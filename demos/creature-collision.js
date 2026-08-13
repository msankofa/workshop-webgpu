// CPU twin of the creature's distance field, for collision only.
//
// WHY THIS EXISTS. Resolving "the blob must not enter the body" needs the body's distance AT THE
// BLOB CENTRE. A fragment shader cannot ask for that: the answer is needed inside the same `map`
// function that would have to supply it, and shaders do not recurse. So the contact is solved once
// per frame on the CPU and the result is handed to the shader as four plain uniforms — a corrected
// centre, a dent depth, a contact normal, and a squash factor.
//
// This is the SAME hand-synced-twin pattern as `forest-cull.js`, `light-cluster.js` and
// `post-grade.js` one directory up, and it carries the same caveat: nothing enforces that this
// agrees with the TSL in `demos/sdf-creature.html`. Edit one, edit the other.
//
// DELIBERATELY COARSER THAN THE SHADER. Legs, body, horns and eye. No mouth cut, no tooth, no idle
// dent. A collision proxy is allowed to be simpler than the render surface — that is what collision
// proxies have always been — and every feature left out is one less thing that can drift. The
// visible consequence is that the blob will not sink into the mouth opening, which is a better
// failure than the blob catching on a 3 cm tooth.
//
// No three.js import: plain numbers and arrays, so `test-demo-creature-sdf.mjs` can run it in Node.

// ---------------------------------------------------------------------------
// Primitives — transcribed from the TSL in sdf-creature.html, including its approximations.
// ---------------------------------------------------------------------------

// Matches `sdEllipsoid`: iq's bound, which under-estimates rather than over-estimates.
export function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return (k0 * (k0 - 1)) / Math.max(k1, 1e-5);
}

// Matches `sdRoundCone`, branches included. `step(edge, v)` is 1 when v >= edge, which is the sense
// the two mix() calls in the shader depend on — getting it backwards silently rounds off the tip.
export function sdRoundCone(x, y, z, r1, r2, h) {
  const b = (r1 - r2) / h;
  const a = Math.sqrt(Math.max(1 - b * b, 0));
  const qx = Math.hypot(x, z), qy = y;
  const k = qx * -b + qy * a;
  const dBase = Math.hypot(qx, qy) - r1;
  const dTip = Math.hypot(qx, qy - h) - r2;
  const dSide = qx * a + qy * b - r1;
  const aboveTip = k >= a * h ? 1 : 0;
  const belowBase = 0 >= k ? 1 : 0;
  const sideOrTip = dSide + (dTip - dSide) * aboveTip;
  return sideOrTip + (dBase - sideOrTip) * belowBase;
}

// Matches `sminM`'s distance half (the material-id half has no meaning for collision).
export function smin(a, b, k) {
  const h = Math.min(Math.max(0.5 + ((b - a) * 0.5) / k, 0), 1);
  return b + (a - b) * h - k * h * (1 - h);
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

export const DEFAULT_PARAMS = {
  time: 0, bodyWidth: 1, legLen: 1, hornLen: 1, eyeSize: 1,
};

/** Signed distance to the collision proxy, in creature space. Negative inside. */
export function collisionSdf(x, y, z, params = DEFAULT_PARAMS) {
  const { time, bodyWidth: w, legLen, hornLen, eyeSize } = { ...DEFAULT_PARAMS, ...params };

  // The same idle bob and squash the shader applies before mapping. Skipping this would leave the
  // blob resting where the body was a fraction of a second ago, which reads as jitter at contact.
  const bob = Math.sin(time * 1.6) * 0.035;
  const squash = Math.sin(time * 1.6 + 0.6) * 0.028;
  const px = x / (1 + squash);
  const py = (y - bob) / (1 - squash);
  const pz = z / (1 + squash);

  let d = sdRoundCone(Math.abs(px) - 0.255 * w, py, pz - 0.02, 0.15, 0.118, 0.42 * legLen);

  const upper = sdEllipsoid(px, py - 1.02, pz, 0.60 * w, 0.66, 0.56 * w);
  const lower = sdEllipsoid(px, py - 0.56, pz, 0.50 * w, 0.40, 0.48 * w);
  d = smin(d, smin(upper, lower, 0.32), 0.15);

  // Horns: mirrored with abs(x), then rotZ(-0.30) followed by rotX(0.26), matching the shader's
  // nesting order. Swapping the two rotations moves the tips by centimetres.
  let hx = Math.abs(px) - 0.30 * w, hy = py - 1.40, hz = pz + 0.02;
  const cz = Math.cos(-0.30), sz = Math.sin(-0.30);
  [hx, hy] = [hx * cz - hy * sz, hx * sz + hy * cz];
  const cx = Math.cos(0.26), sx = Math.sin(0.26);
  [hy, hz] = [hy * cx - hz * sx, hy * sx + hz * cx];
  d = smin(d, sdRoundCone(hx, hy, hz, 0.10, 0.012, 0.34 * hornLen), 0.05);

  // Eye: a hard union in the shader too, so the blob meets a crisp edge here.
  const eye = Math.hypot(px - 0.10, py - 1.16, pz - 0.32 * w) - 0.30 * eyeSize;
  return Math.min(d, eye);
}

/** Unit surface normal, pointing out of the body. Central differences, 6 samples. */
export function collisionGradient(x, y, z, params = DEFAULT_PARAMS, e = 1e-3) {
  const gx = collisionSdf(x + e, y, z, params) - collisionSdf(x - e, y, z, params);
  const gy = collisionSdf(x, y + e, z, params) - collisionSdf(x, y - e, z, params);
  const gz = collisionSdf(x, y, z + e, params) - collisionSdf(x, y, z - e, params);
  const len = Math.hypot(gx, gy, gz);
  // Exactly at a local extremum the gradient vanishes. Straight up is an arbitrary but finite
  // choice, and it keeps every downstream normalisation out of NaN.
  if (!(len > 1e-9)) return [0, 1, 0];
  return [gx / len, gy / len, gz / len];
}

// ---------------------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------------------

// How far past contact a press is allowed to count. Without it, shoving the cursor out the far side
// of the creature reports a two-metre press and pins every deformation to its maximum.
const MAX_PENETRATION = 2.5;
// The dent is a displacement ADDED to the shader's field, so its gradient adds to the field's own.
// Past roughly this fraction of the blob radius the sum exceeds 1, the march starts overshooting,
// and holes open in the silhouette. This bound is what keeps the deformation safe; it is not taste.
const MAX_DENT_FRACTION = 0.6;
const TRACE_STEPS = 64;
const TRACE_EPS = 1e-4;

/** The no-contact state, for callers that place the blob directly (the static portrait cards). */
export function restingBlob(pos, blobR = 0.30) {
  return {
    pos: [pos[0], pos[1], pos[2]],
    contactN: [0, 1, 0],
    press: 0,
    dentAmt: 0,
    dentR: blobR * 2.2,
    squashS: 1,
    contact: false,
    t: 0,
  };
}

// Sphere-trace the blob's CENTRE along the cursor ray until the body is `clearance` away.
//
// Pushing the centre out along the body's gradient was the obvious first approach and it is wrong:
// deep inside a field built from smooth unions the gradient stops pointing at the nearest surface,
// and a centre dropped in the middle of the torso gets ejected downward through the legs. Tracing
// from the camera never evaluates the field deep inside, so it cannot be misled that way, and it is
// also the truer model — the cursor holds the blob on a stick, and the blob stops where it touches.
function traceToClearance(ro, rd, tMax, clearance, params) {
  let t = 0.02;
  for (let i = 0; i < TRACE_STEPS; i++) {
    if (t >= tMax) return tMax;
    const d = collisionSdf(ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t, params) - clearance;
    if (d < TRACE_EPS) return t;
    // 0.9 because the field can locally over-estimate distance by ~10% (see the gradient bound in
    // test-demo-creature-sdf.mjs); a full step could tunnel through a thin horn.
    t += Math.max(d * 0.9, 1e-3);
  }
  return Math.min(t, tMax);
}

/**
 * Where the blob actually ends up, and how both bodies deform to allow it.
 *
 * The requested press is split: the body gives `dentGain` of it and the blob is stopped short by the
 * rest, so the blob comes to rest exactly as deep as the dented surface has receded. At dentGain 0
 * the body is rigid and the blob sits tangent to it; at 1 the body absorbs the press and the blob
 * sinks in by the (capped) dent depth.
 *
 * @param {{ro:number[], rd:number[], t:number}} ray  camera origin, unit direction, requested depth
 * @returns {{pos:number[], contactN:number[], press:number, dentAmt:number, dentR:number, squashS:number, contact:boolean, t:number}}
 */
export function resolveBlob(ray, params = DEFAULT_PARAMS, opts = {}) {
  const { blobR = 0.30, dentGain = 0.5, squashGain = 0.55, collide = true } = opts;
  const { ro, rd, t: tWanted } = ray;
  const at = (t) => [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];

  if (!collide) return { ...restingBlob(at(tWanted), blobR), t: tWanted };

  // First pass against the undeformed body: how far did the cursor ask to go past contact?
  const tTouch = traceToClearance(ro, rd, tWanted, blobR, params);
  if (tTouch >= tWanted) return { ...restingBlob(at(tWanted), blobR), t: tWanted };

  const press = Math.min(tWanted - tTouch, blobR * MAX_PENETRATION);
  const dentAmt = Math.min(press, blobR * MAX_DENT_FRACTION) * dentGain;

  // Second pass: the dent has moved the surface, so the blob is allowed that much further in.
  const tFinal = dentAmt > 0
    ? traceToClearance(ro, rd, tWanted, blobR - dentAmt, params)
    : tTouch;

  const pos = at(tFinal);
  // Flatten against the contact. Floored at 0.35 so the blob never collapses into a disc.
  const squashS = Math.max(0.35, 1 - Math.min(press / blobR, 1) * squashGain * 0.6);

  return {
    pos,
    contactN: collisionGradient(pos[0], pos[1], pos[2], params),
    press,
    dentAmt,
    dentR: blobR * 2.2,
    squashS,
    contact: true,
    t: tFinal,
  };
}
