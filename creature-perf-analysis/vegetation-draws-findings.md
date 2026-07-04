# Vegetation draw pipeline investigation — fixed forestDraws=96 / plantDraws=16

Scope: `forest-gpu.js`, `forest-placement.js`, `forest-palette.js`, `plants-gpu.js`, `plants-placement.js`,
`plants.js`, `environment-viewer.html` (wiring), `frame-profiler.js` / stats plumbing, and
`node_modules/three/build/three.webgpu.js` (renderer internals, to answer the "is it free" question).

## 1. Where 96 and 16 come from

Both `forestDraws` and `plantDraws` are read directly from each subsystem's `stats.draws` getter,
which is a pure function of variant count, not of live instance count:

- `environment-viewer.html:1009` — `forestDraws: forestGPURef ? forestGPURef.stats.draws : ...`
- `environment-viewer.html:1011` — `plantDraws: plantsGPURef ? plantsGPURef.stats.draws : 0`
- `forest-gpu.js:388` — `get stats() { return { draws: V * 8, ... } }`
- `plants-gpu.js:197` — `get stats() { return { draws: V, ... } }`

`V` = `palette.variants.length` = `speciesCount * variantsPerSpecies`, fixed at palette-bake time,
independent of how many instances are actually placed:

**Forest**: `V * 8` because each variant emits exactly 8 draw-call meshes (`forest-gpu.js:273-288`):
`branchesL0, leavesL0, shadowL0, branchesL1, leavesL1, branchesL2, coarseLeavesL2, billboardL3`
(3 LOD levels + a billboard impostor, with branches/leaves/shadow split at LOD0-1). Species count
defaults to 3 (`environment-viewer.html:1323`: `species: 3`), and `variantsPerSpecies` defaults to 4
(`forest-palette.js:46`, not overridden at the call site `environment-viewer.html:1362`). So
V = 3 × 4 = 12, and forestDraws = 12 × 8 = **96**.

**Plants**: `V` directly, one merged geometry (stem+leaves+flowers baked into a single mesh) per
variant (`plants-gpu.js:113-127`, comment at `plants-gpu.js:1-4` notes this is "simplified to a
single distance-cull band and one mesh per variant" vs. forest's branches/leaves/shadow split).
4 species in `PLANT_PRESETS` (`plants.js:55`: chickweed/cleavers/mint/jewelweed) ×
`variantsPerSpecies: 4` (`environment-viewer.html:2721`) = V = 16 = **plantDraws**.

Both numbers are baked once at palette-build time (`createForestPalette`/`createPlantPalette`) and
never change at runtime — they represent the number of `THREE.Mesh` objects added to the scene,
not the number of populated draws.

## 2. Are draws submitted when instance count is 0? Is there any skip/hide path?

Yes, draws are unconditionally submitted, and there is no skip path.

- Every one of the `meshes` built in `forest-gpu.js:273-288` and `plants-gpu.js:114-127` is pushed
  into a flat `meshes` array with no gating on instance count.
- All of them are added to the scene once, unconditionally, at (re)build time:
  - `environment-viewer.html:1370` — `scene.add(...forestGPU.meshes);`
  - `environment-viewer.html:2731` — `scene.add(...plantsGPU.meshes);`
- No `.visible` toggling exists anywhere tied to instance/draw count. Searched
  `environment-viewer.html`, `forest-gpu.js`, `plants-gpu.js` for `.visible`,
  `instanceCount === 0`, `cpuInstances === 0/> 0` — the only `.visible`/`count===0` hits in the
  whole app are for the unrelated creature-collision code (`environment-viewer.html:1810`) and
  the creature HUD stats line (`environment-viewer.html:885/937`). Nothing in the vegetation path.
- `mesh.frustumCulled = false` is explicitly set on every forest/plant mesh
  (`forest-gpu.js:206,285`, `plants-gpu.js:123`), so Three's normal per-object frustum-cull skip
  (which could otherwise avoid a draw call) is disabled by design — the GPU compute cull writes
  survivor counts into the indirect buffer instead, and the CPU-side render loop never learns the
  runtime (post-cull) count.
- Critically, `geometry.instanceCount` is set to the **fixed capacity**, not the live count:
  `forest-gpu.js:203` (`g2.instanceCount = CAP;`, CAP defaults 512, `forest-gpu.js:30`) and
  `plants-gpu.js:120` (`geom.instanceCount = CAP;`, CAP defaults 256, `plants-gpu.js:41`). The
  *actual* surviving instance count for a given frame only exists inside the GPU-resident indirect
  buffer (`element(1)` of each `IndirectStorageBufferAttribute`, written by the `atomicLoad`
  finalizer kernels, e.g. `forest-gpu.js:139-154`, `plants-gpu.js:92-96`), which the CPU never
  reads back. So there is no CPU-visible signal the render loop could even check today without
  a GPU→CPU readback.
- When `cpuInstances` is 0 for a variant (e.g. no placement records fall in that region), the
  per-variant `srcCounts` entry stays 0 (`forest-gpu.js:312-338` `rebuild()`,
  `plants-gpu.js:142-176` `rebuild()`), which means the GPU cull kernel's
  `If(localSlot.lessThan(srcCounts.element(g)), ...)` guard (`forest-gpu.js:93`, `plants-gpu.js:75`)
  never fires for that variant, so the indirect buffer's `instanceCount` element is correctly
  finalized to 0 — but the mesh is still drawn.

## 3. Does a 0-instance-count indirect draw actually cost anything?

Yes — real, non-zero cost per draw, independent of the runtime instance count in the indirect buffer.

Traced through the actual WebGPU backend in `node_modules/three/build/three.webgpu.js`:

- `getDrawParameters()` (`three.webgpu.js:29951-29979`) computes `instanceCount` from
  `geometry.instanceCount` (the fixed CAP, not the live GPU count) and only returns `null` (skipping
  the draw) `if (instanceCount === 0)` (`three.webgpu.js:29977`). Since CAP is always > 0
  (512/256), this early-out **never triggers** for these meshes — it's a CPU-side check on the
  static capacity, blind to the GPU-side survivor count.
- The actual draw submission (`three.webgpu.js:81481-81505`, indexed-geometry path) checks
  `renderObject.getIndirect()`; since it's non-null for every one of these meshes
  (`geometry.indirect = indirectAttr` at `forest-gpu.js:204`/`283`, `plants-gpu.js:121`), it
  unconditionally calls `passEncoderGPU.drawIndexedIndirect(buffer, indirectOffset)`
  (`three.webgpu.js:81495`) — there is no branch that inspects the indirect buffer's count before
  encoding the command; the GPU only reads/uses that count at execution time to decide how many
  instances to actually shade.
- Every such call runs `info.update(object, indexCount, instanceCount)` immediately after
  (`three.webgpu.js:81505`), which unconditionally does `this.render.drawCalls++`
  (`three.webgpu.js:31289-31291`). This is exactly the counter surfaced as `renderDrawCalls`
  (`environment-viewer.html:930`: `renderDrawCalls: r?.render?.drawCalls ?? 0`). So every one of
  the 96 + 16 = 112 vegetation meshes increments `renderDrawCalls` every frame they're in the
  render list, regardless of whether their GPU-side survivor count is 0.
- Practically: a `drawIndexedIndirect` with a GPU-resolved instance count of 0 does approach zero
  *shading* cost (no vertex/fragment invocations), but it is not "free" as a draw call — Three
  still does the full per-object CPU encode path: bind group lookup/creation, pipeline bind (each
  variant has its own `MeshStandardNodeMaterial`/`MeshBasicNodeMaterial` instance, so each is a
  distinct pipeline — `forest-gpu.js:246-252`, `plants-gpu.js:115`), and driver-side command
  submission overhead for reading the indirect args buffer. With 112 fixed draws/frame regardless
  of population, that's fixed CPU encoding + driver overhead on every frame even when
  `forestInstances`/`plantInstances` read 0.

## 4. What would it take to skip zero-instance vegetation draws?

There is no existing per-variant "is this variant populated" signal available on the CPU today —
that's the core gap. Two viable levels of fix:

**A. Cheap, CPU-known signal (per-variant `cpuInstances` from `rebuild()`)**
Both `rebuild()` functions already compute a per-variant placement count on the CPU before
uploading to the GPU:
- `forest-gpu.js:312-338` (`countsArray[g]` per variant `g`, summed into `cpuInstances`)
- `plants-gpu.js:142-176` (same pattern, `countsArray[g]`)

This is the CPU's *placement* count (pre-cull, i.e. before the distance-cull compute pass runs),
not the final per-LOD survivor count, but it is exactly "does this variant have zero instances at
all" — the case the finding calls out (`forestInstances: 0` / `plantInstances: 0` in the CSV). The
minimal change: track `countsArray[g] === 0` per variant in `rebuild()`, and toggle
`mesh.visible = countsArray[g] > 0` for that variant's meshes (all 8 forest meshes for variant g,
or the 1 plants mesh for variant g) right after `rebuild()`. `mesh.visible = false` is respected by
Three's WebGPU renderer's render-list build (objects are filtered out of the render list before
`getDrawParameters`/`renderObject` is ever created), so this fully removes the draw calls, not just
their cost. This does NOT catch the finer-grained case where a variant has placements but all of
them are outside the cull radius (post-cull count 0) — that's only knowable on the GPU.

**B. Full fix (per-variant *live* survivor count, matching what the CSV actually flags)**
The CSV's `forestInstances`/`plantInstances` come from `cpuInstances` too
(`forest-gpu.js:388`, `plants-gpu.js:197`), i.e. the same pre-cull placement count as (A) — so
fix (A) is actually sufficient to address the specific symptom in the finding (fixed draws while
`*Instances` reads 0). Going further to skip draws for variants that have placements but 0
*surviving* (post-distance-cull) instances this frame would require reading the indirect buffers'
survivor counts back to the CPU (e.g. via `renderer.getArrayBufferAsync` on the indirect storage
buffer) and toggling `.visible` per LOD bucket — this adds a GPU→CPU readback latency/cost
tradeoff and is a bigger change than the finding calls for.

**Concrete minimal-change locations:**
- `forest-gpu.js` `rebuild()` (ends `forest-gpu.js:338`): after computing `countsArray`, expose a
  per-variant boolean/count (e.g. `variantCounts` array mirroring `countsArray`) via the returned
  object, and in `environment-viewer.html` (or inside `forest-gpu.js` itself, since it owns
  `meshes`), set `.visible` on the 8 meshes belonging to each empty variant. The mesh-to-variant
  mapping already exists implicitly via the `for (let g = 0; g < V; g++)` loop at
  `forest-gpu.js:230-289` — grouping `meshes.push(...)` calls per `g` into a per-variant sub-array
  (instead of one flat `meshes` list) would make this toggle a one-line loop.
- `plants-gpu.js` `rebuild()` (ends `plants-gpu.js:176`): same pattern — `meshes[g].visible =
  countsArray[g] > 0` right after the loop, since plants already have exactly one mesh per variant
  index (`plants-gpu.js:113-127`), so `meshes[g]` directly corresponds to `countsArray[g]` with no
  restructuring needed.

## Summary

- Root cause: `stats.draws` (and therefore `forestDraws`/`plantDraws`) is `variants × meshes-per-variant`,
  a compile-time constant baked from species/variantsPerSpecies config, not a runtime measurement.
  96 = 3 species × 4 variants × 8 meshes (forest-gpu.js:388, forest-palette.js:46,
  environment-viewer.html:1323/1362). 16 = 4 species × 4 variants × 1 mesh (plants-gpu.js:197,
  plants.js:55, environment-viewer.html:2721).
- Confirmed empty draws ARE submitted: every variant's meshes are unconditionally added to the
  scene (environment-viewer.html:1370, 2731) with no `.visible`/count gating, `frustumCulled =
  false` is forced, and `geometry.instanceCount` is set to the fixed capacity (not the live count),
  so Three's own zero-instance early-out (three.webgpu.js:29977) never fires. The renderer
  unconditionally issues `drawIndexedIndirect` (three.webgpu.js:81495) and increments
  `render.drawCalls` (three.webgpu.js:31291) for every one of the 112 meshes every frame, whether
  their GPU-resolved instance count is 0 or not.
- Real (if small per-draw) cost is incurred for zero-instance draws: CPU-side render-list
  traversal, pipeline bind (distinct material per variant), bind-group setup, and command
  encoding/submission overhead — GPU shading cost is near-zero, but the draw call itself isn't free.
- Minimal fix: both `forest-gpu.js` and `plants-gpu.js` already compute per-variant instance counts
  in `rebuild()` (`countsArray[g]`); toggle `.visible = countsArray[g] > 0` on that variant's
  mesh(es) right after `rebuild()`. This fully eliminates draw-list entries for empty variants using
  data the code already computes — no new GPU readback needed to fix the specific symptom in the CSV.
