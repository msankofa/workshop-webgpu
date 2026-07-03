# Vegetation variety: grass blade fiber textures + procedural understory plants · Design Spec

**Date:** 2026-07-02
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped (design approved; not yet planned/implemented).

## Problem

Grass blades (`grass.js`/`grass-compute.js`) are flat-shaded — `colorNode` is a pure base→tip color
gradient multiplied by lighting and cloud shadow, with no texture at all. Up close, every blade looks
like a smooth plastic wedge. The ground floor also has exactly one non-tree, non-grass vegetation
type: nothing. `forest-gpu.js` covers trees; grass covers ground cover; there's no small-plant layer
in between (flowers, sprawling weeds, etc.) to break up the grass field.

## Goal

Two additions, shipped together as one "vegetation variety" pass:

1. **Grass blade fiber texture** — a small procedurally-synthesized texture (not a downloaded photo)
   applied per-blade, multiplying the existing base→tip color gradient. Five candidate styles, all
   shipped, selectable live via a UI dropdown (not just one baked-in choice).
2. **Procedural understory plants** — four specific real-world species (chickweed, cleavers, mint,
   jewelweed), each with distinct procedural geometry, GPU-instanced and placed among the grass,
   biome-gated the same way forest species are.

Both are visual-density features with no gameplay/simulation implications — no new physics, no new
collision, no interaction with `creature`/`multiplayer` systems.

## Approach chosen

For (1): bake all 5 fiber styles as small canvas textures at grass-module init, sample by style index
in the TSL color node, and expose a `setBladeStyle(key)` setter wired to a UI `<select>` — same
pattern already used for `texMode`/`postTone` in `environment-viewer.html`. Rejected: reusing an
ambientCG ground-grass photo (wrong content — top-down ground-scan texture, not blade-fiber detail;
ruled out earlier in this design process) and per-style separate materials (unnecessary — a single
shared material with a style uniform avoids material-switch overhead and keeps the live-swap cheap).

For (2): a new three-file module set (`plants.js`, `plants-placement.js`, `plants-gpu.js`) mirroring
the `trees.js`/`forest-placement.js`/`forest-gpu.js` split, but deliberately simpler: single LOD (no
distance banding beyond a single cull radius), no palette-variant baking step — geometry is built
once per species (not per-variant) since these are small enough that per-instance visual variety
comes from scale/yaw/color-jitter uniforms rather than distinct baked geometry. Rejected: extending
`forest-gpu.js` itself to also handle plants — trees and plants have different LOD needs (plants
never need a far LOD, they're culled entirely past a short radius) and different geometry-generation
shapes (branching skeleton vs. flat leaf/stem card), so a shared module would need type-branching
throughout; a separate lightweight module is cleaner and matches the "each subsystem is
independently loadable" convention this codebase already follows.

## Section 1 — Grass blade fiber textures

### What "5 styles" means

From the approved mockups (`grass-texture-mockup.html`), each style is a pure function
`fiber(u, v, seed) → multiplier` (plus an optional `tint(u, v, seed) → [0,1]` dryness/speckle amount)
evaluated over blade-local UV space (`u`: 0=left edge→1=right edge, `v`: 0=base→1=tip):

| Key | Label | Effect |
|---|---|---|
| `streaks` | Vertical fiber streaks | Thin sinusoidal ridge lines base→tip, subtle |
| `dryTip` | Fiber + dry tip browning | Streaks + tint blending to brown/yellow near tip |
| `mottle` | Soft mottle | Directionless low-contrast fbm blotches, cheapest-looking upgrade |
| `vein` | Center vein + banding | Bright midrib line + soft light/dark bands |
| `highContrast` | High-contrast dry fiber | Stronger streak contrast + brown speckle flecks + tint |

All 5 formulas are already written and validated visually in `grass-texture-mockup.html` — porting
means re-implementing the same `fiber()`/`tint()` math as canvas-bake generators (see below), not
redesigning them.

### Baking as textures, not procedural TSL noise

Rejected: computing `fiber()` per-fragment in the TSL shader graph (would need `fbm`/noise Fn
duplication of what `grass.js`'s existing `buildGrassNoiseFns()` cloud-shadow noise already does, and
5x that cost per style if not careful). Chosen: bake each style to a small `CanvasTexture` **once at
module init** (not per-frame, not per-blade) — cheap one-time cost, then just a texture sample per
fragment at runtime, consistent with the "image texture... if it won't slow things down" constraint.

- New module `grass-textures.js`, following the `tree-textures.js` canvas-bake precedent.
- Each style bakes to one small tile (e.g. 64×64 — large enough that a blade's UV span doesn't show
  visible texel stretching, small enough to bake instantly and cost nothing in VRAM). Two channels
  used: R = fiber multiplier (encoded 0..1, decoded to the ~0.55–1.35 range in-shader), G = tint
  amount 0..1 (0 for styles without a `tint()`).
- Export `createGrassTextures()` → `{ styles: { streaks: THREE.CanvasTexture, dryTip: ..., mottle:
  ..., vein: ..., highContrast: ... }, styleKeys: [...] }`. Textures use `RepeatWrapping` is NOT
  needed (one tile maps 1:1 to one blade's local UV, no tiling across a blade) — `ClampToEdgeWrapping`,
  `generateMipmaps: false` (blades are small enough on-screen that mip aliasing is a non-issue, and
  skipping mipmaps avoids the one-time generation cost for 5 tiny textures).

### New geometry attribute: per-blade local UV

`buildBladeGeometry()` in `grass.js` (the shared single-blade template imported by both `grass.js`
and `grass-compute.js`) currently has no local-UV attribute — its existing `uv` attribute encodes
world-field position for cloud-shadow noise, not blade-local texture coordinates. Add a new
`aBladeUV` vertex attribute to the 5-vertex blade template (`[BL, BR, TR, TL, TC]`):

```
BL: (0, 0)   BR: (1, 0)   TR: (0.75, 0.85)   TL: (0.25, 0.85)   TC: (0.5, 1)
```

This matches the `bladePath()` mapping already validated in the mockup (u across width, v base→tip,
mid vertices at v=0.85 not 1.0 to match the actual 5-vertex taper shape). Because both `grass.js` and
`grass-compute.js` instance the same shared template, this attribute automatically flows to both
grass modes — no separate implementation needed per mode.

### Shader wiring

In `buildMaterial(o)` (`grass.js`) and the equivalent in `grass-compute.js`:

- New `uBladeStyle = uniform(0)` (int index into the 5 styles) and a `textureNode` sampling the
  active style's baked tile at `aBladeUV`.
- `colorNode` becomes: `mix(uBaseColor, uTipColor, aWind).mul(fiberSample.r_remapped).mul(uAmbient.add(uKey)).mul(cloud)`,
  then for styles with tint: `mix(colorNode, dryColor, fiberSample.g * dryWeight)` where `dryColor` is
  a fixed brown constant (not user-configurable — matches the mockup's hardcoded dry-tint color).
- Style switch is a single value write to `uBladeStyle` — no shader recompile, no geometry rebuild.
  `Grass`/compute-grass class gets a new method `setBladeStyle(key)` that maps `key → index` and
  writes the uniform.

### UI wiring

`environment-viewer.html` grass slider blocks (CPU path ~line 2181, GPU path ~line 2231) get one new
control using the existing `select(key, label, opts, onChange)` helper (same pattern as `texMode` at
line 1739): `select('grassBladeStyle', 'Blade texture', ['streaks','dryTip','mottle','vein','highContrast'], () => grass.setBladeStyle(params.grassBladeStyle))`.
Default style: `streaks` (most neutral/subtle — matches existing look most closely, avoids a jarring
default change for anyone opening the viewer fresh). Persisted via the existing `controlRegistry`
save/load mechanism, no new persistence code needed.

### Cost

One-time: 5× 64×64 canvas draws at grass-module init (sub-millisecond, comparable to
`tree-textures.js`'s existing leaf-atlas bake). Per-frame: one extra texture sample per grass
fragment, same category of cost as the existing cloud-shadow noise sample already in the shader —
not expected to be measurable against current grass frame cost. No new draw calls, no geometry
change beyond the one new float2 attribute already present in every blade.

## Section 2 — Procedural understory plants

### Data model: parameterized, not bespoke-per-species (`tree-viewer.html` trajectory)

`trees.js` is not 4 hardcoded species functions — it's one `createTree(opts)` generator driven by a
`DEFAULTS`-shaped `opts` object, with species-like variety coming from different `opts` values. That
shape is what let `tree-viewer.html` (`docs/superpowers/specs/2026-06-30-tree-viewer-design.md`)
exist later as a thin standalone tool with zero changes to `trees.js` itself — it just exposes every
`opts` field as a slider/select. `plants.js` is deliberately built the same way from the start, so the
same kind of standalone tuning tool (leaf shape, leaflet count/parity, arrangement, serration,
variegation, color) is a later add-on, not a rewrite.

`plants.js` exports one schema, `PLANT_DEFAULTS`, and one generator, `buildPlantGeometry(opts)` (merges
`opts` over `PLANT_DEFAULTS`, same `merge()` deep-merge convention `trees.js` uses), instead of 4
separate draw functions:

```
PLANT_DEFAULTS = {
  seed: 1,
  stem: {
    nodes: 6,                 // node count along the main stem
    nodeSpacing: [8, 14],     // px-equivalent min/max gap between nodes
    height: [30, 60],
    branchProb: 0,            // 0 = single stem (chickweed/mint/jewelweed base), >0 = side branches
    sprawl: 0,                // 0 = upright, 1 = sprawling/prostrate (chickweed)
  },
  leaf: {
    shape: 'oval',            // 'oval' | 'lance' | 'star' — base card silhouette before serration/teeth are cut in
    style: 'simple',          // 'simple' = one leaf blade per node | 'complex' = compound, built from `leafletCount` leaflets
    leafletCount: 1,          // only meaningful when style === 'complex'
    leafletParity: 'odd',     // 'odd' = terminal leaflet (pinnate-odd) | 'even' = paired only, no terminal leaflet
    arrangement: 'opposite',  // 'alternate' | 'opposite' | 'whorl' — phyllotaxy along the stem
    whorlCount: 1,            // only meaningful when arrangement === 'whorl' (leaflets radiating from one node)
    serration: { teeth: 0, depth: 0 },   // teeth=0 → smooth margin; depth 0..1 → `jagDepth` from the mockups
    variegation: { enabled: false, pattern: 'edge', color: 0xffffff, amount: 0 }, // 'edge' | 'vein' | 'blotch'
    size: [10, 20],
    color: 0x3f6b2a,
    veinColor: null,          // null = no visible vein line; set to enable (mint/jewelweed midrib)
  },
  flower: {
    enabled: false,
    shape: 'star',            // 'star' | 'whorlBall' | 'pouch' | 'burPair'
    petals: 5,
    frequency: 1,             // fraction of eligible nodes that get a flower
    color: 0xf4f1e6,
    throatColor: null,        // pale "opening" patch, used by pouch shapes
  },
}
```

`buildPlantGeometry(opts)` returns a `THREE.BufferGeometry` with vertex colors baked in (side-lit
gradient per leaf/leaflet, matching the mockups' `leafGradient()` shading — flat single-color fills
were an explicitly rejected earlier iteration). `opts.seed` drives an internal `rng` for structural
jitter (node spacing, leaf angle, flower placement), mirroring `trees.js`'s seeded generation.

### The 4 species as presets

Each approved species (from `plant-species-mockup.html` / `plant-iterations-gallery.html` iteration 6)
is a named partial-`opts` override, `PLANT_PRESETS.<name>`, merged over `PLANT_DEFAULTS` — not a
distinct code path. This table doubles as the proof that the schema above actually covers all 4
approved designs:

| Preset | stem | leaf | flower |
|---|---|---|---|
| `chickweed` (*Stellaria media*) | `nodes: 6-8, sprawl: 1` (low sprawling strands from a shared root) | `shape: 'oval', style: 'simple', arrangement: 'opposite', serration.teeth: 0` | `shape: 'star', petals: 10, frequency: 0.25` (sparse, near tips only), `color: white` |
| `cleavers` (*Galium aparine*) | `nodes: 5` (widely spaced — leaflet length must stay under node spacing so whorls read as distinct, the key iteration-3 finding) | `style: 'complex', leafletCount: 7-8, arrangement: 'whorl', shape: 'lance', serration.teeth: 0` | `shape: 'burPair'`, terminal only, `color: green` |
| `mint` (*Mentha*) | `nodes: 7` | `shape: 'oval', style: 'simple', arrangement: 'opposite'` (decussate — alternating pair orientation is a stem-level rotation, not a new `arrangement` value), `serration: { teeth: 6, depth: 0.58 }`, `veinColor: set` | `shape: 'whorlBall'`, upper nodes only, bloom fullness increasing upward, `color: purple` |
| `jewelweed` (*Impatiens*) | `nodes: 8, branchProb: 0.3` | `shape: 'oval', style: 'simple', arrangement: 'alternate', serration: { teeth: 5, depth: 0.4 }` | `shape: 'pouch'`, drooping on thin pedicels, `color: orange/yellow`, `throatColor: pale` (elongated lip, not a round ball — the iteration-6 fix; hood capped on top with a visible mouth) |

`leafletParity` (even/odd) isn't exercised by any of the 4 launch presets — none of them are
even-pinnate compound leaves — but it's part of the schema from day one specifically so a future
preset (or a `plant-viewer.html` user) can select it; it's not dead scope, it's the same kind of
schema-completeness `trees.js`'s `DEFAULTS` already has fields not every built-in species varies.
Same reasoning for `variegation`: none of the 4 species use it, but the axis is real (some real-world
mint/jewelweed cultivars do have variegated leaves) and costs nothing to include in the schema now.

### Future trajectory: `plant-viewer.html` (not part of this implementation)

Not built as part of this spec — called out here only so `plants.js`'s data model doesn't accidentally
foreclose it. Once `PLANT_DEFAULTS`/`buildPlantGeometry(opts)` exist, a standalone `plant-viewer.html`
can follow the exact `tree-viewer.html` shape with no changes to `plants.js`: its own minimal scene
shell (renderer/camera/`OrbitControls`/lighting/flat ground, no placement/instancing/GPU-cull, Solo +
Grid view modes), a controls panel with one row per `PLANT_DEFAULTS` field (`select` for `shape`/
`style`/`arrangement`/`leafletParity`/flower `shape`, `slider` for counts/sizes/serration depth,
`colorInput` for the 4 color fields, `toggle` for `variegation.enabled`/`flower.enabled`), a preset
dropdown seeded from `PLANT_PRESETS`, and a "Copy plant JSON" export — all mechanical repeats of
patterns `tree-viewer.html` already established. This is future work, tracked as a follow-up, not
scheduled here.

### Instancing: baked-variant + storage-buffer pattern (mirrors `forest-gpu.js`, simplified)

- **Palette baked once at startup**: for each of the 4 `PLANT_PRESETS`, generate `VARIANTS_PER_SPECIES`
  (default 4 — plants are simpler than trees, less repetition risk per instance since they're
  ground-hugging and partly occluded by grass) fixed geometries by calling
  `buildPlantGeometry({ ...preset, seed: baseSeed + variantIdx })`, each with vertex colors baked in
  by the generator itself (side-lit gradient per leaf, per the data-model section above — no separate
  palette-side color-bake step is needed the way `forest-palette.js`'s `bakeFlatColor` is, since
  `plants.js` bakes its own gradient at build time).
- **Single global storage buffer per species-variant** for instance transforms (`x, y, z, scale,
  yaw`), uploaded on chunk load/unload only, never per-frame — same discipline as `forest-gpu.js`.
- **Single-LOD cull**: unlike forest's 4 LOD bands, plants use one compute cull pass (frustum +
  single distance radius, default short — e.g. 40-60m, tuned during implementation) → indirect draw.
  Past the cull radius, plants simply don't draw (no fade LOD mesh) since they're small enough that
  a hard cutoff is not visually jarring the way it would be for a tree.
- Total draws: `species(4) × variants(4)` = 16 indirect draws, flat regardless of instance count —
  same shape as forest's flat-draws property, just without the LOD multiplier.

### Placement: `plants-placement.js`, biome-gated

Mirrors `forest-placement.js`'s `placementRecords(chunks, params, heightAt, biomeAt)` shape:
`plantPlacementRecords(chunks, params, heightAt, biomeAt)` → per-plant `{x, z, scale, yaw, speciesIdx,
variantIdx}`. Reuses the same `rngFrom(seed)`/`hash2(ix, iz, seed)` deterministic-RNG helpers (either
imported from `forest-placement.js` if exported, or duplicated inline if not — small enough helpers
that duplication is acceptable to avoid coupling the two placement modules; decided during
implementation based on whether `forest-placement.js` exports them).

Biome gating: each species gets a biome-tag allowlist (e.g. chickweed/mint prefer damp/grassland
biomes, jewelweed prefers damp/streamside, cleavers is a generalist) consulted via the same
`biomeAt(x, z)` hook `forest-placement.js` already calls — no changes needed to `terrain-loader.js`'s
`biomeAt()` itself, just a new consumer. On non-authored-map paths where `biomeAt` isn't passed (see
`environment-viewer.html:932`'s forest call site), plants place unconditionally like forest currently
does in that path.

Density: independent of grass density and forest density — a new `plantDensity` param, default tuned
low (plants are accents, not a full ground-cover layer; the grass field remains the dominant ground
texture).

### Wiring in `environment-viewer.html`

New lazy import alongside the existing forest import, gated by a `PLANTS_MODE` flag following the
`GRASS_MODE`/`FOREST_MODE` convention (`?plants=gpu` default, no CPU fallback needed — there's no
existing CPU plants baseline to A/B against, unlike forest's `worker` mode which exists for
uniqueness comparison). New UI slider block: plant density, cull radius, per-species toggle
checkboxes (allow disabling individual species for testing/preference — matches the existing
per-feature toggle pattern used elsewhere in the control panel).

### Cost

Startup: `4 species × 4 variants` = 16 geometry generations (comparable to forest's baseline
palette-bake cost, smaller per-geometry since plants are simpler than trees). Per-frame: one cull
compute pass + 16 indirect draws, same shape as forest's GPU path, additive to forest's existing
cull+draw cost. No CPU per-frame cost beyond chunk-load-triggered buffer uploads (infrequent).

## Section 3 — Files touched / added

| File | Change |
|---|---|
| `grass-textures.js` | **new** — bakes 5 fiber-style canvas textures at init |
| `grass.js` | add `aBladeUV` attribute to `buildBladeGeometry()`; wire `uBladeStyle` uniform + texture sample into `colorNode`; add `setBladeStyle(key)` |
| `grass-compute.js` | same shader/uniform/setter changes as `grass.js` (shares `buildBladeGeometry()`, so only needs its own material/uniform wiring, not new geometry code) |
| `plants.js` | **new** — `PLANT_DEFAULTS` schema, `PLANT_PRESETS` (4 species), `buildPlantGeometry(opts)` generator |
| `plants-placement.js` | **new** — placement records, biome-gated, mirrors `forest-placement.js` |
| `plants-gpu.js` | **new** — storage-buffer instancing + single-LOD cull + indirect draw, mirrors `forest-gpu.js` |
| `environment-viewer.html` | new `select('grassBladeStyle', ...)` control in both grass UI blocks; new `PLANTS_MODE` lazy import + plants UI slider block |
| `docs/subsystems/vegetation.md` | add `plants.js`/`plants-placement.js`/`plants-gpu.js` rows to Files table; add Public API entries; add Tunable parameters entries; fix stale line counts already found for `forest-placement.js` (234, doc says 183) and `forest-palette.js` (86, doc says 84) while in the file |
| `agent_log.csv` | append rows for this change once implemented |

## Testing

Following the existing `node test-<name>.mjs` convention (flat, no framework):

- `test-grass-textures.mjs` — verifies each of the 5 style-bake functions produces the expected
  fiber-multiplier range and that `tint()` styles produce 0 at the base (v=0) and nonzero near the
  tip (v→1), catching regressions in the ported mockup math without needing a GPU.
- `test-plants-placement.mjs` — verifies `plantPlacementRecords` respects biome allowlists (a species
  with an empty allowlist at a given biome tag never places) and produces deterministic output for a
  fixed seed (same pattern as existing `test-forest-*` placement tests, to be confirmed by checking
  their exact names during implementation).
- `test-plants-geometry.mjs` — calls `buildPlantGeometry(opts)` across all 4 `PLANT_PRESETS` plus a
  handful of schema edge cases (`leaf.style: 'complex'` with `leafletParity: 'even'`, `arrangement:
  'whorl'`, `variegation.enabled: true`) and asserts a non-empty `BufferGeometry` with the expected
  attributes (`position`, `normal`, `color`) — a schema-coverage smoke test, not exhaustive shape
  verification (the mockups already did the shape verification visually for the 4 launch presets).

No changes to `creature`, `multiplayer`, `terrain`, `water`, `sky`, or `lighting` subsystems.

## Open items resolved during this design

- **Scope of species**: the earlier generic brainstorm list (flowers/ferns/clovers/dead sticks) is
  fully replaced by the 4 named species (chickweed/cleavers/mint/jewelweed) — all mockup iteration
  effort and approval concentrated on these 4, and they cover comparable visual variety (a spreading
  ground plant, a whorled climber, an upright serrated herb, a flowering herb) without needing a 5th
  generic category.
- **Texture reuse**: confirmed not reusing ambientCG ground-grass photos for blade fiber — those are
  top-down ground-material scans, wrong content for per-blade fiber detail. Confirmed via
  `terrain-textures.js` review earlier in this design process.
- **Customization trajectory**: `plants.js` is built around one parameterized `PLANT_DEFAULTS`/
  `buildPlantGeometry(opts)` generator with the 4 species as `PLANT_PRESETS` overrides, not 4 bespoke
  functions — specifically so a later `tree-viewer.html`-style standalone tool
  (`plant-viewer.html`, not part of this implementation) can expose leaf shape, complex/simple style,
  leaflet count/parity, alternate/opposite/whorl arrangement, serration, variegation, and colors as
  sliders/selects with zero rework of `plants.js` itself.
