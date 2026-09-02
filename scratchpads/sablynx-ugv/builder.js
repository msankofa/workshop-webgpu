// A closed-ring loft along Z: `rings` is [{ z, pts: [[x, y], ...] }] with equal point counts, nose
// first. Used for hull tubs, whose cross-section changes station to station and cannot be extruded.
function loftRings(rings) {
  const n = rings[0].pts.length, m = rings.length;
  const pos = [], idx = [];
  for (const ring of rings) for (const p of ring.pts) pos.push(p[0], p[1], ring.z);
  for (let s = 0; s < m - 1; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = s * n + i, b = s * n + j, c = (s + 1) * n + i, d = (s + 1) * n + j;
      idx.push(a, b, c, b, d, c);
    }
  }
  for (const [s, flip] of [[0, true], [m - 1, false]]) {
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
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.14, 0.52), dark);
  receiver.position.set(0, ty(gunY - 0.035), -0.10); turret.add(receiver);
  // Angular gun cowl with the reference's row of vertical louvre slots on each cheek.
  const cowl = new THREE.Mesh(bodyProfile([
    [-0.34, gunY + 0.10], [-0.20, gunY + 0.155], [0.20, gunY + 0.15], [0.26, gunY + 0.03],
    [0.10, gunY - 0.08], [-0.28, gunY - 0.02],
  ], 0.23), body);
  cowl.position.y = -deckY; turret.add(cowl);
  for (let i = 0; i < 6; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.245, 0.055, 0.016), dark);
    slot.position.set(0, ty(gunY + 0.095), -0.24 + i * 0.055); turret.add(slot);
  }
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.17, 14), body);
  drum.rotation.z = Math.PI / 2;
  drum.position.set(0.10, ty(rwsY + 0.02), 0.06); turret.add(drum);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.78, 9), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, ty(gunY), -0.71); turret.add(barrel);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.024, 0.09, 9), dark);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, ty(gunY), -1.07); turret.add(muzzle);
  const optic = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.30), dark);
  optic.position.set(0, ty(gunY - 0.15), -0.36); turret.add(optic);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.02, 12), lens);
  glass.rotation.x = Math.PI / 2;
  glass.position.set(0, ty(gunY - 0.15), -0.52); turret.add(glass);
  for (const sx of [-1, 1]) {
    const railBar = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.05, 0.44), dark);
    railBar.position.set(sx * 0.115, ty(gunY - 0.10), -0.06); turret.add(railBar);
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

  return finishVehicle(g, wheels, [turret]);
}
