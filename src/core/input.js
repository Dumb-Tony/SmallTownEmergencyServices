/* Input abstraction — GDD §17, §16.6.
 *
 * Systems ask for ACTIONS ('moveUp', 'grab', 'scan'), never for KeyW. The binding table
 * is data, so remapping later (GDD §16.6) is a data edit and not a code edit.
 *
 * Two query shapes, because gameplay needs both:
 *   isDown(action)     held this frame  — movement, throttle
 *   wasPressed(action) edge this step   — grab, interact, pause
 * wasPressed is cleared by endStep(), which the fixed-step loop calls. That keeps input
 * edges aligned to simulation steps rather than to render frames.
 */

/* GDD implementation rule 6: "Keep controls readable: move, interact, use, select
 * equipment, siren." That is the whole table. Anything that wants a sixth verb has to
 * argue for it against the rule. */
export const DEFAULT_BINDINGS = Object.freeze({
  moveUp:    ['KeyW', 'ArrowUp'],       // throttle in the cab
  moveDown:  ['KeyS', 'ArrowDown'],     // brake, then reverse
  moveLeft:  ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  interact:  ['KeyE'],                  // in/out, grab/release/load a patient
  use:       ['Space'],                 // held: whatever is in your hands
  drop:      ['KeyF'],
  siren:     ['KeyQ'],
  slot1:     ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'],
  slot4:     ['Digit4'], slot5: ['Digit5'],
  calls:     ['Tab'],
  pause:     ['Escape'],
  restart:   ['KeyR'],
  debug:     ['F3'],
});

export class Input {
  constructor(target = window, bindings = DEFAULT_BINDINGS) {
    this.target = target;
    this.setBindings(bindings);

    this._down = new Set();      // codes physically held
    this._pressed = new Set();   // codes that went down since the last endStep()
    this._released = new Set();
    // `seen` stays false until the player actually moves the mouse, so keyboard-only
    // play aims by movement direction instead of at the top-left corner (GDD §16.6).
    this.pointer = { x: 0, y: 0, down: false, seen: false };
    this.pointerWorld = null;      // world-space aim, recomputed each frame by main.js
    this._bound = [];
    /** Fired when the window loses focus. main.js pauses on it — GDD §24.3. */
    this.onBlur = null;
  }

  setBindings(bindings) {
    this.bindings = bindings;
    this._codeToActions = new Map();
    for (const [action, codes] of Object.entries(bindings)) {
      for (const code of codes) {
        if (!this._codeToActions.has(code)) this._codeToActions.set(code, []);
        this._codeToActions.get(code).push(action);
      }
    }
  }

  attach() {
    const add = (t, type, fn) => { t.addEventListener(type, fn); this._bound.push([t, type, fn]); };
    add(this.target, 'keydown', (e) => {
      // Never swallow browser reload/devtools; do swallow the keys we bind, so Space
      // does not scroll the page and F3 does not open Find.
      if (this._codeToActions.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._down.add(e.code);
      this._pressed.add(e.code);
    });
    add(this.target, 'keyup', (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
    });
    // A held key whose keyup lands outside the window would stick forever.
    add(this.target, 'blur', () => { this.clear(); if (this.onBlur) this.onBlur(); });
    return this;
  }

  detach() {
    for (const [t, type, fn] of this._bound) t.removeEventListener(type, fn);
    this._bound.length = 0;
  }

  isDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._down.has(c)) return true;
    return false;
  }

  wasPressed(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  wasReleased(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._released.has(c)) return true;
    return false;
  }

  /** -1..1 on each axis, from the four movement actions. Diagonals are normalised. */
  moveAxis() {
    let x = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
    let y = (this.isDown('moveDown') ? 1 : 0) - (this.isDown('moveUp') ? 1 : 0);
    if (x && y) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
    return { x, y };
  }

  /** Clear the per-step edge sets. Called once per fixed simulation step. */
  endStep() { this._pressed.clear(); this._released.clear(); }

  /** Drop all held state (focus loss, restart). */
  clear() { this._down.clear(); this._pressed.clear(); this._released.clear(); }

  /** Test hook: synthesise input without a real keyboard. */
  _debugPress(code)   { this._down.add(code); this._pressed.add(code); }
  _debugRelease(code) { this._down.delete(code); this._released.add(code); }
}
