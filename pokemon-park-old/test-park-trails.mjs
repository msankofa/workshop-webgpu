// Node checks for the park's trail router.

import { buildPark, PARK_TERRAIN } from './park-biomes.js';
import {
  TRAIL_DEFAULTS, buildTrailGrid, snapToWalkable, routeTrail, smoothPath, thinPath,
  buildTrails, parkTrailLegs,
} from './park-trails.js';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

const park = buildPark({ seed: 4 });
const grid = buildTrailGrid({
  heightAt: park.map.heightAt,
  worldX: PARK_TERRAIN.worldX, worldZ: PARK_TERRAIN.worldZ,
  waterLevel: PARK_TERRAIN.waterLevel,
});

{
  let walk = 0;
  for (const v of grid.walkable) walk += v;
  check('the grid covers the park', grid.nx * grid.cell <= PARK_TERRAIN.worldX && grid.nx > 40, `${grid.nx}x${grid.nz}`);
  check('most of the park is walkable', walk / grid.walkable.length > 0.6, `${((walk / grid.walkable.length) * 100).toFixed(0)}%`);
  check('but not all of it — the lake is not', walk < grid.walkable.length);
}

{
  // Every walkable cell must be above the waterline; a trail into the lake is the visible failure.
  let wet = 0;
  for (let i = 0; i < grid.walkable.length; i++) {
    if (grid.walkable[i] && grid.height[i] <= PARK_TERRAIN.waterLevel + TRAIL_DEFAULTS.waterMargin) wet++;
  }
  check('no walkable cell is under water', wet === 0, `${wet} cells`);
}

{
  const lake = { x: PARK_TERRAIN.lake.x * (PARK_TERRAIN.worldX / 2), z: PARK_TERRAIN.lake.z * (PARK_TERRAIN.worldZ / 2) };
  const snapped = snapToWalkable(grid, lake.x, lake.z);
  check('an anchor in the lake snaps to dry land', !!snapped);
  if (snapped) {
    check('and the cell it snaps to really is walkable', !!grid.walkable[snapped.iz * grid.nx + snapped.ix]);
  }
  check('an anchor already on land stays put', (() => {
    const p = grid.toWorld(4, 4);
    if (!grid.walkable[4 * grid.nx + 4]) return true;
    const s = snapToWalkable(grid, p.x, p.z);
    return s.ix === 4 && s.iz === 4;
  })());
}

{
  const legs = parkTrailLegs(PARK_TERRAIN);
  const { paths, skipped } = buildTrails({ grid, legs });
  check('every leg of the park plan routes', skipped.length === 0, skipped.join(', '));
  check('and there are as many paths as legs', paths.length === legs.length, `${paths.length} of ${legs.length}`);

  let metres = 0, worstGrade = 0, wetPoints = 0, offMap = 0;
  const half = PARK_TERRAIN.worldX / 2;
  for (const path of paths) {
    check(`${path.name}: has at least two control points`, path.points.length >= 2);
    for (let i = 0; i < path.points.length; i++) {
      const p = path.points[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) offMap++;
      if (Math.abs(p.x) > half || Math.abs(p.z) > half) offMap++;
      if (park.map.heightAt(p.x, p.z) < PARK_TERRAIN.waterLevel) wetPoints++;
      if (i > 0) {
        const q = path.points[i - 1];
        const run = Math.hypot(p.x - q.x, p.z - q.z);
        metres += run;
        if (run > 1) worstGrade = Math.max(worstGrade, Math.abs(park.map.heightAt(p.x, p.z) - park.map.heightAt(q.x, q.z)) / run);
      }
    }
  }
  check('no control point leaves the park', offMap === 0, `${offMap}`);
  check('no control point is under water', wetPoints === 0, `${wetPoints}`);
  check('the network is worth walking', metres > 3000, `${metres.toFixed(0)} m`);
  // Smoothing cuts corners, so the realised grade can beat the search grid's cell grade.
  check('nothing climbs a cliff', worstGrade < 1.0, `worst ${worstGrade.toFixed(2)}`);
  console.log(`  ${paths.length} trails, ${(metres / 1000).toFixed(1)} km, worst grade ${(worstGrade * 100).toFixed(0)}%`);
}

{
  // A route that cannot exist has to say so rather than return a straight line through the lake.
  const nowhere = buildTrails({ grid, legs: [{ name: 'nowhere', from: { x: 0, z: 0 }, to: { x: 0, z: 0 } }] });
  check('a zero-length leg is reported, not emitted', nowhere.paths.length === 0 && nowhere.skipped.length === 1);
}

{
  const raw = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
  const smooth = smoothPath(raw, 2);
  check('smoothing keeps both ends', smooth[0].x === 0 && smooth[0].z === 0
    && smooth[smooth.length - 1].x === 10 && smooth[smooth.length - 1].z === 10);
  check('and rounds the corner off', smooth.length > raw.length);
  let maxTurn = 0;
  for (let i = 1; i < smooth.length - 1; i++) {
    const a = Math.atan2(smooth[i].z - smooth[i - 1].z, smooth[i].x - smooth[i - 1].x);
    const b = Math.atan2(smooth[i + 1].z - smooth[i].z, smooth[i + 1].x - smooth[i].x);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = Math.PI * 2 - d;
    maxTurn = Math.max(maxTurn, d);
  }
  check('with no corner sharper than the original', maxTurn < Math.PI / 2 + 1e-6, `${(maxTurn * 180 / Math.PI).toFixed(0)} deg`);

  const thin = thinPath(smooth, 3);
  check('thinning keeps the ends too', thin[0].x === 0 && thin[thin.length - 1].x === 10);
  check('and drops the crowded middle', thin.length < smooth.length);
  let closest = Infinity;
  for (let i = 1; i < thin.length - 1; i++) closest = Math.min(closest, Math.hypot(thin[i].x - thin[i - 1].x, thin[i].z - thin[i - 1].z));
  check('leaving nothing closer than the spacing', closest >= 3 - 1e-6, `${closest.toFixed(2)}`);
}

{
  const a = buildTrails({ grid, legs: parkTrailLegs(PARK_TERRAIN) });
  const b = buildTrails({ grid, legs: parkTrailLegs(PARK_TERRAIN) });
  check('routing is deterministic', JSON.stringify(a.paths) === JSON.stringify(b.paths));
}

{
  // A steeper allowance opens ground a gentler one refuses, which is what the knob is for.
  const steep = buildTrailGrid({
    heightAt: park.map.heightAt, worldX: PARK_TERRAIN.worldX, worldZ: PARK_TERRAIN.worldZ,
    waterLevel: PARK_TERRAIN.waterLevel, options: { maxGrade: 0.2 },
  });
  let strict = 0, loose = 0;
  for (const v of steep.walkable) strict += v;
  for (const v of grid.walkable) loose += v;
  check('a stricter grade limit walls off more ground', strict < loose, `${strict} vs ${loose}`);
  const saddle = { x: PARK_TERRAIN.peak.x * 0.66 * 1200, z: PARK_TERRAIN.peak.z * 0.66 * 1200 };
  const gate = { x: PARK_TERRAIN.townPad.x * 1200, z: PARK_TERRAIN.townPad.z * 1200 };
  check('and the default limit still reaches the mountain', !!routeTrail(grid, gate, saddle));
}

console.log(`\npark trails: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
