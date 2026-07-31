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

A third, unrelated layer — `effect-renderer.js` — draws **combat** visuals (tracers, impact
sparks, muzzle flashes, layered explosions, smoke). It is not part of the particle/post stack
and shares no code with it: it is a CPU-side, per-frame-regenerated draw over the serialized
`effect` entities from `entity-types/effect.js`. Because it exists to make host and guest render
an identical blast from one wire object, its replication contract lives in
`docs/subsystems/multiplayer.md` §5b; the section below covers it as a visual layer — its draw
systems, pool ceilings, effect kinds and the rules a caller has to keep to.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `particle-field.js` | Pure-JS CPU reference for particle sim math (hash RNG, volume spawn, curl-noise, life/fade envelope, per-species params). No three.js import. Node-tested. | 58 |
| `particles.js` | GPU particle field: persistent compute-simulated state buffer, atomic survivor compaction into an indirect draw, camera-facing billboard quad rendering. | 213 |
| `post-fx.js` | Configurable TSL post-processing graph: scene pass → bloom → tone mapping → inline color grade → output. Builds/rebuilds a `PostProcessing` node graph. | 106 |
| `post-grade.js` | Pure-JS CPU reference for the color-grade math used inline in `post-fx.js`'s `gradeNode`. Node-tested. | 34 |
| `effect-renderer.js` | Combat-effect draw layer: tracers, impact sparks, muzzle flashes, layered explosions, smoke puffs. Stateless — every sub-particle is regenerated each frame from the wire object + id hash + age. Browser/THREE only. | 446 |
| `entity-types/effect.js` | Pure `EffectEntity` (`create`/`update`/`serialize`) — the authoritative wire shapes and defaults for every effect kind. No THREE. | 98 |

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

### `effect-renderer.js`
- `createEffectRenderer({ THREE, scene, terrainHeight = null, maxSegments = 3072, maxPoints = 1024 }) -> { sync(list, nowMs), dispose() }`.
  `sync` takes the serialized effect wire objects and must be called **every render frame** (nothing
  persists between calls). `terrainHeight(x, z)` is injected because an explosion needs the real
  ground under it, not its own Y — a rocket can detonate on a wall, a trunk or in mid-air. See
  "Combat effects" below.

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

## Combat effects (`effect-renderer.js`)

Unlike the particle field, nothing here is simulated or stored. `sync(list, nowMs)` rebuilds every
sub-particle of every live effect from three inputs: the wire object, a hash of its `id`, and its age
(`nowMs - firstSeen[id]`). That is what lets one ~10-field snapshot object reproduce an identical
blast on every client, and it is also why the renderer costs whatever the current list costs, every
frame — a caller keeping 900 effects alive pays for 900 effects each frame.

**Draw systems.** One pooled `LineSegments` (`maxSegments` 3072) and one pooled `Points`
(`maxPoints` 1024), both additive, for tracers, spark rays, shockwave rings, embers and shrapnel
streaks; plus two **sprite pools** — `GLOW_POOL` 220 additive and `SMOKE_POOL` 260 normal-blend —
for the layers that need per-puff colour/opacity/scale. Sprites use `SpriteNodeMaterial`, not classic
`SpriteMaterial`, because the WebGPU backend requires the node material; the shared soft radial
texture is one `CanvasTexture` generated on the CPU. Pools are immediate-mode: counters reset at the
top of `sync`, leftovers are hidden at the bottom, and overflow is silently dropped.

**Effect kinds.** Defaults and wire shapes are authoritative in `entity-types/effect.js`
(`DEFAULT_LIFE`, `EffectEntity.create`).

| Kind | Default life | Drawn as |
|---|---|---|
| `gun_tracer` | 0.12 s | additive streak + glow sprites along the core (`tracer-visual.js` drives the head/tail) |
| `hit_spark` | 0.6 s | 6 additive rays (fade in 0.22 s) + a point; world surfaces (`terrain`/`obstacle`) also get a lingering dust sprite |
| `muzzle_flash` | 0.42 s | small glow sprite at the muzzle tip + barrel-relative smoke wisps, all shaped by `muzzleFx` |
| `explosion` | 1.8 s | seven sub-timed layers: fireball core (<0.2 s), body puffs (<0.34 s), ground shockwave ring (<0.42 s), shell rays (<0.28 s), 22 ballistic embers (<0.52 s), 12 shrapnel streaks (<0.72 s), 10 staggered smoke puffs (to ~1.8 s) |
| `smoke_puff` | 1.2 s | exactly **one** smoke sprite |

`life` is the **outer envelope** of the whole effect, not one layer — an explosion's 1.8 s exists so
its smoke can linger long after the flash has gone. The shockwave ring is skipped when the blast is
more than `0.8 × radius` above the injected ground height, so airbursts and wall/creature hits don't
paint a ring on the terrain.

### `smoke_puff`

`{ id, type:'effect', kind:'smoke_puff', p, color, life, size, growth, rise, drift, opacity }`.

| Field | Default | Unit / meaning |
|---|---|---|
| `life` | 1.2 | s, the puff's whole existence |
| `size` | 0.35 | m, starting sprite radius |
| `growth` | 0.9 | m gained over a full life |
| `rise` | 0.35 | m/s of buoyancy |
| `drift` | `[0,0,0]` | m/s of wind / inherited velocity |
| `opacity` | 0.3 | peak alpha |
| `color` | `[0.42,0.4,0.38]` | smoke grey (the warm effect default is overridden for this kind) |

Rendered position is `p + drift·t + up·rise·t`, radius is `size + growth·(t/life)`, alpha fades in
fast (over `life/6`) and out to zero. Per-puff jitter, size variance and brightness variance are all
hashed off the `id`, so a trail doesn't read as identical dots on a straight line.

**Two rules a caller has to keep to** — both cost real debugging time when broken:

1. **Ids must be unique across every effect kind, and never reused.** `firstSeen` is keyed by `id`
   alone, and a reused id inherits the previous holder's birth time — the new puff spawns already
   half-dead, or never appears at all.
2. **Never mutate `p` after spawn.** All motion comes from `drift` + `rise` integrated against the
   effect's own age. Moving `p` to follow a projectile turns a trail into one dot dragged along
   behind it.

A puff is **one sprite, not an emitter**: a rocket trail is 30–60 independent short-lived puff
entities, one spawned every 35 ms of flight. That is what makes it stateless, and also why a long
trail is the thing most likely to exhaust `SMOKE_POOL`.

**Callers.** `environment-viewer.html` feeds the renderer from `entityRegistry.renderList({type:'effect'})`
(host/solo) or the interpolated guest upserts — see `docs/subsystems/multiplayer.md` §5b.
`bot-viewer-v2.html` feeds it a plain local list (`botEffects` / `pushEffect` / `updateEffects`,
capped at 900) and is the source of the rocket-trail puffs — see `docs/subsystems/bots.md`
("Explosives in the v2 harness").

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

`effect-renderer.js` is likewise untested directly (it imports `three/webgpu` and touches a canvas).
Its inputs are covered indirectly instead: `test-tracer-visual.mjs` for the tracer segment math it
calls, and `test-bot-explosives.mjs` for the puff-spawn cadence its rocket-trail caller drives.
`entity-types/effect.js` is pure and Node-importable but has no test of its own — the defaults table
above is the only spec for them.

## Host effect-entity wire cache (environment-viewer-v2.html)

`effect-renderer.js` pools every visual object it owns, but the *entity façade* above it did not:
`entityRegistry.renderList(e => e.type === 'effect')` ran once per render frame and re-serialized
every live effect, allocating a fresh wire object plus 3-4 arrays each (plus `list()`'s own two
arrays). At 90-bot full-auto scale that was the dominant per-frame garbage in the combat path.

Effects are immutable after creation — `EffectEntity.update` only advances `sim.age` — so the v2
viewer serializes each effect's wire **once**, at spawn:

- `createEffectEntity(init, nowSec)` wraps `entityRegistry.create('effect', …)` and pushes
  `EffectEntity.serialize(entity)` onto `hostEffectWires`. Every host-side effect spawn goes through
  it, including the adapter-facing `ctx.spawnEffect` handed to `entityRegistry.tick`.
- `liveHostEffectWires()` compacts that array in place each frame, dropping entries whose id no
  longer resolves via `entityRegistry.get` (a Map lookup, no allocation). The registry's own tick is
  still what expires effects, so the render list can never disagree with what guests are told.
- `MAX_EFFECT_ENTITIES` = 220 (≈110 hitscan shots in flight, 2 effects each). A spawn past the cap
  destroys the oldest tracked effect first.

**Replication is untouched.** `snapshot()` walks the registry and serializes independently of this
cache, so guest `upserts` are byte-identical to before; the cap only emits an ordinary early
`removes` tombstone. The guest render path still reads `mpPendingEffects` from the wire. The cache is
therefore a **host/solo render-side** optimisation with no guest-visible behaviour change.

Note: bots never spawn `muzzle_flash` entities — `spawnLocalMuzzleFlash` is a local first-person view
effect (not replicated) fired only from `fireGunFromCamera`. Bot shots produce `gun_tracer` +
`hit_spark` only.
