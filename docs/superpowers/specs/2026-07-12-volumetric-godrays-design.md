# Volumetric God-Rays Design

Date: 2026-07-12

## Context

A request came in to evaluate `cullenwebber/three-volumetric-light` (a Three.js
volumetric-light demo) and how it could be added to this viewer. This spec covers a
volumetric light-shaft ("god-ray") effect for the WebGPU environment, adapted to our
stack rather than ported line-for-line.

The reference repo is **WebGL + hand-written GLSL** (Three.js `^0.182`, `vite-plugin-glsl`).
Its beam is a `BoxGeometry` drawn `BackSide` with `AdditiveBlending` and depth test/write
off; the fragment shader raymarches 16 steps (`defines: { STEPS: 16 }`) from the camera
through the box, and at each step evaluates a spotlight cone falloff, quadratic + exponential
distance attenuation, 2D FBM streaks, 3D FBM smoke, and shadow-map + scene-depth occlusion.
A separate compositor renders a quarter-res depth prepass, the beam at reduced resolution,
the scene at full-res half-float, a mip-cascade bloom, and a final add of scene + bloom + beam.

**None of that code is drop-in usable here.** This viewer is **WebGPU + TSL** (Three.js
r0.184). A GLSL `ShaderMaterial` and manual `WebGLRenderTarget` ping-pong do not run on the
WebGPU backend. What transfers is the *algorithm* (raymarched cone density with depth
occlusion), not the source. We also already have a bloom cascade in `post-fx.js`, so we take
only the beam, not the reference compositor.

## Findings

1. Our post stack is the natural insertion point.

`post-fx.js:26` builds `const scenePass = pass(scene, camera)`. In `build()` (`post-fx.js:62`)
the `full` path composes `scenePassColor.add(bloomPass)` (line 71) before tone-map and grade.
A god-ray contribution wants to be added to the HDR color *before* bloom so the shafts bloom
naturally, i.e. `scenePassColor.add(beamNode).add(bloomPass)`.

2. The pass already exposes scene depth.

The reference renders a dedicated quarter-res depth prepass to feed `uSceneDepth`. On our
side `scenePass` (a TSL `PassNode`) can yield depth directly (`getDepthNode()` /
`getViewZNode()`), so occlusion comes from data we already compute. No separate depth target.

3. We already have a sun direction and a day/night light model.

`sky.js` owns the key light direction (the sun/moon sprite is locked to it) and
`environment-viewer.html` calls `skyRef.setSunDir(d)` every frame. A sky-shaft effect should
be driven from that same direction rather than introducing a new spotlight, so beams stay
consistent with the visible sun and with `applyCelestialLight()`'s sun/moon swap.

4. Raymarched full-screen passes are a known throttle risk on this hardware.

The RTX 3060 Laptop in the telemetry set throttles under sustained GPU load, and `passPostMs`
is already one of the larger frame contributors in recent A/B runs. A per-fragment raymarch
over the whole screen must be opt-in, low-step, and half-res by default, and must be measured
against the warm-window GPU telemetry, not just eyeballed.

5. Shadow-shaft occlusion is the expensive, optional part.

The reference samples a shadow map inside the march (`uShadowMap`) so geometry casts dark
shafts through the light. Replicating that on WebGPU/TSL means feeding a light-space depth
texture into the post node — significantly more wiring than depth-only occlusion, for a
second-order visual gain. It is explicitly out of scope for v1.

## Design

### 1. Scope: sun/sky shafts, not a spotlight demo

Implement god-rays as atmospheric shafts along the sun direction, gated behind a URL flag.
Do not reproduce the reference's arbitrary spotlight rig. The effect reads `skyLightDir()`
(or the same value the viewer already feeds `skyRef.setSunDir`) as the beam direction and the
sky/sun disc color as the beam tint.

### 2. New module: `godrays.js`

A single lazy-loaded module owning a TSL node factory:

```js
// godrays.js
export function createGodRays({ camera, sunDirUniform, params }) -> {
  node,                 // TSL color node: raymarched shaft contribution (vec3)
  setEnabled(v),
  setParams(p),         // live uniform writes: steps? no (rebuild), density, decay,
                        //   weight, exposure, tint, height falloff
  dispose(),
}
```

- `node` is a TSL function that, given the pass's depth and the camera near/far, marches a
  fixed number of steps from the camera through the atmosphere and accumulates cone density
  toward the sun direction, attenuated by height and by scene depth (a fragment whose scene
  depth is nearer than the sample distance is occluded).
- Reimplement the reference's `sampleBeam` math in TSL: cone falloff toward `sunDir`,
  `1/(1+a·d²)` × `exp(-d·falloff)` attenuation, and a 2-octave value-noise "haze" term.
  Reuse the noise helper approach already used elsewhere (e.g. `grass.js`
  `buildGrassNoiseFns().noise2D`, as `particles.js` does) rather than inventing a new noise.
- Step count is a `define`-style constant baked at build; changing it rebuilds the node.
  Everything else (density, decay, weight, exposure, tint, height falloff) is a live uniform.

### 3. Wire into `post-fx.js`

`createPostFX` gains an optional `godrays` node input:

- Accept `opts.godRaysNode` (a TSL color node) and `opts.godRaysEnabled`.
- In `build()`, when god-rays are enabled and `mode === 'full'`, compose
  `scenePassColor.add(godRaysNode).add(bloomPass)` instead of `scenePassColor.add(bloomPass)`.
  In `grade`/`output`/`scene` diagnostic modes, god-rays are skipped (same as bloom).
- Pass the god-ray node the pass depth so occlusion reads the already-rendered scene:
  the node factory receives `scenePass.getViewZNode()` (or depth) at construction.
- Add `setGodRays(strength, ...)` and `setGodRaysEnabled(v)` to the returned object, mirroring
  the existing `setBloom` / `setEnabled` style (plain uniform writes, no graph rebuild except
  step-count changes).

### 4. URL flag and defaults

Add `?godrays=off|on` (default `off`), plus `?godraysQuality=low|medium|high` mapping to step
count and resolution intent:

- Low: 8 steps, half-res intent, depth occlusion only.
- Medium: 12 steps, half-res.
- High: 16 steps, full-res (screenshot tier).

Defaults target gameplay, not screenshots: shipped default is `off`; when enabled without a
quality param, default to `low`. Default `weight`/`density` chosen so that with the flag on but
sliders untouched the effect is subtle, matching how `post-fx.js` bloom defaults to a near
no-op (`post-fx.js:28`).

### 5. Tunable parameters (inline UI, "Effects" tab)

Following the established pattern, the sliders live inline in `environment-viewer.html` (not
`environment-ui.js`), under a `header('God rays')` section, routed to the Effects tab by adding
`'God rays'` to `environment-ui.js`'s `effectsNames`. Params, all live via `postFX.setGodRays`:

- `godrays` (on/off toggle)
- `godRayDensity` (0–1) — cone/haze density along the shaft
- `godRayDecay` (0.8–1.0) — per-step falloff
- `godRayWeight` (0–2) — overall shaft brightness added to HDR color
- `godRayExposure` (0–1) — start-sample scale
- `godRayHeightFalloff` (0–0.05) — atmospheric density decrease with world Y
- `godRayTintR/G/B` — shaft color (defaults sampled from the sun disc palette)

Step count is exposed only as the `godraysQuality` URL tier (rebuild cost), not a live slider.

### 6. Telemetry

Add a `passGodRaysMs`-style contribution and log:

- `godRaysMode` (off/on)
- `godRaysQuality`
- `godRaysSteps`
- `godRaysResScale`

god-rays cost lands in the post path, so also confirm `passPostMs` deltas are attributable to
this pass in A/B runs. Join against the warm-window GPU telemetry per the standing thermal
caveat before drawing conclusions.

### 7. Explicit non-goals for v1

- **No shadow-map shaft occlusion** (`uShadowMap` in the reference). Depth-only occlusion
  from the pass is v1; light-space shadow shafts are a possible v2.
- **No dedicated depth prepass** — reuse the pass depth.
- **No new bloom** — reuse `post-fx.js`'s cascade by injecting before it.
- **No reflection integration** — water reflection does not need to re-render shafts.

## Milestones

1. Node prototype

Build `godrays.js` with the TSL raymarch node and a temporary hard-wire into `post-fx.js`'s
`full` path. Prove the shafts render and occlude against scene depth on the current map. No UI,
no flags yet.

2. Flag + quality tiers

Add `?godrays=` and `?godraysQuality=`, map tiers to step count / resolution intent, default
`off`. Confirm a disabled build is a zero-cost path (module not imported), matching the
`?particles=off` / `?post=off` gating.

3. Inline UI + live params

Add the "God rays" slider section in `environment-viewer.html`, route it to the Effects tab,
wire every slider to `postFX.setGodRays`. Confirm all params are live uniform writes (no graph
rebuild except step-count changes).

4. Telemetry + A/B

Add the CSV fields and a post-path timing contribution. Capture the standard camera route on
and off, at low/medium/high, and join GPU telemetry.

5. Docs + log

Add a `godrays` row/section to `docs/subsystems/fx.md` (the effect lives in the FX subsystem
alongside `post-fx.js`), update `code-map.html` if a new node is worth surfacing, and append to
`agent_log.csv`.

## Verification

Run the same camera route with:

- Baseline (`?godrays=off`, current default).
- `?godrays=on` (defaults to low).
- `?godraysQuality=medium`
- `?godraysQuality=high`
- Sun high vs. sun near horizon (shafts should strengthen at grazing sun angles).
- A frame with a large occluder (tree/terrain ridge) between camera and sun — the occluder
  must darken the shaft region via depth occlusion.

Pass targets:

- `?godrays=off` is byte-for-byte the current post path (module not loaded, no `passPostMs`
  change).
- Low tier adds no more than ~1.5ms `passPostMs` on the standard route at half-res, warm-window
  GPU telemetry joined.
- Shafts visibly align with the sun disc from `sky.js` and fade correctly when the sun is below
  the horizon (no shafts at night / when `moonLight` is the key light, unless explicitly tuned).
- No banding at low step counts (dithered start offset, as in the reference).
- Toggling the flag and every slider causes no shader recompile hitch except changing the
  `godraysQuality` step tier.
