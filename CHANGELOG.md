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
