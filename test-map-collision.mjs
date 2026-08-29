// test-map-collision.mjs — createMapCollider's two build paths.
//
// Streamed terrain chunks are ONE indexed mesh already in world space, but the function was written
// for authored maps: walk a scene graph and bake every mesh into de-indexed world triangles. Doing
// that per chunk cost 1.69 ms against 0.024 ms measured on a 3200-triangle chunk, so there is a
// direct path — and it is only safe under conditions this file pins down.
//
// node test-map-collision.mjs

import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { createMapCollider } from './map-collision.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const chunkGeo = () => { const g = new THREE.PlaneGeometry(30, 30, 40, 40); g.rotateX(-Math.PI / 2); return g; };

console.log('[1] the direct path: one indexed mesh already in world space');
{
  const src = chunkGeo();
  const mesh = new THREE.Mesh(src);
  mesh.updateMatrixWorld();
  const c = createMapCollider(mesh, { maxTriangles: 250000 });
  ok(c.buildMs.direct === true, 'taken for a single indexed world-space mesh');
  ok(c.geometry.attributes.position === src.attributes.position, 'positions are shared, not copied (MeshBVH never writes them)');
  ok(c.geometry.index.array !== src.index.array, 'the index is COPIED, because MeshBVH reorders it in place');
  ok(c.triangleCount === src.index.count / 3, `triangle count matches the source (${c.triangleCount})`);
  const hit = c.raycastDown(new THREE.Vector3(0, 10, 0), 50);
  ok(hit && Math.abs(hit.point.y) < 1e-6, `collides on the plane (y ${hit ? hit.point.y.toFixed(3) : 'MISS'})`);
  c.dispose();
  ok(src.attributes.position.array.length > 0, 'disposing it leaves the render geometry intact');
}

console.log('\n[2] the bake path, for everything the direct path must refuse');
{
  // A moved mesh's triangles are not world space: sharing them would collide at the wrong place.
  const moved = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  moved.position.set(9, 0, 0);
  moved.updateMatrixWorld();
  const c = createMapCollider(moved, { maxTriangles: 250000 });
  ok(c.buildMs.direct === false, 'a non-identity transform falls back');
  const hit = c.raycastDown(new THREE.Vector3(9, 10, 0), 50);
  ok(hit && Math.abs(hit.point.y - 1) < 1e-6, `and collides at the moved position (y ${hit ? hit.point.y.toFixed(3) : 'MISS'})`);

  const root = new THREE.Group();
  for (const x of [-5, 5]) { const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); m.position.set(x, 0, 0); root.add(m); }
  root.updateMatrixWorld(true);
  const multi = createMapCollider(root, { maxTriangles: 250000 });
  ok(multi.buildMs.direct === false, 'a multi-mesh scene graph falls back');
  ok(multi.triangleCount === 24, `and bakes every mesh (${multi.triangleCount} triangles)`);
  for (const x of [-5, 5]) {
    const h = multi.raycastDown(new THREE.Vector3(x, 10, 0), 50);
    ok(h && Math.abs(h.point.y - 1) < 1e-6, `both boxes collide (x ${x})`);
  }
}

console.log('\n[3] the build cost is reported, split by phase');
{
  const mesh = new THREE.Mesh(chunkGeo());
  mesh.updateMatrixWorld();
  const c = createMapCollider(mesh, { maxTriangles: 250000 });
  ok(Number.isFinite(c.buildMs.bake) && Number.isFinite(c.buildMs.bvh), 'bake and bvh are both timed');
  ok(typeof c.buildMs.direct === 'boolean', 'and the record says which path ran');
}

console.log('\n[4] character support separates walkable slopes vertically');
{
  const geometry = new THREE.BoxGeometry(20, 0.5, 10);
  geometry.rotateZ(30 * Math.PI / 180);
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld();
  const c = createMapCollider(mesh);
  const hit = c.raycastDown(new THREE.Vector3(0, 10, 0), 20);
  const capsule = new Capsule(
    new THREE.Vector3(0, hit.point.y + 0.30, 0),
    new THREE.Vector3(0, hit.point.y + 1.40, 0),
    0.35,
  );
  const velocity = new THREE.Vector3(0, -4, 0);
  const result = c.resolveCapsule(capsule, velocity, { slopeLimitY: 0.6, walkableVerticalResolution: true });
  ok(result.grounded && Math.abs(capsule.start.x) < 1e-9, 'walkable penetration raises the capsule without downhill X/Z correction');
  ok(velocity.x === 0 && velocity.y === 0, 'a vertical landing does not become downhill velocity');
  c.dispose();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
