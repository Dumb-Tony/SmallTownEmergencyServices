/* What the town's own people actually do — measured, before anything about them is
 * asserted.
 *
 * Four questions, and none of them has an obvious right answer until it is a number:
 *   1. Does a household get itself out of a burning building, and how often does one of
 *      them not? "Almost always" is the target. "Always" is a system with no stories in
 *      it; "usually not" is a search-and-rescue game the GDD did not ask for.
 *   2. How long does the crew have? If everybody is out before the engine can reach the
 *      far side of town, the mechanic never touches the player.
 *   3. Does a crowd form, does it stand where the work is, and does the siren move it?
 *   4. What does all of this cost a frame, and does it perturb anything that was
 *      measured before it existed?
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { createFire } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { BUILDING_BY_ID, BUILDINGS, dist } from '../src/data/town.js';
import { crowdDragAt, stillInside, alreadyOut } from '../src/sim/residents.js';

const STEP = CONFIG.sim.stepMs;
const lines = [];
const say = (s = '') => { lines.push(s); dump(); };
const f = (n, d = 1) => Number(n).toFixed(d);

let _pre = null;
function dump() {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n==STESTEST-END==';
}

function fireAt(g, buildingId, { withIncident = true } = {}) {
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
  const fire = createFire(buildingId, { seedCells: 3, heat: 1.0, from: 'centre' });
  if (inc) addHazard(s, inc, fire); else s.hazards.push(fire);
  return { inc, fire };
}

/* ── 1 & 2. does a household get out, and how long does the crew have ─────── */

say('== 1. twenty-four households, one fire each ==');
say('seed  building     lived  first out   last out   trapped   crew window');
say('----  -----------  -----  ---------  ---------  --------  ------------');

const TARGETS = ['apartments', 'farmhouse', 'pizza', 'school', 'hardware', 'feedstore'];
let totalPeople = 0, totalTrapped = 0, totalHouseholds = 0;
const lastOutMs = [];

for (let seedN = 0; seedN < 4; seedN++) {
  for (const target of TARGETS) {
    clearSave();
    const g = new Game({ seed: 400 + seedN });
    g.startShift();
    const s = g.state;
    const lived = s.residents.filter((r) => r.homeId === target).length;
    if (!lived) { say(`${400 + seedN}  ${target.padEnd(11)}  0`); continue; }
    totalHouseholds++;
    totalPeople += lived;

    const { inc } = fireAt(g, target);
    let firstOut = null, lastOut = null, trapped = 0;
    for (let t = 0; t < 240000 && s.mode === MODES.PLAYING; t += STEP) {
      g.frame(STEP, null);
      if (inc) inc.danger = 0;                    // somebody is working it
      const out = alreadyOut(s, target);
      if (out >= 1 && firstOut === null) firstOut = s.simTimeMs;
      if (stillInside(s, target) === 0) { lastOut = s.simTimeMs; break; }
    }
    trapped = s.residents.filter((r) => r.homeId === target && r.state === 'trapped').length;
    totalTrapped += trapped;
    if (lastOut != null) lastOutMs.push(lastOut);
    say(`${400 + seedN}  ${target.padEnd(11)}  ${String(lived).padEnd(5)}  ` +
      `${(firstOut == null ? '   never' : f(firstOut / 1000, 1) + ' s').padStart(9)}  ` +
      `${(lastOut == null ? '   never' : f(lastOut / 1000, 1) + ' s').padStart(9)}  ` +
      `${String(trapped).padStart(8)}  ` +
      `${(lastOut == null ? '-' : f(lastOut / 1000, 1) + ' s').padStart(12)}`);
  }
}

// The distribution behind the headline number: how close the ones who DID get out came.
{
  clearSave();
  const g = new Game({ seed: 404 });
  g.startShift();
  const s = g.state;
  const { inc } = fireAt(g, 'apartments');
  const people = s.residents.filter((r) => r.homeId === 'apartments');
  for (let t = 0; t < 90000 && s.mode === MODES.PLAYING; t += STEP) { g.frame(STEP, null); inc.danger = 0; }
  say('');
  say('  one household, in detail (seed 404, Pinecrest):');
  say('    nerve  mobility  exposure/limit  ended as');
  for (const r of people) {
    say(`    ${f(r.nerve, 2).padStart(5)}  ${f(r.mobility, 2).padStart(8)}  ` +
      `${(f(r.exposureMs / 1000, 1) + '/' + f(CONFIG.residents.collapseMs / 1000, 0) + ' s').padStart(14)}  ${r.state}`);
  }
}

const trappedPct = (totalTrapped / Math.max(1, totalPeople)) * 100;
const meanLast = lastOutMs.reduce((a, b) => a + b, 0) / Math.max(1, lastOutMs.length) / 1000;
say('');
say(`${totalHouseholds} households, ${totalPeople} people: ${totalTrapped} did not get out ` +
  `(${f(trappedPct, 1)}%).`);
say(`Mean time until a building is clear: ${f(meanLast, 1)} s. ` +
  `Crossing the town in the engine takes about 25 s.`);
say('');

/* ── 3. the crowd ─────────────────────────────────────────────────────────── */

say('== 3. does a call draw a crowd, does it stand in the way, does the siren move it ==');
clearSave();
{
  const g = new Game({ seed: 77 });
  g.startShift();
  const s = g.state;
  const b = BUILDING_BY_ID.pizza;
  const { inc } = fireAt(g, 'pizza');

  /* The crowd stands on a ring, so measuring at the door measures nothing — the player
   * does not teleport to the door, they WALK IN from wherever they parked. Sample the
   * worst drag along that walk: 30 m out, straight in. That is the number the mechanic
   * is actually made of. */
  const worstOnApproach = () => {
    let worst = 1;
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      for (let k = 0; k <= 30; k++) {
        const d = 30 * (k / 30);
        worst = Math.min(worst, crowdDragAt(s, inc.x + Math.cos(th) * d, inc.y + Math.sin(th) * d));
      }
    }
    return worst;
  };

  const sample = [];
  let n = 0;
  let peak = { onlookers: 0, ms: 0 };
  for (let t = 0; t < 180000 && s.mode === MODES.PLAYING; t += STEP) {
    g.frame(STEP, null);
    inc.danger = 0;
    const now = s.residents.filter((r) => r.state === 'onlooker').length;
    if (now > peak.onlookers) peak = { onlookers: now, ms: s.simTimeMs };
    if (n++ % 1200 === 0) {
      const nearest = Math.min(...s.residents
        .filter((r) => r.state === 'onlooker')
        .map((r) => dist(r.x, r.y, inc.x, inc.y)), Infinity);
      sample.push({ t: Math.round(t / 1000), onlookers: now, drag: worstOnApproach(), nearest });
    }
  }
  say('  t(s)  onlookers  worst drag on the walk in  nearest onlooker');
  for (const r of sample) {
    say(`  ${String(r.t).padStart(4)}  ${String(r.onlookers).padStart(9)}  ` +
      `${f(r.drag, 2).padStart(25)}  ${(Number.isFinite(r.nearest) ? f(r.nearest, 1) + ' m' : '-').padStart(16)}`);
  }
  say(`  peak crowd: ${peak.onlookers} at ${f(peak.ms / 1000, 0)} s`);

  // The siren, tested while there IS a crowd to move.
  say('');
  clearSave();
  const g2 = new Game({ seed: 77 });
  g2.startShift();
  const s2 = g2.state;
  const { inc: inc2 } = fireAt(g2, 'pizza');
  let best = { n: 0 };
  for (let t = 0; t < 120000 && s2.mode === MODES.PLAYING; t += STEP) {
    g2.frame(STEP, null);
    inc2.danger = 0;
    const now = s2.residents.filter((r) => r.state === 'onlooker').length;
    if (now >= 3) { best = { n: now }; break; }
  }
  const ap = s2.apparatus[0];
  ap.x = inc2.x; ap.y = inc2.y; ap.siren = true;
  for (let t = 0; t < 4000; t += STEP) { g2.frame(STEP, null); inc2.danger = 0; }
  const after = s2.residents.filter((r) => r.state === 'onlooker').length;
  const spread = s2.residents.filter((r) => r.state === 'onlooker' || r.state === 'scattering')
    .map((r) => dist(r.x, r.y, inc2.x, inc2.y));
  const hist = (list) => {
    const h = {};
    for (const r of list) h[r.state] = (h[r.state] || 0) + 1;
    return Object.entries(h).map(([k, v]) => `${k} ${v}`).join(', ');
  };
  say(`  siren on at the scene (siren=${ap.siren}, incident=${inc2.status}): ` +
    `${best.n} onlookers -> ${after} after 4 s ` +
    `(nearest anybody ${f(Math.min(...spread, Infinity), 1)} m)`);
  say(`  states now: ${hist(s2.residents)}`);
  ap.siren = false;
  for (let t = 0; t < 8000; t += STEP) { g2.frame(STEP, null); inc2.danger = 0; }
  say(`  siren off, 8 s later: ${s2.residents.filter((r) => r.state === 'onlooker').length} onlookers, ` +
    `${s2.residents.filter((r) => r.state === 'scattering').length} still walking away ` +
    `(scatterMs is ${CONFIG.residents.scatterMs} ms — anybody back is a NEW arrival, not a rebound)`);
}
say('');

/* ── 4. cost, and whether they perturbed anything ─────────────────────────── */

say('== 4. what they cost ==');
clearSave();
{
  const g = new Game({ seed: 909 });
  g.startShift();
  const s = g.state;
  say(`  ${s.residents.length} residents across ${BUILDINGS.length} buildings`);

  const t0 = performance.now();
  for (let t = 0; t < 60000; t += STEP) g.frame(STEP, null);
  const t1 = performance.now();
  const steps = 60000 / STEP;
  say(`  a whole minute of town: ${f(t1 - t0, 1)} ms for ${steps} steps ` +
    `= ${f((t1 - t0) / steps, 4)} ms a step`);

  // and the resident stream really is separate from the shift stream
  clearSave();
  const a = new Game({ seed: 55 }); a.startShift();
  for (let t = 0; t < 20000; t += STEP) a.frame(STEP, null);
  say(`  after 20 s: shift stream drew ${a.rng.draws}, resident stream drew ${a.people.draws} ` +
    '(separate streams, so residents cannot move a dispatch roll)');

  let nan = 0;
  const walk = (o, d = 0) => {
    if (d > 6 || !o || typeof o !== 'object') return;
    for (const v of Object.values(o)) {
      if (typeof v === 'number' && !Number.isFinite(v)) nan++;
      else if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(s.residents);
  say(`  non-finite numbers among the residents after a minute: ${nan}`);

  const states = {};
  for (const r of s.residents) states[r.state] = (states[r.state] || 0) + 1;
  say(`  states: ${Object.entries(states).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const stuck = s.residents.filter((r) => r._why === 'stuck').length;
  say(`  stuck against a wall this step: ${stuck}`);
}

say('');
say('== done ==');
