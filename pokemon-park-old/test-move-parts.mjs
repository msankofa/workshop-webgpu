import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { mulberry32 } from './moves/move-core.js';
import {
  buildRing, buildArc, harmonic, walkPath, radialWalks,
  createSpriteParticles, makeCrystalGeometry, makeRockGeometry,
  createDebrisPool, makeFlashSphere, popFlash, makeGroundDecal,
  setMoveComponentRuntime, getMoveComponentRuntime,
} from './moves/move-parts.js';

let fails = 0;
function check(name, fn) { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e.stack}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

const NODES = {
  MeshBasicNodeMaterial: THREE.MeshBasicNodeMaterial,
  MeshStandardNodeMaterial: THREE.MeshStandardNodeMaterial,
  MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial,
  SpriteNodeMaterial: THREE.SpriteNodeMaterial,
  PointsNodeMaterial: THREE.PointsNodeMaterial,
};

// ---------------------------------------------------------------------------------------------
// buildRing / buildArc / harmonic
// ---------------------------------------------------------------------------------------------

check('ring closes seamlessly: first and last column are the same point', () => {
  const th = (x, z) => Math.sin(x * 0.6) * 0.3;
  const ring = buildRing({ segments: 24, radius: 2, ox: 3, oy: 0.5, oz: -1, terrainHeight: th });
  assert(ring.length === 25, `expected 25 points, got ${ring.length}`);
  const a = ring[0], b = ring[ring.length - 1];
  assert(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9, 'seam does not close');
  assert(a.u === 0 && b.u === 1, `u range wrong: ${a.u}..${b.u}`);
});

check('arc does not close: first and last points differ', () => {
  const arc = buildArc({ segments: 16, radius: 2, angleFrom: 0, angleTo: Math.PI * 0.5 });
  const a = arc[0], b = arc[arc.length - 1];
  assert(Math.hypot(a.x - b.x, a.z - b.z) > 1, 'open arc endpoints coincide');
  assert(arc.length === 17, `expected 17 points, got ${arc.length}`);
});

check('ring and arc agree on the same angle range', () => {
  const ring = buildRing({ segments: 20, radius: 1.5 });
  const arc = buildArc({ segments: 20, radius: 1.5, angleFrom: 0, angleTo: Math.PI * 2 });
  for (let i = 0; i < ring.length; i++) {
    assert(Math.abs(ring[i].x - arc[i].x) < 1e-9 && Math.abs(ring[i].z - arc[i].z) < 1e-9, `point ${i} diverged`);
  }
});

check('harmonic snaps to a whole number, minimum 1', () => {
  assert(harmonic(6.4) === 6, `got ${harmonic(6.4)}`);
  assert(harmonic(6.6) === 7, `got ${harmonic(6.6)}`);
  assert(harmonic(0.2) === 1, `got ${harmonic(0.2)}`);
  assert(harmonic(-3) === 1, `got ${harmonic(-3)}`);
});

// ---------------------------------------------------------------------------------------------
// walkPath / radialWalks
// ---------------------------------------------------------------------------------------------

check('walkPath stays on the terrain function at every step', () => {
  const th = (x, z) => Math.sin(x * 1.3) * 0.5 + Math.cos(z * 0.7) * 0.2;
  const pts = walkPath({ x: 0, z: 0, dirX: 1, dirZ: 0, steps: 10, step: 0.2, curvature: 0.4, terrainHeight: th });
  assert(pts.length === 11, `expected 11 points, got ${pts.length}`);
  for (const p of pts) assert(Math.abs(p.y - th(p.x, p.z)) < 1e-9, `point off terrain at (${p.x},${p.z})`);
  assert(pts[0].x === 0 && pts[0].z === 0, 'did not start at the seed point');
  assert(pts.every((p) => p.maxWalk === 10 * 0.2), 'maxWalk not carried per point');
});

check('walkPath curves when curvature is nonzero, goes straight when zero', () => {
  const straight = walkPath({ x: 0, z: 0, dirX: 1, dirZ: 0, steps: 20, step: 0.1, curvature: 0 });
  assert(straight.every((p) => Math.abs(p.z) < 1e-9), 'zero curvature drifted off the x axis');
  const curved = walkPath({ x: 0, z: 0, dirX: 1, dirZ: 0, steps: 20, step: 0.1, curvature: 1.2 });
  assert(Math.abs(curved[curved.length - 1].z) > 0.05, 'nonzero curvature did not turn');
});

check('radialWalks makes `count` walks radiating from the centre, all on terrain', () => {
  const th = (x, z) => x * 0.05 - z * 0.03;
  const rnd = mulberry32(11);
  const walks = radialWalks({ x: 5, z: 5, count: 6, rnd, terrainHeight: th, baseDist: 2 });
  assert(walks.length === 6, `expected 6 walks, got ${walks.length}`);
  for (const w of walks) {
    assert(w[0].x === 5 && w[0].z === 5, 'walk did not start at the centre');
    assert(w[0].dist === 2, `baseDist not applied: ${w[0].dist}`);
    for (const p of w) assert(Math.abs(p.y - th(p.x, p.z)) < 1e-9, 'radial walk left the terrain');
  }
});

check('radialWalks is deterministic from rnd', () => {
  const run = () => {
    const rnd = mulberry32(99);
    return radialWalks({ x: 0, z: 0, count: 5, rnd, terrainHeight: () => 0 })
      .map((w) => w.map((p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`).join(';')).join('|');
  };
  assert(run() === run(), 'same seed produced different walks');
});

// ---------------------------------------------------------------------------------------------
// createSpriteParticles
// ---------------------------------------------------------------------------------------------

check('sprite particles is an InstancedBufferGeometry + SpriteNodeMaterial, not an InstancedMesh', () => {
  const sp = createSpriteParticles({ THREE, TSL, NODES, cap: 8 });
  assert(sp.mesh.geometry instanceof THREE.InstancedBufferGeometry, 'not instanced buffer geometry');
  assert(!(sp.mesh instanceof THREE.InstancedMesh), 'built as an InstancedMesh');
  assert(sp.mesh.material instanceof THREE.SpriteNodeMaterial, 'not a SpriteNodeMaterial');
  sp.dispose();
});

check('sprite particles emit, age and die, then recycle the same slots', () => {
  const sp = createSpriteParticles({ THREE, TSL, NODES, cap: 4, gravity: -1, drag: 0.5 });
  sp.emit(0, 0, 0, 0, 1, 0, 0.2, 0.1); // life 0.1s, dies fast
  sp.emit(1, 0, 0, 0, 1, 0, 0.2, 10); // life 10s, survives
  sp.step(1 / 60); // instanceCount is only synced by step(), same as fx-stream's puffs
  assert(sp.mesh.geometry.instanceCount === 2, `expected 2 live, got ${sp.mesh.geometry.instanceCount}`);
  for (let i = 0; i < 30; i++) sp.step(1 / 60); // ~0.5s: the short-lived one should have died
  assert(sp.mesh.geometry.instanceCount === 1, `expected 1 survivor, got ${sp.mesh.geometry.instanceCount}`);
  const before = sp.mesh.geometry.getAttribute('aPos').array.length;
  for (let i = 0; i < 8; i++) sp.emit(2, 0, 0, 0, 0, 0, 0.1, 5); // overflow the cap of 4
  assert(sp.mesh.geometry.instanceCount <= 4, 'instance count exceeded cap');
  assert(sp.mesh.geometry.getAttribute('aPos').array.length === before, 'attribute array reallocated');
  sp.dispose();
});

check('sprite particles step() touches no new arrays (allocation-free per frame)', () => {
  const sp = createSpriteParticles({ THREE, TSL, NODES, cap: 32 });
  for (let i = 0; i < 32; i++) sp.emit(i, 0, 0, 0.1, 0.2, 0, 0.1, 2);
  const arrays = ['aPos', 'aLife', 'aSize', 'aSeed'].map((n) => sp.mesh.geometry.getAttribute(n).array);
  for (let f = 0; f < 60; f++) sp.step(1 / 60);
  const after = ['aPos', 'aLife', 'aSize', 'aSeed'].map((n) => sp.mesh.geometry.getAttribute(n).array);
  for (let i = 0; i < arrays.length; i++) assert(arrays[i] === after[i], 'attribute array identity changed — reallocated');
  sp.dispose();
});

check('setFade and reset behave', () => {
  const sp = createSpriteParticles({ THREE, TSL, NODES, cap: 4 });
  sp.setFade(0.5); // just needs to not throw and to set the uniform
  sp.emit(0, 0, 0, 0, 0, 0, 0.1, 1);
  sp.reset();
  assert(sp.mesh.geometry.instanceCount === 0, 'reset did not clear instances');
  sp.dispose();
});

check('live particle diagnostics stop and scale shared particle work', () => {
  const geo = new THREE.TetrahedronGeometry(0.3);
  const mat = new THREE.MeshStandardMaterial();
  try {
    setMoveComponentRuntime({ particles: false, particleScale: 1 });
    const off = createSpriteParticles({ THREE, TSL, NODES, cap: 8 });
    off.emit(0, 0, 0, 0, 0, 0, 0.1, 1);
    off.step(1 / 60);
    assert(off.mesh.geometry.instanceCount === 0 && !off.mesh.visible, 'disabled sprites still ran');
    assert(off.mesh.userData.moveComponent === 'particles', 'sprite component tag missing');
    off.dispose();

    setMoveComponentRuntime({ particles: true, particleScale: 0.5 });
    const half = createSpriteParticles({ THREE, TSL, NODES, cap: 8 });
    for (let i = 0; i < 4; i++) half.emit(i, 0, 0, 0, 0, 0, 0.1, 1);
    half.step(1 / 60);
    assert(half.mesh.geometry.instanceCount === 2, `50% sprite budget emitted ${half.mesh.geometry.instanceCount}, expected 2`);
    half.dispose();

    const debris = createDebrisPool({ THREE, geometry: geo, material: mat, max: 4, rnd: mulberry32(8) });
    debris.emit(0, 0, 0, 4, 2);
    debris.step(0);
    const unused = new THREE.Matrix4();
    debris.mesh.getMatrixAt(2, unused);
    assert(unused.elements[0] === 0, '50% debris budget emitted more than two of four chips');
    assert(debris.mesh.userData.moveComponent === 'particles', 'debris component tag missing');
    debris.dispose();
  } finally {
    setMoveComponentRuntime({ particles: true, particleScale: 1 });
    geo.dispose();
    mat.dispose();
  }
  const state = getMoveComponentRuntime();
  assert(state.particles && state.particleScale === 1, 'particle runtime was not restored');
});

// ---------------------------------------------------------------------------------------------
// makeCrystalGeometry
// ---------------------------------------------------------------------------------------------

check('crystal geometry honours a non-default sides count', () => {
  const rnd6 = mulberry32(5);
  const geo6 = makeCrystalGeometry(THREE, rnd6, {});
  const rnd12 = mulberry32(5);
  const geo12 = makeCrystalGeometry(THREE, rnd12, { sides: 12 });
  const count6 = geo6.getAttribute('position').count;
  const count12 = geo12.getAttribute('position').count;
  assert(count6 === 6 * 4 * 3, `default sides vertex count wrong: ${count6}`);
  assert(count12 === 12 * 4 * 3, `sides:12 vertex count wrong: ${count12}`);
  geo6.dispose(); geo12.dispose();
});

check('crystal geometry is deterministic from rnd', () => {
  const build = () => {
    const geo = makeCrystalGeometry(THREE, mulberry32(77), {});
    const arr = Array.from(geo.getAttribute('position').array);
    geo.dispose();
    return arr.join(',');
  };
  assert(build() === build(), 'same seed produced different crystal geometry');
});

// ---------------------------------------------------------------------------------------------
// makeRockGeometry
// ---------------------------------------------------------------------------------------------

check('rock geometry builds a non-indexed jittered box', () => {
  const geo = makeRockGeometry(THREE, mulberry32(3), {});
  assert(geo.getIndex() === null, 'rock geometry should be non-indexed');
  assert(geo.getAttribute('position').count > 0, 'no vertices');
  assert(geo.getAttribute('normal'), 'normals not computed');
  geo.dispose();
});

// ---------------------------------------------------------------------------------------------
// createDebrisPool
// ---------------------------------------------------------------------------------------------

check('debris pool bounces off the ground and never penetrates it', () => {
  const geo = new THREE.TetrahedronGeometry(0.3);
  const mat = new THREE.MeshStandardMaterial();
  const rnd = mulberry32(21);
  const pool = createDebrisPool({ THREE, geometry: geo, material: mat, max: 4, gravity: -20, bounce: 0.3, drag: 0.6, rnd, life: [2, 2] });
  pool.emit(0, 1, 0, 1, 3);
  const groundY = 1 - 0.04;
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  let minY = Infinity, touchedGround = false;
  for (let i = 0; i < 120; i++) {
    pool.step(1 / 60);
    pool.mesh.getMatrixAt(0, m);
    m.decompose(pos, q, s);
    if (s.x <= 0) break; // died
    minY = Math.min(minY, pos.y);
    if (Math.abs(pos.y - groundY) < 1e-6) touchedGround = true;
  }
  assert(minY >= groundY - 1e-6, `debris penetrated the ground: minY=${minY}, groundY=${groundY}`);
  assert(touchedGround, 'debris never touched the ground plane to bounce');
  geo.dispose(); mat.dispose(); pool.dispose();
});

check('debris pool settles (dies) once its life expires', () => {
  // A zero-scale Matrix4 decomposes to scale (1,1,1) (three.js can't extract scale from a singular
  // matrix), so "dead" is checked on the raw elements, matching how the fx modules use this matrix.
  const geo = new THREE.TetrahedronGeometry(0.3);
  const mat = new THREE.MeshStandardMaterial();
  const rnd = mulberry32(21);
  const pool = createDebrisPool({ THREE, geometry: geo, material: mat, max: 4, gravity: -20, rnd, life: [0.2, 0.2] });
  pool.emit(0, 1, 0, 1, 3);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 30; i++) pool.step(1 / 60); // 0.5s > 0.2s life
  pool.mesh.getMatrixAt(0, m);
  assert(m.elements.every((v) => v === 0 || v === 1) && m.elements[0] === 0, `debris did not die, elements=${m.elements}`);
  geo.dispose(); mat.dispose(); pool.dispose();
});

check('debris pool emit is deterministic and reset clears live chips', () => {
  const geo = new THREE.TetrahedronGeometry(0.3);
  const mat = new THREE.MeshStandardMaterial();
  const run = () => {
    const rnd = mulberry32(4);
    const pool = createDebrisPool({ THREE, geometry: geo, material: mat, max: 8, rnd });
    pool.emit(0, 0, 0, 4, 2);
    pool.step(1 / 60);
    const m = new THREE.Matrix4();
    pool.mesh.getMatrixAt(0, m);
    const out = m.elements.join(',');
    pool.reset();
    pool.dispose();
    return out;
  };
  assert(run() === run(), 'same seed produced different debris motion');
  geo.dispose(); mat.dispose();
});

// ---------------------------------------------------------------------------------------------
// makeFlashSphere / popFlash
// ---------------------------------------------------------------------------------------------

check('flash sphere pops, scales up, fades and hides at end of life', () => {
  const mesh = makeFlashSphere({ THREE, NODES, color: 0xff8800 });
  assert(mesh.visible === false, 'flash starts visible');
  popFlash(mesh, 1, 2, 3, 2, -1, 0.3);
  assert(mesh.visible === false, 'negative age should stay hidden');
  popFlash(mesh, 1, 2, 3, 2, 0, 0.3);
  assert(mesh.visible === true, 'did not become visible on pop');
  assert(mesh.position.x === 1 && mesh.position.y === 2 && mesh.position.z === 3, 'position not set');
  const earlyScale = mesh.scale.x, earlyOpacity = mesh.material.opacity;
  popFlash(mesh, 1, 2, 3, 2, 0.15, 0.3);
  assert(mesh.scale.x > earlyScale, 'scale did not grow over time');
  assert(mesh.material.opacity < earlyOpacity, 'opacity did not fade over time');
  popFlash(mesh, 1, 2, 3, 2, 0.3, 0.3);
  assert(mesh.visible === false, 'did not hide once age reached life');
  mesh.geometry.dispose(); mesh.material.dispose();
});

// ---------------------------------------------------------------------------------------------
// makeGroundDecal
// ---------------------------------------------------------------------------------------------

check('ground decal lies flat, scales to radius, and its opacity is settable', () => {
  const decal = makeGroundDecal({ THREE, TSL, NODES, radius: 2.5, color: 0x224488 });
  assert(Math.abs(decal.mesh.rotation.x + Math.PI / 2) < 1e-9, 'decal not laid flat');
  assert(decal.mesh.scale.x === 2.5, 'decal not scaled to radius');
  decal.setOpacity(0.4); // just needs to not throw
  decal.dispose();
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
