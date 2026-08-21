/* Touch controls.
 *
 * The whole point of this game is a link you send to a friend, and half the people you
 * send a link to open it on a phone. Before this they got a town they could look at and
 * not play.
 *
 * It produces ACTIONS through Input's virtual layer — the same `interact`, `use`,
 * `drop`, `siren`, `slotN` names the keyboard produces — so nothing downstream knows or
 * cares. The stick is the one thing a keyboard cannot do: it is analogue, so a phone
 * player can ease a truck around a corner instead of steering in eighths.
 *
 * DOM rather than canvas, deliberately: the browser already knows how to hit-test a
 * div, how to handle two fingers at once, and how to keep a control the right size on a
 * screen whose pixel ratio nobody can predict.
 */

import { CONFIG } from '../config.js';

/** Coarse pointer and no hover — a phone or a tablet, not a laptop with a touchscreen. */
export function looksLikeTouch(win = window) {
  try {
    if (win.matchMedia && win.matchMedia('(any-pointer: coarse)').matches &&
        win.matchMedia('(any-hover: none)').matches) return true;
  } catch (e) { /* older browsers: fall through */ }
  return (win.navigator && win.navigator.maxTouchPoints > 0 && !win.matchMedia)
    || false;
}

const BUTTONS = [
  { action: 'interact', label: 'E',   hint: 'in / out · grab', cls: 'primary', tap: true },
  { action: 'use',      label: 'USE', hint: 'hold',            cls: 'use',     tap: false },
  { action: 'drop',     label: 'F',   hint: 'put down',        cls: '',        tap: true },
  { action: 'siren',    label: 'Q',   hint: 'siren',           cls: '',        tap: true },
  // Hold to see the whole town. A phone shows sixty metres of a four-hundred-metre town,
  // so the overview matters MORE here than on a desktop, not less.
  { action: 'overview', label: 'MAP', hint: 'hold to look',     cls: 'map',     tap: false },
];

export class TouchControls {
  /**
   * @param {HTMLElement} root  the UI overlay
   * @param {Input} input       actions go in here, exactly as keys do
   */
  constructor(root, input) {
    this.root = root;
    this.input = input;
    this.enabled = false;
    this.el = null;
    this.stick = { id: null, cx: 0, cy: 0, x: 0, y: 0 };
    this.radiusPx = 54;
  }

  enable() {
    if (this.enabled) return this;
    this.enabled = true;
    const wrap = document.createElement('div');
    wrap.id = 'touch';
    wrap.innerHTML = `
      <div id="stick"><i></i></div>
      <div id="tbuttons">
        ${BUTTONS.map((b) => `<button class="tbtn ${b.cls}" data-action="${b.action}">` +
          `<b>${b.label}</b><span>${b.hint}</span></button>`).join('')}
      </div>
      <div id="tslots"></div>`;
    this.root.appendChild(wrap);
    this.el = wrap;
    this.slotsEl = wrap.querySelector('#tslots');

    const stick = wrap.querySelector('#stick');
    this.knob = stick.querySelector('i');
    const rect = () => stick.getBoundingClientRect();

    /* The stick tracks ONE pointer id. Without that, a second thumb on a button
       re-centres the stick and the truck swerves every time you press anything. */
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = rect();
      this.stick.id = e.pointerId;
      this.stick.cx = r.left + r.width / 2;
      this.stick.cy = r.top + r.height / 2;
      this.radiusPx = r.width / 2;
      stick.setPointerCapture(e.pointerId);
      this._moveStick(e.clientX, e.clientY);
    });
    stick.addEventListener('pointermove', (e) => {
      if (this.stick.id !== e.pointerId) return;
      e.preventDefault();
      this._moveStick(e.clientX, e.clientY);
    });
    const end = (e) => {
      if (this.stick.id !== e.pointerId) return;
      this.stick.id = null;
      this._moveStick(this.stick.cx, this.stick.cy);
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);

    for (const btn of wrap.querySelectorAll('.tbtn')) {
      const action = btn.dataset.action;
      const def = BUTTONS.find((b) => b.action === action);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('on');
        if (def.tap) this.input.tapVirtual(action);
        else this.input.holdVirtual(action);
      });
      const off = () => {
        btn.classList.remove('on');
        if (!def.tap) this.input.releaseVirtual(action);
      };
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('pointerleave', off);
    }
    return this;
  }

  _moveStick(px, py) {
    const dx = px - this.stick.cx;
    const dy = py - this.stick.cy;
    const len = Math.hypot(dx, dy);
    const dead = this.radiusPx * 0.22;
    if (this.stick.id === null || len < dead) {
      this.stick.x = 0; this.stick.y = 0;
      this.input.setVirtualAxis(null);
      if (this.knob) this.knob.style.transform = 'translate(0px,0px)';
      return;
    }
    // clamp to the ring, then normalise: full deflection is full speed, and a light
    // touch is a light touch, which is the whole reason a stick beats four buttons
    const k = Math.min(1, (len - dead) / (this.radiusPx - dead));
    const ux = dx / len, uy = dy / len;
    this.stick.x = ux * k; this.stick.y = uy * k;
    this.input.setVirtualAxis({ x: this.stick.x, y: this.stick.y });
    if (this.knob) {
      const px2 = ux * Math.min(len, this.radiusPx), py2 = uy * Math.min(len, this.radiusPx);
      this.knob.style.transform = `translate(${px2.toFixed(1)}px,${py2.toFixed(1)}px)`;
    }
  }

  /**
   * Redraw the equipment row. It mirrors the HUD's numbered slots, because the phone
   * player has no number keys and "take kit from the truck" is one of the five verbs.
   */
  setSlots(slots) {
    if (!this.enabled || !this.slotsEl) return;
    const key = slots.map((s) => s.short).join('|');
    if (key === this._slotKey) return;      // the DOM is not rebuilt sixty times a second
    this._slotKey = key;
    this.slotsEl.innerHTML = slots.slice(0, 5)
      .map((s, i) => `<button class="tslot" data-slot="${i + 1}">${s.short}</button>`).join('');
    for (const b of this.slotsEl.querySelectorAll('.tslot')) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.input.tapVirtual(`slot${b.dataset.slot}`);
        b.classList.add('on');
        setTimeout(() => b.classList.remove('on'), 120);
      });
    }
  }

  /** Metres across the screen for a hand-held device: the readability budget is the
   *  same idea as CONFIG.render.viewWidthM, just for a screen a fifth of the size. */
  static viewWidthFor(cssW, driving) {
    const R = CONFIG.render;
    const desktop = driving ? R.viewWidthM : R.viewWidthOnFootM;
    if (cssW >= 700) return desktop;
    /* Below that, hold a PIXELS-PER-METRE target instead of a metres target. 165 m
       across a 390 px phone is 2.4 px/m: a person is two pixels and a hydrant is one.
       Scaling the metres budget by the screen width was still only 4.2 px/m — the fix
       is to say what a metre has to be worth and let the metres fall out of it. */
    const target = driving ? R.phonePxPerM : R.phonePxPerMOnFoot;
    return Math.min(desktop, Math.max(28, cssW / target));
  }
}
