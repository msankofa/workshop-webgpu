# Grass in base-game.html: investigation (2026-09-03)

Scope: `base-game.html` -> `base-game-flora.js` -> `grass-compute.js`; terrain side `base-game-terrain.js`,
`terrain-splat-streamed.js`, `terrain-field-window.js`, `terrain-clipmap-window.js`. Ten sonnet agents got the
identical brief (`agent-prompt.md`); their claims were cross-checked against the code and, where possible, measured
headlessly. Labels: MEASURED (a script in this folder produced the number), VERIFIED (exact code read), INFERRED,
GUESSED. Nothing here was seen in a browser.

## New tooling that came out of this

`wgsl-build.mjs` builds the grass cull kernel AND the blade material to WGSL in Node, through the WebGPU backend's
own `createNodeBuilder`, over the same terrain rig `test-base-game-flora.mjs` uses. The repo believed this was out
of reach (`test-flora-tsl-build.mjs` header: "grass-compute.js is a storage-buffer material, so it cannot go through
tsl-build-check"). It works. Output: `wgsl-cull.wgsl`, `wgsl-vertex.wgsl`, `wgsl-fragment.wgsl`.

`check-height-mismatch.mjs` measures how far the 8 m placement field sits from the true ground by distance band.

## 1. Grass colour does not match the terrain

What the code does (VERIFIED, and confirmed by the WGSL build):
- The terrain's ground-colour node (`base-game-terrain.js:755`) mixes the vertex tint with a splat sample
  (`terrain-splat-streamed.js:135`, five `textureLevel` reads at a fixed mip) by `uGroundSplatMix`.
- `base-game-flora.js:150-167` wraps it with a central-difference slope from the 8 m field and hands it to
  grass-compute, which evaluates it ONCE PER SURVIVING BLADE inside the cull kernel and packs the rgb into the
  instance record (`grass-compute.js:380-382`).
- The fragment stage reads the record back through a read-only storage buffer and a flat `instance_index`
  varying (`wgsl-fragment.wgsl:24,269`) and blends it in at `grass-compute.js:460-469`.
- Headless WGSL: the cull kernel contains the 5 `textureSampleLevel` calls with samplers bound; the fragment
  reads the record. The graph is structurally complete. In the rig `stats.groundTint.available === true` and
  `groundColorSamplesTextures === true`.

Why it does not read as "matching" (VERIFIED):
- `tintAmt = uGroundTint * mix(rootW, 1, edgeT * uGroundTintFar)`, `rootW = 1 - smoothstep(0, reach, t)`.
  With the defaults (tint 0.5, reach 0.35) only the bottom 35 % of a blade gets at most 50 % ground colour; the
  top 65 % is pure grass palette until the draw edge. From eye height you mostly see tips. This is the
  "top/bottom albedo" design and it is working as written; it is weak by construction. (All agents agree.)
- On top of the ground colour the blade multiplies `uAmbient + uKey` (1.1) and a cloud-noise term (0.65..1.0)
  that the terrain never sees, then a different normal (view-up blend) and roughness 1. Even at tint 1 / reach 1
  the field would be 10 % brighter, blotchier and lit differently than the ground under it.
- The sample is at a fixed mip 4 of a 1024 px map tiled over 4 m: 6 cm texels. That is not a footprint average;
  each blade takes a random 6 cm patch. The sample uses GLOBAL xz while the terrain material tiles from
  `positionWorld` (render-local), so once the origin has moved the texel under the blade is not the texel it reads.
- The mip slider (`grassGroundTintMip`) changes a uniform that is only read during a recull, and `apply()` does
  not force one (`base-game-flora.js:303`; only the cover gate forces). It looks dead until the next 2 m step.
  (Agent 7.)

Agent claims refuted:
- "textureLevel in compute may skip the sRGB decode" (agent 5): the decode is the texture format
  (`rgba8unorm-srgb`, three.webgpu.js:74295) shared by both stages; TSL only adds a shader decode for video
  textures (`needsToWorkingColorSpace`, three.webgpu.js:62826). No mismatch.
- "the compute build may silently fail" (agent 2): it builds; see above. WebGPU bind-time validation is the one
  thing Node cannot exercise.

Trap that can silently disable it (VERIFIED, not the default path): the terrain caches its ground node on first
call and `createSplatSampleNode` captures `ready` at construction. If ground textures are OFF in the saved
settings at boot, `groundColorReady` is true immediately, the node is built on the fallback averages, and nothing
ever re-points it (nobody calls `setTextures`; `setSplatMaterial` only re-syncs numbers). Turning textures on later
mixes toward those averages.

A verified way to prove the sampling works:
1. Node: the WGSL build above asserts the path exists (worth becoming `test-grass-wgsl-build.mjs`).
2. Page: a "ground colour proof" toggle that renders each blade as the raw sampled ground colour with no palette,
   no 1.1, no cloud term, and the ground's own normal. Blades should vanish into the terrain; any blade you can
   still pick out is a sampling error. That is the visual test.
3. Page: a readback probe. After a recull, `renderer.getArrayBufferAsync(instAttr)` for the nearest blade, and
   print its stored rgb beside a CPU twin (`splatWeights` x the layer averages at that xz) in the runtime line.

Already solved elsewhere: no other page tints grass from the ground; environment-viewer's compute grass never
passes `groundColorNode`. `soil-shade.js` and `grass-look.js` do root darkening, not colour matching.

## 2. Patchy in the distance

MEASURED (`check-height-mismatch.mjs`, analytic terrain, the base-game default source; heightfield mode, which is
what base-game runs with the analytic source because volumetric needs a v5 `densityAt`):

| band | field minus true ground p5 / p50 / p95 | blades > 0.5 m under | > 0.3 m floating |
|---|---|---|---|
| contact 0-60 m (1.25 m posts) | -0.04 / 0.00 / +0.04 m | 0 % | 0 % |
| placement 70-600 m (8 m posts) | -0.7 / +0.35 / +3.5 m | 10 % | 52 % |

Beyond `nearEnd` (about 60 m, `safeRadiusFor(contact) - grassNearFade`) blades stand on the band-limited 8 m field,
which the terrain module itself says "decides where things go, never where they sit" (`base-game-terrain.js:450`).
Half the far blades hover 30 cm or more above the mesh; a tenth are buried past half a blade. That is the
patchiness, and the 60-70 m handover ring is a visible edge around the player. No agent measured this; agent 5
named it.

Contributing (VERIFIED): the edge fade is a per-blade coin flip (`keepRand > edge`), so the last 20 % of the radius
is salt-and-pepper rather than a taper. `grass.js` (the CPU path) collapses blade HEIGHT over `fadeStart..fadeEnd`
instead (`grass.js:453-459`, `grassFadeKeep`); the compute path never adopted it.

Transient (VERIFIED): at spawn the 2 km placement window streams nearest-first at 6 tiles per update; until the
tiles land, blades past the ring read the missing sentinel and are dropped. Self-heals. The panel's "field N %
streamed" reads the CONTACT window's coverage, not the placement window's, so it can say 100 % while this is
happening. (Agent 7.)

Precedent (VERIFIED, agent 10): trees hit the same thing. `docs/subsystems/vegetation.md:215-218` records the 8 m
posts "up to 3.65 m off the drawn surface on slopes" (my p95 is +3.5 m) and `base-game-forest.js:14,189` reads
`terrain.groundHeight` per tree instead. Trees are CPU records, so that fix does not transfer as-is; grass needs
a GPU-readable height of the drawn surface.

Fix direction: give far blades the height the mesh actually has. In heightfield mode the clipmap rings already
hold their heights as DataTextures with a bilinear TSL read (`terrain-clipmap.js:120,146`); that is the rendered
mesh. Alternatively cap the default radius at the contact reach until that exists, and add the height taper.

## 3. Density varies; a sharp divide appears when entering dense areas

Three real mechanisms, all VERIFIED; which one the user sees depends on their sliders.

a) Buffer truncation is positional, not radial. Survivors are appended by an atomic counter in dispatch order,
   which is a row-major sweep of the square window (`grass-compute.js:341-352,374-376`). When the count passes
   the 3M instance cap the remaining ROWS get nothing: a straight line across the world that moves with the
   player. The runtime line and `docs/subsystems/vegetation.md:159` say "the far edge truncates"; that is false.
   When it bites (upper bound before cover, thread budget 8M): radius 300 / density 30 wants 5.1M of 3M;
   radius 600 / density 12 wants 5.1M of 3M. Entering a high-cover area raises survivors, so the line moves
   closer. (Agent 8 found this independently.)
b) Cover is a hard biome table (`flora-field.js:16-21`, `BIOME_GRASS`) on a nearest-sampled biome id, blurred
   over one 8 m post. Density genuinely steps at biome borders. The slider is a ceiling; the visible density is
   slider x cover, and the panel never shows the cover under the player (`terrain.coverAt` exists on the CPU).
c) Unstreamed texels read STALE data. On recentre the toroidal window only drops tile keys; the arrays keep
   whatever was there (`terrain-clipmap-window.js:66-76`; only `clear()` zeroes), and the GPU sampler's `inside`
   test is index bounds only (`terrain-field-window.js:120-144`). At walking speed the missing strip stays
   beyond the 70 m contact reach; in a vehicle it does not. (Agents 5, 6, 8 said "zero"; it is stale-or-zero.)

Also: the thread budget divides evenly over the whole window (`syncPerCell`), so raising the radius thins the
grass at your feet; and the density slider has no readout of the real count (the indirect buffer is GPU-side;
one `getArrayBufferAsync` a second would give it).

## 4. Poorly optimised

VERIFIED cost structure:
- Recull: every 2 m cell crossing, full-window rebuild of `side^2 x perCell` threads (default 57^2 x 48 = 156k;
  at radius 600 the 8M budget). `computeAsync` only awaits renderer init, so it is not a GPU sync point (agents
  2/5/6 overstated "blocks the frame"); the cost is encode plus the GPU pass.
- Draw: no frustum cull at all. Every surviving blade in the full disc is drawn every frame, behind the camera
  included, with a MeshStandard PBR fragment, shadow receive, an atlas sample and a storage read, double-sided.
  Roughly 60-70 % of blades are outside a 75-degree view. `forest-gpu.js` does the cone cull with a margin and
  reculls on move > 1.5 m OR heading > 2 degrees (`forest-gpu.js:935-975`); grass has neither.
- Ground colour is 4 field reads + 5 texture samples per surviving blade per recull; agent 4 called this the
  dominant cost. INFERRED: it is not; it runs once per 2 m, the draw runs every frame.
- Not exposed: `grassBufferMB` (3M blades), `grassKmax`, `cellSize`. All construction-time.
- GPU timing: `passGrassMs` is CPU time around `flora.update`; the user has no number for the grass GPU cost.

Order of expected gain (INFERRED, unmeasured): frustum cone in the cull with forest-style recull thresholds;
a Lambert-class material for blades (roughness is 1 anyway); shadow receive off past N m; distance-tiered blade
budget instead of uniform division of the thread budget.

## 5. The fade band is one slider

VERIFIED: `grassCullStart` sets where a linear ramp begins; it ends at the radius. The same ramp drives the keep
probability AND the tint-to-ground (`edgeT`), so they cannot be tuned apart. There is no curve shape, no height
or width taper, no near fade, and the contact-to-placement height handover (`grassNearFade`, 10 m, and
`nearEnd`) is a second fade the panel never shows. `grass.js` has independent `setFade(start, end)` with a height
collapse; environment-viewer's compute grass has the same single knob as base-game. (All agents agree.)

Controls worth adding: fade start, fade end (independent of draw radius), curve power, height taper amount,
width taper, tint ramp start/end separate from the keep ramp, near fade, near-window handover distance and band.

## What only the browser can answer
- Whether the tint is visible at all today at the user's settings (the maths says weak, not absent).
- Which of 3a/3b/3c the user's "sharp divide" is; the runtime line's "truncating" flag decides 3a.
- Actual grass GPU milliseconds.
