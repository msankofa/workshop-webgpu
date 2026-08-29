# Base Game drones: thrown quadcopter and UAV

**STATUS: steps 1-4 shipped 2026-08-27, Node-tested, unseen in a browser.** Weapons off, one gadget slot, chase camera for both, keys F/B/N, shoot-down math built but not wired to hits. First step of
[base-game-flight-integration.md](../../base-game-flight-integration.md), reading C (air support)
with the player able to take the stick. No passenger contract: the player body never leaves the
ground.

## What ships

A player carries a quadcopter and a fixed-wing UAV. Holding one raises it overhead in both hands;
throw launches it. A launched drone loiters around its owner on its own. The owner can either
**take over** (their input flies the drone, the camera moves to it, the body stands still) or
**send it** (aim at a point, press send; it flies there and loiters until recalled or retasked).
Drones are server-simulated and replicated, so every client sees every drone.

## Reuse, and what is new

Both airframes already exist in two viewers. Read, not grepped, 2026-08-27:

| Need | Owner | What it already does |
|---|---|---|
| Quadcopter body | `flight-sim`: `drone` airframe (`flight-airframes.js`, `aircraft-library.js` `DRONE_LAYOUT`/`DRONE_TUNING`) | 1.9 kg, 0.26 m hull, four 0.115 m rotors, `body-up` thrust, `attitude` control; the player flies it with the plane keys; `hp: 45` |
| Quadcopter mesh | `flight-meshes.js` `buildDrone` (or the layout mesh via `aircraft-meshes.js`) | v3 draws the same builder at 2.2x as its bomb drone; rotors spin in `userData.rotors` |
| UAV mesh | `flight-meshes.js` `buildRecon` | authored in real metres (~2 m span at 1x; v3 uses 1.2x); pusher prop in `userData.propeller` |
| UAV flight | none as a `flight-model` airframe; v3 flies the recon with `bot-drones.js` loiter (`orbitAround`, 10 m/s, 1.4 rad/s) | a player-flyable UAV needs either a registered airframe or player input on the bot-drones steer |
| Follow the owner, dock in hands, station keep | `bot-drones.js` (`shadow` over the operator's shoulder, `rearm` docking at `dockOffset`/`dockAlt`, `hoverTo`, `orbitAround`) | pure arrays, no THREE, Node-tested; tuned for a 50 m arena |
| Drone pose from yaw/pitch/bank, rotor spin | `bot-viewer-v3.html` `poseDroneCraft` | including the `lookAt` +Z flip the craft need |
| Hit volume, damage, deadstick, blast exposure | `bot-viewer-v3.html` `droneCapsuleFor`, `damageDrone`, `blastDamageDrones` | ported as logic |
| Chase and cockpit camera | `demos/flight-sim.html` `updateCamera` | cockpit offset scales with `af.size`, chase with `chaseDist` |
| Ground | `flight-terrain.js` `setHeightSource` bound to Base Game's source | the terrain bridge from the integration doc |
| Hold and throw | `weapon-mount.js` hold + `base-game-fire.js` `stepThrow` | the grenade path, with a new overhead hold |
| Replication | new `entities` array in the snapshot | first non-player replicated kind |

**One drone, two steppers.** `bot-drones.js` states (`shadow`, `rearm`, `climb`, `orbit`, a new
`goto`/`hold`) step it while nobody is flying; `flight-model.js` `stepFlyer` steps it in a new
`manual` state, so the quad flies with the flight sim's tilt physics and the UAV with the sim's `plane`
airframe (an invented `uav` airframe was tried first and removed the same day). Position and velocity are
metres and m/s on both sides; the handoff converts attitude only: take-over builds `q` from
`yaw`/`pitch`/`bank` and sets hover throttle, release derives them back from `q` and re-enters
`shadow` (quad) or `orbit` (UAV). Rescale the arena-tuned defs for open ground.

New files: `base-game-drones.js` (server-safe entity: state, autonomy, control mixing, sanitizer),
`base-game-drone-view.js` (client meshes, camera handoff, HUD), tests
`test-base-game-drones.mjs`.

## Protocol (version 13)

- `BASE_GAME_WEAPON_IDS` gains `quad` and `uav`; a fifth slot `gadget`. Holding the slot shows the
  drone overhead; `throw` (or `fire`) launches it. One of each airborne per player.
- Tick input gains `drone: { mode, pitch, roll, yaw, throttle, send: [x,y,z]|null, recall }`.
  `mode` is `0` none, `1` control. The server ignores drone input for a drone the client does not
  own.
- Snapshot gains `entities: [{ id, kind, owner, p, q, v, hp, mode, state, target }]`, sanitized by
  `sanitizeBaseGameEntityState`. Removed entities are absent; clients drop what they stop seeing.
- Player state gains `controlling: entityId|null` so remotes know a body is an operator (stands
  still, arms lowered, same pose the bot-viewer operator crouch uses).

## Server

`stepRoom` steps every drone after players, same 120 Hz. Per drone per tick:

1. Owner input if `mode === 1` and the owner is alive; otherwise autonomy. Autonomy is a small
   state machine: `follow` (station 12 m behind-and-above the owner for the quad, a 60 m orbit
   centred on the owner for the UAV) → `goto` (fly to `target`, then `hold` there) → `return`
   (recall). Terrain floor through `agl` with a hard minimum.
2. The step: `stepFlyer` in `manual`, `stepBotDrone` otherwise.
3. Death: hp ≤ 0 → v3's deadstick-or-break rule (`crippleDrone`; a manual drone releases first), removed when
   it lands; owner's slot refills after a cooldown.

The owner walking away is not a leash. A drone in `goto`/`hold` stays; only `follow` tracks.

## Client

- **Held:** the gadget slot draws the drone mesh through the weapon mount with an authored overhead
  hold (both hands up, mesh above the head). One new hold in `weapon-hold-resolver.js`'s
  vocabulary, `carryClass: 'overhead'`; no aim, no reload.
- **Throw:** the throw action plays; the server spawns the entity from the hand with the throw
  velocity; the client hides the held mesh once the entity appears.
- **Take over:** key `V` (free). Player input is routed to `drone` in the tick packet; the capsule
  gets neutral input. Camera: chase for the UAV, FPV for the quad, pitch/yaw from the mouse. HUD
  shows altitude, speed, distance to owner, and `Esc`/`V` to release. Prediction: none at first —
  the drone renders at the interpolated server pose like a remote player. If the lag is unplayable,
  that is the first tuning target, not a reason to predict up front.
- **Send:** `B` while holding the slot or controlling: raycast from the crosshair through
  `worldQuery`, then `heightAt` fallback beyond the resident radius; the point goes in the packet
  once.
- **Recall:** `B` again with nothing under the crosshair, or hold `B`.

## Order and gates

1. `base-game-drones.js` + tests: spawn from a throw, follow, goto/hold, recall, control mixing,
   wreck, sanitizer round-trip. Node only. Gate: a drone thrown at 8 m/s ends in `follow` within
   5 s over the analytic terrain and never dips under `agl` 2 m.
2. Protocol 13, server step and snapshot, `test-base-game-rooms.mjs` cases. Gate: two clients in
   `test-base-game-relay.mjs` see the same entity list.
3. Client view: meshes, interpolation, held overhead, throw. Gate: your look at it.
4. Take over + send + HUD. Gate: your look at it.
5. Docs: `base-game.md` roadmap entry, `flight.md` cross-link, `agent_log.csv`.

## Questions before step 1

1. **Weapons on the drones?** I plan none: recon only, the quad has no bombs and the UAV no gun.
   Say if you want the bot-viewer bomb drop on the quad from the start.
2. **Loadout:** a fifth `gadget` slot with the drone in it (my plan), or both drones as two
   gadget slots?
3. **Camera when controlling:** FPV quad + chase UAV (my plan), or chase for both?
4. **Keys:** `V` take over, `B` send/recall. Anything already on those in your muscle memory?
5. **Can the drone be shot down?** I plan yes, v3's `damageDrone` rules (30 hp quad, 22 hp UAV from
   `bot-drones.js`, deadstick chance), hit through a sphere provider on the world query.
