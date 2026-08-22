// world-query-heightfield-provider.js — terrain-source → world-query adapter
// (Base Game terrain Phase 3). Pure: reuses collision.js contact/slide math and
// the terrain-source point API. It answers groundProbe and resolveCapsule only;
// it never returns a ceiling or a wall — overhangs, caves and buildings are
// mesh-BVH providers. Holes and finite bounds yield "no terrain here".

import { groundContact, slideVelocity } from './collision.js';

const EPSILON = 1e-9;

export function createHeightfieldWorldQueryProvider(source, {
  id = 'terrain',
  priority = 0,
  layers = 0xffffffff,
  enabled = true,
} = {}) {
  if (!source || typeof source.heightAt !== 'function' || typeof source.normalAt !== 'function') {
    throw new TypeError('heightfield provider requires a terrain source with heightAt() and normalAt()');
  }
  let current = source;
  const normalScratch = [0, 1, 0];
  const heightAt = (x, z) => current.heightAt(x, z);
  const normalAt = (x, z) => current.normalAt(x, z, normalScratch);

  function hasTerrain(x, z) {
    if (typeof current.contains === 'function' && !current.contains(x, z)) return false;
    if (typeof current.holeAt === 'function' && current.holeAt(x, z)) return false;
    return true;
  }
  function colliderId() {
    const d = current.descriptor;
    return d ? `${d.key}@${d.sourceVersion}` : id;
  }

  return {
    id,
    priority,
    layers,
    enabled,
    capabilities: ['groundProbe', 'resolveCapsule'],
    get source() { return current; },
    // Swap the sampled source (Phase 4 apply); identity in hits follows it.
    setSource(next) {
      if (!next || typeof next.heightAt !== 'function') throw new TypeError('setSource needs a terrain source');
      current = next;
    },

    // Cheap rejection before sampling: outside finite bounds / in a hole.
    acceptsQuery(query, capability) {
      if (capability === 'resolveCapsule') return hasTerrain(query.capsule.start[0], query.capsule.start[2]);
      if (capability === 'groundProbe') return hasTerrain(query.origin[0], query.origin[2]);
      return false;
    },

    // Terrain only answers when its surface is at or below the probe origin and
    // within maxDistance; the service applies the slope limit.
    groundProbe(query) {
      const [x, y, z] = query.origin;
      if (!hasTerrain(x, z)) return null;
      const groundY = heightAt(x, z);
      const distance = y - groundY;
      if (distance < -EPSILON || distance > query.maxDistance) return null;
      const n = normalAt(x, z);
      return {
        distance: Math.max(0, distance),
        point: [x, groundY, z],
        normal: [n[0], n[1], n[2]],
        colliderId: colliderId(),
        surfaceType: 'terrain',
        walkable: n[1] >= query.slopeLimitCos,
      };
    },

    // Seat the capsule on the surface and remove only velocity into it.
    resolveCapsule(query) {
      const { start, end, radius } = query.capsule;
      const x = start[0], z = start[2];
      if (!hasTerrain(x, z)) return null;
      const contact = groundContact({ x, z, bottomY: start[1] - radius, slopeLimitY: query.slopeLimitCos, heightAt, normalAt });
      if (contact.penetration <= 0) return null;
      const lift = contact.penetration;
      const n = contact.normal;
      const v = query.velocity;
      const slid = slideVelocity({ x: v[0], y: v[1], z: v[2] }, n);
      return {
        capsule: {
          start: [start[0], start[1] + lift, start[2]],
          end: [end[0], end[1] + lift, end[2]],
          radius,
        },
        velocity: [slid.x, slid.y, slid.z],
        grounded: contact.grounded,
        ceiling: false,
        contacts: [{
          point: [x, contact.groundY, z],
          normal: [n[0], n[1], n[2]],
          depth: lift,
          colliderId: colliderId(),
          surfaceType: 'terrain',
          walkable: contact.grounded,
        }],
      };
    },
  };
}
