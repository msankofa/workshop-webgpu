# Lens: pathfinding / nav cost — model: opus

Audit of `bot-viewer.html` pathing/goal/replan code plus `nav-grid.js`, `nav-corners.js`,
`nav-visibility.js`. Only findings whose cost scales with bot count are listed.

## Sizing assumptions used throughout

The harness's own stress preset ("Test condition", `bot-viewer.html:4529-4546`) sets
`mazeCols = 30; mazeRows = 30` with `mazeCellSize = 3.5`, i.e. a 105 m × 105 m map. With
`NAV_CELL = 0.5` (`bot-viewer.html:2154`) that bakes a **210 × 210 = 44,100-cell nav grid**, of
which roughly 20,000–25,000 cells are walkable. The same preset spawns 200 dummies. Every
per-grid cost below should be read against `n = 44,100`.

Every living bot runs the full FSM every frame with **no striding, no time-slicing, no AI budget**:
`updateAllBots` (`bot-viewer.html:920-944`) loops all actors and calls `updateBotSentry` +
`updateBot` unconditionally, and it is called once per rendered frame from
`renderer.setAnimationLoop` (`bot-viewer.html:5081-5095`). There is no "N bots per frame" gate
anywhere in the nav path, so every finding below multiplies by the full bot count each frame.

---

## Finding: `findPath` allocates and zero-fills three full-grid typed arrays on **every** call

**File:** `nav-grid.js:126-132`

```js
  const n = cols * grid.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
```

**Why it is slow at high N.** Cost is `O(grid cells)` *per A\* call*, entirely independent of how
far the bot is actually walking. On the 210×210 test map that is 352.8 KB + 176.4 KB + 44.1 KB =
**~573 KB freshly allocated and 88,200 elements explicitly written** before a single node is
expanded. A bot re-pathing to a waypoint two metres away pays the same as a corner-to-corner path.
Every goal handler in `bot-viewer.html` routes through `requestPath` → `findPath`
(`bot-viewer.html:2747-2756`).

**How cost scales.** `O(bots × replans_per_bot_per_frame × gridCells)` in both time and GC
pressure. Purely additive per bot — 100 bots each replanning once a frame at 60 fps is
573 KB × 100 × 60 ≈ **3.4 GB/s of garbage**, which alone will pin the major-GC.

**Severity at 100 bots: high.**

**Fix sketch.** Hoist the three arrays into module-level scratch buffers sized to the grid on first
use, and replace the `.fill()` with a monotonically-increasing `visitStamp` `Uint32Array` so a call
only touches the cells it actually expands.

---

## Finding: `floodFill` allocates full-grid arrays even though `maxRadius` bounds it to a tiny disc

**File:** `nav-grid.js:170-176`

```js
  const cols = grid.cols, n = cols * grid.rows;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
```

**Why it is slow at high N.** Callers pass a *tiny* radius. `findFleeGoal` passes
`botBehaviorSettings.fleeSearchRadius = 5` cells (`bot-viewer.html:2468, 3297, 3299`) — the flood
visits at most 11×11 = 121 cells but still allocates and fills 44,100 `Float64` + 44,100 `Int32`
entries. That is a **~365:1 waste ratio**: ~529 KB allocated and 88,200 writes to compute 121
useful distances. `medicNavFlood` (`bot-viewer.html:3525-3532`) has the same shape at 200 ms
cadence per medic.

**How cost scales.** `O(bots_in_FLEE × gridCells)` per frame, plus `O(medics × gridCells / 200ms)`.
At 25 % medics and 100 bots that is 25 medics × 5 floods/s × 529 KB ≈ 66 MB/s of garbage from the
medic path alone, before any flee traffic.

**Severity at 100 bots: high.**

**Fix sketch.** Share the same stamped scratch buffers as `findPath`, or (better) index the bounded
region into a local `(2R+1)²` dense array so allocation is proportional to `maxRadius`, not to the
map.

---

## Finding: every goal handler re-runs a full A\* the moment its path list is empty — no replan cooldown

**Files:** `bot-viewer.html:3257-3265` (pursue), `3277-3285` (knife), `3347-3356` (pack seek),
`3447-3454` (cover move), `3649-3653` (medic move), `3704-3708` (medic cohesion),
`2990-2997` (patrol), `2902-2905` (muzzle recovery)

```js
  if (pathMode !== 'pursue' || goalChanged(goal) || currentPath.length === 0) {
    currentPath = requestPath(bot, goal);
    pathMode = 'pursue';
    botCombatMoveGoal = goal;
  }
  if (currentPath.length === 0 || followPath(bot, currentPath, currentBotMoveSpeed())) {
    pathMode = null;
    botCombatMoveGoal = null;
  }
```

**Why it is slow at high N.** This is a self-sustaining replan storm. If `requestPath` returns `[]`
— which happens whenever the goal is unreachable, or when the smoothed path collapses to just the
start waypoint that gets sliced off (`bot-viewer.html:2755`) — the second `if` immediately clears
`pathMode`, so the *next* frame takes the first branch again and burns another full-grid A\*. Any
bot whose goal is standing inside a wall margin, or that is currently being shoved by the pushout
pass, pays one 573 KB full-grid A\* **every single frame** with nothing to show for it. There is no
guard: the only replan throttle in the file, `NAV_REPATH_COOLDOWN_MS = 350`
(`bot-viewer.html:2445`), is used exclusively by `followPath`'s off-line recovery branch
(`bot-viewer.html:2715-2719`) and by nothing else.

The healthy case is barely better: `goalChanged` uses a 0.65 m threshold
(`bot-viewer.html:3250-3252`), and `updateKnifeMovement` tightens it to 0.35 m
(`bot-viewer.html:3277`). A pursuing bot chasing a target moving at ~2.4 m/s replans roughly
**4–7 times per second, per bot**, forever.

**How cost scales.** `O(bots × gridCells)` per frame in the degenerate case; `O(bots × 6/s ×
gridCells)` in the normal chase case. 100 pursuing bots ≈ 600 full-grid A\* per second sustained,
~2,000+/s if a meaningful fraction are stuck.

**Severity at 100 bots: high.**

**Fix sketch.** Give each actor a `nextReplanAt` stamp (reuse `entity.navRepathAt`) and refuse any
`requestPath` inside ~250–400 ms, jittered per bot so a squad that loses its goal on the same frame
does not resynchronise into a single-frame spike.

---

## Finding: `findFleeGoal` re-runs the whole flood + candidate scan every frame while it keeps failing

**File:** `bot-viewer.html:3369-3377` (caller) and `3292-3339` (body)

```js
  if (pathMode !== 'flee' || !botCombatMoveGoal || currentPath.length === 0) {
    const plan = findFleeGoal();
    if (!plan) {
      if (botHealRequested) recordBotEvent(activeBotActor, 'heal-flee: no reachable retreat goal', now);
      goalClaims.release(bot.id, 'flee');
```

**Why it is slow at high N.** The `!plan` branch does not stamp any cooldown or latch, so a cornered
bot with no unclaimed retreat cell re-runs `floodFill` + the 121-cell candidate scan + `visField.canSee`
per candidate + `goalClaims.isClaimedByOther` per candidate, **every frame, indefinitely**. This is
exactly the state a crowded map produces: `goalClaims` is global and layout-scoped
(`bot-viewer.html:2417`), so as bot count rises more of each bot's 121-cell flee disc is already
claimed by neighbours, which makes `findFleeGoal` *more* likely to fail and therefore *more* likely
to loop. The failure mode gets worse as N grows — a superlinear feedback loop, not a linear cost.

The candidate loop also allocates: `cellToWorld` returns a fresh object per cell
(`nav-grid.js:31-33`), and `candidates.push({ ...goal, c, r, score, covered })`
(`bot-viewer.html:3319`) spreads a new object per cell — 242 short-lived objects per call.

**How cost scales.** `O(bots_in_FLEE × (gridCells_alloc + (2R+1)²))` per frame, with the fraction of
bots stuck in the failing branch itself rising with N.

**Severity at 100 bots: high.**

**Fix sketch.** On `!plan`, stamp a per-actor `fleeSearchBlockedUntil = now + 400` and short-circuit
until it expires; also reuse a preallocated candidate scratch array instead of spreading objects.

---

## Finding: `findMuzzleRecoveryCell` runs a full A\* per candidate cell in the search ring

**File:** `bot-viewer.html:2851-2870`

```js
  for (let radius = 1; radius <= BOT_RECOVERY_CELL_RADIUS; radius++) {
    const ring = []; // Favor the nearest ring: this is a short firing adjustment, not a flank.
    ...
        const path = requestPath(bot, candidate);
        if (path.length === 0) continue;
        const score = pathDistance(start, path);
        ring.push({ ...candidate, c, r, key, path, score, muzzle });
```

**Why it is slow at high N.** With `BOT_RECOVERY_CELL_RADIUS = 2` (`bot-viewer.html:1963`) the two
rings hold 8 + 16 = **24 cells, each of which triggers its own full-grid A\***. One
`findMuzzleRecoveryCell` call is therefore up to 24 × 573 KB ≈ **13.7 MB of allocation and 24
full-grid fills**, all to pick a repositioning cell at most 1 m away. It is invoked from
`beginMuzzleRecovery` (`bot-viewer.html:2890`), which fires whenever `botBlockedShotStreak` reaches
`BOT_BLOCKED_SHOT_THRESHOLD = 2` (`bot-viewer.html:1962, 2934-2943`) — i.e. two consecutive
world/terrain hits. In a maze with 100+ bots firing past each other into walls, that trigger fires
constantly and independently per bot. Worse, when the function returns `null`,
`botRecoveryIssueActive` stays `true` and the very next blocked shot re-enters the same 24-A\* scan.

The `goalClaims.isClaimedByOther` check at `bot-viewer.html:2860` runs *before* the expensive
`requestPath`, which is correct, but it only prunes cells another bot has actually claimed.

**How cost scales.** `O(blocked_shot_events_per_second × 24 × gridCells)`; the event rate itself
scales with bot count because more bots means more shots and more mutual blocking.

**Severity at 100 bots: high** (bursty, but each burst is a multi-millisecond frame spike, so it
reads as stutter rather than a lower average).

**Fix sketch.** Score candidates by straight-line/flood distance first, run `requestPath` only on
the single best candidate (or reuse one `floodFill` from the bot for all 24 cells via `floodPath`),
and cooldown the whole episode after a `null` result.

---

## Finding: `reachableInvestigationCells` floods the **entire** connected map with string-keyed Sets, per bot per investigation

**File:** `bot-viewer.html:2778-2803`, called from `beginInvestigation` at `bot-viewer.html:3104`

```js
  const visited = new Set([navCellKey(startCell.c, startCell.r)]);
  const queue = [startCell];
  ...
      const key = navCellKey(c, r);
      if (visited.has(key) || !isWalkableCell(navGrid, c, r)) continue;
```

with `navCellKey` being `function navCellKey(c, r) { return `${c},${r}`; }` (`bot-viewer.html:2757`).

**Why it is slow at high N.** There is **no radius bound** on this BFS — it enumerates every cell
reachable from the bot, which on a connected maze is the whole walkable set (~20,000+ cells). Each
cell costs one template-literal string allocation, one `Set` hash insert, and one `{c, r}` object
push; diagonal neighbours cost two more `isWalkableCell` calls. That is roughly **20,000 strings +
20,000 objects + 160,000 neighbour probes per call**. It runs once per investigation, and an
investigation begins every time a bot loses sight of a live target — which in a maze happens
continuously and independently for every bot.

**How cost scales.** `O(bots_losing_LOS_per_second × walkableCells)`. With 100 bots in a maze,
LOS-loss events are effectively continuous; a frame in which even 10 bots simultaneously begin an
investigation costs ~200,000 string allocations in that single frame.

**Severity at 100 bots: high.**

**Fix sketch.** Bound the BFS to the investigation's plausible radius (it is already
radius-gated at consumption time by `investigationCellIsWithinRegion`,
`bot-viewer.html:3081-3084`), and key `visited` with the integer `r * cols + c` into a stamped
`Uint32Array` instead of strings in a `Set`.

---

## Finding: `orderInvestigationFrontier` rebuilds, `canSee`-tests and sorts the entire reachable-cell list — and is re-run on every flee completion

**File:** `bot-viewer.html:3123-3153`

```js
  for (const cell of investigation.cells) {
    ...
    if (anchorIdx !== -1 && visField.canSee(cellIdxOf(cell.c, cell.r), anchorIdx)) alignment += INVESTIGATE_LOS_BONUS;
    pending.push({ ...cell, key, ring, alignment, distanceSq });
  }
  pending.sort((a, b) =>
    a.ring - b.ring ||
    b.alignment - a.alignment ||
```

**Why it is slow at high N.** `investigation.cells` is the unbounded reachable set from the previous
finding (~20,000 entries). For each one this allocates a `navCellKey` string, a `cellToWorld`
object, a spread `{...cell, ...}` object, and performs one `visField.canSee` bitset probe — then
sorts ~20,000 objects with a 5-term comparator (`O(n log n)` ≈ 286,000 comparator invocations).
It is called from `beginInvestigation` (`bot-viewer.html:3112`) **and again** from
`updateInvestigationPreferenceAfterFlee` (`bot-viewer.html:3194`), which fires every time a fleeing
bot completes a retreat leg (`bot-viewer.html:3388`) — so a bot that flees repeatedly re-sorts the
whole map repeatedly.

**How cost scales.** `O((investigation_starts + flee_completions) × walkableCells log walkableCells)`.
Both event rates scale linearly with bot count.

**Severity at 100 bots: high.**

**Fix sketch.** Cap `pending` to a bounded shell around the anchor (only cells inside
`initialRadius + durationMs × expansionMetresPerSecond` can ever be selected anyway), and re-rank
by mutating scores in place rather than rebuilding the array on flank flips.

---

## Finding: `investigationHasUnattemptedCells` copies the whole pending array, every frame, per waiting seeker

**File:** `bot-viewer.html:3086-3088`, called from `bot-viewer.html:3217`

```js
function investigationHasUnattemptedCells(investigation) {
  return investigation.pending.slice(investigation.pendingIndex).some((cell) => !investigation.attempted.has(cell.key));
}
```

**Why it is slow at high N.** `.slice()` materialises a **full copy** of the remaining pending array
(up to ~20,000 object references) purely to feed `.some()`, which could have been an indexed loop.
This is not a rare path: `updateSeekMovement` calls `planNextInvestigationGoal` whenever
`pathMode !== 'seek'` (`bot-viewer.html:3214`), and the common early-investigation outcome is `null`
because the expanding uncertainty radius has not reached the next cell yet
(`bot-viewer.html:3159-3162`). The `null` branch then sets `pathMode = null; currentPath = []`
(`bot-viewer.html:3223`), so the next frame takes the same branch again. A bot sitting in the
"waiting for the search radius to expand" state therefore allocates a 20,000-element array
**every frame**, and `investigationSearchRadius` starts at 1.25 m and grows at only 0.55 m/s
(`bot-viewer.html:2506-2510`) — so that wait lasts many seconds.

**How cost scales.** `O(bots_in_SEEK × walkableCells)` array-element copies *per frame*. 20 seeking
bots on the test map ≈ 400,000 reference copies + 20 large array allocations per frame, sustained.

**Severity at 100 bots: high** — this is the single worst sustained per-frame allocation in the nav
path.

**Fix sketch.** Replace with an indexed loop
(`for (let i = investigation.pendingIndex; i < investigation.pending.length; i++)`), or better,
maintain a running `unattemptedCount` so the check is `O(1)`.

---

## Finding: `pickCoverCorner` linearly scans the entire baked corner map, per bot, per frame, with no throttle on the miss case

**File:** `bot-cover.js:102-122`, driven from `bot-viewer.html:3944`

```js
  for (const rec of corners) {
    const dist = Math.hypot(rec.anchorPos.x - botPos.x, rec.anchorPos.z - botPos.z);
    if (dist > searchRadius) continue;
    if (skip && skip(rec)) continue;
    if (field.canSee(threatCell, rec.anchorCell) || !field.canSee(threatCell, rec.peekCell)) continue;
```

```js
  const coverProbe = !coverCommitted && coverEntryOk ? findCoverCorner(bot, coverThreat) : null;
```

**Why it is slow at high N.** `cornerMap.corners` has no spatial index — the radius test at
`bot-cover.js:110` is applied *after* the `Math.hypot`, so every bot walks the entire corner list
(a 30×30 maze bakes on the order of 10³ corner records; `buildCornerMap` emits up to 8 per tall
rect, `nav-corners.js:52-83`). The probe at `bot-viewer.html:3944` runs **unconditionally every
frame** for any non-committed bot with an in-band threat. The only rate limit is
`coverSwitchAllowed(coverGate, now)` (`bot-viewer.html:3943`, `bot-cover.js:62-64`) — but
`gate.switchedAt` is only stamped by `noteCoverSwitch`, which only runs on a *successful* commit
(`bot-viewer.html:3421`). **A bot that never finds a corner is never throttled** and re-scans the
whole corner map every frame forever. That is precisely the crowded case, because
`skip` vetoes every corner already claimed by a neighbour
(`bot-viewer.html:3410-3411`) — so corner availability falls as N rises while scan frequency stays
at 100 %.

**How cost scales.** `O(bots_in_combat × corners)` per frame, with the fraction of bots in the
never-throttled miss branch increasing with N. 100 bots × ~1,000 corners = 100,000 `Math.hypot` +
`skip()` + 2 bitset probes per frame.

**Severity at 100 bots: medium-high.**

**Fix sketch.** Bucket `cornerMap.corners` into a coarse uniform grid keyed by anchor cell and
iterate only the buckets within `COVER_SEARCH_RADIUS`; additionally stamp `gate.switchedAt` (or a
separate `probeFailedAt`) when a probe returns `null` so failures back off too.

---

## Finding: `goalClaims.release` is an O(all claims) map walk and is called unconditionally twice per bot per frame

**Files:** `bot-separation.js:79-82` (implementation), `bot-viewer.html:2175` (`isAlive` callback),
`bot-viewer.html:3821` and `bot-viewer.html:3995` (per-frame callers)

```js
  function release(id, kind = null) {
    for (const [key, c] of cells) if (c.id === id && (kind == null || c.kind === kind)) cells.delete(key);
  }
```

```js
const goalClaims = createGoalClaims((id) => botActors.some((a) => a.id === id && a.entity.alive !== false));
```

```js
  if (state !== BOT_FLEE) goalClaims.release(bot.id, 'flee'); // any flee exit path frees the claimed cell
```

**Why it is slow at high N.** `release` has no reverse index, so freeing one bot's claim iterates
every claim in the map. The map holds up to one entry per bot per claim kind (`flee`, `cover`,
`pack`, `recover`), so its size is `O(N)`. `updateBotSentry` calls `release` at least twice per bot
per frame — line 3821 for `pack` whenever there is no seekable pack (the common case), and line 3995
for `flee` whenever the state is not `BOT_FLEE` (also the common case) — plus line 4005 in the
`beingHealed` branch. That is **`O(N²)` Map iteration per frame** for work that is almost always a
no-op.

Separately, `isAlive` is a linear `botActors.some` scan, so every `isClaimedByOther` hit costs
`O(N)`. `isClaimedByOther` is called *inside* per-cell loops: once per flee candidate
(`bot-viewer.html:3314`, 121 cells), once per recovery ring cell (`bot-viewer.html:2860`), once per
corner record (`bot-viewer.html:3411`), and once per world health pack
(`bot-viewer.html:1614`). Worst case that is `O(N × corners × N)` inside a single cover probe.

**How cost scales.** `O(N²)` per frame for the unconditional releases; up to `O(N × candidates × N)`
for the claim lookups inside goal scans.

**Severity at 100 bots: medium** (10,000+ map iterations/frame is real but not yet dominant);
**high at 200** where it compounds with the corner scan.

**Fix sketch.** Keep a per-owner `Map<id, Map<kind, cellIdx>>` so `release` is `O(1)`, guard the
per-frame calls behind "did this bot actually hold a claim of this kind", and back `isAlive` with an
`id -> actor` map instead of a linear scan.

---

## Finding: `followPath` rebuilds a full `botActors` entity array inside its waypoint loop and does two O(N) neighbour scans per bot per frame

**File:** `bot-viewer.html:2692-2729`

```js
function followPath(entity, path, speed) {
  while (path.length > 0) {
    const target = path[0];
    const p = botXZ(entity);
    ...
    const others = botActors.map((a) => a.entity);
```

**Why it is slow at high N.** `botActors.map(...)` sits **inside the `while` loop**, so it
reallocates an N-element array on every waypoint the bot pops in a single frame (and at minimum
once per bot per frame). It is then handed to `waypointContested` (`bot-viewer.html:2703`,
`bot-separation.js:64-73`) and `separationXZ` (`bot-viewer.html:2723`,
`bot-separation.js:36-49`), each an unindexed linear scan of all bots with `Math.hypot` per pair.

**How cost scales.** `O(N²)` distance tests per frame plus `O(N)` array allocations of size `N` per
frame. At 100 bots: 100 arrays × 100 entries = 10,000 references allocated, 20,000 `Math.hypot`
calls; at 200 bots those quadruple to 40,000 / 80,000. This is on top of the separate `O(N²)`
`resolveBotPairs` pass at `bot-viewer.html:939-942`, which shares the same missing broadphase.

**Severity at 100 bots: medium**; **high at 200.**

**Fix sketch.** Hoist `others` to a single array rebuilt once per frame in `updateAllBots`, and add
a uniform-grid broadphase (cell size = `SEPARATION_RADIUS`) shared by `separationXZ`,
`waypointContested`, and `resolveBotPairs`.

---

## Finding: `followPath` runs 2–3 `lineWalkable` DDA traces per bot per frame, one of them needlessly

**File:** `bot-viewer.html:2702` and `2712-2713`

```js
    const relaxedPopOk = path.length === 1 || !navGrid || lineWalkable(navGrid, p, path[1]);
```

```js
    if (navGrid && !ownBlocked && !lineWalkable(navGrid, p, target)) {
      if (path.length > 1 && lineWalkable(navGrid, p, path[1])) { path.shift(); continue; }
```

**Why it is slow at high N.** `lineWalkable` (`nav-grid.js:216-238`) is a supercover DDA that steps
cell-by-cell across the whole segment. Because `smoothPath` string-pulls waypoints, segments are
*long by design* — tens to well over a hundred cells on the 210×210 test map. Line 2702 computes
`relaxedPopOk` **before** the `dist < reach` test, so it is paid on every frame for every bot even
though its only consumer is the crowd-relax band between `WAYPOINT_REACH` (0.35 m) and
`WAYPOINT_REACH + WAYPOINT_CONTEST_RELAX` (0.80 m) — a condition that is false the overwhelming
majority of frames.

**How cost scales.** `O(bots × segmentLengthInCells)` per frame. 100 bots × ~2 traces × ~60 cells
≈ 12,000 grid lookups per frame, roughly a third of which are the avoidable `relaxedPopOk`.

**Severity at 100 bots: medium.**

**Fix sketch.** Compute `relaxedPopOk` lazily only when `dist` falls inside the relax band, and cache
the `lineWalkable(p, target)` verdict for a few frames (re-test only after the bot has moved more
than ~0.5 × `NAV_CELL`).

---

## Finding: `smoothPath` is O(pathLength²) in grid-cell traversals and runs on every `requestPath`

**File:** `nav-grid.js:243-255`, called from `bot-viewer.html:2751`, `3120`, `3337`

```js
  let anchorIdx = 0;
  for (let i = 1; i < path.length; i++) {
    if (i === path.length - 1) { out.push(path[i]); continue; }
    if (!lineWalkable(grid, path[anchorIdx], path[i + 1])) {
      out.push(path[i]);
      anchorIdx = i;
    }
```

**Why it is slow at high N.** Each iteration re-traces from the *current anchor* to `i + 1`, so an
open run of `k` cells costs `1 + 2 + … + k = O(k²)` cell probes. A\* returns one waypoint per grid
cell, so a corner-to-corner path on the test map is ~300 waypoints; in long straight maze corridors
the anchor does not advance, producing tens of thousands of `isWalkableCell` calls **per
`requestPath`**. This is paid on top of the A\* itself for every replan counted in the replan-storm
finding above.

**How cost scales.** `O(replans_per_frame × pathLength²)`. It compounds multiplicatively with the
uncooldowned replan cadence rather than adding to it.

**Severity at 100 bots: medium** on its own; **high** once combined with the replan frequency.

**Fix sketch.** Cap the string-pull lookahead (e.g. only attempt to skip forward `≤ 16` waypoints
from the anchor), or smooth lazily — only the first two or three segments the bot will actually walk
this replan interval.

---

## Finding: `nearestSeekablePack` does one BVH raycast per world pack, per bot, per frame

**File:** `bot-viewer.html:1609-1620` (and `botCanSeePack`, `1593-1605`), called unconditionally
from `updateBotSentry` at `bot-viewer.html:3815`

```js
  for (const record of worldHealthPacks) {
    const cell = worldToCell(navGrid, record.x, record.z);
    if (goalClaims.isClaimedByOther(cellIdxOf(cell.c, cell.r), bot.id)) continue;
    const seen = botCanSeePack(bot, record);
```

```js
  if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(eye.x, eye.z, record.x, record.z)) return { visible: false, dist };
  ...
  const blocked = mapCollider?.raycast([eye.x, eye.y, eye.z], [dir.x / len, dir.y / len, dir.z / len], len - 0.05);
```

**Why it is slow at high N.** This is a nav-goal picker that costs one full `mapCollider.raycast`
per candidate. `worldHealthPacks` grows with deaths — every bot drops its remaining packs on death
(`dropActorHealthPacks`, `bot-viewer.html:1581-1590`), so in a 200-bot firefight the pack list
climbs into the hundreds and never shrinks except through pickups. The `sightDistance` range check
at line 1597 prunes some, but the per-pack loop and the `worldToCell` +
`goalClaims.isClaimedByOther` (itself `O(N)` via the linear `isAlive`) run for all of them. Crucially
the cheap escape hatch is **disabled**: `USE_FIELD_LOS_PREFILTER = false`
(`bot-viewer.html:1965`), so the baked visibility field — which exists precisely to skip these
raycasts — is never consulted here.

**How cost scales.** `O(bots × packs)` raycasts per frame, and `packs` itself grows roughly linearly
with cumulative deaths, so the product is effectively `O(N²)` over a match. 100 bots × 150 packs =
15,000 BVH raycasts per frame.

**Severity at 100 bots: high.**

**Fix sketch.** Flip `USE_FIELD_LOS_PREFILTER` on after QA (it is a pure prune — the field errs
toward "visible", so it can only remove work), bucket `worldHealthPacks` into a coarse spatial grid,
and only re-evaluate the pack goal every few hundred ms rather than every frame.

---

## Finding: `choosePatrolResumeGoal` runs one full A\* per patrol point on every investigation exit

**File:** `bot-viewer.html:3028-3054`, called from `finishInvestigation` (`bot-viewer.html:3058`)

```js
  for (let index = 0; index < patrolPoints.length; index++) {
    const goal = patrolPoints[index];
    ...
    const path = requestPath(bot, goal);
    if (path.length === 0) continue;
```

**Why it is slow at high N.** The maze layout's patrol points are the four map corners
(`bot-viewer.html:2387`), so this is 4 full-grid A\* calls (≈ 2.3 MB of allocation) plus 4
`smoothPath` passes — and each one is a genuinely *long* corner-to-corner search that expands a
large fraction of the 44,100-cell grid, unlike the short tactical replans elsewhere. It fires
whenever an investigation ends, which happens per bot on target loss/expiry/exhaustion
(`bot-viewer.html:3202, 3210, 3219`) and on every search-region exhaustion.

**How cost scales.** `O(investigation_exits_per_second × patrolPoints × gridCells)`. Exit rate
scales linearly with bot count, and rooms layouts with more patrol points multiply it further.

**Severity at 100 bots: medium** (bursty, but each burst is several milliseconds and bursts
correlate across bots because they lose contact together).

**Fix sketch.** Score patrol points with a single `floodFill` from the bot and `floodPath` only the
winner, instead of an A\* per candidate — the same substitution the flee goal already made.

---

## Finding: `floodFill` has no closed set, so nodes are re-expanded once per stale heap entry

**File:** `nav-grid.js:178-197`

```js
  while (heap.length > 0) {
    const curKey = heapPop(heap);
    const cr = Math.floor(curKey / cols), cc = curKey % cols;
    const curD = dist[curKey];

    for (const [dc, dr, cost] of NEIGHBORS) {
```

**Why it is slow at high N.** `findPath` guards its main loop with `if (closed[curKey]) continue;`
(`nav-grid.js:137-138`), but `floodFill` has no equivalent. The heap uses lazy deletion, so a cell
relaxed `k` times sits in the heap `k` times and gets its full 8-neighbour expansion re-run on each
pop. On an 8-connected grid that is typically a 2–3× constant factor on every flood — paid by every
flee replan and every medic flood.

**How cost scales.** Constant-factor multiplier on an already per-bot-per-frame cost, so it
multiplies whatever the flood-fill volume is.

**Severity at 100 bots: low-medium.**

**Fix sketch.** Add the same stamped `closed` guard `findPath` uses, or skip stale pops by comparing
the popped `f` against `dist[curKey]`.

---

## Finding: array-destructuring the `NEIGHBORS` table in both innermost search loops

**File:** `nav-grid.js:142` and `nav-grid.js:183`

```js
    for (const [dc, dr, cost] of NEIGHBORS) {
```

**Why it is slow at high N.** This is the innermost statement of both A\* and the flood fill. Each
iteration allocates an array-iterator step and destructures a nested array rather than reading flat
typed-array slots. A full-grid A\* expansion is ~44,100 nodes × 8 neighbours = **353,000
destructurings per call**, and the call itself already happens many times per frame.

**How cost scales.** Constant-factor on the dominant nav cost, so it multiplies with replan
frequency and bot count.

**Severity at 100 bots: low** in isolation, but it is a near-free win given how hot the loop is.

**Fix sketch.** Replace `NEIGHBORS` with three flat `Int8Array`/`Float64Array` tables (or one
interleaved `Float64Array`) and index them with a plain `for (let k = 0; k < 8; k++)` loop.

---

## Out of scope, noted for completeness

`buildVisibilityField` (`nav-visibility.js:69-95`) is `O(walkableCells²)` in both time and memory:
at ~22,000 walkable cells that is ~242 million `traceClear` calls and a `bits` array of
`22,000 × ceil(22,000/32) × 4 B ≈ 60 MB`. This is per-layout bake cost, not per-bot, so it is
excluded per the audit brief — but it does mean the map size that makes every finding above severe
is also the map size where the bake itself becomes the gating constraint.
