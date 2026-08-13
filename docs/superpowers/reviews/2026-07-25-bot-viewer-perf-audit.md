# Bot-viewer high-bot-count perf audit — 2026-07-25

Scope: `bot-viewer.html` (~5,140 lines) + its 14 bot/nav modules, target scenario 50–200 bots.
Method: 9 parallel scanner agents (4 Opus / 5 Sonnet), one perf lens each — raw per-lens findings
live in `2026-07-25-bot-viewer-perf-audit/` (85 raw findings). Every finding below was then
**audited by hand against the code** (line-by-line reads of the claimed sites). Verdicts:
CONFIRMED = verified in code; DOWNGRADED = real but overstated / gated; REJECTED = wrong.

Baseline facts verified during audit:

- `updateAllBots` runs the full FSM (`updateBotSentry` + `updateBot`) for **every living bot every
  frame** — no striding, no AI budget (`bot-viewer.html:920-937`).
- **No spatial partitioning of bots exists anywhere.** Nav grid / visibility field / corner map
  index static geometry only; every neighbor query is a linear scan of `botActors`. This single
  gap is the root cause of roughly a third of the confirmed findings.
- Renderer is `WebGPURenderer` (line 45); `map-collision.js` uses a shared `THREE.Raycaster`
  with **`firstHitOnly` never set** (three-mesh-bvh collects and sorts all hits, keeps `[0]`).
- `USE_FIELD_LOS_PREFILTER = false` (line 1965) — the baked-visibility ray-skip is compiled off.

---

## CONFIRMED — high severity

### F1. `selectBotTarget`: O(N²) BVH raycasts per frame (worst single cost)
`bot-viewer.html:1866-1890`, called unconditionally per bot per frame at 3759.
Rebuilds the enemy list with 2 filters + map + 2 spreads, then for every enemy inside the FOV
cone fires a full `mapCollider.raycast` — **no sight-range gate before the ray** (range is only
applied later, to the chosen target, at 3773), no distance sort, no early-out, field prefilter
off, raycaster not `firstHitOnly`. ~2,500 all-hit raycasts + ~20k allocations per frame at 100
bots. Found independently by 4 agents.

### F2. Missing bot spatial index → O(N²) scans across seven systems
All verified: `followPath` rebuilds `others = botActors.map(...)` **inside its waypoint `while`
loop** (2698) and runs `separationXZ` + `waypointContested` (full linear scans,
`bot-separation.js:36-73`) per moving bot per frame; `resolveBotPairs` is an explicit all-pairs
pass (`bot-separation.js:13-33`, called at 940); `sharedAllyAlertNear` (1682) runs per bot per
frame in the common no-firsthand case (3875); `livingTeammatesNear` (1695) during escalations;
`recordNearMisses` (1659) scans all bots **per shot fired** (4236) — shots/sec also scale with N;
medic duty/cohesion scans (3568, 3697) per medic per frame.

### F3. `findPath`/`floodFill` allocate + fill three full-grid typed arrays per call
`nav-grid.js:126-129, 170-172`. O(grid cells) alloc + memset per call regardless of path length
(~41 KB on rooms, ~573 KB on the 30×30 maze preset); `floodFill` allocates full-grid even with
`maxRadius: 5`; `floodFill` also lacks the closed-set guard `findPath` has (178-197), re-expanding
stale heap pops.

### F4. Replan storms — no cooldown anywhere on the goal handlers
Verified: pursue (3257), knife (3277), pack-seek (3347), medic, patrol all re-run a full A* the
frame their path list is empty — an unreachable goal burns one full-grid A* **every frame**.
`NAV_REPATH_COOLDOWN_MS` exists but is only used by `followPath`'s off-line recovery (2715).
Non-heal kite-flee re-runs `findFleeGoal` (flood + (2R+1)² candidate objects) every frame while
it fails (3369-3377); the heal case latches via `botHealArrived` — partial mitigation confirmed.
`findMuzzleRecoveryCell` (2851-2870) runs `requestPath` per surviving ring candidate — up to 24
full A* per call (field prefilter at 2864 prunes some; still the "old flee shape" the comment at
3298 says was fixed). `choosePatrolResumeGoal` = one A* per patrol point per investigation exit.

### F5. Investigation subsystem: unbounded full-map work
`reachableInvestigationCells` (2778-2803): radius-unbounded BFS of every reachable cell with
string-keyed `Set` + one `{c,r}` object per cell, per investigation start (LOS-loss events —
continuous in a firefight). `orderInvestigationFrontier` (3123-3153): spread-object + `canSee`
per cell then a full sort — re-run on every flee completion (3194).
`investigationHasUnattemptedCells` (3086-3088): `.slice()` copies the whole pending array per
call while a seeker waits for the radius to expand.

### F6. `goalClaims`: O(claims) release called ≥2× per bot per frame + O(N) liveness probe
`bot-separation.js:80-82` — `release` walks the entire claim map; called unconditionally for
'pack' (3821) and 'flee' (3995) for essentially every bot every frame. `isClaimedByOther` →
`isAlive` → `botActors.some(...)` (2175) — an O(N) scan invoked **inside** candidate loops
(per flee cell, per recovery cell, per corner, per pack).

### F7. Instanced pools re-upload full fixed-capacity buffers every frame
`body-part-batches.js:80-86` / `weapon-part-batches.js:104-109`: `endFrame` sets
`instanceMatrix.needsUpdate = true` (+ color) on **every bucket** every frame, no
`addUpdateRange`, buffers sized to capacity 8192 / 2048 (defaults confirmed at call sites 698 /
599). Even count-0 buckets upload. On WebGPU this is full-buffer writes per bucket per frame —
hundreds of MB/s of dead upload. (Magnitude estimates vary by bucket count; the pattern is
verified.)

### F8. Corpses never retire
`bot-viewer.html:925-931`: dead ragdolled bots run `stepRagdoll` (14 constraint iterations, no
settle/sleep check in `ragdoll.js:270+` — `kineticEnergy` exists at 339 but is unused here) and
re-flush ~31 body-part matrices (5114 loops **all** actors) every frame, forever. `botActors` is
never pruned; with auto-add waves (957-972) cost grows with cumulative spawns and pushes pools
toward the 8192 cap, where `dropped` starts eating live bots' parts.

### F9. Facing cone: per-bot lit draw + per-frame material write, no toggle
`bot-viewer.html:749` (unique `ConeGeometry` + `MeshStandardMaterial` per bot), update at
1208-1212 rewrites `material.color` every frame per bot (dirty uniform upload) — verified there
is no visibility flag (only death hides it). This is the one **default-path** per-bot draw-call
cost (see F13 for the gated ones).

### F10. Health-pack seeking: raycast per pack per wanting bot, unbounded pack list
`nearestSeekablePack` (1609-1621, called at 3815 behind `wantsPack` — true for most healthy bots
with room): one BVH raycast per in-range unclaimed pack; `worldHealthPacks` grows with every
death (`dropActorHealthPacks`, 1581) and never despawns. `collectPacksUnderfoot` (1625) adds an
unconditional per-bot linear scan. Session-length perf leak on top of bot-count scaling.

---

## CONFIRMED — medium severity (grouped)

- **M1. Steady per-bot allocation churn**: `eyePos` clone per call (2137); `botXZ` object per
  call (2140); `chooseBotState` 24-key ctx literal + `{state}` wrapper (3953-3966,
  `bot-activity.js:32-99`); `aimAnglesTo` object; `updateBotWeaponMount` 2 Quaternions + 2
  Eulers + `getDebug()` object per bot per frame (659-677); `updateBot` mid/facing vectors
  (1164/1208); `updateAllBots` filter+map+Set per frame (939-940); `worldToCell`/`cellToWorld`
  object returns on all hot paths. ~40-60k allocations/s at 100 bots → minor-GC jitter.
- **M2. `pickCoverCorner` full corner-map scan with unthrottled miss path**: verified
  `coverSwitchAllowed` (bot-cover.js:62-64) is stamped only by `noteCoverSwitch` on a
  *successful* commit — a bot that probes and finds nothing rescans every corner record every
  frame (3944), and corner availability drops as N rises. (One scanner claimed the 0.8 s
  cooldown bounds this — **wrong**, audited against the code.)
- **M3. `smoothPath` O(pathLen²) DDA retraces** (nav-grid.js:243-255) — compounds with F4's
  replan frequency. Plus `followPath` computes `relaxedPopOk`'s `lineWalkable(p, path[1])`
  eagerly before the reach test (2702) and re-traces the same segment at 2713.
- **M4. Shot FX draw calls**: tracer/bullet pools are allocation-free (verified) but each live
  tracer + bullet is its own non-culled draw (`frustumCulled = false`), ~360 concurrent at 100
  bots; alert marks are 3 transparent draws per alerted bot (geometry/materials shared —
  verified memoised).
- **M5. Weapon buckets `castShadow = true` + `frustumCulled = false`**
  (weapon-part-batches.js:77-78) — full-roster weapon geometry submitted to the shadow pass
  regardless of the 24 m shadow box.
- **M6. Spawn-time per-bot GPU objects**: ~13 geometries + ~15 materials + a 320×80 canvas +
  `CanvasTexture` per bot for debug overlays that only one focused bot ever shows
  (2012-2084) — spawn-wave hitches + ~10 MB at 100 bots, no steady-state draw cost.
- **M7. Linear id lookups**: `combatEntityById` / `botActors.find` in medic paths / `isAlive`
  callback — all O(N) scans that a `Map<id, actor>` removes.
- **M8. Reload UI**: `updateBotWeaponButtons` rebuilds 6 button labels + DOM writes on every
  bot's reload events (4633-4645) instead of the existing `botShotUiDirty` coalescing path.
- **M9. `withBotActor` bind/commit tax**: ~130 property writes per bot per frame (2600-2688) —
  linear, architectural; cheapest fix is single bind+commit per bot.
- **M10. ~28 invisible scene-graph nodes per bot** still walked by `updateMatrixWorld`; weapon
  rig re-walked a second time by `flushWeaponMount(…, true)`.

## DOWNGRADED / CORRECTED

- **Tactical visuals (health bar / sight ring / FOV wedge)**: `botTacticalVisualsEnabled` and
  `botFovWedgeEnabled` default **false** (206-207) — the "300-900 draw calls in the mode the
  harness is used in" claim is opt-in, not default. Real when toggled (all bots pass
  `emitsFocusedBotDiagnostics` unless a focus is set); keep the instancing fix on the backlog
  but out of the critical path. Spawn-time allocation cost stands (M6).
- **`findMuzzleRecoveryCell`**: field prefilter + `MUZZLE_RECOVERY_CONFIRM_CAP` mitigations are
  real; still up-to-24-A* worst case → folded into F4.
- **`findFleeGoal` failure loop**: heal-flee latches via `botHealArrived`; only the combat
  kite-flee case loops per-frame → still F4, reduced blast radius.
- **`squad-activity.js`**: unwired in bot-viewer.html (zero call sites) — no runtime cost, out
  of scope.
- **`medicNavFlood`**: correctly throttled at 200 ms/medic; remaining cost folded into F3's
  floodFill allocation fix.

## REJECTED

Nothing was fabricated outright; all rejections were partial (the two above). The scanners'
"checked and dismissed" lists (debug gating, recording gates, alert ring cap at 64, batch flush
allocation-freedom) were spot-checked and held up.

---

# Remediation plan

Ordered by (impact at 100-200 bots) / effort. Each phase is independently shippable and
Node-testable; browser QA via the 30×30 maze "Test condition" preset + frame profiler.

## Phase 1 — kill the raycast storm (F1, biggest single win)
1. `map-collision.js`: set `_raycaster.firstHitOnly = true` (three-mesh-bvh fast path); add an
   allocation-free boolean `isOccluded(o, d, dist)` for LOS-only callers.
2. `selectBotTarget`: build per-team living-enemy arrays **once per frame** in `updateAllBots`;
   gate candidates by `sightDistance` (squared) *before* FOV/ray; sort survivors by distance and
   take the first clear one (early-out); reuse scratch vectors.
3. Flip `USE_FIELD_LOS_PREFILTER` on (field errs toward visible — pure prune) after a browser QA
   pass; also use it in `botCanSeePack` (already wired, dead behind the flag).
4. Stagger acquisition: full re-scan every 4th frame per bot (offset `id % 4`), keep the cached
   target + its last LOS verdict between scans (the 3773 confirm ray still runs every frame for
   the current target only).

## Phase 2 — bot spatial hash (root cause, F2)
5. Uniform XZ grid (cell ≈ 2 m) over nav bounds, rebuilt once per frame in `updateAllBots`;
   query helper returns bots in the 3×3 neighborhood.
6. Consume it in: `separationXZ`, `waypointContested`, `resolveBotPairs` broad phase,
   `sharedAllyAlertNear`, `livingTeammatesNear`, medic candidate gathering, and
   `recordNearMisses` (query cells overlapping the shot segment's expanded AABB).
7. Hoist `others` out of `followPath` entirely — pass the frame-scoped living list (also fixes
   the inside-the-while rebuild).
8. `Map<id, actor>` maintained on spawn/remove; replaces `combatEntityById`, medic `.find`s, and
   the `goalClaims` `isAlive` scan (store the actor ref in the claim record). Add a per-owner
   claim index so `release(id, kind)` is O(1) (F6).

## Phase 3 — nav allocation + replan hygiene (F3, F4, F5)
9. `nav-grid.js`: module-scratch `gScore/cameFrom/closed/dist/parent` buffers sized per grid
   bake, reset via generation-stamp `Int32Array` instead of `.fill()`; flat neighbor tables
   (`for k < 8`) replacing destructured `NEIGHBORS`; add the closed-guard to `floodFill`.
10. Per-bot replan cooldown (~300 ms, jittered by id) enforced inside `requestPath`, plus a
    global per-frame A* budget (~8, round-robin queue; bots keep the stale path until served).
    Cooldown latches for: failed `findFleeGoal` (non-heal), failed cover probe (stamp
    `gate.probeFailedAt`, M2), failed muzzle-recovery episodes.
11. `findMuzzleRecoveryCell`: one bounded `floodFill` + `floodPath` on the winner (same shape
    `findFleeGoal` already uses). `choosePatrolResumeGoal`: one floodFill, score all patrol
    points from it.
12. Investigation: bound the BFS to `initialRadius + durationMs × expansion` (cells beyond it
    are unreachable by the gate anyway); integer cell keys into a stamped typed array instead of
    string Sets; `investigationHasUnattemptedCells` → indexed loop / running counter;
    frontier list shrinks accordingly (fixes the sort + re-sort cost).
13. `smoothPath`: cap string-pull lookahead (~16 waypoints) — bounds the O(k²) retrace.

## Phase 4 — rendering (F7, F8, F9, M4-M6)
14. Both batch pools: in `endFrame`, skip buckets with `count === 0` **and** unchanged content;
    `instanceMatrix.addUpdateRange(0, count * 16)` (+ color equivalent) before `needsUpdate`.
15. Corpse retirement: freeze the ragdoll when `kineticEnergy(rd)` (already exported) drops
    below a threshold for ~0.5 s — stop `stepRagdoll` + `setRagdollPose`, keep the final flush;
    optional corpse cap with oldest-first despawn for long auto-add sessions.
16. Facing cone → one shared geometry + per-bot material replaced by a single `InstancedMesh`
    with per-instance color; write color only on state change.
17. Spawn cost: hoist the identical per-bot geometries/materials to module constants; build
    goal/investigation debug (canvas included) lazily on Alt-click focus.
18. Weapon buckets: `castShadow = false` (or tracked bounds + culling) — guns outside the 24 m
    shadow box contribute nothing.

## Phase 5 — GC scraps + polish (M1, M7-M10)
19. Out-param scratch variants for `eyePos`, `botXZ` (or direct field reads), `worldToCell`/
    `cellToWorld` hot callers, `aimAnglesTo`; `chooseBotState` returns the string, caller reuses
    one ctx object; hoisted quaternions/eulers + `getAction()` in the weapon mount path.
20. Reload UI through `botShotUiDirty`; single bind/commit per bot in `withBotActor`;
    `matrixAutoUpdate = false` on transform-only rig nodes; pack list: despawn timer/cap +
    spatial bucket (F10 residue after Phase 2's hash exists).

**Verification per phase**: `node test-bot-activity.mjs` + the nav/separation/cover test files
must stay green; add a headless perf smoke (spawn 200 simulated bots, run 600 updateAllBots
ticks, assert wall-clock ceiling) so regressions are visible in Node before browser QA.
