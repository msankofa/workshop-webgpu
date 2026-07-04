# Creature Performance — Consolidated Implementation Plan

Synthesized 2026-07-04 from five inputs: `results-locomotion.md`, `results-steering.md`,
`results-appearance.md`, `spec-hotpath.md`, `spec-appearance-arch.md`. Where a spec corrected
an analyst finding, the spec's resolution is taken as authoritative (they re-read every anchor);
disagreements are noted explicitly in "Resolved disagreements" below.

All line numbers refer to `port-creature-system.js` unless another file is named. Nothing here
has been implemented; this is the single authoritative work order.

---

## Resolved disagreements & corrections (authoritative record)

| Topic | Analyst position | Spec resolution (adopted) |
|---|---|---|
| Is map-mode raycast cost currently active? | Locomotion results (#1) claimed the workshop `*.glb` files in git status prove map mode "is exactly the mode currently being exercised"; appearance spec (Change B) repeats "current default in this tree". | **Hot-path spec is right: conditional, not proven.** Untracked map files don't prove a map loads at runtime — depends on `map-config`/URL (`loadedMap && mapCollider`). Treat the BVH-raycast `terrainHeight` cost as a *conditional multiplier*. Confirm at runtime before investing in Phase 3 item 3.1 (heightfield bake). |
| Sub-step "negative feedback loop" | Steering results (#1) framed the 5× accumulator catch-up as a structural bug. | **Mechanism confirmed, framing overstated.** Standard fixed-timestep catch-up with an existing spiral guard (`steps===5 → acc=0`, line 4787). Fix by shrinking per-sub-step cost (Phase 1), not restructuring the loop. Optional final-substep-only resolve is a gated Phase 3 behavior change. |
| Materials demotable to `THREE.Color` | Appearance results (#5) said 9 of 13 materials are pure color containers. | **Corrected to 3–4.** `shellMat/plateMat/trimMat/lightMats[0..1]` are bucket-routing identity tokens in `_box()` (lines 1612–1619) and `lightMats` are live-swapped by the blinker (3080). Only `limbMat`, `jointMat`, `footMat` (+ possibly local `skin`) are cleanly demotable, and `materialColor()` read sites must change too. |
| Trunk avoidance complexity | Scout claimed O(N·T). | **Corrected to O(N·k)** (chunk-bucketed, 3×3 of 30-unit chunks — `collision.js:77-101`). Real issue is the per-call fresh-array allocation at `collision.js:93`, not complexity. |
| `enemyTarget` grid-empty → full-list O(N²) fallback | Scout flagged as live hot path. | **Rejected.** Unreachable in steady state (grid rebuilt with every creature each frame before combat runs). No work item; noted as fragile to future rebuild-order refactors. |
| FABRIK 12-iteration cap / tolerance | Task hypothesis: expensive. | **Exonerated.** Warm-started, full-extension fast path, squared-distance early exit, allocation-free. No changes. |
| `placeSegment` / InstancedMesh batching | — | **Exonerated.** Inherent technique cost / well-designed respectively. No CPU-side changes. Batching's silent 8192-per-bucket cap is a robustness note only (Deferred). |
| `shapeArmJoints` warm-start "pollution" | Appearance results (#6) flagged bent-pose seeding of the FABRIK cache. | **No action** (appearance spec): tolerance check unaffected, extra-iteration cost bounded by the same early-exit; not worth the correctness risk. |
| `applyBodyTerrainClearance` ×2 per step | Scout under-reported (listed once). | **Confirmed ×2** (`physicsStep:2673` + accumulator loop `4783`): 18 terrain samples/creature/fixed step, not 9. |
| Leg-partner topology recompute | Missed by scouts entirely. | **Confirmed** by both locomotion results (#5) and hot-path spec (item 3). Pure invariant recompute with per-leg-per-step allocations. |

Merged overlap: **terrain-sampling cost appears in both specs.** The hot-path spec owns the
root cost (make `terrainHeight` cheap under map mode via heightfield bake — Phase 3 item 3.1);
the appearance spec owns call-count reduction on the render side (foot-normal skip — Phase 1
item 1.4; arm-pipeline memo — Phase 3 item 3.2). These compose: the foot-normal skip pays off
in *both* terrain modes, so it goes first; the bake and the arm memo are mode-dependent and are
sequenced after runtime confirmation + measurement. If the bake lands, the arm memo (3.2) is
probably not worth doing.

---

## Phase 1 — Zero-risk constant-factor wins (all effort S, no behavior change)

Do these first, in any order (no interdependencies except as noted). Together they cut the
per-sub-step constant factor that the 5× catch-up loop amplifies, which also de-fangs the
"feedback loop" concern for free.

### 1.1 Cache `collisionRadius()` / `maxArmReach()` / `meleeRadius()`
- **What:** After `this.legs`/`this.arms` are built in the constructor, compute and store
  `this._collisionRadius`, `this._maxArmReach`, `this._meleeRadius` as fields. Replace hot-path
  call sites: separation loop (2321, 2325), trunk avoidance (2338, 2342), collision resolution
  (4227–4229). Keep the methods as one-time builders.
- **Why:** These are pure functions of construction-time-immutable data (verified: no
  `.restLocal` mutation, no `arm.reach` mutation, no `bodyScale` mutation anywhere), yet
  recomputed as an O(legCount)/O(armCount) reduction on *every pairwise check* in the two
  hottest loops, up to 5×/frame in collision resolution. Largest constant-factor win in the
  steering/collision domain; also the primary mitigation for O(N²)-under-density and the
  sub-step amplifier.
- **Effort:** S. **Risk:** very low — contingent on the verified immutability; if inputs ever
  become mutable, recompute at the mutation site.
- **Ordering:** none. Prerequisite (with 1.2) for declaring Phase 3 item 3.4 unnecessary.

### 1.2 Gate the second `applyBodyTerrainClearance` on actual collision movement
- **What:** In `resolveCreatureCollisions` (4219–4261), set `a._collisionMoved = b._collisionMoved
  = true` inside the `overlap > 0` push branch (4243–4247). Clear the flag at the top of each
  sub-step. Change the loop at 4783 to
  `if (c.lodShouldSim && c._collisionMoved) c.applyBodyTerrainClearance();`.
- **Why:** The clearance runs twice per fixed step (`physicsStep:2673` + 4783), 9 terrain
  samples each = 18/creature/step. The second call only exists to re-clear after collision
  pushes, which affect a minority of creatures on a typical step. Gating halves body-clearance
  terrain sampling in the common case; under map mode that's 9 raycasts saved per non-colliding
  creature per sub-step. Note the set mismatch is safe: only collision-candidate creatures
  (`_activeCreatures`) can be dirtied; everyone else keeps their `physicsStep` clearance
  unchanged. Trunk pushes (`resolveTrunks`, 2663–2666) are already re-cleared by the 2673 call.
- **Effort:** S. **Risk:** low — must dirty *both* creatures on every push and clear per
  sub-step.
- **Ordering:** none. Also subsumes the locomotion "idle memoization" finding (#6) for the
  clearance path.

### 1.3 Cache leg-partner topology at construction
- **What:** After `this.legs` is built (assignment at ~1460), run a one-time pass storing per
  leg: `leg.rowMate`, `leg.diagonalPartners`, `leg.adjacentPartners`, `leg.crossRows`
  (`this.legs.filter(l => Math.abs(l.row - leg.row) === 1)`). Replace call sites in
  `canWalkLegMove` (2403, 2407) and `canGallopLegMove` (2420, 2426). Keep
  `legBy`/`diagonalPartners`/`adjacentPartners` (2364–2393) as builders used only during the
  precompute.
- **Why:** Row/side layout is fixed at construction and never mutates, yet the current code
  re-derives partners with 2–3 heap allocations (arrays + Sets) plus linear scans per leg per
  fixed step via `scheduleSteps`. An 8-leg creature at 5 sub-steps discards ~160–240
  alloc-and-scan operations per frame. Pure GC-pressure removal, zero behavior change. (Missed
  entirely by the scouts; confirmed by both the locomotion analyst and the hot-path spec.)
- **Effort:** S. **Risk:** very low — add a `rebuildLegTopology()` note in case legs are ever
  mutated at runtime (currently never).

### 1.4 Foot-normal terrain-sample skip (appearance Change B(1))
- **What:** In the leg render loop (3097–3100), store `leg._lastNormalSampleX/Z` (+ last yaw)
  and cache the resulting normal/quaternion per leg. Only call `terrainNormal` (which costs
  4 `terrainHeight` calls, lines 18–25) + `orientFromUpForward` when `leg.end` moved beyond a
  small epsilon **or** creature yaw changed materially since the last sample; otherwise reuse
  the cached foot quaternion.
- **Why:** A planted, stationary foot's ground normal cannot change, yet it is recomputed
  (4 terrain samples) per leg every frame unconditionally. Removes 4·L samples/frame for
  static/slow creatures in *both* terrain modes; under map mode each avoided sample is an
  avoided BVH raycast + allocations. Best impact-to-effort ratio in the appearance spec.
- **Effort:** S. **Risk:** low — the yaw term in the guard is required or feet stop re-tilting
  during turns on slopes; keep the epsilon conservative to avoid orientation popping.

### 1.5 Trunk-index `nearby` out-param
- **What:** Change `collision.js:93` to `nearby(px, pz, out = []) { out.length = 0; return
  gather(px, pz, out); }` (default preserves existing callers; `resolve` at 95–99 unaffected).
  In `computeSteering` (2334), pass a dedicated module-scope `_trunkScratch` — a *separate*
  buffer from `_nearbyScratch` to avoid aliasing if call order ever changes.
- **Why:** Currently allocates a fresh array per `lodShouldSim` creature per frame — the one
  grid query in the domain that doesn't follow the shared-scratch pattern. Complexity is
  already fine (O(N·k), chunk-bounded — scout's O(N·T) was wrong).
- **Effort:** S. **Risk:** very low.

### 1.6 Per-leg `hipWorld` clone fix
- **What:** Store a persistent `leg._hipWorld` Vector3 at leg construction (~1481) and change
  line 3087 to `this.group.localToWorld(leg._hipWorld.copy(leg.attachmentLocal))`.
- **Why:** The only allocation in the otherwise-clean leg loop; 1 clone/leg/frame.
  `attachmentLocal` is immutable. Same fix shape as Phase 2's arm pooling — can be done here
  standalone (it has none of the arm path's aliasing hazards) or folded into 2.1.
- **Effort:** S. **Risk:** negligible.

---

## Phase 2 — Allocation pooling on the hot path (S–M, mechanical but needs aliasing care)

### 2.1 Pool the arm target/constraint `Vector3` chain (appearance Change A)
- **What:** Add persistent per-arm scratch fields at arm construction (1534–1550):
  `arm._shoulderWorld`, `arm._restWorld`, `arm._localScratch`, `arm._pointScratch`. Replace the
  `X.clone()`-into-`localToWorld`/`worldToLocal` pattern at:
  - 2937 (`shoulderWorld`), 2751 (`armRestTarget`), 2787 (`constrainArmTarget`),
    2802 (`constrainArmPoint`, looped at 2951 — each iteration fully consumed, one buffer
    suffices), 2904 (carry target, reuse `_restWorld`).
  - **Leave the combat punch clones (2832, 2835, 2840) and the cooldown-gated
    `chooseArmObject` clone (2767) on `.clone()` initially** — rarer paths, and the combat
    branch calls `armRestTarget` up to twice (2837 windup + 2846) so a single reused buffer
    could alias; verify or give combat its own second buffer in a follow-up.
- **Why:** The headline appearance finding, and the biggest correction to the scouts'
  "allocation-free" claim: 5–7 guaranteed `Vector3` allocations per arm per frame,
  unconditional whenever `lodArmsActive` — 40–56/frame for an 8-arm plan, per creature. Main
  symptom is minor-GC frame-time spikes rather than steady-state ms. All source vectors
  verified immutable post-construction, so pooling is safe.
- **Effort:** M. **Risk:** low–medium — the one real hazard is buffer aliasing (a buffer must
  be fully consumed before reuse in the same frame). Two audit points: `armRestTarget`'s return
  liveness across the combat double-call, and confirming `constrainArmTarget`'s internal
  `target.copy(localToWorld(local))` at 2794 never has `target === scratch`. No visual change.
- **Ordering:** after Phase 1 (independent, but Phase 1 items are strictly cheaper wins). Do
  1.6 first or together.

### 2.2 Pool convex-hull / support-polygon scratch (hot-path item 8)
- **What:** In `convexHull` (594–612): hoist the `cr` cross-product helper and the sort
  comparator to module scope; use module-scope reusable `lo`/`up`/output arrays
  (`.length = 0` before use); have `convexHull` write into a passed output array instead of
  returning `lo.concat(up)`. Move `let poly = []` (2611) below the `groundedCount >= 2` guard.
  Keep the debug branch (2681–2688) valid — it copies `poly` out immediately
  (`poly.map(p => new THREE.Vector3(...))`), so pooled-array lifetime is safe, but verify no
  other reference to `poly` outlives the step.
- **Why:** ~5 array + 2 closure allocations per creature per fixed step (hull runs whenever
  ≥2 feet are grounded — effectively every step for multi-legged gaits). Hull size ≤8, so
  allocation, not the sort, dominates. Same `_groundedBuf` pooling pattern one level up already
  exists — this finishes the job.
- **Effort:** S–M. **Risk:** low–medium — pooled-output lifetime discipline.

---

## Phase 3 — Mode-dependent & structural work (M, gated on measurement/playtest)

**Gate for 3.1/3.2:** first confirm at runtime whether a workshop map actually loads
(`loadedMap && mapCollider` truthy in `environment-viewer.html`) — see Open Questions. If only
the procedural terrain path is live, 3.1 and 3.2 have near-zero payoff and should be skipped
until map mode ships as the default.

### 3.1 Bake a CPU heightfield for map mode (hot-path item 2)
- **What:** At map-load time, sample `mapCollider.raycastDown` once per cell (e.g. 512×512 over
  map bounds) into a retained `Float32Array`; make the `terrainHeight` closure
  (`environment-viewer.html:638-648`) do a bilinear read from it instead of a per-call
  `Raycaster.intersectObject` (`map-collision.js:117-123`). Fall back to `loadedMap.heightAt`
  outside baked bounds, as today. Mirror the existing `bakeHeightTexture` helper
  (`environment-viewer.html:649`) which already does this for the GPU. Run the bake off the
  first-frame critical path if it stalls load.
- **Why:** Under map mode, every one of the ~40–60 `terrainHeight` calls/creature/fixed step is
  currently a BVH raycast that allocates a results array + `Vector3` per hit. Baking converts
  them all to array reads — the single largest hot-path win *when a map is active*, and it
  benefits every caller at once (locomotion, clearance, foot normals, arm constraints), which
  is why it supersedes point-fix memoization (3.2). No effect in procedural mode.
- **Effort:** M. **Risk:** medium — grid resolution smooths sub-cell terrain features vs. the
  raycast; acceptable for tolerance-padded foot/body clearance but must be validated against
  steep/thin map geometry. ~1 MB retained per map at 512²; one-time bake hitch.
- **Ordering:** after the runtime confirmation; independent of Phases 1–2 (they reduce call
  counts, this reduces per-call cost — they compose).

### 3.2 Arm-pipeline per-render-pass terrain memo (appearance Change B(2)) — conditional
- **What:** Small fixed-size cache keyed by quantized (~0.1-unit) (x,z), populated during a
  creature's render pass, covering the 6–9 near-identical samples per arm per frame at
  2752/2786/2795/2801/2817/2929.
- **Why / when:** Only worth it if (a) map mode is confirmed live AND (b) 3.1 is deferred, or
  profiling after 3.1 still shows arm-side sampling cost. If 3.1 lands, samples are cheap array
  reads and this memo is almost certainly not worth its code. Explicitly second-fiddle to 1.4.
- **Effort:** M. **Risk:** low (terrain is static within a frame).

### 3.3 Demote color-only materials at spawn (appearance Change C — corrected scope)
- **What:** Parts-instancing mode only: replace `limbMat`/`jointMat`/`footMat` (1388–1390) with
  plain `THREE.Color`s; store `part.userData.color` instead of `userData.material` at
  1462–1526 / 1692 / 1712; update the submit readers `submitInstancedSegment/Joint/LocalJoint/
  HandFoot` (3015–3039) to read `userData.color` directly. **Do not touch**
  `shellMat/plateMat/trimMat/lightMats` (identity-routing tokens in `_box`, blinker-swapped) and
  **do not regress** `CREATURE_INSTANCING_MODE === 'off'`, where these materials bind to real
  meshes — construct the full Material in off mode.
- **Why:** Trims ~3 `MeshStandardMaterial` constructions per creature at spawn. Spawn-hitch
  reduction for batched team spawns only; zero steady-state framerate change. Scope corrected
  from the analyst's "9 of 13" to 3–4 by the appearance spec.
- **Effort:** M. **Risk:** medium (two code paths + shared `materialColor` reader). Lowest
  priority of the committed items.

### 3.4 Sub-step / density refinements — only if profiling demands (hot-path items 5–6)
- **What (in escalating order, each gated behind evidence):**
  1. *Final-substep-only resolve:* run `resolveCreatureCollisions` + the gated second clearance
     only on the last catch-up sub-step. Behavior change (deeper transient interpenetration
     during catch-up) — flag-gate and playtest under combat swarm. Effort M.
  2. *Neighbor cap:* optional max-count on `SpatialGrid.nearby` so a pathologically dense cell
     can't force an unbounded inner loop; converges over frames. Behavior change; gate +
     validate. Effort M.
  3. *Dual grids* (separate cell sizes for separation vs. collision): genuine tuning
     improvement but adds a second per-frame rebuild; only if dense-cluster queries dominate a
     profile. Effort L.
- **Why gated:** the specs' shared conclusion is that 1.1 + 1.2 remove most per-sub-step cost,
  which is the correct fix for the catch-up amplifier; true sub-quadratic behavior in a tight
  swarm is unreachable without changing the contact model. Do **not** rebuild the grid inside
  the sub-step loop (adds cost exactly in the slow-frame case); accept the documented one-frame
  grid staleness.
- **Low-value adjacent note (optional, S):** pool `SpatialGrid` bucket arrays across frames
  instead of `Map.clear()` + fresh `[]` per occupied cell per frame (steering finding 6) —
  small GC win, take it opportunistically if touching `SpatialGrid` for the neighbor cap.

---

## Deferred — GPU / robustness track (do not bundle with the CPU work)

- **GPU skinning to retire `placeSegment`** (528–535): large rewrite of the render half of
  `Creature` + batching; `placeSegment` is rated Low cost and inherent to the technique. Only
  revisit if a CPU profile shows it materially. Effort L.
- **GPU-side IK: rejected.** FABRIK is warm-started, early-exiting, branchy/serial — poor GPU
  fit and already cheap. The win was allocations (2.1), not the math.
- **InstancedMesh 8192/bucket silent capacity cap** (`add()` returns `false` unchecked, ~847):
  robustness, not perf — add a logged overflow warning eventually so large populations don't
  silently drop body parts.
- **`enemyTarget`/`forageObjectForCreature` grid-empty fallbacks** (2057, 1265): no change now,
  but they are fragile to future reordering of the per-frame grid rebuild (4772–4773). If the
  frame sequence is ever refactored, re-verify these fallbacks remain cold.

---

## Open questions / needs measurement

1. **Is a workshop map actually loaded at the runtime configuration being optimized?** The
   entire value of 3.1/3.2 (and much of the severity of 1.2/1.4 beyond GC) is conditional on
   `loadedMap && mapCollider`. Check `maps/map-config.json` / URL params / a runtime log of
   which `terrainHeight` branch fires before committing Phase 3 terrain work.
2. **Baseline profile before/after Phase 1:** capture a performance profile (steady-state ms +
   minor-GC frequency) with a representative scene (near-camera multi-arm creatures, combat
   clustering) so Phase 2/3 decisions rest on measurements, not the analysts' call-count
   arithmetic. The allocation findings predict GC-spike reduction more than mean-frame-time
   reduction — measure both.
3. **How often does the 5× catch-up actually engage** in normal play (vs. tab-resume/GC
   events)? Instrument `steps > 1` frequency. If it's rare, 3.4's final-substep-only option is
   not worth its behavior risk.
4. **Combat/forage cluster density in practice:** how large does `nearby` get in the worst
   real cluster? Determines whether the neighbor cap / dual-grid (3.4) ever graduates from
   deferred.
5. **Bake resolution validation (if 3.1 proceeds):** compare baked-heightfield vs. raycast
   heights on the steepest workshop-map geometry to size the acceptable grid resolution before
   wiring it into foot placement.
6. **Is `CREATURE_INSTANCING_MODE === 'off'` ever used in practice?** Determines how much care
   3.3's dual-path gating deserves (and whether the 'off' path is worth keeping at all).

---

## Recommended execution order (single sequence)

1. 1.1 cache radii (S) → 2. 1.2 gate second clearance (S) → 3. 1.3 leg topology cache (S) →
4. 1.4 foot-normal skip (S) → 5. 1.5 trunk out-param (S) → 6. 1.6 leg hipWorld (S) →
7. 2.1 arm Vector3 pooling (M) → 8. 2.2 convex-hull pooling (S–M) →
**[measure + confirm map mode]** →
9. 3.1 heightfield bake (M, map mode confirmed) → 10. 3.3 material demotion (M) →
(3.2, 3.4 only if measurements justify) → Deferred GPU track: not scheduled.
