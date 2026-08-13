// Why bots stood still on open terrain until an enemy showed up.
//
// Out of combat with no patrol points, the only goal source is an explore point 80-300 m out. That
// goal is usually blocked or off-grid, so requestBotPath falls back to "nearest walkable cell to the
// goal" -- and on real terrain that cell is routinely across a lake or a ridge, in a DIFFERENT
// connected region. A* then fails a second time, the caller gets an empty path, clears the goal, and
// picks another equally unreachable one. Forever.
//
// This models the fallback both ways against the real nav-grid: unconstrained (the old behaviour)
// versus constrained to the bot's own region (the fix).
import { buildNavGrid, finalizeNavGrid, findPath, isWalkableCell, cellToWorld, regionAt }
  from './nav-grid.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

// A 200 m map cut in two by an impassable channel at x = 0, like a river across open terrain.
const SPAN = 200, CELL = 2;
const bounds = { minX: -SPAN / 2, maxX: SPAN / 2, minZ: -SPAN / 2, maxZ: SPAN / 2 };
const grid = buildNavGrid((x) => Math.abs(x) > 6, bounds, CELL);
finalizeNavGrid?.(grid);

// Same scan the viewer runs, with and without the region filter.
function scanNearest(g, x, z, region) {
  let best = null, bestDist = Infinity;
  const regions = region >= 0 ? g.regions : null;
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    if (!isWalkableCell(g, c, r)) continue;
    if (regions && regions[r * g.cols + c] !== region) continue;
    const w = cellToWorld(g, c, r);
    const d = Math.hypot(w.x - x, w.z - z);
    if (d < bestDist) { bestDist = d; best = w; }
  }
  return best;
}

const from = { x: -60, z: 0 };                 // a bot on the west bank
const exploreGoal = { x: 300, z: 120 };        // 80-300 m out, off-grid and across the channel
const myRegion = regionAt(grid, from.x, from.z);

console.log('the setup is genuinely split');
check('the bot is on a labelled region', myRegion >= 0, `got ${myRegion}`);
check('the far explore goal does not path directly', findPath(grid, from, exploreGoal) == null);

console.log('\nold behaviour: retarget anywhere');
const anywhere = scanNearest(grid, exploreGoal.x, exploreGoal.z, -1);
check('it finds a walkable cell', !!anywhere);
check('but that cell is on the FAR bank', anywhere && regionAt(grid, anywhere.x, anywhere.z) !== myRegion,
  anywhere ? `region ${regionAt(grid, anywhere.x, anywhere.z)} vs the bot's ${myRegion}` : '');
check('so the retry ALSO fails and the caller gets no path', anywhere && findPath(grid, from, anywhere) == null,
  'this is the freeze: empty path -> goal cleared -> another goal just like it');

console.log('\nfixed: retarget inside the bot\'s own region');
const mine = scanNearest(grid, exploreGoal.x, exploreGoal.z, myRegion);
check('it finds a walkable cell', !!mine);
check('the cell is reachable', mine && regionAt(grid, mine.x, mine.z) === myRegion);
const path = mine ? findPath(grid, from, mine) : null;
check('the retry produces a real path', !!path && path.length > 1, `got ${path ? path.length : 0} points`);
check('and it heads toward the goal, not away from it',
  !!mine && mine.x > from.x && mine.z > from.z,
  mine ? `retarget (${mine.x.toFixed(0)}, ${mine.z.toFixed(0)}) from (${from.x}, ${from.z})` : '');

console.log(failures ? `\nexplore retarget: ${failures} FAILED` : '\nexplore retarget: all checks passed');
process.exit(failures ? 1 : 0);
