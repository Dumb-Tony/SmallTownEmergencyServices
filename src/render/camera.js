/* Three-quarter camera — GDD §19.3.
 *
 * The town is simulated flat: every position in the game is (x, y) in metres on one
 * plane, and collision, reach and aim all work in those metres. NOTHING here changes
 * that. What changes is the projection:
 *
 *   - `tilt` squashes the vertical axis, so the ground plane recedes instead of lying
 *     square to the screen. 1.0 is looking straight down; this game looks down at about
 *     0.62, which is a shallow enough angle to still read a street layout;
 *   - `top(x, y, h)` returns where a point h METRES ABOVE the ground lands, so anything
 *     with height can be extruded — walls, trees, trucks, people;
 *   - `lean` fakes the perspective a real lens gives: verticals away from the centre of
 *     the frame lean outwards, which is what makes a box look like a building rather
 *     than a rectangle with a stripe on it.
 *
 * The whole projection is these three numbers, and it inverts exactly, so screenToWorld
 * still hands the simulation honest metres for mouse aim.
 *
 * Pure maths + a canvas transform. No game rules here (GDD §31.3).
 */

export class Camera {
  constructor({ worldW, worldH, paddingM = 0, maxPixelRatio = 2,
                viewWidthM = 62, followLerp = 7,
                tilt = 0.62, heightK = 0.9, leanK = 0.006 }) {
    this.tilt = tilt;
    this.heightK = heightK;
    this.leanK = leanK;
    this.worldW = worldW;
    this.worldH = worldH;
    this.paddingM = paddingM;
    this.maxPixelRatio = maxPixelRatio;
    this.viewWidthM = viewWidthM;
    this.followLerp = followLerp;

    this.cssW = 1; this.cssH = 1;   // CSS pixels
    this.dpr = 1;
    this.scale = 1;                 // screen pixels per metre
    this.centre = { x: worldW / 2, y: worldH / 2 };
    this.mode = 'follow';           // 'follow' | 'fit'
  }

  setMode(mode) {
    this.mode = mode;
    this._recomputeScale();
    if (mode === 'fit') this.centre = { x: this.worldW / 2, y: this.worldH / 2 };
    return mode;
  }

  /**
   * Ease the view toward a target and keep it inside the world.
   *
   * Clamping to the world edges matters more than it sounds: without it, standing in
   * the sort room shows a screen half full of void, and the player reads that emptiness
   * as "there is nothing over there" rather than "the airport ends here".
   * @param {number} dtSec  use 0 to snap instantly (restart, teleport)
   */
  follow(x, y, dtSec) {
    const vis = this.visibleM;
    const k = dtSec > 0 ? 1 - Math.exp(-this.followLerp * dtSec) : 1;
    this.centre.x += (x - this.centre.x) * k;
    this.centre.y += (y - this.centre.y) * k;

    const halfW = vis.w / 2, halfH = vis.h / 2;
    this.centre.x = vis.w >= this.worldW ? this.worldW / 2
      : Math.min(this.worldW - halfW, Math.max(halfW, this.centre.x));
    this.centre.y = vis.h >= this.worldH ? this.worldH / 2
      : Math.min(this.worldH - halfH, Math.max(halfH, this.centre.y));
  }

  /** Size the backing store to the element, DPR-aware but capped. @returns {boolean} changed */
  resize(canvas) {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width  || canvas.clientWidth  || 1));
    const cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);

    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width === w && canvas.height === h && this.cssW === cssW && this.cssH === cssH) {
      return false;
    }
    canvas.width = w; canvas.height = h;
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this._recomputeScale();
    return true;
  }

  _recomputeScale() {
    if (this.mode === 'fit') {
      const w = this.worldW + this.paddingM * 2;
      const h = this.worldH + this.paddingM * 2;
      this.scale = Math.min(this.cssW / w, this.cssH / h);
    } else {
      // Zoom is set by how many metres must fit across the window — a readability
      // budget, not a taste one. See CONFIG.render.viewWidthM.
      this.scale = this.cssW / this.viewWidthM;
    }
  }

  /** The scale a 'fit' camera would use, without switching mode. */
  fitScale() {
    return Math.min(this.cssW / (this.worldW + this.paddingM * 2),
                    this.cssH / (this.worldH + this.paddingM * 2));
  }

  /** Screen-pixel size of the drawable world area, for letterbox bars. */
  get viewport() {
    return { w: this.cssW, h: this.cssH };
  }

  /**
   * Apply world->screen to a 2D context. Everything drawn after this is in METRES.
   *
   * The y scale is deliberately NOT the x scale: that single asymmetry is the whole
   * three-quarter view. A consequence worth knowing before you chase it as a bug —
   * a circle drawn in world units comes out as an ellipse, and a stroke is thinner
   * vertically than horizontally. Both are correct here.
   */
  applyTo(ctx) {
    const s = this.scale * this.dpr;
    const sy = s * this.tilt;
    const ox = (this.cssW * this.dpr) / 2 - this.centre.x * s;
    const oy = (this.cssH * this.dpr) / 2 - this.centre.y * sy;
    ctx.setTransform(s, 0, 0, sy, ox, oy);
    return s;
  }

  /**
   * Where a point `h` metres above the ground lands, in the same world units everything
   * else is drawn in — so a wall is a quad from the footprint to top() of the footprint,
   * and no drawing code has to know how the projection works.
   */
  top(x, y, h) {
    return {
      x: x + (x - this.centre.x) * h * this.leanK,
      y: y - (h * this.heightK) / this.tilt,
    };
  }

  /** Screen-space rise of one metre of height, for anything sized in pixels. */
  riseFor(h) { return h * this.heightK * this.scale; }

  /** Reset to raw device pixels — for HUD drawn on the canvas, and for clearing. */
  resetTransform(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

  worldToScreen(x, y) {
    const s = this.scale;
    return {
      x: this.cssW / 2 + (x - this.centre.x) * s,
      y: this.cssH / 2 + (y - this.centre.y) * s * this.tilt,
    };
  }

  screenToWorld(sx, sy) {
    const s = this.scale;
    return {
      x: this.centre.x + (sx - this.cssW / 2) / s,
      y: this.centre.y + (sy - this.cssH / 2) / (s * this.tilt),
    };
  }

  /**
   * The visible world rectangle, in metres. `x`/`y` are its top-left corner.
   *
   * They were missing until now, and drawGround read them anyway: `Math.floor(undefined
   * / step)` is NaN, `for (let x = NaN; x < NaN; ...)` runs zero times, and the ground
   * detail it draws has therefore never appeared on screen once. Verify with numbers.
   */
  get visibleM() {
    const w = this.cssW / this.scale;
    const h = this.cssH / (this.scale * this.tilt);
    return { w, h, x: this.centre.x - w / 2, y: this.centre.y - h / 2 };
  }
}
