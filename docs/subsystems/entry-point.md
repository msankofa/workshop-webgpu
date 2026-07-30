# entry-point.md — `environment-viewer.html`

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#entry)

## Purpose

`environment-viewer.html` (4350 lines) is the single `<script type="module">` that boots the
WebGPU sandbox: it sets up the renderer/scene/camera, loads ~20 subsystem modules (terrain,
forest, grass, water, sky/clouds, lighting, particles, post-fx, creature sim, multiplayer,
debug UI), wires their per-frame `update()` calls into one `requestAnimationFrame`-equivalent
loop, and owns the inline "Scene controls" / "Walk controls" panels plus FPS-walk and light-gun
input handling. It does not implement any subsystem itself — this doc is the map of how the
subsystem docs (`terrain.md`, `vegetation.md`, `water.md`, `sky.md`, `lighting.md`, `fx.md`,
`creature.md`, `multiplayer.md`, `infra.md`) plug into one running app.

## Module map

### Importmap (lines 26–34)

CDN-pinned three@0.184.0, served from jsDelivr:

| Specifier | Resolves to |
|---|---|
| `three` | `three.webgpu.js` (WebGPU build, also covers the plain `THREE.*` API surface) |
| `three/webgpu` | same `three.webgpu.js` (renderer/material classes) |
| `three/tsl` | `three.tsl.js` (TSL shader-node functions) |
| `three/addons/` | `examples/jsm/` (e.g. `Capsule.js`) |
| `three-mesh-bvh` | `three-mesh-bvh@0.9.0` (used inside `map-collision.js`, not directly here) |

### Static top-level imports (lines 37–51)

| Import | Used for |
|---|---|
| `* as THREE` | core three.js API (Vector3, Color, Fog, Clock, etc.) |
| `{ WebGPURenderer, MeshStandardNodeMaterial }` from `three/webgpu` | renderer construction |
| `{ Fn, attribute, float, vec2, sin, floor, fract, dot, mix }` from `three/tsl` | TSL helpers (used by inline node code in this file, e.g. height-texture sampling) |
| `{ Capsule }` from `three/addons/math/Capsule.js` | FPS player collision capsule |
| `{ createLightingRig }` from `./lights.js` | sun/sky directional light rig |
| `{ createTerrainSystem, terrainNormalAt }` from `./terrain-system.js` | closed-form terrain heightfield + legacy chunk mesh system |
| `{ groundContact, slideVelocity, createTrunkIndex }` from `./collision.js` | FPS ground contact, trunk-collision spatial index |
| `{ createEnvironmentPortCreatures }` from `./port-creature-bridge.js` | bridges the legacy creature sim into this scene |
| `{ kindParams }` from `./particle-field.js` | particle species presets |
| `{ createFrameProfiler }` from `./frame-profiler.js` | per-stage CPU/GPU timing used by the render loop |
| `{ createEnvironmentUi }` from `./environment-ui.js` | mounts the debug/perf UI (see Mode flags / UI integration below) |
| `{ createEnvironmentAudio, positionalSfxProfiles }` from `./environment-audio.js` | Web Audio controller (SFX/music) injected into the UI and driven by viewer events (see Audio integration below) |
| `{ loadTerrainMap }` from `./terrain-loader.js` | loads an authored map (`?map=...`) |
| `{ showStartScreen }` from `./start-screen.js` | pre-renderer map/multiplayer picker, gates everything below it |
| `{ createMapCollider }` from `./map-collision.js` | BVH collider for authored map meshes |
| `{ createHostSession, createGuestSession, GhostRenderer }` from `./multiplayer.js` | netcode session + remote-player rendering |
| `{ listStates, saveState, deleteState }` from `./slider-state.js` (aliased `listSliderStates`/`saveSliderState`/`deleteSliderState`) | named `localStorage`-backed slider-preset storage, shared with `start-screen.js` |
| `{ createBotEntity, stepBotPhysics, toWirePose }` from `./bot-entity.js` (aliased `botToWirePose`) | combat-bot capsule/physics/pose — see `bots.md` |
| `{ chooseBotState, aimAnglesTo, aimError, slewAngle, ... }` from `./bot-activity.js` | combat-bot FSM decision math (aliased `botAimError` etc. to dodge existing names) |
| `{ buildNavGrid, isWalkableCell, cellToWorld, findPath, smoothPath }` from `./nav-grid.js` (aliased `botIsWalkableCell` etc.) | shoot-house-only bot pathing grid |

### Lazy `await import(...)` calls

| Line | Module | Trigger | Cache-bust tag |
|---|---|---|---|
| 263 | `./clustered-lights.js` | `TERRAIN_MODE === 'gpu' && LIGHTS_MODE !== 'off'` (immediate, before CDLOD ground) | — |
| 274 | `./cdlod-terrain.js` | `!loadedMap && TERRAIN_MODE === 'gpu'` (immediate top-level await) | — |
| 309 | `./particles.js` | `PARTICLES_MODE !== 'off'` (immediate) | — |
| 319 | `./post-fx.js` | `POST_MODE !== 'off'` (immediate) | — |
| 761 | `./trees.js` + `./tree-textures.js` (`Promise.all`) | always, fire-and-forget `_forestPromise`; on failure the whole tree/grass/water/cloud/sky setup chain (nested inside its `.then`) is skipped and an error banner is shown | — |
| 776 | `./forest-placement.js` | inside the forest promise, always (placement records needed by both GPU and baked forest paths) | — |
| 789 | `./forest-palette.js` | `FOREST_MODE === 'gpu'` | — |
| 790 | `./forest-gpu.js?v=bill-brightness` | `FOREST_MODE === 'gpu'` | `bill-brightness` — tags the recent runtime billboard-brightness uniform fix (matches creature-viewer commit `33f2ba1 fix(billboards): match brightness to scene lighting via runtime uniform`) |
| 1839 | `./grass.js?v=density-fix-4` | `GRASS_MODE === 'cpu'` (legacy per-chunk CPU grass, kept for SP2 A/B) | `density-fix-4` — 4th iteration of a per-chunk blade-density fix |
| 1988 | `./grass-compute.js` | `GRASS_MODE !== 'cpu'` (default GPU compute/indirect grass) | — |
| 2038 | `./water.js?v=reflection-controls-1` | always, inside forest promise (`_waterPromise`) | `reflection-controls-1` — tags the new reflection-tuning sliders (matches commit `740e406 feat(water): add reflection tuning controls`) |
| 2082 | `./clouds.js` | always, inside forest promise (`_cloudsPromise`) | — |
| 2156 | `./sky.js?v=sp6d` | `SKY_MODE !== 'off'` (`_skyPromise`) | `sp6d` — SP6 milestone tag, sub-revision d |
| ~2979 | `./plants.js` + `./plants-placement.js` + `./grass-anchors.js` + `./plants-gpu.js` | `PLANTS_MODE === 'gpu'` (default) | `variation-*-1` on plants/placement/gpu |
| ~3170 | `./rocks.js` + `./rocks-placement.js` + `./deadfall.js` + `./deadfall-placement.js` + `./dressing-gpu.js` | `DRESSING_MODE === 'gpu'` (default) — rocks + deadfall on the shared `dressing-gpu.js` host | `dressing-wire-1` on all five |

Notably, the forest/grass/water/clouds/sky setup (trees, palette bake, billboard cache, UI
sliders for each) all live **nested inside the single `_forestPromise.then(async ...)` callback**
(lines ~761–2176), not as independent top-level sequences — they share the same `header()` /
`slider()` / `select()` closures that build the "Scene controls" panel, so they're chained off
the trees module load rather than fired in parallel from the top.

## Startup sequence

1. **Importmap + static imports** resolve (lines 26–51).
2. **Mode flags** read from `URLSearchParams` (lines 55–63): `GRASS_MODE`, `GRASS_RECULL_MODE`,
   `FOREST_MODE`, `CREATURE_MODE`, `TIMESTAMP_MODE`. (Also read further down, at their blocks:
   `PLANTS_MODE` (default `'gpu'`) and `DRESSING_MODE` (default `'gpu'`, gates the shared
   rocks/deadfall `dressing-gpu.js` block).
3. `await showStartScreen()` (line 128) — blocks on map/multiplayer-role selection UI; returns
   `{ mapKey, mpRole, roomCode, mpWorldMode, presetName, setStatus, dismiss }`. `presetName` is the
   name chosen from the role-select screen's "Load preset" dropdown (`null` for "None"). Nothing
   else runs until the user picks.
4. **Renderer setup** (lines 77–98): query `navigator.gpu` adapter limits (so the grass survivor
   storage buffer can exceed the default 128 MB binding), construct `WebGPURenderer`, set
   pixel ratio/size/shadow map, `await renderer.init()`, create `scene`.
5. **Multiplayer session** (lines 100–128): if `mpRole === 'host'`, `createHostSession`; if
   `'guest'`, construct `GhostRenderer` + `createGuestSession`; if `'solo'`, construct
   `GhostRenderer` anyway (added for combat bots — host/solo-only sim, needs somewhere to render
   even with no session; see `bots.md`). Wires `mp:guest_input` events into the (not-yet-created)
   `portCreatures`.
6. **Authored map load** (lines 130–145, conditional on `mapKey`): `await loadTerrainMap(...)`,
   then `createMapCollider`.
7. **Camera** constructed (line 147), **lighting rig** (`createLightingRig`, line 151) with
   shadow camera bounds, optional `moonLight` (`SKY_MODE` gated, lines 159–174).
8. **Terrain system** (`createTerrainSystem`, line 197) plus `terrainHeight`/`terrainNormal`
   closures, height-texture bake for authored maps (lines 213–241), trunk spatial index.
9. **Conditional lazy subsystem loads, in order**: clustered lights (263) → CDLOD ground (274,
   reassigns `ground`) → particles (309) → post-fx (319).
10. **Debug HUD scaffolding**: `terrainDebug` stats object, `frameProfiler`, perf-log ring
    buffer + recorder panel (lines 322–576).
11. `createEnvironmentPortCreatures(...)` (line 351) — wires the legacy creature sim into the
    scene, gated by `CREATURE_MODE`.
12. **Forest promise chain** (`_forestPromise`, line 761 onward) — trees/forest, then nested
    grass/water/clouds/sky loads, each appending its own slider section to the "Scene controls"
    panel as it resolves.
13. **Camera orbit controls** wired (drag/scroll/resize, lines 2178–2217).
14. **FPS walk mode + light gun** state, panel, and input handlers (lines 2219–2530+).
15. `environmentUi = createEnvironmentUi({ perfLog, sliderState })` (line 3859) mounts the separate
    debug/perf panel and the Presets tab from `environment-ui.js`.
16. **`animate()` defined** but not yet started.
17. Final gate (lines 4341–4346): `setStatus('Loading world systems…')` →
    `await _forestPromise` → `await Promise.all([_grassPromise, _waterPromise, _cloudsPromise, _skyPromise])`
    → if `presetName` was set from the start screen, `applySliderState(listSliderStates()[presetName]?.values)`
    → `dismiss()` (closes the start-screen overlay) → `renderer.setAnimationLoop(animate)` starts
    the render loop — this is the first rendered frame. This is the earliest point every
    slider/select/toggle control — including the ones built inside the async grass/water/clouds/sky
    sub-promises — is guaranteed to have finished registering itself into `controlRegistry` (see
    "Slider state presets" below).

## Per-frame render loop

`animate()` (line 2755), driven by `renderer.setAnimationLoop`. Re-entrancy guard `_frameBusy`
drops an overlapping vsync tick (frame still in flight) instead of letting two submits race and
corrupt WebGPU buffers. Per frame, in order:

1. `frameProfiler.beginFrame()`; compute smoothed `rawDt`/fps.
2. **Sky** (`skyRef.update`) — follow camera, sync sun/moon direction.
3. **terrainWindow stage**: update both cloud layers' position; run FPS-controls substeps
   (`STEPS_PER_FRAME = 5`) or orbit `applyCamera()`; then `updateTerrainWindow(...)` (chunk
   streaming, shadow focus, triggers grass/water/tree resync).
4. **Creatures**: `portCreatures.update(rawDt)`.
4b. **Bots**: `updateBots(rawDt)` — host/solo only (no-ops on a guest); see `bots.md`.
5. **Water**: `waterRef.update(now)` (its own reflection/refraction/caustic passes).
6. **HUD**: `updateTerrainDebug(now)`.
7. **Grass** (awaited): `grassRef.update(now)` — GPU generate+cull must finish before draw.
8. **Forest** (awaited): `forestGPURef.update()` — cull → indirect draw compute.
9. **CDLOD terrain** (awaited): `cdlodRef.update()` — select → indirect compute.
10. **Light gun**: `lgUpdateLights`, charge-ring UI update.
11. **Clustered lights** (awaited): `clusteredLightsRef.update(now)` — froxel light cull.
12. **Particles** (awaited): each entry in `particleFields` calls `field.update(rawDt, camera)`.
13. **Composite/render** (awaited): `postFX.renderAsync()` if enabled, else
    `renderer.render(scene, camera)`.
14. `resolveFrameTimestamps()` (only if `TIMESTAMP_MODE === 'on'`).
15. `skyRef.flushDisposals()` — deferred until after this frame's submit so detached GPU
    resources aren't freed mid-flight.
16. CPU frame time recorded into `terrainDebug.cpuMs`; `perfLog.maybeSample`/`updatePerfPanel`.

The recurring pattern is: any subsystem with a GPU compute/cull pass that feeds an indirect
draw (grass, forest, CDLOD, clustered lights, particles) is **awaited** before the final render
call, so the indirect instance counts are written before the draw reads them.

## Mode flags

All read once at top-level via `URLSearchParams` and gate which lazy imports/branches fire:

| Flag | Default | Effect |
|---|---|---|
| `grass` → `GRASS_MODE` | `gpu` | `cpu` loads legacy `grass.js` (per-chunk meshes); else `grass-compute.js` (GPU compute/indirect) |
| `grassRecull` → `GRASS_RECULL_MODE` | `cell` | passed through to `grass-compute.js`'s recull strategy |
| `forest` → `FOREST_MODE` | `gpu` | `gpu` loads `forest-palette.js` + `forest-gpu.js`; `baked` skips both and builds merged meshes from `trees.js` directly on the main thread |
| `creatures` → `CREATURE_MODE` | `on` | passed into `createEnvironmentPortCreatures({ mode })` |
| `timestamps` → `TIMESTAMP_MODE` | `off` | enables `trackTimestamp` on the renderer and the `resolveFrameTimestamps()` GPU readback step |
| `terrain` → `TERRAIN_MODE` | `gpu` | `gpu` loads `cdlod-terrain.js` and clustered lights, puts `terrain-system.js` in `'external'` visual mode; `chunks` uses the legacy per-chunk mesh renderer |
| `lights` → `LIGHTS_MODE` | `on` | `off` skips `clustered-lights.js` entirely |
| `lightsAnimate` → `LIGHTS_ANIMATE` | off | passed to `createClusteredLights({ animate })` |
| `particles` → `PARTICLES_MODE` | `on` | `off` skips `particles.js` import and ember/dust fields |
| `post` → `POST_MODE` | `on` | `off` skips `post-fx.js` (falls back to plain `renderer.render`); other values (`scene`/`output`/`grade`) select diagnostic post graphs |
| `sky` → `SKY_MODE` | `on` | `off` skips `sky.js` + moonlight entirely; `nostars`/`nomilkyway`/`nobodies`/`domeonly`/`nomoonlight` selectively disable sky parts (bisection kill-switches) |
| `map` → `mapKey` | none | set via the start screen, not a raw query flag here; when present, loads an authored map instead of the procedural terrain |
| `perf` | off | `perfLog.recording` starts pre-enabled |
| `botTrace` (v2 copy only) | off | starts the 9-slot bot state-code tracer; `botTraceTick=<ms>` sets the motion heartbeat (default 1000, `0` = change rows only) |
| `layout` (v2 copy only) | — | URL of a `pcw-layout` JSON (see `layout-interchange.js`); overrides the shoot-house generator so a harness-exported world runs with identical geometry, and its `role:'bot'` spawns replace the sampled spawn slots. The start screen's Maze Layouts card is the UI for the same thing (it resolves a `layout:<path>` mapKey); the URL param overrides the card and is the scriptable/repro path |

### Bot state-code tracer (`environment-viewer-v2.html` only)

`?botTrace=1` enables the port of bot-viewer-v2's state-code trace capture: `bot-state-code.js` is
lazily imported (nothing is fetched with the flag off), every bot's discrete state is encoded into a
9-char code at the tail of `botTickOne` (and once per dead bot in `updateBots`), and a row is pushed
to a 20k-entry ring buffer whenever the code changes — plus a `tick` heartbeat row every
`botTraceTick` ms so a bot walking a patrol ring is distinguishable from one standing still. Columns
match the harness's `botStateTraceTsv` exactly so takes from both apps diff slot-by-slot. Dump with
`window.botTrace.save()` in the console: it POSTs to serve.py's `/api/save-bot-state`, landing in
`bot-states/bot-state-trace-env-<YYYYMMDD-HHMMSS>.tsv` (the `-env-` infix keeps game takes from
colliding with harness takes), and falls back to a browser download when that endpoint is absent.
`window.botTrace.rows`/`.tsv()` expose the buffer directly. Since the Phase A brain swap
(2026-07-29) the descriptor reads the live v2 brain: slot 1 covers the full state ladder via
`STATE_NAMES`, slot 2/3 read the real alert tier and escalation score (`rec.alertTierLast`,
`rec.alertScore`), 6 (ammo) and 7 (health) were always real; role, push element and packs stay at
calm defaults until Phases C/C½ port those systems.

## Camera / control modes

Two camera modes, toggled by the `F` key (pointer lock):

- **Orbit** (default): spherical orbit around `target` (`theta`/`phi`/`radius`), drag to rotate,
  wheel to zoom (radius clamped 4–70), WASD to pan `target` across the ground plane along the
  current view heading (`updateOrbitPan()`, shift runs), driven by `applyCamera()` each frame.
- **FPS walk** (`fpsMode`): entered via `renderer.domElement.requestPointerLock()` on `F`;
  capsule-based ground/gravity movement (`Capsule` from `three/addons`, `groundContact`/
  `slideVelocity` from `collision.js`), substepped 5×/frame, mouse-look via `mousemove` deltas,
  crouch/prone stances, plus light-gun shoot/place controls bound to `mousedown`/`mouseup`
  (lines 2219–2530+). Exits to orbit only via `F` (which sets `intentionalOrbitExit = true` before
  calling `document.exitPointerLock()`); any other pointer-lock loss — `Escape`, alt-tab, focus
  loss — is treated by the `pointerlockchange` listener as unintentional and opens the pause menu
  instead (see below), never orbit. `enterFPS()` (`hasEnteredFPSOnce` flag) only keeps the authored
  map spawn point on the very first entry; every later orbit→FPS transition (not a cursor-free
  resume, where `fpsMode` is already true) snaps `playerCollider` to the orbit camera's current
  `target` x/z first, so walking in lands wherever you last drag-rotated/WASD-panned to instead of
  teleporting back to the stale pre-orbit position `exitFPS()` left behind.
- **Cursor-free pause** (`fpsCursorFree`, a sub-state of FPS): `Q` releases the pointer while
  keeping the first-person camera **frozen in place** (distinct from exiting to orbit) so the mouse
  can reach the HUD / minimap layer menu. Movement and mouse-look are gated off; the walk/orbit
  branches in `animate()` both skip. Clicking the 3D view, or `Q`, re-locks and resumes walking.
  Opening the **M** map from FPS enters this pause; closing it (`M`/`Esc`) re-locks. `Q` and `M` are
  no-ops while the pause menu (below) is open, to avoid re-locking the pointer underneath it.

### Pause menu (`Esc`)

`Escape` always opens an in-game pause overlay (`pauseMenuOpen`, `pauseMenuOverlay`) — from FPS,
third-person, or orbit — with **Restart Game** and **Main Menu** buttons; pressing `Escape` again
closes it. `openPauseMenu()` freezes the view the same way `Q`'s cursor-free pause does
(`enterCursorFree()`) when in FPS mode; it's a no-op in orbit mode, where the cursor is already
free (orbit panning via `updateOrbitPan()` is explicitly skipped while the menu is open so held
WASD doesn't pan the camera underneath it). `worldMapOverlay` still takes priority: `Escape` closes
the map first if it's open, same as before.

Both buttons reload the page (`location.reload()`) rather than tearing down in-place — this is a
single long-lived module script with a live multiplayer socket, WebGPU context, and hundreds of
lines of module-scope state, so a full reload is the only reliable way to reset everything cleanly.
The difference is what happens on the next load:

- **Restart Game** first writes the current session's `{ mapKey, mpRole, roomCode, mpWorldMode,
  presetName }` to `sessionStorage['ecw-restart-config']`. On reload, this is read and removed
  before `showStartScreen()` is called, and passed in as `resumeConfig` — `start-screen.js` then
  skips the role/map picker entirely and goes straight to the loading step with those settings, so
  the game silently re-enters the same map/role/room instead of showing the picker.
- **Main Menu** clears `sessionStorage['ecw-restart-config']` (in case a stale one exists) and
  reloads, landing on the normal `showStartScreen()` role/map picker.

For multiplayer guests, `GhostRenderer` (from `multiplayer.js`) renders remote players/creatures
into the same `scene` but does not drive the local `camera` — the guest's own camera still uses
the orbit/FPS modes above; only the host's creature/player state is mirrored visually.

Per `CLAUDE.md`, the legacy `creature-viewer.html` is a separate, older single-file app (not
read in depth for this doc) — it is documented to use orbit-style camera interaction for its
creature sandbox; this WebGPU `environment-viewer.html` is the only place in this repo with the
FPS pointer-lock walk mode and light-gun controls.

## Slider state presets

Every control built via the `slider()`/`select()`/`toggle()` factories (Forest, Lighting,
Terrain/Water, Post FX, Grass, Clouds, Sky sections — everything in the "Scene controls"/`#ctrl`
panel) self-registers into a module-level `controlRegistry` array as it's built:
`{ name, obj, key, sync, onChange }`, where `name` is `'<objName>.<key>'` (`objName` defaults to
`'params'`; the `rigP`/`terrain`/`SKY_PARAMS` slider calls pass it explicitly).

- `captureSliderState()` reads `obj[key]` off every registered control into a flat
  `{ [name]: value }` object.
- `applySliderState(values)` writes matching values back into each control's `obj[key]`, calls
  its `sync()` to update the DOM widget, then fires each distinct `onChange` handler once
  (deduped by function identity, since many sliders in one group share a handler like
  `worldRebuild`) so the live subsystem picks up the change.

`controlRegistry` itself is declared very early (immediately after the mp/light-entity state
block, ~line 106) rather than alongside `captureSliderState`/`applySliderState` (~line 1553),
specifically to dodge a TDZ crash: a multiplayer guest's `onState` handler can fire mid-module-init
(during a top-level `await`, e.g. the clustered-lights import) and reads `controlRegistry`
indirectly through `applySharedWorldSettings` before module eval would otherwise reach its
declaration. `captureSliderState`/`applySliderState` are declared at the top level of the module
(immediately before `_forestPromise`) rather than inside it, so they're reachable both from inside
the promise chain (where the controls are registered) and from the `createEnvironmentUi(...)` call
site and the final startup gate (where they're consumed) — `slider()`/`select()`/`toggle()`
themselves are defined inside `_forestPromise`'s callback and close over the outer
`controlRegistry`.

The multiplayer shared-world-settings sync (`captureSharedWorldSettings`/`applySharedWorldSettings`,
also declared near `captureSliderState`/`applySliderState`) reuses the same registry, filtered to
`terrain.*`/`params.*` entries, to replicate host terrain/world tuning to guests in `mpWorldMode
=== 'shared'` sessions — see `multiplayer.md`.

Consumers: the Presets tab in `environment-ui.js` (save/load/delete UI, via the `sliderState`
object) and the start screen's "Load preset" dropdown (`presetName`, applied once, at the final
startup gate, before `dismiss()`).

## UI integration point

`environment-ui.js`'s `createEnvironmentUi({ perfLog, sliderState })` is called once, at line
3859, after all other panels exist; it mounts the separate debug/perf-readout panel plus the
Presets tab (covered in `infra.md`). The "Scene controls" (`#ctrl`) and "Walk controls" (`#fps`)
panels, by contrast, are built **inline** in this file (the `header()`/`slider()`/`select()`/
`toggle()` closures around lines 1507–1574 and the FPS panel construction around line 2273+) —
they are not part of `environment-ui.js`.

## Audio integration

`environment-audio.js`'s `createEnvironmentAudio(options)` controller (module contract lives in
`infra.md`) is instantiated once, right after the `camera` is created, as `envAudio`. Options
passed by the viewer:

- `THREE`, `scene`, `camera` — shared instances (no module globals).
- `getPlayerPosition: () => playerCollider ? playerCollider.end : camera.position` — the
  first-person capsule top once the player spawns, else the orbit camera.
- `isGameplayActive: () => gameplayActive` — a viewer flag flipped `true` just before
  `dismiss()` (music picks `music_game` vs `music_menu`).
- `workletUrl: './music-pitch-processor.js?v=1'`.

`envAudio` is passed into `createEnvironmentUi({ audio: envAudio, ... })`, which builds the Audio
tab entirely from the controller. `envAudio.restoreSfxFolder()` runs right after UI creation to
re-open a previously granted SFX folder handle.

Gesture/lifecycle hooks (Web Audio needs a user gesture to unlock, and the listener must track
the camera):

- `envAudio.noteGesture()` — called from the `keydown`, `mousedown`, and pointer-lock-entry
  (`pointerlockchange` → locked) handlers.
- `envAudio.update(now)` — called once per frame in `animate()` **after** the FPS
  player/camera movement block, so the audio listener and speaker orb use the current camera pose.

### Event → SFX map

Non-positional self/UI events use `envAudio.play(id)`; world events use
`envAudio.playAt(id, pos, undefined, positionalSfxProfiles.<profile>)` (positions may be plain
`[x,y,z]` arrays wrapped by the local `audioPos()` helper, or `{x,y,z}`/`Vector3`).

| Trigger | Event | Site |
|---|---|---|
| `KeyM` map open / close | `map_menu_open` / `map_menu_close` | keydown handler |
| `KeyQ` cursor-free toggle | `pause_open` / `pause_close` | keydown handler |
| First-person enter / exit | `vr_drive_on` / `vr_drive_off` | `enterFPS()` / `exitFPS()` |
| `KeyR` reset (orbit only) | `vr_model_snap` | keydown handler (`else` branch) |
| Light placement | `vr_light_spawn` (positional, `spawn`) | `lgPlaceAtCrosshair()` |
| Light projectile fire | `beam_quick` (positional, `minor`) | `lgFireLight()` |
| Local hitscan shot | `machinegun_shoot` / `sniper_shoot` (self) | `fireGunFromCamera()` on `result.ok` |
| Hit registered | `enemy_hit` (positional, `minor`); `player_damage` if the local host is hit | `applyCombatIntent()` |
| Remote (guest→host) shot | `weaponFireEvent()` (positional, `gunshot`) at the shooter | `applyCombatIntent()` when `ownerId !== 'host'` |
| Remote shot (guest view) | `weaponFireEvent()` (positional, `gunshot`), once per `fireSeq` increment | guest `onState` (via `mpRemoteFireSeq`) |
| Jump | `jump` | `animate()`, on grounded→airborne while holding Space |
| Landing | `landing` | `animate()`, on airborne→grounded transition (`wasOnFloor`) |
| Footstep | `footstep` | `animate()`, velocity-timed via `footstepDist` stride threshold |

`weaponFireEvent(weaponId)` maps `m24 → sniper_shoot`, everything else → `machinegun_shoot`.
Unassigned event IDs (no `sound-map.json` entry) simply no-op, so partial maps are fine.

### Themeable HUD targets

`environment-viewer.html` gives the first-person health/ammo HUD the stable `#combat-hud` id. `environment-ui.js` uses that ID, plus the minimap/full-map IDs, for its non-gameplay Theme paint-selection and CSS-variable styling layer.