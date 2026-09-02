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
| Overhead cloud decks | `clouds.js` / `Clouds` |
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
| Hitscan and shot validation | `combat.js` |
| Semantic player pose, hurt-rig math and rewind history | `player-body-pose.js` / `player-hit-rig.js` |
| Shared humanoid topology and body-model whitelist | `humanoid-rig-topology.js` / `base-game-body-models.js` |
| Player hp / alive / revive | `player-combat.js` |
| Magazines (lifted from `environment-viewer.html`) | `player-ammo.js` |
| Dispersion cone | `bot-aim.js` |
| Projectile flight and blast falloff | `bot-projectiles.js` / `entity-types/explosion.js` |
| Tracers, muzzle flash, sparks, explosions | `effect-renderer.js` / `tracer-visual.js` |
| Blast debris | `blast-debris-sim.js` / `blast-debris.js` / `explosion-tier.js` |
| Dynamic flash lights | `flash-lights.js` (extracted from `bot-viewer-visuals.js`) |
| Weapon flashlight | `weapon-light.js` |
| Weapon laser sight | `weapon-laser.js` |
| Procedural weapon handling voices (reload, draw) | `weapon-sfx-synth.js` |
| Drone autonomy, manual flight, wire state | `base-game-drones.js` on `bot-drones.js` + `flight-model.js` |
| Drone meshes, pose, chase camera | `base-game-drone-view.js` on `flight-meshes.js` |
| Ground-vehicle autonomy, seats and wire state | `base-game-vehicles.js` on `city-vehicle-model.js` |

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
1b. Hold the frame if the **frame cap** says it is early — see below. The order matters: the
   busy check comes first, so a frame held by the cap is never counted as a dropped one.
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

Two shadow knobs in the Lighting section (2026-08-30), both local: **Shadow map update** (every 1–8
frames; above 1 the page sets `rig.dirLight.shadow.autoUpdate = false` and flips `needsUpdate` on
the frame's turn, which the `ShadowNode` honours; the map is then up to N−1 frames stale while you
move) and **Shadow filter** (`soft` = `PCFSoftShadowMap`, the default; `pcf`; `basic`). The filter
type is part of every material's cache key, so changing it rebuilds the pipelines once, like the
flashlight-shadow toggle does. The sun's shadow camera also enables
`BASE_GAME_FOREST_SHADOW_LAYER` (4) so the forest's shadow-only meshes reach the map — see
`docs/subsystems/vegetation.md`, "Shadows come from a shadow list".

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
  lower-body rig), diagnostic capsule, semantic hurt rig/zone/joint/last-hit overlays, movement,
  jump, gravity, slope, step-up, snap-down, camera
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
- Sky: entire group, dome, sun disc, moon disc, stars, Milky Way, additional bodies. Two nested
  sections (2026-08-27) expose the generator: "Stellar generation" carries `skySeed` (+
  a Reroll button), `skyPlanetCount`, `skyMoonCount`, `skyBodyScale` and the `skyMilkyWay` flag —
  all shared world keys, all wired commit-on-release (`addCommitRange`) because they rebuild the
  sky; "Sky appearance" carries the live star count/brightness/color, Milky Way brightness,
  and sun/moon disc color/size/opacity sliders (uniform, draw-range, or canvas-repaint writes — no
  rebuild), plus the commit-class `skyMilkyWayDensity`. `skyBodyResolution` sits at the section
  foot labeled as a bake-cost knob (the per-body canvas is clamped 96–2048 px, paid per rebuild).
  `applySkySettings()` in `updateWorld` diffs applied-vs-current so a 20 Hz snapshot restating the
  same world never triggers a rebuild; when any rebuild-class key moved it issues ONE
  `sky.setPalette(skyPaletteOverrides())`. The palette passes `bodies: true` so turning the shared
  Milky Way off does not delete the planets.
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
separate version-10 protocol handled by `server/base-game-rooms.js`:

- Client: `base:create`, `base:join`, `base:resume`, `base:set_world`, terrain messages,
  `base:input`, `base:loadout`, `base:set_body`, `base:respawn`, and `base:resync`.
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

Protocol version 10 replicates players. Roster entries carry `id`, `connected`, `owner`,
`spawnRevision`, `tick`, `lastProcessedTick`, `queueDepth`, `lastInputClientTime`, global
`position`, `velocity`, `yaw`, `pitch`, `grounded`, combat/loadout state, `bodyModel`, the
server-selected `hitProfile`, and `poseEpoch`. Clients send only numbered tick inputs;
there is no position message. The implementation state is recorded under roadmap Step 4 below.

Shared world keys are `primaryBody`, all `tod*` clock/astronomy values, manual sun elevation and
azimuth, sun/ambient intensity, and (2026-08-27) the stellar generation keys `skySeed`,
`skyPlanetCount`, `skyMoonCount`, `skyBodyScale`, `skyMilkyWay` — the planets are landmarks, so what
is up there is the room's; how a client draws stars and discs stays local. Guests see these controls
disabled. Camera state, panel/UI, save slots, sky-part visibility, light-part visibility, and
shadows remain local so every client can isolate rendering components without changing the world for
others. Loading a state as room owner
publishes its shared values through the server; loading as a guest applies only local values.

## Server-authoritative player hurt rig (protocol 10)

Player world traversal still uses the 1.8 m kinematic capsule. Damage no longer does. The room
server derives a renderer-free 16-joint humanoid pose from each authoritative 120 Hz movement tick
and resolves players against 18 semantic head/torso/limb capsules. This fixes both the inherent
phantom volume between limbs and the old conversion bug that sent total capsule height to a ray
function expecting straight-segment height.

The live pose stores a global root plus Float32 root-relative joint offsets, so stacked players and
flight-scale coordinates remain distinct. Each player has a 32-slot preallocated rewind ring;
100 ms lag compensation interpolates only inside the same model profile and pose epoch. Respawn,
world replacement and model/profile changes start a new epoch. Hitscan and melee use rewound rigs,
projectiles sweep current rigs with projectile-radius inflation, and explosion falloff measures to
the nearest rig surface. Creatures and mobs retain their existing capsule path.

`base-game-body-models.js` is the whitelist. A client requests only `bodyModel`; the server chooses
`hitProfile` and accepts no joint positions or dimensions. All current designs share the canonical
`humanoid-default` profile pending the measured model corpus. Hit events carry `zone`, `side`, and
the compatibility `head` flag; damage remains flat.

The Player panel exposes the authoritative hurt rig, semantic zone colors, joint points and last
server impact independently of the movement capsule. These are live controls and state/performance
capture settings. The diagnostic uses `player-body-pose.js` and `player-hit-rig-debug.js`, not mesh
bounds. The rich procedural render gait is still a separate stateful solve; visual endpoint parity
is therefore an explicit remaining acceptance gate, documented in
`docs/superpowers/plans/2026-08-24-base-game-server-hit-rig.md`.

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

## The frame cap

`frameCap` is `unlimited`, `60`, `45` or `30`, at the top of the Performance Capture section because
it changes the numbers that section records — and it is recorded with them, in `settingsAtStart`.
It is local: nothing about how fast one player draws belongs on the wire.

The animation loop still fires at the display's rate. A held frame returns before any work, so the
cap costs one comparison, and the next frame that does run simply gets a longer `dt` — which the
fixed-step simulation absorbs without a change, and which `Math.min(0.1, …)` was already bounding.

Three details are the whole implementation, and each is a way a naive cap goes wrong:

- **The deadline is an absolute grid**, `next += period`, not "now plus a period". The latter adds
  each frame's own arrival lateness to the following gap, so a cap settles a little under the rate
  it names and keeps sliding.
- **Half a display frame of slack.** A vsync arrives a fraction of a millisecond early as often as
  not; holding it means waiting a whole refresh for the next one, and a 60 cap on a 60 Hz screen
  runs at 30. The display's own rate is tracked as an EMA of the gap between loop calls, and the
  slack is half of it or half the cap period, whichever is smaller.
- **Only a plausible gap feeds that average.** Samples over 100 ms are a tab switch, a shader
  compile or a breakpoint, not a refresh rate. Left in, one of them drags the average into the
  seconds and the cap is effectively off for as long as the average takes to decay.

A stall resyncs rather than firing every missed frame back to back. Coverage is
`test-base-game-frame-cap.mjs` (24 checks), which extracts the function from the page and drives it
against simulated 60/45/75/144 Hz displays with jitter.

**A cap that does not divide the display rate alternates, and the record shows it (2026-08-30).**
The 45 cap on a 75 Hz display in the 2026-08-30 captures averaged 45–49 fps with a frame-time p50
of 26.6 ms: the grid can only run a frame after one refresh (13.3 ms) or two (26.7 ms), so it
alternates them, and the p50 lands on the long gap. Read `fps.effective` (frames over elapsed
frame time) next to `fps.p50` before calling a capped capture slow; the two disagree exactly when
this is happening. **Snap the cap to the display rate** (`frameCapSnap`, off by default, in the
same section) rounds the cap to the nearest exact division of the display rate — 37.5 for a 45 cap
on 75 Hz, 75 for a 60 cap on 75 Hz, 28.8 for a 30 cap on 144 Hz — so every gap is the same. The
display rate comes from the cap's own refresh EMA, rounded to whole hertz so its drift cannot
restart the grid. The plain cap stays available; the snap is recorded in `settingsAtStart` like
the cap is.

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
node test-base-game-clouds.mjs
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

### World plan and trails (implemented 2026-09-01)

Base Game now holds a second, CPU-only field scheduler for a coarse world plan. The plan window is
16 by 16 tiles, each 16 intervals at 30 m posts: roughly 7.7 km of terrain centred on the player.
It carries band-limited `heights`, `biomeIds`, and derived `planWalk`; `gpu:false` means no unused
textures or uploads. `base-game-plan.js` encodes water and cliff as zero and walkable grade classes
as 1..255. `base-game-sites.js` deterministically jitters one placeholder site per 480 m tile and
snaps it to the flattest nearby walkable post; `{x,z,tier}` is the seam future structure worldgen
will replace.

`base-game-trails.js` turns settled sites into canonically ordered relative-neighbourhood legs,
routes one eligible leg per frame through `trail-router.js`, discounts already committed corridors,
and commits the resulting 6 m samples to one bounded `road-network.js` graph. The placement field's
three cover channels are attenuated both when a trail arrives after a tile and when a tile derives
after a trail. `terrain.coverAt` returns null while an overlapping leg remains unsettled, so tree
placement waits instead of recording a tree that a later trail would cover. Grass can disappear on
its next recull after a late stamp.

The Trails panel exposes the shared world inputs `trailsEnabled`, `trailSeed`, `trailSpacing`,
`trailWidth`, and `trailMaxGrade`; `trailShow` is local presentation. Protocol 18 relays and clamps
the shared inputs. The runtime line reports plan coverage, sites, routed/pending legs, topology,
resident edges and mesh backlog once per second. Road meshes use the fine contact window, are built
one item per frame, fade at their 70 m residency edge, move with render-origin rebases, and carry
terrain heat in visor modes.

Focused tests: `test-base-game-plan.mjs`, `test-base-game-sites.mjs`,
`test-base-game-trails.mjs`, `test-trail-router.mjs`, and
`test-road-system-incremental.mjs`.

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
  `instanceParts`, `bounds`, `reducedParts`). Since 2026-08-30 `instanceParts` is one part per
  MATERIAL (`mergePartsByMaterial`, see `docs/subsystems/bots.md`), not one per GLB sub-mesh: the
  2026-08-30 captures had 74 always-on `WeaponBatch` buckets for one player's guns, the largest
  owner in the scene census, and every one of them is a separate encode. `createMount(body, weaponId)` is async (GLB fetch) and
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
  (golden-angle disc scaled by the pixel's own circle of confusion — the collapsing disc is what
  keeps sharp subjects sharp; the tap weight only stops sharp neighbours polluting blurred pixels;
  known limit: near blurred objects keep hard silhouettes) on HDR colour, driven by the scene pass
  depth attachment. Depth linearizes with the factory's own `sceneNear`/`sceneFar` uniforms
  refreshed from the game camera per render — the global `cameraNear`/`cameraFar` nodes read the
  post quad's ortho camera inside a `RenderPipeline` and flatten every depth to zero. Defocus is
  measured as a fraction of the focus distance so one aperture reads the same near and far, and
  sharp pixels early-out of the gather (`If(rHere > 0.5)`, taps at explicit LOD so the branch is
  uniformity-legal). `dofEnabled`, `dofAutoFocus` (centre ray against the world query, eased on
  the CPU at `focusRate`), `dofFocusDistance`, `dofAperture`, `dofMaxRadius`, `dofFarScale`;
  uniform writes are dirty-checked (`syncDofParams`) and the focus ray reuses hoisted arrays.
  `taps` is baked into the loop at node build. While on, the page renders through a
  `RenderPipeline` (`pass(scene, camera, { samples: 4 })` so MSAA survives → dof → `renderOutput`;
  `PostProcessing` is the pre-r183 name). Three's own `dof()` addon (`DepthOfFieldNode.js`) is the
  cheaper fallback if the gather costs too much; off, the plain render path runs and the pass
  costs nothing. `test-depth-of-field.mjs` builds the node to a shader through
  `tsl-build-check.mjs` (which gained the r182 `getOutputBufferType` stub) and pins the
  scene-camera planes, the explicit-LOD taps, and the loud missing-camera error.
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

**The weapon flashlight (L).** `weapon-light.js` — `createWeaponLight({ THREE, scene, options })`.
bot-viewer-v3 fakes a flashlight with an instanced additive cone per bot (`beams` in
`bot-viewer-visuals.js`) because a real light per bot in a 90-bot firefight is a non-starter; there
is one local player here, so this is an actual `THREE.SpotLight` that lands on terrain, walls and
bodies, plus a small `PointLight` at the lens (`spillIntensity`) so the gun and the ground at your
feet are not black while the wall ahead is lit. Nothing is drawn — no cone mesh, no sprite.

The lamp is mounted on the **bore**, not the camera: `weaponLightSource(canControl)` reads
`weaponSystem.muzzleWorld` and `weaponSystem.barrelDirection` off `playerBodies.localMount`, so the
beam points where the gun points and swings with a reload or a swap. A weapon with no barrel (knife,
empty hands) falls back to the capsule-top eye and the look direction rather than blinking out, and
death or a menu passes `null`, which ramps the beam down instead of cutting it. `placeFlashlight`
sits the lamp `lensForward` metres past the muzzle so the barrel does not shadow its own beam.

Residency follows `flash-lights.js`'s rule exactly: both lights live in the scene from startup and
switch through **intensity**, never `.visible`, because on the WebGPU backend the set of visible
lights keys the render pipeline. `castShadow` is structural in the same way, so `flashlightShadows`
is a deliberate settings toggle (default off) that costs one recompile when flipped and a second
shadow pass while on; without it the beam shines through walls.

`rampToward` is an exponential approach (`rampRate`, default 26/s) so the switch is a click with the
pop taken off and is frame-rate independent. Settings: `flashlightOn` (the L key writes this same
setting, so key and panel are one source of truth), `flashlightIntensity`, `flashlightRange`,
`flashlightAngle`, `flashlightSoftness`, `flashlightWarmth` (0 cool LED to 1 warm incandescent),
`flashlightSpill`, `flashlightShadows`; `applyFlashlight()` pushes them all through `configure`.
The beam is **local only** — it is not in the protocol, so other players do not see yours and you do
not see theirs. `weaponLight.update` runs in the frame's `fx` block. Node-tested:
`test-weapon-light.mjs`.

**The laser sight (double-tap L).** `weapon-laser.js` — `createWeaponLaser({ THREE, scene, options })`.

**The dot is a real light**, not a drawn quad: a `SpotLight` with a cone a fifth of a degree wide and
`decay: 0`. Zero decay is not a cheat, it is what a laser *is* — a collimated beam does not spread,
so its irradiance does not fall off, and three's `getDistanceAttenuation` reduces to a constant 1 at
decay 0 (`lightDistance.pow(0)`) while the Frostbite window still fades the dot out at the end of
`range`. The dot is therefore the same brightness at two metres and at eighty.

That buys, for free, everything the first version of this had to fake: the dot lands on whatever is
actually there, wraps over edges and curves, and takes the surface's own material response. The
version it replaced raycast the world every frame and pasted a billboard at the hit — which put the
dot on the terrain *behind* a player instead of on them, because `world-query.js` has no provider for
bodies. There is now **no laser raycast at all**.

Two cone details are load-bearing. `penumbra` is never 0: three's falloff is
`smoothstep(coneCos, penumbraCos, angleCos)` and penumbra 0 makes those edges equal, which is
degenerate — and a hard edge on a four-pixel dot crawls as you turn. And `shadows` defaults **on**
here, unlike the flashlight's, because a spot lights every surface inside its cone, so without a
shadow map the dot also appears on the wall behind the pillar it just hit — two dots. The saving
grace is that the shadow frustum is under a degree wide, so a 512² map is enormous angular
resolution. `laserShadows` ("Dot is blocked by cover") turns it off for one fewer shadow pass.

**The beam is the one part a light cannot express** — no light source draws a visible column of air —
so it stays a mesh: an additive cylinder down the bore, `depthWrite: false` and depth testing **on**,
drawn to the full `range`. Opaque geometry clips it exactly where the beam would stop, which is the
second reason no raycast is needed. Its radius (`laserBeamRadius`) is a plain world
measurement with nothing layered on top, so **0 means 0** — the beam is hidden, not drawn at zero
scale, which would still be a draw call with a singular matrix. It thins out with distance, because
that is what distance does.

An earlier version also floored the radius in screen pixels so the far end could not go sub-pixel.
That floor was computed at the beam's *midpoint*, which over a 120 m beam is 60 m away, so it swamped
the entire sensible part of the slider: 0 mm, 1 mm and 5 mm all drew the same 10 cm tube, and "0 mm"
did not mean no beam. A control that overrides the control is worse than the shimmer it prevents. The
`metresPerPixel` / `screenSizeFloor` helpers went with it; `test-weapon-laser.mjs` keeps the bug out.

The emitter rides `barrelDirection` off the same mount as the flashlight, so the dot and the reticle
do not agree — the reticle is drawn from the ray the server fires, which leaves your eye. That
disagreement is the point of carrying a laser.

**The L key is one switch with two positions.** `tapKind(lastTapMs, nowMs, windowMs)` (default
`DOUBLE_TAP_MS` 280) separates a tap from a double tap. A single tap toggles the flashlight; a double
tap toggles the laser *and flips the flashlight back*, because the first tap of the pair already
moved it — the light blinks for a fraction of a second rather than every tap waiting on a timer to
learn what it was. A third tap starts a fresh pair. Settings: `laserOn`, `laserBeam` (dot only when
off), `laserHue` (`hueToHex`, a full wheel: 0 red, 1/3 green), `laserDotAngle` (the cone half-angle,
so the dot holds a near-constant size on screen), `laserIntensity`, `laserBeamOpacity`, `laserBeamRadius`,
`laserRange`, `laserShadows`; `applyLaser()` pushes them through `configure`. Resident and intensity-switched like
every other light on this page. Local only, like the flashlight. `updateWeaponLaser` runs in the
frame's `fx` block. Node-tested: `test-weapon-laser.mjs`.

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

**Melee and the feedback layer (2026-08-23).** A knife now resolves the same ray as any hitscan
weapon at its own 2 m `range` — environment-viewer's rule that hitscan and melee share the path and
only the presentation differs, so the client draws the spark and skips the tracer. Note one trigger
per player, not per slot: switching to the knife does not clear the cadence of the gun you were
holding, which is what stops a swap from firing twice in an interval.

Both `shots[]` and `hits[]` now carry the surface `normal`, which pays for three things that were
guessing without it: the spark faces out of the surface, `ballistic-audio.js`'s grazing angle can be
computed, and blood faces out of the wound. On each shot the client asks `pickImpactVoice` for the
ONE voice that hit deserves (a ricochet replaces the impact rather than stacking), and `evaluateWhizz`
whether the round passed close enough to the listener to be heard going by — that voice is built per
round by `createWhizzVoice(pass)` from its own miss distance and time of flight, so
`base-game-audio.js`'s `emit` gained an optional voice override (`whizzAt`). A player hit spawns
`blood-tuning.js`'s burst (`sprayParams` / `stainParams` / `splatterParams`) scaled by
`bloodIntensityForHealth` of the victim's health after the hit; with no rig on the wire the stain
takes its fixed size instead of fitting a part's cross-section.

**Quick-throw on G, and the RPG's viewmodel yaw (2026-08-23).** `G` throws whatever is in the
throwable slot without ever holstering the held weapon, so a rifleman can lob a grenade mid-fight.
Nothing new was needed beyond one wrapper: `base-game-fire.js` `stepThrow(trigger, ammo, opts)` is
`stepTrigger` on a *second* trigger state, minus the reload branch, plus one line — `reloadAmmo`
right after a throw leaves, because a pouch puts the next grenade in the hand at once. Cadence is
still `weapons.js` `fireIntervalMs` (1.5 s) and the count is still `player-ammo.js`
(`magazineSize + reserveAmmo` = 6 throws). A slot holding anything but a `projectile` weapon is
refused (`reason: 'not-throwable'`).

Both sides run it per tick beside the held weapon's `stepTrigger`: the server on `client.throwTrigger`
in `consumeTick`, the page on `localThrowTrigger` in `stepLocalThrow`. `fireShot` gained a fourth
argument so the throw's own trigger supplies the dispersion state — otherwise the rifle's bloom
would bend the server's grenade one way and the client's prediction another. A throw stamps
`action = 5` (`throw`) only when the held weapon's action is idle, so it never cancels a reload
animation; `base-game-audio.js`'s `ACTION_EVENTS` plays `grenade_throw` on it with the handling
profile. The HUD's second line is `[G] <throwable> <count>`. **Protocol 9**: tick input adds `throw`,
and the action enum adds `throw: 5`.

The RPG was held **backwards** in first person: `weapons.js` had `viewRotation: [0, Math.PI, 0]`
while every gun that was actually tuned in environment-viewer's weapon panel sits near 0
(`cz_805_bren` −0.10, `m24` −0.17, `m1911` −0.21). Those four carry measured radian values; the
knife, grenade and RPG carry round hand-authored guesses that were never checked in a view. Both of
the RPG's yaws are now 0. The provenance is worth stating once: **first-person hold = `weapons.js`
`viewOffset` / `viewRotation` / `aimOffset` / `aimRotation`, read by `weapon-viewmodel.js`**, tuned
with the Weapon sliders in `environment-viewer.html`; the third-person hold is unrelated — it comes
from `weapon-anchors.json` grips through `weapon-mount.js` and `weapon-hold-resolver.js`.

**Weapon accuracy is tuned, then committed (2026-08-24).** The cone came from `AIM_DEFAULTS` in
`bot-aim.js` — numbers tuned for *bots*, read by the player's trigger only because that was the one
spread model in the repo. **`shot-spread.js`** now owns the seven that matter: `spreadScale` (a
multiplier on each weapon's authored `spreadRad`, so their relative accuracy stays in `weapons.js`),
`moveSpreadDeg`, `firstShotSpreadDeg`, `settleMs`, `bloomPerShotDeg`, `bloomMaxDeg`,
`bloomDecayDegPerSecond`. `base-game-fire.js` gained `setShotSpread()` / `getShotSpread()` and builds
one `aimSettingsFor(weapon)` that feeds `spreadHalfAngleRad`, `bloomAfterShot` and `decayBloomDeg`.

**`shot-spread.json` is the default**, not a per-room setting and not replicated: the relay reads it
at startup (`server/server.js`, logging which source it used) and the page fetches it, so both fire
the same cone without a protocol field. The page's Weapon spread section (under Player / Camera,
v3's labels and ranges) writes a local object — deliberately *not* `settings`, whose autosave goes to
web storage, because a stale local copy must never win over the committed file — and "Save as
default" POSTs to `serve.py`'s new `/api/save-shot-spread`. `shot-spread.js`'s frozen block is only
the fallback for a page or relay with no file. Tune in Solo: online the relay's copy decides where
the round goes, and the sliders move only what this client predicts. `test-shot-spread.mjs`.

Also fixed that day: the melee assertions in `test-base-game-fire.mjs` were flaky. The block reused
the yaw/pitch computed before the kill, but the respawn puts the victim back on the spawn point the
shooter is standing on — sometimes directly overhead — so the stale aim swung at empty ground. It
now aims at where the victim is.

**Unlimited ammo (2026-08-26).** A room rule, not a client toggle: ammo is server-authoritative, so
`unlimitedAmmo` is a `BASE_GAME_SHARED_KEYS` boolean the owner sets and everyone obeys, like whether
there is a sea. The implementation is `Infinity` and almost nothing else — `player-ammo.js` gained
`setUnlimited()`, which swaps every magazine in the store for a bottomless one and back. `mag -= 1`
leaves `Infinity` alone, `reloadAmmo`'s `mag >= magazineSize` short-circuits, and the wire already
carried it (`wireAmmo` sends `null`, `cleanAmmo` reads it back) because JSON has no `Infinity`. The
one guard added: `stepTrigger` will not open a reload window on a bottomless magazine, which would
otherwise gate the trigger for 1.5 s for nothing. Turning it off hands everyone a full load. The HUD
prints `∞`.

### Weapons, phase 4: stowed weapons and transitions (shipped 2026-08-26)

**Stow (4.1).** What is not in your hands hangs on you. v3's stow block moved into `weapon-mount.js`
(`STOW_PLACEMENTS`, `stowPlacementFor`, `buildStowParts`, `stowedWeaponIds`, and the system's
`createStow()`), and `bot-viewer-v3.html` now calls it instead of its own copy — the same
extract-then-switch that phase 1.5 did for the mount. A stowed copy is a reduced part list (largest
parts covering 90 % of the vertices, at most two — parts being material groups since 2026-08-30) on a per-frame matrix into the SAME instanced
pool as the held gun, so it costs no draw call: long guns across the back, pistols on the right hip.
It rides the torso joint, so a body without one hangs nothing, and it is skipped when the body is
hidden — in first person the local rig is masked away, and a gun floating where the torso used to be
is the one thing you would notice.

That needs to know what a player carries, so the player state now replicates the whole `loadout`,
not just the weapon in hand. Nothing else on the wire said what the other three slots held.

**Transitions (4.2).** `weapons.js` gained `SWAP_MS_BY_CLASS` / `swapMsFor(id)`: the carry class sets
how long a weapon takes to put away and bring up (pistol 350/300 ms, rifle 600/550, everything else
250/220), overridable per weapon with `holsterMs`/`drawMs`. `base-game-fire.js` gained the swap
itself — `createSwapState`, `beginSwap`, `swapPhase` (pure: asking must never change it),
`drawBlendFor` and `remoteDrawBlend` — and `stepTrigger` gained `blocked`, because a gun halfway to
your back cannot fire or reload. Both sides run the same state on the same tick numbers; predicting
it differently means firing shots the server drops.

Three rules fall out, and two of them change earlier behaviour:

1. **A swap during a reload is refused outright** (the plan's rule; both hands are already busy).
   It used to cancel the reload.
2. **The weapon in hand is the outgoing one until the holster finishes.** The slot moves on the key
   press, but `playerEntry` reports `heldWeapon(client)`, so a remote does not swap the model early
   and play the holster on the wrong gun. The page defers its own model handover the same way
   (`stepLocalSwap`).
3. **A trigger held through a swap still needs a fresh press** on a semi-auto: the slot change eats
   the press edge, as it always has.

`holsterHold` is derived rather than authored: with nothing in `weapons.js`, `holsterHoldFor` returns
the weapon's own **stow placement**, which is the place the gun is actually travelling to. Authoring
the two separately is how they drift apart. `base-game-player-bodies.js` runs the blend off a wall
clock (`swap.phase`/`t`/`duration`) rather than the replicated tick — the action and the tick it
began are on the wire, the curve between them is not, and stepping it at the 20 Hz snapshot rate
would stutter a motion lasting half a second. A finished holster stays down until the draw says
otherwise.

**Input and HUD (4.3).** Every way of changing what is in hand goes through one `selectSlot`: the
number keys, `Q` for the last weapon, and the mouse wheel, which `cycleSlot` walks through the filled
slots only. The wheel is the weapon wheel while the pointer is locked, **shift+wheel** is the third-person boom,
and with the pointer free the plain wheel is the boom again (there is no weapon to change while you
are setting the scene up). Camera distance also keeps its own slider. The shift path exists because
the first cut left the boom reachable only from the panel while playing, which is exactly when you
want it. The `#combat` HUD grew a row of slot chips — key, weapon, and that
slot's own magazine, with the held one lit; the throwable shows one pouch count because it is thrown
from the pouch, not a magazine.

**Reticle (2026-08-26).** `reticle.js` is a DOM overlay ported from bot-viewer-v3's POV crosshair —
four bars whose gap tracks the live cone, a centre dot that appears only when the shot is legal, and
the hitmarker X (red when the hit was fatal). Two things had to change for a game with a
third-person camera:

1. **It is positioned, not pinned to screen centre.** A round leaves the player's head along the
   look direction; in third person the camera sits behind and beside that head, so screen centre is
   metres from where the shot lands. `updateReticle` casts the *server's* ray — capsule top,
   `lookDirection(yaw, pitch)` — against the local world query and projects the hit point. It hides
   rather than draw a mirrored position when the point is behind the camera. In first person the
   two agree and it sits where you would expect.
2. **The gap is a real angle.** `reticleGapPx({ halfAngleRad, viewportHeight, fovYDeg })` projects
   the cone through the camera's vertical FOV, so the bars enclose the ground the rounds can
   actually reach — a fixed pixel gap would claim the same accuracy at 50 degrees and while scoped.
   The cone comes from `base-game-fire.js`'s new `spreadHalfAngleFor(trigger, …)`, the same number
   `shotDirectionFor` draws inside, so the reticle cannot drift from where the bullets go.

Amber whenever the trigger would do nothing (reloading, mid-swap, empty) and the dot disappears with
it, so "ready" is never carried by hue alone; red while dead. The hitmarker fires off the
authoritative `hits[]` event where the shooter is you, which means it is honest online and silent in
Solo, where there is nobody to hit. Toggles: `reticleEnabled`, `reticleSpread`. `test-reticle.mjs`
covers the geometry and the overlay against a DOM stub.

**Camera framing offsets are per view mode (2026-08-26).** `cameraSideOffset` / `cameraHeightOffset`
/ `cameraForwardOffset` were one set fed to `playerView.updateCamera` in both modes, and in first
person the camera *is* the focus point — so a decent over-the-shoulder third-person framing moved
the first-person eye the same distance out the side of the head, and the third-person forward offset
stacked on top of the measured `localEyeForward()`. Nobody hit it because all three default to 0.

There are now two sets (`fpCameraSideOffset` and friends) and a `cameraOffsetTarget` dropdown that
picks which one the three sliders edit; the slider labels carry `(1st)` / `(3rd)` so the panel never
lies about what is being changed. Both keys register against the same control, so the page's
"every setting has a control" check still passes and both values persist. The frame passes the set
belonging to the live mode, and only first person still adds `localEyeForward()`. Covered in
`test-base-game-player.mjs`, including that a rig eye height applies the offset exactly once.

**Uphill no longer loses the ground (2026-08-26).** Reported as "going uphill is stuttery". It was
not microstepping: `moveAndCollide` only subdivides above ~16.8 m/s and a sprint is 9.6 m/s, so it
never engages in normal play. Measured headlessly by walking the real controller up analytic ramps
through `createHeightfieldWorldQueryProvider`: at 15 deg the `grounded` flag went false for 12 of
every 150 fixed steps, periodically, while the position path stayed smooth to under 1e-5 m.

Two things combine. The heightfield's `resolveCapsule` grounds only on positive penetration and
seats the foot exactly on the surface, so the next step's motion is tangent to the ramp and
penetration lands on zero plus floating-point residue — every dozen steps it rounds the wrong way
and the provider reports no ground. `trySnapDown` is the latch meant to catch exactly that near
miss, but it bailed on `candidateVelocity[1] > EPSILON`, and climbing legitimately rises (5.5 m/s at
15 deg is +1.47 m/s, the vertical component of walking along the plane). So nothing caught it.

The fix keeps a threshold rather than deleting the guard — without one, players glue to ramp crests
and ski-jump lips. `climbRiseLimit(horizontalSpeed, normal)` is the fastest a body can rise while
merely walking up the slope under its foot, and the snap is refused only above that plus a 5 %
relative and 0.05 m/s absolute margin (resolve and probe normals differ on curved terrain). Two
constraints made the difference between working and not:

- The normal comes from **the snap probe's own hit**, never from remembered surface state. `surface`
  is nulled when ungrounded and is not in `captureState`, so a threshold that remembered it would
  diverge on reconciliation replay — this is a server-authoritative controller.
- The margin is required. On a planar ramp the rise equals the limit exactly, so without slack the
  flicker only shrinks.

Verified in `test-base-game-player.mjs`: zero ungrounded steps walking *and* sprinting at 0/5/15/30/
45/49 deg, a jump taken mid-climb still leaves the ground, running off a ramp crest still launches,
and an identical input stream replays to an identical `captureState`. Reviewed by a second model
before implementing, which is where the hit-normal and margin requirements came from.

**Idle capsules no longer creep down mesh slopes (2026-08-27).** The failure was positional, not
velocity-based: the controller could report `[0, 0, 0]`, `grounded: true` while moving 6.67 m down
the Traversal Lab ramp in ten seconds. A ray probe snapped the axis-aligned capsule foot directly to
the triangle hit. That embeds the round lower cap in an inclined triangle; `map-collision.js` then
pushes the capsule out along the contact normal, including downhill X/Z, and snap-down embedded it
again on the next tick.

`worldQuery.groundProbe()` now identifies ray-fallback hits as capsule-shaped support (a direct
ground-probe provider can override this). Snap-down seats the lower cap tangent to that local plane:
the foot offset is `radius * (1 / normalY - 1)`, and probe reach includes the worst offset at the
configured slope limit. Analytic heightfields retain their existing point-foot seating model. The
same ten-second BVH-ramp test now measures exactly zero X/Z drift and zero residual velocity;
over-limit mesh slopes still slide and fall.

The planar tangent fix was necessary but not sufficient on irregular triangulated ground: changing
face/edge normals could still create a new positional correction later. Base Game capsule queries now
opt into `walkableVerticalResolution`. `map-collision.js` resolves a walkable penetration by
`depth / normalY` on Y only and cancels only downward velocity; it cannot manufacture downhill X/Z
position or turn a vertical landing into tangential speed. Walls, ceilings and normals over the slope
limit retain normal push-out and sliding. The option is query-scoped, so older bot/map users keep
their established collision response.

Snap-down can also reacquire a walkable surface after an airborne tick. The old
`wasGrounded || alreadyGrounded` prerequisite was circular at exact tangency: a descending capsule
could be geometrically supported yet remain flagged airborne until it penetrated again. The existing
rise limit still refuses jumps, lifts and ramp-crest launches.

The Player panel now exposes `Ground braking` (`groundDeceleration`, default 30 m/s2) and
`Steep-slope friction` (`slopeSlideDeceleration`, default 0 m/s2). Slope limit remains the boundary:
walkable ground holds without downhill correction; over-limit ground slides, with its tangential
speed reduced by the configured steep-slope friction. Both controls are ordinary saved settings and
are therefore included in Base Game state captures and loads. All nine player-physics controls are
also owner-controlled shared room rules: `sanitizeBaseGameWorldPatch` bounds them, the relay applies
accepted patches to every authoritative controller, and snapshots return the values so every client
predicts with the same configuration. Regression coverage holds an idle body
for 60 simulated seconds on irregular volumetric ground with exactly zero X/Z drift, checks vertical
BVH separation directly, proves both controls alter motion, preserves crest/jump behavior, and keeps
client/server replay bit-identical through a real 3D cave-floor endpoint.

**The browser-tuned movement and gait are now the defaults (2026-08-26).** Taken from
`base-game-states/base-game-state-20260826184842.json`, which diverged from default in 14 settings.
Walk drops to 2.75 m/s with a 2.25x sprint (was 5.5 and 1.75), first person is the default view,
water clarity 18, camera boom 5.83, and nine gait values change together: double cadence, forward
stride 1.7 and behind stride 1.5, feet barely overlapping (0.02), a 0.47 m step trigger, twice the
bob, real sway, a wider foot workspace and half the locomotion amount.

Setting them turned up two duplicated constants that would have desynced or misdriven the rig:

- **Move speed lives in the controller, not the page.** The relay builds its controllers from
  `DEFAULT_CONFIG` in `base-game-player-controller.js` and overrides nothing but `fixedHz`, while the
  page fed its own `playerMoveSpeed` into the client's controller. Putting 2.75 only in the page
  would have meant the client predicting 2.75 while the server simulated 5.5 — a correction every
  step, online only. The nine physics settings in `DEFAULT_SETTINGS` now read from
  `BASE_GAME_PLAYER_DEFAULT_CONFIG` instead of repeating literals, so they cannot drift again.
- **The rig kept its own copy of the walk speed.** `movementSpeeds` in `base-game-player-bodies.js`
  was `{ walk: 5.5, sprint: 1.75 }`, and the arm-pose presets blend on absolute m/s. The page calls
  `setMovementSpeeds` so the live game was fine, but any consumer that did not got a rig told it was
  strolling while the body sprinted — the arms never came up. It reads the controller config now.

Five test assertions encoded the old speed as a fixed distance or a magic number (`armPoseSpeed > 9`,
"moves 1.5 m in 60 ticks", walking a fixed frame count to reach a ledge or a stair tread). They are
expressed against the configured speed now. The firing fixture had a sharper version of the same
problem: it separated the two players by tick count, so at the slower walk they stayed inside a 15 m
grenade blast and the shooter killed itself before the swap tests ran. It separates by distance now.

### Posture: kneel and prone (shipped 2026-08-26)

`C` kneels, `Z` goes prone, both toggles — you do not hold a key to stay lying down, and pressing the
key you are already in stands you back up. Nothing new was invented: `bot-stance.js` already owned
every curve (speed, spread, height, turn rate) and the eased pose weights, and it is pure, so it runs
on the relay as happily as in the browser. The base game opts kneel and prone in
(`BASE_GAME_STANCE_SETTINGS`); `bot-stance.js` leaves both off by default so the viewers that predate
them keep their behaviour.

**Nothing snaps, by construction.** The stance name never switches anything directly. Every
consequence is blended from `stepStanceWeights`' eased 0..1 weights: the capsule height through
`blendStanceHeightScale`, the move speed through a matching prone-over-kneel-over-crouch blend, and
the rig through its own `crouch`/`kneel`/`prone` channels — the same weights, so the pose you see and
the capsule you get shot in can never disagree. Measured: 1.80 m standing, ~1.35 kneeling, 0.70
prone, and the biggest single tick moves under 10 % of the travel in every direction.

The easing runs on the **fixed clock inside the controller**, not on render dt, so the relay and the
client's prediction land on the same height and speed for the same tick. The weights are in
`captureState` / `applyState` for the same reason the climb threshold could not read remembered
surface state: they are simulation state, and a hard correction that left them out would stand a
prone player up.

Three details worth keeping:

- **Standing up is refused with no headroom.** The taller capsule is resolved in place first; if
  anything pushes it, the pose holds where it is rather than clipping through the ceiling.
  `standBlocked` says so.
- **Prone bottoms out at 0.70 m, not the authored 0.35 scale (0.63 m).** A capsule shorter than its
  own diameter stops being a capsule. A vertical capsule cannot express "lying down is longer than
  it is tall" at all; this is the honest floor, not a tuning choice.
- **The rig gets standing height, not the shrunken one.** The rig does the crouching from the
  weights; feeding it the capsule height as well would squash the whole body like a scale slider.

**Protocol 12**: the tick input carries `stance` as an index into `BASE_GAME_STANCES`
(`stand`/`crouch`/`kneel`/`prone`) and the player state echoes it. Remotes ease their own weights
toward the replicated index rather than resampling three floats at 20 Hz. `crouch` stays a separate
input bit — it is the swim-down key and always was.

**The first cut did not work at all, and the reason is worth keeping.** A stance travels as an index
because the tick object the page builds *is* the wire packet — but the controller only understood the
name, so `setInput` stored the raw number `2`, `normalizeStance` read it as `stand`, and posture
never changed. Only the relay worked, because it converts with `stanceName()` before stepping. Solo
and client prediction silently stood still. `setInput` now accepts either form against
`BASE_GAME_STANCES`, the one list that defines the order. The tests missed it because they drove the
controller with names, the way the server does, and never the way the page does — so the regression
test drives it both ways and asserts they reach an identical capsule.

**Walking out of a kneel gives you the crouch.** A kneel is a one-knee firing position — the rear
knee is on the ground and both feet are pinned — so there is no gait that can walk it. Crouch is the
same lowered pelvis with the normal gait still running, so `C` now means "get low" and the pose
depends on whether you are moving: still is a kneel, moving is a crouch walk, and stopping puts the
knee back down. The handover is the same eased blend as everything else (worst tick under 2 cm), and
it keys off the movement INTENT rather than measured speed — stance changes speed, so reading speed
back would be a feedback loop. Prone is left alone: crawling is its own pose, not a crouch.

That split is why the controller reports two stances. `stance` is what the body IS, which is what the
rig's locomotion, the weapon hold and every remote must agree with; `requestedStance` is what was
asked for, which is what the key toggles against.

**Posture did not reach the wire at all in the first cut.** The tick entry `base-game-prediction.js`
builds *is* the packet the relay receives and *is* the record the replay re-runs, and it listed its
fields explicitly — without `stance`. So the relay never saw a stance, and local prediction never
saw one either: posture worked only in Solo. Worse, had one side got it alone, kneeling while
walking would have desynced by 5.9 m in 5 seconds (the client predicting full walk speed against the
server's crouch speed) — a correction every snapshot. Measured through the real prediction module and
the real wire sanitizer, both sides now land within 0.0000 m for stand, kneel and prone.

`applyState` also stopped zeroing the pose weights when the state does not carry them. Only
`captureState` does; an authoritative wire entry does not, so every resync was standing a kneeling
player up. The replayed inputs re-derive the weights on their own.

Still open: no crouch key is bound (the stance stays in the ladder because the fallback chain reads
it), stance does not yet scale weapon spread even though `stanceSpreadScale` exists, and prone has no
special weapon hold.

**Aim zoom and the sight picture (2026-08-27).** The ADS *zoom* was already there and always had
been — `applyFirstPersonOptics` narrows the FOV by the weapon's `magnification`, eased by the aim
blend, and pushes the eye forward by `aimEyeForward`, the same three lines environment-viewer runs.
What was missing was the half that makes a scope look like a scope, so **`scope-overlay.js`** ports
environment-viewer's `updateScopeOverlay`: a hard black surround with a feathered rim, and a masked
peripheral blur, faded in with the aim. Only `sightType: 'optical'` gets one, which today is the m24
alone; iron sights zoom without blacking out the world.

Two departures from the original, both about cost. It rebuilds the two gradient strings only when
the numbers that shape them change rather than every frame, since a CSS gradient reparse per frame
is real work for a picture that holds still. And `backdrop-filter` is attached only when a weapon
authors blur, because a full-screen backdrop filter is among the more expensive things a browser can
be asked to do per frame. The reticle hides while the sight picture is up: a crosshair over a
telescopic sight is two reticles arguing. `test-scope-overlay.mjs`.

**Third-person aim zoom (2026-08-27).** environment-viewer disables optics in third person outright
(`eligible = !localBodyThird`), so there was nothing to port and this is new. Aiming now narrows the
third-person FOV by the weapon's own `magnification`, eased by the same aim blend, through the same
`magnifiedFov` helper first person uses — but **capped** by `tpAimMagnification` (default 1.6, range
1 to 8, 1 turns it off). The cap is the point: the m24's full 8x in third person would frame the
inside of the player's own shoulder. At the default the pistols land near 42 degrees and everything
from the rifle up bottoms out at 32.5 from a 50 degree base.

`applyFirstPersonOptics` is now `applyAimOptics`, since it is no longer first-person only. Optics
beyond the FOV — the scope picture, a boom pull-in, an aim shoulder shift — stay first-person only
for now.

Still open in this phase: the head multiplier. `hits[].head` is always false, and this is deliberate
rather than forgotten — every other head decision in the repo comes from a rig
(`bot-body-hit.js` → `bot-limb-map.js`), the server has no rig, and a capsule-top zone would be a
second, disagreeing convention. It wants either a rig on the server or an explicit decision to hit-zone
capsules. Remote recoil is NOT open — `applyAction` already kicks a remote's mount and aim on a new
fire tick.

Tests: `test-base-game-fire.mjs` (trigger step, seeded spread, protocol, a two-player room where
one shoots the other dead and the server respawns them, then an RPG flight that detonates and
damages, page markers). `test-combat.mjs`, `test-bot-aim.mjs`, `test-bot-projectiles.mjs`,
`test-tracer-visual.mjs` cover the reused math.

### Drones: thrown quadcopter and UAV (shipped 2026-08-27, unseen in a browser)

Plan: [2026-08-27-base-game-drones.md](../superpowers/plans/2026-08-27-base-game-drones.md); the
wider picture is [base-game-flight-integration.md](../base-game-flight-integration.md). This is the
first non-player thing the room replicates, and the first flight code in Base Game.

**Slot 7, the launcher (protocol 15).** `BASE_GAME_WEAPON_SLOTS` gained a seventh entry, `launcher`,
defaulting to the `rpg`; key 7 selects it and `weaponLauncher` is its dropdown. It takes any weapon,
not only the rpg — the sanitizer's only rule is the existing one, that a gadget belongs in a gadget
slot. The page no longer keeps a parallel list of number keys: `WEAPON_SLOT_SETTINGS` and `SLOT_KEYS`
are both derived from the slot list, since a hand-kept `['Digit1'...'Digit6']` is exactly how the keys
would have stopped at 6 while the slots went to 7. NPC bots are given `launcher: 'none'`, so adding
the slot did not quietly hand every bot on the map a rocket launcher.

The version bump is load-bearing rather than cosmetic: the wire `slot` is an integer bounded by
`BASE_GAME_WEAPON_SLOTS.length`, so a relay still on 14 would clamp slot 6 to 0 and silently hand you
the rifle, and drop the `launcher` key out of the loadout. `validateHandshake` rejecting the version
turns that into a visible refusal instead.

**What it is.** Two gadget slots, `gadget` (key 5, quad) and `gadget2` (key 6, UAV), each hold a `quad` or a `uav` (protocol 13:
`BASE_GAME_GADGET_IDS`, `isBaseGameGadget`; gadgets ride the weapon-id vocabulary so `weapon` on the
wire can name them, but `getWeapon()` knows nothing about them and the bodies and viewmodel are handed
`null` instead). Key 5 or 6 draws it: both hands go up over the head (`base-game-player-bodies.js` drives the arm
targets directly from the head joint, bot-viewer's heal-pose way; `heldAnchor(id)` is the point
between the solved hands) and the drone view puts the craft there, nose along the body's heading
(`record.heading`, not `motion.visualYaw`, which carries the rig's yaw+PI spin). Click throws it (server `launchGadget`: a fire edge once the draw is
done, one of each kind aloft per player, from 0.5 m above the eye along the look at 8 m/s). It then
flies itself: the quad shadows over the owner's shoulder, the UAV (the sim's plane) orbits the owner at 900 m and 300 m up, accelerating from the throw to its 120 m/s circuit speed at the airframe's thrust/mass (`autoSpeed` on the record, also reset from the airspeed when the stick is released) because `cruiseTo` would otherwise snap it there in one tick. `F` takes
the stick (the body stands still, on the server too; the camera rides the drone from behind), `B`
sends it to the point under the crosshair (world query, then the terrain field marched out to
1.5 km), `N` recalls it. At the stick the flight sim's keys: arrows pitch/roll, A/D yaw, W/S throttle; the mouse does
nothing and the right button does not zoom, so the body's view is where you left it on release.

**One drone, two steppers** (`base-game-drones.js`). `bot-drones.js` steering (`hoverTo`,
`cruiseTo`, `orbitAround`, `advance`, now exported) flies the autonomy states `launch`, `follow`,
`goto`, `hold`, `return`; `flight-model.js` `stepFlyer` flies `manual`, so the quad has the flight
sim's `drone` airframe and tilt physics and the UAV the sim's `plane` airframe, unmodified
(an invented `uav` airframe from the bird's wing lasted one day: the user's UAV is the sim's plane,
and bot-viewer-v3's `recon` mesh was never a flyable body). Position and velocity are shared as-is; the handoff
converts attitude only (`quatFromHeading` / `headingFromQuat`, round-trip tested). `deadstick` is
`bot-drones.js`'s own, with v3's deadstick-or-break roll on a kill (`damageBaseGameDrone`). A dead
owner drops the quad and parks the UAV where it is. `flight-terrain.js`'s `setHeightSource` is bound
to the room's ground before every manual step, which is how the flight model sees Base Game terrain.

**Server** (`server/base-game-rooms.js`): `room.drones`, stepped after players and projectiles each
120 Hz tick (`stepDrones`); `applyDroneInput` takes `tick.drone = { id, mode, pitch, roll, yaw,
throttle, send, recall }` and only for a drone the client owns; the snapshot carries `drones`
(`droneWireState` → `sanitizeBaseGameDroneState`) and each player's `controlling`. Ground is
`sim.heightAt` in terrain rooms and the spawn floor in the lab.

**Client**: `base-game-drone-view.js` draws them with `flight-meshes.js` in node materials, in the sim's craft tint (`buildDrone` at 2.2x, the v3
scale; `buildPlane` at 1x), posed from yaw/pitch/bank the way v3's `poseDroneCraft` does,
interpolated through `createRemoteTrack`; the chase camera is the flight sim's chase branch. Solo
runs the same module in `stepSoloDrones` so it works without the relay. No client prediction of the
drone; it renders at the interpolated server pose like a remote player.

**Flight parity audit (2026-08-27).** The user reported the flying was "not even close" to the
flight sim; a four-reader adversarial Sonnet pass with a skeptic per finding confirmed nine real
differences and refuted none. Fixed: (1) **`base-game-prediction.js` rebuilt every tick by hand and
never copied `slot`, `aim`, `fire`, `reload`, `throw` or `drone`**, so from a browser the server
never received a trigger, a slot change or the drone stick (the server tests send ticks directly
and so never saw it); (2) the chase camera's up vector was world-up, so the screen never banked
with the craft; now it is the mesh's own up, the back distance grows with airspeed and the up offset
is body-space, and the lens opens with speed, all as the sim's chase branch; (3) manual flight
integrates in fixed 1/120 s substeps in Solo too (the rate lag and Euler forces are step-size
dependent); (4) taking the stick starts at the airframe's `idleThrottle` like the sim's spawn, not
at computed hover. **Stock, throw and reload (2026-08-27).** A player carries `BASE_GAME_GADGET_STOCK` of each drone
per life (2 and 2; a respawn restocks). Click starts the throw: the arms wind up behind the head and
heave (`THROW_KEYS` in `base-game-player-bodies.js`, driven by `overheadPhase`), and the server
spawns the drone at `BASE_GAME_GADGET_THROW_TICKS` (0.35 s) into the
`BASE_GAME_GADGET_THROW_ACTION_TICKS` (0.7 s) action; the press spends one from the stock and
empties the hands. With empty hands and stock left, R runs the reload action for
`BASE_GAME_GADGET_RELOAD_TICKS` (2 s: hands to the hip, then back up with the next one). The
player state carries `gadgets` and `gadgetReady`; remotes play both motions from `action` and
`actionTick` against their replicated `tick`; the local body plays them from the key edge so the
arms move on the press. Solo runs the same timers in `stepGadgetHands`/`stepSoloDrones`. The UAV
flies as the plane but draws as the `recon` model at its authored size (2.01 m span), and the chase distance is **measured in wingspans off the drawn mesh**, not hand-authored: `CHASE[kind].spans` × the mesh's own bounding box, times `settings.droneCameraZoom`, with the sim's `up = 0.26` and `ahead = 1.6` fractions of that distance. The zoom is the player's own boom gesture — SHIFT and the wheel, 8% a notch, and the wheel alone at the stick since there is no weapon to change while flying — routed through the same `zoomCamera` and clamped to 0.35x–4x. It is a multiple of the craft's framing rather than metres, so one number reads the same on the 1.4 m quad and the 2 m wing. The UAV's 2.26 spans is the sim's own plane framing (`chaseDist` 26 m / 11.5 m span), so the wing fills the same share of the screen the sim's plane does. A hand-authored distance went stale the moment the UAV's `meshScale` changed and put the camera 43% too far back; measuring the mesh is what stops that recurring.

**Proof the physics are the sim's** (`test-base-game-drones.mjs`, "bit for bit"): the sim's own
`makeFlyer('plane')` and the base-game drone under the stick, fed one identical 60 s script (pull,
roll, rudder, throttle, afterburner, a dive to the ground), must not differ by a single metre; they
share the one airframe object and the one `stepFlyer`. Writing that test found two more
differences: `stepManual` forced `input.sweep = false`, so Shift (afterburner) never reached the
plane (the paths split at exactly the second the script held Shift; `sweep`/`flap` now ride
`tick.drone`), and an extra 6 m altitude floor of ours split them at 36 s (removed; the flight
model's own ground rule applies). Left as-is: online drone flight has no client prediction (a stick input is one
round trip plus the interpolation delay late; the body has prediction, the drone renders like a
remote), and the assist flag has no toggle (`rec.assist`, default on).

**Not done, in order of how much it will show:** client prediction of the drone online, a first-person view for the quad, the drone as a hit volume (nothing can shoot it down yet: `damageBaseGameDrone` exists,
nobody calls it), crash FX when a deadstick reaches the ground, sounds, the lab's flat floor as its
only ground, and every number, which has never been seen in a browser. Tests:
`test-base-game-drones.mjs`, `server/test-base-game-drones-room.mjs`.

**The Sentinel (2026-09-01, protocol 17).** A third drone kind, `sentinel` in `base-game-drones.js`, is a
world drone rather than a gadget: nobody carries or throws it (`world: true`, which is what the room's
cap and `clear` count). Its owner flies, sends and recalls it with F, B and N like any other drone; the
first version refused the stick (`pilotable: false`) and that was reversed on 2026-09-02. The room
owner's dev gun spawns it: the key-9 tool cycle gained a
`sentinel` stop after vehicles, `R` switches the `low` and `high` presets, and the click sends
`base:drone { action: 'spawn', kind, preset, alt, radius }` (`sanitizeBaseGameDroneRequest`; `clear`
removes them; `BASE_GAME_WORLD_DRONE_CAP` = 4 per room). Solo builds the same record locally.
`spawnWorldDrone` puts it on its ring already in `follow` at circuit speed, `radius` ahead of the
spawner along their look at `alt` over the ground there, leaving along the ring in the direction the
record will orbit — the first version left across it and the first thing it did was a 180-degree turn
a kilometre outside the ring. The record is owned by the spawner so the orbit follows them; a dead or
departed owner parks it in `hold` where it is, as the UAV does. It flies the plane airframe at a 70 m/s
loiter with `turn` 0.35, because the tightest ring is speed/turn and the low preset's 400 m ring was
not flyable at the UAV's 120 m/s and 0.2. Presets are four sliders in the player section
(`sentinelLowAlt` 150 m / `sentinelLowRadius` 400 m, `sentinelHighAlt` 1500 m / `sentinelHighRadius`
900 m), sent with the request and clamped server-side to `BASE_GAME_SENTINEL_LIMITS`. It draws as
`flight-meshes.js`'s `sentinel` at its authored 20 m span, so `meshScale` is 1; the HUD lists it on an
`overhead` line without the F/B/N hint. Not done: it is not a hit volume (no drone is), it has no
sound, and its look in a browser has been seen once, in the reconstruction viewer, not in this page.
Tests: the Sentinel cases in both drone tests and `test-flight-meshes-sentinel.mjs`.

**The Sentinel's missile and its seats (2026-09-02, protocol 19).** The Sentinel is flyable, carries
four guided missiles, and every craft you are at the stick of now has a green head-up display over
it. The seats are `droneCtl.seat`: `craft` is flying it, `missile` is the sensor picture, and F moves
between them while X gets out (a craft with no rack keeps F's old meaning, which is to let go). At
the sensor, the mouse slews a world-frame aim the way the flight sim's gunner ball does, the wheel
steps the lens through 10/20/30/45 degrees, and space releases a round. The camera then rides that
round until it is gone, and slewing the sensor mid-flight steers it, so it is television-guided
rather than fire-and-forget.

The missile is not a new kind of thing: it is an ordinary projectile from `bot-projectiles.js` with a
`guide` field, so it inherits every hit, ground and detonation path those already have.
`fireAgm(rec, aim, now)` takes a round off the rack and returns what to spawn (the server spawns into
its room manager, Solo into the page's), and `stepGuidedProjectiles(list, dt)` turns each guided
velocity toward its aim and carries the proximity fuse. Both live in `base-game-drones.js` and both
run identically on the server and in Solo. The fuse zeroes the entity's remaining life on arrival, so
the entity detonates itself through the airburst path it already had — needed because a round aimed
where nothing answers a raycast would otherwise sail through and fly on for thirty seconds. The rack
is `agm` on the def: four rounds, 120 m/s, 3.0 rad/s, a 10 m blast for 120 damage, 1.2 s between
rounds. The turn rate is the number that matters: the turning circle is speed / turn, and at the
1.2 rad/s first written it was 100 m, which put a target directly below the drone inside the circle
where the round simply could not reach it. Rounds left ride the wire as `agm`. Design and the numbers:
`docs/superpowers/specs/2026-09-02-sentinel-agm-design.md`. Tests: `test-base-game-agm.mjs`,
`test-flight-hud.mjs`, and a shot end to end in `server/test-base-game-drones-room.mjs`.

**A map, and a mouse that does something while you fly (2026-09-02).**

*The map*, on `M`. It is `world-map.js`'s own `createWorldMapOverlay`, wired the way
`environment-viewer.html` wires it: the panel, the north-up projection, the zoom, the arrows and the
hover readout are all that module's. The only new part is the bake. `bakeMapCanvas` covers a bounded
authored map once over a fixed extent; this page streams an unbounded window, so
`base-game-world-map.js` bakes a square that follows the player and is redone every 60 m of walking,
in the exact field shape the overlay already reads (`worldX/worldZ/wx0/wz0/sxu/szv/canvas/
terrainDetailCanvas`). The relief-and-contour layer comes from `bakeDetailCanvas`, split out of
`bakeMapCanvas` so both bakes produce the same layer rather than two copies. Biome colours are
`BIOME_COLORS`, the palette that module already uses. Unresolved ground answers null and bakes as
unexplored. Everything read is a GLOBAL position, so the floating origin's rebase cannot reach it.

An earlier version of this replaced the overlay as well, on the strength of a review that said the
whole module was coupled to the bounded map. Only `bakeMapCanvas` is; the overlay reads six numbers
and two canvases and does not care where they came from. That rewrite reinvented the projection, the
panel, the zoom and the arrow colours, and drew east on the wrong side, because `worldToBigMap` puts
east at negative X and the hand-written arithmetic did not. `test-base-game-world-map.mjs` now pins
the bake against the fields the overlay reads, which is what a blank map would have looked like.

*Free look.* The mouse used to be captured and discarded at the stick — pointer lock held it and
`pointerLook.clear()` threw every delta away, which reads as a dead mouse rather than as a decision.
The flight sim has exactly one mouse handler and it only runs in the gunner view, so there was
nothing to copy and this is new in both pages. Holding the left button now drags the view around the
craft while it keeps flying its heading, and a double click (`tapKind`, the flashlight's own idiom)
puts it back behind the nose. It works in both views: `placeCamera` swings the boom in the craft's
own frame so it still rides the roll, and `placeCockpitCamera` turns the view inside a held attitude.
A seat change or leaving the craft recentres it. A turret station is excluded, because there the
mouse already aims the gun and the button really does fire something.

**The dev gun is a two-ring wheel, not a cycle (2026-09-02).** Key 9 used to step through
bots, lights, vehicles, sentinel and off, with one line of corner text as the only feedback, and R
cycled the option inside whichever tool you were on. Three things were wrong with that, and they were
one problem: you could not see what you were holding, you could not see what R would do next, and
getting back to your weapon meant counting presses of a key whose last stop before "off" spawns a
20 m aircraft. Firing is gated `weaponState.firing && !devGun.active`, so a miscounted press means a
click places instead of shooting. That is exactly the reported "I tried to switch back to shooting
and it spawned another sentinel".

Now: **hold 9** and the wheel opens on what you already have. Moving the mouse a little picks the
GROUP by direction — Weapon, Bots, Lights, Ground craft, Aircraft. Pushing further out locks that
group and the OUTER ring picks the option inside it, also by direction. Coming back in unlocks, so
you can change your mind without letting go. Releasing 9 commits both at once. A tap that never moved
re-picks what was already there, which makes the gesture safe to abandon.

`Weapon` is a wedge like any other, so putting the tool away is one visible pick. Everything R used
to cycle is now on the outer ring, and R keeps only the bots' side (enemy or friendly): that is a
second axis on one group rather than a choice among wedges, and ten role-and-side wedges would not be
readable. `cycleSpawner` and `devLightCycleKind` are gone. The ground-craft group gained the UGV
beside the buggy, which the server already accepted (`BASE_GAME_VEHICLE_KINDS`) and the dev gun had
never offered.

The wheel is `wheel-menu.js`: environment-viewer's `toolRadial` moved into a module, as a PORT
rather than a reimplementation. The angle maths, the 92 px radius, the 14 px dead zone, the button
markup and its click-to-commit, the centre dot and the colours are the source's, kept so the wheel in
both pages is the same wheel; the first version of this module rewrote all of that in a different
idiom and quietly dropped the clickable wedge, which is a thing the source has and nothing asked to
lose. The additions are the outer ring, the sublabel under a wedge, and callbacks in place of the
source's direct `toolOptions()` / `selectLocalTool()`. Locking the group on the way out is what makes
two rings work at all: the outer options span the whole circle so each is a big target, which they
could not do if the same angle still had to mean a group as well.
The geometry and the selection rule are exported pure and covered by `test-wheel-menu.mjs`, including
a sweep proving every dev-gun group and every option is reachable — an option no gesture can reach is
the failure no screenshot would show. The DOM half is not tested and cannot be without a browser.
`environment-viewer.html` still carries the original inline copy; migrating it onto this module is a
deliberate follow-up, not something this change did on its way past. Review that led here:
`docs/superpowers/reviews/2026-09-02-wheel-menu-import.md`.

**Drones can be shot down, and they always come down (2026-09-02).** Two defects, both of them the
same complaint: a drone hanging in the air instead of going off.

*It could not be hit.* `bodyRadius` had been on every drone def since they were written and nothing
read it, so a drone was scenery a bullet went straight through. `droneHitVolume(rec)` turns a drone
into a `combat.js` mob entry, which is a sphere at its position when the capsule height is zero, the
same shape the flight sim uses (`hitRadius`). `resolveHitscan` already took a `mobs` list, so the
server's shot path and its projectile raycast both pass one, and `hitDrone` routes the damage.
`detonateBlast` sweeps the drones too, through `blastDamageOnDrone`, whose falloff measures from the
SURFACE rather than the centre — a blast beside a 20 m wing has hit the wing. Solo mirrors all three
in `base-game.html` (`nearestSoloDroneHit`, `hitSoloDrone`, `blastSoloDrones`) so single player is
not a different game. A projectile's raycast is handed the projectile itself as a fifth argument
(`bot-projectiles.js` wraps `ctx.raycast` to supply it), because a missile leaves from a metre under
a drone whose hit sphere is eight metres, and without that exclusion every missile detonated on the
aircraft that fired it.

*It did not reliably crash.* Three fixes. A killed drone now always falls: `damageBaseGameDrone` used
to end it on the spot on a high roll, which put the explosion wherever it was hit, often a couple of
hundred metres up with nothing on the ground to show for it. The roll now only picks how it falls,
wild or tumbling, and only a drone already on the deck ends where it is. Under the stick, resting on
the ground for `GROUND_REST_S` (0.6 s) is a crash: the flight model only calls it one above 9 m/s
down or 34 m/s forward, so a gentle arrival used to skid along the surface with the engine running —
measured at 48 seconds before anything ended it. And the deadstick branch has a backstop: at or below
`groundY + GROUND_TOUCH`, it is down, whatever the fall thought. `test-base-game-drones.mjs` walks
every kind against every roll and asserts each one reaches the ground, on the ground, inside 25 s,
while a drone flown normally is left alone.

**Banking, fixed by the Sentinel's size.** Every drone under autonomy was drawn banked *out* of its
turn. `bot-drones.js`'s bank is cosmetic and positive for a left turn, written for bot-viewer's
`lookAt` + `rotateY(PI)` + `rotateZ` pose where the flip mirrors the roll axis; `quatFromHeading`
rolls the physics way, positive right wing down. The wire now carries the physics sign
(`droneWireState` and Solo's `ingestRecords` negate the record's bank; `stepManual` and `releaseDrone`
write the record in the cosmetic sign), so "drawn attitude equals the physics attitude" still holds
and a test pins a turning Sentinel's right wing to the side of the turn. Nobody saw it on the 2 m UAV
at 300 m.

### Ground vehicles: UGV and buggy (shipped 2026-09-01, Node-tested, unseen in a browser)

Plan: [2026-09-01-base-game-vehicles.md](../superpowers/plans/2026-09-01-base-game-vehicles.md).
Protocol 16 adds `vehicles` to snapshots and an exact `vehicle` seat body to the owning driver's
player entry. The default loadout is unchanged; `ugv` is available in either gadget selector with
stock one. The room owner can place or clear world vehicles through `base:vehicle`; key 9's third
dev-gun tool places the plan's `buggy`.

`base-game-vehicles.js` is the shared renderer-free owner. Both rows use
`city-vehicle-model.js`: the UGV is autonomous and remotely driven, while the buggy is parked until
an onboard driver presses E. A three-point support plane supplies height, pitch and roll. The road
body's optional `grade` adds gravity along that plane; a support drop switches to ballistic vertical
motion until landing. Water below the configured sea surface floods the engine. Autonomous UGV
orders mirror the drones (`follow`, `goto`, `hold`, `return`) with a 10 Hz, id-staggered three-heading
grade probe and one reverse-and-turn stuck recovery.

Driving is lockstep-predicted. A driven vehicle steps only inside its driver's numbered tick, never
again in the room-wide vehicle pass. `createSeatedController` presents the existing player-controller
surface to Solo and `base-game-prediction.js`; its body controller is pinned in place without the
allocation and contact reset of `applyState`. Onboard bodies ride the buggy seat. A remote UGV
operator remains where they took the wheel. Reconciliation compares the vehicle body as well as the
player body, so remote UGV drift is visible even while the operator's feet have not moved, restores
the nine-number `vehicleSeatState`, and replays unacknowledged movement ticks.

**Meshes (rebuilt 2026-09-02).** `flight-meshes.js` registers `ugv` and `buggy` builders with
steerable/spinning wheels. The first pass stacked boxes and hand-authored the wheel positions, and
they had drifted: the drawn wheelbase was 0.72 m against a simulated 1.1 m (UGV) and 1.52 m against
2.4 m (buggy), and because the record's `y` is *ground + clearance* while both meshes put their
tyre bottoms at y = 0, every vehicle floated by exactly its own clearance — 0.25 m and 0.40 m. Both
were read off the code, not seen in a browser.

`buildCraftMesh(kind, tint, materials, dims)` now takes an optional fourth argument, and the view
passes the vehicle's own def, so the wheels are placed from `wheelbase`, `track` and `clearance` —
the same three numbers `fitVehicleGround` samples the support plane at. Tyre bottoms sit at
`-clearance`, so the contact patch is the one the physics assumes. Every other caller passes three
arguments and is unaffected.

The geometry itself is no longer a box stack. The buggy is authored to light-strike-vehicle
proportions (3.60 x 1.98 x 2.07 m): an extruded bonnet profile, a tube spaceframe, a full roll cage,
bucket seats placed on `seatOffset` so the driver stands on the driver's seat, a steering wheel,
wishbones, shocks, a brush guard, a light bar, a cargo deck and a spare wheel.

The UGV is a reconstruction of the **Roboneers Sablynx / Lynx ("Рись")**, worked up in
`scratchpads/sablynx-ugv/` and measured in that folder's `intake-analysis.md`. Both references are
perspective photographs rather than an orthographic three-view, so the img2threejs silhouette-IoU
gate cannot run against them; the folder's README records which pipeline steps were run and which
were skipped, and what replaces the missing gate. Every proportion is a fraction of the tyre
diameter above ground, the tyre is 0.55 x wheelbase, and the absolute metres all come from the
simulation def, which puts the model at about 0.85x the real machine (2.08 x 1.09 x 2.06 m). It
carries a lofted monocoque hull tub with a sloped nose, a bolted top flange, an expanded-metal
deck, a tubular perimeter cargo rail with slotted mounting plates and clamp blocks, mudguards, tow
eyes, a rear sensor mast with a camera, dome and whip antennas, and the RWS: pedestal, louvred gun
cowl, ammunition drum, barrel and optic. **The weapon is cosmetic** — the def is still unarmed —
but the whole station is kept out of the static merge and exposed as `userData.turret`, so the
turret follow-up trains it rather than re-authoring the mesh.

**The station trains (shipped 2026-09-02, protocol 20, Node-tested, unseen in a browser).** Step 1
of [2026-09-02-base-game-vehicle-mounts.md](../superpowers/plans/2026-09-02-base-game-vehicle-mounts.md):
it aims, it does not shoot.

The precedent is not the flight sim directly but this game's own port of it, the Sentinel's AGM:
`tick.drone` already carries a world-point `aim`, vehicles already ride that channel, and the AGM's
`fireAgm` already established the seam where a pure function decides and the caller acts. So no new
input field was needed.

`def.turret` carries `pivot` (the trunnion in the SIM frame, forward +Z), `yawRate`, `pitchRate`,
`pitchMin`, `pitchMax` and `tolerance`. `aimVehicleTurret(rec, dt, aim)` converts a **world point**
into hull-relative angles through `vehicleBasis` (yaw, pitch and roll as an orthonormal frame),
slews both angles at their own rate, clamps pitch, and returns `{ onTarget, reachable }`. It runs
inside `stepFixed`, so the slew is deterministic and replay-safe like the drive, and the server and
Solo run the identical call off the identical stored `rec.aim`.

Two decisions worth keeping:

- **The aim is a world point, never a hull-relative angle pair**, and the slew, clamp and
  reachability answer all live below that seam. A bot brain naturally has a target's position, so AI
  aiming later is a new caller rather than a rewrite — and because the limits are below the seam, an
  AI-aimed station cannot snap where a player-aimed one slews. A test flies the same aim at a level
  hull and at one pitched and rolled and asserts both train to the same world direction.
- **An unarmed vehicle sends `null`, not zero**, so a remote can tell "no turret" from "turret
  pointing straight ahead" and does not draw a buggy aiming at the horizon.

The mesh gained a nested `elevation` cradle at the trunnion, exposed as `userData.elevation`, so the
gun pitches without tilting the pedestal with it. `mergeByMaterial`'s skip walk now stops at the
merge root, or merging a group that is itself in the skip set would have skipped all of its own
meshes. The simulation's `pivot` and the drawn trunnion are authored separately, so
`test-vehicle-meshes.mjs` asserts they agree — including that their z values are negations, since
craft meshes point their nose down -Z while the road model drives +Z forward.

**It fires (shipped 2026-09-02, protocol 21, Node-tested, unseen in a browser).** Step 2 of the same
plan, owner-triggered only.

`fireVehicleTurret(rec)` returns one round or null, following `fireAgm`'s seam exactly: it decides,
the caller acts, because the server resolves into its room with lag compensation and Solo only
presents the effect. It refuses on four counts — no trigger, no ammunition, cooldown unpaid, or the
barrel **not yet trained**. That last one is the AC-130's rule (`fireMount` refuses rather than
firing wide) and it is what makes the slew rate matter in play rather than only in the picture.

Rate of fire is a cooldown debt paid down in the fixed step, so a fast tick cannot spray and a slow
one cannot swallow rounds. There is no rearm: a fresh UGV comes with a full mount, as the Sentinel's
rack does.

On the server, `fireShot`'s hitscan tail was extracted into `resolveHitscanShot(room, shooter,
weaponId, weapon, origin, dir, excludeMobId)` and the station calls it, so a vehicle round is
resolved by **the same code, with the same pose-history rewind**, as a round from a hand weapon.
The station only fires while its owner is connected and at the stick; a stale trigger on a vanished
operator would otherwise leave a UGV shooting at whatever it was last pointed at.

The gun is `ugv_mg` in `weapons.js`, marked `vehicleOnly`. `getWeapon` reaches it so the shot path
is unchanged, but it is absent from `BASE_GAME_WEAPON_IDS`, so `sanitizeBaseGameLoadout` refuses it
and `enabledWeapons()` skips it — it can never end up in a hand. It carries the same muzzle and
tracer FX contract every other gun does; the one hand-weapon field it lacks is `model`, because
nothing holds it, and `test-weapons.mjs` asserts exactly that of a `vehicleOnly` entry.

Client: at a station's stick the mouse slews the sensor and the sensor line is sent as the aim every
tick (`turretAimPoint`, the ground if the line meets it and a 300 m reach if it does not, because a
turret shoots roughly level where the missile sensor only ever looked down). The trigger is **held**,
not an edge — a machine gun, not the missile release. The chase camera rides behind the *aim*
(`placeCamera`'s `aimDir`) rather than behind the hull, so the mouse turns the view and the gun
together while the vehicle carries on driving wherever it was pointed. Entering a station sets the
look down its own barrel, with a half turn added because `sensorDir` points -Z at yaw 0 while the
road model's forward is +Z. The view eases the drawn angles rather than snapping them: the wire
arrives at 20 Hz and the slew is already rate-limited in the simulation.

**Two things the first cut got wrong, both found by driving it.**

*The sight barely moved.* `cameraSensitivity` is already radians per pixel — `base-game-pointer-look.js`'s
`consume()` uses it raw, and the default 0.002 gives a 90 degree turn in 785 px on foot. The sensor
handler multiplied it by a second rate (`0.0022 * (fov / 30) * cameraSensitivity`), so the effective
rate was about 450x too slow: **184,655 px** to swing a turret 90 degrees, and 357,000 px on the
missile sensor, which had the same bug and was equally unusable. The rate is now scaled only by the
field of view actually on screen against the player's own first-person 62 degrees, so a sight feels
like the hand does on foot and a zoomed sensor properly slows: 840 px at the turret's chase view,
1,623 at the sensor's 30 degrees, 4,869 at its 10.

*The HUD was drawn for the wrong viewpoint.* A vehicle stick fell through to the "flying the craft"
branch, which feeds `drawFlightHud` the **craft's** forward and up. That was right while the chase
camera sat behind the nose, and wrong the moment the camera moved behind the aim: the horizon,
ladder and heading were all drawn for a viewpoint that was not on the screen. At a station the HUD
now takes its frame from the camera, reports rounds remaining, and drops the aircraft's `PULL UP`
descent warning, which a ground vehicle cannot earn.

**Still one-sided.** Nothing can shoot a vehicle back: `damageBaseGameVehicle` exists and nothing
calls it, and there is no `vehicleHitVolumes` beside the drones'. Step 3 of the plan.

Assembling from primitives cost 44 and 85 parts, and `buildCraftMesh` disables frustum culling on
every one, so each was a guaranteed draw call against a 6-18 house average. `mergeByMaterial` bakes
the static parts into one geometry per material — relative to its root, not the world, or a wheel's
spin group would take its pivot offset twice — and each wheel's rings merge separately so the pivot
still steers and the spin group still rolls. Both vehicles now draw in 14 meshes, at 1,528 and
2,920 triangles, next to the Sentinel's 12 and 2,556.

The combined craft view retains the drone API, caches one held mesh per gadget kind, consumes live
Solo records without wire serialization/sanitization, and reuses the player camera's obstruction
query for ground chase cameras. Controls are movement keys plus Ctrl handbrake; F takes/releases an
owned UGV remotely, B sends it, N recalls it, and E enters/exits a nearby buggy.

Coverage: `test-base-game-vehicles.mjs`, `test-city-vehicle-model.mjs`,
`server/test-base-game-vehicles-room.mjs`, `test-vehicle-meshes.mjs` (drawn track and wheelbase
equal the def's, tyre bottoms at `-clearance`, front wheels at -Z, roll and steer survive the
merge, a stretched def moves the wheels — which is what stops the two drifting apart again, the
UGV's bands match the intake table, its turret group survives the merge, and every part encloses
positive volume, since the hull loft's first winding was inside-out and nothing else caught it),
plus the existing drone, player, session and room suites.
There are still no vehicle hit volumes, collisions with actors/trees/other vehicles, rollover,
passengers, seated animation, first-person seat view, turret, or nav-grid routing.

### NPC bots, slice 2: the server (shipped 2026-08-27, Node-tested, unseen in a browser)

Plan: [2026-08-27-base-game-npc-bots.md](../superpowers/plans/2026-08-27-base-game-npc-bots.md).
The bot-viewer-v3 brain runs in the room as `bot-brain.js` (see `bots.md`, "The brain as a
module"); `server/base-game-npcs.js` hosts one brain per room.

**An NPC is a client with no socket.** `makeNpcClient` builds the same record `makeClient` does
(`npc: { team, role }`, `team`, `npcSpawn`, a rolled `appearance`), with a controller at the
harness speeds (`NPC_WALK_SPEED` 2.4 m/s, run x1.7). `stepClient` hands it to `stepNpcClient`,
which asks the brain for this tick's intent (`tickInputFor`: the bot's wanted velocity becomes
`moveX/moveZ/sprint` in the controller's frame, `yaw` is the bot yaw plus pi, `pitch`, `stance`
from `bot-stance.js`, `aim` in AIM/FIRE, `fire` when the brain's `fireBotShot` hook fired this
think, `reload` on the brain's reload edge) and pushes it through the ordinary `consumeTick`, so
the trigger, ammo store, hurt rig, `fireShot`, `applyDamage`, respawn and the snapshot are all the
player's. The brain thinks at 60 Hz (`room.npcs.think` before the client loop); its ammo copy is
overwritten from `room.ammo` every tick; players are handed to it as `worldEntities` on their
team; `applyDamage` forwards every hit to `brain.damaged`, which is what makes a bot flee, report
to allies and drop a dead target.

**Zone grid.** 384 m at 1.5 m around the connected players' centroid (never a bot), heightfield
walkability (rise to any neighbour <= 1.3 m, above sea level), `buildLazyVisibilityField` and crest
corners at the env constants (span 4.5 m, far 24 m), rebaked at 96 m of drift. **The bake is
sliced**: each cell is sampled once, 2 ms of sampling per think, then `finalizeNavGrid`, the
visibility field and the corner map each in their own tick (10 / 3 / 30 ms on a v5 world), and the
old zone stays live meanwhile. It was one call at first, which on a v5 world was 812 ms inside a
single tick and ran again on every spawn; the room's quarter-second catch-up cap then dropped time
for everyone in it, which is what "bots freeze, then all fight at once, and the UAV jerks" was
(2026-08-27, first browser session). A patrol ring (8 points at 40 m plus every spawn anchor)
gives `updatePatrolMovement` something to walk, which the harness gets from its layout; a new
anchor joins the live ring without a rebake.

**Gate N1, measured** (`bench-base-game-npcs.mjs`, `--v5 --fight`, one player, sea off): 16 bots
0.58 ms per 120 Hz tick, 32 bots 1.0 ms (budget 8.3); worst 100 ms of sim 10-15 ms of wall time.
Analytic world: 16 bots 0.3 ms per tick. `room.npcs.stats` carries the brain's breakdown (think,
sync, input, rays, heightAt, visibility, bakes). Before the `holeAt` cache in `terrain-source-v5.js`
the same bench read 2.2 ms / 4.4 ms, and a CPU profile put 65% of the server in the density field:
every `stepClient` on a v5 world asked `hasTerrain` about five times, and each call scanned a
density column (~60 `fbm3` samples) to decide whether the point is a cave mouth. Human players paid
that too, which is why a room lagged with only a handful of bots. The brain was never the cost.

**Service profiler.** `step()` in `base-game-rooms.js` times every wake-up and each phase inside
`stepRoom` (prepare, npc think, clients, projectiles, drones) plus the 20 Hz snapshot broadcast
(ms and bytes sent). Once per second it prints `[base-game prof] ...` when the longest wake-up
was 12 ms or more, or a gap between wake-ups passed 50 ms; set `BASE_GAME_PROF=1` to print it
every second while NPCs exist. That line is what to paste when a session feels laggy: a long
`clients` phase is the controller/world cost, a long `think` is the brain or a bake, a long gap
is something else on the event loop. The audit of this work, with the open items (`npcAccuracy`
unwired, Solo bots, rig cost unmeasured), is `docs/superpowers/reviews/2026-08-28-base-game-npc-bots-audit.md`.

**Protocol 14.** Player entries carry `team` (players 1, enemy NPCs 2), `npc`, `appearance`
(`{ skin, hair, expression }`, names from `bot-face.js`'s tables). Shared keys `npcRespawn`,
`npcNoticeMs`, `npcAccuracy`, `npcFriendlyFire` (gates `applyDamage` for everyone; self-damage
always counts), `npcSpawnDistance`. Owner message `base:npc` `{ action: 'spawn'|'clear', team,
count, role, at }`; `at` is the aimed point for the slot-9 spawner (slice 3), else the side marker
(friendly beside the requester, enemy `npcSpawnDistance` along their look). Bots vanish on a
terrain change (they belong to the ground they stood on) and, with respawn off, 3 s after death.

**Measured** (`server/test-base-game-npcs-room.mjs`, analytic world, sea off): 4 bots walk,
300 shots and 19 hits in 60 s, hits only across teams, respawn off removes the dead, clear
empties the roster. Not done: the client (slice 3: team tint, panel, faces, the spawner), N1's
cost curve, cover behind crests seen in a browser, tree occlusion (the server has no trees), and
the spawner refusing a point in the sea (today it falls back to the aimed point).

### NPC bots, slice 3: the client (shipped 2026-08-27, unseen in a browser)

- **Bodies.** An NPC arrives in `players[]` like anyone else and is drawn by
  `base-game-player-bodies.js`'s remote path. Two additions: a body with `npc` takes its tint from
  `BASE_GAME_TEAM_TINTS[team]` (green friendly, red enemy; players keep their identity hue), and a
  body with `appearance` is composed with a human head (`composeBot(model, 'human',
  { expression })`) and the named `SKIN_TONES`/`HAIR_COLORS` from `bot-face.js` as its per-body
  palette, which `setTint` leaves alone. The face is part of the record key, so a changed face
  rebuilds the body. Soldier kits keep their helmets (no head swap) and only take the tints.
- **Panel: "NPC bots".** Toggles `npcRespawn`, `npcFriendlyFire`; ranges `npcNoticeMs`,
  `npcAccuracy`, `npcSpawnDistance` (all shared keys, so guests see them disabled); a role
  select; buttons Add friendly / Add 4 friendly / Add enemy / Add 4 enemy / Clear bots, sent by
  `session.sendNpc`. Solo shows a note: bots need a room for now (the loopback room is not built).
- **The dev gun, key 9.** A tool mode over the held sidearm rather than a seventh slot: `9`
  cycles off → bots → lights → vehicles → sentinel → off and draws the sidearm (so the laser has a muzzle). The trigger
  stays quiet while any tool is up; the combat HUD shows the current tool, pick and last result.
  - **Bots** (first press — the old spawner, unchanged): click sends `base:npc` with
    `aimed: true` and the server casts the requester's own look ray (`aimedGroundPoint`: world
    query to 300 m, then the ground marched out to 1.5 km); `R` cycles side and role.
  - **Lights** (second press): hold click to charge (1.5 s window, environment-viewer's) and
    release to shoot a light out; `E` drops one at the crosshair (`updateLocalAimPoint`, called
    directly since it otherwise only runs while aiming); `R` cycles the kind preset. The sim is
    the environment-viewer entity layer run purely locally — `entity-registry.js` with
    `entity-types/light.js` + `entity-types/projectile.js`, ticked in the fx frame block with
    the global-space ground (`terrain.groundHeight`, `-1e9` in map worlds, so non-floating
    lights fall out of maps) — rendered through `point-light-pool.js`, a fixed pool of
    `DEV_LIGHT_SLOTS = 8` resident `THREE.PointLight`s (intensity-driven, never `.visible`;
    reject-newest past the pool, with a HUD note). A ninth resident point light is the held
    lantern: on while the light tool is up (`devLightHeld`), ramped like the flashlight, showing
    the live `devLight*` colour/reach at the muzzle. Kinds (`lantern`/`ember`/`floater`/`flare`)
    are presets that write the `devLightKind`/`devLight*` settings; touching a slider flips the
    kind to `custom` (the `fpPreset` rule). Panel section "Dev gun lights (9)" under Player.
    Nothing is replicated — like the flashlight, the lights are yours alone.
    Reach (`devLightRadius`) runs to 600 m, matched by the clamp in `entity-types/light.js`, so a
    light can be placed high enough to matter from the air. Reach is only the cutoff distance: the
    falloff inside it is `1 / d^decay`, so reach alone does not carry a light's brightness across
    that distance. Falloff (`devLightDecay`, 0..4, default 2) is that exponent, carried per light
    through the entity params and applied per slot by the pool, so 2 stays physically correct while
    lower values reach further and 0 holds full brightness out to the cutoff. It applies to placed
    lights, shot lights in flight, and the held lantern alike.
- `npcAccuracy` is on the wire and in the panel but **not read by the server yet**: an NPC's spread
  is the player trigger's. `npcNoticeMs` reaches the brain as `reactionMs`.

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
the root only), a `residencyRevision` counter bumped whenever the resident chunk set changes (so a
caller that bakes over the terrain — the rain shadow — can tell staleness from a mere camera move
without watching every chunk itself), debug views (wireframe, `MeshNormalNodeMaterial` normals view, per-chunk
`Box3Helper` tile bounds, a magenta contact marker on the probed ground under the player) and a
`stats` block (source kind/key/version/algorithm/bounds, lod, resident/stale/target/queued/in-flight
tiles, draws, triangles, installs per second, `lastUpdateMs`, epoch, worker, `lastSourceError`,
collision-provider id/enabled/colliderId). Two caveats on that block, from the 2026-08-29 terrain
audit: `installedTotal` / `installsPerSecond` count residency *growth*, so both read zero during
steady travel when the window neither grows nor shrinks (`F-15`), and `staleTiles` can only ever be
zero while `restream` drops rather than retains (`F-10`). `frameCost` is the per-frame split and now
reuses one object — read it, copy it if you keep it. `setActive()` switches collision and visuals together;
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

### Weather, phase C1: cloud decks (shipped 2026-08-24)

Two `clouds.js` decks behind `base-game-clouds.js`, per the
[weather plan](../superpowers/plans/2026-08-23-base-game-weather.md). The module owns the three things
the donor pages (`environment-viewer-v2.html`, `demos/flight-sim.html`) never had to:

- **The render origin.** Cloud noise is a function of `positionWorld.xz`, so a rebase would teleport the
  whole field. `update()` writes `worldCoordinates.getOrigin()` into each deck's new `setOffset`, and
  positions the deck at `height − origin[1]` so its altitude is render-local while its pattern is global.
- **Time of day.** A `Clouds` is white on its own and would glow at midnight. The page passes
  `rig.dirLight.color` and `sky.nightness`; the module tints by the key light and multiplies down by
  `nightDim · nightness`, so dusk reddens the decks and night leaves them a silhouette against the stars.
- **Lightning (2026-08-27).** The tint is a *colour*, and no intensity has ever entered it, so a bolt
  could not brighten a cloud. `update()` now also takes `flash` — the same 0..1 term the drops
  brighten on, `rain.uniforms.uLightning` scaled by `cloudLightningLift` — and lerps the tint toward
  `cloudFlashTint` (`#e8f0ff`, blue-white). It is applied **after** the night dim, deliberately: a
  bolt lights the cloud base itself and must punch through the night rather than be scaled down by
  0.85 along with the moonlight.
- **The far plane.** `updateWorld`'s `wantFar` now takes `max(terrain far, clouds.farExtent)`, where a
  deck's far extent is `hypot(extent/2, height)` — the distance to its own far corner — counted only
  while it is visible.

Defaults are deck A at 900 m over a 20 km extent and deck B at 2,200 m over 40 km, which are **not** the
env-viewer defaults (120 m / 280 m over 8 km). Those suit a sandbox; this page draws terrain to
kilometres, so the decks start at an altitude you could fly through, as the flight-sim deck does.

**Where a deck ends.** Alpha is `cloud · opacity · haze · edge` with `edge = smoothstep(1, edgeStart,
norm)` and `norm = |xz − camera| / (extent/2)`, so it reaches zero on a circle inscribed in the square
and the plane's own corners (`norm = √2`) are already past zero — the straight edge of the quad can never
be seen. What can be seen is where that circle sits in the sky: `atan(height / (extent/2))` above the
horizon, which the panel prints beside the extent slider (`deckHorizonAngle`). At the defaults that is
5.1° for deck A and 6.3° for deck B, i.e. a band of clear sky under the clouds. Three controls close it:
a wider extent, a lower deck, and the two numbers that used to be hard-coded in `clouds.js` — the
dimming floor (was 0.25) and where the rim fade begins (was 0.85 of the radius). Floor 0 with an early
rim start dims the deck continuously to nothing and leaves no perceptible boundary. Scene fog (phase C2)
is the other half of the answer, because it tints distant cloud into the horizon colour.

`applyCloudSettings()` is the same dirty-checked apply as the water one: an octave change disposes and
rebuilds that deck's material (octaves are baked into the TSL graph), everything else is a uniform write.
The panel nests two levels — **Weather > Clouds > deck A / deck B / appearance** — which needed three
additions to `workshop-panel-theme.js` (a taller `max-height` for a body holding sections, lighter nested
heads, no hover lift on a nested card) and two new panel helpers in the page, `addColor` and `addAction`.
Section state is keyed by heading text, so every heading in the panel must stay unique.

### Weather, phase C2: overcast, light response and fog (shipped 2026-08-24)

The weather master (`weatherRain`) exists now and drives three things through their own **response**
sliders, so a hand-tuned value is never overwritten by a drag of the master:

- **The overcast lid.** `sky.js` gained an `overcast` uniform mixed in at the end of `skyColorAlong`
  toward a grey that is brighter at the horizon than overhead, plus `setOvercast` / `setOvercastColor`.
  It defaults to 0, so every other consumer is unaffected — and because `skyColorAlong` is what
  `sky.colorAlong` exposes, the water's sky-reflection mode greys with the sky for free. `applyDome`
  lerps `scene.background` toward the lid as well.
- **The light.** The key light (sun or moon, whichever owns the frame) is scaled by
  `1 − sunDimPerRain · rain` and the ambient lifted by `1 + ambientLiftPerRain · rain`, so an overcast
  noon reads flat rather than merely dark. The ambient is multiplied on `rig.ambLight` after both
  time-of-day branches have written it, so it cannot compound.
- **Fog.** `scene.fog` is a `FogExp2` attached at startup with density 0. This is deliberate and was
  checked against the shipped r184 build: fog colour and density become `reference()` nodes, so writing
  them costs nothing, but attaching `scene.fog` for the first time goes into every material's cache key
  and would recompile the world on the first drop of rain. The panel quotes density as the distance at
  which fog reaches 63% (`1/density`), because that is the number a person can picture.

**Why the cloud decks are not fogged.** exp2 fog is `1 − exp(−(d·z)²)`. At 0.0002 — light enough to be
2% at 500 m — it is already 98% at deck A's 10 km rim and total at deck B's 20 km. Scene fog would erase
the decks rather than soften their edge, so they keep `clouds.js`'s `fog: false`. The lid is what makes
the rim disappear: at full overcast the sky behind the clouds is the same grey as the clouds.

**Fixed 2026-08-24 (found in the browser).** The ambient lift shipped as
`rig.ambLight.intensity *= 1 + ambientLiftPerRain · rain` and turned the whole screen white within a
second of raising the master. `createLightingRig`'s `set()` (`lights.js:73`) returns early when the
*requested* value has not changed, and it tracks that request separately from the live light — so on
every frame after the first the rig wrote nothing and the multiply stacked: 1.15× per frame is about
4400× after one second. Both day/night branches now assign their requested ambient to a local
`ambientBase` and the lift is `ambLight.intensity = ambientBase · (1 + …)` — an assignment, so it is
idempotent whether or not the rig's setter fires. `sunIntensity`/`moonIntensity` were never affected:
they are locals recomputed each frame and handed back through `rig.setSunIntensity`. Guarded by
`test-base-game-light-response.mjs`, which runs the response for 600 frames and asserts it equals one
frame, and keeps the old multiply in the file as the thing being guarded against. The general rule
this is an instance of: **do not write a rig-owned light directly from the frame loop** — a
dirty-checked setter makes any read-modify-write on the object it owns compound.

**Fixed 2026-08-27: the lid follows the night** ("why is it so light at night when raining?"). `sky.js`'s
`overcastColor` uniform is a fixed daytime grey (0.42, 0.44, 0.48) and `applyDome` lerps
`scene.background` toward it with no nightness term, so at full rain (`overcast` saturates at
rain 0.8 with the default `overcastPerRain` 1.25) a midnight sky sat at 5.6x the luminance of a
clear one — and the sky-sourced fog painted the whole distance with the same grey while the
weather dimmed the actual lights. The page now owns the lid colour: two **local** settings,
`overcastDayColor` (`#6b707a`, exactly the sky.js default so day is unchanged) and
`overcastNightColor` (`#232936`, ~2x the clear-night dome bottom, so a lidded night is a little
brighter than a clear one — trapped light — but still night), blended by `sky.nightness` with
`lerpHex` in `applyAtmosphereSettings` and pushed through `sky.setOvercastColor` and a new
`clouds.setOvercastColor` (`base-game-clouds.js` forwards it to both decks and re-applies it on an
octave rebuild — the deck material's own overcast grey is also a fixed daytime constant). The fog
inherits the corrected colour through `scene.background`; the water's sky reflection through the
dome uniform. The colours are look, not weather, so they stay off `BASE_GAME_SHARED_KEYS` like the
rest of the cloud appearance. Guarded numerically in `test-base-game-light-response.mjs` section 7.

### Weather, phase C3: shared world keys (shipped 2026-08-24)

Six weather keys are owner-owned and replicated: `weatherRain`, `weatherOvercast`, `cloudACover`,
`cloudAHeight`, `cloudBCover`, `cloudBHeight`. They are what the weather *is*. The response curves
(`overcastPerRain`, `sunDimPerRain`, the fog pair), the fog colour and every cloud look and quality
setting stay local — the same split the wave spectrum uses, where the physics is shared and the
appearance is not. Two players in one room therefore see the same weather but may draw it differently.

The change was confined to `base-game-protocol.mjs` (`BASE_GAME_SHARED_KEYS` and `NUMBER_LIMITS`).
`server/base-game-rooms.js` needed nothing: it sanitizes a patch and `Object.assign`s it into
`room.world`, and it does not simulate weather — no movement or collision code reads it, so this is
state carriage, unlike the terrain and the wave spectrum. The page needed nothing either, because
`sharedSettingKeys` is derived from `BASE_GAME_SHARED_KEYS`, so the new sliders disable themselves for
guests and queue patches on their own. There is no protocol version bump: the sanitizer omits keys it
is not sent, so a client without weather carries none and everyone keeps their own.

`test-base-game-shared-keys.mjs` guards the seam that has no other guard — the protocol's `NUMBER_LIMITS`
(the wire and the server) against the page's (slots and JSON files). A disagreement there silently
rewrites a legal local value the moment it crosses the network. The test covers every shared key and
reads the protocol's boolean/string key sets from source so it cannot fall behind.

### Weather, phase R1: rain (shipped 2026-08-24)

`base-game-rain.js` wraps `rain.js`'s instanced streaks and splash rings the way `base-game-water.js`
wraps the wave surface: it owns the render-origin offset, the ground hook, the enable rules and one
`update(dt, camera, {underwater, skyColor})` that the page calls in its own `weather` profiler slot.
Wet ground, the rain shadow map, lightning and the rain bed are later phases.

**The ground drops land on.** There is no analytic terrain height here as there is in the flight sim,
so the hook is `terrain.seaDepth.gpuHeightAt` — the 16 m sea-depth clipmap window. Rain calls
`terrain.setSeaDepthActive(true)` itself, because a world with the sea turned off would otherwise have
no window streaming and no ground at all. The height comes back global and the graph subtracts the
render origin's Y, so drops keep cutting at the right height across a rebase. Where the ground is
below sea level the hook maxes with the sea level, so rain over water lands on the surface rather than
the sea bed. In the Traversal Lab there is no window: a uniform mixes the whole hook to the lab's flat
floor (y = 0) instead, with no branch in the graph.

**Accuracy on a cliff (plan item R1b, parts 1 and 3).** Both rain materials leave `depthTest` on, so a
ground height read too *low* is hidden by the depth buffer while one read too *high* shows as rain cut
off in mid air in front of a rock face. The error is therefore asymmetric and the sample must be
conservative: `gpuHeightAt(xz, fallback, 'min')` returns the lowest of the four surrounding posts
instead of the bilinear blend (the same trick as `terrain-lod-coverage.js`'s `erode()`). Both branches
live in the graph and a uniform mixes between them, so the toggle is a slider and not a rebuild.
Separately, a horizontal splash ring on a 40° slope is half buried and half floating however accurate
its height is, so `rain.js` now takes an optional `groundSlope` hook: rings fade out above 38° (over a
12° band) and the survivors lie on the surface normal. The slope is central-differenced from the
*bilinear* sample one post apart — the min filter is a staircase whose differences are zero across
most of a cell. The fine 1.25 m near-window (R1b part 2) has not been built; the panel's ground-source
select carries `coarse` and `off` today and gains `fine` when it exists.

**Wind is shared, look is local.** `weatherWindDeg`, `weatherWindSpeed`, `weatherGust` and
`weatherGustPeriod` join `BASE_GAME_SHARED_KEYS`: wind leans every peer's drops the same way, and it
is what the wave heading already agrees with. The drop and splash budgets, colours, volume, near fade
and ground settings stay local, so two players can run 40,000 drops and 2,000 drops in one storm.
`weatherWindFollowsWaves` (local, on by default) makes the page *use* `waveWindDeg` rather than write
it into the shared slider, so a guest follows the sea without needing permission to write a shared key.

**The master fan-out.** `rainResponse(settings)` — exported so it is testable in Node — turns
`weatherRain` into a drop density and an opacity through `rainDensityBase`/`rainDensityPerRain` and
`rainOpacityBase`/`rainOpacityPerRain`. As with the C2 atmosphere response, the master multiplies
through a response slider instead of writing the individual value, so a hand-tuned number survives a
drag of the master.

**Things that used to be constants in `rain.js` and are settings now**, all defaulting to the value
that was baked in so `bot-viewer-v3.html` and `demos/flight-sim.html` draw exactly what they drew
before: the near fade (`smoothstep(0.25, 1.4, …)`), the camera lean, the splash generation rate (1.6/s)
and the gust period (the 0.37 rad/s wander was a ~17 s cycle). Ring slope suppression and orientation
default to off for the same reason.

Coverage is `test-base-game-rain.mjs` (65 checks): the fan-out, the wind conversion, the slope window,
a CPU twin of the conservative-versus-bilinear claim, the module built for real over a real sea-depth
window (allocation rebuild, visibility gates, rebase), and headless GLSL builds of both rain graphs —
with the hooks and without, so a regression for the other two pages fails in Node. Unseen in a browser.

### Weather, phase R2: wet ground (shipped 2026-08-24)

Rain darkens the ground, drops its roughness, pools puddles on the flats and bends the normal with
ripples. Two consumers, one copy of the maths: `rain.js` exports `wetPuddleField`, `wetRippleOffset`,
`wetAlbedoScale` and `wetRoughness`, and both `applyWetSurface` (props, walls, the Traversal Lab) and
`terrain-splat-streamed.js`'s new `rain` bundle import them. The plan had called for a second copy
with a hand-sync note; one import is better, because rain beading differently on the terrain than on
the wall standing on it is exactly the drift that note would have been apologising for.

**The rain bundle** is `{ uniforms, offset, puddleScale, rippleScale }` beside the existing `water`
one, bound once at startup by `terrain.setSplatRain(rain.groundShade)` — not on first rain, because
the graph gates on the wetness uniform and rebuilding every splat instance mid-session is a visible
hitch. `offset` is the render origin, so puddles are anchored to global XZ and stay with the ground
across a rebase.

**Rain and the waterline compose rather than fight.** A single `submerged` term is computed before
either branch: the water branch darkens the albedo and glosses the tide strip by it, and the rain
branch is multiplied by `1 − submerged`. So the seabed gets no puddles, and neither effect
double-darkens a fragment the other already darkened.

**Wetness lags the master.** This is what neither donor page has — in both of them wetness tracks the
rain slider directly, so ground goes bone dry the frame a storm stops. `base-game-rain.js` owns the
uniform and chases the target with a time constant: 8 s rising, 90 s falling, both sliders. It is
advanced on every frame including those where nothing is drawn, so a storm that ends leaves the
ground drying rather than frozen; a zero constant snaps rather than dividing by zero.

The Traversal Lab's materials are now exposed (`traversalLab.materials`) and decorated with
`applyWetSurface`. They carry a plain `color` and no colour graph, and `applyWetSurface` skips the
albedo darkening when there is no `colorNode` to wrap — so they pass `baseColor: materialColor`
explicitly, or they would go glossy in the rain without going dark. That behaviour is now stated at
the line in `rain.js`; it was left opt-in rather than defaulted so the other pages keep their look.

**Deferred:** `applyWetSheen` on player bodies and weapons. `base-game-player-bodies.js` owns those
materials and another session is mid-rewrite there for the server hit rig, so the three sheen
settings were dropped rather than shipped as sliders that do nothing.

**WebGPU audit, 2026-08-24.** Four defects, three of them introduced by R1/R2 and none caught by a
test, found by auditing the page against `.claude/skills/improve-webgpu`:

1. **The wet-ground maths was not behind a uniform branch.** R2's doc comment claimed it was; the
   code had a JavaScript `if (rain)` at graph-build time, which decides whether the code is *emitted*,
   not whether it *runs*. Measured on the generated GLSL: the rain bundle adds 315 fragment-shader
   lines and 4 noise evaluations, and they sat at brace depth 1 in `main` — unconditional, on every
   ground pixel of every frame, in a world with no rain in it. Now wrapped in
   `If(uWetness > 0)`, which moves the noise to depth 2 for 11 extra lines. A uniform branch is
   coherent across the draw, so a dry world skips all of it.
2. **A reallocation orphaned the ground's uniforms.** `createRainSystem` built a fresh uniform set
   on every call, so moving the max-drops slider handed the drops a new set while the splat's
   compiled graph still held the old one — the ground froze at `RAIN_DEFAULTS.wetness` (0.8),
   permanently wet whatever the weather, and leaked a fallback texture per rebuild. `createRainSystem`
   now accepts `uniformSet`, and `base-game-rain.js` builds one set for the life of the page.
3. **`applyRainSettings` did full work every frame** — a response object, a look object and two
   `Object.entries` walks, about 43 short-lived allocations per frame. Measured 5.5 µs against
   0.6 µs dirty-checked, so ~5 µs a frame: small, but `applyCloudSettings` and `applyFloraSettings`
   beside it already gate, and now so does this.
4. **The combat HUD wrote `innerHTML` every frame** (pre-existing, not from the weather work).
   Health, ammo and the hit flag hold still for seconds at a time, so nearly every write reparsed
   identical markup. Both it and the damage-flash opacity now write only on change.

All four are locked down in `test-base-game-rain.mjs`, which reads the generated GLSL for the branch
depth rather than trusting the comment that was wrong the first time.

### Weather, phase R4: lightning, thunder and the rain bed (shipped 2026-08-24)

`base-game-lightning.js`. **Nothing about lightning crosses the network.** A strike is a pure
function of the shared `weatherSeed` and its own index, so two clients in one room see the same bolt
in the same place at the same moment because they each computed it. That also puts a late joiner in
phase with no catch-up. The clock is `playerController.waterTime` — the lockstep tick the swell
already rides, and the one clock the client and the server agree on.

**The schedule is a fixed grid, not an accumulation**, which is a deliberate change from the plan.
The plan scaled each gap by the current rain; that makes strike *n*'s time depend on the whole
history of the rain slider, so an owner dragging it mid-storm would move strikes that had already
happened and two clients with different slider histories would diverge. Instead, strike *n* owns the
slot `[n·interval, (n+1)·interval)` and a hash of `(seed, n)` places it inside, scaled by
`intervalSpread`. Rain gates whether a scheduled strike *fires*, through `lightningThreshold`, rather
than moving when it happens. Three things follow, all tested: clients at 24, 60 and 144 fps fire the
same strike indices; a client joining at t = 500 s is immediately in phase; and the per-frame window
search is O(1) in the age of the room, because a strike is always within half a slot of its slot
centre. A clock jump — a pause, a tab switch, a reconciliation — resyncs rather than firing every
strike in the gap.

Placement uses `sqrt` of the interpolated squared radius, so strikes are uniform over the annulus
between `lightningDistMin` and `lightningDistMax` instead of crowding the inner edge. The bolt runs
from the low cloud deck's height down to the ground the sea-depth window reports at the strike point,
in scene space, so a rebase does not move it.

**The sun lift never touches the light.** `lightning.sunLift` is added to the `sunIntensity` that
`updateWorld` hands to the rig — the same discipline the C2 ambient fix established, because
`createLightingRig`'s setter dirty-checks the requested value and will not undo a direct write.

**Audio** is registered with `base-game-audio.js` rather than started from the page, so mute, the
mixer and the underwater low-pass have one owner. The generators (`createRainBed`, `playThunder`)
are injected from `rain.js` rather than imported by the director, which keeps it free of rain.js and
lets a test watch the calls without a WebAudio context. Thunder is queued at `distance / soundSpeed`
and shares the existing per-event budget, so a close storm cannot stack claps. The bed follows the
drop density and stops when the game is paused.

Seven keys joined the shared set: `weatherSeed`, `lightningEnabled`, `lightningThreshold`,
`lightningInterval`, `lightningIntervalSpread`, `lightningDistMin`, `lightningDistMax` — every input
to the derived schedule. Flash strength, decay, bolt scale, sun lift and the speed of sound stay
local. Coverage is `test-base-game-lightning.mjs` (61 checks).

### Key-light colour: a blend, not a switch (fixed 2026-08-27)

Two reported symptoms, one line. `updateWorld` decided the key light's **colour** with the same
boolean that decides which body owns the shadow map:

```js
const moonOwnsShadow = moonIntensity > sunIntensity;
```

The shadow has to be a boolean — r184 disposes a light's `ShadowNode` the moment `castShadow` flips
false while render objects built earlier still update it, which is the null-`depthTexture` crash at
dusk this page already works around. Colour has no such constraint, and switching it at the same
instant is what made dusk jump. Measured: `sunIntensity` (`settings.sunIntensity · smoothstep(-2, 8,
elevation)`, max 4) falls to 0.342 at sun elevation **−0.20°**, where the moon's `TOD_MOON_MAX` of
0.35 takes over, and the colour went from `#ffb066` — the warm/neutral blend is at 0 that low — to
`TOD_MOON_LIGHT` `#aec6ff` in a single frame. That is **175 of 255** in one 0.01° step. The clouds
take this very colour, so they cut with it.

The colour is now blended by each body's share of the light,
`lerpHex(lerpHex(WARM, NEUTRAL, sunWarmth), MOON, moonIntensity / (sunIntensity + moonIntensity))`,
memoised on both quantised inputs. The worst step across the same sweep is 1.7 of 255, and both
endpoints are byte-identical to before: this is a transition, not a recolouring.

**The lightning lift no longer decides who owns the sky.** It used to be `sunIntensity +=
lightning.sunLift` written *before* the comparison. `sunLift` defaults to 4 against a moon that caps
at 0.35, so every night strike flipped ownership to the sun — the next frame wrote `TOD_SUN_WARM` and
aimed `rig.dirLight` down `sunDir`, which at night points up from below the horizon. Clouds went
orange, lit from underneath, and snapped back when the lift decayed under 0.35. The lift is held in
`keyLift` and added to whichever body already owns the key light. Coverage is
`test-base-game-light-response.mjs` sections 4-6 (29 checks).

### Weather, phase R3: the rain shadow (shipped 2026-08-26)

A top-down height bake, so drops stop under a roof instead of falling through it. The renderer-side
work is `rain.js`'s `bakeOccluderMap`; what `base-game-rain.js` adds is **holding the bake in global
coordinates**. The texture stores `globalY − globalFloor`, which no origin shift can change, and the
two uniforms that address it (`uOccCenter`, `uOccFloor`) are recomputed from the render origin every
frame. So a rebase costs two uniform writes, where a bake stored in scene space would have to be
re-rendered. The floor comes from the bounds of the roots being baked, less a 30 m margin, so the
half-float texture spends its precision on the relief in the window.

**It also fixes a bug that predates the feature.** `roofAt` reported "no roof" as height 0, and both
callers do `max(roofAt, groundHeight)` — so every drop in this world was cut at scene y = 0, whatever
the ground under it was doing. With the sea on at the default sea level of 0 that is invisible,
because the water level already lifts the ground to 0. Drop the sea level, or turn the water off over
terrain that dips below zero, and the rain stopped in mid air at y = 0. `uOccMiss` is now set to the
same `noDataHeight` (−10000) the ground hook uses, once at construction, whether or not anything is
ever baked.

**`rainOccluders` has three values and defaults to `lab`.** The Traversal Lab is static, small and
genuinely roofed, so one bake sized from the lab's own bounds lasts the session. Open terrain is the
opposite: it streams, and there is nothing over it yet — no trees, no buildings — that the ground
hook does not already cut, so `on` there buys a sharper cut height inside the window and costs a
whole extra scene render per bake. That is the seam for when vegetation lands, not a feature anyone
needs today. In terrain mode the bake is player-centred and redone when the player leaves the middle
half of the window (a quarter of its width of walking) or when `terrain.residencyRevision` moves,
which is the terrain's own signal that the resident chunk set changed. A dry world never bakes.

The bake gets its own `rainBake` profiler slot rather than being folded into `weather`, because it is
a whole extra scene render and would otherwise read as rain randomly costing several milliseconds.
It runs in the frame loop before the encode, so it is outside the post/DOF pipeline. Coverage is in
`test-base-game-rain.mjs` (144 checks).

### The rain ground hook is two windows (fixed 2026-08-27, and R1b item 2)

Rain's ground hook was the 16 m sea-depth window alone. That window carries only `heights` — the
**base heightfield** — while the surface a player sees and walks on under volumetric terrain is
`surfaceHeights`, the marching-cubes open-sky surface. `base-game-terrain.js` switches field in
volumetric mode (`contactFields()`, `placementFields()`) and so does grass; rain did not, so it cut
drops on a surface that is not the one being drawn, and did not track volumetric ground at all.

`base-game-rain.js` now reads the terrain's own **contact field** first: lod 0, 1.25 m posts, 160 m
across, carrying `surfaceHeights` in volumetric mode. `gpuSampler(field)` returns its fallback
outside the window, so `mix(coarse, fine(global, coarse), uUseFine)` *is* the handover — fine ground
inside 160 m, the sea-depth window beyond it, and a drop where neither has streamed simply does not
cut. This is also weather plan R1b item 2, which specified a new window at exactly these numbers
before the contact field existed; nothing new needed building.

Three things follow from the window being shared and ref-counted:

- **The handle is held only while the source reads it.** `setGroundSource('fine')` acquires,
  `'coarse'` and `'off'` release, so nothing streams a window nobody reads. In Traversal Lab mode
  the page already passes `'off'`.
- **Binding follows the handle, and the rebuild is synchronous.** The registry disposes a window
  when its last holder lets go, and a TSL graph keeps the texture object it captured — sampling a
  disposed one is a black screen, not a missing height. So `setGroundSource` rebinds and rebuilds the
  rain materials in the same call rather than leaving it to the next `update()`.
- **A volumetric toggle is a different window.** `heights` and `surfaceHeights` are different
  registry keys, so the toggle hands back a new window with a new texture; `update()` compares
  identity and rebuilds.

The splash slope is central-differenced at `uSlopeStep`, which follows whichever window is answering.
16 m differences over a 1.25 m field would smooth away the detail the fine window exists to provide,
and rings only ever land within `splashRadius` (20 m) of the camera, always inside it.

`rainGroundSource` gains `fine` and defaults to it. `coarse` is kept — it is what shipped, and
switching between the two is the fastest way to see the bug it caused.

Next in the plan: R5 (capture, performance log and the remaining docs).

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
and `setSource` takes the new descriptor's value — including into `tileCover`, which holds its own
copy of the waterline to decide that a texel is drowned; before 2026-08-29 only `setSeaLevel` wrote
that copy, so applying a project with a different sea level derived flora cover against the previous
world's shoreline (terrain audit `F-08`, pinned by `test-base-game-sea-level.mjs`). The server world does the same (`sim.seaLevel`,
spawn above the water). The wave spectrum (`waveCount … waveSeed`, the `water-waves.js`
`buildWaveTable` inputs) lives in the Water panel section as shared world keys, so the room owner
tunes it and every peer simulates the same surface; `waveOptionsFromWorld(world)` maps them back
to table options. W2 (2026-08-23): the facade owns a `terrain-sea-depth.js` map (`terrain.seaDepth`, streamed only while `setSeaDepthActive(true)`, recentred on the player each `update`, restarted by `setSource`) that the water surface will read for thickness and the page for the visibility gate. W3 (2026-08-23): `base-game-water.js` renders the surface (`water` in the page: created after the sky, `setEnabled(waterEnabled && terrain mode)` / `setLevel(terrain.seaLevel)` / `setWaves(waveOptionsFromWorld(settings))` in `updateWorld`, `update(dt, camera.position)` in the frame loop under the `water` profiler slot). Its look loads from `water-config.json`'s `ocean` body, then the room's wave keys are re-applied so physics-relevant values never come from the file. The mesh hides while the depth window holds no ground below sea level (`water.state.reason`). W4 (2026-08-23): shoreline and refraction are per pixel — `thicknessAt` reads the opaque depth buffer (`viewportDepthTexture`, the water writes no depth) so the water ends exactly where the drawn ground rises through it and the shore foam sits on the real contact line; `bedColorAt` refracts the framebuffer (`viewportSharedTexture`) by the wave normal, scaled down in the shallows so dry pixels are never pulled in; `shallowFade` (2.5 m) in `createOceanSurface` ramps the displacement to zero at the beach so crests run out flat instead of rising through the sand. The 16 m window now serves only the vertex-stage damping and the visibility gate. Unverified: both viewport nodes inside the DOF `pass()` path. W5 (2026-08-23): reflection modes on `profile.reflMode` (`waterReflection` select: `sky` dome only, `planar` default, `ssr`). Planar is a TSL `reflector()` (own mirror camera, half-res target, uv rippled by the wave normal (the ripple weakening with distance, and the sample falling back to the sky colour wherever the rippled uv leaves the target — sampling off-target reads black, which put a dark strip along shorelines where fresnel is ~1)) whose `updateBefore` is wrapped the water.js way: one pass per application frame, every `reflectRate` (2) frames, only while the surface is visible and the camera is above the displaced surface, with the water mesh (and `excludeFromReflection()` objects) hidden for the mirror render; `water.reflectStats` counts passes/skips/ms. SSR is the demo's 32-step view-space march ported to the opaque depth buffer and framebuffer (`viewportDepthTexture`/`viewportSharedTexture`), edge-faded, falling back to the sky. Unverified in the browser: a camera-attached first-person weapon may appear in the mirror (nothing is excluded yet). W6 (2026-08-23): the ground material carries the water — `createStreamedSplatMaterial(..., { water })` takes the water module's `groundShade` bundle (scene-space waterline, global-xz offset, sun, clock, caustic strength/spread uniforms, `waveNormalFold`); every instance gets a wet tide band (darker albedo, roughness 0.22, waterline → +0.6 m) and the water-demo's analytic Snell caustic as `emissiveNode` (sun ray refracted at the flat surface with the live wave normal, screen-derivative area ratio, depth fade, sun-elevation gate — inside the branch, not after it: a low sun made the refracted ray near-horizontal, `depth / -r0.y` went to infinity and the NaN rendered as black speckles along shorelines, which a trailing `× saturate(sunDir.y)` could not clear because NaN × 0 is NaN; the divisor is floored at 0.15 and the whole trace is skipped below 0.12 sun elevation). `terrain.setSplatWater(shade)` rebuilds the instances with it; disabling the water sinks `sceneLevel` to −1e9 so both parts vanish without a rebuild; `waterCaustics` toggle → `setCausticStrength`. W7 (2026-08-23): underwater. The surface is `DoubleSide` so it exists when seen from below; a clip-space overlay quad (`fogQuad`, renderOrder 998, depth-test off) tints and fogs the frame by scene depth — `1 - exp(-viewDistance · fogDensity)` capped at `fogMax`, coloured from the profile's deep colour — shown only while `water.underwater` (camera below the displaced surface, from the CPU wave sampler). A scene-wide `fogNode` was avoided: it would recompile every material on each dive. `environment-audio.js` gained a master low-pass (`setUnderwater(on)`, 620 Hz submerged / 20 kHz bypassed) that the page toggles on the state change. Toggle: `waterUnderwaterFog`. (`tsl-build-check.mjs` gained `getCanvasTarget`/`getDrawingBufferSize` stubs for the viewport nodes.) Tests: `test-base-game-sea-level.mjs`, `test-terrain-sea-depth.mjs`, `test-base-game-water.mjs`. W8 (2026-08-23): swimming. `base-game-water-sim.js` is the water the physics sees — sea level plus the Gerstner surface from the room's wave keys, `heightAt(x, z, t)`, no renderer and no terrain — and it is the one module both the page and the room server import, so there is no second copy of the maths to drift. The controller takes a `waterSurfaceAt(x, z, t)` hook and carries the lockstep tick as its clock (`stepOnce({ tick, ... })` sets it, `advance` counts it, `captureState`/`applyState` and the prediction replay carry it), which makes a step a pure function of `(position, velocity, config, tick)`: client and server reach the same position bit for bit through a water entry, a swim and an exit. Physics: the float point is the chest (`floatHeightFraction` 0.55), `swimming` once it is under the surface, buoyancy (34) ramping over `floatDepth` (0.6 m) replaces gravity so the body settles with its head out, `waterDrag` 3.2, horizontal speed scaled toward `swimSpeedMultiplier` 0.65 as the body wades deeper, jump swims up (`swimUpSpeed` 3.2) and crouch swims down (`swimDownSpeed` 3), snap-down and step-up are off while swimming, and the seabed still stops you. Crouch is a new tick-input boolean (`ControlLeft`/`KeyC`; older clients omit it and never sink) and `waterEnabled` is now a shared world key, because whether there is a sea is physics, not decoration. The rendered swell reads the same clock the physics does (`water.update(dt, camera, playerController.waterTime + alpha·fixedDt)`), so the body floats on the waves you can see; the sea holds still exactly when the player simulation does. Water tuning stays out of the player-config panel on purpose: buoyancy and drag are constants both sides share, while the player-config sliders are local-only and would desync a swim. Known gap: each client runs its own tick numbering, so two players who joined at different times render the swell at different phases (each still agrees with the server about its own body). Seeding a joining client's tick from the room tick would close it and needs a server-side change to `receiveInput`'s first-tick rule. Also unmodelled in physics: the render's `shallowFade` damping in the last 2.5 m of depth, because the depth samples the two sides hold are not bit-identical — the gap is bounded by the wave amplitude and only shows right at a beach. Swim poses for the body are still the body track's job. Tests: `test-base-game-player.mjs` (float equilibrium, dive, ascent, drag, riding a swell, draining the sea, tick determinism) and `test-base-game-rooms-water.mjs` (server and predicting client identical to 1e-9 through entry/exit and a mid-run wave patch, with a control client that misses the patch drifting 2.6 m). W9 (2026-08-26): the panel and the record. The Water section now carries the whole feature — sea on/off, reflection mode, caustics, underwater fog, a look preset (`waterLook`), a refraction toggle, a foam scale and clarity (the metres of water the colour law reaches through) — on top of the eleven wave keys, with sea level next to the terrain it belongs to. Look preset and physics are kept apart on purpose: `applyWaterSettings` applies the preset first and then puts the panel's reflection, caustics, refraction, foam, clarity and the room's wave keys back on top of it, so a preset can never quietly change what the swimmer swims in. Only the Gerstner presets are offered (`ocean`, `hybrid`): `waterjs` is the 3-sine ripple model with no CPU displacement, and picking it would leave the body bobbing on waves the render does not draw. Foam scales all four foam terms from the authored base (`water.refreshLookBase()` re-reads it after anything else writes the profile), so dragging the slider twice does not compound. `water-config.json` (authored in `demos/water-demo.html`, shared with the flight sim) still supplies the rest of the look at load and its clarity is adopted into the slider so the panel shows what is live; Base Game never writes that file. Every water key is an ordinary setting, so it rides the saved state file and the performance capture's `settingsAtStart`. Frame cost was already split: `passWaterMs` for the surface update, and inside `passPostMs` a `passReflectMs` / `passPostMirrorMs` / `passPostPlainMs` split so the planar mirror's marginal cost is measured rather than subtracted between captures, with `water.reflectStats` (passes, skips, last ms) in the capture context. That closes the water plan.

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

### Moisture-driven plants and other world dressing

**F1-F5 shipped 2026-08-24; trees and understory are still planned (plan
`docs/superpowers/plans/2026-08-23-base-game-plants.md`).** Roadmap step
11, and it starts by closing the gap this doc's terrain section names: the plan's first two phases
give the streamed terrain a biome field. `terrain-source-v5.js` fills the `biomeIds` and `moisture`
tile fields that `terrain-source.js:8` has always reserved, using `biome-classifier-js.js`'s
`classifyBiomeCell` (pure, per-cell, previously called by nothing in production) over slope from the
tile's own grid and temperature/humidity/weirdness from the unbounded sampler the v5 source already
constructs — all continuous in position, so tiles classify without a global pass. Erosion, lakes and
flow-derived materials still wait for regional hydrology, so the streamed `beachMask` drops its lake
factor and moisture stays a proxy (`moisture-proxy.js`) behind one function.
`base-game-terrain.js` now exposes `acquireFields()`, `fieldsReady(x, z)`, `biomeAt` /
`biomeIdAt` / `moistureAt` / `treeDensityAt` / `fieldSurfaceAt` and `surfaceFieldAt(x, z)` over a
reference-counted 8 m placement window fed by one shared field scheduler (`terrain.md` has the
modules and the measured cost) — the shapes `terrain-loader.js` already gives the forest and grass
modules for authored maps, so both consumers wire up unchanged. Every reader returns `null` where
the field has not streamed, so placement defers instead of inventing a candidate. On top of that: `flora-field.js` reconciles biome ambition against
`terrain-splat-streamed.js`'s `splatWeights()` so nothing grows on ground painted as rock,
`flora-chunks.js` (lifted from the three inline copies in `environment-viewer.html`) streams the
placement window, ground height comes from the shared fine `createHeightWindow` instance (the
weather plan's R1b window, 1.25 m posts over 160 m) rather than main-thread `source.heightAt` calls,
and records are kept global and uploaded render-local so a rebase re-uploads instead of re-placing.
Flora is deterministic from a room-shared `floraSeed` and is not replicated; v1 does not collide.

**Grass (F5).** `base-game-flora.js` owns one `createComputeGrass` instance fed by two injected TSL
samplers: height from the terrain's lod-0 contact window (1.25 m posts over 160 m, the exact field
the visible chunks are built from) and density from the placement window's scalar `coverGrass`
channel. Both adapters add the render origin before sampling, since candidates are render-local and
the windows are global. Blades carry a small negative vertical bias — a sunk blade is invisible, a
floating one shows daylight. The Plants panel section drives it through setters only, because
`grass-compute.js` cannot free its storage buffers; the draw radius is clamped to the contact
window's usable circle (56.6 m for a 160 m window). Frame cost lands in the `grass` profiler slot,
awaited like the env-viewer does it. See `vegetation.md` for the module contract.

`flora.update()` takes ELAPSED SECONDS, not `dt`. It only ever reaches `uTime`, which drives the
wind phase; a frame delta pins that near 0.016 and the blades hold one fixed bend. Every other
viewer passes `now / 1000` and this page passed `dt` until 2026-08-26 — `test-grass-compute.mjs`
now asserts the call site, since no unit test of the module can see a wrong caller.

Base Game raises the blade ceiling with `grassKmax: 256`, so the panel's 0-60 blades/m^2 slider
works across its whole range instead of saturating at 16. The instance buffer is 28.5 MB
(891,136 instances) and the per-recull dispatch tracks the live window rather than that ceiling.
Blades tint toward the ground beneath them (`terrainTintNode`, the GPU twin of the bands
`colorizeGeometry` paints the terrain with), strongest at the root and total at the draw edge, so
the field dissolves into the terrain instead of ending on a line. Two Plants sliders drive it.

The draw-radius slider reaches its full 200 m as of 2026-08-27: height comes from the contact
window inside ~60 m and the 2 km placement window beyond it, and `maxRadius` follows the slider
rather than a window. Two limits it is worth knowing about: at radius AND density both maxed the
96 MB blade buffer truncates the far edge (the panel's runtime line says when), and the blade RASTER
cost — vertex and overdraw, which is what actually grows with the
count — sits inside the main render pass and is not measured by `passGrassMs`, which times only
the cull dispatch.

### Reading a performance capture

Captures land in `research/stats/base-game-performance-log.json`, newest entry first. Since
2026-08-24 each sample also carries the frame profiler's per-pass CPU time, summarised under
`performance.passes` (`passTerrainMs`, `passWaterMs`, `passFxMs`, `passSkyMs`, `passGrassMs`,
`passPostMs`), and `context.water`/`context.flora` record the mirror's pass count and the field
windows' coverage. Before that the capture held frame totals only, and the profiler's default
prefix map — written for the environment viewer — silently reported zero for this page's `terrain`
and `fx` slots.

Since 2026-08-24 the slot map covers the whole frame, not just the render half. `weather`,
`playerSim`, `playerView`, `bodies` and `audio` are exported alongside the render passes, and
`passOtherMs` carries whatever is left of the animate body so the parts sum to the whole. `terrain`
is split three ways, because one slot was hiding three unrelated costs: `passTerrainMs`
(`system.update`), `passTerrainFoldMs` (the unbudgeted `applyMaterials` + `syncVolumeColliders` on
changed frames) and `passTerrainFieldMs` (the field windows). `passTerrainInstallMs` is separate
again: worker chunk results arrive in `w.onmessage`, outside the rAF and outside every slot, so
`TerrainSystem` accumulates that cost and `terrain.frameCost` drains it once per frame.

`?gputime=1` builds the renderer with `trackTimestamp` and resolves GPU timestamps into `gpuPostMs`
/ `gpuRenderMs` / `gpuComputeMs`. The key match is deliberately loose (anything starting with `g`
and ending in `time`, plus `gpu`/`gputimestamps`; this page has no other query parameters) because a
strict `gputime=1` check silently swallowed a real `?gptutime=1` for eight captures. The load-time
console line names which key matched, or `nothing`, and `context.gpuTimestamps` records
`requested` / `matchedKey` / `deviceSupports` / `resolved` / the raw `url`.

**The resolve is deliberately not awaited by the frame.** Awaiting it crosses a vsync boundary and
cost an entire display interval per frame — measured p50 13.3 -> 26.7 ms at 75 Hz, halving the frame
rate. It now fires and lands out of band (one resolve in flight at a time), so the GPU numbers are a
frame or two stale, which is irrelevant to a p50/p95 over a 10-second window. A yellow on-screen
badge appears whenever the mode is on, because a diagnostic that silently costs frames is a trap;
clicking it clears the flag and reloads.

**`context.scene` is a census of what the encode walks.** `postRender` is CPU work roughly
proportional to the objects the renderer visits, and the per-subsystem draw counts do not add up
against `renderer.info`: `terrain.stats.draws` reports **1** for its batched world (it counts only
`system.group.children` plus `batcher.batchCount`, never the cascade batchers or the cascade
systems' own meshes), yet toggling `terrainVisible` off removed **~100 draw calls**. Rather than
trust any subsystem's self-report, the capture walks the graph the way the renderer does -- pruning
invisible subtrees exactly as `projectObject` does -- and reports `visitedObjects`, `renderables`,
`unculled` (`frustumCulled: false`, which always encodes), `maxDepth`, and a `byOwner` breakdown
attributing every renderable to the top-level scene child it hangs under.

Since 2026-08-30 the owner key is the child's name up to its first `:` (so `forest:v0:branchesL0`
and its siblings fold into one `forest` row), and each row carries `kinds`, a count per
`name-or-geometry-type/material-type`, so a row that is still called `Mesh` says what it is made of.
The 2026-08-30 captures had 106 renderables under `Mesh` and 27 under `Group` because the forest,
grass, cloud decks, debris, effect pools, projectiles, drone craft, the sky group and the hit marker
were all added to the scene unnamed; they are named now (`forest:v<n>:<part>`, `base-game-grass`,
`base-game-cloud-deck-<n>`, `debris-instanced`/`debris-smoke`, `fx-lines`/`fx-points`/
`fx-sprite-pool`/`fx-decal-pool`, `base-game-projectile`, `drone-view:<kind>`, `sky`,
`player-hit-marker`).

Read it against `drawCallsReported` from the same frame. A large `renderables` count, or an owner
with far more meshes than its subsystem claims, is the thing to fix -- not the mirror's rate.

**Per-chunk frustum culling stays ON, measured both ways (2026-08-26).** Turning it off makes
`BatchedMesh.onBeforeRender` early-out instead of running a matrix + bounding-sphere + frustum test
per resident chunk per camera per pass. `?chunkcull=0` runs that arm; `context.batchFrustumCulled`
labels each capture.

| | draws | postPlain p50 (best/median/worst) | frame p95 median | frame max median |
|---|---|---|---|---|
| culling ON (default, n=5) | 130-304 | 3.2 / 4.9 / 6.9 | **25.7** | **38.8** |
| culling OFF (n=6) | 290-659 | 3.0 / 4.3 / 6.1 | 35.2 | 88.8 |

Two conclusions, and the second is the important one:

1. **The tail is much worse with culling off** -- frame max median 88.8 ms against 38.8 -- while p50
   encode is a wash. Culling stays on. Note the arms were taken in that order, so the later (ON) arm
   winning argues against this being machine drift, which ran the other way.
2. **Draw calls are cheap here.** Doubling submitted draws (155->321 min, 304->659 max) moved p50
   encode by ~0.5 ms or less, inside the within-arm drift. So `postPlain`'s 3-6 ms is **not** draw
   submission, and an earlier reading of this page as "draw-call-bound in the CPU encode loop" was
   wrong. A merge-to-single-draw rewrite of `terrain-chunk-batches.js` would have bought nothing.

The mirror's cost is cross-validated: `passPostMirrorMs - passPostPlainMs` matches `passReflectMs`
to within 0.1 ms in every capture (3.1/3.2, 2.6/2.5, 2.8/2.8, 2.1/2.1, 1.5/1.5, 1.4/1.4). It costs
**1.4-3.2 ms** on the frames it runs. What owns the remaining 3-6 ms of base-scene encode is still
open, and it is not draws — regressing `passPostMs` against `drawCalls` over all 102 captures that
carry both gives 0.011 ms per draw call (2 draws → 13.4 ms, 471 draws → 8.3 ms), so the encode is
very nearly flat in what is drawn. The pipeline meter below is the first instrument aimed at it.

**Profiling the encode.** `postRender` is CPU encode, and the planar mirror re-renders the whole
scene inside it every `reflectRate` frames, so a single number hides the split. Three sub-slots,
all inside `postRender`, separate it:

| Reported as | What |
|---|---|
| `passReflectMs` | the mirror's own encode (`reflectStats.lastMs`) on frames it ran |
| `passPostMirrorMs` | the whole encode, on frames the mirror ran |
| `passPostPlainMs` | the whole encode, on frames it did not |
| `passPostShadowMs` | the whole encode, on frames the shadow map redrew |
| `passPostNoShadowMs` | the whole encode, on frames it did not |
| `passPostChainMs` | the whole encode, on frames the DOF/visor pipeline ran |
| `passPostDirectMs` | the whole encode, on frames it was a direct `renderer.render` |

`passPostMirrorMs.p50 - passPostPlainMs.p50` is the mirror's marginal cost, measured within one
capture rather than subtracted across two. The shadow and chain pairs work the same way, and each
needs both of its buckets to be populated to say anything: **set `shadowUpdateEvery` above 1** or
every frame lands in `passPostShadowMs` and the pair is silent, and the chain pair only splits if
depth of field or the visor is toggled during the window.

**Pipeline creation, the part no split of the encode can reach (2026-09-02).** WebGPU builds a
pipeline lazily, on the first frame the thing that needs it draws, and three creates it
*synchronously* inside `render()` unless `compileAsync()` supplied a promises array. That cost is
inside `postRender` but is not encode — it is compilation, and it arrives scattered through a
session as new things come into view, which is the shape of "the frame time spikes when I start
moving". `gpu-pipeline-meter.js` counts it directly (see `docs/subsystems/infra.md`):

| Reported as | What |
|---|---|
| `passPipelineMs` | ms the frame spent building pipelines; `.frames` is how many frames paid |
| `passPipelineRenderMs` / `passPipelineComputeMs` | the same, split by pipeline kind |
| `pipelinesBuilt` | pipelines built per frame (top-level in the record, not a pass) |
| `renderCalls` | whole scene renders per frame — above 1 means a shadow map or mirror redrew |

`passPipelineMs` is deliberately **not** sparse: the honest reading is per-frame cost over the whole
window, and `frames` already says how rare it was. It is also excluded from
`BASE_GAME_FRAME_SLOTS`, because it overlaps `postRender` rather than partitioning the frame. The
meter is drained every frame whether or not a capture is running — the counters are cumulative, so
skipping idle frames would hand the first profiled frame every pipeline built since load — and the
stats line grows a `N pipelines X ms` segment for the last half-second whenever that is non-zero.

**Base Game calls `compileAsync` nowhere.** `base-game-forest.js` is the only caller in the repo,
added 2026-08-28 after the trees produced a hard freeze and 1000 ms walking spikes; nothing else was
ever measured against a real backend, so nothing else got the treatment. That audit also records
that **shadow-map pipelines are warmed nowhere at all**, because `compileAsync()` walks the normal
render list and does not run the shadow pass.

These three are **sparse passes** (`SPARSE_PASSES` in `performance-capture.mjs`): they run on only
some frames by design, so they are summarised over their non-zero samples only and carry a `frames`
count. Averaging in the frames where they did not run would report half their real cost. Ordinary
passes still count missing frames as 0, which is the honest per-frame average for them. Note the
consequence for the un-split number: with the mirror on alternate frames, `passPostMs.p50` lands on
a plain frame and hides the mirror entirely.

**What the first GPU-timed captures showed (2026-08-25):** `gpuRenderMs` p50 **1.0-1.2 ms**, max
3.8 ms, against a CPU `passPostMs` of 3.2-12.5 ms. The GPU is nearly idle and `postRender` is CPU
encode time — so scene-graph size and draw count matter, and an earlier reading of this page as
"fill-bound" was wrong. `gpuComputeMs` (the grass compute pass) is 0.066 ms.

`passGpuAwaitMs` is deliberately dropped from the record. `frame-profiler.js` defines it as a sum of
the compute slots plus `postRender`, so on this page it merely duplicates `passPostMs` and reads
like an independent measurement of GPU wait, which it is not.

**Two captures with identical settings are not comparable on their own.** `context.camera` records
the player's global position, yaw, pitch and FOV, because what fills the screen moves the frame time
more than most toggles do. Machine state matters too: in the 2026-08-24 session `passSkyMs` — a
fixed, sub-millisecond job — ranged 0.3 to 0.9 ms across captures and correlated -0.92 with fps,
which is every timer dilating together rather than any subsystem costing more. Treat a set of
captures taken minutes apart as confounded, and A/B back to back.

**Draw and triangle counts alternating by roughly 2x is the planar water mirror, not a bug.**
`base-game-water.js` re-renders the scene into its mirror target every `reflectRate` (2) frames, so
`renderer.info` doubles on those frames. It is skipped when no sea surface is visible, which is why
the Traversal Lab shows a flat count and the terrain world does not. The mirror takes an exclusion
list (`excludeFromReflection`); grass is on it, because half-resolution reflected blades are
invisible detail for the cost of re-rendering the whole field.

### The visor: night vision and thermal (shipped 2026-08-29, unseen in a browser)

`H` cycles plain sight, night vision, thermal white-hot and thermal black-hot. The palette itself is
`vision-modes.js`, shared with `demos/flight-sim.html`; see `docs/subsystems/fx.md` for how it works
and `docs/superpowers/plans/2026-08-29-base-game-vision-modes.md` for the plan this came from.

**One pipeline, not two.** The page already had a `RenderPipeline` for depth of field.
`createVisionComposite` builds its own around its own `pass(scene, camera)`, so using it would have
rendered the whole scene twice a frame and made the visor and depth of field mutually exclusive.
Instead the page imports `visionNode(color)` and puts the palette in the pipeline it already had:

```js
postPipeline.outputColorTransform = false;
postPipeline.outputNode = visionNode(renderOutput(depthOfField.node));
```

Depth of field runs first and the palette after it, which is the order a real sensor works in: the
optics blur before the sensor sees. Plain sight with depth of field off still takes the direct
`renderer.render` path and costs no full-screen pass.

Two bugs came out of sharing the pipeline, both pre-existing:

- `outputColorTransform` defaults to `true`, which wraps `outputNode` in a second `renderOutput`.
  The page already applied one by hand, so the depth-of-field path tone mapped and sRGB-encoded
  **twice** while the plain path did it once. Read out of the r184 build, not measured on screen.
- `depthOfField`'s `enabled` uniform was never compared or written — only ever passed as `true`.
  Harmless while depth of field owned the only route into the pipeline; with the visor also using
  it, the frame would have blurred with the setting off.

**Heat is a property of things.** Under IR every tagged material emits its heat and its diffuse goes
black, so lighting cannot reach the picture and the sun cannot make grass read hot. That only works
if every material can carry a tag, and three of the page's could not:

| was | now |
|---|---|
| `player-procedural-body.js`, 15 classic materials | the node twins, with a fallback for a build without them |
| `body-part-batches.js`, 15 classic materials | same |
| GLB weapons, classic from GLTFLoader | `convertMaterial` on the weapon mount, given three's own `renderer.library.fromMaterial`; runs once per distinct material at template load |

A classic material cannot hold a TSL node: the renderer converts it inside `NodeBuilder` at
shader-build time and the app never gets a handle on the result. Untagged, every player, bot and gun
would have rendered in full lit colour inside a heat frame — backwards, since people are what a
thermal sight is for.

`VISOR_HEATS` maps scene-graph names to heats. Bodies are `HEAT.skin` and are the warmest thing that
is not on fire; the sky dome is `HEAT.sky` so bodies read against it; water is `HEAT.water`; the
terrain takes the default, which is already `HEAT.terrain`. Everything else is swept at the default.
`sky.js` names its dome `skyDome` for this. Terrain chunks and trees stream in long after boot, so
the sweep repeats once a second while the visor is up; a tagged material is skipped, so steady state
is one walk over a few hundred objects.

Fog thins to 35% under IR (`BASE_GAME_IR_FOG_SCALE`), as in the flight sim: a thermal sensor sees
through haze that stops the eye.

**Per-instance colour does not tint the heat, on lit materials.** three multiplies `instanceColor`
into `colorNode` only, and that feeds `diffuseColor`; `heatTag` sends a lit material's heat out on
`emissiveNode`, which `instanceColor` never touches. So a bot's team colour cannot change how hot it
reads. On an *unlit* material the colour is the output and the tint does reach the heat — the
limitation `vision-modes.js` records for the flight sim's debris pools. The one unlit body role, the
eye, is never given a per-instance colour.

**Known gaps.** `effect-renderer.js`'s sprite pool is a single unlit material shared by muzzle flash,
sparks, smoke and blood and tinted per instance, so one heat cannot be right for all of them; it is
left at the default rather than guessed at. The scope overlay is DOM and sits outside the pipeline,
so it stays full-colour while the world goes green. Nothing here has been looked at in a browser, so
every heat and every palette number is arithmetic, not observation.

**Multiplayer:** none of this is replicated. A vision mode is a local render setting, so there is no
protocol change and no version bump. A visor other players could *see* on your head would be a
different feature.

Tested by `test-base-game-visor.mjs` (43 checks) and `test-vision-modes.mjs`.

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
