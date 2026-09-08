# Task 12: worker replies delivered under a per-frame budget, tile cover derivation resumable between
# rows, and an allocation-free distance path for the road index.
def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80])
        s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)

# ---- road-path.js: scalar segment distance; the polyline distance uses it and allocates nothing ----
patch('road-path.js', [
("""const polylineScratch = { x: 0, y: 0, z: 0 };
export function distancePointToPolylineXZ(x, z, path) {
  const probe = { x, y: 0, z };
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = projectPointToSegmentXZ(probe, path[i], path[i + 1], polylineScratch).distance;
    if (d < best) best = d;
  }
  return best;
}""",
"""// Distance only, the same arithmetic as projectPointToSegmentXZ without its result record: the field
// derivation asks this once per texel per nearby road.
export function distancePointToSegmentXZ(px, pz, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  let t = lengthSq <= 1e-6 ? 0 : ((px - a.x) * abx + (pz - a.z) * abz) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + (b.x - a.x) * t), pz - (a.z + (b.z - a.z) * t));
}

export function distancePointToPolylineXZ(x, z, path) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = distancePointToSegmentXZ(x, z, path[i], path[i + 1]);
    if (d < best) best = d;
  }
  return best;
}"""),
])

# ---- road-index.js: the bounded nearest-distance query walks the buckets with two reused Sets ----
patch('road-index.js', [
("""  const edgeHalfWidths = new Map();
  let maxSurfaceRadius = 0;
  const keyScratch = [];
""",
"""  const edgeHalfWidths = new Map();
  let maxSurfaceRadius = 0;
  const keyScratch = [];
  const seenEdgeScratch = new Set(), seenNodeScratch = new Set();   // nearestDistanceWithin only
"""),
("""  function nearestDistanceWithin(x, z, radius, best) {
    for (const indexed of queryNodes(x, z, radius, new Set())) {
      best = Math.min(best, Math.hypot(x - indexed.node.position.x, z - indexed.node.position.z));
    }
    for (const edge of queryEdges(x, z, radius, new Set())) {
      best = Math.min(best, distancePointToPolylineXZ(x, z, edge.path));
    }
    return best;
  }""",
"""  // The same candidates queryNodes and queryEdges would return, folded straight into the minimum:
  // no result arrays and no per-call Sets, because the field derivation asks this per texel.
  function nearestDistanceWithin(x, z, radius, best) {
    seenNodeScratch.clear(); seenEdgeScratch.clear();
    for (const key of cellKeysInRadius(x, z, radius, keyScratch)) {
      const nodes = nodeCells.get(key);
      if (nodes) for (const indexed of nodes) {
        if (seenNodeScratch.has(indexed)) continue;
        seenNodeScratch.add(indexed);
        const d = Math.hypot(x - indexed.node.position.x, z - indexed.node.position.z);
        if (d <= radius + 1e-6 && d < best) best = d;
      }
      const bucket = edgeCells.get(key);
      if (bucket) for (const edge of bucket) {
        if (seenEdgeScratch.has(edge)) continue;
        seenEdgeScratch.add(edge);
        const b = edge.bounds;
        if (x >= b.minX - radius && x <= b.maxX + radius && z >= b.minZ - radius && z <= b.maxZ + radius) {
          const d = distancePointToPolylineXZ(x, z, edge.path);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }"""),
])

# ---- flora-field.js: derive pauses between texel rows once past the deadline ----
patch('flora-field.js', [
("""  let clearanceAt = typeof clearance === 'function' ? clearance : null;
  return {""",
"""  let clearanceAt = typeof clearance === 'function' ? clearance : null;
  // Rows finished so far for a tile whose derivation paused; the channels are attached only at the end.
  const progress = new WeakMap();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {"""),
("""    // Mutates the tile, attaching the three channels. Returns it so it can sit in a pipeline.
    derive(tile) {
      const heights = tile.surfaceHeights ?? tile.heights;
      const { biomeIds, moisture, texels, step } = tile;
      if (!heights || !biomeIds) return tile;
      const n = texels * texels;
      const grass = new Uint8Array(n), plant = new Uint8Array(n), tree = new Uint8Array(n);
      for (let iz = 0; iz < texels; iz++) {
        for (let ix = 0; ix < texels; ix++) {""",
"""    // Mutates the tile, attaching the three channels. Returns it so it can sit in a pipeline.
    // With a deadline (performance.now() timebase) it stops between rows once the time is past and
    // returns false; call it again with the same tile to continue. The tile carries no channel until
    // every row is done, so a paused tile can never be committed half-derived.
    derive(tile, deadline = Infinity) {
      const heights = tile.surfaceHeights ?? tile.heights;
      const { biomeIds, moisture, texels, step } = tile;
      if (!heights || !biomeIds) return tile;
      const n = texels * texels;
      let state = progress.get(tile);
      if (!state) { state = { grass: new Uint8Array(n), plant: new Uint8Array(n), tree: new Uint8Array(n), iz: 0 }; progress.set(tile, state); }
      const { grass, plant, tree } = state;
      for (let iz = state.iz; iz < texels; iz++) {
        if (iz > state.iz && now() >= deadline) { state.iz = iz; return false; }
        for (let ix = 0; ix < texels; ix++) {"""),
("""      tile.coverGrass = grass;
      tile.coverPlant = plant;
      tile.coverTree = tree;
      return tile;""",
"""      progress.delete(tile);
      tile.coverGrass = grass;
      tile.coverPlant = plant;
      tile.coverTree = tree;
      return tile;"""),
])

# ---- terrain-field-window.js: the tile callback can say "not yet" ----
patch('terrain-field-window.js', [
("""        onTile: tile => {
          if (disposed || jobEpoch !== epoch) return;      // a source swap invalidates the answer
          if (derive) { try { derive(tile); } catch (err) { stats.lastError = String(err?.message ?? err); return; } }
          if (win.commitTile(tile)) stats.tilesBuilt++;
        },""",
"""        // Returns false only when the derive step paused at its deadline; the scheduler then hands
        // the same tile back next pump. Anything else means the tile is consumed.
        onTile: (tile, deadline) => {
          if (disposed || jobEpoch !== epoch) return true;      // a source swap invalidates the answer
          if (derive) {
            let result;
            try { result = derive(tile, deadline); } catch (err) { stats.lastError = String(err?.message ?? err); return true; }
            if (result === false) return false;
          }
          if (win.commitTile(tile)) stats.tilesBuilt++;
          return true;
        },"""),
])

# ---- terrain-field-scheduler.js: results land in a queue; pump delivers them under a budget ----
patch('terrain-field-scheduler.js', [
("""export const FIELD_SCHEDULER_DEFAULTS = Object.freeze({
  workerCount: 1,        // one worker: field data is never what a frame is waiting on
  maxInFlight: 4,
  syncBudgetMs: 2,       // worker-less fallback: how long one pump may spend building tiles
});""",
"""export const FIELD_SCHEDULER_DEFAULTS = Object.freeze({
  workerCount: 1,        // one worker: field data is never what a frame is waiting on
  maxInFlight: 4,
  syncBudgetMs: 2,       // worker-less fallback: how long one pump may spend building tiles
  deliverBudgetMs: 2,    // how long one pump may spend handing landed tiles to their windows
});"""),
("""  const waiting = new Map();        // key -> [job, ...] merged onto one in-flight job
  const sources = new Map();        // descriptor JSON -> source, for the synchronous path
  let seq = 0, disposed = false;
  const stats = { queued: 0, inFlight: 0, completed: 0, failed: 0, deduped: 0, cancelled: 0, lastError: null, workerCount: 0 };""",
"""  const waiting = new Map();        // key -> [job, ...] merged onto one in-flight job
  const sources = new Map();        // descriptor JSON -> source, for the synchronous path
  const landed = [];                // { job, tile } built results not yet handed to their window
  let seq = 0, disposed = false;
  const stats = { queued: 0, inFlight: 0, completed: 0, failed: 0, deduped: 0, cancelled: 0, lastError: null, workerCount: 0,
    landed: 0, delivered: 0, deliveriesPaused: 0, lastDeliverMs: 0 };"""),
("""  function deliver(job, tile) {
    try { job.onTile?.(tile); } catch (err) { stats.lastError = String(err?.message ?? err); }
  }

  // One tile, many askers: the first job gets the built arrays, the rest get a copy, because a
  // window keeps what it is handed and a transferred buffer has exactly one owner.
  function fanOut(key, tile) {
    const also = waiting.get(key);
    waiting.delete(key);
    if (!also) return tile;
    for (const job of also) deliver(job, cloneTile(tile));
    return tile;
  }""",
"""  // A window's onTile may return false to say its derive step paused at the deadline; the entry then
  // stays at the head of the landed queue and is handed back next pump. Anything else consumes it.
  function deliver(job, tile, deadline) {
    try { return job.onTile?.(tile, deadline) !== false; } catch (err) { stats.lastError = String(err?.message ?? err); return true; }
  }

  // One tile, many askers: the first job gets the built arrays, the rest get a copy, because a
  // window keeps what it is handed and a transferred buffer has exactly one owner. Nothing is
  // delivered here: a worker reply used to run every asker's derivation inside the message handler,
  // and one 80 ms handler was measured doing exactly that (2026-09-08). Results queue for pump().
  function land(key, job, tile) {
    const also = waiting.get(key);
    waiting.delete(key);
    if (also) for (const other of also) landed.push({ job: other, tile: cloneTile(tile) });
    landed.push({ job, tile });
    stats.landed = landed.length;
  }

  // Hands landed tiles to their windows until the deadline. The head entry always gets one call, so
  // a resumable derive makes progress on every pump however late the frame already is.
  function deliverLanded(deadline) {
    const clock = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    const t0 = clock();
    let n = 0;
    while (landed.length) {
      const { job, tile } = landed[0];
      if (!deliver(job, tile, deadline)) { stats.deliveriesPaused++; break; }
      landed.shift();
      stats.delivered++; n++;
      if (clock() >= deadline) break;
    }
    stats.landed = landed.length;
    stats.lastDeliverMs = clock() - t0;
    return n;
  }"""),
("""    } else {
      stats.completed++;
      fanOut(data.key, data);
      deliver(job, data);
    }
    pump();
  }""",
"""    } else {
      stats.completed++;
      land(data.key, job, data);
    }
    fill();
  }"""),
("""  // Runs the queue up to the in-flight cap. Synchronous builds also respect a millisecond budget so
  // a worker-less page keeps its frame; the queue is drained over later pumps, never all at once.
  function pump() {
    if (disposed) return 0;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let started = 0;
    if (queue.length > 1) queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    while (queue.length && inFlight.size < cfg.maxInFlight) {
      const job = queue.shift();
      queuedByKey.delete(job.key);
      stats.queued = queue.length;
      if (job.cancelled) { continue; }
      const wasSync = dispatch(job);
      started++;
      if (wasSync && (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 >= cfg.syncBudgetMs) break;
    }
    return started;
  }""",
"""  // Runs the queue up to the in-flight cap. Synchronous builds also respect a millisecond budget so
  // a worker-less page keeps its frame; the queue is drained over later pumps, never all at once.
  function fill() {
    if (disposed) return 0;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let started = 0;
    if (queue.length > 1) queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    while (queue.length && inFlight.size < cfg.maxInFlight) {
      const job = queue.shift();
      queuedByKey.delete(job.key);
      stats.queued = queue.length;
      if (job.cancelled) { continue; }
      const wasSync = dispatch(job);
      started++;
      if (wasSync && (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 >= cfg.syncBudgetMs) break;
    }
    return started;
  }

  // One frame's worth: dispatch what the cap allows, then hand landed tiles over under the delivery
  // budget. The two budgets are separate so a synchronous build cannot starve delivery.
  function pump() {
    if (disposed) return 0;
    const started = fill();
    if (landed.length) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      deliverLanded(now + cfg.deliverBudgetMs);
    }
    return started;
  }"""),
("""    pump,
    dispose() {
      disposed = true;
      for (const w of workers) w.terminate();
      workers = [];
      queue.length = 0;
      queuedByKey.clear();
      inFlight.clear();
      waiting.clear();
      sources.clear();
    },""",
"""    pump,
    // Landed results waiting for a pump; a test or a paused rebuild can flush them without a budget.
    get landedCount() { return landed.length; },
    deliverLanded,
    dispose() {
      disposed = true;
      for (const w of workers) w.terminate();
      workers = [];
      queue.length = 0;
      queuedByKey.clear();
      inFlight.clear();
      waiting.clear();
      landed.length = 0;
      sources.clear();
    },"""),
])
