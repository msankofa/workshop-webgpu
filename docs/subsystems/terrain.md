# Terrain Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#terrain)
> Authored-map ground texture and density queries are biome-driven — see [biomes.md](biomes.md).

## Purpose

Generates and renders the ground for the environment sandbox: a closed-form analytic
height field shared by every consumer (visible mesh/GPU surface, grass, trees, water,
collision), two interchangeable rendering paths (CPU-built chunk meshes streamed via a
Web Worker, or a GPU-driven CDLOD compute+indirect-draw system), texture splatting for
authored GLTF maps, and capsule collision against both the analytic field and authored
collision meshes (BVH-accelerated).

## Files

| File | Responsibility |
|---|---|
| `terrain-field.js` (150 lines) | Pure math, no Three.js: `terrainHeightAt`, `terrainNormalAt`, chunk geometry array builder, height-tile builder for the heightmap path. Shared by main thread and worker. |
| `terrain-system.js` (~690 lines) | `TerrainSystem` class: chunk streaming/windowing around a moving center, worker dispatch + sync fallback, `chunks`/`instanced` render modes, height-atlas management for the experimental instanced path. Optionally streams from an injected terrain source (Base Game terrain Phase 2). |
| `terrain-worker.js` (~60 lines) | Module Web Worker. Runs `buildChunkArrays`/`buildHeightTile` off the render thread, replies with transferable typed arrays. Also accepts `sourceTile` jobs that build a pure terrain source from a descriptor. |
| `terrain-source.js` | Pure terrain-source contract (Base Game terrain Phase 1): descriptor/tile-request/tile-result validation, `tileKey`/`parseTileKey`, `tileTransferables`, and a `registerSourceKind`/`createSource` registry so a worker or server can build a source from a descriptor alone. No three.js. |
| `terrain-source-analytic.js` | Adapter over `terrain-field.js` implementing the source contract; point heights/normals and LOD-0 tiles are bit-identical to `terrainHeightAt`/`terrainNormalAt`/`buildHeightTile`. Registers the `analytic` kind on import. `contains()` honours descriptor bounds. |
| `terrain-source-v5.js` | Terrain Generator v5 project as a streamable source (kind `v5-recipe`, algorithm `v5-unbounded-1/stack-height`). `v5Descriptor(project)` → descriptor whose `sourceVersion` is the project hash prefix and whose `config` holds the normalized project + hash; `createV5Source(descriptor)` refuses anything `classifyProject` does not mark `runtimeSupported`. Height = `evaluateStackPoint` over `prepareStack(project.stack)` with `classic` layers fed by `createClassicHeightPoint(cfg, createUnboundedFieldSampler(seed))`; normals by the same 0.5 m central difference as the analytic source; tiles sample that point function (optionally with normals). Erosion, hydrology and biome/material masks are preview-only and **not** applied (named in `classification.omitted`). **Volume (Phase 8):** `densityAt(x, y, z, h?)` (positive = solid) from `createDensityPoint(project.density, seed, createUnboundedDensityNoiseSampler())`, `surfaceYAt(x, z)` (the density's real surface: 1 m scan down from `heightAt + VOLUME_TOP_MARGIN` then bisection; never null thanks to the floor seal), `holeAt(x, z)` (true only where `surfaceYAt` is deeper below the heightfield than `warp_strength_surface + warp_strength_global + 2` — a carved cave mouth, never plain warp; the scan stops at that depth and the answer is cached per 0.5 m cell, 65k entries, because the player controller asks it ~5 times per step and uncached it cost ~60 density samples), and the `volume` tile field: marching cubes (`marchingCubesGrid`) over the tile's interior XZ samples × rows from `density.y_min` to the column's highest surface + `VOLUME_TOP_MARGIN` (12 m) at `VOLUME_Y_SPACING_MULT` (2×) the XZ step, with density-gradient normals (`VOLUME_GRADIENT_EPS`) so seams need no neighbour; ~75 ms per 30 m tile at 24 intervals. The volume honours the editor's semantics exactly (surface warp ±`warp_strength_surface`, cave carve `clamp01(ridged − threshold) × cave_strength` within the depth mask), so the mesh top is the density surface, not the bare heightfield. `heightAtSpacing(x, z, spacing)` is the band-limited field (see below) and `buildTile` accepts any lod: lod 0 is exact, lod > 0 samples `heightAtSpacing` at the request's own spacing (`size / intervals`); normals and volume are lod 0 only. Registered by `terrain-worker.js` and `terrain-system.js` on import. |
| `world-query-heightfield-provider.js` | Terrain-source → world-query adapter (`groundProbe` + `resolveCapsule` only; bounds/holes yield no terrain). See `base-game.md`. |
| `world-query-chunk-mesh-provider.js` | One world-query provider (`id: 'terrain-volume'`, `raycast`/`raycastAll`/`resolveCapsule`) over many streamed chunk meshes: `setChunk(key, geometry)` builds a `map-collision.js` BVH per chunk, `removeChunk(key)`, `clear()`; queries only touch chunks whose bounding box the ray/capsule intersects (rays starting inside a box count). Hits carry `colliderId: <chunk key>`, `surfaceType: 'terrain'`. |
| `terrain-clipmap-window.js` | One clipmap level's height window, pure: `createClipmapWindow({ level, post, tileIntervals 32, tilesPerSide 8 })` → a 256-post toroidal window (global post (gx, gz) at texel (gx mod res, gz mod res), so re-centring moves no data). `recentre(x, z)` snaps the origin to whole tiles and evicts tiles that fell out; `missingTiles(x, z)` nearest-first; `tileRequest(ix, iz)` is a lod-(level+1) `heights` request (spacing = post); `commitTile(tile)` writes it; `sample(x, z)` bilinear or null; `createClipmapLevels({ levels, post0, ringCells })` doubles `post` per level. |
| `terrain-clipmap.js` | Far-distance rings (Phase 9). `createTerrainClipmap({ source, descriptor, useWorker, levels 6, post0 2, ringCells 192, overlapCells 2, morphStart 0.7, morphEnd 0.95, yBias −0.25 })`: one ring mesh per level (full square at level 0, annulus with an N/4−overlap hole above), vertex heights from that level's window texture (four wrapped `textureLoad`s + lerps in global post coordinates), morphing toward the next coarser level across the outer band so seams never crack; normals by central difference at one post; the Base Game tint. Ring 0 discards fragments inside `setHoleRect([minX, minZ, maxX, maxZ])` (the exact chunk square, inset by the overlap). Own `terrain-worker.js` instance (`sourceTile` jobs, `maxInFlight` 12, `maxDispatchPerUpdate` 6) or synchronous `buildTile` in Node. `update(globalPosition)` re-centres, dispatches, uploads dirty windows, snaps centres to two cells; `setSource()` bumps the epoch and refills; `stats` (coverage per level, triangles, tiles in flight, last build ms). Outer half-extent = 96 · post0 · 2^(levels−1) = 6.1 km at the defaults. Visual only: collision never reads it. |
| (volume LOD cascade) | Not a module: `base-game-terrain.js` runs extra `terrain-system.js` instances with `params.lod > 0`, `segmentsPerChunk` fixed and `volumetric: true`; `params.workerCount` (0 = min(4, cores−2)) sizes the worker pool every terrain system uses (one `worker` facade, round-robin `postMessage`); the v5 source builds `volume` (and `normals`) at any lod with `createDensityPoint(..., spacing)` band-limiting warp/cave noise (`createUnboundedDensityNoiseSampler().fbm3(..., octaves, bandSpacing)`). See `base-game.md`. |
| `terrain-splat-streamed.js` | Ground textures for the STREAMED terrain (Base Game chunks + volume cascade). Per-fragment layer weights from world height and slope — sand/grass/dirt/rock/snow (`splatWeights(h, ny)` CPU twin; rock triplanar, the rest planar xz) — over ordinary mipmapped textures from `textures/ground/<layer>/{color,normal}.jpg` (`loadStreamedSplatTextures`; `placeholderStreamedSplatTextures` for Node). Built so it cannot turn to static at range: a 7× far tiling takes over from 40–220 m, and from `fadeNear`–`fadeFar` (250–1400 m) the albedo settles on each layer's average colour (its 1×1 mip, measured from the image) while normal strength and the sampler-free macro hash fade to zero (`detailFade(d)` twin). `createStreamedSplatMaterial(textures, overrides)` → `MeshStandardNodeMaterial`. Reads are the cost, so each layer is sampled only where its weight > 0.004 (`If` per layer): the uv derivatives are hoisted to vars in uniform flow (an anchor pins their declaration before the branches) and every sample uses `.grad()`, which is what WGSL requires inside non-uniform control flow — flat grass costs one layer. One `Fn` on `colorNode` does all sampling (three evaluates colour → roughness → normal) and passes roughness and the object-space tilted normal to the other two nodes through `property()`s; the normal goes through `transformNormalToView`; `updateStreamedSplat(mat, { tileMeters, fadeFar, … })` live; `{ lod: { self, finer } }` binds two `terrain-lod-coverage.js` maps for the LOD dissolve (`syncStreamedSplatCoverage(mat)` after a recentre); `{ water }` binds the Base Game water's `groundShade` uniforms for the wet tide band and the Snell caustic emissive. Tests: `test-terrain-splat-streamed.mjs` (headless build via `tsl-build-check.mjs`). An optional `rain` bundle `{ uniforms, offset, puddleScale, rippleScale }` beside `water`, behind `If(uWetness > 0)` so a dry world skips its 315 lines of noise, wets the whole ground (albedo down, roughness down, puddles on the flats, ripple normals) using the fields imported from `rain.js` — one copy of that maths, not a twin — gated to what is out of the water by the same `submerged` term the tide band uses. |
| `terrain-sea-depth.js` | Ground height around the player for water: `createSeaDepthMap({ source, useWorker, spacing 16, tileIntervals 16, tilesPerSide 20 })` wraps one `terrain-clipmap-window.js` window (320 posts = 5120 m, past the far cascade) filled by `sourceTile` jobs at lod 1 on its own worker (band-limited `heightAtSpacing`, so shorelines match the far ground), uploaded as a float `DataTexture`. `recentre(x,z)`, `update()` (requests missing tiles nearest-first within `maxInFlight`, uploads on change, returns true when full), `heightAt(x,z)` CPU bilinear or null, `minHeight()` (interior posts, for the "any water in view" gate), `gpuHeightAt(xz, fallback, mode)` TSL sampler — `'bilinear'` (the default) or `'min'`, which returns the lowest of the four surrounding posts so a caller that must never over-estimate the ground (Base Game's rain, see `base-game.md` §Weather R1) can ask for a conservative height; same idea as `terrain-lod-coverage.js`'s `erode()`, `setSource`, `clear`, `dispose`. Tests: `test-terrain-sea-depth.mjs`. |
| `terrain-lod-coverage.js` | Per-chunk presence for LOD dissolves: `createLodCoverage({ chunkSize, texels 96, fadeSeconds 0.6 })` owns a `texels²` R8 `DataTexture` centred on the player's chunk (`recentre(x, z)`), `update(presentKeys, dt)` ramps each tracked chunk up when present (snaps to 0 when absent), re-uploads, and maintains `erodedTexture` (3×3 min) — what a coarser level dissolves against, keeping one chunk of overlap, `coverageAt(x, z)`, `clear()`. Pure apart from the texture. |
| `terrain-chunk-batches.js` | Resident chunks pooled into `BatchedMesh` — one scene object, one pipeline + bind-group set per ~256 chunks, but on the WebGPU backend still **one `drawIndexed` per visible chunk** (`WebGPUBackend._draw` loops the multi-draw ranges in JS; WebGPU has no multi-draw). `createChunkBatcher({ material, slots 256, vertices 600k, indices 3.6M, maxBatches 64, compactWhenUnusedFraction 0.35, perObjectFrustumCulled false })` → `add(key, geometry)` (copies into the first batch with room, opening batches on demand; `false` = caller keeps its own mesh), `remove(key)` (frees on `optimize()` — run when dead space exceeds the fraction or would satisfy a pending add), `setVisible`, `setMaterial`, `drawCount` (GPU draws submitted; pre-cull upper bound if culling is on), `stats` (includes `draws`). Per-chunk frustum culling is off by default so `BatchedMesh.onBeforeRender` early-outs (see "Per-chunk frustum culling" below); batch meshes are `frustumCulled = false`. Volume chunks get planar world-xz uvs in `terrain-system.js` so both chunk kinds share one attribute set. `test-terrain-chunk-batches.mjs`. |
| `terrain-volume-collision.js` | Headless volumetric collision for a source with `densityAt`/`buildTile` (the server side of volumetric rooms): `createVolumeCollision(source, { worldQuery, chunkSize 30, coverRadius 1, keepRadius 3, maxBuildsPerCall 4 })` builds lod-0 `volume` tiles with the same chunk size / `volumeChunkIntervals` / apron as `terrain-system.js` (so the meshes match the clients' bit for bit) into a chunk-mesh provider; `ensure(positions)` builds nearest-first within the budget and prunes far chunks, `covers(x, z)` says whether the chunk under a point is collidable. Synchronous, ~40 ms per tile. |
| `terrain-loader.js` | Loads an authored GLTF map + its `-data.json` sidecar, derives/queries height, biome, grass/tree density via bilinear sampling, exposes the read-only `surfaceField(x,z)` unified sampler (merged plan §1 F1), builds chunk-window helpers for decorations. |
| `terrain-textures.js` | Loads ground PBR texture layers (grass/dirt/sand/gravel), classifies authored map mesh vertices into a dominant layer per triangle (mask-driven or biome/slope/sea-level fallback), splits geometry into material groups. Now also exports `FALLBACK_COLORS`/`MASK_ALIASES`/`BIOME_MATERIAL` for `surfaceField` to reuse. |
| `soil-shade.js` (~160 lines) | `createSoilShade(overrides)`: optional ground dressing behind live 0/1 toggle uniforms (default-off): `moisture` = 3-octave FBM damp patches that darken (`moistureAmount`) and gloss (`moistureGloss`, roughness toward 0.22) the ground, `cracks` = two-scale warped Worley (F2-F1) dry-crack channels that darken/roughen and, via a 3-tap finite-difference gradient (`crackDepth`), groove the lit normal. Both fields live inside `If (uniform > 0.5)` blocks, so a ground with both toggles off pays two compares rather than ~140 hash evaluations per fragment; the crack domain warp is computed once and the three gradient taps step in warped space. `nodes.apply({col, rough, worldXZ, normalWorld})` returns the dressed trio; `set/get`; `soilFor(block)` merges over `SOIL_SHADE_DEFAULTS`. Composed into `terrain-textures.js`'s splat material (one instance shared by the reduced/full variants, exposed as `splatUniforms.soil`; `updateTerrainSplatGlobals(root, { soil: partial })` drives it and `terrainTextureGlobals.soil` mirrors it) and into `bot-viewer-visuals.js`'s floor/terrain materials (`visuals.soil`, values in `theme.mats.floor.soil`). UI: env-viewer terrain-textures section (`params.terrainSoil*`), bot-viewer-v3 Flora > "Soil surface". JS twins `worleyF1F2Ref`/`soilHash2` for tests (`test-grass-look.mjs`). |
| `moisture-proxy.js` | Pure CPU moisture PROXY (no three): biome→moisture table × elevation-dryness floored by a shore/water-proximity band, plus `upnessFromNormalY`. Backs `surfaceField.moisture`/`upness`; Node-tested by `test-surface-field.mjs`. |
| `moss-tint.js` / `moss-tint-ref.js` | Shared moss/lichen dressing law `mossWeight(moisture, upness, cavity, brushNoise)` → 0..1, as a TSL `Fn` + its CPU math-twin. One law reused by the future terrain (#3), rock (#7), deadwood (#8) materials. Node-tested by `test-moss-tint.mjs`. |
| `cdlod-terrain.js` (262 lines) | GPU-driven CDLOD terrain (SP3): TSL compute pipeline that selects quadtree nodes per frame and indirect-draws a reusable patch grid, displaced/shaded by an analytic TSL height field transcribed from `terrain-field.js`. |
| `cdlod-select.js` (116 lines) | Pure-JS CDLOD node-selection math: Morton encoding, distance-band level selection, morph factor — the CPU source of truth the TSL compute mirrors, and what `cdlod-terrain.js` calls for its CPU-side survivor-count HUD stat. |
| `collision.js` (101 lines) | Pure capsule-vs-analytic-field collision math (no Three.js): ground contact, velocity sliding, tree-trunk circle push-out, chunk-bucketed trunk index. |
| `map-collision.js` (~180 lines) | `createMapCollider`: builds a `MeshBVH` (three-mesh-bvh) over an authored map's world-space triangles for capsule resolution, downward raycasts, and arbitrary-direction shot raycasts. `InstancedMesh` children are expanded per instance (`matrixWorld × instanceMatrix`) — bot-viewer-v2's instanced walls depend on this. |
| `map-surfaces.js` (150 lines) | `createSurfaceQuery`: every standable surface in a column, not just the topmost — the multi-level answer `heightAt` cannot give on a volumetric map. Pure (one `raycastAll` callback), Node-tested in `test-map-surfaces.mjs`. |

## Public API

`terrain-field.js`
- `export function terrainHeightAt(params, x, z)` — closed-form height at world (x,z); `params` = `{ baseAmp, lake, lakeDepth }`.
- `export function terrainNormalAt(params, x, z, out)` — central-difference unit normal into `out` (3-array), returns `out`.
- `export function buildHeightTile(xMin, zMin, size, texelWorld, params, apron = 1)` — returns `{ heights, texels, intervals, step, apron, xMin, zMin, size, originX, originZ }`.
- `export function sampleHeightTileBilinear(tile, x, z)` — CPU mirror of the GPU's LINEAR+CLAMP texture fetch over a tile.
- `export function buildChunkArrays(xMin, zMin, size, segments, params, computeNormals)` — returns `{ positions, normals, uvs, index }` matching `THREE.PlaneGeometry` vertex/index ordering.

`terrain-system.js`
- `export function createTerrainSystem(options)` / `export default createTerrainSystem` — factory for the `TerrainSystem` class (not itself exported). `options.source` (optional) is a source object or a descriptor (see `terrain-source.js`); when absent the system uses the hard-coded `terrain-field.js` path exactly as before (Environment Viewer compatibility).
- With a source: `getHeight` reads `source.heightAt`; chunks are dispatched as worker `sourceTile` jobs (`fields: ['heights','normals']`, apron 0, `intervals = segments`) and built through `buildChunkArraysFromTile`; the sync fallback calls `source.buildTile` directly; the instanced height atlas requests its tiles through the source too (worker keys prefixed `atlas:`). Target keys are clipped to `descriptor.bounds` for finite sources.
- `params.volumetric` (source path only) requests `['heights','normals','volume']` with an apron of 1 and builds chunk geometry from `tile.volume` (positions/normals/indices, no uvs); `sys.setVolumetric(v)` flips it with a restream (`restream()` = epoch bump + stale retention, shared with `setSource`). Chunk `meta.volumetric` and `meta.volume { yMin, yMax, triangles }` record it.
- `sys.setSource(source)` swaps sources through `restream()`: bumps the epoch (old in-flight results dropped) and **discards every resident chunk at once**, on the reasoning that the far LOD already draws the new world; replacements stream back under the normal `maxChunksPerUpdate` budget. `restream({ drop: false })` is the older keep-until-replaced behaviour and **nothing calls it**, so `chunk.stale` is never set and everything downstream of it (`hasFreshChunk`'s freshness test, Base Game's stale hide-rules, `stats.staleTiles`) is currently inert — see the terrain audit's `F-10`/`F-11`. Refill measured 2026-08-29 at radius 6 on the synchronous path: 59 frames / 89 ms analytic, 59 frames / 865 ms v5. `sys.sourceInfo` → `{ kind, key, version, algorithmVersion, lod, bounds }` for perf records. Chunk `meta` and `activeChunks` entries carry `lod`, `sourceKey`, `sourceVersion`, `stale`; `meta.tileKey` is the full `terrain-source` tile key. A worker error reply is kept in `sys.lastSourceError`.
- `buildChunkArraysFromTile(tile)` (`terrain-field.js`) — same vertex/uv/index layout as `buildChunkArrays`, read from a source tile's interior (apron skipped), using `tile.normals` when present.
- `export { terrainHeightAt, terrainNormalAt } from './terrain-field.js'` — re-exported so existing importers don't need to know about `terrain-field.js`.
- Instance surface (no separate class export): `.group`, `.params`, `.rebuild(options)`, `.update(centerX, centerZ)` → bool changed, `.getHeight(x, z)`, `.materialPatchTarget`, `.pendingBuildCount`, `.activeChunks`, `.targetChunkCount`, `.renderMode`, `.dispose()`.
- **`.activeChunks` is lazy** (2026-08-29): it is an array of one freshly built record per resident chunk, and it used to be rebuilt eagerly on every residency change *and* once per worker arrival — 28 rebuilds of 49 objects across 40 walking frames, for a getter Base Game reads only behind the tile-bounds debug toggle. The write paths now set a dirty flag and the getter builds it. `.activeChunkRefreshes` counts the builds so "the frame loop does not rebuild this" is testable rather than inferred (`test-base-game-terrain.mjs`).
- **The quiet frame path allocates nothing it can avoid** (2026-08-29). `update()`'s unload sweep iterates `chunks.keys()` rather than entries (destructuring a Map's entries allocated one pair per resident chunk per frame); the chunking signature is two stored numbers rather than a joined string; `primaryMesh` is re-picked only when residency changed or it was dropped; and `takeInstallCost()` reuses one result object per system — read it, do not hold it. Measured with `bench-base-game-terrain.mjs`: `system.update` fell from 747 to 32 bytes/call at 49 resident chunks.

`terrain-worker.js` — no exports; a `self.onmessage` module Worker entry point. Accepts `{ jobType: 'heightTile', ... }`, default chunk-array jobs, or `{ jobType: 'sourceTile', epoch, key?, descriptor, request }`. A `sourceTile` reply is the validated tile result plus `key` (defaults to `tileKey(descriptor, epoch, lod, ix, iz)`), `epoch`, `sourceKey`, `sourceVersion`; failures reply `{ key, epoch, jobType, error, contractError }` instead of throwing. Sources are cached per normalized descriptor JSON, so a changed descriptor never reuses a stale source.

`terrain-source.js`:
- `normalizeDescriptor(d)` → frozen `{ contractVersion: 1, kind: 'analytic'|'finite-map'|'v5-recipe', key, sourceVersion, algorithmVersion, bounds: null|{minX,maxX,minZ,maxZ}, capabilities: string[], config, seaLevel }`. `seaLevel` (finite number, default 0) is the water plane's y: part of the world identity, not of the tile key (heights ignore it). `analyticDescriptor({ …, seaLevel })` carries it explicitly; `v5Descriptor` fills it from the project's authored `cfg.sea_level`. Rejects unknown kinds, non-finite bounds, `|`/`@` in key/version, and `infinite` capability on a bounded source. `config` is the reproducible source configuration, never render settings.
- `normalizeTileRequest(r)` → frozen `{ ix, iz, lod=0, xMin, zMin, size, intervals, apron=1, fields=['heights'] }` with integer/finite checks.
- `validateTileResult(tile, req)` — checks `texels = intervals + 1 + 2*apron`, typed-array lengths for `heights`/`surfaceHeights`/`normals`/`biomeIds`/`moisture`/`holeMask`/`materialFields`, coords/bounds agreement and presence of every requested field. Optional fields are absent, never zero-filled.
- `tileKey(descriptor, epoch, lod, ix, iz)` → `key@version|e<epoch>|l<lod>|<ix>,<iz>`; `parseTileKey` inverts it. Render origin is never part of the key.
- `registerSourceKind(kind, factory)`, `hasSourceKind`, `createSource(descriptor)`, `validateSource(src)`; throws `TerrainSourceError`.
- A source object is `{ descriptor, contains(x,z), heightAt(x,z), heightAtSpacing?(x,z,spacing), normalAt(x,z,out), surfaceYAt?, holeAt?, buildTile(request) }`. `buildTile` is synchronous and pure.
- **Band limit (Phase 9).** A tile at lod > 0 is the field sampled every `size / intervals` metres with everything finer than that spacing removed, so coarse rings never alias into false landforms: `terrain-noise.js` `octaveBandWeight(wavelength, bandSpacing)` fades each fbm/ridged/billow octave (and voronoi as one octave) to its mean between 8 and 4 samples per wavelength, `evaluateStackPoint(prepared, x, z, { spacing })` threads it through every layer (domain warp included; the classic v4 climate layer is not band-limited yet), and `terrain-field.js` `terrainHeightAtSpacing` does the same per wave for the analytic field. lod 0 and every collision query are exact. Two refinements (2026-08-23, after the far cascade sat tens of metres above the near ground): (1) `VOLUME_Y_SPACING_MAX` caps marching-cubes rows at 8 m whatever the XZ step — the density is not linear in y across the floor seal and cave mask, so 160 m rows put the iso-crossing far above the real surface; (2) above 6 m spacing `heightAtSpacing` is a Gaussian-weighted 6×6 supersample over a two-cell footprint (σ = half the spacing, the usual antialiasing kernel; the four-cell/σ = 1 version first shipped rounded summits off by 10 m mean / 52 m worst at 80 m, measured 2026-08-23, now 5.8 / 35.5 — the rest is inherent to sampling a narrow peak at 80 m) of sub-samples band-limited at half the spacing — the octave fade alone drifted under masked/ridged layers because dropped octaves were replaced by a global mean. Volume tiles get chunked-LOD border skirts from the open-sky contour only (lod 0: 6 m, sliced out of collision via `volume.skirtIndexStart`, and `volume.skirtVertexStart` marks where the skirt's own vertices and normals begin so surface-only checks can stop there; the tile request's optional `skirtDepth` overrides, 0 = none (`addBorderSkirts`; cave contours are left open, told apart by each border column's topmost air→rock crossing in the density field). Measured gain 0.33 at 4 samples per wavelength, 0.78 at 8; mean drift vs exact ±0.3 m at 80 m spacing; lod-3 tile ≈ 90 ms.

**Visible surface, biome and moisture fields (plants plan F1, 2026-08-24).** `TILE_FIELDS` gains
`surfaceHeights`, and `biomeIds`/`moisture` are filled for the first time — until now the contract
reserved them and no source wrote one.

- `surfaceHeights` is the VISIBLE open-sky surface. On a heightfield source it is `heights`; on a
  volumetric one the density warps and carves the ground away from `heights`, so anything standing
  on the drawn world (flora, rain, feet) must read this instead. v5 fills it from `surfaceYAt`,
  analytic aliases it to `heights` (same array, no copy).
- `terrain-biome-point.js` — `createBiomePoint(cfg, sampler, { seaLevel })` → `classifyPoint(x, z,
  height, slope, spacing)`, `moistureAt(biome, height)`, `classifyTile(surfaceHeights, texels, step,
  originX, originZ, spacing, want)` → `{ biomeIds: Uint8Array, moisture: Float32Array }`. Pure, no
  three.js. Slope comes from the tile's own surface grid (the apron supplies the borders), climate
  from `biome-classifier-js.js`'s unbounded sampler, and the decision itself from `classifyBiomeCell`
  — this module does not re-decide what a biome is. Every input is continuous in position, so a cell
  classifies the same whichever tile it lands in; `test-terrain-biome-point.mjs` proves it by
  comparing one tile against four quarter-tiles.
- `createUnboundedFieldSampler(seed).sample(channel, x, z, period, octaves, bandSpacing = 0)` gained
  the optional band limit, using the same `octaveBandWeight` rule as the height stack. 0 is the
  previous behaviour exactly. Climate periods are 1.3–1.55 km, so the fade only bites past ~195 m
  spacing, where it collapses a tile to one biome rather than letting it speckle.
- **Two things are deliberately missing.** Erosion, lakes and flow are global, so the streamed
  `beachMask` keeps `buildDerivedMaps`' local height and slope terms and drops its `lakeMask` factor
  (regional hydrology, roadmap step 9). And it adds one term the grid path has no equivalent for: a
  waterline gate. `classifyBiomeCell` applies beach *after* ocean in its priority stack while
  `detectLakeMask` excludes sea cells, so without the gate a flat seabed scores `beachMask` ~1 and
  the entire ocean floor classifies as `beach`.
- **Authored biome paint is not available here.** `classifyProject` rejects a painted project for the
  infinite runtime ("paint rasters are bounded"), so a streamed v5 source never has one.
- **Cost, measured 2026-08-24** (30 m tile, 23 intervals, apron 1 = 625 posts, mean of 20 builds,
  Node): analytic 0.098 ms for heights and 0.168 ms with biome + moisture; v5 1.30 ms for heights,
  2.51 ms with biome + moisture (×1.9), and **18.56 ms with `surfaceHeights` as well** — `surfaceYAt`
  alone is 16.1 ms per tile, 25.7 µs per post, because it scans down in 1 m steps from
  `heightAt + 12` and then bisects eight times. Biome and moisture are affordable per tile;
  `surfaceHeights` is roughly twelve normal tiles and belongs only on coarse placement windows in
  volumetric mode, never on the near visible chunks.

**Streamed field windows (plants plan F2, 2026-08-24).** The biome/moisture data F1 produces has to
reach a placement loop around the player. Three modules do that, and they replace the
one-worker-per-feature arrangement water and rain were heading toward.

- `terrain-clipmap-window.js` now carries a PAYLOAD. `createClipmapWindow({ …, fields, lod })` holds
  one typed array per field (`heights` always, plus `surfaceHeights` / `biomeIds` / `moisture`),
  `tileRequest` asks the source for all of them, `commitTile` refuses a tile missing any (a partial
  commit would leave holes), and `sampleField(name, x, z)` reads them — **bilinear for values,
  nearest for ids**, because the average of two biome numbers is a third, unrelated biome. `lod`
  now defaults to `level + 1` but can be set: a consumer planting things on the drawn ground passes
  `0`, since the visible chunks are built exact. Every existing caller is unchanged.
- `terrain-field-scheduler.js` — `createFieldScheduler({ workerCount = 1, maxInFlight = 4 })` →
  `request({ key, priority, descriptor, request, owner, onTile, onError })`, `cancelOwner(owner)`,
  `pump()`, `stats`, `dispose()`. One job per tile key however many windows asked for it: the first
  asker gets the built arrays and the rest get copies, because a transferred buffer has exactly one
  owner. `FIELD_PRIORITY` orders field work against field work (`contact` 10, `water` 20,
  `placement` 30, `prefetch` 40). Field work stays behind visible and collision terrain by
  construction — `terrain-system.js` keeps its own pool of up to four workers, this pool is one, and
  `maxInFlight` caps what is outstanding. With no `Worker` (Node) it builds synchronously inside
  `pump()` under a millisecond budget, so a test drives the same scheduling path the page uses.
- `terrain-field-window.js` — `createFieldWindow({ source, scheduler, fields, post, lod, … })` wraps
  a payload window with one `THREE.DataTexture` per field and wrap-aware readers on both sides.
  `sampleAt(name, x, z)` and `ready(x, z)` on the CPU; `gpuSampler(name)` returns a TSL `Fn(xz,
  fallback)` doing the toroidal `textureLoad` (never normalized uv — the texel under a uv moves as
  the window recentres, so the seam smears), and `gpuSamplerRenderLocal(name, renderOriginXZ)` is
  the adapter for render-local callers like grass. Id fields ride an **`r8unorm`** texture decoded
  by ×255: r184 maps `RedIntegerFormat` for `IntType`/`UnsignedIntType` only, so a `Uint8Array`
  integer texture is rejected outright. `acquire()` reference-counts; `createFieldWindowRegistry`
  keys windows so water, weather and flora asking for the same resolution share one.

`base-game-terrain.js` owns one scheduler and one registry, and exposes the seam:
`acquireFields()` (hold a reference to make it stream), `fields`, `fieldsReady(x, z)`,
`biomeAt`/`biomeIdAt`/`moistureAt`/`treeDensityAt`/`fieldSurfaceAt`, and `surfaceFieldAt(x, z)` →
`{ biome, height, normalY, moisture, weights, treeDensity }`, where `weights` is
`terrain-splat-streamed.js`'s `splatWeights` so flora and the ground texture cannot disagree. The
placement window is 8 m posts over 2 km — **the canonical placement resolution, fixed so candidate
identity never changes with visual LOD** — and it requests `surfaceHeights` only in volumetric mode,
where the drawn ground can actually differ from the heightfield.

**Every read returns `null` when the field has not streamed there yet.** That is the contract, not
an oversight: a placement loop must defer and requeue, because a default substituted for missing
data records a candidate that nothing in the world justifies.

**Steady-state scan gating (2026-08-24, /improve-webgpu pass).** `missingTiles()` walks
tilesPerSide^2 keys and builds a string per tile, and `requestTiles()` was calling it every frame
per window — 9.3 us of a 15.1 us `terrain.update()` was one full-window scan returning an empty
array. It is now skipped when `coverage >= 1`, and when neither the window version nor its origin
has changed since a scan that found nothing. Standing still with both windows full went **15.1 ->
3.0 us/frame**. `test-terrain-field-window.mjs` asserts a full window issues no further requests
and that moving resumes them. Two smaller fixes in the same pass: the scheduler sorts its queue once
per `pump()` instead of once per dispatch and indexes queued jobs by key (correct, but no measurable
effect at this queue size), and `base-game-flora.js` passes a scratch array to `getOrigin()`, which
allocates without one and ran three times a frame.

**Measured 2026-08-24** (Node, no worker, so tiles build on the calling thread — the browser's
worker path is cheaper): `terrain.update()` costs 0.022 ms/frame standing with the field off and
0.036 ms with it on; walking at 6 m/s, 0.040 → 0.064 ms; flying at 120 m/s, 0.518 ms mean and
3.66 ms worst. The queue peaks at 0 outstanding after the first fill in every case, and the window
is 576 KB for 256² posts of heights + biomeIds + moisture. Two consumers share one window, so the
second one issues no requests at all rather than relying on the scheduler's dedupe.

`terrain-source-analytic.js`:
- `analyticDescriptor({ key='analytic', sourceVersion='1', params })` → descriptor with `algorithmVersion: 'terrain-field-1'`, `capabilities: ['infinite','heights','normals']`, `config.params` (defaults `baseAmp 1, lake 0.45, lakeDepth 3.2`).
- `createAnalyticSource(descriptorOrOptions)` → source. `buildTile` supports `lod: 0` only and optionally fills `normals`.

`terrain-loader.js`
- `export async function loadTerrainMap(mapKey, { scene, textureMode, maxShaderLayers, slopeCutoff, shaderQuality, prebuildVariants } = {})` — returns `{ key, root, mesh, terrainKind, worldX, worldZ, worldYMin, worldYMax, seaLevel, resolution, biomeNames, terrainTextureMeshes, terrainTextureMode, terrainActiveSplatLayers, grassDensityGrid, heightAt(x,z), biomeAt(x,z), grassDensityAt(x,z), treeDensityAt(x,z), surfaceField(x,z), makeChunks(center, renderRadius, chunkSize), makeAllChunks(chunkSize) }`.
  - `textureMode` (2026-07-08, perf-recovery Wave 0): `'splat'` (default/omit) uses `applyTerrainTextures`'s normal blended-material path; `'legacy'` passes `{ legacySplit: true }`; `'flat'` passes `{ flatMaterial: true }` (diagnostic-only single cheap material, see `terrain-textures.js`'s `applyFlatTerrain`). `environment-viewer.html` wires this straight from the `?terrainTexture=splat|legacy|flat` URL flag (default `splat`, defined near the other top-level URL flags ~line 94) into its one `loadTerrainMap(mapKey, { scene, textureMode: TERRAIN_TEXTURE_MODE })` call. Omitting the flag is behavior-identical to before this option existed.
  - `maxShaderLayers` / `slopeCutoff` / `shaderQuality` / `prebuildVariants` (2026-07-08/09, perf-recovery Milestones 3B/3C) pass straight through to `applyTerrainTextures`'s `options` of the same names (see below) — `loadTerrainMap` does not default or clamp them itself, `applyTerrainTextures`/`applySplatTerrain` do. Not yet wired to a URL flag (task scope was the loader/material option surface only; flag wiring is a later wave).
  - `terrainTextureMode` / `terrainActiveSplatLayers` on the returned object mirror `applyTerrainTextures`'s result (`mode` / `activeLayers.length`, or `'none'` / `0` when no authored map textured successfully) — consumed by the perf CSV's `terrainTextureMode` / `terrainActiveSplatLayers` columns (see `infra.md`). **Bug fix (2026-07-09):** the legacy path (`applyLegacyTerrain`) previously returned `{ materials, texturedMeshes, report }` with no `mode`/`activeLayers` keys, so `?terrainTexture=legacy` always reported `terrainTextureMode: 'none'` in the perf CSV (the loader's "nothing textured" fallback) instead of `'legacy'`. It now returns `mode: 'legacy'`, `activeLayers: []` (the per-triangle multi-material path has no single active-layer set to report). The `'flat'` path (`applyFlatTerrain`) already stamped `mode: 'flat'` correctly and was not affected.
- `surfaceField(x, z)` — **read-only** unified surface sampler (merged plan §1 F1), the shared source of truth for ground albedo / grass+canopy tint / plant density / moss dressing. O(1) per query (bilinear grid reads + arithmetic), safe to call from placement loops. Returns `{ materialColor:[r,g,b] (0..1, feathered top-4 layer blend), materialWeights:{indices,weights,layers} (top-4 normalized, feathered — NOT an argmax), moisture:0..1, upness:0..1 (normalY, 1=flat), density }`. Layer weights come from the same biome/mask (`materialMasks`) tables the vertex bake uses (`FALLBACK_COLORS`/`MASK_ALIASES`/`BIOME_MATERIAL`, now exported from `terrain-textures.js`), but the hard slope/shore/depth thresholds in `fallbackMaterialAt` are replaced by `smoothstep` ramps so weights feather. `moisture` is a **proxy** (no map re-export): `moisture-proxy.js`'s biome→moisture table × elevation-dryness, floored by a shore/water-proximity band. `upness = normalY` from a 4-tap central difference of the height grid. **Additive only** — `classifyMesh`, the `addGroup` multi-material path, and the terrain material are untouched.

`terrain-textures.js`
- `export const TERRAIN_TEXTURE_LAYERS = ['grass', 'forest', 'meadow', 'taiga', 'dirt', 'savanna', 'swamp', 'sand', 'beach', 'desert', 'gravel', 'rock', 'snow']` (13 layers, each with color/normal/roughness/ao/displacement maps under `textures/ground/`; per-layer tile size + roughness + fallback color are tabulated at the top of the file).
- `export async function applyTerrainTextures(root, mapData, meta = {}, options = {})` — returns `{ material, texturedMeshes, mode:'splat', activeLayers }` (splat, the default), `{ materials, texturedMeshes, report }` (legacy), or `null` (no `document`, or missing resolution/world size). **Phase 2 (merged plan row #2) landed:** the default path now builds ONE continuous, blended `MeshStandardNodeMaterial` — no more hard seams.
  - `classifyMeshSplat` bakes the merged attribute schema per vertex: `aSplatWA`/`aSplatWB` (feathered top-4 layer weights over the map's active-layer slots, hardware-interpolated) + `aDress` = `(moisture, upness, cavityFallback, reserved)`. UV stays world `(x,z)`. No `addGroup`, no per-triangle argmax.
  - `pickActiveLayers` caps a map to `MAX_ACTIVE_LAYERS` (6) real layers (mask/biome presence + always-seeded slope/shore ramp layers). `buildTerrainArrays` packs those into two `DataArrayTexture`s (albedo rgb + roughness in alpha; normal rgb + AO in alpha) — 2 samplers total regardless of layer count (WebGPU mip gen broken → `LinearFilter`, `generateMipmaps=false`). `makeSplatMaterial` sums the active layers weighted by the interpolated attributes, replaces `fallbackMaterialAt`'s hard 0.58/0.34-slope + sea±0.5/1.5 thresholds with `smoothstep` ramps, composes the shared `mossWeight()` law (moss-tint.js) gated by `aDress.moisture × aDress.upness × (1 − sampled AO)`, and applies a sampler-free hash macro to break tiling. **Albedo is sampled triplanar** (world-normal-weighted xz/zy/xy projections, sharpened) so cliff faces don't smear — the weights collapse to plain top-down xz on flat ground, so flats are unchanged; the normal/AO tap stays planar-xz (cheaper, and normal-map stretch is far less visible than albedo smear).
  - Rock and sand are **overrides, not additions**: past the slope/shore threshold they suppress the biome/mask base (`keepBase = (1−rockW)(1−sandW)`) so a cliff reads as rock and a lakebed as sand, still feathered through the transition. Slope ramp edges (`RAMP.rock [0.42,0.58]` ≈ full rock past ~65° faces) are **bake-time** (per-vertex weights) — changing the cliff angle needs a map reload. The same ramp + suppression is mirrored in `terrain-loader.js`'s `surfaceField` so the read field and the material agree (one field).
  - Live layer UI is backed by **per-slot uniforms** (`updateTerrainTextureLayer` → `updateSplatLayer`): tile-meters / roughness-multiplier / normal-strength update instantly. **Source-swap works in splat mode** by repacking that slot's `DataArrayTexture` slice (`swapSplatSlice` → `packSlice`) and flagging re-upload — no material rebuild. Splat also exposes global uniforms via `updateTerrainSplatGlobals(root, { macroStrength, mossStrength, slopeCutoff })`; the viewer's **Global noise/static** slider scales the sampler-free macro hash around neutral `1.0`, so setting it to `0` disables that distant static contributor without touching layer textures. `getTerrainTextureLayerNames(root)` returns only the active layers in splat mode. `options.legacySplit:true` still forces the old per-`MeshStandardMaterial` path (kept intact; also the automatic fallback if node-material build throws).
  - **`options.flatMaterial:true`** (2026-07-08, perf-recovery Wave 0, terrain-dressing-performance-design.md Milestone 0): a third, diagnostic-only path (`applyFlatTerrain`) that skips both the splat build and the legacy per-triangle path and assigns ONE shared `MeshStandardNodeMaterial` (flat grass-color, no texture samplers) to every terrain mesh. Checked before `legacySplit` in `applyTerrainTextures`, so `flatMaterial:true` wins if both are somehow set. Returns `{ material, texturedMeshes, mode:'flat', activeLayers:[] }`; falls through to the normal splat/legacy path (returns `null`) if `three/webgpu` fails to import. Exists purely to isolate "how much of the frame cost is the splat shader itself" in A/B captures — never the default, and not wired to any live-tunable UI.
  - **Milestone 3B — triplanar only for slope-relevant layers** (2026-07-09, terrain-dressing-performance-design.md): `export function classifyLayerTriplanar(layerName)` is a pure, Node-testable, **static per-layer** classification — `rock`/`dirt`/`gravel`/`snow` return `true` (triplanar-capable), everything else (`grass`/`forest`/`meadow`/`taiga`/`savanna`/`swamp`/`sand`/`beach`/`desert`) returns `false` (always single-sample planar albedo). Dirt/gravel/snow are classified triplanar-capable because they're the RAMP-driven slope-transition layers by construction (never the flat-ground base), not because a specific map paints them on a cliff — the actual steep-vs-flat decision happens **per-fragment in the shader**, gated by `steepBlend`, a `clamp`ed ramp over `slopeSignal = 1 - nrmW.y` (the SAME triplanar weight signal `makeSplatMaterial` already computes for the projection blend — no new texture reads to decide) against a live uniform `uSlopeCutoff` (default `DEFAULT_TRIPLANAR_SLOPE_CUTOFF = 0.3`, exported). In the fragment loop: not-triplanar layers take one `planarSample` (xz-projected) read; `rock` always takes the full 3-read `triSample`; `dirt`/`gravel`/`snow` take both a planar and a triplanar sample and `mix()` them by `steepBlend` (TSL builds a static graph, so this layer's read count doesn't drop below "planar + triplanar" — the actual read-count win comes from the five always-planar layers dropping from 3 reads to 1 each). `uSlopeCutoff` lives in `material.userData.splatUniforms.slopeCutoff` and is one of the SHARED uniform nodes (see 3C below) both prebuilt material variants reference, so `updateTerrainSplatGlobals(root, { slopeCutoff })` and the viewer's **Triplanar slope cutoff** Perf A/B slider (0..1, step 0.01, registered from `applySplatTerrain` via `window.perfAB?.addSlider(...)`) affect whichever variant is currently assigned.
  - **Milestone 3C — top-K runtime cap** (2026-07-09): `export const DEFAULT_MAX_SHADER_LAYERS = 4`; `export function selectTopShaderLayers(activeLayers, weightByLayer, maxShaderLayers = DEFAULT_MAX_SHADER_LAYERS)` trims a (pre-sorted-ascending) active-layer list down to the `maxShaderLayers` dominant layers by total baked weight (ties break toward the lower global index — deterministic), returned re-sorted ascending (stable slot order). `maxShaderLayers >= activeLayers.length` is a no-op (returns a shallow copy, unchanged order). `applySplatTerrain` calls `pickActiveLayers` + a new internal `accumulateLayerWeights` (the presence-scan accumulator `pickActiveLayers` already did internally, now factored out and reused) to get both the map's active-layer set AND each layer's total sampled weight, then calls `selectTopShaderLayers(activeLayers, weightByLayer, options.maxShaderLayers ?? DEFAULT_MAX_SHADER_LAYERS)` to get the "reduced" layer subset. **The vertex bake (`classifyMeshSplat`) and the `DataArrayTexture` arrays are built ONCE against the FULL `activeLayers` set regardless of the cap** — `makeSplatMaterial`'s new `shaderLayers` parameter (defaults to `activeLayers`, i.e. "keep everything") is a `Set` of which slots the compiled fragment loop actually samples; a dropped slot's weight simply isn't added into `col`/`rough`/`nrm` (no re-normalization — an intentional minor darkening only where a dropped layer had nonzero blend weight, not a re-bake). Because both variants read the identical geometry attributes and array textures, **`applySplatTerrain` prebuilds BOTH a "reduced" (top-K) and a "full" (all active layers) `MeshStandardNodeMaterial`** whenever the map's active-layer count exceeds the cap (`options.prebuildVariants`, default `true`; set `false`, e.g. in tests, to build only the initially-selected variant) and registers `window.perfAB?.addSelect('Terrain shader', initialChoice, ['reduced','full'], swapFn)` where `swapFn` reassigns `mesh.material` on every textured terrain mesh — an instant swap with no shader recompile or rebake. `options.shaderQuality` (`'reduced'`|`'full'`, default `'reduced'`) picks which variant is assigned at load time (and is the select's initial value); `options.maxShaderLayers` (default 4) sets the cap; passing `6` (== `MAX_ACTIVE_LAYERS`) means nothing is ever trimmed for maps that don't exceed 6 active layers, so on the current map's 6-layer worst case it's the true "full quality" request. `root.userData.terrainSplat` gains `reducedMaterial`, `fullMaterial`, `reducedLayers`, `meshes` (the textured mesh list, for the swap) alongside the existing `material`/`arrays`/`activeLayers`/`activeNames`; `root.userData.terrainTextureReport` gains `shaderLayers` (the reduced-set names) and `maxShaderLayers`.
  - The pure weight math (`layerWeightsAt`, `pickActiveLayers`, `weightsIntoSlots`, `classifyLayerTriplanar`, `selectTopShaderLayers`) is Node-tested in `test-terrain-splat.mjs`; the TSL material is browser/WebGPU-only. See `research/terrain-appearance-analysis/MERGED-TERRAIN-UNDERSTORY-PLAN.md`.

`cdlod-terrain.js`
- `export function createCdlodTerrain(opts)` — `opts: { renderer, camera, cfg?, terrainParams?, waterLevel?, addEmissive? }`. Returns `{ mesh, async update(), setViewDistance(levels), maxLevels, setTerrain(p), setWaterLevel(), triangleCount, drawCount, stats, dispose() }`.

`cdlod-select.js`
- `export function part1by1(n)`, `export function compact1by1(n)` — 16-bit Morton bit spread/compact.
- `export function mortonKey(level, ix, iz)` → `{ level, code }`; `export function decodeMorton(key)` → `{ level, ix, iz }`.
- `export function nodeSize(cfg, level)`, `export function levelRanges(cfg)` → `Float32Array`.
- `export function minDistToCell(ox, oz, s, px, pz)`.
- `export function morphFactor(cfg, ranges, level, d)`.
- `export function selectNodes(cfg, camX, camZ)` → array of `{ level, ix, iz, originX, originZ, size, d, morphK }`.
- `export function nodeCountForViewDistance(cfg, camX, camZ)`.
- `export function morphGridCoord(g, N, morphK)`.

`collision.js`
- `export function groundContact({ x, z, bottomY, slopeLimitY = 0.5, heightAt, normalAt })` → `{ groundY, penetration, grounded, normal, restBottomY }`.
- `export function slideVelocity(v, n)` → new `{x,y,z}`.
- `export function resolveTrunks(px, pz, radius, trunks, iterations = 4)` → `{ x, z, pushed }`.
- `export function createTrunkIndex(chunkSize)` → `{ setTrunks(key, trunks), clearTrunks(key), nearby(px, pz, out?), resolve(px, pz, radius) }`. `nearby` takes an optional reusable `out` array (cleared and filled in place) to avoid a per-call allocation; omitting it preserves the old fresh-array return. The creature steering path (`nearbyTrunks`) passes a shared scratch buffer.

`map-collision.js`
- `export function createMapCollider(root, { maxTriangles = 250000, extraRoots = null } = {})` → `{ geometry, triangleCount, resolveCapsule(capsule, velocity, { slopeLimitY, iterations }), raycastDown(origin, maxDistance), raycast(origin, dir, maxDistance), isOccluded(origin, dir, maxDistance), dispose() }`. Throws if the authored map exceeds `maxTriangles` or has zero collision triangles. `raycast` returns the nearest world hit as `{ distance, point:[x,y,z], normal:[x,y,z] }` or `null` — used as the exact bullet occluder in `resolveWorldShot` (walls stop shots on their real faces instead of the heightfield's inflated wall-top ramps). `isOccluded(origin, dir, maxDistance)` is a boolean-only, allocation-minimized LOS check (`boundsTree.raycastFirst` + reusable `Ray` scratch) for callers that only need "blocked or not", e.g. bot line-of-sight; the shared `_raycaster` also sets `firstHitOnly = true` so `raycast`/`raycastDown` short-circuit to the BVH's closest hit instead of collecting and sorting all hits.
- `raycastAll(origin, dir, maxDistance = 200, out = [])` → the same hit records for **every** solid crossing, near to far, into a reusable `out`. Toggles `firstHitOnly` off and restores it in a `finally`, and casts against a second `THREE.Mesh` sharing the same geometry and BVH but carrying a `DoubleSide` material — a cave ceiling's normal points down into the cavity, so a downward ray strikes it from behind and the default `FrontSide` would cull it. Every pre-existing path keeps the culled mesh, so LOS behaviour is unchanged. Bake-time cost, not per-frame.

`map-surfaces.js`
- `export const SURFACE_DEFAULTS = { slopeLimitY: 0.5, minHeadroom: 2.1, coplanarEpsilon: 0.05, samples: 3, maxDeviation: 1.5, levelTolerance: null }`
- `export function createSurfaceQuery({ raycastAll, worldYMax, worldYMin }, defaults)` → `{ surfacesAt, surfaceNear, footprintAt, footprintLevels, config }`.
- `surfacesAt(x, z, opts)` → standable surfaces highest-first as `{ y, normalY, headroom, ceilingY, openSky }`. One downward ray; a surface's ceiling is simply the previous hit, so `headroom` is the Y gap to whatever is directly above and `Infinity` under open sky. Down-facing hits are ceilings, never floors; coplanar duplicates within `coplanarEpsilon` collapse to one surface.
- `footprintAt(cx, cz, w, d, level, opts)` → `{ ok, floorY, skirtDepth, deviation, headroom, openSky }` or `{ ok: false, reason }` where reason is `no-surface` | `too-uneven` | `low-ceiling`. Seats the floor at the **highest** sample so no ground pokes through it and reports how far the foundation skirts down to the lowest — cut-and-fill, not a flattened pad. **`level` is a constraint, not a preference**: a sample further from it than `levelTolerance` (defaulting to `maxDeviation`) is a miss, which is what stops a column with no floor at that level from silently snapping up to the roof above it.
- `footprintLevels(cx, cz, w, d, opts)` → every viable level, best first. Exterior content filters on `openSky`, interior content on its negation.
- `surfaceDecks(query, bounds, cellSize, opts)` → `{ decks, truncated, columns }`. Walks the SAME cell lattice `buildNavGrid` uses (`minX + (c + 0.5) * cellSize`) and emits a cell-sized `{x, z, w, d, y}` deck for every standable surface that is **not** the one `heightAt` already describes — i.e. exactly the input `nav-grid.js#attachLevels` stamps. Pass the grid's own `heightAt` as `opts.baseHeightAt`; surfaces within `baseTolerance` (0.25 m) of it are the base column and are skipped. `truncated` reports hitting `maxDecks`, because a silently capped deck set reads as a pathing bug rather than a missing interior.

**Why this exists.** `terrain-loader`'s `heightAt` is single-valued, and for a volumetric map (`terrainKind: 'volumetric'`, terrain-generator-v4's marching-cubes export) there is no `heights` array in the payload at all — the loader falls back to `deriveTopSurfaceHeights`, which keeps the max-Y vertex per grid cell. On a cave world that grid describes the roof and nothing beneath it, so anything placing content or pathing by sampling `heightAt` builds on the roof and never enters the interior.

**Wiring (`environment-viewer-v2.html`).** `rebuildMapSurfaces()` builds the query from the collider right after `createMapCollider`, and again after structures rebuild it. `buildLocalNavWindow` feeds `surfaceDecks` into `buildNavGrid`'s `decks` when `mapHasMultipleLevels()` — true for a volumetric map or once structures exist, forceable with `?levelNav=1|0`. The local window is 24×24 cells at the shipped `BOT_LOCAL_NAV_RADIUS`/`BOT_LOCAL_NAV_CELL`, so it is one downward ray per cell, rebuilt with the window. `buildMapStructures()` scatters structures whose `site` hook is `footprintAt`.

All of it is panel-driven, in a **Map structures** section that only appears on an imported map (the procedural chunked ground has no collider to query): Count (0 = off, the default), Seed, Mix, Min headroom, Max ground slope, and a Multi-level nav `auto|on|off` select. Every control registers into `controlRegistry`, so structure settings save and load with slider states like any other. Changes debounce 400 ms — longer than the forest's 200 — because each rebuild re-bakes the collision BVH over the whole map, which is the expensive half. `clearMapStructures()` tears down the group and returns the collider to the map alone, so a slider change rebuilds rather than stacking a second scatter on the first. The section shows a live readout of placed-vs-refused: refusals are the interesting number, since they are the ground declining a site. `?structures=N`, `?structureSeed=`, `?structureMix=` and `?levelNav=0|1` still set the STARTING values, the same "URL sets initial state, the panel moves it live" rule the water and terrain-texture controls follow.

## Wiring

Static imports in `environment-viewer.html`:
- `import { createTerrainSystem, terrainNormalAt } from './terrain-system.js'` (line 42)
- `import { groundContact, slideVelocity, createTrunkIndex } from './collision.js'` (line 43)
- `import { loadTerrainMap } from './terrain-loader.js'` (line 48)
- `import { createMapCollider } from './map-collision.js'` (line 50)

Lazy `await import()`:
- `cdlod-terrain.js` — line 274, inside `if (!loadedMap && TERRAIN_MODE === 'gpu') { const { createCdlodTerrain } = await import('./cdlod-terrain.js'); ... }`. Only loaded when no authored map is active and `?terrain=` (default `gpu`) isn't `chunks`.

Inter-file dependencies:
- `terrain-system.js` imports `terrainHeightAt`, `terrainNormalAt`, `buildChunkArrays`, `buildHeightTile` from `terrain-field.js`, and spins up `terrain-worker.js` as a module `Worker` (`new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' })`), falling back to synchronous building (calling the same `terrain-field.js` functions directly) if `Worker` construction throws (e.g. `file://`).
- `terrain-worker.js` imports `buildChunkArrays`, `buildHeightTile` from `terrain-field.js` and runs them inside `self.onmessage`.
- `cdlod-terrain.js` imports `selectNodes` from `cdlod-select.js` — used only for the CPU-side HUD survivor-count mirror (`survivorCount()`); the actual per-frame node selection is a TSL transcription of the same math run on the GPU via `renderer.computeAsync([reset, select, finalize])`.
- `terrain-loader.js` imports `applyTerrainTextures` from `terrain-textures.js` to splat ground materials onto an authored map's meshes after the GLTF + JSON sidecar load.
- `map-collision.js` is independent of `terrain-field.js`/`terrain-system.js` — it builds its BVH straight from whatever mesh root is passed in (the loaded map's `root`), used only when an authored map (not the procedural chunked/CDLOD ground) is active.
- `collision.js` is independent of Three.js and of `terrain-system.js`; the host wires it to the procedural ground by passing `terrainSystem.getHeight`/`terrainNormalAt` (or, for authored maps, `terrainHeight`/`terrainNormal` functions) as its `heightAt`/`normalAt` callbacks.
- On authored maps, the `terrainHeight(x,z)` closure in `environment-viewer.html` first bilinear-samples a **CPU heightfield** (`cpuHeightField` / `sampleHeightField`) baked from the collider, falling back to `mapCollider.raycastDown` (then `loadedMap.heightAt`) outside the baked bounds. The heightfield aliases the same `Float32Array` the grass `bakeHeightTexture` already produces at load (no extra bake, no extra memory); it is installed only after that bake, so the bake itself still fills via raycast. This turns the dominant per-call BVH raycast in creature terrain sampling into an array read (creature-perf-analysis/plan.md 3.1). A one-time load-time check samples the bilinear-vs-raycast height error: it warns automatically if max error exceeds 0.5u, and logs full detail under `?heightfieldCheck` (silent otherwise). Measured ~0.07u max on a 1200² (1u/cell) map.
- `cdlod-terrain.js`'s analytic TSL height function (`heightFn`) is a hand-transcribed copy of `terrainHeightAt` in `terrain-field.js`, not a shared import (TSL nodes can't directly call the JS function) — parity is verified by `test-grass-height-tsl.mjs` via the separate `grass-height-ref.js` port and `test-cdlod-morph.mjs`.

## Architecture notes

- **Closed-form height field.** `terrainHeightAt` is a fixed sum of sines/cosines plus a smoothstep-gated lake basin (Perlin-ish value noise `lakeNoise`/`lakeHash`), parameterized only by `{ baseAmp, lake, lakeDepth }`. Because it's a pure function of world (x,z), every consumer (chunk mesh, GPU CDLOD shader, grass, trees, collision, water) can query identical ground height with no shared mutable state or spatial structure — `terrainNormalAt` is a fixed-epsilon (`e=0.5`) central difference of the same function, which is why adjacent chunks/tiles/CDLOD nodes never show lighting seams (`test-terrain-field.mjs`, `test-terrain-tile-seam.mjs`).
- **Chunking strategy (`terrain-system.js`).** The world is partitioned into `chunkSize`-sided square chunks keyed by `"ix,iz"`. `update(centerX, centerZ)` recomputes a target window (`renderRadius` ring around the center chunk) whenever the center chunk moves or chunking params (`chunkSize`/`renderRadius`) change; missing chunks are queued sorted by distance, built at most `maxChunksPerUpdate` per call (worker-dispatched when available, else synchronous), and stale chunks are unloaded at most `maxUnloadsPerUpdate` per call once the build queue and in-flight worker jobs are both empty (prevents mid-stream churn). A synchronous "cold start" builds the nearest chunk immediately so `primaryMesh`/`activeChunks` exist before the first frame (water/decorations bind to them).
- **Worker offloading.** `terrain-system.js` posts chunk-build jobs (`{ key, epoch, xMin, zMin, size, segments, computeNormals, params }`) to `terrain-worker.js`, which returns positions/normals/uvs/index as zero-copy transferables. An `epoch` counter is bumped on every `rebuild()` and `setSource()`; results whose `epoch` doesn't match the live one are dropped (stale-result guard for rapid param changes). If `new Worker(...)` throws (e.g. `file://` with no module-worker support), `disableWorker()` clears in-flight state and the system falls back to building every chunk synchronously on the main thread.
- **Render modes.** `renderMode: 'chunks'` (default/legacy) builds one `THREE.Mesh` per chunk added to `this.group`. `renderMode: 'instanced'` (gated by `experimentalInstancedTerrain`, disabled by default — "until shader height parity with terrainHeightAt is proven") collapses rendering to a single `InstancedMesh` over a reusable patch grid, sampling a `DataTexture` height atlas (one tile per active chunk, built via `buildHeightTile`/the worker's `heightTile` job, RedFormat Float32, with a 1-texel apron for seam-safe bilinear+normal reconstruction) instead of baking height into vertex positions. `visualMode: 'external'` builds chunk *records* only (key/xMin/zMin/size metadata, no geometry/mesh) — used when the GPU CDLOD system (`cdlod-terrain.js`) renders the actual visible ground but decorations/collision still need the chunk window/height query API.
- **CDLOD node selection (`cdlod-select.js` / `cdlod-terrain.js`).** A camera-snapped, Morton-keyed (Z-order, 16-bit-per-axis, signed-bias-by-0x8000) quadtree, but selection is *flattened* rather than tree-traversed: for each of `cfg.levels` levels and each cell in a `windowCells × windowCells` window centered on the camera's level-snapped cell, a node is emitted iff `notRefined` (camera far enough that this level isn't subdivided further: `L===0` or `dist > range[L-1]`) AND `refinedByParent` (camera close enough that the parent level chose to refine into this node: `L===levels-1` or `parentDist <= range[L]`). This guarantees every point lands in exactly one selected node (verified as a literal coverage partition by `test-cdlod-select.mjs`), bounds node count to `levels * windowCells²` regardless of view distance (each added level is one bounded ring, not area growth), and is GPU-friendly: `cdlod-terrain.js`'s `select` TSL compute kernel runs one thread per `(level, window-cell)` candidate, atomically appending survivors into a `StorageInstancedBufferAttribute`, then a `finalize` pass writes the survivor count into an `IndirectStorageBufferAttribute` for a single `drawIndexedIndirect` of the reusable patch grid (`reset`→`select`→`finalize` chained via `renderer.computeAsync`). Vertex-level CDLOD morphing (`morphGridCoord`/`morphAxis`) pulls odd-indexed grid vertices toward the even (parent-level) lattice as `morphK→1`, so a fully-morphed fine node's boundary matches its coarser neighbor exactly (crack-free; `test-cdlod-morph.mjs`).
- **BVH vs analytic collision.** `collision.js` is the Phase-A analytic-only path (SP5): O(1) capsule-bottom-vs-`heightAt` contact test plus a chunk-bucketed trunk index for tree-trunk push-out — no spatial structure needed because the ground is a closed form. `map-collision.js` is the authored-map path: it walks the entire loaded GLTF mesh tree, flattens every triangle into world space (capped at `maxTriangles`, default 250,000 — throws if exceeded), and builds a `MeshBVH` (three-mesh-bvh) for `shapecast`-based iterative capsule resolution (`resolveCapsule`, default 3 iterations, pushes the capsule out of the closest triangle each pass, zeroes the into-surface velocity component, flags grounded when the surface normal clears `slopeLimitY`) and downward raycasts (`raycastDown`, used by `terrainHeight`/`terrainNormal` in the host when an authored map + collider are active). The two are mutually exclusive per scene: authored maps use `map-collision.js`; the procedural chunked/CDLOD ground uses `collision.js` directly against `terrainSystem.getHeight`/`terrainNormalAt`.

## Tunable parameters

`environment-ui.js` is the perf-HUD/debug-panel module (`createEnvironmentUi`) — it only *displays* terrain stats (e.g. `Terrain` row: render mode, draw count, chunk counts) and does not define any sliders itself. The actual terrain/CDLOD tunables are GUI sliders/toggles built directly in `environment-viewer.html`'s control-panel section (~line 1644 onward), all bound to the shared `terrain` params object:

| Control | Range / step | Effect |
|---|---|---|
| `size` ("View distance") | 200–1000, step 10 | Camera far plane + fog distance only (`updateDrawDistance()`); does not rebuild the chunked terrain. |
| `renderRadius` ("Draw distance (chunks)") | 1–12, step 1 | Streams `terrainSystem.params.renderRadius` live (no full rebuild); also maps to CDLOD `setViewDistance(2 + renderRadius)` when the GPU ground is active. |
| `lake` ("Lake coverage") | 0–1, step 0.01 | Debounced `worldRebuild()` (220ms); pushed into `cdlodRef.setTerrain(...)` and `grassRef.setTerrain(...)` too. |
| `lakeDepth` ("Lake depth") | 0–6, step 0.1 | Same debounced rebuild path as `lake`. |
| `waterLevel` ("Water level") | -3–1, step 0.05 | Same debounced rebuild path; also drives water/shoreline regeneration. |

`?terrain=gpu|chunks` URL param selects the CDLOD vs. legacy chunk-mesh renderer (default `gpu`); `terrainSystem`'s `visualMode` is set to `'external'` when `gpu` is active so the chunk system only tracks metadata/collision while `cdlod-terrain.js` renders the ground.

`?terrainTexture=splat|legacy|flat` (2026-07-08, perf-recovery Wave 0, terrain-dressing-performance-design.md Milestone 0) selects the authored-map ground material build path — see `terrain-loader.js`'s Public API entry above and `terrain-textures.js`'s `applyFlatTerrain` doc entry. Default `splat` is behavior-identical to before this flag existed; `legacy` and `flat` remain diagnostic URL-flag-only modes, not swappable via Perf A/B.

**Milestones 3B/3C landed** (2026-07-09, terrain-dressing-performance-design.md): unlike `terrainTexture`, the reduced/full **material-quality** swap now DOES have a live Perf A/B control — `applySplatTerrain` prebuilds both the "reduced" (top-`maxShaderLayers`, default 4) and "full" (all active layers) splat materials whenever a map's active-layer count exceeds the cap, and registers `window.perfAB?.addSelect('Terrain shader', 'reduced'|'full', ['reduced','full'], swapFn)` (instant `mesh.material` reassignment, no recompile) plus `window.perfAB?.addSlider('Triplanar slope cutoff', 0.3, 0, 1, 0.01, setUniformFn)` for the 3B steep-gate threshold. Both registrations happen from `terrain-loader.js`'s static import chain (`terrain-textures.js`'s `applySplatTerrain`), not from `environment-viewer.html`, per the frozen `window.perfAB?.addX(...)` contract (`infra.md`) — no viewer edit was needed or made. There is still no `?terrainTextureQuality=` URL flag; `loadTerrainMap`'s `maxShaderLayers`/`slopeCutoff`/`shaderQuality`/`prebuildVariants` options exist as a pass-through material-build surface only (see `terrain-loader.js`'s Public API entry above) — URL flag wiring is left for a later wave, same as `terrainTexture` was in Wave 0.

## Per-frame cost accounting

`terrain.update()` used to sit behind a single profiler slot that hid three unrelated costs, which
made a 28-57 ms spike unattributable. Since 2026-08-24 the split is:

| Where | What | Reported as |
|---|---|---|
| `system.update` | queue maintenance and dispatch, budgeted by `maxChunksPerUpdate` | `stats.lastUpdateMs` |
| after `system.update`, when `changed` | `applyMaterials()` + `syncVolumeColliders()`, **unbudgeted** | `frameCost.foldMs` |
| after that | field-window recentre, scheduler pump, coverage | `frameCost.fieldMs` |
| `w.onmessage`, outside the rAF entirely | `installChunk` for each arriving worker result | `frameCost.installMs` |

`TerrainSystem.onWorkerChunk` wraps the real handler (`onWorkerChunkInner`) and accumulates elapsed
time into `installMsPending`; `takeInstallCost()` drains it and is called once per frame from
`base-game-terrain.js`, summing the near system and every cascade level. This matters because that
work runs on a worker message, not inside `animate()`, so **no profiler slot can ever see it** and it
surfaces only as a frame-time tail. `terrain.frameCost` returns all four numbers cheaply enough to
read every frame — it reuses one object, so a caller that keeps the value past the frame must copy it
(the performance capture spreads it); `terrain.stats` carries the same values as `lastFoldMs` / `lastFieldMs` /
`lastInstallMs` / `lastInstallCount` for the performance record.

Note that `maxChunksPerUpdate` budgets *dispatch* only. Up to four workers deliver concurrently, so
several results can land on one frame regardless of that setting.

### Collider build: why it is on the main thread, and what it costs

`createMapCollider` (`map-collision.js`) was written for **authored maps**: hand it a loaded scene
root and it walks the graph, bakes every mesh and `InstancedMesh` into de-indexed world-space
triangles, and builds one `MeshBVH`. That API shape is inherently main-thread, since a scene graph
cannot cross a worker boundary.

`world-query-chunk-mesh-provider.setChunk` reuses it per streamed chunk, wrapping a single geometry
in `new THREE.Mesh(geometry)` purely to satisfy `traverse`. So a walk-the-whole-scene function runs
once per chunk, at streaming rate, on the main thread.

Measured on a 3200-triangle chunk (warm, median of 5):

| path | bake | BVH | total |
|---|---|---|---|
| general (bake de-indexed world triangles) | 1.690 ms | 0.575 ms | 2.265 ms |
| direct (share positions, copy the index) | **0.024 ms** | 0.723 ms | **0.747 ms** |

So the de-index was ~75% of the build, not a rounding error. `createMapCollider` now takes a direct
path when given exactly one indexed mesh at an identity transform, which is precisely the streamed
chunk case. It **shares** the position attribute (MeshBVH never writes positions) and **copies** the
index, because MeshBVH reorders indices in place and a sliced chunk's index is a `subarray` view
onto the buffer being rendered. `dispose()` skips `geometry.dispose()` on that path for the same
reason. Anything else -- a transform, several meshes, an `InstancedMesh`, non-indexed geometry --
falls back to baking, and `collider.buildMs` reports `{ bake, bvh, direct }` so a capture says which
ran. `test-map-collision.mjs` pins both paths.

Beware measuring this cold: the first `createMapCollider` call in a process reports the BVH at
~7.8 ms against a warm 0.72 ms, purely JIT warmup. A single cold call reverses the conclusion.

Measured in the browser afterwards, over 1068 chunk builds across five captures, the split is
steady: **bake 0.046-0.051 ms/chunk, BVH 0.978-1.045 ms/chunk, `direct: true`** -- the de-index is
gone and the BVH is 95% of what is left. `passTerrainColliderMs` max fell from 4.8-6.6 ms to
2.4-3.9 ms, and a single rebuild (`lastBvhMs`) from ~6.6 ms to ~1.6 ms.

Moving the BVH into `terrain-worker.js` is still possible -- `three-mesh-bvh` has
`MeshBVH.serialize()`/`deserialize()` for exactly that -- but at ~1 ms per chunk under a budget of
one per update it is no longer what a frame is waiting on. Terrain's worst pass across those
captures is 8.4 ms against a pre-budget 40.1 ms; `postRender` (p50 3.9-6.0 ms, max 14-28 ms) is now
the largest contributor by a clear margin.

### Per-chunk frustum culling: off by default (2026-08-26)

Verified against the shipped r184 build: `WebGPUBackend._draw` (`three.webgpu.js` ~81451) draws a
`BatchedMesh` as one `drawIndexed` per visible geometry in a JS loop, passing the slot as
`firstInstance` so the shader's `instanceIndex` indexes the batch's indirect texture. There is no
multi-draw path on WebGPU (the `WEBGL_multi_draw` fast path at ~70302 is the WebGL backend), no
optional device feature three could request, and `geometry.indirect` is ignored for BatchedMesh.
So batching here never reduced draw calls; what it buys is one scene object / RenderObject /
pipeline / bind-group set per batch and no per-mesh matrix uploads — still worth having.

Given that, per-chunk frustum culling paid a per-instance matrix + bounding-sphere + frustum loop
(`three.core.js` `onBeforeRender`, ~169 near + ~75 cascade chunks, per camera per pass, doubled on
mirror frames) to save ~70 tiny draws against a measured ~1 ms GPU load. It is now off by default:
with `perObjectFrustumCulled: false` and `sortObjects: false`, `onBeforeRender` early-outs unless
visibility changed (`three.core.js` ~27218), and every visible chunk is submitted. A/B without
editing the modules: `params.batchFrustumCulled: true` on `createBaseGameTerrain` restores the old
behaviour (it feeds `perObjectFrustumCulled` to the near and cascade batchers).

`stats.draws` was fixed at the same time: it used to report batch *objects* (and omitted the
cascade batchers), which read as "1 draw" against ~100 real ones in a capture. It now reports GPU
draw calls — visible fallback meshes plus `drawCount` across batches — and `farLod.draws`/
`farLod.triangles` include the cascade batchers.

**Unmeasured:** the CPU saved by the early-out has not been captured in a browser, and the cull
loop's share of `passPostMs` is unknown. The profiler already splits `passPostMirrorMs` /
`passPostPlainMs`; a capture of those with `batchFrustumCulled` true vs false is what settles it.

### The fold-in budget

Measured in the 2026-08-25 captures, the fold was **86% of the terrain pass spike** (up to 35 ms of a
40 ms pass), so it is now rationed:

- `maxFoldsPerUpdate` (default 2) caps how many chunks are colorized and copied into a
  `BatchedMesh` per update, shared across the near system and every cascade level.
- `maxColliderRebuildsPerUpdate` (default 2) caps `volumeProvider.setChunk` calls. The wanted list
  is sorted by squared distance from the focus, so **the chunk under the player is always rebuilt
  first** and a budget can never defer the ground someone is standing on.
- `maxCompactionsPerFrame` (default 1, opt-in) in `terrain-chunk-batches.js` rations
  `BatchedMesh.optimize()`, which rewrites and re-uploads the batch's entire vertex and index
  buffer. More than one of those in a frame is a hitch on its own. A batcher using it must call
  `beginFrame()` each frame or the ration never refills; the default of 0 (unlimited) keeps any
  other caller unaffected.

Deferring is safe because an unbatched chunk keeps drawing its own mesh (`syncBatches` sets
`chunk.mesh.visible = !inBatch`), so the cost of missing a turn is one extra draw call for a frame,
not a hole in the ground. `stats.foldPending` / `stats.colliderPending` report a backlog, and the
update runs the fold whenever `changed || foldPending || colliderPending` so the backlog always
drains.

**The budget alone was not enough, and the fold is timed three ways because of it.** The first
post-budget captures put the worst fold at 18.4 ms against a pre-budget worst of 35.0 ms — but
18.4 ms under `maxFoldsPerUpdate: 2` cannot be per-chunk batching, so the fold was split rather than
guessed at a second time:

| Reported as | What | Budgeted? | Measured max |
|---|---|---|---|
| `passTerrainColliderMs` | `collisionGeometry` + `volumeProvider.setChunk` (`createMapCollider`) | yes | **4.8-7.5 ms** |
| `passTerrainBatchMs` | `syncBatches`: colorize + copy into the `BatchedMesh` | yes | 1.0-1.4 ms |
| `passTerrainColorizeMs` | `colorizeGeometry` over `group.children`, near and every cascade | no | 0.6 ms |

The 2026-08-25 14:21-14:22 captures settled it: **the collider BVH is 91-96% of the fold**
(7.8 ms fold = 7.5 collider + 1.4 batch + 0.6 colorize). The colorize loop was the prime suspect on
the reasoning that it runs unbudgeted over every chunk — it is 0.6 ms and does not matter, so
moving colours to chunk build time would have been wasted work. `maxColliderRebuildsPerUpdate` is
therefore 1, not 2: `createMapCollider` costs ~2.4-3.75 ms per chunk and 1/frame at 60 Hz still
outruns the ~14 chunks/s that actually arrive.

Measured effect on the whole pipeline, stable captures only:

| | fps med | frame p95 med | frame p95 worst | fold max med | fold max worst |
|---|---|---|---|---|---|
| pre-budget (n=27) | 69.3 | 20.2 | 64.1 | 11.3 | 35.0 |
| post-budget (n=2, 14:21-14:22) | 71.3 | **18.7** | **19.0** | **6.5** | **7.8** |

`test-base-game-terrain.mjs` section 8 proves it by counting: unbudgeted, one update folds 4 chunks;
with a budget of 1 it never exceeds 1, and both reach the same 49/49 batched end state with zero
fallbacks. Timing is deliberately not asserted — headless the analytic chunks are cheap plane
geometry with no GPU upload, and the measured max moves non-monotonically with the budget, i.e. it is
noise. The real effect is read from `passTerrainFoldMs` in a browser capture.

## Tests

| Test file | Covers | What it checks |
|---|---|---|
| `test-terrain-field.mjs` | `buildChunkArrays`, `terrainHeightAt`, `terrainNormalAt` | Worker geometry builder is behaviour-equivalent to the old `THREE.PlaneGeometry` + per-vertex height/normal path (position/normal/uv/index parity, incl. >65535-vertex Uint32 index path); front-face winding is always up; adjacent chunks share identical edge vertices/normals (seamless). |
| `test-terrain-heightmap-parity.mjs` | `terrainHeightAt` (heightmap-sampled path) | Predicts GPU bilinear-texture-sampled height error vs. the analytic field at several texel densities (sweeps flat vs. steep/lake-shore regions); asserts the recommended 0.5 u/texel density keeps worst-case/p99.9 error within tolerance and beats the current-mesh-equivalent density. |
| `test-terrain-tile-seam.mjs` | `buildHeightTile`, `sampleHeightTileBilinear` | Adjacent height tiles (and a 2×2 diagonal block) agree exactly on shared-edge heights and heightmap-derived normals — no seams for the instanced/atlas path. |
| `test-terrain-system.mjs` (cases 7–11) | `terrain-system.js` source path | Injected descriptor streams source-built chunks identical to the legacy builder; `setSource` drops old-epoch results, replaces chunks with no hole (resident count never dips) and disposes old meshes; finite bounds clip the window to 2×2 and to zero far outside; sync fallback and external mode with a source. |
| `test-terrain-volume.mjs` | `terrain-source-v5.js` volume, `world-query-chunk-mesh-provider.js`, `base-game-terrain.js` volumetric | Point density equals the editor's unbounded volumetric preview at its grid (<1e-4); unbounded 3D noise varies far out while the legacy one clamps; tile seams share every border vertex with equal gradient normals; column tops match the density surface; chunk provider raycast/raycastAll/capsule/remove; Base Game fixture: nine volumetric chunks, cave found from `raycastAll` (top → ceiling → floor), player stands on the surface, on the cave floor at the same X/Z ~20 m lower, returns on top, kill plane below the density floor, switching volumetric off restores heightfield collision. |
| `test-terrain-source-v5.mjs` | `terrain-source-v5.js` | Descriptor/source construction and rejections (bounded algorithm, import layer, paint, hash mismatch); point vs tile bit-identity; borders/corners at negative coords; order/instance independence and descriptor save/load; migrated unbounded preview (pre-erosion stack height) vs source within 1e-2 m over the board while bounded vs unbounded climate differ; far coordinates keep varying; worker `sourceTile` with a v5 descriptor; default editor project streams after migration. |
| `test-terrain-source.mjs` | `terrain-source.js`, `terrain-source-analytic.js`, `terrain-worker.js` (`sourceTile` job) | 65 checks: descriptor/request/result validation, key round-trip, analytic points and LOD-0 tiles bit-identical to `terrain-field.js`, negative-tile/corner/apron seams, registry from JSON descriptor, worker transferables and error replies, legacy `heightTile` path intact. |
| `test-terrain-worker-heighttile.mjs` | `terrain-worker.js` (`heightTile` + `sourceTile` jobs) | Mocks `self`/`postMessage` (Node has no browser worker scope) and verifies the worker's `heightTile` reply round-trips key/epoch, returns a `Float32Array` of the expected length/step/origin. |
| `test-terrain-instanced.mjs` | `TerrainSystem` instanced render mode | With a fake synchronous-via-`setTimeout` Worker: instanced mode collapses to exactly one render child (`InstancedMesh`) regardless of streaming; `experimentalInstancedTerrain` gates the request (falls back to `'chunks'` otherwise); instance count tracks `renderRadius`; height atlas gets populated from worker `heightTile` jobs; chunk meshes are never attached to the render group; `dispose()` empties the group. |
| `test-terrain-system.mjs` | `TerrainSystem` (chunk render mode, worker + sync) | Worker streaming fills the expected ring size; movement loads new chunks and unloads old ones with no stale overlap; `rebuild()` bumps `epoch` and drops stale in-flight results; live `renderRadius` changes restream without a full rebuild; synchronous fallback works when `Worker` construction throws; `visualMode: 'external'` produces metadata-only records (no meshes, no group children) while `getHeight` keeps working. |
| `test-collision.mjs` | `groundContact`, `slideVelocity`, `resolveTrunks`, `createTrunkIndex` (against the real `terrain-field.js` field) | Above/below/steep ground contact classification and `restBottomY`/`normal` correctness; velocity sliding removes only the into-surface component and preserves jumps; trunk push-out reaches exact `radius+r` distance, leaves clear points untouched, handles the degenerate same-center case deterministically, and guarantees no tunneling when two trunks' exclusion zones overlap; `createTrunkIndex` bucket set/resolve/clear and 3×3-neighborhood `nearby()` lookup. |
| `test-grass-height-tsl.mjs` (terrain-field.js-relevant parts) | `terrainHeightAt` vs. `grassHeightRef` (a separate TSL-port reference module, not part of this subsystem) | The JS height port used elsewhere for GPU parity testing matches `terrainHeightAt` to <1e-6 over a swept grid, is deterministic, and that `lakeDepth` actually perturbs height where a basin exists. |
| `test-surface-field.mjs` | `moisture-proxy.js` (`surfaceField` CPU twins) | Moisture proxy bounded 0..1, monotone non-decreasing in biome wetness, non-increasing with elevation, floored wet near/below sea level; biome table ordering; `upness == clamped normalY`; a dry+steep sample feeds `mossWeight` → 0. |
| `test-moss-tint.mjs` | `moss-tint-ref.js` (`mossWeight` law) | Bounded 0..1; monotone non-decreasing in moisture, upness, cavity, brushNoise; hard-zero below either the moisture or upness ramp start (dry OR steep → 0); wet+flat+sheltered → strong. |
| `test-cdlod-morton.mjs` | `part1by1`, `compact1by1`, `mortonKey`, `decodeMorton` | Bit spread/compact are exact inverses on 16-bit inputs; `mortonKey`/`decodeMorton` round-trip signed level/ix/iz (including negatives); distinct cells produce distinct codes. |
| `test-cdlod-select.mjs` | `levelRanges`, `nodeSize`, `minDistToCell`, `selectNodes`, `nodeCountForViewDistance` | Range/size formulas match the geometric definition; `minDistToCell` is exact inside/outside a cell; **coverage partition** — every sampled point near the camera lands in exactly one selected node, across several camera positions; the camera's own cell is always a level-0 (finest) node; **bounded cost** — node count never exceeds `levels*windowCells²` and adding levels grows by bounded rings, not quadratically, with view distance; sub-leaf camera moves leave coarse node origins stable (no shimmer). |
| `test-cdlod-morph.mjs` | `morphGridCoord`, `nodeSize` (cross-checked against `grassHeightRef`) | `morphK=0` is the identity; `morphK=1` snaps every grid vertex onto the parent (even) lattice; a fully-morphed fine node's boundary heights exactly match the coarser neighbor's lattice points (crack-free seam proof). |

## Ground colour

What the terrain shows is the streamed splat textures when `terrainTextures` is on, and a per-vertex
height/slope tint when it is off -- "Ground textures replace the vertex tint when set". Both forms
are exported so anything planted ON the ground can match it instead of guessing:

- `terrainTintAt(yAboveSea, normalY, out, offset)` -- CPU, the only implementation `colorizeGeometry`
  has, over `TERRAIN_TINT` and `TERRAIN_TINT_BANDS`.
- `terrainTintNode(yAboveSea, normalY)` -- the hand-synced TSL twin, over the same constants.
- `createSplatSampleNode(textures, cfg)` (`terrain-splat-streamed.js`) -- the ground's albedo at a
  world point, read from the same maps the terrain draws with and blended by the same layer weights.
  Explicit-LOD (`setMip`) because callers run it in a compute kernel, which has no derivatives.
- `createSplatAverageNode(textures, cfg)` -- the same weights folded into per-layer AVERAGE colour.
  Only correct past `fadeFar` (1400 m), where the material itself settles on the average; inside
  that it is an approximation, so prefer the sample node for anything within a few hundred metres.
- Both share one `createSplatWeightsNode`, the GPU twin of `splatWeights`. It returns
  `(sand, grass, dirt, rock)` already split by slope; the five weights sum to 1, so snow is the
  remainder.
- `terrain.groundColorNode()` -- global height and normal-Y in, `vec3` out, blending the two by the
  ground-textures toggle. Grass tints toward this (`docs/subsystems/vegetation.md`).

Base Game also uses this mechanism for its world plan (2026-09-01): a 30 m post, 16-tile-per-side
CPU-only window on a dedicated one-worker scheduler. Its `planWalk` u8 field is derived from each
height tile's apron: zero means water or cliff and 1..255 classifies increasingly easy ground.
`createFieldWindow({gpu:false})` keeps the same CPU/readiness contract without allocating or
uploading `DataTexture`s. `touch()` and `stampAlong()` allow a derived resident channel such as
flora cover to be changed along a polyline and publish one new window version without scanning the
polyline's whole bounding box.
