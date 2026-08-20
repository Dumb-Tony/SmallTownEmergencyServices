/* The town you come back to — GDD Phase 4's exit gate, over more than one shift.
 *
 * "Players refer to locations by name and care about a previous mistake." Every part of
 * the carry-over was unit-asserted long ago — damage persists, a gutted shop is boarded,
 * a struck hydrant stays out — but nobody had watched them COMPOUND. Run five shifts
 * back to back (tools\_campaigndiag.js) and three things were wrong:
 *
 *   - confidence hit zero on shift three and stayed there for good, for a crew that
 *     turned up to everything, so nothing they did afterwards could show;
 *   - the shift report named the same building as destroyed five headlines running,
 *     because it read the town's ACCUMULATED damage table rather than today's losses;
 *   - a saturated town ran out of places to have an emergency and the fifth shift
 *     produced no calls at all — which scored BETTER than working, because a shift with
 *     nothing in it cannot be failed.
 */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave, loadTown, defaultTown, advanceShift } from '../src/core/persistence.js';
import { buildShiftReport } from '../src/ui/shiftReport.js';
import { CrewBot } from './_crewbot.js';
import { BUILDINGS } from '../src/data/town.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const lt = (n, a, b) => ok(n, a < b, `got ${a}, want < ${b}`);

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

/* ── A. today's news ─────────────────────────────────────────────────────── */
function sectionA() {
lines.push('--- A. the headline is about THIS shift ---');
  clearSave();
  const g = new Game({ seed: 4100 });
  g.startShift();
  const s = g.state;

  // a town that already carries a ruin from an earlier shift
  const old = BUILDINGS.find((b) => b.kind === 'shop');
  s.town.buildings[old.id] = { damage: 0.95, boardedShifts: 2, timesBurned: 1 };

  const quiet = buildShiftReport(s);
  ok('A1 an old ruin is not reported as fresh news',
    !quiet.headline.includes(old.name), quiet.headline);
  lines.push(`      with a ruin carried over: "${quiet.headline}"`);

  // something lost today
  const today = BUILDINGS.find((b) => b.kind === 'barn');
  s.outcome.structuresLostNames.push(today.name);
  const fresh = buildShiftReport(s);
  ok('A2 what burned down today is', fresh.headline.includes(today.name), fresh.headline);
  lines.push(`      after losing one today:  "${fresh.headline}"`);

  s.outcome.structuresLostNames.push('Rowan Elementary');
  const two = buildShiftReport(s);
  ok('A3 and two losses are counted, not listed', /2 buildings lost/.test(two.headline), two.headline);
}

/* ── B. a town that can come back ────────────────────────────────────────── */
function sectionB() {
lines.push('--- B. confidence has a way up as well as down ---');
  const T = CONFIG.town;
  const floor = advanceShift({ ...defaultTown(), confidence: 0 }, 'x');
  gt('B1 a night after a disaster is not still a disaster', floor.confidence, 0);
  lt('B2 but it is nowhere near neutral either', floor.confidence, T.startConfidence * 0.5);

  const good = advanceShift({ ...defaultTown(), confidence: 0.95 }, 'x');
  lt('B3 a town that adores you cools off too', good.confidence, 0.95);
  gt('B4 without forgetting it', good.confidence, T.startConfidence);

  const neutral = advanceShift({ ...defaultTown(), confidence: T.startConfidence }, 'x');
  ok('B5 neutral stays neutral', Math.abs(neutral.confidence - T.startConfidence) < 1e-9);

  /* The economy underneath it, stated as SHIFTS rather than unit prices.
   *
   * A single save is allowed to be worth a little more than a single loss costs — you
   * cannot possibly attend everything, and a town that punished you per call for the
   * six you could never reach is the death spiral this section exists to prevent. What
   * has to hold is the shape of a shift: a bad one costs, a good one pays. */
  const shift = (controlled, lost) => controlled * T.confidenceControlled + lost * T.confidenceLost;
  lt('B6 a shift where one call in seven is closed costs the town', shift(1, 6), 0);
  gt('B7 a shift where five of seven are closed earns it back', shift(5, 2), 0);
  lt('B8 and turning up to nothing at all is the worst of it', shift(0, 7), shift(1, 6));
}

/* ── C. the dispatcher always has something to say ───────────────────────── */
function sectionC() {
lines.push('--- C. a saturated town still generates calls ---');
  clearSave();
  const g = new Game({ seed: 4200 });
  const town = loadTown();
  // board up over half the town, as five neglected shifts really do
  for (const b of BUILDINGS.filter((x) => x.kind !== 'station').slice(0, 7)) {
    town.buildings[b.id] = { damage: 0.9, boardedShifts: 3, timesBurned: 2 };
  }
  g.town = town;
  g.state.town = town;
  g.startShift();
  g.state.town = town;

  let calls = 0;
  const off = g.bus.on('CALL_RECEIVED', () => { calls++; });
  g.clock.skipMs(CONFIG.shift.durationMs - 80000, (ms) => g.step(ms, null));
  off();
  gt('C1 seven boarded buildings do not silence the dispatcher', calls, 0);
  lines.push(`      ${calls} calls with 7 of ${BUILDINGS.length} buildings boarded up`);
  ok('C2 and every one of them landed somewhere real',
    g.state.incidents.every((i) => Number.isFinite(i.x) && Number.isFinite(i.y)));
}

/* ── D. three shifts, worked and ignored ─────────────────────────────────── */
function playShift(seed, idle) {
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  const bot = idle ? null : new CrewBot(g);
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    if (bot) bot.think();
    g.frame(STEP, bot ? bot.input : null);
    if (s.mode !== 'playing') break;
  }
  return s;
}

function campaign(idle) {
  clearSave();
  const headlines = [];
  let calls = 0;
  for (let i = 1; i <= 3; i++) {
    const s = playShift(2000 + i, idle);
    headlines.push(s.report ? s.report.headline : '(none)');
    calls += s.incidents.length;
  }
  const t = loadTown();
  const boarded = Object.values(t.buildings || {}).filter((r) => r.boardedShifts > 0).length;
  const damage = Object.values(t.buildings || {}).reduce((n, r) => n + r.damage, 0);
  return { town: t, boarded, damage, headlines, calls };
}

function sectionD() {
lines.push('--- D. three shifts in the same town ---');
  const worked = campaign(false);
  emit(null);
  const ignored = campaign(true);

  lines.push(`      worked:  confidence ${(worked.town.confidence * 100).toFixed(0)}% · ` +
    `${worked.boarded} boarded · ${worked.damage.toFixed(2)} damage · ${worked.calls} calls`);
  lines.push(`      ignored: confidence ${(ignored.town.confidence * 100).toFixed(0)}% · ` +
    `${ignored.boarded} boarded · ${ignored.damage.toFixed(2)} damage · ${ignored.calls} calls`);
  for (const h of worked.headlines) lines.push(`      "${h}"`);

  eq('D1 the shift number carries', worked.town.shiftNumber, 4);
  eq('D2 and so does the history', worked.town.history.length, 3);

  /* The gate. Three shifts of work must leave a better town than three of neglect, and
     "better" has to be visible in more than one number — a single measure can be gamed
     by an accident of pacing. */
  gt('D3 the town thinks more of a crew that turns up', worked.town.confidence, ignored.town.confidence);
  lt('D4 fewer buildings end up boarded up', worked.boarded, ignored.boarded);
  lt('D5 and there is less of the town in pieces', worked.damage, ignored.damage);

  ok('D6 no shift was silent, in either town', worked.calls >= 3 && ignored.calls >= 3,
    `${worked.calls} vs ${ignored.calls}`);
  ok('D7 the headlines are not the same story three times',
    new Set(worked.headlines).size > 1, worked.headlines.join(' | '));

  /* And the shape that matters: a bad run has to be survivable. */
  gt('D8 even a neglected town is not written off for good', ignored.town.confidence, 0);
  lt('D9 while still being plainly worse off', ignored.town.confidence, CONFIG.town.startConfidence);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); emit(null);
  sectionB(); emit(null);
  sectionC(); emit(null);
  sectionD(); emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
