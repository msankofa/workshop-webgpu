// Node test for layout-interchange.js -- the pcw-layout schema shared by bot-viewer-v2 and
// shoot-house.js. No framework: `node test-layout-interchange.mjs`.
import {
  LAYOUT_FORMAT, LAYOUT_VERSION, createLayout, validateLayout,
  toShootHouseLayout, fromShootHouseLayout, sightRectsFor,
} from './layout-interchange.js';
import { buildNavGrid } from './nav-grid.js';
import { buildSightGrid } from './nav-visibility.js';
import { generateDemoRoom } from './shoot-house-layout.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m);

// A harness world in bot-viewer-v2's own shape (walls have no per-rect h; WALL_H is a global).
const WALL_H = 3, WALL_T = 0.3;
const harness = {
  name: 'rooms',
  wallHeight: WALL_H,
  walls: [
    { x: 0, z: -3, w: 6 + WALL_T, d: WALL_T },
    { x: 0, z: 3, w: 6 + WALL_T, d: WALL_T },
    { x: -3, z: 0, w: WALL_T, d: 6 + WALL_T },
    { x: 3, z: -1.75, w: WALL_T, d: 2.5 },
    { x: 3, z: 2.375, w: WALL_T, d: 1.25 },
    { x: 6, z: -3, w: 6 + WALL_T, d: WALL_T },
    { x: 6, z: 3, w: 6 + WALL_T, d: WALL_T },
    { x: 9, z: 0, w: WALL_T, d: 6 + WALL_T },
  ],
  covers: [
    { x: 1.2, z: -1.4, w: 0.9, d: 0.9, h: 1.1 },
    { x: 6.6, z: 1.1, w: 1.2, d: 0.6, h: 1.4 },
    { x: 4.5, z: 0, w: 1.2, d: 1.2, h: 2 },   // over SIGHT_BLOCK_HEIGHT, so the sight bake is non-empty
  ],
  bounds: { minX: -3, maxX: 9, minZ: -3, maxZ: 3 },
  botSpawn: { x: 6, y: 0, z: 0 },
  dummySpawn: { x: 0, y: 0, z: 0 },
  patrolPoints: [{ x: 7, z: -1.5 }, { x: 7, z: 1.5 }, { x: 0, z: 1.5 }, { x: 0, z: -1.5 }],
};

// ---- schema + validation ---------------------------------------------------
const doc = createLayout(harness);
ok(doc.format === LAYOUT_FORMAT && doc.version === LAYOUT_VERSION, 'createLayout stamps format + version');
ok(doc.walls.every((w) => w.kind === 'wall' && w.h === WALL_H && w.y === 0), 'walls get the global wall height per rect, base y 0');
ok(doc.covers.every((c) => c.kind === 'cover'), 'covers default to kind "cover"');
eq(doc.bounds, { minX: -3, maxX: 9, minZ: -3, maxZ: 3, yMin: 0, yMax: 3 }, 'bounds gain derived yMin/yMax');
ok(doc.terrain === null, 'terrain field is present and null in v1 (reserved)');
ok(doc.spawns.length === 6, 'bot + dummy + 4 patrol points become 6 spawns');
eq(doc.spawns.map((s) => s.role), ['bot', 'dummy', 'patrol', 'patrol', 'patrol', 'patrol'], 'spawn roles map from the harness slots');
ok(doc.spawns.every((s) => Number.isFinite(s.y)), 'patrol points without y default to y 0');
ok(!('materials' in doc) && !('lights' in doc) && !('theme' in doc), 'document carries no visual dressing');

const v = validateLayout(doc);
ok(v.ok && v.errors.length === 0, 'a created layout validates clean');
ok(v.warnings.length === 0, 'and raises no warnings');
ok(!validateLayout(null).ok, 'null fails validation');
ok(!validateLayout({ ...doc, version: 99 }).ok, 'an unknown version fails validation');
ok(!validateLayout({ ...doc, format: 'nope' }).ok, 'a wrong format fails validation');
ok(!validateLayout({ ...doc, bounds: { ...doc.bounds, maxX: -3 } }).ok, 'a degenerate footprint fails validation');
ok(!validateLayout({ ...doc, walls: [{ x: 0, z: 0, w: 0, d: 1, h: 1, y: 0 }] }).ok, 'a zero-extent rect fails validation');
ok(!validateLayout({ ...doc, walls: [{ x: NaN, z: 0, w: 1, d: 1, h: 1, y: 0 }] }).ok, 'a non-finite field fails validation');
ok(!validateLayout({ ...doc, terrain: 4 }).ok, 'a non-object terrain fails validation');
ok(validateLayout({ ...doc, covers: [{ kind: 'cover', x: 500, z: 500, w: 1, d: 1, h: 1, y: 0 }] }).warnings.length === 1,
  'a rect outside bounds warns but still validates');

// ---- walls / covers -> primitives ------------------------------------------
const sh = toShootHouseLayout(doc);
ok(sh.primitives.length === harness.walls.length + harness.covers.length, 'every rect becomes exactly one primitive');
const wallPrim = sh.primitives[0];
eq(wallPrim, { kind: 'wall', cx: 0, cy: 1.5, cz: -3, sx: 6.3, sy: 3, sz: 0.3, material: 'wall' },
  'wall rect -> centred prim: cy = h/2, sx/sz = w/d, sy = wall height');
const coverPrim = sh.primitives[harness.walls.length + 1];
eq(coverPrim, { kind: 'cover', cx: 6.6, cy: 0.7, cz: 1.1, sx: 1.2, sy: 1.4, sz: 0.6, material: 'trim' },
  'cover rect -> prim keeping its own height');
ok(sh.primitives.slice(0, 8).every((p) => p.material === 'wall'), 'walls bucket to the wall material');
ok(sh.primitives.slice(8).every((p) => p.material === 'trim'), 'covers bucket to the trim material');
eq(sh.lights, [], 'the descriptor carries no lights (app-side in v1)');
eq(sh.spawn, { x: 6, y: 0, z: 0, heading: Math.PI }, 'the single shoot-house spawn resolves to the bot spawn');
ok(sh.spawns.length === 6, 'the full spawn list rides along for consumers that want it');
eq(sh.bounds, doc.bounds, 'bounds pass through unchanged');
eq(toShootHouseLayout(doc, { materials: { wall: 'panel', cover: 'neon' } }).primitives.map((p) => p.material),
  [...Array(8).fill('panel'), ...Array(3).fill('neon')], 'material keys are a caller option, not schema');

// ---- round trip ------------------------------------------------------------
eq(fromShootHouseLayout(sh), doc, 'doc -> shoot-house -> doc is lossless for harness content');
eq(toShootHouseLayout(fromShootHouseLayout(sh)), sh, 'and the descriptor is stable across a second pass');
eq(createLayout(doc), doc, 'createLayout is idempotent on its own output');

// ---- non-flat: a rect with base y != 0 --------------------------------------
const raised = createLayout({
  ...harness,
  covers: [...harness.covers, { x: -1.5, z: 0.75, w: 2, d: 1.5, h: 1.2, y: 0.8 }],
  bounds: { minX: -3, maxX: 9, minZ: -3, maxZ: 3 },
});
const raisedRect = raised.covers.at(-1);
ok(raisedRect.y === 0.8 && raisedRect.h === 1.2, 'a raised cover keeps its base y and its own height');
ok(raised.bounds.yMax === 3, 'derived yMax spans the tallest rect top');
const raisedPrim = toShootHouseLayout(raised).primitives.at(-1);
ok(raisedPrim.cy === 1.4 && raisedPrim.sy === 1.2, 'base y threads into the prim centre (cy = y + h/2), not dropped to the floor');
eq(fromShootHouseLayout(toShootHouseLayout(raised)), raised, 'a non-flat layout round-trips exactly');
ok(sightRectsFor(raised).at(-1).h === 2, 'sight rects report the box TOP (y + h), so a lifted rect reads at its real height');

// a floor rect deeper than the surface: negative base y must survive too
const sunken = createLayout({ ...harness, covers: [{ x: 0, z: 0, w: 4, d: 4, h: 1.6, y: -0.4 }] });
ok(sunken.bounds.yMin === -0.4, 'a rect below y=0 lowers the derived yMin');
eq(fromShootHouseLayout(toShootHouseLayout(sunken)), sunken, 'a sunken rect round-trips exactly');

// ---- untagged / foreign kinds classify geometrically ------------------------
const demo = generateDemoRoom();
const imported = fromShootHouseLayout(demo, { name: 'demo' });
ok(validateLayout(imported).ok, 'a real shoot-house generator layout imports and validates');
ok(imported.covers.length > 0, 'its solid boxes become covers');
ok(!imported.covers.some((c) => ['sign', 'neon', 'grid'].includes(c.kind)), 'decor kinds are dropped');
const floorSlab = demo.primitives.find((p) => p.cy + p.sy / 2 <= 0.05);
ok(floorSlab !== undefined, '(the demo room has a floor slab to reject)');
ok(!imported.covers.some((c) => c.y + c.h <= 0.05), 'the floor slab is dropped (nothing sight-blocking about it)');
ok(!imported.covers.some((c) => c.y >= 1.5), 'boxes sitting entirely above eye height are dropped');
ok(imported.covers.some((c) => c.kind !== 'cover'), 'surviving foreign kinds keep their tag');
eq(fromShootHouseLayout(toShootHouseLayout(imported)), imported, 'the imported subset then round-trips exactly');
eq(toShootHouseLayout(imported).spawn,
  { x: demo.spawn.x, y: demo.spawn.y, z: demo.spawn.z, heading: demo.spawn.heading },
  'the generator spawn survives as a player-role spawn');

// ---- bake equivalence: nav + sight grids are identical either way ------------
const NAV_CELL = 0.5, WALL_MARGIN = 0.55;
function walkableTest(layout) {
  const rects = [...layout.walls, ...layout.covers];
  const b = layout.bounds;
  return (x, z) => {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
    for (const r of rects) {
      if (Math.abs(x - r.x) <= r.w / 2 + WALL_MARGIN && Math.abs(z - r.z) <= r.d / 2 + WALL_MARGIN) return false;
    }
    return true;
  };
}
function bake(layout) {
  const grid = buildNavGrid(walkableTest(layout), layout.bounds, NAV_CELL);
  return { grid, sight: buildSightGrid(grid, sightRectsFor(layout)) };
}
for (const [label, original] of [['rooms', doc], ['non-flat', raised], ['demo-room', imported]]) {
  const a = bake(original);
  const b = bake(fromShootHouseLayout(toShootHouseLayout(original)));
  ok(a.grid.cols === b.grid.cols && a.grid.rows === b.grid.rows, `${label}: nav grid dims match after a round trip`);
  eq(Array.from(a.grid.cells), Array.from(b.grid.cells), `${label}: nav grid cells are identical after a round trip`);
  eq(Array.from(a.sight), Array.from(b.sight), `${label}: sight grid is identical after a round trip`);
  ok(a.grid.cells.some((c) => c === 1) && a.sight.some((c) => c === 1), `${label}: (the bake is non-trivial)`);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
