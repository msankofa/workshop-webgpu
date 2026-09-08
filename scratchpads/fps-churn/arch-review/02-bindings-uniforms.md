# Base Game FPS churn — bindings, uniforms, GPU resource reuse

Scope: read-only review of `node_modules/three/build/three.webgpu.js` (r0.184.0) binding/uniform
update path, mapped onto base-game.html's per-frame modules. No browser was driven; no new trace
was captured. All findings below are code reads plus static grep against our source, cross-checked
against the existing `research/stats/trace-review-20260907.md` numbers. I did not run the app.

## How the update path works (for reference)

Per render object, per frame, `Renderer._renderObjectDirect` (line ~58767 / ~61308 depending on
pass) calls, in order:
- `Nodes.updateForRender(renderObject)` — evaluates node values (`NodeFrame`), including any
  `uniform()` values from our TSL code.
- `Bindings.updateForRender(renderObject)` (`three.webgpu.js:32461`) → `getForRender` (32389,
  creates/caches the bind group on first use) → `_updateBindings` (32508) → `_update` per bind
  group (32554-32701).

Inside `_update`, for every binding in the group:
- `this.nodes.updateGroup(binding)` (32567 → `NodeManager.updateGroup`, 54252) decides whether the
  owning `UniformGroupNode` (`frameGroup`/`renderGroup`/`objectGroup`, defined 5331/5339/5347) has
  a new `.version`. This check is a `ChainMap` lookup (`_getWeakMap` + nested `WeakMap.get`,
  29334-29348) keyed on `[groupNode, nodeUniformsGroup]`, done once per binding per object per
  frame regardless of whether anything changed.
- If the group is "dirty", `binding.update()` runs. For a `UniformsGroup`/`NodeUniformsGroup`
  (61762, 62307) this iterates every individual uniform in the group and asks each one whether its
  JS-side value changed (`updateByType`), building `updateRanges` (61810-61830) so only the
  changed byte ranges are written — this part is already a partial-update design, not a full
  buffer rewrite, and is not "redundant work" in itself.
- If a `backend.updateBinding()`/`backend.updateBindings()` call fires (32601, 32697), that is a
  real GPU-side write (`writeBuffer` under the hood) or bind-group re-creation
  (`needsBindingsUpdate`, set when a storage-buffer attribute, texture generation, or sampler key
  changes, 32589/32626/32679).

Separately, **every** `RenderObject` re-derives its `needsUpdate` flag every frame
(`RenderObject.needsUpdate` getter, 30246) by calling `getDynamicCacheKey()` (30257), which in turn
calls `Nodes.getCacheKey(scene, lightsNode)` (54718). That method also does a `ChainMap`-style
lookup (`callHashCache.get(_chainKeys$1)`, 54725) keyed on `[scene, lightsNode]`, gated on
`renderer.info.calls` so the actual hash math (`lightsNode.getCacheKey`, environment/fog cache
keys, `hashArray`) only runs once per draw call, not once per object — but the **lookup** itself
still runs once per object per frame.

## Findings

### F1. Per-object `ChainMap`/`WeakMap` lookups on every binding, every frame — measured redundancy (code-read only)

- Path: `Renderer._renderObjectDirect` → `RenderObject.needsUpdate` (30246) → `getDynamicCacheKey`
  (30257) → `Nodes.getCacheKey` (54718, `ChainMap.get`-style access at 54725) — and independently
  `Bindings._update` → `NodeManager.updateGroup` (54252, `ChainMap.get` at 54259) for every binding
  in every bind group of every object.
- With ~202 objects and 2-3 bind groups each (object/render/frame + material-specific), that is on
  the order of 400-1000 `WeakMap` traversals per frame purely to answer "did anything change,"
  independent of whether it did. `ChainMap.get` (29334) walks a `WeakMap` per key segment — for a
  2-key chain that's two dependent `Map.prototype.get` calls plus a `_getWeakMap` object-property
  lookup, done from cold (no local caching on the `RenderObject`/binding itself for "no, group
  unchanged" beyond the version integer compare).
- Classification: **code-supported architectural weakness**, not a bug — this is normal engine
  behavior for a scene with heterogeneous static and dynamic objects; the point is that it is
  proportional to object count and runs even for objects nothing about which changed (camera didn't
  move relative to them, no material animation). I have not profiled this specifically; the
  trace-review's "steady per-object cost not explained by draw count alone" is consistent with it
  but doesn't isolate it from geometry/pipeline lookups (owned by the other investigator).
- Proposed replacement: none inside Three — this is core renderer plumbing, not something
  base-game.html should patch. The actionable lever on our side is **object count**, i.e. merging
  static geometry (structures, rocks, terrain decoration) into fewer `RenderObject`s so this
  per-object bookkeeping runs fewer times. That is a scene-authoring change, not a bindings fix,
  and overlaps with draw-submission/batching work — flagging it here because the bindings code is
  where the cost actually lands, but the fix belongs with whoever owns object count/instancing.
- Priority: informational — no direct change proposed in this file's scope.

### F2. Frame/render-level uniforms are correctly shared; object-level uniforms are correctly per-object — not a redundancy

- `frameGroup`/`renderGroup` (5331, 5339, both `shared: true`) back one `NodeUniformsGroup` per
  *unique node graph*, not per object — TSL's `uniform()` calls that use these groups (camera
  matrices, time, resolution) are written once per frame/render call and read by every object that
  references them. I checked this is genuinely shared: `UniformGroupNode` instances are
  module-level singletons (5331/5339/5347) and `NodeBuilder` caches `NodeUniformsGroup` by
  `[groupNode, ...]`, so 202 objects sharing `frameGroup` do not create 202 buffers for it.
- `objectGroup` (5347, `NodeUpdateType.OBJECT`) is per-object by design (it carries
  `modelMatrix`/`modelViewMatrix`/`normalMatrix`, which are genuinely per-object). This is correct,
  not wasteful — the matrix-auto-update experiment already tested suppressing the write side of
  this and found no gain (per the brief), consistent with `UniformsGroup.update()`'s per-uniform
  diff already skipping unchanged matrices for objects that don't move.
- Classification: verified from code; matches the already-run experiment's null result. No new
  proposal.

### F3. Distinct materials fragment bind-group caching — untested hypothesis, needs a source-side count

- Bind groups are cached by `RenderObjects`/`Bindings` per `RenderObject`, and a `RenderObject` is
  keyed off `(object, material, ...)` — `getForRenderCacheKey` (54283) returns
  `renderObject.initialCacheKey`, which is `getMaterialCacheKey() + getDynamicCacheKey()` (30293).
  Two meshes with materials that are `.clone()`d or separately `new`'d (rather than a single shared
  material instance) get separate `RenderObject`s, separate bind groups, and separate
  `NodeUniformsGroup`s for anything material-scoped even if the uniform *values* are identical.
- I grepped base-game.html's imported modules for material construction
  (`grep -n "new MeshStandardNodeMaterial\|new MeshBasicNodeMaterial\|new MeshPhysicalNodeMaterial\|NodeMaterial(" *.js` → 97 call sites across 40 files). Most of these are one-time module-level
  material factories reused across many instances (grass, forest, rocks, terrain splat), which is
  the correct pattern. `base-game-spawn-building.js:80-82` builds three shared materials
  (`barMat`, `soilMat`, `waterMat`) once and reuses them across the building's meshes — also
  correct.
- I did not find evidence of per-instance material cloning inside the modules I checked
  (`base-game-spawn-building.js`, `concrete-material.js`), but I did **not** exhaustively check
  every one of the 40 files (`base-game-structures-page.js`, `base-game-vehicle-lights.js`,
  `base-game-remote-players.js`, `roads.js`, `shoot-house.js` in particular are unread in this
  pass) for per-instance clones or per-object `uniform()` calls that would multiply bind groups.
  This is the one area where a real finding could still be hiding.
- Classification: **untested hypothesis** — the mechanism (unshared materials → uncached bind
  groups → more `_updateBindings` iterations) is real and code-verified; whether our scene actually
  does this at scale is unverified. A cheap correctness check: instrument
  `Bindings._update`/`getForRender` counts via a temporary `console.count` keyed by
  `bindGroup` identity for one captured frame (or read `renderer.info` if it exposes bind group
  counts — I did not check `Info`'s fields in this pass) and compare against `renderer.info.render.calls`
  (202). If bind-group count is well above material-type count, that confirms fragmentation.
- Priority: bounded experiment — grep the remaining ~30 unread files for `.clone()` on a
  `*NodeMaterial` or per-instance `uniform(` calls tied to `objectGroup`/default group before
  proposing a fix; do not change anything without that count.

### F4. No dynamic-offset uniform buffers in this build — confirms a documented constraint, not a finding to act on

- I grepped the entire built file for `dynamicOffset`/`DynamicOffset` and got zero matches. r0.184's
  WebGPU backend does not implement per-draw dynamic offsets into a single large uniform buffer;
  every `NodeUniformsGroup`/`NodeUniformBuffer` is its own GPU buffer with its own bind group.
- This means the "one big uniform buffer, offset per object" pattern used in some other WebGPU
  engines is **not available** in this Three version without patching the backend — it isn't a
  matter of the codebase not adopting it, it's not exposed. Ruling this out saves anyone from
  designing a plan around it.
- Classification: reproduced defect-of-absence (confirmed by exhaustive grep on the shipped build,
  not inferred from docs).
- Priority: none — closes off a design direction rather than opening one.

### F5. `updateRanges`/partial buffer writes already used — no redundant full-buffer writes at the Three level

- `UniformsGroup.update()` (61930) and `addUniformUpdateRange` (61811) mean an unchanged uniform in
  a group with one changed uniform does not get rewritten — only the changed uniform's byte range
  is queued and later cleared (`Bindings._update`, 32687: `if (binding.isBuffer &&
  binding.updateRanges.length > 0) this.clearUpdateRanges()`). I did not verify what the WebGPU
  backend's `updateBinding`/`writeBuffer` implementation does with multiple small disjoint ranges
  (whether it coalesces them into one `GPUQueue.writeBuffer` call per range, which could still be
  many small driver calls per object if a material has several independently-animated uniforms) —
  that backend-level implementation is outside `Bindings`/`Nodes` and I did not read it in this
  pass (candidate for the draw-submission investigator, since it's adjacent to
  `writeBuffer`/`queue.submit` batching, not per-object binding logic).
- Classification: verified partially (the JS-side diffing exists and is real); the GPU-side
  batching of multiple small writes is unverified.

## Dependencies / overlap with other areas

- Object count (merging static meshes) is the practical lever for F1 but is a
  scene-authoring/draw-submission concern, not a bindings fix — flagging, not claiming ownership.
- Geometry attribute uploads (`Attributes.update`, called from `Bindings._init`/`_update` for
  storage buffers) are explicitly out of scope here per the brief; only the *binding* side
  (`isStorageBuffer` branches at 32535 and 32576) was touched, not the attribute upload cost
  itself.
- `writeBuffer`/queue submission batching (end of F5) belongs with whoever reviews backend/draw
  submission, since it's downstream of `Bindings` and shared with geometry uploads.

## Priority summary

- Safe direct improvement: none identified in this pass — nothing here is a bug to patch inside
  our code; the Three-side behavior is either correct-by-design (F2, F5) or not ours to change (F4).
- Bounded experiment: F3 — finish the material/uniform grep across the unread ~30 files, then count
  live bind groups for one frame before proposing consolidation.
- Larger redesign: F1's actual fix (reducing object count via merging/instancing static geometry)
  is a scene-graph change, not a bindings change; sequencing and ownership belong to whoever is
  driving draw-submission/instancing work, informed by the mechanism documented here.

## What I could not verify

- Whether our scene's 202 objects actually contain unshared/cloned materials that fragment bind
  groups (F3) — grep coverage was partial (about 10 of 40 material-touching files read in detail).
- Actual per-frame counts for `ChainMap`/`WeakMap` lookups, `_updateBindings` calls, or bind-group
  creations in the running game — everything above is a code-path read, not a captured trace. A
  `?trace=1` capture from `render-trace.js` can show `renderer.render` wall time and (per the
  existing trace-review doc) coarse `_updateBindings`/binding-write sampling, but it cannot show
  `ChainMap`/`WeakMap` lookup counts or which specific TSL `uniform()` calls are driving buffer
  writes — that needs either a custom counter patched into a local three.webgpu.js copy (not done
  here, read-only investigation) or the browser profiler's JS call tree, which I was told not to
  drive.
- The GPU-backend `updateBinding`/`writeBuffer` implementation itself (WebGPU backend file, not
  read in this pass) — whether multiple small `updateRanges` per object become multiple
  `GPUQueue.writeBuffer` calls or get coalesced.
- `Info`'s exposed counters (didn't check if bind-group/binding-update counts are already tracked
  and visible via `renderer.info`, which would make F3's proposed check nearly free).
