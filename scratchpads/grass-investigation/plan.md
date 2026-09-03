# Grass fix plan (draft, 2026-09-03)

Companion to `report.md`. Six phases, each one shippable on its own, each with its own test and its own
check for your eyes. Every new knob is a uniform setter with a default equal to today's behaviour, so
`environment-viewer.html` (the other `grass-compute.js` consumer) does not change unless it opts in.
Nothing below narrows a slider range.

Legend: M = mechanical (the code and the pattern already exist), U = uncertain (needs a design call or a
browser answer), lines are rough.

## Phase 0. See what the grass is doing (no behaviour change)

Goal: every later phase can be judged from the panel, and the ground-colour path has a test.

- `test-grass-wgsl-build.mjs` (new, ~120 lines, M): promote `scratchpads/grass-investigation/wgsl-build.mjs`.
  Builds the cull kernel and blade material to WGSL through `WebGPUBackend.prototype.createNodeBuilder` over
  the flora rig. Asserts: 5 `textureSampleLevel` in the cull, storage read plus flat `instance_index` varying
  in the fragment, no `textureLoad` fallback for the colour maps. Fix the stale header of
  `test-flora-tsl-build.mjs`.
- Ground-colour probe (`grass-compute.js` +40, `base-game-flora.js` +25, M): one-thread compute kernel that
  evaluates the injected ground node at the camera xz and writes rgb + height to a 16-byte storage buffer;
  `renderer.getArrayBufferAsync` once a second. Panel shows a swatch, the hex, and a CPU twin from
  `splatWeights` x layer averages so a wrong sample is a number, not an opinion.
- Live blade count (`grass-compute.js` +15, M): read the indirect buffer's instance count the same way.
  Panel: "N blades drawn of M expected, cap C".
- Cover under the player (`base-game.html` +10, M): `terrain.coverAt(x, z)` -> "cover here 0.42, so 5.0 of
  the 12 blades/m^2 you asked for".
- Panel line fixes (M): show `groundTint.available`, whether the sample reads textures, the PLACEMENT window's
  coverage as well as the contact one, and replace "the far edge truncates" with what happens (Phase 3 makes
  the old sentence true).
- Two one-line bugs (M): the mip slider forces a recull; the flora waits for the ground TEXTURES to load
  before building, not merely for `groundColorReady`, so grass started with textures off does not bake the
  fallback averages for the session.

Check: run the test; in the page, the swatch should be the colour of the ground under you.

## Phase 1. Blades take the ground's colour

Goal: at tint 1 and reach 1 a blade IS the ground colour under it, lit the way the ground is lit.

- Colour graph (`grass-compute.js` ~30 lines changed, M): the x1.1 key/ambient factor and the cloud-noise
  term multiply the palette side only: `mix(palette * light * cloud, ground, tintAmt)`. Today they multiply
  the blend result, so the ground part is always 10 % too bright and blotchy.
- Normal (`grass-compute.js` +10, M): blend the lit normal toward the ground's up normal by the same
  `tintAmt`, so a ground-coloured blade does not carry a 65 % face-normal that lights differently per yaw.
  Expose grass-look's `faceNormalMix` too (base-game never calls `setLook`; +15 lines panel).
- UV phase (`base-game-flora.js` 3 lines, U: confirm the terrain's `positionWorld` really is render-local):
  sample the splat maps at render-local xz, the same frame the terrain material tiles from, while still
  passing global height to the weights.
- Colour mode select (`grass-compute.js` +25, `base-game.html` +8, M): `grassColorMode` =
  `palette | ground | proof`. `ground` is tint 1 / reach 1 shorthand. `proof` outputs the raw sampled ground
  colour with the ground normal and the terrain's roughness and nothing else; blades should disappear into
  the terrain. That is the visual demonstration you asked for; the Phase 0 probe is the numeric one.
- Defaults (your call): I would move `grassGroundTint` 0.5 -> 0.8 and `grassGroundTintReach` 0.35 -> 0.7 and
  `grassGroundTintMip` 4 -> 6 (25 cm texels, a footprint average rather than a 6 cm speck). Ranges unchanged.

Test: `test-grass-wgsl-build.mjs` asserts that in `proof` mode the fragment output references no palette
uniform. Check: `proof` mode in the page.

## Phase 2. Fade you can shape

Goal: separate knobs for where grass thins, how it thins, and where it takes the ground colour.

New uniforms in `grass-compute.js` (+60 lines, M), each with a setter and a slider in `base-game.html`
(+40 lines) and a key in `FLORA_APPLY_KEYS`:
- `fadeStart` (today's `cullStart`), `fadeEnd` (new; default = radius, so today), `fadeCurve` (power on the
  ramp, default 1).
- `fadeHeight` 0..1: blades shrink toward the ground across the band (the `grass.js` `grassFadeKeep` idea,
  applied in `posNode`); 0 = today's coin flip only. `fadeWidth` 0..1 likewise for width.
- `tintFadeStart`, `tintFadeEnd`: the ground-tint ramp on its own; default = the keep ramp.
- `nearFadeStart`, `nearFadeEnd`: blades within a few metres of the camera shrink (first-person clutter).
- `handoverDistance`, `handoverBand`: the existing `uNearEnd` / `uFadeBand` uniforms in `base-game-flora.js`,
  wired into `apply()` instead of baked at build.

Test: extend `test-grass-compute.mjs` with the CPU twin of the keep/height curves (like `grassFadeKeep`).
Check: turn `fadeHeight` up; the far edge should taper instead of speckle.

## Phase 3. The divide, and knowing what the sliders mean

- Ring-ordered dispatch (`grass-compute.js` ~40 lines, M with one INFERRED assumption): map thread index to
  window cell in square-ring order from the camera outward, so the atomic counter fills near-to-far and the
  instance cap truncates at the outer ring instead of along a row. Assumes workgroups run roughly in index
  order, which is how GPUs schedule but not a guarantee.
- Distance-tiered blade budget (`grass-compute.js` +50, `base-game.html` +10, M once rings exist): two or
  three ring tiers with their own blades-per-cell, so raising the radius thins the far tier and not the
  grass at your feet. Cumulative thread counts per tier are uniforms; the kernel finds its tier with three
  comparisons.
- Residency texture (`terrain-field-window.js` +30, `terrain-clipmap-window.js` +10, M): a tiles-per-side^2
  u8 texture that says which tiles have landed; `gpuSampler` returns the fallback for a tile that has not,
  instead of stale data. Rain benefits too. Test: `test-terrain-field-window.mjs`.
- Cover controls (`base-game-flora.js` +10, M): `grassCoverFloor`, the density fraction kept where cover is 0
  (default 0 = today), beside the existing gate.

Check: the panel's blade count, expected count and cap now agree with what you see; the truncation line is
gone at radius 300 / density 30.

## Phase 4. Draw less, draw cheaper

- Cone cull in the kernel (`grass-compute.js` +40, M): copy `forest-gpu.js`'s cone test with a margin;
  reculls on move > `recullMoveDist` OR heading > `recullHeadingDeg` OR dirty, replacing the 2 m cell test.
  Both thresholds and the margin exposed; margin must cover the heading threshold (same coupling warning as
  the forest). An on/off toggle so you can A/B the frame rate.
- `grassShading` select (`grass-compute.js` +20, M): `standard | lambert`. Roughness is already 1.
- `grassReceiveShadow` toggle (2 lines, M).
- Buffer and per-cell cap sliders (`base-game-flora.js` +30, U): `grassBufferMB` and `grassKmax` rebuild the
  grass on change. `grass-compute.js`'s `dispose()` already frees the storage buffers through
  `renderer._attributes`, a private API; the flora header saying otherwise is stale. If that path fails in
  the browser the fallback is "takes effect on reload".
- Recull GPU time (`base-game.html` +15, U): `renderer.trackTimestamp` plus `resolveTimestampsAsync(COMPUTE)`
  gives the recull's GPU milliseconds; the draw cost stays an fps reading with the cone toggle.

Check: fps with the cone toggle on and off at your usual settings.

## Phase 5. Far blades stand on the drawn ground

The largest piece and the real fix for distance patchiness. Two routes; I recommend the first.

- Rendered height map (`base-game-flora.js` +120, new `grass-height-capture.js` ~150, U): an orthographic
  camera above the player renders the terrain group into an r32float target with an override material whose
  output is `positionWorld.y`, re-rendered when the player crosses a tile or chunks arrive
  (`residencyRevision`). The blade height node samples it (textureLoad + bilinear, as the field sampler does).
  This is the drawn mesh in every terrain mode, heightfield or volumetric, and it retires the contact/placement
  handover. Cost: one terrain-only draw of ~100 chunks at 2048^2 on move. Unknowns: the r32float target on
  WebGPU (renderable, not filterable, hence textureLoad), and cave roofs winning over cave floors in volumetric
  worlds, which the current field has too.
- Clipmap textures (heightfield mode only, `base-game-flora.js` +60, M): sample the rings' existing height
  DataTextures (`terrain-clipmap.js:120,146`). Cheaper, but nothing for volumetric worlds.
- Either way `grassHeightSource` = `field | drawn` so you can compare.

Test: `check-height-mismatch.mjs` becomes the regression for `field`; for `drawn` there is no headless
answer, only your eyes and the Phase 0 probe height beside `terrain.groundHeight`.

## Every phase
- Update `docs/subsystems/vegetation.md` (grass-compute API, base-game section, the corrected truncation
  text) and append to `agent_log.csv`.
- Snapshot the touched files into `versions/` first.
- New settings persist through the existing base-game settings file, not `localStorage`.
