# Lens: social modules (alert / medic / roles / health-packs / squad) — model: sonnet

Scope: `bot-alert.js`, `bot-medic.js`, `bot-roles.js`, `bot-health-packs.js`, `squad-activity.js`, read in full, plus every call site of their exports inside `bot-viewer.html`. Only findings whose cost scales with bot count (N) or with call frequency are listed; one-time init and style issues are excluded.

Key structural fact that shapes every finding below: `bot-viewer.html`'s `updateAllBots(dt, now)` (line 920) loops `for (const actor of botActors)` once per frame and calls `updateBotSentry(dt, now)` (line 934) for every living bot. Any O(N) work done *inside* that per-bot call is O(N²) per frame across the whole population. `squad-activity.js` is not imported anywhere in `bot-viewer.html` (confirmed by grep — zero matches for its exports), so it currently contributes no runtime cost at all; it is dead code from a perf standpoint until wired in.

## Finding: `recordNearMisses` rescans every bot on every single shot fired

- **File**: `bot-viewer.html`, lines 1659-1673 (function), called from line 4218.
- **Excerpt**:
```js
function recordNearMisses(origin, dir, travelled, hitId, attacker, now) {
  if (!attacker?.alive) return;
  const a = botXZ(attacker);
  for (const actor of botActors) {
    const e = actor.entity;
    if (e === attacker || e.alive === false || e.team === attacker.team || e.id === hitId) continue;
    const c = e.capsule.start.clone().add(e.capsule.end).multiplyScalar(0.5);
    if (shotMissDistance(origin, dir, travelled, c) > NEAR_MISS_RADIUS) continue;
    ...
```
Call site in `fireBotShot` (bot-viewer.html:4192-4238): `recordNearMisses(fireOrigin, dir, hit.distance, hit.kind === 'player' ? hit.id : null, bot, now);` (line 4218), reached on every bullet any bot fires (via `updateBotSentry` -> firing logic -> `fireBotShot`), not throttled or gated by distance/team first.
- **Why slow at high N**: every shot allocates a fresh `Vector3` (`capsule.start.clone().add(...)`) and calls `shotMissDistance` (a `hypot`) for every *other living bot on the enemy team*, regardless of range. `shotMissDistance` itself is `bot-alert.js:50-54`, cheap per call but not the problem — the problem is it runs N times per shot.
- **How cost scales**: shots/sec scale roughly linearly with N (each bot fires independently on its own weapon cadence), and each shot does O(N) work here, so total cost is O(N²) per second, not per frame — it gets worse the more bots are actively fighting, which is exactly the high-N scenario the harness targets.
- **Severity at 100 bots**: high (full-auto weapons at ~600rpm × ~50 shooters × 100-bot scan + per-shot Vector3 allocation is a real GC + CPU hot path during firefights, the worst-case moment for frame time).
- **Fix sketch**: prefilter with a cheap squared-distance/team check before computing `shotMissDistance`, or spatially bucket bots so only nearby enemies are tested; avoid the per-shot `clone()` by reusing a scratch vector.

## Finding: `sharedAllyAlertNear` is an O(N) scan called once per bot per frame

- **File**: `bot-viewer.html`, lines 1682-1694, called from line 3875.
- **Excerpt**:
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
```
Called unconditionally for every living bot every frame from `updateBotSentry`: `const report = firsthand || sharedAllyAlertNear(bot, now);` (line 3875), which itself runs inside the `updateAllBots` per-actor loop (line 920-936).
- **Why slow at high N**: this is exactly the "alert-propagation loop over all bots" pattern — a full team scan to find one nearby teammate's report, done independently by every bot every frame.
- **How cost scales**: O(N) per call × N bots per frame = O(N²) per frame, every frame, unconditionally (not gated by "is anyone alerted").
- **Severity at 100 bots**: medium-high (10,000 hypot+branch checks/frame just for this one function, 60×/sec; grows to 40,000/frame at 200 bots).
- **Fix sketch**: maintain a small spatial grid or per-team "currently alerted" list rebuilt once per frame (O(N)), then each bot queries only nearby entries from that list instead of the full `botActors` array.

## Finding: `livingTeammatesNear` is another O(N) full-roster scan, gated only during active alerts (i.e. during firefights)

- **File**: `bot-viewer.html`, lines 1695-1704, called from line 3880.
- **Excerpt**:
```js
function livingTeammatesNear(me, radius) {
  const p = botXZ(me);
  let n = 0;
  for (const other of botActors) {
    if (other.entity.alive === false || other.entity.team !== me.team) continue;
    const q = botXZ(other.entity);
    if (Math.hypot(q.x - p.x, q.z - p.z) <= radius) n++;
  }
  return n; // includes self
}
```
Call site: `if (esc.score >= ALERT_PUSH_SCORE && livingTeammatesNear(bot, SUPPORT_RADIUS) >= SUPPORT_GROUP_MIN) {` (line 3880), inside the same per-bot `updateBotSentry` tick.
- **Why slow at high N**: same full-array rescan pattern as the previous finding, this time to count nearby living teammates for the "push" escalation tier.
- **How cost scales**: O(N) per call, and the gate (`report` truthy, i.e. some alert active) is satisfied for *many* bots simultaneously exactly when a mass firefight is happening — the scenario where every other system is also under load. Worst case is again O(N²) per frame.
- **Severity at 100 bots**: medium (gated, but the gate opens widely during exactly the high-load moments that matter).
- **Fix sketch**: same as above — reuse a per-team spatial index/neighbor list built once per frame instead of re-scanning `botActors` per bot.

## Finding: `decideMedicDuty`'s candidate-gathering loop rescans the entire roster per medic per frame

- **File**: `bot-viewer.html`, lines 3559-3587 (loop at 3568-3587), called from line 3971.
- **Excerpt**:
```js
function decideMedicDuty(now) {
  const actor = activeBotActor;
  const selfXZ = botXZ(bot);
  const allies = [];
  const corpses = [];
  ...
  for (const other of botActors) {
    if (other === actor || other.entity.team !== bot.team) continue;
    const e = other.entity;
    ...
  }
```
Call site: `if (activeBotActor.role === ROLE_MEDIC && !botHealRequested && state !== BOT_FLEE && state !== BOT_KNIFE) { const duty = decideMedicDuty(now); ... }` (bot-viewer.html:3970-3972), inside the per-bot `updateBotSentry` tick, so it fires once per living medic per frame.
- **Why slow at high N**: iterates every bot on the roster (not just teammates — the team filter happens inside the loop body, after touching every element) to build the allies/corpses candidate lists, for every medic, every frame. This is the exact "medic target search scanning all bots per frame" pattern called out in the audit brief.
- **How cost scales**: O(N) per medic per frame → O(N_medics × N) per frame. With `medicPercent` at even 20%, 100 bots means 20 medics × 100 = 2,000 iterations/frame just for candidate gathering, before `attachMedicNavCost`/`decideMedicAction` (bot-medic.js:34-71, themselves O(candidates), i.e. small) even run.
- **Severity at 100 bots**: high if medic percentage is non-trivial (this is the actual pure-logic module's real caller-side cost — `bot-medic.js`'s own `selectHealTarget`/`selectReviveTarget` are only O(candidates) and fine; the expensive part is bot-viewer.html building those candidate lists from the full roster every frame for every medic).
- **Fix sketch**: maintain a per-team "living/wounded/dead" index updated incrementally (or once per frame in O(N)), and have each medic query that shared structure instead of each medic re-scanning `botActors` from scratch.

## Finding: medic duty pipeline does 2-3 redundant O(N) `Array.find` lookups per medic per frame

- **File**: `bot-viewer.html`, lines 3600, 3622, 3664.
- **Excerpt** (line 3600, inside `decideMedicDuty`):
```js
const targetActor = botActors.find((a) => a.entity.id === action.targetId);
```
**Excerpt** (line 3622, inside `stickyHealTend`):
```js
const cur = botActors.find((a) => a.entity.id === actor.medicTendTargetId && a.entity.alive !== false);
```
**Excerpt** (line 3664, inside `updateMedicTend`):
```js
const targetActor = botActors.find((a) => a.entity.id === action.targetId);
```
Call sites: `decideMedicDuty` (per living medic per frame, via line 3971 as above); `updateMedicTend` per medic per frame while `MEDIC_TEND` is active (line 4039: `updateMedicTend(dt, now);`).
- **Why slow at high N**: `Array.prototype.find` is a linear scan; resolving "the actor for this entity id" by id lookup is done from scratch up to 3 separate times per medic per frame (once inside `decideMedicDuty`'s own O(N) pass, again in `stickyHealTend`'s fallback, again every tend-tick in `updateMedicTend`), instead of using an id→actor map that already conceptually exists (bots are added/removed rarely relative to per-frame lookups).
- **How cost scales**: O(N) per lookup × up to 3 lookups × N_medics per frame, additively on top of the candidate-gathering loop above.
- **Severity at 100 bots**: medium (smaller constant than the full candidate scan, but compounds it — a busy medic actively tending someone pays this every frame for the whole session).
- **Fix sketch**: keep a `Map<id, actor>` alongside `botActors` (already effectively an array-of-structs keyed by `entity.id`) and use `.get(id)` instead of `.find()`.

## Finding: `updateMedicCohesionMovement` rescans the whole roster per medic per frame when idle

- **File**: `bot-viewer.html`, lines 3691-3710 (loop at 3697-3701), called from line 4075.
- **Excerpt**:
```js
function updateMedicCohesionMovement(now) {
  const actor = activeBotActor;
  const selfXZ = botXZ(bot);
  const teammates = [];
  for (const other of botActors) {
    if (other === actor || other.entity.team !== bot.team || other.entity.alive === false || other.role === ROLE_MEDIC) continue;
    const p = botXZ(other.entity);
    teammates.push({ x: p.x, z: p.z });
  }
  const goal = cohesionTarget(selfXZ, teammates, MEDIC_DEFAULTS);
  ...
```
Call site: `} else if (activeBotActor.role === ROLE_MEDIC && updateMedicCohesionMovement(now)) { /* regrouping */ }` (line 4075), the medic's fallback movement branch whenever it has no active heal/revive duty — i.e. runs every frame for every idle medic.
- **Why slow at high N**: full-roster scan to build a filtered non-medic-teammates array purely to compute a centroid (`bot-medic.js:74-100` `teamCentroid`/`cohesionTarget`, which are themselves cheap O(candidates)); the expense is entirely in building `teammates` from `botActors` every frame.
- **How cost scales**: O(N) per idle medic per frame → O(N_medics × N) per frame, same shape as the `decideMedicDuty` finding, and it runs on a different, overlapping set of frames (whenever a medic has no patient — commonly true for many medics much of the time).
- **Severity at 100 bots**: medium.
- **Fix sketch**: same shared per-team roster snapshot as `decideMedicDuty`'s fix; compute the non-medic teammate list once per team per frame and hand each medic a slice/filter view instead of re-deriving it per medic.

## Finding: `nearestSeekablePack`/`botCanSeePack` scan an unbounded, never-despawned world-pack list per bot per frame, including a raycast per candidate

- **File**: `bot-viewer.html`, lines 1593-1605 (`botCanSeePack`) and 1609-1621 (`nearestSeekablePack`), called from line 3815; packs never despawn (only `removeWorldHealthPack` on pickup or a full `clearWorldHealthPacks` reset), and every bot death drops up to `maxPacks` (2-4) fresh packs via `dropActorHealthPacks` (lines 1581-1590).
- **Excerpt**:
```js
function nearestSeekablePack(bot, actor, hurt) {
  if (!worldHealthPacks.length || !canHold(actor?.healthPacks, actor?.maxPacks)) return null;
  let best = null;
  for (const record of worldHealthPacks) {
    const cell = worldToCell(navGrid, record.x, record.z);
    if (goalClaims.isClaimedByOther(cellIdxOf(cell.c, cell.r), bot.id)) continue;
    const seen = botCanSeePack(bot, record);   // <- raycast per candidate, see below
    if (!seen.visible) continue;
    if (!hurt && seen.dist > botPackSettings.shortProximity) continue;
    if (!best || seen.dist < best.dist) best = { record, dist: seen.dist };
  }
  return best;
}
```
```js
function botCanSeePack(bot, record) {
  const eye = eyePos(bot);
  const dx = record.x - eye.x, dz = record.z - eye.z;
  const dist = Math.hypot(dx, dz);
  if (dist > botBehaviorSettings.sightDistance) return { visible: false, dist };
  ...
  const blocked = mapCollider?.raycast([eye.x, eye.y, eye.z], [dir.x / len, dir.y / len, dir.z / len], len - 0.05);
  return { visible: !blocked, dist };
}
```
Call site: `const seekable = wantsPack ? nearestSeekablePack(bot, activeBotActor, wantsHeal) : null;` (line 3815), inside `updateBotSentry`, gated by `wantsPack` (wounded-and-empty, or healthy-with-room — a very common state for most bots most of the time).
- **Why slow at high N, and getting worse over the session**: `worldHealthPacks` (bot-viewer.html:1471) has no cap and no time-based despawn — every bot death (`dropActorHealthPacks`) permanently adds up to `maxPacks` (`bot-health-packs.js:6`, up to 4 for medics via `bot-roles.js:34`) new entries that only ever leave the list on pickup. In a long-running 100+ bot session with combat and respawns, this list grows unboundedly. Each *living* bot doing this scan pays a full `mapCollider.raycast` for every candidate within `sightDistance` that passes the claim check — raycasts are not cheap, unlike the plain-math checks elsewhere in these modules.
- **How cost scales**: O(N_packs) per bot per frame, and N_packs itself grows with cumulative deaths (which scale with N and session length), so effective cost is O(N_bots × N_packs) per frame and monotonically increasing over time — a session-length perf leak, not just a bot-count one.
- **Severity at 100 bots**: medium initially, high after sustained play (deaths accumulate packs faster than pickups can drain them once the bot count and death rate are high).
- **Fix sketch**: cap/despawn world packs on a timer (or a hard max count with oldest-first eviction), and/or spatially bucket packs so `nearestSeekablePack` only tests nearby candidates instead of the whole list; cheap-distance-prefilter before the raycast (partially done via `sightDistance`, but claim/visibility ordering could put the raycast last, after the `shortProximity` gate).

## Finding: `collectPacksUnderfoot` shares the same unbounded-list scan cost, every bot every frame

- **File**: `bot-viewer.html`, lines 1625-1642, called from line 3808.
- **Excerpt**:
```js
function collectPacksUnderfoot(bot, actor, now) {
  const packs = actor?.healthPacks;
  if (!packs || !worldHealthPacks.length) return false;
  const here = botXZ(bot);
  let collected = false;
  for (let i = worldHealthPacks.length - 1; i >= 0; i--) {
    if (!canHold(packs, actor?.maxPacks)) break;
    const record = worldHealthPacks[i];
    if (Math.hypot(record.x - here.x, record.z - here.z) > botPackSettings.pickupRadius) continue;
    ...
```
Call site: `collectPacksUnderfoot(bot, activeBotActor, now);` (line 3808), unconditional, once per living bot per frame in `updateBotSentry`.
- **Why slow at high N**: unlike `nearestSeekablePack` it has no raycast, but it is still a full linear scan of the same ever-growing `worldHealthPacks` array, run for *every* bot every frame (not gated by "wants a pack").
- **How cost scales**: O(N_bots × N_packs) per frame, same growth profile as the previous finding.
- **Severity at 100 bots**: low-medium today (cheap per-entry work), rising to medium over a long session as `worldHealthPacks` grows.
- **Fix sketch**: same as above — bound the world-pack list size/lifetime; consider a shared spatial bucket so this becomes a local lookup instead of a full scan.

## Finding: `medicNavFlood`'s throttled flood-fill frequency scales with medic count

- **File**: `bot-viewer.html`, lines 3524-3531, called from `attachMedicNavCost` (line 3545) which is called from `decideMedicDuty` (line 3591).
- **Excerpt**:
```js
const MEDIC_NAV_FLOOD_MS = 200;
function medicNavFlood(actor, selfXZ, now) {
  if (!navGrid) return null;
  if (actor.medicFlood && now - actor.medicFloodAt < MEDIC_NAV_FLOOD_MS) return actor.medicFlood;
  const reach = Math.max(MEDIC_DEFAULTS.responseRadius, MEDIC_DEFAULTS.reviveRadius);
  actor.medicFlood = floodFill(navGrid, selfXZ, { maxRadius: Math.ceil(reach / navGrid.cellSize) + 1 });
  actor.medicFloodAt = now;
  return actor.medicFlood;
}
```
- **Why slow at high N**: each call is a grid flood-fill (cost proportional to the swept nav-grid area, `~(reach/cellSize)²` cells), not itself bot-count-dependent — but it is re-run per medic, per 200ms window, whenever `decideMedicDuty` has any candidate allies/corpses to rank (`attachMedicNavCost` only runs if `allies.length || corpses.length`, `bot-viewer.html:3544`). Medic count scales with total bot count via `medicPercent`, so aggregate flood-fill work scales with N even though any single call doesn't.
- **How cost scales**: O(N_medics / throttle_window) flood-fills per second, each O(reach²) — linear in N via medic count, not quadratic, but each unit of work is much heavier than the other findings' simple distance checks.
- **Severity at 100 bots**: low-medium (throttled to 5/sec per medic, but 20+ medics at once during a firefight means 100+ flood-fills/sec system-wide, each walking a chunk of the nav grid).
- **Fix sketch**: stagger medics' flood-fill refresh across frames (jittered offset per actor id) instead of a uniform 200ms window for all, so the per-frame flood-fill count is amortized rather than bursty; or share one flood-fill per squad/cluster of nearby medics instead of one per medic.

---

**Not flagged as findings, for context:**
- `squad-activity.js` exports (`tickSquadLossDecision`, `formationOffset`, `columnOffset`, `chooseFormationKind`, `pickExploreGoal`, `rollTemperament`, `formationAngleFor`) have zero call sites in `bot-viewer.html` — the module is unwired, so it costs nothing at runtime today.
- `bot-alert.js`'s own pure functions (`latestAlertNear`, `alertEscalation`, `latestNearMiss`) iterate `recentAllyHits`, which is hard-capped at 64 entries (`bot-viewer.html:1648`) regardless of bot count — these are O(1)-ish relative to N and not a scaling concern by themselves; the scaling problems are in the bot-viewer.html-side loops that call them once per bot per frame over the full `botActors` array (see the `sharedAllyAlertNear`/`livingTeammatesNear` findings above).
- `bot-health-packs.js`'s pure functions (`canHold`, `addPack`, `drawFromPacks`, `hasHealResource`, `packsTotalHp`) all operate on a single actor's held-pack list, capped at `maxPacks` (2-4) — not bot-count scaling.
- `bot-roles.js`'s `assignRolesToBatch` is O(batch size) but only runs once per spawn action, not per frame; `pickSquadLeader` has no call sites in `bot-viewer.html` (unwired, like `squad-activity.js`).
