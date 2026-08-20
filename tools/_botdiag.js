/* Diagnostic: watch the crew bot play, second by second.
 * Not a test — this is how a headless playtest gets debugged. */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import { openIncidents } from '../src/sim/incidentSim.js';
import { CrewBot } from './_crewbot.js';
import { heldTool } from '../src/sim/interaction.js';

const out = [];
const STEP = CONFIG.sim.stepMs;

clearSave();
const g = new Game({ seed: 9001, seedLabel: 'diag' });
g.startShift();
g.town = defaultTown(); g.state.town = g.town;

const bot = new CrewBot(g);
const s = g.state;
let lastLog = -1;

for (let t = 0; t < 240000; t += STEP) {
  bot.think();
  g.frame(STEP, bot.input);
  const sec = Math.floor(s.simTimeMs / 1000);
  if (sec !== lastLog && sec % 4 === 0) {
    lastLog = sec;
    const ap = s.player.inVehicleId ? s.apparatus.find((a) => a.id === s.player.inVehicleId) : null;
    const tool = heldTool(s);
    const inc = s.incidents.find((i) => i.id === bot.targetIncidentId);
    out.push(
      `${String(sec).padStart(3)}s ` +
      `pos ${s.player.x.toFixed(0)},${s.player.y.toFixed(0)} ` +
      (ap ? `IN ${ap.id} spd ${ap.speed.toFixed(1)} ang ${(ap.angle * 57.3).toFixed(0)}° ` : 'on foot        ') +
      (tool ? `[${tool.defId}] ` : '[-] ') +
      `keys ${[...bot.input.down].join('+') || '-'} ` +
      `| ${inc ? `${inc.headline}@${inc.place} d=${Math.round(Math.hypot(inc.x - s.player.x, inc.y - s.player.y))}m danger=${inc.danger.toFixed(2)}` : 'no target'} ` +
      `| open ${openIncidents(s).length}`);
  }
  if (s.mode !== 'playing') break;
}

out.push('');
out.push(`controlled ${s.outcome.controlled} lost ${s.outcome.lost} water ${Math.round(s.telemetry.litresUsed)}L ` +
  `km ${(s.telemetry.distanceDrivenM / 1000).toFixed(2)} tools ${bot.actions.toolsTaken} ` +
  `entries ${bot.actions.entries} dismounts ${bot.actions.dismounts}`);
out.push('');
out.push('bot log:');
for (const l of bot.log.slice(0, 60)) out.push('  ' + l);

const pre = document.createElement('pre');
pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;color:#cfe;font:11px monospace;padding:12px';
pre.textContent = '==STESTEST-BEGIN==\n' + out.join('\n') + '\nALL-PASS diagnostic\n==STESTEST-END==';
document.body.appendChild(pre);
