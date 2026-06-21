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
