// Pure road-surface projection shared by the worker and Node tests. Positions arrive as an XZ
// lattice; Y is ignored and replaced with the authoritative terrain-source surface.

export const ROAD_PROJECTION_DEFAULTS = Object.freeze({ epsilon: 0.25, lift: 0.01 });

export function projectRoadPositions(source, positions, options = {}) {
  if (!source || typeof source.heightAt !== 'function' || typeof source.normalAt !== 'function') {
    throw new TypeError('road projection needs a terrain source');
  }
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
    throw new TypeError('road projection positions must be a Float32Array of xyz triples');
  }
  const cfg = { ...ROAD_PROJECTION_DEFAULTS, ...options };
  const e = Math.max(0.001, Number(cfg.epsilon) || ROAD_PROJECTION_DEFAULTS.epsilon);
  const lift = Math.max(0, Number(cfg.lift) || 0);
  const normals = new Float32Array(positions.length);
  const heightfieldNormal = [0, 1, 0];
  const volumetric = typeof source.surfaceYAt === 'function' && typeof source.densityAt === 'function';

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], z = positions[i + 2];
    const h = source.heightAt(x, z);
    let y, nx, ny, nz;
    if (volumetric) {
      y = source.surfaceYAt(x, z, h);
      const hx0 = source.heightAt(x - e, z), hx1 = source.heightAt(x + e, z);
      const hz0 = source.heightAt(x, z - e), hz1 = source.heightAt(x, z + e);
      const gx = source.densityAt(x + e, y, z, hx1) - source.densityAt(x - e, y, z, hx0);
      const gy = source.densityAt(x, y + e, z, h) - source.densityAt(x, y - e, z, h);
      const gz = source.densityAt(x, y, z + e, hz1) - source.densityAt(x, y, z - e, hz0);
      const inv = -1 / (Math.hypot(gx, gy, gz) || 1); // density grows inward; point out of rock
      nx = gx * inv; ny = gy * inv; nz = gz * inv;
    } else {
      y = h;
      source.normalAt(x, z, heightfieldNormal, 0);
      [nx, ny, nz] = heightfieldNormal;
    }
    if (![x, y, z, nx, ny, nz].every(Number.isFinite)) {
      throw new Error(`invalid road projection at ${x},${z}`);
    }
    positions[i] = x + nx * lift;
    positions[i + 1] = y + ny * lift;
    positions[i + 2] = z + nz * lift;
    normals[i] = nx; normals[i + 1] = ny; normals[i + 2] = nz;
  }
  return normals;
}
