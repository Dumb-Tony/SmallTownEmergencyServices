/* Accessibility: colour, motion and text size — COMPUTED, never guessed.
 *
 * This module owns no state, touches no DOM and draws nothing. Every function here is
 * pure, so the claims it makes about the game ("that pair collapses for a deuteranope",
 * "that text is 3.1:1") are assertions a test can fail rather than opinions in a README.
 *
 * Every colour literal below is COPIED from the file named in the comment beside it.
 * tools/m10-tests.js re-reads styles.css, src/render/renderer.js, src/game.js and
 * src/data/equipment.js over http and asserts that each literal is still in the file it
 * claims to come from — so this table cannot quietly drift out of date, and an audit run
 * against invented colours fails instead of lying.
 */

/* ── colour: parsing and compositing ──────────────────────────────────────── */

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` into {r,g,b} 0-255 and a 0-1. */
export function parseColour(str) {
  if (str && typeof str === 'object' && typeof str.r === 'number') {
    return { r: str.r, g: str.g, b: str.b, a: str.a == null ? 1 : str.a };
  }
  const s = String(str).trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) {
      const n = parseInt(h, 16);
      if (!Number.isFinite(n)) throw new Error(`bad colour ${s}`);
      const r = (n >> 8) & 15, g = (n >> 4) & 15, b = n & 15;
      return { r: r * 17, g: g * 17, b: b * 17, a: 1 };
    }
    if (h.length === 6) {
      // parseInt is too forgiving to trust: 'gb(20,4' parses as NaN and NaN>>16&255 is
      // 0, which is how src/render/renderer.js:86 once painted whole surfaces black.
      if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad colour ${s}`);
      const n = parseInt(h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    throw new Error(`bad colour ${s}`);
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m) throw new Error(`bad colour ${s}`);
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const hex2 = (v) => Math.round(clamp255(v)).toString(16).padStart(2, '0');

/** `#rrggbb`. Alpha is dropped — flatten it with composite() first if it matters. */
export function toHex(c) {
  const p = parseColour(c);
  return `#${hex2(p.r)}${hex2(p.g)}${hex2(p.b)}`;
}

/** Source-over, in sRGB space, which is what a browser does for a translucent panel. */
export function composite(fg, bg) {
  const f = parseColour(fg), b = parseColour(bg);
  const a = f.a;
  return { r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a), a: 1 };
}

/** Flatten a stack of layers, back to front: flatten([backdrop, panel, chip]). */
export function flatten(layers) {
  let out = parseColour(layers[0]);
  for (let i = 1; i < layers.length; i++) out = composite(layers[i], out);
  return out;
}

/* ── colour: WCAG contrast ────────────────────────────────────────────────── */

/** WCAG 2.x sRGB channel linearisation. Not a plain 2.2 gamma — the toe matters. */
export function srgbToLinear(v01) {
  return v01 <= 0.03928 ? v01 / 12.92 : Math.pow((v01 + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(colour) {
  const c = parseColour(colour);
  const r = srgbToLinear(c.r / 255), g = srgbToLinear(c.g / 255), b = srgbToLinear(c.b / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** (L1+0.05)/(L2+0.05), lighter over darker. Black on white is exactly 21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG "large text": 24px, or 18.66px when bold. Everything in this HUD is smaller. */
export function isLargeText(px, bold) {
  return px >= 24 || (!!bold && px >= 18.66);
}

/** The AA floor for a given size: 3.0 for large text, 4.5 for everything else. */
export function requiredRatio(px, bold) { return isLargeText(px, bold) ? 3 : 4.5; }

/* ── colour: CIELAB and CIEDE2000 ─────────────────────────────────────────── */

const D65 = { X: 0.95047, Y: 1, Z: 1.08883 };

export function toXyz(colour) {
  const c = parseColour(colour);
  const r = srgbToLinear(c.r / 255), g = srgbToLinear(c.g / 255), b = srgbToLinear(c.b / 255);
  return {
    X: 0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    Y: 0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    Z: 0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  };
}

export function toLab(colour) {
  const xyz = toXyz(colour);
  const e = 216 / 24389, k = 24389 / 27;
  const f = (t) => (t > e ? Math.cbrt(t) : (k * t + 16) / 116);
  const fx = f(xyz.X / D65.X), fy = f(xyz.Y / D65.Y), fz = f(xyz.Z / D65.Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * CIEDE2000, the standard perceptual distance. Worth the forty lines: CIE76 rates the
 * blue end of the gamut as far more different than an eye does, and this game signals
 * with a purple ring against a red one.
 */
export function deltaE00(lab1, lab2) {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (ap, bp) => {
    if (ap === 0 && bp === 0) return 0;
    const h = deg(Math.atan2(bp, ap));
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(a1p, b1), h2p = hue(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else {
    const d = Math.abs(h1p - h2p), s = h1p + h2p;
    if (d <= 180) hbarp = s / 2;
    else if (s < 360) hbarp = (s + 360) / 2;
    else hbarp = (s - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbarp - 30)) + 0.24 * Math.cos(rad(2 * hbarp))
    + 0.32 * Math.cos(rad(3 * hbarp + 6)) - 0.20 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;

  const tL = dLp / Sl, tC = dCp / Sc, tH = dHp / Sh;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
}

/** Perceptual distance between two colours. 2.3 is a just-noticeable difference. */
export function deltaE(a, b) { return deltaE00(toLab(a), toLab(b)); }

/* ── colour: simulating the three common colour-vision deficiencies ───────── */

/* Smith-Pokorny cone fundamentals and the dichromat projections onto the surviving
 * two-cone plane (Viénot, Brettel & Mollon 1999). Applied in LINEAR light, not to the
 * gamma-encoded bytes, because the cone response is to light and not to a byte; the
 * grey axis is a fixed point of all three projections either way, which is the first
 * thing tools/m10-tests.js checks.
 *
 * Out-of-gamut results are clamped, which is standard and slightly understates how far
 * apart two colours look — so this simulation is conservative about failure, never
 * generous. */
const RGB_TO_LMS = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
];
const LMS_TO_RGB = [
  [0.080944, -0.130504, 0.116721],
  [-0.0102485, 0.0540194, -0.113615],
  [-0.000365294, -0.00412163, 0.693513],
];

export const CVD_KINDS = Object.freeze(['protanopia', 'deuteranopia', 'tritanopia']);

/** L, M, S -> the same three, with one cone's response reconstructed from the others. */
function project(kind, L, M, S) {
  if (kind === 'protanopia') return [2.02344 * M - 2.52581 * S, M, S];
  if (kind === 'deuteranopia') return [L, 0.494207 * L + 1.24827 * S, S];
  if (kind === 'tritanopia') return [L, M, -0.395913 * L + 0.801109 * M];
  throw new Error(`unknown CVD ${kind}`);
}

/** What `colour` looks like to a dichromat, as `#rrggbb`. */
export function simulateCvd(colour, kind) {
  const c = parseColour(colour);
  const lin = [srgbToLinear(c.r / 255), srgbToLinear(c.g / 255), srgbToLinear(c.b / 255)];
  const L = RGB_TO_LMS[0][0] * lin[0] + RGB_TO_LMS[0][1] * lin[1] + RGB_TO_LMS[0][2] * lin[2];
  const M = RGB_TO_LMS[1][0] * lin[0] + RGB_TO_LMS[1][1] * lin[1] + RGB_TO_LMS[1][2] * lin[2];
  const S = RGB_TO_LMS[2][0] * lin[0] + RGB_TO_LMS[2][1] * lin[1] + RGB_TO_LMS[2][2] * lin[2];
  const [L2, M2, S2] = project(kind, L, M, S);
  const out = [0, 1, 2].map((i) => {
    const v = LMS_TO_RGB[i][0] * L2 + LMS_TO_RGB[i][1] * M2 + LMS_TO_RGB[i][2] * S2;
    const lv = v < 0 ? 0 : v > 1 ? 1 : v;
    const enc = lv <= 0.0031308 ? lv * 12.92 : 1.055 * Math.pow(lv, 1 / 2.4) - 0.055;
    return enc * 255;
  });
  return `#${hex2(out[0])}${hex2(out[1])}${hex2(out[2])}`;
}

/** The colour as it is, and as each of the three deficiencies sees it. */
export function cvdReport(colour) {
  const out = { normal: toHex(colour) };
  for (const k of CVD_KINDS) out[k] = simulateCvd(colour, k);
  return out;
}

/* Thresholds, chosen by measurement rather than by taste — see tools/m10-tests.js §D,
 * which asserts the calibration below still holds:
 *   2.3   a just-noticeable difference between two large adjacent patches (CIE);
 *   11    the floor this audit uses for a SIGNAL: small marks, never side by side,
 *         read in a hurry. Anchored on the pair nobody has ever confused — the first two
 *         crew tints #f6c445 and #5fd0f0 measure dE00 46.7 normal and 48.1 at their worst
 *         simulation — and on the pair that is plainly wrong: routine vs high priority
 *         (#ffe082 vs #ffa726) measures 5.5. 11 sits between them with room either side.
 *
 *         That anchor is a CEILING, not a norm, and the crew growing from two to four is
 *         what made the difference matter: one pair can be 46 apart, six pairs of four
 *         tints cannot. The four that ship measure 16.5 at their worst (§D27), and the
 *         four that were reached for by eye measured 4.8.
 *   3:1   WCAG 1.4.11 non-text contrast. A pair whose hues collapse is still separable
 *         if one is this much lighter than the other, which is the whole reason the
 *         proposals below move lightness and not just hue.
 *
 * The measurement's own surprise: for this game's amber-to-red family the binding
 * deficiency is TRITANOPIA, not the red-green pair everyone reaches for. Routine/high
 * scores 11.0 for a deuteranope and 5.5 for a tritanope; high/critical 13.2 and 5.8.
 * Amber, orange and red are separated almost entirely along b* — the yellow-blue axis —
 * and that is the axis tritanopia takes. An eyeballed "does it work in greyscale?" check
 * would have passed all three. */
export const JND_DELTA_E = 2.3;
export const SIGNAL_DELTA_E = 11;
export const LUM_ESCAPE_RATIO = 3;
export const LUM_PARTIAL_RATIO = 1.5;

/**
 * Can these two still be told apart? Reports the perceptual distance as it is and under
 * each deficiency, plus the luminance ratio between them — because a pair that loses its
 * hue can still be carried by lightness, and saying otherwise would be scaremongering.
 */
export function distinguishable(a, b, opts = {}) {
  const min = opts.minDeltaE == null ? SIGNAL_DELTA_E : opts.minDeltaE;
  const normal = deltaE(a, b);
  const cvd = {};
  for (const k of CVD_KINDS) cvd[k] = deltaE(simulateCvd(a, k), simulateCvd(b, k));
  const worstKind = CVD_KINDS.reduce((w, k) => (cvd[k] < cvd[w] ? k : w), CVD_KINDS[0]);
  const worst = cvd[worstKind];
  const ratio = contrastRatio(a, b);
  const verdict = worst >= min ? 'ok'
    : ratio >= LUM_ESCAPE_RATIO ? 'ok-by-lightness'
      : ratio >= LUM_PARTIAL_RATIO ? 'weak'
        : 'collapses';
  return { a: toHex(a), b: toHex(b), normal, ...cvd, worst, worstKind, ratio, verdict, ok: verdict.startsWith('ok') };
}

/* ── the colours this game actually uses ──────────────────────────────────── */

/** styles.css:6-17, the :root token block, verbatim. */
export const CSS_TOKENS = Object.freeze({
  panel: '#171522', panel2: '#1e1b2c', line: '#332f47', paper: '#f2ead9', dim: '#9d97b5',
  lime: '#a8d93a', violet: '#8a7ff0', coral: '#ff5a5a', amber: '#ffab3d',
  good: '#7fd17f', warn: '#e8c04a', bad: '#f0928a',
  page: '#10121a',                       // styles.css:26  html,body background
});

/**
 * A `src` says where a value lives. Two forms, both accepted:
 *
 *   'styles.css:90-92'          a line span — precise, and it rots the moment anybody
 *                               edits above it;
 *   'renderer.js drawVictim'    an ANCHOR: a function name or a CSS selector.
 *
 * Prefer the anchor. This repo is edited by several people at once and renderer.js has
 * already moved by a hundred lines since this table was first written, which turned
 * every line number in it into a lie while every anchor stayed true.
 */
export function parseSrc(src) {
  const m = String(src).trim().match(/^([\w.-]+\.(?:js|css))\s*(?::\s*([\d,\s-]+)|\s+(.+))?$/);
  if (!m) return { file: null, lines: null, anchor: null };
  return { file: m[1], lines: (m[2] || '').trim() || null, anchor: (m[3] || '').trim() || null };
}

/** Which :root token holds each palette hex, so a rule saying `var(--good)` can be
 *  recognised as carrying #7fd17f. styles.css :root. */
export const CSS_VAR_NAMES = Object.freeze({
  '#171522': '--panel', '#1e1b2c': '--panel-2', '#332f47': '--line', '#f2ead9': '--paper',
  '#9d97b5': '--dim', '#a8d93a': '--lime', '#8a7ff0': '--violet', '#ff5a5a': '--coral',
  '#ffab3d': '--amber', '#7fd17f': '--good', '#e8c04a': '--warn', '#f0928a': '--bad',
});

/** The translucent plates the HUD paints on. */
export const PLATES = Object.freeze({
  pill: 'rgba(23,21,34,0.94)',           // styles.css  .pill
  calls: 'rgba(23,21,34,0.88)',          // styles.css  #calls
  prompt: 'rgba(23,21,34,0.94)',         // styles.css  #prompt, #slots
  radio: 'rgba(14,13,22,0.82)',          // styles.css  #radio .line
  overlayScrim: 'rgba(8,9,14,0.72)',     // styles.css  #overlay
  debug: 'rgba(6,8,12,0.86)',            // styles.css  #debug
  coach: 'rgba(28,40,30,0.9)',           // styles.css  #coach
  tslot: 'rgba(12,20,28,0.75)',          // styles.css  .tslot   0.6 -> 0.75
  tbtn: 'rgba(12,20,28,0.75)',           // styles.css  .tbtn    0.55 -> 0.75
  kbd: '#0e0d16',                        // styles.css  kbd
});

/**
 * What is BEHIND a translucent HUD plate: the town itself. A panel at 86% opacity is
 * not opaque, so its contrast depends on what the camera happens to be over. These are
 * the real ground and roof colours from src/render/renderer.js:36-58; the audit takes
 * the WORST of them, because "it is fine over the road" is not an accessibility claim.
 */
export const CANVAS_BACKDROPS = Object.freeze({
  page: '#10121a',        // styles.css:26   — the letterboxed page, and the overlay scrim
  road: '#4b5058',        // renderer.js:37
  grass: '#688f4e',       // renderer.js:36
  field: '#7ea55d',       // renderer.js:38
  lot: '#6d6f76',         // renderer.js:38
  pond: '#4a7fa1',        // renderer.js:38
  kerb: '#8d8f92',        // renderer.js:37
  roofClinic: '#eef2f5',  // renderer.js:58  — the brightest surface in the town
  roofCivic: '#e6e2d6',   // renderer.js:57
});

const BRIGHT_BACKDROPS = ['page', 'road', 'grass', 'field', 'lot', 'pond', 'kerb', 'roofClinic', 'roofCivic'];

/**
 * Every text/background pair the HUD actually renders.
 *
 * `bg` is a stack, back to front, so a chip is measured through its own tint AND the
 * panel AND whatever the town is doing underneath. `over` names which backdrops a
 * translucent stack has to survive; the audit reports the worst one.
 */
export const TEXT_PAIRS = Object.freeze([
  // top bar
  { id: 'pill', where: 'top-bar pill text', src: 'styles.css .pill', fg: CSS_TOKENS.paper, px: 13, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  // The weather pill on a night that is not clear. Amber on the pill plate, and the one
  // pill in the bar whose whole job is to be noticed the moment it is not the default.
  { id: 'pill-warn', where: 'weather, when it matters', src: 'styles.css .pill.warn', fg: CSS_TOKENS.warn, px: 13, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'clock-urgent', where: 'clock, last minute', src: 'styles.css #clock.urgent', fg: CSS_TOKENS.coral, px: 16, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'conf-label', where: '"TOWN" label', src: 'styles.css #confidence .label', fg: CSS_TOKENS.dim, px: 11, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'conf-word', where: 'confidence word', src: 'styles.css #confidence .word', fg: CSS_TOKENS.dim, px: 12, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'mute-on', where: 'SOUND pill', src: 'styles.css .pill.mute', fg: CSS_TOKENS.lime, px: 11, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'mute-off', where: 'MUTED pill', src: 'styles.css .pill.mute.off', fg: CSS_TOKENS.dim, px: 11, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'netchip-live', where: 'connected chip', src: 'styles.css #netchip.live', fg: '#8ff0b0', px: 13, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'netchip-warn', where: 'partner-left chip', src: 'styles.css #netchip.warn', fg: '#ffc9a8', px: 13, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },

  /* The crew name, painted in that crew member's own tint — `.who` in hud.js statusFor.
   *
   * This is the only place in the game where a SIGNAL colour is also TEXT, and it is
   * therefore the floor under how dark a crew tint is allowed to be. 11px bold is below
   * WCAG's 18.66px "large" line, so it needs the full 4.5:1 on the pill plate over the
   * palest roof in the town, and that works out at L* 57. Every extra point of separation
   * between four tints wants to come out of lightness, and this is the rule that says how
   * much lightness there is to spend — which is why #a474fc and #bc7ca4 stop at L* 59 and
   * 60 (4.81:1 and 4.87:1) instead of going darker for an easier §D27. */
  { id: 'who-you', where: 'crew name, "YOU"', src: 'crew.js CREW', fg: '#f6c445', px: 11, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'who-partner', where: 'crew name, "PARTNER"', src: 'crew.js CREW', fg: '#5fd0f0', px: 11, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'who-vol3', where: 'crew name, "VOLUNTEER 3"', src: 'crew.js CREW', fg: '#a474fc', px: 11, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },
  { id: 'who-vol4', where: 'crew name, "VOLUNTEER 4"', src: 'crew.js CREW', fg: '#bc7ca4', px: 11, bold: true, bg: [PLATES.pill], over: BRIGHT_BACKDROPS },

  // chips
  { id: 'chip-plain', where: 'chip, e.g. "at the wheel"', src: 'styles.css .chip', fg: CSS_TOKENS.paper, px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(255,255,255,0.07)'], over: BRIGHT_BACKDROPS },
  { id: 'chip-good', where: 'chip.good "on a hydrant"', src: 'styles.css .chip.good', fg: CSS_TOKENS.good, px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(127,209,127,0.18)'], over: BRIGHT_BACKDROPS },
  { id: 'chip-warn', where: 'chip.warn "gas 20%"', src: 'styles.css .chip.warn', fg: CSS_TOKENS.warn, px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(232,192,74,0.18)'], over: BRIGHT_BACKDROPS },
  { id: 'chip-bad', where: 'chip.bad "damage 40%"', src: 'styles.css .chip.bad', fg: CSS_TOKENS.bad, px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(224,106,90,0.20)'], over: BRIGHT_BACKDROPS },
  { id: 'chip-patient', where: 'chip.patient', src: 'styles.css .chip.patient', fg: '#c3bcff', px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(138,127,240,0.22)'], over: BRIGHT_BACKDROPS },
  { id: 'chip-siren', where: 'chip.siren, lit', src: 'styles.css .chip.siren', fg: '#ffd4d4', px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(255,90,90,0.25)'], over: BRIGHT_BACKDROPS },
  /* The same chip at the bottom of its own keyframe. It used to fade the WHOLE chip to
     35%, which took the label to 2.17:1 at the one moment it most needs reading; the
     keyframe now moves the plate from 0.25 to 0.05 and leaves the text alone. Because
     the trough plate is the darker of the two, the label is measurably MORE readable
     mid-flash than lit — asserted in tools/m10-tests.js E12. */
  { id: 'chip-siren-dim', where: 'chip.siren, mid-flash', src: 'styles.css @keyframes flash', fg: '#ffd4d4', px: 11.5, bold: true, bg: [PLATES.pill, 'rgba(255,90,90,0.05)'], over: BRIGHT_BACKDROPS },

  // dispatch list (opaque panel-2 rows on a translucent box)
  { id: 'calls-head', where: '"DISPATCH"', src: 'styles.css .calls-head', fg: CSS_TOKENS.dim, px: 11, bg: [PLATES.calls], over: BRIGHT_BACKDROPS },
  { id: 'calls-hint', where: '"TAB detail"', src: 'styles.css .calls-head .hint', fg: CSS_TOKENS.dim, px: 11, bg: [PLATES.calls], over: BRIGHT_BACKDROPS },
  { id: 'call-head', where: 'call headline', src: 'styles.css #calls li', fg: CSS_TOKENS.paper, px: 12.5, bold: true, bg: [CSS_TOKENS.panel2] },
  { id: 'call-row2', where: 'place and age', src: 'styles.css #calls .row2', fg: CSS_TOKENS.dim, px: 11.5, bg: [CSS_TOKENS.panel2] },
  { id: 'call-unattended', where: '"· unattended"', src: 'styles.css #calls li.queued', fg: CSS_TOKENS.dim, px: 11, bg: [CSS_TOKENS.panel2] },
  { id: 'call-report', where: 'expanded detail', src: 'styles.css #calls .report', fg: '#cfc8e4', px: 11.5, bg: [CSS_TOKENS.panel2] },
  { id: 'call-quiet', where: '"Nothing outstanding"', src: 'styles.css #calls li.quiet', fg: CSS_TOKENS.dim, px: 12.5, bg: [CSS_TOKENS.panel2] },

  // bottom prompt
  { id: 'prompt', where: 'context prompt', src: 'styles.css #prompt, #slots', fg: CSS_TOKENS.paper, px: 13, bg: [PLATES.prompt], over: BRIGHT_BACKDROPS },
  { id: 'prompt-dim', where: '"Nothing in reach."', src: 'styles.css .dim', fg: CSS_TOKENS.dim, px: 13, bg: [PLATES.prompt], over: BRIGHT_BACKDROPS },
  { id: 'kbd', where: 'key cap', src: 'styles.css kbd', fg: CSS_TOKENS.lime, px: 11, bold: true, bg: [PLATES.kbd] },
  { id: 'slot-from', where: 'slot source, "Engine 1"', src: 'styles.css .slot em', fg: CSS_TOKENS.dim, px: 11, bg: [PLATES.prompt], over: BRIGHT_BACKDROPS },
  { id: 'coach', where: 'the coach line', src: 'styles.css #coach', fg: '#e7f6df', px: 13, bg: [PLATES.coach], over: BRIGHT_BACKDROPS },

  // radio log
  { id: 'radio', where: 'radio line', src: 'styles.css #radio .line', fg: '#cfc8e4', px: 11.5, bg: [PLATES.radio], over: BRIGHT_BACKDROPS },
  { id: 'radio-call', where: 'new call line', src: 'styles.css #radio .line.call', fg: '#ffe6c2', px: 11.5, bg: [PLATES.radio], over: BRIGHT_BACKDROPS },
  { id: 'radio-good', where: 'good news line', src: 'styles.css #radio .line.good', fg: '#d6f0d6', px: 11.5, bg: [PLATES.radio], over: BRIGHT_BACKDROPS },
  { id: 'radio-bad', where: 'bad news line', src: 'styles.css #radio .line.bad', fg: '#ffd8d2', px: 11.5, bg: [PLATES.radio], over: BRIGHT_BACKDROPS },

  // overlay cards (opaque panel over a scrim, so no backdrop dependency)
  { id: 'card-tagline', where: 'title tagline', src: 'styles.css .card .tagline', fg: CSS_TOKENS.amber, px: 16, bold: true, bg: [CSS_TOKENS.panel] },
  { id: 'card-body', where: 'title body copy', src: 'styles.css .card .body', fg: '#d9d3ec', px: 16, bg: [CSS_TOKENS.panel] },
  { id: 'card-keys', where: 'key list', src: 'styles.css .card .keys', fg: '#cfc8e4', px: 13, bg: [CSS_TOKENS.panel] },
  { id: 'card-keys-b', where: 'key name', src: 'styles.css .card .keys b', fg: CSS_TOKENS.lime, px: 13, bold: true, bg: [CSS_TOKENS.panel] },
  { id: 'card-coopkeys', where: 'co-op key line', src: 'styles.css .coopkeys', fg: CSS_TOKENS.violet, px: 13, bg: [CSS_TOKENS.panel] },
  { id: 'card-button', where: '"Start the shift"', src: 'styles.css .card button', fg: '#10121a', px: 15, bold: true, bg: [CSS_TOKENS.lime] },
  { id: 'net-or', where: '"or" between buttons', src: 'styles.css #netrow .or', fg: '#8a97a3', px: 12, bg: [CSS_TOKENS.panel] },
  { id: 'net-ghost', where: '"Play together"', src: 'styles.css #netrow button.ghost', fg: '#bcd3e0', px: 13, bold: true, bg: [CSS_TOKENS.panel] },
  { id: 'net-note', where: 'room status note', src: 'styles.css #netnote', fg: '#8fa6b4', px: 12, bg: [CSS_TOKENS.panel] },
  { id: 'joincode', where: 'the code box', src: 'styles.css #joincode', fg: '#eaf6ff', px: 14, bold: true, bg: ['#0b1218'] },
  { id: 'shareurl', where: 'the invitation link', src: 'styles.css #shareurl', fg: '#cfe6f4', px: 12, bg: ['#0b1218'] },

  // shift report
  { id: 'report-standfirst', where: 'standfirst', src: 'styles.css .card.report .standfirst', fg: CSS_TOKENS.dim, px: 13.5, bg: [CSS_TOKENS.panel] },
  { id: 'report-th', where: 'table heading', src: 'styles.css .card.report th', fg: CSS_TOKENS.dim, px: 10.5, bg: [CSS_TOKENS.panel] },
  { id: 'report-grid-b', where: 'stat label', src: 'styles.css .card.report .grid b', fg: CSS_TOKENS.amber, px: 11, bold: true, bg: [CSS_TOKENS.panel] },
  { id: 'report-controlled', where: 'outcome CONTROLLED', src: 'styles.css tr.controlled', fg: CSS_TOKENS.good, px: 10.5, bold: true, bg: [CSS_TOKENS.panel] },
  { id: 'report-lost', where: 'outcome LOST', src: 'styles.css tr.lost', fg: CSS_TOKENS.coral, px: 10.5, bold: true, bg: [CSS_TOKENS.panel] },

  // touch controls
  { id: 'tbtn', where: 'thumb button label', src: 'styles.css .tbtn', fg: '#eaf4ff', px: 15.6, bold: true, bg: [PLATES.tbtn], over: BRIGHT_BACKDROPS },
  { id: 'tbtn-sub', where: 'thumb button sublabel at 80%', src: 'styles.css .tbtn span', fg: '#eaf4ff', fgAlpha: 0.8, px: 11, bold: true, bg: [PLATES.tbtn], over: BRIGHT_BACKDROPS },
  { id: 'tslot', where: 'equipment row', src: 'styles.css .tslot', fg: '#ffe9b0', px: 12, bold: true, bg: [PLATES.tslot], over: BRIGHT_BACKDROPS },

  /* Text painted straight onto the town.
   *
   * All five now sit on the same 3 px rgba(0,0,0,0.62) halo — the one drawLabels has
   * always stroked, and which drawIncidentMarkers did not until the call headline was
   * measured at 1.00:1 against the civic roof. The halo IS the background, so these are
   * measured through it, swept over every backdrop rather than one chosen one: 55% black
   * over the brightest roof is still the worst case, and now the audit finds that out
   * for itself instead of being told. */
  { id: 'marker-headline', where: 'call headline, haloed', src: 'renderer.js drawIncidentMarkers', fg: '#fdf6e6', px: 11, bold: true, bg: ['rgba(0,0,0,0.62)'], over: BRIGHT_BACKDROPS },
  { id: 'marker-arrow', where: 'off-screen call label, haloed', src: 'renderer.js drawIncidentMarkers', fg: '#fdf6e6', px: 11, bold: true, bg: ['rgba(0,0,0,0.62)'], over: BRIGHT_BACKDROPS },
  { id: 'label-building', where: 'building name, haloed', src: 'renderer.js drawBuilding', fg: '#fdf6e6', px: 11, bold: true, bg: ['rgba(0,0,0,0.62)'], over: BRIGHT_BACKDROPS },
  { id: 'label-truck', where: 'ENG/MED/RES, haloed', src: 'renderer.js drawApparatus', fg: '#ffffff', px: 10, bold: true, bg: ['rgba(0,0,0,0.62)'], over: BRIGHT_BACKDROPS },
  { id: 'label-tool', where: 'tool short name, haloed', src: 'renderer.js drawTool', fg: '#ffe9b0', px: 9, bold: true, bg: ['rgba(0,0,0,0.62)'], over: BRIGHT_BACKDROPS },
]);

/** Resolve one pair to its worst real background and the ratio there. */
export function auditPair(pair) {
  const fg = pair.fgAlpha == null ? pair.fg : { ...parseColour(pair.fg), a: pair.fgAlpha };
  const overs = pair.over && pair.over.length ? pair.over : [null];
  let worst = null;
  for (const name of overs) {
    const stack = name ? [CANVAS_BACKDROPS[name], ...pair.bg] : [...pair.bg];
    if (!stack.length) continue;
    const bg = flatten(stack);
    const ratio = contrastRatio(composite(fg, bg), bg);
    if (!worst || ratio < worst.ratio) worst = { ratio, bg: toHex(bg), backdrop: name };
  }
  const need = requiredRatio(pair.px, pair.bold);
  return {
    id: pair.id, where: pair.where, src: pair.src, fg: toHex(pair.fg), px: pair.px,
    bold: !!pair.bold, large: isLargeText(pair.px, pair.bold),
    bg: worst.bg, backdrop: worst.backdrop, ratio: worst.ratio, need,
    pass: worst.ratio >= need, aaa: worst.ratio >= (isLargeText(pair.px, pair.bold) ? 4.5 : 7),
  };
}

export function auditText(pairs = TEXT_PAIRS) { return pairs.map(auditPair); }
export function textFailures(pairs = TEXT_PAIRS) { return auditText(pairs).filter((r) => !r.pass); }

/* ── the signals: where colour is doing the talking ───────────────────────── */

/**
 * `carrier` is the honest half of this audit. A pair of colours that a deuteranope
 * cannot separate is only a BUG when colour is the only thing carrying the meaning.
 * The radio log is colour-coded and also says what happened in words; the patient ring
 * is a coloured ring and nothing else. Those are not the same finding, and reporting
 * them as one would be scaremongering.
 */
export const SIGNAL_GROUPS = Object.freeze([
  {
    id: 'priority-marker', where: 'incident marker + headline on the town',
    src: 'renderer.js drawIncidentMarkers', carrier: 'colour+ring-count+bang',
    colours: { routine: '#fff0c0', high: '#e8850f', critical: '#c0271f' },
  },
  {
    id: 'priority-list', where: 'call list left border',
    src: 'styles.css #calls li.p-routine', carrier: 'colour+border-width+style',
    colours: { routine: '#fff0c0', high: '#e8850f', critical: '#c0271f' },
  },
  {
    id: 'condition-ring', where: 'patient ring on the ground',
    src: 'renderer.js drawVictim', carrier: 'colour+dash-pattern',
    colours: { stable: '#daf7cf', injured: '#e8a33d', critical: '#b02418', unconscious: '#5b2c85', lost: '#6b6b6b' },
  },
  {
    id: 'condition-bar', where: 'the bar floating over a casualty',
    src: 'renderer.js drawVictim', carrier: 'colour+length',
    colours: { stable: '#daf7cf', injured: '#e8a33d', critical: '#b02418', unconscious: '#5b2c85' },
  },
  /* These two were ONE group until --bad moved from #e06a5a to #f0928a for contrast.
   * The chips follow the token; the confidence bar hard-codes its three hexes in
   * hud.js, so it did not follow. Same three-step status signal, two palettes, two
   * files — the identical split that already exists between the canvas and the CSS for
   * incident priority. Auditing them as one group would have hidden it, so they are
   * two, and tools/m10-tests.js D25 asserts the divergence out loud. */
  {
    id: 'confidence-bar', where: 'the town-confidence bar in the top bar',
    src: 'hud.js confBar', carrier: 'colour+length',
    colours: { high: '#7fd17f', mid: '#e8c04a', low: '#e06a5a' },
  },
  {
    id: 'chip-status', where: 'every good/warn/bad chip',
    src: 'styles.css .chip.good', carrier: 'colour+text',
    colours: { good: '#7fd17f', warn: '#e8c04a', bad: '#f0928a' },
  },
  /* Six pairs, not one. Two tints is the easiest colour problem there is and four is a
   * genuinely hard one: the first two sit at L* 82 and 78, so anything joining them has
   * to be found in the L* 57-70 band that is left, and it has to clear every other member
   * under all three simulations at once. The set below was searched, not chosen — the
   * PROPOSED entry has what the eye picked first and what it measured.
   *
   * `src` is crew.js and not game.js: the table moved to src/data/crew.js when protocol.js
   * needed a third volunteer's colour and could not import game.js back. */
  {
    id: 'crew-tint', where: 'which of the four responders is which',
    src: 'crew.js CREW', carrier: 'colour-only',
    colours: { you: '#f6c445', partner: '#5fd0f0', vol3: '#a474fc', vol4: '#bc7ca4' },
  },
  {
    id: 'apparatus-tint', where: 'which truck is which',
    src: 'equipment.js tint', carrier: 'colour+text',
    colours: { engine: '#c0392b', ambulance: '#ecf0f1', rescue: '#e67e22' },
  },
  {
    id: 'siren-bar', where: 'the lightbar on the cab roof',
    src: 'renderer.js drawApparatus', carrier: 'colour+time',
    colours: { red: '#ff4444', blue: '#5588ff' },
  },
  {
    id: 'hydrant', where: 'a hydrant in service or flattened',
    src: 'renderer.js PALETTE', carrier: 'colour-only',
    colours: { live: '#d94f3d', dead: '#6b6b6b' },
  },
  {
    id: 'gas-meter', where: 'the gas supply shut off or not',
    src: 'renderer.js drawGasFitting', carrier: 'colour+sound',
    colours: { live: '#c9c25a', shutOff: '#6d8f5a' },
  },
  {
    id: 'radio-kind', where: 'radio log left border',
    src: 'styles.css #radio .line.call', carrier: 'colour+text',
    colours: { call: '#ffab3d', update: '#8a7ff0', good: '#7fd17f', bad: '#ff5a5a', system: '#9d97b5' },
  },
]);

/** Every within-group pair, expanded. */
export function signalPairs(groups = SIGNAL_GROUPS) {
  const out = [];
  for (const g of groups) {
    const names = Object.keys(g.colours);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        out.push({ group: g.id, where: g.where, src: g.src, carrier: g.carrier,
          aName: names[i], bName: names[j], a: g.colours[names[i]], b: g.colours[names[j]] });
      }
    }
  }
  return out;
}

export function auditSignals(groups = SIGNAL_GROUPS) {
  return signalPairs(groups).map((p) => ({ ...p, ...distinguishable(p.a, p.b) }));
}

/** Pairs that collapse AND where nothing but colour is carrying the meaning. */
export function signalFailures(groups = SIGNAL_GROUPS) {
  return auditSignals(groups).filter((r) => !r.ok && r.carrier === 'colour-only');
}

/** Pairs that collapse but have another carrier: worth fixing, not urgent. */
export function signalWarnings(groups = SIGNAL_GROUPS) {
  return auditSignals(groups).filter((r) => !r.ok && r.carrier !== 'colour-only');
}

/* ── what to do about it ──────────────────────────────────────────────────── */

/**
 * What was proposed, and what is now in the game. `from` is the palette this audit
 * found; `to` is what replaced it, and `to` is now what SIGNAL_GROUPS reads — asserted
 * in tools/m10-tests.js F9, which is the regression lock: if somebody nudges a hex back
 * towards the old one, the applied set stops matching the proven set and the suite says
 * so before a player with a colour-vision deficiency does.
 *
 * The hexes stay inside the game's palette — the same ambers and reds — but they are
 * spread along LIGHTNESS instead of hue, because lightness is the one channel all three
 * deficiencies keep. Every set is asserted (F3) to clear SIGNAL_DELTA_E under all three
 * simulations, so a set that does not work cannot sit here looking helpful. One earlier
 * attempt at the ring did not and was caught here, not in the game.
 *
 * `redundancy` is the real answer, and every one of them is now built: the ring count
 * and the bang, the border width and style, the dash pattern. A recoloured ring is still
 * a ring, and a player who sees no colour at all still has to triage.
 */
export const PROPOSED = Object.freeze([
  {
    id: 'priority-marker',
    from: { routine: '#ffe082', high: '#ffa726', critical: '#ff5252' },
    to: { routine: '#fff0c0', high: '#e8850f', critical: '#c0271f' },
    why: 'routine and high measure 5.5 dE00 apart for a tritanope and high and critical 5.8, '
      + 'with only 1.50:1 and 1.64:1 of lightness between them — three amber-to-red hues on '
      + 'one axis. The replacements are the same three hues spread over L* 93 / 67 / 42, '
      + 'which lifts the worst pair to 13.7 under every simulation.',
    redundancy: 'shape and count, drawn with the ring that is already there '
      + '(renderer.js:1337-1339): routine = one thin ring, high = two concentric rings, '
      + 'critical = two rings plus a filled centre dot. And prefix the headline with '
      + 'nothing / ! / !! so the text carries it too.',
  },
  {
    id: 'priority-list',
    from: { routine: '#ffe082', high: '#ffab3d', critical: '#ff5a5a' },
    to: { routine: '#fff0c0', high: '#e8850f', critical: '#c0271f' },
    why: 'the same three priorities, worse: routine/high measures 5.0. And the CSS and the '
      + 'canvas do not even agree on the hex today (#ffab3d vs #ffa726, #ff5a5a vs #ff5252) '
      + 'for what is meant to be one signal — one set for both.',
    redundancy: 'border-left-style: solid 3px / double 4px / solid 6px, plus the same '
      + '"!"/"!!" prefix on the headline. Width and style both survive greyscale, and the '
      + 'list is already sorted by priority (hud.js:294-295), which is a third carrier.',
  },
  {
    id: 'condition-ring',
    from: { stable: '#5fbf6a', injured: '#e8a33d', critical: '#e74c3c', unconscious: '#8e44ad', lost: '#5c5c5c' },
    to: { stable: '#daf7cf', injured: '#e8a33d', critical: '#b02418', unconscious: '#5b2c85', lost: '#6b6b6b' },
    why: 'stable and injured measure 5.8 apart for a protanope with 1.06:1 of lightness '
      + 'between them — the ring around a walking casualty and the ring around a bleeding '
      + 'one are the same mark. Lifting stable to L* 95 and dropping critical to L* 39 '
      + 'spreads the three over lightness; darkening the purple keeps it clear of the new '
      + 'dark red, which a first attempt at this did not (it fell to 7.1). Worst pair of '
      + 'the ten: 21.6.',
    redundancy: 'dash the ring: stable = solid, injured = long dash, critical = short dash, '
      + 'unconscious = dotted, lost = the cross the trapped marker already draws '
      + '(renderer.js:1064-1068). ctx.setLineDash costs one line and reads at any zoom. The '
      + 'condition BAR above them (renderer.js:1075-1076) is already a length, which is why '
      + 'the bar is a warning and the ring is a failure.',
  },
  {
    id: 'crew-tint',
    from: { you: '#f6c445', partner: '#5fd0f0', vol3: '#b9f06a', vol4: '#ef8fd0' },
    to: { you: '#f6c445', partner: '#5fd0f0', vol3: '#a474fc', vol4: '#bc7ca4' },
    why: 'the crew went from two to four, and the two colours added to fill r3 and r4 were '
      + 'picked by eye. A lime and a pink beside a gold and a cyan look like four obviously '
      + 'different things and are not: lime #b9f06a against the player OWN gold measures 4.8 '
      + 'dE00 for a deuteranope and 7.7 for a protanope — one colour, not two — and pink '
      + '#ef8fd0 against that same gold measures 6.1 for a tritanope. Three of the six pairs '
      + 'collapsed, and the one carrying "which of these is me" was among them. '
      + 'The two originals are kept: they are the SIGNAL_DELTA_E anchor at 46.7, and moving '
      + 'them was measured to buy only 2 dE00 on the worst pair, which is not worth unlearning '
      + 'a colour a player already knows. r3 and r4 were then searched over the whole gamut '
      + 'rather than reached for: 16.5 is the best any pair of colours can do behind those two, '
      + 'and #a474fc/#bc7ca4 is where it lands (worst pair partner/vol3, deuteranopia).',
    redundancy: 'lightness does the structural work — 82/78 over 59/60 makes this two tiers '
      + 'of two hues rather than four hues on one tier, and lightness is the channel all three '
      + 'deficiencies keep. The free non-colour carrier is the white band already stroked '
      + 'across the torso (renderer.js drawResponder): one band for r1 through four for r4 '
      + 'counts at any zoom and survives greyscale entirely.',
  },
]);

/* ── motion ───────────────────────────────────────────────────────────────── */

/**
 * True when the player has asked their operating system for less movement.
 *
 * Defensive on purpose: a window with no matchMedia (a test double, an old browser)
 * must answer "no", never throw. Nothing in this game may fail to draw because a media
 * query was missing.
 */
export function prefersReducedMotion(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || typeof w.matchMedia !== 'function') return false;
  try {
    const m = w.matchMedia('(prefers-reduced-motion: reduce)');
    return !!(m && m.matches);
  } catch (e) { return false; }
}

/**
 * Measured rates of every moving thing, in flashes per second.
 *
 * WCAG 2.3.1's general flash threshold is three flashes in any one second. `hz` here is
 * flashes, not cycles: `Math.abs(Math.sin(t*k))` has a brightness minimum twice per
 * cycle, so its flash rate is double its cycle rate. That doubling is the whole story of
 * the stun ring: written as `abs(sin(t*14))` it read as a gentle 2.2 Hz wobble and was
 * in fact 4.46 flashes a second, the only thing in the game over the line. It is
 * `abs(sin(t*6))` now — 1.91 Hz — and nothing here clears 3 Hz any more.
 *
 * `wired` says whether the renderer actually reads the matching motion scalar. Anything
 * false still moves at full strength for a player who asked for less; §H checks it
 * against the real file rather than taking this column's word for it.
 */
export const ANIMATION_RATES = Object.freeze([
  { id: 'fireFlicker', src: 'renderer.js drawRoofFire', expr: 'wobble(i,t,8)', hz: 8 / (2 * Math.PI), hz2: 13.6 / (2 * Math.PI), wired: true },
  { id: 'firelightWobble', src: 'renderer.js drawFireLight', expr: 'wobble(i,t,3)', hz: 3 / (2 * Math.PI), hz2: 5.1 / (2 * Math.PI), wired: true },
  { id: 'treeSway', src: 'renderer.js drawTree', expr: 'wobble(i,t,0.5)', hz: 0.5 / (2 * Math.PI), hz2: 0.85 / (2 * Math.PI), wired: true },
  { id: 'smokeDrift', src: 'renderer.js drawSmokePuff', expr: '(t*0.5+...)%1', hz: 0.5, wired: true },
  { id: 'emberDrift', src: 'renderer.js drawEmbers', expr: '(t*0.42+...)%1', hz: 0.42, wired: true },
  { id: 'powerPulse', src: 'renderer.js drawPowerZones', expr: 'pulse01(t,0.7958)', hz: 5 / (2 * Math.PI), wired: true },
  { id: 'markerPulse', src: 'renderer.js drawIncidentMarkers', expr: 'pulse01(t,0.6366)', hz: 4 / (2 * Math.PI), wired: true },
  { id: 'sirenBlink', src: 'renderer.js drawApparatus', expr: 'blinkOn(t,1.9099)', hz: 12 / (2 * Math.PI), wired: true },
  { id: 'sirenRing', src: 'renderer.js drawApparatus', expr: 'abs(sin(t*3))', hz: (2 * 3) / (2 * Math.PI), wired: true },
  { id: 'stunFlash', src: 'renderer.js drawResponder', expr: 'abs(sin(t*6))', hz: (2 * 6) / (2 * Math.PI), wired: true },
  // CSS, so it is damped by the blanket prefers-reduced-motion rule rather than a scalar
  { id: 'chipFlash', src: 'styles.css @keyframes flash', expr: 'animation: flash .6s steps(2)', hz: 1 / 0.6, wired: 'css' },
]);

/** WCAG 2.3.1: no more than three flashes in any one second. */
export const FLASH_THRESHOLD_HZ = 3;

export function flashHazards(rates = ANIMATION_RATES) {
  return rates.filter((r) => Math.max(r.hz, r.hz2 || 0) > FLASH_THRESHOLD_HZ);
}

/** Everything moves at full strength. The renderer's behaviour today. */
export const MOTION_FULL = Object.freeze({
  fireFlicker: 1, firelightWobble: 1, treeSway: 1, smokeDrift: 1, emberDrift: 1,
  powerPulse: 1, markerPulse: 1, sirenBlink: 1, sirenRing: 1, stunFlash: 1, chipFlash: 1,
});

/**
 * Damped. Not switched off — a scalar of 0 holds the value at the MIDDLE of its normal
 * swing, so a marker that pulsed is still a marker and a fire still glows. Losing the
 * animation must never lose the information.
 *
 * fireFlicker keeps a quarter of its swing because a fire that does not move at all
 * stops reading as a fire; the things that reduce to 0 are the ones whose whole content
 * is "look at me": the two siren animations, the marker pulse, the stun ring. The stun
 * ring was also the one rate in the game above the WCAG 2.3.1 flash threshold, at 4.46
 * flashes a second; it is 1.91 now, so damping it is a comfort setting rather than the
 * only thing standing between a player and a photosensitivity trigger.
 */
export const MOTION_REDUCED = Object.freeze({
  fireFlicker: 0.25, firelightWobble: 0.2, treeSway: 0, smokeDrift: 0.3, emberDrift: 0,
  powerPulse: 0.2, markerPulse: 0, sirenBlink: 0, sirenRing: 0, stunFlash: 0, chipFlash: 0,
});

/** The scalar set this window should draw with. Pure: same window, same answer. */
export function motionScalars(win) {
  return prefersReducedMotion(win) ? MOTION_REDUCED : MOTION_FULL;
}

/** mid + (raw-mid)*scalar. scalar 1 is untouched; scalar 0 is a steady mid value. */
export function dampen(raw, mid, scalar) { return mid + (raw - mid) * scalar; }

/** A 0..1 pulse at `hz`, damped. Replaces `0.5 + 0.5*Math.sin(t*k)` in the renderer. */
export function pulse01(t, hz, scalar = 1) {
  return dampen(0.5 + 0.5 * Math.sin(t * hz * 2 * Math.PI), 0.5, scalar);
}

/** A two-state blink. At scalar 0 it stops on the LIT state — a siren is still on. */
export function blinkOn(t, hz, scalar = 1) {
  if (!(scalar > 0)) return true;
  return Math.sin(t * hz * 2 * Math.PI) > 0;
}

/* ── text size ────────────────────────────────────────────────────────────── */

/**
 * Every font-size the HUD sets, and what it becomes inside the phone media query
 * (`@media (max-width: 700px), (max-height: 480px)` — note the second clause: a landscape
 * phone is 844 px wide and still a phone).
 *
 * Sizes are px except the touch controls, which are vmin and therefore depend on the
 * screen. That is how `.tbtn span` came to be the smallest text in the game: 2.1vmin is
 * 15.1 px on the desktop it was written on and 8.2 px on a 390 px phone, and nothing in
 * the stylesheet said so. It now carries a `minPx` floor — `max(11px, 2.1vmin)` — which
 * is the shape a vmin size needs if it is ever going to be read.
 */
export const FONT_SIZES = Object.freeze([
  { id: 'pill', where: 'top bar', src: 'styles.css .pill', px: 13, phonePx: 11 },
  { id: 'clock', where: 'shift clock', src: 'styles.css #clock', px: 16, phonePx: 11 },
  { id: 'conf-label', where: '"TOWN"', src: 'styles.css #confidence .label', px: 11, phonePx: 11 },
  { id: 'conf-word', where: 'confidence word', src: 'styles.css #confidence .word', px: 12, phonePx: 12 },
  { id: 'mute', where: 'SOUND/MUTED', src: 'styles.css .pill.mute', px: 11, phonePx: 11 },
  /* `.who` sets its own 11px, so the phone rule that takes `#topbar .pill` down to 11 has
   *  nothing left to shrink — the one size in this table that is already at its floor. */
  { id: 'who', where: 'crew name in the status line', src: 'styles.css .who', px: 11, phonePx: 11 },
  { id: 'chip', where: 'status chips', src: 'styles.css .chip', px: 11.5, phonePx: 11.5 },
  { id: 'calls', where: 'call rows', src: 'styles.css #calls li', px: 12.5, phonePx: 11 },
  { id: 'calls-head', where: '"DISPATCH"', src: 'styles.css .calls-head', px: 11, phonePx: 11 },
  { id: 'calls-hint', where: '"TAB detail"', src: 'styles.css .calls-head .hint', px: 11, phonePx: 11 },
  { id: 'call-row2', where: 'place and age', src: 'styles.css #calls .row2', px: 11.5, phonePx: 11.5 },
  { id: 'call-unattended', where: '"· unattended"', src: 'styles.css #calls li.queued', px: 11, phonePx: 11 },
  { id: 'call-report', where: 'expanded detail', src: 'styles.css #calls .report', px: 11.5, phonePx: 11.5 },
  { id: 'prompt', where: 'context prompt', src: 'styles.css #prompt, #slots', px: 13, phonePx: 11 },
  { id: 'kbd', where: 'key caps', src: 'styles.css kbd', px: 11, phonePx: 11 },
  { id: 'slots', where: 'equipment list', src: 'styles.css #slots', px: 12, phonePx: null }, // display:none on a phone
  { id: 'slot-from', where: 'slot source', src: 'styles.css .slot em', px: 11, phonePx: null },
  { id: 'coach', where: 'the coach', src: 'styles.css #coach', px: 13, phonePx: 11 },
  { id: 'radio', where: 'radio log', src: 'styles.css #radio', px: 11.5, phonePx: 12 },   // 10 -> 12
  { id: 'card-keys', where: 'title key list', src: 'styles.css .card .keys', px: 13, phonePx: null },
  { id: 'net-or', where: '"or"', src: 'styles.css #netrow .or', px: 12, phonePx: 12 },
  { id: 'net-note', where: 'room status', src: 'styles.css #netnote', px: 12, phonePx: 12 },
  { id: 'report-th', where: 'report table heading', src: 'styles.css .card.report th', px: 10.5, phonePx: 10.5 },
  { id: 'report-st', where: 'report outcome cell', src: 'styles.css td.st', px: 10.5, phonePx: 10.5 },
  { id: 'report-grid-b', where: 'report stat label', src: 'styles.css .card.report .grid b', px: 11, phonePx: 11 },
  { id: 'report-table', where: 'report table body', src: 'styles.css .card.report table', px: 12.5, phonePx: 12.5 },
  { id: 'debug', where: 'F3 overlay', src: 'styles.css #debug', px: 11, phonePx: 11 },
  { id: 'tbtn', where: 'thumb button', src: 'styles.css .tbtn', vmin: 4 },
  { id: 'tbtn-sub', where: 'thumb button sublabel', src: 'styles.css .tbtn span', vmin: 2.1, minPx: 11 },
  { id: 'tslot', where: 'touch equipment row', src: 'styles.css .tslot', vmin: 2.6, minPx: 12 },
  { id: 'label-building', where: 'canvas: building name', src: 'renderer.js drawBuilding', px: 11, phonePx: 11 },
  { id: 'label-marker', where: 'canvas: call headline', src: 'renderer.js drawIncidentMarkers', px: 11, phonePx: 11 },
  { id: 'label-arrow', where: 'canvas: off-screen call', src: 'renderer.js drawIncidentMarkers', px: 11, phonePx: 11 }, // 10 -> 11
  { id: 'label-truck', where: 'canvas: ENG/MED/RES', src: 'renderer.js drawApparatus', px: 10, phonePx: 10 },
  { id: 'label-tool', where: 'canvas: tool short name', src: 'renderer.js drawTool', px: 9, phonePx: 9 },
]);

/** The phone breakpoint, verbatim: `(max-width: 700px), (max-height: 480px)`. */
export function isPhoneLayout(vw, vh) { return vw <= 700 || vh <= 480; }

/** The size this rule resolves to on a given viewport, or null if it is not shown. */
export function resolvedPx(entry, vw, vh) {
  if (entry.vmin != null) {
    return Math.max(entry.minPx || 0, (entry.vmin / 100) * Math.min(vw, vh));
  }
  return isPhoneLayout(vw, vh) ? entry.phonePx : entry.px;
}

/** 12px: the floor below which body text stops being comfortably readable on a phone.
 *  Apple's HIG puts its minimum at 11pt and Android at 12sp; 12px is the harder line
 *  and the one worth reporting against. */
export const TEXT_FLOOR_PX = 12;

export function textSizes(vw, vh, sizes = FONT_SIZES) {
  return sizes
    .map((e) => ({ id: e.id, where: e.where, src: e.src, px: resolvedPx(e, vw, vh) }))
    .filter((e) => e.px != null)
    .sort((a, b) => a.px - b.px);
}

export function smallestText(vw, vh, sizes = FONT_SIZES) {
  const list = textSizes(vw, vh, sizes);
  return list.length ? list[0] : null;
}

export function textSizeFailures(vw, vh, floor = TEXT_FLOOR_PX, sizes = FONT_SIZES) {
  return textSizes(vw, vh, sizes).filter((e) => e.px < floor);
}
