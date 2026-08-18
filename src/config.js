/* Central tuning — GDD "Claude implementation rules" §2: prefer small data-driven
 * additions. Every number a designer would want to turn lives here or in src/data/.
 *
 * Units: distances in METRES, times in MILLISECONDS, speeds in metres/second,
 * water in LITRES. The town is authored at real-world scale so that travel time —
 * the GDD's primary source of pressure — stays honest.
 */

export const CONFIG = {

  /* ── simulation ─────────────────────────────────────────────────────────── */
  sim: {
    stepMs: 1000 / 60,
    maxFrameMs: 250,       // frame gaps above this are DISCARDED, not banked
    defaultSeed: 20260818,
    seedLabel: 'shift_1',
  },

  /* ── shift ──────────────────────────────────────────────────────────────── */
  shift: {
    durationMs: 600000,    // 10 minutes of town time
    quietOpeningMs: 18000, // GDD core loop step 1: "spawn at station with quiet time"
  },

  /* ── world ──────────────────────────────────────────────────────────────── */
  world: { widthM: 420, heightM: 300 },

  /* ── presentation ───────────────────────────────────────────────────────── */
  render: {
    // Readability budget, not taste: at 118 m across a 1600 px window that is ~13.5
    // px/m, so a 4.6 m fire engine is ~62 px and a person ~9 px. Wide enough to see
    // the next intersection while driving, tight enough to read a hose lay.
    viewWidthM: 118,
    viewWidthOnFootM: 76,  // zoom in when out of the cab; the work is close-up
    followLerp: 5,
    fitPaddingM: 6,
    maxPixelRatio: 2,
    zoomLerp: 3.5,
  },

  /* ── responder on foot ──────────────────────────────────────────────────── */
  player: {
    radiusM: 0.36,
    maxSpeed: 4.0,         // brisk jog
    carrySpeedMul: 0.52,   // dragging a patient, or humping a charged hose line
    accel: 26,
    friction: 20,
    reachM: 2.2,           // grab / use / enter range
    shockStunMs: 3200,     // touching a live line: knocked down, not killed
    shockKnockback: 7.0,
    heatHurtPerSec: 0.22,  // standing in fire costs stamina, not lives
    staminaRecoverPerSec: 0.10,
  },

  /* ── apparatus ──────────────────────────────────────────────────────────── */
  drive: {
    steerRateDeg: 96,      // degrees/sec at full lock, scaled by speed
    steerSpeedFalloff: 15, // m/s at which steering authority has halved
    offRoadMul: 0.44,      // grass is a decision, not a shortcut
    offRoadDrag: 2.4,
    reverseMul: 0.42,
    brakeDecel: 14,
    idleDrag: 1.5,
    collisionBounce: 0.28,
    collisionDamage: 0.9,  // damage per m/s of impact above the threshold
    collisionFreeSpeed: 4, // bumps below this do not mark the apparatus
    sirenClearRadiusM: 26, // traffic and pedestrians yield inside this
  },

  /* ── water ──────────────────────────────────────────────────────────────── */
  water: {
    nozzleFlowLps: 12,     // litres/second at the nozzle
    streamReachM: 8.5,
    streamHalfAngleDeg: 15,
    hoseMaxLengthM: 34,    // park badly and the fire is simply out of reach
    hydrantHookupM: 7.0,   // how close the engine must be spotted to a hydrant
    hydrantSupplyLps: 22,  // refill rate once hooked up
    coolPerLitre: 0.020,   // heat removed per litre landed on a cell
    wetPerLitre: 0.030,
  },

  /* ── fire ───────────────────────────────────────────────────────────────── */
  fire: {
    cellM: 4,
    ignitionHeat: 0.62,    // a cell catches above this
    burnHeatGain: 0.30,    // heat/sec a burning cell adds to itself
    spreadPerSec: 0.22,    // heat/sec pushed into each neighbour
    diagonalMul: 0.55,
    fuelBurnPerSec: 0.030, // ~33 s of fuel per cell at full burn
    coolPerSec: 0.045,     // ambient cooling when nothing is burning
    wetDecayPerSec: 0.020,
    jumpDistM: 9,          // exposure distance to the next structure
    jumpChancePerSec: 0.05,
    smokePerSec: 2.4,
    dangerPerBurningCell: 0.055,
  },

  /* ── gas ────────────────────────────────────────────────────────────────── */
  gas: {
    leakRatePerSec: 0.055, // concentration/sec at the source
    dispersePerSec: 0.012,
    cloudRadiusM: 11,
    ignitionThreshold: 0.42,
    ignitionSourceM: 7,    // fire or an arcing line this close lights it
    flashDamage: 0.30,     // structure damage from a flash
    flashKnockbackM: 12,
  },

  /* ── electricity ────────────────────────────────────────────────────────── */
  power: {
    liveRadiusM: 6.5,
    wetSpreadMul: 1.9,     // standing water carries it further
    utilityEtaMs: 240000,  // the power co-op will get there eventually
    arcPerSec: 1.0,
  },

  /* ── medical ────────────────────────────────────────────────────────────── */
  medical: {
    declineStable: 0.0010,   // condition lost per second, by presenting state
    declineInjured: 0.0055,
    declineCritical: 0.0170,
    declineTrappedMul: 1.45,
    declineFireMul: 2.2,     // being next to an active fire is not neutral
    treatMs: 5200,           // holding a medkit on a patient
    treatGain: 0.22,
    treatDeclineMul: 0.35,   // stabilised: buys time, does not cure
    treatDurationMs: 150000,
    extricateMs: 9000,       // spreaders on a trapped occupant
    loadMs: 3000,
    clinicHandoverMs: 4000,
    criticalAt: 0.34,        // below this the patient is reported critical
  },

  /* ── tools ──────────────────────────────────────────────────────────────── */
  tools: {
    chainsawCutPerSec: 0.16,   // ~6 s of cutting per tree section
    wrenchTurnMs: 2600,
    hotstickMs: 4200,
    extinguisherLitres: 9,
    extinguisherFlowLps: 1.6,
    dropOffsetM: 1.0,
  },

  /* ── dispatch ───────────────────────────────────────────────────────────── */
  dispatch: {
    firstCallMs: 18000,
    gapMinMs: 72000,
    gapMaxMs: 150000,
    maxActiveCalls: 6,
    reportUpdateMinMs: 30000,
    reportUpdateMaxMs: 55000,
    escalateHighAt: 0.34,      // danger thresholds for the priority stamp
    escalateCriticalAt: 0.66,
    lostAt: 1.0,
  },

  /* ── consequence ────────────────────────────────────────────────────────── */
  town: {
    startConfidence: 0.62,
    confidenceControlled: 0.045,
    confidenceLost: -0.085,
    confidencePatientSaved: 0.055,
    confidencePatientLost: -0.11,
    confidenceStructureLost: -0.06,
    repairShifts: 3,           // shifts a gutted building stays boarded up
  },

  /* ── debug ──────────────────────────────────────────────────────────────── */
  debug: {
    enabled: false,
    showBounds: false,
    eventLogSize: 256,
    recentEvents: 7,
    timeScales: [0.25, 0.5, 1, 2, 4],
  },
};

/** Deep-frozen so no system can quietly retune the town at runtime. Difficulty
 *  presets, if they ever land, must be multipliers applied at the read site. */
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}
deepFreeze(CONFIG);
