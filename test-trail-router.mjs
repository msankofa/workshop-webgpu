import { buildTrailGrid, routeTrail, smoothPath } from './trail-router.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };

{
  const grid = buildTrailGrid({ heightAt: () => 10, worldX: 330, worldZ: 330, options: { cell: 10 } });
  const path = routeTrail(grid, { x: -140, z: 0 }, { x: 140, z: 0 });
  ok(path?.length > 2, 'flat ground routes');
  ok(path.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)), 'route contains finite world points');
}

{
  const grid = buildTrailGrid({ heightAt: (_x, z) => 20 + z, worldX: 210, worldZ: 210,
    options: { cell: 10, maxGrade: 2, crossSlope: 0.2 } });
  const path = routeTrail(grid, { x: -80, z: 0 }, { x: 80, z: 0 });
  ok(path === null, 'direction-aware cross slope refuses a traverse across a steep face');
}

{
  const grid = buildTrailGrid({ heightAt: () => 10, worldX: 210, worldZ: 210, options: { cell: 10 } });
  grid.costMul = new Float32Array(grid.nx * grid.nz).fill(5);
  const preferredZ = 3;
  for (let x = 0; x < grid.nx; x++) grid.costMul[preferredZ * grid.nx + x] = 0.2;
  const from = grid.toWorld(1, 10), to = grid.toWorld(grid.nx - 2, 10);
  const path = routeTrail(grid, from, to);
  ok(path?.some(p => grid.toCell(p.x, p.z).iz === preferredZ), 'cost multiplier steers the route into a preferred corridor');
}

{
  const source = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }];
  const walkable = (x, z) => !(x > 0 && x < 5 && z > 5 && z < 10);
  const path = smoothPath(source, 3, walkable);
  ok(path.every(p => walkable(p.x, p.z)), 'smoothing never enters an unwalkable corner');
}

console.log(`trail router: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
