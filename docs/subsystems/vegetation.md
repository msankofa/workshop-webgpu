# Vegetation subsystem (trees + grass)

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#vegetation)

## Purpose

Procedurally generates and renders all vegetation for the WebGPU environment viewer: recursive
swept-tube trees (CPU geometry, GPU-instanced draw) and wind-animated grass blades (either a
CPU-built per-chunk mesh or a fully GPU-compute-driven field). Both systems share the same goals —
deterministic seeded placement (so a given seed/camera position always produces the same scene,
with no "swimming" instances as the camera moves), capped GPU buffers sized for a worst case, and
a reset → cull/generate → finalize compute pipeline that writes survivor counts into indirect draw
buffers so the CPU never reads back GPU state.

## Files

| File | Responsibility |
|---|---|
| `trees.js` (454 lines) | `Tree`/`createTree`: CPU procedural generator. Recursive tapered-tube branch skeleton + billboard/silhouette leaves, merged into 3 `THREE.Mesh`es (branches, leaves, shadow-casting leaves). No GPU/TSL code. |
| `tree-textures.js` (97 lines) | `createTextureSource('authored'\|'procedural')`: loads ez-tree bark/leaf texture packs into a 2x2 leaf atlas canvas (authored), or returns a textureless stub set (procedural, WebGPU-friendly). |
| `forest-placement.js` (183 lines) | Pure, three.js-free placement math lifted verbatim from `environment-viewer.html`: seeded RNG, species taxonomy (`buildSpecies`), per-chunk tree count/placement patterns, and `placementRecords()` — the single entry point the GPU and (formerly) baked paths both consume. |
| `forest-palette.js` (84 lines) | `createForestPalette()`: bakes a fixed set of variant geometries (species x variantsPerSpecies) ONCE at startup using `trees.js` + `forest-placement.js`'s `buildSpecies`, flat-coloring each variant's vertices (bark/leaf tint) since materials use `vertexColors: true`. |
| `forest-gpu.js` (399 lines) | `createForestGPU()`: GPU-instanced forest renderer. CPU placement fills a source storage buffer; a TSL compute pipeline (reset → cull → finalize) culls by camera distance into 4 LOD bands per variant and writes per-variant indirect draw buffers. |
| `forest-cull.js` (8 lines) | `cullInstance(rec, cam, maxDist)`: pure JS twin of the cull math in `forest-gpu.js`'s TSL `cull` kernel, kept only so the predicate is unit-testable in Node without a GPU. **Not imported by `forest-gpu.js`** (confirmed — `forest-gpu.js` has no `import` of `forest-cull.js`; the TSL kernel reimplements the same `dx*dx+dz*dz <= maxDist*maxDist` logic inline). |
| `grass.js` (536 lines) | `Grass`/`createGrass`: CPU-built single merged-mesh grass field (5 verts/blade) with a TSL `MeshStandardNodeMaterial` (wind sway, distance fade, base→tip color, cloud-shadow noise). Also exports `buildBladeGeometry`, `buildGrassNoiseFns`, and JS parity helpers `grassWindOffset`/`grassFadeKeep` used both at runtime and by tests. |
| `grass-compute.js` (348 lines) | `createComputeGrass()`: fully GPU-driven grass. A TSL compute pass regenerates candidate blades each frame over a world-cell window around the camera, plants them on a TSL terrain-height function, culls (water/radius/density), and atomically compacts survivors into one indirect-drawn instance buffer. |
| `grass-cells.js` (58 lines) | Pure cell-grid math: `cellHash`, `candidateBlade` (deterministic per-(cell,slot) blade, the JS twin of `grass-compute.js`'s TSL placement), `windowCellCount`, `maxInstances`, `perCellCount`. Used both as the Node-testable spec and by `grass-compute.js` for buffer sizing. |
| `grass-height-ref.js` (33 lines) | `grassHeightRef(params, x, z)`: independent JS re-derivation of `terrain-field.js`'s `terrainHeightAt`, written with the same ops the TSL height function in `grass-compute.js` uses, so terrain conformance is provably bit-matched in tests. |

## Public API

```js
// trees.js
export class Tree extends THREE.Group { constructor(options = {}); regenerate(options); regenerateLeaves(leafOpts); dispose(); }
export function createTree(options): Tree

// tree-textures.js
export const LEAF_FILES; export const LEAF_ATLAS;
export function createTextureSource(mode: 'authored'|'procedural', { onReady } = {}): TextureSet

// forest-placement.js
export function rngFrom(seed): { next(), range(a,b) }
export function hash2(ix, iz, seed): number
export function buildSpecies(p, rng): SpeciesOptions[]
export function placementRecords(chunks, params, heightAt): { x, z, scale, yaw, speciesIdx, chunkKey, slot }[]

// forest-palette.js
export function createForestPalette({ createTree, params, masterSeed, variantsPerSpecies = 4, texSet = null }):
  { variants: { speciesIdx, variant, branches, leaves, shadow, leavesCoarse }[], variantsPerSpecies, speciesCount }

// forest-gpu.js
export function createForestGPU(opts: { renderer, camera, palette, heightAt?, treeBaseOffset?, capPerVariant?, lodR0?, lodR1?, lodR2?, addEmissive? }):
  { meshes, applyTextureSet(fn), billboardMaterials, applyBillboardMap(g, tex), setBillboardBrightness(val),
    setChunk(key, records), setChunks(map), clearChunk(key), setLodDistances(r0, r1, r2),
    update(): Promise<void>, stats, dispose() }

// forest-cull.js
export function cullInstance(rec: {x,z}, cam: {x,z}, maxDist): boolean

// grass.js
export function grassWindOffset(worldX, uTime, uWindSpeed, uWaveSize, uInvExtent): number
export function grassFadeKeep(camDist, start, end): number
export function buildBladeGeometry(opts = {}): THREE.BufferGeometry
export function buildGrassNoiseFns(): { hash2D, noise2D }   // TSL Fn nodes
export class Grass extends THREE.Mesh {
  constructor(options = {}); update(seconds); setAmbient(v); setKey(v); setWind(strength);
  setFade(start, end); regenerate(options); dispose();
}
export function createGrass(options): Grass

// grass-compute.js
export function createComputeGrass(opts: { renderer, camera, cellSize?, Kmax?, maxRadius?, density?, radius?,
  waterLevel?, shoreMargin?, terrainParams?, cullStart?, maxBlades?, bladeHeight?, bladeWidth?, verticalOffset?,
  heightTex?, heightTexBounds?, grassRecull?, addEmissive? }):
  { mesh, update(seconds): Promise<void>, forceRecull(), stats, setDensity(d), setRadius(r), setCullStart(wu),
    setMaxBlades(n), setBladeHeight(v), setBladeWidth(v), setVerticalOffset(v), maxRadius, setWind(strength),
    setTerrain(p), setWaterLevel(wl), dispose() }

// grass-cells.js
export function cellHash(gx, gz): number
export function candidateBlade(cfg: {cellSize, params}, gx, gz, slot): { x, y, z, yaw, tipYaw, h }
export function windowCellCount(R, cellSize): number
export function maxInstances(R, cellSize, Kmax): number
export function perCellCount(density, cellSize, Kmax): number

// grass-height-ref.js
export function grassHeightRef(params: {baseAmp, lake, lakeDepth}, x, z): number
```

## Wiring

In `environment-viewer.html`:

- `GRASS_MODE` (line 55) = `new URLSearchParams(location.search).get('grass') || 'gpu'`. Branch (around
  line 1838-2035): `GRASS_MODE === 'cpu'` lazily `import('./grass.js?v=density-fix-4')` and builds a
  per-chunk `makeChunkGrassManager()` (one `Grass` mesh per terrain chunk, rebuilt on count/water
  change). Otherwise (default `'gpu'`) lazily `import('./grass-compute.js')` and wraps
  `createComputeGrass()` in a thin `grassRef` adapter. Only one of the two modes is ever loaded.
- `FOREST_MODE` (line 59) = `...get('forest') || 'gpu'`. Trees are always loaded via
  `Promise.all([import('./trees.js'), import('./tree-textures.js')])` (line 761), then
  `forest-placement.js` is always imported for `placementRecords`. `forest-palette.js` and
  `forest-gpu.js?v=bill-brightness` are only imported when `FOREST_MODE === 'gpu'` (line 788-791);
  there is no other forest mode left wired up in this branch (comments reference a retired
  "baked" path).
- Cache-busted import URLs in use: `forest-gpu.js?v=bill-brightness`, `grass.js?v=density-fix-4`.
  `grass-compute.js` and `forest-placement.js`/`forest-palette.js` are imported with no query
  string. These `?v=` suffixes are a manual cache-bust convention (no bundler) — bump the suffix
  string when a module's behavior changes and a stale cached copy could otherwise be served.
- Both forest and grass loads are wrapped in `.catch()` so a missing/failed module degrades to "no
  trees" / a `showError(...)` toast rather than blocking the rest of the scene.

Inter-module dependencies:

- `forest-palette.js` imports `{ buildSpecies, rngFrom }` from `forest-placement.js` so the palette's
  species options are generated identically to what `placementRecords()` used to pick `speciesIdx`
  (same `masterSeed`, same RNG draw order).
- `forest-gpu.js` does **not** import `forest-placement.js` or `forest-cull.js` directly — the host
  script (`environment-viewer.html`) calls `placementRecords()` and feeds the resulting records into
  `forestGPU.setChunk()/setChunks()`; `forest-gpu.js`'s TSL `cull` kernel reimplements the
  `forest-cull.js` predicate independently (see Files note above).
- `grass-compute.js` imports `{ buildBladeGeometry, buildGrassNoiseFns }` from `grass.js` (reuses the
  single-blade local-space geometry and the value-noise cloud-shadow TSL `Fn`s so the two grass
  modes look visually consistent) and `{ maxInstances, perCellCount }` from `grass-cells.js` for
  buffer sizing / density-to-per-cell-count conversion.
- `grass-cells.js` imports `{ grassHeightRef }` from `grass-height-ref.js` so `candidateBlade()`
  plants its JS reference blade on the same height the TSL kernel in `grass-compute.js` computes.
- `grass-height-ref.js` has no internal dependencies; it is an independent hand-port of
  `terrain-field.js`'s `terrainHeightAt`, verified against it only by `test-grass-height-tsl.mjs`.

## Architecture notes

**GPU-instanced forest (`forest-gpu.js`).** Placement is CPU-side (`forest-placement.js`), geometry
baking is CPU-side-once (`forest-palette.js`), but per-frame work is GPU-only:
- One global source buffer and one global draw buffer, each sized `V * CAP` (forest) where `V` =
  `palette.variants.length` (species x variantsPerSpecies) and `CAP` = `capPerVariant` (viewer
  passes 2048). Variant `g` owns the fixed slot range `[g*CAP, (g+1)*CAP)` in the source buffer;
  CPU `rebuild()` writes into that range and drops (`console.warn`s once) any tree beyond `CAP` for
  its variant.
- The compute pipeline is `reset` (zero `V*LODS` atomic survivor counters) → `cull` (one invocation
  per `V*CAP` source slot: distance-bucket the live ones into 1 of 4 LOD rings using `atomicAdd` to
  claim a compact output slot in the draw buffer, mirroring `forest-cull.js`'s squared-distance
  test) → `finalizersA`/`finalizersB` (8 tiny `.compute(1)` kernels per variant, split across two
  arrays to stay under WebGPU's per-stage storage-binding limit, that copy the atomic counts into
  each mesh type's `IndirectStorageBufferAttribute` element 1 = `instanceCount`). All of this is
  submitted in a single `renderer.computeAsync([reset, cull, ...finalizersA, ...finalizersB])` call
  (`update()`), explicitly awaited so the indirect-draw read of `instanceCount` never races the
  compute write — the comments note 14 separate awaited submits/frame were a measured CPU cost
  before this consolidation.
- 4 LOD levels per variant: L0/L1 (full branch+leaf geometry, different materials/instance node
  graphs), L2 (full branches + a separately-baked coarse/cheap leaf geometry,
  `leavesCoarse`, controlled by `coarseLeafRatio`/`coarseLeafSizeMult`), L3 (a single
  camera-facing billboard plane per tree, cylindrically aligned so it stays upright). Each variant
  draws up to 8 meshes (`branchesL0, leavesL0, shadowL0, branchesL1, leavesL1, branchesL2,
  coarseLeavesL2, billboardL3`), so `stats.draws = V * 8`.
- `dirty`/camera-epsilon tracking (`EPS = 0.001`) skips recull work when the camera hasn't moved and
  nothing else changed (`skippedReculls` counter), same pattern as `grass-compute.js`.

**CPU vs GPU grass.** `grass.js` (`GRASS_MODE=cpu`) builds one full `BufferGeometry` per terrain
chunk on the main thread (queued/staggered via `buildQueue`/`processQueue` in the viewer's
`makeChunkGrassManager`), with per-vertex wind/height/UV baked at build time; wind sway and the
world-distance fade are still TSL-uniform-driven so they animate without a rebuild. `grass-compute.js`
(`GRASS_MODE=gpu`, default) has no per-chunk meshes at all: a single instanced mesh draws candidate
blades generated fresh by the GPU every recull, addressed purely by `(cell, slot)` so blade identity
never depends on accumulated state — this is what "blades never swim" means in the file's header
comment. Buffer capacity (`CAP = maxInstances(maxRadius, cellSize, Kmax)`) is sized for the
slider's *maximum* radius so the live Radius slider can grow without a reallocation.

**Deterministic seeded placement.** Both forest and grass placement are pure functions of
integer cell/chunk coordinates plus a `masterSeed`/seed salt, using the same `mulberry32`-style hash
(`rngFrom`/`hash2` in `forest-placement.js`; `cellHash`/`slotRand` in `grass-cells.js`, mirrored as
TSL `lakeHashFn`/`slotRandFn` in `grass-compute.js`). This is why `forest-placement.js`'s header
comment stresses that `placementRecords()` consumes its RNG stream "in the SAME order as the baker"
(species draw → seed draw → size draw → yaw draw) — reordering the draws would desync forest
placement from whatever else (historically the CPU "baked" path) shared the same seed.

## Tunable parameters

These live as inline `slider()`/`select()` calls in `environment-viewer.html` (around lines
1582-1610 for trees, 1983-1986 for CPU grass, 2027-2034 for GPU-compute grass), not in
`environment-ui.js`. `environment-ui.js` (checked via grep) only contains read-only stats-panel
labels for this subsystem (`'Grass GPU'`/`passGrassMs`, `'Forest GPU'`/`passForestMs`, and the
`Grass`/`Forest` debug-overlay rows showing chunk/instance/draw/recull counts) — it defines no
sliders itself.

Forest (`header('Forest')`, always shown):
`count` (Tree count, 0-4500), `placement` (random/clustered/scattered/ring), `maxSize`, `sizeVar`,
`skew`, `varPattern` (random/noise/gradient), `species` (1-8), `diversity`, `generalization`,
`treeBaseOffset`, `leafCount`, `leafSize`, `leafStart`, `leafSpread`, `leafShadowPct`.

Forest GPU-only (`FOREST_MODE === 'gpu'`, header `'Tree LOD'`): `treeLodR0`/`treeLodR1`/`treeLodR2`
(LOD ring distances, live-applied via `forestGPU.setLodDistances`), `coarseLeafRatio`,
`coarseLeafSizeMult` (both rebake the palette), and a billboard-mode toggle button (`cross-quad`).

Grass CPU mode (`GRASS_MODE === 'cpu'`): `grassCount` (blade count, 0-1.2M), `mapGrassRadiusChunks`
(map mode only), `grassDistanceCull` (far fade), `wind`.

Grass GPU-compute mode (`GRASS_MODE === 'gpu'`, default): `grassRadius` (8-600), `grassCullStart`,
`grassDensity` (blades/m^2, 0-16), `grassMaxBlades` (0-2,000,000), `grassBladeHeight`,
`grassBladeWidth`, `grassVerticalOffset`, `wind`.

## Tests

| Test file | Covers | What it actually checks |
|---|---|---|
| `_audit_trees.mjs` | `trees.js` (`createTree`) | Headless geometry audit: finite vertex positions, unit-length normals, indices in range and a multiple of 3, UV finiteness/range, across default/rounded-normals-off/atlas/pinned-atlas-cell/shadow-split configs; a "merge fix" regression case (passing texture-like objects where `DEFAULTS` has `null` must not throw and must preserve the reference); and `regenerateLeaves()` leaving branch geometry untouched while changing leaf vertex count. Not a pass/fail harness with assertions library — accumulates a `failures` counter and exits 1 if any check fails. |
| `test-forest-cull.mjs` | `forest-cull.js` (`cullInstance`) | 4 cases: in-range kept, beyond-maxDist culled, diagonal-beyond-radius culled, diagonal-within-radius kept — i.e. the squared-distance circular cull predicate. |
| `test-forest-gpu-rebuild.mjs` | The `rebuild()` logic pattern in `forest-gpu.js` (reimplemented as a standalone harness, not imported from the real file) | `setChunks(map)` produces the same source/counts buffers as N sequential `setChunk()` calls but triggers exactly one rebuild instead of N; insertion order into the chunk map doesn't change final per-variant counts; an empty `setChunks(new Map())` is a no-op rebuild that leaves buffers zeroed. |
| `test-forest-placement.mjs` | `forest-placement.js` (`placementRecords`) | Places between 1 and `count` trees on flat dry ground; identical output for two calls with the same seed/params (determinism); all placements within chunk bounds; positive `scale`; valid `speciesIdx` range; `yaw` present; submerged ground (`heightAt` returns -5) yields zero placements (water rejection). |
| `test-grass-cells.mjs` | `grass-cells.js` (`cellHash`, `candidateBlade`, `windowCellCount`, `maxInstances`, `perCellCount`) and indirectly `grass-height-ref.js` | `candidateBlade` is deterministic and camera-independent; blade XZ falls inside its own cell footprint; blade `y` equals `grassHeightRef` at that XZ (planted on terrain); different slots in a cell give different positions; `cellHash` varies across cells; `maxInstances` = `windowCellCount * Kmax` and the window covers the disk of radius R; `perCellCount` clamps to `[0, Kmax]` and converts density correctly. |
| `test-grass-height-tsl.mjs` | `grass-height-ref.js` (`grassHeightRef`) vs `terrain-field.js` (`terrainHeightAt`) | Samples a grid (x,z in [-64,64] step 3.5, including fractional/negative coords) and asserts `grassHeightRef` matches `terrainHeightAt` to within `1e-6` — i.e. the JS reference used by grass placement is provably bit-equivalent to the canonical terrain height function the TSL kernel is transcribed from. Also checks determinism and that `lakeDepth` actually perturbs height somewhere in the sampled grid. |
| `test-grass-wind.mjs` | `grass.js` (`grassWindOffset`, `grassFadeKeep`) | Wind offset is deterministic and continuous across a chunk boundary (no seam, `x=29.99` vs `30.01` differ by < 0.05); `grassFadeKeep` returns 1 near the camera, 0 far away, and a partial value in between. |
| `test-cdlod-morph.mjs` (relevant parts only) | Imports `grassHeightRef` from `grass-height-ref.js` to verify a CDLOD terrain-morph crack-free property: a fully-morphed fine-LOD edge vertex's height (via `grassHeightRef`) matches the coarser neighboring LOD's height at the same world position, within `1e-6`. The rest of the file (`morphGridCoord`, `nodeSize` from `cdlod-select.js`) is terrain LOD logic outside this subsystem; `grass-height-ref.js`'s only role here is as the shared height oracle used to prove no vertical crack. |

## Standalone tooling

`tree-viewer.html` is a standalone single-file tuning tool for `trees.js`'s full procedural-tree
parameter surface (per-level branch structure, force, bark, leaves), with Solo/Grid view modes,
a procedural/authored texture toggle, a Lighting section driving `lights.js`'s rig live, and a
"copy tree JSON" export. It imports `trees.js` (`createTree`), `tree-textures.js`
(`createTextureSource`), and `lights.js` (`createLightingRig`) directly, with its own minimal
`WebGPURenderer`/`OrbitControls` scene shell — it is **not** wired into `environment-viewer.html`
in any way, and `environment-viewer.html`'s own Forest panel sliders are unaffected by it. Run via
`python serve.py` like the main viewer (see the directory's `CLAUDE.md`).

The controls panel has two tabs: **Tuning** (View/Texture/Lighting/Mutation/Structure/Force/
Bark/Leaves/Export) and **Species** — a save/load library of tuned trees persisted to
`localStorage` (`tree-viewer:saved-trees`; name + "Save current tree" snapshots the current
options with texture maps stripped, click a saved entry to load it). Structure/Force/Bark/Leaves
each have a "Mutate" button at the top that randomly perturbs that section's numeric sliders
(independently per slider, clamped to each slider's own range) by up to the global "Mutation
degree" fraction of that slider's range — a targeted reroll, not a full regenerate.
