# Data ownership and update frequency — base-game.html

Read-only review. All line numbers are current as of this session (branch `sp1-webgpu-renderer-migration`).
Three build read directly: `node_modules/three/build/three.webgpu.js` (r0.184.0), matching the CDN import.

## How Three r184 actually schedules per-node updates (ground truth, code-read)

`Nodes.updateBefore(renderObject)` (three.webgpu.js:55023) runs once per `RenderObject`, i.e. once
per draw submission, and iterates `nodeBuilder.updateBeforeNodes`, calling
`NodeFrame.updateBeforeNode(node)` for each (three.webgpu.js:53039). Renderer call sites at
three.webgpu.js:58772, 59027, 61306, 61372 show this runs on every object in the render list, every
frame — there is no persistent frame-level skip for objects that didn't move.

`NodeFrame` dedupes by `NodeUpdateType`:
- `FRAME` and `RENDER` types are memoized in a `WeakMap` keyed by `node.updateReference(this)`
  (three.webgpu.js:53044-53078): the node's `update()`/`updateBefore()` runs once per `frameId` or
  `renderId` no matter how many render objects reference it. This is real, working dedup — `time`,
  `deltaTime`, `frameId`, camera matrices, light uniforms (three.webgpu.js:36541-36557,
  13906-14203, 42829-42916) are all `RENDER`/`FRAME` group and pay their update cost once per
  frame/pass, not per object.
- `OBJECT` type has **no memoization at all** — three.webgpu.js:53080-53084 (`updateBeforeNode`),
  53129 (`updateAfterNode`), 53178 (`updateNode`) call `node.update(this)` unconditionally every
  time they're reached, once per render object. This is correct for genuinely per-object data
  (`modelViewMatrix`, `modelNormalMatrix` — three.webgpu.js:14622-14686) but Three also tags some
  *material-scoped* uniforms this way: `materialEnvIntensity`, `materialRefractionRatio`
  (three.webgpu.js:15157-15184) call `.onReference(({material}) => material)` — but since their
  `updateType` is `OBJECT` not `RENDER`, the reference is never consulted by `updateBeforeNode`'s
  OBJECT branch; the `onReference` binding only matters for uniform-group dedup elsewhere, not for
  skipping the recompute. **Every object drawn with a standard material recomputes
  `envMapIntensity` off `material` and `scene` every single frame**, even when ten objects share one
  material instance and the value never changes between them. Classification: **code-supported
  architectural weakness** (verified by reading the dispatch code, not measured — I have no browser
  profiler access to attribute a ms cost to it). Likely cheap per call (a scalar multiply and a
  fog-density read) but it is one of several per-object node walks that all run inside the same
  55023 loop for ~202 scene objects every frame, and they add up as *count*, not magnitude, which
  matches the "per-object binding/uniform" cost signature the peer's sampling already attributed to
  something in this area.

**Consequence for `base-game.html`:** the ~11-18 ms encode time at ~200 objects is consistent with
Three's own per-object update loop (`updateBefore` → `updateNode` → bind group refresh) running
`updateBeforeNodes.length` times per object, not just with draw-call submission cost. This engine
does not offer a supported way to hoist an OBJECT-type node to RENDER scope from outside — the type
is fixed by whichever built-in node class declares it (`ModelNode`, `MaterialReferenceNode`, etc.).
The only owned levers are (a) fewer distinct render objects (instancing/merging — overlaps with the
"draw submission" review area, not duplicated here beyond flagging it), or (b) fewer *materials*
that carry OBJECT-type uniforms our own TSL adds on top of Three's built-ins.

## What our own TSL code adds per-object vs per-frame

Grepped `onObjectUpdate`, `onFrameUpdate`, `onRenderUpdate`, `NodeUpdateType.OBJECT` across every
`.js` file in the repo (not just base-game.html). Result: **none of our own modules call
`onObjectUpdate` or otherwise declare `NodeUpdateType.OBJECT` on a custom node.** The only project
uses of the update-scope API are `depth-of-field.js:45-46` (`sceneNear`/`sceneFar` via
`onRenderUpdate`, correctly RENDER-scoped — one depth-of-field material, not per-object). This means
our shader authoring is not the source of any OBJECT-type churn; all such churn is inherent to
Three's built-in material/model uniform set applied to ~200 objects. Classification: **measured
(grep-complete) absence of a defect** — ruling this candidate out rather than finding it.

## `animate()` writes into things that don't need a write every frame

File: `base-game.html`.

1. **`syncBundleGroups()` (line 1288-1303), called every frame at line 6980 (`if (BUNDLES)
   syncBundleGroups();`).** Builds a string signature of every forest mesh's visibility
   (`sig += mesh.visible ? '1' : '0'` per mesh, line 1293) and a second signature walking
   `structures.root.children` (lines 1298-1300), every single frame, purely to decide whether to
   set `needsUpdate`. This is O(object count) string-building work done unconditionally to avoid an
   O(object count) bundle rebuild — i.e. the invalidation check itself is priced close to the thing
   it's guarding. `BUNDLES` is off by default (`BUNDLE_FLAG !== null …`, line 1272) per your
   experiment notes (bundle replay is visually broken), so this code does not run in the default
   path today — flagging it so it isn't miscounted as live cost, and so a future bundle rework
   doesn't reintroduce a linear signature scan as the invalidation check. Classification:
   **measured redundancy, but currently dead under default flags** (confirmed by reading the
   `BUNDLES` gate, not by tracing a live capture). Priority: skip — not on the default hot path.

2. **`matrixWalk` (line 6975-6981) is opt-*out*, not opt-in.** `const matrixWalk =
   createMatrixWalk({ enabled: !readFlagDefaultTrue('matrixauto') })` — default `matrixauto=1`
   means `matrixWalk.enabled` is `false` by default, so this custom walk does **not** run by
   default; Three's own `Object3D.updateMatrixWorld` scene walk is what runs. The comment at
   base-game.html:1475 says the custom walk was tried and made things worse (88.8 ms vs 38.8 median
   without it) — this matches "matrix-auto-update suppression, no gain" already in the ledger. Not
   re-litigating it; noting it here only because it's exactly the kind of "per-frame recompute of
   something that mostly doesn't change" question this review area is chartered to look at, and the
   experiment already answered it: Three's native matrix walk, which does its own per-object
   `matrixWorldNeedsUpdate` dirty check, is cheaper than a hand-rolled replacement here. This is
   real evidence *against* hand-written dirty-tracking being an automatic win in this engine —
   worth stating plainly since the brief asks for dirty tracking "where warranted": here it was
   tried and wasn't.

3. **Shadow map update gating exists and is respected.** Line 4002:
   `if (shadowEvery > 1 && (shadowFrame++ % shadowEvery) === 0) rig.dirLight.shadow.needsUpdate =
   true;` and the read-before-render comment at 6977-6980 correctly notes that Three clears
   `needsUpdate` once it draws the map, so the profiler has to sample the flag *before* `render()`
   or it can't distinguish a shadow-redraw frame from a reused one. This is the right pattern for
   Three's `ShadowNode` API (three.webgpu.js:19606 `updateBefore`, RENDER-scoped, confirms shadow
   redraw is already frame-deduped by the engine, not per-light-per-object). No defect found here;
   listing as a working example of correct ownership so it isn't re-investigated by another pass.

4. **No `material.needsUpdate = true` or `new *Material()` calls inside `animate()`.** Grepped the
   whole file for `needsUpdate` and `new THREE.*Material(` — the only material construction sites
   (lines 2832-2844: `rocketMat`, `grenadeMat`, `agm` craft materials) are one-time module-load-time
   allocations or lazily-created-once-then-cached (`buildCraftMesh`, called only when a mesh entry
   is missing, line 2844). No per-frame material rebuild or shader-recompile trigger found in
   `base-game.html`'s own code. Classification: **measured absence** (grep-complete on this file
   only; did not extend the grep to every lazily-imported module — see "could not verify").

## `updateGroup` dedup for our own uniform groups

`NodeBuilderState.updateGroup` (three.webgpu.js:54252-54275) is version-gated: a `uniformGroup`
(e.g. a custom TSL material's shared params) is only re-uploaded when `groupNode.version` changes,
which happens when the group is explicitly marked dirty (`sharedUniformGroup`/`uniformGroup` calls,
three.webgpu.js:5331-5347). I did not find any of our modules constructing a custom `uniformGroup`
and bumping its version every frame regardless of change — the pattern in this codebase is plain
TSL `uniform()` values mutated via `.value = x` from JS, which Three re-uploads on every bind-group
refresh for that binding regardless of whether the JS-side value actually changed (r184's uniform
buffer diffing is per-binding-object identity, not per-value-equality — this is a general WebGPU
node limitation, not something base-game.html did wrong). This is the same class of cost as the
`materialEnvIntensity` finding above: engine-level, not fixable by changing our call sites without
also changing what we own (batching many small uniforms into fewer, larger, coarsely-invalidated
groups would be a real redesign, not a bug fix).

## Proposed changes, prioritized

1. **Safe, no-risk:** none of the findings above point at a live default-path bug worth a direct
   patch — `syncBundleGroups` is gated off, the matrix walk experiment already answered itself, and
   shadow gating is already correct. I am not proposing a patch from this pass.

2. **Bounded experiment (worth someone else's time, not mine to run — no browser access):**
   instrument `NodeFrame.updateBeforeNode`/`updateNode` call counts for one representative frame
   (e.g. monkey-patch or wrap `Nodes.updateBefore` in a dev build) to get an actual OBJECT-vs-FRAME
   call-count ratio at the measured ~202 objects, and to confirm or refute that
   `materialEnvIntensity`/`materialRefractionRatio`/`modelNormalMatrix` recomputation is a
   measurable slice of the 11-18 ms encode, versus being dominated by draw-call submission /
   bind-group creation (a different review area's territory — flagging the overlap so it isn't
   double-counted). Expected benefit if confirmed: none directly — this identifies whether the fix
   belongs in "fewer objects" (draw submission redesign) rather than "less per-object math," since
   the per-object math itself (a 3x3 normal matrix, a scalar multiply) is not expensive in isolation
   and Three doesn't expose a way to re-scope it.

3. **Larger redesign, not scoped here:** if the bounded experiment shows OBJECT-type node overhead
   is a real slice, the only lever inside Three's own architecture is reducing the render-object
   count that materials with those uniforms apply to — i.e. instancing / merging (draw-submission
   territory) or moving shared material params onto a coarser custom `uniformGroup` invalidated by
   an explicit dirty flag instead of relying on Three's per-uniform diffing. That is a material
   authoring change across every subsystem's TSL materials, not a base-game.html change, and belongs
   with whoever owns "bindings/uniform reuse" in this review — noting the dependency rather than
   attempting it here.

## Dependencies and overlap with other review areas

- The `NodeFrame`/`updateBefore` per-render-object loop is the mechanism the "bindings/uniform
  reuse" and "draw submission" areas will also be looking at from the allocation/count side; this
  report covers *what gets recomputed and how often it's deduped*, not *how many render objects
  exist* or *how bind groups are allocated*. Do not double-count the OBJECT-type finding as a
  separate cost from a draw-submission finding about object count — they're the same 202-object loop
  viewed from two angles.
- Terrain streaming uploads (`docs/terrain-streaming-integration-plan.md`) and the GPU-driven
  submission plan (`docs/render-submission-gpu-driven-plan.md`) are the documented paths for
  reducing render-object count; this report doesn't repeat their content, only confirms from the
  engine's update-dispatch code that fewer objects would proportionally reduce the OBJECT-scoped
  update cost this area was asked to look at.

## Correctness check for any future change here

Because `OBJECT`-type update dedup does not exist in Three r184, any change that tries to add
dedup around a built-in OBJECT node (e.g. wrapping `envMapIntensity` reads) risks staleness bugs —
the check would be: change `material.envMapIntensity` at runtime (any subsystem that does this,
e.g. sky/water tuning) and confirm the rendered brightness updates within one frame, both with and
without the proposed cache. For the `syncBundleGroups` string-signature approach (if bundles are
ever revived), the check is: toggle a single mesh's `.visible` and confirm `forestBundleSig` changes
and `needsUpdate` fires exactly once, not every frame after.

## What I could not verify

- No browser or GPU profiler access in this pass — every timing claim above is inherited from the
  measured facts given in the brief (`base-game-performance-log.json`,
  `trace-review-20260907.md`), not re-measured here. I cannot attribute a millisecond cost to the
  `materialEnvIntensity`/`OBJECT`-type finding; it's a code-read structural observation, not a
  profiled one.
- I did not extend the "no per-frame material rebuild" grep beyond `base-game.html` itself to every
  lazily-imported module (forest, grass, water, sky, terrain, bots, etc.) — that's a large surface
  and several of those modules are other subsystems' territory; if another review area finds a
  `material.needsUpdate` or shader-rebuild in a hot per-frame path inside one of those modules, it
  wasn't ruled out by this pass.
- I did not run any Node script against the actual scene graph (no headless WebGPU device available
  to construct real `RenderObject`s), so the `NodeFrame` dispatch behavior is read from the shipped
  three.webgpu.js source, not exercised. The source is unambiguous about the OBJECT-type no-dedup
  behavior (three.webgpu.js:53080-53084 etc.), so I'm confident in that reading, but it is still a
  code read, not a test run.
- I did not check whether `objectGroup` (three.webgpu.js:5347, `uniformGroup('object', 1,
  NodeUpdateType.OBJECT)`) causes a *bind-group* re-upload per object even when no individual
  uniform's JS value changed — that's a binding-layer question for whoever owns "bindings/uniform
  reuse," not traced further here to avoid overlapping their area.
