// flight-meshes.js — the flight sim's three craft as reusable groups: fixed wing, multirotor and
// flapping wing. Materials come from the caller (`{ standard(color, emissive), basic(color, opacity) }`)
// because the sim runs node materials and the bot viewer does not; geometry and proportions are shared.
// Poseable parts are hung on `userData` (flame / rotors / wings) for whoever animates them.
import * as THREE from 'three';

export const CRAFT_KINDS = ['plane', 'drone', 'bird'];

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

// One entry point for the three: nothing downstream should branch on the airframe key itself.
export function buildCraftMesh(kind, tint, materials) {
  const g = kind === 'plane' ? buildPlane(tint, materials)
    : kind === 'drone' ? buildDrone(tint, materials) : buildBird(tint, materials);
  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}
