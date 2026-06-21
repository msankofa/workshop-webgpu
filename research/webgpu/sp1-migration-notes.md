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
