# SP7 Frame Pacing and Main-Thread Split - Implementation Plan

> Steps use checkbox syntax for tracking. GPU steps require browser checkpoints because this
> workspace cannot validate WebGPU headlessly.

**Goal:** Identify the actual frame stall, reduce unnecessary GPU submit/wait cost, and move the
remaining scalable CPU jobs off the main thread in the right order.

**Spec:** `docs/superpowers/specs/2026-06-25-sp7-frame-pacing-main-thread-design.md`

## Current evidence

Latest trace: `research/stats/perf-2026-06-25T19-37-32-226Z.csv`.

| metric | value |
|---|---:|
| mean CPU frame time | 74.0 ms |
| median CPU frame time | 47.9 ms |
| p95 CPU frame time | 177.8 ms |
| max CPU frame time | 527.9 ms |
| mean fps | 19.3 |

The trace does not expose per-pass time. Do not optimize by guessing beyond the first low-risk
submit-batching changes. Add the profiler first.

## Task 1 - Add pass-level frame profiling

**Files:**
- Create: `frame-profiler.js`
- Create: `test-frame-profiler.mjs`
- Modify: `environment-viewer.html`

- [x] Step 1: Create a pure profiler helper.

`frame-profiler.js` should export `createFrameProfiler({ smoothing = 0.2 })` with:

- `beginFrame()`
- `time(name, fn)`
- `timeAsync(name, fn)`
- `recordGpu(name, ms)` — store an externally-supplied GPU pass duration (from timestamp queries)
- `markDropped()` — increment the dropped-frame counter
- `snapshot(prefixMap)` returning stable numeric fields (CPU wall + GPU + dropped)
- `reset()`

It should store both latest and smoothed values. Keep it independent of Three.js and DOM — the
helper only stores durations; the caller reads timestamp queries from the renderer and feeds them in
via `recordGpu`.

- [x] Step 2: Node-test the helper.

`test-frame-profiler.mjs` should verify:

- sync timings are recorded under the requested name,
- async timings are awaited and recorded,
- `recordGpu(name, ms)` values surface in the snapshot under the GPU field,
- `markDropped()` increments the dropped-frame counter and `reset()` clears it,
- missing fields snapshot as `0`,
- reset clears values.

Run:

```bash
node test-frame-profiler.mjs
```

- [x] Step 3: Enable GPU timestamp queries.

Implementation note after the first browser trace: timestamp query resolution is gated behind
`?timestamps=on` and defaults off. Resolving timestamps maps a GPU buffer, so enabling it on every
normal profiling run can itself make the app slower. Use default `?timestamps=off` for baseline
pass-wall traces, and run a short `?timestamps=on` diagnostic only when GPU duration is needed.

Construct the `WebGPURenderer` with `trackTimestamp: true`. After each frame's submits, read true GPU
pass durations via `await renderer.resolveTimestampsAsync(...)` and/or `renderer.info.render.timestamp`
and `renderer.info.compute.timestamp` (milliseconds), and feed them into the profiler with
`recordGpu('grassGpu', ms)` etc. This is what lets the trace separate CPU wall from GPU execute time
— the whole point of Phase A per the spec. If `trackTimestamp` is unsupported on the device, the GPU
columns snapshot as `0` and the trace degrades to CPU-wall only (do not crash).

- [x] Step 4: Count dropped frames.

The render loop already drops a vsync when `_frameBusy` is true (`environment-viewer.html:1872`). Call
`frameProfiler.markDropped()` on that early-return path so the CSV records how often a frame outran
vsync.

- [x] Step 5: Wire the profiler into `environment-viewer.html`.

Wrap the frame loop blocks:

- `sky`
- `terrainWindow`
- `creatures`
- `water`
- `hud`
- `grassGpu`
- `forestGpu`
- `cdlodGpu`
- `lightsGpu`
- `particlesGpu`
- `postRender`

Add the profiler fields to `perfLog.snapshot()`:

- `passSkyMs`
- `passTerrainWindowMs`
- `passCreaturesMs`
- `passWaterMs`
- `passHudMs`
- `passGrassMs`
- `passForestMs`
- `passCdlodMs`
- `passLightsMs`
- `passParticlesMs`
- `passPostMs`
- `passGpuAwaitMs` (sum of the GPU await pass fields, CPU wall)

Plus the GPU-side timestamp columns and dropped-frame count:

- `gpuGrassMs`
- `gpuForestMs`
- `gpuCdlodMs`
- `gpuLightsMs`
- `gpuParticlesMs`
- `gpuPostMs`
- `droppedFrames`

- [x] Step 6: Syntax and logic checks.

Run:

```bash
node test-frame-profiler.mjs
```

Extract the module script from `environment-viewer.html` and run `node --check` as done in prior
SPs.

- [ ] Step 7: Browser checkpoint.

Open:

```text
http://127.0.0.1:8001/environment-viewer.html?forest=gpu
```

Record a 30-60 second trace with `perfStats.intervalMs = 250`. Confirm the CSV contains the new CPU
pass columns, the `gpu*Ms` timestamp columns, and `droppedFrames`. Confirm the trace lets you
classify the top stall as CPU-bound (large `pass*Ms`, small `gpu*Ms`) or GPU-bound (large `gpu*Ms`).
If `trackTimestamp` is unsupported, note that the GPU columns are `0` and the classification falls
back to CPU-wall only.

- [ ] Step 8: Commit.

```bash
git add frame-profiler.js test-frame-profiler.mjs environment-viewer.html
git commit -m "SP7: add pass-level frame profiler to perf traces"
```

## Task 2 - Batch legal compute-submit chains

**Files:**
- Modify: `grass-compute.js`
- Modify: `cdlod-terrain.js`
- Modify: `particles.js`

- [x] Step 1: Batch grass compute submits.

Change:

```js
await renderer.computeAsync(reset);
await renderer.computeAsync(cull);
await renderer.computeAsync(finalize);
```

to:

```js
await renderer.computeAsync([reset, cull, finalize]);
```

Keep the await. Do not fire-and-forget.

- [x] Step 2: Batch CDLOD compute submits.

Use the same `computeAsync([reset, select, finalize])` shape.

- [x] Step 3: Batch particle compute submits.

For each particle field, change to `computeAsync([reset, simulate, finalize])`. Do not combine
multiple fields into one call in this task.

- [x] Step 4: Syntax check all modified modules.

Run `node --check` on each changed module.

- [ ] Step 5: Browser checkpoint.

Record a short trace before and after, or compare against the Task 1 trace. Confirm no grass,
terrain, or particle flicker and check whether `passGrassMs`, `passCdlodMs`, or `passParticlesMs`
fall.

- [ ] Step 6: Commit.

```bash
git add grass-compute.js cdlod-terrain.js particles.js
git commit -m "SP7: batch reset-cull-finalize compute submits"
```

## Task 3 - Add cell-based GPU grass recull

**Files:**
- Modify: `grass-compute.js`
- Modify: `environment-viewer.html`

- [x] Step 1: Add a URL flag.

In the viewer:

```js
const GRASS_RECULL_MODE = new URLSearchParams(location.search).get('grassRecull') || 'cell';
```

Pass it into `createComputeGrass`.

- [x] Step 2: Track dirty state in `grass-compute.js`.

Grass should always update `uTime`, but only run `reset/cull/finalize` when:

- `grassRecull === 'frame'`,
- camera grid cell changed,
- radius, density, terrain, water level, or force flag changed.

Expose:

- `forceRecull()`
- `stats.reculls`
- `stats.lastCell`

Make existing setters mark dirty when they change inputs used by cull/generation.

- [x] Step 3: Keep visual correctness.

Wind must keep animating while no recull happens. This should work because the draw material reads
`uTime`.

- [ ] Step 4: Browser A/B.

Compare:

```text
?grassRecull=frame
?grassRecull=cell
```

Criteria:

- no grass blinking,
- no stale empty grass after radius/density changes,
- no visible swimming,
- lower `passGrassMs` when camera is still or moving inside a cell.

- [ ] Step 5: Commit.

```bash
git add grass-compute.js environment-viewer.html
git commit -m "SP7: recull GPU grass only on cell crossing or dirty params"
```

## Task 4 - Decide the next bottleneck from measured pass data

**Files:**
- Modify: `research/webgpu/sp1-migration-notes.md`
- Add: new CSV traces in `research/stats/`

- [ ] Step 1: Record fresh traces.

Use draw distance 9 or the current repro settings. Capture at least:

```text
default
?grassRecull=frame
?grassRecull=cell
?post=off
?post=scene
?post=output
?post=grade
?post=full
?particles=off
?lights=off
```

Use `perfStats.intervalMs = 250`.

Post graph modes are diagnostic only:

- `?post=off` uses plain `renderer.render`.
- `?post=scene` uses the post-processing scene texture only.
- `?post=output` adds `renderOutput`.
- `?post=grade` adds the neutral grade node.
- `?post=full`/`?post=on` uses the current bloom graph plus grade.

- [ ] Step 2: Summarize top pass costs.

Add a short SP7 section to `sp1-migration-notes.md` with:

- top pass by p95,
- top pass by mean,
- whether the stall is GPU-await or true JS (use the `pass*Ms` vs `gpu*Ms` split, not CPU wall
  alone),
- the dropped-frame rate,
- the next task chosen from evidence.

- [ ] Step 3 (candidate): Single cross-subsystem compute submit.

**Gate:** do this only if Step 2 shows the dominant cost is GPU-await wall — i.e. the summed
`pass*Ms` GPU-await blocks are large while each individual `gpu*Ms` pass duration is small. That
signature means the loop is paying for ~5 serial CPU↔GPU round-trips, not for any one slow pass.

The grass/forest/cdlod/lights/particles compute passes have no mutual data hazard; the only barrier
is that all indirect counts must be written before the draw reads them. Collapse the five serial
awaits into one submit:

```js
await renderer.computeAsync([
  ...grassNodes, ...forestNodes, ...cdlodNodes, ...lightNodes, ...particleNodes,
]);
// then render
```

Constraints (do not skip — SP2-SP6 race history):

- Land behind an A/B flag: `?computeSubmit=batched` vs `?computeSubmit=serial` (default `serial`
  until the checkpoint passes).
- Browser checkpoint must prove no grass/terrain/forest/particle flicker across a moving camera.
- Compare `passGpuAwaitMs` and per-pass `gpu*Ms` before/after; the batched path should cut the
  await wall without raising any individual GPU pass duration.
- Do not promote `batched` to default until the checkpoint is recorded in `sp1-migration-notes.md`.

If Step 2 instead shows a single slow GPU pass dominates, **skip this step** and tune that pass
directly (per the spec stop condition).

- [ ] Step 4: Commit.

```bash
git add research/stats/ research/webgpu/sp1-migration-notes.md environment-viewer.html
git commit -m "SP7: record pass-level frame pacing traces"
```

## Task 5 - Move forest placement records to a worker

Do this only after Task 4 confirms forest placement or chunk-change work is visible, or if chunk
streaming still causes spikes.

**Files:**
- Create: `forest-placement-job.js`
- Create: `forest-placement-worker.js`
- Create: `test-forest-placement-job.mjs`
- Modify: `environment-viewer.html`

- [ ] Step 1: Extract worker-safe placement job.

`forest-placement-job.js` should export a pure function:

```js
buildForestPlacementJob({ chunks, forestParams, terrainParams })
```

It returns:

```js
{
  chunks: [{ key, records, trunks }]
}
```

The worker-safe path must use the same placement math as `forest-placement.js` and the same terrain
height function as the visible terrain.

- [ ] Step 2: Node parity test.

For fixed chunks and params, assert worker-job records match the direct `placementRecords(...)`
reference.

- [ ] Step 3: Add the worker.

`forest-placement-worker.js` accepts a message with chunks/params and replies with grouped records
and trunks.

- [ ] Step 4: Wire the viewer.

When `FOREST_MODE === 'gpu'`, chunk sync should request worker records and then call:

```js
forestGPU.setChunk(key, records)
trunkIndex.setTrunks(key, trunks)
```

Keep a synchronous fallback for no-worker environments.

- [ ] Step 5: Browser checkpoint.

Move across chunk boundaries. Confirm:

- trees appear in the same places,
- trunk collision still matches visible trees,
- no ghost trunks after chunk unload,
- chunk-change spikes are reduced.

- [ ] Step 6: Commit.

```bash
git add forest-placement-job.js forest-placement-worker.js test-forest-placement-job.mjs environment-viewer.html
git commit -m "SP7: move GPU forest placement records to a worker"
```

## Task 6 - Creature worker spike

Do this after pass data shows creature simulation is a meaningful JS cost or after the GPU-await
wall is reduced enough that creatures become the next wall.

**Files:**
- Create: `creature-worker-protocol.md`
- Create: `creature-sim-worker.js` (spike)
- Create: `test-creature-worker-step.mjs`
- Modify later: `port-creature-bridge.js`, `port-creature-system.js`

- [ ] Step 1: Define the snapshot protocol.

Document the main/worker messages:

- init params,
- terrain params,
- trunk buckets,
- input commands,
- simulation tick,
- render snapshot,
- stats.

Specify the **render-snapshot transport**, not just its contents: per-tick snapshots must be a flat
reusable `Float32Array` (id/pos/yaw/pose at fixed strides) sent as a transferable, or a
`SharedArrayBuffer` double-buffered between worker and main. A plain per-frame object re-introduces
structured-clone + GC cost that scales with creature count — the exact cost this task removes. The
object form is for the Node parity test only.

- [ ] Step 2: Extract one deterministic simulation step.

Before moving the whole system, expose a worker-safe single-step function that can be tested in
Node with deterministic inputs.

- [ ] Step 3: Node-test parity.

`test-creature-worker-step.mjs` should compare main-thread and worker-safe one-step results for
position, velocity, yaw, and leg targets within tolerances.

- [ ] Step 4: Browser spike behind a flag.

Add `?creatures=worker` only after the Node parity test. Main thread should still own Three.js
meshes and apply render snapshots.

- [ ] Step 5: Gate.

The worker path must reduce `passCreaturesMs` without increasing visible latency or breaking
interaction commands.

## Task 7 - Final notes and handoff

**Files:**
- Modify: `docs/superpowers/HANDOFF.md`
- Modify: `research/webgpu/sp1-migration-notes.md`
- Optionally modify: `research/webgpu/webgpu-parallelism-over-serial-synthesis.html`

- [ ] Step 1: Update handoff with SP7 status and the new bottleneck.
- [ ] Step 2: Update migration notes with measured before/after values.
- [ ] Step 3: Sync research docs to `../workshop/research/webgpu/` if those docs changed.
- [ ] Step 4: Commit.

## Stop conditions

Stop and do not proceed to worker refactors if Task 1 shows the dominant cost is a specific GPU
pass that can be tuned directly. Move workers only for true JS work or chunk-change work.

Do not remove awaits unless a browser checkpoint proves the draw does not race the compute output.
