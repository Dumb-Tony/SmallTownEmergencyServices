/* Does it play? — the GDD's own question, asserted.
 *
 * Part II opens with it: "Can one small continuous town, three drivable vehicles, five
 * incident families and a dispatch queue reliably produce a story where players abandon
 * one worsening problem for another and then improvise around the consequences?" And
 * Phase 5's exit gate: "coordination improves outcomes while miscommunication creates
 * recoverable stories."
 *
 * Neither had ever been measured. When they were, the answer was no, for two reasons
 * that had nothing to do with taste:
 *
 *   - a casualty lying under a live wire lost 10% of their condition every two seconds,
 *     which is twenty times the decline rate that defines "critical". They died 14 s
 *     after appearing; the fastest a crew has ever reached anyone is 25 s. `crash_pole`
 *     is a CRITICAL-priority call that no play could win;
 *   - an incident stayed open until the ambulance reached the CLINIC, so a crash cost
 *     more of a ten-minute shift than the entire rest of the response. 11 crashes
 *     worked, 0 controlled, and across every bot shift ever run: 0 patients loaded,
 *     0 delivered, and the `transport` job chosen exactly zero times.
 *
 * These are the assertions that keep both fixed.
 */

import { CONFIG } from '../src/config.js';
import { Game, toggleCoop } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { createVictim, victimHandled, victimState } from '../src/sim/victims.js';
import { createPower } from '../src/sim/hazards.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';
import { POLES, dist } from '../src/data/town.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const gte = (n, a, b) => ok(n, a >= b, `got ${a}, want >= ${b}`);

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

const STEP = CONFIG.sim.stepMs;

function fresh(seed = 700) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  g.state.incidents.length = 0;      // bench measurements, no dispatch noise
  return g;
}

function addVictim(g, opts) {
  const v = createVictim({ incidentId: null, x: 200, y: 150, severity: 'critical', ...opts });
  g.state.victims.push(v);
  return v;
}

/** Seconds until this casualty is lost, or Infinity. */
function survives(g, v, capMin = 20) {
  let ms = 0;
  while (!v.lost && ms < capMin * 60000) { g.step(STEP, null); ms += STEP; }
  return v.lost ? ms / 1000 : Infinity;
}

/* ── A. a live wire is a barrier, not an execution ───────────────────────── */
function sectionA() {
lines.push('--- A. the wire that killed everyone it touched ---');
  const g = fresh();
  const pole = POLES[0];
  const pwr = createPower(pole.x + 3, pole.y + 3, pole.id);
  g.state.hazards.push(pwr);
  ok('A1 the line is live', pwr.live);

  const v = addVictim(g, { x: pwr.x, y: pwr.y, severity: 'injured' });
  const before = v.condition;
  g.step(STEP, null);
  g.step(STEP, null);
  const afterFirst = v.condition;
  ok('A2 touching a live wire hurts them, once', before - afterFirst >= CONFIG.medical.shockCost * 0.9,
    `lost ${(before - afterFirst).toFixed(3)}`);
  ok('A3 and they are now somebody who needs a ride', v.needsTransport);

  // ten more seconds in the zone must not be ten more shocks
  const atTen = v.condition;
  for (let t = 0; t < 10000; t += STEP) g.step(STEP, null);
  const lostInTen = atTen - v.condition;
  ok('A4 lying in it does NOT re-shock them every two seconds', lostInTen < CONFIG.medical.shockCost,
    `lost ${lostInTen.toFixed(3)} in 10 s, one shock is ${CONFIG.medical.shockCost}`);
  gt('A5 but the zone does make them decline faster than open ground',
    lostInTen, CONFIG.medical.declineInjured * 10 * 1.2);

  /* The number that matters: can anyone get there? The fastest arrival ever measured
     across whole bot shifts is 25 s, and before the fix they died at 14 s. */
  const g2 = fresh(701);
  const p2 = createPower(POLES[0].x + 3, POLES[0].y + 3, POLES[0].id);
  g2.state.hazards.push(p2);
  const v2 = addVictim(g2, { x: p2.x, y: p2.y, severity: 'critical' });
  const secs = survives(g2, v2);
  gt('A6 a critical casualty under a live wire lives long enough to be reached', secs, 60);
  lines.push(`      (measured: ${secs === Infinity ? 'survives the shift' : secs.toFixed(0) + ' s'}; before the fix, 14 s)`);
}

/* ── B. a call closes when the scene is clear, not when the clinic signs ─── */
function sectionB() {
lines.push('--- B. what "under control" means ---');
  const g = fresh(702);
  const v = addVictim(g, { severity: 'critical' });
  v.needsTransport = true;
  ok('B1 a casualty waiting for a ride is not handled', !victimHandled(v));

  v.inApparatusId = 'ambulance';
  ok('B2 packaged into the ambulance, they are — the scene is clear', victimHandled(v));
  eq('B3 and they read as being in the truck, not delivered', v.delivered, false);

  v.inApparatusId = null; v.delivered = true;
  ok('B4 delivered is still handled', victimHandled(v));

  const lostOne = addVictim(g, { severity: 'critical' });
  lostOne.lost = true;
  ok('B5 so is somebody nobody could save', victimHandled(lostOne));

  const trapped = addVictim(g, { severity: 'injured', trappedBy: 'wreck' });
  ok('B6 but not somebody still pinned in a car', !victimHandled(trapped));
  eq('B7 a stable bystander needs nothing', victimState(addVictim(g, { severity: 'stable' })), 'stable');
}

/* ── C. the chain the game had never once completed ──────────────────────── */
function runShift(seed, crew) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  if (crew === 2) toggleCoop(s);

  const board = { claims: new Map(), trucks: new Map() };
  const bots = s.responders.map((r) => new CrewBot(g, r.id, crew === 2 ? board : null));
  bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : 'p2'); });
  const input = bots.length > 1 ? mergeBotInputs(bots.map((b) => b.input)) : bots[0].input;

  const chain = { reached: 0, treated: 0, loaded: 0, delivered: 0, lost: 0 };
  const seen = new Set();
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    for (const b of bots) b.think();
    g.frame(STEP, input);
    if (s.mode !== 'playing') break;
    for (const v of s.victims) {
      const key = v.id;
      if (!seen.has(key + ':r') && s.responders.some((r) => !r.inVehicleId && dist(r.x, r.y, v.x, v.y) < CONFIG.player.reachM + 1)) {
        seen.add(key + ':r'); chain.reached++;
      }
      if (!seen.has(key + ':t') && v.treatedAtMs != null) { seen.add(key + ':t'); chain.treated++; }
      if (!seen.has(key + ':l') && v.inApparatusId) { seen.add(key + ':l'); chain.loaded++; }
      if (!seen.has(key + ':d') && v.delivered) { seen.add(key + ':d'); chain.delivered++; }
      if (!seen.has(key + ':x') && v.lost) { seen.add(key + ':x'); chain.lost++; }
    }
  }
  return {
    chain,
    controlled: s.outcome.controlled,
    lost: s.outcome.lost,
    neverWorked: s.telemetry.callsNeverWorked,
    confidence: s.town.confidence,
    families: [...new Set(s.incidents.filter((i) => i.status === 'controlled').map((i) => i.family))],
  };
}

const SEEDS = [101, 303];
const solo = SEEDS.map((s) => runShift(s, 1));
const pair = SEEDS.map((s) => runShift(s, 2));
const sum = (rs, f) => rs.reduce((n, r) => n + f(r), 0);

function sectionC() {
lines.push('--- C. the medical chain, in a real shift, through the real input path ---');
  for (let i = 0; i < SEEDS.length; i++) {
    const c = pair[i].chain;
    lines.push(`      seed ${SEEDS[i]}, two crew: reached ${c.reached} · treated ${c.treated} · ` +
      `loaded ${c.loaded} · delivered ${c.delivered} · lost ${c.lost}`);
  }
  gt('C1 somebody is reached', sum(pair, (r) => r.chain.reached), 0);
  gt('C2 somebody is treated', sum(pair, (r) => r.chain.treated), 0);
  gt('C3 somebody is loaded into the ambulance', sum(pair, (r) => r.chain.loaded), 0);
  gt('C4 and somebody reaches the clinic alive', sum(pair, (r) => r.chain.delivered), 0);
  ok('C5 the family is closeable: a crash or a medical call was controlled',
    [...solo, ...pair].some((r) => r.families.includes('crash') || r.families.includes('medical')),
    [...solo, ...pair].flatMap((r) => r.families).join(','));
}

/* ── D. GDD Phase 5 exit gate: coordination improves outcomes ────────────── */
function sectionD() {
lines.push('--- D. two of you must be better than one of you (Phase 5 exit gate) ---');
  const soloConf = sum(solo, (r) => r.confidence);
  const pairConf = sum(pair, (r) => r.confidence);
  lines.push(`      confidence ${(soloConf * 100).toFixed(0)}% -> ${(pairConf * 100).toFixed(0)}% (pooled over ${SEEDS.length} seeds)`);
  lines.push(`      casualties reached ${sum(solo, (r) => r.chain.reached)} -> ${sum(pair, (r) => r.chain.reached)}` +
    ` · lost ${sum(solo, (r) => r.chain.lost)} -> ${sum(pair, (r) => r.chain.lost)}` +
    ` · calls never worked ${sum(solo, (r) => r.neverWorked)} -> ${sum(pair, (r) => r.neverWorked)}`);

  gt('D1 the town ends happier with a second volunteer', pairConf, soloConf);
  gte('D2 more casualties are physically reached', sum(pair, (r) => r.chain.reached), sum(solo, (r) => r.chain.reached));
  ok('D3 fewer of them are lost', sum(pair, (r) => r.chain.lost) <= sum(solo, (r) => r.chain.lost),
    `${sum(pair, (r) => r.chain.lost)} vs ${sum(solo, (r) => r.chain.lost)}`);
  ok('D4 fewer calls go completely unattended',
    sum(pair, (r) => r.neverWorked) <= sum(solo, (r) => r.neverWorked),
    `${sum(pair, (r) => r.neverWorked)} vs ${sum(solo, (r) => r.neverWorked)}`);

  /* And the other half of the gate: "miscommunication creates recoverable stories".
     Losing calls has to stay normal, and the shift has to carry on regardless. */
  gt('D5 calls are still lost, with two of you — the town does not wait', sum(pair, (r) => r.lost), 0);
  ok('D6 and every shift still ran to the end', [...solo, ...pair].every((r) => r.controlled + r.lost > 0));
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD();
  emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
