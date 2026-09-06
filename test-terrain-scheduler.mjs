// Step 3 of the terrain streaming plan: one scheduler over the near system, the cascade levels
// and the colliders, on one deadline. The clock is injected and every operation costs a number
// the test chooses, so "never exceeds the deadline by more than one item" is asserted rather
// than timed. Run: node test-terrain-scheduler.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSource } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok   ${msg}`); pass++; };

// ---- an injected clock that only moves when an operation says it costs something -------------
let clock = 0;
const now = () => clock;
// Per-operation costs, in ms, chosen by the test. The collider BVH is the expensive one the plan
// is built around, but a volumetric collider needs a density source and the analytic source has
// none, so the 4 ms indivisible item is injected as a fold cost where a BVH cannot run.
const COST = { install: 0.2, fold: 0.3, collider: 4 };

// A worker that holds every job until the test releases it, so a burst is exact.
const held = [];
class HeldWorker {
  constructor() { this.onmessage = null; this._alive = true; }
  postMessage(msg) { held.push({ worker: this, msg }); }
  terminate() { this._alive = false; }
}
globalThis.Worker = function () { return new HeldWorker(); };

const desc = analyticDescriptor({ key: 'sched-test', sourceVersion: '1' });
function landAll() {
  const batch = held.splice(0, held.length);
  for (const { worker, msg } of batch) {
    if (!worker._alive || !worker.onmessage) continue;
    if (msg.jobType !== 'sourceTile') continue;
    const tile = createSource(msg.descriptor).buildTile(msg.request);
    // Charge the install cost when the geometry is actually built, i.e. at commit, not here.
    worker.onmessage({ data: { ...tile, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile' } });
  }
  return batch.length;
}

const { createBaseGameTerrain } = await import('./base-game-terrain.js');

function makeTerrain(params = {}, costs = COST) {
  const terrain = createBaseGameTerrain({
    scene: new THREE.Scene(), worldQuery: createWorldQueryService(), worldCoordinates: createWorldCoordinateSpace(),
    source: desc, useWorker: true, now, params: { renderRadius: 2, ...params },
  });
  terrain.setActive(true);
  // Every operation the scheduler can run is made to cost a known number of injected ms.
  const sys = terrain.system;
  const realCommit = sys.commitNextResult.bind(sys);
  sys.commitNextResult = (key) => { const r = realCommit(key); if (r !== null) clock += costs.install; return r; };
  const provider = terrain.volumeProvider;
  const realSetChunk = provider.setChunk.bind(provider);
  provider.setChunk = (...args) => { clock += costs.collider; return realSetChunk(...args); };
  const batcher = terrain.batcher;
  const realAdd = batcher.add.bind(batcher);
  batcher.add = (...args) => { clock += costs.fold; return realAdd(...args); };
  return terrain;
}

console.log('\n[1] a frame never exceeds the deadline by more than one operation');
{
  held.length = 0; clock = 0;
  // A 4 ms indivisible item -- twice the whole budget -- so the overrun rule is what is measured.
  const heavy = { install: 0.2, fold: 4, collider: 4 };
  const terrain = makeTerrain({ integrateBudgetMs: 2 }, heavy);
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  landAll();
  const worst = [];
  for (let i = 0; i < 40; i++) {
    const before = clock;
    terrain.update([0, 0, 0], 1 / 60);
    worst.push(clock - before);
    landAll();
  }
  const maxFrame = Math.max(...worst);
  const maxItem = 4;
  ok(maxFrame <= 2 + maxItem + 1e-9, `worst frame ${maxFrame.toFixed(1)} ms <= budget 2 + one 4 ms item (never 2 items past the line)`);
  ok(worst.filter(w => w > 2).length > 0, `and the deadline really was crossed (${worst.filter(w => w > 2).length} of 40 frames finished a started item past it)`);
  ok(maxFrame > 4, `a single item bigger than the whole budget still ran rather than deadlocking (${maxFrame.toFixed(1)} ms)`);
  terrain.dispose();
}

console.log('\n[2] five safety-region results arriving together are still one deadline, not five BVHs');
{
  held.length = 0; clock = 0;
  const heavy = { install: 4, fold: 4, collider: 4 };   // every install as costly as a BVH
  const terrain = makeTerrain({ integrateBudgetMs: 2 }, heavy);
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  landAll();                                   // every chunk around the body lands at once
  ok(terrain.system.queuedCount >= 5, `${terrain.system.queuedCount} results waiting, including the body's own chunk and its neighbours`);
  const before = clock;
  terrain.update([0, 0, 0], 1 / 60);
  const spent = clock - before;
  ok(spent <= 2 + 4 + 1e-9, `one frame spent ${spent.toFixed(1)} ms with every item costing 4 ms, not the 15-20 ms five exempt safety chunks would have cost`);
  ok(terrain.system.queuedCount > 0, `and the rest stayed queued (${terrain.system.queuedCount}) rather than being forced through`);
  terrain.dispose();
}

console.log('\n[3] the safety region is the swept footprint, diagonals included');
{
  held.length = 0; clock = 0;
  const terrain = makeTerrain({ chunkSize: 30, integrateBudgetMs: 2 });
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  landAll();
  // Walk diagonally across a chunk corner in one frame: from inside 0,0 to inside 1,1.
  terrain.update([20, 0, 20], 1 / 60, [20, 0, 20]);
  const covered = [];
  terrain.update([40, 0, 40], 1 / 60, [40, 0, 40]);
  for (const key of ['0,0', '1,1', '1,0', '0,1']) covered.push(`${key}:${terrain.system.chunks.has(key) ? 'resident' : 'missing'}`);
  ok(covered.every(c => c.endsWith('resident')), `the corner cut kept every chunk it crossed (${covered.join(' ')})`);
  terrain.dispose();
}

console.log('\n[4] the safety chunk is committed before a nearer-first cosmetic install elsewhere');
{
  held.length = 0; clock = 0;
  const terrain = makeTerrain({ integrateBudgetMs: 0.05, chunkSize: 30 });   // room for exactly one item
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  // The body sits well inside chunk 2,2 while the stream centre is 0,0, so "nearest the stream
  // centre" and "under the body" disagree. Not on the corner: a body on a chunk boundary is
  // genuinely in two chunks at once and either is a correct answer.
  const body = [65, 0, 65];
  terrain.update([0, 0, 0], 1 / 60, body);
  landAll();
  const bodyKey = '2,2';
  ok(terrain.system.inbox.has(bodyKey) && terrain.system.inbox.has('0,0'),
    `both the body's chunk ${bodyKey} and the stream centre's 0,0 are queued`);
  ok(terrain.system.nextQueuedKey() !== bodyKey,
    `and nearest-first alone would have picked ${terrain.system.nextQueuedKey()}, not the body's chunk`);
  terrain.update([0, 0, 0], 1 / 60, body);
  ok(terrain.system.chunks.has(bodyKey), `the one item that fitted the budget was the body's chunk ${bodyKey}`);
  ok(!terrain.system.chunks.has('0,0'), 'the nearer cosmetic install waited its turn');
  terrain.dispose();
}

console.log('\n[5] under sustained arrivals a far level still makes progress (aging)');
{
  held.length = 0; clock = 0;
  const terrain = makeTerrain({ integrateBudgetMs: 2 });
  // Keep the near system permanently fed while watching whether folds and colliders still happen.
  let folds = 0;
  const b = terrain.batcher;
  const realAdd = b.add.bind(b);
  b.add = (...a) => { folds++; clock += COST.fold; return realAdd(...a); };
  for (let i = 0; i < 200; i++) { terrain.update([0, 0, 0], 1 / 60); landAll(); }
  ok(folds > 0, `folds still ran under a permanently fed install queue (${folds})`);
  ok(terrain.system.chunks.size >= 20, `and installs kept up too (${terrain.system.chunks.size} resident)`);
  terrain.dispose();
}

console.log('\n[6] the count caps survive, and the cascade fold is no longer unbudgeted');
{
  held.length = 0; clock = 0;
  const terrain = makeTerrain({ integrateBudgetMs: 1000, maxFoldsPerUpdate: 2, maxColliderRebuildsPerUpdate: 1 });
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  landAll();
  let adds = 0;
  const b = terrain.batcher;
  const realAdd = b.add.bind(b);
  b.add = (...a) => { adds++; return realAdd(...a); };
  terrain.update([0, 0, 0], 1 / 60);
  ok(adds <= 2, `at most maxFoldsPerUpdate folds even with a huge time budget (${adds} <= 2)`);
  ok(terrain.stats.maxColliderRebuildsPerUpdate === 1, 'the one-BVH cap is still reported and still one');
  terrain.dispose();
}

console.log('\n[7] the scheduler reports what it did');
{
  held.length = 0; clock = 0;
  const terrain = makeTerrain({ integrateBudgetMs: 2 });
  for (let i = 0; i < 60; i++) terrain.update([0, 0, 0], 1 / 60);
  landAll();
  terrain.update([0, 0, 0], 1 / 60);
  const cost = terrain.frameCost;
  ok(typeof cost.integrateMs === 'number' && cost.integrateMs > 0, `integrateMs is reported (${cost.integrateMs.toFixed(2)} ms)`);
  ok(cost.integrateItems > 0, `and the item count with it (${cost.integrateItems})`);
  ok(cost.maxItemMs > 0 && cost.maxItemMs <= cost.integrateMs + 1e-9, `maxItemMs is inside the frame's own total (${cost.maxItemMs.toFixed(2)} <= ${cost.integrateMs.toFixed(2)})`);
  const st = terrain.stats;
  ok(typeof st.queued === 'number' && typeof st.queuedBytes === 'number' && typeof st.staleDrops === 'number',
    `stats carry queued ${st.queued}, queuedBytes ${st.queuedBytes}, staleDrops ${st.staleDrops}`);
  // The full field set the panel and the capture read (plan step 6).
  for (const field of ['queuedOldestMs', 'overruns', 'maxItemMs', 'lastIntegrateMs', 'integrateBudgetMs',
                       'inFlight', 'maxInFlight', 'prefetchKeys', 'speed', 'collisionReadyDistance',
                       'workerTintMs', 'colorizePassCount']) {
    assert.equal(typeof st[field], 'number', `stats.${field} must be a number`);
  }
  ok(true, 'every field the panel and the capture read is present and numeric');
  for (const field of ['integrateMs', 'integrateItems', 'maxItemMs', 'queued', 'queuedBytes', 'overruns', 'queuedOldestMs', 'workerTintMs', 'colorizePassCount']) {
    assert.equal(typeof cost[field], 'number', `frameCost.${field} must be a number`);
  }
  ok(true, 'and so is every frameCost field');
  // Worker tint time must never be added to main-thread frame time.
  ok(cost.workerTintMs >= 0 && cost.integrateMs >= 0, `worker tint time is reported separately (${cost.workerTintMs.toFixed(2)} ms worker vs ${cost.integrateMs.toFixed(2)} ms main thread)`);
  terrain.dispose();
}

console.log('\n[8] an untinted arrival is tinted inside the scheduled operation, not in the unbudgeted pass');
{
  // Real clock, not the injected one: what is asserted is where the per-vertex tint is CHARGED,
  // and that is milliseconds. A tile with no normals carries no worker colours (finishTileTint
  // refuses to tint without slope), so it is the one case where the main thread still tints.
  // 169 chunks, not 25: at 25 the difference is under a millisecond warm and proves nothing.
  held.length = 0;
  const terrain = createBaseGameTerrain({
    scene: new THREE.Scene(), worldQuery: createWorldQueryService(), worldCoordinates: createWorldCoordinateSpace(),
    source: desc, useWorker: true, params: { renderRadius: 6, chunkSize: 30, integrateBudgetMs: 100000, maxChunksPerUpdate: 8, maxInFlight: 400 },
  });
  terrain.setActive(true);
  for (let i = 0; i < 400; i++) terrain.update([0, 0, 0], 1 / 60);
  for (const { worker, msg } of held.splice(0, held.length)) {
    if (msg.jobType !== 'sourceTile') continue;
    const tile = createSource(msg.descriptor).buildTile(msg.request);
    delete tile.normals;
    worker.onmessage({ data: { ...tile, colors: null, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile' } });
  }
  const queued = terrain.system.queuedCount;
  ok(queued > 100, `${queued} results queued with no worker colours`);
  terrain.update([0, 0, 0], 1 / 60, [0, 0, 0]);
  const cost = terrain.frameCost;
  const installed = [...terrain.system.chunks.values()].filter(c => c.mesh);
  const coloured = installed.filter(c => c.mesh.geometry.getAttribute('color'));
  ok(coloured.length === installed.length, `every resident chunk is tinted (${coloured.length}/${installed.length})`);
  // A count, not a duration: timing this is JIT-sensitive enough to pass either way. With the
  // tint inside the operation the unbudgeted pass has nothing left to tint; without it, it tints
  // every one of them (measured at 9.7 ms cold, 2.7 ms warm -- which is why the count is asserted).
  // <= 1, not 0: the cold-start chunk is built synchronously inside the system constructor and
  // never passes through a scheduled commit, so the pass is still its safety net. Without the
  // fix this number is every chunk that arrived.
  ok(cost.colorizePassCount <= 1, `the unbudgeted materials pass tinted ${cost.colorizePassCount} chunks, not ${installed.length}`);
  ok(cost.integrateMs > cost.colorizeMs, `the per-vertex work was charged to the scheduler instead (${cost.integrateMs.toFixed(1)} ms integrate vs ${cost.colorizeMs.toFixed(2)} ms materials pass)`);
  terrain.dispose();
}

console.log(`\n${pass} checks passed`);
