/* Renderer. GDD implementation rule 7: "Make causes visible before adding more
 * content." Every drawing decision here is about legibility of cause:
 *
 *   - a fire is drawn CELL BY CELL, on the roof it is eating through, so "it is
 *     spreading left" is a thing you see rather than a number you are told;
 *   - the hose is drawn as an actual line from the actual engine, so running out of
 *     hose looks like running out of hose;
 *   - the live zone is a visible ring, because an invisible one is a bug report;
 *   - gas is drawn faintly, and properly only when you are carrying the meter.
 *
 * THE PROJECTION. The town is simulated flat and drawn in three quarters: the camera
 * squashes the ground plane and `cam.top(x, y, h)` says where a point h metres up
 * lands, so everything with height is extruded from its real footprint. Nothing here
 * feeds back into the simulation — a wall is 6 m tall to look at and 0 m tall to walk
 * into, exactly as before.
 *
 * That buys one thing that has to be paid for: things now OCCLUDE each other. So the
 * standing world is not drawn in fixed layers any more. Every upright thing is
 * collected as a prop with a depth key — the southern edge of whatever it stands on —
 * and the whole list is drawn from the back of the town forwards. Shadows go down
 * first, in one pass, so no shadow ever lands on top of the thing in front of it.
 *
 * This file reads state and never writes it (GDD: "Rendering and UI read simulation
 * state; they do not own it").
 */

import { CONFIG } from '../config.js';
import {
  BUILDINGS, ROADS, SCENERY, TREES, HYDRANTS, POLES, STATION, CLINIC,
  roadRects, BUILDING_BY_ID,
} from '../data/town.js';
import { TOOL_DEFS } from '../data/equipment.js';
import { victimState } from '../sim/victims.js';

const PALETTE = {
  grass: '#688f4e', grassAlt: '#5f8547',
  road: '#4b5058', roadEdge: '#3c414a', kerb: '#8d8f92', centreLine: '#e6d38f',
  pond: '#4a7fa1', field: '#7ea55d', lot: '#6d6f76',
  tree: '#4a7d41', treeDark: '#335b30', treeLit: '#6ea052', treeTrunk: '#4a3a2a',
  hydrant: '#d94f3d', hydrantDead: '#6b6b6b',
  pole: '#6b563f', wire: '#2b2b33',
  player: '#f4e3b2', playerSoot: '#7a6a55',
  victim: '#e9d7c3',
  shadow: 'rgba(18,26,20,0.30)',
  ui: '#f2ead9',
};

const ROOF = {
  station: '#b8403a', shop: '#d2a04a', civic: '#7ba7c9', house: '#c9855f',
  housing: '#a3785f', barn: '#9d4436', industry: '#8b9099', clinic: '#dfe8ee',
};

/* Wall colours are separate from roof colours, and duller. A building whose walls are
 * the same colour as its roof reads as a solid lump of one thing; the moment the roof
 * is the bright surface and the walls are plaster or board, it reads as a building. */
const WALL = {
  station: '#d8cdbc', shop: '#e2d6bd', civic: '#e6e2d6', house: '#e0d5c0',
  housing: '#cfc2ad', barn: '#8d5a3f', industry: '#b9bcc2', clinic: '#eef2f5',
};

/** How tall each kind stands, in metres. Presentation only — nothing collides with it. */
const HEIGHT = {
  station: 7.0, shop: 6.2, civic: 8.0, house: 6.0,
  housing: 11.0, barn: 9.5, industry: 7.2, clinic: 8.4,
};

/** Which get a pitched roof, and how high the ridge sits above the eaves. */
const RIDGE = { house: 2.6, housing: 2.2, barn: 3.4, station: 1.8, shop: 1.4 };

/** Stable pseudo-noise for flicker: the renderer must not call Math.random (the seeded
 *  stream belongs to the simulation, and a repeat playtest should look the same). */
function wobble(i, t, speed = 6) {
  return Math.sin(i * 12.9898 + t * speed) * 0.5 + Math.sin(i * 78.233 + t * speed * 1.7) * 0.5;
}

/**
 * Shade a colour by a factor: <1 darkens, >1 lightens. Faces need this constantly.
 *
 * It takes BOTH `#rrggbb` and the `rgb(r,g,b)` it returns, because shading an already
 * shaded colour is the normal case — a truck cab is a lighter version of a body that is
 * already a shaded face. Hex-only, that second pass did `parseInt('gb(204,60,45)', 16)`
 * = NaN, and `NaN >> 16 & 255` is 0, not NaN: every one of those surfaces came out PURE
 * BLACK. The truck cab, the wrecked car's cabin, the church steeple and every tool lying
 * on the ground, all silently painted black by a bitwise operator being too forgiving.
 */
const _shadeCache = new Map();
function shade(colour, k) {
  /* Cached. Every face of every prism asks for a shade, with the same handful of
     (colour, factor) pairs on every frame — three trucks alone were 76% of a frame and
     this was part of it. A Map lookup replaces a parseInt or a regex, three rounds and
     a template string, and the set of pairs is tiny and bounded by the palette. */
  const key = colour + '|' + k;
  const hit = _shadeCache.get(key);
  if (hit !== undefined) return hit;
  const out = computeShade(colour, k);
  _shadeCache.set(key, out);
  return out;
}

function computeShade(colour, k) {
  let r, g, b;
  if (colour[0] === '#') {
    const n = parseInt(colour.slice(1), 16);
    if (!Number.isFinite(n)) return colour;
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(colour);
    if (!m) return colour;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

export { shade };

export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.showBounds = false;
    this.showGrid = false;
    this.labels = [];
    this.markers = [];
    this.props = [];
  }

  render(state, nowMs = 0) {
    const ctx = this.ctx;
    const cam = this.camera;
    const t = nowMs / 1000;
    this.labels.length = 0;
    this.markers.length = 0;
    this.props.length = 0;

    cam.resetTransform(ctx);
    this.drawSky(ctx);

    cam.applyTo(ctx);

    /* 1. the ground, and everything painted ON it */
    this.drawGround(ctx);
    this.drawRoads(ctx, state);
    this.drawGroundHazards(ctx, state);
    // Firelight lands on the GROUND, under everything that stands on it — that is the
    // difference between a fire that is drawn on the map and a fire that is lighting it.
    this.drawFireLight(ctx, state, t);

    /* 2. everything that stands up, back to front */
    this.collectProps(state, t);
    this.props.sort((a, b) => a.depth - b.depth);
    for (const p of this.props) if (p.shadow) p.shadow(ctx);
    for (const p of this.props) p.draw(ctx);

    /* 3. what belongs over the top of the town: things in the air, and things that are
       information rather than objects */
    this.drawWires(ctx);
    this.drawHose(ctx, state);
    this.drawPowerZones(ctx, state, t);
    this.drawSmokeAndEmbers(ctx, state, t);
    if (this.showBounds) this.drawBounds(ctx, state);

    cam.resetTransform(ctx);
    this.drawVignette(ctx);
    this.drawLabels(ctx);
    this.drawIncidentMarkers(ctx, state, t);
  }

  /** Depth key: the southern edge of a thing is where it meets the ground nearest you. */
  prop(depth, draw, shadow = null) { this.props.push({ depth, draw, shadow }); }

  /* ── the projection, as drawing primitives ──────────────────────────────── */

  /** Footprint corners (clockwise from north-west) for an axis-aligned rect. */
  rectPts(x, y, w, h) {
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }

  /** The same polygon, `h` metres up. */
  topPts(pts, h) {
    const cam = this.camera;
    return pts.map((p) => cam.top(p.x, p.y, h));
  }

  path(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  fillPoly(ctx, pts, fill, stroke = null, lw = 0.18) {
    this.path(ctx, pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  /**
   * Extrude a footprint into a solid and hand back its top face.
   *
   * Side faces are drawn from the back of the shape forwards so that the leaning ones
   * overlap in the right order, and the top goes on last because nothing is ever in
   * front of a roof.
   */
  prism(ctx, pts, h, { wall, top = null, edge = 'rgba(0,0,0,0.28)' }) {
    const up = this.topPts(pts, h);
    const faces = [];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const a = pts[i], b = pts[j];
      // The face's own depth: how far south its base sits. Northern faces are behind.
      faces.push({ mid: (a.y + b.y) / 2, quad: [a, b, up[j], up[i]] });
    }
    faces.sort((p, q) => p.mid - q.mid);
    for (let i = 0; i < faces.length; i++) {
      // Front faces catch the light; the ones nearly edge-on read as the shaded sides.
      const k = i === faces.length - 1 ? 1.0 : 0.80 - (faces.length - 1 - i) * 0.06;
      this.fillPoly(ctx, faces[i].quad, shade(wall, k), edge, 0.14);
    }
    if (top) this.fillPoly(ctx, up, top, edge, 0.16);
    return up;
  }

  /* ── sky, ground, roads ─────────────────────────────────────────────────── */

  /** A graded backdrop rather than a flat fill: the top of the frame is further away. */
  drawSky(ctx) {
    const cam = this.camera;
    const g = ctx.createLinearGradient(0, 0, 0, cam.cssH);
    g.addColorStop(0, '#4e7247');
    g.addColorStop(0.35, '#5f8547');
    g.addColorStop(1, '#6d924f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cam.cssW, cam.cssH);
  }

  /** Grass with something in it. A flat fill reads as a spreadsheet cell; a few
   *  deterministic patches read as ground. */
  drawGround(ctx) {
    const cam = this.camera;
    const v = cam.visibleM;
    ctx.fillStyle = PALETTE.grassAlt;

    /* The step is derived from the visible area, never fixed.
     *
     * A fixed 26 m step is an unbounded loop the moment the visible area is not a
     * sane number — and it is not, on the very first frame, when the canvas has no
     * layout yet and the scale divides by zero. That hung the page hard enough that
     * headless Chrome sat on a screenshot until it was killed. Bounded to a grid of
     * at most 48 x 48, so a bad camera costs a smudge, not the frame. */
    if (!Number.isFinite(v.w) || !Number.isFinite(v.h) || v.w <= 0 || v.h <= 0) return;
    const step = Math.max(26, v.w / 48, v.h / 48);
    const x0 = Math.floor(v.x / step) * step, y0 = Math.floor(v.y / step) * step;
    for (let x = x0; x < v.x + v.w + step; x += step) {
      for (let y = y0; y < v.y + v.h + step; y += step) {
        const n = Math.sin(x * 0.21 + y * 0.13) * Math.cos(x * 0.07 - y * 0.19);
        if (n > 0.18) {
          ctx.globalAlpha = 0.35 + n * 0.3;
          ctx.beginPath();
          ctx.ellipse(x + (n * 9), y + (n * 7), 9 + n * 5, 6 + n * 4, n, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    for (const s of SCENERY) {
      ctx.fillStyle = s.kind === 'pond' ? PALETTE.pond : s.kind === 'field' ? PALETTE.field : PALETTE.lot;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      if (s.kind === 'field') {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 0.4;
        for (let x = s.x + 4; x < s.x + s.w; x += 6) {
          ctx.beginPath(); ctx.moveTo(x, s.y); ctx.lineTo(x, s.y + s.h); ctx.stroke();
        }
      }
      if (s.kind === 'pond') {
        ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 0.35;
        ctx.strokeRect(s.x + 0.6, s.y + 0.6, s.w - 1.2, s.h - 1.2);
      }
      if (s.kind === 'lot') {
        // parking bays, so a lot reads as a lot
        ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.lineWidth = 0.25;
        for (let x = s.x + 5; x < s.x + s.w - 1; x += 5) {
          ctx.beginPath(); ctx.moveTo(x, s.y + 1); ctx.lineTo(x, s.y + s.h - 1); ctx.stroke();
        }
      }
    }
  }

  drawRoads(ctx, state) {
    // kerb, then carriageway: a hard edge is what makes tarmac look like tarmac
    for (const r of roadRects()) {
      ctx.fillStyle = PALETTE.kerb;
      ctx.fillRect(r.x - 0.7, r.y - 0.7, r.w + 1.4, r.h + 1.4);
      ctx.fillStyle = PALETTE.roadEdge;
      ctx.fillRect(r.x - 0.25, r.y - 0.25, r.w + 0.5, r.h + 0.5);
      ctx.fillStyle = PALETTE.road;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.strokeStyle = PALETTE.centreLine;
    ctx.lineWidth = 0.35;
    ctx.setLineDash([3, 4]);
    for (const rd of ROADS) {
      ctx.beginPath(); ctx.moveTo(rd.x1, rd.y1); ctx.lineTo(rd.x2, rd.y2); ctx.stroke();
    }
    ctx.setLineDash([]);

    // station apron, with bay markings under the trucks
    const a = STATION.apron;
    ctx.fillStyle = '#5a5f68';
    ctx.fillRect(a.x, a.y, a.w, a.h);
    ctx.strokeStyle = 'rgba(255,220,120,0.35)'; ctx.lineWidth = 0.3;
    for (const bay of STATION.bays) {
      ctx.strokeRect(bay.x - 2.2, a.y + 0.6, 4.4, a.h - 1.2);
    }

    // clinic apron marker
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.ellipse(CLINIC.x, CLINIC.y, CLINIC.radiusM, CLINIC.radiusM, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Marks that live on the floor: spilled fuel, a shut-off fitting, a cleared stump. */
  drawGroundHazards(ctx, state) {
    for (const h of state.hazards) {
      if (h.kind === 'wreck' && h.fuelLeak > 0.02 && !h.burning) {
        ctx.fillStyle = `rgba(40,35,30,${Math.min(0.4, h.fuelLeak * 0.35)})`;
        ctx.beginPath(); ctx.ellipse(h.x + 1.4, h.y + 1.2, 1.2 + h.fuelLeak, 1.0 + h.fuelLeak, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Warm pools of light on the ground around anything burning. */
  drawFireLight(ctx, state, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const h of state.hazards) {
      if (h.kind === 'fire') {
        let n = 0;
        for (let i = 0; i < h.cells.length && n < 40; i++) {
          const c = h.cells[i];
          if (!c.burning) continue;
          n++;
          this.lightPool(ctx, c.x, c.y, 11 + wobble(i, t, 3) * 1.6, 0.10);
        }
      } else if (h.kind === 'wreck' && h.burning) {
        this.lightPool(ctx, h.x, h.y, 13 + wobble(3, t, 3) * 2, 0.13);
      }
    }
    ctx.restore();
  }

  lightPool(ctx, x, y, r, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,168,72,${alpha})`);
    g.addColorStop(0.5, `rgba(220,110,40,${alpha * 0.45})`);
    g.addColorStop(1, 'rgba(180,60,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  /* ── the standing world ─────────────────────────────────────────────────── */

  collectProps(state, t) {
    const cam = this.camera;

    /* Cull what is not on screen.
     *
     * Every building was extruded, windowed and lit on every frame no matter where the
     * camera was, and at phone zoom — 60 m across a 420 m town — that is ten buildings
     * drawn for nothing. Measured: buildings were 4.07 ms of a 4.80 ms frame.
     *
     * The test is generous on purpose. A building's drawn silhouette rises well above
     * its footprint in this projection and leans sideways with the lean, and smoke and
     * flame go higher still, so the margin is the tallest thing in town projected, not
     * the footprint. Culling something that is genuinely visible is a hole in the world;
     * keeping a few extra is a rounding error. */
    const v = cam.visibleM;
    const upM = (20 * cam.heightK) / cam.tilt + 30;      // tallest roof + its smoke column
    const inView = (x, y, w = 0, h = 0) =>
      x + w >= v.x - 24 && x <= v.x + v.w + 24 &&
      y + h >= v.y - 12 && y <= v.y + v.h + upM;
    this.culled = 0;

    for (const b of BUILDINGS) {
      if (!inView(b.x, b.y, b.w, b.h)) { this.culled++; continue; }
      this.collectBuilding(state, b, t);
    }

    for (let i = 0; i < TREES.length; i++) {
      const tr = TREES[i];
      if (!inView(tr.x - 5, tr.y - 5, 10, 10)) { this.culled++; continue; }
      this.prop(tr.y, (ctx) => this.drawTree(ctx, tr.x, tr.y, i, t),
        (ctx) => this.groundShadow(ctx, tr.x, tr.y, 2.8, 3.2));
    }

    for (const h of HYDRANTS) {
      if (!inView(h.x - 2, h.y - 2, 4, 4)) { this.culled++; continue; }
      this.prop(h.y, (ctx) => this.drawHydrant(ctx, state, h));
    }
    for (const p of POLES) {
      // a pole is short but its WIRES run to the next one, which may be off screen —
      // the wires are drawn in their own pass and are not culled with the pole
      if (!inView(p.x - 3, p.y - 3, 6, 6)) { this.culled++; continue; }
      this.prop(p.y, (ctx) => this.drawPole(ctx, p),
        (ctx) => this.groundShadow(ctx, p.x, p.y, 0.7, 0.5));
    }

    for (const h of state.hazards) {
      if (h.kind === 'tree') {
        this.prop(h.y, (ctx) => this.drawTreeHazard(ctx, h),
          (ctx) => this.groundShadow(ctx, h.x, h.y, h.radiusM, 1.4));
      } else if (h.kind === 'wreck') {
        this.prop(h.y, (ctx) => this.drawWreck(ctx, h, t),
          (ctx) => this.groundShadow(ctx, h.x + 0.6, h.y + 0.5, 2.6, 1.5));
      } else if (h.kind === 'gas') {
        this.prop(h.y, (ctx) => this.drawGasFitting(ctx, h));
      }
    }

    for (const tool of state.tools) {
      if (tool.carrier !== null && tool.carrier !== 'rack') continue;
      const x = tool.carrier === 'rack' ? state.rack.x + toolRackOffset(state, tool) : tool.x;
      const y = tool.carrier === 'rack' ? state.rack.y : tool.y;
      this.prop(y, (ctx) => this.drawTool(ctx, tool, x, y));
    }

    for (const v of state.victims) {
      if (v.delivered || v.inApparatusId) continue;
      this.prop(v.y, (ctx) => this.drawVictim(ctx, v),
        (ctx) => this.groundShadow(ctx, v.x + 0.2, v.y + 0.2, 0.9, 0.6));
    }

    for (const ap of state.apparatus) {
      this.prop(ap.y, (ctx) => this.drawApparatus(ctx, state, ap, t),
        (ctx) => this.apparatusShadow(ctx, state, ap));
    }

    for (const p of state.responders) {
      if (p.inVehicleId) continue;
      /* Somebody who has gone inside sorts with the building they are inside, not with
         the ground they are standing on — otherwise they draw behind its south wall and
         vanish. The building's roof fades for them; see collectBuilding. */
      const host = p.insideBuildingId ? BUILDING_BY_ID[p.insideBuildingId] : null;
      const depth = host ? host.y + host.h + 0.01 : p.y;
      this.prop(depth, (ctx) => this.drawResponder(ctx, state, p, t),
        host ? null : (ctx) => this.groundShadow(ctx, p.x + 0.2, p.y + 0.25, 0.75, 0.5));
    }

    // The gas cloud is drawn last of the props so it hangs in front of what it is
    // leaking out of, and it is nearly invisible without the meter — that is the point.
    const carryingMeter = holdingDef(state, 'gasmeter');
    for (const h of state.hazards) {
      if (h.kind !== 'gas') continue;
      this.prop(h.y + 0.02, (ctx) => this.drawGasCloud(ctx, h, carryingMeter));
    }
    void cam;
  }

  groundShadow(ctx, x, y, rx, ry) {
    ctx.fillStyle = PALETTE.shadow;
    ctx.beginPath();
    ctx.ellipse(x + rx * 0.28, y + ry * 0.30, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ── buildings ──────────────────────────────────────────────────────────── */

  collectBuilding(state, b, t) {
    const rec = state.town.buildings[b.id] || { damage: 0, boardedShifts: 0 };
    const fire = state.hazards.find((h) => h.kind === 'fire' && h.buildingId === b.id) || null;
    const occupied = state.responders.some((p) => p.insideBuildingId === b.id);
    const depth = b.y + b.h;

    /* A building that is between you and the camera has to get out of the way.
     *
     * This is not a nicety. The station's apron is on its NORTH side, so the first
     * thing a solid station does is hide all three appliances and the player standing
     * next to them. Anything the crew is doing behind a building goes translucent —
     * the building stays there, you can just see through it. */
    const veiled = !occupied && this.veils(b, state);

    this.prop(depth,
      (ctx) => {
        if (!veiled) { this.drawBuilding(ctx, state, b, rec, fire, occupied, t); return; }
        ctx.save();
        ctx.globalAlpha = 0.30;
        this.drawBuilding(ctx, state, b, rec, fire, occupied, t);
        ctx.restore();
      },
      veiled ? null : (ctx) => this.buildingShadow(ctx, b));
  }

  /** True when anyone the player is steering would be hidden behind this building. */
  veils(b, state) {
    const cam = this.camera;
    const H = (HEIGHT[b.kind] || 6) + (RIDGE[b.kind] || 0);
    const reach = (H + 2) * cam.heightK / cam.tilt;
    const behind = (x, y) => x > b.x - 1.5 && x < b.x + b.w + 1.5 &&
      y < b.y + b.h && y > b.y - reach;

    for (const p of state.responders) {
      if (!p.inVehicleId && behind(p.x, p.y)) return true;
    }
    for (const ap of state.apparatus) {
      // a truck with somebody in it is somebody; an empty parked one is scenery, and
      // veiling for scenery leaves the station permanently ghosted
      if (ap.driverId && behind(ap.x, ap.y)) return true;
    }
    return false;
  }

  /**
   * A shadow cast away from the light, which sits over the player's shoulder.
   *
   * It is thrown from the LEANED silhouette, not from the flat footprint. Drawn from
   * the footprint it sits square while the building above it leans, and the difference
   * reads as a grey slab lying next to the building rather than as its shadow.
   */
  buildingShadow(ctx, b) {
    const H = HEIGHT[b.kind] || 6;
    const dx = 0.16 * H, dy = 0.20 * H;
    const lean = (x) => (x - this.camera.centre.x) * H * this.camera.leanK;
    const pts = this.rectPts(b.x, b.y, b.w, b.h).map((p) => ({
      x: p.x + lean(p.x) * 0.5 + dx, y: p.y + dy,
    }));
    this.fillPoly(ctx, pts, PALETTE.shadow);
  }

  drawBuilding(ctx, state, b, rec, fire, occupied, t) {
    const H = HEIGHT[b.kind] || 6;
    const wall = WALL[b.kind] || '#d8d2c6';
    const roofCol = ROOF[b.kind] || '#9aa0a6';
    const pts = this.rectPts(b.x, b.y, b.w, b.h);

    // walls, and the eaves line that the roof sits on
    const eaves = this.prism(ctx, pts, H, { wall, top: null });

    this.drawWalls(ctx, state, b, H, fire);

    const ridge = RIDGE[b.kind];
    if (occupied) {
      /* Dollhouse. Somebody has gone in, so the roof comes off — a translucent roof was
         tried first and reads as a greenhouse, and the point is not "the roof is faint",
         it is "you can see what you have walked into". */
      this.drawOpenTop(ctx, b, H, ridge || 0, roofCol, fire, t);
    } else {
      if (ridge) this.drawPitchedRoof(ctx, b, H, ridge, roofCol, fire, t);
      else this.drawFlatRoof(ctx, b, H, eaves, roofCol, fire, t);

      if (b.id === 'church') this.drawSteeple(ctx, b, H);
      if (b.kind === 'house' || b.kind === 'housing') this.drawChimney(ctx, b, H, ridge || 0);
    }

    if (rec.damage > 0.02) {
      const soot = this.topPts(pts, H);
      this.fillPoly(ctx, soot, `rgba(24,20,18,${Math.min(0.7, rec.damage * 0.8)})`);
    }
    if (rec.boardedShifts > 0) this.drawBoards(ctx, b, H);

    const cap = this.camera.top(b.x + b.w / 2, b.y, H + (ridge || 0) + 1.2);
    this.labels.push({
      x: cap.x, y: cap.y, text: b.name,
      size: 11, colour: rec.damage > 0.4 ? '#ffb3a7' : '#fdf6e6', weight: 700,
    });
  }

  /**
   * Windows, on the walls where windows go — and they GLOW when the cell behind them
   * is alight.
   *
   * This is the one visual that tells you what is happening inside a building you
   * cannot see into, and it is read straight off the fire's own cells rather than from
   * a separate "is it bad in there" number. Three lit windows at the left-hand end of a
   * shop is a fire at the left-hand end of that shop.
   */
  drawWalls(ctx, state, b, H, fire) {
    const litAt = (x, y) => {
      if (!fire) return 0;
      let best = 0;
      for (const c of fire.cells) {
        if (!c.burning && c.heat < 0.35) continue;
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < 5) best = Math.max(best, (c.burning ? 1 : 0.45) * (1 - d / 5));
      }
      return best;
    };
    const pane = (x, y, w, h0, h1) => {
      const lit = litAt(x + w / 2, y);
      const quad = [
        this.camera.top(x, y, h0), this.camera.top(x + w, y, h0),
        this.camera.top(x + w, y, h1), this.camera.top(x, y, h1),
      ];
      this.fillPoly(ctx, quad, lit > 0.02
        ? `rgba(255,${Math.round(150 + lit * 80)},70,${(0.45 + lit * 0.5).toFixed(3)})`
        : 'rgba(46,58,72,0.72)', 'rgba(0,0,0,0.25)', 0.1);
    };

    const south = b.y + b.h;
    const storeys = Math.max(1, Math.round(H / 3.4));
    const spacing = 4.4;
    for (let s = 0; s < storeys; s++) {
      const base = 1.0 + s * (H - 1.2) / storeys;
      const h0 = base, h1 = Math.min(H - 0.5, base + 1.5);
      if (h1 - h0 < 0.5) continue;
      for (let x = b.x + 1.6; x < b.x + b.w - 2.4; x += spacing) pane(x, south, 2.0, h0, h1);
    }

    // The door, on the wall it is actually on. It is the only way in on foot, so it is
    // drawn wherever the simulation says it is rather than wherever it would look tidy.
    const dsouth = Math.abs(b.door.y - south) < 3.5;
    if (dsouth) {
      const quad = [
        this.camera.top(b.door.x - 1.1, south, 0), this.camera.top(b.door.x + 1.1, south, 0),
        this.camera.top(b.door.x + 1.1, south, 2.4), this.camera.top(b.door.x - 1.1, south, 2.4),
      ];
      this.fillPoly(ctx, quad, '#3b2f28', 'rgba(0,0,0,0.4)', 0.12);
    } else {
      ctx.fillStyle = 'rgba(60,50,44,0.75)';
      ctx.beginPath(); ctx.ellipse(b.door.x, b.door.y, 1.2, 0.8, 0, 0, Math.PI * 2); ctx.fill();
    }

    /* The station's bay doors, on the wall the apron is actually on. Drawn on the south
       wall by default they were on the wrong side of the building entirely — this town
       parks its appliances to the north. */
    if (b.id === 'station') {
      const apronNorth = STATION.apron.y < b.y;
      const wallY = apronNorth ? b.y : south;
      for (const bay of STATION.bays) {
        const quad = [
          this.camera.top(bay.x - 2.1, wallY, 0.1), this.camera.top(bay.x + 2.1, wallY, 0.1),
          this.camera.top(bay.x + 2.1, wallY, 4.2), this.camera.top(bay.x - 2.1, wallY, 4.2),
        ];
        this.fillPoly(ctx, quad, '#2b3038', 'rgba(255,255,255,0.18)', 0.12);
      }
    }
  }

  /** The roof taken off: the floor you are standing on, the fire on that floor, and a
   *  dashed line where the eaves were, so the building still has an outline. */
  drawOpenTop(ctx, b, H, ridgeH, roofCol, fire, t) {
    const floor = this.topPts(this.rectPts(b.x + 0.3, b.y + 0.3, b.w - 0.6, b.h - 0.6), 0.35);
    this.fillPoly(ctx, floor, '#4a4038');
    // interior walls catch a little light from the doorway
    this.fillPoly(ctx, floor, 'rgba(255,224,170,0.06)');
    this.drawRoofFire(ctx, b, 0.5, fire, t);

    const eaves = this.topPts(this.rectPts(b.x, b.y, b.w, b.h), H);
    ctx.save();
    ctx.setLineDash([1.6, 1.4]);
    this.path(ctx, eaves);
    ctx.strokeStyle = shade(roofCol, 1.05);
    ctx.lineWidth = 0.3;
    ctx.stroke();
    ctx.restore();
  }

  drawFlatRoof(ctx, b, H, eaves, roofCol, fire, t) {
    this.fillPoly(ctx, eaves, roofCol, 'rgba(0,0,0,0.3)', 0.16);
    // a parapet lip, so a flat roof still has an edge to catch the light
    const lip = this.topPts(this.rectPts(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1), H + 0.5);
    this.fillPoly(ctx, lip, shade(roofCol, 0.92), 'rgba(0,0,0,0.22)', 0.12);
    // roof furniture: plant, vents. Cheap, and it kills the blank-slab look.
    const vents = this.topPts(this.rectPts(b.x + b.w * 0.55, b.y + b.h * 0.3, 4.5, 3.0), H + 1.1);
    this.fillPoly(ctx, vents, shade(roofCol, 0.78), 'rgba(0,0,0,0.25)', 0.1);
    this.drawRoofFire(ctx, b, H + 0.6, fire, t);
  }

  /** Two slopes meeting at a ridge. This is most of what stops a town looking like a
   *  circuit board: nothing outdoors is flat on top. */
  drawPitchedRoof(ctx, b, H, ridgeH, roofCol, fire, t) {
    const cam = this.camera;
    const o = 0.5;                                   // the eaves overhang the walls
    const wide = b.w >= b.h;
    const nw = cam.top(b.x - o, b.y - o, H), ne = cam.top(b.x + b.w + o, b.y - o, H);
    const se = cam.top(b.x + b.w + o, b.y + b.h + o, H), sw = cam.top(b.x - o, b.y + b.h + o, H);

    if (wide) {
      const r1 = cam.top(b.x - o, b.y + b.h / 2, H + ridgeH);
      const r2 = cam.top(b.x + b.w + o, b.y + b.h / 2, H + ridgeH);
      this.fillPoly(ctx, [nw, ne, r2, r1], shade(roofCol, 1.14), 'rgba(0,0,0,0.28)', 0.14);
      this.fillPoly(ctx, [r1, r2, se, sw], shade(roofCol, 0.86), 'rgba(0,0,0,0.28)', 0.14);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.moveTo(r1.x, r1.y); ctx.lineTo(r2.x, r2.y); ctx.stroke();
      // gable ends: the triangle of wall under the ridge
      const gw = cam.top(b.x, b.y + b.h / 2, H + ridgeH);
      this.fillPoly(ctx, [cam.top(b.x, b.y, H), gw, cam.top(b.x, b.y + b.h, H)],
        shade(WALL[b.kind] || '#d8d2c6', 0.82));
    } else {
      const r1 = cam.top(b.x + b.w / 2, b.y - o, H + ridgeH);
      const r2 = cam.top(b.x + b.w / 2, b.y + b.h + o, H + ridgeH);
      this.fillPoly(ctx, [nw, r1, r2, sw], shade(roofCol, 1.10), 'rgba(0,0,0,0.28)', 0.14);
      this.fillPoly(ctx, [r1, ne, se, r2], shade(roofCol, 0.84), 'rgba(0,0,0,0.28)', 0.14);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.moveTo(r1.x, r1.y); ctx.lineTo(r2.x, r2.y); ctx.stroke();
    }
    this.drawRoofFire(ctx, b, H + ridgeH * 0.5, fire, t);
  }

  /**
   * The fire, drawn on the roof it is eating through.
   *
   * The cells are the simulation's own grid, projected up to roof height: char spreads
   * across the roof, wet cells darken where the line has been played, and flame breaks
   * out of the cells that are actually alight. Drawn flat on the ground it was invisible
   * the moment the building had walls — and "where is it spreading" is the single most
   * important thing this screen has to say.
   */
  drawRoofFire(ctx, b, h, fire, t) {
    if (!fire) return;
    const cam = this.camera;
    const cw = b.w / fire.cols, ch = b.h / fire.rows;
    for (let i = 0; i < fire.cells.length; i++) {
      const c = fire.cells[i];
      const quad = [
        cam.top(c.x - cw / 2, c.y - ch / 2, h), cam.top(c.x + cw / 2, c.y - ch / 2, h),
        cam.top(c.x + cw / 2, c.y + ch / 2, h), cam.top(c.x - cw / 2, c.y + ch / 2, h),
      ];
      if (c.burnt) this.fillPoly(ctx, quad, 'rgba(20,16,14,0.80)');
      if (c.wet > 0.05 && !c.burning) this.fillPoly(ctx, quad, `rgba(90,160,210,${Math.min(0.32, c.wet * 0.30)})`);
      if (c.heat > 0.15 && !c.burning) this.fillPoly(ctx, quad, `rgba(220,110,50,${Math.min(0.35, (c.heat - 0.15) * 0.5)})`);
    }

    /* Flame in a second, additive pass so that adjacent burning cells merge into one
       body of fire instead of reading as a tidy grid of orange lamps, and standing up
       out of the roof rather than lying on it. The grid is the simulation's business,
       not the player's. */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < fire.cells.length; i++) {
      const c = fire.cells[i];
      if (!c.burning) continue;
      const f = 0.80 + wobble(i, t, 8) * 0.18;
      const r = Math.max(cw, ch) * 0.78 * f;
      const p = cam.top(c.x, c.y, h + 1.1 * f);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1, 1.32 / cam.tilt);
      /* The gradient MUST be built after the transform. A canvas gradient is resolved in
         the user space it is painted in, not the one it was created in, so building it
         at p and then translating to p puts its centre at 2p — which is why the fire was
         a few dim specks on the roof instead of a fire. */
      const g = ctx.createRadialGradient(0, 0, r * 0.10, 0, 0, r);
      g.addColorStop(0, 'rgba(255,238,175,0.46)');
      g.addColorStop(0.40, 'rgba(255,140,32,0.38)');
      g.addColorStop(1, 'rgba(180,40,12,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  drawSteeple(ctx, b, H) {
    const cam = this.camera;
    const cx = b.x + b.w * 0.5, cy = b.y + b.h * 0.28;
    const tower = this.rectPts(cx - 2.6, cy - 2.6, 5.2, 5.2);
    const top = this.prism(ctx, tower, H + 7, { wall: shade(WALL.civic, 0.98) });
    const apex = cam.top(cx, cy, H + 14);
    this.fillPoly(ctx, [top[3], top[2], apex], shade(ROOF.civic, 0.8));
    this.fillPoly(ctx, [top[0], top[3], apex], shade(ROOF.civic, 1.05));
    ctx.strokeStyle = '#efe6cf'; ctx.lineWidth = 0.2;
    const c1 = cam.top(cx, cy, H + 14), c2 = cam.top(cx, cy, H + 15.6);
    ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.stroke();
  }

  drawChimney(ctx, b, H, ridgeH) {
    const cx = b.x + b.w * 0.74, cy = b.y + b.h * 0.5;
    const stack = this.rectPts(cx - 0.8, cy - 0.8, 1.6, 1.6);
    this.prism(ctx, stack, H + ridgeH + 1.4, { wall: '#8d6b58', top: '#5f463a' });
  }

  drawBoards(ctx, b, H) {
    const south = b.y + b.h;
    ctx.strokeStyle = '#8a6a45';
    ctx.lineWidth = 0.55;
    for (const [h0, h1] of [[1.0, 2.6], [2.4, 1.0]]) {
      const p0 = this.camera.top(b.x + 1, south, h0);
      const p1 = this.camera.top(b.x + b.w - 1, south, h1);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
  }

  /* ── trees, poles, wires, hydrants ──────────────────────────────────────── */

  drawTree(ctx, x, y, i, t) {
    const cam = this.camera;
    // size and lean vary per tree, from the index — a row of identical trees reads as
    // wallpaper, and this costs nothing and is stable across frames
    const r = 2.6 + ((i * 37) % 11) / 11 * 1.4;
    const hh = 3.4 + ((i * 29) % 9) / 9 * 1.6;
    const sway = wobble(i, t, 0.5) * 0.22;

    /* The trunk runs INTO the canopy, not up to it. Drawn to the canopy's underside it
       reads as a ball floating over a stick, which is what the first pass looked like. */
    const trunkTop = cam.top(x + sway * 0.5, y, hh + r * 0.35);
    ctx.strokeStyle = PALETTE.treeTrunk;
    ctx.lineWidth = 0.55;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(trunkTop.x, trunkTop.y); ctx.stroke();

    const blob = (dx, dy, dh, rad, col) => {
      const p = cam.top(x + dx + sway, y + dy, hh + dh);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rad, rad * 0.92, 0, 0, Math.PI * 2); ctx.fill();
    };
    blob(0.8, 0.4, 0.2, r * 0.86, PALETTE.treeDark);
    blob(-0.6, 0.1, 0.9, r * 0.90, PALETTE.tree);
    blob(-0.9, -0.4, 1.7, r * 0.58, PALETTE.treeLit);
  }

  drawPole(ctx, p) {
    const cam = this.camera;
    const top = cam.top(p.x, p.y, 8.4);
    ctx.strokeStyle = PALETTE.pole;
    ctx.lineWidth = 0.42;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(top.x, top.y); ctx.stroke();
    const a = cam.top(p.x - 1.6, p.y, 7.8), b = cam.top(p.x + 1.6, p.y, 7.8);
    ctx.lineWidth = 0.3;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  /**
   * Wires between poles, at pole-top height and sagging.
   *
   * They were not drawn at all before, which is why a downed line had nothing to be
   * down FROM. Poles are strung to their neighbour along a run — same road, in x order —
   * and nothing else, so the town does not end up in a cat's cradle.
   */
  drawWires(ctx) {
    const cam = this.camera;
    const runs = new Map();
    for (const p of POLES) {
      const key = Math.round(p.y / 6);
      if (!runs.has(key)) runs.set(key, []);
      runs.get(key).push(p);
    }
    ctx.strokeStyle = PALETTE.wire;
    ctx.lineWidth = 0.14;
    for (const run of runs.values()) {
      run.sort((a, b) => a.x - b.x);
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1], b = run[i];
        if (b.x - a.x > 210) continue;
        for (const off of [-1.4, 1.4]) {
          const p0 = cam.top(a.x + off, a.y, 7.8);
          const p1 = cam.top(b.x + off, b.y, 7.8);
          const mid = cam.top((a.x + b.x) / 2 + off, (a.y + b.y) / 2, 6.4);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.quadraticCurveTo(mid.x, mid.y, p1.x, p1.y);
          ctx.stroke();
        }
      }
    }
  }

  drawHydrant(ctx, state, h) {
    const dead = (state.town.hydrants[h.id] || {}).damaged;
    const cam = this.camera;
    const body = this.rectPts(h.x - 0.35, h.y - 0.35, 0.7, 0.7);
    this.prism(ctx, body, 0.9, { wall: dead ? PALETTE.hydrantDead : PALETTE.hydrant, top: '#f0e6d8' });
    const cap = cam.top(h.x, h.y, 1.05);
    ctx.fillStyle = dead ? '#4f4f4f' : '#a8352a';
    ctx.beginPath(); ctx.ellipse(cap.x, cap.y, 0.62, 0.4, 0, 0, Math.PI * 2); ctx.fill();

    if (state.apparatus.some((a) => a.hydrantId === h.id)) {
      ctx.strokeStyle = '#7fd1ff'; ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.ellipse(h.x, h.y, 1.9, 1.9, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* ── hazards that stand up ──────────────────────────────────────────────── */

  drawTreeHazard(ctx, h) {
    if (h.cleared) {
      const stump = this.rectPts(h.x - 0.9, h.y - 0.9, 1.8, 1.8);
      this.prism(ctx, stump, 0.5, { wall: '#4a3a2a', top: '#e8d9a8' });
      return;
    }
    const cam = this.camera;
    const len = h.radiusM * 2 * (1 - h.cut * 0.45);
    const ang = 0.7, ca = Math.cos(ang), sa = Math.sin(ang);
    const pt = (dx, dy) => ({ x: h.x + dx * ca - dy * sa, y: h.y + dx * sa + dy * ca });
    // a trunk is a lying-down cylinder: extrude its footprint and round the top
    const trunk = [pt(-len / 2, -1.0), pt(len / 2, -1.0), pt(len / 2, 1.0), pt(-len / 2, 1.0)];
    this.prism(ctx, trunk, 1.9, { wall: PALETTE.treeTrunk, top: shade(PALETTE.treeTrunk, 1.25) });

    for (const [dx, rad] of [[-len / 2, 3.0], [len / 2, 2.4]]) {
      const c = pt(dx, 0);
      const p = cam.top(c.x, c.y, 2.6);
      ctx.fillStyle = PALETTE.treeDark;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rad, rad / cam.tilt * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (h.cut > 0) {
      const c = cam.top(h.x, h.y, 2.2);
      ctx.fillStyle = '#e8d9a8';
      ctx.fillRect(c.x - 2, c.y - 0.5, 4 * h.cut, 0.9);
    }
  }

  drawWreck(ctx, w, t) {
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    const pt = (dx, dy) => ({ x: w.x + dx * ca - dy * sa, y: w.y + dx * sa + dy * ca });
    const body = [pt(-2.2, -1.1), pt(2.2, -1.1), pt(2.2, 1.1), pt(-2.2, 1.1)];
    const col = w.burning ? '#4a3a34' : w.kindTag === 'machine' ? '#7d8a56' : '#7a8ba0';
    this.prism(ctx, body, 1.5, { wall: col, top: shade(col, 1.12) });
    // crumpled cabin, sitting lower than it should
    const cab = [pt(-0.7, -0.9), pt(0.9, -0.9), pt(0.9, 0.9), pt(-0.7, 0.9)];
    this.prism(ctx, cab, 2.2, { wall: shade(col, 0.72), top: 'rgba(30,36,46,0.85)' });

    if (w.burning) {
      const cam = this.camera;
      const f = 0.8 + wobble(7, t, 9) * 0.2;
      const p = cam.top(w.x, w.y, 2.4 * f);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(p.x, p.y);
      ctx.scale(1, 1.7 / cam.tilt);
      const g = ctx.createRadialGradient(0, 0, 0.4, 0, 0, 3.4 * f);
      g.addColorStop(0, 'rgba(255,235,160,0.9)');
      g.addColorStop(0.5, 'rgba(255,140,40,0.6)');
      g.addColorStop(1, 'rgba(180,40,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 3.4 * f, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  drawGasFitting(ctx, gas) {
    const meter = this.rectPts(gas.x - 0.5, gas.y - 0.4, 1.0, 0.8);
    this.prism(ctx, meter, 1.3, { wall: gas.shutOff ? '#6d8f5a' : '#c9c25a', top: '#e8e6c0' });
  }

  drawGasCloud(ctx, gas, visible) {
    const cam = this.camera;
    const R = CONFIG.gas.cloudRadiusM;
    const alpha = visible ? Math.min(0.42, 0.10 + gas.ppm * 0.34) : Math.min(0.10, gas.ppm * 0.07);
    const p = cam.top(gas.x, gas.y, 1.6);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 1 / cam.tilt * 0.7);
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, R);
    g.addColorStop(0, `rgba(190,220,140,${alpha})`);
    g.addColorStop(1, 'rgba(190,220,140,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** The live zone, and the wire that is down. Drawn over the town, because being
   *  hidden behind a truck is precisely how it kills somebody. */
  drawPowerZones(ctx, state, t) {
    const cam = this.camera;
    for (const pwr of state.hazards) {
      if (pwr.kind !== 'power') continue;
      if (!pwr.live) {
        ctx.strokeStyle = 'rgba(120,120,130,0.6)'; ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.ellipse(pwr.x, pwr.y, 1.4, 1.4, 0, 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      const pulse = 0.5 + 0.5 * Math.sin(t * 5);
      ctx.fillStyle = `rgba(120,190,255,${0.10 + pulse * 0.07})`;
      ctx.beginPath(); ctx.ellipse(pwr.x, pwr.y, pwr.radiusM, pwr.radiusM, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(150,215,255,${0.55 + pulse * 0.35})`;
      ctx.lineWidth = 0.35;
      ctx.setLineDash([1.4, 1.2]);
      ctx.beginPath(); ctx.ellipse(pwr.x, pwr.y, pwr.radiusM, pwr.radiusM, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      const pole = POLES.find((p) => p.id === pwr.poleId);
      if (pole) {
        // the wire hangs from the crossarm to where it is lying, which is what makes
        // "that came off THAT pole" readable without a label
        const top = cam.top(pole.x, pole.y, 7.6);
        const sag = cam.top((pole.x + pwr.x) / 2, (pole.y + pwr.y) / 2, 1.6);
        ctx.strokeStyle = '#2f2f36'; ctx.lineWidth = 0.26;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.quadraticCurveTo(sag.x, sag.y, pwr.x, pwr.y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(180,230,255,${pulse})`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(pwr.x - 0.9, pwr.y);
        ctx.lineTo(pwr.x, pwr.y - 0.7 - pulse);
        ctx.lineTo(pwr.x + 0.9, pwr.y);
        ctx.stroke();
      }
    }
  }

  /* ── things in the air ──────────────────────────────────────────────────── */

  /* Smoke reads the fire; it must not hide it. A puff per burning cell buried the
   * flame under grey circles the first time this was drawn, so the column is thinned:
   * every third burning cell, capped at eight, and lighter. Both smoke and embers rise
   * over the rooftops, which is what makes a working fire visible three streets away. */
  drawSmokeAndEmbers(ctx, state, t) {
    for (const h of state.hazards) {
      if (h.kind === 'fire') {
        const b = BUILDING_BY_ID[h.buildingId];
        const base = (HEIGHT[b.kind] || 6) + (RIDGE[b.kind] || 0);
        let n = 0, seen = 0;
        for (let i = 0; i < h.cells.length && n < 8; i++) {
          const c = h.cells[i];
          if (!c.burning) continue;
          if (seen++ % 3) continue;
          n++;
          this.drawSmokePuff(ctx, c.x, c.y, base, Math.min(1, c.heat), t, i);
        }
      } else if (h.kind === 'wreck' && h.burning) {
        this.drawSmokePuff(ctx, h.x, h.y, 1.6, 1, t, 91);
      }
    }
    this.drawEmbers(ctx, state, t);
  }

  drawSmokePuff(ctx, x, y, baseH, strength, t, seed) {
    const cam = this.camera;
    for (let k = 0; k < 3; k++) {
      const phase = (t * 0.5 + k * 0.33 + seed * 0.17) % 1;
      const rad = 1.1 + phase * 2.9;
      const alpha = (1 - phase) * 0.15 * strength;
      const p = cam.top(x + wobble(seed + k, t, 1.2) * 2.4, y, baseH + 1 + phase * 13);
      ctx.fillStyle = `rgba(66,64,70,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad, rad * 0.86, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Embers riding the column. Deterministic — no Math.random in the renderer. */
  drawEmbers(ctx, state, t) {
    const cam = this.camera;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const h of state.hazards) {
      if (h.kind !== 'fire') continue;
      const b = BUILDING_BY_ID[h.buildingId];
      const base = (HEIGHT[b.kind] || 6) + (RIDGE[b.kind] || 0);
      let seen = 0;
      for (let i = 0; i < h.cells.length; i++) {
        const c = h.cells[i];
        if (!c.burning) continue;
        if (seen++ % 2) continue;
        for (let k = 0; k < 2; k++) {
          const phase = (t * 0.42 + i * 0.29 + k * 0.5) % 1;
          const a = (1 - phase) * 0.5;
          const p = cam.top(c.x + wobble(i + k, t, 0.9) * 3.2, c.y, base + phase * 15);
          ctx.fillStyle = `rgba(255,${170 + Math.round(phase * 60)},90,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 0.26 * (1 - phase * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /** A soft edge on the frame. Cheap, and it stops the town looking like a spreadsheet. */
  drawVignette(ctx) {
    const cam = this.camera;
    const g = ctx.createRadialGradient(
      cam.cssW / 2, cam.cssH / 2, Math.min(cam.cssW, cam.cssH) * 0.42,
      cam.cssW / 2, cam.cssH / 2, Math.max(cam.cssW, cam.cssH) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(6,10,14,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cam.cssW, cam.cssH);
  }

  /* ── actors ─────────────────────────────────────────────────────────────── */

  drawTool(ctx, tool, x, y) {
    const box = this.rectPts(x - 0.5, y - 0.32, 1.0, 0.64);
    this.prism(ctx, box, 0.55, { wall: shade(toolColour(tool.defId), 0.75), top: toolColour(tool.defId) });
    const cap = this.camera.top(x, y, 1.5);
    this.labels.push({ x: cap.x, y: cap.y, text: tool.short, size: 9, colour: '#ffe9b0', weight: 700 });
  }

  drawVictim(ctx, v) {
    const cam = this.camera;
    const st = victimState(v);
    const ring = st === 'lost' ? '#5c5c5c' : st === 'unconscious' ? '#8e44ad'
      : st === 'critical' ? '#e74c3c' : st === 'injured' ? '#e8a33d' : '#5fbf6a';

    // a casualty is lying down: low to the ground, and the marker does the work
    ctx.fillStyle = v.lost ? '#6d6a6a' : PALETTE.victim;
    ctx.beginPath(); ctx.ellipse(v.x, v.y, 1.05, 0.62, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(40,36,34,0.55)';
    ctx.beginPath(); ctx.ellipse(v.x - 0.62, v.y - 0.1, 0.34, 0.3, 0, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = ring; ctx.lineWidth = 0.28;
    ctx.beginPath(); ctx.ellipse(v.x, v.y, 1.5, 1.0, 0, 0, Math.PI * 2); ctx.stroke();

    if (v.trappedBy) {
      ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 0.25;
      ctx.beginPath();
      ctx.moveTo(v.x - 1.6, v.y - 1.0); ctx.lineTo(v.x + 1.6, v.y + 1.0);
      ctx.moveTo(v.x + 1.6, v.y - 1.0); ctx.lineTo(v.x - 1.6, v.y + 1.0);
      ctx.stroke();
    }
    if (!v.lost) {
      // condition bar, floating above them: the only number a player needs about a person
      const p = cam.top(v.x, v.y, 2.2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(p.x - 1.1, p.y - 0.3, 2.2, 0.6);
      ctx.fillStyle = ring;
      ctx.fillRect(p.x - 1.06, p.y - 0.24, 2.12 * v.condition, 0.48);
    }
  }

  apparatusShadow(ctx, state, ap) {
    const def = state.apparatusDefs[ap.defId];
    const ca = Math.cos(ap.angle), sa = Math.sin(ap.angle);
    const L = def.lengthM, W = def.widthM;
    const pt = (dx, dy) => ({ x: ap.x + dx * ca - dy * sa + 0.5, y: ap.y + dx * sa + dy * ca + 0.6 });
    this.fillPoly(ctx, [pt(-L / 2, -W / 2), pt(L / 2, -W / 2), pt(L / 2, W / 2), pt(-L / 2, W / 2)],
      PALETTE.shadow);
  }

  drawApparatus(ctx, state, ap, t) {
    const cam = this.camera;
    const def = state.apparatusDefs[ap.defId];
    const L = def.lengthM, W = def.widthM;
    const ca = Math.cos(ap.angle), sa = Math.sin(ap.angle);
    const pt = (dx, dy) => ({ x: ap.x + dx * ca - dy * sa, y: ap.y + dx * sa + dy * ca });
    const quad = (x0, y0, x1, y1) => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];

    /* Wheels first, so the body sits on them — but FLAT.
     *
     * They were four extruded prisms per truck: twenty filled and stroked polygons each,
     * for a shape 1 m by 0.4 m that is half hidden under the body. Measured, three
     * trucks were taking 3.4 ms of a 4.5 ms frame — 76% — and this was most of it. A
     * dark quad at ground level reads exactly the same at every zoom the game uses. */
    for (const wx of [L * 0.30, -L * 0.26]) {
      for (const wy of [-W / 2 - 0.05, W / 2 - 0.35]) {
        this.fillPoly(ctx, quad(wx - 0.5, wy, wx + 0.5, wy + 0.4), '#20232a');
      }
    }

    // body: a box with a lower bonnet in front of it, which is what makes a truck a
    // truck at a glance rather than a coloured brick
    const bodyH = def.patientBay ? 2.9 : 3.0;
    const body = quad(-L / 2, -W / 2, L * 0.22, W / 2);
    const bodyTop = this.prism(ctx, body, bodyH, { wall: def.tint, top: shade(def.tint, 1.22) });
    // The cab is LOWER and lighter than the body. Same height and same colour and a
    // truck is a brick from every angle except the one you happen to be looking from.
    const cab = quad(L * 0.16, -W / 2 + 0.08, L / 2, W / 2 - 0.08);
    this.prism(ctx, cab, 2.3, { wall: shade(def.tint, 1.06), top: shade(def.tint, 1.3) });

    // windscreen, at the front of the cab and up where a windscreen is
    const wsA = pt(L / 2 - 0.2, -W / 2 + 0.4), wsB = pt(L / 2 - 0.2, W / 2 - 0.4);
    this.fillPoly(ctx, [
      cam.top(wsA.x, wsA.y, 1.5), cam.top(wsB.x, wsB.y, 1.5),
      cam.top(wsB.x, wsB.y, 2.1), cam.top(wsA.x, wsA.y, 2.1),
    ], 'rgba(150,200,235,0.6)', 'rgba(20,24,32,0.6)', 0.1);

    // the reflective band every appliance in the world has, on the side that shows
    const bandA = pt(-L / 2 + 0.2, W / 2), bandB = pt(L * 0.2, W / 2);
    this.fillPoly(ctx, [
      cam.top(bandA.x, bandA.y, 0.9), cam.top(bandB.x, bandB.y, 0.9),
      cam.top(bandB.x, bandB.y, 1.4), cam.top(bandA.x, bandA.y, 1.4),
    ], 'rgba(255,255,255,0.30)');

    // kit that identifies the truck at a glance, without reading the label
    if (def.hose) {                                    // engine: a ladder on the roof
      ctx.strokeStyle = 'rgba(230,235,240,0.85)'; ctx.lineWidth = 0.16;
      const l0 = cam.top(pt(-L / 2 + 0.7, -W / 2 + 0.5).x, pt(-L / 2 + 0.7, -W / 2 + 0.5).y, bodyH + 0.2);
      const l1 = cam.top(pt(L * 0.15, -W / 2 + 0.5).x, pt(L * 0.15, -W / 2 + 0.5).y, bodyH + 0.2);
      const l2 = cam.top(pt(-L / 2 + 0.7, W / 2 - 0.5).x, pt(-L / 2 + 0.7, W / 2 - 0.5).y, bodyH + 0.2);
      const l3 = cam.top(pt(L * 0.15, W / 2 - 0.5).x, pt(L * 0.15, W / 2 - 0.5).y, bodyH + 0.2);
      ctx.beginPath(); ctx.moveTo(l0.x, l0.y); ctx.lineTo(l1.x, l1.y);
      ctx.moveTo(l2.x, l2.y); ctx.lineTo(l3.x, l3.y); ctx.stroke();
    } else if (def.patientBay) {                       // ambulance: a red cross
      const c = pt(-L * 0.16, W / 2);
      const p = cam.top(c.x, c.y, 1.9);
      ctx.fillStyle = '#d8453a';
      ctx.fillRect(p.x - 0.55, p.y - 0.16, 1.1, 0.32);
      ctx.fillRect(p.x - 0.16, p.y - 0.55, 0.32, 1.1);
    } else {                                           // rescue: roll-up shutters
      ctx.strokeStyle = 'rgba(30,30,34,0.55)'; ctx.lineWidth = 0.12;
      for (let i = 0; i < 4; i++) {
        const a = pt(-L / 2 + 0.6 + i * 0.9, W / 2), p0 = cam.top(a.x, a.y, 0.5), p1 = cam.top(a.x, a.y, 2.2);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
    }

    if (ap.damage > 0.08) {
      this.fillPoly(ctx, bodyTop, `rgba(30,24,20,${Math.min(0.55, ap.damage)})`);
    }

    const blink = Math.sin(t * 12) > 0;
    if (ap.siren) {
      // The lightbar sits on the cab roof, where it can be seen over the traffic.
      const barA = pt(L * 0.2, -W / 2 + 0.3), barB = pt(L * 0.2, W / 2 - 0.3);
      const a = cam.top(barA.x, barA.y, 2.8), b = cam.top(barB.x, barB.y, 2.8);
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = blink ? '#ff4444' : '#5588ff';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(ap.x, ap.y, 0, ap.x, ap.y, 9);
      g.addColorStop(0, blink ? 'rgba(255,60,60,0.18)' : 'rgba(70,120,255,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ap.x, ap.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      const r = CONFIG.drive.sirenClearRadiusM * (0.6 + 0.4 * Math.abs(Math.sin(t * 3)));
      ctx.strokeStyle = `rgba(255,120,120,${blink ? 0.16 : 0.10})`;
      ctx.lineWidth = 0.4;
      ctx.beginPath(); ctx.ellipse(ap.x, ap.y, r, r, 0, 0, Math.PI * 2); ctx.stroke();
    }

    const cap = cam.top(ap.x, ap.y, bodyH + 1.6);
    this.labels.push({ x: cap.x, y: cap.y, text: ap.short, size: 10, colour: '#ffffff', weight: 700 });
  }

  drawHose(ctx, state) {
    for (const t of state.tools) {
      if (t.defId !== 'hose') continue;
      const eng = state.apparatus.find((a) => a.id === t.engineId);
      if (!eng) continue;
      // A tool's carrier is a responder id now, so the line is drawn to whoever is
      // actually on the end of it rather than to "the player".
      const holder = state.responders.find((q) => q.id === t.carrier) || null;
      const held = !!holder;
      const nx = held ? holder.x : (t.carrier === eng.id ? eng.x : t.x);
      const ny = held ? holder.y : (t.carrier === eng.id ? eng.y : t.y);
      if (!held && t.carrier === eng.id) continue;

      const d = Math.hypot(nx - eng.x, ny - eng.y);
      const slack = Math.max(0, CONFIG.water.hoseMaxLengthM - d) * 0.06;
      const mx = (eng.x + nx) / 2, my = (eng.y + ny) / 2 + slack;
      ctx.strokeStyle = t.flowing ? '#f0f4f8' : '#d9dde2';
      ctx.lineWidth = 0.42;
      ctx.beginPath();
      ctx.moveTo(eng.x, eng.y);
      ctx.quadraticCurveTo(mx, my, nx, ny);
      ctx.stroke();
      ctx.strokeStyle = d > CONFIG.water.hoseMaxLengthM * 0.92 ? 'rgba(255,90,90,0.9)' : 'rgba(60,70,80,0.5)';
      ctx.lineWidth = 0.16;
      ctx.stroke();

      if (t.flowing && holder) this.drawStream(ctx, holder, CONFIG.water.streamReachM,
        (CONFIG.water.streamHalfAngleDeg * Math.PI) / 180, 'rgba(190,225,255,0.30)');
    }
    // the extinguisher gets a cone too, so "it is not reaching" is visible
    for (const t of state.tools) {
      if (t.defId !== 'extinguisher' || !t.flowing) continue;
      const holder = state.responders.find((q) => q.id === t.carrier);
      if (holder) this.drawStream(ctx, holder, 4.6, 0.4, 'rgba(230,240,255,0.28)');
    }
  }

  /** One cone, wherever the nozzle actually is. Drawn on the ground plane, because the
   *  ground plane is where the reach it is showing you is measured. */
  drawStream(ctx, holder, reach, half, fill) {
    const a0 = holder.facing;
    const g = ctx.createRadialGradient(holder.x, holder.y, 0.4, holder.x, holder.y, reach);
    g.addColorStop(0, fill);
    g.addColorStop(1, 'rgba(190,225,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(holder.x, holder.y);
    ctx.arc(holder.x, holder.y, reach, a0 - half, a0 + half);
    ctx.closePath();
    ctx.fill();
  }

  drawResponder(ctx, state, p, t) {
    const cam = this.camera;
    const r = CONFIG.player.radiusM;

    /* A dark base under the boots. A yellow responder standing in a yellow fire is
       invisible, and the one thing that must always be findable on this screen is the
       person you are controlling. */
    ctx.fillStyle = 'rgba(18,16,22,0.85)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, r * 1.7, r * 1.1, 0, 0, Math.PI * 2); ctx.fill();

    // facing pip on the ground: which way "use" will point
    ctx.strokeStyle = 'rgba(24,28,36,0.9)'; ctx.lineWidth = 0.22;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(p.facing) * (r * 3.0), p.y + Math.sin(p.facing) * (r * 3.0));
    ctx.stroke();

    // Turnout coat in the crew colour, standing up: two people are never confused for
    // each other, and a person now has a height to read against a truck and a doorway.
    const tint = p.tint || '#f6c445';
    const legs = this.rectPts(p.x - r * 0.7, p.y - r * 0.5, r * 1.4, r);
    this.prism(ctx, legs, 0.85, { wall: '#3a4048', top: null, edge: null });
    const torso = this.rectPts(p.x - r * 0.85, p.y - r * 0.6, r * 1.7, r * 1.2);
    this.prism(ctx, torso, 1.55, { wall: tint, top: shade(tint, 1.1), edge: 'rgba(0,0,0,0.35)' });

    const band0 = cam.top(p.x - r * 0.85, p.y + r * 0.6, 1.05);
    const band1 = cam.top(p.x + r * 0.85, p.y + r * 0.6, 1.05);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.14;
    ctx.beginPath(); ctx.moveTo(band0.x, band0.y); ctx.lineTo(band1.x, band1.y); ctx.stroke();

    const head = cam.top(p.x, p.y, 1.8);
    ctx.fillStyle = p.soot > 0.3 ? PALETTE.playerSoot : PALETTE.player;
    ctx.beginPath(); ctx.ellipse(head.x, head.y, r * 0.75, r * 0.62, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade(tint, 0.92);           // helmet
    ctx.beginPath(); ctx.ellipse(head.x, head.y - 0.2, r * 0.9, r * 0.5, 0, Math.PI, 0); ctx.fill();

    if (p.stunMs > 0) {
      ctx.strokeStyle = `rgba(255,220,90,${0.4 + 0.4 * Math.abs(Math.sin(t * 14))})`;
      ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, r * 3, r * 2, 0, 0, Math.PI * 2); ctx.stroke();
    }

    const held = state.tools.find((q) => q.carrier === p.id);
    if (held) {
      const hx = p.x + Math.cos(p.facing) * 0.9, hy = p.y + Math.sin(p.facing) * 0.9;
      const g = cam.top(hx, hy, 1.1);
      ctx.fillStyle = toolColour(held.defId);
      ctx.fillRect(g.x - 0.35, g.y - 0.28, 0.7, 0.56);
    }
    if (p.draggingVictimId) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.2;
      const v = state.victims.find((q) => q.id === p.draggingVictimId);
      if (v) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(v.x, v.y); ctx.stroke(); }
    }
  }

  drawBounds(ctx, state) {
    ctx.strokeStyle = 'rgba(0,255,255,0.4)'; ctx.lineWidth = 0.15;
    for (const b of BUILDINGS) ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = 'rgba(255,255,0,0.35)';
    for (const h of state.hazards) {
      if (h.radiusM) { ctx.beginPath(); ctx.ellipse(h.x, h.y, h.radiusM, h.radiusM, 0, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  /* ── screen space ───────────────────────────────────────────────────────── */

  drawLabels(ctx) {
    const cam = this.camera;
    const dense = cam.visibleM.w < 150;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of this.labels) {
      if (!dense && l.size < 11) continue;
      const s = cam.worldToScreen(l.x, l.y);
      if (s.x < -60 || s.y < -30 || s.x > cam.cssW + 60 || s.y > cam.cssH + 30) continue;
      ctx.font = `${l.weight || 600} ${l.size}px "Segoe UI", system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(l.text, s.x, s.y);
      ctx.fillStyle = l.colour || PALETTE.ui;
      ctx.fillText(l.text, s.x, s.y);
    }
  }

  /** Every open call gets a marker, and every off-screen call gets an arrow. The town
   *  keeps going without you — so it had better keep telling you where. */
  drawIncidentMarkers(ctx, state, t) {
    const cam = this.camera;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);

    for (const inc of state.incidents) {
      if (inc.status !== 'queued' && inc.status !== 'active') continue;
      const colour = inc.priority === 'critical' ? '#ff5252' : inc.priority === 'high' ? '#ffa726' : '#ffe082';
      const s = cam.worldToScreen(inc.x, inc.y);
      const onScreen = s.x > 20 && s.y > 20 && s.x < cam.cssW - 20 && s.y < cam.cssH - 20;

      if (onScreen) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.35 + pulse * 0.35;
        // an ellipse, because it is lying on a tilted ground plane like everything else
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, 24 + pulse * 6, (24 + pulse * 6) * cam.tilt, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = colour;
        ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(inc.headline, s.x, s.y - 30);
      } else {
        const cx = cam.cssW / 2, cy = cam.cssH / 2;
        const a = Math.atan2(s.y - cy, s.x - cx);
        const rx = cam.cssW / 2 - 34, ry = cam.cssH / 2 - 34;
        const k = Math.min(Math.abs(rx / Math.cos(a)), Math.abs(ry / Math.sin(a)));
        const ex = cx + Math.cos(a) * k, ey = cy + Math.sin(a) * k;
        ctx.save();
        ctx.translate(ex, ey); ctx.rotate(a);
        ctx.fillStyle = colour;
        ctx.globalAlpha = 0.55 + pulse * 0.35;
        ctx.beginPath();
        ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-8, 7);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
        const dm = Math.round(Math.hypot(inc.x - state.player.x, inc.y - state.player.y));
        ctx.fillStyle = colour;
        ctx.font = '700 10px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        // keep the label on screen: at the left edge it was being drawn half off it
        const lx = Math.min(cam.cssW - 70, Math.max(70, ex - Math.cos(a) * 26));
        const ly = Math.min(cam.cssH - 14, Math.max(14, ey - Math.sin(a) * 26));
        ctx.fillText(`${inc.headline} ${dm}m`, lx, ly);
      }
    }
    ctx.globalAlpha = 1;
  }
}

/* ── small helpers ────────────────────────────────────────────────────────── */

/** True when ANY responder is carrying the meter — the gas is drawn for the crew,
 *  not for one nominated person. */
function holdingDef(state, defId) {
  return state.tools.some((q) => q.defId === defId &&
    state.responders.some((r) => r.id === q.carrier));
}

function toolColour(defId) {
  return {
    hose: '#e8eef4', extinguisher: '#d13c2f', medkit: '#e8f0e8', chainsaw: '#e6a220',
    spreaders: '#f0d040', wrench: '#9aa4b0', hotstick: '#f5a623', gasmeter: '#8fd14f',
  }[defId] || '#cccccc';
}

/** Spares on the apron rack are laid out in a row, so five of them are five things. */
function toolRackOffset(state, tool) {
  const rack = state.tools.filter((t) => t.carrier === 'rack');
  const i = rack.indexOf(tool);
  return (i - (rack.length - 1) / 2) * 1.6;
}

export { TOOL_DEFS };
