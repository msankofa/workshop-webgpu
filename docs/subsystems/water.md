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

## Files

- `water.js` (1117 lines) — the entire subsystem: geometry generation (clipmap
  rings), TSL shader material (waves/reflection/refraction/caustics), reflection
  and caustic render-target management, and the public `createWaterSystem` API.

## Public API

```js
import { createWaterSystem, WATER_VERSION } from './water.js';
```

### `createWaterSystem(options = {}) -> WaterSystem`

Key `options` (full list is the `DEFAULTS` object, water.js:45-73):
`renderer`, `scene`, `camera`, `ground` (terrain mesh, for caustic emissive
injection), `size`, `waterLevel`, `heightFn(x, z) -> y`, `lightDir`
(`THREE.Vector3`, defaults to a fixed sun direction), `shallow`/`deep` colors,
`refractStrength`, `reflectStrength` (ripple-distortion strengths), `reflectMix`,
`reflectBrightness`, `depthScale`, `waveStrength`, `caustic`, `causticBedDepth`,
`causticRes`, clipmap tuning (`lodR0`, `lodR1`, `cellS0/1/2`, `buildBudgetMs`,
`maxBuildsPerFrame`), `extentX`/`extentZ` (clip the water mesh to a finite map),
`deferredDisposeFrames`.

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
  setReflectionTuning({ reflectStrength, refractStrength, reflectMix, reflectBrightness, depthScale }),
  setReflectRate(everyNFrames),   // API preserved but currently has no effect (see notes)
  setLightDir(THREE.Vector3),     // re-aim specular + caustic refraction
  setLodDistances(r0, r1),
  getChunkCount(),
  getStats(),          // -> stats object consumed by the debug HUD
  dispose(),
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
  `tsl_reflector.target.rotation.x = -Math.PI/2` orients the mirror plane
  horizontal (local +Z -> world +Y). The reflector's `updateBefore` is wrapped
  to gate the render behind `reflectionEnabled` (true only when both
  `reflectMix > 0` and `reflectBrightness > 0`) and to record timing stats
  (`reflectionRenderStats`). Reflection UV is perturbed by the ripple normal
  (`tsl_reflector.uvNode.add(N.xz.mul(tsl_uReflectStrength))`) and the sampled
  color is scaled by `reflectBrightness`, then Fresnel-blended against
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
  extra render pass); `setReflectRate(everyNFrames)` exists in the API but
  **currently has no effect** — the code comment at water.js:976-981 notes the
  ReflectorNode always renders every frame, and per-N-frame throttling would
  require manipulating `ReflectorNode.updateBeforeType`, deferred to a later pass.
  Disabling reflection (`reflectMix` or `reflectBrightness` at 0) or caustics
  (`caustic` at 0) skips their respective render passes entirely (checked in
  `reflectorBase.updateBefore` / `CausticTextureNode.updateBefore`).

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
