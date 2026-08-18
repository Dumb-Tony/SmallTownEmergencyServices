/* The incident catalogue — GDD "Emergencies are combinations of reusable systems,
 * not bespoke minigames."
 *
 * A template says WHERE a call can happen, WHAT hazards it seeds, and HOW the caller's
 * story changes over time. It does not say how any of it is solved: the hazard systems
 * own that, so a chainsaw works on any tree and a hose works on any fire.
 *
 * `setup` is declarative on purpose (GDD implementation rule 2: prefer small
 * data-driven additions over family-specific branches). src/sim/incidentSim.js is the
 * only file that knows how to read it, and it reads the same six keys for all
 * eleven templates below.
 */

export const FAMILIES = Object.freeze({
  FIRE: 'fire', CRASH: 'crash', TREE: 'tree', MEDICAL: 'medical', UTILITY: 'utility',
});

export const PRIORITIES = Object.freeze(['routine', 'high', 'critical']);
export const PRIORITY_RANK = Object.freeze({ routine: 0, high: 1, critical: 2 });

/** Structure kinds a working fire may be reported in. The station and the clinic are
 *  excluded — burning down your own hall is a joke that only lands once. */
const BURNABLE = ['shop', 'house', 'housing', 'industry', 'barn', 'civic'];

export const TEMPLATES = [
  /* ── fire ─────────────────────────────────────────────────────────────── */
  {
    id: 'kitchen_fire',
    family: FAMILIES.FIRE,
    headline: 'Structure fire',
    weight: 10,
    site: { kind: 'building', kinds: ['shop', 'house', 'housing'] },
    priority: 'high',
    dangerPerSec: 0.0025,
    capabilities: ['water', 'hose'],
    report: [
      'Caller reports smoke coming from the kitchen at {place}. Unclear if anyone is still inside.',
      'Neighbour at {place} says the fire alarm is going and there is smoke at the back.',
      'Kitchen fire at {place}. Caller says they tried a pan lid and it did not work.',
    ],
    setup: {
      fire: { cells: 2, heat: 0.95, from: 'door' },
      victims: [{ state: 'stable', where: 'inside', chance: 0.55, panics: true }],
    },
    updates: [
      { atMs: 45000,  text: 'Second caller at {place} now reports flame showing at a window.', priority: 'high' },
      { atMs: 120000, text: 'Dispatch: multiple callers on {place}. Assume the fire has extended.', priority: 'critical' },
    ],
  },
  {
    id: 'barn_fire',
    family: FAMILIES.FIRE,
    headline: 'Barn fire',
    weight: 5,
    site: { kind: 'building', kinds: ['barn', 'industry'] },
    priority: 'high',
    dangerPerSec: 0.0035,
    capabilities: ['water', 'hose'],
    report: [
      'Passer-by reports heavy smoke from {place}. Nobody has been able to raise the owner.',
      'Fire showing at {place}. Caller is worried about what is stored inside.',
    ],
    setup: { fire: { cells: 3, heat: 1.0, from: 'centre' } },
    updates: [
      { atMs: 60000,  text: 'Caller at {place} says the whole roofline is alight now.', priority: 'critical' },
      { atMs: 150000, text: 'Dispatch: exposures at {place} are threatened. Consider a water supply.', priority: 'critical' },
    ],
  },
  {
    id: 'vehicle_fire',
    family: FAMILIES.FIRE,
    headline: 'Vehicle fire',
    weight: 6,
    site: { kind: 'crash' },
    priority: 'routine',
    dangerPerSec: 0.0018,
    capabilities: ['water'],
    report: [
      'Car well alight at {place}. Driver is out and walking around.',
      'Smoke from under the bonnet of a pickup at {place}. Occupants are clear.',
    ],
    setup: {
      wreck: { count: 1, fuelLeak: 1.0, burning: true },
      victims: [{ state: 'stable', where: 'street', chance: 0.7 }],
    },
    updates: [
      { atMs: 50000, text: 'Caller at {place} says the fire has spread to the grass verge.', priority: 'high' },
    ],
  },

  /* ── crash ────────────────────────────────────────────────────────────── */
  {
    id: 'two_car',
    family: FAMILIES.CRASH,
    headline: 'Two-vehicle collision',
    weight: 9,
    site: { kind: 'crash' },
    priority: 'high',
    dangerPerSec: 0.0020,
    capabilities: ['medical', 'rescue'],
    report: [
      'Two vehicles into each other at {place}. Caller thinks somebody is hurt.',
      'Collision at {place}. One car is across the lane and the road is partly blocked.',
      'Crash at {place}. Caller is a passing motorist and will not get out of their car.',
    ],
    setup: {
      wreck: { count: 2, fuelLeak: 0.4 },
      victims: [
        { state: 'injured',  where: 'wreck',  trapped: 0.4 },
        { state: 'stable',   where: 'street', chance: 0.8 },
      ],
    },
    updates: [
      { atMs: 55000,  text: 'Update from {place}: one of the drivers is not answering the caller now.', priority: 'high' },
      { atMs: 140000, text: 'Dispatch: still no crew on scene at {place}. Caller sounds frightened.', priority: 'critical' },
    ],
  },
  {
    id: 'crash_pole',
    family: FAMILIES.CRASH,
    headline: 'Vehicle into a pole',
    weight: 7,
    site: { kind: 'crash', nearPole: true },
    priority: 'critical',
    dangerPerSec: 0.0028,
    capabilities: ['rescue', 'medical', 'utility'],
    report: [
      'Single vehicle into a power pole at {place}. Caller says wires are down across the road.',
      'Car has taken out a pole at {place}. There is a line on the ground and the driver is still inside.',
    ],
    setup: {
      wreck: { count: 1, fuelLeak: 0.5 },
      power: { at: 'nearestPole' },
      victims: [{ state: 'injured', where: 'wreck', trapped: 0.85 }],
    },
    updates: [
      { atMs: 40000,  text: 'Caller at {place} is being told to stay in their vehicle. The line is arcing.', priority: 'critical' },
      { atMs: 110000, text: 'Power co-op advised of the pole at {place}. They have a long ETA.', priority: 'critical' },
    ],
  },

  /* ── tree ─────────────────────────────────────────────────────────────── */
  {
    id: 'tree_down',
    family: FAMILIES.TREE,
    headline: 'Tree down',
    weight: 8,
    site: { kind: 'tree' },
    priority: 'routine',
    dangerPerSec: 0.0010,
    capabilities: ['saw'],
    report: [
      'Large limb down across {place}. Nobody hurt, but nothing is getting past it.',
      'Tree over the road at {place}. Caller has stopped their car and is waiting.',
    ],
    setup: { tree: { blocks: true } },
    updates: [
      { atMs: 90000, text: 'Dispatch: traffic is backing up at {place}. Still blocked.', priority: 'high' },
    ],
  },
  {
    id: 'tree_on_car',
    family: FAMILIES.TREE,
    headline: 'Tree onto a vehicle',
    weight: 4,
    site: { kind: 'tree' },
    priority: 'high',
    dangerPerSec: 0.0024,
    capabilities: ['saw', 'rescue', 'medical'],
    report: [
      'Tree has come down onto a car at {place}. Caller can hear someone inside.',
      'Vehicle trapped under a tree at {place}. Occupant is talking but cannot get the door open.',
    ],
    setup: {
      tree: { blocks: true },
      wreck: { count: 1, fuelLeak: 0.15 },
      victims: [{ state: 'injured', where: 'wreck', trapped: 1.0 }],
    },
    updates: [
      { atMs: 65000, text: 'Caller at {place} says the person in the car has gone quiet.', priority: 'critical' },
    ],
  },

  /* ── medical ──────────────────────────────────────────────────────────── */
  {
    id: 'chest_pain',
    family: FAMILIES.MEDICAL,
    headline: 'Medical — chest pain',
    weight: 9,
    site: { kind: 'building', kinds: [...BURNABLE, 'clinic'] },
    priority: 'high',
    dangerPerSec: 0.0023,
    capabilities: ['medical', 'transport'],
    report: [
      'Man at {place} with chest pain. Conscious, breathing, grey looking.',
      'Caller at {place} says her husband has crushing chest pain and will not sit down.',
    ],
    setup: { victims: [{ state: 'critical', where: 'inside' }] },
    updates: [
      { atMs: 60000,  text: 'Update from {place}: the patient is now very short of breath.', priority: 'critical' },
      { atMs: 130000, text: 'Dispatch: caller at {place} is asking how much longer.', priority: 'critical' },
    ],
  },
  {
    id: 'fall_outdoor',
    family: FAMILIES.MEDICAL,
    headline: 'Medical — fall',
    weight: 7,
    site: { kind: 'outdoor' },
    priority: 'routine',
    dangerPerSec: 0.0012,
    capabilities: ['medical'],
    report: [
      'Someone has come off a bike at {place}. Awake, but not getting up.',
      'Fall at {place}. Caller says there is a lot of blood but the person is talking.',
    ],
    setup: { victims: [{ state: 'injured', where: 'street' }] },
    updates: [
      { atMs: 80000, text: 'Caller at {place} says the patient has gone pale and cold.', priority: 'high' },
    ],
  },
  {
    id: 'farm_entrapment',
    family: FAMILIES.MEDICAL,
    headline: 'Medical — entrapment',
    weight: 4,
    site: { kind: 'outdoor' },
    priority: 'critical',
    dangerPerSec: 0.0030,
    capabilities: ['rescue', 'medical', 'transport'],
    report: [
      'Someone pinned under machinery at {place}. Caller cannot lift it alone.',
      'Worker trapped at {place}. Conscious, one leg caught.',
    ],
    setup: {
      wreck: { count: 1, fuelLeak: 0.1, kind: 'machine' },
      victims: [{ state: 'critical', where: 'wreck', trapped: 1.0 }],
    },
    updates: [
      { atMs: 70000, text: 'Caller at {place} says the patient is drifting in and out.', priority: 'critical' },
    ],
  },

  /* ── utility ──────────────────────────────────────────────────────────── */
  {
    id: 'gas_odour',
    family: FAMILIES.UTILITY,
    headline: 'Gas odour',
    weight: 7,
    site: { kind: 'building', kinds: BURNABLE, needsGas: true },
    priority: 'high',
    dangerPerSec: 0.0019,
    capabilities: ['utility', 'meter'],
    report: [
      'Strong smell of gas at {place}. Caller has gone outside.',
      'Gas odour reported at {place}. Caller says it is worse near the meter.',
      'Someone at {place} can smell gas and has, unhelpfully, lit a cigarette outside.',
    ],
    setup: {
      gas: { at: 'meter' },
      victims: [{ state: 'stable', where: 'street', chance: 0.5 }],
    },
    updates: [
      { atMs: 55000,  text: 'Update: the smell at {place} is now noticeable from the street.', priority: 'high' },
      { atMs: 125000, text: 'Dispatch: consider the gas at {place} a serious hazard. Nothing is shut off yet.', priority: 'critical' },
    ],
  },
  {
    id: 'line_down',
    family: FAMILIES.UTILITY,
    headline: 'Power line down',
    weight: 6,
    site: { kind: 'crash', nearPole: true },
    priority: 'high',
    dangerPerSec: 0.0017,
    capabilities: ['utility'],
    report: [
      'Line down across {place}. It is sparking and people are driving around it.',
      'Power line on the road at {place}. Caller says a branch brought it down.',
    ],
    setup: { power: { at: 'nearestPole' } },
    updates: [
      { atMs: 75000, text: 'Caller at {place} says a car just drove over the line.', priority: 'critical' },
    ],
  },
];

export const TEMPLATE_BY_ID = Object.freeze(Object.fromEntries(TEMPLATES.map((t) => [t.id, t])));

/**
 * The first three calls of a shift are drawn from this ladder rather than the weighted
 * pool. GDD "acceptance test: the signature scenario" needs a fire, then a crash with a
 * utility hazard, then a route blockage to be POSSIBLE within one shift — this schedules
 * the families in that order and leaves every beat after that to the systems. Locations,
 * victims, entrapment, spread, ignition and route choice are all still emergent.
 */
export const OPENING_LADDER = ['kitchen_fire', 'crash_pole', 'tree_down'];

/** Weighted draw, avoiding an immediate repeat of the same template. */
export function pickTemplate(rng, { avoidId = null, avoidFamily = null } = {}) {
  const pool = TEMPLATES.filter((t) => t.id !== avoidId);
  let total = 0;
  for (const t of pool) total += t.weight * (t.family === avoidFamily ? 0.35 : 1);
  let roll = rng.float() * total;
  for (const t of pool) {
    roll -= t.weight * (t.family === avoidFamily ? 0.35 : 1);
    if (roll <= 0) return t;
  }
  return pool[pool.length - 1];
}

export function formatReport(text, place) { return text.replace(/\{place\}/g, place); }
