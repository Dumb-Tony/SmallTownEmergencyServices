# Changelog

## 2026-08-18 — Phases 0–4 of the GDD MVP

Built against `GDD.md` in one session. The GDD's phase gates are the section headings.

### Phase 0 — walking skeleton
- One continuous 420 × 300 m town: 11 named buildings, 9 roads (four through-routes
  each way), 11 hydrants, 8 utility poles, a clinic and a volunteer station.
- Three apparatus with deliberately non-overlapping loadouts. The engine carries no
  medical kit, so arriving with the wrong truck is possible.
- Walking, driving, on/off-road speed split, collision with impact damage, and doors:
  structures stop trucks, not people.

### Phase 1 — one complete fire response
- Cellular fire: heat, fuel, wetting, ignition, exposure spread to the next structure.
- Hose tethered to its engine, finite tank, hydrant supply, damaged hydrants.
- **Measured** (`tools/_firediag.js`): a shop fire is 25% involved at 46 s and gone by
  110 s; a crew arriving at 45 s controls it in 63 s and loses 10% of the building;
  arriving at 90 s controls it in 74 s and loses 67%.

### Phase 2 — simultaneous calls
- Dispatch queue with partial reports, timed caller updates, danger-driven priority
  escalation, pressure-aware pacing, and no cap of one active call.
- Nothing pauses the simulation: the call list is always on screen, TAB only expands it.

### Phase 3 — five systemic families
- Fire, crash, tree, medical, utility over 11 templates. Gas ignites when an ignition
  source gets close; a downed line stays live until it is killed at the pole; water on
  the ground grows the live zone; a burning wreck beside a building starts a structure
  fire. None of it is scripted per family.

### Phase 4 — consequence and replay
- Versioned device-local persistence: building damage, boarded-up shops, broken
  hydrants, town confidence, and a headline, carried into the next shift.
- Newspaper-framed shift report with a factual incident table.

### Bugs found by the test suites (each had a failing assertion first)
1. Exposure spread tested only the first burning cell in the array, so whether a fire
   found the barn six metres away depended on array order.
2. Building damage was written through only while a call was open — a call that was
   given up on cost the town nothing.
3. Danger accrued at 0.055/s per burning cell, writing off a structure fire nine
   seconds after ignition.
4. A fire could not be put out by design: heat was pushed into cells that were already
   burning, and water was split evenly across cold cells in the cone.
5. `VICTIM_SHOCKED` re-fired every two seconds for a casualty lying in a live zone,
   filling the radio with one repeated line.

### Test counts
- `tools/m0-tests.js` — 111 assertions (skeleton, geometry, persistence, movement, determinism)
- `tools/m1-tests.js` — 112 assertions (systems, lifecycle, acceptance scenario)

## 2026-08-19 — playability: a bot that actually plays it

m0 and m1 drive the simulation through function calls, which cannot answer the question
the GDD's phase gates really ask: can a person pressing keys get anything done?
`tools/_crewbot.js` plays whole shifts through the real input path — same `moveAxis`,
same `wasPressed` edges, same numbered slot list the HUD renders — and
`tools/m2-tests.js` asserts on what it managed. It found nine things.

### Game bugs it found (all fixed)
1. **The apparatus could not reverse out of their own bays.** 0.2 m between back bumper
   and station wall; reversing — the first thing anyone tries — wedged the engine
   nose-first into the station. The hall moved 6 m south.
2. **There were bearings a keyboard player could not point at.** Facing snaps to the
   eight movement directions, 45° apart, and the water cone was ±20°. A crew could
   stand in front of a burning farmhouse holding a charged line and be unable to fire
   it. Cone widened to ±26° so the eight directions overlap.
3. **Mouse aim was computed and thrown away.** `main.js` had maintained
   `input.pointerWorld` since the first commit and nothing ever read it. Now threaded
   through the command into facing, so the mouse aims exactly and the keyboard still works.
4. **A tool at your feet was unreachable beside a loaded truck.** The slot list put
   compartments first, so a just-dropped tool came sixth. Ground first now, nearest first.
5. **Dead air after finishing a call** — 70 seconds of nothing, which the GDD forbids
   outright. Gaps shortened, and the board going clear now pulls the next call forward.

### Harness findings (bot fixes, but each was a real trap)
6. Taking the hose off a parked engine and walking away silently anchors you 34 m from
   the truck — working as designed, and now something the bot learns to avoid.
7. Walking into a downed wire, being thrown clear, and walking straight back into it.
8. Standing on top of the thing you are aiming at leaves facing undefined.
9. Getting in and out of the same cab 5,290 times, which is now a failing assertion
   rather than something you have to read a trace to notice.

### Test counts
- `tools/m2-tests.js` — 36 assertions (whole shifts on the real input path, the
  turning-up-beats-not-turning-up thesis, and soft-lock guards)
- **259 assertions total.**

## 2026-08-19 — audio

WebAudio, synthesised from nothing: no files, no fetches, no dependencies. `tone`,
`makeNoise` and `arm` copied from `SomethingsDifferent` per `Dev\INDEX.md` — that synth
has now been written four times across the tree and this is the fourth *adaptation*,
not a fifth invention.

Two rules hold `src/audio/audio.js` together:

- **Audio reads state and never writes it.** It is the renderer's twin — same input, a
  different output device — and the simulation behaves identically with the whole layer
  dead, which is exactly what happens on a browser that refuses a context.
- **The decision is separate from the plumbing.** `mixFor(state)` is a pure function
  from world state to target loudnesses; everything under it is oscillators. That split
  is what makes the interesting half assertable on a headless box with no sound card.

Continuous voices, all derived from state every frame rather than set by hand: siren
(a real wail, and it carries 150 m), fire (loudness is burning cells each attenuated by
its own distance, so a big fire far off and a small one at your feet can land on the
same number — which is what they sound like), water, engine (pitch follows road speed),
chainsaw, and the crackle of a live wire, which you now hear before you walk into it.

**The gas meter is the reason this exists.** Gas is the one hazard with nothing to see,
so the meter clicks at a rate that rises with concentration — up to fourteen a second at
the leak. That is GDD rule 7, "make causes visible", in the only sense available for an
invisible hazard, and it is why carrying the meter is worth a hand.

One-shots live in a `CUES` table rather than a switch: a new event is a new row, and an
event with no row is silent rather than fatal. Cues are rate-limited, and
`APPARATUS_STRUCK` scales with impact — a kerb and a shop front are the same event with
very different numbers behind them.

`M` mutes, persisted to `stes.audio.v1`. Pausing hushes the town.

### Test counts
- `tools/m0-tests.js` section J — 24 assertions on the mix and the discipline: that a
  siren is quieter across town, that a bigger fire is louder, that the meter's click
  rate falls as you back away, that every cue names an event the simulation really
  emits, and that thirty frames of audio leave the simulation byte-identical.
- `tools/_audiodiag.js` — 12 assertions on the plumbing in a real browser: the context
  builds, the voices exist and start silent, cues rate-limit, mute pulls the master down.
- **283 assertions total.**

## 2026-08-19 — Phase 5a: a crew of two, and a visual pass

### The milestone: cooperative validation, the half that can be verified

GDD Phase 5 is co-op. It splits cleanly into the architecture (several responders in
one town, contending for one wheel, one nozzle, one patient) and the transport (netcode).
The design risk is all in the first half, and unlike netcode it is testable here — so
that is what this is. **Press `P` and a second volunteer signs on**, on the same
keyboard: arrows, right shift, `/`, `.`, `,` and the numpad.

`state.responders` is now a list. `state.player` is kept as the same *object* as
`responders[0]` — not a copy — so single-responder call sites stay honest instead of
quietly diverging. Every responder's intent goes through one `readCommand(input, prefix)`,
which is the same seam a network client would take.

Contention is a property of the seating and the hands, not a rule written down somewhere:

- **One wheel.** First in drives; anyone after that rides. Two people in a cab do not
  make it go twice as fast — asserted, because that is exactly the bug a "crew is a
  list" refactor produces.
- **One nozzle.** Tool ownership is a responder id, so it cannot be held twice.
- **One patient.** `draggedBy` is a responder id for the same reason.
- Signing off puts down whatever you were holding rather than orphaning it.

The camera frames the crew's centre of gravity and widens to keep both on screen; the
HUD shows two status lines, each in that responder's colour, and says who is at the wheel.

**Bugs the co-op tests caught:** a patient already in someone's arms could be grabbed
out of them (the victim stayed put while the first responder walked off "dragging"
nobody), and the second crew member's interaction pass silenced the first one's nozzle
every step.

Still to do for Phase 5 proper: the network transport. The architecture is shaped for
it — host-authoritative simulation, per-responder commands — but two browsers talking
to each other is not something that can be verified from here, so it is not claimed.

### The looks
- **Fire lights the ground.** Warm pools under everything burning, drawn beneath the
  things standing on it, plus embers riding the column.
- **Windows glow when the room behind them is alight** — read straight off the fire's
  own cells, so a shop with three lit windows on the north side has its fire on the
  north side. It is the only way to see inside a building you are outside of.
- Kerbs and lane markings, bay markings on the apron, parking bays in the lots,
  deterministic grass patches and per-tree size variation.
- Apparatus that read as vehicles: wheels, a cab and windscreen, a reflective chevron
  band, and kit that identifies each truck without reading the label — a ladder on the
  engine, a red cross on the ambulance, a locker roll-up on the rescue.
- A lightbar that alternates red and blue and throws colour onto the road.
- A vignette, and a dark contrast ring under every responder — **a yellow crew member
  standing in a yellow fire was invisible**, and the one thing that must always be
  findable on screen is the person you are controlling.

**A real hang bug found while screenshotting:** the new grass texture stepped a fixed
26 m grid across the visible area, which is an unbounded loop when the camera has no
layout yet and the scale divides by zero. It hung the page hard enough that headless
Chrome sat on a screenshot until it was killed. The step is now derived from the visible
size and bounded to a 48×48 grid.

### Test counts
- `tools/m2-tests.js` section E — 21 assertions on co-op: seating, contention, signing
  off cleanly, and a whole shift played by two bots at once through the real input path.
- **304 assertions total** (m0 135 · m1 112 · m2 57).
