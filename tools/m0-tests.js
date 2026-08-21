/* Phase 0 suite — the walking skeleton and the design locks.
 *
 * GDD Phase 0 exit gate: "driving across town is understandable without instructions
 * after one attempt". That is a playtest question, not an assertion — so what is
 * asserted here is everything the gate DEPENDS on: the town's geometry is legible and
 * consistent, the three apparatus exist and carry what the design says they carry,
 * collision behaves, and simulation time only moves when it is supposed to.
 *
 * Emits after every section: a suite that throws half way must still report how far it
 * got (lesson from AirportBaggageCrew\tools\m0-tests.js).
 */

import { GameClock } from '../src/core/clock.js';
import { EventBus, EVENTS } from '../src/core/eventBus.js';
import { Input, DEFAULT_BINDINGS } from '../src/core/input.js';
import { mulberry32, Rng, hashStr } from '../src/core/rng.js';
import { defaultTown, migrate, advanceShift, SAVE_VERSION, clearSave } from '../src/core/persistence.js';
import { Game, MODES, createInitialState } from '../src/game.js';
import { CONFIG } from '../src/config.js';
import {
  WORLD, BOUNDS, ROADS, BUILDINGS, HYDRANTS, POLES, STATION, CLINIC,
  TREE_SITES, CRASH_SITES, roadRects, roadAt, isOnRoad, buildingAt, describePlace,
  blockingRectAt, resolveCircleRect, circleHitsRect, rectsOverlap, dist, clampToBounds,
  BUILDING_BY_ID,
} from '../src/data/town.js';
import { APPARATUS_DEFS, TOOL_DEFS, RACK_ITEMS } from '../src/data/equipment.js';
import { stepPlayerMovement, stepApparatusMovement } from '../src/sim/movement.js';
import { GameAudio, mixFor, atten, CUES } from '../src/audio/audio.js';
import { createFire, createGas } from '../src/sim/hazards.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;

function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
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

/** Drive the real simulation without waiting for animation frames. */
function run(game, ms, input = null) {
  return game.clock.skipMs(ms, (stepMs) => game.step(stepMs, input));
}

/* ── A. seeded RNG ───────────────────────────────────────────────────────── */
function sectionA() {
lines.push('--- A. seeded RNG (implementation rule 1: reproducible playtests) ---');
{
  const a = mulberry32(12345), b = mulberry32(12345), c = mulberry32(12346);
  const sa = [], sb = [], sc = [];
  for (let i = 0; i < 8; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
  ok('A1 same seed gives an identical stream', sa.join() === sb.join());
  ok('A2 different seed diverges', sa.join() !== sc.join());
  ok('A3 draws stay in [0,1)', sa.every((v) => v >= 0 && v < 1));

  const r = new Rng(999);
  const first = [r.float(), r.float(), r.float()];
  eq('A4 Rng counts its draws', r.draws, 3);
  r.reset();
  ok('A5 reset restores the exact stream', [r.float(), r.float(), r.float()].join() === first.join());

  const ri = new Rng(7);
  let inRange = true;
  for (let i = 0; i < 2000; i++) { const v = ri.int(3, 9); if (v < 3 || v > 9) inRange = false; }
  ok('A6 int(lo,hi) inclusive over 2000 draws', inRange);
  ok('A7 shuffle deterministic per seed',
    new Rng(42).shuffle([1,2,3,4,5,6,7,8]).join() === new Rng(42).shuffle([1,2,3,4,5,6,7,8]).join());
  eq('A8 hashStr stable', hashStr('shift_1'), hashStr('shift_1'));
  ok('A9 hashStr separates labels', hashStr('shift_1') !== hashStr('shift_2'));
  ok('A10 Game.seedFromLabel matches hashStr', Game.seedFromLabel('x') === hashStr('x'));
}
emit('running A');
}

/* ── B. fixed-step clock ─────────────────────────────────────────────────── */
function sectionB() {
lines.push('--- B. clock (the only owner of simulation time) ---');
{
  const c = new GameClock({ stepMs: STEP, maxFrameMs: 250 });
  let steps = 0;
  c.advance(100, () => steps++);
  ok('B1 100 ms is spent in whole steps, to within one step', Math.abs(steps * STEP - 100) < STEP, `${steps} steps`);
  near('B2 sim time tracks the steps executed', c.simTimeMs, steps * STEP, 0.001);

  c.reset();
  c.setPaused(true);
  let paused = 0;
  c.advance(1000, () => paused++);
  eq('B3 paused consumes nothing', paused, 0);
  eq('B4 paused does not bank time', c.accumulatorMs, 0);

  c.reset();
  let long = 0;
  c.advance(5000, () => long++);
  ok('B5 a long frame is clamped, not caught up', long <= Math.ceil(250 / STEP), `got ${long}`);
  eq('B6 the clamp is counted', c.clampedFrames, 1);

  c.reset();
  let sk = 0;
  c.skipMs(6000, () => sk++);
  near('B7 skipMs runs the whole span', sk, 360, 2);
  eq('B8 formatMs', GameClock.formatMs(65000), '1:05');
}
emit('running B');
}

/* ── C. event bus ────────────────────────────────────────────────────────── */
function sectionC() {
lines.push('--- C. event bus ---');
{
  const bus = new EventBus({ logSize: 4 });
  let seen = 0, any = 0;
  const off = bus.on('CALL_RECEIVED', () => seen++);
  bus.onAny(() => any++);
  bus.emit('CALL_RECEIVED', {}, 0);
  bus.emit('CALL_UPDATED', {}, 0);
  eq('C1 typed handler fires only for its type', seen, 1);
  eq('C2 onAny sees everything', any, 2);
  off();
  bus.emit('CALL_RECEIVED', {}, 0);
  eq('C3 unsubscribe works', seen, 1);
  for (let i = 0; i < 10; i++) bus.emit('CALL_UPDATED', { i }, i);
  eq('C4 the log is bounded', bus.log.length, 4);
  ok('C5 recent() is newest first', bus.recent(2)[0].i > bus.recent(2)[1].i);
  ok('C6 every emitted name is declared in EVENTS',
    Object.keys(EVENTS).length > 30 && EVENTS.CALL_RECEIVED === 'CALL_RECEIVED');
}
emit('running C');
}

/* ── D. controls ─────────────────────────────────────────────────────────── */
function sectionD() {
lines.push('--- D. readable controls (implementation rule 6) ---');
{
  const inp = new Input(window, DEFAULT_BINDINGS);
  const verbs = ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'interact', 'use', 'drop', 'siren'];
  ok('D1 the five verbs are all bound', verbs.every((v) => DEFAULT_BINDINGS[v]?.length));
  ok('D2 equipment select is 1..5', [1,2,3,4,5].every((i) => DEFAULT_BINDINGS[`slot${i}`][0] === `Digit${i}`));

  inp._debugPress('KeyW');
  ok('D3 isDown reports a held key', inp.isDown('moveUp'));
  ok('D4 wasPressed reports the edge', inp.wasPressed('moveUp'));
  inp.endStep();
  ok('D5 the edge is consumed by the step, the hold is not', !inp.wasPressed('moveUp') && inp.isDown('moveUp'));
  inp._debugPress('KeyD');
  const ax = inp.moveAxis();
  near('D6 diagonals are normalised', Math.hypot(ax.x, ax.y), 1, 0.001);
  inp.clear();
  ok('D7 clear drops held state', !inp.isDown('moveUp'));
}
emit('running D');
}

/* ── E. the town ─────────────────────────────────────────────────────────── */
function sectionE() {
lines.push('--- E. town geometry (one record per place) ---');
{
  eq('E1 world matches CONFIG', WORLD.widthM, CONFIG.world.widthM);
  ok('E2 every building sits inside the bounds', BUILDINGS.every((b) =>
    b.x >= BOUNDS.minX && b.y >= BOUNDS.minY && b.x + b.w <= BOUNDS.maxX && b.y + b.h <= BOUNDS.maxY));

  let overlaps = 0;
  for (let i = 0; i < BUILDINGS.length; i++)
    for (let j = i + 1; j < BUILDINGS.length; j++)
      if (rectsOverlap(BUILDINGS[i], BUILDINGS[j])) overlaps++;
  eq('E3 no two buildings overlap', overlaps, 0);

  let onRoad = BUILDINGS.filter((b) => roadRects().some((r) => rectsOverlap(b, r)));
  eq('E4 no building sits in a carriageway', onRoad.length, 0, onRoad.map((b) => b.id).join());

  ok('E5 every door is outside its own footprint or on its edge', BUILDINGS.every((b) =>
    b.door.x <= b.x || b.door.x >= b.x + b.w || b.door.y <= b.y || b.door.y >= b.y + b.h));

  const horiz = ROADS.filter((r) => r.y1 === r.y2);
  const vert = ROADS.filter((r) => r.x1 === r.x2);
  ok('E6 at least two through-routes each way (alternate routes exist)',
    horiz.length >= 2 && vert.length >= 2, `${horiz.length}h ${vert.length}v`);

  ok('E7 roadAt finds Main Street', roadAt(200, 150)?.id === 'main_st');
  ok('E8 roadAt is null on the grass', roadAt(200, 100) === null);
  ok('E9 isOnRoad agrees', isOnRoad(200, 150) && !isOnRoad(200, 100));
  ok('E10 buildingAt finds the pizzeria', buildingAt(140, 128)?.id === 'pizza');

  ok('E11 every crash site is on a road', CRASH_SITES.every((s) => isOnRoad(s.x, s.y)),
    CRASH_SITES.filter((s) => !isOnRoad(s.x, s.y)).map((s) => s.id).join());
  ok('E12 every tree site blocks a road', TREE_SITES.every((s) => isOnRoad(s.x, s.y)),
    TREE_SITES.filter((s) => !isOnRoad(s.x, s.y)).map((s) => s.id).join());
  ok('E13 no hydrant is buried inside a building', HYDRANTS.every((h) => !buildingAt(h.x, h.y)));
  ok('E14 no pole is buried inside a building', POLES.every((p) => !buildingAt(p.x, p.y)));
  ok('E15 hydrant ids are unique', new Set(HYDRANTS.map((h) => h.id)).size === HYDRANTS.length);

  ok('E16 the station bays are clear of the station building',
    STATION.bays.every((b) => !buildingAt(b.x, b.y)));
  ok('E17 the spawn point is outdoors', !buildingAt(STATION.spawn.x, STATION.spawn.y));
  ok('E18 the clinic drop-off is at the clinic', dist(CLINIC.x, CLINIC.y, 374 + 17, 94 + 18) < 30);

  const c = clampToBounds(-50, 999, 1);
  ok('E19 clampToBounds keeps a radius inside', c.x === 1 && c.y === WORLD.heightM - 1);
  ok('E20 describePlace names a building', describePlace(140, 128).includes('Pizza'));
  ok('E21 describePlace names a street', describePlace(200, 150).includes('Main'));

  ok('E22 circleHitsRect / resolveCircleRect agree',
    circleHitsRect(129, 128, 2, BUILDINGS.find((b) => b.id === 'pizza')) &&
    resolveCircleRect(129, 128, 2, BUILDINGS.find((b) => b.id === 'pizza')) !== null);
  ok('E23 blockingRectAt reports the structure', blockingRectAt(140, 128, 0.4)?.id === 'pizza');
}
emit('running E');
}

/* ── F. persistence ──────────────────────────────────────────────────────── */
function sectionF() {
lines.push('--- F. persistence (versioned, with a default fallback) ---');
{
  const t = defaultTown();
  eq('F1 a fresh town is version-stamped', t.version, SAVE_VERSION);
  near('F2 confidence starts where CONFIG says', t.confidence, CONFIG.town.startConfidence, 0.0001);
  eq('F3 a fresh town starts at shift 1', t.shiftNumber, 1);

  eq('F4 garbage migrates to a default', migrate({ junk: true }).shiftNumber, 1);
  eq('F5 an unknown version migrates to a default', migrate({ version: 99, shiftNumber: 7 }).shiftNumber, 1);
  const good = migrate({ version: SAVE_VERSION, shiftNumber: 4, confidence: 2,
    buildings: { pizza: { damage: 0.5, boardedShifts: 1, timesBurned: 2 } },
    hydrants: { hyd_elm: { damaged: true } }, history: ['a'] });
  eq('F6 a valid save survives migration', good.shiftNumber, 4);
  eq('F7 out-of-range confidence is clamped', good.confidence, 1);
  eq('F8 building records survive', good.buildings.pizza.timesBurned, 2);
  eq('F9 hydrant records survive', good.hydrants.hyd_elm.damaged, true);

  const next = advanceShift({ ...defaultTown(), confidence: 0.5,
    buildings: { pizza: { damage: 0.8, boardedShifts: 0, timesBurned: 1 },
                 barn:  { damage: 0.2, boardedShifts: 0, timesBurned: 0 } },
    hydrants: { hyd_elm: { damaged: true } } }, 'a headline');
  eq('F10 the shift number advances', next.shiftNumber, 2);
  ok('F11 a gutted building is boarded up next shift', next.buildings.pizza.boardedShifts >= 1);
  ok('F12 light damage repairs itself between shifts',
    !next.buildings.barn || next.buildings.barn.damage < 0.2);
  ok('F13 a struck hydrant is still out next shift', next.hydrants.hyd_elm.damaged === true);
  eq('F14 history keeps the headline', next.history[next.history.length - 1], 'a headline');
}
emit('running F');
}

/* ── G. the shift as set up ──────────────────────────────────────────────── */
function sectionG() {
lines.push('--- G. initial state (apparatus determine capability) ---');
{
  const s = createInitialState({ seed: 1, seedLabel: 't', town: defaultTown() });
  eq('G1 three apparatus', s.apparatus.length, 3);
  ok('G2 all three start in their bays', s.apparatus.every((a) =>
    STATION.bays.some((b) => b.apparatusId === a.id && b.x === a.x && b.y === a.y)));
  ok('G3 the engine carries water', s.apparatus.find((a) => a.id === 'engine').waterL > 0);
  ok('G4 nothing else does', s.apparatus.filter((a) => a.id !== 'engine').every((a) => a.waterL === 0));

  const onEngine = s.tools.filter((t) => t.carrier === 'engine').map((t) => t.defId).sort();
  const onAmb = s.tools.filter((t) => t.carrier === 'ambulance').map((t) => t.defId).sort();
  const onRescue = s.tools.filter((t) => t.carrier === 'rescue').map((t) => t.defId).sort();
  ok('G5 the engine has a hose', onEngine.includes('hose'));
  ok('G6 the engine has NO medical kit (the wrong-truck mistake is possible)', !onEngine.includes('medkit'));
  ok('G7 the ambulance has the medical kit', onAmb.includes('medkit'));
  ok('G8 the ambulance has no rescue kit', !onAmb.includes('spreaders') && !onAmb.includes('chainsaw'));
  ok('G9 the rescue truck has saw, spreaders and hot stick',
    ['chainsaw', 'spreaders', 'hotstick'].every((t) => onRescue.includes(t)));
  ok('G10 the rescue truck has no water', !onRescue.includes('hose'));
  eq('G11 the apron rack holds the spares', s.tools.filter((t) => t.carrier === 'rack').length, RACK_ITEMS.length);
  ok('G12 the hose knows which engine it belongs to',
    s.tools.find((t) => t.defId === 'hose').engineId === 'engine');
  ok('G13 every tool def used by a loadout exists',
    APPARATUS_DEFS.every((d) => d.loadout.every((t) => TOOL_DEFS[t])));
  ok('G14 the player starts on the apron, empty handed',
    s.player.toolId === null && !buildingAt(s.player.x, s.player.y));
  eq('G15 nothing is on fire at roll call', s.hazards.length, 0);
  eq('G16 the queue starts empty', s.incidents.length, 0);
  ok('G17 the first call is scheduled, not immediate', s.dispatch.nextCallAtMs === CONFIG.dispatch.firstCallMs);
}
emit('running G');
}

/* ── H. movement ─────────────────────────────────────────────────────────── */
function sectionH() {
lines.push('--- H. movement (structures stop trucks, not people) ---');
{
  const g = new Game({ seed: 4242, seedLabel: 'move' });
  g.startShift();
  const s = g.state;

  s.player.x = 200; s.player.y = 200; s.player.vx = 0; s.player.vy = 0;
  for (let i = 0; i < 120; i++) stepPlayerMovement(s, { x: 1, y: 0 }, STEP);
  ok('H1 walking moves east', s.player.x > 200);
  near('H2 walking tops out at the configured speed', Math.hypot(s.player.vx, s.player.vy),
    CONFIG.player.maxSpeed, 0.15);

  for (let i = 0; i < 240; i++) stepPlayerMovement(s, { x: 0, y: 0 }, STEP);
  near('H3 friction brings a responder to a stop', Math.hypot(s.player.vx, s.player.vy), 0, 0.01);

  // walk at a blank wall of the pizzeria
  const pizza = BUILDINGS.find((b) => b.id === 'pizza');
  s.player.x = pizza.x - 3; s.player.y = pizza.y + 4; s.player.vx = 0; s.player.vy = 0;
  s.player.insideBuildingId = null;
  for (let i = 0; i < 200; i++) stepPlayerMovement(s, { x: 1, y: 0 }, STEP);
  ok('H4 a wall stops a responder', s.player.x < pizza.x, `x=${s.player.x.toFixed(2)}`);
  ok('H5 and does not admit them', s.player.insideBuildingId === null);

  // walk in through the door
  s.player.x = pizza.door.x; s.player.y = pizza.door.y + 3; s.player.vx = 0; s.player.vy = 0;
  for (let i = 0; i < 200; i++) stepPlayerMovement(s, { x: 0, y: -1 }, STEP);
  eq('H6 the door admits them', s.player.insideBuildingId, 'pizza');

  // and cannot leave through the back wall
  for (let i = 0; i < 300; i++) stepPlayerMovement(s, { x: 0, y: -1 }, STEP);
  ok('H7 walls contain them once inside', s.player.y >= pizza.y, `y=${s.player.y.toFixed(2)}`);
  eq('H8 still inside', s.player.insideBuildingId, 'pizza');

  // and out again the way they came
  for (let i = 0; i < 600; i++) stepPlayerMovement(s, { x: 0, y: 1 }, STEP);
  ok('H9 the door lets them out', s.player.insideBuildingId === null, `still ${s.player.insideBuildingId}`);
}
{
  const g = new Game({ seed: 99, seedLabel: 'drive' });
  g.startShift();
  const s = g.state;
  const eng = s.apparatus.find((a) => a.id === 'engine');

  eng.x = 200; eng.y = 150; eng.angle = 0; eng.speed = 0;
  for (let i = 0; i < 300; i++) stepApparatusMovement(s, eng, { throttle: 1, steer: 0 }, STEP);
  ok('H10 the engine crosses ground on Main Street', eng.x > 240, `x=${eng.x.toFixed(1)}`);
  near('H11 road top speed matches the apparatus def', eng.speed, APPARATUS_DEFS[0].maxSpeed, 0.6);

  eng.x = 200; eng.y = 100; eng.angle = 0; eng.speed = 0;   // grass
  for (let i = 0; i < 300; i++) stepApparatusMovement(s, eng, { throttle: 1, steer: 0 }, STEP);
  ok('H12 grass is materially slower', eng.speed < APPARATUS_DEFS[0].maxSpeed * 0.6,
    `off-road ${eng.speed.toFixed(1)} m/s`);

  eng.x = 200; eng.y = 150; eng.angle = 0; eng.speed = 12;
  const before = eng.angle;
  for (let i = 0; i < 60; i++) stepApparatusMovement(s, eng, { throttle: 1, steer: 1 }, STEP);
  ok('H13 steering turns the truck', eng.angle !== before);

  // drive it into Grange Hardware
  const hw = BUILDINGS.find((b) => b.id === 'hardware');
  eng.x = hw.x + hw.w / 2; eng.y = hw.y + hw.h + 8; eng.angle = -Math.PI / 2; eng.speed = 15;
  eng.damage = 0;
  let struck = null;
  for (let i = 0; i < 120; i++) {
    const evs = stepApparatusMovement(s, eng, { throttle: 1, steer: 0 }, STEP);
    const hit = evs.find((e) => e.type === 'APPARATUS_STRUCK');
    if (hit && !struck) struck = hit;
  }
  ok('H14 a building stops an engine', struck !== null);
  ok('H15 and marks the panel', eng.damage > 0, `damage ${eng.damage.toFixed(3)}`);
  ok('H16 the engine did not end up inside the shop', !buildingAt(eng.x, eng.y));
}

/* How a truck FEELS, in numbers, so it cannot drift without somebody noticing. Every
 * one of these was measured with tools\_drivediag.js before it was asserted. A town is
 * only as small as its trucks are quick: when a rig accidentally started the engine on
 * the grass beside Main Street it capped at 26 km/h, and the whole town felt twice as
 * far away as it is. */
{
  const rig = (x, y, angle, apId = 'engine') => {
    clearSave();
    const g = new Game({ seed: 808 });
    g.startShift();
    const s = g.state;
    s.dispatch.nextCallAtMs = Number.MAX_SAFE_INTEGER;
    s.incidents.length = 0; s.hazards.length = 0;
    const ap = s.apparatus.find((a) => a.id === apId);
    ap.x = x; ap.y = y; ap.angle = angle; ap.speed = 0; ap.damage = 0;
    ap.driverId = s.player.id; s.player.inVehicleId = ap.id;
    return { g, s, ap, def: s.apparatusDefs[ap.defId] };
  };
  const pedal = (throttle, steer = 0) => ({
    moveAxis: () => ({ x: 0, y: 0 }),
    isDown: (a) => (a === 'moveUp' && throttle > 0) || (a === 'moveDown' && throttle < 0)
      || (a === 'moveRight' && steer > 0) || (a === 'moveLeft' && steer < 0),
    wasPressed: () => false, wasReleased: () => false, endStep: () => {}, pointerWorld: null,
  });
  const run = (r, input, until, capMs) => {
    let ms = 0;
    while (ms < capMs && !until(r.ap, ms)) { r.g.frame(STEP, input); ms += STEP; }
    return ms / 1000;
  };

  const road = rig(30, 150, 0);                       // ON Main Street, not beside it
  const t95 = run(road, pedal(1), (ap) => ap.speed >= road.def.maxSpeed * 0.95, 30000);
  ok('H17 a truck gets going in seconds, not half a minute', t95 < 4, `${t95.toFixed(1)} s to 95%`);
  near('H18 and reaches the speed its data sheet claims', road.ap.speed, road.def.maxSpeed, road.def.maxSpeed * 0.06);

  const x0 = road.ap.x;
  const tStop = run(road, pedal(-1), (ap) => ap.speed <= 0.4, 20000);
  ok('H19 and stops from top speed in a truck-sized distance', road.ap.x - x0 < 16,
    `${(road.ap.x - x0).toFixed(0)} m in ${tStop.toFixed(1)} s`);

  const turn = rig(200, 150, 0);
  run(turn, pedal(1), (ap) => ap.speed >= 7, 20000);
  const a0 = turn.ap.angle;
  const tTurn = run(turn, pedal(1, 1), (ap) => {
    let d = ap.angle - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d >= Math.PI / 2;
  }, 20000);
  ok('H20 a junction turn takes about a second and a half', tTurn > 0.6 && tTurn < 3,
    `${tTurn.toFixed(1)} s`);

  const grass = rig(30, 118, 0);
  run(grass, pedal(1), (ap, ms) => ms >= 10000, 10000);
  ok('H21 grass really is the decision it is meant to be',
    grass.ap.speed < road.def.maxSpeed * (CONFIG.drive.offRoadMul + 0.06),
    `${(grass.ap.speed * 3.6).toFixed(0)} km/h vs ${(road.def.maxSpeed * 3.6).toFixed(0)} on tarmac`);

  /* Nothing traps the player: nose a truck into a wall at speed and reverse must free
     it. A wedged appliance with a live call on the board is unrecoverable. */
  const b = BUILDING_BY_ID.hardware;
  const jam = rig(b.x + b.w / 2, b.y + b.h + 14, -Math.PI / 2);
  run(jam, pedal(1), (ap) => dist(ap.x, ap.y, b.x + b.w / 2, b.y + b.h) < 4.5, 20000);
  const stuck = { x: jam.ap.x, y: jam.ap.y };
  const tFree = run(jam, pedal(-1), (ap) => dist(ap.x, ap.y, stuck.x, stuck.y) > 8, 20000);
  ok('H22 a truck nosed into a building reverses out of it', tFree < 5, `${tFree.toFixed(1)} s`);
  ok('H23 and is not inside the building afterwards', !buildingAt(jam.ap.x, jam.ap.y));
}
emit('running H');
}

/* ── H2. the house rule about randomness, actually enforced ──────────────── */
function sectionRandom() {
lines.push('--- H2. nothing that draws or simulates may call Math.random ---');
  /* src/core/rng.js has claimed since it was written that "tools\m0-tests.js greps src/
   * for Math.random and fails the build if one appears". No suite ever did. The claim
   * cost something real: the audio layer's noise bed was built from Math.random, so two
   * runs of one seed did not sound the same, and it sat there until somebody read the
   * file. A comment that describes a test is worth nothing; this is the test.
   *
   * Synchronous XHR on purpose — the suite emits after every section, and an await would
   * reorder that against the DOM dump the harness greps. */
  const FILES = [
    'src/game.js', 'src/config.js',
    'src/core/clock.js', 'src/core/eventBus.js', 'src/core/input.js',
    'src/core/persistence.js', 'src/core/rng.js',
    'src/sim/hazards.js', 'src/sim/victims.js', 'src/sim/incidentSim.js',
    'src/sim/dispatch.js', 'src/sim/movement.js', 'src/sim/interaction.js',
    'src/render/camera.js', 'src/render/renderer.js',
    'src/audio/audio.js', 'src/ui/hud.js', 'src/ui/coach.js', 'src/ui/shiftReport.js',
    'src/ui/touch.js', 'src/ui/a11y.js', 'src/net/protocol.js', 'src/main.js',
  ];
  /* One deliberate exception, and it has to be deliberate: a room code that a stranger
   * could predict is not a room code. randCode takes its randomness as an argument and
   * defaults to Math.random for exactly that reason. */
  const ALLOWED = { 'src/net/net.js': 'randCode — an unpredictable room code is the point' };

  const read = (path) => {
    const x = new XMLHttpRequest();
    x.open('GET', path, false);
    x.send(null);
    return (x.status === 200 || x.status === 0) ? x.responseText : null;
  };

  /* Comments are stripped first. Several files EXPLAIN this rule in prose, naming the
     call while forbidding it, and a grep that cannot tell a rule from a violation would
     flag src/core/rng.js — the file that states the invariant — as breaking it. */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const offenders = [];
  let scanned = 0;
  for (const f of FILES) {
    const text = read(f);
    if (text == null) { offenders.push(`${f} could not be read`); continue; }
    scanned++;
    if (/Math\s*\.\s*random\s*\(/.test(stripComments(text))) offenders.push(f);
  }
  gt('H2-1 the scan actually read the source', scanned, 18);
  eq('H2-2 no simulation, renderer, audio or UI file calls Math.random', offenders.join(', '), '');

  const net = read('src/net/net.js');
  ok('H2-3 the one allowed exception is still the one that is allowed',
    net != null && /Math\s*\.\s*random/.test(net) && Object.keys(ALLOWED)[0] === 'src/net/net.js');
  ok('H2-4 and it is randCode, taking it as a default argument rather than reaching for it',
    net != null && /randCode\s*\(\s*rand\s*=\s*Math\.random\s*\)/.test(net));
}

/* ── I. live frames ──────────────────────────────────────────────────────── */
function sectionI() {
lines.push('--- I. live simulation (time moves only through frame()) ---');
{
  const g = new Game({ seed: 777, seedLabel: 'live' });
  eq('I1 a new game starts on the title card', g.state.mode, MODES.TITLE);
  eq('I2 and consumes no time', g.frame(1000, null), 0);

  g.startShift();
  eq('I3 starting the shift begins play', g.state.mode, MODES.PLAYING);
  const steps = g.frame(100, null);
  ok('I4 a 100 ms frame is spent in whole steps', Math.abs(steps * STEP - 100) < STEP, `${steps} steps`);
  near('I5 sim time advanced by exactly those steps', g.state.simTimeMs, steps * STEP, 0.001);

  g.togglePause();
  const t = g.state.simTimeMs;
  g.frame(500, null);
  eq('I6 pause stops the town', g.state.simTimeMs, t);
  g.togglePause();
  g.frame(100, null);
  ok('I7 unpause resumes it', g.state.simTimeMs > t);

  g.pauseForBlur();
  eq('I8 losing focus pauses', g.state.mode, MODES.PAUSED);
}
{
  // determinism: same seed, same shift, same story
  const a = new Game({ seed: 31337, seedLabel: 'det' });
  const b = new Game({ seed: 31337, seedLabel: 'det' });
  a.startShift(); b.startShift();
  run(a, 180000); run(b, 180000);
  const sig = (g) => g.state.incidents.map((i) => `${i.templateId}@${i.place}@${Math.round(i.createdMs)}`).join('|');
  ok('I9 the same seed produces the same shift', sig(a) === sig(b), `${sig(a)}  vs  ${sig(b)}`);
  ok('I10 and it produced calls at all', a.state.incidents.length >= 2, `${a.state.incidents.length} calls`);
}
emit(null);
}

/* ── J. audio ────────────────────────────────────────────────────────────── */
function sectionJ() {
lines.push('--- J. audio (the renderer\'s twin: reads state, owns nothing) ---');
{
  const g = new Game({ seed: 606, seedLabel: 'audio' });
  g.startShift();
  const s = g.state;
  const a = new GameAudio();

  // The harness has no user gesture, so this is the un-armed path — which is exactly
  // the path a browser that refuses us a context takes, and it must be harmless.
  ok('J1 audio starts un-armed', !a.armed);
  let threw = false;
  try { a.update(s, 16.7); a.onEvent('CALL_RECEIVED', {}, 0); a.hush(); } catch (e) { threw = true; }
  ok('J2 update, events and hush are all safe before arming', !threw);
  eq('J3 an un-armed update mixes nothing', a.update(s, 16.7), null);

  // The rule that matters more than any sound in the game.
  const before = JSON.stringify({
    p: s.player, t: s.simTimeMs, inc: s.incidents.length, hz: s.hazards.length,
    tools: s.tools.map((x) => [x.carrier, x.flowing]), town: s.town,
  });
  for (let i = 0; i < 30; i++) { mixFor(s); a.update(s, 16.7); }
  const after = JSON.stringify({
    p: s.player, t: s.simTimeMs, inc: s.incidents.length, hz: s.hazards.length,
    tools: s.tools.map((x) => [x.carrier, x.flowing]), town: s.town,
  });
  ok('J4 audio never mutates the simulation', before === after);
}
{
  // The mix is a pure function of state, so it is assertable with no sound card.
  const g = new Game({ seed: 607, seedLabel: 'mix' });
  g.startShift();
  const s = g.state;

  const quiet = mixFor(s);
  ok('J5 a quiet town is silent', quiet.siren === 0 && quiet.fire === 0 &&
    quiet.water === 0 && quiet.engine.gain === 0 && quiet.gasRate === 0);

  const eng = s.apparatus.find((a) => a.id === 'engine');
  eng.siren = true;
  s.player.x = eng.x; s.player.y = eng.y;
  gt('J6 a siren at your elbow is loud', mixFor(s).siren, 0.9);
  s.player.x = eng.x + 120; s.player.y = eng.y;
  const far = mixFor(s).siren;
  ok('J7 and quieter across town, but still audible', far > 0 && far < 0.2, `${far.toFixed(3)}`);
  s.player.x = eng.x + 400;
  eq('J8 and silent past its range', mixFor(s).siren, 0);
  eng.siren = false;

  // fire: loudness follows burning cells AND distance, the same two facts the fire has
  const fire = createFire('pizza', { seedCells: 4, heat: 1.0, from: 'centre' });
  s.hazards.push(fire);
  const hot = fire.cells.find((c) => c.burning);
  s.player.x = hot.x; s.player.y = hot.y;
  const near = mixFor(s).fire;
  gt('J9 standing in a fire is loud', near, 0.2);
  s.player.x = hot.x + 200; s.player.y = hot.y + 200;
  eq('J10 a fire across town is inaudible', mixFor(s).fire, 0);
  s.player.x = hot.x; s.player.y = hot.y;
  for (const c of fire.cells) { c.burning = true; c.heat = 1; }
  gt('J11 a bigger fire is louder than a smaller one', mixFor(s).fire, near);

  // the gas meter: the whole reason this subsystem exists
  const gas = createGas('hardware');
  gas.ppm = 0.9;
  s.hazards.push(gas);
  s.player.x = gas.x; s.player.y = gas.y;
  eq('J12 gas is silent with the wrong tool in your hands', mixFor(s).gasRate, 0);
  const meter = s.tools.find((t) => t.defId === 'gasmeter');
  meter.carrier = s.player.id; s.player.toolId = meter.id;
  const atLeak = mixFor(s).gasRate;
  gt('J13 carrying the meter makes gas audible', atLeak, 1);
  s.player.x = gas.x + 8;
  const offToTheSide = mixFor(s).gasRate;
  ok('J14 and the click rate falls as you back away', offToTheSide < atLeak && offToTheSide > 0,
    `${atLeak.toFixed(1)} -> ${offToTheSide.toFixed(1)} clicks/s`);
  meter.carrier = null; s.player.toolId = null;

  // water and engine follow the same rule: they are readings, not flags set by hand
  const hose = s.tools.find((t) => t.defId === 'hose');
  hose.carrier = s.player.id; s.player.toolId = hose.id;
  eq('J15 a hose that is not flowing is silent', mixFor(s).water, 0);
  hose.flowing = true;
  gt('J16 an open nozzle is not', mixFor(s).water, 0.5);

  s.player.inVehicleId = 'engine';
  eng.speed = eng.speed || 0;
  const idle = mixFor(s).engine;
  eng.speed = s.apparatusDefs.engine.maxSpeed;
  const flat = mixFor(s).engine;
  ok('J17 the engine note rises with road speed',
    flat.pitch > idle.pitch && flat.gain > idle.gain,
    `idle ${idle.pitch.toFixed(2)} -> ${flat.pitch.toFixed(2)}`);
}
{
  // every cue is a well-formed recipe, and every one names a real event
  const names = Object.keys(CUES);
  gt('J18 there is a cue vocabulary', names.length, 20);
  ok('J19 every cue names an event the simulation actually emits',
    names.every((n) => EVENTS[n] === n), names.filter((n) => EVENTS[n] !== n).join());
  ok('J20 every cue is playable (bus, gap, and at least one partial)',
    Object.values(CUES).every((c) => ['world', 'foley', 'ui'].includes(c.bus) &&
      c.minGapMs >= 0 && c.parts.length > 0 &&
      c.parts.every((p) => p.length >= 5 && p[2] > 0 && p[4] > 0)));

  const a = new GameAudio();
  ok('J21 mute persists through the store', a.setMuted(true) === true && new GameAudio().muted === true);
  ok('J22 and unmutes again', a.setMuted(false) === false && new GameAudio().muted === false);
  near('J23 attenuation is a squared falloff', atten(50, 100), 0.25, 0.001);
  eq('J24 and clamps to silence at the edge', atten(120, 100), 0);
}
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE();
  sectionF(); sectionG(); sectionH(); sectionRandom(); sectionI(); sectionJ();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String(err && err.stack || '').split('\n').slice(0, 6).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
