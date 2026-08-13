# Flight harness plan (`flight-viewer.html`)

STATUS: **partly built, 2026-08-10.** Phases 0-6 are prototyped in `demos/flight-sim.html`, and the
model half has since been extracted into the workspace proper:

| Planned file | Status |
|---|---|
| `flight-model.js` | **shipped** — rigid-body core plus the wreck integrator |
| `flight-airframes.js` | **shipped** |
| `flight-ai.js` | **shipped** — also carries the opponent roster |
| `flight-terrain.js` | **shipped** (not in the original file list; the height field earned its own leaf) |
| `flight-combat.js` | **shipped** (not in the original file list; Phase 6 needed one) |
| `test-flight-model.mjs`, `test-flight-ai.mjs` | **shipped**, plus `test-flight-terrain.mjs` and `test-flight-combat.mjs` |
| `docs/subsystems/flight.md` | **shipped**, registered in CLAUDE.md and code-map.html |
| `flight-hud.js`, `flight-craft.js`, `flight-camera.js`, `flight-controls.js` | not built — still inline in the demo |
| `entity-types/aircraft.js` | not built — this is what Phase 7 actually needs |
| `flight-viewer.html` | **not built, and deliberately so.** A second harness would drift immediately from the one that has actually been flown. `demos/flight-sim.html` imports the modules instead. |

Two decisions differ from the plan below and are worth reading before continuing:

- **`flight-model.js` imports three** rather than carrying its own vector maths. The plan wanted it
  Three-free so it would run under Node; Node resolves the bare `three` specifier from
  `node_modules` and several existing repo tests already do this, so the goal was already met and a
  hand-rolled vector library would only have been a second thing to get wrong.
- **The units pass in Phase 1 never happened, because it was not needed.** The numbers were authored
  fresh against our terrain scale rather than ported from `html-game-v2`, so there was nothing to
  re-derive. Risk 1 below is closed.

Read `docs/subsystems/flight.md` for what the modules do and `demos/README.md` for the bugs each
round caught. The rest of this document is the original plan, kept for the reasoning.

Goal: a standalone flight harness in `workshop-webgpu` covering three craft classes — **drones,
birdlikes, and planes** — flown by both the player and AI, built on the flight physics already
written in `G:\My Drive\Scripts\html game\html-game-v2` and running on this repo's terrain, sky,
FX, and audio. It is intended to land in **`environment-viewer-v2.html`** and **`bot-viewer-v3.html`**,
so the architecture is chosen for that from the start rather than retrofitted.

Direction: **sim-based, arcade-leaning.** Real energy management — speed and altitude trade
against each other, turns cost energy, a stall is a state you fly out of rather than a speed cap.
No charge boost. Forgiving recovery, no engine-out or systems modelling.

The GitHub project [`dimartarmizi/web-flight-simulator`](https://github.com/dimartarmizi/web-flight-simulator)
is a **reference for control scheme and HUD layout only** — it is CesiumJS-based, which conflicts
with our CDLOD terrain, and it is non-commercially licensed, so no code is copied from it.

## Source inventory

### From `html-game-v2` (our own code, portable)

| What | Where | Notes |
|---|---|---|
| Player flight physics | `src/game/main.js:1345-1600` | AoA, lift, four-term drag, dual stall model, turn-rate limiting |
| Flight tuning constants | `src/game/config.js:99-132` | `playerFlightDefaultSettings` — 30 tuned numbers |
| AI aircraft flight | `src/game/main.js:20105` (`updateAirSupportCraft`) | Bank/roll/pitch response, throttle accel, orbit and figure-eight paths, descend/ascend transitions |
| AI craft tuning | `src/game/config.js:325-375` | `airSupportDefs.gunship` |
| Procedural craft mesh | `src/game/main.js:19738` (`createDefaultAirSupportCraftVisual`) | Box and cylinder kitbash with engine glow |
| Flying enemy handling | `main.js:12148, 18802, 15477` | Target altitude, in-air knockback — precedent for fliers as combat targets |

The player physics is the valuable part. Its real dependencies are small — Three.js vectors, a
gravity constant, the player object, camera forward and right, and three input predicates — so it
extracts cleanly. The charge-boost block is dropped as arcade cruft that fights energy management.

### From this repo (reuse as-is)

| Need | Module | API |
|---|---|---|
| Ground height and collision | `terrain-field.js` | `terrainHeightAt(params, x, z)`, `terrainNormalAt(params, x, z, out)` — analytic, works at any position without chunk streaming |
| Terrain rendering | `cdlod-terrain.js` | `createCdlodTerrain({ renderer, camera, cfg, terrainParams })` — GPU-culled around a moving camera, has `setViewDistance` |
| Sky and atmosphere | `sky.js`, `clouds.js`, `stars.js`, `celestial-bodies.js` | `createSky({ scene, camera, size, sunDir, palette, parts })`, `Clouds` |
| Entity plumbing and multiplayer | `entity-registry.js`, `entity-types/*.js` | Contract is `{ type, create(input), update(entity, dt, ctx), serialize(entity) }` over `transform {p,q,s}` / `state` / `sim` |
| Projectiles | `entity-types/combat-projectile.js`, `weapons.js` | Cannon rounds and missiles |
| Trails and impacts | `particle-field.js`, `particles.js`, `effect-renderer.js` | Contrails, engine smoke, hit FX |
| Post-processing | `post-fx.js` | Bloom for afterburner and rotor glint |
| Audio | `synth-utils.js`, `ballistic-audio.js`, `environment-audio.js` | Procedural engine, rotor, and wing tones; gunfire |
| Bird rigging | `port-creature-system.js`, `creature-plan.js`, `player-procedural-body.js` | Wing articulation for birdlikes rather than a new skeletal system |
| Perf HUD | `frame-profiler.js` | Same `?prof=1` convention as the bot viewers |

## Architecture: one core, three airframes

The three classes are genuinely different physics, not one model with different numbers, so the
core is a rigid body — forces and torques integrated onto a quaternion — and each **airframe**
supplies force generators, control mapping, and limits.

| | **Plane** | **Drone** | **Birdlike** |
|---|---|---|---|
| Thrust | Along the nose, throttle-set | Along body up, vectored by tilting | Impulsive, on the wingbeat |
| Lift | Wing at AoA, `v²·Cl·α` | None — thrust carries the weight | Wing at AoA, low wing loading |
| To move forward | Point the nose, add power | Tilt, so thrust gains a horizontal component | Flap, then glide |
| Hover | Impossible | Native | Briefly, at high cost |
| Control | Rate command; authority scales with dynamic pressure | Attitude command, self-levelling; authority constant, props work at any airspeed | Rate command plus flap impulse; wing sweep morphs area for dives |
| Stall | Central to flying it | Not applicable | Recoverable, used deliberately to land |

Everything else — drag, gravity, ground contact, terrain collision, damage — is shared. The
airspeed-dependent control authority on the plane and bird is what makes a stall feel like a
stall rather than a speed cap; the drone deliberately has none of that.

## What has to be written new

The old model is **camera-directed glide** — you look somewhere and the character flies there. A
flight sim is **stick-flown** — you command rotation rates and the craft goes where its nose and
momentum take it. That difference is the main body of new work:

1. Orientation state as a quaternion, with torque integration, instead of a bare forward vector.
2. Pitch, roll, and yaw rate commands with per-airframe authority curves.
3. A throttle axis, replacing the old cruise/boost/min-speed tiers.
4. Sideslip drag, so yaw is not a free turn.
5. The drone and bird airframes, which have no ancestor in either source repo.
6. A flight HUD, chase and cockpit cameras, missile lock, and flares.

## New files

| File | Contents |
|---|---|
| `flight-model.js` | Rigid-body core. Pure physics, no Three.js import (own small vector and quaternion helpers) so it runs under Node. State in, state out. |
| `flight-airframes.js` | The three airframe descriptors and their tuning tables. |
| `flight-controls.js` | Keyboard, mouse, and gamepad to control axes; per-class assist modes. |
| `flight-camera.js` | Chase with lag, cockpit or first-person, external orbit; FOV kick under thrust. |
| `flight-craft.js` | Procedural meshes per class, control-surface and rotor and wing articulation, afterburner glow. |
| `flight-hud.js` | Pitch ladder, heading tape, airspeed, altitude MSL and AGL, throttle, AoA, stall and ground-proximity warnings, G meter. |
| `flight-ai.js` | Per-archetype steering driving the same `flight-model.js` the player uses. |
| `entity-types/aircraft.js` | Registry entity type, for `environment-viewer-v2.html` and multiplayer replication. |
| `flight-viewer.html` | The harness: WebGPU renderer, terrain, sky, tuning panel with localStorage slots. |
| `test-flight-model.mjs`, `test-flight-ai.mjs` | Node tests, no framework, per repo convention. |
| `docs/subsystems/flight.md` | Subsystem doc; add a row to `CLAUDE.md` and to `code-map.html`'s `DOC_LIST`/`GROUP_DOCS`. |

Keeping `flight-model.js` free of Three.js follows the repo's CPU-twin pattern (`forest-cull.js`,
`light-cluster.js`, `post-grade.js`) — except here the pure version is the production one, not a
hand-synced mirror, so it cannot drift. It also means the AI, the player, and the replicated
multiplayer entity all run one implementation.

## Phases

Each phase ends in something visible in the browser.

### Phase 0 — Harness skeleton
WebGPU renderer, CDLOD terrain, sky, clouds, free-fly camera, frame profiler, tuning panel shell
with save and load slots. Confirms terrain and sky hold up at altitude and at speed before any
physics exists.

### Phase 1 — Rigid-body core and the plane
The core plus the plane airframe, since it is the one with a direct ancestor. Includes the
**units pass**: the old game's numbers (cruise 34, stall 30, cap 152) are in its world scale, not
ours, so every speed, rate, and coefficient is re-derived against our terrain scale. Ground
collision from `terrainHeightAt`. Debug-box craft, chase camera, Node tests for trim glide, stall
onset and recovery, equilibrium speed under constant throttle, turn-rate versus energy loss, and
crash detection.

### Phase 2 — HUD
Pitch ladder, heading tape, airspeed and altitude tapes, radar altimeter (AGL from
`terrainHeightAt`), throttle bar, AoA indexer, stall and ground-proximity warnings, G meter. HUD
elements are per-class: a drone wants a hover and drift readout, not a pitch ladder.

### Phase 3 — Drone and birdlike airframes
Both against the same core. The drone brings vectored thrust, self-levelling, and hover hold; the
bird brings the wingbeat cycle, morphing wing area, and flare-to-land. Node tests per class.

### Phase 4 — Craft visuals and audio
Procedural plane, quadrotor, and a bird rig reusing the procedural creature and body system rather
than a new skeleton. Deflecting control surfaces, spinning rotors, flapping wings driven by the
same phase the physics uses. Procedural audio pitched off throttle, rotor RPM, and wingbeat; wind
noise off dynamic pressure.

### Phase 5 — AI
`flight-ai.js` flies the same model the player does, so opponents obey the same physics. Per
archetype: drones hover, strafe, and hold overwatch; birds circle, stoop, and perch; planes fly
patrol circuits and pursuit curves and cannot hover, so they need turn-radius-aware approaches.
The ported `updateAirSupportCraft` orbit and figure-eight logic is the starting point for the
plane.

### Phase 6 — Weapons and air combat
Cannon on the existing ballistic path, missiles with a lock cone reusing
`entity-types/combat-projectile.js`, flares. Air-to-air between AI fliers, and air-to-ground
against existing bots.

### Phase 7 — Integration
`bot-viewer-v3.html` first, because it is the smaller surface: AI drones and birds as flying
opponents alongside the existing ground bots. That exposes the real gap — our bots are entirely
ground-based, so target selection, aim elevation, and line of sight all assume roughly eye-level
targets and will need altitude handling. Then `environment-viewer-v2.html` via
`entity-types/aircraft.js` on the existing registry, which gives host-authoritative multiplayer
replication on the same path lights and projectiles already use, plus the player-flown input and
camera path.

## Risks

1. **Scale mismatch.** The single most likely thing to make this feel wrong. Handled explicitly as
   a Phase 1 task rather than discovered later.
2. **Terrain at altitude and speed.** CDLOD is tuned for a ground-level camera; view distance,
   level count, and morph may need raising, and popping is far more visible at flight speed than
   at walking pace. Phase 0 exists to find this early.
3. **Sky and cloud sizing.** The cloud layer needs a real world altitude you can climb through,
   not a camera-locked dome. How `clouds.js` behaves from above is unknown until tested.
4. **Bots cannot fight what flies.** Phase 7's real cost, and easy to underestimate — it touches
   targeting, LOS, and aim rather than being a spawn change.
5. **Frame budget.** Long view distances plus post-FX plus particles, in a repo where the bot
   viewer already fights for frame time. Profile from Phase 0, not at the end.
6. **Bird physics has no reference implementation** in either repo, and flapping flight is the
   easiest of the three to make feel wrong.

## Open question

Player control across three classes: one control scheme with per-class assists, or genuinely
different schemes — planes on a stick, drones on a hover-and-tilt scheme closer to a twin-stick,
birds somewhere between? This does not block Phase 0 or 1, but it decides Phase 3.
