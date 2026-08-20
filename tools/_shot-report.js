/* Poses the end-of-shift report for tools\shot.ps1: a full ten minutes run with
 * nobody responding, which is the worst-case newspaper. */
import { CONFIG } from '../src/config.js';
const S = window.__STES;
const g = S.game;
S.startShift();
g.clock.skipMs(CONFIG.shift.durationMs + 2000, (ms) => g.step(ms, null));
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
