// bot-human-body.js
//
// A CLOTHED HUMAN body for the bots — the unarmoured one that goes under the human head. The bare rig it
// replaces is a mannequin: one symmetric spindle profile shared by all four limbs, which reads as
// segmented tubing with a face on top.
//
// LIMB PROFILES ARE THE WHOLE POINT. Profiles are [rMul of half-thickness, yFrac of length], with
// yFrac -0.5 at the PROXIMAL end (hip/shoulder) and +0.5 at the DISTAL one (knee/wrist) — see
// placeSegment. A thigh and a calf taper in OPPOSITE directions along that axis, so no single
// symmetric profile can be both, and sharing one is exactly why the legs read as pipe.
//
// WHAT A LATHE CANNOT DO. These are surfaces of revolution, so a profile controls the limb's
// RADIUS at each height and nothing else — front/back asymmetry is not expressible. What is
// expressible, and what carries the read at any distance, is where the mass sits along the bone and
// how the limb enters each joint.

// TROUSERS, NOT LEGS. These are clothed, and fabric obeys different rules from muscle: it drapes
// over the mass rather than wrapping it, so it never narrows as hard, it BUNCHES at the joints
// instead of thinning into them, and at the bottom it blouses over the boot instead of tapering to
// an ankle. A bare-leg profile under a uniform reads as a wetsuit.

// Trouser thigh: fullest at the seat, then a long gentle drape to a knee that stays WIDE — 0.88,
// against the 0.58 a bare knee would take. Trousers do not hug a kneecap. The slight swell at 0.37
// is fabric gathering just above the bend.
// Peak raised to 1.38 once the calf was rebuilt: at 1.22 the thigh was NARROWER than the new calf,
// which reads as chicken-legged whatever the taper does.
export const TROUSER_THIGH_PROFILE = [
  [0.58, -0.500], [1.08, -0.450], [1.30, -0.360], [1.38, -0.250], [1.36, -0.120],
  [1.26, 0.010], [1.14, 0.140], [1.02, 0.270], [0.95, 0.370], [0.90, 0.450], [0.86, 0.500],
];

// Trouser shin: the calf swell is there but SOFTENED — cloth spans the hollows rather than
// following them. The important shape is at the bottom: instead of tapering to an ankle it flares
// out at 0.41-0.46 and gathers in at the cuff. That blouse over the boot top is the single most
// recognizable thing about combat trousers, and it is what a bare-leg taper cannot fake.
// MEASURED and rebuilt. The first cut varied by only 13% across the calf and 6% at the cuff, which
// is below the threshold where a viewer sees anything — the critique came back "a cone", and it was
// right about the silhouette even though the numbers did vary. The swell now reaches 1.24 and the
// pre-cuff narrowing drops to 0.72, so the blouse at 1.06 is a 47% step instead of a 6% one.
// The blouse moved from yFrac 0.43 to 0.10. Measurement showed the boot top standing 181 mm above
// the ankle — the old flare, and every cuff piece with it, was sitting INSIDE the boot shell. Below
// yFrac ~0.15 the trouser is inside the boot and invisible, so it just tapers away.
export const TROUSER_SHIN_PROFILE = [
  [0.86, -0.500], [1.06, -0.420], [1.20, -0.320], [1.24, -0.215], [1.18, -0.090],
  [1.02, 0.020], [0.90, 0.070], [1.06, 0.110], [1.10, 0.150], [0.86, 0.210],
  [0.70, 0.320], [0.34, 0.500],
];

// Sleeves follow the same logic: fuller than the arm, gathered at the cuff.
// Upper-arm sleeve: mass high over the deltoid and bicep, then a real taper into the elbow. Ending
// at 0.84 left the sleeve nearly as wide at the elbow as at the shoulder, which is a tube.
export const SLEEVE_UPPER_PROFILE = [
  [0.62, -0.500], [1.00, -0.440], [1.14, -0.340], [1.16, -0.230], [1.10, -0.090],
  [1.02, 0.070], [0.94, 0.230], [0.85, 0.360], [0.78, 0.450], [0.72, 0.500],
];
// Forearm sleeve: the proximal bulge is GONE. Peaking just below the elbow put a swell right where
// the joint is, and that swell — not the joint sphere, which measures well inside the sleeve — is
// what read as a bead poking out mid-arm. A sleeve runs smoothly out of its elbow.
// Forearm sleeve: widest just BELOW the elbow, then a long taper to a narrow wrist, with a small
// gather at the cuff. Flattening this to kill the elbow bead left it a near-cylinder — correct at
// the elbow, wrong everywhere else, and a forearm that does not narrow reads as a sleeve of pipe.
export const SLEEVE_FOREARM_PROFILE = [
  [0.94, -0.500], [1.02, -0.400], [1.04, -0.300], [1.00, -0.160], [0.93, 0.000],
  [0.84, 0.160], [0.74, 0.300], [0.66, 0.400], [0.72, 0.460], [0.56, 0.500],
];

// NO GLOBAL SCALE. An earlier pass multiplied every length here by 1.233 to make the figure taller.
// That is the wrong lever and it produced the squat in the screenshot: `legLenRatio` sets the leg
// BONE length, but the pelvis sits at a fixed `gait.pelvisHeightRatio * H` regardless, so longer
// bones do not lift the body — they just bend the knees. See the constraint on legLenRatio below.
export const HUMAN_HEAD_SCALE = 1;

// ---------------------------------------------------------------------------------------------
// BONE LENGTHS, and the cuff positions DERIVED from them.
//
// Cuffs are gear, and gear positions are absolute metres along a bone. So every one of them is a
// literal that silently goes wrong the moment a length ratio changes — which is exactly what
// happened: shortening the arms to canon left the sleeve cuff 37 mm PAST the wrist, a black band
// sitting on the back of the hand, and re-lengthening the legs left all three boot pieces floating
// 70-150 mm up the shin. Nothing in the descriptors looked wrong; the bones moved underneath them.
//
// The ratios live here as named constants so the design and the gear read the SAME numbers. Change
// a ratio and the cuffs follow.
// ---------------------------------------------------------------------------------------------
const H_REF = 1.8, R_REF = 0.35;    // the rig's own reference height/radius (player-procedural-body)
const LEG_LEN_RATIO = 0.62, THIGH_FRAC = 0.50, SHIN_FRAC = 0.50;
const ARM_LEN_RATIO = 0.36, UPPER_ARM_FRAC = 0.56, FOREARM_FRAC = 0.44;
const LIMB_THICK_RATIO = 0.32;
const FOOT_SCALE = [0.47, 0.62, 1.18];
const FOOT_LIFT = -0.10;            // the rig's default; the boot normalises to 2 units then shifts

const LIMB_T = R_REF * LIMB_THICK_RATIO;
/** Wrist, as a distance down the forearm from the elbow anchor. */
const WRIST = H_REF * ARM_LEN_RATIO * FOREARM_FRAC;
/** Ankle, as a distance down the shin from the knee anchor. */
const ANKLE = H_REF * LEG_LEN_RATIO * SHIN_FRAC;
/** Top of the boot, same frame. Larger y is LOWER — knee-anchor +Y runs down the shin. */
const BOOT_TOP = ANKLE - FOOT_SCALE[1] * LIMB_T * (2 + FOOT_LIFT);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Knee and elbow pads — a hard SHELL on the front of the joint with side straps wrapping behind it,
 * which is what a real tactical pad is.
 *
 * This needed a rig change to do honestly. Limb-joint frames come from setFromUnitVectors, whose
 * roll about the bone is whatever the minimal arc gives, and near a straight-down leg that arc is
 * degenerate — so anything at a joint had to be symmetric about the bone or it would drift off the
 * front as the limb swung. That constraint is why the first two attempts were 360-degree wraps, and
 * why they read as compression sleeves: a uniform tube is the silhouette of a brace, not a shell.
 * `faceBody: true` (player-procedural-body.js) puts a piece on an anchor whose roll is locked to the
 * body's forward, so the shell can sit where a shell belongs.
 *
 * The shell is an `rbox` — a rounded, chamfered plate — not a sphere. A sphere is a blob; a pad is a
 * plate with an edge. Measured against the limb: the trouser is 48 mm at the knee, so a 34 mm-deep
 * plate whose face sits at z=0.074 stands 26 mm off the front of the leg.
 */
export const SOLDIER_PADS = [
  // `knee` and `elbow` are paired anchor names, so each of these becomes both sides automatically.
  // ---- knee ----
  // Backing plate: the soft tan pad the shell is bonded to, slightly larger all round so it shows as
  // a border. This is the border you can see on a real pad, not decoration.
  { id: 'kneeBacking', anchor: 'knee', type: 'rbox', role: 'fabric', faceBody: true,
    position: [0, 0.006, 0.052], size: [0.132, 0.186, 0.046], bevel: 0.012, corner: 0.040 },
  // Hard shell: narrower, taller-domed, standing proud of the backing.
  { id: 'kneeShell', anchor: 'knee', type: 'rbox', role: 'rubber', faceBody: true,
    position: [0, 0.004, 0.068], size: [0.112, 0.162, 0.044], bevel: 0.016, corner: 0.038 },
  // Raised centre boss — the domed high point every one of these has.
  { id: 'kneeBoss', anchor: 'knee', type: 'rbox', role: 'rubber', faceBody: true,
    position: [0, 0.002, 0.082], size: [0.070, 0.104, 0.028], bevel: 0.012, corner: 0.030 },
  // Side wings: the strap mounts that stand out either side of the shell.
  { id: 'kneeWing', anchor: 'knee', type: 'rbox', role: 'fabric', faceBody: true,
    position: [0.066, 0.004, 0.036], size: [0.030, 0.092, 0.038], bevel: 0.010, corner: 0.014 },
  { id: 'kneeWingL', anchor: 'knee', type: 'rbox', role: 'fabric', faceBody: true,
    position: [-0.066, 0.004, 0.036], size: [0.030, 0.092, 0.038], bevel: 0.010, corner: 0.014 },
  // Straps DO wrap, since a strap genuinely goes all the way round. BLACK and 10 mm proud: as tan
  // webbing 4 mm off an olive trouser they were geometrically present and invisible, the same
  // value-break problem as the collar and cuffs.
  { id: 'kneeStrapUpper', anchor: 'knee', type: 'cylinder', role: 'rubber',
    position: [0, -0.066, 0], size: [0.058, 0.058, 0.024], radial: 16 },
  { id: 'kneeStrapLower', anchor: 'knee', type: 'cylinder', role: 'rubber',
    position: [0, 0.074, 0], size: [0.058, 0.058, 0.024], radial: 16 },

  // ---- elbow: the same assembly at ~0.82 scale ----
  { id: 'elbowBacking', anchor: 'elbow', type: 'rbox', role: 'fabric', faceBody: true,
    position: [0, 0.005, 0.044], size: [0.108, 0.150, 0.040], bevel: 0.010, corner: 0.032 },
  { id: 'elbowShell', anchor: 'elbow', type: 'rbox', role: 'rubber', faceBody: true,
    position: [0, 0.003, 0.058], size: [0.090, 0.130, 0.038], bevel: 0.014, corner: 0.030 },
  { id: 'elbowBoss', anchor: 'elbow', type: 'rbox', role: 'rubber', faceBody: true,
    position: [0, 0.002, 0.070], size: [0.056, 0.082, 0.024], bevel: 0.010, corner: 0.024 },
  { id: 'elbowWing', anchor: 'elbow', type: 'rbox', role: 'fabric', faceBody: true,
    position: [0.054, 0.003, 0.030], size: [0.026, 0.074, 0.032], bevel: 0.008, corner: 0.012 },
  { id: 'elbowWingL', anchor: 'elbow', type: 'rbox', role: 'fabric', faceBody: true,
    position: [-0.054, 0.003, 0.030], size: [0.026, 0.074, 0.032], bevel: 0.008, corner: 0.012 },
  { id: 'elbowStrapUpper', anchor: 'elbow', type: 'cylinder', role: 'rubber',
    position: [0, -0.056, 0], size: [0.053, 0.053, 0.021], radial: 14 },
  { id: 'elbowStrapLower', anchor: 'elbow', type: 'cylinder', role: 'rubber',
    position: [0, 0.062, 0], size: [0.053, 0.053, 0.021], radial: 14 },
];

/**
 * Plate carrier. The torso has a stable front and back (unlike a joint), so this needs none of the
 * faceBody machinery — it can just be placed.
 *
 * Measured against the torso: 193 mm half-width and 127 mm half-depth at the chest, tapering to
 * 147 mm / 97 mm at the waist. The front panel therefore sits at z=0.132 and stands ~40 mm off the
 * chest, and the cummerbund wraps at x=±0.176 where the ribs are 161 mm.
 *
 * The MOLLE rows are what makes it read as a carrier rather than a slab: five thin horizontal bars
 * across the panel. A plain box is body armour from any decade; the webbing grid is specifically
 * modern. Same principle as the boot sole — the STEP does the work, so they sit proud rather than
 * relying on colour.
 */
export const PLATE_CARRIER = [
  // front and back panels
  { id: 'carrierFront', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, 0.040, 0.130], size: [0.300, 0.340, 0.060], bevel: 0.010, corner: 0.022 },
  { id: 'carrierBack', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, 0.040, -0.130], size: [0.300, 0.340, 0.060], bevel: 0.010, corner: 0.022 },
  // SHOULDER STRAPS, cut as a SIDE PROFILE. `axis: 'x'` maps the outline's x onto the body's +Z and
  // extrudes across the width, so the outline below is literally the strap seen from the side —
  // which is what a shoulder strap is: an arc, not a box.
  //
  // Every number is measured off the torso geometry rather than chosen. In this frame (gear space
  // on the torso anchor, where the anchor undoes the z-squash):
  //   torso geometry spans y -0.270 .. 0.317, max half-width 0.193
  //   the arm root sits at x +-0.198, y 0.216; the neck base at y 0.243
  //   at x = 0.105, the torso front surface is z 0.113 at chest height, 0.089 at y 0.272,
  //     and 0.074 at y 0.298 — the shoulder is FALLING AWAY, which is the whole shape of the path
  //   the front panel occupies z 0.100 .. 0.160 with its top edge at y 0.210
  //
  // So the outer edge runs from the panel's front face at (0.142, 0.205), over a crest at y 0.326
  // (9 mm above the torso's own top), down to the back panel at (-0.142, 0.205). The inner edge
  // rides just inside the surface all the way, so the strap is embedded rather than floating.
  // Thickness ~22 mm and width 62 mm: at 32 x 76 it was a yoke rather than a strap.
  //
  // The previous version was a single 310 mm-deep box at y 0.244 — 28 mm longer than the whole torso
  // is deep, and horizontal where the body curves — so it skewered the chest front to back.
  { id: 'carrierStrap', anchor: 'torso', type: 'extrude', role: 'rubber', axis: 'x', smooth: true,
    position: [0.105, 0, 0], depth: 0.062, bevel: 0.005, seg: 2,
    outline: [
      [0.142, 0.205], [0.126, 0.262], [0.084, 0.304], [0.022, 0.326],
      [-0.044, 0.322], [-0.102, 0.294], [-0.134, 0.250], [-0.142, 0.205],
      [-0.118, 0.205], [-0.110, 0.250], [-0.080, 0.288], [-0.018, 0.306],
      [0.042, 0.302], [0.092, 0.272], [0.114, 0.242], [0.118, 0.205],
    ] },
  { id: 'carrierStrapL', anchor: 'torso', type: 'extrude', role: 'rubber', axis: 'x', smooth: true,
    position: [-0.105, 0, 0], depth: 0.062, bevel: 0.005, seg: 2,
    outline: [
      [0.142, 0.205], [0.126, 0.262], [0.084, 0.304], [0.022, 0.326],
      [-0.044, 0.322], [-0.102, 0.294], [-0.134, 0.250], [-0.142, 0.205],
      [-0.118, 0.205], [-0.110, 0.250], [-0.080, 0.288], [-0.018, 0.306],
      [0.042, 0.302], [0.092, 0.272], [0.114, 0.242], [0.118, 0.205],
    ] },
  // cummerbund: the side panels that join front to back at the ribs
  { id: 'carrierSide', anchor: 'torso', type: 'rbox', role: 'fabric',
    position: [0.176, -0.036, 0.000], size: [0.052, 0.150, 0.210], bevel: 0.010, corner: 0.018 },
  { id: 'carrierSideL', anchor: 'torso', type: 'rbox', role: 'fabric',
    position: [-0.176, -0.036, 0.000], size: [0.052, 0.150, 0.210], bevel: 0.010, corner: 0.018 },
  // MOLLE webbing rows
  { id: 'molle1', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, -0.084, 0.163], size: [0.268, 0.020, 0.014], bevel: 0.004 },
  { id: 'molle2', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, -0.030, 0.163], size: [0.268, 0.020, 0.014], bevel: 0.004 },
  { id: 'molle3', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, 0.024, 0.163], size: [0.268, 0.020, 0.014], bevel: 0.004 },
  { id: 'molle4', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, 0.078, 0.163], size: [0.268, 0.020, 0.014], bevel: 0.004 },
  // Name-tape patch, in `accent` — the vivid TEAM-tinted role. A carrier is the natural place to put
  // team identification on a soldier, and it costs nothing extra: the piece has to exist anyway.
  { id: 'carrierPatch', anchor: 'torso', type: 'rbox', role: 'accent',
    position: [0, 0.160, 0.164], size: [0.170, 0.052, 0.012], bevel: 0.003 },
  // centre buckle / admin flap
  { id: 'carrierBuckle', anchor: 'torso', type: 'rbox', role: 'metal',
    position: [0, -0.130, 0.160], size: [0.062, 0.044, 0.016], bevel: 0.004 },
];

/** The clothed human wearing a plate carrier. */
export function withCarrier(design) {
  return { ...design, gear: [...(design.gear || []), ...PLATE_CARRIER] };
}

/**
 * Assault pack. NOT the mech's — `BOT_DESIGN_ADDONS.packLarge` and friends are authored against a
 * 0.360 m-deep armoured chest block and reach z=-0.490, which would leave them hanging 363 mm off
 * the back of a 127 mm-deep human torso.
 *
 * Sized to sit ON the carrier's back panel (whose rear face is at z=-0.160) rather than on the body,
 * because that is how a pack is actually worn over armour. 280 x 360 x 180 mm — a real assault pack
 * is roughly 300 x 450 x 200.
 *
 * No shoulder straps of its own: the carrier's already run over the trapezius and a second pair
 * stacked on them reads as a harness, not a pack.
 */
export const SOLDIER_PACK = [
  { id: 'packBody', anchor: 'torso', type: 'rbox', role: 'cloth',
    position: [0, 0.030, -0.248], size: [0.280, 0.360, 0.180], bevel: 0.016, corner: 0.030 },
  // Top flap, proud of the body so the pack has a lid rather than being one sealed box.
  { id: 'packLid', anchor: 'torso', type: 'rbox', role: 'cloth',
    position: [0, 0.196, -0.244], size: [0.268, 0.086, 0.172], bevel: 0.014, corner: 0.026 },
  // Side pouches: the silhouette break that stops it reading as a suitcase.
  { id: 'packPouch', anchor: 'torso', type: 'rbox', role: 'cloth',
    position: [0.172, -0.026, -0.238], size: [0.078, 0.196, 0.136], bevel: 0.012, corner: 0.020 },
  { id: 'packPouchL', anchor: 'torso', type: 'rbox', role: 'cloth',
    position: [-0.172, -0.026, -0.238], size: [0.078, 0.196, 0.136], bevel: 0.012, corner: 0.020 },
  // Compression straps across the back panel — same MOLLE logic as the carrier: the STEP reads.
  { id: 'packStrap1', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, 0.096, -0.342], size: [0.286, 0.024, 0.016], bevel: 0.004 },
  { id: 'packStrap2', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, -0.040, -0.342], size: [0.286, 0.024, 0.016], bevel: 0.004 },
  // Bedroll lashed across the top, so the pack has a profile above the shoulders.
  { id: 'packRoll', anchor: 'torso', type: 'cylinder', role: 'fabric',
    position: [0, 0.252, -0.240], rotation: [0, 0, Math.PI / 2], size: [0.062, 0.062, 0.250], radial: 14 },
  { id: 'packRollStrap', anchor: 'torso', type: 'rbox', role: 'rubber',
    position: [0, 0.252, -0.240], size: [0.020, 0.136, 0.136], bevel: 0.004 },
];

/** The clothed human wearing an assault pack. */
export function withPack(design) {
  return { ...design, gear: [...(design.gear || []), ...SOLDIER_PACK] };
}

/** The clothed human wearing knee and elbow pads. */
export function withPads(design) {
  return { ...design, gear: [...(design.gear || []), ...SOLDIER_PADS] };
}

// =================================================================================================
// ROLE MARKERS, at human scale.
//
// `BOT_DESIGN_ADDONS` in bot-body-design.js cannot be reused here for the same reason its packs
// cannot: it is authored against the armoured chest block, which is 360 mm deep and 500 mm wide.
// The medic's hip pouches sit at x +-0.235 and its pack cross at z -0.352; on a 385 mm-wide,
// 127 mm-deep human torso those hang in mid-air. So these are re-measured, not scaled.
//
// Every marker below is placed against a SPECIFIC surface, named in its comment. Where that surface
// belongs to a piece of kit rather than the body, the array says so and the composition in
// bot-body-design.js pairs them — a cross on a pack that is not being worn is a floating cross.
// =================================================================================================

// A cross: dark backing plate, then two bars in `eye`, which is one of the UNTINTED roles. A red
// cross that turned red-team red and blue-team blue would stop meaning "medic".
function cross(anchor, [x, y, z], size, axis, sign = 1) {
  const t = size * 0.28, d = size * 0.14, out = sign * d;
  const at = (dx, dy) => (axis === 'x'
    ? [x + out, y + dy, z + dx]
    : [x + dx, y + dy, z + out]);
  const box = (w, h, depth) => (axis === 'x' ? [depth, h, w] : [w, h, depth]);
  return [
    { anchor, type: 'rbox', role: 'rubber', position: at(0, 0), size: box(size, size, d), bevel: d * 0.3 },
    { anchor, type: 'rbox', role: 'eye', position: at(0, 0), size: box(size * 0.82, t, d), bevel: d * 0.2 },
    { anchor, type: 'rbox', role: 'eye', position: at(0, 0), size: box(t, size * 0.82, d), bevel: d * 0.2 },
  ];
}

/**
 * TEAM BRASSARD. Not decoration — without it a soldier is almost untinted: the uniform, hands and
 * face are per-BODY roles (`cloth`/`skin`), the carrier and boots are untinted (`rubber`), and a
 * count of the finished rifleman finds `shell` and `trim` used ZERO times against 46 `rubber`
 * pieces. Team would have come down to the three `plate` pieces on the helmet, which is not
 * something you can read across a firefight.
 *
 * `trim` is the vivid team role and the one `botBodyStyle` in multiplayer.js actually sets
 * (`accent` is not, so the carrier's name tape is the same colour on both teams there).
 *
 * A band wrapped around each carrier strap at its crest. Measured off the strap outline: at
 * y 0.306..0.326 the strap spans z -0.018..0.022 and is 62 mm wide, so 76 x 26 x 50 mm stands proud
 * on both faces — a band goes AROUND a strap, it does not sit on top of one. The crest is 87 mm
 * above the pack lid, so this reads from behind as well as from the front and both sides.
 */
export const SOLDIER_TEAM_BRASSARD = [
  { id: 'brassard', anchor: 'torso', type: 'rbox', role: 'trim',
    position: [0.105, 0.318, 0.002], size: [0.076, 0.026, 0.050], bevel: 0.004 },
  { id: 'brassardL', anchor: 'torso', type: 'rbox', role: 'trim',
    position: [-0.105, 0.318, 0.002], size: [0.076, 0.026, 0.050], bevel: 0.004 },
];

/**
 * MEDIC, carrier-mounted. Needs PLATE_CARRIER: the chest cross sits at z 0.172, which is 12 mm
 * proud of the MOLLE bars at 0.170 — i.e. it is a patch worn OVER the webbing — and the side
 * crosses sit on the cummerbund faces at x +-0.202. Without the carrier all three float.
 */
export const SOLDIER_MEDIC_MARKS = [
  ...cross('torso', [-0.088, 0.000, 0.166], 0.090, 'z', 1),
  ...cross('torso', [0.196, -0.036, 0.000], 0.078, 'x', 1),
  ...cross('torso', [-0.196, -0.036, 0.000], 0.078, 'x', -1),
];

/**
 * MEDIC, pack-mounted. Needs SOLDIER_PACK. The pack's rear face is at z -0.338 and its two
 * compression straps stand proud to -0.350 at y 0.096 and y -0.040, leaving a 112 mm window
 * between their inner edges — so the cross is 108 mm, centred at y 0.028, and clears both.
 */
export const SOLDIER_PACK_CROSS = [...cross('torso', [0, 0.028, -0.344], 0.108, 'z', -1)];

/**
 * SQUAD LEADER radio mast. Needs SOLDIER_PACK: it rises out of the left side pouch, whose top is at
 * y 0.072 and whose x-span is -0.133..-0.211. Rooted at y 0.070 so it emerges from the pouch rather
 * than starting in free air beside it.
 */
export const SOLDIER_ANTENNA = [
  { anchor: 'torso', type: 'cylinder', role: 'metal',
    position: [-0.160, 0.345, -0.300], size: [0.007, 0.007, 0.550], radial: 8 },
  // Mast light in `accent`, not `eye`. `eye` is an untinted role driven by the theme's eyeColor, so
  // the beacon came out the same colour on both sides — a team marker that does not mark a team.
  // `accent` takes the per-instance tint, which is where the team colour lives.
  { anchor: 'torso', type: 'sphere', role: 'accent', position: [-0.160, 0.628, -0.300], size: [0.015] },
];

/**
 * TECHNICAL launcher rack. Needs SOLDIER_PACK — it clamps BEHIND the pack, whose rear straps reach
 * z -0.350, so the tubes sit at z -0.395 and never intersect it. Tubes are 88 mm across and 440 mm
 * long against the armour version's 116 x 560: a mech-sized tube on a human reads as a drainpipe.
 */
const TUBE_TILT = 0.22;
export const SOLDIER_TUBES = [0.075, 0.185].flatMap((x) => [
  { anchor: 'torso', type: 'cylinder', role: 'metal', position: [x, 0.140, -0.395],
    rotation: [TUBE_TILT, 0, 0], size: [0.044, 0.044, 0.440], radial: 14 },
  // Muzzle ring and warhead at the tube's own top END, not at a typed-in height: the axis after a
  // 0.22 rad x-rotation is (0, 0.976, 0.218), so the end is 215 mm up AND 48 mm forward of centre.
  { anchor: 'torso', type: 'cylinder', role: 'rubber', position: [x, 0.3547, -0.3470],
    rotation: [TUBE_TILT, 0, 0], size: [0.050, 0.050, 0.026], radial: 14 },
  { anchor: 'torso', type: 'cone', role: 'accent', position: [x, 0.3762, -0.3422],
    rotation: [TUBE_TILT, 0, 0], size: [0.038, 0.056], radial: 14 },
]).concat([
  { anchor: 'torso', type: 'rbox', role: 'plate', position: [0.130, 0.100, -0.400],
    rotation: [TUBE_TILT, 0, 0], size: [0.220, 0.046, 0.130], bevel: 0.008 },
]);

/**
 * The clothed human body. Head comes from the head axis (composeBot), so nothing here touches
 * headProfile — this is strictly neck-down.
 */
export const HUMAN_BODY_DESIGN = Object.freeze({
  // Human proportions rather than the mech's. Legs are ~47% of standing height in an adult, and the
  // rig's 0.62 is a heroic-mech number that makes everything above the waist look stunted.
  // CONSTRAINED, not chosen. The pelvis is placed at `gait.pelvisHeightRatio * H` = 0.58 * 1.8 =
  // 1.044 m no matter what this says, so the leg chain must be LONGER than that with bend room or
  // the feet cannot reach the ground. Anthropometric canon suggested 0.53 and I used it: that is
  // 90 mm short, so the legs ran dead straight and over-extended, which is why the measured hip sat
  // below where canon put it. 1.233x scaling later pushed it to 0.653 — 132 mm of slack, a permanent
  // squat. 0.62 is the rig default and leaves the documented ~72 mm of bend.
  legLenRatio: LEG_LEN_RATIO,
  thighFrac: THIGH_FRAC, shinFrac: SHIN_FRAC,
  // ARMS WERE 22% TOO LONG — upper arm 0.412 against a canon 0.364, forearm 0.380 against 0.286.
  // The forearm was the worse offender at 33% over, which is the specific thing that reads as ape
  // arms: it is the segment a viewer measures against the torso. Canon is upper 0.186 H and forearm
  // 0.146 H, so the split shifts toward the upper arm as well as the whole limb shortening.
  armLenRatio: ARM_LEN_RATIO, upperArmFrac: UPPER_ARM_FRAC, forearmFrac: FOREARM_FRAC,
  limbThicknessRatio: LIMB_THICK_RATIO,
  armThickScale: 0.84,

  thighProfile: TROUSER_THIGH_PROFILE,
  shinProfile: TROUSER_SHIN_PROFILE,
  upperArmProfile: SLEEVE_UPPER_PROFILE,
  forearmProfile: SLEEVE_FOREARM_PROFILE,

  // At the mech's sizes the joint spheres are wider than the limb around them and everything reads
  // as ball-jointed tubing. Knee/elbow spheres read as the fabric bunching at the bend, so they are not shrunk as hard
  // as bare joints would be; the ankle stays small because the boot covers it.
  // Knee ball measured at 116 mm against a 112 mm calf and a 98 mm trouser knee — the joint was the
  // WIDEST thing in the lower leg, so it bridged thigh to shin and flattened both profiles into one
  // taper. Under trousers a knee is not visible at all: the ball only has to fill the bend, so it
  // now sits well inside the fabric.
  // Hip balls shrunk again: at 0.46 the two spheres met under the pelvis and the pair read as a
  // hanging sack between the thighs. A hip is the top of the leg, not a bead beside it.
  // Ankle ball down to 0.16: at 0.30 it measured 67 mm and, with the boot biased forward, it bulged
  // out through the BACK of the boot as an olive blister. Anything at ankle height is inside a boot.
  hipJoint: 0.38, kneeJoint: 0.36, ankleJoint: 0.16,
  // Shoulder ball measured 105 mm against a 98 mm sleeve — it was OUTSIDE the sleeve, so it read as
  // a pad or a patch of bare skin at the cap. A joint sphere must always sit inside its limb.
  shoulderJoint: 0.48, elbowJoint: 0.32, wristJoint: 0.22,

  // A monotonic TAPER from chest to waist, not a bulge with a pinch in it. Round-round-pinch reads
  // as a sack with a rubber band round it; a trapezoid reads as a ribcage over a waist.
  //
  // CHEST WIDENED to meet the shoulders. The arm roots attach at `state.radius * 0.66` = 198 mm from
  // the centreline — a number this design cannot see, since it comes from the CAPSULE radius, not
  // the rig's R — while the chest was only 144 mm. The arms hung 55 mm clear of the torso on each
  // side and the shoulder spheres floated off a narrow body. Chest is now 193 mm, just inside the
  // attachment point, with chest:waist at 1.67 for a real V.
  // WAIST widened 231 -> 294 mm. Chest:waist was 1.67, which is a comic-book V, not a soldier —
  // real athletic is ~1.3. A waist that narrow also left a visible pinch where the torso met the
  // pelvis, since the hips below were narrower still.
  torsoProfile: [
    [0.38, -0.150], [0.40, -0.126], [0.42, -0.096], [0.46, -0.040],
    [0.51, 0.024], [0.54, 0.086], [0.55, 0.132], [0.46, 0.162], [0.26, 0.176],
  ],
  torsoRadial: 26, torsoZScale: 0.66,
  // NARROWED HARD (0.40 -> 0.30) and flattened (zScale 0.74 -> 0.60). At the old size the pelvis was
  // nearly as wide as the chest and DEEPER than it, so it bulged forward as its own rounded lump
  // between shirt and trousers and read as a nappy. The hip must never out-measure the belt that is
  // supposed to be capping it.
  // Bottom pulled in hard (0.13 -> 0.07) so the profile drops away STEEPLY above the leg fork. A
  // shallow curve there balloons volume exactly where the legs separate, which is the diaper.
  // SHORTENED at the bottom (-0.086 -> -0.048). Length, not width, was the fused-wedge cause: the
  // legs hang 252 mm apart, so a pelvis cone that keeps descending BETWEEN them fills the fork and
  // the hips read as one mass with legs bolted on. Ending it above the fork lets the gap open.
  // HIPS widened 224 -> 336 mm. The thighs hang 252 mm apart and are 154 mm across, so they span
  // 407 mm — the pelvis was 1.82x NARROWER than the legs it sits on, which is the pinch. The bottom
  // point stays tight (126 mm) so the fork still opens between the thighs rather than filling in.
  pelvisProfile: [[0.18, -0.048], [0.34, -0.030], [0.48, 0.004], [0.46, 0.052], [0.34, 0.090]],
  pelvisRadial: 22, pelvisZScale: 0.60,
  // Bridges the torso bottom (0.38) to the pelvis top (0.34). At 0.22/0.26 it was a 154 mm pipe
  // between a 385 mm chest and 407 mm of thigh.
  waist: { rTop: 0.38, rBot: 0.36, h: 0.056, radial: 18, zScale: 0.74 },
  // Lengthening this to 0.082 fixed the bobblehead and then OVERSHOT: chin-to-shoulder measured
  // 137 mm against a canon 98 mm, 40% over. A long neck with low shoulders is most of why the upper
  // body read as short — the torso itself measures correctly. 0.056 lands on canon.
  neck: { rTop: 0.12, rBot: 0.15, h: 0.056, radial: 18, zScale: 0.88 },
  // The head is DROPPED onto the shorter neck. Shrinking neck.h alone did nothing to the gap,
  // because the rig placed the head at a fixed fraction of height regardless — chin-to-shoulder
  // stayed at 137 mm however short the neck cylinder got. 0.459 lands it on the canon 98 mm.
  torsoYRatio: 0.22, neckYRatio: 0.355, headYRatio: 0.459,

  // Smooth everything: a draped profile resampled to 12 bands is a stack of cones.
  profileSmooth: 40,
  outlineSmooth: true,
  limbRadial: 20,
  jointRadial: 14, jointSeg: 10,

  // MEASURED: the boot was 215 x 112 x 143 mm on a 1.8 m figure. A foot is about 0.15 of standing
  // height, so 215 mm is barely three quarters of one — that shortness is the clog read, and no
  // profile work rescues a boot that is simply too small. Now 264 x 105 x 190 mm.
  footShape: 'boot', footSegments: 2, footForwardBias: 0.34,
  footScale: FOOT_SCALE,
  // The rig default puts its tallest point at the BACK, which gives a lumpy heel hump and no ankle
  // collar. A combat boot is the other way round: a flat sole running the full length, a collar
  // topping out just behind the ankle, then a long slope down the instep to a low toe box.
  // A boot is a SHAFT plus a FOOT, and one extruded outline cannot be both: levelling the collar to
  // close the front gap turned the whole rear two thirds into a full-height block and it read as a
  // ski boot. So this profile is only the FOOT — long, low, with a modest collar — and the shaft is
  // a separate cylinder in the gear list, where its height and diameter are controlled independently.
  footProfile: [
    [-0.90, 0.00], [-0.99, 0.14], [-0.95, 0.52], [-0.66, 0.76], [-0.20, 0.80],
    [0.10, 0.62], [0.40, 0.44], [0.70, 0.34], [1.00, 0.16], [0.94, 0.00],
  ],
  // Hand pushed clear of the wrist. Centred, 87 mm of it sat back up the forearm — which is why the
  // sleeve cuff kept landing on the back of the hand however far up the arm it was moved.
  handShape: 'glove', handFingerAxis: -1, handPalmFacing: 'x', handThickness: 0.22,
  handWristBias: -0.62,
  handSegments: 2,
  // MEASURED at 47 x 168 x 126 mm — a real hand is about 190 x 88 x 30, so this was 40% too wide
  // and 55% too thick and read as a mitten. The outline is the mech's, narrowed to 0.78 across;
  // handThickness comes down with it. Length was already right.
  handOutline: [
    [-0.234, -0.70], [0.234, -0.70], [0.328, -0.34], [0.499, -0.04], [0.296, 0.12],
    [0.265, 0.38], [0.218, 0.64], [-0.234, 0.60], [-0.281, 0.16],
  ],

  // `cloth`, not `shell`. Both are per-body tinted, but shell carries the armour's emissive gain —
  // at that gain a pale uniform blew out to flat glowing mint and read as spandex, and a blown-out
  // surface has no shading, so the limb profiles underneath were invisible whatever they were.
  roles: {
    limb: 'cloth', joint: 'cloth', torso: 'cloth', pelvis: 'cloth', waist: 'cloth',
    // Boots are `rubber` — untinted near-black. As team-tinted `plate` they sat close in value to the
    // trousers, so the blouse had a shape change but no colour break and the transition vanished.
    neck: 'skin', hand: 'skin', foot: 'rubber', head: 'skin',
  },

  // GARMENT EDGES. The critique could not find a single one — no waistband, no cuff, no hem — which
  // is why the figure read as a one-piece coverall rather than a shirt and trousers. A garment is
  // legible at its BOUNDARIES, and none of these are expressible in a surface of revolution, so
  // they have to be separate pieces.
  gear: [
    // belt + buckle: the waist/hip break that separates shirt from trousers
    // Belt radius 0.108 against a 0.105 hip: it has to be the WIDEST thing at that height or it
    // reads as a strap slung across the top of the thigh instead of the shirt/trouser seam.
    { id: 'belt', anchor: 'waist', type: 'cylinder', role: 'rubber',
      position: [0, -0.014, 0], size: [0.153, 0.153, 0.040], radial: 20, scale: [1, 1, 0.68] },
    { id: 'buckle', anchor: 'waist', type: 'rbox', role: 'metal',
      position: [0, -0.014, 0.104], size: [0.048, 0.034, 0.014], bevel: 0.003 },
    // Placed against the MEASURED boot top, not guessed. The boot stands 181 mm above the ankle, so
    // the cuff belongs 0.252 down the shin from the knee. The previous set sat at 0.392-0.450 — at
    // or BELOW the ankle — so every piece was buried inside the boot shell, and what showed through
    // was the "bracelet" ring and the lumpy heel.
    // Wider at the BOTTOM (0.078 over 0.070): fabric gathers outward as it folds down over a boot.
    // NOTE THE SIGN: knee-anchor +Y runs DOWN the shin, so a LARGER y is LOWER. Chasing the front
    // gap by increasing y buried the cuff in the boot again. The gap was the boot's fault — its
    // collar was high at the heel and low at the instep — so the collar was levelled instead.
    // The shaft: the leather tube between the foot and the trouser blouse. Slightly tapered, so it
    // is not a plain pipe, and it OVERLAPS both neighbours rather than butting against them.
    { id: 'bootShaft', anchor: 'knee', type: 'cylinder', role: 'rubber',
      position: [0, r4(BOOT_TOP - 0.045), 0], size: [0.064, 0.070, 0.108], radial: 18 },
    { id: 'bootCuff', anchor: 'knee', type: 'cylinder', role: 'cloth',
      position: [0, r4(BOOT_TOP - 0.086), 0], size: [0.070, 0.080, 0.064], radial: 18 },
    { id: 'bootCuffLip', anchor: 'knee', type: 'cylinder', role: 'rubber',
      position: [0, r4(BOOT_TOP - 0.058), 0], size: [0.081, 0.081, 0.016], radial: 18 },
    // SOLE. Without one the boot is a single smooth black volume and reads as a wellington. Measured
    // against the foot mesh's own bounds in true metres (x +-0.053, y -0.007..0.132, z -0.087..0.177):
    // it sits at the bottom, PROUD in x and z so it steps out past the upper all the way round, which
    // is what a welt does. Kept `rubber` — the same black as the upper — because the separation has
    // to come from the STEP, not from colour: any lighter role here is team-tinted, so a red team
    // would get red soles, and a light patch on near-black hardware reads as a hole punched in it.
    { id: 'bootSole', anchor: 'foot', type: 'rbox', role: 'rubber',
      position: [0, 0.008, 0.044], size: [0.112, 0.026, 0.258], bevel: 0.005, corner: 0.020 },
    // heel block: a boot heel is thicker than its forefoot, and that step is most of what says boot
    { id: 'bootHeel', anchor: 'foot', type: 'rbox', role: 'rubber',
      position: [0, 0.002, -0.048], size: [0.106, 0.036, 0.074], bevel: 0.005, corner: 0.014 },
    // bootMouth and laceHood are GONE. The mouth duplicated a collar the boot profile now has, and
    // the lace hood was `plate` — a team-tinted LIGHT role — so on a near-black boot it read as a
    // bright wedge punched into the toe. A detail on dark hardware has to be dark.
    // sleeve cuff at the wrist. Forearm is 0.380 from the elbow anchor.
    // Cuff and collar are `rubber`, not `cloth`. As the same material as the shirt they were
    // geometrically present and visually absent — an edge is a VALUE break, not a bump.
    // 30 mm SHORT of the wrist. At a literal 0.322 this sat past it, on the back of the hand.
    { id: 'sleeveCuff', anchor: 'elbow', type: 'cylinder', role: 'rubber',
      position: [0, r4(WRIST - 0.046), 0], size: [0.048, 0.043, 0.030], radial: 16 },
    // shirt hem: where the shirt stops over the trousers, just above the belt
    { id: 'shirtHem', anchor: 'waist', type: 'cylinder', role: 'cloth',
      position: [0, 0.010, 0], size: [0.150, 0.156, 0.026], radial: 20, scale: [1, 1, 0.76] },
    // collar, so the neck has an edge instead of skin fading into uniform
    // Collar dropped and shrunk so a band of bare throat shows ABOVE it. Sized up around the neck it
    // simply hid the neck, which is what produced the bobblehead read.
    { id: 'collar', anchor: 'neck', type: 'cylinder', role: 'rubber',
      position: [0, -0.048, 0], size: [0.062, 0.076, 0.030], radial: 18, scale: [1, 1, 0.88] },
  ],
});
