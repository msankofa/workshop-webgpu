# `bot-viewer.html` — the original/golden combat-bot harness design

This documents how the standalone dev harness (`bot-viewer.html`) works, as the reference
implementation the port into `environment-viewer.html` was supposed to preserve. All citations are
`file:line` against the current tree (branch `sp1-webgpu-renderer-migration`).

## 1. Bootstrap

`bot-viewer.html` is a single `<script type="module">`, no build step, opened directly (it needs
no server, unlike `environment-viewer.html`).

- **Three.js pin**: `three@0.184.0` WebGPU build via importmap, same CDN pins as
  `environment-viewer.html`/`plant-viewer.html` (`bot-viewer.html:17-25`). `three-mesh-bvh@0.9.0`
  is also pinned (used indirectly through `map-collision.js`).
- **Renderer**: `THREE.WebGPURenderer({ antialias: true })`, `renderer.shadowMap.enabled = true`
  with `PCFSoftShadowMap`, `await renderer.init()` before anything else runs (`:44-50`). WebGPU,
  not WebGL — matches `environment-viewer.html`'s backend.
  Frame submission is `await postFX.renderAsync()` at the end of the animation loop (`:1991`), not
  a bare `renderer.render(scene, camera)`.
- **Scene/camera**: a bare `THREE.Scene` with a flat background color (`:52-53`); a
  `THREE.PerspectiveCamera(55, aspect, 0.05, 200)` starting at `(8, 9, 8)` (`:55-56`), driven by
  `OrbitControls` with damping (`:58-62`). The camera is a *dev/orbit* camera only — bots never
  read from it for aim; the camera's basis is reused only to compute WASD movement for the
  human-controlled **dummy** target (`:741-744`, see §2).
- **Lighting**: `createLightingRig({ scene, ui: false, elevation: 60, azimuth: 20 })` from
  `lights.js` (`:65-71`) plus one extra hand-placed `THREE.PointLight` (`overheadLight`,
  `:74-81`) "so the mannequin and its weapon read against the dark map."
- **Post-FX**: `createPostFX({ renderer, scene, camera, params: {...} })` from `post-fx.js`
  (`:84`), with a small `applySceneLook()` helper that live-tunes brightness/saturation/bloom from
  panel sliders (`:86-95`, sliders at `:1746-1748`).
- **Statically imported modules** (all at top-level `import`, not lazy `await import()` — unlike
  `environment-viewer.html`'s mode-gated lazy loading): `GLTFLoader`, `weapon-pose-controller.js`,
  `OrbitControls`, `lights.js`, `map-collision.js`, `post-fx.js` (`:29-36`); then further down:
  `bot-entity.js`, `player-procedural-body.js` (`:127-128`), `bot-activity.js`, `combat.js`,
  `weapons.js`, `nav-grid.js` (`:758-764`). Nothing in this file is behind a mode flag — the whole
  harness is one linear script.
- **Animation loop**: `renderer.setAnimationLoop(async () => {...})` (`:1966-1992`). Timestep is
  **variable, not fixed** — `dt = Math.min(0.05, (now - lastT) / 1000)` (`:1968`), i.e. wall-clock
  delta clamped to a 50 ms ceiling to avoid huge single-step jumps after a tab stall, but no
  fixed-1/60s accumulator/substepping anywhere in this file. This is a real divergence from the
  original creature-viewer's documented "fixed-timestep (1/60 s)" `physicsStep` convention
  (`../CLAUDE.md`) — the bot harness never adopted that pattern.
- **Per-frame order** inside the loop (`:1970-1991`): `updateDummy(dt)` →
  `updateBotSentry(dt, now)` (FSM decision + movement command) → `updateBot(dt)` (physics step +
  render placement) → `updateDummyCombatVisual` → `updateDummyHitImpacts` → `updateTracers` →
  `updateBullets` → `updateNavPathLine` (debug overlay) → `updateBotRecoveryDebug` →
  `updateBotBehaviorDebug` → HUD text sync → `controls.update()` → `postFX.renderAsync()`.

## 2. Bot lifecycle — no manager, no array

There is **no `Bot` class and no bot array/manager**. The harness hardcodes exactly one bot and
one target ("dummy") as bare module-level `let` variables:

- `let bot = null;` (`:134`), `let dummy = null;` (`:627`).
- **Spawn**: `spawnBot()` (`:556-572`) calls `createBotEntity('bot-1', botSpawnPoint, { standHeight:
  1.8 })` from `bot-entity.js`, sets `bot.weapon`/`bot.tool`, builds a capsule mesh (`botMesh`) and
  a small facing cone (`facingMesh`), adds both directly to `scene`, then calls
  `syncBotVisualMode()` to optionally spin up the procedural body. `spawnDummy()` (`:640-654`) is
  the symmetric target-side spawn — it also goes through `createBotEntity`, but tags on
  `dummy.health`/`dummy.alive`/`dummy.hitFlashUntil` fields the bot itself never has.
- **Update**: `updateBot(dt)` (`:586-621`) — steps physics (`stepBotPhysics`), repositions
  `botMesh`/`facingMesh`, feeds the optional procedural body, updates the weapon mount, and colors
  the facing cone by current FSM state (`:614-620`, red=fire, tan=aim, blue=pursue, purple=flee,
  orange=seek, gray=patrol). `updateBotSentry(dt, now)` (`:1431-1515`, see §4) is the actual
  decision step and is called *before* `updateBot` each frame.
- **Death**: only the **dummy** can die in this harness — `applyDummyDamage` (`:682-701`) drops
  `dummy.health`, and at 0 sets `dummy.alive = false`, zeroes velocity, tips the mesh
  (`dummyMesh.rotation.z = Math.PI * 0.48`), recolors it, and clears all of the bot's
  target-tracking state (`lastKnownTarget`, `currentPath`, `botState` reset to `BOT_PATROL`). The
  **bot itself has no HP/death model at all** — `bot-activity.js`'s own header comment says so
  explicitly (`bot-activity.js:7-8`: "retreat (back off when hp01 is low) still isn't implemented
  — no bot HP model exists yet"). `removeBot()`/`removeDummy()` (`:573-584`, `:655-664`) tear down
  meshes/state on demand from the panel; `resetDummy()` (`:703-706`) is remove+respawn.
- **Map-change teardown**: `applyLayout(layout)` (`:961-992`) rebuilds the whole test map
  (rooms/maze), and as part of that unconditionally calls `removeBot()`/`removeDummy()` and resets
  every piece of FSM/path state (`:983-986`) — old coordinates are meaningless on a differently
  shaped map, so nothing is preserved across a layout swap.

## 3. Rendering approach

- **Bot mesh**: a plain `THREE.CapsuleGeometry(radius, straightHeight, 4, 8)` with a
  `MeshStandardMaterial` (`botMat`, orange `0xff7043`) (`:561-566`), added directly to `scene`
  (not a group). A small cone (`facingMesh`) is a separate mesh tracking yaw for at-a-glance state
  color (`:568-570`).
- **Dummy mesh**: same capsule-geometry approach, blue `0x42a5f5` material, plus ad hoc hit-impact
  spheres (`spawnDummyHitImpact`, `:673-680`) and an emissive hit-flash (`updateDummyCombatVisual`,
  `:722-731`).
- **Optional procedural body** (toggleable, off by default — `botProceduralBodyEnabled`): when on,
  `createBotProceduralBody()` (`:535-548`) builds a full `createProceduralPlayerBody` rig from
  `player-procedural-body.js`, hides the plain capsule mesh (`syncBotVisualMode`, `:550-554`), and
  drives it every frame from the bot's own physics state (`:591-609`) — position, velocity,
  onFloor, crouch/prone/run stance, height/radius derived from the capsule, **yaw converted with a
  `+ Math.PI` offset** (`:603`, same conversion documented in `bot-entity.js`'s `toWirePose`),
  aimPitch, weapon/tool. Movement-tuning sliders (`turnStiffness`, `bodyFollowRate`,
  `workspaceWidthScale`, `bobScale`, etc., `:145-154`, `:1876-1885`) live-adjust
  `botProceduralBody.turnCfg`/`movementTuning`.
- **Weapon mount**: `createBotWeaponMount(bodyRef)` (`:409-481`) is async — fetches
  `weapon-anchors.json` + `weapon-poses.json` once (`loadBotWeaponMountData`, `:371-379`), loads
  the weapon's GLB via `GLTFLoader`, normalizes its scale/orientation
  (`normalizeBotWeaponModel`, `:381-395`), bakes IK anchor points into world space
  (`bakeBotWeaponAnchors`, `:397-407`), and wires a `createWeaponPoseController` (from
  `weapon-pose-controller.js`) that drives the procedural body's arm IK to hold it, including a
  full reload keyframe sequence (`reloadSequence`, `:418-433`) with `detachMagazine`/
  `spawnFreshMagazine`/`insertMagazine`/`grabChargingHandle`/etc. events. `updateBotWeaponMount`
  (`:483-523`) repositions the weapon rig to the visual body's torso each frame and, while
  aiming, calls `alignMountedWeaponToPoint` (`:1552-1569`) to rotate the actual barrel onto the
  aim point around the rear-grip pivot (not just relying on the authored hold pose).
- **Shot visuals**: hand-rolled, not a shared "effect renderer" — `spawnTracer` (a fading
  `THREE.Line`, `:1616-1622`), `spawnBullet` (a small sphere mesh that travels along the resolved
  hit path over `BOT_BULLET_SPEED = 55` units/s, `:1623-1633`, animated in `updateBullets`,
  `:1636-1647`), and `spawnDummyHitImpact` (an expanding/fading sphere on a successful hit,
  `:673-680`, `:708-720`). None of this reuses `effect-renderer.js`.
- **Debug overlays**, all real `THREE.Object3D`s added straight to `scene`: LOS line
  (`losLine`, green/red by visibility, `:1423-1427`), nav-grid walkable-cell point cloud
  (`navPoints`, `:1663-1668`, toggle button `:1959-1961`), current path line (`navPathLine`,
  `:1683-1695`), muzzle-recovery path/visited-cells/marker (`botRecoveryDebug` group,
  `:790-808`), tactical-goal line/marker for pursue/flee/seek/patrol-reentry
  (`botBehaviorDebug`, `:811-818`), and the movement-debug rig (feet targets, workspace limits,
  turn-yaw arrows, body/support markers — `botMovementDebug`, `:157-278`).
- **Materials**: plain `MeshStandardMaterial`/`MeshBasicMaterial`/`LineBasicMaterial` throughout —
  no TSL/node-material usage in this file (TSL lives in `post-fx.js`/`lights.js` internals, not
  authored here).

## 4. Activity/AI system

### 4a. Pure decision core — `bot-activity.js` (THREE-free, Node-tested)

- **States**: `BOT_PATROL`, `BOT_SEEK`, `BOT_PURSUE`, `BOT_FLEE`, `BOT_AIM`, `BOT_FIRE`
  (`bot-activity.js:10-15`) — **six** states, not four.
- **`chooseBotState({ current, ctx })`** (`:28-38`) is a pure deterministic function (no
  randomness, unlike `creature-activity.js`'s weighted picker): given `targetVisible`,
  `aimError`, `readyToFire`, `hasLastKnown`, `targetDistance`, `pursueDistance`, `fleeDistance`,
  it returns exactly one state. Priority when visible: flee (too close) > pursue (too far) > aim
  (visible but not on-target) > fire (on-target and cooldown-ready) else stay aimed. When not
  visible: seek (if a last-known position exists) else patrol.
- **`aimAnglesTo(from, to)`** (`:44-48`) — yaw = `atan2(dx, dz)` (0 = **+Z**-forward, *not* the
  camera/quaternion convention of 0 = -Z), pitch = `atan2(dy, horiz)`.
- **`aimError`/`slewAngle`** (`:70-81`) — shortest-path angular error and a turn-rate-capped slew,
  `TURN_RATE_RAD_S = 4.5` (full 180° turn in ~0.7s, `:19`).
- **`trackStuck`** (`:55-59`) — pure stuck-latch helper, `STUCK_MIN_SPEED = 0.15` m/s.
- `SENSE_RANGE = 25` m (`:17`), `AIM_TOLERANCE_RAD = 0.03` (~1.7°, `:18`).
- This module owns **no** clock, no cooldown state, no position memory — every one of those is
  the caller's job (documented explicitly at `:24-27`).

### 4b. Harness-side wiring — `updateBotSentry` (`bot-viewer.html:1431-1515`)

This is the per-frame glue the FSM assumes exists. Each frame, for the single bot vs. the single
dummy:

1. `updateBotReload(now)` (`:322-337`) — local reload timer, unconditional every frame, **no
   throttling**.
2. If the dummy is alive: computes bot-eye → dummy-eye distance and, if within `SENSE_RANGE`, does
   **one `mapCollider.raycast` line-of-sight test every single frame, no cadence throttle**
   (`:1451-1455`) — unlike the later `environment-viewer.html` port, which had to add a 120ms
   throttle (`bots.md` "LOS check throttled" section) because doing this per bot × per candidate
   became expensive at scale. The harness never needed that because it is always exactly 1 vs 1.
3. On visible: updates `lastKnownTarget`/`lastKnownTargetMotion` (dummy's own velocity direction,
   `:1461-1464`), computes `aimAnglesTo`, stores `botAimTarget`/`botAimPoint`, and `aimError`.
4. Muzzle-recovery check (`:1477-1483`, see §4d) can pre-empt everything else and short-circuit to
   a synthetic `'reposition'` pseudo-state.
5. Ammo/cooldown gate: `readyToFire = visible && botReloadUntil == null && ammo.mag > 0 &&
   (now - lastShotAt >= currentBotWeapon().fireIntervalMs)` (`:1486`) — **no notice-time delay and
   no accuracy jitter** in the harness (both of those were added later, only in the
   `environment-viewer.html` port per `bots.md`'s "Notice time and accuracy" section — this is a
   genuine behavior difference between harness and port, not just a bug).
6. `chooseBotState(...)` is called with that context; the returned state dispatches to one of:
   - `BOT_AIM`/`BOT_FIRE`: zero velocity, clear path state, `faceAimDirection` slews yaw/pitch,
     `BOT_FIRE` calls `fireBotShot`.
   - `BOT_PURSUE`: `updatePursuitMovement` (`:1347-1359`) — paths to a standoff point
     `preferredCombatDistance` (5m) from the dummy via `standoffGoalFromTarget`.
   - `BOT_FLEE`: `updateFleeMovement` (`:1385-1397`) — searches outward nav-grid rings
     (`findFleeGoal`, `:1361-1383`) for the walkable cell that maximizes distance from the threat
     minus path cost, and moves at `currentBotMoveSpeed() * 1.12`.
   - `BOT_SEEK`: `updateSeekMovement` (`:1308-1330`) — a **staged "search episode"** system, richer
     than a simple last-known-position beeline: `beginSearchEpisode` captures the dummy's last
     visible motion direction; `searchStagePoint` projects further and further along that
     direction (`lostSightStepDistance` per stage, up to `lostSightFollowSteps` stages, both panel
     sliders `:1904-1905`) each time a stage's goal is reached, before giving up
     (`finishSearchEpisode`). This is materially more elaborate than the "SEEK decays via
     `botSeekTenacitySec`" behavior `bots.md` describes for the port.
   - else `BOT_PATROL`: `updatePatrolMovement` (`:1206-1234`) walks a fixed `patrolPoints` loop, but
     with a **patrol re-entry system** (`choosePatrolResumeGoal`, `:1235-1261`) that, when a
     search episode ends, scores every patrol point by path distance minus alignment with the
     bot's last travel heading, and prefers *not reversing direction* — also not mentioned in
     `bots.md`'s description of the ported patrol behavior.
7. Facing: `faceAimDirection` (combat states) vs. `faceMovement`/`faceTargetXZ` (movement states)
   — separate yaw drivers depending on FSM state (`:1402-1421`).

### 4c. Pathfinding — `nav-grid.js` (THREE-free, Node-tested) + harness glue

- `buildNavGrid(walkableTest, bounds, cellSize)` (`nav-grid.js:9-22`) samples a boolean walkable
  grid once. The harness's `walkableTest` is `navWalkable` (`bot-viewer.html:842-845`), itself
  `pointInWall` (`:836-841`) — a **hand-authored rectangle test against `activeWalls`**, not any
  raycast/BVH query. This only works because the harness's maps are synthetic (rooms/maze) with
  wall data known at authoring time — explicitly called out as "the same 'authoring-time data'
  shortcut the real shoot-house map would use too" (`:832-834`). This is a **static, one-shot,
  whole-map bake** (`NAV_CELL = 0.5`, `:834`) — there is no local-window fallback in the harness,
  because its maps are always small enough to bake wholesale. (The port later needed a
  local-window variant purely because open/authored terrain maps are 1200-4000m across —
  see `bots.md`.)
- `findPath`/`smoothPath` (`nav-grid.js:62-146`) — 8-connected A* with no corner-cutting, then
  greedy string-pulling. `requestPath` (`bot-viewer.html:1036-1040`) wraps `findPath`+`smoothPath`
  and drops the entity's own current cell.
- `followPath` (`:1021-1035`) pops waypoints and steers `entity.velocity` toward the next one;
  used for patrol/seek/pursue/flee/muzzle-recovery movement alike.

### 4d. Muzzle-recovery — harness-only tactical repositioning (no `bots.md` mention at all)

`beginMuzzleRecovery`/`findMuzzleRecoveryCell`/`updateMuzzleRecoveryMovement`
(`:1043-1153`) track a rolling streak of shots that hit world/terrain instead of the player
(`recordBotShotResult`, `:1140-1153`); after `BOT_BLOCKED_SHOT_THRESHOLD` (2) consecutive blocked
shots, the bot searches outward nav-grid rings for the nearest reachable cell with a *clear muzzle
line* to the target (`hasClearMuzzleShot`, using the actual mounted-weapon muzzle origin, not the
capsule eye point, `:1050-1066`) and repositions there before resuming combat. This entire system
— a real "bot repositions when its shot keeps hitting cover" behavior — has **no corresponding
mention anywhere in `docs/subsystems/bots.md`**'s account of the `environment-viewer.html` port,
which is a strong candidate for something the port simply dropped.

### 4e. Combat resolution and ammo

- `fireBotShot(origin, now, aim)` (`:1577-1614`) decrements `ammo.mag`, resolves the shot via
  `combat.js`'s shared `resolveHitscan` (`combat.js:172-`), passing only the dummy as the single
  `players` entry (no `creatures`/`mobs`/`obstacles` lists — the harness map has no forest/rocks),
  `occluder: (o,d,range) => mapCollider.raycast(o,d,range)`, and `heightAt: () => -1e6` (i.e.
  "never hit terrain," since this harness has no terrain, only walls/floor).
- Ammo is **entirely local**: `bot.ammoByWeapon` is a `Map` keyed by weapon id
  (`ensureBotAmmo`, `:300-309`), refilled by `reloadBotWeapon`/`updateBotReload`
  (`:310-337`) using either the authored weapon reload-sequence duration or a
  `BOT_RELOAD_FALLBACK_MS = 1800` default. `bots.md` explicitly flags this as "Harness-local: no
  ammo/applyCombatIntent pipeline yet" (`bots.md` "Ammo/reload" section) — the harness never used
  the shared `applyCombatIntent`/`playerCombat` pipeline the port had to build.
- **Accuracy/notice-time**: none. The harness fires the instant `aimError` clears tolerance and
  cooldown is ready — perfectly accurate, zero reaction delay. (Both were added only in the port,
  per `bots.md`.)

### 4f. Per-frame budget

There is **no per-bot budget or amortization anywhere in this file** — no cadence throttling, no
spreading work across frames, no cache. Every check (LOS raycast, muzzle-recovery ring search,
flee/pursue path replanning) runs unconditionally, every frame, because the harness only ever
simulates one bot against one target. This is the single biggest structural fact a port must
compensate for: **nothing in the harness's design demonstrates or validates multi-bot performance
budgeting** — that had to be invented from scratch during the port (see `bots.md`'s "LOS check
throttled" pass).

## 5. Explicit list of ambient/global dependencies a bot implicitly relies on

Everything below is state the FSM/movement/render code reads from module scope, not something
passed cleanly through one context object. A port must re-supply each of these, and get its
semantics (not just its existence) right:

| Dependency | Harness source | Read by | Notes |
|---|---|---|---|
| `scene` (global `THREE.Scene`) | `bot-viewer.html:52` | mesh creation for bot/dummy/facing cone/weapon rig/debug overlays/tracers/bullets/impacts | Everything is `scene.add()`'d directly, not grouped under a bot-owned `Object3D`. |
| `camera` | `:55` | `updateDummy`'s WASD basis only (`:741-744`) | The bot's own aim math never touches the camera — only the human-controlled dummy target does. A port with no orbit camera (host FPS camera instead) must not assume bots read `camera` for anything. |
| `mapCollider` (BVH collider over `mapRoot`, from `map-collision.js`'s `createMapCollider`) | rebuilt per layout at `:979` | `stepBotPhysics` (floor/wall resolve), LOS raycast (`:1453`), muzzle-recovery `hasClearMuzzleShot` (`:1065`), `resolveHitscan`'s `occluder` (`:1601`) | **Global mutable `let mapCollider`**, torn down/rebuilt wholesale on layout change (`:966,979`). `stepBotPhysics` has a documented optional `heightAt(x,z)` fallback for maps with no collider (`bot-entity.js:38-58`) — the harness itself never exercises that fallback path (it always has a `mapCollider`); it exists only for the port's benefit onto open procedural terrain. |
| `navGrid` (global mutable, from `nav-grid.js`'s `buildNavGrid`) | rebuilt per layout at `:980` via `navWalkable`/`pointInWall` closures over `activeWalls`/`activeBounds` | every movement function (`requestPath`, `findFleeGoal`, `findMuzzleRecoveryCell`, `findClosestReachableGoal`) | Whole-map static bake; walkability comes from hand-authored rectangle data, **not** a BVH/mesh query — a port onto real/organic geometry cannot reuse this walkability test verbatim (this is exactly the gap `bots.md`'s 2026-07-18 entry documents was later solved with `botMeshBlockedAt`). |
| Fixed-timestep clock / `dt` | `renderer.setAnimationLoop`'s `now`, clamped `dt` (`:1967-1969`) | everything | Variable timestep, clamped to 50ms — **not** a true fixed 1/60s physics step. A port assuming a fixed timestep (as the legacy creature-viewer's documented convention does) is assuming something the bot harness never actually guaranteed. |
| Weapon registry (`weapons.js`'s `getWeapon`) | import at `:763` | `currentBotWeapon()` (`:280-282`), ammo defaults, `fireBotShot`'s range/damage, weapon-mount GLTF path/hold offsets/recoil | Only 5 weapon ids are exposed in this harness (`BOT_VIEWER_WEAPON_IDS`, `:140`), a curated subset of the game's full weapon list, and there's no `enabledWeapons().filter(mode === 'hitscan')` restriction here the way `bots.md` says the port applies — the harness lets you cycle through `rpg` too even though it's not a hitscan weapon in the same sense. |
| Combat resolver (`combat.js`'s `resolveHitscan`) | import at `:762` | `fireBotShot` | Pure function, but the harness always calls it with exactly one candidate (`dummy`) in `players` and nothing in `creatures`/`mobs`/`obstacles` — a port with many simultaneous bots/players/trees/rocks must build those lists itself; nothing about the harness call site demonstrates how to do that at scale. |
| No shared "effect renderer" | — | tracers/bullets/impacts are hand-rolled in this file (`spawnTracer`, `spawnBullet`, `spawnDummyHitImpact`) | If the port assumes bots plug into a shared `effect-renderer.js`, that's new plumbing invented for the port, not something demonstrated by the harness. |
| No shared ammo/combat-intent pipeline | — | `ensureBotAmmo`/`reloadBotWeapon` are fully local Maps/timers | `applyCombatIntent`/`playerCombat` (used by the port per `bots.md`) do not exist in this file at all. |
| "Player" reference | — | there is no player at all — the harness's stand-in is the WASD-controlled **dummy**, itself a `createBotEntity` instance with bolted-on `health`/`alive` fields | A port's real player (with a real camera, real `playerCollider`, real HP via `playerCombat`) is structurally different from anything the harness ever exercised against. |
| `weapon-anchors.json` / `weapon-poses.json` | fetched directly via `fetch()`, cached in a module-level promise (`loadBotWeaponMountData`, `:371-379`) | weapon mount IK baking | Same files the game's real weapon system uses, but fetched independently here — no shared loader/cache with any other module. |
| `terrainHeight` | hardcoded `() => 0` (`:540`) | `createProceduralPlayerBody`'s optional procedural-body visual rig | The harness has **no terrain at all** (only flat floor + walls) — this stub is a flat-earth assumption a port onto real terrain must replace with the real height field, and nothing in the harness proves that swap works. |
| Panel-tunable behavior params | module-level objects (`botBehaviorSettings`, `botMovementSettings`), mutated live by `<input type=range>` listeners | movement/pursuit/flee/patrol-reentry math | These are **not** persisted anywhere (no localStorage), reset to hardcoded defaults on page load; a port that expects these to come from a config file/panel elsewhere must reintroduce them explicitly — none of the six behavior sliders bots.md's port lists (`botMaxHp`, `botMoveSpeed`, `botSightRange`, `botSeekTenacitySec`, `botNoticeTimeSec`, `botAccuracy`) match this harness's own tuning knobs (`pursueDistance`, `preferredCombatDistance`, `fleeDistance`, `fleeSearchRadius`, `lostSightFollowSteps`, `lostSightStepDistance`) one-for-one. |

## 6. Coordinate space, scale, up-axis, units

- **Y-up**, meters throughout (`WALL_H = 3`, `WALL_T = 0.3`, `SENSE_RANGE = 25`,
  `DEFAULT_STAND_HEIGHT = 1.8`, `DEFAULT_RADIUS = 0.3` — `bot-entity.js:7-9`).
- **Capsule ground-contact convention**: `spawnPos.y` passed to `createBotEntity` is the **floor
  height under the spawn point**, not the capsule center (`bot-entity.js:11-12`) — the comment
  there explicitly cross-references this as "same convention environment-viewer.html uses for
  `playerCollider` (:4780)," i.e. an intentional, documented cross-file contract a port must not
  silently violate.
- **Yaw convention split**: `bot.yaw` follows `bot-activity.js`'s `atan2(dx, dz)` convention where
  **0 = +Z-forward** (used by `aimAnglesTo`, `faceMovement`, `faceTargetXZ`, movement code
  throughout). The **wire/render quaternion convention** (matching `camera.rotation.y`, THREE's
  default camera looking down -Z) treats **0 = -Z-forward** — a fixed `+ Math.PI` offset apart.
  `toWirePose` (`bot-entity.js:69-76`) and the procedural-body feed
  (`bot-viewer.html:603`, `yaw: bot.yaw + Math.PI`) both apply this conversion explicitly; a port
  that copies `bot.yaw` straight into a render quaternion without the offset reintroduces exactly
  the "facing bug" `bots.md` documents was already found and fixed once in the port
  (`bots.md` lines 31-38).
- **Gravity** = `30` (units/s², `bot-entity.js:9`) — a bot-local constant, not read from any
  shared physics config; a port must confirm this matches (or intentionally differs from) whatever
  gravity constant the rest of the game uses.
- **Map scale is toy-sized**: the rooms layout spans roughly 12m × 6m (`bounds: {minX:-3,
  maxX:9, minZ:-3, maxZ:3}`, `bot-viewer.html:865`); the maze layout is `cols/rows` × `2.5m` cells
  (8×8 "Compact" up to 14×14 "Large", `:874-877`). Nothing in the harness's nav-grid or LOS code
  was ever exercised at the scale of real terrain maps (1200-4000m, per `bots.md`) — the
  local-window nav fallback the port needed for that is new territory, unvalidated by anything in
  this file.

## 7. Summary of harness-only behavior not reflected in `docs/subsystems/bots.md`'s port account

For traceability, these are concrete harness features found in `bot-viewer.html` that the current
`bots.md` write-up of the `environment-viewer.html` port does not mention at all:

- `BOT_PURSUE` and `BOT_FLEE` states (`bot-activity.js` exports six states; `bots.md` only
  describes "patrol/seek/aim/fire" being driven in the port).
- The muzzle-recovery repositioning system (§4d) — no mention anywhere in `bots.md`.
- The staged "search episode" SEEK behavior with directional projection
  (`lostSightFollowSteps`/`lostSightStepDistance`) — `bots.md` describes the port's SEEK as a
  simpler last-known-position-plus-tenacity-timer decay.
- The patrol re-entry heading-alignment scoring (`choosePatrolResumeGoal`).
- Crouch/prone/run stance toggles on the bot itself (`botStance`, `:135`, `:1764-1828`) — the port
  doc never mentions bot stance at all.
- Zero notice-time delay and zero accuracy jitter (both were later *added* only in the port, per
  `bots.md`'s third pass — meaning the harness's own default combat feel is snappier/more lethal
  than the port's tuned defaults, not something to match 1:1).
