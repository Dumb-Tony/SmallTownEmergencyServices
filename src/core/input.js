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
  moveUp:    ['KeyW'],                  // throttle in the cab
  moveDown:  ['KeyS'],                  // brake, then reverse
  moveLeft:  ['KeyA'],
  moveRight: ['KeyD'],
  interact:  ['KeyE'],                  // in/out, grab/release/load a patient
  use:       ['Space'],                 // held: whatever is in your hands
  drop:      ['KeyF'],
  siren:     ['KeyQ'],
  slot1:     ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'],
  slot4:     ['Digit4'], slot5: ['Digit5'],

  /* The second responder, on the same keyboard. The arrows are NOT also bound to the
   * first responder: shared keys would drive both crew members at once the moment a
   * partner joined, and a control that does something different depending on who else
   * is on shift is worse than no control. Slots take the numpad or the top-row 6-0, so
   * a laptop without a numeric keypad can still play. */
  p2MoveUp:    ['ArrowUp'],
  p2MoveDown:  ['ArrowDown'],
  p2MoveLeft:  ['ArrowLeft'],
  p2MoveRight: ['ArrowRight'],
  p2Interact:  ['ShiftRight'],
  p2Use:       ['Slash'],
  p2Drop:      ['Period'],
  p2Siren:     ['Comma'],
  p2Slot1: ['Numpad1', 'Digit6'], p2Slot2: ['Numpad2', 'Digit7'],
  p2Slot3: ['Numpad3', 'Digit8'], p2Slot4: ['Numpad4', 'Digit9'],
  p2Slot5: ['Numpad5', 'Digit0'],

  /* Hold to see the whole town. Triage is the game's central verb and the GDD asks a
     player to be able to answer "what am I not doing right now" — which was impossible
     while the camera only ever showed one street. It pauses nothing. */
  overview:  ['KeyV'],

  calls:     ['Tab'],
  pause:     ['Escape'],
  restart:   ['KeyR'],
  coop:      ['KeyP'],
  mute:      ['KeyM'],
  debug:     ['F3'],
});

export class Input {
  constructor(target = window, bindings = DEFAULT_BINDINGS) {
    this.target = target;
    this.setBindings(bindings);

    this._down = new Set();      // codes physically held
    this._vDown = new Set();     // ACTIONS held by a thumb (see the virtual layer)
    this._vPressed = new Set();
    this._vTapped = new Set();
    this._vAxis = null;
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
    /* The mouse. `pointer` and `pointerWorld` were declared from the start and never
       filled in by anything, so aiming with the mouse — which the controls list has
       always advertised — silently did nothing and every stream came out of the
       keyboard facing. `seen` stays false until the mouse actually moves, so a
       keyboard-only player is never dragged around by a cursor parked in a corner. */
    add(this.target, 'pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.seen = true;
    });
    add(this.target, 'pointerdown', (e) => {
      this.pointer.x = e.clientX; this.pointer.y = e.clientY;
      this.pointer.seen = true; this.pointer.down = true;
    });
    add(this.target, 'pointerup', () => { this.pointer.down = false; });

    // A held key whose keyup lands outside the window would stick forever.
    add(this.target, 'blur', () => { this.clear(); if (this.onBlur) this.onBlur(); });
    return this;
  }

  detach() {
    for (const [t, type, fn] of this._bound) t.removeEventListener(type, fn);
    this._bound.length = 0;
  }

  /* ── the virtual layer ──────────────────────────────────────────────────────
   * A thumb on a screen produces ACTIONS, exactly as a key does, so touch controls
   * plug in here rather than anywhere near the simulation. Nothing downstream — not
   * game.js, not the bot, not the netcode — can tell the difference, which is the whole
   * reason the input layer speaks in actions instead of key codes (GDD §16.6).
   */
  holdVirtual(action) { this._vDown.add(action); }
  releaseVirtual(action) { this._vDown.delete(action); }
  tapVirtual(action) { this._vPressed.add(action); this._vDown.add(action); this._vTapped.add(action); }
  /** An analogue stick, which a keyboard cannot give you. null hands movement back. */
  setVirtualAxis(axis) { this._vAxis = axis; }

  isDown(action) {
    if (this._vDown.has(action)) return true;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._down.has(c)) return true;
    return false;
  }

  wasPressed(action) {
    if (this._vPressed.has(action)) return true;
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

  /**
   * -1..1 on each axis, from the four movement actions. Diagonals are normalised.
   * @param {string} prefix  '' for the first responder, 'p2' for the second
   */
  moveAxis(prefix = '') {
    // A stick is analogue and already normalised; it belongs to the first responder,
    // because there is one pair of thumbs on a phone.
    if (!prefix && this._vAxis) return { x: this._vAxis.x, y: this._vAxis.y };
    const a = (n) => (prefix ? prefix + n[0].toUpperCase() + n.slice(1) : n);
    let x = (this.isDown(a('moveRight')) ? 1 : 0) - (this.isDown(a('moveLeft')) ? 1 : 0);
    let y = (this.isDown(a('moveDown')) ? 1 : 0) - (this.isDown(a('moveUp')) ? 1 : 0);
    if (x && y) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
    return { x, y };
  }

  /**
   * Clear the per-step edge sets. Called once per fixed simulation step.
   *
   * A TAP releases on the step that consumed it. A finger cannot be trusted to produce
   * a pointerup for every pointerdown — it leaves the element, the browser steals the
   * gesture, the page scrolls — and a stuck virtual key is a responder walking into a
   * wall forever with nothing the player can press to stop it.
   */
  endStep() {
    this._pressed.clear();
    this._released.clear();
    this._vPressed.clear();
    for (const a of this._vTapped) this._vDown.delete(a);
    this._vTapped.clear();
  }

  /** Drop all held state (focus loss, restart). */
  clear() {
    this._down.clear(); this._pressed.clear(); this._released.clear();
    this._vDown.clear(); this._vPressed.clear(); this._vTapped.clear();
    this._vAxis = null;
  }

  /** Test hook: synthesise input without a real keyboard. */
  _debugPress(code)   { this._down.add(code); this._pressed.add(code); }
  _debugRelease(code) { this._down.delete(code); this._released.add(code); }
}
