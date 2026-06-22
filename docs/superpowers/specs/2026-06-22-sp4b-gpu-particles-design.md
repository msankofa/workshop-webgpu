# SP4b — GPU-driven particle fields (embers + dust) · Design Spec

**Date:** 2026-06-22
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped; proceeding to plan + implement under the `a→b→c` goal (4b).
**Part of:** SP4 (lights/effects/post): 4a lighting ✓ → **4b particles** → 4c post.

## Goal

A GPU-driven particle system: a fixed pool simulated **entirely on the GPU** each frame
(forces + lifecycle in a compute pass over a storage buffer), with the alive+visible particles
emitted via `atomicAdd` into one `drawIndexedIndirect` of camera-facing billboards — the proven
SP2/SP3/4a compute→indirect spine. Two species share the pipeline:

- **A · Embers / fireflies** — luminous drifting motes, additive blend, warm/varied color with a
  per-particle brightness flicker, gentle **buoyancy** + curl-noise swirl. Pairs with the dark
  night terrain and the 4a point lights.
- **B · Dust / pollen** — subtle near-neutral specks, soft low-alpha, slow wind drift + curl, ~no
  gravity. Atmospheric depth.

One parameterized module instantiated twice (`kind: 'ember' | 'dust'`); only forces, color,
size, and blend differ. (C · weather is deferred to a future sky/weather SP.)

## SOTA context (WebGPU-reachable)

Compute-simulated particles in storage buffers + indirect instanced draw + curl-noise flow is
the standard real-time GPU particle architecture and is fully reachable in WebGPU (it's the same
spine we've shipped three times). Beyond-scope polish: GPU depth-sorting for correct alpha
(avoided here by additive embers / low-alpha dust, which are order-independent), ribbon/trail
particles, mesh particles, and GPU emitters with a free-list (we use a fixed always-full pool
with respawn, which needs no free-list).

## Architecture

### Particle pool (camera-relative)
Fixed `CAP` particles per field, always alive (respawn on death — no free-list). Particles live
in a **volume around the camera** (half-extent `R`); when one dies (age ≥ maxLife) or leaves the
volume, it respawns at a fresh pseudo-random position in the volume with a reseeded velocity.
Because particles are dynamic, camera-relative respawn (not world-anchored like grass) is correct
— there's no swimming to avoid.

### Buffers (GPU-resident)
- `state` — `CAP` × 2×vec4: `(px,py,pz,age)`, `(vx,vy,vz,seed)`. Initialized on the CPU once.
- `counter` — atomic u32 (alive+visible survivors).
- `indirect` — `IndirectStorageBufferAttribute([indexCount,0,0,0,0])`.
- `draw` — `CAP` × 2×vec4 survivor records the vertex stage reads: `(px,py,pz,size)`,
  `(r,g,b,alpha)`.

### Compute pipeline (per frame, mirrors the spine)
1. **reset** — `atomicStore(counter,0)`.
2. **simulate+cull** — one thread per particle: integrate forces (kind-specific:
   buoyancy/curl/drag for ember; wind/curl for dust), advance `age`; respawn if dead/out-of-
   volume (reseed pos+vel from `seed`); compute size/color/alpha from kind + age (fade in/out) +
   flicker; **frustum-test** the particle; if alive & visible, `atomicAdd(counter,1)` and write
   its `draw` record.
3. **finalize** — copy `atomicLoad(counter)` into the indirect `instanceCount`.
All `computeAsync` **awaited** before `renderer.render` (the SP2 flicker rule).

### Curl-noise forces
Divergence-free curl of a value-noise potential (reuse `buildGrassNoiseFns`-style hash/noise)
gives organic swirling motion. Ember adds upward buoyancy + flicker; dust adds a slow constant
wind. Integer index/seed handling follows the SP2 `modInt`/`bitcast` rules.

### Rendering — camera-facing billboards, indirect
A reusable 2-triangle quad geometry, drawn `instanceCount` = survivors via `drawIndexedIndirect`.
The vertex stage reads the per-survivor `draw` record and places the quad at the particle position
offset by `quadCorner.x * uCamRight * size + quadCorner.y * uCamUp * size` (`uCamRight`/`uCamUp`
uniforms from the camera basis each frame) — standard billboard. `colorNode` = record color ×
alpha; ember uses **AdditiveBlending** (`depthWrite=false`, order-independent), dust uses low-alpha
NormalBlending (also order-tolerant at low opacity). Optional soft-particle depth fade later.

## Components / files

### `particle-field.js` (NEW, pure JS — Node-tested)
- `spawnInVolume(seed, camX, camY, camZ, R)` → `{x,y,z}` (deterministic pseudo-random point in the
  camera volume).
- `curlNoise2(x, z, noiseFns)` → `{fx, fz}` (divergence-free curl of the potential).
- `stepLife(age, dt, maxLife)` → `{age, fade}` (advance + fade-in/out envelope; wraps at maxLife).
- `kindParams(kind)` → forces/size/color config for `'ember'` / `'dust'`.
These are the CPU references the TSL kernels transcribe + the test source of truth.

### `particles.js` (NEW, GPU/TSL — mirrors `clustered-lights.js`/`grass-compute.js`)
`createParticleField({ renderer, camera, kind, count, radius })` → `{ mesh, async update(dt,
camera), setCount, dispose, get aliveCount }`. Owns the `state`/`counter`/`indirect`/`draw`
buffers, the reset→simulate→finalize kernels, the billboard geometry + material (blend per kind),
and the `uCamRight`/`uCamUp`/`uTime`/`uCamPos` uniforms.

### `environment-viewer.html` (MODIFY — note: shares the file with Codex; stage SP4b hunks only)
- Construct two fields (`ember`, `dust`) behind `?particles=on|off` (default on), add their meshes.
- `animate()`: `await emberRef.update(dt, camera); await dustRef.update(dt, camera);` before render.
- HUD/perfLog: alive particle counts.

## Gate (success criteria)
1. **Target particle count in budget:** e.g. ~4k embers + ~8k dust simulated + drawn at
   negligible CPU cost (sim is GPU compute, draw is one indirect call per field); fps holds vs
   `?particles=off`.
2. **GPU-driven:** no CPU per-particle work after init; the awaited compute introduces no stall.
3. **Correctness:** particles drift organically (curl), stay in view (camera-relative respawn),
   embers glow/flicker additively, dust is subtle; no popping on respawn (fade envelope).
4. **Sim/spawn/lifecycle math unit-tested** in Node.

## Testing
- **Node (`test-particle-field.mjs`):** `spawnInVolume` lands inside `[cam±R]` and is deterministic
  per seed; `curlNoise2` is ~divergence-free (finite-difference divergence ≈ 0) and deterministic;
  `stepLife` advances, fades at both ends, wraps at maxLife; `kindParams` returns distinct
  ember/dust configs.
- **Browser checkpoint:** embers glow/flicker and swirl upward over the terrain (lovely against the
  4a lights); dust drifts subtly; both stay around the camera as it moves; HUD shows alive counts;
  `?particles=off` A/B confirms negligible cost. **dd9:** particles on vs off.

## Out of scope (4b)
- **Weather (rain/snow)** → deferred to a future sky/weather SP (per the C decision).
- GPU depth-sort, ribbon/trail particles, mesh particles, soft-particle depth fade (polish).
- Particle collision with terrain/obstacles (purely visual drift here).
- Emitting particles from creatures/combat (Codex coupling) — not in this self-contained field.
