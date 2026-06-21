# SP3 — GPU-driven CDLOD terrain · Design Spec

**Date:** 2026-06-21
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** approved direction; this spec records the decisions for review.

## Goal

Replace the per-chunk, CPU-built **visual** terrain ground with a fully GPU-driven CDLOD
renderer: a camera-snapped, Morton-keyed quadtree whose visible nodes + LOD levels are
selected entirely on the GPU by a compute pass, emitted via `atomicAdd` into an instance
list, and drawn with a single `drawIndexedIndirect` of one reusable grid. Height and
normals come from the analytic terrain field transcribed to TSL (reusing the SP2 parity
port). Continuous CDLOD vertex morphing makes LOD seams crack-free.

This is the §4.4 endpoint of the synthesis paper, adapted to WebGPU's lack of tessellation.

## Gate (success criteria)

1. Terrain **draw-call and triangle cost roughly constant vs draw distance** — a dd9 trace
   showing terrain cost flat from view distance "4" through "12" (vs the chunked path,
   whose cost grows with draw-distance²).
2. **No cracks and no popping** across LOD seams (continuous morphing).
3. **Collision still served by the analytic height field** (`terrainHeightAt`), unchanged.
4. Terrain **CPU frame-time contribution drops** (our SP1/SP2 metric `cpuMs`): visual chunk
   building is eliminated; only a small collider ring + lightweight chunk records remain.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Ambition | **Full GPU-driven CDLOD** (paper-faithful §4.4) |
| 2 | Height source | **Analytic field in TSL** (reuse SP2 port); normals from analytic `terrainNormalAt` in TSL |
| 3 | Quadtree anchoring | **Camera-snapped root** (hybrid): research's Morton quadtree + producer/consumer *intent*, rooted at a camera-snapped origin so infinite roam is preserved |
| 4 | Selection mechanism | **Flattened distance-band evaluation** (equivalent to producer/consumer, far lower risk): one thread per candidate node, independent LOD-band test, emit via `atomicAdd`→indirect |
| 5 | Seams | **Continuous CDLOD vertex morphing** (no skirts) |
| 6 | Integration | New `cdlod-terrain.js` owns GPU ground; `TerrainSystem` gains `external` visual mode (records + colliders only); behind `?terrain=gpu\|chunks` flag |

### Why flattened selection is faithful enough

Everything §4.4's *thesis* requires — GPU-resident selection, zero CPU traversal, no
per-frame CPU↔GPU transfer of survivors, flat cost vs draw distance — is delivered by the
flattened evaluation. The producer/consumer FIFO queue is an implementation optimization
for deep/large trees; for our modest camera-centered depth (~6–8 levels) a per-node band
test is simpler, equally GPU-resident, and reuses the proven SP2 `atomicAdd`→indirect
chain. The substitution is documented in the migration notes (mirroring the
tessellation→vertex-displacement substitution the paper itself prescribes).

## CDLOD model

### Reusable grid

One indexed grid of `PATCH_QUADS × PATCH_QUADS` cells (default `PATCH_QUADS = 16` →
17×17 = 289 vertices, 512 triangles). Vertex positions are unit grid coords in `[0,1]²`.
The grid is drawn `instanceCount` = number of selected nodes via `drawIndexedIndirect`.

### Levels and node sizes

- `LEAF_SIZE` = world size of a level-0 (finest) node (default `16` units).
- Node world size at level `L` = `LEAF_SIZE * 2^L`.
- `LEVELS` = number of LOD levels (default `7` → finest 16 u, coarsest 16·2⁶ = 1024 u).
  Increasing `LEVELS` increases draw distance while adding only one bounded outer ring per
  level (≈ flat cost — this is the gate).

### LOD ranges (distance bands)

- `range[L]` = outer distance at which level `L` is the selected LOD.
- Geometric, **node-size based**: `range[L] = LEAF_SIZE * 2^L * LOD_SCALE` (default
  `LOD_SCALE = 2.5`). With this, a grid cell's angular size at its selection distance is
  `(nodeSize/PATCH_QUADS)/(nodeSize·LOD_SCALE) = 1/(PATCH_QUADS·LOD_SCALE)` — **constant
  across all levels**, so screen-space triangle density is uniform. `PATCH_QUADS` controls
  density; `LOD_SCALE` controls transition distances; the two are independent.
- A node at level `L` covering cell center `c` with min-distance-to-camera `d` is **selected**
  iff `d > range[L-1]` (too far for the finer level) **and** `d ≤ range[L]` (within this
  level's band). Level 0: selected iff `d ≤ range[0]`. Coarsest level: selected iff
  `d > range[LEVELS-2]` (clamped to overall view distance).
- Because the ranges are nested, every point in the plane falls inside **exactly one**
  selected node — coverage is a partition (no gaps, no overlaps). This is unit-tested.

### Candidate enumeration (bounded → the gate)

For each level `L`, candidates are the node-cells (size `LEAF_SIZE·2^L`) inside a fixed
`WINDOW_CELLS × WINDOW_CELLS` window around the camera-snapped center, sized to cover
`range[L]`. Since the window must span `±range[L]` in cells of size `LEAF_SIZE·2^L`, its
half-width in cells is `range[L]/(LEAF_SIZE·2^L) = LOD_SCALE` — **constant across levels**,
so `WINDOW_CELLS = ceil(2·LOD_SCALE) + 2` (default `8` for `LOD_SCALE = 2.5`), independent
of both draw distance and `PATCH_QUADS`. Total candidates `= LEVELS × WINDOW_CELLS²` (default
`7 × 64 = 448`); survivors are the CDLOD partition annuli. Adding draw distance = adding one
level = one more bounded ring, so cost grows with `log₂(distance)` — effectively flat. Camera-snapping: the per-level window center is snapped to that level's
cell size so node boundaries are stable frame-to-frame (no shimmer), the same discipline
SP2 grass used.

### Morphing (crack-free)

Standard CDLOD morph. For a selected node at level `L` with min-distance `d`:
`morphK = clamp((d - MORPH_START·range[L]) / ((1 - MORPH_START)·range[L]), 0, 1)`
(default `MORPH_START = 0.6`). In the vertex stage the grid coord is snapped toward the
even-vertex (parent) lattice by `morphK`, so as a node approaches its outer band its
boundary vertices coincide with the coarser parent level's vertices → heights match exactly
→ no cracks. Height is then sampled at the morphed world position. Continuity at the
boundary (morphed child vertices = parent vertices) is unit-tested against the JS field ref.

## Components / files

### `cdlod-select.js` (NEW, pure JS — no three.js)
- `mortonKey(level, ix, iz)` / `decodeMorton(key)` — 32-bit-half Z-order keys + level marker
  bit (mirrors the research's linear-quadtree encoding; used by the GPU buffer layout and
  testable in isolation).
- `levelRanges(cfg)` → `Float32Array` of `range[L]`.
- `selectNodes(cfg, camX, camZ)` → array of `{level, ix, iz, originX, originZ, size, d, morphK}`
  by running the flattened band test over each level's snapped window. This is the CPU
  reference the TSL compute transcribes, and the source of truth for the coverage/bounded/
  morph tests.
- `nodeCountForViewDistance(cfg, viewDist)` — helper used by the gate test.

### `cdlod-field.js` (REUSE `grass-height-ref.js`)
Already an exact JS re-derivation of `terrainHeightAt`. The selection min-distance test is
purely planar (XZ), so height is only needed for displacement, not selection. Reused as the
parity target for the morph-continuity test and the TSL transcription.

### `cdlod-terrain.js` (NEW, GPU/TSL — mirrors `grass-compute.js`)
`createCdlodTerrain({ renderer, camera, terrainParams, waterLevel, leafSize, levels, patchQuads, lodScale })`:
- Builds the reusable `PATCH_QUADS` grid `BufferGeometry`.
- Storage buffers: `inst` (per-node `originX, originZ, size, level, morphLo, morphHi, …` packed
  as vec4×N, `CAP = LEVELS × WINDOW_CELLS²`), atomic `counter`, `indirectAttr` `[indexCount,0,0,0,0]`.
- Compute kernels (TSL): `reset` (atomicStore counter 0); `select` (one thread per candidate
  across all levels' windows; decompose `instanceIndex` with `modInt`/int-division into
  `(level, cellX, cellZ)`; compute snapped node origin, min-distance, band test; on pass,
  `atomicAdd(counter,1)` and write the node's instance record); `finalize`
  (`indirect.element(1).assign(atomicLoad(counter))`).
- Node material (`MeshStandardNodeMaterial`): vertex stage reads the per-instance node
  record, applies CDLOD morph to the grid coord, maps to world XZ, samples analytic height +
  normal in TSL (transcribed field, bit-matching `grass-height-ref`), displaces.
- `async update(camera)` — awaits the 3 `computeAsync` passes before the draw (the SP2
  flicker fix). Exposes `mesh`, `setTerrain`, `setWaterLevel`, `setViewDistance` (adjusts
  `levels`), `dispose`, plus `drawCount`/`triangleCount` getters for the HUD/gate.

### `terrain-system.js` (MODIFY — add `external` visual mode)
- New param `visualMode: 'mesh' | 'external'` (default `'mesh'`).
- `'external'`: `makeChunk`/`chunkFromArrays` produce a **record without visual geometry**
  (no `THREE.Mesh`/positions); chunks are still tracked, `activeChunks` still populated across
  `renderRadius`, colliders still built within `collisionRadius`, `getHeight` unchanged. The
  visual chunk geometry build (the expensive part) is skipped. `materialPatchTarget` returns
  `null` in this mode (host points `ground` at the CDLOD mesh).
- No behavior change in `'mesh'` mode (the `?terrain=chunks` fallback path is byte-for-byte
  the current renderer).

### `environment-viewer.html` (MODIFY)
- `TERRAIN_MODE = new URLSearchParams(location.search).get('terrain') || 'gpu'`.
- `'gpu'`: construct `TerrainSystem` with `visualMode:'external'`; `import('./cdlod-terrain.js')`,
  add its mesh as the ground; `ground = cdlodRef.mesh`; far-plane from CDLOD coarsest extent.
  `animate()` already async — `await cdlodRef.update(camera)` before `renderer.render`.
- `'chunks'`: current behavior (fallback / dd9 A/B baseline).
- View-distance slider drives `cdlodRef.setViewDistance(...)` (level count). `rebuildWorld`
  pushes `setTerrain`/`setWaterLevel` (mirrors grass).
- HUD + perfLog gain terrain `drawCount` / `triangleCount` for the dd9 gate.

## Testing

**Node logic tests (pre-GPU, the SP2 discipline):**
- `test-cdlod-morton.mjs` — `mortonKey`/`decodeMorton` round-trip; level marker bit.
- `test-cdlod-select.mjs` —
  - **Coverage partition:** sample a dense grid of XZ points around the camera; every point
    is inside exactly one selected node (no gaps, no overlaps).
  - **Bounded cost (the gate, on CPU):** node count grows ≤ `LEVELS × WINDOW_CELLS²` and is
    flat as `viewDistance` doubles beyond the first few levels.
  - **Snapping stability:** moving the camera by < one leaf cell does not change the coarse
    nodes' origins (no shimmer).
- `test-cdlod-morph.mjs` — at a node's outer band (`morphK → 1`), morphed boundary vertices
  coincide with the parent level's vertices, so sampled heights agree within tolerance with
  the parent node along the shared edge (crack-free), checked against `grass-height-ref`.

**Browser checkpoints:** visual parity vs chunked path; no cracks while flying; HUD terrain
draw count stays ~1 indirect draw and triangle count stays bounded while raising view
distance. **dd9 A/B:** `?terrain=gpu` vs `?terrain=chunks` traces → synthesis paper + notes.

## Out of scope
- The literal double-buffered producer/consumer FIFO queue (substituted by flattened
  selection — see Decision 4; documented in migration notes).
- Changing decoration/grass/water systems (they keep using `activeChunks` + `getHeight`).
- Removing the `?terrain=chunks` fallback (kept for the dd9 A/B and as a safety net, like
  `?grass=cpu`).
- Frustum culling in selection (distance selection is sufficient for the gate, as SP2 found;
  may be added later if outer rings prove wasteful).
