// bot-bodies/v1-blockout.js — FROZEN HISTORICAL BODY: v1 — blockout (2026-07-31 09:11)
//
// The FIRST bot design. Placeholder shapes: a broad chest, slim pelvis, slab pauldrons, boots and
// glow accents, before any of it was modelled. Snapshot taken before the armoured-mech redesign.
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
// Design intent vs the rig's plain default body:
// - broader chest / slimmer tucked pelvis (kills the "diaper blob" silhouette)
// - real boots and gloves instead of scaled spheres and lathe blobs, sized to human proportions
//   (the legacy foot was ~0.17 m wide × 0.37 m long — a flipper)
// - higher tessellation everywhere: lathe profiles carry more points, joints and limbs more segments
// - material variation: bare `metal` hardware and matte `rubber` (both untinted, so they read as
//   materials rather than team colour) against the tinted shell/plate/trim/accent
// - a plain helmeted head is the GENERAL look; the visor-slit face is a role marker, not standard

export const BOT_BODY_DESIGN = Object.freeze({
  // ---- proportions ----
  pelvisProfile: [[0.16, -0.090], [0.40, -0.078], [0.50, -0.016], [0.44, 0.060], [0.24, 0.092]],
  // Shoulders ~0.52 m across. An earlier 0.86 profile put them at 0.72 m, which read as a slab.
  torsoProfile: [
    [0.24, -0.148], [0.34, -0.128], [0.42, -0.112], [0.58, -0.020],
    [0.70, 0.048], [0.74, 0.086], [0.68, 0.122], [0.55, 0.146], [0.27, 0.158],
  ],
  torsoRadial: 32,
  pelvisRadial: 28,
  // Head sized to ~0.23 m wide × 0.26 m tall. The previous profile was so deep that the eyes
  // (z 0.084) sat INSIDE the skull surface (z 0.120) and never rendered.
  headProfile: [
    [0.08, -0.070], [0.20, -0.064], [0.27, -0.050], [0.30, -0.020],
    [0.305, 0.008], [0.29, 0.032], [0.24, 0.052], [0.15, 0.063], [0.05, 0.067],
  ],
  headRadial: 28, headZScale: 0.86,
  // Face surface sits at z ≈ 0.089; the lenses protrude to 0.116 so they always read.
  eye: { width: 0.026, length: 0.015, depth: 0.026, y: 0.030, z: 0.090, spacing: 0.088 },
  neck: { rTop: 0.17, rBot: 0.20, h: 0.070, radial: 20, zScale: 0.84 },
  waist: { rTop: 0.29, rBot: 0.35, h: 0.052, radial: 24, zScale: 0.74 },
  limbThicknessRatio: 0.34,
  shoulderJoint: 0.88,
  ankleJoint: 0.50,
  // The wrist ball used to be as wide as the whole palm; the elbow was close behind.
  wristJoint: 0.26,
  elbowJoint: 0.40,

  // ---- material roles ----
  // The head defaulted to `trim` (near-black on bots), which rendered the face as a void under a
  // coloured helmet. Shell puts team colour on the face; hardware roles carry the rest.
  roles: { head: 'shell', hand: 'accent', foot: 'shell', waist: 'rubber', joint: 'metal' },

  // ---- tessellation + limb shaping ----
  // Lathe profiles interpolate LINEARLY between control points, so radial counts alone left the
  // vertical silhouette faceted; profileSmooth resamples every profile through a spline.
  profileSmooth: 48,
  outlineSmooth: true,
  jointRadial: 18, jointSeg: 12,
  eyeRadial: 18, eyeSeg: 12,
  limbRadial: 22,
  // segmented limb: narrow at the joints, swelling twice so the leg/arm reads as two muscle masses
  limbProfile: [
    [0.10, -0.500], [0.62, -0.470], [0.86, -0.420], [0.94, -0.300], [0.88, -0.170],
    [0.80, -0.020], [0.88, 0.130], [0.95, 0.280], [0.86, 0.420], [0.60, 0.470], [0.10, 0.500],
  ],

  // ---- boots ----
  footShape: 'boot',
  // width, height, length as multiples of limbThickness (x/z span [-1,1], sole at y=0)
  footScale: [0.46, 0.52, 1.20],
  footSegments: 3,

  // ---- gloves ----
  handShape: 'glove',
  handFingerAxis: -1,       // fingers hang along local -Y in the idle pose
  handPalmFacing: 'x',      // palm faces inward, as a hand hangs at rest
  handThickness: 0.34,
  handSegments: 2,
  handOutline: [
    [-0.30, -0.70], [0.30, -0.70], [0.42, -0.34], [0.64, -0.04], [0.38, 0.12],
    [0.34, 0.38], [0.28, 0.64], [-0.30, 0.60], [-0.36, 0.16],
  ],

  gear: [
    // Helmet is `plate` (dark) over a `shell` face: same-role gear on a same-role part is invisible.
    { anchor: 'head', type: 'lathe', role: 'plate',
      profile: [[0.108, 0.040], [0.115, 0.062], [0.110, 0.090], [0.090, 0.112], [0.055, 0.126], [0.015, 0.130]], radial: 28 },
    // brow band on the eye line, in bare metal so the face has a hard edge
    { anchor: 'head', type: 'torus', role: 'metal', position: [0, 0.050, 0], rotation: [Math.PI / 2, 0, 0], size: [0.096, 0.007], radial: 28, seg: 12 },
    // chin guard + vent slats: face detail that sits PROUD of the 0.089 surface, or it renders inside
    { anchor: 'head', type: 'box', role: 'metal', position: [0, -0.058, 0.050], size: [0.062, 0.026, 0.034] },
    { anchor: 'head', type: 'box', role: 'metal', position: [0, -0.010, 0.090], size: [0.060, 0.007, 0.014] },
    { anchor: 'head', type: 'box', role: 'metal', position: [0, -0.026, 0.088], size: [0.052, 0.007, 0.014] },
    { anchor: 'head', type: 'box', role: 'metal', position: [0, -0.042, 0.082], size: [0.042, 0.007, 0.014] },
    { anchor: 'head', type: 'cylinder', role: 'metal', position: [0.090, 0.010, 0.020], rotation: [0, 0, Math.PI / 2], size: [0.016, 0.016, 0.016], radial: 12 },
    { anchor: 'head', type: 'cylinder', role: 'metal', position: [-0.090, 0.010, 0.020], rotation: [0, 0, Math.PI / 2], size: [0.016, 0.016, 0.016], radial: 12 },
    // Pauldrons ride the SHOULDER joints (mirrored). Chest-anchored spheres sat too low and read
    // as pecs; with a glowing bar between them the whole torso read as a second face.
    { anchor: 'shoulder', type: 'sphere', role: 'plate', position: [0.012, 0.010, 0], size: [0.072], scale: [1.0, 0.62, 1.15] },
    // flat sternum plate + collar bar + back slab
    { anchor: 'torso', type: 'box', role: 'plate', position: [0, 0.070, 0.128], size: [0.20, 0.13, 0.035], rotation: [0.10, 0, 0] },
    { anchor: 'torso', type: 'box', role: 'metal', position: [0, 0.150, 0.090], size: [0.26, 0.022, 0.030] },
    { anchor: 'torso', type: 'box', role: 'plate', position: [0, 0.030, -0.150], size: [0.26, 0.30, 0.070] },
    // small glowing status light, off-centre so it never reads as a mouth
    { anchor: 'torso', type: 'sphere', role: 'eye', position: [0.075, 0.105, 0.130], size: [0.014] },
    // belt + buckle
    { anchor: 'pelvis', type: 'cylinder', role: 'rubber', position: [0, 0.055, 0], size: [0.175, 0.190, 0.050], radial: 22 },
    { anchor: 'pelvis', type: 'box', role: 'metal', position: [0, 0.055, 0.125], size: [0.050, 0.042, 0.020] },
    // Boot detail, mirrored onto both feet. The boot body spans x ±0.055, y 0–0.124, z ±0.143;
    // every piece must protrude past that or it renders inside the solid boot and disappears.
    // Sole is an extruded outline (fore/aft along +Z) so it follows the boot instead of being a slab.
    { anchor: 'foot', type: 'extrude', role: 'rubber', axis: 'x', depth: 0.118, bevel: 0.004, seg: 2,
      position: [0, 0, 0],
      outline: [[-0.142, 0.000], [-0.150, 0.014], [-0.140, 0.028], [0.118, 0.028], [0.152, 0.015], [0.146, 0.000]] },
    { anchor: 'foot', type: 'box', role: 'metal', position: [0, 0.034, 0.124], size: [0.102, 0.048, 0.052] },
    { anchor: 'foot', type: 'cylinder', role: 'rubber', position: [0, 0.110, -0.012], size: [0.062, 0.062, 0.030], radial: 18 },
    { anchor: 'foot', type: 'box', role: 'metal', position: [0, 0.070, 0.045], size: [0.118, 0.016, 0.055] },
    // knee pads + elbow caps
    { anchor: 'knee', type: 'sphere', role: 'plate', position: [0, 0, 0.030], size: [0.044], scale: [1, 1.15, 0.7] },
    { anchor: 'elbow', type: 'sphere', role: 'plate', position: [0, 0, -0.024], size: [0.034], scale: [1, 1.1, 0.7] },
  ],
});

// Role add-ons layered onto the base gear.
export const BOT_DESIGN_ADDONS = Object.freeze({
  // The visor-slit face: skull + jaw shells with the glowing eyes recessed in the gap between them.
  // Deliberately NOT part of the general look — it reads as a specific role.
  visorSlit: [
    { anchor: 'head', type: 'lathe', role: 'shell',
      profile: [[0.148, 0.078], [0.160, 0.100], [0.148, 0.145], [0.100, 0.190], [0.02, 0.208]], radial: 24 },
    { anchor: 'head', type: 'lathe', role: 'shell',
      profile: [[0.030, -0.185], [0.120, -0.150], [0.150, -0.030], [0.148, 0.028]], radial: 24 },
  ],
  antenna: [
    { anchor: 'torso', type: 'cylinder', role: 'metal', position: [-0.155, 0.30, -0.09], size: [0.009, 0.009, 0.26] },
    { anchor: 'torso', type: 'sphere', role: 'eye', position: [-0.155, 0.448, -0.09], size: [0.018] },
  ],
});

// Gear pieces the add-ons replace rather than stack on (visorSlit owns the whole head).
const ADDON_REPLACES_HEAD = new Set(['visorSlit']);

// Compose the base design with named add-ons: botDesignWith('visorSlit', 'antenna')
export function botDesignWith(...addons) {
  const dropHead = addons.some((a) => ADDON_REPLACES_HEAD.has(a));
  const gear = BOT_BODY_DESIGN.gear.filter((g) => !(dropHead && g.anchor === 'head'));
  for (const name of addons) {
    const extra = BOT_DESIGN_ADDONS[name];
    if (extra) gear.push(...extra);
  }
  return { ...BOT_BODY_DESIGN, gear };
}
