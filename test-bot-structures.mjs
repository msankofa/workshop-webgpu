// Node tests for bot-structures.js (maze carve + scattered structure generator).
// Run: node test-bot-structures.mjs
import { makeRng, generateMazeCells, mazeCellWalls, generateStructures, generateOne, STRUCTURE_DEFAULTS,
  kindsForMix, isPadOnlyKind, teamSideRegions, generateHomeBase, HOME_BASE_DEFAULTS } from './bot-structures.js';
import { buildNavGrid, findPath } from './nav-grid.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const inRect = (rc, x, z, margin = 0) =>
  Math.abs(x - rc.x) <= rc.w / 2 + margin && Math.abs(z - rc.z) <= rc.d / 2 + margin;

// ---- maze carve: fully connected, deterministic, and the wall emission matches the cells ----
{
  const cells = generateMazeCells(8, 6, { rng: makeRng(7) });
  ok(cells.length === 48, 'carve returns cols*rows cells');
  // A perfect maze reaches every cell from (0,0) through carved openings.
  const seen = new Set([0]), stack = [0];
  while (stack.length) {
    const k = stack.pop(), c = k % 8, r = (k / 8) | 0, cw = cells[k];
    const step = (nc, nr) => { const nk = nr * 8 + nc; if (!seen.has(nk)) { seen.add(nk); stack.push(nk); } };
    if (!cw.N && r > 0) step(c, r - 1);
    if (!cw.S && r < 5) step(c, r + 1);
    if (!cw.W && c > 0) step(c - 1, r);
    if (!cw.E && c < 7) step(c + 1, r);
  }
  ok(seen.size === 48, `every cell is reachable (got ${seen.size}/48)`);
  ok(cells.every((cw, k) => {
    const c = k % 8, r = (k / 8) | 0;
    return (r === 0 ? cw.N : true) && (r === 5 ? cw.S : true) && (c === 0 ? cw.W : true) && (c === 7 ? cw.E : true);
  }), 'the outer boundary stays sealed without entrances');

  const again = generateMazeCells(8, 6, { rng: makeRng(7) });
  ok(JSON.stringify(again) === JSON.stringify(cells), 'the same seed regenerates the identical maze');
  const other = generateMazeCells(8, 6, { rng: makeRng(8) });
  ok(JSON.stringify(other) !== JSON.stringify(cells), 'a different seed gives a different maze');

  const opened = generateMazeCells(8, 6, { entrances: 3, rng: makeRng(7) });
  let gaps = 0;
  for (let c = 0; c < 8; c++) { if (!opened[c].N) gaps++; if (!opened[5 * 8 + c].S) gaps++; }
  for (let r = 0; r < 6; r++) { if (!opened[r * 8].W) gaps++; if (!opened[r * 8 + 7].E) gaps++; }
  ok(gaps === 3, `entrances punch exactly that many boundary gaps (got ${gaps})`);

  const walls = mazeCellWalls(cells, 8, 6, { cell: 3, originX: -12, originZ: -9, wallT: 0.3 });
  ok(walls.length > 20 && walls.every(w => w.w > 0 && w.d > 0), 'wall emission produces positive-extent rects');
  const ring = mazeCellWalls(cells, 8, 6, { cell: 3, originX: -12, originZ: -9, wallT: 0.3, ringOnly: true });
  ok(ring.length === 8 * 2 + 6 * 2, `ringOnly emits just the perimeter (got ${ring.length})`);
  ok(ring.length < walls.length, 'the ring is a strict subset of the full carve');
}

// ---- structures: separated, inside bounds, clear of the avoid list, deterministic ----
{
  const bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
  const avoid = [{ x: -50, z: -50, radius: 3 }, { x: 50, z: 50, radius: 3 }];
  const out = generateStructures(bounds, { seed: 5, count: 8 }, avoid);
  console.log(`structures: ${out.placed.length} placed, ${out.walls.length} walls, ${out.covers.length} covers, ${out.pads.length} pads`);

  ok(out.placed.length > 0, 'structures actually get placed on a roomy map');
  for (const s of out.placed) {
    ok(s.x - s.radius >= bounds.minX && s.x + s.radius <= bounds.maxX
      && s.z - s.radius >= bounds.minZ && s.z + s.radius <= bounds.maxZ, `${s.kind} footprint stays inside bounds`);
    for (const a of avoid) {
      ok(Math.hypot(s.x - a.x, s.z - a.z) >= s.radius + a.radius, `${s.kind} keeps clear of the avoid circle`);
    }
  }
  for (let i = 0; i < out.placed.length; i++) {
    for (let j = i + 1; j < out.placed.length; j++) {
      const a = out.placed[i], b = out.placed[j];
      ok(Math.hypot(a.x - b.x, a.z - b.z) >= a.radius + b.radius, 'placed structures never overlap');
    }
  }
  ok(out.walls.every(w => w.w > 0 && w.d > 0) && out.covers.every(c => c.w > 0 && c.d > 0 && c.h > 0),
    'every emitted rect has positive extents');
  ok(out.pads.every(p => p.radius > 0), 'pads carry a positive radius');

  const same = generateStructures(bounds, { seed: 5, count: 8 }, avoid);
  ok(JSON.stringify(same) === JSON.stringify(out), 'the same seed rebuilds the identical scatter');
  ok(JSON.stringify(generateStructures(bounds, { seed: 6, count: 8 }, avoid)) !== JSON.stringify(out),
    'a different seed scatters differently');
}

// ---- mix filters pick only their own kind; a tiny map degrades gracefully ----
{
  const bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
  for (const [mix, kind] of [['buildings', 'building'], ['pockets', 'pocket'], ['obstacles', 'obstacles']]) {
    const out = generateStructures(bounds, { seed: 3, count: 5, mix });
    ok(out.placed.length > 0 && out.placed.every(s => s.kind === kind), `mix '${mix}' places only ${kind}s`);
  }
  const buildings = generateStructures(bounds, { seed: 3, count: 4, mix: 'buildings' });
  ok(buildings.walls.length >= buildings.placed.length * 4, 'each building contributes at least four wall runs');
  ok(buildings.pads.length === buildings.placed.length, 'each building asks for a level pad');

  const obstacles = generateStructures(bounds, { seed: 11, count: 4, mix: 'obstacles' });
  ok(obstacles.walls.length === 0, 'obstacle fields emit no full-height walls');
  ok(obstacles.covers.some(c => c.h >= 1.5) && obstacles.covers.some(c => c.h < 1.5),
    'obstacle fields mix sight-blocking and shoot-over heights');

  const tiny = generateStructures({ minX: -3, maxX: 3, minZ: -3, maxZ: 3 }, { seed: 1, count: 5 });
  ok(tiny.placed.length === 0 && tiny.walls.length === 0, 'a map smaller than the edge margin places nothing');
  ok(generateStructures(bounds, { seed: 1, count: 0 }).placed.length === 0, 'count 0 is a no-op');
}

// ---- the point of the doorways: a building interior stays reachable from outside ----
{
  const bounds = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
  const out = generateStructures(bounds, { seed: 21, count: 3, mix: 'buildings' });
  const blockers = [...out.walls, ...out.covers];
  const grid = buildNavGrid((x, z) => !blockers.some(rc => inRect(rc, x, z, 0.55)), bounds, 0.5);
  for (const s of out.placed) {
    const path = findPath(grid, { x: bounds.minX + 1, z: bounds.minZ + 1 }, { x: s.x, z: s.z });
    ok(path !== null && path.length > 0, `building at ${s.x.toFixed(1)},${s.z.toFixed(1)} is reachable through its doorway`);
  }
}

// ---- side mode: one half of the map per team, with a home compound facing the fight ----
{
  const bounds = { minX: -30, maxX: 30, minZ: -50, maxZ: 50 };   // long axis is Z
  const regions = teamSideRegions(bounds, ['alpha', 'bravo']);
  const a = regions.get('alpha'), b = regions.get('bravo');
  ok(a.axis === 'z' && b.axis === 'z', 'the map is split across its long axis');
  ok(a.z < 0 && b.z > 0, 'the two homes sit on opposite sides of the middle');
  ok(a.facing === 1 && b.facing === -1, 'each base looks in toward the map, not out of it');
  ok(a.min === bounds.minZ && a.max === 0 && b.min === 0 && b.max === bounds.maxZ, 'the sides partition the map');
  ok(Math.abs(a.x) < 1e-9 && Math.abs(b.x) < 1e-9, 'homes are centred across the short axis');
  ok(a.z > bounds.minZ && b.z < bounds.maxZ, 'homes are set in off the outer wall');

  const wide = teamSideRegions({ minX: -50, maxX: 50, minZ: -20, maxZ: 20 });
  ok(wide.get('alpha').axis === 'x' && wide.get('alpha').x < 0, 'a wide map splits along X instead');

  for (const [team, region] of regions) {
    const base = generateHomeBase(region);
    ok(base.walls.length >= 5, `${team} base is a shell, not a single wall`);
    ok(base.covers.length === 2, `${team} base has cover at its gateway`);
    ok(base.pad && base.pad.radius > 0, `${team} base levels the ground under it`);
    // Every wall box must be axis-aligned and sit inside the compound's own footprint.
    const half = HOME_BASE_DEFAULTS.width / 2 + HOME_BASE_DEFAULTS.wallT;
    const reach = HOME_BASE_DEFAULTS.depth / 2 + HOME_BASE_DEFAULTS.wallT;
    for (const w of base.walls) {
      ok(w.w > 0 && w.d > 0, `${team} wall has a real footprint`);
      ok(Math.abs(w.x - region.x) <= half + 0.01 && Math.abs(w.z - region.z) <= reach + 0.01,
        `${team} wall stays inside the compound`);
    }
    // The gateway: the front side must be broken by a gap the door's width, centred on the base.
    const frontZ = region.z + region.facing * HOME_BASE_DEFAULTS.depth / 2;
    const frontWalls = base.walls.filter((w) => Math.abs(w.z - frontZ) < 0.01);
    ok(frontWalls.length === 2, `${team} front wall is split by a gateway`);
    const opening = HOME_BASE_DEFAULTS.width - frontWalls.reduce((sum, w) => sum + w.w, 0);
    ok(Math.abs(opening - HOME_BASE_DEFAULTS.doorWidth) < 0.01, `${team} gateway is the door's width`);
    ok(frontWalls.every((w) => Math.abs(w.x - region.x) > HOME_BASE_DEFAULTS.doorWidth / 2 - 0.01),
      `${team} gateway is clear of wall`);
  }
}

// ---- elevated slabs: lintels, canopies, portal decks ----------------------------------------
{
  const bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
  const built = generateStructures(bounds, { seed: 5, count: 30, mix: 'mixed', wallHeight: 3 }, []);
  ok(Array.isArray(built.slabs), 'generateStructures returns a slabs list');
  ok(built.slabs.length > 0, 'a mixed map of 30 structures produces some elevated geometry');

  // The invariant that matters: a slab you cannot walk under is a trap, because slabs are absent
  // from the nav grid by design, so a bot will happily path straight into one.
  const STANDING = 1.8;
  ok(built.slabs.every(s => s.y >= STANDING),
    `every slab clears a standing bot (lowest underside ${Math.min(...built.slabs.map(s => s.y)).toFixed(2)} m)`);
  ok(built.slabs.every(s => s.h > 0 && s.w > 0 && s.d > 0), 'every slab has positive extent');
  ok(built.slabs.every(s => Number.isFinite(s.x) && Number.isFinite(s.z)), 'every slab is positioned');

  // A lintel must reach the wall top, or the opening reads as a slot with a floating bar over it.
  const lintels = built.slabs.filter(s => Math.abs(s.y + s.h - 3) < 1e-6);
  ok(lintels.length > 0, 'openings emit lintels that meet the wall top exactly');

  // Portals: two piers and a deck spanning them, and the deck must sit ON the piers.
  const portals = generateStructures(bounds, { seed: 9, count: 6, mix: 'portals', wallHeight: 3 }, []);
  ok(portals.slabs.length > 0 && portals.walls.length > 0, 'portals emit both piers and a deck');
  ok(portals.covers.length === 0, 'a portal is piers and a deck, nothing else');
  ok(portals.slabs.every(s => Math.abs(s.y - 3) < 1e-6), 'every portal deck rests on its piers');
  ok(portals.walls.length === portals.slabs.length * 2, 'each portal deck is carried by exactly two piers');

  // Windows: a sill is cover (blocks movement, shoot over it), so it must be below chest height.
  const many = generateStructures(bounds, { seed: 31, count: 20, mix: 'buildings', wallHeight: 3 }, []);
  const sills = many.covers.filter(c => Math.abs(c.h - STRUCTURE_DEFAULTS.windowSill) < 1e-6);
  ok(sills.length > 0, 'buildings emit window sills');
  ok(sills.every(c => c.h < 1.2), 'a sill stays low enough to shoot over');

  // Determinism, same contract as the rest of the generator.
  const a = generateStructures(bounds, { seed: 77, count: 8, wallHeight: 3 }, []);
  const b = generateStructures(bounds, { seed: 77, count: 8, wallHeight: 3 }, []);
  ok(JSON.stringify(a.slabs) === JSON.stringify(b.slabs), 'slab output is deterministic for a seed');

  // wallHeight is the viewer's live WALL_H, so lintels have to track it rather than assume 3.
  // Count raised 2026-08-11 when KINDS reached nine: at 14 a mixed map can place no lintel-bearing
  // kind at all, and the assertion below then passes or fails on the draw rather than on the code.
  const tall = generateStructures(bounds, { seed: 5, count: 30, mix: 'mixed', wallHeight: 5 }, []);
  ok(tall.slabs.some(s => Math.abs(s.y + s.h - 5) < 1e-6), 'lintels follow a changed wallHeight');
}

// ---- seed stability: changing one parameter must change only what it governs -------------------
// The whole point of a structure viewer is "fix a seed, drag one slider, see what it does". Before
// per-structure RNG streams, raising roofChance turned buildings into pockets, because every draw
// downstream shifted. These assertions are that regression test.
//
// The fixture is chosen, not arbitrary: it must place several buildings across several kinds, and
// the pre-fix generator must actually reshuffle under both probability changes. On a roomy map with
// few buildings these assertions pass either way and prove nothing.
{
  const bounds = { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
  // Re-chosen 2026-08-11 when KINDS went from four to eight: buildings got rarer per structure, so
  // the old count-14 fixture stopped containing enough of them to make these assertions bite.
  const base = { seed: 2, count: 24, mix: 'mixed', wallHeight: 3 };
  const gen = (over = {}) => generateStructures(bounds, { ...base, ...over }, []);
  const j = (v) => JSON.stringify(v);
  const ref = gen();
  ok(ref.placed.filter(s => s.kind === 'building').length >= 3
    && new Set(ref.placed.map(s => s.kind)).size >= 6,
    `the stability fixture has buildings and variety (${ref.placed.length} placed)`);

  // Canopies are the case that used to reshuffle the entire field.
  const roofy = gen({ roofChance: 0.9 });
  ok(j(roofy.placed) === j(ref.placed), 'roofChance leaves kinds and placement untouched');
  ok(j(roofy.walls) === j(ref.walls), 'roofChance leaves walls untouched');
  ok(j(roofy.covers) === j(ref.covers), 'roofChance leaves covers untouched');
  ok(j(roofy.slabs) !== j(ref.slabs), 'roofChance does change the canopies it governs');

  // Windows legitimately change walls (a pierced side is two runs), but not the footprint, so the
  // scatter must not move.
  const noWin = gen({ windowChance: 0 });
  ok(j(noWin.placed) === j(ref.placed), 'windowChance leaves kinds and placement untouched');
  ok(j(noWin.walls) !== j(ref.walls), 'windowChance does change the wall runs it governs');
  ok(noWin.covers.every(c => Math.abs(c.h - STRUCTURE_DEFAULTS.windowSill) > 1e-6),
    'windowChance 0 emits no sills');

  // doorWidth was already stable before the fix; it is the control case.
  ok(j(gen({ doorWidth: 2.6 }).placed) === j(ref.placed), 'doorWidth leaves placement untouched');

  // Obstacle heights are a pure post-roll classification, so only the heights may move.
  const oBase = { seed: 11, count: 6, mix: 'obstacles' };
  const oRef = generateStructures(bounds, oBase, []);
  const oTall = generateStructures(bounds, { ...oBase, tallShare: 0.95 }, []);
  ok(j(oTall.placed) === j(oRef.placed), 'tallShare leaves obstacle-field placement untouched');
  ok(j(oTall.covers.map(c => [c.x, c.z, c.w, c.d])) === j(oRef.covers.map(c => [c.x, c.z, c.w, c.d])),
    'tallShare leaves obstacle positions and sizes untouched');
  ok(j(oTall.covers.map(c => c.h)) !== j(oRef.covers.map(c => c.h)), 'tallShare does change heights');

  // Per-structure streams mean structure i cannot depend on structures after it.
  const more = gen({ count: 30 });
  ok(more.placed.length >= ref.placed.length, 'raising count never places fewer');
  ok(j(more.placed.slice(0, ref.placed.length)) === j(ref.placed),
    'raising count leaves the structures already there untouched');

  // The honest limit, asserted so it is not mistaken for a bug later: a change that resizes a
  // footprint still moves later structures, because placement is rejection-sampled against them.
  ok(j(gen({ buildingMax: 20 }).placed) !== j(ref.placed),
    'a footprint change is still allowed to move later structures');
}

// ---- the 2026-08-11 kinds: colonnade, slot, rampart, corner ------------------------------------
{
  const P = STRUCTURE_DEFAULTS;
  const SIGHT_BLOCK_HEIGHT = 1.5;   // nav-visibility.js:8
  const WALL_MARGIN = 0.55;         // bot-viewer-v3.html: capsule radius 0.3 + half a nav cell
  const NAV_CELL = 0.5;

  // Colonnade: posts are covers, because only covers carry a per-record height. A post emitted as
  // a wall would be forced to the global WALL_H and the whole idea collapses into a maze.
  for (let seed = 1; seed <= 40; seed++) {
    const c = generateOne('colonnade', { wallHeight: 3 }, seed);
    ok(c.walls.length === 0, 'a colonnade emits no walls, only posts and an optional soffit');
    ok(c.covers.length >= 4, `a colonnade is a grid, not a pair (${c.covers.length} posts)`);
    ok(c.covers.every(p => p.h >= SIGHT_BLOCK_HEIGHT),
      'every post blocks sight, so the grid yields cover corners');
    // A post narrower than a nav cell can fall between samples; the margin is what saves it.
    ok(c.covers.every(p => p.w + WALL_MARGIN * 2 > NAV_CELL && p.d + WALL_MARGIN * 2 > NAV_CELL),
      'every post is wide enough that the nav raster cannot miss it');
    ok(c.covers.every(p => Math.hypot(p.x, p.z) <= c.radius + 1e-9), 'posts stay inside the reported radius');
    if (c.slabs.length) ok(c.slabs.every(s => s.y >= 1.8), 'a colonnade soffit clears a standing bot');
  }

  // Slot: the gap has to stay walkable. Both walls inflate by WALL_MARGIN in the nav raster, so a
  // gap under 2*WALL_MARGIN is not a corridor at all -- it is a solid block that looks like one.
  const MIN_CLEAR = 0.5;
  for (let seed = 1; seed <= 40; seed++) {
    const s = generateOne('slot', { wallHeight: 3 }, seed);
    ok(s.walls.length === 2, 'a slot is exactly two walls');
    ok(s.covers.length === 0 && s.slabs.length === 0, 'a slot has nothing in it — that is the point');
    const alongX = s.walls[0].w > s.walls[0].d;
    const gap = alongX
      ? Math.abs(s.walls[1].z - s.walls[0].z) - P.wallT
      : Math.abs(s.walls[1].x - s.walls[0].x) - P.wallT;
    ok(gap - WALL_MARGIN * 2 >= MIN_CLEAR,
      `the slot stays walkable (${gap.toFixed(2)} m gap leaves ${(gap - WALL_MARGIN * 2).toFixed(2)} m clear)`);
  }
  ok(P.slotGapMin - WALL_MARGIN * 2 >= MIN_CLEAR,
    `slotGapMin itself is above the nav margin (${P.slotGapMin} m vs ${(WALL_MARGIN * 2 + MIN_CLEAR).toFixed(2)} m floor)`);

  // Rampart: a long wall, a soffit that must clear a standing bot, and buttresses on both faces.
  let sawSoffit = false;
  for (let seed = 1; seed <= 40; seed++) {
    const r = generateOne('rampart', { wallHeight: 3 }, seed);
    ok(r.walls.length === 1, 'a rampart is one long wall');
    ok(r.walls[0].w >= P.rampartMin || r.walls[0].d >= P.rampartMin, 'the rampart wall is actually long');
    ok(r.covers.length === 2 && r.covers.every(c => c.h >= SIGHT_BLOCK_HEIGHT),
      'the buttresses are sight-blocking, so they yield the free corners the wall itself does not');
    if (r.slabs.length) { sawSoffit = true; ok(r.slabs[0].y >= 1.8, 'the soffit clears a standing bot'); }
  }
  ok(sawSoffit, 'some ramparts get their soffit');

  // Corner: two walls meeting, with the nook inside the elbow rather than outside it.
  for (let seed = 1; seed <= 40; seed++) {
    const c = generateOne('corner', { wallHeight: 3 }, seed);
    ok(c.walls.length === 2, 'a corner is exactly two walls');
    const [a, b] = c.walls;
    ok((a.w > a.d) !== (b.w > b.d), 'the two arms are perpendicular');
    ok(c.covers.length === 2, 'the nook is furnished');
    // The covers must sit inside the L's bounding box, not out in the open behind it.
    const minX = Math.min(a.x - a.w / 2, b.x - b.w / 2), maxX = Math.max(a.x + a.w / 2, b.x + b.w / 2);
    const minZ = Math.min(a.z - a.d / 2, b.z - b.d / 2), maxZ = Math.max(a.z + a.d / 2, b.z + b.d / 2);
    ok(c.covers.every(cv => cv.x >= minX && cv.x <= maxX && cv.z >= minZ && cv.z <= maxZ),
      'the nook cover sits inside the elbow, not behind the wall');
    ok(c.covers.some(cv => cv.h >= SIGHT_BLOCK_HEIGHT) && c.covers.some(cv => cv.h < SIGHT_BLOCK_HEIGHT),
      'the nook mixes a sight-blocker with shoot-over cover');
  }

  // All four scatter, and each mix filter picks only its own.
  const bounds = { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
  for (const [mix, kind] of [['colonnades', 'colonnade'], ['slots', 'slot'], ['ramparts', 'rampart'], ['corners', 'corner']]) {
    const out = generateStructures(bounds, { seed: 4, count: 6, mix, wallHeight: 3 }, []);
    ok(out.placed.length > 0 && out.placed.every(s => s.kind === kind), `mix '${mix}' places only ${kind}s`);
  }
  const mixed = generateStructures(bounds, { seed: 4, count: 40, mix: 'mixed', wallHeight: 3 }, []);
  const kinds = new Set(mixed.placed.map(s => s.kind));
  ok(kinds.size >= 6, `a big mixed map draws on most of the eight kinds (got ${[...kinds].sort().join(', ')})`);
}

// ---- generateOne: one specimen, same builders, same seed contract ------------------------------
{
  for (const kind of ['building', 'pocket', 'obstacles', 'portal', 'colonnade', 'slot', 'rampart', 'corner']) {
    const a = generateOne(kind, { wallHeight: 3 }, 42);
    const b = generateOne(kind, { wallHeight: 3 }, 42);
    ok(a !== null, `generateOne builds a ${kind}`);
    ok(JSON.stringify(a) === JSON.stringify(b), `generateOne is deterministic for a ${kind} seed`);
    ok(JSON.stringify(generateOne(kind, { wallHeight: 3 }, 43)) !== JSON.stringify(a),
      `a different seed gives a different ${kind}`);
    ok(Array.isArray(a.walls) && Array.isArray(a.covers) && Array.isArray(a.slabs),
      `${kind} always returns all three geometry lists`);
    ok(a.radius > 0, `${kind} reports a footprint radius`);
    // Centred on the requested point by default, and movable.
    const off = generateOne(kind, { wallHeight: 3 }, 42, { x: 100, z: -40 });
    const shift = (rc, i, list) => Math.abs(rc.x - (a[list][i].x + 100)) < 1e-9
      && Math.abs(rc.z - (a[list][i].z - 40)) < 1e-9;
    ok(off.walls.every((rc, i) => shift(rc, i, 'walls')) && off.covers.every((rc, i) => shift(rc, i, 'covers')),
      `${kind} translates rigidly to a requested position`);
  }
  ok(generateOne('nope', {}, 1) === null, 'an unknown kind returns null rather than throwing');
}

// ---- padTerrain: a pad-only kind is invisible without terrain, so Mixed must drop it ----
{
  const bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
  const base = { count: 8, wallHeight: 3, wallT: 0.4 };

  // The premise, measured rather than assumed: terrace really does emit no geometry at all.
  const solo = generateStructures(bounds, { ...base, seed: 3, count: 6, mix: 'terraces' }, []);
  ok(solo.placed.length > 0, 'a terraces-only map places something');
  ok(solo.walls.length === 0 && solo.covers.length === 0 && solo.slabs.length === 0 && solo.pads.length > 0,
    'a terrace emits terrain pads and no geometry whatsoever');
  ok(isPadOnlyKind('terrace') && !isPadOnlyKind('building'), 'terrace is flagged pad-only, building is not');

  // Without terrain, Mixed must not place one -- over many seeds, not one lucky draw.
  let withTerrain = 0, withoutTerrain = 0, total = 0;
  for (let seed = 1; seed <= 60; seed++) {
    for (const s of generateStructures(bounds, { ...base, seed, mix: 'mixed', padTerrain: true }, []).placed) {
      total++; if (s.kind === 'terrace') withTerrain++;
    }
    for (const s of generateStructures(bounds, { ...base, seed, mix: 'mixed', padTerrain: false }, []).placed) {
      if (s.kind === 'terrace') withoutTerrain++;
    }
  }
  ok(withTerrain > 0, `Mixed places terraces when terrain is on (${withTerrain}/${total} placements)`);
  ok(withoutTerrain === 0, `Mixed places NO terraces when terrain is off (got ${withoutTerrain})`);

  // ...but a mix that named the kind still gets it. An empty map is a worse answer than a flat one.
  const named = generateStructures(bounds, { ...base, seed: 3, count: 6, mix: 'terraces', padTerrain: false }, []);
  ok(named.placed.length > 0 && named.placed.every(s => s.kind === 'terrace'),
    'asking for Terraces by name still places them with terrain off');

  // The dropped list is what a UI needs to explain itself instead of silently shrinking the pool.
  ok(kindsForMix({ mix: 'mixed', padTerrain: false }).dropped.includes('terrace'), 'kindsForMix reports what it dropped');
  ok(kindsForMix({ mix: 'mixed', padTerrain: true }).dropped.length === 0, 'and drops nothing when terrain is on');
  ok(generateStructures(bounds, { ...base, seed: 1, mix: 'mixed', padTerrain: false }, []).dropped.includes('terrace'),
    'generateStructures passes that through to the caller');

  // Default must stay permissive, or every existing caller silently loses a kind.
  ok(STRUCTURE_DEFAULTS.padTerrain === true, 'padTerrain defaults to true');
  const def = generateStructures(bounds, { ...base, seed: 7, mix: 'mixed' }, []);
  const explicit = generateStructures(bounds, { ...base, seed: 7, mix: 'mixed', padTerrain: true }, []);
  ok(JSON.stringify(def.placed) === JSON.stringify(explicit.placed), 'omitting it matches passing true');
}

// ---- the viewers' mix dropdowns must offer every kind the generator can build ----
// This is the check that was missing: five kinds shipped between 2026-08-10 and 2026-08-11 and
// bot-viewer-v3's dropdown still listed the original four, so they were only ever reachable by
// accident under Mixed. Reachability is resolved THROUGH the generator, not by guessing plurals
// ('obstacles' is already plural), so a new mix key cannot pass by looking right.
{
  const src = { 'bot-viewer-v3.html': null, 'structure-viewer.html': null };
  for (const f of Object.keys(src)) src[f] = readFileSync(new URL(f, import.meta.url), 'utf8');
  const allKinds = kindsForMix({ mix: 'mixed', padTerrain: true }).kinds;
  const bounds = { minX: -80, maxX: 80, minZ: -80, maxZ: 80 };

  for (const [file, text] of Object.entries(src)) {
    // every quoted token in the file that names a real, non-'mixed' mix the generator understands
    const offered = new Set();
    for (const m of text.matchAll(/'([a-z]+)'/g)) {
      const key = m[1];
      if (key === 'mixed' || offered.has(key)) continue;
      const resolved = kindsForMix({ mix: key, padTerrain: true }).kinds;
      // an unknown key falls back to the full pool, so only a genuine single-kind mix counts
      if (resolved.length === 1) offered.add(key);
    }
    const reachable = new Set();
    for (const key of offered) {
      for (const s of generateStructures(bounds, { seed: 4, count: 6, mix: key, wallHeight: 3 }, []).placed) {
        reachable.add(s.kind);
      }
    }
    const missing = allKinds.filter(k => !reachable.has(k));
    ok(missing.length === 0,
      `${file} offers a mix for every kind (missing: ${missing.join(', ') || 'none'})`);
  }
}

// ---- the `site` hook: structures conform to imported ground instead of flattening pads ----
{
  const bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
  const base = { seed: 11, count: 8, mix: 'mixed', wallHeight: 3 };

  // A slope that rises with x, exactly as map-surfaces#footprintAt would report it.
  const slopeSite = (cx, _cz, w) => ({ floorY: (cx + w / 2) * 0.05, skirtDepth: w * 0.05 });
  const seated = generateStructures(bounds, { ...base, site: slopeSite }, []);

  ok(seated.placed.length > 0, 'site hook still places structures');
  ok(seated.pads.length === 0, 'pads are suppressed on imported ground');
  ok(seated.placed.every(s => typeof s.floorY === 'number'), 'every placement reports its floor');
  ok(seated.placed.every(s => typeof s.skirtDepth === 'number'), 'every placement reports its skirt');

  // Geometry actually rides the seat: a structure on the high side sits above one on the low side.
  const byX = [...seated.placed].sort((a, b) => a.x - b.x);
  ok(byX[0].floorY < byX[byX.length - 1].floorY, 'floors follow the slope');
  const hiWalls = seated.walls.filter(r => r.x > 30);
  ok(hiWalls.length === 0 || hiWalls.every(r => r.y > 0), 'walls up-slope are lifted off y=0');

  // A site that always refuses places nothing rather than dropping structures into a void.
  const refused = generateStructures(bounds, { ...base, site: () => null }, []);
  ok(refused.placed.length === 0, 'an unbuildable map places nothing');
  ok(refused.walls.length === 0, 'and emits no geometry');

  // Refusing SOME sites must not corrupt the rest: survivors still respect minSeparation.
  const patchy = generateStructures(bounds, {
    ...base, count: 12, site: (cx, cz, w, d) => (cx < 0 ? null : { floorY: 2, skirtDepth: 0 }),
  }, []);
  ok(patchy.placed.every(s => s.x >= 0), 'refused half of the map is respected');
  ok(patchy.placed.every(s => s.floorY === 2), 'survivors carry the seat they were given');
  let overlaps = 0;
  for (let i = 0; i < patchy.placed.length; i++) {
    for (let j = i + 1; j < patchy.placed.length; j++) {
      const a = patchy.placed[i], b = patchy.placed[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < a.radius + b.radius) overlaps++;
    }
  }
  ok(overlaps === 0, 'partial refusal never produces overlapping structures');

  // Without the hook nothing changes: same seed, same map, pads back on.
  const plain = generateStructures(bounds, base, []);
  ok(plain.pads.length > 0, 'pads still emitted when the ground is ours to shape');
  ok(plain.walls.every(r => (r.y || 0) === 0), 'and no lift is applied');
  ok(plain.foundations.length === 0, 'and no foundations without a seat');

  // ---- foundations: the block that carries a seated structure down to grade ----
  const bury = STRUCTURE_DEFAULTS.foundationBury;
  ok(seated.foundations.length === seated.placed.length, 'one foundation per seated structure');

  // The whole point: the foundation reaches from the floor down past the lowest ground sample, so
  // nothing hangs in the air on the downhill side.
  for (let i = 0; i < seated.placed.length; i++) {
    const s = seated.placed[i], f = seated.foundations[i];
    ok(Math.abs((f.y + f.h) - s.floorY) < 1e-9, 'foundation top meets the seated floor');
    ok(Math.abs(f.h - (s.skirtDepth + bury)) < 1e-9, 'foundation spans the skirt plus the bury');
    ok(f.y < s.floorY - s.skirtDepth, 'and sinks below the lowest sample');
  }

  // Flat ground still gets a foundation -- only the bury -- so a structure meets grade cleanly.
  const flatSeated = generateStructures(bounds, {
    ...base, site: () => ({ floorY: 5, skirtDepth: 0 }),
  }, []);
  ok(flatSeated.foundations.length > 0, 'flat ground still gets a foundation');
  ok(flatSeated.foundations.every(f => Math.abs(f.h - bury) < 1e-9), 'sized by the bury alone');
  ok(flatSeated.foundations.every(f => Math.abs((f.y + f.h) - 5) < 1e-9), 'topping out at the floor');

  // Sized from the real XZ extent, not the radius circle: a foundation must cover its structure
  // without ballooning to the diagonal of a long thin one.
  for (const kind of ['buildings', 'colonnades', 'obstacles']) {
    const one = generateStructures(bounds, {
      seed: 3, count: 1, mix: kind, wallHeight: 3, site: () => ({ floorY: 0, skirtDepth: 0 }),
    }, []);
    if (!one.foundations.length) continue;
    const f = one.foundations[0];
    const rects = [...one.walls, ...one.covers, ...one.slabs];
    ok(rects.every(r => r.x - r.w / 2 >= f.x - f.w / 2 - 1e-9 && r.x + r.w / 2 <= f.x + f.w / 2 + 1e-9),
      `${kind}: foundation covers the structure in x`);
    ok(rects.every(r => r.z - r.d / 2 >= f.z - f.d / 2 - 1e-9 && r.z + r.d / 2 <= f.z + f.d / 2 + 1e-9),
      `${kind}: foundation covers the structure in z`);
  }

  // NOTE: a structure's declared `radius` under-reports its true XZ extent for several kinds --
  // buildings 5.46 vs 5.24, obstacles 6.54 vs 6.00, colonnades 5.22 vs 3.84 -- because roof
  // canopies and scattered cover push past the core shape the radius was measured from. The
  // default minSeparation of 5 m absorbs it, so the invariant worth pinning is that foundations
  // never actually collide, not that they fit inside the declared circle.
  {
    const dense = generateStructures(bounds, {
      ...base, count: 14, site: () => ({ floorY: 0, skirtDepth: 0 }),
    }, []);
    let collisions = 0;
    for (let i = 0; i < dense.foundations.length; i++) {
      for (let j = i + 1; j < dense.foundations.length; j++) {
        const a = dense.foundations[i], b = dense.foundations[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2) collisions++;
      }
    }
    ok(collisions === 0, `foundations never overlap each other (${collisions} collisions)`);
  }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-structures: all assertions passed');
