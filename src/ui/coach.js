/* The coach — one line of guidance, read off the world.
 *
 * GDD Phase 0's exit gate is "driving across town is understandable without instructions
 * after one attempt", and implementation rule 3 forbids pausing an incident clock for a
 * tutorial. So this is not a tutorial. It is a pure function from the CURRENT state to
 * at most one short line, shown in the prompt the player is already reading, while the
 * town carries on around it.
 *
 * Three rules it holds itself to:
 *
 *   1. It never blocks. No modal, no pause, no "press E to continue". If the player
 *      ignores it and drives off, the line changes to suit wherever they went.
 *   2. It says the NEXT physical thing, never a lesson. "Take the hose from Engine 1"
 *      is guidance; "fires spread over time" is a manual.
 *   3. It stops. Each verb is retired the first time the player does it, and the whole
 *      thing goes quiet for good once they have done all five — carried across shifts,
 *      because somebody on their third shift does not need to be told which key gets
 *      them into a truck.
 */

import { toolsInReachOf, heldTool, contextPrompt } from '../sim/interaction.js';
import { openIncidents, incidentHazards, incidentVictims } from '../sim/incidentSim.js';
import { victimHandled } from '../sim/victims.js';
import { dist } from '../data/town.js';
import { CONFIG } from '../config.js';

/** The five verbs, in the order a first shift teaches them (CONFIG.coach.lessons). */
export const LESSONS = CONFIG.coach.lessons;

/** Which hazard wants which tool — the same shallow reading a player does off the call. */
function toolForScene(state, inc) {
  const hz = incidentHazards(state, inc);
  if (hz.some((h) => h.kind === 'power' && h.live)) return { defId: 'hotstick', why: 'the wire is live' };
  if (hz.some((h) => h.kind === 'gas' && !h.shutOff)) return { defId: 'wrench', why: 'gas is leaking' };
  if (hz.some((h) => h.kind === 'fire' && !h.resolved)) return { defId: 'hose', why: 'it is burning' };
  if (hz.some((h) => h.kind === 'wreck' && h.burning)) return { defId: 'hose', why: 'the car is alight' };
  if (incidentVictims(state, inc).some((v) => v.trappedBy && !v.lost)) {
    return { defId: 'spreaders', why: 'somebody is pinned' };
  }
  if (hz.some((h) => h.kind === 'tree' && !h.cleared)) return { defId: 'chainsaw', why: 'the road is blocked' };
  if (incidentVictims(state, inc).some((v) => !victimHandled(v) && !v.lost)) {
    return { defId: 'medkit', why: 'somebody is hurt' };
  }
  return null;
}

/**
 * @param {object} state
 * @param {{learned?: object, touch?: boolean}} opts  `learned` is the persisted set of
 *   verbs this player has already performed; `touch` swaps key names for button names.
 * @returns {{id: string, text: string}|null}
 */
export function nextHint(state, opts = {}) {
  const learned = opts.learned || {};
  if (LESSONS.every((l) => learned[l])) return null;      // they can play; be quiet
  if (state.mode !== 'playing') return null;

  const p = state.player;
  if (!p) return null;
  const key = (k, btn) => (opts.touch ? btn : k);
  const open = openIncidents(state);

  /* Nothing has happened yet. Say what the shift IS, once, rather than listing keys —
     the keys are on the title card and, on a phone, under the player's thumbs. */
  if (!open.length) {
    if (learned.ride) return null;
    return { id: 'wait', text: 'Quiet so far. Dispatch will call — the town does not wait for you.' };
  }

  // The call being worked, or the nearest one if none has been reached yet.
  const inc = open.slice().sort((a, b) =>
    dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y))[0];
  const onScene = dist(p.x, p.y, inc.x, inc.y) < 26;
  const want = toolForScene(state, inc);
  const held = heldTool(state, p);

  if (!p.inVehicleId && !onScene) {
    if (!learned.ride) {
      const ap = state.apparatus.slice().sort((a, b) =>
        dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y))[0];
      const named = want && want.defId === 'hose' ? 'Engine 1'
        : want && want.defId === 'medkit' ? 'Medic 1'
          : want ? 'Rescue 1' : ap.name;
      return { id: 'ride', text: `${inc.headline} at ${inc.place}. Take ${named} — ${key('E', 'the E button')} to get in.` };
    }
    if (!learned.drive) {
      return { id: 'drive', text: `${inc.place} is that way. ${key('W to pull away, A and D to steer', 'Push the stick to drive')}.` };
    }
  }

  /* Arriving outranks driving. Somebody parked at the call has plainly worked out the
     throttle, and being told how to drive while you are already there is the kind of
     thing that makes a player stop reading the line at all. */
  if (p.inVehicleId && onScene) {
    return { id: 'arrive', text: `You are here. ${key('E', 'The E button')} gets you out of the cab.` };
  }

  if (p.inVehicleId && !learned.drive) {
    return { id: 'drive', text: `Drive to ${inc.place}. ${key('W throttle, S brake and reverse', 'Push the stick forward; pull back to brake')}.` };
  }

  if (onScene && !held && want) {
    const inReach = toolsInReachOf(state, p.x, p.y);
    const slot = inReach.findIndex((a) => a.tool.defId === want.defId);
    if (slot >= 0) {
      return {
        id: 'equip',
        text: `${inReach[slot].tool.name} — ${want.why}. ${key(`Press ${slot + 1}`, 'Tap it below')} to take it.`,
      };
    }
    /* The kit is on a truck that is not here. This is the GDD's forgotten-kit beat, and
       being told about it once is the difference between learning it and being baffled. */
    const src = state.apparatus.find((a) =>
      state.tools.some((t) => t.carrier === a.id && t.defId === want.defId));
    if (src) return { id: 'equip', text: `Nothing here can do this. The kit for it is on ${src.name}.` };
  }

  if (onScene && held && !learned.use) {
    const ctx = contextPrompt(state, p);
    if (ctx && ctx.text.startsWith('take hold')) {
      return { id: 'use', text: `${key('E', 'The E button')} to take hold of them; then walk them to Medic 1.` };
    }
    return { id: 'use', text: `Face it and hold ${key('SPACE', 'USE')}. Keep holding — it takes a moment.` };
  }

  return null;
}

/**
 * Mark a verb learned from a simulation event. Called with the event stream, so the
 * coach retires each lesson the first time the player actually does the thing rather
 * than after a timer or a click.
 * @returns {boolean} true when something new was learned
 */
export function learnFromEvent(learned, type) {
  const map = {
    ENTERED_APPARATUS: 'ride',
    EXITED_APPARATUS: 'arrive',
    TOOL_TAKEN: 'equip',
    ROAD_CLEARED: 'use',
    PATIENT_TREATED: 'use',
    PATIENT_GRABBED: 'use',
    GAS_SHUT_OFF: 'use',
    LINE_DE_ENERGISED: 'use',
    HYDRANT_CHARGED: 'use',
    PATIENT_EXTRICATED: 'use',
    CREW_ON_SCENE: 'arrive',
  };
  const lesson = map[type];
  if (!lesson || learned[lesson]) return false;
  learned[lesson] = true;
  return true;
}

/** Driving is learned by doing it, not by an event: half a block counts. */
export function learnFromDistance(learned, metresDriven) {
  if (learned.drive || metresDriven < CONFIG.coach.driveLearnedM) return false;
  learned.drive = true;
  return true;
}
