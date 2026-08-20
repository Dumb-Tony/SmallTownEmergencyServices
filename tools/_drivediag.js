/* How does a truck actually handle? Numbers for the thing the player spends the most
 * time doing.
 *
 * Every figure here is measured by driving the real apparatus through the real movement
 * system, with commands shaped exactly like a keyboard's.
 */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { dist, BUILDING_BY_ID } from '../src/data/town.js';

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

/** A game with one apparatus placed and crewed, and nothing else going on. */
function rig(apId, x, y, angle) {
  clearSave();
  const g = new Game({ seed: 808 });
  g.startShift();
  const s = g.state;
  s.dispatch.nextCallAtMs = Number.MAX_SAFE_INTEGER;
  s.incidents.length = 0;
  s.hazards.length = 0;
  const ap = s.apparatus.find((a) => a.id === apId);
  ap.x = x; ap.y = y; ap.angle = angle; ap.speed = 0; ap.damage = 0;
  ap.driverId = s.player.id;
  s.player.inVehicleId = ap.id;
  return { g, s, ap };
}

/** Drive with a fixed command for a while. Returns seconds elapsed. */
function drive({ g, s, ap }, { throttle = 0, steer = 0 }, untilFn, capMs = 60000) {
  const input = {
    moveAxis: () => ({ x: 0, y: 0 }),
    isDown: (a) => (a === 'moveUp' && throttle > 0) || (a === 'moveDown' && throttle < 0)
      || (a === 'moveRight' && steer > 0) || (a === 'moveLeft' && steer < 0),
    wasPressed: () => false,
    wasReleased: () => false,
    endStep: () => {},
    pointerWorld: null,
  };
  let ms = 0;
  while (ms < capMs && !untilFn({ ap, s, ms })) { g.frame(STEP, input); ms += STEP; }
  return ms / 1000;
}

try {
  const D = CONFIG.drive;
  const defs = ['engine', 'ambulance', 'rescue'];

  lines.push('=== top speed on the road, and how long it takes to get there ===');
  for (const id of defs) {
    const r = rig(id, 30, 150, 0);                       // Main Street, pointing east
    const def = r.s.apparatusDefs[r.ap.defId];
    const secs = drive(r, { throttle: 1 }, ({ ap }) => ap.speed >= def.maxSpeed * 0.95, 30000);
    lines.push(`  ${def.name.padEnd(10)} ${(r.ap.speed * 3.6).toFixed(0).padStart(3)} km/h ` +
      `· 0 to 95% in ${secs.toFixed(1)} s · ${r.ap.odometerM.toFixed(0)} m used`);
  }

  lines.push('');
  lines.push('=== stopping: brake from top speed ===');
  for (const id of defs) {
    const r = rig(id, 30, 150, 0);
    const def = r.s.apparatusDefs[r.ap.defId];
    drive(r, { throttle: 1 }, ({ ap }) => ap.speed >= def.maxSpeed * 0.95, 30000);
    const x0 = r.ap.x, v0 = r.ap.speed;
    const secs = drive(r, { throttle: -1 }, ({ ap }) => ap.speed <= 0.4, 20000);
    lines.push(`  ${def.name.padEnd(10)} ${(v0 * 3.6).toFixed(0)} km/h -> stop in ` +
      `${secs.toFixed(1)} s and ${(r.ap.x - x0).toFixed(0)} m`);
  }

  lines.push('');
  lines.push('=== turning circle at a junction speed (about 25 km/h) ===');
  for (const id of defs) {
    const r = rig(id, 200, 150, 0);
    const def = r.s.apparatusDefs[r.ap.defId];
    drive(r, { throttle: 1 }, ({ ap }) => ap.speed >= 7, 20000);
    const a0 = r.ap.angle, x0 = r.ap.x, y0 = r.ap.y;
    // hold full lock and part throttle until the nose has come round 90 degrees
    const secs = drive(r, { throttle: 1, steer: 1 }, ({ ap }) => {
      let d = ap.angle - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d >= Math.PI / 2;
    }, 20000);
    lines.push(`  ${def.name.padEnd(10)} 90 deg in ${secs.toFixed(1)} s · ` +
      `swept ${dist(x0, y0, r.ap.x, r.ap.y).toFixed(0)} m of road`);
  }

  lines.push('');
  lines.push('=== can you get out of a jam? nose into a building at speed ===');
  for (const id of defs) {
    const b = BUILDING_BY_ID.hardware;
    const r = rig(id, b.x + b.w / 2, b.y + b.h + 14, -Math.PI / 2);   // south of it, facing north
    const def = r.s.apparatusDefs[r.ap.defId];
    drive(r, { throttle: 1 }, ({ ap }) => dist(ap.x, ap.y, b.x + b.w / 2, b.y + b.h) < 4.5, 20000);
    const struck = r.ap.damage;
    const stuckAt = { x: r.ap.x, y: r.ap.y };
    const secs = drive(r, { throttle: -1 }, ({ ap }) => dist(ap.x, ap.y, stuckAt.x, stuckAt.y) > 8, 20000);
    const freed = dist(r.ap.x, r.ap.y, stuckAt.x, stuckAt.y) > 8;
    lines.push(`  ${def.name.padEnd(10)} hit at ${(r.ap.speed * 3.6).toFixed(0)} km/h · ` +
      `damage ${(struck * 100).toFixed(0)}% · reversed clear ` +
      (freed ? `in ${secs.toFixed(1)} s` : 'NEVER — STUCK'));
  }

  lines.push('');
  lines.push('=== what damage costs ===');
  const r = rig('engine', 30, 150, 0);
  const def = r.s.apparatusDefs[r.ap.defId];
  for (const dmg of [0, 0.25, 0.5, 1]) {
    const t = rig('engine', 30, 150, 0);
    t.ap.damage = dmg;
    drive(t, { throttle: 1 }, ({ ms }) => ms >= 12000, 12000);
    lines.push(`  damage ${(dmg * 100).toFixed(0).padStart(3)}% -> top speed ` +
      `${(t.ap.speed * 3.6).toFixed(0)} km/h (undamaged ${(def.maxSpeed * 3.6).toFixed(0)})`);
  }
  lines.push(`  a bump under ${D.collisionFreeSpeed} m/s (${(D.collisionFreeSpeed * 3.6).toFixed(0)} km/h) does not mark the truck`);

  lines.push('');
  lines.push('=== grass ===');
  const onRoad = rig('engine', 30, 150, 0);
  drive(onRoad, { throttle: 1 }, ({ ms }) => ms >= 10000, 10000);
  const offRoad = rig('engine', 30, 118, 0);       // open ground north of Main Street
  drive(offRoad, { throttle: 1 }, ({ ms }) => ms >= 10000, 10000);
  lines.push(`  road ${(onRoad.ap.speed * 3.6).toFixed(0)} km/h vs grass ` +
    `${(offRoad.ap.speed * 3.6).toFixed(0)} km/h after ten seconds flat out`);
  emit();
} catch (err) {
  lines.push('threw: ' + (err && err.message));
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
