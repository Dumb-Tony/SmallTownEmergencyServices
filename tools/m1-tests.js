/* Systems suite — GDD Phases 1 to 4.
 *
 * Phase 1 gate: one complete fire response, and the player can say why delay mattered.
 * Phase 2 gate: simultaneous calls, updating while unattended, nothing pauses.
 * Phase 3 gate: five systemic families, and at least one unscripted-feeling chain.
 * Phase 4 gate: consequences survive into the next shift.
 *
 * Section J is the GDD's own acceptance test, run twice: once with nobody responding
 * at all (the town must still tell a coherent story), and once with a scripted crew
 * that actually puts the fire out (the loop must close).
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES } from '../src/game.js';
import { Rng } from '../src/core/rng.js';
import { defaultTown, advanceShift, clearSave } from '../src/core/persistence.js';
import {
  BUILDING_BY_ID, HYDRANTS, POLES, CLINIC, TREE_SITES, dist,
} from '../src/data/town.js';
import { TEMPLATE_BY_ID, OPENING_LADDER, TEMPLATES, pickTemplate } from '../src/data/incidents.js';
import {
  createFire, createGas, createPower, createTree, createWreck, stepHazards,
  applyWater, fireDamageFraction, fireMaxHeat, hazardBlockAt, gasAt, liveZoneAt, heatAt,
} from '../src/sim/hazards.js';
import { createVictim, stepVictims, victimState, victimHandled, treatVictim } from '../src/sim/victims.js';
import { createIncident, stepIncidents, addHazard, openIncidents } from '../src/sim/incidentSim.js';
import { stepInteraction, toolsInReachOf, heldTool } from '../src/sim/interaction.js';
import { stepPlayerMovement, stepApparatusMovement } from '../src/sim/movement.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
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

/* Every section starts from a clean town. Section G runs a shift to its end, which
 * SAVES a battered town — without this, later sections would silently be testing
 * "confidence rose from 0.0", which is not the same assertion at all. */
function fresh(seed = 1234, label = 'sys', quiet = true) {
  clearSave();
  const g = new Game({ seed, seedLabel: label });
  g.startShift();
  g.town = defaultTown();
  g.state.town = g.town;
  g.state.outcome.confidenceStart = g.town.confidence;
  if (quiet) g.state.dispatch.nextCallAtMs = Infinity;
  return g;
}
function run(g, ms, input = null) { return g.clock.skipMs(ms, (s) => g.step(s, input)); }
function hazSteps(state, ms, rng) {
  const out = [];
  for (let t = 0; t < ms; t += STEP) out.push(...stepHazards(state, STEP, rng));
  return out;
}
const CMD = (over = {}) => ({
  axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 },
  interact: false, drop: false, use: false, siren: false, slot: null, ...over,
});
/** Take a named tool from whatever is in reach, the way a player would. */
function take(g, defId) {
  const avail = toolsInReachOf(g.state, g.state.player.x, g.state.player.y);
  const i = avail.findIndex((a) => a.tool.defId === defId);
  if (i < 0) return false;
  stepInteraction(g.state, CMD({ slot: i }), STEP);
  return heldTool(g.state)?.defId === defId;
}

/* ── A. fire ─────────────────────────────────────────────────────────────── */
function sectionA() {
lines.push('--- A. fire spreads on its own clock (the central law) ---');
{
  const g = fresh(11, 'fire');
  const s = g.state;
  const rng = new Rng(1);
  const fire = createFire('pizza', { seedCells: 1, heat: 0.95, from: 'door' });
  s.hazards.push(fire);

  eq('A1 a fire starts with the cells it was given', fire.burningCount, 1);
  gt('A2 a structure has enough cells to have a geography', fire.cells.length, 8);

  hazSteps(s, 60000, rng);
  gt('A3 an unattended fire spreads', fire.burningCount, 1);
  gt('A4 and starts consuming the building', fireDamageFraction(fire), 0);
  ok('A5 it is not resolved while it burns', !fire.resolved);

  const before = fireDamageFraction(fire);
  hazSteps(s, 60000, rng);
  gt('A6 leaving it longer costs more of the building', fireDamageFraction(fire), before);
}
{
  // suppression: the same fire, but somebody turns up with water
  const g = fresh(12, 'supp');
  const s = g.state;
  const rng = new Rng(2);
  const fire = createFire('pizza', { seedCells: 2, heat: 0.95, from: 'door' });
  s.hazards.push(fire);
  hazSteps(s, 20000, rng);
  const peak = fire.burningCount;
  gt('A7 it got going before the crew arrived', peak, 0);

  // One nozzle, put on the worst cell — which is what a player does, and what the
  // cooling rate is tuned against. Washing the whole building at once would test a
  // capability nobody has.
  for (let t = 0; t < 240000; t += STEP) {
    const hot = fire.cells.filter((c) => c.burning).sort((c1, c2) => c2.heat - c1.heat)[0];
    if (hot) {
      applyWater(s, hot.x - 3, hot.y, 1, 0,
        CONFIG.water.nozzleFlowLps * (STEP / 1000), CONFIG.water.streamReachM);
    }
    stepHazards(s, STEP, rng);
    if (fire.resolved) break;
  }
  ok('A8 water puts a structure fire out', fire.resolved, `burning ${fire.burningCount}, maxHeat ${fireMaxHeat(fire).toFixed(2)}`);
  ok('A9 and the building it saved is not a total loss', fireDamageFraction(fire) < 0.6,
    `${Math.round(fireDamageFraction(fire) * 100)}% burnt`);
}
{
  // exposure: the farmhouse and the barn are 6 m apart, so one becomes two
  const g = fresh(13, 'expose');
  const s = g.state;
  const rng = new Rng(3);
  const fire = createFire('farmhouse', { seedCells: 4, heat: 1.1, from: 'centre' });
  s.hazards.push(fire);
  const evs = hazSteps(s, 180000, rng);
  const jumped = evs.filter((e) => e.type === 'FIRE_EXTENDED');
  ok('A10 an unfought fire finds the exposure next door', jumped.length > 0);
  ok('A11 and the exposure it found is the barn', jumped.some((e) => e.buildingId === 'barn'),
    jumped.map((e) => e.buildingId).join());
}
emit('running A');
}

/* ── B. water supply ─────────────────────────────────────────────────────── */
function sectionB() {
lines.push('--- B. water supply (spotting the engine is the decision) ---');
{
  const g = fresh(21, 'water');
  const s = g.state;
  const eng = s.apparatus.find((a) => a.id === 'engine');
  const hyd = HYDRANTS.find((h) => h.id === 'hyd_station');

  s.player.x = eng.x; s.player.y = eng.y + 2;
  ok('B1 the hose is in the engine and can be taken', take(g, 'hose'));

  const startTank = eng.waterL;
  s.player.facing = 0;
  for (let t = 0; t < 4000; t += STEP) stepInteraction(s, CMD({ use: true }), STEP);
  ok('B2 opening the nozzle empties the tank', eng.waterL < startTank, `${eng.waterL.toFixed(0)} L`);
  gt('B3 and the water is counted', s.telemetry.litresUsed, 0);

  // walk away until the line comes tight
  for (let t = 0; t < 20000; t += STEP) {
    stepPlayerMovement(s, { x: 1, y: 0 }, STEP);
    stepInteraction(s, CMD(), STEP);
  }
  const d = dist(s.player.x, s.player.y, eng.x, eng.y);
  ok('B4 the hose is a leash', d <= CONFIG.water.hoseMaxLengthM + 0.4, `${d.toFixed(1)} m`);

  // charge the hydrant beside the station
  eng.x = hyd.x + 3; eng.y = hyd.y;
  eng.waterL = 200;
  s.player.x = hyd.x; s.player.y = hyd.y + 1;
  const hose = heldTool(s);
  hose.carrier = null; s.player.toolId = null;
  s.tools.find((t) => t.defId === 'wrench').carrier = 'engine';
  ok('B5 the wrench is on the engine', take(g, 'wrench'));
  for (let t = 0; t < CONFIG.tools.wrenchTurnMs + 400; t += STEP) stepInteraction(s, CMD({ use: true }), STEP);
  eq('B6 turning the wrench charges the hydrant', eng.hydrantId, 'hyd_station');

  const tankBefore = eng.waterL;
  for (let t = 0; t < 4000; t += STEP) stepInteraction(s, CMD(), STEP);
  gt('B7 a charged hydrant refills the tank', eng.waterL, tankBefore);

  eng.x = hyd.x + 40;
  stepInteraction(s, CMD(), STEP);
  eq('B8 driving away from the hydrant drops the supply', eng.hydrantId, null);

  // a hydrant flattened by an engine is no use to anyone
  s.town.hydrants['hyd_station'] = { damaged: true };
  eng.x = hyd.x + 3; eng.hydrantId = null;
  s.player.x = hyd.x; s.player.y = hyd.y + 1;
  for (let t = 0; t < CONFIG.tools.wrenchTurnMs + 400; t += STEP) stepInteraction(s, CMD({ use: true }), STEP);
  eq('B9 a damaged hydrant gives nothing', eng.hydrantId, null);
}
emit('running B');
}

/* ── C. gas ──────────────────────────────────────────────────────────────── */
function sectionC() {
lines.push('--- C. gas (a hazard you cannot see without the meter) ---');
{
  const g = fresh(31, 'gas');
  const s = g.state;
  const rng = new Rng(4);
  const gas = createGas('hardware');
  s.hazards.push(gas);

  const p0 = gas.ppm;
  hazSteps(s, 30000, rng);
  gt('C1 a leak accumulates', gas.ppm, p0);
  gt('C2 the meter can read it at the scene', gasAt(s, gas.x + 2, gas.y), 0);
  eq('C3 and reads nothing across town', gasAt(s, 20, 280), 0);
  ok('C4 an unshut leak is never resolved', !gas.resolved);

  gas.shutOff = true;
  hazSteps(s, 120000, rng);
  ok('C5 shutting the meter off clears it in time', gas.resolved, `ppm ${gas.ppm.toFixed(3)}`);
}
{
  // the chain the GDD wants: gas + an ignition source = one event, unscripted
  const g = fresh(32, 'flash');
  const s = g.state;
  const rng = new Rng(5);
  const gas = createGas('hardware');
  gas.ppm = CONFIG.gas.ignitionThreshold + 0.05;
  s.hazards.push(gas);
  const evs1 = hazSteps(s, 2000, rng);
  eq('C6 gas alone does not ignite', evs1.filter((e) => e.type === 'GAS_FLASH').length, 0);

  const wreck = createWreck(gas.x + 4, gas.y, 0, { fuelLeak: 0.5, burning: true });
  s.hazards.push(wreck);
  const evs2 = hazSteps(s, 2000, rng);
  eq('C7 gas plus a burning vehicle within reach does', evs2.filter((e) => e.type === 'GAS_FLASH').length, 1);
  ok('C8 and the flash is remembered, not repeated', gas.flashed &&
    hazSteps(s, 5000, rng).filter((e) => e.type === 'GAS_FLASH').length === 0);
}
emit('running C');
}

/* ── D. electricity ──────────────────────────────────────────────────────── */
function sectionD() {
lines.push('--- D. electricity (killed at the pole, not at the wire) ---');
{
  const g = fresh(41, 'power');
  const s = g.state;
  const pole = POLES.find((p) => p.id === 'pole_main_e');
  const pwr = createPower(pole.x - 8, pole.y + 4, pole.id);
  s.hazards.push(pwr);

  ok('D1 the live zone is where the wire is', liveZoneAt(s, pwr.x + 1, pwr.y) === pwr);
  ok('D2 and not everywhere', liveZoneAt(s, pwr.x + 40, pwr.y) === null);

  s.player.x = pwr.x + 2; s.player.y = pwr.y; s.player.vx = 0; s.player.vy = 0;
  s.player.stunMs = 0; s.player.shockCooldownMs = 0;
  const evs = stepPlayerMovement(s, { x: 0, y: 0 }, STEP);
  ok('D3 walking into it throws you clear', evs.some((e) => e.type === 'RESPONDER_SHOCKED'));
  gt('D4 and puts you on the ground for a moment', s.player.stunMs, 0);
  ok('D5 it does not end the shift', s.mode === MODES.PLAYING);

  // water on the ground makes the problem bigger, not smaller
  const before = pwr.radiusM;
  applyWater(s, pwr.x - 3, pwr.y, 1, 0, 400, 8);
  stepHazards(s, STEP, new Rng(6));
  gt('D6 hosing a live line grows the live zone', pwr.radiusM, before);

  // the hot stick, worked from the pole
  s.player.stunMs = 0;
  s.player.x = pole.x; s.player.y = pole.y + 1;
  s.player.toolId = null;
  const stick = s.tools.find((t) => t.defId === 'hotstick');
  stick.carrier = 'player'; s.player.toolId = stick.id;
  for (let t = 0; t < CONFIG.tools.hotstickMs + 400; t += STEP) stepInteraction(s, CMD({ use: true }), STEP);
  ok('D7 the hot stick kills the line from the pole', !pwr.live);
  ok('D8 which resolves the hazard', pwr.resolved);
}
{
  // or you wait for the co-op, which is a real and slow option
  const g = fresh(42, 'coop');
  const s = g.state;
  const pwr = createPower(300, 150, 'pole_main_e');
  pwr.utilityCalled = true;
  s.hazards.push(pwr);
  hazSteps(s, CONFIG.power.utilityEtaMs - 5000, new Rng(7));
  ok('D9 the co-op has not arrived early', pwr.live);
  hazSteps(s, 10000, new Rng(7));
  ok('D10 the co-op eventually kills it', !pwr.live);
}
emit('running D');
}

/* ── E. blockage ─────────────────────────────────────────────────────────── */
function sectionE() {
lines.push('--- E. a tree across the lane genuinely blocks the lane ---');
{
  const g = fresh(51, 'tree');
  const s = g.state;
  const site = TREE_SITES.find((t) => t.id === 'elm_north');
  const tree = createTree(site.x, site.y, site.roadId);
  s.hazards.push(tree);

  ok('E1 the trunk is an obstacle', hazardBlockAt(s, site.x + 1, site.y, 1.2) === tree);

  const eng = s.apparatus.find((a) => a.id === 'engine');
  eng.x = site.x; eng.y = site.y + 30; eng.angle = -Math.PI / 2; eng.speed = 0;
  for (let t = 0; t < 8000; t += STEP) stepApparatusMovement(s, eng, { throttle: 1, steer: 0 }, STEP);
  ok('E2 an engine cannot drive through it', eng.y > site.y + 4, `stopped at y=${eng.y.toFixed(1)}`);

  s.player.x = site.x + 2; s.player.y = site.y + 2;
  s.player.toolId = null;
  const saw = s.tools.find((t) => t.defId === 'chainsaw');
  saw.carrier = 'player'; s.player.toolId = saw.id;
  let cleared = null;
  for (let t = 0; t < 20000; t += STEP) {
    const evs = stepInteraction(s, CMD({ use: true }), STEP);
    const c = evs.find((e) => e.type === 'ROAD_CLEARED');
    if (c) { cleared = c; break; }
  }
  ok('E3 the chainsaw clears it', cleared !== null);
  ok('E4 and the road opens again', hazardBlockAt(s, site.x + 1, site.y, 1.2) === null);

  eng.x = site.x; eng.y = site.y + 30; eng.angle = -Math.PI / 2; eng.speed = 0;
  for (let t = 0; t < 8000; t += STEP) stepApparatusMovement(s, eng, { throttle: 1, steer: 0 }, STEP);
  ok('E5 the engine now gets through', eng.y < site.y - 2, `y=${eng.y.toFixed(1)}`);
}
emit('running E');
}

/* ── F. people ───────────────────────────────────────────────────────────── */
function sectionF() {
lines.push('--- F. patients decline on a clock that ignores the crew ---');
{
  const g = fresh(61, 'people');
  const s = g.state;
  const mk = (sev) => {
    const v = createVictim({ incidentId: 'x', x: 200, y: 200, severity: sev });
    s.victims.push(v); return v;
  };
  const stable = mk('stable'), injured = mk('injured'), critical = mk('critical');
  const c0 = { s: stable.condition, i: injured.condition, c: critical.condition };
  for (let t = 0; t < 60000; t += STEP) stepVictims(s, STEP);
  const drop = { s: c0.s - stable.condition, i: c0.i - injured.condition, c: c0.c - critical.condition };
  ok('F1 everyone declines', drop.s > 0 && drop.i > 0 && drop.c > 0);
  ok('F2 severity orders the decline', drop.c > drop.i && drop.i > drop.s,
    `${drop.s.toFixed(3)} / ${drop.i.toFixed(3)} / ${drop.c.toFixed(3)}`);
  eq('F3 a walking-wounded bystander needs nothing', victimHandled(stable), true);
  eq('F4 a critical patient is not handled by being looked at', victimHandled(critical), false);

  const before = injured.condition;
  for (let t = 0; t < CONFIG.medical.treatMs + 200; t += STEP) treatVictim(s, injured, STEP);
  gt('F5 treatment lifts a patient', injured.condition, before);
  ok('F6 and stabilises them for a while', injured.stabilisedUntilMs > s.simTimeMs);

  const stab = injured.condition;
  for (let t = 0; t < 60000; t += STEP) stepVictims(s, STEP);
  ok('F7 stabilised decline is slower than untreated', (stab - injured.condition) < drop.i,
    `${(stab - injured.condition).toFixed(3)} vs ${drop.i.toFixed(3)}`);

  // fire makes it worse, which is why leaving a patient beside one is a decision
  const inFire = mk('injured');
  const fire = createFire('pizza', { seedCells: 6, heat: 1.2, from: 'centre' });
  s.hazards.push(fire);
  const hot = fire.cells.find((c) => c.burning);
  inFire.x = hot.x; inFire.y = hot.y;
  gt('F8 heat is felt at the patient', heatAt(s, inFire.x, inFire.y), 0);
  const away = mk('injured');
  const a0 = away.condition, f0 = inFire.condition;
  for (let t = 0; t < 30000; t += STEP) stepVictims(s, STEP);
  ok('F9 a patient beside the fire declines faster', (f0 - inFire.condition) > (a0 - away.condition),
    `${(f0 - inFire.condition).toFixed(3)} vs ${(a0 - away.condition).toFixed(3)}`);
}
{
  // trapped -> spreaders -> drag -> ambulance -> clinic
  const g = fresh(62, 'rescue');
  const s = g.state;
  const wreck = createWreck(258, 150, 0, { fuelLeak: 0 });
  s.hazards.push(wreck);
  const v = createVictim({ incidentId: 'y', x: 258, y: 150, severity: 'critical', trappedBy: wreck.id });
  v.needsTransport = true;
  s.victims.push(v);
  wreck.occupantIds.push(v.id);

  s.player.x = 259; s.player.y = 151;
  s.player.toolId = null;
  stepInteraction(s, CMD({ interact: true }), STEP);
  eq('F10 a trapped patient cannot simply be picked up', s.player.draggingVictimId, null);

  const spr = s.tools.find((t) => t.defId === 'spreaders');
  spr.carrier = 'player'; s.player.toolId = spr.id;
  let freed = false;
  for (let t = 0; t < CONFIG.medical.extricateMs + 600; t += STEP) {
    const evs = stepInteraction(s, CMD({ use: true }), STEP);
    if (evs.some((e) => e.type === 'PATIENT_EXTRICATED')) freed = true;
  }
  ok('F11 the spreaders free them', freed && v.trappedBy === null);

  stepInteraction(s, CMD({ drop: true }), STEP);
  stepInteraction(s, CMD({ interact: true }), STEP);
  eq('F12 now they can be moved', s.player.draggingVictimId, v.id);

  const amb = s.apparatus.find((a) => a.id === 'ambulance');
  amb.x = 262; amb.y = 152;
  s.player.x = 261; s.player.y = 152;
  stepInteraction(s, CMD({ interact: true }), STEP);
  eq('F13 and loaded into the ambulance', amb.patientId, v.id);
  eq('F14 which is the only vehicle that will take them', v.inApparatusId, 'ambulance');

  amb.x = CLINIC.x; amb.y = CLINIC.y; amb.speed = 0;
  let delivered = false;
  for (let t = 0; t < CONFIG.medical.clinicHandoverMs + 1000; t += STEP) {
    if (stepVictims(s, STEP).some((e) => e.type === 'PATIENT_DELIVERED')) delivered = true;
  }
  ok('F15 the clinic takes the handover', delivered && v.delivered);
  eq('F16 and the ambulance is free again', amb.patientId, null);
  eq('F17 a delivered patient is handled', victimHandled(v), true);
}
{
  // a patient nobody reaches is lost, and the town notices
  const g = fresh(63, 'lost');
  const s = g.state;
  const v = createVictim({ incidentId: 'z', x: 200, y: 200, severity: 'critical' });
  s.victims.push(v);
  let lost = false;
  for (let t = 0; t < 300000; t += STEP) {
    if (stepVictims(s, STEP).some((e) => e.type === 'PATIENT_LOST')) { lost = true; break; }
  }
  ok('F18 an unreached critical patient is eventually lost', lost);
  eq('F19 and reads as lost', victimState(v), 'lost');
}
emit('running F');
}

/* ── G. dispatch ─────────────────────────────────────────────────────────── */
function sectionG() {
lines.push('--- G. dispatch never empties the queue (Phase 2) ---');
{
  const g = fresh(5150, 'dispatch', false);
  const s = g.state;

  run(g, CONFIG.dispatch.firstCallMs - 2000);
  eq('G1 the shift opens quiet', s.incidents.length, 0);
  run(g, 4000);
  eq('G2 then the first call lands on schedule', s.incidents.length, 1);
  eq('G3 the opening ladder starts with a fire', s.incidents[0].family, 'fire');

  run(g, 400000);
  gt('G4 calls keep coming', s.incidents.length, 3);
  ok('G5 the ladder ran fire, then crash, then tree',
    s.incidents.slice(0, 3).map((i) => i.templateId).join() === OPENING_LADDER.join(),
    s.incidents.slice(0, 3).map((i) => i.templateId).join());

  let maxOpen = 0;
  const g2 = fresh(909, 'load', false);
  for (let t = 0; t < CONFIG.shift.durationMs - 1000; t += 5000) {
    run(g2, 5000);
    maxOpen = Math.max(maxOpen, openIncidents(g2.state).length);
  }
  gt('G6 calls genuinely overlap (the triage premise)', maxOpen, 1);
  ok('G7 and the queue is capped so it stays legible', maxOpen <= CONFIG.dispatch.maxActiveCalls,
    `peak ${maxOpen}`);

  const late = g2.state.incidents.filter((i) => i.createdMs > CONFIG.shift.durationMs - 70000);
  eq('G8 nothing new lands in the last stretch of a shift', late.length, 0);
}
{
  const rng = new Rng(88);
  const picks = new Set();
  for (let i = 0; i < 400; i++) picks.add(pickTemplate(rng, {}).id);
  eq('G9 every template in the catalogue is reachable', picks.size, TEMPLATES.length);
  ok('G10 every family is represented',
    new Set(TEMPLATES.map((t) => t.family)).size === 5);
  ok('G11 every template names a site kind the town can supply',
    TEMPLATES.every((t) => ['building', 'crash', 'tree', 'outdoor'].includes(t.site.kind)));
}
emit('running G');
}

/* ── H. incident lifecycle ───────────────────────────────────────────────── */
function sectionH() {
lines.push('--- H. incidents deteriorate whether or not anyone is there ---');
{
  const g = fresh(71, 'lifecycle');
  const s = g.state;
  const inc = createIncident(s, TEMPLATE_BY_ID.kitchen_fire, new Rng(9));
  ok('H1 an incident places itself somewhere real', inc !== null && inc.buildingId !== null);
  eq('H2 it starts queued', inc.status, 'queued');
  eq('H3 with the caller\'s first, partial story', typeof inc.report, 'string');
  ok('H4 and it seeded a fire', s.hazards.some((h) => h.kind === 'fire' && h.incidentId === inc.id));

  const report0 = inc.report;
  s.player.x = 10; s.player.y = 290;                 // crew far away, doing nothing
  for (const a of s.apparatus) { a.x = 10; a.y = 290; }
  run(g, 60000);
  gt('H5 danger climbs while it is ignored', inc.danger, 0);
  ok('H6 the caller updates the story', inc.report !== report0, inc.report);
  ok('H7 an ignored fire escalates its priority', inc.priority !== 'routine');

  run(g, 300000);
  eq('H8 eventually it is simply lost', inc.status, 'lost');
  ok('H9 with a factual note, not a fail screen', typeof inc.outcomeNote === 'string' && inc.outcomeNote.length > 0,
    inc.outcomeNote);
  ok('H10 and the shift carries on', s.mode === MODES.PLAYING);
  gt('H11 the building damage was written through as it happened',
    (s.town.buildings[inc.buildingId] || { damage: 0 }).damage, 0);
  ok('H12 the town lost confidence', s.town.confidence < CONFIG.town.startConfidence);
  gt('H13 telemetry counted a call nobody worked', s.telemetry.callsNeverWorked, 0);
}
{
  // and the other way: hazards cleared and people handled closes the call
  const g = fresh(72, 'close');
  const s = g.state;
  const inc = createIncident(s, TEMPLATE_BY_ID.tree_down, new Rng(10));
  const tree = s.hazards.find((h) => h.kind === 'tree' && h.incidentId === inc.id);
  s.player.x = inc.x + 1; s.player.y = inc.y + 1;    // crew on scene
  run(g, 500);
  eq('H14 arriving marks the call active', inc.status, 'active');

  tree.cut = 1; tree.cleared = true; tree.resolved = true;
  run(g, 500);
  eq('H15 clearing the hazard controls the call', inc.status, 'controlled');
  ok('H16 and the town notices', s.town.confidence > CONFIG.town.startConfidence);
  ok('H17 the outcome note says the road reopened', /reopened/.test(inc.outcomeNote), inc.outcomeNote);
}
emit('running H');
}

/* ── I. consequence across shifts (Phase 4) ──────────────────────────────── */
function sectionI() {
lines.push('--- I. the next shift starts in the town you left ---');
{
  const town = defaultTown();
  town.buildings.pizza = { damage: 0.85, boardedShifts: 0, timesBurned: 1 };
  town.hydrants.hyd_elm = { damaged: true };
  town.confidence = 0.4;

  const next = advanceShift(town, 'Tony’s Pizza destroyed');
  eq('I1 shift number advances', next.shiftNumber, 2);
  ok('I2 a gutted building is boarded up', next.buildings.pizza.boardedShifts > 0);
  eq('I3 boarded damage does not quietly repair', next.buildings.pizza.damage, 0.85);
  eq('I4 the struck hydrant is still out', next.hydrants.hyd_elm.damaged, true);
  eq('I5 confidence carries over', next.confidence, 0.4);
  ok('I6 the headline is kept', next.history[0].includes('Pizza'));

  // and a boarded-up shop is not where the next kitchen fire happens
  const g = fresh(5, 'boarded');
  g.state.town = next;
  const rng = new Rng(11);
  let placedInBoarded = 0;
  for (let i = 0; i < 40; i++) {
    const inc = createIncident(g.state, TEMPLATE_BY_ID.kitchen_fire, rng);
    if (inc && inc.buildingId === 'pizza') placedInBoarded++;
    if (inc) { inc.status = 'controlled'; }        // free the site up again
  }
  eq('I7 nobody is cooking in a boarded-up shop', placedInBoarded, 0);
}
emit('running I');
}

/* ── J. the signature scenario ───────────────────────────────────────────── */
function sectionJ() {
lines.push('--- J. acceptance: the GDD signature scenario ---');
{
  // Nobody responds at all. The town must still run a coherent ten minutes.
  const g = fresh(20260818, 'accept', false);
  const s = g.state;
  run(g, CONFIG.shift.durationMs + 1000);

  eq('J1 the shift ends by itself', s.mode, MODES.REPORT);
  gt('J2 several calls came in', s.incidents.length, 3);
  ok('J3 all five families are possible in one town',
    new Set(TEMPLATES.map((t) => t.family)).size === 5);
  gt('J4 calls were lost, because nobody went', s.outcome.lost, 0);
  ok('J5 there is a report', s.report !== null);
  ok('J6 with a headline that names what happened', typeof s.report.headline === 'string' && s.report.headline.length > 10,
    s.report && s.report.headline);
  ok('J7 and a factual standfirst', /call/.test(s.report.standfirst), s.report && s.report.standfirst);
  ok('J8 confidence fell', s.report.confidenceDelta < 0);
  ok('J9 the town recorded structural damage', s.report.damaged.length > 0,
    JSON.stringify(s.report.damaged));
  eq('J10 the shift ran its full length', Math.round(s.simTimeMs / 1000), Math.round(CONFIG.shift.durationMs / 1000));
  ok('J11 the simulation stayed bounded', s.hazards.length < 200 && s.radio.length <= 40,
    `${s.hazards.length} hazards, ${s.radio.length} radio lines`);
}
{
  // The other half of the gate: a crew that actually turns up can close a fire call,
  // and doing so requires the engine, the hose and the water — in that order.
  const g = fresh(4242, 'respond');
  const s = g.state;

  const inc = createIncident(s, TEMPLATE_BY_ID.kitchen_fire, new Rng(12));
  const fire = s.hazards.find((h) => h.kind === 'fire' && h.incidentId === inc.id);
  const b = BUILDING_BY_ID[inc.buildingId];
  // A kitchen fire may also come with an occupant. Getting them out is a different
  // loop and it is tested in section F; this test is about whether water closes a
  // structure fire, so the building is empty here.
  s.victims.length = 0;
  inc.victimIds.length = 0;

  // Drive the engine to the address and spot it by the door, then take the line in.
  const eng = s.apparatus.find((a) => a.id === 'engine');
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const ux = b.door.x - cx, uy = b.door.y - cy, ul = Math.hypot(ux, uy) || 1;
  eng.x = b.door.x + (ux / ul) * 4; eng.y = b.door.y + (uy / ul) * 4; eng.speed = 0;
  s.player.x = eng.x; s.player.y = eng.y;
  ok('J12 the hose comes off the engine', take(g, 'hose'));

  // A stub that holds the trigger down. g.step(STEP, null) presses nothing at all —
  // the first version of this test stood a responder beside a fire for four minutes
  // with the nozzle shut and then reported that water does not work.
  const holdUse = {
    moveAxis: () => ({ x: 0, y: 0 }),
    isDown: (a) => a === 'use',
    wasPressed: () => false,
    wasReleased: () => false,
    endStep: () => {},
  };

  // Make entry. The stream reaches 8.5 m and a shop is 26 m deep, so a fire cannot be
  // fought from the kerb — the responder goes in through the door and is then contained
  // by the walls, which is what src/sim/movement.js models and what the hose length is
  // a constraint on.
  s.player.insideBuildingId = inc.buildingId;

  let controlled = false;
  for (let t = 0; t < 240000 && !controlled; t += STEP) {
    const hot = fire.cells.filter((c) => c.burning || c.heat > 0.3)
      .sort((c1, c2) => c2.heat - c1.heat)[0] || fire.cells[0];
    // The line only reaches so far. Working the far side of a big building means
    // repositioning the engine, which is what a crew would actually have to do.
    if (dist(eng.x, eng.y, hot.x, hot.y) > CONFIG.water.hoseMaxLengthM - 8) {
      eng.x = hot.x + 9; eng.y = hot.y + 9;
    }
    // stand three metres off the worst of it and point the line at it
    s.player.x = hot.x - 3; s.player.y = hot.y;
    s.player.facing = 0;
    if (eng.waterL < 400) eng.waterL = 2500;      // the supply problem is tested in B
    g.step(STEP, holdUse);
    if (inc.status === 'controlled') controlled = true;
  }
  ok('J13 a crew with the right truck can control a structure fire', controlled,
    `status ${inc.status}, burning ${fire.burningCount}, danger ${inc.danger.toFixed(2)}`);
  ok('J14 and saves most of the building', fireDamageFraction(fire) < 0.6,
    `${Math.round(fireDamageFraction(fire) * 100)}% burnt`);
  ok('J15 the town gained confidence for it', s.town.confidence > CONFIG.town.startConfidence,
    s.town.confidence.toFixed(3));
}
emit(null);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE();
  sectionF(); sectionG(); sectionH(); sectionI(); sectionJ();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
