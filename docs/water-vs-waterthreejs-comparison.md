# Water comparison: `water.js` vs. achrefelouafi/WaterThreeJS

Date: 2026-08-15. Reference: https://github.com/achrefelouafi/WaterThreeJS
(read from `src/Ocean.js` and the README). Ours: `water.js` and
`docs/subsystems/water.md`.

This is a comparison only. It lists what each system does, how it does it, and
what each choice costs. It does not recommend a direction; that is a separate
decision.

## 1. Context

| | WaterThreeJS | Ours |
|---|---|---|
| Purpose | Standalone open-ocean demo: island, boats, sky, clouds, god-rays, post | Water inside a full game scene next to terrain, forest, grass, bots, FX |
| Water type it targets | Deep ocean with a shore | Lakes carved into a heightfield; one `waterLevel` for the whole map (`terrain.waterLevel`, synced from `loadedMap.seaLevel` on authored maps) |
| Renderer | WebGL2, GLSL `ShaderMaterial` | WebGPU, TSL node material (`MeshBasicNodeMaterial`) |
| Size | ~480 lines in `Ocean.js` (about 250 shader, 230 CPU) plus separate Sky/Floor/Island/Clouds/Post files | ~1120 lines in `water.js`, self-contained |
| Frame budget | Whole frame is the water demo | Shares the frame; reflection is already throttled to every 2nd frame and caustics to every 4th at 512 px to hold framerate |

## 2. Feature by feature

### Wave shape

| | WaterThreeJS | Ours |
|---|---|---|
| Method | 26 Gerstner (trochoid) waves, hash-seeded direction and phase per wave; frequency x1.19 and amplitude x0.82 per octave; phase speed from deep-water dispersion (sqrt(g*k)), so long swells move faster than chop; choppiness `Q` per wave | 3 fixed sine waves (`waveH`) with hand-picked frequencies 0.8/0.7/1.3 and amplitudes 0.05/0.05/0.03, scaled by `waveStrength` |
| Geometry | Vertices are displaced horizontally and vertically (real moving swell, waves fold at crests) | Mesh stays flat at `waterLevel`; the sines only perturb the normal (ripples), the surface never rises or falls |
| Normals | Analytic, accumulated inside the same wave loop | Finite difference of `waveH` (epsilon 0.15), 4 extra evaluations |
| Visual result | Reads as ocean: swell, moving horizon, crests | Reads as still lake with ripples; would not read as ocean |
| Cost | 26 waves x (vertex + fragment) per pixel/vertex; heavier shader | Very cheap |
| What we lack | Displacement, dispersion, wind direction, choppiness | |
| What they lack | Nothing here; their wave model is a superset of ours | |

### Mesh and LOD

| | WaterThreeJS | Ours |
|---|---|---|
| Mesh | One 6000x6000 plane, 600x600 segments (10 m cells), re-centred on the camera and grid-snapped | Three concentric clipmap rings (fine/medium/coarse cell sizes `cellS0/1/2`, radii `lodR0/lodR1`), camera-following and grid-snapped |
| Culling | None; the whole plane is water | Only cells whose four corners are below `waterLevel` are meshed, so triangle count tracks lake area |
| Rebuild cost | Static geometry, no rebuilds | Budgeted incremental builds (`buildBudgetMs` 1.5 ms, `maxBuildsPerFrame`), memoised terrain heights, deferred disposal |
| Finite maps | Not handled | `extentX/extentZ` clip the rings to the map |
| Note | Uniform 10 m cells are coarse for a 26-wave spectrum with fine chop; fine detail is carried by normals, not vertices | Our ring 0 is finer, but the vertices do nothing today because there is no displacement |

### Reflection

| | WaterThreeJS | Ours |
|---|---|---|
| Method | Screen-space reflection: 32 marching steps per pixel with step growth x1.06, hit when the ray falls 0-6 m behind the depth buffer, edge fade `smoothstep(0, 0.14)` | Three.js `reflector()` node: planar mirror camera renders the scene once into a half-resolution target (`reflectResolutionScale` 0.5), every 2nd frame (`reflectRate` 2); UV perturbed by the ripple normal |
| Correct for | Any surface shape, including displaced crests, but only for things already on screen; off-screen objects (trees at the frame edge, sky above the top edge) fade or vanish | Flat surfaces exactly; on a displaced ocean the mirror plane is wrong at crest height, error grows with wave amplitude |
| Cost | Per-pixel ray march every frame; no extra scene render | One extra scene render (half-res, half rate); cost scales with scene complexity, not screen size |
| Runtime controls | Strength uniform | `setReflectionTuning`, `setReflectRate`, `setReflectionEnabled`, visibility gates, HUD stats |

### Refraction and water colour

| | WaterThreeJS | Ours |
|---|---|---|
| Source image | Dedicated pre-water pass into a colour target and a depth target; water reads both | Live framebuffer readback (`viewportSharedTexture`) offset by the ripple normal; no depth texture |
| Depth used | Per-pixel water thickness from the depth texture (view-dependent, correct through the surface) | Per-vertex `aDepth` = `waterLevel - terrainHeight` (vertical depth under the vertex, not along the view ray) |
| Colour law | Beer-Lambert: `T = exp(-(ABSORB / clarity) * thickness)` with a per-channel absorb vector, so red dies first and deep water goes turquoise then navy | Linear `mix(shallow, deep, clamp(depth / depthScale))` |
| Underwater view | Snell's window at ~48.6 deg, total internal reflection outside it, bright turquoise ambient | Not handled; camera below the surface is undefined |
| Cost | One full extra scene render per frame plus depth | One framebuffer copy |

### Fresnel and sun

| | WaterThreeJS | Ours |
|---|---|---|
| Fresnel | Schlick, `f0 = 0.02`, power 5 | `0.02 + 0.98*(1 - N.V)^3` (same idea, power 3) |
| Sun highlight | GGX/Trowbridge-Reitz specular with roughness increasing with distance to stop horizon shimmer | Phong `pow(R.V, 80)`; no distance roughness |
| Light source | Sun uniform, six lighting presets | `setLightDir` from the shared lighting rig, so it tracks the scene sun |

### Foam

| | WaterThreeJS | Ours |
|---|---|---|
| Sources | (a) breaking folds from the Gerstner Jacobian, (b) whitecaps above a crest height (default 1.4 m), (c) shoreline band where depth < 3.4 m with advected noise, (d) contact foam and capsule-shaped wakes for up to 16 floating bodies | None |
| Look | Layered fbm at three scales, threshold dissolve, bubble breakup, sun-shaded | |
| Cost | Several fbm evaluations per pixel | |
| Dependency | (a) and (b) require displaced Gerstner waves; (c) needs only depth; (d) needs a list of bodies | Our per-vertex `aDepth` already gives what (c) needs |

### Caustics

| | WaterThreeJS | Ours |
|---|---|---|
| Method | 4-octave fbm shimmer scrolled by wind, modulated by Fresnel; a pattern, not derived from the surface | Real caustics: each vertex's sun ray is Snell-refracted through the flat and the rippled normal, hit against a bed plane, and the pre/post triangle-area ratio (via `dFdx/dFdy`) gives brightness; rendered top-down into a 512 px target every 4th frame and added to the terrain's `emissiveNode` |
| Cost | Cheap, in the surface shader | An extra render pass (throttled), plus a terrain material patch |
| Correctness | Decorative | Physically motivated; brightness follows where rays actually focus |

### Buoyancy / height query

| | WaterThreeJS | Ours |
|---|---|---|
| CPU access | `surfaceSample()`: CPU port of the wave loop, 4 fixed-point iterations to invert the horizontal displacement, so a body at (x, z) gets the true surface height; terrain-shelf collision stops boats sinking into the island | None; the surface is flat, so height is just `waterLevel` |
| Needed for | Boats, swimming bots, floating debris, contact foam | Only becomes a need if the surface moves |

### Multiple water bodies

| | WaterThreeJS | Ours |
|---|---|---|
| Support | One ocean at one level | One level for the whole map (`waterLevel`); a lake above sea level, or a lake and an ocean with different behaviour, is not expressible |

### Tuning and tooling

| | WaterThreeJS | Ours |
|---|---|---|
| Parameters | ~50 uniforms (wind, wave counts/frequencies/amplitudes, four colours, foam thresholds and coverage, roughness, SSR/refraction strength, clarity, depth falloff, contact-body arrays), GUI, six presets | ~30 options in `DEFAULTS`, slider panels in `environment-viewer.html`, `?water*=` URL flags, Perf A/B panel, HUD stats, quality tiers (stored, not yet read) |
| Perf instrumentation | None | Frame profiler entry, pass counters, throttles, visibility gates |

## 3. Summary of differences

Things WaterThreeJS has that ours does not:
- Displaced Gerstner swell with dispersion, wind direction and choppiness
- Foam (folds, whitecaps, shore band, contact wakes)
- Beer-Lambert absorption from a true per-pixel thickness
- GGX sun glint with distance roughness
- Underwater view (Snell's window)
- CPU surface height query for buoyancy
- Screen-space reflection that stays valid on non-flat water

Things ours has that WaterThreeJS does not:
- Clipmap LOD, terrain-cell culling, budgeted rebuilds, finite-map clipping
- Physically derived caustics projected onto the terrain
- Reflection and caustic throttles, resolution scale, visibility gates, HUD stats
- WebGPU/TSL implementation that fits the rest of this codebase
- Integration with the shared lighting rig and the viewer's slider/URL/A/B tooling

Things both do, differently:
- Reflection: SSR (per-pixel march, on-screen only, any surface shape) vs. planar mirror (extra scene render, correct only for flat water)
- Refraction: dedicated colour+depth pass vs. framebuffer readback with vertex depth
- Depth colour: exponential absorption vs. linear mix
- Fresnel: Schlick power 5 vs. power 3

Things in their repo that are not water at all (sky, clouds, god-rays, HDR/ACES
post, presets) overlap with `sky.js`, `clouds.js`, `post-fx.js`.

## 4. Demo

`demos/water-demo.html` implements both columns of every table above as switches in one shader,
per body of water (an ocean and a lake coexist in the scene), with presets for "water.js lake",
"WaterThreeJS ocean" and a hybrid. The techniques live in `water-hybrid.js`
(`test-water-hybrid.mjs`) over `water-waves.js` as their CPU twin (`test-water-waves.mjs`), so the
demo and the optional ocean in `demos/flight-sim.html` share one implementation. Deviations from the
sources are listed in the demo page's header.

## 5. Open questions this comparison surfaces (not answered here)

- Which maps need ocean-grade water, and do any need lake and ocean at once?
- Is a moving surface required (which pulls in buoyancy for anything that touches water)?
- Is planar reflection error on displaced crests acceptable, or is SSR's cost and on-screen-only limit the better trade?
- What frame budget is water allowed on the heaviest scene?
