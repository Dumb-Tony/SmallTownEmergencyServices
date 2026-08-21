/* Interaction — the five verbs. GDD: "Primary verbs: move, grab/equip, use,
 * enter/exit, carry/drag, radio." and "Keep controls readable."
 *
 *   E      contextual: grab or release a patient, load them, get in, get out
 *   SPACE  use whatever is in your hands, on whatever is in front of you
 *   1..5   take a numbered item out of the nearest compartment or off the ground
 *   F      put down what you are holding
 *
 * Everything is proximity-and-facing based. That is an admitted prototype shortcut
 * (GDD "deliberate simplifications"), but the DATA is already physical: a tool that is
 * put down stays where it was put down, and the nozzle is a point in the world tethered
 * to a real engine parked in a real place.
 */

import { CONFIG } from '../config.js';
import { TOOL_DEFS } from '../data/equipment.js';
import { HYDRANTS, POLES, CLINIC, dist, nearestOf } from '../data/town.js';
import { applyWater } from './hazards.js';
import { treatVictim, victimHandled } from './victims.js';
import { weatherFor } from './weather.js';

export function heldTool(state, r = state.player) {
  return r && r.toolId ? state.tools.find((t) => t.id === r.toolId) : null;
}

/**
 * Everything within arm's reach, in the order the HUD numbers it.
 *
 * GROUND FIRST, then the apron rack, then compartments — nearest first inside each
 * group. Put a saw down at your feet and it is slot 1, because that is where a player
 * looks for it. The first version listed compartments first, so the tool you had just
 * dropped came sixth and could not be picked up at all beside a loaded truck.
 */
export function toolsInReachOf(state, x, y, radius = 3.6) {
  const ground = [];
  for (const t of state.tools) {
    if (t.carrier !== null) continue;
    const d = dist(x, y, t.x, t.y);
    if (d <= radius) ground.push({ tool: t, from: 'the ground', sourceId: null, d });
  }

  const rack = [];
  if (dist(x, y, state.rack.x, state.rack.y) <= radius + 1.5) {
    for (const t of state.tools) {
      if (t.carrier === 'rack') rack.push({ tool: t, from: 'the apron rack', sourceId: 'rack', d: 0 });
    }
  }

  const stowed = [];
  for (const ap of state.apparatus) {
    const d = dist(x, y, ap.x, ap.y);
    if (d > radius + 2.4) continue;
    for (const t of state.tools) {
      if (t.carrier === ap.id) stowed.push({ tool: t, from: ap.name, sourceId: ap.id, d });
    }
  }

  ground.sort((a, b) => a.d - b.d);
  stowed.sort((a, b) => a.d - b.d);
  return [...ground, ...rack, ...stowed];
}

/** What E would do right now — the HUD prints this, so the prompt is never a guess. */
export function contextPrompt(state, r = state.player) {
  const p = r;
  if (p.inVehicleId) {
    const ap = state.apparatus.find((a) => a.id === p.inVehicleId);
    return { key: 'E', text: `get out of ${ap.name}` };
  }
  if (p.draggingVictimId) {
    const amb = nearAmbulance(state, p);
    if (amb) return { key: 'E', text: `load patient into ${amb.name}` };
    return { key: 'E', text: 'let the patient down' };
  }
  const v = grabbableVictim(state, p);
  if (v) return { key: 'E', text: 'take hold of the patient' };
  const ap = nearestApparatus(state, p, CONFIG.player.reachM + 2.2);
  if (ap) return { key: 'E', text: `get into ${ap.name}` };
  return null;
}

function nearestApparatus(state, p, radius) {
  let best = null, bestD = radius;
  for (const a of state.apparatus) {
    const d = dist(p.x, p.y, a.x, a.y) - state.apparatusDefs[a.defId].lengthM * 0.3;
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

function nearAmbulance(state, p) {
  for (const a of state.apparatus) {
    const def = state.apparatusDefs[a.defId];
    if (!def.patientBay || a.patientId) continue;
    if (dist(p.x, p.y, a.x, a.y) < CONFIG.player.reachM + 2.4) return a;
  }
  return null;
}

function grabbableVictim(state, p) {
  let best = null, bestD = CONFIG.player.reachM + 0.8;
  for (const v of state.victims) {
    if (v.lost || v.delivered || v.trappedBy || v.inApparatusId) continue;
    // Somebody already has them. Two people cannot carry one casualty, and without
    // this the second responder silently took the patient out of the first one's arms
    // — the patient stayed put and the first crew member kept walking, "dragging"
    // nobody. There is one of them, so there is one pair of hands on them.
    if (v.draggedBy && v.draggedBy !== p.id) continue;
    const d = dist(p.x, p.y, v.x, v.y);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/* ── the verbs ────────────────────────────────────────────────────────────── */

/**
 * @param {{interact:boolean, drop:boolean, use:boolean, siren:boolean, slot:number|null}} cmd
 * @returns {Array<object>} events
 */
export function stepInteraction(state, cmd, dtMs, r = state.player) {
  const out = [];
  const p = r;

  // Streams are re-asserted every step by whoever is squeezing the trigger, so the
  // renderer never draws water that stopped flowing three steps ago. Each responder
  // clears only their OWN nozzle: this runs once per responder, and clearing the whole
  // list meant the second crew member silenced the first one's line every step.
  for (const t of state.tools) if (t.carrier === null || t.carrier === p.id) t.flowing = false;

  if (p.stunMs > 0) { p.useProgressMs = 0; return out; }

  if (cmd.interact) doInteract(state, p, out);
  if (cmd.drop) doDrop(state, p, out);
  if (cmd.slot != null) doTakeSlot(state, p, cmd.slot, out);
  if (cmd.siren && p.inVehicleId) {
    const ap = state.apparatus.find((a) => a.id === p.inVehicleId);
    ap.siren = !ap.siren;
    out.push({ type: 'SIREN_TOGGLED', apparatusId: ap.id, on: ap.siren });
  }

  if (cmd.use && !p.inVehicleId) doUse(state, p, dtMs, out);
  else p.useProgressMs = 0;

  applyHoseTether(state, p, out);
  applyWaterSupply(state, dtMs);

  return out;
}

function doInteract(state, p, out) {

  if (p.inVehicleId) {
    const ap = state.apparatus.find((a) => a.id === p.inVehicleId);
    if (ap.driverId === p.id) ap.driverId = null;
    ap.passengerIds = ap.passengerIds.filter((id) => id !== p.id);
    p.inVehicleId = null;
    const side = ap.angle + Math.PI / 2;
    p.x = ap.x + Math.cos(side) * 2.4;
    p.y = ap.y + Math.sin(side) * 2.4;
    p.vx = 0; p.vy = 0;
    out.push({ type: 'EXITED_APPARATUS', apparatusId: ap.id });
    return;
  }

  if (p.draggingVictimId) {
    const v = state.victims.find((x) => x.id === p.draggingVictimId);
    const amb = nearAmbulance(state, p);
    if (amb && v) {
      v.inApparatusId = amb.id;
      v.draggedBy = null;
      amb.patientId = v.id;
      p.draggingVictimId = null;
      out.push({ type: 'PATIENT_LOADED', victimId: v.id, apparatusId: amb.id });
    } else {
      if (v) v.draggedBy = null;
      p.draggingVictimId = null;
      out.push({ type: 'PATIENT_RELEASED', victimId: v ? v.id : null });
    }
    return;
  }

  const v = grabbableVictim(state, p);
  if (v) {
    // Hands are needed for this. Dropping the saw to move a patient is the point.
    if (p.toolId) doDrop(state, p, out);
    v.draggedBy = p.id;
    p.draggingVictimId = v.id;
    out.push({ type: 'PATIENT_GRABBED', victimId: v.id });
    return;
  }

  const ap = nearestApparatus(state, p, CONFIG.player.reachM + 2.2);
  if (ap) {
    if (p.toolId) {
      const t = heldTool(state, p);
      if (t && t.defId === 'hose') doDrop(state, p, out);   // the nozzle stays outside
      else { t.carrier = ap.id; p.toolId = null; }          // stow what you are carrying
    }
    /* First in gets the wheel; anyone after that rides.
     *
     * This is the whole of apparatus contention, and it is a property of the seating
     * rather than a rule: two people cannot drive one truck, but they CAN arrive
     * together — which is the difference between co-op and two people playing beside
     * each other. Whoever is driving is also the one holding everyone else hostage
     * when they park badly, which is the story the GDD is asking for. */
    const takingTheWheel = !ap.driverId;
    if (takingTheWheel) ap.driverId = p.id;
    else if (!ap.passengerIds.includes(p.id)) ap.passengerIds.push(p.id);
    p.inVehicleId = ap.id;
    p.vx = 0; p.vy = 0;
    out.push({ type: 'ENTERED_APPARATUS', apparatusId: ap.id, driving: takingTheWheel, responderId: p.id });
  }
}

function doDrop(state, p, out) {
  const t = heldTool(state, p);
  if (!t) return;
  t.carrier = null;
  t.x = p.x + Math.cos(p.facing) * CONFIG.tools.dropOffsetM;
  t.y = p.y + Math.sin(p.facing) * CONFIG.tools.dropOffsetM;
  p.toolId = null;
  p.useProgressMs = 0;
  out.push({ type: 'TOOL_DROPPED', toolId: t.id, defId: t.defId, x: t.x, y: t.y });
}

function doTakeSlot(state, p, slot, out) {
  if (p.inVehicleId) return;
  const avail = toolsInReachOf(state, p.x, p.y);
  if (slot < 0 || slot >= avail.length) {
    out.push({ type: 'NOTHING_IN_SLOT', slot });
    return;
  }
  if (p.toolId) doDrop(state, p, out);
  if (p.draggingVictimId) doInteract(state, p, out);   // both hands, again
  const { tool } = avail[slot];
  tool.carrier = p.id;
  tool.x = p.x; tool.y = p.y;
  p.toolId = tool.id;
  out.push({ type: 'TOOL_TAKEN', toolId: tool.id, defId: tool.defId });
}

/* ── use ──────────────────────────────────────────────────────────────────── */

function doUse(state, p, dtMs, out) {
  const t = heldTool(state, p);
  if (!t) { p.useProgressMs = 0; return; }
  const def = TOOL_DEFS[t.defId];

  if (def.mode === 'stream') { useStream(state, p, t, def, dtMs, out); return; }
  if (def.mode === 'passive') { p.useProgressMs = 0; return; }

  const target = holdTarget(state, t.defId, p);
  if (!target) {
    p.useProgressMs = 0;
    if (!p.wrongToolNotedAt || state.simTimeMs - p.wrongToolNotedAt > 2000) {
      p.wrongToolNotedAt = state.simTimeMs;
      state.telemetry.wrongToolAttempts++;
      out.push({ type: 'NO_TARGET', defId: t.defId });
    }
    return;
  }

  // Switching target abandons the progress. Half-turning one gas valve does not
  // half-turn the next one.
  if (p.useTargetId !== target.id) p.useProgressMs = 0;
  p.useProgressMs += dtMs;
  p.useTargetId = target.id;

  switch (t.defId) {
    case 'medkit': {
      if (treatVictim(state, target, dtMs)) {
        p.useProgressMs = 0;
        out.push({ type: 'PATIENT_TREATED', victimId: target.id });
      }
      break;
    }
    case 'spreaders': {
      target.extricateProgress += dtMs;
      if (target.extricateProgress >= CONFIG.medical.extricateMs) {
        const wreckId = target.trappedBy;
        target.trappedBy = null;
        target.extricateProgress = 0;
        p.useProgressMs = 0;
        const w = state.hazards.find((h) => h.id === wreckId);
        if (w) w.occupantIds = w.occupantIds.filter((id) => id !== target.id);
        out.push({ type: 'PATIENT_EXTRICATED', victimId: target.id });
      }
      break;
    }
    case 'chainsaw': {
      target.cut = Math.min(1, target.cut + CONFIG.tools.chainsawCutPerSec * (dtMs / 1000));
      if (target.cut >= 1 && !target.cleared) {
        target.cleared = true; target.resolved = true;
        p.useProgressMs = 0;
        out.push({ type: 'ROAD_CLEARED', hazardId: target.id, roadId: target.roadId });
      }
      break;
    }
    case 'hotstick': {
      if (p.useProgressMs >= CONFIG.tools.hotstickMs) {
        target.live = false; target.resolved = true; target.wet = 0;
        p.useProgressMs = 0;
        out.push({ type: 'LINE_DE_ENERGISED', hazardId: target.id });
      }
      break;
    }
    case 'wrench': {
      if (p.useProgressMs >= CONFIG.tools.wrenchTurnMs) {
        p.useProgressMs = 0;
        if (target._fixture === 'hydrant') {
          /* ⚠ THE NEAREST TRUCK, NOT THE FIRST ONE IN THE LIST. `find` was correct while
           * exactly one appliance carried water; with a tanker there are two, and turning
           * the wrench beside the tanker would have charged the ENGINE parked across town
           * — because the engine is earlier in APPARATUS_DEFS. The same shape as every
           * other two-case rule that broke when a third case turned up. */
          const eng = state.apparatus
            .filter((a) => state.apparatusDefs[a.defId].tankL > 0 &&
              dist(a.x, a.y, target.x, target.y) <= CONFIG.water.hydrantHookupM)
            .sort((a, b) => dist(a.x, a.y, target.x, target.y) - dist(b.x, b.y, target.x, target.y))[0];
          if (eng) {
            eng.hydrantId = target.id;
            out.push({ type: 'HYDRANT_CHARGED', hydrantId: target.id, apparatusId: eng.id });
          }
        } else if (target._fixture === 'gas') {
          target.shutOff = true;
          out.push({ type: 'GAS_SHUT_OFF', hazardId: target.id });
        }
      }
      break;
    }
    default: p.useProgressMs = 0;
  }
}

/** The one place that answers "what is this tool for, right here?". */
export function holdTarget(state, defId, p = state.player) {
  const reach = CONFIG.player.reachM + 0.8;

  if (defId === 'medkit') {
    let best = null, bestD = reach;
    for (const v of state.victims) {
      if (v.lost || v.delivered) continue;
      if (victimHandled(v) && v.condition > 0.9) continue;
      const d = dist(p.x, p.y, v.x, v.y);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  if (defId === 'spreaders') {
    let best = null, bestD = reach;
    for (const v of state.victims) {
      if (!v.trappedBy || v.lost) continue;
      const d = dist(p.x, p.y, v.x, v.y);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  if (defId === 'chainsaw') {
    let best = null, bestD = reach + 4.2;   // you cut from the end of the trunk
    for (const h of state.hazards) {
      if (h.kind !== 'tree' || h.cleared) continue;
      const d = dist(p.x, p.y, h.x, h.y);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  if (defId === 'hotstick') {
    // Worked from the POLE, which is the point: the safe place to stand is not the
    // place the wire is lying.
    let best = null, bestD = reach + 1.4;
    for (const h of state.hazards) {
      if (h.kind !== 'power' || !h.live) continue;
      const pole = POLES.find((q) => q.id === h.poleId);
      if (!pole) continue;
      const d = dist(p.x, p.y, pole.x, pole.y);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  if (defId === 'wrench') {
    const hyd = nearestOf(HYDRANTS, p.x, p.y, (h) => !(state.town.hydrants[h.id] || {}).damaged);
    if (hyd && hyd.distM < reach + 0.6) return { ...hyd.item, _fixture: 'hydrant', id: hyd.item.id, x: hyd.item.x, y: hyd.item.y };
    let best = null, bestD = reach + 0.6;
    for (const h of state.hazards) {
      if (h.kind !== 'gas' || h.shutOff) continue;
      const d = dist(p.x, p.y, h.x, h.y);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best) { best._fixture = 'gas'; return best; }
    return null;
  }

  return null;
}

function useStream(state, p, tool, def, dtMs, out) {
  const dt = dtMs / 1000;
  const dirX = Math.cos(p.facing), dirY = Math.sin(p.facing);
  const ox = p.x + dirX * 0.8, oy = p.y + dirY * 0.8;

  if (tool.defId === 'hose') {
    const eng = state.apparatus.find((a) => a.id === tool.engineId);
    if (!eng) return;
    if (eng.waterL <= 0) {
      if (!p.dryNotedAt || state.simTimeMs - p.dryNotedAt > 4000) {
        p.dryNotedAt = state.simTimeMs;
        out.push({ type: 'TANK_DRY', apparatusId: eng.id });
      }
      return;
    }
    const litres = Math.min(eng.waterL, CONFIG.water.nozzleFlowLps * dt);
    eng.waterL -= litres;
    tool.flowing = true;
    state.telemetry.litresUsed += litres;
    const res = applyWater(state, ox, oy, dirX, dirY, litres, CONFIG.water.streamReachM);
    if (res.cooled > 0) state.telemetry.waterOnTarget += res.cooled;
    return;
  }

  if (tool.defId === 'extinguisher') {
    if (tool.chargeL <= 0) return;
    const litres = Math.min(tool.chargeL, CONFIG.tools.extinguisherFlowLps * dt);
    tool.chargeL -= litres;
    tool.flowing = true;
    applyWater(state, ox, oy, dirX, dirY, litres * 2.2, 4.6);   // agent punches above its volume
    if (tool.chargeL <= 0) out.push({ type: 'EXTINGUISHER_EMPTY', toolId: tool.id });
  }
}

/* ── hose and supply ──────────────────────────────────────────────────────── */

/** The hose is a leash. Walk past its length and you stop, whatever you meant to do. */
function applyHoseTether(state, p, out) {
  const t = heldTool(state, p);
  if (!t || t.defId !== 'hose') return;

  const eng = state.apparatus.find((a) => a.id === t.engineId);
  if (!eng) return;
  const d = dist(p.x, p.y, eng.x, eng.y);
  t.x = p.x; t.y = p.y;
  t.deployedM = d;

  if (d > CONFIG.water.hoseMaxLengthM) {
    const k = CONFIG.water.hoseMaxLengthM / d;
    p.x = eng.x + (p.x - eng.x) * k;
    p.y = eng.y + (p.y - eng.y) * k;
    p.vx *= 0.2; p.vy *= 0.2;
    t.x = p.x; t.y = p.y;
    if (!p.tautNotedAt || state.simTimeMs - p.tautNotedAt > 5000) {
      p.tautNotedAt = state.simTimeMs;
      out.push({ type: 'HOSE_TAUT', apparatusId: eng.id });
    }
  }
}

function applyWaterSupply(state, dtMs) {
  for (const ap of state.apparatus) {
    const def = state.apparatusDefs[ap.defId];
    if (!def.tankL || !ap.hydrantId) continue;
    const hyd = HYDRANTS.find((h) => h.id === ap.hydrantId);
    const rec = state.town.hydrants[ap.hydrantId] || {};
    // Drive away from the hydrant you charged and the supply is simply gone.
    if (!hyd || rec.damaged || dist(ap.x, ap.y, hyd.x, hyd.y) > CONFIG.water.hydrantHookupM + 2) {
      ap.hydrantId = null;
      continue;
    }
    // Half-frozen mains in a cold snap; 1.0 in everything else.
    ap.waterL = Math.min(def.tankL, ap.waterL +
      CONFIG.water.hydrantSupplyLps * weatherFor(state).hydrantFlow * (dtMs / 1000));
  }
  applyTankerSupply(state, dtMs);
}

/**
 * A tanker parked beside the engine feeds it.
 *
 * The whole reason the fourth appliance exists — though NOT for the reason I built it.
 * m16 section D measured the claim I had written here first ("a barn fire is won on the
 * tank you arrived with or not at all") and it is false: a crew that works the fire with
 * a walking nozzle puts every structure in this town out on under 1500 L, and the engine
 * carries 2500. No SINGLE call needs a tanker.
 *
 * A SHIFT does. Three structure fires at the far end of the valley and the engine is dry
 * on the third, 33-57 m from the nearest hydrant, and the hookup radius is seven metres —
 * so refilling means dropping the line, driving the truck out of the fire, charging a
 * hydrant, filling and driving back. Measured: 114 seconds, during which the building
 * burns unopposed and nine more points of it are lost. That is what this buys.
 *
 * It is deliberately SLOWER than a hydrant (a hydrant is mains pressure; this is a pump
 * between two trucks) and it costs the tanker exactly what it gives, so the shuttle is a
 * real round trip rather than a second hydrant that happens to be parked. No hose, no
 * nozzle, no way for the tanker to put a drop on a fire by itself.
 */
function applyTankerSupply(state, dtMs) {
  const W = CONFIG.water;
  for (const src of state.apparatus) {
    if (!state.apparatusDefs[src.defId].supplies || src.waterL <= 0) continue;
    for (const dst of state.apparatus) {
      if (dst === src) continue;
      const dstDef = state.apparatusDefs[dst.defId];
      // Only into something that can actually use it, and only if it has room.
      if (!dstDef.hose || dst.waterL >= dstDef.tankL) continue;
      if (dist(src.x, src.y, dst.x, dst.y) > W.tankerTransferM) continue;
      const moved = Math.min(
        W.tankerTransferLps * (dtMs / 1000),
        src.waterL,
        dstDef.tankL - dst.waterL);
      src.waterL -= moved;
      dst.waterL += moved;
      dst.suppliedBy = src.id;
      break;                       // one truck feeds one truck: a pump has one outlet
    }
  }
  // Nobody is being fed unless they were fed THIS step — the HUD reads this, and a stale
  // flag is a player told they have water coming when the tanker drove off.
  for (const ap of state.apparatus) {
    if (ap.suppliedBy && !state.apparatus.some((q) => q.id === ap.suppliedBy &&
        dist(q.x, q.y, ap.x, ap.y) <= W.tankerTransferM && q.waterL > 0)) {
      ap.suppliedBy = null;
    }
  }
}

/** Distance from the clinic doors — the ambulance HUD shows it while a patient is aboard. */
export function clinicDistance(state, ap) { return dist(ap.x, ap.y, CLINIC.x, CLINIC.y); }
