# SP7 - Frame pacing and main-thread split - Design Spec

**Date:** 2026-06-25
**Branch:** `sp1-webgpu-renderer-migration` (`workshop-webgpu/`)
**Status:** scoped, not implemented.

## Problem

The renderer has already moved the heavy visual subsystems onto WebGPU:

- CDLOD terrain selection and draw
- grass generation, cull, and indirect draw
- forest cull and indirect draw
- clustered lights
- particles
- post-processing

The newest trace (`research/stats/perf-2026-06-25T19-37-32-226Z.csv`) still shows poor frame
pacing:

| metric | value |
|---|---:|
| rows | 135 |
| mean CPU frame time | 74.0 ms |
| median CPU frame time | 47.9 ms |
| p95 CPU frame time | 177.8 ms |
| max CPU frame time | 527.9 ms |
| mean fps | 19.3 |

The scene counters are mostly flat during the slow part of the run: `terrainDraws = 1`,
`targetChunks = 25`, `pending = 0`, `forestInstances ~= 17`, and creature simulation usually
reports only `1-3 ms`. That means the remaining lag is not explained by CPU terrain generation,
per-chunk forest baking, or creature simulation alone.

The likely wall is **frame serialization around awaited GPU work**. The main thread awaits multiple
WebGPU compute/render promises in sequence:

```js
await grassRef.update(...)
await forestGPURef.update()
await cdlodRef.update()
await clusteredLightsRef.update(...)
for (const e of particleFields) await e.field.update(...)
await postFX.renderAsync()
```

Some of this waiting is required for correctness because indirect draw counts must be written before
the render pass reads them. But the current frame has no pass-level timings, so the project cannot
yet distinguish:

- real JS main-thread work
- CPU cost of submitting many GPU passes
- a GPU pass that takes too long and makes `computeAsync` wait
- post-processing/render queue back-pressure

## Goal

Make frame pacing measurable, then reduce the main-thread frame wall without breaking the WebGPU
ordering rules that were learned in SP2-SP6.

The sequence is:

1. Add pass-level profiling to the perf CSV.
2. Collapse avoidable multi-submit GPU chains into one submit per subsystem.
3. Stop doing full GPU grass recull work every frame when the camera has not crossed a cell.
4. Move true CPU jobs off the main thread: forest placement first, creature simulation second.

## What should stay on the main thread

These are cheap or DOM-bound and should stay:

- DOM UI, control panels, HUD, and CSV download.
- Keyboard, pointer lock, orbit camera, and FPS camera state.
- High-level frame orchestration and render ordering.
- Player analytic terrain collision and trunk push-out.
- Small scene bookkeeping: URL modes, live params, active refs, debug text.

## What should not stay on the main thread

These are either scalable CPU jobs or avoidable per-frame stalls:

- Creature behavior, gait, IK, and physics once creature counts grow.
- Forest placement record generation and trunk record generation on chunk changes.
- Any fallback path that creates merged geometry on the main thread, except as an explicit baseline.
- Repeated GPU compute submits that can be legally batched.
- Full GPU grass generate/cull when only wind time changed.

## Design constraints

- **No headless WebGPU.** Node can test pure logic and CSV formatting only. GPU behavior still needs
  browser checkpoints.
- **Do not make compute fire-and-forget by default.** Prior SPs found that unawaited compute races
  indirect draws and causes flicker. This SP may batch submits or skip cleanly when data is still
  valid, but it must not reintroduce races.
- **No OffscreenCanvas renderer move in this SP.** Moving the whole renderer to a worker is a later
  architecture change. This SP focuses on the current single-renderer app.
- **Default behavior must stay visually equivalent.** A/B flags are acceptable for measurement, but
  the default path should remain correct.

## Architecture

### Phase A - pass profiler

Add a tiny frame-pass profiler that records the latest and smoothed duration of named blocks.

**CPU wall time is not enough.** The awaited GPU updates (`grassRef.update`, `forestGPURef.update`,
`cdlodRef.update`, etc.) block on GPU *completion* — that is why they are awaited before the draw.
So a `performance.now()` delta around `await grassRef.update()` is a fused blob of CPU encode + GPU
execute + queue wait, and it cannot answer the four-way question this SP asks (real JS work vs submit
cost vs slow GPU pass vs back-pressure). The profiler must therefore capture **two numbers per GPU
block**:

1. **CPU wall** via `performance.now()` around the await (blocked main-thread time).
2. **True GPU pass duration** via WebGPU timestamp queries, which three.js WebGPURenderer exposes:
   - construct the renderer with `trackTimestamp: true`,
   - read durations from `renderer.resolveTimestampsAsync(...)` /
     `renderer.info.render.timestamp` and `renderer.info.compute.timestamp` (milliseconds).

The subtraction `cpuWall - gpuDuration` is the discriminator: a large CPU wall with a small GPU
duration means the cost is JS/submit/queue-wait; a large GPU duration means the pass itself is the
wall. Without the GPU number, Phase A only identifies *which* subsystem stalls, not *why* — which is
exactly the distinction the Problem section requires.

The profiler also records **dropped frames**: the render loop's `_frameBusy` guard drops any vsync
that arrives while a frame is still in flight, so a frame that outruns vsync silently halves the
effective rate. Drop count is part of the pacing picture behind the `19.3 fps` mean and must be a
CSV column.

Named blocks recorded:

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

The profiler wraps sync and async work:

```js
await frameProfiler.timeAsync('grassGpu', () => grassRef.update(now / 1000));
frameProfiler.time('creatures', () => portCreatures.update(rawDt));
```

`perfStats.snapshot()` adds columns such as `passGrassMs`, `passCdlodMs`, `passPostMs`, and
`passGpuAwaitMs` (CPU wall), plus the matching GPU-side columns `gpuGrassMs`, `gpuCdlodMs`, etc.
from timestamp queries, and `droppedFrames`. The first gate is not a speedup. The first gate is a
trace that identifies the top stall **and whether it is CPU-bound or GPU-bound**.

> Note: `passGpuAwaitMs` is the sum of the serial GPU await blocks. That sum is only meaningful
> *because* the current loop awaits each subsystem in sequence. Phase B and the Phase B+ candidate
> below change that serialization, so treat `passGpuAwaitMs` as a baseline-shape metric, not a fixed
> invariant — once submits are batched, the per-pass GPU timestamp columns are the durable signal.

### Phase B - submit batching

Several modules still submit a reset, main compute, and finalize as separate awaited calls:

- `grass-compute.js`
- `cdlod-terrain.js`
- `particles.js`

`forest-gpu.js` already proved the preferred shape:

```js
await renderer.computeAsync([reset, cull, ...finalizers]);
```

Batch the legal chains into a single `computeAsync([...])` per subsystem. This reduces CPU submit
overhead and avoids extra promise boundaries without changing ordering.

#### Phase B+ candidate - single cross-subsystem compute submit

Per-subsystem batching is the conservative win. The larger structural win is that the loop currently
performs **five serial cross-subsystem awaits**:

```js
await grassRef.update(...)
await forestGPURef.update()
await cdlodRef.update()
await clusteredLightsRef.update(...)
for (const e of particleFields) await e.field.update(...)
```

These subsystems have no mutual data hazard — grass cull does not read forest's indirect buffer, etc.
The only real barrier is "all indirect counts written before the draw reads them." So in principle
this whole block collapses to **one** `computeAsync([...all compute nodes])` followed by **one** await
and then the render, cutting await boundaries from ~5 to 1 and removing the CPU↔GPU ping-pong where
the GPU idles during each CPU re-encode.

This is a **gated candidate, not a committed step.** It is only worth doing if the Phase A trace
shows the dominant cost is GPU-await wall (large CPU wall, small summed GPU duration) rather than a
single slow GPU pass. Given the SP2-SP6 race history, this change must land behind its own browser
checkpoint proving no flicker, and behind an A/B flag (`?computeSubmit=batched|serial`). See plan
Task 4.

### Phase C - grass recull cadence

GPU grass is the largest hidden workload. It dispatches a camera-centered window every frame even
when only wind animation changed. Wind uses `uTime` in the draw material, so the indirect instance
set does not need to be regenerated just to animate wind.

Add a dirty/cell-crossing rule:

- Always update `uTime`.
- Recompute reset/cull/finalize only when:
  - camera cell changed,
  - radius/density/terrain/water params changed,
  - the mode forces per-frame recull for debugging,
  - an explicit `force` is requested after rebuild.

The public flag should be measurable:

| flag | behavior |
|---|---|
| `?grassRecull=cell` | default, recull only on cell crossing or dirty params |
| `?grassRecull=frame` | old behavior, recull every frame for A/B |

### Phase D - forest placement worker

SP6 moved forest drawing to the GPU, but placement records are still generated on the main thread
when chunks change. That work is smaller than baked geometry, but it belongs off-thread because it
scales with active chunks and directly feeds trunk collision records.

Move placement record generation to a worker:

- Main sends chunk records, forest params, and terrain params.
- Worker imports `forest-placement.js` and a pure terrain height function.
- Worker returns `{ key, records, trunks }` grouped by chunk.
- Main calls `forestGPU.setChunk(key, records)` and `trunkIndex.setTrunks(key, trunks)`.

This is not a visual change. It removes chunk-change placement work from the UI/render frame.

### Phase E - creature simulation worker

Creature simulation is still the largest true JS subsystem. It is not the current trace's only
problem, but it will become the next wall as creature counts rise.

The worker split should not move rendering first. It should move simulation state and send back a
render snapshot:

```js
{
  creatures: [
    { id, pos, yaw, bodyPose, legPose, lodTier, visible, shadowCaster }
  ],
  stats
}
```

The main thread remains responsible for Three.js objects and materials. The worker owns steering,
gait, IK, terrain/trunk queries, and behavior state. Terrain height and trunk buckets are mirrored
to the worker as data, not called across threads.

**Snapshot transport.** The `{ creatures: [{...}] }` object above describes the *contents*, not the
wire format. A plain object posted every tick incurs structured-clone cost and per-frame GC churn
that grows with creature count — re-introducing the main-thread cost this phase is trying to remove.
The snapshot must be carried in a flat, reusable `Float32Array` (id/pos/yaw/pose packed at fixed
strides) sent as a **transferable**, or backed by a `SharedArrayBuffer` double-buffered between
worker and main. The object form is acceptable only for the deterministic Node parity test, not for
the per-frame render path.

## Success gates

1. A profiling trace identifies the top awaited pass or top JS block, **and** separates CPU wall
   from true GPU pass duration (timestamp queries) so the top stall is classified as CPU-bound or
   GPU-bound, with dropped-frame count recorded.
2. Batched compute chains reduce CPU frame time or await time without visual regressions.
3. `?grassRecull=cell` matches visual behavior of `?grassRecull=frame` and reduces grass await time
   when the camera is still or moving slowly inside a cell.
4. Forest placement worker produces byte-for-byte equivalent records to the main-thread reference
   for a fixed chunk/params test.
5. Creature worker prototype matches the main-thread simulation for deterministic one-step tests
   before it is wired into rendering.

## Out of scope

- Moving the whole renderer to `OffscreenCanvas`.
- Removing all awaits from compute passes.
- Rewriting creatures as GPU simulation.
- Changing visual defaults for grass, terrain, forest, water, sky, or creatures.
- Replacing the baked forest baseline.

