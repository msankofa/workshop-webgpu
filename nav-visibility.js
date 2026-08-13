// nav-visibility.js — pure, THREE-free baked pairwise cell↔cell visibility field over a nav grid.
// Node-tested in test-nav-visibility.mjs. See docs/superpowers/plans/2026-07-23-bot-cover-corners-plan.md.
// Sight-blockers are NOT nav-blockers: only rects at/above SIGHT_BLOCK_HEIGHT block sight, so
// short maze covers block walking but let shots/vision pass over. Quantization always errs
// toward VISIBLE (center-coverage rasterization, corner-graze diagonal stepping, symmetric OR).
//
// THIS FILE IS ONE SURFACE PER COLUMN. nav-grid's level overlay (decks) allocates keys past
// cols*rows, and everything here — walkIndex, the sight grid, the height grid — is sized and
// indexed by cols*rows alone. A field built over a grid with levels therefore covers the GROUND
// only: canSee() on a level key is out of range and answers false, so a bot on a deck gets no
// cover records rather than wrong ones. The built field reports this as `levelsIgnored` so a
// caller can say so out loud instead of quietly losing half its cover map.

// Covers at/above this height (metres) block sight for the field.
export const SIGHT_BLOCK_HEIGHT = 1.5;

// Terrain occlusion (optional; see buildHeightGrid). Eye height matches the live raycast's eye so
// the baked field and mapCollider agree; the margin keeps quantization erring toward VISIBLE.
export const TERRAIN_EYE_HEIGHT = 1.6;
export const TERRAIN_LOS_MARGIN = 0.2;

// Ground height sampled at every cell center. Pass the result as opts.terrain.heights to make
// hills and dips occlude sight the same way a wall rect does.
export function buildHeightGrid(navGrid, heightAt) {
  const { cols, rows, cellSize, minX, minZ } = navGrid;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const z = minZ + (r + 0.5) * cellSize;
    for (let c = 0; c < cols; c++) heights[r * cols + c] = heightAt(minX + (c + 0.5) * cellSize, z);
  }
  return heights;
}

// {heights, eyeHeight?, margin?} -> internal context, or null when there is no terrain to test.
function terrainContext(terrain) {
  if (!terrain || !terrain.heights) return null;
  return {
    heights: terrain.heights,
    eye: terrain.eyeHeight ?? TERRAIN_EYE_HEIGHT,
    margin: terrain.margin ?? TERRAIN_LOS_MARGIN,
  };
}

// World (x,z) -> raw cell index into grid.cells, or -1 if out of bounds.
export function cellIndexAt(navGrid, x, z) {
  const c = Math.floor((x - navGrid.minX) / navGrid.cellSize);
  const r = Math.floor((z - navGrid.minZ) / navGrid.cellSize);
  if (c < 0 || r < 0 || c >= navGrid.cols || r >= navGrid.rows) return -1;
  return r * navGrid.cols + c;
}

// Rasterize sight-blocking AABB rects ({x,z,w,d,h} center + full extents; missing h = full
// height wall) onto grid dims. A rect marks a cell only if it covers the cell CENTER, so thin
// overlaps err toward visible. Returns Uint8Array(cols*rows), 1 = blocks sight.
export function buildSightGrid(navGrid, blockers) {
  const { cols, rows, cellSize, minX, minZ } = navGrid;
  const sight = new Uint8Array(cols * rows);
  for (const b of blockers) {
    const h = b.h === undefined ? Infinity : b.h;
    if (h < SIGHT_BLOCK_HEIGHT) continue;
    const hw = b.w / 2, hd = b.d / 2;
    // cell-center coverage: center at minX+(c+0.5)*cellSize must satisfy |center-x| <= hw
    const c0 = Math.max(0, Math.ceil((b.x - hw - minX) / cellSize - 0.5));
    const c1 = Math.min(cols - 1, Math.floor((b.x + hw - minX) / cellSize - 0.5));
    const r0 = Math.max(0, Math.ceil((b.z - hd - minZ) / cellSize - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((b.z + hd - minZ) / cellSize - 0.5));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) sight[r * cols + c] = 1;
    }
  }
  return sight;
}

const TIE_EPS = 1e-9;

// DDA trace center->center over the sight grid; true if no blocking cell strictly between the
// endpoints. Exact corner crossings step diagonally (visit neither flanking cell) — errs visible.
// With `terrain`, each visited cell also has its ground tested against the eye-to-eye chord: a
// ridge that rises more than `margin` above the sight line blocks, matching the live 3D raycast.
function traceClear(sight, cols, c0, r0, c1, r1, terrain) {
  let c = c0, r = r0;
  const dc = c1 - c0, dr = r1 - r0;
  if (dc === 0 && dr === 0) return true;
  const stepC = dc > 0 ? 1 : -1, stepR = dr > 0 ? 1 : -1;
  const tDeltaC = dc !== 0 ? 1 / Math.abs(dc) : Infinity;
  const tDeltaR = dr !== 0 ? 1 / Math.abs(dr) : Infinity;
  // start at cell center: first boundary is half a cell away on each axis
  let tMaxC = dc !== 0 ? 0.5 * tDeltaC : Infinity;
  let tMaxR = dr !== 0 ? 0.5 * tDeltaR : Infinity;
  // Sight line in world Y: eye above the ground at each end, parameterized by the projection of
  // the visited cell onto the (dc,dr) axis so it needs no extra state in the step loop.
  let eyeA = 0, eyeRise = 0, invLen2 = 0;
  if (terrain) {
    eyeA = terrain.heights[r0 * cols + c0] + terrain.eye;
    eyeRise = terrain.heights[r1 * cols + c1] + terrain.eye - eyeA;
    invLen2 = 1 / (dc * dc + dr * dr);
  }
  while (c !== c1 || r !== r1) {
    const diff = tMaxC - tMaxR;
    if (diff < -TIE_EPS) { c += stepC; tMaxC += tDeltaC; }
    else if (diff > TIE_EPS) { r += stepR; tMaxR += tDeltaR; }
    else { c += stepC; r += stepR; tMaxC += tDeltaC; tMaxR += tDeltaR; }
    if (c === c1 && r === r1) break;
    const k = r * cols + c;
    if (sight[k]) return false;
    if (terrain) {
      const t = ((c - c0) * dc + (r - r0) * dr) * invLen2;
      if (terrain.heights[k] > eyeA + eyeRise * t + terrain.margin) return false;
    }
  }
  return true;
}

// Bake the pairwise visibility field: 2D LOS at eye height between every pair of walkable
// cells. Compact walkable indexing (walkIndex maps raw cell idx -> dense row, -1 if
// unwalkable); bits is a row-major bitset of walkableCount² bits. Visibility is symmetric by
// OR: a pair is visible if the trace in EITHER direction is clear.
export function buildVisibilityField(navGrid, sightGrid, { terrain = null } = {}) {
  const terr = terrainContext(terrain);
  const { cols, rows, cells } = navGrid;
  const n = cols * rows;
  const walkIndex = new Int32Array(n).fill(-1);
  const walkCells = [];
  for (let i = 0; i < n; i++) {
    if (cells[i] === 1) { walkIndex[i] = walkCells.length; walkCells.push(i); }
  }
  const walkableCount = walkCells.length;
  const wordsPerRow = Math.ceil(walkableCount / 32) || 1;
  const bits = new Uint32Array(walkableCount * wordsPerRow);

  const setBit = (wa, wb) => { bits[wa * wordsPerRow + (wb >> 5)] |= 1 << (wb & 31); };
  for (let wa = 0; wa < walkableCount; wa++) {
    const a = walkCells[wa];
    const ca = a % cols, ra = (a / cols) | 0;
    setBit(wa, wa);
    for (let wb = wa + 1; wb < walkableCount; wb++) {
      const b = walkCells[wb];
      const cb = b % cols, rb = (b / cols) | 0;
      // symmetric OR: visible if either direction's trace is clear
      if (traceClear(sightGrid, cols, ca, ra, cb, rb, terr) || traceClear(sightGrid, cols, cb, rb, ca, ra, terr)) {
        setBit(wa, wb);
        setBit(wb, wa);
      }
    }
  }

  return {
    lazy: false,
    levelsIgnored: !!navGrid.levels,
    walkIndex,
    walkableCount,
    wordsPerRow,
    bits,
    // Symmetric bit test on RAW cell indices. Unwalkable/out-of-range inputs have no field
    // rows and always return false — callers resolve cover for walkable cells only.
    canSee(cellIdxA, cellIdxB) {
      if (cellIdxA < 0 || cellIdxB < 0 || cellIdxA >= n || cellIdxB >= n) return false;
      const wa = walkIndex[cellIdxA], wb = walkIndex[cellIdxB];
      if (wa === -1 || wb === -1) return false;
      return (bits[wa * wordsPerRow + (wb >> 5)] & (1 << (wb & 31))) !== 0;
    },
    // Uint32Array bitset row (walkable-indexed) for a raw cell index, or null if unwalkable.
    rowFor(cellIdx) {
      if (cellIdx < 0 || cellIdx >= n) return null;
      const wa = walkIndex[cellIdx];
      if (wa === -1) return null;
      return bits.subarray(wa * wordsPerRow, (wa + 1) * wordsPerRow);
    },
  };
}

// Lazy variant of buildVisibilityField: identical canSee/rowFor semantics, but each query is a
// direct symmetric DDA pair trace (~sub-us) instead of reading an O(walkable^2) baked bitset —
// the eager bake is quadratic and takes minutes / >100 MB on large maps (30x30 Test-condition
// maze: ~32k walkable cells). rowFor rows are computed on demand and FIFO-cached; canSee
// consults cached rows first so explicit rowFor users still amortize.
export function buildLazyVisibilityField(navGrid, sightGrid, { rowCacheCap = 64, terrain = null } = {}) {
  const terr = terrainContext(terrain);
  const { cols, rows, cells } = navGrid;
  const n = cols * rows;
  const walkIndex = new Int32Array(n).fill(-1);
  const walkCells = [];
  for (let i = 0; i < n; i++) {
    if (cells[i] === 1) { walkIndex[i] = walkCells.length; walkCells.push(i); }
  }
  const walkableCount = walkCells.length;
  const wordsPerRow = Math.ceil(walkableCount / 32) || 1;
  // symmetric OR, matching the eager bake's pair rule exactly
  const traceVisible = (a, b) => {
    const ca = a % cols, ra = (a / cols) | 0, cb = b % cols, rb = (b / cols) | 0;
    return traceClear(sightGrid, cols, ca, ra, cb, rb, terr) || traceClear(sightGrid, cols, cb, rb, ca, ra, terr);
  };
  // Direct-mapped pair memo. Safe without invalidation: a built field is immutable, so a pair's
  // answer never changes. Collapses repeated same-pivot probes (cover scans re-testing a
  // stationary threat every frame) to a tag check.
  const MEMO_BITS = 13, MEMO_SIZE = 1 << MEMO_BITS, MEMO_MASK = MEMO_SIZE - 1;
  const memoA = new Int32Array(MEMO_SIZE).fill(-1);
  const memoB = new Int32Array(MEMO_SIZE);
  const memoVal = new Uint8Array(MEMO_SIZE);
  const pairVisible = (a0, b0) => {
    const a = a0 < b0 ? a0 : b0, b = a0 < b0 ? b0 : a0; // symmetric -> one slot per unordered pair
    const slot = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) & MEMO_MASK;
    if (memoA[slot] === a && memoB[slot] === b) return memoVal[slot] === 1;
    const vis = traceVisible(a, b);
    memoA[slot] = a; memoB[slot] = b; memoVal[slot] = vis ? 1 : 0;
    return vis;
  };
  const rowCache = new Map(); // raw cellIdx -> Uint32Array row (FIFO-capped)

  return {
    lazy: true,
    levelsIgnored: !!navGrid.levels,
    walkIndex,
    walkableCount,
    wordsPerRow,
    canSee(cellIdxA, cellIdxB) {
      if (cellIdxA < 0 || cellIdxB < 0 || cellIdxA >= n || cellIdxB >= n) return false;
      if (walkIndex[cellIdxA] === -1 || walkIndex[cellIdxB] === -1) return false;
      if (cellIdxA === cellIdxB) return true;
      let row = rowCache.get(cellIdxA);
      if (row) { const wb = walkIndex[cellIdxB]; return (row[wb >> 5] & (1 << (wb & 31))) !== 0; }
      row = rowCache.get(cellIdxB);
      if (row) { const wa = walkIndex[cellIdxA]; return (row[wa >> 5] & (1 << (wa & 31))) !== 0; }
      return pairVisible(cellIdxA, cellIdxB);
    },
    rowFor(cellIdx) {
      if (cellIdx < 0 || cellIdx >= n || walkIndex[cellIdx] === -1) return null;
      let row = rowCache.get(cellIdx);
      if (!row) {
        row = new Uint32Array(wordsPerRow);
        for (let wb = 0; wb < walkableCount; wb++) {   // traceVisible, not pairVisible: a full sweep would flush the memo
          const b = walkCells[wb];
          if (b === cellIdx || traceVisible(cellIdx, b)) row[wb >> 5] |= 1 << (wb & 31);
        }
        if (rowCache.size >= rowCacheCap) rowCache.delete(rowCache.keys().next().value);
        rowCache.set(cellIdx, row);
      }
      return row;
    },
  };
}
