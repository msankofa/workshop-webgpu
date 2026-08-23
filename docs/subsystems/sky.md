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
Returns an object with: `group`, `setSunDir(v)`, `setMoonDir(v)`, `setCelestialVisibility(sunVisible,
moonVisible)`, `setDomeVisible(on)`, `setStarsVisible(on)`, `setMilkyWayVisible(on)`,
`setBodiesVisible(on)`, `setPalette(o)`, `setCelestialType(type)`, `setStarCount(n)`, `setStarOpacity(v)`,
`setStarColor(hex)`, `setSunSize(v)`, `setMilkyWayIntensity(v)`, `setSeed(n)`, `setRadius(radius?)`,
`rebuild(r)`, `update()`, `updateDome(elevationDeg)`, `setCelestialOpacityMode(on)`,
`setGlowDirectionality(v)`, `flushDisposals()`, `dispose()`, getters `radius`, `isMoon`, `moonDir`,
`nightness`, `skyStates`, `thresholds`. `setStarOpacity`/`setStarColor` are live uniform writes (no
rebuild), like `setMilkyWayIntensity`. `updateDome(elevationDeg)` blends the day/dusk/night dome
states by sun elevation and writes uniforms only — never rebuilds. `nightness` (0 in day, 1 at
night) is the single shared "how dark is it" scalar; `setCelestialOpacityMode(true)` multiplies
star/Milky-Way/body opacity by it. `setMoonDir(v)` sets an independent moon direction (normalized,
stored separately from the sun direction) and repositions only the moon sprite; the `moonDir`
getter returns a clone (or `null` if never set) so a caller can aim a separate moon light.
`setCelestialVisibility(sunVisible, moonVisible)` sets `sunSprite.visible`/`moonSprite.visible`
directly, for an external time-of-day driver that wants both discs visible/hidden independently of
`primaryBody`/`setCelestialType`.

**sky-field.js**
```js
export const DEFAULT_PALETTE
export function makePalette(overrides = {})
export function skyRadius(far, size)
export function isMoonBody(palette)
export function sunSpritePlacement(dir, radius, palette)
export function makeRng(seed)
export function generateStars(radius, palette, rng)
export function generateMilkyWay(radius, palette, rng)   // band count = starCount * (palette.milkyWayDensity ?? 1.1)
export function generateCelestialBodies(radius, palette, rng)  // reads palette.planetCount / moonCount (count overrides) and bodyScale (size ×)
export const PLANET_KINDS   // ['terrestrial','gas','ice','volcanic','rocky']
export const MOON_KINDS     // ['ice','rocky'] — moons only roll from this subset
export function randomKindColor(rng, kind)  // continuous HSL color generation, not a fixed palette
export const DEFAULT_SKY_STATES   // { day, dusk, night } dome keyframes (colors + transition params)
export const DEFAULT_THRESHOLDS   // { dayAbove:8, duskPeak:0, nightBelow:-8 } sun-elevation anchors (deg)
export function makeSkyStates(overrides = {})            // per-state defaults-merge, fresh object
export function lerpHex(a, b, t)                         // RGB-space hex interpolation (exact endpoints)
export function domeParamsAtElevation(elevDeg, thresholds, states)  // blend adjacent states by elevation
export function nightnessAtElevation(elevDeg, thresholds)           // 1 - smoothstep(nightBelow, dayAbove)
```

**stars.js**
```js
export function createSkyStars(starData, palette)
export function createMilkyWay(milkyData, palette)
```

**celestial-bodies.js**
```js
export function createCelestialBodies(bodyData, { resScale = 1, faceMode = 'billboard' } = {})
// resScale scales the painter canvas edge (512 HD / 256 simple).
// faceMode: 'billboard' (default) → camera-facing THREE.Sprites (used by stellar-viewer.html);
//           'fixed' → plane meshes oriented once toward the group origin, so distant planets
//           don't appear to rotate as the view yaws (used by sky.js). Both disable frustum
//           culling so small bodies don't pop out at the view edge.
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
  setFade(fade)          // 0..1 edge dimming (0 = clouds full to the plane edge, 1 = dim toward it)
  setExtent(worldUnits)  // also updates the fade's half-extent uniform
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
  8000; layer 2: height 280, extent 16000) — both added directly to `scene`. Each gets
  its own `header('Clouds (layer N)')` + `slider(...)` UI block.
- **Sky** (`environment-viewer.html` ~line 2156): `await import('./sky.js?v=sp7-hdplanets')`,
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
  - All three sub-modules are versioned with the same `?v=sp7-hdplanets` query string as
    `sky.js` itself (cache-busting tied together).
- `environment-ui.js` does **not** define sky/cloud parameters. It only hosts a
  tabbed shell (`createEnvironmentUi`) that re-parents whichever `.sec` DOM blocks
  the inline `header()`/`slider()`/`select()` helpers (defined locally in
  `environment-viewer.html` ~line 1548) produced — `effectsNames` includes `'Clouds'`
  and `'Sky'` so those sections route to the "Effects" tab (`environment-ui.js:460`).

## Architecture notes

- **Independent sun/moon directions**: `sky.js` used to track a single `dir` and place both the
  sun and moon sprites from it. It now holds `dir` (sun) plus a separate `moonDir` (`null` until
  `setMoonDir(v)` is first called). `setSunDir(v)` always repositions the sun sprite; it only
  repositions the moon sprite too when `moonDir` is still unset, preserving the old shared-direction
  behavior for any caller that never calls `setMoonDir`. Once `setMoonDir` has been called, the sun
  and moon sprites move independently (`placeSun()`/`placeMoon()`), which is what lets an anti-sun
  time-of-day driver put the moon opposite the sun. `setCelestialVisibility(sunVisible, moonVisible)`
  gives an external driver (e.g. a time-of-day clock) direct control of each disc's `visible` flag;
  the pre-existing `primaryBody`/`setCelestialType`/`updateDiscVisibility` path — a single
  sun-XOR-moon toggle keyed on `isMoonBody(palette)` — is untouched and still governs visibility
  whenever `setCelestialVisibility` isn't used.
- **Time-of-day dome states**: the dome gradient is no longer a single static palette.
  `sky-field.js` defines three keyframed states — `DEFAULT_SKY_STATES.day` / `.dusk` /
  `.night` — each carrying dome colors (`top`/`horizon`/`bottom`/`glow`) and transition
  params (`horizonHeight`, `zenithSoftness`, `glowWidth`, `glowStrength`). `night`
  reproduces the historic `DEFAULT_PALETTE` look plus the constants that used to be baked
  into `sky.js`'s `colorNode` (`zenithSoftness 0.55`, `glowWidth ~= 1/9`, `glowStrength
  0.4`). Every frame the viewer calls `skyRef.updateDome(rig.elevation)`;
  `domeParamsAtElevation(elevDeg, thresholds, states)` blends the two ADJACENT states around
  the current sun elevation (day↔dusk above `duskPeak`, dusk↔night below it), clamping to
  `day` above `dayAbove` and `night` below `nightBelow` (`DEFAULT_THRESHOLDS = { dayAbove:8,
  duskPeak:0, nightBelow:-8 }` degrees). Because only adjacent, authored states ever blend,
  colors never take a muddy direct blue→red midpoint. The dome material is built once from
  a persistent uniform bundle (`makeDomeUniforms`: 4 color + 4 transition + `sunDir` +
  `glowDirectionality`), so `updateDome` and every slider are pure `.value` writes — the same
  no-rebuild discipline that protects the star/body path. `nightnessAtElevation` returns a
  monotonic 0(day)→1(night) scalar exposed as `skyRef.nightness`, the shared darkness source
  of truth; the "Celestial opacity follows time" toggle multiplies star/Milky-Way/body
  opacity by it. The still-single `DEFAULT_PALETTE` remains for the sun/moon disc colors,
  sizes, `celestialType`, and star/Milky-Way tuning; `makePalette(overrides)` still never
  mutates it.
- **Directional horizon glow**: the glow band in the dome `colorNode` is biased toward the
  sun's azimuth via `dot(normalize(pos.xz), normalize(uSunDir.xz))` mapped to `[0,1]` and
  mixed by `uGlowDirectionality` (0 = even ring, 1 = concentrated toward the sun). `sunDir`
  is updated in `setSunDir`.
- **Seed / re-roll**: the generators (`generateStars`/`generateMilkyWay`/
  `generateCelestialBodies`) are deterministic — they take an `rng`, not entropy — so the
  whole sky is a pure function of the seed fed to `makeRng`. Previously `build()` used three
  hardcoded seed constants (`0x5a17`-salted starCount for stars, `0xb1a5`, `0xc0de`), so
  every page load rendered the identical sky. Now `build()` derives all three streams from a
  single `palette.seed` (defaulting to `1` if unset) via XOR salts —
  `makeRng((seed ^ 0x5a17)>>>0)` / `^ 0xb1a5` / `^ 0xc0de` — keeping the star field, Milky
  Way, and bodies decorrelated while re-rolling together. `setSeed(n)` sets `palette.seed`
  and calls `rebuild()` (the one runtime control that legitimately rebuilds — a seed change
  is a geometry change; it's safe because it's a discrete call, not a per-frame drag, so the
  age-gated `_pending` disposal frees the old tree after the in-flight submit). To keep a
  seed rebuild from discarding live-adjusted state, `setStarCount`/`setMilkyWayIntensity` now
  also write their value back into `palette` (not just the draw-range / uniform). The seed
  itself is owned by `SKY_PARAMS.seed` in `environment-viewer.html`, randomized once per load
  (`Math.random()*0xffffffff>>>0`) so sessions differ, and exposed as a UI number field +
  Reroll button. `sky-field.js`/`DEFAULT_PALETTE` are untouched — seed handling lives
  entirely in `sky.js` and the viewer, so the Node tests are unaffected.
- **Sun/moon disc placement**: `sunSpritePlacement(dir, radius, palette)` places the
  disc along the normalized light direction at `0.74 * radius`, with disc scale
  `radius * sunSize * 2.15 * (moon ? 2.4 : 1)` (moon renders larger than the sun). The discs are
  plane meshes (see the camera-oriented note below), re-oriented toward the camera each time
  `placeDisc` repositions them. `sky.js` builds **both** sun and moon discs up front at `build()` time and
  toggles visibility (`updateDiscVisibility`/`setCelestialType`) rather than
  rebuilding — comments in `sky.js` explicitly call out that a runtime
  rebuild/dispose was the cause of a "night freeze" bug (GPU buffer destroyed while
  still referenced by an in-flight submit). The same reasoning drives `setStarCount`
  (draw-range change, not geometry rebuild) and `setRadius` (uniform group scale
  rather than dome regeneration). Disposal of an actually-replaced tree (e.g. on
  `setPalette`/`rebuild`) is deferred via an age-gated `_pending` queue
  (`flushDisposals`, called once/frame by the viewer) so a tree is freed only after
  surviving ≥2 frames past detach. **`disposeTree` skips geometry disposal for
  `THREE.Sprite`s** (`!o.isSprite`): every Sprite shares one module-level `QuadGeometry`, so
  disposing a sprite's geometry destroys the buffer other live sprites still draw from —
  reproducing the "buffer used in submit while destroyed" freeze. This guard is now defensive:
  `sky.js` builds **no sprites** — the sun/moon discs and the celestial bodies are plane meshes
  (see below), and each mesh owns its **own** 1×1 `PlaneGeometry` (never a shared module-level
  one), so `disposeTree` frees them normally on a rebuild without the shared-buffer hazard.
- **Sky render-order stack** (all sky materials use `depthWrite:false`, so within the sky it's
  pure painter's order, back → front): dome `-1000` → Milky-Way gas `-999` → Milky-Way band
  `-998` → background stars `-997` → celestial bodies `-996` (with `stableCelestialLayering` on,
  `-996 + index*0.001` so companions never swap layers by pitch) → sun/moon disc `-995`. The key
  constraint: **stars sit behind the bodies**, so an opaque planet occludes background stars
  instead of stars twinkling in front of it.
- **Discs and bodies are camera-oriented plane meshes, not billboards.** The sun/moon discs
  (`makeDisc`) and celestial bodies (`createCelestialBodies(..., { faceMode: 'fixed' })`) are
  `THREE.Mesh` quads oriented **once** toward the group origin (the camera) via a fixed basis
  with world-up as the up reference — re-oriented only when repositioned, not every frame. A
  `THREE.Sprite` re-faces the camera each frame, which made the painted spheres appear to spin as
  the view yawed; a fixed mesh sits still. All are `frustumCulled = false` so small bodies don't
  pop out at the view edge.
- **Star field + Milky Way generation**: `generateStars` places points on a
  `0.83 * radius` shell, upper hemisphere only (`y ∈ [0.06, 1.0]` — the range reaches the zenith
  so there's no bare circular gap directly overhead), with 0-3
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
  mesh (`scale.set(s, s, 1)` where `s = worldUnits / 2000` — the mesh is laid flat by
  `rotation.x=-PI/2`, so the plane spans local X and Y and both must be scaled; an
  earlier `scale.set(s, 1, s)` only grew world X and left world Z pinned at 2000, a
  one-axis stretch) rather than resizing the
  geometry, UV space stays fixed at `[0,1]` across the whole plane regardless of
  scale — so changing extent changed how many world-units one noise cycle spanned,
  visibly stretching the cloud pattern. The fix replaces `uvCoord = attribute('uv')`
  with `uvCoord = positionWorld.xz.div(1000.0)`, i.e. samples noise from the
  fragment's actual world-space XZ position. Since `positionWorld` is unaffected by
  the mesh's `scale` the way UV is, noise frequency is now fixed in world units and
  is scale-invariant.
- **Clouds opt out of scene fog** (`mat.fog = false`): the viewer's `worldFog.far` is
  deliberately pinned to `terrainFar` (the map extent), not the cloud far distance
  (`environment-viewer.html` ~line 2099 + comment). With fog enabled, a fogged cloud
  material fades to the fog color at the map edge — a hard wall that no `setExtent`
  increase can push past, because it's the fog, not geometry or the camera far plane
  (which does include `cloudFar`), doing the clamping. Clouds already have their own
  distance-based `uFade` horizon fade, so scene fog on them is redundant as well as
  harmful; disabling it lets the cloud extent actually reach past the terrain.
- **Clouds horizon fade** is camera-centered AND extent-relative: `uCameraXZ` is a `vec2`
  uniform updated every frame from `update(elapsedTime, cameraPosition)`; distance from the
  camera is normalized by `uHalfExtent` (the plane's world half-size, kept in sync by
  `setExtent`). Alpha = `coverage * opacity * haze * edge`, where `haze = max(1 - norm*uFade,
  0.25)` keeps clouds readable across the whole plane and `edge = smoothstep(1.0, 0.85, norm)`
  fades only the outer 15% to hide the plane's finite boundary. This replaced an earlier
  `alpha = … / (uFade * rawDistance)` that dropped clouds to near-invisible within ~1000 world
  units, so the deck vanished well before the horizon. `uFade` is now a 0..1 edge-dim amount
  (`setFade`; default 0.5), not a raw distance rate.
- **Clouds never write depth** (`depthWrite: false`): as a transparent, depth-writing plane the
  cloud deck punched holes in the (also transparent, alpha-tested) tree foliage behind/below it —
  branches vanished where the invisible parts of the cloud plane had written depth. Every other
  sky material already sets `depthWrite:false`; clouds now match.
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

**Sky** (`SKY_PARAMS`, ~line 4610). The panel splits into **live** controls (uniform /
draw-range writes, applied immediately, no rebuild) and **regeneration** controls (change
generated geometry, so they only edit `SKY_PARAMS` and are committed by the **Apply** button
or Reroll — a single rebuild via `setPalette(skyPaletteOverrides())`, never live-dragged).

Live:
- `primaryBody` — select `sun` | `moon` → `skyRef.setCelestialType()` + swaps key light.
- `starCount` — 200–3000 → `skyRef.setStarCount()` (draw-range only).
- `starOpacity` ("Star brightness") — 0–1 → `skyRef.setStarOpacity()` (`_uOpacity` uniform).
- `starColor` ("Star color") — colour picker → `skyRef.setStarColor()` (`_uColor` uniform).
- `sunSize` ("Body size") — 0.02–0.2 → `skyRef.setSunSize()`.
- `milkyWayIntensity` — 0–1.5 → `skyRef.setMilkyWayIntensity()`.

Regeneration (slider + editable number field each; committed on Apply/Reroll):
- `planetCount` ("Planets") — 0–8 → `palette.planetCount` (distant-planet count override).
- `moonCount` ("Moons") — 0–6 → `palette.moonCount` (extra-moon count override).
- `bodyScale` ("Planet/moon size") — 0.3–3 → `palette.bodyScale` (× on generated body sizes).
- `bodyResolution` ("Planet resolution") — 0.5–2 → `palette.bodyResolution` → painter canvas
  edge (`resScale`; 512 HD / 256 simple base, clamped 96–2048).
- `milkyWayDensity` — 0.2–3 → `palette.milkyWayDensity` (band points per star; default 1.1).
- `seed` ("Sky seed") — number field + "Reroll — new sky" button. Randomized once per load;
  type a value to reproduce a specific sky. Reroll and the seed field both rebuild via
  `setPalette`, so any pending regeneration edits apply at the same time.

Time of day (`header('Sky — time of day')`, live — mutate `skyRef.skyStates` /
`skyRef.thresholds` in place, applied by the per-frame `updateDome`, no rebuild):
- Per state `day` / `dusk` / `night`: colour inputs `top` / `horizon` / `bottom` / `glow`
  and sliders `horizonHeight` (−0.4..0.4), `zenithSoftness` (0.1..1.0), `glowWidth`
  (0.02..0.4), `glowStrength` (0..1).
- Sun→time mapping: `dayAbove` (0..30°), `duskPeak` (−15..15°), `nightBelow` (−30..0°).
- `glow toward sun` (0..1) → `skyRef.setGlowDirectionality()`.
- `Celestial opacity follows time` (toggle) → `skyRef.setCelestialOpacityMode()`.

Separately, `header('Time of day')` (~line 4155, distinct from the dome-palette editor above) is a
sun/moon-position driver: `todEnabled` toggle, `todHour`/`todLatitude`/`todDayOfYear`/`todMoonPhase`
sliders, and a `todPlaying`/`todSpeed` auto-advance clock, all stored on the same `params` object
the forest/tree tuning panel uses (`_forestPromise`'s callback, ~line 3196) — reused as a general
settings bag rather than a dedicated object. `params` is forward-declared `let params = null` at
module scope (2026-07-17, next to `applyTimeOfDay`) specifically so `animate()`'s per-frame
time-of-day tick (`if (params.todEnabled) ...`, ~line 8577) can read it directly; it used to be a
bare `const` inside the forest closure, invisible to `animate()`, which threw `ReferenceError:
params is not defined` on every frame once this driver's code was added. `animate()`'s read is
still only reachable once `skyRef` is truthy (guarded by the same `if (skyRef)` this whole block is
nested in), and `skyRef` is assigned later in that same synchronous callback than `params` is, so
there's no window where `skyRef` is set but `params` isn't.

Star point *size* is deliberately not exposed: on the WebGPU backend `THREE.Points` render as
1px primitives (`sizeNode` ignored), so a size slider would have no effect — variable-size
stars would require switching the field to instanced sprites.

**Clouds layer 1** (`params`, ~line 2083): `cloudHeight` (20–400), `cloudExtent`
(500–32000, default 8000), `cloudCover` (0–0.9), `cloudPuff` (0.3–3), `cloudSoftness` (0.05–0.5),
`cloudOpacity` (0–1), `cloudFade` (0.002–0.05), `cloudSpeed` (0–4) — each maps 1:1 to
a `Clouds` setter (`setExtent`/`setCoverage`/`setPuff`/`setSoftness`/`setOpacity`/
`setFade`/`setSpeed`); `cloudHeight` sets `position.y` directly.

**Clouds layer 2**: same parameter set prefixed `cloud2*`, independent `Clouds`
instance, different default ranges (e.g. `cloud2Puff` 0.3–6, `cloud2Height` 20–600,
`cloud2Extent` 500–32000 default 16000).

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
  `color2` string. Also covers the palette-driven controls: `planetCount`/`moonCount` pin the
  generated counts (incl. 0), `bodyScale` scales body size linearly, and `milkyWayDensity`
  scales the band count off `starCount` (with the unset default holding at 1.1×).
- Time-of-day blend math: `makeSkyStates` (per-state defaults-merge, fresh object), `lerpHex`
  (exact endpoints, componentwise midpoint, identity), `domeParamsAtElevation` (exact state
  params at each anchor, interpolation between adjacent states, clamping outside the range,
  determinism), and `nightnessAtElevation` (0 at/above `dayAbove`, 1 at/below `nightBelow`,
  monotonic across the band).

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
