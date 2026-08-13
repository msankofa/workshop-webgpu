// CPU twin of the bug-on-a-sprout distance field in demos/sdf-bug.html.
//
// WHY THIS EXISTS. The picture in that demo is solved entirely in a fragment shader, so nothing about
// it can be checked without a GPU and a pair of eyes — and its authoring mistakes are the kind a
// screenshot hides:
//
//   1. FEET THAT DO NOT TOUCH. Every foot's height is solved from the leaf rather than authored, so
//      the bug stands on the surface at any leg spread. Get the sign or the radius wrong and it
//      hovers a centimetre above, which at this framing reads as "the contact shadow looks soft".
//   2. OVERSHOOT HOLES. The shell's centre groove is a value ADDED to the field, so its gradient
//      stacks on the body's own. Once the sum passes 1 the march steps through the surface and
//      pinholes open — and they open in the busiest part of the image first, where they read as
//      detail rather than as a bug.
//   3. A MARCH THAT RUNS OUT. Rays that graze a large sphere tangentially are sphere tracing's worst
//      case and they stall, exhausting the loop bound and drawing backdrop where there is leaf.
//
// All three are arithmetic, so all three are asserted in Node by `test-demo-sdf-bug.mjs`.
//
// This is the same hand-synced-twin pattern as `creature-collision.js` next door and
// `forest-cull.js` / `light-cluster.js` / `post-grade.js` one directory up, and it carries the same
// caveat: nothing enforces that it agrees with the TSL. Edit one, edit the other.
//
// UNLIKE `creature-collision.js`, THIS TWIN IS NOT COARSE. That one is a collision proxy and is
// allowed to be simpler than the render surface. This one is a test oracle, so every part of the
// field that has a distance is here. What is absent is everything with no distance at all: the
// palette, the eye's painted iris and glints, the leaf's bump and sparkle, the subsurface term, the
// bokeh backdrop, the depth of field. None of those can move a surface, so none can break a march.
//
// HOW THE PRIMARY RAY IS TRACED, AND WHY IT IS NOT ONE MARCH
// ----------------------------------------------------------
// The obvious structure — sphere-trace `min(bug, leaf)` from the camera — is the one this demo
// started with, and it does not work here. The leaf is a 2.4-unit sphere seen from 2.6 units away, so
// a wide band of pixels crosses it at a glancing angle, and a ray tangent to a sphere of radius R
// passing at clearance e needs about 1.8 * sqrt(R/e) steps to get past it. At the silhouette that
// saturated the loop bound and painted backdrop over the edge of the leaf.
//
// So the leaf is not marched. It is a sphere, so its intersection is a quadratic, solved exactly and
// in constant time at any incidence angle. Only the bug is sphere-traced, bounded by BUG_BOUND, and
// the nearer of the two hits wins. Rays that hit neither bounding volume cost nothing at all, which
// is most of the frame.
//
// The consequence worth knowing: the leaf's surface variation cannot be a displacement of the field
// any more, because a displaced sphere is no longer a quadratic. It is a normal perturbation in the
// shader instead. That is not a compromise for this picture — the reference photo's sprout has a
// clean silhouette and all its texture in the shading.
//
// `sceneSdf` below is still the full field, and it is still what the normal, shadow, ambient
// occlusion and subsurface taps read. Those need a distance from an arbitrary point, which only an
// SDF gives. The acceleration is for the primary ray alone.
//
// No three.js import: plain numbers and arrays, so the test can run it in Node.

// ---------------------------------------------------------------------------
// Marching constants — the shader's, so the test can trace exactly as the GPU does.
// ---------------------------------------------------------------------------

/** Fraction of the reported distance the bug march advances per step. See MAX_GRADIENT. */
export const STEP_FACTOR = 0.85;
// Loop bound in the shader's bug march, which only ever runs inside BUG_BOUND. Generous, because it
// costs nothing: the loop breaks on the first hit, only the ~5% of pixels covering the bug enter it at
// all, and the average pixel spends two distance evaluations. What the headroom buys is the handful of
// rays that graze the bug's own silhouette tangentially and creep — with a tight bound those gave up
// mid-surface and punched a pixel of backdrop through the model.
export const MARCH_STEPS = 96;
/** Ray length past which the shader gives up and draws the backdrop. */
export const MAX_T = 14;
/** Surface threshold, scaled by t so distant surfaces are not chased to the same absolute error. */
export const HIT_EPS = 0.0011;

// The bug's field is not 1-Lipschitz: the shell groove is an added displacement, so its gradient
// stacks on the body's. STEP_FACTOR must be at most 1 / this or the march overshoots. The test
// measures the real figure over a dense shell around the surface and asserts it stays under.
// 0.85 * 1.17 = 0.995, so the margin is real but thin, and it is thin on purpose: every point of
// slack here is steps spent on a surface the march has already found.
export const MAX_GRADIENT = 1.17;

// ---------------------------------------------------------------------------
// Material ids
//
// ORDER MATTERS, for the reason sdf-creature.html documents at length: `sminM` blends the id along
// with the distance, and a linearly blended id walks through every palette entry between its two
// endpoints, painting bands of unrelated colour across the seam. SHELL and HEAD are 0 and 1 —
// adjacent — because theirs is the only union in this field whose id is blended. Every other union
// switches at the midpoint (`sminHard`, `opU`), so its position here is free.
// ---------------------------------------------------------------------------

export const ID_SHELL = 0;
export const ID_HEAD = 1;
export const ID_EYE = 2;
export const ID_LEG = 3;
export const ID_ANT = 4;
export const ID_SPROUT = 5;

// ---------------------------------------------------------------------------
// Primitives — transcribed from the TSL, approximations included.
// ---------------------------------------------------------------------------

export function sdSphere(x, y, z, r) {
  return Math.hypot(x, y, z) - r;
}

// iq's ellipsoid bound. Not a true distance; it under-estimates, which is what a march needs.
export function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return (k0 * (k0 - 1)) / Math.max(k1, 1e-5);
}

// A tapered capsule between two arbitrary points — the legs and the antennae. This is the shape
// sdf-creature.html's `sdRoundCone` cannot make: that one runs along +Y and would need a rotation per
// segment, and a leg is far easier to author as "hip here, knee there, foot on the ground".
//
// The plain form OVER-estimates by sqrt(1 + slope^2), because the true distance to a cone's flank is
// the perpendicular distance foreshortened by the flank's tilt. Over-estimating is the dangerous
// direction — it makes the march step past the surface however small STEP_FACTOR is — so the result
// is scaled by TAPER_SAFETY, which is 1/sqrt(1 + slope^2) at MAX_TAPER_SLOPE. The test asserts no
// segment in the model is steeper than that, which is what makes one constant legitimate for all of
// them.
export const MAX_TAPER_SLOPE = 0.25;
export const TAPER_SAFETY = 0.97;

export function sdSegTaper(p, a, b, ra, rb) {
  const px = p[0] - a[0], py = p[1] - a[1], pz = p[2] - a[2];
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const bb = bx * bx + by * by + bz * bz;
  const h = Math.min(Math.max((px * bx + py * by + pz * bz) / Math.max(bb, 1e-9), 0), 1);
  const dx = px - bx * h, dy = py - by * h, dz = pz - bz * h;
  return (Math.hypot(dx, dy, dz) - (ra + (rb - ra) * h)) * TAPER_SAFETY;
}

/** Taper slope of a segment, i.e. what TAPER_SAFETY has to cover. */
export function taperSlope(a, b, ra, rb) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return Math.abs(ra - rb) / Math.max(len, 1e-9);
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Distance half of a smooth union. Both id variants fuse the shape identically. */
export function sminD(a, b, k) {
  const h = Math.min(Math.max(0.5 + ((b - a) * 0.5) / k, 0), 1);
  return b + (a - b) * h - k * h * (1 - h);
}

/** Smooth union with a linearly blended id — legal only between adjacent palette slots. */
export function sminM(a, b, k) {
  const h = Math.min(Math.max(0.5 + ((b[0] - a[0]) * 0.5) / k, 0), 1);
  return [b[0] + (a[0] - b[0]) * h - k * h * (1 - h), b[1] + (a[1] - b[1]) * h];
}

/** Same fused shape, id switched at the midpoint. Everything that is not SHELL/HEAD uses this. */
export function sminHard(a, b, k) {
  const h = Math.min(Math.max(0.5 + ((b[0] - a[0]) * 0.5) / k, 0), 1);
  return [b[0] + (a[0] - b[0]) * h - k * h * (1 - h), h >= 0.5 ? a[1] : b[1]];
}

/** Hard union. Keeps ids discrete, so the eyeball rim and the leaf's edge stay crisp. */
export function opU(a, b) {
  return b[0] < a[0] ? b : a;
}

// ---------------------------------------------------------------------------
// Anatomy
//
// Every number the shader uses is here, so the two files can be diffed by eye. Positions are in bug
// space: +Z is forward (the head), +Y is up, and y = 0 is where the leaf's crown sits.
// ---------------------------------------------------------------------------

// Bearings are DERIVED and normalised rather than typed as decimals. Hand-rounded "unit" vectors are not
// unit: [0.532, 0.847] has length 1.000216, which is invisible in a render and made a dot product of two
// parallel directions come out as 1.0002 — enough to fail an exact check and to leave a slow drift in any
// angle computed from it.
const unit2 = (a, b) => { const m = Math.hypot(a, b); return [a / m, b / m]; };

/** Head-space x,z bearing of the root: forward and slightly inboard of the eye. */
export const ANTENNA_BEARING = unit2(0.343, 0.657);
/** How deep the root sits, as a fraction of the head's radii - i.e. just under the skin. */
export const ANTENNA_DEPTH = 0.9;
/** Floor on the root's horizontal bearing, so extreme elevations cannot pull it onto the midline. */
export const ANTENNA_RING_MIN = 0.55;
export const ANTENNA_HEIGHT_RANGE = [-0.7, 0.95];
/** Default elevation: on the face just below the eye, which is where the pose was tuned. */
export const ANTENNA_HEIGHT_DEFAULT = -0.15;
export const ANTENNA_CLEAR = 0.014;

// Shaft pitch, in radians, 0 being horizontal and positive up. The range and default are derived from the
// direction the shaft was authored at before this became a control, so opening the slider did not move
// the default pose — and the default is EXACTLY the old direction rather than approximately it.
const AUTHORED_DIR = [0.107, -0.040, 0.170];
export const ANTENNA_HORIZ = unit2(AUTHORED_DIR[0], AUTHORED_DIR[2]);
export const ANTENNA_ANGLE_RANGE = [-0.9, 0.9];
/** Hard cap on the corrected pitch: past this the shaft's horizontal bearing flips sign. */
const MAX_PITCH = Math.PI / 2 - 0.05;
export const ANTENNA_ANGLE_DEFAULT = Math.asin(AUTHORED_DIR[1] / Math.hypot(...AUTHORED_DIR));
/** Shaft length, also the authored one. */
export const ANTENNA_LEN = Math.hypot(...AUTHORED_DIR);

export const DEFAULT_ANATOMY = {
  time: 0,
  bodyWidth: 1,
  legSpread: 1,
  antennaLen: 1,
  antennaHeight: ANTENNA_HEIGHT_DEFAULT,
  antennaAngle: ANTENNA_ANGLE_DEFAULT,
  eyeSize: 1,
  grooveDepth: 0.01,
  sproutR: 2.4,
};

// Hip, knee, and the foot's position on the ground plane. The foot's HEIGHT is not authored — it is
// solved from the leaf, which is the only reason the bug stands on the surface rather than near it.
// `legSpread` scales x only: widening the stance is lateral, and scaling z as well would drag the
// front and rear feet out from under the body they are supposed to be carrying.
export const LEGS = [
  { hip: [0.150, 0.170, 0.290], knee: [0.290, 0.255, 0.415], foot: [0.345, 0.500], r: [0.033, 0.024, 0.010] },
  { hip: [0.175, 0.160, 0.045], knee: [0.345, 0.245, 0.080], foot: [0.420, 0.120], r: [0.033, 0.024, 0.010] },
  { hip: [0.165, 0.160, -0.180], knee: [0.320, 0.235, -0.320], foot: [0.385, -0.435], r: [0.031, 0.023, 0.010] },
];

/** How far the foot tip sinks into the leaf, as a fraction of its own radius. Reads as grip. */
export const FOOT_SINK = 0.35;

export const EYE = { at: [0.135, 0.288, 0.452], r: 0.086 };
export const HEAD = { at: [0, 0.262, 0.400], r: [0.175, 0.155, 0.140] };
export const ANTENNA = { r: [0.020, 0.028], tip: 0.030 };

// THE ANTENNA ROOT IS DERIVED FROM THE EYE, NOT AUTHORED.
//
// It was authored at first, at a fixed point 0.041 from the eye centre — inside an eyeball of radius
// 0.086 — so the antennae grew out of the eyes. Moving that one point would only have fixed it for one
// eye size, and `eyeSize` is a slider that goes to 1.5. So the root is now placed relative to the eye's
// SURFACE: it sits `ANTENNA_CLEAR` outside it, sliding along `ANTENNA_PUSH` as the eye grows.
//
// THE ROOT RIDES THE HEAD'S SURFACE, and `antennaHeight` is its ELEVATION on that surface rather than a
// vertical offset in world units. That reparameterisation is what makes a wide range possible at all.
//
// The first version added the height straight to the root's y, and it could not be opened up past 0.11:
// the root's x and z stayed put while y climbed, so it drove out through the top of the skull. The head
// is an ellipsoid 0.175 x 0.155 x 0.140, so climbing it means drawing in on x and z at the same time —
// which is exactly what an elevation angle does and a y offset cannot. Ranging over elevation, the root
// slides from the lower cheek to the crown and stays under the skin at every step by construction,
// because it is placed at a fixed fraction of the head's radius rather than at a fixed height.
//
// The horizontal bearing is fixed, and fixed forward on purpose: a root BEHIND the eye puts the eye in
// the shaft's path, since the shaft points forward. Clearing the root is not the same as clearing the
// antenna.
/**
 * Where the antenna root ends up, given the height slider and the eye size. Mirrored space, so x >= 0.
 *
 * Two steps, and the ORDER is what makes both sliders safe. The elevation places the root under the
 * head's skin, which no setting can escape because the position is a fraction of the head's own radii.
 * Then the eye clearance is re-enforced along whatever direction that produced, so a grown eyeball
 * pushes the root out of itself rather than swallowing it — the bug that shipped.
 */
export function antennaBase(params = DEFAULT_ANATOMY) {
  const a = { ...DEFAULT_ANATOMY, ...params };
  const e = a.antennaHeight;
  // Floored, then normalised. Without the floor the ring collapses toward the pole at extreme elevation
  // and drags the root onto the midline — 23 mm out at the top of the slider — which makes the eye subtend
  // a huge angle from the root and leaves the shaft nowhere to point. Normalising afterwards puts the
  // direction back on the unit sphere, so the root still lands exactly at ANTENNA_DEPTH of the head's radii
  // and cannot escape the skull however the floor distorts the bearing.
  const ring = Math.max(Math.sqrt(Math.max(1 - e * e, 0)), ANTENNA_RING_MIN);
  const raw = [ANTENNA_BEARING[0] * ring, e, ANTENNA_BEARING[1] * ring];
  const rl = Math.max(Math.hypot(...raw), 1e-9);
  const dir = raw.map((v) => v / rl);
  const root = HEAD.at.map((c, i) => c + dir[i] * ANTENNA_DEPTH * HEAD.r[i]);

  // Re-enforce the eye clearance.
  const v = root.map((p, i) => p - EYE.at[i]);
  const len = Math.max(Math.hypot(...v), 1e-5);
  const need = Math.max(len, EYE.r * a.eyeSize + ANTENNA_CLEAR);
  return EYE.at.map((c, i) => c + (v[i] / len) * need);
}

/**
 * Shaft direction. The pitch the slider asks for, CLAMPED OUT OF THE RANGE THAT AIMS AT AN EYE.
 *
 * Placing the root outside the eyeball is not enough once the pitch is adjustable. With both sliders
 * free, a low root pitched up — or a crown root pitched down — points the shaft straight back through the
 * eye, up to 57 mm deep. That is the same defect that shipped originally, reached by a different route.
 *
 * THE CORRECTION IS PITCH ONLY, AND THAT MATTERS. The first version rotated the shaft freely, in the
 * plane containing it and the eye, which is the smallest rotation that reaches tangency. It was wrong.
 * The eye is OUTBOARD of the root, so rotating away from it rotates inboard — and at extreme elevations
 * the root is nearly on the midline, so the shaft crossed x = 0. Everything paired in this model is drawn
 * with abs(x), so a shaft at negative x is really its own mirror image walking into the OPPOSITE eye:
 * measured 7 mm inside it, while a clearance metric that forgot to mirror cheerfully reported 33 mm of
 * room. Confining the correction to pitch keeps the horizontal bearing fixed and positive, so the shaft
 * can never reach the mirror plane at all, and the mirrored twin stays out of it for free.
 *
 * With the bearing fixed, the angle between the shaft and the eye is `M cos(pitch - psi) / W`, so the
 * pitches that hit the eye form one contiguous band and the fix is to clamp to whichever edge is nearer.
 * Closed form, no iteration, and it obeys the slider everywhere outside that band.
 */
export function antennaDir(params = DEFAULT_ANATOMY) {
  const a = { ...DEFAULT_ANATOMY, ...params };
  const len = ANTENNA_LEN * a.antennaLen;
  const root = antennaBase(a);
  const w = EYE.at.map((e, i) => e - root[i]);
  const W = Math.max(Math.hypot(...w), 1e-6);
  const R = EYE.r * a.eyeSize + ANTENNA_CLEAR;

  // dot(u(pitch), w) = P cos(pitch) + Q sin(pitch) = M cos(pitch - psi).
  const P = ANTENNA_HORIZ[0] * w[0] + ANTENNA_HORIZ[1] * w[2];
  const Q = w[1];
  const M = Math.hypot(P, Q);
  let pitch = a.antennaAngle;

  if (M > 1e-9) {
    // Tangency: dot(u, w) = sqrt(W^2 - R^2). W >= R is guaranteed by `antennaBase`, so this is real.
    const limit = Math.sqrt(Math.max(W * W - R * R, 0)) / M;
    if (limit < 1) {
      const psi = Math.atan2(Q, P);
      const half = Math.acos(Math.max(limit, -1));
      // Forbidden band is pitch within `half` of `psi`. Push to the nearer edge.
      let delta = pitch - psi;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      if (Math.abs(delta) < half) pitch = psi + (delta >= 0 ? half : -half);
    }
  }

  // The clamp above can push the pitch past a quarter turn, and past that `cos(pitch)` goes negative: the
  // shaft reverses its horizontal bearing, runs backward across x = 0, and the mirrored twin walks into the
  // opposite eye. So the pitch is held inside a quarter turn no matter what the avoidance asked for. Where
  // that is not enough — no forward pitch clears the eyeball at all — the antenna grazes rather than
  // clears, and only beyond the slider's own range; the test measures where that begins.
  pitch = Math.min(Math.max(pitch, -MAX_PITCH), MAX_PITCH);

  const c = Math.cos(pitch), s = Math.sin(pitch);
  return [ANTENNA_HORIZ[0] * c * len, s * len, ANTENNA_HORIZ[1] * c * len];
}

// Bounding sphere for the bug, and the only place its field is ever evaluated by the primary ray.
// If a slider pushes any part of the bug outside this, that part silently stops being drawn — so the
// test grows the model to the extremes of every slider and asserts the whole surface is still inside.
export const BUG_BOUND = { at: [0, 0.29, 0.1], r: 0.9 };

/** Body-wide idle bob. Applied to the body, head, eyes, antennae and hips — never to the feet. */
export function idleBob(time) {
  return Math.sin(time * 2.2) * 0.006;
}

/** Abdomen radius scale. The breath is in the shell, not in the stance. */
export function idleBreathe(time) {
  return 1 + Math.sin(time * 2.2) * 0.012;
}

// ---------------------------------------------------------------------------
// The leaf
//
// An exact sphere, tangent to y = 0 at the origin. Its texture is a normal perturbation in the
// shader, not a displacement here — see the header for why that is load-bearing rather than lazy.
// ---------------------------------------------------------------------------

export function sproutCenter(a) {
  return [0, -a.sproutR, 0];
}

export function sproutSdf(x, y, z, a) {
  return Math.hypot(x, y + a.sproutR, z) - a.sproutR;
}

/** Height of the leaf's crown above (x, z). Exact, because the leaf is exactly a sphere. */
export function sproutTopY(x, z, a) {
  const R = a.sproutR;
  return Math.sqrt(Math.max(R * R - x * x - z * z, 0)) - R;
}

/** Where a given leg's foot centre ends up, once the spread slider and the leaf are applied. */
export function footPos(leg, a) {
  const fx = leg.foot[0] * a.legSpread;
  const fz = leg.foot[1];
  // The tip is a ball of radius r[2]. Its centre sits (1 - FOOT_SINK) of a radius above the surface,
  // so FOOT_SINK of the ball is buried in the leaf.
  return [fx, sproutTopY(fx, fz, a) + leg.r[2] * (1 - FOOT_SINK), fz];
}

// ---------------------------------------------------------------------------
// The bug
// ---------------------------------------------------------------------------

/** The shell's centre groove. A displacement ADDED to the field, so it pushes the surface inward. */
export function shellGroove(x, y, z, a) {
  const gx = Math.exp(-((x / 0.07) ** 2));
  const gy = smoothstep(0.26, 0.52, y);
  const gz = smoothstep(0.3, 0.14, z) * smoothstep(-0.5, -0.26, z);
  return a.grooveDepth * gx * gy * gz;
}

/** Signed distance and material id of the bug alone, in bug space. Negative inside. */
export function bugSdf(x, y, z, params = DEFAULT_ANATOMY) {
  const a = { ...DEFAULT_ANATOMY, ...params };
  const w = a.bodyWidth;
  const bob = idleBob(a.time);
  const br = idleBreathe(a.time);
  const mx = Math.abs(x); // one expression makes both sides of everything paired

  // Shell: a big abdomen fused to a smaller pronotum, then the head fused onto that.
  const abdomen = sdEllipsoid(x, y - (0.33 + bob), z + 0.1, 0.285 * w * br, 0.255 * br, 0.36 * br);
  const pronotum = sdEllipsoid(x, y - (0.31 + bob), z - 0.22, 0.235 * w, 0.205, 0.16);
  let res = sminM([abdomen, ID_SHELL], [pronotum, ID_SHELL], 0.09);

  const head = sdEllipsoid(
    x - HEAD.at[0], y - (HEAD.at[1] + bob), z - HEAD.at[2],
    HEAD.r[0] * w, HEAD.r[1], HEAD.r[2],
  );
  res = sminM(res, [head, ID_HEAD], 0.055);

  // The groove, before anything crisp joins, so it cannot dent an eyeball.
  res = [res[0] + shellGroove(x, y - bob, z, a), res[1]];

  // Legs. The hip rides the bob, the knee gets less of it, the foot none at all.
  let legD = Infinity;
  for (const leg of LEGS) {
    const hip = [leg.hip[0], leg.hip[1] + bob, leg.hip[2]];
    const knee = [leg.knee[0] * a.legSpread, leg.knee[1] + bob * 0.45, leg.knee[2]];
    const foot = footPos(leg, a);
    const p = [mx, y, z];
    legD = Math.min(legD, sdSegTaper(p, hip, knee, leg.r[0], leg.r[1]));
    legD = Math.min(legD, sdSegTaper(p, knee, foot, leg.r[1], leg.r[2]));
  }
  res = sminHard(res, [legD, ID_LEG], 0.022);

  // Antennae: a widening club off the side of the head, with a ball on the end. The root rides the
  // head's surface at the elevation the height slider asks for, then is pushed clear of the eyeball.
  const root = antennaBase(a);
  const dir = antennaDir(a);
  const ab = [root[0], root[1] + bob, root[2]];
  const at = [
    ab[0] + dir[0] + Math.cos(a.time * 0.9) * 0.022 * a.antennaLen,
    ab[1] + dir[1] + Math.sin(a.time * 1.1) * 0.018 * a.antennaLen,
    ab[2] + dir[2],
  ];
  const antD = Math.min(
    sdSegTaper([mx, y, z], ab, at, ANTENNA.r[0], ANTENNA.r[1]),
    sdSphere(mx - at[0], y - at[1], z - at[2], ANTENNA.tip),
  );
  res = sminHard(res, [antD, ID_ANT], 0.018);

  // Eyes: hard union, so the dome keeps a crisp rim where it breaks the head's surface.
  const eye = sdSphere(mx - EYE.at[0], y - (EYE.at[1] + bob), z - EYE.at[2], EYE.r * a.eyeSize);
  return opU(res, [eye, ID_EYE]);
}

/**
 * The whole picture's field. This is what the normal, shadow, ambient-occlusion and subsurface taps
 * read — they ask for the distance from an arbitrary point, which only an SDF answers. The primary
 * ray does NOT use this; see `traceScene`.
 */
export function sceneSdf(x, y, z, params = DEFAULT_ANATOMY) {
  const a = { ...DEFAULT_ANATOMY, ...params };
  return opU(bugSdf(x, y, z, a), [sproutSdf(x, y, z, a), ID_SPROUT]);
}

/** Central-difference gradient magnitude. This is the number STEP_FACTOR has to survive. */
export function gradientMag(x, y, z, params = DEFAULT_ANATOMY, e = 2e-3) {
  const f = (px, py, pz) => bugSdf(px, py, pz, params)[0];
  const gx = f(x + e, y, z) - f(x - e, y, z);
  const gy = f(x, y + e, z) - f(x, y - e, z);
  const gz = f(x, y, z + e) - f(x, y, z - e);
  return Math.hypot(gx, gy, gz) / (2 * e);
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/**
 * Both roots of a ray against a sphere, or null. Assumes a unit ray direction. This is the whole of
 * the leaf's intersection and the whole of the bug's bounding test.
 */
export function sphereHit(ro, rd, c, r) {
  const ox = ro[0] - c[0], oy = ro[1] - c[1], oz = ro[2] - c[2];
  const b = ox * rd[0] + oy * rd[1] + oz * rd[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return null;
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}

/**
 * Sphere-trace the bug, and only inside its bounding sphere. Returns -1 for a miss.
 *
 * Starting at the bounding sphere's entry rather than at the camera is what keeps this cheap: the
 * field is only ever evaluated across 1.7 units of a well-conditioned model, never across the empty
 * space in front of it and never against the leaf.
 */
export function traceBug(ro, rd, params = DEFAULT_ANATOMY, stepFactor = STEP_FACTOR, steps = MARCH_STEPS) {
  const a = { ...DEFAULT_ANATOMY, ...params };
  const span = sphereHit(ro, rd, BUG_BOUND.at, BUG_BOUND.r);
  if (span === null || span[1] < 0) return { hit: false, t: -1, id: -1, steps: 0 };
  let t = Math.max(span[0], 0.001);
  const tEnd = Math.min(span[1], MAX_T);
  for (let i = 0; i < steps; i++) {
    if (t > tEnd) return { hit: false, t: -1, id: -1, steps: i };
    const [d, id] = bugSdf(ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t, a);
    if (d < HIT_EPS * t) return { hit: true, t, id, steps: i };
    t += d * stepFactor;
  }
  return { hit: false, t: -1, id: -1, steps };
}

/**
 * The primary ray, exactly as the shader solves it: an analytic hit for the leaf, a bounded march for
 * the bug, nearer wins. `evals` counts distance-function calls, which is the cost figure that
 * matters — a ray that hits neither bounding volume makes none at all.
 */
export function traceScene(ro, rd, params = DEFAULT_ANATOMY) {
  const a = { ...DEFAULT_ANATOMY, ...params };
  const bug = traceBug(ro, rd, a);
  const leaf = sphereHit(ro, rd, sproutCenter(a), a.sproutR);
  const tLeaf = leaf === null ? -1 : (leaf[0] > 0.001 ? leaf[0] : -1);

  if (bug.hit && (tLeaf < 0 || bug.t <= tLeaf)) {
    return { hit: true, t: bug.t, id: bug.id, evals: bug.steps + 1, what: 'bug' };
  }
  if (tLeaf > 0) return { hit: true, t: tLeaf, id: ID_SPROUT, evals: bug.steps, what: 'leaf' };
  return { hit: false, t: MAX_T, id: -1, evals: bug.steps, what: 'sky' };
}

/**
 * The naive trace the shader does NOT do: sphere-trace a field from the camera with no bounding
 * volume and no analytic shortcut. Kept only so the test can check `traceScene` against it.
 *
 * `field` picks which. 'bug' is the useful oracle: the bug's field is well conditioned, so a fine
 * march of it is trustworthy, and marching it from the camera rather than from BUG_BOUND is what makes
 * it an independent check of the bounding sphere too. 'scene' is only there to measure what the
 * all-in-one march used to cost — as an ORACLE it is worse than the quadratic it would be judging,
 * because a ray grazing a 2.4-unit sphere trips `HIT_EPS * t` long before the true tangent point and
 * sometimes when it never touches at all.
 *
 * `exhausted` is reported separately from `hit`, because running out of loop iterations part-way
 * through a scene is the specific failure that draws backdrop over a surface.
 */
export function marchNaive(ro, rd, params = DEFAULT_ANATOMY, opts = {}) {
  const { stepFactor = 0.16, steps = 4000, field = 'scene' } = opts;
  const a = { ...DEFAULT_ANATOMY, ...params };
  const f = field === 'bug' ? bugSdf : sceneSdf;
  let t = 0.05;
  for (let i = 0; i < steps; i++) {
    const [d, id] = f(ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t, a);
    if (d < HIT_EPS * t) return { hit: true, t, id, steps: i, exhausted: false };
    t += Math.max(d, 1e-5) * stepFactor;
    if (t > MAX_T) return { hit: false, t: MAX_T, id: -1, steps: i, exhausted: false };
  }
  return { hit: false, t, id: -1, steps, exhausted: true };
}

// ---------------------------------------------------------------------------
// Camera — the shader's, transcribed, so a test can ask what a pixel sees.
// ---------------------------------------------------------------------------

export const DEFAULT_VIEW = {
  yaw: -0.75,
  pitch: 0.1,
  dist: 2.55,
  target: [0, 0.3, 0],
  zoom: 2.35,
  framing: [-0.1, -0.16],
  aspect: 1.85,
};

/**
 * Ray for a pixel, given normalised device coordinates in [-1, 1]. Mirrors the `shaded` function line
 * for line: drift here would point the whole picture somewhere else.
 */
export function cameraRay(ndcX, ndcY, view = DEFAULT_VIEW) {
  const v = { ...DEFAULT_VIEW, ...view };
  const [tx, ty, tz] = v.target;
  const dx = Math.sin(v.yaw) * Math.cos(v.pitch);
  const dy = Math.sin(v.pitch);
  const dz = Math.cos(v.yaw) * Math.cos(v.pitch);
  const ro = [tx + dx * v.dist, ty + dy * v.dist, tz + dz * v.dist];
  const f = [-dx, -dy, -dz];

  // right = normalize(cross(fwd, (0,1,0))) = normalize((-f.z, 0, f.x))
  let r = [-f[2], 0, f[0]];
  const rl = Math.hypot(...r) || 1;
  r = [r[0] / rl, r[1] / rl, r[2] / rl];
  // up = cross(right, fwd)
  const up = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];

  const px = ndcX * v.aspect + v.framing[0];
  const py = ndcY + v.framing[1];
  const rd = [
    f[0] * v.zoom + r[0] * px + up[0] * py,
    f[1] * v.zoom + r[1] * px + up[1] * py,
    f[2] * v.zoom + r[2] * px + up[2] * py,
  ];
  const l = Math.hypot(...rd) || 1;
  return { ro, rd: [rd[0] / l, rd[1] / l, rd[2] / l] };
}
