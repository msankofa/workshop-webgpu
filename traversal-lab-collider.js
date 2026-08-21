// Renderer-free Traversal Lab collision: one merged BufferGeometry per material bucket from the
// shared layout, baked into the existing map-collision BVH and adapted as a world-query provider.
// Both the browser (which then attaches materials) and the room server consume this one path.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createMapCollider } from './map-collision.js';
import { createMapColliderWorldQueryProvider } from './world-query-map-provider.js';
import { createTraversalLabLayout } from './traversal-lab-layout.js';

export const TRAVERSAL_LAB_PROVIDER_ID = 'traversal-lab-static';

export function buildTraversalLabGeometry(layout = createTraversalLabLayout()) {
  const buckets = new Map();
  for (const primitive of layout.primitives) {
    const geometry = new THREE.BoxGeometry(primitive.sx, primitive.sy, primitive.sz);
    geometry.rotateX(primitive.rx);
    geometry.rotateY(primitive.ry);
    geometry.rotateZ(primitive.rz);
    geometry.translate(primitive.cx, primitive.cy, primitive.cz);
    let bucket = buckets.get(primitive.material);
    if (!bucket) buckets.set(primitive.material, bucket = []);
    bucket.push(geometry);
  }
  const merged = new Map();
  for (const [materialName, geometries] of buckets) {
    const geometry = mergeGeometries(geometries, false);
    for (const source of geometries) source.dispose();
    if (!geometry) throw new Error(`Could not merge Traversal Lab material bucket: ${materialName}`);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    merged.set(materialName, geometry);
  }
  return merged;
}

export function createTraversalLabCollider({ layout = createTraversalLabLayout(), priority = 100 } = {}) {
  const root = new THREE.Group();
  root.name = 'base-game-traversal-lab';
  const geometries = buildTraversalLabGeometry(layout);
  const meshes = [];
  for (const [materialName, geometry] of geometries) {
    const mesh = new THREE.Mesh(geometry);
    mesh.name = `traversal-lab-${materialName}`;
    mesh.userData.materialName = materialName;
    root.add(mesh);
    meshes.push(mesh);
  }
  const collider = createMapCollider(root, { maxTriangles: 50_000 });
  const provider = createMapColliderWorldQueryProvider(collider, {
    id: TRAVERSAL_LAB_PROVIDER_ID,
    priority,
    enabled: true,
  });
  return {
    layout,
    root,
    meshes,
    collider,
    provider,
    stats: Object.freeze({
      primitiveCount: layout.primitives.length,
      collisionTriangles: collider.triangleCount,
      materialDraws: meshes.length,
    }),
    dispose() {
      collider.dispose();
      for (const mesh of meshes) mesh.geometry.dispose();
    },
  };
}

// Convenience for hosts that only need queries (the room server): a ready world-query service.
export function createTraversalLabWorldQuery(worldQuery, options) {
  const lab = createTraversalLabCollider(options);
  const unregister = worldQuery.registerProvider(lab.provider);
  return { ...lab, dispose() { unregister(); lab.dispose(); } };
}
