# Bot Viewer v2 Performance Sweep — 2026-07-27

> **STATUS 2026-07-27 (later same day):** do-first items 2, 3, 4 are FIXED (Opus implementation agents + orchestrator review; Node tests green). Item 1 (slider drag rebuilds) deliberately left as-is per user. Details: item 2 = hostGhostsDirty flag in environment-viewer.html flushed once per frame at end of updateBots; item 3 = pooled flood buffers with deferred band-clear + per-actor `out` for medicNavFlood (both viewers) + regression tests in test-nav-grid.mjs; item 4 = measureMountedShotAlignment and all dead helpers deleted from bot-viewer-v2.html (v1 copies intentionally kept).
>
> **STATUS 2026-07-28:** finding #8 (wall instancing) FIXED per the revised design — one InstancedMesh per material, shared UNIT_BOX exempted from applyLayout's dispose loop, floor/catch slabs kept plain. One gotcha the revision missed: `createMapCollider` only applied `matrixWorld`, so map-collision.js had to learn to expand instances into world triangles (verified via mapTris invariant in the autoprofile payload). Maze A/B at 90 bots (perf-autoprofile-9/-10.csv): render submit 13-25 ms → 3.7-5.3 ms, avg fps 34.5 → 51.9.

**Method.** 12 Sonnet agents swept the bot-viewer-v2 codebase (~17.8k lines across bot-viewer-v2.html + 27 modules), one per subsystem group, hunting runtime inefficiencies. Their 23 findings (one duplicate merged → 22 unique) were then each adversarially verified by 12 Opus agents that re-read the cited code, tried to refute the claim, and independently judged the suggested fix. Total: ~1.9M subagent tokens, 543 tool calls.

**Verdict summary.** 17/22 claims **confirmed**, 5 **partial** (real but overstated), 0 refuted. Fixes: 6 **sound** as suggested, 16 **needs-revision** (right direction, but the verifier found aliasing hazards, wrong scratch placement, or a bigger adjacent win the finder missed). Severity after verification: most allocation findings were graded down to LOW (nursery churn, no frame cost); the two items below remain the ones with real frame-time impact.

## Do-first list (post-verification priority)

1. **Maze/structure sliders rebuild the whole map per drag tick** — CONFIRMED HIGH, fix sound. 13 sliders fire `applyLayout()` on raw `input`: ~20M point-in-rect tests + BVH rebuild + visibility/corner bakes per tick on a 30×30 maze. Fix also removes a per-tick sim reset (correctness win). Mirror the adjacent `makeTerrainSlider` commit-on-release pattern.
2. **`updateHostPlayerGhosts` runs N+1 times per frame in firefights** — NEW, found by the toWirePose verifier and bigger than the finding it was checking: `applyCombatIntent` calls the full O(N) ghost + procedural-body pass on *every resolved shot* (environment-viewer.html:8729/8746, botFire routes every bot bullet through it). Replace mid-frame calls with a dirty flag flushed once per frame.
3. **`floodFill` allocates + memsets full-grid typed arrays per call** — CONFIRMED (severity revised high→medium: callers are event/backoff-gated, so it's bursty churn during firefights, not per-frame). Suggested fix was **unsafe** — `actor.medicFlood` retains results up to 200ms across actors, so shared scratch would alias medic A's distances to medic B. Use the revised fix below.
4. **Dead shot-alignment diagnostic** — CONFIRMED, fix sound, trivially deletable: 5 Vector3s + an `updateWorldMatrix` ancestor re-walk per shot feeding `lastShotAlignment`, which nothing in the repo reads.

Everything else is LOW: real, but nursery-level allocation churn worth fixing only opportunistically or for convention consistency. Several verifiers flagged that V8 escape analysis likely elides the smallest ones, and one cited the repo's own prior measurement (docs/subsystems/bots.md) concluding exactly that for bot-aim.js.

---

## Findings by subsystem

Severity shown as `Sonnet grade → Opus adjustment`. Claim: confirmed / partial / refuted. Fix: sound / needs-revision / wrong.

### Sim tick (bot-viewer-v2.html)

#### 1. Dead shot-alignment diagnostic allocates 5 Vector3s per shot
`bot-viewer-v2.html:7282` · medium → low · claim **confirmed** · fix **sound**

- **Problem:** `measureMountedShotAlignment()` runs unconditionally in `fireBotShot()` (:7455) for every hitscan shot; its result goes to `lastShotAlignment` (:3875), which a repo-wide grep shows is never read. 5 Vector3 allocations per call, plus both `getWorldPosition` calls redo an `updateWorldMatrix(true,false)` ancestor walk that `botMountedBarrelRay` already did in the same call (verifier found this — the finding understated cost).
- **Fix:** Delete the call. Verifier confirmed the deletion also frees `directionAngleDegrees`, `_shotAimDir`/`_shotAimEnd`, the `.copy(dir)` at :7423 and `alignEnd` at :7454 — none have other callers.

#### 2. decideMedicDuty allocates fresh arrays/objects every frame per medic
`bot-viewer-v2.html:6404` · medium → low · claim **partial** · fix **needs-revision**

- **Problem (as verified):** Mechanism real — fresh `allies`/`corpses` arrays + record literal per candidate per medic per frame from `updateBotSentry` (:7092). But overstated: candidates are pre-filtered (hp ≤ 0.65 within 16m; corpses within 14m), so both arrays are usually *empty*; common-case cost is two empty arrays + the un-flagged `botXZ(bot)` object. Much of the claimed "departs from scratch pattern" is wrong — `_md*` scratch already exists; only the arrays are fresh.
- **Why the suggested fix was unsafe:** a naive record pool leaks state: `attachMedicNavCost` (:6361) writes `list[i].cost` and early-returns when the flood is null, and `reach()` in bot-medic.js keys on `o.cost != null` — a pooled record carrying last frame's `cost` silently ranks candidates by stale path distance. `attachMedicNavCost` also splices the working arrays, so pool slots can't live in them.
- **Revised fix:** swap `botXZ(bot)` → `botXZInto(bot, scratch)` (twin exists at :4225), hoist the `[allies, corpses]` iteration literal at :6365, hoist the two arrays to module scratch with `.length = 0`. Skip the record pool unless profiling shows it; if ever pooled, reset `cost`/`fleeing`/`squadmate`/`hp01`/`diedAt` on every acquire.

### Rendering / DOM / HUD (bot-viewer-v2.html)

#### 3. Dummy-target mesh sync allocates a Vector3 every frame
`bot-viewer-v2.html:3721` (actual :3708-3711) · low → keep · claim **confirmed** · fix **sound**

- One `capsule.start.clone()` per alive dummy per frame; real bots already use `_updateBotMid` scratch for identical math. Usually 0-1 dummies, but the Test preset (:8163) spawns 200 → ~12k Vector3/s worst case.
- **Fix constraint from verifier:** use a *fresh* module scratch — do NOT reuse `_updateBotMid`, it is handed to `botProceduralBody` as `st.position` (:2181).

#### 4. spawnBullet allocates a wrapper object + Vector3s per shot next to the pooled mesh path
`bot-viewer-v2.html:7689` · medium → low · claim **confirmed** · fix **sound**

- Mesh is pooled but the record `{mesh, from: from.clone(), direction, ...}` is not (`direction` is a second clone the finder missed; `spawnTracer` pushes an unpooled record beside it too). Verifier tempered payoff: per-shot, and the calling fire path allocates ~10 other short-lived objects (hitPoint, origin/dir arrays, 3 closures), so this alone changes little.
- **Fix:** free-list the whole record; `.copy()` into reused vectors. Bullets are only removed on expiry, so it's trivially safe.

#### 5. Focused-bot HUD readout writes DOM every frame with no visibility gating
`bot-viewer-v2.html:10222-10245` · low → keep · claim **confirmed** (flagged independently by two finders) · fix **needs-revision**

- 6 `textContent` writes + template strings every frame regardless of panel/section collapse; the else-branch writes `'-'` six times per frame too. Score panel already gates identically-shaped work. Understated: the block calls `toWirePose()` (Vector3 + 3 arrays per frame) just to print three numbers.
- **Revised fix:** `panelCollapsed` alone misses per-section collapse. Capture the section card when built (`const readoutSectionEl = ctrl.parentElement`) and gate on `!panelCollapsed && !readoutSectionEl.classList.contains('collapsed')` (same idiom as `scoreSectionEl` :8532). No dirty flag needed — repaint-on-visible is fine. Drop `toWirePose()` and format the capsule mid from a scratch Vector3.

### Map generation / persistence (bot-viewer-v2.html, bot-structures.js)

#### 6. Maze/structure sliders rebuild the entire map on every drag tick
`bot-viewer-v2.html:7999` · **high → keep** · claim **confirmed** · fix **sound**

- 13 sliders (12 `makeMazeSlider` + `hallWidthInput` :8139) call `applyLayout()` on raw `input`. Each rebuild: dispose all mapRoot children, BVH collider rebuild, terrain field + floor, one BoxGeometry per wall/cover, then `buildNavGrid` + `buildSightGrid` + `buildLazyVisibilityField` + `buildCornerMap` + `reportNavRegions` + `rebuildNavOverlay`. `navWalkable` → `pointInWall` is a linear scan over walls, so the bake is O(cells × walls): 30×30 Test condition ≈ 150×150 cells × ~950 walls ≈ **20M rect tests per drag tick**, before BVH/corner costs. The adjacent `makeTerrainSlider` (:8241) already splits input/change with a "far too slow" comment.
- **Bonus correctness win (verifier):** committing on release also stops the per-tick sim reset — `applyLayout` (:4613) wipes `currentPath`/`botState` and relocates/removes actors on every drag tick today.

#### 7. Nav path debug line reallocates geometry every frame
`bot-viewer-v2.html:7753` · medium → low · claim **partial** · fix **needs-revision**

- Real dispose + `new BufferGeometry().setFromPoints()` per frame, but **debug-only** (`navPoints.visible` defaults false, toggled via debug button) and paths are tens of points.
- **Why half the fix was wrong:** "skip when path unchanged" fails twice — `currentPath` aliases `actor.path` and `followPath` mutates it in place with `.shift()`, so reference equality misses changes; and the first vertex is the live bot position, which moves every frame (skipping would visibly detach the line).
- **Revised fix:** keep updating every frame, stop reallocating: preallocated `Float32BufferAttribute` (grow on demand), write in place, `setDrawRange(0, n+1)`, `needsUpdate = true`, never dispose per frame. **Same pattern exists at :3974** (per-actor behaviour-debug path lines) and is the larger instance when overlays are on with many bots.

#### 8. Map walls/covers are one Mesh+BoxGeometry each, never merged or instanced
`bot-viewer-v2.html:258` (box(), applyLayout :4573-4574) · medium → keep · claim **confirmed** · fix **needs-revision**

- One BoxGeometry + Mesh + shadow caster per rectangle (2048 shadow map). ~950 boxes on 30×30 Test condition, up to ~1900 with max cover density; shipped default 8×8 is only ~100, so preset-dependent. Merging is collision-safe: `createMapCollider` re-extracts world triangles by traversal; LOS/nav use `activeWalls` rect data, not meshes; nothing raycasts individual walls.
- **Revised fix:** prefer **one InstancedMesh per material** (wallMat/coverMat) over `mergeGeometries` — boxes differ only by translation/scale, shared unit box + per-instance matrices is cheaper to build than merging ~1000 geometries, and matches existing convention (body-part-batches.js). Gotchas: (1) applyLayout's teardown calls `m.geometry.dispose()` on every mapRoot child — exempt the shared unit geometry; (2) keep plain-Mesh path for the floor/catch-slab calls in `buildFloorMesh` (:324, :345).

### Lighting / audio (environment-audio.js)

#### 9. Audio listener update allocates 2 Vector3s every frame
`environment-audio.js:362-381` · low → keep · claim **confirmed** · fix **needs-revision**

- Real and unconditional once the AudioContext exists (called per frame by both viewers). But the bigger unclaimed cost on the same lines: **9 `setValueAtTime` AudioParam automations per frame**, which a position/quaternion dirty-check would actually save.
- **Revised fix:** scratch vectors must live in the `createEnvironmentAudio` factory closure — `THREE` is factory-injected, so module-level `new THREE.Vector3()` throws at import. Pair with an early-out skipping the 9 param writes when camera pos/quat are unchanged.

#### 10. Music speaker-orb behavior target allocates ~4 Vector3s per frame in speaker mode
`environment-audio.js:861-892` · low → keep-low · claim **confirmed** · fix **needs-revision**

- Opt-in (`musicOutputMode` defaults `'global'`). Verifier found a related miss: the unconditional tail `setPannerPosition(..., musicOutputPosition())` (:911) → `musicSpeakerPosition` (:662) allocates a Vector3 + clone per frame **even in global mode** once the orb exists.
- **Revised fix:** factory-closure scratch (`speakerRight/Forward/Target`), rewrite branches with `.copy().addScaledVector()`; comment that the return is shared scratch. Give `musicSpeakerPosition` the same treatment.

### Visual/theme system

#### 11. Per-frame closure allocation in advanceAudioMix
`bot-viewer-visuals-style.js:810-821` · low → keep-low (style nit) · claim **confirmed** · fix **needs-revision**

- One closure per frame, built even when `levels` is null. Verifier: do **only the hoist** (module-level `band(levels, key)` helper). Skip the suggested `!audioReactive` early-out — it saves nothing measurable, needs an epsilon (asymptotic decay never reaches 0), and short-circuiting the decay defeats the deliberate ramp-instead-of-snap behavior the function's own comment documents.

### Terrain

#### 12. gradientAt allocates a fresh {dx,dz} per call in the movement path
`bot-terrain.js:279-284` · low → keep-low · claim **confirmed** · fix **needs-revision**

- Real but off by default (`enabled: false`), consumed inline (textbook escape-analysis candidate). The finder missed the higher-volume caller: `navWalkable` → `slopeAt` → `gradientAt` runs **once per nav cell on every rebuild** — that's where a fix buys measurable time.
- **Revised fix:** (1) don't copy `normalAt`'s pattern — its `out = [0,1,0]` default allocates fresh on every internal call anyway (fix that too); a non-allocating default needs module scratch `_grad`. (2) Better for the hot path: every consumer reduces the gradient to a scalar, so add `gradeAt(x, z, mx, mz, e)` alongside `slopeAt` and call it from `terrainSpeedFactor` — zero shared-mutable-return footgun.

### Nav / pursuit

#### 13. floodFill allocates full-grid arrays regardless of maxRadius
`nav-grid.js:326-366` · **high → medium** · claim **confirmed** · fix **needs-revision**

- `new Float64Array(n)` + `new Int32Array(n)` + fills with n = cols×rows per call; searches touch <150 cells (recovery R=3 ≈ 49, flee R=5 ≈ 121, medic ≈ 4.5k) on grids of tens of thousands of cells → ~0.5MB alloc+memset per call. Corrections: the grenade-evade cite is a comment explaining deliberate *non*-use, and medicNavFlood's 200ms cache is a real mitigation. All callers are event/backoff-gated → bursty churn during firefights, not per-frame.
- **Why the suggested fix was unsafe:** `actor.medicFlood` (:6347) retains results up to 200ms across frames and across multiple medics — module-level shared dist/parent would hand medic A's distances to medic B. Sharing findPath's `acquireScratch` is doubly unsafe (findPath runs in between). Window-sized arrays are invasive: `flood.dist` is indexed by full-grid key at 4 sites and `floodPath`/reconstruct derive c/r from `grid.cols`.
- **Revised fix:** keep full-grid indexing; persistent module buffers grown to the largest grid, initialized once; after each bounded run, clear only the `[start±R]²` band it could have written (elsewhere stays Infinity so `=== Infinity` checks keep working); full clear for the rare `maxRadius: Infinity` caller. Add an optional `out` param so retaining callers (medicNavFlood → per-actor `actor.medicFloodBuf`) opt out of the shared pool.

#### 14. interceptPoint/standoffPoint allocate fresh objects per call
`bot-pursuit.js:42/49/74` · medium → low · claim **partial** · fix **needs-revision**

- Real (and `interceptPoint` allocates *twice* on the lead path — undercounted), but ceiling is 7 standoff calls not 8, offset 0 reuses `direct`, and the loop returns on first walkable bearing → typical cost is ~1 call per pursuing bot per frame. Unmentioned peer: `worldToCell` at :5709 allocates per candidate with `worldToCellInto` already imported.
- **Why the suggested fix was dangerous:** `pursuitStandoffGoal`'s return is committed to `actor.combatMoveGoal` and compared by `goalChanged` next frame — a shared scratch return would compare the object against itself, always yield 0, and **silently stop pursuit re-pathing** as the target moves.
- **Revised fix:** first swap `worldToCell` → `worldToCellInto` in the loop; add `interceptPointInto(..., out)` (result read same-frame, scratch safe; fold the `still` literal into `out`); for standoffPoint use scratch only for *rejected* candidates — the accepted bearing must return fresh (or copy into a per-actor goal object compared by value).

### Perception / aim / activity

#### 15. Redundant/nested AIM_DEFAULTS spread-merge per call
`bot-aim.js:27-64` · medium → low · claim **partial** · fix **needs-revision**

- Facts check out (15-key merge per call; double-merge via spreadHalfAngleRad→settleFactor01; sole caller passes a complete object), and ~2400 merges/s at 40 bots holds — but only for `decayBloomDeg`; the others are per-contact/per-shot, and the double-merge is not on a per-frame path. **docs/subsystems/bots.md records a prior audit that measured this exact construct and found the non-escaping merge JIT-elided** ("genuinely fine — measure before 'fixing' one").
- **Revised fix:** don't blanket `settings || AIM_DEFAULTS` — that drops the partial-settings tolerance this pure, Node-tested, port-bound API deliberately provides. If touched: adopt bot-stance.js's per-key `opt(s, k)` accessor for the genuinely hot `decayBloomDeg` (+`bloomAfterShot`), and fix the double-merge by inlining the settle term. Measure first.

#### 16. environment-viewer.html uses the allocating chooseBotState wrapper
`bot-activity.js:36` / `environment-viewer.html:2360` · low → keep · claim **confirmed** · fix **sound**

- Verified end to end; v2 does it right, env-viewer doesn't. Tempering: env-viewer defaults to ~3 bots, and this whole path is slated for replacement by the bot-v2 port — questionable ROI hand-optimizing now. Verifier also counted more per-tick literals the finder missed (`eye` :2314, aimAnglesTo return :2329, `lastSafePos` :2376, `weaponAimPoint` array :2328). Implementation notes: `aimAnglesTo` already takes an `out` param; `rec.weaponAimPoint` must be a per-rec reused array (read later by `syncEnvironmentBotWeaponMounts` :8050); convert the respawn write at :2655 when in-placing `lastPos`.

### Cover / separation / spatial hash

#### 17. separationXZHashed/blendSeparationDir (+ peekPosition/approachXZ) allocate {x,z} per call
`bot-separation.js:72,141` / `bot-cover.js:57,68` · low → keep-low · claim **confirmed** · fix **needs-revision**

- All sites real; corrections: `separationXZHashed` returns null when no neighbor in radius (not "every call"), and there's a **third** peekPosition site at :7055-7057 the finder missed. ~7k allocs/s worst case — convention cleanup, not speed. Duplicates never-applied items in the 2026-07-25 perf-audit docs (alloc-gc.md:88, crowd-modules.md:208).
- **Revised fix constraints:** `out` param must default to a *fresh literal*, never module scratch — `test-bot-cover.mjs:385/390` retains `approachXZ` returns across iterations (shared default would alias every simulated bot's position). Keep approachXZ's copy semantics (never return `target` itself). Use two distinct scratches at :7226 (peek's out becomes approach's target). **Bigger win at the same site:** hoist the per-call closure `(bx,bz) => navBlockedAhead(p, bx, bz)` at :5055 to module scope (`p` is always `_fpXZ`) — worth more than the {x,z} it wraps.

### Squads / roles / medic / score

#### 18. Duplicate distance computation in medic target ranking
`bot-medic.js:54-57,65,79` · low → keep-low · claim **confirmed** · fix **sound**

- Real duplication, near-zero cost: in the live path `o.cost` is pre-populated, so `reach()` is a property read; candidate lists are 0-4 entries. Fix (pass `d` into `preference`) is safe — module-private, untested-directly, pure. Readability win more than perf.

#### 19. formationRanks rebuilds Map + arrays every frame per squad
`bot-squad.js:205` · low → keep-low · claim **confirmed** · fix **needs-revision**

- Allocation list actually worse than claimed (squadRanks sort array, tuples, Map, slice, two filters, spread) but magnitude small (~75 objects/frame at 5 squads), dwarfed by the per-member snapshot objects at :3519 the finder didn't mention.
- **Why the suggested dirty key was a correctness bug:** `(liveCount, leaderId)` doesn't identify the roster — `reconcileSquads` can absorb+split members in one pass leaving count and leader unchanged, and stale ranks write `squadRank` onto bots that moved squads (:3537).
- **Revised fix:** if caching, key on an explicit `squad.rosterVersion` bumped at every memberIds/detachIds mutation (:3375, :3393, :3465, prune :3507) + leaderId. Lower-risk: don't cache, just stop allocating (out-array + per-squad persistent Map, or early-out when no member is support-role — the common case).

#### 20. squadSlotWorld/squadMemberGoal allocate per call
`bot-squad.js:235-259` · low → keep-low · claim **confirmed** · fix **needs-revision**

- ~3 objects per bot per frame (slot + formationOffsetLocal's `{right,back}` + return), plus the options literal rebuilt at the call site (:6580-6585). No aliasing risk at the movement site (copied into fresh goal at :6597).
- **Revised fix:** `out` params on both (still returning null on no-leader so `if (!goal)` works), **and** out-param or inline `formationOffsetLocal`, **and** hoist the options literal to module scratch — the last two are the majority of the allocations. Separate scratch for the debug-draw caller at :4184. Keep no-arg signatures allocating for tests.

### Entity / wire pose

#### 21. toWirePose allocation storm in host ghost sync
`bot-entity.js:75-90` · medium → low (for the allocations) · claim **confirmed** · fix **needs-revision**

- All verified, still unaddressed since the 2026-07-19 Fable review flagged it. Honest size ~22k objects/s at 40 bots — churn, not stall; the same loop's `_updateProceduralBody` allocates the same order of magnitude per bot anyway.
- **The real defect found during verification:** `updateHostPlayerGhosts` is called from `applyCombatIntent` on **every resolved shot** (:8729, :8746) and `botFire` (:1961) routes every bot bullet through it → in a firefight the full O(N) ghost pass including near-LOD procedural-body IK runs **N+1 times per frame**. That dwarfs the allocations.
- **Revised fix (priority order):** (1) make ghost updates idempotent per frame — replace the six call sites (:703, :721, :1837, :1879, :8729, :8746) with a `hostGhostsDirty` flag flushed once at end of `updateBots` (:2665). (2) Then optionally `writeWirePose(bot, out)` + persistent `Map<id, pose>` (not index-keyed — botPlayers order shifts on respawn). **Critical constraint:** writeWirePose must NOT be used on the `getState`/`rememberPlayerPose` path (:581-585) — `combat.js:pushPlayerPose` stores `pose.p`/`pose.q` **by reference** into the lag-comp history; shared scratch there silently corrupts rewind sampling. Keep allocating `toWirePose` for those callers.

### Camera / batching

#### 22. Camera step functions allocate object literals every frame
`bot-camera-control.js:33,58` · low → keep-low · claim **partial** · fix **needs-revision** (recommend: leave alone)

- Real but overstated ~2×: POV and Follow branches are mutually exclusive per frame → 2 objects/frame for one camera; skipped entirely in Orbit/Fly and while `userInteracting`. The "matches cameraRayOriginArray convention" premise is wrong — that scratch lives in bot-viewer-v2.html; bot-camera-control.js's actual convention is deliberate purity (documented in bots.md, covered by test-bot-camera-control.mjs).
- **Verifier recommendation:** leave it alone. A shared-scratch return would fail the tests (they retain and cross-compare multiple returned objects). If ever touched, positional args + caller-supplied `out`, tests passing fresh `{}` per call. 2 non-escaping objects/frame is below measurement noise; trading away pure-function testability for it is a net loss.

---

## Adjacent issues surfaced by verifiers (not in the original 22)

- **Ghost pass N+1 per frame** — see finding 21; the single biggest item found in the whole exercise.
- `updateAudioListener` fires **9 `setValueAtTime` automations per frame** with no dirty check (environment-audio.js) — heavier than the allocations the finding flagged.
- `musicSpeakerPosition` (environment-audio.js:662) allocates per frame **even in global mode** once the speaker orb exists.
- Behaviour-debug path lines (bot-viewer-v2.html:3974) — same dispose-and-rebuild-geometry-per-frame pattern as finding 7, larger when overlays are on with many bots.
- `normalAt`'s `out = [0,1,0]` default (bot-terrain.js:291) allocates on every internal call — fix alongside finding 12.
- `navWalkable` → `slopeAt` → `gradientAt` runs per nav cell per rebuild — the terrain-sampling cost that actually matters (finding 12).
- Per-shot closures (`heightAt`/`normalAt`/`occluder`) + hitPoint/array allocations in the fire path (bot-viewer-v2.html:7440-7457) — larger than the spawnBullet record beside them.
- `worldToCell` per candidate in `pursuitStandoffGoal` (:5709) with `worldToCellInto` already imported.
- Per-call closure `(bx,bz) => navBlockedAhead(...)` in followPath (:5055) — hoistable for free.

## Cross-references

- 2026-07-25 perf audit (docs/superpowers/reviews/2026-07-25-bot-viewer-perf-audit/): findings 17's {x,z} out-params duplicate never-applied rows in alloc-gc.md:88 and crowd-modules.md:208.
- 2026-07-19 bot-port Fable review: finding 21 (toWirePose) was CONFIRMED there and is still open.
- docs/subsystems/bots.md prior measurement: bot-aim.js merge (finding 15) was measured JIT-elided — measure before fixing.
