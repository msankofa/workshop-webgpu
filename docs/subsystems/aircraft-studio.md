# Aircraft studio

A studio for iteratively designing aircraft that are then flown in `demos/flight-sim.html`. The
shape is authored and the flight numbers are measured off it, which is the whole point: drag the
wing and the stall speed moves while you are dragging.

| File | Contents |
|---|---|
| `aircraft-layout.js` | The parametric skeleton, the physics derived from it, anchors and hardpoints. No THREE, no DOM |
| `aircraft-meshes.js` | A layout, drawn. Materials from the caller, every part named by its anchor |
| `aircraft-library.js` | The three shipped craft as layouts, plus their tuning |
| `aircraft-studio.html` | The studio |
| `test-aircraft-layout.mjs` | The falsifying comparison, the derivation's arithmetic, the panel's formulas |
| `test-aircraft-meshes.mjs` | Drawn extents against measured ones, winding, anchors, cost |

Run it with the local server — `python serve.py`, then
`http://127.0.0.1:8080/aircraft-studio.html`.

## What problem this solves

An aircraft's `wingArea` and `mass` are typed into `flight-airframes.js` by hand. Its wing is a
hard-coded box in `flight-meshes.js`. **Nothing has ever compared the two**, and a studio where you
drag a wing longer and the stall speed does not move is two panels on one page rather than an
aircraft studio.

So the shape is authored and the flight numbers are measured off it. Five fields come out:

| Field | How it derives | How well |
|---|---|---|
| `mass` | part volumes × per-material densities | exactly, once densities are split |
| `wingArea` | Σ span × mean chord, lifting surfaces only | exactly |
| `hitRadius` | half the bounding diagonal × `hitScale` | geometric part exact; see below |
| `chaseDist` | geometric radius × `chaseScale` | needs the authored multiplier |
| `size` | bounding half-height | weakest — 17% to 45% out |

Everything else — thrust, control rates, stall angle, trim speed — is tuning. No amount of measuring
a wing produces it.

`airframeFromLayout(layout, tuning)` writes the derived fields **last**, so a tuning block cannot
quietly override the shape. Wanting a heavier aircraft means making it bigger or denser. That is the
whole discipline the module exists to impose.

## The test is the point

`test-aircraft-layout.mjs` was written before anything else, because it is the cheapest thing that
can invalidate the design. The bot studio's equivalent was `botTarget.adopt(BOT_BODY_DESIGN)`
round-tripping the shipped design; **that option does not exist here**, because `flight-meshes.js` is
imperative code with hard-coded literals rather than data, so there is nothing to adopt from. The
substitute is a comparison against the hand-typed physics, which is a stronger test anyway: it checks
the link between shape and flight rather than that a schema survives a round trip.

It failed on first run, six ways, and every failure was worth having.

### Three places the drawn aircraft is not the flown aircraft

Nothing had compared these before, so nobody could have known.

- **The plane's wing.** Drawn 11.5 × 2.6 m, which is 29.9 m², against a flown `wingArea` of 16.
  The picture claims **1.87× the wing the physics gives it.**
- **The bird's body.** Drawn as a 25 litre ellipsoid. At a bird's real density that is a 22 kg
  animal, and it is flown as 4.2 kg — **1.87× too large in every dimension**, coincidentally the same
  factor.
- **The bird's wing**, in the other direction: drawn 0.43 m² against a flown 0.62.

In all three the layout is authored to reproduce the **flown** number, and the mesh is recorded as the
thing that should change. The physics was measured — every trim, stall and dive figure in `flight.md`
was flown against those values — and the mesh was eyeballed.

### One density per aircraft was not enough

Forcing a wing and a body through one figure made the 4.2 kg bird come out at 28 kg. A wing is a thin
panel of membrane and spar; a body is flesh or batteries. Split three ways (`body`, `panel`, `pod`),
every craft lands in a range you can defend out loud: 68 kg/m³ for a light aircraft's enclosed
volume, 385 for a multirotor whose battery and motors do not shrink with the airframe, and 900
against 63 for a bird's body against its feathers.

A bird's torso is also an **ellipsoid**, not a capsule. Approximating one with the other is a 40%
error on the volume that dominates the entire mass.

### `hitRadius` is not a measurement

It is overloaded five ways — the bullet and blast test, the HUD box, the explosion scale, the wreck
FX scale, and the weapon spawn offset. The shipped drone is 0.63 m across and is flown with a 1.4 m
hit radius, because a 0.63 m target crossing at 120 m/s is not a target.

That inflation is correct and stays. It lives in `hitScale` on the layout, where it is visible next
to the shape it inflates, instead of buried in a hand-typed radius where nothing distinguished a
gameplay decision from a measurement. `chaseDist` deliberately uses the **geometric** radius, so an
inflated hitbox does not drag the camera back with it.

### A test that measured the test

The first version of "does the shape drive the flight" decelerated an aircraft and recorded the
slowest speed it held height at. That sounds like a stall speed and is not one: the stability assist
trims the nose down, so it descended at every speed and the number returned was a property of the
probe rather than of the wing. It now holds one speed the shipped wing cannot carry and compares
height lost — 80 m against 66 m for a doubled wing, and 125 m for the same shape built three times
heavier.

The margin is proportional rather than absolute, because doubling a chord also doubles that panel's
volume and so adds 176 kg to a 950 kg aircraft. Twice the wing carrying 1.2× the mass is a real
improvement and a modest one, and an absolute threshold picked by eye would have been asserting a
number nothing predicted.

## The studio and its loop

Same shape as the bot design studio's: change one thing, look at it closely, read what it did, paste
it back. Three things are deliberately different.

**Rebuilds are live, not on pointer-release.** The bot studio defers because `buildSlots` clears the
shared geometry cache and regenerates 126 geometries across ~2,100 placeholders for a one-piece edit.
An aircraft is **nine meshes and 464 triangles**, so there is nothing to defer — the shape follows
the slider under your finger, and so does the performance table.

**The performance table is the instrument.** Every row is measured off the shape in the viewport, so
dragging the wing moves the wing loading, the aspect ratio and the stall speed while you drag. That
is the whole reason the subsystem exists; a panel of authored numbers next to a picture would be two
panels sharing a page.

It reports **two** slow-end limits, and the second one is a finding:

| | Plane |
|---|---|
| stall speed — where lift at the stalling angle equals weight | 27.0 m/s |
| authority speed — where dynamic pressure reaches `qRef` | 47.8 m/s |

The controls give up nearly twice as high as the wing does, so a panel showing only a stall speed
reports the wrong limit. Both are analytic rather than flown, because they have to update inside a
drag — which is exactly the kind of formula that gets transcribed wrong and looks plausible forever,
so both are asserted in the test against their own definitions.

**The reference is a ghost, not a neighbour.** The bot studio puts the shipped design in adjacent
slots; here it is a translucent wireframe at the same origin, because what you want to see on an
aircraft is whether this wing is longer than that one, and side by side cannot answer that.

The bench flies the design headlessly through level acceleration, hands-off trim drift, a 90° turn
and sink at a slow speed. It is the same `stepFlyer` the sim runs, so a bench number and a flight number
are the same number.

`Fly it` writes the design to `localStorage` under `pcw:aircraft:testbed`; `demos/flight-sim.html`
reads it on load, registers both the airframe and its mesh, and it appears as an extra airframe
button. That is the step 0 registry paying for itself — the button list builds from the registry, so
nothing in the sim's HTML had to know a studio exists.

**`focusPart(name)` works here and could not be reused from the bot studio**, whose version resolves
through `slot.body.joints`. This one resolves through the anchors the layout itself declares.
`setExplode` peels each part along its own offset — the bot studio's `groups` mode explodes by body
region, which has no aircraft analogue at all.

## The A-10, and what building it exposed

The first aircraft authored **from** the layout rather than transcribed **into** it, and the first
measured against something outside this repository. It reproduces the published figures:

| | Derived | Published | |
|---|---|---|---|
| span | 17.53 m | 17.53 m | 0.0% |
| length | 16.25 m | 16.26 m | 0.1% |
| wing area | 46.98 m² | 47.0 m² | 0.0% |
| empty weight | 11,338 kg | 11,321 kg | 0.1% |
| aspect ratio | 6.54 | 6.54 | — |
| level top speed | 706 km/h | 706 km/h | 0.0% |

The density it lands on is the interesting part, because it is not a fitted parameter — it is what
the shape and the weight jointly imply. **174 kg/m³ of enclosed volume against the light plane's
68**, two and a half times denser, which is what a titanium bathtub and a 1,800 kg gun system mean
when you weigh the aeroplane they are bolted into.

Three things only surfaced because a fourth aircraft got built:

**The schema could only describe one engine.** `exhaust` was a single object, and the A-10 has two
turbofans high on the rear fuselage. It is a list now, and `poseMesh` normalises one-or-many so
`flight-meshes.js`'s single flame still works.

**Feeding it published thrust made a 990 km/h A-10.** The gap is not drag — it is that
`flight-model.js` holds thrust constant with airspeed, while a 6:1-bypass turbofan gives roughly half
its static thrust by Mach 0.6. Chasing the top speed with `cd0` instead would have needed 0.072,
near double the drag this airframe has, and would have paid for it in climb, acceleration and turn at
every other speed. So the descriptor carries **thrust at operating speed** (41.6 kN against a static
80.6 kN) and says so. **A thrust lapse term is the real fix**, and it is not built.

**Two bench probes were measuring themselves rather than the aircraft**, and only a craft with
different numbers made it obvious. Both are recorded below.

## Two probes that measured the probe

**Top speed cannot be flown by holding full throttle and taking the fastest speed seen.** The
aircraft climbs, hits the model's 6 km altitude clamp, and then spends its entire excess thrust on
speed at the ceiling — so the answer grows with the length of the run. The same aeroplane read
766 km/h over 90 seconds and 877 km/h over 180. `levelTopSpeedOf` solves thrust against drag
instead. Drag versus speed is a U, so thrust meets it twice; only the **upper** crossing is a top
speed, and for the A-10 the lower one sits at 25 m/s, half its stall.

**Time to reverse cannot be measured as "heading is now 180° from where it started".** Under full
stick a fixed-wing aircraft never quite lands on it — the shipped plane peaks at 173° and reported
`never` forever, which reads as an aircraft that cannot turn. The bench accumulates heading change
instead and reports time to 90°: plane 1.7 s, bird 1.0 s, A-10 3.0 s. A multirotor turns on **yaw**,
so rolling one measures nothing at all.

## Hardpoints

`hardpointsOf(layout)` is where a store hangs, in the aircraft's own frame. `station` is a fraction
of the **half** span, so 0 is the root and 1 the tip; `mirror` gives the matching station on the
other side; sweep and dihedral carry it aft and up so a pylon sits where it looks like it should.

Nothing in the sim has ever had these. Ordnance spawns at a literal offset written next to the fire
call, and nothing is visible on an aircraft before it fires. This is what closes that gap.

## Mounts

`mounts: [{ id, gun, pos, dir, arc }]` is a gun that fires out of the side rather than the nose — a
gunship's battery. `mountsOf(layout)` normalises the list (fills ids, unit-lengths `dir`) and
`airframeFromLayout` copies it onto the descriptor unchanged, so the sim's `makeMounts` and the mesh
builder read the same positions. The mesh builder hangs a barrel along each mount's boresight and
exposes the anchors as `userData.mounts`; the mesh test places a flown, banked AC-130 and asserts
the drawn mount and the sim's `mountOrigin` coincide to 1e-13 m — a barrel drawn from the layout and
a round fired from it leave the same place. Each mount contributes its id to `anchorsOf`. The sim
side — arcs, ballistic aiming, shells with a blast — is in `flight.md` under "Mounts". The studio
panel does not edit mounts yet; they are authored in the layout literal.

## The AC-130

The second aircraft authored from the layout, and the one that forced `mounts` into the schema. A
C-130H airframe — 40.41 m span, 29.79 m long, 162.1 m² of wing, all reproduced inside 1.5% — with
four turboprop nacelles as pods (no propeller discs: `rotors` are measured as horizontal lift discs
and would corrupt the bounds), a tall single fin, and three port-side mounts: `m25` forward of the
wing, `l60` and `m102` aft, barrels depressed 20°. `gun: 'none'`, so it has no nose gun at all, and
`loadout: ['flare']` so the player's racks default to the side guns and flares only (see the weapons
panel in `flight.md`; the tuning object passes it through like any other field).

Its mass target is an **estimate** — the C-130H's published 34,400 kg empty plus a gunship's guns,
ammunition and armour, 38,000 kg — and `AC130_PUBLISHED` labels it as one; the test asserts it
loosely (5%) and asserts the published shape numbers tightly. Densities land at 70/60/215, a hollow
cargo hold near the light plane's figure and nowhere near the A-10's 175. Thrust is again the
operating-speed number, not static: 4 × T56 at 150 m/s is power × efficiency / speed ≈ 77 kN, tuned
to 84 kN so `levelTopSpeedOf` lands on the C-130H's 592 km/h (598 measured).

The design assertion lives in `test-flight-autopilot.mjs`: on a held left orbit at its own circuit
radius and height, the line from every port mount to the orbit centre lies inside that mount's arc,
for every sample over ninety seconds. Bank plus depression add up to where the guns need to look.

## Anchors are derived, not listed

`anchorsOf(layout)` computes the list from the layout the way the `creature` target computes its own
from a body plan, rather than reading a constant the way the `bot` target does. A twin-boom layout
has anchors a single-fuselage one does not, and a fixed list could not express that — it would be
quietly assuming one airframe, which is the failure this whole subsystem exists to avoid.

## Span is tip to tip

The single easiest thing in this code to be quietly wrong about. Getting it wrong halves or doubles
every derived area, and the aircraft still flies, just as the wrong aircraft. It is asserted directly
in the test rather than only through a craft.

## Two ways to draw a wing inside out

Both invisible from half the angles anyone checks from, so both are asserted rather than looked at.

A tapered slab is built from explicit corners, and **mirroring one reverses its winding** — the left
wing renders as a hole seen from outside while the right one looks perfect. And a **fin is the
opposite handedness** from a wing: its basis is (thickness +x, span +y, chord +z) against a wing's
(thickness +y, span +x, chord +z), so the same corner ordering winds it inside out. The fin case
shipped broken and the test caught it on the first run.

## Its gun

The A-10 names `gau8` and everything else keeps the default `cannon`, which is the first weapon in
this sim that belongs to an aircraft rather than to the module. 1,430 damage a second against the
light gun's 154, 1,174 rounds, eighteen seconds of trigger. Details and the frame-rate trap it
exposed are in `flight.md`.

## Not built yet

Missiles and bombs are still shared globals, so the A-10 carries the same four missiles as everything
else and its **eight hardpoints hold nothing** — they are correctly placed empty anchors. Weapon
descriptors and the stores that hang on them — the anchors exist and hold nothing.
`flight-meshes.js` still draws the three shipped craft from hard-coded literals; the studio's own
craft go through `aircraft-meshes.js`, so **the shipped plane in the sim still has its 1.87×
oversized wing** and a layout-built one does not. No critique contact sheet, no `auditVisibility`,
and no undo for structural edits beyond the slider stack.
