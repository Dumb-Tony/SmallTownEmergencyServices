/* The town has people in it.
 *
 * GDD core system "NPCs: health, panic, mobility, self-preservation, bad decisions, loose
 * memory", and the design law with somebody standing in it at last. The measurement
 * behind every number here is tools/_residentdiag.js.
 *
 * What it found, and what is therefore worth locking:
 *   - a household gets ITSELF out, in about 16.5 s, against the ~25 s it takes to cross
 *     town in the engine. The crew arrives to be told who is still inside;
 *   - 5.8% of people do not make it out, never more than one from a household. That
 *     number is a distribution, not a switch, and the section below asserts the shape of
 *     it rather than the exact figure — it is the difference between a system with
 *     stories in it and one with none;
 *   - a call draws a crowd, the crowd stands on the ROAD side where the crew comes from,
 *     and it costs a responder walking in about a quarter of their speed. The siren is
 *     what moves it, which is the first thing the siren has ever done;
 *   - and none of it is allowed to touch the game: residents create no calls, hold no
 *     tools, drive nothing, and cannot keep a call from closing.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, createInitialState } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import { createFire } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { BUILDINGS, BUILDING_BY_ID, dist, isOnRoad, pointInRect } from '../src/data/town.js';
import {
  createResidents, stepResidents, resetResidentIds, crowdDragAt, crowdAt,
  stillInside, alreadyOut, RESIDENT_STATES,
} from '../src/sim/residents.js';
import { encodeSnapshot, applySnapshot } from '../src/net/protocol.js';
import { reportCard } from '../src/ui/hud.js';
import { Rng } from '../src/core/rng.js';

const STEP = CONFIG.sim.stepMs;
const R = CONFIG.residents;

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const le = (n, a, b) => ok(n, a <= b, `got ${a}, want <= ${b}`);
const ge = (n, a, b) => ok(n, a >= b, `got ${a}, want >= ${b}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const f = (n, d = 1) => Number(n).toFixed(d);

let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0 ? `ALL-PASS  ${passes} assertions`
    : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==STESTEST-END==';
}

const nonFinite = (root) => {
  const bad = [];
  const seen = new Set();
  const walk = (o, path, d) => {
    if (d > 7 || !o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(`${path}.${k}=${v}`); }
      else if (v && typeof v === 'object') walk(v, `${path}.${k}`, d + 1);
    }
  };
  walk(root, '', 0);
  return bad;
};

/** A fire in a building, with an open call on it unless told otherwise. */
function fireAt(g, buildingId, { withIncident = true, seedCells = 3 } = {}) {
  const s = g.state;
  const b = BUILDING_BY_ID[buildingId];
  let inc = null;
  if (withIncident) {
    inc = {
      id: `incR${s.incidents.length + 1}`, templateId: 'kitchen_fire', family: 'fire',
      headline: 'Structure fire', place: b.name, x: b.door.x, y: b.door.y,
      buildingId: b.id, roadId: null, priority: 'high', report: '', createdMs: s.simTimeMs,
      ageMs: 0, danger: 0, peakDanger: 0, status: 'active', hazardIds: [], victimIds: [],
      consequences: [], capabilities: [], updates: [], lastUpdateText: null,
      resolvedMs: null, outcomeNote: null, everWorked: true,
    };
    s.incidents.push(inc);
  }
  const fire = createFire(buildingId, { seedCells, heat: 1.0, from: 'centre' });
  if (inc) addHazard(s, inc, fire); else s.hazards.push(fire);
  return { inc, fire };
}

/** Run the town, keeping a call open if one was given. */
function run(g, ms, inc = null) {
  const s = g.state;
  for (let t = 0; t < ms && s.mode === MODES.PLAYING; t += STEP) {
    g.frame(STEP, null);
    if (inc) inc.danger = 0;      // somebody is working it, so it is never declared lost
  }
}

/* ── A. who lives here ───────────────────────────────────────────────────── */

function sectionA() {
lines.push('--- A. a town with people in it, drawn from a stream of their own ---');
  clearSave();
  const g = new Game({ seed: 1200 });
  g.startShift();
  const s = g.state;

  gt('A1 the town has residents at all', s.residents.length, 8);
  ok('A2 every one of them has a home that exists',
    s.residents.every((r) => !!BUILDING_BY_ID[r.homeId]));
  ok('A3 and starts inside it',
    s.residents.every((r) => r.insideBuildingId === r.homeId &&
      pointInRect(r.x, r.y, BUILDING_BY_ID[r.homeId])));
  eq('A4 nobody lives in the station', s.residents.filter((r) => r.homeId === 'station').length, 0);
  eq('A5 nor in the clinic', s.residents.filter((r) => r.homeId === 'clinic').length, 0);
  ok('A6 the apartments hold the most people of any building',
    s.residents.filter((r) => r.homeId === 'apartments').length >= 3);
  ok('A7 every state a resident can be in is declared',
    s.residents.every((r) => RESIDENT_STATES.includes(r.state)));
  ok('A8 self-preservation varies per person, inside the band CONFIG sets',
    s.residents.every((r) => r.mobility >= R.mobilityMin && r.mobility <= R.mobilityMax) &&
    new Set(s.residents.map((r) => r.mobility.toFixed(3))).size > 1);
  ok('A9 and so does nerve', new Set(s.residents.map((r) => r.nerve.toFixed(3))).size > 1);
  eq('A10 nothing about them is non-finite', nonFinite(s.residents).length, 0);

  // the same town, twice
  clearSave();
  const h = new Game({ seed: 1200 }); h.startShift();
  const sig = (st) => st.residents.map((r) => `${r.homeId}:${r.nerve.toFixed(4)}:${r.mobility.toFixed(4)}`).join('|');
  eq('A11 the same seed puts the same people in the same houses', sig(h.state), sig(s));
  clearSave();
  const k = new Game({ seed: 1201 }); k.startShift();
  ok('A12 a different seed does not', sig(k.state) !== sig(s));

  /* The whole reason residents draw from their own stream: dispatch, hazards and
     incident sites all draw from the shift stream, and a resident stepping outside must
     not be able to move a call. */
  clearSave();
  const a = new Game({ seed: 1202 }); a.startShift();
  const beforeShift = a.rng.draws, beforePeople = a.people.draws;
  run(a, 20000);
  gt('A13 residents really do draw while the town runs', a.people.draws, beforePeople);
  ok('A14 and the shift stream is a different object', a.rng !== a.people);
  eq('A15 with a different seed', a.rng.seed === a.people.seed, false);
  eq('A16 and its own label', a.people.label, 'residents');

  // createInitialState populates them without a Game
  resetResidentIds();
  const bare = createInitialState({ seed: 9, seedLabel: 't', town: defaultTown() });
  gt('A17 a bare state has residents too', bare.residents.length, 0);
  eq('A18 and resident ids are unique', new Set(bare.residents.map((r) => r.id)).size,
    bare.residents.length);
  eq('A19 createResidents is pure in its rng', createResidents(new Rng(5, 'x')).length,
    createResidents(new Rng(5, 'x')).length);
emit('A done');
}

/* ── B. they get themselves out ──────────────────────────────────────────── */

function sectionB() {
lines.push('--- B. a household gets itself out, before anybody turns up ---');
  clearSave();
  const g = new Game({ seed: 1210 });
  g.startShift();
  const s = g.state;

  // pick a building that actually has somebody in it on this seed
  const target = BUILDINGS.map((b) => b.id)
    .filter((id) => id !== 'station' && id !== 'clinic')
    .find((id) => s.residents.filter((r) => r.homeId === id).length >= 2);
  ok('B1 some building on this seed has a household in it', !!target, String(target));
  const lived = s.residents.filter((r) => r.homeId === target).length;

  eq('B2 before the fire, everybody is accounted for indoors', stillInside(s, target), lived);
  const { inc } = fireAt(g, target);

  let alertedAt = null, firstOutAt = null, clearAt = null;
  for (let t = 0; t < 120000 && s.mode === MODES.PLAYING; t += STEP) {
    g.frame(STEP, null);
    inc.danger = 0;
    if (alertedAt === null && s.residents.some((r) => r.homeId === target && r.state === 'alerted')) {
      alertedAt = s.simTimeMs;
    }
    if (firstOutAt === null && alreadyOut(s, target) >= 1) firstOutAt = s.simTimeMs;
    if (stillInside(s, target) === 0) { clearAt = s.simTimeMs; break; }
  }

  ok('B3 a fire in the building alerts the people in it', alertedAt !== null,
    `alerted at ${alertedAt}`);
  ok('B4 without anybody being sent', s.responders[0].insideBuildingId !== target);
  ok('B5 somebody is out within twenty seconds', firstOutAt !== null && firstOutAt < 20000,
    `${firstOutAt == null ? 'never' : f(firstOutAt / 1000, 1) + ' s'}`);
  ok('B6 and the building is clear well before the shift is', clearAt !== null && clearAt < 30000,
    `${clearAt == null ? 'never' : f(clearAt / 1000, 1) + ' s'}`);
  ok('B7 they went out through the door, not through a wall',
    s.residents.filter((r) => r.homeId === target)
      .every((r) => r.insideBuildingId === null || r.state === 'trapped'));
  ok('B8 and are outside the building they came out of',
    s.residents.filter((r) => r.homeId === target && r.state !== 'trapped')
      .every((r) => !pointInRect(r.x, r.y, BUILDING_BY_ID[target])));

  const said = s.radio.map((l) => l.text).join(' ');
  ok('B9 the radio said somebody was out', /is out of|everybody out of/i.test(said), said.slice(-160));
  const outLines = s.radio.filter((l) => /out of /i.test(l.text)).length;
  le('B10 and did not say it once per person — two lines at most per building', outLines, 2);
  ok('B11 the last of them was the "that is everybody" line',
    /everybody out of/i.test(said) || stillInside(s, target) > 0);

  // a building with nobody in it says nothing
  clearSave();
  const q = new Game({ seed: 1211 });
  q.startShift();
  const empty = BUILDINGS.map((b) => b.id)
    .find((id) => q.state.residents.filter((r) => r.homeId === id).length === 0);
  if (empty) {
    const before = q.state.radio.length;
    const e2 = fireAt(q, empty);
    run(q, 40000, e2.inc);
    const newLines = q.state.radio.slice(before).map((l) => l.text).join(' ');
    ok('B12 a building nobody lives in reports nobody coming out of it',
      !/out of /i.test(newLines), newLines.slice(0, 140));
  } else {
    ok('B12 (no empty building on this seed to test with)', true);
  }
emit('B done');
}

/* ── C. the ones who do not ──────────────────────────────────────────────── */

function sectionC() {
lines.push('--- C. somebody who does not get out is a casualty, not a statistic ---');

  /* The tail has to EXIST, and it has to be a tail. Twelve households across four seeds
     is the same shape _residentdiag.js measures at 5.8%: rare, never a whole household,
     and never zero. Asserting a band rather than a figure — the figure is a
     distribution, and pinning it would make every future tuning change a test failure
     instead of a decision. */
  let people = 0, trapped = 0, worstHousehold = 0, householdsHit = 0;
  const seeds = [400, 401, 402, 403];
  const targets = ['apartments', 'farmhouse', 'pizza', 'school', 'hardware', 'feedstore'];
  for (const seed of seeds) {
    for (const target of targets) {
      clearSave();
      const g = new Game({ seed });
      g.startShift();
      const s = g.state;
      const lived = s.residents.filter((r) => r.homeId === target).length;
      if (!lived) continue;
      people += lived;
      const { inc } = fireAt(g, target);
      for (let t = 0; t < 90000 && s.mode === MODES.PLAYING; t += STEP) {
        g.frame(STEP, null);
        inc.danger = 0;
        if (stillInside(s, target) === 0) break;
      }
      const n = s.residents.filter((r) => r.homeId === target && r.state === 'trapped').length;
      trapped += n;
      if (n > 0) householdsHit++;
      worstHousehold = Math.max(worstHousehold, n);
    }
  }
  const pct = (trapped / Math.max(1, people)) * 100;
  lines.push(`      ${people} people over ${seeds.length} seeds: ${trapped} did not get out ` +
    `(${f(pct, 1)}%), across ${householdsHit} households, worst ${worstHousehold} from one`);
  gt('C1 somebody, somewhere, does not make it out', trapped, 0);
  le('C2 but it is a tail, not the common case — under a fifth of the town', pct, 20);
  le('C3 and never a whole household at once', worstHousehold, 2);
  emit('running C');

  /* Now one in detail. Force it rather than hunting for it: exposure is the clock, so
     spending it is the whole of the mechanism. */
  clearSave();
  const g = new Game({ seed: 1220 });
  g.startShift();
  const s = g.state;
  const target = BUILDINGS.map((b) => b.id)
    .find((id) => s.residents.filter((r) => r.homeId === id).length >= 1 &&
      id !== 'station' && id !== 'clinic');
  const victim = s.residents.find((r) => r.homeId === target);
  const { inc } = fireAt(g, target);
  victim.nerve = 0.25;
  victim.exposureMs = R.collapseMs - 200;    // one step from it
  const before = s.victims.length;
  const confBefore = s.town.confidence;
  run(g, 2000, inc);

  eq('C4 they are trapped', victim.state, 'trapped');
  eq('C5 and the town has one more casualty than it had', s.victims.length, before + 1);
  const v = s.victims.find((q2) => q2.id === victim.victimId);
  ok('C6 which is the person, not a copy of them', !!v);
  eq('C7 found inside the building they lived in', v.insideBuildingId, target);
  ok('C8 with a condition, like any other patient', v.condition > 0 && v.condition <= 1,
    `${v.condition}`);
  ok('C9 attached to the call that is already running', inc.victimIds.includes(v.id));
  eq('C10 and stillInside still counts them, because they ARE still inside',
    stillInside(s, target) >= 1, true);
  ok('C11 the radio said so', /did not get out/i.test(s.radio.map((l) => l.text).join(' ')));

  /* Confidence must not move here. It moves when the casualty is saved or lost, and
     paying twice for the same person would make a house fire worth more than anything
     else on the board. */
  ok('C12 being trapped costs the town no confidence by itself',
    Math.abs(s.town.confidence - confBefore) < 1e-9, `${confBefore} -> ${s.town.confidence}`);
  eq('C13 the shift outcome counted them', s.outcome.residentsTrapped >= 1, true);

  // a fire whose call was lost still traps people, and nothing throws
  clearSave();
  const h = new Game({ seed: 1221 });
  h.startShift();
  const s2 = h.state;
  const t2 = BUILDINGS.map((b) => b.id)
    .find((id) => s2.residents.filter((r) => r.homeId === id).length >= 1 &&
      id !== 'station' && id !== 'clinic');
  const v2 = s2.residents.find((r) => r.homeId === t2);
  fireAt(h, t2, { withIncident: false });
  v2.exposureMs = R.collapseMs - 200;
  let threw = null;
  try { run(h, 2000); } catch (err) { threw = (err && err.message) || String(err); }
  eq('C14 a fire nobody is counting still traps the people inside it', v2.state, 'trapped');
  eq('C15 and the casualty it makes has no call to belong to',
    (s2.victims.find((q2) => q2.id === v2.victimId) || {}).incidentId, null);
  eq('C16 and nothing threw over it', threw, null);
  run(h, 4000);
  eq('C17 nor over the next four seconds of it', nonFinite(s2).length, 0);
emit('C done');
}

/* ── D. the crowd, and the siren that moves it ───────────────────────────── */

function sectionD() {
lines.push('--- D. a call draws a crowd, and Q is what clears it ---');
  clearSave();
  const g = new Game({ seed: 77 });
  g.startShift();
  const s = g.state;
  const { inc } = fireAt(g, 'pizza');

  let peak = 0, peakAt = 0;
  let worstDrag = 1;
  const worstAround = () => {
    let w = 1;
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      for (let k = 0; k <= 30; k++) {
        const d = 30 * (k / 30);
        w = Math.min(w, crowdDragAt(s, inc.x + Math.cos(th) * d, inc.y + Math.sin(th) * d));
      }
    }
    return w;
  };
  for (let t = 0; t < 120000 && s.mode === MODES.PLAYING; t += STEP) {
    g.frame(STEP, null);
    inc.danger = 0;
    const n = crowdAt(s, inc.id);
    if (n > peak) { peak = n; peakAt = s.simTimeMs; worstDrag = worstAround(); }
    if (peak >= 3) break;
  }
  lines.push(`      peak crowd ${peak} at ${f(peakAt / 1000, 0)} s, worst drag on the walk in ${f(worstDrag, 2)}`);

  ge('D1 a working call draws people to it', peak, 2);
  const watchers = s.residents.filter((r) => r.state === 'onlooker');
  ok('D2 who came from their own homes, not out of nowhere',
    watchers.every((r) => !!BUILDING_BY_ID[r.homeId]));
  ok('D3 they stand back from the scene rather than on top of it',
    watchers.every((r) => dist(r.x, r.y, inc.x, inc.y) > 4),
    watchers.map((r) => f(dist(r.x, r.y, inc.x, inc.y), 1)).join());
  ok('D4 and not inside the burning building',
    watchers.every((r) => !pointInRect(r.x, r.y, BUILDING_BY_ID.pizza)));
  ok('D5 mostly on the road, which is where the crew comes from',
    watchers.filter((r) => isOnRoad(r.x, r.y)).length >= Math.ceil(watchers.length / 2),
    `${watchers.filter((r) => isOnRoad(r.x, r.y)).length} of ${watchers.length}`);

  ok('D6 walking through them costs a responder real speed', worstDrag < 0.95, f(worstDrag, 3));
  ge('D7 but never more than CONFIG allows — friction, never a wall', worstDrag, R.crowdDragMin);
  eq('D8 clear air is not slowed at all', crowdDragAt(s, 5, 5), 1);

  /* The siren. `CONFIG.drive.sirenClearRadiusM` has said "traffic and pedestrians yield
     inside this" since the first commit and had no pedestrians to yield. */
  const ap = s.apparatus[0];
  ap.x = inc.x; ap.y = inc.y;
  ap.siren = true;
  const crowdBefore = crowdAt(s, inc.id);
  run(g, 4000, inc);
  const crowdAfter = crowdAt(s, inc.id);
  const scattering = s.residents.filter((r) => r.state === 'scattering').length;
  lines.push(`      siren: ${crowdBefore} watching -> ${crowdAfter} watching, ${scattering} walking away`);
  ok('D9 the siren moves the crowd', crowdAfter < crowdBefore || scattering > 0,
    `${crowdBefore} -> ${crowdAfter}, ${scattering} scattering`);
  ok('D10 and the ones it moved are further away than they were',
    s.residents.filter((r) => r.state === 'scattering')
      .every((r) => dist(r.x, r.y, inc.x, inc.y) > 4));

  ap.siren = false;
  const clearedTo = crowdAt(s, inc.id);
  run(g, 6000, inc);
  le('D11 they do not rebound the moment it goes off', crowdAt(s, inc.id), clearedTo + 1);

  // and when the call closes they stop watching it
  inc.status = 'controlled';
  run(g, 6000);
  eq('D12 a closed call is not worth watching', crowdAt(s, inc.id), 0);
  eq('D13 and nobody is left staring at an incident that is over',
    s.residents.filter((r) => r.state === 'onlooker' &&
      !s.incidents.some((i) => i.id === r.watching && i.status === 'active')).length, 0);
emit('D done');
}

/* ── E. the law: they must not be able to play the game ──────────────────── */

function sectionE() {
lines.push('--- E. residents act on the town; they never act on the game ---');
  clearSave();
  const g = new Game({ seed: 1230 });
  g.startShift();
  const s = g.state;

  const callsBefore = s.incidents.length;
  // a whole quiet shift with nobody responding
  run(g, 120000);
  ok('E1 residents by themselves create no calls',
    s.incidents.every((i) => i.family !== 'resident'), '');
  ok('E2 nobody is driving anything',
    s.apparatus.every((a) => !a.driverId || s.responders.some((r) => r.id === a.driverId)));
  ok('E3 nobody is holding a tool',
    s.tools.every((t) => t.carrier === null || t.carrier === 'rack' ||
      s.responders.some((r) => r.id === t.carrier) ||
      s.apparatus.some((a) => a.id === t.carrier)));
  ok('E4 and none of them has joined the crew',
    s.responders.every((r) => !String(r.id).startsWith('res')));
  eq('E5 the crew is still one person', s.responders.length, 1);
  eq('E6 two minutes of town leaves nothing non-finite', nonFinite(s).length, 0);
  ok('E7 nobody has walked out of the world',
    s.residents.every((r) => r.x >= 0 && r.x <= CONFIG.world.widthM &&
      r.y >= 0 && r.y <= CONFIG.world.heightM));
  ok('E8 nobody is standing inside a wall',
    s.residents.every((r) => r.insideBuildingId !== null || r.state === 'trapped' ||
      !BUILDINGS.some((b) => b.id !== 'station' && pointInRect(r.x, r.y, b))),
    s.residents.filter((r) => !r.insideBuildingId &&
      BUILDINGS.some((b) => pointInRect(r.x, r.y, b))).map((r) => r.id).join());
  ok('E9 and nobody is permanently jammed against one',
    s.residents.filter((r) => r._why === 'stuck').length <= 1);

  const n = s.residents.length;
  run(g, 60000);
  eq('E10 the resident list does not grow', s.residents.length, n);
  emit('running E');

  // a crowd cannot keep a call open
  clearSave();
  const h = new Game({ seed: 1231 });
  h.startShift();
  const s2 = h.state;
  const { inc } = fireAt(h, 'pizza', { seedCells: 1 });
  run(h, 40000, inc);
  const hz = s2.hazards.filter((x) => inc.hazardIds.includes(x.id));
  for (const x of hz) { x.resolved = true; if (x.cells) for (const c of x.cells) { c.burning = false; c.heat = 0; } }
  run(h, 20000);
  ok('E11 a call still closes with a crowd standing on it', inc.status !== 'active', inc.status);

  // determinism: the same seed walks the same people to the same places
  const trace = (seed) => {
    clearSave();
    const q = new Game({ seed });
    q.startShift();
    const t = fireAt(q, 'farmhouse');
    run(q, 30000, t.inc);
    return q.state.residents.map((r) => `${r.id}:${r.state}:${r.x.toFixed(2)}:${r.y.toFixed(2)}`).join('|');
  };
  const a = trace(1232), b = trace(1232);
  eq('E12 the same seed walks the same people to the same places', a, b);
  ok('E13 a different seed does not', trace(1233) !== a);
emit('E done');
}

/* ── G. what the report says about them ──────────────────────────────────── */

function sectionG() {
lines.push('--- G. the report says what happened to the people, not just the buildings ---');
  clearSave();
  const g = new Game({ seed: 1250 });
  g.startShift();
  const s = g.state;
  const target = BUILDINGS.map((b) => b.id)
    .find((id) => s.residents.filter((r) => r.homeId === id).length >= 2 &&
      id !== 'station' && id !== 'clinic');
  const { inc } = fireAt(g, target);
  const doomed = s.residents.find((r) => r.homeId === target);
  doomed.exposureMs = R.collapseMs - 200;
  run(g, 40000, inc);

  s.simTimeMs = CONFIG.shift.durationMs;
  g.endShift();
  const rep = s.report;
  ok('G1 the shift reached a report', !!rep);
  ge('G2 which counts the people who got themselves out', rep.residentsOut, 1);
  ge('G3 and the ones who did not', rep.residentsTrapped, 1);
  ok('G4 and says so in the standfirst, in words',
    /got themselves out|out of a burning building|did not get out/i.test(rep.standfirst),
    rep.standfirst);
  /* A number computed and never rendered is not a feature — the same failure the
     next-shift block was written to fix. */
  const card = reportCard(rep);
  ok('G5 and the card renders it', /Residents/.test(card));
  ok('G6 with both halves of it', new RegExp(`${rep.residentsOut} got themselves out`).test(card),
    card.slice(card.indexOf('Residents'), card.indexOf('Residents') + 160));

  // a shift where nobody had to leave says so, rather than showing a bare zero
  clearSave();
  const q = new Game({ seed: 1251 });
  q.startShift();
  q.state.simTimeMs = CONFIG.shift.durationMs;
  q.endShift();
  eq('G7 a shift with no fire counts nobody out', q.state.report.residentsOut, 0);
  ok('G8 and the card says that in words rather than printing a zero',
    /nobody had to leave a building/.test(reportCard(q.state.report)));
emit('G done');
}

/* ── F. the wire ─────────────────────────────────────────────────────────── */

function sectionF() {
lines.push('--- F. a client can see them too ---');
  clearSave();
  const host = new Game({ seed: 1240 });
  host.startShift();
  const hs = host.state;
  const { inc } = fireAt(host, 'apartments');
  run(host, 40000, inc);

  clearSave();
  const client = new Game({ seed: 999 });
  client.startShift();
  const cs = client.state;

  const snap = encodeSnapshot(hs);
  ok('F1 the snapshot carries the residents', Array.isArray(snap.re) && snap.re.length > 0,
    `${snap.re && snap.re.length}`);
  eq('F2 all of them', snap.re.length, hs.residents.length);
  const wire = JSON.parse(JSON.stringify(snap));
  eq('F3 and it survives a JSON round trip', applySnapshot(cs, wire), true);
  eq('F4 the client has the same number of people', cs.residents.length, hs.residents.length);

  const byId = new Map(cs.residents.map((r) => [r.id, r]));
  const worst = Math.max(...hs.residents.map((r) => {
    const c = byId.get(r.id);
    return c ? dist(r.x, r.y, c.x, c.y) : Infinity;
  }));
  le('F5 within a centimetre of where the host has them', worst, 0.01);
  ok('F6 in the same state as the host has them',
    hs.residents.every((r) => (byId.get(r.id) || {}).state === r.state));
  ok('F7 with the home they belong to',
    hs.residents.every((r) => (byId.get(r.id) || {}).homeId === r.homeId));
  ok('F8 and indoors or out, correctly',
    hs.residents.every((r) => ((byId.get(r.id) || {}).insideBuildingId || null) ===
      (r.insideBuildingId || null)));
  eq('F9 nothing non-finite came off the wire', nonFinite(cs.residents).length, 0);

  /* The wire is not free, and "cheap" is a number.
     The first version of this sent one object per person with the state and the home as
     STRINGS and a facing angle nothing draws: 78 bytes a head, 35% of a snapshot that
     also carries a fully involved building cell by cell. A tuple of indices is 30. */
  const bytes = JSON.stringify(snap).length;
  const without = JSON.stringify({ ...snap, re: [] }).length;
  const each = (bytes - without) / snap.re.length;
  lines.push(`      snapshot ${bytes} B, of which residents are ${bytes - without} B ` +
    `(${f(((bytes - without) / bytes) * 100, 1)}%, ${f(each, 0)} B a head)`);
  le('F10 a whole snapshot still fits in eight kilobytes', bytes, 8192);
  le('F11 and the people in it are a small part of that', (bytes - without) / bytes, 0.25);
  le('F12 no more than forty bytes a head', each, 40);
  ok('F13 which is a tuple of indices, not a bag of names',
    Array.isArray(snap.re[0]) && typeof snap.re[0][3] === 'number');
  ok('F14 and it carries nothing the client does not draw',
    snap.re[0].length === 6, `${snap.re[0].length} fields`);

  /* A client draws; it must never step. The residents on a client move only because a
     snapshot moved them. */
  const posBefore = cs.residents.map((r) => `${r.x.toFixed(3)},${r.y.toFixed(3)}`).join('|');
  cs.net.isClient = true;
  client.frame(1000, null);
  eq('F15 a client does not walk its own residents',
    cs.residents.map((r) => `${r.x.toFixed(3)},${r.y.toFixed(3)}`).join('|'), posBefore);

  // and a version from another build is refused whole
  eq('F16 a snapshot from a different protocol version is refused',
    applySnapshot(cs, { ...wire, v: 999 }), false);
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE(); sectionG(); sectionF();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
