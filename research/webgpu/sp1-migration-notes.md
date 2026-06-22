# SP1 — WebGPU Renderer Migration Notes

Reference record for the SP1 foundation migration (`workshop-webgpu`, branch
`sp1-webgpu-renderer-migration`). Seeds SP2 (compute grass) and SP3 (GPU-driven
terrain LOD). Companion to the synthesis paper
(`webgpu-parallelism-over-serial-synthesis.html`, §6 SP1) and the SP1 plan
(`docs/superpowers/plans/2026-06-20-sp1-webgpu-renderer-migration.md`).

## Pinned version

- **Three.js `r0.184.0`**, WebGPU build, via CDN importmap (jsDelivr, verified 2026-06-19):
  - `three` / `three/webgpu` → `build/three.webgpu.js` (re-exports the full core *plus* `WebGPURenderer` and node materials)
  - `three/tsl` → `build/three.tsl.js`
  - `three/addons/` → `examples/jsm/`
- Renderer: `new WebGPURenderer({ antialias: true })`, then `await renderer.init()` (top-level await in the module script), `renderer.setAnimationLoop(animate)`. `renderer.render(scene, camera)` is called fire-and-forget each frame (returns after CPU-side command encode/submit).

## Setup cost (caveat 1, confirmed)

`renderer.init()` (adapter + device acquisition) measured **217 ms** on target
hardware; backend reported `WebGPU` (not a WebGL2 fallback). This matches the
literature's ≈0.2 s one-time setup figure and is irrelevant to a persistent app —
caveat (1) from the synthesis §4.5 is a non-issue here.

## GLSL → TSL port map

`onBeforeCompile` / `ShaderMaterial` GLSL does not exist in TSL; each effect was
re-expressed as a node graph. The GLSL being ported remained the behavioral
source of truth (a pure-JS helper, `grassWindOffset`/`grassFadeKeep`, was
extracted and Node-tested in `test-grass-wind.mjs` to lock the wind/fade math).

| Module | Material | Key TSL nodes |
|---|---|---|
| `grass.js` | `MeshStandardNodeMaterial` | `positionNode` = world-X wind sway + distance-fade height collapse (`cameraPosition`, `aHeight`/`aWind` attributes, fade uniforms); `colorNode` = base→tip gradient × flat ambient/key × scrolling value-noise cloud shadow; **`normalNode = vec3(0,1,0)`** (constant up — grass has no normals; without this MeshStandard derives per-face normals and blades alternate light/dark) |
| `clouds.js` | `MeshBasicNodeMaterial` (`transparent`) | `colorNode = vec3(1,1,1)`; `opacityNode` = simplex/value-noise coverage × opacity ÷ horizon-fade(`length(positionWorld)`); setters write `uniform(...)` handles |
| `water.js` surface | `MeshBasicNodeMaterial` (`transparent`) | ripple-normal perturbation, Fresnel, depth tint; `colorNode` = blended reflection/refraction + spec; `opacityNode` = depth-driven clamp |
| `water.js` caustics | `MeshStandardNodeMaterial` on terrain | additive `emissiveNode` from a render-to-target caustic map (see below) |
| `terrain-system.js` | `MeshStandardNodeMaterial` (was `MeshStandardMaterial`) | converted so water can attach the caustic `emissiveNode`; this is the SP1 equivalent of the old `materialPatchTarget` / `onBeforeCompile` contract |

## Water reflection / refraction / caustics approach

The long pole. Three sub-pieces, each binding its texture **during the live
render loop** (the critical lifecycle constraint — see Known issues):

- **Reflection** — the TSL `reflector()` node (`ReflectorNode`). It manages its
  own mirror camera + RenderTarget + oblique near-plane clip and runs its mirror
  pass inside its own `updateBefore()` (`NodeUpdateType.RENDER`). The reflector's
  `target` is rotated `-π/2` about X to lie flat at water level and added under
  the surface; `uvNode` is offset by the ripple normal's XZ for distortion.
- **Refraction** — `viewportSharedTexture(screenUV + refractOffset)`, which copies
  the live framebuffer via `copyFramebufferToTexture()` during its RENDER
  `updateBefore()`. No separate pass or manual RenderTarget — it samples the
  already-drawn terrain/sky behind the surface.
- **Caustics** — a `CausticTextureNode extends TextureNode` with
  `updateBeforeType = NodeUpdateType.RENDER`. In `updateBefore()` it renders a
  top-down `causticScene` (caustic grid driven by its own `positionNode`) into a
  `WebGLRenderTarget` through a dedicated orthographic-ish `causticCamera`, then
  sets `this.value` to that target's texture. The terrain `MeshStandardNodeMaterial`
  samples it as an **additive `emissiveNode`** for fragments below water level —
  additive so the base terrain colour can never be blanked even if the bind is
  momentarily empty.
  - **Caustic-camera gotcha:** `WebGPURenderer._renderScene()` calls
    `camera.updateProjectionMatrix()`, but a base `THREE.Camera` has no such
    method. Fix: a no-op stub `causticCamera.updateProjectionMatrix = () => {}`
    (matrices are set manually with `matrixAutoUpdate`/`matrixWorldAutoUpdate`
    off). Without it: `TypeError: camera.updateProjectionMatrix is not a function`.

## Perf gate — draw distance 9 (361 chunks)

WebGPU vs WebGL2, `perfStats` CSV at `intervalMs = 250`, ~20 s pan
(`research/stats/perf-2026-06-21T04-3*Z-{webgl,webgpu}.csv`). Gate metric is
**CPU frame time** (sim + scene update + command encode/submit; `render()` returns
before GPU completion) — WebGPU's `renderer.info` call/triangle counters are *not*
comparable to WebGL's, so they are not used for the gate.

| dd9 metric | WebGL2 | WebGPU | Δ |
|---|---|---|---|
| CPU frame time — mean | 36.9 ms | 24.8 ms | −33% |
| CPU frame time — median | 29.3 ms | 21.3 ms | −27% |
| CPU frame time — p95 | 77.7 ms | 41.9 ms | −46% |
| Frame rate — mean | 33.4 fps | 45.3 fps | +36% |

**Gate met with margin.** CPU frame time is 27–46% below the WebGL baseline and
frame-time variance collapses (p95/median 2.65× → 1.97×) — the reduced stalling
the literature attributes to bundled state / fewer API calls. CPU time *fell*
rather than rose, so the GEM'24 per-frame buffer-upload stall (caveat 2) did **not**
appear in the ported scene. Note: WebGPU `calls` reads higher (48.9k vs 31.3k) —
expected, the backends count passes/draws differently; ignore it for the gate.

## Known issues / follow-ups carried out of SP1

- **Issue 001 — procedural tree textures invisible on the main pass.** Canvas-generated
  (`CanvasTexture`) bark/leaf maps bound before a material's first render don't
  bind on the WebGPU main pass (they *do* bind in render-to-target passes — they
  show in the water reflection). Full log in
  `issues/001-procedural-tree-textures-invisible-on-webgpu.md`. **Workaround / current
  default: authored textures** (render correctly). Codex made procedural trees
  textureless as an interim. SP1 ships on authored.
- **Empty-mesh draw warning.** `Draw with an index count of 0 is unusual` — harmless
  WebGPU console noise from empty tree-chunk / leaf-shadow sub-meshes transient
  during streaming. Not chased (overlaps tree-system cleanup).
- **Distant-tree shadows (pre-existing).** Only origin-chunk trees cast shadows; the
  directional shadow-camera frustum is pinned near the origin. Reproduces on WebGL
  too — out of scope for SP1.

## Lifecycle rule for SP2/SP3 (most important carry-forward)

A node material whose texture is bound **before/at its first render** leaves that
texture **unbound** on the WebGPU backend (renders empty). Bind **during the live
render loop** — i.e. via a node's `updateBefore()` of `NodeUpdateType.RENDER`
(as `reflector()`, `viewportSharedTexture`, and `CausticTextureNode` all do).
Any SP2 compute-generated grass texture / SP3 heightmap-or-LOD texture fed to a
material must follow the same pattern or expect issue-001-style invisibility.
Also: `NodeMaterialObserver` throws `null.isTexture` if `.map` is toggled through
`null` while loading — never null a live `.map`; keep the previous set live until
the new one is ready (fixed for authored trees in `a86fa8d`).

---

# SP2 — GPU compute grass

Replaces the legacy per-chunk CPU grass meshes (hundreds of draws + main-thread
geometry rebuilds) with one `drawIndexedIndirect` instanced draw fed by a per-frame
compute pass. Spec/plan: `docs/superpowers/specs/2026-06-21-sp2-gpu-compute-grass-design.md`,
`docs/superpowers/plans/2026-06-21-sp2-gpu-compute-grass.md`. Modules: `grass-compute.js`
(+ `grass-cells.js`, `grass-height-ref.js`; shared `buildBladeGeometry`/`buildGrassNoiseFns`
exported from `grass.js`).

## Pipeline (per frame, three compute dispatches → one indirect draw)

1. **reset** (1 thread): `atomicStore(counter.element(0), uint(0))`.
2. **generate+cull** (one thread per candidate slot = `windowCells × Kmax`): derive
   `(gx,gz,slot)` from a world-anchored cell grid around the camera, plant on the TSL
   terrain height, reject water/out-of-radius, density-dither the outer edge, then
   `atomicAdd(counter, uint(1))` to append the survivor's 2× `vec4` record.
3. **finalize** (1 thread): `indirect.element(1).assign(atomicLoad(counter.element(0)))`
   — copy the survivor count into the (non-atomic) indirect `instanceCount`.
4. `geometry.indirect = indirectAttr; geometry.instanceCount = CAP;` → one
   instanced `drawIndexedIndirect` of the 5-vertex blade.

## r0.184 API confirmed by `grass-compute-spike.html` (deleted after)

- Atomic counter: `storage(new StorageBufferAttribute(Uint32Array(1),1),'uint',1).toAtomic()`.
- **Atomics can't be plain-assigned and atomicAdd can't target the indirect buffer.**
  Reset with `atomicStore`, finalize copies `atomicLoad(counter)` into a plain
  `IndirectStorageBufferAttribute([indexCount,instanceCount,firstIndex,baseVertex,firstInstance])`.
- Indirect wiring is the property `geometry.indirect = attr` (not a method).
- `renderer.computeAsync(node)` **awaited** before the draw — fire-and-forget compute
  races the draw and makes the grass blink (the draw reads a half-reset `instanceCount`).
  `animate()` is `async`; grass is updated last, after the camera is positioned.

## Integer-typing gotchas (the "expected a uint" wall)

- TSL `.mod()` / `.div()` lower to **float** ops, breaking uint typing. Decompose the
  cell/slot index in the **int** domain: `modInt(idx, K)` for slot, integer `.div()`
  for the cell — and convert `instanceIndex` to `int` first.
- The lake hash must **bit-match** `terrain-field.js` so grass water-rejection lines
  up with the visible lakes (incl. negative coords): reinterpret `int → uint` with
  `bitcast(node,'uint')` (NOT `uint(node)`, which value-converts and clamps), then
  `bitXor`/`shiftRight` in u32. `grass-height-ref.js` is the Node-tested twin
  (`test-grass-height-tsl.mjs`, maxErr 0 vs `terrainHeightAt`).

## Device limit

The survivor buffer exceeds the default 128 MB `maxStorageBufferBindingSize` at large
Radius. The renderer pre-queries the adapter and requests its **own maximums**
(`maxStorageBufferBindingSize`, `maxBufferSize`) — always satisfiable, ~2 GB on the
dev GPU. Capacity is sized at `maxRadius` (decoupled from the live Radius slider) so
the slider grows without reallocating. Defaults: `cellSize 2`, `Kmax 64`, Radius 350 /
Density 8, sliders to 600 / 16 (CAP 23.1M instances / 705 MB at the ceiling).

## Perf gate — dd9 A/B (`?grass=gpu` vs `?grass=cpu`)

`research/stats/perf-2026-06-21T13-5*-grass{gpu,cpu}.csv`. GPU vs CPU grass:
CPU frame time mean **11.63 vs 17.95 ms (−35%)**, p95 14.87 vs 23.85 (−38%); fps
74.3 vs 57.4 (+29%); draw calls **~12.6k vs ~22.9k** (the per-chunk grass draws
collapse to one indirect draw). The GPU path renders millions of blades vs ~40k on
the CPU path and is still faster on every metric. **Gate met.**

## Open / deferred

- The per-frame full-window cull dispatches up to ~23M threads at Radius 600
  (awaited). Future optimization: re-cull only when the camera crosses a cell, or
  drop the per-frame await. Not needed at the default Radius (~7.9M threads, smooth).
- `?grass=cpu` (the legacy per-chunk manager) and `grass-compute-spike.html`'s lessons
  are retained as a fallback pending final SP2 cleanup (remove once trees/look settle).

# SP3 — GPU-driven CDLOD terrain

Replaces the per-chunk, CPU-built **visual** terrain ground with a fully GPU-driven CDLOD
renderer: a camera-snapped, Morton-keyed quadtree whose visible nodes + LOD are selected by
a compute pass, emitted via `atomicAdd`, and drawn with ONE `drawIndexedIndirect` of a
reusable grid; height + normals from the analytic field in TSL; crack-free via continuous
vertex morphing. This is the §4.4 endpoint (Yuan, Wang & Ai), adapted to WebGPU's lack of
tessellation. Spec/plan: `docs/superpowers/specs/2026-06-21-sp3-gpu-cdlod-terrain-design.md`,
`docs/superpowers/plans/2026-06-21-sp3-gpu-cdlod-terrain.md`. Modules: `cdlod-terrain.js`
(GPU/TSL) + `cdlod-select.js` (pure-JS selection math, Node-tested); reuses
`grass-height-ref.js` as the height parity twin. Behind `?terrain=gpu` (default) /
`?terrain=chunks` (legacy baseline + fallback).

## Pipeline (per frame, three compute dispatches → one indirect draw)

1. **reset** (1 thread): `atomicStore(counter.element(0), uint(0))`.
2. **select** (one thread per candidate node = `levels × windowCells²`, default 7×64=448):
   decompose `instanceIndex` → `(level, lx, lz)` in the int domain, snap the per-level window
   to the camera, compute the node's min-distance to the camera, run the **flattened
   distance-band test** (`notRefined ∧ refinedByParent`), and on pass `atomicAdd(counter,1)`
   + write the node's `vec4(originX, originZ, size, level+morphK)` record.
3. **finalize** (1 thread): `indirect.element(1).assign(atomicLoad(counter.element(0)))`.
4. `geometry.indirect = indirectAttr; geometry.instanceCount = CANDIDATES;` → one
   `drawIndexedIndirect` of the reusable `patchQuads × patchQuads` grid. The vertex stage
   morphs the grid coord toward the parent lattice (`morphK`), maps to world XZ, and
   displaces by the analytic height; normal is the analytic central difference (e=0.5).

## Two substitutions vs the paper (both faithful to its own logic)

- **Flattened selection for the producer/consumer FIFO queue.** The paper's contribution is
  GPU-resident node selection with no CPU traversal and no per-frame survivor transfer — all
  delivered by the flattened per-node band test, which reuses the proven SP2
  `atomicAdd`→indirect chain. Because the tree is camera-snapped and LOD is purely
  distance-based, every candidate decides independently whether it is the selected LOD, so
  the emitted nodes form a **partition** of the covered region (proven in
  `test-cdlod-select.mjs`). The double-buffered queue is an optimization for deep/large
  trees; unneeded at our ~7-level camera-centered depth.
- **Vertex displacement for hardware tessellation** — the substitution the paper itself
  prescribes (WebGPU has no tessellation stage). Height/normal come from the analytic field
  transcribed to TSL, bit-matching `grass-height-ref.js` / `terrain-field.js`.

## CDLOD specifics

- Node size at level L = `leafSize·2^L`; `range[L] = leafSize·2^L·lodScale` (node-size based,
  so a grid cell's angular size at its selection distance is `1/(patchQuads·lodScale)` —
  constant across levels → uniform screen-space density). Defaults: `leafSize 16, levels 7,
  patchQuads 16, lodScale 2.5, morphStart 0.6, windowCells 8`.
- Per-level window snapped to that level's cell size → coarse nodes don't shimmer as the
  camera moves (same world-anchored discipline as SP2 grass; tested).
- Morph: as a node nears its outer band, odd grid vertices snap to the even/parent lattice
  so the shared edge coincides with the coarser neighbor → no cracks. Continuity proven
  against `grass-height-ref.js` in `test-cdlod-morph.mjs` (gap = 0).

## Integration — `external` visual mode (the load-bearing decision)

`activeChunks` is consumed by trees, grass, water, and the collision octree. So SP3 does NOT
remove the chunk manager — `TerrainSystem` gains `visualMode: 'external'`: it keeps producing
`activeChunks` records (no geometry) + colliders within `collisionRadius` + analytic
`getHeight`, but skips the expensive visual chunk geometry. `materialPatchTarget` returns
`null`; the host points `ground` at the CDLOD mesh (loaded at top-level `await` so it binds
before water's caustic projection). Decorations/collision are unchanged.
(`test-terrain-system.mjs` §6 covers it: records + colliders, zero visual meshes.)

## Reused gotcha (same wall as SP2)

Int-index decomposition uses `modInt` + exact-multiple integer `.div` (never float
`.mod`/`.div`); `instanceIndex` cast to `int` first; the lake hash `bitcast(int,'uint')` to
bit-match the field. The select→finalize compute is **awaited** before the draw (unawaited
races → terrain flicker). The GPU-written indirect `instanceCount` is not synced back to the
CPU array, so the HUD's triangle count mirrors the identical (448-iter, cheap) CPU
`selectNodes` count rather than reading back the buffer.

## Perf gate — dd9 A/B (`?terrain=gpu` vs `?terrain=chunks`)

`research/stats/perf-2026-06-21T20-1*-{cdlod,chunks}.csv`. Terrain draw-call and triangle
cost is the gate, and it is **flat versus draw distance**:

| terrain metric (361-chunk-equiv window) | chunks | cdlod |
|---|---|---|
| terrain **draw calls** | **361** (grows with distance²) | **1** (constant) |
| terrain **triangles** | ≈382k (361 × 1,058; grows with distance) | ≈147k (flat, ±5% from camera) |
| CPU frame time, terrain-dominated¹ | 15.7–18.6 ms | **9.5–10.7 ms** (~40% lower) |
| fps, same | 41–61 | **62–75** |

¹ measured at a ~360-chunk window *before* the 300 tree placements + octree rebuild ramp in.
Across the full sweep, CDLOD `terrainDraws` stays **1** and `terrainTris` stays ~147k while
the chunk count climbs 3→361 — terrain cost is decoupled from draw distance (the §4.4 FusionRender
collapse). Once trees + the collision octree dominate (~25–40 ms in both runs), terrain is no
longer the bottleneck, which is the point. No cracks / no popping confirmed in the browser
checkpoint; collision still served by the analytic height field. **Gate met.**

## Open / deferred

- The collision octree still rebuilds from `collisionRadius` colliders (octreeMs ~35–70 ms
  spikes in both runs) — unrelated to terrain rendering, a candidate for a later SP.
- `?terrain=chunks` retained as the dd9 baseline + fallback (like `?grass=cpu`).
- Frustum culling is not in the selection (distance bands suffice for the gate, as in SP2);
  could trim outer-ring nodes later if needed.

# SP4a — Froxel clustered forward+ point lighting

Many dynamic point lights culled into a 3D froxel grid on the GPU; lit surfaces read only
their froxel's lights and add Cook-Torrance GGX over three's untouched sun/ambient. The
WebGPU-reachable lighting SOTA (ReSTIR/RTXDI/NRC need HW ray tracing, absent in browser
WebGPU). Spec: `docs/superpowers/specs/2026-06-21-sp4a-clustered-tiled-lighting-design.md`.
Modules: `clustered-lights.js` (GPU/TSL) + `light-cluster.js` (Node-tested cull math).

## Cull math (Node-tested, `light-cluster.js`)

Exponential depth slices (Olsson), view-space froxel AABBs, sphere-vs-AABB, and the Drobot
(SIGGRAPH 2017) **Z-bin + per-tile bitmask** assignment — `test-light-cluster.mjs` proves the
bitmask cull is a conservative superset of the exact froxel-AABB set (no dark froxels) and
that behind-camera lights bin nowhere.

## v1 GPU cull = per-froxel index lists (no atomics)

The shipped kernel dispatches **one thread per froxel**, loops the lights, and writes its own
index list with the exact sphere-vs-AABB test (mirrors `assignLightsExact`). Chosen over the
Drobot bitmask for the first cut because it needs no `atomicOr` (unconfirmed in TSL) — each
froxel owns its slot, so there are no atomics at all. The Z-bin/bitmask cull (math already
tested) is the documented perf refinement for higher light counts.

## Shading injection — additive `emissiveNode`, the ownership gotcha

Clustered GGX is injected as an **additive `emissiveNode`** term (via an `addEmissive(posWorld,
normal)` hook on `cdlod-terrain.js` and `grass-compute.js`), summed over the base sun/ambient
— the same hook the water caustics use. **That collision was the main bug:** the water system
did `ground.material.emissiveNode = cEmit`, *clobbering* the clustered term once water finished
loading (lights showed on the first frames, then vanished). Fix: water now **composes**
(`prior ? prior.add(cEmit) : cEmit`). Two more gotchas: a TSL `PI.mul(...)` (a plain JS number
can't be a node receiver — pass it as the arg), and grass had to be lit at its **ground base**,
not its swaying tip, or its pools desynced from the terrain by light-height parallax.

## Perf gate — dd9 A/B (`?lights=on` vs `?lights=off`)

`research/stats/perf-2026-06-22T02-0*-lights{on,off}.csv`, 256 animated point lights:

| metric (256 lights, steady state) | lights off | lights on |
|---|---|---|
| CPU frame time | ~15.0 ms | ~14.2 ms (unchanged, within noise) |
| frame rate | ~65 fps | ~68 fps |
| terrain draws / tris | 1 / ~141k | 1 / ~141k |

256 dynamic froxel-clustered GGX point lights add **no measurable CPU frame-time cost** — the
cull is GPU compute (awaited) and the shading is GPU, so the CPU submit cost is unchanged, and
fps holds ~65–70. The frame is dominated by grass/trees/creatures/octree, not the lights.
**Gate met** (target light count within budget). Note: WebGPU `renderer.info.triangles` reads
0, so GPU-time isn't directly measured; the maintained fps with 256 lights is the budget
evidence.

## Open / deferred (4a)
- Drobot Z-bin/bitmask cull (math tested) as a perf upgrade for >~1k lights; current per-froxel
  index-list cull is fine at 256.
- 3D froxels handle depth, but no point-light shadows (only the sun) — beyond the WebGPU ceiling.
- **Creatures** are sun/ambient-lit only; clustered lighting on them needs their materials to be
  node materials (Codex's `creature.js`) — a hand-off, not done here.

# SP4b — GPU particle fields (embers + dust)

A persistent GPU state buffer simulated each frame by a compute pass (curl-noise drift +
buoyancy/wind + lifecycle/respawn); alive+visible particles `atomicAdd` into one
`drawIndexedIndirect` of camera-facing billboards. Two species from one parameterized module.
Spec: `docs/superpowers/specs/2026-06-22-sp4b-gpu-particles-design.md`. Modules: `particles.js`
(GPU/TSL) + `particle-field.js` (Node-tested sim math).

## Pipeline (per frame, reset → simulate → finalize → indirect billboard draw)

1. **reset** atomic counter.
2. **simulate** (one thread per particle): integrate curl + buoyancy/wind, advance age, respawn
   on death/out-of-volume (camera-relative, reseeded), write state back; compute fade+flicker;
   **frustum-cull** via `uViewProj`; if visible `atomicAdd` + write the survivor `draw` record.
3. **finalize** copies the count into the indirect `instanceCount`.
4. One `drawIndexedIndirect` per field of a billboard quad (`uCamRight`/`uCamUp` from
   `camera.matrixWorld.extractBasis`); ember = AdditiveBlending, dust = NormalBlending,
   `depthWrite=false`. All `computeAsync` **awaited** before the draw.

## Notes

- Unlike grass/terrain, the GPU sim uses **equivalent (not bit-exact) randomness** — particles
  are purely visual, no cross-system parity. The Node tests validate the *algorithms* (spawn in
  volume, curl ~divergence-free to 2.8e-12, lifecycle fade/wrap, distinct kind params).
- **State persists on the GPU** (read+write the same storage buffer per particle, by index — no
  cross-particle hazard); initialized once on the CPU, never re-uploaded.
- Fixed always-full pool with respawn → **no free-list** needed. Additive/low-alpha blends are
  order-independent → **no GPU depth sort** needed.

## Perf gate — dd9 A/B (`?particles=on` vs `off`)

`research/stats/perf-2026-06-22T11-3*-particles{on,off}.csv`, 4k embers + 8k dust:

| metric (12k particles, steady state) | particles off | particles on |
|---|---|---|
| CPU frame time | ~18 ms | ~16 ms (within noise) |
| frame rate | ~54 fps | ~61 fps |

12,000 GPU-simulated particles add **no measurable CPU frame-time cost** (the on/off delta is
within run-to-run noise and even favors *on*) — the sim is GPU compute and the draw is two
indirect calls, so the serial CPU path is untouched. **Gate met.** (Caveat: a hard stress test —
maxed grass + lights + particles together — can trigger a WebGPU **device loss**; recovery is a
browser restart. The particle buffers themselves are ~0.8 MB, not the stressor.)

## Open / deferred (4b)
- Weather (rain/snow) deferred to a future **sky/weather SP** (the SP4 "C" option).
- GPU depth-sort, ribbon/trail/mesh particles, soft-particle depth fade, terrain collision — polish.
- Creature/combat-emitted particles (Codex coupling) — not in this self-contained field.

# SP4c — Node post-processing (bloom + tonemap + grade)

A configurable post stack composed from three's `PostProcessing` node pipeline, replacing the
final `renderer.render`. Spec: `docs/superpowers/specs/2026-06-22-sp4c-post-processing-design.md`.
Modules: `post-fx.js` (GPU/TSL) + `post-grade.js` (Node-tested grade math).

## Graph

`scenePass = pass(scene, camera)` → `bloom(scenePassColor, strength, radius, threshold)` (addon
`three/addons/tsl/display/BloomNode.js`) added to the scene color → `renderOutput(...)` (applies
the renderer's tone-mapping operator + sRGB output color space) → `gradeNode(...)` → `outputNode`.
`postProcessing.renderAsync()` replaces the draw when enabled (`?post=off` → plain render).

## Configurable (Post panel, ~16 live controls)

Tone operator (none/neutral/aces/agx/reinhard) + exposure; bloom strength/radius/threshold/smooth;
grade gain/brightness/contrast/gamma/saturation/temperature/tint/vignette/vignette-softness. **All
default to a visual no-op** (tone `none`, bloom strength 0, identity grade) so startup matches the
no-post baseline; you build the look from neutral. Live params are uniforms; switching the tone
operator rebuilds `outputNode` (the operator is baked at build).

## Gotchas hit (browser-only; WebGPU can't be validated headless here)

1. **`renderOutput` returns a vec4** — the grade must run on `color.rgb`, else the luma `dot`/
   white-balance (`vec4 + vec3`) silently misbehave while per-component stages (gain/brightness/
   contrast/gamma) still "work." This is why saturation/temperature appeared dead at first.
2. **Contrast pivot** at `0.5` acts like inverse-brightness on a dark scene (most pixels < 0.5 →
   contrast just darkens). Pivot at **middle-grey 0.18** so contrast expands around the midtone,
   decoupling it from the brightness slider.
3. `PI`/scalars can't be TSL node receivers; AgX tone mapping darkens midtones (don't default to it
   on a dim scene — default `none`).

## Perf note

Post runs as **GPU node passes** after the awaited grass/cdlod/lights/particle computes, so it
doesn't reintroduce a CPU-bound pass — the SP4 gate. cpuMs in the SP4a/4b dd9 runs (~14–18 ms) is
CPU submit time and is unaffected by adding GPU-side post passes; a formal `?post=on/off` dd9 trace
is deferred together with GTAO.

## Open / deferred (4c)
- **GTAO** (addon `ao(depth, normal, camera)`) is **v2** — needs an MRT(output, normal) scene pass;
  deferred (user: "work on it more later").
- Default look is baseline-neutral on purpose; tuned defaults to be baked once dialed in.
- TAA/SMAA/FXAA, SSR, DOF, motion blur — beyond-scope polish; sky/weather is its own future SP.
