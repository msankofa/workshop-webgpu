# Multiplayer Guns Implementation Plan

> For agentic workers: implement this plan task-by-task. Keep checkboxes current. Do not add Rapier in this pass; hitscan/player combat needs protocol correctness, not rigid-body simulation.

## Goal

Add player-held guns to the workshop multiplayer system:

- Local player sees and fires a held gun in FPS mode.
- Remote players visibly hold and fire guns.
- Guest shots are sent as intents, never damage claims.
- Host resolves player hits and applies damage.
- Gun damage and ClaudeCraft mob damage use the same player HP/death authority.
- Existing gun GLB assets in `models/guns/` are used for visuals.

## Architectural Decisions

1. **No Rapier for M1-M6.** Hitscan guns use pure ray/capsule math. Rapier is deferred for grenade/RPG/physics props.
2. **Host authority remains unchanged.** The browser host resolves shots and broadcasts snapshots. The relay stays dumb.
3. **One player combat authority.** Add `player-combat.js` as a facade:
   - With ClaudeCraft creatures active: delegate HP/death/revive to the ClaudeCraft bridge/player entity.
   - Without ClaudeCraft creatures: use a fallback host-owned HP map.
4. **Use local GLB assets for rendering only.** Gameplay remains data-driven.
5. **Effects replicate through entities.** Tracers/hit sparks should be host-created short-lived effect entities, not direct guest renderer calls.

## Existing Assets

Use these files:

| File | Planned Use |
|---|---|
| `models/guns/low-poly_m1911.glb` | Pistol/default compact FPS gun |
| `models/guns/low-poly_m24_sniper_rifle.glb` | Rifle/sniper hitscan visual |
| `models/guns/low_poly_combat_knife.glb` | Later melee weapon |
| `models/guns/low-poly_mk2_grenade.glb` | Later grenade projectile; possible Rapier trigger |
| `models/guns/low-poly_rpg-7.glb` | Later rocket projectile |

First gameplay weapon: `m1911` or `m24`, implemented as hitscan. Pick `m1911` first if first-person framing is easier; use `m24` once weapon offsets are tunable.

## Protocol

Guests send:

```js
{
  type: 'combat_intent',
  action: 'gun.fire',
  weapon: 'm1911',
  shotSeq: 42,
  clientFireTime: 123456.7,
  origin: [x, y, z],
  dir: [x, y, z]
}
```

Host validates:

- player exists
- player is alive
- weapon exists/equipped
- `shotSeq` is newer than the previous accepted shot
- fire cooldown has elapsed
- `origin` is close to the shooter's accepted camera/head position
- `dir` is finite and normalizable
- target is not self

Host applies:

- ray/capsule hit test against player capsules
- optional map/terrain occlusion
- `playerCombat.applyDamage(...)`
- replicated `fireSeq`, `lastShotAt`, and short-lived effects

## Player Snapshot Shape

Extend player snapshots from:

```js
{ id, p, q, h, r }
```

to:

```js
{
  id,
  p, q, h, r,
  hp: 100,
  maxHp: 100,
  alive: true,
  weapon: 'm1911',
  firing: false,
  fireSeq: 0,
  lastShotAt: 0
}
```

`hp`, `maxHp`, `alive`, `fireSeq`, and `lastShotAt` are host-owned. Guest-supplied values must be ignored.

## Milestone M0: Asset Inspection and Weapon Config

### Files

- Create: `weapons.js`
- Test: `test-weapons.mjs`

### Steps

- [ ] Define weapon ids: `m1911`, `m24`.
- [ ] Map each weapon to model path, fire interval, damage, range, recoil, tracer color.
- [ ] Add `loadout.defaultWeapon = 'm1911'`.
- [ ] Keep grenade, RPG, and knife in the config as `disabled: true` future entries.
- [ ] Add a test that every enabled weapon has finite positive `damage`, `range`, and `fireIntervalMs`.
- [ ] Add a test that model paths are strings under `models/guns/`.

### Acceptance

- `node test-weapons.mjs` passes.
- No renderer or multiplayer code imports GLBs directly; they read paths from `weapons.js`.

## Milestone M1: Pure Combat Core

### Files

- Create: `combat.js`
- Create: `test-combat.mjs`

### Steps

- [ ] Implement vector helpers using arrays, no Three import.
- [ ] Implement `normalizeDir(dir)`.
- [ ] Implement `rayCapsuleHit(origin, dir, range, capsule)`.
- [ ] Implement `findPlayerHit({ shooterId, players, origin, dir, range, occlusion })`.
- [ ] Implement `validateShot({ shooter, weapon, intent, nowMs, lastShot })`.
- [ ] Implement `applyGunDamage(targetCombat, weapon)`.
- [ ] Add pose history helpers:
  - `pushPlayerPose(history, id, pose, nowMs)`
  - `samplePlayerPose(history, id, targetTimeMs)`
  - `prunePlayerPoseHistory(history, nowMs, maxAgeMs)`

### Tests

- [ ] Ray through capsule hits.
- [ ] Ray beside capsule misses.
- [ ] Nearest target wins.
- [ ] Shooter cannot hit self.
- [ ] Dead target is ignored.
- [ ] Cooldown rejection works.
- [ ] Duplicate/stale `shotSeq` is rejected.
- [ ] Pose history interpolates by time.

### Acceptance

- `node test-combat.mjs` passes.
- `combat.js` remains browser/Node safe and imports no Three/WebGPU modules.

## Milestone M2: Player Combat Facade

### Files

- Create: `player-combat.js`
- Create: `test-player-combat.mjs`

### Steps

- [ ] Implement fallback HP state:
  - `ensurePlayer(id)`
  - `getSnapshot(id)`
  - `applyDamage({ targetId, amount, source, attackerId, hitPoint, weaponId })`
  - `revive(id, worldPose)`
  - `removePlayer(id)`
- [ ] Add optional ClaudeCraft adapter hooks:
  - `getPlayerCombat(id)`
  - `damagePlayer(id, packet)`
  - `revivePlayer(id, pose)`
  - `removeExternalPlayer(id)`
- [ ] Make facade choose ClaudeCraft adapter when present and fallback map otherwise.
- [ ] Return a normalized snapshot shape in both modes.

### Tests

- [ ] Fallback damage reduces HP.
- [ ] Fallback death sets `alive:false`.
- [ ] Revive restores HP.
- [ ] Missing player is initialized safely.
- [ ] Fake ClaudeCraft adapter receives damage calls.
- [ ] Facade snapshot shape is identical in fallback and delegated mode.

### Acceptance

- `node test-player-combat.mjs` passes.
- Gun implementation never mutates player HP directly.

## Milestone M3: Multiplayer Damage Wiring

### Files

- Modify: `environment-viewer.html`
- Modify: `multiplayer.js`
- Extend: `multiplayer-test.mjs`

### Steps

- [ ] Create `playerCombat` after multiplayer/ClaudeCraft setup is known.
- [ ] Merge `playerCombat.getSnapshot(id)` into every player entry returned by `getState()`.
- [ ] On host `player_state`, ignore guest `hp`, `alive`, `fireSeq`, `lastShotAt`.
- [ ] Add `combat_intent` branch in the `mp:guest_input` handler.
- [ ] Implement `applyCombatIntent(intent, ownerId)` beside `applyLightIntent`.
- [ ] Host-local firing calls `applyCombatIntent(intent, 'host')`.
- [ ] Guest firing sends `mpSession.sendInput(intent)`.
- [ ] Track `lastShotSeq` and `lastShotAt` per player on the host.
- [ ] Push accepted player poses into `playerPoseHistory`.
- [ ] If ClaudeCraft bridge is active, mirror accepted guest poses into the bridge as planned by the ClaudeCraft integration.
- [ ] On `guest_left`, remove pose history and fallback combat state; release ClaudeCraft external player if active.
- [ ] Update `_lerpPlayers()` to carry/interpolate combat fields.

### Tests

- [ ] Extend `multiplayer-test.mjs` to verify `hp` interpolation.
- [ ] Verify `alive`, `weapon`, `fireSeq`, and `lastShotAt` pass through from the newer snapshot.

### Acceptance

- Host can damage guest.
- Guest can damage host.
- Guest cannot spoof HP through `player_state`.
- Rapid duplicate shots do not double-damage.
- When ClaudeCraft player combat is active, gun damage and mob damage affect the same HP pool.

## Milestone M4: First-Person Gun Visuals

### Files

- Modify: `player-hands.js`
- Modify: `environment-viewer.html`

### Steps

- [ ] Add optional gun model group to `createViewHands`.
- [ ] Add API:
  - `setWeapon(weaponDef)`
  - `setWeaponVisible(visible)`
  - `recoil(strength = 1)`
- [ ] Load `models/guns/low-poly_m1911.glb` through the existing GLTFLoader path in `environment-viewer.html`.
- [ ] Attach the cloned/loaded model to the camera viewmodel group.
- [ ] Add per-weapon local offset/rotation/scale in `weapons.js`.
- [ ] Keep orb hands visible unless the model framing requires hiding or shrinking them.
- [ ] On local accepted fire input, call `viewHands.recoil(weapon.recoil)`.

### Acceptance

- In FPS mode, the player sees a held gun.
- The gun does not obscure the crosshair.
- Recoil is visible but does not move the actual camera aim unless explicitly added later.
- Exiting FPS hides the viewmodel.

## Milestone M5: Remote Gun Visuals

### Files

- Modify: `multiplayer.js`

### Steps

- [ ] Extend `GhostRenderer._makePlayer()` with a gun mount group.
- [ ] Load or inject shared gun model resources from `environment-viewer.html`, or start with a simple box placeholder if asset loading inside `GhostRenderer` would tangle responsibilities.
- [ ] Position remote gun relative to the player's local -Z forward direction and orb hands.
- [ ] Watch `fireSeq`; when it changes, run recoil/muzzle flash animation on that remote player.
- [ ] Hide/lower gun for `alive:false`.

### Acceptance

- Host sees guest holding/firing a gun.
- Guest sees host and other guests holding/firing guns.
- Weapon visuals follow player yaw.
- `GhostRenderer.destroy()` cleans up any cloned materials/geometries it owns.

## Milestone M6: Tracers, Hit Effects, and Occlusion

### Files

- Create: `entity-types/effect.js`
- Modify: `entity-registry.js` only if needed for effect cap/lifecycle
- Modify: `environment-viewer.html`
- Add tests if adapter logic is non-trivial

### Steps

- [ ] Add short-lived effect adapter:
  - `gun_tracer`
  - `hit_spark`
  - optional `muzzle_flash`
- [ ] Host creates tracer entity for accepted shots.
- [ ] Host creates hit spark entity at confirmed hit point.
- [ ] Guest renders effects from `entities.upserts`, same as light/projectile path.
- [ ] Add procedural terrain occlusion by ray stepping against `terrainHeight(x,z)`.
- [ ] Add authored map occlusion using `mapCollider`/BVH ray query. If `mapCollider` lacks a forward ray API, add one there rather than duplicating BVH logic in combat code.

### Acceptance

- All clients see the same tracer/hit result.
- Shots do not damage through authored map geometry.
- Procedural terrain blocks shots when the ray passes below terrain height.

## Milestone M7: Documentation and Follow-Up Hooks

### Files

- Modify: `docs/subsystems/multiplayer.md`
- Modify: `docs/subsystems/creature.md` if ClaudeCraft player combat integration is active
- Modify: `agent_log.csv`

### Steps

- [ ] Document `combat_intent`.
- [ ] Document extended player snapshot fields.
- [ ] Document host-owned player combat facade.
- [ ] Document why Rapier is deferred.
- [ ] Log the landed milestones in `agent_log.csv`.

### Acceptance

- A new engineer can tell where player HP is owned.
- The docs explain how gun damage coexists with ClaudeCraft mob damage.

## Deferred: Rapier Integration

Add Rapier only when one of these lands:

- MK2 grenade with bounce/rolling/contact response.
- RPG rocket with physical impulse or collision-rich projectile behavior.
- Physics props that bullets can push.
- Ragdoll or destructible rigid bodies.

When that happens, Rapier should be added as a separate physics subsystem with a clear boundary:

- Rapier owns dynamic rigid bodies.
- Existing player hit registration can remain ray/capsule host logic.
- Terrain/map colliders are exported into Rapier only for objects that need physical contact.
- Rapier must not become a second source of player HP or combat authority.

## Suggested Implementation Order

1. M0 weapon config.
2. M1 combat core.
3. M2 player combat facade.
4. M3 multiplayer damage wiring.
5. M4 local gun visual.
6. M5 remote gun visual.
7. M6 replicated effects and occlusion.
8. M7 docs.

This order lets the game become mechanically correct before visuals and effects, and it keeps the ClaudeCraft integration compatible whether that plan lands before or after the gun work.
