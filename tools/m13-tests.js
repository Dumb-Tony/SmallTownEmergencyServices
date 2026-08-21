/* Weather — GDD core system: "modifiers that generate and connect incidents rather than
 * launching a separate scripted level."
 *
 * The failure mode for a modifier layer is not that it breaks. It is that it does
 * NOTHING: a 20% multiplier on a number nobody was watching ships, reads well in a
 * changelog, and never once changes a decision. So most of this suite is about whether
 * the weather is OBSERVABLE, and the rest is about the law it must not break.
 *
 * What tools/_weatherdiag.js found, and what is therefore worth locking:
 *   - the same fire at 90 s is 14% of a building in rain, 21% in a cold snap, 32% clear,
 *     and 61% in heat. That is a difference a player can see from the cab;
 *   - the wind decides WHICH exposure catches — the barn caught 14 times out of 14 with
 *     the wind blowing at it and 0 out of 14 with the wind blowing away;
 *   - ...but only after the rule was rewritten. Re-ranking the candidates did nothing at
 *     all, because 7 of the 9 workable buildings in this town have NO exposure inside the
 *     jump distance and the other 2 have exactly one. A rule that reorders a list of one
 *     has no outputs. The wind moves the REACH;
 *   - every condition is still winnable: a bot shift closes calls in all five, and no
 *     condition produces a shift with nothing in it.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, toggleCoop } from '../src/game.js';
import { clearSave, defaultTown, migrate, advanceShift, saveTown, loadTown } from '../src/core/persistence.js';
import { Rng } from '../src/core/rng.js';
import { createFire, fireDamageFraction } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { createVictim } from '../src/sim/victims.js';
import { BUILDING_BY_ID, BUILDINGS } from '../src/data/town.js';
import {
  CONDITIONS, CONDITION_IDS, rollWeather, weatherMods, weatherFor,
  describeWeather, downwindFactor,
} from '../src/sim/weather.js';
import { encodeSnapshot, applySnapshot } from '../src/net/protocol.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';

const STEP = CONFIG.sim.stepMs;

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const ge = (n, a, b) => ok(n, a >= b, `got ${a}, want >= ${b}`);
const le = (n, a, b) => ok(n, a <= b, `got ${a}, want <= ${b}`);
const f = (n, d = 1) => Number(n).toFixed(d);

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

function force(g, id, strength = 1, windDir = 0) {
  g.state.weather = { id, strength: id === 'clear' ? 0 : strength, windDir };
  return g;
}

function fireAt(g, buildingId, seedCells = 3) {
  const s = g.state;
  const b = BUILDING_BY_ID[buildingId];
  const inc = {
    id: `incW${s.incidents.length + 1}`, templateId: 'kitchen_fire', family: 'fire',
    headline: 'Structure fire', place: b.name, x: b.door.x, y: b.door.y,
    buildingId, roadId: null, priority: 'high', report: '', createdMs: 0, ageMs: 0,
    danger: 0, peakDanger: 0, status: 'active', hazardIds: [], victimIds: [],
    consequences: [], capabilities: [], updates: [], lastUpdateText: null,
    resolvedMs: null, outcomeNote: null, everWorked: true,
  };
  s.incidents.push(inc);
  const fire = createFire(buildingId, { seedCells, heat: 1.0, from: 'centre' });
  addHazard(s, inc, fire);
  return { inc, fire };
}

/** Run with dispatch held off, so the measurement is of the fire and not of the queue. */
function burn(g, ms, inc) {
  const s = g.state;
  for (let t = 0; t < ms && s.mode === MODES.PLAYING; t += STEP) {
    s.dispatch.nextCallAtMs = 1e9;
    g.frame(STEP, null);
    if (inc) inc.danger = 0;
  }
}

/* ── A. the table ────────────────────────────────────────────────────────── */

function sectionA() {
lines.push('--- A. a set of bounded multipliers, and clear is the game as it was ---');
  const clear = weatherMods({ id: 'clear', strength: 0 });
  const numeric = (m) => Object.entries(m)
    .filter(([k, v]) => typeof v === 'number' && k !== 'windBias' && k !== 'smokeLean');
  eq('A1 clear is exactly 1.0 on every multiplier',
    numeric(clear).filter(([, v]) => v !== 1).length, 0);
  eq('A2 and has no wind in it', clear.windBias, 0);

  let worst = 1, worstName = '';
  for (const id of CONDITION_IDS) {
    const m = weatherMods({ id, strength: 1 });
    for (const [k, v] of numeric(m)) {
      const away = Math.max(v, 1 / v);
      if (away > worst) { worst = away; worstName = `${id}.${k}=${f(v, 2)}`; }
    }
  }
  lines.push(`      furthest any multiplier gets from 1.0: ${worstName} (x${f(worst, 2)})`);
  le('A3 nothing is more than a factor of three from neutral — a modifier, not a mode',
    worst, 3);
  ok('A4 every condition declares a weight, a label and a note',
    CONDITION_IDS.every((id) => CONDITIONS[id].weight > 0 && CONDITIONS[id].label &&
      CONDITIONS[id].note));
  ok('A5 and three words for its strength, so nothing ever reads "Hard windy"',
    CONDITION_IDS.every((id) => Array.isArray(CONDITIONS[id].steps) &&
      CONDITIONS[id].steps.length === 3));
  ok('A6 the table is frozen', Object.isFrozen(CONDITIONS));
  ok('A7 and so is what it hands out, so nothing can write a modifier back into it',
    Object.isFrozen(weatherMods({ id: 'rain', strength: 1 })));

  // strength scales toward 1 rather than switching condition
  const half = weatherMods({ id: 'rain', strength: 0.5 });
  const full = weatherMods({ id: 'rain', strength: 1 });
  ok('A8 half strength sits between clear and full',
    half.fireSpread > full.fireSpread && half.fireSpread < 1,
    `1.00 / ${f(half.fireSpread, 3)} / ${f(full.fireSpread, 3)}`);
  eq('A9 zero strength is indistinguishable from clear',
    weatherMods({ id: 'rain', strength: 0 }).fireSpread, 1);
  eq('A10 an unknown condition falls back to clear rather than throwing',
    weatherMods({ id: 'blizzard', strength: 1 }).fireSpread, 1);
  eq('A11 and so does nothing at all', weatherMods(null).fireSpread, 1);

  eq('A12 describeWeather says something for every condition',
    CONDITION_IDS.filter((id) => !describeWeather({ id, strength: 0.7 })).length, 0);
  eq('A13 a light one and a hard one read differently',
    describeWeather({ id: 'rain', strength: 0.2 }) === describeWeather({ id: 'rain', strength: 1 }),
    false);
  ok('A14 and none of them is a word glued to a word',
    !/Hard \w+y\b/.test(CONDITION_IDS.map((id) => describeWeather({ id, strength: 1 })).join(' ')),
    CONDITION_IDS.map((id) => describeWeather({ id, strength: 1 })).join(', '));

  // the state accessor, which is what everything actually calls
  eq('A15 weatherFor(null) is clear', weatherFor(null).fireSpread, 1);
  eq('A16 weatherFor on a state with no weather is clear', weatherFor({}).fireSpread, 1);
  eq('A17 weatherFor reads the state\'s weather, not the state',
    weatherFor({ weather: { id: 'heat', strength: 1 } }).fireSpread,
    weatherMods({ id: 'heat', strength: 1 }).fireSpread);
  const st = { weather: { id: 'rain', strength: 1 } };
  eq('A18 and caches it, so a per-cell read is not a per-cell allocation',
    weatherFor(st), weatherFor(st));
  st.weather = { id: 'heat', strength: 1 };
  ok('A19 but notices when the weather changes',
    weatherFor(st).fireSpread > 1, `${weatherFor(st).fireSpread}`);
emit('A done');
}

/* ── B. the roll ─────────────────────────────────────────────────────────── */

function sectionB() {
lines.push('--- B. two hundred shifts of weather ---');
  const counts = {};
  let repeats = 0, prev = null;
  for (let i = 0; i < 200; i++) {
    const w = rollWeather(new Rng((1000 + i * 7919) >>> 0, 'w'), prev);
    counts[w.id] = (counts[w.id] || 0) + 1;
    if (w.id === prev) repeats++;
    prev = w.id;
  }
  lines.push('      ' + CONDITION_IDS.map((id) => `${id} ${counts[id] || 0}`).join(' · ') +
    `  ·  back-to-back repeats ${repeats}/199`);
  eq('B1 every condition in the table actually turns up',
    CONDITION_IDS.filter((id) => !counts[id]).length, 0, JSON.stringify(counts));
  ok('B2 and none of them dominates the season',
    Math.max(...Object.values(counts)) < 120, JSON.stringify(counts));
  le('B3 yesterday is unlikely to be today as well', repeats, 60);
  gt('B4 but not impossible — "it rained again" is a thing that happens', repeats, 0);

  eq('B5 the same seed rolls the same weather',
    rollWeather(new Rng(42, 'w')).id, rollWeather(new Rng(42, 'w')).id);
  ok('B6 a different seed does not always agree',
    new Set([7, 8, 9, 10, 11, 12].map((s) => rollWeather(new Rng(s, 'w')).id)).size > 1);

  const rolls = Array.from({ length: 80 }, (_, i) => rollWeather(new Rng((3 + i * 104729) >>> 0, 'w')));
  ok('B7 every roll has a wind direction, calm or not',
    rolls.every((w) => Number.isFinite(w.windDir) && w.windDir >= 0 && w.windDir <= Math.PI * 2));
  ok('B8 clear has no strength', rolls.filter((w) => w.id === 'clear').every((w) => w.strength === 0));
  ok('B9 and everything else is at least CONFIG.weather.minStrength',
    rolls.filter((w) => w.id !== 'clear')
      .every((w) => w.strength >= CONFIG.weather.minStrength && w.strength <= 1));
  ok('B10 with more than one strength among them',
    new Set(rolls.filter((w) => w.id !== 'clear').map((w) => w.strength.toFixed(3))).size > 3);

  // the stream is its own
  clearSave();
  const g = new Game({ seed: 900 });
  g.startShift();
  ok('B11 a shift has weather', !!g.state.weather && CONDITION_IDS.includes(g.state.weather.id));
  clearSave();
  const h = new Game({ seed: 900 }); h.startShift();
  eq('B12 the same seed gives the same shift the same weather',
    h.state.weather.id, g.state.weather.id);
  eq('B13 and the same wind', h.state.weather.windDir, g.state.weather.windDir);
emit('B done');
}

/* ── C. is it observable ─────────────────────────────────────────────────── */

function sectionC() {
lines.push('--- C. the same fire, five conditions: a difference you can see from the cab ---');
  const burnAt90 = {};
  for (const id of CONDITION_IDS) {
    clearSave();
    const g = new Game({ seed: 5150 });
    g.startShift();
    force(g, id, 1, 0);
    const { inc, fire } = fireAt(g, 'farmhouse', 2);
    burn(g, 90000, inc);
    burnAt90[id] = fireDamageFraction(fire);
  }
  lines.push('      burnt at 90 s: ' +
    CONDITION_IDS.map((id) => `${id} ${f(burnAt90[id] * 100, 0)}%`).join(' · '));

  gt('C1 an unattended fire still eats the building in every condition', burnAt90.clear, 0.1);
  ok('C2 rain visibly slows it', burnAt90.rain < burnAt90.clear * 0.75,
    `${f(burnAt90.rain, 3)} vs ${f(burnAt90.clear, 3)}`);
  ok('C3 a cold snap slows it too, less', burnAt90.cold < burnAt90.clear &&
    burnAt90.cold > burnAt90.rain, `${f(burnAt90.cold, 3)}`);
  ok('C4 heat drives it', burnAt90.heat > burnAt90.clear * 1.4,
    `${f(burnAt90.heat, 3)} vs ${f(burnAt90.clear, 3)}`);
  ok('C5 and wind does NOT change how fast a room burns — it changes where it goes next',
    Math.abs(burnAt90.wind - burnAt90.clear) < 0.02,
    `${f(burnAt90.wind, 3)} vs ${f(burnAt90.clear, 3)}`);
  emit('running C');

  /* Gas, the other direction. A windy night is the only one that helps. */
  const gasLeft = {};
  for (const id of ['clear', 'wind']) {
    clearSave();
    const g = new Game({ seed: 5151 });
    g.startShift();
    force(g, id, 1, 0);
    const s = g.state;
    const b = BUILDING_BY_ID.hardware;
    const gas = { id: 'hzG', kind: 'gas', buildingId: b.id, x: b.door.x, y: b.door.y,
      ppm: 1.0, shutOff: true, resolved: false, incidentId: null };
    s.hazards.push(gas);
    burn(g, 20000, null);
    gasLeft[id] = gas.ppm;
  }
  ok('C6 a shut-off leak clears faster in the wind', gasLeft.wind < gasLeft.clear,
    `${f(gasLeft.wind, 3)} vs ${f(gasLeft.clear, 3)}`);

  /* The road. Rain is the trade: time on the fire, paid for on the way there.
   *
   * A real responder in the cab with the throttle held down — the first version of this
   * wrote `ap.speed` by hand and passed a null input, so stepApparatusMovement never ran
   * at all (it only steps a truck somebody is DRIVING) and the assertion compared 99 to
   * 99. A measurement that does not go through the code it is measuring is not one. */
  const topSpeed = {};
  for (const id of ['clear', 'rain']) {
    clearSave();
    const g = new Game({ seed: 5152 });
    g.startShift();
    force(g, id, 1, 0);
    const s = g.state;
    const ap = s.apparatus[0];
    const p = s.player;
    ap.x = 60; ap.y = 152; ap.angle = 0; ap.speed = 0;
    p.inVehicleId = ap.id; ap.driverId = p.id; ap.passengerIds = [p.id];
    const inp = makeBotInput();
    inp.hold('moveUp');                        // throttle, flat out
    for (let t = 0; t < 14000; t += STEP) {
      s.dispatch.nextCallAtMs = 1e9;
      if (ap.x > 380) { ap.x = 60; }           // loop the straight rather than run out of road
      g.frame(STEP, inp);
    }
    topSpeed[id] = ap.speed;
  }
  lines.push(`      top speed on Main Street: clear ${f(topSpeed.clear, 2)} m/s, ` +
    `rain ${f(topSpeed.rain, 2)} m/s`);
  ok('C7 wet tarmac costs the engine its top speed', topSpeed.rain < topSpeed.clear,
    `${f(topSpeed.rain, 2)} vs ${f(topSpeed.clear, 2)} m/s`);
  gt('C8 but it is still a truck, not a bicycle', topSpeed.rain, topSpeed.clear * 0.7);

  /* The patient clock. A cold snap is the only condition that touches it. */
  const left = {};
  for (const id of ['clear', 'cold']) {
    clearSave();
    const g = new Game({ seed: 5153 });
    g.startShift();
    force(g, id, 1, 0);
    const s = g.state;
    const v = createVictim({ incidentId: null, x: 200, y: 200, severity: 'critical' });
    s.victims.push(v);
    burn(g, 60000, null);
    left[id] = v.condition;
  }
  ok('C9 a casualty declines faster in a cold snap', left.cold < left.clear,
    `${f(left.cold, 3)} vs ${f(left.clear, 3)}`);
  gt('C10 but is not simply killed by the weather', left.cold, 0);
emit('C done');
}

/* ── D. the wind decides where it goes next ──────────────────────────────── */

function sectionD() {
lines.push('--- D. the wind decides WHICH building catches ---');

  /* The number that forced the design. If almost every fire has one exposure or none, a
     rule that re-ranks the candidates has no outputs — and the first version of this did
     exactly that, and measured as doing nothing at all. */
  let none = 0, one = 0, several = 0;
  for (const a of BUILDINGS) {
    if (a.kind === 'station' || a.kind === 'clinic') continue;
    let n = 0;
    for (const b of BUILDINGS) {
      if (a.id === b.id || b.kind === 'station' || b.kind === 'clinic') continue;
      const gx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
      const gy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
      if (Math.hypot(gx, gy) <= CONFIG.fire.jumpDistM) n++;
    }
    if (!n) none++; else if (n === 1) one++; else several++;
  }
  lines.push(`      buildings with 0 / 1 / 2+ exposures inside ${CONFIG.fire.jumpDistM} m: ` +
    `${none} / ${one} / ${several}`);
  eq('D1 no building in this town has two exposures to choose between', several, 0);
  gt('D2 so the wind must change the REACH, not the ranking', none + one, 0);

  eq('D3 downwindFactor is 1 straight downwind',
    downwindFactor({ windDir: 0 }, 0, 0, 10, 0), 1);
  eq('D4 0 straight upwind', downwindFactor({ windDir: 0 }, 0, 0, -10, 0), 0);
  eq('D5 and a half across it',
    Number(downwindFactor({ windDir: 0 }, 0, 0, 0, 10).toFixed(6)), 0.5);
  eq('D6 a point on top of the fire is neither', downwindFactor({ windDir: 0 }, 5, 5, 5, 5), 0.5);

  const home = BUILDING_BY_ID.farmhouse, barn = BUILDING_BY_ID.barn;
  const bearing = Math.atan2((barn.y + barn.h / 2) - (home.y + home.h / 2),
    (barn.x + barn.w / 2) - (home.x + home.w / 2));

  const trial = (windDir, id = 'wind') => {
    let caught = 0;
    for (let seed = 0; seed < 10; seed++) {
      clearSave();
      const g = new Game({ seed: 6000 + seed });
      g.startShift();
      force(g, id, 1, windDir);
      const { inc } = fireAt(g, 'farmhouse', 4);
      burn(g, 150000, inc);
      if (g.state.hazards.some((h) => h.kind === 'fire' && h.buildingId === 'barn')) caught++;
    }
    return caught;
  };
  const downwind = trial(bearing);
  emit('running D');
  const upwind = trial(bearing + Math.PI);
  const still = trial(0, 'clear');
  lines.push(`      Miller Barn caught: ${downwind}/10 downwind, ${upwind}/10 upwind, ` +
    `${still}/10 in still air`);

  ge('D7 the wind carries it to the building it is blowing at', downwind, 8);
  le('D8 and does not carry it to the one behind the fire', upwind, 2);
  gt('D9 which is a real difference, not noise', downwind - upwind, 5);
  ge('D10 still air is the nearest-building rule it always was', still, 8);
emit('D done');
}

/* ── E. the law ──────────────────────────────────────────────────────────── */

function sectionE() {
lines.push('--- E. weather may not create a call, close one, or make a shift unwinnable ---');
  /* ⚠ THREE SEEDS PER CONDITION, NOT ONE. "A crew can still close a call in every
     condition" is a claim about the GAME, and it was being decided by a single shift each
     — so it reported heat:0 the first time an unrelated change to the bot reshuffled that
     one shift. One shift is not evidence that a condition is unwinnable; it is evidence
     that one shift went badly, which is what the design intends to be possible. */
  const E_SEEDS = [4242, 101, 505];
  const rows = [];
  for (const id of CONDITION_IDS) {
    const agg = { calls: 0, controlled: 0, lost: 0, confidenceEnd: 0, incidents: [] };
    let nan = 0;
    for (const seed of E_SEEDS) {
      clearSave();
      const g = new Game({ seed });
      g.startShift();
      force(g, id, 1, 0.6);
      const bot = new CrewBot(g);
      const s = g.state;
      for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
        bot.think();
        g.frame(STEP, bot.input);
        if (s.mode !== MODES.PLAYING) break;
      }
      if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
      agg.calls += s.report.calls;
      agg.controlled += s.report.controlled;
      agg.lost += s.report.lost;
      agg.confidenceEnd += s.report.confidenceEnd / E_SEEDS.length;
      agg.incidents.push(...s.report.incidents);
      nan += nonFinite(s);
      emit(`running E, ${id}, seed ${seed}`);
    }
    rows.push({ id, r: agg, nan });
  }
  for (const { id, r } of rows) {
    lines.push(`      ${id.padEnd(6)} ${r.calls} calls · ${r.controlled} controlled · ` +
      `${r.lost} lost · confidence ${f(r.confidenceEnd * 100, 0)}%`);
  }

  ok('E1 every condition produces a shift with calls in it',
    rows.every((x) => x.r.calls > 0), rows.map((x) => `${x.id}:${x.r.calls}`).join());
  ok('E2 and a crew can still close them in every one of them',
    rows.every((x) => x.r.controlled > 0), rows.map((x) => `${x.id}:${x.r.controlled}`).join());
  ok('E3 no condition leaves the town on the floor',
    rows.every((x) => x.r.confidenceEnd > 0.05),
    rows.map((x) => `${x.id}:${f(x.r.confidenceEnd, 2)}`).join());
  ok('E4 and none of them puts anything non-finite in the state',
    rows.every((x) => x.nan === 0), rows.map((x) => `${x.id}:${x.nan}`).join());
  ok('E5 the worst condition is measurably harder than the best',
    Math.min(...rows.map((x) => x.r.confidenceEnd)) < Math.max(...rows.map((x) => x.r.confidenceEnd)));

  // it must not invent calls of its own
  const families = new Set(rows.flatMap((x) => x.r.incidents.map((i) => i.headline)));
  ok('E6 and it invented no call of its own',
    ![...families].some((h) => /weather|storm|wind|rain|snow/i.test(h)), [...families].join(' | '));
  emit('running E, the medical chain');

  /* The one the weather actually threatened.
   *
   * m5 section C asserts the medical chain completes end to end in a real bot shift, and
   * adding weather broke it: its two seeds roll `wind` and `heat`, and the casualty was
   * loaded with the shift ending before the ambulance reached the clinic. m5 now pins
   * itself to clear conditions, because a gate has to control its variables — so the
   * question "can weather make the chain impossible?" moved here, where it is the
   * subject rather than the noise.
   *
   * Measured on those same two seeds, two crew: the chain completes in clear, in wind
   * and in a cold snap, and does not in rain or heat. Rain is the surprising one — its
   * only medical effect is 18% off the ambulance's top speed — and the rest of it is
   * emergent: a slower fire is less hazard pressure, dispatch is pressure-aware, and so
   * a wet shift is a BUSIER shift. Three of five is the assertion; five of five would be
   * a weather system that does not matter. */
  const delivered = {};
  for (const id of CONDITION_IDS) {
    let n = 0;
    /* Four seeds, not two: a 0-or-1 count per condition has no resolution, and E9 below
       needs to see a DIFFERENCE between conditions rather than a wall. */
    for (const seed of [101, 303, 505, 707]) {
      clearSave();
      const g = new Game({ seed });
      g.startShift();
      force(g, id, 1, 0.4);
      const s = g.state;
      toggleCoop(s);
      const board = { claims: new Map(), trucks: new Map() };
      const bots = s.responders.map((r) => new CrewBot(g, r.id, board));
      bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : 'p2'); });
      const input = mergeBotInputs(bots.map((b) => b.input));
      for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
        for (const b of bots) b.think();
        g.frame(STEP, input);
        if (s.mode !== MODES.PLAYING) break;
      }
      n += s.victims.filter((v) => v.delivered).length;
    }
    delivered[id] = n;
    emit(`running E, medical in ${id}`);
  }
  lines.push('      casualties delivered to the clinic: ' +
    CONDITION_IDS.map((id) => `${id} ${delivered[id]}`).join(' · '));
  gt('E7 a casualty still reaches the clinic in clear conditions', delivered.clear, 0);
  ge('E8 and in at least three of the five conditions — weather is a difficulty, not a wall',
    CONDITION_IDS.filter((id) => delivered[id] > 0).length, 3);
  /* ⚠ "AT LEAST ONE CONDITION IS A WALL" IS NOT THE CLAIM — E8 directly above says the
     opposite, that weather is a difficulty and not a wall. This line asked for a zero
     because, on two seeds and a bot that walked most of the shift, there always was one.
     With four seeds and a crew that drives, every condition delivers somebody, and the
     thing worth asserting is that weather still CHANGES the number. */
  gt('E9 while the weather still changes how many of them make it',
    Math.max(...CONDITION_IDS.map((id) => delivered[id])),
    Math.min(...CONDITION_IDS.map((id) => delivered[id])));
emit('E done');
}

/* ── F. it carries, and it is on the page ────────────────────────────────── */

function sectionF() {
lines.push('--- F. recent weather, and saying so ---');
  clearSave();
  const g = new Game({ seed: 7000 });
  g.startShift();
  const first = g.state.weather.id;
  g.state.simTimeMs = CONFIG.shift.durationMs;
  g.endShift();
  eq('F1 the shift banks what the weather was', g.town.lastWeather, first);
  saveTown(g.town);
  eq('F2 and it survives a real save/load', loadTown().lastWeather, first);

  const t = migrate({ version: 1, shiftNumber: 3, confidence: 0.5, buildings: {},
    hydrants: {}, history: [], learned: {}, lastWeather: 'monsoon' });
  eq('F3 a condition that is not in the table is refused rather than believed',
    t.lastWeather, null);
  eq('F4 a save from before weather existed simply has none',
    migrate({ version: 1, shiftNumber: 3, confidence: 0.5, buildings: {}, hydrants: {},
      history: [] }).lastWeather, null);
  eq('F5 a fresh town has none either', defaultTown().lastWeather, null);
  eq('F6 advanceShift carries it forward',
    advanceShift({ ...defaultTown(), lastWeather: 'rain' }, 'x').lastWeather, 'rain');

  // over a run of shifts the weather changes
  clearSave();
  const h = new Game({ seed: 7001 });
  const seen = [];
  for (let i = 0; i < 6; i++) {
    h.startShift();
    seen.push(h.state.weather.id);
    h.state.simTimeMs = CONFIG.shift.durationMs;
    h.endShift();
  }
  lines.push(`      six shifts: ${seen.join(' → ')}`);
  gt('F7 six shifts are not all the same weather', new Set(seen).size, 1);

  // and the shift says so, in the two places a player reads
  clearSave();
  const q = new Game({ seed: 7002 });
  q.startShift();
  force(q, 'rain', 1, 0);
  const said = q.state.radio.map((l) => l.text).join(' ');
  ok('F8 the roll-call line names the conditions', /Clear|wind|rain|Cold|Heat|Warm/i.test(said),
    said.slice(0, 120));
  q.state.simTimeMs = CONFIG.shift.durationMs;
  q.endShift();
  ok('F9 and the report carries it', !!q.state.report.weather &&
    q.state.report.weather.id === 'rain');
  ok('F10 in words, in the standfirst', /rain/i.test(q.state.report.standfirst),
    q.state.report.standfirst);

  clearSave();
  const c = new Game({ seed: 7003 });
  c.startShift();
  force(c, 'clear', 0, 0);
  c.state.simTimeMs = CONFIG.shift.durationMs;
  c.endShift();
  ok('F11 a clear night does not pad the standfirst with a sentence about nothing',
    !/all shift/i.test(c.state.report.standfirst), c.state.report.standfirst);

  /* The client draws; it does not simulate. So it needs none of the multipliers and all
     of the appearance — a partner watching a rainstorm under a clear sky, with the smoke
     going the wrong way while the host's fire jumps downwind, is watching a different
     game. Three numbers. */
  clearSave();
  const host = new Game({ seed: 7010 });
  host.startShift();
  force(host, 'wind', 0.83, 2.4);
  clearSave();
  const client = new Game({ seed: 1 });
  client.startShift();
  const snap = JSON.parse(JSON.stringify(encodeSnapshot(host.state)));
  eq('F12 the snapshot is accepted', applySnapshot(client.state, snap), true);
  eq('F13 the client has the host\'s condition', client.state.weather.id, 'wind');
  ok('F14 and its wind, to a thousandth of a radian',
    Math.abs(client.state.weather.windDir - 2.4) < 0.002, `${client.state.weather.windDir}`);
  ok('F15 and its strength', Math.abs(client.state.weather.strength - 0.83) < 0.002,
    `${client.state.weather.strength}`);
  ok('F16 which costs three numbers, not an object',
    Array.isArray(snap.we) && snap.we.length === 3, JSON.stringify(snap.we));
  eq('F17 and the client resolves the same multipliers the host did',
    weatherFor(client.state).fireJump, weatherFor(host.state).fireJump);
emit(null);
}

function nonFinite(root) {
  let bad = 0;
  const seen = new Set();
  const walk = (o, d) => {
    if (d > 6 || !o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const v of Object.values(o)) {
      if (typeof v === 'number') { if (!Number.isFinite(v)) bad++; }
      else if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(root, 0);
  return bad;
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE(); sectionF();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
