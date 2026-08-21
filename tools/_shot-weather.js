/* A working structure fire in heavy rain, with the wind across it: the whole weather
 * milestone in one frame — graded ground, streaks, and a plume leaning downwind, which is
 * the thing that tells you which building goes next. */
import { BUILDING_BY_ID } from '../src/data/town.js';
import { createFire } from '../src/sim/hazards.js';
import { addHazard } from '../src/sim/incidentSim.js';

window.requestAnimationFrame = () => 0;      // the page must idle for the screenshot

const S = window.__STES;
S.startShift();
const s = S.game.state;
const b = BUILDING_BY_ID.hardware;

s.weather = { id: 'rain', strength: 1, windDir: 0.15 };   // blowing east, along the street
// startShift already spoke the roll-call line for whatever this seed rolled, so a forced
// condition leaves the radio contradicting the pill in the photograph.
if (s.radio[0]) s.radio[0].text = 'Shift 1 on. Station is in service. Heavy rain.';

const inc = {
  id: 'incShot', templateId: 'kitchen_fire', family: 'fire', headline: 'Structure fire',
  place: b.name, x: b.door.x, y: b.door.y, buildingId: b.id, roadId: null,
  priority: 'high', report: 'Second caller reports flame showing at a window.',
  createdMs: 0, ageMs: 96000, danger: 0.55, peakDanger: 0.55, status: 'active',
  hazardIds: [], victimIds: [], consequences: [], capabilities: [], updates: [],
  lastUpdateText: null, resolvedMs: null, outcomeNote: null, everWorked: true,
};
s.incidents.push(inc);
addHazard(s, inc, createFire(b.id, { seedCells: 5, heat: 1.0, from: 'centre' }));

// Let the fire build and the neighbours come out, with no second call to split the frame.
for (let i = 0; i < 3600; i++) {
  S.game.frame(1000 / 60, null);
  s.dispatch.nextCallAtMs = 1e9;
  inc.danger = 0.55;
}
S.game.clock.setPaused(true);

const ap = s.apparatus[0];
ap.x = b.door.x - 11; ap.y = b.door.y + 8; ap.angle = 0; ap.siren = true;
const p = s.player;
p.x = b.door.x - 5; p.y = b.door.y + 5; p.facing = -Math.PI / 2;

/* Framed to include the top of the plume, because the lean is the point: on a windy or
 * wet night the column tells you which building is next, and a frame cropped at the
 * roofline is a photograph of a fire rather than of the mechanic. */
S.camera.viewWidthM = 96;
S.camera._recomputeScale();
S.camera.follow(b.door.x + 6, b.door.y - 16, 0);
S.camera.resize(document.getElementById('stage'));
S.renderer.render(s, performance.now());
S.hud.update();
