// A foot as a contact PATCH instead of a point: a round-box SDF fitted to the foot bones, plus the hull of
// the vertices that actually touch the floor. Pure — no THREE, no DOM. See `docs/subsystems/stadium.md`.

/** Covariance eigenvectors of a point cloud, largest spread first. */
function principalAxes(points, count) {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2]; }
  cx /= count; cy /= count; cz /= count;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    const x = points[i * 3] - cx, y = points[i * 3 + 1] - cy, z = points[i * 3 + 2] - cz;
    C[0] += x * x; C[1] += x * y; C[2] += x * z; C[4] += y * y; C[5] += y * z; C[8] += z * z;
  }
  C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
  for (let i = 0; i < 9; i++) C[i] /= count;
  const mul = (M, v) => [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
  const M = C.slice();
  const axes = [];
  // Deflation after each eigenvector, so the three come out mutually orthogonal.
  for (let k = 0; k < 3; k++) {
    let v = [0.5773502691896258, 0.5773502691896258, 0.5773502691896258];
    for (let it = 0; it < 128; it++) {
      const w = mul(M, v);
      const l = Math.hypot(w[0], w[1], w[2]);
      if (l < 1e-18) break;
      v = [w[0] / l, w[1] / l, w[2] / l];
    }
    axes.push(v);
    const w = mul(M, v);
    const lam = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] -= lam * v[i] * v[j];
  }
  return { center: [cx, cy, cz], axes };
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Re-orthogonalise, and replace any axis the deflation collapsed so the frame is always usable. */
function orthonormalise(axes) {
  const out = [];
  const seed = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let i = 0; i < 3; i++) {
    let v = axes[i] ? axes[i].slice() : [0, 0, 0];
    for (const u of out) {
      const d = dot3(v, u);
      v = [v[0] - u[0] * d, v[1] - u[1] * d, v[2] - u[2] * d];
    }
    let l = Math.hypot(v[0], v[1], v[2]);
    if (l < 1e-9) {
      for (const s of seed) {
        let c = s.slice();
        for (const u of out) { const d = dot3(c, u); c = [c[0] - u[0] * d, c[1] - u[1] * d, c[2] - u[2] * d]; }
        const cl = Math.hypot(c[0], c[1], c[2]);
        if (cl > 1e-6) { v = [c[0] / cl, c[1] / cl, c[2] / cl]; l = 1; break; }
      }
      if (l < 1e-9) v = seed[i];
    } else {
      v = [v[0] / l, v[1] / l, v[2] / l];
    }
    out.push(v);
  }
  // Right-handed, so the frame can be read as a rotation.
  if (dot3(cross3(out[0], out[1]), out[2]) < 0) out[2] = out[2].map(c => -c);
  return out;
}

/**
 * Fit an oriented round box to a point cloud.
 *
 * A round box rather than an ellipsoid because 32% of Stadium bones are flat cards with one extent of
 * literally zero — an ellipsoid has no way to be a card, a box with a rounding radius does.
 */
export function fitRoundBox(points, count, { radius = 0 } = {}) {
  if (!count) return { center: [0, 0, 0], axes: orthonormalise([]), half: [0, 0, 0], radius: Math.max(0, radius) };
  const { center, axes: raw } = principalAxes(points, count);
  const axes = orthonormalise(raw);
  const half = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const d = [points[i * 3] - center[0], points[i * 3 + 1] - center[1], points[i * 3 + 2] - center[2]];
    for (let a = 0; a < 3; a++) half[a] = Math.max(half[a], Math.abs(dot3(d, axes[a])));
  }
  const r = Math.max(0, radius);
  // The radius is carved out of the extents, or the box grows by it and the foot gets fatter than the mesh.
  return { center, axes, half: half.map(h => Math.max(0, h - r)), radius: r };
}

/** Exact signed distance to the fitted round box. Negative inside. */
export function sdRoundBox(box, x, y, z) {
  const d = [x - box.center[0], y - box.center[1], z - box.center[2]];
  const q = [
    Math.abs(dot3(d, box.axes[0])) - box.half[0],
    Math.abs(dot3(d, box.axes[1])) - box.half[1],
    Math.abs(dot3(d, box.axes[2])) - box.half[2],
  ];
  const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
  const inside = Math.min(Math.max(q[0], q[1], q[2]), 0);
  return outside + inside - box.radius;
}

/** Convex hull of 2-D points given as [[u, v, payload], …], monotone chain. */
function hull2(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cw = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cw(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cw(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** Keep at most `n` points, evenly spaced around the ring, so a 40-vertex sole does not cost 40 samples. */
function decimate(ring, n) {
  if (ring.length <= n) return ring;
  const out = [];
  for (let i = 0; i < n; i++) out.push(ring[Math.round((i * ring.length) / n) % ring.length]);
  return out;
}

/** The four corners of the box's downward face, in the box's own space. Null if that face has no area. */
export function boxSoleFace(box) {
  if (!box) return null;
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(box.axes[i][1]) > Math.abs(box.axes[k][1])) k = i;
  const down = box.axes[k][1] > 0 ? -1 : 1;
  const n = box.axes[k], u = box.axes[(k + 1) % 3], v = box.axes[(k + 2) % 3];
  const hn = (box.half[k] + box.radius) * down;
  const hu = box.half[(k + 1) % 3] + box.radius, hv = box.half[(k + 2) % 3] + box.radius;
  if (hu < 1e-9 || hv < 1e-9) return null;
  const samples = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    samples.push([
      box.center[0] + n[0] * hn + u[0] * hu * su + v[0] * hv * sv,
      box.center[1] + n[1] * hn + u[1] * hu * su + v[1] * hv * sv,
      box.center[2] + n[2] * hn + u[2] * hu * su + v[2] * hv * sv,
    ]);
  }
  return { samples, axis: k, down };
}

/**
 * Build a foot's contact proxy from the rest-pose vertices of its bones.
 *
 * `clouds` is one or more `{ points, count }` in rest WORLD space, the same shape `boneGeometry` returns.
 * Offsets come back relative to the sole centroid — the walker anchors the patch at the gait's foothold
 * and only borrows the shape, so turning this on changes the size of the support polygon and not where it
 * sits. `restWorld` is carried, not used here: it is what maps the offsets onto the live bone.
 */
export function buildFootProxy(clouds, opts = {}) {
  const { band = 0.35, minLow = 4, maxSamples = 8, restWorld = null, radiusFraction = 0.06,
    soleCentre = null, maxRadius = 0 } = opts;
  const parts = (Array.isArray(clouds) ? clouds : [clouds]).filter(p => p && p.count > 0);
  const empty = {
    ok: false, samples: [], box: null, restWorld, count: 0, span: 0,
    reason: parts.length ? 'degenerate' : 'no geometry',
  };
  if (!parts.length) return empty;

  const flat = [];
  for (const p of parts) for (let i = 0; i < p.count; i++) flat.push(p.points[i * 3], p.points[i * 3 + 1], p.points[i * 3 + 2]);
  const count = flat.length / 3;

  let span = 0;
  for (let a = 0; a < 3; a++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < count; i++) { const v = flat[i * 3 + a]; if (v < lo) lo = v; if (v > hi) hi = v; }
    span = Math.max(span, hi - lo);
  }
  const box = fitRoundBox(flat, count, { radius: span * radiusFraction });
  if (span < 1e-9) return { ...empty, box, count, span };

  // What can touch the floor is what sits within a BAND of the lowest vertex, not a fixed share of the
  // cloud: a fifth of a 12-vertex foot is two points, which hulls to a line on every quadruped here.
  const order = [];
  for (let i = 0; i < count; i++) order.push(i);
  order.sort((a, b) => flat[a * 3 + 1] - flat[b * 3 + 1]);
  let hiY = -Infinity, loY = Infinity;
  for (let i = 0; i < count; i++) { const v = flat[i * 3 + 1]; if (v < loY) loY = v; if (v > hiY) hiY = v; }
  const cut = loY + (hiY - loY) * band;
  let k = 0;
  while (k < count && flat[order[k] * 3 + 1] <= cut) k++;
  const low = order.slice(0, Math.min(count, Math.max(k, minLow)));

  let cx = 0, cy = 0, cz = 0;
  for (const i of low) { cx += flat[i * 3]; cy += flat[i * 3 + 1]; cz += flat[i * 3 + 2]; }
  cx /= low.length; cy /= low.length; cz /= low.length;
  // The caller's own sole point wins when it has one. `sole()` and this band pick different vertices, and
  // the walker anchors the patch at the foothold `sole()` produced — so centring on anything else would
  // hang the whole patch to one side of the foot it belongs to.
  if (soleCentre) { cx = soleCentre[0]; cz = soleCentre[2]; }

  const ring = decimate(hull2(low.map(i => [flat[i * 3], flat[i * 3 + 2], i])), maxSamples);
  let samples = ring.map(([, , i]) => [flat[i * 3] - cx, flat[i * 3 + 1] - cy, flat[i * 3 + 2] - cz]);
  let source = 'vertices';

  // A foot built from a vertical card hulls to a line, and the fitted box is the only thing left with a
  // width: its rounding radius is the thickness the card does not carry.
  if (samples.length < 3) {
    const face = boxSoleFace(box);
    if (!face) return { ...empty, box, count, span, reason: 'sole hulls to fewer than 3 points' };
    // Re-centred on the sole like the vertex path, or the patch sits wherever the box happens to be and
    // the whole foot is displaced from the foothold it is anchored to.
    samples = face.samples.map(s => [s[0] - cx, s[1] - cy, s[2] - cz]);
    source = 'box';
  }

  let radius = 0;
  for (const s of samples) radius = Math.max(radius, Math.hypot(s[0], s[2]));
  if (radius < 1e-9) return { ...empty, box, count, span, reason: 'sole has no horizontal extent' };

  // Bounded against the leg it hangs off, because the auto-mapper's "foot" is only ever the last bone in
  // the chain: Sandshrew's owns geometry wider than its whole leg, and an unbounded patch there would let
  // it balance on anything. Scaled rather than clipped, so the shape survives, and flagged so it shows.
  let capped = false;
  if (maxRadius > 0 && radius > maxRadius) {
    const k = maxRadius / radius;
    for (const s of samples) { s[0] *= k; s[1] *= k; s[2] *= k; }
    radius = maxRadius;
    capped = true;
  }
  return {
    ok: true, samples, box, restWorld, count, span, radius, capped,
    centroid: [cx, cy, cz], source, reason: null,
  };
}

/** Area of the patch in the horizontal plane, which is what the support polygon actually gains. */
export function patchArea(proxy) {
  const s = proxy?.samples;
  if (!s || s.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < s.length; i++) {
    const p = s[i], q = s[(i + 1) % s.length];
    a += p[0] * q[2] - q[0] * p[2];
  }
  return Math.abs(a) * 0.5;
}
