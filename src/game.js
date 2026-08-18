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
import { stepVictims, resetVictimIds } from './sim/victims.js';
import {
  stepIncidents, addHazard, resetIncidentIds, isOpen, openIncidents,
  ensureBuildingRecord, incidentHazards,
} from './sim/incidentSim.js';
import { createDispatchState, stepDispatch, radio } from './sim/dispatch.js';
import { stepPlayerMovement, stepApparatusMovement } from './sim/movement.js';
import { stepInteraction } from './sim/interaction.js';
import { buildShiftReport } from './ui/shiftReport.js';

export const MODES = Object.freeze({
  TITLE: 'title', PLAYING: 'playing', PAUSED: 'paused', REPORT: 'report',
});

/* ── state ────────────────────────────────────────────────────────────────── */

export function createInitialState({ seed, seedLabel, town }) {
  const state = {
    mode: MODES.TITLE,
    seed, seedLabel,
    simTimeMs: 0,
    shiftMs: CONFIG.shift.durationMs,

    player: {
      x: STATION.spawn.x, y: STATION.spawn.y, vx: 0, vy: 0, facing: -Math.PI / 2,
      inVehicleId: null, toolId: null, draggingVictimId: null,
      insideBuildingId: null,
      stunMs: 0, shockCooldownMs: 0, soot: 0,
      useProgressMs: 0, useTargetId: null,
      wrongToolNotedAt: 0, dryNotedAt: 0, tautNotedAt: 0,
    },

    apparatus: [],
    apparatusDefs: APPARATUS_BY_ID,
    tools: [],
    toolsById: {},
    rack: { ...STATION.rack },

    hazards: [],
    victims: [],
    incidents: [],
    dispatch: createDispatchState(),
    radio: [],

    town,
    outcome: {
      controlled: 0, lost: 0, patientsSaved: 0, patientsLost: 0,
      structuresLost: 0, confidenceStart: town.confidence,
    },
    telemetry: {
      distanceDrivenM: 0, litresUsed: 0, waterOnTarget: 0,
      wrongToolAttempts: 0, callsNeverWorked: 0,
      firstSplitMs: null, sceneChanges: 0, lastSceneIncidentId: null,
      timeOnFootMs: 0, timeDrivingMs: 0,
    },
    report: null,
  };

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
      patientId: null, occupied: false,
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
    if (this.state.mode !== MODES.PLAYING) { if (input) input.endStep(); return 0; }
    return this.clock.advance(realDeltaMs, (stepMs) => this.step(stepMs, input));
  }

  step(stepMs, input) {
    const s = this.state;
    s.simTimeMs = this.clock.simTimeMs;

    const cmd = readCommand(input);
    const events = [];

    /* 1. movement */
    if (s.player.inVehicleId) {
      const ap = s.apparatus.find((a) => a.id === s.player.inVehicleId);
      const before = ap.odometerM;
      events.push(...stepApparatusMovement(s, ap, cmd.drive, stepMs));
      s.player.x = ap.x; s.player.y = ap.y; s.player.facing = ap.angle;
      s.telemetry.distanceDrivenM += ap.odometerM - before;
      s.telemetry.timeDrivingMs += stepMs;
    } else {
      events.push(...stepPlayerMovement(s, cmd.axis, stepMs));
      s.telemetry.timeOnFootMs += stepMs;
    }

    /* 2. hands */
    events.push(...stepInteraction(s, cmd, stepMs));

    /* 3. the world, whether or not anyone is watching it */
    events.push(...stepHazards(s, stepMs, this.rng));
    events.push(...stepVictims(s, stepMs));
    applySirenEffect(s);
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
          const b = BUILDING_BY_ID[e.buildingId];
          const host = inc || s.incidents.find((i) => i.hazardIds.includes(e.fromHazardId));
          if (host && isOpen(host)) {
            addHazard(s, host, createFire(e.buildingId, { seedCells: 1, heat: 0.9, from: 'centre' }));
            host.danger = Math.min(0.95, host.danger + 0.06);
            radio(s, `Fire has extended to ${b.name}.`, 'bad');
          }
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
        case 'VICTIM_SHOCKED':
          radio(s, 'Somebody has touched that line.', 'bad');
          break;
        case 'RESPONDER_SHOCKED':
          radio(s, 'You have been thrown clear of the wire. Sit down for a moment.', 'bad');
          break;

        case 'STRUCTURE_LOST': {
          s.outcome.structuresLost++;
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

  endShift() {
    const s = this.state;
    if (s.mode === MODES.REPORT) return;
    s.mode = MODES.REPORT;
    this.clock.setPaused(true);

    for (const inc of s.incidents) {
      if (isOpen(inc)) {
        inc.status = inc.danger > 0.5 ? 'lost' : 'controlled';
        inc.outcomeNote = inc.status === 'lost' ? 'still going when the shift ended' : 'handed over';
        if (inc.status === 'lost') s.outcome.lost++; else s.outcome.controlled++;
        if (!inc.everWorked) s.telemetry.callsNeverWorked++;
      }
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

function readCommand(input) {
  if (!input) {
    return { axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 }, interact: false, drop: false, use: false, siren: false, slot: null };
  }
  const axis = input.moveAxis();
  let slot = null;
  for (let i = 1; i <= 5; i++) if (input.wasPressed(`slot${i}`)) { slot = i - 1; break; }
  return {
    axis,
    drive: {
      throttle: (input.isDown('moveUp') ? 1 : 0) - (input.isDown('moveDown') ? 1 : 0),
      steer: (input.isDown('moveRight') ? 1 : 0) - (input.isDown('moveLeft') ? 1 : 0),
    },
    interact: input.wasPressed('interact'),
    drop: input.wasPressed('drop'),
    use: input.isDown('use'),
    siren: input.wasPressed('siren'),
    slot,
  };
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
