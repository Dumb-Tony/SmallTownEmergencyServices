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
import { BUILDING_BY_ID, CLINIC, POLES, ROADS, STATION, dist, buildingAt } from '../src/data/town.js';
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

  /* A trunk across the carriageway and a car on its roof in the middle of it are the same
     problem to a driver, and the router only knew about the first. */
  const blocked = state.hazards.filter((h) => (h.kind === 'tree' && !h.cleared) || h.kind === 'wreck');
  const impassable = (a, b) =>
    blocked.some((t) => pointToSegment(t.x, t.y, a.x, a.y, b.x, b.y) < (t.radiusM || 2.4) + 2.2);

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

/**
 * The kerb nearest a point — where a truck can actually stop.
 *
 * ⚠ THE BOT WAS DRIVING AT THE FRONT DOOR. `driveTo(inc.x, inc.y, 11)` aims the truck at
 * the incident's own coordinate, and an incident's coordinate is a building's door, which
 * is by definition against a wall. The truck grinds into the wall, fails to move three
 * metres in 1.4 s, backs off, tries again, and after four of those the bot abandons the
 * truck and WALKS the rest of the call.
 *
 * Measured over three four-hand shifts before this existed: 324 jams, 27 per seat-shift,
 * and only 18% of them anywhere near another appliance — so it was never the crew jamming
 * itself, it was the crew driving into the scenery. 287 s of a 600 s shift on foot.
 *
 * Nobody parks on the lawn. Stop at the kerb and walk the last few metres.
 */
/** True if nothing in ROADS has this point on its carriageway. */
function onNoRoad(x, y) {
  for (const r of ROADS) {
    const dx = r.x2 - r.x1, dy = r.y2 - r.y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - r.x1) * dx + (y - r.y1) * dy) / len2)) : 0;
    if (dist(x, y, r.x1 + t * dx, r.y1 + t * dy) <= r.w / 2 + 3) return false;
  }
  return true;
}

export function parkSpot(x, y, slot = 0) {
  let best = { x, y, d: Infinity, ux: 1, uy: 0 };
  for (const r of ROADS) {
    const dx = r.x2 - r.x1, dy = r.y2 - r.y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - r.x1) * dx + (y - r.y1) * dy) / len2)) : 0;
    const px = r.x1 + t * dx, py = r.y1 + t * dy;
    const d = dist(x, y, px, py);
    if (d < best.d) {
      const len = Math.hypot(dx, dy) || 1;
      best = { x: px, y: py, d, ux: dx / len, uy: dy / len };
    }
  }
  /* ⚠ AND THEN ALL FOUR PARKED ON THE SAME SQUARE METRE. The first version of this
     returned one point per call, so a four-hand crew converging on one incident drove to
     one kerb and blocked each other there — the jam log filled with three seats stuck
     9.1 m apart, over and over, from 134 s to 180 s. A kerb is a LINE. Take a different
     part of it: one truck length and a bit per seat, alternating up and down the road so
     the crew does not string out in one direction. */
  const step = 13;
  let n = slot === 0 ? 0 : (slot % 2 ? Math.ceil(slot / 2) : -slot / 2) * step;
  /* Stay on the road you picked. Sliding a slot along the tangent walked off the end of
     short roads and put four of the eleven doors' slots inside a building, 26 m from any
     carriageway — a parking spot that is not on a road is not a parking spot. */
  let bx = best.x + best.ux * n, by = best.y + best.uy * n;
  for (let guard = 0; guard < 6 && n !== 0 && (buildingAt(bx, by) || onNoRoad(bx, by)); guard++) {
    n *= -0.6;
    bx = best.x + best.ux * n; by = best.y + best.uy * n;
  }
  if (buildingAt(bx, by) || onNoRoad(bx, by)) { bx = best.x; by = best.y; }
  /* Pull off the crown of the road toward the call, so the truck is not left straddling
     the lane it just drove up — and so the walk is a metre or two shorter. */
  if (best.d > 6) {
    const k = Math.min(4, best.d - 2) / best.d;
    bx += (x - best.x) * k; by += (y - best.y) * k;
  }
  return { x: bx, y: by, d: best.d };
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
    this.ferryTo = null;
    this.sidestepMs = 0;
    this.sidestepSign = 1;
    this.refusedTruckId = null;
    this.refusedMs = 0;
    this.wedges = [];
    this.hikeTruckId = null;
    // The board's own claims map is keyed by CALL and so holds one name each; this one is
    // keyed by PERSON, which is the direction the "how many are already on it" question
    // needs. Created lazily so an old two-field board still works.
    if (this.crew && !this.crew.targets) this.crew.targets = new Map();
    this.actions = { toolsTaken: 0, patientsLoaded: 0, entries: 0, dismounts: 0, wedged: 0 };
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
    if (this.refusedMs > 0) this.refusedMs -= CONFIG.sim.stepMs;

    /* ⚠ AND IT HAS TO OUTRANK THE EMPTY BOARD TOO.
     *
     * This block used to sit BELOW chooseCall, which returns early when there is nothing
     * outstanding — and packaging a casualty into the ambulance is exactly what CLEARS
     * the call they came from (m5 B2 asserts it: "the scene is clear"). So the last
     * casualty of a quiet shift was loaded into the back of Medic 1 and left there until
     * the bell, with the whole crew standing around a town with no open calls. m5 C4:
     * "loaded 1 · delivered 0". A patient in the back is a job whether or not the
     * dispatcher has anything else to say. */
    /* ⚠ "A PATIENT IN THE BACK OUTRANKS EVERYTHING" OUTRANKED THE CREW ROTA TOO.
     *
     * Every bot saw the loaded ambulance, every bot decided the clinic run was the most
     * important thing in the town, and every bot got in — and because this branch sits
     * above the not-the-driver check, none of them ever got out again. Measured: two of
     * three shifts ended with all four volunteers sitting in Medic 1, at the identical
     * distance from the station, and 58,611 apparatus-frames with more than one person
     * aboard. It also accounted for most of the shunting, because three passengers each
     * ran the steering code against a truck the game was not listening to them about.
     *
     * A patient needs ONE driver. Everybody else has a town to work. */
    const carrying = s.apparatus.find((a) => a.patientId);
    if (carrying) {
      if (me(s, this).inVehicleId === carrying.id && carrying.driverId === this.responderId) {
        this.driveTo(CLINIC.x, CLINIC.y, 8); return inp;
      }
      /* ⚠ AND "ONE DRIVER" HAS TO MEAN AT LEAST ONE. The first version of this only let an
         ON-FOOT volunteer claim the wheel, and m5 C4 went to zero deliveries: the person
         who loaded the patient walks off to the next call and gets into another truck, and
         then nobody in the town is on foot near the ambulance, so the loaded patient sat
         in it until the bell. Whoever is closest goes, and if that means stepping out of
         something else, step out. */
      const nobodyAtTheWheel = !carrying.driverId;
      const mine = me(s, this);
      const closest = !s.responders.some((r) => r.id !== this.responderId &&
        dist(r.x, r.y, carrying.x, carrying.y) < dist(mine.x, mine.y, carrying.x, carrying.y));
      if (nobodyAtTheWheel && closest) {
        if (!mine.inVehicleId) { this.goToVehicle(s, carrying); return inp; }
        const riding = s.apparatus.find((a) => a.id === mine.inVehicleId);
        if (riding && riding.id !== carrying.id) {
          if (Math.abs(riding.speed) > 1.2) { inp.hold('moveDown'); return inp; }
          inp.tap('interact');
          this.actions.dismounts++;
          this.note(`out to drive ${carrying.name} to the clinic`);
          return inp;
        }
      }
    }

    /* ⚠ AND GETTING OUT OF A TRUCK YOU ARE NOT DRIVING DOES NOT DEPEND ON THERE BEING A
       CALL. This check used to live inside the block below, under chooseCall's early
       return — so a passenger in a town with an empty board sat there. 1,490 frames of it.
       It is a fact about the seating, not about the dispatch queue. */
    {
      const mineNow = me(s, this);
      const riding = mineNow.inVehicleId && s.apparatus.find((a) => a.id === mineNow.inVehicleId);
      if (riding && riding.driverId !== this.responderId) {
        /* ⚠ AND DO NOT WAIT FOR IT TO STOP. Braking first is right for the DRIVER and a
           deadlock for a passenger: their brake key is not connected to anything, so the
           truck carries on and they wait for a stop that their own input cannot cause.
           Measured: 24.8 s as somebody else's passenger, riding along holding a brake
           pedal that was not there. */
        inp.tap('interact');
        this.actions.dismounts++;
        this.escapes = 0;
        this.refusedTruckId = riding.id;
        this.refusedMs = 5000;
        this.note(`${riding.name} already has a driver`);
        return inp;
      }
    }

    const inc = this.chooseCall(s);
    if (!inc) { this.note('nothing outstanding'); return inp; }
    // Back at quarters with nothing to go to: stand still, hands empty, out of the road.
    if (inc.standby && !me(s, this).inVehicleId &&
        dist(me(s, this).x, me(s, this).y, inc.x, inc.y) < 12) return inp;

    if (me(s, this).inVehicleId) {
      const riding = s.apparatus.find((a) => a.id === me(s, this).inVehicleId);
      /* A ferry outranks the call: the bot is driving the truck it has TO the truck it
         needs. Walking that errand is what killed every trapped casualty — 200 m on foot
         each way is longer than the 150 s a dose of the medkit buys them. */
      const target = this.ferryTo || this.fetching || inc;
      /* ⚠ A PASSENGER IS NOT A DRIVER, AND FOUR BOTS FIGHTING FOR ONE WHEEL LOOK EXACTLY
       * LIKE A JAMMED TRUCK. Every bot below runs driveTo whether or not the game is
       * listening to it, so three passengers each watched the truck fail to move, each
       * counted four `wedged; backing off` escapes against themselves, and each hit
       * drivingHopeless and got out to WALK. Measured over three shifts: 345 s of a 600 s
       * shift on foot against 90 s driving, and the eight-second window at 311-324 s where
       * all four seats boarded Engine 1 and all four then abandoned it.
       *
       * If somebody else has the wheel, this is not your truck. Get out and take another;
       * there are four of them and there are four of you. */
      /* ⚠ AND `driverId` GOES NULL WHEN THE DRIVER GETS OUT, WITH THE PASSENGERS STILL IN
       * IT. interaction.js gives the wheel to whoever boards first and hands it to nobody
       * when they leave; a passenger cannot promote themselves, because pressing E while
       * aboard is what gets you OUT. So the first version of this rule — which only fired
       * when somebody ELSE held the wheel — left riders sitting in a parked truck for the
       * rest of the shift, holding steering keys the game was not listening to. Measured:
       * 50,231 frames with two or more people aboard one cab, and all four seats ending
       * the shift at the identical distance from the station, because they were in the
       * same vehicle. Not the driver is not the driver, null included. */
      if (riding.driverId !== this.responderId) {
        if (Math.abs(riding.speed) > 1.2) { inp.hold('moveDown'); return inp; }
        inp.tap('interact');
        this.actions.dismounts++;
        this.escapes = 0;
        // Remember it for a few seconds, or the next frame walks straight back in —
        // measured: "already has a driver" and "taking Engine 1" on the same second.
        this.refusedTruckId = riding.id;
        this.refusedMs = 5000;
        this.note(`${riding.name} already has a driver`);
        return inp;
      }
      if (this.ferryTo && dist(riding.x, riding.y, this.ferryTo.x, this.ferryTo.y) < 14) {
        if (Math.abs(riding.speed) > 1.2) { inp.hold('moveDown'); return inp; }
        this.ferryTo = null;
        inp.tap('interact');
        this.actions.dismounts++;
        this.note('out at the other truck');
        return inp;
      }
      if (this.drivingHopeless) {
        // Give up on driving for THIS call and walk it. Without the latch the bot got
        // out, saw it was not at the scene, got straight back in, and did that
        // eighteen times.
        inp.tap('interact'); this.escapes = 0; this.walkingCallId = inc.id;
        this.note('leaving the truck and walking it');
        return inp;
      }
      /* Stop OUTSIDE the door, not at it. See approachSpot. */
      const spot = this.approachFor(s, target);
      const arrived = dist(riding.x, riding.y, target.x, target.y) <= 14 ||
                      dist(riding.x, riding.y, spot.x, spot.y) <= 11;
      if (!arrived) { this.driveTo(spot.x, spot.y, 9); return inp; }
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
    /* ⚠ "ON SCENE" HAS TO INCLUDE WHERE YOU PARKED.
     *
     * Getting out is allowed near the approach spot; being on scene meant within 26 m of
     * the call's own coordinate. When those two disagree the bot dismounts, decides it has
     * not arrived, and climbs straight back in — 584 boardings in one ten-minute shift.
     *
     * A latch ("boots are down, so walk the rest") fixes that and breaks the opposite
     * thing: the trip back for forgotten kit LEAVES the scene, so the latch fires at 26 m
     * and marches the bot back empty-handed. m14's worst-possible-hand-over shift, where
     * every truck is scattered and every tool is dumped 200 m from the station, went from
     * closing a call to closing nothing on all three seeds.
     *
     * Neither. Just let the two definitions agree: you are at the call if you are near the
     * call OR standing where you parked for it. A fetch trip walks away from both, so it
     * still reads as "not at the scene" and still gets driven. */
    const spot = this.approachFor(s, inc);
    const atScene = dist(me(s, this).x, me(s, this).y, inc.x, inc.y) < 26 ||
                    dist(me(s, this).x, me(s, this).y, spot.x, spot.y) < 14;
    if (!atScene && this.walkingCallId === inc.id) { this.walkTowards(s, inc.x, inc.y); return inp; }
    if (!atScene) {
      // Put the line down before walking off. The hose is tethered to its engine, so
      // carrying it away from the scene silently anchors you 34 m from the truck —
      // which is exactly what happened, for ninety seconds, on the way to the next call.
      const held = heldTool(s, me(s, this));
      if (held && held.defId === 'hose') { inp.tap('drop'); this.note('dropping the line'); return inp; }

      /* Take the kit you will need where you are going.
       *
       * This is the GDD's third core-loop step — "choose apparatus AND equipment" — and
       * it is the only way one person can win a trapped-casualty call. The spares live
       * on the apron rack, and a tool in your hands is stowed in the cab when you climb
       * in, so a medkit rides to the scene in the rescue truck and comes back out of its
       * compartment on arrival. Without it the bot extricated at 31 s, drove back across
       * town for the ambulance, and the casualty died at 185 s every single time: the
       * round trip is longer than a trapped critical patient's 149 s of life.
       */
      if (!held && this.plannedApparatus !== 'ambulance' &&
          incidentVictims(s, inc).some((v) => !victimHandled(v) && !v.lost)) {
        const avail = toolsInReachOf(s, me(s, this).x, me(s, this).y);
        const slot = avail.findIndex((a) => a.tool.defId === 'medkit');
        if (slot >= 0 && slot < 5) {
          inp.tap(`slot${slot + 1}`);
          this.actions.toolsTaken++;
          this.note('taking a medkit for the casualty');
          return inp;
        }
      }

      /* ⚠ `|| s.apparatus[0]` IS ENGINE 1, AND IT WAS THE ANSWER FOR EVERYBODY.
       *
       * The board splits the CALLS and it splits the PLANNED apparatus, and then neither
       * of those reached the line that picks a truck to walk to. Four volunteers standing
       * in the same place — which is where the shared trip back for the medkit puts them —
       * all found the same nearest truck and all took it. The crew's own claims are the
       * fix: a truck with somebody else's name on it is not a truck you can have. */
      const spoken = (id) => {
        const a = s.apparatus.find((q) => q.id === id);
        if (!a) return true;
        if (a.driverId && a.driverId !== this.responderId) return true;
        if (this.refusedTruckId === id && this.refusedMs > 0) return true;
        if (!this.crew || !this.crew.trucks) return false;
        /* A claim only holds while the claimant is actually nearer to it than I am.
           Without that clause the board fills up with stale claims — four seats, four
           trucks, all spoken for, nobody in any of them — and the fallback below hands
           everybody the engine again, which is the bug this whole block exists to kill. */
        for (const [rid, tid] of this.crew.trucks) {
          if (rid === this.responderId || tid !== id) continue;
          const other = s.responders.find((r) => r.id === rid);
          if (!other) continue;
          if (dist(other.x, other.y, a.x, a.y) <=
              dist(me(s, this).x, me(s, this).y, a.x, a.y)) return true;
        }
        return false;
      };
      const freeTrucks = s.apparatus.filter((a) => !spoken(a.id));
      /* ⚠ COMMIT TO THE WALK. Choosing the truck fresh every frame is fine when one is
       * parked at your elbow and ruinous when the nearest is two hundred metres away: the
       * call list re-ranks, the planned appliance changes with it, and the volunteer turns
       * round and starts again. m14's worst-possible-hand-over shift — every truck
       * abandoned across the valley, every tool dumped in one heap — measured ONE boarding
       * in ten minutes and 380 seconds of walking, with six calls taken and none reached.
       * Once you have set off for a truck on foot, that is the truck. */
      if (this.hikeTruckId) {
        const hike = s.apparatus.find((a) => a.id === this.hikeTruckId);
        if (!hike || spoken(hike.id) || dist(me(s, this).x, me(s, this).y, hike.x, hike.y) < 12) {
          this.hikeTruckId = null;
        } else {
          this.goToVehicle(s, hike);
          return inp;
        }
      }
      /* The fallback used to be `s.apparatus[0]`, which is Engine 1 — so the moment every
         truck was spoken for, every seat was sent back to the same one. Fall back to
         something with an empty driver's seat before falling back to a name. */
      let ap = freeTrucks.find((a) => a.id === this.plannedApparatus)
        || freeTrucks[0]
        || s.apparatus.find((a) => !a.driverId || a.driverId === this.responderId)
        || s.apparatus[0];
      const near = freeTrucks.slice().sort((a, b) =>
        dist(me(s, this).x, me(s, this).y, a.x, a.y) - dist(me(s, this).x, me(s, this).y, b.x, b.y))[0];
      // The truck you need is across town and the one you came in is at your elbow:
      // drive that one to it rather than walking a hundred metres.
      if (near && ap && near.id !== ap.id &&
          dist(me(s, this).x, me(s, this).y, ap.x, ap.y) > 40 &&
          dist(me(s, this).x, me(s, this).y, near.x, near.y) < 30) {
        this.fetching = { x: ap.x, y: ap.y };
        ap = near;
      }
      // Anything past a sprint is a hike, and a hike gets committed to.
      if (dist(me(s, this).x, me(s, this).y, ap.x, ap.y) > 60) this.hikeTruckId = ap.id;
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
      // Drive to it if there is something to drive. On foot at the scene with the truck
      // you arrived in beside you, walking across town is never the right answer.
      const mine = s.apparatus.slice()
        .filter((a) => a.id !== needsTruck.id)
        .sort((a, b) => dist(me(s, this).x, me(s, this).y, a.x, a.y) - dist(me(s, this).x, me(s, this).y, b.x, b.y))[0];
      if (!this.ferryTo && mine &&
          dist(me(s, this).x, me(s, this).y, needsTruck.x, needsTruck.y) > 60 &&
          dist(me(s, this).x, me(s, this).y, mine.x, mine.y) < 22) {
        this.ferryTo = { x: needsTruck.x, y: needsTruck.y };
        this.note(`driving ${mine.name} over to ${needsTruck.name}`);
        this.goToVehicle(s, mine);
        return inp;
      }
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
      /* ⚠ THE DEAD BAND BETWEEN "IN REACH" AND "WORTH A TRIP".
       *
       * The trip below only fires past 26 m, and a tool is only takeable from about two.
       * Everything in between fell through to work(), which does the job with empty hands
       * and achieves nothing. It never showed up while the bot parked ON the incident,
       * because then the truck was at zero — and it appeared the moment this milestone
       * started stopping twelve metres outside the door. m5 section C: casualties
       * "reached 4 · treated 1", the crew standing over people they could not treat.
       *
       * Twelve metres is a walk, not an expedition. Walk it. */
      if (src && !this.ferryTo &&
          dist(me(s, this).x, me(s, this).y, src.x, src.y) > CONFIG.player.reachM + 1.4 &&
          dist(me(s, this).x, me(s, this).y, src.x, src.y) <= 26) {
        this.note(`stepping over to ${src.name} for the ${job.tool}`);
        this.walkTowards(s, src.x, src.y);
        return inp;
      }
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

  /**
   * Where to stop the truck for a given target.
   *
   * ⚠ NOT THE CALL'S OWN COORDINATE, AND NOT THE KERB EITHER.
   *
   * The coordinate is a building's door, and a door is against a wall — driving at it
   * ground the truck into the brickwork: 324 jams over three shifts, 82% of them nowhere
   * near another appliance.
   *
   * The obvious correction, parking at the nearest carriageway, is worse in a way that
   * only a whole-shift measurement shows: the hose is TETHERED to its engine at 34 m, and
   * Miller Barn is 40 m from the nearest road. Every suite that fights a fire collapsed —
   * m2 reported 0.4 L of water put on anything all shift, m13 closed zero calls in all
   * five weather conditions, and m5's one-person medical call became unwinnable, because
   * the crew had parked out of reach of their own equipment.
   *
   * So: stop twelve metres OUTSIDE the door, on the side the door faces. Off the wall,
   * inside hose reach, and out of the next truck's way because each seat takes its own
   * lane abreast of the others.
   */
  approachFor(s, target) {
    const slot = Math.max(0, s.responders.findIndex((r) => r.id === this.responderId));
    const step = slot === 0 ? 0 : (slot % 2 ? Math.ceil(slot / 2) : -slot / 2) * 10;
    const b = target && target.buildingId ? BUILDING_BY_ID[target.buildingId] : null;
    if (!b) {
      /* A road call, or another truck: it is already somewhere a truck can be.
         ⚠ AND THE KERB HAS TO BE INSIDE `atScene`, OR ARRIVING IS A LOOP. Getting out is
         allowed within 11 m of the spot, and being "on scene" means within 26 m of the
         call — so a spot more than about fourteen metres from the call lets the bot
         dismount, immediately decide it has not arrived, and climb back in. Measured on
         m2's seed 9002: 584 boardings in one shift, the last 500 of them inside forty
         seconds at the ballfield, "taking Rescue 1 / on scene / taking a medkit" over and
         over. If the kerb is further out than that, drive to the call itself. */
      const p = parkSpot(target.x, target.y, slot);
      return dist(p.x, p.y, target.x, target.y) > 14 ? { x: target.x, y: target.y } : p;
    }
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let ux = b.door.x - cx, uy = b.door.y - cy;
    const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    let x = b.door.x + ux * 12 - uy * step;
    let y = b.door.y + uy * 12 + ux * step;
    // If that lane happens to land on somebody else's roof, keep going outward.
    for (let k = 0; k < 4 && buildingAt(x, y); k++) { x += ux * 6; y += uy * 6; }
    return { x, y };
  }

  goToVehicle(s, ap) {
    /* ⚠ E BOARDS THE NEAREST TRUCK, NOT THE ONE YOU MEANT. Standing between two of them,
       the bot pressed E intending Rescue 1, climbed into the tanker parked a metre closer,
       bounced straight back out because the tanker had a driver, and did that eight times
       in one second. If the one you want is not the closest one, walk to it first. */
    const meR = me(s, this);
    const nearest = s.apparatus.slice().sort((a, b) =>
      dist(meR.x, meR.y, a.x, a.y) - dist(meR.x, meR.y, b.x, b.y))[0];
    if (nearest && nearest.id !== ap.id &&
        dist(meR.x, meR.y, nearest.x, nearest.y) <= dist(meR.x, meR.y, ap.x, ap.y)) {
      this.walkTowards(s, ap.x, ap.y);
      return;
    }
    if (dist(me(s, this).x, me(s, this).y, ap.x, ap.y) < CONFIG.player.reachM + 1.8) {
      this.input.tap('interact');
      this.actions.entries++;
      // Boarding ends the errand. Leaving `fetching` set meant the bot arrived at the
      // truck it had driven across town to collect, got out because it had "arrived",
      // got straight back in because it still was not at the call, and did that five
      // thousand times.
      this.fetching = null; this.fetchingId = null;
      this.route = null;
      // Put your name on it the moment you are in it, not when you planned to be —
      // the plan and the truck you actually reached are routinely different things.
      if (this.crew && this.crew.trucks) this.crew.trucks.set(this.responderId, ap.id);
      this.hikeTruckId = null;
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

    /* ⚠ NOBODY SENDS FOUR APPLIANCES TO A DOWNED TREE.
     *
     * The old fallback was `free.length ? free : open` — so the moment the board had
     * fewer open calls than seats, every spare seat piled onto the same one. Measured
     * with four hands: three trucks nose to tail on the same road, each failing to move
     * three metres in 1.4 s, each backing off, from 111 s to past 160 s. 711 jams in
     * three shifts and 49% of them with another appliance inside 13 m — a convoy
     * deadlocking itself.
     *
     * A call has room for as many pairs of hands as it has jobs, and `pickJob` hands out
     * one job at a time: the hazard, and the casualty if there is one. So: two, at most.
     * A seat with nowhere useful to be stands by, which is what the fifth firefighter
     * does in a real station. */
    /* ⚠ `claims` IS A MAP KEYED BY CALL, SO IT CAN ONLY EVER HOLD ONE NAME PER CALL —
       the second person to take a job silently erases the first. Counting attendance out
       of it gives 0 or 1 and never 2, so a cap of "two hands on a call with a casualty"
       could not be reached. Keyed the other way round it answers the question asked. */
    const room = (inc) => {
      if (!this.crew || !this.crew.targets) return true;
      /* ⚠ AND ONLY COUNT THE HANDS THAT ARE ACTUALLY THERE. Counting everybody who has
         merely NAMED this call means a volunteer three hundred metres away, still driving,
         blocks one standing twenty metres from it — and with four seats and a board of
         mostly one-job calls, two of them ended up standing by at the station while the
         town burned. Measured: a crew of two closed 14 calls and a crew of four closed 8,
         which is the exact failure ("four people do not simply all stand at the same
         fire") inverted. The cap is about crowding a scene, so it should count the people
         at the scene. */
      let on = 0;
      for (const [rid, iid] of this.crew.targets) if (rid !== this.responderId && iid === inc.id) on++;
      /* ⚠ MEASURED, NOT CHOSEN, AND NOT A FLAT NUMBER EITHER.
       *
       * A flat two-per-call (three with a casualty) is more generous and worse on every
       * number: three trucks held station 0.5 m apart for thirty seconds, the slowest
       * response went 56 s → 340 s, the mean response to a call that was ultimately lost
       * went 14 s → 100 s. A flat one-per-call fixed all of that and broke the Phase 5
       * exit gate instead — two volunteers lost MORE casualties than one, because a
       * downed pole with a trapped driver is three jobs and the pair were never allowed
       * to stand on it together.
       *
       * So count the jobs. `pickJob` hands out one at a time: each live hazard, and each
       * casualty nobody has dealt with. A tree is one job and gets one pair of hands. A
       * crash into a pole with somebody trapped is three. */
      const vc = incidentVictims(s, inc).filter((v) => !victimHandled(v) && !v.lost);
      /* ⚠ AND A PINNED CASUALTY IS TWO JOBS, NOT ONE. `farm_entrapment` carries no hazard
         object at all — the machine is expressed as the victim's `trappedBy` — so the
         first version of this count read the design's own two-player showcase as a
         one-person call, capped it at one seat, and m5 E5 reported "solo lost at 155s,
         two crew lost at 155s": identical to the second, because the second volunteer was
         never allowed to go. Cutting somebody out and then treating and driving them are
         different pairs of hands. */
      const jobs = incidentHazards(s, inc).filter((h) => !h.resolved).length +
                   vc.length + vc.filter((v) => v.trappedBy).length;
      const cap = Math.max(1, Math.min(3, jobs));
      return on < cap;
    };
    const free = open.filter((i) => !taken(i) && room(i));
    const pool = free.length ? free : open.filter((i) => room(i));
    if (!pool.length) {
      /* Every call already has the hands it can use. Go back to quarters.
         ⚠ NOT "stop where you are". The first version of this returned null and the bot
         froze on the spot — which for three seats meant three trucks abandoned in the
         carriageway, and the jam log went from 49% truck-on-truck to 97%. Standing by is
         a place, and the place is the station. */
      this.targetIncidentId = null;
      this.committedId = null;
      if (this.crew) {
        for (const [id, by] of this.crew.claims) if (by === this.responderId) this.crew.claims.delete(id);
        if (this.crew.targets) this.crew.targets.delete(this.responderId);
      }
      this.note('standing by — every call has somebody on it');
      return { id: '__quarters', x: STATION.spawn.x, y: STATION.spawn.y, place: 'the station',
               headline: 'Standing by', priority: 'routine', standby: true,
               hazardIds: [], victimIds: [] };
    }

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
      if (this.crew.targets) this.crew.targets.set(this.responderId, best.id);
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
    // Yielding is a decision, not a jam. Counting it as one made the first version of the
    // rule below report 1492 jams where the previous run reported 682, purely because
    // waiting for another truck to clear looks identical to being stuck against a wall.
    if (this.yieldingMs > 0) { this.yieldingMs -= CONFIG.sim.stepMs; this.checkMs = 0; this.progressM = 0; }
    if (this.checkMs >= 1400) {
      if (this.progressM < 3 && d > arriveM && this.reverseMs <= 0) {
        this.reverseMs = 1600;
        this.escapes = (this.escapes || 0) + 1;
        this.actions.wedged++;
        /* Where, and what was next to it. A jam against scenery is a pathing problem;
           a jam with another appliance inside a truck length is the crew jamming itself,
           and those are two different milestones. */
        const others = s.apparatus.filter((q) => q.id !== ap.id);
        const nearest = others.length
          ? Math.min(...others.map((q) => dist(ap.x, ap.y, q.x, q.y))) : Infinity;
        this.wedges.push({ x: ap.x, y: ap.y, t: s.simTimeMs, nearestTruckM: nearest });
        this.note('wedged; backing off');
      }
      this.checkMs = 0; this.progressM = 0;
    }

    /* ⚠ TWO TRUCKS NOSE TO NOSE, EACH REVERSING AND TRYING THE SAME LINE AGAIN.
     *
     * Backing off is the right answer to a wall and the wrong answer to another
     * appliance: both of them do it, both come forward again, and the pair sits there.
     * Measured at its worst: 682 jams over three shifts, 98% of them with another truck
     * inside 13 m, one pair holding station 6.8 m apart from 110 s to past 140 s.
     *
     * Two rules, and between them they break every symmetry that made it a deadlock:
     *   - if the thing in the way is MOVING, it is leaving. Wait, do not shunt.
     *   - if it is stopped, one of us goes round, and WHICH of us is decided by
     *     responder id, so we never both pick the same side.
     */
    /* ⚠ AND A TRUNK IN THE ROAD IS A THING IN THE WAY TOO.
     *
     * routeThrough marks an edge with an uncleared tree on it impassable, and when that
     * leaves no path at all its last line is `return [{x: toX, y: toY}]` — go direct. Go
     * direct means straight through the trunk. Measured: an ambulance with a patient in
     * the back sat eight metres west of the Oak Street junction for eighty-three seconds,
     * rocking between +6 and −4 m/s, wedging every five, while the casualty in the back
     * ran down. It is the same problem as another appliance in the way and it takes the
     * same answer, except that a trunk is never about to move. */
    const blockers = [
      ...s.apparatus.filter((q) => q.id !== ap.id),
      /* ⚠ AND A WRECKED CAR IS THE COMMONEST THING IN THE ROAD OF ALL. It is what a crash
         call PUTS there, and the router has never known about it either. Traced: an
         ambulance with a patient in the back stuck ten metres from wrk_3 at the Oak Street
         junction, rocking between +6 and −4 m/s for eighty-three seconds with four escapes
         already spent, while the casualty in the back ran down. */
      ...s.hazards.filter((h) => (h.kind === 'tree' && !h.cleared) || h.kind === 'wreck')
        .map((h) => ({ id: h.id, x: h.x, y: h.y, speed: 0, driverId: null, radiusM: h.radiusM || 2.4 })),
    ];
    const ahead = blockers.find((q) => {
      const gap = dist(ap.x, ap.y, q.x, q.y);
      if (gap > 15 + (q.radiusM || 0)) return false;
      const bearing = Math.atan2(q.y - ap.y, q.x - ap.x);
      return Math.abs(Math.atan2(Math.sin(bearing - ap.angle), Math.cos(bearing - ap.angle))) < 1.0;
    });
    if (ahead) {
      this.yieldingMs = 700;
      if (Math.abs(ahead.speed) > 1.2) {
        // It is clearing the way on its own. Slow down rather than push into it.
        if (Math.abs(ap.speed) > 2) inp.hold('moveDown');
        this.reverseMs = 0;
        return;
      }
      // Stopped in the way. Go round on my own side, always the same side for me.
      const side = this.responderId < ahead.driverId || !ahead.driverId ? 1 : -1;
      const clear = 9 + (ahead.radiusM || 0);
      const px = -Math.sin(want) * side * clear, py = Math.cos(want) * side * clear;
      const swing = Math.atan2((leg.y + py) - ap.y, (leg.x + px) - ap.x);
      const sd = Math.atan2(Math.sin(swing - ap.angle), Math.cos(swing - ap.angle));
      if (Math.abs(sd) > 0.12) inp.hold(sd > 0 ? 'moveRight' : 'moveLeft');
      inp.hold('moveUp');
      this.reverseMs = 0;
      return;
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

