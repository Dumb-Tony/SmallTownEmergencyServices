/* The picture that shows up when the link is pasted into a chat. A working fire with the
   engine on scene and the crew on the line — the game doing the thing it is about.
   Composed for 1200x630: the camera sits on the building's SOUTH edge, because in the
   three-quarter view a building draws upward from its footprint and the crew stand
   below it. */
import { CONFIG } from '../src/config.js';
import { toolsInReachOf, stepInteraction } from '../src/sim/interaction.js';
import { BUILDING_BY_ID } from '../src/data/town.js';
import { clearSave } from '../src/core/persistence.js';
const S = window.__STES;
const g = S.game;
window.requestAnimationFrame = () => 0;
clearSave();
S.startShift();
const s = g.state;
const STEP = CONFIG.sim.stepMs;
const CMD = (over) => ({ axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 },
  interact: false, drop: false, use: false, siren: false, slot: null, ...over });

g.clock.skipMs(56000, (ms) => g.step(ms, null));

const fire = s.hazards.find((h) => h.kind === 'fire');
const b = BUILDING_BY_ID[fire.buildingId];
const eng = s.apparatus.find((a) => a.id === 'engine');
const cx = b.x + b.w / 2;
eng.x = cx + 9; eng.y = b.y + b.h + 12; eng.angle = -2.0; eng.siren = true;

// stand at the engine to take the line, then walk it to the door
s.player.x = eng.x - 2.4; s.player.y = eng.y - 1.2;
const avail = toolsInReachOf(s, s.player.x, s.player.y);
const i = avail.findIndex((a) => a.tool.defId === 'hose');
if (i >= 0) stepInteraction(s, CMD({ slot: i }), STEP);

const hot = fire.cells.filter((c) => c.burning).sort((p, q) => q.heat - p.heat)[0] || fire.cells[0];
s.player.x = cx - 3; s.player.y = b.y + b.h + 4.5;
s.player.facing = Math.atan2(hot.y - s.player.y, hot.x - s.player.x);
for (let t = 0; t < 900; t += STEP) stepInteraction(s, CMD({ use: true }), STEP);

g.clock.setPaused(true);
S.camera.resize(document.getElementById('stage'));
S.camera.viewWidthM = 88;
S.camera._recomputeScale();
S.camera.follow(cx, b.y + b.h + 1, 0);
S.hud.update();
S.hud.setHint(null);
S.renderer.render(s, performance.now());
