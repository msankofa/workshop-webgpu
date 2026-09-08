# Binding / uniform ownership inventory — Base Game, Three r0.184

Agent D, 2026-09-07. Read-only. No browser driven, no capture taken, nothing edited.
Build read: `node_modules/three/build/three.webgpu.js` (r0.184.0, same as the CDN import at
`base-game.html:86`) and `three.core.js`. Labels: **[code-read]**, **[measured]** (a number from a
run or a grep count), **[hypothesis]**.

## 0. Mechanism, in the order the frame uses it

[code-read] Per RenderObject, per pass, `Renderer._renderObjectDirect` runs
`Nodes.updateBefore` → `Nodes.updateForRender` (55082-55093) → `Bindings.updateForRender`
(32461) → `_updateBindings` (32508) → `_update` per bind group (32554) → `Pipelines.getForRender`
(31976) → `backend.draw`.

Four gates decide whether work actually happens:

1. **`NodeFrame` update-type dedup** (53039-53184). `FRAME`/`RENDER` nodes run once per
   `frameId`/`renderId`, memoised in a WeakMap keyed on `node.updateReference(frame)`. `OBJECT`
   nodes call `node.update(frame)` unconditionally, once per RenderObject (53178-53182).
2. **`NodeManager.updateGroup`** (54252-54275). Keyed on `[groupNode, nodeUniformsGroup]`; returns
   `true` only when `groupNode.version` changed. `frameGroup`/`renderGroup`/`objectGroup` are
   module singletons (5331/5339/5347). `UniformGroupNode.update()` (5265) sets `needsUpdate`, which
   bumps `version`; the group node is itself in `updateNodes` (50396-50406) with the group's own
   update type, so `objectGroup`'s version advances once per RenderObject and `updateGroup` returns
   `true` for every object-scope binding on every object, while `renderGroup`'s advances once per
   pass.
3. **`UniformsGroup.update()` per-uniform value diff** (61973-62160). `updateNumber`,
   `updateVector2/3/4`, `updateColor`, `updateMatrix3/4` each compare against a JS shadow copy
   (`this.values`, `Array.from(this.buffer)`) and only then write the CPU buffer and push an
   `updateRange`. `update()` returns `false` when nothing changed, so `backend.updateBinding` is
   not called at all (32595-32601).
4. **`backend.updateBinding`** (78231-78280). Zero ranges = one whole-buffer `writeBuffer`; N
   ranges = **N separate `writeBuffer` calls, no coalescing of adjacent ranges**.

One more structural fact that drives most of section 2:

[code-read] `NodeBuilderState.createBindings()` (48435-48464): bind groups whose `groupNode.shared`
is `true` (`frameGroup`, `renderGroup`) are pushed **by reference** and therefore shared by every
RenderObject built from that node-builder state. Groups with `shared === false` (`objectGroup` —
5347 constructs it with `uniformGroup(...)`, not `sharedUniformGroup(...)`) are **cloned per
RenderObject** (48450). `Binding.clone()` (61474) is `Object.assign(new this.constructor(), this)`
— shallow. So each clone keeps its own lazily-built `_buffer` and `_values` shadow and its own GPU
buffer, while sharing the `uniforms` array (and therefore the same underlying `UniformNode.value`
objects) with every other clone.

Consequence: a value that lives in `objectGroup` is diffed and, when it changes, uploaded **once
per RenderObject that uses that material**, even when all those RenderObjects read the identical
JS value.

## 1. Data inventory for one Base Game frame

Frequency column is per pass unless stated. "Shared" means one GPU buffer for all RenderObjects
that use the same node-builder state; "cloned" means one buffer per RenderObject.

| Datum | Owner / producer | Consumers | Group | Update freq | Invalidation | Sharing | Disposal |
|---|---|---|---|---|---|---|---|
| `time`, `deltaTime`, `frameId` | `NodeFrame` (36541-36557) | any TSL graph | renderGroup | once/pass | renderId | shared | with node-builder state |
| camera near/far, projection, view, world, normal matrices, position, viewport (13906-14243) | `Renderer` sets `frame.camera` | all materials | renderGroup | once/pass | renderId | shared | with state |
| background blurriness / intensity / rotation (38419-38443) | scene | background node | renderGroup | once/pass | renderId | shared | with state |
| light position / target / view position / colour, shadow matrix, shadow bias / mapSize / radius (42829-42916, 43706, 44223) | `AnalyticLightNode` per light | lighting graph | renderGroup | once/pass | renderId | shared | light dispose |
| clipping planes (20180-20288) | clipping context | all clipped materials | renderGroup | once/pass | renderId | shared | with state |
| fog params | fog node | materials | renderGroup (via the fog nodes' own group) | once/pass | renderId | shared | with state |
| `modelMatrix`, `modelViewMatrix`, `modelNormalMatrix` (14622-14686) | `ModelNode`, from `object.matrixWorld` | vertex stage | objectGroup | per RenderObject | none; recomputed | cloned | RenderObject dispose |
| `materialEnvIntensity`, `materialRefractionRatio`, `materialEnvRotation` (15157-15201) | material + scene, `onObjectUpdate` | env/transmission graph only | objectGroup | per RenderObject | none | cloned | with material |
| our project `uniform()` values (see §2) | our JS, `.value = …` | our TSL graphs | **objectGroup by default** (`UniformNode` constructor, 5396) | JS writes when we call; diffed per RenderObject | our own guards | **cloned** | with material |
| instance data (grass blades, forest instances, effect sprites, debris) | `StorageBufferAttribute` / instanced attributes | compute + draw | storage bindings, not uniform groups | on our writes | `attribute.version` / `updateRanges` | one buffer, all instances | attribute dispose |

**Values that cannot be shared across a second camera, shadow or reflection pass, and why**
[code-read]:

- Camera matrices, `cameraPosition`, `cameraViewport`, `cameraNear/Far`: their `onRenderUpdate`
  callbacks read `frame.camera` (13952, 14048, 14203). A shadow pass renders from the light's
  camera and a planar reflection from a mirrored camera, so the value differs by construction. The
  renderGroup dedup is keyed on `renderId`, which advances per pass, so this is already correct.
- Shadow matrices and `lightShadowMatrix` (42829): derived from the shadow camera's
  projection × view, valid only for the pass that built the map.
- Clipping planes (20180): stored in view space, so they depend on the pass camera.
- `time`/`deltaTime`/`frameId`: these *could* be shared across passes in one frame, and are —
  `frameGroup`-scoped `frameId` dedups on `frameId`, `renderGroup`-scoped `time` re-runs per pass
  but writes the same number, so the diff at 62017 suppresses the upload.
- `modelViewMatrix` / `modelNormalMatrix`: composed against the pass camera's view matrix, so a
  shadow pass genuinely needs its own value.
- `modelMatrix` alone is pass-independent, but it lives in the same objectGroup buffer as the two
  above and is cloned with them.

## 2. Candidates (a)-(d), checked rather than assumed

### (a) `materialEnvIntensity` / `materialRefractionRatio` / `materialEnvRotation` — **not a Base Game cost. Supported negative.**

Report 01 and verdict 3.1 both nominated these as the material-scoped-value-recomputed-per-object
weakness. They are `onObjectUpdate` (15157, 15166, 15180) and therefore un-deduped, and
`materialEnvRotation` even does a `makeRotationFromEuler` + `transpose` per call — so the mechanism
is real [code-read].

But the only consumers in the build are `materialEnvRotation` at 15353 (cube-texture env UV) and
26977 (PMREM env UV), `materialEnvIntensity` at 27124-27142 (radiance/irradiance from `envNode`),
and `materialRefractionRatio` at 15217 (`refractView`, reached through transmission/physical
material) [code-read]. All of those are inside the environment / transmission setup, which is only
built when a material or scene supplies an env node.

[measured] Grep over the live module closure (183 statically-imported files, rebuilt this session
with a Node import-walker, matching report 07's count) for
`\.environment\b|envMap\b|environmentNode|pmrem|PMREM|envMapIntensity|environmentIntensity|environmentRotation|envMapRotation`
returned **zero hits**. Grep for `PhysicalNodeMaterial` returned only two type-test lines in
`vision-modes.js:75,80` — no physical material is constructed anywhere in the live set.

So in Base Game these three nodes never enter a material graph, never appear in a bind group, and
cost nothing. The "every object recomputes `envMapIntensity` every frame" claim in
`01-data-ownership.md` is correct about Three in general and **wrong about this page**. Coverage
limit: `grass-compute.js` reaches the page through a dynamic `import()` at `base-game-flora.js:545`
and was outside the 183-file static closure; I grepped it separately and it has no env usage
either.

### (b) Per-object `NodeUniformsGroup` re-upload when nothing changed — **does not happen. Supported negative.**

`UniformsGroup.update()` (61973) walks every uniform and returns `true` only if `updateByType`
reported a change. I read `updateNumber` (62017), `updateVector2/3/4` (62042/62078/62119) and
`updateColor` (62160): each compares against `this.values` (the JS shadow of the CPU buffer,
built once by `Array.from(this.buffer)`, 61885) and returns `false` on equality without touching
`updateRanges`. `Bindings._update` calls `backend.updateBinding` only when `binding.update()`
returned truthy (32595-32601). A static object therefore issues **no `writeBuffer` at all** for its
object group after the first frame.

What is *not* skipped: the walk itself. `updateGroup` returns `true` for `objectGroup` on every
object (§0 gate 2), so the per-uniform comparison loop runs for every RenderObject every pass
regardless. That is the shape of the 6.21 s sampled at uniform-group `update` [measured, from
`trace-review-20260907.md`] — comparison cost, not upload cost, which is consistent with only
3.29 s of `writeBuffer` leaf time arriving through the bindings path.

### (c) `backend.needsRenderUpdate`'s ~30 compares per object per frame — **runs every frame, result is stable. Weak candidate.**

`Pipelines.getForRender` (31976) calls `_needsRenderUpdate` (32305) unconditionally — it is not
behind the `needsRefresh` gate. `WebGPUBackend.needsRenderUpdate` (81690-81744) does four
render-context lookups (`getSampleCountRenderContext`, `getCurrentColorSpace`,
`getCurrentColorFormat`, `getCurrentDepthStencilFormat`) plus `getPrimitiveTopology`, then ~30
field compares, and rewrites the cached fields only when one differs [code-read].

For a static object with an unmutated material in an unchanged render context, every compare is
equal and `needsUpdate` is `false` on every frame after the first. So there is no redundant *write*
here; there is repeated *reading*. It cannot be short-circuited on `material.version` alone,
because the render-context half (sample count, colour space, colour/depth formats, primitive
topology, `clippingContextCacheKey`) can change without the material changing — a resize, a
different render target, a clipping change. A correct skip would need a version stamp on the render
context that Three does not currently maintain. I am not proposing it.

### (d) Our own `uniform()` values sit in the per-object group, so a shared material writes them once per mesh — **the redundancy I nominate.**

**Producer.** `UniformNode`'s constructor sets `this.groupNode = objectGroup` (three.webgpu.js:5396).
[measured] Across the live set, `setGroup(`/`onRenderUpdate`/`onFrameUpdate`/`onObjectUpdate`
appear on exactly two of our uniforms — `depth-of-field.js:45-46` — out of ~160 `uniform()` call
sites in the live closure plus 70 more in `grass-compute.js` and 17 in `grass-look.js`. Every other
project uniform is in `objectGroup`, i.e. the cloned-per-RenderObject group.

**Consumers that duplicate the write.** `NodeBuilderState.createBindings` (48443-48452) clones the
object group per RenderObject; `Binding.clone` (61474) is shallow, so each clone has its own
`_values` shadow and its own GPU buffer but shares the `uniforms` array and therefore the same
`UniformNode.value`. Each clone runs its own diff and, when the JS value changed since *that
clone's* last upload, its own `device.queue.writeBuffer` (78231).

**The concrete instance.** `grass-compute.js:833-853` builds one material `mat` and then three
meshes from it: the tier-0 mesh at :835 and, for `t = 1..TIERS-1` (`TIERS = 3`, :206), two more at
:847, added as children of tier 0. All three are drawn in the main pass (`castShadow = false`, so
no shadow multiplier). Per-frame writers into that material's graph: `uTime.value` at
`grass-compute.js:925`, `uCam.value.set(camera.position.x, camera.position.z)` at :969,
`uWorldOrigin.value.set(x, z)` at :992, plus `base-game-flora.js:245`
(`uRenderOrigin.value.set(...)`) and `:623` (`uCamXZ.value.set(camera.position…)`).

**Equivalence argument.** All three meshes share one `THREE.Material` instance, one node-builder
state, and one `uniforms` array; `updateNumber`/`updateVector2` read the value through
`uniform.getValue()`, which resolves to the same `UniformNode.value` object for all three clones.
The three uploads therefore carry byte-identical payloads within a frame. The only dependency that
would break the equivalence is a per-object input entering that uniform — i.e. if the value were
ever derived from `frame.object`, which none of these are (they are camera- and clock-derived, set
from JS outside the render loop). A second camera or a reflection pass would *change* the value but
would change it identically for all three meshes, so the equivalence holds per pass as well.

**Size.** Multiplier 3 on ~5 per-frame uniforms in one material. [hypothesis] this is worth
microseconds, not milliseconds; I have no measurement isolating it. Its value is that it is
userland-fixable, correctness-neutral, and the same one-line pattern applies to any material we
later share across more meshes.

**Exact sites.** Producers: `grass-compute.js` (the `uniform(` declarations for `uTime`, `uCam`,
`uWorldOrigin` — declaration lines are in the 200-500 block; the writers are :925, :969, :992),
`base-game-flora.js:231-232`. Edit: append `.setGroup(renderGroup)` to those declarations, with
`import { renderGroup } from 'three/tsl'` (exported — confirmed in `three.tsl.js`'s export list).
Consumers needing no change: the TSL graphs that read them.

**Caveat I could not close.** `renderGroup`'s `NodeUniformsGroup` is created per node-builder
(`this.uniformGroups[groupName]`, 64320 / 75928), so the sharing is per material, not global. That
is exactly the scope needed here (3 meshes, 1 material) but it means moving a uniform to
`renderGroup` does **not** merge it across different materials. Also: a `renderGroup` uniform is
updated once per *pass*, so anything that must differ between the main pass and a reflection pass
within the same frame must keep its own per-pass write; none of the five above does.

## 3. Fix expressibility

**(d) is expressible with public API.** `renderGroup` and `setGroup` are both exported from
`three/tsl`. No renderer extension, no seam, no fallback, no toggle needed beyond a normal revert.
Upgrade cost per Three release: none beyond the export staying public, which it has been since
r16x.

**(a) would have needed an extension, and does not apply here.** For the record, had the env nodes
been live: `materialEnvIntensity`, `materialEnvRotation`, `materialRefractionRatio` and
`NodeUpdateType` are all exported from `three/tsl`, and their `updateReference` is already
`({material}) => material` (15157/15166/15180). Setting `node.updateType = NodeUpdateType.RENDER`
on the exported singleton after import would move them into `NodeFrame`'s RENDER branch
(53156-53170), which memoises on `[reference=material, renderId]` — i.e. once per material per
pass, which is exactly their true scope. Compatibility check at startup: assert
`materialEnvIntensity.updateType === NodeUpdateType.OBJECT` before the change and
`=== NodeUpdateType.RENDER` after (the TSL objects are `nodeObject` proxies, so a property write
must be verified to reach the target, not just appear to). Fallback: leave the property alone.
Toggle: a `?envscope=` flag. Upgrade cost: recheck the three line numbers and the proxy behaviour
each Three release. Not proposed, because §2(a) shows the nodes are absent from this page.

**Dynamic offsets.** [measured] Grep for `dynamicOffset`/`hasDynamicOffset` over the whole build:
zero hits. What a verified design would need, stated as a constraint rather than a rejection: a
bind-group layout entry declaring `buffer.hasDynamicOffset: true`; one arena `GPUBuffer` with every
object slice padded to `minUniformBufferOffsetAlignment` (256 bytes on most desktop adapters,
queryable from `device.limits`); an allocator handing each RenderObject a stable offset with
free-list reuse on dispose; `setBindGroup(index, group, offsets)` at draw time. In r184 that
requires changes in three places: `WebGPUBindingUtils.createBindingsLayout` (layout flag),
`WebGPUBackend.updateBinding`/`createBindings` (arena allocation instead of one buffer per
binding), and the draw path's `setBindGroup` call to pass offsets. That is a vendored-build patch,
which the repo has no rebase tooling for today.

## 4. Verification plan — detecting stale data, not fewer calls

For the (d) change, the failure mode is a value updating on one mesh and not another, or updating
once per frame where a second pass needed a different value. Call counts alone cannot see that.

**Node-testable** (no GPU; these exercise our modules and the Three node objects, not the backend):

1. `setGroup(renderGroup)` returns the same node and leaves `.value` semantics intact — assert
   `u.groupNode.name === 'render'` and `u.groupNode.shared === true` for each moved uniform.
2. A regression guard listing the uniforms that are *intended* to be render-scoped, so a later
   edit that adds a per-object dependency to one of them fails the test. Assert none of the moved
   uniforms is written from inside a per-object callback.
3. Existing grass/flora suites (`test-*.mjs` for grass and terrain) still pass — they cover the
   value plumbing, not the binding layer.
4. A small harness over `UniformsGroup` built from `three.webgpu.js`: add two uniforms, change one,
   assert `update()` returns `true`, exactly one `updateRange` is queued, and a second `update()`
   with no change returns `false`. This pins gate 3 so a future Three upgrade that removes the diff
   is caught in Node.

**Browser-only** (needs a real device; the user drives these, one route):

5. Two cameras / passes in one frame: run with `?reflect=planar` (or the planar mirror mode) and
   confirm the grass in the reflection matches the grass above the water — a render-scoped uniform
   updated once per pass must show the reflection camera's value in the reflection.
6. Shadows: force a shadow-casting configuration and confirm no grass/flora shadow artefact appears
   or disappears relative to the pre-change build.
7. Moving and instanced objects: walk the route; the grass tiers must stay locked to the camera
   with no visible seam between tier 0 and tiers 1-2 — a stale `uCam`/`uWorldOrigin` on one tier
   shows as exactly that seam, which is the specific staleness this change could cause.
8. Live value changes: move every grass and flora slider through its range while moving, and change
   the light/time-of-day, confirming each takes effect on all three tiers simultaneously.
9. Resource replacement: swap the terrain source (the path that already broke grass windows twice
   this month) and confirm grass survives and re-registers.
10. Origin rebase: cross a rebase boundary and confirm no jump or one-frame flash in the grass.
11. Reset: the in-page reset/rebuild path, then repeat 7.
12. Water reflection modes: cycle `sky` / `ssr` / planar and confirm no grass or ground change.

Acceptance: identical appearance on the same seeded route, plus a lower binding `writeBuffer` count
if we instrument it — but appearance parity is the gate, the count is only corroboration.

## 5. What I could not verify

- No browser, so nothing here is timed. Every cost statement is a code-read structural claim or a
  quote from `trace-review-20260907.md`.
- I did not enumerate the *live* RenderObject-to-material ratio for the whole scene; without it I
  cannot say whether any material other than the grass one is shared by more than one mesh with
  per-frame uniforms. The static evidence (report 07's 39 construction sites, forest's ~130
  variant×role meshes each with their own material) suggests the ratio is close to 1 for most of
  the scene, which is why (d) is small here.
- Whether the `nodeObject` proxy forwards a `.updateType` write to the target — relevant only to
  the (a) extension I am not proposing.
- I did not read `WebGPUBindingUtils.createBindings` closely enough to say what the shallow
  `Binding.clone` sharing of `updateRanges` and `_updateRangeCache` across clones implies; the
  sequential clear at `Bindings._update:32687` appears to make it safe, but I did not chase a
  re-entrant case.
