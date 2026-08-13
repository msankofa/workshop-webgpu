import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';

const _box = new THREE.Box3();
const _line = new THREE.Line3();
const _triPoint = new THREE.Vector3();
const _capsulePoint = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _push = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
_raycaster.firstHitOnly = true; // honored by three-mesh-bvh's acceleratedRaycast (BVH returns closest hit only)
const _occRay = new THREE.Ray();

function collectWorldTriangles(root, maxTriangles) {
  root.updateMatrixWorld(true);
  let totalTriangles = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const geometry = obj.geometry;
    const triCount = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    totalTriangles += triCount * (obj.isInstancedMesh ? obj.count : 1);
  });
  if (totalTriangles > maxTriangles) {
    throw new Error(`authored map collision mesh has ${Math.round(totalTriangles).toLocaleString()} triangles; cap is ${maxTriangles.toLocaleString()}`);
  }

  const positions = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const instanceWorld = new THREE.Matrix4();

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const geometry = obj.geometry;
    const pos = geometry.attributes.position;
    const index = geometry.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    // InstancedMesh bakes each instance separately: world = matrixWorld * instanceMatrix.
    const instances = obj.isInstancedMesh ? obj.count : 1;

    for (let inst = 0; inst < instances; inst++) {
      let mat = obj.matrixWorld;
      if (obj.isInstancedMesh) {
        obj.getMatrixAt(inst, instanceWorld);
        mat = instanceWorld.premultiply(obj.matrixWorld);
      }
      for (let tri = 0; tri < triCount; tri++) {
        for (let corner = 0; corner < 3; corner++) {
          const srcIndex = index ? index.getX(tri * 3 + corner) : tri * 3 + corner;
          v[corner].fromBufferAttribute(pos, srcIndex).applyMatrix4(mat);
        }
        positions.push(
          v[0].x, v[0].y, v[0].z,
          v[1].x, v[1].y, v[1].z,
          v[2].x, v[2].y, v[2].z,
        );
      }
    }
  });

  if (positions.length === 0) throw new Error('authored map has no collision triangles');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, triangleCount: totalTriangles };
}

export function createMapCollider(root, { maxTriangles = 250000 } = {}) {
  const { geometry, triangleCount } = collectWorldTriangles(root, maxTriangles);
  geometry.boundsTree = new MeshBVH(geometry, { lazyGeneration: false });
  const colliderMesh = new THREE.Mesh(geometry);
  colliderMesh.raycast = acceleratedRaycast;

  function resolveOnce(capsule, velocity, slopeLimitY) {
    let hit = false;
    let grounded = false;
    _line.copy(capsule);
    _box.makeEmpty();
    _box.expandByPoint(_line.start);
    _box.expandByPoint(_line.end);
    _box.min.addScalar(-capsule.radius);
    _box.max.addScalar(capsule.radius);

    geometry.boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (triangle) => {
        triangle.closestPointToSegment(_line, _triPoint, _capsulePoint);
        _delta.subVectors(_capsulePoint, _triPoint);
        const distSq = _delta.lengthSq();
        const r = capsule.radius;
        if (distSq >= r * r) return false;

        const dist = Math.sqrt(distSq);
        if (dist > 1e-7) {
          _normal.copy(_delta).multiplyScalar(1 / dist);
        } else {
          triangle.getNormal(_normal);
          if (_normal.y < 0) _normal.multiplyScalar(-1);
        }
        const depth = r - dist;
        _push.copy(_normal).multiplyScalar(depth);
        capsule.translate(_push);
        _line.copy(capsule);
        _box.expandByPoint(_line.start);
        _box.expandByPoint(_line.end);
        hit = true;
        if (_normal.y >= slopeLimitY) grounded = true;

        const vn = velocity.dot(_normal);
        if (vn < 0) velocity.addScaledVector(_normal, -vn);
        return false;
      },
    });

    return { hit, grounded };
  }

  function resolveCapsule(capsule, velocity, { slopeLimitY = 0.5, iterations = 3 } = {}) {
    let grounded = false;
    for (let i = 0; i < iterations; i++) {
      const result = resolveOnce(capsule, velocity, slopeLimitY);
      grounded = grounded || result.grounded;
      if (!result.hit) break;
    }
    return { grounded };
  }

  function raycastDown(origin, maxDistance = 8) {
    _raycaster.ray.origin.copy(origin);
    _raycaster.ray.direction.set(0, -1, 0);
    _raycaster.near = 0;
    _raycaster.far = maxDistance;
    return _raycaster.intersectObject(colliderMesh, false)[0] || null;
  }

  // Nearest solid world hit along a ray, as arrays. Triangles are baked in world space on an
  // identity mesh, so the face normal is already the world normal. `dir` need not be unit.
  function raycast(origin, dir, maxDistance = 200) {
    _raycaster.ray.origin.set(origin[0], origin[1], origin[2]);
    _raycaster.ray.direction.set(dir[0], dir[1], dir[2]).normalize();
    _raycaster.near = 0;
    _raycaster.far = maxDistance;
    const hit = _raycaster.intersectObject(colliderMesh, false)[0];
    if (!hit) return null;
    const n = hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 1, 0];
    return { distance: hit.distance, point: [hit.point.x, hit.point.y, hit.point.z], normal: n };
  }

  // Allocation-free LOS test: true if anything solid blocks origin->dir within maxDistance.
  function isOccluded(origin, dir, maxDistance = 200) {
    if (geometry.boundsTree) {
      _occRay.origin.set(origin[0], origin[1], origin[2]);
      _occRay.direction.set(dir[0], dir[1], dir[2]).normalize();
      return !!geometry.boundsTree.raycastFirst(_occRay, colliderMesh.material.side, 0, maxDistance);
    }
    _raycaster.ray.origin.set(origin[0], origin[1], origin[2]);
    _raycaster.ray.direction.set(dir[0], dir[1], dir[2]).normalize();
    _raycaster.near = 0;
    _raycaster.far = maxDistance;
    return !!_raycaster.intersectObject(colliderMesh, false)[0];
  }

  return {
    geometry,
    triangleCount,
    resolveCapsule,
    raycastDown,
    raycast,
    isOccluded,
    dispose() {
      geometry.boundsTree = null;
      geometry.dispose();
    },
  };
}
