/* Renderer. GDD implementation rule 7: "Make causes visible before adding more
 * content." Every drawing decision here is about legibility of cause:
 *
 *   - a fire is drawn CELL BY CELL, so "it is spreading left" is a thing you see
 *     rather than a number you are told;
 *   - the hose is drawn as an actual line from the actual engine, so running out of
 *     hose looks like running out of hose;
 *   - the live zone is a visible ring, because an invisible one is a bug report;
 *   - gas is drawn faintly, and properly only when you are carrying the meter.
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
  tree: '#4a7d41', treeDark: '#335b30', treeTrunk: '#4a3a2a',
  hydrant: '#d94f3d', hydrantDead: '#6b6b6b',
  pole: '#6b563f', wire: '#3a3a42',
  player: '#f4e3b2', playerSoot: '#7a6a55',
  victim: '#e9d7c3',
  smoke: 'rgba(60,60,66,0.30)',
  ui: '#f2ead9',
};

const ROOF = {
  station: '#b8403a', shop: '#d2a04a', civic: '#7ba7c9', house: '#c9855f',
  housing: '#a3785f', barn: '#9d4436', industry: '#8b9099', clinic: '#dfe8ee',
};

/** Stable pseudo-noise for flicker: the renderer must not call Math.random (the seeded
 *  stream belongs to the simulation, and a repeat playtest should look the same). */
function wobble(i, t, speed = 6) {
  return Math.sin(i * 12.9898 + t * speed) * 0.5 + Math.sin(i * 78.233 + t * speed * 1.7) * 0.5;
}

export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.showBounds = false;
    this.showGrid = false;
    this.labels = [];
    this.markers = [];
  }

  render(state, nowMs = 0) {
    const ctx = this.ctx;
    const cam = this.camera;
    const t = nowMs / 1000;
    this.labels.length = 0;
    this.markers.length = 0;

    cam.resetTransform(ctx);
    ctx.fillStyle = PALETTE.grass;
    ctx.fillRect(0, 0, cam.cssW, cam.cssH);

    cam.applyTo(ctx);

    this.drawGround(ctx);
    this.drawRoads(ctx, state);
    // Firelight lands on the GROUND, under everything that stands on it — that is the
    // difference between a fire that is drawn on the map and a fire that is lighting it.
    this.drawFireLight(ctx, state, t);
    this.drawBuildings(ctx, state);
    this.drawStreetFurniture(ctx, state);
    this.drawTrees(ctx);
    this.drawHazards(ctx, state, t);
    this.drawTools(ctx, state);
    this.drawVictims(ctx, state);
    this.drawApparatus(ctx, state, t);
    this.drawHose(ctx, state);
    this.drawResponders(ctx, state, t);
    this.drawEmbers(ctx, state, t);
    if (this.showBounds) this.drawBounds(ctx, state);

    cam.resetTransform(ctx);
    this.drawVignette(ctx);
    this.drawLabels(ctx);
    this.drawIncidentMarkers(ctx, state, t);
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

  /** Embers riding the column. Deterministic — no Math.random in the renderer. */
  drawEmbers(ctx, state, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const h of state.hazards) {
      if (h.kind !== 'fire') continue;
      let seen = 0;
      for (let i = 0; i < h.cells.length; i++) {
        const c = h.cells[i];
        if (!c.burning) continue;
        if (seen++ % 2) continue;
        for (let k = 0; k < 2; k++) {
          const phase = (t * 0.42 + i * 0.29 + k * 0.5) % 1;
          const rise = phase * 13;
          const a = (1 - phase) * 0.5;
          ctx.fillStyle = `rgba(255,${170 + Math.round(phase * 60)},90,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(c.x + wobble(i + k, t, 0.9) * 3.2, c.y - rise, 0.26 * (1 - phase * 0.5), 0, Math.PI * 2);
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

  /* ── ground ─────────────────────────────────────────────────────────────── */

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
  }

  drawBuildings(ctx, state) {
    for (const b of BUILDINGS) {
      const rec = state.town.buildings[b.id] || { damage: 0, boardedShifts: 0 };

      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(b.x + 1.2, b.y + 1.6, b.w, b.h);

      ctx.fillStyle = ROOF[b.kind] || '#9aa0a6';
      ctx.fillRect(b.x, b.y, b.w, b.h);

      // roof ribs, so a big footprint does not read as a flat slab
      ctx.strokeStyle = 'rgba(0,0,0,0.13)';
      ctx.lineWidth = 0.3;
      for (let x = b.x + 3; x < b.x + b.w; x += 3) {
        ctx.beginPath(); ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); ctx.stroke();
      }
      // a ridge line down the long axis, and a lighter sunward face
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      if (b.w >= b.h) ctx.fillRect(b.x, b.y, b.w, b.h * 0.42);
      else ctx.fillRect(b.x, b.y, b.w * 0.42, b.h);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 0.35;
      ctx.beginPath();
      if (b.w >= b.h) { ctx.moveTo(b.x, b.y + b.h / 2); ctx.lineTo(b.x + b.w, b.y + b.h / 2); }
      else { ctx.moveTo(b.x + b.w / 2, b.y); ctx.lineTo(b.x + b.w / 2, b.y + b.h); }
      ctx.stroke();

      this.drawWindows(ctx, state, b);

      if (rec.damage > 0.02) {
        ctx.fillStyle = `rgba(24,20,18,${Math.min(0.82, rec.damage)})`;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      if (rec.boardedShifts > 0) {
        ctx.strokeStyle = '#8a6a45';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(b.x + 1, b.y + 1); ctx.lineTo(b.x + b.w - 1, b.y + b.h - 1);
        ctx.moveTo(b.x + b.w - 1, b.y + 1); ctx.lineTo(b.x + 1, b.y + b.h - 1);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.35;
      ctx.strokeRect(b.x, b.y, b.w, b.h);

      // the door — the only way in or out on foot
      ctx.fillStyle = '#2f2a26';
      ctx.beginPath(); ctx.arc(b.door.x, b.door.y, 1.0, 0, Math.PI * 2); ctx.fill();

      this.labels.push({
        x: b.x + b.w / 2, y: b.y + b.h / 2, text: b.name,
        size: 11, colour: rec.damage > 0.4 ? '#ffb3a7' : '#fdf6e6', weight: 700,
      });
    }

    // clinic apron marker
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.arc(CLINIC.x, CLINIC.y, CLINIC.radiusM, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Windows around the perimeter — and they GLOW when the cell behind them is alight.
   *
   * This is the one visual that tells you what is happening inside a building you
   * cannot see into, and it is read straight off the fire's own cells rather than from
   * a separate "is it bad in there" number. A shop with three lit windows on the north
   * side is a shop whose fire is on the north side.
   */
  drawWindows(ctx, state, b) {
    const fire = state.hazards.find((h) => h.kind === 'fire' && h.buildingId === b.id);
    const inset = 1.2, spacing = 4.4;
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

    const put = (x, y, w, h) => {
      const lit = litAt(x + w / 2, y + h / 2);
      ctx.fillStyle = lit > 0.02
        ? `rgba(255,${Math.round(150 + lit * 80)},70,${(0.35 + lit * 0.6).toFixed(3)})`
        : 'rgba(30,36,44,0.55)';
      ctx.fillRect(x, y, w, h);
    };

    for (let x = b.x + spacing * 0.5; x < b.x + b.w - 1.4; x += spacing) {
      put(x, b.y + inset - 0.5, 2.0, 0.9);
      put(x, b.y + b.h - inset - 0.4, 2.0, 0.9);
    }
    for (let y = b.y + spacing * 0.5; y < b.y + b.h - 1.4; y += spacing) {
      put(b.x + inset - 0.5, y, 0.9, 2.0);
      put(b.x + b.w - inset - 0.4, y, 0.9, 2.0);
    }
  }

  drawStreetFurniture(ctx, state) {
    for (const h of HYDRANTS) {
      const dead = (state.town.hydrants[h.id] || {}).damaged;
      const charged = state.apparatus.some((a) => a.hydrantId === h.id);
      ctx.fillStyle = dead ? PALETTE.hydrantDead : PALETTE.hydrant;
      ctx.fillRect(h.x - 0.5, h.y - 0.7, 1.0, 1.4);
      ctx.fillRect(h.x - 0.9, h.y - 0.25, 1.8, 0.5);
      if (charged) {
        ctx.strokeStyle = '#7fd1ff'; ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.arc(h.x, h.y, 1.8, 0, Math.PI * 2); ctx.stroke();
      }
    }
    for (const p of POLES) {
      ctx.fillStyle = PALETTE.pole;
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.2;
      ctx.beginPath(); ctx.moveTo(p.x - 1.4, p.y - 1.4); ctx.lineTo(p.x + 1.4, p.y + 1.4); ctx.stroke();
    }
  }

  drawTrees(ctx) {
    for (let i = 0; i < TREES.length; i++) {
      const t = TREES[i];
      // size and lean vary per tree, from the index — a row of identical circles reads
      // as wallpaper, and this costs nothing and is stable across frames
      const r = 2.3 + ((i * 37) % 11) / 11 * 1.5;
      const lean = ((i * 53) % 7) / 7 - 0.5;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(t.x + 0.9, t.y + 1.1, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = PALETTE.treeDark;
      ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = PALETTE.tree;
      ctx.beginPath(); ctx.arc(t.x - lean * 0.6, t.y - 0.35, r * 0.82, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ctx.arc(t.x - 0.7 - lean, t.y - 0.9, r * 0.42, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ── hazards ────────────────────────────────────────────────────────────── */

  drawHazards(ctx, state, t) {
    const carryingMeter = holdingDef(state, 'gasmeter');

    for (const h of state.hazards) {
      if (h.kind === 'gas') this.drawGas(ctx, h, t, carryingMeter);
    }
    for (const h of state.hazards) {
      if (h.kind === 'tree') this.drawTreeHazard(ctx, h);
      else if (h.kind === 'wreck') this.drawWreck(ctx, h, t);
    }
    for (const h of state.hazards) {
      if (h.kind === 'fire') this.drawFire(ctx, h, t);
    }
    for (const h of state.hazards) {
      if (h.kind === 'power') this.drawPower(ctx, h, t);
    }
    for (const h of state.hazards) {
      if (h.kind === 'fire') this.drawSmoke(ctx, h, t);
      else if (h.kind === 'wreck' && h.burning) this.drawSmokePuff(ctx, h.x, h.y, 1, t, 91);
    }
  }

  drawFire(ctx, fire, t) {
    const b = BUILDING_BY_ID[fire.buildingId];
    const cw = b.w / fire.cols, ch = b.h / fire.rows;
    for (let i = 0; i < fire.cells.length; i++) {
      const c = fire.cells[i];
      if (c.burnt) {
        ctx.fillStyle = 'rgba(20,16,14,0.72)';
        ctx.fillRect(c.x - cw / 2, c.y - ch / 2, cw, ch);
      }
      if (c.wet > 0.05 && !c.burning) {
        ctx.fillStyle = `rgba(90,160,210,${Math.min(0.30, c.wet * 0.28)})`;
        ctx.fillRect(c.x - cw / 2, c.y - ch / 2, cw, ch);
      }
      if (c.heat > 0.15 && !c.burning) {
        ctx.fillStyle = `rgba(220,110,50,${Math.min(0.35, (c.heat - 0.15) * 0.5)})`;
        ctx.fillRect(c.x - cw / 2, c.y - ch / 2, cw, ch);
      }
    }

    // Flame in a second, additive pass so that adjacent burning cells merge into one
    // body of fire instead of reading as a tidy grid of orange lamps. The grid is the
    // simulation's business, not the player's.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < fire.cells.length; i++) {
      const c = fire.cells[i];
      if (!c.burning) continue;
      const f = 0.80 + wobble(i, t, 8) * 0.18;
      const r = Math.max(cw, ch) * 0.92 * f;
      const g = ctx.createRadialGradient(c.x, c.y, r * 0.10, c.x, c.y, r);
      g.addColorStop(0, 'rgba(255,236,170,0.42)');
      g.addColorStop(0.40, 'rgba(255,140,32,0.34)');
      g.addColorStop(1, 'rgba(180,40,12,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* Smoke reads the fire; it must not hide it. A puff per burning cell buried the
   * flame under grey circles the first time this was drawn, so the column is thinned:
   * every third burning cell, capped at eight, and lighter. */
  drawSmoke(ctx, fire, t) {
    let n = 0, seen = 0;
    for (let i = 0; i < fire.cells.length && n < 8; i++) {
      const c = fire.cells[i];
      if (!c.burning) continue;
      if (seen++ % 3) continue;
      n++;
      this.drawSmokePuff(ctx, c.x, c.y, Math.min(1, c.heat), t, i);
    }
  }

  drawSmokePuff(ctx, x, y, strength, t, seed) {
    for (let k = 0; k < 3; k++) {
      const phase = (t * 0.5 + k * 0.33 + seed * 0.17) % 1;
      const rise = phase * 11;
      const rad = 1.1 + phase * 2.6;
      const alpha = (1 - phase) * 0.13 * strength;
      ctx.fillStyle = `rgba(66,64,70,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x + wobble(seed + k, t, 1.2) * 2.0, y - rise, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawGas(ctx, gas, t, visible) {
    const R = CONFIG.gas.cloudRadiusM;
    const alpha = visible ? Math.min(0.42, 0.10 + gas.ppm * 0.34) : Math.min(0.10, gas.ppm * 0.07);
    const g = ctx.createRadialGradient(gas.x, gas.y, 1, gas.x, gas.y, R);
    g.addColorStop(0, `rgba(190,220,140,${alpha})`);
    g.addColorStop(1, 'rgba(190,220,140,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(gas.x, gas.y, R, 0, Math.PI * 2); ctx.fill();

    // the meter fitting itself, so the wrench has something to aim at
    ctx.fillStyle = gas.shutOff ? '#6d8f5a' : '#c9c25a';
    ctx.fillRect(gas.x - 0.6, gas.y - 0.6, 1.2, 1.2);
  }

  drawPower(ctx, pwr, t) {
    if (!pwr.live) {
      ctx.strokeStyle = 'rgba(120,120,130,0.6)'; ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.arc(pwr.x, pwr.y, 1.4, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    ctx.fillStyle = `rgba(120,190,255,${0.10 + pulse * 0.07})`;
    ctx.beginPath(); ctx.arc(pwr.x, pwr.y, pwr.radiusM, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(150,215,255,${0.55 + pulse * 0.35})`;
    ctx.lineWidth = 0.35;
    ctx.setLineDash([1.4, 1.2]);
    ctx.beginPath(); ctx.arc(pwr.x, pwr.y, pwr.radiusM, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    const pole = POLES.find((p) => p.id === pwr.poleId);
    if (pole) {
      ctx.strokeStyle = '#2f2f36'; ctx.lineWidth = 0.28;
      ctx.beginPath(); ctx.moveTo(pole.x, pole.y); ctx.lineTo(pwr.x, pwr.y); ctx.stroke();
      ctx.strokeStyle = `rgba(180,230,255,${pulse})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(pwr.x - 0.9, pwr.y);
      ctx.lineTo(pwr.x, pwr.y - 0.7 - pulse);
      ctx.lineTo(pwr.x + 0.9, pwr.y);
      ctx.stroke();
    }
  }

  drawTreeHazard(ctx, h) {
    if (h.cleared) {
      ctx.fillStyle = 'rgba(74,58,42,0.5)';
      ctx.beginPath(); ctx.arc(h.x, h.y, 1.6, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(0.7);
    ctx.fillStyle = PALETTE.treeTrunk;
    const len = h.radiusM * 2 * (1 - h.cut * 0.45);
    ctx.fillRect(-len / 2, -1.1, len, 2.2);
    ctx.fillStyle = '#35592f';
    ctx.beginPath(); ctx.arc(-len / 2, 0, 3.0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(len / 2, 0, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (h.cut > 0) {
      ctx.fillStyle = '#e8d9a8';
      ctx.fillRect(h.x - 2, h.y - 3.4, 4 * h.cut, 0.7);
    }
  }

  drawWreck(ctx, w, t) {
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(w.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(-2.1, -1.1, 4.4, 2.4);
    ctx.fillStyle = w.burning ? '#4a3a34' : w.kindTag === 'machine' ? '#7d8a56' : '#7a8ba0';
    ctx.fillRect(-2.2, -1.2, 4.4, 2.4);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-0.6, -1.0, 1.6, 2.0);
    ctx.restore();

    if (w.fuelLeak > 0.02 && !w.burning) {
      ctx.fillStyle = `rgba(40,35,30,${Math.min(0.4, w.fuelLeak * 0.35)})`;
      ctx.beginPath(); ctx.arc(w.x + 1.4, w.y + 1.2, 1.2 + w.fuelLeak, 0, Math.PI * 2); ctx.fill();
    }
    if (w.burning) {
      const f = 0.8 + wobble(7, t, 9) * 0.2;
      const g = ctx.createRadialGradient(w.x, w.y, 0.4, w.x, w.y, 4 * f);
      g.addColorStop(0, 'rgba(255,235,160,0.9)');
      g.addColorStop(0.5, 'rgba(255,140,40,0.7)');
      g.addColorStop(1, 'rgba(180,40,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(w.x, w.y, 4 * f, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ── actors ─────────────────────────────────────────────────────────────── */

  drawTools(ctx, state) {
    for (const t of state.tools) {
      if (t.carrier !== null && t.carrier !== 'rack') continue;
      const x = t.carrier === 'rack' ? state.rack.x + toolRackOffset(state, t) : t.x;
      const y = t.carrier === 'rack' ? state.rack.y : t.y;
      ctx.fillStyle = '#2b2b31';
      ctx.fillRect(x - 0.62, y - 0.42, 1.24, 0.84);
      ctx.fillStyle = toolColour(t.defId);
      ctx.fillRect(x - 0.5, y - 0.3, 1.0, 0.6);
      this.labels.push({ x, y: y - 1.2, text: t.short, size: 9, colour: '#ffe9b0', weight: 700 });
    }
  }

  drawVictims(ctx, state) {
    for (const v of state.victims) {
      if (v.delivered || v.inApparatusId) continue;
      const st = victimState(v);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(v.x + 0.3, v.y + 0.4, 0.7, 0.45, 0, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = v.lost ? '#6d6a6a' : PALETTE.victim;
      ctx.beginPath(); ctx.arc(v.x, v.y, 0.6, 0, Math.PI * 2); ctx.fill();

      const ring = st === 'lost' ? '#5c5c5c' : st === 'unconscious' ? '#8e44ad'
        : st === 'critical' ? '#e74c3c' : st === 'injured' ? '#e8a33d' : '#5fbf6a';
      ctx.strokeStyle = ring; ctx.lineWidth = 0.28;
      ctx.beginPath(); ctx.arc(v.x, v.y, 1.05, 0, Math.PI * 2); ctx.stroke();

      if (v.trappedBy) {
        ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 0.25;
        ctx.beginPath();
        ctx.moveTo(v.x - 1.4, v.y - 1.4); ctx.lineTo(v.x + 1.4, v.y + 1.4);
        ctx.moveTo(v.x + 1.4, v.y - 1.4); ctx.lineTo(v.x - 1.4, v.y + 1.4);
        ctx.stroke();
      }
      if (!v.lost) {
        // condition bar: the only number a player needs about a person
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(v.x - 1.1, v.y - 2.0, 2.2, 0.42);
        ctx.fillStyle = ring;
        ctx.fillRect(v.x - 1.06, v.y - 1.96, 2.12 * v.condition, 0.34);
      }
    }
  }

  drawApparatus(ctx, state, t) {
    for (const ap of state.apparatus) {
      const def = state.apparatusDefs[ap.defId];
      const L = def.lengthM, W = def.widthM;
      ctx.save();
      ctx.translate(ap.x, ap.y);
      ctx.rotate(ap.angle);

      // wheels first, so the body sits on them
      ctx.fillStyle = '#20232a';
      for (const wx of [L * 0.30, -L * 0.26]) {
        ctx.fillRect(wx - 0.5, -W / 2 - 0.16, 1.0, 0.42);
        ctx.fillRect(wx - 0.5, W / 2 - 0.26, 1.0, 0.42);
      }

      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(-L / 2 + 0.4, -W / 2 + 0.5, L, W);

      ctx.fillStyle = def.tint;
      ctx.fillRect(-L / 2, -W / 2, L, W);
      // a darker body behind the cab: the silhouette of a truck rather than a brick
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(-L / 2, -W / 2, L * 0.56, W);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.22;
      ctx.strokeRect(-L / 2, -W / 2, L, W);

      // cab up front, windscreen ahead of it, so heading is unambiguous at a glance
      ctx.fillStyle = 'rgba(20,24,32,0.8)';
      ctx.fillRect(L / 2 - L * 0.30, -W / 2 + 0.22, L * 0.24, W - 0.44);
      ctx.fillStyle = 'rgba(150,200,235,0.55)';
      ctx.fillRect(L / 2 - L * 0.10, -W / 2 + 0.30, L * 0.07, W - 0.6);

      // the reflective chevron band every appliance in the world has
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(-L / 2 + 0.2, -0.22, L - 0.4, 0.44);

      // kit that identifies the truck at a glance, without reading the label
      if (def.hose) {                                  // engine: a ladder down the side
        ctx.strokeStyle = 'rgba(230,235,240,0.75)'; ctx.lineWidth = 0.12;
        for (let i = 0; i < 5; i++) {
          const lx = -L / 2 + 0.9 + i * 0.62;
          ctx.beginPath(); ctx.moveTo(lx, -W / 2 + 0.35); ctx.lineTo(lx, W / 2 - 0.35); ctx.stroke();
        }
      } else if (def.patientBay) {                     // ambulance: a red cross
        ctx.fillStyle = '#d8453a';
        ctx.fillRect(-L * 0.24, -0.16, 1.1, 0.32);
        ctx.fillRect(-L * 0.24 + 0.39, -0.55, 0.32, 1.1);
      } else {                                         // rescue: a toolbox roll-up
        ctx.strokeStyle = 'rgba(30,30,34,0.6)'; ctx.lineWidth = 0.14;
        ctx.strokeRect(-L / 2 + 0.5, -W / 2 + 0.4, L * 0.4, W - 0.8);
      }

      if (ap.damage > 0.08) {
        ctx.fillStyle = `rgba(30,24,20,${Math.min(0.55, ap.damage)})`;
        ctx.fillRect(-L / 2, -W / 2, L, W);
      }

      const blink = Math.sin(t * 12) > 0;
      // The lightbar is on whenever the siren is: two lamps, alternating, and they
      // throw a little colour onto the road beside the truck.
      if (ap.siren) {
        ctx.fillStyle = blink ? '#ff4444' : '#2a3a6a';
        ctx.fillRect(L / 2 - L * 0.34, -W / 2 - 0.38, L * 0.15, 0.44);
        ctx.fillStyle = blink ? '#2a3a6a' : '#5588ff';
        ctx.fillRect(L / 2 - L * 0.19, -W / 2 - 0.38, L * 0.15, 0.44);
      }
      ctx.restore();

      if (ap.siren) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(ap.x, ap.y, 0, ap.x, ap.y, 9);
        g.addColorStop(0, blink ? 'rgba(255,60,60,0.16)' : 'rgba(70,120,255,0.16)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(ap.x, ap.y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      if (ap.siren) {
        const r = CONFIG.drive.sirenClearRadiusM * (0.6 + 0.4 * Math.abs(Math.sin(t * 3)));
        ctx.strokeStyle = `rgba(255,120,120,${blink ? 0.16 : 0.10})`;
        ctx.lineWidth = 0.4;
        ctx.beginPath(); ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2); ctx.stroke();
      }
      this.labels.push({ x: ap.x, y: ap.y - def.widthM - 1.0, text: ap.short, size: 10, colour: '#ffffff', weight: 700 });
    }
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
        (CONFIG.water.streamHalfAngleDeg * Math.PI) / 180, 'rgba(190,225,255,0.30)', t);
    }
    // the extinguisher gets a cone too, so "it is not reaching" is visible
    for (const t of state.tools) {
      if (t.defId !== 'extinguisher' || !t.flowing) continue;
      const holder = state.responders.find((q) => q.id === t.carrier);
      if (holder) this.drawStream(ctx, holder, 4.6, 0.4, 'rgba(230,240,255,0.28)', t);
    }
  }

  /** One cone, wherever the nozzle actually is. */
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

  drawResponders(ctx, state, t) {
    for (const p of state.responders) this.drawResponder(ctx, state, p, t);
  }

  drawResponder(ctx, state, p, t) {
    if (p.inVehicleId) return;
    const r = CONFIG.player.radiusM;

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(p.x + 0.25, p.y + 0.35, r * 1.15, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();

    /* A dark ring under the coat. A yellow responder standing in a yellow fire is
       invisible, and the one thing that must always be findable on this screen is the
       person you are controlling. */
    ctx.fillStyle = 'rgba(18,16,22,0.9)';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.0, 0, Math.PI * 2); ctx.fill();

    // Turnout coat in the crew colour, so two responders are never confused for each
    // other, plus a reflective band that reads at a glance in a dark scene.
    ctx.fillStyle = p.tint || '#f6c445';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.16;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.25, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = p.soot > 0.3 ? PALETTE.playerSoot : PALETTE.player;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.95, 0, Math.PI * 2); ctx.fill();

    // facing pip: which way "use" will point
    ctx.strokeStyle = '#20242c'; ctx.lineWidth = 0.22;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(p.facing) * (r * 2.4), p.y + Math.sin(p.facing) * (r * 2.4));
    ctx.stroke();

    if (p.stunMs > 0) {
      ctx.strokeStyle = `rgba(255,220,90,${0.4 + 0.4 * Math.abs(Math.sin(t * 14))})`;
      ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2); ctx.stroke();
    }

    const held = state.tools.find((q) => q.carrier === p.id);
    if (held) {
      const hx = p.x + Math.cos(p.facing) * 0.9, hy = p.y + Math.sin(p.facing) * 0.9;
      ctx.fillStyle = toolColour(held.defId);
      ctx.fillRect(hx - 0.35, hy - 0.25, 0.7, 0.5);
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
      if (h.radiusM) { ctx.beginPath(); ctx.arc(h.x, h.y, h.radiusM, 0, Math.PI * 2); ctx.stroke(); }
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
        ctx.beginPath(); ctx.arc(s.x, s.y, 22 + pulse * 6, 0, Math.PI * 2); ctx.stroke();
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

function toolRackOffset(state, tool) {
  const rack = state.tools.filter((t) => t.carrier === 'rack');
  const i = rack.indexOf(tool);
  return (i - (rack.length - 1) / 2) * 1.6;
}

export { TOOL_DEFS };
