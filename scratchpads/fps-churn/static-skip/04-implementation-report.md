# 04 — The forest refresh policy, as built

Built as an **off-by-default experiment**. `createForestGPU({ staticRefresh: false })` is the shipped
state; with it off every call delegates to Three's own observer and nothing in the page changes.
No vendor file was edited.

## What changed

| File | Change |
|---|---|
| `forest-gpu.js` | New module-level `FOREST_COMMIT` symbol, `forestPolicyContext` WeakMap, `classifyObjectUpdateNode()`, exported `forestGraphVerdict(state)`, `createForestObserver(base, ctx)`, and `class ForestNodeMaterial extends MeshStandardNodeMaterial` overriding `setupObserver`. Inside `createForestGPU`: `STATIC_REFRESH`/`forestEpoch`/`staticRefreshStats`/`policyContext`/`invalidate(list?)`; `drawMesh` writes `userData.forestEpoch`; `makeMat` builds a `ForestNodeMaterial` and registers the context; `installCommitHook()` wraps `renderer._nodes.updateAfter`; `invalidate()` calls at `setTreeScale`, `setLeafScale`, `setLeafSway`, `setFarLeavesDoubleSided`, the perfAB double-sided toggle, `applyTextureSet`, `installVariant` and `uploadCounts`; new `invalidateStaticRefresh(list?)` and `staticRefreshStats` on the returned API; `stats.staticRefresh`; `dispose()` removes the hook. |
| `base-game-forest.js` | `BASE_GAME_FOREST_DEFAULTS.forestStaticRefresh: false`; `'forestStaticRefresh'` added to `PALETTE_KEYS` (it is a construction option, so changing it rebuilds); `staticRefresh: cfg.forestStaticRefresh === true` passed to `createForestGPU`; `sampleDetail()` copies `stats.staticRefresh`. |
| `base-game.html` | `settings.forestStaticRefresh` default, `?foreststatic=1` override applied after the shipped state loads, the key in `FOREST_APPLY_KEYS`, and an `addToggle` in the Tree look section ("Skip refreshing unchanged tree meshes"). |
| `docs/subsystems/vegetation.md` | The `createForestGPU` signature, the `stats` block, the two new exports, and a full architecture note on the policy. |
| `scratchpads/fps-churn/static-skip/03-design.md` | Retitled "A proposed forest refresh policy"; "pristine third-party artifact" → "no additional vendor change". |
| new: `test-forest-static-observer.mjs`, `test-forest-object-group.mjs` | 53 and 62 assertions. |

`invalidate(list)` bumps a closure epoch and stamps it onto every mesh in `list` that carries one
(default: all meshes). The merged pulled mesh and the billboards are never stamped, so their
materials fall through to Three's observer — see "Outside the opt-in" below.

## The four reviewer requirements

### 1. A material value change with an identical shader and cache key refreshes EVERY mesh

The policy records `renderObject.material.version` on every refresh and refreshes again whenever it
differs, per render object. It does not depend on `RenderObjects.get` recreating anything (a bare
`needsUpdate` that leaves the cache key unchanged only updates `renderObject.version` there,
`three.webgpu.js:30436-30448`). `setFarLeavesDoubleSided`, `applyBillboardMap` and `applyTextureSet`
already write `needsUpdate`; `applyTextureSet` and the two side toggles now also call `invalidate()`,
and `invalidateStaticRefresh(list?)` is exported for anything that writes a forest material value
without a version bump.

**Test** — `test-forest-static-observer.mjs`, section *"a material value change with an unchanged
shader key refreshes the SECOND mesh too"*: two meshes of one material are settled to the steady
state (first refreshes, second skips), `mat.roughness = 0.42; mat.needsUpdate = true`, and the
assertion is that **`v1` — the second mesh — refreshes**, then that it settles back to one refresh.

### 2. The normal matrix, camera dependence, and the allowlist

**The uniform.** `dump-forest-object-group.mjs` and `forest-object-group.json` were rerun. Every one
of the nine roles' object group holds exactly one `Matrix3NodeUniform`, and the only object-typed
plain `UniformNode` in each graph **is three's `modelNormalMatrix` singleton, asserted by identity**.

**How its value is computed** — `vendor/three-0.184/three.webgpu.js:14622`:

```js
const modelNormalMatrix = uniform( new Matrix3() )
  .onObjectUpdate( ( { object }, self ) => self.value.getNormalMatrix( object.matrixWorld ) );
```

It reads `object.matrixWorld` and nothing else: **no camera, no render context, no pass**. The camera
enters in the shader body instead (`render.cameraViewMatrix * (object.<mat3> * normalLocal)`), and
`cameraViewMatrix` lives in the shared `render` group, which the one-refresh-per-material-per-render
rule keeps current. The camera-dependent alternatives Three offers — `highpModelNormalViewMatrix`,
`highpModelViewMatrix` (`:14672-14700`) and `ModelNode` scope `viewPosition` (`:14385-14392`) — are
not in these graphs, and would all be refused: the first two are `UniformNode`s that are not the
`modelNormalMatrix` singleton, the third is a `ModelNode` whose scope is not `worldMatrix`.

**No object-group uniform in these graphs depends on the camera or the pass.** The remaining
object-typed nodes are `UniformGroupNode('object')`, `UserDataNode.slotOffset`,
`ModelNode:worldMatrix` and 5-6 `MaterialReferenceNode`s. `uTreeScale`/`uLeafScale`/`uLeafSway` sit in
the object group but have `updateType 'none'` — they never appear in `updateNodes`, which is exactly
why `invalidate()` is the only path that can carry them.

**The allowlist**, `forestGraphVerdict(state)`, is computed once per builder state (so per material
per pass) at the first refresh of a render object it owns, from `renderObject.getNodeBuilderState()`.
It refuses — and falls back to Three's observer for that graph, recording the reason in
`stats.staticRefresh.refused` — when the state has any `updateBefore`/`updateAfter` node, or any
OBJECT-typed update node outside the five kinds above.

**What it accepted on the real Base Game configuration.** `test-forest-object-group.mjs` builds the
forest exactly as `base-game-forest.js` does (`billboards: false`, `shadowLayer` named,
`drawMode: 'variants'`, `instanceNormalVarying: true`, `leafSway` from the defaults, materials bound
through `bindTreeMaterials`, and **no `addEmissive` — `base-game-forest.js` passes none**;
`environment-viewer.html` is the only caller that does). All nine roles were accepted. The exact
object-typed node list per role:

| role | object-group uniforms | object-typed update nodes |
|---|---|---|
| branchesL0, branchesL1, branchesL2, barkShadow | 9: `u1` u32 slotOffset, `u2` uTreeScale, `u3`/`u4`/`u5` f32, `u7` mat3 normal matrix, `u8` vec3 colour, `u9` f32, `u14` mat4 world matrix | `UniformGroupNode(object)`, `UserDataNode.slotOffset`, `ModelNode:worldMatrix`, `MaterialReferenceNode.opacity/.metalness/.roughness`, `modelNormalMatrix`, `MaterialReferenceNode.emissive/.emissiveIntensity` |
| leavesL0, shadowL0, leavesL1, coarseLeavesL2, leafShadow | 12: `u1` slotOffset, `u3`..`u9` (uTreeScale, uLeafScale, uLeafSway and material scalars/colour), `u11` mat3 normal matrix, `u12` vec3 colour, `u13` f32, `u18` mat4 world matrix | the same, plus `MaterialReferenceNode.color` |

`updateBeforeNodes` and `updateAfterNodes` are empty for all nine.

**The refusal case is tested.** The same test builds the forest with an `addEmissive` that returns
`uniform(vec3()).onObjectUpdate(...)` and asserts `forestGraphVerdict` refuses it and names
`UniformNode` as the reason; it also asserts refusal for a state carrying an `updateBefore` node, an
`updateAfter` node, and for a missing builder state.

### 3. Bookkeeping on every refresh, including the first-per-material-per-render one

`mark(renderObject)` writes epoch, `material.version`, geometry id and the 16 world-matrix elements
on **every** path that returns `true` — first initialisation, the velocity/animation path, the
per-render refresh and the epoch/version paths alike. So an invalidated first mesh does not take a
second refresh when render order changes.

**Test** — same file, *"an epoch bump refreshes every mesh, once…"*: after `setLeafScale`, both
meshes refresh with the order reversed (`[ro1, ro0]`), and the next render with the original order
costs exactly one refresh, not two.

The comment the reviewer asked for is in the test's header block, not in the code: needsRefresh
returning `true` is a decision taken before the renderer does the work, and what happens on a throw
is covered by the commit hook below.

### 4. Adversarial cases

All in `test-forest-static-observer.mjs`, over **real** `ForestNodeMaterial` graphs built by the
shipped `WGSLNodeBuilder` (so `builder.observer` is the object Three would call) and real meshes; the
render objects are fakes shaped like Three's, but the base `NodeMaterialObserver` is driven through
its own `firstInitialization`/`getRenderObjectData`, so its bookkeeping is genuine. The driver is a
reduction of `Renderer._renderObjectDirect` (`:61312`) including the `_nodes.updateAfter` call.

- **The decision table** — first render both refresh; second and third, one refresh; order reversed,
  still exactly one, and it is the first one seen.
- **Geometry mutated on mesh 2 only** — `installVariant(1, …)` (geometry swap plus the indirect
  upload) refreshes v1; the untouched variant does not take a second refresh.
- **A geometry swapped with no invalidate at all** — the geometry-id backstop refreshes it anyway.
- **Alternating which mesh is first** — asserted above; the shared render group is written exactly
  once per render either way.
- **A rebuild** — a second forest hands out fresh meshes with a fresh observer, and its first render
  object refreshes.
- **A rebase** — `setWorldOrigin` bumps no epoch and moves no mesh, and the second mesh still skips;
  see the dedicated heading below.
- **Three passes in one frame** — main, shadow and reflection render objects over the same mesh keep
  three sets of books: each refreshes once per render id, the second render object inside one render
  id skips, and an `invalidate()` is honoured once in every pass.
- **Flag off** — a forest built with `staticRefresh: false` answers `true` on all six calls (Three's
  behaviour for a node material, `:698`), skips nothing, and installs no commit hook.
- **A scalar change with an unchanged shader key** — requirement 1 above.
- **A velocity MRT** — every call refreshes while `getMRT().has('velocity')`.

### Outside the opt-in: the pulled modes and the billboards

The policy only reads meshes that `drawMesh` stamped. The merged pulled mesh and the billboard meshes
are built by their own code paths and are never stamped, so their materials delegate to Three's
observer on every call. That is deliberate: the merged mesh's vertex stage reads the arena storage
buffers, which are uploaded outside any per-mesh event the epoch tracks, and each billboard rebuilds
its own `colorNode` per variant. Asserted in *"the pulled modes and the billboards stay outside the
opt-in"*.

## The three additions from the second review

### A. The clean mark is committed from a success signal, not from the decision

`needsRefresh` returning `true` only marks the render object **pending**. The clean mark is committed
from a hook `forest-gpu.js` installs on `renderer._nodes.updateAfter`, which the renderer calls at
`three.webgpu.js:61351` **only when** `needsRefresh` was `true`, the pipeline was ready and the draw
was issued. A refresh that throws never reaches it; neither does one whose pipeline was not ready.
While a mark is pending, the next call refreshes again. The hook is a runtime wrap on the renderer
(the pattern `render-trace.js` already uses on `renderer._nodes.needsRefresh`), idempotent, and
removed in `dispose()` — no vendor change.

**Tests** — *"a refresh whose update throws is retried on the next call"* drives the update path: an
`invalidate()`, v0 refreshes and commits, v1's update **throws**, and the next call for v1 returns
`true`; once it completes it skips again. *"a refresh whose pipeline was not ready is retried too"*
does the same with `pipelineReady: false`. *"dispose puts renderer._nodes.updateAfter back"* asserts
the unwrap.

### B. What a rebase actually does to the forest meshes

Read out of the two files rather than assumed:

- `forest-gpu.js` `setWorldOrigin(x, y, z)` only sets `originX/Y/Z` and `needsRebuild = true`. The
  rebuild re-bakes each record as `Math.fround(r.x - originX)` into `srcArray` and sets
  `srcAttr.needsUpdate` / `countsAttr.needsUpdate`. Both attributes are bound **only by the cull
  kernels**, and `Bindings.updateForCompute` (`:32450`) is outside the refresh gate.
- No forest mesh has a transform: `drawMesh` sets no position, quaternion or scale, and nothing else
  writes one. `base-game.html`'s `onRebase` handler moves `traversalLab.root`, `spawnBuilding.root`,
  `structures.root` and `roads.group` — **not** the forest, whose published meshes are handed to
  `matrixWalk.skip` precisely because they "sit at the render origin and never move"
  (`base-game.html:3722`).

So the rebase forces no refresh, and correctly so. Because correctness outranks the optimisation, the
policy still compares the render object's 16 world-matrix elements and its geometry id on every skip:
if anything ever does move a forest mesh, it is refreshed regardless of the epoch.

**Tests** — *"a render-origin rebase moves no forest mesh, so it forces no refresh"* asserts the
epoch and matrix are unchanged after `setWorldOrigin(4096, 0, -4096)` and that the second mesh still
skips; then moves `branch1` by hand with **no** invalidate and asserts the matrix compare refreshes
it.

### C. The actual setters, and unsupported callbacks vs known material values

`setTreeScale`, `setLeafScale` and `setLeafSway` write a shared `uniform()` value that lands in every
mesh's own object UBO with nothing bumping `material.version`. All three now `invalidate()`, and all
three are guarded on a value change — `setLeafSway` had no guard at all and
`base-game-forest.js:597` calls it on **every** `syncRenderState`, which would have refreshed the
whole forest every frame. `setLeafScale` had no guard either.

In the allowlist the distinction is explicit: `MaterialReferenceNode` (the known material
scalars/colours — roughness, metalness, opacity, colour, emissive, emissiveIntensity) is **allowed**
and covered by the `material.version` compare; an unsupported custom callback (any
`onObjectUpdate`/`onRenderUpdate`/`onFrameUpdate` uniform a host's graph extension added, which
appears as an object-typed `UniformNode` that is not `modelNormalMatrix`) is **refused** and the
graph falls back to Three.

**Tests** — *"the setters that write a shared uniform value, guarded on change"* calls the real
setters: a new value on any of the three refreshes both meshes; the same value again refreshes only
the one-per-render mesh. The refusal case is in `test-forest-object-group.mjs` (above).

## Tests run

All exit 0:

```
test-forest-static-observer   53 passed, 0 failed
test-forest-object-group      62 passed, 0 failed
test-forest-leaf-shaders      test-forest-pulled-wgsl     test-forest-pulled-arena
test-base-game-forest         test-forest-cull            test-forest-gpu-programs
test-forest-gpu-rebuild       test-forest-gpu-rung-gate   test-forest-source-uploads
test-trees-geometry           tsl-build-check             test-page-syntax
```

(The task named `test-forest-rung-gate`; the file is `test-forest-gpu-rung-gate.mjs`.
`test-trees-geometry.mjs` also imports `forest-gpu.js` and was run.)

## What remains unverified

**Everything about the browser.** Nothing here has been rendered.

1. **The refresh count.** `render-trace.js:527` counts `refreshes` over `refreshChecks` per scene.
   The measurement is: `?trace=1`, plants on, capture with the toggle off, then with
   `?foreststatic=1`, and read `context.render.trace.lastFrame.scenes[]` for the main `Scene`.
   `refreshChecks` should be unchanged; `refreshes` should fall by (forest meshes present) minus
   (distinct forest builder states taking their one-per-render refresh). The predicted ~135-fewer of
   217 in 03 §5 is still a prediction — the capture settles it, and so does whether the nine roles
   collapse to nine builder states.
2. **`stats.staticRefresh` in a capture.** `skipped`, `skippedLastRender`, `refreshed` and `refused`
   ride out through `forest.sampleDetail()` into `context.flora.trees.staticRefresh`. `refused` being
   non-empty in a real capture would mean the browser's graph differs from the headless one — that is
   the check worth reading first.
3. **The picture.** A still frame with the toggle on and off must be pixel-identical, and the seven
   walking checks in 03 §5 (streaming and the rung gate, an 8 km rebase, the three sliders, a
   progressive palette wave, the double-sided toggle plus the async texture set, the shadow meshes)
   are unrun.
4. **`_nodes.updateAfter` in the real renderer.** The commit hook is exercised against a stub
   `_nodes` in Node. That the real `Nodes.updateAfter` is called for forest render objects in a real
   frame is read out of `three.webgpu.js:61351`, not observed.

## Points I could not meet

None outright. Two things are narrower than they sound:

- **The allowlist is a graph check, not a value check.** It proves no *node* writes an unexpected
  per-object uniform. A third party mutating `uTreeScale.value` (or any other `updateType 'none'`
  uniform in the object group) behind the forest's back is still invisible to it; that is what
  `invalidateStaticRefresh()` exists for, and it remains an audit obligation, as 03 §3 said.
- **The commit hook is one wrap on a private renderer field** (`renderer._nodes`). It is not a vendor
  change, but it is a dependency on a private name; if a Three upgrade renames it, the hook silently
  does not install and every marked render object stays pending — i.e. it degrades to Three's own
  refresh count, not to a stale picture.
