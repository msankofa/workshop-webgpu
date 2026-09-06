# Forest occlusion culling: hierarchical depth against terrain and structures

Date: 2026-09-06. Status: SUPERSEDED 2026-09-06 by `docs/superpowers/plans/2026-09-06-base-game-hiz-occlusion.md`
(workshop-webgpu-1c), which builds the hierarchical-Z pyramid from the main pass depth instead of a
second marked-occluder render. Kept for the sphere test and grass bias notes that plan cites.

Item 5 of the 2026-09-06 review: every tree inside the cone and draw radius is drawn, including
those behind hills and buildings. This plan gives the forest cull a depth test the way the grass and
plant culls already have one, then widens the occluder set to the terrain and adds the hierarchy that
makes it correct for objects larger than a pixel.

## Goal and constraints

Reject a tree in the cull kernel when its whole bounding sphere lies behind an occluder already
drawn this frame, so hidden trees claim no draw slot and cost no vertex work. Keep the false-negative
rate at zero: a tree that is even partly visible must survive. Base Game first; the environment
viewer picks it up through the same `forest-gpu.js` option.

- `flora-occlusion.js` already renders occluder depth for the grass/plants culls. Its 256² buffer
  stores linear view depth of the meshes on `OCCLUDER_LAYER`, drawn with an override material, with a
  `bias` and a static cache. Trees reuse it rather than growing a second occlusion system.
- Grass tests one point per blade. A tree is tens of metres tall and its footprint spans many
  buffer texels; a single-texel test is wrong in both directions (a trunk peeking over a ridge would
  be culled, a tree whose base is hidden but crown visible would be culled). Hence the hierarchy.
- The occluder pass must not include the forest itself, or trees would occlude each other with
  last frame's positions and flicker on movement. Terrain and concrete only.
- The forest cull already runs one compute per frame; the depth test is a few texture reads inside
  the `live` branch, before the LOD chain and before any `atomicAdd`.

## Current state

- `flora-occlusion.js`: `createFloraOcclusion({ renderer, scene, camera, size, layer, bias, cacheStatic })`
  → `state` (depth texture + view-projection uniform) consumed by `grass-compute.js` and
  `plants-gpu.js`. Occluders are marked per rebuild with `markOccluders(root)`; in Base Game that
  is the spawn building's concrete. The base-game CDLOD terrain is **not** an occluder today.
- `forest-gpu.js` has no occlusion input. Its cull kernel has `farLive`, `coneLive`, then the LOD
  chain. `forest-cull.js` mirrors the classification and is not imported.
- Another session (2026-09-05) verified grass occlusion cannot cull trees — there is no path from
  the occlusion state into the forest kernel.

## Design

### Stage A: point test, structures only (small, proves the plumbing)

- `createForestGPU` accepts `occlusion: occ.state`. When present the kernel projects the tree's
  base position lifted by half its height (`y + 0.5 × treeHeight × scale`) with the occlusion
  view-projection, reads the occluder depth at that texel, and rejects when the tree's *nearest*
  sphere point (`dist − radius`) is deeper than the stored depth plus bias. Nearest point, not centre,
  so partial visibility survives.
- `computeCullEstimate()` gains `rejectedOccluded`; the Base Game tree panel shows it next to
  `rejectedFrustum`.
- `forest-cull.js` gets `occludedBySample(rec, cam, depthAt, params)` with the same maths against a
  CPU depth sampler; the test feeds a synthetic wall.

### Stage B: terrain as an occluder

- Base Game adds its CDLOD terrain mesh to `OCCLUDER_LAYER`. The occluder pass then draws the ground
  with the depth-override material — the whole visible terrain each frame at 256² (or 512² for
  trees, see below). CDLOD selection already limits it to the visible patches.
- Because the terrain is drawn every frame, `cacheStatic` stays off for the terrain layer; the
  concrete cache is unaffected.
- Grass and plants gain terrain occlusion for free (blades behind a ridge). Their bias must be
  rechecked: grass sits *on* the terrain, so a blade's own ground would occlude it without a bias
  that exceeds the depth quantisation at the horizon. The plan raises grass `bias` per distance
  (`bias + dist × 0.004`) rather than globally.

### Stage C: hierarchical depth (HZB) and a conservative sphere test

- `flora-occlusion.js` builds a mip chain of **maximum** depth over the occluder buffer after the
  pass (a small compute per mip, 512² → 1²). Max, not min: a texel at level `n` says "everything
  behind this depth is hidden over this whole footprint".
- The forest kernel projects the tree's bounding sphere to a screen-space rectangle, picks the mip
  where that rectangle covers at most 2×2 texels, reads the four texels, takes the **maximum** of
  their max-depths (the farthest surface under any of them), and rejects only if the sphere's nearest
  point is deeper than that. This is the standard conservative HZB test; a tree with any visible pixel survives.
- Grass keeps its point test at mip 0 (a blade is smaller than a texel), so nothing changes there
  except the buffer size.
- Buffer size becomes a construction option; trees want 512² so a 20 m tree at 200 m (≈ 60 px at
  1080p) still maps to several texels at mip 0. Cost: the occluder pass draws terrain and concrete
  once more at 512², a small fraction of the main pass.

### Stage D: temporal safety

- Occluders are drawn from this frame's camera before the cull, so there is no one-frame lag for
  static occluders. Moving occluders (doors, vehicles) are not on the layer; if they ever are, the
  kernel's `bias` absorbs sub-metre motion and anything faster is handled by simply not marking it.
- The recull threshold logic (`shouldRecull`) already forces a recull on camera rotation; occlusion
  changes only with the camera, so no new trigger is needed.

## Steps

- [ ] 1. Stage A: `occlusion` option in `forest-gpu.js`, point test, `rejectedOccluded` estimate,
  `forest-cull.js` mirror + test, Base Game passes `floraOcclusion.state` and shows the count.
- [ ] 2. Stage B: terrain on the occluder layer in `base-game.html`; grass/plants bias-by-distance;
  verify blades survive on their own slopes in the Base Game grass debug colour mode.
- [ ] 3. Stage C: max-depth mip chain in `flora-occlusion.js`; sphere-rectangle mip selection in
  the forest kernel; 512² option; `forest-cull.js` mirror with a CPU mip sampler and a test that a
  half-hidden tree survives and a fully hidden one does not.
- [ ] 4. Environment viewer: pass its occlusion state to `createForestGPU` (it has no concrete;
  terrain only) — one line once Stage B exists there too.
- [ ] 5. Docs: `vegetation.md` (`flora-occlusion.js` row, kernel section), `base-game.md`;
  `agent_log.csv`.

## Validation

- Headless: `test-forest-cull.mjs` occlusion cases (wall in front → rejected; wall behind → kept;
  crown above ridge → kept; sphere straddling the ridge → kept), `test-flora-occlusion-mips.mjs`
  (max-mip of a synthetic depth image is the true max per footprint).
- Browser: Base Game, stand behind the spawn building and behind a ridge; the panel's
  `rejectedOccluded` should be non-zero and trees should not vanish when a trunk is still visible.
  A debug toggle draws the occluder buffer in a corner (the grass debug already has this pattern).
- Perf: `?prof=1` per-pass GPU ms for the occluder pass, the mip build and the forest cull; instance
  counts before and after when facing a hillside.

## Open questions

- Should the forest's own L0 branches become occluders for trees behind them (a dense wood hides
  most of itself)? Cheap to try by adding the L0 branch meshes to the layer, but introduces the
  one-frame lag on movement; measure the win first.
- 512² for everything or a separate size for trees? One buffer is simpler; grass reads mip 0 either
  way. Start with one buffer at 512².
