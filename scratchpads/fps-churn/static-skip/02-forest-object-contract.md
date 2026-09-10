# 02 — The forest mesh's per-object contract

Labels as in 01: **[source]** file:line, **[generated]** from the WGSL / binding layout the headless
builder emitted, **[capture]** from a saved trace, **[inferred]**.

Evidence generator: `scratchpads/fps-churn/static-skip/dump-forest-object-group.mjs`
(a copy of the stub renderer from `test-forest-pulled-wgsl.mjs` / `test-forest-leaf-shaders.mjs`).
Outputs in this folder: `forest-object-group.json` and `wgsl-forest_v0_<role>.vert.wgsl`.

Caveats stated up front: the harness imports `three/webgpu` from `node_modules` (the root
`three.webgpu.js`), which the task states is identical to `vendor/three-0.184/three.webgpu.js`
except for a light-uniform patch; the stub renderer has no device, so this is the builder's output,
not validated WGSL. It builds with 3 species × 2 variants = 6 variants (54 meshes) rather than the
shipped 8 species / 16 variants / 144 meshes — the per-mesh contract is per-variant and does not
change with the count. `drawMode: 'variants'`, which is the shipped default
(**[source]** `base-game-forest.js:428`, `BASE_GAME_FOREST_DEFAULTS.forestDrawMode`).

## A. What one forest mesh owns

**[generated]** For `forest:v0:branchesL0`, the emitted vertex shader's binding layout is:

```
bindings.vertex:   NodeStorageBuffer:StorageBuffer_0 @object
                   NodeUniformsGroup:object          @object
                   NodeUniformsGroup:render          @render
bindings.fragment: NodeUniformsGroup:object          @object
                   NodeSampler:nodeUniform15_sampler @object
                   NodeSampledTexture:nodeUniform15  @object
                   NodeUniformsGroup:render          @render
```

and the object group, verbatim from the generated WGSL:

```wgsl
struct objectStruct {
	nodeUniform1  : u32,          // slotOffset
	nodeUniform2  : f32,          // uTreeScale
	nodeUniform3  : f32,          // material scalar
	nodeUniform4  : f32,          // material scalar
	nodeUniform5  : f32,          // material scalar
	nodeUniform7  : mat3x3<f32>,  // normal matrix
	nodeUniform8  : vec3<f32>,    // material colour (emissive)
	nodeUniform9  : f32,          // material scalar
	nodeUniform14 : mat4x4<f32>   // model world matrix
}
struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix       : mat4x4<f32>,
	nodeUniform13          : vec3<f32>,
	nodeUniform11          : vec3<f32>,
	nodeUniform12          : vec3<f32>
}
```

The two identifications that matter are read straight out of the generated body, not guessed:

```wgsl
nodeVar0 = ( ( object.nodeUniform1 + instanceIndex ) * 2u );          // slotOffset
nodeVar3 = ( NodeBuffer_913.value[ nodeVar0 ].w * object.nodeUniform2 ); // uTreeScale
modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform14 );   // model world matrix
varyings.v_normalViewGeometry = normalize( ( render.cameraViewMatrix * vec4<f32>( ( object.nodeUniform7 * normalLocal ), 0.0 ) ).xyz );
```

**[generated]** Answering the reviewer's "no model-view work" question directly: there is **no
`modelViewMatrix` uniform and no `modelViewProjection` uniform**. `modelViewMatrix` is a
`var<private>` computed in the shader body from `render.cameraViewMatrix * object.nodeUniform14`.
The per-object model-view state is therefore exactly two entries — the `mat4x4` world matrix and
the `mat3x3` normal matrix — and both are re-derived by the `ModelNode` in `_nodes.updateForRender`
(01 §3). The camera matrices live in the **shared `render` group**, updated once per render
regardless.

**[generated]** The forest's own cull uniforms (`uCam`, `uCamFwd`, `uFovCos`, `uLodR0/1/2`,
`uMaxDrawRadius`, `uConeMargin`, `uShadowReach`) do **not** appear in any render object group — they
are read only by the compute kernels. The only forest slider uniform that reaches the draw graph in
this role is `uTreeScale` (`uLeafScale`/`uLeafSway` in the leaf roles). This settles the open
question a source-only read could not.

**[generated]** `updateBeforeNodes` and `updateAfterNodes` are empty for all nine roles.
`updateNodes` is 15-16 entries; the OBJECT-typed ones are
`UniformGroupNode('object')`, `UserDataNode` (slotOffset), `ModelNode`, one `UniformNode` (the
normal matrix) and 5-6 `MaterialReferenceNode`s. The rest are RENDER- or FRAME-typed and deduped.

## B. Meshes sharing a material are not interchangeable

**[generated]** `forest-object-group.json` → `sharedMaterialPairs`:

| role | same material object? | slotOffset v0 | slotOffset v1 | same geometry? |
|---|---|---|---|---|
| branchesL0 | **yes** | 0 | 64 | no |
| leavesL0 | **yes** | 0 | 64 | no |
| branchesL2 | **yes** | 32 | 96 | no |

**[generated]** and within variant 0 the nine roles carry slotOffsets 0, 0, 0, 16, 16, 32, 32, 48,
48 — i.e. the L0/L1/L2/shadow rung base. So the material is shared and the object group is not:
`nodeUniform1` is private per mesh. **[source]** `forest-gpu.js:684`
(`mesh.userData.slotOffset = slotOffset`) inside `drawMesh`. **[source]** repo-wide there are only
two writes to `userData.slotOffset` — `forest-gpu.js:684` and `:825` (billboards, disabled in Base
Game: `billboards: false`, `base-game-forest.js:426`) — and `drawMesh` is called only from the
construction loop `forest-gpu.js:806-836`. `installVariant` (`:1330-1375`) replaces geometry but
never re-calls `drawMesh`. **So `slotOffset` is written once per mesh, ever, and never changes.**

## C. Event table — what can change, and whether Three catches it without a refresh

"Caught anyway" means: caught by machinery that runs **before** the `needsRefresh` gate, or by
another object/dispatch that does refresh. See 01 §5 and 01 §2.

| # | Event | Cadence | What changes | Caught without a per-object refresh? |
|---|---|---|---|---|
| 1 | `userData.slotOffset` | **never after construction** ([source] `forest-gpu.js:684`) | `object.nodeUniform1` | n/a — it cannot change |
| 2 | Mesh transform | **never** — `drawMesh` sets no position/quaternion/scale; [source] `base-game.html:3725` comments that the tree meshes sit at the render origin and never move; the rebase shifts `traversalLab.root`/`spawnBuilding.root`/`structures.root`/`roads.group` only ([source] `base-game.html:3387-3399`) | `nodeUniform14`, `nodeUniform7` | n/a — it cannot change |
| 3 | **Render-origin rebase** | rare (~every 8 km; [source] `world-coordinates.js:115`, called `base-game.html:6819`) | **No uniform.** The origin is baked into the source records on the CPU: [source] `forest-gpu.js:1161` `Math.fround(r.x - originX)`, then `srcAttr.needsUpdate` `:1204` and `countsAttr.needsUpdate` `:1206` | **Yes, via compute.** `srcAttr`/`countsAttr` are bound only by the cull kernels ([generated] the render vertex stage binds exactly one storage buffer, the *draw* buffer), and `Bindings.updateForCompute` is ungated ([source] `:32450-32454`) |
| 4 | LOD radii, cone/frustum, max draw radius, shadow reach, camera pose | per slider / per recull ([source] `forest-gpu.js:1494-1500`, `:1561-1563`, `:1583-1592`) | **compute-only uniforms** — [generated] absent from every render object group | **Yes** — updated on the ungated compute path |
| 5 | `uTreeScale` / `uLeafScale` / `uLeafSway` | per slider, and `setLeafSway` runs on every `syncRenderState` ([source] `forest-gpu.js:1410`, `:1414`, `:1458`, `base-game-forest.js:597`) | `object.nodeUniform2` (and the leaf equivalents) — a **shared `uniform()` node whose value lands in every mesh's own UBO** | **NO.** Nothing bumps `material.version`; the only path that copies `.value` into the object UBO is `_nodes.updateForRender` + `_bindings.updateForRender`. **Must be an explicit invalidation.** |
| 6 | Material scalars via `MaterialReferenceNode` (roughness, metalness, opacity, emissive, alphaTest) | whenever anything writes `material.<prop>` | `nodeUniform3/4/5/8/9` | **NO**, unless the writer also sets `material.needsUpdate` *and* the cache key changes. A bare property write is invisible to `RenderObjects.get`. **Must be an explicit invalidation** (or an audit that nothing writes them) |
| 7 | `bindTreeMaterials` texture bind | twice per session: at build and when the async texture set decodes ([source] `base-game-forest.js:433`, `:305`) | Mutates the **existing** materials in place — assigns `map`/`normalMap`/`colorNode`/`normalNode`/`alphaTest`, then `branchMat.needsUpdate = true` / `leafMat.needsUpdate = true` ([source] `base-game-forest.js:138`, `:154-155`) | **Yes.** `material.version` changes → [source] `:30436` `renderObject.version !== material.version` → cache key compare at `:30438`; assigning a new `colorNode` changes `getMaterialCacheKey` ([source] `:30091-30140`) → `dispose()` + re-`get()` → new render object → `firstInitialization` true |
| 8 | Leaf double-sided toggle / `setFarLeavesDoubleSided` / `applyBillboardMap` | rare, user toggle ([source] `forest-gpu.js:1290`, `:1421`, `:1429`) | `material.side`, `material.needsUpdate` | **Yes**, same path as #7 (`side` is in the cache key) |
| 9 | **`installVariant` geometry swap** | rare, progressive palette waves ([source] `forest-gpu.js:1344-1368`) | `mesh.geometry` replaced; `geometryPool.release(old)` | **Partly.** `RenderObjects.get` notices via `needsGeometryUpdate` and calls `setGeometry` ([source] `:30430-30432`) — but `setGeometry` only re-points ([source] `:29873-29879`); the **new geometry's buffers are created in `_geometries.updateForRender`**, which is inside the gate. **Must be an explicit invalidation.** (In Base Game's flow these meshes are not yet in the scene when this runs — [source] `base-game-forest.js:455` installs before `:490` adds — so it is build-time today, but that is a flow property, not a guarantee) |
| 10 | `indirect[m].array[0] = …; indirect[m].needsUpdate = true` | same event as #9 ([source] `forest-gpu.js:1348-1349`, `:1365-1366`) | the per-mesh `IndirectStorageBufferAttribute` | **NO** — the indirect attribute is reached only through `Geometries.updateAttributes` ([source] `:31013-31019`), i.e. only from that mesh's own gated call. **Must be an explicit invalidation.** |
| 11 | Arena buffer uploads (`arenaVertAttr`/`arenaIdxAttr`/`arenaCountAttr`) | rare, pulled modes only ([source] `forest-gpu.js:1049-1063`) | shared storage buffers read by the **merged** mesh's vertex stage | **NO** for the merged mesh if it were static; they are also bound by compute in the compact mode but not in all modes. Not a concern for the shipped `variants` mode — no merged mesh exists |
| 12 | Rung gate / residency gate | per recull, i.e. every walking frame ([source] `forest-gpu.js:1093`, `:1099`, `:1104-1110`) | `mesh.visible` and `mesh.castShadow` only — no counts, draw ranges, instanceCount or indirect offsets ([source] the comments at `:958-961`, `:1176-1181` say so and the code matches) | **Yes** — visibility is a render-list decision made before any of this |
| 13 | Water-mirror pass hide/restore | per mirror frame ([source] `water.js:690-697`, exclusions registered `base-game.html:3718-3724`) | `mesh.visible` twice | **Yes**, same reason as #12 |
| 14 | Palette rebake | rare, explicit setting change ([source] `base-game-forest.js:701`, `forest-gpu.js:1680-1701`) | everything disposed, **new meshes and new materials** | **Yes** — new objects, `firstInitialization` true |
| 15 | `pulledActive` flip on a device error | rare ([source] `forest-gpu.js:898-922`) | `mergedMesh.visible = false` + stops dispatching merged kernels | **Yes** — visibility only |
| 16 | Draw buffer (`drawAttr`) contents | every cull dispatch | GPU-written; the CPU never bumps its version, so `Attributes.update` no-ops after creation ([source] `:30716-30734`) | **Yes** — nothing to upload |
| 17 | Texture object swapped behind a binding without a version/cache-key change | not observed in the forest code | `binding.generation` compare in `Bindings._update` ([source] `:32615-32622`) | **NO** for a skipped object; not currently triggered by anything in `forest-gpu.js`/`base-game-forest.js` |
| 17b | `drawRange` / `instanceCount` / `geometry.groups` | never in the forest ([source] `shared-draw-geometry.js:33-34` sets them once) | draw counts | **Yes** — `backend.draw` re-derives them every call via `getDrawParameters` ([source] `three.webgpu.js:29951`), outside the gate |
| 18 | Lights (`DirectionalLightNode`, FRAME-typed) | per frame | shared `render`-group uniforms | **Yes** — FRAME/RENDER dedupe means whichever object refreshes first does it, and 60+ non-forest objects refresh every frame ([capture] 94 objects with plants off) |

## D. The short list

Events that **would need an explicit "un-static for a frame"** from `forest-gpu.js`:

- **#5** any write to `uTreeScale.value` / `uLeafScale.value` / `uLeafSway.value`
  (`setTreeScale`, `setLeafScale`, `setLeafSway` — note `setLeafSway` is called on every
  `syncRenderState`, so this is not rare in practice and needs a value-changed guard).
- **#6** any direct write to a forest material property that a `MaterialReferenceNode` reads,
  without `needsUpdate`. I found none in `forest-gpu.js` or `base-game-forest.js`; this is an
  audit obligation, not a known writer.
- **#9 + #10** `installVariant` — geometry swap and the indirect upload that goes with it.
- **#11** the arena uploads, if the pulled modes are ever made static (they are a separate mesh).

Everything else on the table is either impossible (1, 2), already carried by the ungated compute
path (3, 4, 16), already carried by `RenderObjects.get` before the gate (7, 8, 14), or a pure
visibility decision (12, 13, 15).
