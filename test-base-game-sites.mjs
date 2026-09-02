import { sitesForTile } from './base-game-sites.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };

function mockPlan({ ready = true, water = false } = {}) {
  return {
    post: 30, tileSize: 120,
    sampleAt(name, x, z) {
      if (!ready) return null;
      if (name === 'planWalk') return water || x > 2000 ? 0 : 255 - (Math.abs(Math.round(x / 30)) + Math.abs(Math.round(z / 30))) % 30;
      return 10;
    },
  };
}

const plan = mockPlan();
const first = sitesForTile(42, 2, -1, plan);
const again = sitesForTile(42, 2, -1, plan);
ok(JSON.stringify(first) === JSON.stringify(again), 'sites are deterministic');
ok(sitesForTile(42, 0, 0, plan)[0].x === 0 && sitesForTile(42, 0, 0, plan)[0].z === 0, 'spawn is always a site');
ok(sitesForTile(42, 4, 4, mockPlan({ water: true })).length === 0, 'open water yields no site');
ok(sitesForTile(42, 4, 4, mockPlan({ ready: false })) === null, 'missing plan data defers the tile');

const ordered = [[2, 3], [-2, 1], [5, -4]].map(([x, z]) => sitesForTile(99, x, z, plan));
const reversed = [[5, -4], [-2, 1], [2, 3]].map(([x, z]) => sitesForTile(99, x, z, plan)).reverse();
ok(JSON.stringify(ordered) === JSON.stringify(reversed), 'tile arrival order does not affect sites');

console.log(`base game sites: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
