/* The town, as data. GDD: "Build one compact, legible town rather than disconnected
 * mission maps." Every incident family picks its location from THIS file, so a new
 * street or a new building immediately becomes somewhere calls can happen.
 *
 * One record per place, shared by the renderer and by collision — the lesson from
 * AirportBaggageCrew\src\data\airport.js, where two copies of the same rectangle
 * drifted apart once and cost an afternoon.
 *
 * Coordinates are metres. +x is east, +y is south. The town is 420 x 300 m: about
 * 25 seconds of hard driving corner to corner in the engine, which is the number the
 * whole triage loop is built on.
 */

export const WORLD = { widthM: 420, heightM: 300 };
export const BOUNDS = { minX: 0, minY: 0, maxX: WORLD.widthM, maxY: WORLD.heightM };

/* ── roads ────────────────────────────────────────────────────────────────
 * Centre lines with a width. Vehicles may leave the tarmac — grass is slow, not
 * forbidden — so the grid is a set of fast corridors rather than a rail network.
 * Two horizontal + four vertical through-routes guarantee the GDD's "at least two
 * alternate routes" between any pair of sites.
 */
export const ROADS = [
  { id: 'river_rd',   name: 'River Road',   x1: 12,  y1: 40,  x2: 408, y2: 40,  w: 9 },
  { id: 'main_st',    name: 'Main Street',  x1: 12,  y1: 150, x2: 408, y2: 150, w: 10 },
  { id: 'mill_rd',    name: 'Mill Road',    x1: 30,  y1: 250, x2: 392, y2: 250, w: 8 },
  { id: 'station_rd', name: 'Station Road', x1: 60,  y1: 40,  x2: 60,  y2: 250, w: 8 },
  { id: 'elm_st',     name: 'Elm Street',   x1: 160, y1: 40,  x2: 160, y2: 250, w: 8 },
  { id: 'oak_st',     name: 'Oak Street',   x1: 260, y1: 40,  x2: 260, y2: 250, w: 8 },
  { id: 'quarry_rd',  name: 'Quarry Road',  x1: 360, y1: 40,  x2: 360, y2: 250, w: 8 },
  // The two spurs stop at the kerb, not at the wall: a driveway that runs under a
  // building would put a carriageway inside a structure, and tools\m0-tests.js E4
  // fails the build if one ever does.
  { id: 'clinic_dr',  name: 'Clinic Drive', x1: 360, y1: 112, x2: 372, y2: 112, w: 7 },
  { id: 'school_dr',  name: 'School Drive', x1: 115, y1: 250, x2: 115, y2: 260, w: 7 },
];

/* ── buildings ────────────────────────────────────────────────────────────
 * `fuel` is how much there is to burn per cell (1.0 = a full structure fire's worth).
 * `gas` marks a building with a service meter, which is what makes a utility call
 * possible there. `door` is where an on-foot responder is expected to work from.
 */
export const BUILDINGS = [
  // MEASURED: with the hall at y=164 the parked apparatus had 0.2 m between their
  // back bumpers and their own front wall, so reversing out of the bay — the first
  // thing anyone tries — put the engine nose-first into the station and wedged it
  // there. Moved south to leave 6 m of apron behind the trucks.
  { id: 'station',    name: 'Volunteer Station',   kind: 'station',  x: 72,  y: 170, w: 40, h: 28, fuel: 0.7, gas: true,  door: { x: 92,  y: 168 } },
  { id: 'pizza',      name: "Tony's Pizza",   kind: 'shop',     x: 130, y: 116, w: 24, h: 26, fuel: 1.0, gas: true,  door: { x: 142, y: 144 } },
  { id: 'hardware',   name: 'Grange Hardware',     kind: 'shop',     x: 176, y: 114, w: 32, h: 28, fuel: 1.1, gas: true,  door: { x: 192, y: 144 } },
  { id: 'church',     name: 'Riverside Church',    kind: 'civic',    x: 90,  y: 56,  w: 32, h: 26, fuel: 0.9, gas: false, door: { x: 106, y: 84 } },
  { id: 'farmhouse',  name: 'Miller Farmhouse',    kind: 'house',    x: 286, y: 58,  w: 30, h: 26, fuel: 1.0, gas: true,  door: { x: 301, y: 86 } },
  { id: 'barn',       name: 'Miller Barn',         kind: 'barn',     x: 322, y: 62,  w: 24, h: 20, fuel: 1.4, gas: false, door: { x: 320, y: 72 } },
  { id: 'apartments', name: 'Pinecrest Apartments',kind: 'housing',  x: 276, y: 174, w: 46, h: 36, fuel: 1.0, gas: true,  door: { x: 299, y: 172 } },
  { id: 'garage',     name: "Ackerman's Garage", kind: 'industry', x: 176, y: 190, w: 34, h: 28, fuel: 1.3, gas: true, door: { x: 193, y: 188 } },
  { id: 'clinic',     name: 'Lakeview Clinic',     kind: 'clinic',   x: 374, y: 94,  w: 34, h: 36, fuel: 0.6, gas: false, door: { x: 372, y: 112 } },
  { id: 'school',     name: 'Rowan Elementary',    kind: 'civic',    x: 90,  y: 262, w: 56, h: 30, fuel: 0.8, gas: true,  door: { x: 118, y: 260 } },
  { id: 'feedstore',  name: 'Vance Feed & Grain',  kind: 'industry', x: 286, y: 260, w: 34, h: 30, fuel: 1.5, gas: false, door: { x: 303, y: 258 } },
];

export const BUILDING_BY_ID = Object.freeze(Object.fromEntries(BUILDINGS.map((b) => [b.id, b])));

/** Where an ambulance hands a patient over. One clinic: transport decisions cost time. */
export const CLINIC = { buildingId: 'clinic', x: 372, y: 116, radiusM: 13 };

/** Apparatus bays and the walk-out point. GDD core loop step 1 starts here. */
export const STATION = {
  buildingId: 'station',
  apron: { x: 68, y: 154, w: 50, h: 16 },
  spawn: { x: 94, y: 158 },
  rack:  { x: 120, y: 159 },     // spare kit left on the apron between calls
  bays: [
    { apparatusId: 'engine',    x: 80,  y: 160, angle: -Math.PI / 2 },
    { apparatusId: 'ambulance', x: 96,  y: 160, angle: -Math.PI / 2 },
    { apparatusId: 'rescue',    x: 112, y: 160, angle: -Math.PI / 2 },
  ],
};

/* ── hydrants ─────────────────────────────────────────────────────────────
 * Kerbside, deliberately not one per building. Spotting the engine is a decision:
 * close to the fire and you run the tank dry, close to the hydrant and you may be
 * out of hose. `damaged` is persisted between shifts — the GDD's own example of a
 * consequence that matters on the NEXT call.
 */
export const HYDRANTS = [
  { id: 'hyd_main_w',    x: 66,  y: 141 }, { id: 'hyd_station',  x: 122, y: 158 },
  { id: 'hyd_elm',       x: 167, y: 141 }, { id: 'hyd_hardware', x: 214, y: 141 },
  { id: 'hyd_oak',       x: 250, y: 141 }, { id: 'hyd_quarry',   x: 352, y: 141 },
  { id: 'hyd_pinecrest', x: 270, y: 170 }, { id: 'hyd_mill_w',   x: 150, y: 242 },
  { id: 'hyd_mill_e',    x: 300, y: 242 }, { id: 'hyd_church',   x: 95,  y: 50  },
  { id: 'hyd_farm',      x: 300, y: 50  },
];

/** Utility poles double as the de-energise point for a downed line. */
export const POLES = [
  { id: 'pole_main_w',  x: 68,  y: 159 }, { id: 'pole_main_c',  x: 168, y: 159 },
  { id: 'pole_main_e',  x: 268, y: 159 }, { id: 'pole_main_x',  x: 352, y: 159 },
  { id: 'pole_river_w', x: 100, y: 31  }, { id: 'pole_river_e', x: 300, y: 31  },
  { id: 'pole_mill',    x: 200, y: 259 }, { id: 'pole_oak',     x: 251, y: 202 },
];

/** Decorative planting. The fallen-tree family draws from TREE_SITES instead — those
 *  are the ones standing where a trunk across the lane actually costs a detour. */
export const TREES = [
  { x: 46, y: 96 }, { x: 46, y: 122 }, { x: 128, y: 66 }, { x: 132, y: 96 },
  { x: 210, y: 68 }, { x: 232, y: 96 }, { x: 236, y: 168 }, { x: 240, y: 218 },
  { x: 330, y: 120 }, { x: 336, y: 172 }, { x: 84, y: 216 }, { x: 60, y: 276 },
  { x: 196, y: 240 }, { x: 260, y: 288 }, { x: 386, y: 200 }, { x: 396, y: 60 },
  { x: 176, y: 60 }, { x: 344, y: 224 }, { x: 30, y: 180 }, { x: 404, y: 264 },
];

/** Ponds, fields, lots. Drawn only — nothing collides with them, but they are what
 *  makes a player say "the field behind the school" instead of "grid 6". */
export const SCENERY = [
  { kind: 'pond',  name: 'Willow Pond',    x: 16,  y: 56,  w: 34, h: 26 },
  { kind: 'field', name: 'Miller Field',   x: 276, y: 96,  w: 74, h: 40 },
  { kind: 'field', name: 'the ballfield',  x: 172, y: 262, w: 60, h: 32 },
  { kind: 'lot',   name: 'the town lot',   x: 216, y: 156, w: 30, h: 20 },
  { kind: 'lot',   name: 'clinic parking', x: 374, y: 134, w: 34, h: 14 },
];

/* ── incident sites ───────────────────────────────────────────────────────
 * Named places, so dispatch can say "the Quarry Road hill" and mean it.
 */
export const CRASH_SITES = [
  { id: 'oak_main',    x: 258, y: 150, name: 'Oak Street and Main', roadId: 'main_st' },
  { id: 'river_bend',  x: 208, y: 40,  name: 'the River Road bend', roadId: 'river_rd' },
  { id: 'quarry_hill', x: 360, y: 198, name: 'Quarry Road hill',    roadId: 'quarry_rd' },
  { id: 'elm_mill',    x: 160, y: 248, name: 'Elm Street and Mill', roadId: 'elm_st' },
  { id: 'main_west',   x: 104, y: 150, name: 'Main Street west',    roadId: 'main_st' },
];

export const TREE_SITES = [
  { id: 'elm_north',   x: 160, y: 96,  roadId: 'elm_st',     name: 'Elm Street north of Main' },
  { id: 'oak_south',   x: 260, y: 216, roadId: 'oak_st',     name: 'Oak Street south of Main' },
  { id: 'mill_west',   x: 96,  y: 250, roadId: 'mill_rd',    name: 'Mill Road at the west end' },
  { id: 'main_east',   x: 320, y: 150, roadId: 'main_st',    name: 'Main Street east' },
  { id: 'station_road',x: 60,  y: 196, roadId: 'station_rd', name: 'Station Road' },
];

/** Outdoor addresses for medical calls that are not inside a building. */
export const OUTDOOR_SITES = [
  { id: 'ballfield',   x: 202, y: 278, name: 'the ballfield behind Rowan Elementary' },
  { id: 'pond',        x: 33,  y: 84,  name: 'Willow Pond' },
  { id: 'millerfield', x: 312, y: 116, name: 'Miller Field' },
  { id: 'townlot',     x: 231, y: 166, name: 'the town lot on Main' },
];

/* ── geometry ─────────────────────────────────────────────────────────────
 * Shared by collision, rendering and every system that asks "what is here?".
 */

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function clampToBounds(x, y, r = 0) {
  return {
    x: Math.min(BOUNDS.maxX - r, Math.max(BOUNDS.minX + r, x)),
    y: Math.min(BOUNDS.maxY - r, Math.max(BOUNDS.minY + r, y)),
  };
}

/** Axis-aligned road bands, cached once: roads never move. */
const ROAD_RECTS = ROADS.map((rd) => {
  const half = rd.w / 2;
  const horizontal = rd.y1 === rd.y2;
  return {
    id: rd.id, name: rd.name, horizontal,
    x: Math.min(rd.x1, rd.x2) - (horizontal ? 0 : half),
    y: Math.min(rd.y1, rd.y2) - (horizontal ? half : 0),
    w: horizontal ? Math.abs(rd.x2 - rd.x1) : rd.w,
    h: horizontal ? rd.w : Math.abs(rd.y2 - rd.y1),
  };
});

export function roadRects() { return ROAD_RECTS; }

export function roadAt(x, y) {
  for (const r of ROAD_RECTS) if (pointInRect(x, y, r)) return r;
  return null;
}

export function isOnRoad(x, y) { return roadAt(x, y) !== null; }

export function buildingAt(x, y) {
  for (const b of BUILDINGS) if (pointInRect(x, y, b)) return b;
  return null;
}

/** True when a circle overlaps a rectangle at all. */
export function circleHitsRect(cx, cy, r, rect) {
  const nx = Math.min(rect.x + rect.w, Math.max(rect.x, cx));
  const ny = Math.min(rect.y + rect.h, Math.max(rect.y, cy));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/**
 * Push a circle out of a rectangle along the shallowest axis.
 * @returns {{x:number,y:number,nx:number,ny:number}|null} corrected centre + normal
 */
export function resolveCircleRect(cx, cy, r, rect) {
  if (!circleHitsRect(cx, cy, r, rect)) return null;
  const left   = cx - (rect.x - r);
  const right  = (rect.x + rect.w + r) - cx;
  const top    = cy - (rect.y - r);
  const bottom = (rect.y + rect.h + r) - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left)  return { x: rect.x - r, y: cy, nx: -1, ny: 0 };
  if (m === right) return { x: rect.x + rect.w + r, y: cy, nx: 1, ny: 0 };
  if (m === top)   return { x: cx, y: rect.y - r, nx: 0, ny: -1 };
  return { x: cx, y: rect.y + rect.h + r, nx: 0, ny: 1 };
}

/** Structures only. Grass, kerbs and scenery are all driveable — badly. */
export function blockingRectAt(cx, cy, r) {
  for (const b of BUILDINGS) if (circleHitsRect(cx, cy, r, b)) return b;
  return null;
}

export function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

/**
 * Did this get back to the STATION — not back to its own bay.
 *
 * Measured against the bay first, which made parking the engine neatly beside the apron
 * rack read as "abandoned at 43 m": the bays are 16 m apart, so the westmost truck's bay
 * is most of the apron away from the eastmost. Punishing somebody for parking in the
 * wrong bay is not a consequence worth having. Distance to the apron RECTANGLE, so
 * anywhere on the forecourt counts and Main Street does not.
 *
 * The radius is a parameter rather than a CONFIG read because this module imports
 * nothing, and that is a property worth more than the convenience.
 */
export function atStation(x, y, radiusM) {
  const a = STATION.apron;
  const cx = Math.min(a.x + a.w, Math.max(a.x, x));
  const cy = Math.min(a.y + a.h, Math.max(a.y, y));
  return dist(x, y, cx, cy) <= radiusM;
}

/**
 * Is this truck going to be here in the morning?
 *
 * ONE predicate, because the shift report and the save have to agree. They did not: the
 * report listed anything away from the station and the save kept only what could not
 * drive, so a crew that ended a shift at a call — which is what the last ten minutes of
 * every shift look like — was warned about three trucks that then drove themselves home.
 * A warning about something that does not happen is worse than no warning.
 */
export function apparatusStaysOut(x, y, damage, radiusM, undriveableDamage) {
  return damage >= undriveableDamage && !atStation(x, y, radiusM);
}

export function nearestOf(list, x, y, filter = null) {
  let best = null, bestD = Infinity;
  for (const it of list) {
    if (filter && !filter(it)) continue;
    const d = dist(x, y, it.x, it.y);
    if (d < bestD) { bestD = d; best = it; }
  }
  return best ? { item: best, distM: bestD } : null;
}

/** Human-readable address for a point — dispatch reads this out loud. */
export function describePlace(x, y) {
  const inside = buildingAt(x, y);
  if (inside) return inside.name;

  let best = null, bestD = Infinity;
  for (const b of BUILDINGS) {
    const d = dist(x, y, b.x + b.w / 2, b.y + b.h / 2);
    if (d < bestD) { bestD = d; best = b; }
  }
  const rd = roadAt(x, y);
  if (rd) return bestD < 60 ? `${rd.name} by ${best.name}` : rd.name;
  for (const s of SCENERY) if (pointInRect(x, y, s)) return s.name;
  return bestD < 70 ? `near ${best.name}` : 'out past the town line';
}
