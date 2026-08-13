// test-weapon-part-batches.mjs
//
// Headless test for the instanced held-weapon pool (weapon-part-batches.js). Uses a minimal
// THREE fake (same pattern as test-body-part-batches.mjs) — the module only touches
// setMatrixAt/count/instanceMatrix, so no real GPU or three.js is needed.
//
// Run: node test-weapon-part-batches.mjs

import { createWeaponPartBatches, bakeSkinnedGeometry } from './weapon-part-batches.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

let _uuid = 0;
class FakeGeo { constructor() { this.uuid = `g${_uuid++}`; this.userData = {}; } }
class FakeMat { constructor(name) { this.name = name; } }
class FakeInstancedMesh {
  constructor(geometry, material, capacity) {
    this.geometry = geometry; this.material = material; this.capacity = capacity;
    this.count = 0; this.userData = {}; this.parent = null;
    this.castShadow = false; this.receiveShadow = false; this.frustumCulled = true;
    this.instanceMatrix = { setUsage() {}, needsUpdate: false };
    this._mats = [];
    this.disposed = false;
  }
  setMatrixAt(i, m) { this._mats[i] = { ...m }; } // copy semantics like the real one
  dispose() { this.disposed = true; }
}
const THREE = { DynamicDrawUsage: 1, InstancedMesh: FakeInstancedMesh };
const scene = { children: [], add(m) { this.children.push(m); m.parent = this; }, remove(m) { this.children = this.children.filter(x => x !== m); m.parent = null; } };
const M = (tag) => ({ tag });

// Two weapon types: rifle = 2 sub-meshes (shared across bots), pistol = 1 sub-mesh.
const gRifleBody = new FakeGeo(), gRifleMag = new FakeGeo(), gPistol = new FakeGeo();
const mRifle = new FakeMat('rifle'), mPistol = new FakeMat('pistol');

const pool = createWeaponPartBatches({ THREE, scene, capacity: 3 });

// Frame 1: three bots — two rifles, one pistol.
pool.beginFrame();
pool.add(gRifleBody, mRifle, M('r1b')); pool.add(gRifleMag, mRifle, M('r1m'));
pool.add(gRifleBody, mRifle, M('r2b')); pool.add(gRifleMag, mRifle, M('r2m'));
pool.add(gPistol, mPistol, M('p1'));
pool.endFrame();

check('one bucket per distinct sub-mesh geometry', pool.stats.draws === 3);
check('instances counted across weapon types', pool.stats.instances === 5);
check('same-geometry bots share a bucket', scene.children.find(m => m.geometry === gRifleBody).count === 2);
check('bucket keeps the template GLB material', scene.children.find(m => m.geometry === gPistol).material === mPistol);
check('buckets cast shadow like the per-clone path', scene.children.every(m => m.castShadow === true));
check('buckets skip frustum culling', scene.children.every(m => m.frustumCulled === false));
check('matrices land at per-instance slots', scene.children.find(m => m.geometry === gRifleMag)._mats[1].tag === 'r2m');

// Frame 2: pool zeroes; only one rifle remains (a bot died and its mount was destroyed).
pool.beginFrame();
pool.add(gRifleBody, mRifle, M('r1b')); pool.add(gRifleMag, mRifle, M('r1m'));
pool.endFrame();
check('beginFrame zeroes buckets (pistol bucket empty)', scene.children.find(m => m.geometry === gPistol).count === 0);
check('surviving mount re-adds each frame', scene.children.find(m => m.geometry === gRifleBody).count === 1);

// Capacity soft-fail: 4th same-geometry add drops, no throw.
pool.beginFrame();
for (let i = 0; i < 5; i++) pool.add(gPistol, mPistol, M(`p${i}`));
pool.endFrame();
check('over-capacity adds are dropped', pool.stats.dropped === 2);
check('bucket count clamps at capacity', scene.children.find(m => m.geometry === gPistol).count === 3);

// dispose removes buckets from the scene without touching shared geometry/materials.
pool.dispose();
check('dispose empties the scene', scene.children.length === 0);
check('dispose resets stats', pool.stats.draws === 0 && pool.stats.instances === 0);

// castShadow: false opts a pool out of the shadow pass (e.g. distant-bot weapons).
const noShadowPool = createWeaponPartBatches({ THREE, scene, capacity: 3, castShadow: false });
noShadowPool.beginFrame();
noShadowPool.add(gPistol, mPistol, M('p1'));
noShadowPool.endFrame();
check('castShadow: false opts a bucket out of the shadow pass', scene.children.every(m => m.castShadow === false));
noShadowPool.dispose();

// --- bakeSkinnedGeometry vs real three skinning math -------------------------
// Uses the reference three copy in ../workshop/node_modules (per parent CLAUDE.md).
// Skipped (not failed) if that copy is ever removed.
let T = null;
try { T = await import('../workshop/node_modules/three/build/three.module.js'); }
catch { console.log('SKIP: bake test (no ../workshop three reference copy)'); }
if (T) {
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 2], 3));
  geo.setAttribute('normal', new T.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  geo.setAttribute('skinIndex', new T.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geo.setAttribute('skinWeight', new T.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new T.SkinnedMesh(geo, new T.MeshBasicMaterial());
  const bone = new T.Bone();
  mesh.add(bone);
  const root = new T.Object3D();
  root.add(mesh);
  mesh.position.set(5, 0, 0);           // mesh node transform must NOT leak into the bake
  root.updateMatrixWorld(true);
  mesh.bind(new T.Skeleton([bone]));    // bind at rest...
  bone.rotation.z = Math.PI / 2;        // ...then pose the bone away from bind (the GLB situation)
  root.updateMatrixWorld(true);

  const baked = bakeSkinnedGeometry(T, mesh);
  const bakedPos = baked.attributes.position;
  const v = new T.Vector3(), expect = new T.Vector3();
  let posMatch = true, changed = false;
  for (let i = 0; i < bakedPos.count; i++) {
    expect.fromBufferAttribute(geo.attributes.position, i);
    mesh.applyBoneTransform(i, expect); // three's own CPU skinning = the shader formula
    v.fromBufferAttribute(bakedPos, i);
    if (v.distanceTo(expect) > 1e-6) posMatch = false;
    if (v.distanceTo(new T.Vector3().fromBufferAttribute(geo.attributes.position, i)) > 1e-6) changed = true;
  }
  check('baked positions match three applyBoneTransform exactly', posMatch);
  check('bake actually moved vertices (bind/rest mismatch exercised)', changed);
  const n = new T.Vector3().fromBufferAttribute(baked.attributes.normal, 0);
  check('normals rotate with the bone pose', n.distanceTo(new T.Vector3(0, 1, 0)) < 1e-6);
  check('skin attributes stripped from baked geometry', !baked.attributes.skinIndex && !baked.attributes.skinWeight);
  check('source geometry untouched', geo.attributes.position.getX(0) === 1 && !!geo.attributes.skinIndex);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
