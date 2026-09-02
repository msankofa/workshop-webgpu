# Flight

Fixed-wing, multirotor and flapping flight over an analytic height field, with air combat. Player
and AI fly the same model.

| File | Contents | Imports |
|---|---|---|
| `flight-terrain.js` | Analytic height field, band limit, `agl`, dry-land placement, `setHeightSource` | nothing |
| `flight-terrain-baked.js` | Baked-grid format, validation and the CPU bilinear sampler (the GPU twin's other half) | nothing |
| `flight-terrain-stream.js` | Toroidal scrolling window: `subtractWindow`, `fillSpan`, wrapped bilinear `sample` | nothing |
| `ground-look.js` | Terrain shading law (wandering material lines, macro colour drift, rock strata) as a TSL `Fn` plus its CPU twin `groundColorRef`; load/save `ground-look.json` | three/tsl (lazily) |
| `ground-look.json` | The tuning itself: written by the flight sim's Ground look panel, read at startup | data |
| `flight-terrain-worker.js` | Module worker: builds a v5 source, fills spans, transfers them back | `terrain-source-v5.js`, stream |
| `bake-terrain.mjs` | CLI: Terrain Generator v5 project → `terrain-bakes/<name>.{json,bin}`, or `--stream` → `<name>.project.json` | terrain-generator/project/stack/paint, `flight-terrain*` |
| `flight-airframes.js` | The three airframe tables, `RHO`, `G`, slider ranges | nothing |
| `flight-model.js` | Rigid-body core, wreck integrator | three, airframes, terrain, combat |
| `flight-ai.js` | Per-archetype steering, the opponent roster | three, airframes, terrain, combat |
| `flight-combat.js` | Weapon tables, missile flight, gun lead, locking, threat warning, bomb ballistics and the impact predictor | three, airframes, terrain |
| `flight-drones.js` | The three releasable mini drones | three, combat |
| `flight-autopilot.js` | Player-selectable orbit for any airframe, on `steerToward` | three, ai, terrain |
| `flight-meshes.js` | The craft as groups (jet, quad, bird, recon UAV, two ground vehicles, the Sentinel wing); materials come from the caller | three |
| `water-hybrid.js` | Optional ocean surface: Gerstner swell, foam, depth colour (shared with `demos/water-demo.html`) | three, `water-waves.js` |
| `water-config.json` | The water settings themselves: written by `demos/water-demo.html`, read here | data |
| `demos/flight-sim.html` | The viewer: meshes, HUD, audio, FX, panel, clipmap | all of the above |

Tests: `test-flight-model.mjs`, `test-flight-terrain.mjs`, `test-flight-terrain-baked.mjs`,
`test-flight-terrain-stream.mjs`, `test-ground-look.mjs`, `test-flight-ai.mjs`, `test-flight-combat.mjs`, `test-flight-drones.mjs`,
`test-flight-autopilot.mjs`, `test-water-hybrid.mjs`, `test-water-waves.mjs`,
`test-flight-meshes-recon.mjs`, `test-flight-meshes-sentinel.mjs`, `test-vehicle-meshes.mjs`. Plain Node, no framework, per repo convention.

The demo needs a server (`python serve.py`) because of the ES module imports, then
`http://127.0.0.1:8080/demos/flight-sim.html`. Add `?terrain=<name>` to fly a bake instead of the
analytic field, or pick one from the panel's Ground dropdown (it reloads, because the height field is
chosen before any material is built). `serve.py` lists what is available at
`/api/list-terrain-bakes`.

## Why the split is where it is

One exception to that line since 2026-08-10: `flight-meshes.js` holds the craft *groups* (geometry and proportions), because the bot viewer's drone operators fly the same quad and the same fixed wing and a private copy would drift. Materials still belong to each page — this one runs node materials, the bot viewer does not — so the builders take a `{ standard, basic }` pair and `buildMesh` here is one call into the module. Everything else below still holds.

A fourth kind joined the three on 2026-08-22: `recon`, a fixed-wing reconnaissance UAV whose
proportions were measured off a press photograph rather than sketched — 2.02 m span, 1.13 m long,
pusher propeller aft of the tail boom, 35-degree V-tail, paddle wingtips. Only the bot viewer flies
it (its loitering munitions); the sim's own `plane` is still the jet and is untouched. It is the one
craft here authored in real metres, so it wants a scale near 1 rather than the 0.22 the jet needed.

`sentinel` (2026-09-01) is the second real-metre craft: a 20 m stealth flying wing whose planform,
section and hump were measured off a three-view drawing of the RQ-170 Sentinel
(`scratchpads/rq170-sentinel/intake-analysis.md`, the img2threejs reconstruction behind it). The wing is
one loft — ribs at the measured stations, a flat upper skin and a lens underside, mirrored so both
halves share the centreline vertices — with the hump, blisters, blunt tail, intake and exhaust as
scaled spheres and boxes, 2.5k triangles, no landing gear because it only ever flies. Base Game flies
it as its world drone; the sim does not use it.
It hangs `userData.propeller`, a hub group that spins about **Z**, where the quad's
`userData.rotors` are blades that spin about Y; a caller that animates one does not animate the
other for free. The photographed blue-and-yellow livery is deliberately not reproduced, because the
caller tints the shell by team and printed colour would fight that read.

The line is **decisions and trajectories** on one side, **pictures** on the other. Anything that was
wrong on first authoring in a way that looked fine on screen belongs in a module with a test; the
meshes, materials, HUD canvas and audio stay in the viewer.

`demos/flight-sim.html` is the second exception to the "demos import nothing from the repo" rule,
after `spsa-gait-tuning.html`, and for the same reason: the point of the demo is to argue for
shipping these modules, and a private copy would be arguing for nothing.

Three seams were chosen so the modules hold no hidden state, and they are the seams an entity
registry would plug into:

- **`stepFlyer(f, dt, assist)`** takes the stability assist as an argument. It was a page-level flag.
- **`aiShoot(f, world)` returns intent** (`{gun, missile}`) rather than firing. `aiGoal` sets
  `f.wantFlares` rather than spawning them. The viewer is the only thing that creates anything.
- **`driveAi(f, dt, world)`** takes `world = { flyers, player, aiEngage }` rather than importing it.
- **`stepWreck(f, dt)` returns `{fire, smoke, pop, landed}`** — the timers are physics, the puffs
  are not.

## The airframe registry

`AIRFRAMES` is a registry, not a literal. `getAirframe(key)` throws on an unknown key naming what is
registered, `registerAirframe(key, def)` adds one at runtime after validating it, and
`airframeKeys()` is what the airframe buttons and the AI test loop iterate.

**Every per-class difference lives on the descriptor.** It did not use to, and that was the whole
problem: the mesh builder, the AI patrol circuit, the engine tone and the starting throttle each
carried their own `key === 'plane' ? … : key === 'drone' ? … : …` chain, and **every one of those
chains ended on the bird's value with no error**. A fourth airframe flew a bird's 820 m circuit,
rendered as a bird, held perfectly still because `poseMesh` named no branch for it, and made a
plane's engine noise. Nothing threw. The four fields that ended it are `mesh`, `circuit`,
`enginePitch` and `idleThrottle`; `armable` replaced a fifth chain, `if (f.afKey === 'bird')` inside
`aiShoot`.

`validateAirframe(key, def)` returns a list of complaints rather than throwing, so a studio can show
them mid-edit while `registerAirframe` and `makeFlyer` treat them as fatal. It checks the required
fields, the fields the craft's own `lift`/`thrust`/`control` reach, and — the one that is not
obvious — that every `tunables` entry has a `TUNE_RANGE` row. A tunable without one used to vanish
from the panel silently, which reads as "that field is not tunable" rather than "somebody forgot a
row".

Validation runs at **construction, never in the step loop**. An airframe missing a field its force
generators read produces a NaN position one frame later, and a NaN is a far worse error message.

Two dispatches are now keyed on capability rather than identity, and both got better for it:

- `buildCraftMesh(kind, tint, materials, dims)` is a `BUILDERS` lookup that throws.
  `registerCraftMesh(kind, fn)` adds one. `dims` is optional and only the two ground vehicles read
  it: Base Game passes the vehicle's simulation def so the wheels are drawn on the same wheelbase,
  track and clearance the ground fit samples. Aircraft callers pass three arguments as before.
- `mergeByMaterial(root, skip)` bakes static parts into one geometry per material, relative to
  `root` rather than the world so a nested animated group keeps its own offset. The ground vehicles
  use it via `finishVehicle(g, wheels, groups)`; assembled from loose primitives they were 44 and 85
  draw calls, and `buildCraftMesh` turns frustum culling off on every part. `groups` names the parts
  that must stay articulated — the UGV passes its weapon station, which lands on `userData.turret`.
- `loftRings(rings)` closes a ring loft along Z for hull tubs, whose cross-section changes station
  to station and so cannot be extruded. Winding is not obvious: check enclosed volume is positive,
  as `test-vehicle-meshes.mjs` does, because an inverted loft still passes every dimension check.
- `poseMesh` reads what the mesh **exposes** — `userData.flame`, `.rotors`, `.wings` — so a new craft
  with an exhaust gets exhaust animation for free, and a craft with both a flame and rotors gets
  both. The key-shaped version could not express that at all.

`thrust: 'none'` is a legal glider. It falls through the thrust chain deliberately; any *other*
value would too, which is exactly why registration rejects it.

## One core, three airframes

The classes are genuinely different physics, not one model with different numbers.

| | Plane | Drone | Birdlike |
|---|---|---|---|
| Thrust | along the nose, throttle-set | along body up, vectored by tilting | impulsive, on the wingbeat |
| Lift | wing at AoA | none — thrust carries the weight | wing at AoA, low wing loading |
| Control | rate command, authority scales with dynamic pressure | attitude command, self-levelling | rate command plus flap impulse |
| Stall | central to flying it | not applicable | recoverable, used to land |

The airspeed-dependent control authority (`qRef`) is what makes a stall feel like a stall rather
than a speed cap. The drone deliberately has none of it.

**Trim seeks the AoA that supports 1 g, blended toward the airframe's reference speed.** That has a
consequence worth knowing before you fly it: hands-off, **throttle controls climb and the stick
controls speed**, the way a real aircraft is flown. Measured over 40 s from 900 m: −258 m at 15%
throttle, −34 m at 25%, +309 m at 40%, +986 m at 70%, with the speed pinned between 99 and 141 m/s
against a trim speed of 105.

The assist is trim, not an autopilot, and the dive numbers say so plainly. A hands-off 40° dive
recovers, but costs 2624 m and 47 s; the same dive with the stick pulled costs 38 m and 0.8 s. You
are expected to pull.

### Five bugs the headless suite caught

Each would have looked like nothing in particular on screen.

1. Trim sought **zero** AoA, which is zero lift, so an untouched aircraft sank 780 m in 30 s.
2. Trim then sought 1 g **at the current speed**, which has no speed reference at all, so a dive was
   self-sustaining and rode into the ground.
3. Flap thrust pointed 0.72 **upward**, so the bird levitated its own flight path into a steepening
   climb until it stalled. A flap is thrust; the wing is what lifts.
4. The AI chased a target swept along a curve at `radius·rate` m/s — faster than any class could fly.
   All three saturated their controls and flew into the ground.
5. The AI banked **away** from its target. Heading is `atan2(-fwd.x, -fwd.z)`, which increases to the
   left, while positive bank rolls right. The error parked at 180°, flipping across the wrap, and the
   aircraft flew off the map with its wings rocking.

## Terrain

`flight-terrain.js` is a sum of 16 plane waves whose directions are spread by the golden angle, with
domain warping, plus a ridge term. The GPU twin is a TSL node graph in the viewer — the `WAVES`
table is shared so only the *shape* is written twice, but that is still enough to drift. **Edit them
together.** Same hand-synced arrangement as `forest-cull.js` / `light-cluster.js` / `post-grade.js`,
except here the CPU side is production rather than a test mirror.

**Why not `sin(x·a)·cos(z·b)`.** The first version was four of those and came out as parallel furrows
across the whole map. It is separable, so bumps sit on a rectangle square with the world axes; and
every octave used `b/a` near 1, where `sin(A)cos(B) = (sin(A+B) + sin(A−B))/2` collapses to one
diagonal plane wave plus a long beat. Measured directional energy: 4.6× the mean in the strongest
direction, against 2.2× for the current field.

**Why it is band-limited by distance.** The clipmap samples on a lattice that doubles every ring —
10.7 m cells at the centre, 170 m at 8 km. Ring 4 carried 1.4 samples per wavelength against a 243 m
finest wave, well under Nyquist, and showed as fingerprint-whorl moire. Every wave now fades out as
the local sample spacing approaches it: full weight at 8 samples per wavelength, gone by 4. Nyquist
is 2, but 2 is where a signal becomes *representable*, not where it looks right.

The weight is a function of **distance, not ring index**, and that matters: neighbouring rings
overlap along a band, and if they disagreed about the height there the seam would crack open.

| Ring | Cell | Samples/wavelength before | after |
|---|---|---|---|
| 0 | 10.7 m | 22.8 | 22.8 |
| 2 | 42.7 m | 5.7 | 5.7 |
| 3 | 85.3 m | 2.8 | 4.7 |
| 4 | 170.7 m | **1.4** | 4.9 |

Physics is never band-limited: `heightAt(x, z)` defaults to full detail, and only the picture fades.

### Dry land: the bases were being built in a lake

`BASE_OFFSET = -40` deliberately pushes the low ground under `y = 0` so the water plane makes lakes,
and it works rather too well: **44% of the field is below the waterline**, measured on a 200 m grid
out to 8 km. The two ground-site clusters were placed at fixed offsets from the player's spawn
(`cx + 2600, cz - 1800` and `cx - 3200, cz + 2400`) and each building simply dropped to `heightAt`,
with nothing asking whether that was under water. From the default spawn, **nine of the eleven
buildings were submerged**, the undefended base 200–400 m down; over 200 spawns, 43% of all buildings.

`dryAnchor(x, z, offsets, {maxR, samples, avoid, avoidR})` fixes it by moving the **cluster**, never
the building — nudging each site to its own dry spot would scatter a base whose layout is the point.
It walks a golden-angle spiral outward (radius `maxR·√(i/samples)`, which spreads samples evenly over
the disc) and takes the first anchor where `lowestOf` — the lowest ground under any offset in the
footprint — clears `SEA_LEVEL + DRY_MARGIN` (0 + 8 m). Properties that matter:

- **Deterministic.** No `Math.random`, so the map does not reshuffle when a panel toggle rebuilds it.
- **Always returns something**, the driest anchor it saw, because a base that silently failed to
  place is just a missing base.
- **Stays put when it can** — an already-dry anchor returns `moved: 0`.
- **`avoid` keeps the two bases apart** (2.5 km), or the undefended one gets dragged onto the
  defended one's island, and it is meant to be reachable without fighting through the SAM ring.

Measured after: **0 of 2200 buildings underwater** over 200 spawns, worst footing 8.5 m, median
cluster move 424 m and max 2.9 km, and the search costs 0.05 ms.

### Baked ground: flying a Terrain Generator v5 map

`?terrain=<name>` swaps the wave field for a bake in `terrain-bakes/`. Default (no parameter) is the
wave field exactly as before, so this is opt-in and reverting is deleting a query string.

**Why bake instead of evaluating v5 live.** Two separate reasons, and only the second is fundamental:

1. v5's layer stack is a JS switch over a runtime list of layer objects (`evaluateStackPoint`), which
   a vertex shader cannot run. This one is *only* labour — TSL builds its graph in JS, so the layer
   loop would unroll at build time into straight-line shader code. It is about 1,900 lines to
   transcribe, almost all of it the `classic` layer's `terrain-generator-js.js` +
   `biome-classifier-js.js`, and it would create a new hand-synced twin.
2. Erosion, hydrology and paint are **not point functions at all.** The height at one spot depends on
   what the whole grid did over many iterations, so there is no equation to hand a vertex shader or a
   CPU sampler. This is why `terrain-source-v5.js` lists them in `classification.omitted` and refuses
   painted projects outright. A grid of numbers is the only representation that carries them.

So `bake-terrain.mjs` runs `generateFullGridV5` — the **editor's** pipeline, not the runtime source —
and what you saw in the generator is what lands in the sim. It subtracts the project's `sea_level` so
the sim's water plane at y=0 lands where the author put the coast, and `--size` stretches a small
project over a bigger world (landforms get wider, not taller, which suits an aircraft).

**The swap is one function.** Every consumer — physics, AI, ballistics, the gunner's ground march,
`agl`, `dryAnchor` — imports `heightAt` and nothing else, so `setHeightSource(fn)` in
`flight-terrain.js` changes the world without touching a call site. `setHeightSource(null)` restores
the wave field bit-for-bit, which the test asserts.

**The sampler is the twin, and it is deliberately not a hardware fetch.** `sampleBake()` in
`flight-terrain-baked.js` and `tslBaked` in the viewer both do four clamped integer texel fetches and
two lerps. Hardware bilinear was rejected twice over: `r32float` is only filterable where the device
reports `float32-filterable`, and leaning on the sampler would mean matching its texel-centre
convention rather than controlling the arithmetic. `test-flight-terrain-baked.mjs` re-derives the
shader's formulation independently and demands **bit-identical** agreement — which caught the CPU
side using `a*(1-t) + b*t` where GLSL's `mix` expands to `a + (b-a)*t`.

**Normals need a bigger `eps`.** A bake is bilinear, so slope is constant inside a cell: taps closer
together than one post land in the same cell and every quad shades flat. The ring normal step is now
`max(4, cellSize * 0.5, bake.step)`.

**Measured** on a 2049² / 8 m bake of the wave field: reproduces the source to **8 mm mean, 1.08 m
worst**; `heightAt` runs at **51 ns/call against the wave field's 462 ns — 9× faster**, since 16 sines
and a domain warp cost more than two lerps; bases still place dry (0 of 2200 underwater, median move
600 m). File size is 16 MB of Float32.

**What it costs.** The world becomes finite — outside the baked square the edge cell extends forever,
so terrain stops changing rather than ending. There is no detail below the post spacing. And a bake
is a build artifact, so editing the project means re-baking.

### Streaming: infinite v5 ground

`bake-terrain.mjs <project> --stream` writes no heights at all — just the project — and the viewer
generates ground around the plane forever. There are now three grounds, chosen once before any
material is built:

| | waves (default) | bake | stream |
|---|---|---|---|
| Extent | infinite | 16 km square | infinite |
| Erosion, hydrology, paint | n/a | **yes** | no |
| Cost | free | 16 MB, no CPU | 4 MB, 8% of one worker core |

**Why this is possible at all, and why erosion still is not.** The v5 *generation field* was already
infinite — `terrain-source-v5.js` declares `capabilities: ['infinite']`, `bounds: null`,
`contains()` returns true everywhere, and `heightAt(1e9, -1e9)` answers with a finite number. The
static bake's edge was a choice of mine, not a limit of v5's. What genuinely cannot be unbounded is
the list v5 reports as `omitted`, and the wording there is worth reading carefully: erosion and
hydrology are `(bounded; preview only)` because flow accumulation asks how much water passes a point
and the answer is the size of its upstream catchment, which no bounded neighbourhood contains.
Biome masks are only `(not streamed yet)` — a wiring gap, since the climate sampler is already
unbounded.

**This is Minecraft's answer.** Minecraft does not simulate erosion either; "erosion" there is one of
six climate *noises* that selects a terrain shape from a spline, and biomes are a table lookup on
those same noises. Both are point functions, which is exactly why it is infinite. v5's `classic`
layer already works this way — `biome-classifier-js.js` has channels named `continentalness`,
`erosion`, `weirdness`, `temperature`, `humidity`. So streamed terrain can look weathered; it is just
not water-routed.

**The window is toroidal.** `flight-terrain-stream.js` holds `res × res` posts and never slides its
contents: global post `(gx, gz)` always lives at texel `(gx mod res, gz mod res)`, so moving east
overwrites the column that just fell off the west edge, in place. Advancing costs one strip of
generation and no memory traffic. `subtractWindow` turns a move into up to four non-overlapping
rectangles — only the newly exposed ground is generated. The GPU does the same `mod` on its integer
fetch, which is why the twin stays a twin.

Three details that are load-bearing:

- **The cell and fraction come from the GLOBAL coordinate; only the fetch wraps.** Computing the
  fraction in window space is algebraically identical and drifts ~1e-13 m as the window scrolls,
  making a hill's height depend on where the plane is. Picometres, but there is no reason to accept
  a position-dependent answer, and the test now demands bit-exactness.
- **The sea-level shift and height scale live in the source**, applied identically in the worker and
  in the main thread's out-of-window fallback. When they did not, ground stepped by `sea × scale` at
  the window edge — invisible in a screenshot, fatal to a plane crossing it.
- **`sample` refuses anything not wholly inside the window**, because a cell straddling the wrap
  would take neighbours from the opposite edge of the world. The caller falls back to the generator,
  which is exact everywhere and merely slower (2.4 µs), and that is what answers for a missile or an
  AI waypoint tens of kilometres out.

**Measured**, 1025² posts at 20 m (a 20.5 km window against the clipmap's 8.2 km reach), flying
75 km at 250 m/s: first fill **2.3 s** (in the worker, so the tab stays responsive), then **77
scrolls, one every 3.9 s, 324 ms mean and 437 ms worst each, 8.3% of one core**, and the plane never
left the window. A full-window rebuild for comparison is 2.3 s, so incremental fill is the difference
between this working and not.

The one rough edge is that 2.3 s of startup. Splitting the first window across several workers would
cut it roughly linearly; it is one rectangle and would not disturb anything else.

### Ground look: why the terrain read as fake

The ground was four flat colours mixed on `smoothstep(height)` and `smoothstep(slope)`. The problem
with that is specific and worth naming, because it is not "not enough detail": **a threshold on
height alone draws a perfect elevation contour.** Real snowlines and treelines wander, because what
grows where depends on aspect, shelter and soil rather than altitude. A contour-perfect snowline
reads as wrong from 2 km up no matter how good the texture on either side of it is.

So `ground-look.js` adds three things, in the order they matter at cruise altitude:

1. **The material lines wander.** One noise field offsets the height fed to the grass and snow ramps
   (`edgeJitter`, default 46 m) and the slope fed to the rock ramp (`slopeJitter`, 0.09).
2. **Macro colour drift.** A second field pulls the palette toward `dry` in patches (`tintScale`
   820 m), a third drifts value light and dark much more broadly (`patchScale` 3.2 km), so no two
   square kilometres match.
3. **Rock strata.** Horizontal banding on steep faces only (`strataPeriod` 34 m), which is what
   gives a cliff a sense of scale.

Cost is three `mx_fractal_noise_float` calls, 9 octaves total, per fragment.

**Detail texture is deliberately not here.** `textures/ground/` already holds 13 PBR layers and
`terrain-textures.js` loads them, but a 4 m tile across a 16 km view repeats ~4,000 times and tiles
visibly; and at cruise altitude the detail is under a pixel anyway. It belongs on the near clipmap
rings with triplanar projection and multi-scale blending — a separate job, and the one place it
clearly pays is the AC-130 gunner view, which is zoomed at the ground.

**The law is twinned, the noise is not.** `groundColorRef` is the exact arithmetic the TSL runs,
taking the three noise values as arguments instead of generating them: MaterialX fractal noise has no
practical JS reimplementation, but what actually goes wrong is the ordering and clamping of the
palette, and that is fully testable. Same arrangement as `moss-tint.js`.

**With every added term at zero it is bit-identical to the old flat ramp**, which
`test-ground-look.mjs` pins. That property caught a real bug: `enabled: 0` zeroed the three noise
inputs but left the strata running, because strata is driven by *height*, not noise. A look that
cannot be switched fully off is a rewrite rather than a layer, and there is then no way back to a
known-good picture.

Tuning lives in `ground-look.json` (loaded at startup, saved by the panel through
`/api/save-ground-look`), never in web storage. `enabled` and the octave counts are graph shape and
need a reload; everything in `GROUND_LOOK_RANGE` is a live uniform the sliders retune directly.

### Three metrics that measured the wrong thing

Recorded so nobody re-derives them. Autocorrelation measured how *smooth* the ground was, not how
repetitive, and scored both fields 0.93. Plain slope-by-direction was drowned by the 7 km landform
terms and scored both at 2.4×. Variance below Nyquist read 0.02% where the slope measure read 22.5%.
Same field, same rings, three orders of magnitude apart, and only one of them about what you can see.

## Combat

Guns on a swept-segment test (a round covers 15.7 m per 60 Hz step, so a point test against a 6.5 m
target misses most of the time), missiles on proportional navigation, flares that can steal a lock,
and ground sites — radar, SAM, AA, plus undefended base structures.

**Gun lead is iterated.** Aiming where the target will be after `range/muzzle` seconds misses by up
to 42 m against a 210 m/s crosser at 900 m, because leading pushes the aim point further away, which
lengthens the flight, which moves the aim point again. Three iterations plus drop compensation bring
the worst case to 2.4 m.

**The threat warning is two sounds, then a third.** A low siren while something holds a lock; a beep
that quickens as a missile closes; a two-note falling chime when you get away with it. Two defects
lived in the cadence, both found by simulating a closing missile rather than by listening:

1. **Time to impact is not monotone.** Near a near-miss the closure collapses, so `range/closure`
   climbs and the warning *relaxes* at the exact moment it should be screaming — measured widening
   from a 0.089 s gap back to 0.65 s. The rate now takes the smaller of the time-to-impact and
   raw-range estimates, then ratchets.
2. **A pure ratchet screams forever.** A missile that overshoots keeps tracking while opening range.
   The ratchet only holds while the range is shrinking.

The evaded chime has three cases where it must stay silent, each a way of pretending you got away
with something you did not: the blast damaged you, you are dead, or a second missile arrived with no
gap. One ordering trap cost the whole feature on first authoring — the "did I have a threat" read has
to happen **before** the loop that clears every flyer's threat, because that loop is the only thing
still holding last frame's value.

**`pickThreat` decides which missile the warning is about, and it has to be the one arriving first.**
Missiles live in a 12-slot pool handed out by first free slot, so pool order carries no meaning. The
warning used to keep whichever live slot came last, which meant a 6 km SAM shot could mask the one
400 m off your tail: the HUD read ten seconds while you died. Ranking is by time to impact now, and
the pool is scanned per flyer rather than written into by the missiles.

Two things follow from putting the choice in one place:

- **A missile aimed at somebody else can still kill you.** The blast radius (`COMBAT.msl.blast`,
  55 m) is more than three times the fuse (16 m), so a missile fusing on your wingman reaches you and
  there was no warning at all, because nothing was tracking you. `missileDanger` now also counts a
  missile whose closest approach on the current relative track falls inside the blast radius, and the
  HUD labels it `MISSILE PASSING` rather than `MISSILE — BREAK` so the two stay distinguishable. One
  that is opening the range does not count.
- **The beep rate and the HUD seconds come from the same measurement.** They used to be computed
  separately, and from different quantities — the HUD divided by the missile's own speed, the beep by
  the closure rate along the line of sight. `pickThreat` returns range, closure and time to impact
  together and both readers use them.

## Missiles you can actually beat

`stepMissile` lives in `flight-combat.js` rather than the viewer specifically so the question "can
this be dodged" can be answered by flying the real aircraft model against it in Node. It could not,
and the measurement is stark — under the old flat g limit a full break turn moved the miss distance
from 5 m to 6 m at 800 m and from 6 m to 10 m at 3600 m. There was no evasion, only luck.

Two changes, both physical rather than arbitrary:

- **`missileMaxG(speed)` scales the g limit with the square of speed** (`gRef` is the speed at which
  the full rating is available). Manoeuvre comes from lift and lift goes with v², so a missile that
  has been coasting for fifteen seconds should not corner like one fresh off the rail. It does not
  any more: 24 g at 600 m/s, 9.4 g at 300, 4.2 g at 200.
- **Turning costs induced drag** (`induced`, as a multiplier on the parasitic term scaled by n²).
  This closes the loop that makes evasion a skill: turning costs speed, and speed is what buys the
  turn. Force it to follow a hard break and it spends the energy it needs to keep following.

The guidance also compensates for gravity now. Without that, the seeker burned its whole budget
re-correcting a fall it never anticipated, which taxed a straight-line intercept as hard as a hard
turn — the first cut of this change let you escape by flying level, which is worse than the problem.

Measured outcome against a 110 hp plane, miss distance and damage:

| Launched at | Fly straight | Break at once | Break at 900 m |
|---|---|---|---|
| 800 m | 7 m, 130 — dead | 12 m, 117 — dead | 5 m, 136 — dead |
| 2000 m | 9 m, 125 — dead | 29 m, 70 — hurt | 9 m, 126 — dead |
| 3600 m | 296 m, 0 — out of energy | 46 m, 25 — hurt | 12 m, 117 — dead |

So: a knife-range shot still kills you, a long shot is survivable if you turn immediately, and
leaving it late is fatal at every range. Note the top-right of that table — past about 3 km the
missile runs out of energy before it arrives, so flying straight already beats it and turning only
drags it back into range. Breaking is the right answer everywhere the shot could actually reach you,
which is not quite the same claim.

## Weapon selection

Two triggers, two selectors, so neither hand leaves the stick to reach a weapon:

| | Trigger | Selector | Carries |
|---|---|---|---|
| Offensive | `Space` / mouse 1 | `Left Alt` | gun, missile, bomb, heavy bomb, kamikaze |
| Defensive | `C` / mouse 2 | `Right Alt` | flare, decoy, interceptor |

Each entry carries **the call that fires it**. It used to be an `if (w === 'gun') … else if …` chain
against literal keys, so every new weapon was a branch in a dispatcher rather than a row in a list.

Selection is the **player's only**. The AI still calls `fireGun`/`fireMissile` directly, because
which weapon is selected is a UI question and an AI that had to answer it would be modelling a menu.

The bird's flap moved from `Space` to `Q`. `F` and `G` are gone — with a selector, a second key that
fires a specific weapon regardless of selection is a contradiction rather than a shortcut.

Both alt keys need `preventDefault`, or a bare Alt hands focus to the browser menu bar and the
keypress never arrives. Same for `Space`, which scrolls.

The HUD lists everything you carry rather than only the selection, because "what else have I got" is
the question asked immediately after something runs dry. Empty racks go red, unselected ones grey.
The gun funnel only draws with the gun selected: it is a sight, and a sight for a weapon you are not
about to fire is clutter.

### The weapons panel and the active set

The panel's **Weapons** section lists every offensive and defensive store plus each side mount, one
row each: an **active** checkbox and −/+ steppers with a typed field for **ammo**, **damage** and
**reload** (seconds; a gun's is `1/rps`, stored back as `rps`). The rows edit the SAME defs the fire
paths read (`f.gun` / `GUNS`, `COMBAT.missileMax` + `COMBAT.msl.damage/cool`, `BOMBS[k].max/damage/cool`,
`DRONE[k].max/damage/cool`, `COMBAT.flareMax` + `COMBAT.flare.cool`, a mount's `m.gun`), so a number
typed there is the number that fires — and since those defs are shared, damage and reload change for
every aircraft carrying the store; only ammo also refills the player on the spot. `COMBAT.msl.cool`
and `COMBAT.flare.cool` exist because of this: the reloads used to be literals in `fireMissile` and
`dropFlares`. Fields a store does not have (flare damage, decoy/interceptor damage) show as `—`.

`weaponActive` is the player's set of what may fire. `defaultWeaponActive(f, key)` follows the
aircraft: nothing on an unarmable craft, the gun only if `af.gun` names one, a mount if it exists,
and everything else per `af.loadout` (a list of store keys; absent means everything — the AC-130
declares `loadout: ['flare']`, so its racks are the side guns and flares). It resets when the airframe
changes and the checkbox flips one entry. `fireSelected`/`deploySelected` refuse an inactive store,
`cycleWeapon` skips them (`nextActive`), the HUD racks list them dim with `OFF`, the gun funnel and
bomb pipper hide, and `gunnerMounts()` is the active subset (`activeMounts`) — take every side gun off
and the gunner view drops back to chase. The AI is not consulted: it never had a menu, and a store the
player took off is not a store the world lost. `validateAirframe` checks `loadout` is a list of strings.

Restructuring the fire path surfaced a pre-existing defect: `fireGun` decremented `gunCool` itself
*and* the per-flyer loop decremented it again, so a held trigger ran at 44 rounds per second against
a table that says 22, and ammunition drained twice as fast as designed. Only the loop does it now.

## Guns belong to the aircraft

`GUNS` is a per-weapon table and a flyer carries its resolved def on `f.gun`, the way a bomb carries
`b.def`. `gunFor(key)` throws on an unknown gun rather than quietly arming the default. An airframe
that names no gun gets `cannon`, whose numbers are exactly the old `COMBAT.gun*` values, so nothing
that has not opted in changes at all.

| | cannon | GAU-8 |
|---|---|---|
| rate | 22 rps | 65 rps |
| damage | 7 | 22 |
| damage/s | 154 | **1,430** |
| muzzle | 940 m/s | 1,010 m/s |
| range | 2,400 m | 3,600 m |
| magazine | 900 | 1,174 — eighteen seconds |

A round carries its own damage, because at 65 a second it is still in the air long after the
aircraft that fired it has been shot down.

**A 65 rps gun broke a rule nothing had ever tested.** `fireGun` is called once a frame, so a gun
could never exceed the frame rate — 22 was safely under 60 and nobody noticed. A 65 rps cannon would
have fired at 60 on a good machine and 30 on a bad one: a weapon whose damage output depends on the
player's graphics card. The cooldown is now **accumulated rather than reset**, so several rounds
leave per call and the rate is exact at any frame length. The debt is bounded at both ends — a
`MAX_BURST` of 6, and a floor on the per-frame decrement — or a trigger pulled after a long pause
would dump the whole backlog in one frame. The decrement itself still lives only in the flyer loop;
doing it in both places is what once ran the gun at 44 rps against a table that said 22.

Two consequences worth knowing. The bullet pool went from 320 to **768**, because a 65 rps gun
reaching 3.6 km keeps 232 rounds in the air by itself and would otherwise starve every other
shooter. And the gunshot plays once per call rather than once per round, since sixty-five of them a
second is not a sound.

`applyAimAssist` and `aiShoot` both read the shooter's own gun now — a faster shell needs less lead,
and a cannon that carries 3,600 m should not hold fire at the 900 where the light gun gave up.

Still global: **one missile for everybody.** `stepMissile` reads `COMBAT.msl` inside itself and the
12-slot pool has no per-slot def, so two different missiles on one aircraft is a state-shape change
rather than a table entry. Guns and bombs are the pattern it has to follow.

### Mounts: guns that are not in the nose

A gunship shoots out of its side, at a point on the ground, from a platform that is itself moving,
with shells slow enough to drop a hundred metres on the way. None of that fits `fireGun`, which
takes `f.fwd` as gospel, so mounts are a second shape beside it rather than a flag on it.

`af.mounts` is a list of `{ id, gun, pos: [x,y,z], dir: [x,y,z], arc }` in the aircraft's own frame
(x right, y up, z aft — the layout convention). `makeMounts(af)` turns it into one live instance per
entry with its own `cool` and `ammo`, carried on `f.mounts`; anything without mounts gets an empty
list. `af.gun: 'none'` is the legal way to say there is no nose gun at all, and leaves `f.gun` null —
the HUD, aim assist and the AI already tolerated that.

Three guns are the reason: `m25` (25 mm, 30 rps, no blast), `l60` (40 mm, 2 rps, 9 m blast) and
`m102` (105 mm, 0.16 rps, 34 m blast). A round with `blast` is a shell: it detonates on **any**
contact, ground included, and hurts a circle regardless of side, the bomb rule. A round without one
is a bullet and hurts what it touched. Both ride the one bullet pool through `spawnRound`, which the
nose gun uses too, so a round is a round wherever it left the aircraft.

Aiming is `mountOrigin` (the muzzle), `ballisticAim` (barrel direction so a round of that speed,
falling at `SHELL_GRAVITY`, from a platform moving at `f.v`, arrives at the point — the round's
velocity is aim·speed + platform velocity exactly as `spawnRound` builds it, so what it solves is
what flies) and `clampToArc` (train into the mount's arc, sliding along the rim rather than snapping
to the boresight). `ballisticAim` returns null beyond reach and `fireMount` then refuses to fire
short and call it a miss. The test flies every calibre from a moving aircraft at 3.2 km and lands
inside a metre; ignoring the platform's own speed misses by 800 m, which is the reason it is in the
solve. `fireMount` keeps every rule the nose gun learned: accumulated cooldown, `MAX_BURST`, one
sound per call, and the flyer loop floors each mount's debt.

### The gunner camera

**4** (or the Gunner button) on a craft with mounts. A sensor ball on the port side, stabilised: the
aim is a WORLD direction the mouse slews (`gunner.yaw/pitch`), so the picture does not roll when the
aircraft banks and the crosshair stays on the ground while the orbit carries the airframe round.
The camera looks straight down the aim; the aim's ground point (`groundHit`, marched then bisected
on the same `heightAt` the shells fall onto) is where the selected mount's shells land by
construction, because `ballisticAim` solves the barrel to hit it — so the crosshair is the reticle
and nothing is projected. What the HUD adds is whether the SELECTED mount can be trained there
(`RANGE / TOF`, `OUT OF ARC`, `OUT OF RANGE`, `NO GROUND`), a dashed circle the size of the shell's
blast at that range, the three mounts with ammunition, and the flight state the pilot can no longer
see. The target boxes (aircraft, ground sites, pods, with off-screen arrows) are the pilot HUD's own,
drawn by the shared `drawTargetBoxes` — the pilot HUD does not have the tape, radar or ladder here. **Left Alt** cycles the mount, **Space / mouse 1** fires it, the **wheel** steps the field of
view (10/20/30/45°, and the slew rate scales with it), **T** re-centres the orbit autopilot on the
crosshair's ground point at the current radius. Entering the view points the sensor at the orbit
centre if there is one, else down the middle mount's boresight, and asks for pointer lock; leaving
releases it. Switching to an aircraft without mounts drops back to chase.

**Arc lock** (**L**, on by default, `gunner.arcLock`): every frame `lockAimToArc` clamps the sight
line into a copy of the selected mount's cone shrunk to `ARC_LOCK_MARGIN` (0.9) of its arc through
`clampToArc` and writes the result back to `gunner.yaw/pitch`, so the mouse sticks at the rim and
the orbit's turn drags the aim round with the aircraft. If the ballistic solution still falls
outside the arc (the barrel superelevated past the upper rim at long range) the loop in
`updateGunnerCamera` pulls the margin in by 0.1 steps and solves again, so `OUT OF ARC` should not
appear while locked. Free (`ARC FREE`, amber) restores the unrestricted sensor. `drawArcRim` draws
the full arc as a dashed loop on the picture in either state — green locked, amber free — so where
the gun can look is a shape rather than a message.

Enter it on the AC-130 with **O** already held: the aircraft circles left, the port guns face in,
and the sensor is looking at the middle of the ring.

### Vision modes

**V** cycles RGB → NVG → white-hot → black-hot, everywhere, not only in the gunner view. The
mechanism is `vision-modes.js` (documented under `fx.md`); what the flight demo did was opt its own
materials in: the terrain's TSL graph emits `terrainHeat` (rock warmer than grass, snow and water
cold) and blacks its diffuse under IR; the sky mixes to cold with the sun's disc as a hot spot; the
clouds mix to cold and still occlude; craft skins are `HEAT.skin` and the exhaust flames
`HEAT.exhaust`; fire particles, flares and the tracers are hot, smoke warm, missiles warm; the
water is cold. `tagScene(scene)` runs at boot, on every mode change and whenever the player's
aircraft is rebuilt, so anything built without a tag reads as a cool object rather than as a lit
one. The tracers had to move from `LineBasicMaterial` to `LineBasicNodeMaterial` to be taggable at
all. Fog density drops to 35% under IR — a thermal sensor sees through haze the eye does not.
Not done: aircraft heat that follows the throttle, and a wreck that cools as it burns out.

## Air to ground

A bomb is the only weapon here you cannot aim. You aim the **aircraft**, seconds early, and what
decides whether you hit is a prediction — so the prediction is the feature and everything else in
`flight-combat.js`'s bomb section exists to keep it honest.

|  | Carried | Mass | Cd·S | Damage | Blast |
|---|---|---|---|---|---|
| **BOMB** (`gp`) | 6 | 230 kg | 0.085 | 170 | 40 m |
| **HVY** (`heavy`) | 2 | 900 kg | 0.16 | 420 | 78 m |

Mass over `dragArea` is the ballistic coefficient, and it is the entire difference between the two:
the heavy is the cleaner store, so from the same release it keeps its forward throw and lands
further ahead. Measured from 900 m at 140 m/s level: **gp 1731 m, heavy 1861 m**, against a vacuum
parabola's 1900 m. Drag is worth 169 m — a closed-form solve that ignored it would put both markers
in the same wrong place.

**`bombImpact` and `stepBomb` share one integrator and one fixed substep** (`BOMB_STEP`, 1/120), and
that is the whole reason the pipper can be trusted: predictor and projectile cannot drift apart
because they are running the same arithmetic. Measured agreement between the marker and where the
store actually lands: **0.70 m for the gp over a 15.5 s fall, 1.27 m for the heavy**. The substep is
also what makes the delivery frame-rate independent — a 15 fps client bombs the same place as a
60 fps one, to 0.00 m.

Terrain is sampled every eighth step rather than every step, because `heightAt` is sixteen plane
waves and a ridge term while the integration is three vector adds — the ground lookup is the entire
cost. The crossing is then bisected inside that span, which is what stops the marker stepping in
visible jumps as the aircraft moves.

Two consequences of the physics being real rather than arcade, both of which catch people out:

- **A dive release falls SHORT of a level one at the same speed** — 974 m against 1731 m. The store
  is already going down, so it arrives sooner and travels less.
- **A bomb has no idea whose side anybody is on**, and neither does the blast. Fly through your own
  on a low pass and it hurts you. That is the only thing keeping a delivery honest, since nothing
  else stops you releasing at fifty metres.

The marker draws as a **ground mark** — a ring at the store's real blast radius, flattened toward the
horizon, with a dashed line back to the boresight — rather than a reticle floating on the glass,
because what the player has to judge is a spot on the terrain. Like the gun funnel it only draws for
the selected weapon.

**Bombs are the first weapon here that carries its own `def` on the instance.** Every missile in
flight reads one module constant, so all missiles are the same missile; `b.def` is what lets a heavy
and a general-purpose store be falling at once with different ballistics. Inventory follows the
`{kind: count}` shape that `f.drones` already used, rather than the bare integers `f.ammo`,
`f.missiles` and `f.flares` still are.

The AI does not bomb. Same rule as the mini drones: ground attack is the player's.

## Autopilot: an orbit any airframe can hold

`flight-autopilot.js`. `driveAi` was split so its steering is a function of its own —
`steerToward(f, wp, speed, state)` in `flight-ai.js` — and the autopilot is that same law given a
ring instead of a waypoint list. It writes `f.input` exactly as the keyboard does, so engaging is
"stop reading keys" and disengaging is "start again"; the model never learns who is flying. Because
`steerToward` already branches on `af.control`, the plane, the A-10, the drone and the bird all hold
an orbit through the one function, and the test flies every registered airframe for two minutes.

`makeAutopilot(f, {x, z, radius, alt, turn, speed})` sets `f.autopilot`; `engageOrbitHere(f, …)`
places the centre one radius off the port (or starboard) wing so the aircraft is already on the ring
and tangent to it — no swing out, no swing in. `orbitGoal` chases a point AHEAD on the ring by a
lead that is a distance, not an angle (600 m is a gentle curve on a 12 km ring and most of the way
round a 400 m one). Pure pursuit of that point cuts the chord and settles on a smaller circle — a
23% shortfall on the 400 m ring — so the goal is pushed outward by twice the shortfall, which puts
the equilibrium back on the ring; every class now holds inside 10%. `orbitError` reports radius,
altitude and where the inside wing points, for the test and the HUD line.

The gunship claim is geometric and is asserted rather than trusted: on a held left orbit the port
wing points at the centre within a degree or two for every class, and a right orbit puts the
starboard wing there. `orbitSign` says which way round the ring angle runs for each turn; that sign
was measured by flying it, not reasoned out.

In the viewer: **O** engages around a point off the left wing at the airframe's own circuit radius,
**[ ]** change the radius in flight, any stick input takes the aircraft back (triggers and selectors
keep working underneath — hands off the stick, hands on the guns), the HUD shows the orbit line and
marks the centre, and a kill clears it. Not built: an orbit around a chosen point on the ground —
that arrives with the gunner camera, which is what picks the point.

## Mini drones

Three releasable airframes (`flight-drones.js`), each answering something the aircraft cannot:

| | Carried | What it does |
|---|---|---|
| **Decoy** | 4 | Sprints away at 470 m/s dispensing 12 flares. It does not fight missiles, it feeds them. |
| **Kamikaze** | 4 | Unpowered glider that attacks ground sites and gains speed the whole way down. |
| **Interceptor** | 3 | Holds station off your wing until something is tracking you, then kills it. |

The decoy needs no missile-side support at all: the flares it drops go into the same pool the seeker
already searches, so nothing in the missile code knows a decoy exists.

It is a rocket with flares bolted to it, and it has to be. A decoy that cannot outrun the aircraft
never gets anywhere the seeker would rather go — it just flies alongside you laying flares on your
own track. It boosts from release to 470 m/s in 0.85 s, against a 105 m/s aircraft, and leaves at 26°
off your heading so the divergence is real: 2.7 km of travel in six seconds where you covered 630 m.

`flareGap` is a consequence of that speed, not a taste setting. Spacing is speed times interval, so
0.6 s at 470 m/s puts a flare every 282 m against a 520 m seeker range — no hole a missile can fly
through. Raise the speed without lowering the gap and the trail becomes a dotted line.

The kamikaze has no engine, so all the energy it will ever have is the height and speed you release
it at, and `impactDamage` scales with what it arrives carrying — half at release speed, full at
terminal. A 3 km glide takes 13 s, arrives at 395 m/s, and does 76 damage, which kills a 70 hp SAM
and cannot kill a 150 hp HQ. Releasing early and high is the whole skill. It prefers armed sites over
soft ones, on the grounds that a SAM is shooting at you and a fuel depot is not.

**Two bugs the interceptor found, both in shared code.** Neither was visible on screen:

- **`steerToward` under-turned.** Lerp-and-normalise is not a rotation: on a 90° correction it
  delivered 0.068 rad against 0.1 commanded, so every turn-rate number in the tables was a third
  larger than what the drone actually flew. It is a real axis-angle rotation now. Worse, the
  antiparallel fallback axis was itself degenerate, so a 180° reversal — exactly what an interceptor
  sent after something astern has to do — silently did nothing at all.
- **Pro-nav is blind dead astern.** A target directly behind produces no line-of-sight rotation, so
  it commands nothing; the interceptor flew away from the thing it was launched at and got overtaken
  at 8 s instead of intercepting at 3. It now points at the intercept first and hands over to pro-nav
  once the bearing is close. Computing that point needed `interceptPoint`, a proper quadratic solve:
  `leadPoint`'s iteration converges on *a* root, and for a chaser slower than its quarry that is the
  8.19 s stern chase rather than the 2.85 s head-on. Same equation, wrong root. `leadPoint` is still
  right for guns, where the shell outruns everything and there is only one root.

Only the player carries drones. Giving bandits interceptors would mean nothing you launch ever
arrives, which is a worse game than the one where missiles are hard to dodge.

## Opponents

A roster, not a fixed lineup. The axis that matters is **`armed`**, not the airframe: an unarmed
opponent is a flying target you can practise on, an armed one is a fight you have to survive. Unarmed
craft never fire, never lock, and — the rule that makes training work — are never chosen as a target
by any other AI, so your allies cannot steal your practice.

Presets: `solo`, `training` (nothing armed, ground sites off), `mixed`, `combat`.

Circuits are centred on the player, which is right for planes on a 2.6 km ring. Anything tighter than
600 m is centred on its own spawn point instead — eight target drones sharing one 90 m ring would fly
through each other.

## Resupply, aim assist, and the panel that was covering the HUD

**Resupply pods.** You start with four missiles and no way to get more, which turned every fight
after the first into a gun fight whether you wanted one or not. Seven pods float at altitude around
you; fly within 55 m and you rearm. Missiles are weighted heaviest in the draw because they are the
shortage, but gun ammo and flares run out too and share the mechanism. Pods are **yours** — the AI
ignores them, the same rule practice targets follow. They respawn 22 s after collection.

Shot-down aircraft also **drop a canister where they died**, which sinks at 7 m/s and expires after
34 s — long enough to be worth turning back for, short enough that you cannot bank them. Fixed pods
and dropped ones share one array and one pickup path, flagged by `fixed`; only the fixed ones
respawn. Only *armed* aircraft drop anything. A target drone is not carrying missiles, and letting
the practice range be farmed for ammunition would make the whole scarcity pointless.

**Gun aim assist**, on a slider, default 0.35. It TRIGGERS on how close your nose is to the target —
what a player actually points at — and CORRECTS toward the lead solution, which is where the round
has to go. Those are two different directions, and for a fast crosser they are 8.6° apart. An
earlier version triggered on the lead point instead, which meant aiming straight at a crossing enemy
put you outside the cone and got you no help at all; the test caught it because the correction went
the wrong way at every angle.

The bend falls off with how far off the target you are — full on boresight, nothing by 6°, squared
so the middle is already weak — and closes a fraction of the lead gap rather than all of it.
Measured at the default with the nose on the enemy: a 700 m tail chase goes from 0.74° of error to
0.48°, a 140 m/s crosser from 8.57° to 5.57°. So a tail chase is nearly solved and a fast crosser
still has to be led by eye, which is the right way round.

**The panel was sitting on top of the HUD.** The radar, weapon state and altitude tape are anchored
to the right edge of the screen, and so is a 318 px tuning panel, so on any window narrower than
about 1500 px they were simply invisible. Two fixes, because they solve different halves: the panel
hides (`H`, or the tab in the corner), and while it is open the right-anchored furniture is pushed
inboard by its width so nothing is hidden even with it up. The pitch ladder is deliberately **not**
inset — it hangs off the projected boresight, and moving it would decouple it from where the nose
actually points, which is the one thing it is for.

## Weather (2026-08-16)

The panel's **Weather → rain** slider (0..1) is one number that the page fans out; nothing else in
the sim reads it, so the flight model is unaware of the weather (no wind on the airframe yet).

- **Rain** is `rain.js`'s `createRainSystem` (documented under `fx.md` §Rain) with the terrain
  standing in for the occluder map: `groundHeight: (xz) => tslHeight(xz, tslSpacing(xz))`, so
  drops cut at the analytic ground and splash rings sit on it with no bake. 60k drops in an
  80×50×80 m box, density = 0.9 × slider; splash rings draw only when the camera is under 160 m AGL.
  `rain.update(dt, camera)` runs right after `updateCamera`, so streaks lean against the aircraft's
  own velocity — at 150 m/s they stretch to the 3× clamp (~3.3 m), which is the motion blur of one
  60 Hz frame. Under IR the drops are `heatMix(…, HEAT.water)` (cold) and the bolt `HEAT.fire`;
  their materials are marked `irTagged` before `tagScene` runs because they own their colour graph
  and `heatTag` would replace it.
- **Overcast** is `uOvercast` (= min(1, 1.25 × rain)): the sky graph mixes toward a horizon-bright
  grey and the sun disc goes with it, the cloud deck darkens and its cover rises
  (`uCloudCover = 0.46 − 0.30 × rain`), sun ×(1 − 0.72 rain), hemisphere ×(1 − 0.35 rain).
- **Haze** has one owner, `applyFog()`: `FOG_DENSITY × (IR ? 0.35 : 1) × (1 + 9 rain)`, colour
  toward a grey; the vision toggle calls it too, so switching to thermal in a storm no longer resets
  the storm's fog.
- **Terrain sheen**: the ring material's `roughnessNode = mix(0.95, 0.45, uWetness)`, wetness =
  min(1, 1.4 × rain). No puddles or ripples at this scale.
- **Storm** (rain > 0.3 and the checkbox): every 4–18 s a `createLightningBolt` strike from the
  cloud base (`CLOUD_Y − 60`) to `heightAt` 0.8–4 km off; `rain.flash` brightens the drops and the
  sun by +4 for a beat; `playThunder` fires `distance / 340` s later through the listener with a
  crack that dies past 1.5 km and a roll that lengthens with distance. The rain bed
  (`createRainBed`) rides the listener too, louder low and slow and fading out above 900 m AGL.

## Rendering notes that belong to the viewer

- **Reversed depth buffer.** `reversedDepthBuffer: true` on the renderer, which in r0.184 both
  reverses the mapping and switches the default attachment from `depth24plus` to `depth32float`.
  Without it the water plane at y=0 and the terrain straddling it stop being separable past 700 m.
  Precision at 10 km goes from 11.9 m to 0.4 mm. The stats panel reports the mode actually in use,
  because the WebGL2 fallback needs `EXT_clip_control` and drops back with a warning.
- **`projectPoint` decides "behind the camera" in view space, not from NDC z.** A point behind the
  camera has a negative clip w, so the perspective divide mirrors its x and y — an enemy on your six
  projects to a believable spot in front of you, and its range readout climbs as you fly at it. NDC z
  cannot answer the question portably: measured on this camera, a behind-camera point reads 1.0009
  under the standard 0..1 range and −0.0004 under the reversed one, and a point past the far plane
  reads negative while being perfectly in front. So the test is `dot(point − eye, camera forward)`,
  with both taken from `matrixWorld` so they cannot disagree with `project()` about which frame this
  is. Every consumer either skips a behind point or, for the off-screen target arrows, rotates the
  bearing 180° to undo the mirror. The pitch ladder skips too, which matters in orbit view where the
  camera can get ahead of the nose.
- **`positionNode` overwrites `positionLocal`.** Setting `material.positionNode` makes three assign
  that value *into* `positionLocal` during vertex setup, so every later read gets the displaced world
  position. Read the raw `attribute('position', 'vec3')` instead. This masqueraded as aliasing for
  three rounds of screenshots.
- **Volumetric explosions** clamp their march against an analytic ground plane rather than reading
  `viewportDepthTexture`, whose multisampled case the source demo flags as untested. The cost is
  `depthTest: false`, so a fireball behind a ridge draws over it.
- **Blast debris** (2026-08-17) is the other half of an explosion: `blast-debris-sim.js` +
  `blast-debris.js`, the html-game-v2 port, driven from the same `explosion()`. Every `'craft'` blast
  throws fragments that bounce and flicker out and wreckage that tumbles, smoulders and trails dust
  for about twenty seconds; `'hit'` pops throw none. Six instanced draws and two point lights. Two
  things had to be added to the shared sim for a world this size — debris that carries the dead
  aircraft's momentum, and settled pieces that stop asking the terrain field where the ground is —
  and both are written up in `docs/subsystems/fx.md`, along with the three rules that stand between
  a call site and the sim (an inherited-speed cap standing in for the missing drag, a ground rule
  that drops the downward half near the surface, and a `wreckage` flag that stops a shell burst
  shedding airframe chunks). The debris materials are heat-tagged through the renderer's
  `tagMaterial` hook, before `tagScene` can sweep them at the default, which is also what keeps the
  dust's own colour graph alive under IR.

## Known bug: AA rounds inherit whatever was last in their bullet slot

`updateGround`'s AA branch takes a slot out of the shared `bullets` pool and sets `live`, `owner`,
`team`, `life`, `p` and `v` — but not `damage` or `blast`, which only `spawnRound` writes. So an AA
round carries whatever the previous occupant of that slot had. On a fresh slot that is 0 damage and
no blast, so AA does nothing at all; on a slot last used by the 105 mm it is 300 damage in a 34 m
radius, from a gun specced at 5 damage. Note that `GROUND.aa.blast: 14` is NOT the fix to reach for —
it is the site's own death-explosion scale, the same field `radar`, `hq`, `depot` and `hangar` carry,
none of which has a gun. Assigning it to the bullet would give AA rounds an HE burst nobody
specified. Predates the debris work, which only made it louder: a polluted slot now also throws a
full blast's worth of debris at 9 rounds per second, and each one reserves a tier slot, so sustained
AA fire can push a real kill in the same 320 ms window down to `lite` — which throws nothing at all.
Fixing it changes what AA does to you, so it is a balance decision rather than a typo.

## Not built yet

Base Game now flies the `drone` airframe and a registered `uav` airframe as player gadgets through
`base-game-drones.js` (see `base-game.md`, "Drones"); that is the first consumer of `flight-model.js`
outside this demo, and `setHeightSource` is how it sees Base Game ground.

Flare audio is synthesised into buffers at startup rather than played as oscillators, so it can go
through the positional voice pool — a bandit defending itself two kilometres away has to sound two
kilometres away. Burning flares are one shared hiss keyed to how many are alight nearby rather than
one source per flare, because a full salvo is 24 cartridges.

Nothing you carry is **visible on the aircraft** before it fires — no gun, no missile on a rail, no
bomb under a wing. There are no hardpoints at all: ordnance spawns at a literal offset written next
to the fire call. That is the gap an aircraft studio has to close, since a studio that can author a
weapon and not show it hanging there is only doing half the job.

The AI ignores terrain for cover and will fly through a hill to reach a waypoint, and ground sites
have no line-of-sight test at all, so a SAM will shoot you through a mountain. No takeoff or landing,
no gun heat, no seeker gimbal limits, and damage is a single hit-point number that degrades nothing.
Carrying stores costs neither mass nor drag, so a full rack handles exactly like an empty one.

Two things the earlier version of this section got wrong, recorded so they are not re-derived. It
claimed there was no air-to-ground ordnance; there is now, above. And it pointed at
`html-game-v2`'s `updateAirSupportCraft` as the obvious source for one — **that file is not in this
repository**, and the bombing here was built against `bot-drones.js`'s release solve instead, at
flight scale rather than its 50 m arena scale.

The viewer layer is mostly still one file. `flight-hud.js` was the first piece to come out of it, on
2026-09-02, because the Base Game needed the same display over its drones — and once it was a module
taking plain arrays, a headless test found a mirrored pitch ladder that had been in the sim all
along (see below). `flight-craft.js`, `flight-camera.js`, `flight-controls.js` and
`entity-types/aircraft.js` from `docs/flight-harness-plan.md` still do not exist; they are
Three/DOM-bound and have no tests to save, so extracting them buys less than the model did.
`entity-types/aircraft.js` is what integration into `environment-viewer-v2.html` actually needs.

## Water: the flat plane and the hybrid surface

The demo carries two water surfaces and a checkbox ("hybrid water") swaps which one is visible.

- **Flat plane (default).** One 40 km quad at y=0, `MeshStandardNodeMaterial`, camera-following.
  What makes the sub-zero ground read as lakes. Cheap, and the reason `reversedDepthBuffer` is on:
  the plane and the ground sit within centimetres of each other over most of the map.
- **Hybrid surface (`water-hybrid.js`).** A displaced Gerstner spectrum with deep-water dispersion,
  Beer-Lambert depth colour over a sand bed, a GGX sun glint whose roughness grows with distance,
  and foam on breaking crests and along the shore. Built by `createOceanSurface()`; the profile is
  the shared `hybrid` preset with a shorter spectrum (14 waves) and a longer, taller swell, because
  this ocean is seen from altitude and speed.

Three things about the hybrid surface are specific to this demo:

- **Geometry is a radial grid**, re-centred on the aircraft and snapped to 2 m: 160 rings by 224
  spokes, radius growing geometrically from 2 m to 26 km. That is 36k vertices and 71k triangles,
  with cells of about 1.4 m under the aircraft, 11 m at 200 m out and 460 m at the terrain edge.
- **Depth comes from `tslHeight`**, the terrain's own GPU twin, evaluated in the vertex stage. So
  shore foam follows the real coast, and the surface fades to fully transparent over dry land —
  which is why it does not write depth: an invisible fragment must not hide the terrain behind it.
  Past the outermost clipmap ring (8192 m) the depth fades to a fixed 80 m, because out there the
  height field would otherwise punch dry holes into the ocean with no land drawn in them.
- **Distance fades.** Displacement fades out between 1200 m and 4500 m and the normal flattens
  between 2500 m and 9000 m, since cells that big cannot carry the short waves and the surface
  would shimmer instead.

`heatTag()` is not used on it: that helper replaces `colorNode` with the material's flat colour,
which would throw the whole graph away. The thermal blend is folded into the graph with `heatMix()`
instead, the same way the sky and the terrain do it.

### Where the water numbers come from

None of the wave, colour or foam numbers live in this page. They live in `water-config.json` at the
repo root, written by `demos/water-demo.html` and read here — the demo is the tuning tool, the sim
is the consumer.

- The sim fetches the file on load and applies its `ocean` entry to the live profile.
- The **refresh** button beside the hybrid-water checkbox re-fetches it. Uniforms and the wave table
  are swapped in place, so the surface changes on the next frame with nothing rebuilt and no reload.
  The output next to the button shows the file's `savedAt`, or why it could not be read.
- The `hybrid` preset applied in code is only the fallback for a missing or unreadable file.
- The profile is named `ocean` because that is the entry it reads. The demo also writes a `lake`
  entry, which this page ignores.

The loop is: tune in the demo, press "Save to water-config.json", press refresh here. Saving needs
`serve.py` (it POSTs to `/api/save-water-config`, which overwrites the file in place, the same
arrangement as `damage-tuning.json`); if some other server is in front of the pages, the demo falls
back to downloading the file so it can be dropped in by hand.

## flight-hud.js

The green head-up display, lifted out of `demos/flight-sim.html` so the Base Game can draw the same
one. `drawFlightHud(ctx, w, h, state)` is the picture for something you are flying: pitch ladder,
flight path marker, speed and height tapes, heading tape, throttle bar, blinking warnings.
`drawSensorHud(ctx, w, h, state)` is the picture for a sensor or a seeker pointed at the ground:
crosshair, a dashed ring the size of the warhead's blast at that range, range and time of flight.

It takes plain arrays and one `project(x, y, z)` callback, so it has no THREE in it and no camera of
its own, and it runs headless against a recording 2D context in `test-flight-hud.mjs`. That test is
how the pitch ladder's mirrored sign was found: `off = (pitch - deg) * pxPerRad` puts the line for
`deg` on the wrong side of the boresight, which looks correct in level flight and puts the horizon
above the nose in a climb. Both this module and the sim were corrected on 2026-09-02.

The Sentinel's missile mesh is `buildAgm` in `flight-meshes.js`, registered as the craft kind `agm`:
1.6 m at its real size, four tail fins, four canards, a dark seeker window, nose down -Z like every
other craft here so the same "point it along the velocity" code aims it.
