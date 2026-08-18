/* Apparatus and tools. GDD: "Vehicles determine capability and remain physical world
 * objects" and "Tools are general-purpose physical objects."
 *
 * The loadouts below are the whole difficulty curve of the MVP. Note what is NOT on
 * the engine: there is no medical kit. Take the engine to a crash and you have arrived
 * with the wrong truck, which is exactly the mistake the GDD wants the town to punish
 * mildly and the players to remember.
 */

export const APPARATUS_DEFS = [
  {
    id: 'engine', name: 'Engine 1', short: 'ENG', tint: '#c0392b',
    lengthM: 7.6, widthM: 2.6,
    maxSpeed: 17, accel: 5.0, reverseSpeed: 6, brake: 12, grip: 0.86,
    tankL: 2500, hose: true, patientBay: false,
    loadout: ['wrench', 'extinguisher'],
    blurb: 'Water and hose. Slow to get moving, slower to stop.',
  },
  {
    id: 'ambulance', name: 'Medic 1', short: 'MED', tint: '#ecf0f1',
    lengthM: 6.0, widthM: 2.3,
    maxSpeed: 21, accel: 6.6, reverseSpeed: 7, brake: 15, grip: 0.94,
    tankL: 0, hose: false, patientBay: true,
    loadout: ['medkit'],
    blurb: 'Patient care and the only ride to the clinic. Carries almost no rescue kit.',
  },
  {
    id: 'rescue', name: 'Rescue 1', short: 'RES', tint: '#e67e22',
    lengthM: 5.6, widthM: 2.2,
    maxSpeed: 19, accel: 7.2, reverseSpeed: 8, brake: 14, grip: 0.90,
    tankL: 0, hose: false, patientBay: false,
    loadout: ['chainsaw', 'spreaders', 'hotstick', 'gasmeter', 'extinguisher'],
    blurb: 'Saw, spreaders, hot stick, gas meter. No water, no stretcher.',
  },
];

export const APPARATUS_BY_ID = Object.freeze(Object.fromEntries(APPARATUS_DEFS.map((a) => [a.id, a])));

/* `mode` is what USE does while the tool is held:
 *   stream  — continuous water on whatever the nozzle is pointed at
 *   hold    — a progress action against one target (treat, cut, spread, de-energise)
 *   tap     — a single committed action at a fixture (hydrant, gas meter)
 *   passive — no use action; carrying it is the point (the meter reads the air)
 */
export const TOOL_DEFS = {
  hose: {
    id: 'hose', name: 'Hose line', short: 'HOSE', mode: 'stream',
    tetheredTo: 'engine', twoHanded: true,
    hint: 'Water only reaches as far as the hose does. Spot the engine first.',
  },
  extinguisher: {
    id: 'extinguisher', name: 'Extinguisher', short: 'EXT', mode: 'stream',
    capacityL: 9, twoHanded: false,
    hint: 'Nine litres. Good for a pan, a bin or a bonnet — not a building.',
  },
  medkit: {
    id: 'medkit', name: 'Medical kit', short: 'MED', mode: 'hold',
    target: 'victim', twoHanded: false,
    hint: 'Stabilises a patient. Buys time; it does not fix anything.',
  },
  chainsaw: {
    id: 'chainsaw', name: 'Chainsaw', short: 'SAW', mode: 'hold',
    target: 'tree', twoHanded: true,
    hint: 'Cuts a trunk out of the road, in sections.',
  },
  spreaders: {
    id: 'spreaders', name: 'Hydraulic spreaders', short: 'SPR', mode: 'hold',
    target: 'trapped', twoHanded: true,
    hint: 'The only way a trapped occupant comes out of a wreck.',
  },
  wrench: {
    id: 'wrench', name: 'Hydrant wrench', short: 'WRN', mode: 'hold',
    target: 'fixture', twoHanded: false,
    hint: 'Charges a hydrant into the engine, or shuts a gas meter off.',
  },
  hotstick: {
    id: 'hotstick', name: 'Insulated hot stick', short: 'STK', mode: 'hold',
    target: 'pole', twoHanded: true,
    hint: 'Kills the line at the pole. Nothing else you own will.',
  },
  gasmeter: {
    id: 'gasmeter', name: 'Gas meter', short: 'GAS', mode: 'passive',
    twoHanded: false,
    hint: 'Reads the air around you. Carrying it is what makes the invisible visible.',
  },
};

/** Spare kit that lives on the station apron, so a forgotten item is recoverable. */
export const RACK_ITEMS = ['medkit', 'extinguisher'];

/** Capability tags a tool satisfies, for the "wrong tool" telemetry counter. */
export const TOOL_CAPABILITIES = {
  hose: ['water'], extinguisher: ['water'], medkit: ['medical'],
  chainsaw: ['saw'], spreaders: ['rescue'], wrench: ['utility', 'water'],
  hotstick: ['utility'], gasmeter: ['meter'],
};
