# Flight

Fixed-wing, multirotor and flapping flight over an analytic height field, with air combat. Player
and AI fly the same model.

| File | Contents | Imports |
|---|---|---|
| `flight-terrain.js` | Analytic height field, band limit, `agl` | nothing |
| `flight-airframes.js` | The three airframe tables, `RHO`, `G`, slider ranges | nothing |
| `flight-model.js` | Rigid-body core, wreck integrator | three, airframes, terrain, combat |
| `flight-ai.js` | Per-archetype steering, the opponent roster | three, airframes, terrain, combat |
| `flight-combat.js` | Weapon tables, missile flight, gun lead, locking, threat warning | three, airframes |
| `flight-drones.js` | The three releasable mini drones | three, combat |
| `flight-meshes.js` | The three craft as groups; materials come from the caller | three |
| `demos/flight-sim.html` | The viewer: meshes, HUD, audio, FX, panel, clipmap | all of the above |

Tests: `test-flight-model.mjs`, `test-flight-terrain.mjs`, `test-flight-ai.mjs`,
`test-flight-combat.mjs`, `test-flight-drones.mjs`. Plain Node, no framework, per repo convention.

The demo needs a server (`python serve.py`) because of the ES module imports, then
`http://127.0.0.1:8080/demos/flight-sim.html`.

## Why the split is where it is

One exception to that line since 2026-08-10: `flight-meshes.js` holds the three craft *groups* (geometry and proportions), because the bot viewer's drone operators fly the same quad and the same fixed wing and a private copy would drift. Materials still belong to each page — this one runs node materials, the bot viewer does not — so the builders take a `{ standard, basic }` pair and `buildMesh` here is one call into the module. Everything else below still holds.

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
| Offensive | `Space` / mouse 1 | `Left Alt` | gun, missile, kamikaze |
| Defensive | `C` / mouse 2 | `Right Alt` | flare, decoy, interceptor |

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

Restructuring the fire path surfaced a pre-existing defect: `fireGun` decremented `gunCool` itself
*and* the per-flyer loop decremented it again, so a held trigger ran at 44 rounds per second against
a table that says 22, and ammunition drained twice as fast as designed. Only the loop does it now.

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

## Not built yet

Flare audio is synthesised into buffers at startup rather than played as oscillators, so it can go
through the positional voice pool — a bandit defending itself two kilometres away has to sound two
kilometres away. Burning flares are one shared hiss keyed to how many are alight nearby rather than
one source per flare, because a full salvo is 24 cartridges.

No air-to-ground ordnance, so the only way to hit a structure is guns or a missile pointed downward —
the bombing layer in `html-game-v2`'s `updateAirSupportCraft` (`airSupportBombs`,
`AirSupportPointToGround`, `airSupportPatternAltitude`) is the obvious source. The AI ignores terrain
for cover and will fly through a hill to reach a waypoint, and ground sites have no line-of-sight
test at all, so a SAM will shoot you through a mountain. No takeoff or landing, no gun heat, no
seeker gimbal limits, and damage is a single hit-point number that degrades nothing.

The viewer layer is still one file. `flight-hud.js`, `flight-craft.js`, `flight-camera.js`,
`flight-controls.js` and `entity-types/aircraft.js` from `docs/flight-harness-plan.md` do not exist;
they are Three/DOM-bound and have no tests to save, so extracting them buys much less than the model
did. `entity-types/aircraft.js` is what integration into `environment-viewer-v2.html` actually needs.
