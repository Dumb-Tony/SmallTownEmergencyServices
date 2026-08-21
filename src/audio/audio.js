/* Audio — WebAudio, synthesised from nothing. No files, no fetches.
 *
 * Copied in spirit and in names from SomethingsDifferent\somethingsdifferent.html
 * (`tone`, `makeNoise`, `arm`, `resume`) and Chameleon's `toneP`, per Dev\INDEX.md —
 * that synth has now been written four times and this is the fourth adaptation, not a
 * fifth invention.
 *
 * TWO RULES HOLD THIS FILE TOGETHER.
 *
 * 1. AUDIO READS STATE AND NEVER WRITES IT. It is the renderer's twin: same input,
 *    different output device. The simulation must behave identically with the whole
 *    layer dead, which is also what happens on a browser that refuses us a context.
 *
 * 2. THE DECISION IS SEPARATE FROM THE PLUMBING. `mixFor(state)` is a pure function
 *    from world state to target loudnesses; everything below it is oscillators. That
 *    split is what lets tools\m0-tests.js assert the interesting half — that a fire
 *    two hundred metres away is quieter than one you are standing in — on a headless
 *    box with no sound card and no user gesture.
 *
 * GDD implementation rule 7 is "make causes visible". The gas meter is the reason this
 * file exists: gas is the one hazard with nothing to see, and a click rate that rises
 * with concentration puts it in your ears instead of a number nobody reads.
 */

import { CONFIG } from '../config.js';
import { mulberry32 } from '../core/rng.js';
import { dist } from '../data/town.js';
import { gasAt } from '../sim/hazards.js';

export const AUDIO_KEY = 'stes.audio.v1';

/* ── the mix: pure, testable, no WebAudio anywhere near it ─────────────────── */

/** Distance falloff. Squared so that "across the street" and "across town" are not
 *  nearly the same number, which linear attenuation makes them. */
export function atten(d, range) {
  const g = 1 - d / range;
  return g <= 0 ? 0 : g * g;
}

export const RANGE = Object.freeze({
  siren: 150,   // a siren carries; that is the entire point of a siren
  fire: 85,
  arc: 30,
  wreck: 60,
});

/* How long a hold action takes, read straight out of CONFIG so the two cannot drift
 * apart. The groan rises toward the finish instead of droning at one pitch, because
 * that is the only feedback there is that leaning on SPACE is achieving anything:
 * measured before this existed, extrication was 9.0 s, a hot stick 4.2 s and a hydrant
 * wrench 2.6 s of complete silence. The medkit is deliberately absent — a dressing has
 * no motor — and the chainsaw has a voice of its own. */
export const WORK_MS = Object.freeze({
  spreaders: CONFIG.medical.extricateMs,
  hotstick: CONFIG.tools.hotstickMs,
  wrench: CONFIG.tools.wrenchTurnMs,
});

const EMPTY = Object.freeze([]);

/**
 * What should be audible right now, and how loudly.
 * @param {object} state  the simulation state, read-only
 * @returns {{siren:number, fire:number, water:number, saw:number, arc:number,
 *            engine:{gain:number, pitch:number}, work:{gain:number, pitch:number},
 *            gasRate:number}}
 */
export function mixFor(state) {
  const crew = state.responders && state.responders.length ? state.responders : [state.player];
  const mix = {
    siren: 0, fire: 0, water: 0, saw: 0, arc: 0,
    engine: { gain: 0, pitch: 0 },
    work: { gain: 0, pitch: 0 },
    gasRate: 0,
  };
  if (!crew[0]) return mix;

  /* Distance is measured to the NEAREST crew member. With two responders on one
   * screen there is no single pair of ears to put in the world, and "whichever of you
   * is closest to it" is both the honest answer and the one that matches what the
   * camera is showing. */
  const near = (x, y) => {
    let d = Infinity;
    for (const r of crew) d = Math.min(d, dist(r.x, r.y, x, y));
    return d;
  };

  for (const ap of state.apparatus || EMPTY) {
    if (!ap.siren) continue;
    mix.siren = Math.max(mix.siren, atten(near(ap.x, ap.y), RANGE.siren));
  }

  // Fire loudness is burning cells, attenuated per cell by its own distance: a big
  // fire far away and a small one at your feet can land on the same number, which is
  // correct — that is what they sound like.
  let fire = 0;
  for (const h of state.hazards || EMPTY) {
    if (h.kind === 'fire') {
      for (const c of h.cells) {
        if (!c.burning) continue;
        fire += 0.10 * atten(near(c.x, c.y), RANGE.fire);
      }
    } else if (h.kind === 'wreck' && h.burning) {
      fire += 0.45 * atten(near(h.x, h.y), RANGE.wreck);
    } else if (h.kind === 'power' && h.live) {
      /* The crackle carries as far as the fault does. Water on the ground grows the
       * live zone from 6.5 m to 12.4 m (CONFIG.power.wetSpreadMul 1.9) and a fixed
       * range meant the warning did not grow with the danger — you could stand inside
       * a wet zone and hear exactly what you heard safely outside a dry one. Scaling
       * the range by the zone's own radius is an exact identity at the boundary:
       * atten(r, 30r/6.5) is (1 - 6.5/30)^2 = 0.613 whatever r is, so "this is as loud
       * as the edge of a live zone sounds" stays one learnable number. */
      const reach = RANGE.arc * ((h.radiusM || CONFIG.power.liveRadiusM) / CONFIG.power.liveRadiusM);
      mix.arc = Math.max(mix.arc, atten(near(h.x, h.y), reach));
    }
  }
  mix.fire = Math.min(1, fire);

  // Anything in anyone's hands. Two crew both cutting is still one saw in your ears.
  for (const r of crew) {
    const held = (state.tools || EMPTY).find((t) => t.carrier === r.id);
    if (!held) continue;
    if (held.flowing) mix.water = Math.max(mix.water, held.defId === 'hose' ? 1 : 0.55);
    if (held.defId === 'chainsaw') {
      // Idling in your hands, screaming while it is in the cut.
      mix.saw = Math.max(mix.saw, r.useProgressMs > 0 ? 1 : 0.35);
    }
    if (held.defId === 'gasmeter') {
      // 0 to ~14 clicks a second. Carrying the meter is what makes gas perceptible at
      // all, so this is a gameplay signal, not decoration.
      mix.gasRate = Math.max(mix.gasRate, Math.min(14, gasAt(state, r.x, r.y) * 14));
    }
    // A powered tool under load. Pitch follows how far into the action this responder
    // is, so a nine-second extrication stops being nine seconds of nothing happening.
    const workMs = WORK_MS[held.defId];
    if (workMs && r.useProgressMs > 0) {
      const frac = Math.min(1, r.useProgressMs / workMs);
      const pitch = 1 + frac * 0.6;
      if (pitch > mix.work.pitch) mix.work = { gain: 1, pitch };
    }
  }

  for (const r of crew) {
    if (!r.inVehicleId) continue;
    const ap = (state.apparatus || EMPTY).find((a) => a.id === r.inVehicleId);
    if (!ap) continue;
    /* An apparatus this build has no def for is reachable input, not a hypothetical:
     * a client rebuilds state.apparatus straight out of a peer's snapshot
     * (src/net/protocol.js applySnapshot) and rooms are not private. main.js re-arms
     * requestAnimationFrame on the LAST line of frame() with audio.update() above it,
     * so anything thrown in here does not mean silence, it means a frozen game. */
    const def = state.apparatusDefs && state.apparatusDefs[ap.defId];
    if (!def) continue;
    const frac = Math.min(1, Math.abs(ap.speed) / (def.maxSpeed || 1));
    const gain = 0.35 + frac * 0.65;
    if (gain > mix.engine.gain) mix.engine = { gain, pitch: 0.6 + frac * 1.9 };
  }

  return mix;
}

/* ── one-shots: the vocabulary, as data ────────────────────────────────────
 * Every simulation event that a player should hear, mapped to a recipe. Keeping it in
 * a table rather than a switch means a new event is a new row, and an event with no
 * row is silent rather than a crash.
 *
 * `[freq0, freq1, seconds, type, gain, delay]` per partial.
 */
export const CUES = Object.freeze({
  SIM_RESET:           { bus: 'ui',    minGapMs: 1000, parts: [[392, 392, 0.18, 'sine', 0.20], [523, 523, 0.28, 'sine', 0.18, 0.15]] },
  CALL_RECEIVED:       { bus: 'ui',    minGapMs: 200, parts: [[740, 740, 0.16, 'square', 0.30], [988, 988, 0.22, 'square', 0.30, 0.17]] },
  CALL_UPDATED:        { bus: 'ui',    minGapMs: 400, parts: [[620, 700, 0.10, 'square', 0.16]] },
  PRIORITY_RAISED:     { bus: 'ui',    minGapMs: 400, parts: [[700, 940, 0.13, 'square', 0.22], [940, 1120, 0.11, 'square', 0.18, 0.12]] },
  CREW_ON_SCENE:       { bus: 'ui',    minGapMs: 800, parts: [[520, 660, 0.09, 'sine', 0.16]] },

  INCIDENT_CONTROLLED: { bus: 'ui',    minGapMs: 300, parts: [[523, 523, 0.16, 'sine', 0.26], [784, 784, 0.30, 'sine', 0.24, 0.13]] },
  INCIDENT_LOST:       { bus: 'ui',    minGapMs: 300, parts: [[330, 196, 0.55, 'sine', 0.28], [165, 110, 0.70, 'triangle', 0.18, 0.06]] },
  STRUCTURE_LOST:      { bus: 'world', minGapMs: 500, parts: [[90, 46, 1.10, 'sawtooth', 0.34], [140, 70, 0.80, 'triangle', 0.20, 0.05]] },

  PATIENT_DELIVERED:   { bus: 'ui',    minGapMs: 300, parts: [[659, 659, 0.14, 'sine', 0.24], [988, 988, 0.34, 'sine', 0.22, 0.12]] },
  PATIENT_LOST:        { bus: 'ui',    minGapMs: 300, parts: [[262, 175, 0.80, 'sine', 0.26]] },
  PATIENT_TREATED:     { bus: 'foley', minGapMs: 300, parts: [[880, 1170, 0.12, 'sine', 0.18]] },
  PATIENT_EXTRICATED:  { bus: 'foley', minGapMs: 300, parts: [[300, 520, 0.22, 'triangle', 0.24]] },
  PATIENT_GRABBED:     { bus: 'foley', minGapMs: 200, parts: [[190, 150, 0.12, 'triangle', 0.16]] },
  PATIENT_RELEASED:    { bus: 'foley', minGapMs: 200, parts: [[165, 118, 0.16, 'triangle', 0.14]] },
  PATIENT_LOADED:      { bus: 'foley', minGapMs: 200, parts: [[240, 320, 0.16, 'triangle', 0.20]] },
  // Somebody walking out of a building that is on fire is the loudest fact on the
  // board and there is nothing on screen that says it: they appear at a door the crew
  // may not be looking at. Once per occupant — victims.js latches `fleeing`.
  OCCUPANT_EVACUATING: { bus: 'world', minGapMs: 600, parts: [[660, 880, 0.14, 'sine', 0.20], [880, 660, 0.20, 'sine', 0.15, 0.13]] },
  /* Somebody who did not get out. Deliberately the same shape as PATIENT_LOST and a
     third below it: the crew has just acquired a search, and it should land in the
     stomach rather than in the notification tray. */
  RESIDENT_TRAPPED:    { bus: 'ui',    minGapMs: 400, parts: [[208, 139, 0.85, 'sine', 0.28], [139, 104, 0.55, 'triangle', 0.16, 0.30]] },

  GAS_FLASH:           { bus: 'world', minGapMs: 400, parts: [[160, 40, 0.70, 'sawtooth', 0.42], [420, 90, 0.45, 'square', 0.24]] },
  WRECK_IGNITED:       { bus: 'world', minGapMs: 500, parts: [[200, 80, 0.50, 'sawtooth', 0.26]] },
  FIRE_EXTENDED:       { bus: 'world', minGapMs: 500, parts: [[280, 150, 0.55, 'sawtooth', 0.24], [120, 80, 0.65, 'triangle', 0.18, 0.08]] },
  RESPONDER_SHOCKED:   { bus: 'world', minGapMs: 300, parts: [[1400, 120, 0.30, 'square', 0.34], [90, 60, 0.35, 'sawtooth', 0.22, 0.02]] },
  VICTIM_SHOCKED:      { bus: 'world', minGapMs: 600, parts: [[1100, 140, 0.24, 'square', 0.22]] },

  APPARATUS_STRUCK:    { bus: 'world', minGapMs: 250, parts: [[120, 55, 0.28, 'triangle', 0.30], [70, 40, 0.34, 'sawtooth', 0.22]] },
  HYDRANT_STRUCK:      { bus: 'world', minGapMs: 300, parts: [[1600, 700, 0.30, 'square', 0.26], [2400, 1100, 0.22, 'square', 0.16, 0.02]] },
  HYDRANT_CHARGED:     { bus: 'foley', minGapMs: 300, parts: [[220, 420, 0.35, 'triangle', 0.22]] },
  TANK_DRY:            { bus: 'foley', minGapMs: 800, parts: [[420, 180, 0.30, 'sawtooth', 0.20]] },
  HOSE_TAUT:           { bus: 'foley', minGapMs: 800, parts: [[300, 260, 0.22, 'triangle', 0.18]] },

  ROAD_CLEARED:        { bus: 'foley', minGapMs: 300, parts: [[440, 660, 0.20, 'triangle', 0.22]] },
  LINE_DE_ENERGISED:   { bus: 'foley', minGapMs: 300, parts: [[900, 300, 0.26, 'sine', 0.24]] },
  GAS_SHUT_OFF:        { bus: 'foley', minGapMs: 300, parts: [[520, 300, 0.24, 'sine', 0.22]] },

  TOOL_TAKEN:          { bus: 'foley', minGapMs: 120, parts: [[600, 760, 0.07, 'square', 0.13]] },
  TOOL_DROPPED:        { bus: 'foley', minGapMs: 120, parts: [[420, 300, 0.09, 'square', 0.12]] },
  NOTHING_IN_SLOT:     { bus: 'foley', minGapMs: 300, parts: [[220, 200, 0.07, 'square', 0.10]] },
  // "You are holding the wrong thing for this." interaction.js already refuses to
  // report it more than once every 2 s per responder, so the gap here only has to keep
  // two crew making the same mistake at once from stacking into one thud.
  NO_TARGET:           { bus: 'foley', minGapMs: 900, parts: [[180, 120, 0.14, 'triangle', 0.15]] },
  ENTERED_APPARATUS:   { bus: 'foley', minGapMs: 200, parts: [[180, 140, 0.14, 'triangle', 0.18]] },
  EXITED_APPARATUS:    { bus: 'foley', minGapMs: 200, parts: [[150, 190, 0.12, 'triangle', 0.16]] },
  // The switch, not the siren. Turning it OFF is the half with no other feedback: the
  // wail takes 60 ms to fall away and until it has, nothing says the press registered.
  SIREN_TOGGLED:       { bus: 'foley', minGapMs: 200, parts: [[1200, 900, 0.05, 'square', 0.12]] },
  EXTINGUISHER_EMPTY:  { bus: 'foley', minGapMs: 500, parts: [[300, 150, 0.24, 'sawtooth', 0.16]] },

  SHIFT_ENDED:         { bus: 'ui',    minGapMs: 500, parts: [[392, 392, 0.30, 'sine', 0.26], [523, 523, 0.30, 'sine', 0.24, 0.22], [659, 659, 0.60, 'sine', 0.22, 0.44]] },
  UTILITY_ARRIVED:     { bus: 'ui',    minGapMs: 500, parts: [[600, 480, 0.18, 'sine', 0.18]] },
});

/* Events deliberately left silent. Kept as data beside CUES so that "somebody decided
 * this one should make no sound" and "nobody noticed this event existed" are different
 * states, and so tools\m9-tests.js can insist every name in the vocabulary is one or
 * the other — a new event with no cue then fails a test instead of being quietly mute.
 *
 * SIM_PAUSED also fires on window blur (src/main.js), so a cue on it would beep at a
 * player as they tab away to something else; and main.js already hushes every voice
 * while the town is not PLAYING, which says the same thing far louder than a tone. */
/* RESIDENT_OUT is silent, and it is the one entry here that was a decision rather than a
 * fact about the engine. It fires once per person, so a four-person household is four
 * cues in eight seconds — and the thing worth hearing is not "another one is out", it is
 * "one of them is NOT". That fact has a sound already, and burying it under three
 * cheerful ones is how you make it inaudible. The radio says the count in words; the
 * silence is what makes RESIDENT_TRAPPED mean something when it comes. */
export const SILENT_EVENTS = Object.freeze(['SIM_PAUSED', 'SIM_RESUMED', 'RESIDENT_OUT']);

/** The recipe for an event, or null. OWN properties only: CUES is a plain object, so
 *  `CUES.constructor` is a function inherited from Object.prototype — an event by that
 *  name reached `cue.parts` as undefined and threw out of the frame, and main.js
 *  re-arms requestAnimationFrame on the last line of frame(), so that is a frozen game
 *  rather than a missing sound. Nothing emits `constructor` today; this makes sure
 *  nothing ever can. */
export function cueFor(type) {
  return Object.prototype.hasOwnProperty.call(CUES, type) ? CUES[type] : null;
}

/** How loud one firing of a cue is, against its recipe. Pure, so the curve is
 *  assertable: a 4 m/s nudge into a kerb (CONFIG.drive.collisionFreeSpeed, the speed
 *  below which a bump does not even mark the truck) and a 14 m/s ram into a shop front
 *  are the same event with very different numbers behind them — 0.64 against 1.35. */
export function cueVolume(type, payload) {
  if (type === 'APPARATUS_STRUCK') return Math.min(1.4, 0.35 + (payload?.impact || 0) / 14);
  return 1;
}

/* ── the plumbing ──────────────────────────────────────────────────────────── */

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.dead = false;
    this.muted = loadMuted();
    this.bus = {};
    this.loops = {};
    this.lastCueAt = {};
    this.gasClickAcc = 0;
    this.sirenPhase = 0;
  }

  /** Build the graph. Must be called from a real user gesture; safe to call always. */
  arm() {
    if (this.ctx || this.dead) return this.ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) { this.dead = true; return null; }
    try {
      const ctx = new AC();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 1;
      // One compressor across the whole mix: a siren plus a fire bed plus a collision
      // can sum past full scale, and digital clipping reads as a bug, not as loudness.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      comp.attack.value = 0.004; comp.release.value = 0.2;
      master.connect(comp); comp.connect(ctx.destination);
      this.master = master;
      for (const name of ['world', 'foley', 'ui']) {
        const g = ctx.createGain();
        g.gain.value = name === 'ui' ? 0.85 : 1;
        g.connect(master);
        this.bus[name] = g;
      }
      this.noiseBuf = makeNoise(ctx);
      this.buildLoops();
    } catch (e) { this.ctx = null; this.dead = true; return null; }
    this.resume();
    return this.ctx;
  }

  resume() {
    const c = this.ctx;
    if (c && c.state === 'suspended' && c.resume) { try { c.resume(); } catch (e) { /* ignore */ } }
  }

  get armed() { return !!this.ctx; }

  setMuted(v) {
    this.muted = !!v;
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    try { globalThis.localStorage?.setItem(AUDIO_KEY, JSON.stringify({ muted: this.muted })); } catch (e) { /* ignore */ }
    return this.muted;
  }

  toggleMute() { return this.setMuted(!this.muted); }

  /** Continuous voices, one node each, running silently until the mix says otherwise.
   *  Starting and stopping oscillators per frame is how you get clicks. */
  buildLoops() {
    const ctx = this.ctx;
    const loop = (name, build) => { this.loops[name] = build(); this.loops[name].name = name; };

    loop('siren', () => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 620;
      const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 2.5;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(band); band.connect(g); g.connect(this.bus.world); o.start();
      return { osc: o, gain: g };
    });

    loop('fire', () => {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(lp); lp.connect(g); g.connect(this.bus.world); src.start();
      return { src, filter: lp, gain: g };
    });

    loop('water', () => {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(hp); hp.connect(g); g.connect(this.bus.world); src.start();
      return { src, gain: g };
    });

    loop('engine', () => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 55;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(lp); lp.connect(g); g.connect(this.bus.world); o.start();
      return { osc: o, gain: g };
    });

    loop('saw', () => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 210;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.2;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(bp); bp.connect(g); g.connect(this.bus.world); o.start();
      return { osc: o, filter: bp, gain: g };
    });

    loop('arc', () => {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(bp); bp.connect(g); g.connect(this.bus.world); src.start();
      return { src, gain: g };
    });

    // The hydraulic pack: spreaders, hot stick, hydrant wrench. Low and lowpassed so it
    // sits under the fire bed rather than competing with it — this is the one voice
    // that plays while the player is holding a key and waiting.
    loop('work', () => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 96;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(lp); lp.connect(g); g.connect(this.bus.world); o.start();
      return { osc: o, filter: lp, gain: g };
    });
  }

  /**
   * One frame of mixing. Reads state; writes only to audio nodes.
   * Safe and cheap before arm() — this is the state the headless harness runs in.
   */
  update(state, dtMs) {
    if (!this.ctx || this.dead || !state) return null;
    const mix = mixFor(state);
    const t = this.ctx.currentTime;
    const ramp = (node, v) => {
      if (!node) return;
      try { node.gain.setTargetAtTime(v, t, 0.06); } catch (e) { node.gain.value = v; }
    };

    // The wail. Driven off the mix, so it stops rising the moment the siren goes off.
    this.sirenPhase += (dtMs / 1000) * 0.55;
    const wail = 0.5 + 0.5 * Math.sin(this.sirenPhase * Math.PI * 2);
    if (this.loops.siren) {
      ramp(this.loops.siren.gain, mix.siren * 0.16);
      try { this.loops.siren.osc.frequency.setTargetAtTime(560 + wail * 380, t, 0.05); } catch (e) { /* ignore */ }
    }

    ramp(this.loops.fire?.gain, mix.fire * 0.30);
    if (this.loops.fire) {
      // A bigger fire is not just louder, it is broader.
      try { this.loops.fire.filter.frequency.setTargetAtTime(500 + mix.fire * 1400, t, 0.2); } catch (e) { /* ignore */ }
    }
    ramp(this.loops.water?.gain, mix.water * 0.16);
    ramp(this.loops.arc?.gain, mix.arc * 0.12);
    ramp(this.loops.saw?.gain, mix.saw * 0.10);
    if (this.loops.saw && mix.saw > 0) {
      try { this.loops.saw.osc.frequency.setTargetAtTime(mix.saw > 0.5 ? 330 : 190, t, 0.08); } catch (e) { /* ignore */ }
    }

    ramp(this.loops.engine?.gain, mix.engine.gain * 0.10);
    if (this.loops.engine && mix.engine.gain > 0) {
      try { this.loops.engine.osc.frequency.setTargetAtTime(42 * mix.engine.pitch, t, 0.08); } catch (e) { /* ignore */ }
    }

    ramp(this.loops.work?.gain, mix.work.gain * 0.09);
    if (this.loops.work && mix.work.gain > 0) {
      // 96 Hz at the start of the action to 154 Hz at the finish. Slow ramp: the point
      // is that it is CLIMBING, and a fast follow just sounds like it is stuttering.
      try { this.loops.work.osc.frequency.setTargetAtTime(96 * mix.work.pitch, t, 0.18); } catch (e) { /* ignore */ }
    }

    // The meter. Clicks, not a tone: a rate is readable in peripheral hearing in a way
    // that a pitch is not, and it is the only sense you have for gas.
    if (mix.gasRate > 0.05) {
      this.gasClickAcc += (dtMs / 1000) * mix.gasRate;
      while (this.gasClickAcc >= 1) {
        this.gasClickAcc -= 1;
        tone(this.ctx, this.bus.foley, 0.07, 2400, 2000, 0.02, 'square');
      }
    } else this.gasClickAcc = 0;

    return mix;
  }

  /**
   * The decision half of a one-shot: which recipe, and may it play yet? Split out of
   * onEvent for the same reason mixFor is split out of update — it holds the only
   * interesting rule and it has no AudioContext anywhere near it, so the rate limit is
   * assertable on a headless box with no sound card.
   * @returns {object|null} the recipe to play, or null for "stay silent"
   */
  takeCue(type, simTimeMs) {
    const cue = cueFor(type);
    if (!cue) return null;
    const last = this.lastCueAt[type];
    /* `last <= simTimeMs` is not redundant. A new shift restarts simTimeMs at 0 while
     * this table still holds stamps from the last one, and a stamp ten minutes in the
     * future reads as "the gap has not passed yet" — measured: a cue stamped at
     * t=540 s of shift one was suppressed when it fired again at t=1.2 s of shift two,
     * and would have stayed suppressed until t=540 s of shift two, which on a 600 s
     * shift is very nearly for ever. A stamp that has not happened yet is not a stamp. */
    if (last != null && last <= simTimeMs && simTimeMs - last < cue.minGapMs) return null;
    this.lastCueAt[type] = simTimeMs;
    return cue;
  }

  /** A simulation event, made audible. Unknown events are silent, never fatal. */
  onEvent(type, payload, simTimeMs) {
    if (!this.ctx || this.dead) return false;
    const cue = this.takeCue(type, simTimeMs);
    if (!cue) return false;
    const vol = cueVolume(type, payload);
    for (const [f0, f1, dur, wave, gain, delay] of cue.parts) {
      tone(this.ctx, this.bus[cue.bus] || this.bus.foley, gain * vol, f0, f1, dur, wave, delay || 0);
    }
    return true;
  }

  /** Everything quiet, immediately — used on pause and between shifts. */
  hush() {
    if (!this.ctx) return;
    for (const l of Object.values(this.loops)) {
      try { l.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); } catch (e) { /* ignore */ }
    }
    this.gasClickAcc = 0;
  }
}

/* ── primitives, copied from somethingsdifferent.html ──────────────────────── */

/** Two seconds of noise with a little brown in it — pure white is hissy.
 *
 *  SEEDED, not the platform generator. src/core/rng.js states the invariant — no
 *  gameplay system may draw from an unseeded source, because implementation rule 1 is
 *  that a playtest can be repeated — and what a shift SOUNDED like is part of what is
 *  being repeated. This is the bed under the fire and the arc, so it was the one place
 *  in the audio layer where two runs of seed 606 diverged. mulberry32 is the same
 *  generator the town is built with (AirportBaggageCrew, per Dev\INDEX.md). */
export function makeNoise(ctx, seed = 0x5EA5E7) {
  const n = Math.floor(ctx.sampleRate * 2);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  const rnd = mulberry32(seed);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    brown = (brown + 0.02 * w) / 1.02;
    d[i] = w * 0.65 + brown * 3.2;
  }
  return b;
}

/** One-shot pitched body. Same shape as the original; takes an explicit bus node. */
export function tone(ctx, busNode, vol, f0, f1, dur, type, delay) {
  if (!ctx || !busNode || !(vol > 0.0004)) return;
  const t = ctx.currentTime + (delay || 0);
  const o = ctx.createOscillator();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const e = ctx.createGain();
  e.gain.setValueAtTime(0.0001, t);
  e.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(e); e.connect(busNode);
  o.start(t); o.stop(t + dur + 0.05);
}

function loadMuted() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIO_KEY);
    if (!raw) return false;
    return !!JSON.parse(raw).muted;
  } catch (e) { return false; }
}
