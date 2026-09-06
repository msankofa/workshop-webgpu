# Base Game: hierarchical-Z occlusion for grass and trees

Date: 2026-09-06. STATUS: planned, not started. Supersedes phases 3 and 4 of
`2026-09-05-base-game-flora-occlusion-everywhere.md`; phases 1 and 2 stay as they are until step 5
here removes them.

## Why

Today's occlusion (`flora-occlusion.js`) is a second scene render at 256 px with an override
material, into which only meshes a page has marked will draw. It cannot hold anything placed by a
shader position node (the forest, the far clipmap rings), only the grass reads it, and it hides the
terrain-versus-field height mismatch behind a bias that a person has to tune. Under volumetric
terrain it is switched off (`ba95aa4`), because the surface-height field the blades stand on and the
marching-cubes mesh disagree.

The way shipping engines do this is a hierarchical depth pyramid built from the depth buffer the main
pass already produced. Everything opaque in the frame is an occluder for free: heightfield chunks,
caves, the building, the lab, scattered structures, tree trunks and leaves. One compute kernel tests
each candidate's bounds against the level of the pyramid whose texel matches the bounds' footprint.
Grass and trees share it. This plan builds that.

## What must stay true

- No new scene render. The depth comes from the main pass. The current second render goes away.
- Grass and forest cull kernels keep their existing structure and stats. Only the visibility test
  changes, and `forest-cull.js` (the CPU twin) gets the same test so it stays testable in Node.
- Shadow-list instances (`forest-gpu.js`, `SHADOW_LAYER`) are never occlusion-culled, or a hidden
  tree stops casting its shadow across the wall that hides it.
- A page that turns occlusion off gets exactly today's frame back, including the direct
  `renderer.render` path with no full-screen pass.
- A candidate that is truly under the rendered ground is culled. That is honest, and it exposes
  placement height errors instead of hiding them behind a bias (see "Volumetric terrain").

## Where the depth comes from

`base-game.html` renders one of two ways (line 6780): through the `RenderPipeline` whose
`pass(scene, camera, { samples: 4 })` already exists for depth of field and the vision modes, or by
direct `renderer.render(scene, camera)`. The swap chain's depth is not readable in WebGPU, so the
pyramid needs the pass.

- When occlusion is on, the pass path runs every frame. Its output node stays what it is now; the
  extra cost is the full-screen copy that the direct path avoids, and the profiler's `postRender`
  slot already measures it. Step 1 measures that cost before anything else is built; if it is more
  than about a millisecond on the user's machine, the fallback is a dedicated depth-only prepass of
  the opaque scene at half resolution, which is more code and drops the "no new render" promise.
- Depth is read with `scenePass.getViewZNode('depth')` (r184 has it). The pass is multisampled; a
  multisampled depth attachment cannot be sampled directly. Step 1 also settles whether three
  resolves it for the node or whether the pass needs `samples: 0` while occlusion is on. Either
  answer is fine; the plan must not assume one.

## The pyramid

New pure-ish module `hiz-pyramid.js`:

- `createHiZ({ renderer, depthNode, width, height, levels })`. Level 0 is linear view depth at half
  the frame resolution, copied from the pass depth by one compute dispatch. Each further level is a
  2×2 max reduction (farthest depth, so a candidate is only culled when every texel it covers is in
  front of it). Levels are `StorageTexture`s written with `textureStore`; three has both.
- `update()` runs the reduction chain as one `computeAsync([...])` submit, after the render, so the
  pyramid describes the frame just drawn. It records `viewProj` and the camera position of that
  frame, because the cull tests against last frame's image.
- `state`: `{ enabled, textures[], viewProj, invViewProj, texel[], width, height, revision }`.
  The cull kernels read it the way they read `occlusion.state` today.
- Cost: for a 1920×1080 frame, level 0 is 960×540 and the whole chain is about 700k texel writes.
  Measure it as its own profiler slot, `hiz`.

## The test

One TSL function, `hizOccluded(boundsMin, boundsMax)`, shared by both kernels through a small
module `hiz-test.js` so the two do not drift:

- Project the eight bound corners with last frame's `viewProj`; take the screen rectangle and the
  nearest depth.
- Keep if any corner is in front of the near plane or the rectangle leaves the screen (a candidate
  partly off-screen is never occlusion-culled; the cone test already decides those).
- Pick the level where the rectangle covers at most 2×2 texels, sample those four, take the max.
- Occluded when the nearest bound depth is greater than that max plus the bias. The bias is the
  texel's world footprint at that depth plus a fixed 0.05 m, not a slider: it exists to cover the
  quantisation of the level chosen, nothing else.
- Sample through one `texture()` node per level with `.sample()`, the per-stage binding limit fix
  from `75d9c2a`. Eight levels is eight bindings, within budget; the kernel selects the level by a
  `select` chain, not an array index, because storage texture arrays are not indexable dynamically.

Grass: bounds are the blade's base to its top at `uBladeHeight × 1.2`, a few centimetres wide, as
the current `keepFn` already frames it. Trees: bounds are the instance's base to its height times
scale, and its crown radius, from the palette's per-variant extents that `forest-gpu.js` already
has for its LOD rung.

Because the cull runs before the render (`flora.update`, then `forest.update`, then the draw), it
tests against the previous frame. That is the standard one-frame lag and is invisible for grass. For
trees a tree revealed by a step around a corner appears one frame late. If that pops, the fix is the
two-phase form: draw last frame's survivors, rebuild the pyramid, test the rest. Not in this plan;
see "Later".

## Volumetric terrain

With the pyramid, the ground in the image is the marching-cubes mesh itself, so a blade the field
put below that mesh is under the ground and is culled. That is correct. What is wrong is the blade's
height, and the honest fix is a height source for the grass that comes from the volumetric mesh,
the way roads sample the rendered mesh: a per-chunk surface-height readback from the chunk geometry
the volume provider already holds for collision (`base-game-terrain.js`, `collisionGeometry`), fed
in as the `drawn` height source under volumetric mode. That is its own step here (step 6), because
it is what lets the `Terrain occlusion` gate from `ba95aa4` go away.

## Relation to the forest palette worker plan

`docs/forest/palette-worker-and-bake-cache-plan.md` is planned for the same files. What matters:

- Both edit `forest-gpu.js` and `base-game-forest.js`. The palette plan touches the bake and the
  per-wave publication into `forest-gpu.js`; this plan touches the cull kernel and the
  `createForestGPU` options. Different regions, same files. Run them one after the other, not in
  parallel, and whichever lands second rebases on the first.
- The palette plan serialises geometry per variant per tier. Nothing here adds a tier: the old
  phase-3 idea of a depth-only material per variant is dropped, because the main pass depth already
  contains the trees. So the palette key and binary format need no field for occlusion.
- Per-wave publication changes instance counts mid-bake. The pyramid is rebuilt every frame and the
  cull runs every frame that the camera moves, so there is no invalidation to hook, unlike the
  static cache in `flora-occlusion.js`.
- The palette plan's byte-identical tests must stay green through this plan's kernel edits; the
  kernel never touches geometry.

## Steps

- [ ] 1. Spike, no product code: base-game.html forced through the pass path with occlusion off,
  read `postRender` and total frame time against the direct path on the user's machine; a
  `getViewZNode` read from the multisampled pass into a 1×1 storage texture to learn whether it
  resolves. Result written into this file's STATUS line. Decides pass path versus prepass.
- [ ] 2. `hiz-pyramid.js` + `test-hiz-pyramid.mjs` (a CPU reduction of a synthetic depth image
  asserts the max rule, level sizes and the texel table; the GPU chain is checked in the browser
  through a proof colour mode, see validation).
- [ ] 3. `hiz-test.js` (the TSL test) and its CPU twin in `forest-cull.js` (`occludedByHiZ(rec,
  pyramidSampler)`), with `test-forest-cull.mjs` cases: fully behind a wall culled, crown over the
  wall kept, partly off-screen kept, near-plane straddle kept, bias at the level's footprint.
- [ ] 4. `grass-compute.js` takes `opts.hiz` in place of `opts.occlusion`; `keepFn` calls
  `hizOccluded`; the probe's `occlusion` counter and `lastRecull: 'occlusion'` keep their names.
  `forest-gpu.js` takes `opts.hiz`, tests inside `cull` next to `coneLive`, and skips the test for
  the shadow slot. `base-game-flora.js` and `base-game-forest.js` pass the state through.
- [ ] 5. `base-game.html`: `hiz.update()` after the render inside the profiled region with its own
  mark; `chained` also true while `settings.grassOcclusion` is on; the occluder root list,
  `terrainFloraOcclusionState`, `grassTerrainOccludes`, `grassOcclusionBias`, `remarkOccluders` and
  the `Terrain occlusion` toggle are removed, and the `Occlusion culling` toggle now covers grass and
  trees. `flora-occlusion.js` stays for `bot-flora.js` and `plants-gpu.js`; `base-game-flora.js`
  stops importing it.
- [ ] 6. Volumetric grass height from the chunk mesh (see above), so grass on caves stands on the
  drawn surface. Independent of steps 2 to 5 and worth doing even without them.
- [ ] 7. Docs: `vegetation.md` (occlusion section rewritten around the pyramid; the old
  `setOccluders` rows go), `base-game.md` (render path condition, settings removed, HUD line),
  `infra.md` if the profiler gains a slot; a row in `agent_log.csv` per step; the STATUS line of the
  2026-09-05 plan marked superseded.

Each step is its own commit. Steps 2 and 3 are pure and land safely on their own; step 4 is the
first one a browser can see.

## Validation

- Headless: `test-hiz-pyramid.mjs`, `test-forest-cull.mjs`, `test-grass-wgsl-build.mjs` (the
  kernel still builds), `test-base-game-flora.mjs`, `test-base-game-forest.mjs`, and
  `test-page-syntax.mjs` before the page commit.
- Browser, the user's look: the grass proof colour mode gains a `hiz` view that paints level 0 of
  the pyramid over the frame; standing behind the lab wall, behind a crest, inside a cave mouth, and
  on a hillside facing the camera at a grazing angle. The last one is the case the old bias slider
  was for; with the pyramid it must hold with no slider. Trees: the forest runtime line shows the
  occlusion-culled count; walk around the spawn building and watch trees behind it drop and return
  without a visible pop.
- Numbers to read from the profiler HUD with and without occlusion: `postRender`, `hiz`,
  `floraGpu`, `forestGpu`, total. The plan succeeds if total with occlusion on is at or below total
  with it off in a treed, grassy view, since the culled draws should pay for the pyramid.

## Later, not here

- Two-phase (draw last visible, rebuild, test the rest) if the one-frame lag pops on trees.
- Rocks and scattered props through the same test once `dressing-gpu.js` is wired into Base Game.
- Bot-viewer and the environment viewer: they keep `flora-occlusion.js` until someone wants the
  pyramid there; the modules from steps 2 and 3 are page-independent by design.

## Open questions

- Whether the multisampled pass depth resolves for `getViewZNode` (step 1 answers).
- Level count: eight levels from 960×540 reaches 4×3, enough for a tree's screen rectangle at any
  distance; grass never needs past level 3. Fewer bindings if the grass kernel only binds four.
- Water writes depth in its opaque form; grass under the water plane is already dropped by the
  ground/water test, so no change expected, but check a shoreline.
