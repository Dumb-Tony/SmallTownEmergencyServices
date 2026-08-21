/* Milestone 9 — the audio layer, completed and held down.
 *
 * m0 section J proved the mix was a pure function and that a fire two hundred metres
 * away is quieter than one you are standing in. It could not prove the two things that
 * actually go wrong with an audio layer built alongside a growing simulation:
 *
 *   1. THE VOCABULARY DRIFTS. Twelve events were added to src/core/eventBus.js after
 *      the audio milestone shipped — the whole medical chain among them. J19 asserts
 *      that every CUE names a real event, which is the easy direction; the direction
 *      that rots is the other one, an event nobody told the audio layer about. This
 *      suite asserts BOTH, and makes "deliberately silent" a thing you have to write
 *      down (audio.js SILENT_EVENTS) rather than something you forget.
 *
 *   2. THE RATE LIMIT WAS BROKEN ACROSS SHIFTS. `lastCueAt` is stamped in simulation
 *      time, and a new shift restarts simulation time at zero while the table still
 *      holds stamps from the last one. A stamp ten minutes in the FUTURE reads as "the
 *      gap has not passed", so a cue that last fired late in shift one stayed silent
 *      for that much of shift two. Section C is the assertion that found it.
 *
 * The house rule underneath all of it — audio reads state and owns none of it — is
 * asserted at full scale in section B: a whole bot shift played with the audio layer
 * running every frame, byte-identical to the same shift played without it.
 *
 * Emits after every section: a suite that throws half way must still report how far it
 * got.
 */

import { CONFIG } from '../src/config.js';
import { EVENTS } from '../src/core/eventBus.js';
import { Game } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { TOOL_DEFS } from '../src/data/equipment.js';
import { createFire, createPower, createWreck } from '../src/sim/hazards.js';
import { createVictim } from '../src/sim/victims.js';
import {
  GameAudio, mixFor, atten, makeNoise,
  CUES, SILENT_EVENTS, RANGE, WORK_MS, cueFor, cueVolume,
} from '../src/audio/audio.js';
import { CrewBot } from './_crewbot.js';

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
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const STEP = CONFIG.sim.stepMs;

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

/** A fresh town at t=0: dispatch's first call is 18 s away, so there is nothing
 *  burning, nobody hurt and no hazard in the world until a test puts one there. */
function quietTown(seed) {
  clearSave();
  const g = new Game({ seed, seedLabel: 'm9' });
  g.startShift();
  return g;
}

/** Put a tool from the station into a responder's hands, the way interaction.js does. */
function hand(state, r, defId) {
  const t = state.tools.find((x) => x.defId === defId);
  t.carrier = r.id; r.toolId = t.id;
  return t;
}

/* ── A. the vocabulary: every event decided, one way or the other ────────── */
function sectionA() {
lines.push('--- A. the vocabulary (an event nobody told the audio layer about) ---');
{
  const cues = Object.keys(CUES);
  const events = Object.keys(EVENTS);
  const silent = SILENT_EVENTS.slice();

  lines.push(`    ${events.length} events · ${cues.length} cued · ${silent.length} deliberately silent`);
  gte('A1 the cue vocabulary covers most of the event vocabulary', cues.length, 39);
  ok('A2 every cue names an event the simulation actually emits',
    cues.every((n) => EVENTS[n] === n), cues.filter((n) => EVENTS[n] !== n).join());

  // The direction J19 cannot see: an event added to the simulation that audio has
  // never heard of. It must be given a cue, or written down as deliberately silent.
  const undecided = events.filter((n) => !CUES[n] && !silent.includes(n));
  ok('A3 every event is either cued or explicitly declared silent', undecided.length === 0,
    `undecided: ${undecided.join(', ')}`);

  // The twelve the medical chain and the consequence work added after audio shipped.
  const since = ['PATIENT_LOADED', 'PATIENT_DELIVERED', 'PATIENT_EXTRICATED', 'ROAD_CLEARED',
    'LINE_DE_ENERGISED', 'GAS_SHUT_OFF', 'HYDRANT_CHARGED', 'STRUCTURE_LOST',
    'CALL_UPDATED', 'PRIORITY_RAISED', 'INCIDENT_CONTROLLED', 'INCIDENT_LOST'];
  ok('A4 everything the medical and consequence work added is audible',
    since.every((n) => !!CUES[n]), since.filter((n) => !CUES[n]).join());

  // The five this milestone found with no row at all.
  const added = ['SIM_RESET', 'SIREN_TOGGLED', 'PATIENT_RELEASED', 'NO_TARGET', 'OCCUPANT_EVACUATING'];
  ok('A5 and the five that still had none',
    added.every((n) => !!CUES[n]), added.filter((n) => !CUES[n]).join());

  ok('A6 nothing is both cued and declared silent', !silent.some((n) => !!CUES[n]));
  ok('A7 the silent list names only real events',
    silent.every((n) => EVENTS[n] === n), silent.filter((n) => EVENTS[n] !== n).join());
}
{
  const rows = Object.entries(CUES);
  const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
  ok('A8 every cue is playable (bus, gap, and at least one partial)',
    rows.every(([, c]) => ['world', 'foley', 'ui'].includes(c.bus) &&
      c.minGapMs >= 0 && c.parts.length > 0 &&
      c.parts.every((p) => p.length >= 5 && p[2] > 0 && p[4] > 0)),
    rows.filter(([, c]) => !['world', 'foley', 'ui'].includes(c.bus)).map(([n]) => n).join());
  ok('A9 every partial names a real oscillator waveform',
    rows.every(([, c]) => c.parts.every((p) => WAVES.includes(p[3]))),
    rows.filter(([, c]) => c.parts.some((p) => !WAVES.includes(p[3]))).map(([n]) => n).join());

  // A partial below ~40 Hz is felt on a desk and gone on a phone; above 6 kHz it is
  // an ice-pick. tone() ramps f0 -> f1, so both ends have to be in the band.
  const badBand = rows.filter(([, c]) =>
    c.parts.some((p) => Math.min(p[0], p[1]) < 40 || Math.max(p[0], p[1]) > 6000));
  ok('A10 every partial sits in a band a laptop can actually reproduce',
    badBand.length === 0, badBand.map(([n]) => n).join());

  // Two events that sound identical are one event as far as the player is concerned.
  const recipes = rows.map(([, c]) => JSON.stringify(c.parts));
  eq('A11 no two events share the same recipe', new Set(recipes).size, recipes.length);

  // 120 ms is eight a second, which is a rattle rather than a rhythm. TOOL_TAKEN and
  // TOOL_DROPPED sit there deliberately: they follow a key press, not a clock.
  const tooFast = rows.filter(([, c]) => c.minGapMs < 120);
  ok('A12 nothing may fire faster than eight times a second', tooFast.length === 0,
    tooFast.map(([n, c]) => `${n} ${c.minGapMs}ms`).join());
}
emit(null);
}

/* ── B. a whole bot shift, with the layer running every frame ────────────── */
const SHIFT_SEED = 9109;

/** One whole shift through the real input path, optionally with the audio layer wired
 *  exactly as src/main.js wires it: onAny -> onEvent, and a mix every frame. */
function playShift(withAudio) {
  clearSave();
  const g = new Game({ seed: SHIFT_SEED, seedLabel: 'm9shift' });
  const stream = [];
  const audio = withAudio ? new GameAudio() : null;
  let threw = null;
  g.bus.onAny((evt) => {
    stream.push({ type: evt.type, ms: evt.simTimeMs });
    if (!audio) return;
    try {
      audio.onEvent(evt.type, evt, evt.simTimeMs);
      audio.takeCue(evt.type, evt.simTimeMs);   // the decision half runs un-armed
    } catch (e) { threw = threw || e; }
  });
  g.startShift();
  const bot = new CrewBot(g);
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    bot.think();
    g.frame(STEP, bot.input);
    if (audio) {
      try { mixFor(g.state); audio.update(g.state, STEP); audio.hush(); } catch (e) { threw = threw || e; }
    }
    if (g.state.mode !== 'playing') break;
  }
  return { g, stream, threw };
}

/** Everything about the town that a sound could conceivably have moved. */
function digest(s) {
  return JSON.stringify({
    t: s.simTimeMs, mode: s.mode,
    rs: s.responders.map((r) => [r.id, r.x, r.y, r.facing, r.inVehicleId, r.toolId,
      r.draggingVictimId, r.useProgressMs, r.stunMs, r.soot]),
    ap: s.apparatus.map((a) => [a.id, a.x, a.y, a.angle, a.speed, a.siren, a.damage,
      a.waterL, a.hydrantId, a.patientId, a.odometerM]),
    tl: s.tools.map((t) => [t.id, t.carrier, t.x, t.y, t.flowing, t.chargeL ?? null]),
    vc: s.victims.map((v) => [v.id, v.x, v.y, v.condition, v.lost, v.delivered,
      v.trappedBy, v.draggedBy, v.inApparatusId]),
    hz: s.hazards.map((h) => [h.id, h.kind, h.resolved, h.burningCount ?? null, h.ppm ?? null,
      h.live ?? null, h.cut ?? null, h.burning ?? null,
      h.cells ? h.cells.reduce((n, c) => n + c.heat + c.wet, 0) : null]),
    in: s.incidents.map((i) => [i.id, i.status, i.danger, i.priority, i.ageMs]),
    out: s.outcome, tel: s.telemetry, town: s.town,
  });
}

function sectionB() {
lines.push('--- B. a whole bot shift (audio reads state and owns none of it) ---');
{
  const loud = playShift(true);
  const quiet = playShift(false);
  const s = loud.g.state;

  const types = new Set(loud.stream.map((e) => e.type));
  lines.push(`    ${Math.round(s.simTimeMs / 1000)} s · ${loud.stream.length} events · ` +
    `${types.size} distinct types · ${s.incidents.length} calls · ${s.outcome.controlled} controlled`);
  lines.push(`    heard: ${[...types].sort().join(', ')}`);

  /* ⚠ A RAW EVENT COUNT MEASURES THRASH AS WELL AS PLAY. The threshold here was 50, and
     it started failing at 48 the moment m17 stopped the bot climbing in and out of the
     same cab — fewer ENTERED_APPARATUS/EXITED_APPARATUS pairs is the FIX showing up, not
     a quieter town. What this section needs is a stream with breadth and substance in it,
     so assert those instead and keep a floor under the volume. */
  gt('B1 the shift produced a real event stream', loud.stream.length, 30);
  gt('B1b with real variety in it, not one thing over and over', types.size, 10);
  ok('B1c including at least one call being received and one being resolved',
    types.has('CALL_RECEIVED') && (types.has('INCIDENT_CONTROLLED') || types.has('INCIDENT_LOST')),
    [...types].sort().join(','));
  gt('B2 and worked several calls', s.incidents.length, 1);
  ok('B3 the audio layer never threw over a whole shift', !loud.threw,
    loud.threw && loud.threw.message);

  // The live version of A3: not the vocabulary as declared, but the events a real
  // shift really emitted. This is the assertion that catches a new event at the
  // moment it first fires, whatever anybody remembered to write down.
  const unheard = [...types].filter((t) => !CUES[t] && !SILENT_EVENTS.includes(t));
  ok('B4 every event a real shift emitted is cued or deliberately silent',
    unheard.length === 0, unheard.join(', '));

  // THE house rule. Same seed, same bot, one shift with the whole layer running every
  // frame and one with none of it: the towns must be identical to the character.
  const a = digest(loud.g.state), b = digest(quiet.g.state);
  ok('B5 a shift played with audio is byte-identical to one played without',
    a === b, `${a.length} vs ${b.length} chars`);
  gt('B6 and it was not an empty shift being compared', a.length, 2000);

  /* Replay the real stream through a fresh rate limiter and count what would actually
   * have been heard. A cue that fires constantly is worse than no cue at all, so the
   * numbers matter more than the rows. */
  const play = new GameAudio();
  const played = [];
  let suppressed = 0;
  for (const e of loud.stream) {
    if (!cueFor(e.type)) continue;                  // no cue at all is not a suppression
    if (play.takeCue(e.type, e.ms)) played.push(e); else suppressed++;
  }
  const perType = {};
  for (const e of played) perType[e.type] = (perType[e.type] || 0) + 1;
  const busiest = Object.entries(perType).sort((x, y) => y[1] - x[1])[0] || ['none', 0];
  const mins = Math.max(1, s.simTimeMs / 60000);
  lines.push(`    ${played.length} cues heard in ${mins.toFixed(1)} min ` +
    `(${(played.length / mins).toFixed(1)}/min) · ${suppressed} suppressed · ` +
    `busiest ${busiest[0]} x${busiest[1]}`);

  gt('B7 the shift was audible at all', played.length, 10);
  ok('B8 and no cue rattles: the busiest fires under 30 times a minute',
    busiest[1] / mins < 30, `${busiest[0]} ${(busiest[1] / mins).toFixed(1)}/min`);
  ok('B9 the town averages under two sounds a second', played.length / mins < 120,
    `${(played.length / mins).toFixed(1)}/min`);

  /* MEASURED, and the point of the whole table: over a whole shift the limiter never
   * engaged once — 0 suppressions in 56 events across 600 s. Every row in CUES is a
   * per-shift moment rather than a per-second one, and the gaps are a backstop for a
   * player mashing a key, not the thing keeping the town quiet. A cue wired to
   * something that fires every frame would suppress thousands of times and land here. */
  ok('B10 the vocabulary is per-shift moments, not per-second noise',
    suppressed < Math.max(4, played.length * 0.1), `${suppressed} suppressed of ${played.length + suppressed}`);

  // And it suppressed them correctly: nothing played twice inside its own gap.
  const lastAt = {};
  const violations = [];
  for (const e of played) {
    if (lastAt[e.type] != null && e.ms - lastAt[e.type] < CUES[e.type].minGapMs) violations.push(e.type);
    lastAt[e.type] = e.ms;
  }
  ok('B11 and nothing played twice inside its own gap', violations.length === 0, violations.join());
}
emit(null);
}

/* ── C. one-shots: lookup, rate limit, and the shift boundary ────────────── */
function sectionC() {
lines.push('--- C. one-shots (the bug: a new shift restarts the clock) ---');
{
  ok('C1 a known event yields its recipe', cueFor('CALL_RECEIVED') === CUES.CALL_RECEIVED);
  eq('C2 an unknown event yields nothing', cueFor('NOT_A_REAL_EVENT'), null);

  /* CUES is a plain object, so CUES.constructor is a function inherited from
   * Object.prototype. Read as a recipe it has no `parts`, and the for..of over it
   * threw — out of audio.update's frame, past main.js's requestAnimationFrame on the
   * last line of frame(), which is a frozen game rather than a missing sound. */
  const inherited = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
  ok('C3 an inherited Object.prototype key is not a cue',
    inherited.every((n) => cueFor(n) === null),
    inherited.filter((n) => cueFor(n) !== null).join());

  const a = new GameAudio();
  let threw = null;
  try {
    for (const n of inherited) a.onEvent(n, {}, 0);
    a.onEvent('NOT_A_REAL_EVENT', {}, 0);
    a.takeCue('constructor', 0);
    a.update(null, 16.7);
    a.hush();
  } catch (e) { threw = e; }
  ok('C4 and none of them throws', !threw, threw && threw.message);
  eq('C5 an un-armed one-shot reports that it did not play', a.onEvent('CALL_RECEIVED', {}, 0), false);
}
{
  const a = new GameAudio();
  ok('C6 the first firing is allowed', !!a.takeCue('CALL_RECEIVED', 10000));
  eq('C7 a repeat inside the gap is refused', a.takeCue('CALL_RECEIVED', 10100), null);
  ok('C8 and allowed again once the gap has passed', !!a.takeCue('CALL_RECEIVED', 10500));
  // Rate limiting is per cue: a fire extending and a call arriving in the same frame
  // are two different pieces of news.
  ok('C9 the gap is per cue, not one gap across the whole mix', !!a.takeCue('FIRE_EXTENDED', 10500));

  /* The bug. Shift one ends at 540 s with a cue freshly stamped; shift two starts the
   * clock again at zero, and 1.2 s is 538.8 s BEFORE the stamp. */
  const b = new GameAudio();
  ok('C10 a cue fires late in shift one', !!b.takeCue('CALL_RECEIVED', 540000));
  ok('C11 and fires again early in shift two, not 540 s later',
    !!b.takeCue('CALL_RECEIVED', 1200));
  eq('C12 with the gap honoured normally from there', b.takeCue('CALL_RECEIVED', 1300), null);
  ok('C13 and running again once it has passed', !!b.takeCue('CALL_RECEIVED', 1500));
}
{
  // A kerb and a shop front are the same event with very different numbers behind it.
  const kerb = cueVolume('APPARATUS_STRUCK', { impact: CONFIG.drive.collisionFreeSpeed });
  const shop = cueVolume('APPARATUS_STRUCK', { impact: 14 });
  lines.push(`    collision gain: 4 m/s -> ${kerb.toFixed(2)} · 14 m/s -> ${shop.toFixed(2)}`);
  gt('C14 a collision at speed is louder than a nudge', shop, kerb);
  near('C15 a nudge into a kerb is well under full scale', kerb, 0.64, 0.01);
  eq('C16 and the ram is clamped rather than clipping the bus',
    cueVolume('APPARATUS_STRUCK', { impact: 90 }), 1.4);
  eq('C17 a collision with no impact reported still makes a sound',
    cueVolume('APPARATUS_STRUCK', {}), 0.35);
  eq('C18 every other cue plays at the gain its recipe asks for',
    cueVolume('CALL_RECEIVED', { impact: 99 }), 1);
}
emit(null);
}

/* ── D. the mix: the tool that works for nine seconds ────────────────────── */
function sectionD() {
lines.push('--- D. the work voice (9 s of extrication used to be 9 s of silence) ---');
{
  const g = quietTown(701);
  const s = g.state;
  const r = s.player;

  eq('D1 a quiet town has no tool working', mixFor(s).work.gain, 0);

  hand(s, r, 'spreaders');
  eq('D2 spreaders in your hands but not in the cut are silent', mixFor(s).work.gain, 0);

  r.useProgressMs = 1;
  const start = mixFor(s).work;
  eq('D3 leaning on them starts the pack', start.gain, 1);

  r.useProgressMs = CONFIG.medical.extricateMs * 0.9;
  const nearlyThere = mixFor(s).work;
  lines.push(`    extrication pitch: ${start.pitch.toFixed(3)} at 0 s -> ` +
    `${nearlyThere.pitch.toFixed(3)} at ${(CONFIG.medical.extricateMs * 0.9 / 1000).toFixed(1)} s`);
  gt('D4 and the note climbs as the action gets there', nearlyThere.pitch, start.pitch);

  r.useProgressMs = CONFIG.medical.extricateMs * 4;
  eq('D5 the climb stops at the end of the action rather than running away',
    mixFor(s).work.pitch, 1.6);

  // Two crew on two casualties: the one further along is the one you hear.
  const g2 = quietTown(702);
  const s2 = g2.state;
  s2.responders.push({ ...s2.player, id: 'r2', toolId: null });
  hand(s2, s2.responders[0], 'spreaders');
  const second = s2.tools.filter((t) => t.defId === 'spreaders')[1] ||
    { defId: 'spreaders', carrier: null };
  second.carrier = 'r2'; s2.tools.push(second);
  s2.responders[0].useProgressMs = 500;
  s2.responders[1].useProgressMs = CONFIG.medical.extricateMs * 0.8;
  gt('D6 with two crew working, the one further along is the one you hear',
    mixFor(s2).work.pitch, 1.4);
}
{
  const g = quietTown(703);
  const s = g.state;
  const r = s.player;

  hand(s, r, 'medkit');
  r.useProgressMs = CONFIG.medical.treatMs * 0.5;
  eq('D7 a dressing has no motor', mixFor(s).work.gain, 0);

  const kit = s.tools.find((t) => t.carrier === r.id);
  kit.carrier = null; r.toolId = null;
  hand(s, r, 'chainsaw');
  const saw = mixFor(s);
  eq('D8 the chainsaw uses its own voice, not the hydraulic pack', saw.work.gain, 0);
  eq('D9 and it is in the cut', saw.saw, 1);

  // Every hold-mode tool has to be accounted for: it groans, it saws, or somebody has
  // decided it is silent. A new one added to equipment.js fails this.
  const holds = Object.values(TOOL_DEFS).filter((d) => d.mode === 'hold').map((d) => d.id);
  const voiced = holds.filter((id) => WORK_MS[id] || id === 'chainsaw' || id === 'medkit');
  lines.push(`    hold-mode tools: ${holds.join(', ')}`);
  eq('D10 every hold-mode tool is accounted for', voiced.length, holds.length);
  gte('D11 and the hydraulic pack covers more than one of them', Object.keys(WORK_MS).length, 3);
}
emit(null);
}

/* ── E. the mix: a live wire you can hear before you walk into it ────────── */
function sectionE() {
lines.push('--- E. the arc (water on the ground carries the fault, and the sound) ---');
{
  const g = quietTown(704);
  const s = g.state;
  const pwr = createPower(200, 150, 'pole1');
  s.hazards.push(pwr);

  const at = (d) => { s.player.x = pwr.x + d; s.player.y = pwr.y; return mixFor(s).arc; };

  const close = at(2), far = at(20);
  lines.push(`    dry line: ${close.toFixed(3)} at 2 m · ${far.toFixed(3)} at 20 m · ` +
    `zone ${pwr.radiusM.toFixed(1)} m`);
  gt('E1 a downed line crackles', close, 0.5);
  ok('E2 and it is quieter from across the road', far < close && far > 0, `${far.toFixed(3)}`);
  eq('E3 and inaudible from the far side of town', at(400), 0);

  const dryEdge = at(pwr.radiusM);
  gt('E4 you hear it before you are close enough to be thrown by it', at(RANGE.arc * 0.5), 0);

  // Water on the ground grows the live zone. The warning has to grow with it, or the
  // one hazard that punishes the wrong tactic sounds exactly the same either way.
  pwr.wet = 1;
  pwr.radiusM = CONFIG.power.liveRadiusM * CONFIG.power.wetSpreadMul;
  const wetAt10 = at(10), dryAt10 = (() => {
    const dry = createPower(200, 150, 'pole1');
    const s2 = { responders: [{ id: 'r1', x: 210, y: 150 }], apparatus: [], tools: [], hazards: [dry] };
    return mixFor(s2).arc;
  })();
  lines.push(`    at 10 m: dry ${dryAt10.toFixed(3)} · wet ${wetAt10.toFixed(3)} ` +
    `(zone ${CONFIG.power.liveRadiusM} m -> ${pwr.radiusM.toFixed(1)} m)`);
  gt('E5 a wet line is louder at the same distance than a dry one', wetAt10, dryAt10);

  const wetEdge = at(pwr.radiusM);
  near('E6 but the EDGE of the zone sounds the same however far the water carried it',
    wetEdge, dryEdge, 1e-6);

  pwr.live = false;
  eq('E7 a line that has been killed at the pole is silent', at(2), 0);
}
emit(null);
}

/* ── F. safe on a state it does not understand ───────────────────────────── */
function sectionF() {
lines.push('--- F. safety (a throw here is a frozen game, not a missing sound) ---');
{
  let threw = null, mix = null;
  try { mix = mixFor({}); } catch (e) { threw = e; }
  ok('F1 a state with nobody in it is silent rather than fatal', !threw, threw && threw.message);
  ok('F2 and silent means silent', mix && mix.siren === 0 && mix.fire === 0 &&
    mix.arc === 0 && mix.engine.gain === 0 && mix.work.gain === 0 && mix.gasRate === 0);

  threw = null;
  try { mixFor({ responders: [{ id: 'r1', x: 10, y: 10, useProgressMs: 0 }] }); } catch (e) { threw = e; }
  ok('F3 a half-built state does not throw', !threw, threw && threw.message);

  /* An apparatus this build has no def for is reachable input: a client rebuilds
   * state.apparatus straight out of a peer's snapshot and rooms are not private. */
  const ghost = {
    responders: [{ id: 'r1', x: 0, y: 0, inVehicleId: 'ghost', useProgressMs: 0 }],
    apparatus: [{ id: 'ghost', defId: 'ghost', x: 0, y: 0, speed: 12, siren: true }],
    apparatusDefs: {}, tools: [], hazards: [],
  };
  threw = null; mix = null;
  try { mix = mixFor(ghost); } catch (e) { threw = e; }
  ok('F4 an apparatus this build has no def for does not throw', !threw, threw && threw.message);
  eq('F5 it just has no engine note', mix && mix.engine.gain, 0);
  eq('F6 and the rest of the mix still reads', mix && mix.siren, 1);
}
{
  const a = new GameAudio();
  ok('F7 audio starts un-armed', !a.armed);
  eq('F8 an un-armed update mixes nothing', a.update({ responders: [] }, 16.7), null);
  let threw = null;
  try { a.hush(); a.update(null, 16.7); a.setMuted(true); a.setMuted(false); } catch (e) { threw = e; }
  ok('F9 hush, mute and update are all safe before arming', !threw, threw && threw.message);
}
{
  // The layer driven hard over a state that is genuinely changing, with hazards of
  // every kind in it at once, still writes nothing back.
  const g = quietTown(705);
  const s = g.state;
  s.hazards.push(createFire('pizza', { seedCells: 5, heat: 1.1, from: 'centre' }));
  s.hazards.push(createPower(150, 150, 'pole1'));
  s.hazards.push(createWreck(160, 150, 0.4, { fuelLeak: 0.4, burning: true }));
  s.victims.push(createVictim({ incidentId: null, x: 152, y: 151, severity: 'critical' }));
  hand(s, s.player, 'gasmeter');

  const before = digest(s);
  const a = new GameAudio();
  let threw = null;
  try {
    for (let i = 0; i < 120; i++) {
      mixFor(s); a.update(s, STEP);
      a.onEvent('GAS_FLASH', { x: 1, y: 2 }, i * STEP);
      a.takeCue('FIRE_EXTENDED', i * STEP);
    }
  } catch (e) { threw = e; }
  ok('F10 two seconds of mixing over every hazard kind at once does not throw',
    !threw, threw && threw.message);
  ok('F11 and changes nothing about the town', digest(s) === before);
}
emit(null);
}

/* ── G. the noise bed is reproducible ────────────────────────────────────── */
function sectionG() {
lines.push('--- G. the noise bed (a repeat playtest has to SOUND the same) ---');
{
  // makeNoise needs a sample rate and somewhere to put the samples; it needs nothing
  // else about a real context, which is how this is assertable on a headless box.
  const fakeCtx = (sampleRate) => ({
    sampleRate,
    createBuffer: (ch, n) => { const d = new Float32Array(n); return { getChannelData: () => d, length: n }; },
  });
  const a = makeNoise(fakeCtx(8000)).getChannelData(0);
  const b = makeNoise(fakeCtx(8000)).getChannelData(0);
  const c = makeNoise(fakeCtx(8000), 12345).getChannelData(0);

  eq('G1 the bed is two seconds long at the context sample rate', a.length, 16000);
  ok('G2 two builds of the bed are identical to the sample', a.every((v, i) => v === b[i]));
  ok('G3 a different seed is a different bed', !a.every((v, i) => v === c[i]));

  let peak = 0, finite = true;
  for (const v of a) { if (!Number.isFinite(v)) finite = false; peak = Math.max(peak, Math.abs(v)); }
  lines.push(`    bed peak ${peak.toFixed(3)}`);
  ok('G4 every sample is a real number', finite);
  ok('G5 and the bed does not clip on its own before anything is mixed into it',
    peak > 0.2 && peak < 1.6, `peak ${peak.toFixed(3)}`);
}
emit(null);
}

/* ── H. source discipline ────────────────────────────────────────────────── */
async function sectionH() {
lines.push('--- H. source discipline (asserted against the file, not remembered) ---');
{
  const url = new URL('../src/audio/audio.js', import.meta.url);
  const src = await (await fetch(url)).text();
  gt('H1 the audio source was readable', src.length, 1000);

  /* src/core/rng.js states the invariant and claims a test enforces it. No suite ever
   * did. The fire bed was built from an unseeded stream, so two runs of one seed did
   * not sound the same — implementation rule 1 says a playtest can be repeated. */
  ok('H2 the layer draws from no unseeded random source', !/Math\s*\.\s*random/.test(src));
  ok('H3 nor from the wall clock', !/Date\s*\.\s*now|performance\s*\.\s*now/.test(src));

  // Rule 1 of the file: it reads state and never writes it.
  const writes = src.match(/\bstate\s*\.\s*[A-Za-z_$][\w$]*\s*(?:=[^=]|\+\+|--|\+=|-=)/g) || [];
  ok('H4 nothing in the layer assigns into the simulation state', writes.length === 0,
    writes.join(' | '));

  // It may read the simulation; it may not import anything that changes it.
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  const mutators = ['../game.js', '../sim/interaction.js', '../sim/movement.js',
    '../sim/victims.js', '../sim/incidentSim.js', '../sim/dispatch.js'];
  lines.push(`    imports: ${imports.join(', ')}`);
  ok('H5 and imports nothing that can', !imports.some((i) => mutators.includes(i)),
    imports.filter((i) => mutators.includes(i)).join());

  // Audio is not a UI layer. The renderer and the HUD own the DOM; this owns nodes.
  ok('H6 the layer touches no DOM', !/\bdocument\s*\.|\bwindow\s*\./.test(src));
}
emit(null);
}

/* ── I. armed: the plumbing, with a real graph behind it ─────────────────── */
function sectionI() {
lines.push('--- I. armed (headless Chrome gives out a context; a browser will not) ---');
{
  /* Everything above this line runs in the un-armed state a real browser is in before
   * the first gesture. This section is the other half: it is the only place the new
   * voice and the new rows are proved to reach an oscillator at all. The harness runs
   * with --autoplay-policy=no-user-gesture-required, so a context is available here. */
  const a = new GameAudio();
  const ctx = a.arm();
  ok('I1 the harness gave the layer a real AudioContext', !!ctx && a.armed);
  if (!ctx) { emit(null); return; }

  const voices = ['siren', 'fire', 'water', 'engine', 'saw', 'arc', 'work'];
  ok('I2 every continuous voice exists', voices.every((v) => !!a.loops[v]),
    voices.filter((v) => !a.loops[v]).join());
  ok('I3 and every one of them starts silent',
    Object.values(a.loops).every((l) => l.gain.gain.value === 0));

  // The five rows this milestone added, through the real graph.
  const added = ['SIM_RESET', 'SIREN_TOGGLED', 'PATIENT_RELEASED', 'NO_TARGET', 'OCCUPANT_EVACUATING'];
  const played = added.filter((n) => a.onEvent(n, {}, 5000) === true);
  ok('I4 all five new cues play when armed', played.length === added.length,
    added.filter((n) => !played.includes(n)).join());
  ok('I5 and an immediate repeat of each is refused',
    added.every((n) => a.onEvent(n, {}, 5010) === false));

  /* setTargetAtTime only moves .value as the context clock runs, which in a headless
   * box it may not — so spy on the call instead of reading the parameter back. An
   * assertion on `typeof setTargetAtTime === 'function'` cannot fail and proves nothing. */
  const spyOn = (param) => {
    const seen = [];
    const real = param.setTargetAtTime.bind(param);
    param.setTargetAtTime = (v, t, c) => { seen.push(v); return real(v, t, c); };
    return seen;
  };
  const workGain = spyOn(a.loops.work.gain.gain);   // the AudioParam, not the node
  const workFreq = spyOn(a.loops.work.osc.frequency);

  const g = quietTown(706);
  const s = g.state;
  hand(s, s.player, 'spreaders');
  s.player.useProgressMs = CONFIG.medical.extricateMs * 0.9;
  a.update(s, STEP);
  ok('I6 a tool under load drives the hydraulic voice', workGain.some((v) => v > 0),
    `targets ${workGain.join()}`);
  ok('I7 and pushes the note up with it', workFreq.some((v) => v > 96),
    `targets ${workFreq.map((v) => Math.round(v)).join()}`);

  s.player.useProgressMs = 0;
  a.update(s, STEP);
  eq('I8 letting go takes it back to silence', workGain[workGain.length - 1], 0);

  a.setMuted(true);
  eq('I9 mute pulls the master down', a.master.gain.value, 0);
  a.setMuted(false);
  eq('I10 and unmute puts it back', a.master.gain.value, 1);

  // Start it up again so hush has something to silence — hushing an already-silent
  // graph proves nothing.
  s.player.useProgressMs = CONFIG.medical.extricateMs * 0.5;
  a.update(s, STEP);
  gt('I11 the voice is running again', workGain[workGain.length - 1], 0);
  let threw = null;
  try { a.hush(); } catch (e) { threw = e; }
  ok('I12 hush does not throw with a live graph', !threw, threw && threw.message);
  eq('I13 and it silences a voice that was running', workGain[workGain.length - 1], 0);
}
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
(async function main() {
  try {
    sectionA(); sectionC(); sectionD(); sectionE(); sectionF(); sectionG();
    await sectionH();
    sectionI();
    /* B plays two whole shifts and is therefore the section most likely to run the
     * harness out of virtual time. Every section emits, so a run that dies in B would
     * otherwise leave an ALL-PASS tail from H standing as the final word. */
    emit('INCOMPLETE  section B (two whole bot shifts) did not finish');
    sectionB();   // last: it plays two whole shifts
  } catch (err) {
    fails++;
    lines.push(`FAIL  suite threw: ${err && err.message}`);
    lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
    emit(`FAILURES  ${fails} of ${passes + fails}`);
  }
})();
