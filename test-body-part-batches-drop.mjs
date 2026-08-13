// P1b test: on-demand bucket drop in body-part-batches.js, and the cache-sweep -> pool bridge.
// A tiny fake THREE stands in for the real renderer (InstancedMesh only needs to record calls here).
// Run: node test-body-part-batches-drop.mjs
import { createBodyPartBatches } from './body-part-batches.js';
import { createGeometryCache } from './model-primitives.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

let uuid = 0;
const THREE = {
  Matrix4: class { premultiply() { return this; } },
  Matrix3: class { getNormalMatrix() { return this; } },
  DynamicDrawUsage: 1,
  MeshStandardMaterial: class { constructor() { this.disposed = false; } dispose() { this.disposed = true; } },
  MeshBasicMaterial: class { constructor() { this.disposed = false; } dispose() { this.disposed = true; } },
  InstancedMesh: class {
    constructor(geometry) { this.geometry = geometry; this.count = 0; this.visible = true; this.userData = {}; this.parent = null; this.disposed = false; this.instanceMatrix = { setUsage() {} }; }
    dispose() { this.disposed = true; }
    setMatrixAt() {} setColorAt() {}
  },
};
const scene = { children: [], add(m) { this.children.push(m); m.parent = this; }, remove(m) { this.children = this.children.filter(x => x !== m); m.parent = null; } };
const mkGeo = () => ({ uuid: `g${uuid++}`, userData: {}, disposed: false, dispose() { this.disposed = true; } });
const M = {};  // dummy matrix arg

// dropBucket removes a live bucket's mesh from the scene immediately, without waiting for evictAfter.
{
  const pool = createBodyPartBatches({ THREE, scene });
  const g = mkGeo();
  pool.beginFrame(); pool.add(g, 'shell', M); pool.endFrame();
  ok(scene.children.length === 1, 'one bucket mesh in the scene after a flush');
  const mesh = scene.children[0];
  ok(pool.dropBucket(g) === true, 'dropBucket reports it dropped the bucket');
  ok(mesh.disposed && scene.children.length === 0, 'bucket mesh disposed and removed on drop');
  ok(pool.dropBucket(g) === false, 'second drop is a no-op');
  ok(!g.disposed, 'dropBucket never disposes the shared geometry');
}

// After a drop, re-adding the same geometry recreates a fresh bucket (the WeakMap miss path).
{
  const pool = createBodyPartBatches({ THREE, scene });
  const g = mkGeo();
  pool.beginFrame(); pool.add(g, 'plate', M); pool.endFrame();
  pool.dropBucket(g);
  pool.beginFrame(); ok(pool.add(g, 'plate', M) === true, 're-add after drop succeeds'); pool.endFrame();
  ok(scene.children.length === 1, 'a fresh bucket was recreated for the re-added geometry');
  pool.dispose();
}

// Bridge: cache.sweep(keep, onDispose) hands each disposed geometry to pool.dropBucket in one tick.
{
  const cache = createGeometryCache();
  const pool = createBodyPartBatches({ THREE, scene });
  // Build one "body" holding two geometries and flush them into the pool.
  cache.beginRecord();
  const gA = cache.get('kA', mkGeo);
  const gB = cache.get('kB', mkGeo);
  const held = cache.endRecord();
  pool.beginFrame(); pool.add(gA, 'shell', M); pool.add(gB, 'trim', M); pool.endFrame();
  ok(scene.children.length === 2, 'two buckets flushed');

  // Destroy the body, then sweep — the bridge should drop both buckets synchronously.
  cache.releaseAll(held);
  const dropped = [];
  const n = cache.sweep(0, geo => { if (pool.dropBucket(geo)) dropped.push(geo); });
  ok(n === 2, 'sweep disposed both geometries');
  ok(dropped.length === 2 && scene.children.length === 0, 'both buckets dropped in the same tick as the sweep');
  ok(gA.disposed && gB.disposed, 'geometries disposed by the sweep, not the pool');
  pool.dispose();
}

console.log(`body-part-batches drop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
