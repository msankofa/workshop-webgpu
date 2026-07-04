# Perf-instrumentation fixes: timestamp-resolve attribution + zeroed render counters

Two defects found in a `TIMESTAMP_MODE=on` perf capture, both in `environment-viewer.html`'s
`animate()` loop and the `perfLog`/`frameProfiler` logging path. Both are fixed below.

## Fix A — attribute the timestamp-resolve cost

**Root cause:** `resolveFrameTimestamps()` (awaits two `renderer.resolveTimestampsAsync(...)`
calls, only active when `TIMESTAMP_MODE==='on'`) was called at the old line 3672 outside any
`frameProfiler.time*` wrapper, yet `cpuMs` (`frameEnd - now`, sampled right after) included its
cost. In a timestamps-on capture, ~20ms of `cpuMs` had no corresponding pass column.

**Files changed:**

- `frame-profiler.js`
  - Added `'timestampResolve'` to `DEFAULT_NAMES` (so `beginFrame()` zeroes it like every other
    pass — reads `0` when timestamps are off, not stale).
  - Added `timestampResolve: 'passTimestampResolveMs'` to `DEFAULT_PREFIXES`, following the
    exact pattern of the other `pass*Ms` columns.

- `environment-viewer.html`
  - Before:
    ```js
    await resolveFrameTimestamps();
    ```
  - After:
    ```js
    await frameProfiler.timeAsync('timestampResolve', () => resolveFrameTimestamps());
    ```

**CSV wiring verified, not assumed:** `perfLog.snapshot()` spreads `...frameProfiler.snapshot()`
into its returned object (`environment-viewer.html` ~line 1016), and `perfLog.toCSV()` derives
its header from `Object.keys(this.samples[0])` (~line 1030) — i.e. the column set is fully
dynamic. Confirmed no separate header list exists anywhere else. So adding
`passTimestampResolveMs` to the snapshot object was sufficient for it to appear as a CSV column
with no other edits.

**Verified with Node** (no GPU/browser available in this environment):
```
node --input-type=module -e "import('./frame-profiler.js').then(m=>{const p=m.createFrameProfiler();p.beginFrame();const s=p.snapshot();console.log('passTimestampResolveMs' in s, s.passTimestampResolveMs);})"
# -> true 0
```
Also ran the existing `node test-frame-profiler.mjs` — all 11 assertions still pass (the new
pass name/column is additive and doesn't disturb existing pass behavior).

## Fix B — restore draw/triangle/compute counters in timestamp mode

**Root cause:** `perfLog.snapshot()` read `renderer.info` live for `renderFrameCalls`
(`r.render.frameCalls`), `renderDrawCalls` (`r.render.drawCalls`), `triangles`
(`r.render.triangles`), and `computeFrameCalls` (`r.compute.frameCalls`). `snapshot()` runs via
`perfLog.maybeSample(frameEnd)` (and `updatePerfPanel`), both called *after*
`resolveFrameTimestamps()`. With `TIMESTAMP_MODE==='on'`, the awaited
`resolveTimestampsAsync()` calls cross a vsync boundary, and WebGPURenderer's internal per-rAF
`info` reset zeroes these per-frame counters before `snapshot()` samples them. The cumulative
`renderer.info.render.calls` (exposed as `calls`/`renderCallsTotal`) isn't reset per-frame, so it
stayed correct — matching the reported symptom exactly (three counters zero, cumulative fine).

**Files changed:** `environment-viewer.html`

1. New module-scoped holder, declared next to `frameProfiler` (~line 837):
   ```js
   let lastFrameRenderInfo = null;
   ```

2. Captured immediately after the `postRender` `timeAsync` block closes, **before** the
   (now-wrapped) `resolveFrameTimestamps()` call:
   ```js
   lastFrameRenderInfo = {
     frameCalls: renderer.info.render.frameCalls,
     drawCalls: renderer.info.render.drawCalls,
     triangles: renderer.info.render.triangles,
     computeFrameCalls: renderer.info.compute.frameCalls,
   };
   await frameProfiler.timeAsync('timestampResolve', () => resolveFrameTimestamps());
   ```
   `computeFrameCalls` was included because it reads from the same reset-prone
   `renderer.info.compute` bucket as the render counters (same defect class), even though the
   task brief flagged it as a "check if affected" item rather than a confirmed symptom.

3. `perfLog.snapshot()` now reads from the holder, falling back to a live read (or `0`) for the
   first frame before the holder is populated:
   ```js
   renderFrameCalls: lastFrameRenderInfo?.frameCalls ?? r?.render?.frameCalls ?? 0,
   renderDrawCalls: lastFrameRenderInfo?.drawCalls ?? r?.render?.drawCalls ?? 0,
   computeCallsTotal: r?.compute?.calls ?? 0,   // cumulative — unchanged, still live
   computeFrameCalls: lastFrameRenderInfo?.computeFrameCalls ?? r?.compute?.frameCalls ?? 0,
   triangles: lastFrameRenderInfo?.triangles ?? r?.render?.triangles ?? 0,
   ```
   `calls` / `renderCallsTotal` / `computeCallsTotal` are left reading `r.render.calls` /
   `r.compute.calls` live, unchanged, since those are cumulative and not subject to the reset.

**Behavior when `TIMESTAMP_MODE` is off:** `lastFrameRenderInfo` is still populated every frame
(the capture isn't gated on `TIMESTAMP_MODE`), and since no vsync boundary is crossed before
`snapshot()` runs in that mode, the holder's values are identical to what a live read would give
at that point — no behavior change for the common case.

Both call sites that invoke `perfLog.snapshot()` (`perfLog.maybeSample()` at line ~3683 and
`updatePerfPanel()` at line ~1071, both inside/after the same `animate()` frame) benefit, since
`lastFrameRenderInfo` is set once per frame before either runs.

## Verification performed

- Re-read both edited regions in `environment-viewer.html` (the `animate()` loop and
  `perfLog.snapshot()`) after editing to confirm ordering: capture → (wrapped) timestamp resolve
  → `frameEnd`/`cpuMs` → `perfLog.maybeSample`/`updatePerfPanel`.
- `node --input-type=module -e "import('./frame-profiler.js')..."` — module still loads/exports
  correctly, new column present and defaults to `0`.
- `node test-frame-profiler.mjs` — 11/11 existing assertions still pass.
- Grepped for `lastFrameRenderInfo`, `passTimestampResolveMs`, `timestampResolve` across
  `environment-viewer.html` and `frame-profiler.js` to confirm end-to-end wiring (declaration,
  capture, consumption, DEFAULT_NAMES/DEFAULT_PREFIXES entries) — all present, no orphaned
  references.
- No GPU/browser available in this environment, so the fixes could not be exercised against a
  live `TIMESTAMP_MODE=on` capture; verification is by code inspection + the Node checks above.

## Deviations / things worth a second look

- `computeFrameCalls` capture (item 3 in Fix B's brief) was implemented as described — included
  it since it shares the same `renderer.info` per-rAF reset mechanism as the other three
  counters, even though the brief only asked me to check whether it showed the same symptom in
  the CSV column list (I couldn't run a live capture to confirm it actually reads 0 in practice;
  including it is the conservative/consistent choice given the identical root cause).
- Left the on-screen HUD text (`updateTerrainDebug`, ~line 887, `const ri = renderer.info;`) and
  its live `renderer.info` reads untouched — that's a separate, un-mentioned code path (debug
  text overlay, not `perfLog`/CSV) and out of scope for this task.
- No changes to `docs/subsystems/creature.md`, `terrain.md`, or other subsystem docs — this
  change is entirely within the `infra` subsystem (frame-profiler.js, environment-ui.js's
  perf-log consumer contract is unaffected since it only reads whatever keys `perfLog.snapshot()`
  produces).

## Files touched

- `environment-viewer.html`
- `frame-profiler.js`
- `docs/subsystems/infra.md`
- `agent_log.csv` (one appended row, `2026-07-04T13:05,infra,...`)
- `creature-perf-analysis/instrumentation-fix-notes.md` (this file)
