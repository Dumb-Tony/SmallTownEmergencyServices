/* People. GDD: "readable states (stable, injured, critical, unconscious, trapped),
 * simple interventions that buy time" and "NPCs: health, panic, mobility,
 * self-preservation, bad decisions".
 *
 * A patient's condition falls on a clock that does not care where the crew is. Treating
 * them slows the fall; it never reverses the situation. Only the clinic ends it. That
 * is the whole medical model, and it is deliberately thin so that the interesting
 * decision stays "which of these two do I go to first".
 */

import { CONFIG } from '../config.js';
import { BUILDING_BY_ID, CLINIC, dist, clampToBounds } from '../data/town.js';
import { heatAt, liveZoneAt } from './hazards.js';

let nextId = 1;
export function resetVictimIds() { nextId = 1; }

const START_CONDITION = { stable: 1.0, injured: 0.80, critical: 0.56 };

export function createVictim({ incidentId, x, y, severity = 'injured', trappedBy = null,
                               insideBuildingId = null, panics = false }) {
  return {
    id: `vic${nextId++}`, incidentId, x, y,
    severity,
    condition: START_CONDITION[severity] ?? 0.8,
    trappedBy,
    insideBuildingId,
    panics,
    fleeing: false,
    treatedAtMs: null,
    stabilisedUntilMs: 0,
    draggedBy: null,        // a responder id, or null
    inApparatusId: null,
    delivered: false,
    lost: false,
    shocked: 0,
    extricateProgress: 0,
  };
}

/** What the HUD and the dispatch card call this person right now. */
export function victimState(v) {
  if (v.lost) return 'lost';
  if (v.delivered) return 'transported';
  if (v.condition <= 0.18) return 'unconscious';
  if (v.condition < CONFIG.medical.criticalAt) return 'critical';
  if (v.condition < 0.72) return 'injured';
  return 'stable';
}

/** True once this patient no longer needs anything from the crew. */
export function victimHandled(v) {
  if (v.lost || v.delivered) return true;
  if (v.trappedBy) return false;
  if (v.severity === 'stable' && !v.needsTransport) return true;
  if (v.needsTransport) return false;
  return v.treatedAtMs != null && v.condition >= CONFIG.medical.criticalAt;
}

export function victimNeedsTransport(v) { return !!v.needsTransport; }

/**
 * One step for every person in the world.
 * @returns {Array<object>} events: patients lost, patients delivered, evacuations.
 */
export function stepVictims(state, dtMs) {
  const dt = dtMs / 1000;
  const M = CONFIG.medical;
  const out = [];

  for (const v of state.victims) {
    if (v.lost || v.delivered) continue;

    /* position: carried, loaded, fleeing, or standing where they fell.
     * `draggedBy` is a responder id, so a patient cannot be held by two people, and
     * a crew member who leaves mid-shift puts them down rather than towing them
     * around by a dangling reference. */
    const carrier = v.draggedBy
      ? state.responders.find((q) => q.id === v.draggedBy) : null;
    if (v.draggedBy && !carrier) v.draggedBy = null;

    if (carrier) {
      v.x = carrier.x - Math.cos(carrier.facing) * 1.0;
      v.y = carrier.y - Math.sin(carrier.facing) * 1.0;
    } else if (v.inApparatusId) {
      const a = state.apparatus.find((ap) => ap.id === v.inApparatusId);
      if (a) { v.x = a.x; v.y = a.y; }
      if (a && dist(a.x, a.y, CLINIC.x, CLINIC.y) < CLINIC.radiusM && a.speed < 3) {
        v.handoverMs = (v.handoverMs || 0) + dtMs;
        if (v.handoverMs >= M.clinicHandoverMs) {
          v.delivered = true; v.inApparatusId = null;
          a.patientId = null;
          out.push({ type: 'PATIENT_DELIVERED', victimId: v.id, incidentId: v.incidentId });
          continue;
        }
      } else v.handoverMs = 0;
    } else if (v.fleeing) {
      // Self-preservation, badly executed: they head for the door they came in by.
      const b = v.insideBuildingId ? BUILDING_BY_ID[v.insideBuildingId] : null;
      const tx = b ? b.door.x : v.x, ty = b ? b.door.y + 6 : v.y + 6;
      const d = dist(v.x, v.y, tx, ty);
      if (d > 0.5) {
        const sp = 2.6 * dt;
        v.x += ((tx - v.x) / d) * sp;
        v.y += ((ty - v.y) / d) * sp;
      } else {
        v.fleeing = false; v.insideBuildingId = null;
      }
    }

    const clamped = clampToBounds(v.x, v.y, 0.4);
    v.x = clamped.x; v.y = clamped.y;

    /* condition: the clock that ignores the crew */
    let decline = M.declineStable;
    if (v.severity === 'injured') decline = M.declineInjured;
    else if (v.severity === 'critical') decline = M.declineCritical;

    if (v.trappedBy) decline *= M.declineTrappedMul;
    const heat = heatAt(state, v.x, v.y);
    if (heat > 0.15) decline *= 1 + (M.declineFireMul - 1) * Math.min(1, heat);
    if (state.simTimeMs < v.stabilisedUntilMs) decline *= M.treatDeclineMul;
    if (v.inApparatusId) decline *= 0.45;   // in the back of the ambulance, on oxygen

    v.condition = Math.max(0, v.condition - decline * dt);
    if (v.condition < M.criticalAt) v.needsTransport = true;

    /* panic evacuation: a stable occupant will leave a building that is alight */
    if (v.panics && !v.fleeing && v.insideBuildingId && !v.trappedBy && heat > 0.12) {
      v.fleeing = true;
      out.push({ type: 'OCCUPANT_EVACUATING', victimId: v.id, incidentId: v.incidentId });
    }

    /* live wires do not care that someone is already having a bad day */
    // Reported once. A casualty lying inside a live zone is not news every two
    // seconds, and the radio said so five times in a row before this guard existed.
    const zone = liveZoneAt(state, v.x, v.y);
    if (zone && v.shocked <= 0) {
      v.shocked = 2000;
      v.condition = Math.max(0, v.condition - 0.10);
      v.needsTransport = true;
      if (!v.shockReported) {
        v.shockReported = true;
        out.push({ type: 'VICTIM_SHOCKED', victimId: v.id, incidentId: v.incidentId });
      }
    }
    if (v.shocked > 0) v.shocked -= dtMs;

    if (v.condition <= 0) {
      v.lost = true;
      v.draggedBy = null;
      out.push({ type: 'PATIENT_LOST', victimId: v.id, incidentId: v.incidentId });
    }
  }

  return out;
}

/** Apply one step of medical-kit treatment. Returns true when the treatment completes. */
export function treatVictim(state, v, dtMs) {
  v.treatProgress = (v.treatProgress || 0) + dtMs;
  if (v.treatProgress < CONFIG.medical.treatMs) return false;
  v.treatProgress = 0;
  v.treatedAtMs = state.simTimeMs;
  v.stabilisedUntilMs = state.simTimeMs + CONFIG.medical.treatDurationMs;
  v.condition = Math.min(1, v.condition + CONFIG.medical.treatGain);
  return true;
}
