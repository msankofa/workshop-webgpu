# Destructible walls in `bot-viewer-v3.html` — implementation plan

Status: **not started**. Written 2026-08-09.

State model, decided with the user: **cracked** (visual only), **crumbled** (half the wall falls away
on a horizontal, vertical or diagonal cut; may or may not be traversable, may or may not be good
cover), **crushed** (a rubble pile, fully traversable). **Breached** (a hole punched through a wall
that otherwise stands) is deliberately deferred: crumbled builds the patterned-fracture machinery
that a breach is then one more pattern of.

## Why this is mostly a rebake problem, not a geometry problem

A wall is already just an axis-aligned rect in `activeWalls` (`{x, z, w, d}`), so "destroy wall 37"
is a data edit. Everything expensive is downstream, baked once per layout in `applyLayout`
(`bot-viewer-v3.html:7689`): the instanced wall mesh, the BVH collider, the nav grid, the sight grid
and visibility field, and the corner map. The last log entry of 2026-08-09T09:10 already names this
as the open problem — *"an incremental nav-grid/corner-map path is the fix if the logged cover bake
proves too slow to sit behind a click."* Destruction is that same fix, driven by bullets instead of
a click, and it needs the cost measured before anything is designed around it.

## What is verified about the current code

- **Walls have no per-record height.** `instancedBoxes(wallMat, activeWallBoxes)` builds every wall
  at the global `WALL_H` (`bot-viewer-v3.html:7719`). A horizontal cut needs an `h` on the record.
  Sight is already fed by the same records, and `buildSightGrid` reads `h === undefined` as infinite
  (`nav-visibility.js:52`), so adding `h` feeds the sight bake for free.
- **The collider is one flat triangle soup.** `collectWorldTriangles` bakes every mesh under
  `mapRoot`, expanding each InstancedMesh instance, into a single identity-transform geometry
  (`map-collision.js:15`). There is no per-instance removal, so any wall change means a full
  `MeshBVH` rebuild unless destructibles get a collider of their own.
- **A bullet hit carries no wall identity.** `raycast` returns `{distance, point, normal}` and
  nothing else (`map-collision.js:~137`), and `resolveHitscan` reports the occluder branch as
  `kind: 'world', id: null` (`combat.js:210`). Attribution has to be derived from the hit point.
- **The visibility field documents an immutability assumption that destruction breaks.** Its pair
  memo is commented *"Safe without invalidation: a built field is immutable, so a pair's answer never
  changes"* (`nav-visibility.js:~186`), and there is a separate FIFO row cache. Neither has an
  invalidation export. The field is also cheap to reconstruct, because it is lazy: construction is
  one O(cells) pass building `walkIndex`, with no traces. Rebuilding the object beats adding
  invalidation.
- **Nav supports exactly the local patch we want.** `finalizeNavGrid` exists as a split from
  `buildNavGrid` precisely so a caller can fill `cells` itself and relabel afterwards
  (`nav-grid.js:51`). Patching a footprint then relabelling is a supported path, not a hack.
- **Cover boxes block movement.** `pointInWall` tests `activeCovers` as well as `activeWalls`
  (`bot-viewer-v3.html:7373`), so a low stub is impassable by default.
- **Corner anchors need 1.5 m.** `buildCornerMap` filters to rects at or above `SIGHT_BLOCK_HEIGHT`
  (`nav-corners.js:55`), and the sight test is `h < 1.5 → transparent` (`nav-visibility.js:53`).
- **`visField.canSee` is load-bearing across the AI**: target prefilter, flee scoring, blast shadow,
  grenade evade scoring, cover-corner validity, and investigation anchoring all read it. A stale
  field is not a cosmetic bug.

## Measured, 2026-08-11 (`bench-corners.mjs`, 200 m map, 900 walls, 400×400 nav cells)

| stage | full bake | after one wall is destroyed |
|---|---|---|
| nav grid | **220.5 ms** | 212.5 ms (still whole-map) |
| visibility field | 4.7 ms | 4.3 ms (still whole-map) |
| corner map | 65.2 ms | **1.5 ms** via `updateCornerMapInBounds`, 38.8× |

Two things fall out, and both contradict what this plan assumed before the numbers existed.

**The corner map was not the bottleneck — the nav grid is, by 3×.** `buildNavGrid` calls a
point-in-world test per cell, and that test scans every rect: 160,000 cells × 900 rects is 144
million rectangle tests. `buildSightGrid` rasterizes the same rects into the same grid dimensions in
under a millisecond by walking each rect's cell range instead. The nav bake can use that shape too,
which is a straight algorithmic win worth more than any incremental path. The viewer's real figure is
higher still, because `navWalkable` also runs a slope test per cell that this bench does not.

**The visibility field is already free.** 4.7 ms whole-map. It needs no incremental path at all, and
the plan's earlier instinct to rebuild rather than invalidate it is the right call for the right
reason: it is cheap, not merely cheaper than the alternative.

## Phase 0 — measure, and build the rebuild seam (blocking)

No destruction yet. Extract the tail of `applyLayout` — collider, nav grid, sight grid, visibility
field, corner map, flora — into a `rebuildDerived({ nav, sight, corners, collider, flora })` that
takes a set of dirty flags, and have `applyLayout` call it with everything set. Behaviour identical,
full suite green.

Then instrument it and **write the numbers into this doc**: BVH rebuild, nav patch plus
`finalizeNavGrid`, sight-grid rasterize, visibility-field construction, corner bake. The `[cover
bake]` console line already prints the corner cost, which is the one I expect to dominate. Measure on
a 200 m open map with ~900 walls, which is the worst case the workspace actually produces.

Everything after this phase is shaped by those numbers. If the corner bake is tens of milliseconds,
destruction batches into a once-per-N-ms dirty pass. If it is hundreds, the corner map needs a
footprint-local invalidation before crumbled can ship at all.

## Phase 1 — `bot-destruction.js`, pure and Node-tested

Follows the repo's pure-module convention (`nav-grid.js`, `nav-corners.js`, `bot-structures.js`).
No THREE import, no viewer state.

```js
export const WALL_STATE = { INTACT: 0, CRACKED: 1, CRUMBLED: 2, CRUSHED: 3 };
export function createDestructibleSet(walls, { hpPerCubicMetre, indestructible })
export function applyWallDamage(set, wallId, amount, { rng })   // -> transition | null
export function fracture(rect, pattern, { rng, minStair })      // -> { solids: [], rubble: [] }
export const FRACTURE_PATTERNS = ['horizontal', 'vertical', 'diagonal'];
```

`fracture` is the whole phase. Given one rect plus its height it returns child rects:

- **horizontal** — one child at the full footprint, roughly half height. Choose 1.4 m rather than
  exactly half of 3 m, so the result lands clearly below `SIGHT_BLOCK_HEIGHT` instead of on the
  `>=` boundary.
- **vertical** — one child at full height covering roughly half the length, the other half becoming
  rubble. This is the pattern worth having first: it leaves a standing wall with a new free end, and
  `buildCornerMap` manufactures a fresh anchor and peek point there.
- **diagonal** — a staircase of three or four children with descending heights, because every
  consumer downstream is an axis-aligned rect test. The rendered mesh may be a real slanted cut; the
  sim reads the staircase.

Tests in `test-bot-destruction.mjs`: children stay inside the parent footprint, children are
axis-aligned and non-overlapping, solid plus rubble volume is conserved within tolerance, the same
seed gives byte-identical output, and the horizontal result is strictly below `SIGHT_BLOCK_HEIGHT`.
Front-load a fixed-length draw vector per pattern the way `plants.js:414` documents for
`rollPlantVariation`, so changing one tunable does not reshuffle every later draw.

## Phase 2 — damage in, cracked out

Wire damage without any rebake, so something ships with zero AI risk.

**Attribution.** Bake a `wallIdAt` raster once per layout, cell → wall index, on the nav grid pitch.
A world hit steps back 0.05 m along `hit.normal` and looks up one cell, falling back to a linear scan
of `activeWalls` on a miss. This is the same authoring-time-data shortcut `pointInWall` already
documents.

**Hooks.** Hitscan at `fireBotShot` (`bot-viewer-v3.html:11334`), where `hit.kind === 'world'` is
already separated from player and terrain hits for the impact voice. Projectiles at
`projectileRaycast` (`:11813`). Blasts in `detonateBlast` (`:11281`) as a sphere-versus-AABB sweep of
the wall list, which needs no attribution at all.

**Cracked** is a material or decal change on the instance plus an impact-debris burst. No record
changes, so nothing rebakes and the state is free. It also telegraphs which walls are breakable,
which the player otherwise cannot know.

## Phase 3 — crumbled

`applyWallDamage` crossing the crumble threshold replaces one record with its fracture children.
Then the dirty pass, in this order:

1. Rebuild `activeWallBoxes` and the wall InstancedMesh. The instance count changes when one wall
   becomes several, so zero-scaling a single instance is not sufficient.
2. Rebuild the collider. Split destructibles into their own collider here if Phase 0's numbers say
   the full BVH rebuild is too slow.
3. Patch `navGrid.cells` over the affected footprint and call `finalizeNavGrid`. A horizontal cut
   leaves nav untouched; a vertical or diagonal cut opens the half that fell.
4. Re-rasterize the sight grid and rebuild `visField`. Not optional: `walkIndex` is baked from
   `cells`, and both caches assume immutability.
5. Re-bake the corner map, or invalidate footprint-local corners if Phase 0 says a full bake is too
   slow.
6. Drop per-bot state pointing at geometry that is gone. `coverCornerValid` already runs per frame
   behind `COVER_INVALID_GRACE_S`, so the FSM may self-heal here — verify that rather than assume it,
   and clear `actor.coverCorner` explicitly if it does not.
7. `rebuildFlora()`, or vines stay anchored to a wall that no longer exists.

Batch: coalesce every destruction in a window into one pass, capped at once per N ms, with N chosen
from Phase 0.

## Phase 4 — crushed

The record leaves `activeWalls` and `activeCovers` entirely, so `pointInWall` opens the ground. A
rubble mesh stays for looks.

The trap is that the rubble mesh still lives under `mapRoot` and `collectWorldTriangles` sweeps all
of it into the BVH, while nav walkability reads only the terrain field's `heightAt`
(`bot-viewer-v3.html:7726`). The capsule solver has a slope limit of 0.5 on the contact normal and no
step-up (`bot-entity.js:66`), so rubble in the collider is climbable but invisible to pathing, and
bots would path straight through a bump the physics then fights them over. **First version keeps
rubble out of the collider entirely** and treats it as decoration over now-flat ground. Making rubble
genuinely rough terrain means feeding it into the terrain field as a pad, which is a later phase if
it is wanted at all.

## Phase 5 — awareness, controls, docs

A destroyed wall changes the map under bots mid-fight. Worth checking, in the browser, whether they
behave sanely without any new AI code: paths reroute on the next repath, cover anchors revalidate,
`visField` answers change. My expectation is that the FSM absorbs it and no new state is needed, but
that is a guess until it is watched.

Panel controls under a new Destruction card: master toggle (default **off**, matching how every other
risky subsystem here ships), hit points per cubic metre, which patterns are allowed, rubble lifetime,
and a "destroy wall under cursor" debug button for testing without a firefight.

Docs: `docs/subsystems/bots.md` gets `bot-destruction.js`, `code-map.html` gets the node, and
`agent_log.csv` gets a row per logical change.

## Traps (verified against the code)

| Trap | Consequence |
|---|---|
| Wall records are bare `{x, z, w, d}`, and `mazeCellWalls` emits ring and interior walls from one loop with no tag (`bot-structures.js:118`) | "destructible" is not expressible in the data yet; `createDestructibleSet` needs either a flag emitted at generation time or a bounds test to keep the ring out |
| `visField`'s memo and row cache are documented as needing no invalidation | stale LOS survives destruction; rebuild the field object, do not add invalidation |
| `raycast` returns no object or instance id | bullet hits cannot name a wall without the attribution raster |
| Collider is one baked soup over all of `mapRoot` | no per-instance removal; every change is a full BVH rebuild unless destructibles are split out |
| `SIGHT_BLOCK_HEIGHT` is 1.5 m and the test is `>=` | a 3 m wall cut exactly in half still blocks sight; pick 1.4 deliberately |
| `buildCornerMap` ignores rects under 1.5 m | a horizontal crumble deletes cover anchors and creates none, so destruction reliably makes a room less defensible |
| `pointInWall` tests `activeCovers` too | a crumbled stub is impassable unless explicitly made traversable |
| `activeSlabs` span walls (lintels, portal decks) | destroying a wall under a slab leaves it floating; slabs must either be destroyed with their supports or be excluded |
| Vines anchor to `activeWallBoxes` in `flora.rebuild`, once per layout | destroyed walls leave vines hanging in air |
| `botLiveAnnounceWorld()` fires only in `applyLayout` | a connected live map never hears about destruction and silently diverges |
| `UNIT_BOX` is shared across every box mesh | teardown must keep skipping it, as `applyLayout` already does |

## Sequencing against `structure-viewer-plan.md`

That plan's Phase 1 extracts `instancedBoxes`, `boxTransformOnTerrain` and friends into
`map-boxes.js` and rewires v3. This plan rewrites the same wall mesh path. Do the extraction first if
both are going to happen, or the extraction inherits a moving target.

## Order of work

Revised once the numbers came in. Local invalidation is wanted across the board, not only for
destruction, so the incremental paths come first and destruction is built on top of them.

1. **Done** — Phase 0's `rebuildDerived(dirty, {label})` seam in `bot-viewer-v3.html`, and
   `bench-corners.mjs` with the numbers above.
2. **Done** — `updateCornerMapInBounds` in `nav-corners.js`, exact for wall records over every
   single-wall removal, a wall shortened below sight height, and a wall split in two
   (`test-nav-corners.mjs`). 1.5 ms against a 65 ms rebake.
3. **Next, and now the priority** — rasterize the nav bake. `buildNavGrid`'s per-cell test scans
   every rect; `buildSightGrid` already shows the rect-range shape that makes this near-free. This
   is worth more than any incremental path and it speeds up every rebuild, not just destruction.
4. Local nav patching for destruction specifically: patch the footprint's cells, then relabel.
   Destruction only ever *opens* ground, and opening can only merge regions, never split them, so a
   local merge is exact — unlike wall *addition*, which needs the full relabel.
5. **Done** — `bot-destruction.js` and `test-bot-destruction.mjs`: the state ladder, the three
   fracture patterns, per-wall deterministic streams, `activeRectsOf`/`rubbleRectsOf`, and
   `wallAtPoint` attribution. Pure; nothing calls it yet.
6. **Done** — Phase 2: attribution (`wallAtPoint`), damage accrual from bullets, haywire fire and
   blasts, and the cracked state, behind the default-off *Wall damage* toggle. The ladder is pinned
   at `CRACKED` via `maxState`, so damage is real but geometry never changes. Attribution is still a
   linear scan rather than the planned cell raster.
7. Phase 3: crumbled, one pattern at a time, vertical first because it is the one that gives the
   cover system something new.
8. Phase 4: crushed, rubble out of the collider.
9. Phase 5: watch the bots, add the panel card, update the docs and the log.
