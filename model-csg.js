// Constructive solid geometry for the model vocabulary.
//
// BSP-tree booleans (the classic csg.js algorithm) over BufferGeometry. This exists because there
// is otherwise NO WAY TO CUT A HOLE. Magazine wells, trigger guards, vents, bolt holes, eye sockets
// and recessed panels are all subtraction, and the usual fake — a dark surface piece laid on top —
// is exactly the defect visible in img2threejs's own showcase, where a recessed charging well read
// as a flat lid with a blob on it.
//
// BOOLEANS ARE NOT FREE THE WAY PRIMITIVES ARE. Output is non-indexed, triangle count grows with
// the cut, and coplanar faces fragment. The budget gate therefore runs after this stage, never on
// the base primitive.
//
// No THREE at module scope: the math is plain arrays, and THREE is injected only at the
// BufferGeometry boundary so this file stays testable headlessly.

const EPS = 1e-5;
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const neg3 = (a) => [-a[0], -a[1], -a[2]];

// Returns null for a degenerate triangle. Dropping them matters: a zero-area face has no usable
// plane, and one NaN plane poisons every split downstream.
function makePolygon(verts) {
  const c = cross3(sub3(verts[1].p, verts[0].p), sub3(verts[2].p, verts[0].p));
  const len = Math.hypot(c[0], c[1], c[2]);
  if (len < 1e-12) return null;
  const n = [c[0] / len, c[1] / len, c[2] / len];
  return { verts, plane: { n, w: dot3(n, verts[0].p) } };
}

function flipPolygon(poly) {
  poly.verts.reverse();
  for (const v of poly.verts) v.n = neg3(v.n);
  poly.plane = { n: neg3(poly.plane.n), w: -poly.plane.w };
}

// Splits `poly` against `plane`, pushing the pieces into the four output lists.
function splitPolygon(plane, poly, coplanarFront, coplanarBack, front, back) {
  let polyType = 0;
  const types = [];
  for (const v of poly.verts) {
    const t = dot3(plane.n, v.p) - plane.w;
    const type = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    polyType |= type;
    types.push(type);
  }
  if (polyType === COPLANAR) {
    (dot3(plane.n, poly.plane.n) > 0 ? coplanarFront : coplanarBack).push(poly);
  } else if (polyType === FRONT) {
    front.push(poly);
  } else if (polyType === BACK) {
    back.push(poly);
  } else {
    const f = [], b = [];
    for (let i = 0; i < poly.verts.length; i++) {
      const j = (i + 1) % poly.verts.length;
      const ti = types[i], tj = types[j];
      const vi = poly.verts[i], vj = poly.verts[j];
      if (ti !== BACK) f.push(vi);
      if (ti !== FRONT) b.push(ti !== BACK ? { p: vi.p.slice(), n: vi.n.slice() } : vi);
      if ((ti | tj) === SPANNING) {
        const t = (plane.w - dot3(plane.n, vi.p)) / dot3(plane.n, sub3(vj.p, vi.p));
        const v = { p: lerp3(vi.p, vj.p, t), n: lerp3(vi.n, vj.n, t) };
        f.push(v);
        b.push({ p: v.p.slice(), n: v.n.slice() });
      }
    }
    if (f.length >= 3) { const p = makePolygon(f); if (p) front.push(p); }
    if (b.length >= 3) { const p = makePolygon(b); if (p) back.push(p); }
  }
}

const newNode = () => ({ plane: null, front: null, back: null, polygons: [] });

function nodeBuild(node, polygons) {
  if (!polygons.length) return;
  if (!node.plane) node.plane = polygons[0].plane;
  const front = [], back = [];
  for (const p of polygons) splitPolygon(node.plane, p, node.polygons, node.polygons, front, back);
  if (front.length) { node.front = node.front || newNode(); nodeBuild(node.front, front); }
  if (back.length) { node.back = node.back || newNode(); nodeBuild(node.back, back); }
}

function nodeInvert(node) {
  for (const p of node.polygons) flipPolygon(p);
  if (node.plane) node.plane = { n: neg3(node.plane.n), w: -node.plane.w };
  if (node.front) nodeInvert(node.front);
  if (node.back) nodeInvert(node.back);
  const t = node.front; node.front = node.back; node.back = t;
}

// Removes the parts of `polygons` that lie inside this solid.
function nodeClipPolygons(node, polygons) {
  if (!node.plane) return polygons.slice();
  let front = [], back = [];
  for (const p of polygons) splitPolygon(node.plane, p, front, back, front, back);
  if (node.front) front = nodeClipPolygons(node.front, front);
  back = node.back ? nodeClipPolygons(node.back, back) : [];
  return front.concat(back);
}

function nodeClipTo(node, other) {
  node.polygons = nodeClipPolygons(other, node.polygons);
  if (node.front) nodeClipTo(node.front, other);
  if (node.back) nodeClipTo(node.back, other);
}

function nodeAllPolygons(node) {
  let out = node.polygons.slice();
  if (node.front) out = out.concat(nodeAllPolygons(node.front));
  if (node.back) out = out.concat(nodeAllPolygons(node.back));
  return out;
}

function treeFrom(polygons) {
  const n = newNode();
  nodeBuild(n, polygons.map((p) => ({ verts: p.verts.map((v) => ({ p: v.p.slice(), n: v.n.slice() })), plane: { n: p.plane.n.slice(), w: p.plane.w } })));
  return n;
}

export function polygonsFromGeometry(geo) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const index = geo.index ? geo.index.array : null;
  const count = index ? index.length : pos.length / 3;
  const polys = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const verts = [];
    for (let k = 0; k < 3; k++) {
      const vi = index ? index[i + k] : i + k;
      verts.push({
        p: [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]],
        n: nrm ? [nrm[vi * 3], nrm[vi * 3 + 1], nrm[vi * 3 + 2]] : [0, 0, 0],
      });
    }
    const poly = makePolygon(verts);
    if (!poly) continue;
    if (!nrm) for (const v of poly.verts) v.n = poly.plane.n.slice();
    polys.push(poly);
  }
  return polys;
}

export function geometryFromPolygons(THREE, polygons) {
  const pos = [], nrm = [];
  for (const poly of polygons) {
    for (let i = 2; i < poly.verts.length; i++) {
      const tri = [poly.verts[0], poly.verts[i - 1], poly.verts[i]];
      for (const v of tri) { pos.push(v.p[0], v.p[1], v.p[2]); nrm.push(v.n[0], v.n[1], v.n[2]); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return geo;
}

// Signed volume of the mesh as a closed solid. Positive for outward winding, and a sanity check a
// boolean either passes or fails outright — a broken cut usually leaves the volume wrong or
// negative, which no triangle count would reveal.
export function signedVolume(geo) {
  const pos = geo.attributes.position.array;
  const index = geo.index ? geo.index.array : null;
  const count = index ? index.length : pos.length / 3;
  let v = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const g = (k) => { const vi = index ? index[i + k] : i + k; return [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]; };
    const a = g(0), b = g(1), c = g(2);
    v += dot3(a, cross3(b, c)) / 6;
  }
  return v;
}

export const CSG_OPS = Object.freeze(['subtract', 'intersect', 'union']);

/**
 * Boolean of two geometries. `op` is one of CSG_OPS. Neither input is modified; the result is a
 * fresh non-indexed geometry carrying position and normal only (no UVs survive a boolean).
 */
export function csgOp(THREE, op, geoA, geoB) {
  const a = treeFrom(polygonsFromGeometry(geoA));
  const b = treeFrom(polygonsFromGeometry(geoB));
  if (op === 'union') {
    nodeClipTo(a, b); nodeClipTo(b, a);
    nodeInvert(b); nodeClipTo(b, a); nodeInvert(b);
    nodeBuild(a, nodeAllPolygons(b));
  } else if (op === 'subtract') {
    nodeInvert(a);
    nodeClipTo(a, b); nodeClipTo(b, a);
    nodeInvert(b); nodeClipTo(b, a); nodeInvert(b);
    nodeBuild(a, nodeAllPolygons(b));
    nodeInvert(a);
  } else if (op === 'intersect') {
    nodeInvert(a);
    nodeClipTo(b, a);
    nodeInvert(b);
    nodeClipTo(a, b); nodeClipTo(b, a);
    nodeBuild(a, nodeAllPolygons(b));
    nodeInvert(a);
  } else {
    throw new Error(`model-csg: unknown op "${op}"`);
  }
  return geometryFromPolygons(THREE, nodeAllPolygons(a));
}
