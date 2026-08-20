/* How long does one frame take to draw? Verify with numbers, not vibes.
 *
 * The three-quarter renderer draws hundreds of polygons where the flat one drew
 * rectangles, and "it feels fine" is not a measurement. This poses a busy town — a
 * building alight, a crash, a live line — and times the renderer alone.
 */

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { createIncident } from '../src/sim/incidentSim.js';
import { TouchControls } from '../src/ui/touch.js';

const lines = [];
let _pre = null;
function emit() {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:12px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\nALL-PASS  measured\n==STESTEST-END==';
}

try {
  const S = window.__STES;
  const g = S.game;
  S.startShift();
  const s = g.state;

  g.clock.skipMs(60000, (ms) => g.step(ms, null));
  createIncident(s, TEMPLATE_BY_ID.crash_pole, new Rng(4));
  createIncident(s, TEMPLATE_BY_ID.tree_down, new Rng(9));
  createIncident(s, TEMPLATE_BY_ID.gas_odour, new Rng(11));
  g.clock.skipMs(30000, (ms) => g.step(ms, null));
  g.clock.setPaused(true);

  const fires = s.hazards.filter((h) => h.kind === 'fire');
  const burning = fires.reduce((n, f) => n + f.cells.filter((c) => c.burning).length, 0);
  lines.push(`town: ${s.hazards.length} hazards, ${fires.length} fires, ${burning} cells alight, ` +
    `${s.victims.length} casualties, ${s.incidents.length} calls`);

  // put somebody inside the burning building, so the dollhouse path is measured too
  const fire0 = s.hazards.find((h) => h.kind === 'fire');
  if (fire0) { s.player.insideBuildingId = fire0.buildingId; }

  // the camera has to be somewhere real, or half the props are off screen and free
  S.camera.resize(document.getElementById('stage'));
  S.camera.follow(s.player.x, s.player.y, 0);

  /* A phone is the machine most likely to open a shared link, and it is also the one
     with the least to spend: a mid-range Android is several times slower than this
     desktop, so a 16 ms budget here is a 40 ms frame there. Measure the phone's actual
     zoom, not the desktop one. */
  const phoneWidths = [
    ['phone, on foot', TouchControls.viewWidthFor(390, false)],
    ['phone, driving', TouchControls.viewWidthFor(390, true)],
  ];

  for (const [name, width] of [...phoneWidths, ['on foot', CONFIG.render.viewWidthOnFootM],
    ['driving', CONFIG.render.viewWidthM], ['whole town', 420]]) {
    S.camera.viewWidthM = width;
    S.camera._recomputeScale();
    S.renderer.render(s, 0);                       // warm the paths
    const t0 = performance.now();
    const N = 30;
    for (let i = 0; i < N; i++) S.renderer.render(s, 1000 + i * 16);
    const per = (performance.now() - t0) / N;
    lines.push(`${name.padEnd(10)} ${width} m across: ${per.toFixed(2)} ms/frame ` +
      `(${(1000 / per).toFixed(0)} fps ceiling, ${S.renderer.props.length} props)`);
  }
  /* Where the time actually goes.
   *
   * Wrapping the renderer's own methods is the only honest way to answer it: a guess
   * about "probably the gradients" is how you end up optimising something that costs
   * 4% of the frame. Nested calls are attributed to the outermost wrapped method, so
   * the numbers add up to roughly one frame rather than double-counting. */
  lines.push('');
  lines.push('=== where a frame goes (phone zoom, driving) ===');
  S.camera.viewWidthM = TouchControls.viewWidthFor(390, true);
  S.camera._recomputeScale();
  const R = Object.getPrototypeOf(S.renderer);
  const cost = {};
  let depth = 0;
  const names = Object.getOwnPropertyNames(R).filter((n) =>
    n.startsWith('draw') || n === 'collectProps' || n === 'prism');
  const originals = {};
  for (const n of names) {
    originals[n] = R[n];
    R[n] = function wrapped(...args) {
      if (depth > 0) return originals[n].apply(this, args);
      depth++;
      const t0 = performance.now();
      try { return originals[n].apply(this, args); }
      finally { depth--; cost[n] = (cost[n] || 0) + (performance.now() - t0); }
    };
  }
  const N = 40;
  const tAll0 = performance.now();
  for (let i = 0; i < N; i++) S.renderer.render(s, 2000 + i * 16);
  const tAll = performance.now() - tAll0;
  for (const n of names) R[n] = originals[n];

  /* One level down: how much geometry is actually being issued, and by whom. A method
     that is 76% of a frame is either doing something enormous or doing something small
     an enormous number of times, and the fix is completely different either way. */
  const calls = { fillPoly: 0, prism: 0, gradient: 0, path: 0 };
  const realFill = R.fillPoly, realPrism = R.prism, realPath = R.path;
  R.fillPoly = function (...a) { calls.fillPoly++; return realFill.apply(this, a); };
  R.prism = function (...a) { calls.prism++; return realPrism.apply(this, a); };
  R.path = function (...a) { calls.path++; return realPath.apply(this, a); };
  const ctx2d = S.renderer.ctx;
  const realGrad = ctx2d.createRadialGradient.bind(ctx2d);
  ctx2d.createRadialGradient = function (...a) { calls.gradient++; return realGrad(...a); };
  S.renderer.render(s, 3000);
  R.fillPoly = realFill; R.prism = realPrism; R.path = realPath;
  ctx2d.createRadialGradient = realGrad;
  lines.push(`  per frame: ${calls.fillPoly} filled polygons · ${calls.prism} prisms · ` +
    `${calls.path} paths · ${calls.gradient} gradients built`);

  const rows = Object.entries(cost).map(([n, ms]) => [n, ms / N]).sort((a, b) => b[1] - a[1]);
  const total = tAll / N;
  lines.push(`  whole frame ${total.toFixed(2)} ms`);
  for (const [n, ms] of rows.slice(0, 10)) {
    lines.push(`  ${n.padEnd(20)} ${ms.toFixed(2)} ms  ${(ms / total * 100).toFixed(0).padStart(3)}%`);
  }
  emit();
} catch (err) {
  lines.push(`threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
