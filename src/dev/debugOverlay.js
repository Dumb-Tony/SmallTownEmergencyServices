/* F3 overlay. GDD implementation rule 1: "Keep the simulation deterministic enough to
 * reproduce playtest failures" — so the first thing on it is the seed and the draw
 * count, which together identify a run exactly.
 *
 * Debug tooling never bleeds into the player-facing HUD.
 */

import { CONFIG } from '../config.js';
import { GameClock } from '../core/clock.js';

export class DebugOverlay {
  constructor(root, game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.enabled = CONFIG.debug.enabled;
    this.fps = 60;
    this.el = document.createElement('pre');
    this.el.id = 'debug';
    root.appendChild(this.el);
    this.el.style.display = this.enabled ? 'block' : 'none';

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') { e.preventDefault(); this.toggle(); }
      if (!this.enabled) return;
      if (e.code === 'F4') { e.preventDefault(); this.renderer.showBounds = !this.renderer.showBounds; }
    });
  }

  toggle() {
    this.enabled = !this.enabled;
    this.el.style.display = this.enabled ? 'block' : 'none';
    return this.enabled;
  }

  update(frameMs) {
    if (!this.enabled) return;
    this.fps += ((1000 / Math.max(1, frameMs)) - this.fps) * 0.1;
    const g = this.game;
    const s = g.state;
    const fires = s.hazards.filter((h) => h.kind === 'fire');
    const burning = fires.reduce((n, f) => n + f.burningCount, 0);

    this.el.textContent = [
      `mode ${s.mode}   fps ${this.fps.toFixed(0)}   steps ${g.clock.stepCount}   clamped ${g.clock.clampedFrames}`,
      `seed ${s.seed} (${g.rng.label})   draws ${g.rng.draws}`,
      `sim ${GameClock.formatMs(s.simTimeMs)} / ${GameClock.formatMs(s.shiftMs)}   next call ${GameClock.formatMs(Math.max(0, s.dispatch.nextCallAtMs - s.simTimeMs))}`,
      `incidents ${s.incidents.length} (open ${s.incidents.filter((i) => i.status === 'queued' || i.status === 'active').length})   hazards ${s.hazards.length}   victims ${s.victims.length}`,
      `fires ${fires.length} burning-cells ${burning}   gas ${s.hazards.filter((h) => h.kind === 'gas').length}   live-lines ${s.hazards.filter((h) => h.kind === 'power' && h.live).length}`,
      `player ${s.player.x.toFixed(1)},${s.player.y.toFixed(1)} ${s.player.inVehicleId || 'on foot'}${s.player.insideBuildingId ? ` inside ${s.player.insideBuildingId}` : ''}`,
      `telemetry drive ${(s.telemetry.distanceDrivenM / 1000).toFixed(2)}km  water ${s.telemetry.litresUsed.toFixed(0)}L  wrong-tool ${s.telemetry.wrongToolAttempts}  split ${s.telemetry.firstSplitMs == null ? '-' : GameClock.formatMs(s.telemetry.firstSplitMs)}`,
      '',
      ...g.bus.recent(CONFIG.debug.recentEvents).map((e) => `  ${GameClock.formatMs(e.simTimeMs)} ${e.type}`),
      '',
      'F3 close  F4 bounds',
    ].join('\n');
  }
}
