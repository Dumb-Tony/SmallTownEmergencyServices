/* Where the shift is actually lost.
 *
 * m15 section G, re-run after the fourth truck landed, reports this:
 *
 *   crew of 1: 2 controlled · 12 lost · 0 to the clinic · confidence 40%
 *   crew of 2: 4 controlled · 10 lost · 1 to the clinic · confidence 50%
 *   crew of 4: 5 controlled · 10 lost · 1 to the clinic · confidence 53%
 *
 * Every assertion in that section passes — four beats two, everybody walked, the town is
 * better off. And ten of fourteen calls are still lost with four people on shift, and one
 * patient in two shifts reaches the clinic.
 *
 * "Four beat two" is a true statement about a town that is losing two thirds of its calls.
 * Before building anything else, this asks WHY: is the crew never getting there, getting
 * there and failing, or getting there and being told they failed?
 *
 * Not a test. A measurement, printed as tables, so the next milestone is chosen by a
 * number instead of by whichever feature sounds good.
 *
 *   .\tools\smoketest.ps1 -Tests tools\_losediag.js -Port 8xxx
 */

import { CONFIG } from '../src/config.js';
import { Game, MODES, seatResponder, readCommand } from '../src/game.js';
import { clearSave } from '../src/core/persistence.js';
import { encodeCommand } from '../src/net/protocol.js';
import { CrewBot, makeBotInput, mergeBotInputs } from './_crewbot.js';
import { fireDamageFraction } from '../src/sim/hazards.js';
import { BUILDINGS, dist, atStation } from '../src/data/town.js';

const STEP = CONFIG.sim.stepMs;
const lines = [];
const f = (n, d = 1) => Number(n).toFixed(d);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const lp = (s, n) => String(s).padStart(n);

let _pre = null;
function emit(tail) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:999999;overflow:auto;background:#06080c;' +
      'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  _pre.textContent = '==STESTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + (tail || 'ALL-PASS  diag') + '\n==STESTEST-END==';
}

/* One shift, four hands, with everything about every call written down. */
function shift(seed, crew = 4) {
  clearSave();
  const g = new Game({ seed });
  g.startShift();
  const s = g.state;
  const board = { claims: new Map(), trucks: new Map() };
  for (const id of ['r2', 'r3', 'r4'].slice(0, crew - 1)) seatResponder(s, id);
  const bots = s.responders.map((r) => new CrewBot(g, r.id, crew > 1 ? board : null));
  bots.forEach((b, i) => { b.input = makeBotInput(i === 0 ? '' : `p${i + 1}`); });
  const kbSeats = bots.slice(0, Math.min(2, bots.length));
  const kb = kbSeats.length > 1 ? mergeBotInputs(kbSeats.map((b) => b.input)) : kbSeats[0].input;

  /* Per-call bookkeeping the state itself does not keep. */
  const seen = new Map();          // incidentId -> record
  const track = () => {
    for (const inc of s.incidents) {
      let rec = seen.get(inc.id);
      if (!rec) {
        rec = {
          id: inc.id, family: inc.family, template: inc.templateId, place: inc.place,
          created: inc.createdMs, firstOnScene: null, firstPriority: inc.priority,
          worstPriority: inc.priority, resolved: null, status: null,
          peakDanger: 0, burnt: 0, victims: 0, lostVictims: 0, delivered: 0,
          treated: 0, everWorked: false,
        };
        seen.set(inc.id, rec);
      }
      if (rec.firstOnScene == null && inc.everWorked) rec.firstOnScene = s.simTimeMs;
      rec.everWorked = rec.everWorked || !!inc.everWorked;
      rec.worstPriority = inc.priority;
      rec.peakDanger = Math.max(rec.peakDanger, inc.danger);
      if (inc.status === 'controlled' || inc.status === 'lost') {
        if (rec.resolved == null) {
          rec.resolved = inc.resolvedMs;
          rec.status = inc.status;
          const hz = s.hazards.filter((h) => inc.hazardIds.includes(h.id));
          rec.burnt = Math.max(0, ...hz.filter((h) => h.kind === 'fire').map(fireDamageFraction), 0);
        }
      }
      const vics = s.victims.filter((v) => v.incidentId === inc.id);
      rec.victims = Math.max(rec.victims, vics.length);
      rec.lostVictims = vics.filter((v) => v.lost).length;
      rec.delivered = vics.filter((v) => v.delivered).length;
      rec.treated = vics.filter((v) => v.treatedAtMs != null).length;
    }
  };

  /* Time budget per seat. Classified from STATE, not from what the bot thinks it is
     doing — a bot that believes it is driving to a fire while wedged against a kerb
     should show up as a stationary cab, which is the whole point of measuring this. */
  const budget = s.responders.map((r) => ({
    id: r.id, driving: 0, stalled: 0, walking: 0, working: 0, idle: 0, metres: 0, jobs: 0,
  }));
  const prevPos = new Map(s.responders.map((r) => [r.id, { x: r.x, y: r.y }]));

  for (let t = 0; t < CONFIG.shift.durationMs + 2000; t += STEP) {
    for (const b of bots) b.think();
    for (let i = 2; i < bots.length; i++) {
      s.responders[i].remote = true;
      g.setRemoteCommand(s.responders[i].id, encodeCommand(readCommand(bots[i].input, `p${i + 1}`)));
    }
    g.frame(STEP, kb);
    track();
    for (const bg of budget) {
      const r = s.responders.find((q) => q.id === bg.id);
      if (!r) continue;
      const p = prevPos.get(r.id);
      const moved = p ? Math.hypot(r.x - p.x, r.y - p.y) : 0;
      bg.metres += moved;
      prevPos.set(r.id, { x: r.x, y: r.y });
      const secs = STEP / 1000;
      const ap = r.inVehicleId ? s.apparatus.find((q) => q.id === r.inVehicleId) : null;
      if (ap) { if (Math.abs(ap.speed) > 1) bg.driving += secs; else bg.stalled += secs; }
      else if (moved > 0.02) bg.walking += secs;
      else if (r.toolId || r.draggingVictimId) bg.working += secs;
      else bg.idle += secs;
    }
    if (s.mode !== MODES.PLAYING) break;
  }
  if (s.mode === MODES.PLAYING) { s.simTimeMs = CONFIG.shift.durationMs; g.endShift(); }
  track();
  for (let i = 0; i < budget.length; i++) budget[i].jobs = bots[i] ? bots[i].jobsAttempted : 0;
  return {
    report: s.report, calls: [...seen.values()], state: s, budget,
    logs: bots.map((b) => ({ id: b.responderId, log: b.log.slice() })),
    wedges: bots.flatMap((b) => b.wedges.map((w) => ({ ...w, id: b.responderId }))),
  };
}

/* ── 1. every call of one shift, in full ─────────────────────────────────── */
const SEEDS = [101, 303, 505];
const all = [];
for (const seed of SEEDS) {
  const { report, calls, budget, logs, wedges } = shift(seed);
  all.push({ seed, report, calls, budget, logs, wedges });
  emit(`ran seed ${seed}`);
}

lines.push('=== 1. every call, three shifts, four hands ===');
lines.push('  seed  family    template            pri   born   on scene   ended   outcome  burnt  vics t/d/lost');
lines.push('  ----  --------  ------------------  ----  -----  ---------  ------  -------  -----  ------------');
for (const { seed, calls } of all) {
  for (const c of calls.sort((a, b) => a.created - b.created)) {
    const arrive = c.firstOnScene == null ? '   never' : lp(f((c.firstOnScene - c.created) / 1000, 0) + 's', 8);
    lines.push(`  ${lp(seed, 4)}  ${pad(c.family, 8)}  ${pad(c.template, 18)}  ${pad(c.worstPriority.slice(0, 4), 4)}  ` +
      `${lp(f(c.created / 1000, 0), 5)}  ${arrive}   ${lp(c.resolved == null ? '-' : f(c.resolved / 1000, 0), 6)}  ` +
      `${pad(c.status || 'open', 7)}  ${lp(c.burnt ? f(c.burnt * 100, 0) + '%' : '-', 5)}  ` +
      `${c.victims} ${c.treated}/${c.delivered}/${c.lostVictims}`);
  }
}

/* ── 2. what actually decided each outcome ───────────────────────────────── */
const flat = all.flatMap((a) => a.calls);
const closed = flat.filter((c) => c.status);
const lost = closed.filter((c) => c.status === 'lost');
const won = closed.filter((c) => c.status === 'controlled');
const never = flat.filter((c) => c.firstOnScene == null);

lines.push('');
lines.push('=== 2. why the lost ones were lost ===');
const reason = (c) => {
  if (c.firstOnScene == null) return 'nobody ever went';
  if (c.lostVictims > 0) return 'somebody died';
  if (c.burnt >= 0.6) return 'building gutted (>=60%)';
  if (c.peakDanger >= CONFIG.dispatch.lostAt) return 'danger ran out the clock';
  return 'other';
};
const tally = new Map();
for (const c of lost) tally.set(reason(c), (tally.get(reason(c)) || 0) + 1);
lines.push(`  ${flat.length} calls over ${SEEDS.length} shifts: ${won.length} controlled, ${lost.length} lost, ` +
  `${flat.length - closed.length} still open at the bell`);
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`    ${pad(k, 26)} ${lp(v, 3)}   (${f((v / lost.length) * 100, 0)}% of the losses)`);
}
lines.push(`  never attended at all: ${never.length} of ${flat.length} calls ` +
  `(${f((never.length / flat.length) * 100, 0)}%)`);

/* ── 3. how long it takes to get anywhere ────────────────────────────────── */
const attended = flat.filter((c) => c.firstOnScene != null);
const resp = attended.map((c) => (c.firstOnScene - c.created) / 1000).sort((a, b) => a - b);
lines.push('');
lines.push('=== 3. response time, for the calls anybody reached ===');
lines.push(`  ${resp.length} of ${flat.length} reached · fastest ${f(resp[0], 0)}s · ` +
  `median ${f(resp[Math.floor(resp.length / 2)], 0)}s · slowest ${f(resp[resp.length - 1], 0)}s`);
const wonR = won.filter((c) => c.firstOnScene != null).map((c) => (c.firstOnScene - c.created) / 1000);
const lostR = lost.filter((c) => c.firstOnScene != null).map((c) => (c.firstOnScene - c.created) / 1000);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
lines.push(`  mean to a call that was WON:  ${f(mean(wonR), 0)}s  (n=${wonR.length})`);
lines.push(`  mean to a call that was LOST: ${f(mean(lostR), 0)}s  (n=${lostR.length})`);

/* ── 4. the medical chain, link by link ──────────────────────────────────── */
lines.push('');
lines.push('=== 4. the medical chain ===');
let vTotal = 0, vTreated = 0, vDelivered = 0, vLost = 0;
for (const { calls } of all) {
  for (const c of calls) {
    vTotal += c.victims; vTreated += c.treated; vDelivered += c.delivered; vLost += c.lostVictims;
  }
}
lines.push(`  casualties in the town: ${vTotal}`);
lines.push(`    reached and treated:  ${vTreated}  (${f((vTreated / Math.max(1, vTotal)) * 100, 0)}%)`);
lines.push(`    delivered to clinic:  ${vDelivered}  (${f((vDelivered / Math.max(1, vTotal)) * 100, 0)}%)`);
lines.push(`    lost:                 ${vLost}  (${f((vLost / Math.max(1, vTotal)) * 100, 0)}%)`);

/* ── 5. is the dispatcher outrunning any possible crew? ──────────────────── */
lines.push('');
lines.push('=== 5. call arrival vs. how long a call takes to work ===');
for (const { seed, calls } of all) {
  const born = calls.map((c) => c.created / 1000).sort((a, b) => a - b);
  const gaps = born.slice(1).map((v, i) => v - born[i]);
  /* ⚠ A call the bell caught has status but NO resolvedMs, and `null - 258000` is a
     large negative number that a mean happily swallows. The first run of this printed
     "mean time on scene -110s". */
  const worked = calls.filter((c) => c.status && c.firstOnScene != null)
    .map((c) => ((c.resolved == null ? CONFIG.shift.durationMs : c.resolved) - c.firstOnScene) / 1000)
    .filter((v) => v >= 0);
  lines.push(`  seed ${seed}: ${calls.length} calls in ${f(CONFIG.shift.durationMs / 1000, 0)}s · ` +
    `a new one every ${f(mean(gaps), 0)}s on average · ` +
    `mean time on scene ${f(mean(worked), 0)}s (n=${worked.length})`);
}
lines.push(`  CONFIG: lostAt danger ${CONFIG.dispatch.lostAt}, shift ${f(CONFIG.shift.durationMs / 1000, 0)}s`);

/* ── 6. and what a shift report says about all that ──────────────────────── */
lines.push('');
lines.push('=== 6. the report the player is handed ===');
for (const { seed, report: r } of all) {
  lines.push(`  seed ${seed}: ${r.controlled}/${r.calls} controlled · ${r.lost} lost · ` +
    `${r.patientsSaved} to the clinic · confidence ${f(r.confidenceEnd * 100, 0)}%`);
}


/* ── 7. where the crew's ten minutes actually goes ───────────────────────── */
lines.push('');
lines.push('=== 7. the crew time budget ===');
lines.push('  Every claim this project makes about playability is measured through the bot,');
lines.push('  so if the bot is slow the town only LOOKS hard. This is the bot audited as an');
lines.push('  instrument: 600 seconds per seat, classified every frame.');
lines.push('');
lines.push('  seed  seat  driving  in cab   walking  working   idle   dist. driven  calls taken');
lines.push('  ----  ----  -------  -------  -------  -------  ------  ------------  -----------');
for (const { seed, budget } of all) {
  for (const b of budget) {
    lines.push(`  ${lp(seed, 4)}  ${pad(b.id, 4)}  ${lp(f(b.driving, 0) + 's', 7)}  ` +
      `${lp(f(b.stalled, 0) + 's', 7)}  ${lp(f(b.walking, 0) + 's', 7)}  ` +
      `${lp(f(b.working, 0) + 's', 7)}  ${lp(f(b.idle, 0) + 's', 6)}  ` +
      `${lp(f(b.metres, 0) + ' m', 12)}  ${lp(b.jobs, 11)}`);
  }
}
const sum = (k) => all.flatMap((a) => a.budget).reduce((n, b) => n + b[k], 0);
const seats = all.flatMap((a) => a.budget).length;
lines.push('');
lines.push(`  averaged over ${seats} seat-shifts: driving ${f(sum('driving') / seats, 0)}s · ` +
  `sat in a stationary cab ${f(sum('stalled') / seats, 0)}s · on foot ${f(sum('walking') / seats, 0)}s · ` +
  `hands on a job ${f(sum('working') / seats, 0)}s · idle ${f(sum('idle') / seats, 0)}s`);
lines.push(`  a shift is ${f(CONFIG.shift.durationMs / 1000, 0)}s, so ` +
  `${f((sum('working') / seats / (CONFIG.shift.durationMs / 1000)) * 100, 0)}% of a volunteer's ` +
  `shift is spent doing the job and ${f(((sum('driving') + sum('walking') + sum('stalled')) / seats / (CONFIG.shift.durationMs / 1000)) * 100, 0)}% getting there.`);

/* ── 8. the worst single call, narrated by the bot that took it ──────────── */
lines.push('');
lines.push('=== 8. the slowest response of the three shifts, in the bot own words ===');
const slowest = flat.filter((c) => c.firstOnScene != null)
  .sort((a, b) => (b.firstOnScene - b.created) - (a.firstOnScene - a.created))[0];
if (slowest) {
  const owner = all.find((a) => a.calls.includes(slowest));
  lines.push(`  ${slowest.template} at ${slowest.place} (seed ${owner.seed}): called at ` +
    `${f(slowest.created / 1000, 0)}s, first boots on the ground ` +
    `${f((slowest.firstOnScene - slowest.created) / 1000, 0)}s later.`);
  const from = Math.round(slowest.created / 1000) - 4;
  const to = Math.round(slowest.firstOnScene / 1000) + 2;
  for (const b of owner.logs) {
    const win = b.log.filter((l) => {
      const t = parseInt(l, 10);
      return t >= from && t <= to;
    });
    if (!win.length) continue;
    lines.push(`    -- ${b.id} --`);
    for (const l of win.slice(0, 18)) lines.push(`       ${l}`);
  }
}

/* ── 9. where the trucks jam, and on what ────────────────────────────────── */
lines.push('');
lines.push('=== 9. every jam, and what was next to it ===');
lines.push('  A truck that stops moving for 1.4 s makes the bot back off, and four of those');
lines.push('  in a row make it abandon the truck and WALK the rest of the call. That latch is');
lines.push('  the difference between the seeds that go well and the ones that do not, so this');
lines.push('  asks what the truck was actually stuck ON.');
const wedges = all.flatMap((a) => a.wedges.map((w) => ({ ...w, seed: a.seed })));
const TRUCK_LEN = 8.4;
const onAnother = wedges.filter((w) => w.nearestTruckM < TRUCK_LEN * 1.6);
const atStationApron = wedges.filter((w) => atStation(w.x, w.y, CONFIG.town.stationTidyRadiusM));
lines.push('');
lines.push(`  ${wedges.length} jams over ${SEEDS.length} shifts ` +
  `(${f(wedges.length / (SEEDS.length * 4), 1)} per seat-shift)`);
lines.push(`    with another appliance inside ${f(TRUCK_LEN * 1.6, 0)} m:  ` +
  `${lp(onAnother.length, 3)}  (${f((onAnother.length / Math.max(1, wedges.length)) * 100, 0)}%)`);
lines.push(`    within the station's tidy radius:        ` +
  `${lp(atStationApron.length, 3)}  (${f((atStationApron.length / Math.max(1, wedges.length)) * 100, 0)}%)`);
const spread = wedges.map((w) => w.nearestTruckM).filter(Number.isFinite).sort((a, b) => a - b);
if (spread.length) {
  lines.push(`    nearest other truck at the moment of the jam: ` +
    `closest ${f(spread[0], 1)} m · median ${f(spread[Math.floor(spread.length / 2)], 1)} m · ` +
    `furthest ${f(spread[spread.length - 1], 1)} m`);
}
lines.push('');
lines.push('  seed  seat   t     where                 nearest truck');
lines.push('  ----  ----  ----  --------------------  -------------');
for (const w of wedges.sort((a, b) => a.seed - b.seed || a.t - b.t).slice(0, 30)) {
  const near = BUILDINGS.slice().sort((a, b) =>
    dist(w.x, w.y, a.x + a.w / 2, a.y + a.h / 2) - dist(w.x, w.y, b.x + b.w / 2, b.y + b.h / 2))[0];
  const d = near ? dist(w.x, w.y, near.x + near.w / 2, near.y + near.h / 2) : Infinity;
  const place = atStation(w.x, w.y, CONFIG.town.stationTidyRadiusM) ? 'the station apron'
    : d < 26 ? near.name : 'open road';
  lines.push(`  ${lp(w.seed, 4)}  ${pad(w.id, 4)}  ${lp(f(w.t / 1000, 0), 4)}  ${pad(place, 20)}  ` +
    `${lp(Number.isFinite(w.nearestTruckM) ? f(w.nearestTruckM, 1) + ' m' : '-', 13)}`);
}
if (wedges.length > 30) lines.push(`  ... and ${wedges.length - 30} more not listed`);
emit('ALL-PASS  diag');
window.requestAnimationFrame = () => 0;

