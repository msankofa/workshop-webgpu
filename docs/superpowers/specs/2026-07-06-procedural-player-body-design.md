# Procedural Player Body

Date: 2026-07-06
Subsystem: player visuals / multiplayer (`environment-viewer.html`, `multiplayer.js`, new `player-procedural-body.js`)

## Goal

Give players a procedural walking body driven by the existing capsule/camera controller:

- Remote players render as readable walking bodies instead of simple capsules.
- Local first-person can optionally render legs/lower body without replacing the current hands/weapon viewmodel.
- Local third-person can render the player's full procedural body so the player can inspect their own walking/aiming/reload motion.
- Player movement, collision, combat, and networking remain owned by the existing player controller and host-authoritative state.
- Body motion is visual-only: IK follows the player pose; it does not move the player.

## Background

The current player visual stack is split:

- Local FPS player: camera at the capsule top; the local capsule/body is not rendered.
- Local hands/weapon: camera-attached viewmodels (`player-hands.js` and local weapon viewmodel).
- Remote players: `GhostRenderer` renders capsules with eyes/orb hands from replicated player snapshots.
- Procedural creatures: `port-creature-system.js` has a FABRIK `KinematicChain`, foot planning, gait scheduling, terrain-aware foot placement, and body pitch/roll, but it also owns full creature physics.

The procedural player body should reuse the IK/gait ideas, not the creature physics authority.

## Non-Goals

- Replacing capsule collision or FPS movement.
- Using procedural body physics to push the camera/player.
- Retargeting arbitrary humanoid skeleton animations.
- Full third-person playable camera.
- Network replication of every foot/hand point in v1.

## Design Principles

- **Controller first**: the capsule/camera state is authoritative.
- **Visual follower**: the body follows `p`, `q`, `h`, `r`, velocity, crouch height, and terrain.
- **Derived animation**: remote clients derive walk cycles locally from interpolated snapshots.
- **No local body occlusion**: local FPS mode starts with legs/lower torso only; hands/weapon stay camera-attached.
- **Inspectability**: third-person/orbit mode should be able to show the local player's full procedural body, using the same rig as remote players.
- **Reusable IK core**: extract a small IK/gait module instead of importing the whole creature system.

## Data Flow

Input per player:

```js
{
  id,
  p: [x, y, z],        // capsule center or body center from player snapshot
  q: [x, y, z, w],     // yaw-only orientation for remote players
  h,                   // capsule height
  r,                   // capsule radius
  aimPitch,            // optional, already used by weapon/view state
  tool,
  weapon,
  alive,
}
```

Local-only extra inputs:

```js
{
  camera,
  playerCollider,
  playerVelocity,
  playerOnFloor,
  fpsMode,
  crouchFraction,
}
```

The procedural body derives:

- root / pelvis position from the capsule.
- facing from yaw.
- speed from horizontal delta or `playerVelocity`.
- stride phase from speed.
- foot targets from terrain-aware gait stepping.
- body bob, pitch, and roll from stance and terrain.

## Module Shape

Create `player-procedural-body.js`:

```js
export function createProceduralPlayerBody({
  THREE,
  scene,
  terrainHeight,
  mode = 'remote', // 'remote' | 'local-lower-body' | 'local-third-person'
  style,
}) {
  return {
    group,
    update(dt, state),
    setVisible(v),
    setTint(hsl),
    destroy(),
  };
}
```

`state`:

```js
{
  id,
  position: THREE.Vector3,
  yaw,
  aimPitch,
  height,
  radius,
  velocity,
  onFloor,
  crouch,
  alive,
  weapon,
  tool,
}
```

## IK Core

Extract or duplicate a narrow subset from `port-creature-system.js`:

- `KinematicChain`: FABRIK solver.
- `terrainNormal(x, z)`: foot orientation helper.
- simple biped step scheduler.
- body bob/pitch/roll smoothing.

Do not import the full `Creature` class. Its `physicsStep()` moves the creature from feet/balance, which conflicts with the player controller.

## Body Rig V1

V1 can be a generated humanoid, not a skinned model:

- pelvis/torso: simple capsule/box/spheres.
- head optional for remote only.
- legs: two IK chains, hip -> knee -> foot.
- feet: flattened capsule/box/sphere oriented to terrain.
- arms optional in this spec; gunplay spec owns arm behavior.

Local FPS mode:

- render legs and lower torso only.
- hide torso/head/upper arms by default.
- update from the real camera/capsule pose.
- disable or fade legs if camera pitch/stance causes clipping.

Local third-person mode:

- render the full procedural body for the local player.
- use the same generated body and IK gait as remote players.
- keep the body rooted to the actual player capsule, not to the camera target.
- show torso/head/arms/weapon so the player can inspect walking, aiming, firing, and reload behavior.
- hide or fade camera-obstructing body parts only if the camera gets very close to the avatar.
- avoid rendering the separate local first-person hands/weapon viewmodel while this mode is active; the procedural body/weapon should be the visible representation.

Remote mode:

- render full body.
- replace or hide the old remote capsule body after parity.
- keep eyes/hands during transition if useful.

## Camera / Visibility Modes

The body renderer should support three local visibility modes:

```js
{
  localBodyMode: 'off' | 'fps-legs' | 'third-person-full'
}
```

Rules:

- `off`: current behavior; no local body.
- `fps-legs`: first-person lower body only, with camera-attached hands/weapon still active.
- `third-person-full`: full local body visible, camera-attached hands/weapon hidden, procedural/held weapon visible on the body.

The existing orbit camera is acceptable for inspection, but a later follow-camera can use the same mode. This spec does not require a production third-person movement camera; it only requires the local body to render correctly when the camera is outside the avatar.

## Gait

The biped gait should be simpler than procedural creatures:

- Two foot anchors in body-local space: left/right.
- Each foot has `current`, `target`, `rest`, `stepping`, `phase`.
- A foot starts a step when horizontal/vertical drift from rest exceeds thresholds.
- Feet alternate: never step both feet at once unless recovering from teleport.
- Step target is rest position plus velocity look-ahead projected to terrain.
- Step curve uses ease-in-out plus vertical lift.
- If player speed is near zero, feet settle under hips.

Suggested defaults:

```js
{
  stepDuration: 0.18,
  stepLift: 0.14,
  triggerDistance: 0.28,
  maxStepDistance: 0.75,
  lookAhead: 0.16,
  pelvisHeightRatio: 0.54,
  hipWidthRatio: 0.42,
}
```

## Multiplayer

V1 should not replicate feet. Remote bodies derive their gait from interpolated player positions.

Snapshot additions only if already available:

- `aimPitch` for upper-body/weapon aim.
- `tool` / `weapon` for future arm pose selection.
- `alive` to collapse/hide body on death.

If gait desync looks bad, add optional cosmetic fields later:

```js
bodyAnim: {
  stridePhase,
  leftFootDown,
  rightFootDown,
}
```

## Integration Plan

1. Add `player-procedural-body.js` with a generated biped visual and pure update API.
2. Add a headless test for the gait scheduler: alternating feet, terrain height sampling, teleport reset.
3. Add remote-body mode to `GhostRenderer` behind a feature flag, keeping capsule fallback.
4. Add local lower-body mode behind a feature flag, hidden outside FPS mode.
5. Add local third-person/full-body visibility behind a feature flag or debug toggle.
6. Hide the local first-person hands/weapon viewmodel when `localBodyMode === 'third-person-full'`.
7. Tune proportions against `capsuleH` and `capsuleR`.
8. Document the player visual split in subsystem docs.

## Acceptance Criteria

- Remote players visibly walk with alternating planted feet while moving.
- Standing remote players settle with both feet on terrain.
- Local FPS lower body does not obscure the crosshair or weapon viewmodel.
- Local third-person/full-body mode shows the player's own full procedural body walking on the terrain.
- In third-person/full-body mode, the camera-attached hands/weapon do not double-render over the body-held weapon.
- Player collision, movement, gun hit registration, and ClaudeCraft mob combat are unchanged.
- Two-client relay test still shows coherent remote movement.

## Follow-Ups

- Procedural arms integrated with weapon anchors.
- Death/fall poses.
- Jump/landing compression.
- Terrain slope foot roll and knee bias tuning.
- Optional authored style presets: human, robot, creature, low-poly.

