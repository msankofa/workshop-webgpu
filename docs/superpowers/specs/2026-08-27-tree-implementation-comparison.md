# Trees: three working implementations, compared against the Base Game plan

Written 2026-08-27 as the input to a dedicated Base Game tree plan. Everything below was read out
of the files named; where a claim is inferred rather than read, it says so.

The question this answers: Base Game has **no tree code at all** (`grep -c "forest\|createTree"
base-game.html` → 0). Three hosts already draw trees. Which parts of which one does Base Game
take, and where does the existing F6 phase of `2026-08-23-base-game-plants.md` get it wrong?

## The shared spine

All three hosts sit on the same four modules, and none of them forks it:

```
trees.js              recursive tube generator, CPU, 3 merged meshes (branches / leaves / shadow leaves)
forest-placement.js   pure placement: rngFrom/hash2/valueNoise, buildSpecies, placementRecords()
forest-palette.js     bake species x variants ONCE, flat-colour the vertices, hand back geometries
tree-presets.js       EZ_TREE_FAMILIES — six stock families (tree-viewer + bot-viewer only)
```

`environment-viewer.html` never imports `tree-presets.js`; it uses procedural `buildSpecies` and
nothing else. The first three are what all three hosts share.

`placementRecords(chunks, params, heightAt, biomeAt)` is the one entry point. It returns
`{x, z, scale, yaw, speciesIdx, chunkKey, slot}` per tree and consumes its RNG stream in a fixed
order (species → seed → size → yaw) so any two callers with the same params get the same forest.
That is the asset Base Game inherits for free, and it is why determinism across peers (F8) is
already nearly solved.

Everything above that line is where the three hosts diverge.

## A — `tree-viewer.html`: the authoring tool

**What it is.** One tree, every slider in `trees.js`'s DEFAULTS, plus a Species tab that groups
trees into *families*. A species is a full `trees.js` opts object plus placement metadata:
`{ biomes[], density, sizeRange, ageRange }`.

**What it gets right for Base Game.** Its `BIOME_NAMES` list (`tree-viewer.html:843`) is exactly
the eighteen names the streamed classifier produces — the same keys as
`terrain-biome-point.js`'s `BIOME_TREE_DENSITY` and `flora-field.js`'s `BIOME_GRASS`. An authored
species already speaks Base Game's biome vocabulary with no translation layer.

**Three problems, in order of how much they cost.**

1. **`localStorage` is the source of truth** (`tree-viewer.html:861,888`). This is the exact
   pattern `CLAUDE.md` forbids: origin-scoped, dies on a port change or a site-data clear, invisible
   to git. There *is* a disk path — a "save family JSON" button POSTs to `/api/save-family`, which
   writes `families/<slug>.json` and appends to `families/manifest.json` — but it is a manual export,
   not a save, and `families/manifest.json` is `[]`, so it has never been used. There is also **no
   `/api/list-families` route** (`serve.py` has list routes for states, music, bot-states, maze
   layouts, body tuning, maps and terrain bakes — not families), so nothing can read them back even
   if they were there.
2. **`ageRange` is authored and then dropped.** The Species tab has Age min/Age max sliders that
   persist (`tree-viewer.html:1127-1128`), but `buildSpeciesFromFamilies` carries only
   `{biomes, density, sizeRange}` into `_tag` (`forest-placement.js`). `applyAge` is imported by
   exactly two files: `tree-viewer.html` (the preview slider) and `test-tree-age.mjs`. No placement
   path has ever rolled an age. The generator support exists and is Node-tested; nothing consumes it.
3. The tool authors *appearance* well and *ecology* thinly. `density` is a scalar weight and
   `biomes[]` is a whitelist — there is no slope preference, no moisture preference, no
   altitude band, and no clumping character per species.

## B — `environment-viewer.html`: the only streaming host

**Shape.** `FOREST_MODE = 'gpu'` (default). Palette baked once → CPU `placementRecords` per chunk →
`forestGPU.setChunks(batch)` → a TSL compute chain (reset → cull → finalize) → per-variant indirect
draws. This is the renderer Base Game wants; almost none of the *host* around it is reusable.

**What is genuinely good, and should be taken as-is.**

- **The cull.** Distance, a horizontal FOV cone padded by canopy radius, and a hard far cutoff all
  run in one compute pass *before* any `atomicAdd`, so a rejected instance never claims a slot
  (`forest-gpu.js:130-200`).
- **Threshold-gated recull.** `update()` returns early unless the camera moved 1.5 m or turned 2°
  (`:432-433`). Without it the cull ran every walking frame.
- **Zero-instance variant gating.** A variant with no records anywhere hides all eight of its
  meshes, so `stats.draws` is `visibleVariants * 8`, not the fixed `V * 8`.
- **`setMaxDrawRadius`**, which is what stops LOD2 becoming an unbounded billboard population.

**Five things Base Game cannot inherit.**

1. **There is no chunk budget.** `maybeSyncTerrainDecorations()` → `regenTrees` →
   `regenerateGPU()` places **every** newly-entered chunk in one synchronous call
   (`environment-viewer.html:3554-3573`). It works there because the window is small; over an
   infinite world with a real draw radius it is a frame spike at every boundary crossing. Base Game
   already has the fix in hand — `flora-chunks.js`, extracted at F4, with per-frame chunk and
   millisecond budgets and readiness deferral.
2. **`rebuild()` is a full rescan and a full re-upload.** Any chunk mutation re-walks every
   resident chunk's records, calls `heightAt(x, z)` per tree, and sets `srcAttr.needsUpdate = true`
   on the entire `V * CAP * 8` float buffer (`forest-gpu.js:470-510`). At the env-viewer's own
   `capPerVariant: 2048` with twelve variants that is 786 KB re-uploaded on every crossing, and
   `heightAt` per tree per rebuild — which in Base Game would be a field-window sample, not a
   closed-form one.
3. **Per-variant capacity silently drops trees.** Slots past `CAP` are discarded with a single
   `console.warn` and then never warn again (`:509`). In a bounded viewer that is a tuning note;
   over an infinite world with a variable radius it is a forest that thins without saying so.
4. **No render-origin rebase, because env-viewer has no floating origin.** Records are written
   straight into the source buffer in world coordinates, and the cull compares them against
   `uCam` from `camera.position`. Base Game rebases at 8192 m. Nothing in `forest-gpu.js` knows
   about an origin.
5. **The palette is never disposed on rebake.** `rebuildForestGPU` builds a fresh
   `createForestPalette` every time the texture mode changes and calls `forestGPU.dispose()` — but
   `drawMesh` *clones* each geometry (`forest-gpu.js:269`), so `dispose()` frees the clones and the
   palette's own `branches/leaves/shadow/leavesCoarse` per variant are never freed.
   `bot-trees.js:230` has a `disposePalette()`; env-viewer does not. **How bad this is depends on
   the map**: a palette geometry only reaches the GPU through the billboard bake, which renders
   `variant.branches`/`variant.leaves` directly (`environment-viewer.html:3630`) and is gated on
   `loadedMap`. On procedural terrain the orphaned palette is collectable JS heap; on an authored
   map it is a real GPU leak.

**One finding worth stating plainly: LOD3 has never run on procedural terrain, and at default
settings neither has LOD1 or LOD2.**

`syncBillboards` returns early on `if (!forestGPU || !loadedMap)` (`environment-viewer.html:3730`)
— billboards are only baked for authored maps. On procedural terrain no atlas is ever applied, and
`billMat` is a `MeshBasicNodeMaterial` with no `colorNode` and `alphaTest: 0.5`
(`forest-gpu.js:366`, `:632`), so LOD3 would draw as opaque white cards.

It never shows, because procedural placement is bounded by the terrain window. The default
`renderRadius` is **2** (`terrain-system.js:19`), a half-extent of about ±75 m per axis and ~106 m
to a window corner — so at defaults **every tree is LOD0** and the ladder is entirely unexercised.
The draw-distance slider does reach 12 (`environment-viewer.html:4519`), a ±375 m half-extent and
~530 m to a corner, which does reach LOD1 (258–400 m) and LOD2 (400–583 m). Only **LOD3 (beyond
583 m) is unreachable procedurally**, which is exactly the rung with no bake path.

The white-card consequence is inferred from the material construction, not observed. The gate, the
radii and the LOD thresholds are read. Base Game is procedural and wants a draw radius in the
hundreds of metres, so it lands in the part of this ladder that has been exercised least and, at
LOD3, not at all.

## C — `bot-viewer-v3.html` (`bot-trees.js` + `bot-trees-place.js`)

**Shape.** A bounded arena, one `floraChunk`, one placement pass, plain `InstancedMesh` per
(variant × mesh type). No streaming, no compute cull, no LOD, no billboards. It is the *simplest*
host and, on several points, the most careful one.

**Five things it has that env-viewer does not, and Base Game needs.**

1. **Height in metres, not a multiplier.** It measures each baked species' real bounding box and
   scales to hit `settings.height` (`bot-trees.js:190-227`), because the stock presets range from
   19.7 to 96.2 units tall and one multiplier cannot serve both. It also records why a multiplier
   was a trap: with a family `speciesTable`, `sizeFor()` uses the species' own `sizeRange` and
   **ignores `maxSize`**, so a size knob routed through `maxSize` does nothing at all.
2. **Trunk collision, and the reason it must be proxies.** A rendered tree is 1,112–13,674
   triangles (measured 2026-08-15) and `createMapCollider` throws above 250k, so render geometry in
   the BVH caps the forest near **27 trees**. Each tree contributes one ~16-triangle cylinder to a
   detached `colliderRoot`. Base Game's plan says trunks do not collide in v1 — but this is the
   worked answer for when they do, and it is already written.
3. **Palette caching across rebuilds.** Baking all six families costs ~432 ms (measured), ten times
   a flora rebuild, so the palette is keyed and reused rather than rebaked when a wall moves.
4. **Density per 100 m², not an absolute count.** An absolute meant a different forest on every
   map size.
5. **`disposePalette()`** — the leak env-viewer still has.

**Three NaN traps it documents, all of which Base Game will hit.** These are in the comments at
`bot-trees.js:258-283` and they are not hypothetical:

- `waterLevel`/`shoreMargin` left undefined → `waterLevel + shoreMargin` is NaN → every
  `height >= NaN` is false → the forest comes out **silently empty**.
- `skew`/`varPattern` left undefined → `Math.exp(p.skew * 1.5)` is NaN → every scale is poisoned.
- `leafCount` passed as an absolute → `forest-palette.js` does `count = params.leafCount ??
  sp.leaves.count`, flattening every species to one leaf count. Pine's 21/30/18 and ash's 30/16/10
  all become the same number, which is most of what makes a pine read as a pine.

**What it cannot give Base Game:** anything about streaming, LOD, or scale. It draws one arena.

## Where the three disagree

| | tree-viewer | environment-viewer | bot-viewer-v3 |
|---|---|---|---|
| Species source | authored families (localStorage) | procedural `buildSpecies` only | authored families, falls back to `EZ_TREE_FAMILIES` |
| Placement | none (one tree) | `placementRecords` per terrain chunk | `placementRecords` over one arena chunk |
| Chunk lifecycle | — | terrain's own window, **unbudgeted** | none |
| Renderer | one `Tree` group | `forest-gpu.js`, 4 LODs, compute cull, indirect | `InstancedMesh` per variant |
| Size control | per-species `sizeRange` | `maxSize` multiplier | **measured metres** |
| Collision | — | trunk index (SP5b) | **trunk proxies + nav rects** |
| Palette disposal | — | **leaks** | `disposePalette()` |
| Age | authored + previewed | ignored | ignored |
| Persistence | localStorage | none | page state file |

The pattern: **env-viewer owns the renderer, bot-viewer owns the discipline, tree-viewer owns the
content and cannot deliver it.**

## Against the Base Game plan's F6

F6 (`2026-08-23-base-game-plants.md:332-357`) is fifteen lines. Measured against the three
implementations, it is right about most of the wiring and silent about most of the risk.

**What F6 already has right, and should keep.**

- Reuse `createForestPalette` + `forest-gpu.js` + `placementRecords` unchanged. Correct: all three
  hosts share them and they are host-agnostic.
- The facade seam is already built. `base-game-terrain.js` exposes `biomeAt`, `moistureAt`,
  `treeDensityAt`, `surfaceFieldAt` and `coverAt` (`:414-457`), and `flora-field.js` already derives
  a `coverTree` u8 channel per field texel at tile commit. F6's "dart-throw through
  `params.treeDensityAt`, veto through `coverAt`" needs no new module.
- A `flora-chunks.js` host per layer, budgeted and readiness-deferred. This is strictly better than
  what env-viewer does, and it exists.
- Records stored global, uploaded render-local, re-uploaded on rebase without redrawing RNG.
- Disposing the previous palette's geometries — F6 says `forest-gpu.js`'s own `dispose()` does not
  reach them. **Verified**: `drawMesh` clones, so `dispose()` frees clones only.

**Seven things F6 does not say, that the three implementations prove matter.**

1. **The billboard rung has no bake path on procedural terrain.** F6 lists `setRenderParts` for
   billboards as a control to reuse, and its stop gate says "record … billboards … independently".
   But `syncBillboards` is gated on `loadedMap`, the bake is 8 offscreen renders per variant into an
   IndexedDB cache, and none of it is in a reusable module — it is 150 lines inline in
   `environment-viewer.html:3575-3750`. Either Base Game ports that bake, or LOD3 must be disabled
   and `maxDrawRadius` clamped to `lodR2`. F6 chooses neither.
2. **`capPerVariant` is a hard, silent cliff.** F6 says "start with the smallest useful procedural
   species and variant count" but never sizes the buffer against radius × density × variants, and
   never says what happens when it overflows. The grass work just went through exactly this and
   ended with two visible budgets and a `truncating` stat; the forest has one invisible one.
3. **`rebuild()`'s cost is not in the plan's frame budget.** F6's stop gate asks for "chunk-boundary
   spikes", which would catch it — but the plan has no line saying the spike is a full-buffer
   re-upload plus one `heightAt` per resident tree, or that `heightAt` is now a streamed field
   sample rather than a closed-form call.
4. **Species are procedural only, and F6 accepts that** ("authored families are a follow-on that
   needs a `/api/list-families` route and a file loader — never localStorage"). That is the right
   call for ordering, but it means Base Game's first forest cannot use any of the six stock families
   that bot-viewer-v3 already renders. The gap is one `serve.py` route and one loader — smaller than
   the plan implies.
5. **Nothing normalises tree height.** F6 reuses `setTreeScale`, which is the multiplier bot-viewer
   explicitly rejected, and `sizeFor`'s `maxSize` path, which a species table ignores. Base Game
   will get trees whose absolute size depends on which preset won the species draw.
6. **The two gates throw away the information that matters.** `treeDensityAt` (facade) is
   `treeDensityForBiome(biomeAt(x,z))`; `coverTree` (streamed channel) is
   `treeDensityForBiome(biome) x groundWelcome x slopeGate x moistureFactor`. F6 dart-throws
   against the first and uses the second as a **veto at zero** ("vetoing what the splat weights say
   is bare"; the test line is "records never land where scalar tree cover is zero"). A binary veto
   does not double-count — where cover is non-zero the accepted density is just `treeDensityForBiome`
   — but it means slope, moisture and ground material **never modulate density at all**. The forest
   runs at full biome density right up to a cliff edge and then stops on a line, instead of thinning
   into it. Dart-throwing against `coverTree` directly, and dropping `treeDensityAt` from the path,
   gives the gradient for free and removes the redundant term.
7. **Age is never mentioned.** `tree-age.js` is pure, Node-tested, and authored per species. A
   per-instance age roll is one RNG draw and would give a forest saplings and mature trees instead
   of one size class per species. It cannot go in `placementRecords` for free, though — age changes
   the *geometry*, so it is a palette axis (age buckets × variants), not a per-instance transform.

**One thing F6 says that is wrong.** It says "LOD distances and `maxDrawRadius` derived from the
terrain's `farExtent`, not hardcoded." `farExtent` is the clipmap's `outerHalfExtent`, about
**6.1 km** at defaults (`terrain-clipmap.js:25`, `base-game-terrain.js:46`), and it is **0 when far
LOD is off** (`:745`). So the derivation fails in both directions: kilometre-scale LOD rings and an
unbounded billboard population with far LOD on — the exact failure `setMaxDrawRadius` was added to
stop — or a zero draw radius with it off. The tree draw radius has to be its own budgeted number,
bounded by the placement field's safe radius (960 m: 2048 m window, half-extent 1024, less the 64 m
the origin snap can move the centre) and by `capPerVariant`.

## What an adversarial review of this comparison added

Everything above was checked against source a second time. Four claims came back wrong and are
corrected in place (the palette-leak severity, the LOD-reachability span, the "double-counted biome
term", and the `farExtent` figure). Seven things were missing entirely, and they are the ones that
most change what a tree plan has to say.

1. **Shadows, which this comparison never mentioned, are the largest single gap.** Three separate
   problems. Base Game's directional shadow camera covers +/-90 m with far 260
   (`base-game.html:1938-1946`), so a forest at any real draw radius is mostly outside it. Leaf
   shadows exist **only at LOD0** (`shadowL0`, `forest-gpu.js:390-396`) — canopy shadows vanish at
   the first LOD ring. And the shadow pass draws the **same indirect buffers the camera-cone cull
   wrote**, so a tree the camera's FOV cone rejected casts no shadow either: at low sun, off-screen
   trees drop their shadows out of the frame, and shadows pop as the camera turns. That last one is
   structural to the one-survivor-list design and matters far more in a first-person game than in
   the sandbox viewer it was built for.
2. **`forest-gpu.js` trees do not move.** There is no time-based node anywhere in its material
   graph. Base Game's grass has wind, and static canopies over swaying grass read dead.
   `bot-trees.js:113-121` already has a TSL canopy sway, height-scaled so the trunk stays planted —
   this comparison enumerated bot-viewer's virtues and missed the one that is most directly
   portable.
3. **`treeCountForChunk` divides an absolute count by the resident window size**
   (`forest-placement.js:115-121`), and env-viewer feeds it the live window (`:3521-3524`). F8
   declares tree draw radius **local** per peer while placement inputs are shared — so two peers
   with different draw radii would place **different forests**, failing F8's own test. Per-100 m²
   density is therefore not bot-viewer "discipline" as this document framed it; it is a correctness
   prerequisite for multiplayer.
4. **The chunk window and the draw radius are never sized against each other.**
   `FLORA_CHUNK_DEFAULTS` is chunkSize 64 at radiusChunks 6 — a 416 m half-extent
   (`flora-chunks.js:16-18`), already smaller than the donor's `lodR2` of 583. Reaching the 960 m
   field radius at that chunk size needs radiusChunks 15, which is **961 resident chunks**, and the
   records map, the per-rebuild rescan and `capPerVariant` all scale with it.
5. **The LOD rungs are hard cuts with no hysteresis and changing materials.** LOD0 leaves are
   DoubleSide, LOD1 FrontSide (`forest-gpu.js:358-361`); leaf shadows disappear at the same cut.
   Billboards are unlit `MeshBasicNodeMaterial` with sun and ambient baked at fixed constants
   (`BAKE_SUN 1.2`, `BAKE_AMB 0.4`) and compensated by a single brightness uniform — under Base
   Game's day/night cycle LOD3 will not track the lighting at all.
6. **The streaming trunk-collision answer already exists, and this document pointed at the wrong
   donor.** It offered bot-viewer's BVH cylinder proxies as the worked answer, but that is a
   static-arena solution (`createMapCollider`, 250k triangle cap) that cannot stream. env-viewer has
   the streaming one: `createTrunkIndex` (`collision.js:77`) with per-chunk `setTrunks`/`clearTrunks`
   wired straight into `regenerateGPU` (`environment-viewer.html:3567`) — analytic cylinders keyed
   by chunk, which is exactly the shape an infinite world needs.
7. **Smaller slips.** The billboard bake is 8 renders per variant only in `8way` mode; the default
   `cross` mode bakes 1. The billboard atlas cache is IndexedDB, which is origin-scoped like
   localStorage — a port change means a cold cache and a visible "baking billboard atlases..." stall.

## Two things the live capture and the water path add

Neither is in any of the three donors, because none of them has a planar water mirror or a
performance log.

**The frame the forest has to fit into.** Base Game's latest capture
(`research/stats/base-game-performance-log.json`, 2026-08-26, 10 s, 641 samples): 64.1 fps
effective, 15.6 ms mean frame, **225 draw calls mean and 304 peak**, 381k triangles. The pass
breakdown is dominated by post (9.16 ms mean on mirror frames, 6.14 on plain) and the water reflect
pass (3.11 ms); terrain is 0.75 and grass is 0.054. A forest at eight draws per visible variant is
up to 96 draws on top of 225 — a 40% rise in draw calls before a single tree is culled. That, not
CPU time, is the number the plan has to budget against.

**The mirror re-renders the scene, and the forest cull is not mirror-aware.**
`base-game-water.js:59-71` hides a caller-supplied exclusion list and re-renders from a reflected
camera; grass is already in that list (`base-game.html:2003`). Two consequences. Trees left in the
mirror double the forest's draw cost on every reflect frame. And `forest-gpu.js` writes its indirect
instance counts from `uCam` — the **main** camera — including the forward-facing cone, so a coned
forest reflects the wrong trees entirely. Distance-only culling (`setConeEnabled(false)`) is
radially symmetric and reflects correctly; the cone is precisely what breaks it.

## What this implies for the dedicated plan

- Take the renderer whole from env-viewer, the host from `flora-chunks.js`, the streaming trunk
  index from `collision.js`, and from bot-viewer the metre heights, the palette disposal, the
  NaN-proof params, the canopy sway and the per-area density.
- Per-area density is not a nicety. It is what makes the forest the same on two peers.
- Treat `capPerVariant`, the draw radius and the chunk-window radius as one coupled budget with a
  visible stat, the way the grass buffer and dispatch budgets now are.
- Decide the billboard question explicitly rather than inheriting it: either port the bake and give
  it a day/night-aware material, or ship three LOD rungs and clamp `maxDrawRadius` to `lodR2`.
- Dart-throw against `coverTree` and drop `treeDensityAt` from the path, so slope and moisture
  thin the forest instead of only vetoing it.
- Add `setWorldOrigin`-equivalent rebase support to the forest the way it was added to grass.
- Decide the shadow story before the LOD story, because the LOD rungs are where shadows break.
- Decide the mirror story too: trees in the reflection cost a second forest and require the cone
  cull off.
- Authored families are a route and a loader away, not a phase away.
