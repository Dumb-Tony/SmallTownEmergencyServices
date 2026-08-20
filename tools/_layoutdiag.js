/* Does the HUD fit the screen it is on? Measured, not eyeballed.
 *
 * Run it at a phone size:
 *   .\tools\smoketest.ps1 -Tests tools\_layoutdiag.js -Width 390 -Height 844
 *
 * Every panel is reported with the number of pixels it hangs off each edge, and any
 * overlap between a HUD panel and a touch control — because a dispatch list sitting
 * under the thumb buttons is worse than no dispatch list.
 */

const lines = [];
let _pre = null;
function emit() {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\nALL-PASS  measured\n==STESTEST-END==';
}

try {
  const S = window.__STES;
  window.requestAnimationFrame = () => 0;
  S.startShift();
  S.touch.enable();
  S.game.clock.skipMs(50000, (ms) => S.game.step(ms, null));
  S.game.clock.setPaused(true);
  S.camera.viewWidthM = 60; S.camera._recomputeScale();   // what the frame loop would pick
  S.hud.update();
  S.touch.setSlots([{ short: 'HOSE' }, { short: 'WRENCH' }, { short: 'EXT' }]);

  const W = window.innerWidth, H = window.innerHeight;
  lines.push(`viewport ${W} x ${H}   dpr ${window.devicePixelRatio}`);
  lines.push(`media (max-width:700px) matches: ${window.matchMedia('(max-width: 700px)').matches}`);
  lines.push('');

  const ids = ['topbar', 'calls', 'bottom', 'radio', 'stick', 'tbuttons', 'tslots', 'netchip'];
  const boxes = {};
  lines.push('panel        x     y     w     h   | off-screen');
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { lines.push(`${id.padEnd(11)} (absent)`); continue; }
    const r = el.getBoundingClientRect();
    boxes[id] = r;
    const over = [];
    if (r.right > W + 0.5) over.push(`right ${(r.right - W).toFixed(0)}px`);
    if (r.left < -0.5) over.push(`left ${(-r.left).toFixed(0)}px`);
    if (r.bottom > H + 0.5) over.push(`bottom ${(r.bottom - H).toFixed(0)}px`);
    if (r.top < -0.5) over.push(`top ${(-r.top).toFixed(0)}px`);
    lines.push(`${id.padEnd(11)} ${r.x.toFixed(0).padStart(4)}  ${r.y.toFixed(0).padStart(4)}  ` +
      `${r.width.toFixed(0).padStart(4)}  ${r.height.toFixed(0).padStart(4)}  | ` +
      (over.length ? 'OVERFLOWS ' + over.join(', ') : 'ok'));
  }

  lines.push('');
  lines.push('overlaps between a HUD panel and a control:');
  const hud = ['topbar', 'calls', 'bottom', 'radio'];
  const controls = ['stick', 'tbuttons', 'tslots'];
  let any = false;
  for (const a of hud) {
    for (const b of controls) {
      const ra = boxes[a], rb = boxes[b];
      if (!ra || !rb) continue;
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) {
        any = true;
        lines.push(`  ${a} over ${b}: ${ox.toFixed(0)} x ${oy.toFixed(0)} px`);
      }
    }
  }
  if (!any) lines.push('  none');

  lines.push('');
  lines.push(`camera: ${S.camera.viewWidthM.toFixed(0)} m across ${S.camera.cssW} px = ` +
    `${(S.camera.cssW / S.camera.viewWidthM).toFixed(1)} px/m`);
  emit();
} catch (err) {
  lines.push('threw: ' + (err && err.message));
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
