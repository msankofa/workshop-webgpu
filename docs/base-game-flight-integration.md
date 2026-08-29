# Base Game flight integration

Written 2026-08-27 from a read of `docs/subsystems/base-game.md`, `docs/subsystems/flight.md`, the
`flight-*.js` exports and `base-game-protocol.mjs`. Nothing here is built. It records where the two
codebases collide, the order that avoids re-deriving that, and the gate each step has to pass.

Roadmap Step 12 in `base-game.md` lists "flight gameplay" after creatures. This plan does not move
it; it says what the step is made of.

## What flight is for

The code cannot answer this and everything below depends on it. Three readings, cheapest last:

| Reading | What it needs | What it buys |
|---|---|---|
| A. Rideable vehicle in the shared world | enter/exit, passenger contract, camera handoff, flight-speed prediction, damage unification | the whole point |
| B. Separate flight mode over the same map | terrain bridge only | aircraft in the air fastest; the worlds never touch |
| C. Air support you call, not fly | terrain bridge + replicated AI aircraft | proves replication with no input problem |

Recommended: build toward A by shipping C first. An AI aircraft over base-game terrain is a real
milestone on its own and it exercises every seam except the one with a human in the seat.

## The three collisions

### 1. Two terrains, both authoritative

`flight-terrain.js` is an analytic 16-wave field plus its own five-ring clipmap to 8 km, with
`SEA_LEVEL = 0` and `dryAnchor` for base placement. Base Game has a v5 source, 30 m streamed chunks,
`world-query-heightfield-provider.js` for collision, far-LOD rings to 6.1 km and a sea level that is
a shared world key. Only one of these can be the ground.

The seam exists: `setHeightSource(fn)` in `flight-terrain.js` makes `heightAt` and `agl` sample
whatever is passed. Every flight module (`flight-model`, `flight-ai`, `flight-combat`,
`flight-autopilot`, `flight-drones`) already goes through those two functions. The flight clipmap,
`WAVES`, `SEA_LEVEL` and `dryAnchor` stay in the demo and never enter the game.

**Gate.** Sample 200 points on a spiral out to the far-LOD edge: `heightAt` must equal the base-game
source's authoritative height exactly, and must be within one cell of the *rendered* far-ring
height, or AI aircraft fly into hills nobody drew (flight.md already records that AI ignores
terrain; do not add a second reason).

**Collision radius.** Base Game streams collision 3 chunks (90 m) around the player, centred on
the player. The fixed-wing airframe cruises at 105–120 m/s. Aircraft need a terrain query that is
answered from the source, not from resident chunks, which `heightAt` on the source already is; but
bombs, missiles and wrecks that call `worldQuery` for impacts will find no ground outside the
resident set. Decide per call: `heightAt` for flight and ballistics, `worldQuery` only inside the
resident radius.

### 2. Coordinate spaces

Flight modules pass raw `THREE.Vector3` world positions and the demo never rebases. Base Game keeps
canonical positions as global `[x, y, z]` and renders relative to a movable origin
(`world-coordinates.js`). The flight physics is pure, so wrap it: the flyer lives in global
coordinates, conversion happens only at mesh placement, and the aircraft renderer subscribes to
`onRebase`.

**Audit before trusting it.** `agl()`, `stepMissile`, `stepBomb`, `bombImpact` and `stepWreck` all
read `.y` directly. If any is ever handed a render-local vector it works near the origin and fails
5 km out, which is exactly where a flight sim spends its time. `test-world-coordinates.mjs` has the
billion-unit cases to copy.

### 3. Nothing but players is replicated

Protocol 12 replicates players and combat projectiles. An aircraft is a server-simulated body with a
driver, and that concept does not exist in `server/base-game-rooms.js`. This is the same shape as the
entity-registry goal that was set for the environment viewer and never reached Base Game.

Build the generic table first and make aircraft its first `kind`. Do not special-case aircraft the
way lights were once special-cased; the second vehicle pays for that twice.

## Order

0. **Flight terrain profile.** A settings profile for Base Game terrain that widens the far LOD and
   raises the chunk build budget, and a source-side `heightAt` path that bypasses residency. Gate:
   the profile toggles live with the player standing still and the walking profile still passes
   `test-base-game-terrain.mjs`.
1. **Terrain bridge.** `setHeightSource` bound to the active Base Game source; rebinds on
   `setSource`. Gate: the 200-point spiral above, run in Node against the analytic descriptor and
   against one v5 project.
2. **`entity-types/aircraft.js`.** flight.md already names this as the missing piece. Server steps
   `stepFlyer` at 120 Hz beside players, drives it with `driveAi` or `driveAutopilot`, snapshots
   position, quaternion, velocity and hp. Client renders through `flight-meshes.js` /
   `aircraft-meshes.js` in render-local space. Gate: two clients see the same aircraft within one
   interpolation delay after a rebase on one of them.
3. **Enter and exit, the passenger contract.** A seated player's global position is derived from the
   aircraft each tick; input goes to the aircraft, not the capsule; camera hands off through
   `base-game-player-view.js`. Exit places the capsule with the aircraft's velocity. World-query
   already reports moving-surface velocity, which is the hard half of standing on a moving deck.
   Gate: enter, fly 5 km, land, exit, and the hurt rig, loadout and ammo are what they were.
4. **Damage unification.** The aircraft registers as a world-query provider so hitscan and
   projectiles hit it; its guns emit the existing shot, hit and explosion events rather than
   `flight-combat.js`'s private ones. Flight's single hit-point number is the aircraft's; the pilot
   keeps the 18-capsule rig only once exposed cockpits exist. Gate: a rifle round from the ground
   damages a flying aircraft and the shooter sees the same hit event the pilot does.

## Traps to write down now

- **Prediction at flight speed.** The 100 ms interpolation delay (`BASE_GAME_LAG_COMP_MS`) is 12 m
  of fixed-wing travel; `BASE_GAME_MAX_TICKS_PER_PACKET`, `MAX_TICKS_AHEAD` and the reconciliation
  thresholds were tuned for a 6 m/s capsule. Reconciliation snaps that are invisible on foot are a
  visible teleport in the air. Step 3 will need its own tolerances, not larger copies of the walking
  ones.
- **Two of every cosmetic system.** Flight has its own sky, clouds, rain, lightning, rain bed and
  audio. All of Base Game's versions win; flight's die at the door. Explosions, debris and the
  explosion budget are already the same modules on both sides and need no work.
- **`SHELL_GRAVITY = 0.35`** in `flight-combat.js` is deliberately arcade. Base Game ballistics use
  real gravity through `bot-projectiles.js`. Aircraft guns need to pick one; the doc for whichever
  loses should say why.
- **No hardpoints.** flight.md is explicit: ordnance spawns at literal offsets and nothing is
  visible on the airframe before it fires. `aircraft-library.js` / `aircraft-meshes.js` are where
  that is fixed and it is authoring, not wiring.
- **AI and terrain.** The AI flies through hills and ground sites shoot through mountains. Neither
  gets better by changing the terrain under them; it goes on the list for step 2.
- **Depth precision.** A first-person weapon at 0.1 m and terrain at 6 km in one frame. Base Game
  already renders the far rings, so this is probably fine, but a cockpit view over a 300 m ridge is
  the case to look at.
- **Water.** Flight's `SEA_LEVEL`/`DRY_MARGIN` placement logic assumes a flat plane at 0. Base Game
  sea level is a shared key with limits of ±120 m and hydrology is planned on top. Any airfield or
  ground-site placement goes through Base Game's ground height, never `dryAnchor`.
