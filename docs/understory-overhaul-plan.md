# Understory Overhaul — Phase 0 Work Order

Planning deliverable for the understory/dressing overhaul (plants variation, moss/lichen tint,
rock/scree host, fungi/deadfall). Written 2026-07-05 from a direct audit of our code, the
SeedThree extraction, the fable5-world-demo vegetation sources, and the threejs-aaa-graphics
scorecard. Companion docs: `understory-dressing-comparison.md`, `tree-generation-comparison.md`.

**Consumers:** implementer agents for Phases 1–4 and the human gate. Each phase section is a
self-contained work order.

> **⚠️ Read the merged plan first.** This overhaul shares a large seam with the terrain-appearance
> work: **this doc's Phase 2 rewrites the exact same `classifyMesh` per-vertex pass** that the
> terrain-shading plan rewrites, and both add a sampler to the same `loadTerrainMap` return object.
> They must land as **one** shared bake + material, not two. The reconciled ordering, the single
> merged vertex-attribute schema (do **not** implement this doc's standalone `splatData:vec4` in
> isolation), the shared `SurfaceField` API, and the shared `mossWeight()` dressing `Fn` are defined
> in `research/terrain-appearance-analysis/MERGED-TERRAIN-UNDERSTORY-PLAN.md`. Phase 1 (plants) here
> is independent and can proceed in parallel; Phase 2+ must follow the merged plan's sequencing.
>
> **Landed 2026-07-05 (shared foundation, additive):** merged-plan **F1 `SurfaceField`** is live as
> `loadedMap.surfaceField(x,z)` in `terrain-loader.js` → `{ materialColor, materialWeights (feathered
> top-4, not argmax), moisture, upness, density }`; the **moisture proxy** is `moisture-proxy.js`
> (biome→moisture × elevation-dryness, shore-band floor — pure, Node-tested); and the shared
> **`mossWeight()` dressing `Fn`** scaffold is `moss-tint.js` (+ `moss-tint-ref.js` CPU twin) ready
> for Phases 2/3(#7)/4(#8) to import. Tests: `test-surface-field.mjs`, `test-moss-tint.mjs`. These are
> read-only/standalone — `classifyMesh`, the `addGroup` path, the terrain material, and `plants-gpu.js`
> were NOT touched (that is merged plan #2, terrain-co-owned, still pending).

**SCOPE (locked by human, 2026-07-05): imported/authored worlds ONLY.** Procedural CDLOD terrain
is out of scope for this entire overhaul (resolves open-Q #6 and #8: defer permanently). All
placement samplers bind to the canonical CPU height query `terrainHeight` (see the R6 resolution
below), biome/normal from the map sidecar — never the procedural terrain field. Moisture is the
**proxy only** (biome→moisture table + height-above-sea + water-distance falloff); no map re-export
this overhaul (resolves open-Q #1 to option (b)).

**R6 / heightAt binding — RESOLVED at start time (verified against live code 2026-07-05).** The one
seam the two parent plans disagreed on. Finding:
- `terrainHeight(x,z)` (`environment-viewer.html:700`) is the **canonical CPU height query for the
  whole sim**: plants (`:2876` gpu, `:2995` placement), trees (`:1512,:2151`), creatures (`:3476`),
  water (`:1357`), collision/entities (`:3715`) all bind to it. Its body resolves in order: baked
  `cpuHeightField` bilinear read → `mapCollider.raycastDown` → `loadedMap.heightAt` — i.e. it **is**
  the authored-map surface (never procedural when a map is loaded).
- The merged plan's R6 ("grass floats on procedural `terrainHeight`") is **imprecise**: it describes
  only the non-default **CPU** grass path (`grass.js`, `:2735`, which passes `terrainHeight`). The
  **default is GPU grass** (`GRASS_MODE='gpu'` at `:63` → `grass-compute.js`), which does **not** use
  `terrainHeight` at all — it **mesh-anchors blades to `mapCollider.geometry`** (`:2822`) so caves/
  overhangs get grass, using `heightTex` only as water-envelope/fallback.
- **Decision: every new understory placement (shrubs, rocks, deadfall, mushrooms) binds to
  `terrainHeight`** — identical to plants/trees/creatures — and seats with the lowest-of-5-footprint
  trick against it. Do **NOT** mesh-anchor props like GPU grass does (that is a deliberate grass-only
  special case for overhang coverage; CPU-placed props needing `createTrunkIndex` collision must use
  the CPU query). Consequence to accept: on steep/overhang terrain, props may differ from GPU-grass
  height by the `cpuHeightField` bake resolution — this is exactly the plants↔grass relationship
  already shipped, so props inherit it consistently. **Terrain-team note:** their Phase-4 "fix grass
  `heightFn`→authored `heightAt`" applies to the CPU grass path only; for default GPU grass the height
  is mesh-anchored and needs no such fix — don't act on the "procedural" framing.

**Viewer compatibility (verified):** `plants.js` is the shared source of truth for both
`plant-viewer.html` (static import) and the world (`createPlantPalette`), and `trees.js` for both
`tree-viewer.html` and the world — so Phase 1 shrub presets appear in plant-viewer and the Phase 4
snag family in tree-viewer automatically. **Caveat:** per-instance variation (hue/dryness/age) lives
in the `plants-gpu.js` instance path, which plant-viewer does NOT use (it renders one hero instance
via `buildPlantGeometry`) — so variation is world-only unless Phase 1 adds a small "variation strip"
preview to plant-viewer (see Phase 1 files). Rocks (Phase 3) and mushrooms (Phase 4) have no viewer;
decide per open-Q whether to add a dressing-viewer or author in-world only.

**Source roles (do not blur them):**
- **SeedThree** (`scratchpad/seedthree/SeedThree-main/`) — same stack as ours (`three/webgpu` +
  `three/tsl`, vanilla JS). Code is adaptable near-directly, **but** its scatter/instancing is CPU
  `InstancedMesh` — everything pulled from it must be re-expressed on our
  reset→cull→finalize→indirect-draw compute spine (`forest-gpu.js`/`plants-gpu.js` pattern).
- **fable5-world-demo** (`scratchpad/fable5full/.../src/vegetation/`) — TypeScript. Study the
  systemic laws and data structures; reimplement, never copy TS.
- **threejs-game-skills** (`scratchpad/tjsk/.../threejs-aaa-graphics-builder/references/`) — review
  rubric only. Core rule: authored forms → materials → lighting → effects; never fake AAA with glow.

---

## 1. KEEP (build on, don't replace)

**Plants (A):**
- `plants-gpu.js` — the single-band reset→cull→finalize→indirect-draw spine, position-hashed
  dither fade (`posRandFn`, stable across rebuild re-sorts), zero-instance visibility gating,
  debounced rebuild, per-rebuild camera-distance sort. This is the production instancing host for
  every new dressing class. Note: `rec1` is `(yaw,_,_,_)` — **three free floats per instance**
  ready to carry hue/dryness/age with zero buffer-layout growth.
- `plants.js` — the schema-driven preset architecture (`PLANT_DEFAULTS` + `PLANT_PRESETS`,
  species = data), the shared petal-cluster/leaf-envelope builders, `createPlantPalette` startup
  bake. Extend the schema; don't fork a second generator.
- `plants-placement.js` — biome-allowlist + density-weighted, deterministic seeded records
  (`rngFrom`/`hash2` reuse), and the `clusterStrength`/`clusterScale` value-noise acceptance gate,
  which the file itself documents as "the intended extension point for future non-biome terrain
  masks". That is exactly where moisture/canopy/slope density functions go.
- `plant-viewer.html` + `plant-families/` authoring loop — new shrub species should be tunable
  there like the existing herbs.
- Tests-as-plain-Node-scripts convention and the CPU/GPU math-twin pattern (`forest-cull.js` et
  al.) — every new GPU-side density/tint law gets a Node-testable JS twin.

**Terrain/splat (B host):**
- `terrain-textures.js`'s texture *sourcing* machinery (manifest, candidate-file resolution,
  per-layer tileMeters/roughness settings, live layer-swap UI plumbing) is worth keeping even
  though the classification/material strategy (triangle-bucket → 13 flat `MeshStandardMaterial`s)
  is what Phase 2 replaces.
- `classifyMesh`'s per-vertex pass already visits every vertex with world position + world normal
  in hand — the natural place to bake per-vertex splat weights instead of a discrete pick.
- `biome-classifier-js.js` — has real `humidity`/`temperature` noise channels (terrain-v3 port);
  the closest thing we have to a moisture field. `terrain-loader.js`'s bilinear grid sampling
  (`biomeAt`/`grassDensityAt`) is the template for a `moistureAt(x,z)`.

**Trees/forest (context for C/host):**
- `trees.js`'s swept-tube mesher (`_generateBranch` ring emission) — reuse for logs/stumps rather
  than writing a new tube mesher. `tree-age.js` (pure, unwired) shows the "state transform over an
  opts object" pattern a `decay` transform should follow.
- `forest-gpu.js` LOD-banding + per-variant indirect draws — the model for rock LOD if boulders
  ever need one (they mostly won't; 3 variants × instancing is cheap).
- `collision.js` `createTrunkIndex` (chunk-bucketed circle push-out) — the cheapest correct
  collision for boulders and stumps on both terrain modes; logs approximate as 2–3 circles.

**Infra:** perf HUD (fps/frame-ms/triangles/draws/instances/per-pass GPU timings + CSV columns) is
the measurement harness for every acceptance criterion below; clustered-forward lighting means new
materials must stay on `MeshStandardNodeMaterial`-family node materials to pick up cluster lights.

## 2. PULL from SeedThree (adapt; re-express on our GPU spine)

All SeedThree scatter code builds CPU `InstancedMesh`es with a while-loop rejection sampler. The
*laws* (gating thresholds, tint math, geometry builders, material node graphs) port directly; the
*placement loop* becomes records in `*-placement.js` files feeding `setChunk()`, and the *per-
instance attributes* become extra floats in the source/draw storage buffers read in `instanceNodes`
— **not** `InstancedBufferAttribute`s.

**RNG caveat:** SeedThree's `docs/generation-design.md` warns against `mulberry32` (reportedly
skips ~⅓ of 32-bit values) and recommends xmur3→splitmix32/sfc32. Our whole placement stack
(`forest-placement.js` `rngFrom`, `grass-anchors.js` `mulberry32`) is mulberry32-based and
deterministic output is load-bearing (docs stress RNG draw order). **Decision: do NOT swap RNGs
mid-overhaul.** Visual quality of scatter jitter is unaffected at our draw counts; a swap would
invalidate every determinism test and any saved-looking world. Log it as tech debt; new subsystems
may use a forked-stream RNG (fable5 `Rng.fork()` style) internally if they never share a stream
with existing placement.

**(A) Plants/shrubs — `src/core/scrub.js`:**
- `shrubGeometry()` — crossed-quad sprig clump (8 jittered tilted quads fanning from the base) with
  **ground-plane normals** (`normals.push(0,1,0)` + view-space up in `normalNode`) so shrubs light
  like the terrain. Adapt as a `plants.js` `style: 'sprigClump'` geometry path (or a small
  `shrubs.js` sibling) baked into the palette like any other variant.
- Per-instance tint law: species base tint × per-channel 0.85–1.12 jitter + a 22%-probability
  "dry" roll that lifts R and suppresses G/B (`dry = 0.22` branch). Port the *math* into
  placement-record fields consumed by TSL `colorNode` mix.
- Share-weighted species buckets + `rocknessAt`-gated rejection — maps onto our density-weighted
  species pick + the `clusterStrength` acceptance-gate extension point.
- `shrubMaterial()` — `MeshSSSNodeMaterial` with translucency-map-driven `thicknessColorNode`
  modulated by per-instance tint. Optional polish; see `docs/foliage-materials.md` for the
  verified knob set (`thicknessAmbientNode: 0` — the flat glow-floor is "the classic mistake").
- Wind: `wind.js` `grassWindPosition()`/`foliageWindPosition()` — TSL `positionNode` displacement
  (never `vertexNode`), baked phase attributes. Our plants currently have **no wind**; adapt the
  grass-tier sway for plants/shrubs (compose with `plants-gpu.js`'s existing `positionNode`
  instance transform — wind offset applies after the yaw/scale rotation, in world space).

**(B) Moss/lichen vehicle — `src/core/terrain-material.js`:**
- The whole file is the Phase 2 blueprint: single `MeshStandardNodeMaterial` for the terrain,
  **attribute-driven splat weights** (`attribute('rockness')` + `attribute('rockVars','vec4')`),
  brush-texture `smoothstep` sharpening (`sharp()`), sequential-mix chain → explicit per-layer
  weights, seam-band gravel (`band(x)=4x(1-x)`), `DataArrayTexture` layer packing (albedo+roughness
  in alpha / normal+height in alpha) to dodge the 16-sampler cap, macro anti-tiling patina tap.
- Verified TSL gotchas documented in its comments (cite these in every phase): **no `If()` at
  material top level — chained `select()` expressions only** (the dominant-layer pick literally
  threw `Cannot read properties of null (reading 'If')` and silently fell back); **explicit
  `.level(0)` inside POM march loops** (derivative sampling in divergent flow is WGSL UB → black
  feather patches); **explicit `.grad(gX, gY)` of the base UV for anything sampled at a marched
  UV** with gradients clamped ±0.1; DataArrayTexture **mipmap generation is broken** on WebGPU
  (use `LinearFilter`, `generateMipmaps=false`).
- SPOM relief itself is optional stretch for Phase 2 (perf risk); the splat-weight + tint layer
  does not depend on it.

**(Host) Rocks — `src/core/rocks.js`:**
- `displaceRock()` — **weld first** (`mergeVertices`; PolyhedronGeometry is non-indexed and
  displacing duplicated verts tears the surface), displace by 4 random plane waves (smooth
  silhouettes only — detail lives in the texture), squash Y 0.55–0.8, recompute normals.
- Triplanar PBR (`triplanarTexture` from `three/tsl`) — displaced blobs have no sane UVs; normal
  map applied as world-locked additive detail over smooth vertex normals.
- `shadowSide = BackSide` on closed smooth rocks — kills terminator acne without raising global
  normalBias (which "eats grass-blade shadows").
- Seating: `seatHeight()` samples the **lowest of 5 footprint points** so downhill edges don't
  hover; scree sinks `-s*0.3` into the dirt.
- Scree: detail-1 welded icosahedron (detail-0 "reads as d20 dice"), 12k instances, rockness-gated
  (`rocknessAt < rng.range(0.4,0.7) → reject`), `castShadow = false` on pebbles.
- Re-expression: 3 boulder variants + 1 scree variant become palette entries in a new
  `rocks-gpu.js` (or a generalized `dressing-gpu.js`) on the plants-gpu spine.

**Foliage material polish (A, optional) — `src/core/leaf-cards.js` + `docs/foliage-materials.md`:**
per-instance `aThickness` (0.4–1) as *the* lever stopping identical backlit glow; dome normals
(`normalize(mix(normalView, transformNormalToView(domeWorld), 0.7))`); alpha-to-coverage **does not
reach three.js shadow maps** (issue #30462) — keep `alphaTest` on depth/shadow materials.

## 3. STUDY from fable5 (reimplement the laws)

**(A) Per-instance variation law** — the single most important import:
- `VegTypes.ts` `GrowthInstance { leanX, leanZ, bias, age }` — every instance gets structural
  uniqueness, not just transform jitter. For plants we take the cheap subset first: per-record
  `hue` (species `hueVar` swing), `dryness`, `age→scale/tint`; skeleton-reshaping lean/asymmetry is
  a tree-phase concern, not understory Phase 1.
- `GroundCover.ts` `grassPatch` parent-clump/child-blade sampling (`sqrt(rng)·radius` around clump
  centers) — structural clumping as the *default*, vs our opt-in noise knob. Reimplement inside
  `plants-placement.js` as a two-level draw (clump centers per chunk → children per clump), keeping
  record shape unchanged.
- `Understory.ts` shrub species (`BUSH_HAZEL`, `BUSH_PINKFLOWER`, `BUSH_JUNIPER`): shrubs =
  bush-tuned params on the shared grammar, incl. `blossom: {r,g,b, frac}` as a species field —
  the model for adding 2–3 shrub presets to `PLANT_PRESETS` (and/or a low-level `trees.js` preset)
  instead of a bespoke shrub engine. **World-placed in the demo — safe to borrow.**

**(B) Dressing-as-one-data-channel:** the demo's moss/lichen/dirt-streak/wet-margin shading across
rock, deadwood, and terrain all reads one baked per-vertex channel (`vdata.z` ≈ moss openness /
upness, + cavity/AO) through the same `smoothstep(moisture|upness) × noise × cavity` formula
(`RockBuilder.ts:8-9,229`, `VegMaterials.ts:125`, `TerrainMaterial.ts:183/205/277/294`). Reimplement
as **one shared TSL `Fn`** (e.g. `mossWeight(upness, moisture, cavity, noise)`) used by the Phase 2
terrain splat, Phase 3 rock material, and Phase 4 deadwood material — not three bespoke shaders.
**Gallery-only flags** (per `understory-dressing-comparison.md`): vine geometry and standalone
mushroom caps in `Dressing.ts` were never world-placed; the demo's own STATUS lists them as debt.
Do not treat them as proven primitives — if we place them, we're closing a gap the demo left open.

**(C/Host) `RockBuilder.ts`:** bake-time per-vertex channels (upness-derived moss openness +
cavity/AO) on displaced rock — combine with SeedThree's simpler geometry recipe: SeedThree gives
the WebGPU-ready material/geometry code, fable5 gives the *baked vertex-data channel* idea that
makes the dressing shader cheap.

**(C) `Deadfall.ts` decay law:**
- `buildLog(rng, decay)` — sagging 9-seg ground-hugging tube, `rotten` → cross-section
  `squish 0.72` + steeper taper (0.88 vs 0.94), both ends capped; decay writes `vdata.z` moss/rot
  weight **fresh 0.15 / mossy 0.8 / rotten 1.0** read by the deadwood material.
- `buildStump(rng)` — short vertical tube with root flare `{amp 0.85, height h*0.55, lobes 5,
  phase}`; `vdata.z = 0.5 + rng*0.3`.
- Snag = a *species preset* (`brokenTop 0.62`, `stubChance 0.28`, no foliage) on the normal tree
  grammar — for us, one more entry in the forest species table with leaves off, not a new asset.
- Placement (per comparison doc; `Scatter.ts` itself wasn't in the extraction): moisture → decay
  class, canopy proximity → occurrence weight, slope > 0.5 → reject logs. Shelf fungi ride logs via
  the decay system (**live**); standalone caps gallery-only (see B note).
- Litter "rings" are *emergent* from canopy-weighted debris density, not a per-trunk primitive —
  don't over-engineer a discrete ring.

## 4. BUILD greenfield (no adaptable source)

**True moss/lichen tint on OUR splat (Phase 2 core).** Neither source hands us this directly:
SeedThree's terrain has grass-vs-rock + brush only (no moss law); fable5's is TS and keyed to its
own moisture sim. Design sketch:
- Bake per-vertex `vec4 splatData` in `classifyMesh`'s existing vertex pass: `x` = primary layer
  weight ramp (replacing the hard 2-band slope pick with smoothsteps around 0.34/0.58), `y` =
  moisture (from a `moistureAt(x,z)` — humidity grid or proxy, see Open Questions), `z` = upness
  (`normalY`), `w` = free (cavity/AO later).
- One `MeshStandardNodeMaterial` for the terrain mesh: existing layer textures sampled per-pixel,
  weights = baked attributes sharpened by a noise brush (SeedThree `sharp()` pattern); moss =
  `smoothstep(moisture) × smoothstep(upness) × brushNoise` mixing a moss albedo/roughness tint
  into forest/taiga/swamp/rock layers; lichen = a second, sparser, higher-frequency speckle term
  gated to *exposed* rock (`upness` mid-range, low moisture), desaturated pale tint; wet-margin
  darkening near `seaLevel` by `smoothstep` of height above water.
- Fallback risk contained: keep the old multi-material path behind a flag until parity is proven.

**Fungi geometry (Phase 4).** `Dressing.ts` `buildMushroom` exists but is TS and gallery-only for
caps; treat as reference only. Sketch: lathed cap (8–12 segment dome, slight lip curl) + gill disk
(darker underside ring) + stem tube from `trees.js`'s ring emitter; shelf variant = half-cap with a
flat mounting chord, placed on log/stump surfaces at bake time (part of the deadfall variant
geometry, not separately scattered — that's how the demo keeps shelf fungi "live" cheaply).
Clustered placement: caps spawn in 2–6-count arcs around a clump center (same parent/child pattern
as plant clumping), gated hard on moisture + canopy.

**Deadfall geometry on our mesher (Phase 4).** New `deadfall.js`: `buildLog(opts)`/`buildStump(opts)`
using `trees.js`-style ring sweeps + fable5's decay parameter law, writing a moss/rot weight into
the **vertex color** channel our vegetation materials already use (`vertexColors: true`) rather
than a new `vdata` attribute — our plants/forest bake final colors at palette time, so decay tint
can be partially baked (cheap) with only the moisture-reactive part in the shader.

**Rock host subsystem (Phase 3).** No rock code exists anywhere in our tree. `rocks.js`
(geometry+material, SeedThree recipe + fable5 baked channels) + `rocks-placement.js` (records) +
instancing via a generalized dressing GPU host (see Phase 3).

---

## 5. Per-phase work orders

Shared conventions for all phases: snapshot per the versions/ backup convention before editing;
update the touched `docs/subsystems/*.md` and append to `agent_log.csv` per CLAUDE.md; bump `?v=`
cache-bust suffixes on behavior changes to lazily-imported modules; every new pure math law gets a
`test-*.mjs` Node twin; **import discipline** — `three/webgpu` + `three/tsl` only, never bare
`'three'` mixed in (SeedThree gotcha list; our files already alias `import * as THREE from 'three'`
via the importmap to the webgpu build — follow whatever the touched file already does, don't mix).

### Phase 1 — Plant variation + shrubs (A)

**Goal:** per-instance hue/dryness/age across all plants; 2–3 shrub/scrub species; default
structural clumping; plant wind.

**Files:**
- `plants-placement.js` (edit): roll `hue` (±species hueVar), `dryness` (SeedThree 22%-dry law),
  `age` (0.6–1, scales into `scale` + tint) per record; add parent-clump/child sampling (fable5
  `grassPatch` law) as the new default (`clusterStrength` default > 0), keeping `clusterStrength:0`
  byte-identical for old callers (existing test asserts this).
- `plants-gpu.js` (edit): write hue/dryness/age into `rec1.yzw` (free floats — no layout change);
  in `instanceNodes`, return a `tint` node = HSV-ish cheap mix (hue swing on vertex color, dryness
  desaturate-and-warm, age darken); `mat.colorNode = vertexColorNode.mul(tint)`; add wind offset to
  `positionNode` (adapt `wind.js` `grassWindPosition`, phase from `posRandFn`).
- `plants.js` (edit): add shrub presets — a sprig-clump geometry style (SeedThree `shrubGeometry`
  crossed quads, ground-up normals) as a new `style`, plus 1–2 twiggy shrubs via existing
  stem/leaf schema; register in `PLANT_PRESETS` + `PLANT_BIOME_TAGS`.
- `plant-viewer.html` (edit, small): expose new schema fields so shrubs are tunable.
- `test-plants-placement.mjs`, `test-plants-defaults.mjs` (extend); new `test-plant-variation.mjs`
  (tint law JS twin: deterministic, bounded, dry-roll rate ≈ p).
- `environment-viewer.html` (edit): sliders for variation strength / wind under the Plants header.

**References:** SeedThree `scrub.js` (tint law, sprig geometry, ground normals), `wind.js`;
fable5 `Understory.ts` (shrub species as data), `GroundCover.ts` `grassPatch` (clump law).

**Risks/gotchas:** tint math in `colorNode` must be pure expression nodes (no `If()` — use
`select()`/`mix()`); wind must go through `positionNode` *composed after* the existing instance
transform; vertex colors are sRGB-ish authored values — apply tint multiplicatively, don't re-bake
palettes per variant (defeats variant sharing); keep the placement RNG draw order appended, never
reordered (determinism note in `forest-placement.js` header) — draw new fields *after* the existing
species→seed→size→yaw sequence.

### Phase 2 — Moss/lichen terrain splat tint (B)

**Goal:** kill the 2-band hard swap; per-pixel moisture/upness-driven moss+lichen+wet-margin tint
on authored-map terrain via one TSL node material.

**Files:**
- `terrain-textures.js` (major edit): `classifyMesh` → `bakeSplatAttributes` (per-vertex
  `splatData` vec4 as sketched in §4; keep triangle-group path behind a `legacySplit` flag);
  new `buildTerrainSplatMaterial(layers, opts)` returning one `MeshStandardNodeMaterial`
  (SeedThree `terrain-material.js` structure: attribute weights, brush sharpening, layer mixing;
  our 13 layers → pack the 4–6 actually-used-per-map layers into a `DataArrayTexture`, `LinearFilter`,
  no mipmaps per the verified WebGPU bug, or start with ≤6 separate samplers if array packing
  slips).
- New `moss-tint.js` (or export from terrain-textures): the shared `mossWeight()` TSL `Fn` + a JS
  twin `moss-tint-ref.js` for Node tests (CPU/GPU twin convention).
- `terrain-loader.js` (edit): `moistureAt(x,z)` bilinear grid (from sidecar humidity if present,
  else proxy — see Open Questions).
- `environment-viewer.html` (edit): moss amount/tint sliders; wire new material path on map load.
- New `test-moss-tint.mjs` (weight law: monotone in moisture, gated by upness, bounded, zero in
  desert-dry input).

**References:** SeedThree `terrain-material.js` (the vehicle, incl. all its inline gotcha
comments); fable5 `TerrainMaterial.ts` laws via `understory-dressing-comparison.md` §2 (litter→moss
by moisture `:205`, lichen splotches `:183`, wet margin `:294` — gorge greening is stretch, skip).

**Risks/gotchas:** **no `If()` at material top level** (chained `select()`); DataArrayTexture
mip bug; sampler-count cap (16/stage) — count every texture the node material binds including
lighting/shadow/env; skip SPOM in the first pass (its `.level(0)`/`grad()` rules are where the
black-patch UB lives — only attempt after tint ships, citing the SeedThree march comments);
authored maps currently rely on per-triangle material groups for the layer-settings UI
(`updateTerrainTextureLayer`) — that UI must be rewired to uniforms on the one material; procedural
(CDLOD) terrain is out of scope this phase (it has its own TSL surface — note follow-up).

### Phase 3 — Rock/boulder + scree host (Host)

**Goal:** the missing dressing-host subsystem: 3-variant displaced boulders + dense scree,
GPU-instanced, moss/lichen-dressed via the Phase 2 shared `Fn`, with collision.

**Files:**
- New `rocks.js`: `buildRockGeometry(rng, {detail, squash})` (weld→plane-wave displace→normals;
  bake per-vertex upness/cavity into vertex color or a `vdata` attribute at build time — fable5
  channel idea), `createRockPalette({variants:3, screeVariant})`, `buildRockMaterial({textures})`
  (triplanar albedo/roughness/normal, `shadowSide: BackSide`, moss = `mossWeight(upness,
  moistureAt-baked-per-instance, cavity)` + lichen speckle + dirt streaks by `1-upness`).
- New `rocks-placement.js`: records `{x,y,z,scale,yaw,tiltX,tiltZ,variant,moisture}`; density from
  biome (`gravel`/`rock`/`windswept_hills` heavy, sprinkle elsewhere), slope-gated: boulders
  anywhere, scree where slope/rockness high (our proxy for `rocknessAt`: slope from
  `terrainNormalAt`/map normals + rock-biome mask); **lowest-of-5 footprint seating** via
  `heightAt`; scree sunk 30%.
- New `rocks-gpu.js` (or generalize `plants-gpu.js` into a shared `dressing-gpu.js` factory —
  preferred if the diff stays small): plants-gpu spine, per-variant caps (boulders ~256, scree
  ~16k with its own shorter cull radius), scree `castShadow=false`.
- `collision.js` consumers in `environment-viewer.html` (edit): register boulder/stump circles into
  the existing `createTrunkIndex` (works on both terrain modes; scree gets no collision).
- New `test-rocks-geometry.mjs` (welded/indexed, finite, normals unit, squash applied),
  `test-rocks-placement.mjs` (deterministic, slope gating, seating ≤ min footprint height).
- `docs/subsystems/`: new `rocks.md` (or fold into vegetation.md) + code-map entry per CLAUDE.md
  rule for new lazy-loaded module groups.

**References:** SeedThree `rocks.js` (whole recipe, incl. weld/shadowSide/seat/scree comments);
fable5 `RockBuilder.ts` (baked upness/cavity channel, `ROCK_PRESETS`), `VegMaterials.ts` rock
dressing laws via comparison doc.

**Risks/gotchas:** `triplanarTexture` binds 3 taps/map — sampler budget again; boulders must not
spawn under water or intersecting tree trunks (reject via `heightAt` vs `waterLevel` + trunk-index
query at placement); grass/plants should thin under boulders — cheapest fix is a rock record →
extra rejection circle fed into plant placement (optional, note as polish); indirect-draw scree at
16k instances is fine GPU-side but keep its cull radius ~40–60 m so overdraw of tiny stones never
shows in per-pass timings.

### Phase 4 — Fungi / deadfall (C)

**Goal:** logs (fresh/mossy/rotten) + stumps with root flare + snag trees + shelf fungi on logs +
clustered ground mushrooms, scattered by moisture/canopy/slope.

**Files:**
- New `deadfall.js`: `buildLog(opts)`/`buildStump(opts)` on `trees.js`-style ring sweeps with the
  fable5 decay law (sag, rotten squish 0.72, taper 0.88/0.94, flare `{amp,height,lobes}`); decay
  writes moss/rot weight into vertex color alpha-equivalent (or `vdata`); shelf-fungi half-caps
  attached at bake time on `mossy`/`rotten` variants; `buildMushroom(opts)` lathed cap+gills+stem;
  `createDeadfallPalette()` (logs 3 decay × 2 seeds, stumps ×2, mushrooms ×3).
- `trees.js`/families (edit, small): snag preset — foliage off, broken-top taper; add as an
  authored family entry so `buildSpeciesFromFamilies` + forest placement pick it up with biome
  tags/low density (dead trees for free through the existing forest pipeline — no new renderer).
- New `deadfall-placement.js`: extends the plants-placement pattern; moisture → decay-class pick,
  canopy proximity (nearest-tree query against forest placement records for the chunk — records
  are already on the CPU) → occurrence weight, slope>0.5 reject for logs; mushrooms cluster
  (parent/child) and gate hard on moisture×canopy.
- Render via the Phase 3 shared dressing-GPU host (new palette group); deadwood material = bark-ish
  standard node material + `mossWeight()` tint driven by the baked decay weight.
- Collision: stumps → trunk-index circles; logs → 2–3 circles along the axis (documented
  approximation); mushrooms none.
- New `test-deadfall-geometry.mjs` (decay monotonicity: rotten < mossy < fresh cross-section;
  finite/indexed), `test-deadfall-placement.mjs` (moisture→decay mapping, slope reject, canopy
  weighting, determinism).

**References:** fable5 `Deadfall.ts` (the decay law — reimplement, don't port TS),
`Dressing.ts` `buildMushroom` (reference only; caps were gallery-only — we are intentionally going
one step past the demo by world-placing them, keep counts modest), comparison doc §3 (litter ring
is emergent — skip a bespoke ring primitive); SeedThree `rocks.js` seating trick for logs on
slopes.

**Risks/gotchas:** logs on steep/curved ground will float or clip — seat at lowest footprint
sample and allow tilt to the terrain normal, and reject when slope>0.5 like the demo; canopy query
must not add an O(trees×deadfall) scan per rebuild — bucket forest records by chunk (they already
are) and query 3×3 neighborhoods; keep mushrooms out of the shadow pass; snag preset must not
disturb existing species RNG draw order (it enters via the authored-families table, which is safe).

---

## 6. Acceptance criteria

Framework: `threejs-aaa-graphics-builder` visual scorecard (0–3 per category), core rule "authored
forms → materials → lighting → effects; never fake AAA with glow". Score **active-play screenshots**
on the workshop map, and capture perf-HUD numbers after every phase (scorecard category 10 demands
renderer diagnostics after graphics changes — our HUD reports fps / frame-ms / triangles / draws /
instances / per-pass GPU ms and CSVs them).

Baseline (from the comparison docs' self-audit): #5 World ≈ 1–1.5 (understory sparse, ground
2-band), #6 Materials ≈ 1 (flat texture buckets, no per-instance variation), #10 evidence ≈ 2
(HUD exists).

**Perf guardrails (all phases, measured on the current dev machine at 1080p on the workshop map):**
- Frame time regression budget per phase: **≤ +1.0 ms** median frame-ms vs. the phase-start
  baseline CSV; any single new pass ≥ 0.5 ms GPU must be named in the HUD (own pass timing or
  folded into an existing labeled pass knowingly).
- Overdraw is the foliage bottleneck (SeedThree `foliage-materials.md`, verified): shrub sprig
  quads and mushroom caps must use `alphaTest`-style cutout or opaque geometry — **no additive/
  transparent-sorted foliage**; new vegetation classes each get a cull radius + dither fade like
  plants (no hard pop ring).
- Draw calls: each phase adds ≤ ~24 submitted draws at steady state (zero-instance gating stays in
  effect; `stats.draws` in the CSV proves it).
- Instance budgets: Phase 1 unchanged caps; Phase 3 scree ≤ 16k / boulders ≤ 512 total; Phase 4
  deadfall+fungi ≤ 1k. Triangle counter must not grow > ~15% per phase at the standard viewpoint.

**Phase 1 pass/fail:**
- PASS: 30+ plants of one species in one screenshot show visibly distinct hue/dryness (no two
  adjacent clones identical); shrub class present in forest-edge biomes; plants sway in wind;
  clumped distribution visible vs. old uniform scatter (A/B screenshots). `test-plants-*.mjs` all
  green incl. `clusterStrength:0` byte-parity. Scorecard: #5 +0.5, #6 → 2 for vegetation ("shared
  material roles… wear/noise" = the variation law).
- FAIL: variation only visible as scale; any new transparent-blend foliage; determinism tests red.

**Phase 2 pass/fail:**
- PASS: no visible hard triangle-boundary texture seams on a slope transition close-up (the
  defining current artifact); moss tint visibly follows valley/shore moisture and up-facing
  surfaces in forest/taiga/swamp; lichen speckle on exposed rock at close range; wet dark band at
  shorelines; sliders modulate live. `test-moss-tint.mjs` green. Scorecard: #6 → solid 2 for
  terrain, #5 +0.5.
- FAIL: moss as a uniform green wash (not gated by moisture×upness); sampler-cap crash on any map;
  frame-ms guardrail broken (this is a full-screen ground material — watch the opaque-pass GPU ms
  specifically).

**Phase 3 pass/fail:**
- PASS: boulders read as smooth authored silhouettes with texture-carried detail (no d20 facets, no
  UV smearing — triplanar); no floating boulder edges on slopes (walk the steepest scree field);
  scree visibly concentrates where rock biome/slope says; moss caps on boulder tops in wet biomes,
  dirt streaks on steep faces; player collides with boulders, not scree. Scorecard: #5 → 2 ("layered
  prop kit… scale cues" — boulders are the missing midground scale anchor).
- FAIL: rocks lit with facet normals; shadow acne or grass-shadow loss from a global bias change
  (use `shadowSide` instead); scree pass shows up > 0.5 ms GPU at default radius.

**Phase 4 pass/fail:**
- PASS: within a 30 m walk in a wet forest you encounter ≥ 1 log, 1 stump, and a mushroom cluster;
  the three decay states are distinguishable at 5 m (silhouette squish + moss coverage, not just
  tint); shelf fungi on mossy/rotten logs only; snags appear inside forests at low density; dry/
  steep biomes stay clean (gating provably works — screenshot desert + steep slope with zero
  deadfall). All new tests green. Scorecard: #5 → 2.5 ("dense authored detail"), #6 holds ≥ 2.
- FAIL: deadfall reads as scattered clones (decay states must vary per instance via seed variants +
  the shared tint law); logs floating/clipping on slopes; mushroom glow/emissive shortcuts (the
  "never fake with glow" rule).

**Overall gate after Phase 4:** scorecard categories #5 and #6 both ≥ 2 with before/after
screenshots and baseline/post CSV rows attached — the "Premium" bar for the two categories this
overhaul owns, with #10 at 3 (baseline/post metrics + budget notes are exactly what the CSVs give).

## 7. Open questions / decisions for the human

1. ~~**Moisture source.**~~ **RESOLVED (human, imported-worlds scope): proxy only** — biome→
   moisture table + height-above-sea + water-distance falloff at load; no humidity-grid re-export
   this overhaul.
1b. **Rock/mushroom authoring viewer (new, from scope review).** Rocks (Phase 3) and mushrooms
   (Phase 4) have no viewer. Add a small dressing-viewer (clone `plant-viewer.html`) so they're
   tunable, or author in-world only? Snags/logs are already viewable via tree-viewer (they ride
   `trees.js`). **Recommendation: in-world only for v1; add a dressing-viewer only if tuning proves
   painful.**
1c. **plant-viewer variation strip (new).** Add ~6-instance hue/dryness/age preview to
   `plant-viewer.html` so per-instance variation is authorable, or accept variation as world-only?
   **Recommendation: add the strip — it's ~20 lines and makes the Phase 1 tint law tunable.**
2. **Shrub/scrub texture cards.** SeedThree's sprig clumps rely on alpha-cut sprig card textures
   (with derived translucency maps). We have no such assets. Source them (CC0 e.g. ambientCG/
   Polyhaven-style), bake procedurally like `grass-textures.js` does for blades, or ship geometry-
   only textureless shrubs (matching our current textureless plants)? **Recommendation: procedural
   bake first (consistent with plants' no-asset look), assets later.**
3. **Rock PBR textures.** Phase 3 triplanar wants a rock albedo/normal/roughness set; we have a
   `textures/ground/rock` layer slot for terrain, but reusing terrain tiling textures on boulders
   may look samey. Reuse for v1, or budget a dedicated boulder set (+ which biomes get distinct
   rock types)?
4. ~~**Species counts & biome scope.**~~ **RESOLVED (human): no artificial type-count caps.** The
   number of distinct shrub / mushroom / boulder / log-decay / stump / snag **TYPES** is **fully
   data-driven and open-ended** — author as many as desired (2 or 20), the system scales with zero
   code changes (species/variants live in preset tables, never hardcoded counts or switch arms). Any
   "N types per biome" phrasing elsewhere in this doc is illustrative starter content, not a cap.
   **What STAYS is the per-frame INSTANCE budget** (scree ≤ 16k, boulders instance cap, deadfall+
   fungi instance cap, cull radii) — those are perf guardrails, independent of how many *types*
   exist. Starter content ships a handful of each so the pipeline is exercised end-to-end; the human
   grows the tables afterward. First-pass biome emphasis (wet forest/taiga/swamp/meadow/plains-edge;
   desert/snow deferred) is a placement-density default, not a type limit.
5. **`dressing-gpu.js` generalization.** Phase 3 prefers factoring `plants-gpu.js` into a shared
   parametric host (plants/rocks/deadfall all use it) vs. copying it twice. Factoring touches a
   working production file for zero visual gain — approve the refactor, or accept two near-clones?
6. **SPOM relief on the terrain** (SeedThree's showpiece): in or out of Phase 2 scope? It is the
   riskiest TSL item (march UB gotchas) with real GPU cost. **Recommendation: out; revisit after
   Phase 3 as a flag-gated experiment.**
7. **RNG debt.** Accept "keep mulberry32 everywhere existing, allow forked-stream RNG in new
   modules" (per §2), or schedule a coordinated swap + test-fixture regeneration later?
8. ~~**Procedural (CDLOD) terrain moss.**~~ **RESOLVED (human): out of scope — imported worlds
   only.**
