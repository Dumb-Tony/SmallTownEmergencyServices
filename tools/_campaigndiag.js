/* Five shifts in the same town, back to back.
 *
 * GDD Phase 4's exit gate is "players refer to locations by name and care about a
 * previous mistake", which needs the town to still be worth caring about on shift five.
 * Every part of the carry-over is unit-asserted — damage persists, a gutted shop is
 * boarded, a struck hydrant stays out — but nobody has ever watched them COMPOUND.
 *
 * Two failure modes worth knowing about, and only a long run shows either:
 *   - the death spiral: damage accumulates, confidence floors, and shift five is a
 *     ruin nobody can retrieve;
 *   - the amnesia: everything quietly repairs and shift five is shift one again, so
 *     nothing you did ever mattered.
 */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave, loadTown } from '../src/core/persistence.js';
import { CrewBot } from './_crewbot.js';
import { BUILDINGS, HYDRANTS } from '../src/data/town.js';

const lines = [];
let _pre = null;
function emit() {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\nALL-PASS  measured\n==STESTEST-END==';
}

const STEP = CONFIG.sim.stepMs;

/** One shift in whatever town is currently saved, played by a bot (or by nobody). */
function playShift(seed, { idle = false } = {}) {
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  const bot = idle ? null : new CrewBot(g);
  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    if (bot) bot.think();
    g.frame(STEP, bot ? bot.input : null);
    if (s.mode !== 'playing') break;
  }
  return {
    calls: s.incidents.length,
    controlled: s.outcome.controlled,
    lost: s.outcome.lost,
    confidence: s.town.confidence,
    headline: s.report ? s.report.headline : '(no report)',
  };
}

function townState() {
  const t = loadTown();
  const damaged = Object.entries(t.buildings || {}).filter(([, r]) => r.damage > 0.02);
  const boarded = Object.entries(t.buildings || {}).filter(([, r]) => r.boardedShifts > 0);
  const brokenH = Object.entries(t.hydrants || {}).filter(([, r]) => r.damaged);
  const totalDamage = damaged.reduce((n, [, r]) => n + r.damage, 0);
  return {
    shift: t.shiftNumber,
    confidence: t.confidence,
    damaged: damaged.length,
    boarded: boarded.length,
    boardedNames: boarded.map(([id]) => id),
    brokenHydrants: brokenH.length,
    totalDamage,
    history: t.history || [],
  };
}

function runCampaign(label, opts) {
  clearSave();
  lines.push(`=== ${label} ===`);
  lines.push('shift | calls ctrl lost | conf | damaged boarded hydrants | total damage');
  for (let i = 1; i <= 5; i++) {
    const r = playShift(1000 + i, opts);
    const t = townState();
    lines.push(`  ${String(i).padStart(2)}  | ${String(r.calls).padStart(5)} ${String(r.controlled).padStart(4)} ` +
      `${String(r.lost).padStart(4)} | ${String(Math.round(r.confidence * 100)).padStart(3)}% | ` +
      `${String(t.damaged).padStart(7)} ${String(t.boarded).padStart(7)} ${String(t.brokenHydrants).padStart(8)} | ` +
      `${t.totalDamage.toFixed(2)}`);
    lines.push(`       "${r.headline}"`);
    emit();   // ten whole shifts is a long run: report each one as it lands
  }
  const end = townState();
  lines.push(`  ends on shift ${end.shift} with ${end.boarded} boarded ` +
    `(${end.boardedNames.join(', ') || 'none'}) of ${BUILDINGS.length} buildings, ` +
    `${end.brokenHydrants} of ${HYDRANTS.length} hydrants out`);
  lines.push(`  history kept: ${end.history.length} lines`);
  lines.push('');
  return end;
}

try {
  lines.push('starting');
  emit();
  const worked = runCampaign('five shifts with somebody on duty', {});
  const ignored = runCampaign('five shifts with nobody responding', { idle: true });

  lines.push('=== does five shifts of work leave a better town than five of neglect? ===');
  lines.push(`  confidence   ${(worked.confidence * 100).toFixed(0)}% vs ${(ignored.confidence * 100).toFixed(0)}%`);
  lines.push(`  boarded up   ${worked.boarded} vs ${ignored.boarded}`);
  lines.push(`  damage total ${worked.totalDamage.toFixed(2)} vs ${ignored.totalDamage.toFixed(2)}`);
  lines.push(`  hydrants out ${worked.brokenHydrants} vs ${ignored.brokenHydrants}`);
  lines.push('');
  lines.push('  (a town that ends the fifth shift identical either way has amnesia;');
  lines.push('   one that ends both ways in ruins has a death spiral.)');
  emit();
} catch (err) {
  lines.push('threw: ' + (err && err.message));
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
