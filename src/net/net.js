/* Transport and session. GDD Phase 5: "an authoritative host simulation with clients
 * sending input intent."
 *
 * Copied in shape from Chameleon's mpHost/mpJoin (Dev\INDEX.md -> Multiplayer): PeerJS
 * over WebRTC, a five-character room code as the peer id, the public broker for
 * signalling only. Names kept so the lineage stays greppable.
 *
 * THE AUTHORITY RULE, stated once: the host's simulation is the game. A client sends
 * commands and draws snapshots; it never steps the world, so it cannot disagree about
 * whether a building burned down. That costs the client a frame or two of input lag and
 * buys the one thing co-op cannot do without — two people who are definitely in the
 * same town.
 *
 * Everything here is behind an interface thin enough to swap for a loopback pair, which
 * is how tools/m3-tests.js drives a whole host+client session with no network at all.
 */

import { MSG, PROTOCOL_VERSION } from './protocol.js';
import { CREW, MAX_CREW } from '../data/crew.js';
import { CONFIG } from '../config.js';

const PEER_OPTS = { host: '0.peerjs.com', port: 443, secure: true, debug: 0 };
const ROOM_PREFIX = 'stes-';

/** Five characters, no letters that can be misheard over a phone. */
export function randCode(rand = Math.random) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += A[Math.floor(rand() * A.length)];
  return c;
}

/* ── links ────────────────────────────────────────────────────────────────
 * A Link is anything with send(msg), onMessage, onOpen, onClose, close(). Two
 * implementations: PeerJS for real play, and a loopback pair for tests.
 */

export function loopbackPair({ latencyMs = 0, schedule = null } = {}) {
  const deliver = schedule || ((fn) => fn());
  const a = makeEndpoint(), b = makeEndpoint();
  a._peer = b; b._peer = a;

  function makeEndpoint() {
    return {
      open: true, onMessage: null, onOpen: null, onClose: null, sent: 0,
      send(msg) {
        if (!this.open || !this._peer.open) return false;
        this.sent++;
        // structuredClone-ish: JSON round trip, so a test cannot accidentally pass a
        // live object reference between the two sides and prove nothing.
        const wire = JSON.parse(JSON.stringify(msg));
        const target = this._peer;
        deliver(() => { if (target.open && target.onMessage) target.onMessage(wire); }, latencyMs);
        return true;
      },
      close() {
        if (!this.open) return;
        this.open = false;
        if (this.onClose) this.onClose();
        if (this._peer.open && this._peer.onClose) this._peer.onClose();
      },
    };
  }
  return [a, b];
}

/* ── the session ──────────────────────────────────────────────────────────── */

export const ROLE = Object.freeze({ SOLO: 'solo', HOST: 'host', CLIENT: 'client' });

/**
 * Owns the role, the link, and the pumping. It does NOT own the simulation: game.js
 * still steps the world on the host, and on the client nothing steps at all.
 */
export class NetSession {
  constructor(game, { snapshotHz = 12 } = {}) {
    this.game = game;
    this.role = ROLE.SOLO;
    this.link = null;
    this.code = null;
    this.status = 'offline';
    this.snapshotEveryMs = 1000 / snapshotHz;
    this._sinceSnapMs = 0;
    this.localResponderId = 'r1';
    this.remoteResponderId = null;
    this.lastSnapshot = null;
    this.snapsReceived = 0;
    this.cmdsReceived = 0;
    this.onStatus = null;
    this.peer = null;

    /* HOST: responderId -> { link, token }. One link per volunteer, not one link.
     *
     * Copied in shape from ContainmentDetailWeb\src\net\net.js `seats` (Dev\INDEX.md ->
     * Multiplayer, "squad of N, not a fixed pair"), which is the only implementation of
     * this in the tree and already carries the three things a pair never needs: a seat
     * held open on a drop, a resume token that buys the same body back, and a broadcast
     * instead of a send. Name kept so the lineage stays greppable. */
    this.seats = new Map();
    /** Links we turned away, so the close WE triggered cannot overwrite the reason. */
    this._refused = new WeakSet();
    /** CLIENT: what the host called us, and the token that reclaims this seat. */
    this.token = null;
  }

  /** How many volunteers are on, host included. */
  get crewSize() { return this.game.state.responders.length; }

  /* There was an `onRoster` callback here, publishing who is on the crew and whether their
   * link is live. Nothing consumed it: a host already says it through `_say` ("3 on the
   * crew", "Volunteer 3 dropped — seat held"), and a CLIENT reads the whole crew straight
   * off every snapshot. A hook that is declared, wired and never read is exactly what the
   * accessibility audit spent a section on — it reports as handled. Deleted rather than
   * left for somebody to find. */

  get online() { return this.role !== ROLE.SOLO; }

  _say(status) {
    this.status = status;
    if (this.onStatus) this.onStatus(status, this);
  }

  /* ── host ─────────────────────────────────────────────────────────────── */

  /** Become the host. Idempotent; volunteers are attached one at a time by `accept`. */
  host() {
    this.role = ROLE.HOST;
    this.localResponderId = 'r1';
    this._say('waiting');
    return this;
  }

  /**
   * Attach ONE volunteer's link.
   *
   * The seat is not allocated until their HELLO arrives, because only then do we know
   * whether this is somebody new or somebody coming back — and a seat held open for a
   * dropped volunteer is the whole reason this is a Map rather than a field.
   */
  accept(link) {
    if (this.role !== ROLE.HOST) this.host();
    link.onMessage = (m) => this._hostOnMessage(link, m);
    link.onClose = () => this._seatDropped(link);
    return link;
  }

  /** Kept so every existing caller and test that attached a single partner still works. */
  hostOn(link) { this.host(); this.remoteResponderId = 'r2'; return this.accept(link) && this; }

  _seatOf(link) {
    for (const [id, seat] of this.seats) if (seat.link === link) return { id, seat };
    return null;
  }

  _hostOnMessage(link, m) {
    /* Everything past this line came off somebody else's machine. A message that throws
       here takes the host's whole shift with it, and a malformed command used to do
       exactly that — `{t:'cmd'}` with no fields threw straight out of the handler. */
    try { this._hostHandle(link, m); } catch (e) { this._say('ignored a bad message'); }
  }

  _hostHandle(link, m) {
    const s = this.game.state;
    if (!m || typeof m !== 'object') return;

    if (m.t === MSG.HELLO) {
      if (m.v !== PROTOCOL_VERSION) {
        /* Say so AND hang up. Left open, a client on a stale build sat there "connected"
           to a host that would never accept a word from it, hammering the link at 60 Hz
           with commands nobody was going to read. */
        this._refusedVersion = true;
        this._say('version mismatch');
        try { link.send({ t: MSG.BYE, v: PROTOCOL_VERSION, reason: 'version' }); } catch (e) { /* going anyway */ }
        try { link.close(); } catch (e) { /* already gone */ }
        return;
      }

      /* A resume token buys back the EXACT volunteer, with whatever they were holding —
       * the seat was held open and their kit never hit the ground. A ten-minute shift is
       * short enough that a dropped connection is usually the same person reconnecting,
       * and re-seating them as a new volunteer would put a nozzle on the floor for no
       * reason. */
      if (m.token) {
        for (const [id, seat] of this.seats) {
          if (seat.token !== m.token) continue;
          const r = s.responders.find((q) => q.id === id);
          if (!r) break;
          seat.link = link;
          r.remote = true;
          link.send(this._welcome(id, seat.token));
          this._say(`${r.name} is back`);
          return;
        }
      }

      const r = this.game.seatResponder(this._freeSeatId());
      if (!r) {
        link.send({ t: MSG.BYE, v: PROTOCOL_VERSION, reason: 'full' });
        this._say(`crew is full (${MAX_CREW})`);
        /* Hanging up fires our own onClose, and `_seatDropped` finding no seat for it
           reported "a connection closed" — overwriting the reason we had just set. Same
           shape as the version-mismatch close, and the same fix: say why FIRST and mark
           the link, so the close it triggers does not talk over it. */
        this._refused.add(link);
        try { link.close(); } catch (e) { /* fine */ }
        return;
      }
      r.remote = true;
      const token = `${r.id}-${randCode(this._tokenRand())}`;
      this.seats.set(r.id, { link, token });
      this.remoteResponderId = this.remoteResponderId || r.id;
      link.send(this._welcome(r.id, token));
      this._say(this.seats.size > 1 ? `${this.crewSize} on the crew` : 'connected');
      return;
    }

    if (m.t === MSG.CMD) {
      /* Commands were never version-checked, only the hello was — so a peer that had been
         refused, or one that never said hello at all, could still drive a responder. And
         with four seats a command has to be attributed to the LINK that sent it: trusting
         an id in the message would let one volunteer drive another's body. */
      if (m.v !== undefined && m.v !== PROTOCOL_VERSION) return;
      const found = this._seatOf(link);
      if (!found) return;
      this.cmdsReceived++;
      this.game.setRemoteCommand(found.id, m);
      return;
    }

    if (m.t === MSG.BYE) this._seatDropped(link, { deliberate: true });
  }

  _welcome(id, token) {
    return { t: MSG.WELCOME, v: PROTOCOL_VERSION, id, token, crew: MAX_CREW };
  }

  /** The lowest crew slot nobody is sitting in. */
  _freeSeatId() {
    const taken = new Set(this.game.state.responders.map((r) => r.id));
    const slot = CREW.find((c) => c.id !== 'r1' && !taken.has(c.id));
    return slot ? slot.id : null;
  }

  /* Room codes and resume tokens are the one place unpredictability is the point, so this
     is the documented exception to the no-Math.random rule (see src/core/rng.js, and
     tools/m0-tests.js section H2, which allows exactly this file). */
  _tokenRand() { return Math.random; }

  /**
   * A volunteer's link closed.
   *
   * `deliberate` — they pressed leave — signs them off and gives their kit back to the
   * town. A link that merely dropped keeps the seat and the body: they have a token, the
   * shift is ten minutes long, and the overwhelming majority of drops are the same person
   * about to come straight back.
   */
  _seatDropped(link, { deliberate = false } = {}) {
    if (this.role !== ROLE.HOST) { this._say('disconnected'); return; }
    const found = this._seatOf(link);
    if (!found) {
      // A link we ourselves refused already carries its own reason; do not talk over it.
      if (!this._refused.has(link) && !this._refusedVersion) this._say('a connection closed');
      return;
    }
    const s = this.game.state;
    const r = s.responders.find((q) => q.id === found.id);
    this.game.setRemoteCommand(found.id, null);
    if (deliberate) {
      this.seats.delete(found.id);
      this.game.unseatResponder(found.id);
      this._say(r ? `${r.name} signed off` : 'a volunteer signed off');
    } else {
      found.seat.link = null;
      found.seat.droppedMs = 0;
      this._say(r ? `${r.name} dropped — seat held` : 'a volunteer dropped');
    }
  }

  /**
   * A held seat is not held for ever.
   *
   * Run from `pump`, so it is real time and not simulation time — the person reconnecting
   * is in the real world and a paused game does not make them come back faster. Past the
   * grace window the volunteer is signed off exactly as if they had pressed leave, which
   * puts their kit on the ground and their casualty down. Without this the seat-holding
   * fix for one bug reintroduced the older one it replaced: a body standing in the street
   * with the only nozzle for the rest of the shift.
   */
  _expireHeldSeats(dtMs) {
    for (const [id, seat] of [...this.seats]) {
      if (seat.link) continue;
      seat.droppedMs = (seat.droppedMs || 0) + dtMs;
      if (seat.droppedMs < CONFIG.net.reconnectGraceMs) continue;
      const r = this.game.state.responders.find((q) => q.id === id);
      this.seats.delete(id);
      this.game.setRemoteCommand(id, null);
      this.game.unseatResponder(id);
      this._say(r ? `${r.name} did not come back` : 'a volunteer did not come back');
    }
  }

  /** Kept for the pair-shaped callers and tests that predate the seat map. */
  _partnerGone() {
    const first = this.seats.values().next().value;
    if (first) this._seatDropped(first.link || { }, { deliberate: true });
    else this._say(this._refusedVersion ? 'version mismatch' : 'partner left');
  }

  /* ── client ───────────────────────────────────────────────────────────── */

  clientOn(link) {
    this.role = ROLE.CLIENT;
    this.game.state.net.isClient = true;
    this.link = link;
    this.remoteResponderId = 'r1';
    link.onMessage = (m) => this._clientOnMessage(m);
    link.onClose = () => this._say('disconnected');
    /* Say "joining" BEFORE the hello goes out. A reply can arrive inside send() — it
     * always does over a loopback link, and can over a fast connection — and setting
     * the status afterwards then overwrites "connected" with "joining" and leaves the
     * player staring at a lie. */
    this._say('joining');
    // The token, if we have one, is a request to be given our own body back rather than a
    // new one. The host decides; a token it does not recognise is simply ignored.
    link.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, token: this.token || undefined });
    return this;
  }

  _clientOnMessage(m) {
    if (m.t === MSG.WELCOME) {
      this.localResponderId = m.id;
      this.token = m.token || null;
      this._say('connected');
      return;
    }
    if (m.t === MSG.BYE) {
      this._say(m.reason === 'full' ? 'that crew is full' : 'the host hung up');
      return;
    }
    if (m.t === MSG.SNAP) {
      this.snapsReceived++;
      this.lastSnapshot = m;
      this.game.applyNetSnapshot(m);
    }
  }

  /* ── the pump ─────────────────────────────────────────────────────────── */

  /**
   * Called once per rendered frame from main.js.
   * @param {number} dtMs   real frame time
   * @param {object} cmd    THIS machine's local command for this frame
   */
  pump(dtMs, cmd) {
    if (this.role === ROLE.HOST) {
      this._expireHeldSeats(dtMs);
      this._sinceSnapMs += dtMs;
      if (this._sinceSnapMs < this.snapshotEveryMs) return;
      this._sinceSnapMs = 0;
      if (!this.seats.size) return;
      /* ONE snapshot, encoded once, sent to everybody. The snapshot is the whole town and
       * does not depend on who is reading it — encoding it per seat would be three times
       * the work for three identical objects, and the moment they could differ is the
       * moment two volunteers are looking at different towns. */
      const snap = this.game.encodeNetSnapshot();
      for (const seat of this.seats.values()) {
        if (seat.link && seat.link.open) seat.link.send(snap);
      }
      return;
    }

    // Client: intent up, every frame. It is a handful of integers.
    if (this.role === ROLE.CLIENT && cmd && this.link && this.link.open) {
      this.link.send(this.game.encodeNetCommand(cmd));
    }
  }

  leave() {
    // A client says goodbye down its one link; a host says goodbye down all of them, and
    // signs everybody off rather than leaving three bodies standing in the road.
    try { if (this.link && this.link.open) { this.link.send({ t: MSG.BYE }); this.link.close(); } } catch (e) { /* ignore */ }
    for (const [id, seat] of this.seats) {
      try { if (seat.link && seat.link.open) { seat.link.send({ t: MSG.BYE }); seat.link.close(); } } catch (e) { /* ignore */ }
      try { this.game.setRemoteCommand(id, null); this.game.unseatResponder(id); } catch (e) { /* ignore */ }
    }
    this.seats.clear();
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignore */ }
    this.link = null; this.peer = null;
    this.token = null;
    if (this.game && this.game.state) this.game.state.net.isClient = false;
    this.role = ROLE.SOLO;
    this.localResponderId = 'r1';
    this.remoteResponderId = null;
    this._say('offline');
  }

  /* ── PeerJS, the real transport ───────────────────────────────────────── */

  /**
   * Open a room. Resolves with the code as soon as the broker has our id — the
   * partner may connect much later.
   */
  hostPeer(rand = Math.random) {
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return null; }
    this.code = randCode(rand);
    this._say('opening room…');
    const peer = new Peer(ROOM_PREFIX + this.code, PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => this._say(`room ${this.code} — waiting`));
    peer.on('connection', (conn) => {
      const link = wrapConn(conn);
      /* `accept`, not `hostOn`: the second and third volunteers arrive through this same
         handler, and hostOn used to overwrite the one link the session had. */
      conn.on('open', () => this.accept(link));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => link.onClose && link.onClose());
    });
    peer.on('error', (e) => {
      this._say(e && e.type === 'unavailable-id' ? 'code taken — try again' : `error: ${e && e.type}`);
    });
    return this.code;
  }

  joinPeer(code) {
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return false; }
    this.code = (code || '').trim().toUpperCase();
    if (this.code.length < 4) { this._say('enter the room code'); return false; }
    this._say('connecting…');
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(ROOM_PREFIX + this.code, { reliable: true });
      const link = wrapConn(conn);
      conn.on('open', () => this.clientOn(link));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => link.onClose && link.onClose());
      conn.on('error', () => this._say('could not reach that room'));
    });
    peer.on('error', (e) => {
      this._say(e && e.type === 'peer-unavailable' ? 'no room with that code' : `error: ${e && e.type}`);
    });
    return true;
  }
}

function wrapConn(conn) {
  return {
    open: true,
    onMessage: null, onOpen: null, onClose: null,
    send(msg) { try { conn.send(msg); return true; } catch (e) { return false; } },
    close() { this.open = false; try { conn.close(); } catch (e) { /* ignore */ } },
  };
}
