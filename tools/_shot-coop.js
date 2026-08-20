/* Poses two responders on a LIVE fire, for tools\shot.ps1.
 * The fire is created fresh rather than run for a minute first — a posed screenshot of
 * a burnt-out shell tells you nothing about how a fire looks while you are fighting it. */
import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { createIncident } from '../src/sim/incidentSim.js';
import { createFire, stepHazards } from '../src/sim/hazards.js';
import { BUILDING_BY_ID } from '../src/data/town.js';
import { toolsInReachOf, stepInteraction } from '../src/sim/interaction.js';
import { toggleCoop } from '../src/game.js';

const S = window.__STES;
const g = S.game;
S.startShift();
const s = g.state;
const STEP = CONFIG.sim.stepMs;
const cmd = (over) => ({ axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 }, aim: null,
  interact: false, drop: false, use: false, siren: false, slot: null, ...over });

toggleCoop(s);
g.clock.skipMs(24000, (ms) => g.step(ms, null));          // let dispatch speak
createIncident(s, TEMPLATE_BY_ID.crash_pole, new Rng(4)); // something else on the board

// A fire caught mid-fight: posed directly rather than simulated for a minute, because
// a screenshot of a burnt-out shell says nothing about what fighting one looks like.
const b = BUILDING_BY_ID.pizza;
const fire = createFire('pizza', { seedCells: 3, heat: 1.05, from: 'door' });
s.hazards.push(fire);
const cxm = b.x + b.w / 2, cym = b.y + b.h / 2;
for (const c of fire.cells) {
  const d = Math.hypot(c.x - cxm, c.y - cym);
  if (d < 9) { c.burning = true; c.heat = 1.1; c.fuel = 0.8; }
  else if (d < 13) { c.heat = 0.45; }
}
fire.burningCount = fire.cells.filter((c) => c.burning).length;
for (let t = 0; t < 1200; t += STEP) stepHazards(s, STEP, new Rng(9));

const [a, p2] = s.responders;
const eng = s.apparatus.find((x) => x.id === 'engine');
const res = s.apparatus.find((x) => x.id === 'rescue');
eng.x = b.door.x + 1.5; eng.y = b.door.y + 6; eng.angle = -Math.PI / 2; eng.siren = true;
res.x = b.door.x + 12;  res.y = b.door.y + 9; res.angle = -Math.PI / 2.4; res.siren = true;

// one inside on the line
a.x = eng.x; a.y = eng.y;
const av = toolsInReachOf(s, a.x, a.y);
const i = av.findIndex((q) => q.tool.defId === 'hose');
if (i >= 0) stepInteraction(s, cmd({ slot: i }), STEP, a);
const hot = fire.cells.filter((c) => c.burning).sort((m, n) => n.heat - m.heat)[0] || fire.cells[0];
a.insideBuildingId = b.id;
a.x = hot.x - 4.5; a.y = hot.y + 2.5;
a.facing = Math.atan2(hot.y - a.y, hot.x - a.x);
for (let t = 0; t < 700; t += STEP) stepInteraction(s, cmd({ use: true }), STEP, a);

// the other at the door with the extinguisher
p2.x = res.x; p2.y = res.y;
const av2 = toolsInReachOf(s, p2.x, p2.y);
const j = av2.findIndex((q) => q.tool.defId === 'extinguisher');
if (j >= 0) stepInteraction(s, cmd({ slot: j }), STEP, p2);
p2.x = b.door.x + 3.6; p2.y = b.door.y + 2.2;
p2.facing = Math.atan2((b.y + b.h / 2) - p2.y, (b.x + b.w / 2) - p2.x);
for (let t = 0; t < 400; t += STEP) stepInteraction(s, cmd({ use: true }), STEP, p2);

let cx = 0, cy = 0;
for (const r of s.responders) { cx += r.x; cy += r.y; }
S.camera.viewWidthM = 78;
S.camera._recomputeScale();
S.camera.follow(cx / s.responders.length, cy / s.responders.length - 3, 0);
/* Freeze the world for the photograph. main.js's own rAF loop keeps stepping the
   simulation while this module runs, and under a virtual-time budget it steps a LOT —
   the first version of this pose lit a fire and then watched it burn to the ground
   before the shutter. The clock stops; the renderer still draws. */
g.clock.setPaused(true);
for (let k = 0; k < 3; k++) S.frame(performance.now());
