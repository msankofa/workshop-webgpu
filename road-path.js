// road-path.js
// Centreline math for spline roads: curve evaluation, ground-following sampling, and the
// point-to-polyline queries the network and the spatial index both need. Ported from the
// TypeScript original (SeloSlav/spline-based-procedural-dirt-road-system, MIT).
//
// Everything here works on plain {x, y, z} objects rather than THREE.Vector3, so the whole
// road stack is testable in Node without a GPU. See docs/subsystems/roads.md.

// Centripetal Catmull-Rom, matching THREE.CatmullRomCurve3's non-uniform formulation. Centripetal
// (alpha 0.5) is the parameterisation that will not loop or cusp when two control points sit close
// together, which a hand-drawn road does constantly.
const CENTRIPETAL_POW = 0.25;   // three uses 0.25 for centripetal, 0.5 for chordal

function cubicCoefficients(x0, x1, t0, t1) {
  return [x0, t0, -3 * x0 + 3 * x1 - 2 * t0 - t1, 2 * x0 - 2 * x1 + t0 + t1];
}

// Tangents from the four surrounding knots, scaled by the middle span so uneven spacing does not
// throw the curve wide on the long side.
function nonUniformCoefficients(x0, x1, x2, x3, dt0, dt1, dt2) {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  return cubicCoefficients(x1, x2, t1 * dt1, t2 * dt1);
}

function evalCubic(c, t) {
  return c[0] + c[1] * t + c[2] * t * t + c[3] * t * t * t;
}

function mirrored(a, b) {
  return { x: 2 * a.x - b.x, y: 2 * a.y - b.y, z: 2 * a.z - b.z };
}

// Point at normalised position `t` along the open Catmull-Rom through `points`.
export function curvePointAt(points, t, out = { x: 0, y: 0, z: 0 }) {
  const len = points.length;
  if (len === 0) return out;
  if (len === 1) { out.x = points[0].x; out.y = points[0].y; out.z = points[0].z; return out; }

  const p = (len - 1) * Math.min(1, Math.max(0, t));
  let index = Math.floor(p);
  let weight = p - index;
  if (weight === 0 && index === len - 1) { index = len - 2; weight = 1; }

  const p0 = index > 0 ? points[index - 1] : mirrored(points[0], points[1]);
  const p1 = points[index];
  const p2 = points[index + 1];
  const p3 = index + 2 < len ? points[index + 2] : mirrored(points[len - 1], points[len - 2]);

  let dt0 = Math.pow(distanceSq3(p0, p1), CENTRIPETAL_POW);
  let dt1 = Math.pow(distanceSq3(p1, p2), CENTRIPETAL_POW);
  let dt2 = Math.pow(distanceSq3(p2, p3), CENTRIPETAL_POW);
  // Coincident knots would divide by zero; three substitutes the neighbouring span.
  if (dt1 < 1e-4) dt1 = 1.0;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;

  out.x = evalCubic(nonUniformCoefficients(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2), weight);
  out.y = evalCubic(nonUniformCoefficients(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2), weight);
  out.z = evalCubic(nonUniformCoefficients(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2), weight);
  return out;
}

function distanceSq3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distanceXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function pathLengthXZ(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distanceXZ(points[i - 1], points[i]);
  return length;
}

export function cumulativeDistances(points, out = []) {
  out.length = points.length;
  out[0] = 0;
  for (let i = 1; i < points.length; i++) out[i] = out[i - 1] + distanceXZ(points[i - 1], points[i]);
  return out;
}

// Total turn angle over the polyline. Sampling density scales with this on top of length: a
// hairpin drawn from three points needs far more samples per metre than a straight run.
export function estimateCurvature(points) {
  let curvature = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const ax = points[i].x - points[i - 1].x, az = points[i].z - points[i - 1].z;
    const bx = points[i + 1].x - points[i].x, bz = points[i + 1].z - points[i].z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const dot = (ax * bx + az * bz) / (la * lb);
    curvature += Math.acos(Math.min(1, Math.max(-1, dot)));
  }
  return curvature;
}

// XZ tangent at a sample, from its neighbours. Roads are flat-normal ribbons -- the Y component is
// deliberately dropped so a steep hill does not roll the cross-section over.
export function tangentAtInto(path, index, out) {
  const prev = path[Math.max(0, index - 1)];
  const next = path[Math.min(path.length - 1, index + 1)];
  let x = next.x - prev.x, z = next.z - prev.z;
  const len = Math.hypot(x, z);
  if (len < 1e-3) { out.x = 1; out.z = 0; return out; }
  out.x = x / len; out.z = z / len;
  return out;
}

export function projectPointToSegmentXZ(point, a, b, out = { x: 0, y: 0, z: 0 }) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  let t = lengthSq <= 1e-6 ? 0 : ((point.x - a.x) * abx + (point.z - a.z) * abz) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return { point: out, distance: Math.hypot(point.x - out.x, point.z - out.z), t };
}

const polylineScratch = { x: 0, y: 0, z: 0 };
export function distancePointToPolylineXZ(x, z, path) {
  const probe = { x, y: 0, z };
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = projectPointToSegmentXZ(probe, path[i], path[i + 1], polylineScratch).distance;
    if (d < best) best = d;
  }
  return best;
}

// Nearest segment index plus the projected point, used when splitting an edge at a junction.
export function nearestPathIndex(path, point) {
  let bestIndex = 0, bestDistance = Infinity;
  let bestPoint = { x: path[0].x, y: path[0].y, z: path[0].z };
  for (let i = 0; i < path.length - 1; i++) {
    const projection = projectPointToSegmentXZ(point, path[i], path[i + 1]);
    if (projection.distance < bestDistance) {
      bestDistance = projection.distance;
      bestIndex = i;
      bestPoint = { ...projection.point };
    }
  }
  return { index: bestIndex, point: bestPoint, distance: bestDistance };
}

// Proper crossing of two XZ segments. The 0.02/0.98 guards reject endpoint grazes, which would
// otherwise split an edge at a node that already exists.
export function segmentIntersectionXZ(a, b, c, d) {
  const rX = b.x - a.x, rZ = b.z - a.z;
  const sX = d.x - c.x, sZ = d.z - c.z;
  const denom = rX * sZ - rZ * sX;
  if (Math.abs(denom) < 1e-5) return null;
  const cax = c.x - a.x, caz = c.z - a.z;
  const t = (cax * sZ - caz * sX) / denom;
  const u = (cax * rZ - caz * rX) / denom;
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
  return { point: { x: a.x + rX * t, y: a.y + (b.y - a.y) * t, z: a.z + rZ * t }, tA: t, tB: u };
}

// Drop control points closer than `minDistance` to the previous kept one. Endpoints always survive.
export function simplifyPath(points, minDistance) {
  if (points.length <= 2) return points.map(clonePoint);
  const result = [clonePoint(points[0])];
  for (let i = 1; i < points.length - 1; i++) {
    if (distanceXZ(points[i], result[result.length - 1]) >= minDistance) result.push(clonePoint(points[i]));
  }
  result.push(clonePoint(points[points.length - 1]));
  return result;
}

export function clonePoint(p) {
  return { x: p.x, y: p.y, z: p.z };
}

export const ROAD_SAMPLE_SPACING = 1.15;   // m between centreline samples on a placed road
// Was 240 and that was a silent quality cliff: a long road hit the cap and its samples spread out
// until its own triangles no longer followed the ground. Arena roads are tens of metres, so a
// ceiling this high only ever binds on something pathological.
const MAX_DIVISIONS = 2000;

// How many samples a control polyline earns: one per `spacing` metres, plus eight per radian of
// accumulated turn, clamped so a very long road cannot blow up the vertex count.
export function divisionsFor(points, spacing, maxDivisions = MAX_DIVISIONS) {
  const length = pathLengthXZ(points);
  const boost = estimateCurvature(points) * 8;
  return Math.min(maxDivisions, Math.max(8, Math.ceil(length / spacing + boost)));
}

// The core operation: evaluate the spline and snap every sample down onto the ground. `heightAt`
// is the only thing the road system needs to know about terrain, which is why any of our viewers
// can host it -- pass terrainField.heightAt and you are done.
export function samplePathOnGround(points, spacing, heightAt, opts = {}) {
  if (points.length < 2) return [];
  const divisions = divisionsFor(points, spacing, opts.maxDivisions);
  const out = Array.isArray(opts.out) ? opts.out : [];
  out.length = divisions + 1;
  const scratch = { x: 0, y: 0, z: 0 };
  for (let i = 0; i <= divisions; i++) {
    curvePointAt(points, i / divisions, scratch);
    const sample = out[i] || (out[i] = { x: 0, y: 0, z: 0 });
    sample.x = scratch.x;
    sample.z = scratch.z;
    sample.y = heightAt(scratch.x, scratch.z);
  }
  return out;
}
