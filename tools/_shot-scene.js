/* Poses a working shift for tools\shot.ps1: a fire being fought at one address while
 * two other calls sit in the queue. Runs after main.js and drives the real objects
 * through window.__STES — never a mock. */

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { createIncident } from '../src/sim/incidentSim.js';
import { BUILDING_BY_ID } from '../src/data/town.js';
import { stepInteraction, toolsInReachOf } from '../src/sim/interaction.js';

const S = window.__STES;
const g = S.game;
S.startShift();
const s = g.state;
const STEP = CONFIG.sim.stepMs;

// let the shift run so dispatch has spoken and the first fire has taken hold
g.clock.skipMs(52000, (ms) => g.step(ms, null));

// a second and third call, so the dispatch panel shows real triage pressure
createIncident(s, TEMPLATE_BY_ID.crash_pole, new Rng(4));
createIncident(s, TEMPLATE_BY_ID.tree_down, new Rng(9));
g.clock.skipMs(9000, (ms) => g.step(ms, null));

// spot the engine at the fire and make entry with the line
const fire = s.hazards.find((h) => h.kind === 'fire');
if (fire) {
  const b = BUILDING_BY_ID[fire.buildingId];
  const eng = s.apparatus.find((a) => a.id === 'engine');
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const ux = b.door.x - cx, uy = b.door.y - cy, ul = Math.hypot(ux, uy) || 1;
  eng.x = b.door.x + (ux / ul) * 5; eng.y = b.door.y + (uy / ul) * 5;
  eng.angle = Math.atan2(-uy, -ux);
  eng.siren = true;

  s.player.x = eng.x; s.player.y = eng.y;
  const avail = toolsInReachOf(s, s.player.x, s.player.y);
  const i = avail.findIndex((a) => a.tool.defId === 'hose');
  if (i >= 0) stepInteraction(s, { axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 },
    interact: false, drop: false, use: false, siren: false, slot: i }, STEP);

  const hot = fire.cells.filter((c) => c.burning).sort((a, b2) => b2.heat - a.heat)[0] || fire.cells[0];
  s.player.insideBuildingId = b.id;
  s.player.x = hot.x - 4; s.player.y = hot.y + 1;
  s.player.facing = Math.atan2(hot.y - s.player.y, hot.x - s.player.x);

  const hold = { axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 },
    interact: false, drop: false, use: true, siren: false, slot: null };
  for (let t = 0; t < 900; t += STEP) stepInteraction(s, hold, STEP);
}

S.camera.follow(s.player.x, s.player.y, 0);
S.camera.viewWidthM = CONFIG.render.viewWidthOnFootM;
S.camera._recomputeScale();
S.camera.follow(s.player.x, s.player.y, 0);

// draw a few frames so the HUD and the canvas are both current
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
