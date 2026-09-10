# 03 — The smallest provably-correct change

Labels as in 01/02. This is a design document; no runtime file has been edited.

## Verdict

**Option B, with one correction to its premise: no change to the vendored Three is needed at all.**

`NodeMaterial.setupObserver( builder )` is an ordinary overridable material method
(**[source]** `vendor/three-0.184/three.webgpu.js:21114-21118`, called at `:21260`), and the only
thing the renderer ever calls on the object it returns is `needsRefresh( renderObject, nodeFrame )`
(**[source]** `:29786-29790` → `:55129-55136`; the only other references to `.observer` in the whole
build are the three that store and pass it: `:21260`, `:48444`, `:54650`). So the forest can supply
its own refresh policy for its own nine materials by subclassing `MeshStandardNodeMaterial` and
overriding one method. Nothing outside `forest-gpu.js` changes, the vendored file stays a pristine
third-party artifact, and every other node material in the page keeps Three's exact behaviour.

### Why not the others

- **(A) patch the vendored Three to honour `object.static` for node materials.** It works, and the
  reviewer's objection is right that it still needs the full invalidation list from 02 §D — so it
  buys no safety over B. What it costs is blast radius: `object.static` would silently change
  meaning for *every* node material in every page that loads the vendored build, and the semantics
  would diverge from upstream (upstream `static` skips `equals()`; this would skip the `hasNode`
  short-circuit, which is a strictly stronger claim). Rejected because B gets the same skip with the
  scope narrowed to the code that can actually honour the contract.
- **(C) skip `_bindings` and `_nodes` but keep `_geometries`.** Attractive on risk — it makes 02 §D
  items #9 and #10 (the `installVariant` geometry swap and its indirect upload) self-healing — and
  **[capture]** `geometriesMs` is only 0.4-1.1 ms of the 11.8-22 ms main-scene encode, so keeping it
  is cheap. But the gate in `_renderObjectDirect` is a single boolean (**[source]** `:61330-61341`);
  splitting it *does* require editing the vendored Three, which is exactly what B avoids. So C is
  not available without A's cost. Under B those two events are handled by two `invalidate()` calls
  instead — see the list below.
- **(D) bake `slotOffset` into geometry so meshes share more.** It does not reduce the refresh count
  at all: **[generated]** the object group still holds the model world matrix, the normal matrix,
  `uTreeScale` and 5-6 material scalars per mesh, and `_bindings.updateForRender` still diffs the
  whole group per object. It would be a prerequisite for *merging* meshes (a much larger win and a
  much larger change), but it is not the smallest correct change to the problem asked about.

## The change

### 1. `forest-gpu.js` — a material subclass with a refresh policy

```js
// A forest mesh's object-group state is fixed between the events forest-gpu raises. Three's own
// observer cannot see that: a node material short-circuits its needsRefresh to true.
// vendor/three-0.184/three.webgpu.js:698
class ForestNodeMaterial extends MeshStandardNodeMaterial {
  setupObserver( builder ) {
    const base = super.setupObserver( builder );          // Three's own policy, kept as the fallback
    const seen = new WeakMap();                            // renderObject -> epoch last refreshed at
    let renderId = -1;
    return {
      needsRefresh( renderObject, nodeFrame ) {
        // A render object we have never seen must do the full first-time work: bind groups,
        // attribute creation, everything. (:150-164 registers it too.)
        if ( base.firstInitialization( renderObject ) ) return true;
        const ud = renderObject.object.userData;
        if ( ud.forestEpoch === undefined || FOREST_STATIC !== true ) {
          return base.needsRefresh( renderObject, nodeFrame );   // flag off / not a forest mesh
        }
        if ( base.hasAnimation || base.needsVelocity( nodeFrame.renderer ) ) return true;
        // One render object per material per render still refreshes, so this material's shared
        // render-group UBO (camera matrices, lights) is written. :703-709 does the same thing.
        if ( renderId !== nodeFrame.renderId ) { renderId = nodeFrame.renderId; return true; }
        if ( seen.get( renderObject ) !== ud.forestEpoch ) {
          seen.set( renderObject, ud.forestEpoch );
          return true;
        }
        return false;
      }
    };
  }
}
```

Notes on why each line is there, not decoration:

- **A subclass, not an own property on the instance.** `RenderObject.getMaterialCacheKey` walks
  `getKeys( material )`, which is `Object.keys( obj )` plus prototype-chain **getters only**
  (**[source]** `:29403-29428`, `:30091-30099`). A prototype method is invisible to it; assigning
  `mat.setupObserver = fn` would put a stringified function into every render object's cache key.
- **`firstInitialization` first.** **[source]** `:150-164` — it both answers and registers. Without
  it a render object created after the mesh went static would never create its bind groups
  (`Bindings.getForRender`, `:32389-32413`) or its attribute buffers (`Geometries.updateForRender`,
  `:30915`), and `backend.draw` would look up buffers that do not exist. See 01 §5.
- **`needsVelocity`.** **[source]** `:173-179` — if a pass ever writes a velocity MRT, per-object
  previous-frame matrices are required and nothing may be skipped.
- **The `renderId` gate.** **[source]** `:703-709` does exactly this in Three; it is needed here for
  the same reason. Each material owns its own `render`-group `NodeUniformsGroup` (**[source]**
  `:64346-64366` — `uniformGroups` is per-`NodeBuilder`), so at least one render object of each
  material must run `_bindings.updateForRender` each render or the camera matrices in *that*
  material's render UBO go stale. **[generated]** the render group of every forest role holds
  `cameraProjectionMatrix`, `cameraViewMatrix` and three more.
- **Epoch, not a boolean "dirty".** A bump must be honoured once per render object per pass — the
  same mesh appears in the main pass and the shadow pass as two different render objects
  (**[source]** `RenderObjects.get` keys on `(object, material, renderContext, lightsNode)` and a
  `passId` chain map, `:30399-30412`). A single boolean cleared by the first pass would leave the
  second pass stale. The `WeakMap<renderObject, epoch>` fixes that with no bookkeeping in
  `forest-gpu`.

### 2. The flag

`FOREST_STATIC` off by default, sourced the way the other forest experiment flags are — a
`createForestGPU` option threaded from `base-game-forest.js` (alongside `forestDrawMode`), plus a
URL override for A/B in one session. With it off, `needsRefresh` delegates to `base` on every call
and the behaviour is Three's, unchanged.

### 3. Invalidation events `forest-gpu.js` must raise

`let epoch = 0;` in the closure, `const invalidate = ( list = meshes ) => { epoch++; for ( const m of list ) m.userData.forestEpoch = epoch; };`
Meshes get `userData.forestEpoch = 0` in `drawMesh` next to the existing
`userData.slotOffset` write (**[source]** `forest-gpu.js:684`).

From 02 §D — the complete list:

| Event | Site | Scope |
|---|---|---|
| `setTreeScale` writes `uTreeScale.value` | `forest-gpu.js:1410` | all meshes; guard on value-changed |
| `setLeafScale` writes `uLeafScale.value` | `:1414` | all meshes; guard on value-changed |
| `setLeafSway` writes `uLeafSway.value` | `:1458` | all meshes; **must** guard on value-changed — `base-game-forest.js:597` calls it on every `syncRenderState` |
| `installVariant` — geometry swap | `:1344-1368` | that variant's 7-9 meshes (buffers for the new geometry are created inside the gate; `RenderObjects.get` only re-points, `:29873-29879`) |
| `installVariant` — `indirect[m].needsUpdate` | `:1348-1349`, `:1365-1366` | same meshes; the indirect attribute is reached only from that mesh's own `Geometries.updateAttributes` (`:31013-31019`) |
| `repackArenaVariant` / `uploadCounts` arena uploads | `:1049-1063` | the merged mesh only — pulled modes; not present in the shipped `variants` mode |
| any future direct write to a forest `material.<prop>` without `needsUpdate` | none found today | all meshes of that material — this is an audit obligation, see below |

Everything else is already safe and must **not** be wired to `invalidate`, because wiring it would
give the change away for nothing: the rebase and all the cull uniforms ride the ungated compute
path (`Bindings.updateForCompute`, **[source]** `:32450-32454`); `bindTreeMaterials` and the
double-sided toggles change `material.version` and go through `RenderObjects.get`'s
dispose-and-recreate (**[source]** `:30436-30448`); the rung gate, the mirror pass and the pulled
fallback only touch `visible`/`castShadow`; a palette rebake builds new meshes.

**The standing obligation, stated plainly:** this design makes "a forest material property is only
ever written together with `material.needsUpdate`" a rule the forest must keep. It is true today
(**[source]** the only `needsUpdate` writes are `forest-gpu.js:1290`, `:1421`, `:1429` and
`base-game-forest.js:138`, `:154-155`, and I found no bare property writes) but nothing enforces
it. The test in §4b is what enforces it going forward.

## 4. Tests

**(a) `test-forest-static-observer.mjs` — the decision table, in Node, no GPU.**
Build the observer from a real `ForestNodeMaterial` via the existing stub-renderer harness, then
drive `needsRefresh` with fake render objects. Rows:

| flag | object marked | render object | epoch | nodeFrame | expected |
|---|---|---|---|---|---|
| off | — | seen before | — | same render | `true` (delegates to base; node material) |
| on | no `forestEpoch` | seen before | — | same render | `true` (delegates to base) |
| on | yes | **first time** | 0 | any | `true` (firstInitialization) |
| on | yes | seen before, **first of this material this render** | 0 | new `renderId` | `true` |
| on | yes | seen before, second of this material this render | 0 | same `renderId` | **`false`** ← the whole point |
| on | yes | seen before | bumped to 1 | same `renderId` | `true` |
| on | yes | same object, **second pass** (a different renderObject) | bumped to 1 | same `renderId` | `true` (per-render-object epoch) |
| on | yes | seen before | 1, already served | same `renderId` | `false` |
| on | yes | seen before | 0 | renderer with a velocity MRT | `true` |
| on | yes | seen before | 0 | material `version` bumped | `true` — asserted at the `RenderObjects.get` level, not the observer's (see note) |

The last row is a *different* assertion: it must be written against `RenderObjects.get`'s
`renderObject.version !== material.version` → cache-key compare → `dispose()`+re-`get()` path
(**[source]** `:30436-30448`), because the observer never sees it. If that cannot be exercised
headlessly, the test should at minimum assert that `bindTreeMaterials` changes
`getMaterialCacheKey()` for the branch and leaf materials — that is the claim the design leans on.

**(b) `test-forest-object-group.mjs` — the object-group set is what 02 says.**
Promote `dump-forest-object-group.mjs` into an assertion: for each of the nine roles, the `object`
uniform group contains exactly the expected count and types (u32 slotOffset, the `mat3x3` normal
matrix, the `mat4x4` model world matrix, `uTreeScale`/`uLeafScale`, and N material scalars), and
`updateBeforeNodes`/`updateAfterNodes` are empty. This is the guard that catches "somebody added a
per-object uniform to the forest graph that changes every frame" — the failure mode that would make
the whole design wrong, silently, with a picture that only looks wrong while walking.

**(c)** `node test-page-syntax.mjs` before committing any `base-game.html` edit, per the standing
rule in this repo.

## 5. What the browser check would show, and what it would not

**The direct measurement is the refresh count, not milliseconds.** `render-trace.js` already
records it: **[source]** `render-trace.js:527-532` wraps `renderer._nodes.needsRefresh` and counts
`refreshChecks` (every call) and `refreshes` (calls that returned true), per scene, and
**[source]** `:519-525` times the six encode stages on the renderer's own manager instances.

Capture with `?trace=1`, plants on, flag off then on, and read
`context.render.trace.lastFrame.scenes[]` for the main `Scene`:

- **Today [capture]:** `refreshes` 217 of `refreshChecks` 217 (`base-game-performance-log.json`,
  entry `capturedAt 2026-09-08T02:15:04.551Z`; the 2026-09-10T02:47 `?trace=1` entries show the
  same 204-object / 217-refresh shape, against 94 objects / 107 refreshes with plants off).
- **Expected with the flag on [inferred]:** `refreshChecks` unchanged at 217; `refreshes` falls by
  (forest meshes present) − (distinct forest materials that take their one-per-render refresh).
  With the shipped 16 variants × 9 meshes that is 144 − ~9 ≈ **135 fewer**, i.e. ~82 of 217. The
  "~9" is a prediction, not a measurement: the observer is per *NodeBuilderState*, and whether the
  nine roles collapse to nine builder states depends on the cache key
  (**[source]** `:30091-30140` — `getMaterialCacheKey` folds in the geometry cache key; the forest
  meshes are plain `Mesh`, so the `object.uuid` clause at `:30181-30185` does not fire). **The
  capture is what settles the number.**
- **Stage times:** `bindingsMs` and `nodesRenderMs` should fall roughly in proportion to the refresh
  count; `pipelinesMs`, `drawMs` and `objects` must **not** change at all — if `drawMs` or the draw
  count moves, something is being skipped that should not be.

**No millisecond figure is promised here.** The earlier "9 ms" was an unvalidated upper-bound
projection: **[capture]** the main scene's `bindingsMs` is 5.0-10.9 ms and `nodesRenderMs`
1.7-4.3 ms across the saved frames, but those are totals over all 217 objects, and the trace does
not attribute them per object. What can be said before measuring is the shape: **[capture]** in one
retained frame the main scene did 217 refreshes but only **36 `backend.updateBinding` calls**
(`uniformWriteRows`, which is the **top 16 rows of that one retained frame, not a full-frame
count**, lists `render/nodeUniform44` ×4, `object/nodeUniform61` ×4, `object/nodeUniform8` ×4,
`object/nodeUniform6` ×2, `object/nodeUniform29` ×2, `render/nodeUniform1` ×1). **[inferred]** most
of the cost is the per-object *diff* in `UniformsGroup.update` (**[source]** `:62001-62022`) and the
bind-group walk in `Bindings._update` (`:32554-32697`), not upload bandwidth — which is the cost
this change removes.

**The visual checks the user would need to do**, one per invalidation event, flag on vs flag off:

1. Walk far enough for terrain streaming and the rung gate to churn — trees must keep appearing and
   disappearing at the same rings, with no frozen or missing rung.
2. Walk ~8 km so a render-origin rebase fires — trees must not jump or smear.
3. Move the **Tree scale**, **Leaf scale** and **Leaf sway** sliders — the change must take effect on
   the same frame it does with the flag off. (This is the event most likely to expose a missing
   `invalidate` and the one whose absence looks like "the slider does nothing".)
4. Let a progressive palette wave land during a fresh load — no black, untextured or zero-sized
   trees; watch for a variant whose LOD2 geometry is wrong.
5. Toggle **Tree leaves double-sided** and let the async tree texture set finish decoding — bark and
   leaf textures must appear.
6. Look at the shadows — the `barkShadow`/`leafShadow` meshes are separate render objects on layer 4
   and would fail independently.
7. A still frame side by side: the picture must be pixel-identical with the flag on and off. Any
   difference is a missing invalidation, not a tuning question.
