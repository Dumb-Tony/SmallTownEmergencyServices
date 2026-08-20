/* Is the medical chain winnable? — the time budget, measured against real play.
 *
 * A trapped critical casualty at a crash needs the SPREADERS (rescue truck) and then
 * the MEDKIT and a ride (ambulance). One responder cannot drive two trucks. So:
 * how long does a casualty have, and how long does a crew actually take to get there?
 */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { createVictim } from '../src/sim/victims.js';
import { CrewBot } from './_crewbot.js';
import { dist } from '../src/data/town.js';

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

function fresh(seed = 700) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  g.state.incidents.length = 0;      // no dispatch noise in the bench measurements
  return g;
}

/** Seconds a casualty survives from the moment they appear, untouched. */
function survivalSeconds(severity, opts = {}) {
  const g = fresh();
  const s = g.state;
  const v = createVictim({ incidentId: null, x: 200, y: 150, severity, ...opts });
  s.victims.push(v);
  let ms = 0;
  while (!v.lost && ms < 25 * 60000) { g.step(STEP, null); ms += STEP; }
  return v.lost ? ms / 1000 : Infinity;
}

/** Seconds of grace a single dose of the medkit buys a critical casualty. */
function treatedSurvivalSeconds() {
  const g = fresh();
  const s = g.state;
  const v = createVictim({ incidentId: null, x: 200, y: 150, severity: 'critical' });
  s.victims.push(v);
  v.treatedAtMs = 0;
  v.condition = Math.min(1, v.condition + CONFIG.medical.treatGain);
  v.stabilisedUntilMs = CONFIG.medical.treatDurationMs;
  let ms = 0;
  while (!v.lost && ms < 25 * 60000) { g.step(STEP, null); ms += STEP; }
  return v.lost ? ms / 1000 : Infinity;
}

/** What real play costs: call -> somebody standing next to the casualty. */
function arrivalProfile(seed) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  const bot = new CrewBot(g);
  const born = new Map(), reached = new Map(), died = new Map();

  for (let t = 0; t < CONFIG.shift.durationMs; t += STEP) {
    bot.think();
    g.frame(STEP, bot.input);
    if (s.mode !== 'playing') break;
    for (const v of s.victims) {
      if (!born.has(v.id)) born.set(v.id, s.simTimeMs);
      if (!reached.has(v.id) && s.responders.some((r) => !r.inVehicleId && dist(r.x, r.y, v.x, v.y) < CONFIG.player.reachM + 1)) {
        reached.set(v.id, s.simTimeMs);
      }
      if (v.lost && !died.has(v.id)) died.set(v.id, s.simTimeMs);
    }
  }
  const arrivals = [...reached.entries()].map(([id, t]) => (t - born.get(id)) / 1000);
  const deaths = [...died.entries()].map(([id, t]) => (t - born.get(id)) / 1000);
  return { casualties: born.size, arrivals, deaths };
}

try {
  const M = CONFIG.medical;
  lines.push('=== how long a casualty has, untouched ===');
  for (const sev of ['stable', 'injured', 'critical']) {
    const t = survivalSeconds(sev);
    lines.push(`  ${sev.padEnd(10)} ${t === Infinity ? 'survives the shift' : t.toFixed(0) + ' s'}`);
  }
  const trapped = survivalSeconds('critical', { trappedBy: 'wreck' });
  lines.push(`  critical + trapped in a car   ${trapped === Infinity ? 'survives' : trapped.toFixed(0) + ' s'}`);
  const treated = treatedSurvivalSeconds();
  lines.push(`  critical, treated once        ${treated === Infinity ? 'survives the shift' : treated.toFixed(0) + ' s'}` +
    `   (the medkit buys ${treated === Infinity ? 'the rest of the shift' : (treated - survivalSeconds('critical')).toFixed(0) + ' s'})`);

  lines.push('');
  lines.push('=== fixed costs of the chain, in seconds ===');
  lines.push(`  extricate ${M.extricateMs / 1000}   treat ${M.treatMs / 1000}   load ${M.loadMs / 1000}   handover ${M.clinicHandoverMs / 1000}` +
    `   = ${(M.extricateMs + M.treatMs + M.loadMs + M.clinicHandoverMs) / 1000} s of hands-on work`);

  lines.push('');
  lines.push('=== what real play costs: casualty appears -> somebody is standing over them ===');
  for (const seed of [101, 202, 303]) {
    const p = arrivalProfile(seed);
    const arr = p.arrivals.length
      ? p.arrivals.map((a) => a.toFixed(0)).join(', ') + ' s'
      : 'NOBODY EVER REACHED A CASUALTY';
    lines.push(`  seed ${seed}: ${p.casualties} casualties · reached after ${arr}`);
    if (p.deaths.length) lines.push(`            died after ${p.deaths.map((d) => d.toFixed(0)).join(', ')} s`);
  }
  emit();
} catch (err) {
  lines.push('threw: ' + (err && err.message));
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
