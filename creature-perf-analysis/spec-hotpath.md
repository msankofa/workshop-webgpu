# Optimization spec — CPU per-frame hot path (physics / locomotion / steering / collision)

Scope: `port-creature-system.js` fixed-timestep physics + steering/collision, plus the
`terrainHeight` closure in `environment-viewer.html` and the trunk index in `collision.js`.
Appearance / IK-render is out of scope (covered by the other spec). All line numbers are as
read on the current working tree.

READ-ONLY analysis. Nothing below has been implemented.

---

## Findings validation

Every anchor cited by the two analysts was re-read from source. Verdicts:

| Analyst claim | Verdict | Note |
|---|---|---|
| `applyBodyTerrainClearance` called twice per fixed step (loco #3) | **Confirmed** | `physicsStep:2673` + accumulator loop `4783`. Both unconditional, 9 samples each → 18/creature/step. |
| `terrainHeight()` is a BVH raycast under map mode (loco #1) | **Confirmed, but the "currently being exercised" claim is overstated** | `environment-viewer.html:638-648` → `map-collision.js:117-123` `raycastDown` → `intersectObject` (array + Vector3 alloc per hit). This only happens when a map is actually loaded (`loadedMap && mapCollider`). The untracked `maps/workshop/*.glb` files in `git status` do **not** prove a map is loaded at runtime — that depends on map-config/URL. Treat this as a **conditional multiplier**, not an always-on cost. |
| Leg-partner topology recomputed every step (loco #5) | **Confirmed** | `diagonalPartners:2368` / `adjacentPartners:2384` / `legBy:2364` allocate Sets/arrays + `Array.find` per call; consumed by `canWalkLegMove`/`canGallopLegMove` via `scheduleSteps:2584` (verified inside `physicsStep`). Row/side/`restLocal` are set once at construction (`1479-1483`). Pure invariant recompute. |
| `collisionRadius()`/`meleeRadius()`/`maxArmReach()` uncached (steer #5) | **Confirmed, with nuance** | `collisionRadius:1844` loops legs; `maxArmReach:1852` loops arms; `meleeRadius:1861` is only a `Math.max` of `bodyScale` (already cheap — no loop). Inputs (`leg.restLocal`, `plan.bodyScale`, `arm.reach`) are immutable post-construction. Called per-pair in `resolveCreatureCollisions:4227-4229` and per-neighbor in separation `2320-2325`. |
| Support-polygon convex-hull heap churn (loco #4) | **Confirmed** | `convexHull:594` allocates 5 arrays + 2 closures per call; `poly=[]` at `2611` allocated even when `groundedCount<2`. Runs whenever ≥2 feet grounded (≈every step). Not in the task's required list but in-domain and worthwhile — included below as item 8. |
| Trunk avoidance is O(N·T) (steer #4) | **Corrected — it is O(N·k)** | `collision.js:77-101` is chunk-bucketed (3×3 of 30-unit chunks). Analyst's correction is right. The real issue is `nearby(px,pz){ return gather(px,pz,[]); }` (`collision.js:93`) allocating a fresh array per call; wired live at `environment-viewer.html:814`. |
| Collision/separation O(N²) under density (steer #1,#3) | **Confirmed as constant-factor-dominated** | Grid (`SpatialGrid`, cell 5.0) mitigates but degenerates in clusters. The *algorithmic* O(N²) under a tight swarm is inherent to pairwise push-apart; the practical, safe win is the constant-factor radius cache (item 4), not a broad-phase rewrite. |
| Sub-step "negative feedback loop" (steer #1) | **Confirmed mechanism, framing overstated** | `while(acc>=FIXED && steps<5)` (`4780`) re-runs collision + the second clearance up to 5×, and only when already behind. But this is standard fixed-timestep catch-up, and the spiral guard already exists (`if (steps===5) acc=0`, `4787`). The fix is to make each sub-step cheaper (items 1+4) and optionally thin the per-sub-step work — not to restructure the loop. |
| `enemyTarget` grid-empty → full-list fallback is a live O(N²) path (scout) | **Rejected (analyst already downgraded — agreed)** | `enemyTarget:2057` fallback is unreachable in steady state (grid rebuilt with all creatures each frame). Not spec'd. |
| Full 3×3 foot-scan brute force (loco #2) | **Confirmed but already LOD-gated; not spec'd here** | `fullFootScan` (`2550`) is gated to near-camera full-IK creatures. Real existing mitigation. Out of this spec's required list. |
| No idle/`stay` memoization (loco #6) | **Confirmed, low value** | Folds naturally into item 1's dirty-gate; not spec'd as a standalone change. |

Net: the two analysts are accurate. The only material corrections are (a) the raycast cost is
**conditional on map mode**, not proven-active, and (b) the sub-step "feedback loop" is a real
amplifier but not a structural bug — its fix is to shrink per-sub-step cost.

---

## 1. Double `applyBodyTerrainClearance` per fixed step

**Problem.** `applyBodyTerrainClearance()` (`2215-2238`) samples terrain at 9 body-relative
points and lifts the body. It runs once inside `physicsStep` (`2673`) and again,
unconditionally, in the accumulator loop after `resolveCreatureCollisions` (`4783`) — 18
terrain samples/creature/fixed step. The second call exists to re-clear after collision
resolution nudges `pos.x/z` (`4244-4247`), but collision resolution moves only a minority of
creatures on a typical sparse step, so the re-clear is wasted for everyone who had zero overlap.

**Proposed change.** Gate the second clearance on whether the creature's horizontal position
actually changed during `resolveCreatureCollisions`.
- In `resolveCreatureCollisions` (`4219-4261`), set a per-creature dirty flag (e.g.
  `a._collisionMoved = true; b._collisionMoved = true;`) inside the `overlap > 0` branch
  where the push is applied (`4243-4247`).
- Reset the flag to `false` at the top of each sub-step (cheap loop, or clear it as part of
  the existing `_activeCreatures` build).
- Change the loop at `4783` to `for (const c of creatures) if (c.lodShouldSim && c._collisionMoved) c.applyBodyTerrainClearance();`
- Note the set mismatch: `resolveCreatureCollisions` runs over `_activeCreatures`
  (`lodVisible && lodShouldSim`) while the `4783` loop runs over the broader `lodShouldSim`
  set. Only creatures that were candidates for collision can be dirtied, so the gate is
  strictly correct: non-active creatures keep exactly the clearance from their `physicsStep`
  call (`2673`), which is unchanged.

**Expected win.** Eliminates 9 terrain samples/creature/sub-step for every creature that did
not collide this sub-step — the common case at low/medium density. Halves body-clearance
terrain sampling in the typical frame; under map mode (item 2) that is 9 raycasts saved per
non-colliding creature per sub-step.

**Risk / correctness.** Low. Correctness hinges on dirtying *both* creatures on every push and
clearing the flag each sub-step. Edge case: a creature pushed by `resolveTrunks` inside
`physicsStep` (`2663-2666`) is already re-cleared by the `2673` call in the same
`physicsStep`, so it does not need the flag. No behavioral change for colliding creatures.

**Effort.** S.

---

## 2. Hidden BVH-raycast cost of `terrainHeight()` under map mode

**Problem.** When a hand-authored map is loaded, `terrainHeight(x,z)`
(`environment-viewer.html:638-648`) does `mapCollider.raycastDown(...)` →
`_raycaster.intersectObject(colliderMesh, false)` (`map-collision.js:117-123`), which allocates
a results array and a `Vector3` per hit on top of BVH traversal — every call. The locomotion
hot path issues ~40-60 `terrainHeight` calls/creature/fixed step (leg rest + scan + floor +
9-point clearance ×N), so under map mode each of those is a raycast + allocation, not the
O(1) sine-sum of the procedural path (`terrain-field.js:25-32`). This is a multiplier on every
other terrain-sampling finding.

**Proposed change.** Bake a CPU-side heightfield from the collider once at map-load time and
replace the per-call raycast with a bilinear grid lookup.
- There is already a `bakeHeightTexture(heightFn, bounds, resolution)` helper at
  `environment-viewer.html:649` that rasterizes a height function into a `Float32Array` for the
  GPU. Add a parallel CPU path: at map load, sample `raycastDown` once per grid cell (e.g.
  512×512 over the map bounds) into a retained `Float32Array`, then make `terrainHeight` do a
  bilinear read from that array instead of ray-casting per call. Fall back to `loadedMap.heightAt`
  (`648`) outside the baked bounds, as today.
- This mirrors what the procedural path already does (analytic O(1) lookup) and removes the
  raycaster from the hot path entirely.
- Cheaper interim alternative if baking is deferred: a per-frame memo cache keyed on rounded
  `(x,z)` shared across a single `update(dt)` — many hot-path samples for one creature land at
  near-identical coordinates within a frame. This is smaller and does not fix cross-creature
  redundancy, so baking is preferred.

**Expected win.** Under map mode, converts ~40-60 raycasts+allocations/creature/fixed step into
~40-60 array reads — the single largest hot-path win when a map is active. No effect in
procedural mode (already O(1)).

**Risk / correctness.** Medium. Baking trades exactness for grid resolution: at 512² over a
large map, sub-cell terrain features are smoothed vs. the raycast. Acceptable for foot/body
clearance (already tolerance-padded via `FOOT_GROUND`/`BODY_VOLUME_CLEAR`), but validate
against steep/thin map geometry. Memory: 512²×4B ≈ 1 MB retained per map. Bake cost is a
one-time load hitch (512² raycasts) — do it off the first-frame critical path if it stalls load.

**Effort.** M (bake path) / S (per-frame memo interim).

---

## 3. Cache leg-partner topology at construction

**Problem.** `diagonalPartners(leg)` (`2368-2382`) and `adjacentPartners(leg)` (`2384-2393`)
re-derive a leg's step-gating partners from `this.legs` on every call — building a
`this.legs.map(l=>l.row)` array, a `Set`, a `.sort()`, `.indexOf()`, a second `Set`, and
`legBy()` (`2364`, an `Array.find` linear scan) per candidate. `canGallopLegMove` (`2426`) also
does `this.legs.filter(...)` for `crossRows`. These run per leg via `scheduleSteps` (`2584`),
once per creature per fixed step. Row/side layout is fixed at construction (`1479-1480`) and
never mutates — this is pure invariant recompute with 2-3 heap allocations per leg per step.

**Proposed change.** Precompute topology once, right after `this.legs` is built (the
`plan.legs.map(...)` at `1460` returns the array; add a second pass after assignment since
partners reference sibling legs):
- For each leg store plain array references: `leg.rowMate` (result of `legBy(row, -side)`),
  `leg.diagonalPartners` (current `diagonalPartners` result), `leg.adjacentPartners` (current
  `adjacentPartners` result), and `leg.crossRows` (`this.legs.filter(l => Math.abs(l.row-leg.row)===1)`).
- Replace the call sites in `canWalkLegMove` (`2403,2407`), `canGallopLegMove` (`2420,2426`)
  with the cached fields. Keep `legBy`/`diagonalPartners`/`adjacentPartners` as the builders
  used only during the one-time precompute.

**Expected win.** Eliminates ~4-6 small array/Set allocations + several linear scans per leg
per fixed step (e.g. an 8-leg creature at up to 5 sub-steps → ~160-240 alloc-and-discard
operations/creature/frame removed). Pure GC-pressure and constant-factor reduction, zero
behavior change.

**Risk / correctness.** Very low. The only invariant to respect: topology must be rebuilt if
legs are ever added/removed at runtime. Grep confirms `this.legs` is assigned once at
construction and never mutated — if that ever changes, add a `rebuildLegTopology()` call at
the mutation site.

**Effort.** S.

---

## 4. Cache `collisionRadius()` / `maxArmReach()` (and memo `meleeRadius()`)

**Problem.** `collisionRadius()` (`1844-1849`) does an O(legCount) `Math.max`-reduction over
`leg.restLocal`; `maxArmReach()` (`1852-1856`) the same over `arm.reach`. Both are pure
functions of immutable per-creature data, yet recomputed on every pairwise check:
`resolveCreatureCollisions` calls `a.collisionRadius()+b.collisionRadius()` per pair per
sub-step (`4229`), and separation calls `this.collisionRadius()+o.collisionRadius()` per
neighbor (`2321,2325`), plus `this.collisionRadius()` again per trunk (`2338,2342`). For a
creature with L legs and K neighbours that is O(L·K) work per creature per pass for a constant.
(`meleeRadius()` is already a cheap `Math.max` with no loop, but memoizing it too keeps the
call sites uniform.)

**Proposed change.** Compute once at construction and store as fields.
- After `this.legs`/`this.arms` are built, set `this._collisionRadius = collisionRadius()`,
  `this._maxArmReach = maxArmReach()`, `this._meleeRadius = meleeRadius()`.
- Replace the hot-path call sites (`2321,2325,2338,2342`, `4227-4229`) with the cached fields.
- Keep the methods as the one-time computation source. If any input can ever change at runtime
  (none found — no `.restLocal.set/.copy`, no `arm.reach` mutation, no `bodyScale` mutation),
  recompute the field at that mutation site.

**Expected win.** Removes the per-pair O(legCount)/O(armCount) reduction from the two hottest
loops in the domain, multiplying down their constant factor by ~4-8× on the radius term.
Directly shrinks per-sub-step collision cost, which compounds with the 5× catch-up (item 5).

**Risk / correctness.** Very low, contingent on the immutability assumption (verified). Guard
with the same "recompute on mutation" note as item 3.

**Effort.** S.

---

## 5. Sub-step collision amplification (5× catch-up)

**Problem.** The accumulator loop (`4780-4786`) runs `physicsStep` + `resolveCreatureCollisions`
+ the second `applyBodyTerrainClearance` up to 5× per frame, engaging exactly when the frame is
already behind (GC pause, tab resume, stutter). Each extra sub-step re-pays the most expensive
passes, worsening the next frame. Secondary: the creature grid is rebuilt once *before* the loop
(`4772-4773`), so all up-to-5 collision passes reuse frozen bucket membership even though
`physicsStep` moves `pos` between passes (minor staleness at cell size 5.0).

**Proposed change.** This is an amplifier, not a structural bug — attack the per-sub-step
constant factor, don't restructure the loop. In priority order:
1. Land items 1 and 4 first — they make each sub-step materially cheaper (gated second
   clearance + cached radii), which is the highest-leverage, zero-risk mitigation.
2. Optionally thin per-sub-step work: run `resolveCreatureCollisions` + the second clearance
   only on the *final* catch-up sub-step rather than every one. During multi-step catch-up,
   intermediate interpenetration is invisible (not rendered), and a single resolve at the end
   corrects the accumulated position. This is a behavior change (fast closers could
   interpenetrate deeper mid-catch-up) so gate it behind a flag and validate combat clustering.
3. Do **not** rebuild the grid inside the loop — that adds cost in the exact slow-frame case
   the loop is trying to survive. Accept the documented staleness.

**Expected win.** Items 1+4 already remove most of the per-sub-step cost. Option 2 removes up
to 4 of 5 collision + clearance passes during catch-up frames specifically, flattening the
stutter-amplification. Steady 60 FPS (1 sub-step/frame) is unaffected either way.

**Risk / correctness.** Option 1: none. Option 2: medium — changes contact behavior during
catch-up; needs playtest under combat swarm. Keep the existing `steps===5 → acc=0` spiral
guard (`4787`) as-is.

**Effort.** S (items 1+4 dependency) / M (option 2, gated).

---

## 6. Separation / collision O(N²) under density

**Problem.** Both `resolveCreatureCollisions` (`4219`) and separation in `computeSteering`
(`2311-2328`) query a uniform grid (cell 5.0). Under a tight cluster (combat convergence,
forage swarm around few objects) the 3×3 neighbour walk approaches N per query, i.e. O(N²)
total. One fixed cell size serves both consumers despite different interaction radii.

**Proposed change.** Prefer constant-factor and bounded fixes over a broad-phase rewrite:
- **Primary:** item 4 (cached radii) removes the per-pair O(legCount) tax that currently
  multiplies this O(N²) region — the biggest realistic win without new data structures.
- **Optional, cheap:** cap neighbour work per query. `SpatialGrid.nearby` already appends into
  a caller `out` array; add an optional max-count so a pathologically dense cell doesn't force
  an unbounded inner loop (soft cap — under extreme swarm, resolving against the nearest K
  neighbours per sub-step still converges over frames). Behavior change; gate + validate.
- **Larger, deferred:** independent cell sizes for the separation grid (larger interaction
  radius) vs. a collision grid (tighter), instead of the single shared 5.0. This is a genuine
  algorithmic tuning improvement but requires a second grid rebuild per frame (more base cost)
  — only worth it if profiling shows dense-cluster queries dominating. Effort L.

**Expected win.** Item-4 constant-factor reduction is the reliable win here. The neighbour cap
bounds worst-case cluster cost. True sub-quadratic behavior in a single tight cluster is not
achievable without changing the contact model (pairwise push-apart is inherently O(pairs)).

**Risk / correctness.** Constant-factor path: none. Neighbour cap: medium (under-resolves in
extreme density; converges across frames). Dual-grid: medium + adds per-frame rebuild cost.

**Effort.** S (via item 4) / M (neighbour cap) / L (dual-grid).

---

## 7. Trunk-avoidance scratch-buffer allocation

**Problem.** `computeSteering` calls `nearbyTrunks(this.pos.x, this.pos.z)` (`2334`), wired at
`environment-viewer.html:814` to `trunkIndex.nearby`, which is
`nearby(px,pz){ return gather(px,pz,[]); }` (`collision.js:93`) — a brand-new array allocated
per call. Called once per `lodShouldSim` creature per frame → N short-lived arrays/frame purely
for GC, inconsistent with `SpatialGrid.nearby`'s caller-supplied `out` pattern used everywhere
else in the domain.

**Proposed change.** Give `trunkIndex.nearby` an `out`-array parameter like `SpatialGrid.nearby`.
- Change `collision.js:93` to `nearby(px, pz, out = []) { out.length = 0; return gather(px, pz, out); }`
  (keeping the default `[]` preserves existing callers; `resolve` at `95-99` is unaffected).
- In `computeSteering`, pass a dedicated module-scope scratch (e.g. a new `_trunkScratch`, not
  the creature `_nearbyScratch` — though by line `2334` the separation loop over
  `_nearbyScratch` has finished, a separate buffer is clearer and future-proof against
  reordering).

**Expected win.** Removes N array allocations/frame (one per arm-active/sim creature) — pure
GC-pressure reduction. Complexity already fine (chunk-bounded), so no algorithmic change.

**Risk / correctness.** Very low. The only caveat is buffer aliasing — use a distinct scratch
from the creature-separation query to avoid mid-loop clobbering if call order ever changes.

**Effort.** S.

---

## 8. Convex-hull / support-polygon allocation (in-domain bonus)

**Problem.** `convexHull(pts, count)` (`594-612`) allocates 5 arrays (`p`, `lo`, `up`, the
`slice`-free copy, and `lo.concat(up)`) plus 2 fresh closures (`cr`, the sort comparator) per
call, and `poly = []` (`2611`) is allocated even when `groundedCount < 2` and unused. This runs
whenever ≥2 feet are grounded — effectively every fixed step for any multi-legged gait. Hull
size is ≤8, so allocation, not the O(n log n) sort, dominates.

**Proposed change.** Pool the hull working set, mirroring the existing `_groundedBuf` pattern
(`767`).
- Hoist `cr` and the comparator to module scope (stateless — no per-call closure needed).
- Use module-scope reusable arrays for `lo`/`up`/output, `.length = 0` before use, and have
  `convexHull` write into a passed output array instead of returning `lo.concat(up)`.
- Move `let poly = []` (`2611`) below the `groundedCount >= 2` guard, or point it at the pooled
  output only when the hull is actually computed.
- Watch the debug branch (`2681-2688`) which reads `poly` — keep it valid (empty pooled array
  when hull not computed).

**Expected win.** ~5 array + 2 closure allocations/creature/fixed step removed for any grounded
multi-leg creature. GC-pressure reduction; no algorithmic change (hull is already tiny).

**Risk / correctness.** Low-medium. Pooled arrays mean the returned `poly` is only valid until
the next `convexHull` call — fine within a single `physicsStep`, but the debug snapshot at
`2688` does `poly.map(p => new THREE.Vector3(...))` (copies out immediately), so it is safe.
Verify no reference to `poly` outlives the step.

**Effort.** S-M.

---

## Ranking (impact ÷ effort)

1. **Item 4 — cache `collisionRadius`/`maxArmReach`** (S). Largest constant-factor win on the
   two hottest loops; also the primary lever for items 5 and 6. Zero behavior risk.
2. **Item 1 — gate the second `applyBodyTerrainClearance`** (S). Halves body-clearance terrain
   sampling in the typical frame; multiplies hard under map mode. Zero behavior risk.
3. **Item 3 — cache leg-partner topology** (S). Removes per-leg-per-step Set/array/find churn
   for pure invariant data. Zero behavior risk.
4. **Item 2 — bake CPU heightfield for map mode** (M). Biggest single win *when a map is
   loaded*, but conditional and higher effort/risk (resolution trade-off, bake hitch). Ranked
   below the free constant-factor wins because its payoff is mode-dependent.
5. **Item 7 — trunk `nearby` out-param** (S). Small, clean GC win; trivial.
6. **Item 8 — pool convex-hull scratch** (S-M). Steady GC-pressure win; slightly more care
   around the debug branch and pooled-array lifetime.
7. **Item 5 — sub-step amplification** (S for the free part / M gated). Mostly resolved for
   free once items 1+4 land; option 2 is a gated behavior change, defer.
8. **Item 6 — density O(N²)** (S via item 4 / L for real broad-phase). Take the free
   constant-factor portion via item 4; defer the neighbour-cap and dual-grid work behind
   profiling evidence.

Do items 1, 3, 4, 7 first — all Small, all zero-behavior-risk, and together they cut the
per-sub-step constant factor that everything else amplifies. Item 2 is the high-value
map-mode-specific follow-up. Items 5, 6, 8 are refinements gated on profiling / playtest.
