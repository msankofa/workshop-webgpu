# Forest palette: bake in a worker, bake once and load many

Date: 2026-09-06. Status: shipped 2026-09-06 (commits 0f24963..), unseen in a browser; the tree-viewer pre-bake, family pre-bake in `bake-palettes.mjs` and the environment viewer's cache tier are not built yet (see steps 4-6).

Tree generation in Base Game runs on the main thread: `base-game-forest.js:456` awaits
`createForestPaletteAsync`, which runs `createTree()` for every species × variant with an
`await yieldFn()` between variants so the frame loop gets a turn. That interleaves the bake with
rendering; it does not move it off the thread or make it shorter. This plan does both: the bake runs
in a module Web Worker, and a species' baked palette is written to disk once so the games load
typed arrays instead of regenerating.

## Goal and constraints

- Enabling trees, changing a tree setting that rebakes, or streaming in a new family costs the main
  thread only the time to wrap typed arrays in `BufferGeometry`s and upload — no `createTree` on the
  render thread, ever.
- A species that has been baked before (same opts, same palette params, same texture mode, same
  `trees.js` version) is not generated again on any page: it is fetched as one binary file.
- Determinism holds: a worker bake and a main-thread bake of the same inputs produce identical
  arrays, and a loaded bake is byte-identical to a fresh one. `test-forest-palette-startup.mjs`
  already asserts "byte-identical palette" across the wave/async paths; the same assertion gates
  the worker and the cache.
- The cache lives on disk in the repo (`serve.py` route), never only in IndexedDB or `localStorage`
  — the same rule as every other authored artefact here. IndexedDB may hold a per-browser copy for
  pages served without the Python server, as the fallback tier `disk-store.js` describes.
- Hosts keep working without a worker (opened over `file://`, or a browser that refuses module
  workers): the current main-thread path stays as the fallback, exactly as `terrain-system.js` falls
  back when `terrain-worker.js` cannot be created.

## Current state

- `forest-palette.js`: `createForestPalette` (sync) and `createForestPaletteAsync` (yields between
  variants, `onFamilyWave` publishes partial palettes so Base Game can show the first family early).
  Each variant is `{ branches, branchesLod1, branchesLod2, leaves, leavesMid, shadow, leavesCoarse }`
  of `BufferGeometry` with a baked flat `color` attribute.
- `base-game-forest.js`: startup stages (`baking geometry` → `finishing` → `complete`), per-wave
  publication into `forest-gpu.js`, `stats.paletteMs`, a `buildToken` that abandons stale bakes.
- `trees.js` is pure Three math plus `BufferGeometry` — no DOM, no renderer — so it already runs
  in Node (`test-trees-geometry.mjs`) and will run in a worker unchanged.
- Precedent: `terrain-worker.js` (module worker, jobs keyed by `key`/`epoch`, transferables via a
  helper) driven by a small round-robin pool in `terrain-system.js`.
- `serve.py` has POST routes for JSON documents (`/api/save-family` and others); none accepts a
  binary body yet.

## Design

### 1. Palette serialisation: one binary per species bake

New pure module `forest-palette-io.js`:

- `paletteKey({ opts, params, texMode, treesVersion })` → a stable hash string (SHA-1 via
  `crypto.subtle` in the browser, `node:crypto` in Node) over the canonical JSON of the species
  opts (map/normalMap stripped, as `snapshotOpts` does), the palette params that shape geometry
  (`branchLods`, `coarseLeafRatio`, `coarseLeafSizeMult`, `midLeafRatio`, `midLeafSizeMult`,
  `leafShadowPct`, `leafCount`/`leafSize` overrides), `variantsPerSpecies`, the texture mode (quad
  vs simple leaves), and `TREES_VERSION` — a constant exported from `trees.js` and bumped whenever
  generation changes (the 2026-09-05 rounding fix would have been such a bump).
- `serializePalette(variants)` → one `ArrayBuffer`: a small JSON header (key, variant count, per
  tier per variant the byte offsets and counts for position/normal/uv/color/index, index type) then
  the concatenated typed arrays, 4-byte aligned. `deserializePalette(buffer)` → the same variant
  objects with `BufferGeometry`s whose attributes are views into the buffer (no copy).
- Round trip is tested in Node against a fresh bake for byte equality of every attribute.

### 2. The worker

New `forest-palette-worker.js` (module worker):

- Job `{ jobType: 'bake', key, species, params, masterSeed, variantsPerSpecies, texMode }`. It runs
  the existing `bakeVariant` loop (refactored so `forest-palette.js` exports the per-variant step)
  and posts back either per variant (`{ key, variantIndex, buffer }`, so the family-wave publication
  keeps working) or one `serializePalette` buffer at the end — both as transferables.
- Job `{ jobType: 'cancel', key }` drops a bake in progress (the worker checks between variants),
  replacing `shouldContinue`.
- Texture-dependent leaf shape (`quad` vs `simple`) is decided from `texMode`, which is a string;
  the worker never sees a `THREE.Texture`. Materials are bound on the main thread as today.
- Main-thread side in `forest-palette.js`: `createForestPaletteWorker()` returns
  `{ bake(inputs, { onVariant }) → Promise<palette>, cancel(key), dispose() }` and falls back to the
  in-thread async bake when `new Worker` throws. One worker is enough (the bake is sequential by
  design so the RNG stream matches); a pool would only help with many families at once.

### 3. Bake once, load many

- The tree viewer becomes the compiler. Saving or keeping a species (and "Export family JSON")
  also bakes its palette for the standard param set of each host (`HOST_PRESETS` in
  `tree-lod-preview.js` already names both) in the worker and POSTs the binary to a new
  `serve.py` route `/api/save-palette?key=<hash>` → `families/palettes/<hash>.bin`, plus an entry in
  `families/palettes/manifest.json` (`key → { family, species, bytes, treesVersion }`). The manifest
  is what lets a person see what is baked and delete stale entries.
- Hosts: `base-game-forest.js` computes `paletteKey` per species, `fetch`es
  `/families/palettes/<hash>.bin` (a static GET; misses are 404s, cheap), deserialises hits on the
  main thread (microseconds), and sends only the misses to the worker. A miss's result is POSTed back
  to the route when the page is served by `serve.py`, so the second run of any species anywhere is a
  hit. `environment-viewer.html` and `bot-viewer-v3.html` use the same path.
- IndexedDB tier: hits and worker results are also stored under the same key so a page opened
  without the server (or the deployed relay build) still skips regeneration on its second run. The
  order is disk → IndexedDB → worker → main thread.
- Invalidation is by key: a changed species, param, texture mode or `TREES_VERSION` is a different
  file. Old files are never wrong, only unused; a `bake-palettes.mjs` script (Node, no GPU) rebuilds
  the manifest's entries for the current version and deletes the rest, and can pre-bake every family
  in `families/` in CI or before a deploy.
- Startup stages in Base Game gain `loading palette` (fetch + deserialise) before `baking geometry`,
  and `stats` splits `paletteMs` into `paletteLoadMs` / `paletteBakeMs` / `paletteHits`.

### 4. Placement in the worker (optional, same job shape)

`placementRecords` is pure and per chunk. A `{ jobType: 'place', chunks, params, ... }` job returns
records as a `Float32Array` (x, z, scale, yaw, speciesIdx per tree). Worth doing only if the chunk
rebuild timing the host already records shows placement on the profile; it is listed so the worker's
job protocol is designed for it from the start.

## Steps

- [x] 1. (2026-09-06) `TREES_VERSION` in `trees.js`; `forest-palette-io.js` key + serialise/deserialise;
  `test-forest-palette-io.mjs` (round trip byte-identical, key stable across property order, key
  changes with every input it should).
- [x] 2. (2026-09-06) Refactor `forest-palette.js` so the per-variant bake step is exported; keep both existing
  entry points passing `test-forest-palette-startup.mjs`.
- [x] 3. (2026-09-06) `forest-palette-worker.js` + `createForestPaletteWorker()` with fallback; Base Game and the
  environment viewer bake through it; `test-forest-palette-worker.mjs` runs the worker module's job
  handler in Node against the same inputs and asserts byte equality with the sync bake.
- [x] 4. (2026-09-06) `serve.py` `/api/save-palette` (binary body, key-named file, manifest update) and the
  static GET. The variant seed is now `PALETTE_SEED + s*977 + v*131` (user's call, 2026-09-06; `TREES_VERSION` 2),
  so the key has no world seed and a viewer pre-bake is possible; that pre-bake itself is still not built.
- [x] 5. (2026-09-06, Base Game; environment viewer bakes through the worker but does not cache yet) Host load path (disk → IndexedDB → worker → thread), stats split, startup stage; write-back
  of misses.
- [x] 6. (2026-09-06) `bake-palettes.mjs` prunes stale/orphan entries; pre-baking every family is now possible and not yet built.
- [x] 7. (2026-09-06, per step) Docs: `vegetation.md` (new modules, palette section), `infra.md` (`serve.py` route),
  `base-game.md` (startup stages, stats); `agent_log.csv` per step.

## Validation

- Headless: the three new tests plus `test-forest-palette-startup.mjs`, `test-base-game-forest.mjs`,
  `test-tree-lod-preview.mjs` unchanged and green.
- Browser: Base Game with trees enabled — first run shows `baking geometry` with the main thread
  free (the frame profiler's CPU pass times stay flat during the bake); second run shows
  `loading palette` only, `paletteHits` equal to the species count, `paletteBakeMs` 0. A species
  edited in the tree viewer and re-saved gets a new key and a new file; the old one stays until
  `bake-palettes.mjs` prunes it.
- Determinism: `_audit_trees.mjs`-style check that a loaded palette and a fresh bake hash the same.

## Open questions

- Should the bake key include the leaf atlas cell? It changes UVs, so yes — it is part of the
  species opts already (`leaves.atlas.cell`) and therefore in the key.
- Binary route body limit in `serve.py`: a 2-variant palette with authored leaves is a few MB;
  `SimpleHTTPRequestHandler` reads `Content-Length` bytes, so no limit issue, but the route should
  refuse anything without a valid header/key to keep the directory clean.
- Whether the deployed (Render) build ships pre-baked palettes in the image or bakes on first visit.
  Ship them: `bake-palettes.mjs` in the deploy step makes first visit a load, not a bake.
