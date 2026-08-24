// flora-chunks.js — the windowed chunk lifecycle flora placement runs on (plants plan F4).
// Pure JS, no three.js.
//
// Lifted from the copy inline in environment-viewer.html (syncPlantsToFocus / processPlantBuildQueue,
// :5584-5650), which exists there three times over for plants, forest and dressing. Two properties
// of that original are load-bearing and kept exactly:
//   - syncToFocus returns on an unchanged window key BEFORE building any candidate list, and drain
//     returns before allocating when both queues are empty. That is why the host costs nothing on
//     the frames where the player has not crossed a cell.
//   - builds are budgeted per frame, by count and by milliseconds, so crossing a cell boundary
//     never stalls a frame with a whole window's worth of placement.
//
// New here: readiness. A chunk whose field has not streamed yet is deferred and retried rather than
// built against a default, because a default would record a tree the world never justified.

export const FLORA_CHUNK_DEFAULTS = Object.freeze({
  chunkSize: 64,
  radiusChunks: 6,
  budgetChunks: 2,
  budgetMs: 2,
  maxDeferredRetries: 0,   // 0 = retry forever, which is what a streaming field wants
});

export function createFloraChunks(options = {}) {
  const cfg = { ...FLORA_CHUNK_DEFAULTS, ...options };
  if (!(cfg.chunkSize > 0)) throw new TypeError('flora chunks need a positive chunkSize');

  const resident = new Set();       // keys currently built and handed to a renderer
  const queuedKeys = new Set();     // keys in buildQueue (or deferred), never in resident
  let buildQueue = [];
  const clearQueue = [];
  let desired = new Set();
  let lastWindowKey = null;
  let onBuild = null, onClear = null, isReady = null;

  const stats = {
    resident: 0, queued: 0, deferred: 0, cleared: 0, built: 0,
    windowKey: '', lastBuildMs: 0, syncs: 0, deferrals: 0,
  };

  const keyFor = (cx, cz) => `${cx},${cz}`;
  const cellOf = v => Math.floor(v / cfg.chunkSize);
  function chunkAt(cx, cz) {
    const xMin = cx * cfg.chunkSize, zMin = cz * cfg.chunkSize;
    return { key: keyFor(cx, cz), cx, cz, xMin, zMin, size: cfg.chunkSize, centerX: xMin + cfg.chunkSize / 2, centerZ: zMin + cfg.chunkSize / 2 };
  }

  // Chunks the window wants, nearest to the focus first so what the player can see arrives first.
  function chunksForFocus(x, z) {
    const cx = cellOf(x), cz = cellOf(z), r = Math.max(0, Math.floor(cfg.radiusChunks));
    const out = [];
    for (let iz = cz - r; iz <= cz + r; iz++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        const chunk = chunkAt(ix, iz);
        chunk.distance = Math.hypot(chunk.centerX - x, chunk.centerZ - z);
        out.push(chunk);
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  function syncToFocus(x, z, rebuildExisting = false) {
    const windowKey = `${cellOf(x)},${cellOf(z)}|${cfg.radiusChunks}|${cfg.chunkSize}`;
    if (!rebuildExisting && windowKey === lastWindowKey) return false;   // the cheap path, most frames
    lastWindowKey = windowKey;
    stats.windowKey = windowKey;
    stats.syncs++;

    const active = chunksForFocus(x, z);
    desired = new Set(active.map(c => c.key));

    if (rebuildExisting) {
      for (const key of resident) clearQueue.push(key);
      resident.clear();
      buildQueue = [];
      queuedKeys.clear();
    } else {
      for (const key of [...resident]) {
        if (!desired.has(key)) { clearQueue.push(key); resident.delete(key); }
      }
      if (buildQueue.length) {
        buildQueue = buildQueue.filter(chunk => {
          const keep = desired.has(chunk.key);
          if (!keep) queuedKeys.delete(chunk.key);
          return keep;
        });
      }
    }

    for (const chunk of active) {
      if (resident.has(chunk.key) || queuedKeys.has(chunk.key)) continue;
      queuedKeys.add(chunk.key);
      buildQueue.push({ ...chunk, retries: 0 });
    }
    stats.resident = resident.size;
    stats.queued = buildQueue.length;
    return true;
  }

  // Runs the queues under the budget. `drain` ignores the budget: it is for a paused rebuild, not
  // for play. Returns how many chunks were built.
  function drain({ drain: drainAll = false, now = null } = {}) {
    if (!clearQueue.length && !buildQueue.length) return 0;      // the other cheap path
    const clock = now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    const t0 = clock();
    while (clearQueue.length) {
      const key = clearQueue.shift();
      stats.cleared++;
      onClear?.(key);
    }
    let built = 0, deferred = 0;
    const requeue = [];
    while (buildQueue.length) {
      if (!drainAll && built >= cfg.budgetChunks) break;
      if (!drainAll && built > 0 && clock() - t0 >= cfg.budgetMs) break;
      const chunk = buildQueue.shift();
      if (!desired.has(chunk.key)) { queuedKeys.delete(chunk.key); continue; }
      if (isReady && !isReady(chunk)) {
        chunk.retries++;
        stats.deferrals++;
        if (cfg.maxDeferredRetries && chunk.retries > cfg.maxDeferredRetries) { queuedKeys.delete(chunk.key); continue; }
        requeue.push(chunk);
        deferred++;
        if (deferred >= buildQueue.length + requeue.length) break;   // nothing is ready; stop spinning
        continue;
      }
      queuedKeys.delete(chunk.key);
      resident.add(chunk.key);
      built++;
      stats.built++;
      onBuild?.(chunk);
    }
    for (const chunk of requeue) buildQueue.push(chunk);
    stats.lastBuildMs = clock() - t0;
    stats.resident = resident.size;
    stats.queued = buildQueue.length;
    stats.deferred = requeue.length;
    return built;
  }

  return {
    stats,
    get chunkSize() { return cfg.chunkSize; },
    get radiusChunks() { return cfg.radiusChunks; },
    get residentKeys() { return [...resident]; },
    has: key => resident.has(key),
    chunkAt,
    keyFor,
    syncToFocus,
    drain,
    // A chunk is built only when this says its data is there. Without it, everything is ready.
    setReadyTest(fn) { isReady = typeof fn === 'function' ? fn : null; },
    onBuild(fn) { onBuild = fn; },
    onClear(fn) { onClear = fn; },
    // Placement-affecting settings changed: everything must be rebuilt, but not synchronously.
    rebuildAll(x, z) { syncToFocus(x, z, true); },
    setRadiusChunks(r) {
      const next = Math.max(0, Math.floor(r));
      if (next === cfg.radiusChunks) return false;
      cfg.radiusChunks = next;
      lastWindowKey = null;
      return true;
    },
    setBudget({ budgetChunks, budgetMs } = {}) {
      if (Number.isFinite(budgetChunks)) cfg.budgetChunks = Math.max(1, budgetChunks | 0);
      if (Number.isFinite(budgetMs)) cfg.budgetMs = Math.max(0, budgetMs);
    },
    clear() {
      for (const key of resident) clearQueue.push(key);
      resident.clear();
      buildQueue = [];
      queuedKeys.clear();
      lastWindowKey = null;
      stats.resident = 0;
      stats.queued = 0;
    },
  };
}
