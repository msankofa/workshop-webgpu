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

### Species and geometry

Four species, matching the approved iteration-6 mockups (`plant-species-mockup.html`,
`plant-iterations-gallery.html`). Each is a flat/near-flat procedural mesh (leaf and petal shapes as
tapered/toothed 2D-profile cards extruded to near-zero thickness or built as camera-independent
tri-fans, matching how `grass.js` blades and `trees.js` leaves are already built — not billboards),
built once per species as a fixed geometry (not per-instance-varied geometry):

- **Chickweed** (*Stellaria media*) — 6-8 sprawling low strands from a shared root, opposite oval
  leaf pairs, small 10-point white star flowers near strand tips only (sparse, not dominant).
- **Cleavers** (*Galium aparine*) — an upright stem with 5 widely-spaced whorl nodes (7-8 narrow
  leaflets radiating per node), leaflet length kept shorter than internode spacing so whorls stay
  visually distinct (not merged into a continuous fishbone — this was the key iteration finding),
  terminal cluster of paired round green burs.
- **Mint** (*Mentha*) — an upright stem with 7 nodes of decussate (alternating-orientation) opposite
  serrated leaf pairs, 6-tooth serration with real depth (`jagDepth` ~0.58 — enough to survive
  rendering at leaf scale, not so much it reads as holly), purple flower whorl balls at the upper
  nodes increasing in bloom fullness toward the top.
- **Jewelweed** (*Impatiens*) — a taller branching stem (8 nodes), alternate coarse-toothed leaves (5
  teeth, `jagDepth` ~0.4), drooping pouch-shaped orange/yellow flowers on thin pedicels — pouch lip
  drawn as an elongated shape (not a round ball), hood capped on top, pale throat/mouth patch so it
  reads as an open flower.

Per-species geometry lives in `plants.js`, one generator function per species
(`buildChickweed(rng)`, `buildCleavers(rng)`, `buildMint(rng)`, `buildJewelweed(rng)`), each returning
a `THREE.BufferGeometry` with vertex colors baked in (side-lit gradient per leaf, matching the
mockups' `leafGradient()` shading — flat single-color fills were an explicitly rejected earlier
iteration). `rng` seeds per-plant structural variation (node count jitter, leaf angle jitter, flower
count) at geometry-build time, mirroring `trees.js`'s seeded generation.

### Instancing: baked-variant + storage-buffer pattern (mirrors `forest-gpu.js`, simplified)

- **Palette baked once at startup**: for each of the 4 species, generate `VARIANTS_PER_SPECIES`
  (default 4 — plants are simpler than trees, less repetition risk per instance since they're
  ground-hugging and partly occluded by grass) fixed geometries via the species builders above, each
  with vertex colors baked (reusing `bakeFlatColor`-style per-vertex tinting from `forest-palette.js`
  if the color model fits, or inline gradient bake if not — decided during implementation, not a
  design fork).
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
| `plants.js` | **new** — 4 species geometry builders |
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
- Geometry generation (`plants.js` species builders) is visual/procedural, not meaningfully unit
  testable beyond "produces a non-empty BufferGeometry with expected attribute names" — a light
  smoke test, not exhaustive shape verification (the mockups already did the shape verification
  visually).

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
