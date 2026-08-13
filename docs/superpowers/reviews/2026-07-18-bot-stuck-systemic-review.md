# Bot Movement/Pathing — Systemic Stuck-ness Review

**Date:** 2026-07-18 · **Scope:** the bot movement/pathing stack as it exists after the `lastSafePos` fall-catch and `stuckReplanCount` fixes landed (`environment-viewer.html` ~1634–2496, `bot-entity.js`, `bot-activity.js`, `nav-grid.js`, `map-collision.js`), reviewed against the two `botStatsLog` recordings in `research/stats/` (`bots-2026-07-18T22-11-41-476Z.csv`, 12 bots; `bots-2026-07-18T01-40-13-182Z.csv`, 110 bots). Read-only review; no code changed.

**Overall verdict:** This is a **systemic problem, not a residue of two bugs** — and the freshly-landed `stuckReplanCount` fix will not survive re-verification, for two independent reasons detailed in Findings 1 and 2. The architecture has three layers (grid A* over an approximation of the world, raw constant-velocity waypoint chasing, post-hoc position corrections) that are never reconciled with each other, so any disagreement between "where physics puts a bot" and "where the nav grid thinks a bot can be" becomes a **permanent, absorbing stall**: the CSV shows that every stuck episode longer than ~1 s never recovered for the rest of the session. The recovery mechanisms that are supposed to prevent this (`pathFailCount` escape hatch, `stuckReplanCount`) are respectively a no-op and unreachable in the cases they target. The good news: the measured 43%-stuck figure is dominated by *one* failure loop (empty-path stall + dead escape hatch), so a small, targeted recovery fix should reclaim most of it — but the generators of stuck-ness (no clearance modeling, no local avoidance, physics/nav divergence) remain and need design-level work, not more counters.

---

## What the data actually shows

Re-analysis of `bots-2026-07-18T22-11-41-476Z.csv` (12 bots, 64 samples @ 500 ms ≈ 32 s, **no squads** — `squadId` is empty on every row, so none of this stuck-ness is formation-goal-driven):

- 314 of 726 alive samples (43.3%) have `stuckMs > 0`; mean per-tick stuck fraction 40.9%, peak 83%.
- **Every single stuck sample has `waypoints = 0` and `speed ≈ 0`.** All measured stuck-ness is one mode: `requestBotPath` returning an empty path from the bot's current position, over and over, while the bot stands still.
- `pathFailCount` in stuck samples takes only values **0–5, never ≥6**. That is the signature of the escape-hatch reset loop (Finding 1): the counter climbs one per 500 ms retry, hits `BOT_STUCK_ESCAPE_RETRIES` (6) at ~3 s, the escape hatch fires, instantly "arrives" (distance to `lastSafePos` ≈ 0), resets to 0, and the cycle repeats forever. Tracing individual bots at the loop's 3 s period shows the counter frozen at the same phase (e.g. `bot-36`: 26 s at (17.3, 24.9), `pathFailCount` = 3 at every 3 s sample, position drift < 4 cm).
- **Stuck is an absorbing state.** Per-bot episode analysis: every episode over ~1 s ran to the end of the recording (`bot-33` 7.1 s→end, `bot-34` 17.9 s→end, `bot-36` 25.9 s→end, `bot-41` 20.2 s→end, `bot-42` 12.3 s→end, `bot-44` 10.6 s→end…). 9 of 12 bots ended the session in a stall they never exited. The ~43% average is just this absorbing state filling up over 32 s; a longer session trends toward 100%.
- The session ran on terrain (bot `y` varies 8.3–16.5 m), i.e. the **local-window A\*** branch of `requestBotPath` with `botTerrainWalkable`, not the shoot-house static bake. `bot-41`'s trace shows the classic generator: it walked downhill at full commanded speed (y 14.3 → 8.4 over ~20 m), stopped, and never moved again — physics let it descend into ground the walkability test rejects, and no recovery mechanism can get it out.
- Historical scale (`bots-2026-07-18T01-40-13-182Z.csv`, 110 bots, pre-any-fix): 24.9% of alive samples stuck, 45 of 110 bots fell through the map, min y −73,828. The fall-through fix held (0 falls in the new recording); the stall problem did not.

So: the prior sessions' focus on "one bot stuck 25.8 s" genuinely missed the story. 25.8 s isn't an outlier duration — it's simply how long that bot had been in the absorbing state when the recording ended.

---

## Finding 1 — The escape hatch is dead code: it steers toward the bot's own feet

**File:** `environment-viewer.html:2127–2143` (escape steering), `:2210–2211` (`lastSafePos` update)
**Severity:** Blocker — this single loop accounts for essentially all measured stuck-ness in the 12-bot recording.

`rec.lastSafePos` is updated to the bot's current position **every tick `bot.onFloor` is true** (line 2211). A stalled bot is standing on the ground, so it is grounded every tick, so `lastSafePos` is always its current position. When `pathFailCount`/`stuckReplanCount` reach 6 and the escape hatch engages (line 2136), `dist = |lastSafePos − pos| ≈ 0 < 0.3`, so it takes the "reached safe ground" branch: zero velocity, reset both counters, resume normal pathing — which fails identically, and the whole cycle repeats every ~3 s forever. The CSV's 0–5-only `pathFailCount` distribution is this loop's fingerprint.

This is a regression introduced by the 2026-07-17 fall-through fix: retargeting the hatch from `spawnPos` to `lastSafePos` fixed the uncollided-beeline-across-a-collision-gap fall (correctly), but silently reduced the hatch to a no-op for every *grounded* stall — which is nearly all of them. The old `spawnPos` target was dangerous but at least moved bots; the new target cannot move anyone. The only case `lastSafePos` differs from the current position is mid-air free-fall, which the separate fall-catch (line 2212) already handles.

The deeper issue: "last position I was grounded" and "last position the nav grid could path from" are different concepts, and the recovery needs the second one. Being on the collision mesh (`onFloor`) says nothing about being on the walkable set — `bot-41` was grounded the entire 20 s it was unreachable to A*.

## Finding 2 — The `stuckReplanCount` fix targets a branch its own trigger case can never reach

**File:** `environment-viewer.html:2229–2246` (forced replan), `:2107–2127` (retry/escape structure)
**Severity:** Blocker — predicts the pending re-verification recording will still show wedged bots stuck indefinitely.

The wedged-with-a-"valid"-path case (bug #2) plays out per tick as: forced replan clears `currentPath` (line 2240) → next tick `botTickMovement` immediately replans (`canRetry` is true — the forced replan sets `stuckReplanAt` but never `pathRetryAt`) → the replan **succeeds** (the goal is nav-valid, that's the premise) → `currentPath.length > 0` → `followBotPath` runs (line 2125) → the escape-hatch check at line 2127 sits inside `else if (rec.currentPath.length === 0)` and is **never evaluated**. `stuckReplanCount` dutifully accumulates past 6, and nothing ever reads it, because the only reader is gated behind an empty path that a wedged bot never has. And even if it were reachable, the escape steering itself is the Finding 1 no-op. Two independent reasons the fix can't work.

This is the third documented round of recovery mechanisms defeating each other (`bots.md`'s 2026-07-17 entry narrates round two: the `pathFailCount` bump wiped by the reset at line 2122). Five ad-hoc fields now exist (`pathFailCount`, `pathRetryAt`, `stuckReplanCount`, `stuckReplanAt`, `stuckSince`) with three different reset semantics spread across four code sites (2118–2123, 2140, 2222, 2239–2245, 2478–2482) plus a side effect (`patrolIdx++` on path failure at 2118) that does nothing on terrain maps (wander goals don't read `patrolIdx`, so a stalled terrain bot retries the *same* goal forever). This is the counter-sprawl the review was asked about, and it is genuinely patch-on-patch: each counter exists to evade another counter's reset rule.

## Finding 3 — Physics and nav disagree in both directions, and nothing reconciles them

**Files:** `environment-viewer.html:1707–1719` (`botTerrainWalkable`), `:1699–1701` (`botNavWalkable`), `bot-entity.js:40–57`, `map-collision.js:63–115`, `nav-grid.js:38–49`
**Severity:** Blocker (this is the generator; Findings 1–2 are why it's unrecoverable)

**Physics permits what nav forbids.** `botTerrainWalkable` rejects cells with ≥0.9 m rise per 1.5 m cell (~31°), but `stepBotPhysics`/`resolveCapsule` ground a bot on anything with contact normal y ≥ 0.5 (~60°), and nothing at all limits *downhill* travel or being displaced by `pushBotsApart` (which translates capsules with no walkability or collision check, line 1961). Additional un-navigated position sources: the spawn fallback (`botSpawnSlot:1739–1747`) places bots on a golden-angle spiral around the player with zero walkability check, and the escape hatch itself historically beelined across arbitrary terrain. Once a bot physically occupies a cell the walkability test rejects — and `findPath`'s start snap (`nearestWalkable`, `nav-grid.js:38`, max 4 cells = 6 m local / 2 m static) can't reach walkable ground — every path request fails for every goal, permanently. `requestBotPath`'s `nearestWalkableInGrid` fallback (line 2026) retargets the **goal** only; nothing ever fixes the **start**. That is exactly `bot-41`'s terminal state.

**Nav permits what physics forbids.** No clearance/erosion anywhere: walkability is sampled at cell centers only, cells are 0.5 m (static) / 1.5 m (local) and the capsule is 0.6 m diameter (`bot-entity.js:7`). A path may thread a gap the capsule cannot fit, and `smoothPath`'s `lineWalkable` (`nav-grid.js:120–129`) string-pulls paths to within ~0.25 m of wall faces — less than the capsule radius — so bots chronically scrape and corner-catch on geometry the grid calls open. This is the actual root of "frozen with a valid path": the path is only valid for a point, not for a capsule.

The shoot-house static branch is worse on the recovery side: `requestBotPath:2004–2008` has **no** `nearestWalkableInGrid` fallback at all (that exists only in the local-window branch), and its start snap is just 2 m.

## Finding 4 — No local steering layer: dynamic obstacles are handled by position teleports that fight the path follower

**Files:** `environment-viewer.html:1979–1995` (`followBotPath`), `:1945–1975` (`pushBotsApart`), `:2457–2496` (tick order)
**Severity:** Should-fix (major contributor to the *undetected* stuck category, see Finding 5)

`followBotPath` is the entire movement model: set velocity at constant full `botMoveSpeed` straight at the next waypoint. There is no avoidance, no arrival slow-down, no blending, no concept of another bot existing. The nav grid models only static geometry. The *only* bot-vs-bot mechanism is `pushBotsApart`, a post-hoc pairwise XZ position correction that runs **after** all `botTickOne` calls, splits the push 50/50 regardless of who is moving (a walking bot and a deliberately-stationary AIM/FIRE bot get shoved equally), and never touches velocity — so next tick the follower commands full speed into the same body again. Two bots converging on nearby goals (shared patrol points via `botSpawnPoints`, or squad formation slots) reach a standing-wave equilibrium: full commanded velocity, zero net displacement, forever — the doorway/corridor deadlock in shoot-house geometry, with no timeout, because contention is not a path failure and (Finding 5) doesn't even register as stuck.

Squad mode multiplies goal contention (`squadMemberGoal:2063–2069`: 5 members on a 5 m ring around a moving leader, adjacent slots ~5.9 m apart, formation points placed with no walkability or occupancy check) but is not the base cause — the 12-bot recording had no squads and still hit 43%.

## Finding 5 — The stuck metric measures commanded velocity, not achieved displacement

**Files:** `environment-viewer.html:2229` (`speed: Math.hypot(bot.velocity.x, bot.velocity.z)`), `bot-activity.js:45–54`
**Severity:** Should-fix (data quality — it shaped the last three fixes)

`trackStuck` is fed post-physics *velocity*. `resolveCapsule` zeroes the into-wall velocity component (`map-collision.js:98–99`), so wall-wedged bots do read ~0 and are detected — but a bot blocked purely by another bot keeps its full commanded 2.4 m/s (`pushBotsApart` corrects position, never velocity, and runs after the sample), so the entire bot-vs-bot contention category from Finding 4 is **invisible** to `stuckSince`, the inspector's STUCK flag, and the CSV. The 43% figure is therefore a *lower bound*, and the diagnostic loop that produced the recent fixes has been systematically blind to one of the two stall families. `rec.lastPos`/`distanceTraveled` (updated at 2225–2227) already contain the right signal; it just isn't the one being tested.

---

## Is it systemic? Yes — summary of the argument

1. The dominant measured failure is not an edge case: it's the designed steady-state response to a path failure (stand still → retry → escape hatch that provably cannot move a grounded bot → reset → repeat). One in-code loop explains ~all 314 stuck samples.
2. Stalls are absorbing because *every* recovery path is broken: goal-retarget fixes goals but never starts; the escape hatch is a no-op (Finding 1); the forced-replan counter feeds an unreachable branch (Finding 2). This isn't bad luck — it's what happens when recovery is bolted on as counters around a movement core that has no notion of "am I physically making progress toward where I claim to be going."
3. Both stall *generators* are architectural absences, not bugs: no capsule clearance in the nav representation (nav-valid ≠ physically-traversable) and no dynamic-obstacle handling in the movement model (physics-valid ≠ nav-reachable). Every patch so far has adjusted the failure counters; none has touched either generator.

## Recommendations (ranked by impact ÷ effort)

**R1. Make recovery actually move the bot.** (small diff, removes ~all *measured* stuck-ness)
- Recovery target = nearest walkable cell **to the bot's own position** (`nearestWalkableInGrid` over the freshly built local window / static grid — the scan already exists at 2036), not `lastSafePos`. Steer straight to it (short, bounded — typically < 6 m), then clear counters and repath. Keep `lastSafePos` strictly for the mid-air fall-catch, which it serves correctly.
- Add the `nearestWalkableInGrid` fallback to the static-grid branch of `requestBotPath` (2004–2008), which currently has none.
- Hoist the escape-hatch check out of the `else if (currentPath.length === 0)` branch (2126) so a wedged bot with a nominally valid path can reach it — or better, fold it into R3's single state machine.
- Cheap fallback if the nearest-walkable steer itself stalls (unwalkable ≠ untraversable, so it usually won't): teleport to that cell after a bounded timeout. Bots already teleport on fall-catch; a 1-in-a-hundred-seconds snap beats a permanent statue.

**R2. Erode the nav grid by capsule radius.** (medium diff in `nav-grid.js` / the two walkability tests, kills the wedged-valid-path generator at the source)
- Mark a cell walkable only if the walkability test also passes within capsule radius (for the 0.5 m static grid: the 4 orthogonal neighbors; for the 1.5 m local window a center test plus half-cell offsets). Equivalently post-process the baked grid with a 1-cell erosion. Make `lineWalkable` sample at the same inflated standard so `smoothPath` stops string-pulling within a radius of walls.
- This also shrinks Finding 3's "physics permits what nav forbids" gap from the other side: fewer paths lead bots to positions from which the (now stricter) grid can't restart — so R2 must ship together with R1, which is what makes stricter grids safe.

**R3. Replace the five counters with one explicit movement status.** (medium refactor, prevents round four of fixes defeating each other)
- One per-bot field, e.g. `moveStatus: OK | NO_PATH | NO_PROGRESS | RECOVERING`, with a single transition function fed by (a) path-request results and (b) *displacement-based* progress (R4). Recovery (R1) is entered from `NO_PATH`/`NO_PROGRESS` after a threshold, exited only by displacement or arrival. Delete `pathFailCount`/`stuckReplanCount`/`stuckReplanAt` and the `patrolIdx++`-on-failure side effect (2118). The transition function belongs in `bot-activity.js` where it's Node-testable — the current counters have zero test coverage, which is how two broken interactions shipped.

**R4. Feed `trackStuck` displacement, not velocity.** (one-line-ish, do with R3 or immediately)
- `speed = hypot(pos − lastPos)/dt` using the already-maintained `rec.lastPos`, sampled after `pushBotsApart` (move the sample or the push). Makes bot-vs-bot stalls visible to the FSM, the inspector, and the CSV, and makes the next verification recording trustworthy.

**R5. Add a soft separation force to `followBotPath` and demote `pushBotsApart` to penetration-only.** (medium; eliminates the contention/doorway category rather than detecting it)
- Blend a repulsion term from bots within ~2× capsule radius into the commanded velocity before physics (the legacy creature viewer's `computeSteering` separation-force pattern is the in-house precedent), add arrival slow-down over the last ~1 m, and treat a final waypoint occupied by another stationary bot as reached (`dist < reach + r_a + r_b`). Keep `pushBotsApart` as a last-resort overlap fix. Full ORCA/RVO is not warranted at n ≤ 12; a separation force plus goal-occupancy is.

**R6. Stop generating off-nav positions.** (small pieces, lowest urgency once R1 exists as the safety net)
- Spawn fallback (`botSpawnSlot`) should reject/nudge unwalkable spiral points via the same walkability tests. Optionally, clamp commanded movement crossing from a walkable into an unwalkable cell (one cell lookup per tick) so bots stop marching down terrain traps that only physics permits — with R1 in place this becomes belt-and-braces rather than critical.

Suggested order: R1+R4 first (small, verifiable with a fresh `botStatsLog` recording expected to show stuck episodes becoming rare *and short* instead of absorbing), then R2, then R3, then R5, R6 opportunistically.

## Verification note for whoever implements

The success metric should be **episode duration**, not just stuck fraction: the current data's defining pathology is that episodes never end. After R1, re-record 12 bots for ≥2 min and check (a) no `pathFailCount` sawtooth (values ≥6 should now appear transiently, or the counter is gone per R3), (b) max episode length bounded (seconds, not session-length), (c) with R4 in place, watch for the previously-invisible bot-vs-bot stalls surfacing — expect the raw stuck fraction to *rise* briefly when the metric is fixed before R5 brings it down. That is signal, not regression.
