# SP6 — GPU-instanced forest (+ worker-baked unique), toggleable · Design Spec

**Date:** 2026-06-23
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped (design approved; not yet planned/implemented).
**Sequencing:** after SP5 (collision). With the octree retired (SP5a), the **per-chunk baked
forest is the single remaining subsystem whose cost scales with draw distance** — the paper names
it explicitly (§1, §7, and the SP3 callout: trees + the old octree were the residual ~25–40 ms).
This SP closes that last "still scales" caveat.

## Problem

The forest is baked **per terrain chunk on the main thread**. For each tree, the procedural
generator (`createTree`/`gen.regenerate`) builds a **unique** branches+leaves+shadow mesh, which is
merged (`appendGeom`) into three per-chunk buffers and committed (`commitMerged`) as three meshes.
Baking is time-sliced (3 ms/frame in `processTreeQueue`) but still:

1. **CPU cost scales with tree count** — generating + merging unique geometry per tree is the
   dominant residual CPU item now that the octree is gone (the SP3 trace's ~25–40 ms).
2. **Draws scale with chunk count** — 3 draws per non-empty chunk (branches/leaves/leafShadows).
3. **Triangles scale with the rendered area**, not a bounded window.

Grass (SP2) and terrain (SP3) already solved the analogous problem by moving generation/culling to
the GPU and collapsing draws via indirect draw. The forest is the same shape of problem.

## Goal

Replace the main-thread baked forest with **two selectable implementations**, chosen by a URL flag,
both sharing the existing placement logic and chunk lifecycle:

| `?forest=` | path | trees | cost shape | role |
|---|---|---|---|---|
| `gpu` (default) | GPU-instanced palette | repeat from a palette | flat vs draw distance | the win |
| `worker` | Web-worker baked | unique per tree | per-chunk, but off main thread | A/B baseline; preserves uniqueness |

The two paths together provide the **dd9 A/B perf trace** that gates every subsystem here.

## Section 1 — Overall structure & the flag

`FOREST_MODE = new URLSearchParams(location.search).get('forest') || 'gpu'`, mirroring
`?grass`/`?terrain`/`?lights`. The current main-thread baking is **removed**; both new paths replace
it. They share, unchanged:
- **Placement** (`placementsForChunk`): ring/clustered/scattered/uniform modes, dry-land/water mask,
  per-chunk deterministic RNG, and species selection — this is cheap (positions only) and stays CPU.
- **Chunk lifecycle**: the existing `regenerate()` flow keyed off `terrainSystem.activeChunks`, with
  per-chunk load (commit) and unload (dispose) hooks.

Only what happens *after* placement differs. The refactor that makes both paths clean is to extract
a single **placement-record** step that yields, per tree, `{x, z, scale, yaw, speciesIdx,
variantIdx}` — separating placement (shared) from geometry (path-specific). This record is also what
SP5b's trunk registration consumes (`{x, z, r = 1.2·scale}`), so trunk collision keeps working in
both paths.

## Section 2 — GPU-instanced palette path (`?forest=gpu`)

**Key decision: placement stays on the CPU; only geometry becomes instanced.** The expensive thing
today is per-tree geometry generation+merge, not placement. So:

- **Palette baked once at startup.** For each species, generate `VARIANTS_PER_SPECIES` (default 8)
  fixed tree geometries via the existing `createTree` generator — branches, leaves, shadow — with
  per-variant seeds. Total generator calls = species × 8 (a fixed startup cost), not per-tree. Bark
  and leaf colors are baked into each variant's vertex colors (per-instance tint is deferred, §4).
- **Global instance buffers, updated on chunk change only.** CPU placement produces instance records
  appended into per-variant instance arrays `{x, y(=terrainHeight+offset), z, scale, yaw}`. These are
  uploaded to GPU storage buffers when chunks load/unload (infrequent), **never per frame** — this
  is the SP2 caveat (avoid per-frame instance re-uploads that re-introduce a CPU↔GPU stall).
- **Per-frame GPU compute cull → indirect draw.** A compute pass tests each instance (frustum +
  distance) and `atomicAdd`s survivors into a compacted per-variant draw list, writing
  `drawIndexedIndirect` args. Each variant draws its survivors with one indirect instanced draw per
  mesh-type: ≈ `VARIANTS × {branches, leaves, shadow}` ≈ 24 draws, **flat regardless of chunk
  count**. Per-fragment/triangle cost tracks the culled (camera-window) set, not the global forest.

This is the SP2/SP3 spine (compute → atomic compact → indirect draw) reused. Cull math is
Node-testable first (the `light-cluster.js`/`cdlod-select.js` pattern).

**Rejected alternative — placement in compute (like grass).** Would require porting the four
placement modes + water mask + per-chunk RNG to TSL for little gain (placement is already cheap).
Reusing CPU placement is lower-risk and keeps the variety logic in one place.

**Repetition mitigation:** N variants × continuous scale × random yaw × species mix; the existing
distance fog further hides palette repeats. Accepted as "equivalent, not identical" (the SP2 bar).

## Section 3 — Worker path (`?forest=worker`)

Move the existing baking off the main thread, mirroring `terrain-worker.js`:
- A `forest-worker.js` receives a chunk's placement records + tree/species params, runs the
  `createTree` generator and the `appendGeom` merge **in the worker**, and returns merged
  branch/leaf/shadow geometry arrays (positions/normals/colors/uvs/indices) as **transferables**.
- The main thread wraps them in `BufferGeometry` and commits the three meshes (the existing
  `commitTreeChunk` tail), keyed by chunk, disposed on unload.
- Every tree stays **unique**; the main-thread spike disappears; draws/triangles still scale per
  chunk — the honest tradeoff vs the GPU path, and the reason both exist.

Requires the tree generator (`trees.js`) and `appendGeom` to run without the main-thread `THREE`
scene (geometry-array output only, as the terrain worker already does for terrain). If `trees.js`
has hard `three` mesh dependencies, the worker builds plain typed arrays the same way
`terrain-field.js`/`buildChunkArrays` do for terrain. File:// (no worker) falls back to synchronous
main-thread baking, as terrain does.

## Section 4 — Deferred (YAGNI)

- **Impostor / billboard LOD** for distant trees (the biggest further triangle win) — deferred, like
  SP3's GTAO. The cull window already bounds cost; impostors are a v2 multiplier.
- **Per-instance color/tint variation** in the GPU path — variety comes from variants × transform
  for v1.
- **Live UI toggle** between paths — the URL flag is the v1 mechanism (matches the rest of the app);
  a runtime dropdown can come later.

## Components / files

### GPU path (new)
- `forest-palette.js` (NEW) — bake the per-species variant geometries once; expose variant
  branch/leaf/shadow geometries + the two node materials. Pure-ish (uses the generator), browser.
- `forest-instances.js` (NEW) — maintain the global per-variant instance buffers from CPU placement
  records; `setChunk(key, records)` / `clearChunk(key)`; own the GPU storage buffers.
- `forest-cull.js` (NEW, Node-testable twin) — the per-instance frustum+distance cull math (the
  `light-cluster.js`/`cdlod-select.js` pattern): a pure JS reference + the TSL compute that matches
  it.
- `forest-gpu.js` (NEW) — wires palette + instances + cull into per-variant indirect draws; the
  `?forest=gpu` system object (`update(camera)`, `setChunk`/`clearChunk`, stats).

### Worker path (new)
- `forest-worker.js` (NEW) — off-thread generate+merge → transferable geometry arrays (mirrors
  `terrain-worker.js`).
- Possibly `forest-bake.js` (NEW) — the pure generate+merge used by both the worker and the
  file:// synchronous fallback (mirrors `terrain-field.js`/`buildChunkArrays`).

### Shared / viewer (modify)
- `environment-viewer.html` — `FOREST_MODE` flag; extract the **placement-record** step from the
  current `buildNextTreeInJob`; route records to the active path; keep SP5b trunk registration fed
  from records; remove the main-thread per-tree baking; HUD/perf fields (`forestDraws`,
  `forestInstances`) for the dd9 trace.

## Gate (success criteria)

**GPU path:**
1. Forest draw calls **O(1) in chunk count** (≈ variants × mesh-types, flat from dd4 to dd12), not
   3 × non-empty chunks.
2. No main-thread per-chunk geometry baking; no per-frame instance-buffer re-upload (GPU-resident,
   updated only on chunk change).
3. Triangles track the culled camera window, not the rendered area.
4. A dd9 `perfStats` trace showing the forest-dominated CPU wall removed vs the old baked path.
5. Visual: a believably varied forest; trees on dry land, sized/rotated, no obvious tiling at play
   distance.

**Worker path:**
6. Trees remain unique; the **main-thread** baking spike is gone (work is on the worker); draws still
   per-chunk (expected); file:// falls back to synchronous baking.

**Both:**
7. SP5b trunk collision still works (records still register per chunk).
8. Cull/placement math unit-tested in Node before any GPU/worker code (SP2/SP3 discipline).

## Testing

- **Node** (`test-forest-cull.mjs`): frustum+distance cull twin — instances inside the frustum/range
  survive, outside are culled; the compacted survivor count matches; determinism. (Reuse the
  `cdlod-select.js`/`light-cluster.js` test pattern.)
- **Node** (`test-forest-placement.mjs` or extend existing): the extracted placement-record step is
  deterministic and dry-land-masked, and yields stable `{x,z,scale,yaw,speciesIdx,variantIdx}`.
- **Browser checkpoints** (one per GPU module, per the hard constraint): palette renders; instances
  place correctly; cull behaves under camera motion; `?forest=worker` bakes without a main-thread
  spike. Then the dd9 A/B trace (`gpu` vs `worker`), dropped in `research/stats/`.

## Out of scope
- Impostor LOD, per-instance tint, live UI toggle (§4).
- Changing placement *modes* or species definitions (reused as-is).
- Wind animation changes (the existing leaf/branch wind, if any, is ported as-is to the instanced
  materials; no new wind work).

## Build order (recommended)
1. **Shared placement-record extraction** (small refactor; both paths + SP5b depend on it).
2. **GPU path** (`?forest=gpu`) — the priority and the default; the flat-cost win. Node cull twin
   first, then palette → instances → cull → indirect draw, one browser checkpoint per module.
3. **Worker path** (`?forest=worker`) — the unique-tree baseline; mirrors `terrain-worker.js`.
4. **dd9 A/B trace** (`gpu` vs `worker`); fold into notes + paper; sync `workshop/`.

Each path is independently shippable and gets its own implementation plan. The GPU-path plan is
written first.
