/* The wire format. PURE — no transport, no sockets, no browser.
 *
 * GDD: "plan for an authoritative host simulation with clients sending input intent."
 * So there are exactly two kinds of message that matter:
 *
 *   client -> host   CMD   one responder's intent for a frame. The same object
 *                          game.js already builds from the keyboard, so a remote
 *                          player is indistinguishable from a local one to the
 *                          simulation. That is the whole point of routing every
 *                          responder through readCommand().
 *   host -> client   SNAP  what the town looks like now. The client does not run
 *                          the simulation at all; it draws this.
 *
 * Keeping encode/decode in a module with no dependencies on the network is what makes
 * the netcode testable: tools/m3-tests.js round-trips a live town through here and
 * drives a whole host+client pair over a loopback link, with no WebRTC in sight.
 */

import { BUILDING_BY_ID } from '../data/town.js';
import { buildFireCells } from '../sim/hazards.js';

export const MSG = Object.freeze({
  HELLO: 'hello',     // client -> host, on connect
  WELCOME: 'welcome', // host -> client, "you are r2"
  CMD: 'cmd',
  SNAP: 'snap',
  BYE: 'bye',
});

export const PROTOCOL_VERSION = 1;

/* ── numbers ──────────────────────────────────────────────────────────────
 * Everything positional is quantised to centimetres and sent as an integer. A town
 * 420 m across needs 5 digits; the float would have cost 17. Nothing in this game is
 * decided on sub-centimetre differences.
 */
const q = (v) => Math.round((v || 0) * 100);
const u = (v) => (v || 0) / 100;
const q3 = (v) => Math.round((v || 0) * 1000);   // angles, 0..1 fractions
const u3 = (v) => (v || 0) / 1000;

/* ── fire cells ───────────────────────────────────────────────────────────
 * One byte per cell as two hex characters: two flag bits and four bits of heat.
 * The feed store is 60 cells, so a fully involved building costs 120 characters —
 * small enough to send whole every snapshot and never think about deltas.
 */
export function packCells(cells) {
  let s = '';
  for (const c of cells) {
    const heat = Math.max(0, Math.min(15, Math.round((c.heat || 0) * 8)));
    const byte = (c.burning ? 1 : 0) | (c.burnt ? 2 : 0) | ((c.wet > 0.3) ? 4 : 0) | (heat << 3);
    s += byte.toString(16).padStart(2, '0');
  }
  return s;
}

export function unpackCells(cells, packed) {
  for (let i = 0; i < cells.length; i++) {
    const byte = parseInt(packed.substr(i * 2, 2), 16) || 0;
    const c = cells[i];
    c.burning = !!(byte & 1);
    c.burnt = !!(byte & 2);
    c.wet = (byte & 4) ? 1 : 0;
    c.heat = (byte >> 3) / 8;
  }
  return cells;
}

/* ── snapshot ─────────────────────────────────────────────────────────────── */

/**
 * Everything a client needs to draw the town and fill in its HUD.
 *
 * Deliberately a FULL snapshot rather than a delta. Two players, a town of a few
 * hundred entities, and a reliable ordered channel: at 12 Hz this is a few KB a second,
 * and delta compression would be a pile of state-tracking bugs bought with bandwidth
 * nobody is short of.
 */
export function encodeSnapshot(state) {
  return {
    t: MSG.SNAP,
    v: PROTOCOL_VERSION,
    ms: Math.round(state.simTimeMs),
    mode: state.mode,
    coop: !!state.coop,
    rs: state.responders.map((r) => ({
      i: r.id, x: q(r.x), y: q(r.y), f: q3(r.facing),
      v: r.inVehicleId || 0, tl: r.toolId || 0, dg: r.draggingVictimId || 0,
      st: Math.round(r.stunMs), so: q3(r.soot), up: Math.round(r.useProgressMs),
      ib: r.insideBuildingId || 0,
    })),
    ap: state.apparatus.map((a) => ({
      i: a.id, x: q(a.x), y: q(a.y), a: q3(a.angle), s: q3(a.speed),
      si: a.siren ? 1 : 0, dm: q3(a.damage), w: Math.round(a.waterL),
      hy: a.hydrantId || 0, pt: a.patientId || 0, dr: a.driverId || 0,
      ps: a.passengerIds.slice(),
    })),
    tl: state.tools.map((t) => ({
      i: t.id, c: t.carrier || 0, x: q(t.x), y: q(t.y),
      fl: t.flowing ? 1 : 0, ch: t.chargeL == null ? -1 : q3(t.chargeL),
    })),
    vc: state.victims.map((v) => ({
      i: v.id, x: q(v.x), y: q(v.y), c: q3(v.condition), sv: v.severity,
      tb: v.trappedBy || 0, db: v.draggedBy || 0, ia: v.inApparatusId || 0,
      d: v.delivered ? 1 : 0, l: v.lost ? 1 : 0, nt: v.needsTransport ? 1 : 0,
      ic: v.incidentId || 0,
    })),
    hz: state.hazards.map((h) => encodeHazard(h)),
    in: state.incidents.map((i) => ({
      i: i.id, h: i.headline, p: i.place, pr: i.priority, s: i.status,
      d: q3(i.danger), r: i.report, x: q(i.x), y: q(i.y), a: Math.round(i.ageMs),
      f: i.family, vi: i.victimIds.slice(), hi: i.hazardIds.slice(),
      ew: i.everWorked ? 1 : 0, bi: i.buildingId || 0,
    })),
    tw: {
      cf: q3(state.town.confidence),
      sn: state.town.shiftNumber,
      bd: Object.fromEntries(Object.entries(state.town.buildings)
        .map(([k, r]) => [k, [q3(r.damage), r.boardedShifts]])),
      hd: Object.keys(state.town.hydrants).filter((k) => state.town.hydrants[k].damaged),
    },
    rd: state.radio.slice(-6).map((l) => [Math.round(l.atMs), l.kind, l.text]),
  };
}

function encodeHazard(h) {
  const base = { i: h.id, k: h.kind, ic: h.incidentId || 0, rs: h.resolved ? 1 : 0 };
  if (h.kind === 'fire') return { ...base, b: h.buildingId, bc: h.burningCount, cl: packCells(h.cells) };
  if (h.kind === 'gas') return { ...base, x: q(h.x), y: q(h.y), pm: q3(h.ppm), so: h.shutOff ? 1 : 0, b: h.buildingId };
  if (h.kind === 'power') return { ...base, x: q(h.x), y: q(h.y), lv: h.live ? 1 : 0, rd: q3(h.radiusM), pl: h.poleId };
  if (h.kind === 'tree') return { ...base, x: q(h.x), y: q(h.y), ct: q3(h.cut), cd: h.cleared ? 1 : 0, rd: q3(h.radiusM) };
  return { ...base, x: q(h.x), y: q(h.y), a: q3(h.angle), bn: h.burning ? 1 : 0,
    fl: q3(h.fuelLeak), kt: h.kindTag, rd: q3(h.radiusM) };
}

/**
 * Write a snapshot into a state object, in place.
 *
 * In place, and reusing existing entities where the ids match, because the renderer
 * and the HUD hold no references across frames but the CAMERA does — rebuilding the
 * responder array every 80 ms would make the camera jump to a new object each time.
 */
export function applySnapshot(state, snap) {
  if (!snap || snap.v !== PROTOCOL_VERSION) return false;
  state.simTimeMs = snap.ms;
  state.mode = snap.mode;
  state.coop = !!snap.coop;

  syncList(state.responders, snap.rs, (d) => ({ id: d.i }), (r, d) => {
    r.x = u(d.x); r.y = u(d.y); r.facing = u3(d.f);
    r.inVehicleId = d.v || null; r.toolId = d.tl || null;
    r.draggingVictimId = d.dg || null; r.stunMs = d.st; r.soot = u3(d.so);
    r.useProgressMs = d.up; r.insideBuildingId = d.ib || null;
    if (!r.tint) { r.tint = d.i === 'r2' ? '#5fd0f0' : '#f6c445'; r.name = d.i === 'r2' ? 'Partner' : 'You'; }
  });

  syncList(state.apparatus, snap.ap, (d) => ({ id: d.i, defId: d.i }), (a, d) => {
    a.x = u(d.x); a.y = u(d.y); a.angle = u3(d.a); a.speed = u3(d.s);
    a.siren = !!d.si; a.damage = u3(d.dm); a.waterL = d.w;
    a.hydrantId = d.hy || null; a.patientId = d.pt || null;
    a.driverId = d.dr || null; a.passengerIds = d.ps || [];
  });

  syncList(state.tools, snap.tl, (d) => ({ id: d.i }), (t, d) => {
    t.carrier = d.c || null; t.x = u(d.x); t.y = u(d.y);
    t.flowing = !!d.fl; if (d.ch >= 0) t.chargeL = u3(d.ch);
  });

  syncList(state.victims, snap.vc, (d) => ({ id: d.i }), (v, d) => {
    v.x = u(d.x); v.y = u(d.y); v.condition = u3(d.c); v.severity = d.sv;
    v.trappedBy = d.tb || null; v.draggedBy = d.db || null;
    v.inApparatusId = d.ia || null; v.delivered = !!d.d; v.lost = !!d.l;
    v.needsTransport = !!d.nt; v.incidentId = d.ic || null;
  });

  syncList(state.hazards, snap.hz, (d) => makeHazardShell(d), (h, d) => applyHazard(h, d));

  syncList(state.incidents, snap.in, (d) => ({ id: d.i, updates: [], consequences: [] }), (i, d) => {
    i.headline = d.h; i.place = d.p; i.priority = d.pr; i.status = d.s;
    i.danger = u3(d.d); i.report = d.r; i.x = u(d.x); i.y = u(d.y);
    i.ageMs = d.a; i.family = d.f; i.victimIds = d.vi || []; i.hazardIds = d.hi || [];
    i.everWorked = !!d.ew; i.buildingId = d.bi || null;
  });

  state.town.confidence = u3(snap.tw.cf);
  state.town.shiftNumber = snap.tw.sn;
  state.town.buildings = Object.fromEntries(Object.entries(snap.tw.bd)
    .map(([k, [dmg, boarded]]) => [k, { damage: u3(dmg), boardedShifts: boarded, timesBurned: 0 }]));
  state.town.hydrants = Object.fromEntries((snap.tw.hd || []).map((k) => [k, { damaged: true }]));

  state.radio = (snap.rd || []).map(([atMs, kind, text]) => ({ atMs, kind, text }));
  return true;
}

/** Keep the array's identity and reuse entries by id; add and remove as needed. */
function syncList(list, incoming, make, fill) {
  const byId = new Map(list.map((e) => [e.id, e]));
  const seen = new Set();
  for (const d of incoming) {
    let e = byId.get(d.i);
    if (!e) { e = make(d); list.push(e); }
    fill(e, d);
    seen.add(d.i);
  }
  for (let i = list.length - 1; i >= 0; i--) if (!seen.has(list[i].id)) list.splice(i, 1);
  return list;
}

function makeHazardShell(d) {
  const h = { id: d.i, kind: d.k };
  if (d.k === 'fire') {
    // Cell POSITIONS are derivable from the building, so only their states travel.
    const grid = buildFireCells(BUILDING_BY_ID[d.b]);
    h.buildingId = d.b; h.cells = grid.cells; h.cols = grid.cols; h.rows = grid.rows;
  }
  if (d.k === 'wreck') h.occupantIds = [];
  return h;
}

function applyHazard(h, d) {
  h.incidentId = d.ic || null;
  h.resolved = !!d.rs;
  if (d.k === 'fire') { h.burningCount = d.bc; unpackCells(h.cells, d.cl); return; }
  h.x = u(d.x); h.y = u(d.y);
  if (d.k === 'gas') { h.ppm = u3(d.pm); h.shutOff = !!d.so; h.buildingId = d.b; return; }
  if (d.k === 'power') { h.live = !!d.lv; h.radiusM = u3(d.rd); h.poleId = d.pl; return; }
  if (d.k === 'tree') { h.cut = u3(d.ct); h.cleared = !!d.cd; h.radiusM = u3(d.rd); return; }
  h.angle = u3(d.a); h.burning = !!d.bn; h.fuelLeak = u3(d.fl);
  h.kindTag = d.kt; h.radiusM = u3(d.rd);
}

/* ── commands ─────────────────────────────────────────────────────────────
 * Short keys because this goes up sixty times a second and there is no reason for it
 * to be readable on the wire; it is readable HERE.
 */
export function encodeCommand(cmd) {
  return {
    t: MSG.CMD,
    a: [q3(cmd.axis.x), q3(cmd.axis.y)],
    d: [q3(cmd.drive.throttle), q3(cmd.drive.steer)],
    m: cmd.aim ? [q(cmd.aim.x), q(cmd.aim.y)] : 0,
    i: cmd.interact ? 1 : 0,
    p: cmd.drop ? 1 : 0,
    u: cmd.use ? 1 : 0,
    s: cmd.siren ? 1 : 0,
    l: cmd.slot == null ? -1 : cmd.slot,
  };
}

export function decodeCommand(m) {
  return {
    axis: { x: u3(m.a[0]), y: u3(m.a[1]) },
    drive: { throttle: u3(m.d[0]), steer: u3(m.d[1]) },
    aim: m.m ? { x: u(m.m[0]), y: u(m.m[1]) } : null,
    interact: !!m.i, drop: !!m.p, use: !!m.u, siren: !!m.s,
    slot: m.l < 0 ? null : m.l,
  };
}

export const EMPTY_COMMAND = Object.freeze({
  axis: { x: 0, y: 0 }, drive: { throttle: 0, steer: 0 }, aim: null,
  interact: false, drop: false, use: false, siren: false, slot: null,
});
