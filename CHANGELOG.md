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
