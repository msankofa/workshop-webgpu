# Lighting Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#lighting)

## Purpose

Two independent lighting layers compose the scene's illumination. `lights.js` provides the
baseline rig — one `THREE.DirectionalLight` (sun) + `THREE.AmbientLight` (sky fill) — that
drives shadows and pushes its sun direction/intensity into the water and grass systems so the
whole scene reads as lit from one source. `clustered-lights.js` adds an optional, GPU-compute
clustered (froxel) forward+ point-light layer for many dynamic point lights, evaluated in TSL
and injected additively into materials via an `emissiveNode` callback. The point-light cluster
math has a pure-JS twin in `light-cluster.js` that exists solely so the culling algorithm can be
unit-tested in Node without a GPU.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `lights.js` | Sun + ambient rig: creates `DirectionalLight`/`AmbientLight`, exposes setters, pushes sun direction/intensity to connected water/grass systems, builds its own optional floating UI panel. | 205 |
| `clustered-lights.js` | GPU clustered point-light system: allocates `StorageBufferAttribute` buffers, runs a per-frame TSL compute pass that culls lights into froxels, and exposes a TSL `pointLightTerm` shading function (Cook-Torrance GGX) for materials to sample. | 274 |
| `light-cluster.js` | Pure-JS (no three.js) reference implementation of the froxel culling math — exponential Z-slicing, view-space froxel AABBs, sphere/AABB tests, exact per-froxel assignment, and the Z-bin + per-tile bitmask scheme. Importable/testable in plain Node. | 142 |
| `test-light-cluster.mjs` (repo root) | Node test script that imports `light-cluster.js` and checks its math. | 100 |
| `point-light-pool.js` | Fixed pool of resident `THREE.PointLight`s that serialized light entities (`entity-types/light.js` / `entity-types/projectile.js` wire shape) borrow by id — the THREE-light twin of `light-entity-renderer.js`'s clustered slot pool, for pages without clustered lights (`base-game.html`'s dev-gun lights). Same slot rules: reject-newest, slots freed by vanished ids available the next sync, intensity-driven residents (never `.visible`, the WebGPU pipeline-hash rule). Keep it and `light-entity-renderer.js` in mind together when the entity wire shape changes. | 60 |
| `test-point-light-pool.mjs` (repo root) | Node test of the pool's slot logic against a stub THREE. | 66 |

## Public API

`lights.js`:
```js
export function createLightingRig(options = {}) // options: { scene, azimuth, elevation,
  // sunColor, sunIntensity, ambientColor, ambientIntensity, ui, uiParent }
```
Returns a `rig` object: `{ dirLight, ambLight, connect(water, grass), dispose(),
setAzimuth(v), setElevation(v), setSunColor(v), setSunIntensity(v), setAmbientColor(v),
setAmbientIntensity(v), get azimuth(), get elevation() }`.
- `connect(water, grass)` registers a water system (must have `.setLightDir`) and/or one or
  more grass systems (must have `.setAmbient`/`.setKey`), then immediately pushes current
  values to them. No per-frame call is needed — setters push on every change.
- Setters are safe to call every frame (the time-of-day drivers in `environment-viewer.html`
  and `base-game.html` do): a setter whose value is unchanged returns before pushing, and the
  direction vector handed to `setLightDir` is a shared scratch — consumers must copy it, not
  keep the reference.

`clustered-lights.js`:
```js
export function createClusteredLights(opts) // opts: { renderer, camera, tile, zSlices, near,
  // far, maxPerFroxel, capLights, count, animate, reserve }
```
Returns `{ pointLightTerm, async update(t), setCount(n), resize(w, h),
setLightDirect(i, {x,y,z,radius,r,g,b,intensity}), clearLight(i), get lightCount(),
get froxelCount(), get stats(), dispose() }`.
- `pointLightTerm(posWorld, nWorld, albedo, rough, metal)` is a TSL node-producing function a
  material's `emissiveNode` calls per-fragment to sample the froxel's culled light list and
  accumulate GGX shading.

`light-cluster.js` (all named exports, pure functions, no side effects, no three.js dependency):
```js
export function zSlice(d, cfg)
export function sliceDepthRange(s, cfg)
export function froxelViewAABB(tx, ty, s, cfg)
export function sphereIntersectsAABB(c, r, min, max)
export function assignLightsExact(lights, cfg, tilesX, tilesY)
export function buildZBins(sortedLights, cfg)
export function buildTileBitmask(lights, cfg, tilesX, tilesY)
export function froxelLightSet(tx, ty, s, zBins, bitmask, order, tilesX)
```

`point-light-pool.js`:
```js
export function createPointLightPool({ THREE, scene, count = 8, decay = 2 })
```
Returns `{ sync(entities, toLocal), dispose(), lights }`. `entities` is the serialized entity
wire shape (`{ id, p:[x,y,z], color:[r,g,b 0..1], radius, intensity }`); `toLocal(p, out)`
converts a position into the scene's space (`worldCoordinates.toRenderLocal` in base-game).
Call `sync` once per frame with the full current entity list — ids not in the list release
their slot to intensity 0. `radius` is the light's cutoff distance, clamped to 600 in
`entity-types/light.js`; three's punctual falloff inside it is `1 / d^decay` windowed by
`(1 - (d/radius)^4)^2`, so a large radius widens where a light reaches without slowing how fast
it dims. `decay` is the exponent, per entity, clamped 0..4 and defaulting to 2; an entity that
omits it falls back to the pool's constructor `decay`. It reaches the shader as
`PointLightNode.decayExponentNode`, a render-group uniform written from `light.decay` each frame,
so changing it costs a uniform write and never a recompile — unlike `castShadow`, which is in the
lights hash.

`clustered-lights.js` does **not** carry decay: `setLightDirect` takes no such field and its TSL
hardcodes the windowed inverse square. So decay is honoured on the `point-light-pool.js` path
(base-game) and ignored on the clustered path (environment-viewer).

## Wiring (in `environment-viewer.html`)

- `lights.js` is a **static import** (line 41) and the rig is created near the top of the
  module (line 151): `const rig = createLightingRig({ scene, ui: false });` — its built-in
  floating panel is disabled (`ui: false`) because the host page builds its own sliders inline.
  `rig.dirLight` is then configured for shadows (`castShadow`, shadow map size, shadow camera
  frustum) directly by the host. `rig.connect(waterRef, null)` is called once water exists
  (line 2057). Per frame, there is no required call into the rig — `setAzimuth`/`setElevation`/
  `setSunIntensity`/`setAmbientIntensity` are only invoked from slider `onChange` handlers and
  from a shadow-frustum-refit helper that re-reads `rig.azimuth`/`rig.elevation` (lines 624-636,
  1627-1638) to re-aim the sun and shadow camera as the player moves.
- `clustered-lights.js` is loaded via a **lazy `await import()`** (line 263, inside what looks
  like an async setup/feature-detection block) and instantiated once:
  `createClusteredLights({ renderer, camera, count: 256, far: 600, animate: LIGHTS_ANIMATE,
  reserve: 33 })`, immediately followed by `clusteredLightsRef.setCount(0)` (point lights start
  disabled; a UI toggle named `pointLights` re-enables them by calling `setCount(256)`).
  `LIGHTS_ANIMATE` is a URL query flag (`?lightsAnimate=on`). The resulting `pointLightTerm` is
  threaded into grass/forest material creation via `addEmissive: (p, n) =>
  clusteredLightsRef.pointLightTerm(p, n)` (lines 279, 2014). **Per frame**, `clusteredLightsRef
  .update(now / 1000)` is awaited inside the frame profiler (line 2823:
  `frameProfiler.timeAsync('lightsGpu', () => clusteredLightsRef.update(now / 1000))`), which
  re-runs the GPU cull compute pass only when dirty (camera moved, lights animated, or light
  data changed — see Architecture notes).

## Architecture notes

- **Clustered (froxel) point lights**: the cluster grid is `tilesX × tilesY` screen-space tiles
  (`tile` px each, default 32) times `zSlices` (default 24) exponential depth slices
  (Olsson & Assarsson 2012 style). Buffers are allocated for a generous max grid
  (`MAXTX×MAXTY` sized for ~2560×1440 at the configured tile size; `FROXEL_CAP = MAXTX*MAXTY*
  zSlices`) and the *active* grid is clamped to the current resolution via `resize(w,h)`.
- **GPU buffers**: three `StorageBufferAttribute`s — `lightAttr` (2 vec4s per light: position+
  radius, color+intensity, capacity `capLights`), `countAttr` (uint per froxel: light count),
  `idxAttr` (uint per froxel-slot, `FROXEL_CAP * maxPerFroxel`: light index list). These are
  wrapped as TSL `storage(...)` nodes for both the compute kernel and the shading function.
  Light data is written/mutated directly on `lightAttr.array` from JS (`writeLights`,
  `setLightDirect`, `clearLight`) and flushed via `lightAttr.needsUpdate = true`.
  - **Slot ownership (since 2026-07-03):** the reserved dynamic range (slots 223–255, the
    `reserve: 33`) is now owned exclusively by `light-entity-renderer.js`
    (`createLightEntityRenderer`), the renderer-binding layer for the replicated entity registry.
    It is the ONLY caller of `setLightDirect`/`clearLight` for dynamic light-gun lights (solo,
    host, and guest all go through it) — gameplay code no longer writes slots directly. Diffs
    entities by id, assigns/reuses/frees slots, reject-newest when the 33-slot pool is full. See
    `docs/subsystems/multiplayer.md` §9 and
    `docs/superpowers/plans/2026-07-03-entity-registry-light-migration.md`.
  - **v1 cull algorithm** (the `cull` TSL `Fn`, run as `.compute(FROXEL_CAP)`, one GPU thread
    per froxel): for each froxel, compute its view-space AABB from the NDC tile corners at the
    slice's near/far depth, then loop all `count` lights doing an exact sphere-vs-AABB test
    (clamped-point squared distance), writing matching light indices into that froxel's slot of
    `indices` (capped at `maxPerFroxel`) and the count into `counts`. No atomics — each froxel
    owns its own index-list slice, so there's no contention.
  - Recull is skipped (`update()` returns early) unless lights changed (`animate: true`),
    the camera view matrix changed (`viewChanged()`, compared against the last matrix with an
    epsilon), or something called `markDirty()` (e.g. `setCount`, `resize`,
    `setLightDirect`/`clearLight`). `stats` exposes `reculls`/`skippedReculls` for profiling.
  - **Shading**: `pointLightTerm` is a TSL function a material's `emissiveNode` calls per
    fragment. It re-derives the fragment's froxel index from `screenUV` and view-space depth,
    reads that froxel's light count/index list, and accumulates a Cook-Torrance GGX
    (D = GGX, G = Schlick-GGX height-correlated approx, F = Schlick Fresnel) direct lighting sum
    with a smooth windowed inverse-square falloff (`1 - (dist/radius)^4`, clamped, squared).
    This is purely additive over three.js's existing sun/ambient lighting — it does not replace
    or interact with `lights.js`'s `DirectionalLight`/`AmbientLight`.

- **Relationship between `clustered-lights.js` and `light-cluster.js` — hypothesis confirmed.**
  Verified by reading both files in full and grepping each for cross-references:
  - `clustered-lights.js` imports only `three`, `three/webgpu` (`StorageBufferAttribute`), and
    `three/tsl` node helpers. It does **not** import `light-cluster.js` anywhere — the only
    mention of `light-cluster.js` in that file is a prose comment ("Cull math is the Node-tested
    twin in light-cluster.js", line 6) and another comment noting a documented-but-unimplemented
    perf refinement ("The Drobot Z-bin/bitmask cull (also Node-tested) is the documented perf
    refinement for later", line 10).
  - `light-cluster.js` imports nothing (no `three`, no `clustered-lights.js`) — it's standalone
    plain JS.
  - The only file that imports `light-cluster.js` is `test-light-cluster.mjs`.
  - So: `light-cluster.js` is a **CPU-only reference twin**, hand-kept in sync with the TSL math
    in `clustered-lights.js`'s `cull` kernel (same exponential Z-slicing formula, same
    view-space froxel AABB derivation, same sphere/AABB test) purely so that math can be
    unit-tested in Node without a GPU. It is not loaded, imported, or executed by the production
    runtime path in any way — `clustered-lights.js` runs its own copy of the cull logic directly
    as a TSL compute shader on the GPU.
  - One asymmetry worth noting: `light-cluster.js` additionally implements the **Z-bin + tile
    bitmask** culling scheme (`buildZBins`, `buildTileBitmask`, `froxelLightSet`) described as
    the future perf refinement — this is tested ahead of being ported into the GPU kernel, which
    today still uses only the brute-force `assignLightsExact`-equivalent per-froxel light loop.

## Tunable parameters

`environment-ui.js` (`createEnvironmentUi`) is the frame-profiler/perf overlay panel; its only
lighting-related entry is a display row, not a tunable: `PERF_ROWS` includes
`['lightsGpu', 'Lights GPU', 'passLightsMs']`, which surfaces the per-frame
`clusteredLightsRef.update()` timing captured by `frameProfiler.timeAsync('lightsGpu', ...)`.

The actual lighting sliders are built inline in `environment-viewer.html` (not in
`environment-ui.js`), under a "Lighting" header (~line 1634):

| Key | Label | Range | Step | Effect |
|---|---|---|---|---|
| `elevation` | Sun elevation | 2–88 | 1 | `rig.setElevation(...)` |
| `azimuth` | Azimuth | 0–360 | 1 | `rig.setAzimuth(...)` |
| `sunIntensity` | Sun intensity | 0–4 | 0.05 | `rig.setSunIntensity(...)`, also rebrightens tree billboards via `forestGPURef?.setBillboardBrightness(billBrightness())` |
| `ambientIntensity` | Ambient | 0–2 | 0.05 | `rig.setAmbientIntensity(...)`, also rebrightens tree billboards |
| `pointLights` (toggle) | Point lights | off/on | — | `clusteredLightsRef.setCount(params.pointLights ? 256 : 0)` |

Defaults set at startup: `{ elevation: 80, azimuth: 198, sunIntensity: 4.0,
ambientIntensity: 0.8 }`; point lights start disabled (count 0) until toggled.
`createClusteredLights` itself is also configured with fixed startup options not exposed as
sliders: `tile`, `zSlices`, `near`/`far` (600), `maxPerFroxel`, `capLights`, `count` (256),
`reserve` (33), and `animate` (only `true` if URL has `?lightsAnimate=on`).

## Time-of-day driver

`environment-viewer.html` also has a "Time of day" header, built directly above "Lighting"
in the same forest-panel scope, that can drive the rig from real solar geometry instead of
manual sliders. It statically imports `sunPosition`/`moonPosition` from `solar-position.js`
(pure declination/hour-angle math, no three.js dependency — see `docs/subsystems/sky.md`) and
`lerpHex` from `sky-field.js`.

- **Master toggle**: `params.todEnabled` (toggle, off by default). While on, `applyTimeOfDay()`
  runs once per frame from the sky block in `animate()` and **overwrites** `rigP.elevation`,
  `rigP.azimuth`, `rigP.sunIntensity`, `rigP.ambientIntensity` and their on-screen sliders every
  frame — manual drags to the Elevation/Azimuth/Sun intensity/Ambient sliders while the driver
  is on are visually reflected but overwritten the next frame. Turning the toggle off simply
  stops calling `applyTimeOfDay()`; the rig keeps whatever values the driver last wrote, and
  manual sliders regain normal control from there.
- **Clock inputs**: `todHour` (0–24, HH:MM display), `todLatitude` (−90–90, default 45),
  `todDayOfYear` (1–365, default 172 ≈ solstice), `todMoonPhase` (0–24 h offset fed to
  `moonPosition`'s anti-sun approximation, default 12). `todSpeed` (0–600 game-min/real-sec) +
  a Play/Pause button (`todPlaying`) auto-advance `todHour` in the per-frame sky block:
  `todHour = (todHour + todSpeed * rawDt / 60) % 24`.
- **`applyTimeOfDay()` behavior** (only reachable while `skyRef` — the lazy-loaded `sky.js`
  instance — exists; a no-op-safe early return handles the brief window before it resolves):
  1. Computes `sun = sunPosition({...})` and `moon = moonPosition({...})` for the current clock.
  2. Drives `rig.setElevation(sun.elevationDeg)` / `rig.setAzimuth(sun.azimuthDeg)` directly
     (azimuth/elevation from `solar-position.js` map straight onto the rig's convention, no
     conversion — see `docs/superpowers/specs/2026-07-16-time-of-day-cycle-design.md`).
  3. `skyRef.updateDome(sun.elevationDeg)`, then reads `skyRef.nightness` for the ambient ramp.
  4. Sets independent sun/moon directions via `skyRef.setSunDir`/`setMoonDir` (a local
     `dirFromAzEl(elevDeg, azDeg, out)` helper mirrors `skyLightDir()`'s az/el-to-vector
     convention) and `skyRef.setCelestialVisibility(sunVisible, moonVisible)`, each visible when
     that body's elevation is above −2°.
  5. **Sun intensity** ramps in as the sun rises: `todSunMax * smoothstep(-2, 8, sun.elevationDeg)`
     (`todSunMax = rigP.sunIntensity`, the manual default, so driver and manual peaks agree).
  6. **Sun color** warms near the horizon: `lerpHex('#ffb066', '#fff4e0', smoothstep(0, 12,
     sun.elevationDeg))` — orange low sun to neutral daylight by ~12° elevation.
  7. **Ambient** cross-fades day/night fill: `todAmbNight + (todAmbMax - todAmbNight) * (1 -
     nightness)`, with `todAmbNight = 0.12` and `todAmbMax = rigP.ambientIntensity`.
  8. **Moon light**: `moonLight.intensity = 0.35 * smoothstep(-2, 10, moon.elevationDeg) *
     nightness`, aimed at the moon direction (not the sun direction) — it only shows up once the
     moon has cleared the horizon AND the scene has actually gone dark, so day + high moon
     doesn't wash out the sunlit ramp.
  9. Rebrightens tree billboards via `forestGPURef?.setBillboardBrightness(billBrightness(...))`,
     same helper the manual sliders use.
  10. **First activation** (latched via a local `todActivated` flag) calls
      `skyRef.setCelestialOpacityMode(true)` once, so stars/Milky Way/planets start fading in
      with `nightness` automatically — this is the same call the "Celestial opacity follows
      time" checkbox makes manually.
  - After writing `rigP`/`params`, it calls a small `syncControlDisplays(names)` helper (refreshes
    each registered slider's DOM label/value from its bound object without re-firing `onChange`)
    so the Lighting sliders visually track the driven values every frame.
- **Persistence**: `todEnabled`/`todHour`/`todLatitude`/`todDayOfYear`/`todMoonPhase`/`todSpeed`
  live on the shared `params` object, so they're captured for free by the generic
  `slider()`/`toggle()` self-registration (`controlRegistry` → `captureSliderState`/
  `applySliderState`/`saveSliderState`) that already backs presets and multiplayer world-setting
  sync — there is no separate export/import block to hand-maintain. `todPlaying` is registered
  the same way via a manual `controlRegistry.push` (it's driven by a Play/Pause button, not a
  standard slider/toggle control).

## Tests

`test-light-cluster.mjs` is a standalone Node script (no test framework — manual `ok()`
assertions, `process.exit(fail ? 1 : 0)`) exercising only `light-cluster.js`, against a small
hand-built 4×4-tile, 4-slice grid (`near=1, far=100, tile=32, screenW=screenH=128`):
- Exponential Z-slicing: `zSlice(near)===0`, sub-near depths clamp to slice 0, near-far depths
  map to the last slice, depths beyond far clamp to the last slice, slice index is monotonic
  non-decreasing in depth, and `sliceDepthRange` round-trips with `zSlice` (a depth at the
  geometric mid-point of slice `s`'s range maps back to `s`).
- Froxel view-space AABBs: a deeper froxel is wider in X (perspective), `min.z`/`max.z` equal
  `-dFar`/`-dNear` of the slice, and adjacent tiles share an exact X face (no gap/overlap).
- `sphereIntersectsAABB`: center-inside, just-touching, and clearly-outside cases.
- Light assignment correctness: builds 3 lights (one mid-depth center, one deeper off-center,
  one **behind the camera**), computes the brute-force exact per-froxel assignment via
  `assignLightsExact`, and checks that the Z-bin ∩ tile-bitmask scheme (`buildZBins` +
  `buildTileBitmask` + `froxelLightSet`) is a **conservative superset** of the exact result (no
  froxel is ever missing a light the exact test assigned it) and that the light behind the
  camera leaks into zero froxels.
- Bitmask capacity: with 100 lights, `buildTileBitmask` allocates `ceil(100/32)` words per tile
  and a correctly sized buffer (`words * tilesX * tilesY`), i.e. no overflow.

Note: this test only covers `light-cluster.js`'s pure-JS math (including the Z-bin/bitmask
scheme not yet used in production). It does not exercise `clustered-lights.js`'s actual TSL
compute kernel, `lights.js`'s rig, or the WebGPU runtime path at all — there is no GPU-backed
test for the production cull shader or the directional/ambient rig.
