# Creature Simulation Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#creature)

## Purpose

Drives the procedural creatures (body plans, gaits, IK limbs, behaviors, combat) inside the WebGPU
environment viewer. This is a port of the standalone `creature-viewer.html` app described in the
top-level `CLAUDE.md`: the same data model (body plan + gait + style descriptors), the same
`Creature` class with FABRIK-based `KinematicChain` IK for legs/arms, the same behavior set
(wander, direction, target, forage, combat, race) and combat state machine, now adapted to run
inside the larger terrain/forest/water environment scene with a WebGPU renderer instead of as a
standalone WebGL page.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `port-creature-bridge.js` | Wires the creature system into `environment-viewer.html`: builds/injects the floating toolbar + panel DOM/CSS, derives an arena size from the terrain system, forwards terrain/trunk callbacks into the simulation, handles pointer click/dblclick raycasting (select creature / set target point), and exposes a thin `update`/`reset`/`stats` wrapper (including an "off" mode that zeroes stats and hides creatures without simulating). | 524 |
| `port-creature-system.js` | The ported simulation itself: body plans, gaits, styles, seeded randomization, `KinematicChain` (FABRIK IK), `Creature` class (steering, physics, leg stepping, combat, foraging, rendering), `Grabbable` objects, spatial-grid collision/separation, LOD tiers, and an instanced-mesh batching layer for WebGPU rendering. | 4830 |

## Public API

`port-creature-system.js` has a single top-level export:

- `createPortCreatureSystem({ scene, terrainHeight, resolveTrunks, nearbyTrunks, terrainSettings, rebuildTerrain, camera, lod, getPlayerPose, damagePlayer })` — factory. The last two are optional callbacks (host/solo only) used by the player-interaction layer below. Returns an object with:
  - `update(dt)` — runs one full sim/render frame.
  - `resetCreatures()` — rebuilds the creature roster from current settings/config.
  - `clearRenderBatches()` — zeroes the instanced-mesh batches (used when creatures are hidden).
  - `spawnRandomObjects(count?)` — (re)spawns `Grabbable` pickup objects.
  - `selectFromRaycaster(raycaster)` — hit-tests creatures/instanced batches for picking.
  - `setTargetPoint(point)` — sets `simTarget` and switches behavior to `'target'`.
  - `setBehavior(b)` — sets the active behavior and syncs the toolbar `<select>`.
  - `setCreatureRole(creature, role)` — sets `creature.role` (`'wild'|'pet'|'hostile'`, invalid values fall back to `'wild'`).
  - `setPetCommand(creature, cmd, point?)` — makes a creature a pet and sets its active command (`'follow'|'stay'|'goto'|'attack'`); `point` (goto only) is cloned and its `y` snapped to `terrainHeight`.
  - `tameNearestToPlayer(maxDist = 6)` — converts the nearest `wild` creature within `maxDist` of the live player to a `follow` pet; returns the creature or `null` (no live player / nothing in range).
  - `commandAllPets(cmd, point?)` — applies `setPetCommand` to every current pet.
  - `untamePet(creature)` — reverts a pet to `wild`/`follow`/no target.
  - `aggroAllWild()` — sets every alive `wild` creature's role to `hostile`; returns the count aggroed. Dev/test trigger for F3 (no wildlife-density awareness yet — that's F4).
  - `calmAllHostile()` — reverts every `hostile` creature to `wild` and clears `combatTarget`/`punchArm`, resetting `attackState` to `'ready'` (skipped for a creature already `'dying'`).
  - `setWildlife(opts)` — shallow-merges validated `{enabled, target, ringMin, ringMax, cullRadius, hardMax}` fields into the wildlife spawner state (invalid/missing keys ignored, `ringMax`/`cullRadius` clamped to stay `>= ringMin`/`ringMax`); returns a shallow copy of the applied public fields.
  - `spawnCreatureAt(x, z, opts?)` — spawns one `ROLE_WILD` creature at `(x,z)` with a freshly randomized body/style; `opts.wildlife` (bool) tags it as spawner-managed. Returns the new `Creature`.
  - `despawnCreature(creature)` — removes and disposes a single creature (mirrors `removeDeadCreatures`'s splice/dispose pattern); returns `false` if the creature isn't in the roster.
  - getters: `stats`, `creatures`, `pets` (creatures with `role === 'pet'`), `playerThreats` (count of `hostile` creatures with `isCombatActive()`), `reflectionMeshes`, `currentBehavior`, `wildlife` (shallow copy of the spawner's public state), `wildlifeCount` (count of spawner-managed wild creatures currently alive).

  (Everything else — `Creature`, `KinematicChain`, `BODY_PLANS`, `GAITS`, `Grabbable`,
  `SpatialGrid`, the instanced batch helper `createCreaturePartBatches`, etc. — is internal/module-scoped,
  not exported; identified via a strategic skim, not a full line-by-line read of all 4830 lines.)

`port-creature-bridge.js` exports one factory:

- `createEnvironmentPortCreatures({ scene, renderer, camera, ground, terrain, terrainSystem, terrainHeight, resolveTrunks, nearbyTrunks, rebuildWorld, isInteractionEnabled, mode })` — returns `{ update(dt), reset(), stats (getter), system }`, where `system` is the object returned by `createPortCreatureSystem`.

## Wiring

In `environment-viewer.html`:

- Static import: `import { createEnvironmentPortCreatures } from './port-creature-bridge.js';` (line 44).
- Construction (line ~351): `const portCreatures = createEnvironmentPortCreatures({ scene, renderer, camera, ground: () => ground, terrain, terrainSystem, terrainHeight, resolveTrunks: (px, pz, r) => trunkIndex.resolve(px, pz, r), nearbyTrunks: (px, pz) => trunkIndex.nearby(px, pz), rebuildWorld, isInteractionEnabled: () => !fpsMode, mode: CREATURE_MODE })`, where `CREATURE_MODE` comes from the `?creatures=` URL param (default `'on'`) and `trunkIndex` is a `createTrunkIndex(...)` from `collision.js`.
- Per-frame call: `frameProfiler.time('creatures', () => portCreatures.update(rawDt));` (line ~2804), profiled under the `'creatures'` pass alongside terrain/water/etc.
- Terrain height: the bridge passes the scene's real `terrainHeight` function straight through to the sim, so creature ground contact follows the actual procedural terrain (not a separate height function). It also derives a synthetic `creatureTerrain` settings object (amplitude/lake/waterLevel/arena size) from the live `terrain`/`terrainSystem` params for the sim's internal "rebuild terrain" UI action, which on rebuild copies values back into the real `terrain` object and calls `rebuildWorld()`.
- Tree collision: `resolveTrunks`/`nearbyTrunks` are forwarded from `trunkIndex` (in `collision.js`) so creatures can avoid/steer around tree trunks; this is separate from the `map-collision.js` `createMapCollider`, which (per a grep of the file) is not referenced by the creature wiring — it appears to serve other movement/collision (e.g. player/vehicle), not creatures.
- Picking/interaction: pointerdown/click/dblclick listeners on `renderer.domElement` call `system.selectFromRaycaster` (single click, gated by `isInteractionEnabled()`/`!fpsMode`) and `system.setTargetPoint` (double-click against the `ground()` mesh) for the `target` behavior.
- Stats are read directly off `portCreatures.stats` for the on-screen terrain/perf debug HUD and the frame-profiler snapshot (`creatureVisible`, `creatures`, `creatureRendered`, etc.).

## Player interaction: roles, follow mode, pet commands

Pure decision math lives in `creature-interaction.js` (THREE-free, unit-tested in
`test-creature-interaction.mjs`), imported by `port-creature-system.js`. `update(dt)` refreshes a
module-scoped player snapshot (`_playerPos`/`_playerAlive`/`hasLivePlayer()`) each frame from the
injected `getPlayerPose()`; role/pet code reads that snapshot rather than calling `getPlayerPose()`
on hot loops. Host/solo only — guests run `mode:'network'` and never touch this layer.

- **Global `follow` mode**: a new `Mode` option (`follow`, "Follow Me") in `port-creature-bridge.js`'s
  toolbar. In `Creature.computeSteering`, the `'follow'` branch uses `followDesire(...)` (stops
  inside a `standoff` ring around the player; `spreadAngle` fans grouped followers out so they don't
  stack) when `hasLivePlayer()`, else falls back to the same roam-to-`roamTarget` logic as the
  default `wander` branch (so followers don't freeze with no player). Each `Creature` gets a stable
  `_followPhase` (random angle set once in the constructor) used both as the fan-out `spreadAngle`
  and to vary `standoff` (~2.2-3.0 m) per creature.
- **Per-creature role, orthogonal to the global behavior**: `creature.role` (`ROLE_WILD` default,
  `ROLE_PET`, `ROLE_HOSTILE`) and `petCommand`
  (`CMD_FOLLOW` default, `CMD_STAY`, `CMD_GOTO`, `CMD_ATTACK`) + `petTarget` (a `THREE.Vector3` or
  `null`). In the `update()` roster loop, a pet's `steerBehavior`/`steerTarget` are derived from its
  own `petCommand` **before** the global `currentBehavior` is consulted, so a tamed pet keeps
  following even while the toolbar Mode is `wander`/`stay`/anything else: `CMD_FOLLOW` → behavior
  `'follow'`, `CMD_STAY` → `'stay'`, `CMD_GOTO` → `'target'` with `c.petTarget` as the target point
  (reuses the existing `'target'` stop-distance logic, so the pet naturally holds position once it
  arrives). `CMD_ATTACK` is out of scope for F2 and is currently treated as `CMD_FOLLOW` (marked
  `// TODO(F3): pet attack` at the call site) — a later workstream adds pet-vs-hostile combat.
- **Public API** (see above): `setPetCommand`, `tameNearestToPlayer`, `commandAllPets`, `untamePet`,
  `pets` getter.
- **Keybinds** in `environment-viewer.html` (host/solo only, guarded on `mpRole !== 'guest'` and
  `portCreatures?.system`): `T` tames the nearest wild creature within 6 m of the player
  (`tameNearestToPlayer()`); `G` raycasts the camera-forward ray against the terrain (reuses the
  light-gun's `lgRaycastTerrain()` march-against-`terrainHeight` helper) and sends every pet there
  (`commandAllPets(CMD_GOTO, hit)`); `Y` toggles all pets between `CMD_FOLLOW` and `CMD_STAY`; `K`
  toggles hostiles — if `playerThreats > 0` it calls `calmAllHostile()`, else `aggroAllWild()`
  (both console.log a one-line result; dev/test trigger until F4 wires a wildlife-driven spawner).
  (`H` was already bound to the GUI-hide toggle, so the follow/stay toggle uses `Y` instead of the
  design doc's suggested `H`.) `CMD_FOLLOW`/`CMD_STAY`/`CMD_GOTO` are imported directly from
  `creature-interaction.js` into `environment-viewer.html`.

### Hostile creatures attacking the player (F3)

`ROLE_HOSTILE` creatures approach the player, melee-attack, and deal damage through the injected
`damagePlayer` callback — reusing the existing team-vs-team punch/IK pipeline unchanged rather than
building a parallel one.

- **Steering**: `computeSteering`'s `'hostile'` branch calls `hostileDesire(this.pos.x, this.pos.z,
  _playerPos.x, _playerPos.z, this.attackRange(), this.isWeak(), _hostileOut)` when `hasLivePlayer()`
  — approaches until `attackRange()`, then flees directly away when `isWeak()` (same weak-health
  threshold as team combat). No live player falls back to the same roam-to-`roamTarget` logic as
  `follow`/default, so hostiles don't freeze.
- **Player proxy** (`port-creature-system.js`, module scope, declared right after `hasLivePlayer()`):
  `_playerProxy` duck-types as a `Creature` combat target — `pos` (aliases the live `_playerPos`
  Vector3), `isCombatActive()`, `bodyContactToward(fromWorld, pad)` (surface point on the player
  capsule, using a reusable `_proxyContact` scratch Vector3 — no per-hit allocation),
  `localPointInBody(worldPoint, pad)` (delegates to `meleeHitsPlayer` from `creature-interaction.js`),
  and `takeDamage(_amount, _attacker)` (ignores both args and calls `damagePlayer(HOSTILE_PLAYER_DAMAGE,
  _playerProxy.pos)`). Because every downstream combat method (`choosePunchArm`, `enemyTarget`
  override below, `sweptHandHitsBody`, the windup/recover state machine, the render damage gate) only
  ever calls methods on `target`/`this.combatTarget`, the proxy is a complete drop-in and none of that
  code needed to change beyond the gates below. `HOSTILE_PLAYER_DAMAGE = 7` (tunable constant next to
  the proxy) is the flat per-hit damage; it does not scale with `ATTACK_DAMAGE` (the creature-vs-creature
  constant), since the proxy's `takeDamage` ignores the `amount` argument passed to it.
- **Targeting**: in `updateCombat`, target selection is `this.role === ROLE_HOSTILE ? (hasLivePlayer()
  ? _playerProxy : null) : this.enemyTarget(all)` — everything else in the state machine (windup/recover
  timers, `attackCooldown`, `isWeak()` abort back to `'ready'`) is unchanged.
- **Always-active combat**: the roster loop's `updateCombat` active flag is `(currentBehavior ===
  'combat' && c.role !== ROLE_PET) || c.role === ROLE_HOSTILE` — hostiles run their attack state
  machine regardless of the global Mode dropdown, since their target is the player, not another team.
- **Relaxed gates**: three `currentBehavior === 'combat'` checks tied to `this.punchArm === arm` are
  widened to `(currentBehavior === 'combat' || this.role === ROLE_HOSTILE)` so a hostile's punch
  animates and lands identically to a team-combat punch: the `updateArmState` windup/recover pose gate,
  the `renderArms` `snapState` gate (arm snaps straight to the strike pose instead of lerping — without
  this a hostile's punch looks sluggish), and the `renderArms` damage-application gate (which calls
  `this.combatTarget.takeDamage(ATTACK_DAMAGE, this)` — routed to the proxy's `takeDamage`, so the
  `ATTACK_DAMAGE` argument is passed but discarded in favor of `HOSTILE_PLAYER_DAMAGE`).
- **Healing-forage interaction**: `wantsHealingForage()`'s early-return in `updateCombat` is unaffected
  because the roster loop only ever assigns `c.healingTarget` inside `if (currentBehavior === 'forage'
  || currentBehavior === 'combat')` — a hostile creature under the (typical) `wander`/other global Mode
  never gets a `healingTarget`, so it always proceeds to attack when healthy. If the global Mode happens
  to be `combat` *and* a hostile creature wants healing, it will still break off to forage (same as any
  other creature) while its steering stays `'hostile'` — an edge case left as-is, matching how
  `ROLE_WILD` creatures already behave in team combat.
- **Public API / keybind**: `aggroAllWild()`, `calmAllHostile()`, `playerThreats` getter (see above);
  `K` key toggles between them (see Keybinds above).

### Ambient wildlife spawning (F4)

Keeps roughly `target` `ROLE_WILD` creatures roaming around the player at all times, spawning them
on a ring and culling ones that wander too far, so the world feels populated without the roster
growing unbounded.

- **State**: module-scoped `_wildlife = { enabled, target, ringMin, ringMax, cullRadius, hardMax,
  interval, _timer, _seq }` (near the other scene state, right after `directionYaw`). `enabled`
  defaults `false` (opt-in via the `J` key or `setWildlife`); `target` is the desired steady-state
  count of spawner-managed wild creatures near the player; `ringMin`/`ringMax` bound the spawn
  annulus (world units from the player); `cullRadius` is the distance beyond which a spawner-managed
  creature despawns; `hardMax` is an absolute cap on total roster size (`creatures.length`) that
  spawning never exceeds, regardless of deficit; `interval` throttles how often the spawn plan runs
  (seconds); `_timer` accumulates `dt`; `_seq` is a monotonically increasing seed index so every
  wildlife spawn gets a fresh, distinct randomized body/style instead of repeating.
- **Throttled planner** (`update()`, right after `refreshPlayerSnapshot()`, before the LOD pass):
  only runs when `_wildlife.enabled && hasLivePlayer()`. Accumulates `_wildlife._timer += dt`; once
  it crosses `interval` (reset to 0), builds an `existing` array of `{id: creature, x, z}` for every
  creature with `c._wildlife && c.role === ROLE_WILD` — **only spawner-tagged, still-wild creatures
  are managed**; a tamed pet, a hostile, or a hand-placed roster creature (even if role happens to be
  `wild`) is never touched — then calls `wildlifeSpawnPlan({ playerX, playerZ, existing, target,
  ringMin, ringMax, cullRadius, rand: Math.random, maxSpawnPerCall: 2 })` from `creature-interaction.js`.
  Every `id` in `despawnIds` is passed to `despawnCreature`; every `{x,z}` in `spawns` is passed to
  `spawnCreatureAt(x, z, { wildlife: true })`, but only while `creatures.length < hardMax`, so the
  hard cap always wins even if the plan wants to spawn more. The `existing` array (and the plan call)
  only allocate inside this throttled block, never per frame.
- **Spawn/despawn helpers** (module scope, next to `removeDeadCreatures`):
  - `spawnCreatureAt(x, z, opts = {})` — builds a config via `variedCreatureConfig(_wildlife._seq++,
    Math.max(4, _wildlife.target))` (reusing the roster's own diverse-body randomizer), overrides
    `config.spawn = [x, 0, z]` (`createCreatureFromConfig` recomputes `y` from `terrainHeight`),
    creates the `Creature`, sets `role = ROLE_WILD` and `_wildlife = !!opts.wildlife`, pushes it onto
    `creatures`, and returns it.
  - `despawnCreature(creature)` — finds the creature's index in `creatures`; returns `false` if not
    present; otherwise mirrors `removeDeadCreatures`'s per-entry pattern (`selectCreature(null)` if it
    was selected, `splice`, `dispose()`) and returns `true`. No manual spatial-grid removal needed —
    `creatureGrid` is fully cleared and rebuilt from `creatures` every frame in `update()`.
- **Wildlife roams regardless of global Mode**: in the roster loop's per-creature role branch (after
  the `ROLE_PET`/`ROLE_HOSTILE` cases, before the default global-behavior fallback), `c.role ===
  ROLE_WILD && c._wildlife` forces `steerBehavior = 'wander'` — so spawner-managed wildlife always
  roams even when the toolbar Mode is `stay`/`target`/anything else, instead of freezing like
  ordinary roster creatures under those modes. Non-wildlife `ROLE_WILD` creatures (the normal roster)
  are unaffected and keep following the global Mode exactly as before.
- **Public API / keybind**: `setWildlife`, `spawnCreatureAt`, `despawnCreature`, `wildlife`/
  `wildlifeCount` getters (see above); `J` toggles `enabled` (`setWildlife({ enabled: !wildlife.enabled
  })`, console.logs the new state) in the same host/solo-only keybind block as `T`/`G`/`Y`/`K`.

### Creatures HUD (F5, discoverability)

`environment-viewer.html` builds a compact fixed panel `#creature-command-hud` (bottom-right,
host/solo only, `pointer-events:none`) right after the `portCreatures` construction, exposing
`updateCreatureCommandHud(nowMs)` (default no-op on guests). `animate()` calls it after
`updateCombatHud()`; it refreshes ~4 Hz from the system getters (`pets.length`, `playerThreats`,
`wildlife.enabled`, `wildlifeCount`) and shows the keybind legend (`T` tame · `G` go-to · `Y`
follow/stay · `K` aggro/calm · `J` wildlife). No sim coupling — pure read-only status.

## Architecture notes

Preserved from the original `creature-viewer.html` (per top-level `CLAUDE.md`):
- The body-plan/gait/style descriptor model (`BODY_PLANS`, `GAITS`, style objects), `pair()`/`finalizePlan()`/`editPlanWithSettings()`/`armSpecsForPlan()` construction pipeline.
- `KinematicChain` FABRIK solver (`port-creature-system.js:642`) for leg/arm IK, including pole-vector elbow/knee bias.
- The `Creature` class (`port-creature-system.js:1359`) with the same per-frame pipeline described in the top-level docs: combat → eating → forage state → steering → fixed-timestep physics/leg-stepping → collision resolution → render.
- The same behavior set (wander/direction/target/forage/combat/race) and combat state machine, `Grabbable` object interaction (reserve/grab/carry/stow), and JSON export/import of full scene config.
- Seeded randomization (`seededRandom`, `RANDOM_GROUPS`-style `numParam`/`gaitParam`/`spreadParam`/`countParam` helpers) and the toolbar/options/model/inspector panel UI, now built dynamically into DOM injected by `ensurePortCreatureUi()` rather than living in the original page's static HTML.

WebGPU/integration-specific adaptations identified:
- **Instanced batch rendering**: `createCreaturePartBatches()` (`port-creature-system.js:805`) replaces (or supplements) per-creature meshes with shared `THREE.InstancedMesh` buckets (`shellBox`, `plateBox`, `trimBox`, `lightBox`, `footBox`, `jointSphere`, `limbSegment`, `shadowBox`) of capacity 8192, populated per-frame via `beginFrame()`/`add*()`/`endFrame()` and used for both rendering and raycaster picking (`ownerForHit`). Toggleable via `?creatureInstancing=` URL param (`'parts'` default, `'off'` falls back to non-instanced — not verified by full read which path that fallback takes).
- **LOD system**: `creaturePerf` distance/stride tuning (`detailDistance`, `bodyOnlyDistance`, `hideDistance`, `fullUpdateStride`, `bodyUpdateStride`, `farUpdateStride`, `ikDistance`, `shadowDistance`) gates simulation/IK/shadow cost by camera distance, tracked per-creature as `lodShouldSim`/`lodVisible`/`lodDebugActive`/`lodArmsActive` flags — not present in the original standalone viewer's CLAUDE.md description.
- **Perf instrumentation**: a `creatureStats`/`stats` object tracks per-stage timings (`lodMs`, `objectsMs`, `behaviorMs`, `steeringMs`, `physicsMs`, `renderMs`, `selectionMs`, `updateMs`) and counts (visible/sim/rendered/bodyOnly/armsActive/shadowCasters/ikFull/ikCheap/instanced* /tiers), consumed by `environment-viewer.html`'s debug HUD and `frame-profiler.js`.
- **External terrain/forest hookup**: `terrainHeight`, `resolveTrunks`, `nearbyTrunks` are injected dependencies from the shared environment systems (`terrain-system.js`, `collision.js`) rather than the standalone app's own closed-form terrain function.
- **Mode toggle**: `port-creature-bridge.js`'s `update(dt)` supports a `mode: 'off'` short-circuit that hides all creature groups and zeroes every stat field without calling into the sim at all, for cheaply disabling creatures via the `?creatures=` URL flag.
- **Per-creature perf caches** (Phase 1 of `creature-perf-analysis/plan.md`): several values that are constant after construction are precomputed in the `Creature` constructor (after `this.legs`/`this.arms` are built) instead of being recomputed on the hot path: `_collisionRadius`/`_maxArmReach`/`_meleeRadius` (the `collisionRadius()`/`maxArmReach()`/`meleeRadius()` methods are now thin accessors over these), and per-leg partner topology (`leg.adjacentPartnersCached`/`diagonalPartnersCached`/`rowMateCached`/`crossRowsCached`, consumed by `canWalkLegMove`/`canGallopLegMove`). If legs/arms ever become mutable at runtime these caches must be rebuilt. Two per-frame render optimizations also rely on per-leg fields: `leg._hipWorld` (reused `localToWorld` target) and a cached `leg._footQuat` foot orientation that is only recomputed when the foot moves or the creature turns (`_normSampleX/_normSampleZ/_normYaw`). The second `applyBodyTerrainClearance()` pass in the fixed-step loop now runs only for creatures flagged `_collisionMoved` by `resolveCreatureCollisions` (physicsStep still clears every simmed creature once). Phase 2 adds more pooling on the same hot paths: per-arm scratch vectors (`arm._shoulderWorld/_restWorld/_localScratch/_pointScratch/_carryWorld`) replace the `.clone()` calls in `renderArms`/`armRestTarget`/`constrainArmTarget`/`constrainArmPoint` (combat-punch and `chooseArmObject` clones are deliberately left as-is), and `convexHull` now writes the support polygon into a module-scope pooled buffer (`_hullOut`, via reused `_hullP/_hullLo/_hullUp`) instead of allocating arrays per fixed step.

## Tunable parameters

`environment-ui.js` does not define its own creature-specific numeric sliders. It only:
- Relocates the creature system's own DOM panel (`#port-creature-ui`, built by `ensurePortCreatureUi()` in the bridge) into the workshop UI's "Creatures" panel host (`environment-ui.js:488-489`).
- Surfaces read-only creature perf stats in its debug snapshot/HUD: `creatureVisible`, `creatures`, `creatureRendered` (`environment-ui.js:618`) and a `passCreaturesMs` frame-profiler entry (`environment-ui.js:3`).

The actual tunables live in the creature system's own toolbar/panels (built in `port-creature-bridge.js`'s `CREATURE_UI_HTML`/`CREATURE_UI_STYLE` and populated dynamically by `port-creature-system.js`'s `renderOptions()`/`renderModelOptions()`/random-group functions): Preset, Gait, Count, Objects, Team Size, Mode (behavior), Scene (uniform/varied), Seed, Debug toggle, plus the Gait Controls / Model + Terrain panels and the lettered randomize-group buttons (S/G/M/A/T) inherited from the original app's `RANDOM_GROUPS` system.

## Second creature system: the ClaudeCraft mob simulation

The viewer runs a **second, fully independent creature system** alongside the IK
`port-creature-system.js` one: the vendored **World of ClaudeCraft** deterministic mob
simulation. The two systems share **no code** and never touch each other's state. They
coexist only by (a) both drawing into the same `scene` and (b) both contributing entries to
the same host-authoritative multiplayer snapshot. The IK creatures are untouched by this work.

### What it is

ClaudeCraft's `src/sim/` is a pure, engine-free TypeScript core (zero Three.js imports, fixed
20 Hz tick, all randomness through a seeded `Rng`) that spawns a families-based mob roster
(beasts, spiders, mudfins, burrowers, humanoids, trolls, ogres, undead, elementals, dragonkin,
demons) and drives their AI/movement/combat. It is host-authoritative and deterministic, which
matches the workshop's existing "host simulates, guests interpolate ghosts" model exactly.

### Files

**Vendored sim (TypeScript, bundled):**
- `claudecraft-sim/` — verbatim copy of ClaudeCraft `src/sim/`, edited only for three injected
  seams: `world.ts` (`setHeightProvider`/`setWaterLevelProvider`, `nearSteepWalls` disabled),
  `colliders.ts` (`setExternalColliderResolver`), `sim.ts`+`types.ts` (external-player support:
  `PlayerMeta.external`, `setPlayerPose`, `reviveExternalPlayer`, movement integration skipped
  for external players). Entry: `claudecraft-sim/sim-entry.ts`.
- `claudecraft-sim.bundle.js` — **committed** esbuild output (`npm run build:claudecraft-sim`).
  Exports `Sim`, `MOBS`, `createMob`, `setActiveWorldContent`/`getActiveWorldContent`,
  `setHeightProvider`, `setWaterLevelProvider`, `setExternalColliderResolver`.

**Bridge (plain JS, in `claudecraft-bridge/`, unit-tested):**
- `sim-scale.js` — `makeScale(workshopPlayerHeight)` → `{ SCALE, toWorld, toSim }`. One scale
  factor `SCALE = workshopPlayerHeight / 2.6` (the sim humanoid reference height in yards). The
  sim runs entirely in yard-space; conversion happens only at the bridge boundary.
- `sim-world-content.js` — `buildClaudecraftWorldContent(...)` builds a minimal `WorldContent`
  (one flat zone, camps converted from workshop coords to sim yards, no NPCs/props/doors).
- `sim-mob-snapshot.js` — `serializeMobs(entities, scale)` → wire shape
  `{ id, tid, p:[x,y,z], q:[x,y,z,w], hp:0..1, dead, s }` (yards → world, hp normalized, pure-yaw
  quat). `s` is the per-mob scale multiplier (`e.scale`: the template scale or a spawn-panel
  override), defaulting to 1; it multiplies the render `worldScale` (see the scale flow below).
- `claudecraft-creatures.js` — the top-level factory `createClaudecraftCreatures(...)`. Owns the
  `Sim`, the fixed-20 Hz step loop (spiral-of-death guarded: clamp dt to 0.25 s, max 5 catch-up
  steps/frame), wires the three seams, mirrors player poses in, and reads combat back out. Also
  exposes the **player-combat facade adapter** surface (`ensurePlayer`, `getPlayerCombat`,
  `damagePlayer`, `revivePlayer`, `removeExternalPlayer`) that `player-combat.js` delegates to.
  Also exposes the **runtime manual-mob API** (see "Runtime manual-mob control" below):
  `listSpawnableMobs()`, `spawnMob({mobId,world,level,scale,behavior}) → id`, `setMobBehavior(id,b)`,
  `setMobScale(id,s)`, `removeMob(id)`, `clearSpawnedMobs() → n`, `spawnedMobIds()`.

**Render adapter (plain JS, in `claudecraft-render/`):**
- `anim_state.js` — verbatim port of ClaudeCraft `render/characters/anim_state.ts`
  (`desiredBaseState`/`locomotionTimeScale`, pure/three-free).
- `manifest.js` — mob-scoped port of `manifest.ts`: ClipMap factories, the `VISUALS` table for
  every key a mob can resolve to, and `visualKeyForMob(tid)` (via `MOBS[tid].family`). Asset base
  repointed to `claudecraft-assets/models/`. Players/npcs/weapon-attach/skins/tints are out of scope.
- `visual.js` — `createClaudecraftVisuals({ scene, worldScale })`: per-mob GLB `CharacterVisual`
  using the workshop's `GLTFLoader` + `SkeletonUtils.clone` + `AnimationMixer`, driving idle/walk/run
  crossfades under the r184 WebGPU backend. Async, guarded: a mob keeps its placeholder box until
  its GLB resolves (or forever, if load fails). `dispose()` releases only the clone's mixer/skeleton.
- `claudecraft-assets/models/` — copied GLBs (creatures/enemies/players/weapons).

### The three injected seams

1. **Terrain height** — `setHeightProvider` repoints the sim's `terrainHeight`/`groundHeight` at the
   workshop's real `terrainHeight(x,z)` (procedural AND authored maps), round-tripping through
   `toWorld`/`toSim`. Downstream `terrainSteepness`/`downhill`/`nearSteepWalls` follow automatically.
2. **Collision** — `setExternalColliderResolver` consults `trunkIndex.resolve` (from `collision.js`)
   after the sim's own prop resolution, so mobs slide around workshop tree trunks.
3. **Players** — each workshop player is mirrored into the sim as an `external` player entity whose
   position is written in each tick while the sim owns its combat (HP/threat/death) and does NOT
   integrate its movement. The local player maps to the sim's primary player; remote guests are added
   as external sim players so host-side mobs aggro them too.

### Scale model

`SCALE = workshopPlayerHeight / 2.6`. Applied at exactly four boundaries: the terrain-height
provider, the collider provider, mob render transforms (`visual.js` `worldScale`), and player-pose
mirroring + spawn placement. The sim never sees `SCALE`. Runtime rescale of a running sim is out of
scope (changing player size would require rebuilding the sim).

### Wiring in `environment-viewer.html`

- Static imports: `createClaudecraftCreatures` (`claudecraft-bridge/claudecraft-creatures.js`) and
  `createClaudecraftVisuals` (`claudecraft-render/visual.js`).
- Construction (after `portCreatures`, host/solo only via `if (mpRole !== 'guest')`):
  `claudecraftCreatures = createClaudecraftCreatures({ workshopPlayerHeight: capsuleH, terrainHeight,
  waterLevelWorld: terrain.waterLevel, trunkResolve: (x,z,r)=>trunkIndex.resolve(x,z,r), camps, ... })`
  then `claudecraftVisuals = createClaudecraftVisuals({ scene, worldScale: claudecraftCreatures.scale.SCALE })`.
- Per-frame (profiled under `'claudecraft'`, right after the `'creatures'` pass): mirror the local
  player pose (`getLocalPlayerWorldPose()`, built from `getLocalPlayerState('host')` + camera yaw) and
  the remote guest poses (`remoteClaudecraftPlayers()`), step the sim, drive `claudecraftVisuals.update`
  (returns the set of mob ids with a live GLB), draw placeholder boxes for the rest, then
  `applyClaudecraftCombatToPlayer(now)`.
- **Combat**: `player-combat.js`'s facade is constructed delegated to a lazy adapter
  (`claudecraftCombatAdapter`) forwarding to the bridge, so gun damage and mob damage share ONE player
  HP pool owned by the sim. The HUD (`localHudState` → `mergePlayerCombatFields` → `playerCombat`)
  therefore shows mob damage automatically. `applyClaudecraftCombatToPlayer` handles the death edge
  (no dedicated respawn screen exists: it shows a status line and auto-revives at the current pose
  after `CC_RESPAWN_MS`).
- **Multiplayer**: `getState()` publishes `mobs: claudecraftCreatures.mobs()` (world-space wire shape).
  `multiplayer.js` `InterpolationBuffer._lerpMobs` matches mobs by id (lerp p/hp, slerp q, carry
  tid/dead, carry `s` scale defaulting to 1) and `GhostRenderer` renders guest mob boxes (scaled by
  `s` via the `_updateSet` getScale accessor). Guests never construct or step the sim; they
  receive mobs inside `sim_state` and render the interpolated snapshot. Guest→host aggro works because
  `guest_joined` → `playerCombat.ensurePlayer(clientId)` adds the guest as an external sim player.

### Runtime manual-mob control (the "ClaudeCraft Mobs" panel)

Beyond the sim-construction-time camps, the bridge exposes a runtime API to spawn/manage individual
mobs, surfaced by an inline **"ClaudeCraft Mobs"** panel in `environment-viewer.html`'s scene-controls
UI (built next to the particle-editor panel, host/solo only — gated on `claudecraftCreatures` being
non-null). Panel: a Creature dropdown (all 112 templates, `<optgroup>`-grouped by family), a Behavior
dropdown (Hostile/Passive/Hold), a Scale slider (0.25–4, default 1), a "Spawn in front of player"
button (places a mob `SPAWN_AHEAD` units along the player's facing, y snapped to terrain), and a
"Clear all spawned" button. Runtime-spawned ids are tracked separately (`spawnedIds`) from the seeded
camp mobs, so clear-all never nukes the camps.

Bridge API (all on the `createClaudecraftCreatures` return object):
- `spawnMob({ mobId, world:{x,z}, level=1, scale, behavior='hostile' }) → id|null` — `createMob` at a
  fresh `sim.nextId++`, positioned at world→sim yards with y from the injected `terrainHeight`, scale +
  behavior applied, injected via `sim.entities.set`. Returns `null` for an unknown `mobId`. The visuals
  adapter auto-creates a GLB for the new id next frame; `mobs()` reflects it immediately (refreshed).
- `setMobBehavior(id, 'hostile'|'passive'|'hold')`, `setMobScale(id, s)` (writes `e.scale`),
  `removeMob(id)` (`sim.entities.delete`; the sim's own `highestThreatTarget`/`updateMobTarget` prune
  any dangling target/threat reference, so no manual nulling), `clearSpawnedMobs() → n`,
  `spawnedMobIds()`, `listSpawnableMobs() → [{id,name,family}]`.

The **three behaviors** are ClaudeCraft-native (verified against `mob/locomotion.ts`):
- **hostile** (`e.hostile=true`) — normal sim AI: aggro/chase/attack in range, leash home.
- **passive** — the mob wanders around spawn but never chases. `hostile=false` alone does **not** work:
  the locomotion self-healing net (`mob/locomotion.ts` ~L135) force-re-hostiles any owner-less mob each
  tick, and the idle detection scan ignores the `hostile` flag entirely. So the bridge re-asserts the
  invariant every tick (`enforceSpawnedBehaviors`, before `sim.tick`): if the mob entered
  chase/attack/flee/evade it is snapped back to `idle` with `aggroTargetId`/`inCombat`/`threat` cleared,
  before it can take a chase step (idle takes no movement step the same tick it re-detects).
- **hold** — fully inert AND ignores players. Set `e.aiState='hold'`, a value the `updateMob` switch has
  no case for, so the mob runs no wander, no detection, and no movement. This is strictly stronger than
  the `moveSpeed=0` candidate (which still lets a mob face + melee an adjacent player); re-asserted each
  tick like passive.

Per-mob scale flow end-to-end: `serializeMobs` writes `s=e.scale` → host `visual.js` applies it as
`v.root.scale.setScalar(m.s)` on top of the skinned clip's `normScale*worldScale` → the multiplayer
snapshot carries `s` through `_lerpMobs` and `GhostRenderer` scales guest mob boxes by it.

### Tests

`node test-claudecraft-scale.mjs`, `test-claudecraft-worldcontent.mjs`, `test-claudecraft-seams.mjs`,
`test-claudecraft-mob-snapshot.mjs` (asserts wire `s`), `test-claudecraft-boot.mjs`,
`test-claudecraft-spawn.mjs` (spawn/scale/behavior/remove API), and the mob-interpolation block in
`multiplayer-test.mjs` (asserts `s` carries) all run headless in `node`. The in-page render/combat/replication paths (M5/M6)
require the browser and are verified manually (see the plan's "Manual verification" steps).

## Local player procedural body + third-person weapon mount

A third, unrelated system: the **local player's own** procedural body (`player-procedural-body.js`,
Contract 2 in `docs/subsystems/procedural-body-weapon-contracts.md`), toggled in `environment-viewer.html`
with the `B` key (`setLocalBodyMode`, cycles `off -> third-person -> fps-legs -> off`; state in
`localBodyMode`/`localBody`/`localBodyThird`). `third-person` builds a full body (`mode:
'local-third-person'`) plus a chase camera; `fps-legs` builds lower-body-only (`mode:
'local-lower-body'`) so you can look down and see your own legs while still in first-person view.
Both feed the body speed-adaptive gait (`adaptGaitToSpeed: true`) and smoothed `{crouch, prone}`
stance weights (`lbCrouchW`/`lbProneW`, eased ~0.2s from the instant C/Z stance toggle) each frame.

**Body-aware arm IK** (`solveArm`/`solveTwoBone`): the analytic 2-bone solve is constrained by a
vertical torso capsule rebuilt each `update()` (`_torsoCapsule`: spine at `pos.x/pos.z`, `yMin/yMax`
spanning pelvis→shoulders padded by `TORSO_CAPSULE_Y_PAD`, `radius = radius + TORSO_CAPSULE_RADIUS_MARGIN`)
and passed into `solveArm`. Two corrections keep reload/reach poses from breaking joints:
- **Adaptive outward pole** (no backward bend): `deriveOutwardPole` redirects the pole's horizontal
  component to point away from the spine before solving. It is a no-op when the pole is already
  outward, so the idle pose (fixed pole `(0,-0.4,-elbowSign)` + `ikCfg` twist, already outward+down)
  is unchanged.
- **Elbow capsule clamp + one re-solve** (no torso penetration): if the solved elbow (`_joint`) is
  inside the capsule (`capsuleContainsPoint`), the elbow is projected onto the root→target axis
  (`projectOntoAxis`), a forced-outward pole is derived from that projection, and `solveTwoBone` runs
  once more. Only the pole is changed — bone lengths and the hand target stay exact (no joint is
  translated directly). Projecting onto the axis first isolates the small bend term the pole actually
  controls; deriving "outward" from the raw elbow under-corrects.
The pure math (`capsuleContainsPoint`, `pushPointOutOfCapsule`, `deriveOutwardPole`, `projectOntoAxis`)
is exported and unit-tested headlessly in `test-player-body-ik.mjs`. Tunables: `TORSO_CAPSULE_RADIUS_MARGIN`
(0.10) and `TORSO_CAPSULE_Y_PAD` (0.06) — too fat and reach-across-body poses stiffen, too thin and
limbs clip.

**Third-person weapon mount** (`environment-viewer.html`, added alongside the body wiring): in
`third-person` mode the camera-attached FPS viewmodel (`localWeaponView`) is hidden and a
body-held weapon is mounted in the world instead, so the gun rides in the body's hands rather than
floating in front of the camera. Mirrors the mount hierarchy and per-frame placement already
prototyped in `body-preview.html`:
- **Lazy init** (`initLocalWeaponMount`, called fire-and-forget from `setLocalBodyMode` when
  entering `third-person`): `await import('./weapon-pose-controller.js')` (lazy, matching this
  file's other optional-subsystem imports), fetch `weapon-anchors.json` + `weapon-poses.json`
  (cached in `lbWeaponDataPromise`), load the current weapon's GLB, normalize it to
  `def.viewTargetSize` (same normalization the FPS viewmodel uses — `normalizeWeaponModel`, a
  copy of `createLocalWeaponViewModel`'s `normalizeObject`), bake `weapon-anchors.json`'s raw-GLB-space
  anchors into that normalized space (`bakeWeaponAnchors`), and build the mount hierarchy
  `weaponRig -> weaponAdjust -> weaponFrame (rotY=PI) -> weaponView`, added to `scene`. Creates
  `createWeaponPoseController({ THREE, body: localBody, weaponView, getWeaponDef })` against the
  **current** `localBody` instance and calls `controller.setWeapon(weaponId)`.
- **Guard/scope**: only mounts if `getWeapon(weaponId).thirdPersonHold` exists and
  `weapon-anchors.json` has anchors for that id — `m1911` and `m24` both have holds now (`m24`'s
  are seeded from `m1911`, unpreviewed); `knife` etc. still have none, so they stay unmounted/hidden.
  Fetch/GLB-load failures `console.warn` and leave the mount unbuilt rather than throwing.
- **Rebuild on weapon switch**: a per-frame check (in the same `localBodyThird` block, before the
  mount placement code) detects `lbWeaponMount.weaponId !== lbState.weapon` (mount is stale) or no
  mount yet but the current weapon has a `thirdPersonHold` (needs a fresh mount), and kicks
  `teardownLocalWeaponMount()` + `initLocalWeaponMount(lbState.weapon, localBody)`. Guarded by
  `lbWeaponMountRequestedId` (set to the weapon id being requested, cleared once that mount lands
  or on teardown) so the check doesn't re-kick an init every frame while one is in flight. GLB
  loads are cached per weapon id in `lbWeaponModelCache` (normalized template `Group`, cloned with
  `.clone(true)` per mount) so toggling between weapons doesn't re-fetch the model each time.
- **Teardown/re-init ordering**: `teardownLocalWeaponMount()` runs unconditionally at the top of
  `setLocalBodyMode` (before the old `localBody` is even destroyed and before a new one may be
  created), and bumps `lbWeaponMountToken` so any in-flight async init from a previous mode switch
  becomes a no-op when it resolves (checked via `token !== lbWeaponMountToken`, plus `localBody ===
  bodyRef` and `localBodyThird` re-checks after every `await`). This guarantees the controller
  is only ever created against the body instance alive on that specific `setLocalBodyMode` call —
  never a stale one — even if the player mashes `B` while a GLB load is in flight.
- **Per-frame** (in the `localBodyMode !== 'off'` block, after `localBody.update(...)`):
  `weaponRig` is placed at the player position with `y = terrainHeight(x,z) + 1.5` and rotation
  `(0, camera.rotation.y + Math.PI, 0)` (the body rig faces yaw+PI internally, so the mount must
  match or the hold offsets point backwards — same as `body-preview.html`). The stance-aware hold
  blends `weapons.js`'s `thirdPersonHold` -> `crouchHold` (by `lbCrouchW / 0.7`) -> `proneHold`
  (by `lbProneW`) component-wise for position/rotation/scale (`crouchHold`/`proneHold` fall back
  to `thirdPersonHold` if absent) into `weaponAdjust`, then
  `weaponRig.updateMatrixWorld(true)` runs *before* `controller.update(rawDt, {})` so anchor
  resolution sees fresh matrices (mirrors `body-preview.html`'s ordering). `controller.setAiming(0)`
  — third-person has no aim-down-sights yet. Visibility mirrors the existing
  `localBody.setVisible(true/false)` branches (mount visible only in `third-person` mode with
  `playerInitialized && fpsMode`).
- **Visual only**: never moves the player/camera or touches hit-registration (Contract 5's
  guardrails), matching the rest of this subsystem's IK/gait work.

## Reload sequence tuner (`body-preview-v3.html`)

`body-preview-v3.html` has a **Reload Tuner** panel section (Weapon tab) for authoring/correcting
the reload keys in `weapon-poses.json` against the real body — the only faithful way to tune the
**body-relative** targets (`{body:[x,y,z]}`, `beltMagazine`) that caused the m1911 through-torso
reach, since the weapon-only `weapon-anchor-editor.html` has no body to judge penetration against.

- **Scrub/play**: when enabled, the animate loop drives
  `controller.update(dt, { action: 'reload', actionTime: RT.t })` (host-authoritative path — the
  controller evaluates at exactly `RT.t` and never self-advances/auto-completes). Play advances
  `RT.t` by `dt` and loops at `duration`; the scrub slider sets it directly. Disabling reverts to
  the normal `controller.update(dt, {})` and calls `controller.play('idle')` once.
- **Live edits**: the key list is built from `WEAPON_POSES.reloadSequence[id].keys`; the selected
  key's editable channel exposes X/Y/Z sliders (`{body}` → `body`; `{weaponAnchor,offset}` →
  `offset`) plus a `t` slider clamped between neighbor times. Edits mutate `WEAPON_POSES` **in
  place** — `getWeaponDef(id)` returns that same `reloadSequence` object by reference and the
  controller holds it as `s.activeSeq`, so changes apply on the next frame without a re-play. String
  refs (`rightGrip`, `beltMagazine`, …) render read-only.
- **Export**: a textarea mirrors `JSON.stringify(WEAPON_POSES, null, 2)`; Copy/Download buttons
  emit the whole sidecar to paste back over `weapon-poses.json` (browser can't write disk).
- Body frame is +x = left, +y = up, +z = forward (matches `body.rootAnchor`); slider labels state
  it. The tuner adds no logic to `weapon-sequence.js` / `weapon-pose-controller.js` — host-side only.
  Design: `docs/superpowers/specs/2026-07-11-reload-sequence-tuner-design.md`.

## Tests

`node test-creature-interaction.mjs` covers the pure player-interaction decision math in
`creature-interaction.js` (`followDesire`, `hostileDesire`, `meleeHitsPlayer`, `wildlifeSpawnPlan`),
including boundary cases at the exact `attackRange`/capsule-radius edges. `node test-combat.mjs`
covers the unrelated player-vs-player/creature hitscan gun math in `combat.js` (not the IK melee
pipeline). No other dedicated test file exists for `port-creature-bridge.js` / `port-creature-system.js`
itself (body plans, IK, steering, the melee state machine) — those remain verified manually in-browser.
The weapon-mount pieces are covered indirectly by `node test-weapon-pose-controller.mjs` and
`node test-player-body-gait.mjs`, which exercise the controller/body modules the mount wires together
(no browser-only mount code itself is unit-tested).
