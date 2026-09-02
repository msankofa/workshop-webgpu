# Base Game: encode cost and forest spikes

**Date:** 2026-08-30
**Status:** items 1–4 shipped 2026-08-30, Node-tested, not yet re-captured in a browser. Item 1
found two things the plan did not predict: the record's placement height was up to 3.65 m off the
drawn surface (8 m posts), so the record now carries the source height instead; and the post-only
shore gate had rooted 209 test-scene trunks below sea level, so the gate now runs again on the real
surface. Item 4's effective-rate half already existed as `fps.effective`; only the snap was new.
**Evidence:** eight captures in `research/stats/base-game-performance-log.json` taken 2026-08-30
13:41–13:54 (solo, terrain world, trees + grass + rain + shadows + depth of field on, water reflection
`sky`, no NPCs), read against the code paths named below. GPU timestamps were off, so every number
here is CPU.

## What the captures say

| | 60 cap (5 captures) | 45 cap (3 captures) |
|---|---|---|
| frame ms p50 / avg / p95 / max | 13.4–16 / 17–18.5 / 27–32 / 39–72 | 26.1–26.6 / 23–25.6 / 27–37 / 66–253 |
| `passPostMs` p50 / max | 8.4–11.4 / 28–36 | 8.1–10.6 / 20–40 |
| `passForestMs` max | 1.5, 53 | 52, 53, 165 |
| `passBodiesMs` max | 1.7–7.5 | 1.7–14.1 |
| draws (steady, no mirror) | 314–328 | 315–327 |
| scene census | 243 renderables, 212 `frustumCulled:false`: `Mesh` 106, `WeaponBatch` 74, `proceduralPlayerBody` 31, `Group` 27, terrain batches 4, water 1 | same |

Three separate things are in there:

1. **The 45 cap is pacing, not load.** The display is 75 Hz. A 45 cap cannot land on a 13.3 ms
   grid, so `frameCapHolds` (`base-game.html:4332`) alternates 13 ms and 27 ms gaps: the average is
   45–49 fps, the p50 reads 37.5, and the alternation is a judder. No renderer work fixes this.
2. **The median is render encode.** `passPostMs` 8–11 ms p50 against a 13.3 ms budget, up from
   3–6 ms on 08-26. `renderer.render` does not wait on the GPU, so this is CPU: per-object binding
   and uniform updates over ~320 draws, most of them node-material objects that never cull. The
   earlier "draws are cheap" A/B (`docs/subsystems/base-game.md`, per-chunk culling table) doubled
   BatchedMesh draws that share one pipeline; it does not transfer to 320 distinct objects.
3. **The spikes are the forest rebuild.** `forest-gpu.js:788` sets `needsRebuild` on every chunk
   arrival; `rebuild()` (about line 505) walks every record in the 400 m window (~2,000 trees at
   45/ha) and calls `heightAt` per record, which in Base Game is `terrain.groundHeight` →
   `TerrainSystem.getHeight` → `source.heightAt` (`terrain-system.js:225`), the v5 noise stack on
   the main thread. 52–165 ms per rebuild, once per placed chunk while walking.

Not implicated by these captures: NPC bodies (none were spawned), the water mirror (reflection was
`sky`), every `apply*Settings` function (all dirty-gated), the HUD (writes on change only).

## Work

Ordered by measured payoff. Each item says what is mechanical and what is not.

### 1. Forest: stop re-querying terrain in `rebuild()`

`base-game-trees.js:193` already writes `r.y = placementHeightAt(x, z) + treeVerticalOffset` on
every record, from the fine field window (`terrain.fieldSurfaceAt`). `forest-gpu.js:552` ignores it
and asks `heightAt` again.

- `base-game-trees.js`: also store the raw height as `r.ground` (without the vertical offset), so
  the renderer can keep applying its live `treeBaseOffset` slider.
- `forest-gpu.js:552`: `const g = Number.isFinite(r.ground) ? r.ground : heightAt(r.x, r.z)`, then
  `g + treeBaseOffset - originY` as now. Records without `ground` (the environment viewer's
  `forest-placement.js` records) take the old path unchanged.
- `base-game-forest.js:183` `globalHeightAt` stays as the fallback.

Mechanical: ~10 lines. **The one thing to check first:** placement samples the field window,
rendering samples the source; if the two disagree by more than a few centimetres, trunks move when
this lands. `test-base-game-forest.mjs` gains a check that compares `r.ground` against
`terrain.groundHeight` over a chunk's records and reports the max difference, so the plan's
assumption is measured rather than trusted.

Optional second step if spikes remain: coalesce `needsRebuild` so at most one rebuild runs per N
frames. Not planned until item 1 is measured.

### 2. Census: name what the encode is walking

`sceneCensus()` (`base-game.html:2517`) keys owners by `child.name || child.type`, so every unnamed
top-level mesh collapses into `Mesh` (106) and unnamed groups into `Group` (27). 42 of the 106 are
the forest (6 variants × 7 rungs); the other ~64 are unattributed.

- Name the meshes Base Game adds to the scene: forest variant meshes (`forest:<species>:<part>` in
  `forest-gpu.js` `drawMesh`), projectile pool, rain streaks and splashes, cloud decks, debris
  instanced meshes, effect pools, laser beam, capsule.
- In the census, for any owner still called `Mesh` or `Group`, add a `byKind` breakdown of
  `geometry.type/material.type` counts so the next capture attributes the remainder without another
  round of naming.

Mechanical: ~30 lines across the modules, ~10 in the census. No behaviour change.

### 3. Weapons: one bucket per material, not per GLB part

`weapon-mount.js:248` makes one `instanceParts` entry per mesh in the GLB; `weapon-part-batches.js`
makes one `InstancedMesh` per part, all `frustumCulled:false`. One player's held and stowed guns are
74 buckets, the largest single owner in the census. bot-viewer-v3 has the same layout and tolerates
it because N bots share the buckets; the cost is per weapon type, not per bot.

- In `templateFor`, after baking, group parts by converted material, pre-apply each part's
  `localMatrix` to a clone of its geometry, merge with `mergeGeometries` (already used by
  `shoot-house.js`), and emit one part per material with an identity `localMatrix`.
- `reducedParts` (the stowed copies use the biggest half of the parts) is recomputed over the
  merged list; with 3–5 merged parts that rule needs a floor of 1, which it already has.

Not fully mechanical: `mergeGeometries` requires matching attribute sets per material group
(position/normal/uv; skinned parts are already baked to static), and a GLB whose parts of one
material differ in attributes falls back to unmerged parts for that material. Expected result: 74 →
roughly 10–15 buckets. `test-weapon-mount.mjs` and `test-weapon-part-batches.mjs` gain a check that
a template's part count equals its distinct-material count when attributes match. This changes a
module shared with bot-viewer-v3, so it is a separate commit with its own capture.

### 4. Frame cap: say what it will actually do on this display

The cap keeps its options (the user tests at extremes on purpose). Two additions:

- The Performance Capture line reports the effective rate the cap produced (`sampleCount /
  windowMs`), next to the p50, so "45 → 37.5 p50, 46 effective" is visible rather than inferred.
- A `snap to display` toggle (default off) that rounds the chosen cap to the nearest
  `displayRate / k`, using the `frameCapRafMs` EMA the cap already keeps, so 45 on a 75 Hz screen
  becomes a steady 37.5 instead of a 13/27 alternation. Both behaviours remain available.

Mechanical: ~25 lines in `frameCapHolds` and the capture summary; `test-base-game-frame-cap.mjs`
gains a 75 Hz / 45 cap case for both modes.

### Deferred, with the reason

- **NPC rig striding.** bot-viewer-v3 (`bot-viewer-v3.html:3394–4245`) already has distance rig
  LOD, a nearest-N rig budget and banked `dt`; porting it into `base-game-player-bodies.js` is the
  right shape. But no capture has NPCs in it yet, so it cannot be measured. Port it when a capture
  with spawned bots exists.
- **Mirror exclusions for bodies and weapons.** Only matters with planar reflection on; the
  captures ran `sky`.
- **Per-frame allocation hoists** (about fifteen short-lived objects a frame in `animate` and
  `updateWorld`). Real but small; last.

## Verification

- `node test-base-game-forest.mjs`, `node test-base-game-trees.mjs`, `node test-weapon-mount.mjs`,
  `node test-weapon-part-batches.mjs`, `node test-base-game-frame-cap.mjs`.
- Captures, same spot and heading as 13:52:31 (global 216, 52, 383, yaw 3.65), 60 cap, 10 s window,
  after each item: expect `passForestMs` max under 5 ms after item 1, `WeaponBatch` renderables
  under 20 after item 3, and `passPostMs` p50 to move with the renderable count. Two A/B captures
  before item 3 would sharpen its expected payoff: shadows off, and depth of field off.
- Docs: `docs/subsystems/base-game.md` (frame cap, reading a capture, census fields),
  `docs/subsystems/vegetation.md` (record `ground` field, forest-gpu fallback),
  `docs/subsystems/bots.md` (weapon template merge). One `agent_log.csv` row per item.
