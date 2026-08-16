# Trees in bot-viewer-v3

STATUS: shipped 2026-08-15. `tree-families-store.js`, `bot-trees-place.js` and `bot-trees.js`
built and Node-tested (130 assertions, mutation-checked), and wired into `bot-viewer-v3.html`
(rebuild stage, collider extraRoot, nav blockers, World > Trees panel, plant/erase tools, maze-slot
persistence). Not yet seen in a browser. The env-viewer half of the family wiring is still
outstanding, and the cluster-stamp brush has no undo beyond click-to-erase.

Bring the `trees.js` generator and the env-viewer forest pipeline into `bot-viewer-v3.html`, with
automatic scatter *and* manual click/paint placement, and species drawn either at random or from a
chosen tree-viewer family.

Scouted by six agents 2026-08-15; findings that drive this plan are cited inline.

## Decisions taken

| Question | Answer |
|---|---|
| Do trees affect bots? | Full solidity — trunks stop bullets, block the camera ray, collide with capsules |
| Theme gating | Togglable: trees may follow the active theme's block or run theme-independent |
| Scope | bot-viewer-v3 first; env-viewer's identical gap is left for a follow-up |

## The triangle budget decides the collision shape

`createMapCollider` throws — not warns — above `maxTriangles` (250,000; `map-collision.js:25-27`),
and it expands every `InstancedMesh` per instance into that count (`map-collision.js:23`).

Measured 2026-08-15:

- Rendered branch meshes, the 16 stock presets: **1,112 – 13,674 triangles** each. Pines run
  10–12k; `ez-bush_3` is the worst at 13,674.
- Terrain mesh worst case: `maxSegments` 220 per axis → 220² × 2 = **96,800 triangles**. The cap's
  own comment (`bot-terrain.js:31`) says it exists to protect this budget.
- Walls, covers and slabs add roughly 15k on a dense maze.

So the baseline is around 112k, leaving ~138k of headroom. Putting rendered tree geometry into the
BVH would cap the forest at **~27 trees**. That is not a forest.

**Therefore: trunks collide, canopies do not.** Each tree contributes one low-poly cylinder proxy
(8 sides, ~32 triangles) to a single `InstancedMesh` handed to the collider as an `extraRoot` — the
mechanism already documented for "procedurally scattered structures added after the map loads"
(`map-collision.js:70-73`). At 32 triangles per tree that is ~4,300 trees inside the headroom, and
the proxy count is what the tree-count slider must be clamped against, not the render count.

Leaves not stopping bullets is also the physically right answer, so this costs nothing in fidelity.

## Module layout

Two new files, both mirroring patterns already proven in this repo.

### `tree-families-store.js` (new, pure, Node-testable)

Reads the tree-viewer families and turns them into a placement species table.

- `loadFamilies()` — `JSON.parse(localStorage['tree-viewer:families'])`, `try/catch → []`, matching
  tree-viewer's own defensive read (`tree-viewer.html:861`). Read-only; bot-viewer never writes back.
- `speciesTableFor(families, filter)` — wraps `buildSpeciesFromFamilies` (`forest-placement.js:97`)
  with an optional family-id filter, which is the whole of "family-specific selection".
- `validateFamily(f)` — guards the shape at the read boundary, since the two pages version
  independently and nothing but this contract connects them.

Both pages are served from one origin by `serve.py`, so this needs no fetch, no manifest and no
export step. The `families/manifest.json` route exists but is `[]` and is deliberately not used.

### `bot-trees.js` (new)

A near-mechanical repeat of `bot-flora.js`, which already feeds a chunk-shaped placement API from a
bounded arena.

- Own `THREE.Group` parented to `scene`, never `mapRoot` — `clearBoxes(mapRoot)` disposes every
  child geometry on each layout rebuild, and the baked per-species geometry must outlive that
  (same reasoning as `bot-flora.js:41-45` and roads at `bot-viewer-v3.html:853-854`).
- Placement via `placementRecords([floraChunk(bounds, pad, 'trees')], …)` — `forest-placement.js`
  is used unmodified. Exclusion is a **post-hoc filter** on its output against a wall/cover blocker
  index, exactly as `bot-flora.js:344-345` does, because `forest-placement.js` has no hard-exclusion
  primitive, only a soft `densityAt` mask.
- Geometry baked once per species by `createForestPalette` (`forest-palette.js:46`), drawn as
  `InstancedMesh` per species/LOD. Instancing is mandatory: v3 measures 15.5 ms of a 16.7 ms CPU
  budget *out of combat*, and wall instancing alone moved render submit from 13–25 ms to 3.7–5.3 ms.
- Trunk collision proxies built into one `InstancedMesh`, exposed as `trees.colliderRoot` for the
  host to pass as an `extraRoot`.
- Ground sampled with `groundHeight` (the analytic field), matching walls and flora. Roads use the
  rendered mesh only because they are wide ribbons; a trunk base is a point sample. Revisit only if
  trees gain a flared-root or shadow decal.

## Host wiring in `bot-viewer-v3.html`

1. **Rebuild stage.** New `dirty.trees` in `rebuildDerived`, placed after `geometry` (needs the wall
   boxes for keep-outs) and **before `collider`** (the proxies must exist when the BVH bakes). The
   stage order at `bot-viewer-v3.html:7929-7935` is documented as non-negotiable.
2. **Collider.** `createMapCollider(mapRoot, { extraRoots: [botTrees.colliderRoot] })`.
3. **Nav and sight.** Trunk footprints go into `blockers` as padded rects so bots walk around trees.
   They stay **out** of `sightBlockers`: `bots.md:6709-6728` records that thin trunk rects occlude
   nothing at grid pitch while emitting up to 8 corner records each. Bullets still stop on trunks
   via the BVH, so trees are physically solid without polluting the tactical field.
4. **Placement tools.** Extend `spawnToolMode` (`:1270`) with `'tree'`, `'tree-paint'`,
   `'tree-erase'`, dispatched from `commitSpawnTool` and fed by the existing `groundPointAtEvent`.
   Erase reuses the click-within-radius idiom that spawn markers and roads already use.
5. **Cluster stamp.** Genuinely new — nothing in the repo does radius + count + jitter in one
   gesture. Parameterize it after `plants-placement.js`'s explicit `clumpRadius` /
   `clumpChildrenTarget`, which is closer to stamp semantics than `forest-placement.js`'s
   `'clustered'` mode (that one only infers cluster count as `count/5`).
6. **Panel.** A `['world', 'Trees', null, true]` row in `SECTION_PLAN` — World, not Visuals, because
   placement is map content. Follow the local-closure slider idiom (`makeFloraSlider`,
   `:14561-14580`) with its own `treeSyncers` array so slot loads repaint the controls.
7. **Theme gating toggle.** A `treesFollowTheme` boolean. On, density reads the active theme's block
   like grass; off, it reads a viewer-level setting. This matters because the default theme is
   `internetcore`, and only `ecobrutal` ships a non-empty flora block — theme-gated trees would be
   invisible on 8 of 9 themes.

## Persistence

Split by origin, following the two idioms already coexisting in `captureMazeState`:

- **Auto-scattered trees**: params + seed only, regenerated deterministically on load, exactly like
  `structureSettings` (`bot-structures.js:6` — "the same (seed, params, bounds) always rebuilds the
  identical map"). Zero per-instance storage.
- **Hand-placed trees**: an explicit record list `{x, z, speciesId, scale, yaw, origin:'placed'}`,
  filtered on capture by `origin === 'placed'` so auto trees are dropped and regenerated — the
  spawn-marker pattern at `bot-viewer-v3.html:17262`. Store no `y`; re-drape against `heightAt` on
  load, as roads do.

Both land in the **maze** slot, since trees are map geometry. Theme-gated density, if the toggle is
on, rides along in the theme object inside the **ui** slot with no extra plumbing.

Clamp every field on load with the existing `numOr`/`boolOr`/`clampOr` discipline.

## Known gaps and traps

- **No undo exists in bot-viewer-v3** (no `undoStack` anywhere in the file). Painted trees get
  click-to-remove, matching markers and roads. A real undo stack would have to be ported from
  `tree-viewer.html:661-714` and is out of scope here.
- **`chunk.key.split(',')`** seeds the per-chunk hash in both `forest-placement.js:200` and
  `plants-placement.js:112`. A non-numeric key like `'arena'` yields `NaN`, which `Math.imul`
  silently coerces to `0`. Harmless for a single chunk — bot-flora already relies on it — but two
  such keys would collide silently. Use one chunk, or numeric keys.
- **`userData.fpNoCollision` does nothing.** `roads.md:188` claims it makes capsules and bullets
  pass through, but no collision code reads the flag; roads avoid the BVH purely by not being under
  `mapRoot`. Do not tag-and-hope. (Worth fixing that doc line separately.)
- **IBL is off by default**, so a bark or leaf material leaning on environment reflections renders
  black or flat. Keep metalness low.
- **`vegetation.md:854-884` describes family→game wiring as though it shipped.** It never did in
  either env-viewer. The doc needs correcting when this lands.

## Test plan

Node scripts at the repo root, no framework:

- `test-tree-families-store.mjs` — validation rejects malformed families; family filter selects the
  right species; a missing or corrupt localStorage value yields `[]` rather than throwing.
- `test-bot-trees.mjs` — placement is deterministic for a fixed seed; every record clears the
  blocker rects; the trunk-proxy triangle total stays under a stated budget for a stated tree count;
  records re-drape to `heightAt` rather than carrying a stored `y`.

`bot-trees.js` must keep its THREE usage behind the same seam `bot-flora.js` uses so the placement
half stays headless-testable.
