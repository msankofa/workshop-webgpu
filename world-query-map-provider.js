// Adapter from the repository's existing three-mesh-bvh map collider to the
// renderer-independent world-query provider contract.

import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';

export function createMapColliderWorldQueryProvider(collider, {
  id = 'static-mesh',
  priority = 0,
  layers = 0xffffffff,
  enabled = true,
} = {}) {
  if (!collider || typeof collider.raycast !== 'function' || typeof collider.raycastAll !== 'function') {
    throw new TypeError('map collider provider requires raycast() and raycastAll()');
  }
  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.35);
  const velocity = new THREE.Vector3();
  const contacts = [];
  const provider = {
    id,
    priority,
    layers,
    enabled,
    raycast(query) {
      return collider.raycast(query.origin, query.direction, query.maxDistance);
    },
    raycastAll(query) {
      return collider.raycastAll(query.origin, query.direction, query.maxDistance, []);
    },
  };
  if (typeof collider.resolveCapsule === 'function') {
    provider.resolveCapsule = function resolveCapsule(query) {
      capsule.start.fromArray(query.capsule.start);
      capsule.end.fromArray(query.capsule.end);
      capsule.radius = query.capsule.radius;
      velocity.fromArray(query.velocity);
      const result = collider.resolveCapsule(capsule, velocity, {
        slopeLimitY: query.slopeLimitCos,
        iterations: query.iterations,
        contacts,
        walkableVerticalResolution: query.walkableVerticalResolution === true,
      });
      return {
        capsule: {
          start: capsule.start.toArray(),
          end: capsule.end.toArray(),
          radius: capsule.radius,
        },
        velocity: velocity.toArray(),
        grounded: result.grounded,
        ceiling: result.ceiling,
        contacts: contacts.map(contact => ({ ...contact })),
      };
    };
  }
  return provider;
}
