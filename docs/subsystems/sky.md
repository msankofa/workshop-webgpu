# Sky / Atmosphere Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#sky)

## Purpose

Renders the procedural night/day sky (gradient dome, sun/moon sprite, star field +
Milky Way, extra moons/planets) and a separate overhead cloud layer for the WebGPU
viewer. The sky is pure-math-driven (deterministic PRNG generators with no DOM/GPU
dependency) composed into TSL node materials at build time; clouds are a single
animated TSL-shader quad. Both are optional, lazily-loaded modules that degrade
gracefully if they fail to load.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `sky.js` | Owner module: camera-following group holding the gradient sky dome, sun/moon sprite (locked to scene light direction), and composed star field + Milky Way + celestial bodies. Builds node materials/canvas textures, manages build/rebuild/dispose lifecycle. | 212 |
| `sky-field.js` | Pure-JS math: palette defaults, sky radius, sun/moon placement, deterministic RNG (`makeRng`), star/Milky Way/celestial-body generators, per-kind color generation (`randomKindColor`). No three.js import — this is the Node-tested source of truth. | ~290 |
| `stars.js` | TSL rendering of the star field + Milky Way gas sphere from `sky-field.js` data. GPU-side twinkle via the `time` node. | 105 |
| `celestial-bodies.js` | TSL rendering of extra moons/planets as camera-following sprites. Two painters dispatched by `body.detail`: `paintBodySimple` (cheap, 256px canvas, for distant/tiny bodies) and `paintBodyHD` (512px canvas, per-pixel sphere-normal shading + fbm/Worley surface detail per `body.kind`, dual-hue patch blending, for the near planet + its moons). Rings and glow are separate configurable painters (`paintRings`, `paintGlow`). Visual constants live in exported `PAINTER_TUNING`, mutated live by `stellar-viewer.html`. | ~440 |
| `clouds.js` | `Clouds` class: a `THREE.Mesh` overhead quad with a TSL `MeshBasicNodeMaterial` (two-octave simplex noise → coverage threshold → horizon fade). Independent of sky.js. | 265 |
| `test-sky-field.mjs` (repo root) | Node test script for `sky-field.js` pure functions only. | ~135 |
| `test-celestial-bodies-smoke.mjs` (repo root) | No-GPU smoke test for `celestial-bodies.js`'s real paint dispatch (Proxy canvas stub), one per `kind`×`detail` combination. | ~50 |
| `stellar-viewer.html` (repo root) | Standalone dev tool — see "Dev tools" below. | ~460 |

## Public API

**sky.js**
```js
export function createSky({ scene, camera, size, palette: overrides, sunDir, parts = {} })
```
Returns an object with: `group`, `setSunDir(v)`, `setPalette(o)`, `setCelestialType(type)`,
`setStarCount(n)`, `setSunSize(v)`, `setMilkyWayIntensity(v)`, `setRadius()`, `rebuild(r)`,
`update()`, `flushDisposals()`, `dispose()`, getters `radius` and `isMoon`.

**sky-field.js**
```js
export const DEFAULT_PALETTE
export function makePalette(overrides = {})
export function skyRadius(far, size)
export function isMoonBody(palette)
export function sunSpritePlacement(dir, radius, palette)
export function makeRng(seed)
export function generateStars(radius, palette, rng)
export function generateMilkyWay(radius, palette, rng)
export function generateCelestialBodies(radius, palette, rng)
export const PLANET_KINDS   // ['terrestrial','gas','ice','volcanic','rocky']
export const MOON_KINDS     // ['ice','rocky'] — moons only roll from this subset
export function randomKindColor(rng, kind)  // continuous HSL color generation, not a fixed palette
```

**stars.js**
```js
export function createSkyStars(starData, palette)
export function createMilkyWay(milkyData, palette)
```

**celestial-bodies.js**
```js
export function createCelestialBodies(bodyData)
export const PAINTER_TUNING   // { terrestrial, gas, ice, volcanic, rocky } visual constants, mutable
```

**clouds.js**
```js
export class Clouds extends THREE.Mesh {
  constructor()
  update(elapsedTime, cameraPosition)
  setSpeed(speed)
  setOpacity(opacity)
  setCoverage(coverage)
  setPuff(puff)
  setSoftness(softness)
  setFade(fade)
  setExtent(worldUnits)
}
export default Clouds;
```

## Wiring

Both are lazy, independent dynamic imports inside the big `<script type="module">` in
`environment-viewer.html` — there is no coupling between them; either can fail/load
without affecting the other.

- **Clouds** (`environment-viewer.html` ~line 2082): `await import('./clouds.js')`
  inside a `.then()/.catch()` chain (clouds are optional — catch is a no-op).
  Two independent `Clouds` instances are created (`cloudsRef`, `clouds2Ref`) — two
  cloud layers at different heights/extents/puff sizes (layer 1: height 120, extent
  2000; layer 2: height 280, extent 4000) — both added directly to `scene`. Each gets
  its own `header('Clouds (layer N)')` + `slider(...)` UI block.
- **Sky** (`environment-viewer.html` ~line 2156): `await import('./sky.js?v=sp6d')`,
  gated by `SKY_MODE` (`?sky=` URL param: `off`, `nostars`, `nomilkyway`, `nobodies`,
  `domeonly`, `nomoonlight`, or default `on`). Calls `createSky({ scene, camera,
  size: terrain.size, sunDir: skyLightDir(), palette: skyPaletteOverrides(), parts:
  skyParts })`, adds `skyRef.group` to the scene, then wires `applyCelestialLight()`
  which swaps the warm directional "sun" light vs. a dedicated cool `moonLight`
  (separate `THREE.Light` in the scene, not part of the sky group) depending on
  `params.primaryBody`.
- Inside `sky.js`, `createSky` imports and composes:
  - `sky-field.js` for all placement/generation math (`makePalette`, `skyRadius`,
    `isMoonBody`, `sunSpritePlacement`, `makeRng`, `generateStars`,
    `generateMilkyWay`, `generateCelestialBodies`),
  - `stars.js` (`createSkyStars`, `createMilkyWay`) to turn `sky-field.js` star/Milky
    Way data into `THREE.Points` node-material objects,
  - `celestial-bodies.js` (`createCelestialBodies`) to turn body descriptors into
    sprites.
  - All three sub-modules are versioned with the same `?v=sp6d` query string as
    `sky.js` itself (cache-busting tied together).
- `environment-ui.js` does **not** define sky/cloud parameters. It only hosts a
  tabbed shell (`createEnvironmentUi`) that re-parents whichever `.sec` DOM blocks
  the inline `header()`/`slider()`/`select()` helpers (defined locally in
  `environment-viewer.html` ~line 1548) produced — `effectsNames` includes `'Clouds'`
  and `'Sky'` so those sections route to the "Effects" tab (`environment-ui.js:460`).

## Architecture notes

- **Day/night palette system**: a single `DEFAULT_PALETTE` object in `sky-field.js`
  (this project has one continuous environment, not per-map presets) carries dome
  gradient colors (`top`/`horizon`/`bottom`/`glow`), sun/moon disc colors and size,
  an explicit `celestialType: 'sun'|'moon'` plus an opacity-based fallback inference
  (`isMoonBody`: `sunOpacity < 0.6` ⇒ moon, only used if `celestialType` is unset),
  and star/Milky Way tuning. `makePalette(overrides)` is a defaults-merge, never
  mutates `DEFAULT_PALETTE`.
- **Sun/moon sprite placement**: `sunSpritePlacement(dir, radius, palette)` places the
  disc along the normalized light direction at `0.74 * radius`, with sprite scale
  `radius * sunSize * 2.15 * (moon ? 2.4 : 1)` (moon renders larger than the sun).
  `sky.js` builds **both** sun and moon sprite/discs up front at `build()` time and
  toggles visibility (`updateDiscVisibility`/`setCelestialType`) rather than
  rebuilding — comments in `sky.js` explicitly call out that a runtime
  rebuild/dispose was the cause of a "night freeze" bug (GPU buffer destroyed while
  still referenced by an in-flight submit). The same reasoning drives `setStarCount`
  (draw-range change, not geometry rebuild) and `setRadius` (uniform group scale
  rather than dome regeneration). Disposal of an actually-replaced tree (e.g. on
  `setPalette`/`rebuild`) is deferred via an age-gated `_pending` queue
  (`flushDisposals`, called once/frame by the viewer) so a tree is freed only after
  surviving ≥2 frames past detach.
- **Star field + Milky Way generation**: `generateStars` places points on a
  `0.83 * radius` shell, upper hemisphere only (`y ∈ [0.06, 0.96]`), with 0-3
  reserved Pleiades-like clusters (tight core + looser halo, jittered around a random
  hemisphere direction) when `starCount >= 800`; each star carries twinkle attributes
  (`phase`, `speed`, `strength`) consumed entirely on the GPU. `generateMilkyWay`
  scatters points on a `0.82 * radius` shell along a randomly tilted great circle with
  gaussian-ish off-plane spread, returning `null` when `palette.milkyWay` is false.
  `stars.js` renders both with a shared `buildPoints()` helper; a code comment notes
  WebGPU `THREE.Points` render as 1px primitives (no `pointUV`/`gl_PointCoord`
  equivalent), so size/round-falloff is impossible — twinkle is done via
  brightness/alpha modulation instead, and per-vertex fragment values must be wrapped
  in `varying()`. The Milky Way also gets a dim additive-blended gas sphere
  (`createMilkyWay`'s `gas` mesh) using layered value noise to fake dust-lane texture.
- **Celestial bodies**: `generateCelestialBodies` produces 1-2 extra moons, 2-4
  distant planets, exactly one "near" planet (size ~0.06-0.10 R, may have rings/glow),
  and 1-3 companion moons orbiting near the near planet's screen position — gated by
  the caller on `palette.milkyWay` (i.e. only at night/dusk). Every body also carries
  a `kind` (`terrestrial | gas | ice | volcanic | rocky`, weighted random; moons only
  roll `ice`/`rocky`), a `detail` flag (`'high'` for the near planet + its companion
  moons, `'low'` for everything else), a `color`/`color2` pair, and a `seed` in
  `[0,1)` used to vary the HD painter's noise per body. `celestial-bodies.js`
  dispatches `detail === 'high'` bodies to `paintBodyHD` (real sphere-normal
  Lambertian shading + fbm continents/clouds/polar caps/specular for terrestrial,
  domain-warped turbulent bands for gas, Worley cell-edge cracks for ice, emissive
  Worley veins for volcanic, Worley craters for rocky, plus a Fresnel rim glow for
  atmosphere-bearing kinds) and everything else to the original `paintBodySimple`.
- **Color generation — `randomKindColor(rng, kind)`**: colors are generated
  continuously (HSL), not picked from a small fixed swatch list — an earlier version
  used 5-6 hardcoded hex values per kind, which capped how many distinct colors could
  ever appear (and, for `rocky`, all 5 values happened to sit in the same narrow
  warm-gray band, so random picks looked like "always brown"). Hue is drawn from 8
  hand-placed named-color anchors (red/orange/yellow/green/cyan/blue/purple/pink,
  `HUE_FAMILIES`) with ±14° jitter, each anchor equally likely — sampling raw hue
  uniformly over `[0,360)` was tried first and measured to pick green or purple
  nearly half the time, because those names happen to span much wider raw-degree
  ranges on the HSL wheel than e.g. red or orange. Saturation/lightness are drawn
  from a per-kind range (`KIND_COLOR_RANGE`) so each kind still reads as its category
  (pale for ice, dark/charred for volcanic) regardless of hue. Every body also gets
  an independent `color2` (same generator, same kind) that `paintBodyHD` blends
  toward in noise-driven patches (`pbase`/`phi`/`plo` locals), giving real multi-hue
  surface variety — like Io's sulfur patches or Callisto's mottled terrain — instead
  of only ever varying the lightness of one hue.
- **Rings and glow are separately configurable**, not fixed-appearance flags. A ring
  body carries `ringColor`/`ringTilt`/`ringInner`/`ringOuter`/`ringBandCount`/
  `ringDensity` (all optional, defaulted in the painter); `paintRings` draws several
  concentric bands with gaps and per-band brightness variance (seeded, so it varies
  per body) instead of two fixed-width solid strokes. A glowing body carries
  `glowColor`/`glowRadius`/`glowIntensity`; `paintGlow` is a 3-stop radial gradient
  starting exactly at the disc edge (an earlier version started at `0.78R`, inside
  the disc, which wasted the first ~22% of the falloff on an invisible region and
  made the visible portion start already ~73% of the way to peak brightness — a hard
  bright rim instead of a gradual fade). Both painters draw the ring's `[0,PI)` half
  *before* the disc is painted and the `[PI,2*PI)` half *after*, so the disc's opaque
  pixels occlude whichever half of the ring geometrically passes behind it — without
  this split, the whole ring draws on top every time and both "sides" show at once.
  `ringTilt` covers the full `-PI..PI` range (an ellipse only has `PI` radians of
  visually distinct orientations, but the full range removes any artificial band).
- **Clouds world-space noise fix** (`faa7b1e`, "fix(clouds): sample noise in world
  space to prevent stretching", 2026-06-30): previously the TSL noise was driven by
  the plane's `attribute('uv')`. Because `setExtent(worldUnits)` scales the cloud
  mesh (`scale.set(s, 1, s)` where `s = worldUnits / 2000`) rather than resizing the
  geometry, UV space stays fixed at `[0,1]` across the whole plane regardless of
  scale — so changing extent changed how many world-units one noise cycle spanned,
  visibly stretching the cloud pattern. The fix replaces `uvCoord = attribute('uv')`
  with `uvCoord = positionWorld.xz.div(1000.0)`, i.e. samples noise from the
  fragment's actual world-space XZ position. Since `positionWorld` is unaffected by
  the mesh's `scale` the way UV is, noise frequency is now fixed in world units and
  is scale-invariant.
- **Clouds horizon fade** is also camera-centered: `uCameraXZ` is a `vec2` uniform
  updated every frame from `update(elapsedTime, cameraPosition)`, and alpha divides
  by `length(positionWorld.xz - uCameraXZ) + 1`, so fade always radiates from the
  camera regardless of where in the world it sits.
- **Clouds drift timing**: `Clouds` accumulates its own `_scaledTime` from deltas
  between successive `update()` calls multiplied by `this.speed`, so changing
  `setSpeed` at runtime changes the rate without jumping/discontinuing the noise
  phase.
- **Dev tool — `stellar-viewer.html`** (repo root, served by `python serve.py`, same
  import map as `environment-viewer.html`): imports `sky-field.js`/`celestial-bodies.js`
  directly (no duplicated generation/painting logic) so tuning in this tool changes
  the same code the game reads. Two modes: **Night sky** shows a user-composed
  collection of bodies (generated from a seed, or built up one at a time via "Add
  body") — bodies are view-only here, always forced through `paintBodyHD` regardless
  of their in-game `detail` (this tool exists to showcase/tune the HD painter, unlike
  the game where only the near planet + moons earn that cost). Clicking a body opens
  **Solo mode**, the only place bodies are edited: kind/type/color/color2/size/
  rings/glow, the ring and glow sub-panels (shown only when that flag is on), a
  "Reroll body" button that re-rolls the noise seed *and* all ring/glow numeric
  parameters together, and — since `PAINTER_TUNING` is a single shared object per
  kind, the same one the real game reads — a "Surface tuning" section whose sliders
  affect every body of that kind, in this tool and in the game. The control panel
  (docked, draggable by its title bar, minimizable, collapsible `header()` sections)
  is ported from `tree-viewer.html`'s panel system rather than reinvented.

## Tunable parameters

All defined inline in `environment-viewer.html` (sliders built with the local
`slider()`/`select()` helpers, organized under "Sky" / "Clouds (layer 1)" /
"Clouds (layer 2)" headers, routed into the "Effects" tab by `environment-ui.js`).
`environment-ui.js` itself defines no sky/cloud parameters.

**Sky** (`SKY_PARAMS`, ~line 2140):
- `primaryBody` — select `sun` | `moon` → `skyRef.setCelestialType()` + swaps key light.
- `starCount` — 200–3000 → `skyRef.setStarCount()` (draw-range only, no rebuild).
- `sunSize` ("Body size") — 0.02–0.2 → `skyRef.setSunSize()`.
- `milkyWayIntensity` — 0–1.5 → `skyRef.setMilkyWayIntensity()`.

**Clouds layer 1** (`params`, ~line 2083): `cloudHeight` (20–400), `cloudExtent`
(500–8000), `cloudCover` (0–0.9), `cloudPuff` (0.3–3), `cloudSoftness` (0.05–0.5),
`cloudOpacity` (0–1), `cloudFade` (0.002–0.05), `cloudSpeed` (0–4) — each maps 1:1 to
a `Clouds` setter (`setExtent`/`setCoverage`/`setPuff`/`setSoftness`/`setOpacity`/
`setFade`/`setSpeed`); `cloudHeight` sets `position.y` directly.

**Clouds layer 2**: same parameter set prefixed `cloud2*`, independent `Clouds`
instance, different default ranges (e.g. `cloud2Puff` 0.3–6, `cloud2Height` 20–600).

## Tests

`test-sky-field.mjs` (repo root, plain Node script, no test framework — `console.log`
+ `process.exit(fail ? 1 : 0)`) covers only `sky-field.js`'s pure functions:

- `DEFAULT_PALETTE` / `makePalette()` — default identity, override merge, immutability
  of unspecified fields, fresh-object return.
- `skyRadius(far, size)` — the `min(far*0.88, max(420, size*2.65))` clamping formula
  across small-size, far-dominant, size-dominant, and zero/undefined-size cases.
- `isMoonBody(palette)` — explicit `celestialType` wins over opacity inference;
  `sunOpacity < 0.6` ⇒ moon when type is unset.
- `sunSpritePlacement(dir, radius, palette)` — position along normalized dir at
  `0.74R`; scale formula `R*sunSize*2.15`, and the `2.4x` moon multiplier.
- `makeRng(seed)` — determinism (same seed → same stream), `[0,1)` range,
  different-seed divergence.
- `generateStars(radius, palette, rng)` — count/array sizing, upper-hemisphere-only
  placement, all positions on the `0.83R` shell, brightness range `[0.62, 1.0]`,
  per-seed determinism, cluster-count range (1-3 for dense, 0 for sparse skies).
- `generateMilkyWay(radius, palette, rng)` — presence/null on `milkyWay` flag, array
  sizing, tilt is a number, points on the `~0.82R` shell.
- `generateCelestialBodies(radius, palette, rng)` — moon count (1-2), distant planet
  count (2-4), exactly one near planet, companion moon count (1-3), every body sits
  on its own declared `radius`, per-seed determinism, every body has a `kind` (moons
  restricted to `ice`/`rocky`), `detail` matches near/companion vs. distant/extra, all
  5 planet kinds appear across 200 seeds, `gas` stays derived from `kind` for
  `paintBodySimple` backward-compatibility, every body carries a `[0,1)` `seed` and a
  `color2` string.

`test-celestial-bodies-smoke.mjs` (repo root, plain Node script) exercises the real
`celestial-bodies.js` paint dispatch with a minimal `document.createElement('canvas')`
stub — confirms every `kind` × `detail` combination paints without throwing. It does
not assert pixel content (no automated coverage exists for that — see below).

**No dedicated tests exist for `sky.js`, `stars.js`, or `clouds.js`** — these are the
TSL/three.js rendering layers (node materials, GPU buffer/lifecycle management) and
are exercised only by manually running the viewer. `celestial-bodies.js`'s paint
dispatch has smoke coverage (above) but not pixel-content coverage — ring/glow/hue
correctness is verified visually via `stellar-viewer.html`. The recent clouds.js
world-space-noise fix had no test coverage added.
