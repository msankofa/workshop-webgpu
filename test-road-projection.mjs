import { projectRoadPositions } from './road-projection.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };
const source = {
  heightAt: () => 2,
  normalAt(x, z, out) { out[0] = 0; out[1] = 1; out[2] = 0; return out; },
  densityAt(x, y) { return 5 - y; },
  surfaceYAt() { return 5; },
};
const positions = new Float32Array([0, 99, 0, 2, -40, 3]);
const normals = projectRoadPositions(source, positions, { lift: 0.01, epsilon: 0.1 });
ok(Math.abs(positions[1] - 5.01) < 1e-5 && Math.abs(positions[4] - 5.01) < 1e-5,
  'projection replaces input Y with the density surface plus the normal lift');
ok(normals[1] > 0.999 && normals[4] > 0.999, 'density gradient normals point out of the surface');

const heightfield = { heightAt: (x, z) => x + z, normalAt(x, z, out) { out[0] = 0; out[1] = 1; out[2] = 0; return out; } };
const fallback = new Float32Array([2, 0, 3]);
projectRoadPositions(heightfield, fallback, { lift: 0 });
ok(fallback[1] === 5, 'non-volumetric sources project through their heightfield contract');

console.log(`road projection: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
