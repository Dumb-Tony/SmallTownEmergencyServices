/* Netcode suite — GDD Phase 5b.
 *
 * The transport is WebRTC and cannot be exercised on a headless box with no second
 * machine. EVERYTHING ELSE CAN, and that is the part with the bugs in it: the wire
 * format, the authority rule, who is allowed to move whom, and what happens when a
 * partner vanishes mid-shift.
 *
 * So this suite runs a real host and a real client — two whole Game instances — joined
 * by a loopback link that JSON round-trips every message, in one page, deterministically.
 * The only thing it does not prove is that PeerJS can find a router, and that is the one
 * thing no test on this machine could ever prove.
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, toggleCoop } from '../src/game.js';
import { clearSave, defaultTown } from '../src/core/persistence.js';
import {
  MSG, PROTOCOL_VERSION, encodeSnapshot, applySnapshot,
  encodeCommand, decodeCommand, packCells, unpackCells, EMPTY_COMMAND,
} from '../src/net/protocol.js';
import { NetSession, ROLE, loopbackPair, randCode } from '../src/net/net.js';
import { roomFromUrl, shareUrl } from '../src/net/link.js';
import { createFire, createGas, createPower, createTree, createWreck } from '../src/sim/hazards.js';
import { createVictim } from '../src/sim/victims.js';
import { createIncident } from '../src/sim/incidentSim.js';
import { TEMPLATE_BY_ID } from '../src/data/incidents.js';
import { Rng } from '../src/core/rng.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const STEP = CONFIG.sim.stepMs;

let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0 ? `ALL-PASS  ${passes} assertions`
    : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==STESTEST-END==';
}

function freshGame(seed, label) {
  clearSave();
  const g = new Game({ seed, seedLabel: label });
  g.startShift();
  g.town = defaultTown();
  g.state.town = g.town;
  g.state.dispatch.nextCallAtMs = Infinity;   // quiet town unless a test asks otherwise
  return g;
}

const CMD = (over = {}) => ({ ...EMPTY_COMMAND, ...over });

/** Host + client, wired together, ready to pump. */
function pair(seed = 5000) {
  const host = freshGame(seed, 'host');
  const client = freshGame(seed, 'client');
  const [hl, cl] = loopbackPair();
  const hostNet = new NetSession(host).hostOn(hl);
  const clientNet = new NetSession(client).clientOn(cl);   // sends HELLO immediately
  return { host, client, hostNet, clientNet, hl, cl };
}

/* ── A. the wire format ──────────────────────────────────────────────────── */
function sectionA() {
lines.push('--- A. the wire format (pure, no transport anywhere near it) ---');
{
  const g = freshGame(11, 'wire');
  const s = g.state;
  toggleCoop(s);

  // put something of every kind in the town so the round trip has work to do
  const inc = createIncident(s, TEMPLATE_BY_ID.kitchen_fire, new Rng(3));
  s.hazards.push(createGas('hardware'));
  s.hazards.push(createPower(258, 150, 'pole_main_e'));
  s.hazards.push(createTree(160, 96, 'elm_st'));
  s.hazards.push(createWreck(258, 150, 0.5, { fuelLeak: 0.4, burning: true }));
  s.victims.push(createVictim({ incidentId: inc.id, x: 200, y: 150, severity: 'critical' }));
  const fire = s.hazards.find((h) => h.kind === 'fire');
  fire.cells[0].burning = true; fire.cells[0].heat = 1.1;
  fire.cells[1].burnt = true;
  fire.cells[2].wet = 1.0; fire.cells[2].heat = 0.5;
  s.apparatus[0].siren = true; s.apparatus[0].waterL = 1234; s.apparatus[0].driverId = 'r1';
  s.apparatus[0].passengerIds = ['r2'];
  s.tools[0].carrier = 'r2'; s.tools[0].flowing = true;
  s.responders[1].x = 123.45; s.responders[1].y = 67.89;
  s.town.confidence = 0.42;
  s.town.buildings.pizza = { damage: 0.5, boardedShifts: 2, timesBurned: 1 };
  s.town.hydrants.hyd_elm = { damaged: true };

  const snap = JSON.parse(JSON.stringify(encodeSnapshot(s)));   // as it arrives
  eq('A1 a snapshot is stamped with the protocol version', snap.v, PROTOCOL_VERSION);

  const g2 = freshGame(99, 'blank');
  ok('A2 a snapshot applies to a different town', applySnapshot(g2.state, snap));
  const c = g2.state;

  eq('A3 sim time crosses', Math.round(c.simTimeMs), Math.round(s.simTimeMs));
  eq('A4 the crew crosses', c.responders.length, 2);
  near('A5 to the centimetre', c.responders[1].x, 123.45, 0.01);
  near('A6 and so does facing', c.responders[1].facing, s.responders[1].facing, 0.002);

  eq('A7 apparatus state crosses', c.apparatus[0].waterL, 1234);
  eq('A8 including who is at the wheel', c.apparatus[0].driverId, 'r1');
  eq('A9 and who is riding', c.apparatus[0].passengerIds.join(), 'r2');
  eq('A10 sirens cross', c.apparatus[0].siren, true);

  eq('A11 tool ownership crosses', c.tools[0].carrier, 'r2');
  eq('A12 and whether it is flowing', c.tools[0].flowing, true);

  eq('A13 patients cross', c.victims.length, s.victims.length);
  near('A14 with their condition', c.victims[0].condition, s.victims[0].condition, 0.002);

  const cf = c.hazards.find((h) => h.kind === 'fire');
  eq('A15 every hazard kind crosses', c.hazards.length, s.hazards.length);
  ok('A16 a fire arrives with its cell grid rebuilt', cf && cf.cells.length === fire.cells.length);
  eq('A17 burning cells cross', cf.cells[0].burning, true);
  eq('A18 burnt cells cross', cf.cells[1].burnt, true);
  ok('A19 wet cells cross', cf.cells[2].wet > 0);
  near('A20 and heat, to an eighth', cf.cells[0].heat, 1.1, 0.13);
  ok('A21 cell POSITIONS are rebuilt, not sent',
    Math.abs(cf.cells[5].x - fire.cells[5].x) < 0.001 && Math.abs(cf.cells[5].y - fire.cells[5].y) < 0.001);

  const cg = c.hazards.find((h) => h.kind === 'gas');
  const cp = c.hazards.find((h) => h.kind === 'power');
  const ct = c.hazards.find((h) => h.kind === 'tree');
  const cw = c.hazards.find((h) => h.kind === 'wreck');
  ok('A22 gas crosses with its reading', cg && Math.abs(cg.ppm - s.hazards.find((h) => h.kind === 'gas').ppm) < 0.002);
  ok('A23 a live line crosses as live', cp && cp.live === true && cp.poleId === 'pole_main_e');
  ok('A24 a trunk crosses with its radius', ct && Math.abs(ct.radiusM - 5.2) < 0.002);
  ok('A25 a burning wreck crosses as burning', cw && cw.burning === true && cw.kindTag === 'car');

  eq('A26 the call list crosses', c.incidents.length, s.incidents.length);
  eq('A27 with the report text', c.incidents[0].report, s.incidents[0].report);
  eq('A28 and its priority', c.incidents[0].priority, s.incidents[0].priority);

  near('A29 town confidence crosses', c.town.confidence, 0.42, 0.002);
  near('A30 building damage crosses', c.town.buildings.pizza.damage, 0.5, 0.002);
  eq('A31 boarded-up shops cross', c.town.buildings.pizza.boardedShifts, 2);
  eq('A32 broken hydrants cross', c.town.hydrants.hyd_elm.damaged, true);
  gt('A33 the radio crosses', c.radio.length, 0);

  // identity: the camera holds a reference to responders[0] across frames
  const before = c.responders[0];
  applySnapshot(c, snap);
  ok('A34 applying twice reuses the same objects', c.responders[0] === before);

  const cells = [{ heat: 0.75, burning: true, burnt: false, wet: 0 },
                 { heat: 0, burning: false, burnt: true, wet: 1 }];
  const round = unpackCells(cells.map((x) => ({ ...x, heat: 0, burning: false, burnt: false, wet: 0 })), packCells(cells));
  ok('A35 cell packing round-trips', round[0].burning === true && round[1].burnt === true && round[1].wet > 0);

  const cmd = CMD({ axis: { x: 0.7071, y: -0.7071 }, use: true, slot: 3, aim: { x: 12.5, y: 300.25 } });
  const back = decodeCommand(JSON.parse(JSON.stringify(encodeCommand(cmd))));
  near('A36 commands round-trip: axis', back.axis.x, 0.7071, 0.002);
  eq('A37 commands round-trip: use', back.use, true);
  eq('A38 commands round-trip: slot', back.slot, 3);
  near('A39 commands round-trip: aim', back.aim.y, 300.25, 0.01);
  eq('A40 an absent aim stays absent', decodeCommand(encodeCommand(CMD())).aim, null);
}
emit('running A');
}

/* ── B. a session, host and client, over a loopback link ─────────────────── */
function sectionB() {
lines.push('--- B. host and client (two whole games, one link) ---');
{
  const { host, client, hostNet, clientNet } = pair(5001);

  eq('B1 the host knows it is the host', hostNet.role, ROLE.HOST);
  eq('B2 the client knows it is the client', clientNet.role, ROLE.CLIENT);
  eq('B3 connecting brings a partner onto the crew', host.state.responders.length, 2);
  ok('B4 that partner is flagged remote', host.state.responders[1].remote === true);
  eq('B5 the client is told which responder is theirs', clientNet.localResponderId, 'r2');
  eq('B6 and the host still drives its own', hostNet.localResponderId, 'r1');
  eq('B7 both sides report connected', `${hostNet.status}/${clientNet.status}`, 'connected/connected');
}
{
  // The headline: a key pressed on the client moves the client's responder on the HOST.
  const { host, client, hostNet, clientNet } = pair(5002);
  const hostR2 = host.state.responders[1];
  const x0 = hostR2.x;

  for (let i = 0; i < 60; i++) {
    clientNet.pump(16.7, CMD({ axis: { x: 1, y: 0 } }));   // client holds "right"
    host.frame(16.7, null);                                 // host simulates
    hostNet.pump(16.7, null);                               // host snapshots
  }
  gt('B8 a command sent from the client moves that responder on the host', hostR2.x - x0, 2);
  gt('B9 the host received commands', hostNet.cmdsReceived, 30);
  gt('B10 the client received snapshots', clientNet.snapsReceived, 5);

  near('B11 and the client sees the host\'s position for it',
    client.state.responders[1].x, hostR2.x, 1.5);
  eq('B12 the client never stepped its own simulation', client.clock.stepCount, 0);
  near('B13 the client\'s clock is the host\'s clock',
    client.state.simTimeMs, host.state.simTimeMs, 200);
}
{
  // Authority: a client cannot move the host's responder, whatever it sends.
  const { host, hostNet, clientNet } = pair(5003);
  const hostR1 = host.state.responders[0];
  const before = { x: hostR1.x, y: hostR1.y };
  for (let i = 0; i < 60; i++) {
    clientNet.pump(16.7, CMD({ axis: { x: -1, y: -1 } }));
    host.frame(16.7, null);
  }
  near('B14 a client cannot move the host\'s responder', hostR1.x, before.x, 0.001);
  near('B15 nor drag it sideways', hostR1.y, before.y, 0.001);
}
{
  // The client's own simulation must be inert: only snapshots may change it.
  const { host, client, hostNet, clientNet } = pair(5004);
  const before = client.state.simTimeMs;
  client.frame(1000, null);            // a client that tries to step must get nowhere
  eq('B16 a client refuses to advance its own clock', client.state.simTimeMs, before);

  for (let i = 0; i < 30; i++) { host.frame(16.7, null); hostNet.pump(16.7, null); }
  gt('B17 but a snapshot moves it forward', client.state.simTimeMs, before);
}
emit('running B');
}

/* ── C. the world crosses, not just the crew ─────────────────────────────── */
function sectionC() {
lines.push('--- C. the client sees the same town ---');
{
  const { host, client, hostNet, clientNet } = pair(5005);
  const s = host.state;
  const inc = createIncident(s, TEMPLATE_BY_ID.kitchen_fire, new Rng(7));
  const fire = s.hazards.find((h) => h.kind === 'fire');

  for (let i = 0; i < 240; i++) { host.frame(16.7, null); hostNet.pump(16.7, null); clientNet.pump(16.7, CMD()); }

  const cFire = client.state.hazards.find((h) => h.kind === 'fire');
  ok('C1 the fire crossed', !!cFire);
  eq('C2 with the same number of cells alight', cFire.cells.filter((c) => c.burning).length,
    fire.cells.filter((c) => c.burning).length);
  eq('C3 the call crossed', client.state.incidents.length, s.incidents.length);
  eq('C4 with its status', client.state.incidents[0].status, inc.status);
  near('C5 and its danger', client.state.incidents[0].danger, inc.danger, 0.002);
  gt('C6 the client has radio traffic to show', client.state.radio.length, 0);
  near('C7 town confidence agrees', client.state.town.confidence, s.town.confidence, 0.002);

  // a client's HUD needs the victim links to draw patient chips
  ok('C8 incidents keep their victim links', Array.isArray(client.state.incidents[0].victimIds));
}
emit('running C');
}

/* ── D. partners leaving, and other bad days ─────────────────────────────── */
function sectionD() {
lines.push('--- D. disconnects, versions, and nothing left holding the bag ---');
{
  const { host, hostNet, cl } = pair(5006);
  const s = host.state;
  const r2 = s.responders[1];

  // give the partner something to be holding when the line drops
  const tool = s.tools.find((t) => t.defId === 'medkit');
  tool.carrier = r2.id;
  r2.toolId = tool.id;
  const v = createVictim({ incidentId: 'x', x: r2.x, y: r2.y, severity: 'injured' });
  v.draggedBy = r2.id;
  s.victims.push(v);

  cl.close();                                   // the partner's browser closes

  eq('D1 the crew is back to one', s.responders.length, 1);
  eq('D2 the tool they were holding is on the ground', tool.carrier, null);
  eq('D3 the patient they were dragging is put down', v.draggedBy, null);
  eq('D4 the host says so', hostNet.status, 'partner left');
  ok('D5 no stale command is left driving a responder that no longer exists',
    Object.keys(s.net.remoteCommands).length === 0);

  let threw = false;
  try { for (let i = 0; i < 60; i++) { host.frame(16.7, null); hostNet.pump(16.7, null); } } catch (e) { threw = true; }
  ok('D6 and the shift carries on without them', !threw && s.mode === MODES.PLAYING);
}
{
  const g = freshGame(5007, 'ver');
  const [hl, cl] = loopbackPair();
  const net = new NetSession(g).hostOn(hl);
  cl.send({ t: MSG.HELLO, v: PROTOCOL_VERSION + 99 });
  eq('D7 a mismatched protocol version is refused, not crashed into', net.status, 'version mismatch');
  eq('D8 and no partner is admitted', g.state.responders.length, 1);
}
{
  const g = freshGame(5008, 'garbage');
  const snapOk = encodeSnapshot(g.state);
  eq('D9 a snapshot from the future is ignored',
    applySnapshot(g.state, { ...snapOk, v: 999 }), false);
  eq('D10 and so is nothing at all', applySnapshot(g.state, null), false);
}
{
  // leave() must be safe from either side, twice
  const { hostNet, clientNet } = pair(5009);
  let threw = false;
  try { clientNet.leave(); clientNet.leave(); hostNet.leave(); hostNet.leave(); } catch (e) { threw = true; }
  ok('D11 leaving is safe, and idempotent', !threw);
  eq('D12 and puts you back to solo', hostNet.role, ROLE.SOLO);
}
{
  const seen = new Set();
  const rng = new Rng(4242);
  for (let i = 0; i < 500; i++) seen.add(randCode(() => rng.float()));
  gt('D13 room codes are not all the same', seen.size, 400);
  ok('D14 and are five readable characters',
    [...seen].every((c) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(c)));
}
emit('running D');
}

/* ── E. cost on the wire ─────────────────────────────────────────────────── */
function sectionE() {
lines.push('--- E. what it costs to send ---');
{
  const g = freshGame(5010, 'size');
  const s = g.state;
  toggleCoop(s);
  // a busy town: three fires, a crash, calls on the board
  for (const id of ['pizza', 'hardware', 'feedstore']) {
    const f = createFire(id, { seedCells: 4, heat: 1, from: 'centre' });
    for (const c of f.cells) { c.burning = true; c.heat = 1; }
    s.hazards.push(f);
  }
  for (let i = 0; i < 4; i++) createIncident(s, TEMPLATE_BY_ID.two_car, new Rng(i + 1));

  const bytes = JSON.stringify(encodeSnapshot(s)).length;
  const cmdBytes = JSON.stringify(encodeCommand(CMD({ aim: { x: 1, y: 2 } }))).length;
  lines.push(`    busy-town snapshot ${bytes} B · at 12 Hz that is ${(bytes * 12 / 1024).toFixed(1)} kB/s`);
  lines.push(`    one command ${cmdBytes} B · at 60 Hz that is ${(cmdBytes * 60 / 1024).toFixed(1)} kB/s`);

  ok('E1 a busy-town snapshot fits in a sensible packet budget', bytes < 60000, `${bytes} B`);
  ok('E2 twelve a second is a few kB/s, not a few hundred', bytes * 12 / 1024 < 200, `${(bytes * 12 / 1024).toFixed(1)} kB/s`);
  ok('E3 a command is small enough to send every frame', cmdBytes < 200, `${cmdBytes} B`);
}
emit(null);
}

/* ── F. the invitation ───────────────────────────────────────────────────── */
function sectionF() {
lines.push('--- F. joining by link (a URL is input a stranger controls) ---');
  const base = 'https://dumb-tony.github.io/SmallTownEmergencyServices/';
  eq('F1 a room in the hash is read', roomFromUrl(base + '#room=ABCDE'), 'ABCDE');
  eq('F2 and in the query', roomFromUrl(base + '?room=ABCDE'), 'ABCDE');
  eq('F3 lower case is fine — people retype links', roomFromUrl(base + '#room=abcde'), 'ABCDE');
  eq('F4 a plain link is not an invitation', roomFromUrl(base), null);
  eq('F5 nor is nonsense', roomFromUrl('not a url at all'), null);
  eq('F6 nor is an empty room', roomFromUrl(base + '#room='), null);

  /* The code goes straight into a PeerJS peer id, so anything that is not a plausible
     code has to be refused rather than passed along. */
  eq('F7 an over-long code is refused', roomFromUrl(base + '#room=ABCDEFGHIJKLMNOP'), null);
  eq('F8 so are characters that are not in the alphabet', roomFromUrl(base + '#room=AB!DE'), null);
  eq('F9 including the ones deliberately left out of it', roomFromUrl(base + '#room=ABCD0'), null);
  eq('F10 and a path traversal dressed as a room', roomFromUrl(base + '#room=../../etc'), null);
  eq('F11 and script, encoded or not',
    roomFromUrl(base + '#room=%3Cscript%3Ealert(1)%3C/script%3E'), null);

  const url = shareUrl(base, 'ABCDE');
  eq('F12 the invitation is this page plus the room', url, base + '#room=ABCDE');
  eq('F13 and it round-trips', roomFromUrl(url), 'ABCDE');
  eq('F14 hosting twice replaces the room, never stacks two',
    shareUrl(base + '#room=OLDXX', 'NEWYY'), base + '#room=NEWYY');
  eq('F15 an existing query survives', shareUrl(base + '?debug=1', 'ABCDE'), base + '?debug=1#room=ABCDE');
  eq('F16 no code, no change', shareUrl(base, null), base);
  eq('F17 no page, no link', shareUrl('', 'ABCDE'), '');
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE(); sectionF();
  emit(null);
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
