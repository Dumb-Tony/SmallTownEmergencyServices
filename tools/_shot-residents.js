/* Poses a working structure fire with the household out on the street and a crowd on the
 * road: what the residents milestone actually looks like from the driver's seat. */
import { BUILDING_BY_ID } from '../src/data/town.js';
import { createFire } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';

window.requestAnimationFrame = () => 0;      // the page must idle for the screenshot

const S = window.__STES;
S.startShift();
const s = S.game.state;

const b = BUILDING_BY_ID.pizza;

const inc = {
  id: 'incShot', templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
  place: b.name, x: b.door.x, y: b.door.y, buildingId: b.id, roadId: null,
  priority: 'high', report: 'Caller reports smoke from the kitchen.', createdMs: 0,
  ageMs: 74000, danger: 0.42, peakDanger: 0.42, status: 'active', hazardIds: [],
  victimIds: [], consequences: [], capabilities: [], updates: [], lastUpdateText: null,
  resolvedMs: null, outcomeNote: null, everWorked: true,
};
s.incidents.push(inc);
addHazard(s, inc, createFire(b.id, { seedCells: 3, heat: 1.0, from: 'centre' }));

// One call, so the crowd has one thing to look at. Dispatch would otherwise open a
// second fire across the street and half the town would go and watch that instead —
// which is correct behaviour and a useless photograph.
s.dispatch.nextCallAtMs = 1e9;

/* Run to the moment the milestone is about: the household is on the grass, the neighbours
 * have come out to look, and the building is still standing. `onlooker` means "on their
 * way to the ring" as well as "standing on it", so wait for arrivals rather than for the
 * count — otherwise the photograph is of three people walking. */
const settled = () => s.residents.filter((r) => r.state === 'onlooker' &&
  r.watching === inc.id && Math.hypot(r.x - r.tx, r.y - r.ty) < 2).length;
for (let i = 0; i < 9000; i++) {
  S.game.frame(1000 / 60, null);
  s.dispatch.nextCallAtMs = 1e9;
  inc.danger = 0.42;
  if (settled() >= 2 && s.residents.some((r) => r.homeId === b.id && r.state === 'safe')) break;
}
S.game.clock.setPaused(true);

// Put the engine on the street outside, and the player on foot beside it.
const ap = s.apparatus[0];
ap.x = b.door.x - 9; ap.y = b.door.y + 9; ap.angle = -Math.PI / 2; ap.siren = false;
const p = s.player;
p.x = b.door.x - 4; p.y = b.door.y + 6; p.facing = -Math.PI / 2;

S.camera.viewWidthM = 58;
S.camera._recomputeScale();
S.camera.follow(b.door.x + 4, b.door.y + 3, 0);
S.camera.resize(document.getElementById('stage'));
S.renderer.render(s, performance.now());
S.hud.update();
