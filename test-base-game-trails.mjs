import { createBaseGameTrails } from './base-game-trails.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };

function fixture() {
  const stampCalls = [];
  const plan = {
    post: 30, tileSize: 120, version: 1, coverage: 1,
    win: {
      placed: true, originPX: -8, originPZ: -8, res: 20, tileIntervals: 4, tilesPerSide: 5,
      hasTile: (tx, tz) => tx >= -2 && tx <= 2 && tz >= -2 && tz <= 2,
    },
    sampleAt(name, x, z) {
      if (x < -240 || x > 360 || z < -240 || z > 360) return null;
      if (name === 'heights') return 20 + x * 0.01;
      if (name === 'planWalk') return 255;
      return 0;
    },
  };
  const fields = {
    stampAlong(names, path, radius) { stampCalls.push({ names, path, radius }); return path.length; },
    clear() {},
  };
  const terrain = {
    plan, fields,
    acquirePlan: () => () => {}, acquireFields: () => () => {},
    setTrailPlannerHooks(hooks) { this.hooks = hooks; },
  };
  return { terrain, stampCalls };
}

function build() {
  const f = fixture();
  const planner = createBaseGameTrails({ terrain: f.terrain, options: {
    seed: 17, spacing: 120, routeMargin: 30, maxLegLength: 500, maxGrade: 0.3, crossSlope: 0.3,
    routeIntervalMs: 0,
  } });
  for (let i = 0; i < 200; i++) planner.update([0, 0, 0]);
  return { ...f, planner };
}

const a = build();
ok(a.planner.stats.sites > 8, 'resident plan tiles produce placeholder sites');
ok(a.planner.stats.routed > 0 && a.planner.stats.edges > 0, 'eligible legs route and commit to the road network');
ok(a.stampCalls.length === a.planner.stats.routed, 'each committed leg stamps resident cover');
ok(a.planner.edgePolylines().flat().every(([, y]) => y >= 17.5), 'routed samples stay on dry ground');
ok(a.planner.edgePolylines().every(path => path.slice(1).every((p, i) => {
  const q = path[i]; return Math.abs(p[1] - q[1]) / Math.hypot(p[0] - q[0], p[2] - q[2]) <= 0.3 + 1e-6;
})), 'every sampled edge remains under the grade cap');
ok([...a.planner.network.nodes.values()].some(node => node.edgeIds.size >= 3), 'the routed network contains a junction');
ok(a.planner.clearanceAt(0, 0) >= 0 && a.planner.clearanceAt(0, 0) <= 1, 'clearance is a normalized multiplier');

const b = build();
const canonical = planner => planner.edgePolylines().map(path => JSON.stringify(path.map(p => p.map(v => +v.toFixed(4))))).sort();
ok(JSON.stringify(canonical(a.planner)) === JSON.stringify(canonical(b.planner)), 'same seed and plan produce identical sampled edge geometry');

const beforePrune = canonical(a.planner);
a.terrain.plan.win.originPX = -4; a.terrain.plan.version++;
for (let i = 0; i < 200; i++) a.planner.update([120, 0, 0]);
a.terrain.plan.win.originPX = -8; a.terrain.plan.version++;
for (let i = 0; i < 200; i++) a.planner.update([0, 0, 0]);
const afterPrune = canonical(a.planner);
ok(JSON.stringify(afterPrune) === JSON.stringify(beforePrune),
  `prune and return rebuilds the same canonical geometry (${beforePrune.length} before, ${afterPrune.length} after)`);

a.planner.dispose(); b.planner.dispose();
console.log(`base game trails: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
