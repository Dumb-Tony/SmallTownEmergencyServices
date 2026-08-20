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

  for (const [name, width] of [['on foot', CONFIG.render.viewWidthOnFootM],
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
  emit();
} catch (err) {
  lines.push(`threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
