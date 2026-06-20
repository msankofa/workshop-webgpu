# Issue 001 — Procedural tree textures invisible on WebGPU (node-material binding lifecycle)

**Status:** Open — deferred (workaround: use authored textures). Surfaced during the SP1 WebGPU renderer migration (`workshop-webgpu`, branch `sp1-webgpu-renderer-migration`, `three@0.184.0`, `WebGPURenderer`).

**Owner ask:** Codex to investigate (needs web access / WebGPU introspection that the migrating agent didn't have).

---

## Symptom (precise)

- On a **clean load in `procedural` texture mode**, trees render **invisible** — you see only their *shadows* (and only for the **initial/origin chunk**, because the shadow camera frustum is pinned near the origin — that part is pre-existing, see Related).
- Switching **Texture mode → authored**: all trees appear correctly (authored looks great).
- Switching **back to procedural**: the trees that were already built **stay visible**.
- **Adjacent / streamed-in chunks** in procedural stay invisible until a mode-switch.

So it is **mode + lifecycle dependent**, not a content problem.

## Confirmed NOT the cause (evidence gathered)

- **Geometry is fine.** A diagnostic at bake-completion reported, in procedural mode:
  `mode=procedural chunks=15 emptyBranch=0 branchVerts=59805 leafVerts=75368 gen=true texReady=true`.
  The meshes have full geometry; nothing is empty.
- **Not vertex colors.** Authored uses the same `MeshStandardMaterial({ vertexColors: true })` + a map and renders fine, so vertexColors work on WebGPU.
- **Not the texture content / it's not "black".** Branches are opaque; an opaque mesh can't be made invisible by a map. The meshes simply don't draw the bound texture.
- The `THREE.AttributeNode: Vertex attribute "position"/"uv" not found` + `Draw with an index count of 0` console warnings are **transient streaming churn** from empty chunk meshes mid-stream, not the cause.

## Root-cause finding (as far as I got)

This is a **`three.webgpu` node-material texture-binding lifecycle quirk**:

> A material whose `.map` is assigned **at construction or before its first render** does **not** bind the texture on the WebGPU backend (renders untextured/invisible). The texture binds **only** when `applyTextureSet` (sets `material.map` + `material.needsUpdate = true`) runs **during the live render loop, after the material has already rendered at least once** — which is exactly what a Texture-mode switch does. Furthermore, **meshes streamed in after that rebind do not inherit the binding.**

This explains every observation: initial-load binding (constructor or pre-first-render) fails; a mode switch (rebind during live loop) works for then-existing meshes; later-streamed meshes need their own rebind.

## Fixes attempted (all insufficient — do NOT just re-try these)

1. **Force `texture.needsUpdate` in `applyTextureSet`** — no effect (was also chasing a wrong "black" symptom).
2. **Deferred `applyTextureSet` two frames after initial load** (`requestAnimationFrame` x2) → **first chunk became visible, streamed chunks still invisible.** (Best partial result.)
3. **Create the materials *with* the map in the constructor** (`new MeshStandardMaterial({ map: texSet.barkMap, ... })`) → **made it worse: NO trees visible at all** on initial load. Strong signal that born-with-map locks in an unbound state because the procedural `CanvasTexture` isn't uploaded at first compile.

All reverted; tree code is back to clean commit `a86fa8d`.

## The one missing data point (run this first)

After switching modes so trees are visible, **move the camera to stream brand-new chunks** and observe whether *those* new trees appear:
- **New streamed trees appear** → the issue is **per-material** (a single correct rebind fixes everything) → a clean fix exists.
- **New streamed trees invisible** → the issue is **per-mesh** → needs a rebind whenever tree chunks are committed (e.g. re-flag `branchMat`/`leafMat` `needsUpdate` in `commitTreeChunk` / when `processTreeQueue` drains), accepting the recompile cost.

## Likely real cause to investigate

The procedural maps are runtime **`CanvasTexture`s** (`tree-textures.js`: `makeBarkColor` via `putImageData`, `makeBarkNormal`, `makeLeafAtlas` via canvas drawing). Authored bark is an `Image`/`TextureLoader` JPG; the authored *leaf* atlas is also a `CanvasTexture` but its `needsUpdate` is set late (post image-decode, during the loop) — which is why authored works. **Hypothesis:** WebGPU's `copyExternalImageToTexture` upload of a drawn `HTMLCanvasElement` needs the texture flagged for upload at a point when the device/loop is live; a `CanvasTexture` constructed from an already-drawn canvas and bound before first render uploads as unbound/empty. Worth checking three.js issues for "WebGPURenderer CanvasTexture not uploading / needs needsUpdate after first render," and whether converting the procedural canvases to `ImageBitmap`/`DataTexture` (or calling `renderer.initTexture(tex)` after init) fixes it.

## Relevant code (in `workshop-webgpu/`)

- `tree-textures.js` — `proceduralSet()`, `makeBarkColor()`, `makeBarkNormal()`, `makeLeafAtlas()` (the `CanvasTexture`s); `authoredSet()` for the working comparison.
- `environment-viewer.html` — `ensureTreeResources()` (material creation), `applyTextureSet()`, `loadTextures()`, the tree bake (`buildNextTreeInJob`, `commitTreeChunk`, `processTreeQueue`), and `regenerate()`/`regenTrees`.

## Workaround (current)

Use **authored** texture mode (renders correctly, looks better). Or switch modes once after load to bind procedural. Production default can stay authored on WebGPU until fixed.

## Related (separate, pre-existing — NOT part of this issue)

- Distant trees are shadowless / only origin-chunk trees cast shadows: the directional shadow camera frustum is fixed near the origin. Reproduces on **WebGL** too — pre-existing, out of scope.
- A separate authored-texture crash (`null.isTexture` in `NodeMaterialObserver` when toggling `.map` to null while loading) was **fixed** in commit `a86fa8d` (don't toggle `.map` through null; keep the previous set live until the new one is ready).

## Cross-cutting note for SP1

The same "material set up / texture bound before first render" risk applies to **water caustics (SP1 checkpoint 6.3)**, where the terrain material gets a caustic node/texture. Set those up so binding happens during the live loop, or expect the same invisibility.
