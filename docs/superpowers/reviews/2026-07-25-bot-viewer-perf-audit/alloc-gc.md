# Lens: per-frame allocation / GC churn — model: opus

Scope: `bot-viewer.html` main loop (`renderer.setAnimationLoop`, line 5081) and everything reachable
per bot per frame through `updateAllBots` → `withBotActor` → `updateBotSentry` / `updateBot`.
Only allocation whose volume grows with bot count `N` is reported. Findings are ordered worst-first.

Baseline for the estimates below: `N = 100` living bots, ~50 of them enemies of any given bot,
60 fps, default map (rooms layout, nav grid ≈ 56×56 = ~3.1k cells; the 30×30 maze preset at line
4531 pushes that to ~210×210 = ~44k cells).

---

## Finding: `selectBotTarget` rebuilds an O(N) candidate array and allocates 2 Vector3 + 2 arrays per candidate — every bot, every frame

- **File / lines**: `bot-viewer.html` 1866–1890 (called unconditionally from `updateBotSentry`, line 3759)
- **Excerpt**:
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
    if (mapCollider.raycast([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], distance - 0.02)) continue;
```
- **Why slow at high N**: the array build alone is 2 `filter` results + 1 `map` result + 2 spread
  copies = 5 intermediate arrays per bot per frame, two of them O(N) long. The scan body then
  allocates, per candidate: 1 `Vector3` from `eyePos` (a `clone().lerp()`), 1 `Vector3` from
  `.clone().sub()`, and 2 array literals for the raycast arguments.
- **Scaling**: `5 + 4·(N/2)` allocations per bot per frame → **O(N²)**. At N=100: ~205 objects/bot
  → **~20,500 allocations per frame**, ~1.2 M/s. This single function is very likely the largest
  young-generation producer in the harness.
- **Severity at 100 bots**: **high** (worst offender).
- **Fix sketch**: keep a persistent per-team `livingEnemies` array rebuilt once per frame in
  `updateAllBots` (not per bot), iterate it by index, and replace the two clones + two argument
  arrays with module-level scratch `Vector3`s and a scratch `[x,y,z]` triple reused across calls.

---

## Finding: `mapCollider.raycast` allocates a fresh intersection array + hit objects on every LOS test, and LOS tests are O(N²) per frame

- **File / lines**: `map-collision.js` 127–136; hot callers `bot-viewer.html` 1885 (`selectBotTarget`),
  3775 (`updateBotSentry` LOS), 1603 (`botCanSeePack`)
- **Excerpt** (`map-collision.js`):
```js
  function raycast(origin, dir, maxDistance = 200) {
    ...
    const hit = _raycaster.intersectObject(colliderMesh, false)[0];
    if (!hit) return null;
    const n = hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 1, 0];
    return { distance: hit.distance, point: [hit.point.x, hit.point.y, hit.point.z], normal: n };
  }
```
- **Why slow at high N**: `Raycaster.intersectObject` always returns a **newly allocated array**,
  and three-mesh-bvh's `acceleratedRaycast` pushes intersection records that each carry a fresh
  `Vector3` point (plus face/uv data). The wrapper then allocates a result object plus two more
  arrays. Nothing is pooled, and the discarded tail of `intersects` (all hits beyond the first)
  is pure garbage.
- **Scaling**: ~6–8 allocations per ray. `selectBotTarget` alone issues ~N/2 rays per bot per frame
  → ~5,000 rays/frame at N=100 → **~35,000 allocations per frame** from raycasting alone, on top of
  the BVH traversal cost. Note `USE_FIELD_LOS_PREFILTER` (line 1965) is **`false`**, so the baked
  visibility field is not currently suppressing any of these rays.
- **Severity at 100 bots**: **high**.
- **Fix sketch**: add a `raycastFirstHit(ox,oy,oz,dx,dy,dz)` that uses `boundsTree.raycastFirst`
  into a reusable hit record (or just returns the distance as a number), and give the caller a
  boolean `isOccluded(...)` variant that allocates nothing when only occlusion matters.

---

## Finding: `followPath` materialises the entire actor list into a new array on every call, inside a loop

- **File / lines**: `bot-viewer.html` 2692–2740, specifically 2698 and 2723–2728
- **Excerpt**:
```js
  while (path.length > 0) {
    const target = path[0];
    const p = botXZ(entity);
    ...
    const others = botActors.map((a) => a.entity);
```
```js
    const sep = separationXZ(entity, others, SEPARATION_RADIUS);
    if (sep) {
      const m = blendSeparationDir(mx, mz, sep, SEPARATION_WEIGHT,
        (bx, bz) => navBlockedAhead(p, bx, bz));
```
- **Why slow at high N**: `followPath` runs for every moving bot every frame (patrol, pursue, seek,
  flee, cover-move, pack-seek, medic-move all funnel into it). Line 2698 is **inside the `while`
  loop**, so a frame that pops 2–3 reached waypoints rebuilds the O(N) array 2–3 times. Each call
  also allocates: `botXZ` object (2695), the `map` closure, the `{x,z}` returned by `separationXZ`,
  the `{x,z}` returned by `blendSeparationDir`, the `(bx,bz)=>` closure (2727), a `worldToCell`
  object (2709), and a `{x,z}` heading literal (2735).
- **Scaling**: **O(N²)** for the array (100 arrays × 100 elements per frame at N=100), plus ~6 small
  objects per moving bot per frame (~600/frame). The array copy alone is ~10,000 element writes/frame.
- **Severity at 100 bots**: **high**.
- **Fix sketch**: hoist the entity list to a frame-scoped module array built once in `updateAllBots`
  and pass it into `followPath`; hoist the `blockedAhead` closure to a module-level function that
  reads a scratch `_probeP`, and return separation results into scratch objects.

---

## Finding: `requestPath` → `findPath` / `floodFill` allocate three full-grid typed arrays per path request

- **File / lines**: `nav-grid.js` 127–129 and 171–172; called via `bot-viewer.html` 2747–2756
  (`requestPath`), hit from `updatePursuitMovement` 3258, `updateCoverMoveMovement` 3450,
  `updatePackSeekMovement` 3350, `updateMedicMoveMovement` 3651, `updatePatrolMovement` 2991,
  and the recovery re-path at 2717
- **Excerpt** (`nav-grid.js`):
```js
  const n = cols * grid.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
```
- **Why slow at high N**: 13 bytes × cell count of *fresh* typed-array garbage per path request,
  regardless of how short the path is — ~41 KB on the default rooms grid, **~573 KB on the 30×30
  maze preset**. These are large enough to skip the nursery on some allocators and to force real
  memset work (`.fill()` touches every byte). `updatePursuitMovement` re-paths whenever the goal
  moves 0.65 m (`goalChanged`, line 3250) — a target running at 2.4 m/s trips that ~3.7×/s, per
  pursuing bot.
- **Scaling**: linear in bots × replan rate. At N=100 with half the bots pursuing, ~185 requests/s
  → **~7.5 MB/s of typed-array garbage** on the default map, ~100 MB/s on the maze preset. Not
  per-frame, so it shows up as periodic GC pauses / frame spikes rather than uniform slowdown.
- **Severity at 100 bots**: **high** (spiky).
- **Fix sketch**: allocate the three scratch buffers once per nav-grid bake and reuse them with a
  monotonically increasing "visit stamp" (`Int32Array` generation counter) instead of `.fill()`,
  since pathfinding is single-threaded and never re-entrant.

---

## Finding: `updateBotSentry` allocates ~10 short-lived objects per bot per frame, unconditionally

- **File / lines**: `bot-viewer.html` 3782, 3786, 3788, 3816, 3823, 3876, 3902, 3909, 3953–3966
- **Excerpt**:
```js
  const esc = alertEscalation(recentAllyHits, { ...botXZ(bot), team: bot.team }, now, ESCALATION_RADIUS);
```
```js
  let { state } = chooseBotState({
    current: botState,
    ctx: { targetVisible: visible, aimError: err, readyToFire, hasLastKnown: !!lastKnownTarget,
      targetDistance, pursueDistance: botCombatStandoff,
      ...
      fireCapable: !attackerOutOfAmmo, knifeCapable: botKnifeSecondaryEnabled },
  });
```
- **Why slow at high N**: `updateBotSentry` is the per-bot FSM tick. Per bot per frame it builds:
  the `chooseBotState` wrapper object + its 21-property `ctx` object (3953–3966), the spread
  `{ ...botXZ(bot), team }` (3876 — two objects: the `botXZ` literal plus the spread copy), the
  `{deaths, hits, score}` returned by `alertEscalation` (`bot-alert.js` 76), the `{ready, unsafe}`
  from `updateHealSafety` (3490/3495/3501), plus `botXZ` literals at 3782, 3902, 3909 and the
  `{yaw,pitch}` from `aimAnglesTo` (3788) and `{x,z}` motion/goal literals at 3786/3816. The
  21-property `ctx` object in particular is the kind of shape V8 will heap-allocate every time.
- **Scaling**: ~10–12 objects per bot per frame → **~1,100 objects/frame** at N=100, ~66 k/s.
- **Severity at 100 bots**: **medium-high** — individually cheap, but this is the steadiest,
  most unavoidable churn in the loop.
- **Fix sketch**: make `botXZ` write into a caller-supplied scratch `{x,z}` (or return `x`/`z` via
  two out-params), and hoist a single module-level `_stateCtx` object that `updateBotSentry`
  overwrites field-by-field before passing to `chooseBotState`; same for the escalation query arg.

---

## Finding: `sharedAllyAlertNear` allocates one `{x,z}` per teammate, per bot, per frame

- **File / lines**: `bot-viewer.html` 1682–1693 (called from 3875); sibling `livingTeammatesNear`
  1695–1704 (called from 3880); `botXZ` itself at 2140–2142
- **Excerpt**:
```js
function sharedAllyAlertNear(me, now) {
  const p = botXZ(me);
  let best = null;
  for (const other of botActors) {
    ...
    const q = botXZ(other.entity);
    if (Math.hypot(q.x - p.x, q.z - p.z) > SEMI_ALERT_SHARE_RADIUS) continue;
```
- **Why slow at high N**: `botXZ` returns a fresh object literal. `sharedAllyAlertNear` runs
  whenever `latestAllyHitNear` returned nothing — i.e. the *common* case for most bots most of
  the time — and walks all `botActors`, allocating one object per teammate examined.
- **Scaling**: **O(N²)** object literals — at N=100 with ~50 same-team actors, ~50 objects/bot →
  **~5,000 allocations/frame** (~300 k/s). `livingTeammatesNear` adds the same pattern but is
  guarded behind `esc.score >= ALERT_PUSH_SCORE`, so it only fires during heavy firefights —
  downgraded accordingly.
- **Severity at 100 bots**: **medium-high**.
- **Fix sketch**: read `other.entity.capsule.start.x/.z` directly in these two loops (no helper
  call at all) — `botXZ` is pure sugar over two field reads.

---

## Finding: `eyePos` clones a Vector3 on every call, and it is called 2–8× per bot per frame

- **File / lines**: `bot-viewer.html` 2137–2139; call sites 3763, 3764, 4008, 4016, 4028, 4035,
  4040, 4045, 4060, 1594, 1718, 1877, 2973–2974
- **Excerpt**:
```js
function eyePos(entity) {
  return entity.capsule.start.clone().lerp(entity.capsule.end, EYE_LIFT);
}
```
- **Why slow at high N**: `.clone()` allocates; `.lerp()` then mutates in place, so exactly one
  `Vector3` is leaked per call. `updateBotSentry` calls it twice at the top (3763–3764) for every
  bot with a target, and each firing branch calls it again (`fireBotShot(eyePos(bot), now)` appears
  in six branches). `selectBotTarget` calls it once per candidate (already counted above).
- **Scaling**: ~3 `Vector3`/bot/frame outside `selectBotTarget` → **~300/frame** at N=100, on top of
  the ~5,000/frame from the target scan.
- **Severity at 100 bots**: **medium-high** (mostly because of the `selectBotTarget` multiplier).
- **Fix sketch**: `eyePos(entity, out = _eyeScratch)` writing into a caller-provided target; the two
  simultaneous uses in `updateBotSentry` need two distinct scratch vectors (`_eyeA` / `_eyeB`).

---

## Finding: `updateBotWeaponMount` builds two Quaternions, two Eulers, a spread, an options literal and a debug object per bot per frame

- **File / lines**: `bot-viewer.html` 659–660, 673, 677; `weapon-pose-controller.js` 393–403
- **Excerpt**:
```js
  const rootRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, bodyYaw, 0, 'YXZ'));
  const holdRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...hold.rotation));
```
```js
  const lockAimedPosition = isAiming && controller.getDebug().action !== 'reload';
  ...
  controller.update(dt, lockAimedPosition ? { lockPosePosition: 'lowReady' } : {});
```
- **Why slow at high N**: called for every bot with a mounted weapon, every frame (via `updateBot`
  line 1205). Allocates 2 `Quaternion` + 2 `Euler` + the `...hold.rotation` spread's argument list
  + an options object literal + the 6-property object `getDebug()` returns — the latter purely to
  read `.action`. `alignMountedWeaponToPoint` (4119) then adds a `Vector3` + `Quaternion`, and
  `botMountedBarrelRay` (4106) adds 3 `Vector3` + a result object, for every aiming bot.
- **Scaling**: ~6 objects/bot/frame here, ~12 for bots that are actively aiming →
  **~600–1,200 allocations/frame** at N=100.
- **Severity at 100 bots**: **medium-high**.
- **Fix sketch**: hoist `_rootQ`/`_holdQ`/`_euler` scratch instances and the two frozen options
  literals (`LOCK_LOWREADY` / `EMPTY_OPTS`) to module scope; add `controller.getAction()` returning
  the string so `getDebug()` isn't called in the hot path.

---

## Finding: `updateBot` allocates the mid-point vector, a facing vector, and a 12-field params object per bot per frame

- **File / lines**: `bot-viewer.html` 1161–1217 (specifically 1163, 1164, 1171–1188, 1208)
- **Excerpt**:
```js
  stepBotPhysics(bot, dt, { mapCollider });
  const mid = bot.capsule.start.clone().add(bot.capsule.end).multiplyScalar(0.5);
```
```js
  facingMesh.position.copy(mid).addScaledVector(new THREE.Vector3(Math.sin(bot.yaw), 0, Math.cos(bot.yaw)), bot.capsule.radius + 0.2);
```
- **Why slow at high N**: `updateBot` runs for every living bot every frame. Line 1164 allocates a
  `Vector3`; line 1208 allocates another `Vector3` **inline in an expression** purely to build a
  unit heading; line 1163 allocates the `{ mapCollider }` options object (which `stepBotPhysics`
  then destructures, and `map-collision.js` 107–114 answers with 1–3 more `{hit, grounded}` /
  `{grounded}` objects); lines 1171–1188 build a 12-property literal for `body.update`.
- **Scaling**: ~6–8 objects per bot per frame → **~700/frame** at N=100. The post-pushout
  `mapCollider.resolveCapsule(entity.capsule, entity.velocity, {})` at line 941 adds one more
  empty literal + result objects per moved bot.
- **Severity at 100 bots**: **medium**.
- **Fix sketch**: module-level `_mid` / `_facingDir` scratch vectors and a single reused
  `_bodyParams` object whose fields are overwritten each call; give `stepBotPhysics` a hoisted
  frozen options object and have `resolveCapsule` return a boolean instead of `{grounded}`.

---

## Finding: `findFleeGoal` builds a candidate object per grid cell in the search square, plus two full-grid typed arrays

- **File / lines**: `bot-viewer.html` 3292–3339 (esp. 3299 and 3306–3320); `nav-grid.js` 171–172
- **Excerpt**:
```js
  const flood = floodFill(navGrid, source, { maxRadius: maxSearchRadius });
  ...
  const candidates = [];
  for (let dr = -maxSearchRadius; dr <= maxSearchRadius; dr++) {
    for (let dc = -maxSearchRadius; dc <= maxSearchRadius; dc++) {
      ...
      const goal = cellToWorld(navGrid, c, r);
      ...
      candidates.push({ ...goal, c, r, score, covered });
```
- **Why slow at high N**: each invocation allocates `floodFill`'s `Float64Array(n)` + `Int32Array(n)`
  (full grid, ~37 KB on the rooms map), then up to `(2R+1)²` candidate objects — 121 at
  `fleeSearchRadius: 5`, **441** at the wounded-retreat radius of 10 — each built with a spread
  (`{...goal}` = 2 objects per candidate counting `cellToWorld`'s literal), plus `smoothPath`'s
  `.slice(1)` at 3337.
- **Why it is not worse**: genuinely throttled — it only runs when the bot has no committed flee
  path (`pathMode !== 'flee' || currentPath.length === 0`, line 3369), so a bot re-plans once per
  retreat leg, not per frame.
- **Scaling**: ~250–900 objects + ~37 KB typed arrays per flee re-plan; linear in the number of
  bots simultaneously entering FLEE. In a 100-bot firefight where a third are kiting, that is a
  few thousand objects and ~1 MB of typed arrays per second.
- **Severity at 100 bots**: **medium** (bursty, correlates with the exact moment the fight is
  busiest — i.e. it lands on already-bad frames).
- **Fix sketch**: score cells into parallel preallocated arrays (or track only the running best
  `{c, r, score}` in scalars) instead of materialising a candidate list, and reuse the flood
  buffers as described in the `findPath` finding.

---

## Finding: `recordNearMisses` clones a Vector3 and runs a `.find()` closure for every bot, on every shot fired

- **File / lines**: `bot-viewer.html` 1659–1673 (called from `fireBotShot`, line 4218)
- **Excerpt**:
```js
  for (const actor of botActors) {
    const e = actor.entity;
    if (e === attacker || e.alive === false || e.team === attacker.team || e.id === hitId) continue;
    const c = e.capsule.start.clone().add(e.capsule.end).multiplyScalar(0.5);
    if (shotMissDistance(origin, dir, travelled, c) > NEAR_MISS_RADIUS) continue;
    const v = botXZ(e);
    const prior = recentAllyHits.find(r => r.kind === NEAR_MISS_KIND && r.victimId === e.id && now - r.at <= NEAR_MISS_WINDOW_MS);
```
- **Why slow at high N**: allocates one `Vector3` per enemy bot examined **per shot**, before any
  distance rejection. Shot volume itself scales with bot count: at N=100 with ~50 bots firing a
  ~100 ms-interval rifle, that is ~500 shots/s ≈ 8 shots per frame. The `.find` closure is
  allocated per surviving candidate too. `fireBotShot` adds per-shot: the `resolveHitscan` config
  object with 3 closures + 2 argument arrays (4207–4215), `combatCapsuleFor`'s object + array
  (826–830), `hitPoint` (4219), `measureMountedShotAlignment`'s 5 vectors + result object
  (4090–4104), and the `lastShotSummary` template string (4235).
- **Scaling**: `~N/2` Vector3 per shot × ~8 shots/frame → **~400 Vector3/frame** at N=100 from
  `recordNearMisses` alone, plus ~15 objects × 8 shots from the rest of `fireBotShot`.
- **Severity at 100 bots**: **medium**.
- **Fix sketch**: reuse a module `_nearMissMid` vector (the value is consumed immediately), replace
  the `.find` with an indexed `for` loop, and hoist the `resolveHitscan` config + its `heightAt` /
  `normalAt` / `occluder` closures to module constants.

---

## Finding: `updateAllBots` allocates two O(N) arrays and an N-entry Set every frame for the pushout pass

- **File / lines**: `bot-viewer.html` 939–943; `bot-separation.js` 13–33
- **Excerpt**:
```js
  const living = botActors.filter((a) => a.entity.alive !== false && !a.ragdoll).map((a) => a.entity);
  for (const entity of resolveBotPairs(living)) {
    if (mapCollider) mapCollider.resolveCapsule(entity.capsule, entity.velocity, {});
  }
  bindBotActor(botActors.includes(focus) ? focus : (botActors[0] ?? null));
```
- **Why slow at high N**: `filter` + `map` = two O(N) arrays plus two closures per frame;
  `resolveBotPairs` then allocates a `Set` that grows to ~N entries in a crowded frame (every
  colliding bot is added), and the loop body allocates an empty options literal per moved bot
  plus `resolveCapsule`'s 1–3 result objects.
- **Scaling**: 3 O(N) containers per frame (not per bot), so **O(N)** not O(N²) — ~200 array slots
  + up to 100 Set entries + ~300 result objects per frame at N=100.
- **Severity at 100 bots**: **medium-low** — real but an order of magnitude below the O(N²) items;
  worth fixing at the same time as the `followPath` entity list since they want the same cached array.
- **Fix sketch**: maintain one persistent `_livingEntities` array (cleared and refilled in place,
  shared with `followPath`) and have `resolveBotPairs` accept a reusable `Set`/flag array to mark
  moved bots rather than allocating one.

---

## Finding: `updateBotWeaponButtons` does six template-string builds + six DOM writes on every reload event, and reload events scale with bot count

- **File / lines**: `bot-viewer.html` 4633–4645; called synchronously from `updateBotReload`
  (455) and `reloadBotWeapon` (439), which run per bot per frame via `updateBotSentry` 3761/4081
- **Excerpt**:
```js
  reloadBtn.textContent = `${botReloadUntil != null ? 'Reloading' : 'Reload'} ${weapon.displayName} (${ammo.mag}/${reserve})`;
```
- **Why slow at high N**: the panel only ever shows the *focused* bot's ammo, but every bot's
  reload start and reload completion triggers a full rebuild of six button labels. Each call
  allocates six strings and performs six `textContent` assignments, which invalidate layout.
  `fireBotShot` deliberately defers its equivalent work through the `botShotUiDirty` flag
  (4236 → `flushShotUi` 4240) — the reload path bypasses that same mechanism.
- **Scaling**: ~2 calls per bot per magazine. At N=100 sustaining fire with a ~30-round magazine
  at ~10 rps, that is **~65 calls/s → ~400 string allocations and ~400 DOM writes per second**,
  growing linearly with bot count. Not per-frame, but concentrated into the frames where reloads
  cluster after a volley.
- **Severity at 100 bots**: **medium**.
- **Fix sketch**: replace both direct calls with `botShotUiDirty = true` so the existing once-per-frame
  `flushShotUi` coalesces them, and early-out of `updateBotWeaponButtons` when the reloading actor
  is not `activeBotActor`.

---

## Checked and deliberately NOT reported

Recorded so the next reader does not re-investigate them:

- **`recordBotStateChange` / `recordBotEvent` string building** (867–885) — guarded by
  `botStateRecording`, which is off by default; the template strings never run unless the user
  starts a recording. Real cost when enabled, but not a default-path scaling issue.
- **`updateBotMovementDebug`** (301–364) — heavy `new THREE.Vector3` / `BufferGeometry` churn, but
  gated by `botMovementDebugEnabled` (off) *and* a 66 ms throttle on a single shared timestamp.
  Only residue when disabled is `clearBotMovementDebug`'s `[...botMovementDebug.children]` spread
  (267) on an empty array — one empty array per bot per frame, negligible.
- **`updateAllBotGoalDebug` (2031) / `updateInvestigationDebug` (2102) / `updateBotRecoveryDebug`
  (2946)** — loop all actors but allocate only for the single `botDebugFocusActor`, and are behind
  `botBehaviorDebugEnabled` / `botRecoveryIssueActive`. O(N) iteration, O(1) allocation.
- **`decideMedicDuty`** (3559–3616) — does allocate two arrays plus a `botXZ` object and a candidate
  literal per same-team actor scanned, i.e. O(N) per medic per frame. Only reaches medics
  (`botMedicPercent` of the roster) and its `floodFill` is throttled to 200 ms (3524–3532), so it
  is roughly a scaled-down copy of the `sharedAllyAlertNear` finding — fix it with the same
  `botXZ` change.
- **`body-part-batches.js` / `weapon-part-batches.js` flush path** (`bot-viewer.html` 5094–5104,
  `flushWeaponMount` 196–204) — genuinely allocation-free: shared `_weaponPartMatrix` scratch,
  bucket counts reset in place, no per-instance objects. Good pattern; the rest of the loop should
  copy it.
- **`losLine` position-attribute write per bot per frame** (3766–3769) — sets `needsUpdate` N times
  but the actual GPU upload happens once at draw; N flag writes, no allocation. Not a scaling issue.
- **`updateDummyControls` / the HUD block at 5117–5131** — template strings and `p.map(...).join()`
  every frame, but constant cost regardless of bot count. Out of scope for this lens.
- **`bindBotActor` / `commitBotActor`** (2600–2677) — ~120 global property writes per bot per frame
  via `withBotActor`'s commit/bind/commit/bind sequence, plus a fresh closure per bot at line 933.
  Real per-bot overhead but almost entirely allocation-free (the `?? {…}` / `?? new Set()` fallbacks
  at 2614–2623 only allocate when binding `null`, which does not happen on the normal path).
