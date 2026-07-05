# entry-point.md — `environment-viewer.html`

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#entry)

## Purpose

`environment-viewer.html` (2854 lines) is the single `<script type="module">` that boots the
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
| `{ loadTerrainMap }` from `./terrain-loader.js` | loads an authored map (`?map=...`) |
| `{ showStartScreen }` from `./start-screen.js` | pre-renderer map/multiplayer picker, gates everything below it |
| `{ createMapCollider }` from `./map-collision.js` | BVH collider for authored map meshes |
| `{ createHostSession, createGuestSession, GhostRenderer }` from `./multiplayer.js` | netcode session + remote-player rendering |

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

Notably, the forest/grass/water/clouds/sky setup (trees, palette bake, billboard cache, UI
sliders for each) all live **nested inside the single `_forestPromise.then(async ...)` callback**
(lines ~761–2176), not as independent top-level sequences — they share the same `header()` /
`slider()` / `select()` closures that build the "Scene controls" panel, so they're chained off
the trees module load rather than fired in parallel from the top.

## Startup sequence

1. **Importmap + static imports** resolve (lines 26–51).
2. **Mode flags** read from `URLSearchParams` (lines 55–63): `GRASS_MODE`, `GRASS_RECULL_MODE`,
   `FOREST_MODE`, `CREATURE_MODE`, `TIMESTAMP_MODE`.
3. `await showStartScreen()` (line 67) — blocks on map/multiplayer-role selection UI; returns
   `{ mapKey, mpRole, roomCode, setStatus, dismiss }`. Nothing else runs until the user picks.
4. **Renderer setup** (lines 77–98): query `navigator.gpu` adapter limits (so the grass survivor
   storage buffer can exceed the default 128 MB binding), construct `WebGPURenderer`, set
   pixel ratio/size/shadow map, `await renderer.init()`, create `scene`.
5. **Multiplayer session** (lines 100–128): if `mpRole === 'host'`, `createHostSession`; if
   `'guest'`, construct `GhostRenderer` + `createGuestSession`; wires `mp:guest_input` events
   into the (not-yet-created) `portCreatures`.
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
15. `environmentUi = createEnvironmentUi({ perfLog })` (line 2452) mounts the separate debug/perf
    panel from `environment-ui.js`.
16. **`animate()` defined** (line 2755) but not yet started.
17. Final gate (lines 2845–2850): `setStatus('Loading world systems…')` →
    `await _forestPromise` → `await Promise.all([_grassPromise, _waterPromise, _cloudsPromise, _skyPromise])`
    → `dismiss()` (closes the start-screen overlay) → `renderer.setAnimationLoop(animate)` starts
    the render loop — this is the first rendered frame.

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

## Camera / control modes

Two camera modes, toggled by the `F` key (pointer lock):

- **Orbit** (default): spherical orbit around `target` (`theta`/`phi`/`radius`), drag to rotate,
  wheel to zoom (radius clamped 4–70), driven by `applyCamera()` each frame (lines 2178–2211).
- **FPS walk** (`fpsMode`): entered via `renderer.domElement.requestPointerLock()` on `F`;
  capsule-based ground/gravity movement (`Capsule` from `three/addons`, `groundContact`/
  `slideVelocity` from `collision.js`), substepped 5×/frame, mouse-look via `mousemove` deltas,
  crouch/prone stances, plus light-gun shoot/place controls bound to `mousedown`/`mouseup`
  (lines 2219–2530+). Exits to orbit on `Esc`/`F` (pointer-lock change listener).
- **Cursor-free pause** (`fpsCursorFree`, a sub-state of FPS): `Q` releases the pointer while
  keeping the first-person camera **frozen in place** (distinct from exiting to orbit) so the mouse
  can reach the HUD / minimap layer menu. Movement and mouse-look are gated off; the walk/orbit
  branches in `animate()` both skip. Clicking the 3D view, or `Q`/`F`, re-locks and resumes walking.
  Opening the **M** map from FPS enters this pause; closing it (`M`/`Esc`) re-locks. The
  `pointerlockchange` listener drops to orbit only when the release was *not* a deliberate pause.

For multiplayer guests, `GhostRenderer` (from `multiplayer.js`) renders remote players/creatures
into the same `scene` but does not drive the local `camera` — the guest's own camera still uses
the orbit/FPS modes above; only the host's creature/player state is mirrored visually.

Per `CLAUDE.md`, the legacy `creature-viewer.html` is a separate, older single-file app (not
read in depth for this doc) — it is documented to use orbit-style camera interaction for its
creature sandbox; this WebGPU `environment-viewer.html` is the only place in this repo with the
FPS pointer-lock walk mode and light-gun controls.

## UI integration point

`environment-ui.js`'s `createEnvironmentUi({ perfLog })` is called once, at line 2452, after all
other panels exist; it mounts the separate debug/perf-readout panel (covered in `infra.md`). The
"Scene controls" (`#ctrl`) and "Walk controls" (`#fps`) panels, by contrast, are built **inline**
in this file (the `header()`/`slider()`/`select()`/`toggle()` closures around lines 1507–1574 and
the FPS panel construction around line 2273+) — they are not part of `environment-ui.js`.
