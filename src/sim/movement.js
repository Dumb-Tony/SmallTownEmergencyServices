/* Movement — on foot and in the cab. GDD interaction philosophy: "The complexity
 * belongs in the situation, not the control scheme."
 *
 * One rule worth stating out loud, because everything else follows from it:
 * STRUCTURES STOP TRUCKS, NOT PEOPLE. A responder walks into a building through its
 * door and is then contained by its walls until they find the door again. An engine
 * that meets a wall stops, and marks the panel doing it.
 */

import { CONFIG } from '../config.js';
import {
  BUILDINGS, BUILDING_BY_ID, HYDRANTS, clampToBounds, resolveCircleRect,
  circleHitsRect, pointInRect, isOnRoad, dist,
} from '../data/town.js';
import { hazardBlockAt, liveZoneAt } from './hazards.js';

/* ── on foot ──────────────────────────────────────────────────────────────── */

/**
 * @param {{x:number,y:number}} axis  normalised movement intent
 * @param {{x:number,y:number}|null} aim  world point the pointer is over, if any
 */
export function stepPlayerMovement(state, axis, dtMs, aim = null, r = state.player) {
  const p = r;
  const P = CONFIG.player;
  const dt = dtMs / 1000;
  const out = [];

  if (p.stunMs > 0) {
    p.stunMs -= dtMs;
    axis = { x: 0, y: 0 };
  }

  // Aim with the mouse if there is one. Without this the only facings available are
  // the eight the movement keys can produce, which is a real constraint on where a
  // stream can be pointed — see CONFIG.water.streamHalfAngleDeg.
  if (aim) {
    const dx = aim.x - p.x, dy = aim.y - p.y;
    if (dx * dx + dy * dy > 0.09) p.facing = Math.atan2(dy, dx);
  }

  /* A crowd is friction, and it arrives here as a number rather than as an import.
   * `p.crowdDrag` is set once per responder per step in game.js, from
   * residents.js `crowdDragAt` — residents already import this module for resolveOnFoot,
   * and importing back would make a cycle out of a multiplication. It bottoms out at
   * CONFIG.residents.crowdDragMin so pushing through onlookers is always possible:
   * costly, never impossible. */
  const speedMul = (p.draggingVictimId ? P.carrySpeedMul : 1) *
                   (p.toolId && state.toolsById[p.toolId]?.twoHanded ? 0.88 : 1) *
                   (p.crowdDrag || 1);
  const target = P.maxSpeed * speedMul;

  if (axis.x || axis.y) {
    p.vx += axis.x * P.accel * dt;
    p.vy += axis.y * P.accel * dt;
    if (!aim) p.facing = Math.atan2(axis.y, axis.x);
  } else {
    const s = Math.hypot(p.vx, p.vy);
    if (s > 0) {
      const drop = Math.min(s, P.friction * dt);
      p.vx -= (p.vx / s) * drop;
      p.vy -= (p.vy / s) * drop;
    }
  }

  const sp = Math.hypot(p.vx, p.vy);
  if (sp > target) { p.vx = (p.vx / sp) * target; p.vy = (p.vy / sp) * target; }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  resolveOnFoot(p, P.radiusM);

  const c = clampToBounds(p.x, p.y, P.radiusM);
  p.x = c.x; p.y = c.y;

  // A live line does not announce itself politely.
  const zone = liveZoneAt(state, p.x, p.y);
  if (zone && p.stunMs <= 0 && p.shockCooldownMs <= 0) {
    p.stunMs = P.shockStunMs;
    p.shockCooldownMs = P.shockStunMs + 1500;
    const away = Math.atan2(p.y - zone.y, p.x - zone.x);
    p.vx = Math.cos(away) * P.shockKnockback;
    p.vy = Math.sin(away) * P.shockKnockback;
    p.soot = Math.min(1, p.soot + 0.35);
    if (p.draggingVictimId) p.draggingVictimId = null;
    out.push({ type: 'RESPONDER_SHOCKED', hazardId: zone.id });
  }
  if (p.shockCooldownMs > 0) p.shockCooldownMs -= dtMs;

  return out;
}

/** Doors, and the walls that make a door mean something. */
/* Exported because a resident has to be contained by exactly the same walls a responder
 * is. Two implementations of "you leave the way you came in" would eventually disagree,
 * and the disagreement would be a person standing inside a wall. */
export function resolveOnFoot(p, r) {
  if (p.insideBuildingId) {
    const b = BUILDING_BY_ID[p.insideBuildingId];
    const nearDoor = dist(p.x, p.y, b.door.x, b.door.y) < 3.4;
    if (!pointInRect(p.x, p.y, b)) {
      if (nearDoor) { p.insideBuildingId = null; return; }
      // contained: you leave the way you came in
      const cx = Math.min(b.x + b.w - r, Math.max(b.x + r, p.x));
      const cy = Math.min(b.y + b.h - r, Math.max(b.y + r, p.y));
      if (cx !== p.x) p.vx = 0;
      if (cy !== p.y) p.vy = 0;
      p.x = cx; p.y = cy;
    }
    return;
  }

  for (const b of BUILDINGS) {
    if (!circleHitsRect(p.x, p.y, r, b)) continue;
    if (dist(p.x, p.y, b.door.x, b.door.y) < 3.4) {
      if (pointInRect(p.x, p.y, b)) p.insideBuildingId = b.id;
      continue;                                   // walking in through the door
    }
    const fix = resolveCircleRect(p.x, p.y, r, b);
    if (fix) {
      p.x = fix.x; p.y = fix.y;
      if (fix.nx) p.vx = 0;
      if (fix.ny) p.vy = 0;
    }
  }
}

/* ── in the cab ───────────────────────────────────────────────────────────── */

/**
 * @param {{throttle:number, steer:number}} intent  throttle -1..1, steer -1..1
 * @returns {Array<object>} events (collisions, hydrant strikes)
 */
export function stepApparatusMovement(state, ap, intent, dtMs) {
  const def = state.apparatusDefs[ap.defId];
  const D = CONFIG.drive;
  const dt = dtMs / 1000;
  const out = [];

  const onRoad = isOnRoad(ap.x, ap.y);
  const damagePenalty = 1 - Math.min(0.45, ap.damage * 0.5);
  const maxFwd = def.maxSpeed * (onRoad ? 1 : D.offRoadMul) * damagePenalty;
  const maxRev = def.reverseSpeed * (onRoad ? 1 : D.offRoadMul);

  if (intent.throttle > 0) {
    ap.speed += def.accel * intent.throttle * dt;
  } else if (intent.throttle < 0) {
    // one pedal: brakes while moving forward, reverse once stopped
    if (ap.speed > 0.4) ap.speed -= def.brake * dt;
    else ap.speed -= def.accel * D.reverseMul * dt;
  } else {
    const drag = (onRoad ? D.idleDrag : D.offRoadDrag);
    if (ap.speed > 0) ap.speed = Math.max(0, ap.speed - drag * dt);
    else if (ap.speed < 0) ap.speed = Math.min(0, ap.speed + drag * dt);
  }
  ap.speed = Math.min(maxFwd, Math.max(-maxRev, ap.speed));

  // Steering authority falls away with speed, so the engine understeers on Main Street
  // exactly when a player wishes it would not.
  if (intent.steer && Math.abs(ap.speed) > 0.25) {
    const authority = 1 / (1 + Math.abs(ap.speed) / D.steerSpeedFalloff);
    const rate = (D.steerRateDeg * Math.PI) / 180 * authority * def.grip;
    ap.angle += intent.steer * rate * dt * Math.sign(ap.speed);
  }

  const nx = ap.x + Math.cos(ap.angle) * ap.speed * dt;
  const ny = ap.y + Math.sin(ap.angle) * ap.speed * dt;
  const moved = resolveApparatus(state, ap, def, nx, ny, out);
  if (!moved) { /* position already corrected inside */ }

  const c = clampToBounds(ap.x, ap.y, def.widthM / 2);
  if (c.x !== ap.x || c.y !== ap.y) { ap.x = c.x; ap.y = c.y; ap.speed *= 0.2; }

  ap.odometerM += Math.abs(ap.speed) * dt;
  return out;
}

function resolveApparatus(state, ap, def, nx, ny, out) {
  const r = def.widthM / 2 + 0.15;
  const probeD = def.lengthM * 0.34;
  const probes = [
    { x: nx + Math.cos(ap.angle) * probeD, y: ny + Math.sin(ap.angle) * probeD },
    { x: nx - Math.cos(ap.angle) * probeD, y: ny - Math.sin(ap.angle) * probeD },
  ];

  let blocked = null;
  for (const pr of probes) {
    for (const b of BUILDINGS) {
      if (circleHitsRect(pr.x, pr.y, r, b)) { blocked = { kind: 'building', ref: b }; break; }
    }
    if (blocked) break;
    const hz = hazardBlockAt(state, pr.x, pr.y, r);
    if (hz) { blocked = { kind: hz.kind, ref: hz }; break; }
  }

  if (!blocked) {
    ap.x = nx; ap.y = ny;
    checkHydrantStrike(state, ap, out);
    return true;
  }

  const impact = Math.abs(ap.speed);
  ap.speed = -ap.speed * CONFIG.drive.collisionBounce;
  if (impact > CONFIG.drive.collisionFreeSpeed) {
    const dmg = (impact - CONFIG.drive.collisionFreeSpeed) * CONFIG.drive.collisionDamage * 0.01;
    ap.damage = Math.min(1, ap.damage + dmg);
    out.push({
      type: 'APPARATUS_STRUCK', apparatusId: ap.id, into: blocked.kind,
      name: blocked.ref.name || blocked.kind, impact, damage: ap.damage,
    });
  }
  // nudge back along the heading so the body is not left overlapping
  ap.x -= Math.cos(ap.angle) * 0.25 * Math.sign(impact || 1);
  ap.y -= Math.sin(ap.angle) * 0.25 * Math.sign(impact || 1);
  return false;
}

/** Flattening a hydrant is the town's favourite way of teaching you about water supply. */
function checkHydrantStrike(state, ap, out) {
  if (Math.abs(ap.speed) < 6) return;
  for (const h of HYDRANTS) {
    const rec = state.town.hydrants[h.id];
    if (rec && rec.damaged) continue;
    if (dist(ap.x, ap.y, h.x, h.y) < 2.2) {
      state.town.hydrants[h.id] = { ...(rec || {}), damaged: true };
      out.push({ type: 'HYDRANT_STRUCK', hydrantId: h.id, apparatusId: ap.id });
      ap.damage = Math.min(1, ap.damage + 0.06);
      return;
    }
  }
}
