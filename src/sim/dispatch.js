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
  if (state.simTimeMs < d.nextCallAtMs) return out;

  const open = openIncidents(state).length;
  if (open >= D.maxActiveCalls) { d.nextCallAtMs = state.simTimeMs + 20000; return out; }

  const template = nextTemplate(state, rng);
  const inc = createIncident(state, template, rng);
  if (!inc) {
    // Every site this template can use is already on fire. Try again shortly with
    // something else rather than skipping the beat entirely.
    d.lastTemplateId = template.id;
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
  d.nextCallAtMs = state.simTimeMs + gap;

  out.push({ type: 'CALL_RECEIVED', incidentId: inc.id, priority: inc.priority, text: inc.report });
  return out;
}

function nextTemplate(state, rng) {
  const d = state.dispatch;
  if (d.ladderIndex < OPENING_LADDER.length) {
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
