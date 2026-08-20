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
    // Readability budget, not taste: at 165 m across a 1600 px window that is ~9.7
    // px/m, so a 7.6 m engine is ~74 px and a person ~7 px. Wide enough to see the
    // next two intersections while driving — the first pass used 118/76 and the
    // screenshot came back as one building filling the screen, with no street in it.
    viewWidthM: 165,
    viewWidthOnFootM: 104, // zoom in out of the cab, but never so far that the street goes

    /* A hand-held screen holds a pixels-per-metre target instead, because the same
       metres budget on a 390 px phone makes a person two pixels wide. */
    phonePxPerM: 6.5,
    phonePxPerMOnFoot: 9.5,
    followLerp: 5,
    fitPaddingM: 6,
    maxPixelRatio: 2,
    zoomLerp: 3.5,

    /* The three-quarter projection, in three numbers (src/render/camera.js).
       tilt 1.0 is straight down and 0 is on the horizon; 0.62 is shallow enough to see
       walls and steep enough to still read a street layout. heightScale is how tall a
       metre of building looks against a metre of ground, and lean is the fake
       perspective that stops verticals from all being parallel. */
    tilt: 0.55,
    heightScale: 1.35,
    lean: 0.004,
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
    // MEASURED: keyboard facing snaps to the eight movement directions, 45 deg apart,
    // so a cone narrower than +/-22.5 deg leaves bearings a keyboard player physically
    // cannot point at. At 20 deg the bot stood in front of a burning farmhouse holding
    // a charged line for two minutes without ever being able to fire it. 26 gives the
    // eight directions an overlap; the mouse aims exactly.
    streamHalfAngleDeg: 26,
    hoseMaxLengthM: 34,    // park badly and the fire is simply out of reach
    hydrantHookupM: 7.0,   // how close the engine must be spotted to a hydrant
    hydrantSupplyLps: 22,  // refill rate once hooked up
    // MEASURED: a burning cell gains fire.burnHeatGain (0.24) heat/sec. At 12 L/s the
    // nozzle removes 0.72 heat/sec from ONE cell, so a focused stream wins comfortably
    // and a stream spread across three cells (0.24 each) only just holds. That ratio is
    // the whole skill of a hose line — do not raise it without re-checking m1 section A.
    coolPerLitre: 0.110,   // heat removed per litre landed on a cell
    wetPerLitre: 0.090,
  },

  /* ── fire ───────────────────────────────────────────────────────────────── */
  fire: {
    cellM: 4,
    ignitionHeat: 0.62,    // a cell catches above this
    burnHeatGain: 0.24,    // heat/sec a burning cell adds to itself
    // MEASURED: net of ambient cooling, one burning cell ignites a neighbour in ~9 s
    // and two do it in ~3.5 s, so a fire accelerates but a single hose line can work
    // the edge of it. At 0.22 the front moved 4 m every 3 s, which no crew could ever
    // beat: every structure fire was a total loss whatever the player did.
    spreadPerSec: 0.030,   // heat/sec pushed into each neighbour
    diagonalMul: 0.45,
    fuelBurnPerSec: 0.022, // ~45 s of fuel per cell at full burn
    coolPerSec: 0.012,     // ambient cooling when nothing is burning
    wetDecayPerSec: 0.010,
    jumpDistM: 9,          // exposure distance to the next structure
    jumpChancePerSec: 0.05,
    smokePerSec: 2.4,
    dangerPerBurningCell: 0.0006,
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
    declineStable: 0.00015,  // condition lost per second, by presenting state
    declineInjured: 0.0011,  // 0.80 -> critical in ~7 min
    declineCritical: 0.0026, // 0.56 -> lost in ~3.5 min untreated
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

    /* A live wire down across the casualty. It is a barrier to REACHING them, not an
       execution: one hit when it first touches them, then a faster clock while they lie
       in it. Measured before this existed: dead 14 s after appearing, against a fastest
       ever arrival of 25 s — the call could not be won by any play. */
    shockCost: 0.10,
    declineLiveMul: 1.7,
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
    gapMinMs: 55000,
    gapMaxMs: 120000,
    // A crew standing on the apron with nothing outstanding is the one state the GDD
    // says the game must not have ("never drop into a mission-complete vacuum"). The
    // bot's first successful shift closed its fire at 37 s and then had 70 seconds of
    // silence; this caps how long the town can stay quiet once the board is clear.
    quietCapMs: 30000,
    maxActiveCalls: 6,
    reportUpdateMinMs: 30000,
    reportUpdateMaxMs: 55000,
    escalateHighAt: 0.34,      // danger thresholds for the priority stamp
    escalateCriticalAt: 0.66,
    lostAt: 1.0,

    /* How much of a call's own deterioration clock still runs while a crew is stood in
       it. The rest of the pressure comes from the hazards themselves, which are not
       damped — see stepIncidents. */
    attendedDangerMul: 0.25,
    // MEASURED: with the cap, the very worst neglected call (a template base of
    // 0.0035/s plus a fully-involved structure) reaches danger 1.0 in about 2 minutes,
    // and a routine tree down would need 16. Uncapped, a spreading fire wrote off its
    // own call in nine seconds, which read as a bug and was one.
    maxHazardPressure: 0.004,
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
