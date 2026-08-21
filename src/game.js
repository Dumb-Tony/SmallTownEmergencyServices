/* The authoritative simulation. Everything else in src/ either feeds it input or reads
 * it to draw something.
 *
 * GDD implementation rule 3: "Never pause incident clocks when a panel or tutorial is
 * open during active play." The only thing that stops time here is MODES.PAUSED, and
 * the call list is not a pause — it is drawn over a town that keeps burning.
 *
 * Step order matters and is stated once, here:
 *   move -> interact -> hazards -> people -> incidents -> dispatch -> shift clock
 * Hazards run before people so that a patient's decline this step reflects the fire
 * that spread this step, not the fire as it was a frame ago.
 */

import { CONFIG } from './config.js';
import { GameClock } from './core/clock.js';
import { EventBus } from './core/eventBus.js';
import { Rng, hashStr } from './core/rng.js';
import { loadTown, saveTown, advanceShift } from './core/persistence.js';
import { STATION, BUILDING_BY_ID, HYDRANTS, dist } from './data/town.js';
import { APPARATUS_DEFS, APPARATUS_BY_ID, TOOL_DEFS, RACK_ITEMS } from './data/equipment.js';
import {
  stepHazards, createFire, fireDamageFraction, resetHazardIds,
} from './sim/hazards.js';
import { stepVictims, resetVictimIds, victimHandled } from './sim/victims.js';
import {
  stepIncidents, addHazard, resetIncidentIds, isOpen, openIncidents,
  ensureBuildingRecord, incidentHazards, writeThroughDamage, summariseIncident,
} from './sim/incidentSim.js';
import { createDispatchState, stepDispatch, radio } from './sim/dispatch.js';
import { stepPlayerMovement, stepApparatusMovement } from './sim/movement.js';
import { stepInteraction } from './sim/interaction.js';
import {
  createResidents, stepResidents, resetResidentIds, crowdDragAt,
} from './sim/residents.js';
import { buildShiftReport } from './ui/shiftReport.js';
import {
  encodeSnapshot, applySnapshot, encodeCommand, decodeCommand, EMPTY_COMMAND,
} from './net/protocol.js';

export const MODES = Object.freeze({
  TITLE: 'title', PLAYING: 'playing', PAUSED: 'paused', REPORT: 'report',
});

/** Who is on the crew, and which keys drive them. Two on one keyboard for now; the
 *  seam a network client would take is the same one — a per-responder command. */
export const CREW = Object.freeze([
  { id: 'r1', name: 'You',     tint: '#f6c445', prefix: '' },
  { id: 'r2', name: 'Partner', tint: '#5fd0f0', prefix: 'p2' },
]);

export function makeResponder(index) {
  const spec = CREW[index];
  return {
    id: spec.id, name: spec.name, tint: spec.tint, prefix: spec.prefix, index,
    x: STATION.spawn.x + index * 3.2, y: STATION.spawn.y,
    vx: 0, vy: 0, facing: -Math.PI / 2,
    inVehicleId: null, toolId: null, draggingVictimId: null,
    insideBuildingId: null,
    stunMs: 0, shockCooldownMs: 0, soot: 0,
    useProgressMs: 0, useTargetId: null,
    wrongToolNotedAt: 0, dryNotedAt: 0, tautNotedAt: 0,
  };
}

/* ── state ────────────────────────────────────────────────────────────────── */

export function createInitialState({ seed, seedLabel, town }) {
  const state = {
    mode: MODES.TITLE,
    seed, seedLabel,
    simTimeMs: 0,
    shiftMs: CONFIG.shift.durationMs,

    /* GDD Phase 5: the crew is a LIST. Everything that can be done by one responder
     * can be done by any of them, and the things there is only one of — a nozzle, a
     * driver's seat, a stretcher-load of ambulance — are contested by construction
     * rather than by a rule written down somewhere.
     *
     * `state.player` below is the same OBJECT as responders[0], not a copy: it keeps
     * the single-responder call sites honest instead of quietly diverging. */
    responders: [],
    player: null,
    coop: false,
    /** Set by NetSession. `remoteCommands` is the whole of the host's inbox. */
    net: { remoteCommands: {}, isClient: false },

    apparatus: [],
    apparatusDefs: APPARATUS_BY_ID,
    tools: [],
    toolsById: {},
    rack: { ...STATION.rack },

    hazards: [],
    victims: [],
    /* The people who live here, drawn from a stream of their own.
     *
     * A SEPARATE stream on purpose. Residents draw at spawn and again every time somebody
     * decides to step outside, and putting those draws in the shift's main stream would
     * shift every dispatch pace, incident site and hazard roll downstream of them — the
     * town would still be deterministic, and it would be a DIFFERENT town, on every seed
     * anyone had ever measured. Named streams are already the idiom (see src/core/rng.js);
     * this is what they are for. */
    residents: [],
    incidents: [],
    dispatch: createDispatchState(),
    radio: [],

    town,
    outcome: {
      controlled: 0, lost: 0, patientsSaved: 0, patientsLost: 0,
      structuresLost: 0, structuresLostNames: [], confidenceStart: town.confidence,
      residentsOut: 0, residentsTrapped: 0,
    },
    telemetry: {
      distanceDrivenM: 0, litresUsed: 0, waterOnTarget: 0,
      wrongToolAttempts: 0, callsNeverWorked: 0,
      firstSplitMs: null, sceneChanges: 0, lastSceneIncidentId: null,
      timeOnFootMs: 0, timeDrivingMs: 0,
    },
    report: null,
  };

  state.responders.push(makeResponder(0));
  state.player = state.responders[0];

  let toolSeq = 1;
  const addTool = (defId, carrier, extra = {}) => {
    const def = TOOL_DEFS[defId];
    const t = {
      id: `tool${toolSeq++}`, defId, name: def.name, short: def.short,
      twoHanded: !!def.twoHanded, mode: def.mode,
      carrier, x: 0, y: 0, flowing: false, ...extra,
    };
    if (defId === 'extinguisher') t.chargeL = CONFIG.tools.extinguisherLitres;
    state.tools.push(t);
    state.toolsById[t.id] = t;
    return t;
  };

  for (const bay of STATION.bays) {
    const def = APPARATUS_BY_ID[bay.apparatusId];
    const ap = {
      id: def.id, defId: def.id, name: def.name, short: def.short,
      x: bay.x, y: bay.y, angle: bay.angle, speed: 0,
      siren: false, damage: 0, odometerM: 0,
      waterL: def.tankL, hydrantId: null,
      patientId: null, driverId: null, passengerIds: [],
      homeX: bay.x, homeY: bay.y,
    };
    state.apparatus.push(ap);
    for (const toolId of def.loadout) addTool(toolId, ap.id);
    if (def.hose) addTool('hose', ap.id, { engineId: ap.id, deployedM: 0 });
  }

  for (const toolId of RACK_ITEMS) {
    const t = addTool(toolId, 'rack');
    t.x = STATION.rack.x; t.y = STATION.rack.y;
  }

  // Who is home tonight. Derived from the shift seed, on its own stream.
  resetResidentIds();
  state.residents = createResidents(new Rng((seed ^ 0x9e3779b9) >>> 0, 'residents'));

  return state;
}

/* ── the game ─────────────────────────────────────────────────────────────── */

export class Game {
  constructor({ seed = CONFIG.sim.defaultSeed, seedLabel = CONFIG.sim.seedLabel } = {}) {
    this.clock = new GameClock({ stepMs: CONFIG.sim.stepMs, maxFrameMs: CONFIG.sim.maxFrameMs });
    this.bus = new EventBus({ logSize: CONFIG.debug.eventLogSize });
    this.seed = seed;
    this.seedLabel = seedLabel;
    this.rng = new Rng(seed, seedLabel);
    this.people = new Rng((seed ^ 0x9e3779b9) >>> 0, 'residents');
    this.town = loadTown();
    this.state = createInitialState({ seed, seedLabel, town: this.town });
    this._subs = new Set();
  }

  static seedFromLabel(label) { return hashStr(label); }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _notify() { for (const fn of Array.from(this._subs)) fn(this.state); }

  /** Fresh shift on the same town. The seed advances with the shift number so shift 2
   *  is not a replay of shift 1, and a given (label, shift) pair always is. */
  startShift() {
    this.town = loadTown();
    const seed = (hashStr(`${this.seedLabel}#${this.town.shiftNumber}`) ^ this.seed) >>> 0;
    this.rng = new Rng(seed, `${this.seedLabel}#${this.town.shiftNumber}`);
    this.people = new Rng((seed ^ 0x9e3779b9) >>> 0, 'residents');
    resetHazardIds(); resetVictimIds(); resetIncidentIds();
    this.clock.reset();
    this.bus.clearLog();
    this.state = createInitialState({ seed, seedLabel: this.seedLabel, town: this.town });
    this.state.mode = MODES.PLAYING;
    radio(this.state, `Shift ${this.town.shiftNumber} on. Station is in service.`, 'system');
    this.bus.emit('SIM_RESET', { seed }, 0);
    this._notify();
    return this.state;
  }

  togglePause() {
    const s = this.state;
    if (s.mode === MODES.PLAYING) { s.mode = MODES.PAUSED; this.clock.setPaused(true); this.bus.emit('SIM_PAUSED', {}, s.simTimeMs); }
    else if (s.mode === MODES.PAUSED) { s.mode = MODES.PLAYING; this.clock.setPaused(false); this.bus.emit('SIM_RESUMED', {}, s.simTimeMs); }
    this._notify();
    return s.mode;
  }

  pauseForBlur() {
    if (this.state.mode !== MODES.PLAYING) return;
    this.state.mode = MODES.PAUSED;
    this.clock.setPaused(true);
    this.bus.emit('SIM_PAUSED', { reason: 'blur' }, this.state.simTimeMs);
    this._notify();
  }

  /** One real frame. The ONLY entry point that advances simulation time. */
  frame(realDeltaMs, input) {
    /* A client does not simulate. Its town is whatever the host last said it was, and
     * the moment it starts stepping on its own it begins disagreeing about whether a
     * building burned down — which is the entire failure mode host authority exists to
     * prevent. The guard lives HERE, at the one door into the simulation. */
    if (this.state.net.isClient) { if (input) input.endStep(); return 0; }
    if (this.state.mode !== MODES.PLAYING) { if (input) input.endStep(); return 0; }
    return this.clock.advance(realDeltaMs, (stepMs) => this.step(stepMs, input));
  }

  step(stepMs, input) {
    const s = this.state;

    /* Nothing happens after the bell.
     *
     * frame() guards the mode, but the clock's accumulator does not: endShift() sets
     * mode to REPORT part-way through a frame's worth of steps, and the remaining ones
     * ran anyway. Measured with a 250 ms frame straddling the end of a shift: thirteen
     * steps of world simulated AFTER the report had been built, the confidence banked
     * and the town saved — and in them a casualty died, so the report said "0 lost"
     * over a state that said 1, and the saved confidence disagreed with the live one.
     * At 60 fps it is a step or two, which is exactly the kind of bug nobody ever
     * catches by playing. */
    if (s.mode !== MODES.PLAYING) return [];

    s.simTimeMs = this.clock.simTimeMs;

    const events = [];

    /* 1 & 2. every responder moves and acts, each from their own command.
     *
     * A vehicle is stepped once, by whoever is holding its wheel — passengers ride,
     * they do not each get a go at the throttle. That is the one place where "the crew
     * is a list" could quietly become "the truck moves twice as fast with two people
     * in it", so it is worth saying out loud. */
    for (const r of s.responders) {
      /* A remote responder is driven by the last command that arrived over the wire.
       * It is the same object shape readCommand builds, so from here down the
       * simulation cannot tell the difference between a partner on this keyboard and
       * a partner on another continent — which is the reason every responder was
       * routed through a command in the first place. */
      const cmd = r.remote
        ? (s.net.remoteCommands[r.id] || EMPTY_COMMAND)
        : readCommand(input, r.prefix);
      if (r.inVehicleId) {
        const ap = s.apparatus.find((a) => a.id === r.inVehicleId);
        if (ap && ap.driverId === r.id) {
          const before = ap.odometerM;
          events.push(...stepApparatusMovement(s, ap, cmd.drive, stepMs));
          s.telemetry.distanceDrivenM += ap.odometerM - before;
          s.telemetry.timeDrivingMs += stepMs;
        }
        if (ap) { r.x = ap.x; r.y = ap.y; r.facing = ap.angle; }
      } else {
        /* Set, not reset. A crowd's drag is derived from where this responder is standing
         * right now, so it is computed once a step and read once a step — never left over
         * from a step in which they were somewhere else. */
        r.crowdDrag = crowdDragAt(s, r.x, r.y);
        events.push(...stepPlayerMovement(s, cmd.axis, stepMs, cmd.aim, r));
        s.telemetry.timeOnFootMs += stepMs;
      }
      events.push(...stepInteraction(s, cmd, stepMs, r));
    }

    /* 3. the world, whether or not anyone is watching it */
    events.push(...stepHazards(s, stepMs, this.rng));
    events.push(...stepResidents(s, stepMs, this.people));
    events.push(...stepVictims(s, stepMs));
    applySirenEffect(s);
    writeThroughDamage(s);
    events.push(...detectStructureLosses(s));
    events.push(...stepIncidents(s, stepMs, this.rng));
    events.push(...stepDispatch(s, stepMs, this.rng));

    this.handleEvents(events);

    if (input) input.endStep();

    if (s.simTimeMs >= s.shiftMs) this.endShift();
    return events.length;
  }

  /* ── consequences ───────────────────────────────────────────────────────
   * Every event goes on the bus for the debug overlay and the report; a handful of
   * them also change the town. This is the only place confidence moves.
   */
  handleEvents(events) {
    const s = this.state;
    for (const e of events) {
      this.bus.emit(e.type, e, s.simTimeMs);
      const inc = e.incidentId ? s.incidents.find((i) => i.id === e.incidentId) : null;

      switch (e.type) {
        case 'CALL_RECEIVED':
          radio(s, `[${inc.priority.toUpperCase()}] ${inc.headline} — ${inc.place}. ${inc.report}`, 'call');
          break;
        case 'CALL_UPDATED':
          radio(s, `Update, ${inc.place}: ${e.text}`, 'update');
          break;
        case 'PRIORITY_RAISED':
          radio(s, `${inc.headline} at ${inc.place} upgraded to ${e.priority}.`, 'update');
          break;

        case 'CREW_ON_SCENE': {
          noteSceneChange(s, inc);
          // Somebody has eyes on it: the co-op gets told about any wire on the ground.
          for (const h of incidentHazards(s, inc)) {
            if (h.kind === 'power' && h.live && !h.utilityCalled) {
              h.utilityCalled = true;
              radio(s, `Power co-op notified for the line at ${inc.place}. ETA ${Math.round(h.utilityEtaMs / 60000)} minutes.`, 'system');
            }
          }
          break;
        }

        case 'INCIDENT_CONTROLLED': {
          s.outcome.controlled++;
          s.town.confidence = clamp01(s.town.confidence + CONFIG.town.confidenceControlled);
          radio(s, `${inc.headline} at ${inc.place}: under control. ${inc.outcomeNote}.`, 'good');
          break;
        }
        case 'INCIDENT_LOST': {
          s.outcome.lost++;
          if (!inc.everWorked) s.telemetry.callsNeverWorked++;
          s.town.confidence = clamp01(s.town.confidence + CONFIG.town.confidenceLost);
          radio(s, `${inc.headline} at ${inc.place}: we lost this one. ${inc.outcomeNote}.`, 'bad');
          break;
        }

        case 'FIRE_EXTENDED': {
          /* A fire takes the building next door whether or not anybody is still counting
           * the call as open.
           *
           * This used to require `isOpen(host)`, so the marquee system in the game
           * switched itself off at exactly the moment things were worst: an unattended
           * structure fire reaches danger 1.0, the call is declared lost, and from then
           * on every exposure jump was silently dropped. Measured on one seed, Miller
           * Farmhouse six metres from Miller Barn: call open, one attempt, the barn
           * catches; call lost, seven attempts, nothing ever catches — while the
           * farmhouse burned to 100% either way.
           *
           * The guard also had to be here rather than only in stepWreck: with nothing
           * ever created, the emitting condition never cleared and a constructed case
           * produced 1200 of these events in twenty seconds. */
          const b = BUILDING_BY_ID[e.buildingId];
          if (s.hazards.some((h) => h.kind === 'fire' && h.buildingId === e.buildingId)) break;
          const host = inc || s.incidents.find((i) => i.hazardIds.includes(e.fromHazardId));
          const fire = createFire(e.buildingId, { seedCells: 1, heat: 0.9, from: 'centre' });
          if (host && isOpen(host)) {
            addHazard(s, host, fire);
            host.danger = Math.min(0.95, host.danger + 0.06);
          } else {
            // Nobody's call any more — but still the town's building, and the damage is
            // still written through to the save by writeThroughDamage().
            s.hazards.push(fire);
          }
          radio(s, `Fire has extended to ${b.name}.`, 'bad');
          break;
        }
        case 'GAS_FLASH': {
          const host = s.incidents.find((i) => i.hazardIds.includes(e.hazardId));
          if (host) {
            if (e.buildingId && !s.hazards.some((h) => h.kind === 'fire' && h.buildingId === e.buildingId)) {
              addHazard(s, host, createFire(e.buildingId, { seedCells: 2, heat: 1.1, from: 'door' }));
            }
            const rec = ensureBuildingRecord(s, e.buildingId);
            rec.damage = Math.min(1, rec.damage + CONFIG.gas.flashDamage);
            host.danger = Math.min(0.98, host.danger + 0.18);
            radio(s, `The gas at ${host.place} has gone up.`, 'bad');
            knockBack(s, e.x, e.y);
          }
          break;
        }
        case 'WRECK_IGNITED':
          radio(s, 'A vehicle is alight.', 'bad');
          break;
        case 'UTILITY_ARRIVED':
          radio(s, 'Power co-op reports the line is dead.', 'system');
          break;

        case 'PATIENT_DELIVERED':
          s.outcome.patientsSaved++;
          s.town.confidence = clamp01(s.town.confidence + CONFIG.town.confidencePatientSaved);
          radio(s, 'Patient handed over at Lakeview Clinic.', 'good');
          break;
        case 'PATIENT_LOST':
          s.outcome.patientsLost++;
          s.town.confidence = clamp01(s.town.confidence + CONFIG.town.confidencePatientLost);
          radio(s, `A patient at ${inc ? inc.place : 'scene'} did not make it.`, 'bad');
          break;
        case 'PATIENT_EXTRICATED':
          radio(s, 'Casualty is free of the wreck.', 'good');
          break;

        /* An ABSENCE is the information. Two lines per building and no more: the first
         * person out, who tells you how many are behind them, and the moment there is
         * nobody left, which tells you to stop looking. A line per resident would bury
         * the dispatch board under a four-person household. */
        case 'RESIDENT_OUT': {
          const b = BUILDING_BY_ID[e.buildingId];
          if (e.insideAfter === 0) radio(s, `That is everybody out of ${b.name}.`, 'good');
          else if (e.outSoFar <= 1) {
            radio(s, `Somebody is out of ${b.name} — they say there ${e.insideAfter === 1
              ? 'is one more person' : `are ${e.insideAfter} more people`} inside.`, 'update');
          }
          s.outcome.residentsOut++;
          break;
        }
        /* No confidence is moved here, deliberately. Somebody trapped is a casualty now,
         * and the town already pays for a casualty saved and charges for one lost —
         * paying twice for the same person would make a house fire worth more than
         * anything else on the board. */
        case 'RESIDENT_TRAPPED':
          s.outcome.residentsTrapped++;
          radio(s, `Somebody did not get out of ${BUILDING_BY_ID[e.buildingId].name}.`, 'bad');
          break;
        case 'VICTIM_SHOCKED':
          radio(s, 'Somebody has touched that line.', 'bad');
          break;
        case 'RESPONDER_SHOCKED':
          radio(s, 'You have been thrown clear of the wire. Sit down for a moment.', 'bad');
          break;

        case 'STRUCTURE_LOST': {
          s.outcome.structuresLost++;
          // Names, not just a count: the shift report has to say what was lost THIS
          // shift rather than reading the town's accumulated damage table, which still
          // holds every building ever gutted.
          s.outcome.structuresLostNames.push(BUILDING_BY_ID[e.buildingId].name);
          s.town.confidence = clamp01(s.town.confidence + CONFIG.town.confidenceStructureLost);
          const rec = ensureBuildingRecord(s, e.buildingId);
          rec.timesBurned++;
          radio(s, `${BUILDING_BY_ID[e.buildingId].name} is a total loss.`, 'bad');
          break;
        }

        case 'HYDRANT_STRUCK':
          radio(s, 'You have flattened a hydrant. That one is out of service.', 'bad');
          break;
        case 'HYDRANT_CHARGED':
          radio(s, 'Hydrant charged. Supply is established.', 'good');
          break;
        case 'TANK_DRY':
          radio(s, 'Tank is dry. You need a hydrant.', 'bad');
          break;
        case 'HOSE_TAUT':
          radio(s, 'That is all the hose there is. Move the engine.', 'update');
          break;
        case 'ROAD_CLEARED':
          radio(s, 'Road is clear.', 'good');
          break;
        case 'LINE_DE_ENERGISED':
          radio(s, 'Line is dead at the pole.', 'good');
          break;
        case 'GAS_SHUT_OFF':
          radio(s, 'Gas is shut off at the meter.', 'good');
          break;
        case 'APPARATUS_STRUCK':
          if (e.impact > 8) radio(s, `${e.apparatusId} has hit ${e.name}.`, 'bad');
          break;
        default: break;
      }
    }
  }

  /* ── the network's whole surface on the simulation ──────────────────────
   * Four methods, and none of them touch the step order. A host takes commands in and
   * hands snapshots out; a client takes snapshots in and hands commands out. If this
   * list ever grows a fifth entry that is not one of those four things, the authority
   * model has sprung a leak.
   */

  /** Host: the latest intent from a remote player. Null clears it (they left). */
  setRemoteCommand(responderId, wire) {
    const s = this.state;
    if (!wire) { delete s.net.remoteCommands[responderId]; return; }
    s.net.remoteCommands[responderId] = decodeCommand(wire);
  }

  encodeNetSnapshot() { return encodeSnapshot(this.state); }
  encodeNetCommand(cmd) { return encodeCommand(cmd); }

  /** Client: adopt the host's town wholesale. The client never steps the simulation. */
  applyNetSnapshot(snap) { return applySnapshot(this.state, snap); }

  /** Bring a partner on (P, or a client connecting). Returns the new responder. */
  addResponder() {
    const on = toggleCoop(this.state);
    return on ? this.state.responders[this.state.responders.length - 1] : null;
  }

  removeResponder() { return toggleCoop(this.state); }

  endShift() {
    const s = this.state;
    if (s.mode === MODES.REPORT) return;
    s.mode = MODES.REPORT;
    this.clock.setPaused(true);

    for (const inc of s.incidents) {
      if (isOpen(inc)) {
        // The bell is not an outcome. A call is only a win at the end of a shift on
        // the same terms as during it — hazards out, people handled. A trunk still
        // across Elm Street at 10:00 is not "controlled" because nobody went.
        const hazardsClear = incidentHazards(s, inc).every((h) => h.resolved);
        const peopleClear = s.victims
          .filter((v) => inc.victimIds.includes(v.id))
          .every((v) => victimHandled(v));
        inc.status = hazardsClear && peopleClear ? 'controlled' : 'lost';
        if (inc.status === 'lost') s.outcome.lost++; else s.outcome.controlled++;
        if (!inc.everWorked) s.telemetry.callsNeverWorked++;
      }
      // Re-summarise everything: a fire keeps eating a building after its call was
      // given up on, so a note written at the moment of loss ("Miller Barn damaged
      // (3%)") contradicts the damage table on the same page.
      inc.outcomeNote = summariseIncident(s, inc);
    }

    s.report = buildShiftReport(s);
    this.town = advanceShift({ ...s.town, confidence: s.town.confidence }, s.report.headline);
    saveTown(this.town);
    this.bus.emit('SHIFT_ENDED', { report: s.report }, s.simTimeMs);
    this._notify();
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

/** One responder's intent for one step. `prefix` selects that responder's key set —
 *  the same shape a network client would send, which is the point of routing every
 *  responder through here rather than reading the keyboard in the movement code. */
export function readCommand(input, prefix = '') {
  const a = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
  if (!input) {
    return { axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 }, aim: null, interact: false, drop: false, use: false, siren: false, slot: null };
  }
  const axis = input.moveAxis(prefix);
  let slot = null;
  for (let i = 1; i <= 5; i++) if (input.wasPressed(a(`slot${i}`))) { slot = i - 1; break; }

  /* Driving falls back to the AXIS when no key is down.
   *
   * Keys win when they are pressed, so keyboard driving is unchanged to the bit. But a
   * thumb on a stick presses no key at all, and without this a phone player could walk
   * anywhere in town and then sit in a cab that would not steer. The stick is analogue,
   * so it also gets something the keyboard cannot give: part-lock, part-throttle. */
  const keyThrottle = (input.isDown(a('moveUp')) ? 1 : 0) - (input.isDown(a('moveDown')) ? 1 : 0);
  const keySteer = (input.isDown(a('moveRight')) ? 1 : 0) - (input.isDown(a('moveLeft')) ? 1 : 0);
  return {
    axis,
    drive: {
      throttle: keyThrottle || -axis.y,
      steer: keySteer || axis.x,
    },
    // Only the first responder has the mouse; a second player on one keyboard aims by
    // facing, which is what the widened stream cone exists for.
    aim: prefix ? null : (input.pointerWorld || null),
    interact: input.wasPressed(a('interact')),
    drop: input.wasPressed(a('drop')),
    use: input.isDown(a('use')),
    siren: input.wasPressed(a('siren')),
    slot,
  };
}

/** Bring the second responder on or send them home. Drop-in, mid-shift. */
export function toggleCoop(state) {
  if (state.responders.length > 1) {
    const gone = state.responders.pop();
    // Never let someone leave holding the only nozzle, or dragging a patient.
    for (const t of state.tools) if (t.carrier === gone.id) { t.carrier = null; t.x = gone.x; t.y = gone.y; }
    for (const v of state.victims) if (v.draggedBy === gone.id) v.draggedBy = null;
    for (const ap of state.apparatus) {
      if (ap.driverId === gone.id) ap.driverId = null;
      ap.passengerIds = ap.passengerIds.filter((id) => id !== gone.id);
    }
    delete state.net.remoteCommands[gone.id];
    state.coop = false;
    return false;
  }
  const r = makeResponder(state.responders.length);
  r.x = state.responders[0].x + 2.6;
  r.y = state.responders[0].y;
  state.responders.push(r);
  state.coop = true;
  return true;
}

/** A siren within earshot is what finally gets an occupant to leave the building. */
function applySirenEffect(state) {
  const loud = state.apparatus.filter((a) => a.siren);
  if (!loud.length) return;
  for (const v of state.victims) {
    if (!v.panics || v.fleeing || v.lost || v.delivered || v.trappedBy || !v.insideBuildingId) continue;
    for (const a of loud) {
      if (dist(a.x, a.y, v.x, v.y) < CONFIG.drive.sirenClearRadiusM * 2.4) { v.fleeing = true; break; }
    }
  }
}

/** A structure is called a loss once most of it has burned — reported once, then it is
 *  simply part of the town until the repairs are done. */
function detectStructureLosses(state) {
  const out = [];
  for (const h of state.hazards) {
    if (h.kind !== 'fire' || h._lossReported) continue;
    if (fireDamageFraction(h) >= 0.6) {
      h._lossReported = true;
      out.push({ type: 'STRUCTURE_LOST', buildingId: h.buildingId, hazardId: h.id });
    }
  }
  return out;
}

function knockBack(state, x, y) {
  const p = state.player;
  const d = dist(p.x, p.y, x, y);
  if (d > CONFIG.gas.flashKnockbackM || p.inVehicleId) return;
  const away = Math.atan2(p.y - y, p.x - x);
  p.vx = Math.cos(away) * 9;
  p.vy = Math.sin(away) * 9;
  p.stunMs = Math.max(p.stunMs, 2200);
  p.soot = Math.min(1, p.soot + 0.5);
  if (p.draggingVictimId) {
    const v = state.victims.find((q) => q.id === p.draggingVictimId);
    if (v) v.draggedBy = null;
    p.draggingVictimId = null;
  }
}

/** Telemetry the GDD explicitly asks for: time to the first split decision. */
function noteSceneChange(state, inc) {
  const t = state.telemetry;
  if (t.lastSceneIncidentId && t.lastSceneIncidentId !== inc.id) {
    t.sceneChanges++;
    const prior = state.incidents.find((i) => i.id === t.lastSceneIncidentId);
    if (t.firstSplitMs == null && prior && isOpen(prior)) t.firstSplitMs = state.simTimeMs;
  }
  t.lastSceneIncidentId = inc.id;
}

export { openIncidents, isOpen };
