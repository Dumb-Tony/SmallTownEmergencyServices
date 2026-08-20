/* Bootstrap. The only place mutable globals live.
 *
 * The frame is deliberately dumb, and simulation can advance nowhere else:
 *   rAF -> game.frame(dt, input) -> clock.advance -> N * game.step
 *       -> camera.follow -> renderer.render(state) -> hud.update() -> debug.update()
 * That is the pause guarantee, and it is also why the smoke tests can drive `frame`
 * directly instead of waiting for animation callbacks that headless Chrome will not
 * deliver (Dev\INDEX.md -> Testing).
 */

import { CONFIG } from './config.js';
import { Game, MODES } from './game.js';
import { Input } from './core/input.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';
import { DebugOverlay } from './dev/debugOverlay.js';
import { GameAudio } from './audio/audio.js';
import { WORLD } from './data/town.js';

const canvas = document.getElementById('stage');
const uiRoot = document.getElementById('ui');

const game = new Game({ seed: CONFIG.sim.defaultSeed, seedLabel: CONFIG.sim.seedLabel });

const camera = new Camera({
  worldW: WORLD.widthM,
  worldH: WORLD.heightM,
  paddingM: CONFIG.render.fitPaddingM,
  maxPixelRatio: CONFIG.render.maxPixelRatio,
  viewWidthM: CONFIG.render.viewWidthM,
  followLerp: CONFIG.render.followLerp,
});
const renderer = new Renderer(canvas, camera);
const input = new Input(window).attach();
const hud = new Hud(uiRoot, game);
const debug = new DebugOverlay(uiRoot, game, renderer);
const audio = new GameAudio();

/* A browser will not give out an AudioContext before a real gesture, so the layer stays
   dead until one arrives — and must behave identically in that state, which is also the
   state the headless harness runs in. Every simulation event goes through onEvent();
   unknown ones are silent rather than fatal, so adding an event never breaks sound. */
const armAudio = () => { audio.arm(); audio.resume(); };
window.addEventListener('keydown', armAudio, { once: true });
window.addEventListener('pointerdown', armAudio, { once: true });
game.bus.onAny((evt) => audio.onEvent(evt.type, evt, evt.simTimeMs));

/* Alt-tabbing out of a live town and coming back to three lost calls is a bug report,
   not a difficulty setting. */
input.onBlur = () => game.pauseForBlur();
document.addEventListener('visibilitychange', () => { if (document.hidden) game.pauseForBlur(); });

/* Screen-level keys ride the real keydown rather than the per-step edge buffer: pause
   has to work on the frame it is pressed, including while no steps are being consumed. */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    e.preventDefault();
    if (game.state.mode === MODES.TITLE || game.state.mode === MODES.REPORT) startShift();
    else game.togglePause();
  }
  if (e.code === 'Tab') { e.preventDefault(); hud.toggleExpanded(); }
  if (e.code === 'KeyR' && game.state.mode === MODES.PAUSED) { e.preventDefault(); startShift(); }
  if (e.code === 'KeyM') { e.preventDefault(); audio.toggleMute(); hud.setMuted(audio.muted); }
});

function startShift() {
  game.startShift();
  camera.setMode('follow');
  camera.follow(game.state.player.x, game.state.player.y, 0);
}
hud.onStart = startShift;
hud.setMuted(audio.muted);

let last = performance.now();

function frame(now) {
  const dt = now - last;
  last = now;

  camera.resize(canvas);

  // Zoom is a readability decision that changes with what you are doing: wide enough
  // to plan a route from the cab, tight enough to lay a hose on foot.
  const wanted = game.state.player.inVehicleId ? CONFIG.render.viewWidthM : CONFIG.render.viewWidthOnFootM;
  if (Math.abs(camera.viewWidthM - wanted) > 0.2) {
    const k = 1 - Math.exp(-CONFIG.render.zoomLerp * Math.min(dt, 100) / 1000);
    camera.viewWidthM += (wanted - camera.viewWidthM) * k;
    camera._recomputeScale();
  }

  game.frame(dt, input);

  // Presentation only. The camera eases on REAL time and keeps easing while paused; it
  // must never feed anything back into the simulation.
  camera.follow(game.state.player.x, game.state.player.y, Math.min(dt, 100) / 1000);

  renderer.render(game.state, now);
  // Audio is the renderer's twin: same state, a different output device, and no more
  // authority over the simulation than the pixels have. A paused town is a silent one.
  if (game.state.mode === MODES.PLAYING) audio.update(game.state, Math.min(dt, 100));
  else audio.hush();
  hud.update();
  debug.update(dt);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* Test and debug handle. The smoke-test harness drives these real objects rather than
   reaching into module scope. */
window.__STES = { game, camera, renderer, hud, debug, input, audio, CONFIG, startShift, frame };
