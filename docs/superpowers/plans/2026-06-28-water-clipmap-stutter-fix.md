# Water Clipmap Stutter Fix Implementation Plan

**Goal:** Restore the three-ring water clipmap without the `9f96a79` movement
stutter. Implement fixes 1-5 from the design: budgeted ring jobs, cached edge
samples, height sampling outside hot frames, deferred disposal, and a real build
budget.

## Task 1: Replace Blocking Ring Builds With Jobs

- [x] Add an interruptible ring geometry job in `water.js`.
- [x] Process vertex rows and index rows until `buildBudgetMs` expires.
- [x] Keep the old ring visible while the new ring job is pending.
- [x] Swap the mesh only after the replacement geometry is complete.

## Task 2: Cache Height Samples Across Ring Snaps

- [x] Add one height cache per ring cell size.
- [x] Key samples by integer cell coordinates and reuse them across snaps.
- [x] Track cache hits and misses in water stats.
- [x] Clear caches when the terrain height source or extent changes.

## Task 3: Stop Viewer-Driven Regeneration On Chunk Movement

- [x] Stop passing terrain chunks to water.
- [x] Make `syncWaterChunks()` a water-input sync wrapper for compatibility.
- [x] Call `regenerate()` only when size, water level, height function, extent,
  or LOD settings actually change.

## Task 4: Defer Old Geometry Disposal

- [x] Remove replaced meshes immediately.
- [x] Queue replaced geometries for delayed disposal.
- [x] Drain the disposal queue from `update()`.
- [x] Preserve immediate disposal when the whole water system is destroyed.

## Task 5: Expose Diagnostics And Validate

- [x] Report ring triangle/vertex counts, pending jobs, cache hits/misses, and
  last build milliseconds.
- [x] Update the HUD and perf CSV fields for clipmap ring stats.
- [x] Add water LOD sliders back to the viewer.
- [x] Run syntax checks and inspect the git diff before committing.
