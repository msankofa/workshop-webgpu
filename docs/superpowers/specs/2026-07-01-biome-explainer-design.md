# Biome explainer — interactive HTML walkthrough of the biome system

## Purpose

There is no single place that shows how a biome gets assigned in the first place (an
external Python pipeline's seeded noise fields + a priority-ordered classifier) and how
`workshop-webgpu` then uses that assignment (ground texture, tree density, grass
density). `docs/subsystems/biomes.md` documents the consumption side in prose/tables;
this adds a standalone, visual, interactive page — `biome-explainer.html` — that lets
someone *see* both halves of the pipeline and play with the knobs, rather than read
about them. Companion to `code-map.html` (interactive) and `biomes.md` (reference), not
a replacement for either.

## Non-goals

- **Not a map authoring tool.** No editing, painting, or exporting map data — that's
  terrain-v3's job (`G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\`, a
  separate repo). This page only visualizes.
- **Not a full config surface.** terrain-v3's `Terrain2DConfig` has ~24 tunable fields;
  this page exposes 8 curated ones that best demonstrate the concept (see "Generation
  section" below). The rest stay fixed at `config.py`'s dataclass defaults.
- **Not bit-exact noise.** The ported value-noise generator uses a JS-native seeded PRNG,
  not numpy's PCG64 (`np.random.default_rng`). Same algorithm (lattice value noise +
  fBm octaves, fade-interpolated), different bit-for-bit output — a real terrain-v3
  export with the same seed will look similar in character, not pixel-identical. The
  page says this explicitly near the seed control.
- **Not a full texture-override reproduction for the real map.** `terrain-textures.js`'s
  slope/sea-level texture overrides need real mesh normals/heights, which
  `test_export-data.json` doesn't carry standalone (heights are baked into the GLTF
  mesh, not the JSON sidecar — see `deriveTopSurfaceHeights` in `terrain-loader.js`).
  The real-map viewer shows the **biome fallback texture only** (`BIOME_MATERIAL[biome]`
  before slope/sea-level override), with a one-line note that the live game may show a
  different texture on steep/shoreline cells.
- No mobile/responsive layout pass — desktop-only, like `code-map.html`.

## Running

Same as the rest of `workshop-webgpu`: `python serve.py [port]`, then open
`http://127.0.0.1:8080/biome-explainer.html`. Required both because the page is an ES
module (`<script type="module">` importing `biome-classifier-js.js` fails over `file://`
in Chromium) and because the consumption section `fetch()`s the real
`maps/workshop/test_export-data.json`.

## Files

| File | Role |
|---|---|
| `biome-explainer.html` | The page: layout, styling, canvas rendering, UI controls, wiring. |
| `biome-classifier-js.js` | New module: ported noise/height/classifier math (below). A "CPU/GPU math twin" in the same spirit as `forest-cull.js`/`light-cluster.js`/`post-grade.js` (see root `CLAUDE.md`) — a hand-synced reimplementation of external (here, Python) logic, not imported by production code, kept in sync manually if the Python source changes. |
| `test-biome-classifier-js.mjs` | New Node test for `biome-classifier-js.js` (see Testing). |

## Architecture

### `biome-classifier-js.js` — ported math

Line-for-line JS transcription of five terrain-v3 Python files
(`stages/noise_fields.py`, `stages/height_composer.py`, `stages/derived_maps.py`,
`stages/biome_classifier.py`, plus the relevant `config.py` defaults), operating on a
2D grid rather than numpy arrays (plain nested loops / typed arrays — the grid this page
generates is small, see below, so vectorization isn't needed for performance).

Exports:

- `BIOMES` (18-name array), `BIOME_INDEX` (name → id), `BIOME_COLORS` (name → `[r,g,b]`,
  copied verbatim from `biome_classifier.py`'s `BIOME_COLORS`) — the palette used
  everywhere on the page.
- `DEFAULT_CONFIG` — a plain object mirroring `Terrain2DConfig`'s dataclass defaults
  (`sea_level: 0`, `continentalness_period: 1180`, `deep_ocean_depth: -42`, etc. — full
  field list transcribed from `config.py`).
- `createFieldSampler(seed)` → `{ sample(channel, x, z, period, octaves) }`, a port of
  `_value_noise`/`_fbm`: fade-interpolated bilinear lattice value noise, summed over
  `octaves` at halving amplitude/doubling frequency, normalized the same way the Python
  does (`* 1.35` then clamp to `[-1, 1]`). The "lattice" is generated lazily per
  `(channel, period-octave)` combination from a seeded JS PRNG (mulberry32, seeded from
  `hashString(seed + channelOffset + octave*1299721)`) sized to cover the sampled
  coordinate range — same shape as the Python approach, different RNG (see Non-goals).
- `generateGrid(cfg, resolution)` → `{ height, slope, temp, humid, weird, biomeId }`,
  each a `Float32Array`/`Uint8Array` of length `resolution*resolution`. Runs the full
  mini-pipeline per cell: sample the 5 noise channels → `composeHeight` (port of
  `compose_height`: `np.interp` against the fixed `CONTINENT_X/Y` and `EROSION_X/Y`
  knots, rescaled by `cfg.deep_ocean_depth`/`far_inland_height`/`min_plains_amplitude`/
  `max_mountain_amplitude`, plus the peaks-and-valleys weirdness term) → central-difference
  slope (port of `build_derived_maps`'s gradient, using the grid's own cell spacing) →
  `beach_mask` (smoothstep port) → `classifyBiomeCell(...)` (below). `_rescale`'s
  dynamic `values.min()/max()` normalization for `base`/`amplitude` knots is computed
  once over the full generated grid, matching the Python's whole-array rescale.
- `classifyBiomeCell({ height, slope, temp, humid, weird, beachMask, seaLevel, cfg })` →
  `{ biome, ruleIndex }`. A literal transcription of `classify_biomes`'s ordered
  `ids[mask] = X` stack as sequential `if` overwrites on a single cell (last matching
  rule wins, exactly as the priority order in `biome_classifier.py`). Returns which rule
  index fired last (`ruleIndex`, `-1` meaning "no rule matched, stayed at the default
  `plains` fill" through `16`, the 17 explicit `ids[mask] = X` lines in source order)
  alongside the biome name — this is what lets the UI highlight the matching rule (or
  the "default" row) in the priority-stack panel for any cell (real map or generated
  map) without needing a second code path.

### `biome-explainer.html` — page structure

Distinct illustrated/explainer visual style (not `code-map.html`'s dark dev-tool
theme) — light-ish background, larger type, section-by-section scroll narrative rather
than a dense single-viewport tool. Sections top to bottom:

**1. Overview diagram.** A static SVG/HTML pipeline diagram: `noise fields` →
`height/slope/beach derivation` → `classify_biomes priority stack` → `biomeIds +
biomeNames in -data.json` → three arrows fanning out to `terrain-loader.js
(biomeAt/treeDensityAt)`, `terrain-textures.js (ground texture fallback)`,
`grass-compute.js (density gate)` / `forest-placement.js (density gate)`. Each box is a
short label + one-line description; no interactivity here, it's the map for the rest of
the page. Matches the two-part structure the user actually asked about (generation, then
consumption).

**2. Generation section — "Grow a map".** The `generateGrid` demo.

- Canvas (128×128 generated grid, rendered via `ImageData` — `BIOME_COLORS[biomeId]` per
  pixel — displayed scaled up to ~512×512 CSS px with `image-rendering: pixelated`).
- 8 curated controls, each a real `config.py` field at its real slider range/step
  (`FIELD_RANGES` in `config.py`): `seed` (0–99999, int, + "Randomize" button),
  `sea_level` (-120–120, step 1), `continentalness_period` (80–4000, step 4),
  `erosion_period` (80–4000, step 4), `temperature_period` (80–4000, step 4),
  `humidity_period` (80–4000, step 4), `forest_humidity_bias` (-1–1, step 0.01),
  `snow_height_start` (-40–240, step 1). All other `Terrain2DConfig` fields
  (`weirdness_period`, all 5 `*_octaves`, `deep_ocean_depth`, `far_inland_height`,
  `min/max_*_amplitude`, `beach_width`, `rock_slope_start/full`, `snow_height_full`,
  `world_x/world_z`) are fixed at their dataclass defaults — not exposed, to keep the
  control surface approachable. A caption notes the fixed set exists and points to
  `config.py` for the full list.
- Every slider input schedules a debounced (150ms) `generateGrid()` + redraw. 128×128 ×
  5 channels is cheap enough to recompute well within one frame.
- Hovering the canvas shows a tooltip with that cell's raw values (height, slope, temp,
  humid, weird, resulting biome name) **and** scrolls/highlights the matching row in the
  priority-stack panel (section 3) — this is what lets one hover both inspect a single
  cell (the "live single result" idea) and see the full generated map (the "mini-map"
  idea) from the same control, since `classifyBiomeCell` returns the fired rule index
  either way.

**3. Priority-stack panel.** An ordered list: one "default: plains (no rule matched)"
row followed by 17 rows, one per `ids[mask] = X` line in `classify_biomes`, showing each
rule's condition in plain language (e.g. "steep & high → stony_peaks (overrides
windswept_hills)") and its target biome's color swatch. The row matching the currently
hovered cell's `ruleIndex` (from section 2 or section 4, `-1` → the default row) gets
highlighted; otherwise all rows sit at rest. This is the section that makes "later rule
wins, it's a priority stack not a blend" concrete.

**4. Consumption section — "A real exported map".** The real-map viewer.

- On load, `fetch('maps/workshop/test_export-data.json')` (+ `maps/map-config.json` for
  the display name). Renders `biomeIds`/`biomeNames` as a canvas the same way as section
  2 (`BIOME_COLORS`), sized to the map's actual aspect ratio (`worldX`/`worldZ`, 2880×1248
  in the shipped file).
- Hovering a cell shows: biome name + color swatch, **grass density** (bilinear-sampled
  from the real `grassDensity` grid in the JSON — exact match to what
  `grass-compute.js` would sample), **tree density** (`TREE_DENSITY[biome]` — exact
  match, since this particular map ships no explicit `treeDensity` grid override), and
  **fallback ground texture** (`BIOME_MATERIAL[biome]` + its swatch, with the one-line
  slope/sea-level-override caveat from Non-goals).
- If the fetch fails (page opened without `python serve.py`, or file moved), the section
  shows an inline error state; the rest of the page (sections 1–3, which are pure
  client-side generation) still works.
- A small legend under the canvas lists which of the 18 biomes actually appear in this
  particular map (computed from the loaded `biomeIds`, matching what we found earlier:
  7 of 18 for the shipped `test_export`) vs. which are defined but unused here — ties
  back to the "different seed/config would surface the others" point from the
  conversation that prompted this page.

**5. Reference tables.** The two static lookup tables from `biomes.md`, always visible:
`BIOME_MATERIAL` (biome → texture layer, with `FALLBACK_COLORS` swatches from
`terrain-textures.js`) and `TREE_DENSITY` (biome → density number). Hovering a cell in
section 2 or 4 highlights the matching row here too, so all three interactive surfaces
(generated map, real map, tables) cross-highlight through the same biome name.

### Data flow summary

Sections 2 and 3 are 100% client-side (no fetch) and work the instant the module loads.
Section 4 requires the `fetch()` to succeed. Section 5's tables are static constants
copied from `terrain-loader.js`/`terrain-textures.js` (kept in sync manually, same
caveat as the `biome-classifier-js.js` twin). No section writes anything back to disk or
to the real map data — read-only throughout.

## Testing

`test-biome-classifier-js.mjs` (flat Node script, matching this repo's existing
`test-*.mjs` convention): imports `biome-classifier-js.js` and checks
`classifyBiomeCell` against a table of hand-traced fixture inputs (e.g. `height: -50 →
deep_ocean`, `height: 5, hot: true, dry: true → desert`, then the same inputs plus
`weird > 0.38 → badlands` to prove the override, `steep: true` on a land cell alone →
`windswept_hills` regardless of temp/humid, etc.) — each fixture's expected biome is
derived by manually tracing `biome_classifier.py`'s rule order for that input, not by
invoking Python (no Python interop in this repo's test suite). Also checks
`generateGrid` is deterministic for a fixed seed (two calls with the same `cfg`/seed
produce identical output) and that changing only `seed` changes the output. This proves
the JS transcription is internally consistent and matches the *documented* rule
semantics; it does not (and per Non-goals, cannot cheaply) prove bit-parity with a real
Python run.

No test for `biome-explainer.html` itself (a visual page, same rationale as
`tree-viewer.html`'s spec) — verification is manual: load the page, confirm sections 2/3
cross-highlight on hover, confirm section 4 loads the real map and cross-highlights
sections 4/5, confirm section 4's error state when `maps/workshop/test_export-data.json`
is unreachable (e.g. temporarily rename it).

## Docs / logging

- Add a link to `biome-explainer.html` from `docs/subsystems/biomes.md` (short note near
  the top, same pattern as the cross-links already added to `terrain.md`/`vegetation.md`
  pointing *at* `biomes.md`).
- Add a link to `biome-explainer.html` in `code-map.html`'s sidebar. Not a `DOC_LIST`
  row as-is — `DOC_LIST`'s render loop (`code-map.html` ~line 675-683) hardcodes
  `a.href = \`docs/subsystems/${file}\`` and a `GROUPS[group].color` dot, which assumes
  every entry is a subsystem doc; `biome-explainer.html` lives at the repo root and
  isn't a subsystem doc. Add a small separate `TOOL_LINKS = [['biome-explainer.html',
  'Biome explainer']]` array rendered into its own one-line list right above or below
  the `#doc-links` sidebar (plain `a.href = file`, no `docs/subsystems/` prefix, no
  group-color dot needed) — same file, new tiny loop, not a change to `DOC_LIST`'s
  existing per-subsystem semantics.
- One `agent_log.csv` row, subsystem `terrain` (or `multi`, since it touches vegetation
  too), listing `biome-explainer.html`, `biome-classifier-js.js`,
  `test-biome-classifier-js.mjs`, and the doc files touched.
