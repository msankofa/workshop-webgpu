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
| `effect-renderer.js` | Combat-effect draw layer: tracers, impact sparks, muzzle flashes, layered explosions, smoke puffs, blood spray, blood stain + ground splatter decals. Stateless — every sub-particle is regenerated each frame from the wire object + id hash + age. Browser/THREE only. | 686 |
| `entity-types/effect.js` | Pure `EffectEntity` (`create`/`update`/`serialize`) — the authoritative wire shapes and defaults for every effect kind. No THREE. | 151 |
| `vision-modes.js` | RGB / NVG / white-hot / black-hot for a WebGPU scene where heat is a property of materials, not of lighting. `heatTag`, `heatMix`, `tagScene`, `createVisionComposite`. Node-tested (tagging, sweep, palettes). First consumer: `demos/flight-sim.html`. | 150 |
| `rain.js` | GPU rain for the TSL stack: `createRainSystem` (instanced streaks + splash rings, no buffers — seeds are `hash(instanceIndex)`), `bakeOccluderMap` (top-down height texture so drops cut at roofs and splashes land on them), `applyWetSurface` (darken/gloss/ripple-normal decoration for any `MeshStandardNodeMaterial`). Wired into `demos/rain.html`, `demos/flight-sim.html` and `bot-viewer-v3.html`. | ~400 |
| `explosion-tier.js` | Pure port of html-game-v2's `reserveExplosionVisualTier` (320 ms window; 2 full / 5 medium primary, 1 / 4 secondary). Injected clock. Node-tested. Wired into `demos/volumetric-smoke.html`, `bot-viewer-v3.html` and `demos/flight-sim.html`, in all three to scale debris. | 93 |
| `blast-debris-sim.js` | Pure port of html-game-v2's persistent debris pools: shrapnel (bounce, friction, flicker recolour, glow, smoke trails), rubble (thrown along the kill vector, non-uniform, smoulder + ember sparks + rising smoke + light values), ground slabs (drop-pod preset with secondary shrapnel bursts), sparks, smoke. Injected `groundAt` and `random`; caps 900/260/80/2600 with oldest-recycle. Two departures from the original, both for the flight sim: an inherited `velocity` spawn option, and settled pieces that stop being simulated. Node-tested. | 454 |
| `blast-debris.js` | WebGPU renderer for those arrays: one `InstancedMesh` per kind (tetra / dodeca / glow spheres / tri-prism sparks) with `instanceColor`, an instanced soft-billboard smoke pool, and pooled `PointLight`s on the hottest rubble. `mesh.count` = live length, and every GPU upload is range-bounded to it. Optional `tagMaterial(material, role)` hook so a page with its own shading pass can reach the materials. Node-tested (`test-blast-debris-render.mjs`, which compiles every material headlessly). | 231 |
| `rain-math.js` | Pure CPU twin of the maths inside `rain.js`'s graphs (drop wrap, streak basis, occluder uv, ripple clock, density→count). Not imported by `rain.js`; hand-synced. Node-tested. | 60 |

### Vision modes (`vision-modes.js`)

The cheap thermal — a luma remap of the lit frame — is wrong in the way that matters: sunlit grass
reads hot and a shadowed engine cold, because it measures light. So every material carries a heat
value instead. `heatTag(material, heat)` rewires a **node** material in terms of its own
`materialColor` / `materialEmissive` nodes (which include the map and keep tracking `.color`,
`.emissive`, `.opacity`, so pooled particles still tint and fade): under `uIR` a lit material's
diffuse goes black, its emissive becomes the heat grey, its roughness goes to 1 and metalness to 0
so the sun cannot glint through; an unlit material's colour becomes the heat grey. Materials that
own a colour graph (a TSL terrain, a sky) opt in with `heatMix(rgbNode, heat)` inside that graph and
mark `userData.irTagged`. Classic (non-node) materials cannot be reached and are reported by
`tagScene`, which sweeps a scene and tags anything left with `DEFAULT_HEAT` — a cool, visible
object — so nothing reads as a lit thing in a thermal frame. `HEAT` is the convention table.

`createVisionComposite(renderer, scene, camera)` is a `PostProcessing` graph — scene pass →
`renderOutput` → palette — with `outputColorTransform = false` because it applies `renderOutput`
itself (RGB mode must equal the plain render exactly). NVG is an intensifier tube: monochrome
luminance with gain, a noise floor and vignette in phosphor green; on a daylight scene it is a
green daylight scene, and that is honest. White-hot maps the (already grey) heat frame with a
little contrast and noise; black-hot inverts it. `PALETTE` holds CPU twins of the three curves,
kept in sync by hand like `post-grade.js`. `setVisionMode(name)` is the one place the mode
becomes uniform values (`uMode`, and `uIR` = 1 for the two thermal palettes only — NVG amplifies
light and does not see heat).

Note for `post-fx.js`: it applies `renderOutput` by hand AND leaves `outputColorTransform` at its
r184 default of true, which by a reading of `PostProcessing.render` in the shipped build would
transform its non-`scene` modes twice. Read from source, not measured on screen; not changed here.

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
- `createEffectRenderer({ THREE, scene, terrainHeight = null, resolveAttachment = null, maxSegments = 3072, maxPoints = 1024, maxBloodDecals = 512 }) -> { sync(list, nowMs), dispose(), setBloodDecalCap(n), stats(), resetStats() }`.
  `sync` takes the serialized effect wire objects and must be called **every render frame** (nothing
  persists between calls). `terrainHeight(x, z)` is injected because an explosion needs the real
  ground under it, not its own Y — a rocket can detonate on a wall, a trunk or in mid-air.
  `resolveAttachment(ownerId, attach)` is injected for the same reason and in the same style: a
  `blood_stain` that carries an `attach` handle is drawn from the live body-part matrix it names.
  Both default to `null` and both degrade to the old behaviour, so the five callers below opt in one
  at a time. See "Combat effects" and "Attached stains" below.
  **Five** apps consume this factory and nothing else of the module, so the signature is treated as
  frozen: `bot-viewer-v2.html`, `bot-viewer-v2-camera.html`, `environment-viewer.html`,
  `environment-viewer-v2.html`, `damage-simulator.html`.
- `setWoundStyle({ inner, outer, darken }) -> current`. Retunes the wound centre. Uniform writes, not
  a rebuild, so it is safe to call as often as a slider moves; omitted or non-finite fields are left
  alone. The uniforms are declared **outside** `makeDecalPool`, so `setBloodDecalCap` cannot reset
  them. `projected-decals.js` exposes the identical method for its own copy of the graph.
- `bloodIntensityForHealth(hp01) -> { sprayCount, spraySpeed, spraySpread, splatterCount, splatterOpacity }`.
  Pure, no THREE, exported from here so the game and the harness cannot drift. `hp01` is the
  victim's health **after** the hit. At `hp01 = 0` it returns exactly the constants that were
  hardcoded before it existed (28 / 4.2 / 1.0 / 10 / 0.8), which is the regression guard: the mapping
  can only ever remove blood from light hits, never change what a lethal one already looked like. At
  full health it drops to 3 slow, tightly-grouped droplets and no ground splatter at all — a trickle
  under `blood_spray`'s existing renderer rather than a new "drip" effect kind. Clamps out-of-range
  and treats non-finite input as dying.
  `blood-tuning.js` turns this result into the actual burst, and both `bot-viewer-v3.html` and
  `damage-simulator.html` call it, so the two cannot drift.

- `setBloodDecalCap(n) -> appliedCap`. A cap is a buffer size and an `InstancedBufferAttribute`
  cannot grow in place, so this **rebuilds** the decal pool: it removes and disposes the old mesh and
  makes a new one. Nothing is permanently lost — `sync()` repopulates every instance from the wire
  list on the next call — but it drops the frame's decals once and must not be called per frame.
  Drive it from a slider's `change` event, not its `input` event. `n` is clamped to `[0, 16384]` and
  non-numeric input clamps to 0 rather than throwing.
- `stats() -> { bloodCap, bloodUsed, bloodDropped, bloodPeak, bloodDroppedPeak, segments, points, glow, smoke }`.
  `bloodUsed`/`bloodDropped` are this frame; the two peaks are high-water marks since the last cap
  change or `resetStats()`. **`bloodDropped` is the number that makes a cap defensible**: 512 was
  chosen without measurement, and a cap is only correct if drops stay at zero while the peak sits
  meaningfully below it. `pushBlood` counts a rejection as a drop only when the pool was full — a
  faded or zero-size decal was never wanted and is not counted.

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
(`maxPoints` 1024), both additive, for tracers, spark rays, shockwave rings, embers, shrapnel
streaks, and blood-spray droplets (droplets are just short gravity-arced streaks through the same
line buffer — no dedicated buffer of their own); plus two **instanced billboard pools** —
`GLOW_POOL` 220 additive and `SMOKE_POOL` 260 normal-blend — for the layers that need per-puff
colour/opacity/scale. A third instanced pool, `maxBloodDecals` (default **512**), holds `blood_stain`
and `blood_splatter` **decals** (shared, combined cap): oriented quads rather than billboards, since a
decal has to sit flush against a surface normal. All pools are immediate-mode: counters reset at the
top of `sync`, buffers upload at the bottom, and overflow is silently dropped.

### The two instanced billboard pools

Each is **one draw call**: a single `Mesh` over an `InstancedBufferGeometry` holding a unit quad
(corners ±0.5, index `0,1,2/0,2,3` — the same geometry `THREE.Sprite` uses) plus four instanced
attributes, `instPos` (vec3 world centre), `instColor` (vec3 RGB), `instSize` (float), `instAlpha`
(float). Billboarding comes from `SpriteNodeMaterial`, which is also what forces the layout:

- **`instanceMatrix` and `instanceColor` are deliberately not used.** `SpriteNodeMaterial`
  (`setupPositionView`) builds the vertex from `positionNode` + `positionGeometry`, never from
  `positionLocal`, so an `InstancedMesh`'s `instanceMatrix` has **no effect** on where a billboard
  lands at r0.184. The per-instance data is wired through the material instead:
  `positionNode = attribute('instPos')`, `scaleNode = attribute('instSize')` (a float, broadcast to
  `vec2(s, s)`), `colorNode = attribute('instColor').mul(materialColor)` (`materialColor` carries
  `material.color × map`, so the soft texture's alpha survives the vec3→vec4 promotion, which pads
  with 1.0), `opacityNode = attribute('instAlpha')`.
- Live count is `geometry.instanceCount`; `mesh.visible = count > 0`. Meshes are
  `frustumCulled = false` with `matrixAutoUpdate = false` — they never move.
- `mat.fog` is on for smoke (reads atmosphere) and off for glow (additive stays bright), as before.
- The shared soft radial texture is one `CanvasTexture` generated on the CPU; each pool owns its own
  copy of the quad attributes so disposing one never frees the other's buffers.

**Smoke ordering.** Normal blending is order-dependent and instancing gives up Three's per-sprite
depth sort, so `sync()` writes smoke into staging buffers and gathers them **back-to-front** into
the instance buffers at the end of the frame. The camera comes from `smoke.mesh.onBeforeRender`,
i.e. the previous frame's draw — one frame stale and visually indistinguishable, and it keeps the
public API frozen (no camera parameter). Before any frame has drawn, the gather falls back to
emission order. Glow is additive and therefore order-independent, so it is never sorted.
`renderOrder` is 0 for glow and 1 for smoke, which makes the two pools' relative order deterministic
instead of depending on a meaningless origin-distance tie-break.

### The decal pool

Same one-draw-call shape as the billboard pools, but the constraint that shaped those is **absent
here**: a decal uses `MeshBasicNodeMaterial`, which *does* build its vertex from `positionLocal`, so
per-instance geometry is expressible. It still doesn't use `instanceMatrix`. Each instance instead
carries its two **in-plane axes already scaled by size** — `instTan` and `instBit`, computed on the
CPU in `pushBlood` from the normal plus the decal's random spin — and the corner is
`instPos + geometryX·instTan + geometryY·instBit`. That is 6 floats and no matrix multiply, against
16 floats and a `mat4` for the equivalent `instanceMatrix`. The mesh matrix stays identity, so those
axes and the centre are world space, exactly like the sprite pools.

- **Surface lift is size-scaled for stains, flat for ground splatter.** `pushBlood` takes a `lift`
  defaulting to 1 cm; `drawBloodStain` passes `clamp(size * 0.04, 0.0008, 0.01)`. A fixed 1 cm is
  right on terrain and wrong on a body — a bot forearm is ~9.4 cm across, so 1 cm floated the decal
  more than a tenth of the limb's width off its surface, reading as a mark hovering near the arm
  rather than one stuck to it. Floored so it still clears depth precision.
- The basis is built with a cross product against a helper axis that swaps to `+X` when the normal
  is near-vertical (`|ny| > 0.99`) — without the swap the cross product collapses on ground splatter,
  which is *every* `blood_splatter` quad. Which in-plane basis comes out doesn't matter, because
  `spin` randomizes the roll on top of it.
- `colorNode = attribute('instColor')`; `opacityNode = attribute('instAlpha').mul(texture(stainTex).a)`.
  The mask is sampled for its **alpha only** — that ramp is what feathers the decal edge instead of
  leaving a hard square. Its rgb is white and carries no colour.
- The decal pool uses **`makeStainTexture`**, not the sprite pools' `makeSoftTexture`. The soft
  texture is a centred radial gradient, i.e. perfectly rotationally symmetric — so the per-decal
  `spin` above was a **visual no-op** for as long as decals shared it, and every stain rendered as
  the same soft circle. `makeStainTexture` breaks that symmetry: a 128px off-centre core lobe, seven
  fused lobes for a lumpy outline, and twelve detached droplets, all kept inside the quad's ±0.5.
  It is generated from a **seeded** LCG rather than `Math.random`, because host and guest each build
  it locally and a divergent mask would render the same wire object differently on the two machines.
- `side: DoubleSide` with **`forceSinglePass: true`**. A decal on a curved surface can present its
  back face, but without `forceSinglePass` Three renders the whole pool twice to get that.
- `renderOrder = -1`: decals are stuck to surfaces, so glow and smoke composite over them.
- **Not depth-sorted**, unlike smoke. Decals lie flush on solid geometry, so their overlap is
  coplanar rather than layered, and every decal in the pool is the same dark red — the back-to-front
  gather would buy nothing.

Before this was instanced it was `maxBloodDecals` separate `Mesh` + `MeshBasicMaterial` pairs,
`DoubleSide` with no `forceSinglePass`, so a saturated pool encoded up to **2×** that many transparent
draws. That cost is why the cap sat at 160; at one draw call it is now 512 by default and the cap
costs ~13 floats per slot with nothing per frame, so callers should size it for the worst case.

**Effect kinds.** Defaults and wire shapes are authoritative in `entity-types/effect.js`
(`DEFAULT_LIFE`, `EffectEntity.create`).

| Kind | Default life | Drawn as |
|---|---|---|
| `gun_tracer` | 0.12 s | additive streak + glow instances along the core (`tracer-visual.js` drives the head/tail) |
| `hit_spark` | 0.6 s | 6 additive rays (fade in 0.22 s) + a point; world surfaces (`terrain`/`obstacle`) also get a lingering dust instance |
| `muzzle_flash` | 0.42 s | small glow instance at the muzzle tip + barrel-relative smoke wisps, all shaped by `muzzleFx` |
| `explosion` | 1.8 s | seven sub-timed layers: fireball core (<0.2 s), body puffs (<0.34 s), ground shockwave ring (<0.42 s), shell rays (<0.28 s), 22 ballistic embers (<0.52 s), 12 shrapnel streaks (<0.72 s), 10 staggered smoke puffs (to ~1.8 s) |
| `smoke_puff` | 1.2 s | exactly **one** smoke instance |
| `blood_spray` | 0.6 s | `count` gravity-arced droplet streaks (line segments) scattered around `normal`, linear fade-out |
| `blood_stain` | 6.0 s | one small, high-opacity decal quad AT the hit point, oriented to `normal` |
| `blood_splatter` | 8.0 s | `count` decal quads on the GROUND, at each droplet's resolved ballistic landing point |

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
("Explosives in the v2 harness"). Neither currently spawns `blood_spray`/`blood_stain`/
`blood_splatter`/`hit_spark` from a real hit — see `docs/subsystems/bots.md`'s combat sections for
the current hit pipeline.

### `blood_spray`, `blood_stain`, and `blood_splatter`

Three kinds split by where the blood actually ends up — the first version conflated "decal at the
hit point" and "marks nearby" into one oversized `blood_splatter` decal; splitting them let each be
tuned for what it actually looks like (a stain is small and dense, ground marks are scattered and
numerous).

`{ id, type:'effect', kind:'blood_spray',    p, normal, color, life, count, spread, speed, gravity, size, bodyPart }`
`{ id, type:'effect', kind:'blood_stain',    p, normal, color, life, size, opacity, bodyPart, attach? }`
`{ id, type:'effect', kind:'blood_splatter', p, normal, color, life, count, spread, speed, gravity, size, opacity, bodyPart }`

All three default `color` to a dark red (`[0.4,0.02,0.03]`, `BLOOD_RED` in `entity-types/effect.js`)
rather than the generic warm-orange effect default. `bodyPart` is a free-form string
(`'head'`/`'torso'`/…) a caller can use to scale any of the three by hit location — it carries no
meaning inside `effect.js` or `effect-renderer.js`, both just pass it through/ignore it.

| Field | Kind(s) | Default | Unit / meaning |
|---|---|---|---|
| `count` | spray | 28 | droplets in the flight burst |
| `count` | splatter | 10 | ground decals |
| `spread` | spray, splatter | 1.0 | scatter angle around `normal` |
| `speed` | spray, splatter | 4.2 | m/s, initial droplet speed |
| `gravity` | spray, splatter | 9.8 | m/s², droplet fall acceleration |
| `size` | spray | 0.03 | m, droplet streak length scale |
| `size` | stain | 0.15 | m, decal quad radius at the hit point |
| `size` | splatter | 0.12 | m, decal quad radius per ground mark (jittered ±30%) |
| `opacity` | stain | 0.92 | peak alpha |
| `opacity` | splatter | 0.8 | peak alpha |

`blood_spray` reuses the additive line-segment pool: each droplet is a short streak drawn along its
instantaneous velocity (`normal` scattered by `spread`, then falling under `gravity`), faded out
linearly over `life`.

`blood_stain` and `blood_splatter` are the two kinds that aren't sprites: **oriented decal quads**
from the shared `maxBloodDecals` pool, offset a hair off the surface along the normal to avoid
z-fighting, with a random spin around that normal for per-decal variety. Alpha fades in fast, holds,
then fades out over the last 30% of `life`. See "The decal pool" below for how they're drawn. They
differ in *where*:
- `blood_stain` places exactly one quad at `p`, oriented to `normal` — the hit surface itself
  (typically the body) — **unless it carries an `attach` handle**, in which case it is placed from
  the attached body part's live transform instead. See "Attached stains" below.
- `blood_splatter` places `count` quads on the **ground**, flat (`normal` forced to `[0,1,0]`, not
  the hit normal), at each droplet's own resolved landing point — it reuses `blood_spray`'s
  per-droplet scatter formula (same math, independent RNG stream off its own `id`, so it is not
  literally the same droplets currently in flight) and solves the standard projectile time-of-flight
  `t = (vy + sqrt(vy² + 2·g·h)) / g` (h = drop height to the injected terrain height under the hit,
  vy = that droplet's initial vertical speed) to find where it would land, rather than animating the
  fall. Verified against a brute-force numeric simulation across five vy/gravity/height combinations
  (±0.02% agreement) before wiring it in.

### `blood-tuning.js` — the shared numbers

Pure, no THREE. It holds every number a blood burst is built from, so `bot-viewer-v3.html` and
`damage-simulator.html` produce the same FX from the same tuning instead of each carrying its own
copy of the constants.

- `BLOOD_BASE` — the absolute shape of one full-intensity hit: `spraySize`, `gravity`, `stainFixed`,
  `stainFit`, `stainFitMin`, `stainFitMax`, `stainOpacity`, `stainProjDepth`, `splatterSize`,
  `splatterLifeScale`, and the `stump*` fields for a severed limb's one-off burst.
- `BLOOD_TUNING` — the five multipliers over it: `amount` (droplet and splatter counts), `force`
  (droplet speed and fan width), `sprayLife` (droplet flight time, s), `decalLife` (stain lifetime,
  s), `stainSize` (every decal, on top of fit-to-part sizing).
- `sprayParams(I, tune, base)`, `splatterParams(I, tune, base)` — `I` is
  `bloodIntensityForHealth`'s result, so the healthy-to-dying ramp still shapes every hit. Both
  return `null` rather than an empty burst when `amount` has scaled the count to zero.
- `stainParams(crossSection, tune, base)` — `crossSection` 0 means the hit never identified a part,
  which falls back to `stainFixed`.
- `stumpParams(tune, base)` — not health-scaled; losing a limb is always the full burst.

`tune` and `base` are both optional and may be partial: any field they do not name falls back to the
module default, so a saved blob from an older shape cannot leave a hole. Covered by
`test-blood-tuning.mjs`.

**Porting a tuning session.** `damage-simulator.html` writes `{ blood, base, bleed, haywire, limb,
wound }` to `localStorage['pcw:damageTuning']` (autosaved on close) and, via its **save to disk**
button, to `damage-tuning.json` at the repo root through `serve.py`'s `/api/save-damage-tuning`.
`bot-viewer-v3.html` reads the disk file first and lets localStorage override it, applying `blood`,
`base`, `bleed`, `haywire` and `wound` into `botBloodTuning`, `botBloodBase`, `botBleedTuning`,
`botHaywireTuning` and `botWoundStyle`. Only `limb` is unused there: v3 takes its limb thresholds
from the damage-class table, not from a live object. All five also ride v3's ui slot.

A tuning object is seeded from its module's defaults (`{ ...BLEED_DEFAULTS, ... }`), so it carries
every key the module expects and is passed straight in as the config with no per-call merge.

**Live updates.** The simulator autosaves to localStorage on every control change, debounced 250 ms
past the end of a drag. `localStorage` fires a `storage` event in every *other* tab of the same
origin, so v3 listens for the `pcw:damageTuning` key and re-applies immediately — a slider in one tab
moves a live fight in the other, with no reload. The event never fires for a tab's own writes, which
is why v3's slot load calls `refreshDamageTuning()` itself. The disk file has no event of its own, so
re-reading it is the **Reload damage tuning** button in Body & ragdoll.

`refreshDamageTuning()` is what pushes newly-applied numbers into anything already holding a copy:
the two decal materials' wound-style uniforms, and every panel syncer.

### Stain sizing (Mode A)

The decal's `size` used to be one authored number (0.15 m) times a coarse head/torso/arm/leg factor.
Measured against the real rig, that is not a near-miss — **0.15 m is 1.6x the width of a forearm**,
so the quad ran past the limb's silhouette on both sides, and simultaneously covered only 0.6x of the
torso. `bot-body-hit.js` exports **`partCrossSection(part)`**, the part's narrower cross-axis extent
in world metres (local Y is the long axis for every part the rig builds, so X and Z are the
cross-axes), and it rides along on every hit as `crossSection`. Sizing a decal against it cannot
overhang whatever it landed on.

Measured widths, armoured (v5) bot / human soldier, and the decal a `0.55x` fit produces:

| Part | Width | Fitted decal | Fixed 0.15 m was |
|---|---|---|---|
| torso | 0.236 / 0.256 m | 0.130 / 0.141 m | 0.6x the width |
| head | 0.151 / 0.181 m | 0.083 / 0.099 m | 1.0 / 0.8x |
| thigh | 0.111 / 0.155 m | 0.061 / 0.085 m | 1.3 / 1.0x |
| forearm | 0.094 / 0.098 m | 0.052 / 0.054 m | **1.6 / 1.5x** |

The flat quad still leaves a gap at its edges where the surface curves away — about 8 mm on a
forearm and 19 mm on a torso at a `0.55x` fit, falling roughly with the square of the fit fraction.
That residual is exactly what Modes B and C exist to remove, and it is the number to judge them
against. A capsule hit identifies no part, so `crossSection` is 0 there and sizing falls back to the
authored number — which is the honest comparison, since fitted sizing is only available once the hit
knows what it struck.

### Attached stains (`attach` + `resolveAttachment`)

A `blood_stain` used to be drawn at its fixed wire `p` every frame with nothing reading a bot
transform, so a hit bot walked away and left the stain hanging in mid-air. `attach` fixes that
without giving up the stateless wire model.

```
attach: { part: <index into body.parts.all>, role: <that part's material role>,
          parts: <body.parts.all.length>, lp: [x,y,z], ln: [x,y,z] }   // lp/ln are PART-LOCAL
```

`createEffectRenderer` takes an optional **`resolveAttachment(ownerId, attach) -> Matrix4 | null`**,
injected exactly the way `terrainHeight` already is and for the same reason: the renderer holds no
reference to a bot, recomputes the transform every frame, and a **guest resolves the same wire object
against its own rig**. Nothing about statelessness or replication changes.

- `lp` is transformed by that matrix; `ln` by its **normal matrix**, because `placeSegment` gives limb
  segments non-uniform scale and the model matrix would skew a normal pushed through it directly.
- On `null` — no resolver injected, bot despawned, corpse culled, body rebuilt by `reviveCombatBot`,
  guest has no such bot — it falls back to the world-anchored `p`/`normal` already in the wire object.
  The decal freezes at its last resolved pose. That pop is deliberate and preferred to dropping the
  decal to the origin.
- `role` and `parts` exist because a **stale index is silent-wrong, not null**: it would resolve to a
  valid matrix for the *wrong* part and put the decal somewhere else on the bot. They are a guard
  against gross mismatch, not proof of identity — `_role` is a *material* role (`shell`/`plate`/…),
  so several parts share one.
- `serialize()` in `entity-types/effect.js` is a **per-kind whitelist**, so `attach` only reaches the
  wire because its `blood_stain` branch names it explicitly. A field added to `create()` alone works
  in-process and silently vanishes for guests.

Both halves of the handle — building it from a shot and resolving it back to a matrix — live in
`bot-body-hit.js` (`resolveBodyHit`, `attachFromPoint`, `resolveAttachmentMatrix`); see
`docs/subsystems/bots.md`. Covered by `test-effect-renderer.mjs` (block 1c) and `test-body-hit.mjs`.

**Caller.** `damage-simulator.html` — a standalone single-bot harness for tuning hit effects against
the real bot rig. Its blood sliders edit `blood-tuning.js`'s two objects (see below), plus the
`smoke_puff`/`hit_spark` toggles.
It drives the full real entity lifecycle (`EffectEntity.create` → per-frame `update` → `serialize` →
`fx.sync`), the same three calls live combat makes. `bot-viewer-v2.html` spawns the same three kinds
from its real combat hit path (`spawnHitBloodFx`), so the harness is where they are *tuned*, not the
only place they run.

Two harness controls exist specifically so the harness can show the defects it is judging, because
by default it could show neither:

- **`hit resolution → source`** (`capsule` / `parts` / `mesh`). The harness has always used the
  triangle-accurate `batches.raycast`, which is *strictly better* than what live combat gives it —
  combat hitscan tests one 0.3 m capsule for the whole bot, so a limb hit lands centimetres off the
  mesh in open air. `capsule` reproduces production via `combat.js`'s `rayCapsuleHit` at
  `bot-entity.js`'s own defaults; `parts` uses `bot-body-hit.js`'s per-part walk; `mesh` is the
  best-case reference. Only `parts` and `mesh` can produce an `attach` handle — a capsule hit has no
  part information at all, which is the point.
- **`bot → pace`.** The harness bot used to never move, so a stain left hanging where the bot *was*
  was invisible in it. Pacing walks it ±1.2 m along X; the camera deliberately stays put.

`attach stains` toggles the handle on and off for a direct before/after. The coarse head/torso/arm/leg
attribution that scales effect sizes still comes from the bot's own live bounding box, since the
batching pool only tracks a material role per bucket, not an anatomical part.

**`limb loss` section** (2026-08-08). Drives `bot-wound.js` and `bot-limb-map.js` — the same two
modules `bot-viewer-v3.html` uses in combat — from clicks instead of gunfire, so a threshold can be
tried here before it reaches a firefight:

- `damage per hit` stands in for weapon damage, since the harness has no weapons. The real numbers it
  substitutes for are five_seven 20, cz_805_bren 24, m1911 33, knife 50, m24 95, rpg 110, against 100
  health — set it to one of those and count the clicks.
- `arm threshold` / `leg threshold` are live. Selecting a **damage class** loads that class's own
  numbers into both sliders, so the difference between armour (85/105) and a robot (45/55) is visible
  rather than tabular; overriding a slider afterwards still wins.
- A readout under the sliders shows each limb's accumulated damage against its threshold, which limbs
  are gone, and what the loss means for the weapon (`both hands` / `oneHanded` / `sidearm` / `disarm`).
- Five buttons sever a limb outright — the four limbs plus `head` — and `restore limbs` puts them all
  back, so the stump burst and the one-armed pose can be inspected without grinding a limb down first.
**`bleeding & death` section** (2026-08-11). Drives `bot-bleed.js` and `bot-haywire.js`. Shooting the
bot opens a bleeding site that drips from wherever that body part is now; severing a limb opens a
stump site at the joint, which bleeds harder. `heal (seal wounds)` closes them all. `kill bot` seeds a
ragdoll from the live rig, starts the bleed-out pool, and rolls for haywire; `force haywire` skips the
roll so the thrash can be watched on demand. The readout shows the open sites, the pool radius, and
the haywire odds this bot would face if it died right now. Wild haywire rounds are a spark and a
counter here — the harness has no weapon.

The **pool is always drawn through the projected decal pool**, whatever mode the wound stains are in,
because it has to conform to the ground. That is the one place Mode C is not optional.

- `headshots kill` mirrors the viewer's own switch. The head never accumulates: one hit anywhere on it
  is fatal and takes it off, so the readout reports it as taken or not rather than as a filling bar.
  Turning the switch off leaves head hits recorded but harmless, which is how to see them land.

`capsule` hit source cannot accrue limb damage at all — it resolves no part, so there is nothing to
attribute the damage to. The readout says so rather than looking broken. That is the same gap
production has, which is why the harness reproduces it instead of hiding it.

### `wound-mask.js` — the wound centre

A decal used to be one flat per-instance colour: `colorNode = attribute('instColor')`, with the stain
texture supplying alpha only. That reads as a puddle, not a puncture. Both decal materials now darken
their own middle:

```
core  = 1 - smoothstep(woundInner, woundOuter, length(<decal-local xy>))
color = mix(instColor, instColor * woundDarken, core)
```

`wound-mask.js` holds the shared constants (`WOUND_DEFAULTS` = inner 0.06, outer 0.28, darken 0.25)
and the CPU twin `woundCoreFactor(dist, inner, outer)`. Unlike `post-grade.js` and the other twins,
this one **is** imported by the files it mirrors — only for the constants, so the two materials cannot
start from different defaults; the function itself exists for the Node test.

- **Distances are in decal half-widths**, not metres. The quad spans ±0.5, so the numbers hold their
  meaning at any stain size: on a fitted forearm stain (~0.052 m half-width) the fully dark core is
  roughly a 6 mm-radius puncture fading out by ~30 mm. `projected-decals.js` computes the same
  radius from `local.xz`, which is already in those units, so the two stain modes match.
- **The mix is driven by geometry, not by the mask's alpha** — the obvious-looking shortcut. The mask
  in `makeStainTexture` is deliberately irregular: seven fused lobes sit at r 0.10–0.26 from centre
  with radii up to ~0.20, so alpha reaches 1 in patches well away from the middle. Driving colour
  from alpha would paint several dark blotches scattered across the stain instead of one wound.
- **The wound centre is per instance, not per material** — `instWound`, a float that multiplies the
  core factor. `blood_stain` passes 1, `blood_splatter` passes 0. This matters because the two kinds
  are **one instanced draw sharing one material**: with the uniforms alone, every ground droplet got
  a dark centre too, which is wrong — a droplet thrown onto the ground is not a puncture. The three
  uniforms still set the *shape* of the core for the whole pool; `instWound` decides who gets one.
  (`projected-decals.js` only ever receives stains, so it has no such flag.)
- `instColor.mul(darken)` darkens *whatever colour the instance carries* rather than forcing a blood
  shade, so a future non-blood decal on the same pool is not broken by it. Remaining limit: a later
  kind wanting a *different* core — a bright ember centre rather than a dark one — needs its own
  per-instance value, since `darken` is still material-wide.
- Covered by `test-wound-mask.mjs`: the twin matches `1 - smoothstep` to 1e-12 across the whole quad,
  is monotonic, handles a zero-width and an inverted band; both materials expose the same write API,
  ignore garbage, survive a pool resize, and start from identical defaults; and a synced
  `blood_stain` writes `instWound = 1` while every instance a `blood_splatter` produces writes 0.

### `projected-decals.js` — depth-projected stains

A flat quad stuck to a curved limb still lifts off at its edges (~8 mm on a forearm, ~19 mm on a
torso, at the 0.55× fit above). `createProjectedDecals({ THREE, scene, decalTexture, cap = 256,
debug = false })` avoids that by having no surface of its own: it draws an instanced box, reads the
depth already in the framebuffer via `viewportDepthTexture()`, reconstructs the world position of
whatever solid geometry is behind each fragment, and paints only where that position falls inside the
box. It therefore conforms to whatever is actually there, with no per-hit CPU work and no geometry.

```
pool.begin();
pool.push(x, y, z, normalVec3, size, depthM, r, g, b, a, spin);   // -> false if capped/faded
pool.end();                                                        // uploads + sets instanceCount
pool.cap / pool.count / pool.dropped / pool.peak / pool.droppedPeak / pool.resetStats()
```

- `size` is the full in-plane width; `depthM` is how far the box reaches along the normal **each
  way**. Keep `depthM` under half a limb's width or the box also catches the limb's far side.
- The material is `MeshBasicNodeMaterial` with `side: BackSide`, `depthTest: false`,
  `depthWrite: false`, `forceSinglePass: true`, `renderOrder = 2` — the box must not vanish when the
  camera is inside it, and only the sampled depth may decide what gets painted.
- Fragments outside the box are masked with `step()`, not `Discard`: `Discard` writes to the fragment
  stack via `.toStack()` and is only reliable inside an `Fn`, and at alpha 0 over a transparent
  material the result is identical.
- The cap is fixed at construction here — there is no `setCap`. `bot-viewer-v2.html` changes it by
  disposing and recreating the pool inside `ensureProjectedStains()`, which it has to do for the
  `debug` toggle anyway. `dropped`/`peak`/`droppedPeak` mirror the quad pool's counters so both
  techniques report their cost the same way.
- `debug` is baked into the TSL graph, so toggling it means disposing and rebuilding the pool. It
  paints reconstructed world position as a 1 m colour grid — a clean grid locked to the world means
  depth sampling works in this pipeline.
- This does **not** replace attachment. A projected decal conforms to whatever is on screen right
  now, so a world-anchored one smears across anything that walks through it; the box still has to be
  moved by the body part it belongs to, exactly like an attached quad.

Covered by `test-projected-decals.mjs` (23 checks: graph builds in both debug modes, basis
half-extents and orthogonality, projection axis along the normal, unlifted centre, near-vertical
normal, cap clamping, degenerate normal stays finite). What it **cannot** check is whether
`viewportDepthTexture` can sample a *multisampled* depth target inside an `antialias: true` +
`PostProcessing` pipeline — that needs a GPU, and it is what the `debug` view exists for.

**That multisampling question is now answered in practice, and the answer is that it works.**
`damage-simulator.html` and `bot-viewer-v3.html` both run `antialias: true` into `postFX.renderAsync()`,
and in both of them projected stains land correctly on the ground. Depth is readable here. What is
still open is narrower and different: in `bot-viewer-v3.html` stains land on the **ground but not on
the bots**, while the same code in `damage-simulator.html` puts them on the body. Both harnesses use
`createBodyPartBatches` with `visuals.botMaterials`, the same `projDepth` of 0.025, and near-identical
push loops, so the cause is not the renderer, the materials or the box size. The live difference is
that v3's bots move and are flushed to an instanced batch under LOD striding (`bot-viewer-v3.html`
line 16246), which makes a stale-or-offset attach transform the leading suspect: a box that misses the
limb by more than 25 mm paints whatever is behind the bot instead, which is exactly the ground.
`bot-viewer-v3.html` now takes **`?projdebug=1`** to build its pool with `debug: true`, so the grid can
be used to tell "the bot is missing from the depth buffer" apart from "the box is in the wrong place".

### Wiring in `bot-viewer-v2.html`

The harness tunes these; `bot-viewer-v2.html` runs them in its real combat hit path. Two buttons in
**Body & ragdoll** expose the cost, because both refinements are optional work:

- **`Wound hit: Cylinder / Mesh`** (`botWoundHitMode`). `Cylinder` keeps the point combat already
  produced from the bot's single 0.3 m capsule — free, but it floats off the limb and carries no part
  information, so no attachment and no fitted sizing. `Mesh` re-traces the shot through
  `refineWoundHit()` → `resolveBodyHit({ refresh: true })` for the true surface point, its normal, the
  hit part's cross-section and an `attach` handle. Cost is one AABB walk over the rig **per damage
  event**, not per frame. It returns `null` when the victim has no instanced rig (dummy targets) or
  when the ray misses the mesh — the capsule is fatter than the body, so a graze can land in open air
  — and every caller then falls back to the capsule point unchanged.
- **`Wound stain: Fitted / Projected`** (`botStainRender`). `Fitted` is the quad in
  `effect-renderer.js`, sized `0.55 ×` the hit part's cross-section and clamped to `0.03..0.16` m.
  `Projected` hands stains to `projected-decals.js` instead. Mode exclusivity is enforced at the call
  site in `updateEffects()`: when projecting, `blood_stain` is filtered out of the wire list before
  `effectRenderer.sync()` (into a reused scratch array, since that runs every frame over up to 900
  effects) and `drawProjectedStains()` draws them, mirroring `drawBloodStain`'s fade envelope and
  attach resolution so only the decal technique differs. The pool is built lazily on first use.

- **`Damage class: <id> / Off`** (`botDamageClassesEnabled`, default on). Routes every hit through
  `bot-damage-class.js`: `cls.sparks` gates `hit_spark`, `shouldShowBlood` gates the three blood
  kinds, `shouldShowSmoke` adds a small grey `smoke_puff`. Off restores the pre-table behaviour
  (everything bleeds and sparks on every hit), which is the A/B — **the default body kind is
  `armoured`, so turning this on stops healthy bots bleeding until they drop below 35%.** The button
  names the class the current body kind resolves to, and follows the body-kind toggle.
  `actor.armourBreached` holds the one-way latch and is cleared only by `reviveCombatBot`.
- **`Bleed by health: On / Off`** (`botBloodIntensityEnabled`, default on). Scales the droplet burst
  and ground splatter by `bloodIntensityForHealth(hpAfter)`. Off pins every hit to the lethal-end
  tuning, i.e. exactly what shipped before.
  `hpAfterHit(target, amount)` predicts the post-hit fraction rather than reading it, because all
  three call sites spawn FX *before* decrementing health — deliberately, so the FX lead the state
  change. An immortal practice dummy never loses health, so it is pinned to the lethal end instead
  of reading as untouched forever.
- **`Decal budget`** (`botDecalBudget`, default 512, range 32–4096). One slider drives both pools —
  `effectRenderer.setBloodDecalCap()` and the projected pool's own cap via `ensureProjectedStains()`
  — and its value readout is the live measurement: `cap — used now, peak, N dropped`. The 512 in
  `effect-renderer.js` was never measured against a real fight; this is what makes it measurable.
  It fires on `change`, not `input`, because each change reallocates buffers, and the readout is
  repolled at 4 Hz alongside the squad roster rather than every frame. Switching stain mode reports
  the other pool's peaks, since the two are counted separately. The budget round-trips through the
  save/load slots with the two mode toggles.

`attachMatrixFor(ownerId, attach)` is the injected resolver: it looks the bot up in `botActorById` and
returns `resolveAttachmentMatrix(actor.body, attach)`. `spawnHitBloodFx` now takes the victim entity
and the shot's source point, so the three callers (`applyBotDamage`, the dummy-target branch, and the
blast loop) all supply a ray to re-trace. `setGearLod` swaps geometry without changing
`parts.all`'s length or identity, so attachment survives an LOD switch.

## Tests

- **`test-rain-math.mjs`** (Node, no GPU): exercises `rain-math.js`, the CPU twin of `rain.js` — wrap stays in the box at any t, streak basis orthonormal and camera-facing (incl. looking straight down the fall line), occluder uv bounds, roof cut, ripple clock, density clamp. 10 tests.
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

- **`test-effect-renderer.mjs`** (Node, no GPU): imports `three/webgpu` from `node_modules` (0.184.0,
  the same version the CDN importmap pins) against a stub `scene` and a stub `document.createElement`
  so `makeSoftTexture` and `makeStainTexture` can run headless (the stub context needs
  `beginPath`/`arc`/`fill` as well as `fillRect`). It verifies **pool arithmetic and lifecycle, not
  rendering**:
  - construction — exactly three instanced pool meshes (additive glow, normal-blend smoke, decal
    blood), all empty, all `frustumCulled = false`, fog on for smoke only, every per-instance
    attribute flagged `isInstancedBufferAttribute`, capacities 220/260/512, and the decal pool
    `DoubleSide` **with** `forceSinglePass`.
  - decal geometry (block 1b) — one stain is one instance; both in-plane axes are exactly `size`
    long, orthogonal to each other and lying in the surface plane; a near-vertical normal still
    yields a real tangent (the helper-axis swap); 700 stains clamp to the 512 cap.
  - attachment (block 1c) — a resolved handle places the decal from the returned matrix rather than
    from the wire `p`; an unresolved handle *and* an absent resolver both fall back to `p`; under a
    non-uniform `(1,4,1)` scale the world normal matches the **normal matrix**, not the model matrix
    (the two differ by ~76° for the test's `ln`, so only the correct one passes), and the decal's
    in-plane axes stay perpendicular to it.
  - blood cases sync twice — once at `t=0` to register `firstSeen`, once aged — because a stain's
    fade-in makes its alpha exactly 0 at birth and `pushBlood` drops it.
  - per-kind instance counts, chosen at ages where the arithmetic is hash-independent: explosion
    `t=0` → 6 glow / 0 smoke and `t=0.6` → 0 glow / 10 smoke; muzzle `t=0` → 1 glow and `t=0.1` → 2
    smoke; tracer `t=0.02` → 11 glow beads (`t=0` → 0, head still inside `minVisibleDistance`);
    `smoke_puff` → exactly one instance each; `hit_spark` on terrain → 1 dust instance at `t=0.1`,
    on flesh → none.
  - caps — 100 explosions clamp glow to 220; 400 puffs clamp smoke to 260.
  - an empty (and an `undefined`) sync drops both `instanceCount`s to 0 and hides both meshes.
  - the `firstSeen` sweep — an id is retained inside `SEEN_TTL_MS` (so it keeps aging out) and
    dropped past it (so a reappearing id restarts at `t=0`).
  - the smoke gather is emission-ordered until a camera has been seen, then back-to-front.
  - `dispose()` removes every pool mesh from the scene.
- **`test-body-hit.mjs`** (Node, no GPU): covers `bot-body-hit.js` against a stand-in rig of plain
  `Object3D` parts — the exact shape instanced mode produces. See `docs/subsystems/bots.md`.

Its inputs are covered separately: `test-tracer-visual.mjs` for the tracer segment math it calls, and
`test-bot-explosives.mjs` for the puff-spawn cadence its rocket-trail caller drives.
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

## Wound-centred hit FX in the game (2026-08-08)

`environment-viewer-v2.html` now spawns the same blood stack the harness does — `hit_spark`,
`blood_spray`, `blood_stain`, `blood_splatter`, plus a `smoke_puff` wisp for classes that ask for one.
They are ordinary replicated `effect` entities created through `createEffectEntity`, so a guest sees
the same hit without any new wire kind: `entity-types/effect.js` already carried every field.

Two hookups worth knowing:

- `createEffectRenderer` is given a `resolveAttachment(ownerId, attach)` that reads the live rig out of
  `GhostRenderer.bodyFor(id)` (a new accessor). That is what lets a stain ride the body part it was
  left on instead of hanging in the air where the shot landed; the wire object stays a plain snapshot.
- Everything hangs off `bumpBotCombatCounters`, the single damage choke point, so bullets, knives and
  blasts all get wound FX without each fire path growing a copy. Hit points arrive as arrays from
  hitscan and as `{x,y,z}` from blasts, which is why `fxPointArray` normalises first.

Cost dials live in the Combat Bots panel: blood FX master, wound-fitted hits (the per-hit rig
retrace), damage classes, health-scaled blood.


## Exploratory demos (`demos/`)

`demos/volumetric-smoke.html` renders explosions two ways on the same life cycle: the billboard
pool this subsystem ships (`GLOW_POOL`/`SMOKE_POOL` with `makeSoftTexture`'s 64px radial gradient) and a
raymarched density volume. It is an evaluation page, not a module — nothing here depends on it.

It was written after reviewing both existing explosions: this file, and html-game-v2
(`G:\My Drive\Scripts\html game\html-game-v2`, `src/game/main.js`). Worth recording, because
this file's own header already says it is a port of that one and the two have since drifted:

| Layer | html-game-v2 | `effect-renderer.js` |
|---|---|---|
| Fireball core | solid sphere mesh + a pooled dynamic light | additive billboard; the light is added separately by the caller |
| Shockwave | ground ring mesh **and** a wireframe shell sphere | 26-segment line ring + 14 radial rays standing in for the shell |
| Smoke | 2600-slot pool of **low-poly spheres**, solid colour, custom shader | 260-slot pool of soft billboards; **10 puffs per blast** |
| Shrapnel | 900 instanced tetrahedra + a 900-slot glow pool + per-fragment trails | 12 additive line streaks, no trails |
| Sparks | 80 instanced cylinders | points in the pooled buffer |
| Ground impact | textured additive quad, gated on height above terrain | line ring only, gated by `nearGround` |
| Rubble, scorch, crater | rubble only | none |
| Degrading under load | `reserveExplosionVisualTier` | pooled sub-particles overflow and drop silently |

**What the volume actually helps.** The smoke (both projects are approximating a volume, one with
sprites and one with opaque spheres), the fireball core, and ground interaction. **What it does
not help** is shrapnel, sparks, embers and the shockwave ring — thin, fast, near-sub-pixel work
where instanced geometry is correct and html-game-v2's version is the stronger of the two. Since
2026-08-16 the demo draws exactly that layer, via `blast-debris-sim.js` + `blast-debris.js` (see
below), so the page now shows the volume *and* the persistent debris side by side.

The one line worth carrying back is the march's exit clamp:

```js
const tEnd = min(tFar, sceneDist);   // sceneDist reconstructed from viewportDepthTexture()
```

That is what a billboard cannot do. A quad meeting the floor cuts a straight line into it; a volume
that stops at the depth already in the framebuffer meets it along a curve. It is also what makes a
ground-hugging blast honest: html-game-v2 has to gate its ground splash on a height test and lay a
flat quad, where the volume simply cannot reach through the deck. The second difference is
self-shadowing — a short secondary march toward the sun gives a cloud a lit top and a dark
underside, which a flat sprite has no way to fake. The third is that the fireball lives inside the
same density field as the smoke, so it is occluded by its own smoke as it decays.

Every live blast is one instance in one draw, with centre, radius, phase and tier as instanced
attributes — the same pool shape this file already uses, and the reason it fits the replication
model: a blast is about eight floats, against ten separately-hashed smoke puffs.

The depth reconstruction is `projected-decals.js`'s (`getViewPositionSafe`, lines 188-193) copied verbatim,
so the demo inherits that file's **unresolved risk and does not settle it**: it runs
`antialias: false` with no `PostProcessing` stack, i.e. a single-sampled depth target. Whether
`viewportDepthTexture` can sample the multisampled target `environment-viewer.html` actually has is
still unverified. Note though that `bot-viewer-v3.html` already ships `projected-decals.js` AND exposes
`?msaa=0` (line 146), so **v3 is where that question gets answered without writing any code** — if
projected wound stains render there, the volume's depth clamp works there too. The demo's "depth
debug" checkbox is the same 1 m-band sanity view `projected-decals.js` ships, for exactly that.

### `explosion-tier.js` (new, not yet wired in)

A port of html-game-v2's `reserveExplosionVisualTier`, extracted as a pure module and covered by
`test-explosion-tier.mjs` (34 checks). It is the one piece of that codebase this subsystem should
adopt outright.

The reason is the failure mode. This file's pools are immediate-mode with silent overflow, so a
volley removes **random sub-particles from every live blast at once** — everything on screen gets
slightly worse and nothing looks deliberate. The tier system instead reserves a quality per blast
at spawn: within a 320 ms window the first two render full, the next three medium, the rest lite.
Later blasts degrade whole and coherently while the first ones stay pristine.

`createExplosionBudget({ windowMs, now, limits })` returns `reserve(priority)` / `reset()` /
`used`; `scaledEffectCount(count, tier)` scales a particle count by tier (medium keeps 55%, lite
25%). The clock is injected so the test does not sleep. The constants are asserted as literals in
the test rather than read back from the module, so retuning them has to be a deliberate decision
about diverging from html-game-v2.

In the demo the tiers drive raymarch step count — full march, half march with the light pass off,
or billboard fallback — because step count is the only quality dial a march really has. They also
scale the debris (`TIER_DEBRIS_SCALE`: medium halves shrapnel and keeps 38% of rubble, lite spawns
none), which is how html-game-v2 applies them.

### `blast-debris-sim.js` + `blast-debris.js` (2026-08-16; demo + bot-viewer-v3)

The persistent debris layer that `effect-renderer.js` cannot hold, because it is stateless by design.
`docs/research/html-game-v2-explosion-effects.md` §13 has the full ported / not-ported table; the
short version is that the instant layers (flash, ring, embers, short smoke, light, shake) were
already here and everything that lands, bounces, skids and smoulders for twenty seconds was not.

`createDebrisSim({ groundAt, random, caps, settings })` returns the arrays `shrapnel`, `rubble`,
`sparks`, `smoke`, plus `spawnBlastShrapnel(x,y,z, blastRadius, color, {countScale, speedScale,
gravityScale, verticalBoost, direction, directionBias})`, `spawnRubble(x,y,z, size, [dx,dz],
{countScale})`, `spawnImpactSlabs(x,y,z, {scale, count, …})`, `spawnSmoke(…)`, `step(dt)`,
`clear()`, `counts()`, `hottestRubble(n)`. `settings` is html-game-v2's
`particleEffectDefaultSettings` (count/speed/gravity/life/smoke/glow scales for shrapnel and rubble,
`rubbleSmolderChance` 0.28, `rubbleLightScale`), live-mutable. Numbers are theirs; the annotated
source is the research doc. `test-blast-debris-sim.mjs` (168 checks) pins the pool sizes, the count
clamps, bounce/settle, flicker + late fade, cone bias, kill-direction rubble, smoulder → glow/light/
sparks/smoke, per-bounce spin damping, slab secondary bursts, recycling and `clear`.

`createDebrisRenderer({ THREE, scene, sim, lightCount, softTexture, tagMaterial })` returns `sync()`
(call every frame after `sim.step`), `show` (per-kind visibility flags: shrapnel, rubble, glow,
lights, sparks, smoke), `stats`, `dispose()`, `meshes`, `lights`. `tagMaterial(material, role)` is
called once per material as it is built — role is one of shrapnel / shrapnelGlow / rubble /
rubbleGlow / sparks / smoke — and exists so a page with its own shading pass can reach them without
this module knowing about that pass. It is called for the smoke AFTER its colour graph is assigned,
so a tagger can wrap rather than replace it. Colours from the sim are sRGB floats and are converted with
`Color.setRGB(r,g,b, SRGBColorSpace)`. Six draws total. The one departure from html-game-v2 is the
smoke: theirs is low-poly spheres with a flat-colour shader, ours is the same instanced sprite pool
this file and the demo already prove under WebGPU.

In `demos/volumetric-smoke.html` the "Debris" panel section carries the visibility toggles, the two
mapping knobs (fireball radius → their blast radius, default ×3.2; rubble size), a "ground slabs"
toggle for the bomb-scale preset, and every tuning scale. Shrapnel spawns on every non-lite blast;
rubble only on ground blasts (`b.y < 0.6·r0`), thrown along a per-blast direction.

In `bot-viewer-v3.html` (2026-08-16) `spawnBlastFx` calls `spawnBlastDebris(center, shown)` after
the layered effect, so every grenade / rocket / loiter-drone blast sheds debris. Differences from
the demo, all deliberate: `groundAt` is the harness's `groundHeight` (terrain field), so pieces
respect the ground but pass through walls (map collider is the next step); the renderer is built
with `lightCount: 2` because `bot-viewer-visuals.js` caps real dynamic lights at two on this forward
path and resident lights tax every pixel even at zero intensity; `radiusScale` defaults to 0.5
because our damage rings (grenade 15 m) are three times theirs; rubble picks a random heading since
an area blast has no kill vector; `explosion-tier.js` admission scales a volley's debris. Panel:
Explosives → "Blast debris (html-game-v2)" (enable, clear, six show toggles, ground-only rubble,
slabs, tiering, mapping knobs, all sim scales); everything saves in the bots slot (`debris`,
`debrisTuning`, `debrisShow`). `rebuildTerrainField` clears the debris through an `onGroundRebuilt`
hook: a settled piece has stopped asking where the ground is, so a reseed would otherwise leave it
hanging at the old height for the rest of its twenty seconds. Not in `environment-viewer.html`: the open decision is whether debris
replicates (host seeds → guests simulate locally) or stays host-local cosmetic.

#### Two departures from html-game-v2, both bought by the flight sim (2026-08-17)

Neither is on unless a caller asks for it, so bot-viewer-v3 and the demo still get their numbers.

- **Inherited velocity.** `spawnBlastShrapnel` and `spawnRubble` take `velocity: [vx, vy, vz]`, added
  to every launch vector. Their game only ever blew up things standing still; an airframe coming
  apart at 200 m/s whose wreckage hangs in the air reads as a bug. Omitting the option spawns every
  piece with their numbers exactly. **Nothing in the sim is drag**, so whatever a piece launches with
  is what it still has when it lands, and passing a raw velocity through is a trap: the flight sim's
  40 mm fuses at 880 m/s, and half of that on 43 fragments with 24 seconds to live puts burning
  wreckage kilometres downrange from one airburst. Callers must cap it — see `DEBRIS.maxInherit`.
- **Settling.** A piece that has run out of bounces, stopped sliding (horizontal speed under 1 cm/s)
  and stopped turning (summed spin under 0.05 rad/s) sets `resting` and is skipped entirely: no
  gravity, no integration, no ground query, no spin. Gravity would otherwise un-zero `vy` every frame
  and drag a piece that has been lying still for fifteen seconds back through a ground query it
  cannot fail. That query was free on html-game-v2's flat floor; on a terrain field it is 16 waves
  plus a domain warp, times up to 1,160 pieces, every frame. How much it actually saves is entirely
  the caller's: a blast at head height has everything down within seconds, while an aircraft killed
  at 1,500 m has fragments airborne for most of their 20 s life and saves almost nothing.
  Fade, flicker, the ember glow, ember smoke, ember sparks and expiry all keep running while
  resting. The MOTION trails do not, which is right — a piece that is not moving is not kicking dust.
  The damping below is load-bearing rather than cosmetic: remove it and nothing ever rests at all,
  because a fragment satisfies the speed test long before it stops turning.
- **Shrapnel spin damping**, which the settling forced. html-game-v2 never damped fragment spin at
  all — a fragment lying on the ground kept turning forever, which stayed invisible only because
  nothing ever stopped simulating it. Skipping a piece still turning at 7 rad/s froze it in one
  frame, a visible pop, so grounded fragments now damp spin at 0.68/contact, the rate the rubble
  already used, and cannot rest until they have. Slabs also diverge slightly from a pre-change run:
  a resting slab stops consuming `rnd()` on its secondary-burst timer, which shifts the stream. No
  burst is lost (they need `v2 > 42`), but a seeded replay will not match frame for frame.

#### In `demos/flight-sim.html` (2026-08-17)

`explosion(pos, scale, kind, vel, wreckage)` gained the last two arguments and calls `spawnDebris`
for every `'craft'` blast — aircraft kills, wreck impacts, bombs, missiles, shell bursts, destroyed
ground sites. `'hit'` pops (bullet strikes, aircraft taking damage) get none, the same line the
volumetric puff already drew.

Three rules stand between a call site and the sim, and each of them was a bug first:

- **`DEBRIS.maxInherit` (90 m/s)** caps the inherited speed. It is the stand-in for the drag the sim
  does not have. Measured on the 40 mm, the fastest gun that actually fuses: 43 fragments left at
  413–472 m/s before the cap and 57–120 m/s after it. The 105 mm goes 189–295 down to 64–150.
- **The ground absorbs the fall.** Within one blast radius of the surface — `scale ×
  DEBRIS.radiusScale`, the radius the sim is actually given, not `explosion()`'s own argument — the
  inherited downward component is dropped and only the horizontal carries, so a wreck arriving in a
  60° dive throws debris ALONG its flight path instead of straight into the terrain. It measures
  against the same clamped waterline the sim uses, or the rule would never fire at sea.
- **`wreckage` is false for a blast that destroyed nothing of its own** — that is, a shell fusing.
  Wreckage is the thing that died coming apart; a shell throws fragments and nothing else. Without
  the gate the gun filled the 260-piece rubble pool with tumbling airframe chunks and starved the
  actual kills. The same flag also cuts the fragment count to `DEBRIS.shellFragments` (0.45), for a
  pool reason rather than a physical one: fragments live 20–28 s, and a gunship holding the 40 mm
  down at 2 rounds a second at full count fills the 900-piece pool by t = 15 s and then recycles.
  Measured over a 30 s burst with a fighter killed at t = 5 s: at full count 74 of the kill's 90
  pieces survived to t = 15 s and the pool was saturated; at 0.45 all 90 survive and the pool sits at
  645. These caps were sized for a ground game where a handful of things explode, not for an
  autocannon.

- Rubble is **not** ground-gated the way it is in bot-viewer-v3. Up here it is the airframe itself
  coming apart, so a kill at 3,000 m rains burning wreckage the whole way down. It is thrown along
  the flight path; a static ground site has no direction, so it gets a random one.
- The two mapping constants (`DEBRIS.radiusScale` 3.0, `DEBRIS.rubbleScale` 0.55) exist because their
  blast radius is a grenade's and `explosion()`'s scale is an aircraft's. The panel's "debris size"
  slider drives both, holding the ratio.
- `groundAt` is **not** `heightAt`: it is `Math.max(SEA_LEVEL, heightAt(x, z))`. `BASE_OFFSET`
  deliberately pushes the low ground under the water plane to make lakes, and measured on a 200 m
  grid over a 16 km square, 44.9% of the field is below y = 0 at a mean of 158 m down. Handing the
  raw field to the sim dropped every fragment of a kill over water through an almost-opaque surface
  to lie on the seabed for twenty seconds. Debris stops at the waterline instead — it does not float,
  spread or splash, which is the next piece of work, but it is where the explosion was. Over land the
  height is spacing 0, what every other placement in the sim uses; the rendered clipmap is
  band-limited by distance, so debris far from the camera sits against a slightly smoother surface
  than it landed on, the same mismatch ground sites and bomb impacts already live with.
- Every instanced upload is bounded with `addUpdateRange` to the live count. Without it `needsUpdate`
  re-uploads the whole pool cap each frame — 296 KB a frame across the six pools, about 18 MB/s, for
  the full twenty seconds one ember takes to burn out.
- **Vision modes.** `tagDebrisMaterial` runs through the `tagMaterial` hook so the debris carries
  sensible heats before `tagScene` can sweep it at the default, and so the smoke's own colour graph
  survives (`heatTag` would overwrite it; it is wrapped with `heatMix` instead). KNOWN LIMITATION:
  three multiplies `colorNode` by `instanceColor`, so on the unlit pools — shrapnel, sparks, glow —
  the heat grey comes out tinted by each piece's own colour and reads cooler than the tag asks for.
  The rubble is a lit material and goes through `heatTag`'s emissive path, which is exact. Fixing the
  unlit case means a per-instance heat channel in `blast-debris.js`.
- Two point lights rather than eight: a sunlit outdoor scene where a smouldering chunk lights nothing
  anybody can see, and every resident light taxes every pixel.
- Panel: "blast debris", "debris size", "momentum carried", under the volumetric-explosions toggle.
  The counts appear in the stats block only while there is debris alive. Re-enabling the toggle
  resets the tier budget, so the first blast back does not land mid-window and come out degraded.

`test-blast-debris-render.mjs` covers what the pure test cannot: that every material compiles as a
TSL graph both untagged and under the flight sim's heat tagging, that the smoke's per-instance
attributes survive the wrap, that `sync()` writes live counts and hides empty pools, and that the
lights follow the hottest rubble and park when there is none.

`demos/sdf-creature.html` is the sibling page and is not an FX technique — it draws a creature from
signed distance functions on a single quad, aimed at the empty portrait and loading surfaces in
`start-screen.js`. Both demos derive from a three.js demo by Drin (@DrinLajci); attribution and the
full write-up are in `demos/README.md`.

`demos/sdf-bug.html` is the third page in that family and the one with an FX result worth borrowing.
(`demos/sdf-bug-v2.html` is that page with a walk cycle; the FX notes below apply to both, and the
locomotion side of v2 is `docs/subsystems/creature.md`'s business, not this file's.)

**A TSL trap worth carrying to any page here that nests a `Loop`.** `Loop(count, ({ i }) => …)` hands the
callback an expression carrying the bare *name* `i`, resolved by WGSL scope where it is used — and every
single-parameter `Loop` in this build names its index `i`, whatever you destructure it to in JavaScript. So an
inner `Loop` declares a second `var i` that shadows the outer one for its whole body, and any reference to the
outer index in there silently reads the inner counter. It is legal WGSL, so there is no error and no warning;
in v2 it made the per-bug march evaluate its step number as the bug index and rendered a black ball. Capture
the index in a variable of its own (`i.toVar('name')`) before entering a nested loop. Checked at the time of
writing: `demos/volumetric-smoke.html` nests two marches and `clustered-lights.js` has two loops, but none of
them reads an outer index inside an inner loop, so v2 was the only live case.

v2 also carries **twelve eye appearances on eight mounts** in `demos/bug-eyes.js` — 96 combinations. The
twelve are shading only and cost no extra distance evaluations: compound facets, a refracted iris with real
parallax, iridescent film, a pseudopupil, an emissive sensor that the depth-of-field pass blooms for free.
The three mounts (stalked, ocelli cluster, cut-gem) are independent flags and the only part that changes the
field; keeping them off the appearance axis is what makes all 96 available instead of 15. The
transferable part for FX work is that a surface normal plus an authored frame is enough to paint a
convincing feature onto a primitive without adding geometry, and that the maths for it can be written once
and unit-tested: `demos/bug-eye-math.js` is method-chaining source that runs on TSL nodes in the browser
and on plain numbers in Node, which is how this repo's fourth CPU/GPU twin was avoided. Full write-up in
`demos/README.md`.
It aims the same technique at one specific photograph — a macro shot of a beetle on a brussels sprout
— and the two parts that generalise beyond the demo are:

- **Screen-space depth of field over an HDR target.** Pass one writes linear HDR colour plus
  normalised depth into a half-float `RenderTarget`; pass two gathers a jittered golden-angle disc,
  keeping each tap only in so far as its own circle of confusion reaches the centre pixel. Keeping the
  colour HDR through the gather is what makes a blown highlight spread into a bokeh circle with an
  edge rather than a grey smudge. `post-fx.js` has no depth-of-field pass; this is the cheapest
  reference implementation in the repo.

  **The gotcha, if you copy this:** a plane's `uv()` has `v = 0` at the bottom, but a render target
  stores row 0 at the **top**, because the rasteriser writes in framebuffer order and WebGPU's fragment
  coordinate is top-origin. Draw a full-screen pass with `uv()` and then sample the target with the same
  `uv()` and the image comes back vertically flipped — silently, with no error, and easy to misread as a
  camera-basis mistake. Three's own output pass avoids it by sampling with `screenUV`, which is already
  top-origin (`screenUV` is `screenCoordinate / screenSize`, and `screenCoordinate` follows the WebGPU
  convention). `sdf-bug.html` keeps `uv()` for screen-space work and flips explicitly for target reads,
  so the two conventions stay visible rather than merely reconciled.
- **Subsurface thickness with no baked map.** Thickness is four samples of the distance field stepping
  toward the light, asking whether the point is still inside. The rasterised path would need a
  thickness texture authored per model, which goes wrong the moment a shape parameter changes; here
  widening the body with a slider thickens the glow correctly because there is nothing to re-bake.

The page also sets `renderer.outputColorSpace` to linear and tone mapping to `NoToneMapping`, because
it does its own tone map and gamma at the end of the blur pass. Worth knowing if you copy from it:
with the defaults left alone the renderer inserts its own output pass and the sRGB curve is applied
twice. `demos/sdf-creature.html` has that double application — it gammas manually and leaves
`outputColorSpace` at its default — which is a real if minor bug in that page, left alone here because
fixing it changes its look and that is a taste call, not a correctness one.

## Rain (`rain.js`, `demos/rain.html`, 2026-08-16)

Evaluation of achrefelouafi/RainSystemThreeJS (MIT) for the bot viewer. That repo is WebGL GLSL
`ShaderMaterial` + `EffectComposer` + `onBeforeCompile` string injection, none of which runs under
`WebGPURenderer`, so nothing was copied; the streak-field idea was rewritten as TSL in `rain.js`.

**What is the same idea:** every drop is one instance of a 4-vertex quad; its position is a per-drop
seed wrapped with `mod()` into a box that follows the camera (`uVolume`, biased 85% below the eye);
the quad is stretched along its velocity and turned edge-on to the view ray; alpha is a soft streak
profile in uv.

**What is new here:**

- **Rain shadow.** `bakeOccluderMap(renderer, scene, U, {center, extent, size, layer, top})` renders
  everything on `layer` from straight above with an override material writing `max(worldY, 0)` into
  a HalfFloat `RenderTarget` (Nearest-filtered, so TSL emits `textureLoad` and it can be read in the
  vertex stage). The streak fragment multiplies alpha by `step(roof, worldY)`; splash rings sample
  the map in the vertex stage and sit at `roof + 0.012`. The ground must be on the layer so open
  ground bakes 0. Bake once for a static scene; the demo's "Rebake" button re-runs it. The bake
  material has `fog: false` — scene fog would bend the heights.
- **Accumulator drive, not `time`.** `update(dt, camera)` advances `uFall += speed·dt` and
  `uWindOff += (wind + gust)·dt`; each drop's own speed spread (0.75..1.25×) multiplies `uFall` on
  the GPU. Moving the speed or wind slider changes the rate, not the position, so drops never jump.
  `uGust` is a slow two-sine wander of amplitude `setGust()` (default 3 m/s) added to `uWind`.
- **Camera-relative motion.** If `update` is given the camera, its smoothed velocity goes into
  `uCamVel`; the streak direction is `(wind+gust, −fall, ·) − camVel`, and streak length scales
  with that apparent speed (clamped 0.25..3× of the authored `uLength`, which is the length at
  18 m/s). Drops within 0.25..1.4 m of the eye fade out (`vNear`) so nothing smears the frame.
- **No per-instance buffers.** Seeds are `hash(instanceIndex + k)`; `setDensity` is a
  `geometry.instanceCount` change. The geometry must be an `InstancedBufferGeometry` — a plain
  `BufferGeometry` with `instanceCount` set draws one instance in r0.184.
- **Splashes** live in a second wrapped square (`uSplashRadius`) so rings stay put in the world and
  only the trailing edge re-appears ahead; each ring re-places by up to 1.5 m per generation.
- **`applyWetSurface(mat, U, {baseColor, baseRoughness, baseNormal, rippleScale, puddleScale, streaks})`** mutates a
  `MeshStandardNodeMaterial`. `baseColor`/`baseRoughness`/`baseNormal` default to the material's own
  `colorNode`, its live `roughness` (via `materialRoughness`, so a theme retune still wins) and `normalWorld`; pass the material's existing graphs (bot-viewer-v3 passes the
  soil-dressed `visuals.groundNodes`) so the wet layer wraps them, and pass the real normal on
  anything not flat — the ripples perturb it, they no longer replace it with straight-up. Puddles are `mx_fractal_noise_float(xz·puddleScale)` thresholded by
  `uPuddle·wetness` with a soft shore, so they are blotches, not tiles; inside them roughness goes
  to 0.06 and albedo darkens a further 35%, outside there is a thin film (roughness × 0.65, albedo
  × 0.7 at full wetness). Ripple normals are a cell grid (expanding sine ring per cell with a
  hashed birth), full strength in puddles and 25% on the film, converted world -> view with
  `cameraViewMatrix.transformDirection()` (it was `transformNormalToView`, which applies the
  object->world normal matrix first and so turned the normal twice on every rotated wall and cover
  box; fixed 2026-08-17).
  Works on anything roughly flat; the demo also puts it on roof slabs. Cells are offset by +4096
  before `toUint()` because a negative float → u32 is undefined. Puddles and ripples are gated to
  up-facing surface (`smoothstep(0.6, 0.9, normal.y)`); side faces instead get a darker, glossier
  film with run-off streaks sliding down them (one `mx_noise_float` tap on `x+z` vs `y − t`,
  `streaks: false` removes them), so the same call dresses floors, roofs, walls and cover.
- **`applyWetSheen(mat, U, {amount, darken})`** is the cheap version for props and bodies:
  roughness × (1 − amount·wet) on top of the material's own roughness, albedo × (1 − darken·wet)
  on top of `materialColor` (instance colours still multiply in). Bot shells use it.
- **Shared uniforms** (`createRainUniforms`) so drops, splashes, wet ground and lightning
  (`uLightning`, decayed by `update`) move together; `flash(strength, decay)` drives it.
- **Two page hooks** on `createRainSystem` / `createRainStreaks` / `createRainSplashes`:
  `groundHeight(xzNode) → heightNode` cuts drops and lands splashes on an analytic surface
  (max'd with the occluder map — flight-sim passes its `tslHeight`), and `colorFn(rgbNode) →
  rgbNode` retints the drops (flight-sim passes `heatMix` so rain reads cold under IR). The
  roof/ground cut is now sampled once per drop in the vertex stage (`vCut` varying), not per fragment.
- **Helpers shared by both pages:** `createLightningBolt(scene, {colorFn})` builds a jagged
  `TubeGeometry` bolt with 2–4 branches whose radius scales with length (`strike(top, hit)`,
  `update(dt)` flickers it out); `createRainBed(ctx, dest)` is a pink-noise loop with `set(level)`
  driving gain and low-pass together; `playThunder(ctx, dest, {distance})` is brown noise with a
  crack that fades past 1.5 km and a roll that lengthens with distance; it returns its length in
  seconds, so it drops straight into `environment-audio`'s `playSynthAt(build)` contract, and
  `createRainBed(...).stop(at)` matches `playSynthLoop`'s stop handle.

Tunables and defaults are in `RAIN_DEFAULTS`. The demo adds what a page can and a module cannot
know about: fog far shrinks by up to 55% with density, bolts strike from 55–70 m, the key light
jumps to the bolt, and thunder fires `distance/340` s later when the sound bed is on. The flight sim
wires the same module over its terrain (see `flight.md` §Weather). Not done and
worth saying: no depth-fade for streaks that cross geometry side-on (the depth test clips them, but
hard), wet surface has no real puddle geometry or reflections beyond the PMREM environment, and no
run-off from roof edges. Node-tested via `test-rain-math.mjs`; the TSL
graphs themselves were verified only by name against the shipped r0.184 build.

**Bot viewer v3 wiring (2026-08-16, World → Weather card).** One `rain` slider fans out through
`setRainAmount`: drop density and opacity, `uWetness` (= min(1, 1.4·rain)) on both ground
materials, and `visuals.setWeather({overcast, dim, fogBoost})` — a new weather overlay in
`bot-viewer-visuals.js` that sits outside the theme (a theme switch keeps the storm): the sky
graph mixes to a cloud lid tinted by the theme horizon, key light ×(1 − 0.65 dim) and ambient
×(1 − 0.3 dim) inside `applyLights`, theme fog density × fogBoost (1 + 4·rain) with the colour
lerped toward grey inside `applyFog`. Roofs and canopies shadow the rain through
`bakeOccluderMap` over `mapRoot` + the trees root: the meshes get layer 3 enabled for the bake
only, extent = max(w, d) + 16 m at 1024², top 60 m, redone on the next rainy frame after any
`rebuildDerived` or tree placement (`rainOccDirty`) or via the Rebake button. Storms (rain > 0.3,
Lightning on) strike a `createLightningBolt` from 55–70 m to `roadGround.heightAt` 20–70 m from
the camera; `rain.flash` brightens drops, and `visuals.setLightning(uLightning)` per frame jumps
the key light (+3) and the cloud lid. Thunder plays `distance/340` s later through
`envAudio.playSynthAt` and the rain bed through `envAudio.playSynthLoop` (non-positional, so the
mixer and mute apply); both wait for a running context. `updateWeather` returns immediately when
dry. Sliders: rain, wind (steady + gusts), puddles, sky lid (how far the theme sky is covered), sight
loss, Lightning, Rain shadow under roofs, Rebake; a "Preset: storm" button sits in the World preset
strip. Second pass (same day): walls and cover get the wet film + run-off streaks + puddled tops,
bot shells/plates/trim/metal go glossy and fabric/rubber darken (`applyWetSheen` on
`visuals.botMaterials`), drops take 35% of the theme's horizon hue (`tintRainForTheme`, re-run on
every theme switch through `onLookChange`), rain shortens every bot's sight
(`botSightDistanceFor × (1 − sightLoss·rain)`, a lightning flash gives it back for a beat), and
weather rides in the maze slot (`captureMazeState.weather`, older slots leave it alone). Unseen in
a browser; the wet ground, wall and bot graphs build headless.

