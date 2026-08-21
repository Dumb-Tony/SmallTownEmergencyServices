/* Residents — the people the town is for.
 *
 * GDD core system "NPCs: health, panic, mobility, self-preservation, bad decisions,
 * loose memory", and the design law stated as plainly as it gets: THE TOWN KEEPS GOING
 * WITHOUT YOU. Until now that meant calls arriving and fires spreading on their own
 * clock. It did not mean anybody being there. A town with nobody in it cannot be let
 * down, and eleven buildings that only ever contain a hazard are scenery with a name.
 *
 * Three things they do, and deliberately nothing else:
 *
 *  1. THEY GET THEMSELVES OUT. Most occupants of a burning building leave on their own,
 *     by the door, usually before the crew arrives. This is the load-bearing one: it is
 *     why the player is not obliged to search every structure, and it is what turns an
 *     ABSENCE into information — four live here, three are standing on the grass.
 *  2. SOME DO NOT. Mobility and nerve are drawn once per person from the shift seed, so
 *     it is the town that decides, not the player and not a coin flip at the moment it
 *     matters. Someone who does not get out is registered as a victim of the incident,
 *     inside, with the condition their time in the heat bought them. That is the search,
 *     and it exists because somebody did not come out rather than because a template
 *     said "1 victim".
 *  3. THEY WATCH. A working call draws a crowd, the crowd stands exactly where you want
 *     to work, and the siren is what moves it. `CONFIG.drive.sirenClearRadiusM` has read
 *     "traffic and pedestrians yield inside this" since the first commit, with no
 *     pedestrians anywhere in the build. Now there are some, and Q is a verb.
 *
 * What they must never do, and what the suite holds them to: create a call, keep a call
 * from closing, or take a decision away from the player. A crowd is FRICTION, never a
 * wall — you can always shove through one, it just costs you.
 *
 * Steering is `_drift`, copied from ContainmentDetailWeb\src\sim\anomaly.js (Dev\INDEX.md
 * -> "Steering without pathfinding"). Name kept so the lineage stays greppable, and both
 * of its scars kept with it: probe further than one step, and RELEASE the wall on a
 * longer probe than you TOOK it on.
 */

import { CONFIG } from '../config.js';
import {
  BUILDINGS, BUILDING_BY_ID, WORLD, blockingRectAt, clampToBounds, dist, isOnRoad, pointInRect,
} from '../data/town.js';
import { heatAt, gasAt } from './hazards.js';
import { createVictim } from './victims.js';
import { resolveOnFoot } from './movement.js';

let nextId = 1;
export function resetResidentIds() { nextId = 1; }

/** Who lives where. A barn has nobody in it at 3 a.m.; the apartments have a household. */
const HOUSEHOLD = {
  housing: [3, 5], house: [2, 3], shop: [1, 2], civic: [1, 3],
  industry: [1, 2], barn: [0, 1], clinic: [0, 0], station: [0, 0],
};

export const RESIDENT_STATES = Object.freeze([
  'home', 'about', 'alerted', 'fleeing', 'safe', 'onlooker', 'scattering', 'trapped',
]);

/** Drawn once per shift, from the shift's own stream, so a seed replays with the same
 *  people in the same houses making the same mistakes. */
export function createResidents(rng) {
  const out = [];
  for (const b of BUILDINGS) {
    const band = HOUSEHOLD[b.kind] || [1, 1];
    const n = rng.int(band[0], band[1]);
    for (let i = 0; i < n; i++) out.push(createResident(b, rng));
  }
  return out;
}

function createResident(b, rng) {
  const R = CONFIG.residents;
  return {
    id: `res${nextId++}`,
    homeId: b.id,
    x: b.x + b.w / 2, y: b.y + b.h / 2,
    vx: 0, vy: 0,
    facing: Math.PI / 2,
    insideBuildingId: b.id,
    state: 'home',
    /* Self-preservation, per person. A town where everyone reacts identically has no
     * stories in it: the interesting shift is the one where three walk out and the
     * fourth is still inside because she went back for something. */
    mobility: rng.range(R.mobilityMin, R.mobilityMax),
    nerve: rng.range(0.25, 1),
    reactMs: 0,
    exposureMs: 0,
    victimId: null,
    watching: null,
    scatteredMs: 0,
    tx: b.door.x, ty: b.door.y,
    /* _drift's memory. See ContainmentDetailWeb anomaly.js.
     * `_bestDist` is 1e9 rather than the Infinity it means: the town is 420 m across, so
     * any real distance beats it, and the suite sweeps every number in the state for
     * non-finite values because a NaN position is unrecoverable. One Infinity per
     * resident is nineteen failures in a check that exists to catch a real bug. */
    _slideSign: 0, _bestDist: 1e9, _stuckMs: 0, _progressTarget: null, _why: 'idle',
  };
}

/* ── what a crowd costs ──────────────────────────────────────────────────────
 * Consumed by stepPlayerMovement as a speed multiplier. This is the whole of the
 * "they get in the way" mechanic: one number, wired into a number the game already
 * reads, rather than a second collision system nobody can debug.
 */

/** 1 in clear air, down to CONFIG.residents.crowdDragMin in the thick of it. */
export function crowdDragAt(state, x, y) {
  if (!state.residents) return 1;
  const R = CONFIG.residents;
  let near = 0;
  for (const r of state.residents) {
    if (r.state !== 'onlooker') continue;
    if (dist(r.x, r.y, x, y) < R.crowdRadiusM) near++;
  }
  if (!near) return 1;
  return Math.max(R.crowdDragMin, 1 - near * R.crowdDragPerHead);
}

/** Everyone standing around this incident right now. The HUD counts them. */
export function crowdAt(state, incidentId) {
  if (!state.residents) return 0;
  let n = 0;
  for (const r of state.residents) if (r.state === 'onlooker' && r.watching === incidentId) n++;
  return n;
}

/** How many people are unaccounted for inside this building — the number the game is
 *  really about. A resident who is `trapped` is somebody's victim now, so they count. */
export function stillInside(state, buildingId) {
  if (!state.residents) return 0;
  let n = 0;
  for (const r of state.residents) {
    if (r.homeId !== buildingId) continue;
    if (r.state === 'home' || r.state === 'alerted' || r.state === 'trapped') n++;
  }
  return n;
}

/** The fraction of a structure that is alight, 0..1. Not a distance — a whole-building
 *  number, because smoke is a whole-building problem. */
function involvement(state, buildingId) {
  for (const h of state.hazards) {
    if (h.kind !== 'fire' || h.buildingId !== buildingId) continue;
    if (!h.cells.length) return 0;
    let burning = 0;
    for (const c of h.cells) if (c.burning) burning++;
    return burning / h.cells.length;
  }
  return 0;
}

/** How many of this building's people are already standing outside it. */
export function alreadyOut(state, buildingId) {
  if (!state.residents) return 0;
  let n = 0;
  for (const r of state.residents) {
    if (r.homeId !== buildingId) continue;
    if (r.state === 'fleeing' || r.state === 'safe' || r.state === 'onlooker' ||
        r.state === 'scattering') n++;
  }
  return n;
}

/* ── the step ────────────────────────────────────────────────────────────── */

/**
 * One step for everybody who lives here.
 * @returns {Array<object>} events: people out, people trapped, crowds gathering.
 */
export function stepResidents(state, dtMs, rng) {
  const out = [];
  if (!state.residents || !state.residents.length) return out;
  const R = CONFIG.residents;
  const dt = dtMs / 1000;

  // The sirens, once, rather than once per person per apparatus.
  const loud = state.apparatus.filter((a) => a.siren);

  for (const r of state.residents) {
    if (r.state === 'trapped') continue;      // the victim system owns them now

    const home = BUILDING_BY_ID[r.homeId];
    const hx = home.x + home.w / 2, hy = home.y + home.h / 2;

    /* Danger is read where the person is, except at home, where it is read at the
     * middle of the building. Somebody asleep at the back of the feed store does not
     * get to be lucky because the fire started at the front. */
    const at = r.state === 'home' ? { x: hx, y: hy } : { x: r.x, y: r.y };
    const threat = heatAt(state, at.x, at.y) + gasAt(state, at.x, at.y) * 0.4;
    /* Smoke does not care which room you are in.
     *
     * Exposure was local heat alone, and `heatAt` reaches 9 m — so in Pinecrest
     * Apartments, 46 m by 36 m, somebody at the far end of a fully involved building was
     * in clear air by the model and walked out with nothing on the clock. Measured over
     * 52 people: nobody was ever trapped, in any building, on any seed. Involvement is
     * the fraction of the structure alight, it applies everywhere inside it at once, and
     * it is what actually stops people getting out of big buildings. */
    const involved = r.insideBuildingId ? involvement(state, r.insideBuildingId) : 0;

    switch (r.state) {
      case 'home':
      case 'about': {
        if (threat > R.alertHeat) {
          /* Hesitation is the "bad decisions" half of the GDD's NPC line, and it is a
           * clock rather than a dice roll so that the player can beat it. Nerve scales
           * it: the steady ones are moving before you are out of the cab.
           *
           * ⚠ THE HESITATION COSTS THE SAME AS THE WALK. Exposure used to start only when
           * they began moving, which made the whole clock free: measured over 24
           * households and 52 people, NOBODY was ever trapped, because the seven seconds
           * somebody spends deciding it is really a fire were seven seconds the fire did
           * not get. Standing in it is standing in it. */
          if (r.insideBuildingId) r.exposureMs += dtMs * (0.35 + threat + involved * 0.8);
          if (r.exposureMs >= R.collapseMs) {
            const v = trapAsVictim(state, r, home, R);
            out.push({ type: 'RESIDENT_TRAPPED', residentId: r.id, victimId: v.id,
              buildingId: home.id, incidentId: v.incidentId });
            break;
          }
          r.reactMs += dtMs;
          if (r.reactMs >= R.reactMs * (1.4 - r.nerve)) {
            r.state = 'alerted';
            r.tx = home.door.x; r.ty = home.door.y;
            resetSteering(r);
          }
          break;
        }
        r.reactMs = 0;
        if (r.state === 'home') {
          /* PEOPLE COME OUT TO LOOK. Without this the only way anybody ever saw a fire
           * was to be outdoors already when it started, so a crowd took a minute and a
           * half to assemble out of whoever happened to be wandering past — which is not
           * a crowd, it is a coincidence. They leave by the door like anyone else; the
           * ring is chosen once they are on the street. */
          if (worthWatching(state, r, R) && rng.float() < R.curiosityChance * dt) {
            r.state = 'about';
            r.tx = home.door.x; r.ty = home.door.y;
            resetSteering(r);
            break;
          }
          // A few people are out and about at any moment. The town is not a diorama.
          if (rng.float() < R.wanderChance * dt) {
            r.state = 'about';
            const a = rng.range(0, Math.PI * 2), d = rng.range(6, R.wanderM);
            const p = clampToBounds(hx + Math.cos(a) * d, hy + Math.sin(a) * d, 1);
            r.tx = p.x; r.ty = p.y;
            resetSteering(r);
          }
          break;
        }
        /* `about`: something to watch first, then the waypoint, then home again.
         * The order matters. With the arrival check first, somebody who walked out
         * specifically to look reached their own doorstep, was sent straight back inside,
         * and only then got asked whether there was anything worth watching. */
        maybeGawk(state, r, R);
        if (r.state === 'onlooker') break;
        walk(state, r, R.walkSpeed, dtMs);
        if (dist(r.x, r.y, r.tx, r.ty) < 2) {
          if (r.tx === home.door.x && r.ty === home.door.y && !r.insideBuildingId) {
            r.state = 'home'; r.insideBuildingId = home.id;
          } else { r.tx = home.door.x; r.ty = home.door.y; resetSteering(r); }
        }
        break;
      }

      case 'alerted': {
        /* Exposure is what decides it, and it runs on the clock whether or not the
         * player is in the building. Enough of it and they are not walking out. */
        r.exposureMs += dtMs * (0.35 + threat + involved * 0.8);
        if (r.exposureMs >= R.collapseMs) {
          const v = trapAsVictim(state, r, home, R);
          out.push({ type: 'RESIDENT_TRAPPED', residentId: r.id, victimId: v.id,
            buildingId: home.id, incidentId: v.incidentId });
          break;
        }
        walk(state, r, R.walkSpeed * R.fleeSpeedMul, dtMs);
        if (!r.insideBuildingId && dist(r.x, r.y, home.door.x, home.door.y) < R.exitRadiusM * 2) {
          r.state = 'fleeing';
          const a = Math.atan2(r.y - hy, r.x - hx) || 0;
          const p = clampToBounds(hx + Math.cos(a) * R.safeM, hy + Math.sin(a) * R.safeM, 1);
          r.tx = p.x; r.ty = p.y;
          resetSteering(r);
          /* The counts travel WITH the event. The radio line is only worth saying twice —
           * the first person out, who tells you how many are behind them, and the last
           * one, who tells you to stop looking — and working that out after the fact
           * means asking the resident list a question it has already answered. */
          out.push({
            type: 'RESIDENT_OUT', residentId: r.id, buildingId: home.id,
            insideAfter: stillInside(state, home.id), outSoFar: alreadyOut(state, home.id),
          });
        }
        break;
      }

      case 'fleeing': {
        walk(state, r, R.walkSpeed * R.fleeSpeedMul, dtMs);
        if (dist(r.x, r.y, r.tx, r.ty) < 2 || dist(r.x, r.y, hx, hy) > R.safeM) r.state = 'safe';
        break;
      }

      case 'safe': {
        r.vx = 0; r.vy = 0;
        // Still too close to what is burning? Keep going.
        if (threat > R.alertHeat) {
          r.state = 'fleeing';
          const a = Math.atan2(r.y - hy, r.x - hx) || 0;
          const p = clampToBounds(r.x + Math.cos(a) * 14, r.y + Math.sin(a) * 14, 1);
          r.tx = p.x; r.ty = p.y;
          resetSteering(r);
          break;
        }
        maybeGawk(state, r, R);
        break;
      }

      case 'onlooker': {
        const inc = state.incidents.find((i) => i.id === r.watching);
        if (!inc || inc.status !== 'active') { goHome(r, home); break; }
        if (yieldsToSiren(state, r, loud, R)) break;
        if (dist(r.x, r.y, r.tx, r.ty) > 1.6) walk(state, r, R.walkSpeed * 0.8, dtMs);
        else { r.vx = 0; r.vy = 0; r.facing = Math.atan2(inc.y - r.y, inc.x - r.x); }
        break;
      }

      case 'scattering': {
        r.scatteredMs -= dtMs;
        walk(state, r, R.walkSpeed * R.fleeSpeedMul, dtMs);
        if (r.scatteredMs <= 0) { r.state = 'safe'; r.watching = null; }
        break;
      }

      default: break;
    }
  }

  return out;
}

/* ── the pieces ──────────────────────────────────────────────────────────── */

function resetSteering(r) {
  r._slideSign = 0; r._bestDist = 1e9; r._stuckMs = 0; r._progressTarget = null;
}

function goHome(r, home) {
  r.state = 'about';
  r.watching = null;
  r.tx = home.door.x; r.ty = home.door.y;
  resetSteering(r);
}

/** A resident who ran out of time. They stop being a resident the simulation drives and
 *  become a patient the crew has to find — same object shape as every other casualty, so
 *  nothing downstream can tell where they came from. */
function trapAsVictim(state, r, home, R) {
  const critical = r.exposureMs >= R.collapseMs * R.criticalExposureFrac;
  const v = createVictim({
    incidentId: hostIncidentFor(state, home.id),
    x: r.x, y: r.y,
    severity: critical ? 'critical' : 'injured',
    insideBuildingId: home.id,
    panics: true,
  });
  if (critical) v.needsTransport = true;
  state.victims.push(v);
  const inc = state.incidents.find((i) => i.id === v.incidentId);
  if (inc) inc.victimIds.push(v.id);
  r.state = 'trapped';
  r.victimId = v.id;
  r.vx = 0; r.vy = 0;
  return v;
}

/** The open call at this building, if there is one. A fire whose call was already lost
 *  has no incident to attach to, and a casualty with `incidentId: null` is handled
 *  everywhere it matters — checked, because a person is not less trapped for it. */
function hostIncidentFor(state, buildingId) {
  const inc = state.incidents.find((i) => i.buildingId === buildingId && i.status === 'active');
  return inc ? inc.id : null;
}

/** A call is a thing to look at. People come from a distance and stop at a distance —
 *  they are nosy, not suicidal, so the ring they stand on is outside the working area
 *  rather than in the middle of it. */
/** The nearest call this person could go and stand at, or null. */
function worthWatching(state, r, R) {
  let best = null, bestD = R.gatherRadiusM;
  for (const inc of state.incidents) {
    if (inc.status !== 'active' || !inc.everWorked) continue;
    const d = dist(r.x, r.y, inc.x, inc.y);
    if (d < bestD) { bestD = d; best = inc; }
  }
  return best;
}

function maybeGawk(state, r, R) {
  if (r.state !== 'safe' && r.state !== 'about') return;
  if (r.insideBuildingId) return;   // get out of the house first
  const best = worthWatching(state, r, R);
  if (!best) return;
  r.state = 'onlooker';
  r.watching = best.id;
  const p = gawkSpot(best, r, R);
  r.tx = p.x; r.ty = p.y;
  resetSteering(r);
}

/** Where on the ring.
 *
 * Everybody standing on their own bearing from the incident spreads a crowd evenly around
 * a circle, and an even circle of five people 11 m out is 13 m between neighbours — the
 * player walks between them and the crowd is decoration. Measured: worst drag on the walk
 * in was 1.00, at every sample, for three minutes.
 *
 * People stand ON THE STREET, which is also where the crew comes from. Preferring road
 * bearings clusters them into the one arc that is actually in the way, and it is the more
 * truthful behaviour of the two. */
function gawkSpot(inc, r, R) {
  let bestOn = null, bestOnD = Infinity, bestOff = null, bestOffD = Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const p = clampToBounds(inc.x + Math.cos(a) * R.gawkRadiusM, inc.y + Math.sin(a) * R.gawkRadiusM, 1);
    if (blockingRectAt(p.x, p.y, R.radiusM)) continue;     // not inside the building
    const d = dist(r.x, r.y, p.x, p.y);
    if (isOnRoad(p.x, p.y)) { if (d < bestOnD) { bestOnD = d; bestOn = p; } }
    else if (d < bestOffD) { bestOffD = d; bestOff = p; }
  }
  return bestOn || bestOff || { x: inc.x, y: inc.y };
}

/** The siren, finally doing what its config entry has always claimed. Yielding is a
 *  timed state rather than a nudge, because a crowd that re-forms the instant you switch
 *  off is a crowd the siren did not clear. */
function yieldsToSiren(state, r, loud, R) {
  for (const a of loud) {
    if (dist(a.x, a.y, r.x, r.y) > CONFIG.drive.sirenClearRadiusM) continue;
    const ang = Math.atan2(r.y - a.y, r.x - a.x) || 0;
    const p = clampToBounds(r.x + Math.cos(ang) * R.gawkRadiusM, r.y + Math.sin(ang) * R.gawkRadiusM, 1);
    r.state = 'scattering';
    r.scatteredMs = R.scatterMs;
    r.tx = p.x; r.ty = p.y;
    resetSteering(r);
    return true;
  }
  return false;
}

/* ── steering ────────────────────────────────────────────────────────────────
 * `_drift`, from ContainmentDetailWeb\src\sim\anomaly.js. Straight on when there is room,
 * otherwise commit to one side and rotate the heading THAT WAY ONLY until something
 * opens. Memoryless, so it can and does take the long way round; that is the point.
 */

function walk(state, r, speed, dtMs) {
  const step = speed * r.mobility * (dtMs / 1000);
  if (step <= 0) return;
  const target = { x: r.tx, y: r.ty };
  const want = Math.atan2(target.y - r.y, target.x - r.x);

  /* ⚠ PROBE FURTHER THAN ONE STEP. A step at walking pace is 28 mm, and a 28 mm probe
   * calls any heading clear that is not literally inside the wall — so they step at the
   * building, get refused, turn tangentially for one step, find the direct heading clear
   * again from 3 cm out, and turn back. A metre of lookahead is what turns that
   * oscillation into wall-following. */
  const probe = Math.max(step, 1.2);
  const RAD = CONFIG.residents.radiusM;
  const clear = (a, d) => {
    const nx = r.x + Math.cos(a) * d, ny = r.y + Math.sin(a) * d;
    if (nx < 1 || ny < 1 || nx > WORLD.widthM - 1 || ny > WORLD.heightM - 1) return false;
    if (r.insideBuildingId) return true;    // inside, resolveOnFoot owns the walls
    const b = blockingRectAt(nx, ny, RAD);
    if (!b) return true;
    // A door is a hole in the wall, exactly as it is for a responder.
    return !!(b.door && dist(nx, ny, b.door.x, b.door.y) < 3.4);
  };
  const go = (a, why) => {
    r.vx = Math.cos(a) * speed * r.mobility;
    r.vy = Math.sin(a) * speed * r.mobility;
    r.x += Math.cos(a) * step;
    r.y += Math.sin(a) * step;
    r.facing = a;
    r._why = why;
  };

  const Q = Math.PI / 2;

  /* ⚠ THE COMMITMENT IS RELEASED ON A LONGER PROBE THAN IT IS TAKEN. Releasing the
   * instant a 1.2 m direct hop opens up produces creep-and-thrash: edge diagonally at the
   * wall until direct is blocked, follow for one step, find direct clear again 3 cm
   * further out, release, and re-pick the side from scratch — averaging zero progress. */
  if (clear(want, probe)) {
    go(want, 'direct');
    if (clear(want, probe * 2.5)) r._slideSign = 0;
    finishStep(r);
    return;
  }

  // A hand on the wall can be the wrong hand: if no progress for a while, try the other.
  const d = dist(r.x, r.y, target.x, target.y);
  const key = `${Math.round(target.x)},${Math.round(target.y)}`;
  if (key !== r._progressTarget) { r._progressTarget = key; r._bestDist = d; r._stuckMs = 0; }
  if (d < r._bestDist - 0.25) { r._bestDist = d; r._stuckMs = 0; } else r._stuckMs += dtMs;
  if (r._stuckMs >= CONFIG.residents.reroundMs) {
    r._slideSign = -(r._slideSign || 1);
    r._stuckMs = 0;
    r._bestDist = d;
  }

  if (!r._slideSign) {
    const cw = clear(want + Q, probe), ccw = clear(want - Q, probe);
    if (cw !== ccw) r._slideSign = cw ? 1 : -1;
    else {
      const endsAt = (a) => dist(r.x + Math.cos(a) * probe, r.y + Math.sin(a) * probe, target.x, target.y);
      r._slideSign = endsAt(want + Q) <= endsAt(want - Q) ? 1 : -1;
    }
  }
  const s = r._slideSign;
  for (let k = 1; k <= 16; k++) {
    const off = s * k * (Math.PI / 12);       // 15 degrees at a time, out to 240
    if (clear(want + off, probe)) { go(want + off, 'follow'); finishStep(r); return; }
  }

  // Nowhere with a metre in it. Take what there is rather than freezing.
  for (const off of [0, s * Q, -s * Q, Math.PI]) {
    if (clear(want + off, step)) { go(want + off, 'crawl'); finishStep(r); return; }
  }
  r.vx = 0; r.vy = 0; r._why = 'stuck';
  finishStep(r);
}

/** Containment and bounds, shared with the crew so a resident cannot walk through a wall
 *  the player has to walk around. */
function finishStep(r) {
  resolveOnFoot(r, CONFIG.residents.radiusM);
  const c = clampToBounds(r.x, r.y, CONFIG.residents.radiusM);
  r.x = c.x; r.y = c.y;
  if (r.insideBuildingId && !pointInRect(r.x, r.y, BUILDING_BY_ID[r.insideBuildingId])) {
    r.insideBuildingId = null;
  }
}
