---
title: Base Game terrain — WebGPU audit
page: base-game.html
subsystem: terrain
scope: The terrain runtime as Base Game drives it — base-game-terrain.js, the terrain-system.js streamer under it, the chunk batcher, the LOD coverage and field windows, and the base-game.html frame wiring. The terrain generator (authoring) and the environment-viewer path are out of scope.
skill: improve-webgpu
date: 2026-08-29
baseline: terrain subsystem and corrected page default are 49 resident chunks at radius 3, 49 near-terrain draws, 51,842 triangles; the audited page had overridden this with radius 6 / 169 chunks; terrain.update p50 0.003 ms standing; 493 bytes/frame allocated on the quiet frame path (bench-base-game-terrain.mjs, 2026-08-29, CPU only)
measurements: bench-base-game-terrain.mjs (new; CPU, headless, no GPU-side numbers in this audit)
steps_complete: [1, 3, 5]
steps_partial: [2, 6]
steps_not_run: [4]
findings: 23
severity_counts:
  high: 8
  medium: 8
  low: 6
  info: 1
status_counts:
  fixed: 12
  deferred: 0
  open: 9
  unverified: 2
kind_counts:
  defect: 18
  gap: 2
  regression: 1
  test-gap: 1
  observation: 1
---

# Base Game terrain — WebGPU audit

Findings from running `improve-webgpu` over the terrain path in `base-game.html`. Almost everything
here predates this pass; `introduced_by` says so per finding. The frame-loop findings are grouped
first because that is where the skill's severity rule puts them, and because they turned out to be
the whole story on the CPU side: the terrain pass is cheap in time and expensive in garbage.

The audit is **incomplete**. Step 4 (the visual rubric) has not run and cannot run from source —
the page has to render. Step 2 has CPU numbers only, from a new headless bench. `F-19` and `F-20`
record those two gaps as findings rather than leaving them implied.

One thing this audit did close: the red test the NPC-bots audit recorded as `F-15` ("something in
the earlier uncommitted work on this branch changed the volumetric handoff. Not diagnosed") is
diagnosed here as `F-09`, and the suite is green again.

## About this document

Written to be machine-read. The contract a reader can rely on:

- A finding is any `##` heading whose text starts with `F-` followed by digits. Every other `##`
  heading is prose and can be skipped.
- The first fenced ` ```yaml ` block inside a finding is its metadata. Fields are fixed; values come
  from the vocabularies below.
- The four `###` headings inside a finding are always present and always in this order:
  **Cause**, **Effect**, **Solution**, **Result**. A finding that is not fixed still has all four —
  `Solution` is then the proposed fix and `Result` says what has and has not changed.

Vocabularies:

| Field | Values |
|---|---|
| `severity` | `high` · `medium` · `low` · `info` |
| `status` | `fixed` · `deferred` · `open` · `unverified` |
| `kind` | `defect` · `regression` · `gap` · `test-gap` · `observation` |
| `introduced_by` | `this-work` · `donor` · `pre-existing` |
| `runs` | `per-frame` · `per-interaction` · `per-rebuild` · `once` · `n/a` |

`severity` follows the skill's rule — where the code runs, not how it reads. `high` means it runs
every frame or leaks GPU memory. Line numbers are as of 2026-08-29 and will drift; the `symbol`
field is the durable half.

## What was measured, and what it is worth

`bench-base-game-terrain.mjs` is new and is the evidence behind every `measured` block below. It
runs the real `createBaseGameTerrain` headless against both sources — the analytic default and a v5
recipe — and reports five things: the per-frame `update()` cost standing and walking, what a chunk
boundary crossing costs, how much the frame path allocates, what the panel's `stats` getter costs at
its 15-frame interval, and the two rebuild paths a slider drives.

Two limits on it, stated up front because several findings rest on them:

- **`useWorker: false`.** Node has no `Worker` for the module worker the page uses, so every chunk
  is built synchronously inside `update()`. That makes the crossing-frame figures the cost of the
  *fallback* path, not of the page — but it is also exactly the path the relay server takes and the
  path `disableWorker()` drops the page onto, so the number is not academic. `F-14` says so.
- **Allocation is measured as a heap delta, taken as the smallest of five runs.** `heapUsed` carries
  collector state, so a single sample is noise; the minimum of five is the tightest upper bound this
  method gives. The empty-loop control reads 0.0 bytes/call, so the figures below are the module's,
  not the harness's.

Headline before/after, analytic source, standing still:

| | before | after |
|---|---|---|
| quiet frame, whole path | 493 bytes/frame | 288 bytes/frame |
| `terrain.update` | 244 bytes/call | 122 bytes/call |
| `system.update` | 747 bytes/call | 32 bytes/call |
| `terrain.frameCost` | 96 bytes/call | 0 bytes/call |
| `system.takeInstallCost` | 40 bytes/call | 0 bytes/call |
| active-chunk cache rebuilds over 40 walking frames | 28 | 0 |

Time did not move, and was never the problem: `terrain.update` is 0.003 ms p50 standing on both
sources, before and after.

# Findings

## F-01 — The unload scan walked every resident chunk every frame, allocating a pair per chunk

```yaml
id: F-01
title: The unload scan walked every resident chunk every frame, allocating a pair per chunk
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: terrain-system.js
    line: 396
    symbol: update
    role: the unload block, entered on every quiet frame
measured:
  before: system.update 747 bytes/call at 49 resident chunks
  after: 32 bytes/call
verified_by: bench-base-game-terrain.mjs — "[3b] allocation by piece"
mutation_tested: false
```

### Cause

The unload block runs whenever the build pipeline is idle — which is every frame the player is not
crossing a chunk boundary, i.e. almost every frame. It iterated `for (const [key, chunk] of
this.chunks)`, and destructuring a Map's entries allocates a fresh two-element array per entry. The
loop then `continue`s on the first line for every chunk inside the target window, which is all of
them.

### Effect

49 short-lived arrays per frame at the default draw radius, 169 at radius 6, and one set per terrain
system — in volumetric mode there are four (the near system plus three cascade levels), so the
cascade multiplies it. This was the single largest source of garbage in the terrain path: 747 of the
measured 793 bytes that `system.update` allocated on a frame where nothing happened.

### Solution

Iterate `this.chunks.keys()` and `get` the chunk only on the rare key that is actually leaving.
Deleting from a Map while iterating its keys is as legal as iterating its entries. The unload branch
also now clears `primaryMesh` when it disposes the chunk that was holding it, which is what makes
`F-06` safe.

### Result

747 → 32 bytes/call. The residual 32 is the Map iterator itself plus the `chunks.values()` call in
`F-06`'s guarded branch.

## F-02 — The active-chunk cache was rebuilt eagerly for a getter nothing in Base Game reads

```yaml
id: F-02
title: The active-chunk cache was rebuilt eagerly for a getter nothing in Base Game reads
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: terrain-system.js
    line: 771
    symbol: refreshActiveChunkCache
    role: builds an array of one fresh object per resident chunk
  - file: terrain-system.js
    line: 424
    symbol: update
    role: called it whenever residency changed
  - file: terrain-system.js
    line: 520
    symbol: onWorkerChunk
    role: called it again per arrival, outside the frame
  - file: base-game-terrain.js
    line: 597
    symbol: refreshTileBounds
    role: Base Game's only consumer, and it is a debug view that is off by default
measured:
  before: 28 rebuilds over 40 walking frames, 49 objects each
  after: 0 rebuilds in the loop; one on the read that wants it
verified_by: test-base-game-terrain.mjs — "the frame loop rebuilds the active-chunk cache zero times"
mutation_tested: true
```

### Cause

`activeChunks` is a snapshot: an array holding one freshly built eleven-field object per resident
chunk. It was rebuilt eagerly on three paths — inside `restream`, at the end of every `update()`
whose residency changed, and once more per worker chunk arrival. With four workers delivering, a
single frame could rebuild it several times over, N+1 style, before anything read it.

Base Game reads it in exactly one place: `refreshTileBounds`, behind the tile-bounds debug toggle,
which is off. `environment-viewer.html` reads it for decoration placement, so the getter is not dead
— just eagerly maintained for a reader that usually is not there.

### Effect

28 rebuilds across 40 frames of ordinary walking at radius 3, each allocating an array plus 49
objects — roughly 3.4 KB per rebuild, and it scales with the square of the draw radius. This is the
same mistake the trees audit recorded as its own `F-01`, in the opposite direction: there a lazy
scan was made eager by a new caller, here an inherently lazy value was maintained eagerly.

### Solution

Mark a dirty flag on the three write paths and build in the getter. `activeChunkRefreshes` counts
the builds, so "the frame loop does not rebuild this" is an invariant a test can assert directly
rather than inferring it from a value that happens to correlate — the lesson the trees audit's
`F-20` wrote down.

### Result

Zero rebuilds across 40 walking frames, confirmed by counter. Restoring the eager call in `update()`
turns the test red with "28", so the assertion observes the cost rather than a side effect of it.

## F-03 — `updateCoverage` allocated a closure every frame, cascade or no cascade

```yaml
id: F-03
title: updateCoverage allocated a closure every frame, cascade or no cascade
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game-terrain.js
    line: 266
    symbol: updateCoverage
    role: cascade.forEach with a callback closing over three locals
measured:
  before: terrain.update 244 bytes/call
  after: 122 bytes/call
verified_by: bench-base-game-terrain.mjs — "[3b] allocation by piece"
mutation_tested: false
```

### Cause

`cascade.forEach((c, i) => { … })` builds a fresh closure on every call, because the callback
captures `globalPosition`, `dt` and `residencyChanged`. `forEach` on an empty array still evaluates
its argument, so heightfield mode — where `cascade` is always empty — paid for it too. The hide-rule
`() => false` passed to `presentKeys` was a second closure allocated inside it.

### Effect

Half of what `terrain.update` allocated on a completely quiet frame, in heightfield mode, where the
loop body never ran once.

### Solution

An indexed `for` loop, and the constant hide-rule hoisted to a module-level `alwaysShow`.

### Result

244 → 122 bytes/call, which is the largest single drop of the four allocation fixes. The remaining
122 is `system.update`'s 32 plus about 90 bytes this audit did not attribute; the bench's per-piece
section is the place to continue that.

## F-04 — `frameCost` returned a fresh object, and the page reads it every frame

```yaml
id: F-04
title: frameCost returned a fresh object, and the page reads it every frame
severity: medium
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game-terrain.js
    line: 891
    symbol: get frameCost
    role: built a seven-field literal per read
  - file: base-game.html
    line: 4700
    symbol: animate
    role: reads it every frame to fill six profiler slots
  - file: base-game.html
    line: 4258
    symbol: recordPerformanceFrame
    role: the one caller that must keep a copy, and already spreads
measured:
  before: 96.4 bytes/call
  after: 0.0 bytes/call
verified_by: test-base-game-terrain.mjs — "frameCost reuses one object"
mutation_tested: false
```

### Cause

The getter's own comment says it is "cheap enough to read every frame (stats is not)" — and it is
cheap in time. It was not cheap in allocation: a fresh object literal with seven number fields, read
once per frame by `animate()` to split the terrain slot into fold, field, install, colorize, batch
and collider marks.

### Effect

One object per frame, forever, for a value that is overwritten each frame anyway.

### Solution

Mutate one hoisted object and return it. The only caller that outlives the frame is the performance
capture, which already writes `{ ...terrain.frameCost }`, so no call site changed. The comment now
says to copy it rather than hold it.

### Result

0 bytes/call, pinned by an object-identity assertion — a getter that goes back to a fresh literal
fails it.

## F-05 — `takeInstallCost` allocated once per terrain system per frame

```yaml
id: F-05
title: takeInstallCost allocated once per terrain system per frame
severity: medium
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: terrain-system.js
    line: 489
    symbol: takeInstallCost
    role: returned { ms, count } per drain
  - file: base-game-terrain.js
    line: 826
    symbol: update
    role: drains the near system and every cascade level, every frame
measured:
  before: 40.0 bytes/call, x4 systems in volumetric mode
  after: 0.0 bytes/call
verified_by: test-base-game-terrain.mjs — "takeInstallCost reuses one object"
mutation_tested: false
```

### Cause

The drain returns the accumulated out-of-frame install cost as a small object. It is called once for
the near system and once per cascade level, on every frame.

### Effect

One to four objects per frame. Small on its own; it is the pattern, and terrain was doing it in four
places at once.

### Solution

Each system owns one `installCostOut` and mutates it. Per-system ownership means the four drains in
one frame cannot alias each other. The existing test that drains twice and asserts zero still holds,
because the fields are rewritten on every drain.

### Result

0 bytes/call.

## F-06 — The primary mesh was re-picked from a Map iterator every frame

```yaml
id: F-06
title: The primary mesh was re-picked from a Map iterator every frame
severity: low
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: terrain-system.js
    line: 411
    symbol: update
    role: chunks.values().next() on every frame
  - file: terrain-system.js
    symbol: addChunk / installChunk
    role: already maintain primaryMesh as chunks arrive
verified_by: bench-base-game-terrain.mjs — folded into system.update's 747 -> 32 bytes
mutation_tested: false
```

### Cause

`primaryMesh` was recomputed unconditionally as the first still-resident chunk's mesh, which
allocates a Map iterator and an iterator-result object per frame. `addChunk` and `installChunk`
already keep it correct as chunks arrive and are replaced; the only case they did not cover was the
primary chunk being unloaded.

### Effect

Two small objects per frame per system, for a value that cannot change on a frame where residency
did not.

### Solution

Guard the re-pick on `changed || !this.primaryMesh`, and close the gap by nulling `primaryMesh` in
the unload branch when the chunk being disposed is the one holding it. The guard is exactly correct
rather than approximately so: on a frame where `changed` is false, nothing has mutated `chunks`.

### Result

Folded into `F-01`'s measurement. Kept separate because the correctness argument is different — this
one needed the unload branch changed to stay safe.

## F-07 — The chunking signature was a template string built every frame

```yaml
id: F-07
title: The chunking signature was a template string built every frame
severity: low
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: terrain-system.js
    line: 350
    symbol: update
    role: `${chunkSize}|${renderRadius}` compared against a stored string
verified_by: bench-base-game-terrain.mjs — folded into system.update's 747 -> 32 bytes
mutation_tested: false
```

### Cause

Runtime changes to `chunkSize` or `renderRadius` must force a re-chunk even when the centre has not
moved, and that was detected by joining the two numbers into a string and comparing it against last
frame's. The join happens every frame; the change happens when a slider moves.

### Effect

One string per frame per system.

### Solution

Store the two numbers and compare them. `this.chunkingSig` becomes `this.sigChunkSize` and
`this.sigRenderRadius`.

### Result

Folded into `F-01`'s measurement.

## F-08 — A source swap left flora cover derived against the previous world's waterline

```yaml
id: F-08
title: A source swap left flora cover derived against the previous world's waterline
severity: medium
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-rebuild
locations:
  - file: base-game-terrain.js
    line: 797
    symbol: setSource
    role: updated seaLevel and uGroundSea but not tileCover
  - file: base-game-terrain.js
    line: 645
    symbol: setSeaLevel
    role: the other path, which does update it
  - file: flora-field.js
    line: 100
    symbol: createTileCover
    role: holds its own `sea`, only written by setSeaLevel
  - file: flora-field.js
    line: 68
    symbol: coverAt
    role: `drowned = height < seaLevel + waterMargin`
measured:
  reproduction: plains at 6 m, sea moved 0 -> 12; cover 199 (grows) instead of 0 (drowned)
verified_by: test-base-game-sea-level.mjs — "a source swap moves the waterline cover is derived against"
mutation_tested: true
```

### Cause

Two things carry the sea level: the module's own `seaLevel` (tint bands, spawn, kill plane) and
`tileCover`'s private copy (what decides that a texel is underwater and grows nothing).
`setSeaLevel` updates both. `setSource` — which is how the page applies a v5 project, and which
takes the new world's `descriptor.seaLevel` — updated only the first. `setSource` then calls
`fieldWindow().setSource(...)`, which clears the window, so every cover texel in the new world was
re-derived against the old world's waterline.

### Effect

After applying a project whose sea level differs from the previous one, grass, plants and trees are
placed by the wrong shoreline: vegetation growing out of the water where the sea rose, and a bare
band where it fell. It survives until something calls `setSeaLevel` explicitly.

### Solution

One line in `setSource`: `tileCover.setSeaLevel(seaLevel)` beside the `uGroundSea` write it already
does.

### Result

Fixed, and pinned by an assertion that derives a tile of plains at 6 m and reads the cover back —
dry at 20 m, drowned at 6 m, after a swap from sea 0 to sea 12. See `F-21`: the first version of
that assertion passed with the fix reverted and had to be rewritten.

## F-09 — The red test in the terrain suite: `restream` stopped retaining chunks

```yaml
id: F-09
title: "The red test in the terrain suite: restream stopped retaining chunks"
severity: medium
status: fixed
kind: regression
introduced_by: pre-existing
runs: n/a
locations:
  - file: terrain-system.js
    line: 267
    symbol: restream
    role: `drop` defaults to true, so both callers now discard resident chunks
  - file: test-base-game-terrain-handoff.mjs
    line: 76
    symbol: "[3] live toggle"
    role: captured the chunk set AFTER the toggle, when it is already empty
closes: the NPC-bots audit's F-15, recorded there as "not diagnosed"
verified_by: test-base-game-terrain-handoff.mjs — ALL PASS
mutation_tested: false
```

### Cause

The test stages worker latency by hand: toggle volumetric mode on, grab the resident chunks, clear
the volume provider, let the player stand for a second on the heightfield, then feed those chunks
back as volume colliders and assert the handoff completes on the next update.

`restream()` now defaults to `drop: true`, so `setVolumetric` disposes every resident chunk instead
of marking it stale. The capture therefore returned an empty array, nothing was ever fed back,
`volumeProvider.hasChunk` stayed false, and the handoff could not complete. Every other assertion in
the block still passed, which is why it read as a mysterious one-line failure.

### Effect

One red test that three audits' worth of readers would attribute to whatever they had just changed.
The behaviour it guards — collision must not lapse while volume tiles are in flight — was never
actually broken.

### Solution

Capture the chunk set before `setVolumetric(true)`, with a comment saying why. `geometry.dispose()`
does not free the CPU arrays, so the captured geometries still build a BVH.

### Result

Green. `test-base-game-terrain-handoff.mjs` reports ALL PASS, and the whole terrain-adjacent suite
(15 scripts) is green.

## F-10 — The stale-retention machinery is dead, and three places still document it

```yaml
id: F-10
title: The stale-retention machinery is dead, and three places still document it
severity: medium
status: open
kind: defect
introduced_by: pre-existing
runs: n/a
locations:
  - file: terrain-system.js
    line: 267
    symbol: restream
    role: `drop: false` has no caller anywhere in the repo
  - file: terrain-system.js
    line: 421
    symbol: hasFreshChunk
    role: `!c.stale` is always true
  - file: base-game-terrain.js
    line: 257
    symbol: hideStaleHeightfield
    role: always false; duplicated inline at line 572
  - file: base-game-terrain.js
    line: 914
    symbol: get stats
    role: staleTiles spreads the whole chunk map to count something that is always 0
  - file: docs/subsystems/terrain.md
    symbol: terrain-system.js API
    role: still describes keep-until-replaced as the contract
verified_by: repo grep — restream is called twice, both without arguments
mutation_tested: false
```

### Cause

`restream` used to mark chunks stale and keep them in the scene until a same-key replacement landed.
It now drops them, on the reasoning recorded in its own comment: the far LOD already shows the right
ground. `drop: false` was kept as an option and nothing uses it.

Everything built for the old contract is still in place and inert: `chunk.stale` is never assigned
true, so the two hide-rules, `hasFreshChunk`'s freshness test, `installChunk`'s replace-when-ready
comment, `activeChunks.stale` and the `staleTiles` stat all describe a state that cannot occur.

### Effect

Nothing runs wrong. The cost is that a reader — including the last three audits — cannot tell which
of the two contracts is live, and `stats.staleTiles` spreads the entire chunk map into an array
every read to produce a guaranteed zero. `setSource`'s own doc comment described the opposite of
what the function did, two lines above the call.

### Solution

Decide whether `drop: false` has a future. If it does, give it a caller (the obvious one is a swap
with far LOD off — see `F-11`) and keep the machinery. If it does not, delete the branch, the two
hide-rules, `staleTiles` and the `stale` field, and update `docs/subsystems/terrain.md`.

### Result

The `setSource` comment is corrected and now says what the function does. The rest is open, because
which way to resolve it depends on `F-11`.

## F-11 — Dropping every chunk on a swap leaves a hole when far LOD is off

```yaml
id: F-11
title: Dropping every chunk on a swap leaves a hole when far LOD is off
severity: medium
status: open
kind: defect
introduced_by: pre-existing
runs: per-rebuild
locations:
  - file: terrain-system.js
    line: 271
    symbol: restream
    role: disposes every chunk immediately, justified by "the far LOD already shows the right one"
  - file: base-game-terrain.js
    line: 738
    symbol: setFarLod
    role: far LOD is a setting, and it can be off
  - file: base-game-terrain.js
    line: 789
    symbol: setSource
    role: the swap path a v5 Apply takes
measured:
  refill_radius_6_sync: 59 frames / 89 ms analytic, 59 frames / 865 ms v5
verified_by: bench-base-game-terrain.mjs — "[5] rebuild paths"; the visual claim is inferred, not seen
mutation_tested: false
```

### Cause

The drop is justified by the far LOD covering the gap. The far LOD is a toggle. With it off there is
nothing under the chunks, and a swap or a volumetric toggle removes all of them in one frame.

### Effect

Inferred from source and the refill timings, **not seen in a browser**: applying a terrain project
with far LOD off should show the world open up to whatever is behind it — sky, or the water plane —
for as long as the restream takes. Collision does not lapse, because `setSource` and
`setVolumetric` both re-enable the heightfield provider through `handoffPending`; this is a visual
defect, not a fall-through.

How long is source-dependent. At radius 6 on the synchronous path the refill is 89 ms of work over
59 frames on the analytic source and 865 ms on a v5 recipe. With workers the wall-clock is shorter
and the frames are not blocked, but the hole is the same hole.

### Solution

Make the drop conditional on something actually drawing underneath: `restream({ drop: farLodMode })`
from `base-game-terrain.js`, which is the caller that knows. That also gives `F-10`'s `drop: false`
branch the caller it lacks, and keeps its machinery alive rather than deleted.

### Result

Not fixed. It is a visual claim, and this audit could not run Step 4 to confirm the severity. Worth
one look at the page: apply a project with far LOD off and watch the ground during the swap.

## F-12 — The volumetric collider pass allocates a set, an array and a sort every frame it runs

```yaml
id: F-12
title: The volumetric collider pass allocates a set, an array and a sort every frame it runs
severity: high
status: open
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game-terrain.js
    line: 166
    symbol: syncVolumeColliders
    role: builds `wanted` (Set), `order` (25 objects), sorts it, then spreads collidedChunks.keys()
  - file: base-game-terrain.js
    line: 841
    symbol: update
    role: calls it whenever changed || foldPending || colliderPending
measured:
  per_pass: 1 Set + 1 array + 25 objects + 1 sort + 1 key array, at collisionRadius 2
verified_by: source review; not isolated in the bench, which runs heightfield mode by default
mutation_tested: false
```

### Cause

The wanted-collider window is rebuilt from scratch on every pass: a `Set` of the 25 keys in a 5×5
square, a parallel `order` array of 25 `{ key, d2 }` objects, a `sort` over it, and finally a spread
of `collidedChunks.keys()` for the removal loop. None of it depends on anything but the focus chunk,
which changes when the player crosses a chunk boundary.

### Effect

In volumetric mode, `colliderPending` stays true while the budget of one BVH rebuild per frame works
through arrivals, so this runs on most frames during travel. That is roughly 28 allocations per
frame for a window whose shape is fixed at construction.

### Solution

Precompute the 25 offsets and their `d2` once, sorted, at construction — the ordering is a property
of `collisionRadius`, not of position. Reuse a scratch `Set` (clear rather than reallocate) and
iterate `collidedChunks.keys()` with a deletion-safe pattern instead of spreading.

### Result

Not fixed. Ranked high because it is per-frame in the mode it applies to, but it is unmeasured: the
bench runs heightfield mode, so this needs a volumetric arm before the fix can show a number.

## F-13 — The fold pass spreads the batched-chunk keys on every frame it runs

```yaml
id: F-13
title: The fold pass spreads the batched-chunk keys on every frame it runs
severity: medium
status: open
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game-terrain.js
    line: 545
    symbol: syncBatches
    role: `for (const key of [...batched.keys()])` per call, per streamer
  - file: base-game-terrain.js
    line: 553
    symbol: applyMaterials
    role: calls syncBatches for the near system and every cascade level
measured:
  per_call: one array of 49 keys at radius 3, x1 + cascade levels
  fold_cost_30s_walk: colorize 1.37 ms, batch 1.87 ms, collider 0.02 ms total over 1800 frames
verified_by: bench-base-game-terrain.mjs — "[2] 30 s fold totals"; the allocation is read from source
mutation_tested: false
```

### Cause

The removal sweep needs to delete from `batched` while iterating it, and the spread is the
straightforward way to make that safe.

### Effect

One array of N strings per fold frame per streamer. The fold's *time* is genuinely small — 3.3 ms of
colorize-plus-batch across a whole 30-second walk — so this is allocation hygiene, not a time cost.
It is listed because it is on the same frame path as `F-01` and `F-03` and is the last obvious one
left there.

### Solution

Deleting the current key from a Map during `for…of` over its keys is well-defined, so the spread can
go. If a defensive copy is wanted, hoist one scratch array and refill it.

### Result

Not fixed. Deliberately below `F-12` in priority: it runs on fold frames, not on every frame.

## F-14 — A chunk boundary crossing costs 12 ms on the synchronous path with a v5 source

```yaml
id: F-14
title: A chunk boundary crossing costs 12 ms on the synchronous path with a v5 source
severity: high
status: open
kind: observation
introduced_by: pre-existing
runs: per-rebuild
locations:
  - file: terrain-system.js
    line: 376
    symbol: update
    role: builds maxChunksPerUpdate tiles inline when there is no worker
  - file: terrain-system.js
    line: 535
    symbol: createChunk
    role: source.buildTile, synchronous by contract
  - file: terrain-system.js
    symbol: disableWorker
    role: the page falls onto this path if a worker errors
measured:
  v5_crossing_frame: p50 12.27 ms, p95 12.36 ms (2 chunks per frame, chunkSize 30)
  analytic_crossing_frame: p50 1.27 ms, p95 1.97 ms
  attribution: fold totals over the same 30 s walk are colorize 0.89 ms + batch 2.07 ms, so the cost is the tile build
verified_by: bench-base-game-terrain.mjs — "[2] walking 5 m/s"
mutation_tested: false
```

### Cause

With no worker, `update()` builds `maxChunksPerUpdate` (2) tiles inline. A v5 tile at 30 m and 23
intervals is roughly 6 ms of stack evaluation each. The fold that follows is measured separately and
is negligible, so the crossing cost is the tile build and nothing else.

### Effect

Not the page's normal cost — `base-game.html` passes `useWorker: true` and gets a pool. It is the
cost of three real situations: the relay server, which streams synchronously; a page whose worker
threw and hit `disableWorker()`; and the cold-start branch in `update()`, which deliberately builds
the first chunk inline so consumers have a mesh immediately. On v5 that first chunk is a 6 ms frame
at load, and on the fallback path it is a 12 ms frame every 6 seconds of walking.

### Solution

Two independent things. Lower `maxChunksPerUpdate` on the synchronous path so a fallback frame costs
one tile rather than two. And measure the same walk with workers on in the page, which is the number
that actually matters and which this audit cannot produce — see `F-20`.

### Result

Not fixed. Recorded because it is the only double-digit millisecond figure the bench found anywhere
in the terrain path, and because the audit would otherwise imply the terrain pass is free.

## F-15 — The install-rate readouts show zero exactly while chunks are streaming

```yaml
id: F-15
title: The install-rate readouts show zero exactly while chunks are streaming
severity: low
status: open
kind: defect
introduced_by: pre-existing
runs: per-interaction
locations:
  - file: base-game-terrain.js
    line: 833
    symbol: update
    role: "if (resident > lastResident) perSecond.installs += resident - lastResident"
  - file: base-game-terrain.js
    line: 918
    symbol: get stats
    role: publishes installedTotal and installsPerSecond
measured:
  30s_walk: installs/s 0.0, installedTotal 73 (49 of them the initial fill), against roughly 35 chunks actually built
verified_by: bench-base-game-terrain.mjs — "[2] walking 5 m/s"
mutation_tested: false
```

### Cause

Both counters are driven by residency *growth*: `chunks.size` compared against last frame's. During
steady travel the window neither grows nor shrinks — one chunk arrives as one leaves — so the
difference is zero on every frame and neither counter moves.

### Effect

The panel reports "0.0 installs/s" while the streamer is at its busiest, and `installedTotal`
undercounts a 30-second walk by roughly a third. Anyone tuning `maxChunksPerUpdate` from these
numbers is reading the wrong thing.

### Solution

Count installs where they happen. `takeInstallCost().count` already carries the worker-side figure
exactly; the synchronous branch in `update()` needs the same increment. Then residency growth stops
being the proxy for it. Renaming matters as much as fixing: `installedTotal` currently means "net
window growth", and a reader has no way to know that from the panel.

### Result

Not fixed.

## F-16 — `stats` allocates 3.9 KB per read, and counts a stale field that is always zero

```yaml
id: F-16
title: stats allocates 3.9 KB per read, and counts a stale field that is always zero
severity: low
status: open
kind: defect
introduced_by: pre-existing
runs: per-interaction
locations:
  - file: base-game-terrain.js
    line: 900
    symbol: get stats
    role: walks the scene children, builds a deeply nested record
  - file: base-game-terrain.js
    line: 914
    symbol: staleTiles
    role: spreads the chunk map to count a flag nothing sets (F-10)
  - file: base-game.html
    line: 4711
    symbol: animate
    role: reads it every 15th frame
measured:
  time: p50 0.011 ms, p95 0.016 ms, max 0.48 ms
  allocation: 3.9 KB per read (7.8 MB over 2000 reads)
verified_by: bench-base-game-terrain.mjs — "[4] terrain.stats"
mutation_tested: false
```

### Cause

`stats` is the performance-record block: it counts draws and triangles by walking every scene child
and every batched chunk, filters the chunk map for stale entries, and builds a nested object with
the source identity, queue depths, the collision provider, the batcher stats and the whole far-LOD
description. It is documented as not being frame-cheap, and it is read four times a second by the
panel.

### Effect

15.6 KB/s of garbage and 0.04 ms/s of time. Not a problem; recorded so that it is not moved into the
loop later, and because `staleTiles` is doing real work (a full spread and filter) for a value that
`F-10` shows can only ever be zero.

### Solution

Drop `staleTiles` with the rest of the stale machinery, or count it in the same pass that already
walks the chunks. Leave the rest as it is — this is the right shape for a 4 Hz readout.

### Result

Not fixed. Deliberately low.

## F-17 — `coverAt` allocates one object per placement candidate

```yaml
id: F-17
title: coverAt allocates one object per placement candidate
severity: low
status: open
kind: defect
introduced_by: pre-existing
runs: per-rebuild
locations:
  - file: base-game-terrain.js
    line: 430
    symbol: coverAt
    role: returns a fresh { grass, plant, tree } and does four window samples
  - file: base-game-trees.js
    line: 128
    symbol: placement scoring
    role: one call per candidate
  - file: base-game-trees.js
    line: 174
    symbol: readiness gate
    role: a second call per candidate, for its null-ness alone
verified_by: source review
mutation_tested: false
```

### Cause

`coverAt` samples three channels and packs them into a new object. The tree placement layer calls it
once to score a candidate and once more, elsewhere, only to test whether the field has streamed
there yet — the second call allocates a whole result to check it is not null.

### Effect

Two objects per candidate on a placement pass. Placement is budgeted to one chunk per frame, so this
is bounded, but the readiness call is pure waste: `terrain.fieldsReady(x, z)` already answers that
question without allocating.

### Solution

Point the readiness gate at `fieldsReady`. For the scoring call, either accept the allocation or add
an out-parameter form; scoring is not per-frame, so the first is defensible.

### Result

Not fixed.

## F-18 — The rebase handler allocates a Vector3 per rebase

```yaml
id: F-18
title: The rebase handler allocates a Vector3 per rebase
severity: low
status: open
kind: defect
introduced_by: pre-existing
runs: per-interaction
locations:
  - file: base-game-terrain.js
    line: 319
    symbol: worldCoordinates.onRebase
    role: "root.position.add(new THREE.Vector3().fromArray(event.delta))"
verified_by: source review
mutation_tested: false
```

### Cause

The render origin moves rarely, and the handler builds a temporary vector to add the delta.

### Effect

One `Vector3` per rebase. Negligible, and listed only because a hoisted scratch is a one-line change
and because `root.position.x += delta[0]` needs no vector at all.

### Solution

Add the three components directly.

### Result

Not fixed. Deliberately low.

## F-19 — The visual rubric has not been run

```yaml
id: F-19
title: The visual rubric has not been run
severity: medium
status: unverified
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: .claude/skills/improve-webgpu/SKILL.md
    symbol: Step 4
    role: the ten-row rubric
blocked_on: the page rendering; a visual claim needs evidence, not source
rows_at_risk: [geometry, scale-and-contact, image-stability, textures]
verified_by: none
mutation_tested: false
```

### Cause

Step 4 requires looking at what the page renders, and this audit ran entirely in Node.

### Effect

Every visual claim about the terrain here is unsupported. Four rows carry known risk from source:

- **Geometry** — `F-11`'s hole during a source swap with far LOD off, and the chunk/clipmap seam,
  which the clipmap handles with a hole rect inset by the overlap. Both are boundary behaviour that
  only the page shows.
- **Scale and contact** — the roads work established that anything draped on the ground must sample
  the rendered mesh, not the field. Base Game's contact window is lod-0 at 1.25 m posts, which is
  the spacing the near chunks are built from, so the two should agree at the posts and disagree
  between them by the interpolation error. Unmeasured.
- **Image stability** — the LOD dissolve between the exact chunks and the cascade levels ramps over
  0.6 s against a 96-texel coverage map, and nothing has confirmed it reads as a dissolve rather
  than a pop or a shimmer.
- **Textures** — the streamed splat's far-tiling handover at 40–220 m and the average-colour settle
  from 250–1400 m are exactly the kind of distance blend that looks wrong before it looks right.

### Solution

Run the page and walk those four rows. Worth capturing at the same time: `passTerrain` against
`passGrass` and `passForest`, standing and walking, and `renderer.info.memory.geometries` while
idle — the chunk streamer creates and disposes geometry continuously, so a rising count while
walking a closed loop would be a disposal leak this audit could not see.

### Result

Open. This is the gating item for the audit as a whole.

## F-20 — No GPU-side measurements

```yaml
id: F-20
title: No GPU-side measurements
severity: high
status: unverified
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: bench-base-game-terrain.mjs
    role: CPU only, headless, no backend, useWorker false
  - file: frame-profiler.js
    symbol: DEFAULT_GPU_PREFIXES
    role: gpuTerrainMs, unpopulated in this audit
  - file: base-game-terrain.js
    symbol: get stats
    role: draws and triangles are counted, never timed
verified_by: none
mutation_tested: false
```

### Cause

Everything here ran in Node. ~~The terrain's raster cost exists only as 49 draws and 51,842
triangles at the default radius, plus whatever the far LOD adds.~~ That was the subsystem and bench
default, not the page configuration audited here: `base-game.html` overrode it with radius 6, or
169 near chunks, and planar water reflection submitted that terrain again every other frame. F-22
and F-23 correct the record and the page defaults.

### Effect

The headline figure — one `drawIndexed` per visible chunk on the WebGPU backend, because
`BatchedMesh` gives one scene object but no multi-draw — is geometry, not time. Whether 49 chunk
draws land as 0.5 ms or 4 ms is unknown, and the two settings built to answer it (draw radius, and
`?chunkcull=0` for the per-chunk frustum-cull arm) have not been swept in this pass.

The trees audit learned this the hard way: it filed its own GPU-measurement gap as `low`, and that
gap turned out to be hiding the freeze users actually reported. The same reasoning applies here, so
this is filed `high` from the start.

### Solution

Run the page with `?gputime` and capture, for defaults and for radius 6, on both sources: frame
median/p95/p99/max, `passTerrain`, `passTerrainFold`, `passTerrainField`, `gpuTerrainMs`,
`renderer.info.render.drawCalls`, triangles, and `renderer.info.memory.geometries` idling and
walking. Then A/B `?chunkcull=0`, which the defaults comment says was measured once and should be
re-measured against the current chunk count.

### Result

Open.

## F-21 — The first sea-level assertion passed with the fix reverted

```yaml
id: F-21
title: The first sea-level assertion passed with the fix reverted
severity: info
status: fixed
kind: test-gap
introduced_by: this-work
runs: n/a
locations:
  - file: test-base-game-sea-level.mjs
    symbol: "a source swap moves the waterline cover is derived against"
    role: where the weak assertion was
verified_by: mutation — reverting F-08 now fails with "dry 199, drowned 199"
mutation_tested: true
```

### Cause

The first version derived a tile of biome id 0 at 6 m and asserted the cover came back zero. Biome
id 0 is `deep_ocean`, which grows nothing at any sea level, so the assertion held whether or not
`tileCover` had the new waterline.

### Effect

A green test that could not fail — the same shape the trees audit recorded as its `F-20`, found
again on the first try in this one.

### Solution

Make the assertion discriminate. Plains at 20 m must grow and plains at 6 m must not, under a sea
level of 12. Only the second half depends on the fix, and the first half proves the harness is
producing cover at all rather than zero for an unrelated reason.

### Result

Fixed and mutation-tested. Worth generalising past the trees audit's version of the lesson: an
assertion has to fail for the reason it names, and picking a fixture that fails for *some* reason is
how that goes wrong.

## F-22 — The page silently overrode the audited 49-draw terrain default with 169 chunks

```yaml
id: F-22
title: The page silently overrode the audited 49-draw terrain default with 169 chunks
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game.html
    symbol: DEFAULT_SETTINGS.terrainDrawRadius
    role: page-level radius 6 overrode the subsystem radius 3
  - file: base-game-terrain.js
    symbol: BASE_GAME_TERRAIN_DEFAULTS.renderRadius
    role: subsystem and benchmark default is radius 3
measured:
  before: radius 6 = 169 resident near chunks and approximately 169 WebGPU drawIndexed submissions
  after: radius 3 = 49 resident near chunks and approximately 49 WebGPU drawIndexed submissions
verified_by: test-base-game-water.mjs — the page uses BASE_GAME_TERRAIN_DEFAULTS.renderRadius
mutation_tested: false
```

### Cause

The terrain subsystem defaulted to radius 3, and the headless audit benchmark used that default.
The page independently set `terrainDrawRadius: 6` and applied it every frame. Because a radius is a
square window, doubling the number did not double the work: it grew the near window from 7×7 to
13×13 chunks. `BatchedMesh` reduces scene objects but Three's WebGPU backend still emits one indexed
draw for each visible batch geometry.

### Effect

The audit called 49 terrain draws the default while the shipped page asked for as many as 169. That
is 120 additional near-terrain submissions in the ordinary render, plus extra resident geometry,
streaming work, and frustum tests. It also multiplied F-23's optional mirror pass.

### Solution

Use `BASE_GAME_TERRAIN_DEFAULTS.renderRadius` in the page settings instead of duplicating a larger
literal. Keep the panel range so a user can explicitly trade submissions for reach.

### Result

Fixed. The page and subsystem now share radius 3, reducing the default near-terrain window and its
potential draw submissions by 71%. A source-level assertion pins the page to the exported default.

## F-23 — Planar water reflection duplicated terrain rendering on alternating default frames

```yaml
id: F-23
title: Planar water reflection duplicated terrain rendering on alternating default frames
severity: high
status: fixed
kind: defect
introduced_by: pre-existing
runs: per-frame
locations:
  - file: base-game.html
    symbol: DEFAULT_SETTINGS.waterReflection
    role: opted every fresh page into the planar mirror
  - file: base-game-water.js
    symbol: mirrorBase.updateBefore
    role: renders the reflected scene every reflectRate frames
measured:
  before: one extra reflected-scene render every 2nd frame; terrain was not excluded
  after: sky reflection by default; no reflected-scene render on the default path
verified_by: test-base-game-water.mjs — the page does not opt into a second scene render by default
mutation_tested: false
```

### Cause

The page defaulted reflection to `planar`. The reflector is intentionally rate-limited to every
second application frame and renders at half resolution, but it is still a second traversal and
render of the reflected scene. Forest and grass were excluded; terrain was not. With F-22's old
page radius this meant roughly 169 terrain submissions could recur inside the mirror pass.

### Effect

Default frame cost oscillated between plain and mirror frames. This directly matches fluctuating
draw counts and millisecond spikes, and it gets more visible while moving because terrain streaming
and vegetation reculling add work to some of the same frames.

### Solution

Default to the sky reflection path, which shades the water from the sky function without another
scene render. Keep planar and screen-space modes in the panel as explicit quality choices, and label
planar as an extra scene render instead of presenting its half-resolution/rate limits as free.

### Result

Fixed for the default configuration. Planar remains intentionally expensive when selected; a
browser GPU capture is still required to quantify its device-specific cost.

# Solution plan

Ordered by how much uncertainty each step removes, not by how easy it is. The frame-path allocation
work is already done, and nothing below should be reordered ahead of P0 — the audit's largest
remaining problem is that it has no GPU numbers at all.

Implementation progress as of 2026-08-29:

- [x] Stop the quiet frame path allocating: unload scan, active-chunk cache, coverage closure,
      `frameCost`, `takeInstallCost`, `primaryMesh`, chunking signature (`F-01` … `F-07`).
- [x] Carry the new sea level into the cover derivation on a source swap (`F-08`).
- [x] Diagnose and fix the red handoff test; the terrain suite is green (`F-09`).
- [x] Pin the no-allocation invariants with assertions that observe the cost (`F-02`, `F-04`, `F-05`).
- [x] Reconcile the page with the radius-3 terrain budget and make planar reflection opt-in
      (`F-22`, `F-23`).
- [ ] Run the P0 browser capture; no GPU acceptance gate is claimed yet.
- [ ] Resolve the stale-retention contract one way or the other (`F-10`, `F-11`).
- [ ] Cut the volumetric collider pass's per-frame allocation (`F-12`).

## P0 — Establish a real GPU baseline

1. Capture standing and walking, 20 seconds each, for the analytic default and a v5 recipe, at draw
   radius 3 and 6, with far LOD on and off.
2. Record frame median/p95/p99/max, total GPU frame time, `passTerrain` and its fold/field/install
   sub-marks, `gpuTerrainMs`, `renderer.info.render.drawCalls`, triangles, and
   `renderer.info.memory.geometries` at both ends of the walk.
3. A/B `?chunkcull=0`. The defaults comment records a 2026-08-26 measurement at an unstated chunk
   count; re-measure it rather than inheriting the conclusion.
4. Acceptance gate: no finding moves to `fixed` on a GPU claim without a before/after capture on the
   same camera path. Node benchmarks stay regression checks, not GPU evidence.

## P1 — Close the visual rubric

1. Run `F-19`'s four at-risk rows: the swap hole, contact against the drawn mesh, the LOD dissolve,
   and the splat distance handover.
2. Decide `F-11` from what the swap actually looks like. If the hole is visible,
   `restream({ drop: farLodMode })` is the fix and it also settles `F-10`'s dead branch.
3. Acceptance gate: every row either passes or has a finding of its own.

## P2 — Finish the allocation pass in volumetric mode

1. Give the bench a volumetric arm, so `F-12` has a number before and after.
2. Fix `F-12` (precomputed collider window) and `F-13` (no spread in the fold sweep).
3. Acceptance gate: the quiet frame path allocates no more in volumetric mode, with four streamers,
   than it now does in heightfield mode with one.

## P3 — Make the panel tell the truth

1. Fix `F-15`: count installs where they happen, and rename `installedTotal` to what it measures.
2. Resolve `F-10`: delete the stale machinery or give it a caller, and bring
   `docs/subsystems/terrain.md` back in line either way.
3. Fix `F-16`'s `staleTiles` with it.
4. Acceptance gate: the panel's install rate is non-zero while chunks are streaming, and every field
   in `stats` describes something that can vary.

## P4 — Price the synchronous path

1. Fix `F-14`: one tile per frame on the no-worker path, and measure the cold-start chunk on v5.
2. Re-run the relay's own terrain numbers, since the server takes this path by construction.
3. Acceptance gate: no synchronous terrain frame above the agreed budget on either source.
