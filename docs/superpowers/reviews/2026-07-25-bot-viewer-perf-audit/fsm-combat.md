# Lens: FSM / combat logic — model: sonnet

## Finding: `selectBotTarget` raycasts every enemy candidate, every bot, every frame, with no range cutoff

**File**: `bot-viewer.html`, lines 1866-1890 (definition), called unconditionally at line 3759 inside `updateBotSentry`, which itself runs for every living bot every frame (`bot-viewer.html:934`, inside `updateAllBots`'s `for (const actor of botActors)` at line 924).

```js
function selectBotTarget() {
  const live = [
    ...dummyTargets.filter((target) => target.alive),
    ...botActors.filter((actor) => actor.entity !== bot && actor.entity.alive !== false && actor.entity.team !== bot?.team).map((actor) => actor.entity),
  ];
  if (!live.length) { botTarget = null; return; }
  if (!bot || bot.alive === false) { botTarget = botTarget?.alive ? botTarget : live[0]; return; }
  const origin = eyePos(bot);
  let best = null;
  let bestDistanceSq = Infinity;
  for (const target of live) {
    const targetEye = eyePos(target);
    const direction = targetEye.clone().sub(origin);
    const distance = direction.length();
    if (distance < 1e-4) continue;
    direction.multiplyScalar(1 / distance);
    if (!withinBotFov(bot.yaw, origin, targetEye)) continue;
    if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(origin.x, origin.z, targetEye.x, targetEye.z)) continue;
    if (mapCollider.raycast([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], distance - 0.02)) continue;
    if (distance * distance < bestDistanceSq) { best = target; bestDistanceSq = distance * distance; }
  }
  botTarget = best || (botTarget?.alive ? botTarget : live[0]);
}
```

Why it's slow at high N: every living bot rebuilds a filtered/mapped list of every living enemy (`botActors.filter().map()`, an `O(N)` allocation) and then, for every candidate still inside the 2D FOV cone, fires a full BVH `mapCollider.raycast(...)` against the level geometry. There is **no sight-range cutoff** in this loop — unlike the visibility check the same function's caller does later at `bot-viewer.html:3773` (`if (dist <= botBehaviorSettings.sightDistance ...)`), `selectBotTarget` will raycast against an enemy on the opposite side of the map as long as it's inside the FOV cone. The one built-in mitigation, a cheap baked-field LOS prefilter that could skip the raycast entirely, is compiled out by default: `const USE_FIELD_LOS_PREFILTER = false;` at line 1965 ("ships off pending browser QA"), so the expensive raycast branch is always live. `eyePos()` (line 2137) also allocates a fresh `Vector3` via `.clone()` per candidate, adding `O(N)` GC churn on top.

How cost scales: for a team split of N/2 vs N/2, each bot's `live` list is ~N/2 long, and this runs for every one of the N bots every frame with no throttle → `O(N^2)` raycasts per frame (plus `O(N^2)` small allocations for `eyePos`/`direction`).

Estimated severity at 100 bots: **high**. 50v50 gives ~2,500 BVH raycasts per frame from target acquisition alone, run every single frame, before any other system's raycasts (LOS confirmation, muzzle recovery, shot resolution) are counted.

Fix sketch: gate the loop by `botBehaviorSettings.sightDistance` before doing FOV/raycast work, turn on (or fix and default-enable) `USE_FIELD_LOS_PREFILTER` so most candidates are rejected by a cheap field lookup instead of a raycast, and/or throttle re-acquisition to a few Hz per bot (staggered) instead of every frame while keeping last-frame's target in between.

## Finding: `followPath` rebuilds the full bot list and re-runs O(N) contest/separation checks on every call, from every movement FSM state

**File**: `bot-viewer.html`, lines 2692-2740 (`followPath`), specifically:

```js
function followPath(entity, path, speed) {
  while (path.length > 0) {
    const target = path[0];
    const p = botXZ(entity);
    const dx = target.x - p.x, dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    const others = botActors.map((a) => a.entity);
    ...
    const reach = relaxedPopOk && waypointContested(entity, others, target, dist, WAYPOINT_CONTEST_RANGE)
      ? WAYPOINT_REACH + WAYPOINT_CONTEST_RELAX : WAYPOINT_REACH;
    if (dist < reach) { path.shift(); continue; }
    ...
    const sep = separationXZ(entity, others, SEPARATION_RADIUS);
```

Why it's slow at high N: `botActors.map((a) => a.entity)` allocates a brand-new `O(N)`-length array on *every call*, and it is rebuilt again on every iteration of the enclosing `while` loop if multiple waypoints are consumed in the same call (each `continue` after `path.shift()` re-executes the map). `waypointContested` and `separationXZ` (imported from `bot-separation.js` via `bot-entity.js:63`) each linearly scan that `others` array. `followPath` is the common movement executor called from essentially every FSM movement state, every frame that state is active: patrol (`bot-viewer.html:3013`), seek (`:3232`), pursue-adjacent knife-close (`:3262`), heal-flee (`:3282`, `:3384`), cover-move (`:3454`), muzzle-recovery (`:2906`), medic-move (`:3653`), revive-move (`:3708`).

How cost scales: any bot currently moving toward a goal pays `O(N)` per frame for the array rebuild plus two more `O(N)` scans; with most of the population in a moving state during active combat (patrol/seek/pursue/flee/cover-move/medic-move), this is effectively `O(N)` work per moving bot per frame → `O(N^2)` total per frame.

Estimated severity at 100 bots: **high** — this runs far more often than target acquisition (every frame for every moving bot, not just sentries), and the redundant array rebuild inside the `while` loop means a single call can pay the `O(N)` cost 2-3x when several waypoints collapse in one tick (e.g. after a re-path).

Fix sketch: hoist `botActors.map((a) => a.entity)` out of `followPath` into `updateAllBots` once per frame and pass the shared array/list in, instead of reallocating it per bot per call; consider a spatial grid for `waypointContested`/`separationXZ` so neighbor queries aren't a full scan of every bot on the map.

## Finding: `recordNearMisses` loops over every bot on every single shot fired

**File**: `bot-viewer.html`, lines 1659-1673, invoked from `fireBotShot` at line 4218:

```js
function recordNearMisses(origin, dir, travelled, hitId, attacker, now) {
  if (!attacker?.alive) return;
  const a = botXZ(attacker);
  for (const actor of botActors) {
    const e = actor.entity;
    if (e === attacker || e.alive === false || e.team === attacker.team || e.id === hitId) continue;
    const c = e.capsule.start.clone().add(e.capsule.end).multiplyScalar(0.5);
    if (shotMissDistance(origin, dir, travelled, c) > NEAR_MISS_RADIUS) continue;
    const v = botXZ(e);
    const prior = recentAllyHits.find(r => r.kind === NEAR_MISS_KIND && r.victimId === e.id && now - r.at <= NEAR_MISS_WINDOW_MS);
    if (prior) { prior.at = now; prior.x = v.x; prior.z = v.z; prior.threat.x = a.x; prior.threat.z = a.z; continue; }
    pushAllyReport({ victimId: e.id, team: e.team, x: v.x, z: v.z, threat: { x: a.x, z: a.z }, at: now, lethal: false, kind: NEAR_MISS_KIND });
  }
}
```

Why it's slow at high N: this is exactly the "hit-test loop over all bots per bullet" pattern — every shot (from `fireBotShot`, `bot-viewer.html:4192`) walks the entire `botActors` list to test whether the bullet's flight path passed close enough to count as a near-miss, allocating a fresh midpoint `Vector3` per bot (`e.capsule.start.clone().add(...)`) plus an inner `recentAllyHits.find(...)` scan (bounded at 64, so that inner part is cheap). There is no spatial prefilter — every bot in the sim is distance-tested against every bullet regardless of how far away it is.

How cost scales: cost is `O(N)` per shot. Shot volume itself scales with the number of armed, engaged bots (`O(N)` shooters, each firing on its own cooldown), so total per-frame cost trends toward `O(N^2)` as the fight gets dense (many bots simultaneously in `BOT_FIRE`/knife-adjacent states with short `fireIntervalMs` weapons).

Estimated severity at 100 bots: **high** during dense firefights (e.g. full-auto weapons at low fire-interval with dozens of bots in `BOT_FIRE` concurrently), **medium** in sparser fights.

Fix sketch: reuse a spatial index (even the same grid used for `waypointContested`/`separationXZ`) to only test bots near the shot's line segment, or cap/throttle near-miss evaluation to allies within `ALLY_ALERT_RADIUS`/`SEMI_ALERT_SHARE_RADIUS` of the shooter instead of scanning the whole roster.

## Finding: `combatEntityById` does a linear scan of all bots on every hit-confirmed shot

**File**: `bot-viewer.html`, lines 832-835, called from `fireBotShot` at line 4228:

```js
function combatEntityById(id) {
  const dummyTarget = dummyTargets.find((target) => target.id === id);
  return dummyTarget || botActors.find((actor) => actor.entity.id === id)?.entity || null;
}
```

Why it's slow at high N: bots are kept in a flat array (`botActors`) with no id→actor map, so resolving "who did I just hit" is an `O(N)` `Array.prototype.find` by string-id comparison. It runs once per confirmed hitscan hit (`hit.kind === 'player'`), i.e. once per successful shot, stacking on top of `recordNearMisses`'s per-shot `O(N)` cost above.

How cost scales: `O(N)` per hit-confirmed shot; total scales with hit volume, which grows with bot count in the same way shot volume does.

Estimated severity at 100 bots: **low-medium** on its own (a plain array `.find` over ~100 entries is cheap in isolation), but it compounds the same per-shot hot path as `recordNearMisses` and is essentially free to fix.

Fix sketch: maintain a `Map<id, actor>` alongside `botActors` (already implied by `bot.id`/`actor.id` conventions used throughout) and do an `O(1)` lookup instead of two linear scans.

## Finding: `decideMedicDuty` rescans the entire bot roster every frame per living medic, plus nested O(N) `.find()` calls

**File**: `bot-viewer.html`, lines 3559-3616, called every frame per medic actor from `updateBotSentry` at lines 3970-3972:

```js
} else if (activeBotActor.role === ROLE_MEDIC) {
```
```js
  if (activeBotActor.role === ROLE_MEDIC && !botHealRequested && state !== BOT_FLEE && state !== BOT_KNIFE) {
    const duty = decideMedicDuty(now);
    if (duty) state = duty.state;
```

and inside `decideMedicDuty`:

```js
function decideMedicDuty(now) {
  const actor = activeBotActor;
  const selfXZ = botXZ(bot);
  const allies = [];
  const corpses = [];
  ...
  for (const other of botActors) {
    if (other === actor || other.entity.team !== bot.team) continue;
    ...
  }
  ...
  if (action) {
    const targetActor = botActors.find((a) => a.entity.id === action.targetId);
```

and the sibling helper `stickyHealTend` (line 3620-3629) also does `botActors.find(...)` at line 3622.

Why it's slow at high N: every medic, every frame, scans the *entire* `botActors` array (not just nearby ones — the radius prefilter is applied per-candidate inside the loop, but the loop itself still visits every bot in the sim) to build `allies`/`corpses` candidate lists, then does up to two more `O(N)` `Array.find` calls to resolve the chosen target actor and (via `stickyHealTend`) the sticky-tend target. This is unthrottled — it runs every FSM tick for every living medic.

How cost scales: `O(N)` per medic per frame. Since medic count is typically a fixed percentage of the roster (`botMedicPercent`, see `botAutoAddMedicAccum` wiring around line 964), medic count `M` scales linearly with `N`, so total cost is `O(M*N) = O(N^2)` as the bot count grows.

Estimated severity at 100 bots: **medium** — smaller constant than target-selection/near-miss (medics are usually a minority of the roster and the response-radius filter keeps the candidate lists themselves short), but it's an uncapped full-roster scan running every frame per medic with no distance/spatial prefilter before the loop even starts.

Fix sketch: prefilter medics' candidate scan with the same spatial partitioning suggested above, or throttle `decideMedicDuty` to a few Hz per medic (duty targets don't need frame-perfect re-evaluation); replace the `botActors.find(...)` lookups with an id→actor `Map`.

## Finding: `sharedAllyAlertNear` / `livingTeammatesNear` scan the full bot roster every frame per bot when the alert system is active

**File**: `bot-viewer.html`, lines 1682-1704, called from `updateBotSentry` at lines 3875 and 3880:

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
    if (!best || rep.at > best.at) best = rep;
  }
  return best;
}
function livingTeammatesNear(me, radius) {
  const p = botXZ(me);
  let n = 0;
  for (const other of botActors) {
    if (other.entity.alive === false || other.entity.team !== me.team) continue;
    const q = botXZ(other.entity);
    if (Math.hypot(q.x - p.x, q.z - p.z) <= radius) n++;
  }
  return n;
}
```

with call sites:

```js
  const report = firsthand || sharedAllyAlertNear(bot, now);
  const esc = alertEscalation(recentAllyHits, { ...botXZ(bot), team: bot.team }, now, ESCALATION_RADIUS);
  let alertTier = null;
  if (report) {
    activeBotActor.alertWarySince ??= now;
    if (esc.score >= ALERT_PUSH_SCORE && livingTeammatesNear(bot, SUPPORT_RADIUS) >= SUPPORT_GROUP_MIN) {
```

Why it's slow at high N: both helpers do a full `O(N)` linear pass over `botActors` (unlike the sibling `latestAllyHitNear`/`alertEscalation`, which scan the *capped* 64-entry `recentAllyHits` ring buffer and are effectively `O(1)`). `sharedAllyAlertNear` runs whenever a bot has no firsthand report of its own (`firsthand` falsy — the common case for most of the map most of the time); `livingTeammatesNear` runs whenever escalation score crosses `ALERT_PUSH_SCORE`, which becomes common precisely during the large, dense firefights this audit is targeting.

How cost scales: `O(N)` per bot per frame while alert conditions are active → `O(N^2)` per frame roster-wide during sustained combat, which is exactly the scenario with the most simultaneous ally-hit reports feeding the alert system.

Estimated severity at 100 bots: **medium** — smaller per-call cost than the raycast-heavy findings above (just distance math, no raycasts/allocs beyond `botXZ`'s small object literal), but it fires broadly across the roster during active fights, which is the target scenario.

Fix sketch: same spatial-partitioning fix as the other findings, or cache `alertReport`/team-position lookups in a small per-team spatial bucket rebuilt once per frame instead of rescanning `botActors` from every bot.
