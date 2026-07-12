# Water Performance Design

Date: 2026-07-08

## Context

The current July 8 A/B runs do not make water the primary regression, but water is still a meaningful render-path multiplier:

- Recent baseline `perf-2026-07-08T23-14-03-823Z.csv`: 43.4 FPS, 17.87ms median CPU, `passPostMs` 12.2, `waterReflectionLastMs` 2.7, `waterReflectionRate` 1, `waterReflectionResolutionScale` 0.5, `waterDraws` 1.
- No-dressing run `perf-2026-07-08T23-09-28-141Z.csv`: 56.6 FPS, 13.62ms median CPU, `passPostMs` 10.0, `waterReflectionLastMs` 2.3.
- Best July 5 full-scene runs were 60-75 FPS with `waterReflectionLastMs` around 1.2-1.6 and `passPostMs` 5.7-8.5.

Water is worth fixing because it nests extra scene renders inside the frame. Every expensive terrain, sky, tree, or dressing material can be paid again by reflection or caustics.

## Findings

1. Reflection still renders every frame by default.

`water.js:58-59` sets `reflectResolutionScale: 0.5` and `reflectRate: 1`. The reflector wraps `reflectorBase.updateBefore` in `water.js:561-619`, and it calls a nested scene render whenever the modulo throttle allows it. At `reflectRate=1`, the nested reflection pass runs every frame.

This is high risk because the reflection pass re-traverses the scene during the main render. The code prunes some reflection exclusions (`water.js:619-645`), but the default still pays a second render path for reflected content.

2. Caustics are globally compiled as enabled and render inside a node update hook.

`water.js:468` has `const CAUSTICS_ENABLED = true`. `CausticTextureNode.updateBefore` in `water.js:803-839` sets a render target and calls `r.render(causticScene, causticCamera)` from the live render path when caustic strength is non-zero.

The viewer initializes water with `caustics: 1.0` in `environment-viewer.html:3958`, so caustics are on unless a user turns the slider down. This should not be a default production cost without a rate limiter and quality tier.

3. The water shader computes ripple normals with repeated sine-wave height samples.

The GLSL helper at `water.js:92-100` and the TSL equivalent at `water.js:488-501` compute finite-difference normals by calling `waveH` four times per fragment. That is acceptable as a high-quality mode, but it should not be the only path for far water, reflections, or low/medium presets.

4. Ring geometry generation is CPU-side and runs from the frame update.

`createRingGeometryJob` starts at `water.js:297`. `processRingQueue` is called from `update()` at `water.js:1041-1045`. It is budgeted, but it still samples terrain height and commits geometry on the main thread when the camera snaps across water-ring cells.

5. Water diagnostics are good, but the controls are incomplete.

The stats pipeline records reflection/caustic times and counts (`environment-viewer.html:1239-1242`, `1544-1553`, `1874-1883`), but the viewer does not expose URL-level A/B flags for reflection rate, reflection scale, caustic rate, caustic resolution, or water shader quality.

## Design

### 1. Add explicit water performance flags

Add URL params and matching runtime setters:

- `?water=off|on`
- `?waterReflection=off|on`
- `?waterReflectRate=1|2|3|4`
- `?waterReflectScale=0.25|0.5|0.75|1`
- `?waterCaustics=off|on`
- `?waterCausticRate=1|2|4|8`
- `?waterCausticRes=256|512|1024`
- `?waterQuality=low|medium|high`

Defaults should target stable gameplay, not screenshots:

- Reflection on, half-res, every second frame.
- Caustics off by default or every fourth frame at 512px.
- High-quality ripples only when `waterQuality=high`.

### 2. Throttle nested renders independently

Reflection already has `setReflectRate`; wire it through `environment-viewer.html` and default it to `2`.

Add a separate caustic frame counter inside `CausticTextureNode.updateBefore`. On skipped frames, preserve the previous caustic texture the same way reflection preserves its previous target.

Acceptance:

- `waterReflectionPasses / sampledFrames` should match `1 / waterReflectRate`.
- `waterCausticPasses / sampledFrames` should match `1 / waterCausticRate`.
- Skipped frames must not bind an empty texture.

### 3. Gate reflection and caustics by visibility and material strength

Skip reflection when:

- `reflectMix <= 0` or `reflectBrightness <= 0`.
- The camera is well above water and the water plane is not in the view frustum.
- The water surface has no visible ring geometry.
- The active reflection strength is visually negligible for the current quality preset.

Skip caustics when:

- `causticStrength <= 0`.
- The sun/light direction is below the horizon or too grazing to create visible caustics.
- No caustic meshes are active.

### 4. Add water shader quality tiers

Low:

- No finite-difference ripple normal.
- Flat normal plus Fresnel/refraction tint.
- Reflection disabled or quarter-res every 4 frames.
- Caustics disabled.

Medium:

- Two wave samples or a small normal texture/LUT.
- Reflection half-res every 2 frames.
- Caustics optional every 4 frames at 512px.

High:

- Current four-sample finite-difference normal.
- Reflection half/full-res every frame or every 2 frames.
- Caustics every frame only when specifically requested.

### 5. Move water ring builds off the hot frame path

Keep the existing ring cache, but move terrain height sampling and typed-array fill work out of `waterRef.update()`:

- Use a Web Worker for ring jobs, or prebuild ring geometry for the current map chunks during idle time.
- Keep the frame update responsible only for swapping in completed geometry.
- Track `waterBuildQueued`, `waterBuildCompleted`, `waterBuildDropped`, and `waterCommitMs`.

### 6. Make reflection exclusions explicit

Reflection exclusions should become a first-class list rather than an ad hoc callback:

- Exclude grass, plant, dressing, creature debug, and shadow-only meshes by default.
- Consider a reflection-specific material override for terrain and trees.
- Add `reflectionDrawCalls`, `reflectionTriangles`, and `reflectionExcluded` stats if available from renderer telemetry.

## Milestones

1. Instrumentation and A/B flags

Add URL params, log them to perf CSVs, and verify that `waterReflectionRate`, `waterReflectionResolutionScale`, `waterCausticLastMs`, and `waterReflectionLastMs` move as expected.

2. Default throttles

Change default reflection to every 2 frames and caustics to off or every 4 frames. Target: reduce `waterReflectionLastMs` contribution without visible startup blanking or flicker.

3. Caustic throttle and visibility gate

Implement caustic frame skipping, offscreen/strength gates, and lower default caustic resolution.

4. Shader quality tiers

Implement `waterQuality` low/medium/high normal and reflection defaults from the design section 4 tiers, and confirm visual acceptability at each tier on the current map.

5. Ring build offload

Move ring geometry generation to a worker or idle queue per design section 5, keeping the frame update responsible only for swapping in completed geometry.

## Verification

Run the same camera route with:

- Baseline defaults.
- `?waterReflection=off`
- `?waterReflectRate=2`
- `?waterReflectRate=4`
- `?waterCaustics=off`
- `?waterQuality=low`

Pass targets:

- Default full scene should recover at least 1.0-1.5ms median CPU/GPU wait versus current `reflectRate=1`, unless visual parity requires a documented exception.
- `waterReflectionLastMs` should be below 2ms on the same camera route that currently measures 2.3-2.7ms.
- `passPostMs` should not exceed the best July 5 range by more than 1.5ms when terrain/dressing are unchanged.
- No frame should show a blank reflection or caustic texture after startup.
