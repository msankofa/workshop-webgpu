# SP2 — GPU Compute Grass: Design Spec

**Status:** Approved (brainstorming complete). Next: `writing-plans`.
**Repo:** `workshop-webgpu`, branch `sp1-webgpu-renderer-migration` (SP2 work continues here).
**Depends on:** SP1 (WebGPU renderer + TSL node materials), Three.js `r0.184.0`.
**Companion docs:** `research/webgpu/webgpu-parallelism-over-serial-synthesis.html` (§6 SP2), `research/webgpu/sp1-migration-notes.md`.

---

## Goal

Replace the per-chunk, CPU-built grass meshes — hundreds of draw calls plus
main-thread geometry rebuilds while streaming — with a **single indirect
instanced draw** fed by a per-frame GPU compute pass. The visible result matches
today's grass (look, density, wind, water-avoidance), but grass draw cost
becomes **O(1)** and roughly flat versus draw distance.

This is the §4.1/§4.2 thesis applied to the project's measured bottleneck: collapse
many serial identical-signature draws into one parallel, GPU-driven batch, and move
the *decision* of which blades to draw onto the GPU.

## Non-goals (YAGNI / scope fence)

- **Trees** stay on their current path (a separate per-chunk bottleneck; not SP2).
- **Terrain LOD** is SP3; SP2 introduces **no** shared heightmap texture (it uses a
  closed-form TSL height function instead — see Decision 3).
- No new grass *look* (no new lighting model, no clumping/biome variation). Visual
  parity with the current field is the bar.

## Decisions (locked in brainstorming)

1. **Camera-centered, world-anchored cells.** Blade placement is a pure function of
   world cell + slot, so blades are stable as the camera moves (no swimming) and the
   field is regenerated+culled every frame from a hash rather than stored. (Exact
   match to *today's* blade positions is explicitly **not** required — "looks
   equivalent + stable" is the bar.)
2. **Density + Radius controls.** Grass fills a fixed ring of radius `R` around the
   camera (slider), decoupled from terrain draw distance. Density is blades per unit
   area (slider). The old "Blade count" total is retired on the GPU path.
3. **Closed-form TSL terrain height.** Port `terrainHeightAt` to a TSL `Fn` (exact
   parity, no textures, no streaming, sidesteps the issue-001 texture-binding risk).
   Guard the port with a Node parity test. SP3 may later replace this with a shared
   heightmap texture; SP2 does not.
4. **Temporary `?grass=cpu` flag.** Keep the existing chunk-grass manager behind a
   runtime flag for same-session A/B at dd9 and as a safety net; delete it in the
   final SP2 cleanup step (mirrors SP1's `?renderer=` lifecycle).

## Architecture

### World model
- Fixed **world-space cell grid**, cell size `C` (default ~2 units; tunable).
- Each cell `(gx,gz)` seeds a small per-cell RNG via the existing integer hash
  (`lakeHash` style). Each cell yields up to `Kmax` candidate blades; the live
  per-cell count derives from **Density** × cell area (≤ `Kmax`).
- The active **window** is the set of cells whose center lies within **Radius** `R`
  of the camera. `maxWindowCells ≈ ceil(πR²/C²)` at the maximum `R`.

### Per-frame GPU pipeline
1. **Reset kernel** (1 thread): zero the atomic append-counter and set the indirect
   buffer's `instanceCount = 0`.
2. **Generate-and-cull kernel** (one thread per candidate slot =
   `maxWindowCells × Kmax`). Each thread:
   - derives `(gx,gz,slot)` → world `(x,z)` via hash + deterministic in-cell jitter;
   - samples the TSL `terrainHeightAt(x,z)` → `y`, plus yaw / tip-lean / height
     variation from the same per-cell RNG stream (mirrors `buildGeometry` in
     `grass.js`);
   - **rejects** the candidate if: `y < waterLevel + shoreMargin` (off lakes/shore),
     world distance `> R`, or it fails a frustum test;
   - **density falloff**: in the outer band of `R`, a hash threshold rising with
     distance probabilistically drops blades so the ring **dithers out** instead of
     ending in a hard circle. This *replaces* the old per-blade height-collapse fade
     ("distance density falls out of the cull").
   - survivors `atomicAdd` their packed instance record into the **survivor buffer**
     and bump `instanceCount`.
3. **One `drawIndexedIndirect`** of the shared 5-vertex blade geometry, instanced
   over the survivor buffer (`instanceCount` from the indirect args).

### Data layout
- **Per-vertex** (shared base blade, constant across instances): `position` (5 verts
  / 3 tris), `aWind` (0 base / 0.5 mid / 1 tip), `aHeight` (height above base).
- **Per-instance** (written by the cull kernel, read in the vertex stage): base
  `(x, y, z)`, blade height `h`, yaw, tip-lean direction — packed into 2× `vec4`.

### Buffers (all GPU-resident; never re-uploaded per frame — honors §4.5 caveat 2)
- `survivorBuffer` — `StorageInstancedBufferAttribute`, capacity
  `maxWindowCells × Kmax` (sized at max Radius/Density; verified by a Node test so it
  cannot overflow).
- `indirectArgs` — `IndirectStorageBufferAttribute`
  `[indexCount = 9, instanceCount, firstIndex, baseVertex, firstInstance]`;
  `instanceCount` is produced by the compute pass and consumed by
  `geometry.indirect(indirectArgs)`.
- `counter` — single-`u32` atomic, reset each frame by the reset kernel.

### Compute execution point
The reset + cull dispatches run inside `update(seconds)` (already called once per
frame before `renderer.render`), via `renderer.compute(...)`. The cull must run
every frame because the frustum and Radius window change with camera motion;
generation is folded into the same kernel since positions are pure functions of
cell+slot (no separate persistent generate pass needed).

## Reuse / refactor

- Refactor `grass.js` to export `buildBladeGeometry()` and the TSL graph builders
  (wind sway, base→tip color, cloud-shadow value-noise, constant-up `normalNode`) so
  **both** the CPU path and the compute path share one source. This keeps the
  parity-tested wind math (`grassWindOffset`/`grassFadeKeep`, `test-grass-wind.mjs`)
  single-sourced. Wind is already phased on world X, so it is seamless for
  world-positioned instances with no change.
- Shadows unchanged: `castShadow = false`, `receiveShadow = true`.

## New module + host integration

- **`grass-compute.js`** — exports
  `createComputeGrass({ renderer, camera, terrainParams, waterLevel, density, radius, cellSize, seed })`
  returning `{ mesh, update(seconds), setDensity(d), setRadius(r), setWind(strength), dispose() }`.
  Owns the storage/indirect buffers, the compute kernels, and the instanced mesh.
- **`environment-viewer.html`** — `?grass=cpu` keeps `makeChunkGrassManager`; the
  default path uses `createComputeGrass`. The Grass panel exposes **Density**,
  **Radius**, **Wind** on the GPU path (the CPU path keeps its existing Blade
  count / Distance cull / Wind sliders behind the flag).

## Terrain height in TSL (Decision 3 detail)

Port `terrainHeightAt(params, x, z)` from `terrain-field.js`:
- trig sum (`sin`/`cos` terms × `baseAmp`) — direct TSL transcription;
- `lakeNoise` = bilinear value noise over `lakeHash(ix,iz)` (integer hash:
  `Math.imul` + XOR + shifts) — transcribed with TSL uint ops + `floor`/`fract`/
  smoothstep `mix`;
- `basin = smoothstep(t, t+0.15, lakeNoise(...)) ; return h - basin*lakeDepth`.

`params` (`baseAmp`, `lake`, `lakeDepth`) are passed as uniforms so the Terrain
panel sliders keep affecting grass placement live.

**Parity test:** a JS transcription mirroring the exact TSL ops, asserted equal to
`terrainHeightAt` (within float epsilon) over a sample grid — the TSL itself runs
only in the browser, but the transcribed math is Node-tested (same discipline as
the grass wind helpers).

## Testing approach

GPU rendering/compute can't be unit-tested in Node, so the suite mixes Node logic
tests with explicit browser checkpoints (per the SP1 testing approach).

- **Node logic tests**
  - terrain-height port parity (JS mirror vs `terrainHeightAt`).
  - cell-hash placement determinism: a candidate's world position is a pure function
    of `(gx,gz,slot)` and identical regardless of camera position (no swimming).
  - density → per-cell count mapping, and capacity sizing: `maxWindowCells × Kmax`
    bounds the worst case (max R, max Density) with no survivor-buffer overflow.
  - existing `test-grass-wind.mjs` and all `test-terrain-*.mjs` stay green (the
    grass.js refactor must not break the shared wind math).
- **Browser checkpoints**
  - blades look like the current field, sit on the ground, stay off lakes/shore,
    wind sways continuously, no swimming as the camera moves, the Radius edge
    dithers out (no hard ring), Density/Radius/Wind sliders work live.
  - **dd9 A/B perf gate** (see below).

## Spike (first implementation step — de-risk the API)

A throwaway page (deleted after, like `webgpu-spike.html`) that exercises the exact
r0.184 surface end-to-end: a `storage`/`instancedArray` survivor buffer, an
`atomicAdd` append in a compute `Fn`, a per-frame counter reset, an
`IndirectStorageBufferAttribute` wired via `geometry.indirect()`, and a
`drawIndexedIndirect` of a trivial instanced quad whose drawn count is set by the
compute pass. **Gate:** the indirect count visibly tracks the compute output on the
WebGPU backend with no console errors. No textures are involved, so the issue-001
binding lifecycle does not apply.

## SP2 acceptance gate

1. Grass draw calls are **O(1)** — a single indirect draw regardless of chunk count
   or draw distance.
2. Triangle count tracks **visible** blades (the cull output), not a global budget.
3. **No main-thread geometry rebuild** while streaming (no per-chunk CPU grass jobs
   on the GPU path).
4. A draw-distance-9 `perfStats` trace shows the **grass-dominated CPU-frame-time
   wall removed** versus `?grass=cpu` on the same hardware (CPU frame time is the
   metric, per SP1).
5. Node test suite green; browser parity checkpoints pass.

If the gate is not met, investigate before SP3 — most likely an oversized survivor
buffer / dispatch, an unintended per-frame buffer upload (the GEM'24 stall), or a
compute dispatch that isn't actually feeding the indirect count.

## Open risks carried into the plan

- **Exact indirect-draw wiring** (`geometry.indirect()` + `drawIndexedIndirect` +
  per-frame `instanceCount` reset) is validated by the spike before the full build.
- **Integer-hash parity in TSL** (uint `Math.imul`/shift semantics) — the Node
  parity test is the guard; if TSL uint ops diverge, fall back to a float hash that
  is itself Node-tested for adequate distribution.
- **Frustum test in compute** — pass the camera frustum planes as uniforms; if
  per-blade frustum culling proves marginal, distance + density falloff alone may
  suffice (frustum cull is an optimization, not correctness).
