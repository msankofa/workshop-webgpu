// Node test for the deck path end to end: bot-structures' platform -> nav-grid levels -> a route
// from open ground onto the deck. test-nav-levels.mjs proves the level overlay against hand-built
// decks; this proves the decks a real map generates are the right shape to use it.
// Run: node test-nav-decks.mjs
import { generateOne, rampDecks, rampBox, STRUCTURE_DEFAULTS } from './bot-structures.js';
import { buildNavGrid, findPath, keyAt, keyIsLevel, keyWalkable, keyHeight, regionAt, reachable } from './nav-grid.js';
import { seatDecksAndRamps } from './map-boxes.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const CELL = 0.5;                 // bot-viewer-v3's NAV_CELL
const NAV_RISE = STRUCTURE_DEFAULTS.platformNavRise;
const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const params = { ...STRUCTURE_DEFAULTS };
const platform = generateOne('platform', params, 11, { x: 0, z: 0 });
const deck = platform.decks[0];
const ramp = platform.ramps[0];
const groundStart = { x: -15, z: -15 };

// `softBlockedTest` is what turns connectivity repair on at all (nav-grid only carves SOFT cells),
// so the fixture supplies one that never yields: the repair runs, finds nothing it may open, and
// has to report rather than carve -- which is exactly bot-viewer-v3's terrain bake on flat ground.
function bake(decks) {
  return buildNavGrid(() => true, bounds, CELL, {
    blockers: platform.covers, blockerMargin: 0.3, decks, softBlockedTest: () => false,
  });
}

// ---- the generated decks tile onto the grid and reach the main region ----
{
  const grid = bake([deck, ...rampDecks(ramp, NAV_RISE)]);
  ok(!!grid.levels && grid.levels.count > 0, 'the platform decks attach as nav levels');

  const onDeck = keyAt(grid, deck.x, deck.z, deck.y);
  ok(onDeck >= 0 && keyIsLevel(grid, onDeck) && keyWalkable(grid, onDeck),
    'the deck centre at deck height resolves to a walkable level');
  ok(Math.abs(keyHeight(grid, onDeck) - deck.y) < 1e-6, 'and that level stands at the deck surface');

  const under = keyAt(grid, deck.x, deck.z, 0);
  ok(under >= 0 && !keyIsLevel(grid, under), 'a bot standing UNDER the deck resolves to the ground, not the deck');

  ok(regionAt(grid, deck.x, deck.z, 4, deck.y) === grid.mainRegion,
    'the deck is part of the main region, not a pocket of its own');
  ok((grid.sealedRegions || []).length === 0, 'and nothing on this map is sealed off');
  ok(reachable(grid, { ...groundStart, y: 0 }, { x: deck.x, z: deck.z, y: deck.y }),
    'reachable() agrees you can get from open ground to the deck');

  const path = findPath(grid, { ...groundStart, y: 0 }, { x: deck.x, z: deck.z, y: deck.y });
  ok(!!path && path.length > 1, 'A* finds a route from open ground onto the deck');
  if (path) {
    ok(Math.abs(path.at(-1).y - deck.y) < 1e-6, 'the route ends on the deck surface');
    ok(Math.abs(path[0].y ?? 0) < 0.3, 'and starts on the ground');
    // The climb has to be gradual: one waypoint that jumps a whole storey means the search took a
    // shortcut nav allows and no capsule can walk.
    let worst = 0;
    for (let i = 1; i < path.length; i++) worst = Math.max(worst, Math.abs((path[i].y ?? 0) - (path[i - 1].y ?? 0)));
    ok(worst <= NAV_RISE + 1e-6, `no single step climbs more than one ramp deck (worst ${worst.toFixed(3)} m)`);
    // It must actually use the ramp, i.e. leave the deck footprint on the way up.
    const climbed = path.filter(p => (p.y ?? 0) > 0.2 && (p.y ?? 0) < deck.y - 0.2);
    ok(climbed.length >= 3, `the route spends several waypoints on the ramp (${climbed.length})`);
    const onRampLine = climbed.every(p => Math.abs(p.x - ramp.x0) < 12 && Math.abs(p.z - ramp.z0) < 12);
    ok(onRampLine, 'and those waypoints lie along the ramp, not in mid-air elsewhere');
  }
}

// ---- the control: without the ramp the deck is unreachable, which is what makes the ramp real ----
{
  const grid = bake([deck]);
  ok(regionAt(grid, deck.x, deck.z, 4, deck.y) !== grid.mainRegion,
    'a deck with no ramp is its own region');
  ok(findPath(grid, { ...groundStart, y: 0 }, { x: deck.x, z: deck.z, y: deck.y }) === null,
    'and no path reaches it');
  ok((grid.sealedRegions || []).length === 1, 'connectivity repair reports it sealed rather than carving to it');
}

// ---- the ramp solid the collider gets is the surface nav was cut from ----
{
  const box = rampBox(ramp);
  const decks = rampDecks(ramp, NAV_RISE);
  const slope = Math.abs(ramp.y1 - ramp.y0) / Math.hypot(ramp.x1 - ramp.x0, ramp.z1 - ramp.z0);
  // resolveCapsule calls a face ground when its normal.y >= slopeLimitY (0.5 by default).
  ok(1 / Math.hypot(1, slope) >= 0.5, `the ramp face reads as ground to the capsule (normal.y ${(1 / Math.hypot(1, slope)).toFixed(2)})`);
  const alongX = box.w > box.d;
  for (const d of decks) {
    const t = alongX ? (d.x - ramp.x0) / (ramp.x1 - ramp.x0) : (d.z - ramp.z0) / (ramp.z1 - ramp.z0);
    const surfaceY = ramp.y0 + (ramp.y1 - ramp.y0) * t;
    ok(Math.abs(d.y - surfaceY) < 1e-9, 'every nav deck sits exactly on the rendered ramp surface');
  }
}


// ---- the same platform on a hillside: seated heights, and a route that still climbs ----
{
  // A steady grade under the whole thing, which is the worst honest case: pads flatten a real map,
  // so if the chain survives an unflattened slope it survives the flattened one.
  const grade = 0.12;
  const groundAt = (x) => grade * x;
  const groundMax = (x, z, w) => groundAt(x + w / 2);
  const seated = seatDecksAndRamps([deck], [ramp], groundMax);
  const worldDeck = seated.decks[0], worldRamp = seated.ramps[0];
  const treads = rampDecks(worldRamp, NAV_RISE);

  ok(Math.abs(worldRamp.y1 - worldDeck.y) < 1e-9, 'the ramp head still meets the deck once both are seated');
  let worstTread = 0;
  for (let i = 1; i < treads.length; i++) worstTread = Math.max(worstTread, Math.abs(treads[i].y - treads[i - 1].y));
  ok(worstTread <= NAV_RISE + 1e-6, `the seated treads still step under the cap (${worstTread.toFixed(3)} m)`);

  const grid = buildNavGrid(() => true, bounds, CELL, {
    blockers: platform.covers, blockerMargin: 0.3, decks: [worldDeck, ...treads],
    heightAt: (x) => groundAt(x), softBlockedTest: () => false,
  });
  ok(regionAt(grid, worldDeck.x, worldDeck.z, 4, worldDeck.y) === grid.mainRegion,
    'the hillside deck is still on the main region');
  const path = findPath(grid, { ...groundStart, y: groundAt(groundStart.x) }, { x: worldDeck.x, z: worldDeck.z, y: worldDeck.y });
  ok(!!path, 'and a bot still finds its way up');
  if (path) ok(Math.abs(path.at(-1).y - worldDeck.y) < 1e-6, 'arriving on the deck, not under it');

  // The lowest tread has to be within one step of the ground it meets, or the ramp starts as a ledge.
  const lowest = treads.reduce((a, b) => (a.y <= b.y ? a : b));
  ok(lowest.y - groundAt(lowest.x) <= 0.5, `the ramp foot is a step off the ground, not a ledge (${(lowest.y - groundAt(lowest.x)).toFixed(2)} m)`);
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('nav decks: all assertions passed');
