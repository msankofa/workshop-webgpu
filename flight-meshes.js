// flight-meshes.js — the flight sim's craft as reusable groups: fixed wing, multirotor, flapping
// wing, the recon UAV, two ground vehicles, the Sentinel flying wing and its missile. Materials come from the caller (`{ standard(color, emissive), basic(color, opacity) }`)
// because the sim runs node materials and the bot viewer does not; geometry and proportions are shared.
// Poseable parts are hung on `userData` (flame / rotors / wings) for whoever animates them.
import * as THREE from 'three';

// Filled in at the bottom of this file. A lookup rather than a ternary chain because the chain
// ended on `buildBird` with no error, so any kind it did not know about silently rendered as a bird.
const BUILDERS = {};

export function registerCraftMesh(kind, build) { BUILDERS[kind] = build; return build; }
export const CRAFT_KINDS = ['plane', 'drone', 'bird', 'recon', 'ugv', 'buggy', 'sentinel', 'agm'];

// ── shared craft materials ──────────────────────────────────────────────────
// Every builder below asks for the same handful of materials with the same literal colours, so a
// second drone used to allocate a second identical `dark`. In r184 identical materials still share
// the compiled pipeline (programs are keyed on shader source), but each one owns a bind group and a
// uniform buffer, so the duplicates cost GPU memory and per-object binding bookkeeping.
//
// The compatibility key is: the caller's factory table (object identity) + which factory (standard
// or basic) + colour + emissive/opacity + any extra property the third argument bakes in (`side`).
// Anything differing in any of those stays a separate material. Roughness/metalness are not in the
// key because the factory bakes them in as constants — a factory that varied them per call would
// need them added here.
//
// Ownership: shared materials are reference counted, not owned outright. `buildCraftMesh` acquires
// one reference per mesh slot that points at a cached material, and `dispose()` on a cached material
// is a *release*: it drops one reference and really frees the material at zero. So the ordinary
// teardown — traverse the craft and dispose everything it can see — stays exactly correct with no
// page change, and no material outlives the last craft using it. `releaseCraftMaterials(root)` is
// the same thing spelled out; use one or the other for a craft, never both.
const MATERIAL_CACHES = new Set();          // every per-factory cache, for disposeCraftMaterials
const CACHE_BY_FACTORY = new WeakMap();     // factory table -> Map(key -> material)
const CACHED_MATERIALS = new WeakSet();
const REAL_DISPOSE = new WeakMap();
const USE_COUNT = new WeakMap();            // cached material -> live mesh slots pointing at it
const CACHE_OF = new WeakMap();             // cached material -> the Map it lives in
const KEY_OF = new WeakMap();               // cached material -> its key in that Map
const colorKey = (c) => (typeof c === 'number' ? c.toString(16) : (c && c.isColor ? c.getHexString() : String(c)));
const optsKey = (o) => (o ? Object.keys(o).sort().map(k => `${k}=${o[k]}`).join(',') : '');

// Hard bound on distinct materials per caller factory. A caller that tints every craft differently
// would otherwise grow the cache without limit; past this, unused entries are evicted and, failing
// that, the material is handed back uncached and owned by the craft as it was before the cache.
export const CRAFT_MATERIAL_CACHE_LIMIT = 64;
let warnedFull = false;

// True for a material this module shares. Such a material's dispose() releases rather than frees.
export function isCachedCraftMaterial(material) { return !!material && CACHED_MATERIALS.has(material); }

// Live reference count of a shared material, for tests and diagnostics.
export function craftMaterialUses(material) { return USE_COUNT.get(material) ?? 0; }

// Distinct materials currently cached for one caller factory table.
export function craftMaterialCacheSize(factory) { return CACHE_BY_FACTORY.get(factory)?.size ?? 0; }

function freeMaterial(mat) {
  const cache = CACHE_OF.get(mat), key = KEY_OF.get(mat);
  if (cache && cache.get(key) === mat) cache.delete(key);
  const real = REAL_DISPOSE.get(mat);
  delete mat.dispose;                       // back to the prototype's real dispose
  CACHED_MATERIALS.delete(mat); USE_COUNT.delete(mat); REAL_DISPOSE.delete(mat);
  if (real) real();
}

function releaseMaterial(mat) {
  if (!CACHED_MATERIALS.has(mat)) return;
  const n = USE_COUNT.get(mat) ?? 0;
  if (n > 1) USE_COUNT.set(mat, n - 1); else freeMaterial(mat);
}

// One reference per mesh slot, so a teardown that disposes per mesh balances exactly.
function acquireCraftMaterials(root) {
  root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (CACHED_MATERIALS.has(x)) USE_COUNT.set(x, (USE_COUNT.get(x) ?? 0) + 1);
  });
}

// Drops this craft's references; a material nothing else uses is really disposed. Equivalent to the
// traverse-and-dispose teardown, for callers that would rather say it explicitly.
export function releaseCraftMaterials(root) {
  if (!root) return;
  root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) releaseMaterial(x);
  });
}

// Frees every shared craft material regardless of who still points at one. Page teardown only.
export function disposeCraftMaterials() {
  for (const cache of MATERIAL_CACHES) {
    for (const mat of [...cache.values()]) freeMaterial(mat);
    cache.clear();
  }
  MATERIAL_CACHES.clear();
  warnedFull = false;
}

// Drops entries no live mesh uses, oldest first. Returns true if it made room.
function evictUnused(cache) {
  let freed = false;
  for (const mat of [...cache.values()]) {
    if ((USE_COUNT.get(mat) ?? 0) > 0) continue;
    freeMaterial(mat);
    freed = true;
    if (cache.size < CRAFT_MATERIAL_CACHE_LIMIT) break;
  }
  return freed && cache.size < CRAFT_MATERIAL_CACHE_LIMIT;
}

// Wraps a caller's `{ standard, basic }` table so repeated requests return one material. The third
// argument is this module's, not the caller's: the caller's factory never sees it, the wrapper
// applies it and keys on it (that is how a double-sided panel stays distinct from the hull).
export function shareCraftMaterials(m) {
  if (!m || typeof m.standard !== 'function' || typeof m.basic !== 'function') return m;
  let cache = CACHE_BY_FACTORY.get(m);
  if (!cache) { cache = new Map(); CACHE_BY_FACTORY.set(m, cache); MATERIAL_CACHES.add(cache); }
  const take = (key, make, opts) => {
    const hit = cache.get(key);
    if (hit) return hit;
    const mat = make();
    if (opts) for (const k of Object.keys(opts)) mat[k] = opts[k];
    if (!mat || typeof mat.dispose !== 'function') return mat;
    // Full and nothing free: hand it back uncached, owned by the craft as before the cache existed.
    if (cache.size >= CRAFT_MATERIAL_CACHE_LIMIT && !evictUnused(cache)) {
      if (!warnedFull) { warnedFull = true; console.warn(`flight-meshes: craft material cache full at ${CRAFT_MATERIAL_CACHE_LIMIT} in-use materials; further materials are per-craft`); }
      return mat;
    }
    REAL_DISPOSE.set(mat, mat.dispose.bind(mat));
    mat.dispose = () => releaseMaterial(mat);
    CACHED_MATERIALS.add(mat); USE_COUNT.set(mat, 0); CACHE_OF.set(mat, cache); KEY_OF.set(mat, key);
    cache.set(key, mat);
    return mat;
  };
  return {
    ...m,
    standard: (color, emissive = 0x000000, opts = null) =>
      take(`s|${colorKey(color)}|${colorKey(emissive)}|${optsKey(opts)}`, () => m.standard(color, emissive), opts),
    basic: (color, opacity = 1, opts = null) =>
      take(`b|${colorKey(color)}|${opacity}|${optsKey(opts)}`, () => m.basic(color, opacity), opts),
  };
}

const DOUBLE_SIDED = { side: THREE.DoubleSide };

export function buildPlane(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x2a3038), glass = m.standard(0x121a24, 0x0a1520);
  const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 6.2, 6, 12), body);
  fuse.name = 'plane-fuselage';
  fuse.rotation.x = Math.PI / 2; g.add(fuse);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.62, 2.2, 12), body);
  nose.name = 'plane-nose';
  nose.rotation.x = -Math.PI / 2; nose.position.z = -4.6; g.add(nose);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.22, 2.6), body);
  wing.name = 'plane-wing';
  wing.position.set(0, -0.15, 0.4); g.add(wing);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.18, 1.2), body);
  stab.name = 'plane-stabiliser';
  stab.position.set(0, 0.1, 3.5); g.add(stab);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.9, 1.5), body);
  fin.name = 'plane-fin';
  fin.position.set(0, 1.05, 3.5); g.add(fin);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), glass);
  canopy.name = 'plane-canopy';
  canopy.scale.set(1, 0.75, 2.1); canopy.position.set(0, 0.5, -1.4); g.add(canopy);
  const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 12), dark);
  intake.name = 'plane-intake';
  intake.rotation.x = Math.PI / 2; intake.position.z = 3.3; g.add(intake);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.44, 2.6, 10), m.basic(0x8fd0ff, 0.85));
  flame.name = 'plane-flame';
  flame.rotation.x = Math.PI / 2; flame.position.z = 4.6; g.add(flame);
  g.userData.flame = flame;
  return g;
}

export function buildDrone(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x1d2228);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.07, 0.26), body);
  hull.name = 'drone-hull'; g.add(hull);
  const rotors = [];
  for (let i = 0; i < 4; i++) {
    const sx = i < 2 ? 1 : -1, sz = i % 2 === 0 ? 1 : -1;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.018, 0.26), dark);
    arm.name = `drone-arm-${i}`;
    arm.position.set(sx * 0.11, 0, sz * 0.13);
    arm.rotation.y = sx * sz * 0.62; g.add(arm);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8), dark);
    hub.name = `drone-hub-${i}`;
    hub.position.set(sx * 0.20, 0.02, sz * 0.20); g.add(hub);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.004, 16), m.basic(0xbfd8ee, 0.30));
    disc.name = `drone-disc-${i}`;
    disc.position.set(sx * 0.20, 0.038, sz * 0.20); g.add(disc);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.004, 0.018), dark);
    blade.name = `drone-blade-${i}`;
    blade.position.copy(disc.position); g.add(blade);
    rotors.push(blade);
  }
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), m.standard(0x0d1116, 0x102030));
  cam.name = 'drone-camera';
  cam.position.set(0, -0.045, -0.09); g.add(cam);
  g.userData.rotors = rotors;
  return g;
}

export function buildBird(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x25201c);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), body);
  torso.name = 'bird-torso';
  torso.scale.set(1, 0.9, 2.4); g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), body);
  head.name = 'bird-head';
  head.position.set(0, 0.06, -0.38); g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.16, 7), m.standard(0xc8a33f));
  beak.name = 'bird-beak';
  beak.rotation.x = -Math.PI / 2; beak.position.set(0, 0.04, -0.52); g.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.34), dark);
  tail.name = 'bird-tail';
  tail.position.set(0, 0.02, 0.44); g.add(tail);
  const wings = [];
  for (const side of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.10, 0.05, -0.02);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.018, 0.30), body);
    wing.name = `bird-wing-${side < 0 ? 'l' : 'r'}`;
    wing.position.set(side * 0.36, 0, 0.02);
    pivot.add(wing); g.add(pivot);
    wings.push({ pivot, side, wing });
  }
  g.userData.wings = wings;
  return g;
}

// A cylinder spanning two points, for tube frames and roll cages. `a` and `b` are [x, y, z].
const _tubeA = new THREE.Vector3(), _tubeDir = new THREE.Vector3(), _tubeUp = new THREE.Vector3(0, 1, 0);
// A solid between two quads that need not be parallel or the same size: a tapered strut. `a` and
// `b` are four points each, in the same rotational order. Double-sided material, so winding is free.
function hexa(a, b, material) {
  const tri = (p, q, r) => [...p, ...q, ...r];
  const pos = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    pos.push(...tri(a[i], b[i], b[j]), ...tri(a[i], b[j], a[j]));
  }
  pos.push(...tri(a[0], a[1], a[2]), ...tri(a[0], a[2], a[3]));
  pos.push(...tri(b[0], b[2], b[1]), ...tri(b[0], b[3], b[2]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

const name = (mesh, n) => { mesh.name = n; return mesh; };

function tube(a, b, radius, material, seg = 8) {
  _tubeA.set(a[0], a[1], a[2]);
  _tubeDir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _tubeDir.length() || 1e-4;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, seg), material);
  mesh.position.copy(_tubeA).addScaledVector(_tubeDir, 0.5);
  mesh.quaternion.setFromUnitVectors(_tubeUp, _tubeDir.divideScalar(len));
  return mesh;
}

// A side silhouette extruded across the vehicle's width. Points are [z, y] in metres, nose at -Z;
// the result is centred on X so the caller places it by its own axis like every other part.
// Several extruded profiles as one geometry, for a part built from more than one shell.
function mergeGeos(geos) {
  const pos = [];
  for (const g of geos) pos.push(...g.attributes.position.array);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function bodyProfile(points, width) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(-Math.PI / 2);   // shape x becomes world z, extrusion becomes world x
  return geo;
}

// Tyre, rim face and hub as three radii, so a wheel reads as a wheel at gameplay distance instead
// of as a black cylinder. The pivot steers, the spin group rolls; the view animates both.
function vehicleWheel(x, y, z, radius, width, mats, front, wheels, label = 'wheel') {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const spin = new THREE.Group();
  spin.name = `${label}-spin`;
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width * 0.86, 16), mats.tyre);
  tyre.rotation.z = Math.PI / 2;
  tyre.name = `${label}-tyre`;
  spin.add(tyre);
  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.93, radius * 0.93, width, 16), mats.tyre);
  shoulder.rotation.z = Math.PI / 2;
  shoulder.name = `${label}-shoulder`;
  spin.add(shoulder);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width * 1.04, 12), mats.rim);
  rim.rotation.z = Math.PI / 2;
  rim.name = `${label}-rim`;
  spin.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, width * 1.14, 8), mats.dark);
  hub.rotation.z = Math.PI / 2;
  hub.name = `${label}-hub`;
  spin.add(hub);
  pivot.add(spin);
  if (wheels) wheels.push({ pivot, spin, front, radius });
  return pivot;
}

// An open half-shell over a wheel. Double-sided because a fender seen from below is a backface.
function wheelArch(x, y, z, radius, width, material, seg = 10) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, seg, 1, true, 0, Math.PI), material);
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

// Bakes every static part into one geometry per material. A vehicle assembled from primitives runs
// to 85 parts, and `buildCraftMesh` turns frustum culling off, so each one is a guaranteed draw
// call; the other craft here sit at 6-18. Anything under `skip` (the steering and rolling wheel
// pivots) keeps its own transform and is left alone.
const _mergeInv = new THREE.Matrix4(), _mergeRel = new THREE.Matrix4();
function mergeByMaterial(root, skip = null) {
  const buckets = new Map();
  const drop = [];
  root.updateMatrixWorld(true);
  // Relative to `root`, not to the world: a wheel's spin group hangs off a pivot that keeps its
  // own offset, and baking the world matrix there would apply that offset a second time.
  _mergeInv.copy(root.matrixWorld).invert();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (skip) for (let p = o; p && p !== root; p = p.parent) if (skip.has(p)) return;
    let bucket = buckets.get(o.material);
    if (!bucket) { bucket = { pos: [], nor: [], uv: [] }; buckets.set(o.material, bucket); }
    const placed = o.geometry.clone().applyMatrix4(_mergeRel.multiplyMatrices(_mergeInv, o.matrixWorld));
    const flat = placed.index ? placed.toNonIndexed() : placed;
    const pos = flat.attributes.position.array, nor = flat.attributes.normal.array, uv = flat.attributes.uv?.array;
    for (let i = 0; i < pos.length; i++) bucket.pos.push(pos[i]);
    for (let i = 0; i < nor.length; i++) bucket.nor.push(nor[i]);
    for (let i = 0, n = pos.length / 3 * 2; i < n; i++) bucket.uv.push(uv ? uv[i] : 0);
    if (flat !== placed) flat.dispose();
    placed.dispose();
    o.geometry.dispose();
    drop.push(o);
  });
  for (const o of drop) o.parent?.remove(o);
  for (const [material, bucket] of buckets) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
    root.add(new THREE.Mesh(geo, material));
  }
  return root;
}

let AUTHORING = false;
// Turn on before building a model that is going out to a modelling tool, off again afterwards.
export function setMeshAuthoring(on) { AUTHORING = !!on; }

// Merges the hull into one draw per material and each wheel's four rings into one per material,
// leaving the pivots free to steer and roll.
function finishVehicle(g, wheels, named = {}) {
  const groups = Object.values(named).filter(Boolean);
  const skip = new Set(wheels.map(w => w.pivot));
  for (const group of groups) skip.add(group);
  if (!AUTHORING) {
    mergeByMaterial(g, skip);
    for (const wheel of wheels) mergeByMaterial(wheel.spin);
    for (const group of groups) mergeByMaterial(group, skip);
  }
  g.userData.wheels = wheels;
  for (const [name, group] of Object.entries(named)) if (group) g.userData[name] = group;
  return g;
}

// Wheel positions come from the simulation's own wheelbase, track and clearance, so the drawn
// contact patch is the one `fitVehicleGround` samples. Hand-authored numbers had drifted 50% out.
// A closed-ring loft along Z: `rings` is [{ z, pts: [[x, y], ...] }] with equal point counts, nose
// first. Used for hull tubs, whose cross-section changes station to station and cannot be extruded.
function loftRings(rings) {
  const n = rings[0].pts.length, m = rings.length;
  const pos = [], idx = [];
  for (const ring of rings) for (const p of ring.pts) pos.push(p[0], p[1], ring.z);
  for (let s = 0; s < m - 1; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = s * n + i, b = s * n + j, c = (s + 1) * n + i, d = (s + 1) * n + j;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (const [s, flip] of [[0, false], [m - 1, true]]) {
    const base = pos.length / 3;
    let cx = 0, cy = 0;
    for (const p of rings[s].pts) { cx += p[0]; cy += p[1]; }
    pos.push(cx / n, cy / n, rings[s].z);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) idx.push(base, s * n + j, s * n + i); else idx.push(base, s * n + i, s * n + j);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// One hull station: a rounded trapezoid, flat on top, near-vertical sides, belly tucked inward.
// Ordered from top centre out to starboard, down and around the belly, back up the port side.
function tubRing(hw, deckY, kneeY, floorY, floorHalf) {
  const half = [
    [0, deckY], [hw * 0.62, deckY], [hw, deckY], [hw, kneeY],
    [hw * 0.95, kneeY - (kneeY - floorY) * 0.42],
    [hw * 0.80, kneeY - (kneeY - floorY) * 0.76],
    [floorHalf * 1.3, floorY + (kneeY - floorY) * 0.12],
    [floorHalf, floorY], [0, floorY],
  ];
  const pts = half.slice();
  for (let i = half.length - 2; i >= 1; i--) pts.push([-half[i][0], half[i][1]]);
  return pts;
}

// Roboneers Sablynx / Lynx ("Рись") UGV, from scratchpads/sablynx-ugv/. Proportions are fractions
// of the tyre diameter above ground, measured off ref/side-studio.jpeg; that reference is a close
// perspective photograph, so it fixes ratios only and every absolute metre comes from the
// simulation def. Bands and the observation-versus-inference split: intake-analysis.md.
const UGV_DIMS = { wheelbase: 1.1, track: 0.8, clearance: 0.25 };
export function buildUgv(tint, m, dims = UGV_DIMS) {
  const wb = dims.wheelbase ?? UGV_DIMS.wheelbase;
  const track = dims.track ?? UGV_DIMS.track;
  const clear = dims.clearance ?? UGV_DIMS.clearance;
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x1b1e22), rim = m.standard(0x54595f);
  const deckMat = m.standard(0x3d4248), lens = m.standard(0x18303a, 0x2a5f6e);
  // Same colour as the hull but double-sided, so it must stay a separate material from `body`.
  const panel = m.standard(tint, 0x000000, DOUBLE_SIDED); panel.side = THREE.DoubleSide;
  const mats = { tyre: dark, rim, dark };

  // Tyre diameter is 0.55 x wheelbase, the reference's own tyre-to-body relationship. Y(f) puts a
  // measured band, given as a fraction of that diameter above ground, into mesh space.
  const D = wb * 0.55, r = D / 2, wheelW = D * 0.32;
  const Y = (f) => f * D - clear;
  const axleY = Y(0.5), tubFloor = Y(0.55), sideLow = Y(0.66), deckY = Y(1.42);
  const railLow = Y(1.45), railTop = Y(1.71), pedTop = Y(1.70), rwsY = Y(2.08);
  const gunY = Y(2.25), mastPlateY = Y(2.874), antTopY = Y(3.425);
  const halfWb = wb / 2, halfTrack = track / 2;
  const nose = -(halfWb + 0.27), tail = halfWb + 0.31, hullHalf = halfTrack * 0.88;

  // ── hull tub ───────────────────────────────────────────────────────────────
  const T =    [0, 0.05, 0.12, 0.26, 0.45, 0.64, 0.80, 0.90, 0.96, 1.0];
  const HW =   [0.50, 0.73, 0.90, 1.0, 1.0, 1.0, 1.0, 0.98, 0.90, 0.70];
  const LIFT = [0.62, 0.42, 0.18, 0.03, 0, 0, 0.02, 0.10, 0.28, 0.50];
  const rings = T.map((t, i) => {
    const hw = hullHalf * HW[i], lift = LIFT[i];
    const floorY = tubFloor + lift * (deckY - tubFloor) * 0.42;
    const kneeY = sideLow + lift * (deckY - sideLow) * 0.72;
    return { z: nose + t * (tail - nose), pts: tubRing(hw, deckY, kneeY, floorY, hw * 0.42) };
  });
  const hull = new THREE.Mesh(loftRings(rings), body);
  hull.name = 'ugv-hull'; g.add(hull);

  // Bolted flange along each hull top edge, and the expanded-metal deck inside it.
  for (const sx of [-1, 1]) {
    const flange = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.026, (tail - nose) * 0.9), deckMat);
    flange.name = `ugv-flange-${sx < 0 ? 'l' : 'r'}`;
    flange.position.set(sx * hullHalf, deckY + 0.012, (nose + tail) / 2); g.add(flange);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(hullHalf * 1.86, 0.02, (tail - nose) * 0.86), deckMat);
  deck.name = 'ugv-deck';
  deck.position.set(0, deckY + 0.011, (nose + tail) / 2 + 0.01); g.add(deck);

  // ── perimeter cargo rail: lower tube at deck level, posts, upper tube ──────
  const railHalf = hullHalf * 1.02, railZ0 = nose + 0.10, railZ1 = tail - 0.08, tubeR = D * 0.037;
  for (const [yi, y] of [railLow, railTop].entries()) {
    const lvl = yi ? 'top' : 'low';
    for (const sx of [-1, 1]) g.add(name(tube([sx * railHalf, y, railZ0], [sx * railHalf, y, railZ1], tubeR, body),
      `ugv-rail-${lvl}-side-${sx < 0 ? 'l' : 'r'}`));
    for (const [zi, z] of [railZ0, railZ1].entries()) g.add(name(tube([-railHalf, y, z], [railHalf, y, z], tubeR, body),
      `ugv-rail-${lvl}-end-${zi ? 'rear' : 'front'}`));
  }
  for (const sx of [-1, 1]) for (const [zi, z] of [railZ0, railZ0 * 0.36 + railZ1 * 0.64, railZ1].entries()) {
    g.add(name(tube([sx * railHalf, railLow, z], [sx * railHalf, railTop, z], tubeR * 0.92, body),
      `ugv-rail-post-${sx < 0 ? 'l' : 'r'}${zi}`));
  }
  for (const [zi, z] of [railZ0, railZ1].entries()) for (const sx of [-1, 1]) {
    g.add(name(tube([sx * railHalf * 0.45, railLow, z], [sx * railHalf * 0.45, railTop, z], tubeR * 0.85, body),
      `ugv-rail-inner-post-${zi ? 'rear' : 'front'}-${sx < 0 ? 'l' : 'r'}`));
  }
  // Slotted mounting plates between the rails, and the clamp blocks bolted to them.
  for (const sx of [-1, 1]) for (const zf of [0.26, 0.68]) {
    const z = railZ0 + (railZ1 - railZ0) * zf;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.016, (railTop - railLow) * 0.82, 0.30), body);
    plate.name = `ugv-rail-plate-${sx < 0 ? 'l' : 'r'}${zf}`;
    plate.position.set(sx * railHalf, (railLow + railTop) / 2, z); g.add(plate);
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.085), body);
    block.name = `ugv-rail-block-${sx < 0 ? 'l' : 'r'}${zf}`;
    block.position.set(sx * (railHalf + 0.02), (railLow + railTop) / 2, z); g.add(block);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.05, 8), dark);
    knob.rotation.z = Math.PI / 2;
    knob.name = `ugv-rail-knob-${sx < 0 ? 'l' : 'r'}${zf}`;
    knob.position.set(sx * (railHalf + 0.075), (railLow + railTop) / 2, z); g.add(knob);
  }

  // ── mudguards, tow eyes, wheels ────────────────────────────────────────────
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(name(wheelArch(sx * halfTrack, axleY, sz * halfWb, r * 1.2, wheelW * 1.5, panel),
      `ugv-mudguard-${sx < 0 ? 'l' : 'r'}${sz < 0 ? 'f' : 'b'}`));
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.011, 5, 9), body);
    eye.name = `ugv-tow-eye-${sx < 0 ? 'l' : 'r'}${sz < 0 ? 'f' : 'b'}`;
    eye.position.set(sx * hullHalf * 0.92, sideLow + 0.05, sz * (halfWb + 0.20));
    eye.rotation.y = Math.PI / 2; g.add(eye);
  }
  const wheels = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wn = `ugv-wheel-${sx < 0 ? 'l' : 'r'}${sz < 0 ? 'f' : 'b'}`;
    g.add(name(vehicleWheel(sx * halfTrack, axleY, sz * halfWb, r, wheelW, mats, sz < 0, wheels, wn), wn));
  }

  // ── remote weapon station, on its own group so it can be trained later ─────
  const turret = new THREE.Group();
  turret.position.set(0, deckY, -0.05);
  const ty = (y) => y - deckY;   // turret-local height
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.16, pedTop - deckY, 14), body);
  ped.name = 'ugv-pedestal';
  ped.position.y = ty((deckY + pedTop) / 2); turret.add(ped);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.05, 14), dark);
  collar.name = 'ugv-collar';
  collar.position.y = ty(pedTop - 0.01); turret.add(collar);
  const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.19, (rwsY - pedTop) * 1.15, 0.20), body);
  yoke.name = 'ugv-yoke';
  yoke.position.y = ty((pedTop + rwsY) / 2 + 0.02); turret.add(yoke);

  // The gun elevates about its trunnion, so everything that moves in pitch hangs off its own group
  // at that height. Pitching the whole station would tilt the pedestal with it.
  const elevation = new THREE.Group();
  elevation.position.set(0, ty(gunY), 0);
  turret.add(elevation);
  const ey = (y) => y - gunY;   // elevation-local height
  const GUN_Z = 0.165;
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.14, 0.75), dark);
  receiver.name = 'ugv-receiver';
  receiver.position.set(0, ey(gunY - 0.035), -0.047); elevation.add(receiver);
  // The cowl is a shroud over the gun, not a solid: an inverted U in cross-section — a roof with a
  // wall down each side and open below. Built as those three slabs so it stays that shape at any
  // scale. `COWL` is the outer silhouette, [z, y] about the trunnion; the cavity roof is at +0.055.
  const COWL = [[0.098, -0.080], [-0.509, -0.020], [-0.605, 0.100],
                [-0.382, 0.155], [0.258, 0.150], [0.354, 0.030]];
  const COWL_ROOF = [[-0.569, 0.055], [-0.605, 0.100], [-0.382, 0.155], [0.258, 0.150], [0.334, 0.055]];
  const cowlHalf = 0.115, cowlWall = 0.032;
  const cowlSide = (pts, width, x) => {
    const geo = bodyProfile(pts.map(([z, dy]) => [z, ey(gunY + dy)]), width);
    if (x) geo.translate(x, 0, 0);
    return geo;
  };
  const cowl = new THREE.Mesh(mergeGeos([
    cowlSide(COWL, cowlWall, -(cowlHalf - cowlWall / 2)),
    cowlSide(COWL, cowlWall, cowlHalf - cowlWall / 2),
    cowlSide(COWL_ROOF, cowlHalf * 2, 0),
  ]), body);
  cowl.name = 'ugv-cowl';
  elevation.add(cowl);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.17, 14), body);
  drum.rotation.z = Math.PI / 2;
  drum.name = 'ugv-drum';
  drum.position.set(0.10, ey(rwsY + 0.02), -0.002); elevation.add(drum);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.78, 9), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.name = 'ugv-barrel';
  barrel.position.set(0, 0, -0.538); elevation.add(barrel);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.024, 0.09, 9), dark);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.name = 'ugv-muzzle';
  muzzle.position.set(0, 0, -0.898); elevation.add(muzzle);
  const optic = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.30), dark);
  optic.name = 'ugv-optic';
  optic.position.set(0, ey(gunY - 0.15), -0.36 + GUN_Z); elevation.add(optic);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.02, 12), lens);
  glass.rotation.x = Math.PI / 2;
  glass.name = 'ugv-optic-glass';
  glass.position.set(0, ey(gunY - 0.15), -0.52 + GUN_Z); elevation.add(glass);
  for (const sx of [-1, 1]) {
    const railBar = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.05, 0.44), dark);
    railBar.name = `ugv-gun-rail-${sx < 0 ? 'l' : 'r'}`;
    railBar.position.set(sx * 0.102, ey(gunY - 0.10), -0.122); elevation.add(railBar);
  }
  // A light and a laser module ride the rails either side of the optic, so they train with the gun.
  for (const sx of [-1, 1]) {
    const module = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.16), dark);
    module.name = sx > 0 ? 'ugv-gun-light' : 'ugv-gun-laser';
    module.position.set(sx * 0.134, ey(gunY - 0.10), -0.30 + GUN_Z); elevation.add(module);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(sx > 0 ? 0.02 : 0.012, sx > 0 ? 0.02 : 0.012, 0.012, 10), lens);
    face.rotation.x = Math.PI / 2;
    face.name = sx > 0 ? 'ugv-gun-light-face' : 'ugv-gun-laser-face';
    face.position.set(sx * 0.134, ey(gunY - 0.10), -0.385 + GUN_Z); elevation.add(face);
  }
  g.add(turret);

  // Headlamps in the nose. The faces are dark glass; the view draws the lit disc when a switch is on.
  for (const sx of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), dark);
    cup.rotation.x = Math.PI / 2;
    cup.name = `ugv-headlamp-${sx < 0 ? 'l' : 'r'}`;
    cup.position.set(sx * hullHalf * 0.32, deckY - 0.07, nose + 0.01); g.add(cup);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.012, 12), lens);
    face.rotation.x = Math.PI / 2;
    face.name = `ugv-headlamp-face-${sx < 0 ? 'l' : 'r'}`;
    face.position.set(sx * hullHalf * 0.32, deckY - 0.07, nose - 0.008); g.add(face);
  }

  // ── rear rack: a post each side, the plate across them, camera, whips and dome ─────
  // Positions read out of the Blender edit (scratchpads/sablynx-ugv/export/ugv-3.glb) by part name;
  // heights are still fractions of tyre diameter and x still scales with the hull, so the rack
  // follows the simulation's wheelbase and track like the rest of the vehicle.
  const mastZ = tail - 0.20, postTopY = Y(2.684), postBaseY = Y(1.440);
  const postX0 = hullHalf * 0.807, postX1 = hullHalf * 0.926, postHalfZ = 0.0275;
  for (const sx of [-1, 1]) {
    const sd = sx < 0 ? 'l' : 'r';
    const post = new THREE.Mesh(new THREE.BoxGeometry(postX1 - postX0, postTopY - postBaseY, postHalfZ * 2), body);
    post.name = `ugv-mast-post-${sd}`;
    post.position.set(sx * (postX0 + postX1) / 2, (postBaseY + postTopY) / 2, mastZ); g.add(post);
    // The brace is a tapered strut, not a box: a flat face against the arm, splaying out and down
    // onto the whole top of the post. Its eight corners are the edit's, to the millimetre.
    const ax = sx * hullHalf * (sx < 0 ? 0.630 : 0.649), topHalfZ = 0.079;
    const y0 = mastPlateY - 0.015, y1 = mastPlateY + 0.015;
    const brace = hexa(
      [[ax, y0, mastZ - topHalfZ], [ax, y0, mastZ + topHalfZ],
       [ax, y1, mastZ + topHalfZ], [ax, y1, mastZ - topHalfZ]],
      [[sx * postX0, postTopY, mastZ - 0.025], [sx * postX0, postTopY, mastZ + 0.025],
       [sx * postX1, postTopY, mastZ + 0.025], [sx * postX1, postTopY, mastZ - 0.025]],
      panel);
    brace.name = `ugv-mast-brace-${sd}`; g.add(brace);
  }
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.592, 0.03, 0.16), body);
  arm.name = 'ugv-mast-arm';
  arm.position.set(0.004, mastPlateY, mastZ); g.add(arm);
  const workLamp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.07), dark);
  workLamp.name = 'ugv-work-lamp';
  workLamp.position.set(-hullHalf * 0.435, Y(2.936), mastZ); g.add(workLamp);
  const workFace = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.035, 0.008), lens);
  workFace.name = 'ugv-work-lamp-face';
  workFace.position.set(-hullHalf * 0.435, Y(2.934), mastZ - 0.038); g.add(workFace);
  const camBox = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.075), body);
  camBox.name = 'ugv-mast-camera';
  camBox.position.set(0.002, Y(2.966), mastZ); g.add(camBox);
  const camLens = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.02, 10), lens);
  camLens.rotation.x = Math.PI / 2;
  camLens.name = 'ugv-mast-camera-lens';
  camLens.position.set(0.002, Y(2.971), mastZ - 0.045); g.add(camLens);
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.06, 10), body);
  stalk.name = 'ugv-dome-stalk';
  stalk.position.set(hullHalf * 0.511, Y(2.941), mastZ); g.add(stalk);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), dark);
  dome.name = 'ugv-dome';
  dome.position.set(hullHalf * 0.511, Y(2.950), mastZ); g.add(dome);
  for (const wx of [-hullHalf * 0.266, hullHalf * 0.247]) {
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.014, antTopY - mastPlateY, 6), dark);
    whip.name = `ugv-whip-${wx < 0 ? 'l' : 'r'}`;
    whip.position.set(wx, (mastPlateY + antTopY) / 2, mastZ); g.add(whip);
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.07, 8), dark);
    boot.name = `ugv-whip-boot-${wx < 0 ? 'l' : 'r'}`;
    boot.position.set(wx, Y(2.932), mastZ); g.add(boot);
  }
  // Corrugated conduit dropping from the turret base to the deck.
  for (const sx of [-1, 1]) {
    g.add(name(tube([sx * 0.053, 0.756 - clear + 0.25, -0.053], [sx * 0.247, 0.602 - clear + 0.25, 0.413], 0.021, dark, 6),
      `ugv-conduit-${sx < 0 ? 'l' : 'r'}`));
  }

  const out = finishVehicle(g, wheels, { turret, elevation });
  // Where each switch's light sits, in the mesh frame (nose down -Z), and the lit disc the view
  // draws there. `parent` names the group a light hangs off so it trains with the gun.
  out.userData.lights = {
    head: { pos: [0, deckY - 0.07, nose - 0.02], dir: [0, -0.06, -1] },
    lamp: { pos: [-hullHalf * 0.435, Y(2.90), mastZ] },
    turretLight: { pos: [0.134, ey(gunY - 0.10), -0.40 + GUN_Z], dir: [0, 0, -1], parent: 'elevation' },
    turretLaser: { pos: [-0.134, ey(gunY - 0.10), -0.40 + GUN_Z], dir: [0, 0, -1], parent: 'elevation' },
  };
  return out;
}

const BUGGY_DIMS = { wheelbase: 2.4, track: 1.6, clearance: 0.4 };

// Open tactical buggy on the proportions of a light strike vehicle: tube spaceframe, full roll
// cage, bucket seats, long-travel wishbones and a rear cargo deck. Same origin rule as the UGV.
export function buildBuggy(tint, m, dims = BUGGY_DIMS) {
  const wb = dims.wheelbase ?? BUGGY_DIMS.wheelbase;
  const track = dims.track ?? BUGGY_DIMS.track;
  const clear = dims.clearance ?? BUGGY_DIMS.clearance;
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x1e2126), rim = m.standard(0x71787f);
  const seatMat = m.standard(0x39322a), lamp = m.standard(0x203038, 0x9fd8ff);
  // As in buildUgv: hull colour, double-sided, and a distinct material from `body`.
  const panel = m.standard(tint, 0x000000, DOUBLE_SIDED); panel.side = THREE.DoubleSide;
  const mats = { tyre: dark, rim, dark };

  const r = clear * 0.9;
  const wheelW = track * 0.17;
  const axleY = r - clear;
  const halfWb = wb * 0.5, halfTrack = track * 0.5;
  const nose = -(halfWb + 0.65), tail = halfWb + 0.52;
  const railX = halfTrack * 0.65, floorY = clear * 0.25;
  // The driver's body is placed at `seatOffset`, so the drawn seat is centred there rather than on
  // a guess; the cage then has to be wide enough to hold it.
  const seat = dims.seatOffset ?? [-halfTrack * 0.26, 0, 0];
  const seatX = Math.abs(Number(seat[0])) || halfTrack * 0.26;
  const seatZ = Number(seat[2]) || 0;
  const driverSide = (Number(seat[0]) || -1) < 0 ? -1 : 1;

  const floor = new THREE.Mesh(new THREE.BoxGeometry(railX * 2.1, 0.06, wb * 0.86), dark);
  floor.name = 'buggy-floor';
  floor.position.y = floorY; g.add(floor);
  for (const [xi, x] of [-railX, railX].entries()) {
    g.add(name(tube([x, floorY + 0.03, nose + 0.3], [x, floorY + 0.03, tail - 0.2], 0.045, rim),
      `buggy-frame-rail-${xi ? 'r' : 'l'}`));
  }
  for (const [zi, z] of [-halfWb * 0.85, 0.05, halfWb * 0.9].entries()) {
    g.add(name(tube([-railX, floorY + 0.03, z], [railX, floorY + 0.03, z], 0.04, rim), `buggy-crossmember-${zi}`));
  }

  const bonnet = new THREE.Mesh(bodyProfile([
    [nose, clear * 0.5], [nose + 0.18, clear * 1.15], [nose + 0.85, clear * 1.4],
    [nose + 1.2, clear * 1.25], [nose + 1.2, floorY], [nose + 0.08, floorY * 0.7],
  ], railX * 1.85), body);
  bonnet.name = 'buggy-bonnet';
  g.add(bonnet);
  const skid = new THREE.Mesh(new THREE.BoxGeometry(railX * 1.7, 0.03, 0.9), rim);
  skid.name = 'buggy-skid-plate';
  skid.position.set(0, floorY * 0.5, nose + 0.6); g.add(skid);

  const guardY = clear * 1.85;
  for (const [xi, x] of [-railX * 0.86, railX * 0.86].entries()) {
    g.add(name(tube([x, clear * 0.45, nose + 0.02], [x, guardY, nose + 0.08], 0.045, dark),
      `buggy-bullbar-upright-${xi ? 'r' : 'l'}`));
  }
  g.add(name(tube([-railX * 0.86, guardY, nose + 0.08], [railX * 0.86, guardY, nose + 0.08], 0.045, dark),
    'buggy-bullbar-top'));
  for (const [xi, x] of [-railX * 0.3, railX * 0.3].entries()) {
    g.add(name(tube([x, clear * 0.5, nose + 0.05], [x, guardY, nose + 0.08], 0.032, dark),
      `buggy-bullbar-inner-${xi ? 'r' : 'l'}`));
  }
  const lightBar = new THREE.Mesh(new THREE.BoxGeometry(railX * 1.3, 0.1, 0.09), dark);
  lightBar.name = 'buggy-light-bar';
  lightBar.position.set(0, guardY + 0.1, nose + 0.06); g.add(lightBar);
  for (const i of [-1.5, -0.5, 0.5, 1.5]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10), lamp);
    lens.rotation.x = Math.PI / 2;
    lens.name = `buggy-headlamp-${i}`;
    lens.position.set(i * railX * 0.36, guardY + 0.1, nose + 0.01); g.add(lens);
  }

  // Roll cage: A-pillars raked back to the roof, vertical B-pillars, roof rails and rear braces.
  const cageX = Math.max(halfTrack * 0.75, seatX + 0.26), roofY = clear * 4.05;
  const aBase = -halfWb * 0.46, aTop = -halfWb * 0.13, bZ = halfWb * 0.52, braceZ = tail - 0.18;
  for (const sx of [-1, 1]) {
    const x = sx * cageX;
    const sd = sx < 0 ? 'l' : 'r';
    g.add(name(tube([x, clear * 1.25, aBase], [x, roofY, aTop], 0.05, dark), `buggy-cage-a-pillar-${sd}`));
    g.add(name(tube([x, floorY + 0.05, bZ], [x, roofY, bZ], 0.05, dark), `buggy-cage-b-pillar-${sd}`));
    g.add(name(tube([x, roofY, aTop], [x, roofY, bZ], 0.05, dark), `buggy-cage-roof-rail-${sd}`));
    g.add(name(tube([x, roofY, bZ], [x, clear * 0.8, braceZ], 0.05, dark), `buggy-cage-rear-brace-${sd}`));
    g.add(name(tube([x, clear * 1.3, aBase + 0.05], [x, clear * 1.1, bZ - 0.05], 0.04, dark), `buggy-cage-side-bar-${sd}`));
  }
  g.add(name(tube([-cageX, roofY, aTop], [cageX, roofY, aTop], 0.05, dark), 'buggy-cage-front-hoop'));
  // A work lamp clamped to the front roof rail, lensed down and forward over the bonnet.
  const roofLamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.09), dark);
  roofLamp.name = 'buggy-roof-lamp';
  roofLamp.position.set(0, roofY + 0.06, aTop - 0.02); g.add(roofLamp);
  const roofFace = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.01), lamp);
  roofFace.name = 'buggy-roof-lamp-face';
  roofFace.position.set(0, roofY + 0.06, aTop - 0.07); g.add(roofFace);
  g.add(name(tube([-cageX, roofY, bZ], [cageX, roofY, bZ], 0.05, dark), 'buggy-cage-rear-hoop'));
  g.add(name(tube([-cageX, roofY - 0.06, bZ + 0.06], [cageX, clear * 1.0, braceZ - 0.05], 0.035, dark), 'buggy-cage-x-brace-l'));
  g.add(name(tube([cageX, roofY - 0.06, bZ + 0.06], [-cageX, clear * 1.0, braceZ - 0.05], 0.035, dark), 'buggy-cage-x-brace-r'));

  const dash = new THREE.Mesh(new THREE.BoxGeometry(cageX * 1.9, 0.2, 0.14), dark);
  dash.name = 'buggy-dash';
  dash.position.set(0, clear * 1.8, -halfWb * 0.35); g.add(dash);
  for (const sx of [-1, 1]) {
    const x = sx * seatX;
    const pan = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.09, 0.46), seatMat);
    pan.name = `buggy-seat-pan-${sx < 0 ? 'l' : 'r'}`;
    pan.position.set(x, clear * 1.3, seatZ); g.add(pan);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.64, 0.11), seatMat);
    back.name = `buggy-seat-back-${sx < 0 ? 'l' : 'r'}`;
    back.position.set(x, clear * 2.1, seatZ + 0.21); back.rotation.x = -0.15; g.add(back);
    const rest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.17, 0.1), seatMat);
    rest.name = `buggy-headrest-${sx < 0 ? 'l' : 'r'}`;
    rest.position.set(x, clear * 2.95, seatZ + 0.27); g.add(rest);
    for (const bx of [-1, 1]) {
      const bolster = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.44), seatMat);
      bolster.name = `buggy-bolster-${sx < 0 ? 'l' : 'r'}${bx < 0 ? 'i' : 'o'}`;
      bolster.position.set(x + bx * 0.22, clear * 1.7, seatZ + 0.02); g.add(bolster);
    }
  }
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 6), rim);
  column.name = 'buggy-steering-column';
  column.position.set(driverSide * seatX, clear * 2.0, seatZ - 0.32);
  column.rotation.x = 1.05; g.add(column);
  const steer = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.023, 6, 14), dark);
  steer.name = 'buggy-steering-wheel';
  steer.position.set(driverSide * seatX, clear * 2.2, seatZ - 0.22);
  steer.rotation.x = 1.05; g.add(steer);

  const bed = new THREE.Mesh(new THREE.BoxGeometry(railX * 2, 0.05, wb * 0.3), rim);
  bed.name = 'buggy-cargo-bed';
  bed.position.set(0, clear * 0.95, halfWb * 0.72); g.add(bed);
  for (const [xi, x] of [-railX, railX].entries()) {
    g.add(name(tube([x, clear * 1.1, halfWb * 0.56], [x, clear * 1.1, braceZ - 0.06], 0.032, dark),
      `buggy-bed-rail-${xi ? 'r' : 'l'}`));
  }
  const spare = vehicleWheel(0, clear * 1.28, halfWb * 0.74, r * 0.92, wheelW, mats, false, null, 'buggy-spare');
  spare.name = 'buggy-spare-wheel';
  spare.rotation.z = Math.PI / 2; g.add(spare);
  g.add(name(tube([halfTrack * 0.4, clear * 0.7, halfWb * 0.8], [halfTrack * 0.42, clear * 0.95, tail], 0.04, rim), 'buggy-exhaust'));

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * halfTrack, z = sz * halfWb, ix = sx * railX;
    const cnr = `${sx < 0 ? 'l' : 'r'}${sz < 0 ? 'f' : 'b'}`;
    g.add(name(tube([ix, axleY + 0.02, z], [x * 0.94, axleY - 0.02, z], 0.045, rim), `buggy-lower-wishbone-${cnr}`));
    g.add(name(tube([ix, axleY + 0.32, z], [x * 0.92, axleY + 0.16, z], 0.04, rim), `buggy-upper-wishbone-${cnr}`));
    g.add(name(tube([ix * 0.9, clear * 1.3, z - sz * 0.06], [x * 0.9, axleY + 0.04, z], 0.045, dark), `buggy-damper-${cnr}`));
    g.add(name(wheelArch(x, axleY, z, r * 1.22, wheelW * 1.4, panel), `buggy-mudguard-${cnr}`));
  }

  const wheels = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wn = `buggy-wheel-${sx < 0 ? 'l' : 'r'}${sz < 0 ? 'f' : 'b'}`;
    g.add(name(vehicleWheel(sx * halfTrack, axleY, sz * halfWb, r, wheelW, mats, sz < 0, wheels, wn), wn));
  }
  const out = finishVehicle(g, wheels, {});
  out.userData.lights = {
    head: { pos: [0, guardY + 0.1, nose - 0.02], dir: [0, -0.05, -1] },
    lamp: { pos: [0, roofY + 0.06, aTop - 0.10], dir: [0, -0.45, -1] },
  };
  return out;
}

// A real reconnaissance airframe rather than a shrunken fighter: the proportions below were measured
// off a press photo of a Ukrainian "Army of Drones" fixed-wing recon UAV and are metres at scale 1
// (2.02 m span, 1.13 m long). Pusher propeller behind the tail boom, 35-degree V-tail, paddle tips.
// Nose points -Z like every other craft here. The livery is deliberately not reproduced: the caller
// tints the shell by team, and a printed blue-and-yellow wing would fight that read.
const RECON = {
  halfSpan: 0.4655, rootChord: 0.200, tipChord: 0.130, thick: 0.024, taperFrac: 0.35,
  vtHalf: 0.0575, vtRootChord: 0.045, vtTipChord: 0.026, vtThick: 0.008,
  vtDihedral: 35 * Math.PI / 180, vtStation: 0.480,
  boomZ0: 0.30, boomZ1: 0.565, boomR0: 0.0527, boomR1: 0.024,
};
// boom radius at the tail station, so each V-tail surface starts on the skin and not on the axis
const RECON_BOOM_R = RECON.boomR0
  + (RECON.vtStation - RECON.boomZ0) / (RECON.boomZ1 - RECON.boomZ0) * (RECON.boomR1 - RECON.boomR0);

// A flying surface as a tapered planform extruded to thickness. Points are (span, chord) in metres.
// ExtrudeGeometry runs 0..depth in its own Z, so the result is recentred and then turned so span
// lands on X, chord on Z and thickness on Y.
function reconPanel(points, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -depth / 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// Constant chord inboard, straight taper over the outer third. `tipAtPositive` mirrors it for port.
function reconWingPoints(tipAtPositive) {
  const h = RECON.halfSpan, r = RECON.rootChord / 2, t = RECON.tipChord / 2;
  const taper = RECON.taperFrac * 2 * h, s = tipAtPositive ? 1 : -1;
  return [[-s * h, -r], [s * (h - taper), -r], [s * h, -t], [s * h, t], [s * (h - taper), r], [-s * h, r]];
}

// A tapered cylinder along Z. CylinderGeometry runs up its own Y, so +Y becomes +Z under the turn
// and the radius nearest the tail is the one passed as `radiusTop`.
function reconTube(z0, z1, r0, r1, seg, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, z1 - z0, seg), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = (z0 + z1) / 2;
  return mesh;
}

export function buildRecon(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x23252a);

  g.add(name(reconTube(-0.31, 0.31, 0.065, 0.052, 12, body), 'recon-fuselage'));
  g.add(name(reconTube(RECON.boomZ0, RECON.boomZ1, RECON.boomR0, RECON.boomR1, 10, body), 'recon-tail-boom'));

  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), body);
  nose.name = 'recon-nose';
  nose.scale.set(0.065, 0.065, 0.22); nose.position.z = -0.310; g.add(nose);

  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.045, 0.115), dark);
  hatch.name = 'recon-hatch';
  hatch.position.set(-0.055, -0.025, 0.020); g.add(hatch);

  for (const side of [1, -1]) {
    const wing = new THREE.Mesh(reconPanel(reconWingPoints(side > 0), RECON.thick), body);
    wing.name = `recon-wing-${side < 0 ? 'l' : 'r'}`;
    wing.position.set(side * 0.5045, 0.005, -0.020); g.add(wing);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), body);   // paddle tip
    cap.name = `recon-wingtip-${side < 0 ? 'l' : 'r'}`;
    cap.scale.set(0.035, RECON.thick / 2, RECON.tipChord / 2);
    cap.position.set(side * 0.970, 0.005, -0.020); g.add(cap);
  }

  // Both surfaces share one geometry and differ only by the swing about Z, which is what puts each
  // root on the boom skin instead of both of them on the body centreline.
  const vtPoints = [[-RECON.vtHalf, -RECON.vtRootChord / 2], [RECON.vtHalf, -RECON.vtTipChord / 2],
    [RECON.vtHalf, RECON.vtTipChord / 2], [-RECON.vtHalf, RECON.vtRootChord / 2]];
  const vtGeo = reconPanel(vtPoints, RECON.vtThick);
  for (const side of [1, -1]) {
    const dx = side * Math.cos(RECON.vtDihedral), dy = Math.sin(RECON.vtDihedral);
    const arm = RECON_BOOM_R + RECON.vtHalf;
    const fin = new THREE.Mesh(vtGeo, body);
    fin.name = `recon-fin-${side < 0 ? 'l' : 'r'}`;
    fin.position.set(dx * arm, dy * arm, RECON.vtStation);
    fin.rotation.z = Math.atan2(dy, dx);
    g.add(fin);
  }

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0045, 0.142, 5), dark);
  mast.name = 'recon-tip-mast';
  mast.position.set(-0.995, 0.008, -0.140); mast.rotation.x = -Math.PI / 2; g.add(mast);   // port tip mast

  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.042, 0.050), body);
  pylon.name = 'recon-pylon';
  pylon.position.z = 0.556; g.add(pylon);

  // The propeller is a child group so the spin is one rotation on the hub, not two on the blades.
  const prop = new THREE.Group();
  prop.position.z = 0.588;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.020, 8), dark);
  hub.name = 'recon-prop-hub';
  hub.rotation.x = Math.PI / 2; prop.add(hub);
  for (const side of [1, -1]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.134, 0.006, 0.030), dark);
    blade.name = `recon-prop-blade-${side < 0 ? 'l' : 'r'}`;
    blade.position.x = side * 0.079; blade.rotation.x = side * 0.34; prop.add(blade);
  }
  g.add(prop);
  g.userData.propeller = prop;
  return g;
}

// A stealth flying wing at its real size: 20 m span, 7.45 m nose to wingtip, proportions measured
// off a three-view drawing of the RQ-170 Sentinel (scratchpads/rq170-sentinel/intake-analysis.md).
// Planform and section come from the same functions the reconstruction spec used: leading edge
// swept 0.638 aft per metre of span, a trailing edge kinked at 3.3 m, a flat upper skin and all
// the section depth on the underside. No landing gear: it only ever flies. Nose points -Z.
const SENTINEL_NOSE_Z = -3.7;
function sentinelLE(x) { x = Math.abs(x); return x <= 9.6 ? 0.638 * x : 6.12 + (x - 9.6) / 0.4 * (7.05 - 6.12); }
function sentinelTE(x) {
  x = Math.abs(x);
  if (x <= 3.3) return 6.26 - 0.77 * x / 3.3;
  if (x <= 9.0) return 5.49 + 0.358 * (x - 3.3);
  return 7.53 - (x - 9.0) * (7.53 - 7.05);
}
const SENTINEL_THICK = [[0, 0.95], [1.75, 0.85], [3.3, 0.62], [6.0, 0.42], [9.0, 0.30], [9.6, 0.24], [10.0, 0.0]];
function sentinelThick(x) {
  x = Math.abs(x);
  for (let i = 0; i + 1 < SENTINEL_THICK.length; i++) {
    const [x0, t0] = SENTINEL_THICK[i], [x1, t1] = SENTINEL_THICK[i + 1];
    if (x >= x0 && x <= x1) return t0 + (t1 - t0) * (x - x0) / (x1 - x0);
  }
  return 0;
}
// The wing as one loft: ribs at measured stations, each a flat top from LE to TE and a lens
// underside back to the LE, mirrored so port and starboard share every vertex on the centreline.
function sentinelWingGeometry() {
  const half = [0, 0.5, 1.0, 1.75, 2.5, 3.3, 4.5, 6.0, 7.5, 9.0, 9.6, 10.0];
  const xs = [...half.slice(1).reverse().map((x) => -x), ...half];
  const N = 10;   // chord samples per surface
  const pos = [], idx = [];
  const ring = 2 * N;
  for (const x of xs) {
    const le = sentinelLE(x) + SENTINEL_NOSE_Z, te = sentinelTE(x) + SENTINEL_NOSE_Z, t = sentinelThick(x);
    for (let j = 0; j < N; j++) { const s = j / (N - 1); pos.push(x, 0, le + (te - le) * s); }                                    // upper, LE to TE
    for (let j = 0; j < N; j++) { const s = 1 - j / (N - 1); pos.push(x, -t * Math.sin(Math.PI * s), le + (te - le) * s); }        // lower, TE to LE
  }
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = i * ring, b = (i + 1) * ring;
    for (let k = 0; k < ring; k++) {
      const k2 = (k + 1) % ring;
      idx.push(a + k, b + k, b + k2, a + k, b + k2, a + k2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
export function buildSentinel(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x23252a);
  const z = (a) => a + SENTINEL_NOSE_Z;
  const blob = (sx, sy, sz, x, y, a, nm, mat = body) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat);
    mesh.name = nm;
    mesh.scale.set(sx, sy, sz); mesh.position.set(x, y, z(a)); g.add(mesh); return mesh;
  };
  const wing = new THREE.Mesh(sentinelWingGeometry(), body);
  wing.name = 'sentinel-wing'; g.add(wing);
  blob(0.90, 0.62, 1.5, 0, -0.12, 2.3, 'sentinel-dorsal-hump');
  blob(0.62, 0.45, 1.9, 0, -0.15, 4.2, 'sentinel-dorsal-fairing');
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.45, 1.2), body);
  tail.name = 'sentinel-exhaust-fairing';
  tail.position.set(0, -0.30, z(5.6)); g.add(tail);   // blunt exhaust fairing
  const exhaust = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.26, 0.4), dark);
  exhaust.name = 'sentinel-exhaust';
  exhaust.position.set(0, -0.08, z(6.0)); g.add(exhaust);
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.4), dark);
  intake.name = 'sentinel-intake';
  intake.position.set(0, 0.20, z(1.1)); g.add(intake);
  for (const side of [1, -1]) {
    blob(0.50, 0.42, 0.65, side * 1.67, -0.02, 2.55, `sentinel-blister-${side < 0 ? 'l' : 'r'}`);
    blob(0.34, 0.28, 1.0, side * 1.67, -0.10, 3.55, `sentinel-blister-taper-${side < 0 ? 'l' : 'r'}`);
    const roundel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.01, 16), dark);
    roundel.name = `sentinel-roundel-${side < 0 ? 'l' : 'r'}`;
    roundel.position.set(side * 5.0, 0.004, z((sentinelLE(5) + sentinelTE(5)) / 2)); g.add(roundel);
  }
  return g;
}

// The air-to-ground missile the Sentinel carries: a 1.6 m body at its real size, so it looks like
// what it is next to a 20 m wing rather than like a thrown rock. Four tail fins, four nose canards,
// a dark seeker window. Nose points -Z, as every craft here does, so the same "point it along the
// velocity" code aims it.
export function buildAgm(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint ?? 0x4a4d52), dark = m.standard(0x1a1c20), glass = m.standard(0x101820, 0x0a1218);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.34, 12), body);
  tube.name = 'agm-body';
  tube.rotation.x = Math.PI / 2; g.add(tube);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.34, 12), body);
  nose.name = 'agm-nose';
  nose.rotation.x = -Math.PI / 2; nose.position.z = -0.84; g.add(nose);
  const seeker = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), glass);
  seeker.name = 'agm-seeker';
  seeker.position.z = -0.95; g.add(seeker);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.075, 0.10, 10), dark);
  nozzle.name = 'agm-nozzle';
  nozzle.rotation.x = Math.PI / 2; nozzle.position.z = 0.70; g.add(nozzle);
  // Fins in two sets of four, rolled 45 degrees apart: tail for stability, canards up front.
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.20, 0.28), dark);
    tail.name = `agm-tail-fin-${i}`;
    tail.position.set(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0.53);
    tail.rotation.z = a; g.add(tail);
    const canard = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.12, 0.16), dark);
    canard.name = `agm-canard-${i}`;
    canard.position.set(Math.cos(a + Math.PI / 4) * 0.12, Math.sin(a + Math.PI / 4) * 0.12, -0.44);
    canard.rotation.z = a + Math.PI / 4; g.add(canard);
  }
  return g;
}

registerCraftMesh('plane', buildPlane);
registerCraftMesh('drone', buildDrone);
registerCraftMesh('bird', buildBird);
registerCraftMesh('recon', buildRecon);
registerCraftMesh('ugv', buildUgv);
registerCraftMesh('buggy', buildBuggy);
registerCraftMesh('sentinel', buildSentinel);
registerCraftMesh('agm', buildAgm);

// One entry point: nothing downstream should branch on the airframe key itself.
// `dims` is optional and only the ground vehicles read it: their wheels come from the simulation's
// wheelbase, track and clearance so the drawn contact patch is the one the ground fit samples.
export function buildCraftMesh(kind, tint, materials, dims = undefined) {
  const build = BUILDERS[kind];
  if (!build) throw new Error(`no craft mesh for '${kind}'. Registered: ${Object.keys(BUILDERS).join(', ')}`);
  const g = build(tint, shareCraftMaterials(materials), dims);
  acquireCraftMaterials(g);                 // one reference per mesh slot; the teardown gives them back
  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}
