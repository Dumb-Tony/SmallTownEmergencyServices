/* Four volunteers on one call: the top bar with a full crew on it, and four people in
 * four coats doing four different things. */
import { BUILDING_BY_ID } from '../src/data/town.js';
import { createFire } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';
import { seatResponder } from '../src/game.js';
import { createVictim } from '../src/sim/victims.js';

window.requestAnimationFrame = () => 0;      // the page must idle for the screenshot

const S = window.__STES;
S.startShift();
const s = S.game.state;
const b = BUILDING_BY_ID.hardware;

// A full crew, three of them over the wire.
for (const id of ['r2', 'r3', 'r4']) { const r = seatResponder(s, id); if (r) r.remote = true; }
s.coop = true;

const inc = {
  id: 'incShot', templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
  place: b.name, x: b.door.x, y: b.door.y, buildingId: b.id, roadId: null,
  priority: 'high', report: 'Caller reports flame showing at a window.', createdMs: 0,
  ageMs: 84000, danger: 0.5, peakDanger: 0.5, status: 'active', hazardIds: [],
  victimIds: [], consequences: [], capabilities: [], updates: [], lastUpdateText: null,
  resolvedMs: null, outcomeNote: null, everWorked: true,
};
s.incidents.push(inc);
addHazard(s, inc, createFire(b.id, { seedCells: 4, heat: 1.0, from: 'centre' }));

for (let i = 0; i < 2400; i++) {
  S.game.frame(1000 / 60, null);
  s.dispatch.nextCallAtMs = 1e9;
  inc.danger = 0.5;
}
S.game.clock.setPaused(true);

/* Pose the four of them so the picture shows the thing the crew is FOR: one on the line,
 * one at the wheel, one carrying somebody out, one still walking in. */
const eng = s.apparatus[0], med = s.apparatus[1];
eng.x = b.door.x - 12; eng.y = b.door.y + 8; eng.angle = 0; eng.siren = true;
med.x = b.door.x + 12; med.y = b.door.y + 9; med.angle = Math.PI;

const [r1, r2, r3, r4] = s.responders;
const hose = s.tools.find((t) => t.defId === 'hose');
r1.x = b.door.x - 4; r1.y = b.door.y + 4; r1.facing = -Math.PI / 2;
hose.carrier = r1.id; r1.toolId = hose.id; hose.flowing = true;

r2.x = med.x; r2.y = med.y; r2.inVehicleId = med.id; med.driverId = r2.id; med.passengerIds = [r2.id];

const casualty = createVictim({ incidentId: inc.id, x: b.door.x + 4, y: b.door.y + 5, severity: 'critical' });
casualty.draggedBy = r3.id;
r3.draggingVictimId = casualty.id;      // BOTH halves, or the HUD sees nobody carrying
s.victims.push(casualty);
inc.victimIds.push(casualty.id);
r3.x = b.door.x + 5; r3.y = b.door.y + 5; r3.facing = 0.4;

r4.x = b.door.x - 9; r4.y = b.door.y + 13; r4.facing = -Math.PI / 3;
const kit = s.tools.find((t) => t.defId === 'medkit');
kit.carrier = r4.id; r4.toolId = kit.id;

S.camera.viewWidthM = 68;
S.camera._recomputeScale();
S.camera.follow(b.door.x, b.door.y + 3, 0);
S.camera.resize(document.getElementById('stage'));
S.renderer.render(s, performance.now());
S.hud.update();
