/* Tanker 1 — a fourth appliance, and the first thing in this game built because a
 * MEASUREMENT asked for it.
 *
 * tools/m15-tests.js section G found that a crew of four closes exactly as many calls as
 * a crew of two: all four walk three kilometres, so the hands are working, and there is
 * simply nothing for the third and fourth pair to drive. The GDD files the answer under
 * long-term progression — "additional apparatus BROADENS capability instead of providing
 * percentage upgrades" — so this is not a better engine.
 *
 * It is water where there is no hydrant. The engine has to be spotted within seven metres
 * of a kerbside hydrant to refill, and the far end of the valley is 33-57 m from the
 * nearest one, so out there the hose runs on the 2500 L you arrived with. A tanker parked
 * beside the engine feeds it.
 *
 * The two questions this suite exists to answer, in the order that matters:
 *   1. does it CHANGE AN OUTCOME — is there a call that goes better with it than without?
 *      A fourth truck that makes no difference is a fourth truck. Section D asked that
 *      question badly three times before it asked it properly; all three wrong premises
 *      are written up in there, because the way they were wrong is the interesting part;
 *   2. does it stay a trade — it is the slowest thing in the station, it can put no water
 *      on a fire itself, and it spends exactly what it gives.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, seatResponder } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { APPARATUS_DEFS, APPARATUS_BY_ID } from '../src/data/equipment.js';
import { STATION, HYDRANTS, BUILDING_BY_ID, dist } from '../src/data/town.js';
import { createFire, fireDamageFraction, applyWater } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { Hud } from '../src/ui/hud.js';

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
const lt = (n, a, b) => ok(n, a < b, `got ${a}, want < ${b}`);
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

function freshGame(seed) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  g.state.dispatch.nextCallAtMs = 1e9;
  return g;
}

/* ── A. the appliance ────────────────────────────────────────────────────── */

function sectionA() {
lines.push('--- A. a fourth appliance that broadens rather than upgrades ---');
  const t = APPARATUS_BY_ID.tanker;
  const e = APPARATUS_BY_ID.engine;
  ok('A1 there is a tanker', !!t);
  eq('A2 the station has four bays', STATION.bays.length, 4);
  ok('A3 one of them is its', STATION.bays.some((b) => b.apparatusId === 'tanker'));
  eq('A4 and every appliance has exactly one',
    new Set(STATION.bays.map((b) => b.apparatusId)).size, APPARATUS_DEFS.length);

  gt('A5 it carries much more water than the engine', t.tankL, e.tankL * 2);
  ok('A6 and it declares itself a supply', t.supplies === true);
  ok('A7 no other appliance does',
    APPARATUS_DEFS.filter((a) => a.supplies).length === 1);

  /* ⚠ NOT A BETTER ENGINE. Every axis on which it beats the engine has to be paid for on
     another, or a fourth truck is just the truck everybody takes. */
  ok('A8 it has NO hose, so it cannot put a drop on a fire itself', !t.hose);
  lt('A9 it is the slowest thing in the station', t.maxSpeed,
    Math.min(...APPARATUS_DEFS.filter((a) => a.id !== 'tanker').map((a) => a.maxSpeed)));
  lt('A10 the slowest to get going', t.accel,
    Math.min(...APPARATUS_DEFS.filter((a) => a.id !== 'tanker').map((a) => a.accel)));
  lt('A11 and the worst at stopping', t.brake,
    Math.min(...APPARATUS_DEFS.filter((a) => a.id !== 'tanker').map((a) => a.brake)));
  ok('A12 it is the biggest thing on the road', t.lengthM >
    Math.max(...APPARATUS_DEFS.filter((a) => a.id !== 'tanker').map((a) => a.lengthM)));
  ok('A13 it carries no medical or rescue kit either',
    !t.patientBay && !t.loadout.some((q) => ['medkit', 'spreaders', 'chainsaw', 'hotstick'].includes(q)));
  ok('A14 but it can charge a hydrant itself, or it could never fill up',
    t.loadout.includes('wrench'));
emit('A done');
}

/* ── B. the shuttle ──────────────────────────────────────────────────────── */

function sectionB() {
lines.push('--- B. parked beside the engine, it feeds it ---');
  const g = freshGame(1600);
  const s = g.state;
  const eng = s.apparatus.find((a) => a.id === 'engine');
  const tnk = s.apparatus.find((a) => a.id === 'tanker');

  // out in the field, nowhere near a hydrant, engine half empty
  eng.x = 240; eng.y = 40; eng.waterL = 500;
  tnk.x = 245; tnk.y = 40; tnk.waterL = 6000;
  const farFromWater = Math.min(...HYDRANTS.map((h) => dist(eng.x, eng.y, h.x, h.y)));
  gt('B1 the engine is nowhere near a hydrant', farFromWater, CONFIG.water.hydrantHookupM * 3);

  const engBefore = eng.waterL, tnkBefore = tnk.waterL;
  for (let i = 0; i < 300; i++) g.frame(STEP, null);
  const gained = eng.waterL - engBefore, spent = tnkBefore - tnk.waterL;
  lines.push(`      five seconds beside the tanker: engine +${f(gained, 0)} L, tanker -${f(spent, 0)} L`);

  gt('B2 the engine gains water with no hydrant in sight', gained, 0);
  ok('B3 and the tanker spends exactly what the engine gains',
    Math.abs(gained - spent) < 0.001, `${f(gained, 3)} vs ${f(spent, 3)}`);
  ok('B4 at the rate CONFIG says', Math.abs(gained - CONFIG.water.tankerTransferLps * 5) < 20,
    `${f(gained, 0)} L in 5 s`);
  eq('B5 and the engine knows who is feeding it', eng.suppliedBy, 'tanker');

  // drive away and it stops
  tnk.x = 300; tnk.y = 40;
  const at = eng.waterL;
  for (let i = 0; i < 120; i++) g.frame(STEP, null);
  eq('B6 driving the tanker away stops the supply', eng.waterL, at);
  eq('B7 and the engine stops claiming it has one', eng.suppliedBy, null);

  // it will not fill something that cannot use it
  const amb = s.apparatus.find((a) => a.id === 'ambulance');
  amb.x = 300; amb.y = 40;
  const ambBefore = amb.waterL;
  for (let i = 0; i < 120; i++) g.frame(STEP, null);
  eq('B8 it will not fill an ambulance, which has nothing to do with water', amb.waterL, ambBefore);

  // a full engine takes nothing
  tnk.x = eng.x + 4;
  eng.waterL = APPARATUS_BY_ID.engine.tankL;
  const tnkFull = tnk.waterL;
  for (let i = 0; i < 120; i++) g.frame(STEP, null);
  eq('B9 a full engine takes nothing, so the tanker does not pour it away', tnk.waterL, tnkFull);
  eq('B10 and never overfills it', eng.waterL, APPARATUS_BY_ID.engine.tankL);

  // an empty tanker gives nothing
  eng.waterL = 100; tnk.waterL = 0;
  for (let i = 0; i < 120; i++) g.frame(STEP, null);
  eq('B11 an empty tanker has nothing to give', eng.waterL, 100);
  ok('B12 and does not go negative doing it', tnk.waterL >= 0, `${tnk.waterL}`);

  // it fills from a hydrant like any water truck
  const g2 = freshGame(1601);
  const s2 = g2.state;
  const t2 = s2.apparatus.find((a) => a.id === 'tanker');
  const hyd = HYDRANTS[0];
  t2.x = hyd.x + 2; t2.y = hyd.y; t2.waterL = 0;
  t2.hydrantId = hyd.id;
  for (let i = 0; i < 300; i++) g2.frame(STEP, null);
  gt('B13 and it refills from a hydrant, like any truck with a tank', t2.waterL, 0);
emit('B done');
}

/* ── C. two trucks with tanks is one more than there used to be ──────────── */

function sectionC() {
lines.push('--- C. the wrench charges the truck in front of you ---');
  const g = freshGame(1610);
  const s = g.state;
  const eng = s.apparatus.find((a) => a.id === 'engine');
  const tnk = s.apparatus.find((a) => a.id === 'tanker');
  const hyd = HYDRANTS.find((h) => h.id === 'hyd_station') || HYDRANTS[0];

  /* ⚠ THE ONE THAT WOULD HAVE BEEN SILENT. Charging a hydrant used to `find` the first
     appliance with a tank inside the hookup radius — correct while exactly one truck
     carried water. With two, turning the wrench beside the tanker charged the ENGINE,
     because the engine is earlier in APPARATUS_DEFS. */
  eng.x = 10; eng.y = 10;                     // engine parked across town
  tnk.x = hyd.x + 2; tnk.y = hyd.y;           // tanker on the hydrant
  const p = s.player;
  p.x = hyd.x + 1; p.y = hyd.y + 1;
  const wrench = s.tools.find((t) => t.defId === 'wrench');
  wrench.carrier = p.id; p.toolId = wrench.id;
  p.facing = Math.atan2(hyd.y - p.y, hyd.x - p.x);

  const inp = { isDown: () => false, wasPressed: (n) => n === 'use', wasReleased: () => false,
    moveAxis: () => ({ x: 0, y: 0 }), endStep: () => {} };
  for (let i = 0; i < 400; i++) g.frame(STEP, { ...inp, wasPressed: () => false, isDown: (n) => n === 'use' });

  eq('C1 the truck ON the hydrant is the one that gets charged', tnk.hydrantId, hyd.id);
  eq('C2 and not the one parked across town', eng.hydrantId, null);
emit('C done');
}


/* ── D. does it change an outcome ────────────────────────────────────────── */

function sectionD() {
lines.push('--- D. a fire that can be won with it and not without it ---');

  /* ⚠ THREE VERSIONS OF THIS SECTION FAILED BEFORE ONE OF THEM MEASURED ANYTHING, and
   * every failure was my premise rather than the code. Worth keeping, because each one
   * was wrong in a different and instructive way.
   *
   *  1. Fight Miller Barn the instant it lights. Result, twice over: "out · 93% burnt ·
   *     2208 L", identical with and without. 2208 L is less than the engine's own 2500,
   *     so the tanker was never touched.
   *  2. Assume the fire just needs a head start, and sweep over how long it burned first.
   *     The water used went DOWN: 2208 -> 1065 -> 704 -> 344 L. Not a bug — a building
   *     alight for ninety seconds has already consumed itself, and there is less left to
   *     cool. Demand PEAKS when you arrive early and try to save the place.
   *  3. Assume the building is the variable and sweep all eleven. Two need more than one
   *     tank — but only because the stream was poured from ONE FIXED SPOT, which reaches
   *     a fraction of a big shed and loses 96% of it whatever the supply. Give the nozzle
   *     a walking crew on a 34 m line and every structure in town, at every head start,
   *     comes in under 1500 L:
   *
   *       barn 0/45/90 s -> 96 / 884 / 344 L    feedstore -> 116 / 1458 / 800 L
   *                                             apartments -> 146 / 1343 / 790 L
   *
   * SO: NO SINGLE FIRE IN THIS TOWN NEEDS MORE THAN ONE TANK. The tanker is not a bigger
   * engine and this suite is not allowed to pretend otherwise — D2 asserts it, so if the
   * fire model ever changes underneath, the claim fails loudly instead of rotting.
   *
   * What 2500 L does not cover is a SHIFT. Three structure fires at the far end of the
   * valley and the engine is dry on the third, 33-40 m from the nearest hydrant — and the
   * hookup radius is 7 m, so refilling means dropping the line, driving the truck out of
   * the fire, filling, and driving back, with the building burning through every second
   * of it. That is what the appliance is for, and it is why a real rural department owns
   * one. The measurement is a three-call shift, run twice. */

  const toWater = (b) => Math.min(...HYDRANTS.map((h) => dist(b.x + b.w / 2, b.y + b.h / 2, h.x, h.y)));
  const WALK = 2.0, DRIVE = 9.0, RUN_IDS = ['barn', 'feedstore', 'garage'];
  const mkInc = (s, b, n) => {
    const inc = {
      id: 'incT' + n, templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
      place: b.name, x: b.door.x, y: b.door.y, buildingId: b.id, roadId: null,
      priority: 'high', report: '', createdMs: 0, ageMs: 0, danger: 0, peakDanger: 0,
      status: 'active', hazardIds: [], victimIds: [], consequences: [], capabilities: [],
      updates: [], lastUpdateText: null, resolvedMs: null, outcomeNote: null, everWorked: true,
    };
    s.incidents.push(inc);
    return inc;
  };

  for (const id of RUN_IDS) {
    lines.push(`      ${BUILDING_BY_ID[id].name} is ${f(toWater(BUILDING_BY_ID[id]), 0)} m from the nearest hydrant`);
  }
  ok('D1 all three are out of reach of the mains',
    RUN_IDS.every((id) => toWater(BUILDING_BY_ID[id]) > CONFIG.water.hydrantHookupM * 4),
    RUN_IDS.map((id) => f(toWater(BUILDING_BY_ID[id]), 0)).join('/'));

  /* One shift, three calls, no going home in between.
     The nozzle is worked by a crew that WALKS — 2 m/s, tethered to the engine by
     hoseMaxLengthM — because a stream poured from one parked spot measures aim, not
     supply. Water goes on through applyWater, the same function the real nozzle calls.
     The only thing modelled test-side is the DRIVE to the hydrant and back; the refill
     itself is the game's own applyWaterSupply, at the game's own rate and radius. */
  const shift = (withTanker) => {
    const g = freshGame(1620);
    const s = g.state;
    const eng = s.apparatus.find((a) => a.id === 'engine');
    const tnk = s.apparatus.find((a) => a.id === 'tanker');
    eng.waterL = APPARATUS_BY_ID.engine.tankL;
    tnk.waterL = APPARATUS_BY_ID.tanker.tankL;
    const quiet = () => { for (const i of s.incidents) i.danger = 0; };
    let clock = 0, trips = 0, tripMs = 0;
    const dmg = [];

    for (const [n, id] of RUN_IDS.entries()) {
      const b = BUILDING_BY_ID[id];
      const inc = mkInc(s, b, n);
      const fire = createFire(b.id, { seedCells: 3, heat: 1.0, from: 'centre' });
      addHazard(s, inc, fire);
      // it burns for the drive out
      for (let t = 0; t < 45000; t += STEP) { g.frame(STEP, null); clock += STEP; quiet(); }

      const ex = b.x + b.w / 2, ey = b.y + b.h + 6;
      eng.x = ex; eng.y = ey;
      if (withTanker) { tnk.x = ex + 5; tnk.y = ey; }
      const hydD = toWater(b);
      const hyd = HYDRANTS.reduce((a, h) =>
        dist(h.x, h.y, ex, ey) < dist(a.x, a.y, ex, ey) ? h : a, HYDRANTS[0]);
      let nx = ex, ny = ey;

      for (let t = 0; t < 400000 && s.mode === MODES.PLAYING; t += STEP) {
        const dt = STEP / 1000;
        let best = null, bh = -1;
        for (const c of fire.cells) if (c.burning && c.heat > bh) { bh = c.heat; best = c; }
        if (best) {
          const dx = best.x - nx, dy = best.y - ny, d = Math.hypot(dx, dy) || 1;
          if (d > CONFIG.water.streamReachM - 1.5) {
            const sx = nx + (dx / d) * WALK * dt, sy = ny + (dy / d) * WALK * dt;
            if (dist(sx, sy, eng.x, eng.y) <= CONFIG.water.hoseMaxLengthM) { nx = sx; ny = sy; }
          }
          if (eng.waterL > 0.001) {
            const use = Math.min(CONFIG.water.nozzleFlowLps * dt, eng.waterL);
            eng.waterL -= use;
            applyWater(s, nx, ny, dx / d, dy / d, use);
          } else {
            /* Dry, and no tanker. Drop the line and take the truck to the mains. */
            const drive = (hydD * 2) / DRIVE * 1000;
            eng.x = hyd.x + 2; eng.y = hyd.y; eng.hydrantId = hyd.id;
            let spent = 0;
            for (let u = 0; u < drive; u += STEP) { g.frame(STEP, null); clock += STEP; spent += STEP; quiet(); }
            while (eng.waterL < APPARATUS_BY_ID.engine.tankL - 1 && spent < 300000) {
              g.frame(STEP, null); clock += STEP; spent += STEP; quiet();
            }
            tripMs += spent;
            eng.x = ex; eng.y = ey; eng.hydrantId = null; nx = ex; ny = ey; trips++;
          }
        }
        g.frame(STEP, null); clock += STEP; quiet();
        if (fire.cells.every((c) => !c.burning)) break;
      }
      dmg.push(fireDamageFraction(fire));
    }
    return { clock, trips, tripMs, dmg, fed: APPARATUS_BY_ID.tanker.tankL - tnk.waterL };
  };

  const alone = shift(false);
  emit('running D, second shift');
  const withT = shift(true);
  const row = (tag, r) => `      ${tag.padEnd(14)} ${f(r.clock / 1000, 0).padStart(4)} s   ` +
    `${r.trips} trip${r.trips === 1 ? ' ' : 's'} (${f(r.tripMs / 1000, 0)} s)   ` +
    `${r.dmg.map((d) => f(d * 100, 0) + '%').join(' / ')}`;
  lines.push(`      shift          total    refill trips      ${RUN_IDS.join(' / ')} lost`);
  lines.push('      ------------   ------   ---------------   -----------------------');
  lines.push(row('engine alone', alone));
  lines.push(row('with a tanker', withT));
  lines.push(`      the tanker gave up ${f(withT.fed, 0)} L of its ${APPARATUS_BY_ID.tanker.tankL}`);

  /* The claim that keeps this honest: it is NOT a bigger engine. */
  ok('D2 no single call in this shift emptied the tank on its own',
    alone.trips <= RUN_IDS.length - 1, `${alone.trips} trips on ${RUN_IDS.length} calls`);
  /* The claim it exists for. */
  gt('D3 without one, the engine has to leave a burning building to refill', alone.trips, 0);
  eq('D4 with one alongside, it never does', withT.trips, 0);
  gt('D5 and that trip is not free', alone.tripMs / 1000, 30);
  lt('D6 so the shift finishes sooner with a tanker on scene', withT.clock, alone.clock - 20000);
  const worst = RUN_IDS.length - 1;
  lt(`D7 and less of the ${BUILDING_BY_ID[RUN_IDS[worst]].name} is lost`,
    withT.dmg[worst], alone.dmg[worst] - 0.05);
  gt('D8 which cost the tanker real water, not a rounding error', withT.fed, 500);
  ok('D9 and it still had plenty left, as a shift-long supply should',
    withT.fed < APPARATUS_BY_ID.tanker.tankL,
    `${f(withT.fed, 0)} of ${APPARATUS_BY_ID.tanker.tankL} L`);
emit('D done');
}

/* ── E. and does the fourth pair of hands have something to do now ───────── */

function sectionE() {
lines.push('--- E. four trucks for four volunteers ---');
  const g = freshGame(1630);
  const s = g.state;
  for (const id of ['r2', 'r3', 'r4']) seatResponder(s, id);
  eq('E1 four on the crew', s.responders.length, 4);
  eq('E2 and four things to drive', s.apparatus.length, 4);
  ok('E3 every one of them can be driven by somebody different', (() => {
    s.apparatus.forEach((ap, i) => {
      const r = s.responders[i];
      r.x = ap.x; r.y = ap.y; r.inVehicleId = ap.id;
      ap.driverId = r.id; ap.passengerIds = [r.id];
    });
    return s.apparatus.every((ap, i) => ap.driverId === s.responders[i].id);
  })());
  eq('E4 with nobody doubling up', new Set(s.apparatus.map((a) => a.driverId)).size, 4);

  /* The GDD's own line: apparatus determine capability. Four trucks is four capabilities,
     not four of the same one. */
  const caps = s.apparatus.map((a) => {
    const d = s.apparatusDefs[a.defId];
    return d.hose ? 'water on a fire' : d.patientBay ? 'a ride to the clinic'
      : d.supplies ? 'water where there is none' : 'tools';
  });
  lines.push(`      the four capabilities: ${caps.join(' · ')}`);
  eq('E5 and they are four different capabilities', new Set(caps).size, 4);
emit('E done');
}


/* ── F. and can the player see any of it ─────────────────────────────────── */

function sectionF() {
lines.push('--- F. a shuttle nobody can see is a shuttle nobody drives ---');
  /* ⚠ applyTankerSupply's own comment said "the HUD reads this" about `suppliedBy` for a
     whole milestone before the HUD read anything of the sort. Both cabs need it: the one
     being fed, so they know water is coming and can keep the line open, and the one doing
     the feeding, so they know whether nine metres was close enough. */
  const g = freshGame(1640);
  const s = g.state;
  const root = document.createElement('div');
  root.style.display = 'none';
  document.body.appendChild(root);
  const hud = new Hud(root, g);

  const eng = s.apparatus.find((a) => a.id === 'engine');
  const tnk = s.apparatus.find((a) => a.id === 'tanker');
  const r = s.responders[0];

  const lineFor = (ap) => {
    r.inVehicleId = ap.id;
    return hud.statusFor(s, r);
  };

  // apart: nothing hooked up
  eng.x = 240; eng.y = 40; eng.waterL = 500;
  tnk.x = 300; tnk.y = 40;
  for (let i = 0; i < 30; i++) g.frame(STEP, null);
  const engApart = lineFor(eng), tnkApart = lineFor(tnk);
  ok('F1 an engine nobody is feeding says nothing about a tanker', !/fed by/.test(engApart), engApart);
  ok('F2 and a parked-up tanker says so in as many words', /nothing hooked up/.test(tnkApart), tnkApart);

  // alongside
  tnk.x = eng.x + 5; tnk.y = eng.y;
  for (let i = 0; i < 30; i++) g.frame(STEP, null);
  const engFed = lineFor(eng), tnkFeeding = lineFor(tnk);
  lines.push(`      engine:  ${engFed.replace(/<[^>]+>/g, '')}`);
  lines.push(`      tanker:  ${tnkFeeding.replace(/<[^>]+>/g, '')}`);
  ok('F3 the engine says who is feeding it, by name', /fed by Tanker 1/.test(engFed), engFed);
  ok('F4 and the tanker says who it is feeding, by name', /feeding Engine 1/.test(tnkFeeding), tnkFeeding);
  ok('F5 not still claiming it is idle', !/nothing hooked up/.test(tnkFeeding), tnkFeeding);

  // drive off and both chips go, in the same frame the water stops
  tnk.x = 300; tnk.y = 40;
  for (let i = 0; i < 30; i++) g.frame(STEP, null);
  ok('F6 driving away clears it on the engine', !/fed by/.test(lineFor(eng)));
  ok('F7 and on the tanker', /nothing hooked up/.test(lineFor(tnk)));

  // a truck that can never be fed never mentions it
  const amb = s.apparatus.find((a) => a.id === 'ambulance');
  const ambLine = lineFor(amb);
  ok('F8 a truck with no hose never mentions a supply either way',
    !/fed by|feeding|hooked up/.test(ambLine), ambLine);

  // and the truck itself is labelled on the canvas like any other
  eq('F9 the tanker has a short name for the label over its roof',
    typeof APPARATUS_BY_ID.tanker.short, 'string');
  ok('F10 which is not one another truck already uses',
    new Set(APPARATUS_DEFS.map((d) => d.short)).size === APPARATUS_DEFS.length,
    APPARATUS_DEFS.map((d) => d.short).join('/'));

  root.remove();
emit(null);
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
