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
import { Game, MODES, toggleCoop, readCommand } from './game.js';
import { radio } from './sim/dispatch.js';
import { Input } from './core/input.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';
import { DebugOverlay } from './dev/debugOverlay.js';
import { GameAudio } from './audio/audio.js';
import { NetSession, ROLE } from './net/net.js';
import { roomFromUrl, shareUrl } from './net/link.js';
import { TouchControls, looksLikeTouch } from './ui/touch.js';
import { nextHint, learnFromEvent, learnFromDistance } from './ui/coach.js';
import { saveTown } from './core/persistence.js';
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
  tilt: CONFIG.render.tilt,
  heightK: CONFIG.render.heightScale,
  leanK: CONFIG.render.lean,
});
const renderer = new Renderer(canvas, camera);
const input = new Input(window).attach();
const hud = new Hud(uiRoot, game);
const debug = new DebugOverlay(uiRoot, game, renderer);
const audio = new GameAudio();
const touch = new TouchControls(uiRoot, input);
if (looksLikeTouch()) touch.enable();
const net = new NetSession(game);
net.onStatus = (st) => hud.setNetStatus(st, net);

/* A browser will not give out an AudioContext before a real gesture, so the layer stays
   dead until one arrives — and must behave identically in that state, which is also the
   state the headless harness runs in. Every simulation event goes through onEvent();
   unknown ones are silent rather than fatal, so adding an event never breaks sound. */
const armAudio = () => { audio.arm(); audio.resume(); };
window.addEventListener('keydown', armAudio, { once: true });
window.addEventListener('pointerdown', armAudio, { once: true });
game.bus.onAny((evt) => audio.onEvent(evt.type, evt, evt.simTimeMs));

/* The coach retires a lesson the first time the player DOES the thing, not after a
   timer or a click, and the flags live in the town save so shift three is quiet. */
/* A save that fails is not allowed to fail quietly.
 *
 * saveTown returns false when the browser refuses — a full quota, private browsing, a
 * locked-down profile — and every call site ignored it. Measured: with storage refused,
 * three shifts ran and the player was shown "Shift 1" three times, with the town
 * silently resetting each time and nothing anywhere saying so. Told once, on the radio
 * the player is already reading, because told every shift is nagging. */
let saveWarned = false;
function persist(town) {
  if (saveTown(town)) return true;
  if (!saveWarned) {
    saveWarned = true;
    radio(game.state, 'This browser will not let the game save. The town will not carry '
      + 'over to the next shift.', 'bad');
  }
  return false;
}

game.bus.onAny((evt) => {
  if (game.state.town && learnFromEvent(game.state.town.learned || (game.state.town.learned = {}), evt.type)) {
    persist(game.state.town);
  }
});

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
  if (e.code === 'KeyP' && game.state.mode === MODES.PLAYING) {
    e.preventDefault();
    /* Not while somebody is connected over the network.
     *
     * P adds or removes the SECOND responder, and a remote player IS the second
     * responder. Pressing it during a network game evicted them: measured, the crew
     * dropped to one while the link stayed open and the status still read "connected",
     * so the client went on playing a town it was no longer in — and pressing P again
     * gave their slot to a local partner, so their commands went nowhere. */
    if (net.online) {
      radio(game.state, 'Somebody is already on the crew over the network.', 'system');
      return;
    }
    const on = toggleCoop(game.state);
    radio(game.state, on ? 'Second volunteer signed on. Arrow keys, right shift, and /.'
      : 'Second volunteer signed off.', 'system');
  }
});

function startShift() {
  game.startShift();
  camera.setMode('follow');
  camera.follow(game.state.player.x, game.state.player.y, 0);
}

/* The join flow. A client's shift is the host's shift, so it must NOT start its own —
   it waits, black-screen-free, on the title card until the first snapshot lands. */
hud.onHost = () => {
  audio.arm();
  if (game.state.mode === MODES.TITLE) startShift();
  const code = net.hostPeer();
  /* The host's address bar becomes the invitation. Putting the room in the URL means
     the thing a player already knows how to do — copy the link, paste it in a chat — is
     the thing that invites somebody, instead of reading five characters down a phone. */
  if (code) {
    const url = shareUrl(location.href, code);
    try { history.replaceState(null, '', `#room=${code}`); } catch (e) { /* file://, older browsers */ }
    hud.setShareUrl(url);
  }
  hud.setNetStatus(net.status, net);
};
hud.onJoin = (code) => {
  audio.arm();
  net.joinPeer(code);
  hud.setNetStatus(net.status, net);
};
hud.onLeaveNet = () => {
  net.leave();
  hud.setShareUrl(null);
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  hud.setNetStatus(net.status, net);
};

/* Somebody opened an invitation. Fill the box, say so, and join — the tap that opened
   the link IS the intent, and making them press a second button to honour it is the
   kind of friction that ends with "it didn't work". */
const invited = roomFromUrl(location.href);
if (invited) {
  hud.setInvitedCode(invited);
  net.joinPeer(invited);
  hud.setNetStatus(net.status, net);
}
hud.onStart = startShift;
hud.setMuted(audio.muted);

let last = performance.now();
let camSnapped = false;

function frame(now) {
  const dt = now - last;
  last = now;

  camera.resize(canvas);

  /* Zoom is a readability decision that changes with what you are doing: wide enough
     to plan a route from the cab, tight enough to lay a hose on foot — and in co-op,
     wide enough that a partner who has wandered off is still on the screen rather than
     an arrow at the edge of it. */
  const crew = game.state.responders;
  const anyDriving = crew.some((r) => r.inVehicleId);
  let spread = 0;
  for (const a of crew) for (const b of crew) spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y));
  /* The readability budget scales with the screen. 165 m across a 390 px phone is
     2.4 px/m — a person is two pixels and a street sign is nothing — so a hand-held
     device gets a proportionally tighter view rather than the same one shrunk. */
  /* Hold V (or the MAP button) to see the whole town.
   *
   * The GDD asks a player to be able to answer "what am I not doing right now", and
   * triage is the game's central verb — but the camera only ever showed one street, so
   * the answer lived entirely in the dispatch list. This pauses NOTHING: the fire keeps
   * spreading while you look at it, which is the only version of an overview this
   * design allows (implementation rule 3). */
  const overview = input.isDown('overview') && game.state.mode === MODES.PLAYING;
  const wanted = overview
    ? WORLD.widthM + CONFIG.render.fitPaddingM * 2
    : Math.max(TouchControls.viewWidthFor(camera.cssW, anyDriving), spread * 1.9);
  if (Math.abs(camera.viewWidthM - wanted) > 0.2) {
    // Out fast, back at the usual pace: a peek that takes a second to arrive is a peek
    // nobody uses while a building is burning.
    const rate = CONFIG.render.zoomLerp * (overview ? 2.6 : 1);
    const k = 1 - Math.exp(-rate * Math.min(dt, 100) / 1000);
    camera.viewWidthM += (wanted - camera.viewWidthM) * k;
    camera._recomputeScale();
  }

  /* Mouse aim. input.pointerWorld has claimed since it was written that main.js
     recomputes it every frame; nothing ever did, so it was permanently null and every
     stream came out of the keyboard facing instead. It has to happen HERE because the
     screen->world inverse belongs to the camera, and the camera moved this frame. */
  input.pointerWorld = input.pointer.seen
    ? camera.screenToWorld(input.pointer.x, input.pointer.y)
    : null;

  /* Host and solo step the world; a client does not — game.frame() refuses on a client,
     so this call is the same line either way and the difference stays in one place.
     The command is built here rather than inside game.js because the client needs the
     SAME object to send up the wire: a remote player is a player whose keyboard is
     somewhere else. */
  const localCmd = net.role === ROLE.CLIENT ? readCommand(input) : null;
  game.frame(dt, input);
  net.pump(dt, localCmd);
  /* A client joins mid-shift and its first snapshot can land anywhere in town; easing
     across 200 m of it is a second of watching nothing. Snap once, then ease. */
  const snapCam = net.role === ROLE.CLIENT && net.snapsReceived === 1 && !camSnapped;
  if (snapCam) camSnapped = true;

  // Presentation only. The camera eases on REAL time and keeps easing while paused; it
  // must never feed anything back into the simulation.
  // the camera watches the crew's centre of gravity, not one nominated person
  let cx = 0, cy = 0;
  for (const r of crew) { cx += r.x; cy += r.y; }
  camera.follow(cx / crew.length, cy / crew.length, snapCam ? 0 : Math.min(dt, 100) / 1000);

  renderer.render(game.state, now);
  // Audio is the renderer's twin: same state, a different output device, and no more
  // authority over the simulation than the pixels have. A paused town is a silent one.
  if (game.state.mode === MODES.PLAYING) audio.update(game.state, Math.min(dt, 100));
  else audio.hush();
  /* Driving is learned by doing it: the odometer is already kept for the shift report. */
  if (game.state.town && learnFromDistance(game.state.town.learned || {}, game.state.telemetry.distanceDrivenM)) {
    persist(game.state.town);
  }
  hud.setHint(nextHint(game.state, { learned: game.state.town && game.state.town.learned, touch: touch.enabled }));

  hud.update();
  // the phone's equipment row mirrors the HUD's numbered slots: same list, same order
  if (touch.enabled) touch.setSlots(hud.lastSlots || []);
  debug.update(dt);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* Test and debug handle. The smoke-test harness drives these real objects rather than
   reaching into module scope. */
window.__STES = { game, camera, renderer, hud, debug, input, audio, net, touch, CONFIG, startShift, frame };
