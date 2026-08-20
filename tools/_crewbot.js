/* CrewBot — a competent-but-not-clever volunteer, driven through the REAL input path.
 *
 * There is no way to hand-playtest a browser game from here, so this is the substitute:
 * a bot that presses the same keys a player presses, reads the same context prompts a
 * player reads, and picks tools out of the same numbered slot list the HUD shows. It
 * exercises everything a unit test cannot — that the verbs compose, that a job can
 * actually be finished start to finish, and that nothing traps the player in a state
 * with no way out.
 *
 * It is deliberately NOT good at the game. It goes to the highest-priority call, takes
 * the obvious truck, and does the obvious thing. If a bot this dumb cannot close a call,
 * neither can a first-time player.
 *
 * Test harness only. Nothing in src/ imports this, and no AI crew mate is implied —
 * the GDD lists NPC crews as a non-goal.
 */

import { CONFIG } from '../src/config.js';
import { BUILDING_BY_ID, CLINIC, POLES, ROADS, dist, buildingAt } from '../src/data/town.js';
import { toolsInReachOf, heldTool } from '../src/sim/interaction.js';
import { openIncidents, incidentHazards, incidentVictims } from '../src/sim/incidentSim.js';
import { liveZoneAt } from '../src/sim/hazards.js';
import { victimHandled } from '../src/sim/victims.js';

/* ── an input the bot can press ──────────────────────────────────────────────
 * Same surface Input exposes to game.js. moveAxis is derived from the held keys
 * exactly as the real one does, so the bot cannot accidentally use an analogue stick
 * the player does not have.
 */
/** Which responder this bot is the hands of. */
function me(state, bot) {
  return state.responders.find((r) => r.id === bot.responderId) || state.responders[0];
}

/**
 * @param {string} prefix  '' drives the first responder, 'p2' the second — the bot
 *   presses the same prefixed action names the real binding table defines, so a co-op
 *   test exercises the two-crew command path rather than a special one built for it.
 */
export function makeBotInput(prefix = '') {
  const down = new Set();
  const pressed = new Set();
  const a = (n) => (prefix ? prefix + n[0].toUpperCase() + n.slice(1) : n);
  return {
    down, pressed, prefix,
    hold(action) { down.add(a(action)); },
    release(action) { down.delete(a(action)); },
    /* Clears BOTH sets. game.frame() runs zero steps on some frames (the fixed-step
     * accumulator), and a tap left sitting in `pressed` fires on a later step — the
     * bot pressed E to get into the engine and a stale E pressed itself straight back
     * out of the cab, over and over, for the rest of the shift. */
    releaseAll() { down.clear(); pressed.clear(); },
    tap(action) { pressed.add(a(action)); down.add(a(action)); },
    isDown(n) { return down.has(n); },
    wasPressed(n) { return pressed.has(n); },
    wasReleased() { return false; },
    moveAxis() {
      let x = (down.has(a('moveRight')) ? 1 : 0) - (down.has(a('moveLeft')) ? 1 : 0);
      let y = (down.has(a('moveDown')) ? 1 : 0) - (down.has(a('moveUp')) ? 1 : 0);
      if (x && y) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
      return { x, y };
    },
    endStep() {
      const moves = ['moveUp', 'moveDown', 'moveLeft', 'moveRight'].map(a);
      for (const k of pressed) if (!moves.includes(k)) down.delete(k);
      pressed.clear();
    },
  };
}

/** One input object that answers for a whole crew, so two bots can share one game. */
export function mergeBotInputs(inputs) {
  return {
    isDown: (n) => inputs.some((i) => i.isDown(n)),
    wasPressed: (n) => inputs.some((i) => i.wasPressed(n)),
    wasReleased: () => false,
    moveAxis: (prefix = '') => {
      const owner = inputs.find((i) => i.prefix === prefix);
      return owner ? owner.moveAxis() : { x: 0, y: 0 };
    },
    endStep: () => { for (const i of inputs) i.endStep(); },
  };
}

/* ── a road map the bot can follow ───────────────────────────────────────────
 * Pointing the bonnet at the call and holding the throttle works until a building is
 * in the way, and then it works never: the engine spent two minutes shuffling against
 * the back wall of Grange Hardware. So the bot drives the grid, like a person.
 *
 * Nodes are road intersections plus road ends; edges run along a road between adjacent
 * nodes. An edge with an uncleared trunk lying on it is impassable, so the bot detours
 * around a blocked road for the same reason a player does — which is also the only way
 * to exercise the GDD's "a blocked road materially changes travel" from the driver's
 * seat rather than from a unit test.
 */
const GRAPH = (() => {
  const H = ROADS.filter((r) => r.y1 === r.y2);
  const V = ROADS.filter((r) => r.x1 === r.x2);
  const within = (v, a, b) => v >= Math.min(a, b) - 0.01 && v <= Math.max(a, b) + 0.01;

  const nodes = [];
  const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
  const seen = new Map();
  const addNode = (x, y) => {
    const k = key(x, y);
    if (seen.has(k)) return seen.get(k);
    const n = { id: nodes.length, x, y, edges: [] };
    nodes.push(n); seen.set(k, n);
    return n;
  };

  for (const h of H) {
    for (const v of V) {
      if (within(v.x1, h.x1, h.x2) && within(h.y1, v.y1, v.y2)) addNode(v.x1, h.y1);
    }
  }
  for (const r of ROADS) { addNode(r.x1, r.y1); addNode(r.x2, r.y2); }

  for (const r of ROADS) {
    const horizontal = r.y1 === r.y2;
    const on = nodes.filter((n) => (horizontal
      ? Math.abs(n.y - r.y1) < 0.01 && within(n.x, r.x1, r.x2)
      : Math.abs(n.x - r.x1) < 0.01 && within(n.y, r.y1, r.y2)));
    on.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    for (let i = 0; i + 1 < on.length; i++) {
      const a = on[i], b = on[i + 1];
      const cost = dist(a.x, a.y, b.x, b.y);
      a.edges.push({ to: b.id, cost, roadId: r.id });
      b.edges.push({ to: a.id, cost, roadId: r.id });
    }
  }
  return nodes;
})();

/** Distance from a point to a segment — used to spot a trunk lying across an edge. */
function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return dist(px, py, ax + t * dx, ay + t * dy);
}

function nearestNode(x, y) {
  let best = GRAPH[0], bestD = Infinity;
  for (const n of GRAPH) { const d = dist(x, y, n.x, n.y); if (d < bestD) { bestD = d; best = n; } }
  return best;
}

/** Waypoints from one point to another along the grid, avoiding blocked roads. */
export function routeThrough(state, fromX, fromY, toX, toY) {
  const start = nearestNode(fromX, fromY);
  const goal = nearestNode(toX, toY);
  if (start.id === goal.id) return [{ x: toX, y: toY }];

  const blocked = state.hazards.filter((h) => h.kind === 'tree' && !h.cleared);
  const impassable = (a, b) =>
    blocked.some((t) => pointToSegment(t.x, t.y, a.x, a.y, b.x, b.y) < t.radiusM + 2.2);

  const distTo = new Array(GRAPH.length).fill(Infinity);
  const prev = new Array(GRAPH.length).fill(-1);
  const done = new Array(GRAPH.length).fill(false);
  distTo[start.id] = 0;

  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < GRAPH.length; i++) if (!done[i] && distTo[i] < best) { best = distTo[i]; u = i; }
    if (u < 0 || u === goal.id) break;
    done[u] = true;
    for (const e of GRAPH[u].edges) {
      if (done[e.to] || impassable(GRAPH[u], GRAPH[e.to])) continue;
      const nd = distTo[u] + e.cost;
      if (nd < distTo[e.to]) { distTo[e.to] = nd; prev[e.to] = u; }
    }
  }

  if (distTo[goal.id] === Infinity) return [{ x: toX, y: toY }];   // no way round; go direct
  const path = [];
  for (let at = goal.id; at !== -1; at = prev[at]) path.unshift({ x: GRAPH[at].x, y: GRAPH[at].y });
  path.push({ x: toX, y: toY });
  return path;
}

const RANK = { critical: 0, high: 1, routine: 2 };

/** Which truck a call needs. First match wins — this is the reasoning a player does
 *  while reading the call, and it is deliberately shallow. */
function apparatusFor(state, inc) {
  const hz = incidentHazards(state, inc);
  const vics = incidentVictims(state, inc);
  if (hz.some((h) => h.kind === 'fire' && !h.resolved)) return 'engine';
  if (hz.some((h) => h.kind === 'wreck' && h.burning)) return 'engine';
  if (hz.some((h) => (h.kind === 'tree' && !h.cleared) || (h.kind === 'power' && h.live) || (h.kind === 'gas' && !h.shutOff))) return 'rescue';
  if (vics.some((v) => v.trappedBy)) return 'rescue';
  if (vics.some((v) => !victimHandled(v))) return 'ambulance';
  return 'rescue';
}

export class CrewBot {
  /**
   * @param {string} responderId  which crew member this bot is the hands of
   * @param {{claims?: Map<string,string>}} [crew]  shared board, so a two-person crew
   *   can see what the other one has taken. Without it both bots sorted the same call
   *   list by the same priority and drove to the same fire — two people doing one
   *   person's job, which is exactly the co-op that GDD Phase 5 says must NOT be the
   *   outcome. Passing nothing keeps the solo behaviour byte for byte.
   */
  constructor(game, responderId = 'r1', crew = null) {
    this.game = game;
    this.crew = crew;
    this.responderId = responderId;
    this.input = makeBotInput(responderId === 'r2' ? 'p2' : '');
    this.targetIncidentId = null;
    this.stuckMs = 0;
    this.reverseMs = 0;
    this.log = [];
    this.jobsAttempted = 0;
    this.plannedApparatus = null;
    this.fetching = null;
    this.fetchingId = null;
    this.sidestepMs = 0;
    this.sidestepSign = 1;
    this.actions = { toolsTaken: 0, patientsLoaded: 0, entries: 0, dismounts: 0 };
  }

  note(msg) {
    const t = Math.round(this.game.state.simTimeMs / 1000);
    if (this.log[this.log.length - 1] !== `${t}s ${msg}`) this.log.push(`${t}s ${msg}`);
    if (this.log.length > 200) this.log.shift();
  }

  /** One decision, expressed as key presses. Call this before every game.frame. */
  think() {
    const s = this.game.state;
    const inp = this.input;
    inp.releaseAll();

    const inc = this.chooseCall(s);
    if (!inc) { this.note('nothing outstanding'); return inp; }

    // A patient in the back outranks everything: finish the transport first.
    const carrying = s.apparatus.find((a) => a.patientId);
    if (carrying) {
      if (me(s, this).inVehicleId === carrying.id) { this.driveTo(CLINIC.x, CLINIC.y, 8); return inp; }
      if (!me(s, this).inVehicleId) { this.goToVehicle(s, carrying); return inp; }
    }

    if (me(s, this).inVehicleId) {
      const riding = s.apparatus.find((a) => a.id === me(s, this).inVehicleId);
      const target = this.fetching || inc;
      if (this.drivingHopeless) {
        // Give up on driving for THIS call and walk it. Without the latch the bot got
        // out, saw it was not at the scene, got straight back in, and did that
        // eighteen times.
        inp.tap('interact'); this.escapes = 0; this.walkingCallId = inc.id;
        this.note('leaving the truck and walking it');
        return inp;
      }
      if (dist(riding.x, riding.y, target.x, target.y) > 14) { this.driveTo(target.x, target.y, 11); return inp; }
      if (Math.abs(riding.speed) > 1.2) { inp.hold('moveDown'); return inp; }
      inp.tap('interact');                       // out of the cab, on scene
      this.actions.dismounts++;
      if (target === inc) this.committedId = inc.id;   // boots on the ground: finish it
      this.note(`on scene at ${target === inc ? inc.place : 'the kit'}`);
      return inp;
    }

    /* On foot.
     *
     * The order here is the whole lesson of the first bot run: it stood on the apron,
     * took the hose off a parked engine because the hose was within reach, and then
     * spent the shift being yanked back by a 34 m tether it had never moved. Kit is
     * picked up AT the scene. Getting there is a driving problem, not a hands problem.
     */
    const atScene = dist(me(s, this).x, me(s, this).y, inc.x, inc.y) < 26;
    if (!atScene && this.walkingCallId === inc.id) { this.walkTowards(s, inc.x, inc.y); return inp; }
    if (!atScene) {
      // Put the line down before walking off. The hose is tethered to its engine, so
      // carrying it away from the scene silently anchors you 34 m from the truck —
      // which is exactly what happened, for ninety seconds, on the way to the next call.
      const held = heldTool(s, me(s, this));
      if (held && held.defId === 'hose') { inp.tap('drop'); this.note('dropping the line'); return inp; }

      let ap = s.apparatus.find((a) => a.id === this.plannedApparatus) || s.apparatus[0];
      const near = s.apparatus.slice().sort((a, b) =>
        dist(me(s, this).x, me(s, this).y, a.x, a.y) - dist(me(s, this).x, me(s, this).y, b.x, b.y))[0];
      // The truck you need is across town and the one you came in is at your elbow:
      // drive that one to it rather than walking a hundred metres.
      if (near && ap && near.id !== ap.id &&
          dist(me(s, this).x, me(s, this).y, ap.x, ap.y) > 40 &&
          dist(me(s, this).x, me(s, this).y, near.x, near.y) < 30) {
        this.fetching = { x: ap.x, y: ap.y };
        ap = near;
      }
      this.goToVehicle(s, ap);
      return inp;
    }

    const job = this.pickJob(s, inc);
    if (!job) { this.walkTowards(s, inc.x, inc.y); return inp; }

    /* The kit you need is on a truck that is not here — so BRING THE TRUCK.
     *
     * This is the whole medical family, and without it the family does not exist. The
     * medkit lives on the ambulance and nowhere else, so a crash worked out of the
     * rescue truck cannot be treated; the bot would walk two hundred metres to the
     * station for the kit, walk back, and find the patient dead. Six measured shifts:
     * 14 casualties needing a ride, 0 ever loaded, 0 delivered, and the `transport` job
     * chosen exactly ZERO times — because `treat` always came first and could never be
     * satisfied. Drive the right truck to the scene, like a crew would.
     */
    let needsTruck = null;
    if (job.kind === 'transport' && !me(s, this).draggingVictimId) {
      // the ambulance IS the job: it has to be here, wherever the bot is standing
      const amb = s.apparatus.find((a) => a.id === 'ambulance');
      if (amb && dist(amb.x, amb.y, inc.x, inc.y) > 30) needsTruck = amb;
    }
    // (Kit that is merely far is already handled below, by the forgotten-kit trip.)
    if (needsTruck) {
      if (this.fetchingId !== needsTruck.id) {
        this.note(`going back for ${needsTruck.name}`);
        this.fetchingId = needsTruck.id;
      }
      this.fetching = inc;
      this.plannedApparatus = needsTruck.id;
      this.goToVehicle(s, needsTruck);
      return inp;
    }

    // The trip back for the thing you did not bring. This is the GDD's forgotten-kit
    // beat, and the bot has to live it like anyone else.
    if (job.tool && !this.canDoHere(s, job)) {
      const src = s.apparatus.find((a) => s.tools.some((t) => t.carrier === a.id && t.defId === job.tool));
      if (src && dist(me(s, this).x, me(s, this).y, src.x, src.y) > 26) {
        if (this.fetchingId !== src.id) { this.note(`the ${job.tool} is on ${src.name}, back for it`); this.fetchingId = src.id; }
        this.fetching = inc;                 // the truck comes to the call, not the reverse
        this.plannedApparatus = src.id;
        this.goToVehicle(s, src);
        return inp;
      }
    }
    this.fetching = null; this.fetchingId = null;
    this.work(s, job);
    return inp;
  }

  goToVehicle(s, ap) {
    if (dist(me(s, this).x, me(s, this).y, ap.x, ap.y) < CONFIG.player.reachM + 1.8) {
      this.input.tap('interact');
      this.actions.entries++;
      // Boarding ends the errand. Leaving `fetching` set meant the bot arrived at the
      // truck it had driven across town to collect, got out because it had "arrived",
      // got straight back in because it still was not at the call, and did that five
      // thousand times.
      this.fetching = null; this.fetchingId = null;
      this.route = null;
      this.note(`taking ${ap.name}`);
      return;
    }
    this.walkTowards(s, ap.x, ap.y);
  }

  chooseCall(s) {
    const open = openIncidents(s);
    if (!open.length) { this.targetIncidentId = null; this.committedId = null; return null; }

    /* Commitment.
     *
     * Priority alone makes a terrible triager. The bot arrived at a house fire, got the
     * line off the engine, and six seconds later a critical call landed on the far side
     * of town; it dropped the hose and left, then did the same thing at the next call,
     * and closed nothing all shift. A person finishes the twenty-second job they are
     * standing on. So once boots are on the ground, stay until it is done — unless the
     * new call is critical and this one is merely routine.
     */
    const committed = this.committedId && open.find((i) => i.id === this.committedId);
    if (committed) {
      const emergency = open.find((i) => i.priority === 'critical' && committed.priority === 'routine');
      if (!emergency) { this.targetIncidentId = committed.id; return committed; }
      this.note(`leaving ${committed.headline} — ${emergency.headline} is critical`);
      this.committedId = null;
    }

    const current = open.find((i) => i.id === this.targetIncidentId);

    /* Split the board. A call somebody else has taken is worth less than one nobody is
     * going to — unless it is the only call left, in which case two pairs of hands on
     * one job is right (one on the line, one on the casualty). */
    const taken = (inc) => {
      if (!this.crew) return false;
      const by = this.crew.claims.get(inc.id);
      return !!by && by !== this.responderId;
    };
    const free = open.filter((i) => !taken(i));
    const pool = free.length ? free : open;

    // Stay on a job unless something outranks it — a bot that re-plans every step
    // drives back and forth across town and closes nothing.
    const best = pool.slice().sort((a, b) =>
      (RANK[a.priority] - RANK[b.priority]) ||
      (dist(me(s, this).x, me(s, this).y, a.x, a.y) - dist(me(s, this).x, me(s, this).y, b.x, b.y)))[0];
    if (current && RANK[current.priority] <= RANK[best.priority]) return current;
    if (best.id !== this.targetIncidentId) {
      this.jobsAttempted++;
      this.plannedApparatus = apparatusFor(s, best);
      this.fetching = null; this.fetchingId = null;
      this.note(`taking ${best.headline} at ${best.place} in the ${this.plannedApparatus}`);
    }
    this.targetIncidentId = best.id;
    if (this.crew) {
      for (const [id, by] of this.crew.claims) if (by === this.responderId && id !== best.id) this.crew.claims.delete(id);
      this.crew.claims.set(best.id, this.responderId);
      /* Bring the truck the other one did NOT bring. A crash wants the rescue for the
         spreaders and the ambulance for the kit and the ride, and one person cannot
         drive both — which is the co-op story the GDD is asking for. */
      const partnerHere = this.crew.trucks &&
        [...this.crew.trucks.entries()].find(([rid, tid]) => rid !== this.responderId &&
          this.crew.claims.get(best.id) && tid);
      const mine = apparatusFor(s, best);
      if (partnerHere && partnerHere[1] === mine) {
        const vics = incidentVictims(s, best);
        if (mine !== 'ambulance' && vics.some((v) => !victimHandled(v))) this.plannedApparatus = 'ambulance';
        else if (mine === 'ambulance') this.plannedApparatus = 'rescue';
      }
      if (this.crew.trucks) this.crew.trucks.set(this.responderId, this.plannedApparatus);
    }
    return best;
  }

  /** The next physical thing to do at this call, in the order a crew would do it. */
  pickJob(s, inc) {
    const hz = incidentHazards(s, inc);
    const vics = incidentVictims(s, inc);

    const live = hz.find((h) => h.kind === 'power' && h.live);
    if (live) {
      const pole = POLES.find((p) => p.id === live.poleId);
      return { kind: 'hotstick', tool: 'hotstick', x: pole.x, y: pole.y, hazard: live };
    }
    const gas = hz.find((h) => h.kind === 'gas' && !h.shutOff);
    if (gas) return { kind: 'gas', tool: 'wrench', x: gas.x, y: gas.y, hazard: gas };

    const fire = hz.find((h) => h.kind === 'fire' && !h.resolved && h.burningCount > 0);
    if (fire) {
      const eng = s.apparatus.find((a) => a.id === 'engine');
      const cell = fire.cells.filter((c) => c.burning)
        .sort((a, b) => dist(a.x, a.y, eng.x, eng.y) - dist(b.x, b.y, eng.x, eng.y))[0];
      if (cell) return { kind: 'fire', tool: 'hose', x: cell.x, y: cell.y, hazard: fire, stream: true };
    }
    const burningWreck = hz.find((h) => h.kind === 'wreck' && h.burning);
    if (burningWreck) return { kind: 'fire', tool: 'hose', x: burningWreck.x, y: burningWreck.y, hazard: burningWreck, stream: true };

    const trapped = vics.find((v) => v.trappedBy && !v.lost);
    if (trapped) return { kind: 'extricate', tool: 'spreaders', x: trapped.x, y: trapped.y, victim: trapped };

    const tree = hz.find((h) => h.kind === 'tree' && !h.cleared);
    if (tree) return { kind: 'tree', tool: 'chainsaw', x: tree.x, y: tree.y, hazard: tree };

    const untreated = vics.find((v) => !victimHandled(v) && !v.lost && v.treatedAtMs == null && !v.inApparatusId);
    if (untreated) return { kind: 'treat', tool: 'medkit', x: untreated.x, y: untreated.y, victim: untreated };

    const needsRide = vics.find((v) => !victimHandled(v) && !v.lost && v.needsTransport && !v.inApparatusId);
    if (needsRide) return { kind: 'transport', tool: null, x: needsRide.x, y: needsRide.y, victim: needsRide };

    return null;
  }

  /** Is the kit for this job available from here, or does it need a trip? */
  canDoHere(s, job) {
    if (!job.tool) return true;
    const held = heldTool(s, me(s, this));
    if (held && held.defId === job.tool) return true;
    return toolsInReachOf(s, me(s, this).x, me(s, this).y).some((a) => a.tool.defId === job.tool);
  }

  work(s, job) {
    this.lastJob = job;
    const inp = this.input;
    const held = heldTool(s, me(s, this));

    if (job.tool && (!held || held.defId !== job.tool)) {
      const avail = toolsInReachOf(s, me(s, this).x, me(s, this).y);
      const slot = avail.findIndex((a) => a.tool.defId === job.tool);
      if (slot >= 0 && slot < 5) {
        inp.tap(`slot${slot + 1}`);
        this.actions.toolsTaken++;
        this.note(`taking the ${job.tool}`);
        return;
      }
      // kit is elsewhere: go to the truck that carries it
      const src = s.apparatus.find((a) => s.tools.some((t) => t.carrier === a.id && t.defId === job.tool));
      if (src) { this.walkTowards(s, src.x, src.y); return; }
      this.walkTowards(s, s.rack.x, s.rack.y);
      return;
    }

    if (job.kind === 'transport') {
      const amb = s.apparatus.find((a) => a.id === 'ambulance');
      if (me(s, this).draggingVictimId) {
        if (dist(me(s, this).x, me(s, this).y, amb.x, amb.y) < CONFIG.player.reachM + 2.0) {
          inp.tap('interact');
          this.actions.patientsLoaded++;
          this.note('patient loaded');
        } else this.walkTowards(s, amb.x, amb.y);
        return;
      }
      if (dist(me(s, this).x, me(s, this).y, job.x, job.y) < CONFIG.player.reachM) inp.tap('interact');
      else this.walkTowards(s, job.x, job.y);
      return;
    }

    // Working range: a stream is used from a distance, everything else hands-on.
    const reach = job.stream ? CONFIG.water.streamReachM * 0.55 : CONFIG.player.reachM * 0.8;
    const standoff = job.stream ? 2.6 : 0;
    const d = dist(me(s, this).x, me(s, this).y, job.x, job.y);
    if (d > reach) { this.walkTowards(s, job.x, job.y); return; }
    // Do not stand on the thing you are pointing a hose at. At zero range the direction
    // to the target is undefined, no movement key gets pressed, and facing therefore
    // never updates — the bot stood in the middle of a burning farmhouse holding a
    // charged line for two minutes without firing it once.
    if (standoff && d < standoff - 0.7) { this.pressAway(s, job); return; }

    this.faceAndHold(s, job);
  }

  /** Aim by walking: facing follows the movement axis, so the bot nudges toward the
   *  target for a step and then squeezes. Exactly the aiming a keyboard player has. */
  faceAndHold(s, job) {
    const inp = this.input;
    const dx = job.x - me(s, this).x, dy = job.y - me(s, this).y;
    const bearing = Math.atan2(dy, dx);
    const aimed = Math.abs(Math.atan2(Math.sin(bearing - me(s, this).facing),
      Math.cos(bearing - me(s, this).facing))) < 0.42;
    if (!aimed) {
      // Press with a full-length vector so a key is always issued: nudging by the raw
      // offset does nothing at all once you are within half a metre.
      this.pressTowards(Math.cos(bearing) * 10, Math.sin(bearing) * 10);
      return;
    }
    inp.hold('use');
  }

  pressAway(s, job) {
    const bearing = Math.atan2(me(s, this).y - job.y, me(s, this).x - job.x);
    this.pressTowards(Math.cos(bearing) * 10, Math.sin(bearing) * 10);
  }

  walkTowards(s, tx, ty) {
    // Structures stop people too, unless they use the door. Waypoint through it.
    const targetB = buildingAt(tx, ty);
    const insideId = me(s, this).insideBuildingId;
    if (targetB && insideId !== targetB.id) {
      // Aim THROUGH the doorway, not at it. Walking to the door itself and stopping
      // put the bot in a loop: step off the door mark toward the fire, notice it is no
      // longer on the door mark, step back to it, forever — three metres from a
      // structure fire, holding a charged line, for two minutes.
      const door = targetB.door;
      const cx = targetB.x + targetB.w / 2, cy = targetB.y + targetB.h / 2;
      const ux = cx - door.x, uy = cy - door.y, ul = Math.hypot(ux, uy) || 1;
      const entryX = door.x + (ux / ul) * 3.0, entryY = door.y + (uy / ul) * 3.0;
      this.pressTowards(entryX - me(s, this).x, entryY - me(s, this).y);
      return;
    } else if (!targetB && insideId) {
      const door = BUILDING_BY_ID[insideId].door;
      if (dist(me(s, this).x, me(s, this).y, door.x, door.y) > 1.6) { this.pressTowards(door.x - me(s, this).x, door.y - me(s, this).y); return; }
    }

    /* Walk the roads for anything more than a few paces.
     *
     * Sidestepping around obstacles by feel was three separate limit cycles in a row:
     * pacing on a corner, flipping direction every 900 ms, and — the last one — walking
     * into the downed wire at Oak Street, being thrown clear, and walking straight back
     * into it. The road graph already solves all of that and is what a person does
     * anyway, so pedestrians use it too. Local heuristics are gone.
     */
    let tx2 = tx, ty2 = ty;
    if (dist(me(s, this).x, me(s, this).y, tx, ty) > 22) {
      const key = `foot:${Math.round(tx)},${Math.round(ty)}`;
      if (this.footRouteKey !== key || !this.footRoute || !this.footRoute.length) {
        this.footRoute = routeThrough(s, me(s, this).x, me(s, this).y, tx, ty);
        this.footRouteKey = key;
      }
      while (this.footRoute.length > 1 &&
             dist(me(s, this).x, me(s, this).y, this.footRoute[0].x, this.footRoute[0].y) < 6) this.footRoute.shift();
      while (this.footRoute.length > 1 &&
             dist(this.footRoute[0].x, this.footRoute[0].y, tx, ty) > dist(me(s, this).x, me(s, this).y, tx, ty)) {
        this.footRoute.shift();
      }
      const leg = this.footRoute[0];
      if (leg) { tx2 = leg.x; ty2 = leg.y; }
    } else {
      this.footRoute = null; this.footRouteKey = null;
    }

    let dx = tx2 - me(s, this).x, dy = ty2 - me(s, this).y;

    // Give a live wire a wide berth unless we are carrying the thing that kills it.
    const held = heldTool(s, me(s, this));
    if (!held || held.defId !== 'hotstick') {
      const len = Math.hypot(dx, dy) || 1;
      const aheadX = me(s, this).x + (dx / len) * 3, aheadY = me(s, this).y + (dy / len) * 3;
      const zone = liveZoneAt(s, aheadX, aheadY);
      if (zone) {
        // step around the ring rather than through it
        const away = Math.atan2(me(s, this).y - zone.y, me(s, this).x - zone.x);
        dx = Math.cos(away + Math.PI / 2.2) * 10;
        dy = Math.sin(away + Math.PI / 2.2) * 10;
      }
    }
    this.pressTowards(dx, dy);
  }

  pressTowards(dx, dy) {
    const inp = this.input;
    let any = false;
    if (Math.abs(dx) > 0.4) { inp.hold(dx > 0 ? 'moveRight' : 'moveLeft'); any = true; }
    if (Math.abs(dy) > 0.4) { inp.hold(dy > 0 ? 'moveDown' : 'moveUp'); any = true; }
    this.walkedLastFrame = any;
  }

  /** Steer the truck along the road grid. Digital lock-to-lock, like the keys give. */
  driveTo(tx, ty, arriveM) {
    const s = this.game.state;
    const inp = this.input;
    const ap = s.apparatus.find((a) => a.id === me(s, this).inVehicleId);
    if (!ap) return;

    // Re-route when the destination changes, when the road ahead gets blocked, or
    // after a shunt — otherwise follow the waypoints already planned.
    const key = `${Math.round(tx)},${Math.round(ty)}`;
    const blockedCount = s.hazards.filter((h) => h.kind === 'tree' && !h.cleared).length;
    if (this.routeKey !== key || this.routeBlocked !== blockedCount || !this.route || !this.route.length) {
      this.route = routeThrough(s, ap.x, ap.y, tx, ty);
      this.routeKey = key;
      this.routeBlocked = blockedCount;
    }
    // Drop waypoints already reached, and never let one behind us drag the wheel back.
    while (this.route.length > 1 && dist(ap.x, ap.y, this.route[0].x, this.route[0].y) < 13) this.route.shift();
    // Drop a leading waypoint that points the wrong way. The nearest junction to the
    // station is BEHIND the bays, so the engine used to pull out, drive west to it,
    // U-turn across the grass and clip the pizzeria on the way back east.
    while (this.route.length > 1 &&
           dist(this.route[0].x, this.route[0].y, tx, ty) > dist(ap.x, ap.y, tx, ty)) {
      this.route.shift();
    }
    const leg = this.route[0] || { x: tx, y: ty };
    const final = this.route.length <= 1;

    const d = dist(ap.x, ap.y, leg.x, leg.y);
    const want = Math.atan2(leg.y - ap.y, leg.x - ap.x);
    const diff = Math.atan2(Math.sin(want - ap.angle), Math.cos(want - ap.angle));
    if (!final) arriveM = 0;                    // only the last leg is an arrival

    /* Stuck means "the truck has not gone anywhere", measured over a second and a bit.
     * Judging it on instantaneous speed called every pull-away from rest a jam: the
     * bot reversed out of its own bay on the first frame of every shift. */
    const moved = this.lastPos ? dist(ap.x, ap.y, this.lastPos.x, this.lastPos.y) : 0;
    this.progressM = (this.progressM || 0) + moved;
    this.lastPos = { x: ap.x, y: ap.y };
    this.checkMs = (this.checkMs || 0) + CONFIG.sim.stepMs;
    if (this.checkMs >= 1400) {
      if (this.progressM < 3 && d > arriveM && this.reverseMs <= 0) {
        this.reverseMs = 1600;
        this.escapes = (this.escapes || 0) + 1;
        this.note('wedged; backing off');
      }
      this.checkMs = 0; this.progressM = 0;
    }

    if (this.reverseMs > 0) {
      this.reverseMs -= CONFIG.sim.stepMs;
      inp.hold('moveDown');
      // Steering inverts in reverse, so ask for the opposite of the way we want to go
      // and the nose swings toward it as we back out.
      inp.hold(diff > 0 ? 'moveLeft' : 'moveRight');
      return;
    }

    if (Math.abs(diff) > 0.12) inp.hold(diff > 0 ? 'moveRight' : 'moveLeft');

    // A truck turns around by driving in an arc, not by stopping. Braking whenever the
    // target was behind it left the bot rocking on the spot with the throttle down.
    const tooFast = d < arriveM + 10 && Math.abs(ap.speed) > 7;
    if (d <= arriveM || tooFast) inp.hold('moveDown');
    else inp.hold('moveUp');
  }

  /** Driving has failed repeatedly; walk the rest of it. A player would. */
  get drivingHopeless() { return (this.escapes || 0) >= 4; }
}

/**
 * Run a whole shift with the bot at the wheel.
 *
 * Through game.frame(), not game.step(): the clock is the only thing that advances
 * simulation time, and calling step() directly leaves simTimeMs pinned at zero — so
 * dispatch never reaches its first call and the bot spends ten minutes standing on the
 * apron in a town where nothing ever happens. It did exactly that the first time.
 */
export function runBotShift(game, { maxMs = CONFIG.shift.durationMs + 2000 } = {}) {
  const bot = new CrewBot(game);
  const step = CONFIG.sim.stepMs;
  for (let t = 0; t < maxMs; t += step) {
    bot.think();
    game.frame(step, bot.input);
    if (game.state.mode !== 'playing') break;
  }
  return bot;
}
