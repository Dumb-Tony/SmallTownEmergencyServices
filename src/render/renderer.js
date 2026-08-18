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
  road: '#4b5058', roadEdge: '#3c414a', centreLine: '#e6d38f',
  pond: '#4a7fa1', field: '#7ea55d', lot: '#6d6f76',
  tree: '#3f6b39', treeTrunk: '#4a3a2a',
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
    this.drawBuildings(ctx, state);
    this.drawStreetFurniture(ctx, state);
    this.drawTrees(ctx);
    this.drawHazards(ctx, state, t);
    this.drawTools(ctx, state);
    this.drawVictims(ctx, state);
    this.drawApparatus(ctx, state, t);
    this.drawHose(ctx, state);
    this.drawPlayer(ctx, state, t);
    if (this.showBounds) this.drawBounds(ctx, state);

    cam.resetTransform(ctx);
    this.drawLabels(ctx);
    this.drawIncidentMarkers(ctx, state, t);
  }

  /* ── ground ─────────────────────────────────────────────────────────────── */

  drawGround(ctx) {
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
    }
  }

  drawRoads(ctx, state) {
    for (const r of roadRects()) {
      ctx.fillStyle = PALETTE.roadEdge;
      ctx.fillRect(r.x - 0.6, r.y - 0.6, r.w + 1.2, r.h + 1.2);
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

    // station apron
    ctx.fillStyle = '#5a5f68';
    const a = STATION.apron;
    ctx.fillRect(a.x, a.y, a.w, a.h);
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
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath(); ctx.arc(t.x + 0.8, t.y + 1.0, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = PALETTE.tree;
      ctx.beginPath(); ctx.arc(t.x, t.y, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath(); ctx.arc(t.x - 0.7, t.y - 0.8, 1.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ── hazards ────────────────────────────────────────────────────────────── */

  drawHazards(ctx, state, t) {
    const carryingMeter = holdingDef(state) === 'gasmeter';

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
      if (!c.burning) continue;

      const f = 0.72 + wobble(i, t, 8) * 0.16;
      const r = Math.min(cw, ch) * 0.52 * f;
      const g = ctx.createRadialGradient(c.x, c.y, r * 0.15, c.x, c.y, r * 1.5);
      g.addColorStop(0, 'rgba(255,242,180,0.95)');
      g.addColorStop(0.45, 'rgba(255,150,40,0.85)');
      g.addColorStop(1, 'rgba(190,50,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, r * 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawSmoke(ctx, fire, t) {
    let n = 0;
    for (let i = 0; i < fire.cells.length && n < 26; i++) {
      const c = fire.cells[i];
      if (!c.burning) continue;
      n++;
      this.drawSmokePuff(ctx, c.x, c.y, Math.min(1, c.heat), t, i);
    }
  }

  drawSmokePuff(ctx, x, y, strength, t, seed) {
    for (let k = 0; k < 3; k++) {
      const phase = (t * 0.55 + k * 0.33 + seed * 0.17) % 1;
      const rise = phase * 9;
      const rad = 1.6 + phase * 4.2;
      const alpha = (1 - phase) * 0.26 * strength;
      ctx.fillStyle = `rgba(58,56,60,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x + wobble(seed + k, t, 1.2) * 2.2, y - rise, rad, 0, Math.PI * 2);
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

      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(-L / 2 + 0.4, -W / 2 + 0.5, L, W);

      ctx.fillStyle = def.tint;
      ctx.fillRect(-L / 2, -W / 2, L, W);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.22;
      ctx.strokeRect(-L / 2, -W / 2, L, W);

      // cab up front, body behind, so heading is unambiguous at a glance
      ctx.fillStyle = 'rgba(20,24,32,0.75)';
      ctx.fillRect(L / 2 - L * 0.30, -W / 2 + 0.22, L * 0.24, W - 0.44);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(-L / 2 + 0.3, -W / 2 + 0.25, L * 0.5, W - 0.5);

      if (ap.damage > 0.08) {
        ctx.fillStyle = `rgba(30,24,20,${Math.min(0.55, ap.damage)})`;
        ctx.fillRect(-L / 2, -W / 2, L, W);
      }

      const blink = Math.sin(t * 12) > 0;
      if (ap.siren) {
        ctx.fillStyle = blink ? '#ff4444' : '#3355ff';
        ctx.fillRect(L / 2 - L * 0.34, -W / 2 - 0.35, L * 0.3, 0.4);
      }
      ctx.restore();

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
      const held = t.carrier === 'player';
      const nx = held ? state.player.x : (t.carrier === eng.id ? eng.x : t.x);
      const ny = held ? state.player.y : (t.carrier === eng.id ? eng.y : t.y);
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

      if (t.flowing) {
        const p = state.player;
        const dirX = Math.cos(p.facing), dirY = Math.sin(p.facing);
        const reach = CONFIG.water.streamReachM;
        const half = (CONFIG.water.streamHalfAngleDeg * Math.PI) / 180;
        const a0 = Math.atan2(dirY, dirX);
        ctx.fillStyle = 'rgba(190,225,255,0.30)';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, reach, a0 - half, a0 + half);
        ctx.closePath();
        ctx.fill();
      }
    }
    // the extinguisher gets a cone too, so "it is not reaching" is visible
    const held = state.tools.find((t) => t.carrier === 'player' && t.defId === 'extinguisher' && t.flowing);
    if (held) {
      const p = state.player;
      const a0 = p.facing;
      ctx.fillStyle = 'rgba(230,240,255,0.28)';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.arc(p.x, p.y, 4.6, a0 - 0.4, a0 + 0.4);
      ctx.closePath(); ctx.fill();
    }
  }

  drawPlayer(ctx, state, t) {
    const p = state.player;
    if (p.inVehicleId) return;
    const r = CONFIG.player.radiusM;

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(p.x + 0.25, p.y + 0.35, r * 1.15, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#f6c445';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.soot > 0.3 ? PALETTE.playerSoot : PALETTE.player;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.05, 0, Math.PI * 2); ctx.fill();

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

    const held = state.tools.find((q) => q.carrier === 'player');
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
        ctx.fillText(`${inc.headline} ${dm}m`, ex - Math.cos(a) * 26, ey - Math.sin(a) * 26);
      }
    }
    ctx.globalAlpha = 1;
  }
}

/* ── small helpers ────────────────────────────────────────────────────────── */

function holdingDef(state) {
  const t = state.tools.find((q) => q.carrier === 'player');
  return t ? t.defId : null;
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
