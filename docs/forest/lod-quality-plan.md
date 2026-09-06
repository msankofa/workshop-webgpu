# Forest LOD quality: crossfade, impostors, leaf shading, size-based selection

Date: 2026-09-06. Status: planned, not started.

Covers items 1–4 of the 2026-09-06 review of the Base Game tree implementation: hard LOD pops,
single-angle billboards, flat leaf lighting, and distance-only tier selection. Items 5 (occlusion),
6 (shadows) and 7–8 (placement, capacity) have their own plans beside this one.

## Goal and constraints

Make the four tiers of `forest-gpu.js` read as one tree at every range: no visible pop at a ring,
impostors that turn and light like the mesh they replace, canopies that respond to the sun, and
tiers chosen by how big a tree is on screen rather than how far away it is. Everything is judged
in `tree-viewer.html`'s LOD mode (`tree-lod-preview.js`, layouts `rings` / `side` / `fill`) before
it is wired into either game. Base Game keeps its "no fourth rung" choice until the impostor work
gives it one worth having.

Constraints that shape the design:

- The cull kernel writes each instance into exactly one tier's compact region and claims one
  `atomicAdd` slot. A crossfade needs the same tree in two regions for the width of the fade band,
  so the kernel gains a second write, not a fade uniform per draw.
- Instance records are two `vec4`s: `rec0 = (x, y, z, scale)`, `rec1 = (yaw, _, _, _)`. Three
  floats of `rec1` are free; the fade weight and the tier index go there.
- `forest-cull.js` is the CPU twin of the kernel and is not imported by it. Every kernel change here
  is mirrored there by hand, with a test.
- The CPU/GPU math twin rule applies to the impostor as well: the angle-to-cell math lives once in a
  small pure module both the bake and the shader read.

## Current state (what the code does today)

- `forest-gpu.js` buckets on squared XZ distance against `uLodR0/1/2` and `uMaxDrawRadius`; a tree
  is in one tier per frame; tiers switch instantly at the ring.
- L1 draws `variant.leavesMid ?? variant.leaves` (the intermediate bake added 2026-09-05, identical
  to the full leaves at the 1/1 defaults); L2 draws `leavesCoarse` (25% of the cards at 2.5×).
- The billboard rung (`HAS_BILLBOARDS`) is one camera-facing quad per tree with a texture the host
  bakes: `environment-viewer.html`'s `bakeVariantBillboard` renders one (`cross`) or eight (`8way`)
  orthographic captures at sun 1.2 / ambient 0.4 and applies it through `applyBillboardMap(g, tex)`
  and a brightness ratio. The `8way` atlas is baked but the shader does not select a cell by view
  angle, and the impostor has no normal so it never relights. Base Game constructs with
  `billboards: false`.
- Leaves are flat cards with the baked normal of the card. `MeshStandardNodeMaterial`, no
  translucency, `DoubleSide` at L0 and `FrontSide` beyond. Wind is a host-side `positionNode` sway.

## Design

### 1. Dithered crossfade between tiers

Each ring `R_k` becomes a band `[R_k − w_k, R_k + w_k]`. Inside the band the tree is written to
both tiers with complementary weights; outside it is written to one tier with weight 1.

- Kernel: after `live`, compute `t_k = clamp((dist − (R_k − w_k)) / (2 w_k), 0, 1)` for the ring the
  tree is nearest. Write the near tier with `fade = 1 − t_k` and the far tier with `fade = t_k`
  whenever `0 < t_k < 1`; store `fade` in `rec1.y`. The compact regions and finalizers already
  exist; the band only adds a second `atomicAdd` for trees inside it.
- Fragment: every forest material gets `alphaTest`-style screen-door discard driven by
  `rec1.y`, using an ordered 4×4 Bayer threshold on `screenCoordinate`. Discard when
  `bayer(pixel) >= fade`. No blending, no sort, shadows still work because the shadow pass runs the
  same discard.
- Both tiers of a fading tree share position, yaw and scale, so the two dithers interleave into a
  solid tree; the visible cost is the dither pattern itself across a `2 w_k` band.
- Width `w_k` is a uniform per ring (`setLodFadeWidths([w0, w1, w2])`), default 8% of `R_k`, exposed
  in the tree viewer's LOD panel and Base Game's tree panel.
- Cost: the fade band roughly doubles instance count inside it. With default widths that is well
  under 20% of the live set; `computeCullEstimate()` gains a `fadingInstances` field so the panel
  shows it.

### 2. Octahedral impostors as the fourth rung

Replace the one-capture quad with an impostor atlas indexed by view direction.

- New pure module `impostor-atlas.js`: `cellForDirection(dir, n)` (hemi-octahedral mapping, `n×n`
  cells, upper hemisphere only — trees are never seen from below), `directionForCell(i, j, n)`,
  `uvRect(i, j, n)`. Exported so the bake, the shader constants and the test all use the same
  mapping.
- New `impostor-bake.js`: `bakeImpostor({ renderer, variant, n, size, texSet })` renders `n×n`
  captures of `branches + leaves` with an orthographic camera at each `directionForCell`, into two
  atlases: albedo (RGBA, alpha is coverage) and normal+depth (RG octahedral-encoded view-space
  normal, B linear depth 0..1 across the bounding sphere). Lit captures are dropped — albedo is
  captured unlit (`MeshBasicNodeMaterial` with the baked vertex colour and maps) so the impostor
  can be lit live. Default `n = 8` (64 cells), 2048² atlases, or `n = 4` for low settings.
- `environment-viewer.html`'s bake moves onto this module; its IndexedDB cache keys gain the atlas
  version. `tree-lod-preview.js`'s `bakeBillboard` does too, so the viewer shows the same impostor.
- Shader (`forest-gpu.js` billboard material → impostor material): from the per-instance position and
  `cameraPosition` compute the view direction in the tree's frame (undo `rec1.x` yaw), pick the
  three nearest cells (barycentric on the octahedral grid) and blend their albedo and normal samples
  — the standard three-tap impostor. Depth sample offsets the fragment depth so impostors intersect
  terrain plausibly. The reconstructed normal feeds the same lighting as the mesh tiers, so the
  impostor relights as the sun moves; `uBillBrightness` and the bake-lighting ratio go away.
- The quad stays camera-facing and upright (cylindrical); the octahedral lookup handles pitch.
- Base Game turns the rung on (`billboards: true`) once the viewer shows the impostor matching L2 at
  R2; its draw radius extends to `1.5 × R2` as the environment viewer's already does.

### 3. Leaf normal bulge and translucency

- `trees.js` `_leafQuad`: keep the card's geometric normal for winding, but add a second attribute
  `shadeNormal` = normalised vector from the tree's canopy centre (the bounding sphere centre of the
  leaf set, computed in `generate()`) to the card centre, blended 70/30 with the card normal. The
  palette bakes it through (`bakeFlatColor` clones attributes), and the forest leaf materials read it
  as `normalNode` instead of the card normal. Canopies then shade as a volume — lit side, dark side —
  which is what every shipped foliage system does.
- Translucency: leaf materials gain a wrap-lighting term `max(0, dot(-L, V))^k × thickness × leafTint`
  added to diffuse, gated by `uLeafTranslucency` (default 0.35), so backlit canopies glow at low sun.
  Implemented as an `emissiveNode` contribution in TSL, not a custom lighting model, to stay inside
  what `MeshStandardNodeMaterial` supports.
- Both apply to L0, L1 and L2 leaves. `tree-viewer.html`'s Leaves panel gets "Normal bulge" and
  "Translucency" sliders; the values ride in the tree's opts (`leaves.bulge`, `leaves.translucency`) so
  species can carry them and the palette bakes them.
- `tsl-build-check.mjs` builds the new leaf material headlessly; `test-trees-geometry.mjs` asserts the
  bulge normal points outward from the canopy centre for every card.

### 4. Screen-size LOD selection with a budget

Replace "tier by radial distance" with "tier by projected height, under a global budget".

- Kernel: `projected = treeHeight × scale × uFocalPx / dist` (pixels), where `uFocalPx` is
  `0.5 × viewportHeight / tan(fov/2)` uploaded each frame, and `treeHeight` comes from the
  variant's bounding box (a per-variant uniform array, already available via `variantRadius`).
  Tier thresholds become pixel heights `uLodPx0/1/2` (defaults chosen so a 20 m tree at the current
  ring distances lands in the same tier as today: at 1080p with 60° fov, R0 = 60 m → ~330 px,
  R1 = 140 m → ~140 px, R2 = 260 m → ~75 px). The crossfade band from item 1 is expressed in pixels
  too.
- Consequence: a 4 m bush drops to L2 at ~50 m while a 40 m pine stays L0 to ~120 m. Bushes stop
  costing full geometry at ranges where they are a few pixels tall.
- Budget: the host reads back `lod0Instances`/`lod1Instances` (already estimated by
  `computeCullEstimate()`; a real readback exists in `plants-gpu.js`'s `readSurvivors()` pattern)
  and, when L0 exceeds `budgetL0`, scales `uLodPx0` up by a small factor for the next frame; when
  well under, scales it back toward the authored value. A one-pole controller, never a snap, so the
  fade band hides the adjustment. Same for L1.
- `forest-cull.js` `classifyInstance` grows the projected-size path behind the same params object;
  `test-forest-cull.mjs` (new if absent) covers distance and pixel paths agreeing at the reference
  height.
- Hosts: `base-game-forest.js` and `environment-viewer.html` expose either distances or pixel sizes
  in their panels — the panel shows both, editing one recomputes the other for a reference 20 m tree,
  so the existing "LOD 0 to 1 (m)" sliders keep meaning something.

## Steps

- [ ] 1. `impostor-atlas.js` mapping + test (pure, no GPU).
- [ ] 2. Crossfade kernel write + `rec1.y` fade + Bayer discard in all forest materials;
  `forest-cull.js` mirror; `setLodFadeWidths`; tree viewer + Base Game sliders; `fadingInstances`
  estimate. Judge in `fill` layout.
- [ ] 3. `impostor-bake.js` (albedo + normal/depth atlases); environment viewer and
  `tree-lod-preview.js` bake through it; IndexedDB key bump.
- [ ] 4. Impostor material in `forest-gpu.js` (three-tap octahedral, relit, depth offset); remove
  `uBillBrightness`; Base Game enables the rung.
- [ ] 5. Leaf `shadeNormal` + translucency in `trees.js`, palette, forest materials, tree viewer
  sliders; `tsl-build-check.mjs` and geometry test.
- [ ] 6. Projected-size selection + budget controller; panel shows metres and pixels.
- [ ] 7. Docs: `vegetation.md` (kernel, palette, materials), `base-game.md` panel rows,
  `agent_log.csv` one row per step.

## Validation

- Headless: `test-forest-cull.mjs` (fade weights sum to 1 across a band; pixel-size and distance
  paths agree at the reference tree), `test-impostor-atlas.mjs` (cell ↔ direction round trip,
  three-tap weights sum to 1), `test-trees-geometry.mjs` (bulge normals outward), `tsl-build-check.mjs`
  for every changed material, plus the existing `test-forest-palette-startup.mjs` /
  `test-base-game-forest.mjs`.
- Viewer: `fill` layout at each ring with the readout's per-tier counts; a slow orbit should show no
  pop at any ring, impostors turning with the camera and relighting with the Sun slider, canopy
  shading changing with sun azimuth.
- Perf: `?prof=1` in `base-game.html` before and after each step with the same seed and camera;
  report per-pass GPU ms and `lod0Instances`, not total fps.

## Open questions

- Fade band in metres or in pixels once item 4 lands? Pixels is consistent; metres is what the
  current sliders mean. The plan does pixels and converts for display.
- Impostor depth offset writes `gl_FragDepth`-equivalent; WebGPU allows `frag_depth` but it disables
  early-Z for that draw. Acceptable for a far rung; measure.
- `n = 8` atlases at 2048² are 16 MB per variant pair with 2 variants × up to 6 species. Fine for
  desktop; a low setting uses `n = 4` at 1024².
