/* Diagnostic: the two curves that matter for a structure fire.
 *   1. free burn — how long the town has before a shop is gone
 *   2. one line, arriving late — can a single crew still control it, and at what cost
 * Not a test; a measuring stick for tuning CONFIG.fire / CONFIG.water.
 */

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { createFire, stepHazards, applyWater, fireDamageFraction, fireMaxHeat } from '../src/sim/hazards.js';

const STEP = CONFIG.sim.stepMs;
const out = [];
out.push(`spread=${CONFIG.fire.spreadPerSec} diag=${CONFIG.fire.diagonalMul} burnGain=${CONFIG.fire.burnHeatGain} ` +
         `ambient=${CONFIG.fire.coolPerSec} fuel=${CONFIG.fire.fuelBurnPerSec} coolPerL=${CONFIG.water.coolPerLitre}`);

function burning(f) { return f.cells.filter((c) => c.burning).length; }
function involved(f) { return f.cells.filter((c) => c.burning || c.burnt).length / f.cells.length; }

/* 1. free burn */
{
  const st = { hazards: [], simTimeMs: 0 };
  const rng = new Rng(2);
  const f = createFire('pizza', { seedCells: 2, heat: 0.95, from: 'door' });
  st.hazards.push(f);
  const marks = [0.25, 0.5, 0.75, 1.0];
  let mi = 0;
  const log = [];
  for (let t = 0; t < 600000; t += STEP) {
    stepHazards(st, STEP, rng);
    if (t % 30000 < STEP) log.push(`${Math.round(t / 1000)}s:${burning(f)}b/${Math.round(involved(f) * 100)}%`);
    while (mi < marks.length && involved(f) >= marks[mi]) {
      out.push(`free burn: ${Math.round(marks[mi] * 100)}% involved at ${Math.round(t / 1000)}s`);
      mi++;
    }
    if (f.resolved) { out.push(`free burn: burnt out at ${Math.round(t / 1000)}s, damage ${Math.round(fireDamageFraction(f) * 100)}%`); break; }
  }
  out.push(`  trace ${log.slice(0, 12).join(' ')}`);
}

/* 2. one line, arriving at 45 s and 90 s */
for (const arriveMs of [45000, 90000]) {
  const st = { hazards: [], simTimeMs: 0 };
  const rng = new Rng(2);
  const f = createFire('pizza', { seedCells: 2, heat: 0.95, from: 'door' });
  st.hazards.push(f);
  for (let t = 0; t < arriveMs; t += STEP) stepHazards(st, STEP, rng);
  const atArrival = { b: burning(f), inv: Math.round(involved(f) * 100) };

  let won = null;
  for (let t = arriveMs; t < arriveMs + 300000; t += STEP) {
    const hot = f.cells.filter((c) => c.burning).sort((a, b) => b.heat - a.heat)[0];
    if (hot) {
      applyWater(st, hot.x - 3, hot.y, 1, 0,
        CONFIG.water.nozzleFlowLps * (STEP / 1000), CONFIG.water.streamReachM);
    }
    stepHazards(st, STEP, rng);
    if (f.resolved) { won = t - arriveMs; break; }
  }
  out.push(`arrive ${arriveMs / 1000}s (${atArrival.b} cells burning, ${atArrival.inv}% involved): ` +
    (won == null ? 'NEVER controlled' : `out after ${Math.round(won / 1000)}s of work`) +
    `, final damage ${Math.round(fireDamageFraction(f) * 100)}%`);
}

const pre = document.createElement('pre');
pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;color:#cfe;font:11px monospace;padding:12px';
pre.textContent = '==STESTEST-BEGIN==\n' + out.join('\n') + '\nALL-PASS diagnostic\n==STESTEST-END==';
document.body.appendChild(pre);
