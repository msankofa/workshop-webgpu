# Lens: algorithmic complexity / pair loops — model: opus

Audit target: `bot-viewer.html` (5138 lines) plus the support modules it calls from hot paths.
Scenario assumed: N = 100 living bots, 60 fps, `updateAllBots` → `withBotActor(actor, …)` →
`updateBotSentry` + `updateBot` runs **once per living bot per frame** (`bot-viewer.html:924-937`).
Every "per bot per frame" cost below is therefore multiplied by N.

**Headline structural gap: there is no spatial partitioning of bots anywhere in this harness.**
A nav grid, a baked visibility field and a baked corner map all exist and are all used for
*static* queries, but no structure indexes *bots* by position. Every neighbor question
("nearest enemy", "teammates near me", "who is alerted near me", "is anyone crowding my
waypoint") is answered by a full linear scan of `botActors`. That single omission is the root
cause of findings 1, 3, 5, 6 and 7 below.

---

## Finding: `selectBotTarget()` does an all-enemies scan **with a BVH raycast per candidate**, per bot, per frame

**File:** `bot-viewer.html`
**Lines:** 1866-1890 (definition), called unconditionally at 3759 from `updateBotSentry`.

```js
function selectBotTarget() {
  const live = [
    ...dummyTargets.filter((target) => target.alive),
    ...botActors.filter((actor) => actor.entity !== bot && actor.entity.alive !== false && actor.entity.team !== bot?.team).map((actor) => actor.entity),
  ];
  ...
  for (const target of live) {
    const targetEye = eyePos(target);
    const direction = targetEye.clone().sub(origin);
    ...
    if (!withinBotFov(bot.yaw, origin, targetEye)) continue;
    if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(origin.x, origin.z, targetEye.x, targetEye.z)) continue;
    if (mapCollider.raycast([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], distance - 0.02)) continue;
```

**Loop nesting:** `updateAllBots` (N) → `updateBotSentry` → `selectBotTarget` → `for (const target of live)` (N/2 enemies).

**Why slow at high N:**
1. The candidate array is rebuilt from scratch every call: two `filter`s, one `map`, and two
   spread copies — **N array allocations of ~N/2 elements each per frame**.
2. `eyePos()` (`bot-viewer.html:2137-2138`) does `capsule.start.clone().lerp(...)`, and
   `direction = targetEye.clone().sub(origin)` — 2 `THREE.Vector3` allocations per candidate,
   i.e. ~N²/2 vector allocations per frame.
3. Worst of all, there is **no distance sort and no early-out**: the FOV cone is the only
   filter before the raycast, so every enemy inside the (default wide) FOV gets a full
   `mapCollider.raycast`. The sight-distance gate is checked *inside* `withinBotFov`? No — it
   is not checked at all here (the range gate at 3773 is applied later, only to the *chosen*
   target). Distant enemies across the whole map are raycast every frame.
4. `mapCollider.raycast` (`map-collision.js:127-136`) uses `_raycaster.intersectObject(colliderMesh, false)[0]`
   with **`firstHitOnly` never set** — three-mesh-bvh therefore collects *all* triangle hits
   along the ray into a fresh array and sorts them, then discards all but `[0]`.
5. `USE_FIELD_LOS_PREFILTER = false` (`bot-viewer.html:1965`), so the cheap baked-field
   prefilter that exists specifically to skip these raycasts is **switched off**.

**Scaling:** O(bots²) BVH raycasts + O(bots²) Vector3 allocations per frame.
At 100 bots (50 enemies each, say half inside the FOV cone) that is ~2,500 all-hit BVH
raycasts and ~5,000 Vector3 allocations **per frame** — 150,000 raycasts/second.

**Severity at 100 bots: HIGH.** This is almost certainly the single largest CPU cost in the harness.

**Fix sketch:** Keep a per-frame team-bucketed array of living enemies (built once in
`updateAllBots`, not per bot); reject by squared distance against `sightDistance` and by FOV
*before* any raycast; sort candidates by distance and raycast only until the first clear one;
set `_raycaster.firstHitOnly = true` in `map-collision.js`; and re-run LOS acquisition on a
staggered cadence (e.g. each bot re-acquires every 4th frame, offset by `bot.id % 4`) rather
than every frame.

---

## Finding: `nearestSeekablePack()` raycasts every dropped pack, per bot, per frame

**File:** `bot-viewer.html`
**Lines:** 1609-1621 (definition), `botCanSeePack` 1593-1605, called at 3815 from `updateBotSentry`.

```js
  for (const record of worldHealthPacks) {
    const cell = worldToCell(navGrid, record.x, record.z);
    if (goalClaims.isClaimedByOther(cellIdxOf(cell.c, cell.r), bot.id)) continue;
    const seen = botCanSeePack(bot, record);
```

and inside `botCanSeePack`:

```js
  const blocked = mapCollider?.raycast([eye.x, eye.y, eye.z], [dir.x / len, dir.y / len, dir.z / len], len - 0.05);
```

**Loop nesting:** N bots → `for (const record of worldHealthPacks)` (P packs) → one BVH
raycast + one `isClaimedByOther` (which is itself O(N), see finding 4).

**Why slow at high N:** `P` is not a constant — it **grows with bot count and with fight
duration**. Every bot spawns holding packs (`healthPacks: Array.from({length: role.startingPacks}…)`,
2573) and `killCombatBot` → `dropActorHealthPacks` (1581-1590) scatters all of them onto the
ground on death, where they persist until someone walks over them. So P ≈ O(N) in a 100-bot
firefight. The gate at 3815 is `wantsPack`, which for a healthy bot is just
`canHold(actor.healthPacks, actor.maxPacks)` — true for most bots most of the time, so this is
effectively unguarded. Note the range check inside `botCanSeePack` happens *before* the raycast
(1597), which helps, but `sightDistance` is map-scale so most packs pass it on these small maps.

Secondary, same shape: `collectPacksUnderfoot` (1625-1642) is called **unconditionally** at
3808 and scans all P packs per bot per frame (cheap `Math.hypot` only, no raycast).

**Scaling:** O(bots × packs) BVH raycasts per frame, with packs ≈ O(bots) ⇒ **O(bots²) raycasts per frame**.

**Severity at 100 bots: HIGH** (once casualties start; negligible at spawn).

**Fix sketch:** Bucket `worldHealthPacks` into nav-grid cells and query only the cells within
`shortProximity`/`sightDistance` of the bot, do the LOS raycast only for the single nearest
surviving candidate, and re-evaluate pack seeking on a cadence (every ~200 ms) rather than
every frame.

---

## Finding: `followPath()` allocates an N-element array and runs two O(N) neighbor scans, per bot, per frame

**File:** `bot-viewer.html`
**Lines:** 2692-2740. `others` built at 2698; `waypointContested` at 2703; `separationXZ` at 2723.
Pure helpers in `bot-separation.js:36-49` (`separationXZ`) and `64-73` (`waypointContested`).

```js
function followPath(entity, path, speed) {
  while (path.length > 0) {
    ...
    const others = botActors.map((a) => a.entity);
    ...
    const reach = relaxedPopOk && waypointContested(entity, others, target, dist, WAYPOINT_CONTEST_RANGE)
      ? WAYPOINT_REACH + WAYPOINT_CONTEST_RELAX : WAYPOINT_REACH;
    ...
    const sep = separationXZ(entity, others, SEPARATION_RADIUS);
```

**Loop nesting:** N bots → `followPath` (called from every movement state: patrol 3013, pursue 3260ish,
flee 3384, cover-move 3454, pack-seek 3356, medic-move 3653, medic-cohesion 3708, muzzle-recovery 2906)
→ `while (path.length > 0)` → `botActors.map` (N) + `waypointContested` (N) + `separationXZ` (N).

**Why slow at high N:**
- `const others = botActors.map(...)` is built **inside the `while` loop**, so a frame in which
  the bot pops 3 consumed waypoints allocates 3 N-element arrays for that one bot. Even in the
  common single-iteration case it is one N-element array per moving bot per frame.
- `separationXZ` and `waypointContested` each iterate all N bots with no radius pre-filter —
  they compute `Math.hypot` against every bot on the map to find the handful within
  `SEPARATION_RADIUS` (a few metres).

**Scaling:** O(bots²) distance tests + O(bots²) array-element copies per frame.
At 100 bots: ~20,000 hypots and ~10,000 array writes per frame just for steering.

**Severity at 100 bots: HIGH.** Same order as finding 1 but with a much smaller constant
(no raycasts), so it bites second.

**Fix sketch:** Hoist `others` out of the `while` loop and out of `followPath` entirely —
build one shared living-entity array per frame in `updateAllBots`; then replace both scans with
a nav-grid-cell spatial hash rebuilt once per frame, querying only the 3×3 cell neighborhood.

---

## Finding: `goalClaims.release()` scans the whole claim map, and `isClaimedByOther` does an O(N) liveness lookup

**File:** `bot-separation.js` lines 78-95; the liveness callback is `bot-viewer.html:2175`.

```js
// bot-separation.js
  function release(id, kind = null) {
    for (const [key, c] of cells) if (c.id === id && (kind == null || c.kind === kind)) cells.delete(key);
  }
  ...
    isClaimedByOther(cellIdx, id) {
      const c = cells.get(cellIdx);
      return !!c && c.id !== id && isAlive(c.id);
    },
```

```js
// bot-viewer.html:2175
const goalClaims = createGoalClaims((id) => botActors.some((a) => a.id === id && a.entity.alive !== false));
```

**Loop nesting (release):** N bots → `updateBotSentry` calls `release` at least twice per frame
(3821 pack-release-or-claim, 3995 flee release; plus 4005, 3373/3385, 2807/2908, 3431) →
each `release` iterates the entire `cells` Map, whose size is O(N) since every living bot may
hold a claim. `claim()` also calls `release()` internally, so a claim is a full scan too.

**Loop nesting (isClaimedByOther):** it is called from *inside* candidate loops —
`nearestSeekablePack` per pack (1614), `findMuzzleRecoveryCell` per ring cell (2860),
`findFleeGoal` per candidate cell (3314), `findCoverCorner`'s `skip` per corner record (3411).
Each call does `botActors.some(...)` = an O(N) linear id search.

**Why slow at high N:** the claim map is keyed by cell index but `release` is keyed by owner id,
so there is no index for the operation performed most often. And `isAlive` re-derives liveness
by scanning `botActors` when the claim record could simply store the actor reference.

**Scaling:** `release` ⇒ O(bots²) Map-entry visits per frame (≥2 scans/bot/frame).
`isClaimedByOther` ⇒ O(candidates × bots) per goal search, e.g. `findFleeGoal` with
`fleeSearchRadius` R visits (2R+1)² cells × O(N) ⇒ thousands of bot-array scans per flee replan.

**Severity at 100 bots: MEDIUM** for `release` (cheap per visit, ~20k Map iterations/frame);
**MEDIUM-HIGH** for `isClaimedByOther` inside `findFleeGoal`/`findCoverCorner`, which are the
searches that run during exactly the moments the framerate matters (a firefight).

**Fix sketch:** Keep a second `Map<ownerId, Set<cellIdx>>` so `release` is O(claims held by that
owner) instead of O(all claims); and store the owning actor object (not just the id) in the claim
record so `isAlive` is a property read instead of `botActors.some`.

---

## Finding: `sharedAllyAlertNear()` scans all bots for every bot, every frame

**File:** `bot-viewer.html`
**Lines:** 1682-1694 (definition), called at 3875 in `updateBotSentry`.

```js
function sharedAllyAlertNear(me, now) {
  const p = botXZ(me);
  let best = null;
  for (const other of botActors) {
    if (other.entity === me || other.entity.alive === false || other.entity.team !== me.team) continue;
    const rep = other.alertReport;
    if (!rep || now - rep.at > alertWindowMs(rep)) continue;
    const q = botXZ(other.entity);
    if (Math.hypot(q.x - p.x, q.z - p.z) > SEMI_ALERT_SHARE_RADIUS) continue;
```

**Loop nesting:** N bots → `for (const other of botActors)` (N). The call at 3875 is
`firsthand || sharedAllyAlertNear(bot, now)` — short-circuited only when the bot already has a
firsthand report, which is the *rare* case, so in practice it runs for essentially every bot
every frame.

Also in this family, per bot per frame at 3873/3876/3896: `latestAllyHitNear` →
`latestAlertNear` (`bot-alert.js:27-36`), `alertEscalation` (`bot-alert.js:68-77`) and
`latestNearMiss` (`bot-alert.js:40-47`) each scan the `recentAllyHits` ring. That ring is capped
at 64 (`pushAllyReport`, 1646-1649), so those three are O(64·bots) — linear, not quadratic, but
they add ~19,000 iterations/frame at 100 bots on top of everything else.

`livingTeammatesNear` (1695-1704) is another full O(N) scan but is **properly guarded** — it only
runs when a report exists *and* `esc.score >= ALERT_PUSH_SCORE` (3880), so it is a rare path;
downgraded to low.

**Scaling:** O(bots²) `Math.hypot`/field tests per frame from `sharedAllyAlertNear` alone,
plus O(64 × bots) from the ring scans. `botXZ` allocates a small object per call (2140-2142),
so this also produces ~N² short-lived objects per frame.

**Severity at 100 bots: MEDIUM** (10,000 iterations/frame with a small constant; it is
overshadowed by findings 1-3 but is pure waste).

**Fix sketch:** Maintain a per-team list of currently-alerted actors (updated when
`actor.alertReport` is set/cleared, typically a handful of entries) and scan only that list,
or fold the query into the same per-frame spatial hash used for separation.

---

## Finding: `resolveBotPairs()` is an unpartitioned O(N²) pushout, and every moved bot then pays another BVH capsule resolve

**File:** `bot-separation.js` lines 13-33; call site `bot-viewer.html:939-942`.

```js
// bot-viewer.html
  const living = botActors.filter((a) => a.entity.alive !== false && !a.ragdoll).map((a) => a.entity);
  for (const entity of resolveBotPairs(living)) {
    if (mapCollider) mapCollider.resolveCapsule(entity.capsule, entity.velocity, {});
  }
```

```js
// bot-separation.js — the comment already admits the shape
// One O(n^2) XZ pushout pass over bot capsule pairs; caller pre-filters dead/ragdolled bots.
  for (let i = 0; i < bots.length; i++) {
    const a = bots[i];
    for (let j = i + 1; j < bots.length; j++) {
```

**Loop nesting:** explicit `i` × `j` double loop over all living bots, once per frame.

**Why slow at high N:** the pair test itself is cheap (a `Math.hypot`, no allocation), so 4,950
pairs at 100 bots is tolerable in isolation — but it is O(N²) with **no broad phase at all**,
and it degrades quadratically: 200 bots is 19,900 pairs. The bigger hidden cost is the
follow-up: `resolveBotPairs` returns the Set of bots it moved, and in a crowded map that set
approaches all N bots, each of which then pays a **second** `mapCollider.resolveCapsule` — a
three-mesh-bvh `shapecast` with up to 3 iterations (`map-collision.js:107-115`) — on top of the
one `stepBotPhysics` already did. That doubles the per-frame BVH capsule work whenever bots are
packed together, which is exactly the 100-bot scenario.

**Scaling:** O(bots²) distance tests + up to O(bots) extra BVH shapecasts per frame.

**Severity at 100 bots: MEDIUM** (rising to HIGH at 200, where the pair loop quadruples and
crowding makes near-100% of bots re-resolve).

**Fix sketch:** Bin bots into nav-grid cells (cell size ≥ 2× capsule radius) and test only
same-cell + 8-neighbor pairs; that alone turns the pushout into O(bots × local density) and
also cuts the moved-set to genuinely-colliding bots.

---

## Finding: `pickCoverCorner()` linearly scans the entire baked corner map, per bot, per frame

**File:** `bot-cover.js` lines 102-121; wrapper `bot-viewer.html:3408-3414`; call site 3944.

```js
// bot-cover.js
export function pickCoverCorner({ corners, field, navGrid, searchRadius, skip }, botPos, threatPos) {
  ...
  for (const rec of corners) {
    const dist = Math.hypot(rec.anchorPos.x - botPos.x, rec.anchorPos.z - botPos.z);
    if (dist > searchRadius) continue;
    if (skip && skip(rec)) continue;
```

```js
// bot-viewer.html:3944
  const coverProbe = !coverCommitted && coverEntryOk ? findCoverCorner(bot, coverThreat) : null;
```

**Loop nesting:** N bots → `findCoverCorner` → `for (const rec of corners)` (C records), and for
each record within `searchRadius`, `skip` → `goalClaims.isClaimedByOther` → `botActors.some` (N).

**Why slow at high N:** `C` is a map constant, not a bot constant — but it is large. The corner
bake (`nav-corners.js:48-84`) emits up to 8 records per sight-blocking rect (4 corners × 2 faces);
the default 8×8 maze layout with cover pieces produces on the order of 10² wall/cover rects,
so C is in the low hundreds. `searchRadius` filters *inside* the loop, so the full C scan happens
regardless of how few corners are actually nearby. The guard on this call is weak: `coverEntryOk`
only requires a threat in band and `coverSwitchAllowed` (an 0.8 s per-bot cooldown that is
`true` by default until the bot's first switch), so an engaged bot without a committed corner
probes **every frame**.

**Scaling:** O(bots × corners) per frame, plus O(bots × in-radius-corners × bots) from the
claim check. At 100 bots and C≈300: ~30,000 corner iterations/frame plus tens of thousands of
`botActors.some` steps.

**Severity at 100 bots: MEDIUM-HIGH** (it is zero-raycast, but it is a full data-structure sweep
per bot per frame during exactly the combat moments where frame time is already tight).

**Fix sketch:** Bucket `cornerMap.corners` by nav-grid cell at bake time and iterate only the
cells within `COVER_SEARCH_RADIUS`; and rate-limit the probe itself (a cover re-probe every
~250 ms per bot is behaviorally indistinguishable from every frame).

---

## Finding: A* re-planning has no per-frame budget, and each `findPath` allocates and fills three whole-grid typed arrays

**File:** `nav-grid.js` lines 114-161 (`findPath`) and 166-201 (`floodFill`);
callers `bot-viewer.html:2747-2756` (`requestPath`), 3257-3258 (pursuit re-path), 3299 (flee flood).

```js
// nav-grid.js:126-129
  const n = cols * grid.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
```

```js
// bot-viewer.html:3257-3258 — pursuit re-paths whenever the target has moved 0.65 m
  if (pathMode !== 'pursue' || goalChanged(goal) || currentPath.length === 0) {
    currentPath = requestPath(bot, goal);
```

**Loop nesting:** N bots → `updatePursuitMovement`/`updateSeekMovement`/`updateFleeMovement`/
`updateCoverMoveMovement`/`updateMedicMoveMovement`/`updatePatrolMovement` → `requestPath` →
`findPath` (O(cells) alloc + O(cells log cells) search) → `smoothPath` → `lineWalkable` DDA per
retained waypoint.

**Why slow at high N:** the search itself is fine, but the *setup* is O(grid cells) regardless of
path length — a `Float64Array(n).fill(Infinity)` over the whole grid. The default 8×8 maze at
3.5 m spacing with 0.5 m nav cells is ~56×56 = 3,136 cells, i.e. ~41 KB allocated **and zero/
Infinity-filled** per A* call. `goalChanged` uses a 0.65 m threshold (3250-3252), so a bot
pursuing a target moving at ~4 m/s re-paths roughly 6×/second. There is **no global budget, no
stagger, and no queue** — if 60 bots decide to re-path on the same frame, all 60 A* searches run
in that frame.

`findFleeGoal` (3292-3339) is worse per call: a `floodFill` (same whole-grid allocation) plus a
(2R+1)² candidate scan plus a `floodPath` — and it runs whenever a fleeing bot has no committed
path. `findMuzzleRecoveryCell` (2841-2880) can issue **up to 24 `requestPath` calls in a single
invocation** (one per ring cell, line 2865) — 24 whole-grid allocations for one bot's decision.

**Scaling:** O(bots × grid cells) allocation + fill per second, unbounded per frame.
At 100 bots × ~5 re-paths/s × 41 KB ≈ **20 MB/s of typed-array garbage**, with frame-time spikes
whenever many bots re-path on the same tick.

**Severity at 100 bots: MEDIUM-HIGH** — not a per-frame quadratic, but it is the most likely
source of *stutter* (GC pauses and multi-bot re-path convoys) rather than steady-state fps loss.

**Fix sketch:** Hoist the three scratch arrays into module-level buffers reused across calls with
a generation stamp instead of `.fill()`; add a global per-frame path budget (e.g. max 8 A*
searches/frame, queued round-robin, bots keep their stale path until served); and raise the
pursuit `goalChanged` threshold / add a minimum re-path interval per bot.

---

## Finding: `recordNearMisses()` scans every bot on every shot, with a nested ring search

**File:** `bot-viewer.html`
**Lines:** 1659-1673 (definition), called from `fireBotShot` at 4218.

```js
function recordNearMisses(origin, dir, travelled, hitId, attacker, now) {
  if (!attacker?.alive) return;
  const a = botXZ(attacker);
  for (const actor of botActors) {
    ...
    const c = e.capsule.start.clone().add(e.capsule.end).multiplyScalar(0.5);
    if (shotMissDistance(origin, dir, travelled, c) > NEAR_MISS_RADIUS) continue;
    const v = botXZ(e);
    const prior = recentAllyHits.find(r => r.kind === NEAR_MISS_KIND && r.victimId === e.id && now - r.at <= NEAR_MISS_WINDOW_MS);
```

**Loop nesting:** shots-this-frame → `for (const actor of botActors)` (N) → `recentAllyHits.find`
(up to 64) for any bot inside the near-miss radius. Shots per frame themselves scale with N.

**Why slow at high N:** it is a point-vs-segment test against *every bot on the map* for a
1.5 m radius, with no broad phase — the shot segment's AABB would eliminate ~all of them. It also
allocates two `Vector3`s per bot per shot (`clone().add(...).multiplyScalar`). With 100 bots at a
~8 rounds/s cyclic rate, roughly 10-15 bots fire on any given frame, so this is ~1,500 segment
tests and ~3,000 Vector3 allocations per frame, purely to notice the occasional whizz-by.

**Scaling:** O(shots × bots) per frame, and shots ∝ bots ⇒ **O(bots²) per frame** during a
sustained firefight.

**Severity at 100 bots: MEDIUM.**

**Fix sketch:** Compute the shot segment's AABB expanded by `NEAR_MISS_RADIUS` and query only the
nav-grid cells it overlaps from the per-frame bot spatial hash; and index `recentAllyHits` by
`victimId` so the dedupe lookup is a Map hit rather than a 64-entry linear `find`.

---

## Finding: medic duty re-scans all bots per medic per frame, then does three `botActors.find` id lookups

**File:** `bot-viewer.html`
**Lines:** 3559-3616 (`decideMedicDuty`, ally scan at 3568), `botActors.find` at 3600, 3622
(`stickyHealTend`), 3664 (`updateMedicTend`); called from `updateBotSentry` at 3971.
`updateMedicCohesionMovement` (3691-3710) has a second full scan at 3697.

```js
  for (const other of botActors) {
    if (other === actor || other.entity.team !== bot.team) continue;
    ...
    const targetActor = botActors.find((a) => a.entity.id === action.targetId);
```

**Loop nesting:** M medics (M = `botMedicPercent`% of N, default nonzero) → full `botActors`
scan (N) + up to 3 linear `find`s (N each).

**Why slow at high N:** the candidate scan is a straight linear pass with only a squared-distance
filter applied *after* the team/role/claim tests, and the id→actor lookups are linear searches
over an array that already has a stable `entity.botActor` back-reference (set at 2596) and could
trivially be a `Map`. The one genuinely expensive part — the nav flood-fill — *is* properly
throttled (`MEDIC_NAV_FLOOD_MS = 200`, 3524-3532), so credit where due; the O(N) scans around it
are not.

**Scaling:** O(medics × bots) per frame ⇒ O(bots²) with a fractional constant. At 100 bots and
15% medics: ~1,500-6,000 iterations/frame.

**Severity at 100 bots: LOW-MEDIUM** (the medic fraction keeps the constant small; it would
become material at a high medic percentage).

**Fix sketch:** Replace the three `botActors.find(a => a.entity.id === …)` with a module-level
`Map<id, actor>` maintained by `spawnBots`/`removeAllBots`, and source the ally candidates from
the shared per-frame team-bucketed spatial hash.

---

## Finding: `withBotActor` copies ~35 fields four times per bot per frame (global-state binding tax)

**File:** `bot-viewer.html`
**Lines:** `bindBotActor` 2600-2639, `commitBotActor` 2641-2677, `withBotActor` 2679-2688;
driven from `updateAllBots` 933-936.

```js
function withBotActor(actor, fn) {
  const previous = activeBotActor;
  if (previous) commitBotActor(previous);
  bindBotActor(actor);
  try { return fn(); }
  finally {
    commitBotActor(actor);
    bindBotActor(previous);
```

**Loop nesting:** N bots → 2 × `commitBotActor` (≈31 property writes) + 2 × `bindBotActor`
(≈35 property writes with `??` fallbacks) = ~130 property writes per bot per frame, plus the
`bindBotActor(previous)` call which immediately gets undone by the next iteration's
`commitBotActor(previous)`.

**Why slow at high N:** this is the architectural price of simulating every bot through one set
of module-level globals. It is strictly linear, but it is ~13,000 property reads/writes per
frame at 100 bots for **zero simulation work** — and it forces `bindBotActor`'s
`?? new THREE.Vector3()` / `?? { yaw: 0, pitch: 0 }` / `?? []` fallbacks (2614-2623) to allocate
whenever the fallback branch is taken.

**Scaling:** O(bots) per frame, constant ≈130 property accesses.

**Severity at 100 bots: LOW** (measurable but an order of magnitude below findings 1-3).

**Fix sketch:** Drop the double bind — in `updateAllBots`, bind each actor once and commit once
(the `bindBotActor(previous)` in the `finally` is only needed for the re-entrant call sites like
`reviveCombatBot`/`spawnBots`, which could use an explicit save/restore variant).

---

## Checked and deliberately NOT reported (guarded or non-scaling)

- `updateBotMovementDebug` (301-364): called per bot per frame from 1209, but gated by
  `botMovementDebugEnabled` **and** a single global 66 ms throttle stamp, so at most one bot per
  frame does work. Not a scaling issue.
- `updateAllBotGoalDebug` (2031-2053) / `updateInvestigationDebug` (2102-2135): loop all actors
  but the `active` predicate includes `actor === diagnosticActor`, so exactly one actor does work;
  the loop body is an early `continue` for everyone else.
- `recordBotStateChange` / `recordBotEvent` / `recordBotDamage` (867-896): all early-return on
  `!botStateRecording`, and `flushBotStateRecord` (851-861) already appends incrementally rather
  than re-joining. Properly gated.
- `medicNavFlood` (3525-3532): the expensive whole-grid flood is throttled to 200 ms per medic.
- `livingTeammatesNear` (1695-1704): O(N) scan, but reached only behind `report &&
  esc.score >= ALERT_PUSH_SCORE` (3880) — rare.
- `detonateBlast` (4159-4191) and `invalidateTargetMemoryAfterDeath` (1358-1383): O(N) scans, but
  event-driven (one explosion / one death), not per frame.
- `buildNavGrid` / `buildVisibilityField` / `buildCornerMap` (2415-2423): one-time per layout.
