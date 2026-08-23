// flight-meshes.js — the flight sim's three craft as reusable groups: fixed wing, multirotor and
// flapping wing. Materials come from the caller (`{ standard(color, emissive), basic(color, opacity) }`)
// because the sim runs node materials and the bot viewer does not; geometry and proportions are shared.
// Poseable parts are hung on `userData` (flame / rotors / wings) for whoever animates them.
import * as THREE from 'three';

// Filled in at the bottom of this file. A lookup rather than a ternary chain because the chain
// ended on `buildBird` with no error, so any kind it did not know about silently rendered as a bird.
const BUILDERS = {};

export function registerCraftMesh(kind, build) { BUILDERS[kind] = build; return build; }
export const CRAFT_KINDS = ['plane', 'drone', 'bird', 'recon'];

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

registerCraftMesh('plane', buildPlane);
registerCraftMesh('drone', buildDrone);
registerCraftMesh('bird', buildBird);
registerCraftMesh('recon', buildRecon);

// One entry point: nothing downstream should branch on the airframe key itself.
export function buildCraftMesh(kind, tint, materials) {
  const build = BUILDERS[kind];
  if (!build) throw new Error(`no craft mesh for '${kind}'. Registered: ${Object.keys(BUILDERS).join(', ')}`);
  const g = build(tint, materials);
  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}
