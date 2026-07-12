# Creature Interaction Overhaul — Design Spec

Date: 2026-07-11
Subsystem: `creature` (`port-creature-system.js`, `port-creature-bridge.js`, `environment-viewer.html`)
Status: **in progress** (orchestrated build; see STATUS below)

## Goal

The IK procedural creatures (`port-creature-system.js`) currently have **no awareness of the
player at all**. Behaviors are global (`currentBehavior` applies to every creature) and
player-agnostic: wander, stay, target (a clicked point), direction, forage, combat (team vs team),
race. You cannot make a creature follow you, command one to go somewhere, have creatures appear as
ambient wildlife, or be attacked by them.

This overhaul makes creatures behave like **pets and wildlife**:

1. **Follow** — creatures can follow the player (as a global mode and as a per-creature pet role).
2. **Command** — the player can tame a nearby creature into a pet and command it: follow / stay /
   go-to a point / attack a target.
3. **Wildlife** — ambient creatures spawn on a ring around the player and despawn when far, so the
   world feels populated with roaming wildlife.
4. **Attack you** — hostile creatures approach the player, melee-attack, and deal damage to the
   shared player HP pool; the player fights back with the existing gun (already damages creatures).

## Key existing facts (verified 2026-07-11)

- `getLocalPlayerState('host')` (`environment-viewer.html:422`) → `{ p:[x,y,z], q, h, r, ... }`,
  the live player capsule pose. `null` until `playerInitialized`. `q` is a pure-yaw quaternion.
- `playerCombat` (`createPlayerCombatFacade`, `player-combat.js`) owns player HP.
  `playerCombat.applyDamage({ targetId:'host', amount, source, attackerId, hitPoint })` damages
  the player (shared pool; delegates to the ClaudeCraft bridge when creatures are active).
  `playerCombat.getSnapshot('host')` → `{ hp, maxHp, alive }`.
- The gun already damages port creatures: `hit.creatureRef.takeDamage(weapon.damage, null)`
  (`environment-viewer.html:5854`). So player→creature damage already works; this spec adds the
  creature→player direction and the AI to drive it.
- Behavior is dispatched in `Creature.computeSteering(all, gait, behavior, targetPoint, dirYaw,
  raceStart)` (`port-creature-system.js:2288`) and the roster loop in `update(dt)`
  (`port-creature-system.js:4780`). The combat attack state machine lives in `updateCombat` and is
  driven each frame; contact/damage is applied via `punchArm`/`punchContact`.
- `createPortCreatureSystem` is built by `createEnvironmentPortCreatures` (`port-creature-bridge.js`)
  and constructed in `environment-viewer.html:1387`. Guests run `mode:'network'` (no local sim), so
  all player interaction is host/solo only — consistent with the ClaudeCraft mob path.

## Architecture

### New per-creature *role*, orthogonal to the global *behavior*

Global `currentBehavior` stays as-is for the classic sandbox modes. We add a per-creature
`creature.role` (default `'wild'`) that, when the new **Interactive** layer is active, overrides
the global behavior for that individual creature:

- `ROLE_WILD` — ambient wildlife: wanders; flees briefly when hurt. Spawned by the wildlife system
  or by the roster. Can be tamed.
- `ROLE_PET` — follows the player; obeys a command (`follow` | `stay` | `goto` | `attack`).
- `ROLE_HOSTILE` — predator: approaches the player, melee-attacks, deals damage; flees when weak.

Roles are stored on the `Creature` instance and are **not** part of the global behavior `<select>`.
A creature's effective steering each frame is: if it has an interactive role, use the role's
steering; otherwise fall back to the global `currentBehavior` path (unchanged).

### New pure module: `creature-interaction.js`

All new decision math lives in a THREE-free, Node-testable module so it can be unit-tested without a
GPU (matches the repo's `forest-cull.js`/`light-cluster.js` testability pattern). It is imported by
`port-creature-system.js`. Exports (final signatures may be refined by the implementer but keep them
pure and tested):

- Role constants: `ROLE_WILD`, `ROLE_PET`, `ROLE_HOSTILE`.
- Pet command constants: `CMD_FOLLOW`, `CMD_STAY`, `CMD_GOTO`, `CMD_ATTACK`.
- `followDesire({ selfX, selfZ, playerX, playerZ, standoff, spreadAngle }) -> { dx, dz, moving }`
  — unit XZ steering toward the player that stops inside `standoff` (so pets don't jitter into the
  player); optional per-creature `spreadAngle` fans a group out so they don't stack.
- `hostileDesire({ selfX, selfZ, playerX, playerZ, attackRange, weak }) -> { dx, dz, moving, inRange }`
  — approach the player until `attackRange`, or flee (weak). `inRange` gates the melee/damage state.
- `meleeHitsPlayer({ handX, handY, handZ, playerX, playerY, playerZ, playerRadius, playerHeight })`
  — capsule proximity test for whether a strike contacts the player capsule.
- `wildlifeSpawnPlan({ playerX, playerZ, existing, target, ringMin, ringMax, cullRadius, rand })`
  — returns `{ spawns:[{x,z}], despawnIds:[...] }`: how many to spawn on the ring and which distant
  creatures to cull, to keep `~target` wild creatures around the player. Deterministic given `rand`.

### Injected dependencies (the foundation, wired first)

`createPortCreatureSystem` / `createEnvironmentPortCreatures` gain two optional callbacks (default
no-op / `null`), forwarded from `environment-viewer.html`:

- `getPlayerPose() -> { x, y, z, yaw, alive, height, radius } | null` — implemented in the entry
  point from `getLocalPlayerState('host')` + `playerCombat.getSnapshot('host').alive`.
- `damagePlayer(amount, hitPoint) -> void` — implemented as
  `playerCombat.applyDamage({ targetId:'host', amount, source:'creature', attackerId:'creature', hitPoint })`.

Inside `port-creature-system.js`, `update(dt)` refreshes a module-scoped player snapshot at the top
(`_playerPos: Vector3`, `_playerAlive`, `_playerRadius`, `_playerHeight`, `_playerYaw`,
`_hasPlayer`). All role code reads that snapshot; nothing calls `getPlayerPose()` on the hot inner
loops.

### New public API on the system (added incrementally by the workstreams)

- `setCreatureRole(creature, role)` / `creature.role`.
- `setPetCommand(creature, cmd, point?)` — set a pet's command + optional goto/attack target.
- `tameNearestToPlayer(maxDist) -> creature|null` — convert the nearest wild creature to a pet.
- `spawnCreatureAt(x, z, opts) -> creature` / `despawnCreature(creature)` — used by wildlife.
- Wildlife controls: `setWildlife({ enabled, target, ringMin, ringMax, cullRadius })`.
- Getters for UI/HUD: `pets`, `playerThreats` (hostiles targeting player), etc.

## Workstreams (orchestrated; sequential — all touch `port-creature-system.js`)

- **F1 Foundation** (done by orchestrator): `creature-interaction.js` skeleton + constants, injected
  `getPlayerPose`/`damagePlayer` through bridge + entry point, module-scoped player snapshot, `role`
  field + `setCreatureRole`, `test-creature-interaction.mjs` seed. No behavior change yet.
- **F2 Follow + pet commands**: `follow` global mode + `ROLE_PET` steering + `setPetCommand` +
  `tameNearestToPlayer`. `followDesire` math + tests.
- **F3 Hostile-to-player**: `ROLE_HOSTILE` steering + melee via the existing attack state machine
  targeting the player capsule + `damagePlayer` on contact + flee-when-weak. `hostileDesire` /
  `meleeHitsPlayer` math + tests.
- **F4 Wildlife spawning**: ambient ring spawn/despawn around the player, capped, with UI toggle +
  density. `wildlifeSpawnPlan` math + tests.
- **F5 Interaction UX**: tame/command HUD + keybinds (look at a creature, press a key to
  tame/command; double-click ground to send a pet), wildlife toggle button, hostile spawn control.

Each workstream: sonnet implements → fable reviews → orchestrator applies fixes, runs `node --check`
+ affected `node test-*.mjs`, updates `docs/subsystems/creature.md` + appends `agent_log.csv`.

## Guardrails

- Host/solo only (guests short-circuit in `mode:'network'`). Never damage the player on a guest.
- Never mutate player HP directly — only via the injected `damagePlayer` (→ `playerCombat`).
- Respect LOD: role AI runs only for `lodShouldSim` creatures, same as existing behaviors.
- Keep new hot-loop code allocation-free (reuse scratch vectors), matching the perf work already in
  this file (see `docs/subsystems/creature.md` "Per-creature perf caches").
- One-line comments only (user preference). Rationale goes in this spec / `agent_log.csv`, not inline.
- Back up big files into `versions/` before editing per the repo convention; `.js` modules rely on
  git (feature branch `sp1-webgpu-renderer-migration`).
- In-browser QA (WebGPU) is done by the user; automated verification is `node --check` + node tests.

## STATUS

- [x] F1 Foundation — `creature-interaction.js` (+ `test-creature-interaction.mjs`, green),
  injected `getPlayerPose`/`damagePlayer` through bridge + entry point, module-scoped player
  snapshot (`refreshPlayerSnapshot`/`hasLivePlayer`), `creature.role`/`petCommand`/`petTarget`
  fields, `setCreatureRole` public API. No behavior change yet.
- [x] F2 Follow + pet commands — global `follow` Mode + `computeSteering` follow branch
  (`followDesire`, per-creature `_followPhase` fan-out/standoff); `ROLE_PET` overrides the global
  behavior per-creature in the `update()` roster loop via `petCommand` (follow/stay/goto; attack
  treated as follow, `// TODO(F3)`); `setPetCommand`/`tameNearestToPlayer`/`commandAllPets`/
  `untamePet` + `pets` getter; `T`/`G`/`Y` keybinds in `environment-viewer.html` (host/solo only) —
  `Y` substituted for the doc's suggested `H`, which was already bound to GUI-hide.
- [x] F3 Hostile-to-player — `ROLE_HOSTILE` steering (`hostileDesire`) + module-scoped `_playerProxy`
  (duck-types as a `Creature` combat target, allocation-free) reused through the existing team-combat
  punch/IK/damage pipeline unchanged; `HOSTILE_PLAYER_DAMAGE = 7` per hit via `damagePlayer`;
  `aggroAllWild`/`calmAllHostile`/`playerThreats` API + `K` keybind (host/solo only).
- [x] F4 Wildlife spawning — `_wildlife` state (enabled/target/ring/cullRadius/hardMax/interval),
  throttled ring spawn/despawn via `wildlifeSpawnPlan` in `update()`, `spawnCreatureAt`/
  `despawnCreature`, wildlife-tagged `ROLE_WILD` creatures roam regardless of global Mode, `J`
  keybind toggle, `setWildlife`/`wildlife`/`wildlifeCount` API.
- [x] F4 review (orchestrator, self — the fable pass was cut off by a session limit): verified no
  crash paths in spawn/despawn mid-`update` (fresh creatures get LOD flags before the LOD pass;
  roster/grid/active-list/forage-claims rebuild after the spawner; `combatTarget` recomputed in
  `updateCombat` after despawn), cull scope limited to `_wildlife && ROLE_WILD`, `hardMax` bounds
  total roster, role-branch precedence pet→hostile→wildlife→global correct. **Known limitation:**
  enabling wildlife on a multiplayer *host* churns the roster, so the change-driven
  `creature_config` packet resends each spawn/despawn (O(creatures) payload). Wildlife defaults off
  and MP is opt-in; interest-scoped/delta config sync is deferred (see `multiplayer.md` §6/§9).
- [x] F5 Interaction UX (orchestrator) — compact host/solo **Creatures HUD** (`#creature-command-hud`,
  bottom-right in `environment-viewer.html`) showing live Pets / Threats / Wildlife counts + the
  keybind legend (`T` tame · `G` go-to · `Y` follow/stay · `K` aggro/calm · `J` wildlife), updated
  ~4 Hz from the system getters. This makes the F2–F4 features discoverable. Deeper UX (radial
  command menu, look-at targeting, pet-attack command, a toolbar wildlife panel) remains future work.

## In-browser QA (pending — user to verify)

Serve with `python serve.py` and open `http://127.0.0.1:8080/environment-viewer.html` (Solo). Enter
FPS mode. Then: **J** to populate wildlife (roaming creatures appear on a ring and cull when you walk
away); walk up to one and press **T** to tame it (Pets count rises, it follows you); **G** while
aiming at ground sends pets there; **Y** toggles pets follow/stay; **K** turns wild creatures hostile
— they approach and melee you (player HP drops in the HUD), and your gun kills them; **K** again calms
survivors. The bottom-right HUD reflects all counts.
