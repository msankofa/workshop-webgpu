# Draw submission and scene organization — architecture review

Scope: how base-game.html and its vegetation/terrain/body/water modules organize and submit
draws under three.webgpu.js r184. Code-read only; I did not run the browser. Where I ran
something, it is a `node -e` grep/read of the shipped build, not the app.

## 1. Whole scene graph is walked and pushed into a render list every `renderer.render()` call, per camera

`_projectObject` (`node_modules/three/build/three.webgpu.js:60817-60940`) recurses into every
child of `scene` unconditionally (only gated by `object.visible`, `layers.test`, then per-mesh
frustum test). This runs once per `renderer.render(scene, camera)` call. `BundleGroup`
(`object.isBundleGroup`, line 60913) does not skip this recursion — it just swaps in a private
render list and, on replay, reuses the recorded GPU commands instead of re-encoding them; the
JS-side walk and `renderList.push()` still happen every frame. This matches
`docs/render-submission-gpu-driven-plan.md`'s claim; I re-derived it independently from the
build rather than trusting the doc.

- Classification: reproduced (read the exact code path), not measured live.
- Consequence: `base-game.html:6990`'s single `renderer.render(scene, camera)` call triggers this
  walk, but water's reflection (`water.js:657` `renderReflection = reflectorBase.updateBefore`,
  called from `renderReflectionPruned` at `water.js:684-700`, itself invoked from the TSL node's
  `updateBefore` during the main render) issues a **second, independent**
  `renderer.render(scene, virtualCamera)` over the same scene graph, and the shadow pass is a
  third traversal (`base-game.html:6979` gates `shadowRedrew` on `renderer.shadowMap.enabled`).
  So per real frame there can be up to 3 full graph traversals + render-list builds, not 1. This
  is consistent with the plan's evidence table showing `passPostMs` covering "main, mirror,
  shadow and post passes" and the trace review's finding that `_updateBindings` alone
  sample-weighs 17.37s of the 46.2s render-path total — that cost multiplies per pass.
  Reflection is throttled (`reflectEvery`, water.js) and excludes some objects
  (`collectReflectExcludes`/`reflectExcludeScratch`), so its per-frame cost is lower than main on
  average, but on a re-render frame it is a full second traversal, not a cheap one.
- Overlap: this is the same mechanism the plan's step 0/D/R already targets. I am not proposing a
  new fix, just confirming the mechanism against the local build and flagging the mirror pass as
  an under-counted multiplier the plan's Evidence table does not break out separately.
- Priority/scope: no new change proposed here — this is corroborating evidence for the plan's
  own step 0 instrumentation, which should add a per-pass traversal count (main vs mirror vs
  shadow) rather than only object/draw census, since the mirror pass reruns the walk on a
  possibly-different visible set (`reflectExclude`).

## 2. Real indirect draws exist and are already used correctly by forest/grass; terrain/body are not indirect and don't need to be

Grepped `three.webgpu.js` for indirect support (r184, this build):
- `IndirectStorageBufferAttribute` is a real type (`three.webgpu.js:17546-17553`,
  `isIndirectStorageBufferAttribute`), and `RenderObject.getIndirect()` /
  `Geometries.getIndirect()` (lines 29835-29841, 31073) resolve a mesh's indirect buffer.
- The WebGPU backend issues genuine `passEncoderGPU.drawIndexedIndirect(buffer, offset)` /
  `drawIndirect(buffer, offset)` (lines 81485-81521) when a `RenderObject` has an indirect
  attribute — this is real GPU-side indirect draw, not an emulation.
- Separately, `WebGLBackend` (this repo is WebGPU-first but the build ships both backends) has
  `multiDrawElementsWEBGL`/`multiDrawArraysWEBGL` (lines 68719-68723) — a *different*,
  WebGL-only multi-draw path used by `BatchedMesh` there. **On the WebGPU backend there is no
  multi-draw entry point** — `terrain-chunk-batches.js`'s own header comment (lines 1-8) says
  this explicitly and correctly: `WebGPUBackend._draw` issues one `drawIndexed` per visible
  geometry in a JS loop, so `BatchedMesh` on WebGPU buys one scene object (one `RenderObject`,
  one pipeline/bind-group set, one matrix upload) but not fewer draw calls.

So: `forest-gpu.js` and `grass-compute.js` already do the thing the plan's step A proposes in
spirit — a compute cull writes counts into an `IndirectStorageBufferAttribute` and a fixed small
set of meshes (`CAP`-sized geometry, `instanceCount = CAP`, `geom.indirect = indirectAttrs[...]`)
draws only live instances via real `drawIndexedIndirect`. Grass is 1-3 meshes total (tier 0 mesh
plus up to 2 child tier meshes, `grass-compute.js:836-852`); the indirect count, not JS, decides
how many blades draw. Forest is NOT collapsed the same way: it keeps one mesh per
(variant × LOD-role) — up to 8 meshes per variant (`forest-gpu.js:686-716`: branchesL0, leavesL0,
shadowL0, branchesL1, leavesL1, branchesL2, coarseLeavesL2, billboard, plus 2 more if
`SHADOW_LIST`) — each with its own indirect draw, because materials/geometry differ per role and
(for billboards) per variant. This is the real reason forest draw count is high (documented in
the plan's census: "forest 130 to 140 (16 variants x 7 main + 2 shadow)"), not a missing
indirect mechanism — the indirect mechanism is already there per-mesh; what's missing is
cross-variant/cross-role merging, which the plan's step A (arena + prefix-sum liveCount) targets
correctly in mechanism. I did not find anything in this build that would let a single indirect
draw span multiple materials or multiple non-contiguous vertex ranges without exactly the
arena-plus-remap scheme the plan describes (map `vertexIndex` through a prefix-range table into
the right variant's arena slice) — there is no "multi-draw-indirect" (indirect *count* buffer
driving N logical draws from one JS call) primitive in this backend, so each merged role in the
plan's design still needs its own single indirect draw call, i.e. the target is "one draw per
role" not "one draw total," consistent with the plan's own wording ("The target is one mesh per
role per pass").

- Classification: reproduced (grep + read against the shipped build) for the indirect
  capability; measured redundancy for forest's per-role mesh count via the plan's own census
  (I did not re-run the census myself, no browser).
- Terrain (`terrain-chunk-batches.js`) and body (`body-part-batches.js`) do NOT use indirect —
  terrain is `BatchedMesh` with `perObjectFrustumCulled: false` and `frustumCulled = false` on
  the batch (lines 51-53, comment explains the tradeoff explicitly: submit every resident chunk,
  skip a per-instance CPU culling loop, since WebGPU draws one `drawIndexed` per chunk either
  way). Body is `InstancedMesh` per geometry bucket (`body-part-batches.js:97-107`), which is a
  normal (non-indirect) instanced draw with a JS-set `mesh.count`; CPU sets the count once per
  `endFrame()`, which is cheap and correct for a bucket size that changes at most once per frame
  (bots don't spawn/despawn every frame). Converting these to indirect would trade a cheap CPU
  `mesh.count = n` write for a compute-visibility pass and a storage-buffer instance pull, which
  only pays off if per-instance GPU-side culling (not currently done for terrain chunks or
  bodies) is also wanted. Neither module claims to want that. I don't recommend touching these
  under this plan; they are already at the right complexity for their instance counts (terrain:
  tens of chunks; bodies: dozens of bots).
- Priority/scope for step A: bounded experiment, as the plan already frames it. My check adds:
  before building the arena, benchmark whether `passEncoderGPU.drawIndexedIndirect` call
  overhead in this backend is itself a meaningful fraction of the ~130-object forest submission
  cost, versus the CPU-side `_projectObject`/`renderList.push`/binding-update cost that happens
  per mesh regardless of whether the draw is indirect. If most of the 0.56s
  `forest-gpu.js`-attributed sample time (trace review) is in per-object JS overhead rather than
  in the draw call itself, merging meshes (fewer `RenderObject`s to bind) is the win, and the
  indirect mechanism is already present — the arena's value is almost entirely in mesh count
  reduction, not in "unlocking" indirect drawing that forest already has.

## 3. `frustumCulled = false` is used pervasively as a deliberate opt-out, and each instance carries a rationale — but there's no per-instance GPU cull for terrain or bodies

Grep of `frustumCulled` across the reviewed files:
- `forest-gpu.js:367,508` — per-mesh false; correct, since visibility is GPU-cull-driven
  (compute pass into `countsArray`/indirect), a CPU frustum test on the container mesh's
  (degenerate, since `CAP`-sized) bounds would be meaningless.
- `grass-compute.js:836,848` — same reasoning, correct.
- `terrain-chunk-batches.js:51` — comment: "whole-batch bounds never maintained." This is an
  honest admission that the `BatchedMesh`'s aggregate bounding volume is not kept in sync with
  its live chunk set, so CPU frustum culling against it would be wrong (too large, covering
  unloaded slots) rather than merely absent. `perObjectFrustumCulled: false` by default disables
  Three's own per-instance-within-batch cull too (comment lines 20-23), meaning **every resident
  chunk in the batch submits a `drawIndexed` even when off-screen**, relying entirely on the
  streaming radius to bound the resident set, not on frustum visibility.
- `body-part-batches.js:101` — comment: "instances span the whole map" — same reasoning as
  terrain, correct given `InstancedMesh` doesn't do per-instance frustum culling on this backend
  either way.

Classification: measured redundancy (terrain chunks outside the frustum still draw), directly
supported by the code comment, not something I benchmarked. Whether this matters depends on
resident chunk count vs visible chunk count, which I cannot measure without the browser.

Proposed replacement (bounded experiment, not required by the current plan): if the streaming
radius is set generously (loads chunks well beyond the far clip or behind the camera), a coarse
CPU AABB-vs-frustum test per chunk record before it's added to the batch (i.e. gate residency,
not draw submission) would avoid uploading/drawing chunks that can never be seen this frame,
without touching the "one drawIndexed per chunk on WebGPU regardless" constraint. This is
cheaper to reason about than turning on `perObjectFrustumCulled` (`cfg.perObjectFrustumCulled`
already exists as an off-by-default knob at `terrain-chunk-batches.js:22-23` — flipping it on is
the more direct bounded experiment, already wired, unexercised). I'd try the existing flag first;
it's a one-line config change with an existing off-path, versus writing new gating logic.
Tradeoff: `optimize()`-driven compaction assumes stable indices; per-object culling adds a
CPU loop over resident chunks every frame (the exact cost the comment says was avoided). Whether
that CPU loop is cheaper than drawing off-screen chunks needs measurement with
`?trace=1`+`postShadow`/`postNoShadow`-style before/after draw counts, which I did not run.

- Overlap: this is terrain-owned (Hi-Z / terrain-clipmap-window sessions may already cover
  visibility), flagging only because it's inside `terrain-chunk-batches.js` which this area
  audits for draw submission; do not double-implement if a terrain-side culling pass already
  exists upstream of batch admission (I did not check `terrain-clipmap-window.js` for this).

## 4. Render-list sort is Three's default painter's-algorithm sort, unmodified

`RenderList.sort()` (`three.webgpu.js:33064-33068`) uses `painterSortStable`/
`reversePainterSortStable` unless the renderer is given `_opaqueSort`/`_transparentSort`
overrides (`_projectObject`'s caller passes `this._opaqueSort`/`this._transparentSort` at
`three.webgpu.js:59418`). I found no code in `base-game.html` or the reviewed modules setting
`renderer._opaqueSort`/`renderer.sortObjects` beyond the per-object `mesh.sortObjects = false` on
the terrain batch (`terrain-chunk-batches.js:53`) and the implicit `frustumCulled=false` +
`instanceCount` pinning on forest/grass meshes discussed above. So opaque objects sort
front-to-back by default (reduces overdraw, standard Three behavior) at `renderList.opaque.sort`
cost proportional to visible opaque count (~200-300 objects per the census) — this is a small,
expected cost, not a defect. I flag it only because the plan doesn't mention sort cost at all;
it's a minor, likely-negligible line item that step 0's instrumentation should still separate
from projection/binding cost if it wants a complete CPU breakdown, since `RenderList.sort` is a
distinct call from `_projectObject`.

- Classification: untested hypothesis (plausible but small; I have no measurement isolating sort
  cost from projection cost in this codebase).
- Priority: not worth a dedicated experiment; mention only for completeness of step 0's
  instrumentation if it aims to be exhaustive.

## 5. Evaluation of the plan's proposed steps, given the above

- **Step D (matrix-walk)**: already run per the task context (`render-matrix-walk.js`,
  `?matrixauto=0`), measured 0.1-0.4ms, no material gain. Consistent with what I'd expect from
  reading `_projectObject`: it doesn't touch matrix update at all (that's a separate pass before
  projection per the plan's own citation of `Renderer.js` line ~1489), so removing matrix-update
  cost can't touch the projection/binding cost that `_updateBindings` (17.37s sampled,
  trace-review) dominates. Do not repeat.
- **Step R (BundleGroup)**: already run (`?bundles=1`), and the plan's own text plus my read of
  `three.webgpu.js:60913-60930` agree bundles cache *command recording*, not traversal — the
  forest afterimage bug (replay refreshes only the first object) is consistent with a bundle
  replaying stale per-mesh bind groups/uniforms for meshes after the first when their underlying
  buffer contents changed but the bundle wasn't invalidated. I did not find, in this build,
  automatic invalidation tied to storage-buffer *content* writes (only structural changes like
  visibility/material swap would plausibly invalidate a recorded bundle — I did not exhaustively
  trace the invalidation predicate, so this is inferred, not verified against the exact
  invalidation code). This matches the plan's own diagnosis. Do not repeat under a new name;
  if revisited, the fix would be either (a) exclude buffer-only-changing meshes from the bundle,
  keeping bundles only for truly static structures, or (b) find and use an explicit
  bundle-invalidate-on-buffer-write hook if one exists in this build (I did not locate one in the
  grep above; would need a dedicated search of the `Bundle`/`beginBundle` implementation before
  trying this again).
- **Step A (forest compact pulling)**: mechanism is sound per §2 above — the backend supports
  real indirect draws and forest already uses per-mesh indirect; the extension to a shared arena
  with a prefix-sum remap is the correct next move to cut mesh count without cutting live
  instances. Main risk not fully covered by the plan text: the vertex-index remap through a
  prefix-range table is itself extra per-vertex ALU work (a binary search or a small linear scan
  over role/variant boundaries) done for every drawn vertex, which could partly offset the CPU
  savings with a small GPU cost — worth measuring, not assumed away. Correctness check: render
  the same seeded forest window in `pulled` vs `variants` mode and diff a screenshot/pixel count
  per variant (the plan doesn't specify an automated diff; I'd add one using existing
  `render-trace.js` per-object counts plus a manual screenshot compare, since there's no
  automated visual diff harness I found in this repo).
- **Step B/C (body/static arenas)**: not reviewed in code depth here since they're marked "only
  if R leaves it necessary" / later steps; my only note is body's current `InstancedMesh`
  bucketing (§2) is already cheap for its scale, so B's benefit is bounded by draw count (54
  buckets per the log) times per-object overhead, smaller than forest's opportunity.

## What I could not verify

- Actual per-frame counts of `_projectObject` recursion depth, `RenderList.sort` cost, or
  binding-update cost broken out by pass (main/mirror/shadow) — no browser run performed; the
  trace-review numbers are sampled/inclusive and explicitly warn against being treated as exact
  per-pass costs.
- Whether `perObjectFrustumCulled: true` on terrain chunks actually saves CPU (untested,
  existing off-by-default flag, no capture with it flipped on).
- Exact `BundleGroup` invalidation predicate (what specifically triggers a re-record vs a
  replay) — I read the projection-time bundle handling but did not trace the backend's
  bundle-cache invalidation logic in full.
- Reflection pass's actual per-frame frequency (`reflectEvery`) and its real traversal/object
  count relative to main, since `reflectExclude` can shrink its scene subset — I read the
  mechanism, not a captured trace of its cost.
- Whether the vertex-index remap in the plan's arena design would show up as a measurable
  vertex-stage cost on this hardware — no GPU timing captured here.
