# Refresh-skip extension — design (D2, 2026-09-08)

Design only. No code written, nothing edited, no browser driven. Line numbers are
`node_modules/three/build/three.webgpu.js` (r0.184). Labels: **[code-read]**, **[measured]**,
**[estimate]**, **[unknown]**.

Problem, restated: every Base Game material has node properties, so
`NodeMaterialObserver.needsRefresh` (696-716) returns `true` on its first clause and never reaches
the renderId check, the `object.static` / bundle shortcut, or `equals()`. **[code-read]** Captures
show `refreshes === refreshChecks` in every frame, encode 12-42 ms/frame with
`Bindings.updateForRender` ~45% and `Nodes.updateForRender` ~17% of encode. **[measured]**

Astra's requirement is adopted as the shape of this design: opt-in only, an explicit and complete
dependency contract per declared object, unknown graphs default to Three's path, adversarial
multi-pass and changing-uniform tests, and no claim that skipped work was redundant.

---

## 1. What a refresh actually does

`Renderer._renderObjectDirect` (61286-61330) **[code-read]**:

```
needsRefresh = this._nodes.needsRefresh(renderObject)      // 61302
if (needsRefresh) {
  this._nodes.updateBefore(renderObject)                   // 61306
  this._geometries.updateForRender(renderObject)           // 61308
  this._nodes.updateForRender(renderObject)                // 61310
  this._bindings.updateForRender(renderObject)             // 61311
}
this._pipelines.updateForRender(renderObject)              // 61315  — always, outside the gate
if (this._pipelines.isReady(renderObject)) {
  this.backend.draw(renderObject, this.info)
  if (needsRefresh) this._nodes.updateAfter(renderObject)  // 61323
}
```

Side effect by side effect:

| Call | What it does | What it reads |
|---|---|---|
| `Nodes.updateBefore` (55023) | iterates `nodeBuilderState.updateBeforeNodes`, calls `nodeFrame.updateBeforeNode` | pre-pass node callbacks: render-target-consuming nodes (reflection/Hi-Z/viewport-texture style), whatever declares `updateBefore` in the graph |
| `Geometries.updateForRender` (30915) | `initGeometry` if unseen, then `updateAttributes` | index + every vertex attribute's `version`, instanced attributes, morph attributes; uploads changed ones through `attributes.update` |
| `Nodes.updateForRender` (55082) | iterates `updateNodes`, `nodeFrame.updateNode(node)` each | all update-typed nodes. `FRAME`/`RENDER` scoped nodes are deduped in `NodeFrame` by `frameId`/`renderId` in a WeakMap; **`OBJECT`-scoped nodes have no dedup and re-run per RenderObject** (53039-53184). Includes the `UniformGroupNode`s themselves (50396-50406), so `objectGroup.version` bumps once per RenderObject **[code-read]** |
| `Bindings.updateForRender` (32461) | `_updateBindings(getForRender(ro))` → `_update(bindGroup)` per group (32508, 32554) | for each bind group: `NodeManager.updateGroup` gate (54252) on the group node's version; then `UniformsGroup.update()` diffs each uniform against its JS shadow (61973-62160) and only pushes an update range on change; sampled textures / samplers / storage buffers refreshed via `textures.updateTexture` / `updateSampler` / `attributes.update` (32519-32545); `backend.updateBinding` only when the diff produced something (32595-32601) |
| `Nodes.updateAfter` (55043) | iterates `updateAfterNodes` | post-draw node callbacks (e.g. nodes that copy the framebuffer after the draw) |

Two facts that bound any saving: the uniform diff already writes nothing when values are unchanged
(so the saving is the **walk and the callbacks**, not GPU traffic) **[code-read]**, and
`Pipelines.updateForRender` (61315) plus `backend.draw` run regardless, so skipping refresh never
removes the draw or the ~30-field `backend.needsRenderUpdate` compare (81690). **[code-read]**

---

## 2. The observer's existing dependency model (non-node materials)

`getRenderObjectData` (~180-230) snapshots: `geometry.id`, a clone of `object.matrixWorld`,
`object.center` (sprites), `morphTargetInfluences`, `bundle.version`, and for transmissive
materials `context.width/height`; plus `getLightsData(lightsNode.getLights())`. **[code-read]**

`equals(renderObject, lightsData, renderId)` (~376+) compares, in order **[code-read]**:

1. `object.matrixWorld` against the stored clone.
2. Material: `getMaterialData` snapshots the fixed `refreshUniforms` list; the comparison runs
   **once per renderId per material** (`materialData._renderId`), memoising `_equal`. Values with
   `.equals` compare structurally, textures compare `id` + `version`, others by `!==`. Transmission
   re-checks buffer size.
3. Geometry: `geometry.id`, then per-attribute `id` + `version`, memoised once per renderId per
   geometry.
4. Lights data (hash of the lights the material sees), then renderId bookkeeping.

Not compared at all: camera/pass identity (handled structurally — `RenderObjects.get` is keyed on
`[object, material, renderContext, lightsNode]`, ~30399, so each pass has its own RenderObject and
its own observer entry), `object.visible`/`layers` (the render list already filtered), scene fog/env
identity, and anything reached only through a node graph.

Why Three bails out for node materials: `containsNode` (270-290) returns true if any material
property `isNode` or the builder context uses `modelViewMatrix` / `modelNormalViewMatrix` / `getAO`
/ `getShadow`. **[code-read]** The observer's snapshot vocabulary is fixed material fields; it
cannot see a TSL graph's `uniform()` handles, `time`, texture nodes swapped at runtime, storage
buffers, or `onFrameUpdate`/`onObjectUpdate` callbacks whose side effects the frame depends on. A
node graph's inputs are unbounded from the observer's point of view, so it refuses to guess.

---

## 3. Dependency contract for a declared-static RenderObject

Everything below can change bindings or shader inputs **without** `material.version` changing.
A declared-static object must be re-checked against all of them, or the declaration is unsound.

| Input | Why it matters | Detection | Cost per object per frame |
|---|---|---|---|
| `object.matrixWorld` | model/modelView/normal matrices in `objectGroup` (5347) | compare `matrixWorld.elements` to a stored copy, or trust `object.matrixWorldNeedsUpdate` history — safer: 16 float compares | ~16 compares [estimate] |
| Render-origin rebase | `world-coordinates.js:52 renderOriginShiftDelta`, `rebaseDistance 8192`, `rebaseSnap 1024` (world-coordinates.js:72-76) — a rebase moves every render-local object at once | a monotone `originEpoch` counter on the coordinate space; declared objects compare one integer | 1 compare |
| Camera / pass | per-object `modelViewMatrix`, `normalMatrix` depend on camera; main vs shadow vs reflection | already structural: a distinct `renderContext` gives a distinct RenderObject (30399), so a per-RenderObject snapshot is per-pass by construction. Must still key the snapshot on the RenderObject, never on the Object3D | 0 (structural) |
| Camera motion | the camera moving changes modelView even when the object does not | store the camera's `matrixWorldInverse` + projection version per pass; compare once per pass, not per object | 1 compare per object against a pass-level "camera changed" flag |
| `time` / animated TSL | `NodeFrame` time, `oscSine`, wind, water — these are `FRAME`/`RENDER` scope and deduped anyway, but the object's own callbacks still fire | disqualify: any graph containing a time-dependent or `updateBefore`/`updateAfter` node is not declarable | n/a (excluded) |
| `uniform().value` written from JS | the whole reason a graph looks static and is not. 14 modules write `.value` (grep over `base-game-*.js`, `terrain-*.js`, `grass*.js`, `forest-gpu.js`, `sky.js`, `clouds.js`) **[measured: grep]** | require the declaring subsystem to route its writes through a helper that bumps a `dirtyEpoch` on the declaration, or to list the uniform handles so the wrapper diffs their `.value` | 1 integer compare (epoch), or N value compares if listed |
| Lights | `lightsNode` is part of the RenderObject key, but light *values* (position, colour, shadow matrix) live in `renderGroup` and are shared/deduped per pass; flashlight/laser toggles change the lights set | lights-set change rebuilds the lightsNode → new RenderObject, so structural. Value changes are `renderGroup`, updated once per pass regardless of this gate — **but only if some object still refreshes**. Safety rule: never let a pass skip *every* object; or explicitly exclude declared objects from carrying shared-group updates | 1 flag |
| Textures / samplers replaced | terrain splat streamed textures, palettes, Hi-Z | compare `texture.id` + `texture.version` for the textures the declaration lists; anything with a runtime-swapped texture is better excluded | N cheap compares, or excluded |
| Instancing / skinning / morph | instanceMatrix / instanceColor version bumps in body and weapon batches; `hasAnimation` already excludes skinned meshes (712) | attribute `version` compare, same as `getAttributesData`. Simpler: exclude instanced and skinned objects from the class in v1 | excluded |
| Geometry attribute versions | terrain chunk rebuilds, BatchedMesh edits | per-attribute `id` + `version` — reuse the observer's own `getAttributesData` shape | ~5-10 compares |
| Storage buffers / compute output | grass and forest read compute-written storage | exclude outright: the binding may be swapped or resized by a compute pass | excluded |
| userData-driven nodes, fog, env, background | scene-level changes with no material version bump | scene-level epoch bumped by the page whenever fog/env/background/vision-mode changes; declared objects compare it | 1 compare |
| `material.color.set(...)` etc. without `needsUpdate` | mutation invisible to version | run the observer's own `getMaterialData`/`equals` material step, which is already memoised once per renderId per material — cheap and reuses vendor code | amortised, once per material per pass |

Net per declared object per frame: roughly 20-40 primitive compares plus a handful of epoch
integers. **[estimate]** That is the thing that has to beat `Nodes.updateForRender` +
`Bindings.updateForRender` for that object; nothing measured yet says by how much.

---

## 4. The opt-in class in Base Game

Candidates (all **[estimate]** until the trace's `topBindings` / `topNodes` rows are read from a
fresh capture — `render-trace.js:151-160` emits `top`, `topNodes`, `topBindings` with per-object ms
and share, which is the list that should decide this):

- **Plausible**: spawn-building meshes and eco-brutalist structure pieces (static transforms, no
  runtime texture swap once built); merged static props/rocks/decals; static road meshes; terrain
  chunk batches **only if** their attribute versions and splat textures are stable between
  rebuilds — they are not during streaming, so terrain qualifies only for chunks marked resident
  and unchanged this frame.
- **Excluded by construction**: player and NPC bodies (skinned/animated, `hasAnimation` already
  forces refresh at 712), grass and forest (compute-written storage), water and sky and clouds
  (time-driven), rain, FX and debris, remote players, drones and aircraft.

Count: main-scene captures show ~200 RenderObjects. **[measured]** How many are static structures
vs terrain vs bodies is **[unknown]** without reading the `top` rows; a plausible declared set is
20-60 objects, i.e. 10-30% of the objects and, if per-object cost is roughly uniform, 10-30% of the
~45% + ~17% of encode. That would be ~2-8 ms/frame of the 12-42 ms encode. **[estimate — the
uniformity assumption is untested and is exactly what the top rows would falsify.]**

---

## 5. The seam

**(a) Wrap `renderer._nodes.needsRefresh`.** `render-trace.js:460` already wraps this exact method
on the renderer's own instance (instance property shadows the prototype, so nothing else is
affected). The wrapper: if the RenderObject is in our declaration registry *and* its dependency
snapshot matches, return `false`; otherwise call through to Three and return its answer. Cost: one
small module, no vendor changes, no reimplemented dispatch. Risk: we can only ever *reduce*
refreshes, and a bug shows as stale visuals rather than a crash. Compatibility check at attach:
`typeof renderer._nodes?.needsRefresh === 'function'`, `renderer._objects`, `renderObject.object`,
`renderObject.material`, `renderObject.geometry`, `renderObject.lightsNode` all present; if any is
missing, do not attach and log once.

**(b) `setRenderObjectFunction`** (60427). Requires reimplementing ~100 lines of
`_renderObjectDirect` dispatch (bundles, groups, clipping context, pipeline readiness) and
re-verifying it every Three release, to gain nothing (a) does not already give.

**(c) Vendored patch to the observer.** Cleanest semantically (a real `renderObject.declaredStatic`
branch before the `hasNode` clause), but means leaving the CDN and rebasing an 84k-line file per
release; the repo has no tooling for that. **[code-read from 00-verdict §3.6]**

**Recommendation: (a).** Off by default, enabled with `?staticrefresh=1`, and a second flag
`?staticrefresh=audit` that computes the snapshot, still returns Three's answer, and logs how often
the two disagree — that is the correctness evidence, gathered before any skipping happens. Upgrade
cost per Three release: re-check the five field names above and re-read `needsRefresh`; if the
signature changed, the compatibility check fails closed and the game runs unchanged.

---

## 6. Adversarial tests

Each of these must show **no skip** (or a correct skip) with `?staticrefresh=audit` reporting zero
disagreements:

1. **Same-frame multi-pass.** Main + shadow with different cameras, both containing the same
   declared mesh. Assert the two passes hold distinct RenderObjects and distinct snapshots; assert
   moving only the shadow camera invalidates only the shadow one.
2. **`uniform().value` change between frames** on a declared object → must refresh. This is the
   test that decides whether declaration-by-subsystem or uniform-handle-listing is required.
3. **`matrixWorld` change** (move the object one frame) → must refresh that frame and may skip the
   next.
4. **Origin rebase** — walk past `rebaseDistance` — every declared object must refresh on the
   rebase frame.
5. **Texture replacement** — swap a splat/palette texture on a declared material → must refresh.
6. **Lights toggle** — flashlight on/off, laser on/off → new lightsNode → new RenderObject; assert
   the new RenderObject is not treated as declared until it snapshots.
7. **`material.color.set()` with no version bump** → must refresh (covered by delegating the
   material step to the vendor `getMaterialData` path).
8. **Sustained static frame** — nothing moves for 60 frames → refresh count for declared objects
   drops to ~0 while the render is pixel-identical.

Node harness: the snapshot/compare module itself is pure and fully testable headless — feed it fake
RenderObject shapes (`{object:{matrixWorld}, material, geometry:{attributes}, lightsNode}`) and a
fake NodeFrame, and assert the invalidation matrix above. `test-refresh-declaration.mjs`, flat at
repo root, matching the repo's convention. What needs the browser: tests 1, 6 and 8 end-to-end, and
every pixel comparison — visual equality is not provable in Node.

---

## 7. What this does not prove

Broad `needsRefresh === true` proves the branch is *taken* every frame; it does not prove the work
inside it is redundant. Concretely: `UniformsGroup.update` already diffs against a JS shadow and
skips `backend.updateBinding` entirely when nothing changed (61973-62160, 32595-32601)
**[code-read]**, so the GPU traffic for a genuinely static object is already near zero. What a skip
removes is the **walk** (the per-uniform compares, the bind-group iteration, the `updateGroup`
version checks) and the **node update callbacks**. It removes neither the draw nor
`Pipelines.updateForRender`.

How to measure it, before and after, with the existing sub-phase trace: capture with `?trace=1` and
compare, per main-scene frame, `refreshes` vs `refreshChecks`, `bindingsMs`, `nodesRenderMs`,
`nodesBeforeMs`, `bindingWrites` and `bindingWriteBytes`. The prediction if the theory holds:
`refreshes` falls by the declared-object count, `bindingsMs` + `nodesRenderMs` fall roughly
proportionally, and `bindingWrites`/`bindingWriteBytes` barely move (they were already near zero for
those objects). If `bindingsMs` does not fall while `refreshes` does, the per-object cost is not
where we think it is and the extension should be abandoned rather than tuned. Fixed comparison
conditions: same seed, same route and camera path, same worker count, vegetation, flashlight and
reflection settings, warm-up frames discarded — as specified in
`docs/render-data-submission-improvement-plan.md` §0.
