# Body Preview V3: Mesh Skin And Imported Model Harness

Date: 2026-07-08
Subsystem: player visuals / preview tooling (`body-preview.html` v2 WIP baseline, later `player-procedural-body.js`)
Status: WIP design for the next preview iteration. Spec on top of body-preview v2; implement later.

## Goal

Define Body Preview v3 as a character-visual lab built on the existing Body Preview v2 WIP for two questions:

- Can the current procedural body drive a more continuous generated mesh "skin" over the mannequin parts?
- Can the current procedural body act as a kinematic skeleton for an imported GLB model?

The first implementation target will be `body-preview.html`, but this document is a spec pass. The
runtime body module stays unchanged until the preview proves which model is worth promoting.

## Background

The current body is not a `THREE.Skeleton`. It is a procedural follower rig made from separate meshes:
pelvis, waist, torso, neck, head, two arms, two legs, hands, feet, and joint marker meshes. Each frame
`body.update(dt, state)` solves the gait and IK, then writes world transforms into those visible parts.

The useful seam from the v2 preview baseline is:

```js
body.joints = {
  leftShoulder, leftElbow, leftWrist, leftHand,
  rightShoulder, rightElbow, rightWrist, rightHand,
  leftHip, leftKnee, leftAnkle, leftFoot,
  rightHip, rightKnee, rightAnkle, rightFoot,
  pelvis, waist, torso, neck, head,
}
```

Those are live mesh refs, already updated by the procedural rig. The preview can read their world
positions/quaternions after `body.update()` and draw alternate representations without touching player
movement, weapon IK, collision, networking, or the runtime body contract.

## Non-Goals

- Do not change `player-procedural-body.js` in the first pass.
- Do not replace the body contract or `setArmTarget`.
- Do not add collision or hit-registration changes.
- Do not require a fully auto-rigged arbitrary model importer.
- Do not assume imported GLBs can deform unless they already have compatible skinning or are mapped
  into preview-only driver bones.
- Do not make `body-preview.html` a production character customization UI.

## Preview V3 Modes

Add a visual-source mode in `body-preview.html`:

```js
visualMode: 'procedural' | 'generated-skin' | 'imported-rigid' | 'imported-skinned' | 'overlay'
```

Mode behavior:

- `procedural`: current v2 preview baseline. Existing body parts and joints are visible.
- `generated-skin`: hide or fade the mannequin parts and draw a generated shell driven by joints.
- `imported-rigid`: load a GLB and attach named sub-objects rigidly to procedural segments.
- `imported-skinned`: load a skinned GLB, create/drive preview bones from procedural joints, and bind
  the model if the skeleton can be mapped.
- `overlay`: show procedural rig, generated/imported skin, and joint markers together for debugging.

The UI should keep the current v2 stance, gait, weapon, joint-picking, and copy-tuning tools. V3 adds
skin/import controls next to them; it does not remove the v2 tuning workflow.

## Generated Skin Prototype

Generated skin is a preview-only wrapper mesh or mesh set that follows the procedural joints.

### V3A: Segment Shells

Start with a conservative shell made from connected segment geometry:

- Torso shell from pelvis -> waist -> torso -> neck.
- Head shell from neck -> head.
- Arm shells from shoulder -> elbow -> wrist -> hand.
- Leg shells from hip -> knee -> ankle -> foot.

Use the joint world positions as a stick frame and render tapered capsule/frustum tubes over each
chain. This is not one perfect watertight mesh yet, but it answers the first usability question:
whether a continuous-looking body reads better than separated mannequin parts during walk, crouch,
prone, aim, fire, and reload.

Controls:

- Skin enabled.
- Procedural rig opacity.
- Skin opacity.
- Limb radius scale.
- Torso radius scale.
- Joint blend radius.
- Wireframe/debug normals toggle.
- Material preset: neutral cloth, armor shell, skin matte.

Acceptance:

- The wrapper follows every stance already in the preview: stand, crouch, prone.
- It follows weapon-driven arm IK without hand lag.
- No wrapper segment flips or collapses when an elbow/knee is close to straight.
- The existing procedural body can still be shown underneath for diagnosis.

### V3B: Continuous Mesh Pass

If segment shells read well, build a more continuous generated mesh in the preview:

- Define cross-sections around key joints.
- Connect adjacent cross-sections into tubes.
- Add bridge patches across shoulders, hips, neck, and pelvis/torso.
- Rebuild or update vertex positions each frame from joint-space frames.

This can still be preview-only. It does not need GPU skinning in v3. The output is an authored
procedural surface driven by the same live joints.

Acceptance:

- Shoulders, hips, and neck look connected in common poses.
- Prone does not produce obvious torso tearing.
- The preview can toggle between segment shells and continuous mesh for comparison.

## Imported Model Prototype

There are two different import paths. The preview must keep them separate because they have different
requirements.

### Imported Rigid Parts

This path supports models that are already split into sub-objects, or a test GLB whose parts can be
named by convention.

Expected object names:

```txt
pelvis
torso
head
upper_arm_l
lower_arm_l
hand_l
upper_arm_r
lower_arm_r
hand_r
upper_leg_l
lower_leg_l
foot_l
upper_leg_r
lower_leg_r
foot_r
```

The preview computes a transform for each procedural segment:

- Segment position = midpoint between two mapped joints.
- Segment orientation = local +Y aligned from start joint to end joint.
- Segment scale = mapped length divided by bind/reference length.

This gives a fast path for armor plates, robot bodies, low-poly characters, and kitbashed models.
It does not deform a single continuous mesh.

Acceptance:

- A rigid test model can be loaded, normalized, and mapped without changing `player-procedural-body.js`.
- Missing parts fail softly and are listed in the preview log.
- Each part can be offset/rotated/scaled in a mapping table for fit tuning.

### Imported Skinned Model

This path supports GLBs with a real `SkinnedMesh` and humanoid-ish bones.

The current procedural body can drive such a model only through a retargeting layer:

1. Load GLB via `GLTFLoader`.
2. Discover `SkinnedMesh` objects and their skeletons.
3. Map imported bone names to procedural joint pairs.
4. Record bind-pose lengths and local offsets.
5. Each frame, drive preview bones from the procedural joints.
6. Let the imported `SkinnedMesh` deform normally through its own skin weights.

Initial bone-map shape:

```js
{
  hips: 'pelvis',
  spine: 'torso',
  neck: 'neck',
  head: 'head',
  leftUpperArm: ['leftShoulder', 'leftElbow'],
  leftLowerArm: ['leftElbow', 'leftWrist'],
  leftHand: 'leftHand',
  rightUpperArm: ['rightShoulder', 'rightElbow'],
  rightLowerArm: ['rightElbow', 'rightWrist'],
  rightHand: 'rightHand',
  leftUpperLeg: ['leftHip', 'leftKnee'],
  leftLowerLeg: ['leftKnee', 'leftAnkle'],
  leftFoot: 'leftFoot',
  rightUpperLeg: ['rightHip', 'rightKnee'],
  rightLowerLeg: ['rightKnee', 'rightAnkle'],
  rightFoot: 'rightFoot',
}
```

Important caveat: this is retargeting, not automatic rigging. If the imported mesh has bad skin
weights, unusual bone axes, extra twist bones, or non-humanoid proportions, the preview needs mapping
offsets. V3 should expose those issues clearly instead of hiding them.

Controls:

- Import GLB file/url.
- Show imported skeleton.
- Show procedural driver joints.
- Bone-map preset selector.
- Per-bone axis correction.
- Per-bone rest rotation offset.
- Uniform model scale.
- Ground offset.
- Reset mapping.

Acceptance:

- A compatible skinned GLB can be driven through walk, crouch, prone, aim, and reload in the preview.
- The preview logs unmapped bones and unmapped procedural joints.
- The model can be displayed over the procedural driver for side-by-side diagnosis.
- The preview does not mutate the loaded asset on disk.

## Data Model

Keep v3 mapping data inside `body-preview.html` at first, next to the existing v2 preview-only tuning
state. If it grows, move it to a sidecar JSON later.

Suggested shape:

```js
const BODY_PREVIEW_V3 = {
  visualMode: 'overlay',
  generatedSkin: {
    enabled: true,
    type: 'segment-shell',
    opacity: 0.82,
    limbRadiusScale: 1.12,
    torsoRadiusScale: 1.0,
    jointBlendRadius: 0.08,
    material: 'neutral-cloth',
    wireframe: false,
  },
  importModel: {
    source: null,
    mode: 'rigid-parts',
    scale: 1,
    groundOffset: 0,
    showSkeleton: true,
    showDriver: true,
    boneMapPreset: 'humanoid-basic',
    corrections: {},
  },
};
```

If/when this is promoted out of the preview, split it into:

- runtime style config for generated procedural skins.
- imported-model retarget presets.
- authoring-only debug metadata.

## Frame Order

In `body-preview.html`, update order should be:

1. Update movement and stance state.
2. Apply preview sliders to `body.gait`, `body.proneCfg`, `body.crouchCfg`, `body.eyeCfg`.
3. Call `body.update(dt, bodyState)`.
4. Update weapon mount.
5. Call weapon pose controller so arms chase grips.
6. Call `body.update(dt, bodyState)` again only if needed for post-controller hand targets.
7. Read `body.joints` world transforms.
8. Update generated skin or imported model drivers.
9. Render.

Current body-preview v2 updates the body before the controller pushes hand targets, so v3 should verify whether
the skin reads one frame behind the weapon hands. If it does, the preview can either run the body
solve after controller updates or explicitly document the one-frame delay before runtime changes.

## Implementation Phases

### Phase 1: Preview-Only Debug Overlay

- Add v3 panel section and `visualMode`.
- Add helpers to read world-space joint data from `body.joints`.
- Add driver skeleton helpers: points, segment lines, local frames.
- Add no runtime module changes.

### Phase 2: Generated Segment Skin

- Add procedural segment-shell meshes to `body-preview.html`.
- Update them from joint pairs after each body solve.
- Add opacity/material/wireframe controls.
- Add overlay mode to compare with mannequin parts.

### Phase 3: Imported Rigid Parts

- Add GLB import/load path in the preview.
- Normalize the imported root.
- Map named rigid child meshes to procedural segments.
- Add missing-name diagnostics.

### Phase 4: Imported Skinned Retarget Spike

- Detect `SkinnedMesh` and skeletons.
- Add a basic humanoid bone-map preset.
- Drive mapped bones from procedural joints with axis corrections.
- Add skeleton/debug overlays.

### Phase 5: Promote Only The Proven Path

After the preview answers which path works:

- Promote generated skin support into `player-procedural-body.js` only if it is stable and cheap.
- Promote imported-model retargeting only if a real asset can be made to work without brittle per-frame hacks.
- Update `docs/subsystems/procedural-body-weapon-contracts.md` before changing the runtime contract.

## Acceptance Criteria For Body Preview V3

- Existing body-preview v2 controls still work: gait, stance, weapon, fire, reload, joint pole tuning, copy tuning.
- Generated skin can be toggled without changing body movement or weapon logic.
- Imported rigid part model can be mapped with clear diagnostics.
- Imported skinned model spike either works on a compatible test GLB or reports exactly why it cannot.
- Overlay mode makes the procedural driver, generated/imported visual, and joint markers inspectable.
- No changes are required outside `body-preview.html` for Phases 1-4, except optional sidecar test assets.

## Open Questions

- Should preview v3 use an imported test humanoid from `claudecraft-assets/models/chars/players/` or a tiny purpose-built local test GLB?
- Should the generated skin be one mesh for clean material control or multiple segment meshes for easier debugging?
- Should the body solve be reordered so weapon hand targets are reflected in the same frame before skin/import drivers read joints?
- Do we want copy-tuning to include generated-skin/import-retarget settings, or keep those as separate logs?
- If imported skinned retargeting works, is the runtime goal to drive real `THREE.Bone`s directly, or to keep the procedural mannequin as the canonical driver and attach imported visuals as a child layer?
