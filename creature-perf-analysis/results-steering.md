# Results: Steering, Behavior Selection & Collision

Domain: `port-creature-system.js` (creature-creature separation, enemy targeting, trunk
avoidance, collision resolution, arena confinement, forage targeting). Verified against
scout files `steer-locate.md` / `steer-trace.md` by reading the actual code at each
anchor. Corrections to the scouts' claims are called out explicitly where the code
disagreed.

All line numbers below refer to `port-creature-system.js` unless another file is named.

---

## 1. Creature-creature collision resolution — `resolveCreatureCollisions` (4219-4261)

**What it does:** For every active creature `a`, queries `creatureGrid.nearby(a.pos.x, a.pos.z, _nb)` (3x3 cells around `a`, cell size 5.0 -> a 15x15 unit box), then for every `b` in that neighbor set with `b._gridIdx > a._gridIdx` (dedup), computes overlap of `collisionRadius()`/`meleeRadius()` and pushes the pair apart + damps closing velocity.

**Cost:** O(N_active) outer x O(nearby) inner. With cell size 5.0 and typical creature collision radii ~1-2, `nearby` count stays small while creatures are spread out, but degenerates toward O(N) per query (i.e. O(N²) total) as soon as a swarm packs into a few adjacent cells (e.g. combat mode drives enemies together, or forage clustering around a few objects). Confirmed via `steer-trace.md`.

**Runs up to 5x/frame — confirmed, and worse than it looks:** `FIXED = 1/60` (line 4607); the `while (acc >= FIXED && steps < 5)` loop (4780-4786) calls `resolveCreatureCollisions` once per fixed sub-step. At a steady 60 FPS this is exactly 1x/frame. But the multiplier only engages when the accumulator backs up — i.e. exactly when the frame is already running slow (a stutter, a tab coming back from background, a GC pause). That is a **negative feedback loop**: a slow frame triggers catch-up sub-steps, each of which re-runs the most expensive O(N²)-leaning pass in the whole creature system, making the next frame slower too.

**Grid staleness across sub-steps (a correctness note, not a complexity one):** the grid is rebuilt exactly once per frame at 4772-4773, *before* the physics loop starts. All up-to-5 collision passes inside that loop reuse the same bucket membership even though `physicsStep` moves every creature's `pos` between passes. The distance math inside `resolveCreatureCollisions` reads live `pos.x/pos.z` (correct), but which cells got queried for "nearby" was frozen before any of the 5 sub-steps ran, so a creature that crosses a cell boundary mid-catch-up won't pick up newly-adjacent neighbors until the next frame's rebuild. Minor at cell size 5.0 vs. per-substep displacement, but a real staleness source that compounds with more sub-steps.

**Why inefficient / WHY:**
- No true broad-phase decoupling — the grid mitigates but does not eliminate O(N²) under density; there is no swept/sorted axis pass or larger-vs-smaller-radius cell tiering.
- `collisionRadius()` and `meleeRadius()` are **not cached** — see Finding 5 below; they're recomputed from a leg-count loop on every single pair check, every sub-step.
- The 5x cap is a bandage for frame-time variance, not a fix — it converts "occasional dropped frame" into "occasional 5x collision cost spike," which is the worst time for it.

**Severity: High**

---

## 2. Enemy targeting — `enemyTarget` (2051-2069), called from `updateCombat` (4751)

**What it does:** For a combat-active creature, grid-queries nearby creatures and picks the closest valid enemy (different team, combat-active), with a bonus toward weak/low-health targets.

**Cost:** O(N) calls/frame (once per combat-active, `lodShouldSim` creature — see 4751), each O(nearby) via the grid.

**Scout's O(N²) "grid empty -> full list fallback" claim — verified true in code, but overstated as a per-frame risk.** Line 2057: `const candidates = _nearbyScratch.length > 0 ? _nearbyScratch : list;` — this fallback is real and does hand back the entire `creatures` array (`all`, i.e. `list`) when the grid query returns nothing. However: the grid is rebuilt every frame at 4772-4773 by adding *every* creature in `creatures` (not just active ones), and a creature querying its own position will always find at least itself in its own cell. So in steady-state operation the fallback is effectively unreachable — it only fires on the very first frame after the module loads (before `creatureGrid` has ever been populated) or in a pathological edge case where a creature's position doesn't correspond to any populated cell. **Correction:** this is not a persistent O(N²) hot path; it is a one-time (or near-never) cold-start fallback. Downgrading scout's severity assessment accordingly, though it's worth noting as fragile: if `creatureGrid.clear()`/rebuild timing ever changes (e.g. moved after the combat phase, or a new early-return path), the fallback would silently become live again on every frame.

**Ordering issue actually more relevant than the fallback:** the grid used by `enemyTarget` (called at 4751) and by `computeSteering`'s separation query (called at 4756-4770) is the grid built at the *end of the previous frame* (rebuild happens at 4772-4773, *after* both). So targeting/separation decisions are always one frame stale relative to current positions. Doesn't change complexity, but is a real behavioral-lag source worth knowing about if targeting ever looks "behind."

**Severity: Medium** (bounded per-call cost; the flagged O(N²) fallback path is real but not normally exercised)

---

## 3. Separation (creature-creature soft steering) — `computeSteering` (2311-2328)

**What it does:** Grid-queries nearby creatures, accumulates a repulsion vector scaled by `(sepRadius - d)/sepRadius` with an extra hard boost inside `MIN_GAP`. Radii differ for active melee opponents (`meleeRadius()`) vs. everyone else (`SEP_RADIUS` + `collisionRadius()`).

**Cost:** O(N) calls/frame (once per `lodShouldSim` creature, from 4756), each O(nearby) via the grid — confirmed no full-list fallback exists here (unlike `enemyTarget`/`forageObjectForCreature`), so this loop degrades cleanly to "just the grid says," but that also means it silently under-separates if the grid is stale/empty rather than falling back to correctness. Scout's "O(N²) dense" label is correct: as creatures cluster (grid cell 5.0, separation radius ~2.3-3+), `nearby` approaches N in a tight cluster.

**Why inefficient / WHY:**
- Same missing broad-phase tiering as collision resolution — cell size 5.0 is a single fixed constant shared by both use cases (see Finding 6), not tuned independently for separation's larger interaction radius vs. collision's tighter one.
- `collisionRadius()` called twice per neighbor pair-check (`this.collisionRadius()` once per creature per call, `o.collisionRadius()` once per neighbor) with no caching — see Finding 5.
- This query and the trunk-avoidance query (next finding) both run inside the same per-creature loop body but are two independent grid lookups into two different grids, each re-walking a 3x3 neighborhood — no shared/combined broad-phase pass.

**Severity: Medium-High** (scales with combat/forage clustering, which is exactly when the game is busiest)

---

## 4. Tree-trunk avoidance — `computeSteering` (2333-2346), backed by `trunkIndex.nearby` (`collision.js:93`)

**What it does:** Soft steering repulsion away from nearby trunks, same falloff shape as creature separation, folded into the same `_sep` accumulator. Backed by `resolveTrunks()` hard push-out elsewhere in `physicsStep` (out of this domain's scope).

**Correction to scout's O(N·T) label:** `nearbyTrunks` (wired in `environment-viewer.html:814` -> `trunkIndex.nearby`, implemented in `collision.js:77-101`) is **not** a linear scan of all T trunks. It's chunk-bucketed by the terrain's `chunkSize` (30 units — `terrain-system.js:14`) and only gathers the query point's chunk plus its 8 neighbors (a 90x90-unit area), i.e. bounded by *local* trunk density, not global forest size T. So the real cost is **O(N x k)** where k = trunks in ~8100 sq. units around each creature, not O(N x T). The scout's complexity label overstates the risk for large forests; it's already broad-phased correctly. This should be corrected in any downstream summary.

**Real inefficiency here (different from what the scouts flagged):** `collision.js:93` — `nearby(px, pz) { return gather(px, pz, []); }` — allocates a **brand-new array on every single call**, unlike `creatureGrid`/`objectGrid` queries elsewhere in `port-creature-system.js` which all reuse a single shared `_nearbyScratch` buffer (declared once at line 768, `.length = 0`'d before each reuse). Since `nearbyTrunks` is called once per `lodShouldSim` creature per frame (2334), this is N short-lived array allocations per frame purely for GC to reclaim — a straightforward, fixable inconsistency (the trunk index could take an `out` array parameter the same way `SpatialGrid.nearby` does).

**Severity: Low-Medium** (bounded cost confirmed, but avoidable allocation churn every frame)

---

## 5. Uncached per-pair invariants: `collisionRadius()` / `meleeRadius()` / `maxArmReach()` (1844-1856, 1861-1863)

**What it does:** `collisionRadius()` loops over `this.legs` taking `Math.max` of `Math.hypot(leg.restLocal.x, leg.restLocal.z)` for every leg, then combines with `plan.bodyScale`. `maxArmReach()` does the equivalent over `this.arms`. Both are called from the hottest loops in this domain: separation (2321, 2325), enemy/melee radius checks, and collision resolution (4227-4229) — every pair, every sub-step.

**Why this is a genuine inefficiency (not previously flagged by the scouts):** `leg.restLocal` and `this.plan.bodyScale` are set once at creature construction (verified — no `.restLocal.set(...)`/`.copy(...)` mutation sites exist anywhere in `port-creature-system.js`) and never change for the creature's lifetime. `collisionRadius()` is therefore a pure function of immutable per-creature data, yet it's recomputed from scratch — an O(legCount) reduction — on **every** neighbor comparison in both the separation loop and the collision-resolution loop, up to 5x/frame in the latter. For a creature with L legs and K nearby neighbors, that's O(L x K) work that could be O(1) with a cached value computed once at spawn (or once per frame, in the worst case where it must ever change).

**Cost:** Multiplies the per-pair cost of Findings 1 and 3 by leg count (typically 4-8), for zero behavioral benefit since the value never changes.

**Severity: Medium** (cheap to fix, meaningfully reduces the constant factor on the two hottest loops in this domain)

---

## 6. Spatial grid infrastructure — `SpatialGrid` (913-937), `creatureGrid`/`objectGrid` (938, 983)

**What it does:** Uniform-cell hash grid, cell size 5.0 for both creatures and objects. `clear()` + full rebuild every frame (creatures: 4772-4773; objects: `rebuildObjectGrid`, 1019-1024, called every frame at 4720). `nearby()` does a 3x3-cell walk and appends into a caller-supplied `out` array.

**Confirmed used everywhere it should be for this domain**, with the fallback-to-full-list caveat noted in Finding 2 (and the same pattern in `forageObjectForCreature`, 1260-1278, and the arm/object-reach query at 2760-2762 — out of strict domain scope but worth noting it's the same shared pattern, same near-unreachable fallback reasoning applies since `rebuildObjectGrid` runs every frame before any forage/reach query consumes it).

**Why inefficient / WHY:**
- **Full teardown every frame:** `clear()` calls `Map.clear()` (920), discarding every per-cell array outright. The next `add()` for each occupied cell allocates a brand-new `[]` (924-925). This means the number of *distinct occupied cells* worth of small-array allocations happens every single frame for both grids, purely GC churn — there's no pooling/reuse of the bucket arrays across frames despite the same cells usually being repopulated frame-to-frame.
- **Single fixed cell size (5.0) shared across two different consumers with different interaction radii** — creature separation/melee radii (~1-3 units, wants a tight query) and enemy-targeting/collision (similar) all share one grid tuned by one constant; no ability to independently tune query breadth per use case without also changing bucket density for the others.
- **Good practice already in place, worth preserving:** the module-level `_nearbyScratch` (768) is correctly reused (`.length = 0` then repopulated) across `forageObjectForCreature`, `enemyTarget`, `computeSteering`'s separation, `resolveCreatureCollisions`, and the arm-reach query — this is NOT an inefficiency, it's the one part of the grid-query path already avoiding per-call allocation. Contrast with Finding 4's trunk index, which does not follow this pattern.

**Severity: Low** (constant-factor GC pressure, not algorithmic; the cell-size-sharing point is more of a tuning limitation than a bug)

---

## 7. Per-frame behavior/forage/combat passes (orchestration, 4710-4816)

**What it does:** Sequential O(N) passes per frame: LOD (4642-4707) -> object grid rebuild (4720) -> forage assignment (4737-4749) -> combat (4751) -> eating (4752) -> forage-state + steering (4756-4771) -> creature-grid rebuild (4772-4773) -> physics/collision loop (4776-4788, up to 5x) -> render (4790-4805).

**Cost:** Each pass individually is O(N) (or O(N) x grid-bounded work per creature, per Findings 2-4). None of these orchestration passes themselves introduce new O(N²) behavior beyond what's already captured in Findings 1-4 — confirmed by reading the full `update(dt)` body rather than just the trace summary.

**Why it's still worth flagging:** the forage-assignment pass (4737-4749) and combat pass (4751) both iterate the *entire* `creatures` array even when `currentBehavior` isn't `'forage'`/`'combat'` for that creature's LOD tier — gated by `c.lodShouldSim`/`c.lodArmsActive` per-creature flags rather than skipped at the array level, so the loop itself is always O(N) even when most creatures are LOD-culled and do nothing inside. This is minor (the loop body short-circuits immediately via `continue`) but is a small constant-factor cost (array iteration + property reads) paid every frame regardless of how many creatures are actually simulating.

**Severity: Low**

---

## Corrections to the scouts' claims (summary)

| Scout claim | Verdict | Correction |
|---|---|---|
| O(N²) collision resolution (4219) | **Confirmed** | Also: runs up to 5x/frame specifically when frames are already slow (feedback loop); grid membership frozen across those 5 sub-steps. |
| O(N²) enemy targeting (2051-2069), "falls back to full list when grid empty" | **Technically true, practically unreachable** | Grid is always populated with every creature before combat/steering run in steady state; fallback only matters on frame 0 or if rebuild ordering changes. Real issue is one-frame-stale grid, not O(N²) fallback. |
| O(N·T) trunk avoidance (2333-2346) | **Overstated — corrected to O(N x k), k = local density** | `trunkIndex` is chunk-bucketed (30-unit chunks, 3x3 gather), bounded by local density not global trunk count T. Real inefficiency is a fresh array allocation per call (no scratch-buffer reuse), not complexity. |
| O(N²) separation (2313-2328) | **Confirmed** | Compounded by uncached `collisionRadius()`/`meleeRadius()` recomputation per pair (not previously flagged). |
| Grid cell size 5.0, rebuilt per frame, queried multiple times | **Confirmed** | Full `Map.clear()` + fresh per-cell array allocation every frame (creature grid + object grid); no bucket-array pooling. Single cell size shared across creature-separation, melee, and collision use cases. |

---

## Top offenders (ranked)

1. **`resolveCreatureCollisions` (4219-4261)** — O(N²)-leaning under density, amplified up to 5x/frame exactly when the frame is already running behind (accumulator catch-up), plus uncached `collisionRadius()`/`meleeRadius()` recomputation on every pair. Highest combined severity: algorithmic + feedback-loop + constant-factor waste all in one place.
2. **Separation loop in `computeSteering` (2311-2328)** — same O(N²)-under-density profile as #1, same uncached-radius constant-factor tax, runs every frame (not just sub-steps) for every active creature.
3. **Uncached `collisionRadius()`/`meleeRadius()`/`maxArmReach()` (1844-1863)** — pure functions of immutable per-creature data, recomputed from an O(legCount)/O(armCount) reduction on every pairwise check across both hottest loops (#1 and #2); cheapest fix here for the largest constant-factor win.
4. **Spatial grid full rebuild + array churn (913-937, 4772-4773, `rebuildObjectGrid` 1019-1024)** — GC pressure from tearing down and reallocating every occupied cell's bucket array every frame, for both `creatureGrid` and `objectGrid`.
5. **`trunkIndex.nearby` per-call array allocation (`collision.js:93`)** — N fresh array allocations/frame; complexity itself is fine (chunk-bounded), but doesn't follow the shared-scratch-buffer pattern used everywhere else in this domain.
6. **`enemyTarget` grid-empty fallback (2057) / `forageObjectForCreature` grid-empty fallback (1265)** — real O(N) fallback paths that are correctly guarded by grid rebuild ordering in steady state, but fragile to future refactors of the frame's rebuild sequencing.
