import {
  WORLD_COORDINATE_CONTRACT_VERSION,
  createWorldCoordinateSpace,
  globalToRenderLocal,
  parseWorldCellKey3,
  renderLocalToGlobal,
  renderOriginShiftDelta,
  snapRenderOrigin,
  worldCell3,
  worldCellBounds3,
  worldCellKey3,
  worldPositionKey3,
} from './world-coordinates.js';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};
const equal3 = (a, b, eps = 1e-9) => a.length >= 3 && b.length >= 3
  && Math.abs(a[0] - b[0]) <= eps
  && Math.abs(a[1] - b[1]) <= eps
  && Math.abs(a[2] - b[2]) <= eps;

ok(WORLD_COORDINATE_CONTRACT_VERSION === 1, 'coordinate contract is versioned');

{
  const global = [1_000_000_012.25, -1997.5, -999_999_992.75];
  const origin = [1_000_000_000, -2000, -1_000_000_000];
  const local = globalToRenderLocal(global, origin);
  ok(equal3(local, [12.25, 2.5, 7.25]), 'large global coordinates become small render-local coordinates');
  ok(equal3(renderLocalToGlobal(local, origin), global), 'global/local conversion round-trips');
}

{
  ok(equal3(renderOriginShiftDelta([100, 20, -30], [160, -5, 10]), [-60, 25, -40]),
    'origin shift delta moves existing local objects correctly');
  ok(equal3(snapRenderOrigin([1500, -700, 4100], 1024), [1024, -1024, 4096]),
    'render origin snaps in all three dimensions');
}

{
  const space = createWorldCoordinateSpace({ rebaseDistance: 1000, rebaseSnap: 256 });
  let observed = null;
  const stop = space.onRebase(event => { observed = event; });
  const unchanged = space.maybeRebase([500, 0, 0]);
  ok(!unchanged.changed && space.revision === 0, 'focus inside threshold does not rebase');
  const changed = space.maybeRebase([1300, 600, -900]);
  ok(changed.changed && space.revision === 1, 'focus outside threshold rebases and increments revision');
  ok(equal3(space.getOrigin(), [1280, 512, -1024]), 'automatic rebase uses snapped 3D origin');
  ok(observed?.revision === 1 && equal3(observed.delta, [-1280, -512, 1024]), 'rebase listener receives local-object delta');
  const global = [1290, 520, -1000];
  ok(equal3(space.toGlobal(space.toRenderLocal(global)), global), 'coordinate-space conversion round-trips after rebase');
  stop();
  space.setRenderOrigin([0, 0, 0]);
  ok(observed?.revision === 1, 'unsubscribed listener is not called again');
}

{
  const cell = worldCell3([-0.01, 64, -64.01], 64);
  ok(equal3(cell, [-1, 1, -2]), '3D cell addressing floors negative coordinates correctly');
  const key = worldCellKey3(cell, { lod: 2, layer: 'cave' });
  ok(key === 'cave:2:-1:1:-2', '3D cell key includes layer, LOD, and XYZ');
  const parsed = parseWorldCellKey3(key);
  ok(parsed.layer === 'cave' && parsed.lod === 2 && equal3(parsed.cell, cell), '3D cell key round-trips');
  ok(worldPositionKey3([127, 255, -1], 128, { layer: 'structure' }) === 'structure:0:0:1:-1',
    'world position produces stable 3D spatial key');
  const bounds = worldCellBounds3([-1, 1, -2], 64);
  ok(equal3(bounds.min, [-64, 64, -128]) && equal3(bounds.max, [0, 128, -64]),
    'cell bounds cover the addressed 3D region');
}

{
  let threw = 0;
  try { globalToRenderLocal([0, NaN, 0], [0, 0, 0]); } catch { threw++; }
  try { worldCell3([0, 0, 0], 0); } catch { threw++; }
  try { parseWorldCellKey3('bad:key'); } catch { threw++; }
  ok(threw === 3, 'invalid coordinates, cell size, and keys fail loudly');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
