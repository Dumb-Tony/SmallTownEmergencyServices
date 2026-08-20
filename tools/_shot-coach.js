/* A first-timer's opening seconds: the call has landed and the coach is saying the one
   next physical thing, while the town carries on behind it. */
import { CONFIG } from '../src/config.js';
import { nextHint } from '../src/ui/coach.js';
import { clearSave } from '../src/core/persistence.js';
const S = window.__STES;
const g = S.game;
window.requestAnimationFrame = () => 0;
clearSave();
S.startShift();
const s = g.state;
s.town.learned = {};
g.clock.skipMs(24000, (ms) => g.step(ms, null));
g.clock.setPaused(true);
S.camera.resize(document.getElementById('stage'));
S.camera.viewWidthM = CONFIG.render.viewWidthOnFootM;
S.camera._recomputeScale();
S.camera.follow(s.player.x, s.player.y, 0);
S.hud.update();
S.hud.setHint(nextHint(s, { learned: s.town.learned }));
S.renderer.render(s, performance.now());
