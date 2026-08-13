// Deformation operators for the model vocabulary.
//
// A finite primitive list reaches hard-surface armour and stops. Organic form needs operations ON
// shapes rather than more shapes: a limb reads as a limb because it tapers and bulges, not because
// it is a different solid from a tube. These are the ops img2threejs's `continuous-sculpt` topology
// class exists to demand, and its flat-projection-bias rule exists to catch the absence of.
//
// THEY NEED TESSELLATION ALONG THE AXIS THEY ACT ON. Bending a twelve-triangle box does nothing
// visible, because there are no intermediate rings to move. That is what the `lengthSeg` descriptor
// field in model-primitives.js is for, and it is the single most common way a modifier looks broken
// when it is working correctly.
//
// Vertex math only, so no THREE at module scope — geometries arrive already built.

export const MODIFIER_OPS = Object.freeze(['taper', 'bend', 'twist', 'bulge', 'displace']);

const AXIS = { x: 0, y: 1, z: 2 };
const axisIndex = (a, fallback = 1) => (a in AXIS ? AXIS[a] : fallback);

// Integer hash, deliberately not Math.random or Math.sin: geometry is cached and shared, so a
// displaced piece must rebuild to the same vertices every time or two consumers disagree.
function ihash(i) {
  i = Math.imul(i ^ (i >>> 16), 2246822507);
  i = Math.imul(i ^ (i >>> 13), 3266489909);
  return ((i ^ (i >>> 16)) >>> 0) / 4294967296;
}

function latticeValue(a, b, c, seed) {
  return ihash((Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791) ^ Math.imul(seed, 2654435761)) | 0);
}

// Trilinear value noise in [0,1].
function valueNoise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (i, j, k) => latticeValue(xi + i, yi + j, zi + k, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function extentOf(pos, ai) {
  let min = Infinity, max = -Infinity;
  for (let i = ai; i < pos.length; i += 3) {
    if (pos[i] < min) min = pos[i];
    if (pos[i] > max) max = pos[i];
  }
  return { min, max, span: Math.max(1e-9, max - min) };
}

// Perpendicular component indices for a given axis.
function perp(ai) { return ai === 0 ? [1, 2] : ai === 1 ? [0, 2] : [0, 1]; }

function opTaper(pos, m) {
  const ai = axisIndex(m.axis);
  const [p, q] = perp(ai);
  const { min, span } = extentOf(pos, ai);
  const a = m.start ?? 1, b = m.end ?? 1;
  for (let i = 0; i < pos.length; i += 3) {
    const t = (pos[i + ai] - min) / span;
    const s = a + (b - a) * t;
    pos[i + p] *= s;
    pos[i + q] *= s;
  }
}

function opTwist(pos, m) {
  const ai = axisIndex(m.axis);
  const [p, q] = perp(ai);
  const { min, span } = extentOf(pos, ai);
  const angle = m.angle ?? 0;
  for (let i = 0; i < pos.length; i += 3) {
    const t = (pos[i + ai] - min) / span;
    const a = angle * t, c = Math.cos(a), s = Math.sin(a);
    const x = pos[i + p], y = pos[i + q];
    pos[i + p] = x * c - y * s;
    pos[i + q] = x * s + y * c;
  }
}

// Smooth bump around `center` (0..1 along the axis), scaling the perpendicular components.
function opBulge(pos, m) {
  const ai = axisIndex(m.axis);
  const [p, q] = perp(ai);
  const { min, span } = extentOf(pos, ai);
  const amount = m.amount ?? 0, center = m.center ?? 0.5, width = Math.max(1e-6, m.width ?? 0.4);
  for (let i = 0; i < pos.length; i += 3) {
    const t = (pos[i + ai] - min) / span;
    const d = (t - center) / width;
    const f = Math.abs(d) < 1 ? 0.5 * (1 + Math.cos(Math.PI * d)) : 0;
    const s = 1 + amount * f;
    pos[i + p] *= s;
    pos[i + q] *= s;
  }
}

// Arc bend: `angle` is the TOTAL sweep across the axis extent, so the sign picks the direction and
// the magnitude is readable without knowing the piece's size.
function opBend(pos, m) {
  const li = axisIndex(m.axis);
  const bi = axisIndex(m.around, li === 2 ? 0 : 2);
  const di = 3 - li - bi;
  if (di === li || di === bi || di < 0 || di > 2) throw new Error('model-modifiers: bend axis and around must differ');
  const angle = m.angle ?? 0;
  if (Math.abs(angle) < 1e-9) return;
  const { min, max, span } = extentOf(pos, li);
  const mid = (min + max) * 0.5;
  const k = angle / span, R = 1 / k;
  for (let i = 0; i < pos.length; i += 3) {
    const th = k * (pos[i + li] - mid);
    const r = R - pos[i + di];
    pos[i + di] = R - r * Math.cos(th);
    pos[i + li] = mid + r * Math.sin(th);
  }
}

function opDisplace(geo, pos, m) {
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const amount = m.amount ?? 0, freq = m.frequency ?? 8, seed = (m.seed ?? 0) | 0;
  for (let i = 0; i < pos.length; i += 3) {
    const n = valueNoise(pos[i] * freq, pos[i + 1] * freq, pos[i + 2] * freq, seed) * 2 - 1;
    if (nrm) {
      pos[i] += nrm[i] * n * amount;
      pos[i + 1] += nrm[i + 1] * n * amount;
      pos[i + 2] += nrm[i + 2] * n * amount;
    } else {
      pos[i] += n * amount; pos[i + 1] += n * amount; pos[i + 2] += n * amount;
    }
  }
}

/**
 * Applies an ordered modifier stack in place and returns the same geometry. Order is significant:
 * a taper then a bend is not a bend then a taper, so the list is authored, never sorted.
 */
export function applyModifiers(geo, modifiers) {
  if (!modifiers || !modifiers.length) return geo;
  const attr = geo.attributes.position;
  const pos = attr.array;
  for (const m of modifiers) {
    switch (m.op) {
      case 'taper': opTaper(pos, m); break;
      case 'twist': opTwist(pos, m); break;
      case 'bulge': opBulge(pos, m); break;
      case 'bend': opBend(pos, m); break;
      // Displace reads normals, so earlier ops must be settled into them first.
      case 'displace': geo.computeVertexNormals(); opDisplace(geo, pos, m); break;
      default: throw new Error(`model-modifiers: unknown op "${m.op}"`);
    }
  }
  attr.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
