/* Accessibility — measured, not asserted by vibes.
 *
 * Three things this suite exists to stop:
 *   1. a11y.js quoting colours the game does not actually use. Every literal in the
 *      audit tables is checked against the file it claims to come from, read back over
 *      http at run time (§H). An audit of invented colours fails here.
 *   2. the contrast maths being plausible but wrong. It is asserted against published
 *      values — black on white is exactly 21:1, #767676 on white is 4.54:1 — and
 *      CIEDE2000 against the CIE's own reference pairs (§B).
 *   3. a proposed replacement palette that does not survive the simulations it was
 *      proposed to survive (§F).
 */

import {
  parseColour, toHex, composite, flatten, srgbToLinear, relativeLuminance, contrastRatio,
  isLargeText, requiredRatio, toLab, deltaE00, deltaE, simulateCvd, cvdReport, CVD_KINDS,
  distinguishable, SIGNAL_DELTA_E, JND_DELTA_E, LUM_ESCAPE_RATIO, LUM_PARTIAL_RATIO,
  parseSrc, CSS_VAR_NAMES, CSS_TOKENS, PLATES, CANVAS_BACKDROPS,
  TEXT_PAIRS, auditText, textFailures, SIGNAL_GROUPS, signalPairs, auditSignals,
  signalFailures, signalWarnings, PROPOSED, prefersReducedMotion, motionScalars,
  MOTION_FULL, MOTION_REDUCED, dampen, pulse01, blinkOn, ANIMATION_RATES,
  FLASH_THRESHOLD_HZ, flashHazards, FONT_SIZES, isPhoneLayout, resolvedPx, textSizes,
  smallestText, textSizeFailures, TEXT_FLOOR_PX,
} from '../src/ui/a11y.js';
import { APPARATUS_DEFS } from '../src/data/equipment.js';

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
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);

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

const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const lpad = (s, n) => String(s).padStart(n);

/** Lab hue angle in degrees — the channel a dichromat loses. */
function hueAngle(colour) {
  const l = toLab(colour);
  const h = (Math.atan2(l.b, l.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}
function hueSpread(cols) {
  const hs = cols.map(hueAngle);
  let max = 0;
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      let d = Math.abs(hs[i] - hs[j]);
      if (d > 180) d = 360 - d;
      if (d > max) max = d;
    }
  }
  return max;
}

/* ── A. the contrast maths, against values that can be checked by hand ───── */
function sectionA() {
lines.push('--- A. luminance and WCAG contrast ---');
  near('A1 white is luminance 1', relativeLuminance('#ffffff'), 1, 1e-9);
  near('A2 black is luminance 0', relativeLuminance('#000000'), 0, 1e-9);
  near('A3 black on white is exactly 21:1', contrastRatio('#000000', '#ffffff'), 21, 1e-9);
  near('A4 and the ratio does not care which way round', contrastRatio('#ffffff', '#000000'), 21, 1e-9);
  near('A5 a colour against itself is 1:1', contrastRatio('#688f4e', '#688f4e'), 1, 1e-12);

  /* Hand-checkable: 0x80/255 = 0.50196; ((0.50196+0.055)/1.055)^2.4 = 0.21586;
     (1.05)/(0.21586+0.05) = 3.949. WebAIM reports 3.95:1 for the same pair. */
  near('A6 mid grey on white is 3.95:1', contrastRatio('#808080', '#ffffff'), 3.95, 0.005);
  near('A7 and 5.32:1 on black', contrastRatio('#808080', '#000000'), 5.32, 0.005);
  near('A8 #767676 is the lightest grey that clears AA on white',
    contrastRatio('#767676', '#ffffff'), 4.54, 0.005);
  lt('A9 one shade lighter does not', contrastRatio('#777777', '#ffffff'), 4.5);

  near('A10 the sRGB toe is linear below 0.03928', srgbToLinear(0.02), 0.02 / 12.92, 1e-12);
  near('A11 and a power curve above it', srgbToLinear(0.5), Math.pow((0.555) / 1.055, 2.4), 1e-12);

  // parsing, including the shape that once painted half the town black (renderer.js:86)
  eq('A12 #rgb expands', toHex('#f8a'), '#ff88aa');
  eq('A13 rgb() parses', toHex('rgb(255, 224, 130)'), '#ffe082');
  eq('A14 rgba() keeps its alpha', parseColour('rgba(23,21,34,0.86)').a, 0.86);
  let threw = false;
  try { parseColour('gb(204,60,45)'); } catch (e) { threw = true; }
  ok('A15 and garbage throws instead of silently becoming black', threw);

  // compositing a translucent panel is not the same as ignoring the alpha
  const overGrass = composite('rgba(23,21,34,0.86)', CANVAS_BACKDROPS.grass);
  gt('A16 a panel over grass is lighter than the panel colour',
    relativeLuminance(overGrass), relativeLuminance('#171522'));
  const stacked = flatten([CANVAS_BACKDROPS.grass, PLATES.pill, 'rgba(255,255,255,0.07)']);
  gt('A17 and a chip stacked on it lighter still', relativeLuminance(stacked), relativeLuminance(overGrass));

  ok('A18 24px is large text', isLargeText(24, false));
  ok('A19 18.66px is large only when bold', isLargeText(18.66, true) && !isLargeText(18.66, false));
  eq('A20 so 13px bold HUD text needs the full 4.5:1', requiredRatio(13, true), 4.5);
}

/* ── B. CIELAB and CIEDE2000, against the CIE's reference pairs ──────────── */
function sectionB() {
lines.push('--- B. perceptual distance ---');
  const w = toLab('#ffffff');
  near('B1 white is L*100', w.L, 100, 0.01);
  near('B2 with no chroma (a)', w.a, 0, 0.02);
  near('B3 with no chroma (b)', w.b, 0, 0.02);
  near('B4 black is L*0', toLab('#000000').L, 0, 1e-9);
  near('B5 mid grey is L*53.6', toLab('#808080').L, 53.585, 0.02);

  /* Sharma, Wu & Dalal's CIEDE2000 test data — the pairs the standard is verified
     against. If the hue-angle mean or the RT rotation term is wrong, these are what
     catch it; a naive implementation gets B6 and B8 wrong by a factor of two. */
  const d = (l1, a1, b1, l2, a2, b2) => deltaE00({ L: l1, a: a1, b: b1 }, { L: l2, a: a2, b: b2 });
  near('B6 reference pair 1 (blue, hue wrap)', d(50, 2.6772, -79.7751, 50, 0, -82.7485), 2.0425, 0.01);
  near('B7 reference pair 7 (near neutral)', d(50, 0, 0, 50, -1, 2), 2.3669, 0.01);
  near('B8 reference pair 9 (opposite sides of neutral)',
    d(50, 2.49, -0.001, 50, -2.49, 0.0009), 7.1792, 0.01);
  near('B9 reference pair 18 (green)', d(60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387), 1.2644, 0.01);
  near('B10 reference pair 30 (near white)', d(90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447), 1.4441, 0.01);

  near('B11 a colour is zero distance from itself', deltaE('#e8a33d', '#e8a33d'), 0, 1e-9);
  near('B12 and the metric is symmetric',
    deltaE('#5fbf6a', '#e74c3c') - deltaE('#e74c3c', '#5fbf6a'), 0, 1e-9);
  gt('B13 two colours a person would call different clear the JND',
    deltaE('#5fbf6a', '#e74c3c'), JND_DELTA_E);
  lt('B14 and one 8-bit step does not', deltaE('#e8a33d', '#e8a33e'), JND_DELTA_E);
}

/* ── C. simulating the three deficiencies ───────────────────────────────── */
function sectionC() {
lines.push('--- C. colour-vision deficiency simulation ---');
  for (const k of CVD_KINDS) {
    const g = parseColour(simulateCvd('#808080', k));
    ok(`C1.${k} grey is a fixed point (${toHex(g)})`,
      Math.abs(g.r - g.g) <= 2 && Math.abs(g.g - g.b) <= 2, `${g.r},${g.g},${g.b}`);
  }
  eq('C2 white stays white for a deuteranope', simulateCvd('#ffffff', 'deuteranopia'), '#ffffff');
  eq('C3 black stays black for a protanope', simulateCvd('#000000', 'protanopia'), '#000000');

  /* The defining property of the two red-green deficiencies: the surviving cones cannot
     separate long from medium, so the simulated red and green channels come out equal.
     If this ever stops holding, the projection matrices have been mangled. */
  for (const k of ['protanopia', 'deuteranopia']) {
    const c = parseColour(simulateCvd('#ff0000', k));
    ok(`C4.${k} red loses the red-green axis (R==G, ${toHex(c)})`, Math.abs(c.r - c.g) <= 2,
      `${c.r} vs ${c.g}`);
  }

  /* Protanopes have reduced luminous efficiency at the red end; deuteranopes do not.
     A simulation that got this backwards would under-report exactly the wrong failures. */
  lt('C5 red is darker to a protanope than to a deuteranope',
    relativeLuminance(simulateCvd('#ff0000', 'protanopia')),
    relativeLuminance(simulateCvd('#ff0000', 'deuteranopia')));

  /* The blue-yellow axis survives both red-green deficiencies, which is the whole reason
     the crew tints (#f6c445 / #5fd0f0) work. */
  gt('C6 yellow and cyan stay apart for a deuteranope',
    deltaE(simulateCvd('#f6c445', 'deuteranopia'), simulateCvd('#5fd0f0', 'deuteranopia')),
    SIGNAL_DELTA_E);

  // the game's own three priorities, measured before and after
  const pri = ['#ffe082', '#ffa726', '#ff5252'];
  const before = hueSpread(pri);
  const after = hueSpread(pri.map((c) => simulateCvd(c, 'deuteranopia')));
  lines.push(`      priority hue spread: ${f(before, 1)} deg normal -> ${f(after, 1)} deg deuteranope`);
  lt('C7 the three priorities collapse onto one hue for a deuteranope', after, before / 2);

  let threw = false;
  try { simulateCvd('#ffffff', 'monochromacy'); } catch (e) { threw = true; }
  ok('C8 an unknown deficiency throws rather than quietly returning the input', threw);

  const rep = cvdReport('#e74c3c');
  ok('C9 cvdReport answers for all three plus normal',
    !!(rep.normal && rep.protanopia && rep.deuteranopia && rep.tritanopia));
  eq('C10 and reports the original unchanged', rep.normal, '#e74c3c');
}

/* ── D. every signal the game actually uses ─────────────────────────────── */
function sectionD() {
lines.push('--- D. the signal pairs ---');
  const rows = auditSignals();
  const ids = new Set(rows.map((r) => r.group));
  eq('D1 every declared signal group is audited', ids.size, SIGNAL_GROUPS.length);
  eq('D2 and every within-group pair with it', rows.length, signalPairs().length);
  ok('D3 no pair is missing a simulation',
    rows.every((r) => CVD_KINDS.every((k) => Number.isFinite(r[k]) && r[k] >= 0)));
  ok('D4 nor a luminance ratio', rows.every((r) => r.ratio >= 1));

  const find = (g, a, b) => rows.find((r) => r.group === g && r.aName === a && r.bName === b);
  ok('D5 the incident priorities are checked', !!find('priority-marker', 'high', 'critical'));
  ok('D6 the patient rings are checked', !!find('condition-ring', 'stable', 'critical'));
  ok('D7 the confidence bar is checked', !!find('confidence-bar', 'high', 'mid'));
  ok('D7b and the chips separately from it', !!find('chip-status', 'good', 'warn'));
  ok('D8 the crew tints are checked', !!find('crew-tint', 'you', 'partner'));
  ok('D8b all four of them, which is six pairs and not one',
    ['you/partner', 'you/vol3', 'you/vol4', 'partner/vol3', 'partner/vol4', 'vol3/vol4']
      .every((p) => !!find('crew-tint', p.split('/')[0], p.split('/')[1])));
  ok('D9 the trucks are checked', !!find('apparatus-tint', 'engine', 'rescue'));
  /* ⚠ A NEW SIGNAL COLOUR THAT THE AUDIT DOES NOT KNOW ABOUT IS AN UNAUDITED SIGNAL
     COLOUR. The tanker shipped with a tint no pair in this table had ever been compared
     against, and every assertion here still passed, because the table names its own
     entries. Count against the source of truth instead. */
  const apGroup = SIGNAL_GROUPS.find((g) => g.id === 'apparatus-tint');
  eq('D9b every appliance in the station is in it, not just the ones that existed then',
    Object.keys(apGroup.colours).length, APPARATUS_DEFS.length);
  ok('D9c and each one by its own id',
    APPARATUS_DEFS.every((d) => apGroup.colours[d.id] === d.tint),
    JSON.stringify(APPARATUS_DEFS.filter((d) => apGroup.colours[d.id] !== d.tint).map((d) => d.id)));

  lines.push('      group                pair                     dE00  prot  deut  trit  lum   verdict');
  for (const r of rows) {
    lines.push(`      ${pad(r.group, 20)} ${pad(r.aName + '/' + r.bName, 24)} ` +
      `${lpad(f(r.normal, 1), 5)} ${lpad(f(r.protanopia, 1), 5)} ${lpad(f(r.deuteranopia, 1), 5)} ` +
      `${lpad(f(r.tritanopia, 1), 5)} ${lpad(f(r.ratio, 2), 5)}  ${r.verdict}`);
  }

  // the calibration the threshold is anchored on
  const crew = find('crew-tint', 'you', 'partner');
  gt('D10 the pair nobody confuses clears the threshold', crew.worst, SIGNAL_DELTA_E);
  /* The palette that was REPLACED. These are still measurements of real colour science
     and they are the reason the live set looks the way it does, so they stay asserted —
     what changed is that they now describe history rather than the game. PROPOSED.from
     is the record of what the audit found. */
  const was = (id) => PROPOSED.find((p) => p.id === id).from;
  const oldPri = was('priority-marker');
  const hc = distinguishable(oldPri.high, oldPri.critical);
  lt('D11 the palette that was replaced put high and critical below the threshold',
    hc.worst, SIGNAL_DELTA_E);
  lt('D12 with too little lightness to fall back on', hc.ratio, LUM_ESCAPE_RATIO);
  ok('D13 so those two were not distinguishable', !hc.ok, hc.verdict);
  /* The measurement's own surprise, and the reason this suite exists: the deficiency
     that breaks the amber-to-red family is TRITANOPIA, not either red-green one. The
     three priorities are separated almost entirely along b*, which is the axis a
     tritanope loses; a greyscale eyeball test passes all three. */
  eq('D14 and the deficiency that broke it was tritanopia, not deuteranopia', hc.worstKind, 'tritanopia');
  lt('D14b more than twice as bad for a tritanope', hc.tritanopia, hc.deuteranopia / 2);
  const oldRing = was('condition-ring');
  lt('D15 the old ring put a stable casualty and an injured one below the threshold',
    distinguishable(oldRing.stable, oldRing.injured).worst, SIGNAL_DELTA_E);
  lt('D16 and a stable one against a dying one',
    distinguishable(oldRing.stable, oldRing.critical).worst, SIGNAL_DELTA_E);

  /* And the palette that is live now. Same measurement, same threshold, opposite answer:
     this is what the milestone was for, so it is asserted pair by pair rather than
     summarised into one number that could hide a regression in any single pair. */
  gt('D17 the priorities that shipped clear it — high vs critical',
    find('priority-marker', 'high', 'critical').worst, SIGNAL_DELTA_E);
  gt('D17b routine vs high', find('priority-marker', 'routine', 'high').worst, SIGNAL_DELTA_E);
  gt('D17c and the call list uses the same set',
    find('priority-list', 'routine', 'high').worst, SIGNAL_DELTA_E);
  gt('D18 the rings that shipped clear it — stable vs injured',
    find('condition-ring', 'stable', 'injured').worst, SIGNAL_DELTA_E);
  gt('D18b stable vs critical', find('condition-ring', 'stable', 'critical').worst, SIGNAL_DELTA_E);
  gt('D18c injured vs critical', find('condition-ring', 'injured', 'critical').worst, SIGNAL_DELTA_E);
  gt('D18d and critical vs unconscious, the pair a first attempt at this broke',
    find('condition-ring', 'critical', 'unconscious').worst, SIGNAL_DELTA_E);
  ok('D18e every one of the ten ring pairs clears it',
    rows.filter((r) => r.group === 'condition-ring').every((r) => r.ok));

  ok('D19 distinguishable() is symmetric',
    Math.abs(distinguishable('#c0392b', '#e67e22').worst
      - distinguishable('#e67e22', '#c0392b').worst) < 1e-9);
  eq('D19b a colour against itself collapses', distinguishable('#ffab3d', '#ffab3d').verdict, 'collapses');

  // the honest half: colour that is the ONLY carrier vs colour that is decoration
  const failures = signalFailures();
  const warn = signalWarnings();
  eq('D20 no signal carried by colour ALONE is left below the threshold', failures.length, 0);
  ok('D20b and the three groups that were are now carried by more than colour',
    ['priority-marker', 'priority-list', 'condition-ring']
      .map((id) => SIGNAL_GROUPS.find((g) => g.id === id).carrier)
      .every((c) => c !== 'colour-only' && c.indexOf('+') > 0));
  ok('D21 the radio log, which also says what happened in words, is only a warning',
    !failures.some((r) => r.group === 'radio-kind') && warn.some((r) => r.group === 'radio-kind'));
  ok('D22 the condition BAR is a length as well as a colour, so it is a warning too',
    !failures.some((r) => r.group === 'condition-bar'));
  lines.push(`      ${failures.length} genuine failures, ${warn.length} warnings, ` +
    `${rows.length - failures.length - warn.length} clear`);
  for (const r of warn) {
    lines.push(`      WARN   ${pad(r.group + ' ' + r.aName + '/' + r.bName, 40)} ` +
      `worst dE00 ${f(r.worst, 1)} (${r.worstKind}), lightness ${f(r.ratio, 2)}:1  — ${r.where}`);
  }

  // the two files do not even agree with each other about the same three priorities
  const marker = SIGNAL_GROUPS.find((g) => g.id === 'priority-marker').colours;
  const list = SIGNAL_GROUPS.find((g) => g.id === 'priority-list').colours;
  /* They used to disagree — #ffab3d against #ffa726 and #ff5a5a against #ff5252 — so the
     call in the list and the marker over that same call were not quite the same colour. */
  eq('D23 canvas and CSS agree on the hex for "high"', marker.high, list.high);
  eq('D24 and on "critical"', marker.critical, list.critical);

  /* The same three-step signal exists twice, and on "bad" the two deliberately disagree.
     --bad moved from #e06a5a to #f0928a to get a chip label from 2.90:1 to 5.17:1: the
     chip is small text ON the colour, so contrast is what it needs. The confidence bar is
     the other shape — a block of colour with its word BESIDE it — and what it needs is
     separation between its three steps, which the lighter red destroys (warn/bad 9.5 ->
     3.2 dE00, amber and red the same bar at a glance).

     This is pinned rather than fixed because "fixing" it means picking one red for two
     jobs, and the measurement below is what that would cost. D23/D24 caught the version
     of this split that was an ACCIDENT; this is the version that is a decision, and the
     difference between the two is written down in src/ui/hud.js. */
  const conf = SIGNAL_GROUPS.find((g) => g.id === 'confidence-bar').colours;
  const chip = SIGNAL_GROUPS.find((g) => g.id === 'chip-status').colours;
  eq('D25 the confidence bar and the chips agree on "good"', conf.high, chip.good);
  eq('D25b and on "warn"', conf.mid, chip.warn);
  ok('D25c and deliberately differ on "bad" - contrast on the chip, separation on the bar',
    conf.low !== chip.bad, `${conf.low} vs ${chip.bad}`);
  gt('D25d the bar keeps the step separation the chip gave up',
    deltaE(conf.mid, conf.low), deltaE(chip.warn, chip.bad));
  ok('D25e and hud.js says why, so the next tidy-up does not undo it',
    /NOT --bad, on purpose/.test(readSource('hud.js')));
  lines.push(`      by design: bar low=${conf.low} (warn/bad dE00 ${f(deltaE(conf.mid, conf.low), 1)}), ` +
    `chip bad=${chip.bad} (warn/bad dE00 ${f(deltaE(chip.warn, chip.bad), 1)})`);

  /* And the price of that move, stated rather than buried. Lightening --bad from #e06a5a
     to #f0928a bought the chip label 2.90:1 -> 5.17:1, and cost the chip COLOUR its
     separation: good/bad fell from 11.1 to 4.2 and warn/bad from 9.5 to 3.2. That is an
     acceptable trade only because a chip always says "damage 40%" in words next to the
     colour — which is exactly what `carrier` records. It would not be acceptable on the
     confidence bar, and the confidence bar is the one that did not move. */
  const oldBad = distinguishable('#e06a5a', '#7fd17f').worst;
  const newBad = distinguishable(chip.bad, chip.good).worst;
  lt('D26 lightening --bad cost the chips their colour separation', newBad, oldBad);
  lt('D26b enough to drop good/bad below the signal threshold', newBad, SIGNAL_DELTA_E);
  gt('D26c which the old hex cleared', oldBad, SIGNAL_DELTA_E);
  ok('D26d acceptable only because a chip carries its value in words',
    SIGNAL_GROUPS.find((g) => g.id === 'chip-status').carrier.includes('text'));
  lines.push(`      --bad #e06a5a -> ${chip.bad}: chip label 2.90:1 -> 5.17:1, ` +
    `good/bad dE00 ${f(oldBad, 1)} -> ${f(newBad, 1)} (text carries it)`);

  /* ── the crew, the one signal with nothing but colour under it ──────────────────
   *
   * Two tints is one pair, and one pair is the easiest colour problem there is — it is
   * the pair SIGNAL_DELTA_E was calibrated on, at 46.7. Four tints is SIX pairs, and six
   * is where a palette stops being a matter of taste: every colour has to clear every
   * other one under three simulations at once, and there is only so much gamut.
   *
   * The set reached for first is the exact shape of failure this suite exists to catch. A
   * lime and a pink beside the gold and the cyan look like four obviously different
   * things. Three of their six pairs collapse. */
  const crewNow = SIGNAL_GROUPS.find((g) => g.id === 'crew-tint').colours;
  const crewWas = PROPOSED.find((p) => p.id === 'crew-tint').from;
  const crewRows = rows.filter((r) => r.group === 'crew-tint');
  eq('D27 four crew members is six pairs, and all six are audited', crewRows.length, 6);
  ok('D27b every one of the six clears the threshold under all three simulations',
    crewRows.every((r) => r.ok && r.worst >= SIGNAL_DELTA_E),
    crewRows.filter((r) => r.worst < SIGNAL_DELTA_E)
      .map((r) => `${r.aName}/${r.bName} ${f(r.worst, 1)}`).join(','));
  ok('D27c and in normal vision as well, which `worst` does not cover',
    crewRows.every((r) => r.normal >= SIGNAL_DELTA_E));
  ok('D27d none of them is leaning on lightness to escape a hue that collapsed',
    crewRows.every((r) => r.verdict === 'ok'), crewRows.map((r) => r.verdict).join(','));

  /* What the eye picked, measured. These are not hypotheticals: they are the hexes that
     were in src/data/crew.js when this was written, and the reason the search happened. */
  const wasPair = (a, b) => distinguishable(crewWas[a], crewWas[b]);
  const wasLime = wasPair('you', 'vol3'), wasPink = wasPair('you', 'vol4');
  lt('D27e the lime picked by eye IS the player own gold to a deuteranope',
    wasLime.worst, SIGNAL_DELTA_E);
  eq('D27f and the deficiency it dies on is deuteranopia, not the tritanopia the ambers died on',
    wasLime.worstKind, 'deuteranopia');
  lt('D27g with no lightness underneath it to escape by', wasLime.ratio, LUM_ESCAPE_RATIO);
  lt('D27h the pink collapses against that same gold too', wasPink.worst, SIGNAL_DELTA_E);
  eq('D27i — that one for a tritanope, so no single simulation would have found both',
    wasPink.worstKind, 'tritanopia');
  const wasNames = Object.keys(crewWas);
  const wasBroken = [];
  for (let i = 0; i < wasNames.length; i++) {
    for (let j = i + 1; j < wasNames.length; j++) {
      if (!wasPair(wasNames[i], wasNames[j]).ok) wasBroken.push(`${wasNames[i]}/${wasNames[j]}`);
    }
  }
  eq('D27j three of its six pairs collapsed, including the one that says which is me',
    wasBroken.join(','), 'you/vol3,you/vol4,partner/vol4');

  /* WHY the replacement works, stated as structure rather than as luck: two tiers of two.
     The pairs WITHIN a tier — you/partner at L* 82 and 78, vol3/vol4 at 59 and 60 — have
     no lightness to fall back on and are carried entirely by hue, which is affordable
     twice. The four pairs ACROSS the tiers have 18 to 23 points of L* under them, and
     lightness is the one channel all three deficiencies keep. Four hues on one tier would
     be six of the first kind and no second chances anywhere. */
  const Ls = Object.values(crewNow).map((c) => toLab(c).L);
  gt('D27k the four are spread over lightness and not only hue', Math.max(...Ls) - Math.min(...Ls), 20);
  const withinTier = [find('crew-tint', 'you', 'partner'), find('crew-tint', 'vol3', 'vol4')];
  ok('D27l the two within-tier pairs are carried by hue alone',
    withinTier.every((r) => r.ratio < LUM_PARTIAL_RATIO));
  ok('D27m and every across-tier pair has lightness under it as well',
    crewRows.filter((r) => !withinTier.includes(r)).every((r) => r.ratio >= LUM_PARTIAL_RATIO));

  /* The constraint that shaped the palette, asserted where it can be seen rather than
     left in a comment. hud.js statusFor paints each crew member's NAME in that crew
     member's tint, 11px bold — below WCAG's 18.66px "large" line, so it needs the full
     4.5:1 on the pill plate over the palest roof in town. That is L* 57, and it is the
     reason vol3 and vol4 stop at 59 and 60 instead of going darker to buy separation.
     A signal colour that is also text cannot be chosen on separation alone. */
  const whoRows = auditText().filter((r) => r.id.indexOf('who-') === 0);
  eq('D27n each of the four is audited as text as well as a mark', whoRows.length, 4);
  ok('D27o and every one clears AA at 11px bold over the palest roof in the town',
    whoRows.every((r) => r.pass && r.need === 4.5),
    whoRows.filter((r) => !r.pass).map((r) => `${r.id} ${f(r.ratio)}`).join(','));
  gt('D27p the darkest of them clears it on merit, not on a rounding',
    Math.min(...whoRows.map((r) => r.ratio)), 4.6);

  /* CROSS-GROUP. This suite asserts within a group and not between groups, and that is a
     decision rather than an oversight: with twenty-five signal colours in one town, some
     pair of them collapses under some deficiency no matter what is done — the player's own
     #f6c445 is 3.5 dE00 from a live gas meter for a protanope and was before the crew was
     four. What CAN honestly be asked of a crew tint is that it not read as a truck or a
     casualty in normal vision, where the player is doing the telling apart and where the
     shapes differ anyway. So: reported, with one assertion, and that assertion is relative
     — no colour added here may sit closer to its neighbourhood than the gold already does. */
  const NEIGHBOUR_GROUPS = ['apparatus-tint', 'condition-ring', 'condition-bar',
    'priority-marker', 'priority-list', 'hydrant', 'gas-meter', 'siren-bar'];
  const nearestNeighbour = (hex) => {
    let best = { id: '', hex: '', d: Infinity };
    for (const g of SIGNAL_GROUPS) {
      if (NEIGHBOUR_GROUPS.indexOf(g.id) < 0) continue;
      for (const [k, v] of Object.entries(g.colours)) {
        const d = deltaE(hex, v);
        if (d < best.d) best = { id: `${g.id}.${k}`, hex: v, d };
      }
    }
    return best;
  };
  const goldGap = nearestNeighbour(crewNow.you).d;
  gt('D27q neither new tint sits closer to a truck or a casualty than the gold already does',
    Math.min(nearestNeighbour(crewNow.vol3).d, nearestNeighbour(crewNow.vol4).d), goldGap);

  let wasWorst = Infinity;
  for (let i = 0; i < wasNames.length; i++) {
    for (let j = i + 1; j < wasNames.length; j++) {
      wasWorst = Math.min(wasWorst, wasPair(wasNames[i], wasNames[j]).worst);
    }
  }
  lines.push(`      crew ${Object.values(crewWas).join(' ')} -> ${Object.values(crewNow).join(' ')}` +
    `: worst of the six ${f(wasWorst, 1)} -> ${f(Math.min(...crewRows.map((r) => r.worst)), 1)} dE00`);
  lines.push('      crew tint  L*   as text   nearest thing it stands next to (normal vision)');
  for (const [k, v] of Object.entries(crewNow)) {
    const n = nearestNeighbour(v);
    const w = whoRows.find((r) => r.id === `who-${k}`);
    lines.push(`      ${pad(k, 8)} ${v} ${lpad(f(toLab(v).L, 0), 3)}  ${lpad(f(w.ratio), 5)}:1   ` +
      `${pad(n.id, 26)} ${n.hex} ${f(n.d, 1)}`);
  }
}

/* ── E. every text/background pair the HUD renders ───────────────────────── */
function sectionE() {
lines.push('--- E. text contrast ---');
  const rows = auditText();
  eq('E1 every declared pair is audited', rows.length, TEXT_PAIRS.length);
  ok('E2 no pair produced a nonsense ratio', rows.every((r) => Number.isFinite(r.ratio) && r.ratio >= 1));
  ok('E3 and each is measured against the worst real backdrop, not a convenient one',
    rows.filter((p) => TEXT_PAIRS.find((q) => q.id === p.id).over).every((r) => !!r.backdrop));

  lines.push('      id                    fg       bg(worst)  ratio  need  where');
  for (const r of rows) {
    lines.push(`      ${pad(r.id, 21)} ${pad(r.fg, 8)} ${pad(r.bg + (r.backdrop ? '/' + r.backdrop : ''), 10)} ` +
      `${lpad(f(r.ratio), 5)} ${lpad(f(r.need, 1), 5)}  ${r.pass ? '   ' : 'AA!'} ${r.where}`);
  }

  const by = (id) => rows.find((r) => r.id === id);
  gt('E4 the start button is the most readable thing on the page', by('card-button').ratio, 7);
  ok('E5 key caps pass', by('kbd').pass, `${f(by('kbd').ratio)}:1`);
  ok('E6 the call headline passes', by('call-head').pass, `${f(by('call-head').ratio)}:1`);
  ok('E7 the coach line passes', by('coach').pass, `${f(by('coach').ratio)}:1`);

  /* The call headline used to be painted in the priority colour with no plate and no
     halo: drawLabels strokes 3 px of black behind every label it draws, and
     drawIncidentMarkers did not. Measured over the clinic roof it was 1.00:1 — not
     "hard to read", invisible. It is paper-white and haloed now, like every other
     label, and the priority moved to the ring count and a bang on the front. */
  const mr = by('marker-headline');
  ok('E8 the call headline over the town is readable on the palest roof in it',
    mr.pass, `${f(mr.ratio)}:1 on ${mr.backdrop}`);
  gt('E9 — it was 1.00:1 before the halo went behind it', mr.ratio, 4);
  ok('E10 and the off-screen arrow label got the same treatment', by('marker-arrow').pass,
    `${f(by('marker-arrow').ratio)}:1`);
  ok('E11 the building labels, which always had it, still pass', by('label-building').pass,
    `${f(by('label-building').ratio)}:1`);

  /* The siren chip used to fade the WHOLE chip to 35% opacity twice a second, taking its
     label to 2.17:1 at the bottom of every cycle. The keyframe moves the plate now and
     leaves the text alone — and because the trough plate (0.05) is darker than the lit
     one (0.25), the label is measurably MORE readable mid-flash than lit. The animation
     went from costing contrast to adding it. */
  const lit = by('chip-siren'), dim = by('chip-siren-dim');
  gt('E12 the siren chip no longer loses contrast at the bottom of its flash', dim.ratio, lit.ratio);
  ok('E13 and both ends of the cycle pass', dim.pass && lit.pass,
    `lit ${f(lit.ratio)}, trough ${f(dim.ratio)}`);

  /* The seventeen pairs this audit found below AA, locked one by one. A summary count
     would go green again if one were fixed and another broke; naming them will not. */
  const FIXED = ['clock-urgent', 'conf-label', 'conf-word', 'mute-off', 'chip-bad',
    'chip-siren-dim', 'calls-hint', 'prompt-dim', 'slot-from', 'net-or', 'tbtn',
    'tbtn-sub', 'tslot', 'marker-headline', 'marker-arrow'];
  for (const id of FIXED) {
    const r = by(id);
    ok(`E14.${id} clears AA now`, r && r.pass, r ? `${f(r.ratio)}:1 needs ${f(r.need, 1)}` : 'no such pair');
  }

  /* The crew names are the only text in the game painted in a SIGNAL colour, which makes
     them the one place where the two halves of this audit constrain each other: §D27 wants
     the four tints spread as far apart as the gamut allows, and this wants every one of
     them light enough to read at 11px. The second wins, and §D27 says by how much. */
  const who = rows.filter((r) => r.id.indexOf('who-') === 0);
  ok('E16 every crew name clears AA painted in its own tint', who.every((r) => r.pass),
    who.filter((r) => !r.pass).map((r) => `${r.id} ${f(r.ratio)}`).join(','));
  lines.push(`      crew names on the pill over ${who[0] ? who[0].backdrop : '?'}: ` +
    `${who.map((r) => `${r.id.slice(4)} ${f(r.ratio)}:1`).join(', ')} (need 4.5)`);

  const failures = textFailures();
  ok('E15 no failure is a false positive on an opaque card',
    !failures.some((r) => r.id === 'card-body' || r.id === 'card-keys'));
  lines.push(`      ${failures.length} of ${rows.length} text pairs are below their AA floor:`);
  for (const r of failures) {
    lines.push(`      FAILS  ${pad(r.id, 20)} ${f(r.ratio)}:1 (needs ${f(r.need, 1)}) ` +
      `${r.px}px${r.bold ? ' bold' : ''}  ${r.where}  [${r.src}]`);
  }
}

/* ── F. the proposals have to actually work ─────────────────────────────── */
function sectionF() {
lines.push('--- F. the replacement palettes, and that they are what shipped ---');
  gt('F1 the proposals are recorded', PROPOSED.length, 0);
  /* Every group this audit found failing has a proposal, and the proposal is what is now
     in the game — F9 below. The failure list is empty precisely BECAUSE of that, so it
     can no longer be used to look them up; the three ids are named instead. */
  for (const g of ['priority-marker', 'priority-list', 'condition-ring', 'crew-tint']) {
    ok(`F2.${g} has a proposal`, PROPOSED.some((p) => p.id === g));
  }

  for (const p of PROPOSED) {
    const names = Object.keys(p.to);
    let worst = Infinity, worstPair = '';
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = distinguishable(p.to[names[i]], p.to[names[j]]);
        if (d.worst < worst) { worst = d.worst; worstPair = `${names[i]}/${names[j]}`; }
      }
    }
    let wasWorst = Infinity;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = distinguishable(p.from[names[i]], p.from[names[j]]);
        if (d.worst < wasWorst) wasWorst = d.worst;
      }
    }
    lines.push(`      ${pad(p.id, 18)} worst pair ${pad(worstPair, 22)} ` +
      `${f(wasWorst, 1)} -> ${f(worst, 1)} dE00 under the worst simulation`);
    ok(`F3.${p.id} the replacement set survives all three simulations`,
      worst >= SIGNAL_DELTA_E, `worst ${f(worst, 1)} on ${worstPair}`);
    ok(`F4.${p.id} and is no worse than what it replaces`, worst >= wasWorst - 1e-9,
      `${f(wasWorst, 1)} -> ${f(worst, 1)}`);
    ok(`F5.${p.id} names a non-colour redundancy`,
      typeof p.redundancy === 'string' && p.redundancy.length > 20);
    ok(`F6.${p.id} keeps the same set of states`,
      Object.keys(p.from).join() === Object.keys(p.to).join());
  }

  /* The other half of honesty: nothing may be "fixed" that measures fine. The hydrant
     (worst 16.8) and the gas meter (worst 18.3) both look like textbook red-green traps
     and both clear the threshold, so neither gets a proposal. */
  const changed = PROPOSED.filter((p) => Object.keys(p.to).some((k) => p.to[k] !== p.from[k]));
  ok('F6b every recolour answers a failure this audit measured',
    changed.every((p) => ['priority-marker', 'priority-list', 'condition-ring', 'crew-tint'].includes(p.id)),
    changed.map((p) => p.id).join(','));
  ok('F6c and a group that measures fine is left alone',
    !PROPOSED.some((p) => p.id === 'hydrant' || p.id === 'gas-meter'));

  /* THE REGRESSION LOCK. A proposal that is not in the game is a document; a proposal
     asserted to BE the game is a test. If anybody nudges a hex back towards the set that
     collapsed, this is where it is caught. */
  for (const p of changed) {
    const live = SIGNAL_GROUPS.find((g) => g.id === p.id).colours;
    const same = Object.keys(p.to).every((k) => live[k] === p.to[k]);
    ok(`F9.${p.id} the palette in the game is the palette that was proven`, same,
      Object.keys(p.to).map((k) => `${k} ${live[k]} vs ${p.to[k]}`).join(', '));
  }

  /* THE LOCK ON THE CREW, which goes one step further than F9.
   *
   * F9 asserts that a11y.js's own table matches a11y.js's own proposal: it catches the
   * audit disagreeing with itself. That is not enough for a palette that has been proven
   * but not yet pasted in, because both halves of the audit can agree perfectly while the
   * game paints something else entirely. This reads src/data/crew.js over http and pulls
   * the four `tint:` hexes straight out of the CREW literal — so it catches the GAME
   * disagreeing with the audit: a wrong hex, the right hexes in the wrong order (which
   * paints the player as a volunteer), or a fifth crew member nobody measured.
   *
   * It is RED until the proven palette is in the file, and the failure message is the
   * paste. That is deliberate: a proven palette sitting in a11y.js while the game ships
   * a set with three collapsing pairs is precisely the lie this suite exists to prevent,
   * and it should be impossible to leave it that way and still see a green run. */
  const crewProven = Object.values(PROPOSED.find((p) => p.id === 'crew-tint').to);
  const crewShipped = crewTintsInSource();
  /* The detail is the edit, not a diagnosis: only the seats that differ, named by the id
     the game uses for them, short enough to survive on one line of a console that is being
     grepped for FAIL. A failure nobody can act on from the failure line is half a test. */
  const crewDiff = crewShipped == null ? ['no CREW literal in src/data/crew.js']
    : crewProven.map((h, i) => (crewShipped[i] === h ? null : `r${i + 1} ${crewShipped[i] || '(missing)'} -> ${h}`))
      .filter((s) => s !== null);
  if (crewShipped && crewShipped.length !== crewProven.length) {
    crewDiff.push(`crew.js declares ${crewShipped.length} tints, ${crewProven.length} were measured`);
  }
  ok('F10 the four tints in crew.js are the four that were proven',
    crewDiff.length === 0, crewDiff.join(', '));
  ok('F10b and game.js still re-exports CREW, so every existing caller keeps working',
    /export\s*\{[^}]*\bCREW\b[^}]*\}\s*from\s*'\.\/data\/crew\.js'/.test(readSource('game.js')));
  lines.push(`      crew.js tints:  ${(crewShipped || ['(none)']).join(' ')}`);
  lines.push(`      proven palette: ${crewProven.join(' ')}`);

  // the point of the exercise: lightness, not hue, is what carries through
  const pri = PROPOSED.find((p) => p.id === 'priority-marker');
  const ls = Object.values(pri.to).map((c) => toLab(c).L).sort((a, b) => a - b);
  gt('F7 the proposed priorities are spread over lightness', ls[2] - ls[0], 40);
  lines.push(`      proposed priority L*: ${ls.map((v) => f(v, 0)).join(' / ')}`);
  const ring = PROPOSED.find((p) => p.id === 'condition-ring');
  gt('F8 as are the proposed casualty rings',
    toLab(ring.to.stable).L - toLab(ring.to.critical).L, 40);
}

/* ── G. motion ──────────────────────────────────────────────────────────── */
function sectionG() {
lines.push('--- G. reduced motion ---');
  const win = (matches) => ({ matchMedia: (q) => ({ matches: q.includes('reduced-motion') && matches }) });
  ok('G1 a player who asked for less movement is detected', prefersReducedMotion(win(true)));
  ok('G2 one who did not, is not', !prefersReducedMotion(win(false)));
  ok('G3 a window with no matchMedia answers no rather than throwing',
    prefersReducedMotion({}) === false);
  ok('G4 and so does one whose matchMedia throws',
    prefersReducedMotion({ matchMedia() { throw new Error('nope'); } }) === false);
  ok('G5 the query asked for is the standard one',
    (() => { let q = null; prefersReducedMotion({ matchMedia: (s) => { q = s; return { matches: false }; } });
      return q === '(prefers-reduced-motion: reduce)'; })());

  eq('G6 the full scalars are handed to a normal window', motionScalars(win(false)), MOTION_FULL);
  eq('G7 and the damped set to one that asked', motionScalars(win(true)), MOTION_REDUCED);
  ok('G8 every animation has a scalar in both sets',
    Object.keys(MOTION_FULL).every((k) => k in MOTION_REDUCED));
  ok('G9 full means untouched', Object.values(MOTION_FULL).every((v) => v === 1));
  ok('G10 reduced never amplifies anything',
    Object.keys(MOTION_FULL).every((k) => MOTION_REDUCED[k] <= MOTION_FULL[k]));
  ok('G11 and every animation in the renderer has a scalar named after it',
    ANIMATION_RATES.every((r) => r.id in MOTION_FULL));

  near('G12 damping by 1 changes nothing', dampen(0.83, 0.5, 1), 0.83, 1e-12);
  near('G13 damping by 0 holds the middle', dampen(0.83, 0.5, 0), 0.5, 1e-12);
  near('G14 and half-way is half-way', dampen(1, 0.5, 0.5), 0.75, 1e-12);

  /* The rule that matters: damping must never make anything BRIGHTER or dimmer than it
     already got. A "reduced motion" setting that pushed the fire outside its normal
     range would be a new visual bug, not an accessibility feature. */
  let outOfRange = 0, minR = 1, maxR = 0;
  for (let i = 0; i < 240; i++) {
    const t = i * 0.037;
    const full = pulse01(t, 0.6366, 1);
    const red = pulse01(t, 0.6366, MOTION_REDUCED.markerPulse);
    if (red < -1e-9 || red > 1 + 1e-9) outOfRange++;
    minR = Math.min(minR, red); maxR = Math.max(maxR, red);
    if (full < -1e-9 || full > 1 + 1e-9) outOfRange++;
  }
  eq('G15 a damped pulse never leaves the range it damped', outOfRange, 0);
  near('G16 the marker pulse stops dead but stays visible at mid-brightness', minR, 0.5, 1e-9);
  near('G17 (and does not drift)', maxR, 0.5, 1e-9);

  let hi = 0, lo = 1;
  for (let i = 0; i < 240; i++) { const v = pulse01(i * 0.013, 0.6366, 1); hi = Math.max(hi, v); lo = Math.min(lo, v); }
  gt('G18 at full strength it still swings', hi - lo, 0.9);

  let alwaysOn = true, onCount = 0;
  for (let i = 0; i < 400; i++) {
    if (!blinkOn(i * 0.01, 1.9099, 0)) alwaysOn = false;
    if (blinkOn(i * 0.01, 1.9099, 1)) onCount++;
  }
  ok('G19 a damped siren stops flashing but stays lit', alwaysOn);
  near('G20 an undamped one is lit half the time', onCount / 400, 0.5, 0.03);

  const rate = (id) => ANIMATION_RATES.find((r) => r.id === id);
  near('G21 the siren lightbar is measured at 1.91 flashes/sec', rate('sirenBlink').hz, 1.9099, 0.001);
  near('G22 the incident marker at 0.64', rate('markerPulse').hz, 0.6366, 0.001);
  /* The stun ring was `abs(sin(t*14))`. abs() doubles the flash rate, so what reads in
     source like a 2.2 Hz wobble was 4.46 flashes a second — the only thing in the game
     over WCAG 2.3.1's three-per-second line. At t*6 it is 1.91, the same rate as the
     siren, and it is now damped by a scalar on top of that. */
  near('G23 the stun ring is 1.91 flashes/sec now, not 4.46', rate('stunFlash').hz, 1.9099, 0.001);
  lt('G23b comfortably under the threshold', rate('stunFlash').hz, FLASH_THRESHOLD_HZ);
  near('G24 the CSS siren chip at 1.67', rate('chipFlash').hz, 1.6667, 0.001);

  const haz = flashHazards();
  eq('G25 nothing in the game exceeds the 3 Hz flash threshold any more', haz.length, 0,
    haz.map((r) => `${r.id} ${f(r.hz, 2)}Hz`).join(','));
  ok('G26 every rate, including the doubled abs() ones, is under it',
    ANIMATION_RATES.every((r) => Math.max(r.hz, r.hz2 || 0) <= FLASH_THRESHOLD_HZ));
  gt('G27 and the fastest thing left has real headroom under the line',
    FLASH_THRESHOLD_HZ - Math.max(...ANIMATION_RATES.map((r) => Math.max(r.hz, r.hz2 || 0))), 0.5);
  lines.push('      measured flash rates (Hz):');
  for (const r of ANIMATION_RATES) {
    lines.push(`      ${pad(r.id, 18)} ${lpad(f(r.hz, 3), 6)}${r.hz2 ? ' + ' + f(r.hz2, 3) : ''}` +
      `   ${pad(r.expr, 22)} ${r.wired === true ? 'damped' : r.wired === 'css' ? 'css   ' : 'UNWIRED'}` +
      `  ${r.src}`);
  }
}

/* ── H. the audit is reading the real files ─────────────────────────────── */
const SOURCES = {
  'styles.css': 'styles.css',
  'renderer.js': 'src/render/renderer.js',
  'hud.js': 'src/ui/hud.js',
  'game.js': 'src/game.js',
  // The crew table left game.js for its own data module the moment protocol.js needed a
  // third volunteer's colour; game.js re-exports it, so every `src` that said game.js CREW
  // had stopped naming the file the hexes are actually in. H22 pins the move itself.
  'crew.js': 'src/data/crew.js',
  'equipment.js': 'src/data/equipment.js',
};
const _cache = {};
/** Synchronous on purpose: the suite emits after every section, and an await would
 *  reorder that against the DOM dump the harness greps. */
function readSource(name) {
  if (_cache[name] != null) return _cache[name];
  const x = new XMLHttpRequest();
  x.open('GET', SOURCES[name], false);
  x.send(null);
  _cache[name] = x.status === 200 || x.status === 0 ? x.responseText : '';
  return _cache[name];
}

/**
 * The four `tint:` hexes inside the CREW literal in src/data/crew.js, in crew order.
 *
 * Order and count are read, not just membership: "the four hexes are all somewhere in the
 * file" would go green on a palette pasted in the wrong order, which paints the player as
 * a volunteer, and on a fifth crew member whose colour nobody measured.
 */
function crewTintsInSource() {
  const m = readSource('crew.js').match(/export const CREW = Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  return (m[1].match(/tint:\s*'#[0-9a-fA-F]{6}'/g) || [])
    .map((s) => s.slice(s.indexOf('#'), s.indexOf('#') + 7).toLowerCase());
}

function sectionH() {
lines.push('--- H. every colour in the audit came out of the game ---');
  const css = readSource('styles.css');
  const rnd = readSource('renderer.js');
  gt('H1 styles.css was readable', css.length, 1000);
  gt('H2 renderer.js was readable', rnd.length, 1000);

  let missing = [];
  for (const [k, v] of Object.entries(CSS_TOKENS)) if (!css.includes(v)) missing.push(`${k}=${v}`);
  eq('H3 every :root token in the audit is in styles.css', missing.join(','), '');
  missing = [];
  for (const [k, v] of Object.entries(PLATES)) if (!css.includes(v)) missing.push(`${k}=${v}`);
  eq('H4 every translucent plate colour too', missing.join(','), '');

  missing = [];
  for (const [k, v] of Object.entries(CANVAS_BACKDROPS)) {
    if (!css.includes(v) && !rnd.includes(v)) missing.push(`${k}=${v}`);
  }
  eq('H5 and every backdrop the town paints', missing.join(','), '');

  /* Each signal colour must be in the file its `src` names — and, when the src carries
     an ANCHOR rather than a line span, near that anchor rather than merely somewhere in
     the file. "#6b6b6b is in renderer.js" is nearly worthless: it is both the dead
     hydrant and the lost casualty's ring. "#6b6b6b is inside drawVictim" is a fact.
     A rule may of course name a token instead of a hex, so var(--good) counts as
     carrying #7fd17f. */
  /* "Near the anchor" means, for JS, INSIDE the thing the anchor names: every occurrence
     is sliced forward to the next method at this file's two-space class indent. A fixed
     character window cannot work here — drawVictim's colours sit under a nine-line
     comment and drawApparatus is seventy lines long — and widening the window until both
     fit would have made the check meaningless. CSS rules are short, so those keep a
     window. */
  const slices = (text, anchor, isJs) => {
    const out = [];
    let i = text.indexOf(anchor);
    while (i >= 0) {
      const rest = text.slice(i);
      if (!isJs) out.push(rest.slice(0, 500));
      else {
        const end = rest.slice(1).search(/\n {2}[A-Za-z_$][\w$]*\(/);
        out.push(end >= 0 ? rest.slice(0, end + 1) : rest.slice(0, 4000));
      }
      i = text.indexOf(anchor, i + 1);
    }
    return out;
  };
  const near1 = (text, anchor, needle, isJs) => {
    if (!anchor) return text.includes(needle);
    return slices(text, anchor, isJs).some((s) => s.includes(needle));
  };
  const carries = (text, anchor, hex, isJs) => near1(text, anchor, hex, isJs)
    || (CSS_VAR_NAMES[hex] && near1(text, anchor, `var(${CSS_VAR_NAMES[hex]})`, isJs));

  missing = [];
  let anchored = 0;
  for (const g of SIGNAL_GROUPS) {
    /* crew-tint is checked by F10 instead, and checked harder. F10 reads the four `tint:`
       hexes out of the CREW literal in src/data/crew.js IN ORDER, so it also catches the
       right hexes pasted in the wrong order — which paints the player as a volunteer — and
       a fifth crew member nobody measured; "the hex turns up somewhere near the anchor"
       sees neither. Nothing is lost by not doing it twice: F9 pins SIGNAL_GROUPS to
       PROPOSED.to and F10 pins crew.js to the same, so the two ends still meet.
       It is also the one group whose table is allowed to disagree with the game for a
       while — it holds a proven replacement palette, and F10 is the line that stays red
       until that palette is applied. Reporting that here as well would turn one fact into
       two failures that read like two problems. */
    if (g.id === 'crew-tint') { anchored++; continue; }
    const { file, anchor } = parseSrc(g.src);
    const text = file && SOURCES[file] ? readSource(file) : '';
    const isJs = !!file && file.endsWith('.js');
    if (anchor) anchored++;
    for (const [k, v] of Object.entries(g.colours)) {
      if (!text.includes(v)) missing.push(`${g.id}.${k}=${v} not in ${file}`);
      else if (!carries(text, anchor, v, isJs)) missing.push(`${g.id}.${k}=${v} not near "${anchor}"`);
    }
  }
  eq('H6 every signal colour is where the audit says it is', missing.join(' | '), '');
  gt('H6b and most of them are pinned to an anchor, not a line number that rots',
    anchored, SIGNAL_GROUPS.length / 2);
  ok('H6c parseSrc reads both forms',
    parseSrc('styles.css:90-92').lines === '90-92'
    && parseSrc('renderer.js drawVictim').anchor === 'drawVictim'
    && parseSrc('styles.css .chip.good').file === 'styles.css');

  /* And the text pairs, whose fg colours are quoted from styles.css or renderer.js.
     A colour that is ALSO a signal colour is skipped: the check above is the more specific
     claim about it, and running both turns one drifted hex into two failures that look
     like two problems. The crew names are what made this worth saying — they are painted
     in the crew member's own tint, so each of them is a signal colour first and text
     second, and §D27 is where the two constraints on it are reconciled. */
  const signalHexes = {};
  for (const g of SIGNAL_GROUPS) for (const v of Object.values(g.colours)) signalHexes[v] = g.id;
  missing = [];
  let alsoSignal = 0;
  for (const p of TEXT_PAIRS) {
    if (signalHexes[p.fg]) { alsoSignal++; continue; }
    const { file } = parseSrc(p.src);
    const text = file && SOURCES[file] ? readSource(file) : '';
    if (!text.includes(p.fg) && !css.includes(p.fg)) missing.push(`${p.id}=${p.fg} (${p.src})`);
  }
  eq('H7 every text colour is in the game as well', missing.join(','), '');
  gt('H7b and the ones that are signal colours too were checked as signals', alsoSignal, 3);

  /* The animation rates are read off real expressions.
   *
   * These three used to pin the numbers the audit was written against; the audit's
   * findings have since been APPLIED, so they now pin the fix instead. The siren and
   * the marker kept their rates and went through the damping helpers; the stun ring was
   * the one animation above WCAG 2.3.1's three-flashes-a-second — 14 rad/s through an
   * abs() is 4.46 Hz — and is now 6 rad/s, which is 1.91. */
  ok('H8 the siren blink goes through the damper, at the rate it always had',
    rnd.includes('blinkOn(t, 1.9099'));
  ok('H9 and so does the marker pulse', rnd.includes('pulse01(t, 0.6366'));
  ok('H10 the stun ring is no longer over the flash threshold',
    rnd.includes('Math.abs(Math.sin(t * 6))') && !rnd.includes('Math.abs(Math.sin(t * 14))'));
  ok('H11 the fire flicker is still wobble(i,t,8)', rnd.includes('wobble(i, t, 8)'));
  ok('H12 the chip flash is still a 0.6s two-step', css.includes('animation: flash .6s steps(2, end)'));
  // the comment at renderer.js:70 says the word, so match the CALL and not the prose
  ok('H13 and the renderer still calls no Math.random', !/Math\.random\(/.test(rnd));

  /* Reduced motion is only honoured where the renderer actually READS the scalar. A
     scalar declared in a11y.js and never consumed is worse than no scalar: it reads like
     the work is done. ANIMATION_RATES carries a `wired` column, H20 proves that column
     is not lying, and H21 is the outstanding work. */
  const unwired = ANIMATION_RATES.filter((r) => r.wired === true
    && !rnd.includes(`this.motion.${r.id}`));
  eq('H20 every animation this table calls damped really does read its scalar',
    unwired.map((r) => r.id).join(','), '');
  const notWired = ANIMATION_RATES.filter((r) => r.wired === false);
  eq('H21 and nothing is left moving at full strength for a player who asked for less',
    notWired.map((r) => `${r.id} (${r.src})`).join(', '), '');
  ok('H21b the ones that are wired outnumber the ones that are not',
    ANIMATION_RATES.filter((r) => r.wired === true).length > notWired.length);

  // the phone breakpoint and the sizes claimed inside it
  ok('H14 the phone breakpoint covers a landscape phone as well as a narrow one',
    css.includes('@media (max-width: 700px), (max-height: 480px)'));
  ok('H14b and isPhoneLayout implements both clauses, not just the width one',
    isPhoneLayout(1280, 400) && isPhoneLayout(390, 844) && !isPhoneLayout(1280, 720));
  ok('H15 the radio log is no longer 10px on a phone',
    !/#radio\s*\{[^}]*font-size:\s*10px/.test(css) && /#radio[^}]*font-size:\s*12px/.test(css));
  ok('H16 and the thumb-button sublabel has a pixel floor under the vmin',
    css.includes('max(11px, 2.1vmin)'));
  ok('H16b as does the touch equipment row', css.includes('max(12px, 2.6vmin)'));
  ok('H16c the touch plates are opaque enough to read a label on',
    css.includes('rgba(12,20,28,0.75)'));
  ok('H16d and the siren chip flashes its plate, not its text',
    /@keyframes flash \{[^}]*background:/.test(css) && !/@keyframes flash \{[^}]*opacity:/.test(css));
  ok('H17 the incident headline is haloed like every other label now',
    /drawIncidentMarkers[\s\S]{0,3200}?strokeText\(tag \+ inc\.headline/.test(rnd));
  ok('H18 with the same 3px black halo drawLabels uses',
    /strokeStyle = 'rgba\(0,0,0,0\.62\)';\s*ctx\.strokeText/.test(rnd));
  ok('H19 the game honours prefers-reduced-motion, in CSS and on the canvas',
    css.includes('prefers-reduced-motion') && rnd.includes('motionScalars'));

  /* The crew table moved out of game.js while this audit was being written, and every
     `src` that said "game.js CREW" quietly stopped naming the file the hexes are in —
     H6 kept passing on a stale pointer only because game.js re-exports the name, not the
     literals. Pin the move: where the table lives, and the property that made it a
     separate module at all. crew.js importing anything is the import cycle coming back. */
  const crewSrc = readSource('crew.js');
  gt('H22 src/data/crew.js was readable', crewSrc.length, 200);
  ok('H22b it holds the CREW literal itself, not a re-export',
    /export const CREW = Object\.freeze\(\[/.test(crewSrc));
  ok('H22c and imports nothing, which is the whole reason it is its own module',
    !/^\s*import\s/m.test(crewSrc));
  ok('H22d the crew-tint group points at that file and not at game.js',
    parseSrc(SIGNAL_GROUPS.find((g) => g.id === 'crew-tint').src).file === 'crew.js');
}

/* ── I. text size ───────────────────────────────────────────────────────── */
function sectionI() {
lines.push('--- I. text size ---');
  ok('I1 a 390x844 phone is the phone layout', isPhoneLayout(390, 844));
  ok('I2 a 1280x720 desktop is not', !isPhoneLayout(1280, 720));
  ok('I3 nor is a wide window — until it is short', !isPhoneLayout(1280, 500) && isPhoneLayout(1280, 480));

  const radio = FONT_SIZES.find((e) => e.id === 'radio');
  eq('I4 the radio log is 11.5px on a desktop', resolvedPx(radio, 1280, 720), 11.5);
  eq('I5 and 12px on a phone, where it used to shrink to 10', resolvedPx(radio, 390, 844), 12);
  /* The vmin trap, and the shape that fixes it. 2.1vmin alone was 15.1px on the desktop
     it was written on and 8.2px on a 390px phone — the smallest text in the game, and
     invisible to anybody testing in a desktop window. max(11px, 2.1vmin) keeps the
     scaling on a big screen and puts a floor under it on a small one. */
  const sub = FONT_SIZES.find((e) => e.id === 'tbtn-sub');
  eq('I6 the sublabel floor holds it at 11px on a 390px phone, not 8.2', resolvedPx(sub, 390, 844), 11);
  near('I7 while a desktop still gets the vmin size', resolvedPx(sub, 1280, 720), 15.12, 0.01);
  gt('I7b so the floor only ever raises, never lowers',
    resolvedPx(sub, 1280, 720), resolvedPx(sub, 390, 844));
  eq('I7c and the equipment row has one too', resolvedPx(FONT_SIZES.find((e) => e.id === 'tslot'), 390, 844), 12);
  eq('I8 a rule the phone hides is not counted', resolvedPx(FONT_SIZES.find((e) => e.id === 'slots'), 390, 844), null);

  /* The phone no longer holds the record. With the floors in place, the smallest text in
     the game is the same on a phone as on a desktop — a 9px canvas label — which is what
     you want: the size is now a deliberate choice about the town, not an accident of
     which unit somebody reached for. */
  const phone = smallestText(390, 844);
  eq('I9 the smallest text on a phone is now a canvas label, not the thumb sublabel',
    phone.id, 'label-tool');
  eq('I10 at 9px, where the sublabel used to be 8.2', phone.px, 9);
  const desk = smallestText(1280, 720);
  eq('I11 and a desktop agrees', desk.id, 'label-tool');
  eq('I12 at the same 9px', desk.px, 9);
  eq('I12b nothing on a phone is under 9px any more', textSizeFailures(390, 844, 9).length, 0);

  const bad = textSizeFailures(390, 844);
  gt('I13 several rules are still below the 12px floor on a phone', bad.length, 3);
  ok('I14 but no longer the radio log, which was the worst DOM one at 10px',
    !bad.some((e) => e.id === 'radio'));
  ok('I14b nor the touch equipment row', !bad.some((e) => e.id === 'tslot'));
  /* What is left is deliberate and unchanged: a dense HUD at 11-11.5px, two 10.5px cells
     in the shift report, and the canvas labels. Reporting them as outstanding is honest;
     asserting they were "fixed" would not be. */
  ok('I15 the dispatch heading is still under it, at the 11px it was raised to',
    bad.some((e) => e.id === 'calls-head' && e.px === 11));
  ok('I16 and the touch sublabel, at its 11px floor', bad.some((e) => e.id === 'tbtn-sub' && e.px === 11));
  ok('I17 and the call rows at 11px', bad.some((e) => e.id === 'calls' && e.px === 11));
  ok('I17b everything left under the floor is 10.5px or more except the canvas labels',
    bad.filter((e) => e.px < 10.5).every((e) => e.id.startsWith('label-')),
    bad.filter((e) => e.px < 10.5).map((e) => `${e.id} ${e.px}`).join(','));
  eq('I18 the floor being reported against is 12px', TEXT_FLOOR_PX, 12);
  ok('I19 the failure list is sorted smallest first',
    bad.every((e, i) => i === 0 || bad[i - 1].px <= e.px));

  lines.push(`      at 390x844, ${bad.length} of ${textSizes(390, 844).length} rules are under ${TEXT_FLOOR_PX}px:`);
  for (const e of bad) lines.push(`      ${lpad(f(e.px, 1), 5)}px  ${pad(e.id, 18)} ${pad(e.where, 26)} [${e.src}]`);
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); emit(null);
  sectionB(); emit(null);
  sectionC(); emit(null);
  sectionD(); emit(null);
  sectionE(); emit(null);
  sectionF(); emit(null);
  sectionG(); emit(null);
  sectionH(); emit(null);
  sectionI(); emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
