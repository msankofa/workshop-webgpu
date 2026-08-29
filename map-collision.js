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

function collectWorldTriangles(roots, maxTriangles) {
  for (const root of roots) root.updateMatrixWorld(true);
  let totalTriangles = 0;
  const traverse = (fn) => { for (const root of roots) root.traverse(fn); };
  traverse((obj) => {
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

  traverse((obj) => {
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

// `extraRoots` bakes further scene graphs into the same BVH -- procedurally scattered structures
// are added after the map loads, and a collider that predates them lets bots and bullets through.
const IDENTITY_ELEMENTS = new THREE.Matrix4().elements;
function isIdentity(m) {
  for (let i = 0; i < 16; i++) if (m.elements[i] !== IDENTITY_ELEMENTS[i]) return false;
  return true;
}

// Fast path for the streamed-chunk caller: ONE indexed mesh already in world space. The general
// path below bakes de-indexed world triangles through a growable JS array, which for geometry that
// is already global is a 3-6x data expansion and a full copy for no gain. Positions are shared
// (MeshBVH never writes them); the index is copied because MeshBVH reorders it in place, and for a
// sliced chunk that index is a subarray VIEW onto the geometry being rendered.
function directGeometry(roots, maxTriangles) {
  if (roots.length !== 1) return null;
  const root = roots[0];
  if (!root.isMesh || root.isInstancedMesh || root.children.length) return null;
  const src = root.geometry;
  if (!src?.index || !src.attributes?.position) return null;
  if (!isIdentity(root.matrixWorld)) return null;
  const triangleCount = src.index.count / 3;
  if (triangleCount === 0 || triangleCount > maxTriangles) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', src.attributes.position);
  geometry.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
  return { geometry, triangleCount, shared: true };
}

export function createMapCollider(root, { maxTriangles = 250000, extraRoots = null } = {}) {
  const roots = extraRoots?.length ? [root, ...extraRoots] : [root];
  const tBake = performance.now();
  const direct = extraRoots?.length ? null : directGeometry(roots, maxTriangles);
  const { geometry, triangleCount, shared = false } = direct ?? collectWorldTriangles(roots, maxTriangles);
  const bakeMs = performance.now() - tBake;
  const tBvh = performance.now();
  geometry.boundsTree = new MeshBVH(geometry, { lazyGeneration: false });
  const bvhMs = performance.now() - tBvh;
  const colliderMesh = new THREE.Mesh(geometry);
  colliderMesh.raycast = acceleratedRaycast;
  // Second view of the SAME geometry and BVH, differing only in material side. raycastAll needs
  // back faces (a cave ceiling's normal points down into the cavity, so a downward ray hits it
  // from behind and FrontSide would cull it); every existing path keeps the default culling.
  const twoSidedMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  twoSidedMesh.raycast = acceleratedRaycast;

  function resolveOnce(capsule, velocity, slopeLimitY, contacts, walkableVerticalResolution) {
    let hit = false;
    let grounded = false;
    let ceiling = false;
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
        const walkable = _normal.y >= slopeLimitY;
        // A character standing on walkable ground must not inherit the contact normal's lateral
        // component. Resolve that penetration vertically; reserve normal push-out for walls,
        // ceilings, and deliberately too-steep slopes. depth / normal.y gives the same separating
        // distance along the plane normal without moving X/Z.
        if (walkableVerticalResolution && walkable) _push.set(0, depth / _normal.y, 0);
        else _push.copy(_normal).multiplyScalar(depth);
        capsule.translate(_push);
        _line.copy(capsule);
        _box.expandByPoint(_line.start);
        _box.expandByPoint(_line.end);
        hit = true;
        if (walkable) grounded = true;
        if (_normal.y <= -slopeLimitY) ceiling = true;
        if (contacts) contacts.push({
          normal: [_normal.x, _normal.y, _normal.z],
          depth,
          walkable,
        });

        if (walkableVerticalResolution && walkable) {
          // Normal projection turns a vertical landing into downhill velocity. Walkable ground is
          // support: cancel only downward speed and let requested X/Z motion climb via correction.
          if (velocity.y < 0) velocity.y = 0;
        } else {
          const vn = velocity.dot(_normal);
          if (vn < 0) velocity.addScaledVector(_normal, -vn);
        }
        return false;
      },
    });

    return { hit, grounded, ceiling };
  }

  function resolveCapsule(capsule, velocity, {
    slopeLimitY = 0.5,
    iterations = 3,
    contacts = null,
    walkableVerticalResolution = false,
  } = {}) {
    let grounded = false;
    let ceiling = false;
    if (contacts) contacts.length = 0;
    for (let i = 0; i < iterations; i++) {
      const result = resolveOnce(capsule, velocity, slopeLimitY, contacts, walkableVerticalResolution);
      grounded = grounded || result.grounded;
      ceiling = ceiling || result.ceiling;
      if (!result.hit) break;
    }
    return { grounded, ceiling, contacts: contacts || undefined };
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

  // EVERY solid hit along a ray, near to far -- what raycast() returns only the first of. Used to
  // enumerate the floors in a column on volumetric maps, where one height per XZ is a lie.
  // Bake-time cost, not a per-frame one: `out` is reused so a placement loop need not allocate.
  function raycastAll(origin, dir, maxDistance = 200, out = []) {
    out.length = 0;
    _raycaster.ray.origin.set(origin[0], origin[1], origin[2]);
    _raycaster.ray.direction.set(dir[0], dir[1], dir[2]).normalize();
    _raycaster.near = 0;
    _raycaster.far = maxDistance;
    // firstHitOnly lives on the shared raycaster, so it is restored even if intersectObject throws.
    _raycaster.firstHitOnly = false;
    let hits;
    try { hits = _raycaster.intersectObject(twoSidedMesh, false); }
    finally { _raycaster.firstHitOnly = true; }
    for (const hit of hits) {
      const n = hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 1, 0];
      out.push({ distance: hit.distance, point: [hit.point.x, hit.point.y, hit.point.z], normal: n });
    }
    return out;
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
    // Which half of the build cost is which, and whether the fast path was taken. Guessing at this
    // split is what a per-chunk 6.6 ms bill does not survive.
    buildMs: { bake: +bakeMs.toFixed(3), bvh: +bvhMs.toFixed(3), direct: shared },
    resolveCapsule,
    raycastDown,
    raycast,
    raycastAll,
    isOccluded,
    dispose() {
      geometry.boundsTree = null;
      twoSidedMesh.material.dispose();
      // The fast path shares its position attribute with the live render geometry: disposing this
      // wrapper would free a buffer the renderer is still drawing from.
      if (!shared) geometry.dispose();
    },
  };
}
