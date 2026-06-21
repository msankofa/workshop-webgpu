# SP4a — Clustered (tiled) forward point lighting · Design Spec

**Date:** 2026-06-21
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped; proceeding to plan + implement under the `a→b→c` goal (4a first).
**Part of:** SP4 (lights/effects/post), decomposed into **4a lighting** → 4b particles → 4c post.

## Goal

Render many dynamic point lights (target ≈256) within frame budget by deciding **on the GPU**
which lights affect which screen tile — the canonical "cull on the GPU" pattern that is
infeasible in serial WebGL. A per-frame compute pass bins point lights into a 2D screen-tile
grid (a light-index list per tile in a storage buffer); the shading stage loops only its
tile's lights. This is the SP4 gate's headline ("target dynamic-light count within budget").

## Why hand-rolled

three r0.184 ships no tiled/clustered lighting node (only the base `LightsNode`, which loops
**all** lights per fragment — O(fragments × lights)). That naive loop is precisely the cost we
remove. We build the cluster cull in TSL compute, reusing the SP2/SP3 spine
(`atomicAdd` → storage buffer, awaited `computeAsync` before draw).

## Architecture

### Tile grid (2D screen space)
- Screen divided into `TILE × TILE` px tiles (default `TILE = 16`); `tilesX = ceil(W/TILE)`,
  `tilesY = ceil(H/TILE)`. Recomputed on resize.
- Per-tile capacity `MAX_PER_TILE` (default 64): a tile holds up to that many light indices.

### Buffers (GPU-resident)
- `lightBuf` — `CAP_LIGHTS` × 2×vec4: `(x,y,z,radius)`, `(r,g,b,intensity)`.
- `tileCounts` — `tilesX·tilesY` atomic u32 (lights binned into each tile).
- `tileIndices` — `tilesX·tilesY·MAX_PER_TILE` u32 (the per-tile light-index lists).
- Uniforms: view+projection matrix, screen size, tile size, light count, near/far.

### Compute pipeline (per frame, mirrors SP2/SP3)
1. **reset** — zero `tileCounts` (atomicStore per tile; dispatched over tiles).
2. **bin** — one thread per light: project the light's world-space bounding sphere to screen,
   compute the covered tile AABB `[tileMinX..tileMaxX] × [tileMinY..tileMaxY]` (clipped), and
   for each covered tile `atomicAdd(tileCounts[tile], 1)`; if `< MAX_PER_TILE`, write the light
   index into `tileIndices[tile*MAX_PER_TILE + slot]`. Lights fully behind the camera or with
   zero on-screen extent are skipped.
3. (no finalize/indirect — the lists are consumed directly by the shading stage.)
All `computeAsync` calls **awaited** before `renderer.render` (the SP2 flicker rule).

### Shading integration — additive `emissiveNode` term
Sun + ambient stay on three's standard node-lighting path, **untouched**. Clustered point
lights are added as an **additive emissive term** — the same injection the water caustics
already use (`material.emissiveNode`), so we never touch three's internal light loop or
reimplement its BRDF. A shared helper:

```
clusteredPointLight(worldPos, worldNormal) -> vec3   // additive diffuse from the tile's lights
```
derives the fragment's tile from its screen UV (`gl_FragCoord`-equivalent via the projected
position), reads `tileCounts[tile]` and loops `tileIndices`, and for each light accumulates
`color * intensity * max(0, N·L) * attenuation(dist, radius)` (smooth inverse-square falloff
clamped to `radius`). Lit surfaces opt in by adding this to their `emissiveNode`
(terrain CDLOD, grass, creatures). A simple Lambert term is enough for the demo/gate; spec
highlight is out of scope for 4a.

### Light source / animation
A `createClusteredLights({ renderer, camera, count })` module owns the buffers + compute and
exposes `setLights(array)` / a built-in animated demo set (drifting colored lights over the
terrain) so the gate has something to measure. Lights are updated in the GPU buffer (not
re-uploaded wholesale per frame where avoidable — caveat 2).

## Components / files

### `clustered-lights.js` (NEW, GPU/TSL — mirrors `grass-compute.js`)
`createClusteredLights(opts)` → `{ reset/bin compute nodes, lightTerm(worldPos, normal) TSL
helper, update(camera), setCount(n), setLights(arr), resize(w,h), drawCount/maxPerTile getters,
dispose }`. Owns `lightBuf`/`tileCounts`/`tileIndices` and the uniforms.

### `light-cluster.js` (NEW, pure JS — the Node-tested binning math)
- `screenSphereTiles(light, viewProj, screenW, screenH, tile)` → `{minTx,maxTx,minTy,maxTy}`
  (the tile AABB a light's projected bounding sphere covers, clipped to the grid; empty if
  off-screen/behind).
- `binLights(lights, viewProj, screenW, screenH, tile, maxPerTile)` → `{counts, indices}`
  (CPU reference the TSL `bin` kernel transcribes; the source of truth for the tests).

### `environment-viewer.html` (MODIFY)
- Construct `createClusteredLights` (top-level await, like the CDLOD ground).
- Add its `lightTerm(...)` to the `emissiveNode` of terrain/grass/creature materials (a shared
  opt-in; where a material already sets `emissiveNode`, sum the terms).
- `animate()`: `await clusteredLightsRef.update(camera)` before `renderer.render`.
- On resize: `clusteredLightsRef.resize(w, h)`.
- HUD/perfLog: light count + max lights/tile + cpuMs.

## Gate (success criteria)
1. **Target light count in budget:** ≈256 animated point lights render within frame budget;
   per-fragment cost tracks **lights-per-tile**, not total lights (raising total light count
   far off-screen / spread out does not blow the frame).
2. **Cull is on the GPU:** binning is a compute pass; no CPU per-light-per-fragment work; the
   awaited compute does not reintroduce a stall (cpuMs stays flat).
3. **Correctness:** lit surfaces show the moving pooled light; no light "popping" at tile
   borders (a light affects every tile its sphere covers).
4. **Binning math unit-tested** in Node (coverage, clipping, capacity clamp).
5. Measured vs the naive all-lights loop and the SP1 baseline (dd9-style trace).

## Testing
- **Node (`test-light-cluster.mjs`):**
  - `screenSphereTiles`: a centered light covers the center tiles; an off-screen/behind light
    yields an empty range; a light at a screen edge clips to the grid (no negative/overflow).
  - `binLights`: a light's index lands in exactly the tiles its projected sphere covers; tile
    counts match; capacity clamp at `MAX_PER_TILE` never overflows `tileIndices`; two lights
    overlapping a tile both appear.
- **Browser checkpoint:** spawn ≈256 drifting lights over the terrain — pooled light moves
  correctly, no tile seams; HUD shows light count + max/tile; raising the count keeps cost
  bounded by per-tile occupancy. **dd9:** clustered vs a naive all-lights loop build.

## Out of scope (4a)
- **3D froxel clusters** (depth slices) — 2D tiles suffice for the gate; froxels are a later
  refinement (a light behind geometry in the same tile can over-light, acceptable for now).
- **Shadows from point lights** (only the sun casts shadows).
- **Specular** from clustered lights (Lambert diffuse only for the demo).
- Particles (4b) and post-processing (4c) — separate sub-projects.
