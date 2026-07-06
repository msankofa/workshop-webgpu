# Procedural Gunplay: Anchors, Poses, and IK Sequences

Date: 2026-07-06
Subsystem: weapons / player visuals (`weapons.js`, `environment-viewer.html`, `player-hands.js`, new weapon anchor editor, new procedural arm/sequence modules)

## Goal

Build a data-driven procedural gunplay animation system:

- Use a standalone tool to select precise points on each weapon model.
- Use in-game controls to pose the weapon/body in gameplay context.
- Drive procedural arms/hands with IK targets for holding, aiming, firing, and reloading.
- Author complex reloads as timed sequences of weapon poses, hand targets, and prop events.
- Keep weapon gameplay host-authoritative and separate from visual animation.

## Background

The weapon system already has useful runtime state:

- `weapons.js` defines weapon model paths, view offsets, recoil, fire rate, magazine size, and ammo.
- The local weapon viewmodel loads GLBs and applies placement sliders/recoil.
- `player-hands.js` already reacts to recoil/charge with simple hand motion.
- `gun.fire` and `gun.reload` intents already exist.
- Multiplayer snapshots carry weapon/ammo/fire sequence state for remote feedback.

The missing layer is a reusable authoring/runtime model for:

- weapon-space anchors.
- player/body-space anchors.
- timed pose sequences.
- IK hand targets.
- prop visibility/events for magazines, bolts, charging handles, etc.

## Non-Goals

- Full skeletal animation authoring.
- Physics-based weapon manipulation.
- Server-side animation validation.
- Making reload timing authoritative in the first milestone.
- A full DCC replacement; the standalone editor only captures game-relevant points and orientations.

## Core Model

Separate the problem into four data types:

1. **Weapon anchors**: points on the weapon model in weapon-local space.
2. **Body anchors**: points on or near the player body in body/camera-local space.
3. **Weapon poses**: transforms for the weapon root relative to camera/body.
4. **Sequences**: timed channels that move hands, weapon, and props through targets.

Runtime IK solves arms toward the current interpolated targets. The sequence data describes intent; IK produces the final limb pose each frame.

## Weapon Anchor Data

Add per-weapon metadata, either in `weapons.js` or a sidecar file such as `weapon-anchors.json`.

```js
ikAnchors: {
  rightGrip: {
    p: [0.02, -0.04, -0.12],
    q: [0, 0, 0, 1]
  },
  leftGrip: {
    p: [-0.18, -0.03, -0.34],
    q: [0, 0, 0, 1]
  },
  magwell: {
    p: [0.01, -0.18, -0.18],
    q: [0, 0, 0, 1]
  },
  chargingHandle: {
    p: [0.0, 0.07, -0.28],
    q: [0, 0, 0, 1]
  },
  muzzle: {
    p: [0, 0.02, -0.65],
    q: [0, 0, 0, 1]
  }
}
```

Each anchor should include position and orientation. Position gets the hand to the target; orientation lets wrist/weapon contact look intentional.

## Standalone Weapon Anchor Editor

Create a standalone HTML tool, for example `weapon-anchor-editor.html`.

Purpose:

- Load a weapon GLB from `models/guns/` or from a local file picker.
- Show it with orbit controls, grid, axes, lighting, and bounding box.
- Select an anchor name from a list.
- Add/move/rotate a gizmo on the model.
- Optionally snap anchor position by raycasting onto the weapon mesh.
- Show ghost hand spheres and orientation axes at anchors.
- Export/copy JSON.

Minimum controls:

- Weapon dropdown/file picker.
- Anchor dropdown: `rightGrip`, `leftGrip`, `magwell`, `chargingHandle`, `muzzle`, custom.
- Add anchor at clicked point.
- Translate/rotate selected anchor.
- Nudge controls for precision.
- Copy JSON.

This tool handles model-space precision. It should not try to author full reload behavior.

## In-Game Pose Authoring

Use the current gun placement sliders as the seed for a pose editor in `environment-viewer.html`.

Pose data:

```js
weaponPoses: {
  lowReady: {
    p: [0.24, -0.42, -0.62],
    r: [-0.08, -0.04, -0.02],
    scale: 1.0
  },
  aimed: {
    p: [0.30, -0.31, -0.68],
    r: [-0.02, -0.04, -0.03],
    scale: 1.0
  },
  reloadRaise: {
    p: [0.22, -0.20, -0.50],
    r: [0.25, -0.12, 0.20],
    scale: 1.0
  }
}
```

The game context matters here: camera FOV, player body, hand reach, and first-person clipping are visible only in the actual viewer.

## Sequence Data

A sequence is a set of timed channels. Each keyframe can target a weapon anchor, body anchor, local offset, or world/body-space point.

```js
reloadSequence: {
  duration: 1.45,
  commitAmmoAt: 1.05,
  keys: [
    { t: 0.00, weaponPose: 'aimed', right: 'rightGrip', left: 'leftGrip' },
    { t: 0.18, weaponPose: 'reloadRaise', right: 'rightGrip', left: 'magwell' },
    { t: 0.35, right: 'rightGrip', left: { body: [-0.35, -0.35, -0.35] }, event: 'detachMagazine' },
    { t: 0.48, left: { body: [-0.70, -0.45, -0.40] }, event: 'tossMagazine' },
    { t: 0.68, left: 'beltMagazine', event: 'spawnFreshMagazine' },
    { t: 0.95, left: 'magwell', event: 'insertMagazine' },
    { t: 1.15, left: 'chargingHandle', event: 'grabChargingHandle' },
    { t: 1.28, left: { weaponAnchor: 'chargingHandle', offset: [0, 0, -0.12] }, event: 'pullChargingHandle' },
    { t: 1.38, left: 'leftGrip', weaponPose: 'aimed', event: 'releaseChargingHandle' }
  ]
}
```

Target resolver rules:

- String matching a weapon anchor: transform by current weapon root.
- String matching a body anchor: transform by body/camera root.
- `{ weaponAnchor, offset }`: anchor plus local offset.
- `{ body: [x,y,z] }`: body-local target.
- `{ camera: [x,y,z] }`: camera-local target for first-person viewmodels.
- `{ world: [x,y,z] }`: absolute debug/special-case target.

## Runtime Animation State

Add a visual-only weapon animation controller:

```js
createWeaponPoseController({
  THREE,
  body,
  weaponView,
  getWeaponDef,
}) -> {
  update(dt, state),
  play(actionName),
  setWeapon(id),
  setAiming(amount),
  recoil(amount),
}
```

State:

```js
{
  weaponId,
  action: 'idle' | 'aim' | 'fire' | 'reload' | 'swap',
  actionTime,
  fireSeq,
  reloading,
  ammoMag,
  ammoReserve,
  aimAmount,
}
```

The controller computes:

- weapon root pose.
- right-hand target.
- left-hand target.
- optional magazine/bolt prop transforms.
- recoil offsets.
- IK blend weights.

## IK Arms

The procedural player body should expose an arm target API:

```js
body.setArmTarget('right', {
  position,
  quaternion,
  weight,
  hint: 'grip' | 'support' | 'reload',
});

body.setArmTarget('left', {
  position,
  quaternion,
  weight,
  hint,
});
```

For local FPS:

- weapon aim remains camera/viewmodel-authoritative.
- arms solve to the weapon anchors.
- right hand usually follows `rightGrip`.
- left hand switches between `leftGrip`, `magwell`, `beltMagazine`, `chargingHandle`, and toss targets.

For remote players:

- weapon root follows replicated yaw/aim pitch.
- arms solve from body shoulders to the same resolved anchors.
- fire/reload actions are triggered by replicated `fireSeq` / reload state.

## Reload Gameplay Timing

Two viable modes:

### Visual-only reload v1

- Existing `gun.reload` instantly transfers ammo.
- The reload sequence plays cosmetically.
- Lowest risk, but reload visuals may not match gameplay timing.

### Timed reload v2

- `gun.reload` starts a reload state with `reloadStartAt`.
- Ammo commits at `commitAmmoAt`.
- Firing is blocked while reloading.
- Host owns reload timing and replicates `reloading`, `reloadSeq`, `reloadStartAt`.

Recommended path: ship visual-only v1, then convert to timed reload once the pose sequencer feels good.

## Events and Props

Sequence events drive small visual props:

- `detachMagazine`: hide magazine in gun, attach mag prop to left hand.
- `tossMagazine`: release mag prop along a short ballistic arc or fade it out.
- `spawnFreshMagazine`: attach fresh mag prop at body anchor.
- `insertMagazine`: hide hand mag, show gun magazine.
- `grabChargingHandle`: optional hand target/prop lock.
- `pullChargingHandle`: slide bolt/handle visual if model supports it.
- `releaseChargingHandle`: return handle to rest.
- `commitAmmo`: gameplay event in timed reload mode.

V1 can use simple box/placeholder magazine props if the GLB has no separable magazine mesh.

## Authoring UI Split

Standalone editor:

- model-space anchor placement.
- precise click/raycast/gizmo workflows.
- exports anchor JSON.

In-game editor:

- camera/body-relative weapon poses.
- hand target sequence authoring.
- timeline scrubber.
- play/stop action preview.
- save current weapon pose from sliders.
- save current left/right hand targets as sequence keyframes.

This split avoids precision point selection during gameplay while preserving gameplay-context tuning.

## Multiplayer

Minimum replicated fields:

```js
{
  weapon,
  aimPitch,
  fireSeq,
  reloading,
  reloadSeq,
  reloadStartedAt,
  ammoMag,
  ammoReserve
}
```

For v1 visual-only reload, `reloadStartedAt` can be local/cosmetic. For timed reload, host owns it.

Remote clients derive all arm/weapon animation from these fields. Do not replicate hand positions unless debugging proves it necessary.

## Implementation Plan

1. Add weapon anchor metadata structure and defaults for `m1911` and `m24`.
2. Build `weapon-anchor-editor.html` for model-space anchor placement/export.
3. Extend in-game weapon controls to save named weapon poses.
4. Add a sequence data shape and a small evaluator: interpolate weapon pose and resolve left/right hand targets by time.
5. Add procedural arm target API to the player body module.
6. Wire local first-person arms to current weapon anchors while aiming/firing.
7. Add one authored M1911 reload sequence with placeholder magazine prop events.
8. Replicate reload/fire visual state for remote procedural bodies.
9. Convert reload to timed gameplay only after visual sequencing is stable.

## Acceptance Criteria

- A weapon GLB can be opened in the standalone editor and anchors can be exported as JSON.
- In game, M1911 has `rightGrip`, `leftGrip`, `magwell`, `muzzle`, and `chargingHandle` anchors.
- Local procedural hands hold the weapon anchors while aiming.
- Firing triggers recoil in weapon pose and arms.
- Reload preview runs through a multi-step left-hand sequence: magwell, toss, body magazine, insert, cock/return.
- Remote players show coherent aim/fire/reload gestures from replicated state.
- Hit registration still uses gameplay ray/capsule logic, not hand or weapon mesh positions.

## Follow-Ups

- Per-weapon custom reload sequences.
- Add editable easing curves per keyframe.
- Visible separable magazine meshes.
- Bolt/slide animation for weapons with named parts.
- Two-handed melee and throwables using the same target sequencing system.
- Export/import authoring bundles for weapons, anchors, poses, and sequences.

