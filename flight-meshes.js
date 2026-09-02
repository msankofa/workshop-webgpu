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

export function buildPlane(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x2a3038), glass = m.standard(0x121a24, 0x0a1520);
  const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 6.2, 6, 12), body);
  fuse.rotation.x = Math.PI / 2; g.add(fuse);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.62, 2.2, 12), body);
  nose.rotation.x = -Math.PI / 2; nose.position.z = -4.6; g.add(nose);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.22, 2.6), body);
  wing.position.set(0, -0.15, 0.4); g.add(wing);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.18, 1.2), body);
  stab.position.set(0, 0.1, 3.5); g.add(stab);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.9, 1.5), body);
  fin.position.set(0, 1.05, 3.5); g.add(fin);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), glass);
  canopy.scale.set(1, 0.75, 2.1); canopy.position.set(0, 0.5, -1.4); g.add(canopy);
  const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 12), dark);
  intake.rotation.x = Math.PI / 2; intake.position.z = 3.3; g.add(intake);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.44, 2.6, 10), m.basic(0x8fd0ff, 0.85));
  flame.rotation.x = Math.PI / 2; flame.position.z = 4.6; g.add(flame);
  g.userData.flame = flame;
  return g;
}

export function buildDrone(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x1d2228);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.07, 0.26), body); g.add(hull);
  const rotors = [];
  for (let i = 0; i < 4; i++) {
    const sx = i < 2 ? 1 : -1, sz = i % 2 === 0 ? 1 : -1;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.018, 0.26), dark);
    arm.position.set(sx * 0.11, 0, sz * 0.13);
    arm.rotation.y = sx * sz * 0.62; g.add(arm);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8), dark);
    hub.position.set(sx * 0.20, 0.02, sz * 0.20); g.add(hub);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.004, 16), m.basic(0xbfd8ee, 0.30));
    disc.position.set(sx * 0.20, 0.038, sz * 0.20); g.add(disc);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.004, 0.018), dark);
    blade.position.copy(disc.position); g.add(blade);
    rotors.push(blade);
  }
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), m.standard(0x0d1116, 0x102030));
  cam.position.set(0, -0.045, -0.09); g.add(cam);
  g.userData.rotors = rotors;
  return g;
}

export function buildBird(tint, m) {
  const g = new THREE.Group();
  const body = m.standard(tint), dark = m.standard(0x25201c);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), body);
  torso.scale.set(1, 0.9, 2.4); g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), body);
  head.position.set(0, 0.06, -0.38); g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.16, 7), m.standard(0xc8a33f));
  beak.rotation.x = -Math.PI / 2; beak.position.set(0, 0.04, -0.52); g.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.34), dark);
  tail.position.set(0, 0.02, 0.44); g.add(tail);
  const wings = [];
  for (const side of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.10, 0.05, -0.02);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.018, 0.30), body);
    wing.position.set(side * 0.36, 0, 0.02);
    pivot.add(wing); g.add(pivot);
    wings.push({ pivot, side, wing });
  }
  g.userData.wings = wings;
  return g;
}

// A cylinder spanning two points, for tube frames and roll cages. `a` and `b` are [x, y, z].
const _tubeA = new THREE.Vector3(), _tubeDir = new THREE.Vector3(), _tubeUp = new THREE.Vector3(0, 1, 0);
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
function vehicleWheel(x, y, z, radius, width, mats, front, wheels) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const spin = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width * 0.86, 16), mats.tyre);
  tyre.rotation.z = Math.PI / 2;
  spin.add(tyre);
  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.93, radius * 0.93, width, 16), mats.tyre);
  shoulder.rotation.z = Math.PI / 2;
  spin.add(shoulder);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width * 1.04, 12), mats.rim);
  rim.rotation.z = Math.PI / 2;
  spin.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, width * 1.14, 8), mats.dark);
  hub.rotation.z = Math.PI / 2;
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

// Merges the hull into one draw per material and each wheel's four rings into one per material,
// leaving the pivots free to steer and roll.
function finishVehicle(g, wheels, named = {}) {
  const groups = Object.values(named).filter(Boolean);
  const skip = new Set(wheels.map(w => w.pivot));
  for (const group of groups) skip.add(group);
  mergeByMaterial(g, skip);
  for (const wheel of wheels) mergeByMaterial(wheel.spin);
  for (const group of groups) mergeByMaterial(group, skip);
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
  const panel = m.standard(tint); panel.side = THREE.DoubleSide;
  const mats = { tyre: dark, rim, dark };

  // Tyre diameter is 0.55 x wheelbase, the reference's own tyre-to-body relationship. Y(f) puts a
  // measured band, given as a fraction of that diameter above ground, into mesh space.
  const D = wb * 0.55, r = D / 2, wheelW = D * 0.32;
  const Y = (f) => f * D - clear;
  const axleY = Y(0.5), tubFloor = Y(0.55), sideLow = Y(0.66), deckY = Y(1.42);
  const railLow = Y(1.45), railTop = Y(1.71), pedTop = Y(1.95), rwsY = Y(2.45);
  const gunY = Y(2.62), mastPlateY = Y(2.85), domeY = Y(3.0), antTopY = Y(3.4);
  const halfWb = wb / 2, halfTrack = track / 2;
  const nose = -(halfWb + 0.27), tail = halfWb + 0.31, hullHalf = halfTrack * 0.75;

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
    flange.position.set(sx * hullHalf, deckY + 0.012, (nose + tail) / 2); g.add(flange);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(hullHalf * 1.86, 0.02, (tail - nose) * 0.86), deckMat);
  deck.position.set(0, deckY + 0.011, (nose + tail) / 2 + 0.01); g.add(deck);

  // ── perimeter cargo rail: lower tube at deck level, posts, upper tube ──────
  const railHalf = hullHalf * 1.02, railZ0 = nose + 0.10, railZ1 = tail - 0.08, tubeR = D * 0.037;
  for (const y of [railLow, railTop]) {
    for (const sx of [-1, 1]) g.add(tube([sx * railHalf, y, railZ0], [sx * railHalf, y, railZ1], tubeR, body));
    for (const z of [railZ0, railZ1]) g.add(tube([-railHalf, y, z], [railHalf, y, z], tubeR, body));
  }
  for (const sx of [-1, 1]) for (const z of [railZ0, railZ0 * 0.36 + railZ1 * 0.64, railZ1]) {
    g.add(tube([sx * railHalf, railLow, z], [sx * railHalf, railTop, z], tubeR * 0.92, body));
  }
  for (const z of [railZ0, railZ1]) for (const sx of [-1, 1]) {
    g.add(tube([sx * railHalf * 0.45, railLow, z], [sx * railHalf * 0.45, railTop, z], tubeR * 0.85, body));
  }
  // Slotted mounting plates between the rails, and the clamp blocks bolted to them.
  for (const sx of [-1, 1]) for (const zf of [0.26, 0.68]) {
    const z = railZ0 + (railZ1 - railZ0) * zf;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.016, (railTop - railLow) * 0.82, 0.30), body);
    plate.position.set(sx * railHalf, (railLow + railTop) / 2, z); g.add(plate);
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.085), body);
    block.position.set(sx * (railHalf + 0.02), (railLow + railTop) / 2, z); g.add(block);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.05, 8), dark);
    knob.rotation.z = Math.PI / 2;
    knob.position.set(sx * (railHalf + 0.075), (railLow + railTop) / 2, z); g.add(knob);
  }

  // ── mudguards, tow eyes, wheels ────────────────────────────────────────────
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(wheelArch(sx * halfTrack, axleY, sz * halfWb, r * 1.2, wheelW * 1.5, panel));
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.011, 5, 9), body);
    eye.position.set(sx * hullHalf * 0.92, sideLow + 0.05, sz * (halfWb + 0.20));
    eye.rotation.y = Math.PI / 2; g.add(eye);
  }
  const wheels = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(vehicleWheel(sx * halfTrack, axleY, sz * halfWb, r, wheelW, mats, sz < 0, wheels));
  }

  // ── remote weapon station, on its own group so it can be trained later ─────
  const turret = new THREE.Group();
  turret.position.set(0, deckY, -0.05);
  const ty = (y) => y - deckY;   // turret-local height
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.16, pedTop - deckY, 14), body);
  ped.position.y = ty((deckY + pedTop) / 2); turret.add(ped);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.05, 14), dark);
  collar.position.y = ty(pedTop - 0.01); turret.add(collar);
  const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.19, (rwsY - pedTop) * 1.15, 0.20), body);
  yoke.position.y = ty((pedTop + rwsY) / 2 + 0.02); turret.add(yoke);

  // The gun elevates about its trunnion, so everything that moves in pitch hangs off its own group
  // at that height. Pitching the whole station would tilt the pedestal with it.
  const elevation = new THREE.Group();
  elevation.position.set(0, ty(gunY), 0);
  turret.add(elevation);
  const ey = (y) => y - gunY;   // elevation-local height
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.14, 0.52), dark);
  receiver.position.set(0, ey(gunY - 0.035), -0.10); elevation.add(receiver);
  const cowl = new THREE.Mesh(bodyProfile([
    [-0.34, ey(gunY + 0.10)], [-0.20, ey(gunY + 0.155)], [0.20, ey(gunY + 0.15)], [0.26, ey(gunY + 0.03)],
    [0.10, ey(gunY - 0.08)], [-0.28, ey(gunY - 0.02)],
  ], 0.23), body);
  elevation.add(cowl);
  for (let i = 0; i < 6; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.245, 0.055, 0.016), dark);
    slot.position.set(0, ey(gunY + 0.095), -0.24 + i * 0.055); elevation.add(slot);
  }
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.17, 14), body);
  drum.rotation.z = Math.PI / 2;
  drum.position.set(0.10, ey(rwsY + 0.02), 0.06); elevation.add(drum);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.78, 9), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0, -0.71); elevation.add(barrel);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.024, 0.09, 9), dark);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -1.07); elevation.add(muzzle);
  const optic = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.30), dark);
  optic.position.set(0, ey(gunY - 0.15), -0.36); elevation.add(optic);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.02, 12), lens);
  glass.rotation.x = Math.PI / 2;
  glass.position.set(0, ey(gunY - 0.15), -0.52); elevation.add(glass);
  for (const sx of [-1, 1]) {
    const railBar = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.05, 0.44), dark);
    railBar.position.set(sx * 0.115, ey(gunY - 0.10), -0.06); elevation.add(railBar);
  }
  g.add(turret);

  // ── sensor mast: post at the rear, arm forward, camera, whips and dome ─────
  const mastX = hullHalf * 0.62, mastZ = tail - 0.20;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.055, mastPlateY - railLow, 0.055), body);
  post.position.set(mastX, (railLow + mastPlateY) / 2, mastZ); g.add(post);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.60), body);
  arm.position.set(mastX * 0.55, mastPlateY, mastZ - 0.29); g.add(arm);
  const brace = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.19), body);
  brace.position.set(mastX, mastPlateY - 0.055, mastZ - 0.09);
  brace.rotation.x = 0.72; g.add(brace);
  const camBox = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.075), body);
  camBox.position.set(mastX * 0.55, mastPlateY + 0.055, mastZ - 0.50); g.add(camBox);
  const camLens = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.02, 10), lens);
  camLens.rotation.x = Math.PI / 2;
  camLens.position.set(mastX * 0.55, mastPlateY + 0.058, mastZ - 0.54); g.add(camLens);
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.06, 10), body);
  stalk.position.set(mastX * 0.55, mastPlateY + 0.04, mastZ - 0.06); g.add(stalk);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), dark);
  dome.position.set(mastX * 0.55, domeY - 0.045, mastZ - 0.06); g.add(dome);
  for (const zf of [-0.40, -0.20]) {
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.014, antTopY - mastPlateY, 6), dark);
    whip.position.set(mastX * 0.55, (mastPlateY + antTopY) / 2, mastZ + zf); g.add(whip);
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.07, 8), dark);
    boot.position.set(mastX * 0.55, mastPlateY + 0.035, mastZ + zf); g.add(boot);
  }
  // Corrugated conduit dropping from the turret base to the deck.
  for (const sx of [-1, 1]) {
    g.add(tube([sx * 0.10, pedTop - 0.06, 0.06], [sx * 0.20, deckY + 0.03, 0.30], 0.021, dark, 6));
  }

  return finishVehicle(g, wheels, { turret, elevation });
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
  const panel = m.standard(tint); panel.side = THREE.DoubleSide;
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
  floor.position.y = floorY; g.add(floor);
  for (const x of [-railX, railX]) {
    g.add(tube([x, floorY + 0.03, nose + 0.3], [x, floorY + 0.03, tail - 0.2], 0.045, rim));
  }
  for (const z of [-halfWb * 0.85, 0.05, halfWb * 0.9]) {
    g.add(tube([-railX, floorY + 0.03, z], [railX, floorY + 0.03, z], 0.04, rim));
  }

  const bonnet = new THREE.Mesh(bodyProfile([
    [nose, clear * 0.5], [nose + 0.18, clear * 1.15], [nose + 0.85, clear * 1.4],
    [nose + 1.2, clear * 1.25], [nose + 1.2, floorY], [nose + 0.08, floorY * 0.7],
  ], railX * 1.85), body);
  g.add(bonnet);
  const skid = new THREE.Mesh(new THREE.BoxGeometry(railX * 1.7, 0.03, 0.9), rim);
  skid.position.set(0, floorY * 0.5, nose + 0.6); g.add(skid);

  const guardY = clear * 1.85;
  for (const x of [-railX * 0.86, railX * 0.86]) {
    g.add(tube([x, clear * 0.45, nose + 0.02], [x, guardY, nose + 0.08], 0.045, dark));
  }
  g.add(tube([-railX * 0.86, guardY, nose + 0.08], [railX * 0.86, guardY, nose + 0.08], 0.045, dark));
  for (const x of [-railX * 0.3, railX * 0.3]) {
    g.add(tube([x, clear * 0.5, nose + 0.05], [x, guardY, nose + 0.08], 0.032, dark));
  }
  const lightBar = new THREE.Mesh(new THREE.BoxGeometry(railX * 1.3, 0.1, 0.09), dark);
  lightBar.position.set(0, guardY + 0.1, nose + 0.06); g.add(lightBar);
  for (const i of [-1.5, -0.5, 0.5, 1.5]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10), lamp);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(i * railX * 0.36, guardY + 0.1, nose + 0.01); g.add(lens);
  }

  // Roll cage: A-pillars raked back to the roof, vertical B-pillars, roof rails and rear braces.
  const cageX = Math.max(halfTrack * 0.75, seatX + 0.26), roofY = clear * 4.05;
  const aBase = -halfWb * 0.46, aTop = -halfWb * 0.13, bZ = halfWb * 0.52, braceZ = tail - 0.18;
  for (const sx of [-1, 1]) {
    const x = sx * cageX;
    g.add(tube([x, clear * 1.25, aBase], [x, roofY, aTop], 0.05, dark));
    g.add(tube([x, floorY + 0.05, bZ], [x, roofY, bZ], 0.05, dark));
    g.add(tube([x, roofY, aTop], [x, roofY, bZ], 0.05, dark));
    g.add(tube([x, roofY, bZ], [x, clear * 0.8, braceZ], 0.05, dark));
    g.add(tube([x, clear * 1.3, aBase + 0.05], [x, clear * 1.1, bZ - 0.05], 0.04, dark));
  }
  g.add(tube([-cageX, roofY, aTop], [cageX, roofY, aTop], 0.05, dark));
  g.add(tube([-cageX, roofY, bZ], [cageX, roofY, bZ], 0.05, dark));
  g.add(tube([-cageX, roofY - 0.06, bZ + 0.06], [cageX, clear * 1.0, braceZ - 0.05], 0.035, dark));
  g.add(tube([cageX, roofY - 0.06, bZ + 0.06], [-cageX, clear * 1.0, braceZ - 0.05], 0.035, dark));

  const dash = new THREE.Mesh(new THREE.BoxGeometry(cageX * 1.9, 0.2, 0.14), dark);
  dash.position.set(0, clear * 1.8, -halfWb * 0.35); g.add(dash);
  for (const sx of [-1, 1]) {
    const x = sx * seatX;
    const pan = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.09, 0.46), seatMat);
    pan.position.set(x, clear * 1.3, seatZ); g.add(pan);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.64, 0.11), seatMat);
    back.position.set(x, clear * 2.1, seatZ + 0.21); back.rotation.x = -0.15; g.add(back);
    const rest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.17, 0.1), seatMat);
    rest.position.set(x, clear * 2.95, seatZ + 0.27); g.add(rest);
    for (const bx of [-1, 1]) {
      const bolster = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.44), seatMat);
      bolster.position.set(x + bx * 0.22, clear * 1.7, seatZ + 0.02); g.add(bolster);
    }
  }
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 6), rim);
  column.position.set(driverSide * seatX, clear * 2.0, seatZ - 0.32);
  column.rotation.x = 1.05; g.add(column);
  const steer = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.023, 6, 14), dark);
  steer.position.set(driverSide * seatX, clear * 2.2, seatZ - 0.22);
  steer.rotation.x = 1.05; g.add(steer);

  const bed = new THREE.Mesh(new THREE.BoxGeometry(railX * 2, 0.05, wb * 0.3), rim);
  bed.position.set(0, clear * 0.95, halfWb * 0.72); g.add(bed);
  for (const x of [-railX, railX]) {
    g.add(tube([x, clear * 1.1, halfWb * 0.56], [x, clear * 1.1, braceZ - 0.06], 0.032, dark));
  }
  const spare = vehicleWheel(0, clear * 1.28, halfWb * 0.74, r * 0.92, wheelW, mats, false, null);
  spare.rotation.z = Math.PI / 2; g.add(spare);
  g.add(tube([halfTrack * 0.4, clear * 0.7, halfWb * 0.8], [halfTrack * 0.42, clear * 0.95, tail], 0.04, rim));

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * halfTrack, z = sz * halfWb, ix = sx * railX;
    g.add(tube([ix, axleY + 0.02, z], [x * 0.94, axleY - 0.02, z], 0.045, rim));
    g.add(tube([ix, axleY + 0.32, z], [x * 0.92, axleY + 0.16, z], 0.04, rim));
    g.add(tube([ix * 0.9, clear * 1.3, z - sz * 0.06], [x * 0.9, axleY + 0.04, z], 0.045, dark));
    g.add(wheelArch(x, axleY, z, r * 1.22, wheelW * 1.4, panel));
  }

  const wheels = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(vehicleWheel(sx * halfTrack, axleY, sz * halfWb, r, wheelW, mats, sz < 0, wheels));
  }
  return finishVehicle(g, wheels, {});
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

  g.add(reconTube(-0.31, 0.31, 0.065, 0.052, 12, body));                      // fuselage pod
  g.add(reconTube(RECON.boomZ0, RECON.boomZ1, RECON.boomR0, RECON.boomR1, 10, body));   // tail boom

  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), body);
  nose.scale.set(0.065, 0.065, 0.22); nose.position.z = -0.310; g.add(nose);

  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.045, 0.115), dark);
  hatch.position.set(-0.055, -0.025, 0.020); g.add(hatch);

  for (const side of [1, -1]) {
    const wing = new THREE.Mesh(reconPanel(reconWingPoints(side > 0), RECON.thick), body);
    wing.position.set(side * 0.5045, 0.005, -0.020); g.add(wing);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), body);   // paddle tip
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
    fin.position.set(dx * arm, dy * arm, RECON.vtStation);
    fin.rotation.z = Math.atan2(dy, dx);
    g.add(fin);
  }

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0045, 0.142, 5), dark);
  mast.position.set(-0.995, 0.008, -0.140); mast.rotation.x = -Math.PI / 2; g.add(mast);   // port tip mast

  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.042, 0.050), body);
  pylon.position.z = 0.556; g.add(pylon);

  // The propeller is a child group so the spin is one rotation on the hub, not two on the blades.
  const prop = new THREE.Group();
  prop.position.z = 0.588;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.020, 8), dark);
  hub.rotation.x = Math.PI / 2; prop.add(hub);
  for (const side of [1, -1]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.134, 0.006, 0.030), dark);
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
  const blob = (sx, sy, sz, x, y, a, mat = body) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat);
    mesh.scale.set(sx, sy, sz); mesh.position.set(x, y, z(a)); g.add(mesh); return mesh;
  };
  const wing = new THREE.Mesh(sentinelWingGeometry(), body);
  wing.name = 'sentinel-wing'; g.add(wing);
  blob(0.90, 0.62, 1.5, 0, -0.12, 2.3);            // dorsal hump, steep front
  blob(0.62, 0.45, 1.9, 0, -0.15, 4.2);            // its tail fairing to the exhaust
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.45, 1.2), body);
  tail.position.set(0, -0.30, z(5.6)); g.add(tail);   // blunt exhaust fairing
  const exhaust = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.26, 0.4), dark);
  exhaust.position.set(0, -0.08, z(6.0)); g.add(exhaust);
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.4), dark);
  intake.position.set(0, 0.20, z(1.1)); g.add(intake);
  for (const side of [1, -1]) {
    blob(0.50, 0.42, 0.65, side * 1.67, -0.02, 2.55);   // sensor blister, fat end forward
    blob(0.34, 0.28, 1.0, side * 1.67, -0.10, 3.55);    // its taper aft
    const roundel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.01, 16), dark);
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
  tube.rotation.x = Math.PI / 2; g.add(tube);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.34, 12), body);
  nose.rotation.x = -Math.PI / 2; nose.position.z = -0.84; g.add(nose);
  const seeker = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), glass);
  seeker.position.z = -0.95; g.add(seeker);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.075, 0.10, 10), dark);
  nozzle.rotation.x = Math.PI / 2; nozzle.position.z = 0.70; g.add(nozzle);
  // Fins in two sets of four, rolled 45 degrees apart: tail for stability, canards up front.
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.20, 0.28), dark);
    tail.position.set(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0.53);
    tail.rotation.z = a; g.add(tail);
    const canard = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.12, 0.16), dark);
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
  const g = build(tint, materials, dims);
  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}
