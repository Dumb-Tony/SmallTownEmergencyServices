/* Why is the bot not putting water on the fire? Trace one call, closely. */
import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import { CrewBot } from './_crewbot.js';
import { heldTool } from '../src/sim/interaction.js';

const out = [];
const STEP = CONFIG.sim.stepMs;
clearSave();
const g = new Game({ seed: 9001, seedLabel: 'play_a' });
g.startShift();
g.town = defaultTown(); g.state.town = g.town;
const bot = new CrewBot(g);
const s = g.state;
let last = -1;

for (let t = 0; t < 120000; t += STEP) {
  bot.think();
  g.frame(STEP, bot.input);
  const sec = Math.floor(s.simTimeMs / 1000);
  if (sec !== last && sec >= 40 && sec % 3 === 0) {
    last = sec;
    const j = bot.lastJob;
    const tool = heldTool(s);
    const fire = s.hazards.find((h) => h.kind === 'fire');
    const bearing = j ? Math.atan2(j.y - s.player.y, j.x - s.player.x) : 0;
    const delta = j ? Math.abs(Math.atan2(Math.sin(bearing - s.player.facing), Math.cos(bearing - s.player.facing))) : -1;
    out.push(`${sec}s p=${s.player.x.toFixed(1)},${s.player.y.toFixed(1)} inside=${s.player.insideBuildingId || '-'} ` +
      `tool=${tool ? tool.defId : '-'} job=${j ? j.kind : '-'} ` +
      (j ? `jt=${j.x.toFixed(1)},${j.y.toFixed(1)} d=${Math.hypot(j.x - s.player.x, j.y - s.player.y).toFixed(1)} aimΔ=${delta.toFixed(2)} ` : '') +
      `keys=${[...bot.input.down].join('+') || '-'} ` +
      `burning=${fire ? fire.burningCount : '-'} water=${Math.round(s.telemetry.litresUsed)}L`);
  }
  if (sec > 110) break;
}

const pre = document.createElement('pre');
pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;color:#cfe;font:11px monospace;padding:12px';
pre.textContent = '==STESTEST-BEGIN==\n' + out.join('\n') + '\nALL-PASS diagnostic\n==STESTEST-END==';
document.body.appendChild(pre);
