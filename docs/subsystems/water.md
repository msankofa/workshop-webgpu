# Water

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#water)

## Purpose

Renders lake water for heightfield terrain: a camera-following clipmap of water
surface rings with planar reflection, screen-space refraction of the lakebed, and
projected caustic lighting cast back onto the terrain. Ported from the
martinRenou/threejs-water techniques (real reflection/refraction/caustics math,
not faked) but adapted to lakes carved from a terrain heightfield instead of a
walled pool — no raytraced walls or ping-pong height simulation, just analytic
ripples and a reference bed plane.

## See also

- `docs/water-vs-waterthreejs-comparison.md` compares this subsystem with achrefelouafi/WaterThreeJS
  (ocean water), and `demos/water-demo.html` puts both sets of techniques behind switches per body of
  water. Nothing in this subsystem imports the demo.
- `water-hybrid.js` + `water-waves.js` are the shared implementation of that comparison's techniques
  (Gerstner spectrum, Beer-Lambert absorption, GGX glint, foam, plus this file's 3-sine ripples,
  linear depth mix and Phong highlight), used by `demos/water-demo.html` and by the optional ocean in
  `demos/flight-sim.html`. `water.js` itself does **not** import them — the lake system in the
  environment viewer is unchanged.
- `water-config.json` at the repo root carries the settings for those two pages: `demos/water-demo.html`
  writes it (`POST /api/save-water-config` in `serve.py`, falling back to a download) and
  `demos/flight-sim.html` reads it on load and behind a refresh button. It has one entry per body of
  water (`ocean`, `lake`). `water.js` does not read it; the environment viewer's lake settings are
  still its own sliders.

## Files

- `water.js` (1117 lines) — the entire subsystem: geometry generation (clipmap
  rings), TSL shader material (waves/reflection/refraction/caustics), reflection
  and caustic render-target management, and the public `createWaterSystem` API.

## Public API

```js
import { createWaterSystem, WATER_VERSION } from './water.js';
```

### `createWaterSystem(options = {}) -> WaterSystem`

Key `options` (full list is the `DEFAULTS` object, water.js:45-83):
`renderer`, `scene`, `camera`, `ground` (terrain mesh, for caustic emissive
injection), `size`, `waterLevel`, `heightFn(x, z) -> y`, `lightDir`
(`THREE.Vector3`, defaults to a fixed sun direction), `shallow`/`deep` colors,
`refractStrength`, `reflectStrength` (ripple-distortion strengths), `reflectMix`,
`reflectBrightness`, `reflectResolutionScale` (perf: reflector render-target
scale, default `0.5` — half resolution per dimension), `reflectRate` (perf:
render the reflection every Nth frame, default **`2`** since 2026-07-09), `depthScale`,
`waveStrength`, `caustic`, `causticBedDepth`, `causticRes` (default **`512`**
since 2026-07-09), `causticRate` (perf: render the caustic pass every Nth
eligible frame, default **`4`** since 2026-07-09), clipmap tuning
(`lodR0`, `lodR1`, `cellS0/1/2`, `buildBudgetMs`, `maxBuildsPerFrame`),
`extentX`/`extentZ` (clip the water mesh to a finite map), `deferredDisposeFrames`.

Returns a `WaterSystem` object (water.js:1114):

```js
{
  surface,            // THREE.Group — add to scene
  version,            // WATER_VERSION string
  update(timeSec),    // call once per frame, BEFORE renderer.render(scene, camera)
  resize(),           // no-op today (RTs auto-size); kept for API stability
  regenerate(opts),   // re-derive geometry on terrain/size/waterLevel/heightFn change
  setWaves(strength),
  setCaustic(strength),
  setReflectionTuning({ reflectStrength, refractStrength, reflectMix, reflectBrightness, depthScale, reflectResolutionScale, reflectRate }),
  setReflectRate(everyNFrames),   // perf: throttle reflection re-renders to every Nth frame (see notes)
  setLightDir(THREE.Vector3),     // re-aim specular + caustic refraction
  setLodDistances(r0, r1),
  getChunkCount(),
  getStats(),          // -> stats object consumed by the debug HUD
  dispose(),
  // perf (2026-07-08, perf-recovery Wave 0, water-performance-design.md §1) — pass-through
  // setters added for the URL-flag/Perf-A/B-panel scaffolding. None of them change any
  // DEFAULT createWaterSystem() starts with; they only add a way to change it afterward.
  setReflectionEnabled(enabled),  // explicit on/off override, ANDed with the existing reflectMix/reflectBrightness gate (default true = no override)
  setCausticsEnabled(enabled),    // explicit on/off override, ANDed with the existing causticStrength gate (default true = no override)
  setCausticRate(everyNFrames),   // perf: throttle the caustic pass to every Nth eligible frame, same seam as setReflectRate (construction default now 4, see "Defaults" below)
  setCausticRes(resolution),      // perf: resizes the fixed-size causticsTarget WebGLRenderTarget at runtime (causticsTarget.setSize) — default stays whatever causticRes/DEFAULTS.causticRes (512 since 2026-07-09) was at construction until called
  setQuality(preset),             // 'low'|'medium'|'high' — STORED ONLY in this task (see "Water shader quality tiers" below); nothing reads it yet
  // perf (2026-07-09, water-performance-design.md §3) — master on/off for the two gates this
  // task adds (see "Visibility/strength gates" below). Default true (gates armed).
  setVisibilityGatesEnabled(enabled),
}
```

Caller responsibilities each frame: call `water.update(now / 1000)` before the
main scene render call; the reflector and caustic passes fire their own
`renderer.render(...)` calls internally during that draw via TSL node
`updateBefore()` hooks, not inside `update()` itself.

## Wiring

`environment-viewer.html` lazy-loads the module:

```js
_waterPromise = import('./water.js?v=reflection-controls-1').then(({ createWaterSystem }) => { ... })
  .catch(err => { showError('water.js could not load (' + err.message + ')'); });
```
(around line 2038; the `?v=` query string is a cache-buster bumped per change).

Inside the `.then`:
- `params` is extended with default values for `waterWaves`, `caustics`,
  `waterLodR0/R1`, `waterReflectMix`, `waterReflectBrightness`,
  `waterReflectRipple`, `waterRefractRipple`, `waterDepthScale`.
- `waterRef = createWaterSystem({ renderer, scene, camera, ground, size: terrain.size, waterLevel: terrain.waterLevel, heightFn: terrainHeight, ...extent, lodR0, lodR1, reflectMix, reflectBrightness, reflectStrength, refractStrength, depthScale })`.
  `ground` is the CDLOD terrain mesh — water patches its `emissiveNode` for
  caustics. If a heightmap-based map is loaded, `extentX`/`extentZ` are passed
  from `loadedMap.worldX/worldZ` to clip the clipmap to the finite map bounds.
- `scene.add(waterRef.surface)`.
- `syncWaterChunks(true)` — pushes the regenerate call (terrain/waterLevel sync helper defined in the same file, ~line 693).
- `rig.connect(waterRef, null)` — registers `waterRef` with the shared lighting
  rig (`lights.js`, `createLightingRig`). `connect()` pushes `water.setLightDir`
  on every sun azimuth/elevation slider change, keeping reflection specular and
  caustic refraction locked to the same sun direction the rest of the scene uses.
- Slider panels (`header`/`slider` helpers) are registered for Water (wave
  strength, caustics), Water Reflection (reflect amount/brightness, reflect/
  refract ripple, depth tint scale), and Water LOD (near/mid radius) — see
  Tunable Parameters below.

Per frame, in the main render loop (around line 2805-2808):
```js
frameProfiler.time('water', () => { if (waterRef) { waterRef.update(now / 1000); } });
```
called after `portCreatures.update` and before the HUD/grass/forest updates,
and before the actual `renderer.render(scene, camera)` draw call later in the
loop. Terrain/water-level edits route through `syncWaterChunks(force, extra)`
(line ~693), which calls `waterRef.regenerate({ size, waterLevel, heightFn, ...extent })`
whenever the terrain signature changes; this is invoked from `worldRebuild()`
and the chunk-streaming logic (`updateTerrainWindow`). `resize()` is called from
the window-resize handler (line ~2215) but is currently a no-op. `getStats()` is
polled by `syncWaterDebug()` (line ~703) to populate `terrainDebug.water*`
fields consumed by the on-screen HUD and `environment-ui.js`'s frame-profiler
panel (`['water', 'Water', 'passWaterMs']` and the `Water` / `Water FX` HUD rows
at environment-ui.js:621-622).

## Architecture notes

- **Clipmap LOD geometry.** Instead of one big quad, the water surface is three
  concentric square "rings" (`waterRings[0..2]`) re-centered on the camera's XZ
  position, snapped to grid steps (`lodConfig.snaps = cells * 4`) so rebuilds are
  infrequent. Ring 0 is finest (`cellS0`, radius `lodR0`), ring 1 medium
  (`cellS1`, out to `lodR1`), ring 2 coarsest (`cellS2`, out to the map extent or
  `size`). Ring N's geometry is cut out where ring N-1 already covers, via
  `emitRect`-based rectangle clipping against the inner ring's bounds
  (`createRingGeometryJob`, water.js:294-448).
- **Incremental/budgeted builds.** Ring geometry is generated by a coroutine-like
  job object (`step(deadlineMs)` does as much work as fits in a time budget, then
  yields) so a full clipmap rebuild doesn't spike frame time. `processRingQueue()`
  (water.js:925) runs each frame, gated by `buildBudgetMs` (default 1.5ms) and
  `maxBuildsPerFrame`, committing at most one ring per call by default. Sampled
  terrain heights are memoized per LOD level in `heightCaches` (`sampleCachedHeight`)
  to avoid recomputing `heightFn` for shared vertices across rebuilds.
- **Deferred disposal.** Old ring geometries aren't disposed immediately on
  rebuild — they're queued (`queueGeometryDispose`) and freed a few frames later
  (`deferredDisposeFrames`, default 4) via `drainDeferredDisposals`, presumably to
  avoid disposing a buffer still in flight to the GPU.
- **Water-only verts are culled at build time.** Only triangles where the
  terrain is below `waterLevel` at all four corners are emitted (dry land is
  simply not meshed), keeping triangle count proportional to actual lake area.
- **TSL shader, not GLSL.** The shading is built from `three/tsl` nodes
  (`Fn`, `uniform`, `mix`, `dot`, etc.) assigned to `surfaceMat.colorNode` /
  `opacityNode` on a `MeshBasicNodeMaterial`. The file keeps the original GLSL
  source (`WAVE_GLSL`, `SURFACE_VERT/FRAG`, `CAUSTIC_VERT/FRAG`) as comments/dead
  code documenting what each TSL block is a port of — useful for cross-checking
  the math but not actually used at runtime (no `ShaderMaterial` is constructed
  from those strings).
- **Waves.** `waveH(p)` is a 3-octave sine sum driven by a `uTime` uniform;
  `rippleNormal(p)` finite-differences it (epsilon 0.15) into a surface normal.
  Both refraction-offset and caustic ray-bending reuse this same node function so
  ripples are visually consistent across all three effects.
- **Reflection — `reflector()` (ReflectorNode).** Uses Three.js's built-in TSL
  `reflector()` node, which owns its own mirror camera, render target, and
  oblique near-plane clip (the classic Lengyel/THREE.Reflector technique) —
  replacing a hand-rolled reflection camera from earlier in the file's history.
  Constructed as `reflector({ resolutionScale: o.reflectResolutionScale })`
  (water.js:561, default `0.5` = half-res render target in each dimension —
  the reflection is already distorted by the ripple-normal UV offset and
  Fresnel-blended, so the loss of sharpness is not noticeable).
  `tsl_reflector.target.rotation.x = -Math.PI/2` orients the mirror plane
  horizontal (local +Z -> world +Y). The reflector's `updateBefore` is wrapped
  (water.js:584-605) to gate the render behind `reflectionEnabled` (true only
  when both `reflectMix > 0` and `reflectBrightness > 0`), throttle it to every
  `reflectEvery`th frame (see Performance levers below), and record timing
  stats (`reflectionRenderStats`). Reflection UV is perturbed by the ripple
  normal (`tsl_reflector.uvNode.add(N.xz.mul(tsl_uReflectStrength))`) and the
  sampled color is scaled by `reflectBrightness`, then Fresnel-blended against
  refraction by `reflectMix`.
- **Refraction — `viewportSharedTexture`.** No separate refraction render
  target/pass: `viewportSharedTexture(screenUV.add(refractOffset))` reads back
  the live framebuffer (already containing terrain/sky, since water has
  `renderOrder = 1` and draws after opaques) via Three's internal
  `copyFramebufferToTexture()`, triggered automatically during the node
  system's `RENDER`-phase update. This means refraction sees whatever was
  drawn earlier in the same frame, not a dedicated "scene minus water" pass.
- **Caustics — manual render-to-texture.** Unlike reflection/refraction, the
  caustic pass keeps a real `THREE.WebGLRenderTarget` (`causticsTarget`,
  resolution `causticRes`) and a custom orthographic-ish `THREE.Camera`
  (`causticCamera`, hand-built view/projection matrices mapping world XZ to a
  top-down clip-space map — note it has `updateProjectionMatrix = () => {}`
  stubbed out because WebGPURenderer calls it on plain `THREE.Camera`, which
  has no such method and would otherwise crash). `causticGroup` (a meshes-only
  scene, `causticScene`) renders a top-down caustic intensity map: each
  vertex's light ray is Snell-refracted by both the flat and the rippled
  surface normal, intersected with a reference bed plane (`causticBedDepth`
  below `waterLevel`), and the ratio of pre/post-refraction triangle areas
  (via `dFdx`/`dFdy` screen-space derivatives on varyings) gives the caustic
  brightness — bright where rays focus, dim where they spread. A
  `CausticTextureNode` (extends `TextureNode`, `updateBeforeType = RENDER`)
  performs the actual `renderer.render(causticScene, causticCamera)` into
  `causticsTarget` each frame inside its `updateBefore`, gated by
  `causticStrength > 0`. The terrain material (`ground.material`, a node
  material) gets a reverse-projection caustic sample added to its
  `emissiveNode` (additive — preserves any prior emissive term, e.g. clustered
  point-light contributions), so caustics show up as extra light on the
  lakebed without touching the terrain's base color.
- **Light direction.** `setLightDir(v)` updates both the surface specular
  uniform and recomputes the flat-surface refracted ray (`refractVec`, a
  CPU-side GLSL-equivalent `refract()`) used by the caustic vertex/terrain
  shaders, keeping caustics aligned with whatever direction the lighting rig's
  sun is currently pointing.
- **Performance levers:** `buildBudgetMs`/`maxBuildsPerFrame` cap clipmap rebuild
  cost per frame; `causticRes` controls the caustic RT resolution (cost of the
  extra render pass). The reflection render (measured at ~10.6ms/frame average
  before this fix — see `creature-perf-analysis/render-bottleneck-fixes.md`
  Problem 1) has two independent throttles, both live and runtime-adjustable:
  - `reflectResolutionScale` (default `0.5`) sets the reflector render target's
    resolution scale. Passed at construction (`reflector({ resolutionScale })`,
    water.js:561) but also safe to change at runtime via `setReflectionTuning({
    reflectResolutionScale })`, which assigns `reflectorBase.resolutionScale`
    directly — `ReflectorBaseNode._updateResolution()` re-reads that property
    on every render (three.webgpu.js:37162-37170, called from `updateBefore` at
    37268), so a runtime change takes effect on the very next reflection render,
    no rebuild needed.
  - `reflectRate` / `setReflectRate(everyNFrames)` (default **`2`** since 2026-07-09, i.e. every
    2nd frame — was `1`/every frame; see the "URL flags" section below for how a URL flag or the
    Perf A/B panel changes this live in either direction) throttles how
    often the reflection actually re-renders. The `reflectorBase.updateBefore`
    wrapper (water.js:584-605) counts distinct `frame.frameId` transitions (a
    plain call counter would also work — see the in-code comment on why
    `frame.frameId` isn't simply "app frame number" on its own, since it's
    bumped by every internal `renderer._renderScene()` call including the
    reflector's own nested render) and skips the real `renderReflection(frame)`
    call on non-multiple frames, returning early **without** touching
    `textureNode.value` — the previous render target's texture stays bound, so
    there is no blank-frame flash. The very first frame always renders (frame
    counter starts such that `0 % N === 0` for any `N`), so there's no blank
    reflection at startup. `setReflectRate(1)` restores full per-frame
    rendering. This was previously a dead no-op API (`water.js:976-981` in the
    pre-throttle version) — it is now wired through.
  - `reflectionRenderStats` tracks `passes` (real renders only), `skipped`
    (throttled-away frames), and `lastMs` (wall-clock time of the last real
    render only — stays at its last value, not reset to 0, while a frame is
    skipped). Surfaced via `getStats()` as `reflectionPasses`,
    `reflectionSkipped`, `reflectionLastMs`, `reflectionResolutionScale`,
    `reflectionRate`.
  Disabling reflection (`reflectMix` or `reflectBrightness` at 0) or caustics
  (`caustic` at 0) skips their respective render passes entirely (checked in
  `reflectorBase.updateBefore` / `CausticTextureNode.updateBefore`).
- **Caustic throttle (2026-07-08, perf-recovery Wave 0).** `CausticTextureNode.updateBefore`
  (water.js:~845-880) has the exact same every-Nth-frame throttle as the reflector: a
  `causticFrameCounter` counts distinct `frame.frameId` transitions, and on a non-multiple frame
  the function returns **without** touching `this.value` (or rendering), leaving the previous
  `causticsTarget.texture` bound — never a blank/black caustic frame. Controlled by
  `setCausticRate(everyNFrames)` (construction default now **`4`** since 2026-07-09, was `1` —
  see "Defaults" below). `causticRenderStats.skipped` counts
  throttled-away frames, surfaced via `getStats()` as `causticSkipped`; `causticRate` (also from
  `getStats()`) is the currently configured throttle divisor. `setCausticRes(resolution)` calls
  `causticsTarget.setSize(resolution, resolution)` at runtime — the render target was previously
  fixed-size for the life of the water system; `getStats().causticRes` reads back the live size
  (`causticsTarget.width`). `setCausticsEnabled(enabled)` / `setReflectionEnabled(enabled)` are
  explicit on/off overrides ANDed with the existing strength-based gates (`causticStrength > 0`
  / `reflectMix > 0 && reflectBrightness > 0`) — both default to `true` (no override), so gating
  behavior is identical to before these setters existed unless something calls them.

### Defaults (2026-07-09, water-performance-design.md §1/§2)

`DEFAULTS` in `water.js` (lines ~45-83) now targets stable gameplay framerate over screenshot
sharpness:

| Option | Old default | New default |
|---|---|---|
| `reflectRate` | `1` (every frame) | **`2`** (every 2nd frame) |
| `causticRate` | `1` (every frame) | **`4`** (every 4th frame) |
| `causticRes` | `1024` | **`512`** |
| `reflectResolutionScale` | `0.5` | unchanged |

The design doc's §1 offered two options for caustics: off by default, or every-4th-frame at
512px. This task picked **rate-4-at-512px over off-by-default** so caustic lighting on the
lakebed still reads as present (dimmer/coarser, never absent) instead of vanishing outright —
caustics are a small, localized visual detail (light patches on the lake bed) rather than a
scene-wide cost like the reflection pass, so keeping a throttled version live was judged worth
the residual GPU cost. All four defaults above are still fully overridable in both directions —
raise or lower — via the `?water*=` URL flags and the "Water"-section Perf A/B panel controls
(see "URL flags + Perf A/B panel" below); nothing about the override mechanism changed, only the
values `createWaterSystem()` starts with when no flag/control touches them.

### Visibility/strength gates (2026-07-09, water-performance-design.md §3)

Both the reflection and caustic passes now skip the nested `renderer.render(...)` call entirely
(not just throttle it) under additional conditions, layered on top of the pre-existing
`reflectMix`/`reflectBrightness`/`causticStrength` gates:

- **Reflection** — also skipped when there is no visible water ring geometry:
  `hasVisibleWaterRings()` (water.js:~648, checked inside `reflectorBase.updateBefore`) is
  `waterRings.some(r => r && r.mesh)` — `false` before the first ring build lands (startup) or
  on a map with no water cells at all (nothing ever crosses `waterLevel`, so no ring mesh is
  ever committed). `reflectionRenderStats.enabled` (surfaced as `getStats().reflectionEnabled`)
  now reflects `reflectionEnabled && hasVisibleWaterRings()`, recomputed on every real render.
  **Deviation from the spec:** §3 also asks for "the camera well above water and the water plane
  not in the view frustum." There is no existing frustum-test helper in this file for the
  clipmap rings against `camera`'s frustum, and building one correctly (three concentric,
  re-centering rings, not a single static mesh) is more than the "cheap check" the task scoped
  this gate as — landing it risked either a wrong/flickery gate or scope creep into a mini
  frustum-culling system. The strength- and ring-count gates are landed; the frustum gate is
  reported as not implemented rather than approximated.
- **Caustics** — also skipped when the light direction is at or below the horizon:
  `computeCausticEnabled()` (water.js:~490) ANDs the pre-existing gates with
  `lightDir.y > CAUSTIC_MIN_LIGHT_ELEVATION` (`0.02`, ~1.15° above horizon — `lightDir` is the
  normalized world-space unit vector toward the light, so `.y` is the sine of its elevation).
  Below that, Snell-refracted caustic rays go near-vertical/invalid and the top-down caustic
  projection degenerates, so the pass isn't worth its cost. `setLightDir(v)` (called every frame
  by the lighting rig as the sun moves) recomputes `causticRenderStats.enabled` synchronously so
  a horizon crossing is reflected in `getStats()` immediately, not just on the next real render.

Both gates are ANDed with a single master toggle, **`visibilityGatesEnabled`** (default `true`),
settable via `setVisibilityGatesEnabled(enabled)` and surfaced as `getStats().visibilityGatesEnabled`
— wired to the Perf A/B **"Water visibility gates"** toggle so an A/B run can isolate the two new
gates' contribution from the rate/resolution/strength throttles that predate this task. Turning
it off does not touch `reflectMix`/`reflectBrightness`/`causticStrength`/`causticGroup`
child-count — those remain their own independent, always-on gates.

## URL flags + Perf A/B panel (2026-07-08, perf-recovery Wave 0)

`environment-viewer.html` parses `water-performance-design.md` §1's URL flags into a
`WATER_URL_FLAGS` object (top-level, near the other URL flags ~line 95) and applies them as
runtime-setter calls immediately after `createWaterSystem(...)` returns — **never** as
construction options — so omitting every `?water*=` flag leaves `createWaterSystem()`'s own
defaults (`reflectRate: 2`, `causticRate: 4`, `causticRes: 512`, caustics on,
`reflectResolutionScale: 0.5` — see "Defaults" above) completely untouched. Since these flags
only ever *call a setter*, they work in both directions — e.g. `?waterReflectRate=1` raises the
rate back to every-frame, `?waterCausticRate=8` lowers it further:

| Flag | Values | Setter called |
|---|---|---|
| `?waterReflection=` | `on`\|`off` | `setReflectionEnabled(bool)` |
| `?waterReflectRate=` | `1`\|`2`\|`3`\|`4` | `setReflectRate(n)` |
| `?waterReflectScale=` | `0.25`\|`0.5`\|`0.75`\|`1` | `setReflectionTuning({ reflectResolutionScale })` |
| `?waterCaustics=` | `on`\|`off` | `setCausticsEnabled(bool)` |
| `?waterCausticRate=` | `1`\|`2`\|`4`\|`8` | `setCausticRate(n)` |
| `?waterCausticRes=` | `256`\|`512`\|`1024` | `setCausticRes(n)` |
| `?waterQuality=` | `low`\|`medium`\|`high` | `setQuality(preset)` — **stored only**, see below |

`?waterQuality`/`setQuality(preset)` is Wave 0 scaffolding only: it stores `preset` in a local
`waterQualityPreset` variable (surfaced via `getStats().qualityPreset`, and the perf CSV's
`waterQuality` column) but nothing in the render path reads it yet. Design section 4 ("Water
shader quality tiers" — low/medium/high normal-sampling and reflection/caustic defaults) is
explicitly deferred past this task; the flag exists now so a later wave doesn't need another
round of URL-flag plumbing.

The same water block also registers **Perf A/B panel** controls (`window.perfAB.addToggle` /
`addSlider` / `addSelect`, see `infra.md` for the registry API) for every flag above except
`waterQuality`, plus one more added 2026-07-09: "Water reflection" toggle, "Reflect rate" slider
(1-4 step 1), "Reflect scale" select (`[0.25, 0.5, 0.75, 1]`), "Caustics" toggle, "Caustic rate"
slider (1-8 step 1), "Caustic res" select (`[256, 512, 1024]`), and **"Water visibility gates"**
toggle (default `true` — calls `setVisibilityGatesEnabled`, see "Visibility/strength gates"
above). Each control's initial position follows its URL flag when
present, else the construction default — so a reload with no flags shows the panel already
reflecting `reflectRate=2`/`causticRate=4`/caustics-on/gates-on/etc. (see "Defaults" above). The
perf CSV's `waterQuality`/`waterCausticRate` columns (and the pre-existing
`waterReflectionRate`/`waterReflectionResolutionScale`/`waterReflectionPasses`/
`waterCausticPasses` columns) read `waterRef.getStats()` **live** every sample, not the flags'
initial values, so a capture taken while toggling the panel mid-run stays interpretable (per the
orchestration plan's rule 7). `waterReflectionPasses`/`waterCausticPasses` count only real,
non-skipped `renderer.render(...)` calls (`reflectionRenderStats.passes`/
`causticRenderStats.passes`, incremented at the bottom of each `updateBefore` after a pass
actually runs, never on a throttled/gated-out frame) — dividing either by the CSV's sampled
frame count over a window approximates `1 / rate` (lower still when a gate is also active).

## Tunable parameters

All registered as sliders in `environment-viewer.html`'s lazy water-loader
callback (~line 2058 onward), backed by the shared `params` object:

**Water**
- `waterWaves` — "Wave strength", 0-3 -> `water.setWaves(v)` (drives `tsl_uWave`, shared by surface ripples and caustic ray bending).
- `caustics` — "Caustics", 0-2 -> `water.setCaustic(v)` (caustic emissive strength on terrain; 0 disables the caustic render pass).

**Water Reflection** (all routed through one `updateWaterReflection()` calling `water.setReflectionTuning({...})`)
- `waterReflectMix` — "Reflect amount", 0-2 — Fresnel-blend weight toward reflection vs. refraction.
- `waterReflectBrightness` — "Reflect brightness", 0.2-2 — multiplies the sampled reflection color; combined with `reflectMix`, a 0 on either disables the reflection render pass.
- `waterReflectRipple` — "Reflect ripple", 0-0.3 — ripple-normal distortion strength applied to reflection UVs (`reflectStrength`).
- `waterRefractRipple` — "Refract ripple", 0-0.3 — ripple-normal distortion strength applied to the refraction screen-UV sample (`refractStrength`).
- `waterDepthScale` — "Depth tint scale", 0.5-8 — divides water depth to compute the shallow/deep color blend factor (`depthScale`).
- `reflectResolutionScale` / `reflectRate` (perf) — not exposed as regular sliders (they'd need a rebuild-free live-tune UI of their own); adjustable at runtime via `water.setReflectionTuning({ reflectResolutionScale, reflectRate })` or `water.setReflectRate(n)`, and configurable at construction via the same-named `createWaterSystem()` options (defaults `0.5` and **`2`** since 2026-07-09 — was `1`/every-frame; see "Defaults" above). Since 2026-07-08 (perf-recovery Wave 0) they ARE exposed as **Perf A/B panel** controls ("Reflect rate" 1-4 step 1, "Reflect scale" select `[0.25,0.5,0.75,1]`) — see "URL flags + Perf A/B panel" below.

**Water LOD**
- `waterLodR0` — "Near radius", 10-200 -> `water.setLodDistances(r0, r1)` — outer radius of clipmap ring 0 (finest cell size).
- `waterLodR1` — "Mid radius", 30-400 — outer radius of ring 1 (medium cell size); ring 2 extends from there to the map/terrain extent.

`waterLevel` itself is a top-level "terrain" slider (not under a Water header,
line ~1665: `slider('waterLevel', 'Water level', -3, 1, 0.05, f2, worldRebuild, terrain)`)
that triggers a full world rebuild including `syncWaterChunks`.

`environment-ui.js` itself defines no water-specific sliders — it only
consumes water's stats for the debug HUD/frame-profiler panel (`Water`,
`Water FX` rows, and the `passWaterMs` frame-profiler bucket); all the actual
tuning sliders above live in `environment-viewer.html`.

## Tests

No dedicated test file exists for water. The repo root contains numerous
`test-*.mjs` files for other subsystems (terrain, grass, cdlod, forest, sky,
particles, lighting, post, frame-profiler, collision, height-texture) but none
named `test-water*.mjs` — water has no automated test coverage at this time.
