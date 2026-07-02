# FX subsystem: particles & post-processing

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#fx)

## Purpose

Two independent visual layers on top of the WebGPU TSL render pipeline: a GPU-simulated
particle field (`particles.js`, embers/dust billboards driven entirely by compute passes) and
a node-based post-processing stack (`post-fx.js`, bloom → tone mapping → color grade →
output). Both are optional (`?particles=off`, `?post=off`) and both are designed so default
parameters are a visual no-op, matching the no-post/no-particle baseline. `particle-field.js`
and `post-grade.js` are pure-JS, Node-testable "twins" of math that is otherwise only
expressed inline as TSL shader graphs — they exist purely so the shader math has a CPU
reference that can be unit-tested without a browser/GPU.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `particle-field.js` | Pure-JS CPU reference for particle sim math (hash RNG, volume spawn, curl-noise, life/fade envelope, per-species params). No three.js import. Node-tested. | 58 |
| `particles.js` | GPU particle field: persistent compute-simulated state buffer, atomic survivor compaction into an indirect draw, camera-facing billboard quad rendering. | 213 |
| `post-fx.js` | Configurable TSL post-processing graph: scene pass → bloom → tone mapping → inline color grade → output. Builds/rebuilds a `PostProcessing` node graph. | 106 |
| `post-grade.js` | Pure-JS CPU reference for the color-grade math used inline in `post-fx.js`'s `gradeNode`. Node-tested. | 34 |

## Public API

### `particle-field.js`
- `hash01(seed, salt) -> number` — deterministic pseudo-random in `[0,1)`.
- `spawnInVolume(seed, camX, camY, camZ, R) -> {x,y,z}` — deterministic point in a camera-centered cube `[cam ± R]`.
- `curlNoise2(x, z, pot, e = 1e-3) -> {fx, fz}` — divergence-free 2D flow from the curl of a scalar potential `pot(x,z)`.
- `stepLife(age, dt, maxLife, fadeFrac = 0.15) -> {age, fade, reborn}` — advances age, computes fade-in/out envelope, wraps (and flags `reborn`) at `maxLife`.
- `kindParams(kind) -> object` — per-species (`'ember'` default or `'dust'`) config: `buoyancy, drag, curlStrength, wind, size, color, alpha, blend, flicker, maxLife, speed`.

### `particles.js`
- `createParticleField(opts) -> field` where `opts = { renderer, camera, kind, params, count, radius }` (`kind` defaults `'ember'`; `count`/`radius` default per-kind). Returned `field`:
  - `mesh` — `THREE.Mesh` (billboard quad, indirect-drawn) to add to the scene.
  - `kind`, `count`, `defaults` (resolved param object incl. `kind`/`count`/`radius`), `enabled` (getter).
  - `async update(dt, cam)` — runs the compute pipeline (`reset → simulate → finalize`) via `renderer.computeAsync`; no-ops if disabled.
  - `setParams(p)` — live-writes any subset of uniform-backed params (`size, alpha, flicker, buoyancy, drag, curlStrength, speed, maxLife, wind, color`).
  - `setEnabled(on)` — toggles simulation + mesh visibility.
  - `dispose()`.

### `post-fx.js`
- `createPostFX(opts) -> postFX` where `opts = { renderer, scene, camera, params }`. `params.mode` selects the output graph: `'scene' | 'output' | 'grade' | 'full'/'on'` (default `'full'`). Returned `postFX`:
  - `mode`, `enabled` (getter), `setEnabled(v)`.
  - `async renderAsync()` — runs `PostProcessing.renderAsync()`.
  - `setToneMapping(name)` — one of `agx, aces, reinhard, neutral, none`; rebuilds the output graph.
  - `setExposure(e)` — writes `renderer.toneMappingExposure` directly (no rebuild).
  - `setBloom(strength, radius, threshold, smoothWidth)`.
  - `setGrade(g)` — partial update of `{ brightness, contrast, gamma, gain, saturation, temperature, tint, vignette, vignetteSoft }`.
  - `resize()` — no-op (PassNode auto-tracks renderer size).
  - `dispose()`.

### `post-grade.js`
- `grade(rgb, p = {}, uv = [0.5, 0.5]) -> [r, g, b]` — applies the full grade chain (gain → brightness → contrast(pivot 0.18) → gamma → white balance → saturation → vignette) to one RGB triplet at one UV. All `p` fields default to identity.

## Wiring (`environment-viewer.html`)

- `particle-field.js` is **statically** imported at module top (`import { kindParams } from './particle-field.js'`) — its pure functions are cheap and used synchronously by the particle editor UI (`kindParams` seeds the per-species editor defaults).
- `particles.js` and `post-fx.js` are **lazily** `await import()`'d, gated by URL params (`?particles=off`, `?post=off`), so a disabled subsystem pays no module-load cost.
  - Particles: `addParticleField({kind, name, params, count, radius, enabled})` creates a field via `createParticleField`, adds `field.mesh` to `scene`, and tracks it in a `particleFields` registry (`{id, name, params, field}`). Two fields are seeded at startup (`embers`, `dust`), both `enabled: false` by default.
  - Post FX: `postFX = createPostFX({ renderer, scene, camera, params: { mode: POST_MODE } })`, `POST_MODE` from `?post=` (default `'on'` → `'full'`).
- **Per-frame** (inside the render loop, in order): `portCreatures.update` → `waterRef.update` → terrain/grass/forest/CDLOD compute updates → light-gun/clustered-lights updates → `for (const e of particleFields) await e.field.update(rawDt, camera)` → finally `if (postFX && postFX.enabled) await postFX.renderAsync(); else renderer.render(scene, camera)`. Particle sim is awaited before the post/render step so survivor counts are written before the draw, matching the same awaited-compute-before-draw pattern used by grass/CDLOD/forest.
- `particles.js` reuses `grass.js`'s `buildGrassNoiseFns().noise2D` to build its TSL `curlFn` (the GPU-side equivalent of `particle-field.js`'s `curlNoise2`), and mirrors `particle-field.js`'s hash RNG (`randFn`, transcribed from `hash01`) for in-shader respawn randomness. The doc comment in `particles.js` explicitly notes the GPU randomness is *not* bit-exact with the CPU twin — only visually equivalent — since particles are purely cosmetic and don't need cross-system parity (contrast with the Node-tested numeric assertions on the CPU twin itself).

## Architecture notes

- **Post-processing graph order**: scene pass → (`mode === 'full'`) add bloom to the HDR scene color → `renderOutput` (applies the renderer's `toneMapping` + output color space) → inline `gradeNode` (gain→brightness→contrast→gamma→white-balance→saturation→vignette) → `pp.outputNode`. Diagnostic `mode`s let you stop early: `'scene'` = raw scene color, `'output'` = scene + tone-map/colorspace only, `'grade'` = scene + tone-map + grade but no bloom, `'full'`/`'on'` = everything.
- **Mode switching**: `setToneMapping(name)` calls `build(name)`, which reassigns `renderer.toneMapping` and rebuilds `pp.outputNode` from scratch (then sets `pp.needsUpdate = true`). This is the only operation that rebuilds the graph; it's described as "rare, on dropdown change" — all other live params (bloom strength/radius/threshold/smooth, every grade param, exposure) are plain uniform writes with no rebuild.
- **`post-fx.js` vs `post-grade.js` relationship — hypothesis confirmed**: `post-fx.js` does **not** import `post-grade.js` (verified by grep — the only occurrences of the string `post-grade` in `post-fx.js` are two code comments, lines 6 and 43). `post-grade.js`'s `grade()` is a hand-kept-in-sync pure-JS transcription of the inline TSL `gradeNode` math in `post-fx.js` (same chain, same pivot 0.18, same vignette falloff), used solely so `test-post-grade.mjs` can unit-test the grade math under Node without a WebGPU context. Production code only ever executes the TSL version inside `gradeNode`.
- Bloom defaults to `strength: 0` and grade defaults are all identity, so with `mode: 'full'` and untouched sliders the post stack is a visual no-op vs. `?post=off` (per the comment on `post-fx.js` line 28).
- Contrast pivots at middle grey (0.18), not 0.5 — chosen so contrast doesn't act like uniform darkening on dark scenes (see comment in both `post-fx.js` and `post-grade.js`).
- Particle field capacity (`count`) and spawn `radius` are fixed at allocation (`StorageBufferAttribute` sized to `CAP * 8`); changing them in the editor UI triggers a full field rebuild (dispose + recreate), whereas every other param (`size, alpha, color, flicker, buoyancy, drag, curlStrength, wind, speed, maxLife`) is a live uniform write via `setParams`.
- Particles respawn either on death (`age > maxLife`) or on leaving an XZ box of half-width `R * 1.2` around the camera, keeping the field camera-centered without a per-particle "follow" cost.

## Tunable parameters (`environment-viewer.html`, panel built inline; routed into the "effects" tab by `environment-ui.js`)

Note: `environment-ui.js` itself defines no FX sliders — it only (a) lists perf-HUD rows `particlesGpu`/`postRender` (`PERF_ROWS`, lines 9-10) and (b) routes any UI section titled `'Post'` or `'Particles'` into the Effects tab (`effectsNames`, line 460). The actual `slider`/`toggle`/`select`/`header` controls are built locally in `environment-viewer.html` (~line 1548 onward) and call straight into `postFX`/particle-field methods.

**Post** (`environment-viewer.html` ~1669-1701, all live via `postFX.set*`):
`postFX` (on/off toggle), `postTone` (`none|neutral|aces|agx|reinhard`), `postExposure` (0.1-4), `postBloomStrength` (0-3), `postBloomRadius` (0-1), `postBloomThreshold` (0-2), `postBloomSmooth` (0.001-0.2), `postBrightness` (-0.5-0.5), `postGain` (0-2), `postContrast` (0.5-1.5), `postGamma` (0.2-3), `postSaturation` (0-2), `postTemperature` (-1-1), `postTint` (-1-1), `postVignette` (0-1), `postVignetteSoft` (0.2-3).

**Particles** (~1704-1792, an editor for a "design" that can be added as a new field or live-edits the selected field via `field.setParams`):
`particlesEnabled` (master on/off for all active fields), base species select (`ember`/`dust`), then per-field `Size, Opacity, Color R/G/B, Flicker, Buoyancy, Drag, Curl strength, Wind X/Y, Speed, Lifetime`. `Count` and `Radius` are also editable but are non-live (`pslider(..., live=false)`) — they schedule a debounced (220ms) field rebuild (`rebuildEntry`) instead of a uniform write, since GPU buffer capacity can't change live.

## Tests

- **`test-particle-field.mjs`** (Node, no GPU): exercises `particle-field.js` directly.
  - `spawnInVolume`: same seed → identical point (determinism); point lands within `[cam ± R]`; different seed → different point; 200 seeds spread across the volume rather than clustering.
  - `curlNoise2`: deterministic for the same inputs; numerically verifies the field is ~divergence-free (finite-difference divergence sampled on a grid, asserted `< 1e-2`).
  - `stepLife`: age advances with `dt`; fade ≈0 at birth and at end-of-life, ≈1 mid-life; wraps to a small age and sets `reborn: true` once `age` crosses `maxLife`.
  - `kindParams`: `'ember'` vs `'dust'` differ as expected (ember buoyant/flickering/additive, dust non-buoyant/non-flickering/alpha-blended, distinct colors).
- **`test-post-grade.mjs`** (Node, no GPU): exercises `post-grade.js`'s `grade()`.
  - All-default params is an identity transform.
  - `gain` multiplies, `brightness` offsets.
  - `contrast` pivots exactly at 0.18 (unchanged there) and pushes values above it further up.
  - `gamma > 1` brightens midtones (`pow(0.25, 1/2) = 0.5`, numerically checked).
  - `saturation: 0` collapses to the luma value (Rec.709 weights) on all three channels.
  - `temperature` warms (R up / B down), `tint` shifts green up.
  - `vignette` darkens the corner but not the center; higher `vignetteSoft` darkens less away from the extreme edge than lower softness, at a fixed sample point.

Neither test file touches `particles.js` or `post-fx.js` directly — both are GPU/TSL/three.js-dependent and not Node-testable; only their pure-JS math twins are covered.
