// bot-structures.js — pure, THREE-free map-content generators shared by the bot viewers.
// Node-tested in test-bot-structures.mjs. Two halves:
//   1. the maze carve + wall emission that bot-viewer-v2's full-map maze layout uses, and
//   2. generateStructures: islands of content (buildings, maze pockets, obstacle fields) scattered
//      across an otherwise empty map, which is what makes a large open terrain worth fighting on.
// Everything is seeded: the same (seed, params, bounds) always rebuilds the identical map.

// mulberry32 PRNG: deterministic float in [0,1) from an integer seed.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer mix (splitmix-style finaliser): distinct (seed, index, salt) triples give uncorrelated
// streams, so structure i's rolls do not depend on how many draws structures 0..i-1 consumed.
export function streamSeed(seed, index, salt) {
  let h = (seed >>> 0) ^ Math.imul(index + 1, 0x9E3779B1) ^ Math.imul(salt + 1, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  return (h ^ (h >>> 16)) >>> 0;
}

// n draws up front, so a branch can read its slot whether or not it fires.
function draws(rng, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = rng();
  return out;
}

// Recursive-backtracker maze carve: iterative DFS over a seeded RNG. Produces long, winding,
// dead-end-heavy corridors by default. straightness biases the DFS toward continuing its current
// heading; loopChance punches random internal walls (alternate routes); braid removes dead ends.
// Returns cols*rows cells of {N,S,E,W} booleans, true = wall standing.
export function generateMazeCells(cols, rows, { loopChance = 0, straightness = 0, braid = 0, rooms = { count: 0, size: 3 }, entrances = 0, rng = Math.random } = {}) {
  const idx = (c, r) => r * cols + c;
  const openCount = (cw) => (cw.N ? 0 : 1) + (cw.S ? 0 : 1) + (cw.E ? 0 : 1) + (cw.W ? 0 : 1);
  const cells = Array.from({ length: cols * rows }, () => ({ N: true, S: true, E: true, W: true }));
  const visited = new Array(cols * rows).fill(false);
  const stack = [{ c: 0, r: 0, dir: null }];
  visited[0] = true;
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const { c, r } = top;
    const options = [];
    if (r > 0 && !visited[idx(c, r - 1)]) options.push({ c, r: r - 1, dir: 'N', opp: 'S' });
    if (r < rows - 1 && !visited[idx(c, r + 1)]) options.push({ c, r: r + 1, dir: 'S', opp: 'N' });
    if (c > 0 && !visited[idx(c - 1, r)]) options.push({ c: c - 1, r, dir: 'W', opp: 'E' });
    if (c < cols - 1 && !visited[idx(c + 1, r)]) options.push({ c: c + 1, r, dir: 'E', opp: 'W' });
    if (options.length === 0) { stack.pop(); continue; }
    let pick = null;
    if (straightness > 0 && top.dir && rng() < straightness) pick = options.find((o) => o.dir === top.dir) || null;
    if (!pick) pick = options[Math.floor(rng() * options.length)];
    cells[idx(c, r)][pick.dir] = false;
    cells[idx(pick.c, pick.r)][pick.opp] = false;
    visited[idx(pick.c, pick.r)] = true;
    stack.push({ c: pick.c, r: pick.r, dir: pick.dir });
  }
  // Room pass: merge NxN blocks of cells into open arenas by clearing their internal walls. Each
  // block's cells were already on the connected backbone, so the arena stays reachable.
  if (rooms.count > 0 && rooms.size >= 2) {
    const w = Math.min(rooms.size, cols), h = Math.min(rooms.size, rows);
    for (let n = 0; n < rooms.count; n++) {
      const c0 = Math.floor(rng() * (cols - w + 1)), r0 = Math.floor(rng() * (rows - h + 1));
      for (let r = r0; r < r0 + h; r++) {
        for (let c = c0; c < c0 + w; c++) {
          if (c < c0 + w - 1) { cells[idx(c, r)].E = false; cells[idx(c + 1, r)].W = false; }
          if (r < r0 + h - 1) { cells[idx(c, r)].S = false; cells[idx(c, r + 1)].N = false; }
        }
      }
    }
  }
  // Loop pass: open a fraction of remaining internal walls to create alternate routes without
  // puncturing the outer boundary.
  if (loopChance > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1 && cells[idx(c, r)].E && rng() < loopChance) {
          cells[idx(c, r)].E = false;
          cells[idx(c + 1, r)].W = false;
        }
        if (r < rows - 1 && cells[idx(c, r)].S && rng() < loopChance) {
          cells[idx(c, r)].S = false;
          cells[idx(c, r + 1)].N = false;
        }
      }
    }
  }
  // Braid pass: for each dead end (one opening), with probability `braid` knock through one more
  // wall to a neighbor -- preferring another dead end so two are cleared at once.
  if (braid > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cw = cells[idx(c, r)];
        if (openCount(cw) > 1 || rng() >= braid) continue;
        const nbrs = [];
        if (r > 0 && cw.N) nbrs.push({ dir: 'N', opp: 'S', c, r: r - 1 });
        if (r < rows - 1 && cw.S) nbrs.push({ dir: 'S', opp: 'N', c, r: r + 1 });
        if (c > 0 && cw.W) nbrs.push({ dir: 'W', opp: 'E', c: c - 1, r });
        if (c < cols - 1 && cw.E) nbrs.push({ dir: 'E', opp: 'W', c: c + 1, r });
        if (nbrs.length === 0) continue;
        const dead = nbrs.filter((n) => openCount(cells[idx(n.c, n.r)]) <= 1);
        const pool = dead.length ? dead : nbrs;
        const pick = pool[Math.floor(rng() * pool.length)];
        cw[pick.dir] = false;
        cells[idx(pick.c, pick.r)][pick.opp] = false;
      }
    }
  }
  // Entrance pass: open a few outer-boundary walls so the maze isn't fully sealed (flank routes).
  // Runs last so the braid pass can't re-close these.
  if (entrances > 0) {
    const boundary = [];
    for (let c = 0; c < cols; c++) { boundary.push({ c, r: 0, dir: 'N' }); boundary.push({ c, r: rows - 1, dir: 'S' }); }
    for (let r = 0; r < rows; r++) { boundary.push({ c: 0, r, dir: 'W' }); boundary.push({ c: cols - 1, r, dir: 'E' }); }
    for (let i = boundary.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = boundary[i]; boundary[i] = boundary[j]; boundary[j] = t; }
    for (let i = 0; i < Math.min(entrances, boundary.length); i++) cells[idx(boundary[i].c, boundary[i].r)][boundary[i].dir] = false;
  }
  return cells;
}

// Carved cells -> world-space wall rects {x,z,w,d}. `ringOnly` keeps just the outer boundary (the
// viewer's "perimeter" wall mode); the south/east edges are always emitted from the last row/col.
export function mazeCellWalls(cells, cols, rows, { cell, originX, originZ, wallT, ringOnly = false } = {}) {
  const walls = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cw = cells[r * cols + c];
      const cx = originX + c * cell + cell / 2, cz = originZ + r * cell + cell / 2;
      if (cw.N && (!ringOnly || r === 0)) walls.push({ x: cx, z: originZ + r * cell, w: cell + wallT, d: wallT });
      if (cw.W && (!ringOnly || c === 0)) walls.push({ x: originX + c * cell, z: cz, w: wallT, d: cell + wallT });
      if (r === rows - 1 && cw.S) walls.push({ x: cx, z: originZ + (r + 1) * cell, w: cell + wallT, d: wallT });
      if (c === cols - 1 && cw.E) walls.push({ x: originX + (c + 1) * cell, z: cz, w: wallT, d: cell + wallT });
    }
  }
  return walls;
}

// Scattered-structure defaults. Sizes in metres.
export const STRUCTURE_DEFAULTS = {
  seed: 1,
  count: 6,
  mix: 'mixed',        // mixed | buildings | pockets | obstacles | portals | colonnades | slots
                       // | ramparts | corners | terraces
  // False when the caller cannot use terrain pads (terrain off), which makes a pad-only kind
  // render nothing at all. See PAD_ONLY_KINDS.
  padTerrain: true,
  wallT: 0.3,
  edgeMargin: 4,       // clear of the map bounds, so nothing straddles the perimeter
  minSeparation: 5,    // between structure footprints: the gaps ARE the firing lanes
  attempts: 40,        // rejection-sampling tries per structure before giving up
  buildingMin: 7,      // building footprint side range
  buildingMax: 13,
  doorWidth: 2.2,
  pocketCells: 4,      // maze pocket = pocketCells^2 cells at pocketCell metres
  pocketCell: 3.0,
  clusterMin: 4,       // obstacles per obstacle field
  clusterMax: 8,
  clusterRadius: 5,
  coverHeight: 1.1,    // shoot-over cover
  tallHeight: 2.4,     // sight-blocking obstacle (>= SIGHT_BLOCK_HEIGHT, so it yields cover corners)
  tallShare: 0.35,     // fraction of obstacles built tall
  foundationBury: 0.3, // m a seated structure's foundation sinks past its lowest sample
  // ---- elevated geometry (slabs): lintels, roofs, portal decks ----
  // Slabs are {x,z,w,d,y,h} with y = the slab's UNDERSIDE above local ground. They render and
  // stop bullets but are deliberately absent from the nav and sight lists, so a bot walks under
  // an overhang instead of pathing round it. Keep every y >= a standing capsule or they trap.
  wallHeight: 3,       // must match the viewer's WALL_H; lintels fill from their head to here
  doorHeight: 2.2,     // clear height of a doorway; the wall above it becomes a lintel
  windowSill: 0.9,     // sill height (emitted as cover: shoot over it, don't walk through it)
  windowHeight: 1.2,   // clear height of the window itself
  windowChance: 0.5,   // per non-door building side
  slabT: 0.35,         // lintel / roof thickness
  roofChance: 0.5,     // a building gets a cantilevered canopy over one side
  roofOverhang: 1.0,   // how far a canopy projects past the wall line
  portalMin: 5,        // clear span between a portal's two piers
  portalMax: 9,
  // ---- colonnade: a grid of tall posts, optionally carrying a soffit ----
  colonnadeMin: 3,     // posts per side
  colonnadeMax: 5,
  colonnadePitch: 3.0, // m between post centres (jittered +-20%)
  colonnadePost: 0.8,  // m, post side (jittered +-25%); keep above NAV_CELL or a post falls between samples
  colonnadeRoofChance: 0.6,
  // ---- slot: two parallel walls and nothing else ----
  slotMin: 8,          // m, run length
  slotMax: 16,
  slotGapMin: 2.0,     // m between the wall faces; below ~1.6 the nav margin seals it shut
  slotGapMax: 3.5,
  // ---- rampart: one long wall carrying a cantilevered soffit ----
  rampartMin: 9,
  rampartMax: 16,
  rampartThickness: 0.6,
  rampartSoffitChance: 0.7,
  rampartSoffitDepth: 2.4,   // m the soffit reaches out from the wall face
  // ---- corner: two perpendicular walls and the nook they make ----
  cornerMin: 4,        // m, arm length
  cornerMax: 8,
  // ---- terrace: high ground, built as terrain rather than geometry ----
  // Nav reads one height per cell from the terrain field, so a slab is something bots walk under and
  // never onto. A terrace raises the ground instead: a mesa whose rim is steeper than the nav slope
  // gate (so it excludes itself) plus one graded approach that is not.
  terraceRise: 2.6,        // m the top stands above local ground
  terraceRadius: 5,        // m, top radius
  terraceRim: 0.9,         // m of falloff on the top pad; rise/rim must beat maxSlope or it is a hill
  terraceRampSteps: 5,
  terraceRampSlope: 0.45,  // rise/run the approach is built to; nav rejects above maxSlope (0.85)
  terraceRampWidth: 2.4,   // m, approach half-width
  // ---- platform: a raised deck on posts, reached by a sloped ramp ----
  // The only kind that emits `decks` (nav levels) and `ramps` (sloped boxes). Everything else here
  // is either ground you walk on or geometry you walk under.
  platformWidth: 6,
  platformDepth: 5,
  platformHeight: 3.0,     // m from local ground to the walking surface
  platformPost: 0.7,       // corner post side; emitted as cover, so it blocks sight and movement
  platformDeckT: 0.35,
  platformRampSlope: 0.5,  // rise/run; the capsule needs the ramp face under its own slope limit
  platformRampWidth: 2.0,
  platformRampT: 0.3,
  platformNavRise: 0.4,    // max rise between consecutive ramp decks; must stay under nav's levelStep
};

const KINDS = ['building', 'pocket', 'obstacles', 'portal', 'colonnade', 'slot', 'rampart', 'corner', 'terrace', 'platform'];
const MIX_KINDS = {
  buildings: ['building'], pockets: ['pocket'], obstacles: ['obstacles'], portals: ['portal'],
  colonnades: ['colonnade'], slots: ['slot'], ramparts: ['rampart'], corners: ['corner'],
  terraces: ['terrace'], platforms: ['platform'],
  mixed: KINDS,
};
// Every mix name a caller may ask for, so a save file can be validated against one list.
export const MIX_NAMES = Object.keys(MIX_KINDS);

// Kinds that emit terrain pads and NO geometry. A caller with terrain off drops their pads on the
// floor, so under `mixed` they would silently burn a slot and its separation radius while
// rendering nothing -- measured at 10.6% of placements. Filtered out of `mixed` when padTerrain is
// false, but never out of a mix that named one: asking for terraces and getting an empty map is
// worse than asking for terraces and being told they need terrain.
const PAD_ONLY_KINDS = new Set(['terrace']);

// The kind pool a params set resolves to, and whether anything was dropped (so a UI can say so).
export function kindsForMix(p) {
  const named = MIX_KINDS[p.mix] || MIX_KINDS.mixed;
  if (p.padTerrain === false && named.length > 1) {
    const usable = named.filter((k) => !PAD_ONLY_KINDS.has(k));
    if (usable.length) return { kinds: usable, dropped: named.filter((k) => PAD_ONLY_KINDS.has(k)) };
  }
  return { kinds: named, dropped: [] };
}
export function isPadOnlyKind(kind) { return PAD_ONLY_KINDS.has(kind); }

// One wall run along an axis, optionally broken by a gap centred at `gap`. `opening` turns that
// gap into a real opening rather than a full-height slot: a door gets a lintel over it, a window
// gets a lintel and a sill. Returns three lists because one opening emits three kinds of geometry
// — wall either side, a sill that behaves as cover, and a lintel that behaves as neither.
function wallRun(axis, fixed, from, to, thickness, gap, gapWidth, opening = null, p = null) {
  const walls = [], covers = [], slabs = [];
  const box = (mid, len) => (axis === 'x'
    ? { x: mid, z: fixed, w: len, d: thickness }
    : { x: fixed, z: mid, w: thickness, d: len });
  const push = (a, b) => { if (b - a > 1e-6) walls.push(box((a + b) / 2, b - a)); };

  if (gap == null) { push(from, to); return { walls, covers, slabs }; }
  push(from, gap - gapWidth / 2);
  push(gap + gapWidth / 2, to);
  if (opening && p) {
    const sill = opening.kind === 'window' ? opening.sill : 0;
    const head = sill + opening.height;
    if (head < p.wallHeight - 1e-6) slabs.push({ ...box(gap, gapWidth), y: head, h: p.wallHeight - head });
    if (sill > 1e-6) covers.push({ ...box(gap, gapWidth), h: sill });
  }
  return { walls, covers, slabs };
}

// A building is a shell: four walls, one or two doorways, and a little interior cover so clearing
// it is a fight rather than a walk-through.
// Slots: 0-1 size, 2-4 side shuffle, 5 door count, 6-9 opening rolls, 10-13 opening positions,
// 14-15 divider, 16-19 canopy, 20 interior count, 21-26 two interior covers.
const BUILDING_DRAWS = 27;
function buildBuilding(cx, cz, p, rng) {
  const r = draws(rng, BUILDING_DRAWS);
  const w = p.buildingMin + r[0] * (p.buildingMax - p.buildingMin);
  const d = p.buildingMin + r[1] * (p.buildingMax - p.buildingMin);
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const sides = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) { const j = Math.floor(r[5 - i] * (i + 1)); const t = sides[i]; sides[i] = sides[j]; sides[j] = t; }
  const doors = new Set(sides.slice(0, r[5] < 0.5 ? 1 : 2));
  const inset = p.doorWidth / 2 + p.wallT + 0.4;   // keep a doorway off the corners
  const doorAt = (a, b, t) => a + inset + t * Math.max(0, (b - inset) - (a + inset));
  const walls = [], covers = [], slabs = [];
  const DOOR = { kind: 'door', height: p.doorHeight };
  const WINDOW = { kind: 'window', sill: p.windowSill, height: p.windowHeight };
  // A side is a door, else a window on the roll, else solid.
  const sideOpening = [0, 1, 2, 3].map((i) => (doors.has(i) ? DOOR : (r[6 + i] < p.windowChance ? WINDOW : null)));
  const run = (...args) => {
    const out = wallRun(...args);
    walls.push(...out.walls); covers.push(...out.covers); slabs.push(...out.slabs);
  };
  const sideArgs = [
    ['x', z0, x0, x1], ['x', z1, x0, x1], ['z', x0, z0, z1], ['z', x1, z0, z1],
  ];
  sideArgs.forEach(([axis, fixed, a, b], i) => {
    const op = sideOpening[i];
    const width = op && op.kind === 'window' ? p.doorWidth * 1.3 : p.doorWidth;
    run(axis, fixed, a, b, p.wallT, op ? doorAt(a, b, r[10 + i]) : null, width, op, p);
  });
  // Optional internal divider with its own gap: turns one room into two connected ones.
  if (r[14] < 0.5 && Math.min(w, d) > 8) {
    const vertical = w >= d;
    if (vertical) run('z', cx, z0 + p.wallT, z1 - p.wallT, p.wallT, doorAt(z0, z1, r[15]), p.doorWidth, DOOR, p);
    else run('x', cz, x0 + p.wallT, x1 - p.wallT, p.wallT, doorAt(x0, x1, r[15]), p.doorWidth, DOOR, p);
  }
  // A cantilevered canopy over one side, projecting past the wall line — the soffit the
  // references are built around, and the deep shade under it is the point.
  if (r[16] < p.roofChance) {
    const over = p.roofOverhang;
    const frac = 0.35 + r[17] * 0.4;
    const far = r[19] < 0.5;
    if (r[18] < 0.5) {
      const band = d * frac;
      slabs.push({
        x: cx, z: far ? z1 + over - band / 2 : z0 - over + band / 2,
        w: w + over * 2, d: band, y: p.wallHeight, h: p.slabT,
      });
    } else {
      const band = w * frac;
      slabs.push({
        x: far ? x1 + over - band / 2 : x0 - over + band / 2, z: cz,
        w: band, d: d + over * 2, y: p.wallHeight, h: p.slabT,
      });
    }
  }
  const inner = Math.min(w, d) / 2 - 1.4;
  const nCover = Math.floor(r[20] * 3);
  for (let i = 0; i < nCover && inner > 0.6; i++) {
    const s = 0.7 + r[21 + i * 3] * 0.8;
    covers.push({ x: cx + (r[22 + i * 3] * 2 - 1) * inner, z: cz + (r[23 + i * 3] * 2 - 1) * inner, w: s, d: s, h: p.coverHeight });
  }
  return { walls, covers, slabs, radius: Math.hypot(w, d) / 2, pad: { x: cx, z: cz, radius: Math.hypot(w, d) / 2 + 0.6 } };
}

// A portal: two piers carrying a deck overhead. The underpass form the reference set is built
// around, and the only structure here you fight UNDER rather than around — the piers block sight
// and movement, the deck blocks neither.
function buildPortal(cx, cz, p, rng) {
  const span = p.portalMin + rng() * (p.portalMax - p.portalMin);
  const alongX = rng() < 0.5;
  const pierW = 0.8 + rng() * 0.7;      // across the opening
  const pierD = 2.2 + rng() * 1.8;      // along the direction you pass through
  const half = span / 2;
  const walls = alongX
    ? [{ x: cx - half, z: cz, w: pierW, d: pierD }, { x: cx + half, z: cz, w: pierW, d: pierD }]
    : [{ x: cx, z: cz - half, w: pierD, d: pierW }, { x: cx, z: cz + half, w: pierD, d: pierW }];
  // The deck sits ON the piers (y = wallHeight, their full height), reads as a real mass rather
  // than a plank, and oversails the piers on the pass-through axis.
  const over = p.roofOverhang;
  const deck = p.slabT * 2.2;
  const slabs = [alongX
    ? { x: cx, z: cz, w: span + pierW, d: pierD + over * 2, y: p.wallHeight, h: deck }
    : { x: cx, z: cz, w: pierD + over * 2, d: span + pierW, y: p.wallHeight, h: deck }];
  return { walls, covers: [], slabs, radius: (span + pierW) / 2 + 1, pad: null };
}

// A maze pocket: a small carved block dropped into the open, braided and with entrances so it is
// a hazard to cross rather than a trap to die in.
function buildPocket(cx, cz, p, rng) {
  const n = Math.max(2, Math.round(p.pocketCells));
  const cell = p.pocketCell;
  const span = n * cell;
  const cells = generateMazeCells(n, n, {
    loopChance: 0.25, braid: 0.4, entrances: 2 + Math.floor(rng() * 3), rng,
  });
  const walls = mazeCellWalls(cells, n, n, {
    cell, originX: cx - span / 2, originZ: cz - span / 2, wallT: p.wallT,
  });
  return { walls, covers: [], radius: span * 0.71, pad: null };
}

// An obstacle field: boxes of mixed height. Tall ones break sight (and become cover corners),
// low ones only break movement and let a bot shoot over them.
function buildObstacles(cx, cz, p, rng) {
  const n = p.clusterMin + Math.floor(rng() * (p.clusterMax - p.clusterMin + 1));
  const covers = [];
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rad = Math.sqrt(rng()) * p.clusterRadius;
    const w = 0.8 + rng() * 1.6, d = 0.8 + rng() * 1.6;
    covers.push({
      x: cx + Math.cos(a) * rad, z: cz + Math.sin(a) * rad, w, d,
      h: rng() < p.tallShare ? p.tallHeight : p.coverHeight,
    });
  }
  return { walls: [], covers, slabs: [], radius: p.clusterRadius + 1, pad: null };
}

// A colonnade: a grid of tall posts, optionally carrying a soffit. Posts are emitted as COVERS,
// not walls — only covers carry a per-record height, and a post has to be shorter than a wall.
// At tallHeight it blocks sight and yields cover corners; the grid is transparent at range and
// opaque up close, so it is the one form here you shoot through and hide inside at the same time.
const COLONNADE_DRAWS = 5;
function buildColonnade(cx, cz, p, rng) {
  const r = draws(rng, COLONNADE_DRAWS);
  const n = Math.max(2, p.colonnadeMin + Math.floor(r[0] * (p.colonnadeMax - p.colonnadeMin + 1)));
  const rows = Math.max(2, p.colonnadeMin + Math.floor(r[1] * (p.colonnadeMax - p.colonnadeMin + 1)) - 1);
  const pitch = p.colonnadePitch * (0.8 + r[2] * 0.4);
  const post = p.colonnadePost * (0.75 + r[3] * 0.5);
  const span = (n - 1) * pitch, depth = (rows - 1) * pitch;
  const covers = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < rows; j++) {
      covers.push({
        x: cx - span / 2 + i * pitch, z: cz - depth / 2 + j * pitch,
        w: post, d: post, h: p.tallHeight,
      });
    }
  }
  const over = p.roofOverhang;
  const slabs = r[4] < p.colonnadeRoofChance ? [{
    x: cx, z: cz, w: span + post + over * 2, d: depth + post + over * 2,
    y: p.wallHeight, h: p.slabT * 1.6,
  }] : [];
  return { walls: [], covers, slabs, radius: Math.hypot(span + post, depth + post) / 2, pad: null };
}

// A slot: two parallel walls and nothing else. A firing lane you have to commit to — unlike a
// pocket it does not branch, so there is no perpendicular escape once you are in it.
const SLOT_DRAWS = 4;
function buildSlot(cx, cz, p, rng) {
  const r = draws(rng, SLOT_DRAWS);
  const len = p.slotMin + r[0] * (p.slotMax - p.slotMin);
  const gap = p.slotGapMin + r[1] * (p.slotGapMax - p.slotGapMin);
  const alongX = r[2] < 0.5;
  const skew = (r[3] * 2 - 1) * len * 0.15;   // one wall runs past the other: an asymmetric mouth
  const off = gap / 2 + p.wallT / 2;
  const walls = alongX
    ? [{ x: cx - skew / 2, z: cz - off, w: len, d: p.wallT },
       { x: cx + skew / 2, z: cz + off, w: len, d: p.wallT }]
    : [{ x: cx - off, z: cz - skew / 2, w: p.wallT, d: len },
       { x: cx + off, z: cz + skew / 2, w: p.wallT, d: len }];
  return {
    walls, covers: [], slabs: [],
    radius: Math.hypot(len + Math.abs(skew), gap + p.wallT * 2) / 2,
    pad: null,
  };
}

// A rampart: one long wall carrying a cantilevered soffit, with a couple of buttress blocks at its
// foot. The wall is a long sight-line blocker; the soffit is deep shade that costs nothing in nav
// (bots walk under it); the buttresses manufacture the free wall ends buildCornerMap wants.
const RAMPART_DRAWS = 9;
function buildRampart(cx, cz, p, rng) {
  const r = draws(rng, RAMPART_DRAWS);
  const len = p.rampartMin + r[0] * (p.rampartMax - p.rampartMin);
  const alongX = r[1] < 0.5;
  const thick = p.rampartThickness * (0.8 + r[2] * 0.5);
  const side = r[4] < 0.5 ? 1 : -1;          // which face the soffit projects over
  const reach = p.rampartSoffitDepth;
  const walls = [alongX
    ? { x: cx, z: cz, w: len, d: thick }
    : { x: cx, z: cz, w: thick, d: len }];
  const over = p.roofOverhang;
  const slabs = r[3] < p.rampartSoffitChance ? [alongX
    ? { x: cx, z: cz + side * (thick / 2 + reach / 2), w: len + over * 2, d: reach, y: p.wallHeight, h: p.slabT * 1.6 }
    : { x: cx + side * (thick / 2 + reach / 2), z: cz, w: reach, d: len + over * 2, y: p.wallHeight, h: p.slabT * 1.6 }]
    : [];
  const covers = [];
  for (let i = 0; i < 2; i++) {
    const t = (r[5 + i * 2] * 0.7 + 0.15) - 0.5;      // -0.35..0.35 of the run, off the ends
    const s = 0.9 + r[6 + i * 2] * 0.9;
    const face = i === 0 ? 1 : -1;                    // one buttress per face
    const outward = thick / 2 + s / 2;
    covers.push(alongX
      ? { x: cx + t * len, z: cz + face * outward, w: s, d: s, h: p.tallHeight }
      : { x: cx + face * outward, z: cz + t * len, w: s, d: s, h: p.tallHeight });
  }
  return { walls, covers, slabs, radius: Math.hypot(len + over * 2, thick + reach * 2) / 2, pad: null };
}

// A corner: two perpendicular walls and the nook they make. The cheapest structure here, and the
// one that most reliably produces a defensible hold — a concave elbow with two free ends.
const CORNER_DRAWS = 8;
function buildCorner(cx, cz, p, rng) {
  const r = draws(rng, CORNER_DRAWS);
  const armA = p.cornerMin + r[0] * (p.cornerMax - p.cornerMin);
  const armB = p.cornerMin + r[1] * (p.cornerMax - p.cornerMin);
  const q = Math.min(3, Math.floor(r[2] * 4));
  const sx = (q & 1) ? 1 : -1, sz = (q & 2) ? 1 : -1;
  // Elbow offset so the L's bounding box centres on (cx, cz) and the placement radius is honest.
  const ex = cx + sx * armA / 2, ez = cz + sz * armB / 2;
  const walls = [
    { x: cx, z: ez, w: armA + p.wallT, d: p.wallT },
    { x: ex, z: cz, w: p.wallT, d: armB + p.wallT },
  ];
  const s = 0.8 + r[3] * 0.8;
  const covers = [];
  for (let i = 0; i < 2; i++) {
    covers.push({
      x: ex - sx * (0.9 + r[4 + i * 2] * (armA - 1.8)),
      z: ez - sz * (0.9 + r[5 + i * 2] * (armB - 1.8)),
      w: s, d: s, h: i === 0 ? p.tallHeight : p.coverHeight,
    });
  }
  return { walls, covers, slabs: [], radius: Math.hypot(armA, armB) / 2 + p.wallT, pad: null };
}

// A terrace: the first structure here made of ground rather than geometry. It emits only terrain
// pads — `{x, z, radius, y, falloff}` — so the raised top IS the walkable surface and nav, sight and
// the collider all see it without knowing anything new. The rim is deliberately steeper than the nav
// slope gate, so the sides exclude themselves and the graded approach is the only way up.
const TERRACE_DRAWS = 5;
function buildTerrace(cx, cz, p, rng) {
  const r = draws(rng, TERRACE_DRAWS);
  const rise = p.terraceRise * (0.75 + r[0] * 0.5);
  const top = p.terraceRadius * (0.8 + r[1] * 0.4);
  const dir = Math.min(3, Math.floor(r[2] * 4));
  const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
  const dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
  const slope = p.terraceRampSlope * (0.85 + r[3] * 0.3);
  const steps = Math.max(2, Math.round(p.terraceRampSteps));
  const pads = [{ x: cx, z: cz, radius: top, y: rise, falloff: p.terraceRim }];
  // Approach: pads stepping down and out. Spacing comes from the target grade, so the run is set by
  // the rise rather than guessed, and a step's own falloff carries the blend to its neighbour.
  const drop = rise / steps;
  const run = drop / Math.max(0.05, slope);
  for (let i = 1; i <= steps; i++) {
    pads.push({
      x: cx + dx * (top + run * (i - 0.5)), z: cz + dz * (top + run * (i - 0.5)),
      radius: p.terraceRampWidth, y: rise - drop * i, falloff: run,
    });
  }
  const reach = top + run * steps + p.terraceRampWidth;
  return { walls: [], covers: [], slabs: [], pads, radius: reach, pad: null };
}

// Scatter `count` structures across `bounds`, keeping clear of `avoid` circles ({x,z,radius} —
// spawn points, start/goal cells) and of each other. Returns viewer-shaped geometry plus the
// placement list, so callers can pad the terrain under them and report what was built.
export const HOME_BASE_DEFAULTS = {
  width: 15,        // span across the team's own side
  depth: 10,        // how far the compound reaches toward the middle of the map
  doorWidth: 5.5,   // gateway in the front wall, so leaving is a chokepoint and not a whole open side
  wallT: 0.6,
  margin: 3,        // keeps the compound off the outer wall
};

// Split the map into one side per team, each with a home point set back from its own edge. The long
// axis is divided so the two sides face each other across the map's width, not its corner.
export function teamSideRegions(bounds, teams = ['alpha', 'bravo'], { margin = HOME_BASE_DEFAULTS.margin } = {}) {
  const spanX = bounds.maxX - bounds.minX, spanZ = bounds.maxZ - bounds.minZ;
  const axis = spanZ >= spanX ? 'z' : 'x';
  const lo = axis === 'z' ? bounds.minZ : bounds.minX;
  const hi = axis === 'z' ? bounds.maxZ : bounds.maxX;
  const crossMid = axis === 'z' ? (bounds.minX + bounds.maxX) / 2 : (bounds.minZ + bounds.maxZ) / 2;
  const depth = HOME_BASE_DEFAULTS.depth;
  const regions = new Map();
  teams.forEach((team, index) => {
    const atLow = index % 2 === 0;
    const edge = atLow ? lo : hi;
    const facing = atLow ? 1 : -1;   // toward the middle
    const home = edge + facing * (margin + depth / 2);
    regions.set(team, {
      team, axis, facing,
      x: axis === 'z' ? crossMid : home,
      z: axis === 'z' ? home : crossMid,
      // The half of the map this team spawns in, as an inclusive [min, max] on the split axis.
      min: atLow ? lo : (lo + hi) / 2,
      max: atLow ? (lo + hi) / 2 : hi,
    });
  });
  return regions;
}

// A team's home compound: a three-sided shell with a gateway facing the fight. Axis-aligned like
// every other wall in the map, so it drops straight into the same collider and nav bake.
export function generateHomeBase(region, params = {}) {
  const p = { ...HOME_BASE_DEFAULTS, ...params };
  const { x, z, axis, facing } = region;
  const half = p.width / 2, reach = p.depth / 2;
  // Local frame: `front` is the side that looks at the map, `back` the side against the map edge.
  const front = (axis === 'z' ? z : x) + facing * reach;
  const back = (axis === 'z' ? z : x) - facing * reach;
  const crossCentre = axis === 'z' ? x : z;
  const crossAxis = axis === 'z' ? 'x' : 'z';
  const walls = [
    ...wallRun(crossAxis, back, crossCentre - half, crossCentre + half, p.wallT, null, 0).walls,
    ...wallRun(crossAxis, front, crossCentre - half, crossCentre + half, p.wallT, crossCentre, p.doorWidth).walls,
    ...wallRun(axis, crossCentre - half, Math.min(back, front), Math.max(back, front), p.wallT, null, 0).walls,
    ...wallRun(axis, crossCentre + half, Math.min(back, front), Math.max(back, front), p.wallT, null, 0).walls,
  ];
  // Two blocks inside the gateway: something to fight from on the way out, and back into on the way in.
  const coverSize = 1.1, coverOff = p.doorWidth / 2 + 1.6;
  const covers = [-1, 1].map((side) => ({
    x: axis === 'z' ? crossCentre + side * coverOff : front - facing * 2.2,
    z: axis === 'z' ? front - facing * 2.2 : crossCentre + side * coverOff,
    w: coverSize, d: coverSize, h: 1.0,
  }));
  return { walls, covers, pad: { x, z, radius: Math.hypot(p.width, p.depth) / 2 + 1 } };
}

// A platform: a deck on four posts with a ramp up to it. The first structure here that puts bots
// ABOVE each other -- everything else is one walkable surface per column, so a slab was only ever
// something to walk under. It emits two lists nothing else does: `decks` (nav levels, the walking
// surface height rather than a slab underside) and `ramps` (the one sloped solid in the map).
// The ramp is a real slope, not a stair: the capsule climbs it because its face is inside the
// collider's slope limit, while nav sees the stepped decks rampDecks() cuts from it.
const PLATFORM_DRAWS = 4;
function buildPlatform(cx, cz, p, rng) {
  const r = draws(rng, PLATFORM_DRAWS);
  const w = p.platformWidth * (0.85 + r[0] * 0.3);
  const d = p.platformDepth * (0.85 + r[1] * 0.3);
  const top = p.platformHeight * (0.9 + r[2] * 0.25);
  const dir = Math.min(3, Math.floor(r[3] * 4));   // the edge the ramp leaves from
  const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
  const dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
  const post = p.platformPost, deckT = p.platformDeckT;
  const covers = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      covers.push({ x: cx + sx * (w / 2 - post / 2), z: cz + sz * (d / 2 - post / 2), w: post, d: post, h: top - deckT });
    }
  }
  const run = top / Math.max(0.1, p.platformRampSlope);
  const headX = cx + dx * (dx !== 0 ? w / 2 : 0), headZ = cz + dz * (dz !== 0 ? d / 2 : 0);
  const reach = Math.hypot(w, d) / 2 + run;
  return {
    walls: [], covers,
    slabs: [{ x: cx, z: cz, w, d, y: top - deckT, h: deckT }],
    decks: [{ x: cx, z: cz, w, d, y: top }],
    // Foot first: `y0` is the low end, so a caller resolving the two ends against real ground can
    // tell which one it must seat and which one the deck already fixes.
    ramps: [{
      x0: headX + dx * run, z0: headZ + dz * run, y0: 0,
      x1: headX, z1: headZ, y1: top,
      width: p.platformRampWidth, thickness: p.platformRampT,
    }],
    radius: reach,
    // One pad for deck and ramp together: two pads would flatten to two heights and leave a step
    // where the ramp foot meets the ground it is supposed to run onto.
    pad: { x: cx + dx * run / 2, z: cz + dz * run / 2, radius: Math.hypot(w, d) / 2 + run / 2 + 1 },
  };
}

// A ramp as a rotated box: centre, size and the one Euler angle that tilts it. The record's two
// ends name the TOP face, so the solid hangs `thickness` below it and the walking surface is
// exactly the line the caller asked for. Axis-aligned in XZ -- the longer span picks the axis.
export function rampBox(ramp) {
  const alongX = Math.abs(ramp.x1 - ramp.x0) >= Math.abs(ramp.z1 - ramp.z0);
  // Ordered along +x / +z so the tilt is a signed angle under a quarter turn and the box's own
  // up-axis always stays up; a ramp described head-first is the same solid described foot-first.
  const forward = alongX ? ramp.x1 >= ramp.x0 : ramp.z1 >= ramp.z0;
  const yA = forward ? ramp.y0 : ramp.y1, yB = forward ? ramp.y1 : ramp.y0;
  const run = alongX ? Math.abs(ramp.x1 - ramp.x0) : Math.abs(ramp.z1 - ramp.z0);
  const rise = yB - yA;
  const angle = Math.atan2(rise, run);
  const len = Math.hypot(run, rise);
  const t = ramp.thickness;
  const cx = (ramp.x0 + ramp.x1) / 2, cz = (ramp.z0 + ramp.z1) / 2, cy = (ramp.y0 + ramp.y1) / 2;
  if (alongX) {
    // Rotation about z by `angle` sends local +x up-slope and local +y to the surface normal.
    return {
      x: cx + Math.sin(angle) * t / 2, y: cy - Math.cos(angle) * t / 2, z: cz,
      w: len, h: t, d: ramp.width, rx: 0, ry: 0, rz: angle,
    };
  }
  return {
    x: cx, y: cy - Math.cos(angle) * t / 2, z: cz + Math.sin(angle) * t / 2,
    w: ramp.width, h: t, d: len, rx: -angle, ry: 0, rz: 0,
  };
}

// The ramp's top face cut into nav decks: contiguous rects tiling the run, each at the surface
// height of its own centre. `maxRise` bounds the step between neighbours, so the chain stays under
// nav-grid's levelStep and a bot may actually walk up it. Contiguous rather than overlapping:
// a tiling puts every cell centre in exactly one rect, so no column gets two levels a few
// centimetres apart.
export function rampDecks(ramp, maxRise = 0.4) {
  const alongX = Math.abs(ramp.x1 - ramp.x0) >= Math.abs(ramp.z1 - ramp.z0);
  const n = Math.max(1, Math.ceil(Math.abs(ramp.y1 - ramp.y0) / Math.max(0.05, maxRise)));
  const spanX = (ramp.x1 - ramp.x0) / n, spanZ = (ramp.z1 - ramp.z0) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    out.push({
      x: ramp.x0 + (ramp.x1 - ramp.x0) * t,
      z: ramp.z0 + (ramp.z1 - ramp.z0) * t,
      w: alongX ? Math.abs(spanX) : ramp.width,
      d: alongX ? ramp.width : Math.abs(spanZ),
      y: ramp.y0 + (ramp.y1 - ramp.y0) * t,
    });
  }
  return out;
}

const BUILDERS = {
  building: buildBuilding, pocket: buildPocket, obstacles: buildObstacles, portal: buildPortal,
  colonnade: buildColonnade, slot: buildSlot, rampart: buildRampart, corner: buildCorner,
  terrace: buildTerrace, platform: buildPlatform,
};
// Stream salts. SHAPE is a base: attempt k draws from SHAPE + k, so a rejected attempt costs the
// next one nothing.
const SALT_KIND = 0, SALT_POS = 1, SALT_SHAPE = 2;

function buildAt(kind, cx, cz, p, seed) {
  const b = BUILDERS[kind];
  if (!b) return null;
  // `pad` is a single flatten circle; `pads` is a list a terrain-shaped structure emits instead.
  return { covers: [], slabs: [], decks: [], ramps: [], pad: null, pads: [], ...b(cx, cz, p, makeRng(seed)) };
}

// One specimen of one kind, for galleries and previews. Same builders and the same per-structure
// stream the scatter uses, so a seed here means what it means there.
export function generateOne(kind, params = {}, seed = 1, { x = 0, z = 0 } = {}) {
  const p = { ...STRUCTURE_DEFAULTS, ...params };
  return buildAt(kind, x, z, p, streamSeed(seed, 0, SALT_SHAPE));
}

// Lifts a structure's rects onto its seated floor. Rect `y` is the base, so the whole shape rides
// up together and its own heights are untouched.
function liftRects(list, dy) {
  if (!dy) return list;
  for (const r of list) r.y = (r.y || 0) + dy;
  return list;
}

// Same for ramps, which carry a height at each end rather than one base.
function liftRamps(list, dy) {
  if (!dy) return list;
  for (const r of list) { r.y0 += dy; r.y1 += dy; }
  return list;
}

// XZ bounding box of everything a structure emitted. Exact, unlike the `radius` circle, so a long
// thin colonnade does not get a square foundation the size of its diagonal.
function footprintBox(built) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const list of [built.walls, built.covers, built.slabs]) {
    for (const r of list) {
      if (r.x - r.w / 2 < minX) minX = r.x - r.w / 2;
      if (r.x + r.w / 2 > maxX) maxX = r.x + r.w / 2;
      if (r.z - r.d / 2 < minZ) minZ = r.z - r.d / 2;
      if (r.z + r.d / 2 > maxZ) maxZ = r.z + r.d / 2;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ };
}

// The block that carries a seated structure down to grade. footprintAt seats the floor at the
// HIGHEST sample so no ground pokes up through it, which leaves the low side hanging by exactly
// skirtDepth -- without this a building on any slope floats visibly on its downhill corner.
// `bury` sinks it a little further so ground curving between samples cannot show a gap.
function foundationFor(built, floorY, skirtDepth, bury) {
  const box = footprintBox(built);
  if (!box) return null;
  const h = Math.max(0, skirtDepth) + bury;
  if (h <= 0) return null;
  return { x: box.x, z: box.z, w: box.w, d: box.d, y: floorY - h, h };
}

export function generateStructures(bounds, params = {}, avoid = []) {
  const p = { ...STRUCTURE_DEFAULTS, ...params };
  // `site(cx, cz, w, d)` -> { floorY, skirtDepth } | null. Supplied when the ground is IMPORTED
  // rather than generated (map-surfaces.js#footprintAt over a terrain-generator-v4 GLB): the
  // structure conforms to whatever is there instead of flattening a pad into it, and a site that
  // is too uneven, too cramped or over a void simply refuses and the scatter tries elsewhere.
  // With `site` on, pads are suppressed -- an authored landscape is not ours to flatten.
  const site = typeof p.site === 'function' ? p.site : null;
  if (site) p.padTerrain = false;
  const { kinds, dropped } = kindsForMix(p);
  const minX = bounds.minX + p.edgeMargin, maxX = bounds.maxX - p.edgeMargin;
  const minZ = bounds.minZ + p.edgeMargin, maxZ = bounds.maxZ - p.edgeMargin;
  const walls = [], covers = [], slabs = [], decks = [], ramps = [], pads = [], placed = [], foundations = [];
  if (maxX <= minX || maxZ <= minZ) return { walls, covers, slabs, decks, ramps, pads, placed, foundations, dropped };

  for (let i = 0; i < p.count; i++) {
    const kind = kinds[Math.floor(makeRng(streamSeed(p.seed, i, SALT_KIND))() * kinds.length)];
    const posRng = makeRng(streamSeed(p.seed, i, SALT_POS));
    let built = null, cx = 0, cz = 0;
    for (let attempt = 0; attempt < p.attempts; attempt++) {
      cx = minX + posRng() * (maxX - minX);
      cz = minZ + posRng() * (maxZ - minZ);
      // Build first, then test: footprint radius is only known once the size is rolled, and
      // re-rolling the size per attempt is what keeps a dense map from degenerating to one kind.
      const candidate = buildAt(kind, cx, cz, p, streamSeed(p.seed, i, SALT_SHAPE + attempt));
      const clash = [...avoid, ...placed].some((o) =>
        Math.hypot(cx - o.x, cz - o.z) < candidate.radius + o.radius + p.minSeparation);
      const outside = cx - candidate.radius < bounds.minX || cx + candidate.radius > bounds.maxX
        || cz - candidate.radius < bounds.minZ || cz + candidate.radius > bounds.maxZ;
      if (clash || outside) continue;
      if (site) {
        // Square the footprint radius: conservative against the real shape, and the corners are
        // exactly where a building overhangs a ledge or drops into a hole.
        const span = candidate.radius * 2;
        const seat = site(cx, cz, span, span);
        if (!seat) continue;   // unbuildable ground: same outcome as a clash, try another spot
        candidate.seat = seat;
      }
      built = candidate; break;
    }
    if (!built) continue;   // crowded map: silently place fewer, never overlapping
    const floorY = built.seat?.floorY || 0;
    // Before the lift: the box is XZ-only, but reading it first keeps it independent of ordering.
    if (built.seat) {
      const f = foundationFor(built, floorY, built.seat.skirtDepth ?? 0, p.foundationBury);
      if (f) foundations.push(f);
    }
    walls.push(...liftRects(built.walls, floorY));
    covers.push(...liftRects(built.covers, floorY));
    slabs.push(...liftRects(built.slabs, floorY));
    decks.push(...liftRects(built.decks, floorY));
    ramps.push(...liftRamps(built.ramps, floorY));
    if (!site) {
      if (built.pad) pads.push(built.pad);
      if (built.pads.length) pads.push(...built.pads);
    }
    placed.push({
      kind, x: cx, z: cz, radius: built.radius,
      ...(built.seat ? { floorY, skirtDepth: built.seat.skirtDepth ?? 0, openSky: built.seat.openSky } : {}),
    });
  }
  return { walls, covers, slabs, decks, ramps, pads, placed, foundations, dropped };
}
