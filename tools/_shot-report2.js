/* The report at the end of a THIRD shift, so the carry-over block has something in it. */
import { CONFIG } from '../src/config.js';
import { clearSave } from '../src/core/persistence.js';
import { CrewBot } from './_crewbot.js';
const S = window.__STES;
window.requestAnimationFrame = () => 0;
clearSave();
const STEP = CONFIG.sim.stepMs;
for (let shift = 0; shift < 3; shift++) {
  S.game.startShift();
  const s = S.game.state;
  const bot = new CrewBot(S.game);
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    bot.think();
    S.game.frame(STEP, bot.input);
    if (s.mode !== 'playing') break;
  }
}
S.hud.update();
S.camera.resize(document.getElementById('stage'));
S.renderer.render(S.game.state, performance.now());
