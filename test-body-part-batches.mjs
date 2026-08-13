// test-body-part-batches.mjs
//
// Headless test for the instanced body-part pool (body-part-batches.js). Uses a minimal THREE
// fake (InstancedMesh/materials/geometry stubs) — the module only touches setMatrixAt/setColorAt/
// count/instanceMatrix, so no real GPU or three.js is needed.
//
// Run: node test-body-part-batches.mjs

import { createBodyPartBatches } from './body-part-batches.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

let _uuid = 0;
class FakeGeo { constructor() { this.uuid = `g${_uuid++}`; this.userData = {}; } }
class FakeMat { constructor(o = {}) { Object.assign(this, o); this.disposed = false; } dispose() { this.disposed = true; } }
class FakeInstancedMesh {
  constructor(geometry, material, capacity) {
    this.geometry = geometry; this.material = material; this.capacity = capacity;
    this.count = 0; this.userData = {}; this.parent = null; this.visible = true; this.disposed = false;
    this.instanceMatrix = { setUsage() {}, needsUpdate: false };
    this.instanceColor = null;
    this._mats = []; this._cols = [];
  }
  dispose() { this.disposed = true; }
  setMatrixAt(i, m) { this._mats[i] = m; }
  setColorAt(i, c) { if (!this.instanceColor) this.instanceColor = { needsUpdate: false }; this._cols[i] = c; }
}
// raycast()'s scratch objects; only construction is exercised here (no raycaster in this test).
class FakeMatrix4 { premultiply() { return this; } }
class FakeMatrix3 { getNormalMatrix() { return this; } }
const THREE = {
  DynamicDrawUsage: 1,
  MeshStandardMaterial: class extends FakeMat {},
  MeshBasicMaterial: class extends FakeMat {},
  InstancedMesh: FakeInstancedMesh,
  Matrix4: FakeMatrix4,
  Matrix3: FakeMatrix3,
};
const scene = { children: [], add(m) { this.children.push(m); m.parent = this; }, remove(m) { this.children = this.children.filter(x => x !== m); m.parent = null; } };
const M = () => ({ /* opaque matrix token */ });
const COL = (hex) => ({ hex });

// --- one geometry per role -------------------------------------------------
const gShell = new FakeGeo(), gPlate = new FakeGeo(), gTrim = new FakeGeo(), gEye = new FakeGeo();

const pool = createBodyPartBatches({ THREE, scene, capacity: 4 });

// Frame 1: two bots, each contributes shell+plate+trim+eye once.
pool.beginFrame();
pool.add(gShell, 'shell', M(), COL(0xff0000));
pool.add(gPlate, 'plate', M(), COL(0x00ff00));
pool.add(gTrim, 'trim', M(), COL(0x0000ff));
pool.add(gEye, 'eye', M(), null);
pool.add(gShell, 'shell', M(), COL(0x112233));
pool.add(gPlate, 'plate', M(), COL(0x445566));
pool.add(gTrim, 'trim', M(), COL(0x778899));
pool.add(gEye, 'eye', M(), null);
pool.endFrame();

check('one bucket per distinct geometry', pool.stats.draws === 4);
check('total instances counted', pool.stats.instances === 8);
check('scene received one InstancedMesh per bucket', scene.children.length === 4);

const shellMesh = scene.children.find(m => m.geometry === gShell);
const eyeMesh = scene.children.find(m => m.geometry === gEye);
check('shell bucket count = 2 after endFrame', shellMesh.count === 2);
check('shell bucket allocated instanceColor (tinted role)', shellMesh.instanceColor !== null);
check('eye bucket never allocated instanceColor (flat role)', eyeMesh.instanceColor === null);
check('instanceMatrix flagged for upload', shellMesh.instanceMatrix.needsUpdate === true);

// Frame 2: beginFrame must zero counts (immediate mode), one bot only.
pool.beginFrame();
check('beginFrame resets stats.instances', pool.stats.instances === 0);
pool.add(gShell, 'shell', M(), COL(0xabcdef));
pool.endFrame();
check('shell bucket count = 1 after re-flush', shellMesh.count === 1);
check('draws stable across frames (no new buckets)', pool.stats.draws === 4);

// --- soft-fail beyond capacity --------------------------------------------
pool.beginFrame();
for (let i = 0; i < 10; i++) pool.add(gShell, 'shell', M(), COL(i));
pool.endFrame();
check('capacity is a hard cap (count clamped)', shellMesh.count === 4);
check('overflow counted as dropped', pool.stats.dropped === 6);

// --- dispose ---------------------------------------------------------------
pool.dispose();
check('dispose removes every InstancedMesh from scene', scene.children.length === 0);

// --- bucket lifecycle: hide when empty, evict after N empty flushes ---------
const EVICT_N = 120;   // the module default
const gA = new FakeGeo(), gB = new FakeGeo();
const life = createBodyPartBatches({ THREE, scene, capacity: 8 });

life.beginFrame();
life.add(gA, 'shell', M(), COL(1));
life.add(gB, 'plate', M(), COL(2));
life.endFrame();
const meshA = scene.children.find(m => m.geometry === gA);
const meshB = scene.children.find(m => m.geometry === gB);
check('both buckets visible while populated', meshA.visible === true && meshB.visible === true);

// gB stops being flushed. It must hide immediately and survive until the eviction threshold.
life.beginFrame();
life.add(gA, 'shell', M(), COL(1));
life.endFrame();
check('empty bucket hidden after endFrame', meshB.visible === false);
check('populated bucket still visible', meshA.visible === true);
check('empty bucket not evicted on its first empty frame', life.stats.draws === 2);

for (let f = 2; f < EVICT_N; f++) {   // frames 2..119 empty: still alive at 119
  life.beginFrame();
  life.add(gA, 'shell', M(), COL(1));
  life.endFrame();
}
check(`bucket survives ${EVICT_N - 1} empty frames`, life.stats.draws === 2 && scene.children.length === 2);

life.beginFrame();
life.add(gA, 'shell', M(), COL(1));
life.endFrame();
check(`bucket evicted on the ${EVICT_N}th empty frame`, life.stats.draws === 1);
check('evicted mesh removed from scene', scene.children.length === 1 && !scene.children.includes(meshB));
check('evicted mesh released its GPU buffers', meshB.disposed === true);
check('evicted bucket kept its shared geometry', gB.uuid !== undefined && gB.disposed === undefined);
check('surviving bucket untouched by the eviction', meshA.count === 1 && meshA.visible === true);

// A later add() with the same geometry has to transparently rebuild the bucket (both maps cleared).
life.beginFrame();
life.add(gA, 'shell', M(), COL(1));
life.add(gB, 'plate', M(), COL(2));
life.endFrame();
const meshB2 = scene.children.find(m => m.geometry === gB);
check('add() after eviction recreates the bucket', life.stats.draws === 2 && scene.children.length === 2);
check('recreated bucket is a fresh InstancedMesh', meshB2 && meshB2 !== meshB);
check('recreated bucket draws again', meshB2.count === 1 && meshB2.visible === true);

// The counter must reset, not accumulate: gB is live again, so it gets a fresh N-frame grace.
for (let f = 0; f < EVICT_N - 1; f++) {
  life.beginFrame();
  life.add(gA, 'shell', M(), COL(1));
  life.endFrame();
}
check('empty-frame counter resets when a bucket is refilled', life.stats.draws === 2);

// Eviction counts flushed frames only: a guest that stops calling endFrame keeps its buckets.
for (let f = 0; f < EVICT_N * 2; f++) life.beginFrame();
check('beginFrame alone never evicts (guests hold last frame)', life.stats.draws === 2);

// --- WeakMap fast path is the same bucket as the uuid path -----------------
// Mutating the uuid after the bucket exists: a uuid lookup would miss and mint a second bucket,
// so identical mesh + flat draws proves add() resolved via the geometry object.
const gU = new FakeGeo();
const idPool = createBodyPartBatches({ THREE, scene: null, capacity: 8 });
idPool.beginFrame();
idPool.add(gU, 'shell', M(), COL(3));
const drawsBefore = idPool.stats.draws;
gU.uuid = 'uuid-changed-after-bucket-creation';
idPool.add(gU, 'shell', M(), COL(4));
idPool.endFrame();
check('WeakMap path returns the same bucket as the uuid path', idPool.stats.draws === drawsBefore);
check('both adds landed in the one bucket', idPool.stats.instances === 2);

life.dispose();
idPool.dispose();
check('dispose clears every bucket again', scene.children.length === 0 && life.stats.draws === 0);

// A stale WeakMap entry must never resurrect a mesh dispose() already pulled from the scene.
life.beginFrame();
life.add(gA, 'shell', M(), COL(1));
life.endFrame();
const meshA2 = scene.children.find(m => m.geometry === gA);
check('add() after dispose() builds a fresh bucket', scene.children.length === 1 && !!meshA2 && meshA2 !== meshA);
check('rebuilt bucket draws', meshA2.count === 1 && meshA2.visible === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
