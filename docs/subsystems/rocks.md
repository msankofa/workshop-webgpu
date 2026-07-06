# Rocks / Scree Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#rocks)
> Understory overhaul Phase 3 (merged-plan row #7): the missing dressing-host subsystem for
> displaced boulders + dense scree, dressed via the shared moss/lichen law, GPU-instanced.
> See `docs/understory-overhaul-plan.md` §Phase 3 and
> `research/terrain-appearance-analysis/MERGED-TERRAIN-UNDERSTORY-PLAN.md` row #7 for the
> governing spec this doc implements.

## Status

**Wired into `environment-viewer.html`** via the `DRESSING_MODE` block (URL flag `?dressing=`,
default `'gpu'`), sharing one `dressing-gpu.js` host with the deadfall/fungi subsystem — rock
variants and deadfall variants are both expanded into the same flat group list. See
"Integration" below for the exact wiring (it matches the recommended recipe). Placement binds to
`terrainHeight` + `loadedMap.surfaceField`; boulder/stump/log collision circles go into a
**separate** `dressingIndex` (`createTrunkIndex`) so they never clobber the tree `trunkIndex`,
and the player push-out resolves against both.

## Purpose

Adapts SeedThree's `src/core/rocks.js` recipe (weld → plane-wave displace → squash → smooth
normals; triplanar PBR; `shadowSide: BackSide`) and fable5's `RockBuilder.ts` idea of baking
per-vertex upness/cavity into a vertex attribute at build time, so the rock material's
moss/lichen dressing (the shared `mossWeight()` law from `moss-tint.js`, also used by the
terrain splat material and the future deadwood material) is a cheap attribute read instead of
a runtime concavity estimate. Placement is deterministic and slope/rockness-gated: boulders
scatter broadly across a map, scree concentrates on steep/rocky ground. Rendering goes through
a new generalized GPU instancing host (`dressing-gpu.js`) rather than forking
`plants-gpu.js`'s compute spine a second time.

## Files

| File | Responsibility |
|---|---|
| `rocks.js` | `buildRockGeometry(rng, opts)` — welded, plane-wave-displaced, squashed icosphere with baked `rockUpness`/`rockCavity` vertex attributes. `buildRockMaterial(opts)` — triplanar PBR + moss/lichen/dirt dressing. `createRockPalette(opts)` — data-driven palette of any number of rock types. |
| `rocks-placement.js` | `rockPlacementRecords(...)` — deterministic seeded placement records for boulders (scatter broadly) + scree (slope/rockness-gated), lowest-of-5-footprint seating, per-instance moisture. `boulderCirclesFromRecords(...)` — collision-circle export for `createTrunkIndex`. `rocknessOf(...)` — shared gating helper. |
| `dressing-gpu.js` | `createDressingGPU(opts)` — generalized reset→cull→finalize→indirect-draw instancing host with per-group instance caps/cull radii/shadow flags/materials. Factored out of (not edited into) `plants-gpu.js`'s spine; the intended shared host for rocks now and deadfall/fungi (Phase 4) later. |
| `test-rocks-geometry.mjs` | Welded→indexed, finite verts, unit normals, squash applied, baked upness/cavity in `[0,1]`, determinism, and `createRockPalette`'s data-driven type scaling. |
| `test-rocks-placement.mjs` | Determinism, record shape, slope/rockness gating (scree vs. flat/non-rocky ground), water rejection, lowest-of-5-footprint seating (cliff-straddling case), scree sink depth, optional `trunkQuery` rejection, `boulderCirclesFromRecords`, `rocknessOf`. |

## Public API

`rocks.js`
- `export function buildRockGeometry(rng, { detail = 1, squash })` — `rng` is a
  `forest-placement.js` `rngFrom(seed)` instance (`{ next(), range(a,b) }`, same RNG family as
  the rest of the placement stack). Weld (self-contained quantize-and-dedupe pass — see
  "Weld implementation" below) → displace by 4 random plane waves (smooth silhouette only,
  amplitude 0.05–0.13 each) → squash Y by `squash` (random in `[0.55, 0.8]` if omitted) →
  `computeVertexNormals()`. Bakes two extra per-vertex `Float32BufferAttribute`s, both in
  `[0, 1]`: `rockUpness` (pre-squash sphere-normal Y — "how up-facing was this point before we
  flattened the boulder", the fable5 `RockBuilder.ts` idea) and `rockCavity` (how far below the
  mean wave displacement a vertex sits — dips read as concave/sheltered).
- `export function buildRockMaterial({ textures = {}, moistureNode, normalBase, brushScale =
  0.6 })` — a `MeshStandardNodeMaterial` with `shadowSide = THREE.BackSide`. `textures:
  { albedo, normal, roughness }` (each an optional `THREE.Texture`) drive triplanar
  (`triplanarTexture` from `three/tsl`) albedo/roughness/normal at `scale = 0.35`; omitted
  textures fall back to a flat rock-grey albedo. `moistureNode` is a TSL float node for
  per-instance moisture — **the wiring layer must supply this** from the instance record (see
  "Integration"); it defaults to `float(DEFAULT_MOISTURE)` (from `moisture-proxy.js`) for
  standalone use/previews. `normalBase` is an **optional** TSL vec3 node — the instance-rotated
  world normal the dressing host builds (`nodes.nWorld`); when a normal texture is supplied the
  detail deviation is composed ON TOP of `normalBase` (so tilted/rotated instances keep both
  their detail map and their per-instance rotation) and `normalNode` is set. Omit it (standalone
  rock previews) and the detail is composed over view-space `normalView` instead. **The dressing
  host only assigns its own `nodes.nWorld` to `mat.normalNode` when the material left it unset**,
  so a normal-textured rock's world-locked detail normal is preserved, not clobbered.
  `normalStrength` (default **0.25**) scales the detail-normal deviation before it's composed over
  the base normal; keep it modest, because high-frequency triplanar normal detail shimmers/aliases
  on big, close boulders under any small camera motion (e.g. the player ground-spring micro-bob
  while standing still — the observed "texture jitters a few times a second" bug). `roughnessFloor`
  (default **0.92**) clamps the authored roughness texture high so tiny low-roughness flecks cannot
  become bright/dark sparkle on sky-facing tops. The wiring layer also sets `anisotropy` on the
  rock textures for the same reason. Dressing =
  `mossWeight(moistureNode,
  rockUpness, rockCavity, brushNoise)` (moss/lichen albedo mix + roughness bump) + a sparser
  higher-frequency lichen speckle gated to exposed rock (mid-high upness, low moisture) + dirt
  streaks by `1 - upness`. `brushNoise` and the lichen speckle are a cheap world-space hash
  (`hashNoise3`), not a texture tap, so the material stays at 3 samplers (triplanar) instead of
  4.
- `export const DEFAULT_ROCK_TYPES` — starter content: two boulder types + one scree type
  (`{ key, detail, squashRange, seedsPerType, scree }` each).
- `export function createRockPalette({ variants = DEFAULT_ROCK_TYPES, screeVariant,
  masterSeed = 1 })` — **fully data-driven, no hardcoded type-count cap.** `variants` is an
  array of type descriptors of ANY length: `{ key, detail = 1, squash (fixed) | squashRange
  [lo,hi] (random per baked geometry), seedsPerType (baked-geometry variety per type, default
  1), scree (bool) }`. `screeVariant` is a convenience shorthand marking a type as scree by key
  when its descriptor omits `scree`. Returns `{ variants: BufferGeometry[] (flat, baked once),
  types: [{ key, scree, startIdx, count }], masterSeed }` — `types[i].startIdx/.count` index
  into `variants` for that type's baked geometries.

`rocks-placement.js`
- `export function rocknessOf(materialWeights)` — sums the `'gravel'`/`'rock'` layer weights
  out of `surfaceField(x,z).materialWeights` (terrain-loader.js's top-4 feathered weights) —
  the `SurfaceField` proxy for SeedThree's `rocknessAt()`. Returns `0` for missing/malformed
  input.
- `export function rockPlacementRecords(chunks, params, heightAt, surfaceFieldAt, opts = {})`
  — `chunks` is the `forest-placement.js`-style chunk descriptor array
  (`{ key, xMin, zMin, size, ... }`). `heightAt(x,z)` is the canonical CPU height query
  (`terrainHeight` in `environment-viewer.html` — **not** mesh-anchored; see the R6 resolution
  in `docs/understory-overhaul-plan.md`). `surfaceFieldAt(x,z)` is `terrain-loader.js`'s
  `surfaceField` (optional; omitting it disables scree gating refinement and defaults
  per-instance moisture to `DEFAULT_MOISTURE` from `moisture-proxy.js`). `params`: `{ masterSeed, waterLevel = 0, rockTypeTable:
  [{ key, scree = false, density = 1, variantCount = 1, sizeRange = [lo,hi], footprintScale =
  0.8 }, ...] (open-ended, any length), boulderDensity = 0.0006 (per world-unit²),
  screeDensity = 0.03 (per world-unit², deliberately much higher), rockGateStart = 0.3,
  rockGateEnd = 0.6 (smoothstep ramp on `max(slope, rockness)` gating SCREE acceptance only —
  boulders scatter broadly and are rejected only by water/occupancy) }`. `opts.trunkQuery(x,z)
  => truthy if occupied` is **optional, not hard-wired** — when supplied, boulder candidates
  on occupied ground are rejected (for future trunk-collision integration); omit it and
  boulders place freely except under water. Boulders are rejected when
  `heightAt(x,z) < waterLevel`; scree is gated by `smoothstep(rockGateStart, rockGateEnd,
  max(slope, rockness))` where `slope = 1 - upness`. Both types seat at the lowest of 5
  footprint samples (center + 4 axis offsets, offset = `scale * footprintScale`) against
  `heightAt`; boulders sit slightly above that seat (`+ scale * rand(0, 0.2)`), scree sinks
  `- scale * 0.3` into the dirt. Returns, per rock: `{ x, y, z, scale, yaw, tiltX, tiltZ,
  variant, variantIdx, moisture, scree, chunkKey, slot }` — `variant` is the type's `key` (or
  numeric index if untagged), `variantIdx` selects among that type's `seedsPerType` baked
  geometries, `scree` is a boolean flag.
- `export function boulderCirclesFromRecords(records, radiusScale = 0.6)` — maps non-scree
  records to `{ x, z, r: scale * radiusScale }` circles, the exact shape
  `collision.js`'s `createTrunkIndex(chunkSize).setTrunks(key, circles)` expects. **Not wired**
  — see "Integration".

`dressing-gpu.js`
- `export function createDressingGPU({ renderer, camera, heightAt, groups })` — a generalized
  version of `plants-gpu.js`'s reset→cull→finalize→indirect-draw spine. Unlike `plants-gpu.js`
  (one global instance cap + one cull radius shared across every variant of one species
  table), each entry in `groups` is fully independent:
  `{ key, geometry (indexed BufferGeometry), cap = 256, cullRadius = 45, cullStart =
  0.7*cullRadius, castShadow = true, receiveShadow = true, buildMaterial(nodes) }`.
  `buildMaterial` receives `{ world, nWorld, yaw, tiltX, tiltZ, extra }` (vertex-stage TSL
  nodes for that group's current instance — `extra` is the instance record's 4th free float,
  meant to carry e.g. per-instance moisture into a material's `moistureNode`; `nWorld` is the
  instance-rotated world normal, meant to be composed under a material's own detail normals)
  and must return a `MeshStandardNodeMaterial`-family node material. `dressing-gpu.js` then
  assigns `mat.positionNode = nodes.world` unconditionally, but only assigns `mat.normalNode =
  nodes.nWorld` **when the material left `normalNode` unset** — a material that builds its own
  normal (e.g. `buildRockMaterial` composing triplanar detail over `nodes.nWorld`) keeps it,
  and is NOT clobbered. Geometry ownership: the host **clones** each group's `geometry`
  internally (instanceCount/indirect are written per group, so a shared geometry would corrupt
  siblings) and disposes those clones in `dispose()`; the caller still owns and disposes the
  originals it passed in. Instance records
  are `{ x, y?, z, scale, yaw = 0, tiltX = 0, tiltZ = 0, extra = 0, groupIdx }` fed via
  `setChunk(key, records)` / `clearChunk(key)` / `setChunks(batch, clearKeys)`, exactly like
  `plants-gpu.js`'s chunk API; `groupIdx` selects which of `opts.groups` an instance renders
  as — **palette-to-group variant selection (e.g. `rocks-placement.js`'s `variant`/`variantIdx`
  → a flat `groups` array index) is the placement/wiring layer's job, not this host's.**
  Returns `{ meshes, setChunk, clearChunk, setChunks, setGroupCull(radius, { start, filter }),
  update() (async, runs the compute passes), stats: { draws, groups, instances }, dispose() }`.
  `setGroupCull` retunes cull radius/start live (they're GPU uniforms, so no rebuild — just marks
  the host dirty so the next `update()` re-runs the cull compute). `filter(spec, groupIndex) =>
  bool` scopes it to a class of groups; the `environment-viewer.html` wiring tags each group with
  a `cullClass` (`'boulder'|'scree'|'deadwood'|'mushroom'`) and the range sliders filter on it.
- Position/normal transform: instances apply a 3-axis Euler rotation (X tilt → Z tilt → Y yaw,
  identical composition for position and normal) via plain trig — no TSL `mat3`/quaternion
  type is used anywhere in this codebase, so this stays consistent with that convention.
- `plants-gpu.js` is unedited. Migrating plants onto this host is a **separately-coordinated
  later step** (see `docs/understory-overhaul-plan.md` open question #5) — do not assume it
  has happened.

## Weld implementation (why not `three/addons`)

SeedThree's `rocks.js` uses `mergeVertices` from
`three/addons/utils/BufferGeometryUtils.js`. That resolves fine in the browser (the
`environment-viewer.html` importmap maps `three/addons/` to the jsdelivr CDN's `examples/jsm/`
tree), but this repo's local `three` npm devDependency ships that file **empty** (examples/jsm
isn't published to the npm package the way the browser CDN serves it), so a Node-testable
`rocks.js` cannot depend on it. `rocks.js` instead implements a small self-contained
quantize-and-dedupe weld (`weldGeometry`, not exported) directly in the file: round each vertex
position to 5 decimal places, dedupe by that key, rebuild the index. This has no three.js addon
dependency and runs identically in Node and the browser.

## Data-driven types (no caps)

Per the human-resolved open question in `docs/understory-overhaul-plan.md` §7 item 4: the
number of rock TYPES is fully data-driven. `createRockPalette`'s `variants` array and
`rockPlacementRecords`' `rockTypeTable` both accept any length with zero code changes —
`test-rocks-geometry.mjs` asserts this with a 5-entry custom type table. What DOES stay fixed
as a perf guardrail (independent of type count) is the **per-group instance cap and cull
radius** in `dressing-gpu.js`'s `groups` config (see "Integration" below for the recommended
starting numbers).

## Integration (DONE — `DRESSING_MODE` block in `environment-viewer.html`)

Rocks + deadfall now share one `dressing-gpu.js` host, built in the `DRESSING_MODE` block right
after the `PLANTS_MODE` block. The block mirrors the plants windowed-chunk streaming machinery
(`dressingChunksForPlacement`/`dressingWindowKey`/`processDressingBuildQueue`, budget
`DRESSING_BUILD_MAX_CHUNKS=2`) and monkeypatches `dressingGPU.update` to sync+drain the build
queue each frame, exactly like plants. `regenDressing` is called from
`maybeSyncTerrainDecorations` on terrain edits, and `dressingGPURef.update()` is awaited in
`animate()` under the `dressingGpu` frame-profiler phase. Notable wiring choices vs the original
recipe below: **boulders/scree are textured with the terrain's rock layer**
(`textures/ground/rock/{color,normal,roughness}.jpg`, triplanar — so the S1 detail normal is live),
logs/stumps sample the **same authored bark pack the forest uses** (`textures/bark/Bark014_1K-JPG`)
via `buildDeadwoodMaterial`'s `albedoMap`/`roughnessMap`, and collision uses a **separate
`dressingIndex`** rather than merging into the tree `trunkIndex`. The recipe as implemented:

1. **Build the palette once at load**: `const rockPalette = createRockPalette({ masterSeed });`
2. **Expand palette types into `dressing-gpu.js` groups**, one group per baked geometry
   (`rockPalette.variants[i]`), inheriting cap/cullRadius/castShadow from whether the owning
   type is scree:
   ```js
   const typeOf = (i) => rockPalette.types.find(t => i >= t.startIdx && i < t.startIdx + t.count);
   // The Phase 3 instance budget is a TOTAL per class (boulders ≤512, scree ≤16000), not
   // per group. A type expands to `seedsPerType` groups, so divide the class budget across
   // the number of groups that class expands to — otherwise N boulder groups × 256 blows the
   // 512 boulder budget.
   const boulderGroupCount = Math.max(1, rockPalette.variants.filter((_, i) => !typeOf(i).scree).length);
   const screeGroupCount   = Math.max(1, rockPalette.variants.filter((_, i) =>  typeOf(i).scree).length);
   const groups = rockPalette.variants.map((geometry, i) => {
     const type = typeOf(i);
     return {
       key: `${type.key}#${i - type.startIdx}`,
       geometry,
       cap: type.scree
         ? Math.floor(16000 / screeGroupCount)   // ≤16000 scree total across all scree groups
         : Math.floor(512 / boulderGroupCount),  // ≤512 boulders total across all boulder groups
       cullRadius: type.scree ? 50 : 140,       // scree stays short (40–60m) so overdraw of tiny stones never shows in per-pass GPU ms; boulders can see much further (midground scale anchors)
       castShadow: !type.scree,
       buildMaterial: (nodes) => buildRockMaterial({ textures: rockTextures, moistureNode: nodes.extra, normalBase: nodes.nWorld }),
     };
   });
   const dressing = createDressingGPU({ renderer, camera, heightAt: terrainHeight, groups });
   ```
3. **Placement**: call `rockPlacementRecords(chunks, params, terrainHeight, loadedMap.surfaceField)`
   per chunk (mirroring how `plants-placement.js`/`forest-placement.js` records feed their GPU
   hosts today), map each record's `{ variant, variantIdx }` to a flat `groupIdx` via
   `rockPalette.types` (`type.startIdx + variantIdx`), and set `extra = record.moisture` before
   calling `dressing.setChunk(chunk.key, records)`.
4. **Per-frame**: `await dressing.update()` alongside the other GPU dressing hosts; add
   `dressing.meshes` to the scene once (they self-gate visibility per group, same convention as
   `plants-gpu.js`).
5. **Collision** (done): a **separate** `dressingIndex = createTrunkIndex(mapChunkSize())` holds
   `boulderCirclesFromRecords(rockRecs)` merged with the deadfall stump/log circles, set per
   chunk key under `dressingIndex.setTrunks(chunk.key, circles)` and cleared on unload. The
   player push-out (`animate()`) resolves against `trunkIndex` (trees) **and** `dressingIndex`.
   A separate index (rather than merging boulder circles into the tree `trunkIndex`) avoids the
   per-chunk `setTrunks` clobber where a chunk with both trees and boulders would overwrite one
   set with the other. Scree is intentionally excluded (no collision) per the Phase 3 pass/fail
   criterion ("player collides with boulders, not scree").
6. **TODO**: migrate `plants.js`/`plants-gpu.js`/`plants-placement.js` onto `dressing-gpu.js`
   once this rock host is proven in production (separately-coordinated step, not assumed here).
7. **TODO**: add a rock/mushroom authoring dressing-viewer later (open question 1b in
   `docs/understory-overhaul-plan.md` recommends in-world-only tuning for v1; revisit if
   tuning proves painful).

## Perf notes (merged-plan §3 gates)

- Placement is chunk-local (one RNG stream per chunk, like every other placement file); gating
  is O(1) `surfaceField`/`heightAt` reads — no O(rocks × trees) or O(n²) scans anywhere in
  `rocks-placement.js`.
- `buildRockMaterial` binds 3 texture samplers (triplanar albedo/roughness/normal) — the
  moss/lichen "brush" and lichen speckle noise are a cheap analytic world-space hash
  (`hashNoise3`), not a 4th texture tap, keeping sampler count flat regardless of dressing
  complexity. This is a SEPARATE draw from the terrain material's own sampler budget.
  Opaque/cutout only — no transparent-sorted geometry anywhere in this subsystem.
  `shadowSide = BackSide` avoids raising the renderer's global `normalBias` (which would eat
  grass-blade shadows) to fix rock terminator acne.
  `dressing-gpu.js`'s per-group cull radius/cap split (short radius + `castShadow=false` for
  scree, longer radius + shadows for boulders) is the mechanism that keeps a 16k-instance
  scree field from ever showing up as >0.5ms in the per-pass GPU HUD at default settings — this
  is a design property of the host, verified once wiring lands and the perf HUD can be sampled
  live (the ≤ +1.0ms median frame-ms gate is a live-scene measurement, not something the Node
  tests in this change can assert).

## Tests

| Test file | Covers | What it checks |
|---|---|---|
| `test-rocks-geometry.mjs` | `buildRockGeometry`, `createRockPalette` | Weld produces an indexed geometry with fewer unique vertices than the raw non-indexed icosahedron (same triangle/index count); all positions finite; all normals unit length; `squash` measurably shrinks the Y extent relative to X/Z; `rockUpness`/`rockCavity` attributes exist, are bounded `[0,1]`, and vary across a boulder's surface; same-seed determinism (byte-identical positions and baked attributes); `createRockPalette` scales to an arbitrary (tested: 5-entry) type table with zero code changes, honors per-type `seedsPerType`, and the `screeVariant` shorthand. |
| `test-rocks-placement.mjs` | `rockPlacementRecords`, `boulderCirclesFromRecords`, `rocknessOf` | Determinism for the same seed/params; record shape (`x/y/z/scale/yaw/tiltX/tiltZ/moisture/variant/scree`); scree acceptance rises on steep/rocky ground vs. flat non-rocky ground (isolated boulder/scree density knobs); slope alone (no rock-layer weight) still raises the gate; total rejection when the chunk is fully submerged; lowest-of-5-footprint seating proven with a cliff-straddling case (a boulder whose footprint crosses a height step seats at the LOW side, not its own center height); scree sinks exactly `scale * 0.3` into flat ground; optional `trunkQuery` rejects every boulder when always-true and is a no-op when omitted; `boulderCirclesFromRecords` excludes scree and matches the non-scree record count; `rocknessOf` sums only `gravel`/`rock` layer weights and handles missing input. |

Both tests pass as of this writing (`node test-rocks-geometry.mjs`, `node
test-rocks-placement.mjs`).
