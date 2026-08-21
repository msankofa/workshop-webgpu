// bot-spatial-hash.js — pure, THREE-free uniform XZ grid hash over entity capsule positions.
// Node-tested in test-bot-spatial-hash.mjs; consumed by bot-viewer.html's per-frame neighbor
// queries (separation, waypoint contest, pairwise pushout, alert/medic scans, near-miss tests).
// Layout is a linked list per cell: `heads` maps a packed cell key to a first item slot, `next`
// chains the rest -- both buffers are reused, so a steady-state rebuild() allocates nothing.
// Queries never touch positions, only cells, so a stale (un-rebuilt) hash returns stale entities
// rather than throwing; exact distance tests are always the caller's job.

const CELL_MIN = -32768, CELL_MAX = 32767, CELL_BIAS = 32768, CELL_SPAN = 65536;

// Floor to a cell index, clamped into the packable range (non-finite coords collapse to 0).
function cellIndex(v, cellSize) {
  if (!Number.isFinite(v)) return 0;
  const c = Math.floor(v / cellSize);
  return c < CELL_MIN ? CELL_MIN : (c > CELL_MAX ? CELL_MAX : c);
}

// Pack a cell pair into one non-negative integer key (multiply, not <<, to stay out of int32 wrap).
function cellKey(cx, cz) { return (cx + CELL_BIAS) * CELL_SPAN + (cz + CELL_BIAS); }

export function createBotSpatialHash(cellSize = 2) {
  const cs = cellSize > 0 ? cellSize : 1;
  const heads = new Map();      // packed cell key -> first item slot
  const items = [];             // slot -> entity, reused across rebuilds
  let next = new Int32Array(64); // slot -> next slot in the same cell, or -1
  let cellOf = new Float64Array(64); // slot -> packed cell key (exceeds int32), for the sparse scan below
  let count = 0;
  const SCAN_MAX_SLOTS = 4096;  // sort-key packing budget: key*SCAN_MAX_SLOTS + slot stays exact
  let scanKeys = new Float64Array(64);

  function ensureCapacity(n) {
    if (n <= next.length) return;
    let cap = next.length;
    while (cap < n) cap *= 2;
    next = new Int32Array(cap);
    cellOf = new Float64Array(cap); // only called from rebuild, which refills every live slot
    scanKeys = new Float64Array(cap);
  }

  // Re-index from scratch; entities without a capsule are skipped, survivors get a slot stamp.
  function rebuild(entities) {
    const prevCount = count;
    heads.clear();
    count = 0;
    if (entities) {
      ensureCapacity(entities.length);
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e || !e.capsule || !e.capsule.start) continue;
        const slot = count++;
        items[slot] = e;
        e._hashIdx = slot;
        const key = cellKey(cellIndex(e.capsule.start.x, cs), cellIndex(e.capsule.start.z, cs));
        cellOf[slot] = key;
        const head = heads.get(key);
        next[slot] = head === undefined ? -1 : head;
        heads.set(key, slot);
      }
    }
    for (let i = count; i < prevCount; i++) items[i] = null; // drop refs the shrunken roster left
  }

  // Visit every stored entity in the inclusive cell rect; stops early if fn returns true.
  // When the rect holds more cells than there are stored items, scanning the slots beats probing
  // every (mostly empty) cell. Visit ORDER matches the cell walk exactly — cells by ascending
  // packed key (= cx then cz), slots within a cell descending (the chain is LIFO) — so callers
  // with order-sensitive folds (pushout, freshest-report ties) see bit-identical results.
  function forEachCellRange(cx0, cz0, cx1, cz1, fn) {
    const cells = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
    if (count < cells && count <= SCAN_MAX_SLOTS) {
      let m = 0;
      for (let slot = 0; slot < count; slot++) {
        const key = cellOf[slot];
        const cx = Math.floor(key / CELL_SPAN) - CELL_BIAS;
        const cz = (key % CELL_SPAN) - CELL_BIAS;
        if (cx < cx0 || cx > cx1 || cz < cz0 || cz > cz1) continue;
        scanKeys[m++] = key * SCAN_MAX_SLOTS + (SCAN_MAX_SLOTS - 1 - slot);
      }
      for (let i = 1; i < m; i++) {   // insertion sort: m is small and often nearly sorted
        const v = scanKeys[i];
        let j = i - 1;
        while (j >= 0 && scanKeys[j] > v) { scanKeys[j + 1] = scanKeys[j]; j--; }
        scanKeys[j + 1] = v;
      }
      for (let i = 0; i < m; i++) {
        const e = items[SCAN_MAX_SLOTS - 1 - (scanKeys[i] % SCAN_MAX_SLOTS)];
        if (e && fn(e) === true) return true;
      }
      return false;
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        let slot = heads.get(cellKey(cx, cz));
        if (slot === undefined) continue;
        while (slot >= 0) {
          const e = items[slot];
          const nextSlot = next[slot]; // read before fn, which may rebuild underneath us
          if (e && fn(e) === true) return true;
          slot = nextSlot;
        }
      }
    }
    return false;
  }

  return {
    rebuild,
    // Every entity within `radius` of (x, z) is visited (full circle AABB, so some are farther).
    forEachNear(x, z, radius, fn) {
      const r = radius > 0 ? radius : 0;
      return forEachCellRange(
        cellIndex(x - r, cs), cellIndex(z - r, cs),
        cellIndex(x + r, cs), cellIndex(z + r, cs), fn);
    },
    // Same, over the segment's AABB expanded by `pad` -- AABB coverage only, no supercover walk.
    forEachSegment(x0, z0, x1, z1, pad, fn) {
      const p = pad > 0 ? pad : 0;
      const minX = Math.min(x0, x1) - p, maxX = Math.max(x0, x1) + p;
      const minZ = Math.min(z0, z1) - p, maxZ = Math.max(z0, z1) + p;
      return forEachCellRange(
        cellIndex(minX, cs), cellIndex(minZ, cs),
        cellIndex(maxX, cs), cellIndex(maxZ, cs), fn);
    },
    get size() { return count; },
    get cellSize() { return cs; },
  };
}
