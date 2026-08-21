/* The station between shifts — the GDD's "vehicle damage and location" and "equipment
 * location and consumables", the last two entries on its persistence list.
 *
 * This is the only carry-over the player causes ENTIRELY BY HAND, which makes it the one
 * most likely to feel like an ambush rather than a consequence. The GDD asks for it
 * directly — "missing, depleted, damaged, or badly parked apparatus should create
 * improvisation" — and rule 9 asks for the failure to be recoverable, so most of this
 * suite is about the line between the two.
 *
 * What tools/_stationdiag.js measured, and what is therefore worth locking:
 *   - a truck on the apron is re-parked and refilled; one at the junction, 70 m away, is
 *     where you left it with what was in the tank;
 *   - ...and the first version measured against each truck's OWN BAY, which made parking
 *     neatly beside the apron rack read as abandoned at 43 m. The bays are 16 m apart;
 *     the test has to be "did it get back to the station";
 *   - a dented engine is repaired over three shifts, 0.90 -> 0.60 -> 0.30 -> whole, so a
 *     bad night is a slow truck for a shift or two rather than for ever;
 *   - the WORST hand-over a shift can make — three trucks scattered, every tank dry, all
 *     of them at 80% damage and nine tools in a field — still closes a call: 1 of 7
 *     against 2 of 6 from a clean station. Measurably worse, and not a wall.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES } from '../src/game.js';
import {
  clearSave, loadTown, saveTown, defaultTown, migrate, advanceShift,
} from '../src/core/persistence.js';
import { STATION, BUILDING_BY_ID, dist, atStation } from '../src/data/town.js';
import { APPARATUS_DEFS } from '../src/data/equipment.js';
import { reportCard } from '../src/ui/hud.js';
import { CrewBot } from './_crewbot.js';

const STEP = CONFIG.sim.stepMs;
const TIDY = CONFIG.town.stationTidyRadiusM;

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

/** End a shift with the station left in a given state; hand back the town and report. */
function bankWith(mutate, seed = 300) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  mutate(g.state);
  g.state.simTimeMs = CONFIG.shift.durationMs;
  g.endShift();
  saveTown(g.town);
  return { town: loadTown(), report: g.state.report, game: g };
}

/* ── A. did it get back to the station ───────────────────────────────────── */

function sectionA() {
lines.push('--- A. the line between "nearly back" and "left at the junction" ---');
  const a = STATION.apron;
  ok('A1 the middle of the apron is at the station', atStation(a.x + a.w / 2, a.y + a.h / 2, TIDY));
  ok('A2 so is every bay', STATION.bays.every((b) => atStation(b.x, b.y, TIDY)));
  ok('A3 and the apron rack', atStation(STATION.rack.x, STATION.rack.y, TIDY));
  ok('A4 and the spawn point somebody clocks on at',
    atStation(STATION.spawn.x, STATION.spawn.y, TIDY));

  /* The bug this replaced: measured against each truck's OWN bay, the apron rack sat
     43 m from the engine's bay and parking there read as abandoned. The bays are 16 m
     apart, so the westmost truck's bay is most of the forecourt from the eastmost. */
  const bay0 = STATION.bays[0];
  gt('A5 the rack really is far from the westmost bay — which is why the bay test failed',
    dist(STATION.rack.x, STATION.rack.y, bay0.x, bay0.y), TIDY);
  ok('A6 but it is plainly at the station', atStation(STATION.rack.x, STATION.rack.y, TIDY));

  ok('A7 Miller Barn is not at the station', !atStation(320, 74, TIDY));
  ok('A8 nor is the junction', !atStation(150, 152, TIDY));
  ok('A9 nor the clinic', !atStation(372, 116, TIDY));
  ok('A10 it takes a radius, not a config read, so town.js still imports nothing',
    atStation(300, 300, 1e6) === true && atStation(300, 300, 1) === false);
emit('A done');
}

/* ── B. what a shift banks ───────────────────────────────────────────────── */

function sectionB() {
lines.push('--- B. a truck left out is left out; one brought back is put away ---');

  const tidy = bankWith((s) => {
    const ap = s.apparatus[0];
    ap.x = STATION.rack.x; ap.y = STATION.rack.y; ap.waterL = 100; ap.damage = 0;
  });
  eq('B1 a truck parked at the station banks nothing at all',
    tidy.town.apparatus.engine, undefined);
  eq('B2 and the report does not list it as out',
    tidy.report.nextShift.apparatusOut.length, 0);

  const dented = bankWith((s) => {
    const ap = s.apparatus[0];
    ap.x = STATION.rack.x; ap.y = STATION.rack.y; ap.damage = 0.5;
  });
  ok('B3 unless it came back dented, which is worth remembering',
    !!dented.town.apparatus.engine && dented.town.apparatus.engine.home === true);
  ok('B4 and then it is two fields, not a position it does not need',
    dented.town.apparatus.engine.x === undefined);

  /* A truck the bell caught out on a call drives itself home, because ending a shift at
     a call is not a mistake — it is what the last ten minutes of every shift look like.
     What stays out is what cannot drive. */
  const busy = bankWith((s) => {
    const ap = s.apparatus[0];
    ap.x = 320; ap.y = 74; ap.waterL = 250; ap.damage = 0.2;
  });
  ok('B4b a truck caught out on a call at the bell brings itself back',
    (busy.town.apparatus.engine || {}).home !== false,
    JSON.stringify(busy.town.apparatus.engine));
  eq('B4c and the report does not scold anybody for finishing a job',
    busy.report.nextShift.apparatusOut.length, 0);

  const out = bankWith((s) => {
    const ap = s.apparatus[0];
    ap.x = 320; ap.y = 74; ap.angle = 1.2; ap.waterL = 250; ap.damage = 0.95;
  });
  const rec = out.town.apparatus.engine;
  ok('B5 a truck WRECKED at the barn is recorded where it stands', !!rec && rec.home === false);
  ok('B6 to the metre', Math.abs(rec.x - 320) < 0.01 && Math.abs(rec.y - 74) < 0.01,
    `${rec.x},${rec.y}`);
  eq('B7 facing the way it was left', Math.abs(rec.angle - 1.2) < 0.001, true);
  eq('B8 with what was left in the tank', rec.waterL, 250);
  /* Less one shift of the department's repair: `bankWith` hands back the town AFTER
     advanceShift, which is the town the next shift actually loads. */
  ok('B9 and the damage it collected, less a night in the shop',
    Math.abs(rec.damage - (0.95 - CONFIG.town.apparatusRepairPerShift)) < 1e-9, `${rec.damage}`);
  eq('B10 and the report says where it is', out.report.nextShift.apparatusOut.length, 1);
  ok('B11 by name and by place',
    /Engine/.test(out.report.nextShift.apparatusOut[0].name) &&
    out.report.nextShift.apparatusOut[0].where.length > 3,
    JSON.stringify(out.report.nextShift.apparatusOut[0]));
  eq('B12 with the tank reading, because that is the decision it makes for tomorrow',
    out.report.nextShift.apparatusOut[0].waterL, 250);

  // tools: on the ground and away from the station is the only case that banks
  const kit = bankWith((s) => {
    const saw = s.tools.find((t) => t.defId === 'chainsaw');
    saw.carrier = null; saw.x = 300; saw.y = 70;
    const med = s.tools.find((t) => t.defId === 'medkit');
    med.carrier = null; med.x = STATION.rack.x + 3; med.y = STATION.rack.y + 2;
  });
  eq('B13 kit dropped in the field is written down', Object.keys(kit.town.tools).length, 1);
  /* The hose is not kit. It is tethered to its engine and lies on the ground the whole
     time it is being worked, so the rule above filed it as lost on every shift that ever
     fought a fire — and the next shift started with the nozzle two hundred metres from
     the appliance. Six bot shifts closed 2 calls instead of 9. */
  const hosed = bankWith((s) => {
    const hose = s.tools.find((t) => t.defId === 'hose');
    hose.carrier = null; hose.x = 300; hose.y = 70; hose.deployedM = 20;
  });
  eq('B13b a deployed hose is a hose that needs rewinding, not kit anybody lost',
    Object.keys(hosed.town.tools).length, 0);
  eq('B13c and the report does not tell the crew they lost their own nozzle',
    hosed.report.nextShift.toolsOut.length, 0);
  ok('B14 and the report names it and where',
    kit.report.nextShift.toolsOut.length === 1 && /Chainsaw/i.test(kit.report.nextShift.toolsOut[0].name),
    JSON.stringify(kit.report.nextShift.toolsOut));
  ok('B15 kit dropped on the forecourt is somebody putting it away, not losing it',
    !Object.values(kit.town.tools).some((t) => atStation(t.x, t.y, TIDY)));

  const held = bankWith((s) => {
    const saw = s.tools.find((t) => t.defId === 'chainsaw');
    saw.carrier = s.player.id; saw.x = 300; saw.y = 70;
  });
  eq('B16 a tool still in somebody\'s hands at the bell is put back, not dropped',
    Object.keys(held.town.tools).length, 0);
emit('B done');
}

/* ── C. and a shift reads it back ────────────────────────────────────────── */

function sectionC() {
lines.push('--- C. clocking on to the station you left ---');
  const { town } = bankWith((s) => {
    const ap = s.apparatus[0];
    ap.x = 320; ap.y = 74; ap.angle = 1.2; ap.waterL = 250; ap.damage = 0.95;
    const saw = s.tools.find((t) => t.defId === 'chainsaw');
    saw.carrier = null; saw.x = 300; saw.y = 70;
  });

  clearSave();
  saveTown(town);
  const g = new Game({ seed: 301 });
  g.startShift();
  const s = g.state;
  const eng = s.apparatus.find((a) => a.id === 'engine');
  ok('C1 the engine is where it was left', Math.abs(eng.x - 320) < 0.01 && Math.abs(eng.y - 74) < 0.01,
    `${f(eng.x, 1)},${f(eng.y, 1)}`);
  ok('C2 still wrecked', Math.abs(eng.damage - 0.65) < 0.001,
    `${f(eng.damage, 3)} — 0.95 less one shift of repair`);
  le('C3 and still short of water', eng.waterL, 250);
  const saw = s.tools.find((t) => t.defId === 'chainsaw');
  eq('C4 the chainsaw is on the ground, not back on the truck', saw.carrier, null);
  ok('C5 where it was left', Math.abs(saw.x - 300) < 0.01 && Math.abs(saw.y - 70) < 0.01);

  const amb = s.apparatus.find((a) => a.id === 'ambulance');
  const bay = STATION.bays.find((b) => b.apparatusId === 'ambulance');
  ok('C6 a truck that was never mentioned is in its bay, exactly as before any of this',
    Math.abs(amb.x - bay.x) < 0.01 && Math.abs(amb.y - bay.y) < 0.01);
  eq('C7 with a full tank', amb.waterL, s.apparatusDefs.ambulance.tankL);
  eq('C8 and no damage', amb.damage, 0);

  // a fresh town is the station as it always was
  clearSave();
  const h = new Game({ seed: 302 });
  h.startShift();
  ok('C9 a first shift starts with every truck in its bay',
    h.state.apparatus.every((ap) => {
      const b = STATION.bays.find((q) => q.apparatusId === ap.id);
      return Math.abs(ap.x - b.x) < 0.01 && Math.abs(ap.y - b.y) < 0.01;
    }));
  ok('C10 and nothing on the ground but the rack',
    h.state.tools.filter((t) => t.carrier === null).length === 0);

  /* Tool ids are positional — tool1..toolN in loadout order — so the save is only sound
     as long as building the station twice numbers them the same way. */
  clearSave();
  const p = new Game({ seed: 303 }); p.startShift();
  clearSave();
  const q = new Game({ seed: 304 }); q.startShift();
  eq('C11 the station numbers its kit the same way every time',
    p.state.tools.map((t) => `${t.id}:${t.defId}`).join(),
    q.state.tools.map((t) => `${t.id}:${t.defId}`).join());
emit('C done');
}

/* ── D. it heals ─────────────────────────────────────────────────────────── */

function sectionD() {
lines.push('--- D. the department patches up its own trucks ---');
  let town = defaultTown();
  town.apparatus = { engine: { home: true, damage: 0.9 } };
  const trail = [];
  for (let i = 0; i < 6; i++) {
    town = advanceShift(town, `s${i}`);
    saveTown(town); town = loadTown();
    trail.push(town.apparatus.engine ? Number(town.apparatus.engine.damage.toFixed(3)) : null);
  }
  lines.push(`      damage 0.90 -> ${trail.map((v) => (v === null ? 'whole' : f(v, 2))).join(' -> ')}`);
  ok('D1 a dented truck gets better', trail[0] < 0.9, `${trail[0]}`);
  ok('D2 by the amount CONFIG says, every shift, unconditionally',
    Math.abs(trail[0] - (0.9 - CONFIG.town.apparatusRepairPerShift)) < 1e-9);
  eq('D3 and is eventually forgotten entirely', trail[trail.length - 1], null);
  le('D4 within four shifts — a bad night, not a bad season',
    trail.findIndex((v) => v === null) + 1, 4);

  /* The other half of the fixed-point lesson the buildings taught: a countdown that runs
     on a condition the countdown keeps true never finishes. This one is unconditional. */
  let t2 = defaultTown();
  t2.apparatus = { engine: { home: false, damage: 0.9, x: 320, y: 74, angle: 0, waterL: 0 } };
  for (let i = 0; i < 6; i++) { t2 = advanceShift(t2, 's'); saveTown(t2); t2 = loadTown(); }
  /* And the repair is what eventually brings a wrecked truck home. The countdown runs
     unconditionally and the homecoming hangs off it, so nothing here is gated on a
     condition the countdown itself keeps true — the whole of the boarded-building
     lesson, applied to a vehicle. */
  let t5 = defaultTown();
  t5.apparatus = { engine: { home: false, damage: 0.9, x: 320, y: 74, angle: 0, waterL: 0 } };
  const trail2 = [];
  for (let i = 0; i < 5; i++) {
    t5 = advanceShift(t5, 's'); saveTown(t5); t5 = loadTown();
    const r = t5.apparatus.engine;
    trail2.push(!r ? 'in' : r.home ? `in@${f(r.damage, 2)}` : `out@${f(r.damage, 2)}`);
  }
  lines.push(`      an engine wrecked at 0.90 and abandoned: ${trail2.join(' -> ')}`);
  eq('D5 it is still out there the morning after', trail2[0].startsWith('out'), true);
  ok('D6 and repaired where it lies — nobody has to drive it back first',
    trail2[0] === `out@${f(0.9 - CONFIG.town.apparatusRepairPerShift, 2)}`, trail2[0]);
  ok('D7 the shift it drops below undriveable, somebody drives it in',
    trail2.some((v) => v.startsWith('in')), trail2.join(','));
  eq('D8 and it is home for good after that', trail2[trail2.length - 1].startsWith('out'), false);
  le('D9 which takes a few shifts, not a season',
    trail2.findIndex((v) => v.startsWith('in')) + 1, 4);

  /* The other arm: nothing short of undriveable is ever left out, because the bell
     ringing while you are at a call is not a mistake anybody made. */
  let t3 = defaultTown();
  t3.apparatus = { rescue: { home: false, damage: 0.1, x: 320, y: 74, angle: 0, waterL: 0 } };
  t3 = advanceShift(t3, 's');
  eq('D10 a lightly dented truck is not abandoned anywhere', t3.apparatus.rescue, undefined);

  /* And the kit's own clock, which is shorter. A station does not write off a chainsaw:
     one shift without it is the consequence. Without a counter it lay in the field for
     ever, because a tool on the ground re-banks itself every night — the same shape as
     the boarded building and the struck hydrant, for the third time. */
  let t6 = defaultTown();
  t6.tools = { tool5: { x: 300, y: 70 } };
  const kitTrail = [];
  for (let i = 0; i < 3; i++) {
    t6 = advanceShift(t6, 's'); saveTown(t6); t6 = loadTown();
    kitTrail.push(Object.keys(t6.tools).length);
  }
  lines.push(`      a chainsaw dropped in a field: still out on ${kitTrail.join(', ')} of the next three shifts`);
  eq('D11 kit is still where you dropped it the next morning', kitTrail[0], 1);
  eq('D12 and somebody has been out and got it by the morning after', kitTrail[1], 0);
  eq('D13 and it stays got', kitTrail[2], 0);
  ok('D14 the counter survives a real save/load, or the retrieval never runs',
    (() => {
      let t7 = defaultTown();
      t7.tools = { tool5: { x: 300, y: 70 } };
      t7 = advanceShift(t7, 's'); saveTown(t7); t7 = loadTown();
      return t7.tools.tool5 && t7.tools.tool5.shiftsOut === 1;
    })());
emit('D done');
}

/* ── E. a hand-edited save cannot break the shift ────────────────────────── */

function sectionE() {
lines.push('--- E. a save is a file somebody can edit ---');
  const hostile = migrate({
    version: 1, shiftNumber: 3, confidence: 0.5, buildings: {}, hydrants: {}, history: [],
    apparatus: {
      engine: { home: false, damage: 99, x: 1e9, y: -1e9, angle: 'north', waterL: -50 },
      ghost: 'not an object',
      ambulance: { home: true, damage: NaN },
    },
    tools: { tool1: { x: NaN, y: 'over there' }, tool2: 7 },
  });
  ok('E1 a truck at x = 1e9 is brought back inside the world',
    hostile.apparatus.engine.x <= CONFIG.world.widthM && hostile.apparatus.engine.x >= 0,
    `${hostile.apparatus.engine.x}`);
  ok('E2 and at y = -1e9', hostile.apparatus.engine.y >= 0, `${hostile.apparatus.engine.y}`);
  eq('E3 damage is a fraction', hostile.apparatus.engine.damage, 1);
  eq('E4 a facing of "north" is a number', hostile.apparatus.engine.angle, 0);
  eq('E5 a negative tank is empty, not negative', hostile.apparatus.engine.waterL, 0);
  eq('E6 NaN damage is zero', hostile.apparatus.ambulance.damage, 0);
  eq('E7 a record that is not an object is dropped', hostile.apparatus.ghost, undefined);
  ok('E8 a tool at NaN is somewhere real',
    Number.isFinite(hostile.tools.tool1.x) && Number.isFinite(hostile.tools.tool1.y),
    JSON.stringify(hostile.tools.tool1));
  eq('E9 and a tool that is a number is dropped', hostile.tools.tool2, undefined);

  let threw = null;
  clearSave();
  saveTown(hostile);
  try {
    const g = new Game({ seed: 305 });
    g.startShift();
    for (let t = 0; t < 4000; t += STEP) g.frame(STEP, null);
  } catch (err) { threw = (err && err.message) || String(err); }
  eq('E10 and a shift starts on top of it without throwing', threw, null);

  eq('E11 a save from before any of this simply has none',
    Object.keys(migrate({ version: 1, shiftNumber: 2, confidence: 0.5, buildings: {},
      hydrants: {}, history: [] }).apparatus).length, 0);
  eq('E12 a fresh town has none either', Object.keys(defaultTown().apparatus).length, 0);
emit('E done');
}

/* ── F. recoverable, which is the whole question ─────────────────────────── */

function sectionF() {
lines.push('--- F. the worst hand-over a shift can make is still a shift (GDD rule 9) ---');
  /* One abandoned spot per appliance. Derived from APPARATUS_DEFS rather than written
     out as a literal count, because the fourth truck landing in m16 broke this section
     three ways at once: spots[3] was undefined, and F1/F3/F6 all asserted "3". */
  const spots = [[320, 74], [300, 260], [180, 60], [390, 200]];
  const nTrucks = APPARATUS_DEFS.length;
  const { town, report } = bankWith((s) => {
    s.apparatus.forEach((ap, i) => {
      const spot = spots[i % spots.length];
      ap.x = spot[0]; ap.y = spot[1]; ap.waterL = 0; ap.damage = 0.95;
    });
    for (const t of s.tools) {
      if (t.carrier === 'rack') continue;
      t.carrier = null; t.x = 340; t.y = 80;
    }
  });
  eq('F1 every truck is recorded as out', Object.keys(town.apparatus).length, nTrucks);
  gt('F2 and the kit with them', Object.keys(town.tools).length, 5);

  /* The warning is the difference between a consequence and an ambush, so it is asserted
     as hard as the mechanic is. */
  eq('F3 the report warned about every one of them', report.nextShift.apparatusOut.length, nTrucks);
  ok('F4 naming the place for each', report.nextShift.apparatusOut.every((a) => a.where && a.where.length > 3),
    JSON.stringify(report.nextShift.apparatusOut.map((a) => a.where)));
  gt('F5 and listed the kit', report.nextShift.toolsOut.length, 0);
  eq('F6 and the damage', report.nextShift.damagedApparatus.length, nTrucks);
  const card = reportCard(report);
  ok('F7 the card renders it, because a number nobody sees is not a feature',
    /Still out:/.test(card) && /Left in the field:/.test(card) && /In the shop:/.test(card));
  ok('F8 with a truck named in it', /Engine 1 at /.test(card), card.slice(card.indexOf('Still out'), card.indexOf('Still out') + 160));
  emit('running F');

  const walk = Math.min(...spots.map(([x, y]) => dist(STATION.spawn.x, STATION.spawn.y, x, y)));
  lines.push(`      nearest truck ${f(walk, 0)} m from the spawn point, ` +
    `${f(walk / CONFIG.player.maxSpeed, 0)} s at a jog`);
  le('F9 the nearest truck is a walk, not an expedition', walk / CONFIG.player.maxSpeed, 90);

  const play = (seed, withSave) => {
    clearSave();
    if (withSave) saveTown(town);
    const g = new Game({ seed });
    g.startShift();
    const bot = new CrewBot(g);
    const s = g.state;
    for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
      bot.think();
      g.frame(STEP, bot.input);
      if (s.mode !== MODES.PLAYING) break;
    }
    if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
    return s.report;
  };
  /* ⚠ THREE SEEDS PER ARM. "A crew inheriting the worst possible station still closes a
     call" is a claim about RECOVERABILITY — GDD rule 9 — and it was decided by a single
     shift, so it reported zero the first time an unrelated change to the bot reshuffled
     that one shift. One bad shift is not proof of an unrecoverable hand-over; it is proof
     that shifts can go badly, which is the design working. */
  const F_SEEDS = [4242, 101, 505];
  const arm = (withSave) => {
    const rs = F_SEEDS.map((seed) => play(seed, withSave));
    return {
      controlled: rs.reduce((n, r) => n + r.controlled, 0),
      calls: rs.reduce((n, r) => n + r.calls, 0),
      confidenceEnd: rs.reduce((n, r) => n + r.confidenceEnd, 0) / rs.length,
      each: rs.map((r) => r.controlled),
    };
  };
  const bad = arm(true);
  emit('running F, the control');
  const good = arm(false);
  lines.push(`      worst hand-over: ${bad.controlled}/${bad.calls} controlled (${bad.each.join('/')}), ` +
    `confidence ${f(bad.confidenceEnd * 100, 0)}%  ·  clean station: ` +
    `${good.controlled}/${good.calls} (${good.each.join('/')}), ${f(good.confidenceEnd * 100, 0)}%`);

  gt('F10 a crew inheriting the worst possible station still closes a call', bad.controlled, 0);
  gt('F11 and still gets calls to work', bad.calls, 0);
  gt('F12 and the town has not written them off', bad.confidenceEnd, 0.05);
  le('F13 but it is plainly harder than clocking on to a tidy station',
    bad.confidenceEnd, good.confidenceEnd);
emit('F done');
}

/* ── G. and it does not accumulate ───────────────────────────────────────── */

function sectionG() {
lines.push('--- G. six shifts of a crew that never puts anything away ---');

  /* Run it twice on the same seed: once as the game plays, and once with the station
     carry-over wiped between shifts. The second arm is the CONTROL — without it, "the
     town ends at 0% confidence" is a sentence about seed 55 rather than about this
     feature, and the first version of this assertion could not tell the difference. */
  const run = (carryOver) => {
    clearSave();
    const g = new Game({ seed: 55 });
    const rows = [];
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
      if (!carryOver) { g.town.apparatus = {}; g.town.tools = {}; saveTown(g.town); }
      rows.push({
        ap: Object.keys(g.town.apparatus).length,
        tools: Object.keys(g.town.tools).length,
        bytes: JSON.stringify(g.town).length,
        controlled: s.report.controlled,
        conf: s.report.confidenceEnd,
        worstDamage: Math.max(0, ...Object.values(g.town.apparatus).map((a) => a.damage)),
      });
      emit(`running G, ${carryOver ? 'carry-over' : 'control'} shift ${i}`);
    }
    return rows;
  };
  const rows = run(true);
  const control = run(false);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    lines.push(`      shift ${i + 1}: ${r.ap} apparatus · ${r.tools} tools out · ${r.bytes} B · ` +
      `${r.controlled} controlled · confidence ${f(r.conf * 100, 0)}% · worst damage ${f(r.worstDamage, 2)}` +
      `   (control: ${control[i].controlled} controlled, ${f(control[i].conf * 100, 0)}%)`);
  }

  le('G1 there are only as many trucks as the station has, so only that many can be out',
    Math.max(...rows.map((r) => r.ap)), APPARATUS_DEFS.length);
  le('G2 and the kit list cannot grow past the kit', Math.max(...rows.map((r) => r.tools)), 12);
  le('G3 the save is still nowhere near the quota it could fill',
    Math.max(...rows.map((r) => r.bytes)), 4096);
  le('G4 damage does not ratchet up shift on shift', Math.max(...rows.map((r) => r.worstDamage)), 1);

  /* The fixed point, asserted as a SHAPE rather than a floor: the number of trucks out
     must not climb to three and stay there, because somebody fetches one back every
     shift. Before that line existed it went 1, 2, 3, 3, 3, 3. */
  const last3 = rows.slice(-3).map((r) => r.ap);
  le('G5 the trucks do not all end up stranded for good — somebody fetches one back',
    Math.min(...last3), 2, last3.join(','));
  /* The kit list is the one that could grow without bound, because a tool lying in a
     field re-banks itself every night. It does not: what is out on any morning is what
     LAST NIGHT dropped, never the sum of every night — the retirement itself is asserted
     in section D. Half the kit is the bar; six shifts of a crew that tidies nothing
     measured 0, 0, 2, 2, 3, 3. */
  le('G6 the kit left out is a night\'s worth, not a season\'s',
    Math.max(...rows.map((r) => r.tools)), 6, rows.map((r) => r.tools).join(','));

  /* The honest comparison, and the assertion that caught the worst bug in this milestone.
   *
   * Written when carrying the station over cost the crew almost everything — 2 calls
   * closed over six shifts against a control's 7 — it read as a balance question and was
   * not one. The tool being banked every single shift was the HOSE LINE, which is
   * tethered to its engine and lies on the ground whenever it is being worked, so every
   * shift that fought a fire filed its own nozzle as lost kit and the next one began with
   * the engine unable to put water on anything. One line excluding it took the six-shift
   * total from 2 to 9.
   *
   * So the bar is not "harder is allowed" any more. Carrying the station over is not a
   * TAX: a crew that leaves the odd thing behind plays the same game as one that does
   * not, and the consequence is supposed to be a specific inconvenience you were warned
   * about, not a shift you cannot work. */
  const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0);
  const carried = sum(rows, 'controlled'), tidy = sum(control, 'controlled');
  lines.push(`      six shifts: carry-over ${carried} controlled, control ${tidy}`);
  gt('G7 a crew that leaves things behind still plays the game', carried, 0);
  le('G8 and is not quietly playing a much worse one — within a call a shift of the control',
    Math.max(0, tidy - carried), rows.length);
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE(); sectionF(); sectionG();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
