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
  }

  get online() { return this.role !== ROLE.SOLO; }

  _say(status) {
    this.status = status;
    if (this.onStatus) this.onStatus(status, this);
  }

  /* ── host ─────────────────────────────────────────────────────────────── */

  /** Attach a link as the host. The partner responder is created on connect. */
  hostOn(link) {
    this.role = ROLE.HOST;
    this.link = link;
    this.localResponderId = 'r1';
    this.remoteResponderId = 'r2';
    link.onMessage = (m) => this._hostOnMessage(m);
    link.onClose = () => this._partnerGone();
    this._say('waiting');
    return this;
  }

  _hostOnMessage(m) {
    const s = this.game.state;
    if (m.t === MSG.HELLO) {
      if (m.v !== PROTOCOL_VERSION) { this._say('version mismatch'); return; }
      // Bring the partner on exactly as the P key does, then mark them remote so the
      // step loop stops reading a keyboard for them.
      if (s.responders.length < 2) this.game.addResponder();
      const r = s.responders[1];
      r.remote = true;
      this.link.send({ t: MSG.WELCOME, v: PROTOCOL_VERSION, id: r.id });
      this._say('connected');
      return;
    }
    if (m.t === MSG.CMD) {
      this.cmdsReceived++;
      this.game.setRemoteCommand(this.remoteResponderId, m);
      return;
    }
    if (m.t === MSG.BYE) this._partnerGone();
  }

  _partnerGone() {
    if (this.role !== ROLE.HOST) { this._say('disconnected'); return; }
    const s = this.game.state;
    if (s.responders.length > 1) this.game.removeResponder();
    this.game.setRemoteCommand(this.remoteResponderId, null);
    this._say('partner left');
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
    link.send({ t: MSG.HELLO, v: PROTOCOL_VERSION });
    return this;
  }

  _clientOnMessage(m) {
    if (m.t === MSG.WELCOME) {
      this.localResponderId = m.id;
      this._say('connected');
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
    if (!this.link || !this.link.open) return;

    if (this.role === ROLE.HOST) {
      this._sinceSnapMs += dtMs;
      if (this._sinceSnapMs >= this.snapshotEveryMs) {
        this._sinceSnapMs = 0;
        this.link.send(this.game.encodeNetSnapshot());
      }
      return;
    }

    // Client: intent up, every frame. It is a handful of integers.
    if (this.role === ROLE.CLIENT && cmd) this.link.send(this.game.encodeNetCommand(cmd));
  }

  leave() {
    try { if (this.link && this.link.open) { this.link.send({ t: MSG.BYE }); this.link.close(); } } catch (e) { /* ignore */ }
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignore */ }
    this.link = null; this.peer = null;
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
      conn.on('open', () => this.hostOn(link));
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
