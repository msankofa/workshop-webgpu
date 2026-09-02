# Base Game vehicle mounts: arming the UGV

**STATUS: spec only, 2026-09-02. Nothing built. Revised the same day** after reading
`docs/superpowers/specs/2026-09-02-sentinel-agm-design.md`, which moved most of this work into the
"already built" column.

Sources read: the base game's own AGM work (`fireAgm`, `steerToward`, `stepGuidedProjectiles` in
`base-game-drones.js`; `sanitizeBaseGameDroneInput/State` at protocol 19; `flight-hud.js`), the
flight sim's mount layer (`flight-combat.js` `makeMounts`, `mountOrigin`, `mountBoresight`,
`clampToArc`, `ballisticAim`; `AC130_LAYOUT.mounts`; `fireMount` and the `gunner` state in
`demos/flight-sim.html`), the mount tests in `test-flight-combat.mjs`, `mountsOf` in
`aircraft-layout.js`, and the shot path in `server/base-game-rooms.js`.

The UGV already draws a Sablynx remote weapon station, kept out of the static merge and exposed as
`userData.turret`. Nothing reads it: `base-game-vehicles.js` has no match for turret, mount, weapon,
aim or fire, and the vehicle wire carries only yaw, pitch, roll and steer.

## The precedent is no longer the flight sim

The AC-130 is where the ideas come from, but **they have already been ported into this game once**,
for the Sentinel's missile, and that port is the thing to copy. From the AGM spec: "The sensor is
the flight sim's AC-130 gunner ball: a world-frame aim the mouse slews, so the picture does not roll
when the aircraft banks."

What that port already established, which this feature inherits rather than builds:

| Already there | Where |
|---|---|
| A world-point `aim` and a `fire` edge on the stick channel | `sanitizeBaseGameDroneInput`, protocol 19 |
| Vehicles ride that same `tick.drone` channel | `applyDroneInput` resolves the id against both maps |
| The server/Solo seam: a pure function returns **what to fire**, the caller fires it | `fireAgm(rec, aim, now)` — "the server spawns into its room's manager and Solo into the page's, and neither should know about the other" |
| A seat you fly the weapon from, with F to the sensor and X to get out | the Sentinel's sensor seat |
| A sensor picture: crosshair, blast ring, range, time of flight, THREE-free and headless-testable | `drawSensorHud` in `flight-hud.js` |
| Rounds-remaining on the wire | `agm` on the drone state |
| The house answer on auto-targeting | "Nothing auto-targets. The aim is wherever the player points, by design." |

So **no protocol input change is needed at all**. The aim and the trigger the UGV needs are already
sanitized, already replicated, and already arriving on the vehicle's own input channel.

## What is genuinely new

Three things, and only three.

### 1. A turret is a rotating mount, not a free aim

The AGM aims freely because a missile turns after launch: you point at a place and the round gets
there. A gun cannot. The barrel has to physically arrive, and until it does the shot is refused.

`clampToArc` is the flight sim's answer, but it is a **cone around a fixed boresight**, correct for
guns bolted to a fuselage. An RWS traverses 360 degrees with limited elevation, and a cone cannot say
that: a hemisphere lets it shoot through its own hull, a narrow cone stops it turning round. So the
clamp is on two angles instead — yaw wraps, pitch clamps to `[min, max]` — and both slew at a rate.

The rate is not decoration. The AGM spec's own lesson was that the turn rate was "the number that
matters and the one that changed": at 1.2 rad/s the turning circle was 100 m and the player's aim
was inside it, so the round could not reach and missed by 65 m. A turret has the same failure in
angle rather than distance — an aim behind the station is reachable, but not this tick — and the
same fix: pick the rate against the aims the seat can actually produce, and refuse honestly when the
barrel is not there yet.

### 2. The shot is hitscan, so it goes through the server's gun path

`ballisticAim` exists because AC-130 shells fall a hundred metres over kilometres, and it solves
against `SHELL_GRAVITY` and the sim's own platform velocity. A machine gun at Base Game ranges is
flat, and every Base Game gun is already hitscan **with pose-history rewind**.

So the AGM's projectile route is the wrong one here: the shot hands an origin and a direction to
`fireShot`/`resolveHitscan`, which rewinds victims by the client interpolation delay. Following
`fireAgm`'s seam exactly, the pure function returns the shot and the caller resolves it — server
into the room, Solo into FX only.

A grenade-launcher variant later is the projectile path, which the AGM already proved.

### 3. The turret angle has to be replicated

A missile is its own entity on the wire, so the AGM needed no articulation state. A turret is part
of a vehicle other people are looking at, and a station swinging onto you is a warning. Two floats
and an ammunition count on `sanitizeBaseGameVehicleState`; the view rotates `userData.turret`, which
is already exposed and already excluded from the static merge.

## Carried over from the flight sim's mount layer

- **The mount table shape** `{ id, gun, pos, dir, arc }` in the vehicle's own frame, on the def
  exactly as `AC130_LAYOUT.mounts` sits on the airframe. No `mounts` means unarmed, which is every
  vehicle today.
- **A live instance per mount** with its own `cool` and `ammo`, so a future buggy pintle gun and the
  UGV's RWS never share a counter.
- **`mountOrigin`**, which needs a `right`/`up`/`fwd` basis — the vehicle has yaw, pitch and roll, so
  that is three lines, and it is the same basis the view already builds to pose the mesh.
- **`fireMount`'s refusal rules and burst cap**: accumulated `cool` debt so a slow frame does not eat
  rounds, `MAX_BURST` 6 so a fast one does not spray them, and no firing out of arc.
- **Fail at registration, not at the trigger.** `test-flight-combat.mjs` pins four things worth
  copying: a malformed `pos` is rejected when the airframe is registered, an unknown gun throws at
  construction naming the gun, mounts are independent state rather than shared, and a craft without
  mounts gets an empty list rather than `undefined`.
- **`mountsOf(layout)`** normalises a list — fills ids, defaults `pos`, unit-lengths `dir`. A `dir`
  that is not unit length silently biases every arc test after it.

## The design

```
BASE_GAME_VEHICLE_DEFS.ugv.mounts = [{
  id: 'rws',
  weapon: 'ugv_mg',                  // a Base Game weapon, so the shot path is unchanged
  pos: [0, <turret y>, <turret z>],  // vehicle frame, from the mesh's own band table
  muzzle: 0.78,                      // metres forward of the trunnion, so tracers start at the barrel
  yawRate: 1.9,                      // rad/s
  pitch: { min: -0.17, max: 0.79, rate: 1.2 },
  burst: 6, ammo: 400, rps: 9,
}]
```

Record: `turretYaw` (hull-relative, wrapped), `turretPitch` (clamped), and per mount `{ cool, ammo }`.
`turretYaw` is stored hull-relative but driven from the **world** aim already on the wire, so the
crosshair stays still while the hull pitches over a rock — the AC-130's insight, which matters more
on the ground than in the air because a UGV crossing a slope rolls continuously.

Per tick, server-side and identically in `stepSoloVehicles`:

1. Build the vehicle basis from yaw, pitch, roll.
2. Slew `turretYaw`/`turretPitch` toward the world aim at their rates, clamped.
3. `mountOrigin` for the muzzle.
4. Refuse if the aim is not yet within the trained arc.
5. Accumulate `cool`, up to `burst` rounds, decrement `ammo`.
6. Return the shot; the caller resolves it through the existing hitscan path.

## Order of work

1. **Aim, replicated, no gun.** Turret angles, rates, clamps, two wire floats, the view rotating
   `userData.turret`. You can watch the station track before anything can shoot, and it is fully
   Node-testable: clamp limits, rate limiting, and world-to-hull conversion over a rolling hull.
2. **The shot.** Mount instances, muzzle, arc refusal, cooldown and burst, through the server's
   existing hitscan path. Room test that a non-owner's trigger does nothing and that a shot out of
   arc is refused rather than fired, mirroring `server/test-base-game-drones-room.mjs`'s AGM case.
3. **Hit volume.** Arming the UGV without this gives a thing that kills and cannot be killed.
   `damageBaseGameVehicle` exists and nothing calls it; wreck and crash blast then fire on their own.
   Note this gap is repo-wide: the AGM spec records that no drone has a hit volume either.
4. **The gunner picture.** `drawSensorHud` already draws crosshair, blast ring and range, so this is
   wiring rather than authoring.

## Decided

- **Owner-triggered only, for now** (2026-09-02). Matches the AGM's "nothing auto-targets, by
  design". AI aiming comes later.

  **What that costs, if the seam is right: nothing.** `fireMount(rec, mountId, aim, now)` takes a
  world point and returns the shot, the way `fireAgm` does. Nothing below that line can tell whether
  the point came from a player's mouse or from a bot brain, so adding AI aiming later is a caller,
  not a rewrite. Two rules keep it that way and are worth stating now, because breaking either is
  what would turn a trivial addition into a refactor:

  - The slew, the clamp, the arc refusal and the cooldown all live **below** the seam, in the tick
    step, so an AI-aimed turret obeys the same traverse limits a player-aimed one does. Putting any
    of them in the client's input builder would give a bot a turret that snaps.
  - The aim is a **world point**, never a hull-relative angle pair. A brain naturally produces a
    point in the world — a target's position — and would have to solve backwards for angles.

## Open questions
- **A dedicated gunner seat, or the chase camera with a reticle?** The Sentinel already has the seat
  pattern; the cheap version is the existing chase camera plus `drawSensorHud`.
- **Does the buggy get a pintle mount?** It needs a gunner seat, and passengers are not built.
- **Where the vehicle weapon lives.** Putting `ugv_mg` in the weapons table keeps the shot path
  literally unchanged, but that table also feeds the player loadout vocabulary; it must be reachable
  by `getWeapon` without being selectable as a personal weapon. To confirm, not assumed.
