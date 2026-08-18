/* Hazards — the reusable systems the GDD asks for. Fire, gas, electricity, blockage
 * and wrecks are five independent state machines that happen to be able to see each
 * other. Nothing in here knows which incident template spawned it.
 *
 * That is where the chain reactions come from: gas ignites because a fire cell is
 * within reach of the cloud, not because a template said "then explode". A hose stream
 * wets the ground near a downed line and the live zone grows. A wreck's fuel finds a
 * burning building. None of it is scripted per family.
 *
 * All of it runs whether or not a player is anywhere near — GDD's central law.
 */

import { CONFIG } from '../config.js';
import { BUILDINGS, BUILDING_BY_ID, POLES, dist, nearestOf } from '../data/town.js';

let nextId = 1;
export function resetHazardIds() { nextId = 1; }
function newId(prefix) { return `${prefix}${nextId++}`; }

/* ── construction ─────────────────────────────────────────────────────────── */

/** Cell grid clipped to a building footprint. ~4 m cells: a small shop is 6 cells,
 *  the feed store is 60, and that ratio is the whole reason a barn fire is scary. */
export function buildFireCells(building) {
  const cell = CONFIG.fire.cellM;
  const cols = Math.max(1, Math.round(building.w / cell));
  const rows = Math.max(1, Math.round(building.h / cell));
  const cw = building.w / cols, ch = building.h / rows;
  const cells = [];
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      cells.push({
        ix, iy,
        x: building.x + (ix + 0.5) * cw,
        y: building.y + (iy + 0.5) * ch,
        heat: 0, fuel: building.fuel, wet: 0, burning: false, burnt: false,
      });
    }
  }
  return { cells, cols, rows };
}

export function createFire(buildingId, { seedCells = 1, heat = 0.95, from = 'centre' } = {}) {
  const b = BUILDING_BY_ID[buildingId];
  const { cells, cols, rows } = buildFireCells(b);
  const h = {
    id: newId('fire_'), kind: 'fire', buildingId, cells, cols, rows,
    resolved: false, burningCount: 0, peakBurning: 0, smoke: 0,
  };
  // Seed near the door for a kitchen fire (the room the caller is standing in), or in
  // the middle for something found late. Either way the player can see where it started.
  const anchor = from === 'door' ? b.door : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const sorted = cells.slice().sort((c1, c2) =>
    dist(c1.x, c1.y, anchor.x, anchor.y) - dist(c2.x, c2.y, anchor.x, anchor.y));
  for (let i = 0; i < Math.min(seedCells, sorted.length); i++) {
    sorted[i].heat = heat; sorted[i].burning = true;
  }
  h.burningCount = Math.min(seedCells, sorted.length);
  return h;
}

export function createGas(buildingId, x, y) {
  const b = BUILDING_BY_ID[buildingId];
  return {
    id: newId('gas_'), kind: 'gas', buildingId,
    x: x ?? b.door.x, y: y ?? b.door.y,
    ppm: 0.08, shutOff: false, flashed: false, resolved: false,
  };
}

export function createPower(x, y, poleId) {
  return {
    id: newId('pwr_'), kind: 'power', x, y, poleId,
    live: true, wet: 0, radiusM: CONFIG.power.liveRadiusM,
    utilityEtaMs: CONFIG.power.utilityEtaMs, utilityCalled: false, resolved: false,
  };
}

export function createTree(x, y, roadId) {
  return {
    id: newId('tree_'), kind: 'tree', x, y, roadId,
    radiusM: 5.2, cut: 0, cleared: false, resolved: false,
  };
}

export function createWreck(x, y, angle, { fuelLeak = 0, kindTag = 'car', burning = false } = {}) {
  return {
    id: newId('wrk_'), kind: 'wreck', x, y, angle,
    fuelLeak, kindTag, burning, burnt: 0, radiusM: kindTag === 'machine' ? 2.4 : 2.0,
    resolved: !burning, occupantIds: [],
  };
}

/* ── queries ──────────────────────────────────────────────────────────────── */

export function hazardsOfKind(state, kind) {
  return state.hazards.filter((h) => h.kind === kind);
}

/** Anything a vehicle should hit: a trunk across the lane, or a wreck. */
export function hazardBlockAt(state, x, y, r) {
  for (const h of state.hazards) {
    if (h.kind === 'tree' && !h.cleared) {
      if (dist(x, y, h.x, h.y) < r + h.radiusM) return h;
    } else if (h.kind === 'wreck') {
      if (dist(x, y, h.x, h.y) < r + h.radiusM) return h;
    }
  }
  return null;
}

/** Hottest cell of a fire, for the "is this out?" test and for danger. */
export function fireMaxHeat(fire) {
  let m = 0;
  for (const c of fire.cells) if (c.heat > m) m = c.heat;
  return m;
}

export function fireDamageFraction(fire) {
  let burnt = 0;
  for (const c of fire.cells) if (c.burnt) burnt++;
  return burnt / fire.cells.length;
}

/** Heat felt by a person standing at a point — used for stamina and for patient decline. */
export function heatAt(state, x, y) {
  let heat = 0;
  for (const h of state.hazards) {
    if (h.kind === 'fire') {
      for (const c of h.cells) {
        if (!c.burning) continue;
        const d = dist(x, y, c.x, c.y);
        if (d < 9) heat = Math.max(heat, c.heat * (1 - d / 9));
      }
    } else if (h.kind === 'wreck' && h.burning) {
      const d = dist(x, y, h.x, h.y);
      if (d < 7) heat = Math.max(heat, 0.8 * (1 - d / 7));
    }
  }
  return heat;
}

/** Gas concentration at a point. The gas meter reads this; nothing else can see it. */
export function gasAt(state, x, y) {
  let g = 0;
  for (const h of state.hazards) {
    if (h.kind !== 'gas') continue;
    const d = dist(x, y, h.x, h.y);
    if (d < CONFIG.gas.cloudRadiusM) g += h.ppm * (1 - d / CONFIG.gas.cloudRadiusM);
  }
  return Math.min(1.5, g);
}

/** The live zone. Walking into it is a mistake, not a death. */
export function liveZoneAt(state, x, y) {
  for (const h of state.hazards) {
    if (h.kind !== 'power' || !h.live) continue;
    if (dist(x, y, h.x, h.y) < h.radiusM) return h;
  }
  return null;
}

function ignitionSourceNear(state, x, y, radius) {
  for (const h of state.hazards) {
    if (h.kind === 'fire') {
      for (const c of h.cells) if (c.burning && dist(x, y, c.x, c.y) < radius) return h;
    } else if (h.kind === 'wreck' && h.burning) {
      if (dist(x, y, h.x, h.y) < radius) return h;
    } else if (h.kind === 'power' && h.live) {
      if (dist(x, y, h.x, h.y) < radius * 0.7) return h;
    }
  }
  return null;
}

/* ── water ────────────────────────────────────────────────────────────────
 * One entry point for every source of water: the hose, the extinguisher, and later
 * anything else that sprays. It returns what it managed to land, so the caller can
 * decide whether the tank should be charged for it.
 */
export function applyWater(state, ox, oy, dirX, dirY, litres, reachM = CONFIG.water.streamReachM) {
  const halfAngle = (CONFIG.water.streamHalfAngleDeg * Math.PI) / 180;
  const targets = [];
  for (const h of state.hazards) {
    if (h.kind === 'fire') {
      for (const c of h.cells) if (!c.burnt || c.heat > 0.05) targets.push({ h, c, x: c.x, y: c.y });
    } else if (h.kind === 'wreck' && h.burning) {
      targets.push({ h, c: null, x: h.x, y: h.y });
    } else if (h.kind === 'power' && h.live) {
      targets.push({ h, c: null, x: h.x, y: h.y, isPower: true });
    }
  }

  const hit = [];
  for (const t of targets) {
    const dx = t.x - ox, dy = t.y - oy;
    const d = Math.hypot(dx, dy);
    if (d > reachM || d < 0.001) continue;
    const cos = (dx * dirX + dy * dirY) / d;
    if (cos < Math.cos(halfAngle) - 0.0001) continue;
    hit.push({ ...t, d });
  }
  if (!hit.length) return { landed: 0, cooled: 0 };

  // Weight the stream by how hot each thing in the cone is. Splitting it evenly meant
  // a cold wall two cells over soaked up as much as the seat of the fire, so a single
  // line could never win — the first version of this file made every structure fire a
  // total loss and the tests said so. Cold cells still get some water: pre-wetting the
  // path of the fire is a real tactic, and 0.2 is what it is worth.
  let totalW = 0;
  for (const t of hit) { t.w = 0.2 + (t.c ? Math.max(0, t.c.heat) : 1.0); totalW += t.w; }

  let cooled = 0;
  for (const t of hit) {
    const share = litres * (t.w / totalW);
    if (t.c) {
      const before = t.c.heat;
      t.c.heat = Math.max(0, t.c.heat - share * CONFIG.water.coolPerLitre);
      t.c.wet = Math.min(1.5, t.c.wet + share * CONFIG.water.wetPerLitre);
      if (t.c.burning && t.c.heat < CONFIG.fire.ignitionHeat * 0.55) t.c.burning = false;
      cooled += before - t.c.heat;
    } else if (t.isPower) {
      // Wetting a live line is the wrong answer, and the town shows you why.
      t.h.wet = Math.min(1, t.h.wet + share * 0.02);
    } else {
      t.h.burnt = Math.min(1, t.h.burnt);
      t.h.burning = false;
      t.h.fuelLeak = Math.max(0, t.h.fuelLeak - share * 0.02);
      cooled += share * 0.01;
    }
  }
  return { landed: litres, cooled };
}

/* ── per-step update ──────────────────────────────────────────────────────── */

/**
 * Advance every hazard one simulation step.
 * @returns {Array<{type:string,[k:string]:any}>} world events for the caller to fan out
 *   (new fires from exposure or ignition, gas flashes, utility arrivals). Hazards never
 *   emit on the bus directly — the incident layer decides what any of it MEANS.
 */
export function stepHazards(state, dtMs, rng) {
  const dt = dtMs / 1000;
  const out = [];

  for (const h of state.hazards) {
    if (h.kind === 'fire') stepFire(state, h, dt, rng, out);
    else if (h.kind === 'gas') stepGas(state, h, dt, rng, out);
    else if (h.kind === 'power') stepPower(state, h, dtMs, out);
    else if (h.kind === 'tree') h.resolved = h.cleared;
    else if (h.kind === 'wreck') stepWreck(state, h, dt, out);
  }
  return out;
}

function stepFire(state, fire, dt, rng, out) {
  const F = CONFIG.fire;
  const { cells, cols, rows } = fire;
  const heatAdd = new Float32Array(cells.length);

  let burning = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c.burning) continue;
    burning++;
    heatAdd[i] += F.burnHeatGain * dt;
    c.fuel = Math.max(0, c.fuel - F.fuelBurnPerSec * dt);
    if (c.fuel <= 0) { c.burning = false; c.burnt = true; }

    // Push heat into the neighbours; diagonals count for less.
    //
    // Only into neighbours that are NOT already alight. Heat here is the thing that
    // drives ignition, not a temperature — piling more of it onto a cell that is
    // already burning just made that cell impossible to knock down, because a nozzle
    // then had to out-cool the whole surrounding fire to darken one square. Working
    // the edge of a fire has to be a winnable fight or the hose is decoration.
    const push = F.spreadPerSec * dt * Math.min(1, c.heat);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = c.ix + dx, ny = c.iy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = cells[ny * cols + nx];
        if (n.burning || n.burnt) continue;
        heatAdd[ny * cols + nx] += push * (dx && dy ? F.diagonalMul : 1);
      }
    }
  }

  let maxHeat = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const wetResist = 1 / (1 + c.wet * 6);
    c.heat = Math.max(0, c.heat + heatAdd[i] * wetResist - (c.burning ? 0 : F.coolPerSec * dt));
    c.heat = Math.min(1.25, c.heat);   // a ceiling, so a knock-down is 3 s and not 8
    c.wet = Math.max(0, c.wet - F.wetDecayPerSec * dt);
    if (!c.burning && !c.burnt && c.fuel > 0 && c.heat >= F.ignitionHeat) {
      c.burning = true;
      burning++;
    }
    if (c.heat > maxHeat) maxHeat = c.heat;
  }

  fire.burningCount = burning;
  fire.peakBurning = Math.max(fire.peakBurning, burning);
  fire.smoke = burning * F.smokePerSec;
  fire.resolved = burning === 0 && maxHeat < F.ignitionHeat * 0.8;

  // Exposure. A structure this close to open flame is a second call waiting to happen.
  //
  // Measured against EVERY burning cell, not the first one found: the farmhouse is 6 m
  // from the barn along its east wall and 34 m from it along its west wall, so testing
  // one arbitrary cell meant the fire next door depended on array order.
  if (burning > 0) {
    const chance = F.jumpChancePerSec * dt * Math.min(3, burning);
    if (rng.chance(chance)) {
      let best = null, bestD = F.jumpDistM;
      for (const b of BUILDINGS) {
        if (b.id === fire.buildingId || b.kind === 'clinic' || b.kind === 'station') continue;
        if (state.hazards.some((x) => x.kind === 'fire' && x.buildingId === b.id)) continue;
        for (const c of cells) {
          if (!c.burning) continue;
          const nx = Math.min(b.x + b.w, Math.max(b.x, c.x));
          const ny = Math.min(b.y + b.h, Math.max(b.y, c.y));
          const d = dist(c.x, c.y, nx, ny);
          if (d <= bestD) { bestD = d; best = b; }
        }
      }
      if (best) out.push({ type: 'FIRE_EXTENDED', fromHazardId: fire.id, buildingId: best.id });
    }
  }
}

function stepGas(state, gas, dt, rng, out) {
  const G = CONFIG.gas;
  if (!gas.shutOff) gas.ppm = Math.min(1.4, gas.ppm + G.leakRatePerSec * dt);
  gas.ppm = Math.max(0, gas.ppm - G.dispersePerSec * dt);
  gas.resolved = gas.shutOff && gas.ppm < 0.10;

  if (!gas.flashed && gas.ppm >= G.ignitionThreshold) {
    const src = ignitionSourceNear(state, gas.x, gas.y, G.ignitionSourceM);
    if (src) {
      gas.flashed = true;
      gas.ppm = 0.15;
      out.push({ type: 'GAS_FLASH', hazardId: gas.id, buildingId: gas.buildingId, x: gas.x, y: gas.y });
    }
  }
}

function stepPower(state, pwr, dtMs, out) {
  if (!pwr.live) { pwr.resolved = true; return; }
  // Water on the ground carries the fault further than the wire ever reached.
  pwr.radiusM = CONFIG.power.liveRadiusM * (1 + pwr.wet * (CONFIG.power.wetSpreadMul - 1));
  if (pwr.utilityCalled) {
    pwr.utilityEtaMs -= dtMs;
    if (pwr.utilityEtaMs <= 0) {
      pwr.live = false; pwr.resolved = true;
      out.push({ type: 'UTILITY_ARRIVED', hazardId: pwr.id });
    }
  }
}

function stepWreck(state, wreck, dt, out) {
  if (wreck.burning) {
    wreck.burnt = Math.min(1, wreck.burnt + 0.05 * dt);
    wreck.resolved = false;
    // A burning car beside a building is how a road incident becomes a structure fire.
    for (const b of BUILDINGS) {
      const nx = Math.min(b.x + b.w, Math.max(b.x, wreck.x));
      const ny = Math.min(b.y + b.h, Math.max(b.y, wreck.y));
      if (dist(wreck.x, wreck.y, nx, ny) < 6 &&
          !state.hazards.some((h) => h.kind === 'fire' && h.buildingId === b.id)) {
        out.push({ type: 'FIRE_EXTENDED', fromHazardId: wreck.id, buildingId: b.id });
        break;
      }
    }
    return;
  }
  if (wreck.fuelLeak > 0.02) {
    const src = ignitionSourceNear(state, wreck.x, wreck.y, 6);
    if (src) { wreck.burning = true; out.push({ type: 'WRECK_IGNITED', hazardId: wreck.id }); }
  }
  wreck.resolved = !wreck.burning;
}

/** The nearest pole to a point — where a downed line is killed from. */
export function nearestPole(x, y) {
  const n = nearestOf(POLES, x, y);
  return n ? n.item : POLES[0];
}
