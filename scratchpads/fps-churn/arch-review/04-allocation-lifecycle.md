# Hot-path allocation, caches and lifecycle — base-game.html

Method: static code read only. No browser run, no heap snapshot, no `renderer.info.memory`
sampling was taken. The performance log's `heapMB` column was not analysed by me for a trend
(that is a separate, unclaimed task here) — I only used it to confirm the brief's statement
that GC was ruled out as a dominant cause of the measured dips. Everything below is a
code-read finding unless marked otherwise; I did not patch and re-measure anything.

## Summary of what I looked at

`animate()` in `base-game.html:6646-7089` and its direct per-frame callees: `flora.update()`
(`grass-compute.js`), `forest.update()` (`forest-gpu.js`), `water.update()`, `rain.update()`,
`updateProjectiles`/`updateShotEffects`/`debrisSim.step` (effects), `hiz.update()`,
`updateStats()`. I also spot-checked `effect-renderer.js`, `particle-field.js`,
`projected-decals.js`, `terrain-chunk-batches.js`, `terrain-clipmap-window.js` for cache
growth/eviction.

## Findings

### F1. `animate()` itself is allocation-light — mostly scratch reuse (measured redundancy: none found)

`base-game.html:6646` onward reuses module-level scratch objects: `playerPositionScratch`,
`audioVelocityScratch`, `fpViewPos`/`fpViewQuat`/`fpScale`/`fpLocalMatrix`/`fpWorldMatrix`,
`playerRenderPosition`, `correctionOffset`. Grepping the animate() body (lines 6646-7089) for
`new THREE.`, `{ ...`, `.map(`, `.filter(` found exactly one hit: a spread object built inside
the online-prediction step callback.

- File: `base-game.html:6705` — `return { ...input, jump: ..., reload, throw: thrown, drone: droneInput };`
  This runs inside `prediction.advance(dt, () => {...})` — once per **fixed simulation step**,
  not once per render frame. At a 60Hz fixed step and ~60fps render this is ~1 alloc/frame;
  under frame-rate hitches `prediction.advance` can run multiple fixed steps per rAF, so this
  scales with simulation steps, not renders. `input` itself (`base-game.html:6664-6674`) is a
  fresh object literal built once per animate() call, so this spread is a shallow copy of an
  already-fresh object.
  Classification: measured redundancy (small, code-confirmed, not perf-confirmed).
  Fix: pass `input` directly and set/clear `jump`/`reload`/`throw`/`drone` fields on it in place
  (it's already rebuilt fresh every frame, so mutating it before the callback runs costs nothing
  extra), or hoist a persistent `stepInput` object reused across steps. Benefit: removes one
  small object alloc per fixed step — this is a minor-GC-pressure cut, not a frame-time fix,
  since the brief's own trace found GC wasn't the dip driver. Priority: safe direct improvement,
  very low expected impact; do it opportunistically, not as a priority fix.
- The end-of-frame `lastRenderInfo = { drawCalls, triangles, renderCalls, pipelinesBuilt,
  pipelineMs }` at `base-game.html:7017-7024` is one small object literal per frame. Same
  category — trivial, not worth a special mechanism, mention only for completeness.

Everything else that looks like allocation in updateStats()/getStats() (`base-game.html:6598-6607`,
including `{ ...flora.stats }`, `forest.sampleDetail()`, `Object.fromEntries(...)`,
`JSON.stringify(...)`) is gated behind `vegetationDebugHud.refresh()` which `updateStats()` only
calls once the 500ms FPS-averaging window closes (`base-game.html:6619,6624`) — twice a second,
not per frame. Not a hot-path allocation source. (Reproduced by reading the call graph, not
timed.)

### F2. Grass compute: per-tier plain-object allocation in the non-anchor recull path

File: `grass-compute.js`, inside the returned `update(seconds)` closure.

- `grass-compute.js:930` — `const now = { x: camera.position.x, z: camera.position.z, fx: cone.fx, fz: cone.fz, frame: frameNo, dirty: dirtyAll, occlusion: !!hizSampler && occOn };`
  built once per `update()` call whenever `!anchorMode`, i.e. every frame the non-anchor
  (radius-scan) grass path is active, regardless of whether any tier is actually due.
- `grass-compute.js:976` — inside the tier loop, `tierLast[t] = { x: ..., z: ..., fx: ..., fz: ..., frame: frameNo };`
  one fresh object per tier that recessed this frame (up to `TIERS`, currently 7, per call).

Both are plain data records with a fixed, small shape (5-6 numeric fields). V8 will likely keep
these in young-gen and collect them cheaply, and the trace evidence in this task's brief already
says minor GC wasn't the dominant cause of the measured dips — so I am not claiming this explains
the dip. It is still avoidable churn on a path that runs every rendered frame while non-anchor
grass mode is active.

Classification: measured redundancy (code-confirmed shape and call frequency; GC cost not
measured by me).

Producer → consumer: `now` is read only inside `tierDue(tierLast[t], now, tierClocks[t])`
(comparison of scalar fields); `tierLast[t]` is read the same way next frame. Neither escapes
the closure or is retained beyond one comparison.

Proposed replacement: hoist one persistent `nowScratch = {x:0,z:0,fx:0,fz:0,frame:0,dirty:false,occlusion:false}`
object and mutate its fields in place before the tier loop; replace `tierLast` (currently an
array of objects, one per tier) with parallel typed/plain arrays (`tierLastX`, `tierLastZ`,
`tierLastFx`, `tierLastFz`, `tierLastFrame`) indexed by tier, since `TIERS` is a small fixed
constant. This fits the engine style already used elsewhere in the same file (`uCam.value.set(...)`,
`_dir` scratch at `grass-compute.js:231`) — the codebase already prefers mutate-in-place scratch
for camera-adjacent per-frame values.

Expected benefit: removes up to 8 small-object allocations per frame on the non-anchor grass
path (1 `now` + up to 7 `tierLast` entries). Given the brief's own finding that GC was not the
dip driver, expected effect on the measured 17-21ms frame is small to negligible; this is a
cleanliness/consistency fix more than a performance one. Tradeoff: `tierDue()`'s signature reads
a `now` object — switching to scratch mutation requires it to tolerate a shared mutable object
(check it doesn't retain `now` past the call — a grep of `tierDue` in this file shows it's a pure
comparison function, so it does not retain it, but I read this by inspection only, not by
tracing every call site across the file exhaustively).

Priority: safe direct improvement, small scope (one file, ~15 lines), bounded experiment to
verify with `renderer.info.memory` / a heap allocation timeline is cheap if anyone wants to
confirm the GC-irrelevance claim more precisely for this path specifically (the brief's trace
covered the whole frame, not this call in isolation).

### F3. Grass anchor-mode residency scan: bounded, no leak found

`grass-compute.js:860-909` (`maintainResidency`) builds a `missing` array and sorts it every
call when `anchorMode` is on. This is bounded by the number of chunks in the streaming radius
(a spatial window, not something that grows over a session), and `resident` (a `Map`) is
explicitly evicted via `resident.delete(key)` when a chunk falls outside `r + chunkSize`
(`grass-compute.js:869-874`), with `freeSlots` given back to the pool. `numSlots` bounds the
pool size (`grass-compute.js:859`). No unbounded growth found here.

Classification: code-read, no defect. Long-session behavior: stable — `resident.size` is capped
by `numSlots`, confirmed by the `slot === undefined` break-and-retry-next-frame logic at
`grass-compute.js:893`.

### F4. Chunk/entity caches elsewhere: eviction paths exist where checked

- `forest-gpu.js:524` `chunkRecords = new Map()` (chunkKey → records) has explicit
  `clearChunk(key)` (`forest-gpu.js:952`) called presumably from the terrain streaming layer on
  chunk unload — I confirmed the method exists and is exported, but did not trace every call
  site that invokes `clearChunk` to confirm it fires on every terrain-source-swap and respawn
  path. That link (terrain unload → forest `clearChunk` call) is asserted by the module's own
  comment convention but not verified by me end-to-end — flag as **untested hypothesis** for the
  swap/respawn case specifically, verified only for the steady-state streaming case.
- `effect-renderer.js:324` `firstSeen = new Map()` (id → first-seen timestamp) has a TTL sweep
  at `effect-renderer.js:796` (`if (nowMs - seen > SEEN_TTL_MS) firstSeen.delete(id)`), run
  inline in the per-frame update — bounded, no leak.
- `terrain-chunk-batches.js:32` `byKey = new Map()` (chunk key → batch) has matching
  `byKey.delete(key)` at `terrain-chunk-batches.js:103`, paired with the `entries` sub-map's own
  delete at line 102 — looks correctly paired by inspection, not traced against every call site
  that removes a chunk.
- `terrain-clipmap-window.js:49` allocates one `Map` of `Float32Array`/typed fields at window
  construction (not per frame) — this is a one-time per-window allocation, not a hot-path or
  growing structure; `present.delete(key)` at line 73 evicts stale tile presence flags.

None of these four are reproduced defects; they are code-read confirmations that an eviction
path exists syntactically. I did not instrument a 30-minute session to confirm the maps stay
flat in practice (no browser run available to me), so "bounded in practice over a long session"
remains partially inferred from the code rather than measured.

### F5. Three.js r184's own per-frame cost — separating engine cost from ours

I did not instrument `renderer.render()` internals (no profiler run, no `RenderObject`/cache-key
allocation trace). What I can say from the module layout and this task's stated measured facts:

- The brief states the standing frame is ~17-21ms **inside `renderer.render`**, CPU-bound, and
  that a DevTools trace tied the dips to terrain worker contention, not GC. That places the
  17-21ms cost inside three.js's own `render()` call graph (render-list building, `RenderObject`
  creation/caching, bind-group array construction, `getCacheKey` string building for pipeline
  lookups) rather than in the allocation patterns I audited above in `base-game.html` and its
  modules, which run in separate, explicitly-timed slots (`frameProfiler.mark('grassGpu', ...)`,
  `mark('forestGpu', ...)`, etc. at `base-game.html:6931-6941`) that are visibly smaller than the
  render/postRender slot per the frame-marking structure at `base-game.html:6969-6992`.
- I did not read three.js r184's `WebGPURenderer`/`Backend`/`RenderObjects` source in this pass
  to attribute the 17-21ms to a specific internal allocation (e.g. per-object `RenderObject`
  cache misses vs. bind-group rebuilds vs. actual GPU wait surfaced as CPU time via sync points).
  That attribution is out of my scope for this pass given time — flagging as **not
  investigated**, not as "ruled out ours" or "ruled out theirs." This is the boundary another
  area (draw submission / Three abstraction costs, per the task's own area list) should own; I
  did not double-count it here.

### F6. GPU resource churn on rebuild paths — not found within the modules checked

I looked for geometry/material creation without matching `dispose()` on rebuild paths in
`grass-compute.js`, `forest-gpu.js`, `effect-renderer.js`, `projected-decals.js`. Each has an
explicit `dispose()`/teardown block (`grass-compute.js:1194-1202` disposes compute nodes and
attributes; `projected-decals.js:177-180` disposes geometry/material). I did not check every
subsystem in the doc's module list (terrain, water, sky, roads, etc.) for this pattern — this is
a partial sweep of the vegetation/effects modules touched by `animate()`'s hot path, not a full
repo audit. Scope limit stated explicitly here rather than implied.

## Priority / scope summary

| Finding | Classification | Priority/scope |
|---|---|---|
| F1 spread in prediction step, `lastRenderInfo` literal | measured redundancy, trivial | safe direct improvement, do opportunistically |
| F2 grass `now`/`tierLast` object literals | measured redundancy | safe direct improvement, small bounded experiment to confirm GC-irrelevance for this path specifically |
| F3 grass anchor residency | no defect found | none needed |
| F4 chunk/entity map eviction | code-read confirmation, one link (terrain swap → forest clearChunk) unverified | if pursued: bounded experiment — instrument `chunkRecords.size` across a scripted terrain-source swap |
| F5 three.js internal render cost | not investigated in this pass | belongs to draw-submission/Three-abstraction area, not double-counted here |
| F6 GPU resource dispose | partial sweep, no defect found in modules checked | scope-limited, not a full repo audit |

## What I could not verify

- No browser was run: no `renderer.info.memory` sampling, no heap snapshot, no
  `performance.measureUserAgentSpecificMemory()`, no observation of the `heapMB` column's trend
  over a real 30-minute session.
- I did not confirm GC pause timing or count for the object literals in F1/F2 — I asserted they
  are small enough to likely stay in young-gen, which is a reasoning claim from V8's generational
  GC model, not a measurement.
- I did not trace every call site that populates or evicts `chunkRecords` (forest-gpu.js) or
  `byKey`/`entries` (terrain-chunk-batches.js) across a full terrain-source-swap or respawn path
  — only confirmed the deletion methods exist and are exported/called somewhere.
- I did not read three.js r184's WebGPU backend source to attribute the measured 17-21ms
  `renderer.render` cost between engine-internal allocation (RenderObject cache, bind groups,
  cache-key strings) and our own scene graph size/material count — this needs either a source
  read of `node_modules/three/build/three.webgpu.js`'s render path or a CPU profile with symbol
  names, neither of which I ran.
- I did not check every subsystem doc's module list for GPU-resource dispose correctness — only
  the ones directly in `animate()`'s per-frame call chain (grass, forest, effects, decals).
- I did not run any `test-*.mjs` scripts in this pass; the findings above come entirely from
  static reads of the listed files.
