---
title: Base Game trees — WebGPU audit
page: base-game.html
subsystem: vegetation
scope: The tree plan T2 forest — base-game-forest.js, the forest-gpu.js additions, and the base-game.html wiring
skill: improve-webgpu
date: 2026-08-28
baseline: 64.1 fps, 15.6 ms mean frame, 225 draws mean / 304 peak, 381k triangles (capture 2026-08-26)
measurements: bench-base-game-forest.mjs (CPU, headless — no GPU-side numbers in this audit)
steps_complete: [1, 3]
steps_partial: [2, 5, 6]
steps_not_run: [4]
findings: 28
severity_counts:
  high: 10
  medium: 9
  low: 8
  info: 1
status_counts:
  fixed: 9
  deferred: 1
  open: 11
  unverified: 7
kind_counts:
  defect: 19
  gap: 5
  regression: 1
  test-gap: 1
  observation: 2
---

# Base Game trees — WebGPU audit

Findings from running `improve-webgpu` over the forest shipped at tree plan T2. Most of these are
defects I introduced building it; where a finding is inherited from `forest-gpu.js` or predates the
work, `introduced_by` says so.

> **Reviewer revision, 2026-08-29.** The original audit is preserved in place. Claims rejected or
> narrowed by source review are struck through, followed by the replacement conclusion. Metadata
> reflects the revised disposition so machine readers do not treat a disputed fix as complete.
> The review ran `test-base-game-forest.mjs` (81/81 passed), `test-base-game-trees.mjs` (45/45),
> `test-base-game-tree-species.mjs` (7/7), `test-trees-geometry.mjs` (27/27),
> `test-tree-presets.mjs` (222/222), and `bench-base-game-forest.mjs`, but
> those harnesses still use renderer stubs and therefore do not close the GPU evidence gap.

The audit is **incomplete**. Step 4 (the visual rubric) has not run and cannot run without the page
rendering, and Step 2 has CPU numbers only. `F-16` through `F-19` record those gaps as findings in
their own right rather than leaving them implied.

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
every frame or leaks GPU memory. Line numbers are as of 2026-08-28 and will drift; the `symbol`
field is the durable half.

# Findings

## F-01 — The frame loop scanned every tree instance

```yaml
id: F-01
title: The frame loop scanned every tree instance
severity: high
status: fixed
kind: regression
introduced_by: this-work
runs: per-frame
locations:
  - file: base-game-forest.js
    line: 239
    symbol: syncStats
    role: the caller that made a lazy scan eager
  - file: forest-gpu.js
    line: 556
    symbol: computeCullEstimate
    role: the scan
  - file: forest-gpu.js
    line: 805
    symbol: get stats
    role: the getter that runs it
measured:
  before: 0.016 ms/read at 253 instances, 0.208 ms/read at 10496 instances
  after: 0 scans in 200 idle frames; forest.update() idles at 0.004-0.007 ms
verified_by: test-base-game-forest.mjs — "twenty more frames run the instance scan zero times"
mutation_tested: true
```

### Cause

`syncStats()` read `forestGPU.stats` once per frame. That getter calls `computeCullEstimate()`,
which walks every live instance recomputing the cone and far-cutoff maths on the CPU, and allocates
three objects and two arrays. `forest-gpu.js` had made it lazy deliberately — its own comment says
the estimate is "computed ONLY when something reads `stats`, not every update() call". Wiring the
per-frame path to it undid that.

### Effect

0.21 ms of CPU per frame at 10,496 instances, against a 15.6 ms frame. That instance count is
reachable with the shipped sliders, not a synthetic worst case. Plus five allocations per frame
feeding the collector.

### Solution

Split the read. `forestGPU.summary` neither scans nor allocates and now carries everything the
per-frame path needs (`variants`, `truncating`, `cullEstimates`). The per-rung instance counts and
the triangle estimate moved to `base-game-forest.sampleDetail()`, called by the panel readout on its
15-frame interval and by a capture, never from the loop.

### Result

Zero scans across 200 idle frames, confirmed by counter rather than by inspection.
`forest.update()` idles at 0.004–0.007 ms across defaults, dense and wide configurations. See
`F-05` for the allocation that remains on the interaction path.

## F-02 — A palette rebuild leaked every GPU storage buffer

```yaml
id: F-02
title: A palette rebuild leaked every GPU storage buffer
severity: high
status: fixed
kind: defect
introduced_by: donor
runs: per-rebuild
locations:
  - file: forest-gpu.js
    line: 825
    symbol: dispose
    role: freed meshes and materials but not storage
  - file: base-game-forest.js
    line: 173
    symbol: teardownRenderer
    role: the rebuild path that calls it
  - file: environment-viewer.html
    line: 3537
    symbol: rebuildForestGPU
    role: the other host with the same leak
measured:
  leak_per_rebuild: ~2 MB at 12 variants (source 393 KB, draw 1.57 MB, counts, atomics, 96 indirect)
verified_by: test-base-game-forest.mjs — "every storage buffer the old forest owned was freed"
mutation_tested: true
```

### Cause

Storage attributes have no dispose event, and `ComputeNode.dispose()` frees pipelines and bind
groups but not the buffers behind them. `forest-gpu.js`'s `dispose()` disposed the mesh geometries
and materials and stopped there, so the source, draw, count, survivor-atomic and eight-per-variant
indirect buffers survived every teardown.

### Effect

Roughly 2 MB of GPU memory lost per palette rebuild, and a rebuild is on a slider — species count,
capacity, and every leaf parameter. Ten drags is 20 MB. `environment-viewer.html` has the same leak
on `rebuildForestGPU`.

### Solution

Free them through `renderer._attributes.delete`, the same guarded private path
`grass-compute.js:683` already uses, plus `dispose()` on the compute nodes. The survivor-atomic
attribute was inline in a `storage()` call and had to be hoisted to a named binding so it could be
reached.

### Result

All 4 + 8×variants attributes freed per teardown, asserted by a stub renderer that counts deletions.
Fixes `environment-viewer.html` at the same time, since the fix is in the shared module.

## F-03 — The density slider emptied the forest while being dragged

```yaml
id: F-03
title: The density slider emptied the forest while being dragged
severity: medium
status: fixed
kind: defect
introduced_by: this-work
runs: per-interaction
locations:
  - file: base-game.html
    line: 3449
    symbol: addCommitRange(plantsSec, 'treesPerHectare', ...)
    role: the control
  - file: base-game-trees.js
    symbol: apply
    role: identity change triggers rebuildAll
  - file: flora-chunks.js
    symbol: rebuildAll
    role: forced full re-queue
verified_by: none — reasoned from the rebuildAll path, not measured in a browser
mutation_tested: false
```

### Cause

`treesPerHectare` is in `TREE_IDENTITY_KEYS`, so changing it makes `trees.apply` call
`rebuildAll`, which force-queues every resident chunk for clear and rebuild. It was wired with
`addRange`, which commits on `input` — every drag frame.

### Effect

49 chunks re-queued per drag frame against a one-chunk-per-frame placement budget. The forest drains
and does not refill until the drag ends. Grass density is a plain setter, which is why `addRange` is
correct there and wrong here.

### Solution

`addCommitRange`, which commits on release, matching the other rebuild-class sliders
(`treeSpecies`, `treeMaxSize`, `treeCapPerVariant`).

### Result

Fixed in code. Not confirmed in a browser — the failure mode is visual and belongs to Step 4.

## F-04 — Mesh geometry is uploaded to the GPU three times per variant

```yaml
id: F-04
title: Mesh geometry is uploaded to the GPU three times per variant
severity: medium
status: deferred
kind: defect
introduced_by: donor
runs: once
locations:
  - file: forest-gpu.js
    line: 287
    symbol: drawMesh
    role: clones the palette geometry per mesh
measured:
  uploaded: 24.66 MB across 96 meshes
  distinct: 13.53 MB
  waste: 11.13 MB
verified_by: bench-base-game-forest.mjs — "geometry uploaded / distinct"
mutation_tested: false
```

### Cause

`drawMesh` calls `geom.clone()` so each mesh can carry its own `instanceCount` and `indirect`
attribute. `BufferGeometry.clone()` deep-copies the attribute arrays, and a variant's branch
geometry is drawn at three LOD rungs, its leaves at two — so branches reach the GPU three times and
leaves twice.

### Effect

11.13 MB of duplicated vertex data resident on the GPU. A constant, not a leak, and not on the frame
path.

### Solution

Build each draw geometry with `setAttribute`/`setIndex` referencing the source's existing
`BufferAttribute` objects instead of cloning them. Three.js's WebGPU backend keys uploads off the
attribute instance, so sharing means one upload.

**A correction to the record.** An earlier version of this finding said sharing was unsafe here,
because three.js's `Geometries` registers a dispose listener that calls `attributes.delete()` on
every attribute of a disposed geometry — so the first mesh torn down would free buffers the other 95
still reference. The hazard is real in general and does not apply to this ownership model:
`forest-gpu.js` creates all 96 geometries together and disposes them together in one loop, alongside
the palette, so there is no window in which a freed buffer is still referenced. That justification
was an overstated generalisation and should not be used to keep this deferred.

### Result

Not fixed. Deferred on severity — the skill ranks by frame-loop leverage and this is neither in the
loop nor a leak. Expected on fixing: uploaded geometry falls from 24.66 MB to 13.53 MB, with the
same benefit in `environment-viewer.html`.

## F-05 — `apply()` allocates on every settings change

```yaml
id: F-05
title: apply() allocates on every settings change
severity: low
severity_revised: was medium; interaction-only allocation hygiene is not a plausible gameplay-lag cause
status: open
kind: defect
introduced_by: this-work
runs: per-interaction
locations:
  - file: base-game-forest.js
    line: 327
    symbol: apply
    role: builds a placement object and a focus array per call
  - file: base-game.html
    line: 2284
    symbol: applyForestSettings
    role: the caller
verified_by: none — read from source
mutation_tested: false
```

### Cause

`apply()` builds a fresh `placement` object each call and passes focus as a newly allocated
`[x, z]` array. `applyForestSettings` calls it whenever any of 19 watched keys change, which during
a slider drag is once per frame.

### Effect

Two allocations per drag frame. Small in isolation; it is the pattern the skill names, and the
forest is not the only layer doing it.

**Reviewer revision.** ~~This is medium-severity optimization work.~~ This is low-priority allocation
hygiene. It does not run during ordinary play and cannot explain standing, walking, or first-enable
GPU stalls. Do not schedule it ahead of `F-08`, `F-21`, `F-22`, `F-23`, or `F-25` through `F-28`.

### Solution

Hoist a reusable placement object and a two-element focus scratch, clearing rather than
reallocating.

### Result

Not fixed.

## F-06 — Any settings change rewrites all 96 mesh visibility flags

```yaml
id: F-06
title: Any settings change rewrites all 96 mesh visibility flags
severity: low
severity_revised: was medium; only setRenderParts performs the unconditional mesh walk
status: open
kind: defect
introduced_by: this-work
runs: per-interaction
locations:
  - file: base-game-forest.js
    line: 222
    symbol: syncRenderState
    role: unconditional, no diff
  - file: forest-gpu.js
    symbol: setRenderParts
    role: always calls syncRenderParts
verified_by: none — read from source
mutation_tested: false
```

### Cause

`syncRenderState()` runs on every non-palette `apply()` and ~~unconditionally re-sends LOD distances,
the max draw radius, the rung mask, the render parts, the sway and the base offset~~ calls every
setter. Most of those setters already compare the incoming value; `setRenderParts()` is the material
exception because it always calls `syncRenderParts()`.
`forestGPU.setRenderParts` then always calls `syncRenderParts`, which walks all 96 meshes.

### Effect

Dragging the density slider rewrites 96 mesh visibility flags and ~~re-sends five uniforms that did
not change~~ invokes setters whose internal diffs reject most unchanged values. Cheap per call, on
the interaction path, and it makes the cost of a slider independent of what the slider does.

**Reviewer revision.** The unconditional visibility walk is real, but it is low severity and not a
credible explanation for lag outside a slider drag.

### Solution

Diff each group before sending, the way `applyForestSettings` already diffs its key list.

### Result

Not fixed.

## F-07 — The tree window follows the camera, not the player

```yaml
id: F-07
title: The tree window follows the camera, not the player
severity: low
severity_revised: was medium; camera-centred render residency is intentional unless gameplay residency is coupled to it
status: open
kind: observation
kind_revised: was defect; the correct focus depends on the residency contract
introduced_by: this-work
runs: per-frame
locations:
  - file: base-game-forest.js
    line: 117
    symbol: readFocus
    role: reads camera.position
  - file: base-game.html
    line: 4682
    symbol: frameProfiler.timeAsync('forestGpu', ...)
    role: the per-frame call
verified_by: none — read from source; not reproduced
mutation_tested: false
```

### Cause

`readFocus()` derives the placement focus from `camera.position` plus the render origin. The grass
layer does the same, and for a first-person rig camera and player coincide.

### Effect

~~The moment the camera detaches from the player — free-fly, spectator, orbit — chunks stream around
wherever the camera is looking rather than around the player. Trees would appear and vanish behind a
free camera, and in multiplayer the placement window would follow a local camera rather than the
simulated body.~~

**Reviewer revision.** A local rendering-residency window normally should follow the camera; using
the player would instead leave a detached spectator or free camera looking at an empty world. This
becomes a defect only if the same resident set is later used for player-centred collision, AI, or
authoritative gameplay. Split render residency from gameplay residency at that point.

### Solution

~~Take the focus from `playerController.getPosition()`, as `terrain.update` already does at
`base-game.html:4674`, and fall back to the camera only when there is no player.~~ Keep camera focus
for rendering. If gameplay consumers require a player window, give them a separate focus and
residency contract rather than making one window serve incompatible purposes.

### Result

~~Not fixed. Harmless in the default first-person view, which is why it was not caught.~~ No render
fix recommended. Record the contract before T7 collision work.

## F-08 — The palette bake is a synchronous stall on the frame trees turn on

```yaml
id: F-08
title: The palette bake is a synchronous stall on the frame trees turn on
severity: high
severity_revised: was medium; the synchronous 68-139 ms enable-frame stall is directly user-visible
status: unverified
status_revised: yielding implementation landed 2026-08-29; browser frame-time acceptance remains open
kind: defect
introduced_by: this-work
runs: once
locations:
  - file: base-game-forest.js
    symbol: publishFamilyWave
    role: compiles and publishes each complete cross-family variant wave
  - file: forest-palette.js
    symbol: createForestPaletteAsync
    role: bakes breadth-first across families and reports each completed wave
measured:
  headless: 33-79 ms total CPU bake for six named-default variants; publication is split into two three-species waves
verified_by: bench-base-game-forest.mjs — "palette bake"
mutation_tested: true
```

### Cause

~~`buildAsync()` runs `createForestPalette` in one synchronous call on whichever frame the lazy
imports resolve. Despite the async name, execution remains synchronous until the later
`compileAsync()` await. That runs the procedural tree generator once per variant — twelve times at
defaults.~~ Base Game now bakes breadth-first: variant zero for every family, then variant one for
every family. Each complete wave is compiled, compute-warmed, and published before the next wave.

### Effect

~~A single frame of 68–139 ms measured headless, landing exactly when the user ticks the Trees box.~~
~~Total CPU bake remains 66–132 ms headless~~ The named-species default measured 33–79 ms total,
but it is yielded between family members and no longer
gates the whole forest. The browser frame cost of one generator slice remains unmeasured.

### Solution

~~Bake one variant per frame behind the existing "waiting on the palette" readout, or move the bake
to a worker.~~ The incremental path now retains one fixed instanced GPU allocation, hides unfinished
slots, and publishes complete cross-family waves. Moving generation to workers remains the stronger
option if one individual variant still exceeds the browser frame budget.

### Result

~~Not fixed.~~ Implemented in code on 2026-08-29: `createForestPaletteAsync()` preserves the donor's
synchronous API for other hosts, yields between family members, and aborts stale work. Base Game
publishes all families' first variants together, then all families' second variants, rather than
waiting for the full palette. Tests verify wave ordering, species-major GPU identity, compilation
before each wave enters the scene, and cancellation during an in-flight compile. This remains
unverified until a browser capture proves each individual generator slice stays inside budget.

## F-09 — Per-frame timing that only a panel reads

```yaml
id: F-09
title: Per-frame timing that only a panel reads
severity: low
status: open
kind: defect
introduced_by: this-work
runs: per-frame
locations:
  - file: base-game-forest.js
    line: 321
    symbol: stats.updateMs
    role: two performance.now() calls per frame
verified_by: none — read from source
mutation_tested: false
```

### Cause

`update()` brackets itself with `performance.now()` to fill `stats.updateMs`, whether or not
anything reads it. The page already times the same call through `frameProfiler.timeAsync('forestGpu')`.

### Effect

Two clock reads per frame for a number that duplicates a profiler slot.

### Solution

Drop it and read `passForestMs` from the profiler, or gate it behind a capture being active the way
`frameOther` already is.

### Result

Not fixed.

## F-10 — `meshes` hands out the live internal array

```yaml
id: F-10
title: meshes hands out the live internal array
severity: low
status: open
kind: defect
introduced_by: this-work
runs: n/a
locations:
  - file: base-game-forest.js
    line: 281
    symbol: get meshes
    role: returns forestGPU.meshes directly
verified_by: none — read from source
mutation_tested: false
```

### Cause

The getter returns `forestGPU.meshes`, which is the array `forest-gpu.js` iterates in
`syncRenderParts` and `dispose`.

### Effect

A caller that sorted, spliced or pushed to it would corrupt the mesh-to-rung index that
`syncRenderParts` depends on. Nothing does today.

### Solution

Return a copy, or freeze the contract in the doc comment. The same question applies to `onMeshes`,
which passes the same array to the host.

### Result

Not fixed.

## F-11 — `rungTriangles` allocates on every read

```yaml
id: F-11
title: rungTriangles allocates on every read
severity: low
status: open
kind: defect
introduced_by: this-work
runs: n/a
locations:
  - file: base-game-forest.js
    line: 283
    symbol: get rungTriangles
    role: spreads into a new array per read
verified_by: none — read from source
mutation_tested: false
```

### Cause

`get rungTriangles() { return [...rungTris]; }` copies defensively on each access.

### Effect

One small array per read. Both current callers — the bench and the test — read it outside the loop,
so this costs nothing today and is listed only so it is not moved into the loop later.

### Solution

Leave as is, or return a frozen array built once per bake.

### Result

Not fixed. Deliberately low.

## F-12 — A missing ground height is indistinguishable from a real one

```yaml
id: F-12
title: A missing ground height is indistinguishable from a real one
severity: low
status: open
kind: defect
introduced_by: this-work
runs: per-rebuild
locations:
  - file: base-game-forest.js
    line: 125
    symbol: globalHeightAt
    role: returns -1e5 as a sentinel
  - file: forest-gpu.js
    line: 495
    symbol: rebuild
    role: writes it into the instance buffer unchecked
verified_by: none — read from source
mutation_tested: false
```

### Cause

`globalHeightAt` returns `-1e5` when `terrain.groundHeight` gives a non-finite answer. `rebuild()`
writes that straight into the instance buffer with the vertical bias added.

### Effect

The tree is drawn 100 km below the world instead of being skipped. It still consumes a variant slot
and a cull thread, and it silently counts as a standing tree in every stat. The placement layer is
careful about exactly this — it rejects rather than inventing a height — and the renderer is not.

### Solution

Skip the record rather than writing a sentinel, and count the skips so the readout can report them.

### Result

Not fixed. Unreachable in practice today, since `groundHeight` falls back to the analytic source
rather than failing.

## F-13 — The placement window was only reconciled to the draw radius in `apply()`

```yaml
id: F-13
title: The placement window was only reconciled to the draw radius in apply()
severity: medium
status: fixed
kind: defect
introduced_by: this-work
runs: once
locations:
  - file: base-game-forest.js
    line: 91
    symbol: cfg.treeRadius = drawRadius()
    role: the constructor reconciliation that was missing
measured:
  before: 121 chunks resident to draw 49
  after: 49 chunks
verified_by: test-base-game-forest.mjs — "the chunk window follows the draw radius from the first frame"
mutation_tested: false
```

### Cause

`treeRadius` (the placement window) is derived from `treeDrawRadius`, but the derivation only ran
inside `apply()`. A forest constructed and never re-applied kept the module default of 400 m while
drawing to 260 m.

### Effect

121 chunks placed to draw 49 — two and a half times the placement work and record memory. Masked in
the page because `applyForestSettings` calls `apply()` on its first pass; found by the bench, which
does not.

### Solution

Reconcile at construction as well, before `createBaseGameTrees` is built.

### Result

Fixed and pinned by a test that constructs a forest and never applies to it.

## F-14 — Teardown left dead meshes in the mirror-exclusion list

```yaml
id: F-14
title: Teardown left dead meshes in the mirror-exclusion list
severity: medium
status: fixed
kind: defect
introduced_by: this-work
runs: per-rebuild
locations:
  - file: base-game-forest.js
    line: 173
    symbol: teardownRenderer
    role: now notifies with an empty list
  - file: base-game.html
    line: 2268
    symbol: forest.onMeshes
    role: reconciles instead of appending
verified_by: none — read from source
mutation_tested: false
```

### Cause

`onMeshes` appended to the page's `reflectionExclusions` array and nothing ever removed from it, so
each rebuild added 96 more entries pointing at disposed meshes.

### Effect

The array the planar mirror walks each reflect frame grows without bound across rebuilds, holding
references to disposed meshes and preventing their collection.

### Solution

`teardownRenderer` fires `onMeshes([])`, and the page removes what it previously added before adding
the new list.

### Result

Fixed. Not covered by a test — the exclusion list lives in the page, not the module.

## F-15 — `showError` does not exist

```yaml
id: F-15
title: showError does not exist
severity: low
status: fixed
kind: defect
introduced_by: pre-existing
runs: n/a
locations:
  - file: base-game.html
    line: 2245
    symbol: applyFloraSettings
    role: grass load-failure path
  - file: base-game.html
    line: 2283
    symbol: applyForestSettings
    role: tree load-failure path, copied from it
verified_by: repo-wide grep — no definition anywhere
mutation_tested: false
```

### Cause

The grass lazy-load failure path called `showError(...)`, a function defined nowhere in the repo. I
copied the idiom into the tree path without checking it resolved.

### Effect

A failed dynamic import would throw `ReferenceError` from inside the error handler, replacing a
recoverable "grass unavailable" message with an unhandled rejection. Never triggered, because the
import has never failed.

### Solution

`console.warn` with a `[base-game]` prefix, matching the house style at `base-game.html:905`, `:986`
and `:1120`. The panel readout already surfaces `lastError` to the user.

### Result

Fixed on both paths.

## F-16 - The visual rubric has not been run

```yaml
id: F-16
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
blocked_on: the page rendering with trees on; a visual claim needs evidence, not source
rows_at_risk: [scale-and-contact, render-sanity, shadows, image-stability]
verified_by: none
mutation_tested: false
```

### Cause

Step 4 requires looking at what the page renders. No one has run Base Game with trees enabled.

### Effect

Every visual claim about this forest is currently unsupported. Four rows are at elevated risk and
are recorded separately: `F-17` (render sanity), `F-18` (scale and contact). Shadows and image
stability are known and already scoped — leaf shadows exist only at LOD0 while the shadow camera
covers ±90 m (tree plan D5, deferred to T3), and the LOD rings have no hysteresis while the recull
is gated at 1.5 m of travel, so a tree near a ring may flip band as the camera walks.

### Solution

Run the page with trees on and walk the four rows. The numbers worth capturing at the same time are
`passForestMs` against `passGrassMs` and `passPostMs`, standing and walking, and
`renderer.info.memory.geometries` while idle.

### Result

Open. This is the gating item for the audit as a whole.

## F-17 — The canopy sway graph cannot be compiled headless

```yaml
id: F-17
title: The canopy sway graph cannot be compiled headless
severity: medium
status: unverified
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: forest-gpu.js
    symbol: swayed
    role: the sway displacement
  - file: forest-gpu.js
    symbol: instanceNodes
    role: the positionNode it feeds
  - file: tsl-build-check.mjs
    symbol: buildMaterial
    role: cannot compile storage-buffer materials without a backend
verified_by: none — the bark colour node is covered, the sway graph is not
mutation_tested: false
```

### Cause

The sway is folded into a `positionNode` that reads the draw storage buffer. `tsl-build-check.mjs`
compiles a NodeMaterial in Node, but storage-buffer materials need a real backend — the same
limitation that keeps `grass-compute.js` out of that harness.

### Effect

If the graph fails to compile, leaves render black or not at all. Nothing in the test suite would
catch it; the first evidence would be the page.

### Solution

No headless route exists today. The mitigation already applied is that the sway graph is only built
when a host passes `leafSway`, so `environment-viewer.html` is unaffected either way.

### Result

Unverified. Test with trees on and leaves visible; a black canopy points here first.

## F-18 — Trunks sample the collision surface, not the rendered ground

```yaml
id: F-18
title: Trunks sample the collision surface, not the rendered ground
severity: medium
status: unverified
kind: gap
introduced_by: this-work
runs: per-rebuild
locations:
  - file: base-game-forest.js
    line: 125
    symbol: globalHeightAt
    role: calls terrain.groundHeight
  - file: base-game-terrain.js
    line: 628
    symbol: groundHeight
    role: delegates to source.heightAt
  - file: terrain-system.js
    line: 221
    symbol: getHeight
    role: the exact analytic curve, not the drawn mesh
prior_art: the roads work — anything draped on the ground must sample the RENDERED mesh, not the field
verified_by: none — the 4.07 m figure below compares against the placement field, not the drawn mesh
mutation_tested: false
```

### Cause

Trunk height comes from `terrain.groundHeight`, which is `source.heightAt` — the exact height
function. The ground you see is a chunk mesh triangulated at vertex resolution, which interpolates
linearly between those samples. Between vertices the two disagree, by more the more curved the
ground.

### Effect

Trunks may sit slightly above or below the visible surface on curved terrain. The player's collision
uses the same heightfield source, so a trunk and the player's feet agree with each other — both may
sit off the drawn ground together, which is a pre-existing property of the page rather than
something the forest introduced.

### Solution

Either accept it (trunks agree with collision, which is what matters for T7) or sample the rendered
chunk mesh through `world-query-chunk-mesh-provider.js` and accept that trunks then disagree with
where the player stands. This is a decision, not a bug fix, and it should be made explicitly.

### Result

Unverified and undecided. The measured 4.07 m figure quoted elsewhere is the error against the 8 m
*placement field*, which is why that field was rejected; it says nothing about the drawn mesh.

## F-19 — No GPU-side measurements

```yaml
id: F-19
title: No GPU-side measurements
severity: high
status: unverified
severity_revised: was low, raised after the page showed the freeze this gap hid (see F-22)
kind: gap
introduced_by: this-work
runs: n/a
locations:
  - file: bench-base-game-forest.mjs
    role: CPU only, headless, no backend
  - file: frame-profiler.js
    symbol: DEFAULT_GPU_PREFIXES
    role: gpuForestMs, unpopulated in this audit
verified_by: none
mutation_tested: false
```

### Cause

Everything measured here ran in Node without a GPU. The forest's raster and compute cost exist only
as instance and triangle counts.

### Effect

The headline cost — ~~84 draws~~ 42 visible main-pass mesh submissions, plus up to 18 shadow-pass
submissions at current defaults, and ~~about 526k~~ ~~about 308k~~ about 165k estimated main-pass forest triangles
on a 225-draw, 381k-triangle baseline — is
geometry, not time. Whether that lands as 1 ms or 6 ms is unknown, and the per-rung toggles built
specifically to answer it (tree plan D5b) have not been swept. The internal `stats.draws` counter is
not comparable to `renderer.info.render.drawCalls`; see `F-25`.

### Solution

Run the page with `?gputime` for timestamps, and sweep each rung alone then in combination,
recording actual frame GPU time, `renderer.info.render.drawCalls`, triangles, `passForestMs`, and
`gpuForestMs` for each. `passForestMs` primarily covers update/compute encoding, not the later tree
raster inside the main render, so use total-frame deltas and the rung/shadow switches to isolate
raster cost rather than labeling `passForestMs` as forest render time.

### Result

Open, and re-ranked from `low` to `high`. Filed as a tidy loose end, it turned out to be the gap
that hid `F-22`: every cost this audit could see was CPU-side, and the reported freeze is pipeline
creation, which has no CPU-side signature in Node at all. A gap in the evidence is not low severity
merely because it is not a defect.

## F-20 — A test that passed under mutation

```yaml
id: F-20
title: A test that passed under mutation
severity: info
status: fixed
kind: test-gap
introduced_by: this-work
runs: n/a
locations:
  - file: test-base-game-forest.mjs
    symbol: "the forest builds and draws what placement found"
    role: where the weak assertion was
  - file: forest-gpu.js
    line: 555
    symbol: cullEstimates
    role: the counter added to make the invariant testable
verified_by: mutation — restoring the per-frame scan now fails with "300 -> 320 scans over 20 frames"
mutation_tested: true
```

### Cause

The first test written for `F-01` asserted that the per-rung fields stay unfilled after `update()`.
That is true whether or not the expensive scan runs, because the scan's cost and the fields it fills
are separate things. Reverting the fix left the test green.

### Effect

A green test that could not fail — the same failure mode found at T1 with the cover-gate assertion.
It would have let the regression back in silently.

### Solution

Make the cost observable rather than inferring it from a side effect. `forest-gpu.js` counts its own
scans and publishes `summary.cullEstimates`, so "the frame loop does not scan" is an invariant a
test can assert directly.

### Result

Fixed. The mutation now fails correctly. Worth generalising: an assertion about a *cost* has to
observe the cost, not a value that happens to correlate with it.

## F-21 — Branch geometry never decimates across LOD rungs

```yaml
id: F-21
title: Branch geometry never decimates across LOD rungs
severity: high
severity_revised: was info; the unchanged branch mesh dominates the far rung every rendered frame
status: unverified
status_revised: was open; distinct branch LOD geometry is implemented and headless-tested, but browser silhouette and GPU validation remain
kind: observation
introduced_by: donor
runs: n/a
locations:
  - file: forest-gpu.js
    symbol: "branchesL1Geo / branchesL2Geo"
    role: LOD1 and LOD2 now draw their separately baked branch geometry
  - file: trees.js
    symbol: branchLodGeometries
    role: emits simplified skins during the original skeleton traversal without changing RNG or leaf placement
measured:
  per_variant: named-default branches full/lod1/lod2 4590/1607/1012 tris; leaves 3532; leaf-shadow 1548; coarse leaves 1524
  per_rung: 9670 / 5139 / 2536 / 2
verified_by: bench-base-game-forest.mjs and test-trees-geometry.mjs
mutation_tested: true
```

### Cause

~~`forest-gpu.js` draws `variant.branches` at LOD0, LOD1 and LOD2. Only the leaves get a coarse
variant, through `coarseLeafRatio` and `coarseLeafSizeMult`.~~ The palette now asks the generator
for two extra branch skins during the same skeleton traversal. Those skins retain fewer rings and
circumference sides without advancing RNG, so the full mesh and leaf placement stay identical.

### Effect

~~A "coarse" LOD2 tree is 8858 triangles, 5618 of them undecimated trunk — 63%. Moving the LOD
rings therefore buys far less than the rung names suggest.~~ ~~The procedural default's LOD2 tree
was 4,936 triangles, including 1,696 bark triangles, and its default/dense/wide estimates were
308k/1.72M/1.57M.~~ The explicit Aspen Small/Oak Small/Pine Small default now averages 2,536
triangles at LOD2, including 1,012 bark triangles; its default/dense/wide estimates are
165k/902k/812k main-pass triangles respectively.

### Solution

Give the branch skeleton a coarse variant at bake time, the way the leaves already have one.

### Result

~~Not fixed. Recorded because it is the first thing T3 should price before moving any ring.~~
~~Not fixed, and promoted to a primary sustained-cost item. The headless sweep reports ~2.85M
main-pass triangles in the dense case and ~2.79M in the wide case; a far tree retaining 5,618 branch
triangles is not an informational concern.~~ Implemented on 2026-08-29. Generator tests prove that
opting into the LOD streams leaves the full branch mesh and leaf positions unchanged for a fixed
seed, and that triangle count falls at both branch rungs. Status remains unverified until the
browser visual rubric and GPU capture confirm transition silhouettes and frame-time benefit.

## F-22 - 84 distinct materials, each compiled on the frame its mesh first draws

```yaml
id: F-22
title: 84 distinct materials, each compiled on the frame its mesh first draws
severity: high
status: unverified
status_revised: was fixed; normal render pipelines are warmed, but shadow and compute first-use pipelines remain
kind: defect
introduced_by: donor
runs: once
locations:
  - file: forest-gpu.js
    symbol: instanceNodes
    role: bakes the variant slot offset into positionNode, so no two variants can share a material
  - file: base-game-forest.js
    symbol: buildAsync
    role: now precompiles each cross-family wave before that wave reaches the scene
  - file: forest-gpu.js
    symbol: syncRenderParts
    role: flips mesh.visible as variants populate, deferring compiles across the session
measured:
  materials: 84 distinct across 96 meshes at 3 species x 4 variants
  js_enable_cost: 136 ms palette bake + 35 ms createForestGPU (Node, excludes all pipeline work)
reported_by: user - hard freeze on enable, spikes over 1000 ms while moving
verified_by: test-base-game-forest.mjs - a renderer stub verifies the compileAsync call shape, not backend compilation
mutation_tested: true
```

### Cause

`forest-gpu.js` compiles each variant draw-buffer slot offset into its `positionNode`, so every
variant needs its own materials - 7 per variant, 84 at defaults. WebGPU builds a render pipeline per
material per pass, and three.js creates them lazily on the first frame a mesh actually draws. Meshes
start hidden and `syncRenderParts` reveals a variant only once it has records, so the compiles do
not all land at once: they arrive as chunks stream in and new variants populate.

### Effect

Reported from the page, not measured here: a hard freeze when trees are switched on, spikes over
1000 ms while moving, and worse when the draw or LOD distance rises - ~~which is exactly the shape
lazy pipeline creation produces~~ which is consistent with lazy pipeline creation but does not
distinguish it from shadow pipeline creation, compute pipeline creation, streaming uploads, or
sustained raster load. None of it appears in the Node measurements, because there is no backend to
compile against. `F-19` recorded that gap and ranked it `low`. It was the gap that mattered.

### Solution

~~`renderer.compileAsync(warmGroup, camera, scene)` before any mesh reaches the scene, with every mesh
forced visible for the pass so hidden rungs compile too.~~ The same rule now applies per cross-family
wave: the first wave may draw while the second bakes, but a wave never enters the scene before all of
its own meshes compile against the real target scene. A teardown invalidates in-flight work through
a token, including a compile promise that resumes after its GPU shell was disposed.

**Reviewer revision.** Three.js `compileAsync()` walks the normal render list; it does not execute the
shadow-map pass or the forest's compute nodes. ~~At defaults the first forest recull still creates and
encodes reset + cull + 24 finalizer compute nodes~~ Base Game now warms each reachable compute node
in a separately yielded task before entering the scene; the two-variant default reduces the chain
from 26 to 14 nodes. `Renderer.computeAsync()` still uses synchronous first-pipeline creation, which
is why staging remains necessary. Compile errors now surface through `stats.lastError`, keep the
forest out of the scene, and do not retry every frame. Shadow-map pipelines remain unwarmed.

The deeper fix is to stop needing 84 materials - read the variant offset from the draw buffer
instead of compiling it in - which is a donor refactor and is not done. `F-23` is its other half.

### Result

~~Fixed in code and covered by a test that asserts every mesh is handed to `compileAsync`, visible,
before entering the scene.~~ The normal render warmup and staged compute warmup are implemented and
their ordering is covered by stub tests. The overall finding remains **unverified** because
shadow-map pipelines are not warmed and no browser backend was exercised. ~~It explains all three reported
symptoms at the right magnitude and nothing else does~~ It is one credible contributor among several.
The discriminating matrix is Species 1/3, Variants 1/2/4, shadows off/on, and each LOD rung alone,
captured standing, walking, and first-enable.

## F-23 - The draw count is fixed at variants x rungs, and most of those draws are empty

```yaml
id: F-23
title: The draw count is fixed at variants x rungs, and most of those draws are empty
severity: high
severity_revised: was medium; this is a per-frame submission cost and the audit defines per-frame work as high
status: open
kind: defect
introduced_by: donor
runs: per-frame
locations:
  - file: forest-gpu.js
    symbol: syncRenderParts
    role: gates on variantPopulated (records exist), never on per-rung survivors
  - file: forest-gpu.js
    symbol: variantPopulated
    role: set from countsArray, which counts source records not survivors
measured:
  defaults: 56 visible instances, 84 draws
  dense: 296 visible instances, 84 draws
  wide: 311 visible instances, 84 draws
verified_by: bench-base-game-forest.mjs
mutation_tested: false
```

### Cause

The forest is genuinely GPU-instanced - a tree costs almost nothing per tree - but the work is
partitioned into `variants x rungs` regions, each with its own mesh, material and indirect draw. A
variant is hidden only when it has no source records anywhere in the window. A variant whose trees
all sit at LOD2 still submits its LOD0 and LOD1 meshes every frame with an instance count of zero.
The per-rung survivor counts are GPU atomics and are never read back, so the CPU cannot cheaply know
a rung is empty.

### Effect

84 main-pass mesh submissions at defaults render 56 visible instances - more submissions than
instances. The count does not move with the number of trees, so it is 84 whether the world holds 5
trees or 5000, on a page whose entire baseline is 225 draws. Up to 36 additional shadow submissions
are absent from this internal counter (`F-25`). Every submitted mesh also selects a pipeline.

### Solution

Two independent levers. Cheap: cut the variant count. `variantsPerSpecies` 4 to 2 halves both draws
and materials, costing silhouette variety. That is now a slider beside Species, whose readout gives
the product it controls - variants and resulting draws - because neither number means anything on
its own. ~~The default stays 4.~~ Make 2 the provisional default until GPU evidence supports 4.
Proper: avoid baking the variant/rung offset into a unique material, consolidate indirect commands,
and reduce the number of render objects. Asynchronous survivor readback can improve visibility
gating, but it is not a substitute for fixing the partition count.

### Result

Not fixed architecturally. The immediate lever landed on 2026-08-29: the provisional Base Game
default is now two variants per species, cutting the default from 12 variants / 84 main meshes to
6 variants / 42 main meshes. The headless benchmark also fell from 24.66 MB across 96 meshes to
12.32 MB across 42 meshes. ~~Triangle count is unchanged, so `F-21` and the partition refactor
remain.~~ The subsequent `F-21` implementation lowered uploaded geometry to 10.77 MB, and the
explicit named-species default lowers the current figure again to 5.56 MB across 42 meshes. The
partition refactor still remains.
For contrast, `bot-trees.js` builds one `InstancedMesh` per populated (variant, part) bucket and never
submits an empty draw, but it cannot stream.

## F-24 - LOD2 rasterised into a shadow map it cannot appear in

```yaml
id: F-24
title: LOD2 rasterised into a shadow map it cannot appear in
severity: medium
status: fixed
kind: defect
introduced_by: this-work
runs: per-frame
locations:
  - file: forest-gpu.js
    symbol: syncRenderParts
    role: set castShadow per part, with no per-rung axis
  - file: base-game-forest.js
    symbol: syncRenderState
    role: now derives the casting rungs from the shadow reach
  - file: base-game.html
    line: 2165
    symbol: rig.dirLight.shadow.camera.right
    role: the 90 m half-extent the rungs are compared against
measured:
  wasted: up to 304 LOD2 branch instances at 5618 triangles each submitted to a 90 m shadow pass from 260 m out
verified_by: test-base-game-forest.mjs - rungs past the shadow camera do not cast
mutation_tested: true
```

### Cause

`syncRenderParts` sets `castShadow` per part - bark or leaf - with no notion of distance. The bark
mesh at every rung casts, including LOD2, whose instances live between `lodR1` (140 m) and `lodR2`
(260 m). The directional shadow camera reaches 90 m either side.

### Effect

Every LOD2 branch mesh was ~~rasterised into~~ submitted to a shadow pass whose clip volume ends at
90 m, contributing no visible shadow. Geometry outside the clip volume still pays submission and
vertex work but is clipped before rasterization. ~~It costs nothing in draw calls~~ It costs one
shadow submission per populated variant (up to 12 at defaults); the internal draw counter simply
does not count shadow passes. It scales with the LOD-distance slider - one of the two controls
reported as making the lag worse.

### Solution

`forest-gpu.js` gains `setShadowRungs([...])`, defaulting to all-true so `environment-viewer.html`
is unchanged, folded into the existing `castShadow` assignment through the same mesh-to-rung map the
visibility mask uses. `base-game-forest.js` derives it: a rung casts only if it *starts* inside the
shadow reach, so with r0 60, r1 140 and a 90 m camera, rungs 0 and 1 cast and rung 2 does not.
`base-game.html` passes `rig.dirLight.shadow.camera.right` rather than a copied constant, so the two
cannot drift apart.

### Result

Fixed. Each variant now casts from three meshes instead of four, and widening the shadow camera
brings rung 2 back - the test asserts both directions, so this follows the light rather than a
hardcoded number.

## F-25 - The forest draw counter omits shadow-pass submissions

```yaml
id: F-25
title: The forest draw counter omits shadow-pass submissions
severity: high
status: open
kind: gap
introduced_by: this-work
runs: per-frame
locations:
  - file: forest-gpu.js
    symbol: submittedDraws
    role: counts visible scene meshes, not renderer submissions across passes
  - file: forest-gpu.js
    symbol: syncRenderParts
    role: enables three shadow-casting meshes per default variant
  - file: base-game.html
    symbol: renderer.info.render.drawCalls
    role: the renderer-wide counter that includes the passes the forest counter omits
measured:
  internal_default: 84 visible main-pass meshes
  estimated_shadow_default: up to 36 additional submissions at 12 populated variants
verified_by: source review; requires a browser renderer capture for the actual count
mutation_tested: false
```

### Cause

`submittedDraws` increments once for every forest mesh left visible by `syncRenderParts`. It does not
model render passes. At the default shadow reach, each populated variant also submits LOD0 bark,
LOD0 shadow-casting leaves, and LOD1 bark to the directional shadow pass. `frustumCulled = false`
means Three cannot reject the mesh object before reading its indirect count.

### Effect

The audit compared 84 against the page's renderer-wide 225-draw baseline even though the two values
have different definitions. The forest can contribute up to approximately 120 submissions at
defaults before any future reflection or auxiliary pass. This also made `F-24` appear to save no
draws when it actually removed up to 12 shadow submissions.

### Solution

Rename the current metric to `mainMeshSubmissions`. Add `shadowMeshSubmissions` from the same
visibility/cast-shadow state, and validate both against the delta in
`renderer.info.render.drawCalls` with trees off/on. Report zero-instance submissions separately once
per-rung survivor visibility is observable. Never compare the internal count with a renderer-wide
baseline without labeling the difference in scope.

### Result

Partially implemented on 2026-08-29. The runtime panel and benchmark now label the old counter as
main mesh submissions and report a separate shadow mesh-submission estimate from visibility plus
`castShadow`. The focused test pins 7 main + 3 default shadow meshes per populated variant and follows
the widened shadow reach to 4. Browser validation against `renderer.info.render.drawCalls` is still
required, so the finding remains open.

## F-26 - Base Game builds and compiles a billboard rung it can never draw

```yaml
id: F-26
title: Base Game builds and compiles a billboard rung it can never draw
severity: medium
status: fixed
kind: defect
introduced_by: this-work
runs: once
locations:
  - file: base-game-forest.js
    symbol: syncRenderState
    role: permanently disables LOD3 and billboards and clamps the draw radius to LOD2
  - file: base-game-forest.js
    symbol: buildAsync
    role: forces every mesh visible during compileAsync, including unreachable billboards
  - file: forest-gpu.js
    symbol: LODS
    role: allocates four draw regions and finalizes the fourth for every variant
  - file: forest-gpu.js
    symbol: variantBillboardGeo
    role: creates one unreachable billboard mesh and material per variant
measured:
  default_dead_objects: 12 meshes and 12 materials
  default_dead_draw_storage: 393216 bytes
verified_by: test-base-game-forest.mjs - Base Game constructs three rungs, seven meshes per variant, and no billboards
mutation_tested: true
```

### Cause

The donor renderer always constructs four LOD regions. Base Game sets the fourth rung and billboard
part false and clamps `maxDrawRadius <= lodR2`, so no instance can enter LOD3. The warmup then forces
all 96 meshes visible and compiles the twelve unreachable billboard materials anyway.

### Effect

Base Game pays generation, geometry, material, indirect-buffer, draw-buffer, finalizer, disposal, and
pipeline-warmup costs for a feature its v1 contract forbids. One quarter of the 1.57 MB draw storage
is the unreachable fourth region. This is primarily enable/rebuild waste, plus a small recull cost.

### Solution

Add an explicit renderer option such as `lodCount: 3` or `billboards: false` that omits the LOD3
buffers, nodes, materials, geometry, indirect command, and finalizer writes at construction. Preserve
the current four-rung default for `environment-viewer.html`.

### Result

Fixed on 2026-08-29. `createForestGPU({ billboards: false })` now uses three survivor regions, seven
indirect buffers and seven meshes per variant, while the donor default remains four rungs. With the
two-variant default the headless benchmark reports 42 meshes and 12.32 MB uploaded geometry instead
of 96 meshes and 24.66 MB. Real GPU pipeline and memory deltas remain part of P0.

## F-27 - A recull encodes 2 + 2xvariants compute dispatches

```yaml
id: F-27
title: A recull encodes 2 + 2xvariants compute dispatches
severity: high
status: open
kind: defect
introduced_by: donor
runs: per-frame
locations:
  - file: forest-gpu.js
    symbol: reset
    role: one dispatch
  - file: forest-gpu.js
    symbol: cull
    role: one dispatch
  - file: forest-gpu.js
    symbol: finalizersA
    role: one finalizer node and dispatch per variant
  - file: forest-gpu.js
    symbol: finalizersB
    role: a second finalizer node and dispatch per variant
  - file: forest-gpu.js
    symbol: update
    role: sends reset, cull, and every finalizer through one compute submission
measured:
  prior_default: 1 reset + 1 cull + 12 finalizersA + 12 finalizersB = 26 dispatches
  current_default: 1 reset + 1 cull + 6 finalizersA + 6 finalizersB = 14 dispatches
verified_by: source review; GPU duration and first-use compile duration unmeasured
mutation_tested: false
```

### Cause

Every variant owns eight separate indirect buffers. Binding limits caused finalization to be split
into two one-thread compute nodes per variant. Combining them into one `computeAsync([...])` call
removes repeated queue submissions, but it does not remove the 26 dispatches or their distinct
compute pipelines.

### Effect

~~The first built-frame recull can synchronously create missing compute pipelines after the normal
render warmup has completed.~~ Base Game now warms one compute node per yielded task before adding
the forest to the scene. While moving, each threshold-triggered recull still encodes 2 + 2xvariants
dispatches: 14 at the current six-variant default. The audit attributed first-use spikes to render
materials without measuring this path.

### Solution

First instrument compute pipeline creation and recull GPU duration. Then consolidate indirect
arguments into fewer storage resources and finalize all variants with one or two kernels instead of
24. Derive variant/rung addressing from instance or indirect data so materials and finalizers do not
compile variant offsets into separate graphs. Until that refactor lands, stage any unavoidable
first-use compute compilation behind the loading state rather than the first visible update.

### Result

Partially implemented. First-use compute creation is staged and the provisional variant default cuts
the chain from 26 to 14, but the per-variant finalizer architecture is unchanged. This remains a
candidate for movement overhead, not a confirmed cause.

## F-28 - Streaming mutations rescan and re-upload the full source capacity

```yaml
id: F-28
title: Streaming mutations rescan and re-upload the full source capacity
severity: high
status: open
kind: defect
introduced_by: donor
runs: per-rebuild
locations:
  - file: forest-gpu.js
    symbol: setChunk
    role: marks the whole source buffer for rebuild after any chunk mutation
  - file: forest-gpu.js
    symbol: rebuild
    role: rescans all resident records and marks the fixed-capacity source attribute for upload
  - file: forest-gpu.js
    symbol: cull
    role: dispatch size is variants times capacity rather than live or high-water slots
measured:
  default_source_upload: 393216 bytes at 12 variants x 1024 capacity x 8 floats
  default_cull_dispatch: 12288 threads regardless of 271 default resident records
  wide_cpu_only: 0.18 ms full rescan; GPU upload and dispatch time unmeasured
verified_by: source review and bench-base-game-forest.mjs CPU figures
mutation_tested: false
```

### Cause

Chunk additions and removals are debounced to one `rebuild()` per frame, but each rebuild starts from
all resident chunk records, repacks every variant, marks the entire fixed-capacity storage attribute
dirty, and reculls `V * CAP` slots. During initial fill or movement, chunk streaming can cause this
path on consecutive frames.

### Effect

The CPU rescan is small in the headless benchmark, but that benchmark stubs the renderer and sees
neither the full storage-buffer upload nor GPU dispatch. Raising `capPerVariant` scales both costs
even when the world contains few trees. This is a plausible source of walking spikes that `F-01`'s
idle measurement cannot reveal.

### Solution

Measure source uploads and recull duration during chunk entry/exit. Maintain stable per-chunk or
per-variant slot ranges, update only dirty byte ranges, and dispatch to a live high-water mark rather
than total capacity. If incremental compaction is too invasive, batch several placement mutations
before one upload and give streaming a time/byte budget so wide-radius fill cannot rebuild every
frame indefinitely.

### Result

Not fixed and not GPU-measured.

# Solution plan

The plan is ordered by the probability of explaining user-visible lag and by how much uncertainty a
step removes. Do not spend optimization time on `F-05`, `F-06`, or `F-09` before this sequence.

Implementation progress as of 2026-08-29:

- [x] Yield family-interleaved palette generation, publish complete cross-family waves progressively, and abort stale builds (`F-08`, GPU validation open).
- [x] Replace the count-only random species index with an explicit stable-ID Aspen/Oak/Pine/Ash/Bush/Trellis multi-selection shared by placement and palette baking.
- [x] Remove Base Game's unreachable billboard rung (`F-26`).
- [x] Surface render compile failures and keep failed meshes out of the scene (`F-22`).
- [x] Stage compute first-use pipelines before scene insertion (`F-22`, `F-27`).
- [x] Set the provisional default to two variants and halve main mesh/material partitions (`F-23`).
- [x] Separate main and shadow mesh-submission telemetry (`F-25`, renderer validation open).
- [ ] Run the P0 browser/GPU capture matrix; no browser acceptance gate is claimed yet.
- [ ] Warm or otherwise eliminate first-use shadow-map pipelines.
- [x] Decimate branch geometry for LOD1/LOD2 without perturbing the full skeleton or leaf placement (`F-21`, visual/GPU validation open).
- [ ] Collapse the per-variant finalizer/render-object architecture.

## P0 - Establish a real GPU baseline

1. Capture first-enable, 20 seconds standing, and 20 seconds walking for defaults, dense, and wide.
2. For each capture record frame median/p95/p99/max, total GPU frame time, `passForestMs`,
   `gpuForestMs`, `renderer.info.render.drawCalls`, triangles, reculls, source uploads, and pipeline
   creation events. Label compute/update time separately from main/shadow raster time.
3. Sweep Species `1/3`, Variants `1/2/4`, shadows `off/on`, and LOD0/1/2 alone and combined.
4. Acceptance gate: no causal finding moves to `fixed` without a before/after browser capture on the
   same camera path. Node benchmarks remain regression checks, not GPU evidence.

## P1 - Remove first-enable and first-movement stalls

1. Fix `F-08`: bake one variant per yielded task/frame or in a worker; target no enable-frame task
   above 16 ms, including cold load.
2. Fix `F-26`: construct only three rungs for Base Game and do not compile unreachable billboards.
3. Complete `F-22`: surface compile errors, verify normal pipelines on a real backend, and stage
   shadow and compute pipeline warmup behind the loading state.
4. Fix `F-27` structurally where possible before warming 24 finalizer pipelines that should not
   exist. Acceptance gate: enabling trees and the first movement recull produce no frame above the
   agreed p99 budget and no new pipeline-creation event after the forest becomes visible.

## P2 - Cut sustained submissions immediately

1. Set `treeVariantsPerSpecies` to 2 provisionally. Keep 4 as an explicit high-variety option.
2. Fix `F-25` so the panel reports main and shadow submissions with comparable definitions.
3. Use the rung and shadow sweep to choose cheaper default distances; do not move rings based on
   triangle names alone.
4. Acceptance gate: default trees add a measured, explicit GPU-frame budget and the panel's forest
   submission delta agrees with `renderer.info` within documented pass scope.

## P3 - Make the LODs real

1. Fix `F-21`: bake separate branch geometry for LOD1 and a strongly decimated branch geometry for
   LOD2. Price leaf geometry at the same time; LOD1 currently remains leaf-heavy.
2. Establish per-rung triangle and silhouette targets from the visual rubric, then test transition
   stability and shadows while walking.
3. Acceptance gate: triangle counts fall materially at every rung, the wide capture no longer sits
   near 2.8M main-pass triangles, and the visual rubric passes at the chosen ring distances.

## P4 - Collapse the variant/rung architecture

1. Fix `F-23` and `F-27` together: stop baking variant offsets into unique material graphs, share
   pipelines across variants, consolidate indirect arguments, and reduce finalization to one or two
   dispatches.
2. Prefer fewer render objects over per-frame GPU-to-CPU survivor readback. If delayed readback is
   retained for telemetry or empty-rung gating, prove that its latency never hides a newly populated
   rung.
3. Acceptance gate: draw and pipeline counts scale with visible parts rather than `variants x rungs`,
   and default recull dispatches fall from 26 to the documented target.

## P5 - Make streaming incremental

1. Fix `F-28`: add dirty-range source uploads, live/high-water dispatch bounds, and a byte/time budget
   for chunk installation.
2. Capture continuous travel across chunk boundaries at default and 600 m radius.
3. Acceptance gate: no repeated full-capacity uploads during steady travel, and walking p99 remains
   within budget while chunks enter and leave residency.
