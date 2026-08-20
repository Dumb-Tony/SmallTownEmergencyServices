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
import { confidenceWord } from './shiftReport.js';

const PRIORITY_CLASS = { routine: 'p-routine', high: 'p-high', critical: 'p-critical' };

export class Hud {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.expanded = false;
    this.onStart = null;
    this._lastRadioLen = -1;
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div id="topbar">
        <div class="pill" id="clock">10:00</div>
        <div class="pill" id="shift">Shift 1</div>
        <div class="pill mute" id="mute" title="M">SOUND</div>
        <div class="pill grow" id="confidence"><span class="label">Town</span>
          <span class="bar"><i></i></span><span class="word"></span></div>
        <div class="pill" id="vehicle"></div>
      </div>

      <div id="calls">
        <div class="calls-head">DISPATCH <span class="hint">TAB detail</span></div>
        <ul></ul>
      </div>

      <div id="bottom">
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
            <div><b>TAB</b> call detail &nbsp; <b>ESC</b> pause &nbsp; <b>M</b> mute</div>
            <div><b>mouse</b> aim what you are holding</div>
          </div>
          <button id="startbtn">Start the shift</button>
        </div>
      </div>`;

    this.el = {
      clock: this.root.querySelector('#clock'),
      shift: this.root.querySelector('#shift'),
      mute: this.root.querySelector('#mute'),
      confBar: this.root.querySelector('#confidence .bar i'),
      confWord: this.root.querySelector('#confidence .word'),
      vehicle: this.root.querySelector('#vehicle'),
      calls: this.root.querySelector('#calls ul'),
      callsBox: this.root.querySelector('#calls'),
      prompt: this.root.querySelector('#prompt'),
      slots: this.root.querySelector('#slots'),
      radio: this.root.querySelector('#radio'),
      overlay: this.root.querySelector('#overlay'),
    };

    this.root.querySelector('#startbtn').addEventListener('click', () => this.onStart && this.onStart());
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
    this.el.confBar.style.width = `${Math.round(s.town.confidence * 100)}%`;
    this.el.confBar.style.background = s.town.confidence > 0.6 ? '#7fd17f'
      : s.town.confidence > 0.35 ? '#e8c04a' : '#e06a5a';
    this.el.confWord.textContent = confidenceWord(s.town.confidence);

    const ap = s.player.inVehicleId ? s.apparatus.find((a) => a.id === s.player.inVehicleId) : null;
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
      this.el.vehicle.innerHTML = bits.join(' ');
    } else {
      const t = heldTool(s);
      const bits = [];
      bits.push(t ? `<b>${t.name}</b>` : '<b>empty handed</b>');
      if (t && t.defId === 'extinguisher') bits.push(`<span class="chip">${t.chargeL.toFixed(1)} L</span>`);
      if (t && t.defId === 'hose') {
        const eng = s.apparatus.find((a) => a.id === t.engineId);
        const d = eng ? dist(s.player.x, s.player.y, eng.x, eng.y) : 0;
        const taut = d > CONFIG.water.hoseMaxLengthM * 0.9;
        bits.push(`<span class="chip ${taut ? 'bad' : ''}">${Math.round(d)} / ${CONFIG.water.hoseMaxLengthM} m</span>`);
        if (eng) bits.push(waterChip(eng, s.apparatusDefs[eng.defId]));
      }
      if (t && t.defId === 'gasmeter') {
        const g = gasAt(s, s.player.x, s.player.y);
        bits.push(`<span class="chip ${g > 0.35 ? 'bad' : g > 0.1 ? 'warn' : 'good'}">gas ${(g * 100).toFixed(0)}%</span>`);
      }
      if (s.player.draggingVictimId) bits.push('<span class="chip patient">dragging a patient</span>');
      if (s.player.stunMs > 0) bits.push('<span class="chip bad">on the ground</span>');
      this.el.vehicle.innerHTML = bits.join(' ');
    }
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
      const d = Math.round(dist(s.player.x, s.player.y, inc.x, inc.y));
      const age = GameClock.formatMs(inc.ageMs);
      const vic = s.victims.filter((v) => inc.victimIds.includes(v.id) && !v.delivered && !v.lost);
      const worst = vic.sort((a, b) => a.condition - b.condition)[0];
      const detail = this.expanded ? `<div class="report">${inc.report}</div>` : '';
      const people = worst
        ? `<span class="chip ${worst.condition < CONFIG.medical.criticalAt ? 'bad' : 'warn'}">${vic.length} patient${vic.length > 1 ? 's' : ''} · ${victimState(worst)}</span>`
        : '';
      return `<li class="${PRIORITY_CLASS[inc.priority]} ${inc.status}">
          <div class="row1"><span class="head">${inc.headline}</span>
            <span class="dist">${d} m</span></div>
          <div class="row2"><span class="place">${inc.place}</span>
            <span class="age">${age}</span></div>
          <div class="danger"><i style="width:${Math.round(inc.danger * 100)}%"></i></div>
          ${people}${detail}
        </li>`;
    }).join('');
  }

  updateBottom(s) {
    if (s.mode !== MODES.PLAYING) { this.el.prompt.textContent = ''; this.el.slots.innerHTML = ''; return; }

    const ctx = contextPrompt(s);
    const held = heldTool(s);
    const parts = [];
    if (ctx) parts.push(`<kbd>${ctx.key}</kbd> ${ctx.text}`);
    if (held) {
      const def = TOOL_DEFS[held.defId];
      parts.push(def.mode === 'passive'
        ? `<span class="dim">${def.hint}</span>`
        : `<kbd>SPACE</kbd> ${useVerb(held.defId)} &nbsp; <kbd>F</kbd> put down`);
      if (s.player.useProgressMs > 0) {
        const total = progressTotal(held.defId);
        parts.push(`<span class="progress"><i style="width:${Math.min(100, (s.player.useProgressMs / total) * 100)}%"></i></span>`);
      }
    }
    this.el.prompt.innerHTML = parts.join('&nbsp;&nbsp;·&nbsp;&nbsp;') || '<span class="dim">Nothing in reach.</span>';

    if (s.player.inVehicleId) { this.el.slots.innerHTML = '<span class="dim">You are in the cab.</span>'; return; }
    const avail = toolsInReachOf(s, s.player.x, s.player.y).slice(0, 5);
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
      <div><b>Driving</b><br>${(r.telemetry.distanceDrivenM / 1000).toFixed(1)} km · ${Math.round(r.telemetry.litresUsed)} L of water</div>
      <div><b>First split decision</b><br>${r.telemetry.firstSplitMs == null ? 'never split' : GameClock.formatMs(r.telemetry.firstSplitMs)}</div>
    </div>
    <p class="dim">Damage and broken hydrants carry into the next shift.</p>
    <button id="startbtn">Start shift ${r.shiftNumber + 1}</button>
  </div>`;
}
