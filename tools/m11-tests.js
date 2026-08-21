/* Robustness — what a long session and a rough player do to this game.
 *
 * Every other suite asks whether a shift works. This one asks what is left after six of
 * them without a reload, after an hour with the laptop lid shut, after two thousand jabs
 * at ESC, and on a browser that will not hand out a localStorage. The measurement behind
 * every number here is tools/_soakdiag.js.
 *
 * What it found, and what is therefore worth locking:
 *   - nothing in the live state grows across shifts. radio, the bus log, the tool list,
 *     the crew, the renderer's scratch arrays and the town save are all bounded, and the
 *     numbers below are the caps they were measured against;
 *   - a 10-minute shift ends with 0 non-finite numbers in it, through 60 s of
 *     full-throttle ramming and 30 s of walking into walls. A NaN position is
 *     unrecoverable, so this is the assertion that matters most;
 *   - the clock throws long frames away rather than banking them, in both directions;
 *   - a dead localStorage is survivable: the shift still ends and the report still
 *     builds. Seven shapes of corrupt save all load as a fresh town instead of throwing;
 *   - the same seed still produces the same shift, byte for byte, over a whole bot shift.
 *
 * Assertions here are deliberately written to survive the fixes the diagnostic argues
 * for: they lock the invariant, not the bug.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, toggleCoop } from '../src/game.js';
import {
  clearSave, loadTown, saveTown, migrate, advanceShift, defaultTown, SAVE_KEY,
} from '../src/core/persistence.js';
import { createFire, fireDamageFraction } from '../src/sim/hazards.js';
import { createVictim } from '../src/sim/victims.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { loopbackPair, NetSession } from '../src/net/net.js';
import { MSG, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { CrewBot } from './_crewbot.js';
import { BUILDINGS, HYDRANTS } from '../src/data/town.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const le = (n, a, b) => ok(n, a <= b, `got ${a}, want <= ${b}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);

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
const RADIO_CAP = 40;          // src/sim/dispatch.js
const HISTORY_CAP = 12;        // src/core/persistence.js

/** Every number in a live object graph, checked for NaN and Infinity. */
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
      for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) { bad.push(`${path}[${i}]`); break; }
      return;
    }
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], `${path}[${i}]`, d + 1); return; }
    for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`, d + 1);
  };
  walk(root, '', 0);
  return bad;
}

/** A fingerprint of a whole shift outcome. Two runs of one seed must produce the same. */
function digest(s) {
  const r = (v) => Math.round((v || 0) * 1000) / 1000;
  const p = [
    s.simTimeMs, s.mode, s.outcome.controlled, s.outcome.lost, s.outcome.patientsSaved,
    s.outcome.patientsLost, s.outcome.structuresLost, r(s.town.confidence),
    s.dispatch.callsMade, r(s.telemetry.distanceDrivenM), s.telemetry.sceneChanges,
  ];
  for (const a of s.apparatus) p.push(a.id, r(a.x), r(a.y), r(a.angle), r(a.speed), r(a.waterL), r(a.damage));
  for (const q of s.responders) p.push(q.id, r(q.x), r(q.y), r(q.facing), q.toolId, q.inVehicleId);
  for (const i of s.incidents) p.push(i.id, i.templateId, i.place, i.status, i.priority, r(i.danger));
  for (const v of s.victims) p.push(v.id, r(v.x), r(v.y), r(v.condition), v.lost ? 1 : 0, v.delivered ? 1 : 0);
  for (const h of s.hazards) p.push(h.id, h.kind, h.resolved ? 1 : 0,
    h.kind === 'fire' ? `${h.burningCount}:${Math.round(fireDamageFraction(h) * 1000)}`
      : r(h.ppm ?? h.cut ?? h.burnt ?? 0));
  for (const m of s.radio) p.push(m.atMs, m.kind, m.text);
  return p.join('|');
}

function playShift(g, { idle = false } = {}) {
  g.startShift();
  const s = g.state;
  const bot = idle ? null : new CrewBot(g);
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    if (bot) bot.think();
    g.frame(STEP, bot ? bot.input : null);
    if (s.mode !== MODES.PLAYING) break;
  }
  return s;
}

/* ── A. four shifts back to back, one Game, never reloaded ───────────────── */
let soakGame = null;

function sectionA() {
lines.push('--- A. nothing grows across shifts (four shifts, one Game object) ---');
  clearSave();
  const g = new Game({ seed: 7331 });
  soakGame = g;
  const rows = [];
  for (let i = 1; i <= 4; i++) {
    const s = playShift(g);
    rows.push({
      radio: s.radio.length, busLog: g.bus.log.length, tools: s.tools.length,
      hazards: s.hazards.length, incidents: s.incidents.length, victims: s.victims.length,
      responders: s.responders.length, subs: g._subs.size,
      history: loadTown().history.length, saveBytes: (localStorage.getItem(SAVE_KEY) || '').length,
      nan: nonFinite(s).length,
    });
    emit(`running A, shift ${i}`);
  }
  const worst = (k) => Math.max(...rows.map((r) => r[k]));

  ok('A1 the radio log is bounded on every shift', worst('radio') <= RADIO_CAP,
    `worst ${worst('radio')} of a cap of ${RADIO_CAP}`);
  ok('A2 the event-bus log is bounded on every shift', worst('busLog') <= CONFIG.debug.eventLogSize,
    `worst ${worst('busLog')}`);
  ok('A3 the tool list is the same size on shift 4 as on shift 1',
    rows.every((r) => r.tools === rows[0].tools), rows.map((r) => r.tools).join());
  eq('A4 every shift starts and ends with one responder', worst('responders'), 1);
  eq('A5 nothing subscribes to the Game per shift', worst('subs'), 0);
  ok('A6 hazards do not accumulate shift on shift', rows[3].hazards <= rows[0].hazards + 12,
    rows.map((r) => r.hazards).join(' -> '));
  ok('A7 incidents do not accumulate shift on shift', rows[3].incidents <= rows[0].incidents + 6,
    rows.map((r) => r.incidents).join(' -> '));
  ok('A8 victims do not accumulate shift on shift', rows[3].victims <= rows[0].victims + 10,
    rows.map((r) => r.victims).join(' -> '));
  le('A9 the town history never exceeds its cap', Math.max(...rows.map((r) => r.history)), HISTORY_CAP);
  le('A10 the save stays small enough to never be the thing that fills a quota',
    Math.max(...rows.map((r) => r.saveBytes)), 4096);
  eq('A11 four whole shifts leave no NaN or Infinity anywhere in the state', worst('nan'), 0);

  // a fresh shift really is fresh
  const s = g.state;
  g.startShift();
  eq('A12 startShift resets simulation time', g.state.simTimeMs, 0);
  eq('A13 startShift resets the clock', g.clock.stepCount, 0);
  eq('A14 startShift clears the event log', g.bus.log.length, 1);
  eq('A15 startShift hands out a new state object', g.state === s, false);
  eq('A16 and player is still the same object as responders[0]', g.state.player, g.state.responders[0]);
emit('A done');
}

/* ── B. the clock under a rough machine ──────────────────────────────────── */
function sectionB() {
lines.push('--- B. long frames are thrown away, not banked (GDD 28.2) ---');
  clearSave();
  const g = new Game({ seed: 61 });
  g.startShift();
  const maxSteps = Math.ceil(CONFIG.sim.maxFrameMs / STEP);

  const hour = g.frame(3600000, null);
  eq('B1 an hour with the lid shut runs one clamped frame, not an hour of catch-up', hour, maxSteps);
  ok('B2 and advances simulation time by exactly the clamp',
    Math.abs(g.state.simTimeMs - CONFIG.sim.maxFrameMs) < 0.001, `${g.state.simTimeMs}`);
  eq('B3 the discarded time is counted', g.clock.clampedFrames, 1);

  const before = g.state.simTimeMs;
  eq('B4 a negative delta runs nothing', g.frame(-5000, null), 0);
  eq('B5 and does not rewind the town', g.state.simTimeMs, before);
  ok('B6 and does not bank negative time',
    g.clock.accumulatorMs >= 0 && g.clock.accumulatorMs < STEP, `${g.clock.accumulatorMs}`);

  eq('B7 an Infinity delta is clamped like any other long frame', g.frame(Infinity, null), maxSteps);
  ok('B8 simulation time is still finite after it', Number.isFinite(g.state.simTimeMs), `${g.state.simTimeMs}`);

  const beforeNaN = g.state.simTimeMs;
  eq('B9 a NaN delta advances no steps', g.frame(NaN, null), 0);
  eq('B10 and never moves simulation time', g.state.simTimeMs, beforeNaN);
  ok('B11 and never makes simulation time non-finite', Number.isFinite(g.state.simTimeMs));

  // the mode guard is the pause guarantee, and it is the only one
  const h = new Game({ seed: 62 });
  eq('B12 the title card consumes no simulation', h.frame(1000, null), 0);
  h.startShift();
  h.togglePause();
  eq('B13 a paused town consumes no simulation', h.frame(1000, null), 0);
  h.togglePause();
  gt('B14 unpausing starts it again', h.frame(1000, null), 0);
emit('B done');
}

/* ── C. a rough player ───────────────────────────────────────────────────── */
function sectionC() {
lines.push('--- C. mashed keys, double-ends, and a shift started on top of a shift ---');
  clearSave();

  {
    const g = new Game({ seed: 65 });
    g.startShift();
    for (let i = 0; i < 2000; i++) g.togglePause();
    eq('C1 two thousand jabs at ESC land back where they started', g.state.mode, MODES.PLAYING);
    for (let i = 0; i < 500; i++) { g.pauseForBlur(); g.togglePause(); }
    eq('C2 five hundred alt-tabs leave the town playing', g.state.mode, MODES.PLAYING);
    le('C3 and cannot overflow the event log', g.bus.log.length, CONFIG.debug.eventLogSize);
    le('C4 nor the radio', g.state.radio.length, RADIO_CAP);
    gt('C5 the town still steps afterwards', g.frame(100, null), 0);
    g.state.mode = MODES.REPORT;
    g.togglePause();
    eq('C6 pause does nothing on the report screen', g.state.mode, MODES.REPORT);
    g.state.mode = MODES.TITLE;
    g.pauseForBlur();
    eq('C7 blur does nothing on the title card', g.state.mode, MODES.TITLE);
  }

  {
    const g = new Game({ seed: 63 });
    g.startShift();
    g.state.simTimeMs = CONFIG.shift.durationMs;
    const start = loadTown().shiftNumber;
    let ended = 0;
    g.bus.on('SHIFT_ENDED', () => { ended++; });
    g.endShift(); g.endShift(); g.endShift(); g.endShift();
    eq('C8 ending a shift four times ends it once', ended, 1);
    eq('C9 and advances the town exactly one shift', loadTown().shiftNumber, start + 1);
    eq('C10 and leaves exactly one report', typeof g.state.report, 'object');
  }

  {
    // a long frame that straddles the bell must still end the shift exactly once
    const g = new Game({ seed: 62 });
    g.startShift();
    let ended = 0;
    g.bus.on('SHIFT_ENDED', () => { ended++; });
    const before = loadTown().shiftNumber;
    g.clock.simTimeMs = CONFIG.shift.durationMs - 2 * STEP;
    g.state.simTimeMs = g.clock.simTimeMs;
    g.frame(CONFIG.sim.maxFrameMs, null);
    eq('C11 a 250 ms frame across the bell ends the shift once', ended, 1);
    eq('C12 and banks the town once', loadTown().shiftNumber, before + 1);
    eq('C13 and leaves the game on the report', g.state.mode, MODES.REPORT);
    ok('C14 a report was built', !!g.state.report && g.state.report.calls >= 0);
  }

  {
    const g = new Game({ seed: 64 });
    g.startShift();
    for (let t = 0; t < 60000; t += STEP) g.frame(STEP, null);
    const shiftBefore = loadTown().shiftNumber;
    g.startShift();
    eq('C15 restarting mid-shift does not bank a shift that was never finished',
      loadTown().shiftNumber, shiftBefore);
    eq('C16 and the clock goes back to zero', g.state.simTimeMs, 0);
    eq('C17 and the board is empty again', g.state.incidents.length, 0);
  }
emit('C done');
}

/* ── D. the crew, mashed ─────────────────────────────────────────────────── */
function sectionD() {
lines.push('--- D. a second volunteer, signed on and off five hundred times ---');
  clearSave();
  const g = new Game({ seed: 66 });
  g.startShift();
  const s = g.state;
  for (let i = 0; i < 500; i++) toggleCoop(s);
  eq('D1 an even number of P presses leaves one responder', s.responders.length, 1);
  toggleCoop(s);
  eq('D2 an odd number leaves two', s.responders.length, 2);
  eq('D3 player is still responders[0] whatever happened in between', s.player, s.responders[0]);
  eq('D4 responder ids are still unique', new Set(s.responders.map((r) => r.id)).size, s.responders.length);
  eq('D5 nothing non-finite came out of it', nonFinite(s).length, 0);

  // sign off with both hands full
  const r2 = s.responders[1];
  const ap = s.apparatus[0];
  r2.inVehicleId = ap.id; ap.driverId = r2.id; ap.passengerIds = [r2.id];
  const tool = s.tools[0]; tool.carrier = r2.id;
  const victim = createVictim({ incidentId: null, x: r2.x, y: r2.y });
  victim.draggedBy = r2.id;
  s.victims.push(victim);
  toggleCoop(s);
  eq('D6 signing off gives the wheel back', ap.driverId, null);
  eq('D7 and empties the cab', ap.passengerIds.length, 0);
  eq('D8 and puts the nozzle on the ground rather than orphaning it', tool.carrier, null);
  eq('D9 and puts the patient down', victim.draggedBy, null);
  eq('D10 and drops nothing to a non-finite place', nonFinite(s).length, 0);

  // a network partner is a responder too
  const h = new Game({ seed: 67 });
  h.startShift();
  const [hostLink, clientLink] = loopbackPair();
  const net = new NetSession(h);
  net.hostOn(hostLink);
  clientLink.onMessage = () => {};
  clientLink.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
  eq('D11 a client that says hello gets a responder', h.state.responders.length, 2);
  eq('D12 and it is marked remote so no keyboard drives it', h.state.responders[1].remote, true);
  net._partnerGone();
  eq('D13 a partner who drops leaves the shift one-handed', h.state.responders.length, 1);
  eq('D14 and their queued commands are dropped with them',
    Object.keys(h.state.net.remoteCommands).length, 0);
emit('D done');
}

/* ── E. determinism ──────────────────────────────────────────────────────── */
function sectionE() {
lines.push('--- E. the same seed still produces the same shift ---');
  clearSave();
  const a = new Game({ seed: 2026 }); const da = digest(playShift(a));
  clearSave();
  const b = new Game({ seed: 2026 }); const db = digest(playShift(b));
  ok('E1 a whole bot shift on one seed is reproducible byte for byte', da === db,
    `${da.length} vs ${db.length} chars`);
  emit('running E');

  clearSave();
  const c = new Game({ seed: 31337 }); const dc = digest(playShift(c, { idle: true }));
  clearSave();
  const d = new Game({ seed: 31337 }); const dd = digest(playShift(d, { idle: true }));
  ok('E2 and so is a shift nobody turns up to', dc === dd);
  ok('E3 a different seed is a different shift', da !== dc);

  clearSave();
  const e = new Game({ seed: 808 });
  const e1 = digest(playShift(e, { idle: true }));
  const e2 = digest(playShift(e, { idle: true }));
  ok('E4 shift 2 of a town is not a replay of shift 1', e1 !== e2);
emit('E done');
}

/* ── F. localStorage: full, missing, corrupt ─────────────────────────────── */
function withStorage(get, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage') ||
    Object.getOwnPropertyDescriptor(Window.prototype, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
    return fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
  }
}

function fakeStore({ failWrite = false, seed = null } = {}) {
  const map = new Map();
  if (seed) map.set(SAVE_KEY, seed);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (failWrite) throw new Error('QuotaExceededError'); map.set(k, String(v)); },
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function sectionF() {
lines.push('--- F. a save that cannot be written must not end the shift ---');

  let quota;
  withStorage(() => fakeStore({ failWrite: true }), () => {
    let threw = null;
    const g = new Game({ seed: 55 });
    try {
      g.startShift();
      g.state.simTimeMs = CONFIG.shift.durationMs;
      g.endShift();
    } catch (err) { threw = (err && err.message) || String(err); }
    quota = { threw, mode: g.state.mode, report: !!g.state.report, save: saveTown(defaultTown()) };
  });
  eq('F1 a full localStorage does not throw out of endShift', quota.threw, null);
  eq('F2 the shift still reaches the report', quota.mode, MODES.REPORT);
  ok('F3 and the report is still built', quota.report);
  eq('F4 saveTown reports the failure rather than hiding it in an exception', quota.save, false);

  let priv;
  withStorage(() => { throw new Error('SecurityError'); }, () => {
    let threw = null;
    const g = new Game({ seed: 56 });
    try {
      for (let i = 0; i < 3; i++) { g.startShift(); g.state.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
    } catch (err) { threw = (err && err.message) || String(err); }
    priv = { threw, mode: g.state.mode, town: loadTown() };
  });
  eq('F5 a browser with no localStorage at all can still play three shifts', priv.threw, null);
  eq('F6 and reaches the report on the third', priv.mode, MODES.REPORT);
  eq('F7 loadTown falls back to a default town rather than throwing', priv.town.shiftNumber, 1);
  ok('F8 which is a complete town, not a half-built one',
    !!priv.town.buildings && !!priv.town.hydrants && Array.isArray(priv.town.history));

  const corrupt = [
    ['a save truncated mid-write', '{"version":1,"shiftNumber":9,"confid'],
    ['a save that is a string', '"hello"'],
    ['a save that is null', 'null'],
    ['a save that is an array', '[1,2,3]'],
    ['a save from a future version', JSON.stringify({ version: 99, shiftNumber: 9 })],
    ['a save with a null confidence', '{"version":1,"shiftNumber":9,"confidence":null,"buildings":{},"hydrants":{},"history":[]}'],
    ['a save with hostile field types', JSON.stringify({
      version: 1, shiftNumber: 9, confidence: 0.5,
      buildings: { nope: 'x', bad: { damage: 'zz' } }, hydrants: 7, history: 'nope', learned: 5,
    })],
  ];
  let allLoaded = true, allSane = true, gameRan = true;
  for (const [, raw] of corrupt) {
    withStorage(() => fakeStore({ seed: raw }), () => {
      let t = null;
      try { t = loadTown(); } catch { allLoaded = false; return; }
      if (!t || t.version !== 1 || !Number.isFinite(t.confidence) ||
          !Array.isArray(t.history) || typeof t.buildings !== 'object' ||
          typeof t.hydrants !== 'object' || typeof t.learned !== 'object') allSane = false;
      try { const g = new Game({ seed: 57 }); g.startShift(); g.frame(100, null); }
      catch { gameRan = false; }
    });
  }
  ok('F9 seven shapes of corrupt save all load without throwing', allLoaded);
  ok('F10 and every one of them yields a well-formed town', allSane);
  ok('F11 and a shift starts on top of every one of them', gameRan);

  // the save is small, and stays small
  clearSave();
  const worst = defaultTown();
  for (const b of BUILDINGS) worst.buildings[b.id] = { damage: 0.97, boardedShifts: 3, timesBurned: 99 };
  for (const h of HYDRANTS) worst.hydrants[h.id] = { damaged: true };
  worst.history = new Array(HISTORY_CAP).fill('Feed store gutted; two patients handled; three calls never worked.');
  le('F12 even a ruined town saves in under 4 kB', JSON.stringify(worst).length, 4096);

  let t = defaultTown();
  for (let i = 0; i < 40; i++) { t = advanceShift(t, `headline ${i}`); saveTown(t); t = loadTown(); }
  eq('F13 forty shifts of real save/load cycles keep counting', t.shiftNumber, 41);
  le('F14 and the history never grows past its cap', t.history.length, HISTORY_CAP);
  eq('F15 and nothing in the town has gone non-finite', nonFinite(t).length, 0);
  ok('F16 a valid town survives a migrate round trip unchanged',
    JSON.stringify(migrate(JSON.parse(JSON.stringify(t)))) === JSON.stringify(t));

  // light damage really does repair; the repair path is the half that works
  clearSave();
  let t2 = defaultTown();
  t2.buildings.b_feed = { damage: 0.4, boardedShifts: 0, timesBurned: 1 };
  for (let i = 0; i < 3; i++) { t2 = advanceShift(t2, `s${i}`); saveTown(t2); t2 = loadTown(); }
  eq('F17 a lightly damaged building is repaired and forgotten within three shifts',
    t2.buildings.b_feed, undefined);

  /* The boarding path was the other half, and it was a one-way door: boardedShifts was
   * re-set to repairShifts on every shift the damage was still high, and damage was never
   * allowed to fall while boarded, so a gutted building stayed gutted for ever. Walk one
   * all the way back to nothing and assert the countdown, not just the endpoint. */
  clearSave();
  let t3 = defaultTown();
  t3.buildings.b_feed = { damage: 0.9, boardedShifts: 0, timesBurned: 1 };
  const boardTrail = [];
  for (let i = 0; i < CONFIG.town.repairShifts + 2; i++) {
    t3 = advanceShift(t3, 'boarded ' + i); saveTown(t3); t3 = loadTown();
    boardTrail.push((t3.buildings.b_feed || { boardedShifts: 0 }).boardedShifts);
  }
  eq('F18 a gutted building boards up for exactly the shifts CONFIG allows',
    boardTrail[0], CONFIG.town.repairShifts);
  ok('F19 and the boards come down one shift at a time instead of resetting',
    boardTrail.slice(0, CONFIG.town.repairShifts)
      .every((n, i) => n === CONFIG.town.repairShifts - i), boardTrail.join(' -> '));
  eq('F20 and the building reopens whole once they are off', t3.buildings.b_feed, undefined);

  /* And the hydrant repair arm, which was unreachable through a real save because
   * sanitiseHydrants dropped shiftsDown on every load. Through saveTown/loadTown, not
   * advanceShift in isolation — the load is where it used to be lost. */
  clearSave();
  let t4 = defaultTown();
  t4.hydrants[HYDRANTS[0].id] = { damaged: true };
  t4 = advanceShift(t4, 'hydrant out'); saveTown(t4); t4 = loadTown();
  ok('F21 a struck hydrant is still out the shift after it is struck',
    !!(t4.hydrants[HYDRANTS[0].id] || {}).damaged);
  eq('F22 and the load did not throw its clock away',
    (t4.hydrants[HYDRANTS[0].id] || {}).shiftsDown, 1);
  t4 = advanceShift(t4, 'water board'); saveTown(t4); t4 = loadTown();
  eq('F23 and the water board gets to it the shift after that',
    t4.hydrants[HYDRANTS[0].id], undefined);
emit('F done');
}

/* ── G. the renderer reads, and keeps nothing ────────────────────────────── */
function sectionG() {
lines.push('--- G. the renderer keeps no scratch between frames ---');
  const S = window.__STES;
  if (!S || !S.renderer) { ok('G1 a page renderer is available to measure', false, 'no __STES.renderer'); emit('G done'); return; }
  clearSave();
  const g = new Game({ seed: 71 });
  g.startShift();
  for (let t = 0; t < 120000; t += STEP) g.frame(STEP, null);
  const r = S.renderer;
  S.camera.resize(r.canvas);

  const before = digest(g.state);
  r.render(g.state, 16.7);
  const first = { labels: r.labels.length, props: r.props.length, markers: r.markers.length };
  for (let i = 2; i <= 240; i++) r.render(g.state, i * 16.7);
  const last = { labels: r.labels.length, props: r.props.length, markers: r.markers.length };

  eq('G1 240 frames later the label list is the same length', last.labels, first.labels);
  eq('G2 and the prop list', last.props, first.props);
  eq('G3 and the marker list', last.markers, first.markers);
  gt('G4 and it was actually drawing something', first.props, 0);
  ok('G5 240 frames changed nothing about the town', digest(g.state) === before);
emit('G done');
}

/* ── H. the exposure rule, which is the whole point of a fire ────────────── */
function sectionH() {
lines.push('--- H. fire, exposure, and the town it eats ---');
  // the map still has a pair close enough for the rule to mean anything
  let bestGap = Infinity, pair = null;
  const gap = (a, b) => Math.hypot(
    Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))),
    Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))));
  for (const a of BUILDINGS) {
    for (const b of BUILDINGS) {
      if (a.id === b.id || a.kind === 'station' || b.kind === 'station' || b.kind === 'clinic') continue;
      const d = gap(a, b);
      if (d < bestGap) { bestGap = d; pair = [a, b]; }
    }
  }
  ok('H1 the town still has an exposure inside the jump distance',
    bestGap <= CONFIG.fire.jumpDistM, `closest pair is ${bestGap.toFixed(1)} m`);

  clearSave();
  const g = new Game({ seed: 91 });
  g.startShift();
  const s = g.state;
  const inc = {
    id: 'incF', templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
    place: pair[0].name, x: pair[0].door.x, y: pair[0].door.y, buildingId: pair[0].id, roadId: null,
    priority: 'high', report: '', createdMs: 0, ageMs: 0, danger: 0, peakDanger: 0,
    status: 'active', hazardIds: [], victimIds: [], consequences: [], capabilities: [],
    updates: [], lastUpdateText: null, resolvedMs: null, outcomeNote: null, everWorked: true,
  };
  s.incidents.push(inc);
  const fire = createFire(pair[0].id, { seedCells: 3, heat: 1.0, from: 'centre' });
  addHazard(s, inc, fire);
  for (let t = 0; t < 300000 && s.mode === MODES.PLAYING; t += STEP) {
    g.frame(STEP, null);
    inc.danger = 0;   // somebody is working it, so it is never declared lost
  }
  const jumped = s.hazards.filter((h) => h.kind === 'fire' && h.incidentId === inc.id &&
    h.buildingId !== pair[0].id);
  gt('H2 an unfought fire takes the exposure next door while its call is open', jumped.length, 0);
  ok('H3 and the building it started in is a total loss', fireDamageFraction(fire) > 0.6,
    `${(fireDamageFraction(fire) * 100).toFixed(0)}%`);

  const perBuilding = new Map();
  for (const h of s.hazards) {
    if (h.kind !== 'fire') continue;
    perBuilding.set(h.buildingId, (perBuilding.get(h.buildingId) || 0) + 1);
  }
  eq('H4 no building ever ends up with two fire hazards on it',
    Math.max(...perBuilding.values()), 1);
  eq('H5 five minutes of a spreading fire leaves nothing non-finite', nonFinite(s).length, 0);
  ok('H6 the town wrote the damage down whether or not anyone attended',
    (s.town.buildings[pair[0].id] || {}).damage > 0.6);

  /* The other arm of the same rule, and the one that was silently dead. H2 keeps the call
   * open by hand; this one lets it go lost, which is what actually happens to a fire
   * nobody attends. The jump used to be gated on isOpen(host), so the marquee system
   * switched itself off at exactly the moment the town was worst off. */
  clearSave();
  const g2 = new Game({ seed: 92 });
  g2.startShift();
  const s2 = g2.state;
  const inc2 = { ...inc, id: 'incF2', hazardIds: [], victimIds: [], consequences: [], updates: [] };
  s2.incidents.push(inc2);
  addHazard(s2, inc2, createFire(pair[0].id, { seedCells: 3, heat: 1.0, from: 'centre' }));
  for (let t = 0; t < 300000 && s2.mode === MODES.PLAYING; t += STEP) g2.frame(STEP, null);
  ok('H7 a structure fire nobody turns up to does lose its call', inc2.status !== 'active',
    `status ${inc2.status}, danger ${inc2.danger.toFixed(2)}`);
  gt('H8 and the exposure next door catches anyway, with nobody counting the call',
    s2.hazards.filter((h) => h.kind === 'fire' && h.buildingId !== pair[0].id).length, 0);
  ok('H9 and the town wrote down what it cost after the call was written off',
    (s2.town.buildings[pair[0].id] || {}).damage > 0.6,
    `${((s2.town.buildings[pair[0].id] || {}).damage || 0).toFixed(2)}`);

  // and the whole soak from section A is still a loadable town
  const town = loadTown();
  ok('H10 the town still loads clean after everything above',
    town.version === 1 && Number.isFinite(town.confidence) &&
    town.confidence >= 0 && town.confidence <= 1);
  eq('H11 with nothing non-finite in it', nonFinite(town).length, 0);
  if (soakGame) eq('H12 and the soaked Game is still free of NaN', nonFinite(soakGame.state).length, 0);
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD();
  sectionE(); sectionF(); sectionG(); sectionH();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
