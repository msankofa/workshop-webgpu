# Locomotion & Physics — Performance Findings

Domain: `port-creature-system.js` fixed-timestep physics (`physicsStep`, `updateLegTarget`,
`scheduleSteps`, `applyBodyTerrainClearance`, support-polygon geometry). Scout files
(`scout/loco-locate.md`, `scout/loco-trace.md`) verified against source; corrections noted
inline where the scouts' call counts or claims were off.

All line numbers refer to `port-creature-system.js` unless another file is named.

---

## 1. `terrainHeight()` cost is likely far higher than the scouts assumed

- **Where** — `environment-viewer.html:638-648` (the `terrainHeight` closure passed into
  `createPortCreatureSystem`), backed by `map-collision.js:117-123` (`raycastDown`).
- What it does: when a hand-authored map is loaded (`loadedMap` set — true for the
  `maps/workshop/*.glb` exports currently in this working tree), every `terrainHeight(x,z)`
  call does a **`THREE.Raycaster.intersectObject()` against a BVH collider mesh**, not an
  O(1) analytic lookup. Only the procedural/no-map path (`terrainSystem.getHeight` →
  `terrainHeightAt` in `terrain-field.js:25-32`, a closed-form sum of ~6 sines/cosines) is cheap.
- Cost: `Raycaster.intersectObject` allocates a fresh results array and, per hit, a fresh
  `THREE.Vector3` for the intersection point (three.js internals) — on top of the BVH
  traversal itself. This happens **once per `terrainHeight()` call**, and the locomotion
  code calls it 40-60+ times per creature per fixed step (see finding 2 and 4 below).
- WHY it matters here even though the raycaster lives outside this file: the scouts'
  "10 terrainHeight() calls per leg" framing implicitly treats each call as free. It is not,
  when a workshop map is active — which is exactly the mode currently being exercised
  (see the untracked `maps/workshop/terrain-generator-export-*` files in git status). The
  call-count multipliers below (10x for full IK scan, 2x duplicate body-clearance call)
  translate directly into raycast + allocation multipliers, not just transcendental-math
  multipliers.
- Severity: **High** (context multiplier — makes every other finding in this doc worse
  whenever a custom map is loaded).

---

## 2. Full foot-scan: 10 `terrainHeight()` calls per leg per step — confirmed

- **Name** — `updateLegTarget` full 3×3 grid scan — `port-creature-system.js:2473-2532`
  (grid loop at `2500-2519`).
- What it does: computes rest position (1 terrain sample, line 2477), then for `fullScan`
  scans a 3×3 grid around the look-ahead point (9 more terrain samples, line 2506),
  scoring each cell by squared distance to look-ahead plus a back-facing penalty, keeping
  the best in-bounds/in-comfort cell.
- Cost: exactly **10 `terrainHeight()` calls** per leg per fixed step, confirmed against
  the scout's count. Cheap-mode (`!fullScan`) is exactly **2 calls** (rest + look-ahead),
  also confirmed. Gated by `fullFootScan = this.lodFullIk || this.lodDebugActive ||
  this.forceFootTargetRefresh` (line 2550) — so the 10x path is already LOD-restricted to
  near-camera creatures (`lodTier === 0 && d2 <= ikSq`), which is a real existing
  optimization, correctly noted by the scouts.
- WHY inefficient: the grid scan is brute-force nearest-cell search with no early-out —
  it always evaluates all 9 cells even after finding a perfect-score cell. The 3×3
  neighborhood is also fixed resolution (`gait.scanGrid` spacing); there's no adaptive
  refinement (e.g., coarse-then-fine) to reduce sample count on flat ground, which is the
  common case. On flat/gently-sloped terrain, 9 of the 10 samples return functionally the
  same answer as the single look-ahead sample the cheap path already uses.
- Severity: **Medium** (already LOD-gated, but still a 5x tax on every near-camera,
  full-detail creature, every fixed step, every leg — and each sample is a raycast when a
  map is loaded, per finding 1).

---

## 3. Body-clearance 9-point sampling is done **twice** per fixed step — scout under-reported this

- **Name** — `applyBodyTerrainClearance` — `port-creature-system.js:2215-2238`, called from
  two places: `physicsStep` line **2673** (inside the per-creature step) and again,
  unconditionally, from the outer accumulator loop at line **4783**
  (`for (const c of creatures) if (c.lodShouldSim) c.applyBodyTerrainClearance();`).
- What it does: builds 9 body-relative sample points (1 center + 4 corners + 4
  edge-midpoints, confirmed 9 points matching the scout's count), rotates each by the
  current pitch/yaw/roll quaternion, samples `terrainHeight` at each (9 calls), and lifts
  the body by the maximum terrain intrusion found.
- Cost: 9 `terrainHeight()` calls **per call**, and the function is called **twice per
  creature per fixed step** — once before `resolveCreatureCollisions` runs (inside
  `physicsStep`), once after (in the `update()` accumulator loop). That's **18
  `terrainHeight()` calls per creature per fixed step**, not 9. The scouts' locate doc
  lists both call sites (`2215-2238` and the bridge/loop at `4780-4786`) but the trace doc's
  frequency table doesn't call out that this is the *same* 9-point sampler running twice —
  it's listed once under "per creature per fixed step" without the ×2 multiplier.
- WHY inefficient: the second call exists to re-clear the body after
  `resolveCreatureCollisions` nudges `pos.x/z` (collision only pushes horizontally, per
  `port-creature-system.js:4244-4247`). But it reruns unconditionally for every simulated
  creature even when that creature had zero collision overlap this step (the common case
  with sparse creature counts) — there's no cheap "did my horizontal position actually
  change" gate before paying for another 9-sample terrain query + quaternion rebuild.
- Severity: **High** (doubles a already-nontrivial per-step cost for every creature, every
  fixed step, unconditionally).

---

## 4. Support-polygon geometry: convex hull + point-in-poly recomputed from scratch every step, with heap churn

- **Name** — `convexHull` / `pointInPoly` / `nearestOnPoly` — `port-creature-system.js:594-639`,
  invoked per creature per fixed step from `physicsStep:2599-2631`.
- What it does: gathers grounded feet into a preallocated scratch buffer (`_groundedBuf`,
  16-entry pool, line 767 — good, no per-call allocation there), then for `groundedCount
  >= 2` runs a Graham-scan convex hull, tests whether the center-of-mass projects inside
  it, and if not, finds the nearest polygon edge to derive the support normal.
- Cost: runs once per creature per fixed step whenever ≥2 feet are grounded — which is the
  overwhelming majority of steps for any multi-legged gait (quadrupeds are rarely down to
  0-1 grounded feet). For a typical 4-legged creature this is effectively "every step."
- WHY inefficient: `convexHull` (line 594) copies the grounded points into a **new array**
  `p` every call, sorts it with an **inline comparator closure** (`(a,b) => ...`, a new
  function object per call), builds two more **new arrays** (`lo`, `up`) via push/pop, and
  returns `lo.concat(up)` — a **fifth new array**. `cr` (the cross-product helper, line
  597) is also a fresh closure per call. None of this is scratch-buffer'd, unlike
  `_groundedBuf` one level up — so the memory-conscious pattern used for the leg buffer is
  abandoned right at the geometry step that needs it most. `poly = []` (line 2611) is also
  allocated unconditionally at the top of the block even when `groundedCount < 2` and the
  hull is never computed. For a 4-legged creature this is 4-5 small array/closure
  allocations × N creatures × fixed steps/frame — pure GC pressure with no algorithmic
  payoff (hull sizes are ≤4-8 points, so the allocations, not the O(n log n) sort, dominate
  wall time).
- Severity: **Medium** (small n keeps absolute cost low per call, but it's unconditional,
  every step, every creature, and 100% avoidable with pooled arrays).

---

## 5. Leg-partner topology (`diagonalPartners` / `adjacentPartners` / `legBy`) recomputed every step from *static* data — not flagged by scouts at all

- **Name** — `diagonalPartners` (`2368-2382`), `adjacentPartners` (`2384-2393`), `legBy`
  (`2364-2366`), consumed by `canWalkLegMove` (`2399-2413`) and `canGallopLegMove`
  (`2415-2429`), which are called from `scheduleSteps` (`2431-2463`) — once per leg per
  creature per fixed step.
- What it does: for a given leg, finds its "same row, opposite side" partner and its
  "diagonal" partners (adjacent row, opposite side) to decide whether it's allowed to
  start a step this frame (gait cross/same-pair cooldown rules).
- Cost: `diagonalPartners` alone, **per call**, does: `this.legs.map(l => l.row)` (new
  array) → `new Set(...)` → `.sort()` → `.indexOf()` → `new Set([prev, next])` (second new
  Set) → a `for...of` loop calling `legBy` (an `Array.find`, i.e. a linear scan) for each
  candidate. `adjacentPartners` allocates its own `partners = []` and does another linear
  scan plus a `legBy` call. `canGallopLegMove`'s `crossRows` (line 2426) does a fresh
  `this.legs.filter(...)` every call too.
- WHY inefficient: **leg row/side layout is fixed at creature construction time and never
  changes** — a leg's diagonal and adjacent partners are topological constants for the
  lifetime of the creature. This is recomputed from scratch, with 2-3 heap allocations
  (arrays + Sets) each, **every single leg, every single fixed step**, for data that could
  be computed once in the constructor and cached as a plain array reference on the leg
  object (e.g., `leg.diagonalPartners`, `leg.adjacentPartners`, `leg.rowMate`). This is the
  single clearest "redundant per-step recomputation of invariant data" in the locomotion
  code and the scouts' inventory missed it entirely (it's not mentioned in either
  `loco-locate.md` or `loco-trace.md`).
- Severity: **High** (pure waste — zero algorithmic reason this can't be a one-time
  precomputation; multiplied by legs × creatures × fixed steps/frame).

---

## 6. No caching/memoization across steps for stationary or slow-changing state

- **Name** — general pattern across `updateLegTarget` (rest-position resample) and
  `applyBodyTerrainClearance` (9-point resample).
- What it does: every fixed step, for every simulated leg/body, terrain height is
  resampled at the current position — regardless of whether the creature actually moved
  enough since the last sample to change the answer.
- Cost: N/A (this is a missing-optimization finding, not a hot-path cost by itself).
- WHY inefficient: for `behavior === 'stay'` (currentMaxSpeed forced to 0, line 2360) or
  creatures that are simply idle/blocked, `pos` and `yaw` don't change between fixed
  steps, so the rest-position terrain sample (line 2477) and the 9-point body-clearance
  sample (2215-2238) recompute an answer that is bit-for-bit identical to the previous
  step's. There is no "position delta below epsilon → reuse last sample" guard anywhere
  in this code path. This compounds with finding 1: every one of these redundant
  resamples is a raycast when a map is loaded.
- Severity: **Low-Medium** (only matters for creatures that are actually idle; wandering/
  combat/forage creatures are usually moving enough that resampling is legitimate, but
  `stay` behavior and off-screen/culled-but-still-`lodShouldSim` creatures get zero
  benefit from the current code).

---

## Corrections to the scouts' claims

- **Confirmed accurate**: cheap scan = 2 terrainHeight calls, full scan = 10 (loco-trace.md
  line 15-16); 3×3 grid scan location and scoring (loco-locate.md line 33); convex
  hull/point-in-poly/nearest-edge locations (loco-locate.md lines 18-20, 39-41); 9-point
  body clearance sampling and point count (loco-locate.md line 43).
- **Under-reported**: the trace doc's frequency table (loco-trace.md lines 20-34) counts
  `applyBodyTerrainClearance` once per creature per fixed step in the narrative
  (`4783`), but doesn't note that `physicsStep` *also* calls it internally at line 2673 —
  so the real cost is 2× what a reader would infer from the table (see finding 3).
- **Missing entirely**: leg-partner topology recomputation (`diagonalPartners`,
  `adjacentPartners`, `legBy` — finding 5) is not mentioned in either scout doc, despite
  being called once per leg per fixed step and being pure allocation waste on static data.
- **Missing context**: neither scout doc mentions that `terrainHeight()` itself is a BVH
  raycast (with per-call heap allocations) rather than O(1) math when a hand-authored map
  is loaded (finding 1) — this changes the severity assessment of every call-count finding
  in their docs from "some transcendental math" to "some transcendental math, or a
  raycast + allocations, depending on map mode."

---

## Top offenders (ranked)

1. **`applyBodyTerrainClearance` called twice per fixed step** (finding 3) — 18 rather than
   9 terrain samples per creature per fixed step, unconditionally, with no gate on whether
   collision resolution actually moved the creature.
2. **`terrainHeight()` raycast cost when a map is loaded** (finding 1) — turns every one of
   the ~50-60 terrain samples per creature per fixed step into a BVH raycast with
   per-call heap allocations, not a cheap analytic call. This is a multiplier on every
   other finding, and is the most consequential fact the scouts' call-count tables leave
   out.
3. **Leg-partner topology recomputed every step** (finding 5) — `diagonalPartners` /
   `adjacentPartners` / `legBy` re-derive static, constructor-time-invariant data via
   fresh arrays and `Set`s every leg, every fixed step; trivially cacheable, currently
   uncached, and not on the scouts' radar at all.
4. **Convex hull / support-polygon allocations** (finding 4) — 4-5 small array/closure
   allocations per creature per fixed step for a hull of ≤8 points; GC pressure with no
   algorithmic justification.
5. **Full 3×3 foot-scan brute force** (finding 2) — already LOD-gated (mitigating factor),
   but still a flat 5x tax with no early-out or adaptive resolution for near-camera
   creatures.
6. **No step-to-step memoization for idle/stationary creatures** (finding 6) — smallest
   in isolation, but a straightforward win for `stay`/idle creatures that currently get
   zero benefit from not moving.
