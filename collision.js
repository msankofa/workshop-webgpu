// collision.js — pure capsule-vs-world collision math (SP5). No three.js import, so it
// runs under Node for unit tests and in the browser for the live player/creatures.
//
// Phase A implements terrain only: the ground is a closed-form analytic height field
// (terrain-field.js terrainHeightAt), so contact is an O(1) query with no spatial
// structure to rebuild. Phases B/C (trunk capsules, rock BVH) extend this module.

// Capsule-bottom vs analytic ground. Inputs are scalars + injected field functions so
// the module stays three.js-free and Node-testable.
//   x, z         capsule axis position in world XZ
//   bottomY      world Y of the lowest point of the capsule (start.y - radius)
//   slopeLimitY  minimum normal.y to count as standable ground (default 0.5)
//   heightAt     (x,z) -> ground Y
//   normalAt     (x,z) -> [nx,ny,nz] unit surface normal
// Returns { groundY, penetration, grounded, normal, restBottomY }.
//   penetration > 0  means the capsule bottom is below the ground by that much.
//   restBottomY      where the bottom should rest (groundY if penetrating, else unchanged).
//   normal           the surface normal when penetrating, else null.
export function groundContact({ x, z, bottomY, slopeLimitY = 0.5, heightAt, normalAt }) {
  const groundY = heightAt(x, z);
  const penetration = groundY - bottomY;
  if (penetration <= 0) {
    return { groundY, penetration, grounded: false, normal: null, restBottomY: bottomY };
  }
  const normal = normalAt(x, z);
  const grounded = normal[1] >= slopeLimitY;
  return { groundY, penetration, grounded, normal, restBottomY: groundY };
}

// Remove the into-surface component of a velocity (slide along the surface). Only the
// component opposing the normal is removed, so upward motion (a jump) is preserved and
// resting gravity is cancelled — mirrors the octree slide but does not kill jumps.
//   v  { x, y, z }   n  [nx, ny, nz] (unit)
// Returns a new { x, y, z }.
export function slideVelocity(v, n) {
  const vn = v.x * n[0] + v.y * n[1] + v.z * n[2];
  if (vn >= 0) return { x: v.x, y: v.y, z: v.z };
  return { x: v.x - n[0] * vn, y: v.y - n[1] * vn, z: v.z - n[2] * vn };
}
