# Multiplayer Guns Design

## Goal

Add player-held guns that work in solo, host, and guest sessions:

- Local players can equip/hold a gun in first person.
- Remote players visibly hold/aim/fire a gun.
- Shots register damage on players through the existing host-authoritative multiplayer model.
- Guests send fire intents, never damage claims.
- The host validates fire rate, pose, range, line of fire, and damage, then replicates health and fire effects in snapshots.

This spec targets the current `three`/WebGPU stack, `multiplayer.js`, `player-hands.js`, `entity-registry.js`, and `environment-viewer.html`. It does not require Rapier, Cannon, Ammo, Babylon, or enable3d for the first milestone.

## Current Architecture Constraints

- The relay is dumb. It forwards JSON and does not simulate combat.
- The browser host is authoritative for creatures, entities, player roster, and snapshots.
- Guests send `player_state` at 20 Hz and receive interpolated `sim_state`.
- Player wire shape is currently `{ id, p, q, h, r }`.
- Local first-person hands are camera-attached via `createViewHands(camera, THREE)`.
- Remote players are rendered by `GhostRenderer` as capsule bodies with orb hands.
- Dynamic visual entities already use `entityRegistry.snapshot()` in `getState()`.
- Light gun intents already follow the right shape: guest sends `entity_intent`, host applies it.

Gun combat should follow the same direction: **client intent -> host validation/resolution -> replicated snapshot/effects**.

## Non-Goals

- Full rigid-body bullet simulation.
- Server-side authoritative simulation in `server/server.js`.
- Creature damage from guns in the first milestone.
- Inventory, ammo pickups, persistence, weapon customization UI, reload animations.
- Anti-cheat strong enough for untrusted public competitive play. The browser-host model can reduce casual abuse, not eliminate it.

## Compatibility With ClaudeCraft Creature Integration

`docs/superpowers/plans/2026-07-05-claudecraft-creatures-integration.md` adds a second creature system whose mobs fight workshop players. That plan makes the ClaudeCraft sim the owner of mirrored player combat state (`playerEntity.hp`, `dead`, revive/threat state), with the workshop reading HP/death back each tick.

Guns must not create a second independent player-health authority. Use one host-side player-combat facade:

```js
playerCombat.applyDamage({ targetId, amount, source: 'gun', attackerId, hitPoint, weaponId });
playerCombat.getSnapshot(playerId); // { hp, maxHp, alive/dead, weapon, lastShotAt, ... }
playerCombat.revive(playerId, worldPose);
```

If ClaudeCraft creatures are enabled, `playerCombat` delegates HP/death/revive to the ClaudeCraft bridge. If they are disabled, it uses a small workshop fallback map. `getState()` always reads combat fields through this facade so mob damage, gun damage, death, and respawn share one source of truth.

## Weapon Model

Start with one hitscan rifle. Hitscan is the right first implementation because it is cheap, deterministic, and avoids tunneling or high-speed projectile physics.

Use the existing local GLBs in `models/guns/` for held weapon visuals. First-pass gameplay should still be hitscan; the models only affect first-person and remote-player rendering.

| Asset | First Use |
|---|---|
| `models/guns/low-poly_m1911.glb` | M1/M2 pistol or compact default gun |
| `models/guns/low-poly_m24_sniper_rifle.glb` | Hitscan rifle/sniper visual |
| `models/guns/low_poly_combat_knife.glb` | Later melee weapon |
| `models/guns/low-poly_mk2_grenade.glb` | Later thrown projectile/explosive |
| `models/guns/low-poly_rpg-7.glb` | Later slow projectile launcher |

```js
const DEFAULT_WEAPON = {
  id: 'rifle',
  displayName: 'Rifle',
  mode: 'hitscan',
  damage: 25,
  range: 120,
  fireIntervalMs: 220,
  spreadRad: 0.006,
  pelletCount: 1,
  recoil: 1,
  tracerLifeMs: 90,
};
```

Future weapon types can add slower projectiles, but the wire protocol should still submit an intent and let the host resolve it.

## Player Combat State

Extend the host's player records from:

```js
{ id, p, q, h, r }
```

to:

```js
{
  id,
  p, q, h, r,
  hp: 100,
  alive: true,
  weapon: 'rifle',
  firing: false,
  fireSeq: 0,
  lastShotAt: 0,
}
```

Rules:

- `hp`, `alive`, `lastShotAt`, and confirmed `weapon` are host-owned.
- Guests may include cosmetic/input hints like `weapon` and `aimPitch`, but the host clamps/accepts them into host state.
- `firing` and `fireSeq` are transient visual hints replicated for remote muzzle flash/recoil.
- Dead players cannot fire and should be ignored by hit tests.

`_lerpPlayers()` in `multiplayer.js` should interpolate `hp` like it already interpolates `h`/`r`, and pass through `alive`, `weapon`, `firing`, `fireSeq`, and `lastShotAt` from the newer snapshot.

## Input Protocol

Guests send fire intents. Hosts and solo apply the same intent path locally.

```js
{
  type: 'combat_intent',
  action: 'gun.fire',
  weapon: 'rifle',
  shotSeq: 42,
  clientFireTime: 123456.7,
  origin: [x, y, z],
  dir: [x, y, z],
  playerStateSeq: 188
}
```

Field rules:

- `shotSeq`: monotonically increasing per shooter. Host drops duplicates/out-of-order values.
- `clientFireTime`: diagnostic and optional lag-comp input. Never trusted alone.
- `origin`: camera/muzzle origin as seen by the shooter. Host validates against the shooter's authoritative capsule/head position.
- `dir`: normalized or normalizable aim vector. Host clamps invalid/zero vectors.
- `playerStateSeq`: optional later improvement for associating a shot with the most recent accepted movement packet.

Host should also support local host firing through the same function:

```js
applyCombatIntent(intent, 'host')
```

## Host Validation

The host must reject a shot when:

- Shooter id is missing or not present.
- Shooter is dead.
- Weapon id is unknown or not equipped.
- Fire interval has not elapsed.
- `shotSeq` is stale or duplicate.
- `origin` is too far from the shooter's current or rewound head/muzzle position.
- `dir` is invalid.
- The shot exceeds weapon range.

Recommended origin validation:

- Derive a canonical muzzle/head origin from the shooter capsule and yaw.
- Allow the submitted `origin` only within a small radius, e.g. `<= 1.25m`, to absorb client camera/head mismatch.
- Use the canonical origin for actual raycast if submitted origin fails, or reject. First implementation should reject to expose bugs.

## Lag Compensation

Current guest movement arrives as 20 Hz `player_state`, so strict current-host-pose hits will feel late. Add a small host-side history for player capsules:

```js
playerPoseHistory: Map<playerId, [
  { hostTimeMs, p, q, h, r, alive, hp }
]>
```

Keep the last 750 ms per player.

When resolving a guest shot:

1. Estimate rewind target time.
2. Sample all target player capsules from history at that time.
3. Resolve the ray against those capsules.
4. Apply damage to the current host-owned player health.

First implementation can use:

```js
rewindMs = 100;
targetTime = hostNowMs - rewindMs;
```

Better follow-up:

- Add relay ping/pong or host echo to estimate per-client RTT.
- Use `targetTime = hostNowMs - clamp(rttMs * 0.5, 0, 200)`.
- Keep a hard max rewind of 250 ms to avoid unfair corner shots.

Host player firing can use current poses with no rewind.

## Hit Geometry

Use capsule-vs-ray math against player capsules. Do not rely on rendered meshes for hit registration.

For each target player:

- Capsule vertical segment:
  - `center = p`
  - `radius = r`
  - `height = h`
  - `start = [p.x, p.y - h * 0.5, p.z]`
  - `end = [p.x, p.y + h * 0.5, p.z]`
- Intersect ray segment `[origin, origin + dir * range]` against capsule.
- Return earliest valid hit distance.

Ignore:

- The shooter.
- Dead targets.
- Targets outside range.

Optional first pass:

- No terrain occlusion between players. This is acceptable only for a fast prototype.

Required for the milestone:

- Block hits through authored-map collision when `mapCollider` is active.
- Block hits through analytic/procedural terrain when the ray samples below `terrainHeight(x, z)`.
- Tree/dressing occlusion can be deferred unless it is already cheap to query.

Damage rules:

- Apply `target.hp = max(0, target.hp - weapon.damage)`.
- Set `alive = hp > 0`.
- On death, keep the player in snapshots but mark `alive:false`.
- Respawn can be a later input (`combat_intent`, `player.respawn`) or reuse reset locally once host-authorized.

## Visual Effects

Use the entity registry for replicated combat effects, not direct renderer calls.

Add lightweight wire entities or reuse a generic `effect` adapter:

```js
{
  id,
  type: 'effect',
  kind: 'gun_tracer',
  ownerId,
  p0: [x, y, z],
  p1: [x, y, z],
  color: [1, 0.85, 0.45],
  lifespan: 0.09
}
```

```js
{
  id,
  type: 'effect',
  kind: 'hit_spark',
  ownerId,
  p: [x, y, z],
  normal: [x, y, z],
  lifespan: 0.2
}
```

First implementation can render these locally from a small non-physics effect renderer. They should be snapshot-owned by the host so guests see the same shot result.

Remote player visuals:

- Extend `GhostRenderer` player groups with a simple gun mesh parented between/near the orb hands.
- Drive muzzle flash/recoil from `fireSeq` changes.
- Hide or lower the gun when `alive:false`.

Local visuals:

- Extend `player-hands.js` to add a small first-person gun mesh between the orbs.
- Existing `viewHands.recoil()` can be reused for shots.
- Add a tiny muzzle flash mesh/light that is local-predicted immediately, then host-confirmed effects arrive through snapshots.

## Prediction Policy

Local shooter feedback should be immediate:

- Recoil immediately.
- Muzzle flash immediately.
- Play local shot sound immediately once audio exists.

Damage feedback must be host-confirmed:

- Do not reduce remote player health from client-side prediction.
- Guest may show a tentative crosshair hit marker only if local ray math predicts a hit, but final hit marker/damage should be driven by host result/effect.

## Host State Ownership

Add a host-owned player combat facade near `mpGuestPlayers`:

```js
const playerCombat = createPlayerCombatFacade({
  claudecraftCreatures, // optional; present only in host/solo when that plan is enabled
});
```

`getState()` merges combat state into each player snapshot through `playerCombat.getSnapshot(id)`. For guests, the host must not trust incoming `player.hp`, `player.alive`, or `player.lastShotAt`.

When a `player_state` arrives:

- Accept pose fields after shape/range validation.
- Preserve/merge host-owned combat fields.
- Push pose into `playerPoseHistory`.
- If ClaudeCraft creatures are enabled, mirror the accepted pose into the ClaudeCraft external-player bridge.

When `guest_left` arrives:

- Remove pose and history records.
- Remove/release the corresponding ClaudeCraft external player if that bridge is active.
- Remove fallback combat state only if the fallback backend is being used.

## File-Level Plan

### New files

- `combat.js`
  - Pure weapon definitions, cooldown checks, ray/capsule hit test, damage reducer, pose-history sampling.
  - Node-testable; no Three import.

- `test-combat.mjs`
  - Ray/capsule hits, misses, nearest-target ordering, cooldown rejection, duplicate `shotSeq`, rewind sampling, death transition.

- Optional later: `entity-types/effect.js`
  - Generic short-lived effect adapter for tracers/hit sparks.

### Modify `environment-viewer.html`

- Add `combat_intent` handling beside `entity_intent`.
- Capture LMB for gun firing when gun mode is active.
- Build host combat state into `getState()`.
- Update guest `player_state` receive path to keep host-owned combat fields.
- Call shared `applyCombatIntent()`.
- Add local first-person gun setup.

### Modify `multiplayer.js`

- Extend `_lerpPlayers()` for `hp`, `alive`, `weapon`, `firing`, `fireSeq`, `lastShotAt`.
- Extend `GhostRenderer` player group with a simple held gun mesh and fire animation.
- Keep combat effects under `entities` if effect entities are added.

### Modify `player-hands.js`

- Add optional gun mesh to first-person hands.
- Add `setWeapon(id)` if more than one weapon is expected.
- Reuse `recoil()` for gun shots.

### Modify docs

- Update `docs/subsystems/multiplayer.md` after implementation with the new protocol and player wire shape.

## Milestones

### M1: Pure Combat Core

- Implement `combat.js`.
- Unit-test ray/capsule hit registration and damage.
- No rendering or networking yet.

Acceptance:

- A ray through a capsule returns the expected target and distance.
- A closer player wins over a farther player.
- Shooter cannot hit self.
- Cooldown and duplicate sequence checks reject shots.
- Damage transitions `hp` to `0` and `alive:false`.

### M2: Host-Authoritative Damage

- Add `combat_intent`.
- Host resolves guest and host shots.
- Host applies player damage through `playerCombat.applyDamage()`, not by mutating player snapshots directly.
- Player snapshots include `hp` and `alive`.
- Guests see health changes through snapshots.

Acceptance:

- Guest A shoots Guest B; only host applies damage.
- Forged guest `hp` fields in `player_state` are ignored.
- Rapid fire above weapon rate is rejected.
- Duplicate shot packet does not double damage.
- If ClaudeCraft creatures are active, gun damage and mob damage reduce the same HP pool.

### M3: Held Gun Visuals

- Add first-person gun mesh.
- Add remote ghost gun mesh.
- Replicate `fireSeq` so remote firing animates.

Acceptance:

- Local player sees gun in FPS mode.
- Host sees guest holding/firing gun.
- Guest sees host/other guests holding/firing gun.
- Gun visuals hide or lower for dead players.

### M4: Effects and Occlusion

- Add tracer/hit effect entities.
- Add terrain/map occlusion to host hit tests.

Acceptance:

- All clients see the same tracer/hit spark.
- Shots do not damage through authored map geometry.
- Procedural terrain blocks shots when line samples below `terrainHeight`.

## Security and Abuse Limits

This cannot be fully cheat-proof while clients run in browsers and one browser is the host. Still enforce:

- Host-owned damage.
- Host-owned cooldown.
- Bounded origin trust.
- Bounded rewind.
- Duplicate shot rejection.
- Max shots per second per client.
- Numeric validation for all arrays and scalars.
- Drop malformed intents silently or with throttled console diagnostics.

## Why Not a Physics Library Yet

The first gun implementation needs ray queries against player capsules, plus optional terrain/map occlusion. That is smaller and more controllable than integrating a full rigid-body engine. Rapier remains the best candidate if later work needs grenades, physics props, ragdolls, or physically simulated projectiles, but it should not be required for hitscan player damage.

