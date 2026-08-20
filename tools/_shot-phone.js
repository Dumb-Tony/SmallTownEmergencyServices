/* Poses a live shift on a phone-sized screen with the touch controls forced on, so the
   mobile layout can be looked at from a desktop harness. */
import { CONFIG } from '../src/config.js';
import { TouchControls } from '../src/ui/touch.js';
const S = window.__STES;
const g = S.game;
window.requestAnimationFrame = () => 0;
S.startShift();
const s = g.state;
S.touch.enable();
g.clock.skipMs(46000, (ms) => g.step(ms, null));

// walk the responder to the fire so the scene has something in it
const fire = s.hazards.find((h) => h.kind === 'fire');
if (fire) {
  const eng = s.apparatus.find((a) => a.id === 'engine');
  const c = fire.cells.find((q) => q.burning) || fire.cells[0];
  eng.x = c.x + 12; eng.y = c.y + 14; eng.angle = -2.2; eng.siren = true;
  s.player.x = c.x + 8; s.player.y = c.y + 10;
  s.player.facing = Math.atan2(c.y - s.player.y, c.x - s.player.x);
}
g.clock.setPaused(true);
S.camera.resize(document.getElementById('stage'));
S.camera.viewWidthM = TouchControls.viewWidthFor(S.camera.cssW, false);
S.camera._recomputeScale();
S.camera.follow(s.player.x, s.player.y, 0);
S.hud.update();
S.touch.setSlots(S.hud.lastSlots || [{ short: 'HOSE' }, { short: 'WRENCH' }]);
S.renderer.render(s, performance.now());
void CONFIG;
