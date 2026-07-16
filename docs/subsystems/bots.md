# Combat bots

Status: **wired into `environment-viewer.html`** (2026-07-14), with four follow-up polish passes
the same day: (1) facing bug, bot/player collision, a fall-over death pose, a respawn toggle, a
weapon-type select, behavior sliders, and local A* pathing on non-shoot-house maps; (2) a smooth
(not snapped) death fall, a player immortality toggle, threat awareness/alerting (bots react to
being shot or shot-at and share that awareness with nearby squadmates), and a first-person-only
visibility gate so bots can't perceive or hit the local player while they're in third-person body
view or the orbit/dev camera; (3) real ammo/reload (bots used to reload instantly, effectively
unlimited ammo), tree/rock-aware line of sight and pathing (bots used to see and path straight
through forest/rocks), and notice-time + accuracy sliders (bots used to snap-aim and fire with
perfect accuracy the instant they spotted you); (4) a code-review pass on (3) that throttled the
now-expensive LOS raycast to a fixed cadence instead of every frame, and gave the notice-time
clock a short grace window so briefly ducking behind a branch doesn't cheat a free reset. Plus a
same-day Phase 1 of a squads/outposts/ammo-economy layer — see "Squads (Phase 1)" below. See
`docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md` for the base FSM design/phasing,
`docs/superpowers/specs/2026-07-14-squad-outpost-ammo-economy-design.md` for the squads/outposts
design and phasing, `docs/superpowers/plans/2026-07-13-combat-bot-phase0-viewer.md` for how Phase 0
was built, and `bot-viewer.html` for the standalone dev harness these modules were tuned in (still
functional, kept as the fast iteration loop for future FSM/nav changes).

## What exists today

- `bot-entity.js` — capsule state (`createBotEntity`), gravity + physics step
  (`stepBotPhysics`), and conversion to the game's player wire-pose shape (`toWirePose`).
  `stepBotPhysics` resolves against a BVH `mapCollider` when one exists (shoot-house / any
  authored map); on open procedural terrain (no `mapKey`, so no `mapCollider` is ever built) it
  falls back to an optional `heightAt(x,z)` flat ground-snap so bots don't fall through the
  world — added for the wiring step, since the harness always has a `mapCollider` and never
  exercised that path. Browser/THREE only, not Node-tested.
  **Facing bug (fixed 2026-07-14)**: `bot.yaw` is stored in `bot-activity.js`'s convention
  (`atan2(dx,dz)`, 0 = +Z-forward — the convention `aimAnglesTo`, movement, and fire direction
  all use), but the wire quaternion's convention matches `camera.rotation.y` (0 = -Z-forward, the
  direction THREE's default camera looks). `toWirePose` previously built the quaternion straight
  from `bot.yaw` with no conversion, so a bot's rendered mesh (eyes/hands sit on the ghost's -Z
  face, see `multiplayer.js`) faced exactly opposite its actual aim/movement direction — it shot
  and walked correctly, but visually appeared to do so backwards. Fixed by adding a `+ Math.PI`
  offset before halving for the quaternion (`toWirePose`'s `halfYaw`).
- `bot-activity.js` — pure, THREE-free FSM: `chooseBotState` (patrol/seek/aim/fire, gated by
  target visibility + aim error + caller-owned fire-cooldown readiness + a caller-owned
  "last-known target position" flag), `aimAnglesTo`/`aimError`/`slewAngle` (turn-rate-capped
  yaw/pitch tracking). Node-tested (`test-bot-activity.mjs`). `retreat` (hp01-gated) still isn't
  implemented — no bot HP model exists yet (Phase 3).
- `nav-grid.js` — pure, THREE-free 2D walkable grid + A* pathfinding: `buildNavGrid`, `findPath`
  (8-connected, no corner-cutting), `smoothPath` (string-pull). Node-tested (`test-nav-grid.mjs`).
- `bot-viewer.html` — standalone harness, unchanged by this pass: swappable rooms/maze test maps,
  spawn/remove panel, WASD dummy target, full FSM+nav debug overlay. Still the place to iterate on
  FSM/nav-grid changes before they land in the real wiring below.
- `environment-viewer.html` — the live wiring (host/solo only; bots never run on a guest):
  - **State**: a `botPlayers` Map (id → `{ bot, fsmState, lastFireAt, lastKnownTarget, lastSeenAt,
    pathMode, currentPath, patrolIdx, spawnPos, deadSince, wanderTarget, weaponId }`), alongside
    the existing `mpGuestPlayers` Map. `getKnownPlayerState`, `currentCombatPlayers`, and
    `getState`'s player list all fold bots in exactly like guests — this is the payoff of the
    spec's "combat is player-id-generic" finding: no branching needed in `applyCombatIntent`,
    `resolveWorldShot`, `mergePlayerCombatFields`, ammo, or `player-combat.js`. Bots are hittable
    by humans (and vice versa) and count toward explosion blast damage for free — except the host
    player specifically, who is only perceivable/hittable by bots while first-person-visible (see
    "Player visibility gate" below); that carve-out lives in `resolveWorldShot`/`pickBotTarget`,
    not here.
  - **Rendering**: `mpGhostRenderer` (previously only constructed for `host`/`guest`) is now also
    constructed for `solo`, since bots are host/solo-only sim and need somewhere to render even
    with no multiplayer session. `updateHostPlayerGhosts()` folds bot wire-poses in alongside
    guest poses and is called every `updateBots()` tick (previously only guest-state-driven); it
    also merges each bot's `playerCombat.getSnapshot(id).alive` into the pose so
    `GhostRenderer`'s death-pose handling (below) picks it up.
  - **Nav grid**: a static full-map A* bake at map-load time, **shoot-house maps only**
    (`NO_ENVIRONMENT && mapCollider && loadedMap.bounds`) — `shoot-house.js`'s adapter exposes
    `bounds` (`{minX,maxX,minZ,maxZ}`, the absolute footprint) for this. The walkability test
    (`botNavWalkable`) samples `terrainHeight(x,z)` (a `mapCollider.raycastDown` probe) and
    accepts only points close to the map's constant floor height (0 on shoot-house) — a
    wall/pillar/cover top reads much higher and is correctly excluded, without needing to expose
    shoot-house's internal wall primitives. Walkable cells are also sampled (spread subset) as
    both bot spawn points and patrol stops.
    **Open/authored terrain maps** (2026-07-14) get real A* pathing too, just not a static bake —
    the maps in `maps/*-data.json` run 1200–4000m across, far too large to grid at any reasonable
    cell size. Instead `requestBotPath` builds a small window (`BOT_LOCAL_NAV_RADIUS` = 18m,
    `BOT_LOCAL_NAV_CELL` = 1.5m cells) centered on the bot fresh each time a path is requested,
    walkability from `botTerrainWalkable` (rejects underwater points — checked against
    `terrain.waterLevel`, which is synced from `loadedMap.seaLevel` on authored maps so the same
    test covers both — and points whose height differs too sharply from their neighbors —
    `BOT_TERRAIN_SLOPE_TOLERANCE` — so steep slopes and cliffs are excluded the same way shoot-house
    walls are, via a height discontinuity rather than a "near-zero floor" heuristic), and the goal
    clamped into that window. Once the window's path is consumed the bot is close enough to its old
    goal that a fresh window naturally makes progress toward a far-off target over several replans,
    without ever pathing the whole map at once. This applies uniformly to authored terrain maps
    (bounded, but far too big to bake) and fully open procedural terrain (unbounded — `terrainHeight`
    still resolves via the CPU height field/`loadedMap.heightAt` fallback either way). The debug
    panel shows a note when a session has no *static* nav grid, since the local-window approach is
    invisible from the outside.
    **Squad member terrain-trap fix (2026-07-15)**: `requestBotPath`'s local-window fallback used to
    beeline the bot straight to the raw goal (`[toXZ]`, ignoring walkability entirely) whenever A*
    found no walkable route to it. This was a latent gap since Phase 0 but bit hard once squad
    followers started chasing `squadMemberGoal`'s continuously-moving formation-ring point (Squads
    Phase 1, see below) — a formation point on the downhill/far side of a slope from a roaming
    leader hits this fallback far more often than the old fixed patrol/wander targets ever did, and
    the direct-line walk would take the bot straight down into a depression or across a slope it
    couldn't climb back out of, alive and still fighting the whole time, just visually buried up to
    the eyes. `requestBotPath` now retargets to `nearestWalkableInGrid`'s nearest walkable cell to
    the goal instead, only truly holding position (empty path, velocity zeroed) if that also fails.
    A per-bot `pathRetryAt` throttle (`BOT_PATH_RETRY_MS` = 500ms) stops a genuinely-stuck bot from
    rebuilding the local nav grid every single tick. Separately, `botTerrainWalkable`'s underwater
    check only ever looked at `loadedMap?.seaLevel`, which is `undefined` on open procedural
    terrain — bots could path straight into a lake there with no rejection at all; fixed by checking
    the unified `terrain.waterLevel` instead (same value, kept in sync for both cases already).
    **Retreat rally-point clump fix (2026-07-15)**: separately from the two spawn/path bugs above,
    an *already-active* squad could still visually clump after taking losses — `squad.order ===
    'retreat'` sent every surviving member's goal straight to the literal same `squad.spawnPos`
    point (the leader's XZ at squad-formation time), bypassing `squadMemberGoal`'s formation ring
    entirely, so the whole squad beelined onto one coordinate and `pushBotsApart` only separated
    them the bare minimum. Retreating non-leaders now keep their formation-ring offset
    (`formationOffset(squad.spawnPos, rec.formationAngle, SQUAD_FORMATION_RADIUS)`) around the
    rally point instead of the literal point itself; only the leader walks to `squad.spawnPos`
    directly.
    **Escape hatch for a bad-position (not just bad-goal) stall**: retargeting to the nearest
    walkable cell only fixes an unreachable *goal* — if the bot's own actual position ever falls
    outside `findPath`'s 6m start-snap radius (e.g. shoved there by `pushBotsApart`'s XZ-only
    collision correction), every retry fails identically regardless of goal, which would otherwise
    be a permanent stall. `rec.pathFailCount` counts consecutive throttled failures; at
    `BOT_STUCK_ESCAPE_RETRIES` (6, ~3s) the bot bypasses the nav grid and steers straight for its
    own `spawnPos` — independently trusted walkable ground — until either it arrives (resets the
    counter, normal pathing resumes) or a retry succeeds first. This is a bounded one-off recovery,
    not a substitute for real pathfinding.
  - **FSM tick** (`updateBots(dt)`, called from `animate()` alongside the creature update):
    per bot, picks the nearest alive human (host + guests, never other bots or ClaudeCraft mobs)
    within `botSightRange` (panel-tunable, live) with an unobstructed `mapCollider.raycast` line
    of sight, drives `bot-activity.js`'s aim/fire/patrol/seek exactly as the harness does, fires
    by building the same `combat_intent` shape `fireGunFromCamera` builds (using `rec.weaponId`,
    the bot's own assigned weapon) and calling `applyCombatIntent(intent, botId)` directly
    (host-local), and steps physics via `stepBotPhysics`. "Seek tenacity" (`botSeekTenacitySec`,
    panel-tunable) bounds how long a bot keeps chasing a lost target's last-known position
    (tracked via `rec.lastSeenAt`) before giving up and returning to patrol.
  - **Bot/player collision** (2026-07-14): `pushBotsApart()`, called once per `updateBots()` tick
    after the FSM loop, does pairwise XZ position correction between every pair of alive bots and
    between each bot and the local human player — same style as the legacy creature viewer's
    `resolveCreatureCollisions`, O(n²) but trivial at the round-mode cap of 10 bots. Dead
    (fallen) bots are excluded. Bots do not push against guest players (their positions are
    network-interpolated ghosts, not something the host can correct).
  - **Death/respawn**: dead bots (`playerCombat` HP hits 0) sit inert. If `botRespawnEnabled`
    (panel checkbox, default on) they revive after `BOT_RESPAWN_MS` (4000, matching the existing
    ClaudeCraft `CC_RESPAWN_MS` human-death convention) at their original spawn point via
    `playerCombat.revive`, with a freshly-created bot entity carrying the same `rec.weaponId`.
    With respawn disabled, dead bots stay fallen indefinitely — in round mode this also means a
    dead bot keeps its slot (the round-mode top-up loop counts `botPlayers.size`, not "alive"
    bots), so round mode won't backfill a bot that dies with respawn off. Visually, a dead bot
    smoothly tips over (450ms, `tick()`-driven, not a snap) via `GhostRenderer`'s death pose (see
    `multiplayer.js` above) rather than just standing inert or vanishing.
  - **Threat awareness / alerting** (2026-07-14): getting shot, or even just shot *at* (a miss
    that passes within `BOT_NEAR_MISS_RADIUS` = 2.5m of a bot's capsule), sets that bot's
    `lastKnownTarget`/`lastSeenAt` to the shooter's current position — the exact same fields
    normal LOS-based spotting uses — so the existing SEEK state (and its `botSeekTenacitySec`
    decay) handles "go find out what's happening" for free, no separate alert-timeout system
    needed. `alertBotsToShot`, called from `applyCombatIntent` right after every hitscan/melee
    shot resolves (hit or miss), checks the shot's ray against every living bot's capsule (3D
    point-to-segment distance, clamped to the hit distance) and alerts anything close enough.
    Explosions alert the same way from `applyExplosionBlast`, using the thrower's position (or the
    blast center if the thrower's pose isn't resolvable) as the threat. `propagateBotAlert` then
    shares that same threat position with every other living bot within `BOT_ALERT_PROPAGATE_RADIUS`
    = 15m (a squad awareness radius), and the same propagation fires whenever a bot acquires a
    live LOS target (`botTickOne`'s `targetVisible` branch) — so a bot actively fighting also pulls
    in nearby squadmates, not just one that gets hit. While seeking a `lastKnownTarget` (as opposed
    to patrolling), `botFaceTarget` keeps the bot's yaw locked onto the threat's direction every
    tick (independent of `botFaceMovement`'s velocity-direction facing), so a bot advancing on
    a shooter visibly "looks toward" them the whole way in, and starts firing back the instant
    `pickBotTarget`'s normal LOS check clears (no special-cased "blind fire" — a bot still needs
    real line of sight to actually shoot).
  - **Player visibility gate** (2026-07-14): `hostVisibleToBots()` (`fpsMode && !localBodyThird`,
    the same predicate the FP viewmodel's own visibility already used, see `showVM` elsewhere in
    the file) gates the local host player out of bot perception AND hit-testing whenever they're
    not actually looking through their own eyes — third-person body view (`localBodyThird`, the
    'B' key) or the orbit/dev camera (`fpsMode === false`) both make the player invisible to bots.
    `pickBotTarget` simply never offers the host as a candidate while not visible; `resolveWorldShot`
    additionally strips 'host' out of the hit-test capsule list for any shot fired by a bot
    (`botPlayers.has(shooterId)`) while invisible, so a bot's shot can't physically register a hit
    on a body it was never allowed to aim at either. This carve-out is bot-specific — it does not
    affect human-vs-human (guest) combat or human-vs-creature/mob combat, and guests are unaffected
    entirely (bots never target guests differently based on this).
  - **Player immortality toggle** (2026-07-14, "Player" panel section, host/solo only):
    `playerImmortal` gates the two places host damage is actually applied —
    `applyHitDamage` (hitscan/melee) and `applyExplosionBlast` — skipping `playerCombat.applyDamage`
    and the hit-feedback audio/screen-shake when `hit.id === 'host'` / `pl.id === 'host'` and the
    toggle is on. Bot alerting still fires normally even when immortal (getting shot still counts
    as "shot at" for awareness purposes, it just does zero damage). Host/solo-local only — a guest
    toggling this has no effect, since guest damage decisions are made host-side, not locally.
  - **Spawn modes** (debug panel, "Combat Bots" section, host/solo only): **manual** (a "+ Spawn
    bot" button drops one bot at the next sampled spawn point / near the player on open terrain;
    "Despawn all bots" clears them) and **round** (auto-maintains a target count, topping back up
    every tick if a bot is removed — dying alone never lowers the live count when respawn is on).
    Both modes are switchable at runtime from the same panel (explicit product decision,
    2026-07-14 — the original spec left "hand-placed vs. round-based" as an open question; the
    answer is "both, toggleable").
    **Coincident-spawn fix for squads on open terrain (2026-07-15)**: `botSpawnSlot(index)` falls
    back to a fixed `pose.x + 6, pose.z` point (ignoring `index` entirely) whenever there's no
    authored map to sample `botSpawnPoints` from — true for all open procedural terrain. Since
    `spawnSquadAtSlot` calls it once per squad member with consecutive indices, every member of a
    squad spawned this way, until this fix, landed on the exact same point; `pushBotsApart`'s
    pairwise correction only pushes overlapping capsules the bare minimum apart, so the squad
    stayed visually clumped together indefinitely instead of spreading onto the formation ring.
    The fallback now spreads slots around the player using a golden-angle spiral (`ang = index *
    2.399963`, radius `6 + (index % 4) * 2.5`) so squad members spawn already separated.
  - **Weapon select** (2026-07-14): a dropdown of `weapons.js`'s hitscan weapons
    (`enabledWeapons().filter(w => w.mode === 'hitscan')` — melee/projectile weapons aren't wired
    into the bot FSM's aim/fire model) sets `botWeaponId`. Applied at spawn time only and
    remembered per-bot as `rec.weaponId`; changing the dropdown doesn't retroactively re-equip
    bots already on the field, including through a respawn (the respawned bot keeps `rec.weaponId`
    from its original spawn, not whatever the dropdown currently shows).
  - **Behavior/trait sliders** (2026-07-14, panel): Health (`botMaxHp`, spawn-time trait, passed
    to `playerCombat.ensurePlayer`'s `maxHp`/`hp` opts — existing bots keep whatever max they
    spawned with), Move speed (`botMoveSpeed`), Sight range (`botSightRange`), Seek tenacity
    (`botSeekTenacitySec`), Notice time (`botNoticeTimeSec`), and Accuracy (`botAccuracy`) — all
    six except Health are read live every tick by all active bots, so moving those sliders affects
    bots already on the field immediately.
  - **Ammo/reload** (2026-07-14 third pass): `botFire` no longer calls `ensureAmmo`/`reloadAmmo`
    itself — `botTickOne` checks ammo before allowing `readyToFire`, and an empty mag starts a
    `BOT_RELOAD_MS` (1800ms) timer instead of refilling instantly. While reloading, `readyToFire`
    is false, so `chooseBotState` keeps the bot in `BOT_AIM` (tracking the target, not firing)
    until the timer elapses and the mag actually refills. Previously `botFire` called
    `reloadAmmo` the instant the mag hit 0, right before firing again — bots never ran dry.
  - **Tree/rock-aware perception and pathing** (2026-07-14 third pass): `botHasLineOfSight`
    previously only raycast against `mapCollider` (map/wall geometry) — trees and rocks
    (`trunkIndex`/`dressingIndexRef`, the same spatial indices the player's own movement collision
    uses) weren't checked at all, so a bot could lock onto and fire at someone standing behind a
    tree or boulder as if it wasn't there. It now runs the exact same occlusion pipeline a real
    shot resolves against (`resolveHitscan` with `obstacleColumnsAlongRay`'s tree/rock columns
    plus the map BVH occluder). `botTerrainWalkable` (the local-window nav test, see above)
    likewise now rejects any cell within `BOT_NAV_OBSTACLE_RADIUS` (0.3m, matching the bot
    capsule's own radius) of a trunk or rock circle (`trunkIndex.resolve`/`dressingIndexRef.resolve`),
    so `requestBotPath` routes around forest/rocks instead of clipping straight through them.
    Shoot-house's static bake (`botNavWalkable`) is unchanged — it's an indoor map with no forest.
  - **Notice time and accuracy** (2026-07-14 third pass): a freshly-spotted target isn't
    fireable-at immediately, even at zero aim error — `rec.targetAcquiredAt` is stamped on first
    spotting a target (`targetVisible` transitioning false→true) and `readyToFire` additionally
    requires `botNoticeTimeSec` (default 0.6s, panel slider 0-3s) to have elapsed since; losing
    sight resets the clock, so re-spotting notices again. `botAccuracy` (0-100%, default 60,
    panel slider) jitters only the *fired shot's* direction in `botFire` (up to
    `BOT_MAX_SPREAD_RAD` = 0.15 rad at 0% accuracy) — the bot's own visible aim (`bot.yaw`/`pitch`)
    stays exactly on target, so a low-accuracy bot still visibly aims right at you, it just doesn't
    always land the hit. Previously bots fired the instant `aimError` cleared tolerance with zero
    spread, which could mean an instant, perfectly-accurate shot the moment a target came into view
    at close range.
  - **LOS check throttled, notice-time grace window** (2026-07-14 fourth pass, code review of the
    third pass): `botHasLineOfSight` reuses the real shot-resolution pipeline
    (`resolveHitscan`/`obstacleColumnsAlongRay`), which is correct but not cheap — it was being
    re-run every single frame for every bot × every candidate (host + guests) via `pickBotTarget`,
    where before this pass that pipeline only ran when a shot was actually fired. `pickBotTarget`
    now splits into `nearestBotCandidate` (cheap, distance-only, still called every frame so aim
    tracking stays smooth) and a throttled raycast cached per bot (`rec.losVisible`/
    `rec.losTargetId`/`rec.nextLosCheckAt`, `BOT_LOS_CHECK_INTERVAL_MS` = 120ms) that's forced to
    refresh immediately if the nearest-candidate identity changes. Separately, `rec.targetAcquiredAt`
    (the notice-time clock) used to reset to `null` the instant `targetVisible` went false for even
    one tick — a target strafing behind a branch or doorframe could keep re-triggering the reaction
    delay and never let a bot reach `readyToFire`. `rec.lastVisibleAt` now tracks the last tick the
    target was actually seen, and the clock only resets after `BOT_NOTICE_GRACE_MS` (400ms) of
    continuous invisibility, not the first missed tick.

## Squads (Phase 1)

Pure decision logic lives in `squad-activity.js` (THREE-free, Node-tested via
`test-squad-activity.mjs`), wired into `environment-viewer.html`:

- `SQUAD_LOSS_THRESHOLD` (0.4), `rollTemperament(min, max, rand)`, `tickSquadLossDecision(...)`
  (edge-triggered, latched loss-retreat roll — see the module for exact latch semantics),
  `formationAngleFor(memberIndex, memberCount)`, `formationOffset(leaderPos, angleRad, radius)`.
- **State**: `botSquadModeEnabled` (panel toggle), `botTemperamentMin`/`Max` (panel sliders,
  default 0.15/0.85), `SQUAD_MIN_SIZE` (5), `SQUAD_FORMATION_RADIUS` (5m), `BOT_RETREAT_SPEED_MULT`
  (1.45), a `squads` Map (`squadId -> { id, outpostId: null, teamId: 'bots', leaderId, memberIds,
  initialSize, order, orderTarget, lossRetreatDecided, spawnPos }` — `outpostId`/`teamId` are
  placeholders for Phase 4, unused this phase). Every bot rec (squadded or not) gets `squadId`,
  `isLeader`, `temperament` (rolled once at spawn between the temperament sliders), and
  `formationAngle`.
- **Formation**: `formSquad(botIds)` builds a squad record from a batch of already-spawned bot
  ids (first id is the leader), assigns each member's `formationAngle`, and captures the leader's
  spawn position as `squad.spawnPos`. `spawnSquadAtSlot` spawns `SQUAD_MIN_SIZE` bots via the
  existing `spawnBotAtSlot` and forms them. When `botSquadModeEnabled`, both manual spawn and
  round-mode top-up spawn in squad batches instead of one bot at a time; with the toggle off,
  spawning is byte-identical to the pre-squads behavior.
- **Movement**: `squadMemberGoal(rec)` — a non-leader with no patrol path in flight orbits the
  live leader position at `formationAngle`/`SQUAD_FORMATION_RADIUS`, falling back to the existing
  `nextPatrolTarget` wander only if unsquadded or leaderless. Any squad member (leader included)
  heads for `squad.spawnPos` instead when `squad.order === 'retreat'`. `followBotPath` (the sole
  `botMoveSpeed` read site) multiplies by `BOT_RETREAT_SPEED_MULT` for a retreating bot's squad.
- **Per-tick squad logic**: `updateSquads()`, called from `updateBots` right after the per-bot FSM
  loop (before `pushBotsApart()`). Per squad: computes `aliveCount` from `playerCombat.getSnapshot`,
  calls `tickSquadLossDecision` with the leader's `temperament` (cautious/low-temperament leaders
  retreat more readily once ≥40% of `initialSize` is lost), sets `order = 'retreat'` on a true
  roll, and promotes the first other alive member to leader when the current leader is dead
  (flips `isLeader` on both). Attack/hold orders otherwise come only from the panel's manual
  per-squad Retreat/Attack buttons — no AI outpost-leader exists yet (Phase 4).
- **Panel**: new "Squads & Outposts" section — squad-mode checkbox, temperament min/max sliders, a
  live per-squad roster readout (id, alive/total, current order), and manual Retreat/Attack
  buttons per squad.
- **Scope**: squads only, uniform spawn placement (no density gradient yet), no ammo/medkit
  economy, no outposts, no drops — see the design spec's Phasing section for Phases 2-4.
  Interactive browser verification (formation-follow, retreat behavior, leader succession, the
  loss-threshold auto-retreat roll) is still outstanding — the above was verified via `node
  --check`, the full `test-*.mjs` suite, and static code reading, not an in-browser playtest.

## Bot Inspector (2026-07-15)

Debug tool for diagnosing the kind of live movement/pathing glitches squads exposed (terrain-trap,
retreat clump, etc. above) directly instead of guessing from a screenshot. All in
`environment-viewer.html`, host/solo only (`mpRole !== 'guest'`), no new files.

- **Selection**: `selectedBotId` (module state) plus `selectBot(id)`/`cycleSelectedBot(delta)`.
  Three ways to select: Alt+Click a bot in the 3D scene (`pickBotAtScreen` raycasts against
  `mpGhostRenderer.playerGroups()`, filtered to ids in `botPlayers`), click a row in the panel
  table, or Left/Right arrow keys (global keydown handler, skipped while a form control has focus).
  Alt+Click is used instead of a plain click because plain left-click is already claimed (fires the
  equipped weapon in FPS mode, starts an orbit-camera drag otherwise); the orbit-drag pointerdown
  handler and the FPS-mode mousedown handler both bail out early on `e.altKey` so the two never
  fire together.
- **3D highlight**: `ensureBotMarker()` lazily creates a flat yellow ring (`depthTest: false`, high
  `renderOrder`) that `updateBotInspector` repositions onto the selected bot's capsule-base position
  every `updateBots` tick; hidden (not removed) when nothing is selected.
- **Panel** ("Bot Inspector" section): a live text readout of the selected bot (fsm state, hp/alive,
  position, XZ speed, `pathMode`/waypoint count/`pathFailCount`, squad id + leader/member + order,
  whether it has a live target, ammo/reload) refreshed at ~150ms via `refreshBotInspectorPanel`
  (throttled the same way `updateCreatureCommandHud` is), Prev/Next/Clear buttons mirroring the
  arrow keys, a "Teleport to selected" button, and a table of every live bot (id, state, hp,
  rounded position, fail count) — each row selectable by click and carries its own "Go" teleport
  button, with the selected row highlighted.
- **Teleport**: `teleportPlayerTo(x, z)` snaps the local player's capsule (`playerCollider`) and the
  orbit camera's `target` straight to a world XZ point at `terrainHeight(x,z)`, matching the same
  ground-contact convention `resetPlayerPosition`/bot spawning use — no path or collision check, an
  instant jump for inspection purposes only.

## Not yet built (see spec for phasing)

The `retreat` state (needs a bot HP model beyond alive/dead — a hp01-style threshold could now
reuse `playerCombat.getSnapshot(id).hp/maxHp`, since bots have real HP via the panel's Health
slider, but the FSM itself still has no low-HP branch), the optional Phase 2b nav-mesh upgrade
path (superseded in spirit by the 2026-07-14 local-window A* for terrain, though a nav-mesh would
still be more accurate for irregular authored geometry), and tactical polish (Phase 3:
cover-seeking, peek/lean squad coordination beyond the simple shared-target-position alerting
added 2026-07-14). Bots also don't currently count toward any player-count-gated logic (round win
conditions, scoreboards) — the spec's other open question was resolved as out of scope for this
pass (no such logic exists yet in this codebase to wire into).

Known minor edge case (2026-07-14, not fixed — harmless): if the host fires while invisible to
bots (third-person/orbit), `alertBotsToShot` can still alert *other* bots standing near the shot's
ray to the host's position (the visibility gate only blocks the actually-targeted/hit bot's
perception, not the near-miss alert to bystanders). Those bystander bots will SEEK toward the
host's last known position but can never actually acquire or hit them (`pickBotTarget`/
`resolveWorldShot` both still enforce the gate), so this only wastes a little bot movement, never
results in an actual interaction.

## Key files

| File | Role |
|---|---|
| `bot-entity.js` | Capsule/physics/pose, including the wire-quaternion facing fix — Browser/THREE only. |
| `bot-activity.js` | Pure FSM decision math (patrol/seek/aim/fire) — Node-tested, THREE-free. |
| `squad-activity.js` | Pure squad decision math (temperament roll, loss-retreat latch, formation geometry) — Node-tested, THREE-free. |
| `nav-grid.js` | Pure walkable-grid + A* pathfinding, used both for shoot-house's static bake and the terrain local-window — Node-tested, THREE-free. |
| `bot-viewer.html` | Dev harness; not part of the game's module graph, still useful for FSM/nav iteration. |
| `environment-viewer.html` | Live wiring: `botPlayers`, nav-grid bake + local windows, `updateBots`, `pushBotsApart`, spawn/behavior panel. |
| `shoot-house.js` | Adapter exposes `bounds` for the shoot-house static nav-grid bake. |
| `multiplayer.js` | `GhostRenderer`'s capsule-ghost path renders a smooth (tick()-driven) fall-over death pose for any `alive:false` player/bot pose. |
