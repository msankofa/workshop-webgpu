# TSL Night Sky — dome, moon/sun, stars, Milky Way, planets · Design Spec

**Date:** 2026-06-22
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped & approved; proceeding to plan + implement.
**Target viewer:** `environment-viewer.html` (WebGPU + TSL sandbox, three@0.184.0).

## Goal

Replace the flat `scene.background` color in `environment-viewer.html` with a full procedural
night sky: a gradient sky dome with horizon glow, a twinkling star field, a tilted Milky Way
band, extra moons and distant/near planets — and a **primary celestial body (sun or moon)** that
is **locked to the scene's real light direction** so it sits exactly where the water reflection
already points. The Sun⇄Moon choice also **switches the active key light** so the scene reads as
either sunlit or moonlit.

This is a re-authoring, not a copy-paste port. The source design
(`html-game-v2/sky-moon-stars.md`) is WebGL + GLSL `ShaderMaterial`, which does **not** run on
the `WebGPURenderer`. All shader-driven parts (dome gradient, star twinkle, Milky Way gas) are
rebuilt as **TSL node materials**, matching this codebase's house style (`clouds.js`, `water.js`,
`grass.js` — one module per subsystem, nodes only, no `onBeforeCompile`/GLSL strings). Canvas-
texture sprites (moon/sun/planets) carry over directly onto `SpriteNodeMaterial`.

Dropped from the source spec (no analogue in this project): the **GLB-skybox path** and the
**multi-map preset machinery** (`custom`/`ruins`/`arena`/`perlin`/`blockland`). This viewer has one
continuous environment, so there is a single tunable palette instead of per-map presets.

## SOTA context (WebGPU-reachable)

- **Dome gradient + horizon glow** in a fragment node is standard and cheap (one back-side sphere).
- **GPU-twinkling stars**: a single `THREE.Points` with per-star attributes driving `sizeNode` /
  `opacityNode` from one shared time uniform — all animation on the GPU, one draw call, zero
  per-star JS. Soft round points via the point-sprite UV falloff (no texture needed).
- **Procedural Milky Way gas**: layered value/simplex noise (reuse the `snoise` already ported in
  `clouds.js`) on a back-side inner sphere — the same noise spine the project already ships.
- Beyond scope (deliberately not done): HDRI/IBL environment lighting from the sky, real
  atmospheric scattering (Rayleigh/Mie), volumetric Milky Way, eclipse/phase simulation. The moon
  phase is faked in the canvas texture, not simulated.

## Architecture

Three new ES modules, dynamically imported by `environment-viewer.html` (like `clouds.js`), each
self-contained and independently testable for its pure/math parts.

### `sky.js` — dome + primary body + group + lifecycle (owner module)

Exports `createSky({ scene, camera, palette, sunDir })` returning an object:
`{ group, setSunDir(v3), setPalette(p), setCelestialType('sun'|'moon'), rebuild(radius), update(seconds), dispose() }`.

- **`skyGroup`** — a `THREE.Group` added to the scene; `userData.followCamera = true`. The viewer
  copies `camera.position` into it each frame so the sky is infinitely distant (no parallax).
- **Radius** — `Math.min(camera.far * 0.88, Math.max(420, (size||120) * 2.65))` evaluated at build.
  `rebuild(radius)` re-creates dome/stars/bodies when the View-distance slider changes `camera.far`
  (rare; a full teardown+rebuild is fine).
- **Sky dome** — `SphereGeometry(radius, 40, 18)`, `MeshBasicNodeMaterial`,
  `side: THREE.BackSide`, `depthTest: false`, `depthWrite: false`, `fog: false`,
  `renderOrder: -1000`. `colorNode` (TSL): normalize the world-space fragment direction; blend
  `bottom → horizon → top` by its Y; add a `glow`-colored horizon band (faithful re-author of
  `makeSkyDomeMaterial`). Also set `scene.background` to the palette bottom color as a fallback.
- **Primary celestial body** — `THREE.Sprite` + `SpriteNodeMaterial`, `depthWrite:false`,
  `fog:false`, `renderOrder: -996`. Texture from `makeSkySunTexture(color, {moon})`:
  - **Sun** 256² canvas: bright radial disc + warm corona + offset hotspot.
  - **Moon** 512² canvas: atmospheric glow + shaded sphere + limb darkening + brighter upper-left +
    soft maria; rendered at 2.4× the sun sprite scale.
  - **Position = sunDir**: `sprite.position.copy(dir.normalize().multiplyScalar(radius*0.74))`,
    where `dir` is the rig's light direction (see Light Coupling). Scale
    `radius * palette.sunSize * 2.15 * (isMoon ? 2.4 : 1)`.
- Imports and composes `stars.js` and `celestial-bodies.js`, parenting their outputs under
  `skyGroup` and forwarding `update()` / `dispose()`.

### `stars.js` — star field + Milky Way

- `createSkyStars(radius, palette)` → one `THREE.Points`, `PointsNodeMaterial`,
  `transparent:true`, `depthWrite:false`, `fog:false`, `renderOrder:-995`.
  - Positions: `palette.starCount` stars on the **upper hemisphere only**
    (`theta = rand*2π`, `y = 0.06 + rand*0.9`), at **83% of radius**; per-star brightness
    `0.62–1.0`. Per-star attributes: twinkle phase, twinkle speed, twinkle strength, base size; a
    small % are enlarged for occasional prominent stars.
  - For dense skies, reserve a few stars for **1–3 Pleiades-like clusters** (tight bright core +
    looser faint ring) — same geometry, same draw call.
  - TSL: `sizeNode` and `opacityNode` modulate base size/brightness by
    `1 + strength * sin(time*speed + phase)`; fragment makes a **soft circular** point via
    `1 - smoothstep` on the point-sprite UV radius. One shared `time` uniform.
- `createMilkyWay(radius, palette)` → a tilted sub-group (returned only for night/dusk palettes;
  skipped for bright/day palettes):
  - **Gas**: back-side inner sphere, `MeshBasicNodeMaterial`, additive, layered `snoise` (reused
    from `clouds.js`) forming irregular warm/cool luminous clouds, a warped central band, and a
    dark dust lane.
  - **Band stars**: a dense `THREE.Points` aligned to the same galactic plane, smaller average
    size + gentler twinkle than foreground stars.
  - The whole group is tilted across the sky and parented to `skyGroup`.
- `updateSkyStars(group, seconds)` writes the shared `time` uniform(s) once per frame — all
  twinkle/drift runs on the GPU.

### `celestial-bodies.js` — extra moons + planets

- `createCelestialBodies(radius, palette)` → a sub-group of `THREE.Sprite`s (canvas textures,
  `SpriteNodeMaterial`, `depthWrite:false`, `fog:false`), only for night/dusk palettes:
  - 1–2 additional moons (varied size/color/phase/markings).
  - 2–4 small distant planets.
  - usually 1 large near planet (rocky→soft markings, or gas→horizontal bands + storms),
    optional atmospheric glow and occasional rings.
  - 1–3 small companion moons around the near planet.
  - Bodies sit at varied radii inside `skyGroup`, so they stay astronomical (camera-following),
    not world geometry.

### Light coupling (the "bring the sun into the sky" + "moon its own light" requirement)

The rig (`lights.js`) already derives the key direction from `toDir(azimuth, elevation)` and pushes
it to the water specular (`setLightDir`) and shadow camera. The sky reuses **the same direction**:

- Each frame the viewer computes `dir = toDir(rig.azimuth, rig.elevation)` and calls
  `sky.setSunDir(dir)`. The primary sprite is placed along `dir`, so the disc, the directional
  shadows, and the water reflection are always aligned. Moving the Azimuth/Elevation sliders moves
  all of them together.
- **Sun⇄Moon toggle switches the active key light** along that same direction:
  - **Sun** → the existing warm `rig.dirLight` (`#fff4e0`, intensity ~1.8) is the key.
  - **Moon** → a dedicated **`moonLight`** (`THREE.DirectionalLight`, cool e.g. `#aec6ff`, low
    intensity ~0.35, its own soft shadow) becomes the key while the warm sun is dimmed toward 0.
    The moon light's `position`/`target` track the same `dir`, so the moonlit shadows fall
    correctly and the water highlight (white, direction-only) stays consistent.
  - The toggle also swaps the primary sprite texture (sun↔moon) and updates the dome palette toward
    the matching look.
- The moon light is created in the viewer alongside the rig (it is a scene light, not a sky-group
  child, so it must **not** follow the camera). `sky.js` exposes `setCelestialType()`; the viewer's
  toggle handler flips both the sprite and the light pair.

**Default:** primary body = **Sun**, toggleable to Moon. Stars / Milky Way / planets render in both
modes (a stylized twilight/moonlit sky). The whole `skyGroup` follows the camera every frame.

## Viewer integration (`environment-viewer.html`)

- Add a `moonLight` `THREE.DirectionalLight` near the rig setup (shadow-configured like
  `rig.dirLight`), initially intensity 0.
- Dynamic-import `sky.js` near the clouds import; build with current `camera.far`/`terrain.size`;
  `scene.add(sky.group)`.
- In `animate()` (before `renderer.render`): copy `camera.position` into `sky.group` when
  `followCamera`; `sky.setSunDir(toDir(rig.azimuth, rig.elevation))`; `sky.update(now/1000)`.
- On the View-distance change handler that updates `camera.far`, call `sky.rebuild(...)`.
- **Control panel** — a new collapsible **"SKY"** section built with the existing `slider` /
  `select` helpers:
  - `select` Primary body: **Sun / Moon** (drives `setCelestialType` + the light pair).
  - sliders: star count, star size, moon/sun size, Milky Way intensity, horizon-glow strength.
  - color inputs: sky top / horizon / bottom (reuse the lighting panel's color-row pattern).

## Render ordering & depth

| Object        | renderOrder | depthWrite | depthTest | fog |
| ------------- | ----------: | ---------- | --------- | --- |
| Sky dome      |       -1000 | false      | false     | off |
| Sun/Moon      |        -996 | false      | true*     | off |
| Stars         |        -995 | false      | true*     | off |
| Milky Way     |        -997 | false      | true*     | off |
| Planets/moons |       ~-996 | false      | true*     | off |

\*depth *test* stays on for non-dome layers (they sit at large radius behind scene geometry); only
the dome disables depth test. All disable depth *write* and fog. Verified to compose correctly
through the optional post-FX stack (`?post=` on) and the plain `renderer.render` path.

## Disposal

`sky.dispose()` removes `skyGroup` from the scene and disposes every geometry, node material, and
**canvas texture** it created (sun/moon/planet textures flagged for explicit `.dispose()`), then
removes the `moonLight`. Follows the project's existing disposable-cleanup convention.

## Testing

Pure/deterministic helpers get Node tests (`test-*.mjs`, matching the repo pattern), with no
WebGPU/DOM dependency:

- **`test-sky-palette.mjs`** — radius formula clamps; palette derivation; Sun/Moon `isMoon`
  inference and sprite scale (`2.4×` moon, sizeMul); sun-direction placement (`dir*radius*0.74`)
  equals the rig's `toDir(az,el)` for sample angles (the coupling invariant).
- **`test-sky-stars.mjs`** — star generator: count matches `palette.starCount`; all stars in the
  **upper hemisphere** (y ≥ 0.06) at ~83% radius; brightness within `[0.62,1.0]`; clusters reserved
  only above a density threshold and within count budget; single geometry (one draw call).
- **`test-celestial-bodies.mjs`** — body counts within the spec ranges; night/dusk-only gating;
  companion moons attach to the near planet.

Visual/material correctness (TSL nodes, sprites, twinkle, post-FX compositing) is verified by
running `environment-viewer.html` — there is no headless WebGPU path in this repo.

## Out of scope / non-goals

- GLB/GLTF skybox loading and `map-config.json` (no custom-map system here).
- Per-map presets (`ruins`/`arena`/`perlin`/`blockland`/`custom`).
- IBL/HDRI sky-driven scene lighting; physical atmospheric scattering.
- Day↔night animation/time-of-day cycle (toggle is manual; a future SP could animate it).

## Main modification points (for future tuning)

- Colors / star density / moon size / glow → the single **palette** object + the **SKY** panel.
- Sky gradient / horizon glow math → `makeSkyDomeMaterial` (TSL) in `sky.js`.
- Star distribution / twinkle → `createSkyStars` in `stars.js`.
- Moon/sun artwork → `makeSkySunTexture` in `sky.js`.
- Sun⇄Moon light behavior → the viewer's toggle handler + `moonLight` config.
