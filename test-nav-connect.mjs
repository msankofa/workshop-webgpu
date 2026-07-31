// connectStrandedRegions: reconnect pockets cut off by SOFT (too-steep) ground, never by walls.
// This is the fix for the 2026-07-29 traces where 30 of 112 bots sat in a nav pocket the patrol ring
// could not reach. The wall case matters as much as the slope case -- opening a wall would put bots
// inside geometry, so a sealed room must stay sealed and be reported instead.
import assert from 'node:assert';
import { buildNavGrid, regionAt, reachable, findPath } from './nav-grid.js';

const CELL = 1;
// 20x9 world. A vertical divider at x=10 splits it in two. `kind` decides what the divider is made of.
function makeGrid(kind, opts = {}) {
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 9 };
  const isDivider = (x, z) => Math.floor(x) === 10 && Math.floor(z) !== 4;   // gap at z=4 when open
  const solid = (x, z) => Math.floor(x) === 10;
  const blocked = kind === 'wall' ? solid : kind === 'slope' ? solid : isDivider;
  return buildNavGrid(
    (x, z) => !blocked(x, z),
    bounds, CELL,
    {
      heightAt: () => 0,
      // Only the 'slope' grid calls its divider soft; the 'wall' grid calls nothing soft.
      softBlockedTest: kind === 'slope' ? (x, z) => solid(x, z) : () => false,
      ...opts,
    },
  );
}

// 1. Slope-stranded pocket: must be connected, and a real path must now exist across it.
{
  const g = makeGrid('slope');
  assert.strictEqual(g.regionSizes.length, 1, `expected one region after repair, got ${g.regionSizes.length}`);
  assert.ok(g.carved.length > 0, 'the repair must record which cells it opened');
  const a = { x: 2.5, z: 4.5 }, b = { x: 17.5, z: 4.5 };
  assert.ok(reachable(g, a, b), 'the two halves must be reachable after the carve');
  const path = findPath(g, a, b);
  assert.ok(path && path.length, 'A* must actually walk the carved link, not just the labels');
  console.log(`ok  slope-stranded pocket connected by opening ${g.carved.length} cell(s); A* path ${path.length} waypoints`);
}

// 2. Walled pocket: must NOT be carved, and must be reported as sealed.
{
  const g = makeGrid('wall');
  assert.strictEqual(g.carved.length, 0, 'a wall must never be opened');
  assert.strictEqual(g.regionSizes.length, 2, 'the two halves must stay separate');
  assert.ok(g.sealedRegions?.length >= 1, 'a sealed pocket must be reported, not silently ignored');
  assert.ok(!reachable(g, { x: 2.5, z: 4.5 }, { x: 17.5, z: 4.5 }), 'a wall must still block reachability');
  console.log(`ok  walled pocket left sealed and reported (${g.sealedRegions.length} region(s))`);
}

// 3. Already-connected map: nothing is carved and nothing is reported.
{
  const g = makeGrid('gap');
  assert.strictEqual(g.carved.length, 0, 'a connected map needs no repair');
  assert.strictEqual(g.regionSizes.length, 1, 'a map with a doorway is one region');
  console.log('ok  connected map untouched');
}

// 4. Opting out leaves the pocket stranded, so the repair is genuinely doing the work above.
{
  const g = makeGrid('slope', { connectRegions: false });
  assert.strictEqual(g.carved.length, 0, 'connectRegions:false must not carve');
  assert.strictEqual(g.regionSizes.length, 2, 'without the repair the pocket stays stranded');
  console.log('ok  connectRegions:false reproduces the original stranding');
}

// 5. The carve prefers gentle ground: given a cheap saddle and a steep ridge, it must take the saddle.
{
  const bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 9 };
  const solid = (x, z) => Math.floor(x) === 10;
  // Divider is a tall ridge everywhere except a low saddle at z=7.
  const heightAt = (x, z) => (Math.floor(x) === 10 ? (Math.floor(z) === 7 ? 0.2 : 6) : 0);
  const g = buildNavGrid((x, z) => !solid(x, z), bounds, CELL,
    { heightAt, softBlockedTest: solid });
  assert.ok(g.carved.length > 0, 'expected a carve');
  const rows = g.carved.map(k => (k / g.cols) | 0);
  assert.ok(rows.every(r => r === 7), `carve should cross the saddle at row 7, crossed rows ${[...new Set(rows)]}`);
  console.log(`ok  carve crosses the low saddle (row ${rows[0]}), not the 6 m ridge`);
}

// 6. No softBlockedTest supplied -> feature is inert, so existing callers are unaffected.
{
  const g = buildNavGrid((x, z) => Math.floor(x) !== 10, { minX: 0, maxX: 20, minZ: 0, maxZ: 9 }, CELL);
  assert.strictEqual(g.carved.length, 0, 'no soft test means no carving');
  assert.strictEqual(g.regionSizes.length, 2, 'and the map is labelled exactly as before');
  console.log('ok  inert without softBlockedTest (existing callers unchanged)');
}

console.log('\nall nav-connect tests passed');
