# Base game: weapons, in four phases

Date: 2026-08-22. Status: PLAN, not started. Decision: weapon choice is **per player** and replicated.

| Phase | Deliverable |
|---|---|
| 1 | Third-person weapon holding on local + remote bodies, replicated weapon id, aim, reload |
| 2 | First-person presentation as a blend between the body's hold and an authored viewmodel, on the same rig |
| 3 | Firing, ammo, damage, muzzle flash, tracers, server-authoritative hits |
| 4 | Stowed weapons on the body and weapon transitions (holster/draw/swap) |

Each phase lists what it builds and, in **Seams**, what it does now only so the next phase fits.

## What already exists (reuse, do not rewrite)

| Piece | What it gives us |
|---|---|
| `weapons.js` | defs: `model` GLB, `thirdPersonHold`/`crouchHold`/`proneHold`, `carryClass`, `viewOffset`, `recoil`, `mode: hitscan` or `projectile{}`, `damage`, `magazineSize`, `reserveAmmo` |
| `weapon-anchors.json`, `weapon-poses.json` | per-weapon IK anchors (grips, muzzle, magwell, chargingHandle), shared `weaponPoses`, `reloadSequence` |
| `weapon-hold-resolver.js` (Contract 6) | `resolveWeaponHold`, `carryDeltaFor`, `locomotionFor`, `stepCarryBlend`, one-handed dash rule |
| `weapon-pose-controller.js` (Contract 5) | drives `body.setArmTarget` for both hands from a `weaponView` Object3D; aim blend, recoil, reload sequence with events |
| `weapon-sequence.js` | `evaluateSequence`, `resolveTargetRef` (weapon/body/camera-rooted refs) |
| `weapon-part-batches.js` | instanced pool for every held GLB, `bakeSkinnedGeometry` |
| `bot-viewer-v3.html` mount code | `loadBotWeaponMount` / `updateBotWeaponMount` / stow block (~450 lines): the reference wiring |
| `environment-viewer.html` viewmodel | camera-attached GLB + orb hands, FP reload choreography from the same sequence data, `viewOffset` per weapon |
| `bot-body-hit.js` | `resolveBodyHit({body, origin, dir})` ray vs. rig parts, limb attribution |
| `tracer-visual.js`, `ballistic-audio.js`, `bot-projectiles.js`, `explosion-tier.js` | tracer segments, whizz/ricochet, grenade/RPG arcs, blast tiers |
| `map-collision.js` / `world-query.js` | collider raycast for hitscan against the world |

The rig seam stays `body.setArmTarget(side, {position, quaternion, weight, hint})`. The free-arm
pose model (`armCfg`) already yields to a weapon target by its weight.

---

## Phase 1 — Third-person holding

### 1.1 `weapon-mount.js` (extract v3's mount, copy-first)

```js
createWeaponMountSystem({ THREE, scene, loadGLB, anchorsUrl, posesUrl })
  .createMount(body, weaponId) -> Promise<mount>
  .updateMount(mount, dt, frame)    // frame: see below
  .flush()                          // instanced pool write, once per page frame
  .destroyMount(mount)
  .templateFor(weaponId)            // cached {bakedAnchors, instanceParts, bounds}
```

`frame` = `{ feetY, bodyPosition, yaw, stanceWeights, locomotion, aiming, aimPoint, motion, aimChannels, viewFrame?, viewBlend? }`.

- The mount root is Contract 6 unchanged: rig at `terrainHeight + 1.5`, bob/sway re-added.
- The mount exposes `mount.muzzleMarker` world matrix and `mount.controller` (pose controller),
  and an `events` callback forwarding the sequence events (`detachMagazine`, …).
- v3 keeps its own code until 1.4; the module is a copy, with `stepBarrelTrim` and the M1/M5/M10
  perf notes carried over.

Test `test-weapon-mount.mjs`: headless body + fake template; both hands land on grip anchors,
carry deltas move the hold per locomotion, dash releases the left hand, `flush` writes N instances.

**Seams for later phases**
- `updateMount` accepts an optional `viewFrame` (world-space transform of the owner's authored
  viewmodel) and `viewBlend 0..1`, and blends it with the resolved hold before the controller
  update. Phase 1 never passes one (blend 0). Phase 2's whole first-person model hangs off this
  one argument.
- `mount.muzzleWorld(out)` and `mount.barrelDirection(out)` helpers now; phase 3 fires from them.
- `updateMount` takes an optional `drawBlend 0..1` and applies it as a lerp from `def.holsterHold`
  (if present) to the resolved hold. Phase 4 drives it; phase 1 leaves it at 1.
- The template cache returns `bounds` (Box3) and a `reducedParts` list (v3 uses a reduced part
  list for stowed guns); phase 4 reads it without re-baking.

### 1.2 `base-game-player-weapons.js`

Per body (local and remote) one mount record; owned by `base-game-player-bodies.js`, which knows
every body and its sample.

- `playerBodies.setWeapon(id | null, playerId = local)`. A design swap rebuilds the body, so the
  mount is re-created against the new body (`setBodyDesign` calls it).
- In `feed()` after `body.update`: `updateMount` with `grounded`, speed → `moving`, stance (stand
  only until crouch ships), `aiming`, `aimPoint` (camera ray for local; from `aimPitch` + yaw for
  remotes), `action` (reload start tick) so remotes play the same sequence.
- `flush()` after `endRemoteFrame`.

**Seams**
- The record is `{ mount, weaponId, ammo: null, action, actionTick }`. `ammo` is a placeholder
  phase 3 fills; keeping the shape now means the snapshot → record path does not change later.
- The local mount keeps updating in first person (drawn or not): it is the replicated tracer
  origin and one of phase 2's two blend inputs. Only its draw is masked.

### 1.3 Page (`base-game.html`)

- Settings: `playerWeapon` dropdown (`none` + every `weapons.js` id with a `model`, default
  `cz_805_bren`), saved with the rest.
- Keys: `1`–`7` select, `R` reload (sequence only), right mouse = aim.
- Third-person aim: controller aim blend toward the camera ray, and the rig's aim channels
  (torso pitch/twist) fed from the mouse like v3 feeds them from the bot's aim. Phase 2 depends on
  the body carrying the gun toward the crosshair, so this is not optional.

### 1.4 Protocol v4 (replication)

- Tick input: `weapon: uint8` (index in `BASE_GAME_WEAPON_LIST`, shared), `aim: 0|1`,
  `reload: 0|1` (edge).
- Player state: `weapon`, `aiming`, `aimPitch`, `action: 0 idle | 1 reload`, `actionTick`.
- Server sanitizes and echoes; no simulation yet. `sanitizeBaseGameTickInput` /
  `sanitizeBaseGamePlayerState` gain the fields. Version bump rejects old clients.

**Seams**
- `action` is an enum, not a bool, and carries `actionTick`: phase 3 adds `2 fire`, phase 4 adds
  `3 holster`, `4 draw` without changing the shape.
- Tick input reserves `fire: 0|1` now (sent as 0, ignored by the server) so phase 3 is additive.
- The weapon list index is the one id both sides agree on; phase 3's server fire validation and
  phase 4's loadout both key on it.

Tests: `test-base-game-replication.mjs` round-trips the fields; a remote body gets a mount from
the snapshot and swaps when the id changes.

### 1.5 Switch v3 to `weapon-mount.js`, docs, log

No-behaviour-change refactor with the v3 weapon tests green. Docs: `base-game.md` (new Weapons
section), `procedural-body-weapon-contracts.md` (Contract 6 owner is now `weapon-mount.js`),
`bots.md`, `agent_log.csv`.

---

## Phase 2 — First-person presentation: the blend model

Decision 2026-08-22: no arms-only rig. One authoritative state (weapon, action, aim) and one
full rig per player; first person is a **presentation** of that state for the owner only, blended
between two poles on two independent axes. Remotes always see the third-person mount.

References, each the best at one thing:

| Concern | Source |
|---|---|
| Gun placement on screen, ADS, bob, recoil, reload deltas in FP | `environment-viewer.html` `createLocalWeaponViewModel` (authored `viewOffset`/`viewRotation`/`aimOffset`/`aimRotation` in `weapons.js`, `feel.*` bob tunables, `reloadPoseDelta`) |
| Eye position on the real head, comfort damping, head-relative look | `bot-viewer-v3.html` POV (`botPovAnimatedEyePoint` from `eyeCfg`, `CAMERA_POV_COMFORT_PRESETS`) |
| Arms, grips, reload choreography | pose controller + rig, shared by everything |

### 2.1 Two axes

| Axis | Pole 0 | Pole 1 | Parameter |
|---|---|---|---|
| Camera | damped to the body's head (v3 comfort) | rigid on the mouse (env-viewer) | `cameraComfort`: off / light / strong (v3 table) |
| Gun + arms | the body's solved third-person hold seen from the eyes (v3 POV) | authored camera-space viewmodel (env-viewer) | `viewBlend` 0..1 |

Every frame the owner's mount computes both gun frames: the third-person hold in world space
(Contract 6, what remotes see) and the viewmodel frame in camera space (env-viewer's
`applyToolTransform`, converted to world). `weaponView` = lerp of the two by `viewBlend`
(position lerp, quaternion slerp). The pose controller reads that one `weaponView` and drives the
arms as usual, so hands, elbows and reload choreography are correct at any blend.

Overrides on `viewBlend`, eased: ADS → 1 (sights must be stable), sprint → toward 0 (the body's
run carry shows), reload → hold the current value. `cameraComfort` is forced off while aiming so
the crosshair and the camera never disagree.

### 2.2 Presets (all just numbers)

| Preset | cameraComfort | viewBlend |
|---|---|---|
| Arcade (env-viewer) | off | 1 |
| Embodied (v3 POV) | light | 0 |
| Hybrid (default) | off | 0.6 |

Dropdown for the preset, sliders for `cameraComfort` rate scale and `viewBlend`, saved to disk
with the rest of the settings.

### 2.3 Pieces

- `weapon-viewmodel.js`: port of env-viewer's viewmodel maths (bob model, ADS lerp, carry lean,
  recoil kick, reload delta, `viewBob`) with no rendering of its own; it outputs a camera-local
  transform and reads the GLB template from `weapon-mount.js`'s cache so FP and TP share baked
  anchors. Test: pure maths on fake weapon defs.
- `weapon-mount.js`: `updateMount` takes an optional `viewFrame` + `viewBlend` and blends before
  the controller update (seam 1.1).
- Rig: the local body stays the full rig in FP (legs for look-down). Add a per-part visibility
  mask (`body.setPartMask({ head: false, torso: false })`) so the head and torso do not clip the
  camera; arms, hands, gloves and sleeves stay. The shoulder line is pinned to a camera-relative
  frame with weight = `viewBlend` so elbows solve sensibly when the gun sits at the authored
  screen position.
- Camera: eye anchor from `eyeCfg` through the head (v3), comfort damping from the v3 table
  scaled by `cameraComfort`, small `viewBob` from the viewmodel at any blend.
- Rendering: arms + gun in a late pass with depth cleared so they never clip walls; shadows off.
- Muzzle: the replicated tracer origin is always the third-person mount's `muzzleWorld()`; the
  owner's flash spawns at the blended `weaponView` muzzle. Remotes unaffected.

### 2.4 Known limits

At low `viewBlend` the gun can leave the screen when the body twists its torso (aim channels)
or drops into a stance; that is the embodied pole by design and why ADS forces 1. Comfort damping
plus a rigid crosshair is contradictory, hence the aiming override.

### 2.5 Tests, docs

`test-weapon-viewmodel.mjs` (bob/ADS/recoil maths); `test-base-game-player-body.mjs`: at
`viewBlend` 0 the hands sit on the TP grips, at 1 on the viewmodel grips, at 0.5 midway; the
part mask hides head/torso and keeps arms; a reload moves the left hand to the magwell at every
blend. Docs: `base-game.md` (first-person section with the preset table),
`procedural-body-weapon-contracts.md` (Contract 5 gains the blended `weaponView` note and the
part mask), `agent_log.csv`.

**Adjustments to phase 1 required by this phase**
- Seam 1.1 is `viewFrame` + `viewBlend` on `updateMount`, not a `root: 'camera'` option.
- Phase 1 feeds `aimChannels` to the mount from the start: the embodied pole depends on the body
  carrying the gun toward the crosshair.
- Phase 1's local third-person mount keeps updating while in first person (not hidden and
  frozen): it is the tracer origin and one of the two blend inputs.

---

## Phase 3 — Firing, ammo, damage, muzzle flash

STATUS 2026-08-23: hitscan firing, ammo, health, death/respawn, lag compensation and hit/death
events SHIPPED on `combat.js` + `player-combat.js` + `player-ammo.js` (lifted from the environment
viewer) with `base-game-fire.js` as the lockstep trigger step; see `docs/subsystems/base-game.md`
"Weapons, phase 3". Later the same day: seeded spread (`bot-aim.js`), tracers / muzzle flash /
sparks / explosions (`effect-renderer.js`), and server projectiles (`bot-projectiles.js` +
`entity-types/explosion.js`) SHIPPED, then blast debris (`blast-debris*.js`) and the explosion /
muzzle light (`flash-lights.js`, extracted from bot-viewer-visuals). Still open: melee, head
multiplier, remote recoil kick.

Goal: shots are server-authoritative, feel instant for the shooter, and read on every client.

### 3.1 Data

`weapons.js` already has `damage`, `magazineSize`, `reserveAmmo`, `recoil`, `mode`. Add per weapon
`fireIntervalMs`, `spreadDeg` (stand/move/aim), `range`, `auto: bool` where missing; keep the
defaults in one `WEAPON_FIRE_DEFAULTS`.

### 3.2 Client: `base-game-fire.js`

- Input: `fire` edge/hold in the tick (seam 1.4). Client predicts: rate gate, ammo decrement,
  recoil kick (`controller.kick()`), muzzle flash at `mount.muzzleWorld()` (FP or TP mount per
  view), tracer via `tracer-visual.js` from the **third-person** muzzle for everyone including
  yourself (the FP flash is local only, as env-viewer does).
- Reload: consumes ammo from reserve at the sequence's `commitAmmoAt`; `R` and auto-reload on dry.
- Spread from stance/move/aim, seeded per tick so replay is bit-for-bit (prediction history
  already keys by tick).

### 3.3 Server

- Tick input `fire` is consumed by `stepClient` like movement: the server keeps `ammo` per client,
  rate-gates, and for `hitscan` raycasts the world collider (`world-query.js`) and every other
  player's body. Body hits: the server has no rig, so use a capsule (head/torso/legs three-segment)
  derived from the player state; `bot-body-hit.js` stays a client cosmetic for decals/wound reads.
- Lag compensation: rewind other players to `tick - rttTicks` using the existing remote tracks'
  history (server keeps ~250 ms of positions per client).
- Projectiles (grenade/RPG): server-simulated with `bot-projectiles.js` arcs; clients render from
  replicated projectile entities.
- Snapshot additions: `health`, `ammo` (mag, reserve) for self; `action: 2 fire` with
  `actionTick` for remotes (so they play flash + tracer); `hits[]` events (shooter, victim, point,
  normal, limb, damage) for decals/blood/wound audio; `deaths[]`.
- Kill plane and respawn already exist; death = health 0 → respawn through `respawnClient`.

### 3.4 Feedback

- Hit markers, damage numbers optional; blood/sparks from `effect-renderer.js` / `projected-decals.js`
  keyed by surface class (`ballistic-audio.js surfaceClass`); SFX from `sound-events.js` +
  `weapon-sfx-synth.js`; whizz/ricochet from `ballistic-audio.js`.
- Remote bodies play `controller.kick()` on `action: fire`.

### 3.5 Tests

Replication: fire ticks gate by rate and ammo on both sides identically (replay equals server);
hitscan hits a rewound player; reload commits ammo at the right sequence time. Projectile arc
matches `bot-projectiles.js`.

**Adjustments to phases 1–2 required by this phase**
- Phase 1: `action` enum + `actionTick` (already in seams), reserved `fire` tick field, server
  keeping ~250 ms of per-client position history (cheap to add in phase 1's `base-game-rooms.js`
  since the remote tracks already exist client-side; do it server-side in phase 1 so 3.3 is not a
  refactor).
- Phase 1: `sanitizeBaseGamePlayerState` includes `health` (100, echoed) so the HUD and snapshot
  shape do not change in phase 3.
- Phase 2: the owner's flash spawns at the blended `weaponView` muzzle; the tracer origin is the
  third-person mount's `muzzleWorld()` at every blend.

---

## Phase 4 — Stowed weapons and transitions

Goal: a loadout of primary + sidearm, the unused one visible on the body, holster/draw with the
arms doing the motion, and a weapon swap that remotes see.

### 4.1 Stowed visuals

Port v3's stow block into `weapon-mount.js` as `createStow(body, weaponId, slot)`: reduced part
list + a per-frame matrix into the same instanced pool; long guns slung across the back, pistols on
the right hip (`stowPlacementFor`). Knife/grenade: belt. Uses `templateFor().reducedParts` from 1.1.

### 4.2 Transitions

- `action: 3 holster`, `4 draw` with `actionTick` (seam 1.4). Duration from
  `weapons.js` `holsterMs`/`drawMs` (defaults: pistol 350/300, rifle 600/550, v3's
  `SIDEARM_DRAW_MS` as reference).
- Motion: `drawBlend` (seam 1.1) lerps the hold from `def.holsterHold` (a hold authored near the
  stow point: back for rifles, hip for pistols) to the live hold; the pose controller's hands follow
  because they read `weaponView`. Holster is the reverse. The stowed copy hides when the held copy
  appears and vice versa at the blend midpoint.
- Swap = holster current + draw next; server enforces no-fire during the window (3.3 rate gate
  reads `action`).
- Dry-mag swap to sidearm is a client choice (v3 `swapOnDryMag`), not automatic.

### 4.3 Loadout

- `BASE_GAME_LOADOUTS`: primary list + sidearm list; tick input `weapon` becomes a slot
  (`0 primary`, `1 sidearm`, `2 melee`, `3 throwable`), the loadout itself is set in the handshake
  and echoed in state. Keys: `1`–`4` slots, `Q` last weapon, wheel cycles.
- HUD: slot icons, ammo per slot.

### 4.4 Tests, docs

Stow placement lands on the body attach (back/hip) across designs; holster→draw plays the hold
lerp and the hands track it; swap is refused while a reload is in progress; remotes show the stow
and the swap from the snapshot.

**Adjustments to earlier phases required by this phase**
- Phase 1: `drawBlend` + `def.holsterHold` on the mount (seam), `reducedParts`/`bounds` in the
  template cache (seam). Also author `holsterHold` for the two pistols and two rifles while the
  holds are being checked in phase 1, since the author session is already open.
- Phase 1 protocol: send `weapon` as a **slot index from the start** with a fixed default loadout
  (primary `cz_805_bren`, sidearm `five_seven`, melee knife, throwable grenade) rather than a raw
  weapon index. That way phase 4 adds the loadout handshake without changing the tick shape. The
  phase-1 dropdown then sets the *primary* of the default loadout.
- Phase 3: ammo is per slot, not per body. The `ammo` placeholder in 1.2 becomes `ammo[slot]`.

---

## Order, size, risk

1. Phase 1: ~2 sessions. Biggest risk is the v3 extraction; copy-first keeps v3 safe.
2. Phase 2: ~1.5 sessions (viewmodel port, blend, part mask, presets). Risk: elbows at mid
   blend; the shoulder pin weight is the tuning knob.
3. Phase 3: ~2 sessions. Risk: lag compensation correctness; test with artificial latency.
4. Phase 4: ~1 session; mostly data authoring once the blend seam exists.

## Out of scope for all four

Bots in base-game, vehicles, attachments/optics, per-weapon first-person animations beyond the
shared sequences, weapon pickup from the world.
