# SP2 — GPU Compute Grass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-chunk CPU-built grass meshes with a single `drawIndexedIndirect` instanced draw fed by a per-frame GPU compute pass (generate + cull), so grass draw cost is O(1) and flat versus draw distance.

**Architecture:** A world-anchored cell grid is hashed deterministically; a per-frame compute kernel regenerates candidate blades around the camera, plants them on a closed-form TSL terrain height, rejects underwater/out-of-radius/out-of-frustum blades, and `atomicAdd`s survivors into a GPU-resident instance buffer whose count drives one indirect instanced draw. The blade geometry and wind/color TSL graph are shared with the existing `grass.js`.

**Tech Stack:** Three.js `r0.184.0` WebGPU build (`three/webgpu` + `three/tsl`): `storage`/`instancedArray`/`instanceIndex`/`atomicAdd` compute nodes, `StorageInstancedBufferAttribute`, `IndirectStorageBufferAttribute`, `geometry.indirect()`, `renderer.compute()`. Node (`node --check`, logic tests) for everything renderer-independent.

**Spec:** `docs/superpowers/specs/2026-06-21-sp2-gpu-compute-grass-design.md`.

---

## Testing approach (read first)

GPU compute/rendering cannot run in Node (no WebGPU device). So, exactly as in SP1:
the **pure math** (terrain-height port, cell placement determinism, capacity sizing,
density→count) is extracted into renderer-independent modules and Node-tested with
TDD; the **GPU pipeline** is gated by an explicit browser spike and browser parity
checkpoints; the **perf gate** is a `perfStats` dd9 trace comparing `?grass=cpu`
(old path) vs the new compute path, using **CPU frame time** as the metric.

TSL graph/compute code below is written against r0.184's node API; the exact node
function names are confirmed in the Task 4 spike before the Task 5 build (TSL evolves
between releases — the JS reference math from Tasks 1–2 is the behavioral source of
truth).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `grass-height-ref.js` | Pure JS re-derivation of `terrainHeightAt`, written with the exact integer/float ops we transcribe to TSL. The transcription target + parity guard. | **Create** (Task 1) |
| `grass-cells.js` | Pure placement math: per-cell deterministic RNG, candidate-blade generation, window-cell count, instance-capacity sizing, density→per-cell count. | **Create** (Task 2) |
| `grass.js` | Existing CPU grass. Export `buildBladeGeometry()` (one instanced base blade) + the color/noise TSL builders so the compute path reuses them. | **Modify** (Task 3) |
| `grass-compute-spike.html` | Throwaway: validate compute→atomicAdd→indirect-draw on the real device. | **Create** then delete (Tasks 4, 8) |
| `grass-compute.js` | `createComputeGrass(...)`: storage/indirect buffers, reset+cull compute kernels, instanced mesh, public API. | **Create** (Task 5) |
| `environment-viewer.html` | `?grass=cpu` flag keeps the old manager; default uses `createComputeGrass`; Grass panel → Density/Radius/Wind. | **Modify** (Tasks 6, 8) |
| `research/webgpu/sp1-migration-notes.md` | Append an SP2 section (compute approach, indirect wiring, dd9 numbers). | **Modify** (Task 8) |
| `test-grass-height-tsl.mjs`, `test-grass-cells.mjs` | Node logic tests. | **Create** (Tasks 1, 2) |

Untouched and must stay green: `terrain-field.js`, `terrain-worker.js`, `test-terrain-*.mjs`, `test-grass-wind.mjs`.

---

## Task 1: Terrain-height port reference + Node parity test

The compute kernel needs `terrainHeightAt(x,z)` in the shader. We hand-transcribe it
to TSL in Task 5; here we build an independent JS re-derivation (`grass-height-ref.js`)
written with the same ops, and prove it matches the canonical `terrainHeightAt` from
`terrain-field.js`. If they match and we copy `grass-height-ref.js`'s ops faithfully
into TSL, the shader matches the visible terrain.

**Files:**
- Create: `grass-height-ref.js`
- Test: `test-grass-height-tsl.mjs`

- [ ] **Step 1: Write the failing test**

Create `test-grass-height-tsl.mjs`:

```js
import { terrainHeightAt } from './terrain-field.js';
import { grassHeightRef } from './grass-height-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };

// Sample a grid spanning several chunks incl. fractional + negative coords.
let maxErr = 0;
for (let x = -64; x <= 64; x += 3.5) {
  for (let z = -64; z <= 64; z += 3.5) {
    const a = terrainHeightAt(params, x, z);
    const b = grassHeightRef(params, x, z);
    maxErr = Math.max(maxErr, Math.abs(a - b));
  }
}
ok(maxErr < 1e-6, `height port matches terrainHeightAt over grid (maxErr=${maxErr.toExponential(2)})`);

// Determinism: same input twice → identical output.
ok(grassHeightRef(params, 12.3, -7.1) === grassHeightRef(params, 12.3, -7.1), 'deterministic');

// Lake params actually move the result (so uniforms are wired meaningfully).
const deep = grassHeightRef({ ...params, lakeDepth: 10 }, 0, 0);
const shallow = grassHeightRef({ ...params, lakeDepth: 0 }, 0, 0);
ok(deep !== shallow, 'lakeDepth changes height');

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-grass-height-tsl.mjs`
Expected: FAIL — `Cannot find module './grass-height-ref.js'`.

- [ ] **Step 3: Implement `grass-height-ref.js`**

Re-derive the math from `terrain-field.js` (do NOT import it — this is the
independent transcription target). Keep each op in a TSL-friendly form (integer hash
via `Math.imul` + `>>>`, value noise via `floor`/`fract`/smoothstep `mix`):

```js
// grass-height-ref.js
// Independent re-derivation of terrain-field.js terrainHeightAt(), written with the
// exact ops we transcribe into the TSL grass-compute height function. Node-tested
// against the canonical terrainHeightAt so the shader provably matches the terrain.
// Keep in sync with terrain-field.js if the terrain formula changes.

function lakeHash(ix, iz) {
  let h = (Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function lakeNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = lakeHash(ix, iz), b = lakeHash(ix + 1, iz);
  const c = lakeHash(ix, iz + 1), d = lakeHash(ix + 1, iz + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function grassHeightRef(params, x, z) {
  const h = (Math.sin(x * 0.10) * 1.1 + Math.cos(z * 0.085) * 1.0 + Math.sin((x + z) * 0.16) * 0.5
           + Math.cos((x - z) * 0.22 + 0.8) * 0.35 + Math.sin(x * 0.38 + z * 0.27) * 0.18
           + Math.cos(z * 0.44 - x * 0.19) * 0.14) * params.baseAmp;
  const t = 1 - params.lake;
  const basin = smoothstep(t, t + 0.15, lakeNoise(x * 0.045 + 10.5, z * 0.045 - 7.2));
  return h - basin * params.lakeDepth;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node test-grass-height-tsl.mjs`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add grass-height-ref.js test-grass-height-tsl.mjs
git commit -m "feat(sp2): terrain-height port reference + Node parity test"
```

---

## Task 2: Cell placement model + capacity sizing (Node TDD)

Pure helpers for the world-anchored cell grid: deterministic per-cell candidate
blades (stable regardless of camera), the window-cell count, the survivor-buffer
capacity, and density→per-cell count. These are the numbers `grass-compute.js` uses to
size buffers and that the compute kernel mirrors in TSL.

**Files:**
- Create: `grass-cells.js`
- Test: `test-grass-cells.mjs`

- [ ] **Step 1: Write the failing test**

Create `test-grass-cells.mjs`:

```js
import { cellHash, candidateBlade, windowCellCount, maxInstances, perCellCount } from './grass-cells.js';
import { grassHeightRef } from './grass-height-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const cfg = { cellSize: 2, Kmax: 8, params };

// Determinism: a blade depends only on (gx,gz,slot), NOT on camera — no swimming.
const b1 = candidateBlade(cfg, 5, -3, 2);
const b2 = candidateBlade(cfg, 5, -3, 2);
ok(b1.x === b2.x && b1.z === b2.z && b1.h === b2.h && b1.yaw === b2.yaw, 'candidate is deterministic');

// Blade sits inside its cell's XZ footprint.
const cx = 5 * cfg.cellSize, cz = -3 * cfg.cellSize;
ok(b1.x >= cx && b1.x < cx + cfg.cellSize && b1.z >= cz && b1.z < cz + cfg.cellSize, 'blade within its cell');

// Blade base y equals the terrain height at its XZ (planted on the ground).
ok(Math.abs(b1.y - grassHeightRef(params, b1.x, b1.z)) < 1e-9, 'blade planted on terrain height');

// Distinct slots in a cell give distinct positions.
ok(candidateBlade(cfg, 0, 0, 0).x !== candidateBlade(cfg, 0, 0, 1).x, 'slots differ within a cell');

// Hash spread: not all cells collide to the same value.
ok(cellHash(0, 0) !== cellHash(1, 0) && cellHash(0, 0) !== cellHash(0, 1), 'cell hash varies');

// Capacity bounds the worst case: windowCellCount(R) * Kmax >= survivors for any camera.
const R = 48;
const cells = windowCellCount(R, cfg.cellSize);
const cap = maxInstances(R, cfg.cellSize, cfg.Kmax);
ok(cap === cells * cfg.Kmax, 'capacity = windowCells * Kmax');
ok(cells >= Math.PI * R * R / (cfg.cellSize * cfg.cellSize), 'window covers the disk of radius R');

// Density → per-cell count maps blades/area to an integer <= Kmax.
ok(perCellCount(0, cfg.cellSize, cfg.Kmax) === 0, 'zero density → 0 blades');
ok(perCellCount(100, cfg.cellSize, cfg.Kmax) === cfg.Kmax, 'high density clamps to Kmax');
const mid = perCellCount(1 / (cfg.cellSize * cfg.cellSize), cfg.cellSize, cfg.Kmax); // 1 blade/cell-area
ok(mid === 1, 'density of 1 blade per cell-area → 1');

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-grass-cells.mjs`
Expected: FAIL — `Cannot find module './grass-cells.js'`.

- [ ] **Step 3: Implement `grass-cells.js`**

```js
// grass-cells.js
// Pure, renderer-independent math for the world-anchored grass cell grid. The TSL
// compute kernel in grass-compute.js mirrors candidateBlade(); grass-compute.js uses
// maxInstances()/perCellCount() to size buffers and dispatch. Node-tested.

import { grassHeightRef } from './grass-height-ref.js';

// Integer cell hash → uint in [0, 2^32). Same family as terrain-field lakeHash; the
// TSL port uses the identical ops so placement matches between JS and shader.
export function cellHash(gx, gz) {
  let h = (Math.imul(gx | 0, 1597334677) ^ Math.imul(gz | 0, 3812015801)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0);
}

// A per-(cell,slot) pseudo-random in [0,1). Mixing slot keeps slots independent.
function slotRand(gx, gz, slot, salt) {
  let h = (cellHash(gx, gz) ^ Math.imul((slot | 0) + 1, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Deterministic candidate blade for (gx,gz,slot): position jittered within the cell,
// planted on the terrain, with yaw/height variation. Pure function of its indices
// (and terrain params) — independent of camera, so blades never swim.
export function candidateBlade(cfg, gx, gz, slot) {
  const C = cfg.cellSize;
  const jx = slotRand(gx, gz, slot, 1);
  const jz = slotRand(gx, gz, slot, 2);
  const x = gx * C + jx * C;
  const z = gz * C + jz * C;
  const y = grassHeightRef(cfg.params, x, z);
  const yaw = slotRand(gx, gz, slot, 3) * Math.PI * 2;
  const tipYaw = slotRand(gx, gz, slot, 4) * Math.PI * 2;
  const h = 0.8 + slotRand(gx, gz, slot, 5) * 0.6; // bladeHeight + heightVariation (grass.js DEFAULTS)
  return { x, y, z, yaw, tipYaw, h };
}

// Number of cells whose center lies within radius R (square window that covers the
// disk; the kernel still distance-culls to a circle). Square side = 2*ceil(R/C)+1.
export function windowCellCount(R, cellSize) {
  const half = Math.ceil(R / cellSize);
  const side = 2 * half + 1;
  return side * side;
}

// Worst-case survivor capacity for buffer sizing.
export function maxInstances(R, cellSize, Kmax) {
  return windowCellCount(R, cellSize) * Kmax;
}

// blades-per-unit-area → integer blades per cell, clamped to [0, Kmax].
export function perCellCount(density, cellSize, Kmax) {
  const per = Math.round(density * cellSize * cellSize);
  return Math.max(0, Math.min(Kmax, per));
}
```

Note: the `windowCellCount` square side `2*ceil(R/C)+1` over-covers the disk, so
`windowCellCount * Kmax` is a safe upper bound for survivors after the circular
distance cull — the capacity assertion holds.

- [ ] **Step 4: Run it to verify it passes**

Run: `node test-grass-cells.mjs`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add grass-cells.js test-grass-cells.mjs
git commit -m "feat(sp2): world-cell placement model + capacity sizing (Node TDD)"
```

---

## Task 3: Refactor `grass.js` to share blade geometry + color graph

Export a single instanced **base blade** geometry and the color/noise TSL builders so
`grass-compute.js` reuses them (DRY; keeps the parity-tested wind/color math
single-sourced). The CPU path must keep working — `test-grass-wind.mjs` stays green.

**Files:**
- Modify: `grass.js`

- [ ] **Step 1: Add `buildBladeGeometry()` export**

A single blade in local space (base at origin, unit-ish dims from DEFAULTS), carrying
`position`, `aWind`, `aHeight`, and the 9-index triangle list — the instanced base
mesh. Add near `buildGeometry`:

```js
// One blade in local space, for instanced rendering (the compute path positions each
// instance from a storage buffer). Layout matches buildGeometry's per-blade verts:
// [BL, BR, TR, TL, TC]; aWind = WIND_WEIGHT; aHeight = local y of each vert.
export function buildBladeGeometry(opts = {}) {
  const bladeWidth = opts.bladeWidth ?? DEFAULTS.bladeWidth;
  const bladeHeight = opts.bladeHeight ?? DEFAULTS.bladeHeight;
  const tipOffset = opts.tipOffset ?? DEFAULTS.tipOffset;
  const halfW = bladeWidth * 0.5, midW = bladeWidth * 0.25, h = bladeHeight;
  // width axis along local X; tip leans along local +X by tipOffset (per-instance yaw
  // is applied in the vertex shader from the instance's stored yaw/tipYaw).
  const ox = [-halfW, halfW, midW, -midW, tipOffset];
  const oy = [0, 0, h * 0.5, h * 0.5, h];
  const pos = new Float32Array(5 * 3);
  const wnd = new Float32Array(5);
  const hgt = new Float32Array(5);
  for (let k = 0; k < 5; k++) {
    pos[k * 3] = ox[k]; pos[k * 3 + 1] = oy[k]; pos[k * 3 + 2] = 0;
    wnd[k] = WIND_WEIGHT[k];
    hgt[k] = oy[k];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aWind', new THREE.BufferAttribute(wnd, 1));
  geom.setAttribute('aHeight', new THREE.BufferAttribute(hgt, 1));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array(BLADE_INDICES), 1));
  return geom;
}
```

- [ ] **Step 2: Export the color/noise TSL builders**

Factor the value-noise + color nodes out of `buildMaterial` into exported helpers so
both materials share them. Add:

```js
// Exported so grass-compute.js builds the same blade color (base→tip × light × cloud).
export function buildGrassNoiseFns() {
  const hash2D = Fn(([p]) => {
    const q = fract(p.mul(vec2(123.34, 456.21)));
    const r = q.add(dot(q, q.add(float(45.32))));
    return fract(r.x.mul(r.y));
  });
  const noise2D = Fn(([p]) => {
    const i = floor(p), f = fract(p);
    const a = hash2D(i), b = hash2D(i.add(vec2(1.0, 0.0)));
    const c = hash2D(i.add(vec2(0.0, 1.0))), d = hash2D(i.add(vec2(1.0, 1.0)));
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });
  return { hash2D, noise2D };
}
```

Then refactor `buildMaterial` to call `buildGrassNoiseFns()` instead of its inline
`hash2D`/`noise2D` (delete the inline copies; behavior identical).

- [ ] **Step 3: Verify the CPU path is unbroken**

Run: `node test-grass-wind.mjs`
Expected: PASS (4/4 — the wind/fade helpers are untouched).

Run the inline-module syntax check is not applicable (grass.js is a module): instead
`node --check grass.js`
Expected: no output (valid).

- [ ] **Step 4: Commit**

```bash
git add grass.js
git commit -m "refactor(sp2): export shared blade geometry + grass noise fns from grass.js"
```

---

## Task 4: Spike — compute → atomicAdd → indirect draw (browser, throwaway)

De-risk the exact r0.184 API before the full build. A bare page that, each frame:
clears an atomic counter, runs a compute kernel that conditionally `atomicAdd`s into a
survivor buffer and writes the indirect `instanceCount`, then issues one
`drawIndexedIndirect` of a small instanced quad whose count equals the survivors.

**Files:**
- Create: `grass-compute-spike.html`

- [ ] **Step 1: Write the spike**

```html
<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111">
<pre id="log" style="position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace;z-index:9"></pre>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
  "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
  "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js"
} }
</script>
<script type="module">
import * as THREE from 'three';
import { WebGPURenderer, StorageInstancedBufferAttribute, IndirectStorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, storage, uniform, float, vec3, vec4, If, atomicAdd } from 'three/tsl';
const log = (m) => document.getElementById('log').textContent += m + '\n';
if (!navigator.gpu) { log('NO navigator.gpu'); throw new Error('no webgpu'); }

const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();
log('backend: ' + (renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'));

const CAP = 1024;                 // candidate/survivor capacity
// survivor instance data: vec4 per instance (xyz offset + unused .w)
const survivor = storage(new StorageInstancedBufferAttribute(new Float32Array(CAP * 4), 4), 'vec4', CAP);
// atomic counter (1 u32) used as the append index
const counter = storage(new THREE.StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).setPBO(true).toAtomic();
// indirect args: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 5);
const indirect = storage(indirectAttr, 'uint', 5);

const uKeepEvery = uniform(2);    // keep 1 of every N candidates → visibly tracks compute

const reset = Fn(() => { counter.element(0).assign(0); indirect.element(1).assign(0); })().compute(1);
const cull = Fn(() => {
  const i = instanceIndex;
  If(i.mod(uKeepEvery).equal(0), () => {
    const slot = atomicAdd(counter.element(0), 1);
    const col = i.toFloat().mul(0.01);
    survivor.element(slot).assign(vec4(col.mod(8).sub(4), col.div(8).mod(8).sub(4), 0, 1));
    atomicAdd(indirect.element(1), 1);
  });
})().compute(CAP);

// instanced quad whose draw count comes from the indirect buffer
const geo = new THREE.PlaneGeometry(0.05, 0.05);
geo.instanceCount = CAP;
geo.indirect = indirectAttr;       // confirm exact wiring during the spike (geometry.indirect)
const mat = new THREE.MeshBasicNodeMaterial({ color: 0x66ff66 });
import { positionLocal } from 'three/tsl';
mat.positionNode = positionLocal.add(survivor.element(instanceIndex).xyz);
const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
const scene = new THREE.Scene(); scene.add(mesh);
const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0, 10); cam.position.z = 5;

let logged = 0;
renderer.setAnimationLoop(async () => {
  await renderer.computeAsync(reset);
  await renderer.computeAsync(cull);
  renderer.render(scene, cam);
  if (logged++ === 30) log('rendered ~' + Math.floor(CAP / 2) + ' instances via indirect (keepEvery=2)');
});
</script>
```

- [ ] **Step 2: Browser checkpoint**

Serve and open `grass-compute-spike.html`. **Pass criteria:**
- A grid of ~512 green quads renders (half of CAP, since keepEvery=2), no console errors.
- In the console, change `uKeepEvery.value = 4` → roughly a quarter as many quads draw,
  confirming the indirect count tracks the compute output live.
- `backend: WebGPU`.

**This step resolves the exact API**: the storage/atomic creation calls
(`.toAtomic()`, `storage(...).setPBO(...)`), `IndirectStorageBufferAttribute`, and how
the geometry references the indirect buffer (`geo.indirect` vs `geometry.indirect()`).
Record the working forms in the commit message — Task 5 uses them verbatim.

- [ ] **Step 3: Commit the spike result**

```bash
git add grass-compute-spike.html
git commit -m "spike(sp2): compute atomicAdd survivor list drives drawIndexedIndirect"
```

> **Gate:** the indirect-driven instance count must visibly track the compute output
> before continuing. If `geometry.indirect` wiring or `.toAtomic()` differs from the
> above, fix here and note the correct API; Task 5 depends on it.

---

## Task 5: `grass-compute.js` — generate + cull + indirect draw

The core build, using the API confirmed in Task 4 and the math from Tasks 1–3.

**Files:**
- Create: `grass-compute.js`

- [ ] **Step 1: Implement `createComputeGrass`**

```js
// grass-compute.js
// GPU-driven grass: a per-frame compute pass regenerates candidate blades over a
// world-cell window around the camera, plants them on the TSL terrain height, culls
// (water / radius / frustum / density falloff), and atomicAdds survivors into a
// GPU-resident instance buffer that drives ONE drawIndexedIndirect. Placement math
// mirrors grass-cells.js (Node-tested); height mirrors grass-height-ref.js.
import * as THREE from 'three';
import { MeshStandardNodeMaterial, StorageInstancedBufferAttribute, IndirectStorageBufferAttribute } from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, vec2, vec3, vec4,
  sin, cos, floor, fract, mix, clamp, max, min, dot, atomicAdd, positionLocal, cameraPosition,
} from 'three/tsl';
import { buildBladeGeometry, buildGrassNoiseFns } from './grass.js';
import { maxInstances, perCellCount } from './grass-cells.js';

// ---- TSL terrain height (transcription of grass-height-ref.js; Node-tested twin) ----
function buildHeightFn(uBaseAmp, uLake, uLakeDepth) {
  const lakeHash = Fn(([ix, iz]) => {
    // integer hash; uint ops mirror grass-height-ref.lakeHash
    let h = uint(ix).mul(uint(374761393)).bitXor(uint(iz).mul(uint(668265263)));
    h = h.bitXor(h.shiftRight(uint(13))).mul(uint(1274126177));
    h = h.bitXor(h.shiftRight(uint(16)));
    return h.toFloat().div(4294967296.0);
  });
  const lakeNoise = Fn(([p]) => {
    const i = floor(p), f = fract(p);
    const ix = int(i.x), iz = int(i.y);
    const u = f.x.mul(f.x).mul(float(3).sub(f.x.mul(2)));
    const v = f.y.mul(f.y).mul(float(3).sub(f.y.mul(2)));
    const a = lakeHash(ix, iz), b = lakeHash(ix.add(1), iz);
    const c = lakeHash(ix, iz.add(1)), d = lakeHash(ix.add(1), iz.add(1));
    return mix(mix(a, b, u), mix(c, d, u), v);
  });
  return Fn(([x, z]) => {
    const h = sin(x.mul(0.10)).mul(1.1)
      .add(cos(z.mul(0.085)).mul(1.0))
      .add(sin(x.add(z).mul(0.16)).mul(0.5))
      .add(cos(x.sub(z).mul(0.22).add(0.8)).mul(0.35))
      .add(sin(x.mul(0.38).add(z.mul(0.27))).mul(0.18))
      .add(cos(z.mul(0.44).sub(x.mul(0.19))).mul(0.14))
      .mul(uBaseAmp);
    const t = float(1).sub(uLake);
    const nz = lakeNoise(vec2(x.mul(0.045).add(10.5), z.mul(0.045).sub(7.2)));
    const basin = clamp(nz.sub(t).div(0.15), 0, 1);
    const basinSS = basin.mul(basin).mul(float(3).sub(basin.mul(2)));
    return h.sub(basinSS.mul(uLakeDepth));
  });
}

export function createComputeGrass(opts) {
  const { renderer, camera } = opts;
  const cellSize = opts.cellSize ?? 2;
  const Kmax     = opts.Kmax ?? 8;
  const o = {
    density: opts.density ?? 1.0,        // blades / unit area
    radius:  opts.radius ?? 48,
    waterLevel: opts.waterLevel ?? -0.9,
    shoreMargin: opts.shoreMargin ?? 0.1,
    baseAmp: opts.terrainParams?.baseAmp ?? 1.0,
    lake:    opts.terrainParams?.lake ?? 0.45,
    lakeDepth: opts.terrainParams?.lakeDepth ?? 3.2,
  };
  const CAP = maxInstances(o.radius, cellSize, Kmax); // sized at the configured radius

  // ---- buffers (GPU-resident) ----
  const instAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP * 8), 8); // 2x vec4
  const inst = storage(instAttr, 'vec4', CAP * 2);   // [2i]=xyz+h, [2i+1]=yaw,tipYaw,_,_
  const counter = storage(new THREE.StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).toAtomic();
  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([9, 0, 0, 0, 0]), 5);
  const indirect = storage(indirectAttr, 'uint', 5);

  // ---- uniforms (live sliders) ----
  const uCam = uniform(new THREE.Vector2());
  const uRadius = uniform(o.radius);
  const uHalf = uniform(Math.ceil(o.radius / cellSize) | 0);   // window half-extent in cells
  const uSide = uniform((2 * (Math.ceil(o.radius / cellSize) | 0) + 1) | 0);
  const uPerCell = uniform(perCellCount(o.density, cellSize, Kmax));
  const uCellSize = uniform(cellSize);
  const uWaterMin = uniform(o.waterLevel + o.shoreMargin);
  const uTime = uniform(0);
  const uWindSpeed = uniform(2.0), uWaveSize = uniform(10.0);
  const uTipDist = uniform(0.3), uCenterDist = uniform(0.1);
  const uBaseAmp = uniform(o.baseAmp), uLake = uniform(o.lake), uLakeDepth = uniform(o.lakeDepth);

  const heightFn = buildHeightFn(uBaseAmp, uLake, uLakeDepth);

  // integer cell/slot rng mirroring grass-cells.js
  const cellRand = Fn(([gx, gz, slot, salt]) => {
    let h = uint(gx).mul(uint(1597334677)).bitXor(uint(gz).mul(uint(3812015801)));
    h = h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519)).bitXor(h.shiftRight(uint(13)));
    h = h.bitXor(uint(slot).add(1).mul(uint(0x9e3779b1))).bitXor(uint(salt).mul(uint(0x85ebca6b)));
    h = h.bitXor(h.shiftRight(uint(16))).mul(uint(2246822519)).bitXor(h.shiftRight(uint(13)));
    return h.toFloat().div(4294967296.0);
  });

  // ---- reset kernel ----
  const reset = Fn(() => { counter.element(0).assign(0); indirect.element(1).assign(0); })().compute(1);

  // ---- generate + cull kernel: one thread per candidate slot ----
  const cull = Fn(() => {
    const idx = instanceIndex;
    const perCell = uPerCell;
    const slot = int(idx.mod(uint(Kmax)));
    If(slot.lessThan(int(perCell)), () => {     // only the first perCell slots are live
      const cellI = int(idx.div(uint(Kmax)));
      const side = int(uSide);
      const lx = cellI.mod(side), lz = cellI.div(side);
      // window cell → world cell index (camera cell ± half)
      const camGx = int(floor(uCam.x.div(uCellSize)));
      const camGz = int(floor(uCam.y.div(uCellSize)));
      const gx = camGx.add(lx).sub(int(uHalf));
      const gz = camGz.add(lz).sub(int(uHalf));
      const jx = cellRand(gx, gz, slot, int(1));
      const jz = cellRand(gx, gz, slot, int(2));
      const wx = gx.toFloat().mul(uCellSize).add(jx.mul(uCellSize));
      const wz = gz.toFloat().mul(uCellSize).add(jz.mul(uCellSize));
      const wy = heightFn(wx, wz);
      const dist = vec2(wx.sub(uCam.x), wz.sub(uCam.y)).length();
      // density falloff: drop blades probabilistically in the outer 20% of R
      const edge = clamp(dist.div(uRadius).sub(0.8).div(0.2), 0, 1);
      const keepRand = cellRand(gx, gz, slot, int(7));
      const live = wy.greaterThan(uWaterMin)
        .and(dist.lessThan(uRadius))
        .and(keepRand.greaterThan(edge));
      If(live, () => {
        const s = atomicAdd(counter.element(0), 1);
        const yaw = cellRand(gx, gz, slot, int(3)).mul(6.2831853);
        const tipYaw = cellRand(gx, gz, slot, int(4)).mul(6.2831853);
        const h = float(0.8).add(cellRand(gx, gz, slot, int(5)).mul(0.6));
        inst.element(s.mul(2)).assign(vec4(wx, wy, wz, h));
        inst.element(s.mul(2).add(1)).assign(vec4(yaw, tipYaw, 0, 0));
        atomicAdd(indirect.element(1), 1);
      });
    });
  })().compute(CAP);

  // ---- instanced base blade + material ----
  const geom = buildBladeGeometry();
  geom.instanceCount = CAP;
  geom.indirect = indirectAttr;   // exact form per Task-4 spike

  const aWind = attribute('aWind', 'float');
  const aHeight = attribute('aHeight', 'float');
  const rec0 = inst.element(instanceIndex.mul(2));        // xyz + h
  const rec1 = inst.element(instanceIndex.mul(2).add(1)); // yaw, tipYaw
  const base = rec0.xyz, bladeH = rec0.w, yaw = rec1.x;
  // rotate local blade (X width axis) by yaw, scale height to bladeH
  const cy = cos(yaw), sy = sin(yaw);
  const lx2 = positionLocal.x, ly2 = positionLocal.y.mul(bladeH.div(0.8)), lz2 = positionLocal.z;
  const rx = lx2.mul(cy).sub(lz2.mul(sy));
  const rz = lx2.mul(sy).add(lz2.mul(cy));
  // wind sway phased on WORLD X (seam-free), weighted by aWind (mid/tip)
  const worldX = base.x.add(rx);
  const wave = sin(uTime.mul(uWindSpeed).add(worldX.mul(uWaveSize).mul(float(1).div(uRadius.mul(2)))));
  const isMidTip = clamp(aWind.mul(2), 0, 1);
  const isTip = clamp(aWind.sub(0.6).mul(10), 0, 1);
  const sway = wave.mul(isMidTip.mul(mix(uCenterDist, uTipDist, isTip)));
  const posNode = vec3(base.x.add(rx).add(sway), base.y.add(ly2), base.z.add(rz));

  const { noise2D } = buildGrassNoiseFns();
  const uBase = uniform(new THREE.Color(0x16240e)), uTip = uniform(new THREE.Color(0x5a8a32));
  const uAmbient = uniform(0.55), uKey = uniform(0.55), uCloudStr = uniform(0.35), uCloudScale = uniform(0.15);
  const cloud = float(1).sub(uCloudStr.mul(noise2D(vec2(base.x, base.z).mul(uCloudScale))));
  const colorNode = mix(uBase, uTip, aWind).mul(uAmbient.add(uKey)).mul(cloud);

  const mat = new MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 1, metalness: 0 });
  mat.positionNode = posNode;
  mat.colorNode = colorNode;
  mat.normalNode = vec3(0, 1, 0);

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  return {
    mesh,
    update(seconds) {
      uTime.value = seconds;
      uCam.value.set(camera.position.x, camera.position.z);
      renderer.compute(reset);
      renderer.compute(cull);
    },
    setDensity(d) { uPerCell.value = perCellCount(d, cellSize, Kmax); },
    setRadius(r) { uRadius.value = r; uHalf.value = Math.ceil(r / cellSize) | 0; uSide.value = 2 * uHalf.value + 1; },
    setWind(strength) { uTipDist.value = 0.3 * strength; uCenterDist.value = 0.1 * strength; },
    setTerrain(p) { uBaseAmp.value = p.baseAmp; uLake.value = p.lake; uLakeDepth.value = p.lakeDepth; },
    setWaterLevel(wl) { uWaterMin.value = wl + o.shoreMargin; },
    dispose() { geom.dispose(); mat.dispose(); },
  };
}
```

Note: `setRadius` above changes the window extent but NOT `CAP` (the buffer is sized
once at the initial radius). The host clamps the Radius slider max to the
initial-config radius; growing past `CAP` is a regenerate (Task 6 caps the slider).

- [ ] **Step 2: Syntax check**

Run: `node --check grass-compute.js`
Expected: no output. (Compute can't run in Node; this only catches syntax.)

- [ ] **Step 3: Commit**

```bash
git add grass-compute.js
git commit -m "feat(sp2): grass-compute.js — compute generate+cull, indirect instanced draw"
```

> Browser validation happens in Task 6 once it's wired into the viewer (a module with
> no host can't render on its own).

---

## Task 6: Host integration — `?grass=cpu` flag + Density/Radius/Wind sliders

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Add the grass-mode flag**

Near the top of the module script (after the imports), add:

```js
const GRASS_MODE = new URLSearchParams(location.search).get('grass') || 'gpu';
```

- [ ] **Step 2: Branch the grass loader**

Replace the grass `import('./grass.js?...')` block so the CPU manager only builds
under `?grass=cpu`, and the GPU path builds otherwise. Wrap the existing
`makeChunkGrassManager` body in `if (GRASS_MODE === 'cpu') { ... }` and add the else:

```js
if (GRASS_MODE === 'cpu') {
  import('./grass.js?v=density-fix-4').then(({ createGrass }) => {
    /* ...existing makeChunkGrassManager block unchanged... */
  }).catch(() => {});
} else {
  import('./grass-compute.js').then(({ createComputeGrass }) => {
    Object.assign(params, { grassDensity: 1.0, grassRadius: 48, wind: 1.0 });
    const cg = createComputeGrass({
      renderer, camera,
      terrainParams: { baseAmp: terrain.baseAmp, lake: terrain.lake, lakeDepth: terrain.lakeDepth },
      waterLevel: terrain.waterLevel, density: params.grassDensity, radius: params.grassRadius,
    });
    scene.add(cg.mesh);
    grassRef = {
      update: (s) => cg.update(s),
      sync: () => {}, regenerate: () => {},
      setWind: (st) => cg.setWind(st), applyFade: () => {},
      setTerrain: (p) => cg.setTerrain(p), setWaterLevel: (wl) => cg.setWaterLevel(wl),
    };
    header('Grass');
    slider('grassDensity', 'Density', 0, 4, 0.05, f2, () => cg.setDensity(params.grassDensity));
    slider('grassRadius', 'Radius', 8, 48, 1, fi, () => cg.setRadius(params.grassRadius));
    slider('wind', 'Wind strength', 0, 2.5, 0.01, f2, () => cg.setWind(params.wind));
  }).catch(err => { showError('grass-compute.js could not load (' + err.message + ')'); });
}
```

(The Radius slider max = the initial `radius: 48` so `CAP` is never exceeded — per the
Task-5 note. `f2`/`fi` are the existing slider formatters.)

- [ ] **Step 3: Keep terrain/water edits in sync (GPU path)**

Where the terrain `waterLevel`/amplitude sliders rebuild the world (`worldRebuild`),
also push to grass if present. Find `worldRebuild` and append:

```js
if (grassRef?.setTerrain) grassRef.setTerrain({ baseAmp: terrain.baseAmp, lake: terrain.lake, lakeDepth: terrain.lakeDepth });
if (grassRef?.setWaterLevel) grassRef.setWaterLevel(terrain.waterLevel);
```

- [ ] **Step 4: Syntax check**

Run:
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('environment-viewer.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('.__c.mjs',m[1]);" && node --check .__c.mjs && echo OK && rm -f .__c.mjs
```
Expected: `OK`.

- [ ] **Step 5: Browser checkpoint — parity**

Open `environment-viewer.html` (default `?grass=gpu`). **Pass criteria:**
- Grass renders as a ring around the camera, blades sit on the ground, stay off
  lakes/shore, sway with wind continuously, and **do not swim** when you move (orbit +
  F-walk). The Radius edge **dithers out** (no hard circle). Density/Radius/Wind
  sliders change the field live. HUD `calls` does not climb with draw distance.
- Open `?grass=cpu`: the old per-chunk grass still renders (A/B intact).
- No console errors on either.

- [ ] **Step 6: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(sp2): wire compute grass into viewer behind ?grass flag + Density/Radius sliders"
```

---

## Task 7: dd9 perf gate — `?grass=cpu` vs compute grass

**Files:**
- Add: `research/stats/` (two CSVs)

- [ ] **Step 1: Capture both traces**

At Draw distance 9, in each of `?grass=cpu` and `?grass=gpu`, in the console:
```js
perfStats.clear(); perfStats.intervalMs = 250;
```
pan ~20s, then `perfStats.download()`. Save both into `research/stats/` with `-grasscpu`
/ `-grassgpu` suffixes.

- [ ] **Step 2: Compare cpuMs**

Run the same summary used for SP1 (mean/median/p95 of the `cpuMs` column) over both
files. **Gate:** compute-grass `cpuMs` ≤ `?grass=cpu` `cpuMs` at dd9, and grass draw
calls are O(1) (HUD `calls` flat vs draw distance). Record the numbers.

- [ ] **Step 3: Commit**

```bash
git add research/stats/
git commit -m "perf(sp2): dd9 grass A/B traces — compute grass vs CPU chunk grass"
```

> If the gate fails: most likely CAP/dispatch too large (shrink Kmax/cellSize), a
> per-frame upload (verify buffers are GPU-resident), or the cull not feeding the
> indirect count (re-check Task 4 wiring).

---

## Task 8: Cleanup — remove CPU grass path, delete spike, document

**Files:**
- Modify: `environment-viewer.html` (drop `?grass=cpu` branch + `GRASS_MODE`)
- Delete: `grass-compute-spike.html`
- Modify: `research/webgpu/sp1-migration-notes.md` (append SP2 section)

- [ ] **Step 1: Remove the CPU branch**

Delete the `if (GRASS_MODE === 'cpu') { ... } else` wrapper, keeping only the
compute-grass loader. Remove the `GRASS_MODE` const. (Keep `grass.js`'s exported
`buildBladeGeometry`/`buildGrassNoiseFns` — they're used by the compute path; the
`makeChunkGrassManager`/`createGrass` per-chunk usage is what's removed.)

- [ ] **Step 2: Delete the spike**

```bash
git rm grass-compute-spike.html
```

- [ ] **Step 3: Document**

Append an SP2 section to `research/webgpu/sp1-migration-notes.md`: the compute
generate+cull approach, the confirmed indirect-draw API (from Task 4), the
closed-form TSL height reuse, and the dd9 A/B numbers.

- [ ] **Step 4: Syntax check + Node suite green**

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('environment-viewer.html','utf8');const m=h.match(/<script type=\"module\">([\s\S]*?)<\/script>/);fs.writeFileSync('.__c.mjs',m[1]);" && node --check .__c.mjs && echo OK && rm -f .__c.mjs
for t in test-grass-height-tsl test-grass-cells test-grass-wind test-terrain-field test-terrain-system test-terrain-instanced test-terrain-heightmap-parity test-terrain-tile-seam test-terrain-worker-heighttile; do printf "%-34s " "$t"; node "$t.mjs" >/dev/null 2>&1 && echo PASS || echo FAIL; done
```
Expected: `OK` and all PASS.

- [ ] **Step 5: Commit**

```bash
git add environment-viewer.html research/webgpu/sp1-migration-notes.md
git commit -m "chore(sp2): remove CPU grass path; document compute-grass migration"
```

---

## Self-Review

**Spec coverage:**
- Camera-centered world-anchored cells → Tasks 2 (`grass-cells.js`), 5 (kernel). ✓
- Density + Radius controls → Task 5 setters + Task 6 sliders. ✓
- Closed-form TSL height + Node parity test → Tasks 1 (`grass-height-ref.js` + test), 5 (`buildHeightFn`). ✓
- Temporary `?grass=cpu` flag → Task 6, removed Task 8. ✓
- Per-frame reset→generate-and-cull→indirect draw → Task 5; de-risked Task 4. ✓
- GPU-resident buffers (no per-frame upload) → Task 5 (storage/indirect/atomic). ✓
- Density falloff replacing height-collapse fade → Task 5 cull (`edge`/`keepRand`). ✓
- Shared blade geometry + wind/color graph → Task 3. ✓
- Spike-first → Task 4. ✓
- dd9 A/B gate (cpuMs) → Task 7. ✓
- Node tests (height parity, placement determinism, capacity) + browser checkpoints → Tasks 1, 2, 4, 6, 7. ✓

**Placeholder scan:** No TBD/TODO. GPU steps that can't run in Node have explicit
browser pass-criteria (Tasks 4, 6) — the stated domain reality, not a placeholder.

**Type consistency:** `createComputeGrass` returns `{ mesh, update, setDensity,
setRadius, setWind, setTerrain, setWaterLevel, dispose }` — used consistently in Task
6. `grassHeightRef(params,x,z)`, `candidateBlade(cfg,...)`, `maxInstances(R,cellSize,
Kmax)`, `perCellCount(density,cellSize,Kmax)` signatures match across Tasks 1/2/5.
`buildBladeGeometry()`/`buildGrassNoiseFns()` exports match their Task-3 definitions
and Task-5 imports. Indirect args `[indexCount=9,...]` consistent (blade = 9 indices).

**Caveat:** the exact TSL compute API (`.toAtomic()`, `storage().setPBO()`,
`geometry.indirect`, `uint` bit-op method names) is pinned by the Task-4 spike; Task 5
code uses the planned forms and is adjusted to the spike's confirmed forms before its
browser validation in Task 6. This is the SP1-style version-pinning note, not a gap.
