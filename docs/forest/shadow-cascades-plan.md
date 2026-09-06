# Forest shadows: cascaded shadow maps with per-cascade tree rungs

Date: 2026-09-06. Status: planned, not started.

Item 6 of the 2026-09-06 review: Base Game lights the world with one directional shadow camera
(±90 m, far 260 m, `base-game.html:3373-3380`), so trees are either inside a single sharp-ish map
or cast nothing. The forest already knows which rungs can cast (`setShadowRungs`,
`treeShadowReach`, a shadow-only region per variant drawn on `BASE_GAME_FOREST_SHADOW_LAYER`); it
lacks a shadow system that reaches past 90 m without going soft everywhere.

## Goal and constraints

Three cascades from the eye outward — sharp near, coarse far — with each cascade drawing only the
tree rungs that can matter to it, stable under camera motion (no shimmer), and with a cost the
Base Game `?prof=1` breakdown can attribute per cascade. The environment viewer shares the module.

- Three.js r184 has no built-in CSM for the WebGPU renderer (the `CSMShadowNode` addon exists but
  drives a `DirectionalLight` through its own frustum split; it is the reference, not necessarily
  the dependency — see open questions). Whatever is chosen must work with `MeshStandardNodeMaterial`
  and the forest's instanced `positionNode`s, because the shadow pass runs those same node graphs.
- The forest's shadow list is "every instance within `uShadowReach`, cone or not" (`SHADOW_LIST`),
  so shadows from trees behind the camera fall into view. Cascades change how far that reach is
  worth, per cascade, not the mechanism.
- Terrain receives; concrete receives and casts; grass receives (it already samples the shadow map).
  The receiver side is the renderer's; the plan's work is the caster side and the split.

## Current state

- One `DirectionalLight` shadow camera, orthographic ±90 m, `near 1`, `far 260`, map size set by the
  host (check `base-game.html` for the current value; the tree viewer uses 2048²).
- `base-game-forest.js` `syncRenderState()`: a rung casts only if it *starts* inside
  `treeShadowReach` (rung 0 always, rung 1 if `r0 < reach`, rung 2 if `r1 < reach`), so with the
  defaults (60/140/260, reach 90) only L0 and L1 cast, and L1 trees past 90 m cast into a map that
  cannot show them.
- `forest-gpu.js`: `SHADOW_SLOT` region per variant, two shadow-only meshes (branches, leaves —
  `shadowL0` uses full geometry) on the shadow layer, `setShadowReach`, `setShadowRungs`.
- The tree viewer fits its single shadow frustum to the LOD clusters in LOD mode (2026-09-05), which
  is exactly the "one map, blurry everywhere" failure this plan removes.

## Design

### 1. Cascade split and fitting

- New `shadow-cascades.js`: `createShadowCascades({ light, camera, count: 3, maxDistance, lambda: 0.6 })`.
  Practical split (blend of uniform and logarithmic, `lambda` weights the log term): with
  `maxDistance` 300 m the defaults land near 0–25 m, 25–90 m, 90–300 m.
- Each cascade owns an orthographic camera fitted to its slice of the view frustum: the slice's
  bounding sphere sets the extent (a sphere, not a box, so the extent does not change with camera
  yaw), the light direction sets the orientation, and the position is snapped to shadow-texel
  increments in light space so the map does not shimmer when the camera translates.
- Map size per cascade from a total budget: 2048² near, 2048² mid, 1024² far by default, all in
  one atlas or three targets depending on what the renderer supports cleanly (open question).

### 2. Caster selection per cascade

- The forest's shadow list splits into one region per cascade (`SHADOW_SLOT_k`). The cull kernel
  writes a tree into cascade `k`'s shadow region when its light-space footprint intersects that
  cascade's extent — computed in the kernel from the cascade's light-space bounds uniforms. A tree
  can be in two regions at a cascade boundary; that is correct.
- Which geometry casts per cascade: near uses `shadowL0` (full branches + shadow leaves), mid uses
  the L1 branches plus the shadow leaves, far uses L2 branches only (leaves at 90 m+ contribute a
  blob the coarse branches already give). `setShadowRungs` becomes `setShadowGeometry([...])` per
  cascade. Leaf shadows on the far cascade are the first thing to cut under a budget.
- `uShadowReach` is superseded by `maxDistance`; the "cone or not" rule stays, because the extent
  test is in light space and naturally includes casters behind the camera that shadow the view.

### 3. Receiver side

- The renderer's shadow sampling for a `DirectionalLight` reads one map. With cascades the receiver
  material needs to pick the cascade by view depth and sample that map — this is what
  `CSMShadowNode` does for node materials. If it can be used as the light's `shadow.shadowNode`
  with our fitted cameras, that is the route (Option A). If not, Option B: three `DirectionalLight`s
  sharing direction, each with one cascade's camera, and receivers that read all three with a
  depth-based select node injected via `material.shadowNode` — more lights in the shader but no
  fork of the addon.
- Cascade blending: a 2 m band at each split where both cascades are sampled and lerped, so the
  seam does not show as a line across the ground.

### 4. Hosts

- `base-game.html`: replace the fixed ±90 m camera with `createShadowCascades`; `treeShadowReach`
  becomes `treeShadowDistance` (the far cascade's end) and the panel gains per-cascade map size and a
  "far cascade leaf shadows" toggle.
- `environment-viewer.html`: same module; it has the larger rings so `maxDistance` defaults higher.
- `tree-viewer.html`: LOD mode uses the cascades instead of the fitted single frustum, so the
  viewer shows the shadows each rung will really get.

## Steps

- [ ] 1. Spike: can `CSMShadowNode` accept externally fitted cameras and does it run the forest's
  instanced `positionNode` in its shadow pass? One evening in a demo page under `demos/`. Decide
  Option A or B from what it does.
- [ ] 2. `shadow-cascades.js` split + fit + texel snap, pure where possible
  (`test-shadow-cascades.mjs`: splits monotonic, spheres cover the slices, snapping is idempotent).
- [ ] 3. Per-cascade shadow regions in `forest-gpu.js` (kernel light-space test, finalizers,
  meshes per cascade), `forest-cull.js` mirror + test.
- [ ] 4. Receiver select and blend (per the spike's option).
- [ ] 5. Base Game wiring and panel; environment viewer; tree viewer LOD mode.
- [ ] 6. Docs: `lighting.md` (new module), `vegetation.md` (shadow regions), `base-game.md`;
  `agent_log.csv`.

## Validation

- Headless: the cascade tests above; `tsl-build-check.mjs` for any receiver material change.
- Browser: Base Game at noon and at low sun; walk toward a tree line — shadow edges should stay
  crisp within 25 m, no shimmer when strafing, no visible seam at 25 m or 90 m; a debug colour mode
  tints receivers by cascade index (the standard CSM debug view).
- Perf: `?prof=1` shadow pass ms per cascade and shadow-region instance counts, before and after,
  same seed and camera.

## Open questions

- `CSMShadowNode` (three addon) vs. our own three-light arrangement — decided by the spike.
- Contact-hardening or PCSS on the near cascade is out of scope; PCF as today.
- Whether grass should cast into the near cascade (it receives today; casting is a `grass-compute.js`
  change) — separate decision, not in this plan.
