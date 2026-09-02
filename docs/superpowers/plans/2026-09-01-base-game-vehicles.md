# Base Game vehicles: the UGV gadget and drivable ground vehicles

**STATUS: implemented 2026-09-01. Node and room tested; not yet visually audited in a browser.** Written from a read of `base-game-drones.js`,
`base-game-drone-view.js`, `server/base-game-rooms.js` (gadget, drone and tick paths),
`base-game-prediction.js`, `base-game-player-controller.js`, `base-game-protocol.mjs`,
`city-vehicle-model.js`, `flight-model.js`, `flight-combat.js`, `flight-meshes.js`, and the
2026-08-27 drone plan this one is shaped after.

## What ships

Two ground vehicles in the Base Game, in Solo and online alike.

- **UGV.** A gadget, like the quad. Holding the slot raises it overhead; fire sets it down in front
  of you. It drives itself: it shadows you on the ground, goes where you send it, holds there, and
  comes back when recalled. You can take the wheel from a distance (your body stands still, the
  camera rides behind it) and hand it back. Unarmed in this plan; the turret is the first follow-up.
- **Buggy.** A vehicle that exists in the world without an owner, placed by the dev gun. Walk up,
  press E, and you drive it from the seat with the movement keys. Press E to get out. Online your
  own driving is predicted like your body is, so it steers when you steer.

One module simulates both. What differs between them is a table row: autonomy on or off, a seat or
a remote.

## Reuse, and what is new

| Need | Owner | What it already does |
|---|---|---|
| Car physics | `city-vehicle-model.js` `makeRoadVehicle` / `stepRoadVehicle` | fixed-step planar car: engine, brakes, handbrake, slip-angle tyres, yaw inertia, drag, top speed. Pure, no THREE, tested in `test-city-vehicle-model.mjs`. Faces +Z at yaw 0, the same heading convention `bot-drones.js` and the drone view use |
| Record, two steppers, orders, take over and release, wire state | `base-game-drones.js` | the shape is copied line for line: `create*`, `step*`, `sendTo`, `recall`, `takeOver`, `release`, `damage*`, `*WireState`, one `world` object with `ownerPos`, `ownerYaw`, `ownerAlive`, `groundY(x, z)` |
| Ground under it, both sides | `roomGroundY(room)` on the server, `soloGroundY` on the client | the one query the drones already need; nothing else about the terrain is read |
| Gadget slot: hold, stock, throw timers, one per kind aloft | `launchGadget`, `stepGadgetTimers`, `spawnGadget` on the server; `stepGadgetHands`, `stepSoloDrones` on the client | a per-kind lookup replaces the hard-coded `createBaseGameDrone` |
| The stick and the orders on the wire | tick input `drone: { id, mode, send, recall, … }` | a vehicle id in `id` is a vehicle order; the sanitizer already bounds every field |
| Owner-only control, `controlling` on the player | `applyDroneInput`, `dropStick`, player state `controlling` | the lookup becomes `room.drones.get(id) ?? room.vehicles.get(id)` |
| Lockstep prediction | `base-game-prediction.js` | unchanged except one line: `installAuthoritative` hands the seat state through |
| Mesh registry, materials, interpolation, chase camera, held-overhead mesh | `base-game-drone-view.js` on `flight-meshes.js` `registerCraftMesh` / `buildCraftMesh`, `createRemoteTrack` | two builders registered under new kinds; `CHASE` gains two rows; the pose branch already builds a quaternion from yaw, pitch and bank |
| Crash blast | `detonateBlast` via `rec.crash` / `def.crashBlast` | the drone crash path, unchanged |
| Owner-placed spawn | dev gun `spawnerPlace` → `base:npc { aimed: true }` | a third dev-gun tool and a `base:vehicle` message with the same shape |
| Turret (follow-up) | `flight-combat.js` `makeMounts`, `mountOrigin`, `clampToArc`, `ballisticAim` | mounts are defined in the craft's own frame with an arc; a UGV def carries `mounts` the same way an airframe does |
| Paths over open ground (follow-up) | `server/base-game-npcs.js` zone nav grid with `NPC_MAX_SLOPE` | the UGV's first driver steers by probing; the nav grid is where real routing comes from later |

**New, because nothing here does it:**

1. A ground fit. The car model is planar; the terrain is not. Three wheel points sampled through
   `groundY` (front centre, rear left, rear right) give height, pitch and roll; a plane needs three
   and the fourth would be a fourth noise-stack evaluation for nothing. About 30 lines.
2. Grade. One optional field on the car model, `body.grade` (radians of pitch, default 0), adds
   `-mass * G * sin(grade)` to the longitudinal force. The climb limit falls out of the engine
   numbers instead of being a rule. City-builder passes nothing and is unchanged.
3. Airborne. When the ground drops away faster than the car, it flies ballistic on `airV` with no
   drive or steer until it lands. About 15 lines.
4. A ground driver for the autonomy: pure pursuit on the target with a turn-rate limit, slow-down
   on heading error, a reverse-and-turn when stuck, and a three-heading grade probe so it goes
   around a slope it cannot climb. About 60 lines. `hoverTo` and `cruiseTo` are 3D and do not apply.
5. A seat: the driver's body is carried by the vehicle, in lockstep. About 80 lines across the
   module and the two callers.
6. Two meshes: a low box on four wheels for the UGV, an open buggy. Wheels in `userData.wheels`.

## The module: `base-game-vehicles.js`

```
record = {
  id, kind, def, ownerId, team,
  body,                 // makeRoadVehicle(): x, z, yaw, vx, vz, yawRate, steering, speed …
  y, pitch, roll,       // from the ground fit each step
  airV, airborne,
  mode: 'auto' | 'manual' | 'parked',
  state: 'deploy' | 'follow' | 'goto' | 'hold' | 'return' | 'manual' | 'parked' | 'stuck' | 'drowned' | 'wreck',
  stateT, target, driver,       // driver: clientId while a seat is taken
  input: { throttle, brake, reverse, steer, handbrake },
  hp, done, crash,
}
```

Defs extend `DEFAULT_ROAD_VEHICLE` the way `BASE_GAME_DRONE_DEFS` extends `DRONE_DEFS`:

| | `ugv` | `buggy` |
|---|---|---|
| mass, engine, top speed | 180 kg, small motor, 7 m/s | 900 kg, 24 m/s |
| wheelbase, track, clearance | 1.1, 0.8, 0.25 | 2.4, 1.6, 0.4 |
| autonomy | yes: shadow 3 m behind the owner, goto, hold, return | none: parked until driven |
| seat | remote (the body stands, like the quad's operator) | on board, exit point 1.2 m to the driver's left |
| gadget | yes, stock 1 | no, placed by the dev gun |
| hp, crash blast | 40, 3 m / 20 | 120, 5 m / 40 |
| mesh | `ugv` | `buggy` |

Numbers are starting points, tuned in Solo.

**One step.** `stepBaseGameVehicle(rec, dt, world)` in fixed 1/120 s substeps like `stepManual`:

1. Ground fit: sample `groundY` at the three wheel points in the yaw frame. Centre height is the
   mean; `pitch = atan2(hFront - hRear, wheelbase)`, `roll = atan2(hLeft - hRight, track)`. If the
   car is above centre plus clearance it is airborne: gravity on `airV`, the road model steps with
   zero input so drag still acts, it lands when it meets the ground. On the ground `y` follows the
   fit and `body.grade = pitch`.
2. Input: the driver's in `manual`, the autonomy's in `auto`, nothing in `parked`.
3. `stepRoadVehicle(body, input, dt)`.
4. Water: ground below sea level by more than the clearance floods the engine, `drowned`, and the
   driver is put out. Sea level is a shared world key on both sides already.
5. A dead owner: a UGV in `follow` or `return` stops and holds where it is (the UAV's rule); one
   with a target keeps its order.

**Autonomy** (`auto`, the UGV only), the drone's five states on the ground:

- `deploy` → set down 2 m ahead of the owner, wheels on the ground, then `follow`.
- `follow` → `driveToward` the shadow point 3 m behind the owner, stop within 1.5 m, face the
  owner's yaw when stopped.
- `goto` → `driveToward(target)`, `hold` within 2 m.
- `hold` → stop, handbrake.
- `return` → `driveToward` the shadow point, then `follow`.
- `stuck` → speed under 0.3 m/s for 1.5 s while wanting to move: reverse 1 s with the wheel over,
  then back to the previous state. A second stuck inside 5 s holds.

`driveToward(rec, x, z, dt, groundY)`: heading error → steer, throttle scaled down by the error and
by distance, brake inside the stop radius. Before committing, probe the grade 5 m out along the
straight heading and ±35°; take the lowest heading whose rise per metre is under `def.maxGrade`
(0.7, the NPC walkable slope). The probe runs at 10 Hz, staggered by record id the way the NPC
think is, and only in a moving state: six extra height samples per tick per vehicle at 120 Hz
would cost more than the physics. Cheap and local; it will go the long way round a hill and can
get trapped in a bowl, which is what the nav grid fixes later.

**Manual** (`manual`), from the movement keys, not the flight stick: `moveZ` is throttle or
reverse, `moveX` is steer, `crouch` (Ctrl, held) is the handbrake. These three fields already ride
every tick and are already passed to `stepOnce` in the server's `consumeTick` and in the prediction
wrapper's replay, so driving needs no new input field.

**Take over and release** keep the drone's names. `takeOverVehicle` sets `manual` and `driver`;
`releaseVehicle` goes back to `goto` if there is a target, else `return` for a UGV, else `parked`.
A released buggy keeps rolling in `parked` with zero input until the model's own friction stops it.

**Damage**: `damageBaseGameVehicle(rec, amount)`; at zero hp `wreck`, done, `crash` set at its
position so the room's blast path fires. Nothing can hit it yet, the same gap the drones have.

**Wire**: `vehicleWireState(rec)` = `{ id, kind, owner, team, driver, p, v, yaw, pitch, roll,
steer, hp, mode, state, target }`. `vehicleSeatState(rec)` adds `body: [x, z, yaw, vx, vz, yawRate,
steering, y, airV]`, the exact numbers a replay must start from.

## The seat

The one design decision. A drone under the stick is stepped in `stepDrones` from the latest input,
so it runs a round trip late. A car driven that way is unplayable. So a **manned vehicle is stepped
only inside its driver's tick**, on both sides, from the same tick input, and the prediction
wrapper replays it like the body:

- `stepVehicleSeat(rec, tickInput, dt, world)` in the module: maps the keys, steps the vehicle,
  and returns the seat point. Pure.
- **Server**: in `consumeTick`, when `client.controlling` names a vehicle, `stepVehicleSeat` runs
  instead of the body's movement; the body is then placed at the seat point with the vehicle's
  velocity through a new `controller.pin(position, velocity)` (a UGV's driver stands still, as
  now). `pin` writes the three arrays in place; `applyState` validates through `vec3`, allocates
  three arrays and clears the contacts, which is a resync, not a per-tick move. `stepVehicles`
  skips any vehicle with a driver.
- **Client**: `createSeatedController(bodyController, vehicles)` exposes the surface the page and
  the prediction wrapper already call (`stepOnce`, `applyState`, `captureState`, `getPosition`,
  `getVelocity`, `advance`, `setInput`, `queueJump`, `interpolatedPosition`, the getters). Every
  call forwards to the body until a seat is taken; seated, `stepOnce` steps the vehicle and pins the
  body. Solo calls it directly, online the prediction wrapper does. `stepSoloVehicles` skips the
  driven one.
- **Reconcile**: the driver's player entry carries `vehicle: vehicleSeatState(rec)`. The player
  state sanitizer keeps it; `installAuthoritative` passes it on; `applyState` restores the body
  numbers before the replay. Position error is measured on the body as now, and the body is at the
  seat, so the existing hard-snap and replay rules cover the car.
- **Enter and exit**: E. Within 3 m of an empty seat, the tick carries `drone: { id, mode: 1 }`
  and the server takes the seat; `mode: 0` leaves it at the exit point with the vehicle's velocity.
  The UGV's F still works from any range, as for the quad.
- **Others** see the driver's body at the seat because the body's position is the seat: the remote
  path needs nothing new. The body stands rather than sits; a seated pose is a follow-up.

Gate for this to hold: the client's `terrain.groundHeight` and the server's `heightAt` must agree
to within the prediction's soft tolerance where the car drives. They already have to for the body,
and the same reconciliation catches drift. Measured, not assumed, in the room test: a scripted
drive on the analytic source reconciles with no hard snaps.

## Protocol (version 16)

- `BASE_GAME_GADGET_IDS` and `BASE_GAME_WEAPON_IDS` gain `ugv`; `BASE_GAME_GADGET_STOCK.ugv = 1`;
  the default loadout is unchanged (choose it from the loadout panel).
- `BASE_GAME_VEHICLE_KINDS`, `_MODES`, `_STATES`; `sanitizeBaseGameVehicleState`;
  `sanitizeBaseGameVehicleSeatState`. Vehicle input is the drone input sanitizer, unchanged.
- Snapshot gains `vehicles: []`. Player state gains `vehicle` (null unless driving).
- `base:vehicle { action: 'spawn' | 'clear', kind, aimed }`, owner only, the `base:npc` shape.

## Server (`server/base-game-rooms.js`)

- `room.vehicles: Map`, stepped in `stepRoom` after `stepDrones`; `prof.vehicles`.
- `spawnGadget` picks the factory by kind; a UGV is placed, not thrown.
- `applyDroneInput` resolves the id against both maps; a vehicle `mode: 1` within seat range takes
  the seat, out of range is ignored for a buggy and is the remote take-over for a UGV.
- `consumeTick` seat branch as above. `dropStick` releases a vehicle too.
- `base:vehicle` handler, like `npcCommand`: placed at the owner's aim point, on the ground.

## Client (`base-game.html`, `base-game-drone-view.js`)

- The view takes one def table for drones and vehicles; `CHASE.ugv`, `CHASE.buggy`; wheels spin
  with speed and the fronts turn with `steer`. Held overhead the UGV shows like the quad, but the
  held meshes are kept per kind and hidden, not disposed and rebuilt on every slot change.
- The chase camera gains the third-person camera's obstruction test (`obstructionDistance` in
  `base-game-player-view.js`, exported) so it cannot back into a hill behind a car. The drone
  camera never needed it; a ground vehicle's camera is inside terrain half the time.
- `stepSoloVehicles` beside `stepSoloDrones`, same shape; `soloVehicles` map. Solo feeds the view
  through a new `ingestRecords(records, time)` that reads the records directly; today's Solo path
  builds a wire-state array, sanitizes every entry into fresh objects, and pushes a track sample,
  every frame, for records that live in the same page.
- `createSeatedController` wraps `playerController`; both the Solo branch and `prediction` receive
  the wrapper.
- E: enter and exit. Dev gun: 9 cycles bots → lights → vehicles; click places a buggy; Solo places
  it locally.
- HUD: the drone line reads the vehicle too (`[F] take the wheel · [B] send · [N] recall`, and
  `[E] get out` when seated). The chase camera rides the vehicle whenever you drive one.

## Order of work

Each step ships on its own and is Node-tested before the next.

1. **Module.** `base-game-vehicles.js`, the `grade` field in `city-vehicle-model.js`,
   `test-base-game-vehicles.mjs`: ground fit angles on an analytic slope, the climb limit from the
   engine numbers, a cliff edge goes airborne and lands, deploy → follow on a hill, goto over a
   ridge never exceeds `maxGrade`, hold, recall, stuck recovery, take over and release round trip,
   two records stepped from the same inputs are bit-identical, wire round-trip. `test-city-vehicle-model.mjs` stays green.
2. **UGV online.** Protocol 16, `room.vehicles`, gadget deploy, orders and take over through the
   drone channel, snapshot. `server/test-base-game-vehicles-room.mjs` after the drone room test.
3. **UGV in the browser, both modes.** Meshes, view, Solo stepper, HUD, keys. First thing you can
   see.
4. **Seats and the buggy.** `stepVehicleSeat`, the seated controller, the reconcile hook, E, the
   dev gun tool, `base:vehicle`. Room test: a scripted drive reconciles with no hard snaps; a
   non-driver's input never moves it; exit leaves it rolling and it stops.
5. **Docs and log.** `docs/subsystems/base-game.md` gains a vehicles section; `agent_log.csv`.

## Audit against `/improve-webgpu` (2026-09-01, on the plan, nothing measured)

No page exists yet, so there is no baseline and no render to look at. The findings below come from
the code paths the plan reuses, ranked the way the skill ranks: by where the code runs. Each one is
already folded into the sections above; this records why.

| Severity | Finding | Where it runs | What the plan now says |
|---|---|---|---|
| HIGH | Height samples. `heightAt` on the v5 source evaluates the whole noise stack per point, and the volumetric `surfaceYAt` scans and bisects the density on top of that. Four wheel points plus a six-sample grade probe per vehicle per 120 Hz tick is ten stack evaluations a tick. | server `stepVehicles`, client `stepSoloVehicles`, both at 120 Hz | three-point fit; probe at 10 Hz, staggered, moving states only |
| HIGH | Solo ingest allocates. `stepSoloDrones` builds a wire array, sanitizes each entry into new objects and arrays, and pushes a track sample every frame. Vehicles would double it. | client `animate()` | `ingestRecords` reads the local records directly |
| HIGH | `applyState` per tick. Pinning the body to the seat through `applyState` validates and allocates three arrays and clears contacts every tick. | server `consumeTick`, client prediction, replay | `controller.pin` writes in place |
| MEDIUM | Held mesh churn. `showHeld` disposes and rebuilds geometry and materials whenever the held kind changes; a slot wheel through quad, UAV, UGV rebuilds three times. | slot change | one held mesh per kind, hidden |
| MEDIUM | Camera into terrain. The drone chase camera has no obstruction test. Inferred, not seen: a car parked against a slope puts the camera underground. | client, per frame | the player view's obstruction test, exported and reused |
| MEDIUM | Float and sink. The physics samples the terrain field on both sides because the server has nothing else, but the client draws the LOD chunk mesh, and the roads work showed the two disagree. Inferred, not seen. | render | ship without a correction; if it shows, offset the drawn mesh by one `worldQuery` raycast under the centre per visible vehicle per frame, presentation only |
| PASS | HUD writes. The combat status line is diffed before `innerHTML`; a vehicle line adds string work, not DOM work. | client, per frame | unchanged |
| PASS | Materials. Each mesh gets its own node materials, but same-structure node materials share a pipeline, so a spawn is not a recompile. | spawn | unchanged |
| PASS | Ground parity. Client `groundHeight` is `source.heightAt` on the same v5 source the server calls, so the lockstep gate is the same function on both sides, not two implementations. Verified in the code, not measured. | prediction | the gate in "The seat" stays as the measured check |

Not auditable until built: GPU time per pass, draw calls, `renderer.info.memory` at idle, and
every row of the visual rubric. Step 3 is the first point a baseline can be taken.

## Not in this plan, in the order it will show

- The turret: `mounts` on the UGV def through `flight-combat.js`, fired by the owner at the wheel
  or by the autonomy at the nearest enemy, resolved through `resolveHitscan` like a shot.
- A hit volume for vehicles, so they can be shot; and vehicles as occluders.
- Collision with players, trees and each other. Today it drives through all three, as the drones
  fly through everything.
- A seated pose for remotes; a first-person view from the seat; passengers.
- Real routing from the NPC zone nav grid; NPC drivers, which need the Solo loopback room.
- Rollover. Roll is displayed, never acted on.
