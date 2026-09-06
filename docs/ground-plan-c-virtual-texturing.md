# Ground plan C: virtual texturing for the ground

STATUS: planned 2026-09-06, not started. Only worth building after plans A and B, and only if
painted, unique ground detail is wanted across the world. The procedural ground needs none of
this.

## What it buys

- A fixed video memory cost for ground detail no matter how many textures or how much unique
  paint the world carries.
- The splat, height blend, decals and painted strokes evaluated once per tile when it is
  baked, then sampled as a single texture. The runtime ground shader becomes one indirection
  read plus one cache sample.
- Unique detail anywhere: a road's wear, a burn, a footpath.

## Shape

1. **Page space.** The world is a virtual texture of `pages` 128 texels square at every mip.
   Page coordinates come from world X/Z and a texels-per-metre setting (8 texels per metre
   gives 16 mm detail; a 7.7 km world is then a 61k square virtual texture, 480 pages a side).
2. **Feedback pass.** Once per frame, render the terrain into a small target (1/8 screen) with
   a material that writes the page id and mip each pixel would sample. Read it back
   asynchronously (`renderer.readRenderTargetPixelsAsync`) a frame or two later.
3. **Page cache.** One 4096 square physical texture (32 × 32 pages of 128) per map: colour,
   normal, packed. An LRU over page slots. The indirection texture is one texel per virtual
   page at the coarsest resident mip, storing cache slot and mip.
4. **Page baking.** A page is produced on the GPU by rendering the existing splat material
   (plan A's version) into the cache slot with an orthographic camera over that page's world
   rectangle, plus decals and plan B's painted strokes. Nothing is read from disk: the source
   textures are the tiled ground set already resident. That is the difference from a
   disk-streamed VT and the reason this is feasible here.
5. **Sampling.** The ground shader reads the indirection texture at the fragment's page,
   computes cache uvs, samples with a border to hide slot seams, and falls back to a coarser
   page while the requested one bakes.

## Files

- `terrain-vt.js`: page maths (pure, tested), the cache and indirection state, the LRU.
- `terrain-vt-feedback.js`: the feedback material and the async readback.
- `terrain-vt-bake.js`: the page baker (an orthographic pass with the splat material).
- `terrain-splat-streamed.js`: a `vt` binding that replaces the per-pixel splat with the
  cache read when a page is resident, keeping the per-pixel path as the fallback.
- `base-game.html`: a Terrain setting to turn it on, cache size, texels per metre, and a
  stats line for resident pages, bakes per second and readback latency.

## Uncertain parts

- Readback latency on WebGPU. `readRenderTargetPixelsAsync` is one to three frames. Fast
  camera turns will show a coarse mip for that long. Acceptable for a ground, but it needs to
  be seen.
- Bakes per frame. A page bake is a full splat evaluation over 128 square texels, cheap, but a
  fresh camera cut can request hundreds. A budget of a few dozen per frame with coarse pages
  first.
- Anisotropic filtering across page borders. The classic fix is a 4 texel border per page and
  clamped gradients. Gets it mostly right; remaining seams show at grazing angles.
- Interaction with the LOD dissolve and the cascade. Each cascade level is its own mesh with
  its own coverage map; the VT sits on top of whichever mesh is drawn, so the dither stays.

## Why not now

Every benefit above needs something to paint or bake that the procedural rules do not already
produce. Until plan B's painted strokes and plan A's height blend exist, a VT would bake the same
picture the shader draws directly, at higher complexity.

## Verification

- Node: page maths (world to page, mip selection, LRU eviction order).
- Browser: turn it on, spin the camera, and watch the stats line and the ground; a painted
  stroke from plan B appears baked; memory stays flat as more textures are used.
