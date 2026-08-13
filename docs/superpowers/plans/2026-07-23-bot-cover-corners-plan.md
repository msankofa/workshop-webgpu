# Bot Cover & Corners — Baked Visibility Field + Defensive FSM Plan

> **For agentic workers:** Execute inline (`superpowers:executing-plans` style — direct Edit/
> Write/Bash in the main session). Steps use checkbox (`- [ ]`) syntax for tracking. This doc is
> both the spec and the plan. Scope is **bot-viewer.html only** (the canonical bot AI);
> environment-viewer porting is Future Work.

**STATUS (2026-07-23): Tasks 0–6 implemented, all Node tests green (test-nav-visibility,
test-nav-corners, test-bot-separation, test-bot-cover, test-bot-activity, test-bot-health-packs,
test-nav-grid). Browser QA pending. `USE_FIELD_LOS_PREFILTER` ships default-off until QA.
Notable impl choices: pure math lives in `bot-separation.js`/`bot-cover.js` re-exported or
imported rather than inside bot-entity/viewer (Node can't import bot-entity's three addon);
cover anchors use the goal-claim store (kind `'cover'`) — corner records' `claimedBy` unused;
ally-hit entry additionally gated on a corner existing; target-loss exit folded into
`coverValid`. Docs updated in `docs/subsystems/bots.md` ("Visibility field, corner cover & bot
separation").**

## Goal

Bots currently have no defensive positioning: when engaged they stand in the open and trade fire
(AIM/FIRE are deliberately stationary) until the heal-retreat chain kicks in. The only occlusion
reasoning in the codebase is a +12 "threat can't see this cell" bonus inside `findFleeGoal`,
gated to health-retreat and capped at 24 raycasts.

This plan adds:

1. A **baked pairwise visibility field** over the nav grid (cell↔cell LOS at eye height,
   computed once at map build) — the shared substrate for all occlusion queries.
2. A **baked corner map** (cover anchors + peek points extracted from the map's wall rects).
3. A **cover FSM branch**: when engaged (or a nearby ally is hit), a healthy bot runs to a
   nearby corner that occludes the threat and fights from it with a peek/hold cycle.
4. **Retrofits** of existing raycast-hungry systems (flee/heal cover scoring, muzzle recovery,
   LOS pre-filtering) onto the field.
5. **Bot-bot separation & goal deconfliction** — bots currently phase through each other (no
   pairwise physics at all) and can commit to identical goal spots. Hard pushout + soft
   avoidance steering + a general goal-claim map (of which the cover-anchor `claimedBy` is one
   instance). Independent of the visibility bake — can ship first.

Deliberately out of scope (Future Work): stance-based hit-capsule shrink (crouch/prone as
mechanical smaller-target), lean channel in the procedural body rig, environment-viewer port.

## Why baked is correct here

All sight-blocking geometry in bot-viewer maps is static after map build (`activeWalls` /
`activeCovers` AABB rects, set once in `applyMapLayout`). Visibility between any two nav cells
never changes at runtime, so every raycast the AI does against static geometry is recomputing a
constant. Precomputing turns:

- corner validity vs. a threat → 2 bit tests
- flee-cell cover scoring → 1 bit test per cell (today: 24-raycast cap, heal-only)
- clear-muzzle-shot cell search → bit tests (today: raycast per ring cell)
- cover re-validation while holding → per-frame bit test (instant reaction to flanks)

## Architecture

Two new pure modules (Node-testable, zero three.js imports, same style as `nav-grid.js`), plus
FSM changes in `bot-activity.js`, plus wiring in `bot-viewer.html`:

### 1. `nav-visibility.js` — pairwise visibility field

```js
buildSightGrid(navGrid, blockers)        // rasterize sight-blocking rects onto grid dims
buildVisibilityField(navGrid, sightGrid) // -> field
field.canSee(cellIdxA, cellIdxB)         // symmetric bit test
field.rowFor(cellIdx)                    // Uint32Array bitset view (walkable-indexed)
cellIndexAt(navGrid, x, z)               // world -> cell idx (shared helper)
```

- **Sight-blockers ≠ nav-blockers.** The sight grid is built from `activeWalls` plus only the
  `activeCovers` entries with `h >= SIGHT_BLOCK_HEIGHT` (1.5 m). Maze covers are deliberately
  short so shots pass over them — they block walking, not sight. Building the field from the
  nav grid's blocked set would mark bots "in cover" behind knee-high props. A rect marks a cell
  sight-blocking only if it covers the **cell center** (errs toward visible for thin overlaps).
- **Compact walkable indexing:** only walkable cells get field rows. `walkIndex:
  Int32Array(cols*rows)` maps cell → dense walkable index or -1; field is a row-major bitset,
  `walkableCount²` bits (~5k walkables → ~3 MB worst case, typically far less).
- **Bake algorithm:** per-origin supercover Bresenham (or shadowcast) over the sight grid,
  early-out on first blocking cell. ~5k origins × cells-in-grid visits — well under a second in
  Node/browser at map build. Bake once per layout, cached beside the nav grid.
- **Conservatism direction:** wherever quantization forces a choice, err toward **visible**.
  A false "you're exposed" costs a slightly worse cover pick; a false "you're safe" gets a bot
  shot while "in cover" — the worst-looking failure mode. Concretely: center-coverage
  rasterization (above) + symmetric OR (visible if either direction's trace says visible).

### 2. `nav-corners.js` — corner map

```js
buildCornerMap(navGrid, sightBlockerRects) // -> { corners: [...] }
// corner record:
// { corner:{x,z}, wallDirA, wallDirB,          // the two edge directions leaving the corner
//   anchorCell, anchorPos,                     // standing spot: ~0.6m inward along wall, ~0.4m off face, snapped to walkable cell
//   peekCell, peekPos,                         // anchor + lateral peek offset past the corner edge
//   peekDir }                                  // unit XZ direction of the lean
```

- Corners come straight off the sight-blocker rects (4 per rect), **culled** when: buried inside
  another blocker, anchor or peek cell unwalkable/off-grid, or anchor cell can already be seen
  from the peek cell's whole hemisphere (degenerate, e.g. freestanding thin post — keep pillars
  though, they're explicitly "hard cover you flank around").
- A rect corner yields up to **2 anchors** (one per adjoining face); each is its own record.
- Sanity cross-check at bake: `field.canSee(anchorCell, peekCell)` must be true (they're a step
  apart) — drop records that violate it (snapping artifacts).

### 3. Runtime query (in `bot-viewer.html`)

```js
findCoverCorner(bot, threatPos) // -> corner record | null
```

1. `threatCell = cellIndexAt(threatPos)`; candidates = corners with `anchorPos` within
   `COVER_SEARCH_RADIUS` (~10 m) of the bot (linear scan is fine at these counts; add a coarse
   spatial bucket only if profiling says so).
2. Validity: `!field.canSee(threatCell, anchorCell) && field.canSee(threatCell, peekCell)`.
3. Score valid candidates: `-distToBot` (closer better), penalty if the path direction closes
   distance to the threat (don't sprint at the enemy to reach cover), bonus for wall face
   roughly perpendicular to the threat bearing (peek exposes less).
4. Skip corners whose `claimedBy` is another living bot (bots have no separation steering —
   without reservation, squadmates stack on the best anchor). Claim on commit, release on
   exit/death.
5. Return best or null. Zero raycasts.

### 4. FSM: cover states (`bot-activity.js` + viewer handlers)

Two new enum states, following the existing flat-ladder style of `chooseBotState`:

- **`BOT_COVER_MOVE`** — pathing to `anchorCell` (A* + string-pull, same as flee movement).
- **`BOT_COVER_HOLD`** — at anchor: hold concealed, cycle peeks. During a peek the bot slides
  laterally to `peekPos` and runs the existing aim/fire gating (aim error, `readyToFire`);
  between peeks it slides back and is fully occluded.

New `ctx` inputs computed by the viewer and passed into `chooseBotState` (keeping the FSM core
pure and Node-testable): `coverAvailable`, `atCoverAnchor`, `coverValid`, `allyHitNearby`.

Ladder placement — after the heal/knife/flee-committed rungs, before the stationary AIM/FIRE
rungs:

- Enter `BOT_COVER_MOVE` when: `targetVisible && !healRequested && coverAvailable` (a valid
  corner exists within radius), OR `allyHitNearby` (an ally within `ALLY_ALERT_RADIUS` took
  damage in the last few seconds — threat = the attacker's last-known position) — and not
  already cover-committed.
- `BOT_COVER_MOVE → BOT_COVER_HOLD` when `atCoverAnchor`.
- Exit either state when `!coverValid` (threat moved — the per-frame bit test caught it):
  re-run `findCoverCorner` once; if a new corner is found, re-enter `BOT_COVER_MOVE`
  (re-pick is cheap — that's the point of the bake); else fall through the ladder to normal
  AIM/FIRE/flee. Also exit on target death/loss (→ SEEK/PATROL) and on `healRequested`
  (heal chain outranks cover, unchanged).
- **Commitment/hysteresis:** `coverCommitted` mirrors `fleeCommitted` — once a corner is
  chosen, don't re-shop every frame; only the validity bit test can break commitment (plus a
  max-commit timeout so a never-valid path abandons gracefully).

Peek cycle (viewer-side, inside the HOLD handler): timers `PEEK_OUT` (~1.2 s) / `PEEK_IN`
(~0.8–1.6 s jittered per bot so squads don't metronome). While peeked the existing muzzle-blocked
counter (`recordBotShotResult`) still runs — if shots from the peek keep hitting world geometry,
that's a bad peek: invalidate this corner (session blacklist for this engagement) instead of
entering muzzle-recovery wander.

Rendering: **no rig changes.** The peek is a lateral body slide (anchor↔peek over ~0.15 s) plus
reusing the existing `crouch` stance channel while holding behind low-profile anchors is *not*
attempted yet (needs stance mechanics — Future Work). A body-roll lean channel is likewise
deferred; the slide reads clearly at gameplay distance.

### 5. Bot-bot separation, pushout & goal claims

Audit finding: each bot physics-steps as a singleton against the static `mapCollider` only —
there is **no** bot-bot collision or steering anywhere, and no goal deconfliction. Three layers,
cheapest-first, all in `bot-viewer.html` (pushout math in `bot-entity.js` so it's Node-testable):

- **Hard pushout:** after all bots step, one O(n²) XZ pass over living pairs closer than
  `2 × capsule radius`: push each apart by half the penetration. Dead/ragdolled bots excluded.
  Any bot moved by pushout gets a follow-up wall resolve against `mapCollider` — otherwise two
  bots squeezing at a doorway get shoved through the wall.
- **Soft avoidance steering:** during path-following movement, sum a separation vector from
  living neighbors within `SEPARATION_RADIUS` (1.5 m), 1/dist weighted, blended into the move
  direction before velocity is applied. Prevents corridor jitter against the hard constraint.
- **Goal claims:** layout-scoped `claimedCells: Map<cellIdx, botId>`. Committed movement goals
  register a claim (flee cell, muzzle-recovery cell, pack target, cover anchor — the corner
  `claimedBy` above is this mechanism's first consumer — medic tend point); goal-scoring in
  each picker skips cells claimed by another living bot. Claims released on arrival, replan,
  state exit, and death. **Patrol ring points are exempt** — shared pass-through waypoints by
  design.

Tunables: `SEPARATION_RADIUS = 1.5`, `SEPARATION_WEIGHT`, pushout uses the existing capsule
radius from `bot-entity.js`.

### 6. Retrofits onto the field

- **`findFleeGoal`:** replace the top-24 threat-eye raycast block with `!field.canSee(threatCell,
  candidateCell)` for **every** flood-fill candidate, and apply the `coverScore` bonus for
  **all** flees, not just heal-retreat. Delete `FLEE_COVER_RAYCAST_CAP`.
- **`findMuzzleRecoveryCell`:** replace per-ring-cell `hasClearMuzzleShot` raycasts with
  `field.canSee(cell, targetCell)` as the filter; keep **one** confirming raycast on the chosen
  cell (the field is 2D at eye height; the confirm catches 3D oddities cheaply).
- **LOS pre-filter (flagged, default off):** in `selectBotTarget`/`botCanSeePack`, skip the BVH
  raycast when `!field.canSee(botCell, targetCell)`. Because the field errs toward visible,
  a "hidden" verdict can very rarely be wrong — ship behind a `USE_FIELD_LOS_PREFILTER` toggle
  and flip it after browser QA.
- **Pursue-on-miss investigation (nice-to-have, last):** when picking orbit points around the
  last-known cell, prefer cells where `field.canSee(cell, lastKnownCell)`.

## Tunables (add to the existing bot tuning constants)

```
SIGHT_BLOCK_HEIGHT = 1.5   // covers at/above this height block sight for the field
COVER_SEARCH_RADIUS = 10   // m, corner candidate radius
ALLY_ALERT_RADIUS = 12     // m, ally-hit cover trigger
PEEK_OUT_S = 1.2 / PEEK_IN_S = 0.8..1.6 (jittered)
COVER_COMMIT_TIMEOUT_S = 6
ANCHOR_INSET = 0.6 / ANCHOR_OFFACE = 0.4  // corner-anchor placement, m
```

## Build order

### Task 0 — bot separation, pushout & goal claims (independent — no bake dependency)
- [x] Pairwise pushout pass in `bot-entity.js` (`resolveBotPairs(actors, radius)`, pure) +
      post-pushout wall re-resolve; wire after the per-bot step loop in `bot-viewer.html`.
- [x] Separation steering blended into path-following movement.
- [x] `claimedCells` goal-claim map + claim/release lifecycle; wire into flee, muzzle-recovery,
      and pack goal pickers (cover anchors join in Task 3).
- [x] `test-bot-separation.mjs`: overlapping pair separates to ≥ 2r; doorway squeeze never
      penetrates a wall rect; two bots offered the same goal cell resolve to different cells;
      claims release on death/replan.

### Task 1 — `nav-visibility.js` + `test-nav-visibility.mjs`
- [x] Implement sight-grid rasterization, walkable indexing, bitset field, supercover trace,
      `canSee`/`rowFor`.
- [x] Tests: single wall splits two rooms (cells mutually hidden across it, visible within);
      short cover (`h < 1.5`) does NOT block; symmetry; conservatism (grazing-corner pairs
      resolve visible); bake-time budget assertion on a maze-sized grid.

### Task 2 — `nav-corners.js` + `test-nav-corners.mjs`
- [x] Corner extraction, anchor/peek placement + snapping, culls, field cross-check.
- [x] Tests: lone rect yields ≤8 anchor records with sane geometry; abutting rects cull shared
      corners; anchor/peek cells walkable; hand-built L-wall: anchor hidden from one side,
      peek sees it.

### Task 3 — runtime query + FSM core
- [x] `findCoverCorner` in bot-viewer (bake field+corners in the layout-build path beside the
      nav-grid bake; dispose with the map).
- [x] `bot-activity.js`: add `BOT_COVER_MOVE`/`BOT_COVER_HOLD` + ctx inputs to
      `chooseBotState` ladder as specced.
- [x] Extend `test-bot-activity.mjs`: enter-on-engage, enter-on-ally-hit, hold at anchor,
      exit-on-invalid re-picks, heal outranks cover, commit timeout.

### Task 4 — viewer wiring: movement + peek cycle
- [x] COVER_MOVE pathing handler (reuse flee-movement machinery), COVER_HOLD peek cycle with
      slide interpolation, aim/fire gating while peeked, bad-peek corner blacklist,
      per-frame validity bit test, ally-hit tracking (`allyHitNearby`).
- [x] Cover anchors join the Task 0 goal-claim map — claim on cover commit, release on state
      exit/death; `findCoverCorner` skips claimed anchors.
- [x] `test-bot-cover.mjs`: scripted two-bot scenario on a hand-built L-wall map — attacker
      static, defender ends holding at the correct anchor; peek exposes/conceals on timer;
      attacker teleported behind → defender re-picks or falls back.

### Task 5 — retrofits
- [x] `findFleeGoal` on the field (all candidates, all flees); delete raycast cap.
- [x] `findMuzzleRecoveryCell` on the field + single confirm raycast.
- [x] `USE_FIELD_LOS_PREFILTER` toggle (default off).
- [x] Update affected assertions in existing bot tests.

### Task 6 — docs + log
- [x] `docs/subsystems/bots.md`: new "Visibility field & cover" section (bake, data shapes,
      FSM states, tunables); fix the flee-cover section (raycast cap gone).
- [x] `agent_log.csv` rows per logical change (append-only).
- [ ] Browser QA pass in bot-viewer (rooms + maze layouts); note results in STATUS header.

## Future work (explicitly deferred)

- **Stance mechanics:** tie crouch/prone to the hit capsule + eye height in `bot-entity.js`,
  bake a second field slice at crouch eye height so short covers become real cover when
  crouched behind — this is what makes "smaller target" mechanical instead of cosmetic.
- **Lean/roll channel** in `player-procedural-body.js` for a proper corner lean read.
- **Environment-viewer port:** real shoot-house geometry is a BVH triangle soup; either stop
  discarding the `shoot-house-pieces` primitive list (it already carries `kind:'cover'` tags —
  best option) or bake the field via BVH raycasts at load. Same runtime API either way.
- **Doors/dynamic blockers:** if portalDoor pieces ever open/close, the field needs dirty-region
  rebakes; out of scope while all blockers are static.
