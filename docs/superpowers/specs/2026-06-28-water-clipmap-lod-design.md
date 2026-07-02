# Water Clipmap LOD Design

**Date:** 2026-06-28
**Status:** Approved

## Problem

The current water system uses terrain chunks to partition the water surface — the same streaming grid that the terrain uses. For an authored map with a fixed extent and a single sea level, this is the wrong model:

- The entire water body is known at load time; there is nothing to stream
- Chunk boundaries create arbitrary geometry seams across a continuous water plane
- All chunks render at the same mesh density regardless of camera distance — wasteful far away, under-detailed for caustics close up

The fix is to model water the same way trees are modelled: fixed placement, distance-based detail. For water, that means a camera-following clipmap — three concentric rings at decreasing mesh density — instead of a terrain-chunk grid.

## Architecture: Three Concentric Camera-Following Rings

Three `THREE.Mesh` objects share the same `surfaceMat` and `causticMat` (unchanged). Each ring is a square grid clipped to an annular zone centered on the camera's snapped XZ position.

| Ring | Inner bound | Outer bound | Cell size | Snap step |
|------|-------------|-------------|-----------|-----------|
| 0 near | 0 | `lodR0` (default 40 m) | `cellS0` (default 1 m) | `cellS0 × 4` |
| 1 mid | `lodR0` | `lodR1` (default 120 m) | `cellS1` (default 4 m) | `cellS1 × 4` |
| 2 far | `lodR1` | map extent (or `size` fallback) | `cellS2` (default 16 m) | `cellS2 × 4` |

**Annular clipping:** ring N's geometry builder skips any quad whose center falls inside ring N-1's outer square. This is the same technique already used to skip dry quads (quads above water level). No stitching geometry is needed — the overlap is avoided by exclusion.

**Map extent clipping:** ring 2 (far) is clipped to the authored map bounds (`extentX × extentZ`). Quads outside the boundary are skipped in the geometry builder, same as dry quads.

**Fallback (no authored map):** when `extentX`/`extentZ` are absent, the outer ring extends to `size` (existing behaviour), giving backwards compatibility with the procedural terrain path.

## Camera Snap and Rebuild Trigger

Each ring tracks `snapX, snapZ` — the camera XZ position at the time its geometry was last built, rounded to the ring's snap step.

In `update(time)`:
1. Read `camera.position.x / .z`
2. For each ring N: if `|camX − snapX_N| > snapStep_N` or `|camZ − snapZ_N| > snapStep_N`, mark ring N dirty and push it onto the existing async build queue
3. Ring 0 rebuilds most often (finest snap step, small area — cheap). Ring 2 rebuilds rarely (coarsest snap step, only on large camera moves)

Settings changes (`waterLevel`, `heightFn`, `extentX/Z`) force a full rebuild of all three rings, same as the current `regenerate()` path.

## Changes to `water.js`

### `createWaterSystem` options

- Add: `lodR0` (default 40), `lodR1` (default 120), `cellS0` (default 1), `cellS1` (default 4), `cellS2` (default 16), `extentX`, `extentZ`
- Keep: `size` as fallback when no extent is given; all shader/material options unchanged

### `buildGeometry`

Extended to accept a ring descriptor `{ snapX, snapZ, innerR, outerR, cellSize, extentX, extentZ }` instead of a chunk bounds object. The grid is built over the outer square `[snapX − outerR, snapX + outerR] × [snapZ − outerR, snapZ + outerR]`, skipping quads that:
- fall inside the inner square (annular exclusion)
- fall outside the map extent (boundary clip)
- are fully dry (existing bed-height check)

### Ring management (replaces chunk map)

- `waterRings: Array(3)` — one entry per LOD level, each `{ mesh, causticMesh, geometry, snapX, snapZ } | null`
- `ringDirty: [true, true, true]` — initialized dirty so all three build on first `update()`
- `disposeRing(n)` / `addRing(n, descriptor)` replace `disposeWaterChunk` / `addWaterChunk`
- Build queue entries carry a ring index `n` instead of a chunk key
- World projection for the caustic camera is computed from the union of the three ring bounds (same `getWorldProjection` logic, just over ring extents instead of chunk bounds)

### `update(time)` additions

```
snapCheck(n, camX, camZ):
  step = snapStepForRing(n)
  sx = round(camX / step) * step
  sz = round(camZ / step) * step
  if sx !== ring[n].snapX || sz !== ring[n].snapZ:
    mark ring[n] dirty, enqueue rebuild
```

### `regenerate(opts)`

Drops `opts.chunks`. Accepts `opts.extentX`, `opts.extentZ`. Marks all rings dirty and flushes the queue.

### `getStats()`

Returns `{ ring0Tris, ring1Tris, ring2Tris, ring0Verts, ring1Verts, ring2Verts, version, waterLevel }` instead of chunk/candidate/dry counts.

## Changes to `environment-viewer.html`

### Removed

- `syncWaterChunks()` function
- `waterChunkSignature()` function
- `lastWaterChunkSignature` variable
- All `activeTerrainChunks()`-for-water calls
- `waterChunks`, `waterCandidates`, `waterPending`, `waterDry` debug fields

### Changed

- `waterRef.regenerate(...)` call drops `chunks` argument, adds `extentX: loadedMap.worldX, extentZ: loadedMap.worldZ` when a map is loaded
- Debug overlay: replace chunk/candidate/dry counts with `ring0Tris / ring1Tris / ring2Tris`
- Add two LOD sliders in the terrain panel alongside the existing tree LOD sliders: `waterLodR0` (LOD 0→1 radius) and `waterLodR1` (LOD 1→2 radius), calling `waterRef.setLodDistances(r0, r1)`

### Kept

- All water shader params (wave strength, caustic, reflect/refract strength, etc.)
- `worldRebuild()` still calls `waterRef.regenerate(...)` on terrain settings changes
- `waterRef.update(time)` call in the animation loop (now also drives snap checks)

## Out of Scope

- Multiple discrete water bodies at different heights (future extension — the ring approach generalises naturally by building one clipmap per water body)
- Per-ring caustic toggling (deferred — all rings run the full shader)
- GPU-driven clipmap stitching (Approach B — not needed at this scale)
