/* The station between shifts. Measured before anything about it is asserted.
 *
 * This is the one carry-over the player causes entirely by hand, and the one with the
 * clearest way of going wrong: a truck abandoned across town with an empty tank is a
 * consequence, and three of them plus the medical kit in a ditch is a fail screen wearing
 * a persistence feature. GDD rule 9 asks for RECOVERABLE failure, and the questions are:
 *
 *   1. Does anything actually carry? A save that quietly drops it is the likelier bug.
 *   2. Does the tidy radius sort "nearly back" from "abandoned at the junction"?
 *   3. Does a truck repair itself over a few shifts, or is damage another fixed point?
 *   4. Can a crew recover from the worst state a previous shift can leave them in —
 *      and how much does it cost them?
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES } from '../src/game.js';
import { clearSave, loadTown, saveTown, defaultTown, advanceShift } from '../src/core/persistence.js';
import { STATION, BUILDING_BY_ID, dist } from '../src/data/town.js';
import { CrewBot } from './_crewbot.js';

const STEP = CONFIG.sim.stepMs;
const lines = [];
const say = (s = '') => { lines.push(s); dump(); };
const f = (n, d = 1) => Number(n).toFixed(d);
const pad = (s, n) => String(s).padEnd(n);

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

/** End a shift with the station in a given state, and return the town that results. */
function bankWith(mutate, seed = 300) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  mutate(g.state);
  g.state.simTimeMs = CONFIG.shift.durationMs;
  g.endShift();
  saveTown(g.town);
  return { town: loadTown(), report: g.state.report };
}

/* ── 1 & 2. what carries, and where the line is ──────────────────────────── */

say('== 1. what stays out ==');
say(`  stationTidyRadiusM ${CONFIG.town.stationTidyRadiusM} m · ` +
  `undriveableDamage ${CONFIG.town.undriveableDamage}`);
say('');
say('  left at            distance  damage  banked as       tank kept');
say('  -----------------  --------  ------  --------------  ---------');
{
  const bay = STATION.bays[0];
  const spots = [
    ['its own bay', bay.x, bay.y],
    ['the apron', STATION.apron.x + 6, STATION.apron.y + 6],
    ['the kerb outside', 122, 150],
    ['the junction', 150, 152],
    ["Tony's Pizza", 142, 150],
    ['Miller Barn', 320, 74],
  ];
  /* Two passes, because the rule has two clauses and the first version of this table only
     exercised one. A DRIVEABLE truck comes home from anywhere — the bell ringing while
     you are at a call is not a mistake anybody made. Only a wreck stays where it is. */
  for (const dmg of [0.2, 0.95]) {
    for (const [label, x, y] of spots) {
      const { town } = bankWith((s) => {
        const ap = s.apparatus[0];
        ap.x = x; ap.y = y; ap.waterL = 400; ap.damage = dmg;
      });
      const rec = town.apparatus.engine;
      say(`  ${pad(label, 17)}  ${pad(f(dist(x, y, bay.x, bay.y), 0) + ' m', 8)}  ` +
        `${pad(f(dmg, 2), 6)}  ` +
        `${pad(!rec || rec.home ? 'in its bay' : 'still out', 14)}  ` +
        `${rec && !rec.home ? rec.waterL + ' L' : 'refilled'}`);
    }
    if (dmg === 0.2) say('  ' + '-'.repeat(58));
  }
}
say('');

say('== 2. kit left lying about ==');
{
  const { town, report } = bankWith((s) => {
    const saw = s.tools.find((t) => t.defId === 'chainsaw');
    saw.carrier = null; saw.x = 300; saw.y = 70;
    const kit = s.tools.find((t) => t.defId === 'medkit');
    kit.carrier = null; kit.x = STATION.rack.x + 3; kit.y = STATION.rack.y + 3;
  });
  say(`  tools banked: ${Object.keys(town.tools).length} ` +
    `(the saw at the barn; the kit dropped by the rack should NOT be one)`);
  for (const [id, rec] of Object.entries(town.tools)) {
    say(`    ${id} at ${f(rec.x, 0)},${f(rec.y, 0)}`);
  }
  say(`  the report names: ${(report.nextShift.toolsOut || []).map((t) => `${t.name} at ${t.where}`).join(', ') || 'nothing'}`);

  clearSave();
  saveTown(town);
  const g = new Game({ seed: 301 });
  g.startShift();
  const saw = g.state.tools.find((t) => t.defId === 'chainsaw');
  say(`  next shift, the saw is: carrier=${saw.carrier} at ${f(saw.x, 0)},${f(saw.y, 0)}`);
  const kit = g.state.tools.find((t) => t.defId === 'medkit');
  say(`  and the medical kit is: carrier=${kit.carrier} (should be back on the ambulance)`);
}
say('');

/* ── 3. does a dented truck heal ─────────────────────────────────────────── */

say('== 3. a dented engine, over six shifts ==');
{
  let town = defaultTown();
  town.apparatus = { engine: { home: true, damage: 0.9 } };
  const trail = [];
  for (let i = 0; i < 6; i++) {
    town = advanceShift(town, `s${i}`);
    saveTown(town); town = loadTown();
    trail.push(town.apparatus.engine ? f(town.apparatus.engine.damage, 2) : 'whole');
  }
  say(`  damage: 0.90 -> ${trail.join(' -> ')}`);
  const D = CONFIG.drive;
  const speedAt = (d) => 1 - Math.min(0.45, d * 0.5);
  say(`  top-speed penalty at 0.90: x${f(speedAt(0.9), 2)}  ·  at 0.30: x${f(speedAt(0.3), 2)}  ·  whole: x1.00`);
}
say('');

/* ── 4. the worst a shift can hand over ──────────────────────────────────── */

say('== 4. can a crew recover from the worst hand-over a shift can make ==');
{
  // Everything out, everything dry, everything dented, and the kit in a ditch.
  const { town, report } = bankWith((s) => {
    const spots = [[320, 74], [300, 260], [180, 60]];
    s.apparatus.forEach((ap, i) => {
      ap.x = spots[i][0]; ap.y = spots[i][1]; ap.waterL = 0; ap.damage = 0.8;
    });
    for (const t of s.tools) {
      if (t.carrier === 'rack') continue;
      t.carrier = null; t.x = 340; t.y = 80;
    }
  });
  say(`  banked: ${Object.keys(town.apparatus).length} apparatus out, ` +
    `${Object.keys(town.tools).length} tools in the field`);
  say(`  the report warned: "${(report.nextShift.apparatusOut || [])
    .map((a) => `${a.name} at ${a.where}`).join('; ')}"`);

  const walk = Math.min(...[[320, 74], [300, 260], [180, 60]]
    .map(([x, y]) => dist(STATION.spawn.x, STATION.spawn.y, x, y)));
  say(`  nearest truck is ${f(walk, 0)} m from the spawn point — ` +
    `${f(walk / CONFIG.player.maxSpeed, 0)} s at a jog`);

  for (const label of ['worst hand-over', 'clean station']) {
    clearSave();
    if (label === 'worst hand-over') saveTown(town);
    const g = new Game({ seed: 4242 });
    g.startShift();
    const bot = new CrewBot(g);
    const s = g.state;
    for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
      bot.think();
      g.frame(STEP, bot.input);
      if (s.mode !== MODES.PLAYING) break;
    }
    if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
    const r = s.report;
    say(`  ${pad(label, 16)} ${r.calls} calls · ${r.controlled} controlled · ${r.lost} lost · ` +
      `confidence ${f(r.confidenceEnd * 100, 0)}% · ${f(r.telemetry.distanceDrivenM / 1000, 1)} km`);
  }
}
say('');

/* ── 5. and it does not accumulate ───────────────────────────────────────── */

say('== 5. six shifts of a bot that never puts anything away ==');
{
  clearSave();
  const g = new Game({ seed: 55 });
  for (let i = 1; i <= 6; i++) {
    g.startShift();
    const bot = new CrewBot(g);
    const s = g.state;
    for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
      bot.think();
      g.frame(STEP, bot.input);
      if (s.mode !== MODES.PLAYING) break;
    }
    if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
    const t2 = g.town;
    /* WHICH tool, and whether the crew spent the shift walking to it. Six shifts of this
       closed 2 calls against a control's 7 with NO truck ever stranded, so the entire gap
       is one dropped tool a night — and a five-call swing from one chainsaw is either a
       real balance problem or a bot that cannot cope, and the two want opposite fixes. */
    const outNames = Object.keys(t2.tools)
      .map((id) => (s.toolsById[id] || {}).name || id).join(', ');
    say(`  shift ${i}: ${Object.keys(t2.apparatus).length} apparatus recorded · ` +
      `${Object.keys(t2.tools).length} tools out (${outNames || '—'}) · ` +
      `save ${JSON.stringify(t2).length} B · ` +
      `${s.report.controlled}/${s.report.calls} controlled · ` +
      `confidence ${f(s.report.confidenceEnd * 100, 0)}% · ` +
      `${f(s.report.telemetry.distanceDrivenM / 1000, 2)} km driven · ` +
      `${f(s.report.telemetry.timeOnFootMs / 1000, 0)} s on foot`);
  }
}

say('');
say('== done ==');
