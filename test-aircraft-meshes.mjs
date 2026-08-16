// test-aircraft-meshes.mjs — does the aircraft you see match the aircraft you fly?
//
// That question had no answer before this subsystem existed, and the answer was no: the shipped
// plane is drawn with a 29.9 m2 wing and flown with 16. Here the bounds the physics reads and the
// geometry the renderer draws come from one pair of corner functions, and this is what holds them
// to it.
//
//   node test-aircraft-meshes.mjs

import * as THREE from 'three';
import { boundsOf, anchorsOf, hardpointsOf, wingAreaOf } from './aircraft-layout.js';
import { buildAircraftMesh, partsNamed } from './aircraft-meshes.js';
import { LIBRARY, airframeFor } from './aircraft-library.js';
import { registerAirframe, AIRFRAMES } from './flight-airframes.js';
import { makeFlyer, syncAxes } from './flight-model.js';
import { mountOrigin } from './flight-combat.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// Node has no renderer, so the materials are stubs. The builder only ever calls them.
const MATS = {
  standard: () => new THREE.MeshBasicMaterial(),
  basic: () => new THREE.MeshBasicMaterial(),
};

const build = (layout, opts) => buildAircraftMesh(layout, 0xffffff, MATS, opts);

// ---------------------------------------------------------------------------
console.log('--- 1. the drawn aircraft is the measured aircraft ---');
// ---------------------------------------------------------------------------
for (const key of Object.keys(LIBRARY)) {
  const layout = LIBRARY[key].layout;
  const g = build(layout);
  // flames are effects, not structure: they are not shot at and do not count as extent
  for (const fl of g.userData.flame || []) fl.parent.remove(fl);
  const box = new THREE.Box3().setFromObject(g);
  const b = boundsOf(layout);
  const worst = Math.max(
    Math.abs(box.min.x - b.lo[0]), Math.abs(box.max.x - b.hi[0]),
    Math.abs(box.min.y - b.lo[1]), Math.abs(box.max.y - b.hi[1]),
    Math.abs(box.min.z - b.lo[2]), Math.abs(box.max.z - b.hi[2]));
  const scale = Math.max(...b.size);
  ok(`${key}: drawn extents match the measured ones`, worst < scale * 0.03,
    `worst corner off by ${worst.toFixed(3)} m on a ${scale.toFixed(2)} m craft`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. nothing is drawn inside out ---');
//
// A tapered slab is built from explicit corners, and mirroring one reverses its winding — so the
// left wing renders as a hole seen from outside while the right one looks perfect. It is invisible
// from exactly half the angles anyone would check from, which is why it is asserted rather than
// looked at.
// ---------------------------------------------------------------------------
for (const key of Object.keys(LIBRARY)) {
  const g = build(LIBRARY[key].layout);
  let checked = 0, inverted = [];
  g.traverse((o) => {
    if (!o.isMesh || !o.geometry.index) return;
    const pos = o.geometry.attributes.position;
    o.geometry.computeBoundingSphere();
    const c = o.geometry.boundingSphere.center;
    const idx = o.geometry.index.array;
    let out = 0, total = 0;
    const a = new THREE.Vector3(), bb = new THREE.Vector3(), cc = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3(), mid = new THREE.Vector3();
    for (let i = 0; i < idx.length; i += 3) {
      a.fromBufferAttribute(pos, idx[i]); bb.fromBufferAttribute(pos, idx[i + 1]); cc.fromBufferAttribute(pos, idx[i + 2]);
      n.crossVectors(e1.subVectors(bb, a), e2.subVectors(cc, a));
      if (n.lengthSq() < 1e-16) continue;
      mid.copy(a).add(bb).add(cc).multiplyScalar(1 / 3).sub(c);
      if (mid.lengthSq() < 1e-12) continue;
      total++;
      if (n.dot(mid) > 0) out++;
    }
    if (!total) return;
    checked++;
    if (out / total < 0.9) inverted.push(`${o.name || 'part'} ${(100 * out / total).toFixed(0)}%`);
  });
  ok(`${key}: every face points outward`, inverted.length === 0,
    inverted.length ? inverted.join(', ') : `${checked} meshes checked`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. every anchor the layout declares is a thing you can point at ---');
//
// This is the seam that makes a studio possible at all. The bot design studio resolves part names
// through `slot.body.joints`, a humanoid joint dictionary, which is precisely why none of its
// inspection tools work on anything that is not a person.
// ---------------------------------------------------------------------------
for (const key of Object.keys(LIBRARY)) {
  const layout = LIBRARY[key].layout;
  const g = build(layout);
  const missing = anchorsOf(layout).filter((n) => partsNamed(g, n).length === 0);
  ok(`${key}: all ${anchorsOf(layout).length} anchors resolve`, missing.length === 0, missing.join(', '));
}
{
  const g = build(LIBRARY.plane.layout);
  ok('a bare wing id resolves to both panels', partsNamed(g, 'wing').length === 2);
  ok('and a sided one to just that panel', partsNamed(g, 'wing.r').length === 1);
  ok('an unknown name resolves to nothing rather than throwing', partsNamed(g, 'rudder').length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. the viewer animates it without knowing it exists ---');
//
// `poseMesh` dispatches on what the mesh exposes, not on the airframe name, so these keys are the
// entire contract for a layout-built craft getting an exhaust, rotors or a wingbeat.
// ---------------------------------------------------------------------------
{
  ok('a rotor layout exposes its blades', build(LIBRARY.drone.layout).userData.rotors?.length === 4);
  ok('a bird exposes its wing pivots', build(LIBRARY.bird.layout).userData.wings?.length === 2);
  ok('and a plane exposes one exhaust', build(LIBRARY.plane.layout).userData.flame?.length === 1);
  // The reason `flame` is a list at all: a twin-engined aircraft has two, which is a thing the
  // schema could not say until an A-10 was built with it.
  ok('while the A-10 exposes two', build(LIBRARY.a10.layout).userData.flame?.length === 2);
  ok('but a plane has no wingbeat to drive', !build(LIBRARY.plane.layout).userData.wings);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. hardpoints are where the layout says, and carry nothing by default ---');
// ---------------------------------------------------------------------------
{
  const layout = LIBRARY.plane.layout;
  const g = build(layout);
  let worst = 0;
  for (const hp of hardpointsOf(layout)) {
    const o = g.userData.hardpoints[hp.id];
    worst = Math.max(worst, Math.abs(o.position.x - hp.p[0]), Math.abs(o.position.y - hp.p[1]),
      Math.abs(o.position.z - hp.p[2]));
  }
  ok('every station sits at its computed point', worst < 1e-9);
  ok('and holds no geometry until something is mounted',
    Object.values(g.userData.hardpoints).every((o) => o.children.length === 0));
  const shown = build(layout, { showHardpoints: true });
  ok('unless the studio asks to see the pylons',
    Object.values(shown.userData.hardpoints).every((o) => o.children.length === 1));
}

// ---------------------------------------------------------------------------
console.log('\n--- 5b. a drawn barrel and a fired round leave the same place ---');
//
// The mesh builder reads `mountsOf(layout)` and the sim reads `af.mounts` off the same layout, so
// this puts a flown AC-130 somewhere, banks it, and asks the mesh where the barrel is and the sim
// where the muzzle is. If those ever disagree the gunner is aiming a picture.
// ---------------------------------------------------------------------------
{
  const layout = LIBRARY.ac130.layout;
  const g = build(layout);
  ok('the gunship draws its three mounts', g.userData.mounts && Object.keys(g.userData.mounts).length === 3);
  ok('each with a barrel on it', Object.values(g.userData.mounts).every((o) => o.children.length === 1));
  ok('a plane with no mounts has no userData.mounts', build(LIBRARY.plane.layout).userData.mounts === undefined);
  ok('and every mount is a named part', ['g25', 'g40', 'g105'].every((id) => partsNamed(g, id).length === 1));

  registerAirframe('ac130mesh', airframeFor('ac130'));
  const f = makeFlyer('ac130mesh', { x: 400, z: -900, heading: 1.1 });
  f.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), -0.4));  // banked
  syncAxes(f);
  g.position.copy(f.p); g.quaternion.copy(f.q); g.updateMatrixWorld(true);
  const drawn = new THREE.Vector3(), fired = new THREE.Vector3();
  let worst = 0;
  for (const m of f.mounts) {
    g.userData.mounts[m.id].getWorldPosition(drawn);
    mountOrigin(fired, f, m);
    worst = Math.max(worst, drawn.distanceTo(fired));
  }
  ok('the mesh\'s mount and the sim\'s muzzle coincide on a banked, turned aircraft', worst < 1e-6,
    `${worst.toExponential(1)} m apart at worst`);
  delete AIRFRAMES.ac130mesh;
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. what it costs ---');
//
// A studio rebuilds on every slider release, so the per-rebuild cost is a number worth knowing
// rather than discovering. The bot studio's equivalent regenerates 126 geometries for a one-piece
// edit and that is its documented worst trap.
// ---------------------------------------------------------------------------
for (const key of Object.keys(LIBRARY)) {
  const g = build(LIBRARY[key].layout);
  let meshes = 0, tris = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
  });
  ok(`${key}: under the 60-mesh, 12k-triangle budget`, meshes < 60 && tris < 12000,
    `${meshes} meshes, ${Math.round(tris)} triangles`);
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
