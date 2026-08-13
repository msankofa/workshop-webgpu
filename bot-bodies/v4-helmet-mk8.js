// bot-bodies/v4-helmet-mk8.js — FROZEN HISTORICAL BODY: v4 — helmet mk8 (2026-07-31 11:55)
//
// The Mark VIII helmet. Snapshot taken before the upper-body pass that produced the current chest,
// collar and pack layering.
//
// Do not edit. This is a fixed point in the design's history, kept so the studio can put every
// iteration side by side (see bot-body-versions.js). Copied out of versions/ deliberately:
// versions/ is a manual undo history and must not become an import path.
//
//
// The bots' appearance spec — the `design` option passed to createProceduralPlayerBody
// (player-procedural-body.js), overriding BODY_DESIGN_DEFAULTS. Authored in
// bot-design-studio.html; iterate there, then update this file with the winner.
//
// TARGET: an armoured combat mech — heavy angular plate over a slim inner chassis, in the vein of
// the reference the design was art-directed against (dark matte armour, oversized boxy pauldrons,
// layered thigh/shin plates, a fully enclosed helmet with small glowing eyes).
//
// THREE RULES this spec is built on, each learned by shipping the bug first:
//
// 1. GEAR MUST EXCEED THE PART IT DECORATES, or it renders inside the solid part and is invisible.
//    A 0.34 m chest block inside a 0.52 m torso showed up as nothing but a colour patch. The torso
//    lathe is therefore a NARROW inner chassis (~0.27 m) and the armour is the widest thing on the
//    body — the silhouette belongs to the plate, not the frame.
//
// 2. NEVER LEAVE A BARE CHASSIS CYLINDER BETWEEN TWO ARMOUR MASSES. Exposed neck, waist and
//    mid-thigh bands each read as "unfinished mannequin" and got worse as their neighbours grew.
//    Plates must MEET: the thigh plate runs the full femur to the knee block, the gorget bridges
//    helmet to chest, the waist plate bridges chest to pelvis.
//
// 3. LIMB-JOINT FRAMES CARRY AN ARBITRARY ROLL. placeSegment builds them with setFromUnitVectors,
//    so only their +Y (down the bone toward the child joint) is meaningful — an "outward" X offset
//    on a shoulder joint does NOT reliably point outward. Big silhouette masses that need a stable
//    left/right/forward frame (the pauldrons) hang off the TORSO, which is stable. Joint anchors
//    are used only for pieces that are symmetric about the bone (thigh/shin/vambrace sleeves).

// ==============================================================================================
// HELMETS
//
// Art-directed against Halo/Destiny-style helmet sheets. The design language those share, and
// which the previous "smooth enclosing dome with two dot eyes" had none of:
//
//   1. THE VISOR IS THE HERO. One large dark/reflective band wrapping the front, not two lenses.
//   2. It sits in a RAISED FRAME — a brow ridge above and a cheek/jaw rail below, so the visor
//      reads as inset hardware rather than paint.
//   3. A CENTRAL CREST runs front-to-back over the crown (the orange spine on the Rakshasa).
//   4. Side housings are FLUSH angular plates, never protruding cylinders — round ear pods read
//      as cartoon ears, which is exactly what the previous head did.
//   5. A separate MANDIBLE volume under the visor.
//   6. Hard facets: low radial counts on the dome, chamfered plates over it.
//
// GEOMETRY CONSTRAINT that broke this twice already: the head's own gear anchor undoes the head
// part's scale, so helmet pieces are in TRUE METRES — but the EYES are direct children of `head`
// and therefore shrink by headZScale (0.88). The skull shell's front face sits at z=0.116, so
// anything meant to be seen must clear that, and eye z must clear 0.116/0.88 = 0.132 before its
// own depth is added. Every z below is chosen against that number.
// ==============================================================================================

// Mark VII: the default. Wraparound glowing visor, crest, flush ear plates, mandible.
const HELMET_MARK_VII = [
  // faceted skull shell — the CROWN must own most of the mass; the visor is a slim insert.
  { anchor: 'head', type: 'lathe', role: 'shell',
    profile: [[0.030, -0.150], [0.082, -0.136], [0.104, -0.100], [0.114, -0.030],
      [0.118, 0.020], [0.110, 0.066], [0.090, 0.100], [0.056, 0.122], [0.018, 0.130]], radial: 14 },
  // crown cap in SHELL, not plate: the helmet has to read as ONE continuous mass. When the crown
  // was near-black plate it became a dark void behind a light brow, and the head read as a
  // separate cap sitting on a separate face.
  { anchor: 'head', type: 'lathe', role: 'shell',
    profile: [[0.106, 0.056], [0.114, 0.078], [0.098, 0.106], [0.062, 0.128], [0.020, 0.136]], radial: 14 },
  // ONE low centreline crest in gunmetal. Was team-accent green, which read as a shoulder part
  // stuck on a head; a crest is structure, not livery.
  // Sits ABOVE the dome. At y=0.124 the dome's own radius already exceeded the crest, so all but
  // its front and back tips were buried inside the skull — which is why it read as a nub/antenna
  // stub rather than a ridge. Bottom 0.125 merges into the dome, top 0.159 clears it by 23mm.
  // Lower and longer than the first attempt: at 0.034 tall over a 0.170 run it stood up off the
  // crown like a periscope. A crest reads as a crest only when it is long relative to its height.
  { anchor: 'head', type: 'rbox', role: 'metal', position: [0, 0.134, -0.010], size: [0.026, 0.022, 0.206], bevel: 0.005 },

  // ---- THE VISOR IS THE FACE ----------------------------------------------------------------
  // One uninterrupted glowing band, ±0.104 against a 0.118 skull, so it spans nearly the full
  // width. Nothing is allowed to cross or flank it: the previous cheek rails sat at the visor's
  // own depth and below its centreline, which read as fangs around a mouth.
  // y -0.010..0.058, front face z=0.133 (skull front is 0.118).
  //
  // DARK SOCKET first: 6% larger outline, 8mm further back, so a dark rim shows all the way
  // around the glass. Without it the visor met the shell as a pure colour boundary with no
  // occlusion break, which is what made it read as tape stuck on rather than a window cut in.
  { anchor: 'head', type: 'extrude', role: 'rubber', smooth: false, position: [0, 0.024, 0.096], depth: 0.050, bevel: 0.004, seg: 1,
    outline: [[-0.113, 0.038], [-0.107, -0.014], [-0.076, -0.038], [0.076, -0.038], [0.107, -0.014], [0.113, 0.038]] },
  // the glass: hard-edged, WIDER AT TOP (±0.106) tapering to ±0.070 at the chin. Was an rbox,
  // whose corner rounding plus the wing seams gave the scalloped multi-lobed blob silhouette.
  { anchor: 'head', type: 'extrude', role: 'visor', smooth: false, position: [0, 0.024, 0.104], depth: 0.050, bevel: 0.004, seg: 1,
    outline: [[-0.106, 0.030], [-0.100, -0.008], [-0.070, -0.030], [0.070, -0.030], [0.100, -0.008], [0.106, 0.030]] },
  // NO separate wraparound wings. Rotated side panels sat behind the flat glass front, and the
  // dark socket showing through that gap made two downward-curling wedges at the visor's lower
  // corners — which read as a waxed moustache. Three rounds of critique never once read them as
  // wraparound, so the shape was paying a comic-read cost for nothing.
  // hard shadow gutter along the brow/visor seam — the hooding was geometrically there but cast
  // no shadow, so the overhang was invisible. This is that shadow, modelled.
  { anchor: 'head', type: 'rbox', role: 'rubber', position: [0, 0.056, 0.112], size: [0.212, 0.016, 0.044], bevel: 0.004 },

  // BROW hoods the visor: front face z=0.141 (11mm PROUD of the visor) and its lower edge
  // overlaps the visor top by 10mm. The old one was 3mm apart in z — coplanar, so it just
  // intersected the visor instead of shading it.
  // Top edge pulled down (0.024 -> 0.004) so the brow is a RIDGE, not a roof. At the old height its
  // top face was a 0.224 x 0.070 horizontal plane sitting 22mm below the dome crown, and that
  // ledge is what made the dome read as a separate cap plopped on a head.
  // Depth 0.058 -> 0.032: at full depth its top face was a 0.224 x 0.070 flat plane projecting off
  // the dome, which read as a mortarboard brim. It only needs to clear the visor, not shelf over it.
  { anchor: 'head', type: 'extrude', role: 'shell', smooth: false, position: [0, 0.082, 0.114], depth: 0.032, bevel: 0.006, seg: 1,
  // Bottom edge FLAT. Dipping it at the centre (-0.030 mid vs -0.014 at the ends) left triangular
  // gaps at the outer corners where the dark gutter showed through, and those two dark wedges
  // above the visor read as angry eyebrows.
    outline: [[-0.112, -0.026], [0.112, -0.026], [0.100, 0.004], [-0.100, 0.004]] },

  // MANDIBLE: TAPERS toward the chin (±0.072 at the top, ±0.052 at the bottom) so the lower head
  // is a teardrop, not a cube. A flat-sided box here was most of the "stacked slabs" read.
  // Narrower than the visor's bottom edge so the glass overhangs it; 3mm proud in z.
  { anchor: 'head', type: 'extrude', role: 'shell', smooth: false, position: [0, -0.042, 0.080], depth: 0.092, bevel: 0.010, seg: 1,
    outline: [[-0.072, 0.034], [0.072, 0.034], [0.052, -0.030], [-0.052, -0.030]] },
  // breather as a WIDE SLIM vent in plate, not a small black block: a centred black rectangle on
  // a tapering chin read as a soul patch. Wide + shallow + closer to shell value reads mechanical.
  // breather: METAL, not plate. In plate it was near-isovalue with the olive shell and read as a
  // stray scratch. Three stacked louvers over a dark recess so it reads as a vent at any distance.
  // Vent kept NARROW (0.052, a quarter of face width) and dark. At 0.092 wide in pale metal the
  // three louvers spanned most of the jaw and read as a grinning grille of teeth — a centred
  // horizontal bar array directly under a visor is a mouth to the eye, whatever it is to the spec.
  { anchor: 'head', type: 'rbox', role: 'rubber', position: [0, -0.046, 0.120], size: [0.060, 0.034, 0.020], bevel: 0.003 },
  // louvers in PLATE (dark), not pale metal: bright horizontal bars centred under a visor read as
  // teeth no matter how narrow they get. Dark-on-dark inside a recess reads as a vent.
  { anchor: 'head', type: 'rbox', role: 'plate', position: [0, -0.036, 0.130], size: [0.052, 0.006, 0.014], bevel: 0.002 },
  { anchor: 'head', type: 'rbox', role: 'plate', position: [0, -0.046, 0.130], size: [0.052, 0.006, 0.014], bevel: 0.002 },
  { anchor: 'head', type: 'rbox', role: 'plate', position: [0, -0.056, 0.130], size: [0.052, 0.006, 0.014], bevel: 0.002 },
  // one more plate seam low on the jaw so the lower shell isn't a single unbroken mass
  { anchor: 'head', type: 'rbox', role: 'rubber', position: [0, -0.082, 0.104], size: [0.070, 0.008, 0.018], bevel: 0.002 },

  // SIDE plates sit at TEMPLE height only (y -0.035..0.055). They previously ran down to y=-0.059
  // and gave the lower head flat vertical slab sides, fighting the chin taper above.
  // Must also clear the 0.118 skull radius to exist at all.
  { anchor: 'head', type: 'rbox', role: 'shell', position: [0.112, 0.010, 0.010], size: [0.030, 0.090, 0.126], bevel: 0.008 },
  { anchor: 'head', type: 'rbox', role: 'shell', position: [-0.112, 0.010, 0.010], size: [0.030, 0.090, 0.126], bevel: 0.008 },
  // DARK rail, not metal: as pale gunmetal this read as a flashlight or hearing aid bolted on.
  // Dark reads as a recessed seam in the plate, which is what it is.
  { anchor: 'head', type: 'rbox', role: 'rubber', position: [0.128, 0.010, 0.030], size: [0.014, 0.052, 0.026], bevel: 0.004 },
  { anchor: 'head', type: 'rbox', role: 'rubber', position: [-0.128, 0.010, 0.030], size: [0.014, 0.052, 0.026], bevel: 0.004 },

  // rear vents, low profile, no spikes
  { anchor: 'head', type: 'rbox', role: 'plate', position: [0.046, 0.046, -0.114], size: [0.018, 0.052, 0.052], rotation: [0.25, 0, 0], bevel: 0.004 },
  { anchor: 'head', type: 'rbox', role: 'plate', position: [-0.046, 0.046, -0.114], size: [0.018, 0.052, 0.052], rotation: [0.25, 0, 0], bevel: 0.004 },
];

export const BOT_BODY_DESIGN = Object.freeze({
  // ---- inner chassis: deliberately slim, since the armour carries the silhouette (rule 1) ----
  torsoProfile: [
    [0.20, -0.148], [0.28, -0.128], [0.33, -0.112], [0.37, -0.020],
    [0.385, 0.048], [0.39, 0.086], [0.36, 0.122], [0.30, 0.146], [0.20, 0.158],
  ],
  torsoRadial: 28, torsoZScale: 0.86,
  pelvisProfile: [[0.16, -0.090], [0.40, -0.078], [0.50, -0.016], [0.44, 0.060], [0.24, 0.092]],
  pelvisRadial: 24,
  waist: { rTop: 0.20, rBot: 0.24, h: 0.048, radial: 14, zScale: 0.80 },
  neck: { rTop: 0.24, rBot: 0.28, h: 0.030, radial: 20, zScale: 0.90 },
  // Head is a small inner skull; the helmet gear below is what is actually seen.
  headProfile: [
    [0.07, -0.068], [0.17, -0.062], [0.22, -0.048], [0.24, -0.018],
    [0.245, 0.006], [0.23, 0.028], [0.19, 0.046], [0.12, 0.058], [0.04, 0.062],
  ],
  headRadial: 26, headZScale: 0.88,
  // Small recessed lenses. They sit PROUD of the 0.076 m face surface or they vanish inside it.
  // TRAP: eyes are children of `head`, so headZScale (0.88) shrinks their z — but gear hangs off an
  // inverse-scale anchor and stays in TRUE METRES. The helmet's 0.116 m front therefore swallowed
  // eyes authored at 0.088 (=0.077 after scaling). Front face here = z*0.88 + depth = 0.127 > 0.116.
  // The VISOR (helmet gear, role 'eye') is the face now, so the rig's own eye spheres are pulled
  // inside the shell deliberately — two dots poking through a visor band looked like a bug.
  eye: { width: 0.001, length: 0.001, depth: 0.001, y: 0.000, z: 0.0, spacing: 0.0 },
  limbThicknessRatio: 0.34,
  // Joint balls are shrunk so the armour sleeves over them overhang instead of being swallowed.
  shoulderJoint: 0.45, elbowJoint: 0.34, wristJoint: 0.26, ankleJoint: 0.50,
  footScale: [0.62, 0.52, 1.20],

  // ---- material roles ----
  // Team tint lives on shell/plate/trim/accent; metal and rubber are untinted so they read as
  // hardware. Armour is `plate` (dark) with `metal` seams — the reference is dark matte, not
  // colour-blocked, so team colour survives only on the inner chassis peeking through at joints.
  roles: { head: 'shell', hand: 'plate', foot: 'shell', waist: 'rubber', joint: 'rubber' },

  // ---- tessellation ----
  // Lathe profiles interpolate LINEARLY between control points, so radial counts alone leave the
  // vertical silhouette faceted; profileSmooth resamples every profile through a spline.
  profileSmooth: 36,
  outlineSmooth: true,
  jointRadial: 14, jointSeg: 10,
  eyeRadial: 16, eyeSeg: 10,
  limbRadial: 18,
  limbProfile: [
    [0.10, -0.500], [0.62, -0.470], [0.86, -0.420], [0.94, -0.300], [0.88, -0.170],
    [0.80, -0.020], [0.88, 0.130], [0.95, 0.280], [0.86, 0.420], [0.60, 0.470], [0.10, 0.500],
  ],

  footShape: 'boot',
  footSegments: 2,
  // Ankle sits ~26% back along the boot rather than dead centre. Centred, the foot trailed the leg
  // as far as it led it and read as pointing backwards.
  footForwardBias: 0.48,
  handShape: 'glove',
  handFingerAxis: -1,
  handPalmFacing: 'x',
  handThickness: 0.34,
  handSegments: 2,
  handOutline: [
    [-0.30, -0.70], [0.30, -0.70], [0.42, -0.34], [0.64, -0.04], [0.38, 0.12],
    [0.34, 0.38], [0.28, 0.64], [-0.30, 0.60], [-0.36, 0.16],
  ],

  gear: [
    // =========================== HELMET (see HELMETS below) ====================================
    ...HELMET_MARK_VII,

    // team-identification markers: small, vivid `accent` pieces. The armour itself is desaturated.
    { anchor: 'torso', type: 'rbox', role: 'accent', position: [0.262, 0.150, 0.175], size: [0.230, 0.070, 0.030] },
    { anchor: 'torso', type: 'rbox', role: 'accent', position: [-0.262, 0.150, 0.175], size: [0.230, 0.070, 0.030] },

    // ================= gorget: bridges helmet to chest so no bare neck shows (rule 2) ===========
    { anchor: 'neck', type: 'rbox', role: 'shell', position: [0, 0.010, 0], size: [0.255, 0.210, 0.250] },
    { anchor: 'neck', type: 'rbox', role: 'metal', position: [0, -0.080, 0.010], size: [0.235, 0.032, 0.235] },

    // ================= chest: 0.42 wide x 0.36 deep over a 0.27 chassis (rule 1) ================
    { anchor: 'torso', type: 'rbox', role: 'shell', position: [0, 0.050, 0.020], size: [0.420, 0.300, 0.360] },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0, 0.185, 0.020], size: [0.350, 0.055, 0.350] },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0, 0.040, 0.196], size: [0.290, 0.016, 0.030] },
    { anchor: 'torso', type: 'sphere', role: 'eye', position: [0.140, 0.130, 0.190], size: [0.014] },
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [0, -0.085, 0], size: [0.340, 0.120, 0.290] },

    // ===== pauldrons: the widest, most forward masses. TORSO-anchored for a stable frame (rule 3)
    { anchor: 'torso', type: 'rbox', role: 'shell', position: [0.255, 0.150, 0.015], size: [0.250, 0.235, 0.300] },
    { anchor: 'torso', type: 'rbox', role: 'shell', position: [-0.255, 0.150, 0.015], size: [0.250, 0.235, 0.300] },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0.268, 0.028, 0.015], size: [0.215, 0.055, 0.255] },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [-0.268, 0.028, 0.015], size: [0.215, 0.055, 0.255] },

    // ================= waist: bridges chest to pelvis (rule 2) ==================================
    { anchor: 'waist', type: 'rbox', role: 'shell', position: [0, 0, 0], size: [0.290, 0.130, 0.260] },
    { anchor: 'waist', type: 'rbox', role: 'metal', position: [0, -0.055, 0.010], size: [0.250, 0.028, 0.230] },
    { anchor: 'pelvis', type: 'cylinder', role: 'rubber', position: [0, 0.050, 0], size: [0.215, 0.230, 0.075], radial: 20 },

    // ================= arms: vambrace sleeves the forearm ======================================
    { anchor: 'elbow', type: 'rbox', role: 'shell', position: [0, 0.100, 0], size: [0.145, 0.230, 0.145] },

    // ===== legs: plates MEET (rule 2). Femur is 0.58 m, so the thigh plate runs 0.06 -> 0.54 =====
    { anchor: 'hip', type: 'rbox', role: 'shell', position: [0, 0.300, 0], size: [0.170, 0.480, 0.205] },
    { anchor: 'hip', type: 'rbox', role: 'metal', position: [0, 0.075, 0], size: [0.180, 0.070, 0.215] },
    { anchor: 'knee', type: 'rbox', role: 'metal', position: [0, 0.010, 0], size: [0.150, 0.130, 0.175] },
    { anchor: 'knee', type: 'rbox', role: 'shell', position: [0, 0.260, 0], size: [0.155, 0.390, 0.180] },

    // ================= boots: ankle/heel block plus a separate toe volume ======================
    { anchor: 'foot', type: 'rbox', role: 'plate', position: [0, 0.075, 0.020], size: [0.180, 0.150, 0.150] },
    { anchor: 'foot', type: 'rbox', role: 'metal', position: [0, 0.022, 0.172], size: [0.165, 0.085, 0.110] },

    // ============================================================================================
    // LAYERING PASS. Detail reads as PART COUNT, not tessellation: a smooth 100k-triangle box
    // still reads as one box. These are small, cheap, low-poly pieces that sit PROUD of the big
    // masses so the armour looks assembled from overlapping plates rather than carved from one
    // volume. They also give the joints a visible mechanical reveal instead of melting together.
    // ============================================================================================

    // --- chest: a raised core plate + collarbone plates layered over the main block ---
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0, 0.070, 0.196], size: [0.200, 0.150, 0.040], bevel: 0.008 },
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [0.115, 0.150, 0.180], size: [0.150, 0.070, 0.055], rotation: [0, 0, -0.18] },
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [-0.115, 0.150, 0.180], size: [0.150, 0.070, 0.055], rotation: [0, 0, 0.18] },
    // --- abdominal segment strips: three stacked bands read as a flexible midsection ---
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0, -0.055, 0.170], size: [0.230, 0.030, 0.040], bevel: 0.006 },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0, -0.098, 0.160], size: [0.205, 0.030, 0.040], bevel: 0.006 },
    // --- pauldron layering: a second smaller plate riding each shoulder, plus a rim lip ---
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0.262, 0.246, 0.020], size: [0.215, 0.055, 0.250], bevel: 0.008 },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [-0.262, 0.246, 0.020], size: [0.215, 0.055, 0.250], bevel: 0.008 },
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [0.330, 0.150, 0.020], size: [0.070, 0.190, 0.250], bevel: 0.008 },
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [-0.330, 0.150, 0.020], size: [0.070, 0.190, 0.250], bevel: 0.008 },
    // --- ASYMMETRY: a pouch on the left hip and a shoulder box on the right. The reference breaks
    //     mirror symmetry with kit; a perfectly symmetric model reads as a placeholder. ---
    { anchor: 'torso', type: 'rbox', role: 'rubber', position: [-0.300, 0.240, -0.060], size: [0.110, 0.090, 0.140] },
    { anchor: 'pelvis', type: 'rbox', role: 'rubber', position: [0.175, 0.010, 0.030], size: [0.090, 0.130, 0.110] },
    { anchor: 'pelvis', type: 'rbox', role: 'metal', position: [0.175, 0.070, 0.030], size: [0.095, 0.022, 0.115], bevel: 0.006 },

    // --- joint reveals: a dark rubber collar where each plate stops, so limbs look mounted on a
    //     mechanism rather than fused. Sized to sit just proud of the limb, under the plates. ---
    { anchor: 'knee', type: 'cylinder', role: 'rubber', position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], size: [0.072, 0.072, 0.150], radial: 14 },
    { anchor: 'elbow', type: 'cylinder', role: 'rubber', position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], size: [0.058, 0.058, 0.120], radial: 14 },
    { anchor: 'hip', type: 'cylinder', role: 'rubber', position: [0, 0.030, 0], rotation: [0, 0, Math.PI / 2], size: [0.078, 0.078, 0.160], radial: 14 },
    // --- kneecap guard riding proud of the knee reveal ---
    { anchor: 'knee', type: 'rbox', role: 'metal', position: [0, 0.045, 0.060], size: [0.120, 0.130, 0.070], rotation: [0.25, 0, 0] },
    // --- ankle collar ---
    { anchor: 'foot', type: 'rbox', role: 'metal', position: [0, 0.145, -0.030], size: [0.130, 0.055, 0.115], bevel: 0.006 },

    // --- head: lens housings around the eyes, brow vents, jaw vents. The head is the focal point
    //     of any character read and was the emptiest part of the model. ---
    { anchor: 'head', type: 'cylinder', role: 'metal', position: [0.031, 0.000, 0.082], rotation: [Math.PI / 2, 0, 0], size: [0.022, 0.022, 0.026], radial: 12 },
    { anchor: 'head', type: 'cylinder', role: 'metal', position: [-0.031, 0.000, 0.082], rotation: [Math.PI / 2, 0, 0], size: [0.022, 0.022, 0.026], radial: 12 },
    // camera housing offset to one side (asymmetry, as on the reference)
    { anchor: 'head', type: 'rbox', role: 'metal', position: [0.070, 0.098, 0.040], size: [0.048, 0.038, 0.055], bevel: 0.006 },
    { anchor: 'head', type: 'sphere', role: 'eye', position: [0.070, 0.098, 0.070], size: [0.010] },

    // ============================================================================================
    // TAN WEBBING. The model was team-shell vs bare-metal with nothing between them, which reads
    // toy-like: the grey looked pasted on rather than integrated. `fabric` is the mid-value band
    // the reference uses heavily (thigh pouches, chest webbing, shoulder straps).
    // ============================================================================================
    { anchor: 'torso', type: 'rbox', role: 'fabric', position: [0, -0.020, 0.198], size: [0.330, 0.070, 0.036] },
    { anchor: 'torso', type: 'rbox', role: 'fabric', position: [0.215, 0.075, 0.150], size: [0.075, 0.230, 0.075], rotation: [0, 0, 0.12] },
    { anchor: 'torso', type: 'rbox', role: 'fabric', position: [-0.215, 0.075, 0.150], size: [0.075, 0.230, 0.075], rotation: [0, 0, -0.12] },
    // shoulder straps under the pauldrons
    { anchor: 'torso', type: 'rbox', role: 'fabric', position: [0.262, 0.020, 0.020], size: [0.230, 0.055, 0.230] },
    { anchor: 'torso', type: 'rbox', role: 'fabric', position: [-0.262, 0.020, 0.020], size: [0.230, 0.055, 0.230] },
    // thigh pouch, mirrored, plus a tan outer panel on each thigh
    { anchor: 'hip', type: 'rbox', role: 'fabric', position: [0.098, 0.290, 0.020], size: [0.055, 0.190, 0.130] },
    { anchor: 'hip', type: 'rbox', role: 'fabric', position: [0, 0.510, 0], size: [0.185, 0.070, 0.215] },

    // ============================================================================================
    // ACTUATORS. Cheap cylinder primitives implying hydraulics — the reference shows exposed rods
    // at the back of the knee and ankle, and the model had none.
    // ============================================================================================
    // Previous attempt used r=0.018 rods that read as shading noise. The reference's hip-to-shin
    // piston is one of the most iconic shapes in the image, so these are 3x thicker and stand well
    // clear of the leg on the outside, where nothing occludes them.
    { anchor: 'hip', type: 'cylinder', role: 'metal', position: [0.128, 0.300, -0.045], size: [0.048, 0.048, 0.400], radial: 14 },
    { anchor: 'hip', type: 'cylinder', role: 'rubber', position: [0.128, 0.470, -0.045], size: [0.062, 0.062, 0.090], radial: 14 },
    { anchor: 'knee', type: 'cylinder', role: 'metal', position: [0.118, 0.190, -0.055], size: [0.040, 0.040, 0.330], radial: 14 },
    { anchor: 'knee', type: 'cylinder', role: 'rubber', position: [0.118, 0.020, -0.055], size: [0.052, 0.052, 0.080], radial: 14 },
    { anchor: 'elbow', type: 'cylinder', role: 'metal', position: [0.092, 0.100, -0.045], size: [0.030, 0.030, 0.220], radial: 12 },

    // ============================================================================================
    // PAULDRON ASSEMBLY. It was one box plus a vent disc; the reference shoulder is 4-5 overlapping
    // plates with visible parting lines.
    // ============================================================================================
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [0.300, 0.235, 0.075], size: [0.190, 0.080, 0.160], rotation: [0.16, 0, 0.10] },
    { anchor: 'torso', type: 'rbox', role: 'plate', position: [-0.300, 0.235, 0.075], size: [0.190, 0.080, 0.160], rotation: [0.16, 0, -0.10] },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [0.318, 0.100, 0.115], size: [0.150, 0.075, 0.085], rotation: [0, 0, 0.14] },
    { anchor: 'torso', type: 'rbox', role: 'metal', position: [-0.318, 0.100, 0.115], size: [0.150, 0.075, 0.085], rotation: [0, 0, -0.14] },

    // ============================================================================================
    // SEGMENTED WAIST. A single solid band became an accordion of stacked rings.
    // ============================================================================================
    { anchor: 'waist', type: 'rbox', role: 'metal', position: [0, 0.045, 0], size: [0.268, 0.018, 0.243], bevel: 0.004 },
    { anchor: 'waist', type: 'rbox', role: 'metal', position: [0, 0.014, 0], size: [0.276, 0.018, 0.249], bevel: 0.004 },
    { anchor: 'waist', type: 'rbox', role: 'metal', position: [0, -0.017, 0], size: [0.268, 0.018, 0.243], bevel: 0.004 },

    // ============================================================================================
    // BOOT: distinct toe cap, heel block and sole tread instead of one wedge.
    // ============================================================================================
    { anchor: 'foot', type: 'rbox', role: 'rubber', position: [0, -0.005, 0.070], size: [0.190, 0.045, 0.310], bevel: 0.008 },
    { anchor: 'foot', type: 'rbox', role: 'rubber', position: [0, 0.038, -0.072], size: [0.170, 0.090, 0.090] },
    { anchor: 'foot', type: 'rbox', role: 'fabric', position: [0, 0.105, 0.075], size: [0.150, 0.055, 0.110] },
  ],
});

// Role add-ons layered onto the base gear.
export const BOT_DESIGN_ADDONS = Object.freeze({
  antenna: [
    { anchor: 'torso', type: 'cylinder', role: 'metal', position: [-0.155, 0.30, -0.09], size: [0.009, 0.009, 0.26] },
    { anchor: 'torso', type: 'sphere', role: 'eye', position: [-0.155, 0.448, -0.09], size: [0.018] },
  ],
});

// Compose the base design with named add-ons: botDesignWith('antenna')
export function botDesignWith(...addons) {
  const gear = [...BOT_BODY_DESIGN.gear];
  for (const name of addons) {
    const extra = BOT_DESIGN_ADDONS[name];
    if (extra) gear.push(...extra);
  }
  return { ...BOT_BODY_DESIGN, gear };
}
