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
  design,                 // optional appearance spec overriding BODY_DESIGN_DEFAULTS (see below)
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
    setPartMask(mask),    // { head, eyes, neck, torso, pelvis, waist: bool } over parts.core; first-person owners hide what clips the camera
    setTint(hsl),
    destroy(),
    gait,      // live gait scheduler; tune gait.cfg (read-mostly)
    proneCfg,  // live prone-pose tuning (hipHeight, pitch, torsoFwd, footBack, …)
    crouchCfg, // live crouch-pose tuning (pelvisDrop, torsoDrop, headDrop, shoulderDrop, lean, fwd)
    armCfg,    // live free-arm pose model (ARM_POSE_PRESETS / armPoseFromPreset): per-gait idle/walk/run
               // {raise, bend, spread, swing, pump} blended by horizontal speed (walkSpeed, runSpeedLo/Hi),
               // plus jumpLift/jumpSpread/landSwing on the air weight. The hand target is built from an
               // articulated upper-arm + forearm (armPoseHandLocal) so swing happens at the shoulder.
               // armCfg.enabled=false restores the old fixed idle vector. setArmPreset(name) copies a preset.
    jumpCfg,   // live jump/fall tuning: airW blends 0..1 (riseRate/fallRate) instead of a boolean; the
               // tuck is shaped by vertical velocity (tuckRise/tuckFall/vyScale/footForward); landing
               // drops the pelvis by impact speed (absorbDrop/absorbMax/absorbRecover), holds both
               // re-planted feet (landHold) and swings the idle arms (armRaise/armLand). In the air the
               // pelvis follows the capsule (state.position.y) rather than ground + lift, so falls track.
               // Needs state.velocity.y (or a changing position.y) and state.onFloor.
               // Floor loss shorter than airGrace (0.12 s) with no upward launch (launchVy) is NOT a
               // jump: capsule controllers drop onFloor for a frame on slopes and steps, and treating
               // that as a landing froze the feet and lifted the legs (stutter-step / hover). The
               // landing foot hold only applies below holdSpeed; a moving body keeps stepping.
    ikCfg,     // live elbow/knee pole-rotation tuning, VISUAL side naming (leftArmPole, leftArmPoleProne, leftLegPole, leftLegPoleProne, right…)
    // Arm IK is additionally torso-aware: a vertical capsule around the spine forces the elbow pole
    // outward (no backward bend) and re-solves once if the elbow lands inside the torso (no phasing).
    // See docs/subsystems/creature.md; tunables TORSO_CAPSULE_RADIUS_MARGIN / TORSO_CAPSULE_Y_PAD.
    joints,    // { leftShoulder..leftHand, rightShoulder..rightHand, leftHip..leftFoot, rightHip..rightFoot, pelvis, waist, torso, neck, head } mesh refs, VISUAL side naming, for picking
  };
}
```

### Design spec (`design` option, exported `BODY_DESIGN_DEFAULTS`)

Every previously-hardcoded geometry number is now a field of `BODY_DESIGN_DEFAULTS`; the `design`
option shallow-merges over it (nested `waist`/`neck` objects merge one level deep), so omitting it
renders the identical body. Fields: limb ratios (`legLenRatio`, `thighFrac`, `shinFrac`,
`armLenRatio`, `upperArmFrac`, `forearmFrac`, `limbThicknessRatio`, `armThickScale`), lathe
profiles as `[r, y]` pairs in R/H units (`pelvisProfile`, `torsoProfile`, `headProfile`;
`handProfile` in limbThickness units) with matching `*Radial`/`*ZScale`, `waist`/`neck` cylinder
specs, joint-sphere multiples (`hipJoint` … `wristJoint`), `footScale`, an optional `eye` partial
override of `eyeCfg` (meters), and `gear`.

Shape options beyond the legacy blobs: `footShape: 'boot'` extrudes `footProfile` (a side profile,
heel −1 → toe +1) across the width and normalizes it so x/z span [−1,1] with the sole at y=0, so
`footScale` keeps its old meaning; `handShape: 'glove'` extrudes `handOutline` (palm + thumb) with
`handPalmFacing` choosing whether the palm normal is 'z' or 'x' (inward, natural at rest) and
`handFingerAxis` flipping it end-for-end. `limbProfile` replaces the built-in mannequin taper with
`[rMul, yFrac]` pairs.

**Tessellation has two independent axes.** `*Radial` counts only smooth a lathe HORIZONTALLY;
its vertical silhouette is a linear interpolation of the control points, so a 6-point profile
renders as 5 flat bands however high the radial count. `profileSmooth: N` resamples every lathe
profile through a spline to N points, and `outlineSmooth` does the same for extruded outlines.

`roles` overrides the material role of any core part (`pelvis`, `waist`, `torso`, `neck`, `head`,
`limb`, `joint`, `foot`, `hand`, `eye`); defaults reproduce the legacy assignment. Available roles
are `shell`/`plate`/`trim`/`accent` (team-tinted per instance) and
`eye`/`metal`/`rubber`/`fabric`/`visor` (untinted — they carry their own colour, so they read as
materials rather than team colour).

The human face (`bot-face.js`) adds five more: `skin` and `hair` are per-instance tinted from
`style.skin`/`style.hair`, and `sclera`/`pupil`/`mouth` are untinted. Skin and hair take the
instance colour but are NOT in `tintMaterials` and are skipped by `setTint()`, so a squad varies in
skin tone without a team recolour repainting anyone's face. Their emissive is held to ~15% of the
armour's (`glowScale`/`rimScale` on `botRoleMaterial`): at full gain the face self-illuminates in
its own colour, brows, mouth and sockets all wash to one value, and the head reads as a blank mask.
That is rule 5 — material defeating silhouette — and no amount of reshaping fixes it.

`visor` is dark tinted glass: a low base value with a fresnel sheen (`visorColor`/`visorGain`
uniforms in `bot-viewer-visuals.js`), deliberately DARKER than the surrounding shell. Use it for
visors rather than `eye`. `eye` is a flat unlit fill, and a light-valued uniform rectangle over a
face reads as a bandage or censor bar no matter what silhouette it is given — that failure is a
property of the material, not of the outline, so reshaping cannot fix it. The sheen is not gated on
the `botGlow` toggle, so glass stays legible with neon effects off.
Adding a role means touching three files in step: `player-procedural-body.js` (`DEFAULT_STYLE`,
`_roleColor`, the material block), `body-part-batches.js` (`roleMaterials`), and
`bot-viewer-visuals.js` (`botMaterials`).

### Role-specific bodies

`bot-body-design.js` exports `botDesignForRole(roleId, ...extraAddons)` alongside the older
`botDesignWith(...addons)`. `BOT_ROLE_DESIGNS` maps a role id from `bot-roles.js` to
`{ helmet?, addons? }`:

| role | pack | distinguishing kit |
|---|---|---|
| `rifleman` | large ruck | bedroll, side straps |
| `medic` | small | cross-marked hip pouches, crosses on pack/shoulder/both hips |
| `technical` | medium | twin missile tubes on a back rack |
| `sniper` | small | `HELMET_MARKSMAN` — slit visor, monocular optic, rangefinder stalk |

Unknown role ids fall back to the plain base design rather than throwing, so a role added to
`bot-roles.js` with no art yet still renders.

### Body kind: armoured mech or human soldier

A third axis on top of role and helmet. `bot-body-design.js` exports `BOT_BODY_KINDS`
(`['armoured', 'soldier']`), `getBotBodyKind()` and `setBotBodyKind(kind)`, and `botDesignForRole()`
branches on the current kind.

**It belongs behind `botDesignForRole` and nowhere else.** Both viewers already reach the art
through exactly that one function — `bot-viewer-v2.html` at its `createBotProceduralBody`, and
`environment-viewer-v2.html` via `GhostRenderer`'s `getDesign` hook. Putting the switch there makes
the two agree by construction; putting it in the viewers reintroduces the drift the `getDesign` hook
was added to fix.

`setBotBodyKind` **returns true only when the kind actually changed**, and that return value is the
contract: a procedural body reads its design ONCE at construction, so live bots keep the old body
until their rig is destroyed and remade. Callers use the return value to decide whether to pay for
that rebuild — `GhostRenderer.rebuildBotBodies()` in the environment viewer,
`rebuildBotProceduralBodies()` in bot-viewer-v2.

The design cache is keyed by `kind|role`, and is **not cleared on a switch**: both kinds' designs
coexist, so toggling back is free. Clearing it would discard the descriptor objects that are still
the keys into the rig's geometry cache, making every toggle re-upload buffers it already had.

`SOLDIER_ROLE_DESIGNS` is the soldier-side equivalent of `BOT_ROLE_DESIGNS`:

| role | pack | head kit | marker | face |
|---|---|---|---|---|
| `rifleman` | yes | helmet | — | determined |
| `medic` | yes | helmet | carrier + pack crosses | neutral |
| `technical` | yes | helmet, mask | launcher tubes | angry, shaved |
| `sniper` | **no** | helmet, sunglasses | — | neutral, shaved |
| `squadleader` | yes | helmet, sunglasses | radio mast | shout |

Two constraints that are easy to get wrong:

- **Every role marker is placed against a PACK surface**, so a marker on a packless role hangs in
  free air. The build guards on `spec.pack` rather than trusting the table, and the test asserts it.
  The medic's carrier crosses are the exception — they sit on the carrier and the cummerbund, so
  they survive without a pack.
- **A soldier is almost entirely UNTINTED, so it needs a deliberate team marker.** The uniform,
  hands and face are per-BODY roles (`cloth`/`skin`), the carrier and boots are untinted (`rubber`),
  and a role histogram of the finished rifleman finds `shell` and `trim` used ZERO times against 46
  `rubber` pieces. Team would have come down to the three `plate` pieces on the helmet.
  `SOLDIER_TEAM_BRASSARD` is therefore unconditional on every role: a band around each carrier strap
  at its crest, in `trim` — the vivid team role AND the one `botBodyStyle` in `multiplayer.js`
  actually sets. `accent` is NOT set there, so the carrier's name tape is the same colour on both
  teams in the environment viewer and is not a substitute.
- **Face varies by ROLE, not by bot.** Every bot of a role shares one design object so the geometry
  cache resolves N bots to one set of buffers; a per-bot face multiplies that by the squad size.
  Expression and hair are the levers because they are geometry. **Skin tone is not** — `SKIN_TONES`
  feeds the `skin` material role, which is a per-body palette colour set through the `style` object
  the viewers pass to `createProceduralPlayerBody`, and a design cannot reach it. Varying skin per
  bot means touching `botBodyStyle` in `multiplayer.js` and the style block in `bot-viewer-v2.html`.

`extraAddons` (the `BOT_DESIGN_ADDONS` names) are **armoured-only** and the soldier path ignores
them: they are authored against the mech's 500 × 360 mm chest block. No caller passes them today.
The human-scale replacements live in `bot-human-body.js` as `SOLDIER_MEDIC_MARKS`,
`SOLDIER_PACK_CROSS`, `SOLDIER_ANTENNA` and `SOLDIER_TUBES`.

### Body and head as independent axes (`bot-body-versions.js`)

`composeBot(bodyKey, headKey, headOpts)` crosses a body version with a head. It works because head
gear is exactly the set of `anchor: 'head'` pieces, so a head is separable from any body by
construction — `headOf(design)` and `bodyOf(design)` are that split.

`BOT_BODIES` is the design's history, oldest first: the bare rig (`BODY_DESIGN_DEFAULTS`, no gear),
four frozen snapshots in `bot-bodies/`, then the live `BOT_BODY_DESIGN`. The snapshots were copied
out of `versions/` on purpose — `versions/` is a manual undo history and must not become an import
path. `BOT_HEAD_KEYS` is `as authored` plus `human` plus every `BOT_HELMETS` key, and `BOT_KITS` is
`none` plus every `BOT_DESIGN_ADDONS` name — the packs and role markers, as a third axis. Kits are
raw add-ons rather than role ids on purpose: a role like `medic` is itself a combination
(`packSmall` + `medicKit`), and pre-baking combinations is what this layer exists to avoid. Pass
several to `composeBot` to layer them.

Two things this has to get right, both covered by `test-bot-body-versions.mjs`:

- **The skull travels with the head, not the body.** `headProfile`/`headRadial`/`headZScale`/`eye`
  are top-level design fields rather than gear, so a swap that moved only the gear would leave the
  human face hanging on a 0.086 m armoured skull. A helmet brings the current design's skull; the
  human head brings its own; `as authored` keeps the body's.
- **`as authored` is an identity, not a rebuild.** It returns the stored design object itself. If it
  recomposed from parts it could drift, and the whole point of the frozen list is that the old
  versions are trustworthy references.

### Clothed human body (`bot-human-body.js`)

`HUMAN_BODY_DESIGN` is the unarmoured body, registered as the `human` branch of `BOT_BODIES`. It is
HEADLESS on purpose — no `headProfile` — so it must be paired with a head from the head axis.

The rig gained **per-limb profiles**: `thighProfile`, `shinProfile`, `upperArmProfile`,
`forearmProfile`, each falling back to `limbProfile`. One profile shared by all four limbs is what
made the old rig read as segmented tubing — a thigh and a calf taper in OPPOSITE directions along
the bone (yFrac -0.5 is proximal, +0.5 distal), and no symmetric spindle can be both. No geometry
cache change was needed: `makeLatheGeometry` keys on the resolved points.

Also new: the `cloth` material role — per-body tinted like `skin`, but matte and with its glow held
to 8% of the armour's. As team-tinted `shell` a pale uniform blew out to a flat glowing surface, and
a blown-out surface has no shading, so the limb profiles underneath were invisible whatever they
were.

**THE CHEST HAS TO REACH THE SHOULDERS.** Arm roots attach at `state.radius * 0.66` — the CAPSULE
radius, not the rig's `R` — so a design cannot see where its own arms will hang. At a 144 mm chest
against a 198 mm attachment the arms floated 55 mm clear of the torso on each side and the shoulder
spheres read as pads stuck on a narrow body. The same split means torso width and arm/leg attachment
width must be changed together; scaling one alone puts the limbs inside the chest.

**THE CHEST HAS TO REACH THE SHOULDERS.** Arm roots attach at `state.radius * 0.66` — the CAPSULE
radius, not the rig's `R` — so a design cannot see where its own arms will hang. At a 144 mm chest
against a 198 mm attachment the arms floated 55 mm clear of the torso on each side and the shoulder
spheres read as pads stuck on a narrow body.

**HEAD KIT** lives in `bot-face.js`: `SOLDIER_HELMET`, `SUNGLASSES`, `FACE_MASK` and
`withHeadKit(design, { helmet, glasses, mask })`, with the three independent so all eight
combinations are reachable. `helmetRadius(y)` / `helmetSurfaceZ(x, y)` are exported alongside the
skull's equivalents, because every fitting on the shell (rails, NVG shroud, rear pouch) has to clear
the HELMET, not the head.

Three things fell out of measuring rather than guessing:

- **The shell is `type: 'dome'`, not `lathe`, and that is the whole design.** A lathe's rim is a
  LEVEL RING — one radius per height, nothing varies with angle — so the bottom edge is the same
  height at the front, the back and both sides. A combat helmet's silhouette is precisely the
  opposite, and building it from a lathe forced two workarounds that are now gone: a `helmetSkirt`
  rbox bolted on the back to fake the nape, and a `helmetBrim` torus to cap the open rim. The
  result read as two objects stuck together, which is what it was. `dome` (see `gearGeometry` in
  `player-procedural-body.js`) is the same surface of revolution cut at a PER-AZIMUTH height, plus
  a `wall` that gives it an inner face and a real edge band.
- **The rim table IS the silhouette.** `HELMET_RIM_HALF` is authored over half a turn and mirrored
  (`turn -> 1 - turn`), because a helmet whose left and right cuts differ reads as damaged. Three
  facts about it were each found by rendering, not by reasoning:
  - It is a STAIRCASE of three level runs — front over the brow (48 mm), a shelf over the ear
    (35 mm), and the nape (−26 mm) — not a curve. 84.7% of the descent lands in 6 of the 40 radial
    segments; spreading it evenly averages the steps into one smooth arc.
  - The rear run must span BOTH sides of dead-centre at one height. A single lowest sample at turn
    0.5 mirrors into a downward point, which reads as a V cut into the nape.
  - The front run is level, not scalloped. An earlier version had the edge RISING over the ear on
    the theory that "high cut" means a notch there; it made the shell read as a bowl perched on the
    head.
- **Thicken a shell OUTWARD.** Going from a 7 mm to a 15 mm wall, every profile radius went up by
  the same 8 mm, so `inner = outer - wall` is unchanged and the 5.4-11.9 mm of pad space between
  shell and skull is untouched. Thickening inward would have eaten it.
- **A helmet is longer front-to-back than the head.** Its z-stretch is 1.12, separate from the
  head's 1.10. Matching the head's stretch is most of what made the first version read as a bicycle
  helmet; the original 1.20 overshot and stood the shell too far off the brow.
- **Straps are GENERATED on the skull, never typed.** A strap is the one piece that cannot be a box
  between two plausible points: the skull's radius changes with height and its cross-section is an
  ellipse, so any straight bar stands off in the middle and buries its ends. `strapOnHead()` takes
  `[turn, y]` path samples, projects each onto `skullRadius`/`HEAD_Z_SCALE`, and orients every
  segment from the SURFACE NORMAL at its midpoint (taken from the two surface tangents, not the
  radial direction — near the jaw the radius changes fast enough that a radial normal tips the
  webbing off the face). Measured standoff along the whole run is 1.5-5.9 mm with nothing sunk into
  the head. `headPoint`/`headNormal`/`helmetRimY`/`helmetEdgePoint` are exported for this.
- **Anything spanning the skull and the shell has to be COMPUTED between them.** The webbing runs on
  the skull; the shell's rear edge is ~21 mm further out and 6 mm higher. `strapAnchor` is built
  from `headPoint()` to `helmetEdgePoint()` at the rear leg's own start azimuth, so it stays joined
  if either the rim table or the strap path is retuned. Placed by hand it would silently detach the
  next time the rim moved.
- **A flat lens cannot wrap.** At the eye (x 0.036) the skull front is 92 mm; at the temple (x 0.074)
  it is 58 mm. Any single slab wide enough to cover both eyes stands ~46 mm off the temples and reads
  as a welding visor. Two plates rotated 0.6 rad about Y land 14 mm and 9 mm proud instead.
- **`visor` is theme-driven and came out amber.** Its colour and gain are uniforms `applyBots()`
  rewrites every frame, so sunglasses built from it were shooting glasses on one theme and something
  else on the next. Fixed dark kit wants `pupil`.
- **A CHAIN has to be placed from ENDPOINTS, not positions.** The boom mic is five pieces
  (`helmetBoomBoss` → `helmetBoom` → `helmetBoomJoint` → `helmetBoom2` → `helmetBoomTip`) and the
  first version had both ends floating: the rod ran from (−114, −56, 1) to (−66, −16, 91) mm, so it
  started 13 mm outside the cup rim and ended 54 mm above the tip sphere sitting at y −70. Nothing
  in the descriptors looked wrong, because a cylinder's `position` is its CENTRE and its axis is
  local +Y AFTER `rotation` — neither end appears in the source at all. For Euler order XYZ with the
  middle angle 0, local +Y is `(−sin z, cos x·cos z, sin x·cos z)`, so a link along unit `d` is
  `z = −asin(dx)`, `x = atan2(dz, dy)`. `test-bot-face.mjs` now recomputes every link's endpoints
  from its own descriptor and measures the gap to the previous link, which is the only kind of test
  that catches this — each piece can sit in a legal place and the assembly still be in five parts.

**KIT IS OPTIONAL GEAR LISTS**, not part of the body. `bot-human-body.js` exports `SOLDIER_PADS` /
`withPads(design)`, `PLATE_CARRIER` / `withCarrier(design)` and `SOLDIER_PACK` / `withPack(design)`,
so a squad can be mixed. They compose: `withPack(withCarrier(withPads(body)))`.

The pack is HUMAN-SCALE and separate from the mech's `BOT_DESIGN_ADDONS.packLarge` family, which
is authored against a 0.360 m-deep armoured chest and reaches z=-0.490 — on a 127 mm-deep human
torso those hang 363 mm off the back. It sits on the CARRIER's rear panel rather than on the body,
which is how a pack is actually worn over armour, and carries no shoulder straps of its own since
the carrier's already cross the trapezius and a second pair reads as a harness. The carrier
needs no `faceBody` machinery — the torso has a stable front and back, unlike a joint. Its MOLLE
rows are what make it read as a modern carrier rather than a plain slab of armour, and the name-tape
patch is `accent` (the vivid team-tinted role), which puts team identification on a soldier's chest
for free: the piece has to exist anyway.

**`faceBody: true` ON GEAR** puts a piece on a second anchor whose roll is locked to the body's
forward: `orientFaceAnchors` re-rolls it every frame with Gram-Schmidt (+Y down the bone, +Z as
close to body-forward as that allows, falling back to the body's right when the bone is parallel to
forward). It exists because rule 3 — limb-joint frames carry an arbitrary roll — was forcing bad
SHAPES, not just awkward placement. Joint gear had to be symmetric about the bone, so knee pads came
out as 360-degree wraps, and a uniform tube is the silhouette of a compression brace, not a shell.
The roll is now chosen rather than inherited, so a plate can sit on the FRONT of a knee and stay
there. Joints only; everything else already has a stable frame. Note the underlying instability is
real: `setFromUnitVectors(up, boneDir)` is a ~180-degree arc for a straight-down leg, where the axis
is degenerate and the roll can flip.

**THE PELVIS HAS TO BE IN THE SAME LEAGUE AS THE LEGS.** The thighs hang `radius*2*hipWidthRatio`
= 252 mm apart and are 154 mm across, so they span 407 mm. Against a 224 mm pelvis that is 1.82x
narrower than the legs beneath it, which reads as a pinch no amount of belt or hem work hides. Same
class of error as the chest-vs-shoulders one: the attachment span comes from `state.radius`, which
the design cannot see, so torso, pelvis and waist widths have to be checked AGAINST it rather than
authored on their own. Chest:waist should land near 1.3; at 1.67 it is a comic-book V, not a soldier.
The belt clears the WAIST, not the hip — on a real figure the hips are wider than the belt.

**GEAR POSITIONS ARE ABSOLUTE METRES ALONG A BONE, so they break silently when a length ratio
changes.** Shortening the arms to canon left the sleeve cuff 37 mm PAST the wrist — a black band on
the back of the hand — and re-lengthening the legs left all three boot pieces floating 70-150 mm up
the shin. Nothing in the descriptors looked wrong; the bones moved underneath them. `bot-human-body.js`
now names the ratios as constants and DERIVES the cuff positions (`WRIST`, `ANKLE`, `BOOT_TOP`) from
them, so a ratio change moves the cuffs with it.

**`handWristBias`** is new, and is the hand's equivalent of `footForwardBias`. The glove outline is
centred on the wrist, so half the hand sat back along the forearm — a hand growing THROUGH the joint
rather than off it, which is why a sleeve cuff kept landing on it however far up the arm it moved.
Defaults to 0, so existing callers are unchanged.

**`legLenRatio` IS CONSTRAINED, NOT CHOSEN.** The pelvis is placed at `gait.pelvisHeightRatio * H`
(0.58 x 1.8 = 1.044 m) regardless of what a design says, so the leg chain has to be LONGER than that
with bend room. Too short and the legs run dead straight and over-extend with the feet unable to
reach; too long and the knees sit in a permanent squat. Both shipped here: an anthropometric 0.53
left 90 mm of over-extension, and a later 1.233x scale pushed it to 0.653 for 132 mm of slack and a
visible crouch. The rig default 0.62 leaves ~72 mm of bend and is the value to hold near.
Consequence: **leg length cannot be used to make a body taller** — longer bones only bend the knees.
`test-bot-body-versions.mjs` now checks this for every registered body.

Proportions are measured against human canon as fractions of the figure's real standing height,
not eyeballed. What that caught: the arms were 22% too long (forearm 33%, the segment a viewer
measures against the torso, and the specific thing that reads as ape arms) while the legs were
already correct, and the neck — lengthened to cure an earlier bobblehead — had overshot to 40% over
canon, which is most of why the upper body read as short even though the torso itself measured
right. All four limb segments and every landmark now land within 2%.

**`torsoYRatio` / `neckYRatio` / `headYRatio`** were hardcoded literals (0.22 / 0.37 / 0.48) inside
`update()`. That meant `neck.h` sized the neck MESH without moving the head, so shortening a neck
opened a gap rather than lowering the head onto the shoulders. They are design fields now, defaulted
to the former literals so every existing caller renders identically.

**Findings from four adversarial critique rounds**, each of which shipped a wrong read first:

- **Trousers are not legs.** Fabric drapes rather than wraps: it never narrows as hard, it bunches
  at joints instead of thinning into them, and at the bottom it blouses over the boot instead of
  tapering to an ankle. A bare-leg profile under a uniform reads as a wetsuit.
- **A joint sphere wider than its limb erases the profile.** The knee ball measured 116 mm against a
  112 mm calf, so it bridged thigh to shin and flattened both into one cone — the critique came back
  "a cone" and was right about the silhouette even though the numbers varied. Same failure at the
  shoulder (105 mm ball, 98 mm sleeve).
- **Below ~25%, a profile change is invisible.** The first calf varied 13% and the first blouse 6%;
  neither registered at all. Both are now large steps.
- **A garment is legible at its boundaries, and none are expressible in a surface of revolution.**
  Belt, buckle, shirt hem, collar, sleeve cuffs, boot cuff and boot mouth all exist as separate
  primitives for that reason.
- **An edge is a VALUE break, not a bump.** Collar and cuffs authored in the same material as the
  shirt were geometrically present and visually absent.
- **A hip that out-measures its belt reads as a nappy**, and a pelvis lathe that keeps descending
  BETWEEN the legs fills the fork and fuses the hips into one wedge. The fix was length, not width.
- **A bulge next to a joint reads as the joint.** The forearm sleeve peaked just below the elbow and
  that swell — not the sphere, which sat well inside — was the "bead poking out mid-arm".
- **A boot is a SHAFT plus a FOOT**, and one extruded outline cannot be both: levelling the collar to
  close a gap at the instep turned the rear two thirds into a full-height block and it read as a ski
  boot. The shaft is a separate cylinder.
- **Measure where a part actually ENDS before placing anything against it.** Every trouser and cuff
  piece was authored from the shin length and landed 80-140 mm inside the boot shell; what showed
  through was a "bracelet" ring and a lumpy heel. Note also that knee-anchor +Y runs DOWN the shin,
  so a larger y is LOWER — chasing the gap by increasing it buried the cuff again.
- **A light team-tinted role on dark hardware reads as a hole punched in it**, and would give a red
  team red boot soles. The boot sole separates from the upper by its STEP, in the same black.

### Human head (`bot-face.js`)

`withHumanHead(design, { expression, hair, ears })` swaps a design's head for a human one, and
`withHelmet(design, BOT_HELMETS[name])` swaps back; `botDesignHuman(opts)` is the base design
wearing it. **Not wired into the game** — the shipped bots still wear the Mark VII. Iterate in the
studio's Head section, then flip `BOT_ROLE_DESIGNS` when it is ready.

Both swaps work by dropping every `anchor: 'head'` piece, so body and pack gear survive untouched.
The swap also carries the SKULL, not just the gear on it: the human head replaces `headProfile`,
`headRadial`, `headZScale` and `roles.head`, so `withHelmet` has to restore the armoured versions
or the Mark VII ends up sized for a human head. `BOT_HELMETS` includes the three head pieces the
layering pass adds outside `HELMET_MARK_VII`, or a round trip silently loses them.

Expression is authored, not animated. `FACE_EXPRESSIONS` holds eight presets over six numbers
(`brow`, `browTilt`, `lid`, `mouthCurve`, `mouthOpen`, `mouthWidth`) that generate the brow, lid and
mouth outlines. Each distinct expression mints its own geometry and every geometry costs an
InstancedMesh bucket that is never evicted, so a bot picks an expression when it is built — a
per-frame expression would be unbounded.

`headSurfaceZ(x, y)` is the number every face piece is placed against. Because the skull lathe is
squashed by `headZScale` and the gear anchor undoes that squash, the surface a feature has to clear
is an ELLIPSE, not the lathe radius — `test-bot-face.mjs` checks every forward feature against it,
which is what caught the eyes and mouth sinking into the skull after the jaw was widened.

Four things that read wrong before they read right, all rule 4:

- **A lid bar above an open eye is a second eyebrow.** To occlude the eyeball a lid must sit proud
  of it, and a proud skin bar over an open eye reads as a brow. The lid is now emitted only at
  `lid >= LID_MIN` (0.30); below that the brow carries the expression alone.
- **A constant-section nose is a nose clip.** A box bridge with a ball on the end cannot start flush
  inside the brow and grow forward as it descends. The nose is one `axis: 'x'` extrusion — an actual
  side profile — with its root buried behind the skull surface.
- **Two small round shapes beside a nose are nostril beads.** The nose base is one rbox, not a
  mirrored pair of wings.
- **A constant-thickness mouth outline splines into a bow tie.** Thickness has to taper to the
  corners, or the spline overshoots the end points and fattens both ends.

Role helmets swap only `MARK_VII_FACE` (socket + glass), keeping the shared skull, crown, jaw and
side plates — the roles must read as one army, so only the face may differ. Two traps:

- **Medical crosses use untinted `eye`-on-`rubber`, never `accent`.** `accent` is team-tinted, so a
  cross drawn with it turns green on one team and red on the other — that is livery, not a medical
  marking.
- **Packs must be wider than the 0.420 chest plate.** A pack narrower than the backplate framing it
  reads as a panel inset into the armour rather than a ruck worn over it. This is rule 1 applied to
  gear-over-gear, not just gear-over-chassis.

`gear` is a list of accessory descriptors parented to a core part through an inverse-scale anchor
node, so gear is authored in true part-local meters: `{ anchor, type, role, position, rotation,
scale, size, profile, outline, depth, axis, bevel, radial, seg, rim, wall }`. Types are
`lathe|dome|box|sphere|cylinder|capsule|torus|cone|extrude` — `extrude` runs an `outline` through
the same extruder the boot and glove use (with `axis: 'x'` turning the outline's X into +Z), which
is how detail follows a silhouette instead of being a box.

`dome` is a lathe whose bottom edge VARIES WITH AZIMUTH: same `[r, y]` `profile`, plus a cyclic
`rim` table of `[turn, y]` samples (turn 0 = +Z, 0.25 = +X, matching `LatheGeometry`'s phi origin so
a profile moves between the two types unchanged) and a `wall` thickness that generates an inner
surface and a rim band. Use it for anything whose trim line is the point — a helmet's edge cannot be
a level ring, and faking one with a second part bolted on reads as two objects. Note `extrude` is
NOT the alternative: `ExtrudeGeometry` has a constant cross-section, so `axis: 'x'` gives a prism
with flat slab sides. Adding a new field here means adding it to the cache key too, or two pieces
differing only by that field silently share one geometry.

**The primitive builders now live in `model-primitives.js`**, and the spec and gates built on top of
them are documented in `model-studio.md` — the bot is one target of several there. The field tables
below stay here because the rig is still the biggest consumer. They are no longer inside
`player-procedural-body.js`: that file's `gearGeometry`, `extrudeOutline`, `smoothProfile` and
`sharedGeo` are thin bindings onto `createPrimitiveFactory({ THREE, cache, defaults })`, and the
shared cache is `createGeometryCache()` — `clearSharedBodyGeometry()` delegates to it, so its
contract is unchanged. Bodies were the first consumer, not the only intended one: the model-studio
targets build from the same nine-type vocabulary, which is what lets one validator reason about the
cost of any of them (see `docs/superpowers/plans/2026-08-07-model-studio-plan.md`).

`outlineSmooth` and `profileSmooth` moved from descriptor reads to factory `defaults`, because they
are a house style rather than a property of a piece; an explicit `smooth` on a descriptor still
wins. `test-model-primitives.mjs` pins the vocabulary, the cache-sharing rules, and the two
tessellation numbers every triangle budget rests on — an `rbox` is **828** triangles at the
authored `seg: 3` and **156** at `GEAR_LOD_SEG`.

### Three build stages: primitive, modifiers, CSG

A descriptor is no longer just a primitive. `geometryFor` builds in a fixed order — **base
primitive, then the ordered `modifiers` stack, then the `csg` stack** — and the whole chain is in
the cache key. Nothing in the shipped bot design uses stages two or three, so the bot path is
unchanged; they exist because armour was the only thing the primitive list could reach.

**`tube` (`model-primitives.js`)** sweeps a cross-section along a Catmull-Rom path. `path` is the
control points, `size[0]` the radius, `seg` the tubular segments, and `section` an optional closed
`[x, y]` polygon in the frame plane — omit it for a circle of `radial` points, supply one for a flat
strap. `closed: true` makes a loop, `cap: false` leaves the ends open. This is the shape a surface
of revolution cannot make: cables, hoses, slings, railings, exhausts, tails. The fake, a chain of
cylinders, costs more geometries *and* reads as segments.

**`modifiers` (`model-modifiers.js`)** is an ordered list of vertex deformations, applied in the
order written — a taper then a bend is a different solid from a bend then a taper, so the list is
never sorted.

| op | fields | effect |
|---|---|---|
| `taper` | `axis`, `start`, `end` | scales the two perpendicular components from `start` at the axis minimum to `end` at the maximum |
| `bend` | `axis`, `around`, `angle` | bends the axis into an arc whose **total** sweep is `angle`; sign picks the direction |
| `twist` | `axis`, `angle` | rotates rings about the axis, `0` at the minimum to `angle` at the maximum |
| `bulge` | `axis`, `amount`, `center`, `width` | a raised-cosine bump on the perpendicular scale, `center`/`width` in 0..1 along the axis |
| `displace` | `amount`, `frequency`, `seed` | value-noise displacement along the vertex normal |

Two rules that are easy to get wrong:

- **Modifiers need tessellation along the axis they act on**, or they look broken while working
  correctly: a bend on a twelve-triangle box has no intermediate rings to move. `lengthSeg` on the
  descriptor supplies them — height segments for `cylinder`/`cone`/`capsule`, all three segment
  counts for the fallback box, extrusion `steps` for `rbox`. A test asserts a `lengthSeg: 1` bend
  barely deforms, so the trap is pinned rather than described.
- **`displace` must stay deterministic.** Geometry is cached and shared, so a piece that rebuilt
  differently would let two consumers disagree about the same descriptor. The noise is an integer
  hash, deliberately not `Math.random` and not the `Math.sin` fract trick.

**`csg` (`model-csg.js`)** is BSP booleans — `subtract`, `intersect`, `union`. Each entry is
`{ op, shape, position, rotation, scale }`, where `shape` is itself a descriptor, so a hole can be
any shape the vocabulary can make. This is the only way to cut a hole: magazine wells, trigger
guards, vents, bolt holes, eye sockets, recessed panels. The usual fake — a dark surface piece laid
on top — is the defect visible in img2threejs's own showcase, where a recessed charging well read as
a flat lid with a blob on it.

Three consequences worth carrying:

- **Cutters never enter the geometry cache.** They are built through the uncached `buildBase`,
  because a cutter is never rendered and letting one in would inflate the count the budget gate
  reads. A cut piece costs one cached geometry, not two.
- **Booleans are not free the way primitives are.** Output is non-indexed, triangle count grows with
  the cut, and coplanar faces fragment. Budgets must be measured on the finished geometry, never on
  the primitive that started it.
- **No UVs survive a boolean.** Position and normal only. Nothing in the role-coloured material
  system samples UVs today, but a target that needs them has to know.

`test-model-csg.mjs` checks every boolean against a hand-computed volume via `signedVolume`, which
is exported for that purpose — a broken cut usually leaves the volume wrong or negative, and no
triangle count or screenshot would show it.

Anchors are `pelvis`/`waist`/`torso`/
`neck`/`head` plus the limb joints `footL`/`footR`/`handL`/`handR`/`kneeL`…`hipR`; a side-less
name (`foot`, `hand`, `knee`, `elbow`, `shoulder`, `hip`) expands to BOTH sides with x (and the
y/z rotations) mirrored on the left. Gear geometry goes through the shared-geometry cache (keyed
on the descriptor), so it batches under instancing like every other part. Head gear is skipped on
headless styles.

Two authoring traps, both of which silently render nothing:
- **Gear inside a solid part is invisible.** A boot's body occupies x ±0.055, y 0–0.124, z ±0.143
  at the bot design's scale; a sole authored within that box never shows. Every detail piece must
  protrude past the surface it decorates.
- **Same-role gear on a same-role part is invisible.** A `shell` helmet on a `shell` head is one
  flat colour; contrast has to come from a different role.
- Eyes have the same failure mode: they are children of `head` (which carries `headZScale`), so a
  deeper `headProfile` can bury them. The bot design keeps the lens front at z 0.116 against a
  face surface at 0.089.

One rig caveat: `legLenRatio` above default mostly adds standing knee bend, not height — pelvis
height comes from the gait model, not the design.

`bot-design-studio.html` is the iteration harness for this spec: it renders design variants side
by side with the bot-viewer-v2 look (visual-system materials + themes) and exposes a
`window.__studio` API (setSlots/setAnim/setTheme/camera presets/labels) meant to be driven from
the console or browser automation. **How to run a session — the loop, the inspection tools, the
full API table — is in `design-studio.md`.** What follows here is why the panel behaves as it does,
which is a property of the rig rather than of the tool.

### Studio control panel

The studio also carries a DOM panel (sliders, number entries, dropdowns, colour pickers) over the
same descriptors this file documents, so a piece can be tuned by hand and pasted back into
`bot-body-design.js`. Slot 0 is the editable copy; the other slots stay on the shipped design as an
unedited reference. `window.__studio.controls` exposes `design`, `selection`, `select(indices)`,
`gearSource()`, `diff()`, `rebuild()`, `undo()`, `redo()` for scripted use.

Three things about the panel follow directly from the rig's shape, and matter if you extend it:

- **Position, rotation and scale are live; size and material are not.** Those three are placeholder
  local transforms, and `update()` never rewrites gear, so one write sticks and a drag can run at
  frame rate. `size`/`type`/`bevel`/`seg`/`radial`/`role` mint geometry or re-bucket materials, and
  every distinct geometry adds an `InstancedMesh` bucket that is never evicted — so they apply on
  release through a single coalesced `buildSlots`. Types whose `size` maps onto local axes
  (box, rbox, sphere, cylinder, cone) get a node-scale preview during the drag; lathe, extrude and
  torus wait for the rebuild.
- **Group edits are per-field.** Position and rotation apply a delta, sizes and scales multiply, and
  role/type/anchor/flags set absolutely. Multiplying is what keeps a selection's internal
  proportions intact rather than flattening every piece to one value. With `symmetry x` on, an X
  nudge moves a mirrored pair apart instead of sliding both the same way.
- **The selection outline is line geometry, not instance colour.** Calling `setColorAt` on an
  untinted bucket allocates a zero-filled buffer and blackens every other instance in it — the same
  trap `auditVisibility` documents.

The `eye` and `visor` materials are deliberately absent from the panel: `applyBots()` rewrites their
uniforms from the active theme every frame, so a control there would be overwritten immediately.
Lathe profiles and extrude outlines get a points-scale multiplier rather than a curve editor.

A **Body & head** section picks the two independently: `body` loads a frozen version from
`BOT_BODIES`, `head` swaps between `as authored`, the human face and the helmets, and the rest set
expression, hair, ears, skin tone and hair colour. The two behave differently on purpose — changing
the HEAD patches only the head pieces and keeps any body edits, while changing the BODY reloads that
version wholesale and discards them, because asking for a different body is not asking for yours to
be patched. Either way every gear index shifts, so the selection is dropped rather than remapped: an
index that survives a swap points at a different piece, which is worse than pointing at nothing. The
face controls grey out under a helmet. The panel reports `human` when it finds the `sclera` role and
`as authored` otherwise, rather than guessing which helmet is on — telling a Mark VII from a Mark
VIII from v3's slit by inspecting gear would be shape heuristics that silently rot.

A **Gallery** section exposes five INDEPENDENT AXES — body, head, kit, expression, skin — each a
multi-select, crossed at display time, plus a **per row** count. The first cut was a flat list of
pre-baked combinations, which quietly welded the axes together (skin tone only existed on a
`determined` face, expressions only on the current body), so the one thing a gallery is for —
varying one thing while holding the rest still — was the thing it could not do. An axis with
nothing selected is held at one value rather than showing none, or every axis would have to be
touched before anything rendered. Expression and skin collapse off under a helmet, since the skull
is only `skin`-roled on a human head. The cross product is capped at 36 and the overflow is
reported, because a silently truncated gallery reads as "that is all of them". Slots lay out as a grid rather than one row, wrapping at that
count, and `fit view` frames the whole thing — solving both fov axes and taking the larger distance,
since a wide lineup is limited horizontally and a single tall bot vertically.

Two costs worth knowing before adding to the gallery. The **importmap pins the minified three
builds**: unminified `three.webgpu.js` is 1.97 MB against 0.61 MB, which is 3.2x the bytes and 3.2x
the parse before the first frame. And **`buildSlots` clears the shared geometry cache every time**,
so every rebuild — including every slider release — regenerates all geometry and every body. For the
full gallery that is 126 unique geometries across ~2,100 part placeholders; the geometries are
cheap, rebuilding twenty whole bodies for a one-piece edit is not.

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

#### Scoring the fit automatically (`gait-objective.js`, 2026-08-09)

`gait-objective.js` drives `stepGait` headlessly over a speed sweep on procedural terrain and
reduces the resulting foot states to artifact measures — a swing foot passing through the ground,
a planted foot dragged outside `LEG_WORKSPACE_DEFAULTS.maxReach`, both feet airborne at once,
stride asymmetry, stride irregularity, excess lift, and steps short enough to read as jitter. That
turns the fit above into something an optimiser can search rather than something a human samples by
hand in `body-preview.html`. Contract 3's headless-test split is what makes this possible at all.

```js
export const GAIT_PARAMS, GAIT_BOUNDS, GAIT_BASELINE, GAIT_INDEX;  // 11 tunables; baseline IS the shipped fit
export const SPEED_SWEEP, HEIGHT_SWEEP, REFERENCE_PHASES;          // what a score averages over
export const BONES, LEG_REACH, TWO_BONE_CLAMP;                     // the real bone lengths and IK clamp
export function rigFor(height, radius);                 // the per-body workspace update() derives each frame
export function reachCliffHeight(pelvisRatio);          // height above which a standing leg cannot reach ground
export function cfgForSpeed(theta, speed);              // reproduces gaitForSpeed exactly at GAIT_BASELINE
export function shippedStepDuration(speed);             // the cadence a candidate may not beat
export function sampleGait(theta, rng, opts);           // one noisy walk — what a search may call
export function scoreGait(theta, opts);                 // clean reference over phases × heights × speeds
export function profileGait(theta, opts);               // per-speed artifact breakdown
export function createWalker(theta, opts);              // live preview; setTheta/setSpeed retune in place
```

`SPEED_SWEEP` is the four speeds a v3 bot actually moves at (crouch 1.32, walk 2.40, run 4.08, dash
4.69), derived from `BOT_MOVE_SPEED`, `runMultiplier` and the stance factors rather than invented.
`HEIGHT_SWEEP` is 1.7/1.8/1.9 — bots are all exactly 1.8, so the band exists for the player's Stand
slider, which `environment-viewer.html` lets the user drag from 0.5 to 2.5.

Paired with `spsa.js`, this is demonstrated in `demos/spsa-gait-tuning.html`, and
`node tune-gait.mjs` runs the same search headlessly and prints a pasteable result. Tests:
`node test-gait-objective.mjs` (116 assertions, exercises the shipped scheduler).

#### Selectable gait models (`GAIT_MODELS`, `movementTuning.gaitModel`, 2026-08-10)

```js
export const GAIT_MODELS;   // { shipped, tuned }, each { label, note, speed, triggerDistance, stepOverlap, stepLeadScale }
```

`movementTuning.gaitModel` names one of the keys; `update()` reads only `model.speed`, passing it to
`gaitForSpeed`. `triggerDistance`, `stepOverlap` and `stepLeadScale` are **recommendations for the
UI to copy into its sliders**, not values `update()` applies — `bot-viewer-v3.html` already writes
`stepOverlap` straight onto `gait.cfg` every frame, so applying them in the rig would fight the
panel. The v3 "Gait model" dropdown sits above the movement sliders and writes the selected model's
`stepLeadScale` into the slider, so the change is visible rather than hidden.

**`GAIT_MODELS.tuned` carries the shipped speed fit unchanged.** That is the result, not an
oversight — see the finding below.

#### Lean into step (`movementTuning.stepLeadScale`, 2026-08-09)

```js
export function leanAngleForSpeed(speed, cfg = LOCOMOTION_DEFAULTS);       // pure; radians
export function effectiveStepDuration(speed, cfg = GAIT_DEFAULTS);         // pure; mirrors stepGait's effStepDur
export function stepLeadFor(speed, gaitCfg = GAIT_DEFAULTS, leadScale = 0); // pure; metres
```

`update()` hands the gait scheduler a **balance point** — `pos + lead` along the *direction of
travel* — instead of the pelvis. The scheduler is unchanged; its rest anchor simply follows whatever
hip it is given. Lead is taken along velocity rather than facing because that is where the mass is
going, while the spine's own lean follows facing.

`lead = leadScale · speed · effectiveStepDuration`, capped at one `maxStepDistance` — a fraction of
the hip travel the foot has to catch up on. At scale 1 the planted foot ends up centred under the
hip. About 0.93 m at a dash, so this is a stride-scale effect, not a cosmetic one.

**`stepLeadScale` defaults to 0, which is exactly the previous behaviour** — asserted in
`test-player-body-gait.mjs` across every speed and gait config. `bot-viewer-v3.html` exposes it as
the "Lean into step" slider in the movement section, saved with the rest of `botMovementSettings`.

**Finding: a step is aimed at lift-off and never revised, so the foot always lands behind the hip.**
This is the rig's largest measurable gait defect. `stepGait` sets `stepEnd` when the foot lifts and
lerps to it; during the swing the hip travels `speed · effStepDur`, which at a dash is about a
metre. Traced at 5.2 m/s, the planted foot runs from **0.36 m to 1.46 m behind the hip and is never
once underneath it**. `aheadDist` was meant to cover this — it is exactly one step of hip travel —
but `constrainFootTarget` then clamps the target to `workspace.forward` (0.62 m) and throws most of
it away.

**Finding: nothing downstream absorbs an out-of-reach foot target.** Legs are solved by
`solveTwoBone`, an analytic two-bone IK that clamps the end effector to `0.999 · (L1 + L2)` along
the hip→target line. There is no FABRIK on the legs and nothing stretches the bones, so an
unreachable target means the *drawn* foot is not where the simulation put it — on a planted foot
that is visible skating. `constrainFootTarget` cannot prevent it either: its `maxReach` is a purely
**horizontal** bound and never sees the drop to the ground. This supersedes an earlier note here
which guessed that "FABRIK plus body settle may absorb part of it". They do not; there is no FABRIK
in the leg path. `simulateWalk` now scores it as `slidePlanted` / `slideSwing`.

**Finding: bone lengths do not scale with body height, but the pelvis and workspace do.** `legLen`
is built from a function-local `H = 1.8` for every body, while `pelvisY = height ·
pelvisHeightRatio` and every workspace field is multiplied by `height / H`. So a taller body raises
its hip and widens its planning volume while keeping a 1.116 m leg. Above **1.895 m**
(`reachCliffHeight()`) a standing leg cannot touch the ground at all, and the player's Stand slider
goes to 2.5. `HEIGHT_SWEEP` deliberately reaches past that cliff rather than avoiding it.

**Result of the search: the shipped coefficients did not need changing.** Tuning all eleven
parameters scores **3.16**; adding only the lead term scores **3.87**, against a shipped baseline of
**2.49**. So `GAIT_MODELS.tuned` ships the shipped fit with a lead term and nothing else. At v3's
`stepOverlap` of 0.22 the best `stepLeadScale` is **0.55**, which takes the planted foot's overshoot
at a dash from 0.099 m to 0.004 m and the fraction of ticks past reach from 47% to 8%, with cadence,
stride, hip height and lift untouched. The optimum moves with overlap (0.76 at 0, 0.54 at 0.22, 0.38
at 0.33) because an overlapped step shortens the stance phase.

Things worth knowing before trusting a number this harness produces:

- **`GAIT_DEFAULTS.lookAhead` is dead.** Declared, never read anywhere in
  `player-procedural-body.js`. Excluded from `GAIT_PARAMS`; tuning it moves nothing. Either wire it
  up or delete it. `stepLeadScale` is what it should have been.
- **`triggerDistance` is inert while walking.** The desired target is always further than the
  trigger at every swept speed, so both feet always want to step and the rate is set by
  `stepDuration` and the strict alternation. Setting it anywhere in 0.05–0.28 changes nothing
  measurable. It is still tuned, because a much longer `stepDuration` would make it bind.
- **The rig steps about twice as fast as a human and cannot stop.** 3.75 footfalls/s at 1 m/s
  advancing 0.27 m each, against roughly 1.8 and 0.55 for a person. Forcing human cadence measurably
  makes slide *worse* (0.455 m against 0.269 m at sprint), because a longer ground contact drags the
  foot further behind a hip whose leg spans only 0.35 m horizontally. The shuffle is how this
  geometry buys low slide. Cadence is therefore scored as a don't-regress rule against the shipped
  model, not against an absolute target. The underlying limit is leg length versus hip height, and
  no coefficient fixes it.
- **Three objective exploits had to be closed**, each of which scored a visibly bad gait near 4.0:
  measuring cadence from `cfg.stepDuration` instead of the effective duration (the search set one
  high and drove the other to the floor, scoring an 8 Hz shuffle at 3.99); loose pelvis bounds (it
  squatted to 0.40 of body height); and penalising a flight phase at running speed, which punished
  the `stepOverlap` v3 was deliberately tuned to. Assume the next new term has one too.
- **Step lift is only weakly constrained.** The clipping term that should push lift up is small, so
  the objective is nearly indifferent to it even though a floaty walk reads as wrong.

---

### Cyclic locomotion layer (`naturalLocomotion`, `body-locomotion.js`, 2026-08-06)

The gait scheduler is **reactive**: a foot waits until its error from the under-hip rest point
crosses `triggerDistance`, then swings. That places feet correctly on terrain but produces no walk
**cycle**, so nothing above the ankles knows a stride is happening — arms hang, hips stay square,
feet stay flat to the ground normal. The result reads as a puppet on strings.

`body-locomotion.js` adds a cyclic pose layer on top. It is THREE-free like the gait scheduler and
is covered by `test-body-locomotion.mjs`.

```js
export const LOCOMOTION_DEFAULTS;            // frozen; `enabled: false`
export function createLocomotionState();
export function stepLocomotion(state, dt, { speed, feet }, cfg);  // mutates + returns state.pose
export function createLocomotion(overrides);  // { cfg, state, pose, update(dt, input) }
```

**Phase comes from the feet, not from a clock.** A free-running sine would drift out of sync with
the planted feet, which is the classic source of foot-slide. Instead the layer watches for lift
events (`foot.stepping` false→true), pins left lifts to phase 0 and right lifts to phase 0.5, and
measures the stride period from the gap between alternating lifts. Corrections are bled in over
`syncRate` rather than snapped, because a snap is itself a visible hitch. `swingFrac` (the share of
a stride a foot is airborne) is likewise eased, since it positions both the leg's forward peak and
the ankle curve's stance/swing boundary.

`pose` fields, all faded by an amplitude weight that ramps with speed and by `1 - prone`:

| Field | Applied to | Axis / units |
|---|---|---|
| `armSwing.left/right` | idle arm target only (an aiming arm keeps the gun) | rad, local +X, contralateral to that side's leg |
| `armSpread.left/right` | idle arm target | m outward |
| `anklePitch.left/right` | `leg.foot.quaternion` in `solveLeg` | rad, local +X, + = toes down |
| `pelvisRoll` | `_pelvisQ` + `_hipQ` | rad, local +Z; + drops the left side (the swing leg) |
| `pelvisYaw` / `shoulderYaw` | `_pelvisQ`/`_hipQ` and `_upperQ`/`_shoulderQ` | rad, local +Y, counter-rotating |
| `torsoLean` | `_upperQ` | rad, local +X, scales with speed only |
| `bob` / `sway` | `motion.bob` / `motion.sway` | m / fraction of radius |

`bob` replaces the old per-step `sin(π·stepPhase)`, which collapsed to zero whenever both feet were
down and so ticked once per stride. The cyclic version peaks at mid-stance and dips at double
support — two dips per stride, continuous throughout.

Two quaternions exist where one might seem enough: `_pelvisQ` orients the pelvis **mesh** and
inherits the prone blend from `_bodyQ`; `_hipQ` places the hip **sockets** and stays on the upright
`_orient` the legs have always used. Merging them would swing prone hips out of place.

`GAIT_DEFAULTS.stepOverlap` (0..~0.5, default **0**) is the companion change in the scheduler: the
fraction of a swing the trailing foot may have left when the next foot lifts. At 0 the original
strict alternation holds and one foot is always planted, which is what makes the stride read as
plant-pause-plant.

**Spine gradient (2026-08-06).** `waist`, `torso` and `neck` previously all copied one `_upperQ`, so
the upper body twisted as a single block hinged at the hips. Each segment now takes a share of the
locomotion twist and lean via `spineOrient(out, frac)`, where `frac` is that segment's height above
the pelvis over the shoulder line's (0.34 H) — about 0.29 at the waist, 0.65 at the torso, 1 at the
neck. `body.spineCfg.falloff` (default 1, linear) is the exponent: above 1 holds the twist in the
chest, below 1 pushes it down into the waist. The crouch hunch is deliberately **not** graded — it
is a whole-torso pose — so it stays in the shared `_upperBaseQ`. `_upperQ` remains the full
shoulder-line rotation and still drives the head.

### Kneel stance (`state.kneel`, `KNEEL_DEFAULTS`, 2026-08-07)

A third stance channel beside `crouch` and `prone`, modelled on prone rather than crouch: kneeling
is a distinct pose, not a shortened standing one. Kneeling on **one** knee — the firing position:
rear knee on the ground under the hip, front foot planted with the thigh horizontal and the shin
vertical, torso upright.

**Precedence is prone > kneel > crouch.** `kw = state.kneel * (1 - pw)`; crouch is then scaled by
`(1 - kw)`, so two stances can never both claim the pelvis. The locomotion layer fades by
`(1 - pw) * (1 - kw)`, and the gait scheduler keeps running underneath with its output ignored,
exactly as under prone.

Two structural differences from `proneCfg`:

1. **Units are limb multiples, not metres.** A kneel is a closed kinematic chain; fixed metres
   would stretch limbs on any body whose skeleton differs from the H=1.8 baseline. Note the
   skeleton is one fixed size for every body (only meshes scale per-instance), so the kneeling hip
   height derives from `thighLen`, never from `state.height`.
2. **The knee is authored, not solved.** Prone lerps a foot target and lets IK find the knee. A
   kneeling knee has to be on the ground under the hip and no pole angle reliably puts it there, so
   `solveLeg` takes `kneeTarget`/`kneeWeight` and lerps the solved joint toward the authored one
   after `solveTwoBone`. `placeSegment` stretch-fits, which absorbs the small bone-length error
   mid-blend; at weight 1 the authored chain closes on its own.

`pelvisYK` (kneel-adjusted hip) was split out from `pelvisY` because the whole upper-body stack
hangs off it — left on the standing `pelvisY`, the torso floats while the hips drop away.
`pelvisYP` adds prone on top and is what the pelvis mesh and the legs use.

`test-body-kneel.mjs` covers the property the design rests on: both chains closing to within 5% of
true bone length, for both handednesses, plus the shape assertions that separate a kneel from a
squat (thigh horizontal, shin vertical, knee grounded, legs uncrossed).

Tune it in `body-preview.html` — Stance = kneel, "Kneel pose" panel. That panel shows a **live
bone-length error readout**, because the sliders can trivially author a chain that does not close
and `placeSegment` would hide it by stretching.

**Bots drive this channel as of 2026-08-08.** `bot-stance.js` gained `STANCE_KNEEL` and a third
`kneel01` weight, and `bot-viewer-v3.html` feeds it into `st.kneel` on the same eased-weight path as
`crouch`/`prone`, so the rig pose, the collision capsule, and the weapon hold all read one source.
Which FSM rungs take it, and why the capsule ends up *taller* than a crouch, are documented in
`docs/subsystems/bots.md`. Every weapon gained its own `kneelHold` on 2026-08-11 — the first wiring
folded `kneel01` into the crouch weight, which left a kneeling rifle 0.51 m below its own shoulders;
see Contract 6 for the derivation. The channel stays opt-in per viewer (`kneelEnabled`, default off):
`bot-viewer-v2.html` and `environment-viewer-v2.html` have no third weight channel, so letting the
ladder pick kneel there would render a kneeling bot standing.

**Saving a tuning session (2026-08-07).** `body-preview.html` has a Save/load tuning section that
POSTs to `serve.py`'s `/api/save-body-tuning`, writing `body-tuning/body-tuning-[<label>-]<stamp>.json`,
and lists them back via `/api/list-body-tuning`. Every save is a new timestamped file, not an
overwrite — tuning is exploratory and the point is being able to return to the one that looked
right. The payload carries both the semantic blocks (`locomotionCfg`, `stepOverlap`, `spineCfg`,
`movementTuning`, `proneCfg`, `crouchCfg`, `ikCfg`, the speed-model fit) for pasting into source
**and** a `ui` snapshot of every slider, which is what Load restores — a re-derivation from the
semantic blocks would silently drop any slider with no cfg field behind it. `serve.py` must be
restarted after pulling this change or the endpoint 404s.

**Compatibility with the bot render paths** (both verified, not assumed):

- **Instanced bodies** (`body-part-batches.js`): `flush()` uploads `part.matrixWorld`, the full
  transform, so the new ankle rotation reaches the instanced matrix like any other pose change.
- **Rig LOD striding** (`bot-viewer-v2.html`): distant bodies solve every 2nd or 4th frame with a
  banked `dt`, and `gait.update` is skipped alongside the rig, so lift events are sampled on the
  same coarse grid. Because the phase is *locked to those events* rather than free-running, the
  error stays bounded by the sampling interval instead of drifting: measured worst-case is ~3% of
  a cycle at 60 Hz, ~7% at 30 Hz (beyond 18 m) and ~13% at 15 Hz (beyond 45 m). Covered by the
  `rig LOD:` assertions in `test-body-locomotion.mjs`.

**Ships off.** `naturalLocomotion` defaults to false and `stepOverlap` to 0, so
`environment-viewer.html` and `bot-viewer-v2.html` are unchanged until the tuning is adopted.
`body-preview.html` creates its body with `naturalLocomotion: true` and exposes the full config as
live sliders under "Natural locomotion" (plus a **Movement dynamics** checkbox, since the preview
previously built its body without `movementDynamics` and so disabled the turn lag and bob/sway that
bots actually run with). Copy-tuning exports `locomotionCfg` + `stepOverlap`.

---

### Limb-segment frames are body-rigid (2026-08-05)

`placeSegment(mesh, a, b, thickness, orientation)` orients a limb by the **shortest-arc** rotation
from local +Y to the bone. A shortest-arc rotation carries **no roll**, so computed in world space it
leaves a near-vertical bone with a near-identity frame *whichever way the body is facing* — the
segment's local frame is world-locked, not body-locked. It now does the identical solve in **body
space** and rotates the result by `orientation`:

```js
_segDir.copy(_dir).applyQuaternion(_segInvQ.copy(orientation).invert());
mesh.quaternion.setFromUnitVectors(_up, _segDir).premultiply(orientation);
```

- **Nothing rendered changes.** Limb geometry is a lathe about Y (`makeMannequinLimbGeometry`) and
  `placeSegment` scales X and Z equally, so a segment is exactly rotationally symmetric about the
  axis being rolled. `placeSegment` is called for limb segments only — the four IK ones plus the
  ragdoll's — never for hands, feet, gear or core parts, which set their own orientation.
- **`orientation` is optional and defaults to `null`**, which restores the old world-space behaviour.
  `solveLeg`/`solveArm` pass their existing `orientation`; the ragdoll path passes `_rdBodyQ`.
- **Why it matters:** anything pinned in a limb's local frame — a blood decal via
  `bot-body-hit.js` — used to stay put in world space while the body turned around it, so a stain on
  the front of a thigh appeared on the back after a 180° turn. Measured at ~0.12 m of error on a
  ~0.11 m-thick thigh, i.e. the exact mirror position.
- `test-segment-frame.mjs` pins the property: rotate a pose rigidly through `setRagdollPose` and every
  limb frame must rotate by the same amount (exact to ~1e-17), for both legs and both arms.

---

## Contract 3 — IK / gait core (copy, do not import)

The body **copies** a narrow subset out of `port-creature-system.js` — it must NOT import the
`Creature` class (its `physicsStep()` moves the creature from its feet and would fight the player
controller).

Reference implementations to copy from `port-creature-system.js`:
- `KinematicChain` (line ~654): `new KinematicChain(segments)` where `segments = [{ length, initDirection: THREE.Vector3 }]`; `solve(root, target, orientation) -> THREE.Vector3[]` (FABRIK; last point is the foot/hand). **Uses THREE.**
- `terrainNormal(x, z, out)` (line ~18): finite-difference normal from `terrainHeight`. **Uses THREE.**

**Headless-test split (required):** the biped **gait scheduler** (foot state: `current/target/rest/stepping/phase`, trigger-distance, alternation, look-ahead, step curve, settle-under-hips) must be pure array/number math with **no THREE import**, so `test-player-body-gait.mjs` can run under `node`. The THREE-dependent rig + `KinematicChain` rendering layer sits on top and is not unit-tested headlessly. The same rule covers `body-locomotion.js` (`test-body-locomotion.mjs`) — `player-procedural-body.js` may import it precisely because it is also THREE-free.

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
- **Grip anchor frame convention** (rightGrip/leftGrip): `+Y` = finger direction, `+Z` = out of the
  palm into the weapon, right-hand thumb toward `+X` (left mirrored); `p` is the palm contact point.
  `weapon-anchor-editor.html` renders translucent hand proxies at grip anchors in this frame ("Show
  hands at grips") so the twist about the grip axis is authorable — the old axes-only authoring left
  that twist arbitrary (the V2 stub hand is a surface of revolution), which is why body-preview-v3
  derives palm frames from weapon geometry instead of trusting `q`. Anchors re-authored against the
  hand proxies satisfy this convention and can be trusted directly.
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
  getAction(),         // bare action string; allocation-free alternative to getDebug().action (2026-07-25)
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
from `feel.bobWalk`/`feel.bobRun` and are damped by aim and reload. Idle↔walk↔run is not a hard switch:
`moveBlend`/`runBlend` are eased 0→1 blends so bob amplitude, phase rate, and the walk-form vs run-form
*shape* all cross-fade across the boundary — a hard switch popped the gun (and the bob-following hands) in
one frame because player speed is set directly on Shift. The net camera-local bob translation is
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
| `crouchHold` | crouch | same mount space, dropped by the rig's own crouch shoulder drop (0.773 m) |
| `kneelHold` | kneel | same, dropped by the kneel shoulder drop (0.516 m) — **higher** than crouch |
| `proneHold` | prone | dropped low + pushed forward so the gun sits at ground level in the outstretched hands |

The mount rig itself stays at terrain+1.5 in **every** stance (both in the preview and in the game) —
the per-stance holds carry the full vertical drop themselves.

**Each stance needs its own hold, and its Y is not free.** Because the mount never moves, hold Y is
the only thing expressing how far that stance lowers the shoulders, so it is *derived*, not styled:

```
holdY(stance) = holdY(stand) − (shoulderY(stand) − shoulderY(stance))
```

with `shoulderY = pelvisY + height*0.34*(1 − dropShoulder)` (`player-procedural-body.js:1832`). For a
1.8 m body at rest that gives a **0.773 m** drop to crouch and **0.516 m** to kneel. Kneel is the
smaller drop: a crouch is a deep squat parking the hip at 0.40 m, while a kneel sits it at a full
thigh length, 0.58 m, and the kneel shoulder drop is 0.06 against crouch's 0.19 — so a kneeling bot's
shoulders ride **0.26 m higher** than a crouching one's. `test-weapon-hold-resolver.mjs` pins every
weapon's authored holds against these rig constants, so retuning `crouchCfg`/`KNEEL_DEFAULTS` fails
the test rather than silently desyncing the gun.

Getting this wrong is invisible in code review and obvious in the render. Until 2026-08-11 every
weapon's `crouchHold` was `thirdPersonHold` with Y overwritten by a flat −0.09 ("the shoulder
convention"), which cannot express a per-weapon offset: the standing holds differ (0.44 pistol / 0.92
rifle / 0.96 RPG) and all three collapsed to the same crouch height. That left the rifle 0.25 m below
its shoulders and the pistol 0.23 m above. Kneel then had no slot at all and borrowed crouch's,
compounding to 0.51 m. The tell that it was mechanical rather than tuned: X, Z and the whole rotation
triple were byte-identical between stand and crouch for every weapon.

The game blends stand→crouch→kneel→prone by the smoothed stance weights, un-normalized: since both
`shoulderY` and the hold lerp are linear in the crouch weight and the hold is authored at crouch = 1,
a partial crouch lands at the right shoulder-relative height for free. (The env-viewers previously
divided their 0.7 body crouch target out of the hold weight; that was compensating for the flat
−0.09 and became wrong once the hold was derived.) The preview's body state (`height: 1.8`,
`radius: 0.3`) and the game's `fp.heightStand` / player capsule radius must stay equal so tuned holds
read identically in both; the game was raised to 1.8/0.3 to match the preview the holds were tuned in.
Holds are absolute metres, so a body whose height differs from 1.8 still wants its own values.

Tuned in `body-preview.html` — a Weapon selector (m1911/m24) loads the real GLB for each weapon
and the Stance selector swaps a separate slider set per weapon+stance (`WEAPON_HOLDS[weaponId][stance]`,
seeded from each weapon's `thirdPersonHold`/`crouchHold`/`kneelHold`/`proneHold`), and Copy-tuning
exports the active weapon's four stances under `weaponHolds`. Hold values (including
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

## Contract 6 — Third-person hold: stance × locomotion

**Owner since 2026-08-22: `weapon-mount.js`.** `createWeaponMountSystem` is the one implementation
of the mount frame, hold resolve, pose-controller drive, barrel trim and instanced flush described
below; base-game and bot-viewer-v3 both use it. See `docs/subsystems/base-game.md`, "Weapons, phase 1".

Added 2026-07-27. Contract 5's `weaponPoses` (`lowReady`/`aimed`/`reloadRaise`) are one set shared by
every weapon and live *under* the mount. This contract covers the layer *above* it: where the weapon
sits relative to the body. Owned by `weapon-hold-resolver.js`, which is imported by both
`bot-viewer-v2.html` and `weapon-animation-viewer.html` — that shared import is the contract. The
authoring tool must never compute a hold itself, or what it previews stops being what ships.

**Per-weapon stance holds** (`weapons.js`, mount space, unchanged shape):
```js
thirdPersonHold: { position: [x,y,z], rotation: [x,y,z], scale }   // and crouchHold / kneelHold / proneHold
```
Blend precedence is prone > kneel > crouch, the rig's own (`stanceBlendWeights`). A missing hold falls
back along the chain crouch → stand, kneel → crouch, prone → stand, so an unauthored stance is merely
mispositioned rather than collapsed onto the mount origin.

**Per-class carry deltas** (`CARRY_PRESETS` in `weapon-hold-resolver.js`), opted into by
`carryClass: 'rifle' | 'pistol'` in `weapons.js`, overridable per weapon via `carryHolds`:
```js
{ walk: { position: [x,y,z], rotation: [x,y,z] }, run: {...}, dash: {...} }
```

Each locomotion entry (`walk`/`run`/`dash`) is normally that flat `{position, rotation}` shape, applied
unchanged at every stance. A weapon whose carry has to read differently prone vs. standing (added
2026-08-04 for the RPG — its length flips backwards-looking at the generic rifle walk pose) can instead
give that entry the stance-aware shape:
```js
{ stand: { position: [x,y,z], rotation: [x,y,z] }, crouch: {...}, prone: {...} }
```
`crouch`/`prone` are each optional and fall back along the chain `crouch -> stand`, `prone -> crouch ->
stand` — the same convention `crouchHold`/`proneHold` use on the stance holds themselves. `carryDeltaFor`
now takes a third argument, the same eased `{crouch01, prone01}` weights `resolveWeaponHold` takes, and
blends a stance-aware entry with the identical prone-dominates-crouch curve so the carry never disagrees
with the stance hold it composes with mid-transition. Both `CARRY_PRESETS` entries and per-weapon
`carryHolds` entries may use either shape; `resolveCarryEntry` in `weapon-hold-resolver.js` discriminates
on `entry.position` (flat) vs. absence of it (stance map). Callers (`bot-viewer-v2.html`,
`environment-viewer-v2.html`) must pass the actor's `stanceWeights` as `carryDeltaFor`'s third argument —
omitting it silently resolves a stance-aware entry as if standing.

The two axes combine differently, deliberately:

| Axis | Values | Combination |
|---|---|---|
| Stance | stand / crouch / prone | **Continuous lerp** by the eased `{crouch01, prone01}` weights `bot-stance.js` already gives the rig |
| Locomotion | idle / walk / run / dash / aim | **Additive delta**, itself eased by `stepCarryBlend` |

Stance must ride the rig's own weights or the gun detaches from the hands mid-transition. Locomotion
is additive so the vocabulary stays 3 deltas per class instead of the 5 × 3 = 15 holds per weapon a
cross product would need; `crouch-walk` is then `crouchHold + walk delta` for free. `idle` and `aim`
carry no delta — they *are* the authored stance hold.

**Sign convention** (mount space, verified against the pose controller's recoil, which raises the
muzzle with `r[0] - kick`): `+rotation[0]` = muzzle **down**, `+rotation[1]` = swung **across** the
body toward perpendicular, `+rotation[2]` = roll clockwise from behind.

Rotations compose by **component-wise addition**, not quaternion multiplication — matching how
`environment-viewer.html` already blends its stance holds, and keeping the authoring sliders WYSIWYG.

**Two rules callers must honour:**
- `isCarryLocomotion(loc)` → never barrel-solve that frame. A carry deliberately points the weapon
  off-target; solving it onto an aim point undoes the entire pose.
- `isOneHanded(loc)` (dash only) → release the support arm and drive it to a body-local tuck
  *after* `controller.update()`, which drives both hands to their grips.

**The mount frame is ground-anchored and stance-INVARIANT.** The rig sits at the body's smoothed XZ,
`terrainHeight + 1.5` — never at a body joint. This is the frame `body-preview-v3.html:3925` authors
in and `environment-viewer.html` renders in, and the stance holds carry the whole vertical drop
themselves. Mounting to the torso joint double-counts every stance: the torso already drops ~0.75 m
into a crouch (`pelvisDrop` 0.62 + `torsoDrop` 0.25), so `crouchHold`'s further ~0.77 m put the weapon
below the feet with the IK hands chasing it into the floor (fixed 2026-07-29; `bot-viewer-v2.html`
had drifted to a torso mount and the overshoot was exactly the torso drop).

Consequence: **bob and sway must be re-added explicitly** — `motion.bob` on Y and `motion.sway` along
body-right on XZ, both scaled by `(1 - prone01)`. They cannot be inherited via a joint, because no
joint carries them without also carrying the stance pose.

### The mount's ROTATION follows the shoulder line (2026-08-12)

Position stays ground-anchored, as above. The *rotation* was `Euler(0, visualYaw + headYaw, 0)`, which
put the head's turn-anticipation yaw on the gun — the head leads a turn and then recentres, so the
weapon swung ahead of the body and back for no reason. With the aim channels
(`docs/subsystems/bots.md` § "Aim coherence") the mount is instead built exactly the way the rig builds
its shoulder line:

```
Ry(visualYaw) · Rx(state.aimLean) · Ry(state.aimYaw)
```

Same axes, same composition order as `spineOrient`, so the gun and the chest cannot disagree. The
euler order is `YXZ` and the twist is applied as a separate quaternion multiply afterwards, because
`Ry·Rx·Ry` is not expressible as one euler. This is a rotation-only change: it is **not** a licence to
reparent the mount to the torso — that failure is documented immediately above and has not changed.

Sign note: `state.aimLean` and `state.aimPitch` rotate about the same local `+X` in the same frame, so
whichever direction the head already pitches for a positive `aimPitch`, the weapon pitches the same
way. The sign is inherited from the shipped head behaviour rather than re-derived.

### Aim channels on the rig (`player-procedural-body.js`, 2026-08-12)

Four optional `state` fields, all defaulting to 0 so every caller that does not set them renders
byte-identically:

| Field | Meaning |
|---|---|
| `aimYaw` | spine twist toward the aim point, body-local radians. Applied on the height gradient (`frac`) but **not** on `_spineLw` — that locomotion weight is zero when kneeling or prone. Also applied whole to `_shoulderQ`, or the arms detach from the twisted chest. |
| `aimLean` | spine pitch toward the aim elevation, same gradient |
| `lookYaw` | head yaw toward the target, **relative to the twisted spine** (the head inherits `_upperQ`) |
| `lookWeight` | 0..1 blend of `lookYaw` over the existing turn-anticipation yaw. 0 is the old behaviour exactly. |

`state.aimPitch` keeps its meaning (head pitch) — the caller sends `aimPitch − aimLean` so the total
elevation is unchanged. Only `bot-viewer-v3.html` sets any of these today.

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
