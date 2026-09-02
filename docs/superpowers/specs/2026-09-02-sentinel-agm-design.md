# The Sentinel's missile, and the seats you fly it from

**Status: shipped 2026-09-02, Node-tested, never seen in a browser.** Protocol 19.

The RQ-170 Sentinel arrived on 2026-09-01 as a world drone that orbits and nothing else. This adds
three things: the Sentinel is flyable, it carries four guided missiles, and there is a green head-up
display over every craft you are at the stick of.

## What a player does

| Key | On foot | Flying the craft | At the sensor | Riding a missile |
|---|---|---|---|---|
| F | take the stick | to the sensor | back to the craft | back to the craft |
| X | — | get out | get out | get out |
| Space | jump | jump | **release a missile** | — |
| V | player view | cockpit / chase | — | seeker / chase |
| Wheel | weapon | boom in and out | zoom 10/20/30/45 | — |
| Mouse | look | — | slew the sensor | — |
| B / N | — | send / recall | send / recall | — |

The sensor is the flight sim's AC-130 gunner ball: a world-frame aim the mouse slews, so the picture
does not roll when the aircraft banks. The camera looks straight down the aim, which makes the middle
of the screen the impact point by construction — there is nothing to project onto it.

Firing does not change the seat. The camera picks up the round and rides it, and when the round is
gone (impact, or its life running out) you are put back in the craft. Slewing the sensor while a
round is in the air steers it, so this is a television-guided weapon, not a fire-and-forget one.

## How it is built

**The missile is an ordinary projectile.** `bot-projectiles.js` flying
`entity-types/combat-projectile.js` already knows how to hit a player rig, hit the ground, and hand a
detonation to whoever asked for one. A missile is one of those with a `guide` field attached, so it
inherits every one of those paths rather than growing its own. `spawn` carries `init.guide` onto the
projectile beside `weaponId`; nothing else in that module changed.

**Two functions in `base-game-drones.js`, run identically by the server and by Solo.**

- `fireAgm(rec, aim, now)` takes a round off the rack and returns the projectile to spawn, or null.
  The caller does the spawning, because the server spawns into its room's manager and Solo into the
  page's, and neither should know about the other.
- `stepGuidedProjectiles(list, dt)` walks a manager's list, turns each guided velocity toward its
  aim, and carries the proximity fuse. Anything without a `guide` is untouched.

`steerToward` rotates the velocity in the plane of the two vectors and then restores its length.
Steering each axis toward the target instead would both cut the corner and arrive slow.

**The fuse.** A guided round is aimed at a point, usually on the ground, so the ordinary impact paths
would do — except where nothing answers a raycast there, the round sails through and flies until its
life runs out. So arriving is its own end: within 25 m, a closing rate that has gone to zero zeroes
the entity's remaining life, and the entity detonates itself through the same airburst path it
already had. A distance test alone is not enough; at 120 m/s a 1/60 s step is two metres, and a small
sphere is stepped straight over.

**The display is a new module, `flight-hud.js`,** taking plain arrays and one `project(x, y, z)`, so
it has no THREE in it and runs headless in a test. Two pictures: `drawFlightHud` (pitch ladder,
flight path marker, tapes, heading, throttle) and `drawSensorHud` (crosshair, blast ring, range,
time of flight). The page draws it onto a canvas over the scene, after the render, so it reads the
camera the frame actually used.

## The numbers

| | Value | Why |
|---|---|---|
| Rounds | 4, no rearm | Clearing and respawning the drone reloads it |
| Speed | 120 m/s | About 3 s to the ground from the low preset, 15 s from the high one |
| Turn rate | 3.0 rad/s | Turning circle is speed / turn = 40 m |
| Blast | 10 m, 120 damage | Between the RPG and the drone crash blast |
| Gap between rounds | 1.2 s | A held key must not empty the rack |
| Unguided drop | 0.35 s | It clears the wing before the motor takes over |
| Life | 30 s | Long enough for the high preset, short enough to clean up |

The turn rate is the number that matters and the one that changed. At the 1.2 rad/s I first wrote,
the turning circle is 100 m, and a player at the low preset aiming at the ground directly below the
drone is inside it: the round physically cannot get there and misses by 65 m. A 40 m circle covers
every aim point the low preset can produce.

## What the tests hold down

- `test-base-game-agm.mjs` — the rack (count, gap, a wrecked drone, a kind with no rack), the
  steering (speed held, rate capped, on-course left alone, a reversed aim not producing NaN), the
  fuse, and five aim points flown all the way to impact from both presets, plus a mid-flight re-aim.
- `test-flight-hud.mjs` — the display against a recording canvas: the horizon on the horizon at four
  pitches, the marker off to the side when the craft drifts, the blast ring the size the geometry
  gives, no coordinate ever NaN.
- `server/test-base-game-drones-room.mjs` — a shot end to end: the aim and one trigger edge on the
  stick, one round off the rack, the missile on the snapshot, and an explosion within 25 m of the aim.

## Two things found on the way

**Every base-game drone was banking the wrong way.** Found on 2026-09-01 and fixed then; the record
keeps `bot-drones.js`'s cosmetic sign and the wire carries the physics one.

**The flight sim's pitch ladder is mirrored.** `off = (pitch - deg) * pxPerRad` places the line for
`deg` on the wrong side of the boresight: level flight looks right, which is why it survived, but a
climb puts the horizon above the nose. Corrected in `flight-hud.js` and in `demos/flight-sim.html`.
The display test is what caught it, and it is the reason that test exists.

## Hit volumes and reliable crashes (added the same day)

Drones could not be shot, and did not reliably blow up. Both are fixed; the detail is in
`docs/subsystems/base-game.md` under "Drones can be shot down".

- **Hit volume.** `droneHitVolume` / `droneHitVolumes` / `blastDamageOnDrone` in
  `base-game-drones.js`. A drone is a sphere of its `bodyRadius`, which every def already carried and
  nothing read. It rides in through `resolveHitscan`'s existing `mobs` list, so bullets, projectiles
  and blasts all see it, on the server and in Solo.
- **A killed drone falls.** It used to end on the spot, which put the blast wherever it was hit.
- **Sitting on the ground is a crash.** 0.6 s of ground contact under the stick. Before this, a drone
  landed gently skidded for 48 seconds before anything ended it.
- **A backstop in the deadstick fall**, because a dead drone left hanging is the one failure a player
  actually notices.
- **A missile no longer detonates on its own launcher.** The projectile is handed to the raycast so
  the firing aircraft can be excluded; it leaves from a metre under an eight-metre hit sphere.

## Not done

- No sound: no launch, no motor, no impact report beyond the shared explosion.
- The missile has no smoke trail of its own; it borrows the rocket's puff.
- Nothing auto-targets. The aim is wherever the player points, by design.
- Ground vehicles still have no hit volume; only drones got one.
- Never seen in a browser by anyone.
