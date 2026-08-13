// test-bot-flora.mjs — bot-flora-place.js (placement math) plus the eco-brutalism theme's two
// optional blocks. bot-flora.js itself needs a GPU and is not covered here; this is the same
// split as test-bot-viewer-visuals.mjs, which tests the style file and not the renderer.
import {
  makeRng, blockerRects, padRects, buildBlockerIndex, isBlocked,
  vineAnchors, floraChunk, bladeBudget, nearestBlockerDist, wallAffinityMask, inRect, BLADE_CAP,
} from './bot-flora-place.js';
import {
  THEMES, validateTheme, concreteFor, floraFor, togglesFor, normalizeTheme, CONCRETE_OFF, FLORA_OFF,
} from './bot-viewer-visuals-style.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (cond) pass++; else fail++;
}

// ─── blockers ───────────────────────────────────────────────────────────────

const wall = { x: 0, z: 0, w: 4, d: 0.3 };
let rects = blockerRects([wall], 0);
ok(rects.length === 1 && rects[0].minX === -2 && rects[0].maxX === 2, 'blockerRects uses the box half-extents');
ok(rects[0].minZ === -0.15 && rects[0].maxZ === 0.15, 'blockerRects keeps a thin wall thin');

rects = blockerRects([wall], 0.5);
ok(rects[0].minX === -2.5 && rects[0].maxZ === 0.65, 'clearance widens on both axes');

ok(blockerRects([{ x: 0, z: 0, w: 0, d: 2 }], 0).length === 0, 'degenerate boxes are skipped');
ok(blockerRects(null, 0).length === 0, 'a null box list is not an error');

const pads = padRects([{ x: 5, z: 5, radius: 2 }], 0);
ok(pads.length === 1 && pads[0].minX === 3 && pads[0].maxX === 7, 'padRects squares a pad radius');
ok(padRects([{ x: 0, z: 0, radius: 0 }], 0).length === 0, 'a zero-radius pad contributes nothing');

// ─── the blocker index agrees with a brute-force scan ───────────────────────
// The index exists purely for speed, so the property that matters is that it never disagrees
// with the linear test it replaces.

const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const rng = makeRng(99);
const manyBoxes = [];
for (let i = 0; i < 120; i++) {
  manyBoxes.push({
    x: (rng() - 0.5) * 36, z: (rng() - 0.5) * 36,
    w: 0.4 + rng() * 5, d: 0.4 + rng() * 5,
  });
}
const manyRects = blockerRects(manyBoxes, 0.3);
const index = buildBlockerIndex(manyRects, bounds, 2);
const brute = (x, z) => manyRects.some((r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);

let disagreements = 0, insideHits = 0;
for (let i = 0; i < 4000; i++) {
  const x = (rng() - 0.5) * 40, z = (rng() - 0.5) * 40;
  const b = brute(x, z);
  if (b) insideHits++;
  if (isBlocked(index, x, z) !== b) disagreements++;
}
ok(disagreements === 0, 'indexed blocking matches the brute-force scan over 4000 samples');
ok(insideHits > 200, `the sample actually hit blockers (${insideHits}/4000) -- otherwise the above proves nothing`);

ok(isBlocked(index, 500, 500) === false, 'points outside the indexed area are free ground');
ok(isBlocked(null, 0, 0) === false, 'a null index blocks nothing');

// A cell-size change must not change the answer -- if it does, the bucketing is dropping rects.
const coarse = buildBlockerIndex(manyRects, bounds, 7);
let cellDisagreements = 0;
for (let i = 0; i < 2000; i++) {
  const x = (rng() - 0.5) * 40, z = (rng() - 0.5) * 40;
  if (isBlocked(coarse, x, z) !== brute(x, z)) cellDisagreements++;
}
ok(cellDisagreements === 0, 'the index result is independent of cell size');

// ─── vines ──────────────────────────────────────────────────────────────────

// A rendered wall box: 6 m long, 0.3 m thick, 3 m tall, centred 1.5 m up.
const wallBox = { x: 0, y: 1.5, z: 0, w: 6, h: 3, d: 0.3 };
const anchors = vineAnchors([wallBox], { density: 1, length: 1.5, seed: 5 });
ok(anchors.length > 0, 'vines grow on a wall');
ok(anchors.every((a) => Math.abs(a.y - 3) < 1e-9), 'every anchor sits on the box top, not at a fixed height');
ok(anchors.every((a) => Math.abs(a.nz) === 1), 'a 6 m x 0.3 m wall grows only off its two long faces');
ok(anchors.every((a) => Math.abs(a.x) <= 3 + 1e-9), 'anchors stay within the wall run');
ok(anchors.every((a) => Math.abs(Math.abs(a.z) - 0.15) < 1e-9), 'anchors sit on the face, not inside the box');

// A wall sunk into a hillside reports a different top; the anchors must follow it.
const sunk = vineAnchors([{ x: 0, y: 0.2, z: 0, w: 6, h: 3, d: 0.3 }], { density: 1, length: 1.5, seed: 5 });
ok(sunk.every((a) => Math.abs(a.y - 1.7) < 1e-9), 'anchors follow a terrain-sunk box top');

ok(vineAnchors([wallBox], { density: 0, length: 1.5 }).length === 0, 'density 0 grows nothing');
ok(vineAnchors(null, { density: 1 }).length === 0, 'a null box list is not an error');

// Fractional counts must still grow. A floor() here would silently strip every short wall
// segment out of a maze, which is most of a maze.
let shortWallTotal = 0;
for (let s = 0; s < 200; s++) {
  shortWallTotal += vineAnchors([{ x: 0, y: 1.5, z: 0, w: 1, h: 3, d: 0.3 }],
    { density: 0.4, length: 1.5, seed: s }).length;
}
ok(shortWallTotal > 0, 'a fractional strand count is a probability, not a truncation to zero');
// 200 walls x 2 long faces x 0.4 expected = ~160.
ok(shortWallTotal > 90 && shortWallTotal < 240, `fractional count lands near its expectation (${shortWallTotal})`);

// Distribution: clumping must gather strands, not just move them. Measured as mean nearest-
// neighbour gap along the edge -- bunched strands sit closer together than evenly spaced ones.
function meanGap(list) {
  const xs = list.filter((a) => a.nz === -1).map((a) => a.x).sort((p, q) => p - q);
  if (xs.length < 2) return Infinity;
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += xs[i] - xs[i - 1];
  return sum / (xs.length - 1);
}
const longWall = { x: 0, y: 1.5, z: 0, w: 20, h: 3, d: 0.3 };
const evenGaps = [], clumpGaps = [];
for (let s = 0; s < 30; s++) {
  evenGaps.push(meanGap(vineAnchors([longWall], { density: 1, length: 1.5, clump: 0, seed: s })));
  clumpGaps.push(meanGap(vineAnchors([longWall], { density: 1, length: 1.5, clump: 1, seed: s })));
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
ok(avg(clumpGaps) < avg(evenGaps) * 0.75,
  `clumping tightens spacing (${avg(clumpGaps).toFixed(2)} m vs ${avg(evenGaps).toFixed(2)} m even)`);
const clumped = vineAnchors([longWall], { density: 1, length: 1.5, clump: 1, seed: 3 });
ok(clumped.every((a) => Math.abs(a.x) <= 10 + 1e-9), 'clumped strands stay on the wall');
ok(clumped.length === vineAnchors([longWall], { density: 1, length: 1.5, clump: 0, seed: 3 }).length,
  'clumping redistributes strands rather than changing how many there are');

const a1 = vineAnchors([wallBox], { density: 1, length: 1.5, seed: 42 });
const a2 = vineAnchors([wallBox], { density: 1, length: 1.5, seed: 42 });
ok(JSON.stringify(a1) === JSON.stringify(a2), 'the same seed reproduces the same strands');
const a3 = vineAnchors([wallBox], { density: 1, length: 1.5, seed: 43 });
ok(JSON.stringify(a1) !== JSON.stringify(a3), 'a different seed produces different strands');

ok(a1.every((a) => a.len > 0), 'every strand has a positive length');
const lens = new Set(a1.map((a) => a.len));
ok(lens.size > 1, 'strand lengths vary rather than all matching the nominal length');

// Cover-sized cubes grow off all four faces, unlike thin walls.
const cube = vineAnchors([{ x: 0, y: 0.5, z: 0, w: 2, h: 1, d: 2 }], { density: 2, length: 0.8, seed: 3 });
ok(new Set(cube.map((a) => `${a.nx},${a.nz}`)).size === 4, 'a square box grows off all four faces');

// ─── chunk + budget ─────────────────────────────────────────────────────────

const chunk = floraChunk({ minX: -10, maxX: 10, minZ: -5, maxZ: 5 }, 3);
ok(chunk.size === 26, 'chunk size is the larger padded span, so it covers the whole arena');
ok(chunk.centerX === 0 && chunk.centerZ === 0, 'chunk centre matches the arena centre');
// The regression this guards: a corner-anchored square over a rectangular arena puts ALL of its
// overspill past one edge, which renders as a band of plants growing off one side of the map.
ok(chunk.xMin === -13 && chunk.zMin === -13, 'the chunk square is centred on the arena, not corner-anchored');
ok(chunk.xMin + chunk.size === 13 && chunk.zMin + chunk.size === 13, 'so the overspill is symmetric on both axes');
// An off-centre arena must still get a centred square.
const offset = floraChunk({ minX: 0, maxX: 12, minZ: 0, maxZ: 4 }, 0);
ok(offset.xMin === 0 && offset.zMin === -4, 'an off-centre arena is still centred in its own square');

// A padded rect and the square around it: the rect test is what rejects the overspill, and it has
// to be a separate test from isBlocked, which reports "not blocked" off the map because out there
// nothing is in the way.
const padded = { minX: -13, maxX: 13, minZ: -8, maxZ: 8 };
ok(inRect(padded, 0, 0) === true, 'inRect accepts the arena centre');
ok(inRect(padded, 0, 12) === false, 'inRect rejects a point past the arena edge');
ok(inRect(padded, 13, 8) === true, 'inRect includes its own boundary');
ok(isBlocked(buildBlockerIndex([], padded, 2), 0, 12) === false,
  'isBlocked alone would have KEPT that off-map point -- which is the bug inRect exists to fix');

ok(bladeBudget({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 10) === 1000, 'blade budget is density x area on a square arena');
// The request is sized to the SQUARE the generator scatters into (30 x 30), not the 30 x 10
// rectangle -- otherwise a long thin arena comes out three times too sparse.
ok(bladeBudget({ minX: 0, maxX: 30, minZ: 0, maxZ: 10 }, 10) === 9000, 'a rectangular arena is sized to its bounding square');
ok(bladeBudget({ minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 }, 40) === BLADE_CAP, 'the budget caps on a huge map');
// The cap is the ONLY way the density slider can lie: below it, achieved density must equal the
// density asked for at every map size. That equality is what the reported number rests on.
for (const span of [20, 60, 120, 166]) {
  const b = { minX: -span / 2, maxX: span / 2, minZ: -span / 2, maxZ: span / 2 };
  const built = bladeBudget(b, 26) / (span * span);
  ok(Math.abs(built - 26) < 0.01, `a ${span} m map builds at the density asked for (${built.toFixed(2)}/m2)`);
}
// And above it, it demonstrably does not — which is why the panel reports the built density.
const bigSpan = 300, big = { minX: 0, maxX: bigSpan, minZ: 0, maxZ: bigSpan };
ok(bladeBudget(big, 26) / (bigSpan * bigSpan) < 26 * 0.5,
  'past the ceiling a large map thins to well under the requested density');
ok(bladeBudget({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 0) === 0, 'density 0 asks for no blades');
ok(bladeBudget({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, 10) === 0, 'a degenerate arena asks for no blades');

// ─── wall affinity ──────────────────────────────────────────────────────────

// One 4 x 4 box at the origin, no clearance, in a 40 x 40 arena.
const affBounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const affIndex = buildBlockerIndex(blockerRects([{ x: 0, z: 0, w: 4, d: 4 }], 0), affBounds, 2);

ok(nearestBlockerDist(affIndex, 0, 0, 10) === 0, 'a point inside the box is at distance 0');
ok(Math.abs(nearestBlockerDist(affIndex, 5, 0, 10) - 3) < 1e-9, 'distance is measured to the box face, not its centre');
ok(Math.abs(nearestBlockerDist(affIndex, 2, 2, 10) - 0) < 1e-9, 'a corner point is at distance 0');
ok(Math.abs(nearestBlockerDist(affIndex, 5, 5, 10) - Math.hypot(3, 3)) < 1e-9, 'diagonal distance is the true corner distance');
ok(nearestBlockerDist(affIndex, 19, 19, 3) === 3, 'distance saturates at maxR rather than searching the whole map');
ok(nearestBlockerDist(null, 0, 0, 5) === 5, 'a null index reads as "nothing near"');

// The search radius must not change the answer inside it — that would mean cells are being missed.
let reachDisagreements = 0;
const rr = makeRng(7);
for (let i = 0; i < 1500; i++) {
  const x = (rr() - 0.5) * 30, z = (rr() - 0.5) * 30;
  const a = nearestBlockerDist(affIndex, x, z, 20);
  const b = nearestBlockerDist(affIndex, x, z, 25);
  if (Math.min(a, 20) !== Math.min(b, 20)) reachDisagreements++;
}
ok(reachDisagreements === 0, 'the distance below maxR is independent of maxR');

const mask = wallAffinityMask(affIndex, 2, 0.25);
ok(Math.abs(mask(2, 0) - 1) < 1e-9, 'the mask is full density right at the wall face');
ok(Math.abs(mask(10, 0) - 0.25) < 1e-9, 'and falls to the open-ground floor beyond the reach');
ok(mask(2.5, 0) > mask(3, 0) && mask(3, 0) > mask(3.5, 0), 'the mask decreases monotonically away from the wall');
ok(mask(3, 0) < 0.25 + (1 - 0.25) * 0.5,
  'falloff is quadratic, so the band hugs the wall instead of washing halfway across the map');
const flat = wallAffinityMask(affIndex, 2, 1);
ok(flat(2, 0) === 1 && flat(10, 0) === 1, 'an open-ground floor of 1 disables the affinity entirely');
let bounded = true;
for (let i = 0; i < 800; i++) {
  const v = mask((rr() - 0.5) * 30, (rr() - 0.5) * 30);
  if (!(v >= 0.25 - 1e-9 && v <= 1 + 1e-9)) bounded = false;
}
ok(bounded, 'the mask stays within [openFloor, 1] everywhere');

// ─── the theme ──────────────────────────────────────────────────────────────

ok(!!THEMES.ecobrutal, 'the ecobrutal theme exists');
ok(validateTheme(THEMES.ecobrutal).length === 0,
  `ecobrutal is a complete theme: ${validateTheme(THEMES.ecobrutal).join(', ')}`);

// The whole point of making concrete and flora OPTIONAL blocks is that the pre-existing themes
// are untouched. If either ever became required, this is what would catch it.
for (const key of Object.keys(THEMES)) {
  if (key === 'ecobrutal') continue;
  ok(concreteFor(THEMES[key].mats.wall).gain === 0, `${key} walls stay flat (concrete gain 0)`);
  ok(floraFor(THEMES[key]).grassDensity === 0, `${key} grows nothing`);
}

// Ground moss is the same optional-field pattern: read as `f.mossGain ?? 0`, so only ecobrutal
// carries it and the other six themes keep a bare floor.
ok(THEMES.ecobrutal.mats.floor.mossGain > 0, 'ecobrutal carpets the ground in moss');
for (const key of Object.keys(THEMES)) {
  if (key === 'ecobrutal') continue;
  ok(THEMES[key].mats.floor.mossGain === undefined, `${key} has no ground moss`);
}

const ecoWall = concreteFor(THEMES.ecobrutal.mats.wall);
ok(ecoWall.gain === 1, 'ecobrutal walls are concrete');
ok(ecoWall.mossGain > 0 && ecoWall.algaeGain > 0, 'ecobrutal walls take both moss and algae');
ok(concreteFor(THEMES.ecobrutal.mats.cover).mossGain > ecoWall.mossGain,
  'cover weathers harder than walls -- it sits at ground level in the wet');
ok(Object.keys(concreteFor(undefined)).length === Object.keys(CONCRETE_OFF).length,
  'concreteFor fills in every field for a theme with no block');
ok(Object.keys(floraFor(undefined)).length === Object.keys(FLORA_OFF).length,
  'floraFor fills in every field for a theme with no block');

const ecoFlora = floraFor(THEMES.ecobrutal);
ok(ecoFlora.grassDensity > 0 && ecoFlora.plantDensity > 0 && ecoFlora.vineDensity > 0,
  'ecobrutal grows grass, plants and vines');
ok(ecoFlora.clearance > 0, 'ecobrutal keeps growth off the wall faces');
ok(ecoFlora.plantOpenFloor < 1, 'ecobrutal plants favour the concrete over open ground');
// The default clump radius in plants-placement.js is chunk.size * 0.16, which on one arena-sized
// chunk is metres across and overlaps into flat scatter. An explicit radius is the whole point.
ok(ecoFlora.plantClumpRadius > 0 && ecoFlora.plantClumpRadius < 3,
  'ecobrutal sets a clump radius small enough that a clump reads as a clump');
ok(floraFor({}).plantOpenFloor === FLORA_OFF.plantOpenFloor,
  'a theme with no flora block still gets the mask fields, so wallAffinityMask never sees undefined');
// Per-species maps must survive as objects, not be shared between themes by reference.
ok(floraFor({}).speciesHeight && typeof floraFor({}).speciesHeight === 'object',
  'the per-species maps default to objects, so the panel can write into them');
// The panel writes straight into these maps, so a shared reference would let one theme's edit
// leak into FLORA_OFF and from there into every other theme.
const mapsA = floraFor({}), mapsB = floraFor({});
mapsA.speciesHeight.mint = 2.5;
ok(mapsB.speciesHeight.mint === undefined && FLORA_OFF.speciesHeight.mint === undefined,
  'per-species maps are copied per call, not aliased to FLORA_OFF');
ok(ecoFlora.vineClump >= 0 && ecoFlora.vineLeafiness > 0,
  'ecobrutal vines have a distribution and leafiness set');

const ecoToggles = togglesFor(THEMES.ecobrutal);
ok(ecoToggles.concrete && ecoToggles.flora, 'ecobrutal starts with concrete and flora on');
ok(!ecoToggles.trim && !ecoToggles.grid && !ecoToggles.scan && !ecoToggles.pulse,
  'ecobrutal has no neon at all');

// A look slot saved from ecobrutal has to survive the round trip, blocks included -- normalizeTheme
// backfills by REQUIRED, which these two are deliberately absent from.
const round = normalizeTheme(JSON.parse(JSON.stringify(THEMES.ecobrutal)));
ok(concreteFor(round.mats.wall).gain === 1, 'a saved ecobrutal keeps its concrete through normalizeTheme');
ok(floraFor(round).grassDensity > 0, 'a saved ecobrutal keeps its flora through normalizeTheme');
ok(validateTheme(round).length === 0, 'the round-tripped theme is still valid');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
