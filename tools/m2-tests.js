/* Playability suite — can anybody actually play this?
 *
 * m0 proves the pieces behave and m1 proves the systems behave, but both drive the
 * simulation through function calls. Neither answers the question the GDD's phase
 * gates actually ask, which is whether a person pressing keys can get anything done.
 *
 * So: tools/_crewbot.js plays whole shifts through the real input path — the same
 * moveAxis, the same wasPressed edges, the same numbered slot list the HUD renders —
 * and this suite asserts on what it managed. The headline assertion is the thesis of
 * the entire game: a crew that turns up must beat a crew that does not.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, toggleCoop } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import { openIncidents } from '../src/sim/incidentSim.js';
import { stepInteraction, toolsInReachOf } from '../src/sim/interaction.js';
import { victimHandled, createVictim } from '../src/sim/victims.js';
import { CrewBot, runBotShift, makeBotInput, mergeBotInputs } from './_crewbot.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
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

function freshGame(seed, label) {
  clearSave();
  const g = new Game({ seed, seedLabel: label });
  g.startShift();
  g.town = defaultTown();
  g.state.town = g.town;
  g.state.outcome.confidenceStart = g.town.confidence;
  return g;
}

/** The control group: the same shift with nobody in the station. */
function runIdleShift(seed, label) {
  const g = freshGame(seed, label);
  g.clock.skipMs(CONFIG.shift.durationMs + 2000, (ms) => g.step(ms, null));
  return g;
}

const CMD = (over = {}) => ({
  axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 }, aim: null,
  interact: false, drop: false, use: false, siren: false, slot: null, ...over,
});

const SEEDS = [[9001, 'play_a'], [9002, 'play_b']];
const runs = [];

/* ── A. the bot can play a shift at all ──────────────────────────────────── */
function sectionA() {
lines.push('--- A. a crew that turns up (the real input path, whole shifts) ---');
for (const [seed, label] of SEEDS) {
  const g = freshGame(seed, label);
  const bot = runBotShift(g);
  const s = g.state;
  runs.push({ seed, label, game: g, bot });

  lines.push(`    ${label}: ${s.incidents.length} calls · ${s.outcome.controlled} controlled · ` +
    `${s.outcome.lost} lost · ${s.outcome.patientsSaved} transported · ` +
    `${(s.telemetry.distanceDrivenM / 1000).toFixed(2)} km · ${Math.round(s.telemetry.litresUsed)} L · ` +
    `wrong-tool ${s.telemetry.wrongToolAttempts}`);

  ok(`A[${label}] the shift ran to the end`, s.mode === MODES.REPORT, `mode ${s.mode}`);
  gt(`A[${label}] the bot got into a truck`, bot.actions.entries, 0);
  gt(`A[${label}] and got back out of it on scene`, bot.actions.dismounts, 0);
  gt(`A[${label}] the bot drove somewhere`, s.telemetry.distanceDrivenM, 200);
  gt(`A[${label}] the bot picked kit out of a compartment`, bot.actions.toolsTaken, 0);
  gt(`A[${label}] and reached at least one scene`, s.incidents.filter((i) => i.everWorked).length, 0);
}
emit('running A');
}

/* ── B. the thesis ───────────────────────────────────────────────────────── */
function sectionB() {
lines.push('--- B. turning up must beat not turning up (the whole game) ---');

/* Compared in AGGREGATE across seeds, not shift by shift.
 *
 * A crew changes which sites are free, which changes where later calls land, so the
 * worked shift and the idle shift stop being the same shift the moment the bot closes
 * anything. Per-seed comparisons of a specific number are therefore noise; the claim
 * worth defending is the aggregate one, which is also the claim the game makes. */
const worked = { conf: 0, controlled: 0, lost: 0, damage: 0, saved: 0 };
const idle = { conf: 0, controlled: 0, lost: 0, damage: 0, saved: 0 };

for (const run of runs) {
  const idleGame = runIdleShift(run.seed, run.label);
  const w = run.game.state, i = idleGame.state;
  lines.push(`    ${run.label}: confidence worked ${(w.town.confidence * 100).toFixed(0)}% ` +
    `vs idle ${(i.town.confidence * 100).toFixed(0)}%  ·  ` +
    `controlled ${w.outcome.controlled} vs ${i.outcome.controlled}  ·  ` +
    `lost ${w.outcome.lost} vs ${i.outcome.lost}  ·  ` +
    `damage ${totalDamage(w).toFixed(2)} vs ${totalDamage(i).toFixed(2)}`);
  worked.conf += w.town.confidence; idle.conf += i.town.confidence;
  worked.controlled += w.outcome.controlled; idle.controlled += i.outcome.controlled;
  worked.lost += w.outcome.lost; idle.lost += i.outcome.lost;
  worked.damage += totalDamage(w); idle.damage += totalDamage(i);
  worked.saved += w.outcome.patientsSaved; idle.saved += i.outcome.patientsSaved;
}

ok('B1 the town ends happier when somebody responds',
  worked.conf > idle.conf, `${worked.conf.toFixed(2)} vs ${idle.conf.toFixed(2)}`);
gt('B2 more calls are brought under control', worked.controlled, idle.controlled);
ok('B3 fewer calls are lost', worked.lost < idle.lost, `${worked.lost} vs ${idle.lost}`);
ok('B4 less of the town burns down', worked.damage < idle.damage,
  `${worked.damage.toFixed(2)} vs ${idle.damage.toFixed(2)}`);
lines.push(`    (transports worked ${worked.saved} vs idle ${idle.saved} — observed, not asserted; see note in C)`);
emit('running B');
}

function totalDamage(state) {
  return Object.values(state.town.buildings).reduce((n, r) => n + r.damage, 0);
}

/* ── C. every family can actually be closed by hand ──────────────────────── */
function sectionC() {
lines.push('--- C. across both shifts, each verb produced a result ---');
{
  const all = runs.flatMap((r) => r.game.state.incidents);
  const closed = all.filter((i) => i.status === 'controlled');
  gt('C1 calls were closed, not just attended', closed.length, 0);

  const families = new Set(closed.map((i) => i.family));
  lines.push(`    families closed: ${[...families].join(', ') || 'none'}`);
  gt('C2 at least two different families were closed', families.size, 1);

  const totals = runs.reduce((acc, r) => {
    acc.tools += r.bot.actions.toolsTaken;
    acc.loaded += r.bot.actions.patientsLoaded;
    acc.saved += r.game.state.outcome.patientsSaved;
    acc.wrong += r.game.state.telemetry.wrongToolAttempts;
    acc.water += r.game.state.telemetry.litresUsed;
    return acc;
  }, { tools: 0, loaded: 0, saved: 0, wrong: 0, water: 0 });

  gt('C3 water was put on something', totals.water, 50);
  ok('C4 targeting works: wrong-tool attempts stay rare',
    totals.wrong < totals.tools * 6 + 40, `${totals.wrong} wrong for ${totals.tools} tools taken`);

  /* Transport is NOT asserted here, deliberately.
   *
   * The full chain — grab, extricate with the spreaders, load, drive, hand over at the
   * clinic — is asserted end to end in tools/m1-tests.js section F, through the same
   * interaction functions a player drives. Whether an unattended bot also completes one
   * inside ten minutes depends on how clever the bot is, not on whether the game works:
   * it has to fetch the ambulance from the station, and the crash it is standing at has
   * a live wire on it that outranks the patient. Asserting it here would be testing the
   * harness. What m2 is for is the composition of the verbs and the absence of traps.
   */
  lines.push(`    transport chain observed: ${totals.loaded} loaded, ${totals.saved} delivered ` +
    '(asserted in m1 section F, not here)');
}
emit('running C');
}

/* ── D. no soft-locks ────────────────────────────────────────────────────── */
function sectionD() {
lines.push('--- D. nothing traps the player ---');
for (const run of runs) {
  const s = run.game.state;
  ok(`D[${run.label}] the responder is not left inside a wall`,
    s.player.x > 0 && s.player.x < CONFIG.world.widthM && s.player.y > 0 && s.player.y < CONFIG.world.heightM);
  ok(`D[${run.label}] no apparatus ended up wedged off the map`,
    s.apparatus.every((a) => a.x > 0 && a.x < CONFIG.world.widthM && a.y > 0 && a.y < CONFIG.world.heightM));
  ok(`D[${run.label}] the event log stayed bounded`, run.game.bus.log.length <= CONFIG.debug.eventLogSize);
  ok(`D[${run.label}] the radio stayed bounded`, s.radio.length <= 40, `${s.radio.length} lines`);
  // A dithering loop — in/out of the same cab, or take/drop the same tool — is the
  // signature of a state machine with no exit, and it is invisible in the outcome
  // numbers. Ten minutes of sane play is a few dozen of each, not thousands.
  ok(`D[${run.label}] no getting in and out of the cab on a loop`,
    run.bot.actions.entries < 60 && run.bot.actions.dismounts < 60,
    `${run.bot.actions.entries} in, ${run.bot.actions.dismounts} out`);
  ok(`D[${run.label}] no picking the same tool up on a loop`,
    run.bot.actions.toolsTaken < 60, `${run.bot.actions.toolsTaken} tools taken`);
}
{
  // A held tool must always be droppable, and a dropped tool must always be findable:
  // the one state a player can get permanently stuck in is hands they cannot empty.
  const g = freshGame(4321, 'drop');
  const bot = new CrewBot(g);
  const inp = bot.input;
  const eng = g.state.apparatus.find((a) => a.id === 'engine');
  g.state.player.x = eng.x; g.state.player.y = eng.y + 1.5;
  inp.tap('slot1'); g.step(STEP, inp);
  const held = g.state.tools.find((t) => t.carrier === g.state.player.id);
  ok('D1 a tool can be taken', !!held);
  inp.tap('drop'); g.step(STEP, inp);
  ok('D2 and always put down again', g.state.player.toolId === null);
  ok('D3 where it stays, as a world object', held && held.carrier === null &&
    Number.isFinite(held.x) && Number.isFinite(held.y));
  g.state.player.x = held.x; g.state.player.y = held.y;
  inp.tap('slot1'); g.step(STEP, inp);
  ok('D4 and can be picked back up off the ground', g.state.player.toolId === held.id);
}
emit(null);
}

/* ── E. two on the crew (GDD Phase 5) ────────────────────────────────────── */
function sectionE() {
lines.push('--- E. cooperative validation: two responders, one town ---');
{
  const g = freshGame(7101, 'coop');
  const s = g.state;
  eq('E1 a shift starts with one volunteer', s.responders.length, 1);
  ok('E2 and state.player IS that responder, not a copy', s.player === s.responders[0]);

  ok('E3 a partner can sign on mid-shift', toggleCoop(s) === true && s.responders.length === 2);
  ok('E4 they are a different person with their own keys',
    s.responders[1].id !== s.responders[0].id && s.responders[1].prefix === 'p2');

  /* Contention. There is one wheel, one nozzle, one patient — and the design says
   * those are contested by construction rather than by a rule. */
  const [a, b] = s.responders;
  const eng = s.apparatus.find((x) => x.id === 'engine');
  a.x = eng.x; a.y = eng.y + 1.5;
  b.x = eng.x; b.y = eng.y + 1.5;

  stepInteraction(s, CMD({ interact: true }), STEP, a);
  eq('E5 the first one in takes the wheel', eng.driverId, a.id);
  stepInteraction(s, CMD({ interact: true }), STEP, b);
  eq('E6 the second one rides instead of taking it', eng.driverId, a.id);
  ok('E7 but they are aboard, not left behind', eng.passengerIds.includes(b.id) && b.inVehicleId === eng.id);

  // only the driver's throttle moves the truck
  const x0 = eng.x;
  g.frame(200, mergeBotInputs([
    (() => { const i = makeBotInput(''); i.hold('moveUp'); return i; })(),
    (() => { const i = makeBotInput('p2'); i.hold('moveUp'); return i; })(),
  ]));
  const drivenBoth = eng.x - x0;
  eng.x = x0; eng.speed = 0;
  g.frame(200, mergeBotInputs([(() => { const i = makeBotInput(''); i.hold('moveUp'); return i; })()]));
  const drivenOne = eng.x - x0;
  ok('E8 two people in a cab do not drive it twice as fast',
    Math.abs(drivenBoth - drivenOne) < 0.2, `${drivenBoth.toFixed(2)} vs ${drivenOne.toFixed(2)}`);

  stepInteraction(s, CMD({ interact: true }), STEP, a);
  eq('E9 the driver getting out frees the wheel', eng.driverId, null);
  ok('E10 and the passenger is still aboard', b.inVehicleId === eng.id);
}
{
  const g = freshGame(7102, 'coop2');
  const s = g.state;
  toggleCoop(s);
  const [a, b] = s.responders;
  const eng = s.apparatus.find((x) => x.id === 'engine');
  a.x = eng.x; a.y = eng.y + 1.5; b.x = eng.x; b.y = eng.y + 1.5;

  // one nozzle
  const hose = s.tools.find((t) => t.defId === 'hose');
  const slotOf = (who, defId) =>
    toolsInReachOf(s, who.x, who.y).findIndex((q) => q.tool.defId === defId);
  stepInteraction(s, CMD({ slot: slotOf(a, 'hose') }), STEP, a);
  eq('E11 one of them takes the line', hose.carrier, a.id);
  const before = hose.carrier;
  const slot = slotOf(b, 'hose');
  if (slot >= 0) stepInteraction(s, CMD({ slot }), STEP, b);
  eq('E12 the other cannot take it out of their hands', hose.carrier, before);

  // one patient
  const v = createVictim({ incidentId: 'x', x: a.x + 1, y: a.y, severity: 'injured' });
  s.victims.push(v);
  stepInteraction(s, CMD({ interact: true }), STEP, b);
  eq('E13 a free hand can take hold of a patient', v.draggedBy, b.id);
  stepInteraction(s, CMD({ interact: true }), STEP, a);
  eq('E14 and the other cannot take the same patient', v.draggedBy, b.id);

  // signing off must not strand anything
  toggleCoop(s);
  eq('E15 signing off leaves one responder', s.responders.length, 1);
  eq('E16 the patient they were carrying is put down, not orphaned', v.draggedBy, null);
  ok('E17 nothing is left carried by a responder who no longer exists',
    s.tools.every((t) => t.carrier === null || t.carrier === 'rack' ||
      s.apparatus.some((ap) => ap.id === t.carrier) ||
      s.responders.some((r) => r.id === t.carrier)));
}
{
  // Two bots, one town, whole shift: the composition test rather than the unit test.
  const g = freshGame(7103, 'coopshift', false);
  toggleCoop(g.state);
  const bots = [new CrewBot(g, 'r1'), new CrewBot(g, 'r2')];
  const step = CONFIG.sim.stepMs;
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += step) {
    for (const bot of bots) bot.think();
    g.frame(step, mergeBotInputs(bots.map((x) => x.input)));
    if (g.state.mode !== MODES.PLAYING) break;
  }
  const s = g.state;
  lines.push(`    two-crew shift: ${s.incidents.length} calls · ${s.outcome.controlled} controlled · ` +
    `${s.outcome.lost} lost · ${(s.telemetry.distanceDrivenM / 1000).toFixed(2)} km · ` +
    `${Math.round(s.telemetry.litresUsed)} L`);
  eq('E18 a two-crew shift runs to the end', s.mode, MODES.REPORT);
  gt('E19 both volunteers did something', bots.filter((x) => x.actions.entries > 0).length, 1);
  gt('E20 and the crew closed calls', s.outcome.controlled, 0);
  ok('E21 neither of them ended up wedged off the map',
    s.responders.every((r) => r.x > 0 && r.x < CONFIG.world.widthM && r.y > 0 && r.y < CONFIG.world.heightM));
}
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE();
  lines.push('');
  lines.push('--- bot log, first shift (abridged) ---');
  for (const l of (runs[0] ? runs[0].bot.log.slice(0, 26) : [])) lines.push(`    ${l}`);
  emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
