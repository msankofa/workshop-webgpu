# Combat bots: player-shaped entities driven by an FSM

Status: DESIGN (2026-07-13). Not started.

## Goal
Add host-only bots that occupy a slot in the `players` list (same wire shape as a human),
can be shot by players/creatures and shoot back, but whose movement/aim/fire decisions come
from a state machine instead of keyboard/mouse input. No new "player class" needed — most of
the combat pipeline is already keyed by player *id*, not by "is this a human."

## Terminology note
"NPC" is already taken: `syncSharedNpcConfig`/`exportSharedNpcConfig` (environment-viewer.html
~:467) refer to the port-creature roster synced to guests. Call this feature **bots**
throughout code/docs to avoid the clash (`botPlayers`, `bot-activity.js`, `BotEntity`).

## Key finding: combat is player-id-generic, movement is camera-coupled
Two separate systems, very different reuse cost:

- **Combat/HP pipeline — reusable as-is.** `applyCombatIntent(intent, ownerId)`
  (environment-viewer.html:6567) only needs `getKnownPlayerState(ownerId)` to return a pose;
  it doesn't care whether `ownerId` is `'host'`, a guest clientId, or a bot id. HP lives in
  `player-combat.js`'s facade, keyed by id, already shared across humans and (via the
  delegated backend) ClaudeCraft mobs. `getState()` (environment-viewer.html:525) builds
  `players` by calling `addPlayer(getLocalPlayerState('host'))` then iterating
  `mpGuestPlayers.values()` — a `botPlayers` Map iterated the same way is a straight addition,
  no branching elsewhere. Guests already render anything in `players` via `GhostRenderer`
  (multiplayer.js:93), so bots are visible to guests for free.
- **Movement/physics — NOT reusable as-is.** `applyFPSControls`/`updateFPSPlayer`
  (environment-viewer.html:6812, 6850) read module-global singletons (`camera`, `fpsKeys`,
  `playerVelocity`, `playerCollider`, `stance`, `capsuleH`) — there is exactly one of each,
  because there is exactly one local player. Movement basis vectors come from
  `camera.matrixWorld`. This code cannot be called per-bot without first extracting per-entity
  state, and even then a bot has no camera to read a heading from. **Write bot movement fresh**
  instead of retrofitting these functions; reuse only the generic pieces underneath them:
  `mapCollider.resolveCapsule(capsule, velocity, opts)`, `terrainHeight(x, z)`,
  `trunkIndex.resolve`, `dressingIndexRef.resolve` — all already take explicit
  capsule/position args, no globals.

## Bot state shape
Mirror the wire pose (`getLocalPlayerState`, environment-viewer.html:432) plus physics state
a real capsule needs:
```
{
  id,                          // 'bot-1', ...
  capsule: Capsule,            // own start/end/radius, independent of playerCollider
  velocity: Vector3,
  onFloor: bool,
  yaw, pitch,                  // facing/aim, no camera involved
  weapon, tool,
  fsm: { state, timer, target },
}
```
`toPose(bot)` → `{ id, p, q, h, r, weapon, tool, aimPitch }` (same fields as
`getLocalPlayerState` returns) is what gets pushed into `botPlayers` each frame for
`getState()`/`getKnownPlayerState()` to pick up unchanged.

## New pure module: `bot-activity.js`
Follow the `creature-activity.js` pattern (THREE-free, Node-tested,
`chooseActivity({ current, ctx, weights, rand }) → { activity, duration }`). States for a
combat bot are different from the wildlife set:

| State | Behavior |
|---|---|
| patrol | walk a waypoint loop / wander like `pickRoamTarget` |
| seek | move toward last-known enemy position |
| aim | stop, rotate yaw/pitch toward target within a turn-rate cap |
| fire | hold aim, emit `gun.fire` intents at the weapon's fire interval |
| retreat | back off toward cover/spawn when `hp01` low |

`ctx` inputs: `targetDist`, `targetVisible` (line-of-sight via the existing hitscan occluder
check), `hp01`, `aimError` (angle to target). Same determinism contract as
`creature-activity.js`: pure function of `(current, ctx, weights, rand)`.

## Nav grid (Phase 2 dependency)
`seek`/`patrol`/`retreat` need to move a bot across the shoot-house's rooms/corridors without
snagging on wall corners — steering-only (what creatures do today via `computeSteering` +
collision push-out) is fine on open terrain but not indoors. No nav data exists anywhere in
this codebase yet.

- New pure module `nav-grid.js` (THREE-free, Node-tested, same family as `nav-grid` peers
  `forest-cull.js`/`light-cluster.js`): `buildNavGrid(walkableTest, bounds, cellSize)` bakes a
  2D walkable/blocked grid; `findPath(grid, from, to) → [{x,z}, ...]` is A* over 4/8-connected
  cells; `smoothPath(path)` string-pulls it down to a handful of waypoints so bots don't hug
  the grid's staircase pattern.
- Bake source: reuse whatever `map-collision.js` already builds its wall/solid geometry from
  for the current map (shoot-house or terrain), sampled per cell at bake time — not
  regenerated per bot, not per frame. One grid per loaded map, built once and cached.
- Cell size: start at 0.5 m (comfortably under the bot capsule radius) for the shoot-house;
  terrain/open-world bots likely don't need the grid at all and can keep using steering.
- `seek`/`patrol`/`retreat` in `bot-activity.js` consume `findPath` output as a waypoint queue
  (`ctx.nextWaypoint`), not raw grid cells — the FSM stays map-representation-agnostic, only
  the wiring layer touches `nav-grid.js`.
- This is a hard dependency for Phase 2 (any bot movement) but not for Phase 1 (stationary
  sentry needs no path).

## Nav mesh (optional, Phase 2b — upgrade path, not required)
Only pursue if nav-grid path quality/perf becomes a real problem (many bots, bigger maps, or
paths that still look grid-locked after smoothing). Default is: don't build this.

- Why it's cheaper here than usual: nav mesh generation is normally the hard part (Recast-style
  voxelize-then-extract-polygons from arbitrary rendered geometry). This codebase doesn't need
  that, because `shoot-house-rooms.js`/`shoot-house-layout.js` already know each room as a
  rectangular footprint with an explicit doorway position (`entryX`, shoot-house-rooms.js:8)
  *before* it becomes geometry. The mesh can be built directly from those authoring-time
  rectangles instead of extracted from the rendered walls.
- New pure module `nav-mesh.js` (Node-tested, same `findPath(from, to) → [{x,z}, ...]` shape as
  `nav-grid.js` so `bot-activity.js` doesn't care which backend is active): each room →
  one convex polygon (a few, if cover boxes subdivide it); each doorway → a portal edge linking
  two room polygons. Pathing becomes A* over the room-adjacency graph, then a funnel/string-pull
  pass across the portal sequence for the final line — replacing nav-grid's post-hoc smoothing.
- Generator hook, and the actual cost of this phase: `shoot-house-layout.js`/
  `shoot-house-rooms.js` would need to *export* the room-rect + doorway-portal list they already
  compute internally but currently only consume for geometry. The pathfinding math is the easy
  part; exposing that authoring data is the work.
- Tradeoff vs. nav grid: far fewer nodes (rooms, not cells) → cheap long paths, naturally smooth
  routes, no smoothing pass. But it only works because the shoot-house generator can hand you
  polygons/portals directly — it would NOT generalize to open terrain or hand-authored geometry
  without a real mesh-extraction pipeline, so terrain bots (if ever needed) stay on steering,
  never nav mesh.
- Reuses the `bot-viewer.html` harness and its debug overlay (draw room polygons + portals +
  funneled path instead of grid cells + A* path).

## Dev/test harness: `bot-viewer.html`
Build this **before** wiring bots into `environment-viewer.html`, mirroring the established
`plant-viewer.html`/`tree-viewer.html`/`stellar-viewer.html` pattern: a standalone page that
imports the real production modules directly (not copies), with its own minimal WebGPU
scene/camera/orbit-controls and no game-loop/multiplayer/UI-tab dependency. Because it imports
the same files, everything built and tuned here is literally the code that lands in
`environment-viewer.html` later — "drag and drop," not a port.

- Imports: `bot-activity.js`, `nav-grid.js`, the bot movement/physics module, `weapons.js`,
  `combat.js` (`resolveHitscan`), `player-combat.js`, `map-collision.js`. Skips everything
  viewer-only: `multiplayer.js`, `environment-ui.js`, audio, forest/grass/water.
- Test surface: a small hand-built box-and-plane room set (or a slice of `shoot-house-layout.js`
  output) with a few walls/corners so nav-grid pathing is actually exercised, plus a
  keyboard-controlled dummy "player" capsule (reuse the minimal parts of `applyFPSControls`'s
  logic, not the function itself, since it's camera-global-coupled) so bot detection/aim/fire
  has a target to react to.
- Debug overlay: draw the baked nav grid (walkable cells) and the current A* path as line
  segments — this is the single highest-leverage thing the harness buys, since path bugs are
  nearly invisible without a visual.
- Panel: play/pause, spawn/remove bot, force an FSM state, toggle nav-grid/path overlay, hp
  slider to trigger `retreat` — same lightweight dat.gui-less inline-DOM style as the other
  `*-viewer.html` tools.
- Explicitly out of scope for the harness: multiplayer replication, `getState()`/`GhostRenderer`
  wiring, real shoot-house geometry — those are only exercised once the bot code is wired into
  `environment-viewer.html`.

## Per-frame wiring (environment-viewer.html, host/solo only)
New `updateBots(dt)`, called from `animate()` alongside `portCreatures.update(rawDt)`
(~:7230), host-authoritative like everything else in multiplayer (guests never run this):
1. For each bot: tick FSM via `bot-activity.js`, producing a movement heading + speed and
   whether to aim/fire this frame.
2. Movement: integrate velocity from heading (no `fpsKeys`), gravity when `!onFloor`, resolve
   against `mapCollider`/`trunkIndex`/`dressingIndexRef` exactly as `updateFPSPlayer` does
   but on the bot's own capsule.
3. Aim: slerp `yaw`/`pitch` toward the target pose's `p`, capped by a turn-rate constant.
4. Fire: when FSM state is `fire` and the weapon's cooldown has elapsed, build the same intent
   shape `fireGunFromCamera` builds (environment-viewer.html:6653) — `{ type: 'combat_intent',
   action: 'gun.fire', weapon, shotSeq, origin: bot muzzle pos, dir: aim vector, clientTime }`
   — and call `applyCombatIntent(intent, botId)` directly (host-local, no network hop needed).
5. Push `toPose(bot)` into `botPlayers`.

## Hook points to touch
- `getKnownPlayerState(id)` (environment-viewer.html:421): check `botPlayers` alongside
  `'host'`/`mpGuestPlayers`.
- `getState()` (environment-viewer.html:525): `for (const b of botPlayers.values()) addPlayer(b)`.
- `currentCombatPlayers(nowMs)` (environment-viewer.html:424): same addition, so bots count as
  hittable targets in `combat.js`'s `resolveHitscan` player list.
- `player-combat.js`: `ensurePlayer(botId, opts)` on spawn, `removePlayer(botId)` on despawn —
  no facade changes needed, it's already id-generic.
- Death/respawn: reuse whatever the human death/revive path does
  (`player-combat.js#revive`), or despawn the bot on death — decide in Phase 1.

## Constraints
- Bots are host/solo-only simulation, same as creatures and mobs — never run FSM or physics
  for a bot on a guest client.
- Do not touch `applyFPSControls`/`updateFPSPlayer` — they stay human-only and camera-coupled.
  Bot movement is new code, not a refactor of these.
- Terse one-line comments only; rationale lives in this spec + agent_log.
- Pure decision logic (`bot-activity.js`) is Node-tested and THREE-free, mirroring
  `creature-activity.js`'s split between pure FSM and world-wiring.

## Phasing
- **Phase 0 — `bot-viewer.html` harness.** Build the standalone viewer first (see above) with
  a stub bot: capsule, yaw/pitch, no FSM yet. Proves the module boundary (viewer imports the
  same files the game will) before any bot logic exists.
- **Phase 1 — stationary sentry, built and tuned in the harness.** Fixed position, no movement
  FSM: rotate to face nearest visible target, fire on cooldown. Proves `bot-activity.js`'s
  aim/fire states and the combat-intent shape entirely inside the harness.
- **Phase 2 — patrol/seek movement + nav grid.** Add `nav-grid.js` (bake + A* + smoothing),
  capsule physics, and patrol/seek states — built and path-debugged in the harness using its
  overlay.
  - **Reordered 2026-07-13** (project decision, not the original draft order): movement was
    pulled ahead of the "wire Phase 1 into `environment-viewer.html`" step below. Rationale: a
    bot that can't move is a much smaller proof than one that can navigate the map, so both
    Phase 1 (aim/fire) and Phase 2 (patrol/seek/nav-grid) are now proven entirely inside the
    harness *before* any `environment-viewer.html` wiring is attempted, rather than wiring the
    stationary sentry in first. `retreat` (hp01-gated) still waits on a bot HP model — Phase 3.
- **Wire into `environment-viewer.html`** (hook points above) — happens once Phase 1 and
  Phase 2 both work in the harness, proving combat-pipeline reuse (spawn, hittable, HP, death,
  movement/collision against the real map) against the real multiplayer/HP code in one pass
  instead of two.
  - **Done 2026-07-14.** All hook points above are live; see `docs/subsystems/bots.md` for the
    resulting shape. Two deviations from this doc as originally written:
    - **Nav grid is shoot-house-only**, baked from `mapCollider`/`terrainHeight` directly (a
      floor-height raycast-down test) rather than from shoot-house's internal wall primitives —
      avoided needing to export room-rect/doorway authoring data early (that's still the Phase 2b
      nav-mesh path if ever needed). Open terrain gets no nav grid; bots there wander instead of
      patrol-pathing, per this doc's own "terrain bots keep steering" guidance below.
    - **`stepBotPhysics` gained an optional `heightAt` ground-snap fallback** (`bot-entity.js`)
      for open terrain with no `mapCollider` at all (no authored `mapKey`) — not anticipated by
      the harness, which always has a collider.
  - **Open question resolved 2026-07-14** ("Spawn/despawn authoring"): both hand-placed/manual
    and round-based spawning are implemented, toggleable at runtime from the same debug-panel
    control — not an either/or choice.
  - **Open question resolved 2026-07-14** ("player-count-gated logic"): out of scope for this
    pass — no round-win/scoreboard logic exists yet in this codebase for bots to interact with.
  - **Follow-up polish pass, same day (2026-07-14)**, from playtesting feedback on the initial
    wiring:
    - **Facing bug fixed**: `toWirePose` built the wire quaternion straight from `bot.yaw` with
      no conversion, but `bot.yaw`'s convention (0 = +Z-forward) and the wire quaternion's
      convention (0 = -Z-forward, matching `camera.rotation.y`) are a fixed π apart — bots aimed
      and fired correctly but their rendered mesh faced exactly backwards. See `bot-entity.js`.
    - **Bot/player collision added**: `pushBotsApart()` in `environment-viewer.html`, pairwise XZ
      correction between alive bots and against the local player, same style as the legacy
      creature viewer's `resolveCreatureCollisions`.
    - **Death now has a visible effect**: `GhostRenderer`'s capsule-ghost path (`multiplayer.js`)
      tips a dead pose's capsule onto its face and drops it to ground height, rather than leaving
      it standing inert. Generic on any `alive: false` pose, not bot-specific.
    - **Terrain nav grid revisited**: the original "open terrain gets no nav grid, bots wander
      instead" decision above was **not** primarily a performance shortcut — the authored maps in
      `maps/*-data.json` run 1200–4000m across, far too large for a static full-map bake at any
      usable cell size (a shoot-house-style bake would be tens of millions of cells). Instead,
      `requestBotPath` now builds a small on-demand A* window (`BOT_LOCAL_NAV_RADIUS` = 18m)
      centered on the bot each time a path is requested, using a slope/water-based walkability
      test (`botTerrainWalkable`) instead of shoot-house's floor-height test. This applies to both
      authored terrain maps and fully open procedural terrain, so "terrain bots keep steering" (the
      guidance referenced above) is superseded — terrain bots now path locally, they just don't get
      a whole-map static bake the way shoot-house does.
    - **Respawn, weapon, and behavior became panel-tunable**: `botRespawnEnabled` (toggle — off
      leaves fallen bots dead in place), `botWeaponId` (select, hitscan weapons only, applied at
      spawn time and remembered per-bot), `botMaxHp` (spawn-time), `botMoveSpeed`/`botSightRange`/
      `botSeekTenacitySec` (live, read every tick). See `docs/subsystems/bots.md` for specifics.
  - **Second follow-up polish pass, same day (2026-07-14)**, from further playtesting feedback:
    - **Smooth death fall**: the death pose (added in the first polish pass above) was an instant
      snap; `GhostRenderer` now animates it over 450ms via `tick()`, lerping from the last upright
      pose captured at the moment of death rather than jumping straight to the resting pose. See
      `docs/subsystems/multiplayer.md`.
    - **Threat awareness / squad alerting**: being shot, or shot *at* (a near miss), now sets a
      bot's `lastKnownTarget` to the shooter's position — reusing the existing SEEK/tenacity
      machinery rather than a new alert-timeout system — and propagates that same threat to nearby
      living bots (`BOT_ALERT_PROPAGATE_RADIUS` = 15m), whether the bot got shot, was shot at and
      missed, or is a squadmate of one that acquired a live LOS target. A new `botFaceTarget` keeps
      a seeking bot's aim trained on the threat direction while it moves, independent of its
      direction of travel, so it visibly "looks toward" the danger and starts firing back the
      instant real line of sight opens up (no blind-fire special case — `pickBotTarget`'s LOS check
      still gates actually shooting).
    - **Player immortality toggle**: `playerImmortal`, panel-tunable, gates the two host-damage
      application sites (`applyHitDamage`, `applyExplosionBlast`). Host/solo-local only.
    - **First-person-only visibility**: the local player is only perceivable/hittable by bots
      while `fpsMode && !localBodyThird` (`hostVisibleToBots()`) — third-person body view and the
      orbit/dev camera both make the player invisible to bots, both for AI targeting
      (`pickBotTarget`) and for physical hit registration (`resolveWorldShot` strips 'host' from a
      bot shooter's hit-test list while invisible). Human-vs-human and human-vs-creature/mob combat
      are unaffected; this carve-out is specifically about bot perception of the local player.
    See `docs/subsystems/bots.md` for the full writeup, including one known-harmless edge case
    (bystander bots can still be alerted toward an invisible host's position via near-miss, even
    though they can never actually acquire or hit them).
  - **Third follow-up polish pass, same day (2026-07-14)**, from further playtesting feedback
    ("unlimited ammo", "can see through trees/rocks", "lasers me the instant it notices me"):
    - **Real ammo/reload**: `botFire` previously called `reloadAmmo` the instant a bot's mag hit
      0, right before firing again — bots effectively never ran dry. `botTickOne` now gates
      `readyToFire` on ammo and starts a `BOT_RELOAD_MS` (1800ms) timer when empty; the bot keeps
      tracking its target (`BOT_AIM`) but can't fire until the timer elapses and the mag refills.
    - **Tree/rock-aware LOS and pathing**: `botHasLineOfSight` only checked `mapCollider` (map/wall
      geometry) — trees and rocks weren't occluders at all, so a bot could lock onto and fire
      through one. It now reuses the exact same occlusion pipeline a real shot resolves against
      (`resolveHitscan` + `obstacleColumnsAlongRay`'s tree/rock columns). `botTerrainWalkable`
      (the local-window nav test) likewise now rejects cells within a bot-radius of a trunk/rock
      circle, so pathing routes around forest/rocks instead of clipping through them.
    - **Notice time + accuracy**: bots fired the instant `aimError` cleared tolerance with zero
      shot spread — effectively an instant, perfectly accurate snap-shot the moment you came into
      view. `rec.targetAcquiredAt` now stamps the moment a target is first spotted, and
      `readyToFire` additionally requires `botNoticeTimeSec` (panel slider, default 0.6s) to
      elapse since; `botAccuracy` (panel slider, default 60%) jitters the *fired shot's* direction
      (not the bot's visible aim) by up to `BOT_MAX_SPREAD_RAD` at 0% accuracy.
    See `docs/subsystems/bots.md` for full details.
  - **Fourth follow-up polish pass, same day (2026-07-14)**, a code review of the third pass
    rather than new playtesting feedback:
    - **LOS raycast throttled**: `botHasLineOfSight` (added in the third pass) reuses the real
      shot-resolution pipeline, correct but not cheap, and was running every frame per bot per
      candidate. `pickBotTarget` now only re-runs the raycast every `BOT_LOS_CHECK_INTERVAL_MS`
      (120ms) per bot (or immediately if the nearest candidate changes); cheap distance-only
      candidate selection still runs every frame so aim tracking stays live.
    - **Notice-time grace window**: `rec.targetAcquiredAt` used to reset the instant a target
      dipped out of LOS for even one tick, so weaving through light cover could indefinitely
      deny a bot ever reaching `readyToFire`. `BOT_NOTICE_GRACE_MS` (400ms) now tolerates brief
      breaks before resetting the clock.
    See `docs/subsystems/bots.md` for full details.
- **Squads, outposts, and an ammo economy (design only, not started)**: see
  `docs/superpowers/specs/2026-07-14-squad-outpost-ammo-economy-design.md`. Ammo pickups become
  the actual fix for the "bots that ran dry stay dry forever" gap noted during the fourth
  polish-pass review above — not fixed by throttling, deferred to that spec instead.
- **Phase 2b — nav mesh (optional).** Only if Phase 2's nav grid proves insufficient (see Nav
  mesh section). Swaps `nav-grid.js` for `nav-mesh.js` behind the same `findPath` shape;
  everything above the pathing call (`bot-activity.js`, FSM wiring) is unaffected either way.
- **Phase 3 — tactical polish.** Cover-seeking, peek/lean, difficulty tuning, squad
  coordination (multiple bots sharing target info) — design later, not blocked on Phase 1/2.

## Open questions
- Spawn/despawn authoring: hand-placed in the map (like shoot-house spawn points) or
  round-based spawner? Affects whether `botPlayers` entries are static or pooled.
- Does a bot "count" toward existing player-count-gated logic (e.g. round win conditions,
  scoreboards) or is it explicitly excluded? Needs a product decision before Phase 1 wiring.
