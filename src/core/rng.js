/* Seeded RNG — GDD §21.7.
 *
 * mulberry32, copied from SomethingsDifferent\somethingsdifferent.html:664 (which took
 * it from Chameleon\chameleon3d.html:653). Name kept so the lineage stays greppable —
 * see Dev\INDEX.md "Randomness & hashing".
 *
 * INVARIANT: no gameplay system may call Math.random(). Bag composition, spawn order
 * and every authored variation draw from a seeded stream so a shift replays exactly.
 * tools\m0-tests.js section H2 greps src/ for Math.random and fails if one appears
 * outside the single allowed exception (net.js randCode — a predictable room code is
 * not a room code). That claim sat here for a long time with no such test behind it,
 * and in the meantime the audio layer's noise bed was built from Math.random.
 */

export function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

/** A named draw stream. Systems take a Rng, never the raw closure, so a stream can be
 *  reseeded on restart and reported in the shift report / debug overlay. */
export class Rng {
  constructor(seed, label = 'rng') {
    this.seed = seed >>> 0;
    this.label = label;
    this.draws = 0;
    this._next = mulberry32(this.seed);
  }

  /** Restore to the exact state a fresh Rng(seed) would have. Used by restart. */
  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.draws = 0;
    this._next = mulberry32(this.seed);
    return this;
  }

  /** float in [0,1) */
  float() { this.draws++; return this._next(); }

  /** float in [lo,hi) */
  range(lo, hi) { return lo + this.float() * (hi - lo); }

  /** integer in [lo,hi] inclusive */
  int(lo, hi) { return lo + Math.floor(this.float() * (hi - lo + 1)); }

  /** true with probability p */
  chance(p) { return this.float() < p; }

  pick(arr) { return arr[Math.floor(this.float() * arr.length)]; }

  /** Fisher-Yates, in place, deterministic for a given stream position. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

/** Deterministic seed from a string, so "regional_day_1" always yields the same shift.
 *  FNV-1a, from SomethingsDifferent\somethingsdifferent.html:5563 `hashStr`. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
