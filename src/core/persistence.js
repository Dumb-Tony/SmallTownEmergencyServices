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
import { CONDITION_IDS } from '../sim/weather.js';
import { clampToBounds, STATION } from '../data/town.js';

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
    /* The GDD's "recent weather", and it does exactly one job: tomorrow's roll weights a
     * repeat of it down. A save from before weather existed has null, which the roll
     * reads as "no preference" — the same thing shift 1 sees. */
    lastWeather: null,

    /* "vehicle damage and location" and "equipment location and consumables", both from
     * the GDD's persistence list and both missing until now.
     *
     * The station tidies up overnight, but only what is AT the station. A truck left on
     * the apron goes back in its bay with a full tank; a truck left at the far end of
     * Main Street is at the far end of Main Street when you clock on, and the shift
     * report says so the night before. That is the GDD asking for it directly —
     * "missing, depleted, damaged, or badly parked apparatus should create
     * improvisation" — and it is the one consequence in the list that the player causes
     * entirely by hand.
     *
     * apparatus: id -> { damage, x, y, angle, waterL, home }
     * tools:     id -> { x, y }   (only the ones left lying in the field) */
    apparatus: {},
    tools: {},
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
    // A condition id, or nothing. Checked against the table rather than trusted, because
    // this is the one field a hand-edited save could use to make up a sixth season.
    lastWeather: CONDITION_IDS.includes(data.lastWeather) ? data.lastWeather : null,
    apparatus: sanitiseApparatus(data.apparatus),
    tools: sanitiseTools(data.tools),
  };
}

/* Positions come back through clampToBounds, not through a range check, because a save
 * is a file a player can edit and a truck at x = 1e9 is a camera that follows it there. */
function sanitiseApparatus(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, rec] of Object.entries(obj)) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.home) { out[id] = { home: true, damage: clamp01(Number(rec.damage) || 0) }; continue; }
    const p = clampToBounds(num(rec.x), num(rec.y), 3);
    out[id] = {
      home: false,
      damage: clamp01(Number(rec.damage) || 0),
      x: p.x, y: p.y,
      angle: Number.isFinite(Number(rec.angle)) ? Number(rec.angle) : 0,
      waterL: Math.max(0, Math.min(99999, Math.round(Number(rec.waterL) || 0))),
    };
  }
  return out;
}

function sanitiseTools(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, rec] of Object.entries(obj)) {
    if (!rec || typeof rec !== 'object') continue;
    const p = clampToBounds(num(rec.x), num(rec.y), 1);
    out[id] = { x: p.x, y: p.y };
    // The counter that eventually gets it collected. Same lesson as the hydrant's
    // shiftsDown: a sanitiser that rebuilds the record without it makes the retrieval
    // arm of advanceShift unreachable through a real save.
    const s = Number(rec.shiftsOut);
    if (Number.isFinite(s) && s > 0) out[id].shiftsOut = Math.min(9, Math.round(s));
  }
  return out;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

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
    // shiftsDown MUST survive a save: it is the only thing that ever repairs a hydrant,
    // and rebuilding the record without it made the repair arm of advanceShift dead code.
    out[id] = { damaged: !!rec.damaged };
    const down = Number(rec.shiftsDown);
    if (Number.isFinite(down) && down > 0) out[id].shiftsDown = Math.min(9, Math.round(down));
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
/**
 * A town's opinion of you fades toward neutral between shifts.
 *
 * Not forgiveness — arithmetic. Losing a call costs more than controlling one pays,
 * and a shift is mostly losses, so confidence measured over five consecutive shifts hit
 * zero on shift three and stayed there for good, for a crew that turned up to
 * everything (tools\_campaigndiag.js). A number that can only fall stops being a signal
 * the moment it lands, and GDD rule 9 asks for recoverable failure: a bad shift has to
 * hurt and a good run afterwards has to show.
 */
function fadeConfidence(c) {
  const T = CONFIG.town;
  return clamp01(c + (T.startConfidence - c) * T.confidenceFadePerShift);
}

export function advanceShift(town, summary) {
  const next = {
    ...town,
    version: SAVE_VERSION,
    shiftNumber: town.shiftNumber + 1,
    confidence: fadeConfidence(clamp01(town.confidence)),
    buildings: {},
    hydrants: {},
    history: [...town.history, summary].slice(-12),
  };

  /* A gutted building is boarded for `repairShifts` shifts and then reopens.
   *
   * It used to be a FIXED POINT, and the town could only ever get worse: boarding was
   * re-set to repairShifts whenever damage was at or above 0.6, and damage was never
   * allowed to fall while boarded — so damage stayed high, so it was boarded again, for
   * ever. Measured over twelve unattended shifts: seven buildings boarded by shift four
   * and all seven STILL boarded on shift thirteen, every record pinned at 2, with the
   * sites available for a structure fire stuck at three out of ten. The countdown has to
   * run on its own, not on a condition the countdown itself keeps true. */
  for (const [id, rec] of Object.entries(town.buildings)) {
    let boarded = rec.boardedShifts || 0;
    let damage = rec.damage;
    if (boarded > 0) {
      boarded -= 1;                       // one shift of the repair goes by
      if (boarded === 0) damage = 0;      // the contractors finish and it reopens
    } else if (damage >= 0.6) {
      boarded = CONFIG.town.repairShifts; // gutted this shift: board it up
    } else {
      damage = Math.max(0, damage - 0.34);  // crews chip away at the lighter stuff
    }
    if (damage <= 0.001 && boarded === 0) continue;   // whole again: forget it
    next.buildings[id] = { damage, boardedShifts: boarded, timesBurned: rec.timesBurned };
  }

  /* The department patches up its own trucks overnight, and the countdown runs the same
   * way the buildings' does: unconditionally, so a bad night is a slow engine for a shift
   * or two rather than a slow engine for ever. A truck that made it back to the apron is
   * also refilled and re-parked; one left in the field is not, and stays where it is.
   *
   * `home` is decided at endShift, where the position is known. Storing the decision
   * rather than the position keeps a tidy truck's record to two fields and means nothing
   * here has to know where the bays are. */
  /* ⚠ AND SOMEBODY GOES AND FETCHES ONE BACK.
   *
   * Without this it is the boarded-building fixed point wearing a different hat: trucks
   * left out make the next shift harder, a harder shift leaves more trucks out, and the
   * station never recovers. Measured over six bot shifts before this line existed —
   * 1 truck out, then 2, then 3 and there it stayed, with town confidence 33% -> 8% ->
   * 0% and never above 1% again. A consequence that makes itself harder to undo is not a
   * consequence, it is a trap, and this codebase has now built the same trap twice.
   *
   * The repair is the countdown, and it is what eventually brings a wrecked truck home:
   * once the department has it back under `undriveableDamage` somebody drives it in. That
   * is the same unconditional-countdown rule the buildings needed — nothing here is
   * gated on a condition the countdown itself keeps true — so a truck abandoned at the
   * far end of the valley is a problem for a shift or two and never for ever. */
  next.apparatus = {};
  for (const [id, rec] of Object.entries(town.apparatus || {})) {
    const damage = Math.max(0, (rec.damage || 0) - CONFIG.town.apparatusRepairPerShift);
    const cameHome = rec.home || damage < CONFIG.town.undriveableDamage;
    if (cameHome) {
      if (damage > 0.001) next.apparatus[id] = { home: true, damage };
    } else {
      next.apparatus[id] = { ...rec, damage };
    }
  }
  /* Kit gets collected too, and on a shorter clock than the trucks.
   *
   * "Nobody goes out looking for it" was the first rule, and it made a dropped chainsaw a
   * permanent loss: it lies in the field, so it is still lying in the field at the next
   * bell, so it re-banks — for ever, with no counter anywhere. Measured over six bot
   * shifts, one tool out on every single one of them and the crew closing 2 calls against
   * a control's 7. A volunteer station does not write off a chainsaw. One shift without
   * it is the consequence; the second morning somebody has been out and got it. */
  next.tools = {};
  for (const [id, rec] of Object.entries(town.tools || {})) {
    const out = (rec.shiftsOut || 0) + 1;
    if (out <= CONFIG.town.toolRetrieveShifts) next.tools[id] = { ...rec, shiftsOut: out };
  }

  /* A struck hydrant is out for the following shift, then the water board gets to it —
   * which never once happened, because sanitiseHydrants rebuilt every record as
   * { damaged } and dropped `shiftsDown` on every load, so the repair arm below was
   * unreachable through a real save. Measured: six save/load cycles, still damaged, and
   * a bot campaign where broken hydrants only ever went up. */
  for (const [id, rec] of Object.entries(town.hydrants)) {
    if (!rec.damaged) continue;
    const down = (rec.shiftsDown || 0) + 1;
    if (down <= CONFIG.town.hydrantDownShifts) next.hydrants[id] = { damaged: true, shiftsDown: down };
    // else: repaired, and simply not carried forward
  }

  return next;
}

function sanitiseLearned(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of CONFIG.coach.lessons) if (obj[k] === true) out[k] = true;
  return out;
}
