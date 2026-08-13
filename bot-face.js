// bot-face.js
//
// A HUMAN head for the bots: skin-coloured skull, real eyes, a nose, a mouth and hair, with the
// brow/lid/mouth driven by a small set of expression numbers. Pure data — no THREE import — so it
// stays Node-testable like the rest of the design layer.
//
// It replaces the Mark VII helmet rather than sitting under it: `withHumanHead(design)` drops every
// `anchor: 'head'` piece and substitutes this face. The body below the neck is untouched.
//
// COORDINATES. Head gear hangs off an inverse-scale anchor, so everything here is in TRUE METRES in
// an UNSQUASHED frame, while the skull lathe itself is authored in the rig's R/H units and then
// squashed by headZScale. The skull surface a feature has to clear is therefore an ELLIPSE, not the
// lathe radius: headSurfaceZ(x, y) below is that number, and every z in this file was picked
// against it. Get this wrong and the piece renders inside the skull and is simply invisible — the
// same failure the helmet hit twice (rule 1 in bot-body-design.js).
//
// EXPRESSION is authored, not animated. Changing it remints the brow/lid/mouth geometry, and each
// distinct geometry costs an InstancedMesh bucket that is never evicted, so a bot picks an
// expression when it is built. Eight presets is eight buckets; a per-frame expression would be
// unbounded.
//
// RULE 4 APPLIES HARDEST HERE. On a helmet, a stray dark bar under the visor became teeth by
// accident. On an actual face every piece is read as a facial feature by definition, so the failure
// mode flips: the question is never "is it there" but "does it read as the expression it is named
// after". Judge these at normal viewing distance, not by the numbers.

const R_UNIT = 0.35;   // player-procedural-body's reference radius (profiles are in these units)
const H_UNIT = 1.8;    // ... and its reference height

// Skull half-width by height, in TRUE METRES. ~0.180 m wide, 0.198 m deep, 0.253 m tall — slightly
// larger than a real head relative to the rig, because the armoured body it sits on is oversized.
// Chin raised from -0.125 and the jaw widened: at full length this was an egg with a blank lower
// third, and no amount of feature work fixes a face that is simply too long.
const SKULL_M = [
  [0.034, -0.116], [0.056, -0.103], [0.074, -0.082], [0.084, -0.054], [0.090, -0.018],
  [0.091, 0.016], [0.089, 0.052], [0.077, 0.086], [0.056, 0.112], [0.024, 0.128],
];
const HEAD_Z_SCALE = 1.10;   // heads are deeper than they are wide

// Feature anchors. Eyes sit near the vertical middle of the skull (chin -0.116, crown 0.128) — the
// classic proportion. Placing them high is the single fastest way to make a face read as a doll.
const EYE = { x: 0.036, y: 0.008, r: 0.016, z: 0.0785 };
const BROW_Y = 0.038;
const MOUTH_Y = -0.062;
export const LID_MIN = 0.30;   // below this the lid piece is left out entirely — see makeHumanHead

/**
 * Skull fields at a given size. `scale` multiplies the head uniformly — needed because the rig
 * derives limb lengths from a fixed reference height, so a body scaled to fill its capsule would
 * otherwise keep a fixed head and stretch from ~7.6 heads to ~10, which reads as an alien rather
 * than a taller person.
 */
export function humanHeadShape(scale = 1) {
  return {
    headProfile: SKULL_M.map(([r, y]) => [(r * scale) / R_UNIT, (y * scale) / H_UNIT]),
    headRadial: 26,
    headZScale: HEAD_Z_SCALE,
    // The rig's own eye spheres stay collapsed: the sclera/pupil pieces are the real eyes.
    eye: { width: 0.001, length: 0.001, depth: 0.001, y: 0, z: 0, spacing: 0 },
  };
}
export const HUMAN_HEAD_SHAPE = Object.freeze(humanHeadShape(1));

// Skin and hair are per-body palette colours (see _roleColor in player-procedural-body.js), so a
// squad can be mixed without any extra draw calls — same buckets, different instance tints.
export const SKIN_TONES = Object.freeze({
  pale: 0xe0b48f, tan: 0xc98d63, olive: 0xa9713f, brown: 0x7d4a2a, deep: 0x4e2c19,
});
export const HAIR_COLORS = Object.freeze({
  black: 0x1a1512, brown: 0x3a2617, auburn: 0x5a2c17, blond: 0x9c7434, grey: 0x6d6a63,
});

// brow      vertical offset of the eyebrows, in 10 mm units (+ raised)
// browTilt  radians; + drops the INNER end (the angry direction)
// lid       0..1 how far the upper lid closes over the eye
// mouthCurve -1..1 (frown .. smile)
// mouthOpen 0..1
// mouthWidth multiplier on the default half-width
export const FACE_EXPRESSIONS = Object.freeze({
  neutral:    { brow:  0.00, browTilt:  0.00, lid: 0.10, mouthCurve:  0.00, mouthOpen: 0.00, mouthWidth: 1.00 },
  determined: { brow: -0.25, browTilt:  0.16, lid: 0.26, mouthCurve: -0.12, mouthOpen: 0.00, mouthWidth: 1.05 },
  angry:      { brow: -0.55, browTilt:  0.34, lid: 0.34, mouthCurve: -0.45, mouthOpen: 0.10, mouthWidth: 0.95 },
  shout:      { brow: -0.40, browTilt:  0.26, lid: 0.02, mouthCurve: -0.15, mouthOpen: 0.85, mouthWidth: 0.90 },
  grin:       { brow:  0.10, browTilt: -0.06, lid: 0.20, mouthCurve:  0.60, mouthOpen: 0.15, mouthWidth: 1.10 },
  worried:    { brow:  0.30, browTilt: -0.30, lid: 0.00, mouthCurve: -0.30, mouthOpen: 0.05, mouthWidth: 0.85 },
  pain:       { brow: -0.30, browTilt:  0.20, lid: 0.62, mouthCurve: -0.35, mouthOpen: 0.45, mouthWidth: 1.00 },
  dead:       { brow:  0.05, browTilt:  0.00, lid: 0.88, mouthCurve: -0.10, mouthOpen: 0.30, mouthWidth: 0.95 },
});

// ---------------------------------------------------------------------------------------------
// skull surface — the number every face piece is placed against
// ---------------------------------------------------------------------------------------------

/** Lathe radius of the skull at height y, in metres. Clamps outside the profile. */
export function skullRadius(y) {
  const p = SKULL_M;
  if (y <= p[0][1]) return p[0][0];
  if (y >= p[p.length - 1][1]) return p[p.length - 1][0];
  for (let i = 1; i < p.length; i++) {
    if (y <= p[i][1]) {
      const t = (y - p[i - 1][1]) / (p[i][1] - p[i - 1][1]);
      return p[i - 1][0] + t * (p[i][0] - p[i - 1][0]);
    }
  }
  return p[p.length - 1][0];
}

/**
 * Front face of the skull at (x, y) in gear space. Linear between control points, so it slightly
 * UNDER-reads the splined surface (profileSmooth bulges a convex profile outward) — leave a few mm
 * of margin rather than sitting exactly on this value.
 */
export function headSurfaceZ(x, y) {
  const r = skullRadius(y);
  const k = r * r - x * x;
  return k <= 0 ? 0 : HEAD_Z_SCALE * Math.sqrt(k);
}

// ---------------------------------------------------------------------------------------------
// outline builders
// ---------------------------------------------------------------------------------------------

const r5 = (v) => Math.round(v * 1e5) / 1e5;

// Mouth: a lens whose centre sags for a smile, so the CORNERS lift. Building it the other way (lift
// the corners directly) leaves the middle flat and reads as a moustache rather than a mouth.
function mouthOutline(curve, open, width) {
  const hw = 0.024 * width;
  const sag = 0.010 * curve;
  const half = 0.0032 + 0.0170 * open;
  const N = 8;
  const top = [], bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = -hw + 2 * hw * t;
    const k = 1 - (2 * t - 1) ** 2;   // 0 at the corners, 1 at the centre
    const yc = -k * sag;
    // Thickness TAPERS to the corners. At constant thickness the spline overshoots the end points
    // and the mouth came out fat at both ends and pinched in the middle — a bow tie, not lips.
    const h = half * (0.28 + 0.72 * k);
    top.push([r5(x), r5(yc + h)]);
    bot.push([r5(x), r5(yc - h)]);
  }
  return [...top, ...bot.reverse()];
}

// Brow: a tapered bar, THICKER at the inner end (local -x points at the face centre for the piece
// on the bot's right). A bar of even thickness reads as a sticker, not hair.
function browOutline() {
  return [[-0.025, -0.0060], [0.023, -0.0030], [0.023, 0.0030], [-0.025, 0.0070]];
}

/** The left-hand twin of a right-hand piece: x mirrored, y/z rotations negated, outline flipped. */
function mirrorX(g) {
  const out = { ...g };
  if (g.id) out.id = g.id.replace(/R$/, 'L');
  if (g.position) out.position = [-g.position[0], g.position[1], g.position[2]];
  if (g.rotation) out.rotation = [g.rotation[0], -g.rotation[1], -g.rotation[2]];
  if (g.outline) out.outline = g.outline.map(([x, y]) => [-x, y]).reverse();
  return out;
}
const pair = (g) => [g, mirrorX(g)];

// ---------------------------------------------------------------------------------------------
// the face
// ---------------------------------------------------------------------------------------------

/**
 * Gear descriptors for a human head, all anchored to `head`.
 * @param {object}  [opts]
 * @param {string|object} [opts.expression='neutral'] a FACE_EXPRESSIONS key, or its own param object
 * @param {boolean} [opts.hair=true]  hair cap (off gives a shaved head)
 * @param {boolean} [opts.ears=true]
 */
export function makeHumanHead(opts = {}) {
  const { hair = true, ears = true, scale = 1 } = opts;
  const e = typeof opts.expression === 'object' && opts.expression
    ? { ...FACE_EXPRESSIONS.neutral, ...opts.expression }
    : { ...FACE_EXPRESSIONS.neutral, ...(FACE_EXPRESSIONS[opts.expression || 'neutral'] || null) };

  const gear = [];

  // ---- eyes -------------------------------------------------------------------------------
  // Real spheres, not printed dots: mostly sunk in the skull so only a lens-shaped cap of white
  // shows. At x=0.036 the skull front is 0.0905, so a sphere front at 0.0945 stands 4 mm proud.
  gear.push(...pair({ id: 'eyeballR', anchor: 'head', type: 'sphere', role: 'sclera',
    position: [EYE.x, EYE.y, EYE.z], size: [EYE.r], radial: 16, seg: 12 }));
  // Pupil as a flat disc, not a second sphere — a domed pupil turns the eye into a bug eye.
  gear.push(...pair({ id: 'pupilR', anchor: 'head', type: 'cylinder', role: 'pupil',
    position: [EYE.x, EYE.y, 0.0925], rotation: [Math.PI / 2, 0, 0], size: [0.0090, 0.0090, 0.007], radial: 14 }));
  // Catchlight. Offset the SAME way on both eyes (a light source is in one place), which is why
  // this pair is written out rather than mirrored.
  gear.push({ id: 'glintR', anchor: 'head', type: 'sphere', role: 'sclera',
    position: [EYE.x + 0.005, EYE.y + 0.005, 0.0950], size: [0.0030], radial: 8, seg: 6 });
  gear.push({ id: 'glintL', anchor: 'head', type: 'sphere', role: 'sclera',
    position: [-EYE.x + 0.005, EYE.y + 0.005, 0.0950], size: [0.0030], radial: 8, seg: 6 });

  // ---- upper lids: the expression's eye half -----------------------------------------------
  // ONLY EMITTED FOR A SQUINT OR BETTER. To occlude the eyeball a lid has to sit PROUD of it, and a
  // proud skin bar above an open eye is just a second eyebrow — which is exactly how the first
  // version read. Below the threshold the brow carries the expression on its own and the eye stays
  // clean; above it the lid is doing real work and reads as a squint.
  if (e.lid >= LID_MIN) {
    gear.push(...pair({ id: 'lidR', anchor: 'head', type: 'rbox', role: 'skin',
      position: [EYE.x, r5(0.030 - e.lid * 0.020), 0.0825],
      rotation: [0, 0, r5(-e.browTilt * 0.6)],
      size: [0.042, 0.014, 0.026], bevel: 0.005 }));
  }

  // ---- brows: the other half --------------------------------------------------------------
  gear.push(...pair({ id: 'browR', anchor: 'head', type: 'extrude', role: 'hair', smooth: false,
    position: [EYE.x, r5(BROW_Y + e.brow * 0.010), 0.086],
    rotation: [0, 0, r5(-e.browTilt)],
    depth: 0.014, bevel: 0.002, seg: 1, outline: browOutline() }));

  // ---- nose --------------------------------------------------------------------------------
  // ONE piece, cut as a SIDE PROFILE. `axis: 'x'` maps the outline's x onto the body's +Z, so the
  // outline below is literally a nose seen from the side, extruded across the width.
  //
  // Two earlier tries — a box bridge with a ball on the end, then the same with more overlap —
  // both read as a rod with a bead stuck on it, because a constant-section bridge cannot do the one
  // thing a nose does: start flush inside the brow and grow forward as it descends. The profile
  // does that for free. Its top-rear point sits at z=0.084 against a 0.099 skull, so the root is
  // BURIED and the nose emerges out of the face instead of being parked on it.
  // smooth: false. Splined, the profile inflated into a rounded slab across the middle of the face
  // and read as a nose guard; the ridge needs its corners.
  gear.push({ id: 'nose', anchor: 'head', type: 'extrude', role: 'skin', smooth: false,
    axis: 'x', position: [0, 0, 0.074], depth: 0.018, bevel: 0.003, seg: 2,
    outline: [[0.006, 0.024], [0.016, 0.008], [0.028, -0.012], [0.034, -0.024],
      [0.020, -0.030], [0.004, -0.026], [0.002, 0.018]] });
  // Nose base. The extrusion is one constant width top to bottom, so head-on the nose is a
  // rectangle; this widens the bottom into a triangle, which is what makes it read as a nose from
  // the front rather than a tab. It sits BEHIND the ridge, so the ridge still leads.
  // ONE piece, not a mirrored pair of wings: as two spheres they read as beads stuck either side of
  // the nose — rule 4, a pair of small round shapes on a face is always read as a pair of somethings.
  gear.push({ id: 'noseBase', anchor: 'head', type: 'rbox', role: 'skin',
    position: [0, -0.030, 0.090], size: [0.034, 0.014, 0.020], bevel: 0.006 });

  // ---- mouth -------------------------------------------------------------------------------
  // Only a few mm proud at the centre, which is what makes it read as printed on the face rather
  // than glued to it. It cannot go flush: at the corners the skull has already fallen away, so a
  // mouth that sits on the surface at its centre is buried at its ends and disappears.
  gear.push({ id: 'mouth', anchor: 'head', type: 'extrude', role: 'mouth', smooth: true,
    position: [0, MOUTH_Y, 0.0845], depth: 0.010, bevel: 0.002, seg: 2,
    outline: mouthOutline(e.mouthCurve, e.mouthOpen, e.mouthWidth) });

  // ---- ears --------------------------------------------------------------------------------
  if (ears) {
    gear.push(...pair({ id: 'earR', anchor: 'head', type: 'rbox', role: 'skin',
      position: [0.088, -0.004, -0.014], size: [0.016, 0.046, 0.028], bevel: 0.009 }));
  }

  // ---- hair --------------------------------------------------------------------------------
  // A lathe cap scaled in z to match the skull's ellipse — an unscaled circular cap sinks into the
  // front and back of a head that is deeper than it is wide, and reads as a bald patch.
  if (hair) {
    // Tipped back 0.14 rad. Level, the lathe cuts a hard horizontal circle across the forehead and
    // reads as a swim cap; tipped, the same edge rides high at the front and low at the nape, which
    // is what a hairline actually does.
    gear.push({ id: 'hairCap', anchor: 'head', type: 'lathe', role: 'hair', radial: 36,
      rotation: [-0.10, 0, 0], position: [0, -0.004, 0.004],
      scale: [1, 1, HEAD_Z_SCALE],
      profile: [[0.0860, 0.070], [0.0840, 0.088], [0.0740, 0.106], [0.0580, 0.120], [0.0340, 0.131], [0.0140, 0.136]] });
  }

  return scale === 1 ? gear : gear.map((g) => scaleGear(g, scale));
}

// Uniform scale over every LENGTH in a descriptor. Radial/segment counts and rotations are left
// alone — they are counts and angles, not lengths, and scaling either corrupts the piece.
function scaleGear(g, k) {
  const out = { ...g };
  const m = (v) => Math.round(v * k * 1e5) / 1e5;
  if (g.position) out.position = g.position.map(m);
  if (g.size) out.size = g.size.map(m);
  if (g.depth != null) out.depth = m(g.depth);
  if (g.bevel != null) out.bevel = m(g.bevel);
  if (g.corner != null) out.corner = m(g.corner);
  if (g.profile) out.profile = g.profile.map(([r, y]) => [m(r), m(y)]);
  if (g.outline) out.outline = g.outline.map(([x, y]) => [m(x), m(y)]);
  return out;
}

// =================================================================================================
// HEAD KIT — helmet, sunglasses, face mask. Optional, so a squad can be mixed.
// =================================================================================================
//
// Sized against the MEASURED skull (skullRadius / headSurfaceZ above), not chosen:
//   widest r = 90.8 mm at y 0.008, crown at y 0.128, chin at y -0.116
//   the ears occupy y -0.027 .. 0.019 at x +-0.088
//
// That ear span is the whole reason a modern helmet looks the way it does: it is a HIGH CUT, ending
// above the ear so a headset fits under it. The shell here therefore stops at y 0.026 and never
// comes down over the side of the head, which is what separates it from a WW2-style steel pot.

/** Helmet shell radius at height y, in metres — the number the fittings have to clear. */
export function helmetRadius(y) {
  const p = HELMET_SHELL_PROFILE;
  if (y <= p[0][1]) return p[0][0];
  if (y >= p[p.length - 1][1]) return p[p.length - 1][0];
  for (let i = 1; i < p.length; i++) {
    if (y <= p[i][1]) {
      const t = (y - p[i - 1][1]) / (p[i][1] - p[i - 1][1]);
      return p[i - 1][0] + t * (p[i][0] - p[i - 1][0]);
    }
  }
  return p[p.length - 1][0];
}
/** Front face of the helmet at (x, y). Same ellipse trick as the skull: the shell carries the
 *  head's z-stretch so it sits parallel to it rather than pinching at the front. */
export function helmetSurfaceZ(x, y) {
  const r = helmetRadius(y);
  const k = r * r - x * x;
  return k <= 0 ? 0 : HEAD_Z_SCALE * Math.sqrt(k);
}

// ONE SHELL, not a dome plus a patch on the back.
//
// This was previously a `lathe`, and a lathe's rim is a level ring — the same height at the front,
// the back and both sides, because a surface of revolution has one radius per height and nothing
// varies with angle. A FAST shell's whole silhouette is the opposite: the edge sits just above the
// brow at the front, sweeps UP into a scallop over the ear so a headset fits under it, and drops at
// the nape to cover the back of the skull. None of that is reachable with a level rim, so the nape
// was faked with a rotated box stuck on the back — and it read as two objects, which is exactly
// what it was.
//
// `type: 'dome'` is the same revolution cut at a per-azimuth height. The rim table below IS the
// silhouette, so the shape comes out of one piece of data instead of three parts.
const HELMET_Z_SCALE = 1.12;

// [r, y], fitted so the shell clears the skull by 12.6-18.9 mm everywhere the skull exists (the
// widest point is y 0.030, matching the head's own), then falls off SLOWER than the skull does —
// an egg-shaped crown is the tell of a helmet modelled as an offset skull rather than a shell.
// This is the OUTER surface. The shell grows outward only: the wall went 7 mm -> 15 mm and every
// radius here went up by the same 8 mm, so inner = outer - wall is bit-identical to what it was and
// the standoff from the skull does not move. Thickening inward instead would have eaten the 5-7 mm
// of pad space between the shell and the head.
const HELMET_SHELL_PROFILE = [
  [0.1092, -0.036], [0.1104, -0.018], [0.1110, -0.006], [0.1118, 0.012], [0.1126, 0.030],
  [0.1113, 0.048], [0.1071, 0.066], [0.0999, 0.084], [0.0904, 0.100], [0.0789, 0.114],
  [0.0656, 0.126], [0.0485, 0.137], [0.0282, 0.145], [0.0090, 0.148],
];

// Bottom edge by azimuth: turn 0 is dead front (+Z), 0.25 is the right ear, 0.5 is the nape.
// Authored over half a turn and mirrored, because a helmet whose left and right cuts differ reads
// as damaged.
//
// Read off the side-on reference, not invented. The edge is a STAIRCASE of level runs, not a curve:
// flat over the brow, a short steep drop, a flat shelf over the ear, a second short drop, then flat
// across the whole back. Two things follow from that and both were wrong before.
//
// FLAT ACROSS THE BACK. The rear run has to span BOTH sides of dead-centre at one height. A single
// lowest sample at turn 0.5 mirrors into a downward point — the edge falls to the centre line from
// the left and rises away from it on the right, which reads as a V cut into the nape. The rear
// samples are therefore level from 0.375 all the way to 0.625.
//
// STEPPED, NOT RAMPED. Each drop happens over 0.03 of a turn — about one segment at radial 40 — so
// it lands as an edge you can see. Spreading the same descent across the whole rear quadrant, which
// is what the previous table did, averages the staircase into one smooth arc.
//
// Against the measured skull: brow top ~0.045, ear 0.019 down to -0.027, and the ear muff spans
// y -0.045..0.041 so its midpoint is -0.002.
const HELMET_RIM_HALF = [
  [0.000, 0.048],   // front — flat over the brow
  [0.155, 0.048],   // ... and level for the whole frontal span
  [0.190, 0.037],   // step 1: 11 mm. Shallow — the side run sits just under the front, not halfway
  [0.345, 0.034],   //   down the head, so the two read as neighbouring shelves
  [0.380, -0.026],  // step 2: 60 mm, the deep one, carrying the shell down over the nape
  [0.500, -0.026],  // rear — flat, and level right through dead-centre
];
const HELMET_RIM = [
  ...HELMET_RIM_HALF,
  ...HELMET_RIM_HALF.slice(1, -1).reverse().map(([t, y]) => [+(1 - t).toFixed(4), y]),
];

// =================================================================================================
// GAITER EXTENT — the cloth surface, as a function anything worn over it can query.
// =================================================================================================
//
// Declared up here rather than next to FACE_MASK because the retention straps have to clear it: the
// straps are solved onto the SKULL, and the gaiter stands 5-13 mm off the skull, so every piece of
// webbing below the hem is inside the cloth unless it is pushed out. Both the mask pieces and the
// clearance test read these numbers, so the two cannot drift.
const MASK_PROFILE = [
  [0.0450, -0.118], [0.0640, -0.106], [0.0800, -0.086], [0.0880, -0.058],
  [0.0930, -0.034], [0.0952, -0.014],
];
const MASK_HEM_Y = -0.014, MASK_HEM_R = 0.0945, MASK_HEM_T = 0.0055;

/** Cloth radius at height `y`, or 0 where there is no cloth. The lathe and the hem torus are both
 *  z-stretched by HEAD_Z_SCALE, so one un-stretched radius describes both. */
export function maskRadius(y) {
  let r = 0;
  const lo = MASK_PROFILE[0], hi = MASK_PROFILE[MASK_PROFILE.length - 1];
  if (y >= lo[1] && y <= hi[1]) {
    for (let i = 1; i < MASK_PROFILE.length; i++) {
      const a = MASK_PROFILE[i - 1], b = MASK_PROFILE[i];
      if (y <= b[1]) { r = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]); break; }
    }
  }
  const dy = Math.abs(y - MASK_HEM_Y);              // the hem bulges above the lathe's top edge
  if (dy < MASK_HEM_T) r = Math.max(r, MASK_HEM_R + Math.sqrt(MASK_HEM_T ** 2 - dy * dy));
  return r;
}

/** How far inside the cloth a point sits, in metres. Negative means clear of it. */
export function maskDepth(p) {
  const r = maskRadius(p.y);
  return r <= 0 ? -1 : r - Math.hypot(p.x, p.z / HEAD_Z_SCALE);
}

/** Thickness of the cloth over the skin at a height — what a piece resting on the skull has to move
 *  straight out by to rest on the gaiter instead, keeping whatever proudness it already had. */
export function maskStandoff(y) {
  const r = maskRadius(y);
  return r <= 0 ? 0 : Math.max(0, r - skullRadius(y));
}

// =================================================================================================
// RETENTION STRAPS — generated ON the measured skull, not typed as coordinates.
// =================================================================================================
//
// A strap is the one piece of kit that cannot be authored as a box between two plausible points.
// The skull's radius changes with height AND its cross-section is an ellipse (z is stretched by
// HEAD_Z_SCALE), so a straight bar spanning any real distance stands off the face in the middle and
// buries its ends. The previous straps were six such bars, rotated by eye to fake the taper.
//
// These are built from the surface instead: each path is a list of [turn, y] samples, every sample
// is projected onto skullRadius/HEAD_Z_SCALE, and each segment is oriented from the SURFACE NORMAL
// at its midpoint — so the strap's flat face lies against the head all the way round rather than
// only where it was eyeballed.
//
// `turn` is the same azimuth convention as the helmet rim: 0 is dead front (+Z), 0.25 the right ear.
// Mirroring is turn -> 1 - turn, which flips x and leaves z untouched, so the two sides cannot drift.
const TAU = Math.PI * 2;
const v3 = (x, y, z) => ({ x, y, z });
const vsub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const vadd = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const vmul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const vnorm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return vmul(a, 1 / l); };

/** Point on the skull surface at azimuth `turn`, height `y`. */
export function headPoint(turn, y) {
  const phi = turn * TAU, r = skullRadius(y);
  return v3(r * Math.sin(phi), y, HEAD_Z_SCALE * r * Math.cos(phi));
}

/** Outward unit normal there. Taken from the two surface tangents rather than from the radial
 *  direction, because the skull's radius changes fast with height near the jaw — a purely radial
 *  "normal" tips the strap off the surface exactly where the head is narrowing most. */
export function headNormal(turn, y) {
  const phi = turn * TAU, r = skullRadius(y), h = 0.0005;
  const dr = (skullRadius(y + h) - skullRadius(y - h)) / (2 * h);
  const tPhi = v3(r * Math.cos(phi), 0, -HEAD_Z_SCALE * r * Math.sin(phi));
  const tY = v3(dr * Math.sin(phi), 1, HEAD_Z_SCALE * dr * Math.cos(phi));
  const n = vnorm(vcross(tPhi, tY));
  return vdot(n, v3(Math.sin(phi), 0, Math.cos(phi))) < 0 ? vmul(n, -1) : n;
}

/** Bottom-edge height of the shell at an azimuth — the same cyclic table the dome is cut with, so
 *  anything anchoring to the edge tracks it automatically when the rim is retuned. */
export function helmetRimY(turn) {
  const u = ((turn % 1) + 1) % 1;
  for (let i = 0; i < HELMET_RIM.length; i++) {
    const a = HELMET_RIM[i], b = HELMET_RIM[(i + 1) % HELMET_RIM.length];
    const a0 = a[0], b0 = b[0] > a0 ? b[0] : b[0] + 1;
    const uu = u >= a0 ? u : u + 1;
    if (uu >= a0 && uu <= b0) return a[1] + ((uu - a0) / (b0 - a0)) * (b[1] - a[1]);
  }
  return HELMET_RIM[0][1];
}

/** Point on the shell's OUTER bottom edge at an azimuth. */
export function helmetEdgePoint(turn) {
  const y = helmetRimY(turn), phi = turn * TAU, r = helmetRadius(y);
  return v3(r * Math.sin(phi), y, HELMET_Z_SCALE * r * Math.cos(phi));
}

/** Euler XYZ mapping local +Y onto `dir` (the strap runs along its own height) and local +Z onto
 *  `normal` (its thickness points off the head), so local +X ends up across the webbing. */
function frameEuler(dir, normal) {
  const Y = vnorm(dir);
  let Z = vsub(normal, vmul(Y, vdot(normal, Y)));           // re-orthogonalise against the path
  Z = Math.hypot(Z.x, Z.y, Z.z) < 1e-6 ? vnorm(vcross(Y, v3(0, 0, 1))) : vnorm(Z);
  const X = vcross(Y, Z);
  const m13 = Z.x, m23 = Z.y, m33 = Z.z, m11 = X.x, m12 = Y.x, m22 = Y.y, m32 = Y.z;
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  return Math.abs(m13) < 0.9999999
    ? [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)]
    : [Math.atan2(m32, m22), ey, 0];
}

// Webbing lies this far off whatever surface it is on, skin or cloth.
const SKIN_GAP = 0.0015;
const LIFT_STEP = 0.0002, LIFT_CAP = 0.030;

/** Standoff for one point on the skull. Over a gaiter it is stepped outward until a plate of
 *  `thick` lying there keeps its INNER face clear of the cloth — stepped rather than solved because
 *  the cloth surface is piecewise and the strap's normal is not radial. */
function standoffAt(q, n, thick, overMask) {
  let off = thick * 0.5 + SKIN_GAP;
  if (!overMask) return off;
  while (off < LIFT_CAP && maskDepth(vadd(q, vmul(n, off - thick * 0.5))) > -SKIN_GAP) off += LIFT_STEP;
  return off;
}

/** Standoffs for a whole path. Each sample is cleared on its own, then every chord midpoint is
 *  re-tested and both ends of any segment still cutting in are raised: a straight segment between
 *  two cleared points still sags into a convex surface. Repeats until a pass moves nothing. */
function liftOffsets(pts, thick, overMask) {
  const off = pts.map((p) => standoffAt(p.q, p.n, thick, overMask));
  if (!overMask) return off;
  const inner = (i) => vadd(pts[i].q, vmul(pts[i].n, off[i] - thick * 0.5));
  const raise = (i) => (off[i] >= LIFT_CAP ? false : (off[i] += LIFT_STEP, true));
  for (let pass = 0; pass < 64; pass++) {
    let moved = false;
    for (let i = 1; i < pts.length; i++) {
      if (maskDepth(vmul(vadd(inner(i - 1), inner(i)), 0.5)) <= -SKIN_GAP) continue;
      moved = raise(i - 1) || moved;
      moved = raise(i) || moved;
    }
    if (!moved) break;
  }
  return off;
}

function strapOnHead(id, samples, { width = 0.017, thick = 0.005, role = 'rubber', mirror = false,
  overMask = false } = {}) {
  const base = samples.map(([t, y]) => {
    const tt = mirror ? 1 - t : t;
    return { q: headPoint(tt, y), n: headNormal(tt, y) };
  });
  const off = liftOffsets(base, thick, overMask);
  const pts = base.map((b, i) => ({ p: vadd(b.q, vmul(b.n, off[i])), n: b.n }));
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = vsub(b.p, a.p);
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 1e-4) continue;
    const mid = vmul(vadd(a.p, b.p), 0.5);
    out.push({
      id: `${id}${mirror ? 'L' : ''}${i}`, anchor: 'head', type: 'rbox', role,
      position: [r5(mid.x), r5(mid.y), r5(mid.z)],
      rotation: frameEuler(d, vnorm(vadd(a.n, b.n))).map(r5),
      // + thick of length so consecutive segments overlap at each kink instead of leaving a gap
      size: [width, r5(len + thick), thick], bevel: 0.0012,
    });
  }
  return out;
}

// FRONT LEG — down from under the shell's front run to the point between the ear muff and the eye.
// The eye sits at turn 0.074 and the muff at 0.25, so the leg lands at 0.155: between them, which is
// what the reference shows and what the muff needs in order not to be strapped over.
const STRAP_FRONT = [[0.185, 0.038], [0.175, 0.012], [0.163, -0.016], [0.155, -0.042]];
// REAR LEG — out of the bottom step at the back (the rear run sits at y -0.026, spanning turn
// 0.38..0.62) and forward around the jaw. It passes BELOW the muff, whose underside is at y -0.045.
const STRAP_REAR = [[0.395, -0.032], [0.340, -0.048], [0.270, -0.058], [0.205, -0.056], [0.160, -0.048]];
// CHIN — from the junction where the two legs meet, forward under the jaw to the chin cup.
const STRAP_CHIN = [[0.155, -0.050], [0.110, -0.070], [0.060, -0.086], [0.010, -0.094]];

/** The whole retention assembly. `overMask` re-solves it onto the gaiter instead of the skin — one
 *  generator, so the worn-over-a-mask variant cannot drift from the bare one when a path is retuned. */
function soldierStraps(overMask = false) {
  const o = { overMask };
  return [
    ...strapOnHead('strapFront', STRAP_FRONT, o), ...strapOnHead('strapFront', STRAP_FRONT, { ...o, mirror: true }),
    ...strapOnHead('strapRear', STRAP_REAR, o), ...strapOnHead('strapRear', STRAP_REAR, { ...o, mirror: true }),
    ...strapOnHead('strapChin', STRAP_CHIN, { ...o, width: 0.019 }),
    ...strapOnHead('strapChin', STRAP_CHIN, { ...o, width: 0.019, mirror: true }),
    // ANCHOR TABS joining each rear leg to the shell's bottom step. The webbing runs on the SKULL and
    // the shell's rear edge is ~21 mm further out and 6 mm higher, so the leg's top end otherwise
    // stops in mid-air under the helmet — connected in intent, not in geometry. Computed BETWEEN the
    // two surfaces rather than placed, so it stays joined if either the rim or the strap path moves.
    ...[false, true].map((m) => {
      const t = m ? 1 - STRAP_REAR[0][0] : STRAP_REAR[0][0];
      const y = STRAP_REAR[0][1];
      const n = headNormal(t, y);
      const q = headPoint(t, y);
      const a = vadd(q, vmul(n, overMask ? standoffAt(q, n, 0.006, true) : 0.004));
      const b = helmetEdgePoint(t);
      const d = vsub(b, a);
      const mid = vmul(vadd(a, b), 0.5);
      return { id: 'strapAnchor' + (m ? 'L' : ''), anchor: 'head', type: 'rbox', role: 'rubber',
        position: [r5(mid.x), r5(mid.y), r5(mid.z)],
        rotation: frameEuler(d, n).map(r5),
        // overlength so it buries into the strap at one end and under the shell edge at the other
        size: [0.019, r5(Math.hypot(d.x, d.y, d.z) + 0.012), 0.006], bevel: 0.0015 };
    }),
    // Slider where the front and rear legs meet, which is what stops the junction reading as two
    // straps crossing in mid-air.
    ...[false, true].map((m) => {
      const t = m ? 1 - 0.157 : 0.157;
      const n = headNormal(t, -0.047), q = headPoint(t, -0.047);
      const p = vadd(q, vmul(n, overMask ? standoffAt(q, n, 0.008, true) : 0.006));
      return { id: 'strapSlider' + (m ? 'L' : ''), anchor: 'head', type: 'rbox', role: 'rubber',
        position: [r5(p.x), r5(p.y), r5(p.z)],
        rotation: frameEuler(v3(0, 1, 0), n).map(r5),
        size: [0.021, 0.014, 0.008], bevel: 0.002 };
    }),
  ];
}

const SOLDIER_STRAPS = soldierStraps();

export const SOLDIER_HELMET = [
  { id: 'helmetShell', anchor: 'head', type: 'dome', role: 'plate', radial: 40, seg: 18,
    scale: [1, 1, HELMET_Z_SCALE], profile: HELMET_SHELL_PROFILE, rim: HELMET_RIM, wall: 0.015 },
  // Side ARC rails, hugging the scallop edge rather than sitting on the widest line. In the
  // reference the rail follows the bottom edge for its whole length and is the most recognisable
  // feature of the silhouette after the shell — the shell radius at y 0.076 is 0.0961, so that is
  // where the inner face has to be.
  { id: 'helmetRail', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [0.0965, 0.076, 0.004], size: [0.010, 0.024, 0.116], bevel: 0.003, corner: 0.005 },
  { id: 'helmetRailL', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [-0.0965, 0.076, 0.004], size: [0.010, 0.024, 0.116], bevel: 0.003, corner: 0.005 },
  // Bolts through the rail ends, not floating on the shell above it.
  { id: 'helmetBolt', anchor: 'head', type: 'cylinder', role: 'metal',
    position: [0.0995, 0.076, 0.046], rotation: [0, 0, Math.PI / 2], size: [0.008, 0.008, 0.012], radial: 12 },
  { id: 'helmetBoltL', anchor: 'head', type: 'cylinder', role: 'metal',
    position: [-0.0995, 0.076, 0.046], rotation: [0, 0, Math.PI / 2], size: [0.008, 0.008, 0.012], radial: 12 },
  // NVG shroud on the forehead. The shell front at y 0.070 is z 0.1095 now that the z-stretch is
  // 1.12 rather than 1.20, so this moved in with it.
  { id: 'helmetShroud', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [0, 0.070, 0.1150], size: [0.038, 0.030, 0.026], bevel: 0.004, corner: 0.006 },
  { id: 'helmetShroudLip', anchor: 'head', type: 'rbox', role: 'metal',
    position: [0, 0.070, 0.1285], size: [0.026, 0.021, 0.010], bevel: 0.002 },
  // Retention dial on the nape, sitting on the shell's own rear drop — there is no skirt to mount
  // it to any more because the rim goes down there itself.
  { id: 'helmetDial', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [0, 0.022, -0.1125], rotation: [Math.PI / 2, 0, 0], size: [0.022, 0.022, 0.016], radial: 14 },

  // ---- headset ----
  // Ear cups over the ears (x +-0.088, y -0.027..0.019). The skull is 90.4 mm there, so the cup's
  // inner face sits at 0.089 — against the head — and it stands 30 mm proud of it.
  { id: 'helmetCup', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [0.1040, -0.002, -0.012], rotation: [0, 0, Math.PI / 2],
    size: [0.043, 0.043, 0.030], radial: 18 },
  { id: 'helmetCupL', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [-0.1040, -0.002, -0.012], rotation: [0, 0, Math.PI / 2],
    size: [0.043, 0.043, 0.030], radial: 18 },
  // Softer seal ring, wider than the cup, sitting against the head.
  { id: 'helmetCupPad', anchor: 'head', type: 'cylinder', role: 'cloth',
    position: [0.0930, -0.002, -0.012], rotation: [0, 0, Math.PI / 2],
    size: [0.047, 0.047, 0.014], radial: 18 },
  { id: 'helmetCupPadL', anchor: 'head', type: 'cylinder', role: 'cloth',
    position: [-0.0930, -0.002, -0.012], rotation: [0, 0, Math.PI / 2],
    size: [0.047, 0.047, 0.014], radial: 18 },
  // Arm joining each cup up to the helmet rail.
  { id: 'helmetCupArm', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [0.1020, 0.036, -0.010], size: [0.012, 0.048, 0.026], bevel: 0.003 },
  { id: 'helmetCupArmL', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [-0.1020, 0.036, -0.010], size: [0.012, 0.048, 0.026], bevel: 0.003 },
  // ---- boom mic, as a CONNECTED chain off the left cup ----
  // Every piece here is placed from the previous piece's END, not typed as a plausible-looking
  // coordinate. A cylinder's `position` is its CENTRE and its axis is local +Y after `rotation`, so
  // a link that looks joined in the numbers can still be metres apart in the render: the previous
  // version's rod ran up and forward from (-0.114, -0.056, 0.001) to (-0.066, -0.016, 0.091), which
  // started 13 mm outside the cup rim and ended 54 mm above the tip sphere sitting at y -0.070.
  //
  // Chain: boss on the cup face -> arm 1 -> elbow -> arm 2 -> capsule at the mouth corner.
  // Each rotation is solved for, not guessed: for Euler XYZ with the middle angle 0, local +Y is
  // (-sin z, cos x cos z, sin x cos z), so z = -asin(dx) and x = atan2(dz, dy) / cos z.
  //
  // Hinge boss, on the cup's outer face at 40 deg below the forward horizontal — 38 mm out from the
  // cup's 43 mm rim, so it sits ON the face rather than straddling the edge.
  { id: 'helmetBoomBoss', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [-0.1150, -0.0264, 0.0171], rotation: [0, 0, Math.PI / 2],
    size: [0.010, 0.010, 0.014], radial: 12 },
  // Arm 1: boss (-0.112, -0.029, 0.021) -> elbow (-0.088, -0.048, 0.080). Length 66.5 mm.
  { id: 'helmetBoom', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [-0.1000, -0.0385, 0.0505], rotation: [1.8825, 0, -0.3696],
    size: [0.005, 0.005, 0.0665], radial: 8 },
  // Elbow ball, covering the kink where the two arms meet.
  { id: 'helmetBoomJoint', anchor: 'head', type: 'sphere', role: 'rubber',
    position: [-0.0880, -0.0480, 0.0800], size: [0.0058], radial: 10, seg: 8 },
  // Arm 2: elbow -> mouth corner (-0.045, -0.056, 0.101). Swings hard inboard, which is what makes
  // a boom read as a boom; the face there is at z 0.077, so it runs 24 mm clear of the cheek.
  { id: 'helmetBoom2', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [-0.0665, -0.0520, 0.0905], rotation: [1.9350, 0, -1.0892],
    size: [0.0045, 0.0045, 0.0485], radial: 8 },
  // Mic capsule, on arm 2's axis and overlapping its end by 2 mm. Mouth is at y -0.062, and with a
  // face mask on the cloth reaches z 0.084 here — so this clears that too.
  { id: 'helmetBoomTip', anchor: 'head', type: 'cylinder', role: 'rubber',
    position: [-0.0379, -0.0573, 0.1045], rotation: [1.9350, 0, -1.0892],
    size: [0.009, 0.009, 0.020], radial: 12 },
  // Team patch on the shell, the same trick as the carrier's name tape.
  { id: 'helmetPatch', anchor: 'head', type: 'rbox', role: 'accent',
    position: [0.064, 0.104, 0.052], rotation: [0.36, 0, -0.44], size: [0.044, 0.026, 0.010], bevel: 0.002 },
  ...SOLDIER_STRAPS,
  // Chin cup, closing the small gap where the two chin straps meet at the front. The skull is
  // 63.7 mm at y -0.094, so its front face at z 0.070 is where this has to sit.
  { id: 'helmetChinCup', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [0, -0.094, 0.058], size: [0.044, 0.018, 0.032], bevel: 0.004, corner: 0.008 },
];

// Wraparound shades, as TWO ANGLED PLATES rather than one lens.
//
// A flat lens cannot wrap. At the eye (x 0.036) the skull front is 92 mm, but at the temple
// (x 0.074) it is only 58 mm — the face falls away 34 mm across that span, so any single slab wide
// enough to cover the eyes stands ~46 mm off the temples and reads as a welding visor. Rotating each
// half 0.62 rad about Y swings its outer edge back onto the head: the outer corner then lands 16 mm
// proud and the inner corner 12 mm, which is a pair of glasses.
//
// A flat chord cannot grow without floating: the face is an ellipse, so widening a plate that clears
// the cheekbone pushes BOTH ends off the head. 80 mm is the practical ceiling — at 90 mm the outer
// corner runs past the widest part of the skull and hangs in air. Height is free, so most of the
// growth went there (36 -> 46 mm).
//
// The eyes are DELETED, not covered — see HIDDEN_BY_SHADES. The eyeball stands 2.9 mm proud of the
// skull and the catchlight 3.5 mm proud of that, so a lens close enough to read as glasses is always
// behind them. Pushing it forward instead needs +8 mm, which is the welding visor again.
export const SUNGLASSES = [
  // `pupil`, not `visor`. The visor role is driven by theme uniforms (visorColor/visorGain) and came
  // out amber — shooting glasses, not the dark shades in the reference — and it would change again
  // with every theme. `pupil` is a fixed near-black.
  { id: 'shadeLens', anchor: 'head', type: 'rbox', role: 'pupil',
    position: [0.0435, 0.010, 0.0828], rotation: [0, 0.62, 0],
    size: [0.080, 0.046, 0.012], bevel: 0.003, corner: 0.010 },
  { id: 'shadeLensL', anchor: 'head', type: 'rbox', role: 'pupil',
    position: [-0.0435, 0.010, 0.0828], rotation: [0, -0.62, 0],
    size: [0.080, 0.046, 0.012], bevel: 0.003, corner: 0.010 },
  // Bridge over the nose, joining the two plates. Follows the lens inner edge, which the wider
  // plate carries 3 mm further inboard and 3 mm forward.
  { id: 'shadeBridge', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [0, 0.016, 0.100], size: [0.028, 0.011, 0.016], bevel: 0.002 },
  // Temple arms running back to the ear.
  { id: 'shadeArm', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [0.0855, 0.020, 0.026], size: [0.008, 0.011, 0.076], bevel: 0.002 },
  { id: 'shadeArmL', anchor: 'head', type: 'rbox', role: 'rubber',
    position: [-0.0855, 0.020, 0.026], size: [0.008, 0.011, 0.076], bevel: 0.002 },
];

// Neck gaiter pulled up over nose and mouth. A lathe wrapping the lower face, 5 mm off the skull the
// whole way — cloth over a jaw, not a cup stuck on a chin. Stops at y -0.014 so the ear stays clear.
export const FACE_MASK = [
  { id: 'maskWrap', anchor: 'head', type: 'lathe', role: 'cloth', radial: 24,
    scale: [1, 1, HEAD_Z_SCALE], profile: MASK_PROFILE },
  // Top hem, so the mask has an EDGE where it meets skin rather than fading out.
  { id: 'maskHem', anchor: 'head', type: 'torus', role: 'cloth',
    position: [0, MASK_HEM_Y, 0], rotation: [Math.PI / 2, 0, 0], scale: [1, HEAD_Z_SCALE, 1],
    size: [MASK_HEM_R, MASK_HEM_T], radial: 24, seg: 8 },
];

// ---- the helmet as worn OVER a gaiter -----------------------------------------------------------
// A mask swallowed the whole retention system: the chin legs sit 8 mm inside the cloth at their
// inner face, the rear legs 5 mm, and the chin cup is 21 mm in — completely gone. Straps go OVER a
// gaiter in reality, so the fix is to re-solve them against the cloth surface rather than to nudge
// coordinates: `soldierStraps(true)` steps each sample out until it clears (see liftOffsets), and
// the cup moves straight out by the cloth's own thickness at its height, keeping the 4 mm of
// proudness it has against bare skin.
const LIFTED_BY_MASK = new Set([...SOLDIER_STRAPS.map((g) => g.id), 'helmetChinCup']);
export const SOLDIER_HELMET_MASKED = [
  ...SOLDIER_HELMET.filter((g) => !LIFTED_BY_MASK.has(g.id)),
  ...soldierStraps(true),
  ...SOLDIER_HELMET.filter((g) => g.id === 'helmetChinCup').map((g) => ({
    ...g,
    position: [g.position[0], g.position[1],
      r5(g.position[2] + HEAD_Z_SCALE * maskStandoff(g.position[1]))],
  })),
];

// Dropped when the shades go on. All of these sit at or in front of the lens plane, so they poke
// through it; and none of them can be seen through an opaque lens anyway. The eyeball is mostly sunk
// in the skull, so removing it leaves skull surface rather than a hole.
const HIDDEN_BY_SHADES = new Set([
  'eyeballR', 'eyeballL', 'pupilR', 'pupilL', 'glintR', 'glintL', 'lidR', 'lidL',
]);

// The nose runs 16 mm below the mask's top hem and stands 4.5 mm proud of the cloth down there, so a
// masked head gets a skin-coloured tip poking through the gaiter. The nose CANNOT simply be pulled
// back — above the hem it is the face's strongest feature and shortening it flattens the profile.
// Instead the extrusion outline is cut at the hem and the lower half repainted `cloth`, which turns
// the poke-through into what it should have been: fabric tented over the bridge of the nose.
const MASK_TOP_Y = -0.014;
const NOSE_SEAM = 0.003;   // halves overlap ACROSS the cut, so no gap opens at the join

// Sutherland-Hodgman against one horizontal line. The outline is a closed polygon in the extrusion's
// own 2D space, where y is world y — see the `nose` piece in makeHumanHead.
function clipOutline(outline, y, keepAbove) {
  const inside = (p) => (keepAbove ? p[1] >= y : p[1] <= y);
  const out = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (y - a[1]) / (b[1] - a[1]);
      out.push([r5(a[0] + t * (b[0] - a[0])), y]);
    }
  }
  // Drop coincident vertices: a cut landing exactly on a corner emits it twice, and ExtrudeGeometry
  // turns the zero-length edge into degenerate triangles.
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
}

function splitNoseForMask(gear) {
  return gear.flatMap((g) => (g.id === 'nose' && g.outline ? [
    { ...g, id: 'noseTop', outline: clipOutline(g.outline, MASK_TOP_Y - NOSE_SEAM, true) },
    { ...g, id: 'noseMasked', role: 'cloth',
      outline: clipOutline(g.outline, MASK_TOP_Y + NOSE_SEAM, false) },
  ] : [g]));
}

/**
 * Head kit on top of a design. `helmet`, `glasses` and `mask` are independent, so all eight
 * combinations are reachable.
 */
export function withHeadKit(design, { helmet = false, glasses = false, mask = false } = {}) {
  const extra = [
    ...(helmet ? (mask ? SOLDIER_HELMET_MASKED : SOLDIER_HELMET) : []),
    ...(glasses ? SUNGLASSES : []),
    ...(mask ? FACE_MASK : []),
  ];
  if (!extra.length) return design;
  let base = design.gear || [];
  if (glasses) base = base.filter((g) => !HIDDEN_BY_SHADES.has(g.id));
  if (mask) base = splitNoseForMask(base);
  return { ...design, gear: [...base, ...extra] };
}

/**
 * Swap a design's head for the human one. Every `anchor: 'head'` piece is dropped, so this composes
 * with any body/pack add-ons — they hang off the torso and are left alone.
 */
export function withHumanHead(design, opts = {}) {
  const body = (design.gear || []).filter((g) => g.anchor !== 'head');
  return {
    ...design,
    ...humanHeadShape(opts.scale ?? 1),
    roles: { ...(design.roles || null), head: 'skin' },
    gear: [...makeHumanHead(opts), ...body],
  };
}
