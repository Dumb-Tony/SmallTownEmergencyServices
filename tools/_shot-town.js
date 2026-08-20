/* Poses the driving view for tools\shot.ps1: the engine on Main Street with the siren
 * on and three calls outstanding, to check that the town reads at driving zoom. */

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { createIncident } from '../src/sim/incidentSim.js';

const S = window.__STES;
const g = S.game;
S.startShift();
const s = g.state;

g.clock.skipMs(64000, (ms) => g.step(ms, null));
createIncident(s, TEMPLATE_BY_ID.two_car, new Rng(3));
createIncident(s, TEMPLATE_BY_ID.gas_odour, new Rng(7));
createIncident(s, TEMPLATE_BY_ID.tree_down, new Rng(11));
g.clock.skipMs(12000, (ms) => g.step(ms, null));

const eng = s.apparatus.find((a) => a.id === 'engine');
eng.x = 196; eng.y = 150; eng.angle = 0; eng.speed = 14; eng.siren = true;
eng.driverId = s.player.id;
s.player.inVehicleId = eng.id;
s.player.x = eng.x; s.player.y = eng.y; s.player.facing = eng.angle;

S.camera.viewWidthM = CONFIG.render.viewWidthM;
S.camera._recomputeScale();
S.camera.follow(eng.x, eng.y, 0);
g.clock.setPaused(true);
/* Freeze the page, then draw the pose directly.

   main.js's frame() re-schedules itself forever, and a headless Chrome whose page never
   goes idle never reaches its virtual-time budget — so the shutter never fires and the
   run hangs until something kills it. Stubbing rAF here is safe because this module
   runs after main.js but before the first callback: the loop has been scheduled and has
   not started, so nothing is half-drawn. The pose then renders exactly once. */
window.requestAnimationFrame = () => 0;
S.camera.resize(document.getElementById('stage'));
S.renderer.render(S.game.state, performance.now());
S.hud.update();
