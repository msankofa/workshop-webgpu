# HD Planet/Moon Painter + Standalone Stellar Object Viewer — Design

**Date:** 2026-06-30
**Status:** Approved

## Problem

`celestial-bodies.js`'s `paintBody()` paints every planet/moon sprite with a flat radial-gradient
disc, scattered random circles, and a single `gas: boolean` flag — there is no real surface
structure (no continents, no clouds, no ice caps, no lit terminator curve), and only one axis of
variation (gas vs rocky) across all bodies. Two specific defects were found and fixed during a
throwaway noise-based prototype:

1. Gas-giant band turbulence warped the wrong axes, so bands rendered as straight lines instead of
   swirling clouds (measured directional sensitivity ratio 3.16x along the unwarped axis).
2. Crater detail used ridge-noise (`1 - abs(n*2-1)`), which produces a connected vein/streak
   network, not isolated round blobs — the wrong noise transform for the intended shape.

Both are fixed in the validated prototype (see conversation history / scratchpad
`planet-preview.html`). This spec turns that prototype into production code, expands body variety
to match a reference "Halo 1-esque celestial objects" catalog (terrestrial, gas giant, ice, volcanic,
ringed, barren/rocky), and — separately but in the same effort — gives this code a standalone dev
tool so future tuning happens against the real game code, not a throwaway copy.

## Goals

- Replace `paintBody()` with a per-pixel sphere-normal-shaded painter (real Lambertian terminator,
  Fresnel rim glow, fbm continents/clouds/polar caps, Worley craters/cracks/lava veins) for bodies
  large enough on screen for detail to read.
- Add a `kind` axis (`terrestrial | gas | ice | volcanic | rocky`) with per-kind palettes, replacing
  the current single `gas` boolean and shared color list.
- Keep the existing cheap painter for bodies too small on screen for detail to matter (distant
  planets, extra moons) — no regression in per-frame cost for the common case.
- Ship `stellar-viewer.html`, a standalone page that imports the real `sky-field.js` /
  `celestial-bodies.js` modules (no duplicated logic) for browsing generated variety and
  live-tuning the painter's visual constants.

## Non-goals

- Stars / Milky Way are out of scope for the viewer (separate subsystem, separate tool if ever
  needed).
- No change to body placement, count, or orbit/physics — purely visual + a dev tool.
- No real sphere geometry / dynamic lighting (see "Why sprites stay sprites" below) — this is a
  texture-quality upgrade, not an architecture change to how bodies render in the game.

## Why sprites stay sprites

Considered moving the "near" hero planet to a real lit `THREE.Mesh` sphere for true dynamic
lighting/rotation. Rejected: every body sits at a fixed, very large radius and is never approached
or orbited, so there is no parallax to gain, and a lit mesh costs a per-pixel shader evaluation
every frame versus a sprite's bake-once-at-spawn cost. The reference catalog image itself is a
static single-frame render per body, so rotation isn't required to hit that look. Revisit only if a
future feature needs the camera to actually approach a planet.

## Data model changes — `sky-field.js`

`generateCelestialBodies(radius, palette, rng)` keeps its existing signature (no new params; the
`rng` already passed in drives the new choices, preserving the existing determinism-per-seed
contract relied on by `test-sky-field.mjs`).

### `kind` replaces the `gas` boolean

```
const PLANET_KINDS = ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'];
const KIND_WEIGHTS  = [0.28, 0.22, 0.18, 0.12, 0.20]; // sums to 1; tunable, not load-bearing
function pickKind(rng) { ...weighted pick over PLANET_KINDS... }
```

Every body descriptor (`moon`, `planet` distant, `planet` near, companion `moon`) gets a `kind`
field. Moons typically roll from a restricted subset (`ice | rocky`) since "gas moon" or
"terrestrial moon" don't read as sensible; near/distant planets roll from the full set.

### Per-kind palettes replace `PLANET_COLORS`

```
const KIND_PALETTES = {
  terrestrial: ['#2f5d8a', '#3a6e4f', ...],   // ocean/land base hues
  gas:         ['#b07a55', '#7d8aa0', ...],   // existing PLANET_COLORS, kept for this kind
  ice:         ['#dce8f2', '#c9d8e8', ...],
  volcanic:    ['#33201a', '#4a2a20', ...],
  rocky:       ['#9a958c', '#8a7f6e', ...],
};
```

`pick(KIND_PALETTES[kind])` replaces the current flat `pick(PLANET_COLORS)` call at each body's
construction site.

### `detail` flag (cheap vs HD painter)

```
out.push({ ..., detail: 'high' });  // near planet + its companion moons
out.push({ ..., detail: 'low' });   // distant planets + extra moons
```

Set directly at each body's push site (the near/distant/companion/extra distinction already exists
in the function — this just labels it) — no new geometry math needed.

## Painter changes — `celestial-bodies.js`

### Two painters, dispatched by `body.detail`

- `paintBodySimple(body, canvas)` — today's existing `paintBody()`, unchanged, renamed. Used for
  `detail: 'low'` bodies (a few px on screen — noise detail would be invisible).
- `paintBodyHD(body, canvas, seed)` — the validated prototype painter. Used for `detail: 'high'`
  bodies. Per `body.kind`:
  - **terrestrial**: fbm continent mask (land/ocean), biome color variance, polar ice caps
    (`smoothstep` on `abs(ny)`), separate cloud noise layer, Blinn-Phong ocean specular glint,
    Fresnel atmosphere rim glow.
  - **gas**: domain-warped turbulent bands (warp applied to all three sphere-normal axes, fixing
    the straight-band defect) + one analytic "great spot" storm ellipse.
  - **ice**: Worley **F2−F1** (cell-edge) noise → crack network, Fresnel rim glow (thin pale
    atmosphere).
  - **volcanic**: dark rocky crust (fbm) + Worley cell-edge veins added as **emissive** (not
    multiplied by the lighting term), so lava glows on the unlit side too.
  - **rocky**: fbm continents/lowlands + Worley **F1** (distance-to-point) craters — the
    blob-shaped transform, as opposed to ice/volcanic's edge transform.
  - `rings: true` (existing flag, any kind) still overlays the existing vector-ellipse ring pair —
    unchanged.

A body with `kind` not yet covering "desert/exotic" variants from the reference catalog is
explicitly **out of scope for this pass** — five kinds is the agreed scope; more kinds are pure
palette/threshold additions later and don't need new techniques.

### `PAINTER_TUNING` — exported, mutable, read at paint time

```js
export const PAINTER_TUNING = {
  terrestrial: { cloudThreshold: [0.56, 0.78], iceCapLatitude: [0.74, 0.9], continentThreshold: [0.46, 0.52], specularPower: 50 },
  gas:         { warpAmount: 1.4, warpFreq: 2.5, bandFreq: 6.5, bandThreshold: [0.3, 0.7] },
  ice:         { crackFreq: 4.5, crackWidth: 0.06 },
  volcanic:    { veinFreq: 4, veinWidth: 0.05, hotWidth: 0.025, ambient: 0.12 },
  rocky:       { craterFreq: 5, rimBand: [0.32, 0.22], floorBand: [0.14, 0.05], continentThreshold: [0.42, 0.58] },
};
```

`paintBodyHD` reads these objects each time it paints rather than capturing literals — this is what
lets `stellar-viewer.html` mutate `PAINTER_TUNING.terrestrial.cloudThreshold` directly (same module
instance, no setter API needed) and see the next repaint reflect it immediately. Production code
never mutates this object; it's a tuning surface for the viewer only.

### `createCelestialBodies(bodyData)` — unchanged external signature

Internally dispatches `body.detail === 'high' ? paintBodyHD : paintBodySimple`. `sky.js`'s existing
call site (`createCelestialBodies(generateCelestialBodies(radius, palette, makeRng(0xc0de)))`) needs
no changes.

## `stellar-viewer.html`

Root-level file alongside `environment-viewer.html`, same import map, served by the existing
`python serve.py` (ES module imports + the canvas-texture pipeline don't work over `file://`).

```js
import { makeRng, makePalette, skyRadius, generateCelestialBodies } from './sky-field.js';
import { createCelestialBodies, PAINTER_TUNING } from './celestial-bodies.js';
```

No reimplementation of generation or painting logic anywhere in this file.

### Scene

`WebGPURenderer` + `OrthographicCamera` (deliberate — these are camera-facing sprites; an
orthographic camera means every body in a grid renders at the same scale regardless of grid
position, with no perspective distortion to compensate for). Plain dark background, no lighting
rig needed (sprites are unlit/self-shaded via their baked texture).

### Gallery mode (default)

- Generates N bodies via the real `generateCelestialBodies()` → `createCelestialBodies()` pipeline,
  laid out on a fixed grid of world positions.
- HTML overlay `<div>` labels positioned from the same fixed grid math used to place the bodies (no
  3D→2D projection needed since the camera/grid relationship is static and orthographic).
- Controls: kind filter checkboxes (show/hide per `kind`), **Reroll** button (`makeRng(Date.now())`
  or similar fresh seed), seed text field + **Go** button to reproduce a specific roll.
- Clicking a body switches to Solo mode for that body.

### Solo mode

- One selected body, rendered large and centered.
- Slider panel bound to the `PAINTER_TUNING` section matching that body's `kind` (e.g. selecting a
  terrestrial body shows cloud threshold / ice-cap latitude / continent threshold / specular power
  sliders). Moving a slider repaints just that body's texture (`texture.needsUpdate = true`) — no
  full-scene rebuild.
- Own Reroll / seed controls, scoped to just this one body (re-rolls only this body's descriptor,
  not the whole gallery).
- Back button returns to Gallery mode.

## Testing

- Extend `test-sky-field.mjs` (existing Node test file, no GPU/DOM dependency) to cover:
  - `kind` distribution: over many seeds, all five kinds appear with roughly the configured weights.
  - `detail` flag: near planet + its companion moons are `'high'`; distant planets + extra moons are
    `'low'`, for every seed.
  - Determinism is preserved: same seed → identical `kind`/`detail`/palette pick, matching the
    existing `generateCelestialBodies(...).length` determinism test already in this file.
- `paintBodyHD` / `paintBodySimple` remain canvas/DOM-only (same status quo as today's `paintBody` —
  not a new constraint introduced by this change) — verified visually via `stellar-viewer.html`
  rather than Node tests, consistent with there being no existing canvas-painting test coverage in
  this codebase today.

## Docs / process

- Update `docs/subsystems/sky.md`: document the `kind`/`detail`/`PAINTER_TUNING` additions to
  `celestial-bodies.js` and `sky-field.js`, and add a short "Dev tools" note pointing at
  `stellar-viewer.html`.
- Append one `agent_log.csv` row for this change (subsystem `sky`).

## Out of scope

- Desert/sand and exotic/alien palette variants from the reference catalog (pure palette/threshold
  additions on top of this scope — no new technique needed, can follow later).
- Ring shadow-casting onto the planet surface (current vector-ellipse rings unchanged).
- Slow rotation / "living planet" feel (would need a wider equirectangular bake + UV pan — separate
  follow-up if wanted).
- Whole-sky (stars/Milky Way) coverage in the viewer.
