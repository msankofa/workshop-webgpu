// terrain-worker-pool.js — one pool of terrain workers shared by every streamer on the page.
//
// Each terrain system used to spawn its own min(4, cores - 2) workers, so four systems made sixteen
// threads and a boundary crossing lit them all at once, starving the main thread (DevTools trace
// 2026-09-07: 104 of 106 long frames overlapped such a burst). The pool is sized once from the
// machine and handed to every system; a system that is not given one still spawns its own.
//
// Jobs are tagged with the owning system's id and the worker echoes the tag, so replies route back
// to the system that asked. A facade from attach() has the same shape the systems already use:
// { count, postMessage(msg), terminate() }, where terminate() detaches this owner only.

// cores/2 - 1, at least 1, at most `cap`: leaves the main thread, the GPU process and the other
// pools (fields, clipmap, sea depth, roads, palette) their own cores.
export function defaultTerrainWorkerCount(cores = globalThis.navigator?.hardwareConcurrency || 4, cap = 4) {
  const n = Math.floor((Number(cores) || 4) / 2) - 1;
  return Math.max(1, Math.min(cap, n));
}

export function createTerrainWorkerPool({ count = 0, cap = 4, url = new URL('./terrain-worker.js', import.meta.url), WorkerCtor = globalThis.Worker } = {}) {
  const size = count > 0 ? Math.floor(count) : defaultTerrainWorkerCount(undefined, cap);
  const owners = new Map();   // owner id -> { onMessage, onError }
  const workers = [];
  const outstanding = [];   // per worker: jobs posted and not yet replied to; a worker runs one at a time
  let next = 0, nextOwner = 1, alive = true;
  const route = (data) => {
    const owner = owners.get(data?.owner);
    if (owner) owner.onMessage(data);
  };
  try {
    for (let i = 0; i < size; i++) {
      const w = new WorkerCtor(url, { type: 'module' });
      const slot = i;
      outstanding.push(0);
      w.onmessage = e => { outstanding[slot] = Math.max(0, outstanding[slot] - 1); route(e.data); };
      w.onerror = () => { for (const o of owners.values()) o.onError?.(); };
      workers.push(w);
    }
  } catch {
    for (const w of workers) w.terminate?.();
    workers.length = 0;
    alive = false;
  }
  return {
    get count() { return workers.length; },
    get available() { return alive && workers.length > 0; },
    get owners() { return owners.size; },
    // Workers with a job posted and not yet answered: exactly the threads executing right now.
    get busyWorkers() { let n = 0; for (const c of outstanding) if (c > 0) n++; return n; },
    get outstanding() { return outstanding.slice(); },
    // A per-system facade. Messages are stamped with the owner id; terminate() only detaches.
    attach(onMessage, onError = null) {
      if (!alive || !workers.length) return null;
      const id = nextOwner++;
      owners.set(id, { onMessage, onError });
      return {
        count: workers.length,
        postMessage: (msg) => {
          if (!owners.has(id)) return;
          outstanding[next]++;
          workers[next].postMessage({ ...msg, owner: id });
          next = (next + 1) % workers.length;
        },
        terminate: () => { owners.delete(id); },
      };
    },
    dispose() {
      alive = false;
      owners.clear();
      for (const w of workers) w.terminate?.();
      workers.length = 0;
    },
  };
}
