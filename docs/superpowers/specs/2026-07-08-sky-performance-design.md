# Sky Performance Design

Date: 2026-07-08

## Context

The sky is probably not the main July 8 FPS regression. The frame loop already has `passSkyMs`, and recent stats show the largest regression in `passPostMs`, GPU wait, terrain/material cost, and dressing interactions. Still, the sky can inflate total render cost because it contributes full-screen transparent layers and can be drawn again by reflection.

The existing viewer has useful diagnostic modes:

- `?sky=off`
- `?sky=nomoonlight`
- `?sky=nostars`
- `?sky=nomilkyway`
- `?sky=nobodies`
- `?sky=domeonly`

Those should be formalized into perf tests and expanded with quality controls.

## Findings

1. Sky layers are forced visible and skip frustum culling.

The dome is a `SphereGeometry(radius, 40, 18)` with `frustumCulled = false` in `sky.js:86-87`. Stars and Milky Way also set `frustumCulled = false` in `stars.js:39` and `stars.js:94`. This is common for skyboxes, but it means every enabled sky layer draws every frame.

2. Milky Way uses both a transparent gas sphere and a point band.

`createMilkyWay` builds a back-side gas sphere with `SphereGeometry(radius * 0.995, 40, 18)` at `stars.js:93`, plus band points at `stars.js:99`. The gas shader layers several noise calls in `stars.js:67-87`. This is visually richer than a static texture but more expensive than a precomputed sky texture, especially because it is full-screen transparent/additive work.

3. Stars and Milky Way animate on the GPU, but still pay per-point fragment/vertex cost.

`stars.js:12-40` creates point clouds with per-star brightness, phase, speed, size, and twinkle strength. `sky-field.js:85-140` generates up to `starCount` foreground stars, and `sky-field.js:142-166` generates a Milky Way band at about `starCount * 1.1`.

The code notes that WebGPU points render as 1px points and ignore size (`stars.js:24-31`). That means the `aSize` attribute is still generated and uploaded even though it is not currently useful in rendering.

4. Celestial textures are generated synchronously on the main thread.

`sky.js:116` creates celestial bodies from `generateCelestialBodies`. `celestial-bodies.js` owns canvas painting. High-detail bodies use a 512px canvas and per-pixel fractal/cellular noise in `paintBodyHD` (`celestial-bodies.js:157-321`). Low-detail bodies use 256px canvas textures in `paintBodySimple` (`celestial-bodies.js:323-333`).

This is mostly load-time cost, but runtime palette/body rebuilds or future dynamic sky changes can hitch the main thread.

5. The frame loop updates sun/moon placement every frame even when light direction is unchanged.

The frame loop calls `skyRef.setSunDir(d)` in `environment-viewer.html:5502-5503`. `setSunDir` normalizes and calls `placeSun()` every time in `sky.js:182`; `placeSun()` updates both sun and moon sprite placement in `sky.js:142`.

This is not a large cost, but it is unnecessary work in a tight loop.

6. Sky cost is under-instrumented relative to its render layers.

The profiler times the sky update in `environment-viewer.html:5498`, but the actual sky draw cost lands in the final render/post path. There are no logged counts for sky draw calls, sky triangles, star count, Milky Way mode, or body sprite count.

## Design

### 1. Formalize sky quality presets

Add `?skyQuality=low|medium|high|ultra`.

Low:

- Dome only.
- No Milky Way gas sphere.
- Stars capped at 400.
- No extra planets/moons.

Medium:

- Dome plus stars capped at 1000.
- Milky Way as points only or a low-resolution baked texture.
- Primary sun/moon sprite only.

High:

- Current default visuals, but with Milky Way gas optional.
- Stars capped at current configured count.
- Celestial sprites enabled.

Ultra:

- Current full feature set with higher star/body settings for screenshots.

### 2. Replace procedural full-screen Milky Way gas with a cached texture option

The current gas sphere shader is attractive but does procedural noise across a full-screen transparent surface. Add a baked/cached mode:

- Generate a Milky Way texture once from the same seed.
- Render it as a single low-poly dome or background layer.
- Keep the procedural gas shader behind `?skyMilkyWay=procedural`.

This shifts noise cost from every frame to load/idle time.

### 3. Remove unused star attributes from the WebGPU point path

Since WebGPU points ignore `sizeNode`, stop generating and uploading `aSize` unless a future implementation actually consumes it. Keep this simple:

- `generateStars` and `generateMilkyWay` can omit `size` when the renderer path is WebGPU points.
- `buildPoints` should only attach attributes it reads.

### 4. Coalesce sky placement updates

Track the last normalized light direction and last body size. In `setSunDir`, skip `placeSun()` when the direction delta is below a small epsilon. In `setSunSize`, skip work when the value is unchanged.

Acceptance:

- Static camera/sun frames should not update sun/moon sprite transforms.
- Animated day/night mode should still update smoothly.

### 5. Move celestial texture painting off the main frame path

The current body painting is acceptable at startup, but it should not block interactive frames:

- Generate high-detail body textures in idle tasks or a worker/offscreen canvas when available.
- Add a simple placeholder sprite first, then swap in the finished texture.
- Dispose old generated textures only after the frame submit, preserving the current delayed-disposal safety model in `sky.js:157-197`.

### 6. Add sky render telemetry

Log:

- `skyMode`
- `skyQuality`
- `skyDraws`
- `skyTriangles`
- `skyStarCount`
- `skyMilkyWayPoints`
- `skyMilkyWayGas`
- `skyBodies`
- `skyTextureBakeMs`

Reflection should also log whether sky layers are included in the reflection pass.

## Milestones

1. Instrumentation and presets

Add sky quality params and CSV fields. The initial implementation can map presets onto existing `skyParts`, `starCount`, and Milky Way intensity.

2. Update coalescing

Skip redundant `setSunDir` placement work. This is small but low risk and easy to verify.

3. WebGPU point cleanup

Remove unused `aSize` attribute generation/upload for the current WebGPU point renderer.

4. Baked Milky Way mode

Add a cached texture path and make it the default for low/medium quality. Keep procedural gas for high/ultra or explicit opt-in.

5. Async celestial texture generation

Move 512px high-detail body painting out of any synchronous runtime rebuild path.

## Verification

Run comparable captures with:

- `?sky=off`
- `?sky=domeonly`
- `?sky=nostars`
- `?sky=nomilkyway`
- `?sky=nobodies`
- `?skyQuality=low`
- `?skyQuality=high`

Pass targets:

- `passSkyMs` should remain near zero for update work in static lighting.
- `skyQuality=low` should reduce sky draw calls/layers to dome-only plus optional primary body.
- Disabling Milky Way should measurably reduce full-scene render cost at night/look-up camera angles if sky is a material contributor.
- Runtime celestial changes should not create main-thread frame spikes over 2ms.
