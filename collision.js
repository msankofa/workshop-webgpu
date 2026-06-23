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

// Lateral 2D circle-vs-circle push-out: move a point at (px,pz) with collision radius
// `radius` out of any overlapping trunk circle {x,z,r}. Iterates so resolving the deepest
// overlap does not leave the point inside another. Lateral only (no Y). Returns {x,z,pushed}.
// Trees are tall and narrow, so a vertical trunk capsule reduces to this XZ circle test.
// v1 limit: two trunks whose exclusion zones overlap on the connecting axis leave no valid
// gap; the point is stopped between them (no tunneling) rather than ejected perpendicular.
export function resolveTrunks(px, pz, radius, trunks, iterations = 4) {
  let x = px, z = pz, pushed = false;
  for (let it = 0; it < iterations; it++) {
    let best = null, bestPen = 0;
    for (const t of trunks) {
      const dx = x - t.x, dz = z - t.z;
      const minD = radius + t.r;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const pen = minD - d;
        if (pen > bestPen) { bestPen = pen; best = { tx: t.x, tz: t.z, dx, dz, d, minD }; }
      }
    }
    if (!best) break;
    pushed = true;
    if (best.d > 1e-6) {
      const inv = best.minD / best.d;
      x = best.tx + best.dx * inv;
      z = best.tz + best.dz * inv;
    } else {
      x = best.tx + best.minD;   // exactly at centre: deterministic +x
      z = best.tz;
    }
  }
  return { x, z, pushed };
}

// Chunk-bucketed trunk store. Keys are terrain chunk keys ("ix,iz"); resolve() only tests
// the point's chunk plus its 8 neighbours, so cost is bounded regardless of forest size.
export function createTrunkIndex(chunkSize) {
  const buckets = new Map();
  return {
    setTrunks(key, trunks) { if (trunks && trunks.length) buckets.set(key, trunks); else buckets.delete(key); },
    clearTrunks(key) { buckets.delete(key); },
    resolve(px, pz, radius) {
      const cx = Math.floor(px / chunkSize), cz = Math.floor(pz / chunkSize);
      const near = [];
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
          const b = buckets.get(`${ix},${iz}`);
          if (b) for (const t of b) near.push(t);
        }
      }
      if (near.length === 0) return { x: px, z: pz, pushed: false };
      return resolveTrunks(px, pz, radius, near);
    },
  };
}
