// node test-map-surfaces.mjs
import assert from 'node:assert';
import { createSurfaceQuery, surfaceDecks, SURFACE_DEFAULTS } from './map-surfaces.js';
import { buildNavGrid, keyAt, keyIsLevel, keyHeight, keyWalkable, keyToWorld, findPath } from './nav-grid.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const UP = [0, 1, 0], DOWN_N = [0, -1, 0], WALL = [1, 0, 0];

// A fake world: columnFn(x, z) returns surfaces as [y, normal], any order. The fake sorts them
// top-down and converts to hit records, which is exactly what a downward BVH raycast produces.
function worldOf(columnFn, startY = 51) {
  return (origin, _dir, _maxDistance, out = []) => {
    out.length = 0;
    const cols = columnFn(origin[0], origin[2]) || [];
    for (const [y, normal] of [...cols].sort((a, b) => b[0] - a[0])) {
      out.push({ distance: startY - y, point: [origin[0], y, origin[2]], normal });
    }
    return out;
  };
}

const flat = (y = 0) => createSurfaceQuery({
  raycastAll: worldOf(() => [[y, UP]]), worldYMax: 50,
});

// ── single-surface behaviour matches what heightAt would have said ──────────────────────────
test('flat ground reports one surface, open to the sky', () => {
  const q = flat(0);
  const s = q.surfacesAt(0, 0);
  assert.equal(s.length, 1);
  assert.equal(s[0].y, 0);
  assert.equal(s[0].openSky, true);
  assert.equal(s[0].headroom, Infinity);
});

// ── the case heightAt gets wrong ────────────────────────────────────────────────────────────
// A cave: roof top at 20, roof underside at 18, floor at 10. deriveTopSurfaceHeights would keep
// only y=20 and every placement would land on the roof.
const caveWorld = createSurfaceQuery({
  raycastAll: worldOf(() => [[20, UP], [18, DOWN_N], [10, UP]]), worldYMax: 50,
});

test('a cave column reports both floors, not just the roof', () => {
  const s = caveWorld.surfacesAt(0, 0);
  assert.equal(s.length, 2, 'roof top and cave floor');
  assert.equal(s[0].y, 20);
  assert.equal(s[1].y, 10);
});

test('the roof is open sky; the cave floor is not', () => {
  const [roof, floor] = caveWorld.surfacesAt(0, 0);
  assert.equal(roof.openSky, true);
  assert.equal(floor.openSky, false);
  assert.equal(floor.ceilingY, 18);
});

test('cave headroom is measured to the ceiling, not to the roof top', () => {
  const floor = caveWorld.surfacesAt(0, 0)[1];
  assert.equal(floor.headroom, 8);   // 18 - 10, NOT 20 - 10
});

test('a down-facing ceiling is never offered as a floor', () => {
  const s = caveWorld.surfacesAt(0, 0);
  assert.ok(s.every((x) => x.normalY >= SURFACE_DEFAULTS.slopeLimitY));
});

test('a low overhang is filtered out by needHeadroom', () => {
  // floor at 10 with a ceiling at 11.5: 1.5 m of headroom, less than a standing bot.
  const q = createSurfaceQuery({
    raycastAll: worldOf(() => [[13, UP], [11.5, DOWN_N], [10, UP]]), worldYMax: 50,
  });
  assert.equal(q.surfacesAt(0, 0).length, 2);
  assert.equal(q.surfaceNear(0, 0, 10)?.y, undefined, 'the cramped floor is not standable');
  assert.equal(q.surfaceNear(0, 0)?.y, 13, 'the open roof still is');
});

test('a vertical wall face is not a floor', () => {
  const q = createSurfaceQuery({ raycastAll: worldOf(() => [[5, WALL], [0, UP]]), worldYMax: 50 });
  const s = q.surfacesAt(0, 0);
  assert.equal(s.length, 1);
  assert.equal(s[0].y, 0);
});

test('coplanar duplicate hits collapse to one surface', () => {
  // A shared triangle edge reports the same plane twice; left alone the second copy would read as
  // a ceiling 0 m above the first and reject every site on flat ground.
  const q = createSurfaceQuery({ raycastAll: worldOf(() => [[7, UP], [7, UP]]), worldYMax: 50 });
  const s = q.surfacesAt(0, 0);
  assert.equal(s.length, 1);
  assert.equal(s[0].headroom, Infinity);
});

// ── footprints ──────────────────────────────────────────────────────────────────────────────
test('a footprint on flat ground seats at grade with no skirt', () => {
  const fit = flat(4).footprintAt(0, 0, 8, 8);
  assert.equal(fit.ok, true);
  assert.equal(fit.floorY, 4);
  assert.equal(fit.skirtDepth, 0);
  assert.equal(fit.openSky, true);
});

test('a footprint on a slope seats at the high corner and skirts down to the low one', () => {
  // ground rises 0.1 m per metre of x, so an 8 m footprint spans 0.8 m.
  const q = createSurfaceQuery({ raycastAll: worldOf((x) => [[x * 0.1, UP]]), worldYMax: 50 });
  const fit = q.footprintAt(0, 0, 8, 8);
  assert.equal(fit.ok, true);
  assert.ok(Math.abs(fit.floorY - 0.4) < 1e-9, 'seated at the highest sample');
  assert.ok(Math.abs(fit.skirtDepth - 0.8) < 1e-9, 'foundation covers the full drop');
});

test('too-steep ground is rejected rather than seated', () => {
  const q = createSurfaceQuery({ raycastAll: worldOf((x) => [[x * 2, UP]]), worldYMax: 50 });
  const fit = q.footprintAt(0, 0, 8, 8);
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'too-uneven');
});

test('a footprint straddling a hole is rejected, not averaged across it', () => {
  const q = createSurfaceQuery({
    raycastAll: worldOf((x) => (x > 2 ? [] : [[0, UP]])), worldYMax: 50,
  });
  const fit = q.footprintAt(0, 0, 8, 8);
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'no-surface');
  assert.ok(fit.misses > 0);
});

test('a footprint under an overhang stays on its own level', () => {
  // Every column has a roof at 20 and a floor at 10. Asking for level 10 must not let any sample
  // snap up to the roof -- that is the bug this whole module exists to prevent.
  const fit = caveWorld.footprintAt(0, 0, 6, 6, 10);
  assert.equal(fit.ok, true);
  assert.equal(fit.floorY, 10);
  assert.equal(fit.openSky, false);
  assert.equal(fit.headroom, 8);
});

test('a column with no floor at the level does not snap up to the roof', () => {
  // The regression this module exists for. Left of x=1 the cave floor is missing, but the roof
  // above it is not. If `level` were a preference rather than a constraint, those samples would
  // resolve to y=20 and the site would report a clean footprint spanning two storeys.
  const q = createSurfaceQuery({
    raycastAll: worldOf((x) => (x < 1 ? [[20, UP]] : [[20, UP], [18, DOWN_N], [10, UP]])),
    worldYMax: 50,
  });
  const fit = q.footprintAt(0, 0, 6, 6, 10);
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'no-surface');
});

test('a cave site is rejected when the structure is taller than the ceiling', () => {
  const fit = caveWorld.footprintAt(0, 0, 6, 6, 10, { needHeadroom: 12 });
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'low-ceiling');
});

test('footprintLevels offers the hillside and the cave under it, best first', () => {
  const levels = caveWorld.footprintLevels(0, 0, 6, 6);
  assert.equal(levels.length, 2);
  assert.equal(levels[0].floorY, 20);
  assert.equal(levels[0].openSky, true);
  assert.equal(levels[1].floorY, 10);
  assert.equal(levels[1].openSky, false);
});

test('exterior and interior placement are separable by openSky', () => {
  const levels = caveWorld.footprintLevels(0, 0, 6, 6);
  assert.equal(levels.filter((l) => l.openSky).length, 1);
  assert.equal(levels.filter((l) => !l.openSky).length, 1);
});

test('a tall structure only fits the open level', () => {
  const levels = caveWorld.footprintLevels(0, 0, 6, 6, { needHeadroom: 12 });
  assert.equal(levels.length, 1);
  assert.equal(levels[0].openSky, true);
});

// ── decks: feeding the multi-level nav grid ─────────────────────────────────────────────────
// A hill from x=-20..20 with a tunnel bored through it between x=-8..8. Outside the tunnel the
// column is solid hill; inside it there are two floors: the hilltop at 20 and the tunnel at 10.
const tunnelBounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const inTunnel = (x, z) => Math.abs(x) <= 8 && Math.abs(z) <= 4;
const tunnelWorld = createSurfaceQuery({
  raycastAll: worldOf((x, z) => (inTunnel(x, z)
    ? [[20, UP], [18, DOWN_N], [10, UP]]
    : [[20, UP]])),
  worldYMax: 50,
});
const tunnelTopAt = () => 20;   // what buildNavGrid's own heightAt reports: the hilltop, always

test('decks are emitted only where a second floor actually exists', () => {
  const { decks, truncated } = surfaceDecks(tunnelWorld, tunnelBounds, 2, { baseHeightAt: tunnelTopAt });
  assert.equal(truncated, false);
  assert.ok(decks.length > 0, 'the tunnel produced decks');
  assert.ok(decks.every((d) => d.y === 10), 'every deck is the tunnel floor, not the hilltop');
  assert.ok(decks.every((d) => inTunnel(d.x, d.z)), 'and none sit outside the bore');
});

test('a one-surface map produces no decks at all', () => {
  const { decks } = surfaceDecks(flat(3), tunnelBounds, 2, { baseHeightAt: () => 3 });
  assert.equal(decks.length, 0);
});

test('decks land on the same lattice buildNavGrid samples', () => {
  const cellSize = 2;
  const { decks } = surfaceDecks(tunnelWorld, tunnelBounds, cellSize, { baseHeightAt: tunnelTopAt });
  for (const d of decks) {
    const c = (d.x - tunnelBounds.minX) / cellSize - 0.5;
    const r = (d.z - tunnelBounds.minZ) / cellSize - 0.5;
    assert.ok(Number.isInteger(c) && Number.isInteger(r), `deck at ${d.x},${d.z} is cell-centred`);
    assert.equal(d.w, cellSize);
  }
});

test('a cramped tunnel yields no decks -- bots are not sent somewhere they cannot stand', () => {
  const cramped = createSurfaceQuery({
    raycastAll: worldOf((x, z) => (inTunnel(x, z) ? [[20, UP], [11, DOWN_N], [10, UP]] : [[20, UP]])),
    worldYMax: 50,
  });
  const { decks } = surfaceDecks(cramped, tunnelBounds, 2, { baseHeightAt: tunnelTopAt });
  assert.equal(decks.length, 0, '1 m of headroom is not standable');
});

test('maxDecks truncates loudly rather than silently losing an interior', () => {
  const { decks, truncated } = surfaceDecks(tunnelWorld, tunnelBounds, 2, {
    baseHeightAt: tunnelTopAt, maxDecks: 3,
  });
  assert.equal(decks.length, 3);
  assert.equal(truncated, true);
});

// ── the payoff: the real nav-grid can path through the tunnel ────────────────────────────────
function tunnelNav(cellSize = 2) {
  const { decks } = surfaceDecks(tunnelWorld, tunnelBounds, cellSize, { baseHeightAt: tunnelTopAt });
  return buildNavGrid(() => true, tunnelBounds, cellSize, {
    heightAt: tunnelTopAt,
    decks,
    connectRegions: false,
  });
}

test('nav-grid accepts the decks and reports two surfaces in a tunnel column', () => {
  const grid = tunnelNav();
  const top = keyAt(grid, 0, 0, 20);
  const under = keyAt(grid, 0, 0, 10);
  assert.ok(top >= 0 && under >= 0, 'both surfaces resolve');
  assert.notEqual(top, under);
  assert.equal(keyIsLevel(grid, top), false, 'the hilltop is the base column');
  assert.equal(keyIsLevel(grid, under), true, 'the tunnel floor is a level');
  assert.equal(keyHeight(grid, under), 10);
  assert.ok(keyWalkable(grid, under));
});

test('a column outside the bore has no second surface to stand on', () => {
  const grid = tunnelNav();
  assert.equal(keyAt(grid, 18, 0, 10), -1, 'solid hill refuses a query at tunnel height');
  assert.ok(keyAt(grid, 18, 0, 20) >= 0, 'but the hilltop is there');
});

test('standing IN the tunnel is never mistaken for standing ON the hill', () => {
  const grid = tunnelNav();
  const k = keyAt(grid, 0, 0, 10);
  assert.equal(keyToWorld(grid, k).y, 10);
});

test('a path along the tunnel stays at tunnel height instead of climbing the hill', () => {
  const grid = tunnelNav();
  // findPath resolves world points, and `y` is what picks WHICH surface at the point.
  const path = findPath(grid, { x: -6, z: 0, y: 10 }, { x: 6, z: 0, y: 10 });
  assert.ok(path && path.length > 1, 'a route exists through the tunnel');
  for (const step of path) assert.equal(step.y, 10, 'every waypoint is on the tunnel floor');
});

test('the same two points routed over the hill stay on the hilltop', () => {
  const grid = tunnelNav();
  const path = findPath(grid, { x: -6, z: 0, y: 20 }, { x: 6, z: 0, y: 20 });
  assert.ok(path && path.length > 1);
  for (const step of path) assert.equal(step.y, 20, 'never drops into the tunnel');
});

test('the tunnel and the hilltop are separate components with no bore to link them', () => {
  // 10 m apart vertically, far past LEVEL_DEFAULTS.step, so nothing may connect them. A route
  // between the two would mean bots teleporting through rock.
  const grid = tunnelNav();
  assert.equal(findPath(grid, { x: -6, z: 0, y: 10 }, { x: 18, z: 0, y: 20 }), null);
});

console.log(`\n${passed} passed`);
