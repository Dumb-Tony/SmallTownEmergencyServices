/* Touch — the half of the audience that opens a shared link on a phone.
 *
 * The rule this suite exists to hold: a thumb produces ACTIONS, and nothing downstream
 * can tell the difference between a thumb and a key. If the simulation ever grows a
 * branch for touch input, that is a bug, and these assertions are where it shows up.
 */

import { CONFIG } from '../src/config.js';
import { Input } from '../src/core/input.js';
import { Game, readCommand } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { TouchControls, looksLikeTouch } from '../src/ui/touch.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
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

/* ── A. a thumb is a key ─────────────────────────────────────────────────── */
function sectionA() {
lines.push('--- A. the virtual layer (a thumb and a key are the same thing) ---');
  const input = new Input(window);

  ok('A1 nothing is held to begin with', !input.isDown('use'));
  input.holdVirtual('use');
  ok('A2 a held button reads as held', input.isDown('use'));
  input.endStep();
  ok('A3 and STAYS held across a step, like a finger on a screen', input.isDown('use'));
  input.releaseVirtual('use');
  ok('A4 until it is lifted', !input.isDown('use'));

  input.tapVirtual('interact');
  ok('A5 a tap is an edge', input.wasPressed('interact'));
  ok('A6 and reads as down on the same step', input.isDown('interact'));
  input.endStep();
  ok('A7 the edge is consumed by the step', !input.wasPressed('interact'));
  /* A finger cannot be relied on to send pointerup — it slides off the button, the
     browser steals the gesture, the page scrolls. A tap that never released would be a
     responder walking into a wall forever with nothing to press to stop it. */
  ok('A8 and so is the hold: a tap cannot get stuck down', !input.isDown('interact'));

  input.holdVirtual('use');
  input.clear();
  ok('A9 clear() drops virtual state too', !input.isDown('use'));

  // keys and thumbs coexist
  input._debugPress('KeyE');
  ok('A10 a real key still works with the virtual layer present', input.wasPressed('interact'));
}

/* ── B. the stick is analogue, which no key is ───────────────────────────── */
function sectionB() {
lines.push('--- B. the stick ---');
  const input = new Input(window);
  eq('B1 with no stick, movement comes from the keys', input.moveAxis().x, 0);

  input.setVirtualAxis({ x: 0.5, y: -0.25 });
  near('B2 a half-deflected stick is half speed', input.moveAxis().x, 0.5, 1e-9);
  near('B3 on both axes', input.moveAxis().y, -0.25, 1e-9);
  ok('B4 which a keyboard cannot express', Math.abs(input.moveAxis().x) !== 1);

  /* One pair of thumbs, one responder. The second crew member is a keyboard player
     sitting next to you, and a phone stick must not drive them as well. */
  input._debugPress('ArrowRight');
  eq('B5 the stick does not touch the second responder', input.moveAxis('p2').x, 1);
  near('B6 and the first one is still on the stick', input.moveAxis('').x, 0.5, 1e-9);

  input.setVirtualAxis(null);
  eq('B7 letting go hands movement back to the keys', input.moveAxis().x, 0);
}

/* ── C. the simulation cannot tell ───────────────────────────────────────── */
function sectionC() {
lines.push('--- C. the command the simulation receives is identical ---');
  const input = new Input(window);

  input.holdVirtual('use');
  input.tapVirtual('interact');
  input.tapVirtual('slot3');
  input.setVirtualAxis({ x: -1, y: 0 });
  const cmd = readCommand(input);
  eq('C1 use is held', cmd.use, true);
  eq('C2 interact fired', cmd.interact, true);
  eq('C3 the third slot was chosen', cmd.slot, 2);
  near('C4 and the axis came through', cmd.axis.x, -1, 1e-9);
  eq('C5 driving reads the same actions', readCommand(input).drive.steer, -1);

  // and it actually moves somebody
  clearSave();
  const g = new Game({ seed: 900 });
  g.startShift();
  const p = g.state.player;
  const x0 = p.x;
  const drive = new Input(window);
  drive.setVirtualAxis({ x: 1, y: 0 });
  for (let i = 0; i < 40; i++) g.frame(CONFIG.sim.stepMs, drive);
  ok('C6 a thumb on the stick walks the responder east', p.x > x0 + 0.5, `moved ${(p.x - x0).toFixed(2)} m`);
}

/* ── D. it only appears on a device that wants it ────────────────────────── */
function sectionD() {
lines.push('--- D. when the controls appear, and how big the town looks ---');
  const fakeWin = (coarse, hover) => ({
    matchMedia: (q) => ({ matches: q.includes('coarse') ? coarse : (q.includes('hover') ? hover : false) }),
    navigator: { maxTouchPoints: coarse ? 5 : 0 },
  });
  ok('D1 a phone gets touch controls', looksLikeTouch(fakeWin(true, true)));
  ok('D2 a desktop does not', !looksLikeTouch(fakeWin(false, false)));
  ok('D3 nor does a laptop with a touchscreen and a mouse', !looksLikeTouch(fakeWin(true, false)));

  /* The readability budget. 165 m across a 390 px phone is 2.4 px/m — a person is two
     pixels — so the view has to tighten with the screen rather than just shrink. */
  const R = CONFIG.render;
  eq('D4 a desktop keeps the tuned budget', TouchControls.viewWidthFor(1600, true), R.viewWidthM);
  eq('D5 on foot too', TouchControls.viewWidthFor(1600, false), R.viewWidthOnFootM);
  const phone = TouchControls.viewWidthFor(390, true);
  lt('D6 a phone sees fewer metres, not smaller ones', phone, R.viewWidthM);
  const pxPerM = 390 / phone;
  ok('D7 and gets a usable scale out of it', pxPerM > 6, `${pxPerM.toFixed(1)} px/m`);
  lines.push(`      phone: ${phone.toFixed(0)} m across 390 px = ${pxPerM.toFixed(1)} px/m ` +
    `(desktop: ${(1600 / R.viewWidthM).toFixed(1)} px/m)`);
  ok('D8 there is a floor, so a tiny window does not zoom into somebody\'s boots',
    TouchControls.viewWidthFor(120, true) >= 28 - 0.001);
  lt('D9 on foot a phone is tighter still than driving',
    TouchControls.viewWidthFor(390, false), TouchControls.viewWidthFor(390, true));
}

/* ── E. the controls that get built ──────────────────────────────────────── */
function sectionE() {
lines.push('--- E. the buttons themselves ---');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const input = new Input(window);
  const touch = new TouchControls(root, input).enable();

  ok('E1 a stick is built', !!root.querySelector('#stick'));
  const btns = [...root.querySelectorAll('.tbtn')].map((b) => b.dataset.action);
  ok('E2 the five verbs are reachable without a keyboard',
    btns.includes('interact') && btns.includes('use') && btns.includes('drop') && btns.includes('siren'),
    btns.join(','));

  // pressing a button must produce the action, through the same path a key takes
  const press = (action, type) => {
    const b = root.querySelector(`.tbtn[data-action="${action}"]`);
    b.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1 }));
  };
  press('interact', 'pointerdown');
  ok('E3 tapping E is an interact', input.wasPressed('interact'));
  press('use', 'pointerdown');
  ok('E4 holding USE is held', input.isDown('use'));
  input.endStep();
  ok('E5 and stays held while the thumb is down', input.isDown('use'));
  press('use', 'pointerup');
  ok('E6 until it lifts', !input.isDown('use'));

  touch.setSlots([{ short: 'HOSE' }, { short: 'MED' }]);
  const slots = [...root.querySelector('#tslots').querySelectorAll('.tslot')];
  eq('E7 the equipment row mirrors the HUD list', slots.length, 2);
  eq('E8 with the same short names', slots[0].textContent, 'HOSE');
  slots[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
  ok('E9 and tapping one takes that numbered slot', input.wasPressed('slot2'));

  touch.setSlots([{ short: 'HOSE' }, { short: 'MED' }]);
  eq('E10 an unchanged list is not rebuilt under the thumb',
    root.querySelector('#tslots').querySelectorAll('.tslot').length, 2);

  root.remove();
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
