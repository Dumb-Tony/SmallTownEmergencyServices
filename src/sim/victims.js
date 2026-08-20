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

/**
 * True once this patient no longer needs anything from the crew AT THE SCENE.
 *
 * Being in the back of the ambulance counts. A call is under control when the scene is
 * clear and the casualty is packaged — not when the ambulance finally reaches the
 * clinic on the far side of town. Holding the incident open until handover made the
 * crash and medical families unclosable: measured over six shifts, 11 crashes worked
 * and 0 controlled, because the round trip costs more of a ten-minute shift than the
 * whole rest of the response put together.
 *
 * The transport still matters — they keep declining in the truck and the delivery is
 * what saves them — it just stops being the incident's problem.
 */
export function victimHandled(v) {
  if (v.lost || v.delivered) return true;
  if (v.inApparatusId) return true;
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

    /* A live wire down across the car is a barrier to REACHING them, which is what the
     * GDD asks of the utility family — not an execution.
     *
     * It used to take 10% of a casualty's condition every two seconds, which is 5% a
     * second against a critical decline of 0.26% a second: twenty times the rate that
     * defines the family. Measured, they died 14 s after appearing, and the fastest a
     * crew has ever reached anyone is 25 s. `crash_pole` is a CRITICAL-priority call
     * that a player could not save by any play at all — turn up instantly, drive
     * perfectly, kill the power first, and the patient is dead before you arrive. The
     * throttle around it looked like it fixed this; it only stopped the radio spam.
     *
     * Now: the first contact hurts them once (it is why they are a casualty), and
     * lying in the zone makes them decline faster while they are in it. */
    const zone = liveZoneAt(state, v.x, v.y);
    if (zone) decline *= M.declineLiveMul;
    if (state.simTimeMs < v.stabilisedUntilMs) decline *= M.treatDeclineMul;
    if (v.inApparatusId) decline *= 0.45;   // in the back of the ambulance, on oxygen

    v.condition = Math.max(0, v.condition - decline * dt);
    if (v.condition < M.criticalAt) v.needsTransport = true;

    /* panic evacuation: a stable occupant will leave a building that is alight */
    if (v.panics && !v.fleeing && v.insideBuildingId && !v.trappedBy && heat > 0.12) {
      v.fleeing = true;
      out.push({ type: 'OCCUPANT_EVACUATING', victimId: v.id, incidentId: v.incidentId });
    }

    /* live wires do not care that someone is already having a bad day — once. The
       repeat damage is gone (see declineLiveMul above); the first contact still costs
       them, still calls for a ride, and is still reported once rather than every two
       seconds, which is what the guard was actually for. */
    if (zone && !v.shockReported) {
      v.shockReported = true;
      v.shocked = 2000;
      v.condition = Math.max(0, v.condition - M.shockCost);
      v.needsTransport = true;
      out.push({ type: 'VICTIM_SHOCKED', victimId: v.id, incidentId: v.incidentId });
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
