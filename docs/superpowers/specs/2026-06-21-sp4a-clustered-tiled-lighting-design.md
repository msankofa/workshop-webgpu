# SP4a — Froxel clustered forward+ point lighting (WebGPU-reachable SOTA) · Design Spec

**Date:** 2026-06-21
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped; proceeding to plan + implement under the `a→b→c` goal (4a first).
**Part of:** SP4 (lights/effects/post): **4a lighting** → 4b particles → 4c post.

## SOTA context & WebGPU reachability (why this design, not ReSTIR)

The 2026 high-end lighting SOTA is **ray-traced direct+indirect illumination** — reservoir
resampling (**ReSTIR DI/GI/PT**, productized as **RTXDI**), **neural radiance caching**, and
ML denoising (**ray reconstruction**), i.e. real-time path tracing (Unreal's **MegaLights**,
Cyberpunk RT Overdrive). **All of it assumes hardware ray tracing.** WebGPU exposes **no
ray-tracing pipeline / ray-query in shipping browsers** (as of early 2026 it's a proposal, not
a standard), so RTXDI/ReSTIR/NRC are **out of reach** here.

The **WebGPU-reachable** lighting SOTA is therefore the rasterized-clustering ceiling:
**froxel (3D) clustered forward+** with view-space culling, the Drobot-style **Z-bin + per-tile
light bitmask** cull (SIGGRAPH 2017), and a proper **Cook-Torrance GGX** BRDF — the lineage
Olsson&Assarsson 2012 → Harada Forward+ → Drobot 2017 → modern WebGPU clustered demos. That is
what 4a targets. (Software ray tracing in a compute shader is the only RT-style alternative on
the web and is far too heavy for this scene; noted, rejected.)

## Goal

Render many dynamic point lights (target ≈256, scalable) with **physically based** shading,
deciding which lights affect which **froxel** entirely on the GPU. A per-frame compute pass
culls lights into a 3D view-frustum cluster grid; the forward shading stage reads its froxel's
light set and accumulates GGX lighting. Per-fragment cost tracks **lights-per-froxel**, not
total light count.

## Architecture

### Froxel grid (3D clusters)
- `tilesX × tilesY` screen tiles (default tile 32 px) × `Z_SLICES` depth slices (default 24).
- **Exponential depth slicing** (Olsson): `slice(z) = floor(log(z/near) / log(far/near) · Z_SLICES)`
  so froxels are ~cubic in view space (uniform angular+depth resolution). Inverse mapping gives
  each slice's `[zNear_s, zFar_s]`.
- Each froxel has a **view-space AABB** (from its tile's screen-corner rays at the slice's z
  range), used for tight light culling.

### Light culling — Drobot Z-bin + bitmask (the SOTA cull)
Lights live in a GPU storage buffer `(viewPos, radius, color, intensity)`, **sorted by view-space
min-Z each frame** (so a froxel's relevant lights are a contiguous index range).
- **Z-bins:** for each depth slice, store `[minLightIdx, maxLightIdx]` whose sphere intersects
  that slice's z-range (a compute pass over slices/lights). O(slices) memory.
- **XY bitmask:** for each `tilesX×tilesY` tile, a bitfield (`ceil(CAP_LIGHTS/32)` u32s) of which
  lights overlap that tile's screen-space frustum (a compute pass; `atomic`/bit-set). O(tiles·lights/32).
- **Shading** intersects the fragment's **Z-bin index range** with its **tile bitmask** → only
  the lights in *this* froxel, with no per-froxel index-list memory blowup and no overflow.
- *Simpler fallback if the bitmask path proves fiddly:* per-froxel index lists (atomic count +
  `tileIndices` buffer, `MAX_PER_FROXEL` cap) — functionally equivalent, more memory, has an
  overflow cap. The Node tests cover both shapes via the same `assignLights` reference.
- View-space **sphere-vs-froxel-AABB** intersection is the cull primitive (tighter than a
  screen-projected circle; this is what makes 3D froxels pay off).
All compute `computeAsync`-awaited before `renderer.render` (the SP2 flicker rule).

### Shading — Cook-Torrance GGX, additive over three's sun/ambient
Sun + ambient stay on three's standard node path, untouched. Clustered **point lights** are
added as a **physically based additive term** computed in TSL, reusing the material's own
`albedo / roughness / metalness` nodes:
- Per light in the froxel: `L`, `NdotL`; **D** = GGX/Trowbridge-Reitz, **G** = Smith height-
  correlated, **F** = Schlick; `spec = D·G·F / (4·NdotL·NdotV)`; `diff = (1-F)·(1-metal)·albedo/π`;
  attenuation = inverse-square with a smooth `radius` cutoff (windowing function).
- Summed and injected via the material's output (added to `emissiveNode`, the same hook the
  water caustics use — robust, no surgery on three's light loop).
- **Primary path is this manual GGX** (genuinely PBR; gives real microfacet specular + Fresnel,
  which a `LightsNode` would too). *Optional nicety, gated on a feasibility spike:* a custom
  `LightsNode` so clustered lights flow through three's exact BRDF + shadow/IBL — adopted only
  if r0.184's node-lighting injection allows it cleanly; otherwise manual GGX stands (it is
  SOTA-adequate for unshadowed point lights).

### Light source / animation
`createClusteredLights({ renderer, camera, count })` owns buffers + compute and a built-in
animated demo set (drifting colored lights over the terrain) so the gate has something to
measure. Light data updated in-buffer (not wholesale re-uploaded — caveat 2).

## Components / files

### `light-cluster.js` (NEW, pure JS — Node-tested cull math)
- `zSlice(z, near, far, slices)` / `sliceRange(slice, …)` — exponential depth mapping + inverse.
- `froxelViewAABB(tx, ty, slice, …)` — froxel's view-space AABB from screen rays + slice z-range.
- `sphereIntersectsAABB(center, radius, aabbMin, aabbMax)`.
- `assignLights(lights, gridCfg, viewProj, view, screen)` → `{ zBins, tileBitmask }` (and/or
  `{ counts, indices }` for the fallback) — the CPU reference the TSL kernels transcribe and the
  source of truth for the tests.

### `clustered-lights.js` (NEW, GPU/TSL — mirrors `grass-compute.js`)
Owns `lightBuf`, the Z-bin/bitmask (or index) buffers, the sort + cull compute kernels, the
`pointLightTerm(worldPos, worldNormal, viewPos, albedo, roughness, metalness)` GGX TSL helper,
and `update(camera)` / `setCount` / `setLights` / `resize(w,h)` / `dispose` + HUD getters.

### `environment-viewer.html` (MODIFY)
- Construct `createClusteredLights` (top-level await, like the CDLOD ground).
- Add `pointLightTerm(...)` to the `emissiveNode` of lit materials (terrain/grass/creatures);
  where one already sets `emissiveNode`, sum the terms.
- `animate()`: `await clusteredLightsRef.update(camera)` before render; `resize` on resize.
- HUD/perfLog: light count, max lights/froxel, cpuMs.

## Gate (success criteria)
1. **Target light count in budget:** ≈256 animated point lights render within frame budget;
   per-fragment cost tracks **lights-per-froxel** (a Z-spread of many lights does not blow the
   frame, where 2D tiles would over-light).
2. **PBR quality:** clustered lights show correct GGX **specular highlights + Fresnel** on
   terrain/creatures (not flat Lambert), consistent with the sun's shading.
3. **GPU-resident cull:** froxel assignment + sort are compute passes; no CPU per-light-per-
   fragment work; the awaited compute introduces no stall (cpuMs flat).
4. **Cull math unit-tested** in Node (depth slicing, froxel AABB, sphere-AABB, Z-bin/bitmask
   assignment, capacity bounds).
5. Measured vs (a) a naive all-lights loop and (b) a 2D-tile variant, and vs the SP1 baseline.

## Testing
- **Node (`test-light-cluster.mjs`):**
  - `zSlice`: monotonic; `near→0`, `far→Z_SLICES-1`; inverse `sliceRange` brackets it.
  - `froxelViewAABB`: adjacent froxels share faces (no gaps/overlap); deeper slices are larger.
  - `sphereIntersectsAABB`: inside / touching / outside cases exact.
  - `assignLights`: a light lands in exactly the froxels its view-space sphere intersects (Z-bin
    range ∩ tile bitmask matches the brute-force froxel set); counts/bitmasks within capacity;
    a light spanning slices appears in each; an off-frustum light appears nowhere.
- **Browser checkpoint:** ≈256 drifting lights — specular highlights track the lights, no froxel
  seams, depth-correct (a light behind a ridge doesn't bleed onto near terrain in the same tile);
  HUD shows count + max/froxel; scaling count keeps cost bounded by occupancy. **dd9:** froxel
  clustered vs naive all-lights loop.

## Out of scope (4a)
- **Point-light shadows** — only the sun casts shadows. Many shadowed lights is a VSM/ray-traced
  problem beyond the WebGPU-reachable ceiling here.
- **Indirect / GI** (ReSTIR/NRC) — needs hardware ray tracing, unreachable in WebGPU (see SOTA
  context); explicitly not attempted.
- **Software ray tracing in compute** — too heavy for this scene; noted and rejected.
- Particles (4b) and post (4c) — separate sub-projects, each targeting their own WebGPU-reachable
  SOTA when reached.
