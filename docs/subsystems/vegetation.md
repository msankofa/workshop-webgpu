# Vegetation subsystem (trees + grass)

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#vegetation)
> On authored maps, tree/grass density is gated per-biome — see [biomes.md](biomes.md).

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
| `forest-placement.js` (234 lines) | Pure, three.js-free placement math lifted verbatim from `environment-viewer.html`: seeded RNG, species taxonomy (`buildSpecies`), per-chunk tree count/placement patterns, and `placementRecords()` — the single entry point the GPU and (formerly) baked paths both consume. Also `buildSpeciesFromFamilies()`, which flattens `tree-viewer.html`-authored families into the same species-table shape, letting `placementRecords()` do biome-filtered, density-weighted species selection instead of picking uniformly at random — see "Game integration" below. `rngFrom`/`hash2` are also reused directly by `plants-placement.js`. |
| `forest-palette.js` (86 lines) | `createForestPalette()`: bakes a fixed set of variant geometries (species x variantsPerSpecies) ONCE at startup using `trees.js` + (`params.speciesTable` if an authored family table was loaded, else `forest-placement.js`'s `buildSpecies`), flat-coloring each variant's vertices (bark/leaf tint) since materials use `vertexColors: true`. |
| `grass-textures.js` | 5 procedurally-synthesized blade fiber styles (`streaks`/`dryTip`/`mottle`/`vein`/`highContrast`), baked to one atlas texture; see "Grass blade fiber textures" below. |
| `plants.js` | Parameterized procedural plant generator (`PLANT_DEFAULTS`/`PLANT_PRESETS`/`buildPlantGeometry`/`createPlantPalette`); 4 species: chickweed, cleavers, mint, jewelweed. See "Plants" below. |
| `plants-placement.js` | Biome-gated, density-weighted plant placement (mirrors `forest-placement.js`, reuses its `rngFrom`/`hash2`). |
| `plants-gpu.js` | Single-LOD GPU-instanced plant rendering (mirrors `forest-gpu.js`'s reset→cull→finalize→indirect-draw spine, one distance-cull band instead of 4 LOD bands). |
| `forest-gpu.js` (399 lines) | `createForestGPU()`: GPU-instanced forest renderer. CPU placement fills a source storage buffer; a TSL compute pipeline (reset → cull → finalize) culls by camera distance into 4 LOD bands per variant and writes per-variant indirect draw buffers. |
| `forest-cull.js` (8 lines) | `cullInstance(rec, cam, maxDist)`: pure JS twin of the cull math in `forest-gpu.js`'s TSL `cull` kernel, kept only so the predicate is unit-testable in Node without a GPU. **Not imported by `forest-gpu.js`** (confirmed — `forest-gpu.js` has no `import` of `forest-cull.js`; the TSL kernel reimplements the same `dx*dx+dz*dz <= maxDist*maxDist` logic inline). |
| `grass.js` (536 lines) | `Grass`/`createGrass`: CPU-built single merged-mesh grass field (5 verts/blade) with a TSL `MeshStandardNodeMaterial` (wind sway, distance fade, base→tip color, cloud-shadow noise). Also exports `buildBladeGeometry`, `buildGrassNoiseFns`, and JS parity helpers `grassWindOffset`/`grassFadeKeep` used both at runtime and by tests. |
| `grass-compute.js` (541 lines) | `createComputeGrass()`: fully GPU-driven grass with two placement paths. Procedural mode (no map): a TSL compute pass regenerates candidate blades over a world-cell window around the camera, plants them on a TSL terrain-height function. Anchor mode (authored maps, when `surfaceGeometry` is passed): CPU-sampled mesh anchors from `grass-anchors.js` are streamed into a chunk-slot storage buffer and a TSL kernel culls them instead. Both paths cull (water/radius/density) and atomically compact survivors into one indirect-drawn instance buffer. |
| `grass-anchors.js` (206 lines) | Pure CPU mesh-anchor sampling for anchor mode, no three.js import. `buildChunkIndex()` bins the map collider's world-space triangle soup into XZ chunks of upward-facing triangles (unit normal `y >= minNormalY`), clipping triangles that span chunks exactly to each chunk rectangle (Sutherland–Hodgman; low-poly maps have triangles bigger than a chunk, so centroid binning would leave grassless holes). `sampleChunk()` draws deterministic area-weighted anchor points `(x,y,z,rand01)` on that surface — so blades land on cave floors, overhangs, and floating islands the top-down heightfield can't represent. |
| `grass-cells.js` (58 lines) | Pure cell-grid math: `cellHash`, `candidateBlade` (deterministic per-(cell,slot) blade, the JS twin of `grass-compute.js`'s TSL placement), `windowCellCount`, `maxInstances`, `perCellCount`. Used both as the Node-testable spec and by `grass-compute.js` for buffer sizing. |
| `grass-height-ref.js` (33 lines) | `grassHeightRef(params, x, z)`: independent JS re-derivation of `terrain-field.js`'s `terrainHeightAt`, written with the same ops the TSL height function in `grass-compute.js` uses, so terrain conformance is provably bit-matched in tests. |
| `tree-age.js` | `applyAge(opts, ageT)`: pure sapling→mature transform (scale, branch-recursion "development", leaf count/size) for a `trees.js` options object. No DOM/THREE dependency — used by `tree-viewer.html`'s age-preview slider today, intended for the game's forest placement to reuse later (per-instance age roll) without duplicating the math. |

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
export function buildSpeciesFromFamilies(families): (SpeciesOptions & { _tag: { biomes, density, sizeRange } })[]
export function placementRecords(chunks, params, heightAt, biomeAt?): { x, z, scale, yaw, speciesIdx, chunkKey, slot }[]

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
  heightTex?, heightTexBounds?, grassRecull?, addEmissive?,
  surfaceGeometry?, anchorChunkSize?, anchorMinNormalY?, anchorBudgetMs? }):   // anchor mode (see below)
  { mesh, update(seconds): Promise<void>, forceRecull(), stats, setDensity(d), setRadius(r), setCullStart(wu),
    setMaxBlades(n), setBladeHeight(v), setBladeWidth(v), setVerticalOffset(v), maxRadius, setWind(strength),
    setTerrain(p), setWaterLevel(wl), dispose() }
  // stats gains { anchorMode: boolean, residentChunks: number } in anchor mode

// grass-anchors.js
export function hashKey(str, seed?): number                     // FNV-1a 32-bit
export function mulberry32(seed): () => number                  // deterministic PRNG in [0,1)
export function chunkKey(cx, cz): string
export function parseChunkKey(key): [cx, cz]
export function pointToChunkDist(x, z, cx, cz, chunkSize): number
export function slotCapacityForRadius(radius, chunkSize): number // worst-case chunk count → GPU slot pool size
export function buildChunkIndex(positions: Float32Array, { chunkSize = 32, minNormalY = 0.5 } = {}):
  { chunkSize, minNormalY, chunks: Map<key, { tris, cdf, totalArea }>, triCount, extraTris }
export function sampleChunk(index, positions, key, { density, maxCount?, seed? }):
  Float32Array | null                                            // n*4 floats: (x, y, z, rand01) per anchor

// grass-cells.js
export function cellHash(gx, gz): number
export function candidateBlade(cfg: {cellSize, params}, gx, gz, slot): { x, y, z, yaw, tipYaw, h }
export function windowCellCount(R, cellSize): number
export function maxInstances(R, cellSize, Kmax): number
export function perCellCount(density, cellSize, Kmax): number

// grass-height-ref.js
export function grassHeightRef(params: {baseAmp, lake, lakeDepth}, x, z): number

// tree-age.js
export function applyAge(opts, ageT: number): opts   // ageT clamped to [0,1]; ageT=1 is value-equivalent to opts unchanged

// grass-textures.js
export const FIBER_STYLES: { streaks, dryTip, mottle, vein, highContrast }   // each: { fiber(u,v,seed), tint?(u,v,seed) }
export const STYLE_KEYS: string[]                                // the 5 keys above, in order
export const FIBER_REMAP_MIN, FIBER_REMAP_MAX: number             // fiber() multiplier range encoded into the atlas' R channel
export function clamp01(v): number
export function createGrassStyleAtlas(): THREE.CanvasTexture      // bakes all 5 styles into one atlas (5 tiles in a row)

// plants.js
export const PLANT_DEFAULTS, PLANT_PRESETS: { chickweed, cleavers, mint, jewelweed }, PLANT_BIOME_TAGS
export function mergePlantOpts(base, over): opts                  // deep-merge, same convention as trees.js/grass.js
export function buildPlantGeometry(opts = {}): THREE.BufferGeometry   // indexed geometry with position/normal/color
export function createPlantPalette({ variantsPerSpecies = 4, masterSeed = 1 } = {}):
  { variants: THREE.BufferGeometry[], variantsPerSpecies, speciesCount, speciesTags: { key, tag: { biomes, density } }[] }

// plants-placement.js
export function plantPlacementRecords(chunks, params, heightAt, biomeAt?):
  { x, z, scale, yaw, speciesIdx, chunkKey, slot }[]

// plants-gpu.js
export function createPlantsGPU(opts: { renderer, camera, palette, heightAt?, capPerVariant?, cullRadius? }):
  { meshes, setChunk(key, records), clearChunk(key), setCullRadius(r), update(): Promise<void>, stats, dispose() }
```

## Wiring

In `environment-viewer.html`:

- `GRASS_MODE` (line 55) = `new URLSearchParams(location.search).get('grass') || 'gpu'`. Branch (around
  line 1838-2035): `GRASS_MODE === 'cpu'` lazily `import('./grass.js?v=density-fix-4')` and builds a
  per-chunk `makeChunkGrassManager()` (one `Grass` mesh per terrain chunk, rebuilt on count/water
  change). Otherwise (default `'gpu'`) lazily `import('./grass-compute.js')` and wraps
  `createComputeGrass()` in a thin `grassRef` adapter. Only one of the two modes is ever loaded.
  When an authored map is loaded, the viewer passes `surfaceGeometry: mapCollider.geometry` (the
  MeshBVH world-space triangle soup from `map-collision.js`) into `createComputeGrass()`, which
  switches it into anchor mode; `heightTex` is still passed alongside as the water-envelope lookup
  and as the height source when no map is loaded.
- `FOREST_MODE` (line 59) = `...get('forest') || 'gpu'`. Trees are always loaded via
  `Promise.all([import('./trees.js'), import('./tree-textures.js')])` (line 761), then
  `forest-placement.js` is always imported for `placementRecords`. `forest-palette.js` and
  `forest-gpu.js?v=bill-brightness` are only imported when `FOREST_MODE === 'gpu'` (line 788-791);
  there is no other forest mode left wired up in this branch (comments reference a retired
  "baked" path).
- Cache-busted import URLs in use: `forest-gpu.js?v=bill-brightness`, `grass.js?v=density-fix-4`,
  `grass-compute.js?v=mesh-anchors-1`. `forest-placement.js`/`forest-palette.js` are imported with
  no query string. These `?v=` suffixes are a manual cache-bust convention (no bundler) — bump the
  suffix string when a module's behavior changes and a stale cached copy could otherwise be served.
- Both forest and grass loads are wrapped in `.catch()` so a missing/failed module degrades to "no
  trees" / a `showError(...)` toast rather than blocking the rest of the scene.
- `PLANTS_MODE` = `...get('plants') || 'gpu'`. When `'gpu'` (the default), `plants.js`,
  `plants-placement.js`, and `plants-gpu.js` are lazily imported right after the grass block; a
  `createPlantPalette()` bake, a `createPlantsGPU()` instance, and per-chunk placement (mirroring
  `regenerateGPU`'s forest chunk-lifecycle pattern, hooked into `maybeSyncTerrainDecorations()` via
  `regenPlants`) are wired the same way forest/grass are. There is no `?plants=` alternative mode.

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
  modes look visually consistent), `{ maxInstances, perCellCount }` from `grass-cells.js` for
  buffer sizing / density-to-per-cell-count conversion, and `{ buildChunkIndex, sampleChunk,
  slotCapacityForRadius, chunkKey, parseChunkKey, pointToChunkDist }` from `grass-anchors.js` for
  anchor mode.
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

**Anchor mode (`grass-compute.js` + `grass-anchors.js`).** The procedural path plants blades on a
single-valued height function (TSL terrain math, or the baked 2048² `heightTex` on authored maps) —
structurally incapable of caves, overhangs, or floating islands, and its bilinear filtering smears
height discontinuities into floating grass sheets. When `surfaceGeometry` (the map collider's
non-indexed world-space triangle soup) is passed, `createComputeGrass()` instead:
- builds a chunk index once at load (`buildChunkIndex`, ~740 ms for the 331k-triangle cave-world
  map): upward-facing triangles binned into `anchorChunkSize` (default 32 m) XZ chunks, spanning
  triangles clipped exactly per chunk;
- maintains chunk residency each `update()` (`maintainResidency`): a fixed pool of
  `slotCapacityForRadius(maxRadius, chunkSize)` GPU slots, each `perSlot = round(density × chunkSize²)`
  anchors wide; chunks beyond radius + 1-chunk hysteresis are evicted, missing in-radius chunks are
  CPU-sampled nearest-first within an `anchorBudgetMs` (default 3 ms) per-frame budget and uploaded
  via partial `addUpdateRange` writes. Sampling is deterministic per (chunk key, seed), so a
  re-entered chunk gets identical blades;
- swaps the cull kernel: `anchorCull` reads anchors from the slot buffer (live when its index is
  below the slot's anchor count) instead of generating candidate positions, then applies the same
  radius/density/edge-fade culling and atomic compaction as the procedural kernel.
Blade `y` comes from the actual mesh triangle, so stacked surfaces (cave floor below terrain above)
each get grass. The water test becomes an envelope test: a blade is rejected only if its own `y` is
at-or-below water level *and* the baked `heightTex` envelope there is too — the water plane only
renders where the envelope is below water level, so cave floors that sit below sea level but under
dry ground keep their grass. Known limits: the density slider saturates at the sampled base density
(anchors are pre-sampled at `opts.density`; `setDensity` above that clamps to 1.0 via
`uDensityScale`); stacked layers share one slot's `perSlot` cap, so density halves where two layers
overlap; winding must be consistently outward for the up-facing test (GLB exports are). Trees still
use the top-down `terrainHeight()` — anchor placement for the forest is not yet implemented.

**Deterministic seeded placement.** Both forest and grass placement are pure functions of
integer cell/chunk coordinates plus a `masterSeed`/seed salt, using the same `mulberry32`-style hash
(`rngFrom`/`hash2` in `forest-placement.js`; `cellHash`/`slotRand` in `grass-cells.js`, mirrored as
TSL `lakeHashFn`/`slotRandFn` in `grass-compute.js`). This is why `forest-placement.js`'s header
comment stresses that `placementRecords()` consumes its RNG stream "in the SAME order as the baker"
(species draw → seed draw → size draw → yaw draw) — reordering the draws would desync forest
placement from whatever else (historically the CPU "baked" path) shared the same seed.

**Grass blade fiber textures (`grass-textures.js`).** `FIBER_STYLES`/`STYLE_KEYS` are pure
`fiber(u,v,seed)`/`tint(u,v,seed)` functions, Node-testable without a DOM (`test-grass-textures.mjs`).
`createGrassStyleAtlas()` bakes all 5 into one canvas atlas (5 tiles in a row, R = fiber multiplier
remapped to `[FIBER_REMAP_MIN, FIBER_REMAP_MAX]`, G = tint/dryness amount 0..1) rather than 5 separate
textures — TSL's `texture()` node binds to one texture at shader-graph-build time and can't switch
which texture it samples based on a runtime uniform, so the live style switch instead shifts which
atlas tile a blade's `aBladeUV.x` reads from (`uBladeStyle` uniform, one `.value` write, no shader
recompile). `grass.js` owns a lazy module-scope singleton (`getGrassStyleAtlas()`, exported) so the
atlas is baked exactly once regardless of how many `Grass` instances exist (CPU mode creates one per
chunk). Both `Grass` (`grass.js`) and the object returned by `createComputeGrass` (`grass-compute.js`)
expose `setBladeStyle(key)`. The per-blade local UV (`aBladeUV`, base(0,0)/tip(0.5,1) taper-matched)
lives on the shared `buildBladeGeometry()` template, so both grass modes get it automatically.

**Plants (`plants.js` / `plants-placement.js` / `plants-gpu.js`).** Procedural understory plants,
parameterized like `trees.js` rather than hardcoded per species: `PLANT_DEFAULTS` is a schema (stem
node count/spacing/sprawl; leaf shape/style/leaflet count+parity/arrangement/serration/
variegation/color; flower shape/petals/frequency/color) and `PLANT_PRESETS.{chickweed,cleavers,
mint,jewelweed}` are named overrides. `buildPlantGeometry(opts)` returns one indexed
`THREE.BufferGeometry` per plant with baked vertex colors (stem + leaves + flowers all in one mesh,
one material — no separate branches/leaves/shadow split like forest). Leaf blades are
fan-triangulated from a base/petiole point around a parametric taper-envelope boundary (`leafEnvelope`:
oval/lance/star), with serration cut in as a per-tooth sawtooth multiplier on the boundary radius;
compound leaves (`style: 'complex'`) fan smaller leaflet cards along a shared rachis, honoring
`leafletParity` (odd = terminal leaflet, even = paired only). Flowers reuse the same leaf builder at
petal scale — all 4 shapes (`star`/`whorlBall`/`pouch`/`burPair`) are one shared petal-cluster
generator parameterized by petal length/width/curl/count, not 4 bespoke algorithms.
`createPlantPalette({variantsPerSpecies, masterSeed})` bakes a fixed set of variant geometries once
at startup, mirroring `forest-palette.js`'s role but with no separate color-bake step (the generator
already writes final colors). `plantPlacementRecords(chunks, params, heightAt, biomeAt)` mirrors
`forest-placement.js`'s shape (reuses its `rngFrom`/`hash2`/`valueNoise`); each preset carries a
`PLANT_BIOME_TAGS` allowlist (`cleavers` has an empty allowlist, i.e. it's a biome generalist that
places everywhere; unlike forest's placement, a chunk position with no matching species is simply
skipped rather than falling back to "any species"). An optional `clusterStrength`/`clusterScale`
param pair (default 0 = old flat-uniform behavior) biases each candidate's acceptance by a smooth
`valueNoise` field so plants clump into patches instead of scattering evenly — the same acceptance
check is the intended extension point for future non-biome terrain masks (water/mountain/snow density
fields), not just clustering. `createPlantsGPU(opts)` mirrors `forest-gpu.js`'s
reset→cull→finalize→indirect-draw compute spine but with a single distance-cull band (no LOD levels)
and one mesh per variant (`stats.draws = V`, not `V * 8`); survival between `cullStart` and
`cullRadius` is a stochastic per-instance dither (`keepRand.greaterThan(edge)`, same technique as
`grass-compute.js`'s anchor/procedural cull kernels) keyed by a position-based hash (`posRandFn`, not
buffer-slot index) so the fade pattern stays stable even though `rebuild()` re-sorts and reassigns
buffer slots every call — plants thin out gradually approaching `cullRadius` instead of popping at a
fixed ring. Wired in `environment-viewer.html` behind `?plants=gpu` (default on); density/cull-radius/
cull-start/clustering sliders live in the "Plants" panel.

Plants use their own grass-style windowed chunk set around the player (`plantChunksForPlacement()`,
sized by `plantRadiusChunks`, refreshed as they move) on **both** terrain modes — not
`forestChunksForPlacement()`'s whole-map `makeAllChunks()` on authored maps (trees tolerate that eager
approach via a much larger `capPerVariant`, 2048 vs. plants' 512, but for plants it used to mean the
per-species CAP got consumed by far-away chunks in an arbitrary scan order before the player ever got
near them), and, on infinite/procedural terrain, not `activeTerrainChunks()` either — that window is
sized by the terrain system's own render-distance slider (`terrain.renderRadius`, defaults to 2, i.e.
~60-75 world units), which is much smaller than a useful plant draw distance; reusing it would mean
the edge-fade band never engages and plants would just pop at that smaller window's hard square edge
instead. `plantChunksForPlacement()` builds an independent NxN chunk window on both modes (delegating
to `loadedMap.makeChunks()` when a map is loaded, otherwise building the same shape of window directly
around `terrainFocus`), decoupling plant draw distance from ground draw distance entirely.
`plants-gpu.js`'s `rebuild()` also sorts every pooled instance by true distance to the camera before
allocating each variant's CAP slots (not just relying on chunk window membership), since
`chunkRecords` is a `Map` and `Map.set()` on an existing key doesn't reorder it — without the
in-`rebuild()` sort, newly-entered (nearest) chunks would be appended last in iteration order and get
the *worst* CAP priority, which defeated an earlier attempt at chunk-level distance sorting.

**Standalone tuning tool.** `plants.js`'s data model is fully parameterized specifically so a
standalone tool could expose it — see `plant-viewer.html` under "Standalone tooling" below.

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

Both grass modes also get `grassBladeStyle` (select: `streaks`/`dryTip`/`mottle`/`vein`/
`highContrast`, default `streaks`) — live-swappable, no geometry rebuild.

Plants (`header('Plants')`, `PLANTS_MODE === 'gpu'`, default): `plantDensity` (plants/m², 0-0.2,
rebakes placement) and `plantCullRadius` (10-150, live-applied via `setCullRadius`).

## Tests

| Test file | Covers | What it actually checks |
|---|---|---|
| `_audit_trees.mjs` | `trees.js` (`createTree`) | Headless geometry audit: finite vertex positions, unit-length normals, indices in range and a multiple of 3, UV finiteness/range, across default/rounded-normals-off/atlas/pinned-atlas-cell/shadow-split configs; a "merge fix" regression case (passing texture-like objects where `DEFAULTS` has `null` must not throw and must preserve the reference); and `regenerateLeaves()` leaving branch geometry untouched while changing leaf vertex count. Not a pass/fail harness with assertions library — accumulates a `failures` counter and exits 1 if any check fails. |
| `test-forest-cull.mjs` | `forest-cull.js` (`cullInstance`) | 4 cases: in-range kept, beyond-maxDist culled, diagonal-beyond-radius culled, diagonal-within-radius kept — i.e. the squared-distance circular cull predicate. |
| `test-forest-gpu-rebuild.mjs` | The `rebuild()` logic pattern in `forest-gpu.js` (reimplemented as a standalone harness, not imported from the real file) | `setChunks(map)` produces the same source/counts buffers as N sequential `setChunk()` calls but triggers exactly one rebuild instead of N; insertion order into the chunk map doesn't change final per-variant counts; an empty `setChunks(new Map())` is a no-op rebuild that leaves buffers zeroed. |
| `test-forest-placement.mjs` | `forest-placement.js` (`placementRecords`, `buildSpeciesFromFamilies`) | Places between 1 and `count` trees on flat dry ground; identical output for two calls with the same seed/params (determinism); all placements within chunk bounds; positive `scale`; valid `speciesIdx` range; `yaw` present; submerged ground (`heightAt` returns -5) yields zero placements (water rejection); `buildSpeciesFromFamilies` flattens a family into a species table carrying `_tag`; with a `speciesTable` + an all-`'forest'` `biomeAt`, only the forest-tagged species is ever picked and `scale` stays within its `sizeRange`; without a `biomeAt`, every tagged species stays a density-weighted candidate everywhere. |
| `test-grass-cells.mjs` | `grass-cells.js` (`cellHash`, `candidateBlade`, `windowCellCount`, `maxInstances`, `perCellCount`) and indirectly `grass-height-ref.js` | `candidateBlade` is deterministic and camera-independent; blade XZ falls inside its own cell footprint; blade `y` equals `grassHeightRef` at that XZ (planted on terrain); different slots in a cell give different positions; `cellHash` varies across cells; `maxInstances` = `windowCellCount * Kmax` and the window covers the disk of radius R; `perCellCount` clamps to `[0, Kmax]` and converts density correctly. |
| `test-grass-height-tsl.mjs` | `grass-height-ref.js` (`grassHeightRef`) vs `terrain-field.js` (`terrainHeightAt`) | Samples a grid (x,z in [-64,64] step 3.5, including fractional/negative coords) and asserts `grassHeightRef` matches `terrainHeightAt` to within `1e-6` — i.e. the JS reference used by grass placement is provably bit-equivalent to the canonical terrain height function the TSL kernel is transcribed from. Also checks determinism and that `lakeDepth` actually perturbs height somewhere in the sampled grid. |
| `test-grass-anchors.mjs` | `grass-anchors.js` (all exports) | Cave scene with stacked layers (floor at y=-50, down-facing ceiling, roof top at y=40, vertical wall): only up-facing tris kept, both stacked layers counted in projected area; sample count = density × area; anchor y lands exactly on a surface layer; area-weighted split across layers; deterministic per (key, seed), different seed differs; `maxCount` caps; a 64×64 quad spanning 4 chunks is clipped so each chunk gets ~1024 m² and anchors stay inside their own chunk; helper round-trips (`chunkKey`/`parseChunkKey` with negatives, `pointToChunkDist`, `slotCapacityForRadius` bounds, `hashKey`, `mulberry32`). ~18.5k assertions. |
| `test-grass-wind.mjs` | `grass.js` (`grassWindOffset`, `grassFadeKeep`) | Wind offset is deterministic and continuous across a chunk boundary (no seam, `x=29.99` vs `30.01` differ by < 0.05); `grassFadeKeep` returns 1 near the camera, 0 far away, and a partial value in between. |
| `test-cdlod-morph.mjs` (relevant parts only) | Imports `grassHeightRef` from `grass-height-ref.js` to verify a CDLOD terrain-morph crack-free property: a fully-morphed fine-LOD edge vertex's height (via `grassHeightRef`) matches the coarser neighboring LOD's height at the same world position, within `1e-6`. The rest of the file (`morphGridCoord`, `nodeSize` from `cdlod-select.js`) is terrain LOD logic outside this subsystem; `grass-height-ref.js`'s only role here is as the shared height oracle used to prove no vertical crack. |
| `test-tree-age.mjs` | `tree-age.js` (`applyAge`) | age=1 is value-equivalent to the input opts unchanged; age=0 shrinks length/radius/leaf count/leaf size and reduces `levels`, but never raises `levels` above the species' own count; age values outside `[0,1]` clamp; age=0.5 lands strictly between the age-0 and age-1 results; the input opts object itself is never mutated. |
| `test-grass-blade-uv.mjs` | `grass.js` (`buildBladeGeometry`) | The shared blade template's new `aBladeUV` attribute exists, is a vec2, has exactly 5 entries, and matches the fixed BL/BR/TR/TL/TC taper mapping used for atlas sampling. |
| `test-grass-textures.mjs` | `grass-textures.js` (`FIBER_STYLES`, `STYLE_KEYS`, `clamp01`) | Exactly 5 styles in the approved order; every style's `fiber()` stays finite and within `[0.35, 1.45]` across the UV domain; `dryTip.tint()` is exactly 0 at the blade base and nonzero near the tip (its one monotonic-in-v style); `highContrast.tint()` (speckle-based, not monotonic) stays within `[0,1]`; styles without a `tint()` omit it rather than defining a zero function. |
| `test-plants-defaults.mjs` | `plants.js` (`PLANT_DEFAULTS`, `PLANT_PRESETS`, `PLANT_BIOME_TAGS`, `createPlantPalette`) | Default schema values (simple/opposite/smooth/no-variegation); all 4 presets exist with their species-defining traits (cleavers compound+whorled, mint serrated, jewelweed alternate, chickweed/jewelweed flower shapes); `cleavers`' empty biome allowlist; `createPlantPalette` bakes `speciesCount * variantsPerSpecies` geometries, each species tagged, variants of the same species differing by seed. |
| `test-plants-geometry.mjs` | `plants.js` (`buildPlantGeometry`) | Non-empty, all-triangle, sequentially-indexed geometry (position/normal/color attributes) for all 4 presets with and without flowers, for 3 schema-only edge cases the presets don't exercise (even-pinnate compound leaf, variegated leaf, star-shaped leaf), and that the same seed reproduces identical geometry; enabling flowers strictly adds geometry. |
| `test-plants-placement.mjs` | `plants-placement.js` (`plantPlacementRecords`) | Places plants within chunk bounds with valid `speciesIdx`/`scale`/`yaw`; deterministic for a fixed seed; rejects submerged ground; in an all-desert biome only the biome-generalist species (empty allowlist) is ever picked; in an all-plains biome the swamp-only species never places while the plains-tagged one does; `clusterStrength: 0` matches the omitted-param baseline exactly (byte-identical output, no behavior change for existing callers); `clusterStrength: 1` rejects some baseline-kept candidates but still places plants, deterministically. |

## Standalone tooling

`tree-viewer.html` is a standalone single-file tuning tool for `trees.js`'s full procedural-tree
parameter surface (per-level branch structure, force, bark, leaves), with Solo/Grid view modes,
a procedural/authored texture toggle, a Lighting section driving `lights.js`'s rig live, and a
"copy tree JSON" export. It imports `trees.js` (`createTree`), `tree-textures.js`
(`createTextureSource`), and `lights.js` (`createLightingRig`) directly, with its own minimal
`WebGPURenderer`/`OrbitControls` scene shell — it is **not** wired into `environment-viewer.html`
in any way, and `environment-viewer.html`'s own Forest panel sliders are unaffected by it. Run via
`python serve.py` like the main viewer (see the directory's `CLAUDE.md`).

The controls panel has two tabs: **Tuning** and **Species**. Species is a **Family/Species**
authoring system persisted to `localStorage` (`tree-viewer:families`) — a Family is a named group
of Species (each a full tree `opts` + metadata: name, biome tags from the canonical 18-name list
in [biomes.md](biomes.md), a density weight, a size range, and an age range), grown by "Auto-add
mutations" (batch-mutates the currently-loaded tree N times from the same baseline, reusing the
existing `structureMutateList`/`forceMutateList`/`barkMutateList`/`leavesMutateList`, and saves
every result as a new species without rendering each intermediate mutation) or manually ("Keep
current tree as new species" after tuning/mutating normally — never hitting it is how a bad
result gets discarded). Clicking a species in the list both loads it and selects it for editing;
its metadata panel includes an **age-preview slider** that renders the live Solo tree through
`tree-age.js`'s `applyAge()` without altering the saved (mature) opts. A one-time migration folds
any pre-existing flat `tree-viewer:saved-trees` entries into a family named "Imported" so nothing
from before this feature existed is lost. Its "Family"/"Grow family"/"Species"/"Edit species"
sub-sections are still plain inline collapsibles (`header()`), unaffected by the floating-panel
redesign below (which applies to the Tuning tab only). While building this, a pre-existing bug
was found and fixed: `applyOptsAndRefresh()` (the shared hub Load/Undo/Redo/Restart all use after
replacing `opts`) never resynced the page-local `forceAz`/`forceEl` state the Force section's
sliders are bound to, so the Force sliders would silently show the previous tree's angle after
any of those actions — fixed via `resyncForceAngles()`.

Every Tuning-tab section (View, Texture, Lighting, Structure, Force, Bark, Leaves, Export) is a
row (label + optional "Mutate" button) that opens its own independent floating panel on click,
rather than expanding inline — inline accordion sections took up too much vertical space once
there were this many sliders. Structure is two levels deep: its own floating panel lists all 10
traits (Length, Radius, Taper, Children, Branch start, Angle, Gnarliness, Twist, Sections,
Segments) as rows, each of which opens a further-nested floating panel with just that trait's
per-level sliders. Multiple floating panels can be open at once; a panel with no remembered
position yet opens one panel-width to the left of whatever contained the row that opened it,
pushed down to avoid overlapping any already-open panel in roughly the same column, clamped to
stay fully on-screen. Once a panel has a position — auto-placed or user-dragged — reopening it
reuses that position. Closing a panel also closes any panel that was opened from inside it (e.g.
closing Structure also closes any open trait panels).

Mutation is **not** part of this floating-panel system — it's a second, separate, always-visible
panel docked directly below the main "Tree controls" panel (own drag handling, same visual style).
It holds the global "Mutation degree" slider, a "Mutate all" button, Undo/Redo, and Restart.
Structure/Force/Bark/Leaves's row-level "Mutate" buttons (and Structure's per-trait ones) randomly
perturb that section's/trait's numeric sliders (independently per slider, clamped to each
slider's own range) by up to the "Mutation degree" fraction of that slider's range — a targeted
reroll, not a full regenerate; it works whether or not the corresponding floating panel is open.
A 15-slot Undo/Redo history covers "big jump" actions only — any Mutate, Reroll seed, and loading
a saved tree — not individual slider drags; a new action after an undo clears the redo stack.
"Restart" resets to the tool's built-in default tree (captured once at startup), not a saved tree;
Lighting and texture mode are outside undo/restart's scope since Mutate never touches them.

### Game integration: authored families replace procedural species

The Species tab's "Export family JSON" button (next to "+ New family") sends the selected family
straight to `serve.py`'s `POST /api/save-family` — the handler slugifies `family.name` (lowercase,
non-alnum runs → `-`, trimmed) into a filename, writes `families/<slug>.json`, and appends that
filename to `families/manifest.json` (creating either if missing; re-exporting the same name
overwrites the file and is a no-op on the manifest, which never gets a duplicate entry). If the
POST fails — a different static server, or the page opened over `file://` — the button falls back
to a browser download of the same JSON and tells you to move it into `families/` and add it to
`manifest.json` by hand, which remains a plain hand-edited `string[]` (mirroring the explicit-path
convention `maps/<key>-data.json` already uses; there's no server-side directory listing).

At forest-module startup, `environment-viewer.html` fetches `families/manifest.json`, `fetch`es
every listed file, and passes them through `buildSpeciesFromFamilies()` to build `params.speciesTable`.
An empty/missing manifest, or any fetch failure, is swallowed (`try/catch`) and leaves
`speciesTable` unset, so the forest falls back to `buildSpecies()`'s procedural generator exactly
as before this feature existed — nothing here can regress the no-families case.

When `params.speciesTable` is set, `placementRecords()`'s per-tree species pick changes from
"uniform random index" to biome-filtered, density-weighted: for each tree it calls `biomeAt(x, z)`
(the authored map's biome lookup, see [biomes.md](biomes.md); `null` when no map is loaded, e.g. the
procedural infinite terrain, which has no biome concept), narrows the species table to entries whose
`biomes` list includes that biome (or has no biome tags at all, meaning "any biome"), falls back to
the full table if nothing matches, then draws one RNG value scaled to the candidates' summed
`density` to pick a winner — still exactly one RNG draw, preserving the species→seed→size→yaw draw
order the "Deterministic seeded placement" note above depends on. The winning species' `sizeRange`
is then passed into `sizeFor()` as its scale bounds instead of `[0, params.maxSize]`.
`forest-palette.js` mirrors the same `params.speciesTable || buildSpecies(...)` fallback so the baked
variant geometries match whichever species set placement actually used.

Scope: this only wires into the GPU forest path (`FOREST_MODE === 'gpu'`, the default) via
`forest-placement.js`/`forest-palette.js`; the retired inline "baked" path in
`environment-viewer.html` has its own duplicated `buildSpecies` and is untouched. Per-instance age
rolling (via `tree-age.js`'s `applyAge`) is not wired into game placement yet — only the tree-viewer
age-preview slider uses it today.

### plant-viewer.html

`plant-viewer.html` is `tree-viewer.html`'s direct counterpart for `plants.js`: a standalone
single-file tuning tool with its own minimal `WebGPURenderer`/`OrbitControls`/`lights.js` scene
shell (not wired into `environment-viewer.html`), Solo/Grid view modes, the same duplicated-inline
floating-panel controls kit, Mutate/Undo/Redo/Restart, and a Family/Species tab persisted to
`localStorage` under `plant-viewer:families`. Run via `python serve.py` like the main viewer.

Two things tree-viewer.html has that this tool deliberately omits: a texture-mode toggle (`plants.js`
geometry has no texture maps — colors are baked directly into vertex colors) and an age-preview
slider / per-species age range (`plants.js` has no growth model analogous to `tree-age.js`'s
`applyAge` yet).

Tuning-tab sections: View, Lighting (identical to tree-viewer.html), Stem (`stem.nodes`/
`nodeSpacing` min-max, `branchProb`, `sprawl`), Leaf (`shape`/`style`/`leafletCount`/
`leafletParity`/`arrangement`/`whorlCount`/serration/variegation/`size`/`color`, plus a toggle-gated
vein color since `leaf.veinColor` is nullable), Flower (`enabled`/`shape`/`petals`/`frequency`/
`color`, plus a toggle-gated throat color for the same nullable-field reason), and Export ("Copy
plant JSON", no texture replacer needed since plant opts never hold live `Texture` objects).

Species tab: unlike tree-viewer.html's one-time migration of a legacy flat saved-tree list,
plant-viewer.html has no prior save format — instead, on a genuinely fresh `localStorage` (the
`plant-viewer:families` key was never set, not merely emptied), it seeds one starter family,
**"Wildflowers"**, containing the 4 `PLANT_PRESETS` species (chickweed, cleavers, mint, jewelweed)
with their `PLANT_BIOME_TAGS` biome/density values pre-filled and a `sizeRange` of `[0.85, 1.15]`
(matching `plants-placement.js`'s existing hardcoded scale jitter — now editable per-species rather
than a single global constant). "Grow family" (Auto-add mutations / Keep current plant as new
species) and the Species list/edit panel work identically to tree-viewer.html, using
`stemMutateList`/`leafMutateList`/`flowerMutateList` in place of tree-viewer's structure/force/
bark/leaves lists. Species metadata is `name`/`biomes[]`/`density`/`sizeRange` — no `ageRange`
field (dropped; see above).

"Export family JSON" POSTs to a new `serve.py` route, `/api/save-plant-family`, which writes into
its own `plant-families/` directory + `plant-families/manifest.json` — kept fully separate from
tree-viewer.html's `families/` so the two tools' saved data can never collide on disk. `serve.py`
factors the shared slugify-filename/write-file/update-manifest logic both routes need into one
`save_family_to(payload, dir_path)` helper. Nothing in `environment-viewer.html`'s forest-placement
pipeline reads `plant-families/` yet — the "fetch manifest → buildSpeciesFromFamilies → wire into
placementRecords" game-integration step `families/` already has for trees has no plant equivalent
yet; that would be a separate follow-on, not part of this tool.
