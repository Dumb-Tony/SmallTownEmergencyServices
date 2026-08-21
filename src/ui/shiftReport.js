/* The end-of-shift report. GDD: "End shifts with a factual report and a local-news
 * framing that acknowledges what actually happened."
 *
 * Factual first, and never a scolding. The paper reports what the town saw; it does not
 * tell the crew they played badly. If three buildings burned it says three buildings
 * burned, and that is punishment enough.
 */

import { CONFIG } from '../config.js';
import { BUILDING_BY_ID } from '../data/town.js';

export function buildShiftReport(state) {
  const rows = state.incidents.map((inc) => ({
    id: inc.id,
    headline: inc.headline,
    place: inc.place,
    status: inc.status,
    priority: inc.priority,
    peakDanger: Math.round(inc.peakDanger * 100),
    note: inc.outcomeNote || '—',
    everWorked: inc.everWorked,
    ageMs: inc.ageMs,
  }));

  const damaged = Object.entries(state.town.buildings)
    .filter(([, rec]) => rec.damage > 0.02)
    .map(([id, rec]) => ({ id, name: BUILDING_BY_ID[id]?.name || id, damage: rec.damage }))
    .sort((a, b) => b.damage - a.damage);

  const brokenHydrants = Object.entries(state.town.hydrants)
    .filter(([, rec]) => rec.damaged).map(([id]) => id);

  const o = state.outcome;
  const confidenceEnd = state.town.confidence;
  const report = {
    shiftNumber: state.town.shiftNumber,
    durationMs: state.simTimeMs,
    incidents: rows,
    calls: rows.length,
    controlled: o.controlled,
    lost: o.lost,
    patientsSaved: o.patientsSaved,
    patientsLost: o.patientsLost,
    structuresLost: o.structuresLost,
    /* People who walked out of a burning building by themselves, and people who did not.
       The second number is the one that belongs in a report: the crew did not save the
       ones who got out — but somebody trapped is a search the crew either made or did
       not, and it is the only line here that is about people rather than buildings. */
    residentsOut: o.residentsOut || 0,
    residentsTrapped: o.residentsTrapped || 0,
    damaged,
    brokenHydrants,
    confidenceStart: o.confidenceStart,
    confidenceEnd,
    confidenceDelta: confidenceEnd - o.confidenceStart,
    telemetry: { ...state.telemetry },
    apparatus: state.apparatus.map((a) => ({
      name: a.name, damage: a.damage, km: a.odometerM / 1000, waterL: Math.round(a.waterL),
    })),

    /* The town you will walk back into.
     *
     * The card used to end on the sentence "damage and broken hydrants carry into the
     * next shift" — a claim with nothing behind it. Phase 4's gate is that a player
     * cares about a previous mistake, and a mistake nobody is shown is a mistake nobody
     * can care about. These are the consequences, named, at the moment they are handed
     * over. */
    nextShift: {
      boarded: damaged
        .map((d) => ({ ...d, boardedShifts: (state.town.buildings[d.id] || {}).boardedShifts || 0 }))
        .filter((d) => d.boardedShifts > 0 || d.damage >= 0.6),
      stillDamaged: damaged.filter((d) => d.damage > 0.02 && d.damage < 0.6),
      hydrantsOut: brokenHydrants.length,
      history: (state.town.history || []).slice(-3),
    },
  };

  report.headline = headlineFor(report, damaged, state.outcome.structuresLostNames || []);
  report.standfirst = standfirstFor(report);
  return report;
}

function headlineFor(r, damaged, lostThisShift) {
  /* What burned down TODAY. `damaged` is the town's ACCUMULATED damage table and still
     holds every building ever gutted, so reading the worst entry out of it reported the
     same loss as fresh news five shifts running — measured, five identical headlines in
     a row (tools\_campaigndiag.js). */
  if (lostThisShift.length) {
    return lostThisShift.length === 1
      ? `${lostThisShift[0]} destroyed in shift ${r.shiftNumber} fire`
      : `${lostThisShift.length} buildings lost in shift ${r.shiftNumber}`;
  }
  if (r.patientsLost > 0) return `Town mourns after ${r.calls}-call shift stretches volunteers thin`;
  /* Somebody who did not get out and WAS reached is the best thing that happens in this
     game, and the headline had no way of saying it — a rescue scored identically to a
     quiet shift. It sits below patientsLost, because a shift with both in it is not a
     good-news story. */
  if (r.residentsTrapped > 0 && r.patientsSaved > 0) {
    const at = (r.incidents.find((i) => i.headline.toLowerCase().includes('fire')) || {}).place;
    return `Volunteers reach ${r.patientsSaved === 1 ? 'resident' : `${r.patientsSaved} residents`}` +
      `${at ? ` trapped in ${at}` : ' trapped in burning building'}`;
  }
  if (r.lost > 0 && damaged.length) return `${damaged[0].name} damaged as calls stack up`;
  if (r.lost > 0) return `Volunteers overrun as ${r.lost} call${r.lost > 1 ? 's get' : ' gets'} away from them`;
  if (r.calls === 0) return 'A quiet shift at the volunteer station';
  if (r.patientsSaved > 0) return `Volunteer crew clears ${r.controlled} calls, ${r.patientsSaved} to the clinic`;
  return `Volunteer crew clears ${r.controlled} call${r.controlled === 1 ? '' : 's'} without incident`;
}

function standfirstFor(r) {
  const bits = [];
  bits.push(`${r.calls} call${r.calls === 1 ? '' : 's'} in ${Math.round(r.durationMs / 60000)} minutes`);
  if (r.controlled) bits.push(`${r.controlled} brought under control`);
  if (r.lost) bits.push(`${r.lost} lost`);
  if (r.patientsSaved) bits.push(`${r.patientsSaved} transported`);
  if (r.patientsLost) bits.push(`${r.patientsLost} not reached in time`);
  if (r.residentsOut) bits.push(`${r.residentsOut} out of a burning building by themselves`);
  if (r.residentsTrapped) {
    bits.push(`${r.residentsTrapped} did not get out unaided`);
  }
  if (r.telemetry.callsNeverWorked) bits.push(`${r.telemetry.callsNeverWorked} never attended`);
  bits.push(`${(r.telemetry.distanceDrivenM / 1000).toFixed(1)} km driven`);
  return `${bits.join(' · ')}.`;
}

/** Town confidence as a phrase, for the HUD and the report. Deliberately not the word
 *  "patient" — it sat two centimetres from the patient count in the HUD and read as a
 *  casualty tally. */
export function confidenceWord(c) {
  if (c >= 0.85) return 'proud of you';
  if (c >= 0.68) return 'confident';
  if (c >= 0.5) return 'giving you time';
  if (c >= 0.32) return 'uneasy';
  if (c >= 0.15) return 'losing faith';
  return 'talking about a paid service';
}

export const CONFIDENCE_BANDS = Object.freeze([0.15, 0.32, 0.5, 0.68, 0.85]);
export const REPAIR_SHIFTS = CONFIG.town.repairShifts;
