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
