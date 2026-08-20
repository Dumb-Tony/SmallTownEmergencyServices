/* One medical call at a time, with a bot on it and nothing else in the town.
 *
 * The play measurement says medical calls are worked 4 times out of 4 and controlled 0
 * times out of 4. This runs each template alone so the stall is visible rather than
 * inferred: what the bot decided, where the casualty got to, and what the incident was
 * still waiting for when the clock ran out.
 */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { createIncident, incidentVictims, incidentHazards } from '../src/sim/incidentSim.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { victimHandled, victimState } from '../src/sim/victims.js';
import { Rng } from '../src/core/rng.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';
import { toggleCoop } from '../src/game.js';

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

function runOne(templateId, seed, crew = 1) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  // stop dispatch from adding anything else: this call, and only this call
  s.dispatch.nextCallAtMs = Number.MAX_SAFE_INTEGER;
  const inc = createIncident(s, TEMPLATE_BY_ID[templateId], new Rng(seed));
  if (crew === 2) toggleCoop(s);

  const board = { claims: new Map(), trucks: new Map() };
  const bots = s.responders.map((r) => new CrewBot(g, r.id, crew === 2 ? board : null));
  bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : 'p2'); });
  const bot = bots[0];
  const input = bots.length > 1 ? mergeBotInputs(bots.map((b) => b.input)) : bot.input;
  const jobs = {};
  let firstReach = null, firstJobless = null;

  for (let t = 0; t < CONFIG.shift.durationMs; t += STEP) {
    for (const b of bots) b.think();
    if (bot.lastJob) jobs[bot.lastJob.kind] = (jobs[bot.lastJob.kind] || 0) + 1;
    g.frame(STEP, input);
    if (s.mode !== 'playing') break;
    if (inc.status === 'controlled' || inc.status === 'lost') break;
    if (firstReach === null && inc.everWorked) firstReach = s.simTimeMs;
    // a bot standing at the call with no job to do is the interesting failure
    if (firstJobless === null && inc.everWorked && !bot.lastJob) firstJobless = s.simTimeMs;
  }

  const vics = incidentVictims(s, inc);
  const hz = incidentHazards(s, inc);
  return {
    templateId,
    status: inc.status,
    at: (s.simTimeMs / 1000).toFixed(0),
    reachedAt: firstReach === null ? null : (firstReach / 1000).toFixed(0),
    jobs,
    victims: vics.map((v) => ({
      state: victimState(v),
      handled: victimHandled(v),
      cond: v.condition.toFixed(2),
      treated: v.treatedAtMs != null,
      needsRide: !!v.needsTransport,
      inside: v.insideBuildingId || null,
      inTruck: v.inApparatusId || null,
      delivered: v.delivered,
      trapped: !!v.trappedBy,
      lost: v.lost,
    })),
    hazards: hz.map((h) => `${h.kind}${h.resolved ? '(resolved)' : ''}`),
    log: bot.log.slice(-8),
  };
}

try {
  for (const [id, crew] of [['fall_outdoor', 1], ['chest_pain', 1], ['farm_entrapment', 1], ['farm_entrapment', 2]]) {
    for (const seed of [11, 22]) {
      const r = runOne(id, seed, crew);
      lines.push(`=== ${id} (seed ${seed}, ${crew} crew) -> ${r.status.toUpperCase()} at ${r.at}s` +
        `, crew on scene at ${r.reachedAt === null ? 'never' : r.reachedAt + 's'} ===`);
      lines.push('    jobs: ' + (Object.entries(r.jobs).map(([k, v]) => `${k} ${v}`).join('  ') || 'NONE'));
      lines.push('    hazards: ' + (r.hazards.join(', ') || 'none'));
      for (const v of r.victims) {
        lines.push(`    casualty: ${v.state} cond ${v.cond} · handled=${v.handled}` +
          ` treated=${v.treated} needsRide=${v.needsRide} inside=${v.inside}` +
          ` inTruck=${v.inTruck} delivered=${v.delivered} trapped=${v.trapped} lost=${v.lost}`);
      }
      for (const l of r.log) lines.push('      ' + l);
      lines.push('');
    }
  }
  emit();
} catch (err) {
  lines.push('threw: ' + (err && err.message));
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
