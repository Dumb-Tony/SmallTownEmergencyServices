/* The coach — GDD Phase 0's exit gate, which is the one gate that was never built for.
 *
 * "Driving across town is understandable without instructions after one attempt", and
 * implementation rule 3: never pause an incident clock for a tutorial. So the thing
 * under test is a PURE FUNCTION from world state to at most one line, and the assertions
 * are about what it says, when it shuts up, and what it must never do.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES } from '../src/game.js';
import { clearSave, defaultTown, migrate } from '../src/core/persistence.js';
import { nextHint, learnFromEvent, learnFromDistance, LESSONS } from '../src/ui/coach.js';
import { createIncident } from '../src/sim/incidentSim.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { Rng } from '../src/core/rng.js';
import { CrewBot } from './_crewbot.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

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
function fresh(seed = 500) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  g.state.dispatch.nextCallAtMs = Number.MAX_SAFE_INTEGER;
  g.state.incidents.length = 0;
  return g;
}

/* ── A. it says the next physical thing ──────────────────────────────────── */
function sectionA() {
lines.push('--- A. what it says, and when ---');
  const g = fresh();
  const s = g.state;
  const learned = {};

  const quiet = nextHint(s, { learned });
  ok('A1 before any call, it says what the shift is', !!quiet && quiet.id === 'wait', quiet && quiet.text);

  const inc = createIncident(s, TEMPLATE_BY_ID.kitchen_fire, new Rng(3));
  const h1 = nextHint(s, { learned });
  eq('A2 a call arrives and it names the truck to take', h1.id, 'ride');
  ok('A3 by name, with the place', /Engine 1/.test(h1.text) && h1.text.includes(inc.place), h1.text);
  lines.push(`      "${h1.text}"`);

  // in the cab
  const eng = s.apparatus.find((a) => a.id === 'engine');
  s.player.inVehicleId = eng.id; eng.driverId = s.player.id;
  const h2 = nextHint(s, { learned });
  eq('A4 in the cab, it says where to go', h2.id, 'drive');
  ok('A5 and how to make it move', /W/.test(h2.text), h2.text);

  // arrived, still in the cab
  eng.x = inc.x; eng.y = inc.y;
  s.player.x = inc.x; s.player.y = inc.y;
  const h3 = nextHint(s, { learned });
  eq('A6 parked at the call, it says to get out', h3.id, 'arrive');

  // out of the cab, empty handed, standing at a fire
  s.player.inVehicleId = null; eng.driverId = null;
  const h4 = nextHint(s, { learned: { ride: true, drive: true, arrive: true } });
  eq('A7 empty handed at a fire, it names the kit', h4.id, 'equip');
  ok('A8 and says WHY that one', /burning/.test(h4.text), h4.text);
  lines.push(`      "${h4.text}"`);

  // holding it
  const hose = s.tools.find((t) => t.defId === 'hose');
  hose.carrier = s.player.id; s.player.toolId = hose.id;
  const h5 = nextHint(s, { learned: { ride: true, drive: true, arrive: true, equip: true } });
  eq('A9 holding the line, it says to use it', h5.id, 'use');
  ok('A10 and that it takes a moment', /hold/i.test(h5.text), h5.text);
}

/* ── B. it stops ─────────────────────────────────────────────────────────── */
function sectionB() {
lines.push('--- B. it retires itself ---');
  const g = fresh(501);
  const s = g.state;
  createIncident(s, TEMPLATE_BY_ID.kitchen_fire, new Rng(3));

  const all = {};
  for (const l of LESSONS) all[l] = true;
  eq('B1 a player who has done all five is never spoken to again', nextHint(s, { learned: all }), null);

  const learned = {};
  ok('B2 getting into a truck retires the first lesson', learnFromEvent(learned, 'ENTERED_APPARATUS'));
  eq('B3 and it is remembered', learned.ride, true);
  ok('B4 the same event a second time teaches nothing new', !learnFromEvent(learned, 'ENTERED_APPARATUS'));
  ok('B5 an unrelated event teaches nothing', !learnFromEvent(learned, 'HOSE_TAUT'));
  ok('B6 taking kit retires equip', learnFromEvent(learned, 'TOOL_TAKEN') && learned.equip === true);
  ok('B7 putting water on something retires use', learnFromEvent(learned, 'HYDRANT_CHARGED') && learned.use === true);

  ok('B8 driving is learned by driving, not by an event',
    !learnFromDistance(learned, CONFIG.coach.driveLearnedM - 1));
  ok('B9 half a block does it', learnFromDistance(learned, CONFIG.coach.driveLearnedM + 1));
  eq('B10 and it too is remembered', learned.drive, true);

  // paused / title / report: the coach has nothing to say
  s.mode = MODES.PAUSED;
  eq('B11 a paused town gets no hints', nextHint(s, { learned: {} }), null);
  s.mode = MODES.PLAYING;
}

/* ── C. it survives being saved, and cannot be corrupted into silence ────── */
function sectionC() {
lines.push('--- C. the flags live in the town, like everything else that persists ---');
  const town = defaultTown();
  ok('C1 a new town has learned nothing', Object.keys(town.learned).length === 0);

  town.learned.ride = true;
  town.learned.drive = true;
  const back = migrate(JSON.parse(JSON.stringify(town)));
  eq('C2 what was learned survives a save and load', back.learned.ride, true);
  eq('C3 and so does the rest of it', back.learned.drive, true);

  const junk = migrate({ ...town, learned: { ride: true, everything: true, drive: 'yes' } });
  eq('C4 a junk save cannot silence the coach with invented lessons', junk.learned.everything, undefined);
  eq('C5 nor with a truthy non-true', junk.learned.drive, undefined);
  eq('C6 the real one still counts', junk.learned.ride, true);

  const old = migrate({ ...town, learned: undefined });
  ok('C7 a save from before the coach existed loads clean', old.learned && Object.keys(old.learned).length === 0);
}

/* ── D. it never touches the simulation ──────────────────────────────────── */
function sectionD() {
lines.push('--- D. guidance is not gameplay ---');
  const g = fresh(502);
  const s = g.state;
  createIncident(s, TEMPLATE_BY_ID.two_car, new Rng(7));
  g.clock.skipMs(4000, (ms) => g.step(ms, null));

  const before = JSON.stringify({
    t: s.simTimeMs, p: [s.player.x, s.player.y],
    inc: s.incidents.map((i) => [i.status, i.danger]),
    v: s.victims.map((v) => v.condition),
  });
  for (let i = 0; i < 50; i++) nextHint(s, { learned: {} });
  const after = JSON.stringify({
    t: s.simTimeMs, p: [s.player.x, s.player.y],
    inc: s.incidents.map((i) => [i.status, i.danger]),
    v: s.victims.map((v) => v.condition),
  });
  eq('D1 fifty hints change nothing about the town', after, before);
  eq('D2 and consume no simulation time', s.simTimeMs, g.clock.simTimeMs);

  /* The whole point of rule 3: the clock keeps running while the coach is talking. */
  const dangerBefore = s.incidents[0].danger;
  g.clock.skipMs(8000, (ms) => g.step(ms, null));
  nextHint(s, { learned: {} });
  ok('D3 the call deteriorates while the player is being coached',
    s.incidents[0].danger > dangerBefore);
}

/* ── E. a first-time player, coached, through the real input path ────────── */
function sectionE() {
lines.push('--- E. a whole first shift with the coach running ---');
  clearSave();
  const g = new Game({ seed: 303 });
  g.startShift();
  const s = g.state;
  const bot = new CrewBot(g);
  const learned = {};
  g.bus.onAny((e) => learnFromEvent(learned, e.type));

  const seen = new Set();
  let hintFrames = 0;
  for (let t = 0; t < CONFIG.shift.durationMs; t += STEP) {
    bot.think();
    g.frame(STEP, bot.input);
    if (s.mode !== 'playing') break;
    learnFromDistance(learned, s.telemetry.distanceDrivenM);
    const h = nextHint(s, { learned });
    if (h) { seen.add(h.id); hintFrames++; }
  }

  lines.push(`      lessons taught: ${[...seen].join(', ') || 'none'} · ` +
    `learned by the end: ${Object.keys(learned).join(', ') || 'none'}`);
  ok('E1 the coach spoke at the start of the shift', seen.size > 0);
  ok('E2 a player who plays learns most of the verbs',
    Object.keys(learned).length >= 3, Object.keys(learned).join(','));
  ok('E3 and the coach goes quiet long before the shift ends',
    hintFrames < (CONFIG.shift.durationMs / STEP) * 0.5,
    `${hintFrames} frames of ${Math.round(CONFIG.shift.durationMs / STEP)}`);
  ok('E4 the shift still ran to the end', s.mode !== 'playing' || s.simTimeMs >= CONFIG.shift.durationMs - 2000);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); emit(null);
  sectionB(); emit(null);
  sectionC(); emit(null);
  sectionD(); emit(null);
  sectionE(); emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
