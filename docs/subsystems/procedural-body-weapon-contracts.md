# Procedural Body + Weapon — Frozen Interface Contracts

Date: 2026-07-06
Status: **normative**. Both build tracks (player-procedural-body, procedural-gunplay) implement against
the signatures here, not against each other's code. Do not change a signature in this file without
updating both tracks. Source specs: `docs/superpowers/specs/2026-07-06-procedural-player-body-design.md`,
`docs/superpowers/specs/2026-07-06-procedural-gunplay-design.md`.

The seam between the two features is exactly one API: **`body.setArmTarget(...)`**. The body owns it;
the weapon pose controller drives it.

---

## Contract 1 — Arm target seam

Exposed by the procedural body, consumed by the weapon pose controller and by remote posing.

```js
body.setArmTarget(side, {
  position,    // THREE.Vector3 — world-space hand target
  quaternion,  // THREE.Quaternion — desired wrist/hand orientation (optional; identity if omitted)
  weight,      // 0..1 blend toward this target vs. the idle arm pose (default 1)
  hint,        // 'grip' | 'support' | 'reload' | 'idle' — elbow-bias / pose selection
});
// side: 'left' | 'right'
```

- Called every frame the arm is under weapon control. When `weight` ramps to 0 the arm returns to
  the body's own idle/gait arm pose.
- The body solves IK toward the target during its own `update()`; callers never touch limb meshes.
- **Visual only.** Setting an arm target must never move the player capsule, camera, or affect
  hit-registration.

---

## Contract 2 — Procedural body module

New file: `player-procedural-body.js`.

```js
export function createProceduralPlayerBody({
  THREE,
  scene,
  terrainHeight,          // (x, z) => y
  mode = 'remote',        // 'remote' | 'local-lower-body' | 'local-third-person'
  style,                  // optional palette/proportion overrides
  adaptGaitToSpeed = false, // derive gait.cfg from the body's own speed each frame (see below)
}) {
  return {
    group,                // THREE.Group root (already added to scene) — stays at world origin; the rig
                          //   writes every mesh in ABSOLUTE world space, so group is NOT a usable frame.
    rootAnchor,           // parent-less Object3D kept at chest height + facing yaw each frame; this is
                          //   the frame body-space weapon refs resolve against (see Contract 4/5 note).
    update(dt, state),    // advance gait + IK toward state (see below)
    setArmTarget(side, target),  // Contract 1
    setVisible(v),
    setTint(hsl),
    destroy(),
    gait,      // live gait scheduler; tune gait.cfg (read-mostly)
    proneCfg,  // live prone-pose tuning (hipHeight, pitch, torsoFwd, footBack, …)
    crouchCfg, // live crouch-pose tuning (pelvisDrop, torsoDrop, headDrop, shoulderDrop, lean, fwd)
    ikCfg,     // live elbow/knee pole-rotation tuning, VISUAL side naming (leftArmPole, leftArmPoleProne, leftLegPole, leftLegPoleProne, right…)
    // Arm IK is additionally torso-aware: a vertical capsule around the spine forces the elbow pole
    // outward (no backward bend) and re-solves once if the elbow lands inside the torso (no phasing).
    // See docs/subsystems/creature.md; tunables TORSO_CAPSULE_RADIUS_MARGIN / TORSO_CAPSULE_Y_PAD.
    joints,    // { leftShoulder..leftHand, rightShoulder..rightHand, leftHip..leftFoot, rightHip..rightFoot, pelvis, waist, torso, neck, head } mesh refs, VISUAL side naming, for picking
  };
}
```

`state` passed to `update(dt, state)`:

```js
{
  id,
  position,     // THREE.Vector3 — capsule/body center (authoritative, from controller/snapshot)
  yaw,          // radians — facing
  aimPitch,     // radians — optional upper-body/weapon aim
  height,       // capsule height
  radius,       // capsule radius
  velocity,     // THREE.Vector3 — for stride phase/look-ahead (optional; derived from delta if absent)
  onFloor,      // bool
  crouch,       // 0..1 — squash/hunch of the upright stack; tune via crouchCfg
  prone,        // 0..1 — lie-down blend (pitch body horizontal, limbs fore/aft); tune via proneCfg
  alive,        // bool — collapse/hide when false
  weapon, tool, // ids, for future arm-pose selection
}
```

Rules:
- The body is a **pure follower**: it reads `state`, never writes player/controller state.
- `mode` gates what renders: `local-lower-body` = legs + lower torso only; `local-third-person` and
  `remote` = full body.

### Speed-adaptive gait (`adaptGaitToSpeed`)

The four speed-varying gait fields (`pelvisHeightRatio`, `maxStepDistance`, `stepLift`,
`stepDuration`) can be driven from a single fitted **speed → gait model** instead of switching
between the discrete `LOCO_PROFILES.walk`/`.run` presets:

```js
export const GAIT_SPEED_MODEL;              // frozen fit coefficients
export function gaitForSpeed(speed, model = GAIT_SPEED_MODEL); // pure; clamped gait fields
```

`pelvis/stride/lift` are linear in speed; `stepDuration` is a power law (`A·v^B`) so cadence
tracks ~`1/speed` and never crosses zero when extrapolated fast. The coefficients were
least-squares fit over gait samples tuned across 0.5–7.7 m/s in `body-preview.html`'s
"Speed → gait model" panel (Add-sample refits; Copy-tuning exports `samples` + `fit`). When
`adaptGaitToSpeed:true`, `update()` overlays `gaitForSpeed(|velocity|)` onto `gait.cfg` every
frame; when false (the default, e.g. the preview's manual sliders) the caller owns `gait.cfg`.
The game (`environment-viewer.html`) creates its local body with `adaptGaitToSpeed:true`, so it
blends walk↔run continuously with no manual profile switch.

---

## Contract 3 — IK / gait core (copy, do not import)

The body **copies** a narrow subset out of `port-creature-system.js` — it must NOT import the
`Creature` class (its `physicsStep()` moves the creature from its feet and would fight the player
controller).

Reference implementations to copy from `port-creature-system.js`:
- `KinematicChain` (line ~654): `new KinematicChain(segments)` where `segments = [{ length, initDirection: THREE.Vector3 }]`; `solve(root, target, orientation) -> THREE.Vector3[]` (FABRIK; last point is the foot/hand). **Uses THREE.**
- `terrainNormal(x, z, out)` (line ~18): finite-difference normal from `terrainHeight`. **Uses THREE.**

**Headless-test split (required):** the biped **gait scheduler** (foot state: `current/target/rest/stepping/phase`, trigger-distance, alternation, look-ahead, step curve, settle-under-hips) must be pure array/number math with **no THREE import**, so `test-player-body-gait.mjs` can run under `node`. The THREE-dependent rig + `KinematicChain` rendering layer sits on top and is not unit-tested headlessly.

Gait defaults (from spec, tune later):
```js
{ stepDuration: 0.18, stepLift: 0.14, triggerDistance: 0.28,
  maxStepDistance: 0.75, lookAhead: 0.16, pelvisHeightRatio: 0.54, hipWidthRatio: 0.42 }
```

---

## Contract 4 — Weapon anchor sidecar (JSON)

New file: `weapon-anchors.json`. Sidecar (not inline in `weapons.js`) so the standalone editor can
read/write it. `weapons.js` loads/merges it at runtime; gameplay stays data-driven.

```json
{
  "m1911": {
    "ikAnchors": {
      "rightGrip":      { "p": [0.02, -0.04, -0.12], "q": [0, 0, 0, 1] },
      "leftGrip":       { "p": [-0.18, -0.03, -0.34], "q": [0, 0, 0, 1] },
      "magwell":        { "p": [0.01, -0.18, -0.18], "q": [0, 0, 0, 1] },
      "chargingHandle": { "p": [0.0, 0.07, -0.28], "q": [0, 0, 0, 1] },
      "muzzle":         { "p": [0, 0.02, -0.65], "q": [0, 0, 0, 1] }
    }
  },
  "m24": { "ikAnchors": { "...": "same keys" } }
}
```

- `p` = position in **weapon-local** space (meters). `q` = orientation quaternion `[x,y,z,w]`.
- Anchor keys are open-ended; `rightGrip`/`leftGrip`/`magwell`/`chargingHandle`/`muzzle` are the
  required baseline. Body-space anchors (e.g. `beltMagazine`) are resolved via the `body:` target form
  in Contract 5, not stored here.
- **Body-local axis convention** (`{body:[x,y,z]}` and `DEFAULT_BODY_ANCHORS`): resolved against
  `rootAnchor`, which faces `cameraYaw + PI`, so the frame is **+x = the body's LEFT, +y = up,
  +z = forward** (a hand reaching to its own left/front uses positive x and z). Authoring these with
  the "camera" convention (+x right, −z forward) mirrors the reach across and behind the torso — that
  was the m1911/m24 reload phasing bug. Weapon anchors above are unaffected (they resolve against the
  weapon root, not the body).

---

## Contract 5 — Weapon poses, sequences, and the pose controller

Pose + sequence data live with the weapon (in `weapons.js` or a `weapon-poses.json` sidecar — track A2
picks, but the **shapes** are frozen here).

**Weapon pose** (weapon root transform relative to camera/body):
```js
{ p: [x,y,z], r: [x,y,z] /* euler */, scale: 1.0 }   // e.g. lowReady, aimed, reloadRaise
```

**Sequence** (timed channels; visual-only reload v1):
```js
{
  duration: 1.45,
  commitAmmoAt: 1.05,     // informational in v1 (ammo still transfers via existing gun.reload)
  keys: [
    { t, weaponPose, right, left, event }   // right/left = target ref (below); event = prop hook
  ]
}
```

**Target ref resolver** (used by `right`/`left` in a key):
| Form | Meaning |
|---|---|
| `"rightGrip"` (string) | weapon anchor → transform by current weapon root |
| `"beltMagazine"` (string not in anchors) | body anchor → transform by body/camera root |
| `{ weaponAnchor, offset }` | anchor plus local offset |
| `{ body: [x,y,z] }` | body-local target |
| `{ camera: [x,y,z] }` | camera-local target (first-person viewmodel) |
| `{ world: [x,y,z] }` | absolute (debug) |

Body-space refs (`{ body: [...] }`, `"beltMagazine"`) are composed against `body.rootAnchor`, **not**
`body.group`. The procedural rig leaves `group` at the world origin (identity) and writes meshes in
absolute world space, so resolving body-space refs against `group` makes them land at fixed absolute-
world points that ignore player position and facing — the reload arm then reaches toward world origin
regardless of where/which way the player stands. `rootAnchor` is the chest-height, facing-yaw node the
controller must use; the controller falls back to `group` only if `rootAnchor` is absent.

**Pose controller** (new file `weapon-pose-controller.js`, visual only):
```js
createWeaponPoseController({ THREE, body, weaponView, getWeaponDef, onEvent, handGlideSpeed = 3.5, poseGlideSpeed = 4.0 }) -> {
  update(dt, state),   // state: { weaponId, action, actionTime, fireSeq, reloading, ammoMag, ammoReserve, aimAmount }
  play(actionName),    // 'idle'|'aim'|'fire'|'reload'|'swap'
  setWeapon(id),
  setAiming(amount),
  recoil(amount),
  getDebug(),
}
```
Each frame it computes: weapon-root pose, right-hand target, left-hand target, optional mag/bolt prop
transforms, recoil offsets — and pushes hand targets via `body.setArmTarget(...)` (Contract 1).

**Hand-target glide.** The `right`/`left` ref channels are carried-forward (a ref stays active until a
key changes it), so a resolved hand point *jumps* at each key. The controller does not push that jump
straight to the arm — it glides the driven target from the previous ref's point to the new one at
**constant speed** (`handGlideSpeed` m/s), so the duration of a transition is set by its distance, not a
fixed time: a long grip→belt reach takes proportionally longer than a short charging-handle nudge. Both
endpoints are re-resolved every frame, so a settled hand (progress ≥ 1) stays glued to its moving anchor
while the player walks/aims/recoils; only a genuine ref flip starts a glide. The progress math lives in
`advanceGlideProgress(p, dist, speed, dt)` in `weapon-sequence.js` (pure, THREE-free, unit-tested);
`handGlideSpeed: Infinity` reproduces the old instant-snap behavior (used by the anchor-position asserts
in `test-weapon-pose-controller.mjs`).

**Weapon-root pose chase.** The weapon-root pose is computed two different ways — the idle blend
`lerp(lowReady, aimed, aim)` when idle, or the sequence's interpolated pose when reloading — and these
are **not** cross-faded across the action boundary, so the gun used to pop one frame at reload start/end
(only visible when not aiming, since aiming makes both poses `aimed`). The controller now runs a
**continuous constant-speed chase** of the live `weaponView` pose toward whichever is current, via
`advancePoseChase(current, target, speed, dt)` in `weapon-sequence.js` (pure, THREE-free, unit-tested).
It holds no from/to or captured distance — it just steps toward the current target at `poseGlideSpeed`
m/s each frame — so it makes no begin/end assumption: the reload's start pose, end pose, and the idle it
returns to are three independent poses, and if aim changes mid-reload the exit target changes with it.
Chased on the **pre-recoil base pose** so the recoil kick stays snappy and never feeds back into the
chase; reset to a snap (`basePose = null`) on `setWeapon`. `poseGlideSpeed` is set high enough that the
already-smooth in-sequence pose motion isn't visibly lagged — only the boundary jumps get spread over a
few frames.

`environment-viewer.html` drives this controller from live input: `fireGunFromCamera()` calls
`play('fire')` on a successful shot, `reloadGun()` calls `play('reload')`, and right-mouse-button
hold (FPS mode only) eases a shared `localAimAmount` (0..1, in `environment-viewer.html`) into
`setAiming()` each frame — so the third-person body-held gun now kicks, reloads, and aims in sync
with the first-person gun logic. All calls are guarded on `lbWeaponMount?.ready` so they no-op
when there's no third-person mount (fps-legs/off body modes, or before the mount finishes loading).

The first-person viewmodel (`createLocalWeaponViewModel`, ~line 5104) reads the same shared
`localAimAmount` in its own `update(dt, { speed, aim })`: `applyToolTransform` lerps the hip
`viewOffset` toward a centered/raised/closer aimed offset and damps sway/bob while aiming.
`reload()` (wired from `reloadGun()`) captures `reloadSequence[currentTool]` (from its own
self-contained `weapon-poses.json` fetch, mirroring the `weapon-anchors.json` pattern) into
`activeReloadSeq` and counts `reloadT` down from that sequence's `duration`, falling back to a fixed
1.2s only for a weapon with no authored reload sequence. Capturing the sequence at `reload()` start
(rather than re-looking it up per frame by `currentTool`) keeps the duration and the curve atomic, so
a mid-reload weapon swap or a late `weapon-poses.json` fetch can't desync them; `loadTool()` also
clears `reloadT`/`activeReloadSeq` so switching weapons cancels the reload visual cleanly. While
reloading, `applyToolTransform` calls `reloadPoseDelta(seq, t)` (in `weapon-sequence.js`,
pure/THREE-free, alongside `advanceGlideProgress`/`advancePoseChase`) to get the weapon-root pose as
a delta from the sequence's OWN start pose — flush (zero) at both ends by construction, with no
dependency on an external `aimed` reference — and adds that delta on top of the group's
position/rotation, so the FP gun raises/tilts on the same authored curve and duration as the
third-person `weapon-pose-controller`, instead of a generic sine dip. The old sine-eased dip/tilt
(`reloadBump`) is kept only as the fallback path for weapons without a `reloadSequence` entry. Aim is still cancelled and recoil kick still suppressed
for the whole reload, same as before.

**First-person hands follow the reload too.** In addition to the weapon-root pose, `applyToolTransform`
resolves the reload sequence's `left`/`right` hand refs into **camera-local** points each frame
(`resolveReloadHandTargets`), using the same `resolveTargetRef` as the third-person controller but with
FP-space roots: weapon anchors compose against the just-positioned weapon `group` (both `group` and the
orb-hands are camera children, so no world round-trip); body-space refs (`{body:[...]}`, `beltMagazine`)
compose against `FP_BODY_ROOT` — a 180°-about-Y rotation (`[0,1,0,0]`) that maps the body frame
(+x=left/+z=forward) into camera space (+x=right/−z=forward), dropped slightly so belt/chest reaches read
as reaching down. Baked anchors omit `viewScale`, so `scaledAnchorsFor` pre-multiplies anchor positions by
it (exact for the viewScale=1 pistols, a small offset on the m24). The resolved targets are exposed via
`getReloadHandTargets()` and consumed by `createViewHands` (`player-hands.js`): its `update(dt, { …, reload })`
eases the orb-hands into sequence control (`reloadW`) and chases each hand to its target at constant speed
(`RELOAD_GLIDE_SPEED`, matching the controller's `handGlideSpeed`), so the FP hands do the same mag-pull
choreography as the third-person body. The animate loop runs `localWeaponView.update` **before**
`viewHands.update` so the weapon group is positioned (and targets resolved) first. There is still no
magazine prop — third-person emits reload events but wires no `onEvent`, so neither view renders a mag.

**Run/gun bob.** `applyToolTransform` also takes `{ running, moveX, moveZ }` (the animate loop passes the
run flag and world XZ velocity) and adds a run/gun bob on top of the aimed offset: a directional
side-to-side keyed off the strafe-relative move axis (`runBobAxis` in `view-feel.js`) plus vertical/depth/
roll terms and an eased "carry" lean that swings the gun across the chest while sprinting. Amplitudes come
from `feel.bobWalk`/`feel.bobRun` and are damped by aim and reload. The net camera-local bob translation is
stored in `viewBob` and exposed via `getViewBob()`; the orb-hands read it through `update(dt, { …, bob })`
and inherit it at `HAND_BOB_FOLLOW` so the hands ride with the gun instead of detaching. This is separate
from the reload hand targets above (bob applies to the idle/base pose; the reload blend sits on top). See
`infra.md` "First-person view feel" for the camera-side feel layers (shake/tilt/lean/look decoupling).

### Third-person weapon holds (per stance)

The body-held (third-person) weapon mount is stance-aware. Each weapon def in `weapons.js` carries a
hold offset **per stance** relative to the body's hold mount (weapon-root pose in body-facing space,
`{ position:[x,y,z], rotation:[x,y,z] euler, scale }`):

| Field | Stance | Notes |
|---|---|---|
| `thirdPersonHold` | stand | mount sits at head height; weapon rides at the shoulder |
| `crouchHold` | crouch | same mount space, dropped to crouched shoulder height (y ≈ −0.09) |
| `proneHold` | prone | dropped low + pushed forward so the gun sits at ground level in the outstretched hands |

The mount rig itself stays at terrain+1.5 in **every** stance (both in the preview and in the game) —
the per-stance holds carry the full vertical drop themselves. The game blends
stand→crouch→prone holds by the smoothed stance weights (crouch weight normalized by the 0.7 body
crouch target). The preview's body state (`height: 1.8`, `radius: 0.3`) and the game's
`fp.heightStand` / player capsule radius must stay equal so tuned holds read identically in both;
the game was raised to 1.8/0.3 to match the preview the holds were tuned in.

Tuned in `body-preview.html` — a Weapon selector (m1911/m24) loads the real GLB for each weapon
and the Stance selector swaps a separate slider set per weapon+stance (`WEAPON_HOLDS[weaponId][stance]`,
seeded from each weapon's `thirdPersonHold`/`crouchHold`/`proneHold`), and Copy-tuning exports the
active weapon's three stances under `weaponHolds`. Hold values (including
`scale`) are stored in the preview's mount space **verbatim**: the game's third-person mount
normalizes the GLB to the preview's 0.62 target (not `viewTargetSize`) so the hold scale, the
pose-controller's weaponPoses offsets, and the baked anchors all resolve identically to the
preview. Do not pre-compensate `scale` for `viewTargetSize` — `weaponAdjust.scale` multiplies the
pose/anchor offsets too, so compensating matches only the model's size while shrinking the
geometry the hands are solved against.

**Skinned weapon GLBs must be cloned with `SkeletonUtils.clone`, not `Object3D.clone(true)`.** Some
gun GLBs are exported as skinned meshes (e.g. `low-poly_m1911.glb` — a 15-joint armature with all
primitives weighted to it), while others are static (`low-poly_m24_sniper_rifle.glb`). Plain
`clone(true)` does not rebind a cloned `SkinnedMesh` to a cloned `Skeleton`, so a skinned weapon
collapses to invisible in-game — even though its geometry, materials, mount transform, and anchors
are all correct. Both clone sites in `environment-viewer.html` (the third-person mount
`buildLocalWeaponMount`, and the FPS viewmodel `createLocalWeaponViewModel`) use
`SkeletonUtils.clone` (imported as `skeletonClone`). `body-preview-v3.html` never hit this because it
adds the loaded model directly without cloning. The mount is also self-healing: a failed/bailed
`initLocalWeaponMount` releases its request marker and arms a throttled retry rather than leaving the
current weapon permanently unmounted. A Backquote-toggled debug HUD (default off) shows body mode,
mount/request state, weapon world position, and the pose controller's `getDebug()`.

---

## Global guardrails (all tracks)

- **Visual only**: IK/gait/pose never move the player, camera, or change hit-registration
  (`combat.js` ray/capsule against player capsules stays authoritative).
- **Do not import `Creature`** from `port-creature-system.js`; copy the narrow IK/gait subset.
- **Host authority unchanged**: no new server authority; MP v1 derives remote gait locally from
  interpolated positions — do NOT replicate feet/hands.
- **Backup convention**: snapshot `environment-viewer.html` / `multiplayer.js` into `versions/` before
  editing (see repo backup convention).
- On finishing a change: update the owning `docs/subsystems/*.md` and append an `agent_log.csv` row.
