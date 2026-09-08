# Task 11: a tree chunk build that pauses at the frame budget and resumes next drain, same output.
def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80])
        s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)

# ---- forest-placement.js: placement as a resumable job; placementRecords runs the same job to the end ----
patch('forest-placement.js', [
("""// ---- per-chunk placement points (verbatim from placementsForChunk :728) ----
function placementsForChunk(chunk, count, params, heightAt) {
  const out = [];
  if (count <= 0) return out;""",
"""// ---- per-chunk placement points (verbatim from placementsForChunk :728) ----
// A generator so a build can pause between attempts: the RNG draws, the attempt order and the
// slot numbers are untouched, so the points are the same however often it pauses.
const ATTEMPTS_PER_YIELD = 16;
function* placementsForChunkGen(chunk, count, params, heightAt) {
  const out = [];
  if (count <= 0) return out;"""),
("""  if (params.placement === 'ring') {
    const rr = chunk.size * 0.32, jitter = chunk.size * 0.08;
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      const i = attempt % Math.max(1, count);""",
"""  if (params.placement === 'ring') {
    const rr = chunk.size * 0.32, jitter = chunk.size * 0.08;
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      if (attempt && attempt % ATTEMPTS_PER_YIELD === 0) yield;
      const i = attempt % Math.max(1, count);"""),
("""    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      const c = centers[Math.floor(crng.next() * nc)];""",
"""    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      if (attempt && attempt % ATTEMPTS_PER_YIELD === 0) yield;
      const c = centers[Math.floor(crng.next() * nc)];"""),
("""    for (let gx = chunk.xMin; gx < chunk.xMin + chunk.size; gx += cell) for (let gz = chunk.zMin; gz < chunk.zMin + chunk.size; gz += cell) {
      const x = gx + crng.range(0, cell), z = gz + crng.range(0, cell);""",
"""    for (let gx = chunk.xMin; gx < chunk.xMin + chunk.size; gx += cell) for (let gz = chunk.zMin; gz < chunk.zMin + chunk.size; gz += cell) {
      if (slot && slot % ATTEMPTS_PER_YIELD === 0) yield;
      const x = gx + crng.range(0, cell), z = gz + crng.range(0, cell);"""),
("""  } else {
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      if (keepDry({ x: crng.range(chunk.xMin, chunk.xMin + chunk.size), z: crng.range(chunk.zMin, chunk.zMin + chunk.size) }, placed)) placed++;
    }
  }
  return out;
}
""",
"""  } else {
    for (let attempt = 0, placed = 0; placed < count && attempt < maxAttempts; attempt++) {
      if (attempt && attempt % ATTEMPTS_PER_YIELD === 0) yield;
      if (keepDry({ x: crng.range(chunk.xMin, chunk.xMin + chunk.size), z: crng.range(chunk.zMin, chunk.zMin + chunk.size) }, placed)) placed++;
    }
  }
  return out;
}

function placementsForChunk(chunk, count, params, heightAt) {
  const gen = placementsForChunkGen(chunk, count, params, heightAt);
  let r;
  do { r = gen.next(); } while (!r.done);
  return r.value;
}
"""),
("""export function placementRecords(chunks, params, heightAt, biomeAt) {
  const out = [];
  const targetChunkCount = params.targetChunkCount || chunks.length;
  const speciesTable = params.speciesTable || null;
  const speciesCount = speciesTable ? speciesTable.length : Math.max(1, Math.floor(params.species));
  for (const chunk of chunks) {
    const count = treeCountForChunk(chunk, params, targetChunkCount);
    const pts = placementsForChunk(chunk, count, params, heightAt);
    for (const pt of pts) {
      const { x, z, chunkKey, slot } = pt;""",
"""export function placementRecords(chunks, params, heightAt, biomeAt) {
  const job = createPlacementJob(chunks, params, heightAt, biomeAt);
  job.step(Infinity);
  return job.records;
}

// The same placement as a job that stops at a deadline (performance.now() timebase) and resumes on
// the next step(); `records` is complete once step() has returned true. Nothing about the result
// depends on where it paused.
export function createPlacementJob(chunks, params, heightAt, biomeAt) {
  const out = [];
  const targetChunkCount = params.targetChunkCount || chunks.length;
  const speciesTable = params.speciesTable || null;
  const speciesCount = speciesTable ? speciesTable.length : Math.max(1, Math.floor(params.species));
  const gen = (function* () {
    for (const chunk of chunks) {
      const count = treeCountForChunk(chunk, params, targetChunkCount);
      const pts = yield* placementsForChunkGen(chunk, count, params, heightAt);
      for (const pt of pts) out.push(recordFor(pt, params, speciesTable, speciesCount, biomeAt));
    }
  })();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let done = false;
  return {
    records: out,
    get done() { return done; },
    step(deadline = Infinity) {
      if (done) return true;
      do {
        if (gen.next().done) { done = true; return true; }
      } while (clock() < deadline);
      return false;
    },
  };
}

function recordFor(pt, params, speciesTable, speciesCount, biomeAt) {
  {
    {
      const { x, z, chunkKey, slot } = pt;"""),
("""      const scale = sizeFor(params, x, z, treeRng, sizeRange);         // 3rd draw (random varPattern)
      const yaw = treeRng.next() * Math.PI * 2;                       // 4th draw
      out.push({ x, z, scale, yaw, speciesIdx, chunkKey, slot });
    }
  }
  return out;
}""",
"""      const scale = sizeFor(params, x, z, treeRng, sizeRange);         // 3rd draw (random varPattern)
      const yaw = treeRng.next() * Math.PI * 2;                       // 4th draw
      return { x, z, scale, yaw, speciesIdx, chunkKey, slot };
    }
  }
}"""),
])

# ---- flora-chunks.js: a build may pause; the host resumes it first next drain ----
patch('flora-chunks.js', [
("""  let desired = new Set();
  let lastWindowKey = null;
  let onBuild = null, onClear = null, isReady = null;

  const stats = {
    resident: 0, queued: 0, deferred: 0, cleared: 0, built: 0,
    windowKey: '', lastBuildMs: 0, syncs: 0, deferrals: 0,
  };""",
"""  let desired = new Set();
  let lastWindowKey = null;
  let onBuild = null, onClear = null, onAbandon = null, isReady = null;
  // A build that returned false at its deadline: resumed at the head of the next drain, before any
  // new chunk starts. Its key stays in queuedKeys so a window move cannot queue it twice.
  let pending = null;

  const stats = {
    resident: 0, queued: 0, deferred: 0, cleared: 0, built: 0,
    windowKey: '', lastBuildMs: 0, syncs: 0, deferrals: 0, pausedBuilds: 0, abandonedBuilds: 0,
  };

  function abandonPending() {
    if (!pending) return;
    queuedKeys.delete(pending.key);
    stats.abandonedBuilds++;
    try { onAbandon?.(pending); } catch { /* the host's own state is already consistent */ }
    pending = null;
  }"""),
("""    if (rebuildExisting) {
      for (const key of resident) clearQueue.push(key);
      resident.clear();
      buildQueue = [];
      queuedKeys.clear();
    } else {""",
"""    if (rebuildExisting) {
      abandonPending();
      for (const key of resident) clearQueue.push(key);
      resident.clear();
      buildQueue = [];
      queuedKeys.clear();
    } else {
      if (pending && !desired.has(pending.key)) abandonPending();"""),
("""  function drain({ drain: drainAll = false, now = null } = {}) {
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
    }""",
"""  // onBuild(chunk, deadline) may return false to say it stopped at the deadline with the chunk
  // unfinished; the chunk becomes resident only when a later call returns anything else. The deadline
  // is in the clock's own timebase; a drain-all passes Infinity so every build runs to the end.
  function drain({ drain: drainAll = false, now = null } = {}) {
    if (!clearQueue.length && !buildQueue.length && !pending) return 0;      // the other cheap path
    const clock = now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    const t0 = clock();
    const deadline = drainAll ? Infinity : t0 + cfg.budgetMs;
    while (clearQueue.length) {
      const key = clearQueue.shift();
      if (pending && pending.key === key) abandonPending();
      stats.cleared++;
      onClear?.(key);
    }
    let built = 0, deferred = 0;
    const finish = chunk => { queuedKeys.delete(chunk.key); resident.add(chunk.key); built++; stats.built++; };
    if (pending) {
      const chunk = pending;
      if (onBuild?.(chunk, deadline) === false) { stats.pausedBuilds++; }
      else { pending = null; finish(chunk); }
    }
    const requeue = [];
    while (!pending && buildQueue.length) {
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
      if (onBuild?.(chunk, deadline) === false) { pending = chunk; stats.pausedBuilds++; break; }
      finish(chunk);
    }"""),
("""    onBuild(fn) { onBuild = fn; },
    onClear(fn) { onClear = fn; },""",
"""    onBuild(fn) { onBuild = fn; },
    onClear(fn) { onClear = fn; },
    // A paused build whose chunk left the window or was cleared: the builder drops its partial state.
    onAbandon(fn) { onAbandon = fn; },
    get pendingKey() { return pending ? pending.key : null; },"""),
("""    clear() {
      for (const key of resident) clearQueue.push(key);""",
"""    clear() {
      abandonPending();
      for (const key of resident) clearQueue.push(key);"""),
])

# ---- base-game-trees.js: the build runs as a job across drains ----
patch('base-game-trees.js', [
("""import { placementRecords } from './forest-placement.js';""",
"""import { createPlacementJob } from './forest-placement.js';"""),
("""    host.setReadyTest(isChunkReady);
    host.onBuild(buildChunk);
    host.onClear(clearChunk);
    return host;""",
"""    host.setReadyTest(isChunkReady);
    host.onBuild(buildChunk);
    host.onClear(clearChunk);
    host.onAbandon(chunk => building.delete(chunk.key));
    return host;"""),
("""  function buildChunk(chunk) {
    const t0 = now();
    const params = placementParams();
    assertPlacementParams(params);
    const recs = placementRecords([chunk], params, placementHeightAt);
    // `ground` is the drawn surface (the source, not the 8 m placement posts, which sit up to 4 m
    // off it on a slope), asked once here so the renderer never asks per tree per rebuild.
    const groundAt = typeof terrain.groundHeight === 'function' ? terrain.groundHeight : placementHeightAt;
    for (const r of recs) { r.ground = groundAt(r.x, r.z); r.y = r.ground + cfg.treeVerticalOffset; }
    // The shore gate ran on the posts; run it again on the real surface, or a slope the posts read
    // as dry roots a trunk in the sea. Deterministic, so every peer drops the same trees.
    const shore = (terrain.seaLevel ?? -Infinity) + cfg.treeShoreMargin;
    const kept = recs.filter(r => r.ground >= shore);
    stats.shoreDropped += recs.length - kept.length;
    records.set(chunk.key, kept);
    onChunkCb?.(chunk.key, kept);
    stats.lastChunkTrees = kept.length;
    stats.lastChunkMs = now() - t0;
    stats.trees += kept.length;
  }""",
"""  // Builds in progress, by chunk key: the placement job, then the ground-height cursor. One chunk
  // used to place and measure all its trees inside one frame (20 to 22 ms in the 2026-09-07 trace);
  // now each call does what fits before the deadline and returns false until the chunk is complete.
  // The records are the same whichever frame finishes them: placement is seeded and the heights are
  // pure functions of position.
  const building = new Map();
  function buildChunk(chunk, deadline = Infinity) {
    const t0 = now();
    let st = building.get(chunk.key);
    if (!st) {
      const params = placementParams();
      assertPlacementParams(params);
      st = { job: createPlacementJob([chunk], params, placementHeightAt), recs: null, i: 0, ms: 0, steps: 0 };
      building.set(chunk.key, st);
    }
    st.steps++;
    if (!st.recs) {
      if (!st.job.step(deadline)) { st.ms += now() - t0; return false; }
      st.recs = st.job.records;
    }
    // `ground` is the drawn surface (the source, not the 8 m placement posts, which sit up to 4 m
    // off it on a slope), asked once here so the renderer never asks per tree per rebuild.
    const groundAt = typeof terrain.groundHeight === 'function' ? terrain.groundHeight : placementHeightAt;
    const recs = st.recs;
    for (; st.i < recs.length; st.i++) {
      const r = recs[st.i];
      r.ground = groundAt(r.x, r.z); r.y = r.ground + cfg.treeVerticalOffset;
      if (st.i + 1 < recs.length && now() >= deadline) { st.i++; st.ms += now() - t0; return false; }
    }
    building.delete(chunk.key);
    // The shore gate ran on the posts; run it again on the real surface, or a slope the posts read
    // as dry roots a trunk in the sea. Deterministic, so every peer drops the same trees.
    const shore = (terrain.seaLevel ?? -Infinity) + cfg.treeShoreMargin;
    const kept = recs.filter(r => r.ground >= shore);
    stats.shoreDropped += recs.length - kept.length;
    records.set(chunk.key, kept);
    onChunkCb?.(chunk.key, kept);
    stats.lastChunkTrees = kept.length;
    stats.lastChunkMs = st.ms + (now() - t0);
    stats.lastChunkSteps = st.steps;
    stats.trees += kept.length;
    return true;
  }"""),
("""      if (cfg.treeChunkSize !== chunks.chunkSize) {
        chunks.clear(); chunks.drain({ drain: true });
        forgetRecords();
        chunks = makeHost();
      }""",
"""      if (cfg.treeChunkSize !== chunks.chunkSize) {
        chunks.clear(); chunks.drain({ drain: true });
        forgetRecords();
        building.clear();
        chunks = makeHost();
      }"""),
("""    lastChunkTrees: 0, lastChunkMs: 0, placeMs: 0, shoreDropped: 0, chunkSize: cfg.treeChunkSize,""",
"""    lastChunkTrees: 0, lastChunkMs: 0, lastChunkSteps: 0, placeMs: 0, shoreDropped: 0, chunkSize: cfg.treeChunkSize,"""),
])
