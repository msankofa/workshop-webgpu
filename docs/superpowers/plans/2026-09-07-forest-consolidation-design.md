# Forest submission consolidation — design (agent C)

Date 2026-09-07. **Status: the branchesL2 prototype is implemented behind `forestDrawMode`,
default `'variants'`, and has never been rendered.** See the STATUS ADDENDUM at the end of this
file for what was built instead of what section 4.3 proposed, and why. The original design text
below is unedited.

Original status: design only, nothing implemented. Read-only pass over `forest-gpu.js`,
`forest-cull.js`, `base-game-forest.js`, `base-game.html`, `hiz-test.js`, `shared-draw-geometry.js`
and `node_modules/three/build/three.webgpu.js` (r184). No browser, no GPU. Every number below is
labelled **code-read**, **doc-cited** or **estimate**; nothing here is measured by me.

Refines section 3 of `docs/render-data-submission-improvement-plan.md` and step A of
`docs/render-submission-gpu-driven-plan.md`. Bundles and the matrix walk are out of scope.

## 1. Current state

### 1.1 What the forest submits (code-read, `forest-gpu.js:686-716`, `900-1002`)

One `THREE.Mesh` per (variant × role). With `V` variants:

| role | geometry (per variant) | material | indexed | cast | layer |
|---|---|---|---|---|---|
| branchesL0 | `variant.branches` | `branchMat` Std, FrontSide, rough .9 | yes | see below | default |
| leavesL0 | `variant.leaves` | `leafMat` Std, **DoubleSide**, rough 1 | yes | no | default |
| shadowL0 | `variant.shadow` | `leafMat` (shared with leavesL0) | yes | yes | default |
| branchesL1 | `branchesLod1 ?? branches` | `branchMat1` Std FrontSide | yes | yes | default |
| leavesL1 | `leavesMid ?? leaves` | `leafMat1` Std, FrontSide (side-switchable) | yes | no | default |
| branchesL2 | `branchesLod2 ?? branches` | `branchMat2` Std FrontSide | yes | yes | default |
| coarseLeavesL2 | `leavesCoarse` | `coarseMat` Std FrontSide (side-switchable) | yes | no | default |
| billboardL3 | per-variant `PlaneGeometry` | **per-variant** `MeshBasicNodeMaterial`, transparent, alphaTest .5 | yes (6 idx) | no | default |
| barkShadow | `branchesLod2 ?? branches` | `shadowMats.bark` | yes | yes | `SHADOW_LAYER` |
| leafShadow | `variant.shadow` | `shadowMats.leaf` (DoubleSide) | yes | yes | `SHADOW_LAYER` |

Base Game passes `billboards: false` and a `shadowLayer` (`base-game-forest.js:397-399`), so it has
7 main + 2 shadow-only = **9 meshes per variant** (code-read). Its default species string is three
ez-tree species (`base-game-tree-species.js:16`) at `treeVariantsPerSpecies: 2`
(`base-game-forest.js:32`), so the default is **6 variants → 54 meshes** (code-read). The plan's
"forest 130-140 (16 variants × 7 main + 2 shadow)" is a **doc-cited census** from
`render-submission-gpu-driven-plan.md`, taken at a larger species selection (16 variants × 9 = 144);
I found no code that fixes 16, so treat 54-144 as the range the settings span.

Material sharing is already done across variants: one material per role, and the per-variant draw
region comes from `mesh.userData.slotOffset` read in the shader through `userData('slotOffset','uint')`
(`forest-gpu.js:~640`). The comment there records that per-material constants produced ~224 WGSL
programs and per-material uniforms ~256 pipelines; the userData form is what keeps it at one pipeline
per role (code-read, comment-cited, not re-measured).

### 1.2 Passes

- **Main**: `renderer.render(scene, camera)` once (`base-game.html:6990`).
- **Shadow**: Three's shadow pass; `rig.dirLight.shadow.camera.layers.enable(BASE_GAME_FOREST_SHADOW_LAYER)`
  (`base-game.html:3474`). With `SHADOW_LIST` on, `syncRenderParts` forces `castShadow = false` on
  every main mesh and only the two shadow-layer meshes cast (`forest-gpu.js:~1000`).
- **Reflection**: planar mirror is opt-in (`waterReflection: 'planar'`), and the forest meshes are
  pushed into `reflectionExclusions` (`base-game.html:3649-3658`), so **the forest does not draw in
  the mirror today** (code-read). Any consolidation must keep that exclusion working; it is a list of
  mesh objects, so merged meshes change the list's contents but not its mechanism.

### 1.3 Counts, indirect args, LOD, Hi-Z (code-read)

- Buffers: `srcAttr` = `V*CAP` instances × 8 floats (rec0 = x,y,z,scale; rec1 = yaw,_,_,_);
  `drawAttr` = `V*SLOTS*CAP` × 8 floats; `countsAttr` = `V` uints (CPU-uploaded live source counts);
  `survAttr` = `V*SLOTS` atomics. `SLOTS = LODS + (shadow ? 1 : 0)`; Base Game `LODS = 3`, `SLOTS = 4`.
- Per (variant, role) there is one `IndirectStorageBufferAttribute` of 5 uints, initialised
  `[geo.index.count, 0, 0, 0, 0]`; element(1) is `instanceCount`, written by the finalize kernels.
- Chain per recull: `reset` (clear `V*SLOTS` atomics) → `cull` (dispatch `V*CAP`) → `finalizersA` →
  `finalizersB`, all in one `computeAsync([...])` await (`update()`).
- `cull` per instance: far cutoff (`uMaxDrawRadius`) → shadow-slot append (distance ≤ `uShadowReach`,
  written **before** the cone/Hi-Z tests so a hidden tree still casts) → cone test (padded by
  `uConeMargin`, `uRearMargin` and the instance's own angular canopy radius) → Hi-Z box test via
  `hiz-test.js` → LOD bucket by squared XZ distance against `uLodR0/R1/R2` → `atomicAdd` into that
  slot's counter and a compacted write into the slot's draw region.
- So **compaction already exists**, per (variant, LOD slot). Roles within a rung share one survivor
  list and one count; the finalizers copy that count into each role's indirect buffer.
- LOD is chosen per instance, radially, in the cull kernel. Rungs can be disabled
  (`setLodEnabled`) — a disabled rung's trees vanish, deliberately, as a raster A/B.
- Recull is threshold-gated: `recullMoveDist` (1.5 m), heading 2°, cone widening, `dirty`, or the
  Hi-Z clock (`hizRecullFrames`, default 4). Otherwise `update()` returns early.
- A CPU "rung gate" (`RUNG_GATE`, default on) hides meshes whose rung can hold no tree of that
  variant, by scanning live source records against ring distances with 0.5 m slack.
- Culling semantics per pass: **there is only one visibility computation**, camera-centred. The
  shadow-only slot is a separate, cone-free, Hi-Z-free radial list — that is how the code already
  avoids reusing main-camera visibility for shadows (code-read). Without `SHADOW_LIST` the main
  meshes cast and shadows *do* inherit main-camera visibility, which is the donor behaviour and is
  wrong in the same way the plan warns about; Base Game does not use it.

### 1.4 Origin rebase (code-read)

Records are global; the buffers are render-local. `setWorldOrigin(x,y,z)` only sets a
`needsRebuild` flag; `rebuild()` re-derives `x - originX`, ground `- originY`, `z - originZ` and
uploads a merged dirty range. `base-game-forest.js:211` calls it from the page's origin change.

## 2. Role partition — what may merge

Merge criterion is (geometry layout, material graph, blend/depth/side state, pass/layer), not looks.

Compatible for cross-variant merging (they already share one material each, so the only barrier is
that each variant needs its own geometry range):

- **A. Opaque branches**, per rung: branchesL0 / L1 / L2. Same attribute layout, Std material,
  FrontSide, opaque, `vertexColors`. Three merged meshes (one per rung).
- **B. Leaf cards**, split by side state: `leavesL0` + `shadowL0` share `leafMat` (DoubleSide) →
  one merged mesh; `leavesL1` and `coarseLeavesL2` are FrontSide but are two *different* materials
  today (`leafMat1`, `coarseMat`) with identical construction — mergeable into one only if agent B
  confirms the two can be one material; otherwise two merged meshes.
- **C. Shadow-only pair** (`barkShadow`, `leafShadow`): different materials and side; two merged
  meshes on `SHADOW_LAYER`.

Must stay separate:

- **Billboards** — one baked capture texture per variant, so one material per variant. Merging needs
  a texture atlas plus a per-instance UV rect. Base Game does not build them; out of prototype scope.
- **DoubleSide leaves vs FrontSide leaves** — `mat.side` is pipeline state, not shader graph.
- **Anything transparent** (billboards) vs opaque.
- **Shadow-layer meshes vs main-layer meshes** — different layer *and* different visibility list.

Best case for Base Game (estimate, from the partition above): 9 meshes per variant → 6 merged meshes
total (3 branch rungs + L0 leaves + far leaves + 2 shadow, minus one if the two far-leaf materials
unify). At 6 variants that is 54 → 6-7 meshes; at 16 variants 144 → 6-7.

## 3. Arena layout per merged role

One arena per merged role, built once when the palette is ready, rebuilt on a variant install.

**Vertex arena**: a single `BufferGeometry` whose `position`, `normal`, `color` (and `uv` where the
role has one) are the concatenation of every variant's geometry for that role, in variant order.
Per-variant table (CPU-side, mirrored into a small storage buffer):

```
struct VariantRange { vertexStart: u32, vertexCount: u32, indexStart: u32, indexCount: u32 }
```

16 bytes per (variant, role); ≤ 16 variants × 7 roles × 16 B = 1792 B (estimate).

**Capacity and growth**: arenas are sized at build time from the palette's actual geometries; there
is no incremental append, so no growth policy is needed inside a frame. `installVariant(g, variant)`
(progressive palette waves) changes one variant's geometry — the arena is rebuilt for the affected
roles at that point, off the hot path, mirroring how `shared-draw-geometry.js` re-acquires today.
While a wave is unpublished the variant's range is `vertexCount = 0`, which the mapping in §4 must
tolerate.

**Bounds**: every merged mesh keeps `frustumCulled = false` (as today), so the arena's bounding box
is informational only. Keep a union box for debug/raycast, computed at build.

**Disposal**: `shared-draw-geometry.js`'s reference-counted pool no longer applies once each role
owns one private arena; disposal becomes "dispose the arena geometry and its attributes when the
palette is replaced". The pool stays for any role left unmerged (billboards).

**Instance record**: unchanged from today's `draw` buffer — 2 × vec4 = 32 B per live slot,
`rec0 = (x, y, z, scale)`, `rec1 = (yaw, _, _, _)`. Consolidation needs one added field: the
**variant id**, so the vertex stage knows which arena range to read. Put it in `rec1.y` as a float
(free — the slot is already allocated and zero) rather than growing the record. Tint and wind are
derived, not stored: colour is baked into vertex colours, sway comes from `uLeafSway` + `time`.
Total instance storage is unchanged: `V*SLOTS*CAP*32 B` (6 variants, 4 slots, cap 1024 → 786 KB;
16 variants → 2.1 MB) (estimate, arithmetic from code-read shapes).

## 4. Compact live-count submission

### 4.1 What already works, unchanged

The cull kernel already appends survivors with `atomicAdd` per (variant, slot) and the finalizers
already write `instanceCount` into indirect buffers with **no CPU readback**. Consolidation does not
change the cull; it changes what a *draw* is.

### 4.2 The problem a merged role creates

`WebGPUBackend._draw` (r184, `three.webgpu.js:81480-81530`, code-read) issues exactly one
`drawIndexedIndirect(buffer, offset)` per indirect offset for an indexed geometry, and one
`drawIndirect` for a non-indexed one. There is no multi-draw-indirect on the WebGPU backend
(`multiDrawIndirect`: 0 hits in the build; `multiDrawElementsWEBGL` exists only on the WebGL
backend). One draw = one contiguous index range × one instance range. Variants in one arena have
different index ranges *and* different live counts, so they cannot be expressed as a single
**indexed** indirect draw.

### 4.3 Proposed form: non-indexed pulled draw with a prefix table

Per merged role, one non-indexed draw whose indirect args are `[vertexCount, instanceCount=1,
firstVertex=0, firstInstance=0]`. Note the arg layout differs from the indexed one
(4 uints, not 5) — the existing `IndirectStorageBufferAttribute` is constructed with itemSize 5 for
indexed draws; a non-indexed indirect buffer must be itemSize 4 (code-read from the WebGPU spec's
draw-args layout as used at `81505-81521`; **not verified against a running device**).

A small compute pass ("submit") runs after `finalize`, one workgroup, per role:

```
total = 0
for v in 0..V-1:
    live[v]   = atomicLoad(surv[v * SLOTS + slotOf(role)])
    firstVert[v] = total                       // prefix sum, exclusive
    total += live[v] * indexCount[v, role]
indirect[0] = total                            // vertexCount
```

`firstVert[]` and a copy of `live[]` are written to a small storage buffer the vertex stage reads.
V ≤ 16 today, so a serial loop in one invocation is fine (estimate: tens of cycles).

**Invocation → (variant, instance, local vertex)**: in the vertex node, given `vertexIndex`
(`vertexIndex` is a real TSL node, `three.webgpu.js:10549`, mapping to WGSL `@builtin(vertex_index)`
at `76019`; code-read):

```
v = 0
loop v in 0..V-1:                    // linear scan, V ≤ 16
    span = live[v] * indexCount[v]
    if vertexIndex < firstVert[v] + span: break
local  = vertexIndex - firstVert[v]
inst   = local / indexCount[v]       // integer div; indexCount is not a power of two
k      = local % indexCount[v]
idx    = indexArena[indexStart[v] + k]    // preserves indexed semantics: the index buffer is pulled
attrs  = positionArena[idx], normalArena[idx], colorArena[idx]
rec    = draw[(slotOffset(v, slot) + inst) * 2 ...]
```

This preserves indexed geometry exactly — the index buffer becomes a storage buffer read rather
than a pre-expanded arena. Pre-expanding (unrolling each triangle to 3 unique vertices) is the
alternative: it drops one dependent read per vertex but inflates vertex memory by roughly the
index-to-vertex ratio (LOD0 leaves are quoted in `forest-gpu.js` comments as ~7200 verts / 3600 tris
per variant, so expansion is ~10800 verts — about 1.5× — for leaves; branches are typically worse,
2-3×) (estimate). Start with the pulled index buffer; pre-expansion is a fallback if the dependent
read dominates.

**Per-vertex extra cost vs today** (estimate, not measured):

- today: fixed-function index fetch + attribute fetch through the vertex-attribute path, plus 2
  storage reads (rec0, rec1) per vertex.
- pulled: 1 linear scan over ≤ 16 entries (≤ 16 storage reads of a 16 B struct, likely all
  cache-resident), 1 integer div + 1 mod, 1 storage read for the index, 3-4 storage reads for the
  attributes (no vertex-fetch hardware, no post-transform vertex cache reuse), plus the same 2
  record reads. The loss of the post-transform cache is the biggest unknown and may cost more than
  the CPU saving; §7 exists to find out.

A cheaper mapping to consider once measured: bucket the scan by making every variant's `indexCount`
for a role equal (pad the shorter ones with degenerate triangles). Then `v = vertexIndex / stride`
with no scan, at the cost of drawing degenerate triangles — but only for the padding, not for dead
instance slots. Worth measuring as a variant of the prototype, not as the design.

**Ordering**: `submit` must run in the same `computeAsync([...])` array, after the finalizers and
before the draw, exactly as the existing chain does.

## 5. Pass-specific visibility

- **Main pass**: three merged branch meshes and one or two merged leaf meshes, each with its own
  prefix table and its own indirect `vertexCount`. Because roles within a rung share one survivor
  list, one prefix table per (rung, role-with-that-rung's-count) suffices; the branch rungs each
  need their own because they read different slots.
- **Shadow pass**: the shadow-only slot already carries its own list (cone-free, Hi-Z-free, radial
  within `uShadowReach`). Keep it. Two merged shadow meshes on `SHADOW_LAYER`, two more prefix
  tables, computed by the same `submit` kernel reading `SHADOW_SLOT`. Main-camera visibility is
  never used for shadows in this design, matching today.
- **Reflection**: forest is excluded from the planar mirror today. Keep it excluded; if it is ever
  included, it needs a third set of survivor lists culled against the virtual camera, which means a
  second cull dispatch — that is a separate decision, not part of this work.

Cost of pass-specific compaction (estimate): one extra `submit` dispatch, ~7 tables × (V × 16 B)
≈ 1.8 KB of storage, and no extra cull work, since the slots already exist.

## 6. Edge cases

- **Zero visible**: `total = 0` → `vertexCount = 0`. A zero-vertex `drawIndirect` is legal; the
  existing zero-instance case is already relied upon. Keep the CPU-side `mesh.visible` gate as a
  cheap short-circuit when *all* variants are empty, since a submitted mesh still costs renderer CPU.
- **Full visibility**: `total = CAP × sum(indexCount)` per role. At cap 1024, 16 variants and, say,
  20k indices for a branch LOD0, that is 3.3 × 10^8 vertices — far past what the GPU could raster in
  a frame, but the *number* is only a `u32` (max 4.29 × 10^9), so no overflow (estimate/arithmetic).
  It is the existing cull's job to keep live counts sane; consolidation does not change that.
- **Compact-buffer overflow**: unchanged from today. `atomicAdd` past `CAP` would write outside the
  variant's region. Today the CPU drops records past `CAP` at rebuild time
  (`droppedInstances`, warn once) and the shadow slot can in principle exceed it if
  `uShadowReach` admits more than `CAP` — worth clamping in the kernel (`if s >= CAP: return`) as a
  hardening item this design depends on, whether or not consolidation lands.
- **Camera moves between cull and draw**: already the normal case (reculls are threshold-gated, up
  to 1.5 m of travel and 2° of turn stale). The padded cone plus the coupling warning in
  `forest-gpu.js` covers it, unchanged.
- **Origin rebase**: `setWorldOrigin` flags a rebuild; only the source records change. The arena is
  in local model space and is untouched. No new work.
- **Variant reload / progressive waves**: `setVariantReady` and `installVariant` change geometry.
  Rebuild the affected role arenas and their range tables at that moment; a variant with
  `vertexCount = 0` contributes zero span and the mapping skips it. Warmup (`warmupVariant`) becomes
  per-role rather than per-variant, since the finalizers collapse.
- **Resource regeneration**: `dispose()` must free the arenas and the range/prefix buffers via the
  same `renderer._attributes.delete` path already used for the source/draw/counts/surv attributes.

## 7. Prototype scope

**Pick: branchesL2** (merged across variants, one mesh replacing V). Why: opaque, FrontSide,
one existing shared material (`branchMat2`), no alpha, the smallest per-variant geometry of the
three branch rungs (so the arena is small), it casts no shadow in the Base Game path
(`castShadow = false` is forced on main meshes when `SHADOW_LIST` is on), it is not in the mirror,
and it is the rung with the largest instance population, so any mapping cost shows up. It exercises
the whole mechanism (arena, prefix, pulled index, per-instance record) with the fewest confounds.

Behind an option `forestDrawMode: 'variants' | 'pulled'` so both arms run in one session.

**Acceptance checks** (browser, the user):
1. Placement: trees at LOD2 stand in the same places, same yaw and scale, as `variants` mode.
2. Silhouette: per-variant shapes are distinguishable — a wrong prefix mapping shows as one
   variant's trunk appearing everywhere.
3. LOD transitions: walk through the r1/r2 rings; no popping or gaps beyond today's.
4. Depth: no z-fighting or missing backfaces (FrontSide preserved).
5. Shadows: unchanged (this rung does not cast in Base Game; confirm it still does not).
6. Extremes: zero visible (walk out of the ring / disable the rung), and a dense stand near cap.
7. Rebase: cross an origin-rebase boundary; trees do not shift.

**Comparison to run**, same seeded window, same standing spot, warm, three captures per arm:

| measure | source |
|---|---|
| total frame CPU p50/p95 | `frame-profiler.js` record |
| `passPostMs` and the mirror/plain split | existing slots |
| draw calls / objects | existing census |
| GPU render time | existing GPU timing where the device exposes it |
| vertex work | triangles drawn (existing `rungTris` / renderer info) |
| memory | arena bytes vs the per-variant geometries they replace |
| pixel diff | screenshot of the same seeded window, `pulled` vs `variants` |

There is no automated visual-diff harness in this repo (code-read), so the pixel diff is a manual
compare unless one is written.

**Fallback**: if GPU time rises more than the CPU time falls, or the silhouette check fails,
keep `variants` as the default and either (a) try the equal-stride padded arena from §4.3, or
(b) stop at merging only the two shadow-only roles, whose instance counts are smaller and whose
raster cost is depth-only.

## 8. Ownership and interfaces

**Files that change**

- `forest-gpu.js` — the buffer/indirect construction block (~lines 60-110), the finalize kernels
  (~265-320), `instanceNodes` (~630-660), the mesh-construction loop (~686-716), `installVariant`,
  `syncRenderParts`/`RUNG_GATE` (the rung gate is per-mesh and becomes per-variant-within-a-mesh, so
  it degrades into a "is any variant live in this rung" check), `dispose`.
- `forest-cull.js` — no math change; the twin's `classifyInstance`/`shouldRecull` are untouched. Add
  a pure `prefixSpans(live[], indexCount[])` helper so the mapping in §4 is Node-testable.
- `base-game-forest.js` — pass `forestDrawMode` through from settings.
- `base-game.html` — the setting + panel control, and the `reflectionExclusions` list population
  (`3649-3658`) now takes fewer meshes.
- `shared-draw-geometry.js` — still used by unmerged roles; no change.
- Tests: `test-forest-cull.mjs` (new prefix helper), `test-base-game-forest.mjs`,
  `tsl-build-check.mjs` for the new vertex graph.
- Docs: `docs/subsystems/vegetation.md` (the `forest-gpu.js` row and the LOD/shadow sections),
  `agent_log.csv`.

**Blocking decisions from other agents**

- **Agent B (material sharing)**: whether `leafMat1` and `coarseMat` can be one material (decides
  5 vs 6 merged main meshes), and whether the L0 DoubleSide policy is fixed. Also whether
  `applyTextureSet`'s per-rung binding survives a merge (it binds by role pair today).
- **Agent D (binding inventory)**: the merged vertex stage adds bindings — arena position/normal/
  colour, index, range table, prefix table, plus the existing `draw` storage. The finalize split
  into A/B lists exists because of a per-stage storage-binding cap (comment in `forest-gpu.js`);
  D must say what the vertex stage's budget is on the target devices before the layout is fixed.
  Packing position+normal+colour into one interleaved storage buffer is the obvious mitigation.

**Ordered checklist**

1. Land the `atomicAdd`-past-`CAP` clamp (independent hardening, §6).
2. Add `prefixSpans` to `forest-cull.js` + Node test.
3. Build the branchesL2 arena and range table at palette-ready; assert byte equality of the
   concatenation against the source geometries in a Node test.
4. Add the `submit` compute kernel and its non-indexed indirect buffer (itemSize 4).
5. Write the pulled vertex node; `tsl-build-check.mjs` it headless.
6. Wire `forestDrawMode` and the option plumbing; keep `variants` the default.
7. Run the §7 comparison. Decide expand / pad-stride / stop.
8. Docs + `agent_log.csv`.

## 9. What I could not verify without a browser or GPU

- That a 4-uint non-indexed indirect buffer is what r184 + the device expect (I read the encoder
  call, not a running draw), and that `IndirectStorageBufferAttribute` accepts itemSize 4.
- Whether the vertex stage's storage-binding budget on the target device allows the arena layout;
  the build has no `maxStorageBuffersPerShaderStage` constant to read (0 hits).
- Whether losing the post-transform vertex cache costs more than the CPU submission saving. This is
  the single biggest risk in the design and the reason for the one-role prototype.
- The real per-object renderer CPU cost, and therefore how much 54 → 6 meshes is actually worth.
  The plan's ~55 µs/object is a doc-cited average over several passes, not a per-mesh measurement.
- Whether `userData('slotOffset','uint')` disappearing (it becomes per-instance data) changes
  pipeline count as the comment predicts in reverse.
- The actual index/vertex counts per variant per role, which set the arena sizes — they come from
  the palette bake at runtime.


---

# STATUS ADDENDUM (agent F, 2026-09-07)

## 1. The census dispute, settled

| Number | Value | Label |
|---|---|---|
| Meshes per variant in Base Game (7 main + 2 shadow) | 9 | code-read, `forest-gpu.js` |
| Module-default species (`base-game-tree-species.js:16`) | 3 | code-read |
| **Shipped-default species** (`base-game-default-state.json` `data.settings.treeSpeciesSelection`) | **8** | code-read |
| `treeVariantsPerSpecies`, both defaults | 2 | code-read |
| **Variants a shipped session builds** | **16** | code-read (8 x 2) |
| **Forest meshes a shipped session allocates** | **144** | code-read (16 x 9) |
| Forest meshes without the saved state (module defaults) | 54 | code-read (6 x 9) |
| Baked palette on disk (`families/palettes/manifest.json`) | speciesCount 8, variantsPerSpecies 2 | artifact-read, independent of the JSON |
| Highest variant id named in a capture | `forest:v15:...` | capture (`base-game-performance-log.json` entries 34-55) |
| Shadow-pass draws | 32 | capture (= 16 x 2, i.e. every shadow mesh) |
| Main-pass objects / draws | 202 / 214 | capture |
| Plant objects implied by the with/without-plants capture pair | ~109 (202 - 93) | capture arithmetic |
| Main-pass forest meshes left visible by the rung gate | ~106 (109 minus 1-3 grass) | estimate |

So section 1.1's "6 variants -> 54 meshes" is the configuration a page opened WITHOUT the saved
state gets, and the older plan's 130-140 is the configuration a shipped session actually runs.
Both were right about their own configuration. The 16-variant number is the one that matters.

RenderObjects per pass, from the same capture: main pass draws all seven main roles for the
variants the rung gate keeps; the shadow pass draws 32, which is every shadow-only mesh (the rung
gate's shadow test admits any variant with a tree inside `treeShadowReach`). Draws per mesh is
always one `drawIndexedIndirect`, whose `instanceCount` the finalize kernels write.

## 2. The four interface decisions

**(a) Storage bindings available to the vertex stage.** The existing forest material binds
**one** storage buffer in the vertex stage (`draw`). Three r184 requests its adapter with
`featureLevel: 'compatibility'` and `requiredLimits: {}` (`three.webgpu.js:80040-80074`), so the
device gets default limits, and the only two limits the build reads anywhere are
`maxUniformBufferBindingSize` and `maxComputeWorkgroupsPerDimension` — there is no
`maxStorageBuffersPerShaderStage` handling to read. **Answer taken: budget the merged vertex stage
at four storage buffers** (merged instance list, interleaved vertex arena, index arena, per-variant
count table), interleaving position/normal/uv/colour into one buffer specifically to stay low. That
the device admits four is inferred from the one that already works, not measured.

**(b) Index arena format.** From the palette on disk, branchesL2 across 16 variants is
**71,178 indices over 21,798 vertices** (index reuse factor 3.27; per-variant index counts run
1,092-7,308). Pre-expanded non-indexed: 71,178 x 44 B = **3.13 MB**. Pulled u32 index + indexed
arena: 21,798 x 48 B + 71,178 x 4 B = **1.33 MB**. **Answer taken: u32 index storage, pulled per
vertex.** 2.4x smaller, and pre-expansion is the fallback if the dependent read dominates.

**(c) Indirect args layout.** Section 4.3's non-indexed 4-uint form turned out to be avoidable, and
avoiding it removed the one thing the design could not verify. Because the merged mesh carries an
**identity index buffer** of length `indexSlot`, the draw stays an ordinary
`drawIndexedIndirect` with the same **5-uint `IndirectStorageBufferAttribute`** every other role
uses — `[indexSlot, liveInstances, 0, 0, 0]`, element(1) written by a finalize kernel exactly as
today. **Answer taken: no new indirect layout.** The identity index buffer also means
`@builtin(vertex_index)` (which under an indexed draw is the index VALUE, `three.webgpu.js:76019`)
hands the shader the local index directly, and it keeps every hardware vertex fetch inside the
mesh's own small dummy attributes — which matters because `positionLocal` is
`attribute('position').toVarying(...)` (`three.webgpu.js:14726-14734`), so Three still emits an
attribute fetch even when `positionNode` overrides it.

**(d) Per-pass compaction for the shadow list.** **Answer taken: no change.** The shadow-only slot
is already a separate, cone-free, Hi-Z-free radial compaction, and `branchesL2` does not cast in
Base Game (`SHADOW_LIST` forces `castShadow = false` on every main mesh). Merging the two shadow
roles is the fallback in section 7, not this prototype.

## 3. What was built vs. what section 4.3 proposed

Built: uniform-slot arena, identity-index indexed indirect draw, variant id in `rec1.y`, a merged
cross-variant compaction written by the existing cull, a one-invocation merged finalizer, the
per-variant meshes kept and hidden so a fallback needs no rebuild, per-variant overflow fallback,
and `forestDrawMode` plumbed through `base-game-forest.js`.

Not built, deliberately: the **prefix-sum scan** of section 4.3. Uniform slots make the mapping two
multiplies instead of a per-vertex linear scan over V entries, and they remove the non-indexed
4-uint indirect unknown entirely. The cost is section 4.3's own "pad-stride" trade, which it named
as a thing to measure: **about 1.64x the vertex invocations** at this rung
(`indexSlot 7,308` vs a 4,449 mean), before the 2x slack multiplier. That is now the prototype's
single biggest risk and the first thing a capture should answer.

Also not built: `normalMap` on the merged material. Three derives tangents from real vertex
attributes and the merged mesh has none, so `bindTreeMaterials` binds bark colour from the arena's
uv and vertex colour and sets `normalMap = null`. LOD2 rung only.

## 4. Ordered checklist, against section 8

1. `atomicAdd`-past-cap clamp — **done for the merged list** (`ms < MERGED_TOTAL`). The
   pre-existing per-variant and shadow-slot clamps are still unaddressed; independent hardening.
2. `prefixSpans` — **superseded** by `pulledArenaSlots` / `packPulledArena` / `pulledVertexOffset`
   in `forest-cull.js`, tested in `test-forest-pulled-arena.mjs`.
3. Arena + range table at palette-ready — **done**, with byte round-trip asserted in Node.
4. Submit kernel + non-indexed indirect — **replaced** by the identity-index form; see (c).
5. Pulled vertex node — **written**; `tsl-build-check.mjs` cannot reach it (it is a GLSL builder and
   says storage-buffer materials need a real backend).
6. `forestDrawMode` plumbing — **done in `base-game-forest.js`**; `base-game.html` still needs three
   lines (see the report).
7. The section 7 comparison — **not run**, needs a device.
8. Docs + `agent_log.csv` — done.
