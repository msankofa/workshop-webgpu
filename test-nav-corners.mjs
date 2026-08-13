// Node tests for nav-corners.js (baked corner/cover-anchor map).
// Run: node test-nav-corners.mjs
import { buildNavGrid } from './nav-grid.js';
import { buildSightGrid, buildVisibilityField, buildLazyVisibilityField, buildHeightGrid } from './nav-visibility.js';
import { buildCornerMap, updateCornerMapInBounds, ANCHOR_INSET, ANCHOR_OFFACE, PEEK_PAST } from './nav-corners.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// Rects are bot-viewer format: {x,z,w,d,h} center + full extents; missing h = full-height wall.
function inRect(rect, x, z) {
  return Math.abs(x - rect.x) <= rect.w / 2 && Math.abs(z - rect.z) <= rect.d / 2;
}
function bake(rects, bounds, cellSize) {
  const grid = buildNavGrid((x, z) => !rects.some(rc => inRect(rc, x, z)), bounds, cellSize);
  const sight = buildSightGrid(grid, rects);
  const field = buildVisibilityField(grid, sight);
  return { grid, field, map: buildCornerMap(grid, rects, field) };
}
function idx(grid, c, r) { return r * grid.cols + c; }
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// shared sanity checks for every emitted record, incl. the mandated anchor<->peek cross-check
function checkRecords(grid, field, records, label) {
  for (const rec of records) {
    ok(grid.cells[rec.anchorCell] === 1, `${label}: anchor cell walkable`);
    ok(grid.cells[rec.peekCell] === 1, `${label}: peek cell walkable`);
    ok(field.canSee(rec.anchorCell, rec.peekCell), `${label}: anchor<->peek canSee cross-check`);
    ok(near(Math.hypot(rec.peekDir.x, rec.peekDir.z), 1), `${label}: peekDir is unit length`);
    ok(near(Math.hypot(rec.wallDirA.x, rec.wallDirA.z), 1) && near(Math.hypot(rec.wallDirB.x, rec.wallDirB.z), 1), `${label}: wall dirs unit length`);
    ok(rec.claimedBy === null, `${label}: claimedBy starts null`);
  }
}

// ---- lone tall rect in an open grid: 4 corners x 2 faces = 8 records, sane geometry ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };
  const rect = { x: 10, z: 10, w: 4, d: 4, h: 2 };
  const { grid, field, map } = bake([rect], bounds, 1);
  console.log(`lone rect: ${map.corners.length} records`);
  ok(map.corners.length === 8, `lone tall rect yields 8 anchor records (got ${map.corners.length})`);
  checkRecords(grid, field, map.corners, 'lone rect');
  for (const rec of map.corners) {
    const d = Math.hypot(rec.anchorPos.x - rec.corner.x, rec.anchorPos.z - rec.corner.z);
    ok(d <= 1.5, `lone rect: anchor within 1.5m of its corner (got ${d.toFixed(2)})`);
    ok(near(d, Math.hypot(ANCHOR_INSET, ANCHOR_OFFACE)), 'lone rect: open-grid anchor needed no snap');
    ok(!inRect(rect, rec.anchorPos.x, rec.anchorPos.z), 'lone rect: anchorPos not inside the rect');
    ok(!inRect(rect, rec.peekPos.x, rec.peekPos.z), 'lone rect: peekPos not inside the rect');
    const lat = Math.hypot(rec.peekPos.x - rec.anchorPos.x, rec.peekPos.z - rec.anchorPos.z);
    ok(near(lat, ANCHOR_INSET + PEEK_PAST), 'lone rect: peek is the lateral slide past the corner');
  }
}

// ---- two abutting rects forming a longer wall: shared/buried seam corners culled ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };
  const rects = [
    { x: 8, z: 10, w: 4, d: 1, h: 3 },   // x in [6,10]
    { x: 12, z: 10, w: 4, d: 1, h: 3 },  // x in [10,14], abuts at x=10
  ];
  const { grid, field, map } = bake(rects, bounds, 1);
  console.log(`abutting wall: ${map.corners.length} records`);
  ok(map.corners.every(rec => !near(rec.corner.x, 10)), 'abutting wall: seam corners at x=10 are culled');
  // up to 2 faces per outer corner; some face records die to the snap cross-check on a 1m-deep wall
  const cornerKeys = new Set(map.corners.map(rec => `${rec.corner.x},${rec.corner.z}`));
  ok(cornerKeys.size === 4, `abutting wall keeps exactly the 4 outer corners (got ${cornerKeys.size})`);
  ok(map.corners.length >= 4 && map.corners.length <= 8, `abutting wall record count in [4,8] (got ${map.corners.length})`);
  checkRecords(grid, field, map.corners, 'abutting wall');
}

// ---- short rect (h < SIGHT_BLOCK_HEIGHT): no corners at all ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };
  const { map } = bake([{ x: 10, z: 10, w: 4, d: 4, h: 1.0 }], bounds, 1);
  console.log(`short rect: ${map.corners.length} records`);
  ok(map.corners.length === 0, `short cover yields zero corner records (got ${map.corners.length})`);
}

// ---- hand-built L-wall: a corner record actually works as cover vs a threat ----
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };
  const rects = [
    { x: 10, z: 8, w: 1, d: 8, h: 3 },     // vertical arm, x in [9.5,10.5], z in [4,12]
    { x: 13.5, z: 11.5, w: 6, d: 1, h: 3 }, // horizontal arm, x in [10.5,16.5], z in [11,12]
  ];
  const { grid, field, map } = bake(rects, bounds, 1);
  console.log(`L-wall: ${map.corners.length} records`);
  checkRecords(grid, field, map.corners, 'L-wall');
  ok(map.corners.every(rec => !(near(rec.corner.x, 10.5) && (near(rec.corner.z, 11) || near(rec.corner.z, 12)))), 'L-wall: buried junction corners culled');
  ok(map.corners.some(rec => near(rec.corner.x, 9.5) && near(rec.corner.z, 12)), 'L-wall: outer junction corner survives');

  // threat east of the vertical arm; mirror threat on the west side
  const threat = idx(grid, 13, 7);
  const mirror = idx(grid, 4, 7);
  const validVs = t => map.corners.filter(rec => !field.canSee(t, rec.anchorCell) && field.canSee(t, rec.peekCell));
  const valid = validVs(threat);
  ok(valid.length > 0, 'L-wall: at least one record is valid cover vs the east threat');

  // the bottom-of-wall record (corner 10.5,4 peeking east) is that cover, and the mirror threat breaks it
  const rec = map.corners.find(r => near(r.corner.x, 10.5) && near(r.corner.z, 4) && near(r.peekDir.x, 1));
  ok(!!rec, 'L-wall: bottom-corner east-peek record exists');
  if (rec) {
    ok(!field.canSee(threat, rec.anchorCell), 'L-wall: east threat cannot see the anchor');
    ok(field.canSee(threat, rec.peekCell), 'L-wall: east threat IS visible from the peek');
    ok(!(!field.canSee(mirror, rec.anchorCell) && field.canSee(mirror, rec.peekCell)), 'L-wall: mirror-side threat invalidates that same record');
    ok(field.canSee(mirror, rec.anchorCell), 'L-wall: mirror threat sees the anchor directly');
  }
}

// ---- terrain crests: dead ground behind a brow is cover, and it must prove it ----
{
  const bounds = { minX: 0, maxX: 40, minZ: 0, maxZ: 16 };
  // Flat approach, a 4 m ramp from x=18 to x=22, then a high plateau: classic reverse slope.
  const ground = (x) => (x < 18 ? 0 : x > 22 ? 5 : ((x - 18) / 4) * 5);
  const grid = buildNavGrid(() => true, bounds, 1);
  const heights = buildHeightGrid(grid, (x) => ground(x));
  const sight = buildSightGrid(grid, []);
  const field = buildVisibilityField(grid, sight, { terrain: { heights } });
  const map = buildCornerMap(grid, [], field, { heights });
  console.log(`reverse slope: ${map.corners.length} crest records`);

  ok(map.corners.length > 0, 'a reverse slope emits crest cover records');
  ok(map.corners.every(rec => rec.kind === 'crest'), 'with no rects, every record is a crest');
  for (const rec of map.corners) {
    // the contract every cover record owes the FSM, re-derived from the field itself
    ok(field.canSee(rec.anchorCell, rec.peekCell), 'crest: the bot can see its own peek point');
    ok(grid.cells[rec.anchorCell] === 1 && grid.cells[rec.peekCell] === 1, 'crest: both cells are walkable');
    const anchorH = heights[rec.anchorCell], peekH = heights[rec.peekCell];
    ok(peekH > anchorH, 'crest: the peek point stands above the anchor');
  }
  // The point of the whole exercise: a threat up on the plateau cannot see the anchor.
  const uphill = idx(grid, 34, 8);
  const facing = map.corners.filter(rec => rec.peekDir.x === 1 && rec.anchorPos.z > 7 && rec.anchorPos.z < 9);
  ok(facing.length > 0, 'crest: at least one record faces the uphill threat');
  for (const rec of facing) {
    ok(!field.canSee(uphill, rec.anchorCell), 'crest: plateau threat cannot see the anchor');
    ok(field.canSee(uphill, rec.peekCell), 'crest: plateau threat IS visible from the brow');
  }

  // Flat ground has no crests; wall records still come through unchanged alongside them.
  const flatHeights = buildHeightGrid(grid, () => 3);
  const flatField = buildVisibilityField(grid, sight, { terrain: { heights: flatHeights } });
  ok(buildCornerMap(grid, [], flatField, { heights: flatHeights }).corners.length === 0, 'flat ground emits no crest records');
  ok(buildCornerMap(grid, [], field).corners.length === 0, 'omitting heights disables crest baking entirely');

  // The record cap is a hard ceiling, not a suggestion.
  const capped = buildCornerMap(grid, [], field, { heights, crest: { maxRecords: 3 } });
  ok(capped.corners.length <= 3, 'crest: maxRecords caps the bake');
}

// Coarse grid: the authored sub-metre offsets quantize anchor and peek onto ONE cell, which is a
// record with no lean in it. Scaling the offsets with the cell is what brings the corners back --
// environment-viewer-v2's 1.5 m terrain zone bake depends on exactly this.
{
  const cellSize = 1.5;
  const bounds = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };
  const rects = [{ x: 0, z: 0, w: 4, d: 4, h: 3 }];
  const grid = buildNavGrid((x, z) => !rects.some(rc => inRect(rc, x, z)), bounds, cellSize);
  const field = buildVisibilityField(grid, buildSightGrid(grid, rects));
  const tight = buildCornerMap(grid, rects, field);
  const scaled = buildCornerMap(grid, rects, field,
    { inset: cellSize * 0.6, offFace: cellSize * 0.5, peekPast: cellSize * 1.2 });
  const lean = map => map.corners.reduce((s, rec) =>
    s + Math.hypot(rec.peekPos.x - rec.anchorPos.x, rec.peekPos.z - rec.anchorPos.z), 0) / Math.max(1, map.corners.length);
  ok(scaled.corners.length >= tight.corners.length,
    `coarse grid: scaling offsets never loses corners (${tight.corners.length} -> ${scaled.corners.length})`);
  ok(lean(scaled) > lean(tight),
    `coarse grid: cell-scaled offsets give a real lean (${lean(tight).toFixed(2)} m -> ${lean(scaled).toFixed(2)} m)`);
  for (const map of [tight, scaled]) {
    ok(map.corners.every(rec => rec.anchorCell !== rec.peekCell),
      'no record has its anchor and peek quantized onto the same cell');
  }
}

// ---- footprint-local update vs a full rebake ----
// updateCornerMapInBounds exists so a wall coming down mid-fight does not pay for a whole-map corner
// bake. The claim it must earn is that its result EQUALS a full rebake for wall records. The crest
// half is scan-order dependent by construction, so it is measured and bounded, not asserted equal.
// Lazy field throughout: the eager bake is quadratic and this block bakes ~20 maps.
{
  const key = rec => [rec.kind, rec.corner.x.toFixed(4), rec.corner.z.toFixed(4),
    rec.anchorCell, rec.peekCell, rec.peekDir.x, rec.peekDir.z].join('|');
  const setOf = recs => new Set(recs.map(key));
  const diff = (a, b) => [...a].filter(k => !b.has(k));
  const footprint = r => ({ minX: r.x - r.w / 2, maxX: r.x + r.w / 2, minZ: r.z - r.d / 2, maxZ: r.z + r.d / 2 });

  const cellSize = 0.5;
  const bounds = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };
  const base = [];
  for (let i = -2; i <= 2; i++) {
    base.push({ x: i * 5, z: 0, w: 0.3, d: 9, h: 3 });   // vertical fins
    base.push({ x: 0, z: i * 5, w: 9, d: 0.3, h: 3 });   // horizontal fins
  }
  const rebake = (rects, heights = null, opts = {}) => {
    const grid = buildNavGrid((x, z) => !rects.some(rc => inRect(rc, x, z)), bounds, cellSize);
    const field = buildLazyVisibilityField(grid, buildSightGrid(grid, rects),
      heights ? { terrain: { heights } } : {});
    return { grid, field, map: buildCornerMap(grid, rects, field, { heights, ...opts }) };
  };

  // Every single-wall removal, compared against the full rebake of the same post-change world.
  let mismatches = 0;
  for (let victim = 0; victim < base.length; victim++) {
    const before = rebake(base);
    const after = base.filter((_, i) => i !== victim);
    const full = rebake(after);
    // The local update runs against the POST-change grid and field, exactly as the viewer will:
    // nav and the sight grid are patched first, corners last.
    const local = updateCornerMapInBounds(before.map, full.grid, after, full.field, footprint(base[victim]));
    const a = setOf(full.map.corners), b = setOf(local.corners);
    const missing = diff(a, b), extra = diff(b, a);
    if (missing.length || extra.length) {
      mismatches++;
      if (mismatches === 1) console.error(`  first mismatch removing rect ${victim}: ${missing.length} missing, ${extra.length} extra`);
    }
  }
  ok(mismatches === 0, `local corner update equals a full rebake over all ${base.length} single-wall removals`);

  // Shortening a wall below sight height must delete its corners the same way removing it does.
  {
    const victim = 4;
    const before = rebake(base);
    const after = base.map((r, i) => (i === victim ? { ...r, h: 1.2 } : r));
    const full = rebake(after);
    const local = updateCornerMapInBounds(before.map, full.grid, after, full.field, footprint(base[victim]));
    ok(diff(setOf(full.map.corners), setOf(local.corners)).length === 0
      && diff(setOf(local.corners), setOf(full.map.corners)).length === 0,
      'local corner update equals a full rebake when a wall is shortened below sight height');
  }

  // Splitting one wall into two halves with a gap -- the shape a breach takes.
  {
    const victim = 0, g = base[victim];
    const before = rebake(base);
    const after = base.filter((_, i) => i !== victim).concat([
      { ...g, z: g.z - g.d / 4 - 1, d: g.d / 2 - 2 },
      { ...g, z: g.z + g.d / 4 + 1, d: g.d / 2 - 2 },
    ]);
    const full = rebake(after);
    const local = updateCornerMapInBounds(before.map, full.grid, after, full.field, footprint(g));
    ok(diff(setOf(full.map.corners), setOf(local.corners)).length === 0
      && diff(setOf(local.corners), setOf(full.map.corners)).length === 0,
      'local corner update equals a full rebake when a wall is split in two');
    const keys = local.corners.map(key);
    ok(new Set(keys).size === keys.length, 'local corner update emits no duplicate records');
  }

  // With terrain, wall records must still be exact; the crest half is only bounded. The ground is
  // the same reverse slope the crest tests above use (flat, 4 m ramp, plateau), which is a shape
  // known to emit crests -- a gentle sine emits none, and a bound over zero records proves nothing.
  {
    const tBounds = { minX: 0, maxX: 40, minZ: 0, maxZ: 24 };
    const tCell = 1;
    const ground = (x) => (x < 18 ? 0 : x > 22 ? 5 : ((x - 18) / 4) * 5);
    const fins = [
      { x: 8, z: 12, w: 1, d: 9, h: 3 },
      { x: 30, z: 6, w: 1, d: 9, h: 3 },
      { x: 30, z: 18, w: 9, d: 1, h: 3 },
    ];
    const tBake = (rects, heights) => {
      const grid = buildNavGrid((x, z) => !rects.some(rc => inRect(rc, x, z)), tBounds, tCell);
      const field = buildLazyVisibilityField(grid, buildSightGrid(grid, rects), { terrain: { heights } });
      return { grid, field, map: buildCornerMap(grid, rects, field, { heights }) };
    };
    const gridH = buildNavGrid(() => true, tBounds, tCell);
    const heights = buildHeightGrid(gridH, (x) => ground(x));
    const before = tBake(fins, heights);
    const after = fins.slice(1);
    const full = tBake(after, heights);
    const local = updateCornerMapInBounds(before.map, full.grid, after, full.field, footprint(fins[0]), { heights });

    const fw = setOf(full.map.corners.filter(r => r.kind === 'wall'));
    const lw = setOf(local.corners.filter(r => r.kind === 'wall'));
    ok(diff(fw, lw).length === 0 && diff(lw, fw).length === 0,
      'with terrain present, wall records still match a full rebake exactly');

    const fc = full.map.corners.filter(r => r.kind === 'crest').length;
    const lc = local.corners.filter(r => r.kind === 'crest').length;
    ok(fc > 0, `the crest comparison actually has crests to compare (${fc})`);
    console.log(`  crest drift: full bake ${fc}, local update ${lc} (${local.crestExact ? 'untouched' : 'rescanned'})`);
    ok(Math.abs(fc - lc) <= Math.max(2, Math.round(fc * 0.1)),
      `crest count after a local update stays within 10% of a full bake (${fc} vs ${lc})`);
  }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('nav-corners: all assertions passed');
