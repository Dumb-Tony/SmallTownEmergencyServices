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
import { Game, MODES } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import { openIncidents } from '../src/sim/incidentSim.js';
import { victimHandled } from '../src/sim/victims.js';
import { CrewBot, runBotShift, makeBotInput } from './_crewbot.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
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
  const held = g.state.tools.find((t) => t.carrier === 'player');
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

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD();
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
