/* Dispatch — the signature system. GDD: "Players are choosing which problems not to
 * solve yet."
 *
 * The scheduler here is small on purpose. It decides WHEN the next call lands and
 * roughly what kind; everything that makes a call interesting — where, who is in it,
 * whether they are trapped, what it turns into — belongs to the incident and hazard
 * layers. A shift is a queue that keeps filling, never a mission list that empties.
 */

import { CONFIG } from '../config.js';
import { TEMPLATE_BY_ID, OPENING_LADDER, pickTemplate } from '../data/incidents.js';
import { createIncident, openIncidents } from './incidentSim.js';

export function createDispatchState() {
  return {
    nextCallAtMs: CONFIG.dispatch.firstCallMs,
    ladderIndex: 0,
    lastTemplateId: null,
    lastFamily: null,
    callsMade: 0,
    suppressedUntilMs: 0,
  };
}

/**
 * @returns {Array<object>} CALL_RECEIVED events
 */
export function stepDispatch(state, dtMs, rng) {
  const D = CONFIG.dispatch;
  const d = state.dispatch;
  const out = [];

  // Nothing new in the last stretch of a shift: the crew should get to finish something.
  const tailMs = 70000;
  if (state.simTimeMs + tailMs > CONFIG.shift.durationMs) return out;

  const open = openIncidents(state).length;

  // The board going clear pulls the next call forward. Checked here rather than only
  // at scheduling time, because the silence that matters is the silence AFTER a crew
  // finishes something, not the silence they were promised when the last call landed.
  if (open === 0 && d.nextCallAtMs > state.simTimeMs + D.quietCapMs) {
    d.nextCallAtMs = state.simTimeMs + D.quietCapMs;
  }

  if (state.simTimeMs < d.nextCallAtMs) return out;
  if (open >= D.maxActiveCalls) { d.nextCallAtMs = state.simTimeMs + 20000; return out; }

  /* Try a few kinds of call before giving up on the beat.
   *
   * One attempt was enough right up until a town got saturated: measured over five
   * neglected shifts (tools\_campaigndiag.js), five buildings ended up boarded and the
   * fifth shift produced ZERO calls — every attempt drew a structure fire, every
   * structure was gone, and a dispatcher with nothing to say is the one thing this
   * game cannot afford. A tree across a road or somebody's chest pain needs a different
   * kind of site, and there is almost always one of those left. */
  let template = null, inc = null;
  for (let attempt = 0; attempt < 4 && !inc; attempt++) {
    template = nextTemplate(state, rng, attempt > 0);
    inc = createIncident(state, template, rng);
    if (!inc) d.lastTemplateId = template.id;   // so the next draw picks something else
  }
  if (!inc) {
    // The whole town is occupied. Come back shortly rather than skipping the beat.
    d.nextCallAtMs = state.simTimeMs + 12000;
    return out;
  }

  d.callsMade++;
  d.lastTemplateId = template.id;
  d.lastFamily = template.family;
  if (d.ladderIndex < OPENING_LADDER.length) d.ladderIndex++;

  // Pressure-aware pacing: a crew already juggling two calls gets a little longer to
  // breathe than a crew standing on the apron. The queue still never empties.
  const load = Math.min(1, open / 3);
  const gap = rng.range(D.gapMinMs, D.gapMaxMs) * (0.75 + load * 0.55);
  d.nextCallAtMs = state.simTimeMs + (open === 0 ? Math.min(gap, D.quietCapMs) : gap);

  out.push({ type: 'CALL_RECEIVED', incidentId: inc.id, priority: inc.priority, text: inc.report });
  return out;
}

/**
 * @param {boolean} retry  true when the previous draw had nowhere to happen.
 *
 * The opening ladder is deliberate — a shift starts fire, crash, tree — but it must not
 * be a trap. On the fifth shift of a neglected town, half the buildings were boarded up
 * and the ladder's structure fire had nowhere to go; the retry drew the SAME pinned
 * template four times and the shift produced no calls at all. A dispatcher with nothing
 * to say is the one thing this game cannot afford, so a retry leaves the ladder and
 * takes whatever the town can still supply.
 */
function nextTemplate(state, rng, retry = false) {
  const d = state.dispatch;
  if (!retry && d.ladderIndex < OPENING_LADDER.length) {
    return TEMPLATE_BY_ID[OPENING_LADDER[d.ladderIndex]];
  }
  return pickTemplate(rng, { avoidId: d.lastTemplateId, avoidFamily: d.lastFamily });
}

/** Radio traffic. Bounded — a ten-minute shift generates a lot of it — and never
 *  repeats itself back to back, because a message worth hearing twice in a row is
 *  usually a bug rather than an emergency. */
export function radio(state, text, kind = 'dispatch') {
  const last = state.radio[state.radio.length - 1];
  if (last && last.text === text) { last.atMs = state.simTimeMs; return text; }
  state.radio.push({ atMs: state.simTimeMs, text, kind });
  if (state.radio.length > 40) state.radio.shift();
  return text;
}
