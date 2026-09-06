# Forest placement rules and capacity: ecosystem placement, sized buffers, graceful degradation

Date: 2026-09-06. Status: planned, not started.

Items 7 and 8 of the 2026-09-06 review. Placement is a jittered pattern with a biome-weighted species
pick; capacity is a fixed `CAP` instances per variant that `console.warn`s and drops trees when
exceeded. Both are prototype seams. Grouped because they meet in the same place: how many trees a
chunk asks for, and what the renderer does when it cannot hold them.

## Goal and constraints

1. Trees stand where trees would grow — slope, altitude, moisture, canopy competition, clearings —
   and the rules are data a person can edit in the tree viewer's Species tab and the Base Game
   terrain, not code.
2. The renderer never silently drops a tree. Buffers are sized from the streaming window, and when
   the budget is genuinely exceeded the forest thins predictably (far first, small species first)
   and says so in the panel.

- Placement is CPU-side and deterministic per chunk (`placementRecords(chunks, params, heightAt,
  biomeAt)` in `forest-placement.js`, seeded from `masterSeed` and the chunk key). Every rule added
  must keep that: same inputs, same trees, so multiplayer hosts and guests agree and a tree does not
  move when its chunk is re-streamed.
- Species already carry authored `biomes`, `density`, `sizeRange`, `ageRange` from the tree
  viewer (`tree-families-store.js`). New rules extend that record; they do not invent a parallel one.
- The terrain field answers `heightAt`; slope and altitude derive from it. Moisture does not exist
  yet as a field in Base Game and must come from somewhere (open question).
- Capacity today: `CAP = opts.capPerVariant ?? 512` per variant, `SRC_TOTAL = V × CAP`, fixed at
  construction. `rebuild()` fills the source range per variant and warns once on overflow.

## Current state

- `placementsForChunk` picks `count` points per chunk with a pattern (`treeCountForChunk`,
  `sizeFor` with `varPattern`), then `placementRecords` draws species by biome filter and density
  weight, tree seed, scale, yaw — four RNG draws per tree in a fixed order that the palette baker
  depends on.
- No slope test: trees stand on cliffs. No altitude band: pines and oaks mix at every height unless
  biomes separate them. No spacing beyond the jitter pattern: two large trees can share a metre.
  No clearings except where the spawn building's collider removes them after the fact.
- `base-game-trees.js` sets per-hectare density and streams chunks; `base-game-forest.js` bakes
  the palette and pushes chunk batches into `forest-gpu.js`, whose `CAP` is a construction constant.

## Design

### Part A: placement rules

Add a rule pass between "candidate point" and "accepted tree" in `placementRecords`, driven by a
`rules` object on the species record and a `site` sampler the host supplies.

- `site = { heightAt, slopeAt, moistureAt?, clearingAt? }`. `slopeAt` is derived once from
  `heightAt` by central differences at 1 m (pure, in `forest-placement.js`). `clearingAt(x, z)`
  returns 0..1 (1 = keep clear) and is the union of the world plan's sites, roads and structures —
  Base Game already has `base-game-plan.js` sites and `base-game-trails.js`; the sampler reads them.
- Species rules (authored in the tree viewer Species tab, stored with the species, defaults chosen so
  existing families behave as today): `maxSlope` (degrees, default 90 = no limit), `altitude:
  [min, max]` (default unbounded), `moisture: [min, max]` (default unbounded), `spacing` (metres,
  minimum distance to another accepted tree of any species, default 0), `clearingTolerance` (0..1,
  how much clearing value still allows the tree, default 0 = respect all clearings).
- Rule pass per candidate: reject if slope > `maxSlope`, altitude out of band, moisture out of band,
  or `clearingAt > clearingTolerance`. Spacing uses a per-chunk grid hash of accepted trees plus the
  neighbouring chunks' accepted trees (they are deterministic, so recompute rather than store) —
  accept the larger tree when two conflict, so canopies compete the way they do in a wood.
- RNG discipline: the rule pass consumes **no** RNG draws; rejection happens after the four draws
  so the palette's seed alignment (`treeRng` second draw) is unchanged, and a rejected candidate
  simply does not emit. Density therefore drops where rules reject; `treeCountForChunk` may be
  scaled up by the chunk's historical acceptance ratio (a second deterministic pass) if a biome
  should stay as dense as authored.
- Canopy competition beyond spacing (shade-tolerant species under tall ones) is a later rule; the
  hook is the same pass.
- Tree viewer: the Species "Edit species" section gains these five fields; the Pokémon Park's
  biome painter already has the slope/altitude vocabulary and its UI can be borrowed.

### Part B: capacity sized from the window, thinning instead of dropping

- `createForestGPU` takes `capacity: { perVariant }` **or** `window: { chunks, treesPerChunkMax }`
  and derives `CAP = ceil(window.chunks × treesPerChunkMax / V × 1.25)`. `base-game-forest.js`
  knows both numbers (`expectedTreesPerChunk(perHectare, chunkSize)` exists in
  `base-game-trees.js`); it stops passing a magic 512.
- Resize: when the window or density changes so the derived `CAP` grows, the forest rebuilds its
  storage buffers (a full reconstruction of `createForestGPU`, which the palette rebake path already
  does; the cost is a hitch on a settings change, never in play).
- Over budget at runtime (a dense biome that beats the estimate): instead of dropping arbitrary
  trees per variant, `rebuild()` computes a per-chunk keep fraction so the total fits and thins each
  chunk by its own deterministic hash order — far chunks first, small species first (species
  `_tag.sizeRange` is known). The panel shows `thinnedInstances` and a per-variant fill percentage;
  the `console.warn` goes.
- Budget knob: `treeInstanceBudget` in the Base Game tree panel caps the live set below `CAP` on
  purpose (low settings), thinning the same way. Together with the LOD-quality plan's projected-size
  budget, this is the whole "graceful degradation" story: the LOD budget trades detail, this trades
  count, and both are gradual.

## Steps

- [ ] 1. `slopeAt` + rule pass in `forest-placement.js` with default rules that change nothing;
  `test-forest-placement-rules.mjs` (determinism under re-streaming, spacing accepts the larger tree,
  rejection consumes no RNG).
- [ ] 2. Species record fields + tree viewer Species tab fields; `tree-families-store.js`
  `validateFamily` accepts them; `buildSpeciesFromFamilies` passes them into `_tag`.
- [ ] 3. Base Game `site` sampler: slope from the terrain, `clearingAt` from plan sites, trails and
  the spawn building footprint; remove the after-the-fact collider culling where it becomes redundant.
- [ ] 4. Capacity derived from the window in `createForestGPU`; `base-game-forest.js` passes the
  window; reconstruction on growth.
- [ ] 5. Deterministic thinning in `rebuild()`; `thinnedInstances` and fill percentages in the
  panel; `treeInstanceBudget` knob.
- [ ] 6. Docs: `vegetation.md` (`forest-placement.js`, `forest-gpu.js` rows and sections),
  `base-game.md` panel rows, `tree-families-store.js` schema; `agent_log.csv`.

## Validation

- Headless: the placement rules test; `test-base-game-trees.mjs` extended with a steep synthetic
  terrain (no trees above `maxSlope`) and a clearing (no trees inside); a capacity test that a window
  of N chunks at the max density fits without thinning and one chunk over thins far chunks first.
- Browser: Base Game on a hilly seed — bare ridges, trees in the valleys, clear roads and sites;
  the panel's `thinnedInstances` stays 0 at default settings and rises predictably at 3× density.
- Perf: rule pass CPU ms per chunk in the existing chunk-rebuild timing (`placementRecords` is
  already timed by the host's telemetry).

## Open questions

- Moisture source: a cheap deterministic field (valley-ness from the height field, i.e. inverse of
  local height rank over a 50 m window) is enough to separate willows from pines and needs no new
  authoring; a painted layer from the terrain generator is the long-term answer. Start with the
  derived field.
- Spacing across chunk borders needs neighbour chunks' accepted trees; recomputing a one-chunk
  border ring is deterministic but doubles rule-pass work at edges. Acceptable; measure.
- Whether thinning should prefer removing whole variants (fewer draws) or spread across variants
  (preserves variety). Spread, unless the profile says draws dominate.
