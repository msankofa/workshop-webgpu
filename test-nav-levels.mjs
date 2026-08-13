// Node checks for nav-grid.js's sparse level overlay (decks you fight ON and UNDER).
// Three groups:
//   1. REGRESSION, proved against the pre-overlay file in versions/ rather than against itself --
//      a deck-free map must bake and path byte-identically, or every existing map changed;
//   2. the overlay itself: a deck is reachable only by the ramp you provide, never off its edge,
//      and the ground under it stays walkable;
//   3. the surface lookup, whose real assertion is the REFUSAL -- a point with no surface at its
//      height gets nothing rather than the nearest one.
// Run: node test-nav-levels.mjs
import {
  buildNavGrid, findPath, floodFill, floodPathToKey, reachable, keyAt, keyCount,
  keyIsLevel, keyHeight, keyToWorld, nearestWalkableKey, smoothPath,
} from './nav-grid.js';
import * as OLD from './versions/nav-grid-before-levels-20260811-222855.js';

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log(`  ok   ${msg}`); return; }
  failed++;
  console.log(`  FAIL ${msg}${detail ? `\n       ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------------------------
// 1. regression: a map with no decks must be exactly what it was
// ---------------------------------------------------------------------------------------------
console.log('\ndeck-free maps are unchanged (vs versions/nav-grid-before-levels)');

const BOUNDS = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const CELL = 0.5;
const WALLS = [
  { x: -6, z: 0, w: 1, d: 22 }, { x: 6, z: 4, w: 1, d: 18 }, { x: 0, z: -11, w: 14, d: 1 },
];
// TWO fixtures on purpose. `rolling` is open enough that every sampled pair has a route, so the A*
// comparison has something to compare; `broken` is steep enough to strand pockets, so the region
// labeller, cheapestSoftLink and the carve loop all actually run. On `rolling` alone this whole
// section passed while carving 0 cells -- it was agreeing about code neither build had executed.
const FIXTURES = [
  { name: 'rolling', amp: 1.6, fx: 0.42, fz: 0.31 },
  { name: 'broken', amp: 4.0, fx: 0.42, fz: 0.50 },
];

const sameArray = (a, b) => {
  if (!a !== !b) return false;
  if (!a) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

for (const fx of FIXTURES) {
  const heightAt = (x, z) => fx.amp * Math.sin(x * fx.fx) * Math.cos(z * fx.fz) + 0.9 * Math.sin(z * 0.7);
  const grad = (x, z) => {
    const e = 0.25;
    return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  };
  const walkableTest = (x, z) => grad(x, z) <= 0.85;
  const opts = { heightAt, softBlockedTest: () => true, blockers: WALLS, blockerMargin: 0.55 };
  const gNew = buildNavGrid(walkableTest, BOUNDS, CELL, opts);
  const gOld = OLD.buildNavGrid(walkableTest, BOUNDS, CELL, opts);
  const tag = `[${fx.name}: ${gNew.regionSizes.length} regions, ${gNew.carved.length} carved, ${gNew.sealedRegions.length} sealed]`;

  ok(gNew.levels === null, `${fx.name}: a map with no decks gets no level overlay at all`);
  ok(sameArray(gNew.cells, gOld.cells), `${fx.name}: cells are identical (${gNew.cells.length} cells)`);
  ok(sameArray(gNew.heights, gOld.heights), `${fx.name}: heights are identical`);
  ok(sameArray(gNew.soft, gOld.soft), `${fx.name}: soft flags are identical`);
  ok(sameArray(gNew.regions, gOld.regions), `${fx.name}: region labels are identical ${tag}`);
  ok(sameArray(Int32Array.from(gNew.carved), Int32Array.from(gOld.carved)),
    `${fx.name}: the same cells were carved, in the same order`);
  ok(gNew.regionSizes.join() === gOld.regionSizes.join(), `${fx.name}: region sizes are identical`);
  ok(JSON.stringify(gNew.sealedRegions) === JSON.stringify(gOld.sealedRegions),
    `${fx.name}: the same regions were reported sealed`);

  // Paths, not just the bake: the searches were rewritten, so their OUTPUT is what has to match.
  let pathMismatch = null, pathsCompared = 0, pathsFound = 0;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 120 && !pathMismatch; i++) {
    const a = { x: -19 + rnd() * 38, z: -19 + rnd() * 38 };
    const b = { x: -19 + rnd() * 38, z: -19 + rnd() * 38 };
    const pn = findPath(gNew, a, b), po = OLD.findPath(gOld, a, b);
    pathsCompared++;
    if (pn) pathsFound++;
    if (JSON.stringify(pn) !== JSON.stringify(po)) pathMismatch = { a, b, pn: pn && pn.length, po: po && po.length };
    // and the string-pull on top of it
    if (pn && JSON.stringify(smoothPath(gNew, pn)) !== JSON.stringify(OLD.smoothPath(gOld, po))) {
      pathMismatch = { a, b, note: 'smoothPath differs' };
    }
  }
  ok(!pathMismatch, `${fx.name}: every A* path is identical (${pathsFound}/${pathsCompared} pairs had a route)`,
    pathMismatch && JSON.stringify(pathMismatch));

  const fn = floodFill(gNew, { x: -2, z: 3 }, { maxRadius: 24 });
  const fo = OLD.floodFill(gOld, { x: -2, z: 3 }, { maxRadius: 24 });
  let floodMismatch = -1;
  for (let i = 0; i < fo.dist.length; i++) if (fn.dist[i] !== fo.dist[i]) { floodMismatch = i; break; }
  ok(floodMismatch === -1, `${fx.name}: floodFill distances are identical`,
    floodMismatch >= 0 ? `first at cell ${floodMismatch}` : '');
  ok(sameArray(fn.parent, fo.parent), `${fx.name}: floodFill parents are identical`);
}

// ---------------------------------------------------------------------------------------------
// 2. the overlay: a deck, its ramp, and the ground underneath
// ---------------------------------------------------------------------------------------------
console.log('\na deck is reachable only by its ramp');

const FLAT = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const flatGround = () => 0;
const DECK = { x: 4, z: 0, w: 8, d: 6, y: 3.0 };            // deck surface spans x 0..8, z -3..3
const RAMP = [];                                             // stepped rects west of it, 0.5 m apiece
for (let i = 0; i < 6; i++) RAMP.push({ x: -8.25 + i * 1.5, z: 0, w: 1.5, d: 3, y: 0.5 + i * 0.5 });

const withRamp = buildNavGrid(() => true, FLAT, CELL, { heightAt: flatGround, decks: [DECK, ...RAMP] });
const noRamp = buildNavGrid(() => true, FLAT, CELL, { heightAt: flatGround, decks: [DECK] });

ok(withRamp.levels && withRamp.levels.count > 0, `the deck stamped ${withRamp.levels.count} level cells`);
ok(keyCount(withRamp) === withRamp.cols * withRamp.rows + withRamp.levels.count,
  'level keys allocate after the base range, so base keys are untouched');

const onDeck = { x: 4, z: 0, y: 3.0 };
const westOfRamp = { x: -15, z: 0, y: 0 };
const eastOfDeck = { x: 14, z: 0, y: 0 };

const up = findPath(withRamp, westOfRamp, onDeck);
ok(up !== null, 'with a ramp, a bot on the ground can path onto the deck');
ok(up && up[up.length - 1].y > 2.9, `the path ends ON the deck (y = ${up && up[up.length - 1].y})`);

ok(findPath(noRamp, westOfRamp, onDeck) === null,
  'delete the ramp and the deck is unreachable -- nothing walks up a vertical side');
ok(!reachable(noRamp, westOfRamp, onDeck), 'and reachable() says so without paying for the search');
ok(reachable(withRamp, westOfRamp, onDeck), 'reachable() agrees with findPath once the ramp is back');

// The east side is the one that would break if a deck edge were steppable: straight across the deck
// is ~19 m, round by the ramp is far longer.
const around = findPath(withRamp, eastOfDeck, onDeck);
ok(around !== null, 'the deck is reachable from the east too');
const straight = Math.hypot(onDeck.x - eastOfDeck.x, onDeck.z - eastOfDeck.z);
const walked = around ? around.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - around[i].x, p.z - around[i].z), 0) : 0;
ok(walked > straight * 2.5,
  `it routes round to the ramp rather than up the edge (${walked.toFixed(1)} m walked vs ${straight.toFixed(1)} m straight)`);

// Walking UNDER is the whole point of route B: the ground beneath the deck stays its own surface.
const under = findPath(withRamp, { x: 4, z: -12, y: 0 }, { x: 4, z: 12, y: 0 });
ok(under !== null, 'the ground under the deck is still walkable end to end');
ok(under && under.every(p => p.y < 0.6), 'and that route never climbs onto the deck');
ok(under && under.some(p => Math.abs(p.z) < 3 && p.x > 0 && p.x < 8), 'it genuinely passes beneath the footprint');

// A shortcut across the deck edge would be the string-pull's way of undoing all of the above.
const smoothed = smoothPath(withRamp, up || []);
let jump = 0;
for (let i = 1; i < smoothed.length; i++) jump = Math.max(jump, Math.abs(smoothed[i].y - smoothed[i - 1].y));
ok(smoothed.length === 0 || jump <= 0.5 + 1e-6, `the string-pull never joins two surfaces (largest y step ${jump.toFixed(2)} m)`);

// floodFill has to reach levels too, or every flee/retreat scorer is blind to them.
const flood = floodFill(withRamp, westOfRamp, {});
const n0 = withRamp.cols * withRamp.rows;
let reachedLevels = 0;
for (let i = 0; i < withRamp.levels.count; i++) if (flood.dist[n0 + i] < Infinity) reachedLevels++;
ok(reachedLevels === withRamp.levels.count,
  `floodFill reaches every level cell (${reachedLevels}/${withRamp.levels.count})`);
const deckKey = keyAt(withRamp, 4, 0, 3.0);
const fp = floodPathToKey(withRamp, flood, deckKey);
ok(fp && fp[fp.length - 1].y > 2.9, 'floodPathToKey routes to the surface it scored, not the ground under it');

// A sealed deck is a map bug and should be reported as one, not carved open.
const sealed = buildNavGrid(() => true, FLAT, CELL,
  { heightAt: flatGround, softBlockedTest: () => true, decks: [DECK] });
ok(sealed.carved.length === 0, `connectStrandedRegions carves nothing to reach a rampless deck (${sealed.carved.length} cells)`);
ok(sealed.sealedRegions.length === 1 && keyIsLevel(sealed, sealed.sealedRegions[0].cell),
  'it records the deck as a sealed region instead',
  JSON.stringify(sealed.sealedRegions));

// ---------------------------------------------------------------------------------------------
// 3. the surface lookup, and the refusal
// ---------------------------------------------------------------------------------------------
console.log('\nthe surface lookup refuses rather than snaps');

const kGround = keyAt(withRamp, 4, 0, 0);
const kDeck = keyAt(withRamp, 4, 0, 3.0);
ok(kGround >= 0 && !keyIsLevel(withRamp, kGround), 'a bot at ground height under the deck resolves to the ground');
ok(kDeck >= 0 && keyIsLevel(withRamp, kDeck), 'a bot at deck height over the same column resolves to the deck');
ok(kGround !== kDeck, 'they are different keys, so "where am I" can tell them apart');
ok(Math.abs(keyHeight(withRamp, kGround)) < 1e-6 && Math.abs(keyHeight(withRamp, kDeck) - 3) < 1e-6,
  'each key reports its own surface height');

ok(keyAt(withRamp, 4, 0, 1.5) === -1,
  'a height with no surface within tolerance returns nothing -- it does NOT snap to the nearer one');
ok(keyAt(withRamp, 4, 0, 8) === -1, 'and neither does a height far above everything');
ok(keyAt(withRamp, 4, 0, 2.4) === kDeck, 'inside tolerance it does resolve, to the surface it is nearest');
ok(keyAt(withRamp, 4, 0, null) === kGround, 'omitting y keeps the old 2D answer (the base column)');
ok(keyAt(withRamp, 99, 99, 0) === -1, 'out of bounds is still -1');

// The spiral has to refuse the same way, or it re-introduces the snap it was meant to prevent.
ok(nearestWalkableKey(withRamp, 4, 0, 1.5, 4) === -1,
  'the outward spiral also refuses a height no nearby surface matches');
const w = keyToWorld(withRamp, kDeck);
ok(Math.abs(w.y - 3) < 1e-6 && Math.abs(w.x - 4.25) < CELL && Math.abs(w.z - 0.25) < CELL,
  `keyToWorld returns the surface, not the footprint (${w.x}, ${w.y}, ${w.z})`);

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
