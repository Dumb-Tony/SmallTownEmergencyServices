/* Incidents — the layer that turns hazards into a call with a story.
 *
 * The GDD's data model, near enough verbatim: family, location, priority, report, age,
 * danger, hazards, consequences, status. What matters is what is NOT here — no idea of
 * "the objective", no completion checklist, no mission instance. An incident is
 * controlled when the world says its hazards are out and its people are handled, and it
 * is lost when its danger reaches the top whether anyone was there or not.
 */

import { CONFIG } from '../config.js';
import {
  BUILDINGS, BUILDING_BY_ID, CRASH_SITES, TREE_SITES, OUTDOOR_SITES,
  describePlace, dist, nearestOf, POLES,
} from '../data/town.js';
import { TEMPLATE_BY_ID, formatReport, PRIORITY_RANK } from '../data/incidents.js';
import {
  createFire, createGas, createPower, createTree, createWreck,
  fireDamageFraction, nearestPole,
} from './hazards.js';
import { createVictim, victimHandled } from './victims.js';

let nextId = 1;
export function resetIncidentIds() { nextId = 1; }

/* ── site selection ───────────────────────────────────────────────────────── */

function siteInUse(state, x, y, radius = 26) {
  return state.incidents.some((i) =>
    (i.status === 'queued' || i.status === 'active') && dist(i.x, i.y, x, y) < radius);
}

/** Pick where this template happens. Returns null when the town has nowhere left. */
export function chooseSite(state, template, rng) {
  const spec = template.site;

  if (spec.kind === 'building') {
    const kinds = spec.kinds || null;
    const pool = BUILDINGS.filter((b) => {
      if (b.kind === 'station') return false;
      if (kinds && !kinds.includes(b.kind)) return false;
      if (spec.needsGas && !b.gas) return false;
      const rec = state.town.buildings[b.id];
      if (rec && rec.boardedShifts > 0) return false;   // nobody is cooking in a gutted shop
      if (siteInUse(state, b.x + b.w / 2, b.y + b.h / 2, 8)) return false;
      return true;
    });
    if (!pool.length) return null;
    const b = rng.pick(pool);
    return { x: b.door.x, y: b.door.y + 2, buildingId: b.id, name: b.name };
  }

  if (spec.kind === 'crash') {
    const pool = CRASH_SITES.filter((s) => {
      if (siteInUse(state, s.x, s.y)) return false;
      if (spec.nearPole) {
        const p = nearestOf(POLES, s.x, s.y);
        if (!p || p.distM > 34) return false;
      }
      return true;
    });
    if (!pool.length) return null;
    const s = rng.pick(pool);
    return { x: s.x, y: s.y, name: s.name, siteId: s.id, roadId: s.roadId };
  }

  if (spec.kind === 'tree') {
    const pool = TREE_SITES.filter((s) =>
      !siteInUse(state, s.x, s.y) &&
      !state.hazards.some((h) => h.kind === 'tree' && !h.cleared && dist(h.x, h.y, s.x, s.y) < 10));
    if (!pool.length) return null;
    const s = rng.pick(pool);
    return { x: s.x, y: s.y, name: s.name, siteId: s.id, roadId: s.roadId };
  }

  const pool = OUTDOOR_SITES.filter((s) => !siteInUse(state, s.x, s.y));
  if (!pool.length) return null;
  const s = rng.pick(pool);
  return { x: s.x, y: s.y, name: s.name, siteId: s.id };
}

/* ── construction ─────────────────────────────────────────────────────────── */

/**
 * Build an incident and everything it seeds into the world.
 * @returns {object|null} the incident, or null when no site was available
 */
export function createIncident(state, template, rng) {
  const site = chooseSite(state, template, rng);
  if (!site) return null;

  const place = site.name || describePlace(site.x, site.y);
  const inc = {
    id: `inc${nextId++}`,
    templateId: template.id,
    family: template.family,
    headline: template.headline,
    place, x: site.x, y: site.y,
    buildingId: site.buildingId || null,
    roadId: site.roadId || null,
    priority: template.priority,
    report: formatReport(rng.pick(template.report), place),
    createdMs: state.simTimeMs,
    ageMs: 0,
    danger: 0,
    peakDanger: 0,
    status: 'queued',
    hazardIds: [],
    victimIds: [],
    consequences: [],
    capabilities: template.capabilities || [],
    updates: (template.updates || []).map((u) => ({ ...u, fired: false })),
    lastUpdateText: null,
    resolvedMs: null,
    outcomeNote: null,
    everWorked: false,
  };

  const setup = template.setup || {};

  if (setup.fire && site.buildingId) {
    const h = createFire(site.buildingId, {
      seedCells: setup.fire.cells, heat: setup.fire.heat, from: setup.fire.from,
    });
    addHazard(state, inc, h);
  }

  if (setup.gas && site.buildingId) {
    const b = BUILDING_BY_ID[site.buildingId];
    const h = createGas(site.buildingId, b.door.x + 3, b.door.y + 1);
    addHazard(state, inc, h);
  }

  if (setup.power) {
    const pole = nearestPole(site.x, site.y);
    const h = createPower(
      site.x + (pole.x - site.x) * 0.45,
      site.y + (pole.y - site.y) * 0.45,
      pole.id,
    );
    addHazard(state, inc, h);
  }

  if (setup.tree) addHazard(state, inc, createTree(site.x, site.y, site.roadId || null));

  const wrecks = [];
  if (setup.wreck) {
    for (let i = 0; i < setup.wreck.count; i++) {
      const ang = rng.range(0, Math.PI * 2);
      const off = i === 0 ? 0 : rng.range(3, 5.5);
      const w = createWreck(
        site.x + Math.cos(ang) * off,
        site.y + Math.sin(ang) * off,
        rng.range(0, Math.PI * 2),
        {
          fuelLeak: rng.chance(setup.wreck.fuelLeak ?? 0) ? rng.range(0.3, 1) : 0,
          kindTag: setup.wreck.kind || 'car',
          burning: !!setup.wreck.burning && i === 0,
        },
      );
      addHazard(state, inc, w);
      wrecks.push(w);
    }
  }

  for (const spec of setup.victims || []) {
    if (spec.chance != null && !rng.chance(spec.chance)) continue;
    let vx = site.x, vy = site.y, inside = null, trappedBy = null;

    if (spec.where === 'inside' && site.buildingId) {
      const b = BUILDING_BY_ID[site.buildingId];
      vx = b.x + rng.range(0.25, 0.75) * b.w;
      vy = b.y + rng.range(0.25, 0.75) * b.h;
      inside = b.id;
    } else if (spec.where === 'wreck' && wrecks.length) {
      const w = wrecks[0];
      vx = w.x; vy = w.y;
      if (spec.trapped != null && rng.chance(spec.trapped)) trappedBy = w.id;
    } else {
      vx = site.x + rng.range(-4, 4);
      vy = site.y + rng.range(-4, 4);
    }

    const v = createVictim({
      incidentId: inc.id, x: vx, y: vy,
      severity: spec.state || 'injured',
      trappedBy, insideBuildingId: inside, panics: !!spec.panics,
    });
    if (v.severity === 'critical') v.needsTransport = true;
    state.victims.push(v);
    inc.victimIds.push(v.id);
    if (trappedBy) {
      const w = state.hazards.find((h) => h.id === trappedBy);
      if (w) w.occupantIds.push(v.id);
    }
  }

  state.incidents.push(inc);
  return inc;
}

export function addHazard(state, inc, hazard) {
  hazard.incidentId = inc.id;
  state.hazards.push(hazard);
  inc.hazardIds.push(hazard.id);
  return hazard;
}

/* ── queries ──────────────────────────────────────────────────────────────── */

export function incidentHazards(state, inc) {
  return state.hazards.filter((h) => inc.hazardIds.includes(h.id));
}

export function incidentVictims(state, inc) {
  return state.victims.filter((v) => inc.victimIds.includes(v.id));
}

export function isOpen(inc) { return inc.status === 'queued' || inc.status === 'active'; }

export function openIncidents(state) { return state.incidents.filter(isOpen); }

/** Pressure this incident is putting on the town right now, before the clock is added.
 *  Capped: an incident that is going badly should accelerate, not detonate. */
function hazardPressure(state, inc) {
  let p = 0;
  for (const h of incidentHazards(state, inc)) {
    if (h.kind === 'fire') p += h.burningCount * CONFIG.fire.dangerPerBurningCell;
    else if (h.kind === 'gas') p += h.ppm * 0.0030;
    else if (h.kind === 'power' && h.live) p += 0.0015;
    else if (h.kind === 'wreck' && h.burning) p += 0.0030;
  }
  for (const v of incidentVictims(state, inc)) {
    if (v.lost || v.delivered) continue;
    p += (1 - v.condition) * 0.0030;
    if (v.trappedBy) p += 0.0015;
  }
  return Math.min(CONFIG.dispatch.maxHazardPressure, p);
}

/**
 * Structural damage is written through for EVERY fire in the world, on every step,
 * whether or not its call is still open.
 *
 * This lives outside the incident loop deliberately. A call that has been given up on
 * still has a building burning down inside it, and the town has to end the shift
 * knowing that — otherwise "we lost that one" costs nothing on the next shift, and the
 * central law quietly stops applying to the only consequence anyone can see.
 */
export function writeThroughDamage(state) {
  for (const h of state.hazards) {
    if (h.kind !== 'fire') continue;
    const rec = ensureBuildingRecord(state, h.buildingId);
    const frac = fireDamageFraction(h);
    if (frac > rec.damage) rec.damage = frac;
  }
}

/* ── per-step update ──────────────────────────────────────────────────────── */

/**
 * Age, deteriorate, update and resolve every incident. Runs regardless of where the
 * crew is: an incident nobody has driven to still gets worse on schedule.
 * @returns {Array<object>} events for the caller to turn into radio traffic + scoring
 */
export function stepIncidents(state, dtMs, rng) {
  const dt = dtMs / 1000;
  const out = [];

  for (const inc of state.incidents) {
    if (!isOpen(inc)) continue;
    inc.ageMs += dtMs;

    const hazards = incidentHazards(state, inc);
    const victims = incidentVictims(state, inc);
    const template = TEMPLATE_BY_ID[inc.templateId];

    const hazardsClear = hazards.every((h) => h.resolved);
    const peopleClear = victims.every((v) => victimHandled(v));

    /* danger — the deterioration curve */
    if (hazardsClear && peopleClear) {
      inc.danger = Math.max(0, inc.danger - 0.06 * dt);
    } else {
      inc.danger = Math.min(1, inc.danger + (template.dangerPerSec + hazardPressure(state, inc)) * dt);
      inc.peakDanger = Math.max(inc.peakDanger, inc.danger);
    }

    /* scheduled caller updates — these fire on the incident's own age, so a call that
       is ignored keeps talking to you from across town */
    for (const u of inc.updates) {
      if (u.fired || inc.ageMs < u.atMs) continue;
      u.fired = true;
      if (hazardsClear && peopleClear) continue;  // do not nag about a call already won
      inc.report = formatReport(u.text, inc.place);
      inc.lastUpdateText = inc.report;
      if (u.priority && PRIORITY_RANK[u.priority] > PRIORITY_RANK[inc.priority]) inc.priority = u.priority;
      out.push({ type: 'CALL_UPDATED', incidentId: inc.id, text: inc.report, priority: inc.priority });
    }

    /* priority follows danger as well as the script */
    const D = CONFIG.dispatch;
    let wanted = inc.priority;
    if (inc.danger >= D.escalateCriticalAt) wanted = 'critical';
    else if (inc.danger >= D.escalateHighAt && PRIORITY_RANK[inc.priority] < 1) wanted = 'high';
    if (PRIORITY_RANK[wanted] > PRIORITY_RANK[inc.priority]) {
      inc.priority = wanted;
      out.push({ type: 'PRIORITY_RAISED', incidentId: inc.id, priority: wanted });
    }

    /* status */
    if (inc.status === 'queued' && crewNear(state, inc)) {
      inc.status = 'active';
      inc.everWorked = true;
      out.push({ type: 'CREW_ON_SCENE', incidentId: inc.id });
    }

    if (hazardsClear && peopleClear) {
      // A fire with nothing left to burn is "out", but calling that CONTROLLED would
      // be a lie the shift report then repeats. The outcome is decided by what is left
      // standing and who is left, not by whether the hazard list finally emptied.
      const gutted = hazards.some((h) => h.kind === 'fire' && fireDamageFraction(h) >= 0.6);
      const someoneLost = victims.some((v) => v.lost);
      inc.status = (gutted || someoneLost) ? 'lost' : 'controlled';
      inc.resolvedMs = state.simTimeMs;
      inc.outcomeNote = summariseIncident(state, inc);
      out.push({
        type: inc.status === 'lost' ? 'INCIDENT_LOST' : 'INCIDENT_CONTROLLED',
        incidentId: inc.id, burnedOut: gutted,
      });
    } else if (inc.danger >= CONFIG.dispatch.lostAt) {
      inc.status = 'lost';
      inc.resolvedMs = state.simTimeMs;
      inc.outcomeNote = summariseIncident(state, inc);
      out.push({ type: 'INCIDENT_LOST', incidentId: inc.id });
    }
  }

  return out;
}

/** Anyone — on foot or in a cab — close enough to be working this call. */
function crewNear(state, inc, radius = 28) {
  for (const r of state.responders) {
    if (!r.inVehicleId && dist(r.x, r.y, inc.x, inc.y) < radius) return true;
  }
  for (const a of state.apparatus) {
    if (dist(a.x, a.y, inc.x, inc.y) < radius) return true;
  }
  return false;
}

export function ensureBuildingRecord(state, buildingId) {
  let rec = state.town.buildings[buildingId];
  if (!rec) {
    rec = { damage: 0, boardedShifts: 0, timesBurned: 0 };
    state.town.buildings[buildingId] = rec;
  }
  return rec;
}

/** One factual line for the shift report. No jokes: the GDD asks for the town to take
 *  its own emergencies seriously and to let the comedy come from what the crew did. */
export function summariseIncident(state, inc) {
  const victims = incidentVictims(state, inc);
  const saved = victims.filter((v) => v.delivered || (victimHandled(v) && !v.lost)).length;
  const lost = victims.filter((v) => v.lost).length;
  const bits = [];

  for (const h of incidentHazards(state, inc)) {
    if (h.kind === 'fire') {
      const pct = Math.round(fireDamageFraction(h) * 100);
      const b = BUILDING_BY_ID[h.buildingId];
      if (pct >= 60) bits.push(`${b.name} gutted (${pct}% of the structure)`);
      else if (pct > 0) bits.push(`${b.name} damaged (${pct}%)`);
      else bits.push(`${b.name} held with no fire damage`);
    } else if (h.kind === 'gas') {
      bits.push(h.flashed ? 'gas ignited before it was shut off'
        : h.shutOff ? 'gas service shut off' : 'gas service left running');
    } else if (h.kind === 'power' && h.live) bits.push('line still energised');
    else if (h.kind === 'tree' && !h.cleared) bits.push('road still blocked');
    else if (h.kind === 'tree') bits.push('road reopened');
  }
  if (saved) bits.push(`${saved} patient${saved > 1 ? 's' : ''} handled`);
  if (lost) bits.push(`${lost} patient${lost > 1 ? 's' : ''} not reached in time`);
  if (!inc.everWorked) bits.push('no crew ever arrived');

  return bits.join('; ') || 'no lasting effects';
}
