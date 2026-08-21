/* A crew of four — GDD player fantasy, first line: "One to four players begin each shift
 * at a small volunteer station."
 *
 * The netcode was a fixed pair: one `link`, one `remoteResponderId`, and a partner who was
 * created by "if there are fewer than two responders, add one". Four seats is not that
 * shape with a bigger number in it, and the interesting assertions here are all about the
 * places where a two-case rule quietly becomes wrong at three:
 *
 *   - `toggleCoop` popped the LAST responder, so the P key on the host's keyboard would
 *     have signed off whichever volunteer happened to be last in the list — somebody on
 *     another continent;
 *   - a command was attributed to `remoteResponderId`, a single field, so any client's
 *     command drove the same body. With four seats a command has to be attributed to the
 *     LINK it arrived on, or one volunteer can drive another;
 *   - `readCommand`'s prefix is falsy-tested, so a third seat with an empty prefix reads
 *     r1's own keys — the per-seat-input-collapsing bug this tree shipped once already,
 *     in another project;
 *   - and the snapshot decoder painted anybody who was not `r2` in the HOST's colour and
 *     called them "You".
 *
 * Shape copied from ContainmentDetailWeb\src\net\net.js `seats` (Dev\INDEX.md ->
 * Multiplayer), which is the only squad-of-N in the tree.
 */

import { CONFIG } from '../src/config.js';
import {
  Game, MODES, CREW, MAX_CREW, readCommand,
  seatResponder, unseatResponder, toggleCoop,
} from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { loopbackPair, NetSession, ROLE } from '../src/net/net.js';
import {
  MSG, PROTOCOL_VERSION, encodeSnapshot, applySnapshot, encodeCommand, EMPTY_COMMAND,
} from '../src/net/protocol.js';
import { createVictim } from '../src/sim/victims.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';

const STEP = CONFIG.sim.stepMs;

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;
function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const gt = (n, a, b) => ok(n, a > b, `got ${a}, want > ${b}`);
const le = (n, a, b) => ok(n, a <= b, `got ${a}, want <= ${b}`);
const f = (n, d = 1) => Number(n).toFixed(d);

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

function freshGame(seed) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  return g;
}

/** A host with `n` volunteers connected over loopback links. */
function crewOf(n, seed = 9000) {
  const host = freshGame(seed);
  const net = new NetSession(host).host();
  const clients = [];
  for (let i = 0; i < n; i++) {
    const [hl, cl] = loopbackPair();
    net.accept(hl);
    cl.onMessage = (m) => { clients[i].welcomes.push(m); };
    clients.push({ hl, cl, welcomes: [] });
    cl.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
  }
  return { host, net, clients };
}

/* ── A. the crew table ───────────────────────────────────────────────────── */

function sectionA() {
lines.push('--- A. four seats, and only two of them have a keyboard ---');
  eq('A1 the crew is four', MAX_CREW, 4);
  eq('A2 and the table is that long', CREW.length, 4);
  eq('A3 every id is unique', new Set(CREW.map((c) => c.id)).size, 4);
  eq('A4 every name is', new Set(CREW.map((c) => c.name)).size, 4);
  eq('A5 and every tint', new Set(CREW.map((c) => c.tint)).size, 4);
  ok('A6 every tint is a real hex', CREW.every((c) => /^#[0-9a-f]{6}$/i.test(c.tint)),
    CREW.map((c) => c.tint).join());
  ok('A7 the table is frozen', Object.isFrozen(CREW));

  /* One keyboard is one keyboard. The first two seats share it; the other two exist only
     over the wire, and that is said as a NULL prefix rather than an empty one. */
  eq('A8 the first seat takes the bare keys', CREW[0].prefix, '');
  eq('A9 the second has its own set', CREW[1].prefix, 'p2');
  eq('A10 the third has no keyboard at all', CREW[2].prefix, null);
  eq('A11 nor the fourth', CREW[3].prefix, null);

  /* ⚠ THE ONE THAT WOULD HAVE COLLAPSED. `readCommand` builds action names as
     `prefix ? prefix + Name : name`, so a null prefix is falsy and reads r1's own keys —
     two crew members on one set of WASD. */
  const inp = makeBotInput();
  inp.hold('moveRight');
  inp.tap('use');
  const r1 = readCommand(inp, CREW[0].prefix);
  const r3 = readCommand(inp, CREW[2].prefix);
  eq('A12 r1 reads the keyboard', r1.axis.x, 1);
  eq('A13 and r3 reads nothing from it, despite the prefix being falsy', r3.axis.x, 0);
  eq('A14 not the use key either', r3.use, false);
  ok('A15 which is not what an EMPTY prefix does — that is r1',
    readCommand(inp, '').axis.x === 1);
emit('A done');
}

/* ── B. seating by name ──────────────────────────────────────────────────── */

function sectionB() {
lines.push('--- B. sign a NAMED volunteer on, and off ---');
  const g = freshGame(9100);
  const s = g.state;
  eq('B1 a shift starts with one', s.responders.length, 1);

  const r3 = seatResponder(s, 'r3');
  ok('B2 a specific seat can be filled', !!r3 && r3.id === 'r3');
  eq('B3 without filling the ones before it', s.responders.length, 2);
  eq('B4 and r1 is still first, which state.player depends on', s.responders[0].id, 'r1');
  eq('B5 player is still the same OBJECT as responders[0]', s.player, s.responders[0]);

  eq('B6 seating the same person twice is not two people', seatResponder(s, 'r3'), r3);
  eq('B7 and the crew is still two', s.responders.length, 2);

  seatResponder(s, 'r2'); seatResponder(s, 'r4');
  eq('B8 all four can be on at once', s.responders.length, 4);
  eq('B9 with four different ids', new Set(s.responders.map((r) => r.id)).size, 4);
  eq('B10 and four different tints', new Set(s.responders.map((r) => r.tint)).size, 4);
  eq('B11 a fifth is refused', seatResponder(s, 'r5'), null);
  eq('B12 and nothing was added for it', s.responders.length, 4);
  eq('B13 a name that is not a crew slot is refused', seatResponder(s, 'nobody'), null);

  eq('B14 a named volunteer can be signed off', unseatResponder(s, 'r3'), true);
  eq('B15 leaving the others alone', s.responders.map((r) => r.id).join(), 'r1,r2,r4');
  eq('B16 signing off somebody who is not on is not an error', unseatResponder(s, 'r3'), false);
  eq('B17 and r1 is the shift — they cannot leave it', unseatResponder(s, 'r1'), false);
  eq('B18 so the crew is unchanged', s.responders.length, 3);

  /* ⚠ THE P KEY MUST NOT SIGN OFF SOMEBODY ON ANOTHER CONTINENT. It used to pop the LAST
     responder, which with a networked crew is whoever joined most recently. */
  for (const r of s.responders) if (r.id !== 'r1') r.remote = true;
  const before = s.responders.length;
  toggleCoop(s);
  eq('B19 P does nothing when every other seat is a remote volunteer', s.responders.length, before);
  ok('B20 and specifically has not signed off the last one to join',
    s.responders.some((r) => r.id === 'r4'));

  unseatResponder(s, 'r4');
  s.responders.find((r) => r.id === 'r2').remote = false;
  toggleCoop(s);
  eq('B21 but it does sign off the one sharing this keyboard', s.responders.map((r) => r.id).join(), 'r1');
  eq('B22 and brings them back', toggleCoop(s), true);
  eq('B23 as r2, the seat with the second key set', s.responders[1].id, 'r2');
emit('B done');
}

/* ── C. four over one host ───────────────────────────────────────────────── */

function sectionC() {
lines.push('--- C. three volunteers join a host, and a fourth is turned away ---');
  const { host, net, clients } = crewOf(3, 9200);
  const s = host.state;

  eq('C1 the host is hosting', net.role, ROLE.HOST);
  eq('C2 and has three seats filled', net.seats.size, 3);
  eq('C3 so the crew is four', s.responders.length, 4);
  eq('C4 all with different ids', new Set(s.responders.map((r) => r.id)).size, 4);
  ok('C5 the three who joined are all marked remote',
    s.responders.filter((r) => r.remote).length === 3);
  ok('C6 and the host is not', !s.responders[0].remote);

  const welcomed = clients.map((c) => (c.welcomes.find((m) => m.t === MSG.WELCOME) || {}).id);
  eq('C7 each was told which volunteer they are', welcomed.filter(Boolean).length, 3);
  eq('C8 and no two were told the same', new Set(welcomed).size, 3);
  ok('C9 none of them was told they are the host', !welcomed.includes('r1'), welcomed.join());
  ok('C10 each got a token to buy their seat back with',
    clients.every((c) => !!(c.welcomes.find((m) => m.t === MSG.WELCOME) || {}).token));
  eq('C11 and the tokens are all different',
    new Set(clients.map((c) => c.welcomes.find((m) => m.t === MSG.WELCOME).token)).size, 3);

  // a fourth volunteer
  const [hl4, cl4] = loopbackPair();
  net.accept(hl4);
  const got4 = [];
  cl4.onMessage = (m) => got4.push(m);
  cl4.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
  eq('C12 a fifth pair of hands is turned away', s.responders.length, 4);
  ok('C13 and told why, rather than left hanging',
    got4.some((m) => m.t === MSG.BYE && m.reason === 'full'), JSON.stringify(got4));
  ok('C14 the host says so too', /full/.test(net.status), net.status);
  emit('running C');

  /* ⚠ A COMMAND IS ATTRIBUTED TO THE LINK IT ARRIVED ON. The pair version read a single
     `remoteResponderId`, so with three clients every command would have driven the same
     body — and trusting an id inside the message would let one volunteer drive another. */
  const ids = clients.map((c) => c.welcomes.find((m) => m.t === MSG.WELCOME).id);
  const walkEast = { ...EMPTY_COMMAND, axis: { x: 1, y: 0 }, drive: { throttle: 0, steer: 0 } };
  const walkWest = { ...EMPTY_COMMAND, axis: { x: -1, y: 0 }, drive: { throttle: 0, steer: 0 } };

  const before = Object.fromEntries(s.responders.map((r) => [r.id, r.x]));
  // A real command, built by the encoder the client actually uses.
  clients[1].cl.send({ ...encodeCommand(walkEast), v: PROTOCOL_VERSION });
  for (let i = 0; i < 30; i++) host.frame(STEP, null);
  const moved = s.responders.filter((r) => Math.abs(r.x - before[r.id]) > 0.05).map((r) => r.id);
  eq('C15 exactly one volunteer moved', moved.length, 1, moved.join());
  eq('C16 and it was the one whose link sent it', moved[0], ids[1]);

  // and a command that lies about who it is from
  const was = Object.fromEntries(s.responders.map((r) => [r.id, r.x]));
  clients[2].cl.send({ ...encodeCommand(walkWest), v: PROTOCOL_VERSION, id: ids[0] });
  for (let i = 0; i < 30; i++) host.frame(STEP, null);
  ok('C17 a command naming somebody else does not drive them',
    Math.abs(s.responders.find((r) => r.id === ids[0]).x - was[ids[0]]) < 0.05,
    `${f(was[ids[0]], 2)} -> ${f(s.responders.find((r) => r.id === ids[0]).x, 2)}`);
  ok('C18 it drives the sender, because that is who sent it',
    Math.abs(s.responders.find((r) => r.id === ids[2]).x - was[ids[2]]) > 0.05,
    `${f(was[ids[2]], 2)} -> ${f(s.responders.find((r) => r.id === ids[2]).x, 2)}`);

  // one snapshot, everybody
  for (const c of clients) c.welcomes.length = 0;
  net.pump(1000, null);
  const snaps = clients.map((c) => c.welcomes.filter((m) => m.t === MSG.SNAP).length);
  eq('C19 one pump sends one snapshot to every seat', snaps.join(), '1,1,1');
  const bodies = clients.map((c) => JSON.stringify(c.welcomes.find((m) => m.t === MSG.SNAP).rs));
  eq('C20 and it is the same town for all of them', new Set(bodies).size, 1);
  eq('C21 carrying all four of them', JSON.parse(bodies[0]).length, 4);
emit('C done');
}

/* ── D. drops, and coming back ───────────────────────────────────────────── */

function sectionD() {
lines.push('--- D. a drop is not a departure, and neither is it for ever ---');
  const { host, net, clients } = crewOf(2, 9300);
  const s = host.state;
  const ids = clients.map((c) => c.welcomes.find((m) => m.t === MSG.WELCOME).id);
  const tokens = clients.map((c) => c.welcomes.find((m) => m.t === MSG.WELCOME).token);

  // give the second volunteer something to be holding
  const victim = s.responders.find((r) => r.id === ids[1]);
  const tool = s.tools.find((t) => t.defId === 'medkit');
  tool.carrier = victim.id; victim.toolId = tool.id;

  clients[1].cl.close();
  eq('D1 the crew is unchanged while the seat is held', s.responders.length, 3);
  eq('D2 and their kit is still theirs', tool.carrier, victim.id);
  eq('D3 the seat is still in the map', net.seats.has(ids[1]), true);
  ok('D4 with nothing on the other end of it', !net.seats.get(ids[1]).link);
  ok('D5 the host says they dropped, not that they left', /dropped/.test(net.status), net.status);

  // they come back, with their token
  const [hl, cl] = loopbackPair();
  net.accept(hl);
  const back = [];
  cl.onMessage = (m) => back.push(m);
  cl.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, token: tokens[1] });
  eq('D6 the token buys back the same volunteer',
    (back.find((m) => m.t === MSG.WELCOME) || {}).id, ids[1]);
  eq('D7 and the crew never changed size', s.responders.length, 3);
  eq('D8 with their kit still in their hands', tool.carrier, victim.id);
  ok('D9 and the link is live again', !!net.seats.get(ids[1]).link);
  ok('D10 the host says so', /back/.test(net.status), net.status);
  emit('running D');

  // a token nobody recognises is just a new volunteer
  const [hl2, cl2] = loopbackPair();
  net.accept(hl2);
  const other = [];
  cl2.onMessage = (m) => other.push(m);
  cl2.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, token: 'r2-NOTAREALTOKEN' });
  const w = other.find((m) => m.t === MSG.WELCOME);
  ok('D11 an unrecognised token gets a seat of its own, not somebody else\'s',
    !!w && !ids.includes(w.id), JSON.stringify(w));
  eq('D12 which fills the crew', s.responders.length, 4);

  // and a seat nobody reclaims eventually goes
  clients[0].cl.close();
  eq('D13 held at first', s.responders.length, 4);
  for (let t = 0; t < CONFIG.net.reconnectGraceMs + 500; t += 100) net.pump(100, null);
  eq('D14 but a seat nobody comes back to is given up', s.responders.length, 3);
  eq('D15 and released from the map', net.seats.has(ids[0]), false);
  ok('D16 the host says they did not come back', /did not come back/.test(net.status), net.status);

  /* The grace runs on REAL time. A game paused because somebody alt-tabbed does not make
     the person on the other end come back faster, and a shift that ends does not either. */
  const held = net.seats.size;
  host.togglePause();
  for (let t = 0; t < 1000; t += 100) net.pump(100, null);
  host.togglePause();
  eq('D17 and it runs whether or not the town is stepping', net.seats.size, held);
emit('D done');
}

/* ── E. four people, still one wheel ─────────────────────────────────────── */

function sectionE() {
lines.push('--- E. contention is a property of the data, and four does not change that ---');
  const g = freshGame(9400);
  const s = g.state;
  for (const id of ['r2', 'r3', 'r4']) { const r = seatResponder(s, id); r.remote = true; }
  eq('E1 four on the crew', s.responders.length, 4);

  const ap = s.apparatus[0];
  for (const r of s.responders) { r.x = ap.x; r.y = ap.y; }
  for (const r of s.responders) {
    if (!ap.driverId) ap.driverId = r.id;
    ap.passengerIds.push(r.id);
    r.inVehicleId = ap.id;
  }
  eq('E2 all four can be in the cab', ap.passengerIds.length, 4);
  eq('E3 but only one of them is driving it', ap.driverId, 'r1');

  /* ⚠ A VEHICLE IS STEPPED ONCE, BY ITS DRIVER. With two people this was already
     asserted; with four, stepping per occupant would make a truck go four times as fast. */
  const inp = makeBotInput();
  inp.hold('moveUp');
  const x0 = ap.x, y0 = ap.y;
  for (let i = 0; i < 60; i++) g.frame(STEP, inp);
  const moved4 = Math.hypot(ap.x - x0, ap.y - y0);

  const h = freshGame(9400);
  const hs = h.state;
  const hap = hs.apparatus[0];
  hs.player.x = hap.x; hs.player.y = hap.y;
  hs.player.inVehicleId = hap.id; hap.driverId = hs.player.id; hap.passengerIds = [hs.player.id];
  const inp2 = makeBotInput();
  inp2.hold('moveUp');
  const hx0 = hap.x, hy0 = hap.y;
  for (let i = 0; i < 60; i++) h.frame(STEP, inp2);
  const moved1 = Math.hypot(hap.x - hx0, hap.y - hy0);
  lines.push(`      one second of throttle: four aboard ${f(moved4, 2)} m, one aboard ${f(moved1, 2)} m`);
  ok('E4 a truck with four people in it is not four times as fast',
    Math.abs(moved4 - moved1) < 0.05, `${f(moved4, 3)} vs ${f(moved1, 3)}`);

  // one nozzle, one patient
  const g2 = freshGame(9401);
  const s2 = g2.state;
  for (const id of ['r2', 'r3', 'r4']) seatResponder(s2, id);
  const hose = s2.tools.find((t) => t.defId === 'hose');
  hose.carrier = 'r2';
  eq('E5 a tool in somebody\'s hands has exactly one carrier', hose.carrier, 'r2');
  const v = createVictim({ incidentId: null, x: 100, y: 100, severity: 'injured' });
  v.draggedBy = 'r3';
  s2.victims.push(v);
  eq('E6 and a casualty exactly one pair of hands', v.draggedBy, 'r3');
  unseatResponder(s2, 'r3');
  eq('E7 signing that person off puts the casualty down', v.draggedBy, null);
  eq('E8 and does not touch anybody else\'s kit', hose.carrier, 'r2');

  // the town steps once, whatever the crew size
  const four = freshGame(9402);
  for (const id of ['r2', 'r3', 'r4']) seatResponder(four.state, id);
  for (let i = 0; i < 120; i++) four.frame(STEP, null);
  const one = freshGame(9402);
  for (let i = 0; i < 120; i++) one.frame(STEP, null);
  eq('E9 two seconds of town is two seconds of town, whoever is on shift',
    four.state.simTimeMs, one.state.simTimeMs);
  eq('E10 and the dispatcher is not calling four times as often',
    four.state.incidents.length, one.state.incidents.length);
emit('E done');
}

/* ── G. and does four of them actually play ──────────────────────────────── */

function sectionG() {
lines.push('--- G. four hands on a real shift (GDD Phase 5 gate, extended) ---');

  /* Phase 5's exit gate is "coordination improves outcomes while miscommunication creates
   * recoverable stories", and m5 proves it for two. Four is not automatically better: a
   * town with seven calls and three trucks can absorb a fourth pair of hands or it can
   * simply have four people standing at the same fire. This is the measurement. */
  const shift = (crew, seed) => {
    clearSave();
    const g = new Game({ seed });
    g.startShift();
    const s = g.state;
    const board = { claims: new Map(), trucks: new Map() };
    for (const id of ['r2', 'r3', 'r4'].slice(0, crew - 1)) seatResponder(s, id);
    const bots = s.responders.map((r) => new CrewBot(g, r.id, crew > 1 ? board : null));
    bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : `p${i + 1}`); });

    /* ⚠ THE FIRST VERSION OF THIS MEASURED ONE BOT, THREE TIMES, and every assertion
     * passed: crews of one, two and four all reported "2 controlled · 12 lost · 28%",
     * identical to the digit, because the comparisons were all "not worse than". Two
     * separate wiring mistakes, both silent — only bots[0].input was ever handed to
     * frame(), so the second seat's keyboard was never read; and the remote seats were
     * read back with a bare prefix while the bot had written 'p3'-prefixed actions, so
     * their commands were empty every step.
     *
     * A crew-size comparison in which the sizes come out EQUAL is not a result. */
    const keyboardSeats = bots.slice(0, Math.min(2, bots.length));
    const kb = keyboardSeats.length > 1
      ? mergeBotInputs(keyboardSeats.map((b) => b.input)) : keyboardSeats[0].input;

    const travelled = {};
    let last = Object.fromEntries(s.responders.map((r) => [r.id, { x: r.x, y: r.y }]));
    for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
      for (const b of bots) b.think();
      // Seats past the second have no keyboard: their bot drives them as a remote
      // command, which is exactly the path a networked volunteer takes.
      for (let i = 2; i < bots.length; i++) {
        s.responders[i].remote = true;
        g.setRemoteCommand(s.responders[i].id,
          encodeCommand(readCommand(bots[i].input, `p${i + 1}`)));
      }
      g.frame(STEP, kb);
      for (const r of s.responders) {
        const p = last[r.id];
        if (p) travelled[r.id] = (travelled[r.id] || 0) + Math.hypot(r.x - p.x, r.y - p.y);
        last[r.id] = { x: r.x, y: r.y };
      }
      if (s.mode !== MODES.PLAYING) break;
    }
    if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
    /* How far each seat actually walked. Without this, "four scored the same as two" is
       indistinguishable between the interesting answer (a fourth pair of hands has nothing
       left to claim) and the boring one (seats 3 and 4 were never wired up) — and the
       first version of this harness was the boring one. */
    return { report: s.report, walked: s.responders.map((r) => Math.round(travelled[r.id] || 0)) };
  };

  const rows = [];
  for (const crew of [1, 2, 4]) {
    let controlled = 0, lost = 0, reached = 0, conf = 0, ran = 0;
    let walked = null;
    for (const seed of [101, 303]) {
      const { report: r, walked: w } = shift(crew, seed);
      controlled += r.controlled; lost += r.lost;
      reached += r.patientsSaved; conf += r.confidenceEnd;
      ran += r.durationMs >= CONFIG.shift.durationMs ? 1 : 0;
      walked = walked ? walked.map((v, i) => v + w[i]) : w;
      emit(`running G, crew of ${crew}, seed ${seed}`);
    }
    rows.push({ crew, controlled, lost, reached, conf: conf / 2, ran, walked });
  }
  for (const r of rows) {
    lines.push(`      crew of ${r.crew}: ${r.controlled} controlled · ${r.lost} lost · ` +
      `${r.reached} to the clinic · confidence ${f(r.conf * 100, 0)}% · ` +
      `each walked ${r.walked.join('/')} m`);
  }

  eq('G1 every shift ran to the end, whatever the crew size',
    rows.reduce((n, r) => n + r.ran, 0), 6);

  /* ⚠ FIRST, THAT THE MEASUREMENT MEASURES ANYTHING. Three crew sizes reporting the same
     numbers to the digit is a wiring bug, not a finding — and every "not worse than"
     comparison below passes happily on it. This assertion is the one that failed when
     the harness above was wrong, and it is the reason the rest can be trusted. */
  const fingerprint = rows.map((r) => `${r.controlled}/${r.lost}/${r.reached}/${f(r.conf, 3)}`);
  gt('G2 the crew size changes the shift at all — three identical rows is a broken test',
    new Set(fingerprint).size, 1, fingerprint.join('  '));

  const solo = rows[0], pair = rows[1], four = rows[2];
  const score = (r) => r.controlled + r.reached;
  gt('G3 two beat one, which is the Phase 5 gate m5 already holds', score(pair), score(solo));
  gt('G4 and four beat one', score(four), score(solo));
  ok('G5 four people do not simply all stand at the same fire',
    score(four) >= score(pair), `four ${score(four)} vs two ${score(pair)}`);
  gt('G6 and the town is better off for them than for one', four.conf, solo.conf);

  /* The other half of "is this measuring anything": every seat has to have DONE something.
     Four scoring the same as two is a legitimate finding — three trucks and a shared claims
     board is only so much work to go round — but it is only a finding if seats three and
     four were on their feet. */
  ok('G7 every one of the four actually moved', four.walked.every((m) => m > 20),
    four.walked.join('/'));
  gt('G8 including the two with no keyboard, driven entirely by remote commands',
    Math.min(four.walked[2], four.walked[3]), 20, four.walked.join('/'));
emit('G done');
}

/* ── F. what a client sees, and what it costs ────────────────────────────── */

function sectionF() {
lines.push('--- F. a client with four people in the town ---');
  const { host, net } = crewOf(3, 9500);
  const hs = host.state;

  const client = freshGame(9501);
  const snap = JSON.parse(JSON.stringify(encodeSnapshot(hs)));
  eq('F1 the snapshot applies', applySnapshot(client.state, snap), true);
  eq('F2 the client has all four', client.state.responders.length, 4);

  /* ⚠ THE DECODER BRANCHED ON 'r2'. Anybody who was not r2 got the HOST's own colour and
     the name "You" — two people in the same coat, one of them yours. */
  const tints = client.state.responders.map((r) => r.tint);
  eq('F3 each of them in their own colour', new Set(tints).size, 4, tints.join());
  eq('F4 and with their own name',
    new Set(client.state.responders.map((r) => r.name)).size, 4);
  ok('F5 nobody but the first is called "You"',
    client.state.responders.filter((r) => r.name === 'You').length === 1,
    client.state.responders.map((r) => `${r.id}:${r.name}`).join());
  ok('F6 and the tints are the ones the crew table declares',
    client.state.responders.every((r) => (CREW.find((c) => c.id === r.id) || {}).tint === r.tint));

  const bytes = JSON.stringify(snap).length;
  const perHead = JSON.stringify(snap.rs).length / 4;
  lines.push(`      snapshot with four on the crew: ${bytes} B, ${f(perHead, 0)} B a volunteer`);
  le('F7 four crew is still a sensible packet', bytes, 8192);
  le('F8 and a volunteer is not expensive', perHead, 160);

  // the host's own cost
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) { host.frame(STEP, null); net.pump(STEP, null); }
  const t1 = performance.now();
  lines.push(`      hosting four: ${f((t1 - t0) / 600, 4)} ms a frame, ` +
    `simulation and broadcast together`);
  le('F9 hosting four people costs a fraction of a frame', (t1 - t0) / 600, 4);
  eq('F10 and nothing went non-finite doing it', nonFinite(hs), 0);

  net.leave();
  eq('F11 the host leaving signs everybody off', hs.responders.length, 1);
  eq('F12 and empties the seat map', net.seats.size, 0);
  eq('F13 and is back to solo', net.role, ROLE.SOLO);
emit(null);
}

function nonFinite(root) {
  let bad = 0;
  const seen = new Set();
  const walk = (o, d) => {
    if (d > 6 || !o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const v of Object.values(o)) {
      if (typeof v === 'number') { if (!Number.isFinite(v)) bad++; }
      else if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(root, 0);
  return bad;
}

/* ── go ──────────────────────────────────────────────────────────────────── */
try {
  sectionA(); sectionB(); sectionC(); sectionD(); sectionE(); sectionG(); sectionF();
} catch (err) {
  fails++;
  lines.push(`FAIL  suite threw: ${err && err.message}`);
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 8).join('\n'));
  emit(`FAILURES  ${fails} of ${passes + fails}`);
}
