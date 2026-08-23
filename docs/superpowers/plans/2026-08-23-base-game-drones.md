# Base game: quadcopter and recon UAV, autonomous and pilotable

Date: 2026-08-23. Status: PLAN, not started. Decisions: drones are **server-simulated entities**; the
autonomous brain is `bot-drones.js` unchanged; piloting reuses `flight-model.js` behind the same
`stepOnce` contract the player capsule already has.

| Phase | Deliverable |
|---|---|
| 0 | Health and damage on the server (prerequisite, owned by the weapons plan Phase 3) |
| 1 | Server entity list + replicated `entities[]` + client presentation of the quad and the recon craft |
| 2 | Autonomous sorties: bomb drops and loiter dives through the blast path, player-launched |
| 3 | Piloting: possession, predicted flight controller, flyer camera, HUD |
| 4 | Ordnance from the seat, tether and signal loss, handback |

Each phase lists what it builds and, in **Seams**, what it does now only so the next phase fits.

## What already exists (reuse, do not rewrite)

| Piece | What it gives us |
|---|---|
| `bot-drones.js` | zero-import, deterministic AI for `bomber` (quad, hovers) and `loiter` (fixed wing): `createDrone`, `stepBotDrone(d, dt, world)`, `orphanDrone`, `crippleDrone`, `pickDroneTarget`, `decideDroneLaunch`, `pickAirTarget`, `airLeadPoint`; Node-tested in `test-bot-drones.mjs` |
| `flight-meshes.js` | `buildCraftMesh('drone' \| 'recon', tint, { standard, basic })`; `userData.rotors` spin about Y, `userData.propeller` about Z; nose is −Z |
| `flight-model.js` + `flight-airframes.js` | `makeFlyer(key)`, `stepFlyer(f, dt)`: stick-driven flight; the quad airframe (`body-up` thrust, `attitude` control) is registered, the recon is not |
| `bot-viewer-v3.html:12998-13160` | reference mesh build, pose (`lookAt` → `rotateY(π)` → `rotateZ(bank)`), rotor spin, `droneBlastWeapon` adaptor, `updateBotDrones` tick |
| `base-game-player-controller.js` | the `stepOnce / captureState / applyState / interpolatedPosition` contract a second controllable body must match |
| `base-game-prediction.js` | tick replay and reconcile against the authoritative snapshot, soft-correction offset |
| `base-game-remote-players.js` | `createRemoteTrack` interpolate/extrapolate/hold, pooled release by id |
| `server/base-game-rooms.js` | 120 Hz lockstep `stepRoom`, 20 Hz full `snapshot`, `BASE_GAME_POSITION_HISTORY` for lag compensation |
| `base-game-terrain.js` | `groundHeight(x, z)`, `killPlaneYAt`, `update(globalPosition, dt)` streaming focus |
| `base-game-audio.js`, `sound-events.js` | per-id remote audio budgeting, event registry (`rocket_launch`, `explosion` exist) |
| `docs/superpowers/plans/2026-08-22-base-game-weapon-holding.md` Phase 3 | server hitscan, `health` in the snapshot, projectile entities |

Not used: `flight-drones.js`. It is `THREE`-coupled, depends on `flight-combat.js`'s missile model,
and its three kinds (decoy, kamikaze, interceptor) answer air-to-air threats the base game does not
have.

---

## Phase 0 — Health (prerequisite)

DONE 2026-08-23: weapons phase 3 shipped health on the server through `player-combat.js`
(`room.combat.applyDamage({ targetId, amount, source, attackerId, hitPoint, weaponId })`), with
death, respawn and the snapshot `hits[]` / `deaths[]` events. Drone blasts call the same facade.

---

## Phase 1 — Entities: simulate, replicate, present

### 1.1 Server entity list

`server/base-game-entities.js` (new, plain Node, no `three`):

```js
createRoomEntities({ heightAt })                  // heightAt from the room's terrain source
  spawn(kind, from, { ownerId, team, yaw })       // wraps bot-drones createDrone, returns id
  step(dt, { players })                           // one call per accumulator step, inside stepRoom
  remove(id)
  snapshotEntries()                               // → entities[] for snapshot()
  drainEvents()                                   // one-shot drop / detonate / crash / done
```

`step` builds the `world` argument for `stepBotDrone` per drone: `groundY = heightAt(x, z)`,
`home` at the owner's position, `target` from the nearest enemy player (Phase 2 refines this). The
drone sim runs **only on the server**; clients never predict it, so
`test-base-game-replication.mjs`'s bit-for-bit replay is untouched.

### 1.2 Protocol

`base-game-protocol.mjs`: bump `BASE_GAME_PROTOCOL_VERSION` to 8 (the handshake rejects mismatches,
so old clients fail loudly rather than missing entities). Add:

```js
sanitizeBaseGameEntityState({ id, kind, ownerId, team, p, yaw, pitch, bank, state, hp, pilotId })
sanitizeBaseGameEntityEvent({ kind: 'drop'|'detonate'|'crash'|'launch'|'done', id, p, v })
```

`snapshot()` gains `entities: [...]` and `events: [...]` (events are the ones drained since the
previous snapshot; a client that misses a snapshot misses the FX, never the state).

### 1.3 Client presentation

`base-game-entities.js` (new, browser):

```js
createBaseGameEntities({ THREE, scene, worldCoordinates, audioDirector })
  ingestSnapshot(snapshot, now)     // createRemoteTrack per id, release on absence
  update(now, dt, { interpolationDelayMs })   // pose meshes, spin rotors/propeller
  meshFor(id)
```

Mesh build and pose are lifted from `bot-viewer-v3.html:12998-13160`: `buildCraftMesh` with
`MeshStandardNodeMaterial` / `MeshBasicNodeMaterial` factories, `DRONE_MESH_SCALE` kept, every
position through `worldCoordinates.toRenderLocal()`. Hook into `animate()` directly after the
remote-player block (`base-game.html:2077-2108`) and reseat on `onRebase`.

### 1.4 Launch (temporary)

A debug key spawns a bomber or loiterer at the local player via a new `base:spawn_entity` message
(owner-only, rate-limited). Phase 2 replaces this with a loadout slot.

### 1.5 Tests

- `test-base-game-entities.mjs`: spawn, step over a flat `heightAt`, snapshot entry shape through the
  sanitizer, release on absence, rebase independence, orphan on owner disconnect.
- `test-base-game-replication.mjs`: protocol 8 rejected by a 7 client; `entities[]` survives the
  sanitizer; player replay still bit-for-bit.

### Seams

- Entity records carry `pilotId: null` from day one so Phase 3 only flips it.
- `step` takes `dt` and a per-entity `stepFn`, so a piloted flyer can be stepped by a different
  function in the same list.
- Events carry `p` and `v` as global arrays, which is what FX and audio need later.

---

## Phase 2 — Autonomous sorties

### 2.1 Targets and vetoes

Server-side `droneTargetPoint` modelled on `bot-viewer-v3.html:13061`: nearest enemy player, `stale`
after `DRONE_SEED_MAX_AGE_MS`, `holdFire` when a friendly is inside `blastRadius` of the aim point.
LOS through `world-query.js` `raycast`; without a collider provider on the server this degrades to
terrain-only occlusion via `heightAt` sampling along the ray.

### 2.2 Blast as a weapon

Port `droneBlastWeapon(kind, def)` (`bot-viewer-v3.html:12980`): a bomb drop or a loiter detonate
becomes `{ id: 'drone_bomb' | 'drone_kamikaze', damage, projectile: { blastRadius } }` and goes
through the weapons plan's server projectile path, so falloff, kill credit and lag compensation come
free. Bombs are server projectiles replicated like any other; the `drop` event is for sound only.

### 2.3 Launch from the loadout

`base:loadout` gains `drones: { bomber: n, loiter: n }`. A tick action code
(`BASE_GAME_WEAPON_ACTION.launchDrone`) releases one at the player's position along their yaw,
gated by `decideDroneLaunch` with a kit per player (`createOperatorKit`). Spares count down; the
HUD shows `describeDrones`-style text.

### 2.4 Damage to drones

`damageDrone` on the server (`bot-viewer-v3.html:13254` is the reference: deadstick roll, then
`done` before detonating). Hitscan against a drone capsule of `def.bodyRadius` at `d.p` joins the
player capsule list in the weapons plan's hit resolver.

### 2.5 Audio and FX

Register `drone_rotor` (loop) and `drone_prop` (loop) in `sound-events.js`; `rocket_launch` on
launch, `explosion` on wreck and warhead. Client FX on `detonate` / `crash` events reuse whatever
explosion the weapons plan ships (`explosion-tier.js` is the candidate).

### 2.6 Tuning

`DRONE_DEFS` are arena-scale (`cruiseAlt 14`, `speed 9`, 50 m map). Expose a per-room override in
`world` settings and save it to a file via `disk-store.js` and a `serve.py` route, never
`localStorage`. Expect `cruiseAlt`, `speed`, `orbitRadius`, `diveRadius` to roughly double on open
terrain; that is a guess until flown.

### Tests

- `test-base-game-entities.mjs`: a bomber drops on a walking player within `dropWindow`; a friendly
  under the aim point holds fire; a loiterer dives a stale target and ends on ground contact;
  `damageDrone` never detonates twice.

---

## Phase 3 — Piloting

### 3.1 Flight controller behind the capsule's contract

`base-game-flyer.js` (new, shared browser + server, imports `three` and `flight-model.js`):

```js
createBaseGameFlyer({ airframe, heightAt, spawn })
  stepOnce(input)             // input = sanitized tick; pitch/roll/yaw/throttle derived here
  captureState() / applyState(s)
  interpolatedPosition(alpha, out)
  getPosition(), getVelocity(), getAttitude()   // yaw, pitch, bank
  crashed()                   // ground contact below def tolerance, or hp 0
```

Tick mapping: `moveZ` → pitch, `moveX` → roll, look `yaw` delta → yaw, look `pitch` → camera
only, `sprint` → boost, new field `throttle` (0–1) added to `sanitizeBaseGameTickInput`. The quad
uses its registered airframe; add a `recon` airframe to `flight-airframes.js` (`wing` lift,
`axial` thrust, `rate` control, low reference speed) with a `validateAirframe` test.

Determinism: `flight-model.js` reads no clock and no `Math.random`, so Node and browser stepping
agree bit-for-bit; extend `test-base-game-replication.mjs`'s hard-snap/exact-replay case to a flyer.

### 3.2 Possession

`base:possess { entityId }` and `base:release`. Server sets `client.controlling`; `stepClient`
routes the tick into the flyer instead of the player controller and feeds the capsule neutral input
(the path frozen players already take). The entity's `pilotId` is set and `stepBotDrone` is skipped
for it. Release or signal loss calls `orphanDrone` so the sortie continues or the craft dead-sticks.

Refusals: drone not owned by the client, drone `done`, client already possessing, client dead.

### 3.3 Prediction

`base-game-prediction.js` gains a second predicted body. While `controlling` is set, replay targets
the flyer and reconciles against the matching `entities[]` entry. Fast rolling bodies make snaps far
more visible than walking does, so the soft-correction offset (`base-game.html:1978-1984`) applies to
both position and attitude, with a longer decay. This is the uncertain part of the plan.

### 3.4 Camera

`base-game-player-view.js` gains `mode: 'chase' | 'fpv'`. Chase sits behind and above along
`-velocity` with `lookAt` ahead; FPV sits at the craft's nose rolled with `bank`. The capsule
obstruction ray is off in the air. `demos/flight-sim.html`'s inline camera is the donor.

### 3.5 Streaming focus

`terrain.update(focus, dt)` takes the controlled body's global position. Sky and audio listener
follow the camera as they already do.

### 3.6 HUD

Altitude above `groundHeight`, airspeed, battery or fuel from the airframe, munitions aboard, tether
distance. The weapon view-model and mount are hidden while possessing.

### Tests

- `test-base-game-flyer.mjs`: quad climbs on throttle, holds altitude hands-off, rolls on `moveX`;
  recon needs airspeed to climb; ground contact sets `crashed`; state round-trip.
- `test-base-game-replication.mjs`: possess/release ordering, tick routing, neutral capsule while
  possessing, exact replay of a 960-tick flight.

---

## Phase 4 — Ordnance, tether, handback

- `fire` on the tick while possessing a bomber drops a bomb using `bombLead` for the HUD pipper;
  on a loiterer it commits the dive and control returns at once.
- Tether: `homeRadius` scaled for the open world; beyond it, or with no terrain-only LOS to the
  pilot's body for `signalLossS`, the server releases possession and the craft flies home on
  `stepBotDrone`.
- Handback on crash, `hp 0`, pilot death (once Phase 0 exists), or disconnect.
- Remote view: a piloted craft renders with a pilot tag above it; the pilot's body stands still.

---

## Order of work and risk

| Step | Files | Mechanical or uncertain |
|---|---|---|
| 1.1–1.3 | `server/base-game-entities.js`, `base-game-entities.js`, `base-game-protocol.mjs`, `server/base-game-rooms.js`, `base-game.html` | mechanical once the three must-agree places are listed; mesh/pose copied |
| 2.2 | blast adaptor + weapons plan Phase 3 | blocked on Phase 0 |
| 2.6 | tuning file + `serve.py` route | mechanical, numbers uncertain |
| 3.1 | `base-game-flyer.js`, `flight-airframes.js` | mechanical wrap; recon airframe needs flying |
| 3.3 | `base-game-prediction.js` | uncertain: attitude reconciliation at speed |
| 3.4 | `base-game-player-view.js` | mechanical |

Several tests assert literal strings in `base-game.html`; keep the existing call sites intact and add
beside them.

Docs to update when shipping: `docs/subsystems/base-game.md` (entities, possession, protocol 8),
`docs/subsystems/bots.md` (note that `bot-drones.js` now has a second consumer), `docs/subsystems/flight.md`
(recon airframe), `agent_log.csv`.
