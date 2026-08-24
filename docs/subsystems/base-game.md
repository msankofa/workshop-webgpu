# Base Game v0

## Purpose

`base-game.html` is the clean starting point for a game assembled from the workshop's existing
systems. Version 0 contains the runtime shell, authoritative light/time state, the shared sky, the
permanent geometric Traversal Lab, a fixed-step diagnostic player and standard first/third-person
camera, component isolation controls, state persistence, error reporting, start/pause menus,
server-authoritative player replication with owning-client prediction and interpolated remote
capsules, and frame statistics. It deliberately contains no terrain,
water, clouds, flora, creatures, player art, combat, fog, weather, post-processing, or game-specific
play systems.

This is "Day 1 plus the minimum Day 2 sky": light/day/night own the state; the sky consumes it.

## Reused owners

| Responsibility | Existing owner |
|---|---|
| Directional sun and ambient light | `lights.js` / `createLightingRig()` |
| Dome, discs, stars, Milky Way, bodies | `sky.js` / `createSky()` |
| Sun and moon geometry | `solar-position.js` |
| Day/dusk/night color interpolation | `sky-field.js` |
| Dropped-frame accounting | `frame-profiler.js` |
| Six named local save slots | `bot-viewer-slots.js` |
| Panel appearance and section state | `workshop-panel-theme.js` |
| FPS/worst/draw/triangle HUD pattern | `demos/pokemon-park-old-fail.html` |
| Shared-world schema and validation | `base-game-protocol.mjs` |
| Lightweight WebSocket client lifecycle and bounded input sending | `base-game-session.mjs` |
| Renderer-free Traversal Lab collider shared with the server | `traversal-lab-collider.js` |
| Owning-client prediction and reconciliation | `base-game-prediction.js` |
| Pooled, buffered remote-player capsules | `base-game-remote-players.js` |
| Start and pause menu UI | `base-game-menu.mjs` |
| Server-owned room state and 120 Hz lockstep player simulation | `server/base-game-rooms.js` |
| Static triangle BVH collision | `map-collision.js` / `three-mesh-bvh` |
| Global/render-local coordinates | `world-coordinates.js` |
| Provider-based 3D queries | `world-query.js` |
| Traversal Lab layout and rendering | `traversal-lab-layout.js` / `base-game-traversal-lab.js` |
| Fixed-step diagnostic player | `base-game-player-controller.js` |
| Player presentation and camera | `base-game-player-view.js` / `bot-camera-control.js` damping |
| Procedural humanoid rig, gait, IK | `player-procedural-body.js` / `body-part-batches.js` |
| Body support through world query | `base-game-body-support.js` |
| Body presentation owner | `base-game-player-bodies.js` |
| Web Audio graph, positional SFX, http music playlist | `environment-audio.js` (see `audio.md`) |
| Sound director: what fires when, budgets, cull, sample-or-synth | `base-game-audio.js` |
| Hitscan, shot validation, lag-compensation pose history | `combat.js` |
| Player hp / alive / revive | `player-combat.js` |
| Magazines (lifted from `environment-viewer.html`) | `player-ammo.js` |
| Dispersion cone | `bot-aim.js` |
| Projectile flight and blast falloff | `bot-projectiles.js` / `entity-types/explosion.js` |
| Tracers, muzzle flash, sparks, explosions | `effect-renderer.js` / `tracer-visual.js` |
| Blast debris | `blast-debris-sim.js` / `blast-debris.js` / `explosion-tier.js` |
| Dynamic flash lights | `flash-lights.js` (extracted from `bot-viewer-visuals.js`) |
| Procedural weapon handling voices (reload, draw) | `weapon-sfx-synth.js` |

`base-game.html` is integration wiring. It does not duplicate any renderer subsystem, sky shader,
or server room logic.

## Initialization order

1. Install visible error and rejected-promise reporting.
2. Show Solo/Create Room/Join Room and, for online play, wait for the server's initial snapshot.
3. Construct and initialize `WebGPURenderer`.
4. Create the scene, perspective camera, and stock `OrbitControls`.
5. Create the shared sun/ambient rig and dedicated moon directional light.
6. Create the shared sky and add its group to the scene.
7. Create the coordinate/query services, build the Traversal Lab, and register its static BVH
   provider.
8. Construct the renderer-independent player controller, its diagnostic presentation/camera, the
   prediction wrapper, and the remote-player manager.
9. Build controls, assert complete state coverage, and apply online ownership permissions.
10. Apply the initial authoritative or local state.
11. Start `renderer.setAnimationLoop()`.

## Frame order

1. Reject a reentrant frame with `frameProfiler.markDropped()`.
2. In Player mode, sample input, hand it to the session (online) and run bounded 120 Hz fixed
   simulation steps through the prediction wrapper (online) or the controller directly (Solo), then
   interpolate the global player position; when paused or in Orbit debug mode, send neutral input
   online and update stock OrbitControls instead.
3. Rebase render-local presentation when the global player exceeds the coordinate-space threshold.
4. Place the diagnostic capsule and independently damped player camera, then place remote
   capsules from their server-time buffers.
5. Move the infinitely distant sky group to the camera.
6. Advance time when the clock is playing.
7. Compute sun and moon positions, then drive lights and sky from those same directions.
8. Apply component visibility masks and render.
9. Snapshot renderer draw/triangle counters immediately.
10. Flush age-gated sky disposals after submission and release the frame guard in `finally`.

Only one directional light owns shadows per frame: sunlight by day, moonlight when its effective
intensity exceeds the sun. This avoids two world-scale directional shadow passes.

`updateWorld()` runs every frame and re-applies every setting, so its callees must be cheap when
nothing changed: the sun colour is re-blended only when the twilight factor moves, the player
controller is reconfigured only when one of its seven settings moved (`configure()` validates and
copies), and the lighting rig's setters return early on an unchanged value. Player position reads
in the loop go through a scratch array. The world-query and world-coordinate contracts still
copy and validate every input per call by design; their per-step cost is shared with the server.

## Live component controls

All controls work without reloading the page.

- World: Empty Space or Traversal Lab, collision wireframe, and origin marker.
- Player: Player or Orbit debug control, first/third person, player body (off, third-person rig,
  lower-body rig), diagnostic capsule, movement, jump, gravity, slope, step-up, snap-down, camera
  damping, distance, sensitivity, and wall padding.
- Network: remote player bodies, remote diagnostic capsules, network diagnostics line, and
  interpolation delay.
- Arms: preset dropdown (relaxed, brisk, sprinter) plus idle elbow bend, walk raise/swing, run
  raise/swing/forearm pump, jump arm lift, landing arm swing, and elbow direction (rotation of
  the down/back pole about the arm axis, mirrored per side: 0 bends straight back, 1.57 straight
  out; default 0.8). The preset fills the sliders;
  sliders then override it. Applied live to the local and every remote rig through
  `playerBodies.setArmTuning()`.
- Body movement: bot-viewer-v3's Movement tuning section, control for control (turn follow/drag,
  chest lead, gait model, lean into step, chest follow, foot width/reach, bob, sway, natural
  locomotion toggle, cyclic amount, step overlap, spine falloff), applied live to every rig through
  `playerBodies.setMovementTuning()`. Arms also gets Backswing (`armAsym`, the locomotion layer's
  backward-swing fraction).
- Sky: entire group, dome, sun disc, moon disc, stars, Milky Way, additional bodies.
- Lighting: directional sunlight, ambient light, moonlight, shadows.
- Time: astronomical driver, manual primary body, hour, latitude, day of year, moon phase offset,
  clock speed, play/pause.
- Manual lighting: elevation, azimuth, sun maximum intensity, day ambient intensity.

The time driver combines horizon tests with user masks. A sun or moon is visible only when the
component is enabled and the body is above the configured horizon threshold. The driver likewise
masks calculated light intensity with the light's enabled setting instead of overwriting the user's
choice on the next frame.

## Start, pause, and main-menu lifecycle

The start screen offers **Solo**, **Create Room**, and **Join Room**. "Create" means creating a
server-owned room; it does not turn that browser into a simulation host. Returning to Main Menu is
in-place: the active session is destroyed, controls are disabled, and the role picker is shown again
without reloading the renderer.

Escape and the Session panel's Pause/Menu button open the same pause menu. Solo pause freezes the
local world clock. Online pause releases local controls but continues receiving snapshots and keeps
the shared clock moving. Settings opens the existing control panel while the local game remains
paused.

## Server-authoritative multiplayer foundation

The existing Environment Viewer host/guest relay protocol remains intact. Base Game messages use a
separate version-3 protocol handled by `server/base-game-rooms.js`:

- Client: `base:create`, `base:join`, `base:resume`, `base:set_world`, `base:input`.
- Server: `base:joined`, `base:snapshot`, `base:error`.

The server owns each room's canonical world state, revision, roster, owner identity, clock, and
every player's simulation. It steps player controllers at 120 Hz in lockstep with client ticks
and broadcasts complete snapshots at 20 Hz. Clients render/extrapolate the inexpensive clock between snapshots and accept the next
server snapshot as correction. The room owner is an administrator allowed to request
shared-setting changes, not a simulation authority; the server validates and applies every request.

Sessions receive an opaque reconnect token. A disconnected identity and room survive for a
30-second grace period, during which the client reconnects with exponential backoff. After the grace
period the server transfers room ownership to a connected player; an empty room is deleted. The
current server is in-memory, so process restart persistence remains a later milestone.

Protocol version 3 replicates players. Roster entries carry `id`, `connected`, `owner`,
`spawnRevision`, `tick`, `lastProcessedTick`, `queueDepth`, `lastInputClientTime`, global
`position`, `velocity`, `yaw`, `pitch`, and `grounded`. Clients send only numbered tick inputs;
there is no position message. The implementation state is recorded under roadmap Step 4 below.

Shared world keys are `primaryBody`, all `tod*` clock/astronomy values, manual sun elevation and
azimuth, and sun/ambient intensity. Guests see these controls disabled. Camera state, panel/UI,
save slots, sky-part visibility, light-part visibility, and shadows remain local so every client can
isolate rendering components without changing the world for others. Loading a state as room owner
publishes its shared values through the server; loading as a guest applies only local values.

## State contract

The state format is `pcw-base-game-state`, version 2. `captureAllState()` records:

- Every key in the single `DEFAULT_SETTINGS` object.
- Camera position, OrbitControls target, and FOV.
- Global player/previous-fixed positions, velocity, grounded state, yaw/pitch, and camera boom memory.
- The render origin independently of the global player position.
- Panel collapsed state and each named section's collapsed state.

Every settings control must register its key. Startup throws if a key in `DEFAULT_SETTINGS` has no
control, so a configured parameter cannot silently be omitted from saves. Loading iterates the same
default key set, checks types, clamps numeric ranges, rejects unknown enum values, and ignores unknown
future/legacy keys.

Four persistence paths share the exact same capture/apply functions:

1. Six named Bot Viewer-style local slots.
2. Slot mirroring to `bot-viewer-saves/` through `serve.py` when that server is available.
3. Explicit JSON download and JSON file upload.
4. Debounced local autosave with an explicit "Restore last session" action.

State files use the Bot Viewer envelope shape:

```json
{
  "group": "base-game",
  "name": "base game",
  "savedAt": "ISO timestamp",
  "data": {
    "format": "pcw-base-game-state",
    "version": 2,
    "settings": {},
    "camera": {},
    "world": { "renderOrigin": [0, 0, 0] },
    "player": {},
    "ui": {}
  }
}
```

The loader accepts either this envelope or its inner `data` object, so files mirrored by a slot and
files downloaded directly use the same load path.

## Sky lifecycle rules

Component visibility is retained by `sky.js` itself and reapplied after rebuilds. Callers do not
inspect `group.children` or depend on child ordering.

Live visibility, direction, intensity, draw-range, and dome-state changes do not rebuild resources.
`setPalette()`, `setSeed()`, and explicit `rebuild()` do. Any host that invokes those operations must
continue calling `flushDisposals()` after render from inside its serialized frame.

## Baseline HUD

The bottom-left HUD reports FPS, worst frame in the current sampling window, draw calls, triangles,
dropped/reentrant frames, and current Solo/room/connection status. Renderer counters are copied
immediately after render so later async work cannot expose counters from a different frame.

## Performance captures

The control panel has a small **Performance Capture** section, not an in-game history window. Choose
a measurement window from instantaneous (0 seconds) through 10 seconds and press **Record
Performance**. The text label is optional: `capturedAt` plus the complete recorded configuration
distinguish unlabeled entries. A timed capture samples rendered frames only after the button is
pressed; JSON construction and disk I/O happen after the measurement window so they do not become
part of the measured workload.

Each entry records every `DEFAULT_SETTINGS` value at the start and end, a separate map of active
boolean toggles, session/viewport context, and performance distributions for FPS, frame time, draw
calls, and triangles. Timed results include average, minimum, maximum, p50, p95, p99, standard
deviation, sample count, effective FPS, and dropped-frame totals. If configuration changes during
the window, `configurationStable` is false and the changed values are listed. Normal `todHour`
movement while the clock remains running is listed separately as an expected dynamic change.

The browser sends one completed entry to `serve.py`, which atomically prepends it to
`research/stats/base-game-performance-log.json`; newest results therefore appear first and an old
browser tab never sends an old copy of the log back to the server. The file uses the
`pcw-base-game-performance-log` version-1 envelope and is created on the first successful capture.
Disk persistence requires loading Base Game through `serve.py`.

## Audio

The same `createEnvironmentAudio` controller the environment viewer and `bot-viewer-v3.html` run,
with the camera as the listener, `autoplayOnGesture: false` and `isGameplayActive` = not in the
menu and not paused. SFX load with zero setup over http (`restoreSfxFolder()` falls back to
`sfx/sound-map.json`); music is the `'http'` playlist of `sfx/music/` behind the "Play music"
toggle, default off.

`base-game-audio.js` is the pure director (`test-base-game-audio.mjs`). It owns no Web Audio; it
decides which event id fires and where, then calls `play`/`playAt`, or `playSynthAt` with a
`weapon-sfx-synth.js` voice when `hasSfxEvent` is false. A local footstep is a literal foot plant:
the procedural body's `gait.feet.{left,right}.stepping` flag is true while a foot swings, and the
frame it drops the step plays at `foot.current` (+0.16 m), panned ±0.18 toward that side through
html-game-v2's `ownStep` profile (ref 6 m, max 16 m, no rolloff, volumeScale 1.45), sample volume
0.4. Settling shuffles below 0.5 m/s and plants while airborne are ignored. When the body is not
being stepped (hidden in the current view mode) the director falls back to v2's bob cadence: one
step each time `floor((weaponViewModel.bobPhase - pi/2) / pi)` changes, alternating sides, placed
0.32 m beside the feet.

`jump` and `landing` both come off the controller's `grounded` flag, which cannot be trusted alone:
walking over uneven ground lifts the capsule off the terrain every step, and a landing per bump
sounds exactly like a footstep while ignoring the footsteps toggle. So a jump needs at least
`minJumpRise` (2.5 m/s) of upward speed on leaving the ground, and a landing needs both
`minAirTime` (0.15 s) and a peak fall of `minLandingFall` (2.2 m/s) built up in the air; landing
volume is 0.65 + 0.03 x that peak fall. Every event has a budget of 4–8
starts per 100 ms and positional sounds are culled at 70 m.

Fire points in `base-game.html`:

- `audioDirector.updateLocal(dt, { speed, grounded, verticalSpeed, feet, bobPhase, position, right })`
  once per frame from the controller's velocity, `playerBodies.localBody.gait.feet` (only when
  last frame's `playerBodies.updateLocal` returned true), the view-model bob phase, the render-local
  feet position and the camera's right vector.
- `localReload()` wherever `playerBodies.localReload()` returns true (both the lockstep and the solo
  path), `localSlotChange()` on a 1–4 key that changes the slot. Both use the new `weapon_reload` /
  `weapon_draw` ids, which have no sample yet and play the synth voices.
- `updateRemote(id, { position, grounded, action, actionTick, weapon })` per remote player from its
  interpolated sample converted through `worldCoordinates.toRenderLocal`; footsteps, jump and
  landing are positional with the step profile, and a new `actionTick` plays `weapon_reload`,
  `weapon_draw` or (once the server emits fire actions) the weapon report via `weaponFireEvent`.
  `releaseRemote(id)` when the body is released.
- `menuOpen()` / `menuClose()` around the pause menu; `envAudio.update()` every frame before the
  terrain update.

The Audio panel section holds master/effects/music volume, mute, the sound-effects, footsteps,
other-players and synth-fallback switches, the music toggle and previous/next track. All of it
lives in `settings` (`audio*` keys), so it autosaves and round-trips through slots and JSON;
`applyAllState` re-applies it to the controller. `sfx/sound-map.json` now carries html-game-v2's
Metroid Prime footstep (4 variants) and jump (4 variants) sets plus `landing`, `pause_open`,
`pause_close` and `weapon_draw` (v2's `weapon_switch`), so every base-game event except
`weapon_reload` plays a real file; `weapon-sfx-synth.js` has v2's noise+tone footstep, jump and
landing voices as the fallback.

## Verification

Run the existing pure/state tests:

```powershell
node test-sky-field.mjs
node test-solar-position.mjs
node test-celestial-bodies-smoke.mjs
node test-world-coordinates.mjs
node test-world-query.mjs
node test-traversal-lab.mjs
node test-base-game-session.mjs
node test-base-game-player.mjs
node test-base-game-replication.mjs
node test-base-game-fire.mjs
node test-performance-capture.mjs
python -B test_performance_capture_store.py
node server/test-base-game-rooms.mjs
node server/test-base-game-relay.mjs
```

Browser acceptance requires a clean cold load, no WebGPU validation errors, zero steady-state
dropped frames under normal load, live component toggles with corresponding draw-count changes,
correct sun/moon and light alignment, state round-tripping through both slots and JSON, and a resize
without sky reconstruction. Multiplayer acceptance additionally requires two tabs to create/join
one room, owner changes to appear on the guest, guest shared controls to remain disabled, local
component toggles to stay independent, online pause to leave the clock running, Solo pause to stop
it, and Main Menu to disconnect without a reconnect.

## World implementation roadmap

This roadmap governs the progression from the sky-only v0 to a traversable, streamable world. The
systems are introduced one at a time and each phase ends at an explicit visual, correctness, and
performance gate. A later phase must not silently replace an earlier system with an unrelated
implementation.

The required build order is:

1. Global/local coordinate and three-dimensional world-query contracts.
2. Permanent geometric Traversal Lab debug world.
3. Minimal player and camera using that 3D query foundation.
4. Server-authoritative player replication, prediction/reconciliation, and remote presentation.
5. Common terrain-source contract.
6. Infinite Terrain Generator v5 heightfield source.
7. Terrain streaming and flight-scale LOD data.
8. Connect terrain as another collision/query provider without changing the player contract.
9. Regional river and lake hydrology.
10. Water rendering, rapids, and waterfalls.
11. Moisture-driven plants and other world dressing.
12. Creatures, expanded structures/caves, flight gameplay, and remaining systems.

The Traversal Lab and 3D collision foundation deliberately precede real terrain even though complete
caves and buildings may arrive later. Player movement, weapons, cameras, navigation, and interaction
must not be designed around the assumption that the world has only one height for each X/Z
coordinate. Terrain is subsequently integrated into a controller that has already demonstrated
correct traversal above, below, and inside geometric structures.

### Coordinate spaces and large worlds

Canonical simulation, save, and multiplayer positions are full three-dimensional global
coordinates. Rendered positions are relative to a movable render origin so flight-scale travel does
not produce floating-point jitter far from `(0, 0, 0)`. Rebasing the render origin must not change
global entity IDs, terrain or hydrology region keys, procedural results, saved positions, or network
positions.

Surface terrain remains efficiently addressed in X/Z. Traversable solids and volumes use X/Y/Z
spatial cells. A world location is never reduced to a terrain height merely because the first player
is ground-bound.

#### Implemented coordinate and world-query foundation

Roadmap Step 1 is implemented as two renderer-independent ES modules:

- `world-coordinates.js` defines versioned `[x, y, z]` global vectors, global/render-local
  conversion, explicit and threshold-triggered render-origin rebasing, rebase events/deltas, and
  stable layer/LOD/X/Y/Z spatial-cell keys and bounds.
- `world-query.js` defines a versioned synchronous provider registry for raycast, multi-hit raycast,
  ground probe, shape sweep, overlap, and point-contents capabilities.

World-query providers have stable unique IDs, collision-layer masks, optional live enablement,
capability discovery, and deterministic priority/registration-order tie-breaking. Results are
normalized into global 3D positions with provider, collider, entity, material, surface, walkability,
normal, and moving-surface velocity fields where supplied. A ground probe combines stacked results
from every eligible provider and selects the nearest walkable surface rather than assuming one Y per
X/Z.

Queries are synchronous because they run inside movement and interaction simulation. Streaming and
BVH construction may be asynchronous outside the service, but only resident provider data may answer
a query; returning a Promise from a provider is a contract error. `heightAt(x, z)` is not part of the
generic service and will later be exposed only as an optimized terrain-provider capability behind
ground probes and sweeps.

Focused verification is in `test-world-coordinates.mjs` and `test-world-query.mjs`. It covers
billion-unit global coordinates, 3D origin shifts, negative spatial cells, stable key round-trips,
stacked floors at the same X/Z, slope filtering, layer masks, provider lifecycle and tie-breaking,
shape/volume dispatch, and rejection of asynchronous frame-critical queries.

### Permanent 3D Traversal Lab

Before real terrain, Base Game provides a permanent geometric Traversal Lab. It is selected through
an in-game world/debug menu rather than a URL or page reload. `Empty Space`, `Traversal Lab`, and
later terrain sources are ordinary live world-mode choices covered by state save/load and
performance capture. The lab remains available after terrain is implemented as an uncluttered
regression environment for player movement, cameras, collision, navigation, weapons, structures,
multiplayer prediction, and floating-origin changes.

The lab contains deliberately diagnostic geometry rather than decorative scenery:

- A flat starting platform and a long-distance platform for render-origin rebasing tests.
- Slopes immediately below and above the configured walkable limit.
- Stairs, isolated steps, ramps, and transitions between triangle seams.
- Narrow ledges, drop-offs, pits, and floating platforms.
- Stacked floors sharing the same X/Z coordinates.
- A bridge with traversable space above and below.
- A tunnel with floor, walls, and ceiling plus a simple cave-shaped section.
- Doorways and low ceilings around the capsule-clearance threshold.
- Concave corners and opposing nearby surfaces.
- A moving platform when dynamic-collider support is introduced.

Every test structure has a stable ID and known dimensions so failures can be reproduced and covered
by automated geometry/query tests. Collision shapes, contact normals, grounded state, current
surface ID, capsule, ground-probe result, and render origin have live debug visualizations.

Traversal Lab acceptance requires a capsule, ray, and ground probe to distinguish stacked surfaces;
walk both over and under the bridge; enter and leave the tunnel; handle floors, walls, and ceilings;
cross triangle seams without snagging; reject too-steep slopes; and continue working after a render-
origin rebase. None of those tests may depend on `heightAt(x, z)`.

#### Implemented Traversal Lab state

Roadmap Step 2 is implemented. `traversal-lab-layout.js` owns a deterministic versioned descriptor
containing the origin platform, walkable and too-steep ramps, stairs and step-height probes, a bridge
with ground beneath it, a tunnel and low-clearance doorway, three stacked floors, ledges, concave
corners, a faceted cave passage, and a platform beyond the default render-origin rebase threshold.
Every solid has a stable diagnostic ID and zone.

`base-game-traversal-lab.js` merges those boxes into one rendered mesh per material bucket, then
passes those same meshes to the existing `createMapCollider()` BVH builder. Diagnostic axes and the
optional collision wireframe are added only after collision is baked. The collider is adapted into
the shared world-query service as provider `traversal-lab-static`; switching World Mode to Empty
Space disables the provider as well as hiding the geometry, so invisible lab solids cannot block a
future player. The UI also provides a one-click camera framing action.

`test-traversal-lab.mjs` validates descriptor determinism and coverage, constructs the real merged
Three.js geometry and BVH under Node, queries actual stacked bridge/building/tunnel surfaces through
the Step 1 service, verifies that the bridge deck is selected over the ground at the same X/Z, and
checks live disablement and disposal. Visual browser inspection remains required for material,
lighting, shadow, and camera composition because there is no automated browser connector in this
workspace.

### Pre-terrain player and camera foundation

The first player is intentionally plain. This phase establishes only the reusable controller,
camera, timing, coordinates, collision, and diagnostics:

- Capsule sweep/resolution, gravity, jumping, grounded state, and ceiling response.
- Step-up, snap-down, slope limits, controlled sliding, and stable seam traversal.
- Fixed simulation stepping with bounded catch-up rather than frame-rate-dependent movement.
- Global 3D simulation position and render-local presentation position.
- First- or third-person view using standard, independently damped camera behavior.
- Camera obstruction handled separately from player-body collision.
- No direct rigid attachment of camera transform to a jerking physics/body transform.
- World-query-based footsteps and surface identity hooks without terrain-specific assumptions.

Player art, animation, combat, inventory, elaborate locomotion, and terrain-dependent effects are out
of scope for this gate. Success means the diagnostic capsule and camera traverse the complete lab
without tunneling, sticking, visible camera jerk, or disagreement between fixed-step simulation and
render interpolation. The next roadmap phase must replicate this global 3D transform before terrain
introduces streaming, versioning, and query-availability concerns.

#### Implemented player and camera state

Roadmap Step 3 is implemented. `world-query.js` contract version 2 adds renderer-independent capsule
resolution. `world-query-map-provider.js` adapts that query to the existing
`map-collision.js`/`three-mesh-bvh` resolver; ray-only providers remain valid. Resolution reports
ground, ceiling, velocity correction, and provider-tagged contacts. Movement is split by distance
before resolution, so the fixed-step controller does not rely on one large frame-dependent move.

`base-game-player-controller.js` owns a global 3D foot position, capsule dimensions, velocity,
grounded/ceiling state, current world-query surface identity, camera-relative movement, gravity,
jumping, slope limits, controlled steep-surface sliding, explicit step-up, bounded snap-down, and
render interpolation. It simulates at 120 Hz with at most eight catch-up steps per rendered frame;
discarded excess time is reported in diagnostics instead of causing an unbounded freeze. The
standard 0.6 m lab step is accepted with a 0.1 mm geometry tolerance, while the 1.3 m probe is
rejected.

`base-game-player-view.js` owns only presentation. The visible player remains a diagnostic capsule.
First- and third-person cameras follow the interpolated position rather than a render/body transform,
and focus and camera positions use independent exponential damping. Third-person obstruction uses a
separate world ray: it retracts immediately, releases gradually, and clamps the damped camera with a
second ray so damping cannot carry it through a wall. OrbitControls remain an explicit in-game debug
mode and never run while the player camera owns the view.

All player and camera tuning values are registered settings and therefore participate in save slots,
autosave, JSON export/import, and performance records. State format version 2 additionally saves the
global player position, previous fixed position, velocity, grounded state, yaw/pitch, camera boom
memory, and render origin. Version 1 files remain loadable because these additions are optional.
Pause/menu/settings transitions clear held input and release pointer lock.

`test-base-game-player.mjs` constructs the real Traversal Lab geometry and BVH. It verifies floor
settling, camera-relative movement, jumping and landing, ceiling response, distinct Y values at one
stacked-floor X/Z, sprint wall blocking, accepted/rejected step heights, bounded catch-up, global 3D
state round-trip, surface identity, first-person capsule hiding, third-person wall obstruction, and
the required HTML integration points. Visual feel and pointer-lock interaction still require the
browser play test.

### Player body presentation (Track A of the parallel plan)

Tracks A1-A5 of `docs/superpowers/plans/2026-08-21-base-game-player-body-terrain-parallel.md` are
implemented against the Traversal Lab; A6 (the body acceptance gate) is a browser review.

- `base-game-body-support.js` is the one compatibility change. The procedural body asks for ground
  height through its existing `terrainHeight(x, z)` callback; this adapter answers that exact
  signature with `worldQuery.groundProbe()`. Each probe starts 1.0 m above the body's current
  global foot Y and searches 1.9 m downward, so a bridge deck, a stacked floor, a tunnel floor and
  a cave floor all resolve without ever scanning a whole column. It converts render-local in and
  out and keeps a global reference, so a render-origin rebase changes nothing. With no support in
  the window it returns the capsule's own foot plane (the body's airborne pose comes from
  `onFloor`, not from this value); misses are counted. `player-procedural-body.js` is unchanged,
  so every existing viewer keeps its heightfield path.
- `base-game-player-bodies.js` is the presentation owner. It builds/destroys one local rig
  (`thirdPerson` = `local-third-person`, `lowerBody` = `local-lower-body`) and one remote rig per
  player id, converts global foot positions to render-local body centres, feeds velocity, yaw,
  pitch, grounded state and capsule size, enables Bot Viewer v3's `adaptGaitToSpeed`,
  `movementDynamics` and `naturalLocomotion`, renders remote rigs through `body-part-batches.js`
  instancing, tints remotes with the same id-derived colour as their capsule, and reports counts and
  support probes/misses. It owns no input, simulation, networking, camera or state storage and
  cannot move the capsule.
- Conventions carried over from Bot Viewer v3 (2026-08-21), because the rig leans and strides along
  its *facing*: the body's `yaw` is the heading of travel (`atan2(-vx, -vz)`, held while slower than
  0.4 m/s) and the camera yaw is sent as `lookYaw`/`lookWeight` so the head looks where the camera
  points; `gait.cfg.stepOverlap` is 0.22 (v3's roll-through, the rig default 0 is plant-pause-plant);
  every rig starts on v3's shipped `botMovementSettings` (`BASE_GAME_MOVEMENT_DEFAULTS`) applied
  through a port of its `applyBotMovementSettings()`. The arm-pose presets blend walk→run on
  absolute m/s, so `setMovementSpeeds()` rescales their thresholds from the live move speeds.
- `base-game.html` adds the registered `playerBodyMode` (default `thirdPerson`) and
  `remoteBodiesEnabled` (default on) settings; `playerCapsuleVisible` and `remotePlayersEnabled`
  (remote capsules) now default off but remain independent toggles. The local body reads the same
  interpolated render position the capsule uses; a third-person rig shows only in third-person view
  and a lower-body rig only in first-person view. Remote bodies read the interpolated samples that
  `base-game-remote-players.js` now computes even when its capsules are hidden. Body diagnostics
  join `context.network.bodies` in performance captures.
- **Model appearance.** `bodyDesign` (default `default`, the bare rig) picks one of
  `BASE_GAME_BODY_DESIGNS`: `bot-body-versions.js`'s `BOT_BODIES` list (v1 blockout … v5 current,
  human) followed by the five human soldier role kits (`soldier:rifleman` … `soldier:squadleader`,
  built by the now-exported `buildSoldierDesign` in `bot-body-design.js`). `playerBodies.setBodyDesign(key)` composes the design with `composeBot` (the
  human body gets its human head), rebuilds the local body in place and drops remotes so they
  re-create on their next update. The dropdown sits in the Player section under "Player body".
  Appearance is local-only: it is not replicated, so each client sees its own choice on every body.

`test-base-game-player-body.mjs` (27 checks) proves stacked floors, bridge deck versus ground,
tunnel floor versus roof, ramp and standard step, an airborne miss, render-origin independence,
that body updates never mutate the controller, local and stacked remote feet through the owner,
release by id, feet following a rebase, body-off teardown, and the page integration points.

### Weapons, phase 1: third-person holding (shipped 2026-08-22)

Plan: `docs/superpowers/plans/2026-08-22-base-game-weapon-holding.md`. Phase 1 puts a weapon from
`weapons.js` in the hands of every body, local and remote, with the authored stance holds, the
walk/run/dash carries, aim and the reload choreography. Nothing fires yet.

- **`weapon-mount.js`** is the mount (Contract 6) extracted from `bot-viewer-v3.html` as a module:
  `createWeaponMountSystem({ THREE, scene, loadGLB, getWeapon, loadData? })` owns the instanced pool
  (`weapon-part-batches.js`), the anchor/pose JSON and a GLB template cache (`bakedAnchors`,
  `instanceParts`, `bounds`, `reducedParts`). `createMount(body, weaponId)` is async (GLB fetch) and
  resolves null for a weapon with no model or third-person hold. `updateMount(mount, dt, frame)`
  takes `{ feetY, bodyX, bodyZ, yaw, stance, stanceWeights, speed, aiming, aimPoint, bob, sway,
  headYaw, aimChannels, viewFrame?, viewBlend?, drawBlend? }`, places the ground-anchored root at
  feet + 1.5, resolves the hold, runs the pose controller, trims the barrel onto `aimPoint`, and
  handles the one-handed dash. `beginFrame / flushMount / endFrame` write the pool once per page
  frame. The barrel ray runs along the normalized model's bore through the muzzle (the old
  grip-to-muzzle line tilted up, so an aligned gun shot low). `holdOffsetY/Z` are page trims,
  exposed as the `weaponHoldHeight` / `weaponHoldForward` sliders. `muzzleWorld`,
  `barrelDirection`, `drainEvents` are the phase 3 seams; `viewFrame +
  viewBlend` is phase 2's; `drawBlend` + `def.holsterHold` and `reducedParts` are phase 4's.
  `test-weapon-mount.mjs` drives it headless with a fake GLB sized like the CZ.
- **`base-game-player-bodies.js`** takes a `weaponSystem` and keeps a weapon record per body
  (`{ id, mount, pending, action, actionTick, lastActionTick, ammo: null }`). `setWeapon(id)` for
  the local body; remotes take `sample.weapon`. In `feed()` the look-vs-heading residual and the
  pitch go through `solveAimBlend` (`BASE_GAME_AIM_BLEND`: torso, head and barrel trim all on) so
  the torso carries the gun toward the crosshair and the rig gets `aimYaw/aimLean/lookYaw`; then
  the mount updates from the rig's `motion`. Remote aim points sit 30 m along the replicated look.
  `sample.action` with a new `actionTick` plays the reload once. A design swap re-creates the mount;
  `endRemoteFrame()` flushes the pool (Solo calls `flushWeapons()` itself).
- **`base-game.html`**: loadout dropdowns (`weaponPrimary/Sidearm/Melee/Throwable`, default CZ 805
  / Five-seveN / knife / grenade), keys 1 to 4 pick the slot, R reloads, right mouse aims, T resets
  the player (R used to). The aim point is the camera ray against the world query. The loadout is
  pushed with `session.setLoadout()` once the room is ready and on every dropdown change.
- **Protocol version 7**: tick input adds `slot`, `aim`, `reload` (edge) and a reserved `fire`;
  player state adds `slot`, `weapon` (resolved id), `aiming`, `action` (0 idle, 1 reload, 2 fire,
  3 holster, 4 draw), `actionTick`, `health` (echoed 100). `base:loadout` replaces a client's
  loadout (`sanitizeBaseGameLoadout`, ids from `BASE_GAME_WEAPON_IDS`). The server does not
  simulate weapons: it echoes slot and aim from consumed ticks, starts a reload at the tick of an
  edge on a `BASE_GAME_RELOADABLE_WEAPONS` id, clears it after `BASE_GAME_RELOAD_TICKS` or a slot
  change, and keeps `BASE_GAME_POSITION_HISTORY` recent positions per client for phase 3's lag
  compensation. Remote samples carry the latest weapon fields un-interpolated.
- `bot-viewer-v3.html` was switched to the module the same day (1.5): its mount functions are
  wrappers now and the three mount code paths no longer exist twice.

### Weapons, phase 2: first-person blend model (shipped 2026-08-22)

One rig, two presentation axes, owner only; remotes always see the third-person mount.

- **`weapon-viewmodel.js`** ports `environment-viewer.html`'s first-person maths with no rendering:
  authored `viewOffset` / `viewRotation`, ADS lerp to `aimOffset` / `aimRotation`, idle/walk/run bob
  cross-fade on a strafe-relative axis, run carry lean, recoil kick, and the reload delta from the
  shared `reloadSequence`. `update(dt, { speed, aim, running, moveX, moveZ, lookYaw })` returns a
  camera-local `{ position, rotation, viewBob }`. `test-weapon-viewmodel.mjs`.
- **Blend**: the page lifts that pose into the world through the camera matrix and passes it as the
  local sample's `viewFrame` + `viewBlend`; `weapon-mount.js` lerps the whole rig toward it before
  the pose controller runs, so hands and reloads are right at any blend. Blend target = the
  `fpViewBlend` setting, pulled to 1 while aiming and to 30 % while sprinting, eased at 6/s.
- **Presets** (`fpPreset`): arcade (blend 1, comfort off), embodied (blend 0, comfort light),
  hybrid (blend 0.6, comfort off, default), custom (whatever the two controls say).
- **First-person eye** (2026-08-23, measured): the rig's eyes are at 1.96 m and its shoulders at
  1.66 m on a 1.8 m capsule, while the capsule eye was 1.62 m, so the camera sat below the
  shoulders. The eye's X/Z now stay on the capsule (the render body trails the capsule by up to
  ~0.46 m when running, and anchoring the camera to the head put it behind the body) plus the
  body's own eyes-ahead-of-head distance (`localEyeForward`); its height is the body's live eye
  height (`eyeAnchorY`, from `localEyePoint`), so bob, lean and stance move the camera vertically.
  `fpCameraComfort` damps only that height (`comfortRateY`, off while aiming).
- **Part mask**: the rig gained `setPartMask(mask)` over `parts.core`; in first person on the
  third-person rig the page hides head, eyes, neck and torso (`FP_PART_MASK`) and keeps arms and
  legs. Mesh-mode only hides anchored gear with its host; instanced bodies would not.
- **Two-grip reach solve** (`weaponReachSolve` toggle, default on; `frame.reachSolve` on the
  mount): before the pose controller runs, `solveReach` translates the gun toward the trigger
  hand's shoulder by any excess over `armLen * REACH_FRACTION`, then pivots it about that grip by
  the least angle that puts the support grip on the support arm's reach sphere (two iterations).
  A no-op when both grips are reachable, so authored holds are untouched; without it the arms
  simply extend and the gun floats away from the hands whenever the hold, the stance, the torso
  twist or the view frame pushes a grip out of reach.
- **Body-relative hold** (`weaponHoldMode`, default `body`; `authored` keeps the bot holds): the
  authored hold supplies rotation only; `placeBodyHold` then translates the gun so the trigger grip
  sits at trigger shoulder + aimDir × armLen × dist + right × side + up × up, idle and aim values
  blended by the controller's aim amount (`BODY_HOLD_DEFAULTS`: idle 0.55 / -0.04 / -0.16, aim
  0.46 / -0.10 / 0.06; six sliders). While aiming, the hold pitches by the full elevation to
  the aim point (not just the torso lean), so the arms swing to point the gun and the barrel
  trim covers only the residual; aiming down lowers the grip below the shoulder. Elbows bend by construction, and the body, not a fixed
  ground-frame offset, decides where the gun is. The barrel trim now pivots about the trigger grip
  (`pivotMarker`) again while taking its direction from the bore; pivoting near the muzzle swung the
  grip metres away on large corrections.
- **Default facing is environment-viewer's** (`bodyFacing: 'look'`): the body's yaw is the look
  yaw and the legs strafe (`environment-viewer.html` `localBody.update({ yaw: look.yaw, aimPitch:
  look.pitch })`), the mount is the authored ground-anchored hold, aim is `controller.setAiming`
  only. Everything below in this list is the experimental `travel` path and the opt-in toggles
  (`weaponAimTrim`, `weaponHoldMode: 'body'`, `weaponReachSolve`), all off by default since
  2026-08-23; they were patches for a facing choice env-viewer never makes.
- **Facing and the gun's leash** (`travel` only; `BASE_GAME_FACING_DEFAULTS`, sliders `bodyTurnThreshold` 0.6 rad,
  `bodyTurnRate` 7 rad/s, `gunYawLimit` 0.9 rad): a standing body turns in place toward the look
  once the residual passes the threshold and keeps turning until within `settle` (0.12 rad), so
  looking around no longer just twists the torso to its stop; while moving the heading is still the
  travel direction. The local aim point is clamped into a yaw/pitch cone about the heading
  (`clampAimPoint`) before the barrel trim, so the weapon follows the camera only as far as the
  body can and waits for the turn rather than outrunning it.
- **First-person optics** (imported from `environment-viewer.html` `updateAimOptics`): base FOV
  `fpFov` 70 (third person keeps `cameraFov` 50), ADS zoom `2·atan(tan(fov/2)/magnification)`
  by the weapon's `magnification`, and the eye pushed forward by `aimEyeForward × aim`. The
  authored `aimOffset` values assume FOV 70; at 50 the sights sat off centre.
- **Camera framing**: `cameraSideOffset`, `cameraHeightOffset`, `cameraForwardOffset` (yaw-only
  right / up / forward of the look, applied to the third-person focus and the first-person eye
  alike, bot-viewer POV style) and `cameraFov` are settings; `updateCamera` takes
  `sideOffset` / `heightOffset` / `forwardOffset`. Obstruction still rays from the
  shifted focus.
- **Depth of field** (`depth-of-field.js`, off by default): `demos/sdf-bug-v2.html`'s gather
  (golden-angle disc, each tap weighted by whether its own circle of confusion reaches the pixel,
  HDR colour so highlights become discs) driven by the scene pass depth attachment. Defocus is
  measured as a fraction of the focus distance so one aperture reads the same near and far.
  `dofEnabled`, `dofAutoFocus` (centre ray against the world query, eased on the CPU at
  `focusRate`), `dofFocusDistance`, `dofAperture`, `dofMaxRadius`, `dofFarScale`. While on, the
  page renders through a `RenderPipeline` (`pass → dof → renderOutput`; `PostProcessing` is the
  pre-r183 name). Three's own `dof()` addon (`DepthOfFieldNode.js`) is the cheaper fallback if the
  gather costs too much; off, the plain
  render path runs and the pass costs nothing. `test-depth-of-field.mjs` builds the node to a
  shader through `tsl-build-check.mjs` (which gained the r182 `getOutputBufferType` stub).
- Not done: the late depth-cleared pass for arms + gun (they can clip walls at the 0.1 m near
  plane) and the shoulder pin at mid blend. Both are tuning items once the look is judged.

### Weapons, phase 3: firing, ammo, health (shipped 2026-08-23)

Plan: `docs/superpowers/plans/2026-08-22-base-game-weapon-holding.md` Phase 3. Hitscan weapons now
fire, spend ammo, damage players and kill them; the server is the only authority. Built on the
multiplayer-guns stack that already existed, not a new one:

| Responsibility | Existing owner |
|---|---|
| Hit registration (ray vs capsule, world occluder), pose history for lag compensation | `combat.js` (`resolveHitscan`, `validateShot`, `pushPlayerPose` / `samplePlayerPose` / `prunePlayerPoseHistory`) |
| Player hp / alive / revive | `player-combat.js` (`createPlayerCombatFacade`) |
| Magazines | `player-ammo.js` — `defaultAmmoFor` / `ensureAmmo` / `reloadAmmo` / `consumeAmmo` lifted verbatim from `environment-viewer.html` into a module with a `createAmmoStore()` wrapper |
| Weapon numbers (`damage`, `fireIntervalMs`, `magazineSize`, `reserveAmmo`, `automatic`, `range`) | `weapons.js` |
| Fire and damage sounds | `base-game-audio.js` (`localFire`, remote `action === 2`, new `localDamage`, `hitAt`) |

What is new is only what lockstep needed and nothing had: **`base-game-fire.js`**. `createTriggerState()`
+ `stepTrigger(trigger, ammo, { playerId, weaponId, tick, fire, reload, alive })` is the one trigger
step both sides run per tick. It turns the tick's `fire` boolean into a press edge (semi-auto) or a
hold (`automatic`), asks `validateShot` whether the cadence allows a shot (the tick is converted to
milliseconds, so cooldowns are the same `fireIntervalMs` every other page uses), draws from
`player-ammo.js`, and runs the reload window in ticks (`BASE_GAME_RELOAD_TICKS`, ammo commits when
it closes; a dry press starts one). `lookDirection(yaw, pitch)` is the player-view look vector.

**Server** (`server/base-game-rooms.js`). Each room owns a `combat` facade, an `ammo` store and a
`poseHistory` map. `consumeTick` runs `stepTrigger`; a fired tick stamps `action = fire` for
`BASE_GAME_FIRE_ACTION_TICKS` (12, so a 20 Hz snapshot never misses it) and calls `fireShot`:
origin is the capsule top (combat.js's head convention), direction is the look vector, every other
player is sampled from the pose history `BASE_GAME_LAG_COMP_MS` (100 ms, the client interpolation
delay) in the past, the room's `worldQuery.raycast` is the occluder, and a `player` hit goes through
`combat.applyDamage`. Death: the victim's controller runs neutral steps (ticks still consumed so
numbering holds), and after `BASE_GAME_RESPAWN_TICKS` (3 s) `respawnClient` revives, refills ammo,
resets the trigger and resyncs as before. Melee and projectile modes are accepted by the trigger
(ammo, cadence) but resolve nothing yet.

**Protocol 8.** Roster entries add `dead` and `ammo: { mag, reserve }` (active slot); the snapshot adds
one-shot `hits[]` (`shooter, victim, point, damage, head, tick`) and `deaths[]` (`victim, killer,
tick`), drained on each broadcast (the joiner's private snapshot does not drain). Sanitizers:
`sanitizeBaseGameHitEvent`, `sanitizeBaseGameDeathEvent`, `wireAmmo`. `BASE_GAME_MAX_HEALTH` is 100.

**Page.** Left mouse (pointer-locked) sets `weaponState.firing`, which rides the tick. The page keeps
its own `createTriggerState()` + `createAmmoStore()` and runs `stepLocalTrigger` on every predicted
tick (online) or fixed step (solo): a predicted shot plays `audioDirector.localFire` and
`weaponViewModel.recoil()`, a predicted reload starts the existing reload choreography. Hits are
never predicted. On each snapshot the local entry's `health`, `dead` and `ammo` overwrite the local
copy; `hits` where I am the shooter flash HIT, where I am the victim flash the red vignette
(`#damage-flash`) and play `player_damage`, and any other hit plays `enemy_hit` at the point;
`deaths` set "killed by". The `#combat` HUD (bottom right) shows HP or DEAD, the weapon and
`mag / reserve`.

**Spread, tracers, muzzle flash, projectiles (same day).** Again on what existed:

| Responsibility | Existing owner |
|---|---|
| Dispersion cone (base + move + first-shot settle + bloom) and the rotation off-axis | `bot-aim.js` (`spreadHalfAngleRad`, `bloomAfterShot`, `decayBloomDeg`, `dispersedDirection`); base angle is `weapons.js` `spreadRad`, authored since the guns design but unread until now |
| Deterministic rolls | `biome-classifier-js.js` `mulberry32(hashSeed(seed, tick))`, seed = `bot-activity.js` `botSeedFromId(clientId)` |
| Projectile flight, bounce, fuse, fizzle | `bot-projectiles.js` `createProjectileManager` over `entity-types/combat-projectile.js`, one manager per room |
| Blast falloff | `entity-types/explosion.js` `blastDamageAt` (environment-viewer's `applyExplosionBlast` rule: 45 % at the edge, 12 floor, friendly fire and self-damage on) |
| Tracer timing / geometry, flash and smoke, sparks, explosions | `tracer-visual.js` + `effect-renderer.js`, driven by bot-viewer-v3's `pushEffect` / `updateEffects` list |
| Tracer and flash origin | `weapon-mount.js` `muzzleWorld(mount)`; `base-game-player-bodies.js` gained `remoteMount(id)` beside `localMount` |
| Projectile presentation | bot-viewer-v3's pooled spheres (`projectileMeshAt`, rocket / grenade materials) placed by `createRemoteTrack` per projectile id |

`base-game-fire.js` `shotDirectionFor(trigger, { yaw, pitch, weaponId, tick, seed, moveSpeed01 })`
is the one call both sides make after `stepTrigger` reports `fired`: the trigger state carries
`bloomDeg` (decayed every tick) and `contactSinceTick` (first tick of an aim or trigger hold, for the
first-shot settle term), so the server's ray and the shooter's predicted tracer are the same ray.
The server's `fireShot` now handles `projectile` weapons by spawning through the room manager with
environment-viewer's `spawnCombatProjectile` field forwarding; the manager's raycast is `combat.js`
`resolveHitscan` over the roster plus the world occluder, with environment-viewer's rule that a
ground hit is left to the entity's own terrain contact (so grenades bounce) wherever the sim exposes
`heightAt` (terrain rooms; the lab has no heightfield, so there a grenade detonates on the floor).
Detonation applies `blastDamageAt` to every live capsule and emits an `explosions[]` event plus a
`hits[]` event per victim. The room manager is rebuilt on a terrain swap.

Protocol 8 additions: per snapshot `shots[]` (`shooter, weapon, origin, dir, end, kind, tick`),
`explosions[]` (`p, radius, owner, weapon, tick`) and `projectiles[]` (`id, p, v, color, weapon,
owner, radius`); sanitizers `sanitizeBaseGameShotEvent`, `sanitizeBaseGameExplosionEvent`,
`sanitizeBaseGameProjectileState`.

Page: a shot of mine spawns the muzzle flash and a predicted tracer (same seeded ray, ended on the
local `worldQuery.raycast`) the tick it fires; everyone else's shots, all explosions and the live
projectile list come from the snapshot. `frameProfiler.time('fx')` wraps `updateProjectiles` and
`updateShotEffects` before the sky update.

**Blast debris and the explosion light (same day).** `blast-debris-sim.js` + `blast-debris.js` run
here exactly as in bot-viewer-v3 and the flight sim: one sim (`groundAt` maps render-local x/z
through `worldCoordinates.toGlobal` onto `terrain.groundHeight`, or the lab's floor), one renderer
with `lightCount: 2`, `createExplosionBudget()` tiering, and v3's `spawnBlastDebris` (shrapnel
always, rubble only for a ground burst) fired from each `explosions[]` event. A rebase clears the
sim — pieces are render-local and the origin just moved under them. The explosion and muzzle light
is **`flash-lights.js`**, the dynamic-light budget extracted verbatim from `bot-viewer-visuals.js`
(`createFlashLights({ THREE, scene, getViewPosition })`): a 64-record ring feeding two resident
`PointLight`s by `flashCurve` / `pickLightSlotsInto` from `bot-viewer-visuals-style.js`, intensity-only
writes, never `.visible` (the WebGPU pipeline-hash rule travels with the code). Blasts use v3's
`spawnBlastFx` numbers (`BLAST_FLASH`, distance `min(60, radius * 3.2)`); every muzzle flash borrows
a slot like v3's `spawnTracer` does. `debrisSim.step` / `debrisRenderer.sync` / `flashLights.update`
run in the frame's `fx` block. Node-tested: `test-flash-lights.mjs`.

**What a blast throws.** Shrapnel is the warhead coming apart, so every blast throws it. Rubble is
torn *out of a surface*, so it needs two things, and this page diverges from bot-viewer-v3's
proximity rule to get them right:

1. **The blast actually touched a surface.** `entity-types/combat-projectile.js` now tags each
   detonation with a `cause` — `impact` (a body or wall), `ground` (terrain), `rest` (cooked out
   lying on the ground), `fuse` or `airburst` (both in mid-air) — and exports
   `isSurfaceDetonation(cause)` for the first three. `bot-projectiles.js` forwards the explosion
   init to `onDetonate` as a third argument so a caller reads the cause instead of guessing it.
   The server puts the boolean on the `explosions[]` event as `contact`. v3's old test was
   "within 0.6 R of the ground", which throws rubble for an airburst over a hillside and none for a
   rocket that hits a wall two metres up.
2. **A warhead that breaks surfaces.** `weapons.js` `projectile.rubble: false` opts a weapon out
   entirely; the frag grenade carries it, so it never digs anything up wherever it goes off. Absent
   means it throws rubble.

`verticalBoost` on the shrapnel now keys off the same contact flag.
Projectile trails are v3's `onTrail` smoke puffs emitted **client-side** at the manager's 0.035 s
cadence from the interpolated flight path — the sim runs on the server, which has no effect list.
**Solo** runs its own `bot-projectiles.js` manager against the local `worldQuery` (v3's wiring,
FX-only since solo has nothing to damage) and renders it through the same sphere pool, so an RPG
behaves identically offline. `presentExplosion(globalPoint, radius)` is the one presentation both
the snapshot `explosions[]` events and the solo manager call.

Not done: remote recoil on bodies, head multiplier (`head` is always false), melee.

Tests: `test-base-game-fire.mjs` (trigger step, seeded spread, protocol, a two-player room where
one shoots the other dead and the server respawns them, then an RPG flight that detonates and
damages, page markers). `test-combat.mjs`, `test-bot-aim.mjs`, `test-bot-projectiles.mjs`,
`test-tracer-visual.mjs` cover the reused math.

### Pre-terrain server-authoritative player replication

Roadmap Step 4 is mandatory before any terrain implementation. The existing room service is retained,
but protocol version 3 extends it from shared-world synchronization to actual player simulation and
presentation. This phase reuses the Step 1 query contract and Step 3 controller; it must not introduce
a network-only movement model, a second collision implementation, or a browser acting as host.

#### Authority and simulation boundary

- The OnRender Node server is the simulation authority for every room and every player. Room owner
  remains an administrative permission for shared world settings and has no movement authority.
- Clients send numbered tick inputs, never trusted position/velocity corrections. The server
  validates finite/ranged values, ordering, rate, room identity, and connection ownership.
- Each room advances server player controllers at 120 Hz, consuming exactly one client tick per
  step so server and client arithmetic match. Delayed service wake-ups catch up at most a quarter
  second rather than running an unbounded recovery loop.
- The server initially simulates against the exact Traversal Lab collision source. Collision geometry
  construction is extracted from the rendered lab module so browser and server consume one descriptor
  and one `map-collision.js`/world-query path. The server never imports scene materials or WebGPU code.
- Player-player collision is disabled for this first replication gate. Players are visible but do not
  push or block one another, avoiding circular prediction and order-dependent collision. World
  collision remains authoritative.
- A room is initially capped at 16 players. Disconnected grace-period players receive neutral input;
  their physics may settle, but they cannot continue moving under stale input.

#### Protocol version 3 (lockstep ticks)

The client adds one movement message. Each entry in `ticks` is one local 120 Hz simulation step:

```json
{
  "type": "base:input",
  "protocol": 3,
  "clientTime": 88012,
  "ticks": [
    { "tick": 1042, "moveX": 0, "moveZ": 1, "yaw": 1.2, "pitch": -0.1, "sprint": false, "jump": false },
    { "tick": 1043, "moveX": 0, "moveZ": 1, "yaw": 1.2, "pitch": -0.1, "sprint": false, "jump": true }
  ]
}
```

Ticks are sampled from the same control state used by local prediction and sent at a bounded 30 Hz,
each packet carrying every tick the server has not yet acknowledged. `jump` belongs to exactly one
tick and cannot repeat when that tick is resent. Consumed, duplicate, excessively future, malformed,
and over-rate input is ignored or rejected without mutating authoritative state. There is no
client `set_position` message.

Room snapshots run at 20 Hz and retain canonical shared-world state. Each player entry adds:

- Stable player ID, connection/owner flags, and a spawn revision.
- Authoritative server tick, last processed client tick, and current input-queue depth.
- Global `[x, y, z]` foot position and velocity.
- Yaw, pitch, grounded state, and view-independent diagnostic state needed for presentation.

The snapshot is complete rather than delta-compressed for the initial 16-player cap. This keeps
reconnect, packet loss, tests, and protocol inspection simple. Compression/deltas are a measured later
optimization, not part of the correctness gate.

#### Shared server-safe collision ownership

`base-game-player-controller.js` remains the only movement controller on client and server. A small
server simulation owner constructs one controller per room player and supplies the same synchronous
world-query capabilities used in the browser. Traversal Lab collision construction is split into a
renderer-free module used by both `base-game-traversal-lab.js` and the server; production server
dependencies must include the exact tested `three` and `three-mesh-bvh` versions.

The future terrain source must satisfy this same server-safe query boundary. Authoritative terrain
collision must be reproducible from world seed/project, source version, algorithm version, and global
coordinates without WebGPU or rendered LOD meshes. A room snapshot/handshake will carry those version
identifiers. The server must never substitute a flat floor when authoritative query data is missing;
movement waits or remains on the last valid state until the required provider is ready.

#### Owning-client prediction and reconciliation

- The owning client continues running the Step 3 controller immediately from local input.
- It retains a bounded history of fixed-step inputs and predicted states keyed by tick.
- On a server snapshot, it installs the acknowledged authoritative state and replays only unacknowledged
  inputs through the same controller and world query.
- Simulation correction is immediate; the existing presentation interpolation absorbs small visible
  corrections independently. Respawn/spawn-revision changes and large invalid states hard-snap and
  reset camera smoothing.
- Reconciliation compares global coordinates. Render-origin changes never enter input packets or
  authoritative snapshots and therefore cannot create false correction errors.
- Online pause sends neutral movement, releases pointer lock, and continues accepting authoritative
  snapshots. It does not pause the room or freeze the server player in midair.

#### Remote-player presentation

A dedicated remote-player manager, separate from the local player view, owns one diagnostic capsule
per roster player other than the local ID. Remote snapshots are buffered against server tick/time and
rendered approximately 100 ms behind so normal jitter is interpolated rather than extrapolated.
Extrapolation is capped at 250 ms; after that the remote holds its last state until a snapshot,
disconnect, or resume transition arrives. Spawn-revision changes clear interpolation history.

Remote positions remain global until each render, then pass through that client's own
`worldCoordinates.toRenderLocal()`. This is required to show two players at the same X/Z on different
Y levels and to let clients use different render origins. First-person mode hides only the local
diagnostic capsule. Remote capsules remain visible, receive stable ID-derived colors, and are pooled
rather than rebuilt as roster snapshots arrive. Player art, animation, names, chat, voice, and combat
replication remain outside this gate.

#### Connection lifecycle and diagnostics

- The server chooses/validates spawn state and retains authoritative transform plus input acknowledgement
  through the existing 30-second resume grace period.
- A resumed client keeps its stable player ID and reconciles from the returned server state. An expired
  resume creates a new identity/spawn revision rather than inheriting stale prediction history.
- Main Menu sends neutral input and disconnects through the existing lifecycle. Ownership transfer
  changes shared-setting permission only.
- Local saved player state remains a Solo/debug artifact; joining an online room never uploads a saved
  transform over the server's spawn state.
- In-game network diagnostics report server tick, input/snapshot rates, ping estimate, acknowledged
  tick, server queue depth, prediction error, reconciliation count, buffered interpolation time, and remote count.
- `remotePlayersEnabled`, network-debug visibility, and interpolation-delay tuning are local registered
  settings covered by save/load and performance capture. Performance records also include room player
  count and network/reconciliation statistics.

#### Implementation sequence

1. Define protocol input/player-state sanitizers and pure tick helpers with tests.
2. Extract renderer-free Traversal Lab collider construction and prove browser/server queries match.
3. Add the server player-simulation owner, neutral-input/disconnect behavior, room cap, 120 Hz
   one-tick-per-step simulation on a 60 Hz service wake-up, and 20 Hz complete snapshots.
4. Extend `base-game-session.mjs` with bounded input sending, server-time/tick tracking, and player-state
   snapshot delivery without coupling it to rendering.
5. Add a renderer-independent prediction/reconciliation module around the existing controller.
6. Add the pooled remote diagnostic-capsule manager with buffered interpolation and origin conversion.
7. Wire pause/resume/menu behavior, registered controls, state/performance context, and live diagnostics.
8. Run unit, service, relay, simulated-latency, multi-tab, and deployed OnRender acceptance gates.

#### Implemented replication state

Roadmap Step 4 is implemented in code and verified under Node; the deployed two-tab acceptance gate
below still has to be run by a person. The shipped design is **lockstep tick input**, chosen after
the first "latest input held per server tick" version produced visible 20 Hz correction steps on
the owning client: every client simulation tick is a numbered input, the server runs exactly one
controller step per tick, and replay reproduces the server's arithmetic bit-for-bit
(`test-base-game-replication.mjs` asserts exact equality).

- `base-game-protocol.mjs` is protocol version 7 (3 introduced lockstep ticks; 7 added weapons). `sanitizeBaseGameTickInput()` cleans one tick
  (identity rejected when malformed, movement clamped); `sanitizeBaseGameInputPacket()` accepts 1-64
  strictly increasing ticks; `sanitizeBaseGamePlayerState()` reads authoritative entries;
  `isAcceptableBaseGameTick()` allows only ticks newer than the last consumed one and at most 240
  ahead; `createBaseGameRateLimiter()` is a 30 Hz / burst 10 token bucket for packets. Constants
  define the 16-player cap, 120 Hz simulation, 20 Hz snapshots, queue target 3 / drain 8, and the
  60-tick stall limit.
- `base-game-player-controller.js` gains `stepOnce(input, jump)`: one fixed step from an explicit
  input, bypassing the frame accumulator. Client prediction and the server both drive ticks through
  it so the two sides execute identical code on identical numbers.
- `traversal-lab-collider.js` builds the merged lab geometry, the `map-collision.js` BVH, and the
  `traversal-lab-static` provider without importing `three/webgpu`; `base-game-traversal-lab.js`
  only attaches materials and debug helpers. The server's default world factory lazily builds this
  collider once and shares it across rooms; browser and server ground probes agree to 1e-9.
- `server/base-game-rooms.js` keeps a per-player tick queue. Each 120 Hz step consumes exactly one
  queued tick (two when the queue is deeper than 8). An empty queue freezes the player; after 60
  stalled steps the server runs neutral steps and flags a resync. Disconnected players always run
  neutral steps. A resync (join, resume, stall, disconnect) clears the queue and, on the next
  packet, adopts the client's tick numbering and bumps `spawnRevision` so the client hard-snaps and
  clears its history. Packets are dropped whole when malformed, over-rate, wrong-protocol, or from
  a socket that does not own the player; already-consumed or already-queued ticks are ignored
  individually because clients resend on purpose; a tick that is not exactly the next expected one
  is refused so the queue can never contain a gap, and `base:resync` lets a client abandon a
  backlog. Joins beyond the cap get `room_full`; snapshots
  report `worldReady`/`worldVersion` so movement never runs against a substitute floor.
  `server/server.js` calls `step()` every 1/60 s (two 120 Hz steps) and broadcasts every 50 ms.
  `server/package.json` pins `three@0.184.0` and `three-mesh-bvh@0.9.0`; `render.yaml` also
  installs the repository root's dev dependencies because the shared modules resolve `three` from
  the root `node_modules`.
- `base-game-session.mjs` adds `queueTick(entry)`, which accepts only the next consecutive tick and
  sends at most 30 packets per second, each carrying the oldest unacknowledged ticks (up to 64) so
  a lost packet costs nothing and no tick is ever skipped; snapshots drop acknowledged ticks from
  the resend queue. A backlog of 256 unacknowledged ticks triggers `requestResync()` (`base:resync`)
  instead of silently dropping ticks; the server then adopts the next numbering and bumps the spawn
  revision. The handshake does not complete until a snapshot reports `worldReady: true`, so a cold
  server never lets a client move against a placeholder. `flushInput()` sends immediately (Main
  Menu, page hide). `stats` exposes packet/tick counts, server tick, a smoothed server-time offset,
  the last acknowledged tick, and a ping estimate derived from `lastInputClientTime`.
- `base-game-prediction.js` owns the client's fixed-step accumulator. `advance(dt, sampleInput)`
  runs numbered ticks (at most eight per frame), records each with its input and resulting
  position, and reports every tick through `onTick`. `reconcile(entry)` compares the position
  recorded at the acknowledged tick with the server's, skips work when they agree within 0.1 mm,
  otherwise installs the authoritative state and replays the unacknowledged ticks (always, because
  the server will still consume them), and reports a hard snap on a spawn-revision change or an
  error above 3 m so presentation resets its smoothing; only a spawn-revision change empties the
  history. A history over 256 ticks calls `onOverflow`, which the page routes to the session's
  resync. `adjustPacing(queueDepth)` runs the local
  clock 6 % fast when the server's queue is starving and 6 % slow when it is deeper than 8.
- `base-game-remote-players.js` keeps one pooled capsule per remote roster entry. `createRemoteTrack()`
  is the pure per-player buffer: samples are keyed by server time, rendered `interpolationDelayMs`
  behind, extrapolated with velocity for at most 250 ms, then held; a spawn-revision change clears
  it. Positions stay global until `toRenderLocal()` at render, so two clients with different render
  origins and two players at one X/Z on different Y levels both work.
- `base-game.html` keeps ticking online even while paused or in Orbit mode (with neutral input) so
  the server and the local simulation never fall out of step; runs the controller directly in Solo;
  absorbs any residual soft correction as a render-only offset that decays at 12/s; hard-snaps and
  resets camera smoothing on authoritative spawn; never applies a saved player transform while
  online; flushes queued ticks before Main Menu or page hide; adds the registered
  `remotePlayersEnabled`, `networkDebugVisible`, and `interpolationDelayMs` settings; shows a
  network diagnostics line (tick, ack, server queue depth, pacing scale, error, reconciliations,
  remotes); and records `context.network` in performance captures.

`test-base-game-replication.mjs` (80 checks) covers the sanitizers and rate limiter, browser/server
collider agreement, frozen players without ticks, resync numbering, one tick per step, rejection of
consumed, far-future, malformed, wrong-protocol, wrong-socket, over-rate, and transform-injection
messages, retransmit deduplication, one jump per jump tick, queue draining, stall freeze then
resync, neutral steps after disconnect, hard-snap / exact replay / in-tolerance paths with
bit-for-bit server agreement, pacing, remote track interpolation/extrapolation/hold/reset,
render-local remote capsules with stacked Y, pooled release, session resend-until-acked, and the
HTML integration points. `server/test-base-game-relay.mjs` drives the real server process: the
owner's tick packets move its player in the guest's snapshots and `base:set_position` is ignored.

Not yet verified: the deployed OnRender gate, simulated latency/jitter/duplicate delivery, and the
16-player frame budget. Known simplification: the ping estimate includes the time an input waited
for the next snapshot.

#### Acceptance gate before terrain

Terrain work cannot begin until all of the following pass:

- Two browser tabs can Create/Join on the deployed OnRender server and continuously see each other's
  movement, jump, view direction, pause/resume, disconnect, and reconnect state.
- The server rejects direct transform injection, malformed/non-finite input, duplicate jump edges,
  stale or gapped ticks, over-rate input, and movement from a socket that does not own that player ID.
- Server and predicted clients agree while walking flat ground, climbing the standard step, rejecting
  the high step, jumping into the tunnel ceiling, sliding on the steep ramp, and stopping at walls.
- Two players can occupy identical X/Z coordinates on different bridge/stacked-floor Y levels without
  snapping to one height or swapping interpolation tracks.
- One client can cross the render-origin threshold while another remains at origin; both continue to
  see the same authoritative global positions without a network teleport.
- Simulated latency, jitter, duplicate delivery, and reconnect do not cause unbounded input history,
  repeated jumps, indefinite extrapolation, or visible one-frame correction spikes for ordinary error.
- Sixteen diagnostic players remain within the established Base Game frame-time/draw-call budget, and
  server stepping/snapshot work remains bounded when a service tick is late.
- All Step 1-3 coordinate, query, Traversal Lab, player/camera, state, room-service, relay, and
  performance tests remain green.

Only after this gate is accepted may the Common Terrain Source contract become roadmap Step 5.

The detailed [player-body and terrain parallel implementation plan](../superpowers/plans/2026-08-21-base-game-player-body-terrain-parallel.md)
allows body presentation to proceed against the Traversal Lab and terrain-source/evaluator modules to
proceed under isolated tests while this gate closes. Streamed terrain must not register into the
authoritative runtime world until the gate passes. The plan reuses Bot Viewer v3's procedural body
and scaling patterns, Environment Viewer v2's local/remote presentation wiring, and Base Game's
existing capsule, coordinates, multiplayer, and `worldQuery.groundProbe()` ownership. Pokémon Park
is comparison evidence only. The sole compatibility extension is a Y-aware procedural-body support
adapter backed by the existing world query; it is not a second terrain or collision API.

### Common terrain-source contract

The implementation order and exact reuse boundaries are recorded in the
[Base Game terrain execution plan](../superpowers/plans/2026-08-21-base-game-terrain-execution.md).
Its first vertical slice uses the existing analytic `terrain-field.js`, the existing
`terrain-system.js` streamer, one necessary heightfield-to-`worldQuery` adapter, and Solo Base Game
ordinary chunks. It also establishes the shared v5 project model and embedded Terrain Studio bridge
early, but live v5 terrain Apply remains gated until the v5 source evaluator exists. Finite maps,
multiplayer terrain authority, caves, and flight-scale visual LOD follow their documented gates.

Base Game will use one capability-based terrain-source interface rather than special-casing each
viewer. It must support:

- `InfiniteRecipeSource`: a Terrain Generator v5 project evaluated at arbitrary global coordinates.
- `FiniteMapSource`: the existing finite GLB plus terrain-data JSON path.
- The current simple analytic infinite source as a test/fallback implementation.
- Authoritative full-detail height and surface-field queries.
- Asynchronous terrain tile and LOD tile requests.
- Optional biome, material, moisture, hole-mask, and hydrology fields.
- Explicit finite bounds or unbounded capability.
- Source and algorithm versions for cache, save, and multiplayer validation.

The complete v5 project JSON is the procedural source artifact. Its exported GLB is a finite baked
map and is never repeated to imitate infinity. Imported heightmaps, existing paint rasters, and
finite GLBs remain world-anchored finite layers or overlays on an otherwise infinite source.

### Heightfield world-query provider (terrain plan Phase 3, shipped 2026-08-22)

`world-query-heightfield-provider.js` — `createHeightfieldWorldQueryProvider(source, { id='terrain', priority, layers, enabled })`
adapts any `terrain-source.js` source to the world-query contract using `collision.js` math.
It declares only `groundProbe` and `resolveCapsule` (never raycast, never a ceiling or wall):
`groundProbe` answers only when the surface is at or below the origin and within `maxDistance`
(the service applies the slope limit); `resolveCapsule` seats the lower sphere on the surface,
removes only the into-surface velocity (jumps survive), reports `grounded` per the slope limit and
one contact `{ point, normal, depth, colliderId: 'key@version', surfaceType: 'terrain' }`.
`acceptsQuery` rejects points outside finite bounds or inside a `holeAt` hole before sampling, so
a bridge deck above or a cave floor below the same X/Z is answered by the mesh provider instead.
`setSource(next)` swaps sampling and identity. `test-world-query-heightfield.mjs` covers rest,
penetration, slope slide, jump preservation, no-hit, probe rules, bounds/holes, composition with a
mesh provider and the real `base-game-player-controller.js` walking/jumping on the analytic source.

### Terrain world mode (terrain plan Phase 4, shipped 2026-08-22)

`base-game-terrain.js` — `createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source, params, useWorker })`
is the runtime owner: a source-injected `terrain-system.js` streamer (chunk 30 m, draw radius 3,
2 builds / 2 unloads per update), the heightfield world-query provider (`id: 'terrain'`), a scene
root translated by `-renderOrigin` (chunk geometry stays global; `worldCoordinates.onRebase` shifts
the root only), debug views (wireframe, `MeshNormalNodeMaterial` normals view, per-chunk
`Box3Helper` tile bounds, a magenta contact marker on the probed ground under the player) and a
`stats` block (source kind/key/version/algorithm/bounds, lod, resident/stale/target/queued/in-flight
tiles, draws, triangles, installs per second, `lastUpdateMs`, epoch, worker, `lastSourceError`,
collision-provider id/enabled/colliderId). `setActive()` switches collision and visuals together;
`setVisible(false)` hides chunks but keeps collision authoritative; `setSource()` swaps the streamed
and collided source with an epoch bump and drops the old chunks immediately (the far LOD shows the new ground; `restream({ drop: false })` keeps the old keep-until-replaced behaviour); `groundHeight(x, z)` is the surface a
body stands on in the current mode (the density surface via `source.surfaceYAt` when volumetric, the
heightfield otherwise) and feeds `spawnPosition(x, z)` and `killPlaneYAt(x, z)` (80 m under it).
`update(globalPosition, dt)` must receive the player's global position.

**Fall-through fix (2026-08-22).** Three causes, all measured in Node: (1) the density surface warps
up to ±`warp_strength_surface` from the heightfield, so a heightfield-based spawn sat inside rock at
~35% of points and a marching-cubes solid has no interior triangles to push a capsule out;
(2) `setVolumetric(true)` disabled the heightfield provider before any volume chunk existed, and a
collider gap of ≥30 frames sinks the player past recovery; (3) `holeAt` tested density 1 m under the
heightfield, which the warp makes "air" at ~40% of points, so the plain heightfield refused ground
there too. Now: `surfaceYAt` exists and drives placement; the switch is a **handoff** — the
heightfield stays live (`handoffPending`) until `volumeProvider.hasChunk()` holds the chunk under the
player, then `update()` flips providers and `takeHandoffCompleted()` reads true once so the page's
`reseatPlayerOnTerrain()` moves the player onto the new surface at the same X/Z (toggle-off reports
immediately); `holeAt` is true only where the density surface lies deeper than the warp can reach.
`test-base-game-terrain-handoff.mjs` covers all three.

In `base-game.html`: `worldMode` gains `terrain` (the only runtime source is
`analyticDescriptor({ key: 'base-game-analytic', sourceVersion: '1' })` until Phase 7);
`worldSpawn()`/`worldKillPlaneY()` pick terrain or Traversal Lab values; changing `worldMode` in
Solo respawns the player; `updateWorld()` drives `setActive/Visible/DrawRadius/…` from settings;
`animate()` calls `terrain.update()` under the `terrain` profiler label before `updateWorld`. New
local settings (all registered): `terrainVisible`, `terrainDrawRadius` (1–32, default 6; the top of the range exists for stress-testing, not for play), `terrainWireframe`,
`terrainNormals`, `terrainTileBounds`, `terrainCollisionDebug`, in a **Terrain world** panel
section with a source readout and a 4 Hz runtime line. The performance `context.world.terrain` is
now `{ project: terrainStore.summary(), runtime: terrain.stats }`. Online, `worldMode` is still
local and the server still simulates the Traversal Lab (Phase 5 is the fix).
`test-base-game-terrain.mjs` covers mode switch, walking/jumping/crossing chunk boundaries with the
real controller, respawn, visual-off collision, rebase (keys and geometry untouched), debug views,
draw radius, source swap and removal without rebuilding the player.

### Terrain authoring and Terrain Studio

**Shipped 2026-08-22 (terrain plan Phase 0A).** `base-game-terrain-studio.js` owns this:

- `createTerrainProjectStore({ applySource, onChange })` — pure. Holds an **active** project and
  an unapplied **draft** (`receiveDraft(raw, origin)` normalizes through `terrain-project-v5.js`
  and hashes; a draft equal to the active hash collapses to "unchanged"), `discardDraft()`,
  `apply()` (the transaction: validate → classify → `applySource(project)` → only then swap
  active; every failure keeps active and reports a precise `message`; with no runtime source
  yet it fails with "terrain-source-v5.js … Phase 7"), `capture()`/`restore()` (full projects
  with hashes, format `pcw-base-game-terrain` v1; restore re-validates and rejects a hash
  mismatch without touching the current state) and `summary()` (hash/version/status only).
- `createBaseGameTerrainStudio({ store, editorUrl, onOpen, onClose })` — a `z-index:1100`
  full-screen overlay with a top bar and a lazily created same-origin `<iframe>` of
  `terrain-generator-v5.html`, driven by `createBridgeHost`. `show()` re-sends the draft (or
  active, or `null`) project every time; an editor Apply becomes a draft and closes the screen;
  editor Cancel just closes. Status values: `unchanged`, `draft`, `validating`, `rebuilding`,
  `active`, `failed`.

In `base-game.html` the store and studio are created before the start menu, so **Terrain
Studio** is a button on the start menu and on the pause menu (`base-game-menu.mjs` gained
`onTerrainStudio` on both). The Terrain panel section shows the active/draft identity (name,
version, algorithm, hash, kind, runtime status), the status message and **Open Terrain
Studio** / **Apply draft** / **Discard draft**. Opening sets `gameplayPaused`, disables orbit
controls, clears input and releases pointer lock (guarded by `simulationReady` when opened
from the start menu); `animate()` skips `renderer.render` while the studio is open but still
advances online lockstep with neutral input; closing resumes or returns to the pause menu
depending on what was open before. `captureAllState()` embeds `terrain: store.capture()`,
`applyAllState()` restores it, and the performance `context.world.terrain.project` carries
`store.summary()`. Escape is ignored while the studio owns the screen.

**Phase 7 (2026-08-22):** Apply now works at runtime. `terrainStore` is created with
`applySource: applyTerrainProjectAtRuntime(project)`, which builds `v5Descriptor(project)`,
constructs the candidate source and synchronously generates the tile under the player (proving the
recipe evaluates) before `terrain.setSource(descriptor)` bumps the epoch; it then forces
`worldMode = 'terrain'`, keeps the player's global position unless the new ground is more than
3 m away (then respawns at that X/Z), and updates the source readout. After a state load,
`syncTerrainSourceFromStore()` re-applies an active project whose descriptor is not the one being
streamed. The Terrain panel gained **Make draft streamable**
(`migrateProjectToUnbounded(draft, { dropBoundedData: true })`). The embedded editor defaults new
work to the unbounded algorithm, so drafts from Terrain Studio are normally streamable; a bounded
draft fails Apply with the precise reason. Runtime height is the pre-erosion stack height (erosion,
hydrology and masks are preview-only; the status line names them).

**Phase 8 (2026-08-22) — streamed volumetric terrain.** `base-game-terrain.js` takes a
`volumetric` option / `setVolumetric(v)`: the streamer requests the `volume` tile field (marching
cubes from the v5 project's `density` config — surface warp, caves, overhangs), chunk meshes are
built from it, and collision moves from the heightfield provider to
`world-query-chunk-mesh-provider.js` (`id: 'terrain-volume'`, one BVH per resident chunk, synced
in `update()` as chunks install/unload; the heightfield provider is disabled meanwhile). The kill
plane drops to `density.y_min − 10` so cave floors are not a death zone; `stats.volumetric` and
`stats.collisionProvider` report the mode. In `base-game.html` the **Volumetric (caves from the
v5 density config)** toggle (`terrainVolumetric`, default off) drives it from `updateWorld()`;
it only engages when the streamed source has `densityAt` (an applied v5 project — the analytic
default has no density), and the runtime line says so otherwise. Apply's candidate tile includes
the volume when the toggle is on. Vertical sample spacing is 2× the XZ step (2.5 m at the default
chunk), so passages thinner than that do not survive; `VOLUME_Y_SPACING_MULT` is the knob.

**Phase 5 (2026-08-22) — room-owned terrain (protocol 4).**
`base-game-protocol.mjs` gained `sanitizeBaseGameTerrainConfig(input)` → `{ config, error }` where
config is `{ kind: 'traversalLab', worldVersion }` or `{ kind: 'terrain', descriptor, projectHash,
worldVersion }`: the descriptor is re-normalized, a v5 project is re-normalized, re-classified
(must be `runtimeSupported`) and re-hashed server-side, `volumetric` is refused (Solo-only until
the server streams chunk meshes), `finite-map` is refused, and the JSON is capped at 512 KB.
`describeBaseGameTerrainConfig` is the identity-only form in snapshots.
- `base:create` carries `terrain` (the creator's current ground: `pickRoomTerrainConfig()` in
  `base-game.html` — `traversalLab` unless `worldMode === 'terrain'`, in which case the active
  descriptor, analytic or v5); invalid terrain fails with `invalid_terrain` and no room is made.
- `base:joined` carries the room's full sanitized config once; snapshots carry
  `worldVersion` + `terrain` identity. `base-game-session.mjs` exposes it as `session.terrain`.
- `server/base-game-rooms.js` now owns a world **per room** (`room.terrain`, `room.sim`), built
  by `worldFactory(config)` and cached by `worldVersion` so rooms on the same descriptor share one
  immutable instance; terrain rooms use the same pure source + `world-query-heightfield-provider`
  Solo uses (the heightfield is infinite, nothing streams server-side), spawn at
  `heightAt(0,0)+1.5`, and a surface-relative kill plane (`killPlaneYAt`). `step()` only runs rooms
  whose world is resident. `warmTraversalLab()` pre-builds the lab at server start.
- Client: `adoptRoomTerrain(config)` re-sanitizes the joined config, compares `worldVersion`
  (mismatch → handshake fails and the client returns to the menu rather than predicting on
  substitute ground), `terrain.setSource()`s it, forces `worldMode`, and `worldMode` /
  `terrainVolumetric` controls are disabled while online. Apply draft refuses while online.
- `test-base-game-rooms-terrain.mjs`: sanitizer cases, three rooms with distinct worlds and
  spawns, shared instance for an equal descriptor, deterministic rejection, server vs predicted
  client agree to 0 m over 960 ticks across a tile seam with jumps, resume returns the same
  config, surface-relative kill plane, session sends `terrain` on create.

**Owner-controlled worlds + volumetric rooms (2026-08-22, protocol 5).** The room owner picks the
world for everyone, at any time; guests follow and cannot change it.
- `base:set_terrain { terrain }` (owner only, else `not_owner`): the server sanitizes the config,
  builds the world through the same per-version cache (`buildWorld`), then atomically swaps
  `room.terrain`/`room.sim`, re-creates every controller at the new spawn, bumps `revision` and
  `spawnRevision`, requests a resync, and broadcasts `base:terrain { terrain }` (full config) followed
  by a snapshot. An identical config is just echoed; `invalid_terrain`/`world_failed` leave the room
  untouched. A later request supersedes an in-flight build (`room.terrainRequest`).
- `sanitizeBaseGameTerrainConfig` now accepts `volumetric: true` for v5 descriptors (world version
  gets a `:volume` suffix; `describe…` carries the flag). Volumetric rooms collide on the server
  against the same lod-0 marching-cubes tiles the clients stream: `terrain-volume-collision.js`
  (`createVolumeCollision(source, { worldQuery })`) builds a 3×3 ring around each player
  synchronously (`coverRadius` 1, `maxBuildsPerCall` 4 per tick, `keepRadius` 3 then pruned; same
  `chunkSize` 30 / `volumeChunkIntervals` as `terrain-system.js`). `stepRoom` calls
  `sim.prepare(positions)` before stepping and holds any player whose chunk is not collidable yet.
  Spawn is `surfaceYAt(0,0)+1.5`; the kill plane is `min(surface−80, y_min−10)`.
- `base-game-session.mjs`: `setTerrain(config)` (owner) resolves with the echoed config;
  `onTerrain(config)` fires for everyone; `session.terrain` tracks it.
- `base-game.html`: `worldMode`/`terrainVolumetric`/Apply draft stay enabled for the owner online and
  route through `requestRoomTerrain()` / `applySource → setTerrain`; guests' are disabled and snap
  back to `session.terrain` if touched. `receiveRoomTerrain` → `adoptRoomTerrain` (now honours
  `volumetric`) for every client; the server's next snapshot hard-snaps the respawn.
- `test-base-game-rooms-terrain.mjs` [5]–[7]: session request/echo/reject; owner switch (guest
  refused, full config to all, respawn + resync, echo on identical, refusal leaves the world, back to
  the lab); volumetric room (spawn on the density surface, ring built player-first, 720 ticks across
  a seam with server and predicted client agreeing to 0 m, bounded footprint, kill plane).

**Asset keys (2026-08-22, protocol 6).** Projects travel once. `server/terrain-store.js`
(`createTerrainStore({ dir })`) is a content-addressed store of streamable v5 projects (normalized,
classified, hashed; 512 KB cap; LRU at 512 entries) mirrored to `server/terrain-store/<hash>.json`
and reloaded at relay start. Messages: `base:terrain_put { project }` → `base:terrain_ref
{ projectHash }` (idempotent); `base:terrain_get { projectHash }` → `base:terrain_project
{ projectHash, project }` or `unknown_terrain`. `sanitizeBaseGameTerrainConfig(input,
{ resolveProject })` accepts a v5 descriptor whose `config` is just `{ projectHash }` and resolves it
through the store (inline bodies are still accepted and stored). `publicBaseGameTerrainConfig`
strips bodies for `base:joined` / `base:terrain` (a joined packet is ~750 bytes instead of the
project size); `terrainConfigNeedsProject` / `terrainConfigProjectHash` / `withTerrainProject` are
the client-side helpers. `base-game-session.mjs` publishes before `base:create` / `setTerrain`,
keeps a per-session project cache, and fetches any body it lacks before resolving the join or firing
`onTerrain`, so the page always sees full configs. `test-base-game-rooms-terrain.mjs` [8].

**Phase 9 (2026-08-22) — far LOD.** `createBaseGameTerrain({ farLod, params.farLodLevels 6 })` /
`setFarLod(bool)` lazily builds a `terrain-clipmap.js` under the chunk root (so it shares
−renderOrigin) from the same source, re-sources it on `setSource`, keeps its ring-0 hole on the
resident chunk square (`chunkWindowRect()`), and exposes `farExtent` (outer half-extent) and a
`stats.farLod` block. `base-game.html`: `terrainFarLod` toggle (default on) in the Terrain world
panel; `updateWorld()` pushes `camera.far` to 1.5× the far extent (9.2 km at the defaults) and back
to 600 m when off; the runtime line reports rings/coverage/tris/in-flight/ms.
`test-terrain-clipmap.mjs`: band limit (exact lod 0, fine layers gone at coarse spacing), toroidal
window correctness and eviction, 400-focus ring/hole/window containment (no gaps, no swimming),
constant triangle count over a 2 km run, source swap, and the Base Game fixture (visual only —
ground probes return the exact height while the ring's own height differs by metres; rebasing is a
translation).

**Volumetric far LOD (2026-08-23).** Volumetric is the primary ground, so in volumetric mode far
LOD is a **marching-cubes cascade**, not the heightfield rings (those showed a step and a gap
against the warped volume surface): `BASE_GAME_TERRAIN_DEFAULTS.volumeLod` = three extra
`createTerrainSystem`s on the same source with `segmentsPerChunk: 24`, `lod: 1..3`, `volumetric:
true` — chunks of 120 / 480 / 1920 m (spacing 5 / 20 / 80 m), radius 2 each (half-extents 300 m,
1.2 km, 4.8 km), `yBias` 0 since 2026-08-23 (the −1.5 / −6 / −24 m sink that kept coarse levels
under finer ones made far mountains read up to 24 m lower than they are). Cracks at level
boundaries are closed by chunked-LOD skirts instead: every volume tile at lod ≥ 1 hangs a strip
(`max(4, spacing·0.2 + 8)` m) from its border's open-sky surface contour (`addBorderSkirts` in
`terrain-source-v5.js`); cave contours on the border are recognised by each border column's
topmost air→rock crossing and left open so cave mouths are never curtained. Exact lod-0 tiles get 6 m skirts too (their window edge cracked against the cascade), but `volume.skirtIndexStart` marks where skirt triangles begin and `collisionGeometry()` slices the collider input there, so client and server BVHs are exactly the skirtless triangles (`skirtDepth: 0` in `terrain-volume-collision.js`). Shore/crest foam fades out over 800–2500 m (`foamFade`) so the far cascade's coarse shorelines carry no giant foam rims. The density is band-limited per level
(`createDensityPoint(..., spacing)`: warp and cave octaves finer than ~4 samples per period fade
out), so cave mouths survive as far as their size allows (test: 39/400 cave columns at 5 m vs
149/400 exact). Cascade chunks share the chunk material/tint, never enter the volume provider, and
follow `setSource`. `stats.farLod.kind` is `'volume-cascade'` or `'clipmap'`; `farExtent` is 4.8 km.
Both representations are kept once built; `setVolumetric` switches which one is live.
Volumetric is the **default** (`terrainVolumetric: true`; the analytic start source has no density,
so the first v5 Apply switches it on). `terrain-system.js` now runs a pool of `min(4, cores−2)`
workers behind one round-robin `worker` facade (`params.workerCount`), so a full restream at a wide
draw radius takes seconds, not minutes; while it runs, stale heightfield chunks are hidden and the
cascade's 5 m level shows through rather than drawing the wrong ground.

**Ground textures (2026-08-23).** `terrain-splat-streamed.js` (see `terrain.md`) replaces the
vertex tint on chunks and the cascade: `terrain.setSplatMaterial(mat)` / `setSplatEnabled(bool)`,
`stats.textures` = `'tint' | 'streamed-splat' | 'off'`. **LOD dissolve (2026-08-23, replaces the rectangle holes):** every streamer (exact chunks + each cascade level) owns a `terrain-lod-coverage.js` map — one texel per chunk around the player holding how present that chunk is, ramping 0→1 over 0.4 s after it lands and back down when it unloads — and its own splat instance bound to its map (`self`) and the next finer level's (`finer`). The fades are staggered on one stable world-space dither: a level dissolves IN over the first half of its own ramp and the coarser level under it dissolves OUT over the second half, so the finer surface is fully present before the coarser one starts leaving (2026-08-23 fix: fading both at once opened the void, since the two surfaces do not share screen pixels; unloads now snap coverage to 0 because the mesh is already gone). Ramp 0.6 s. The coarser level dissolves against the finer map's ERODED texture (3×3 min, `erodedTexture` in `terrain-lod-coverage.js`): it keeps drawing one full chunk of overlap into the finer region and the z-buffer sorts the two surfaces — a hard cut at the coverage boundary bit chunk-sized holes out of the coarse silhouette wherever it stood higher than the fine ground (seen as water/sky slivers along the window edges). `updateCoverage()` runs per frame but rebuilds the present-key sets (which iterate every resident chunk — 4,400 at draw radius 32) only when residency changed, a window recentred, or a ramp is still `animating`; a source swap clears the maps. The last cascade level's map skips its eroded texture (no coarser consumer). The 2026-08-23 improve-webgpu audit also gave the sea-depth window a full-window early-out, the water module a `setLevel` no-op on equal level, and the page an `applyWaterSettings()` dirty-check so the per-frame wave-options object is only built when a water key moved. Note for reading captures: `renderer.info` counts each visible chunk in a BatchedMesh multi-draw as one draw call — the radius-32 capture's 1,121 'draws' is 18 actual terrain batches (`stats.batches`, 0 fallbacks). `setSplatMaterial(mat, textures)` builds the instances; `updateSplat(patch)` tunes them all; `lodCoverage` / `cascadeMaterialFor(i)` expose them (0 = exact). Resident chunks (and each cascade level) draw through `terrain-chunk-batches.js` pools — `stats.draws` counts batches, `stats.batches` carries the pool stats; a chunk's own mesh is hidden while batched and is the fallback when a pool is full (measured: over 1,000 draws at draw radius 32 before). Volume colliders exist only within `collisionRadius` (2) chunks of the player (`colliderFocus`, re-synced when the player's chunk changes): a BVH per resident chunk at draw radius 16 was 1.4 M triangles built on the main thread as tiles landed — the frame spikes in the 2026-08-23 captures. `base-game.html` loads the maps once in the
background (tint shows until they arrive) and exposes `terrainTextures` (on), `terrainTextureTile`
(4 m) and `terrainTextureFade` (1400 m) in the Terrain world panel. The far fade is what keeps the
horizon from shimmering; the flight sim's height band limit is the same idea one level down.

Not yet: finite GLB maps (Phase 6); textures driven by streamed v5 biome/material masks instead of
height/slope; soil-shade/moss dressing; no distance fog; the classic (v4 climate) layer is not
band-limited; the tint-only fallback (before textures load) has no LOD hole, so a coarse level can
poke through a fine one there. Server volume tiles are built on the
tick thread (~40 ms each), so a crowd spreading into fresh chunks will stall ticks; a worker pool is
the follow-up if that shows.

Base Game hosts the actual Terrain Generator v5 interface as a full-screen Terrain Studio screen
reachable from the start and pause menus. It does not recreate a second set of v5 sliders. The
standalone and embedded editors share one renderer-free project normalizer/serializer so `cfg`,
`density`, layer stack, paint data, imports, project version, algorithm version, and content hash
round-trip identically.

Opening Terrain Studio pauses simulation, releases pointer lock, and suspends the Base Game world
render while the editor preview is active. Edits remain a draft until Apply. Solo Apply validates a
candidate source and spawn tile first, then changes source epoch and replaces chunks under bounded
budgets without removing complete old chunks. The player keeps the same global position when it is
still supported; otherwise the established safe-spawn path handles the source change.

State files embed the complete normalized project so every configured parameter is loadable.
Performance records store the project identity/hash and a compact configuration summary rather than
duplicating paint/import payloads on every capture. Local export and hosted publishing add a sibling
`-project.json` artifact to the existing map artifact set. Multiplayer rooms reference that published
asset by validated key and hash; changing terrain requires an explicit room restart/resync rather
than accepting or applying an arbitrary client project blob during play.

### Infinite Terrain Generator v5 evaluation

Refactor the v5 layer pipeline around point and arbitrary-tile evaluation while retaining the
current finite generator preview as an adapter. Tile requests include global origin, sample spacing,
resolution, and an apron/halo.

Directly infinite-compatible operations include fBm, ridged, billow, Voronoi, domain warp,
terracing, constants, layer masks, and blend operations. Slope, normals, local masks, and thermal
erosion are evaluated with the required neighboring samples and the interior is cropped from the
halo.

The inherited classic terrain sampler is not infinite as written: it clamps against a fixed
1,200-unit lattice. It must use an unbounded coordinate-hashed lattice before classic terrain and
climate fields can participate in the infinite source. Current hydraulic flow, lake discovery,
paint rasters, imports, and finite volumetric export are not mislabeled as directly streamable.

Initial success requires:

- Identical samples along adjacent tile borders.
- Results independent of tile generation order.
- Identical output after reloading the same recipe, seed, and algorithm version.
- Finite preview and infinite tile agreement over the same compatible coordinates.
- CPU collision and rendered surface agreement.

### Terrain streaming

Workers are initialized once with the normalized recipe and source epoch. Individual jobs contain
only tile identity and sampling information. They return transferable height, surface, biome, and
material arrays. Requests are nearest-first, cancellable before expensive work, and protected by
epoch so stale results cannot replace newer terrain.

Old complete terrain remains visible until a replacement tile is ready. Generation does not occur
inside the frame loop, and camera movement does not synchronously rebuild terrain, decoration, or
collision structures. Ordinary chunk rendering keeps per-chunk frustum culling enabled.

### Flight-scale terrain LOD

The flight demo's geometric clipmap establishes the large-world reference: a small fixed set of
camera-following rings increases cell size with distance. Base Game must preserve the same bounded
render cost while allowing a v5-authored source instead of requiring the flight demo's analytic
wave field.

Mesh LOD alone is insufficient. Every authoritative terrain tile produces a prefiltered height and
field pyramid. Coarser rings sample coarser height, material, biome, moisture, water, and terrain-hole
data so high-frequency detail cannot alias into false distant landforms. Procedural layers may fade
octaves from sample spacing; carved, painted, imported, or otherwise sampled data uses reduced tile
levels. Physics and nearby interactions continue using authoritative local detail rather than the
far visual LOD.

Terrain generation and rendering remain separate. Ordinary culled chunks are the initial
correctness renderer. A streamed height-atlas clipmap or corrected GPU CDLOD renderer can consume
the same tile pyramid for walking and flight. A coarse horizon shell may extend visual land beyond
the detailed outer ring without becoming authoritative collision terrain.

Flight-scale success requires:

- Approximately constant terrain draw/triangle cost while travelling.
- No cracks or topology changes at ring/LOD transitions.
- No distant moire, swimming, or high-frequency flicker.
- Stable global positions and visuals after render-origin rebasing.
- Full-detail collision close to relevant players and aircraft.

### Three-dimensional world representation

The world is hybrid rather than wholly volumetric:

| Component | Authoritative representation |
|---|---|
| Open outdoor ground | Infinite 2.5D heightfield |
| Rivers | Hydrology modification of that heightfield plus water fields |
| Cave entrances | Terrain hole/cutout mask plus separate entrance geometry |
| Cave interiors | Streamed 3D mesh or volumetric chunks with 3D collision |
| Buildings, bridges, and platforms | 3D meshes and spatially indexed collision |
| Doors and moving platforms | Dynamic colliders |
| Distant structures | HLOD/impostors without distant collision |

The fast `heightAt(x, z)` query remains useful for outdoor generation, broad-phase tests, and
flight terrain avoidance. It is not the universal definition of solid world space.

Before the player, provide a unified world-query service with three-dimensional inputs:

- Raycast and multi-hit raycast.
- Capsule/shape sweep and overlap.
- Point-contents or inside/outside query where supported.
- Ground probe returning the first suitable surface below a 3D origin.
- Nearest-surface query.
- Collision masks and source/entity identity.

Hits include position, normal, material/surface type, walkability, collider/entity ID, and velocity
for moving surfaces. A ground probe may return outdoor terrain, a cave floor, a bridge, a building
floor, or a moving platform. The existing mesh-BVH map collision is the starting point for static
3D solids; the current height-only ground contact remains an optimized terrain provider behind the
unified service.

Caves cannot be represented by lowering a heightfield because a heightfield has only one Y value
per X/Z. A traversable cave therefore requires a near-field terrain cutout, separate interior mesh
or density chunks, 3D collider lifecycle, and explicit portals between streamed cells. Far terrain
LODs may simplify or close entrances that are too small to see, while the near authoritative LOD
must preserve them.

The Traversal Lab establishes these three-dimensional query requirements before terrain. When real
terrain arrives, an additional integration scene adds outdoor ground and a terrain-cut cave entrance
to the existing tunnel, stacked-floor, ramp, and bridge cases. The existing player must traverse the
combined scene without changing its world-query contract.

### Terrain integration gate

After the Traversal Lab player passes, the infinite terrain source registers its heightfield as an
optimized provider behind the same world-query service. The player and camera continue using global
3D positions and do not begin calling terrain height directly for general movement. Camera
obstruction, footsteps, projectiles, use interaction, and future navigation consume the same
collision/source identities whether a hit came from analytic terrain, a streamed terrain tile, a
cave, a building, or a dynamic platform.

This integration gate occurs after the player foundation and terrain but before water, plants, or
creatures. Its success condition is that terrain can be enabled, disabled, or replaced by the
Traversal Lab live without rebuilding the player controller or changing the meaning of a collision
query. It prevents later systems from embedding a second incompatible definition of ground or
traversability.

### Regional erosion and hydrology

The reference river system in `research/fable5-world-demo-main.zip` is MIT-licensed and computes
hydrology once over one bounded 4,096 m domain. Its order is designed-channel enforcement,
multigrid depression fill, continuous particle flow tracing, atomic accumulation, separate terrain
carve and visible-water thresholds, river carving, hardness-aware talus relaxation, and moisture
derivation. It mutates the terrain and emits water elevation, flow strength/direction, river/lake
depth, and moisture for downstream rendering and ecology.

Base Game first adapts this pipeline as one bounded reference region to establish correctness and
measure cost. It is not then run independently on visible terrain chunks: doing so would make every
chunk border an artificial watershed boundary.

Infinite hydrology uses persistent watershed regions that are much larger than render chunks. A
coarse deterministic parent drainage solution supplies watershed identity, outlets, boundary water
levels, major-river connections, and authored valley/spline crossings. Each detailed region is
generated with a halo, publishes only its central area, and becomes immutable under a specific
recipe/seed/algorithm version. Designed channels are enforced before depression fill so required
rivers survive erosion deposits and cross region boundaries intentionally.

Hydrology produces the authoritative carved terrain before final slope, biome, material, and flora
classification. The order is:

`base terrain -> erosion/hydrology/carving -> slopes and masks -> biomes/materials -> flora`

Region generation is prefetched, cached, concurrency-limited, and performed during loading or under
an explicit background budget. The multi-million-particle reference pass is never launched casually
because the camera crossed a render-chunk boundary. Multiplayer shares seed, recipe, algorithm
version, and region hashes/manifests; a normal room server is not required to own a GPU.

Hydrology success requires continuous river elevation, width, and direction across region borders;
generation-order independence; stable published regions; level lakes; no valley-wide water sheets;
and no gameplay-frame stalls from generation or cache installation.

### Water, rapids, and waterfalls

**Shipped water (plan `docs/superpowers/plans/2026-08-23-base-game-water.md`).** W1 (2026-08-23):
sea level is a terrain-source descriptor field (`descriptor.seaLevel`, see `terrain.md`): a v5
project fills it from its authored `cfg.sea_level`, the analytic source takes the page's
`terrainSeaLevel` slider (−120..120, room-owned online, rebuilt into `activeTerrainDescriptor` by
`applyLocalSeaLevel()`; with a v5 project active the slider shows the project's value and snaps back).
`base-game-terrain.js` exposes `seaLevel` / `setSeaLevel(level)`: the vertex-tint height bands sit on it
(chunks and batches recolour on change), `spawnPosition()` lands on `max(ground, seaLevel) + clearance`,
and `setSource` takes the new descriptor's value. The server world does the same (`sim.seaLevel`,
spawn above the water). The wave spectrum (`waveCount … waveSeed`, the `water-waves.js`
`buildWaveTable` inputs) lives in the Water panel section as shared world keys, so the room owner
tunes it and every peer simulates the same surface; `waveOptionsFromWorld(world)` maps them back
to table options. W2 (2026-08-23): the facade owns a `terrain-sea-depth.js` map (`terrain.seaDepth`, streamed only while `setSeaDepthActive(true)`, recentred on the player each `update`, restarted by `setSource`) that the water surface will read for thickness and the page for the visibility gate. W3 (2026-08-23): `base-game-water.js` renders the surface (`water` in the page: created after the sky, `setEnabled(waterEnabled && terrain mode)` / `setLevel(terrain.seaLevel)` / `setWaves(waveOptionsFromWorld(settings))` in `updateWorld`, `update(dt, camera.position)` in the frame loop under the `water` profiler slot). Its look loads from `water-config.json`'s `ocean` body, then the room's wave keys are re-applied so physics-relevant values never come from the file. The mesh hides while the depth window holds no ground below sea level (`water.state.reason`). W4 (2026-08-23): shoreline and refraction are per pixel — `thicknessAt` reads the opaque depth buffer (`viewportDepthTexture`, the water writes no depth) so the water ends exactly where the drawn ground rises through it and the shore foam sits on the real contact line; `bedColorAt` refracts the framebuffer (`viewportSharedTexture`) by the wave normal, scaled down in the shallows so dry pixels are never pulled in; `shallowFade` (2.5 m) in `createOceanSurface` ramps the displacement to zero at the beach so crests run out flat instead of rising through the sand. The 16 m window now serves only the vertex-stage damping and the visibility gate. Unverified: both viewport nodes inside the DOF `pass()` path. W5 (2026-08-23): reflection modes on `profile.reflMode` (`waterReflection` select: `sky` dome only, `planar` default, `ssr`). Planar is a TSL `reflector()` (own mirror camera, half-res target, uv rippled by the wave normal) whose `updateBefore` is wrapped the water.js way: one pass per application frame, every `reflectRate` (2) frames, only while the surface is visible and the camera is above the displaced surface, with the water mesh (and `excludeFromReflection()` objects) hidden for the mirror render; `water.reflectStats` counts passes/skips/ms. SSR is the demo's 32-step view-space march ported to the opaque depth buffer and framebuffer (`viewportDepthTexture`/`viewportSharedTexture`), edge-faded, falling back to the sky. Unverified in the browser: a camera-attached first-person weapon may appear in the mirror (nothing is excluded yet). W6 (2026-08-23): the ground material carries the water — `createStreamedSplatMaterial(..., { water })` takes the water module's `groundShade` bundle (scene-space waterline, global-xz offset, sun, clock, caustic strength/spread uniforms, `waveNormalFold`); every instance gets a wet tide band (darker albedo, roughness 0.22, waterline → +0.6 m) and the water-demo's analytic Snell caustic as `emissiveNode` (sun ray refracted at the flat surface with the live wave normal, screen-derivative area ratio, depth fade, sun-elevation gate). `terrain.setSplatWater(shade)` rebuilds the instances with it; disabling the water sinks `sceneLevel` to −1e9 so both parts vanish without a rebuild; `waterCaustics` toggle → `setCausticStrength`. W7 (2026-08-23): underwater. The surface is `DoubleSide` so it exists when seen from below; a clip-space overlay quad (`fogQuad`, renderOrder 998, depth-test off) tints and fogs the frame by scene depth — `1 - exp(-viewDistance · fogDensity)` capped at `fogMax`, coloured from the profile's deep colour — shown only while `water.underwater` (camera below the displaced surface, from the CPU wave sampler). A scene-wide `fogNode` was avoided: it would recompile every material on each dive. `environment-audio.js` gained a master low-pass (`setUnderwater(on)`, 620 Hz submerged / 20 kHz bypassed) that the page toggles on the state change. Toggle: `waterUnderwaterFog`. Swimming (W8) is next; the camera can still walk the seabed. (`tsl-build-check.mjs` gained `getCanvasTarget`/`getDrawingBufferSize` stubs for the viewport nodes.) Tests: `test-base-game-sea-level.mjs`, `test-terrain-sea-depth.mjs`, `test-base-game-water.mjs`.

The reference water renderer uses six camera-following clipmap grids sampling the shared hydrology
fields. Dry samples are moved below the bed, so adding rivers does not create a mesh or draw call per
river. Initial Base Game water follows this arrangement with near/far water fields, flow-advected
ripples, depth absorption, shoreline opacity/foam, optional refraction, and optional SSR.

The reference does not contain true falling waterfall sheets. Its waterfall look is an emergent
steep carved chute: standing water is removed on the steepest reach, and rapid foam is driven by
downstream water-surface drop plus flow speed on suitable wet reaches. Base Game implements and
tests that behavior first. Actual vertical sheets, plunge-pool foam, mist, spray, audio, and their
own culling/LOD are a separate later extension triggered from sufficiently tall river drops.

Water success requires a nearly fixed small draw count independent of river count; invisible
clipmap boundaries; dry gullies without water sheets; calm large rivers without automatic foam;
rapid foam at local drops; and no vertical or diagonal standing-water walls.

### Isolation, persistence, and measurement requirements

Every introduced component is controlled live in the game UI, included in `DEFAULT_SETTINGS`,
round-tripped by state files, and recorded in performance captures. The terrain/world phases must
ultimately expose at least:

- Base terrain, thermal erosion, regional hydrology, river carving, lakes, and moisture.
- Terrain renderer/LOD mode, draw distance, tile resolution, and debug region/LOD boundaries.
- Terrain holes, cave/interior rendering, static solids, and collision debug visualization.
- Water surface, near/far rings, ripples, absorption, refraction, SSR, shore foam, rapid foam, and
  later true-waterfall effects.
- Flow direction, flow accumulation, wet mask, water elevation, and moisture debug overlays.

Performance records add terrain and hydrology generation times, worker queue depth, resident tile
and region counts, cache hits/misses, water draw/triangle counts, and render-origin information. Each
major phase stops for a controlled performance comparison before the next phase begins.
