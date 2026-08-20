/* Presentation suite — the three-quarter view.
 *
 * The projection is pure maths and the renderer is a pure reader of state, so both are
 * testable without looking at a single pixel. What is asserted here is what a screenshot
 * cannot tell you: that screen->world still inverts exactly (mouse aim depends on it),
 * that height goes UP and leans OUTWARD, that the draw order is back-to-front, and that
 * drawing a frame changes nothing about the town.
 *
 * What it cannot assert is whether it looks any good. That is what docs/m4-*.png are for.
 */

import { CONFIG } from '../src/config.js';
import { Camera } from '../src/render/camera.js';
import { Renderer, shade } from '../src/render/renderer.js';
import { Game } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { BUILDING_BY_ID } from '../src/data/town.js';
import { WORLD } from '../src/data/town.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const lt = (n, a, b) => ok(n, a < b, `got ${a}, want < ${b}`);

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

function freshCamera() {
  const cam = new Camera({
    worldW: WORLD.widthM, worldH: WORLD.heightM,
    paddingM: CONFIG.render.fitPaddingM, viewWidthM: CONFIG.render.viewWidthM,
    tilt: CONFIG.render.tilt, heightK: CONFIG.render.heightScale, leanK: CONFIG.render.lean,
  });
  cam.cssW = 1600; cam.cssH = 900; cam.dpr = 1;
  cam._recomputeScale();
  cam.centre = { x: 200, y: 150 };
  return cam;
}

function freshGame(seed = 4242) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  return g;
}

/* ── A. the projection inverts, rises and leans ──────────────────────────── */
function sectionA() {
lines.push('--- A. the projection (mouse aim depends on every one of these) ---');
  const cam = freshCamera();

  const s = cam.worldToScreen(200, 150);
  near('A1 the camera centre lands at the centre of the frame', s.x, 800, 0.01);
  near('A2 and vertically too', s.y, 450, 0.01);

  for (const [x, y] of [[200, 150], [240, 190], [61.5, 288.25], [399, 12]]) {
    const p = cam.worldToScreen(x, y);
    const back = cam.screenToWorld(p.x, p.y);
    near(`A3 ${x},${y} survives the round trip in x`, back.x, x, 1e-6);
    near(`A4 ${x},${y} survives the round trip in y`, back.y, y, 1e-6);
  }

  // the whole point of a tilt: the same distance covers fewer pixels north-south
  const east = cam.worldToScreen(210, 150), south = cam.worldToScreen(200, 160);
  const dx = east.x - s.x, dy = south.y - s.y;
  gt('A5 ten metres east is more pixels than ten metres south', dx, dy);
  near('A6 and shorter by exactly the tilt', dy / dx, CONFIG.render.tilt, 1e-9);

  // height
  const ground = cam.worldToScreen(200, 150);
  const up6 = cam.top(200, 150, 6);
  const up6s = cam.worldToScreen(up6.x, up6.y);
  lt('A7 six metres up is up the screen, not down it', up6s.y, ground.y);
  near('A8 and rises by heightScale metres of screen', ground.y - up6s.y,
    6 * CONFIG.render.heightScale * cam.scale, 0.01);
  near('A9 a metre of rise is riseFor(1)', cam.riseFor(1), CONFIG.render.heightScale * cam.scale, 1e-9);
  eq('A10 zero height changes nothing', cam.top(200, 150, 0).y, 150);

  // lean
  eq('A11 nothing leans at the centre of the frame', cam.top(200, 150, 8).x, 200);
  const right = cam.top(260, 150, 8), left = cam.top(140, 150, 8);
  gt('A12 a tower right of centre leans further right', right.x, 260);
  lt('A13 and one left of centre leans further left', left.x, 140);
  near('A14 symmetrically', (right.x - 260) + (left.x - 140), 0, 1e-9);
  gt('A15 a taller tower leans further', cam.top(260, 150, 16).x, right.x);

  // the visible rectangle
  const v = cam.visibleM;
  near('A16 the visible width is the readability budget', v.w, CONFIG.render.viewWidthM, 0.01);
  gt('A17 the tilt makes more of the town visible north-south than a flat camera would',
    v.h, cam.cssH / cam.scale);
  near('A18 and its corner is the centre less half of it', v.x, 200 - v.w / 2, 1e-9);
  near('A19 in y as well', v.y, 150 - v.h / 2, 1e-9);
  ok('A20 every field is a real number', [v.w, v.h, v.x, v.y].every(Number.isFinite));
}

/* ── B. drawing changes nothing, and happens back to front ───────────────── */
function sectionB() {
lines.push('--- B. the renderer reads the town and never writes it ---');
  const g = freshGame();
  const s = g.state;
  g.clock.skipMs(70000, (ms) => g.step(ms, null));

  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 450;
  const cam = freshCamera();
  const r = new Renderer(canvas, cam);
  cam.follow(s.player.x, s.player.y, 0);

  const before = JSON.stringify({
    t: s.simTimeMs, p: [s.player.x, s.player.y, s.player.facing],
    h: s.hazards.map((z) => [z.kind, z.x, z.y, z.resolved]),
    v: s.victims.map((z) => [z.x, z.y, z.condition]),
    a: s.apparatus.map((z) => [z.x, z.y, z.angle, z.waterL]),
    c: s.town.confidence,
  });
  r.render(s, 1000);
  r.render(s, 1016);
  const after = JSON.stringify({
    t: s.simTimeMs, p: [s.player.x, s.player.y, s.player.facing],
    h: s.hazards.map((z) => [z.kind, z.x, z.y, z.resolved]),
    v: s.victims.map((z) => [z.x, z.y, z.condition]),
    a: s.apparatus.map((z) => [z.x, z.y, z.angle, z.waterL]),
    c: s.town.confidence,
  });
  eq('B1 two frames leave the town exactly as it was', after, before);
  eq('B2 and no simulation time passed', s.simTimeMs, g.clock.simTimeMs);

  gt('B3 the frame collected props to draw', r.props.length, 20);
  let sorted = true;
  for (let i = 1; i < r.props.length; i++) if (r.props[i].depth < r.props[i - 1].depth) sorted = false;
  ok('B4 and drew them back to front, so the near thing wins', sorted);
  ok('B5 every prop knows how to draw itself', r.props.every((p) => typeof p.draw === 'function'));
  gt('B6 labels were produced for the HUD pass', r.labels.length, 5);

  // the depth key is the SOUTH edge: a building draws before anything standing south of it
  const b = BUILDING_BY_ID.pizza;
  const bp = r.props.find((p) => Math.abs(p.depth - (b.y + b.h)) < 0.001);
  ok('B7 a building sorts by the edge nearest the camera', !!bp);
}

/* ── C. you can always see the crew ──────────────────────────────────────── */
function sectionC() {
lines.push('--- C. no building is allowed to hide the person you are steering ---');
  const g = freshGame(77);
  const s = g.state;
  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 450;
  const cam = freshCamera();
  const r = new Renderer(canvas, cam);

  const b = BUILDING_BY_ID.hardware;

  // standing in front of it (south): nothing to hide behind
  s.player.x = b.x + b.w / 2; s.player.y = b.y + b.h + 8;
  s.player.insideBuildingId = null;
  ok('C1 a responder in front of a building does not veil it', !r.veils(b, s));

  // standing behind it (north): the building is between them and the camera
  s.player.y = b.y - 6;
  ok('C2 a responder behind one does', r.veils(b, s));

  // well past it, still north but out of the silhouette
  s.player.y = b.y - 120;
  ok('C3 but not from three streets away', !r.veils(b, s));

  // off to the side
  s.player.x = b.x - 40; s.player.y = b.y - 6;
  ok('C4 nor from beside it', !r.veils(b, s));

  // a parked truck is scenery; a truck with a driver is a person
  s.player.x = 10; s.player.y = 10;
  const ap = s.apparatus[0];
  ap.x = b.x + b.w / 2; ap.y = b.y - 5; ap.driverId = null;
  ok('C5 an empty parked truck does not veil anything', !r.veils(b, s));
  ap.driverId = s.player.id;
  ok('C6 a truck with somebody in it does', r.veils(b, s));

  // and somebody who has gone inside gets the roof taken off instead
  const station = BUILDING_BY_ID.station;
  s.player.insideBuildingId = station.id;
  s.player.x = station.x + 4; s.player.y = station.y + 4;
  r.render(s, 0);
  const depth = r.props.filter((p) => Math.abs(p.depth - (station.y + station.h + 0.01)) < 0.0001);
  eq('C7 someone indoors sorts with the building, not with the grass outside it', depth.length, 1);
}

/* ── D. the town has height at all ───────────────────────────────────────── */
function sectionD() {
lines.push('--- D. height is real, and the same every frame ---');
  const cam = freshCamera();
  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 300;
  const r = new Renderer(canvas, cam);

  const pts = r.rectPts(100, 100, 20, 10);
  eq('D1 a footprint is four corners', pts.length, 4);
  eq('D2 clockwise from the north-west', `${pts[0].x},${pts[0].y}|${pts[2].x},${pts[2].y}`, '100,100|120,110');

  const up = r.topPts(pts, 6);
  eq('D3 the top has the same number of corners', up.length, 4);
  ok('D4 and every one of them is higher up the screen', up.every((p, i) => p.y < pts[i].y));

  // determinism: the renderer must never call Math.random
  const g = freshGame(9);
  g.clock.skipMs(40000, (ms) => g.step(ms, null));
  r.render(g.state, 5000);
  const a = r.props.map((p) => p.depth.toFixed(4)).join(',');
  r.render(g.state, 5000);
  const b = r.props.map((p) => p.depth.toFixed(4)).join(',');
  eq('D5 the same town at the same instant draws identically', b, a);
}

/* ── E. the colour helper every face depends on ──────────────────────────── */
function sectionE() {
lines.push('--- E. shading (this one cost an evening: it painted trucks black) ---');
  eq('E1 hex darkens', shade('#c0392b', 0.5), 'rgb(96,29,22)');
  eq('E2 hex lightens', shade('#c0392b', 1.22), 'rgb(234,70,52)');
  eq('E3 and clamps rather than wrapping', shade('#c0392b', 9), 'rgb(255,255,255)');

  /* The one that mattered. A cab is a lighter version of a body that is ALREADY a
     shaded face, so shade() is routinely handed its own output. Hex-only, that parsed
     as NaN, and NaN >> 16 & 255 is 0 — so the surface came out pure black instead of
     unchanged-ish, and nothing threw. */
  const once = shade('#c0392b', 1.06);
  eq('E4 shade takes its own output back', shade(once, 1.0), 'rgb(204,60,46)');
  ok('E5 and shading twice is not black', shade(once, 0.62) !== 'rgb(0,0,0)', shade(once, 0.62));
  const twice = shade(shade('#808080', 0.5), 0.5);
  eq('E6 two halves are a quarter', twice, 'rgb(32,32,32)');
  eq('E7 nonsense is passed through, not turned into black', shade('nonsense', 0.5), 'nonsense');
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE();
  emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
