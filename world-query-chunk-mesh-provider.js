// world-query-chunk-mesh-provider.js — one world-query provider over many streamed chunk
// meshes (Base Game terrain Phase 8: volumetric terrain with caves). Each chunk gets its own
// map-collision BVH; queries touch only the chunks whose bounds they intersect. The provider
// id stays stable while chunks come and go, so surface identity reads as `terrain-volume`
// with the chunk key as colliderId.

import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { createMapCollider } from './map-collision.js';

const _box = new THREE.Box3();
const _ray = new THREE.Ray();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();

export function createChunkMeshWorldQueryProvider({
  id = 'terrain-volume',
  priority = 50,
  layers = 0xffffffff,
  enabled = true,
  maxTrianglesPerChunk = 200_000,
} = {}) {
  const chunks = new Map();   // key -> { collider, box, triangles }
  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.35);
  const velocity = new THREE.Vector3();
  const scratchContacts = [];

  // Cumulative collider build cost, split by phase (see map-collision.js createMapCollider).
  const buildStats = { chunks: 0, bakeMs: 0, bvhMs: 0, lastBakeMs: 0, lastBvhMs: 0, direct: null };

  function setChunk(key, geometry, { sourceVersion = null } = {}) {
    removeChunk(key);
    if (!geometry?.attributes?.position || geometry.attributes.position.count === 0) return false;
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld();
    const collider = createMapCollider(mesh, { maxTriangles: maxTrianglesPerChunk });
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    chunks.set(key, { collider, box: geometry.boundingBox.clone(), triangles: collider.triangleCount, sourceVersion });
    // Rolling build cost, so a capture can say which half of a collider rebuild is expensive.
    buildStats.chunks++;
    buildStats.bakeMs += collider.buildMs.bake;
    buildStats.bvhMs += collider.buildMs.bvh;
    buildStats.lastBakeMs = collider.buildMs.bake;
    buildStats.lastBvhMs = collider.buildMs.bvh;
    buildStats.direct = collider.buildMs.direct;
    return true;
  }
  function removeChunk(key) {
    const entry = chunks.get(key);
    if (!entry) return false;
    entry.collider.dispose();
    chunks.delete(key);
    return true;
  }

  function rayCandidates(query) {
    _origin.fromArray(query.origin);
    _dir.fromArray(query.direction);
    _ray.set(_origin, _dir);
    const out = [];
    for (const [key, entry] of chunks) {
      if (entry.box.containsPoint(_origin)) { out.push([key, entry]); continue; }   // short probes from inside the chunk
      const t = _ray.intersectBox(entry.box, _hitPoint);
      if (t === null) continue;
      if (_hitPoint.distanceTo(_origin) > query.maxDistance) continue;
      out.push([key, entry]);
    }
    return out;
  }

  return {
    id, priority, layers, enabled,
    capabilities: ['raycast', 'raycastAll', 'resolveCapsule'],
    get chunkCount() { return chunks.size; },
    get triangleCount() { let n = 0; for (const e of chunks.values()) n += e.triangles; return n; },
    hasChunk(key) { return chunks.has(key); },
    setChunk,
    buildStats,
    removeChunk,
    clear() { for (const key of [...chunks.keys()]) removeChunk(key); },

    raycast(query) {
      let best = null;
      for (const [key, entry] of rayCandidates(query)) {
        const hit = entry.collider.raycast(query.origin, query.direction, query.maxDistance);
        if (hit && (!best || hit.distance < best.distance)) best = { ...hit, colliderId: key, surfaceType: 'terrain' };
      }
      return best;
    },
    raycastAll(query) {
      const out = [];
      for (const [key, entry] of rayCandidates(query)) {
        for (const hit of entry.collider.raycastAll(query.origin, query.direction, query.maxDistance, [])) {
          out.push({ ...hit, colliderId: key, surfaceType: 'terrain' });
        }
      }
      return out;
    },
    resolveCapsule(query) {
      capsule.start.fromArray(query.capsule.start);
      capsule.end.fromArray(query.capsule.end);
      capsule.radius = query.capsule.radius;
      velocity.fromArray(query.velocity);
      let grounded = false, ceiling = false;
      const contacts = [];
      for (const [key, entry] of chunks) {
        _box.makeEmpty();
        _box.expandByPoint(capsule.start); _box.expandByPoint(capsule.end);
        _box.min.addScalar(-capsule.radius - 0.5); _box.max.addScalar(capsule.radius + 0.5);
        if (!_box.intersectsBox(entry.box)) continue;
        scratchContacts.length = 0;
        const r = entry.collider.resolveCapsule(capsule, velocity, { slopeLimitY: query.slopeLimitCos, iterations: query.iterations, contacts: scratchContacts });
        grounded = grounded || r.grounded;
        ceiling = ceiling || r.ceiling;
        for (const c of scratchContacts) contacts.push({ ...c, colliderId: key, surfaceType: 'terrain' });
      }
      if (!contacts.length) return null;
      return {
        capsule: { start: capsule.start.toArray(), end: capsule.end.toArray(), radius: capsule.radius },
        velocity: velocity.toArray(),
        grounded, ceiling, contacts,
      };
    },
  };
}
