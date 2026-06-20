# World-Gen Performance: Pragmatic Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Only Rung 1 is bite-sized and executable as written.** Rungs 2–4 are engineering plans that MUST be re-expanded into their own bite-sized plans (via the writing-plans skill) once their entry gate is met — they intentionally do not contain fabricated shader code.

**Goal:** Take the workshop world-gen from "single background worker" to a measured, staged path toward a GPU-driven pipeline, climbing only when profiling data justifies the next rung.

**Architecture:** Four independent rungs. Rung 1 parallelises CPU geometry generation across a worker pool (incremental, same architecture). Rung 2 replaces per-chunk CPU meshes with a CDLOD/clipmap grid displaced in the vertex shader (the biggest structural change for an analytic heightfield). Rung 3 moves grass to a GPU compute → indirect-draw pipeline. Rung 4 converges everything into a GPU-driven renderer. Each rung is gated on `perfStats` evidence.

**Tech Stack:** Three.js r160 (ESM, no bundler), ES module Web Workers, `perfStats` HUD (already built), Node + local `three` for headless tests. Rungs 3–4 introduce WebGPU (`WebGPURenderer` / TSL or raw WGSL).

---

## Guiding Principles

- **DRY / YAGNI / TDD / frequent commits.** Every Rung-1 behavioural change is driven by a Node test using the existing fake-worker harness pattern (`test-terrain-system.mjs`).
- **No build step.** The project runs `.html` directly off a static server. Any rung that would add a toolchain (WASM, WGSL bundling) must isolate it behind an optional, gracefully-degrading path — never a hard dependency.
- **Measure before climbing.** Each rung has an **entry gate** (a `perfStats` condition that justifies the work) and **exit criteria** (what "done" means). Do not start a rung whose entry gate is unmet.
- **Behaviour preservation.** The existing equivalence test (`test-terrain-field.mjs`) and integration test (`test-terrain-system.mjs`) must stay green after every rung that touches terrain.

## Baseline & Measurement Protocol (do this FIRST, before any rung)

The whole ladder is pointless without a baseline. Capture one.

- [ ] **Step B1: Record a baseline trace**

In the browser (served over http), open `environment-viewer.html`, then in the console:

```js
perfStats.clear();
perfStats.intervalMs = 250;           // finer resolution around transitions
// 1. let the scene settle ~5s at default draw distance
// 2. raise Draw distance 2 -> 12, pan the camera continuously for ~15s
// 3. raise Grass "Blade count" toward 1.2M
copy(perfStats.toCSV());               // paste into docs/superpowers/baselines/
```

- [ ] **Step B2: Classify the bottleneck from the CSV**

Read the columns and decide which rung is justified:
- `fps` drops correlate with `calls` rising (many visible chunks) → **draw-call bound** → Rung 2 matters.
- `fps` drops correlate with `triangles` rising (grass blade count) → **vertex/fill bound** → Rung 3 matters.
- Visible *hitches* (single-frame `fps` dips) while streaming, with `geom` climbing in steps → **generation bound** → Rung 1 matters.
- `geom` climbs without bound while moving → a **disposal leak** → fix before anything else.

- [ ] **Step B3: Commit the baseline**

```bash
git add docs/superpowers/baselines/
git commit -m "docs: capture world-gen perf baseline before optimization ladder"
```

> **Gate to proceed at all:** you have a baseline CSV and a named bottleneck. If the bottleneck is "none — it's already smooth at your target settings," stop. YAGNI.

## Baseline Result — 2026-06-19 (captured)

**Trace:** `research/stats/perf-2026-06-19T23-40-51-663Z.csv` (~230 s; draw distance swept 2→6, grass blade count cranked up, continuous panning, trees ~300).

**Classification: draw-call / object-count bound at high draw distance.** Not fill-bound, not terrain-generation-bound, and no leak.

| Condition | chunks | calls | triangles | geometries | fps |
|---|---|---|---|---|---|
| draw dist 2, grass cranked | 25 | ~103 | **~3.0M** | ~95 | **75** |
| draw dist 6, camera still | 169 | **377** | ~1.9M | **~945** | **~40** |
| draw dist 6, panning | 169 | 300–440 | ~1.8M | ~930–1015 | **~28 + jitter** |

**Decisive evidence:** going 25→169 chunks, triangles went *down* (3.0M → 1.9M) while fps *halved* — so fill/vertex throughput is NOT the wall (3.0M tris ran at 75 fps). What exploded: `calls` ×3.7 (103 → ~380) and live `geometries` ×10 (~95 → ~1000) — i.e. 169 terrain + 169 grass + ~3 tree meshes/chunk (mostly empty) + the shadow pass redrawing casters. The extra drop and frame-to-frame jitter while panning is **main-thread grass/tree geometry rebuilds during streaming** (terrain is already off-thread; the `pending` column drains cleanly). `geometries` plateaus ~1000 and falls when chunks unload (t≈229) → **no disposal leak**.

**Consequences for this ladder:**
- **Rung 1 is GATED OUT for this profile.** Terrain generation is not the bottleneck — it is already off-thread and drains. A worker pool would fill faster but would not move the ~40 fps draw-distance-6 ceiling. Revisit only if a future profile shows generation-bound hitches.
- **Recommended order:** (0) cheap tree-mesh win — stop creating 3 meshes per *empty* chunk → (Rung 2) CDLOD terrain → (Rung 3) GPU grass. Rungs 2 and 3 each collapse ~169 per-chunk objects/draw-calls; Rung 3 also removes the panning-jitter main-thread churn.
- This corrects the earlier verbal claim that grass *fill* was the #1 cost: at these settings the wall is **object / draw-call count**, and grass is guilty via per-chunk object multiplication, not triangle throughput.

---

# Rung 1 — Terrain Worker Pool

**Entry gate:** Baseline shows generation-bound hitches (single worker can't keep up while streaming, especially at high draw distance), OR you simply want faster fill.

> **STATUS (2026-06-19): GATED OUT.** The captured baseline is draw-call/object-count bound, not generation-bound (see *Baseline Result* above). Terrain already builds off-thread and `pending` drains, so a pool would not move the draw-distance-6 fps ceiling. **Do not build this rung until a profile shows terrain generation is the bottleneck.** It is kept here in full as reference — it remains the smallest, safest jump if that ever changes.

**Goal:** Build N terrain chunks concurrently across a pool of workers instead of one, keeping all cores busy during streaming.

**Architecture:** Replace `this.worker` (single) with `this.workers` (array) sized from `navigator.hardwareConcurrency`, round-robin dispatch, saturate the pool each `update()`. All correctness machinery (epoch invalidation, in-flight tracking, target-key filtering, sync fallback) is already key/epoch-addressed and worker-agnostic, so it carries over unchanged.

**Files:**
- Modify: `terrain-system.js` (constructor, `initWorker`→`initWorkers`, `disableWorker`→`disableWorkers`, `dispatchChunk`, `update` build loop, `dispose`, `DEFAULTS`)
- Test: `test-terrain-pool.mjs` (new)
- Unchanged: `terrain-field.js`, `terrain-worker.js` (the worker body is identical; we just run more of them)

### Task 1.1: Pool sizing default + failing test for pool creation

**Files:**
- Modify: `terrain-system.js` (DEFAULTS)
- Test: `test-terrain-pool.mjs`

- [ ] **Step 1: Write the failing test**

Create `test-terrain-pool.mjs` (mirrors the fake-worker harness in `test-terrain-system.mjs`, but counts worker instances):

```js
// Headless tests for the terrain worker POOL. Reuses the fake-worker pattern.
import { buildChunkArrays } from './terrain-field.js';

let liveWorkers = 0;
let maxConcurrentInFlight = 0;
const pending = [];   // deferred replies so we can observe concurrency

class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this._alive = true; liveWorkers++; }
  postMessage(msg) {
    pending.push(() => {
      if (!this._alive || !this.onmessage) return;
      const a = buildChunkArrays(msg.xMin, msg.zMin, msg.size, msg.segments, msg.params, msg.computeNormals);
      this.onmessage({ data: { key: msg.key, epoch: msg.epoch, positions: a.positions, normals: a.normals, uvs: a.uvs, index: a.index } });
    });
  }
  terminate() { this._alive = false; liveWorkers--; }
}
globalThis.Worker = function () { return new FakeWorker(); };
globalThis.navigator = { hardwareConcurrency: 8 };

const { createTerrainSystem } = await import('./terrain-system.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failures++; };
// Flush all deferred worker replies, tracking peak concurrency.
async function flush() {
  maxConcurrentInFlight = Math.max(maxConcurrentInFlight, pending.length);
  const jobs = pending.splice(0);
  for (const j of jobs) j();
  await new Promise((r) => setTimeout(r, 0));
}
async function settle(sys, cx, cz, max = 600) {
  for (let i = 0; i < max; i++) {
    sys.update(cx, cz);
    await flush();
    const stale = [...sys.chunks.keys()].some((k) => !sys.targetKeys.has(k));
    if (sys.pendingBuildCount === 0 && !stale) return i;
  }
  return max;
}

console.log('\n[1] pool is created with multiple workers');
{
  const sys = createTerrainSystem({ params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2, renderRadius: 1, chunkSize: 30, maxWorkers: 4 } });
  ok(sys.workers.length === 4, `pool size ${sys.workers.length} (expected 4 = min(maxWorkers, hw-1))`);
  ok(liveWorkers === 4, `live workers ${liveWorkers}`);
  sys.dispose();
  ok(liveWorkers === 0, `workers terminated on dispose (${liveWorkers})`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-terrain-pool.mjs`
Expected: FAIL — `sys.workers` is undefined (system still uses `this.worker`).

- [ ] **Step 3: Add the `maxWorkers` default**

In `terrain-system.js`, add to `DEFAULTS` (after `useWorker`):

```js
  useWorker: true,            // build chunk geometry off-thread when a Web Worker is available
  maxWorkers: 4,              // cap on the worker pool; actual count = min(maxWorkers, hardwareConcurrency-1)
```

- [ ] **Step 4: Re-run (still failing, expected)**

Run: `node test-terrain-pool.mjs`
Expected: FAIL — pool not created yet. Proceed to Task 1.2 (this task only lands the default).

- [ ] **Step 5: Commit**

```bash
git add terrain-system.js test-terrain-pool.mjs
git commit -m "test: add terrain worker-pool harness + maxWorkers default"
```

### Task 1.2: Create the pool (`initWorkers` / `disableWorkers`)

**Files:**
- Modify: `terrain-system.js` (constructor, `initWorker`→`initWorkers`, `disableWorker`→`disableWorkers`, `dispose`)

- [ ] **Step 1: Replace single-worker state in the constructor**

In `terrain-system.js` constructor, replace:

```js
    // Async (worker) build state.
    this.worker = null;
    this.inFlight = new Set();   // chunk keys dispatched to the worker, awaiting a result
    this.epoch = 0;              // bumped on rebuild(); stamped on jobs so stale results are dropped
    this.workerChanged = false;  // a worker chunk landed since the last update() — surface it as "changed"
    if (this.params.useWorker) this.initWorker();
```

with:

```js
    // Async (worker pool) build state.
    this.workers = [];           // pool of terrain workers; empty => synchronous fallback
    this.nextWorker = 0;         // round-robin cursor
    this.inFlight = new Set();   // chunk keys dispatched to the pool, awaiting a result
    this.epoch = 0;              // bumped on rebuild(); stamped on jobs so stale results are dropped
    this.workerChanged = false;  // a worker chunk landed since the last update() — surface it as "changed"
    if (this.params.useWorker) this.initWorkers();
```

- [ ] **Step 2: Replace `initWorker` with `initWorkers`**

Replace the whole `initWorker()` method:

```js
  initWorkers() {
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const count = Math.max(1, Math.min(this.params.maxWorkers, hw - 1));
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this.onWorkerChunk(e.data);
        w.onerror = () => this.disableWorkers();
        this.workers.push(w);
      } catch (err) {
        this.disableWorkers();   // no worker support (e.g. file://) — fall back to synchronous building
        return;
      }
    }
  }

  // True when at least one pool worker is available.
  get hasWorker() { return this.workers.length > 0; }
```

- [ ] **Step 3: Replace `disableWorker` with `disableWorkers`**

Replace the whole `disableWorker()` method:

```js
  // Drop to the synchronous path if a worker errors. Outstanding in-flight keys are
  // cleared and the window is recomputed so they get rebuilt on the main thread.
  disableWorkers() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.inFlight.clear();
    this.centerChunkX = null;   // force update() to recompute the build queue
  }
```

- [ ] **Step 4: Update `dispose`**

In `dispose()`, replace:

```js
    if (this.worker) { this.worker.terminate(); this.worker = null; }
```

with:

```js
    for (const w of this.workers) w.terminate();
    this.workers = [];
```

- [ ] **Step 5: Run the pool-creation test**

Run: `node test-terrain-pool.mjs`
Expected: still FAIL or ERROR — `dispatchChunk`/`update` still reference `this.worker`. That is fixed in Task 1.3. (If the test errors with "this.worker", that confirms the next task is needed.)

- [ ] **Step 6: Commit**

```bash
git add terrain-system.js
git commit -m "feat(terrain): create a worker pool instead of a single worker"
```

### Task 1.3: Round-robin dispatch + saturate the pool each update

**Files:**
- Modify: `terrain-system.js` (`dispatchChunk`, cold-start seed condition, build loop)
- Test: `test-terrain-pool.mjs` (extend)

- [ ] **Step 1: Extend the test for concurrency + correctness**

Append to `test-terrain-pool.mjs` before the final summary:

```js
console.log('\n[2] pool builds multiple chunks concurrently and fills correctly');
{
  maxConcurrentInFlight = 0;
  const sys = createTerrainSystem({ params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2, renderRadius: 2, chunkSize: 30, maxWorkers: 4 } });
  // After one update post-construct, more than one job should be in flight.
  sys.update(0, 0);
  ok(sys.inFlight.size > 1, `concurrent in-flight after one update: ${sys.inFlight.size}`);
  await flush();
  const iters = await settle(sys, 0, 0);
  ok(sys.chunks.size === 25, `loaded ${sys.chunks.size}/25`);
  ok(sys.activeChunks.length === 25, `activeChunks ${sys.activeChunks.length}/25`);
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
  ok(maxConcurrentInFlight > 1, `observed concurrency peak ${maxConcurrentInFlight} (>1)`);
  console.log(`  filled 25 chunks in ${iters} settle iterations`);
  sys.dispose();
}

console.log('\n[3] epoch invalidation still holds across the pool');
{
  const sys = createTerrainSystem({ params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2, renderRadius: 1, chunkSize: 30, maxWorkers: 4 } });
  sys.update(0, 0);
  const e0 = sys.epoch;
  sys.rebuild({ lakeDepth: 5 });
  ok(sys.epoch === e0 + 1, `epoch bumped ${e0} -> ${sys.epoch}`);
  await flush();                 // stale (old-epoch) replies arrive and must be dropped
  await settle(sys, 0, 0);
  ok(sys.chunks.size === 9, `refilled ${sys.chunks.size}/9 after rebuild`);
  ok(sys.params.lakeDepth === 5, 'new param applied');
  sys.dispose();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-terrain-pool.mjs`
Expected: FAIL/ERROR referencing `this.worker` in `dispatchChunk`/`update`.

- [ ] **Step 3: Update `dispatchChunk` to round-robin**

Replace the `dispatchChunk` method:

```js
  dispatchChunk(item, chunkSize) {
    const segments = Math.max(this.params.minSegmentsPerChunk, Math.round(chunkSize * 0.75));
    this.inFlight.add(item.key);
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    worker.postMessage({
      key: item.key,
      epoch: this.epoch,
      xMin: item.ix * chunkSize,
      zMin: item.iz * chunkSize,
      size: chunkSize,
      segments,
      computeNormals: true,
      params: fieldParams(this.params),
    });
  }
```

- [ ] **Step 4: Update the cold-start seed condition**

In `update()`, change the cold-start guard from `this.worker` to `this.hasWorker`:

```js
    if (this.hasWorker && this.chunks.size === 0 && this.inFlight.size === 0 && this.buildQueueIndex < this.buildQueue.length) {
```

- [ ] **Step 5: Replace the build loop to saturate the pool**

Replace the existing `maxBuilds` block:

```js
    const maxBuilds = Math.max(1, Math.floor(this.params.maxChunksPerUpdate));
    for (let i = 0; i < maxBuilds && this.buildQueueIndex < this.buildQueue.length; i++) {
      const item = this.buildQueue[this.buildQueueIndex++];
      if (this.chunks.has(item.key) || this.inFlight.has(item.key) || !this.targetKeys.has(item.key)) {
        i--;
        continue;
      }
      if (this.worker) {
        this.dispatchChunk(item, chunkSize);   // builds off-thread; lands in onWorkerChunk
      } else {
        const chunk = this.createChunk(item.key, item.ix * chunkSize, item.iz * chunkSize, chunkSize);
        this.addChunk(chunk);
        changed = true;
      }
    }
```

with:

```js
    if (this.hasWorker) {
      // Keep the pool saturated: dispatch until every worker has a job in flight
      // (or the queue empties). The pool size bounds concurrency; results land in
      // onWorkerChunk between frames.
      while (this.inFlight.size < this.workers.length && this.buildQueueIndex < this.buildQueue.length) {
        const item = this.buildQueue[this.buildQueueIndex++];
        if (this.chunks.has(item.key) || this.inFlight.has(item.key) || !this.targetKeys.has(item.key)) continue;
        this.dispatchChunk(item, chunkSize);
      }
    } else {
      const maxBuilds = Math.max(1, Math.floor(this.params.maxChunksPerUpdate));
      for (let i = 0; i < maxBuilds && this.buildQueueIndex < this.buildQueue.length; i++) {
        const item = this.buildQueue[this.buildQueueIndex++];
        if (this.chunks.has(item.key) || !this.targetKeys.has(item.key)) { i--; continue; }
        const chunk = this.createChunk(item.key, item.ix * chunkSize, item.iz * chunkSize, chunkSize);
        this.addChunk(chunk);
        changed = true;
      }
    }
```

- [ ] **Step 6: Run the pool tests**

Run: `node test-terrain-pool.mjs`
Expected: ALL PASS (pool created, concurrency peak > 1, 25 chunks fill, epoch invalidation holds).

- [ ] **Step 7: Run the existing suites to confirm no regression**

Run: `node test-terrain-field.mjs && node test-terrain-system.mjs`
Expected: both ALL PASS. (`test-terrain-system.mjs` exercises the single-worker-shaped fake; it should still pass because a pool of 1+ behaves identically per-key. If it asserts `sys.worker`, update those assertions to `sys.hasWorker`.)

- [ ] **Step 8: Commit**

```bash
git add terrain-system.js test-terrain-pool.mjs
git commit -m "feat(terrain): round-robin dispatch across the worker pool"
```

### Task 1.4: Tune pool size + verify in-browser

**Files:**
- Modify: `environment-viewer.html` (optional: expose pool size / show it in `perfStats`)

- [ ] **Step 1: (Optional) surface the worker count in the HUD**

In `environment-viewer.html` `updateTerrainDebug`, add to the text block:

```js
    `workers ${terrainSystem.workers.length}\n` +
```

- [ ] **Step 2: Browser verification**

Hard-refresh `environment-viewer.html`. In DevTools → Sources, confirm multiple `terrain-worker.js` threads. Record a trace at draw distance 12 while panning:

```js
perfStats.clear(); perfStats.intervalMs = 250;
// pan continuously across fresh terrain ~15s
copy(perfStats.toCSV());
```

- [ ] **Step 3: Compare against baseline**

Exit criteria (vs Step B1 baseline): streaming hitches reduced (fewer/smaller single-frame `fps` dips while `geom` climbs), and the field fills faster (chunks reach target in fewer seconds). If `hardwareConcurrency` is low (≤2), expect little gain — note it and stop.

- [ ] **Step 4: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(viewer): show terrain worker count in perf HUD"
```

**Rung 1 exit criteria:** Pool tests green; existing suites green; browser shows N worker threads; streaming hitch measurably reduced or shown to be already non-dominant. **Stop here unless the baseline named a different (draw-call or fill-rate) bottleneck.**

### Rung 1 Appendix — WASM/SIMD noise (deferred, likely YAGNI for this project)

Your height field is a closed-form `sin/cos` sum + value-noise (`terrain-field.js`). It is already cheap; the worker hides it. WASM+SIMD would add a **build toolchain** (Rust/AssemblyScript), which contradicts the project's no-build rule. **Do not implement unless** a profiler (worker self-timing via `performance.now()` around `buildChunkArrays`) shows the field math — not array allocation or transfer — is the pool's bottleneck. If ever justified, isolate it: ship a `.wasm` + a JS fallback so `file://` and no-WASM environments still work. Track as a separate spec.

---

# Rung 2 — CDLOD / Clipmap Terrain (vertex-shader displacement)

> **This rung is an engineering plan, not bite-sized steps. Before executing, re-run the writing-plans skill to expand each milestone into TDD tasks once Milestone 0 (spike) resolves the open shader decisions.**

**Entry gate:** Baseline (or post-Rung-1 trace) shows **draw-call bound** — `fps` falls as `calls` rises with visible chunk count at high draw distance — and/or you want true continuous LOD instead of uniform-resolution chunks. This is the highest-leverage rung for an analytic heightfield.

> **STATUS (2026-06-19): GATE MET.** The captured baseline is draw-call/object-count bound (calls ×3.7, geometries ×10, fps halved while triangles fell). This is the recommended next structural rung, after the cheap tree-mesh pre-win.

**Goal:** Replace N per-chunk CPU meshes with a small set of **reusable grid meshes** displaced in the vertex shader by `terrainHeightAt` (evaluated directly or sampled from a baked heightmap), with continuous distance LOD and morphing so there are no cracks or popping. CPU stops generating terrain geometry and stops issuing one draw call per chunk.

**Why it fits this project:** `terrainHeightAt` is closed-form and deterministic — ideal to port into GLSL (or to bake into a float heightmap), so the vertex shader can compute height with no CPU readback. The existing seam-free analytic normal (`terrainNormalAt`) ports the same way.

### File structure

- Create: `terrain-clipmap.js` — owns the reusable ring/grid geometries, per-level uniforms, and the camera-follow update. Replaces `terrain-system.js`'s mesh-streaming role for *rendering* (collision keeps a separate path; see open questions).
- Create: `shaders/terrain-displace.glsl.js` — exported GLSL strings: vertex shader that (a) samples/evaluates height, (b) computes analytic normal, (c) morphs between LOD levels; fragment shader matching the current MeshStandard look (or a custom-injected `onBeforeCompile`).
- Modify: `terrain-field.js` — add a GLSL port of `terrainHeightAt`/`terrainNormalAt` as exported template strings (single source of truth shared by a heightmap-bake path and the shader), plus an optional `bakeHeightTile(...)` that fills a `Float32Array` heightmap for a tile (reuses the JS function).
- Modify: `environment-viewer.html` — swap the terrain system construction; keep `getHeight(x,z)` available for grass/trees/collision (still the JS `terrainHeightAt`).
- Modify/keep: `terrain-system.js` — retain for **collision colliders only** (small, near-player), or extract collision into `terrain-collision.js`.
- Test: `test-terrain-glsl-parity.mjs` — verify the GLSL height port matches the JS `terrainHeightAt` (run the GLSL via a headless GL or by transpiling the expression and sampling; if headless GL is unavailable, assert against a JS mirror of the exact same expression to prevent drift).

### Milestones

**Milestone 0 — Spike & decision (timeboxed, throwaway):**
- Decide **CDLOD vs geometry clipmaps.** Recommendation: **CDLOD** (quadtree of grid patches + vertex morph) — better for a single camera with large view distance and simpler crack handling than toroidal clipmap updates.
- Decide **height source:** evaluate `terrainHeightAt` directly in GLSL (no texture, perfect for a cheap analytic field) **vs** bake heightmap tiles into a float texture and sample (better if the field later becomes expensive). Recommendation: **direct GLSL evaluation** first; it removes all streaming/baking from terrain entirely.
- Decide **normals:** analytic central-difference in the shader (mirror `terrainNormalAt`) vs derivative-based. Recommendation: analytic (matches existing seam-free result).
- Output: a one-screen spike proving a single displaced grid renders the current terrain shape with correct normals/lighting. Throw the spike away; keep the decisions.

**Milestone 1 — Single displaced grid:** one reusable `PlaneGeometry` grid, vertex shader displaces by GLSL `terrainHeightAt`, fragment matches current shading. Acceptance: visually identical hills to current terrain at close range; `calls` for terrain drops to a small constant.

**Milestone 2 — CDLOD levels + morph:** quadtree selection of grid patches by camera distance, vertex-shader morph between adjacent levels (no popping), skirts/stitching for crack-free seams. Acceptance: no cracks/popping while moving; triangle count bounded and roughly constant regardless of draw distance.

**Milestone 3 — Integration:** grass/trees keep using JS `getHeight`; collision uses the retained collider path (near-player only). Water binds to the new terrain extent. Acceptance: full scene runs; `test-terrain-field.mjs` parity still green; grass sits on terrain correctly.

**Milestone 4 — Retire CPU terrain streaming:** remove or demote `terrain-system.js` mesh streaming (keep collision). Acceptance: terrain `geom` count is now a small constant; draw-call count flat vs draw distance.

### Testing strategy
- **GLSL/JS parity test** (`test-terrain-glsl-parity.mjs`): the height expression exists once; both JS and GLSL derive from it. Assert sampled equality at a grid of points to prevent the two from drifting.
- Keep `test-terrain-field.mjs` for the JS path used by grass/trees/collision.
- Manual: crack/popping inspection while moving; `perfStats` flat-draw-call confirmation.

### Risks / open questions
- **Collision:** the FPS octree currently consumes terrain collider meshes. CDLOD displaces in-shader, so the CPU has no terrain mesh for the octree. Resolution: keep a tiny CPU-meshed collision patch around the player (the existing `collisionRadius` path already does exactly this — it's why we kept it independent). Document this dependency explicitly.
- **Shader maintainability:** porting `terrainHeightAt` to GLSL duplicates math. Mitigate with the parity test and a shared expression source.
- **Lighting parity:** reproducing `MeshStandardMaterial` exactly via custom shader is fiddly; prefer `material.onBeforeCompile` injection of displacement+normal into the standard shader over a from-scratch shader.

**Rung 2 exit criteria:** terrain draw calls flat and small across draw distance; bounded triangle count; no cracks/popping; parity test green; collision still works in walk mode.

---

# Rung 3 — GPU Compute-Driven Grass

> **Engineering plan. Re-expand into bite-sized tasks after Milestone 0 picks the API (WebGPU vs WebGL2 transform-feedback).**

**Entry gate:** Baseline shows **vertex/fill bound** — `fps` falls as grass `triangles` rises — and the per-blade shader fade (already shipped) isn't enough because the vertex shader still processes every blade.

**Goal:** Move grass from a CPU-built merged mesh per chunk to a GPU pipeline: a **compute shader** generates per-blade instance transforms and performs **frustum + distance culling**, feeding an **indirect instanced draw**. The CPU never touches a blade; density-by-distance is continuous (the correct version of the fade hack).

**Why:** Grass is the established #1 cost (we measured this reasoning earlier). This is the proper SOTA fix.

### File structure
- Create: `grass-gpu.js` — owns the compute pipeline, instance/indirect buffers, and per-frame dispatch. Public API mirrors the current `grass.js` host contract (`setWind`, `setFade`, `applyFade`, `sync`) so `environment-viewer.html` swaps cleanly.
- Create: `shaders/grass-cull.wgsl.js` (or GLSL transform-feedback variant) — compute pass: generate blade instances in a region around the camera, cull by frustum + distance, write surviving instances + an indirect draw-args buffer.
- Create: `shaders/grass-draw.wgsl.js` — instanced vertex/fragment for blades (port the existing wind/fade/cloud look from `grass.js`).
- Modify: `environment-viewer.html` — feature-detect WebGPU; use `grass-gpu.js` when available, else keep current `grass.js`.
- Keep: `grass.js` — the CPU fallback (no-WebGPU / file://).
- Test: `test-grass-density.mjs` — validate the JS-side instance generation math (placement, water rejection, distance falloff) headlessly, independent of the GPU.

### Milestones
**Milestone 0 — API decision spike:** WebGPU compute + `drawIndirect` (preferred, clean) vs WebGL2 transform-feedback + `drawArraysInstanced` (works without WebGPU but clunky). Recommendation: **WebGPU** (`THREE.WebGPURenderer` or raw device), with `grass.js` as the universal fallback. Verify `environment-viewer` can host a WebGPU renderer alongside the rest (or run grass on a separate device/pass).
**Milestone 1 — Instanced draw, CPU-generated instances:** prove instanced blades render with the existing look (no compute yet). Acceptance: visual parity with current grass.
**Milestone 2 — Compute generation:** move instance generation to a compute pass over a camera-centered region; deterministic per-cell seeding (reuse the `hash2` value-noise approach) so it matches the field placement. Acceptance: density continuous, follows camera, no chunk steps.
**Milestone 3 — Compute culling + indirect draw:** frustum + distance cull in compute; write `drawIndirect` args. Acceptance: `triangles` scales with *visible/near* blades only; CPU `calls` for grass is a small constant; large blade budgets no longer tank `fps`.
**Milestone 4 — Water/shore + wind/fade parity:** port shore rejection (height ≥ waterLevel+margin) and the wind/fade/cloud shading. Acceptance: grass off lakebeds; seamless wind; smooth far fade.

### Testing strategy
- Headless JS test of the instance-generation math (placement determinism, water rejection, distance weighting) — the GPU port must match it.
- Manual `perfStats`: confirm `triangles` decouples from total blade budget and tracks visible blades.
- Visual: seamless wind (the earlier fix), continuous density, off-water.

### Risks
- **WebGPU availability/coexistence** with the existing WebGL renderer — may require running the whole viewer on `WebGPURenderer`, which can perturb materials (water/shadows). Spike this in Milestone 0.
- **Determinism** between CPU fallback and GPU path — keep one documented seeding scheme.
- **Scope:** this is the largest rung. Do not start before Rung 2, since a GPU terrain + GPU grass share the renderer decision.

**Rung 3 exit criteria:** grass `triangles` tracks visible blades not total budget; grass draw calls constant; CPU off the blade path; fallback path intact.

---

# Rung 4 — Full GPU-Driven Pipeline

> **Engineering plan / north star. Only meaningful after Rungs 2 & 3 land, because it composes them.**

**Entry gate:** Rungs 2 and 3 done, and the remaining cost is CPU-side scene traversal / draw-call submission / main-thread jank — i.e., `calls` and frame pacing dominated by CPU, not GPU.

**Goal:** A renderer where the CPU sets up passes and the GPU decides what to draw: **compute-based frustum/occlusion culling** producing **indirect draws** for terrain patches, grass, and trees; optionally the whole render loop on **OffscreenCanvas** in a worker so DOM/GC never touches frames.

### Components (each its own future spec)
- **Indirect draw for terrain (CDLOD patch selection in compute)** — extends Rung 2: patch selection + culling on GPU, `multiDrawIndirect`.
- **Trees via GPU instancing + compute cull** — requires first extracting raw tree geometry (the Three.js generator isn't worker/GPU-friendly today); bake species meshes once, instance + cull on GPU. This is a prerequisite sub-spec.
- **OffscreenCanvas render thread** — move `renderer` + loop into a worker; main thread only handles input/UI. Biggest win for main-thread jank; significant plumbing (input forwarding, resize, context transfer).
- **GPU occlusion culling** — hierarchical-Z / two-pass; only if frustum culling proves insufficient.

### Milestones (high level)
- M1: terrain indirect draw (build on Rung 2).
- M2: trees → bakeable instanced meshes + GPU cull (prerequisite: tree-geometry extraction spec).
- M3: unify culling into one compute pass producing all indirect args.
- M4: OffscreenCanvas render thread.

### Testing strategy
- Per-component headless validation of cull math (which instances survive a given frustum) before GPU port.
- `perfStats`: CPU `calls` becomes near-constant regardless of scene size; frame pacing stable under load.

### Risks
- Highest complexity; diminishing returns unless content scale justifies it.
- OffscreenCanvas + WebGPU + Three.js interaction is the least-trodden path — heavy spiking required.
- Trees need a generator refactor first — treat as a blocking sub-spec.

**Rung 4 exit criteria:** CPU draw-call submission ~constant vs scene size; main-thread frame pacing stable under max content; all paths retain a non-GPU-driven fallback.

---

## Cross-Rung Self-Review Checklist (run after expanding any rung)
- Every milestone maps to an entry gate condition from the baseline protocol.
- No fabricated shader code shipped as "complete" — spikes resolve unknowns first.
- Each rung keeps a graceful fallback (no-worker / no-WebGPU / file://).
- Behaviour-preservation tests (`test-terrain-field.mjs`, parity tests) stay green.
- Collision (FPS octree) remains functional through the terrain rewrite (Rung 2 risk).
- Determinism preserved where CPU and GPU paths must agree (grass placement).

## Definition of Done (whole ladder)
You are done with the ladder when `perfStats` at your target content settings shows stable `fps` with headroom and no single dominant bottleneck — **or** when the next rung's entry gate is unmet (the pragmatic stop). Climbing further than the data justifies is a YAGNI violation.
