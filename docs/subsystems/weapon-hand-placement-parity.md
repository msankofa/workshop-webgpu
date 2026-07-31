# Weapon Hand Placement and Cross-Viewer Parity

Date: 2026-07-12  
Status: Current implementation audit; this document describes the code as it exists today and is not a frozen interface contract.

## Executive summary

Third-person hands are not parented directly to the gun. Instead, the game transforms authored grip anchors into world-space targets every frame and sends those targets to the procedural body's two-bone arm IK solver.

The body preview and environment viewer mostly match because they use the same data files, weapon models, procedural-body implementation, pose controller, body dimensions, mount hierarchy, and transform conventions. The weapon-normalization and anchor-baking code is duplicated rather than shared, however, and there is no end-to-end parity test.

Exact parity is not currently guaranteed. In particular:

- `body-preview-v3.html` ignores the authored crouch hold used by the environment viewer.
- Both preview and runtime apply newly resolved arm targets one frame late.
- Arm reach is clamped, so an unreachable grip cannot be met exactly.
- First-person idle/ADS hands and V3 imported-skin hand correction use separate paths.

## Sources of truth

| Source | Responsibility | Authoring path |
|---|---|---|
| [`weapon-anchors.json`](../../weapon-anchors.json) | Named weapon contact frames such as `rightGrip`, `leftGrip`, `magwell`, `chargingHandle`, and `muzzle` | [`weapon-anchor-editor.html`](../../weapon-anchor-editor.html) |
| [`weapons.js`](../../weapons.js) | Weapon model path and whole-weapon placement relative to the body: `thirdPersonHold`, `crouchHold`, and `proneHold` | Body-preview hold controls and manual code update |
| [`weapon-poses.json`](../../weapon-poses.json) | Low-ready, aimed, and reload weapon poses plus timed left/right hand references | Reload tuner in `body-preview-v3.html` and manual file replacement |
| [`weapon-pose-controller.js`](../../weapon-pose-controller.js) | Per-frame weapon pose, target-reference resolution, hand-target glide, and calls to `body.setArmTarget()` | Shared runtime module |
| [`player-procedural-body.js`](../../player-procedural-body.js) | World-space arm targets, deterministic two-bone IK, reach clamp, wrist placement, and hand orientation | Shared runtime module |

The older normative API description is in [`procedural-body-weapon-contracts.md`](procedural-body-weapon-contracts.md). Some comments there and in `weapon-anchors.json` are stale: the active implementation treats anchor numbers as raw GLB-root coordinates and the viewers fetch the sidecar directly; `weapons.js` does not load or merge it.

## End-to-end transform pipeline

```text
weapon-anchor-editor.html
  authors raw GLB-root p/q
            |
            v
weapon-anchors.json
            |
            +------------------------------+
            |                              |
            v                              v
body-preview-v3.html             environment-viewer.html
  normalize GLB to 0.62            normalize GLB to 0.62
  bake anchor p/q                   bake anchor p/q
            |                              |
            +---------------+--------------+
                            v
                 weapon-pose-controller.js
                 resolve grip to world space
                            |
                            v
              body.setArmTarget(side, target)
                            |
                            v
                player-procedural-body.js
                shoulder/elbow/wrist IK
```

### 1. Anchor authoring

`weapon-anchor-editor.html` lines 70-76 define the active coordinate convention. The loaded weapon is kept under an identity `modelGroup`, so marker transforms are stored in the weapon GLB's root coordinate frame before runtime rotation, scaling, or recentering.

An anchor has the shape:

```json
{
  "p": [x, y, z],
  "q": [x, y, z, w]
}
```

- `p` is the contact position in raw weapon-root coordinates.
- `q` is the desired hand/contact orientation.
- Clicking a model stores the raycast hit after converting it through `modelGroup.worldToLocal()`.
- Initial orientation points local `+Z` toward the negative surface normal; roll and final wrist orientation are tuned with the local-space gizmo.
- Marker position and quaternion are serialized verbatim into the full sidecar object.

The editor only copies or downloads JSON. It does not write the repository file automatically, so an exported file must replace `weapon-anchors.json` before the preview or game will consume it.

### 2. GLB normalization and anchor baking

Both `body-preview-v3.html` lines 953-979 and `environment-viewer.html` lines 5795-5820 perform the same steps:

1. Find the model's longest bounding-box dimension.
2. Rotate an X- or Y-long model so it follows the expected weapon axis.
3. Uniformly scale the longest dimension to `0.62`.
4. Recenter the model at the origin.
5. Return the resulting normalization matrix.
6. Apply the full matrix to every raw anchor position.
7. Premultiply every anchor quaternion by the normalization rotation.

Conceptually:

```text
bakedPosition    = normalizationMatrix * rawPosition
bakedOrientation = normalizationRotation * rawOrientation
```

This accommodates assets exported in very different units. For example, some current anchors are around `13` raw units while others are around `0.1`; both are converted into the normalized body-preview/runtime space before use.

### 3. Shared weapon mount hierarchy

The preview and third-person environment viewer use the same topology:

```text
weaponRig
  weaponAdjust
    weaponFrame        rotation.y = PI
      weaponView       driven by weapon-pose-controller.js
        normalized GLB
```

- `weaponRig` is placed at the player/body position, with Y at terrain height plus `1.5`.
- `weaponRig` faces body yaw plus `PI`, matching the internally rotated procedural body.
- `weaponAdjust` receives the stance-specific hold position, Euler rotation, and uniform scale from `weapons.js`.
- `weaponFrame` supplies the fixed 180-degree camera-forward to body-forward conversion.
- `weaponView` receives low-ready, aim, reload, recoil, and pose-scale changes from the pose controller.

Both paths explicitly update the mount's world matrix before asking the controller to resolve the anchors. The preview does this around `body-preview-v3.html:3941-3959`; the game does it around `environment-viewer.html:7007-7035`.

Default preview body dimensions are height `1.8` and radius `0.3`. The environment viewer uses the same standing height and default collider radius, so the arm proportions used while authoring holds are deliberately aligned with runtime.

### 4. Per-frame hand targets

`weapon-pose-controller.js` defaults the hands to:

```text
right -> rightGrip
left  -> leftGrip
```

During reload, `weapon-poses.json` can carry each hand to another weapon anchor, a body-local point, a camera-local point, or a world point. Target references are evaluated by [`weapon-sequence.js`](../../weapon-sequence.js).

For the current position/rotation-only resolver:

```text
worldPosition    = rootPosition + rootRotation * localPosition
worldOrientation = rootRotation * localOrientation
```

The controller re-resolves active references every frame. Once a hand has settled, this keeps its target moving with weapon pose, aim, recoil, and player motion. When a sequence changes references, the driven target glides at the configured constant speed rather than teleporting.

The resolved target is sent through the shared seam:

```js
body.setArmTarget(side, {
  position,       // world-space THREE.Vector3
  quaternion,     // desired world-space hand orientation
  weight: 1,
  hint,            // grip, support, or reload
});
```

### 5. Procedural arm IK

`player-procedural-body.js` lines 811-862 consume the target:

1. Blend it with the idle arm position if `weight < 1`.
2. Choose an elbow pole using the body-facing orientation and live IK tuning.
3. Redirect/re-solve the pole if necessary to keep the elbow outside the torso capsule.
4. Analytically solve shoulder-to-elbow and elbow-to-wrist lengths.
5. Put the wrist and procedural hand mesh at the solved endpoint.
6. Copy the target quaternion to the hand mesh.

The generated rig is internally mirrored, so `setArmTarget('left', ...)` deliberately drives the internally named right arm and vice versa. The public API and exposed joints retain visual-side naming.

The `hint` value is passed through the interface but is not currently used by `solveArm`; elbow behavior comes from the pole configuration and torso-capsule correction.

## First-person muzzle placement and effect tuning

The first-person muzzle uses the same raw `muzzle` entry from `weapon-anchors.json`, but it does not use the hand-target resolver. `environment-viewer.html` transforms the raw point and quaternion once through the rendered viewmodel root, then keeps an empty muzzle marker beside the model under the shared camera-local weapon group. This avoids applying the model-normalization transform twice while still inheriting view offset, aim, bob, carry, reload, and recoil from the group.

Each weapon has an independent `muzzleFx` profile in `weapons.js`:

- `offset` is an in-game correction layered onto the transformed authored position.
- Flash forward offset, size, growth, duration, and opacity are independently tunable.
- Smoke forward offset, travel, spread, rise, size, growth, duration, opacity, and wisp count are independently tunable.

Each hitscan weapon also has an independent `tracerFx` profile:

- Every accepted hitscan shot emits a tracer; frequency is not sampled or throttled.
- `speed` and `length` control the moving streak rather than changing hitscan damage timing.
- `width`, `opacity`, and `glow` control its one-pixel additive core and soft billboard glow.
- `minVisibleDistance` delays visible ignition until the round is away from the camera.

The environment viewer exposes these values under **Weapon control → Muzzle / firing FX** and **Weapon control → Tracer FX**. Edits update the selected weapon immediately and are included in named slider-state presets. With `?tune=1`, they are also mirrored to the `pcw:weaponTuning` localStorage record so they survive a browser refresh. The source defaults remain in `weapons.js`; browser tuning does not rewrite source files.

The **Show muzzle anchor** debug toggle displays a small magenta dot at the final runtime muzzle position. Because the dot is parented directly to the same muzzle marker used by firing effects, it includes the authored anchor transform, model normalization, per-weapon muzzle offset, view placement, aim, bob, reload, and recoil.

At fire time, the authored muzzle anchor supplies the smoke/flash position, but not its forward direction. The weapon GLBs do not share a reliable quaternion-axis convention, so the authoritative shot direction is used at emission and the camera's live forward direction is used during subsequent viewmodel updates. This prevents an anchor whose local axis points backward or sideways from reversing the smoke. While the local first-person effect remains alive, the environment viewer refreshes its source position and direction every render frame; strafing, camera motion, bob, and recoil therefore cannot leave the viewmodel effect behind. The ballistic hit ray and damage still resolve immediately from the authoritative camera/head origin. Separately, an eligible tracer round captures the muzzle and hit positions once, then advances a short head-and-tail segment between those fixed world points at the selected speed. The tail contracts into the target after the head arrives, so the result never becomes a full muzzle-to-target beam and never follows the moving player. The glow is assembled from pooled camera-facing sprites along the additive core. Networked muzzle points are accepted only when they remain within two world units of the validated shot origin; bots, third-person shots, and missing anchors retain the near-eye fallback. Short-range tracer entities retain a small replication envelope so a 20 Hz guest snapshot cannot miss them, but the renderer stops drawing as soon as the moving tail arrives. The effect renderer scatters smoke in a barrel-relative basis and applies vertical rise separately, instead of adding the old world-X/Z jitter. Smoke starts at the muzzle by default and moves forward according to the selected weapon's profile.

## What currently keeps preview and runtime aligned

- Both import the production `player-procedural-body.js` implementation.
- Both use the production `weapon-pose-controller.js` and `weapon-sequence.js` behavior.
- Both load the same GLB path from `weapons.js`.
- Both fetch the same anchor and pose sidecars.
- Both normalize the weapon to the same `0.62` target and bake anchors with the resulting matrix.
- Both use the same mount hierarchy and `PI` facing conversions.
- Both apply the same stance hold values when using the canonical `body-preview.html`.
- Both default to the same body height/radius and terrain-relative mount height.
- Both refresh the mount matrix before target resolution.

This is primarily shared-data and copy-parity, not a mechanically enforced invariant. The normalization, baking, and host-side mount wiring are duplicated between HTML files.

## Known parity gaps and limitations

### 1. ~~Third-person anchor scale is dropped~~ (fixed 2026-07-15)

`weapon-pose-controller.js`'s `asRoot()` now decomposes and forwards `scale` alongside position/quaternion. `weapon-sequence.js`'s `composeRoot()` takes an explicit `scale` argument and multiplies the local anchor position by it component-wise before rotating; the two weapon-anchor call sites (plain string ref and `{ weaponAnchor, offset }` ref) pass `weaponRoot.scale`, while body/camera-ref call sites still omit it (those offsets are already authored in body-scale units and must not be scaled by the weapon). Covered by `test-weapon-sequence.mjs`.

Previously: `asRoot()` forwarded only position and quaternion, so `handTarget = rootPosition + rootRotation * bakedAnchor` diverged from the visible `rootPosition + rootRotation * (rootScale * bakedAnchor)` whenever a weapon's `thirdPersonHold` scale wasn't `1` (e.g. `0.68` for the M1911, `2` for the M24/Bren/RPG) — the hand would visibly miss the grip.

The first-person reload path was unaffected; it already handled scale separately by explicitly multiplying baked anchor positions by `viewScale`.

### 2. `body-preview-v3.html` crouch hold differs from runtime

At lines 3585-3590, V3 seeds its crouch profile from the standing hold instead of `weapon.crouchHold`. Its Copy-tuning output at lines 3795-3808 also omits `crouchHold`.

The environment viewer reads and blends the real `thirdPersonHold`, `crouchHold`, and `proneHold`. Therefore V3 crouch placement does not reproduce runtime when a weapon has a distinct crouch hold.

The older canonical `body-preview.html` lines 597-645 handles all three holds correctly.

### 3. Arm targets are applied one frame late

Both preview and runtime call `body.update()` before `controller.update()`. The controller writes the next arm target after the body has already solved its arms for that frame.

This keeps the two hosts behaviorally consistent, but it makes the hands trail a moving or recoiling weapon by one frame.

### 4. IK is reach-limited

The analytic solver clamps the hand endpoint to the valid interval defined by the two arm-bone lengths. If an authored grip is outside reach, the arm straightens toward it but the hand cannot land exactly on the anchor.

This is expected solver behavior rather than a coordinate-space failure.

### 5. First-person hands are a separate path

[`player-hands.js`](../../player-hands.js) uses hardcoded camera-local idle positions for first-person orb hands. These positions are not resolved from `rightGrip` and `leftGrip`, and unsupported weapons fall back to the M1911 pose.

Only first-person reload choreography resolves the shared sequence and anchor data. That path uses camera-local roots and explicit `viewScale` compensation.

Consequently, “hands stay on the gun” applies to the third-person procedural-body IK and to first-person reload targets, not ordinary first-person idle or ADS hands.

### 6. V3 imported-skin tuning is preview-only

The imported-character mode in `body-preview-v3.html` has an additional adaptation layer:

- It derives an anatomical palm frame from the imported hand/finger bones.
- It targets the palm center rather than the wrist origin.
- It can correct anchor orientation toward the closest weapon surface.
- It stores translation, rotation, finger-curl, and thumb-curl tuning in browser localStorage.
- It can translate the displayed weapon by the average residual from the two arm solves.
- Its validator checks palm distance, orientation error, and finger/thumb intersection with the weapon mesh.

The environment viewer does not consume these localStorage profiles or apply the residual weapon translation. A passing V3 imported-skin diagnostic therefore does not prove runtime procedural-hand parity.

### 7. Anchor-editor guardrails are limited

The editor currently has no schema, finite-number, vector-length, normalized-quaternion, required-anchor, model-hash, or weapon/model identity validation.

Changing the weapon ID updates the markers and model-path label but does not automatically load that weapon's model. The user must press **Load model**. It is therefore possible to author weapon B's anchors while weapon A's mesh remains visible.

### 8. Missing anchors fail softly

An unknown string target falls through to body-anchor handling and may resolve to the body-root origin. A missing `{ weaponAnchor }` likewise falls back to the weapon-local origin. The environment viewer skips a third-person mount only when the entire weapon anchor set is absent; it does not validate every required anchor name.

### 9. Remote/bot players now use this IK path

Bots (and remote bodies rendered with `useProceduralBody`) drive the full procedural body plus real weapon-anchor arm IK via a per-bot mount, not the old capsule/hand placeholders — see `docs/subsystems/bots.md` "Bot weapon rendering". One difference from the local mount: the bot mount's rig **must** be placed at `terrainHeight(x,z) + 1.5` (not an absolute constant), the same terrain-relative convention this contract's local path uses; a flat-floor absolute placement buries the gun and both arm targets underground on real terrain (fixed 2026-07-19). Bots reuse the local player's `lbWeaponModelCache` template and `skeletonClone` per mount, so the shared weapon geometry/materials are not disposed per bot.

**The bot mount is no longer static-hold-only (2026-07-30).** `environment-viewer-v2.html` and `bot-viewer-v2.html` both feed `weaponAdjust` from [`weapon-hold-resolver.js`](../../weapon-hold-resolver.js) instead of assigning `def.thirdPersonHold` verbatim. `resolveWeaponHold(def, stanceWeights, carryBlend, out)` lerps `thirdPersonHold`/`crouchHold`/`proneHold` on the rig's own eased `{crouch01, prone01}` weights and then **adds** a walk/run/dash carry delta (`CARRY_PRESETS` per `carryClass`, or a weapon's own `carryHolds`), eased at `CARRY_BLEND_RATE`. Rotations compose by component-wise addition, matching how the stance holds were already blended and how the authoring sliders manipulate them, so the tool stays WYSIWYG. Two invariants this contract depends on: the mount root must stay in the **ground-anchored, stance-invariant** frame (`terrain + 1.5`), because the authored crouch/prone holds already contain the stance drop and mounting to the torso joint would double-count it; and a carry pose must never be barrel-solved onto an aim point (`isCarryLocomotion` gates `alignMountedWeaponToPoint` / `alignEnvironmentBotWeaponToPoint`), because the solve would undo the whole muzzle-down pose. `locomotionFor` returns `aim` whenever the bot is aiming and the aim delta is zero, so the aimed hold — the one this document's parity claims are about — is bit-identical to the pre-2026-07-30 behaviour. The local player mount and `body-preview-v3.html` do not consume the resolver yet; that is a live parity gap for the walking/running third-person player.

`environment-viewer-v2.html` additionally hangs two **non-IK** props off the bot body that have no counterpart in this contract's pipeline: stowed weapons (the loadout minus what is in hand, on the back or hip) and a grenade prop during a throw wind-up. They are plain `skeletonClone`s of the same normalized template placed by a single torso-relative transform — no anchors, no pose controller, no arm targets — so they neither participate in nor constrain the hand-placement parity described above.

## Verification status

The following existing test suites pass as of the date above:

- `node test-weapon-sequence.mjs`: 54 passed, 0 failed (includes weaponRoot.scale coverage).
- `node test-weapon-pose-controller.mjs`: all assertions passed.
- `node test-player-body-ik.mjs`: 30 passed, 0 failed.
- `node test-player-hands.mjs`: passed.

They cover sequence evaluation, target reference behavior, hand glide, weapon pose chase, reload events, torso-aware elbow correction, and first-person hand motion.

They do not currently cover:

- End-to-end GLB normalization/baking parity between preview and environment viewer.
- Required-anchor schema validation.
- Weapon-ID/model-ID agreement in the anchor editor.
- V3 crouch-hold parity with `weapons.js` and the environment viewer.
- Imported-skin localStorage tuning versus runtime behavior.

## Recommended hardening work

1. ~~Carry uniform/world scale through `resolveTargetRef()`, or resolve weapon anchors with the full weapon matrix.~~ Done (see gap #1 above).
2. Extract weapon normalization and anchor baking into one shared module used by both preview and environment viewer.
3. Make V3 seed and export `crouchHold` exactly as `body-preview.html` does.
4. Add anchor schema validation and automatically reload the selected weapon model in the editor.
5. Add a browser or headless scene-graph parity test with a non-unit parent scale.
6. Add a test that compares preview and runtime mount transforms for standing, crouching, and prone.
7. If same-frame contact is required, split procedural-body update into a root/body prepass and an arm-IK pass so the controller can resolve against the current body root before arms are solved.
