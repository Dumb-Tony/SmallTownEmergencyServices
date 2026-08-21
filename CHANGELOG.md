# Changelog

## 2026-08-21 — Tanker 1, and three wrong reasons for it

The previous milestone measured a crew of four and found the fourth pair of hands had
nothing to drive: three trucks, four volunteers, and a shift that closed exactly as many
calls with four as with two. The GDD files the answer under long-term progression —
*"additional apparatus BROADENS capability instead of providing percentage upgrades"* — so
the fix is a fourth capability, not a better engine.

**Tanker 1**: 6000 L, a hydrant wrench, and no hose. It cannot put a drop on a fire by
itself. Parked within nine metres of the engine it pumps into its tank at 14 L/s — slower
than a hydrant, because a hydrant is mains pressure and this is a pump between two trucks —
and it spends exactly what it gives. It is also the slowest thing in the station, the
slowest to get going, the worst at stopping, and the biggest thing on the road.

### The part worth reading: I was wrong about what it was for, three times

The suite's job was to answer one question — *is there a call that goes better with it
than without?* — because **a fourth appliance that makes no difference is a fourth
appliance**. Section D asked it badly three times, and each wrong premise was wrong in a
different way.

1. **Fight Miller Barn the instant it lights.** Both runs came back identical to the
   digit: `out · 93% burnt · 2208 L`. 2208 L is less than the engine's own 2500, so the
   tanker was never touched. A test that cannot detect "no effect" is not a test — this
   one could, and it did.
2. **Assume the fire just needs a head start**, and sweep how long it burned first. The
   water used went **down**: 2208 → 1065 → 704 → 344 L. Not a bug. A building alight for
   ninety seconds has already consumed itself and there is less left to cool. In this model
   water demand **peaks when you arrive early and try to save the place**.
3. **Assume the building is the variable** and sweep all eleven. Two of them — the feed
   store at 72 cells and the apartments at 108 — wanted more than one tank. But only
   because the stream was poured from one fixed spot, which reaches a fraction of a big
   shed and loses 96% of it whatever the supply. Give the nozzle a crew that **walks**, on
   the 34 m line it is actually tethered by, and every structure in town at every head
   start comes in under 1500 L:

   | | 0 s | 45 s | 90 s |
   |---|---|---|---|
   | Miller Barn | 96 L | 884 L | 344 L |
   | Vance Feed & Grain | 116 L | 1458 L | 800 L |
   | Sutter Apartments | 146 L | 1343 L | 790 L |

**So no single fire in this town needs more than one tank, and the suite now asserts
that** — if the fire model ever changes underneath, the claim fails loudly instead of
rotting into marketing.

What 2500 L does not cover is a **shift**. Three structure fires at the far end of the
valley — barn, feed store, garage, 40/33/57 m from the nearest hydrant against a seven
metre hookup radius — and the engine is dry on the third. Refilling means dropping the
line, driving the truck out of the fire, charging a hydrant, filling, driving back:

```
shift          total    refill trips      barn / feedstore / garage lost
engine alone    457 s   1 trip  (114 s)   63% / 75% / 87%
with a tanker   422 s   0 trips (0 s)     63% / 75% / 78%
```

114 seconds with the building burning unopposed, and nine points of the garage. That is
what the fourth truck buys, and it is why a real rural department owns one. The first two
fires are identical in both columns — it does not touch the calls that never needed it.

### The rest of it

- **A fourth bay**, at the same 14 m spacing as the other three. The apron was
  deliberately *not* widened: `atStation` measures from the apron rectangle, and widening
  it put the Main Street junction inside the 22 m tidy radius, which would have quietly
  broken the station's memory of where you left things.
- **The hydrant wrench now charges the nearest truck, not the first one in the file.** It
  used to `find` the first apparatus in `APPARATUS_DEFS` order — always the engine — so
  standing at a hydrant with the tanker in front of you charged a truck across town.
- **Four trucks for four volunteers, and four distinct capabilities**: water on a fire, a
  ride to the clinic, tools, and water where there is none.
- **The HUD now says the shuttle is working, from both cabs** — `Engine 1 · water 507 L ·
  fed by Tanker 1` and `Tanker 1 · water 5993 L · feeding Engine 1`, and
  `nothing hooked up` when it is parked doing neither. `applyTankerSupply`'s own comment
  had claimed "the HUD reads this" about `suppliedBy` since the hour it was written, and
  the HUD did not read it at all. A tanker whose work is invisible is a tanker nobody
  drives.

### Two things the fourth truck broke on its way in

Neither would have been caught by reading the diff.

- **`tools/m14-tests.js` section F threw.** It scattered "every truck" across a
  hand-written list of three positions and asserted `3` three separate times. A fourth
  appliance indexed past the end of the array. The counts now come from
  `APPARATUS_DEFS.length`, and so does section G's ceiling on how many trucks can be out.
- **The colour audit did not know the tanker existed.** `SIGNAL_GROUPS.apparatus-tint`
  named its three colours as a literal, so a new signal colour shipped without a single
  CIEDE2000 or CVD comparison against anything — and every assertion in that section still
  passed, because the table names its own entries. `m10` D9b/D9c now count the group
  against `APPARATUS_DEFS`, which is the guard that was missing. For the record the tint
  is fine: worst pair engine/tanker at 40.9 dE00 under protanopia, against a threshold
  of 11.

### Test counts
- `tools/m16-tests.js` — 53 assertions: the appliance and what it gives up, the shuttle
  and its edges (a full engine takes nothing, an empty tanker gives nothing, driving away
  stops it, it will not fill an ambulance), the nearest-truck hydrant fix, the three-call
  shift, four trucks for four volunteers, and the two HUD chips below.
- **1539 assertions** across 18 suites — m0 149 · m1 113 · m2 57 · m3 102 · m4 59 · m5 31 ·
  m6 42 · m7 35 · m8 34 · m9 94 · m10 256 · m11 105 · m12 98 · m13 78 · m14 88 · m15 107 ·
  m16 53 · boot-check 38.

## 2026-08-20 — a crew of four

The GDD's player fantasy opens *"One to four players begin each shift at a small volunteer
station."* The netcode was a fixed pair: one `link`, one `remoteResponderId`, and a partner
created by *"if there are fewer than two responders, add one"*. Four seats is not that with
a bigger number in it.

The session now keeps a **seat map** — one link per volunteer, a resume token each, and one
snapshot broadcast to all of them. Shape copied from `ContainmentDetailWeb\src\net\net.js`
(`Dev\INDEX.md` → Multiplayer), which is the only squad-of-N in the tree.

**Four places where a two-case rule was quietly wrong at three**, each of which would have
shipped looking finished:

- **`toggleCoop` popped the LAST responder.** The P key on the host's own keyboard would
  have signed off whichever volunteer joined most recently — somebody on another continent.
  Seating is now by name, and P only ever touches a seat a keyboard can reach.
- **A command was attributed to `remoteResponderId`**, a single field. Three clients would
  all have driven the same body. A command is now attributed to **the link it arrived on**,
  so a message naming somebody else drives the sender and not the person it names.
- **`readCommand` falsy-tests its prefix**, so a third seat with an empty prefix reads r1's
  own keys — two crew on one set of WASD, which is the per-seat-input-collapsing bug this
  tree has already shipped once elsewhere. r3 and r4 have a **null** prefix and the reader
  returns an empty command for it.
- **The snapshot decoder branched on `'r2'`**, so anybody who was not r2 arrived in the
  host's own colour, called "You". Two people in the same coat, one of them yours.

**A drop is not a departure — and neither is it for ever.** The pair version signed a
partner off the instant their link closed, which drops whatever they were holding on the
floor for a three-second reconnect. The seat is now held, with a token that buys back the
same body and the same kit. But held *for ever* is the older bug that behaviour replaced: a
volunteer standing in the street with the only medical kit for the rest of the shift. So
the seat expires after `CONFIG.net.reconnectGraceMs`, and expiring does exactly what
signing off does. Both halves are asserted.

The top bar had to change shape too. Four full status lines is a bar that wraps off the
screen — and the fix is not to shorten all four, it is to decide **what a crew actually
needs to know about each other**: not each other's water, but where they are and whether
they are upright. You get your own status in full; everybody else gets a name in their own
colour and one fact. That immediately exposed a collision that had always been in the data
— `Medic 1` and `Medical kit` both abbreviate to **MED**, so one volunteer driving the
ambulance and another carrying the kit rendered identically. The verb separates them.

**Two more colours turned out to be the hardest part.** Two crew tints is one pair to keep
apart; four is six, under normal vision and three colour-vision simulations. The two
obvious extra colours — a lime and a hot pink — were applied, looked completely
unmistakable, and **measured 4.8 against a threshold of 11**: `#b9f06a` *is* the player's
own gold to a deuteranope, and `#ef8fd0` is that same gold to a tritanope. Three of six
pairs collapsed, including the one carrying *which of these is me*, and no single
simulation catches both. Searched rather than picked, the palette is now a violet and a
muted rose, worst pair **16.5**.

There is no lightness ladder in it, for a reason worth writing down: a crew tint is also
TEXT — the HUD paints each name in it at 11px bold, which needs 4.5:1 on the pill plate,
which floors L\* at 57. The best candidate found measured exactly 4.50:1, one rounding from
failing AA. So it is two tiers of two, hue apart within a tier and 18–23 L\* across.

**And does four of them actually help? Measured: no — and that is worth saying plainly.**
Bot shifts on two seeds, one crew against two against four: one closes 2 calls and leaves
the town at 28% confidence, two close 4 at 49%, and **four also close 4 at 49%**. All four
volunteers are genuinely working — they walk 2941, 3100, 3100 and 3024 metres — so the
third and fourth pair of hands are on their feet the whole shift and there is simply no
more work for them to close. The bottleneck is three trucks and one dispatch queue, not
hands. That matches where the GDD files "larger station and more bays": under long-term
progression, as the thing a bigger crew would need.

Both halves of that took an assertion the first version could not make. The first harness
reported **1, 2 and 4 crew as identical to the digit** and every comparison passed happily,
because they were all "not worse than" — two silent wiring mistakes meant it had measured
one bot three times. So the suite now asserts, first, that the crew size changes the shift
*at all*, and second, that every seat actually moved. A crew-size comparison in which the
sizes come out equal is not a result.

`tools/m15-tests.js` — 107 assertions, and `src/data/crew.js` is a new data module holding
the crew table: the moment the wire format needed to know what colour a third volunteer
wears, `protocol.js` had to import `game.js`, which already imports `protocol.js`. A `const`
in a cycle is not a hoisted function.


## 2026-08-20 — the station remembers

The last two entries on the GDD's persistence list — "vehicle damage and location" and
"equipment location and consumables" — were the only ones never implemented. They are now,
and getting them right took three goes, because this is the one carry-over the player
causes **entirely by hand** and it is correspondingly easy to make it feel like an ambush
rather than a consequence.

**What the shift banks:** a truck's damage, always; a truck's position and tank, only if it
cannot drive; and kit left lying in the field. The report names all of it the night
before — *"Still out: Engine 1 at Miller Barn, 250 L aboard"*, *"Left in the field:
Chainsaw at Miller Farmhouse"* — because a consequence you are told about is a decision
about tomorrow, and the same consequence discovered by walking out of the station and not
seeing your engine is an ambush.

### Three wrong versions, and what each one taught

**It measured against each truck's own bay.** The bays are 16 m apart, so parking neatly
beside the apron rack read as *abandoned at 43 m*. The test has to be "did it get back to
the station", against the apron rectangle — punishing somebody for parking in the wrong
bay is not a consequence worth having.

**It kept every truck exactly where the bell caught it.** That sounds like the GDD's
"badly parked apparatus should create improvisation" and is not, because **the bell rings
wherever you are**. A crew working a call at 9:58 ends the shift at that call, every time,
on purpose — so "badly parked" was not a mistake anybody made, it was the default, and it
applied to the careful player and the careless one identically. Wrecking a truck *is* a
mistake and one you can see coming, so a truck drives itself home unless you have beaten
it past `undriveableDamage`, in which case it sits where it died until the department has
patched it back under the line. That repair is the countdown, and the homecoming hangs off
it — the same unconditional-countdown rule the boarded buildings needed, for the third
time in this codebase.

**And the worst one: it banked the hose.** A hose line is tethered to its engine and lies
on the ground the whole time it is being worked, which is indistinguishable from a dropped
chainsaw to a rule that reads `carrier === null`. So **every shift that ever put water on a
fire filed its own nozzle as lost kit**, and the next shift began with the engine unable to
fight anything. Measured over six consecutive bot shifts: the hose out on every single one,
**2 calls closed against a control's 7**, and the crew on foot for 570 seconds of a
600-second shift. One line excluding it took the six-shift total from 2 to 9 — level with
the control.

That bug was only visible because the six-shift test has a **control arm**: the same seed,
the same bot, with the carry-over wiped between shifts. Without it, "the town ends at 0%
confidence" is a sentence about seed 55 rather than about the feature, and the first
version of that assertion could not tell the difference.

Measured after: a truck wrecked at 0.90 and abandoned reads `out@0.60 → in@0.30 → in`, kit
is collected the morning after next, and the worst hand-over a shift can physically make —
three trucks scattered and written off, every tank dry, eight tools in a field — still
closes a call, at 21% town confidence against a clean station's 64%.

`tools/m14-tests.js` — 88 assertions. `tools/_stationdiag.js` is the measurement.


## 2026-08-20 — weather, as a set of multipliers rather than an event

The GDD asks for weather as "modifiers that generate and connect incidents rather than
launching a separate scripted level", and that sentence rules out most of what a weather
feature usually is. There is no storm event, no flood level, no scripted sequence.
`src/sim/weather.js` is a small table of bounded multipliers on numbers the systems
already read, so a windy night is the same game with the fire behaving differently — and
the difference turns up in decisions the player was already making.

**Clear is exactly 1.0 on every multiplier**, which is the game as it was, and nothing is
more than a factor of 2.2 from neutral. The same fire, unattended, at ninety seconds:

| | clear | wind | rain | cold snap | heat |
|---|---|---|---|---|---|
| **of the building burnt** | 32% | 32% | **14%** | 21% | **61%** |

- **Wind** does not change how fast a room burns — it changes **where it goes next**. Gas
  blows away nearly twice as fast, which is the one mercy in it.
- **Rain** slows a fire and costs the engine its top speed: 17.0 → 13.9 m/s on Main
  Street. Time on the fire, paid for on the way there — a trade the player makes with the
  throttle rather than reads off a status line.
- **A cold snap** moves the pressure off the structure and onto the people and the water:
  a casualty declines 30% faster and the mains run at 70%.
- **Heat** drives everything.

**The wind decides which building catches — and the first version of that rule did
nothing at all.** It re-ranked the candidate exposures by how downwind they were, which
is the obvious design and measured as exactly zero difference: fourteen runs with the
wind blowing straight at Miller Barn and fourteen with it blowing straight away, and the
barn caught 14 times out of 14 in both. **Seven of the nine workable buildings in this
town have no exposure at all inside the 9 m jump distance, and the other two have exactly
one.** A rule that reorders a list of one has no outputs.

So the wind moves the REACH rather than the ranking: downwind an ember carries to about
13 m, upwind it barely leaves the building. Measured after: **the barn catches 10 times
out of 10 downwind and 0 out of 10 upwind**, with still air unchanged at 10 of 10. That
turns "which exposure do I protect" from a distance calculation you do once into
something you read off where the smoke is going.

The law is the same one the residents got: weather may not create a call, close one, or
make a shift unwinnable. A bot shift in every condition closes calls in all five, and the
hardest (heat, 35% confidence) is measurably harder than the easiest (clear, 64%) without
being impossible — GDD rule 9, recoverable failure.

It rolls from its own named stream, carries in the save as the GDD's "recent weather" so
tomorrow weights a repeat down (24 back-to-back repeats in 200 shifts), and a condition id
that is not in the table is refused on load rather than believed.

**It also broke the playability gate, which turned out to be the right kind of failure.**
`tools/m5-tests.js` asserts the medical chain completes end to end in a real bot shift —
the GDD's own "does it play?" — and its two pinned seeds happened to roll the two
conditions where it does not. Measured across all five: the casualty reaches the clinic in
clear, in wind and in a cold snap, and does not in rain or heat. **Rain is the surprise**,
because its only medical effect is 18% off the ambulance's top speed; the rest is
emergent, and in the other direction from the multiplier. A slower fire is less hazard
pressure, the dispatcher is pressure-aware, so **a wet shift is a busier shift** — the
merciful-looking condition on the table is the one that overruns the crew.

So m5 now pins itself to clear conditions, because a gate has to control its variables,
and "can weather make the chain impossible?" moved into m13 where it is the subject rather
than the noise. A playability gate that silently depends on a dice roll is a flaky test
wearing the clothes of a design claim.

Three numbers of it go on the wire (`PROTOCOL_VERSION` 3) — the client does not simulate
and needs none of the multipliers, but it draws, and a partner watching a rainstorm under
a clear sky with the smoke going the wrong way is watching a different game.

`tools/m13-tests.js` — 78 assertions, most of them about whether the weather is
OBSERVABLE at all. That is the real failure mode for a modifier layer: a 20% multiplier on
a number nobody was watching ships, reads well in a changelog, and never once changes a
decision. `tools/_weatherdiag.js` is the measurement.


## 2026-08-20 — the town has people in it

"The town keeps going without you" has meant calls arriving and fires spreading on their
own clock. It has never meant anybody being there. Eleven buildings that only ever
contain a hazard are scenery with a name, and a town with nobody in it cannot be let
down. `src/sim/residents.js` — the GDD's `NPCs: health, panic, mobility,
self-preservation, bad decisions, loose memory` — does three things and nothing else.

**They get themselves out.** A household leaves a burning building by the door, on its
own, usually before the crew arrives — the mean building is clear at 16.5 s against the
~25 s it takes to cross town in the engine. This is the load-bearing one: it is why the
player is not obliged to search every structure, and it is what turns an ABSENCE into
information. The radio says it twice per building and no more — *"Somebody is out of
Pinecrest Apartments — they say there are 3 more people inside"*, and then *"That is
everybody out"* — and the call card carries the same count while it matters.

**Some don't.** Nerve and mobility are drawn per person from the shift seed, so the town
decides and not a coin flip at the moment it matters. Someone who runs out of time
becomes a casualty of that incident, inside, with the condition their time in the smoke
bought them — the same object shape as every other patient, so nothing downstream can
tell where they came from. **Measured over 52 people on four seeds: 3 did not get out
(5.8%), never more than one from a household.** That number is a distribution and the
suite asserts its shape rather than the figure.

Two measurements moved it there, and both were the model being wrong rather than a
number being wrong:

- **The hesitation was free.** Exposure only started when somebody began moving, so the
  seven seconds spent deciding it is really a fire were seven seconds the fire did not
  get. Nobody was EVER trapped — 0 of 52, on every seed, in every building.
- **`heatAt` reaches 9 m**, so in Pinecrest Apartments — 46 m by 36 m — a person at the
  far end of a fully involved building was in clear air by the model. Exposure now
  carries a whole-building involvement term, because smoke does not care which room you
  are in.
- And the hesitation turned out to be the whole distribution. At the first setting the
  spread of time-spent-inside across a population was 14.4 s to 16.7 s — so tight that
  the collapse limit trapped 34.6% of the town at one value and nobody at the next. A
  slower walker also spends their extra seconds further from the fire, at a lower
  exposure rate, so mobility very nearly cancels itself out.

**They watch, and the siren is what moves them.**
`CONFIG.drive.sirenClearRadiusM` has read *"traffic and pedestrians yield inside this"*
since the first commit, with no pedestrians anywhere in the build. A working call now
draws the neighbourhood, they stand on the ROAD side — where the crew comes from, and
where people actually stand — and walking through them costs a responder about a quarter
of their speed, bottoming out at a floor so a crowd is always friction and never a wall.
Two more things were wrong on the way here: an even ring of five people 11 m out leaves
13 m between neighbours and the player simply walks between them, and nobody came out to
look at all — the only people who ever saw a fire were the ones already outdoors when it
started, so a "crowd" was a coincidence that took ninety seconds to assemble.

Steering is `_drift`, copied from `ContainmentDetailWeb\src\sim\anomaly.js` with both of
its scars: probe further than one step, and release the wall on a longer probe than you
took it on.

On the wire, residents are a tuple of indices: the obvious version — an object per person
with the state and home as strings and a facing angle nothing draws — measured at 78 bytes
a head and **35% of the whole snapshot**. It is 28 bytes and 15% now, and the snapshot
went 4242 B → 3247 B. `PROTOCOL_VERSION` is 2.

Whole-town cost: **0.0196 ms a step**, 19 residents, no allocation growth.

`tools/m12-tests.js` — 98 assertions, including the ones that keep them out of the game:
residents create no calls, drive nothing, hold no tools, cannot join the crew, and cannot
keep a call from closing. `tools/_residentdiag.js` is the run behind every number above.


## 2026-08-20 — three audits: sound, sight, and a long session

Three read-only audits run against a build at 618 green assertions, each asked for
DEFECTS rather than a summary. All three found live bugs, which is the point: a suite
proves what somebody thought to assert.

### Sound — `tools/m9-tests.js`, 94 assertions

- **The audio layer called `Math.random`** for its noise bed. `src/core/rng.js` has
  claimed since the first commit that a grep test forbids exactly this, and no such test
  existed — which is how the bug survived. The claim is now true: m0 section H2 scans 23
  source files, with one documented exception (`net.js` `randCode` — an unpredictable
  room code is the point) and a comment stripper, because two of the three files that
  tripped it were merely *naming* the call while forbidding it.
- **The cue vocabulary drifts in the direction nobody checks.** m0 J19 asserted every cue
  names a real event; twelve events had been added since, including the whole medical
  chain, and nothing asserted the other direction. "Deliberately silent" is now something
  you write down (`SILENT_EVENTS`) rather than something you forget.
- **The rate limit was broken across shifts.** `lastCueAt` is stamped in simulation time,
  and a new shift restarts simulation time at zero while the table still holds stamps
  from the last one. A stamp ten minutes in the future reads as "the gap has not passed",
  so a cue that last fired late in shift one stayed silent for that long into shift two.

### Sight — `tools/m10-tests.js`, 226 assertions

A colour audit that computes rather than eyeballs: WCAG contrast, CIEDE2000 distance, and
protanopia/deuteranopia/tritanopia simulation, against the palettes actually in the files.

- **Eight signal pairs were indistinguishable under a simulated deficiency** — including
  a routine call against a high one, and a stable casualty against a dying one. Zero are
  now, and the ones that could not be fixed by colour are carried by more than colour:
  a casualty's condition is a DASH PATTERN as well as a hue, so the ring still says which
  patient this is in greyscale.
- **Seventeen of 57 text pairs were below AA.** One of 55 was, and then none.
- **The stun ring flashed at 4.46 Hz**, over the WCAG 2.3.1 three-flash threshold —
  the only animation in the game that was. Nothing exceeds it now, and every animation
  reads a scalar so `prefers-reduced-motion` damps it. Three that were declared and never
  read — drifting smoke, rising embers, a wobbling firelight pool — kept moving at full
  strength for a player who had asked for less.
- **The smallest text on a phone was 8.2 px.** It is 9 px, and the smallest thing is a
  canvas label rather than an accident of which unit somebody reached for.
- And one divergence is pinned rather than fixed: `--bad` was lightened to rescue a
  2.90:1 chip label, which cost that colour its separation — so the confidence bar keeps
  the darker red, because a chip is text ON the colour and a bar is a block of it with
  the word beside it. `hud.js` says why, and D25e asserts it still says why.

### A long session — `tools/m11-tests.js`, 105 assertions

Six shifts without a reload, an hour with the lid shut, two thousand jabs at ESC, and a
browser that will not hand out a `localStorage`.

- **The town could only ever get worse.** A gutted building was boarded for
  `repairShifts` — except boarding was re-set every shift the damage was still high, and
  damage was never allowed to fall while boarded. A fixed point. Measured over twelve
  unattended shifts: seven buildings boarded by shift four, all seven still boarded on
  shift thirteen, and the sites available for a structure fire stuck at three of ten.
- **A struck hydrant was never repaired**, because `sanitiseHydrants` rebuilt every record
  as `{ damaged }` and dropped `shiftsDown` on every load, so the repair arm was
  unreachable through a real save.
- **An unattended fire stopped being able to spread at the moment it got worst.** The
  exposure jump was gated on the call still being open, so a structure fire nobody
  attended reached danger 1.0, was declared lost, and from then on every jump was
  silently dropped. Measured on one seed: call open, one attempt, the barn catches; call
  lost, seven attempts, nothing ever catches — while the farmhouse burned to 100% either
  way.
- **A malformed network message took the host's whole shift with it.** `{t:'cmd'}` with
  no fields threw straight out of the handler; commands were never version-checked, only
  the hello was, so a peer that had been refused could still drive a responder.
- **Thirteen steps of world ran after the bell.** `frame()` guards the mode but the
  clock's accumulator does not, and a 250 ms frame straddling the end of a shift
  simulated past the report — in one, a casualty died, so the report said "0 lost" over
  a state that said 1.


## 2026-08-20 — a frame a phone can afford: 8.1 ms → 0.64 ms

The three-quarter view arrived as geometry, not as a budget. Measured by wrapping the
renderer's own methods, `drawApparatus` was **3.26 ms of a 4.33 ms frame — 75%** — for
three trucks. Not polygon volume: per-call overhead.

- **Wheels were four extruded prisms per truck**, twenty filled and stroked polygons
  each, for a shape 1 m by 0.4 m half hidden under the body. Flat quads now, and they
  read identically at every zoom the game uses. `drawApparatus` 3.26 ms → **0.09 ms**.
- **`shade()` re-parsed a colour string for every face of every prism on every frame**,
  with the same handful of pairs each time. Cached.
- **Nothing was culled.** At phone zoom — 60 m across a 420 m town — ten buildings were
  being extruded, windowed and lit for nothing, every frame. Props outside the visible
  rectangle are skipped now, with a generous upward margin because a building in this
  projection draws well above where it stands and its smoke goes higher still.

Phone driving **8.12 → 0.64 ms** a frame, 62 props → 26, 488 filled polygons → 212. The
town screenshot is pixel-identical.

`tools/m4-tests.js` section F — seven assertions, including the failure that actually
matters: that nothing inside the frame, or just off the top edge where it still draws
down into view, is ever culled.


## 2026-08-20 — a link worth pasting, and a report that hands the town over

Two things the project's own premise depends on.

- **The shared URL previewed as a bare domain**: no title, no description, no picture,
  blank favicon. It has Open Graph and Twitter card tags now, and a real 1200×630
  screenshot generated by `tools/_shot-og.js` — never a mock-up — plus an inline SVG
  favicon that keeps the no-extra-requests property. The boot check asserts the image URL
  is **absolute**, because a relative one previews as nothing at all.
- **The shift report used to end on the sentence "damage and broken hydrants carry into
  the next shift"** — a promise with nothing behind it. Phase 4's gate is that a player
  cares about a previous mistake, and a mistake nobody is shown is a mistake nobody can
  care about. The card now names what shift N+1 inherits: which buildings are boarded and
  for how many more shifts, which are still being patched up, how many hydrants are out,
  and the last few headlines underneath.

`tools/m8-tests.js` section E — 12 assertions on the data **and** on the rendered card,
because a block that computes correctly and renders nothing is not a feature.


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
