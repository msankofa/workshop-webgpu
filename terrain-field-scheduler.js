// terrain-field-scheduler.js — one job queue for every streamed FIELD window (plants plan F2).
//
// Water depth, rain contact height and flora placement all want source tiles around the player.
// Before this, each one owned a worker: three pools competing with terrain-system.js's own pool for
// the chunks the player is standing on. This is the single owner instead — a small pool, a priority
// queue, and one job per tile key however many windows asked for it.
//
// Priority is a number, low first (PRIORITY.contact = 10 beats PRIORITY.placement = 30). It orders
// field work against other field work. Field work stays behind visible and collision terrain by
// construction: terrain-system.js keeps its own workers, this pool is deliberately small, and
// `maxInFlight` caps how much can be outstanding at once.
//
// Pure enough to test: with no Worker (Node) it builds tiles synchronously inside `pump()`, under
// the same budget, so a test drives the exact scheduling path the page uses.

import { createSource, normalizeDescriptor, normalizeTileRequest, tileKey } from './terrain-source.js';

export const FIELD_PRIORITY = Object.freeze({
  contact: 10,     // what the player and rain touch: the fine, lod-0 window
  water: 20,       // the sea-depth window
  plan: 25,        // kilometres-ahead planning, on its own scheduler in Base Game
  placement: 30,   // flora's coarse biome/moisture field
  prefetch: 40,    // speculative
});

export const FIELD_SCHEDULER_DEFAULTS = Object.freeze({
  workerCount: 1,        // one worker: field data is never what a frame is waiting on
  maxInFlight: 4,
  syncBudgetMs: 2,       // worker-less fallback: how long one pump may spend building tiles
  deliverBudgetMs: 2,    // how long one pump may spend handing landed tiles to their windows
  deliverBacklog: 4,     // landed tiles per extra budget step: the budget grows with the backlog, to 4x
});

export function createFieldScheduler({ useWorker = true, ...opts } = {}) {
  const cfg = { ...FIELD_SCHEDULER_DEFAULTS, ...opts };
  const queue = [];                 // { key, priority, seq, descriptor, request, onTile, onError, owner }
  const queuedByKey = new Map();    // key -> job, so a re-request is a lookup and not a queue walk
  const inFlight = new Map();       // key -> job
  const waiting = new Map();        // key -> [job, ...] merged onto one in-flight job
  const sources = new Map();        // descriptor JSON -> source, for the synchronous path
  const landed = [];                // { job, tile } built results not yet handed to their window
  let seq = 0, disposed = false;
  const stats = { queued: 0, inFlight: 0, completed: 0, failed: 0, deduped: 0, cancelled: 0, lastError: null, workerCount: 0,
    landed: 0, delivered: 0, deliveriesPaused: 0, lastDeliverMs: 0 };

  let workers = [];
  let next = 0;
  if (useWorker && typeof Worker !== 'undefined') {
    for (let i = 0; i < Math.max(1, cfg.workerCount); i++) {
      try {
        const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
        w.onmessage = e => onResult(e.data);
        w.onerror = () => { stats.lastError = 'worker error'; };
        workers.push(w);
      } catch { /* fall through to the synchronous path */ }
    }
  }
  stats.workerCount = workers.length;

  function sourceFor(descriptor) {
    const id = JSON.stringify(normalizeDescriptor(descriptor));
    let s = sources.get(id);
    if (!s) { s = createSource(descriptor); sources.set(id, s); }
    return s;
  }

  // A window's onTile may return false to say its derive step paused at the deadline; the entry then
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
  }

  function cloneTile(tile) {
    const out = { ...tile };
    for (const k of Object.keys(tile)) {
      const v = tile[k];
      if (ArrayBuffer.isView(v)) out[k] = v.slice();
    }
    return out;
  }

  function onResult(data) {
    const job = inFlight.get(data.key);
    inFlight.delete(data.key);
    stats.inFlight = inFlight.size;
    if (!job) { waiting.delete(data.key); return; }
    if (data.error) {
      stats.failed++;
      stats.lastError = data.error;
      waiting.delete(data.key);
      try { job.onError?.(data.error); } catch { /* reporting must not break the pump */ }
    } else {
      stats.completed++;
      land(data.key, job, data);
    }
    fill();
  }

  function dispatch(job) {
    inFlight.set(job.key, job);
    stats.inFlight = inFlight.size;
    if (workers.length) {
      workers[next].postMessage({ jobType: 'sourceTile', key: job.key, epoch: job.epoch, descriptor: job.descriptor, request: job.request });
      next = (next + 1) % workers.length;
      return false;
    }
    try {
      const tile = sourceFor(job.descriptor).buildTile(job.request);
      onResult({ ...tile, key: job.key, epoch: job.epoch });
    } catch (err) {
      onResult({ key: job.key, epoch: job.epoch, error: String(err?.message ?? err) });
    }
    return true;
  }

  // Runs the queue up to the in-flight cap. Synchronous builds also respect a millisecond budget so
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
      // A backlog means the windows are falling behind the player: trees wait on a field that never
      // comes and grass stands on stale heights. Spend more per frame rather than let it grow.
      const steps = Math.min(4, 1 + Math.floor(landed.length / Math.max(1, cfg.deliverBacklog)));
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      deliverLanded(now + cfg.deliverBudgetMs * steps);
    }
    return started;
  }

  return {
    stats,
    get hasWorker() { return workers.length > 0; },
    // A window asks for one tile. Identical keys collapse to one build; the extra askers each get
    // their own copy of the result.
    request({ key, priority = FIELD_PRIORITY.placement, descriptor, request, epoch = 0, owner = null, onTile, onError }) {
      if (disposed) return false;
      const req = normalizeTileRequest(request);
      const jobKey = key ?? `${tileKey(normalizeDescriptor(descriptor), epoch, req.lod, req.ix, req.iz)}|${req.fields.join(',')}`;
      const pending = inFlight.get(jobKey);
      if (pending) {
        stats.deduped++;
        const list = waiting.get(jobKey) ?? [];
        list.push({ key: jobKey, onTile, onError, owner });
        waiting.set(jobKey, list);
        return true;
      }
      const queued = queuedByKey.get(jobKey);
      if (queued && !queued.cancelled) {
        stats.deduped++;
        queued.priority = Math.min(queued.priority, priority);
        const list = waiting.get(jobKey) ?? [];
        list.push({ key: jobKey, onTile, onError, owner });
        waiting.set(jobKey, list);
        return true;
      }
      // Appended in arrival order; pump() sorts once before it dispatches.
      const job = { key: jobKey, priority, seq: seq++, descriptor, request: req, epoch, owner, onTile, onError, cancelled: false };
      queue.push(job);
      queuedByKey.set(jobKey, job);
      stats.queued = queue.length;
      return true;
    },
    // Drop queued work an owner no longer wants (window recentred, consumer released). In-flight
    // jobs are left to land and are ignored by their window's own tile-fits test.
    cancelOwner(owner) {
      let n = 0;
      for (const job of queue) if (job.owner === owner && !job.cancelled) { job.cancelled = true; n++; }
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].cancelled) { queuedByKey.delete(queue[i].key); queue.splice(i, 1); }
      stats.queued = queue.length;
      stats.cancelled += n;
      return n;
    },
    pump,
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
    },
  };
}
