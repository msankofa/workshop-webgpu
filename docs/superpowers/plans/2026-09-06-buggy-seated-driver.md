# Base Game: the buggy driver sits down

**STATUS: plan only, 2026-09-06. Nothing built.**

Sources read: `stepVehicleSeat` / `vehicleSeatPoint` and the buggy def in `base-game-vehicles.js`; the
driver pin in `server/base-game-rooms.js` (`client.controller.pin(seat.position, ...)` every tick);
`feed()` in `base-game-player-bodies.js`; `setRagdollPose` and `update()` in
`player-procedural-body.js`; `ragdollFromBody` in `ragdoll-body.js`; `buildBuggy` in
`flight-meshes.js`; the player wire in `base-game-protocol.mjs` (`controlling`, `vehicle`).

## What already exists

- **The body already rides the buggy.** The room pins the driver's controller to the def's
  `seatOffset` ([-0.42, 0.72, 0.05] on the buggy) every tick, and Solo does the same through
  `stepVehicleSeat`. Remote players see the driver's body at that point through the normal player
  wire. Nothing new is needed to put the body in the seat.
- **The body stands in it.** Pose comes from the stance channels (crouch/kneel/prone), so a driver
  is drawn upright on the cushion, through the roof. That is the whole bug.
- **The rig can take a placed pose.** `setRagdollPose(P)` takes sixteen joint points (head, neck,
  chest, pelvis, shoulders, elbows, hands, hips, knees, feet) and places every part with no solve.
  Ragdoll death drives the rig through it every frame in the bot viewer and multiplayer.
- **The points are in the body group's frame.** `ragdollFromBody` seeds them from joint world
  positions with the group at the origin, so in the Base Game they are render-local world points.
- **The buggy mesh knows its seat.** `buildBuggy` draws the pan at `clear * 1.3`, the back at
  `clear * 2.1` raked 0.15 rad, the dash at `clear * 1.8`, the wheel torus at `clear * 2.2`,
  `seatZ - 0.22`, tilted 1.05 rad, and the floor at `clear * 0.25`. Every number the pose needs is
  already there.
- **Who is seated is on the wire.** The local controller has `controlledVehicle`; a remote's
  sample carries `vehicle` and `controlling`. No protocol change.

## What this is, and is not

This is the bottom layer of how a shipped game does it: a seat pose, attached to a socket on the
vehicle. It is not the enter/exit blend, hand IK on the wheel, lean under acceleration, or a
seated hit capsule. Those are listed at the end as the layers that stack on this one, in order,
and none of them is needed for the driver to sit.

## Design

```
buggy def
  seatPose: {                         // buggy frame, metres, nose -Z, authored for H = 1.8
    pelvis, chest, neck, head,
    hipL, hipR, kneeL, kneeR, footL, footR,
    shoulderL, shoulderR, elbowL, elbowR, handL, handR,
  }

bodies, per body, per frame
  seated = local ? controller.controlledVehicle?.def.seat === 'onboard'
                 : sample.vehicle && vehicles.get(sample.controlling)?.def.seat === 'onboard'
  if (!seated) body.update(...)       // exactly as today
  else {
    P = seatPose × scale(height / 1.8, about pelvis) × vehicle mesh matrix
    body.setRagdollPose(P)            // position, yaw, pitch and roll all come from the matrix
  }
```

- **One table per vehicle def, not per body.** The pose is a property of the seat. Body height
  scales it about the pelvis so a short body's feet still reach the floor and its hands the wheel,
  which is a lie for a tall body (the wheel is where the wheel is), accepted for this layer.
- **The matrix is the socket.** The driver tilts with the cage on a slope because the points are
  transformed by the same matrix the mesh is drawn with. No separate pitch/roll plumbing.
- **The head follows the look.** `setRagdollPose` derives the head from neck→head, so the look yaw
  and pitch rotate the head point about the neck before the transform. Clamped to the seat
  (±80° yaw, ±40° pitch) so the driver cannot look through their own back.
- **The UGV is untouched.** Its seat is `remote`: the operator stands beside it. Only `onboard`
  seats take the branch.

### The sixteen points

Derived from the mesh, driver side, `clear` = the buggy's clearance, seat at (sx, seatZ):

| joint | x | y | z | from |
|---|---|---|---|---|
| pelvis | sx | pan top + 0.10 | seatZ + 0.06 | sitting on the pan, against the back |
| chest | sx | pelvis + 0.42 | pelvis − 0.06 | up the raked back |
| neck | sx | chest + 0.14 | chest − 0.02 | |
| head | sx | neck + 0.14 | neck − 0.01 | under the roof rail with clearance |
| hips | sx ± 0.11 | pelvis | pelvis | |
| knees | sx ± 0.13 | pelvis + 0.02 | pelvis − 0.44 | thigh level and forward |
| feet | sx ± 0.13 | floor + 0.05 | knee − 0.08 | on the floor, shin near vertical |
| shoulders | sx ± 0.19 | chest + 0.06 | chest | |
| elbows | sx ± 0.20 | shoulder − 0.20 | shoulder − 0.18 | |
| hands | sx ± 0.14 | wheel centre | wheel rim | on the torus at ten and two |

The Node test asserts each bone length against `limbLengths` (thigh, shin, upper and lower arm)
to within 3 %, so the table cannot stretch the rig; the ragdoll's `RAGDOLL_JOINT_MAP` names are
the same sixteen so the table works unchanged as a ragdoll seed later.

## Order of work

1. **The table and its test.** `seatPose` on the buggy def in `base-game-vehicles.js`, plus
   `seatPosePoints(def, height, matrix, out)` exported from the same file: scales about the
   pelvis, applies the matrix, fills sixteen `{x,y,z}` in place. `test-base-game-vehicles.mjs`
   checks bone lengths against a default rig and that the transformed pelvis lands on the seat
   point `vehicleSeatPoint` already returns, so the drawn seat and the driver agree by
   construction.
2. **The seated branch in bodies.** `feed()` in `base-game-player-bodies.js` takes a
   `seatMatrix` (null when not seated) in the sample; when set it calls `setRagdollPose` instead
   of `update`. The page fills it: local from `playerController.controlledVehicle` and the
   vehicle's mesh, remote from `sample.vehicle` and `droneView.drones.get(sample.controlling)`.
   The weapon stays mounted where the hand goes (`w.mount` reads the hand joint), so a rifle sits
   across the lap; good enough for this layer.
3. **First-person eye.** The seat camera in `base-game.html` uses the transformed head point plus
   the eye offset when the local player is in an onboard seat, instead of `placeCockpitCamera`'s
   span-based aircraft eye. Third person is unchanged.
4. **The look.** Head yaw/pitch from the local view and the remote sample, clamped, applied
   before the matrix.

Each step is one commit; steps 1 and 2 are the feature.

## The layers on top, in order, after it sits

1. **Enter and exit.** A 0.25 s blend from the last `update` pose to the seat pose and back, so
   the body does not snap. The pose points are already the right data to lerp.
2. **Hands on the wheel.** Hand points read from a `wheel` anchor in the mesh `userData` (the
   light anchors are the pattern) and rotate with `body.steering`, elbows re-solved by
   `solveArm`. Two-bone IK the rig already has.
3. **Lean.** Chest and head shift by `body.ax` and lateral acceleration, a few centimetres.
4. **The seated capsule.** The controller still sizes its hit capsule for a standing body, so a
   seated driver is shot at head height 0.5 m above their actual head. Feed a seat weight into
   `stepStanceWeights` so the capsule and the pose come from the same number, as crouch does.
5. **Passenger seats.** The mesh already draws two seats. A `seats[]` list on the def with a pose
   each is the shape, but passengers need a second stick holder, which is not built.

## Open questions

- Does `setRagdollPose` leave the group at the origin in the Base Game as it does in the bot
  viewer? `feed()` passes `position` through `update`, which may move the group; if so the points
  need the group's inverse first. To confirm in step 2, not assumed.
- The weapon across the lap will clip the wheel. Acceptable for this layer, or stow it (the wire
  already carries the loadout) while seated. Preference: stow, one line, decided at step 2.
