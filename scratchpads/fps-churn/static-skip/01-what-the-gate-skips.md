# 01 — What the `needsRefresh` gate actually skips

All line numbers are into `vendor/three-0.184/three.webgpu.js` unless another file is named.
Every claim is labelled: **[source]** = read out of that file, **[generated]** = read out of the
WGSL / binding layout this repo's headless builder emitted, **[capture]** = read out of a saved
trace, **[inferred]** = reasoning on top of the other three.

## 0. The gate

**[source :61312-61356]** `Renderer._renderObjectDirect`:

```js
const renderObject = this._objects.get( object, material, scene, camera, lightsNode, ... );  // :61314 — ALWAYS
renderObject.drawRange = object.geometry.drawRange;                                          // :61315 — ALWAYS
const needsRefresh = this._nodes.needsRefresh( renderObject );                               // :61330
if ( needsRefresh ) {
    this._nodes.updateBefore( renderObject );        // :61334
    this._geometries.updateForRender( renderObject ); // :61336
    this._nodes.updateForRender( renderObject );      // :61338
    this._bindings.updateForRender( renderObject );   // :61339
}
this._pipelines.updateForRender( renderObject );      // :61343 — ALWAYS
if ( this._pipelines.isReady( renderObject ) ) {
    this.backend.draw( renderObject, this.info );     // :61349 — ALWAYS
    if ( needsRefresh ) this._nodes.updateAfter( renderObject ); // :61351
}
```

### 0a. Why `object.static` is unreachable for a node material

**[source :55129-55136]** `Nodes.needsRefresh( renderObject )` fetches the NodeFrame for the render
and `renderObject.getMonitor()`, then returns `monitor.needsRefresh( renderObject, nodeFrame )`.

**[source :29786-29790]** `getMonitor()` returns `this.getNodeBuilderState().observer` — so the
observer is **shared by every render object that resolves to the same builder state** (i.e. per
material+pass+context), not per object. **[source :21260]** the observer is created in
`NodeMaterial.setup` via `builder.observer = this.setupObserver( builder )`, and **[source
:21114-21118]** `setupObserver( builder ) { return new NodeMaterialObserver( builder ); }` — an
ordinary, overridable material method. **[source :48444, :54650, :55134]** the only thing anything
in the build ever calls on that object is `needsRefresh( renderObject, nodeFrame )`.

**[source :696-724]** `NodeMaterialObserver.needsRefresh`, in order:

```js
if ( this.hasNode || this.hasAnimation || this.firstInitialization( renderObject ) || this.needsVelocity( nodeFrame.renderer ) )
    return true;                       // :698-699
const { renderId } = nodeFrame;
if ( this.renderId !== renderId ) { this.renderId = renderId; return true; }   // :703-709
const isStatic = renderObject.object.static === true;                          // :711
const isBundle = ...;                                                          // :712
if ( isStatic || isBundle ) return false;                                      // :714-715
... this.equals( renderObject, lightsData, renderId ) ...                      // :717-720
```

**[source :262-281]** `containsNode( builder )` returns `true` if **any** material property is a
node (`material[property].isNode`), or if the builder context carries `modelViewMatrix`,
`modelNormalViewMatrix`, `getAO` or `getShadow`. `this.hasNode = this.containsNode( builder )` is
set in the constructor. Every forest material has `positionNode` (and most have `colorNode`), so
`hasNode` is `true` and `needsRefresh` returns at :699 — the `renderId` short-circuit at :703 and
the `static` check at :711 are dead code for it. **[capture]** the traces agree: main scene
`refreshes === refreshChecks` in every saved frame (217/217 with plants on, 107/107 with plants
off — `research/stats/base-game-performance-log.json`, `context.render.trace.lastFrame.scenes[]`).

Note the ordering consequence, which matters for the design in 03: `firstInitialization` is *part
of* the `hasNode` disjunction, and `renderId` is checked **after** it. In a variant where `hasNode`
no longer forces `true`, a material still gets exactly one guaranteed refresh per render (the first
render object to reach :703 sets `this.renderId`), because the observer is shared per material.

**[source :119, :126]** `this.hasNode = this.containsNode( builder )`; `this.hasAnimation =
builder.object.isSkinnedMesh === true` — a skinned mesh is always refreshed. **[source :133 and the
module-level list at :9-64]** `refreshUniforms` is 56 *classic* material property names
(`alphaMap … transmissionMap`); it is what `getMaterialData` snapshots inside `equals()`, and it is
independent of the `hasNode` test.

**[source :150-164]** `firstInitialization` returns `true` the first time a given `renderObject` is
seen (it is a `WeakMap`-backed set, `this.renderObjects`), and populates the per-render-object
monitoring record.

**[source :335-361]** `getRenderObjectData` snapshots `geometry.id`, `object.matrixWorld.clone()`,
`object.center`, `morphTargetInfluences`, bundle version, transmission buffer size, and lights data.

**[source :607-624]** `equals()` — the branch a non-node material takes — compares world matrix
(:614-621), material properties **once per material per render** (`materialData._renderId`, :630),
geometry id / attribute ids+versions / index id+version / drawRange **once per geometry per render**
(:667-716), morph influences, spot-light maps, and `object.center`.

## 1. `_nodes.updateBefore( renderObject )` — and `updateAfter`

**[source :55051-55063]** iterates `renderObject.getNodeBuilderState().updateBeforeNodes` and calls
`NodeFrame.updateBeforeNode( node )` on each.

**[source :53066-53095]** `NodeFrame.updateBeforeNode` reads `node.getUpdateBeforeType()` and
`node.updateReference( this )`, then dedupes:
- `FRAME` → runs at most once per `frameId` (`updateBeforeMap` keyed by the node's *reference*);
- `RENDER` → at most once per `renderId`;
- `OBJECT` → **no dedupe at all**, `node.updateBefore( this )` runs every call.
A node returning `false` from `updateBefore` rolls the recorded id back so it runs again next call
(:53076-53080).

**[source :55071-55083 / :53123-53150]** `updateAfter` is the mirror image over `updateAfterNodes`.

**[generated]** For every one of the nine forest roles, `builder.updateBeforeNodes` and
`builder.updateAfterNodes` are **empty**. (Dumped by
`scratchpads/fps-churn/static-skip/dump-forest-object-group.mjs`; see
`forest-object-group.json` → `roles[].updateBeforeNodes` / `updateAfterNodes`.) So for the forest
these two calls are a no-op loop plus the call and `getNodeFrameForRender` overhead. **[capture]**
the trace still bills 0.3-0.9 ms of `nodesBeforeMs` across ~217 objects, which is that overhead
(and other objects' real updateBefore nodes) — the per-object split is not measured.

## 2. `_geometries.updateForRender( renderObject )`

**[source :30915-30922]** `updateForRender` = `if ( this.has( renderObject ) === false ) this.initGeometry( renderObject ); this.updateAttributes( renderObject );`

**[source :30902-30908]** `has()` is `super.has( geometry ) && this.get( geometry ).initialized === true` — keyed on the **geometry**, not the render object.

**[source :30928-30976]** `initGeometry` sets `initialized`, bumps `info.memory.geometries`, and
registers a `dispose` listener that deletes the geometry's attributes from `Attributes`.

**[source :30983-31023]** `updateAttributes( renderObject )` walks, in order:
- every attribute from `renderObject.getAttributes()` → `updateAttribute(attr, STORAGE)` if
  `isStorageBufferAttribute || isStorageInstancedBufferAttribute`, else `VERTEX` (:30989-30999);
- `this.getIndex( renderObject )` → `updateAttribute(index, INDEX)` (:31003-31009);
- `renderObject.geometry.indirect` → `updateAttribute(indirect, INDIRECT)` (:31013-31019).
Morph targets are **not** handled here in this build (no morph branch in `Geometries`).

**[source :31031-31063]** `updateAttribute( attribute, type )` dedupes per **pass** via a
`WeakMap` keyed on the attribute (`attributeCall`, :30884) against `this.info.render.calls` — and
**[source :59289]** `info.render.calls` increments once per `render()` pass, not per draw. So an
attribute shared by several render objects is offered to `Attributes` once per pass, by whichever
object reaches it first.

**[source :30695-30737]** `Attributes.update( attribute, type )` is the actual upload decision, and
it is **keyed on the attribute, not on the object**:
```js
const data = this.get( attribute );
if ( data.version === undefined ) { backend.create*Attribute( attribute ); data.version = bufferAttribute.version; }
else if ( data.version < bufferAttribute.version || bufferAttribute.usage === DynamicDrawUsage ) {
    this.backend.updateAttribute( attribute );  // :30729
    data.version = bufferAttribute.version;
}
```

### The cross-object question the reviewer asked

**[source, :30695-30737 + :31031-31063]** *Yes* — if a `BufferAttribute` has `needsUpdate = true`
(which bumps `.version`, `three.core.js` `BufferAttribute.needsUpdate` setter) and the object that
owns it is skipped by the gate, **any other render object in the same frame whose geometry or
bindings reference the same attribute object will upload it**, because the staleness test is
`this.get(attribute).version < bufferAttribute.version` on the shared `Attributes` DataMap. The
version is not consumed anywhere else. Concretely the two paths that reach `Attributes.update` are:
- `Geometries.updateAttributes` (:30989/:31005/:31015), reached only from the gated
  `_geometries.updateForRender`;
- `Bindings._init` (:32524-32534) and `Bindings._update` (:32571-32588) for `isStorageBuffer`
  bindings, reached from the gated `_bindings.updateForRender` **and** from the *ungated*
  `Bindings.updateForCompute` (:32450-32454) that every compute dispatch runs.

**[inferred]** Therefore: an attribute referenced *only* by objects that are all skipped is never
uploaded. An attribute also bound by a compute node that dispatches that frame is still uploaded
via the compute path — subject to the `updateGroup` gate in §4.

**[source]** Textures are different: a `Texture` whose `version` was bumped is re-uploaded from
`Bindings._update` (:32615-32622, `this.textures.updateTexture( texture )`) — also inside the gate.
`Textures` is keyed on the texture, so again *some* refreshing object that binds it will do the
work; if none does, it does not happen.

## 3. `_nodes.updateForRender( renderObject )`

**[source :55110-55122]** iterates `renderObject.getNodeBuilderState().updateNodes` and calls
`NodeFrame.updateNode( node )` on each.

**[source :53172-53199]** `NodeFrame.updateNode` — same three-way dedupe as `updateBeforeNode`:
`FRAME` once per `frameId`, `RENDER` once per `renderId`, `OBJECT` **every call, no dedupe**. The
dedupe key is `node.updateReference( this )`, i.e. for reference-style nodes the *referenced
object*, not the node.

**[generated]** `updateNodes` for `forest:v0:branchesL0` (15 entries; the other roles differ only in
the count of `MaterialReferenceNode`s — 15 or 16):

| node | update type | what its `update()` does |
|---|---|---|
| `UniformGroupNode('object')` | OBJECT | **[source :5266-5270]** `update() { this.needsUpdate = true; }` → `Node.needsUpdate` setter bumps `version`. This is the flag `Bindings` reads to decide the object UBO is dirty (§4). |
| `UserDataNode` | OBJECT | **[source]** `UserDataNode extends ReferenceNode`; `updateReference()` re-points at `object.userData`, `update()` → `updateValue()` writes `mesh.userData.slotOffset` into its uniform's `.value`. This is the `slotOffset` path. |
| `ModelNode` | OBJECT | reads `object.matrixWorld` (and the normal matrix) into the object-group `mat4x4`/`mat3x3` uniforms. |
| `UniformNode` (normalMatrix, mat3) | OBJECT | re-derives from the object. |
| 5-6 × `MaterialReferenceNode` | OBJECT | re-read one property off `material` into its uniform (roughness, metalness, opacity, emissive, alphaTest…). **These do not require `material.version` to change.** |
| `UniformNode('cameraProjectionMatrix')`, `UniformNode('cameraViewMatrix')`, `UniformGroupNode('render')`, 2 × `UniformNode` | RENDER | deduped per render — the first refreshing object in the render pays, everyone else no-ops. |
| `DirectionalLightNode` | FRAME | deduped per frame. |

**[inferred]** So the *per-object* work in `_nodes.updateForRender` for a forest mesh is: bump the
object group version, re-read `userData.slotOffset`, re-read `matrixWorld`, re-read ~6 material
scalars. The RENDER/FRAME entries cost a map lookup each after the first object.

## 4. `_bindings.updateForRender( renderObject )`

**[source :32461-32465]** `updateForRender` = `this._updateBindings( this.getForRender( renderObject ) )`.

**[source :32389-32413]** `getForRender` calls `renderObject.getBindings()` and, for any bind group
not yet created, runs `_init( bindGroup )` and `backend.createBindings(...)`.
**[source :29797-29801]** `renderObject.getBindings()` is memoised per render object
(`this._bindings || ( this._bindings = this.getNodeBuilderState().createBindings() )`), and
**[source :48462-48489]** `NodeBuilderState.createBindings` **clones** every binding of a
non-shared group into a fresh `BindGroup` while pushing shared groups by reference
(`instanceGroup.bindings[0].groupNode.shared`). So each render object owns its own `object` group
even when it shares a material, and all of them share one `render` group per material.

**[source :32523-32547]** `_init` uploads sampled textures (`textures.updateTexture`), samplers, and
storage-buffer attributes (`attributes.update`) once, at group creation.

**[source :32554-32697]** `_update( bindGroup, bindings )` per binding:
1. **[source :32567]** `const updatedGroup = this.nodes.updateGroup( binding ); if ( updatedGroup === false ) continue;`
   **[source :54280-54303]** `Nodes.updateGroup` looks up `(groupNode, nodeUniformsGroup)` in
   `this.groupsData` and returns `true` only when `groupData.version !== groupNode.version`.
   **This `continue` skips everything below for that binding** — including the storage attribute
   update and the texture generation check, not just the UBO write.
   Confirmed by running it: `scratchpads/fps-churn/static-skip/probe-updategroup.mjs` prints
   `call1 true / call2 false / after objectGroup.update() true / call4 false`. So the object group
   is only reported dirty because `UniformGroupNode('object').update()` ran during
   `_nodes.updateForRender` — skip that and the binding is `continue`d for free.

   **A correction worth recording, because a source-only read gets this wrong.** Grepping the
   bundle for callers of `UniformGroupNode.update()` (:5266-5270) finds none, which reads as "the
   object UBO is only ever written once, in r184". That reading is wrong. The group node is *built
   into the graph*, so `NodeBuilder.buildUpdateNodes` (**[source]** :50423-50455) picks it up by its
   `getUpdateType() === 'object'` and puts it in `builder.updateNodes` — **[generated]** it is
   literally the first entry of `updateNodes` for every forest role in `forest-object-group.json`.
   `NodeFrame.updateNode` then calls `update()` on it once per object with no dedupe (:53211).
   **[from a probe]** `scratchpads/fps-churn/static-skip/probe-objectgroup-version.mjs` builds a
   plain `MeshStandardNodeMaterial` with the shipped `WebGPUBackend` builder and prints:

   ```
   updateNodes: 15 entries
   uniform GROUP nodes among them: render[render] v=0, object[object] v=0
   after three objects in one render: render v=0, object v=3
   updateGroup right now: true
   updateGroup again, no update in between: false
   updateGroup after one more object update: true
   ```

   So the group nodes *are* in `updateNodes`; `object` rises once per object, `render` holds still
   within one `renderId`, and `updateGroup` tracks it exactly. The object group is dirty once per
   object per pass **because `_nodes.updateForRender` made it so** — which is exactly why skipping
   that call also makes `_bindings` cheap. (This also means `test-grass-uniform-groups.mjs`, which
   feeds the group nodes through `NodeFrame.updateNode` by hand, is modelling the real path, and the
   `updateGroup` description in `docs/subsystems/vegetation.md:1986-2010` stands.)
2. **[source :32571-32588]** `isStorageBuffer` → `this.attributes.update( attribute, STORAGE|INDIRECT )`,
   and if the binding's attribute object was swapped, flag `needsBindingsUpdate`.
3. **[source :32592-32598]** `isUniformBuffer` → `const updated = binding.update(); if ( updated ) backend.updateBinding( binding );`
   **[source :62001-62022]** `UniformsGroup.update()` walks **every uniform in the group** and calls
   `updateByType` (:62026-62036) → `updateNumber` / `updateVector*` / `updateColor` / `updateMatrix*`,
   each of which compares the live value component-by-component against the group's cached
   `Float32Array` and only writes (and records an update range) on a real difference. So the write
   is value-diffed; the **diff itself is the unconditional per-object cost**.
4. **[source :32600-32675]** `isSampledTexture` → `binding.update()`, then `textures.updateTexture`
   on a version change, and a `binding.generation !== texturesTextureData.generation` compare that
   sets `needsBindingsUpdate` (i.e. re-create the bind group when the binding now points at a
   different GPU texture object).
5. **[source :32677-32692]** `isSampler` → sampler key compare, same `needsBindingsUpdate` effect.
6. **[source :32700-32704]** if anything set `needsBindingsUpdate`, `backend.updateBindings(...)`.

**[capture]** In `base-game-performance-log.json` the main scene of one retained frame reports
`bindingsMs` 5.0-10.9 ms against only **36 `bindingWrites`** (and in another retained frame, 127
writes / 296 KB). `uniformWriteRows` for that frame — **the top 16 rows of ONE retained frame, not
a full-frame count** — lists `render/nodeUniform44` ×4, `object/nodeUniform61` ×4,
`object/nodeUniform8` ×4, `object/nodeUniform6` ×2, `object/nodeUniform29` ×2,
`render/nodeUniform1` ×1. **[inferred]** the great majority of the 217 object UBOs were diffed and
found unchanged: the milliseconds are the check, not the upload.

## 5. What still runs when the gate skips

**[source :61314]** `RenderObjects.get(...)` runs **before** the gate, unconditionally, and it is
not a pure lookup — **[source :30430-30448]**:
- `if ( renderObject.needsGeometryUpdate ) renderObject.setGeometry( object.geometry );`
  (**[source :30203-30222]** compares `this.geometry.id !== this.object.geometry.id` and each cached
  attribute id) — so a **geometry swap on a live mesh is noticed here regardless of the gate**.
  **[source :29873-29879]** `setGeometry` only re-points and clears the attribute cache; it does
  **not** upload anything.
- `if ( renderObject.version !== material.version || renderObject.needsUpdate )` → compare
  `initialCacheKey` against `getCacheKey()`; on a mismatch, `dispose()` and re-`get()`, which makes
  a brand-new render object and therefore a `firstInitialization === true` on the next
  `needsRefresh`. So a **`material.needsUpdate` that changes the cache key is caught regardless of
  the gate**; one that does not change the cache key only updates `renderObject.version`.

**[source :61343]** `_pipelines.updateForRender` (:32148) → `getForRender` (:31977), which does
real work only when `_needsRenderUpdate` (:32305-32311) → `backend.needsRenderUpdate`. **[source
:81718-81780]** that compares material identity and `material.version`, blending, colour/depth/
stencil write and func, side, alphaToCoverage, sample count, colour space and format, depth-stencil
format, primitive topology and the clipping cache key — **no uniform value, no attribute version,
no texture**. On a steady frame it returns `false` and the cached pipeline is reused.
**[capture]** `pipelinesMs` 0.2-0.6 ms for 217 objects.

**[source :61349]** `backend.draw( renderObject, this.info )` → `_draw` (:81411) — sets the
pipeline, sets the bind groups the render object already owns (by id identity, :81430), binds
index/vertex buffers by looking up `backend.get(attribute).buffer` (:81463-81469), and issues the
(indirect) draw. The one thing it *does* recompute per call is
`renderObject.getDrawParameters()` (**[source :29951]**), which re-derives vertex/instance counts
from geometry, `drawRange`, `group` and `object.count` every time — so a changed draw range or
instance count is honoured even for an object the gate skipped. It reads GPU buffers that
`Attributes`/`Bindings` created; it never creates or uploads them. **[inferred]** — this is the
reason a skipped object whose buffers were never created would fail rather than draw stale: the
buffer lookup would come back undefined.

## 6. Summary of the risk surface

Skipping the four calls for one object loses exactly:
1. the object-group version bump and therefore the object UBO diff/write (`slotOffset`,
   `modelWorldMatrix`, `normalMatrix`, the material scalars) — §3 + §4;
2. that object's contribution to uploading any attribute/texture it references — §2, and only
   matters if **no** other object or compute dispatch references the same attribute — §2;
3. the per-object bind-group re-creation when a texture object behind a binding changes — §4.4;
4. nothing in `updateBefore`/`updateAfter` for the forest specifically — §1 **[generated]**.

It does **not** lose: geometry-swap detection, material-cache-key invalidation, pipeline
resolution, or the draw — §5.
