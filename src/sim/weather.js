/* Weather — GDD core system: "modifiers that generate and connect incidents rather than
 * launching a separate scripted level."
 *
 * That sentence is the whole design brief and it rules out most of what a weather feature
 * usually is. There is no storm event, no flood level, no scripted sequence. There is a
 * small set of MULTIPLIERS that the systems already in the game read, so a windy night
 * is the same game with the fire behaving differently — and the difference shows up in
 * decisions the player was already making, rather than in a new panel.
 *
 * WHAT EACH ONE ACTUALLY CHANGES, and why it is that and not something else:
 *
 *   wind   — fire jumps to an exposure more readily, and it is DIRECTIONAL: the building
 *            downwind of a fire is the one that catches. That turns "which exposure do I
 *            protect" from a distance calculation into a reading of the smoke. Gas blows
 *            away faster, which is the one mercy in it.
 *   rain   — a fire spreads more slowly and the roads are slippery. It buys the crew time
 *            on the fire and charges them for it on the way there, which is a trade the
 *            player makes with the throttle rather than a number they read.
 *   cold   — a fire spreads more slowly still, a casualty declines faster, and the mains
 *            run slow. The pressure moves off the structure and onto the people and the
 *            water, which are the two things a crew cannot hurry.
 *   heat   — fire spreads and jumps harder, and there is more of it to work in.
 *
 * THE LAW, same as for residents: weather may not create a call, close one, or make a
 * shift unwinnable. Every multiplier is bounded, `clear` is exactly 1.0 on all of them,
 * and the suite asserts both.
 *
 * It draws from its OWN stream (see src/core/rng.js on named streams). A weather roll in
 * the shift's main stream would move every dispatch pace and hazard roll after it, and
 * every seed anybody had ever measured would quietly become a different town.
 */

import { CONFIG } from '../config.js';

/** The conditions, and what each one multiplies. Anything absent is 1.0. */
export const CONDITIONS = Object.freeze({
  clear: {
    id: 'clear', label: 'Clear', steps: ['Clear', 'Clear', 'Clear'], note: 'Still and dry.',
    weight: 34, sky: '#0f1220', tint: 0,
  },
  wind: {
    id: 'wind', label: 'Windy', steps: ['Light wind', 'Windy', 'High wind'], note: 'A steady wind across the valley.',
    weight: 22, sky: '#141626', tint: 0.06,
    fireJump: 2.1,        // an exposure is much more likely to catch
    windBias: 0.75,       // ...and it is the one DOWNWIND that catches
    gasDisperse: 1.9,     // the one mercy in it
    smokeLean: 1.0,
  },
  rain: {
    id: 'rain', label: 'Rain', steps: ['Light rain', 'Rain', 'Heavy rain'], note: 'Wet roads, and a fire that fights back less.',
    weight: 18, sky: '#101828', tint: 0.16,
    fireSpread: 0.72,
    fireJump: 0.45,
    roadGrip: 0.82,       // the trade: time on the fire, paid for on the way there
    gasDisperse: 1.25,
    curiosity: 0.45,      // fewer people stand about in it
    smokeLean: 0.4,
  },
  cold: {
    id: 'cold', label: 'Cold snap', steps: ['Cold', 'Cold snap', 'Hard freeze'], note: 'Below freezing. Hydrants and people both suffer.',
    weight: 14, sky: '#0d1626', tint: 0.10,
    fireSpread: 0.86,
    patientDecline: 1.30, // the pressure moves from the structure to the people
    hydrantFlow: 0.70,    // half-frozen mains: a refill takes noticeably longer
    curiosity: 0.5,
    smokeLean: 0.5,
  },
  heat: {
    id: 'heat', label: 'Heat', steps: ['Warm', 'Heat', 'Fierce heat'], note: 'Dry and hot. Everything wants to burn.',
    weight: 12, sky: '#1a1420', tint: 0.08,
    fireSpread: 1.24,
    fireJump: 1.6,
    windBias: 0.3,
    curiosity: 1.3,
    smokeLean: 0.7,
  },
});

export const CONDITION_IDS = Object.freeze(Object.keys(CONDITIONS));

/* ── how every system reads it ────────────────────────────────────────────────
 * ONE accessor, taking a STATE. `weatherMods` below takes a weather object, and having
 * both shapes in circulation is how `weatherMods(state)` gets written by mistake: it
 * reads `state.id`, finds nothing, and silently returns `clear` — a modifier that is
 * wired, compiles, runs, and does nothing, which is precisely the failure the a11y audit
 * spent a section on. Every consumer calls this; nothing outside this file calls
 * `weatherMods` directly except the tests, which pass a weather.
 *
 * Cached per state object because it is read per victim, per truck and per burning cell,
 * every step, for a value that changes once a shift.
 */
const _cache = new WeakMap();
const _noState = {};
export function weatherFor(state) {
  const w = (state && state.weather) || null;
  const key = state || _noState;
  const hit = _cache.get(key);
  if (hit && hit.w === w) return hit.m;
  const m = weatherMods(w);
  _cache.set(key, { w, m });
  return m;
}

/** The multipliers, complete, with every absent one filled in as 1.0. Frozen so that a
 *  system cannot quietly write a modifier back into the table it is reading. */
export function weatherMods(w) {
  const c = CONDITIONS[(w && w.id) || 'clear'] || CONDITIONS.clear;
  const s = (w && Number.isFinite(w.strength)) ? clamp01(w.strength) : 1;
  // Strength scales each modifier TOWARD 1, so a light wind is a small wind rather than
  // a different condition. A shift is never more extreme than its table entry says.
  const lerp = (v) => 1 + ((v == null ? 1 : v) - 1) * s;
  return Object.freeze({
    id: c.id,
    fireSpread: lerp(c.fireSpread),
    fireJump: lerp(c.fireJump),
    gasDisperse: lerp(c.gasDisperse),
    roadGrip: lerp(c.roadGrip),
    patientDecline: lerp(c.patientDecline),
    hydrantFlow: lerp(c.hydrantFlow),
    curiosity: lerp(c.curiosity),
    // Not a multiplier: 0..1, how much the wind decides WHICH exposure catches.
    windBias: (c.windBias || 0) * s,
    smokeLean: (c.smokeLean || 0) * s,
  });
}

/**
 * The weather for a shift.
 *
 * `avoid` is the previous shift's condition — the town's "recent weather" from the save.
 * Two identical shifts in a row is not weather, it is a constant, and a constant is
 * exactly the thing this system exists not to be. It is a WEIGHT reduction rather than a
 * ban, because "it rained again" is a real thing that happens.
 */
export function rollWeather(rng, avoid = null) {
  const ids = CONDITION_IDS;
  const weights = ids.map((id) => {
    const w = CONDITIONS[id].weight;
    return id === avoid ? w * CONFIG.weather.repeatWeightMul : w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng.float() * total;
  let id = ids[0];
  for (let i = 0; i < ids.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { id = ids[i]; break; }
  }
  return {
    id,
    // Direction the wind is going, in world radians. Always present — a calm night has a
    // direction too, it just does not matter, and one field that is sometimes absent is
    // how a renderer ends up drawing NaN.
    windDir: rng.range(0, Math.PI * 2),
    strength: id === 'clear' ? 0 : rng.range(CONFIG.weather.minStrength, 1),
  };
}

/** Plain English, for the top bar and the paper.
 *
 *  Each condition writes its own three, because building them out of the label produced
 *  "Hard windy", which is what a system says and not what a person does. */
export function describeWeather(w) {
  const c = CONDITIONS[(w && w.id) || 'clear'];
  const s = (w && w.strength) || 0;
  const steps = c.steps || [c.label, c.label, c.label];
  return s < 0.5 ? steps[0] : s > 0.85 ? steps[2] : steps[1];
}

/** How much a bearing agrees with the wind: 1 straight downwind, 0 straight upwind. */
export function downwindFactor(w, fromX, fromY, toX, toY) {
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (!len) return 0.5;
  const dot = (dx / len) * Math.cos(w.windDir) + (dy / len) * Math.sin(w.windDir);
  return (dot + 1) / 2;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
