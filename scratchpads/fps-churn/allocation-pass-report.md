# Same-content allocation pass — 2026-09-09

Scope: our code only. Nothing in three-mesh-bvh, Three, `forest-gpu.js`, `base-game-forest.js`, and
nothing visual, was touched. No commit.

Snapshots taken before editing (all `20260909-223107`):

- `versions/road-index-before-allocation-pass-20260909-223107.js`
- `versions/base-game-terrain-before-allocation-pass-20260909-223107.js`
- `versions/flora-field-before-allocation-pass-20260909-223107.js`
- `versions/terrain-splat-streamed-before-allocation-pass-20260909-223107.js`

---

## 1. `road-index.js` — `nearestDistanceWithin`

**What changed.** The per-segment loop no longer calls `distancePointToSegmentXZ`. The segment
arithmetic is inlined verbatim, the loop is argmin by **squared** distance keeping the winner's `dx`
and `dz` in locals, and `Math.hypot` is called **once**, on the winner, after every cell has been
walked. The cell-key walk, the node bucket walk and the run bucket walk are indexed `for` loops
instead of `for...of`, so no array iterators are created per query. The node distances keep their own
`Math.hypot` and their `radius + 1e-6` gate exactly as they were. The now-unused
`distancePointToSegmentXZ` import was dropped; `road-path.js` itself is unchanged.

**Why the value is the same.**

- The returned number is a `Math.hypot` of the same two operands the old per-segment call produced
  for the winning segment — the inlined expression is character-for-character the same arithmetic in
  the same order, including `t`'s `1e-6` degenerate guard and the `[0, 1]` clamp.
- `hypot` is monotone in `dx² + dz²`, so the segment that minimises the squared distance is the one
  that minimised the hypot.
- The final `best` is a minimum over the same set of candidate values. Minimum is order-independent,
  so folding segments in at the end rather than interleaved with nodes gives the same result, and on
  an exact tie either winner produces the same number.
- Finite-radius semantics are untouched: run bounds rejection, the node radius gate and the
  unbounded ring-growing loop all still work on the same `best`.

**Parity proof.** `test-roads.mjs` gained a block that rebuilds the **previous** implementation
verbatim (its own cell grid, its own run indexing, per-segment `distancePointToSegmentXZ` folded
straight into `best`, per-call `Set`s) over the same 14-road network, and compares with `===`:

- 4000 random points at random radii 2–60 m: 0 mismatches, 1400+ of them finite.
- 400 random points through the unbounded ring-growing path: 0 mismatches.

`node test-roads.mjs` exits 0.

---

## 2. `base-game-terrain.js` — `killPlaneYAt`

**What changed.** `killPlaneYAt(x, z)` now goes through `killPlaneY`, which caches one answer. It
recomputes only when any of these differ from the cached entry:

- `system.source` (object identity),
- `system.epoch` (bumped by `setSource` and by `rebuild`, i.e. every param/source generation),
- `volumetricMode`,
- or the query moved more than `KILL_PLANE_CACHE_M` = 0.5 m in |Δx| or |Δz|.

`killPlaneYAtExact(x, z)` was added as the uncached form; it is the old body, unchanged, and exists
only so a test can compare against it.

**Why the invalidation is airtight.** The value is `groundHeight(x, z) - cfg.killPlaneBelowSurface`,
optionally `min`'d with `volumeFloorY() - 10`. `groundHeight` is either `system.source.surfaceYAt`
(volumetric) or `system.getHeight`, which is `this.source.heightAt(x, z)` — both pure functions of
the source, with **no dependency on which chunks have streamed**. `volumeFloorY` reads
`system.source.project.density.y_min`, again a property of the source. `setSource` installs a new
source object *and* bumps the epoch, so the identity check and the epoch check each catch it on
their own. `cfg.killPlaneBelowSurface` is frozen at construction. Sea level does not enter the
computation.

**Why 0.5 m of horizontal staleness is safe.** The kill plane is a safety net 80 m
(`killPlaneBelowSurface`) below the local ground; the test it feeds is
`playerY < killPlaneY`. For the cached answer to change the outcome, the ground would have to move
by more than the player's distance below the plane within half a metre of travel — i.e. the player
would have to be already ~80 m below the surface. The one real case is crossing a cliff edge: for at
most half a metre of travel the plane is the old column's, and the recompute at 0.5 m catches it.
Measured in the test on the analytic source, the staleness inside the cache radius was 0.018 m.

**Parity proof.** New block in `test-base-game-terrain.mjs`:

- a first query equals `killPlaneYAtExact` at the same point;
- a 0.36 m move returns the cached number, and the exact answer there differs by 0.018 m — far
  under the 80 m margin;
- a move past the radius equals `killPlaneYAtExact` at the new point, and is then itself cached;
- `setSource(descB)` at the same XZ returns the new exact value (−78.063 → −75.740), so the swap
  invalidates.

---

## 3. `base-game-terrain.js` — `syncBatchVisibility`, `batchTargets`, residency

**What changed.**

- `syncBatchVisibility` no longer does `for (const key of [...batched.keys()])`. It walks
  `batched.keys()` directly, pushes only the keys it will actually remove into one module-level
  reused array, then deletes from that array. Collect-then-delete is kept because a Map must not be
  mutated while it is being iterated. Previously this built a fresh array of **every** batched key,
  on every batcher, every frame.
- `batchTargets()` fills one reused array of reused per-streamer records instead of allocating an
  array plus one object literal per streamer. It is called two or three times per frame
  (`applyMaterialsPass` runs twice in `update`, plus once inside `integrate`).

**Why reuse is safe here.** Every caller was checked. `applyMaterialsPass` iterates the list and
drops it; `applyMaterials` calls `applyMaterialsPass`, then iterates a fresh `batchTargets()` while
calling `foldOne` (which never asks for the list again), then calls `applyMaterialsPass` after the
loop has finished; `integrate` holds the list across its scheduling loop, and none of the operations
it runs (`commitAndTint`, `foldOne`, `buildCollider`) calls `batchTargets`. No caller stores the
array or an entry beyond its own scope, and no call nests inside an iteration of another. If a new
caller ever does either, this reuse has to be revisited — that constraint is written into
`docs/subsystems/terrain.md`.

**What was deliberately NOT changed.** `residencyOf` still returns a fresh object per call.
`stats.residency` records are copied and retained by the performance capture and the panel, and
`stats.residency.levels` builds one per cascade level; aliasing them across reads would be a real
behaviour change for a getter that is not on the hot per-frame path (`stats` is explicitly the
expensive one; `frameCost` is the per-frame one, and it already reuses its object). The
`for (const [key, chunk] of sys.chunks)` entry iteration in `syncBatchVisibility` also stayed: it
allocates a pair per resident chunk per frame in principle, but removing it means either a `forEach`
closure per call or restructuring the loop, and neither is a same-content change I could prove as
cheaply. It remains open.

**Parity proof.** `test-base-game-terrain.mjs` and `test-terrain-chunk-batches.mjs` both stay green,
including the existing assertions that the batch tracks residency exactly across 900 m of travel and
across a source swap with no double-draws. Added: two consecutive `stats.residency.near` reads report
identical numbers for all six fields and are still distinct objects; and after a 300-frame walk the
batch chunk count still equals the resident chunk count.

---

## 4. `flora-field.js` — `derive`, `coverAt`, and `terrain-splat-streamed.js` `splatWeights`

**What changed.**

- `splatWeights(height, normalY, cfg, out?)` — a new optional 5-element array to write into. Without
  it the function allocates a fresh array exactly as before.
- `coverAt(biome, moisture, weights, { …, out })` — a new optional `{ grass, plant, tree }` to write
  into. Without it, a fresh object as before. Its two per-call closures (`write` was never
  introduced in the shipped form; the pre-existing `moistureFactor`) are gone — `1 - strength *
  (1 - wet)` is now `1 - strength * dry` with `dry = 1 - wet` hoisted, which is the same expression
  with the common subexpression computed once.
- `createTileCover(...).derive` passes one reused weights array, one reused cover object and one
  reused options record. That removes three heap objects per texel; a 16k-texel tile arrives every
  few frames while walking.

**Byte-identical proof.** Two independent checks, both run against
`versions/flora-field-before-allocation-pass-20260909-223107.js` (imported alongside the new file):

1. Element-wise: 12 tiles of varying size, step, sea level, origin and a non-trivial clearance
   function, over random heights/moisture/biomes — **37,056 channel values compared, 0 mismatches**.
2. Checksum on a fixed-seed 64×64 tile (sea level 3, a modulo clearance function, origin
   (−128, 64)): FNV-1a over all three u8 channels = **2676199228** from the pre-change file and
   **2676199228** from the new one.

That checksum is now pinned in `test-flora-field.mjs` with a comment saying it was derived from the
pre-change file and must be re-derived from the rule, not from the code's output, if the cover rule
ever deliberately changes. The test also asserts that the `out` and no-`out` paths give the same
numbers over 400 random points, and that `splatWeights` still returns distinct arrays with no `out`.

---

## 5. `vegetation-debug-hud.js` — skipped

`refresh()` contains no `Object.fromEntries`. The one the profile attributes here is in
`base-game.html`'s `sample()` closure (`configuration: JSON.stringify([Object.fromEntries(...)])`),
which is called from `updateStats` **only on the 500 ms HUD tick and only while the HUD is visible**
— not per frame. Reusing that object would also alias the `structuredClone` the Pin button takes.
Not trivial, not per-frame, and not risk-free: skipped, as the brief allowed.

---

## Tests run (all exit 0)

`test-roads`, `test-base-game-trails`, `test-base-game-terrain`, `test-terrain-chunk-batches`,
`test-flora-field`, `test-base-game-flora`, `test-base-game-trees`, `test-terrain-field-window`,
plus `test-terrain-splat-streamed` (because `splatWeights` changed signature) and
`test-page-syntax`.

## What remains unmeasured

- **The GC effect in the browser is not measurable headless.** Nothing here was profiled in Chrome
  after the change. Whether the 68–114 ms major GCs shrink, or merely move, has to be re-measured
  with an allocation-sampling profile taken the same way as
  `research/stats/"running w treesHeap-20260909T222105.heapprofile"`.
- **The two largest items in the profile were out of scope.** `map-collision.js`
  `intersectsTriangle` + `resolveCapsule` at 14–18% is mostly three-mesh-bvh's own shapecast math;
  `forest-gpu.js` belongs to another agent.
- **Boxed doubles are inferred, not observed.** The claim that inlining the segment loop stops
  per-segment heap numbers is a reading of the profile's attribution, not something a Node test can
  see. What the tests prove is that the *values* did not change; they say nothing about how many
  bytes were saved.
- The `for (const [key, chunk] of sys.chunks)` entry-pair allocation in `syncBatchVisibility` (see
  item 3) is still there.
- `integrate`'s `pickOther` builds a `stages` array plus one record per candidate stage, per
  scheduled item. It is per-item, not per-texel, so it was left alone.
