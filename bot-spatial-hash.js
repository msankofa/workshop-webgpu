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
  let count = 0;

  function ensureCapacity(n) {
    if (n <= next.length) return;
    let cap = next.length;
    while (cap < n) cap *= 2;
    next = new Int32Array(cap);
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
        const head = heads.get(key);
        next[slot] = head === undefined ? -1 : head;
        heads.set(key, slot);
      }
    }
    for (let i = count; i < prevCount; i++) items[i] = null; // drop refs the shrunken roster left
  }

  // Visit every stored entity in the inclusive cell rect; stops early if fn returns true.
  function forEachCellRange(cx0, cz0, cx1, cz1, fn) {
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
