/* Does the weather change anything a player would notice, and does it stay inside the
 * law? Measured, before anything about it is asserted.
 *
 * The failure mode for a modifier layer is not that it breaks — it is that it does
 * NOTHING. A 20% multiplier on a number nobody was watching is a feature that ships,
 * reads well in a changelog, and never once changes a decision. So the questions are:
 *
 *   1. Is a windy shift measurably a different shift from a clear one, on the same seed?
 *   2. Does the wind decide WHICH building catches, or is it still just the nearest?
 *   3. Does a shift stay winnable in the worst condition — GDD rule 9, recoverable
 *      failure. A modifier that makes a call impossible is a fail screen wearing a cloud.
 *   4. Does the roll actually vary, or does one condition dominate the table?
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, toggleCoop } from '../src/game.js';
import { clearSave, defaultTown, advanceShift } from '../src/core/persistence.js';
import { Rng } from '../src/core/rng.js';
import { createFire, fireDamageFraction } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { BUILDING_BY_ID, BUILDINGS, dist } from '../src/data/town.js';
import {
  CONDITIONS, CONDITION_IDS, rollWeather, weatherMods, describeWeather, downwindFactor,
} from '../src/sim/weather.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';

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

/** Force a condition on a game that has already rolled one. */
function force(g, id, strength = 1, windDir = 0) {
  g.state.weather = { id, strength: id === 'clear' ? 0 : strength, windDir };
  return g;
}

function fireAt(g, buildingId, seedCells = 3) {
  const s = g.state;
  const b = BUILDING_BY_ID[buildingId];
  const inc = {
    id: 'incW', templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
    place: b.name, x: b.door.x, y: b.door.y, buildingId, roadId: null, priority: 'high',
    report: '', createdMs: 0, ageMs: 0, danger: 0, peakDanger: 0, status: 'active',
    hazardIds: [], victimIds: [], consequences: [], capabilities: [], updates: [],
    lastUpdateText: null, resolvedMs: null, outcomeNote: null, everWorked: true,
  };
  s.incidents.push(inc);
  const fire = createFire(buildingId, { seedCells, heat: 1.0, from: 'centre' });
  addHazard(s, inc, fire);
  return { inc, fire };
}

/* ── 1. the table itself ─────────────────────────────────────────────────── */

say('== 1. the multipliers, as they will actually be read ==');
say('cond   fireSpread fireJump gasDisp roadGrip decline hydrant curiosity windBias');
say('-----  ---------- -------- ------- -------- ------- ------- --------- --------');
for (const id of CONDITION_IDS) {
  const m = weatherMods({ id, strength: 1, windDir: 0 });
  say(`${pad(id, 5)}  ${pad(f(m.fireSpread, 2), 10)} ${pad(f(m.fireJump, 2), 8)} ` +
    `${pad(f(m.gasDisperse, 2), 7)} ${pad(f(m.roadGrip, 2), 8)} ${pad(f(m.patientDecline, 2), 7)} ` +
    `${pad(f(m.hydrantFlow, 2), 7)} ${pad(f(m.curiosity, 2), 9)} ${f(m.windBias, 2)}`);
}
const clearM = weatherMods({ id: 'clear', strength: 0, windDir: 0 });
const notOne = Object.entries(clearM)
  .filter(([k, v]) => k !== 'id' && typeof v === 'number' && v !== 1 && k !== 'windBias' && k !== 'smokeLean');
say('');
say(`clear is 1.0 on every multiplier: ${notOne.length === 0 ? 'yes' : `NO — ${JSON.stringify(notOne)}`}`);
const half = weatherMods({ id: 'rain', strength: 0.5, windDir: 0 });
const full = weatherMods({ id: 'rain', strength: 1, windDir: 0 });
say(`half-strength rain sits between clear and full rain: fireSpread ` +
  `1.00 / ${f(half.fireSpread, 2)} / ${f(full.fireSpread, 2)}`);
say('');

/* ── 2. does the roll vary ───────────────────────────────────────────────── */

say('== 2. two hundred shifts of weather ==');
{
  const counts = {};
  let repeats = 0, prev = null;
  let town = defaultTown();
  for (let i = 0; i < 200; i++) {
    const w = rollWeather(new Rng((1000 + i * 7919) >>> 0, 'w'), prev);
    counts[w.id] = (counts[w.id] || 0) + 1;
    if (w.id === prev) repeats++;
    prev = w.id;
    town = { ...town, lastWeather: w.id };
  }
  say('  ' + CONDITION_IDS.map((id) => `${id} ${counts[id] || 0}`).join(' · '));
  say(`  back-to-back repeats: ${repeats} of 199 (${f((repeats / 199) * 100, 1)}%)`);
  const strengths = [];
  for (let i = 0; i < 60; i++) {
    const w = rollWeather(new Rng((7 + i * 104729) >>> 0, 'w'), null);
    if (w.id !== 'clear') strengths.push(w.strength);
  }
  say(`  strength range on ${strengths.length} non-clear rolls: ` +
    `${f(Math.min(...strengths), 2)} to ${f(Math.max(...strengths), 2)}`);
  say(`  and the same seed rolls the same weather: ` +
    `${rollWeather(new Rng(42, 'w')).id === rollWeather(new Rng(42, 'w')).id}`);
}
say('');

/* ── 3. is a windy shift a different shift ───────────────────────────────── */

/* Three minutes was the wrong window: the farmhouse burns to 100% in every condition
 * long before it ends, so the table read identically five times over and said nothing.
 * The difference a multiplier makes is visible while the fire is still GROWING — which
 * is also the only window in which a crew could have done anything about it. */
say('== 3. the same fire, in five conditions (Miller Farmhouse, growing) ==');
say('cond   burnt @30s  @60s  @90s   cells alight @60s   caught by 90s');
say('-----  ----------  ----  -----  -----------------   -------------');
for (const id of CONDITION_IDS) {
  clearSave();
  const g = new Game({ seed: 5150 });
  g.startShift();
  force(g, id, 1, 0);                       // wind blowing east, +x
  const s = g.state;
  s.dispatch.nextCallAtMs = 1e9;
  const { inc, fire } = fireAt(g, 'farmhouse', 2);
  const marks = {};
  let alight60 = 0;
  for (let t = 0; t < 90000 && s.mode === MODES.PLAYING; t += STEP) {
    g.frame(STEP, null);
    s.dispatch.nextCallAtMs = 1e9;
    inc.danger = 0;
    const sec = Math.round(s.simTimeMs / 1000);
    if ((sec === 30 || sec === 60 || sec === 90) && marks[sec] === undefined) {
      marks[sec] = fireDamageFraction(fire);
      if (sec === 60) alight60 = fire.cells.filter((c) => c.burning).length;
    }
  }
  const jumped = s.hazards.filter((h) => h.kind === 'fire' && h.buildingId !== 'farmhouse');
  const pc = (n) => (marks[n] == null ? '—' : `${f(marks[n] * 100, 0)}%`);
  say(`${pad(id, 5)}  ${pad(pc(30), 10)}  ${pad(pc(60), 4)}  ${pad(pc(90), 5)}  ` +
    `${pad(`${alight60} of ${fire.cells.length}`, 17)}   ` +
    `${jumped.map((h) => h.buildingId).join(',') || '—'}`);
}
say('');

/* ── 4. does the wind decide WHICH one catches ───────────────────────────── */

say('== 4. the wind and the exposure: same fire, opposite winds ==');
{
  /* How much there is to bias in the first place: if almost every fire has one exposure
     or none, a rule that re-ranks candidates has no outputs and the wind must move the
     REACH instead. This is the number that decided that. */
  let one = 0, several = 0, none = 0;
  for (const a of BUILDINGS) {
    if (a.kind === 'station' || a.kind === 'clinic') continue;
    let n = 0;
    for (const b of BUILDINGS) {
      if (a.id === b.id || b.kind === 'station' || b.kind === 'clinic') continue;
      const gx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
      const gy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
      if (Math.hypot(gx, gy) <= CONFIG.fire.jumpDistM) n++;
    }
    if (n === 0) none++; else if (n === 1) one++; else several++;
  }
  say(`  buildings with 0 / 1 / 2+ exposures inside ${CONFIG.fire.jumpDistM} m: ${none} / ${one} / ${several}`);

  // The farmhouse has the barn to its east. Blow the wind each way and count.
  const home = BUILDING_BY_ID.farmhouse, barn = BUILDING_BY_ID.barn;
  const bearing = Math.atan2((barn.y + barn.h / 2) - (home.y + home.h / 2),
    (barn.x + barn.w / 2) - (home.x + home.w / 2));
  say(`  Miller Barn lies at ${f((bearing * 180) / Math.PI, 0)}° from Miller Farmhouse`);

  const trial = (label, windDir) => {
    const hits = {};
    let runs = 0;
    for (let seed = 0; seed < 14; seed++) {
      clearSave();
      const g = new Game({ seed: 6000 + seed });
      g.startShift();
      force(g, 'wind', 1, windDir);
      const s = g.state;
      s.dispatch.nextCallAtMs = 1e9;
      const { inc } = fireAt(g, 'farmhouse', 4);
      for (let t = 0; t < 150000 && s.mode === MODES.PLAYING; t += STEP) {
        g.frame(STEP, null);
        s.dispatch.nextCallAtMs = 1e9;
        inc.danger = 0;
      }
      runs++;
      for (const h of s.hazards) {
        if (h.kind !== 'fire' || h.buildingId === 'farmhouse') continue;
        hits[h.buildingId] = (hits[h.buildingId] || 0) + 1;
      }
    }
    const rows = Object.entries(hits).sort((a, b) => b[1] - a[1]);
    say(`  ${pad(label, 22)} ${rows.map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing caught'} (of ${runs})`);
    return hits;
  };
  const downwind = trial('wind toward the barn', bearing);
  const upwind = trial('wind away from it', bearing + Math.PI);
  const still = (() => {
    const hits = {};
    for (let seed = 0; seed < 14; seed++) {
      clearSave();
      const g = new Game({ seed: 6000 + seed });
      g.startShift();
      force(g, 'clear', 0, 0);
      const s = g.state;
      s.dispatch.nextCallAtMs = 1e9;
      const { inc } = fireAt(g, 'farmhouse', 4);
      for (let t = 0; t < 150000 && s.mode === MODES.PLAYING; t += STEP) {
        g.frame(STEP, null); s.dispatch.nextCallAtMs = 1e9; inc.danger = 0;
      }
      for (const h of s.hazards) {
        if (h.kind !== 'fire' || h.buildingId === 'farmhouse') continue;
        hits[h.buildingId] = (hits[h.buildingId] || 0) + 1;
      }
    }
    say(`  ${pad('still air (control)', 22)} ${Object.entries(hits).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing caught'} (of 14)`);
    return hits;
  })();
  say('');
  say(`  downwindFactor sanity: straight downwind ${f(downwindFactor({ windDir: 0 }, 0, 0, 10, 0), 2)}, ` +
    `across ${f(downwindFactor({ windDir: 0 }, 0, 0, 0, 10), 2)}, ` +
    `upwind ${f(downwindFactor({ windDir: 0 }, 0, 0, -10, 0), 2)}`);
}
say('');

/* ── 5. is it still winnable ─────────────────────────────────────────────── */

say('== 5. a bot shift in every condition — GDD rule 9, recoverable failure ==');
say('cond   calls  controlled  lost  patients saved/lost  confidence  km');
say('-----  -----  ----------  ----  -------------------  ----------  -----');
for (const id of CONDITION_IDS) {
  clearSave();
  const g = new Game({ seed: 4242 });
  g.startShift();
  force(g, id, 1, 0.6);
  const bot = new CrewBot(g);
  const s = g.state;
  while (s.mode === MODES.PLAYING && s.simTimeMs < CONFIG.shift.durationMs + 2000) {
    bot.think();
    g.frame(STEP, bot.input);
  }
  if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
  const r = s.report;
  say(`${pad(id, 5)}  ${pad(r.calls, 5)}  ${pad(r.controlled, 10)}  ${pad(r.lost, 4)}  ` +
    `${pad(`${r.patientsSaved}/${r.patientsLost}`, 19)}  ` +
    `${pad(f(r.confidenceEnd * 100, 0) + '%', 10)}  ${f(r.telemetry.distanceDrivenM / 1000, 1)}`);
}
say('');

/* ── 6. cost, and the wire ───────────────────────────────────────────────── */

say('== 6. what it costs ==');
{
  clearSave();
  const g = new Game({ seed: 808 });
  g.startShift();
  const s = g.state;
  force(g, 'wind', 1, 1.2);
  fireAt(g, 'pizza');
  const t0 = performance.now();
  for (let t = 0; t < 60000; t += STEP) g.frame(STEP, null);
  const t1 = performance.now();
  say(`  a minute of a windy town with a fire in it: ${f((t1 - t0) / (60000 / STEP), 4)} ms a step`);
  say(`  weather on the state: ${JSON.stringify(s.weather)}`);
  say(`  described as: "${describeWeather(s.weather)}"`);

  // and it survives a shift boundary
  s.simTimeMs = CONFIG.shift.durationMs;
  g.endShift();
  say(`  saved as town.lastWeather = ${JSON.stringify(g.town.lastWeather)}`);
  g.startShift();
  say(`  and the next shift rolled: ${g.state.weather.id} (${describeWeather(g.state.weather)})`);
}

/* ── 7. the medical chain, per condition ─────────────────────────────────── */

/* m5 is the suite that asks the GDD's own question — does it play? — and its hardest
 * assertion is that a casualty reaches the clinic ALIVE in a real bot shift. Adding
 * weather broke it on both of its seeds. That is either a genuine balance problem or a
 * gate that was silently depending on a roll, and the only way to tell is to run the same
 * shift in all five conditions. */
say('== 7. does a casualty still reach the clinic, in every condition ==');
say('  (TWO crew, seeds 101 and 303 summed — exactly the shifts m5 section C plays)');
say('cond      reached  treated  loaded  DELIVERED  lost   rolled');
say('--------  -------  -------  ------  ---------  ----   ------');
for (const id of [...CONDITION_IDS, null]) {   // null = whatever the seed rolls by itself
  const totals = { reached: 0, treated: 0, loaded: 0, delivered: 0, lost: 0 };
  const rolled = [];
  for (const seed of [101, 303]) {
    clearSave();
    const g = new Game({ seed });
    g.startShift();
    if (id) force(g, id, 1, 0.4);
    rolled.push(g.state.weather.id);
    const s = g.state;
    toggleCoop(s);
    const board = { claims: new Map(), trucks: new Map() };
    const bots = s.responders.map((r) => new CrewBot(g, r.id, board));
    bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : 'p2'); });
    const input = mergeBotInputs(bots.map((b) => b.input));
    const seen = new Set();
    for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
      for (const b of bots) b.think();
      g.frame(STEP, input);
      if (s.mode !== MODES.PLAYING) break;
      for (const v of s.victims) {
        if (!seen.has(v.id + 'r') && s.responders.some((r) => !r.inVehicleId &&
            dist(r.x, r.y, v.x, v.y) < CONFIG.player.reachM + 1)) { seen.add(v.id + 'r'); totals.reached++; }
        if (!seen.has(v.id + 't') && v.treatedAtMs != null) { seen.add(v.id + 't'); totals.treated++; }
        if (!seen.has(v.id + 'l') && v.inApparatusId) { seen.add(v.id + 'l'); totals.loaded++; }
        if (!seen.has(v.id + 'd') && v.delivered) { seen.add(v.id + 'd'); totals.delivered++; }
        if (!seen.has(v.id + 'x') && v.lost) { seen.add(v.id + 'x'); totals.lost++; }
      }
    }
  }
  say(`${pad(id || 'natural', 8)}  ${pad(totals.reached, 7)}  ${pad(totals.treated, 7)}  ` +
    `${pad(totals.loaded, 6)}  ${pad(totals.delivered, 9)}  ${pad(totals.lost, 5)}  ${rolled.join(',')}`);
}

say('');
say('== done ==');
