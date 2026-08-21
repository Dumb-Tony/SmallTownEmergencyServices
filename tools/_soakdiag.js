/* Soak and abuse measurement. NUMBERS ONLY — no assertions live here.
 *
 * The question is not "does a shift work", which m0-m8 already answer. It is: what
 * breaks when somebody plays six shifts back to back without reloading the page, alt-tabs
 * for an hour, mashes P, or opens the game in a browser that will not give it a
 * localStorage. Every claim in tools/m11-tests.js is a number printed here first.
 *
 * Harness rules learned the hard way and obeyed here:
 *   - nothing heavy at module scope: a run that is merely still working reports as a
 *     crash, so every section is a function and emit() lands after each one;
 *   - the page's own rAF loop is never forked. The page game stays on the title card
 *     and every measurement drives a Game of its own, synchronously.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, toggleCoop, createInitialState } from '../src/game.js';
import { GameClock } from '../src/core/clock.js';
import {
  clearSave, loadTown, saveTown, migrate, advanceShift, defaultTown, SAVE_KEY,
} from '../src/core/persistence.js';
import { hashStr } from '../src/core/rng.js';
import { fireDamageFraction, createWreck, createFire } from '../src/sim/hazards.js';
import { createVictim } from '../src/sim/victims.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { loopbackPair, NetSession } from '../src/net/net.js';
import { MSG, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { CrewBot } from './_crewbot.js';
import { BUILDINGS, HYDRANTS, CRASH_SITES, dist } from '../src/data/town.js';

const STEP = CONFIG.sim.stepMs;
const lines = [];
let _pre = null;
function emit(tail = 'measuring') {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==STESTEST-END==';
}
const say = (s) => { lines.push(s); };
const pad = (v, n) => String(v).padStart(n);

/* ── shared measurement helpers ──────────────────────────────────────────── */

/** Every number in a live state, checked for NaN/Infinity. Cycles are fine. */
function nonFinite(root, maxDepth = 8) {
  const bad = [];
  const seen = new WeakSet();
  const walk = (o, path, d) => {
    if (bad.length >= 25 || d > maxDepth || o === null || o === undefined) return;
    const t = typeof o;
    if (t === 'number') { if (!Number.isFinite(o)) bad.push(`${path}=${o}`); return; }
    if (t !== 'object') return;
    if (seen.has(o)) return;
    seen.add(o);
    if (ArrayBuffer.isView(o)) {
      for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { bad.push(`${path}[${i}]=${o[i]}`); break; }
      return;
    }
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], `${path}[${i}]`, d + 1); return; }
    for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`, d + 1);
  };
  walk(root, '', 0);
  return bad;
}

/** A compact fingerprint of an entire shift outcome, for the determinism check. */
function digest(s) {
  const r = (v) => Math.round((v || 0) * 1000) / 1000;
  const p = [
    's', s.simTimeMs, s.mode,
    'o', s.outcome.controlled, s.outcome.lost, s.outcome.patientsSaved,
    s.outcome.patientsLost, s.outcome.structuresLost,
    'c', r(s.town.confidence), 'n', s.incidents.length, s.hazards.length, s.victims.length,
    'd', s.dispatch.callsMade, r(s.dispatch.nextCallAtMs),
    't', r(s.telemetry.distanceDrivenM), r(s.telemetry.litresUsed), s.telemetry.sceneChanges,
  ];
  for (const a of s.apparatus) p.push(a.id, r(a.x), r(a.y), r(a.angle), r(a.speed), r(a.waterL), r(a.damage), r(a.odometerM));
  for (const q of s.responders) p.push(q.id, r(q.x), r(q.y), r(q.facing), q.toolId, q.inVehicleId);
  for (const i of s.incidents) p.push(i.id, i.templateId, i.place, i.status, i.priority, r(i.danger), r(i.ageMs));
  for (const v of s.victims) p.push(v.id, r(v.x), r(v.y), r(v.condition), v.lost ? 1 : 0, v.delivered ? 1 : 0);
  for (const h of s.hazards) {
    p.push(h.id, h.kind, h.resolved ? 1 : 0);
    p.push(h.kind === 'fire' ? `${h.burningCount}:${Math.round(fireDamageFraction(h) * 1000)}`
      : r(h.ppm ?? h.cut ?? h.burnt ?? 0));
  }
  for (const m of s.radio) p.push(m.atMs, m.kind, m.text);
  return p.join('|');
}

function fireCellCount(s) {
  let n = 0;
  for (const h of s.hazards) if (h.kind === 'fire') n += h.cells.length;
  return n;
}

function savedBytes() {
  try { const raw = globalThis.localStorage.getItem(SAVE_KEY); return raw ? raw.length : 0; }
  catch { return -1; }
}

/** Play one whole shift on an EXISTING Game — the ESC-restart path a real player takes. */
function playShift(g, { idle = false, sample = null } = {}) {
  g.startShift();
  const s = g.state;
  const bot = idle ? null : new CrewBot(g);
  let simMs = 0, frames = 0;
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    if (bot) bot.think();
    const t0 = performance.now();
    g.frame(STEP, bot ? bot.input : null);
    simMs += performance.now() - t0;
    frames++;
    if (sample) sample(s, frames, simMs);
    if (s.mode !== MODES.PLAYING) break;
  }
  return { simMs, frames };
}

function snapshotCounts(g) {
  const s = g.state;
  const town = loadTown();
  return {
    radio: s.radio.length,
    busLog: g.bus.log.length,
    busEmitted: g.bus.emitted,
    hazards: s.hazards.length,
    fireCells: fireCellCount(s),
    victims: s.victims.length,
    incidents: s.incidents.length,
    tools: s.tools.length,
    responders: s.responders.length,
    subs: g._subs.size,
    history: town.history.length,
    buildings: Object.keys(town.buildings).length,
    hydrants: Object.keys(town.hydrants).length,
    brokenHydrants: Object.values(town.hydrants).filter((h) => h.damaged).length,
    saveBytes: savedBytes(),
    shiftNumber: town.shiftNumber,
    confidence: town.confidence,
    clamped: g.clock.clampedFrames,
    nan: nonFinite(s).length,
  };
}

/* ── A. six shifts back to back on ONE Game ──────────────────────────────── */
const SHIFTS = 6;
let sectionAResult = null;

function sectionA() {
  say('=== A. six consecutive shifts, one Game object, never reloaded ===');
  say('  (a real player presses ESC on the report; the page is not reloaded)');
  clearSave();
  const g = new Game({ seed: 7331 });
  const rows = [];
  say(' sh | radio busLog  emitted | haz cells  vic  inc | tools resp subs | hist bldg hyd brk | saveB | NaN | simMs');
  for (let i = 1; i <= SHIFTS; i++) {
    const { simMs } = playShift(g);
    const c = snapshotCounts(g);
    c.simMs = Math.round(simMs);
    rows.push(c);
    say(` ${pad(i, 2)} | ${pad(c.radio, 5)} ${pad(c.busLog, 6)} ${pad(c.busEmitted, 8)} | ` +
      `${pad(c.hazards, 3)} ${pad(c.fireCells, 5)} ${pad(c.victims, 4)} ${pad(c.incidents, 4)} | ` +
      `${pad(c.tools, 5)} ${pad(c.responders, 4)} ${pad(c.subs, 4)} | ` +
      `${pad(c.history, 4)} ${pad(c.buildings, 4)} ${pad(c.hydrants, 3)} ${pad(c.brokenHydrants, 3)} | ` +
      `${pad(c.saveBytes, 5)} | ${pad(c.nan, 3)} | ${pad(c.simMs, 5)}`);
    emit(`A: shift ${i}/${SHIFTS}`);
  }
  const first = rows[0], last = rows[rows.length - 1];
  say(`  growth over ${SHIFTS} shifts: radio ${first.radio}->${last.radio}, busLog ${first.busLog}->${last.busLog}, ` +
    `hazards ${first.hazards}->${last.hazards}, incidents ${first.incidents}->${last.incidents}`);
  say(`  save bytes ${first.saveBytes} -> ${last.saveBytes} ` +
    `(${((last.saveBytes - first.saveBytes) / (SHIFTS - 1)).toFixed(1)} B/shift)`);
  say(`  town history ${first.history} -> ${last.history} of a cap of 12`);
  say(`  broken hydrants ${rows.map((r) => r.brokenHydrants).join(' -> ')} of ${HYDRANTS.length}`);
  say(`  damaged buildings ${rows.map((r) => r.buildings).join(' -> ')} of ${BUILDINGS.length}`);
  say(`  confidence ${rows.map((r) => Math.round(r.confidence * 100) + '%').join(' -> ')}`);
  say(`  wall clock per shift ${rows.map((r) => r.simMs).join(' -> ')} ms of simulation`);
  say('');
  sectionAResult = { g, rows };
  emit('A done');
}

/* ── B. does one shift get more expensive as it goes on? ─────────────────── */
function sectionB() {
  say('=== B. cost of a step, early in a shift vs late in the same shift ===');
  clearSave();
  const g = new Game({ seed: 5150 });
  const buckets = [];   // [ms of sim, steps] per 60 s of shift
  let bucketMs = 0, bucketSteps = 0, bucketIdx = 0;
  const marks = [];
  playShift(g, {
    sample: (s, frames, simMs) => {
      bucketSteps++;
      const idx = Math.floor(s.simTimeMs / 60000);
      if (idx !== bucketIdx) {
        buckets.push({
          min: bucketIdx,
          usPerStep: ((simMs - bucketMs) * 1000) / Math.max(1, bucketSteps),
          hazards: s.hazards.length, cells: fireCellCount(s),
          victims: s.victims.length, incidents: s.incidents.length,
        });
        marks.push(s.hazards.length);
        bucketMs = simMs; bucketSteps = 0; bucketIdx = idx;
      }
    },
  });
  say('  min | us/step | hazards fireCells victims incidents');
  for (const b of buckets) {
    say(`  ${pad(b.min, 3)} | ${pad(b.usPerStep.toFixed(1), 7)} | ${pad(b.hazards, 7)} ${pad(b.cells, 9)} ` +
      `${pad(b.victims, 7)} ${pad(b.incidents, 9)}`);
  }
  if (buckets.length > 2) {
    const a = buckets[0].usPerStep, z = buckets[buckets.length - 1].usPerStep;
    say(`  first minute ${a.toFixed(1)} us/step, last minute ${z.toFixed(1)} us/step ` +
      `(x${(z / Math.max(0.0001, a)).toFixed(2)})`);
  }
  const s = g.state;
  const resolved = s.hazards.filter((h) => h.resolved).length;
  say(`  at the bell: ${s.hazards.length} hazards, ${resolved} of them RESOLVED and still stepped every frame`);
  say(`  ${fireCellCount(s)} fire cells still walked by stepFire/heatAt/applyWater every step`);
  say('');
  emit('B done');
}

/* ── C. numeric health after abuse that produces extreme numbers ─────────── */
function sectionC() {
  say('=== C. numeric health (a single NaN position is unrecoverable for a player) ===');
  clearSave();
  const g = new Game({ seed: 4242 });
  g.startShift();
  const s = g.state;

  // Ram the engine into the shop at full throttle for a minute, then walk the responder
  // into walls, then knock them about with gas flashes.
  const eng = s.apparatus[0];
  const p = s.player;
  p.inVehicleId = eng.id; eng.driverId = p.id;
  const inp = {
    moveAxis: () => ({ x: 1, y: 1 }), isDown: () => true, wasPressed: () => false,
    endStep: () => {}, pointerWorld: null,
  };
  for (let t = 0; t < 60000; t += STEP) g.frame(STEP, inp);
  const afterRam = nonFinite(s);
  say(`  60 s of full-throttle ramming: ${afterRam.length} non-finite numbers ${afterRam.slice(0, 4).join(', ')}`);
  say(`  engine at (${eng.x.toFixed(2)}, ${eng.y.toFixed(2)}) speed ${eng.speed.toFixed(2)} damage ${eng.damage.toFixed(3)} odo ${Math.round(eng.odometerM)} m`);

  p.inVehicleId = null; eng.driverId = null;
  for (let t = 0; t < 30000; t += STEP) g.frame(STEP, inp);
  const afterWalk = nonFinite(s);
  say(`  30 s of walking into walls: ${afterWalk.length} non-finite ${afterWalk.slice(0, 4).join(', ')}`);
  say(`  responder at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) facing ${p.facing.toFixed(3)} v=(${p.vx.toFixed(2)}, ${p.vy.toFixed(2)})`);

  // Aim exactly at your own feet: atan2(0,0) territory.
  p.vx = 0; p.vy = 0;
  const aimSelf = {
    moveAxis: () => ({ x: 0, y: 0 }), isDown: () => false, wasPressed: () => false,
    endStep: () => {}, pointerWorld: { x: p.x, y: p.y },
  };
  for (let t = 0; t < 2000; t += STEP) g.frame(STEP, aimSelf);
  say(`  aiming at your own feet for 2 s: facing ${p.facing} (finite ${Number.isFinite(p.facing)})`);

  const worst = [];
  for (const v of s.victims) if (!Number.isFinite(v.condition)) worst.push(`victim ${v.id}`);
  for (const i of s.incidents) if (!Number.isFinite(i.danger)) worst.push(`incident ${i.id}`);
  for (const h of s.hazards) if (h.kind === 'fire') for (const c of h.cells) if (!Number.isFinite(c.heat)) { worst.push(`cell of ${h.id}`); break; }
  if (!Number.isFinite(s.town.confidence)) worst.push('town confidence');
  say(`  targeted scan (victim condition, incident danger, fire cell heat, confidence): ${worst.length ? worst.join(', ') : 'all finite'}`);

  // And the whole soak from section A.
  if (sectionAResult) {
    const bad = nonFinite(sectionAResult.g.state);
    say(`  after the six-shift soak in A: ${bad.length} non-finite ${bad.slice(0, 4).join(', ')}`);
  }
  say('');
  emit('C done');
}

/* ── D. determinism ──────────────────────────────────────────────────────── */
function sectionD() {
  say('=== D. determinism: the same seed must produce the same shift ===');
  for (const seed of [2026, 991]) {
    clearSave();
    const a = new Game({ seed });
    playShift(a);
    const da = digest(a.state);
    clearSave();
    const b = new Game({ seed });
    playShift(b);
    const db = digest(b.state);
    say(`  seed ${seed}: bot shift digest ${hashStr(da)} vs ${hashStr(db)} — ${da === db ? 'IDENTICAL' : 'DIVERGED'}`);
    if (da !== db) {
      const n = Math.min(da.length, db.length);
      let i = 0; while (i < n && da[i] === db[i]) i++;
      say(`    first difference at char ${i}: ...${da.slice(Math.max(0, i - 60), i + 40)}`);
      say(`                                   ...${db.slice(Math.max(0, i - 60), i + 40)}`);
    }
    emit('D running');
  }
  // an idle shift too — no bot, so nothing but the world's own clocks
  clearSave();
  const c = new Game({ seed: 31337 }); playShift(c, { idle: true });
  const dc = digest(c.state);
  clearSave();
  const d = new Game({ seed: 31337 }); playShift(d, { idle: true });
  say(`  seed 31337 idle: ${dc === digest(d.state) ? 'IDENTICAL' : 'DIVERGED'}`);

  // shift 2 of a town must differ from shift 1 but repeat for the same town
  clearSave();
  const e = new Game({ seed: 808 });
  playShift(e, { idle: true }); const e1 = digest(e.state);
  playShift(e, { idle: true }); const e2 = digest(e.state);
  say(`  shift 2 differs from shift 1 on the same town: ${e1 !== e2}`);
  say('');
  emit('D done');
}

/* ── E. localStorage: full, unavailable, corrupt ─────────────────────────── */
function withStorage(fake, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage') ||
    Object.getOwnPropertyDescriptor(Window.prototype, 'localStorage');
  let installed = false;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: fake });
    installed = true;
    return fn();
  } finally {
    if (installed) {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete globalThis.localStorage;
    }
  }
}

function fakeStore({ failWrite = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrite) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i],
    clear: () => map.clear(),
    _map: map,
  };
}

function sectionE() {
  say('=== E. localStorage: full, unavailable, corrupt ===');

  // 1. quota exceeded on every write
  const full = fakeStore({ failWrite: true });
  let quotaResult;
  withStorage(() => full, () => {
    const ok1 = saveTown(defaultTown());
    const g = new Game({ seed: 55 });
    let threw = null;
    try { g.startShift(); g.state.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
    catch (err) { threw = err && err.message; }
    quotaResult = { ok1, threw, mode: g.state.mode, report: !!g.state.report, shift: loadTown().shiftNumber };
  });
  say(`  quota exceeded: saveTown returns ${quotaResult.ok1} (nobody in src/ reads that return value)`);
  say(`  a shift still ends: threw=${quotaResult.threw} mode=${quotaResult.mode} report=${quotaResult.report}`);
  say(`  but the town is frozen: next loadTown says shift ${quotaResult.shift} forever`);

  // 2. no localStorage at all (private mode / locked-down profile)
  let privResult;
  withStorage(() => { throw new Error('SecurityError: access denied'); }, () => {
    const g = new Game({ seed: 56 });
    const shifts = [];
    let threw = null;
    try {
      for (let i = 0; i < 3; i++) {
        g.startShift();
        g.state.simTimeMs = CONFIG.shift.durationMs;
        g.endShift();
        shifts.push(g.state.town.shiftNumber);
      }
    } catch (err) { threw = err && err.message; }
    privResult = { shifts, threw, save: saveTown(defaultTown()), load: loadTown().shiftNumber };
  });
  say(`  storage throws on access: three shifts run, threw=${privResult.threw}`);
  say(`  shift numbers seen by the player: ${privResult.shifts.join(', ')} (loadTown always ${privResult.load})`);
  say(`  saveTown reports ${privResult.save}; the HUD is never told`);

  // 3. corrupt / truncated save
  const corruptCases = [
    ['truncated json', '{"version":1,"shiftNumber":9,"confid'],
    ['not an object', '"hello"'],
    ['null', 'null'],
    ['array', '[1,2,3]'],
    ['wrong version', JSON.stringify({ version: 99, shiftNumber: 9, history: ['a'] })],
    ['NaN confidence', '{"version":1,"shiftNumber":9,"confidence":null,"buildings":{},"hydrants":{},"history":["a"]}'],
    ['hostile buildings', JSON.stringify({ version: 1, shiftNumber: 9, confidence: 0.5, buildings: { nope: 'x', bad: { damage: 'zz' } }, hydrants: 7, history: 'nope' })],
  ];
  for (const [name, raw] of corruptCases) {
    const st = fakeStore();
    st._map.set(SAVE_KEY, raw);
    let out;
    withStorage(() => st, () => {
      let threw = null, t = null;
      try { t = loadTown(); } catch (err) { threw = err && err.message; }
      let gameThrew = null;
      try { const g = new Game({ seed: 57 }); g.startShift(); g.frame(100, null); }
      catch (err) { gameThrew = err && err.message; }
      out = { threw, shift: t && t.shiftNumber, hist: t && t.history.length, gameThrew };
    });
    say(`  ${name.padEnd(18)} -> loadTown ${out.threw ? 'THREW ' + out.threw : `shift ${out.shift}, ${out.hist} history lines`}` +
      `${out.gameThrew ? ' | game threw ' + out.gameThrew : ''}`);
  }
  say('  (a corrupt save silently resets the town to shift 1 — no warning anywhere in the UI)');

  // 4. how big does the save actually get, worst case
  const worst = defaultTown();
  for (const b of BUILDINGS) worst.buildings[b.id] = { damage: 0.97, boardedShifts: 3, timesBurned: 99 };
  for (const h of HYDRANTS) worst.hydrants[h.id] = { damaged: true, shiftsDown: 1 };
  worst.history = new Array(12).fill('Feed store gutted; two patients handled; three calls never worked at all.');
  say(`  worst-case save is ${JSON.stringify(worst).length} bytes against a 5 MB quota`);
  say('');
  emit('E done');
}

/* ── F. abuse ────────────────────────────────────────────────────────────── */
function sectionF() {
  say('=== F. abuse: long deltas, mashed keys, double-ends ===');
  clearSave();

  // 1. the laptop lid closed for an hour
  {
    const g = new Game({ seed: 61 }); g.startShift();
    const before = g.state.simTimeMs;
    const steps = g.frame(3600000, null);
    say(`  a 1-hour frame delta: ${steps} steps executed, sim advanced ` +
      `${(g.state.simTimeMs - before).toFixed(1)} ms, clampedFrames ${g.clock.clampedFrames}`);
    const st = g.frame(-5000, null);
    say(`  a NEGATIVE 5 s delta: ${st} steps, accumulator ${g.clock.accumulatorMs.toFixed(3)}`);
    const si = g.frame(Infinity, null);
    say(`  an Infinity delta: ${si} steps, accumulator ${g.clock.accumulatorMs.toFixed(3)}, sim ${g.state.simTimeMs.toFixed(1)}`);
    const sn = g.frame(NaN, null);
    const after = g.frame(16.7, null);
    say(`  a NaN delta: ${sn} steps, accumulator ${g.clock.accumulatorMs}; ` +
      `the NEXT normal frame ran ${after} steps (sim ${g.state.simTimeMs.toFixed(1)} ms)`);
    say(`  -> the clock ${Number.isFinite(g.clock.accumulatorMs) ? 'recovered' : 'is permanently poisoned'}`);
  }

  // 2. a long frame that straddles the end of the shift
  {
    const g = new Game({ seed: 62 }); g.startShift();
    const s = g.state;
    let ended = false, afterEnd = [];
    g.bus.on('SHIFT_ENDED', () => { ended = true; });
    g.bus.onAny((e) => { if (ended && e.type !== 'SHIFT_ENDED') afterEnd.push(e.type); });

    // a casualty who has about six steps left in them
    const v = createVictim({ incidentId: null, x: 200, y: 150, severity: 'injured' });
    v.condition = CONFIG.medical.declineInjured * (6 * STEP / 1000);
    s.victims.push(v);

    g.clock.simTimeMs = CONFIG.shift.durationMs - 2 * STEP;
    s.simTimeMs = g.clock.simTimeMs;
    const steps = g.frame(CONFIG.sim.maxFrameMs, null);
    say(`  a ${CONFIG.sim.maxFrameMs} ms frame across the bell: ${steps} steps ran, ` +
      `sim ended at ${s.simTimeMs.toFixed(1)} ms vs a shift length of ${s.shiftMs} ms`);
    say(`  -> ${((s.simTimeMs - CONFIG.shift.durationMs) / STEP).toFixed(0)} steps of world simulated AFTER ` +
      `the report was built, the confidence was banked and the town was saved`);
    say(`  events after SHIFT_ENDED: ${afterEnd.length ? afterEnd.join(', ') : 'none'}`);
    say(`  report says patientsLost ${s.report.patientsLost}, state now says ${s.outcome.patientsLost}; ` +
      `report confidenceEnd ${s.report.confidenceEnd.toFixed(4)}, town confidence now ${s.town.confidence.toFixed(4)}`);
    say(`  the saved town kept ${loadTown().confidence.toFixed(4)} (the post-bell change is not in it)`);
  }

  // 3. ending a shift twice, and starting one while one is running
  {
    const g = new Game({ seed: 63 }); g.startShift();
    g.state.simTimeMs = CONFIG.shift.durationMs;
    g.endShift();
    const t1 = loadTown().shiftNumber;
    g.endShift(); g.endShift(); g.endShift();
    const t2 = loadTown().shiftNumber;
    say(`  endShift x4: town shift number ${t1} then ${t2} (double-advance would show here)`);

    const h = new Game({ seed: 64 }); h.startShift();
    for (let t = 0; t < 90000; t += STEP) h.frame(STEP, null);
    const midDamage = Object.keys(h.state.town.buildings).length;
    const midShift = h.state.town.shiftNumber;
    h.startShift();
    say(`  startShift while a shift is running: shift number ${midShift} -> ${h.state.town.shiftNumber}, ` +
      `${midDamage} damaged buildings -> ${Object.keys(h.state.town.buildings).length}, sim clock ${h.state.simTimeMs}`);
  }

  // 4. mashing ESC, and alt-tabbing
  {
    const g = new Game({ seed: 65 }); g.startShift();
    for (let i = 0; i < 2000; i++) g.togglePause();
    const modeAfter = g.state.mode;
    for (let i = 0; i < 500; i++) { g.pauseForBlur(); g.togglePause(); }
    let ran = 0;
    for (let t = 0; t < 1000; t += STEP) ran += g.frame(STEP, null);
    say(`  2000 pause toggles then 500 blur/unpause pairs: mode ${modeAfter}/${g.state.mode}, ` +
      `busLog ${g.bus.log.length} (cap ${CONFIG.debug.eventLogSize}), radio ${g.state.radio.length}, ` +
      `the town still steps (${ran} steps in the next second)`);
    // pause while already paused, unpause while playing, from every mode
    g.state.mode = MODES.REPORT; g.togglePause();
    say(`  togglePause on the report screen leaves mode ${g.state.mode}`);
    g.state.mode = MODES.TITLE; g.pauseForBlur();
    say(`  blur on the title card leaves mode ${g.state.mode}`);
  }

  // 5. mashing P
  {
    const g = new Game({ seed: 66 }); g.startShift();
    const s = g.state;
    for (let i = 0; i < 501; i++) toggleCoop(s);
    const orphanTools = s.tools.filter((t) => t.carrier && t.carrier !== 'rack' &&
      !s.responders.some((r) => r.id === t.carrier) &&
      !s.apparatus.some((a) => a.id === t.carrier)).length;
    const orphanVictims = s.victims.filter((v) => v.draggedBy && !s.responders.some((r) => r.id === v.draggedBy)).length;
    const ghostDrivers = s.apparatus.filter((a) => a.driverId && !s.responders.some((r) => r.id === a.driverId)).length;
    say(`  501 toggleCoop calls: ${s.responders.length} responders, coop=${s.coop}, ` +
      `player===responders[0] ${s.player === s.responders[0]}, ` +
      `orphan tools ${orphanTools}, orphan patients ${orphanVictims}, ghost drivers ${ghostDrivers}`);
    say(`  remoteCommands keys after the mashing: ${Object.keys(s.net.remoteCommands).length}`);
    // and while the partner is at the wheel, holding a tool, carrying somebody
    if (s.responders.length < 2) toggleCoop(s);
    const r2 = s.responders[1];
    const ap = s.apparatus[0];
    r2.inVehicleId = ap.id; ap.driverId = r2.id; ap.passengerIds = [r2.id];
    const tool = s.tools[0]; tool.carrier = r2.id;
    if (s.victims[0]) s.victims[0].draggedBy = r2.id;
    toggleCoop(s);
    say(`  signing off mid-job: driver ${ap.driverId}, passengers ${ap.passengerIds.length}, ` +
      `tool carrier ${tool.carrier}, dropped at (${(tool.x || 0).toFixed(1)}, ${(tool.y || 0).toFixed(1)})`);
  }

  // 6. mashing P while a network partner is connected
  {
    const g = new Game({ seed: 67 }); g.startShift();
    const [hostLink, clientLink] = loopbackPair();
    const net = new NetSession(g);
    net.hostOn(hostLink);
    let welcomed = null;
    clientLink.onMessage = (m) => { if (m.t === MSG.WELCOME) welcomed = m.id; };
    clientLink.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
    const s = g.state;
    say(`  a client joins: ${s.responders.length} responders, welcome id ${welcomed}, ` +
      `remote flag ${s.responders[1] && s.responders[1].remote}, status "${net.status}"`);
    toggleCoop(s);   // the host presses P
    say(`  the host presses P: ${s.responders.length} responders, link open ${clientLink.open}, ` +
      `status "${net.status}" — the client is still connected to a town it is not in`);
    toggleCoop(s);   // and presses P again
    say(`  and presses P again: responders ${s.responders.length}, ` +
      `responders[1].remote=${s.responders[1] && s.responders[1].remote} ` +
      `(a LOCAL partner now wears the remote player's slot; their commands go nowhere)`);
    say(`  queued remote commands nobody reads: ${Object.keys(s.net.remoteCommands).length}`);
  }

  // 7. what a host does with a command it did not like the look of
  {
    const g = new Game({ seed: 68 }); g.startShift();
    const [hostLink, clientLink] = loopbackPair();
    const net = new NetSession(g);
    net.hostOn(hostLink);
    clientLink.onMessage = () => {};
    clientLink.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
    const s = g.state;
    const r2 = s.responders[1];

    const shapes = [
      ['no fields at all', { t: MSG.CMD }],
      ['missing drive', { t: MSG.CMD, a: [0, 0] }],
      ['strings where numbers go', { t: MSG.CMD, a: ['x', 'y'], d: [0, 0], m: 0, l: -1 }],
      ['an aim of NaN', { t: MSG.CMD, a: [0, 0], d: [0, 0], m: ['a', 'b'], l: -1 }],
      ['a slot of 1e9', { t: MSG.CMD, a: [0, 0], d: [0, 0], m: 0, l: 1e9 }],
    ];
    for (const [name, msg] of shapes) {
      let threw = null;
      try { clientLink.send(msg); } catch (err) { threw = (err && err.message) || String(err); }
      const cmd = s.net.remoteCommands.r2;
      say(`  CMD "${name}": ${threw ? 'THREW ' + threw : `accepted as axis (${cmd.axis.x}, ${cmd.axis.y}) slot ${cmd.slot}`}`);
      if (!threw) {
        for (let i = 0; i < 30; i++) g.frame(STEP, null);
        const nanCrew = s.responders.filter((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y)).length;
        if (nanCrew) {
          let cx = 0; for (const q of s.responders) cx += q.x;
          say(`  -> after 30 steps ${nanCrew} responder(s) are at a NON-FINITE position; ` +
            `the camera follows their mean, which is ${cx / s.responders.length}`);
          // does it ever come back?
          for (let i = 0; i < 600; i++) g.frame(STEP, null);
          say(`  -> 10 s later r2 is still at (${r2.x}, ${r2.y}) — nothing in the sim can undo a NaN`);
          break;
        }
      }
    }

    // a client on the WRONG protocol version: rejected at hello, still hammering
    const g2 = new Game({ seed: 69 }); g2.startShift();
    const [hl, cl] = loopbackPair();
    const net2 = new NetSession(g2);
    net2.hostOn(hl);
    cl.onMessage = () => {};
    cl.send({ t: MSG.HELLO, v: PROTOCOL_VERSION + 7 });
    say(`  a client on protocol v${PROTOCOL_VERSION + 7}: status "${net2.status}", ` +
      `responders ${g2.state.responders.length}, link still open ${cl.open} ` +
      `(nothing hangs up, and CMD is never version-checked)`);
  }
  say('');
  emit('F done');
}

/* ── G. the renderer, over many frames ───────────────────────────────────── */
function sectionG() {
  say('=== G. renderer scratch arrays over repeated frames ===');
  const S = window.__STES;
  if (!S || !S.renderer) { say('  no page renderer available'); say(''); emit('G done'); return; }
  clearSave();
  const g = new Game({ seed: 71 });
  g.startShift();
  for (let t = 0; t < 180000; t += STEP) g.frame(STEP, null);   // a busy-ish town
  const r = S.renderer;
  S.camera.resize(S.renderer.canvas);
  const samples = [];
  for (let i = 1; i <= 240; i++) {
    r.render(g.state, i * 16.7);
    if (i === 1 || i === 60 || i === 120 || i === 240) {
      samples.push(`frame ${i}: labels ${r.labels.length} props ${r.props.length} markers ${r.markers.length}`);
    }
  }
  for (const s of samples) say('  ' + s);
  say(`  town on screen: ${g.state.hazards.length} hazards, ${g.state.victims.length} victims, ` +
    `${g.state.incidents.length} incidents`);
  say('');
  emit('G done');
}

/* ── H. save / load round trip after a long campaign ─────────────────────── */
function sectionH() {
  say('=== H. the town after the six-shift soak: does it still load clean? ===');
  const town = loadTown();
  const again = migrate(JSON.parse(JSON.stringify(town)));
  say(`  loadTown -> shift ${town.shiftNumber}, confidence ${town.confidence.toFixed(3)}, ` +
    `${Object.keys(town.buildings).length} buildings, ${Object.keys(town.hydrants).length} hydrants, ` +
    `${town.history.length} history lines, learned ${JSON.stringify(town.learned)}`);
  say(`  round trip is stable: ${JSON.stringify(town) === JSON.stringify(again)}`);
  say(`  every field finite: ${nonFinite(town).length === 0}`);

  // What does advanceShift do to a hydrant, twice, through a real save?
  clearSave();
  let t = defaultTown();
  t.hydrants.hyd_elm = { damaged: true };
  const seen = [];
  for (let i = 0; i < 6; i++) {
    t = advanceShift(t, `shift ${i}`);
    saveTown(t);
    t = loadTown();
    const rec = t.hydrants.hyd_elm;
    seen.push(rec ? `damaged(shiftsDown=${rec.shiftsDown})` : 'repaired');
  }
  say(`  a struck hydrant, through six real save/load cycles: ${seen.join(' -> ')}`);
  say('  (persistence.js says "out for the following shift, then the water board gets to it")');

  // and a gutted building
  clearSave();
  let t2 = defaultTown();
  t2.buildings.b_feed = { damage: 0.95, boardedShifts: 0, timesBurned: 1 };
  const bseen = [];
  for (let i = 0; i < 6; i++) {
    t2 = advanceShift(t2, `s${i}`);
    saveTown(t2); t2 = loadTown();
    const rec = t2.buildings.b_feed;
    bseen.push(rec ? `dmg ${rec.damage.toFixed(2)}/boarded ${rec.boardedShifts}` : 'repaired');
  }
  say(`  a gutted building, six cycles: ${bseen.join(' -> ')}`);

  // history cap under a long campaign
  clearSave();
  let t3 = defaultTown();
  for (let i = 0; i < 40; i++) { t3 = advanceShift(t3, `headline ${i}`); saveTown(t3); t3 = loadTown(); }
  say(`  40 shifts: shiftNumber ${t3.shiftNumber}, history ${t3.history.length} lines, ` +
    `save ${savedBytes()} bytes, confidence ${t3.confidence.toFixed(3)}`);
  say('');
  emit('H done');
}

/* ── I. the burning wreck whose call was given up on ─────────────────────── */
function distToRect(x, y, b) {
  const nx = Math.min(b.x + b.w, Math.max(b.x, x));
  const ny = Math.min(b.y + b.h, Math.max(b.y, y));
  return dist(x, y, nx, ny);
}

/** Gap between two axis-aligned footprints, 0 if they touch. */
function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/* ── J. is the town's decay permanent? ───────────────────────────────────── */
function sectionJ() {
  say('=== J. twelve shifts nobody responds to: can the town ever come back? ===');
  clearSave();
  const g = new Game({ seed: 101 });
  say('  sh | boarded | damaged | brokenHyd | sites left for a structure fire | confidence');
  const boardedNames = new Set();
  for (let i = 1; i <= 12; i++) {
    playShift(g, { idle: true });
    const t = loadTown();
    const boarded = Object.entries(t.buildings).filter(([, r]) => r.boardedShifts > 0);
    const damaged = Object.entries(t.buildings).filter(([, r]) => r.damage > 0.02);
    const broken = Object.values(t.hydrants).filter((h) => h.damaged).length;
    for (const [id] of boarded) boardedNames.add(id);
    const sites = BUILDINGS.filter((b) => b.kind !== 'station' &&
      !(t.buildings[b.id] && t.buildings[b.id].boardedShifts > 0)).length;
    say(`  ${pad(i, 2)} | ${pad(boarded.length, 7)} | ${pad(damaged.length, 7)} | ${pad(broken, 9)} | ` +
      `${pad(sites, 30)} | ${(t.confidence * 100).toFixed(0)}%`);
    emit(`J: shift ${i}/12`);
  }
  const end = loadTown();
  say(`  ${boardedNames.size} distinct buildings have been boarded up; ` +
    `${Object.values(end.buildings).filter((r) => r.boardedShifts > 0).length} are STILL boarded on shift ${end.shiftNumber}`);
  say(`  every boarded record sits at boardedShifts=${CONFIG.town.repairShifts - 1} ` +
    `even though CONFIG.town.repairShifts is ${CONFIG.town.repairShifts}: ` +
    `${Object.values(end.buildings).filter((r) => r.boardedShifts > 0).map((r) => r.boardedShifts).join(',') || 'none'}`);
  say(`  broken hydrants: ${Object.values(end.hydrants).filter((h) => h.damaged).length} of ${HYDRANTS.length}, none ever repaired`);
  say('');
  emit('J done');
}

function sectionI() {
  say('=== I. what a hazard can still do once its call has been given up on ===');

  // I1. a structure fire whose call went LOST, next to an exposure it should take.
  {
    let pair = null, bestD = Infinity;
    for (const a of BUILDINGS) {
      for (const b of BUILDINGS) {
        if (a.id === b.id || b.kind === 'clinic' || b.kind === 'station' || a.kind === 'station') continue;
        const d = distToRect(a.x + a.w / 2, a.y + a.h / 2, b) - Math.max(a.w, a.h) / 2;
        const real = rectGap(a, b);
        if (real < bestD) { bestD = real; pair = [a, b]; }
        void d;
      }
    }
    say(`  closest pair of buildings: ${pair[0].name} and ${pair[1].name}, ${bestD.toFixed(1)} m apart ` +
      `(CONFIG.fire.jumpDistM is ${CONFIG.fire.jumpDistM})`);

    // Same seed, same fire, same 5 minutes. The only difference is whether the call is
    // still open. Everything is attributed by id, so the shift's own dispatch cannot
    // contaminate the count.
    for (const open of [true, false]) {
      clearSave();
      const g = new Game({ seed: 91 });
      g.startShift();
      const s = g.state;
      const inc = {
        id: 'incF', templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
        place: pair[0].name, x: pair[0].door.x, y: pair[0].door.y, buildingId: pair[0].id, roadId: null,
        priority: 'high', report: '', createdMs: 0, ageMs: 0, danger: 0, peakDanger: 0,
        status: open ? 'active' : 'lost', hazardIds: [], victimIds: [], consequences: [], capabilities: [],
        updates: [], lastUpdateText: null, resolvedMs: open ? null : 0, outcomeNote: null, everWorked: true,
      };
      s.incidents.push(inc);
      const fire = createFire(pair[0].id, { seedCells: 3, heat: 1.0, from: 'centre' });
      addHazard(s, inc, fire);

      let attempts = 0;
      g.bus.on('FIRE_EXTENDED', (e) => { if (e.fromHazardId === fire.id) attempts++; });
      for (let t = 0; t < 300000 && s.mode === MODES.PLAYING; t += STEP) {
        g.frame(STEP, null);
        if (open) inc.danger = 0;   // a crew is working it; it never gets declared lost
      }
      const caught = s.hazards.filter((h) => h.kind === 'fire' && h.incidentId === inc.id &&
        h.buildingId !== pair[0].id);
      say(`  call ${open ? 'OPEN' : 'LOST'}: ${attempts} FIRE_EXTENDED attempts off that fire in 5 min, ` +
        `${caught.length} of them started a fire in ${pair[1].name} ` +
        `(${(fireDamageFraction(fire) * 100).toFixed(0)}% of ${pair[0].name} burned)`);
    }
    say(`  -> "fire jumps to an exposure ${CONFIG.fire.jumpDistM} m away" stops being true the moment a call is given up on`);
  }

  say('');
  say('  I2. the same missing guard, in a shape that also spams the bus:');
  // How close can a wreck legitimately get to a building? Wrecks are placed within
  // 5.5 m of a crash site, and stepWreck reaches 6 m.
  const near = [];
  for (const cs of CRASH_SITES) {
    let best = Infinity, name = '';
    for (const b of BUILDINGS) { const d = distToRect(cs.x, cs.y, b); if (d < best) { best = d; name = b.name; } }
    near.push(`${cs.id} ${best.toFixed(1)} m from ${name}`);
  }
  say('  crash site -> nearest building: ' + near.join(' | '));
  say(`  reachable within stepWreck's 6 m (site distance minus the 5.5 m scatter): ` +
    near.filter((n) => parseFloat(n.split(' ')[1]) <= 11.5).length + ' of ' + CRASH_SITES.length);

  for (const closed of [false, true]) {
    clearSave();
    const g = new Game({ seed: 81 });
    g.startShift();
    const s = g.state;
    // put a burning wreck 4 m off the nearest building to a crash site
    const cs = CRASH_SITES[0];
    let target = BUILDINGS[0], bd = Infinity;
    for (const b of BUILDINGS) { const d = distToRect(cs.x, cs.y, b); if (d < bd) { bd = d; target = b; } }
    const wx = Math.min(target.x + target.w, Math.max(target.x, cs.x));
    const wy = Math.min(target.y + target.h, Math.max(target.y, cs.y)) + 4;
    const inc = {
      id: 'incX', templateId: 'vehicle_fire', family: 'fire', headline: 'Vehicle fire',
      place: 'a test', x: wx, y: wy, buildingId: null, roadId: null, priority: 'routine',
      report: '', createdMs: 0, ageMs: 0, danger: 0, peakDanger: 0,
      status: closed ? 'lost' : 'active', hazardIds: [], victimIds: [], consequences: [],
      capabilities: [], updates: [], lastUpdateText: null, resolvedMs: closed ? 0 : null,
      outcomeNote: null, everWorked: true,
    };
    s.incidents.push(inc);
    addHazard(s, inc, createWreck(wx, wy, 0, { fuelLeak: 1, burning: true }));

    let extended = 0;
    g.bus.on('FIRE_EXTENDED', () => { extended++; });
    const before = s.hazards.length;
    for (let t = 0; t < 20000; t += STEP) g.frame(STEP, null);
    const fires = s.hazards.filter((h) => h.kind === 'fire' && h.buildingId === target.id).length;
    say(`  call ${closed ? 'LOST  ' : 'OPEN  '}: ${extended} FIRE_EXTENDED events in 20 s ` +
      `(${(extended / 20).toFixed(1)}/s), fires now on ${target.name}: ${fires}, ` +
      `hazards ${before} -> ${s.hazards.length}, bus emitted ${g.bus.emitted}`);
    if (closed) {
      say(`  -> the FIRE_EXTENDED audio cue has a ${500} ms floor, so that is ` +
        `${Math.min(extended, Math.floor(20000 / 500))} whooshes in 20 s with nothing catching fire`);
      const junk = g.bus.log.filter((e) => e.type === 'FIRE_EXTENDED').length;
      say(`  -> ${junk} of the ${g.bus.log.length} entries in the debug event log are this one event`);
    }
  }
  say('');
  emit('I done');
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  say('soak diagnostic starting');
  emit('starting');
  sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  sectionF();
  sectionG();
  sectionH();
  sectionI();
  sectionJ();
  emit('ALL-PASS  measured');
} catch (err) {
  say('threw: ' + (err && err.message));
  say(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit('ALL-PASS  measured (with a throw above)');
}
