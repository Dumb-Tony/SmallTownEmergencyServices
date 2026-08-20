# Changelog

## 2026-08-20 — the town you come back to

GDD Phase 4's gate is "players care about a previous mistake", which needs the town to
still be worth caring about on shift five. Every part of the carry-over was already
unit-asserted; nobody had watched them COMPOUND. Five shifts back to back
(`tools/_campaigndiag.js`) found three things, none of which one shift can show.

- **Confidence could only ever fall.** A lost call cost nearly twice what a controlled
  one paid, and a shift is mostly losses, so a crew that turned up to everything hit
  zero on shift three and stayed there for good. Nothing they did afterwards could show.
  Now a night fades a quarter of the gap back toward neutral — not forgiveness,
  arithmetic — and the per-call numbers are set so that closing one of seven still costs
  the town and closing five of seven earns it back. GDD rule 9 asks for recoverable
  failure; this is what that means in numbers.
- **The shift report named the same building as destroyed five headlines running**,
  because it read the town's ACCUMULATED damage table instead of today's losses. It now
  reports what was lost this shift, by name, or counts them if there were several.
- **A saturated town ran out of places to have an emergency.** After five neglected
  shifts, five buildings were boarded and the fifth shift produced ZERO calls — which
  scored *better* than working, because a shift with nothing in it cannot be failed.
  Dispatch now tries several kinds of call before giving up, and a retry leaves the
  opening ladder rather than drawing the same pinned template four times.

Measured after, over five shifts, worked against ignored: confidence 23% vs 16%, three
buildings boarded vs five, 3.0 damage vs 5.0 — and no silent shifts in either town.

`tools/m8-tests.js` — 22 assertions. 618 in total.


## 2026-08-20 — the link is the invitation

Co-op needed one person to read five characters down a phone while the other typed them
in. What people actually do with a game is paste a link into a chat.

- **Hosting puts the room on the host's own URL** and offers it to copy. Opening that
  link fills the code in and joins — the tap that opened it is the intent, and asking
  for a second button is how you get "it didn't work".
- **A URL is input a stranger controls**, and the code goes straight into a PeerJS peer
  id, so `roomFromUrl` refuses anything that is not a plausible code: too long, letters
  deliberately left out of the alphabet, a path traversal, a script tag encoded or not.
  Seventeen assertions on those two pure functions (`src/net/link.js`).
- Hosting twice replaces the room rather than stacking two on the URL, an existing query
  string survives, and leaving puts the plain link back.

`tools/m3-tests.js` section F, and the boot check grew seven more on the share row.
595 assertions in total.


## 2026-08-20 — driving, measured

The bot logs a lot of collisions, so the handling model got a diagnostic
(`tools/_drivediag.js`) before anybody touched it. It turned out to be fine, and the
first alarming number was the measurement's own fault: a rig placed at y=159 — the pole
line — put the engine on the GRASS beside Main Street, where it capped at 26 km/h and
took over thirty seconds to get there. On the carriageway at y=150 the same truck does
0–95% in 3.2 s and 58 km/h.

Nothing was changed. What was added is the numbers, as assertions, so they cannot drift:

| | engine | ambulance | rescue |
|---|---|---|---|
| 0 to 95% | 3.2 s | 3.0 s | 2.5 s |
| top speed on tarmac | 58 km/h | 72 | 65 |
| stop from top speed | 1.3 s / 11 m | 1.3 / 13 | 1.3 / 12 |
| 90° at a junction | 1.7 s | 1.7 | 1.7 |
| nosed into a wall, reversed clear | 1.9 s | 1.8 | 1.8 |

Grass is 27 km/h against 61 on tarmac, so the off-road shortcut stays a decision. Damage
to 100% costs 44% of top speed. m0 section H grew seven assertions for all of it,
including the one that matters most — a truck nosed into a building must reverse out of
it, because a wedged appliance with a live call on the board is unrecoverable.


## 2026-08-20 — a first shift you can work out

GDD Phase 0's exit gate — "driving across town is understandable without instructions
after one attempt" — was the one gate nothing had ever been built for. The title card
listed keys, and on a phone even that is now hidden under the player's thumbs.

- **A coach: one line, read off the world.** Not a tutorial. `nextHint(state)` is a pure
  function from the current state to at most one short line, shown in the prompt the
  player is already reading. It names the call, the truck, the kit and why that kit —
  "Hose line — it is burning. Press 3 to take it."
- **It never blocks.** No modal, no pause, no "press E to continue". Implementation rule
  3 forbids pausing an incident clock for a tutorial, and there is an assertion that the
  call deteriorates while the player is being coached.
- **It retires itself.** Each verb goes quiet the first time the player does it — from
  the simulation's own events, not a timer or a click — and driving is learned by
  driving half a block. The flags live in the town save, so shift three is silent.
  A corrupt save cannot silence it with invented lessons.
- It speaks in buttons on a phone and keys on a keyboard, off the same lines.

Measured over a whole bot shift: the coach taught `wait, ride, drive, arrive, equip,
use`, all five verbs were learned, and it went quiet well before the shift ended.

`tools/m7-tests.js` — 35 assertions, 564 in total.


## 2026-08-20 — it plays on a phone

The whole point of this project is a link you send to a friend, and half the people you
send a link to open it on a phone. They got a town they could look at and not play.

- **A virtual input layer.** A thumb produces ACTIONS — `interact`, `use`, `drop`,
  `siren`, `slotN` — through the same `Input` the keyboard goes through, so the
  simulation, the crew bot and the netcode cannot tell a thumb from a key. That is the
  payoff for an input layer that speaks in actions instead of key codes.
- **A stick, four verb buttons and an equipment row** that mirrors the HUD's numbered
  slots, because a phone has no number keys. The stick is analogue — the one thing the
  keyboard cannot express — so a phone player can ease a truck round a corner instead of
  steering in eighths.
- **A tap releases on the step that consumes it.** A finger cannot be relied on to send
  a pointerup: it slides off the button, the browser steals the gesture, the page
  scrolls. A stuck virtual key is a responder walking into a wall forever with nothing
  to press to stop it.
- **Driving fell back to the axis.** `readCommand` derived throttle and steering from
  the four movement ACTIONS, which a stick never presses — so a phone player could walk
  anywhere in town and then sit in a cab that would not steer. Keys still win when they
  are down, so keyboard driving is unchanged to the bit.
- **The camera holds a pixels-per-metre target on small screens** instead of a metres
  budget. 165 m across a 390 px phone is 2.4 px/m: a person is two pixels and a hydrant
  is one. It is 6.5 px/m now, and 9.5 on foot.
- **A layout that fits.** `tools/_layoutdiag.js` measures every panel against the
  viewport and reports overflow and overlap: it found the radio log sitting under the
  thumb buttons (172 × 59 px) and the prompt sitting on the stick, and it found that a
  landscape phone at 722 px wide skipped the mobile layout entirely while still having
  touch controls. All three fixed and re-measured at four device sizes.

`tools/m6-tests.js` — 42 assertions, 529 in total. `tools/smoketest.ps1` takes
`-Width`/`-Height` now, so a suite can be run at a phone's viewport.


## 2026-08-20 — the medical family closes

Following the previous milestone's measurement: medical calls were being worked 4 times
out of 4 and controlled 0 times out of 4. Run one template at a time, the reason was
different for each.

- **`fall_outdoor` and `chest_pain` already worked** once a call could close on
  packaging rather than handover — 23 s and 40 s respectively, one volunteer.
- **`farm_entrapment` was failing on a timer that ignored the crew.** A call's danger
  climbed at its full rate whether or not anybody was stood in it, so a crew that
  reached a trapped casualty at 16 s, extricated by 33 s and treated them watched the
  call declared lost at 218 s with the patient alive, conscious and stable. Deterioration
  is what happens WITHOUT you — the central law says so — so the base rate is now damped
  to a quarter while a crew is on scene. Hazard pressure is not damped: a building that
  is still burning is still burning, and standing next to a fire saves nothing.
- **A stabilised casualty puts less pressure on the town** than one nobody has touched.
  Treatment buys time in both places now, not just on their own clock.
- **The entrapment is a two-person call, and that is the design working.** It needs the
  spreaders (rescue truck) and then the medkit and a ride (ambulance), and one person
  cannot drive two trucks. Measured: solo it is lost at 383 s; with a partner it is
  **controlled at 43 s** with the casualty alive and aboard. That is GDD Phase 5's exit
  gate stated as a single call.
- The crew bot learned the GDD's third core-loop step — choose apparatus **and
  equipment**. It takes a spare medkit off the apron rack before rolling on a call with
  casualties, because a tool in your hands is stowed in the cab when you climb in.

`tools/m5-tests.js` grew a section for it (31 assertions, 487 in total), and
`tools/_medcalldiag.js` is the per-template measurement. The playability baseline moved
with it: whole bot shifts now close fire, crash AND medical calls, where they used to
close fire and tree, and town confidence at the end of a worked shift went from 13%/29%
to 48%/39%.


## 2026-08-20 — does it play?

The GDD's build phases were all in, so the next milestone was the question Part II
opens with: can this town reliably produce a story where you abandon one worsening
problem for another? Nobody had ever measured it. Measured, the answer was no — twice,
for reasons that had nothing to do with taste.

**A live wire executed the casualty it touched.** A patient lying in a live zone lost
10% of their condition every two seconds: 5% a second, against the 0.26% a second that
defines "critical". They died 14 seconds after appearing, and the fastest a crew has
ever reached anyone is 25 seconds. `crash_pole` is a CRITICAL-priority call that no
play could win — turn up instantly, drive perfectly, kill the power first, and the
patient is dead before you arrive. The guard around it looked like it fixed this; it
only stopped the radio saying so five times in a row. Now the first contact hurts them
once and lying in the zone makes them decline faster (×1.7) — a barrier to reaching
them, which is what the GDD asks of the utility family, rather than an execution.

**A call stayed open until the ambulance reached the clinic.** So a crash cost more of
a ten-minute shift than the entire rest of the response, and across every bot shift
ever run: 11 crashes worked, 0 controlled, 0 patients loaded, 0 delivered, and the
`transport` job chosen exactly zero times. A call is now under control when the scene
is clear and the casualty is packaged into the ambulance. The transport still matters —
they keep declining in the truck and the delivery is what saves them — it just stops
being the incident's problem.

With both fixed, the medical chain completed end to end for the first time in the
project's life, and **GDD Phase 5's exit gate passes on evidence**:

| pooled over two seeds | one volunteer | two |
|---|---|---|
| town confidence | 54% | **97%** |
| casualties reached | 3 | **4** |
| casualties lost | 2 | **1** |
| calls nobody attended | 4 | **2** |

- `tools/m5-tests.js` — 24 assertions holding both fixes and the gate. 480 in total.
- `tools/_playdiag.js` — where the chain breaks, per family, for one crew and for two.
- `tools/_medicaldiag.js` — how long a casualty has, against what the response costs.
- The crew bot learned to work as a crew: a shared board so two responders do not both
  drive to the same fire, and complementary trucks when they take the same call.
- The headless harness ran out of virtual time on suites that play whole shifts, and
  reported it as "the page probably crashed". Budget raised 90 s -> 600 s.


## 2026-08-19 — the town stands up

The complaint was exact: "top down, geometric shapes on a flat plane". The fix is the
projection, not more detail on flat rectangles.

- **Three-quarter view.** `tilt` squashes the ground plane, `camera.top(x, y, h)` says
  where a point h metres up lands, and `lean` gives verticals a fake perspective. The
  simulation is untouched: a wall is six metres tall to look at and zero metres tall to
  walk into. Everything with height is extruded from its real footprint — walls, pitched
  roofs, a steeple, chimneys, trees, trucks, people, and the wires between the poles,
  which had never been drawn at all.
- **Depth sorting.** Upright things are collected with a depth key — the edge nearest
  the camera — and drawn from the back of the town forwards. Two rules stop that hiding
  the game: the roof comes off the building you walk into (with the fire drawn on the
  floor you are standing on), and a building goes translucent when the crew is behind
  it. The station's apron is on its north side, so a solid station hid all three
  appliances the moment it had walls.
- **The fire is on the roof it is eating through**: char spreading, wet cells where the
  line has been played, flame breaking out of the cells actually alight.
- `tools/m4-tests.js` — 52 assertions on the projection, the draw order and the veil.
  `tools/_perfdiag.js` measures 1.1 / 9.2 / 11.6 ms a frame at the three zooms.

Four bugs found on the way, three of them older than this work:

- **`shade()` painted things pure black.** It parsed only `#rrggbb`, and four call sites
  hand it its own `rgb(...)` output — a cab is a lighter version of an already-shaded
  face. `parseInt` gave NaN, `NaN >> 16 & 255` is **0**, and so the truck cabs, the
  wrecked car's cabin, the church steeple and every tool on the ground were painted
  black without anything throwing. Found by probing the actual pixels.
- **`camera.visibleM` never had `x` or `y`**, and `drawGround` read them anyway:
  `Math.floor(undefined / step)` is NaN, the loop ran zero times, and the ground detail
  had never once appeared on screen.
- **Mouse aim had never worked.** `input.pointerWorld` claimed in a comment that main.js
  recomputed it every frame; nothing did, and there was no pointer listener either — so
  the mouse did nothing and every stream came out of the keyboard facing.
- **Flames were painted off-target**: the gradient was built before the transform that
  moved it, and a canvas gradient resolves in the space it is painted in, so the fire
  was a few dim specks instead of a fire.

Screenshots hung the harness until the pose scripts stopped calling `S.frame()` by
hand — main.js's frame re-schedules itself, so each manual call forked another render
chain, and a page that never goes idle never reaches its virtual-time budget.


## 2026-08-19 — Phase 5b: the network half of co-op

- **Host-authoritative netcode.** One five-character room code, a direct WebRTC
  connection through PeerJS, and no server of ours anywhere in it. The host's simulation
  is the game; a client sends command intent every frame (76 B) and draws snapshots
  twelve times a second (4.7 kB for a busy town, 55 kB/s). `Game.frame()` refuses to
  advance on a client — the guard sits at the one door into the simulation, so the two
  towns cannot diverge.
- **A partner who drops is cleaned up after**: their tool is on the ground, their patient
  is put down, no stale command keeps driving a responder that no longer exists.
- `src/net/protocol.js` is the wire format with no transport near it; `src/net/net.js` is
  the transport, behind an interface thin enough that `loopbackPair()` runs a whole
  host+client session in one page. That is how `tools/m3-tests.js` gets 82 assertions out
  of a network with no network.
- **Two bugs the tests caught, both real**: a client that connected fast enough showed
  "joining" after it had already connected, because the status was set after the hello
  went out; and `broadcastRadio` sent a message the client had no handler for — deleted,
  since the radio already crosses in snapshots.
- `tools/boot-check.js` — 18 assertions that the page itself came up: no crash banner,
  PeerJS loaded, the join UI built, the code box sanitised, and a live session attached
  to the real page encoding the real town.


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
