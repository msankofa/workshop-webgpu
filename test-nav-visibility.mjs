// Node tests for nav-visibility.js (baked pairwise cell visibility field).
// Run: node test-nav-visibility.mjs
import { buildNavGrid } from './nav-grid.js';
import { buildSightGrid, buildVisibilityField, buildLazyVisibilityField, buildHeightGrid, cellIndexAt, SIGHT_BLOCK_HEIGHT } from './nav-visibility.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// Rects are bot-viewer format: {x,z,w,d,h} center + full extents; missing h = full-height wall.
function inRect(rect, x, z) {
  return Math.abs(x - rect.x) <= rect.w / 2 && Math.abs(z - rect.z) <= rect.d / 2;
}
function gridFromRects(rects, bounds, cellSize) {
  return buildNavGrid((x, z) => !rects.some(rc => inRect(rc, x, z)), bounds, cellSize);
}
function idx(grid, c, r) { return r * grid.cols + c; }

// ---- single full-height wall splitting a room: opposite sides hidden, same side visible ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 10 };
  const wall = { x: 10, z: 5, w: 1, d: 10 }; // no h -> full height, blocks sight
  const grid = gridFromRects([wall], bounds, 1);
  const sight = buildSightGrid(grid, [wall]);
  const field = buildVisibilityField(grid, sight);

  ok(field.canSee(idx(grid, 2, 2), idx(grid, 17, 2)) === false, 'cells on opposite sides of the wall are mutually hidden');
  ok(field.canSee(idx(grid, 2, 8), idx(grid, 17, 1)) === false, 'diagonal cross-wall pair is hidden too');
  ok(field.canSee(idx(grid, 2, 2), idx(grid, 5, 8)) === true, 'cells on the same (left) side see each other');
  ok(field.canSee(idx(grid, 14, 1), idx(grid, 18, 9)) === true, 'cells on the same (right) side see each other');
  ok(field.canSee(idx(grid, 2, 2), idx(grid, 2, 2)) === true, 'a cell sees itself');

  // unwalkable / out-of-range inputs have no field rows
  const wallCell = idx(grid, 10, 5);
  ok(grid.cells[wallCell] === 0, 'wall cell is unwalkable in the nav grid');
  ok(field.canSee(wallCell, idx(grid, 2, 2)) === false, 'canSee is false when an input cell is unwalkable');
  ok(field.canSee(-1, idx(grid, 2, 2)) === false, 'canSee is false for out-of-range input');
  ok(field.rowFor(wallCell) === null, 'rowFor returns null for an unwalkable cell');
  const row = field.rowFor(idx(grid, 2, 2));
  ok(row instanceof Uint32Array && row.length === field.wordsPerRow, 'rowFor returns a wordsPerRow-sized Uint32Array for a walkable cell');
  // row bits agree with canSee
  const wb = field.walkIndex[idx(grid, 5, 8)];
  ok(((row[wb >> 5] >> (wb & 31)) & 1) === 1, 'rowFor bitset agrees with canSee');

  // cellIndexAt round-trips world coords and rejects out-of-bounds
  ok(cellIndexAt(grid, 2.5, 2.5) === idx(grid, 2, 2), 'cellIndexAt maps a world point to its raw cell index');
  ok(cellIndexAt(grid, -3, 5) === -1 && cellIndexAt(grid, 25, 5) === -1, 'cellIndexAt returns -1 out of bounds');
}

// ---- short cover blocks walking but NOT sight (visibility and walkability independent) ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 10 };
  const lowCover = { x: 10, z: 5, w: 1, d: 10, h: 1.0 }; // below SIGHT_BLOCK_HEIGHT
  const grid = gridFromRects([lowCover], bounds, 1);
  const sight = buildSightGrid(grid, [lowCover]);
  const field = buildVisibilityField(grid, sight);

  ok(lowCover.h < SIGHT_BLOCK_HEIGHT, 'test cover really is below SIGHT_BLOCK_HEIGHT');
  ok(sight.every(v => v === 0), 'short cover rasterizes no sight-blocking cells');
  ok(grid.cells[idx(grid, 10, 5)] === 0, 'short cover still blocks walking in the nav grid');
  ok(field.canSee(idx(grid, 2, 5), idx(grid, 17, 5)) === true, 'cells on opposite sides of short cover see each other');

  // same rect at sight height DOES block
  const tall = { ...lowCover, h: SIGHT_BLOCK_HEIGHT };
  const sight2 = buildSightGrid(grid, [tall]);
  const field2 = buildVisibilityField(grid, sight2);
  ok(field2.canSee(idx(grid, 2, 5), idx(grid, 17, 5)) === false, 'the same rect at h >= 1.5 blocks sight');
}

// ---- conservatism: LOS exactly clipping a blocker corner resolves VISIBLE ----
{
  const bounds = { minX: 0, maxX: 15, minZ: 0, maxZ: 15 };
  // tall block covering cells c,r in [5..9]: outer corner at world lattice point (5,5)
  const block = { x: 7.5, z: 7.5, w: 5, d: 5, h: 3 };
  const grid = gridFromRects([block], bounds, 1);
  const sight = buildSightGrid(grid, [block]);
  ok(sight[idx(grid, 5, 5)] === 1 && sight[idx(grid, 4, 5)] === 0, 'block rasterizes exactly cells [5..9]');
  const field = buildVisibilityField(grid, sight);

  // segments (4.5,5.5)->(5.5,4.5) and (3.5,6.5)->(6.5,3.5) pass exactly through corner (5,5)
  ok(field.canSee(idx(grid, 4, 5), idx(grid, 5, 4)) === true, 'adjacent grazing-corner pair resolves visible');
  ok(field.canSee(idx(grid, 3, 6), idx(grid, 6, 3)) === true, 'longer grazing-corner diagonal resolves visible');
  // sanity: a ray actually through the block is still hidden
  ok(field.canSee(idx(grid, 2, 7), idx(grid, 12, 7)) === false, 'ray through the block interior is hidden');
}

// ---- maze-sized bake: symmetry over random pairs + time budget ----
{
  const bounds = { minX: 0, maxX: 28, minZ: 0, maxZ: 28 };
  const CELL = 0.5; // 56x56 grid
  const blockers = [];
  let seed = 1234;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 12; i++) {
    blockers.push({
      x: 3 + rand() * 22, z: 3 + rand() * 22,
      w: 1 + rand() * 4, d: 1 + rand() * 4,
      h: rand() < 0.75 ? 2.5 : 1.0, // a few short covers mixed in
    });
  }
  const grid = gridFromRects(blockers, bounds, CELL);
  const walkables = [];
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === 1) walkables.push(i);
  ok(walkables.length > 2000, `maze grid has a few thousand walkables (got ${walkables.length})`);

  const sight = buildSightGrid(grid, blockers);
  const t0 = performance.now();
  const field = buildVisibilityField(grid, sight);
  const bakeMs = performance.now() - t0;
  console.log(`bake: ${grid.cols}x${grid.rows} grid, ${walkables.length} walkables, ${blockers.length} blockers -> ${bakeMs.toFixed(0)} ms`);
  ok(bakeMs < 3000, `bake stays under budget (${bakeMs.toFixed(0)} ms < 3000 ms)`);
  ok(field.walkableCount === walkables.length, 'field walkableCount matches the nav grid');

  let symChecked = 0;
  for (let i = 0; i < 500; i++) {
    const a = walkables[(rand() * walkables.length) | 0];
    const b = walkables[(rand() * walkables.length) | 0];
    if (field.canSee(a, b) !== field.canSee(b, a)) { ok(false, `symmetry violated for pair ${a},${b}`); break; }
    symChecked++;
  }
  ok(symChecked === 500, 'canSee(a,b) === canSee(b,a) over 500 random pairs');
}

// ---- lazy field: exact equivalence with the eager bake ----
{
  const bounds = { minX: 0, maxX: 24, minZ: 0, maxZ: 24 };
  const blockers = [];
  let seed = 4242;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 10; i++) {
    blockers.push({
      x: 2 + rand() * 20, z: 2 + rand() * 20,
      w: 1 + rand() * 3, d: 1 + rand() * 3,
      h: rand() < 0.7 ? 2.5 : 1.0,
    });
  }
  const grid = gridFromRects(blockers, bounds, 1); // 24x24 keeps the all-pairs sweep fast
  const sight = buildSightGrid(grid, blockers);
  const eager = buildVisibilityField(grid, sight);
  const lazy = buildLazyVisibilityField(grid, sight);

  ok(lazy.walkableCount === eager.walkableCount, 'lazy walkableCount matches eager');
  const walkables = [];
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === 1) walkables.push(i);
  let mismatches = 0;
  for (const a of walkables) for (const b of walkables) {
    if (lazy.canSee(a, b) !== eager.canSee(a, b)) mismatches++;
  }
  ok(mismatches === 0, `lazy canSee matches eager over ALL ${walkables.length * walkables.length} pairs (${mismatches} mismatches)`);

  // unwalkable / out-of-range edge behavior matches
  const wallCell = grid.cells.indexOf(0);
  ok(lazy.canSee(wallCell, walkables[0]) === false, 'lazy canSee false for unwalkable input');
  ok(lazy.canSee(-1, walkables[0]) === false && lazy.canSee(walkables[0], grid.cells.length) === false, 'lazy canSee false out of range');
  ok(lazy.rowFor(wallCell) === null && lazy.rowFor(-1) === null, 'lazy rowFor null for unwalkable/out-of-range');

  // rowFor bit-identical to the eager row, and cached rows answer canSee identically
  const probe = walkables[(walkables.length / 2) | 0];
  const lRow = lazy.rowFor(probe), eRow = eager.rowFor(probe);
  let rowDiff = 0;
  for (let w = 0; w < eager.wordsPerRow; w++) if (lRow[w] !== eRow[w]) rowDiff++;
  ok(rowDiff === 0, 'lazy rowFor is bit-identical to the eager row');
  let cachedMismatch = 0;
  for (const b of walkables) if (lazy.canSee(probe, b) !== eager.canSee(probe, b) || lazy.canSee(b, probe) !== eager.canSee(b, probe)) cachedMismatch++;
  ok(cachedMismatch === 0, 'canSee via the cached row still matches eager both argument orders');

  // FIFO cap: exceeding rowCacheCap evicts without changing answers
  const capped = buildLazyVisibilityField(grid, sight, { rowCacheCap: 2 });
  capped.rowFor(walkables[0]); capped.rowFor(walkables[1]); capped.rowFor(walkables[2]);
  let cappedMismatch = 0;
  for (let i = 0; i < 200; i++) {
    const a = walkables[(rand() * walkables.length) | 0];
    const b = walkables[(rand() * walkables.length) | 0];
    if (capped.canSee(a, b) !== eager.canSee(a, b)) cappedMismatch++;
  }
  ok(cappedMismatch === 0, 'capped row cache never changes canSee answers');

  // pair memo: repeated queries (incl. reversed order) stay consistent with the eager bake
  const memoField = buildLazyVisibilityField(grid, sight);
  let memoMismatch = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const a of walkables) for (const b of walkables) {
      if (memoField.canSee(a, b) !== eager.canSee(a, b)) memoMismatch++;
      if (memoField.canSee(b, a) !== eager.canSee(a, b)) memoMismatch++;
    }
  }
  ok(memoMismatch === 0, `pair memo stays exact over 3 repeat passes in both orders (${memoMismatch} mismatches)`);

  // lazy construction is effectively instant (no quadratic bake)
  const t0 = performance.now();
  buildLazyVisibilityField(grid, sight);
  ok(performance.now() - t0 < 50, 'lazy field construction does no quadratic work');
}

// ---- terrain occlusion: a ridge hides what a wall would, a dip hides nothing ----
{
  const bounds = { minX: 0, maxX: 40, minZ: 0, maxZ: 20 };
  const grid = buildNavGrid(() => true, bounds, 1);   // no rects at all: only ground can block
  const sight = buildSightGrid(grid, []);
  const ridgeAt = (x) => (Math.abs(x - 20) < 1.5 ? 4 : 0);
  const heights = buildHeightGrid(grid, (x) => ridgeAt(x));
  const terrain = { heights };

  ok(heights.length === grid.cols * grid.rows, 'height grid covers every cell');
  ok(heights[10 * grid.cols + 20] === 4, 'height grid samples cell centers');

  const flat = buildVisibilityField(grid, sight);
  const ridge = buildVisibilityField(grid, sight, { terrain });
  const west = idx(grid, 5, 10), east = idx(grid, 35, 10), crest = idx(grid, 20, 10);
  ok(flat.canSee(west, east) === true, 'without terrain the same pair is visible (control)');
  ok(ridge.canSee(west, east) === false, 'a 4 m ridge between two ground-level cells blocks sight');
  ok(ridge.canSee(west, idx(grid, 15, 10)) === true, 'cells on the same side of the ridge still see each other');
  ok(ridge.canSee(crest, west) === true && ridge.canSee(crest, east) === true, 'standing on the crest sees both sides');

  // A depression is below the sight line, so it must not occlude.
  const dip = buildVisibilityField(grid, sight, { terrain: { heights: buildHeightGrid(grid, (x) => (Math.abs(x - 20) < 1.5 ? -4 : 0)) } });
  ok(dip.canSee(west, east) === true, 'a dip between the pair does not block sight');

  // A rise smaller than the eye height + margin must not block either (errs visible).
  const bump = buildVisibilityField(grid, sight, { terrain: { heights: buildHeightGrid(grid, (x) => (Math.abs(x - 20) < 1.5 ? 1.2 : 0)) } });
  ok(bump.canSee(west, east) === true, 'a 1.2 m bump stays under the 1.6 m eye line');

  // Lazy and eager fields must agree cell-for-cell with terrain in play.
  const lazy = buildLazyVisibilityField(grid, sight, { terrain });
  let mismatch = 0;
  for (let c = 0; c < grid.cols; c += 3) {
    for (let c2 = 0; c2 < grid.cols; c2 += 3) {
      const a = idx(grid, c, 10), b = idx(grid, c2, 4);
      if (lazy.canSee(a, b) !== ridge.canSee(a, b)) mismatch++;
    }
  }
  ok(mismatch === 0, `lazy field matches the eager bake with terrain (${mismatch} mismatches)`);
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('nav-visibility: all assertions passed');
