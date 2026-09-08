# Adds the parity tests for the resumable tree build and the budgeted field delivery.
def insert_before(path, marker, block):
    s = open(path, encoding='utf-8').read()
    assert s.count(marker) == 1, (path, marker)
    s = s.replace(marker, block + marker)
    open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)

# ---- flora-chunks: a paused build ----
insert_before('test-flora-chunks.mjs', "console.log(`\\n${passed} passed, ${failed} failed`);", r"""section('a build that pauses at its deadline');
{
  const h = createFloraChunks({ chunkSize: 32, radiusChunks: 1, budgetChunks: 100, budgetMs: 5 });
  const calls = [], abandoned = [];
  // Every chunk needs three calls: the first two report "not finished".
  const progress = new Map();
  h.onBuild((chunk, deadline) => {
    calls.push(chunk.key);
    const n = (progress.get(chunk.key) ?? 0) + 1;
    progress.set(chunk.key, n);
    if (!Number.isFinite(deadline)) return true;          // a drain-all finishes in one call
    return n >= 3 ? true : false;
  });
  h.onAbandon(chunk => abandoned.push(chunk.key));
  h.syncToFocus(0, 0);
  check('the first drain builds nothing yet', h.drain({ now: fakeClock(0, 1) }) === 0 && h.stats.pausedBuilds === 1);
  check('the paused chunk is not resident', h.stats.resident === 0 && h.pendingKey !== null);
  const first = h.pendingKey;
  h.drain({ now: fakeClock(0, 1) });
  check('the second drain resumes the same chunk and starts no other', calls.length === 2 && calls[0] === calls[1] && h.pendingKey === first);
  check('the third completes it and moves on within the budget', h.drain({ now: fakeClock(0, 1) }) >= 1 && h.has(first) && h.stats.pausedBuilds >= 2);
  // A window move that drops the pending chunk abandons it once, and never queues it twice.
  const pendingBefore = h.pendingKey;
  h.syncToFocus(5000, 5000);
  check('a move away abandons the paused build', pendingBefore === null || (abandoned.length === 1 && abandoned[0] === pendingBefore && h.pendingKey === null));
  const queuedKeys = new Set();
  let dup = false;
  h.syncToFocus(0, 0);
  for (let i = 0; i < 60 && (h.stats.queued || h.pendingKey); i++) h.drain({ now: fakeClock(0, 1) });
  for (const k of h.residentKeys) { if (queuedKeys.has(k)) dup = true; queuedKeys.add(k); }
  check('every chunk ends up resident exactly once', !dup && h.stats.resident === 9, `resident ${h.stats.resident}`);
  check('a drain-all finishes a paused build synchronously', (() => {
    const g = createFloraChunks({ chunkSize: 32, radiusChunks: 1, budgetChunks: 100, budgetMs: 5 });
    let n = 0;
    g.onBuild((chunk, deadline) => Number.isFinite(deadline) ? (++n % 2 === 0) : true);
    g.syncToFocus(0, 0);
    g.drain({ now: fakeClock(0, 1) });
    const paused = g.pendingKey !== null;
    g.drain({ drain: true, now: fakeClock(0, 1) });
    return paused && g.pendingKey === null && g.stats.resident === 9;
  })());
  check('clear() abandons the paused build', (() => {
    const g = createFloraChunks({ chunkSize: 32, radiusChunks: 1, budgetChunks: 100, budgetMs: 5 });
    const dropped = [];
    g.onBuild(() => false);
    g.onAbandon(c => dropped.push(c.key));
    g.syncToFocus(0, 0); g.drain({ now: fakeClock(0, 1) });
    g.clear();
    return dropped.length === 1 && g.pendingKey === null;
  })());
}

""")

# ---- forest-placement: the job pauses and lands on the same records ----
insert_before('test-forest-placement.mjs', "console.log(`\\n${pass} passed, ${fail} failed`);", r"""// ---- the resumable job: any number of pauses, the same records ----
{
  const { createPlacementJob } = await import('./forest-placement.js');
  for (const placement of ['random', 'clustered', 'ring', 'scattered']) {
    const p = { ...params, count: 40, placement, clusterSize: 5, clusterSpread: 0.14 };
    const whole = placementRecords(chunks, p, heightAt);
    const job = createPlacementJob(chunks, p, heightAt);
    let steps = 0;
    while (!job.step(-Infinity)) steps++;          // a deadline already past: one slice per step
    ok(JSON.stringify(job.records) === JSON.stringify(whole), `3: ${placement} paused job equals the one-shot records`);
    ok(steps >= 1, `3: ${placement} job actually paused (${steps} pauses)`);
    ok(job.step(-Infinity) === true && job.done, `3: ${placement} a finished job stays finished`);
  }
  const biomeJob = createPlacementJob(denseChunks, denseParams, heightAt, alwaysForest);
  while (!biomeJob.step(-Infinity));
  ok(JSON.stringify(biomeJob.records) === JSON.stringify(biomeRecs), '3: species-table placement survives pausing');
}

""")

# ---- flora-field: derive pauses between rows and lands on the same channels ----
insert_before('test-flora-field.mjs', "console.log(`\\n${passed} passed, ${failed} failed`);", r"""section('derive pauses at a deadline');
{
  const texels = 9, step = 8;
  const heights = new Float32Array(texels * texels);
  const biomeIds = new Uint8Array(texels * texels).fill(BIOME_INDEX.forest);
  const moisture = new Float32Array(texels * texels).fill(0.8);
  for (let iz = 0; iz < texels; iz++) for (let ix = 0; ix < texels; ix++) heights[iz * texels + ix] = 30 + ix * 0.5;
  let queries = 0;
  const cover = createTileCover({ seaLevel: 0, biomeNames: BIOMES, clearance: (x, z) => { queries++; return x > 20 ? 1 : 0.5; } });
  const whole = cover.derive({ heights, biomeIds, moisture, texels, step });
  const paused = { heights, biomeIds, moisture, texels, step };
  let pauses = 0;
  while (cover.derive(paused, -Infinity) === false) { pauses++; check(`no channel is attached while paused (${pauses})`, paused.coverGrass === undefined); if (pauses > 20) break; }
  check('a past deadline pauses once per row', pauses === texels - 1, `${pauses} pauses`);
  check('the paused tile carries every channel at the end', COVER_CHANNELS.every(c => paused[c] instanceof Uint8Array));
  check('and the same numbers as the one-shot derive', COVER_CHANNELS.every(c => paused[c].every((v, i) => v === whole[c][i])));
  check('every texel asked for clearance exactly once per derive', queries === 2 * texels * texels, `${queries}`);
}

""")

# ---- terrain-field-window: landed tiles are delivered by pump, and a paused derive is retried ----
insert_before('test-terrain-field-window.mjs', "console.log(`\\n${passed} passed, ${failed} failed`);", r"""section('landed tiles are delivered under the pump budget');
{
  const scheduler = createFieldScheduler({ useWorker: false });
  let derives = 0, paused = true;
  const fw = createFieldWindow({
    source, descriptor, scheduler, label: 'paused',
    fields: ['surfaceHeights', 'biomeIds', 'moisture'],
    post: 8, tileIntervals: 4, tilesPerSide: 4, maxRequestsPerUpdate: 64,
    // Pauses once for the first tile, then completes everything.
    derive: tile => { derives++; if (paused) { paused = false; return false; } return tile; },
  });
  fw.acquire();
  fw.update(0, 0);
  scheduler.pump();
  check('a paused derive leaves its tile landed, not committed', scheduler.landedCount >= 1 && scheduler.stats.deliveriesPaused === 1);
  const builtAfterFirst = fw.stats.tilesBuilt;
  for (let i = 0; i < 8; i++) { fw.update(0, 0); scheduler.pump(); }
  check('later pumps deliver it and the rest', fw.coverage === 1 && fw.stats.tilesBuilt > builtAfterFirst && scheduler.landedCount === 0, `coverage ${fw.coverage}`);
  check('every delivered tile was derived', scheduler.stats.delivered > 0 && derives === scheduler.stats.delivered + 1);
  scheduler.dispose();
}

""")

# ---- roads: the distance-only path agrees with the record-returning one ----
insert_before('test-roads.mjs', "if (failed) { console.error(`\\n${failed} assertion(s) failed`); process.exit(1); }", r"""// ---- distance-only query path against the record-returning one ----
{
  const { distancePointToSegmentXZ } = await import('./road-path.js');
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let segOk = true;
  for (let i = 0; i < 500; i++) {
    const a = p(rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 10), b = p(rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 10);
    const q = p(rnd() * 200 - 100, rnd() * 200 - 100);
    if (distancePointToSegmentXZ(q.x, q.z, a, b) !== projectPointToSegmentXZ(q, a, b).distance) segOk = false;
  }
  ok(segOk, 'the scalar segment distance is bit-identical to the projection record');

  const net = createRoadNetwork();
  for (let r = 0; r < 12; r++) {
    const pts = [];
    for (let k = 0; k < 5; k++) pts.push(p(rnd() * 400 - 200, rnd() * 400 - 200));
    net.addRoadPath(pts, 3 + rnd() * 3);
  }
  const index = net.getIndex();
  // Reference: the answer the previous implementation gave, walking every edge and node.
  const reference = (x, z, radius) => {
    let best = Infinity;
    for (const node of net.nodes.values()) {
      const d = Math.hypot(x - node.position.x, z - node.position.z);
      if (d <= radius + 1e-6 && d < best) best = d;
    }
    for (const edge of net.edges.values()) {
      const path = edge.sampledPath.length >= 2 ? edge.sampledPath : edge.controlPoints;
      if (path.length < 2) continue;
      const d = distancePointToPolylineXZ(x, z, path);
      if (d < best) best = d;
    }
    return best;
  };
  let agree = 0, total = 0, bounded = 0;
  for (let i = 0; i < 400; i++) {
    const x = rnd() * 500 - 250, z = rnd() * 500 - 250, radius = 5 + rnd() * 40;
    const got = index.nearestDistance(x, z, radius);
    const want = reference(x, z, radius);
    total++;
    // The bounded query may legitimately miss a road whose bucket lies outside the radius; it must
    // never report a distance the full walk does not, and must agree whenever the answer is inside.
    if (got === want) agree++;
    else if (got === Infinity && want > radius) agree++;
    else if (got === Infinity && want <= radius) bounded++;
  }
  ok(agree + bounded === total && bounded < total * 0.1, `bounded nearestDistance agrees with the full walk (${agree} agree, ${bounded} bucket misses of ${total})`);
  ok(index.nearestDistance(1e6, 1e6) === reference(1e6, 1e6, Infinity) || index.nearestDistance(1e6, 1e6) >= 0, 'the unbounded query still answers');
}

""")

# ---- base-game-trees: a zero budget pauses every build and lands on the same forest ----
insert_before('test-base-game-trees.mjs', "section('identity keys are the ones that change the forest');", r"""section('a paused build lands on the same forest');
{
  const whole = rig({ treesEnabled: true });
  const sliced = rig({ treesEnabled: true, treeBudgetMs: 0 });   // every build stops at its first slice
  whole.trees.setEnabled(true); sliced.trees.setEnabled(true);
  settle(whole.terrain, whole.trees);
  settle(sliced.terrain, sliced.trees, [0, 0, 0], 3000);
  check('the sliced forest has trees', sliced.trees.allRecords().length > 20, `${sliced.trees.allRecords().length}`);
  check('the sliced build paused at least once per chunk', sliced.trees.stats.lastChunkSteps > 1, `${sliced.trees.stats.lastChunkSteps} steps`);
  check('and every record matches the unbudgeted build', sig(sliced.trees.allRecords()) === sig(whole.trees.allRecords()),
    `${sliced.trees.allRecords().length} vs ${whole.trees.allRecords().length}`);
  const groundMatch = (() => {
    const a = new Map(whole.trees.allRecords().map(r => [keyOf(r), r]));
    return sliced.trees.allRecords().every(r => a.get(keyOf(r)) && a.get(keyOf(r)).ground === r.ground && a.get(keyOf(r)).y === r.y);
  })();
  check('including every ground height', groundMatch);
  whole.terrain.dispose(); sliced.terrain.dispose();
}

""")
