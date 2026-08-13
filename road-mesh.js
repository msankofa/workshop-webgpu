// road-mesh.js
// Turns a road centreline into geometry arrays. Same convention as bot-terrain.js's
// buildTerrainMeshArrays: pure functions returning typed arrays, so the vertex layout is
// unit-testable in Node and only the caller ever touches THREE. See docs/subsystems/roads.md.
//
// Roads are draped, not carved. Every vertex samples the ground at its own XZ and lifts by a few
// centimetres. Nothing about the terrain changes, which is why this works identically over a baked
// grid field, a closed-form one, or a GPU-displaced one.
//
// The catch, and the thing that cost two rounds of "the terrain is showing through the road":
// draping is only as good as the road's OWN tessellation. A ribbon with vertices every 0.9 m along
// and nothing at all across its 3.2 m width is a set of very large flat triangles laid over ground
// that bends every 0.5 m -- so its interior sags below terrain that its corners clear comfortably.
// Measured on the eroded-highlands preset, 26% of such a road's area sat under the ground, by up to
// 0.64 m against a 4 cm lift. Hence `surfaceCell`: no road quad spans more than one ground cell,
// in either direction. Clearing at the vertices is necessary and nowhere near sufficient.

import { cumulativeDistances, tangentAtInto } from './road-path.js';

export const ROAD_MESH_DEFAULTS = {
  coreLift: 0.06,        // m the paved surface sits above the ground it samples
  shoulderLift: 0.08,    // m for the feathered edge; above the core so they never z-fight
  // Target span of one road quad. Match it to the ground mesh's cell (bot-terrain's meshCell) so
  // the road bends wherever the ground does. Raising it above the ground cell reintroduces the
  // interior sag described above; the lift cannot save you from it.
  surfaceCell: 0.5,
  edgeJitter: 0.18,      // m of wobble on the paved edge, so the road is not a drafted ribbon
  shoulderMid: 0.48,     // shoulder waypoint, as a multiple of road width outward from the edge
  shoulderOuter: 0.92,   // where the shoulder has faded out entirely
  innerOverlap: 0.14,    // m the shoulder tucks back under the core, hiding the seam
  midAlpha: 0.42,        // opacity at the mid waypoint; the falloff shape lives in these two stops
  uvRepeat: 5.8,         // m of road per texture repeat along its length
};

// Deterministic per-sample wobble. Seeded off the edge id so a rebuild reproduces the same road,
// and smoothed across three samples so the edge undulates instead of buzzing.
function edgeJitterAt(seed, index, side) {
  return Math.sin(index * 1.734 + side * 11.91 + seed * 0.137) * 0.65
    + Math.sin(index * 0.431 + seed) * 0.35;
}
function smoothJitter(seed, index, side) {
  return edgeJitterAt(seed, index - 1, side) * 0.24
    + edgeJitterAt(seed, index, side) * 0.52
    + edgeJitterAt(seed, index + 1, side) * 0.24;
}
function seedFrom(id) {
  let sum = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum;
}

function smoothstep01(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

// Quad strip indices over `cols + 1` columns and `rows` samples, wound so the face points up.
// Column order must run left-to-right across the direction of travel, same as the core.
function stripIndices(cols, rows, out, offset = 0, stride = cols + 1) {
  let n = offset;
  for (let i = 0; i < rows - 1; i++) {
    for (let c = 0; c < cols; c++) {
      const a = i * stride + c, b = a + 1, d = a + stride, e = d + 1;
      out[n++] = a; out[n++] = d; out[n++] = b;
      out[n++] = b; out[n++] = d; out[n++] = e;
    }
  }
  return n;
}

// Second pass over a finished XZ lattice, writing each vertex's height.
//
// `ground.maxNear(x, z, r)` gives the highest the ground gets within r. Taking that rather than the
// height at the point is what guarantees a flat quad clears the ground INSIDE it -- a terrace lip
// or an erosion bank between two vertices otherwise cuts straight through the triangle spanning
// them. The radius has to be read off the lattice rather than assumed: a road's quads are not
// uniform, and on the outside of a turn they stretch to several times their nominal size. Reading
// each vertex's real neighbour distance is what finally took the last penetrations to zero; every
// fixed radius left slivers on the outside of tight curves.
// `col0`/`colCount` restrict it to one block of columns, for meshes whose row holds two strips that
// are not joined to each other (the shoulder's two sides): measuring a neighbour across the gap
// between them would read the whole road width as a span and lift the edges for no reason.
function dropOntoGround(positions, rows, stride, ground, lift, { col0 = 0, colCount = stride, coverage = 0.8 } = {}) {
  const at = (i, c) => (i * stride + col0 + c) * 3;
  const perRow = colCount;
  const span = (k0, k1) => Math.hypot(positions[k1] - positions[k0], positions[k1 + 2] - positions[k0 + 2]);
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < perRow; c++) {
      const k = at(i, c);
      let reach = 0;
      if (i > 0) reach = Math.max(reach, span(k, at(i - 1, c)));
      if (i < rows - 1) reach = Math.max(reach, span(k, at(i + 1, c)));
      if (c > 0) reach = Math.max(reach, span(k, at(i, c - 1)));
      if (c < perRow - 1) reach = Math.max(reach, span(k, at(i, c + 1)));
      positions[k + 1] = ground.maxNear(positions[k], positions[k + 2], reach * coverage) + lift;
    }
  }
}

// Hosts that have no envelope to offer (flat ground, or a field with no mesh behind it) get one
// that just answers the point height -- the geometry code never needs to know which it has.
export function groundFromHeightFn(heightAt) {
  return typeof heightAt === 'function'
    ? { heightAt, maxNear: (x, z) => heightAt(x, z) }
    : heightAt;
}

// Left/right paved edges per sample, each already dropped onto the ground at its own position.
// Shared by the core ribbon and the shoulder so the two cannot disagree about where the road ends.
function buildCrossSections(path, width, ground, o) {
  const seed = seedFrom(o.seed ?? 'road');
  const half = width * 0.5;
  const sections = [];
  const tangent = { x: 1, z: 0 };
  for (let i = 0; i < path.length; i++) {
    tangentAtInto(path, i, tangent);
    const nx = -tangent.z, nz = tangent.x;
    const leftJitter = o.edgeJitter > 0 ? smoothJitter(seed, i, 0) * o.edgeJitter : 0;
    const rightJitter = o.edgeJitter > 0 ? smoothJitter(seed, i, 1) * o.edgeJitter : 0;
    const lx = path[i].x + nx * (half + leftJitter), lz = path[i].z + nz * (half + leftJitter);
    const rx = path[i].x + nx * (-half + rightJitter), rz = path[i].z + nz * (-half + rightJitter);
    // Only XZ matters here; the heights every mesh actually uses are written by dropOntoGround.
    sections.push({ nx, nz, left: { x: lx, y: 0, z: lz }, right: { x: rx, y: 0, z: rz } });
  }
  return sections;
}

// The paved ribbon. Columns run left edge to right edge at `surfaceCell` spacing; the edge wobble
// lives in the outer columns and the interior ones interpolate between them, so the road keeps its
// ragged outline while its middle still follows the ground.
export function buildRoadCoreArrays(path, width, heightAt, opts = {}) {
  const o = { ...ROAD_MESH_DEFAULTS, ...opts };
  const ground = groundFromHeightFn(heightAt);
  const sections = opts.sections || buildCrossSections(path, width, ground, o);
  const rows = sections.length;
  const cols = Math.max(1, Math.ceil(width / Math.max(0.01, o.surfaceCell)));
  const perRow = cols + 1;
  const positions = new Float32Array(rows * perRow * 3);
  const uvs = new Float32Array(rows * perRow * 2);
  const indices = new Uint32Array(Math.max(0, rows - 1) * cols * 6);
  const distances = cumulativeDistances(path);

  for (let i = 0; i < rows; i++) {
    const { left, right } = sections[i];
    const v = distances[i] / o.uvRepeat;
    for (let c = 0; c <= cols; c++) {
      const t = c / cols;
      const x = left.x + (right.x - left.x) * t;
      const z = left.z + (right.z - left.z) * t;
      const k = (i * perRow + c) * 3;
      positions[k] = x;
      positions[k + 2] = z;
      uvs[(i * perRow + c) * 2] = t;
      uvs[(i * perRow + c) * 2 + 1] = v;
    }
  }
  dropOntoGround(positions, rows, perRow, ground, o.coreLift);
  stripIndices(cols, rows, indices);
  return { positions, uvs, indices, sections, cols, triangleCount: Math.max(0, rows - 1) * cols * 2 };
}

// The shoulder is described in NORMALISED width: t = 0 at the tuck under the core, t = 1 where it
// has faded out. Working in t rather than metres is what keeps the edge wobble from stretching a
// span past one ground cell -- jitter scales the whole side instead of shifting each stop, so the
// subdivision guarantee survives it. (It did not, the first time: a jittered first gap reached
// 0.9 m over a 0.5 m ground cell, and the terrain came through exactly there, at full opacity.)
function shoulderAlphaAtT(t, tMid, midAlpha) {
  if (t <= 0) return 1;
  if (t <= tMid) return 1 + (midAlpha - 1) * (t / Math.max(1e-6, tMid));
  return midAlpha * (1 - (t - tMid) / Math.max(1e-6, 1 - tMid));
}

// The feathered shoulder: one strip per side, subdivided to `surfaceCell` like the core. The band
// between the two sides is deliberately absent -- that gap is the road itself.
export function buildRoadShoulderArrays(path, width, heightAt, opts = {}) {
  const o = { ...ROAD_MESH_DEFAULTS, ...opts };
  const ground = groundFromHeightFn(heightAt);
  const sections = opts.sections || buildCrossSections(path, width, ground, o);
  const seed = seedFrom(o.seed ?? 'road');
  const rows = sections.length;
  const mid = width * o.shoulderMid, outer = width * o.shoulderOuter;
  const span = outer + o.innerOverlap;
  const tMid = (mid + o.innerOverlap) / Math.max(1e-6, span);
  // Enough columns that no span exceeds one ground cell even at full jitter, which stretches the
  // side by up to `jitterMax`.
  const jitterMax = 0.52;
  const steps = Math.max(2, Math.ceil((span + jitterMax) / Math.max(0.01, o.surfaceCell)));
  const perSide = steps + 1;
  const perRow = perSide * 2;
  const positions = new Float32Array(rows * perRow * 3);
  const uvs = new Float32Array(rows * perRow * 2);
  const alphas = new Float32Array(rows * perRow);
  const cols = perSide - 1;
  const indices = new Uint32Array(Math.max(0, rows - 1) * cols * 2 * 6);
  const distances = cumulativeDistances(path);
  // A dead-end road that just stopped would show a hard rectangular mouth; fade the shoulder out
  // over this distance instead. Junction ends keep full opacity so the patch can meet them.
  const fadeSpan = width * 0.55;
  const total = distances[distances.length - 1] || 0;

  for (let i = 0; i < rows; i++) {
    const s = sections[i];
    const jl = smoothJitter(seed, i, 2) * 0.52, jr = smoothJitter(seed, i, 3) * 0.52;
    let mouth = 1;
    if (o.fadeStart) mouth = Math.min(mouth, smoothstep01(distances[i] / fadeSpan));
    if (o.fadeEnd) mouth = Math.min(mouth, smoothstep01((total - distances[i]) / fadeSpan));
    const v = distances[i] / o.uvRepeat;

    for (let c = 0; c < perRow; c++) {
      // Columns run outermost-left -> road -> outermost-right, so the winding matches the core's.
      const onLeft = c < perSide;
      const step = onLeft ? perSide - 1 - c : c - perSide;
      const t = step / steps;
      // Jitter widens or narrows the whole side; every stop moves with it, so spacing stays bounded.
      const reach = span + (onLeft ? jl : jr);
      const lateral = -o.innerOverlap + reach * t;
      const base = onLeft ? s.left : s.right;
      const dir = onLeft ? 1 : -1;
      const x = base.x + s.nx * lateral * dir;
      const z = base.z + s.nz * lateral * dir;
      const k = (i * perRow + c) * 3;
      positions[k] = x;
      positions[k + 2] = z;
      uvs[(i * perRow + c) * 2] = c / (perRow - 1);
      uvs[(i * perRow + c) * 2 + 1] = v;
      const a = shoulderAlphaAtT(t, tMid, o.midAlpha);
      alphas[i * perRow + c] = a >= 1 ? mouth : a * mouth;
    }
  }

  dropOntoGround(positions, rows, perRow, ground, o.shoulderLift, { col0: 0, colCount: perSide });
  dropOntoGround(positions, rows, perRow, ground, o.shoulderLift, { col0: perSide, colCount: perSide });

  // Two independent strips over one vertex row, skipping the span between the sides.
  let n = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (const sideBase of [0, perSide]) {
      for (let c = 0; c < cols; c++) {
        const a = i * perRow + sideBase + c, b = a + 1, d = a + perRow, e = d + 1;
        indices[n++] = a; indices[n++] = d; indices[n++] = b;
        indices[n++] = b; indices[n++] = d; indices[n++] = e;
      }
    }
  }
  return { positions, uvs, alphas, indices, steps, triangleCount: n / 3 };
}

// A ground-following disc for a junction or a dead end: opaque out to `innerRatio` of the radius,
// then fading to nothing so the patch dissolves into the terrain rather than ending on a circle.
// Without it, three roads meeting at an angle leave visible corner gaps. Subdivided radially at
// `surfaceCell` for the same reason the ribbon is.
export function buildRoadPatchArrays(center, radius, heightAt, opts = {}) {
  const o = { ...ROAD_MESH_DEFAULTS, ...opts };
  const ground = groundFromHeightFn(heightAt);
  const segments = Math.max(8, o.segments || 28);
  const innerRatio = o.innerRatio ?? 0.62;
  const rings = Math.max(2, Math.ceil(radius / Math.max(0.01, o.surfaceCell)));
  const vertexCount = 1 + segments * rings;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const alphas = new Float32Array(vertexCount);
  const indices = new Uint32Array(segments * 3 + segments * (rings - 1) * 6);

  const ringStep = radius / rings;
  positions[0] = center.x;
  positions[1] = ground.maxNear(center.x, center.z, ringStep * 0.8) + o.coreLift;
  positions[2] = center.z;
  uvs[0] = 0.5; uvs[1] = 0.5;
  alphas[0] = 1;

  for (let ring = 0; ring < rings; ring++) {
    const t = (ring + 1) / rings;
    const r = radius * t;
    // Opaque across the middle, then a linear fade over the outer band.
    const alpha = t <= innerRatio ? 1 : 1 - (t - innerRatio) / Math.max(1e-6, 1 - innerRatio);
    const lift = alpha >= 1 ? o.coreLift : o.shoulderLift;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      const v = 1 + ring * segments + s;
      // Radial step or arc step, whichever is longer, is the span this vertex has to cover.
      const arc = (2 * Math.PI * r) / segments;
      positions[v * 3] = x;
      positions[v * 3 + 1] = ground.maxNear(x, z, Math.max(ringStep, arc) * 0.8) + lift;
      positions[v * 3 + 2] = z;
      uvs[v * 2] = 0.5 + Math.cos(a) * 0.5 * t;
      uvs[v * 2 + 1] = 0.5 + Math.sin(a) * 0.5 * t;
      alphas[v] = alpha;
    }
  }

  let n = 0;
  for (let s = 0; s < segments; s++) {
    const a = 1 + s, b = 1 + ((s + 1) % segments);
    indices[n++] = 0; indices[n++] = b; indices[n++] = a;
  }
  for (let ring = 0; ring < rings - 1; ring++) {
    const inner = 1 + ring * segments, outerBase = inner + segments;
    for (let s = 0; s < segments; s++) {
      const next = (s + 1) % segments;
      indices[n++] = inner + s; indices[n++] = inner + next; indices[n++] = outerBase + s;
      indices[n++] = outerBase + next; indices[n++] = outerBase + s; indices[n++] = inner + next;
    }
  }
  return { positions, uvs, alphas, indices, rings, triangleCount: n / 3 };
}

// Flat-shaded ground ribbons look wrong lit from the side, and the true geometric normal of a
// draped strip is noisy. Averaged face normals over the index buffer is what the terrain mesh does.
export function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[b] - positions[a], ay = positions[b + 1] - positions[a + 1], az = positions[b + 2] - positions[a + 2];
    const bx = positions[c] - positions[a], by = positions[c + 1] - positions[a + 1], bz = positions[c + 2] - positions[a + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}
