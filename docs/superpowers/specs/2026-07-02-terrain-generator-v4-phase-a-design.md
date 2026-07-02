# Terrain generator v4 — Phase A: 2D pipeline

## Purpose

`terrain-v3` (`G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\`, a separate
Python/Flask repo) is the real terrain design tool — a preview-first cockpit with a 2D
procedural pipeline, paint-layer authoring, a density-field preview, and an interactive
Three.js heightfield viewport. `biome-explainer.html` (this repo) proved a lighter
pattern works well for exploring part of that pipeline in-browser: a single
self-contained, no-build HTML page with a narrative hero + panel-per-stage layout, a
hand-synced JS "math twin" of the Python logic, live sliders, and a canvas preview.

`terrain-generator-v4.html` extends that same pattern to (eventually) the *entire*
terrain-v3 pipeline, plus the marching-cubes/water/forest/export half that terrain-v3
itself never rebuilt (that logic still only exists in the older, still-in-production
`tools/terrain/generate_terrain.py`). This is too large for one implementation pass, so
it's split into five phases, each its own spec → plan → build cycle:

- **Phase A (this spec)** — 2D pipeline: noise fields → height composer → erosion
  simulation → derived masks → biome classification → material masks.
- **Phase B** — paint authoring (height/humidity-bias/temperature-bias/rock/snow/
  forest-density/biome-override layers, brush, undo/redo, save/load design JSON).
- **Phase C** — heightfield preview (direct 2D-height-grid → `BufferGeometry` mesh,
  Three.js viewport, no voxels).
- **Phase D** — density-field preview (3D voxel density derived from A+B's output,
  slice visualizations, voxel stats — a diagnostic for Phase E's marching cubes).
- **Phase E** — marching-cubes mesh + water sheet + forest/rock placement + GLB export,
  ported from `tools/terrain/generate_terrain.py` / `generate_forest.py` /
  `generate_rocks.py` (the older tool, since terrain-v3 itself never rebuilt this half).

C and D both depend only on A+B's output (they are siblings, not sequential to each
other); C is ordered before D because it's the simpler, more immediately useful "does my
terrain look right in 3D" check, while D is a diagnostic that mainly pays off once
Phase E exists.

## Non-goals (Phase A)

- **Not bit-exact with a real terrain-v3/Python run.** Same caveat as
  `biome-classifier-js.js`: JS-native seeded PRNG (mulberry32), not numpy's PCG64. Same
  algorithm, same character, different bits.
- **No paint authoring, no density field, no heightfield viewport, no marching
  cubes/water/forest/export.** Those are Phases B–E; Phase A's hero diagram shows them
  as dimmed/dashed "not yet built" pipe-boxes, not live sections.
- **No backend.** The full field schema (`FIELD_GROUPS`/`FIELD_RANGES`/`FIELD_LABELS`)
  is a hand-transcribed copy of `terrain_v3/config.py`, not fetched from a `/v3/schema`
  endpoint — kept in sync manually, same maintenance model as the existing
  `DEFAULT_CONFIG` twin.
- Desktop-only, no responsive/mobile layout pass (same as `biome-explainer.html` and
  `code-map.html`).

## Running

Same as the rest of `workshop-webgpu`: `python serve.py [port]`, then open
`http://127.0.0.1:8080/terrain-generator-v4.html`. Required for the same two reasons as
`biome-explainer.html`: it's an ES module page, and the "real exported map" section
`fetch()`s `maps/workshop/*-data.json`.

## Files

| File | Role |
|---|---|
| `terrain-generator-v4.html` | New page: layout, styling, canvas rendering, UI controls, wiring. |
| `terrain-generator-js.js` | New module: erosion simulation, remaining derived masks (sea/lake/mountain), material masks, and the full `config.py`-mirrored field schema. Imports shared math from `biome-classifier-js.js` rather than duplicating it. |
| `biome-classifier-js.js` | **Modified, additive only.** Widen the export surface (`interp1d`, `rescaleArray`, `peaksAndValleys`, `CONTINENT_X/Y`, `EROSION_X/Y`, `smoothstep`, `clamp01`) so `terrain-generator-js.js` can reuse them. No behavior change — `biome-explainer.html` is unaffected. |
| `test-terrain-generator-js.mjs` | New Node test for `terrain-generator-js.js` (see Testing). |

## Architecture

### Why extend `biome-classifier-js.js` instead of duplicating or folding in

Three options were considered:

1. **Reuse via export (chosen).** Widen `biome-classifier-js.js`'s exports (additive,
   zero behavior change), import the shared pieces into the new module, add Phase A's
   new stages on top. No duplication, `biome-explainer.html` stays exactly as it is.
2. **Duplicate the math** into a fully standalone `terrain-generator-js.js`. Rejected —
   this produces two hand-synced copies of the same noise/height math with nothing
   forcing anyone to notice drift, the exact risk the repo's own "CPU/GPU math twins"
   convention (root `CLAUDE.md`) warns about.
3. **Fold everything into `biome-classifier-js.js`** and repoint `biome-explainer.html`'s
   import at the merged file. Rejected — touches an already-working, separately-committed
   page for a change that isn't about it, and conflicts with keeping this a new file.

### `terrain-generator-js.js` — new pipeline stages

Ported from four more terrain-v3 Python files, in the order the real pipeline actually
runs them (`terrain_v3/pipeline.py`'s `run_preview_2d`):

- **`simulateErosion(heightMaps, cfg)`** — port of `stages/erosion_sim.py`.
  - `flowAccumulation(height)`: D8 steepest-descent receiver per cell (8 neighbor
    offsets, pick the lowest neighbor that's actually lower), then accumulate flow by
    visiting cells in descending height order (sort indices by `-height`, add each
    cell's accumulator into its receiver's) — a direct port of the Python's
    `np.argsort(-flat_height)` loop, using a plain JS array sort of indices. Returns raw
    accumulation plus a `log1p`-then-normalized `[0,1]` version.
  - Hydraulic incision/deposition: `slope`-gated `channel = flow^1.35` term subtracted
    (incision) / added back at low slope + high flow (deposition), scaled by
    `hydraulic_erosion_strength`.
  - Thermal relaxation: `thermal_erosion_iterations` passes of pairwise horizontal/
    vertical relaxation — for each adjacent cell pair, move material down-slope by half
    the excess over the talus angle (`thermal_talus_angle`), scaled by
    `thermal_erosion_strength`. A no-op when iterations=0 or strength=0 (test fixture).
  - Returns updated `target_height` plus `erosion_delta` (height − original) and
    `flow_accumulation` for preview panels.
- **`buildDerivedMaps(height, cfg, flowAccumulation)`** — port of `stages/derived_maps.py`.
  Extends the existing slope/beach-mask logic with:
  - `sea_mask` — `height <= sea_level`.
  - `lake_mask` — region-growing flood fill: seed cells are land, low-slope, high-flow
    local sinks (no lower neighbor); each iteration lets pooled water spread to
    neighboring land cells whose height is under the current waterline
    (`seed height + lake_bank_height`) and whose flow clears a lower secondary
    threshold, tracking the minimum waterline per pooled cell; stops when no cell
    changes or `lake_expand_iterations` is exhausted.
  - `beach_mask` — same smoothstep as before, now additionally multiplied by
    `(1 - lake_mask)` so lake shorelines don't also count as beach.
  - `mountain_mask` — smoothstep of height × smoothstep of slope (two independent
    gates, both must be high).
  - `rock_mask` / `snow_mask` — direct smoothstep of slope / height against the
    `rock_slope_start/full` and `snow_height_start/full` config fields (previously only
    computed inline for the biome classifier's `high`/`steep` checks; now exposed as
    standalone preview arrays too).
- **`buildMaterialMasks(fields, height, derived, biomeIds, cfg)`** — port of
  `stages/material_masks.py`. Combines `sea_mask`/`lake_mask` into a `water` mask, then
  derives `sand`/`rock`/`snow`/`dirt`/`forest`/`grass` weights (forest gated by biome id
  being one of forest/dark_forest/jungle/taiga/swamp; the rest by slope/height masks
  with mutual exclusion terms), and blends them into one material RGBA image via
  per-material flat colors — read-only relative to config (no new tunable fields; its
  only config dependency, `sea_level`, is already exposed in the World group).
- **Field schema** — `FIELD_GROUPS`, `FIELD_RANGES`, `FIELD_LABELS`, transcribed
  verbatim from `terrain_v3/config.py` (six groups: World, Noise Fields, Height
  Composer, Erosion Simulation, Hydrology, Derived Masks — ~40 fields total, versus the
  8 curated ones `biome-explainer.html` exposes today). `world_x`/`world_z`/
  `preview_resolution` are now live sliders (previously fixed constants) per the design
  discussion — real terrain-v3's own ranges apply (`preview_resolution`: 96–1024), with
  a v3-style warning banner above a practical smooth-dragging threshold (picked during
  implementation after a perf check, not silently capped).

### `terrain-generator-v4.html` — page structure

Same visual language as `biome-explainer.html` (paper/ink palette, hero + panel-card
narrative), sections now following the real pipeline order end to end:

**1. Hero / pipeline overview.** Diagram of the *entire* intended pipeline, Phases A–E,
matching terrain-v3.md's own design-idea diagram. Phase A's stages render as normal
pipe-boxes; Phases B–E render as dimmed/dashed pipe-boxes labeled "not yet built" — the
page is honest about what's interactive today.

**2. World & noise fields.** Sliders for the `World` + `Noise Fields` groups (seed,
world_x, world_z, preview_resolution, sea_level, 5×period, 5×octaves). Canvas + a
panel-select dropdown (continentalness / erosion / weirdness / temperature / humidity),
diverging colormap (blue → pale → orange, matching `color_maps.py`'s `diverging`),
hover tooltip with raw sampled values.

**3. Height composer.** Sliders for the `Height Composer` group (deep_ocean_depth,
far_inland_height, min_plains_amplitude, max_mountain_amplitude). Canvas of pre-erosion
target height, height colormap (sea-level-aware color stops, matching `color_maps.py`'s
`height_map`).

**4. Erosion & hydrology.** Sliders for `Erosion Simulation` + `Hydrology` groups.
Canvas + panel-select (erosion delta / flow accumulation / lake mask / eroded height).

**5. Derived masks.** Sliders for the `Derived Masks` group (beach_width,
rock_slope_start/full, snow_height_start/full, forest_humidity_bias). Canvas +
panel-select (slope / sea mask / beach mask / mountain mask).

**6. Biome classification.** Today's rule-list + generated-map section, unchanged in
content, now fed by the full Phase A pipeline's height/slope/temp/humid/weird/beachMask
instead of the simplified pre-erosion values.

**7. Material masks.** Read-only preview (no dedicated sliders) — canvas of the blended
material RGBA (grass/forest/dirt/sand/rock/snow/water) plus a swatch legend of
`MATERIAL_COLORS`.

**8. A real exported map.** Kept from `biome-explainer.html`, unchanged.

**9. Reference tables.** Kept from `biome-explainer.html`, unchanged.

Per-section UX conventions carried over from `biome-explainer.html` plus terrain-v3's
own authoring controls: debounced (150ms) live regen on any slider change, hover
tooltip with raw values, a per-section "Randomize" button, a per-section "Reset to
defaults" button, and one global "Randomize all" (mirroring v3's global randomize +
per-section randomize/reset pattern).

### Data flow

One shared `genConfig` object (the full ~40-field config) and one
`generateFullGrid(cfg, resolution)` function that runs the entire pipeline once per
regenerate — noise sampling → height composition → erosion → derived masks → biome
classification → material masks — and returns every intermediate typed array. Every
section's canvas reads from this single shared result object; no section recomputes
independently. Any slider change (in any section) mutates `genConfig` and calls one
debounced `scheduleRegenerate()`, which reruns `generateFullGrid` once and lets every
section redraw from the new result. This is what makes the sections actually build on
each other computationally, not just visually.

Section 8 (real exported map) and section 9 (reference tables) are unchanged from
`biome-explainer.html` — section 8 requires the `fetch()` to succeed, section 9 is
static constants. Read-only throughout; no section writes back to disk.

## Testing

`test-terrain-generator-js.mjs` (flat Node script, matching this repo's `test-*.mjs`
convention):

- **Determinism** — same seed + config → identical grid across two calls.
- **Flow accumulation invariants** — every cell's raw accumulation is ≥ 1 (itself);
  accumulation only ever flows from a cell to a strictly lower neighbor (never uphill,
  never to itself).
- **Lake mask correctness** — lake mask is never set on cells above sea level's
  complement conditions it shouldn't be (never on high-slope cells above
  `lake_max_slope`), and is empty when no sink cells clear the flow threshold.
- **Thermal relaxation no-op** — `thermal_erosion_iterations: 0` or
  `thermal_erosion_strength: 0` leaves height unchanged.
- **Regression guard** — with `hydraulic_erosion_strength: 0` and
  `thermal_erosion_iterations: 0`, Phase A's height output matches
  `biome-classifier-js.js`'s existing `generateGrid` height output bit-for-bit, proving
  the widened-export refactor didn't change existing behavior.

No test for `terrain-generator-v4.html` itself (a visual page, same rationale as
`biome-explainer.html`'s spec) — verification is manual: load the page, confirm each
section's sliders regenerate the shared grid and redraw, confirm section 6's
cross-highlight still works, confirm section 8's real-map loading and error state.

## Docs / logging

- Add a link to `terrain-generator-v4.html` from `docs/subsystems/biomes.md` (near the
  existing `biome-explainer.html` link).
- Add `['terrain-generator-v4.html', 'Terrain generator v4 (interactive)']` to
  `code-map.html`'s `TOOL_LINKS` array (~line 692).
- One `agent_log.csv` row, subsystem `terrain`, listing `terrain-generator-v4.html`,
  `terrain-generator-js.js`, `biome-classifier-js.js` (export widening),
  `test-terrain-generator-js.mjs`, and the doc files touched.
