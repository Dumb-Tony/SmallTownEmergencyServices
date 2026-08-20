/* Does it play? — the measurement the GDD's own question demands.
 *
 * "Can one small continuous town, three drivable vehicles, five incident families and a
 * dispatch queue reliably produce a story where players abandon one worsening problem
 * for another and then improvise around the consequences?"
 *
 * The story only works if working the town beats not working it, and if a crew that
 * turns up can actually WIN some of it. Two numbers from the playability suite say that
 * is not yet true: whole shifts end 6-lost-of-7, and across every bot shift ever run,
 * patients loaded = 0 and patients delivered = 0. The medical family — a fifth of the
 * game — has never once completed in real play.
 *
 * This prints where the chain breaks, per family, for one crew and for two.
 */

import { CONFIG } from '../src/config.js';
import { Game } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';
import { toggleCoop } from '../src/game.js';
import { victimState } from '../src/sim/victims.js';
import { CLINIC, dist } from '../src/data/town.js';

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

function shift(seed, crew) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  if (crew === 2) toggleCoop(s);

  const board = { claims: new Map(), trucks: new Map() };
  const bots = s.responders.map((r) => new CrewBot(g, r.id, crew === 2 ? board : null));
  bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : 'p2'); });
  const merged = bots.length > 1 ? mergeBotInputs(bots.map((b) => b.input)) : bots[0].input;

  /* Watch the medical chain tick by tick. A shift report says "lost"; it does not say
     whether the crew never arrived, arrived and could not treat, treated and never got
     a truck, or got a truck and ran out of clock. */
  const seen = new Map();
  let firstCallMs = null, firstArrivalMs = null;

  // what the crew DECIDED, and what the simulation did about it
  const jobs = {};
  const events = {};
  g.bus.onAny((e) => { events[e.type] = (events[e.type] || 0) + 1; });

  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    for (const b of bots) b.think();
    for (const b of bots) if (b.lastJob) jobs[b.lastJob.kind] = (jobs[b.lastJob.kind] || 0) + 1;
    g.frame(STEP, bots.length > 1 ? merged : bots[0].input);
    if (s.mode !== 'playing') break;

    for (const v of s.victims) {
      if (!seen.has(v.id)) seen.set(v.id, { reached: false, treated: false, loaded: false, delivered: false, lost: false, needsRide: false });
      const rec = seen.get(v.id);
      if (v.needsTransport) rec.needsRide = true;
      if (!rec.reached && s.responders.some((r) => !r.inVehicleId && dist(r.x, r.y, v.x, v.y) < CONFIG.player.reachM + 1)) rec.reached = true;
      if (v.treatedAtMs != null) rec.treated = true;
      if (v.inApparatusId) rec.loaded = true;
      if (v.delivered) rec.delivered = true;
      if (v.lost) rec.lost = true;
    }
    if (firstCallMs === null && s.incidents.length) firstCallMs = s.simTimeMs;
    if (firstArrivalMs === null && s.incidents.some((i) => i.everWorked)) firstArrivalMs = s.simTimeMs;
  }

  const byFamily = {};
  for (const inc of s.incidents) {
    const f = inc.family || 'other';
    byFamily[f] = byFamily[f] || { n: 0, controlled: 0, lost: 0, worked: 0 };
    byFamily[f].n++;
    if (inc.status === 'controlled') byFamily[f].controlled++;
    if (inc.status === 'lost') byFamily[f].lost++;
    if (inc.everWorked) byFamily[f].worked++;
  }

  const chain = { total: 0, needsRide: 0, reached: 0, treated: 0, loaded: 0, delivered: 0, lost: 0 };
  for (const rec of seen.values()) {
    chain.total++;
    if (rec.needsRide) chain.needsRide++;
    if (rec.reached) chain.reached++;
    if (rec.treated) chain.treated++;
    if (rec.loaded) chain.loaded++;
    if (rec.delivered) chain.delivered++;
    if (rec.lost) chain.lost++;
  }

  return {
    seed, crew, s, byFamily, chain, jobs, events,
    calls: s.incidents.length,
    controlled: s.outcome.controlled,
    lost: s.outcome.lost,
    neverWorked: s.telemetry.callsNeverWorked,
    km: s.telemetry.distanceDrivenM / 1000,
    confidence: s.town.confidence,
    firstCallMs, firstArrivalMs,
  };
}

try {
  const seeds = [101, 202, 303];
  lines.push('=== per-shift outcome ===');
  lines.push('seed crew | calls ctrl lost never | km   conf | first call -> first arrival');
  const runs = [];
  for (const seed of seeds) {
    for (const crew of [1, 2]) {
      const r = shift(seed, crew);
      runs.push(r);
      lines.push(`${String(seed).padStart(4)}   ${r.crew}  | ` +
        `${String(r.calls).padStart(5)} ${String(r.controlled).padStart(4)} ${String(r.lost).padStart(4)} ` +
        `${String(r.neverWorked).padStart(5)} | ${r.km.toFixed(2)} ${String(Math.round(r.confidence * 100)).padStart(4)}% | ` +
        `${(r.firstCallMs / 1000).toFixed(0)}s -> ${r.firstArrivalMs == null ? 'never' : (r.firstArrivalMs / 1000).toFixed(0) + 's'}`);
    }
  }

  lines.push('');
  lines.push('=== does a second pair of hands help? (GDD Phase 5 exit gate) ===');
  for (const seed of seeds) {
    const a = runs.find((r) => r.seed === seed && r.crew === 1);
    const b = runs.find((r) => r.seed === seed && r.crew === 2);
    lines.push(`seed ${seed}: controlled ${a.controlled} -> ${b.controlled}   lost ${a.lost} -> ${b.lost}   ` +
      `never worked ${a.neverWorked} -> ${b.neverWorked}   confidence ${Math.round(a.confidence * 100)}% -> ${Math.round(b.confidence * 100)}%`);
  }

  lines.push('');
  lines.push('=== where the medical chain breaks ===');
  lines.push('seed crew | casualties needsRide reached treated loaded delivered lost');
  for (const r of runs) {
    const c = r.chain;
    lines.push(`${String(r.seed).padStart(4)}   ${r.crew}  | ${String(c.total).padStart(10)} ${String(c.needsRide).padStart(9)} ` +
      `${String(c.reached).padStart(7)} ${String(c.treated).padStart(7)} ${String(c.loaded).padStart(6)} ` +
      `${String(c.delivered).padStart(9)} ${String(c.lost).padStart(4)}`);
  }

  lines.push('');
  lines.push('=== what the crew decided to do, in ticks spent on each job ===');
  for (const r of runs) {
    lines.push(r.seed + '/' + r.crew + ': ' +
      Object.entries(r.jobs).map(([k, v]) => k + ' ' + v).join('  '));
  }
  lines.push('');
  lines.push('=== interaction events (all runs pooled) ===');
  const ev = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.events)) ev[k] = (ev[k] || 0) + v;
  for (const k of Object.keys(ev).sort()) {
    if (/PATIENT|APPARATUS|VICTIM|TREAT|CLINIC/.test(k)) lines.push('  ' + k.padEnd(26) + ev[k]);
  }

  lines.push('');
  lines.push('=== by family (all runs pooled) ===');
  const pooled = {};
  for (const r of runs) {
    for (const [f, v] of Object.entries(r.byFamily)) {
      pooled[f] = pooled[f] || { n: 0, controlled: 0, lost: 0, worked: 0 };
      for (const k of ['n', 'controlled', 'lost', 'worked']) pooled[f][k] += v[k];
    }
  }
  for (const [f, v] of Object.entries(pooled)) {
    lines.push(`${f.padEnd(10)} calls ${String(v.n).padStart(3)}  worked ${String(v.worked).padStart(3)}  ` +
      `controlled ${String(v.controlled).padStart(3)}  lost ${String(v.lost).padStart(3)}`);
  }

  lines.push('');
  lines.push(`clinic at ${CLINIC.x},${CLINIC.y} · shift ${(CONFIG.shift.durationMs / 60000).toFixed(0)} min · ` +
    `victim states seen: ${[...new Set(runs.flatMap((r) => r.s.victims.map(victimState)))].join(', ')}`);
  emit();
} catch (err) {
  lines.push('threw: ' + (err && err.message));
  lines.push(String((err && err.stack) || '').split('\n').slice(0, 6).join('\n'));
  emit();
}
