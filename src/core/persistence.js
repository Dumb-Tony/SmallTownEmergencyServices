/* Device-local persistence — GDD MVP scope: "device-local town-confidence persistence"
 * and "Persistence tracks consequences, not busywork."
 *
 * Versioned with a migration path and a default fallback, because a save that throws is
 * worse than no save at all: the shift must still start. Everything here is a plain
 * object; the simulation reads it once at shift start and writes it once at shift end.
 *
 * Deliberately NOT saved: incident state, vehicle positions, mid-shift progress. A shift
 * is the unit of persistence. What survives is what the town would notice.
 */

import { CONFIG } from '../config.js';

export const SAVE_KEY = 'stes.town.v1';
export const SAVE_VERSION = 1;

export function defaultTown() {
  return {
    version: SAVE_VERSION,
    shiftNumber: 1,
    confidence: CONFIG.town.startConfidence,
    buildings: {},     // id -> { damage, boardedShifts, timesBurned }
    hydrants: {},      // id -> { damaged }
    history: [],       // one line per completed shift, newest last
    // Which of the five verbs this player has performed at least once. The coach reads
    // it to know when to stop talking; a save from before it existed simply has none.
    learned: {},
  };
}

function storage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__stes_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }   // private mode, headless harness, or a locked-down profile
}

export function loadTown() {
  const s = storage();
  if (!s) return defaultTown();
  let raw;
  try { raw = s.getItem(SAVE_KEY); } catch { return defaultTown(); }
  if (!raw) return defaultTown();

  let data;
  try { data = JSON.parse(raw); } catch { return defaultTown(); }
  return migrate(data);
}

/** Future versions land here. An unknown or damaged save falls back to a fresh town
 *  rather than half-applying itself. */
export function migrate(data) {
  if (!data || typeof data !== 'object') return defaultTown();
  if (data.version !== SAVE_VERSION) return defaultTown();

  const base = defaultTown();
  return {
    version: SAVE_VERSION,
    shiftNumber: Number.isFinite(data.shiftNumber) ? data.shiftNumber : base.shiftNumber,
    confidence: clamp01(Number.isFinite(data.confidence) ? data.confidence : base.confidence),
    buildings: sanitiseBuildings(data.buildings),
    hydrants: sanitiseHydrants(data.hydrants),
    history: Array.isArray(data.history) ? data.history.slice(-12) : [],
    // Only the known lesson names survive a load, so a corrupt save cannot silence the
    // coach with junk keys — and an old save, which has none, simply starts learning.
    learned: sanitiseLearned(data.learned),
  };
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

function sanitiseBuildings(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, rec] of Object.entries(obj)) {
    if (!rec || typeof rec !== 'object') continue;
    out[id] = {
      damage: clamp01(Number(rec.damage) || 0),
      boardedShifts: Math.max(0, Math.floor(Number(rec.boardedShifts) || 0)),
      timesBurned: Math.max(0, Math.floor(Number(rec.timesBurned) || 0)),
    };
  }
  return out;
}

function sanitiseHydrants(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, rec] of Object.entries(obj)) {
    if (!rec || typeof rec !== 'object') continue;
    out[id] = { damaged: !!rec.damaged };
  }
  return out;
}

export function saveTown(town) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(SAVE_KEY, JSON.stringify({ ...town, version: SAVE_VERSION }));
    return true;
  } catch { return false; }
}

export function clearSave() {
  const s = storage();
  if (!s) return false;
  try { s.removeItem(SAVE_KEY); return true; } catch { return false; }
}

/**
 * Roll the town forward one shift: repairs tick down, gutted buildings stay boarded,
 * hydrants get fixed by the town eventually. This is the ONLY place a new shift's
 * starting world differs from the last one's ending world.
 */
export function advanceShift(town, summary) {
  const next = {
    ...town,
    version: SAVE_VERSION,
    shiftNumber: town.shiftNumber + 1,
    confidence: clamp01(town.confidence),
    buildings: {},
    hydrants: {},
    history: [...town.history, summary].slice(-12),
  };

  for (const [id, rec] of Object.entries(town.buildings)) {
    const boarded = rec.damage >= 0.6
      ? Math.max(rec.boardedShifts, CONFIG.town.repairShifts)
      : Math.max(0, rec.boardedShifts - 1);
    // Crews and contractors chip away at it between shifts.
    const repaired = boarded > 0 ? rec.damage : Math.max(0, rec.damage - 0.34);
    if (repaired <= 0.001 && boarded === 0) continue;   // fully repaired: forget it
    next.buildings[id] = {
      damage: repaired,
      boardedShifts: boarded > 0 ? boarded - 1 : 0,
      timesBurned: rec.timesBurned,
    };
  }

  for (const [id, rec] of Object.entries(town.hydrants)) {
    // A struck hydrant is out for the following shift, then the water board gets to it.
    if (rec.damaged && !rec.shiftsDown) next.hydrants[id] = { damaged: true, shiftsDown: 1 };
    else if (rec.damaged && rec.shiftsDown >= 1) { /* repaired */ }
  }

  return next;
}

function sanitiseLearned(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of CONFIG.coach.lessons) if (obj[k] === true) out[k] = true;
  return out;
}
