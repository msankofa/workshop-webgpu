# Terrain + Dressing Performance Recovery Design

## Context

Recent performance captures show the renderer regressed after the July 5 optimization work.

The last good full-scene stats were:

| Capture | FPS median | CPU median | renderDrawCalls | passPostMs | passGpuAwaitMs |
| --- | ---: | ---: | ---: | ---: | ---: |
| `perf-2026-07-05T06-43-10-616Z.csv` | 62.65 | 10.35 ms | 127.5 | 6.45 ms | 7.30 ms |

The new July 8 A/B pair isolates two contributors:

| Capture | Mode | FPS median | CPU median | renderDrawCalls | passPostMs | passGpuAwaitMs |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `perf-2026-07-08T23-09-28-141Z.csv` | dressing off | 56.60 | 13.62 ms | 240 | 10.00 ms | 10.70 ms |
| `perf-2026-07-08T23-14-03-823Z.csv` | baseline | 43.40 | 17.87 ms | 239 | 12.20 ms | 13.70 ms |

Interpretation:

- Terrain/global material changes explain the slower no-dressing baseline versus July 5.
- Dressing adds another ~4.25 ms CPU / ~13 FPS loss, mostly in final render/GPU-await, not in `passDressingMs`.
- Draw counts barely change when dressing is enabled, so the dressing regression is material/shader/pass cost more than object-count cost.

## Goals

1. Restore default current-map performance to the July 5 envelope: median `cpuMs <= 11 ms`, `passPostMs <= 7 ms`, median FPS >= 60 on the same hardware/camera route.
2. Keep terrain visual quality scalable: close terrain may use richer materials, but distant/flat terrain must not pay the full splat shader cost.
3. Keep dressing visually rich where it matters: boulders can be detailed, but dense scree/deadfall/mushrooms must use cheaper tiers.
4. Make future regressions diagnosable through perf CSV fields and URL flags.

## Non-Goals

- Do not redesign terrain generation or authored map format.
- Do not remove terrain splat texturing or dressing entirely.
- Do not introduce a bundler or engine rewrite.
- Do not optimize unrelated systems like ClaudeCraft mobs, audio, or multiplayer in this pass.

## Current Problems

### P1: Terrain Splat Shader Is Always Full Cost

`terrain-textures.js` builds a single `MeshStandardNodeMaterial` for the authored map. The current map resolves to six active layers:

`grass, forest, dirt, sand, beach, rock`

For every terrain fragment, the shader loops over all active layers and does:

- triplanar albedo sample: 3 texture-array reads
- planar normal/AO sample: 1 texture-array read
- per-layer roughness and normal blend
- macro hash
- moss hash and moss blend

This happens even on flat terrain and even when interpolated layer weights are zero or effectively zero.

Relevant code:

- `terrain-textures.js:553-564` layer loop
- `terrain-textures.js:542-546` triplanar sample
- `terrain-textures.js:571-581` moss/normal material finalization

### P2: Scree Uses Boulder-Grade Rock Material

All rock groups, including dense scree, call `buildRockMaterial()`.

That material performs triplanar albedo, triplanar roughness, triplanar normal, moss, lichen hash noise, and several blends. This is acceptable for large nearby boulders, but wasteful for tiny dense stones.

Relevant code:

- `environment-viewer.html:3697-3712`
- `rocks.js:172-231`

### P3: Dressing GPU Host Uses Per-Group Kernels

`createDressingGPU()` creates separate source/draw/count/atomic/indirect state per group and submits `reset`, `cull`, and `finalize` kernels for each group every dirty/camera-moved update.

This is a convenient abstraction but not a scalable GPU design. It increases compute pass count and CPU submission overhead as group count grows.

Relevant code:

- `dressing-gpu.js:88-124`
- `dressing-gpu.js:246-248`

### P4: Dressing Culling Is Radial Only

Dressing compute culling checks distance from camera, not frustum or view cone. Mesh-level frustum culling is disabled because each group is an indirect draw with a broad moving instance set.

This means many instances behind the player or outside the view can survive and feed render/shadow work.

Relevant code:

- `dressing-gpu.js:109-113`
- `dressing-gpu.js:164`

### P5: Double-Sided Deadfall Is a Workaround for Wrong Winding

Deadwood and mushrooms use `THREE.DoubleSide` because the geometry winding is inverted or because some sheets need two-sided rendering. This makes closed logs/stumps more expensive than they should be.

Relevant code:

- `deadfall.js:354-362`
- `deadfall.js:405-407`

### P6: Dressing Placement Still Runs Main-Thread Work

Dressing chunk generation is budgeted but still synchronous inside the frame. It calls CPU height/surface/canopy sampling and generates records on the main thread.

This is more likely to cause movement hitches than the stationary baseline regression, but it should be addressed after render cost is under control.

Relevant code:

- `environment-viewer.html:3878-3898`
- `rocks-placement.js:14-22`
- `deadfall-placement.js`

### P7: Missing Perf Controls

There is no current URL flag to force legacy terrain texturing. Dressing stats are not logged with draw/group/instance counts. This slows diagnosis.

Relevant code:

- `terrain-loader.js:144-150`
- `environment-viewer.html:1555-1565`

## Design

### Milestone 0: Instrumentation and A/B Flags

Add minimal controls before changing rendering behavior.

#### URL Flags

- `?terrainTexture=splat` default current behavior.
- `?terrainTexture=legacy` force `applyTerrainTextures(..., { legacySplit: true })`.
- `?terrainTexture=flat` optional diagnostic: skip authored texture material and use a cheap standard material.
- Keep existing `?dressing=off`.

#### Perf CSV Fields

Add:

- `terrainTextureMode`
- `terrainActiveSplatLayers`
- `terrainTextureMeshes`
- `dressingDraws`
- `dressingGroups`
- `dressingInstances`
- `dressingMode`

#### Acceptance

Run four 60s captures on the same current map/camera route:

1. `?perf=on&dressing=off&terrainTexture=splat`
2. `?perf=on&dressing=off&terrainTexture=legacy`
3. `?perf=on&dressing=gpu&terrainTexture=splat`
4. `?perf=on&dressing=gpu&terrainTexture=legacy`

This establishes the exact terrain/dressing split.

### Milestone 1: Cheap Scree Material

Split rock material tiers:

- `buildBoulderMaterial()`: current rich material, but only for large boulder groups.
- `buildScreeMaterial()`: cheap material for scree.

`buildScreeMaterial()` should:

- Use flat color or one albedo sample, not triplanar.
- Disable normal map by default.
- Disable lichen noise.
- Use constant roughness or one roughness scalar.
- Keep receive shadows only if visual value justifies it.

Wire scree groups in `environment-viewer.html` to `buildScreeMaterial()` when `t.scree`.

#### Expected Effect

Baseline with dressing on should recover a large part of the `passPostMs` delta between no-dressing and baseline.

#### Acceptance

Compared with current baseline:

- `cpuMs` median improves by >= 1.5 ms.
- `passPostMs` median improves by >= 1.0 ms.
- Visual: scree still reads as ground scatter at normal walking height.

### Milestone 2: Fix Deadfall Winding and Reduce DoubleSide

Fix `Grower` triangle/quad winding so closed logs and stumps render correctly with `FrontSide`.

Then split materials/geometry where needed:

- Logs/stumps: `FrontSide`.
- Shelf fungus and gill discs: either separate small DoubleSide submesh/group or keep DoubleSide only for mushroom groups.

Avoid a blanket `DoubleSide` material for all deadwood.

#### Acceptance

- Logs/stumps render correctly from outside.
- No visible inside-out artifacts.
- `passPostMs` and/or GPU render time improves in dressing-on baseline.

### Milestone 3: Terrain Splat Cost Reduction

The current splat shader must stop paying six-layer full triplanar cost on every pixel.

Implement in order:

#### 3A: Skip Zero-Weight Layers at Material Construction

If active layer count is six but a mesh/terrain section only uses fewer layers, build separate materials per active-layer subset. For authored terrain meshes, classify layer use per mesh from baked weights and assign a smaller material when possible.

Target:

- Flat grass/forest sections should not compile six-layer cliff/beach/rock code.

#### 3B: Triplanar Only for Slope-Relevant Layers

Use planar sampling for normal flat ground. Apply triplanar albedo only when it actually matters:

- rock
- dirt/gravel on steep slopes
- optionally snow on steep peaks

Grass/forest/meadow/sand/beach should use planar sampling by default.

This changes the layer-loop cost from 4 texture samples/layer to usually 2 samples/layer, with triplanar only on a minority of layers.

#### 3C: Top-K Runtime Cap

The bake already keeps top-4 vertex weights, but the shader still loops over `activeLayers.length`. Add a material option:

- `maxShaderLayers=4` default
- `maxShaderLayers=6` visual/debug

If six active layers exist, make the map choose the four dominant layers unless the user explicitly requests full quality.

#### 3D: Cheap Distant Terrain

If authored map terrain is large, split terrain meshes or use distance/material LOD:

- near: splat material
- far: baked/legacy/simple material

This can be coarse and camera-centered. The goal is to avoid full splat shader work outside inspection distance.

#### Acceptance

With dressing off:

- Current map `terrainTexture=splat` returns near July 5 envelope: `cpuMs <= 11.5 ms`, `passPostMs <= 7.5 ms`.
- If visual quality changes are noticeable, expose `?terrainTextureQuality=full` to compare.

### Milestone 4: Dressing Compute Host Consolidation

Replace per-group compute dispatch with a packed-group design.

#### Current

For each group:

- one source buffer
- one draw buffer
- one count buffer
- one atomic survivor buffer
- one indirect buffer
- reset/cull/finalize kernels

#### Target

Use:

- one packed source buffer for all records
- one packed draw buffer or per-group ranges in one buffer
- one group metadata buffer: `{ srcOffset, srcCount, drawOffset, cap, cullRadius, cullStart }`
- one survivor count array
- one indirect args array
- one reset kernel over groups
- one cull kernel over all records
- one finalize kernel over groups

Keep public API stable:

- `setChunk`
- `clearChunk`
- `setChunks`
- `setGroupCull`
- `stats`

#### Acceptance

- `computeFrameCalls` does not scale with dressing group count.
- Dressing update remains correct when moving camera and streaming chunks.
- No increase in render draws or visual popping.

### Milestone 5: Frustum/Cone Culling for Dressing

Add camera-oriented culling before indirect draw count is finalized.

Simpler first pass:

- send camera forward/right vectors and FOV cosine to compute shader.
- reject instances behind camera or outside an expanded cone.
- keep radial culling as existing distance limit.

Do not be too aggressive: use a wide cone and padding to avoid visible popping.

#### Acceptance

- Looking away from dense scree/deadfall reduces surviving instances and render time.
- No obvious popping at screen edge.

### Milestone 6: Workerize Dressing Placement

Move chunk record generation out of the frame:

- Worker input: chunk descriptors, params snapshot, map surface/height data or compact sampled grids.
- Worker output: records + collision circles.
- Main thread only calls `dressingGPU.setChunks()` with ready batches.

If full worker migration is too much, first cache generated chunk records by `(chunkKey, paramsHash, mapKey)` and avoid recomputation when revisiting chunks.

#### Acceptance

- Movement captures show reduced `cpuMs` p90 and fewer frame hitches.
- Stationary median may not change much; this is a hitch fix.

## Recommended Implementation Order

1. Milestone 0: instrumentation and A/B flags.
2. Milestone 1: cheap scree material.
3. Milestone 3B + 3C: reduce terrain splat shader work.
4. Milestone 2: fix deadfall winding / remove blanket DoubleSide.
5. Milestone 5: dressing frustum/cone culling.
6. Milestone 4: packed dressing compute host.
7. Milestone 6: worker/cache placement.

This order front-loads the biggest, lowest-risk wins and keeps every step measurable.

## Verification Matrix

For each milestone, record these captures:

- Stationary: 60s, same camera pose.
- Slow pan: 60s, same route.
- Walk: 60s through dense terrain/dressing.

Required CSV columns:

- `fps`
- `cpuMs`
- `renderDrawCalls`
- `triangles`
- `computeFrameCalls`
- `passTerrainWindowMs`
- `passDressingMs`
- `passPostMs`
- `passGpuAwaitMs`
- `waterReflectionLastMs`
- `dressingDraws`
- `dressingGroups`
- `dressingInstances`
- `terrainTextureMode`
- `terrainActiveSplatLayers`

Regression gates:

- Stationary median `cpuMs` must not increase by more than 0.5 ms from the previous milestone.
- p90 `cpuMs` must not increase by more than 1.0 ms unless visual quality is explicitly increased.
- `renderDrawCalls` must not grow without a documented reason.

## Risks

- Terrain material simplification can cause visible seams or loss of cliff detail.
- Scree cheap material may look flat up close if boulder/scree classification is wrong.
- Frustum/cone culling can pop if bounds are too tight.
- Packed dressing compute host is higher risk than material-tier fixes; defer until cheap tiers and terrain reductions are validated.

## Open Questions

1. Should terrain quality default to performance or full visual fidelity on authored maps?
2. Should scree be allowed to cast/receive shadows, or is ambient shading enough?
3. Can terrain meshes be split spatially enough to support near/far material LOD without re-exporting maps?
4. Is the water reflection path still rendering dressing detail meshes, or are all dressing meshes excluded as intended?
