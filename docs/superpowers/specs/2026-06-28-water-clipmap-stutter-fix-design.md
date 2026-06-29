# Water Clipmap Stutter Fix Design

**Date:** 2026-06-28
**Status:** Approved

## Problem

Commit `9f96a79` replaced water chunks with three camera-following clipmap
rings. The visual model is right for authored maps, but the first version can
stutter because each snap can synchronously rebuild a whole ring:

- it samples terrain height for every ring vertex in one frame
- it allocates new position, depth, and index buffers in one frame
- it disposes the previous geometry immediately
- the viewer may still ask water to regenerate because terrain chunks moved
- `buildBudgetMs` only limits additional builds after the first build already
  happened

The fix keeps the three-ring clipmap, but makes ring movement incremental and
cache-backed so camera motion never has to pay for a complete ring rebuild in a
single update.

## 1. No Blocking Whole-Ring Rebuild On Movement

Each dirty ring becomes a small build job. A job owns its typed arrays and
row/index cursor, and advances only until the current frame budget expires.
The old ring remains visible until the replacement job finishes, then the mesh
swap happens once.

The system may still produce a full replacement geometry, but never by running
the whole generation loop in one movement frame.

## 2. Reuse Edge Samples Across Snaps

The clipmap snap distance is a multiple of each ring cell size. When the camera
moves by one snap, most grid sample locations overlap the previous ring. A
per-cell-size height cache stores sampled terrain heights by integer grid
coordinate, so only newly exposed rows and columns call the expensive
`heightFn`.

This provides the practical edge-strip benefit without requiring in-place
index-buffer mutation in the first pass.

## 3. Move Height Sampling Out Of Hot Frames

Height sampling happens inside the same budgeted ring job as vertex filling.
For authored maps where `heightFn` can raycast against map collision, cache hits
avoid repeat raycasts and cache misses are spread across frames.

The cache is invalidated only when water-level-independent terrain inputs
change: `heightFn`, map extent, or size. Water-level changes keep the sampled
bed heights and rebuild depth/index data from the cache.

## 4. Defer Old Geometry Disposal

Ring replacement removes old meshes from their groups immediately, but queues
old geometries for disposal after several update ticks. This avoids freeing GPU
buffers in the same frame they were recently rendered or replaced.

Full `dispose()` still releases everything immediately because the water system
is being torn down.

## 5. Real Build Budget

`buildBudgetMs` becomes a hard per-frame time slice for build work. The queue
checks the deadline before and during row/index processing. If time expires,
the job resumes next update. `maxBuildsPerFrame` limits completed swaps, not
the amount of unbounded synchronous work.

Stats expose the current pending jobs, cache hits/misses, and last build time
so perf captures can show whether stutter came from water generation.

## Viewer Contract

The viewer no longer drives water from terrain chunk signatures. Water follows
the camera internally. Viewer code calls `regenerate()` only for real water
inputs: size, water level, height function, map extent, or LOD distance changes.

Debug output switches from chunk counts to ring triangle counts and pending
ring jobs.

## Non-Goals

- In-place GPU buffer scrolling for ring edge strips.
- Shader-side terrain height texture sampling for water depth.
- Reflection or caustic throttling. Those remain useful future optimizations,
  but they are separate from the clipmap rebuild stutter.
