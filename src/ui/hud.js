/* HUD. Reads state, writes DOM, decides nothing.
 *
 * The call list is the centrepiece and it is ALWAYS on screen — GDD implementation
 * rule 3 forbids a panel that pauses the world, so rather than hiding triage behind a
 * key it is simply always readable, with TAB expanding the detail. A player should be
 * able to answer "what am I not doing right now" without pressing anything.
 */

import { CONFIG } from '../config.js';
import { MODES } from '../game.js';
import { GameClock } from '../core/clock.js';
import { TOOL_DEFS } from '../data/equipment.js';
import { dist } from '../data/town.js';
import { contextPrompt, toolsInReachOf, heldTool } from '../sim/interaction.js';
import { victimState } from '../sim/victims.js';
import { gasAt } from '../sim/hazards.js';
import { stillInside } from '../sim/residents.js';
import { describeWeather, CONDITIONS } from '../sim/weather.js';
import { confidenceWord } from './shiftReport.js';

const PRIORITY_CLASS = { routine: 'p-routine', high: 'p-high', critical: 'p-critical' };

export class Hud {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.expanded = false;
    this.onStart = null;
    this.onHost = null;
    this.onJoin = null;
    this.onLeaveNet = null;
    this.netStatus = 'offline';
    this.lastSlots = [];
    this._lastRadioLen = -1;
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div id="topbar">
        <div class="pill" id="clock">10:00</div>
        <div class="pill" id="shift">Shift 1</div>
        <!-- Tonight's conditions. It sits next to the shift number because it is the
             same kind of fact: something about this shift that was decided before you
             arrived and that you now have to work with. -->
        <div class="pill" id="weather" title=""></div>
        <div class="pill mute" id="mute" title="M">SOUND</div>
        <div class="pill grow" id="confidence"><span class="label">Town</span>
          <span class="bar"><i></i></span><span class="word"></span></div>
        <div class="pill" id="vehicle"></div>
        <div class="pill net" id="netchip" hidden></div>
      </div>

      <div id="calls">
        <div class="calls-head">DISPATCH <span class="hint">TAB detail</span></div>
        <ul></ul>
      </div>

      <div id="bottom">
        <div id="coach" hidden></div>
        <div id="prompt"></div>
        <div id="slots"></div>
      </div>

      <div id="radio"></div>

      <div id="overlay" class="show">
        <div class="card" id="titlecard">
          <h1>Small Town Emergency Services</h1>
          <p class="tagline">The town keeps going without you.</p>
          <p class="body">You are the volunteer on duty. Three trucks, one clinic, and a
             dispatcher who will keep calling whether or not the last job is finished.</p>
          <div class="keys">
            <div><b>WASD</b> move / drive</div>
            <div><b>E</b> get in, get out, grab a patient</div>
            <div><b>SPACE</b> use what you are holding</div>
            <div><b>1–5</b> take kit from the nearest truck</div>
            <div><b>F</b> put it down</div>
            <div><b>Q</b> siren</div>
            <div><b>V</b> hold to see the whole town</div>
            <div><b>TAB</b> call detail &nbsp; <b>ESC</b> pause &nbsp; <b>M</b> mute</div>
            <div><b>mouse</b> aim what you are holding</div>
            <div class="coopkeys"><b>P</b> add a second volunteer — arrows, <b>RShift</b>, <b>/</b>, <b>.</b>, <b>,</b>, numpad</div>
          </div>
          <button id="startbtn">Start the shift</button>
          <div id="netrow">
            <button id="hostbtn" class="ghost">Play together</button>
            <span class="or">or</span>
            <input id="joincode" maxlength="5" placeholder="CODE" autocomplete="off" spellcheck="false">
            <button id="joinbtn" class="ghost">Join</button>
          </div>
          <div id="sharerow" hidden>
            <input id="shareurl" readonly>
            <button id="copybtn" class="ghost">Copy link</button>
          </div>
          <div id="netnote"></div>
        </div>
      </div>`;

    this.el = {
      clock: this.root.querySelector('#clock'),
      shift: this.root.querySelector('#shift'),
      weather: this.root.querySelector('#weather'),
      mute: this.root.querySelector('#mute'),
      confBar: this.root.querySelector('#confidence .bar i'),
      confWord: this.root.querySelector('#confidence .word'),
      vehicle: this.root.querySelector('#vehicle'),
      calls: this.root.querySelector('#calls ul'),
      callsBox: this.root.querySelector('#calls'),
      prompt: this.root.querySelector('#prompt'),
      coach: this.root.querySelector('#coach'),
      slots: this.root.querySelector('#slots'),
      radio: this.root.querySelector('#radio'),
      overlay: this.root.querySelector('#overlay'),
      netchip: this.root.querySelector('#netchip'),
      netnote: this.root.querySelector('#netnote'),
      joincode: this.root.querySelector('#joincode'),
      sharerow: this.root.querySelector('#sharerow'),
      shareurl: this.root.querySelector('#shareurl'),
    };

    this.root.querySelector('#startbtn').addEventListener('click', () => this.onStart && this.onStart());

    const code = this.el.joincode;
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    this.root.querySelector('#hostbtn').addEventListener('click', () => this.onHost && this.onHost());
    const join = () => this.onJoin && this.onJoin(code.value);
    this.root.querySelector('#joinbtn').addEventListener('click', join);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); e.stopPropagation(); });
    // The room code is five characters and people read it off a screen to a friend, so
    // one click to copy it beats squinting.
    this.el.netchip.addEventListener('click', () => {
      const c = (this.el.netchip.dataset.code || '');
      if (c && navigator.clipboard) navigator.clipboard.writeText(c).catch(() => {});
    });

    /* Copying the LINK, not the code. Clipboard access can be refused — an insecure
       origin, a browser that says no — so the fallback is to select the text, which is
       the thing the player was going to do by hand anyway. */
    const copy = this.root.querySelector('#copybtn');
    copy.addEventListener('click', () => {
      const url = this.el.shareurl.value;
      this.el.shareurl.select();
      const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy link'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => {});
      else done();
    });
  }

  /**
   * Show the invitation: the host's own URL with the room on the end of it.
   * Pass null to put the join row back.
   */
  setShareUrl(url) {
    if (!this.el.sharerow) return;
    this.el.sharerow.hidden = !url;
    const row = this.root.querySelector('#netrow');
    if (row) row.hidden = !!url;
    if (url) this.el.shareurl.value = url;
  }

  /** A code that arrived in the URL: fill the box and say what is about to happen. */
  setInvitedCode(code) {
    if (!code || !this.el.joincode) return;
    this.el.joincode.value = code;
    const btn = this.root.querySelector('#joinbtn');
    if (btn) btn.textContent = `Join ${code}`;
  }

  /**
   * Net status, verbatim from the session. The HUD never decides what the connection
   * is doing — it only says so, in the two places a player is looking: the title card
   * while they are setting it up, and a top-bar chip once the shift is running.
   */
  setNetStatus(status, net) {
    this.netStatus = status;
    const online = net && net.online;
    const chip = this.el.netchip;
    chip.hidden = !online;
    chip.dataset.code = (net && net.code) || '';
    chip.textContent = net && net.code ? `${net.code} · ${status}` : status;
    chip.classList.toggle('live', status === 'connected');
    chip.classList.toggle('warn', /left|mismatch|error|unavailable|not|could not|taken/i.test(status));
    if (this.el.netnote) {
      this.el.netnote.textContent = status === 'offline' ? '' :
        (net && net.code && !/connected/.test(status)
          ? `Room ${net.code} — tell your friend to type it in. (${status})`
          : status);
    }
  }


  /**
   * One line of guidance from src/ui/coach.js, or null.
   *
   * A hint that changed every frame would be unreadable, so a line stays put for
   * CONFIG.coach.minShowMs before a different one may replace it — except when the
   * coach falls silent, which happens the instant the player does the thing and should
   * be immediate. Nothing here pauses anything; the town keeps running behind it.
   */
  setHint(hint) {
    const el = this.el.coach;
    if (!el) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!hint) {
      this._hintId = null;
      el.hidden = true;
      return;
    }
    if (this._hintId === hint.id) { el.textContent = hint.text; return; }
    if (this._hintId && now - (this._hintAtMs || 0) < CONFIG.coach.minShowMs) return;
    this._hintId = hint.id;
    this._hintAtMs = now;
    el.hidden = false;
    el.textContent = hint.text;
  }

  toggleExpanded() { this.expanded = !this.expanded; this.el.callsBox.classList.toggle('expanded', this.expanded); }

  /** Audio owns whether it is muted; the HUD only reports it. */
  setMuted(muted) {
    this.muted = !!muted;
    if (this.el.mute) {
      this.el.mute.textContent = this.muted ? 'MUTED' : 'SOUND';
      this.el.mute.classList.toggle('off', this.muted);
    }
  }

  update() {
    const s = this.game.state;
    this.updateTop(s);
    this.updateCalls(s);
    this.updateBottom(s);
    this.updateRadio(s);
    this.updateOverlay(s);
  }

  updateTop(s) {
    const left = Math.max(0, s.shiftMs - s.simTimeMs);
    this.el.clock.textContent = GameClock.formatMs(left);
    this.el.clock.classList.toggle('urgent', left < 60000);
    this.el.shift.textContent = `Shift ${s.town.shiftNumber}`;
    if (this.el.weather) {
      const w = s.weather || { id: 'clear' };
      this.el.weather.textContent = describeWeather(w);
      this.el.weather.title = (CONDITIONS[w.id] || CONDITIONS.clear).note;
      this.el.weather.classList.toggle('warn', w.id !== 'clear');
    }
    this.el.confBar.style.width = `${Math.round(s.town.confidence * 100)}%`;
    /* This red is NOT --bad, on purpose, and the suite pins the divergence so nobody
     * "tidies" it (tools/m10-tests.js D25c).
     *
     * --bad was lightened from #e06a5a to #f0928a to get a chip label from 2.90:1 to
     * 5.17:1 — the chip is small text ON the colour, so contrast is what it needs. This
     * bar is the opposite shape: a block of colour with the words beside it, not on it,
     * and what it needs is SEPARATION between its three steps. Measured, the lighter red
     * costs warn/bad 9.5 -> 3.2 dE00, which is amber and red becoming the same bar at a
     * glance. Two signals, two jobs, two reds. */
    this.el.confBar.style.background = s.town.confidence > 0.6 ? '#7fd17f'
      : s.town.confidence > 0.35 ? '#e8c04a' : '#e06a5a';
    this.el.confWord.textContent = confidenceWord(s.town.confidence);

    this.el.vehicle.innerHTML = s.responders.map((r) => this.statusFor(s, r)).join(
      '<span class="crewsep"></span>');
  }

  /** One crew member's line. In co-op there are two, side by side, each in their own
   *  colour — you should never have to work out which of you is out of water. */
  statusFor(s, r) {
    const ap = r.inVehicleId ? s.apparatus.find((a) => a.id === r.inVehicleId) : null;
    const badge = s.coop
      ? `<span class="who" style="color:${r.tint}">${r.name}</span> ` : '';
    return badge + this.statusBits(s, r, ap).join(' ');
  }

  statusBits(s, r, ap) {
    if (ap) {
      const def = s.apparatusDefs[ap.defId];
      const bits = [`<b>${ap.name}</b>`, `${Math.round(Math.abs(ap.speed) * 3.6)} km/h`];
      if (def.tankL) bits.push(waterChip(ap, def));
      if (ap.patientId) {
        const v = s.victims.find((q) => q.id === ap.patientId);
        bits.push(`<span class="chip patient">patient aboard ${v ? Math.round(v.condition * 100) : '?'}%</span>`);
      }
      if (ap.hydrantId) bits.push('<span class="chip good">on a hydrant</span>');
      if (ap.damage > 0.1) bits.push(`<span class="chip bad">damage ${Math.round(ap.damage * 100)}%</span>`);
      if (ap.siren) bits.push('<span class="chip siren">SIREN</span>');
      // Who is actually driving matters the moment there are two of you in one cab.
      if (s.coop) bits.push(ap.driverId === r.id
        ? '<span class="chip">at the wheel</span>'
        : '<span class="chip dim">riding</span>');
      return bits;
    }

    const t = heldTool(s, r);
    const bits = [];
    bits.push(t ? `<b>${t.name}</b>` : '<b>empty handed</b>');
    if (t && t.defId === 'extinguisher') bits.push(`<span class="chip">${t.chargeL.toFixed(1)} L</span>`);
    if (t && t.defId === 'hose') {
      const eng = s.apparatus.find((a) => a.id === t.engineId);
      const d = eng ? dist(r.x, r.y, eng.x, eng.y) : 0;
      const taut = d > CONFIG.water.hoseMaxLengthM * 0.9;
      bits.push(`<span class="chip ${taut ? 'bad' : ''}">${Math.round(d)} / ${CONFIG.water.hoseMaxLengthM} m</span>`);
      if (eng) bits.push(waterChip(eng, s.apparatusDefs[eng.defId]));
    }
    if (t && t.defId === 'gasmeter') {
      const g = gasAt(s, r.x, r.y);
      bits.push(`<span class="chip ${g > 0.35 ? 'bad' : g > 0.1 ? 'warn' : 'good'}">gas ${(g * 100).toFixed(0)}%</span>`);
    }
    if (r.draggingVictimId) bits.push('<span class="chip patient">dragging a patient</span>');
    if (r.stunMs > 0) bits.push('<span class="chip bad">on the ground</span>');
    return bits;
  }

  updateCalls(s) {
    const open = s.incidents.filter((i) => i.status === 'queued' || i.status === 'active');
    const rank = { critical: 0, high: 1, routine: 2 };
    open.sort((a, b) => (rank[a.priority] - rank[b.priority]) || (b.danger - a.danger));

    if (!open.length) {
      this.el.calls.innerHTML = '<li class="quiet">Nothing outstanding. Enjoy it.</li>';
      return;
    }

    this.el.calls.innerHTML = open.map((inc) => {
      // distance from the NEAREST crew member: with two of you, "how far is it" means
      // how far is it from whoever could actually go
      const d = Math.round(Math.min(...s.responders.map((r) => dist(r.x, r.y, inc.x, inc.y))));
      const age = GameClock.formatMs(inc.ageMs);
      const vic = s.victims.filter((v) => inc.victimIds.includes(v.id) && !v.delivered && !v.lost);
      const worst = vic.sort((a, b) => a.condition - b.condition)[0];
      const detail = this.expanded ? `<div class="report">${inc.report}</div>` : '';
      const people = worst
        ? `<span class="chip ${worst.condition < CONFIG.medical.criticalAt ? 'bad' : 'warn'}">${vic.length} patient${vic.length > 1 ? 's' : ''} · ${victimState(worst)}</span>`
        : '';
      /* The number that decides whether anybody goes inside.
       *
       * The radio says it once, at the moment the first person walks out, and then it
       * scrolls away — so on a board with four calls on it, the one fact that changes
       * what the crew does next lives for about eight seconds. It belongs on the card. */
      const inside = inc.buildingId ? stillInside(s, inc.buildingId) : 0;
      const unaccounted = inside > 0
        ? `<span class="chip bad">${inside} still inside</span>` : '';
      return `<li class="${PRIORITY_CLASS[inc.priority]} ${inc.status}">
          <div class="row1"><span class="head">${inc.headline}</span>
            <span class="dist">${d} m</span></div>
          <div class="row2"><span class="place">${inc.place}</span>
            <span class="age">${age}</span></div>
          <div class="danger"><i style="width:${Math.round(inc.danger * 100)}%"></i></div>
          ${unaccounted}${people}${detail}
        </li>`;
    }).join('');
  }

  updateBottom(s) {
    if (s.mode !== MODES.PLAYING) { this.el.prompt.textContent = ''; this.el.slots.innerHTML = ''; return; }

    const me = s.responders[0];
    const ctx = contextPrompt(s, me);
    const held = heldTool(s, me);
    const parts = [];
    if (ctx) parts.push(`<kbd>${ctx.key}</kbd> ${ctx.text}`);
    if (held) {
      const def = TOOL_DEFS[held.defId];
      parts.push(def.mode === 'passive'
        ? `<span class="dim">${def.hint}</span>`
        : `<kbd>SPACE</kbd> ${useVerb(held.defId)} &nbsp; <kbd>F</kbd> put down`);
      if (me.useProgressMs > 0) {
        const total = progressTotal(held.defId);
        parts.push(`<span class="progress"><i style="width:${Math.min(100, (me.useProgressMs / total) * 100)}%"></i></span>`);
      }
    }
    this.el.prompt.innerHTML = parts.join('&nbsp;&nbsp;·&nbsp;&nbsp;') || '<span class="dim">Nothing in reach.</span>';

    if (me.inVehicleId) {
      this.el.slots.innerHTML = '<span class="dim">You are in the cab.</span>';
      this.lastSlots = [];
      return;
    }
    const avail = toolsInReachOf(s, me.x, me.y).slice(0, 5);
    // The same list, in the same order, for whatever else wants to show it — the phone's
    // equipment row has no number keys to mirror, so it mirrors this instead.
    this.lastSlots = avail.map((a) => ({ short: a.tool.short, name: a.tool.name, from: a.from }));
    this.el.slots.innerHTML = avail.length
      ? avail.map((a, i) => `<span class="slot"><kbd>${i + 1}</kbd> ${a.tool.name}<em>${a.from}</em></span>`).join('')
      : '<span class="dim">No kit within reach.</span>';
  }

  updateRadio(s) {
    if (s.radio.length === this._lastRadioLen) return;
    this._lastRadioLen = s.radio.length;
    const recent = s.radio.slice(-5);
    this.el.radio.innerHTML = recent.map((r) =>
      `<div class="line ${r.kind}">${GameClock.formatMs(r.atMs)} &nbsp; ${r.text}</div>`).join('');
  }

  updateOverlay(s) {
    const o = this.el.overlay;
    if (s.mode === MODES.PLAYING) { o.classList.remove('show'); return; }
    o.classList.add('show');

    if (s.mode === MODES.TITLE) return;   // the title card is already in the DOM

    if (s.mode === MODES.PAUSED) {
      o.innerHTML = `<div class="card">
        <h1>Paused</h1>
        <p class="body">The town is stopped too. It will not be, in a moment.</p>
        <p class="dim">ESC resume &nbsp;·&nbsp; R restart the shift</p></div>`;
      return;
    }

    if (s.mode === MODES.REPORT && s.report && this._reportShownFor !== s.report) {
      this._reportShownFor = s.report;
      o.innerHTML = reportCard(s.report);
      const btn = o.querySelector('#startbtn');
      if (btn) btn.addEventListener('click', () => this.onStart && this.onStart());
    }
  }
}

/* ── bits ─────────────────────────────────────────────────────────────────── */

function waterChip(ap, def) {
  const pct = def.tankL ? ap.waterL / def.tankL : 0;
  const cls = pct < 0.15 ? 'bad' : pct < 0.4 ? 'warn' : 'good';
  return `<span class="chip ${cls}">water ${Math.round(ap.waterL)} L</span>`;
}

function useVerb(defId) {
  return {
    hose: 'open the nozzle', extinguisher: 'discharge', medkit: 'treat the patient',
    chainsaw: 'cut', spreaders: 'spread', wrench: 'turn it', hotstick: 'kill the line',
  }[defId] || 'use';
}

function progressTotal(defId) {
  return {
    medkit: CONFIG.medical.treatMs, spreaders: CONFIG.medical.extricateMs,
    wrench: CONFIG.tools.wrenchTurnMs, hotstick: CONFIG.tools.hotstickMs,
    chainsaw: 1000 / CONFIG.tools.chainsawCutPerSec,
  }[defId] || 1000;
}

export function reportCard(r) {
  const rows = r.incidents.map((i) => `
    <tr class="${i.status}">
      <td>${i.headline}</td><td>${i.place}</td>
      <td class="st">${i.status}</td><td class="note">${i.note}</td>
    </tr>`).join('');

  const damage = r.damaged.length
    ? r.damaged.map((d) => `${d.name} ${Math.round(d.damage * 100)}%`).join(', ')
    : 'nothing left standing damaged';
  const hyd = r.brokenHydrants.length ? `${r.brokenHydrants.length} hydrant(s) out of service` : 'hydrants all in service';

  return `<div class="card report">
    <div class="masthead">THE MERCER COUNTY WEEKLY <span>Shift ${r.shiftNumber}</span></div>
    <h1>${r.headline}</h1>
    <p class="standfirst">${r.standfirst}</p>
    <table><thead><tr><th>Call</th><th>Location</th><th>Outcome</th><th>Detail</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No calls came in.</td></tr>'}</tbody></table>
    <div class="grid">
      <div><b>Town confidence</b><br>${Math.round(r.confidenceStart * 100)}% → ${Math.round(r.confidenceEnd * 100)}%
        (${r.confidenceDelta >= 0 ? '+' : ''}${Math.round(r.confidenceDelta * 100)})</div>
      <div><b>Structures</b><br>${damage}</div>
      <div><b>Water supply</b><br>${hyd}</div>
      <div><b>Patients</b><br>${r.patientsSaved} transported · ${r.patientsLost} lost</div>
      <div><b>Residents</b><br>${r.residentsOut === 0 && r.residentsTrapped === 0
        ? 'nobody had to leave a building'
        : `${r.residentsOut} got themselves out${r.residentsTrapped
          ? ` · <span class="st lost">${r.residentsTrapped} did not</span>` : ''}`}</div>
      <div><b>Driving</b><br>${(r.telemetry.distanceDrivenM / 1000).toFixed(1)} km · ${Math.round(r.telemetry.litresUsed)} L of water</div>
      <div><b>First split decision</b><br>${r.telemetry.firstSplitMs == null ? 'never split' : GameClock.formatMs(r.telemetry.firstSplitMs)}</div>
    </div>
    ${nextShiftBlock(r)}
    <button id="startbtn">Start shift ${r.shiftNumber + 1}</button>
  </div>`;
}

/**
 * What the next shift inherits, named.
 *
 * The card used to end on "damage and broken hydrants carry into the next shift", which
 * is a promise rather than evidence. GDD Phase 4's gate is that a player cares about a
 * previous mistake — so the mistakes get names, and the last few shifts' headlines sit
 * underneath them, because a run of them is the story the town is telling about you.
 */
function nextShiftBlock(r) {
  const n = r.nextShift;
  if (!n) return '';
  const bits = [];
  if (n.boarded.length) {
    bits.push(`<b>Boarded up:</b> ${n.boarded.map((d) =>
      `${d.name}${d.boardedShifts > 0 ? ` (${d.boardedShifts} more shift${d.boardedShifts === 1 ? '' : 's'})` : ''}`)
      .join(', ')}`);
  }
  if (n.stillDamaged.length) {
    bits.push(`<b>Still being patched up:</b> ${n.stillDamaged
      .map((d) => `${d.name} ${Math.round(d.damage * 100)}%`).join(', ')}`);
  }
  if (n.hydrantsOut) bits.push(`<b>Out of service:</b> ${n.hydrantsOut} hydrant${n.hydrantsOut === 1 ? '' : 's'}`);
  if (!bits.length) bits.push('Nothing carries over. The town is whole.');

  const past = n.history.length > 1
    ? `<div class="pastshifts">${n.history.slice(0, -1).map((h) => `<span>${h}</span>`).join('')}</div>`
    : '';

  return `<div class="nextshift"><h2>Shift ${r.shiftNumber + 1} starts here</h2>
    ${bits.map((b) => `<p>${b}</p>`).join('')}${past}</div>`;
}
