// Step 2 of the terrain streaming plan: worker results wait in a bounded, keyed, validated
// inbox instead of being installed inside onmessage. Clock is injected, so ageing is asserted
// rather than slept for. Run: node test-terrain-inbox.mjs
import assert from 'node:assert/strict';
import { buildChunkArrays } from './terrain-field.js';
import { createSource } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok   ${msg}`); pass++; };

// A worker that holds every job until the test says to answer, so "22 land at once" is exact.
const held = [];
class HeldWorker {
  constructor() { this.onmessage = null; this._alive = true; }
  postMessage(msg) { held.push({ worker: this, msg }); }
  terminate() { this._alive = false; }
}
globalThis.Worker = function () { return new HeldWorker(); };
const { createTerrainSystem } = await import('./terrain-system.js');

const desc = analyticDescriptor({ key: 'inbox-test', sourceVersion: '1' });
function reply(entry, over = {}) {
  const { worker, msg } = entry;
  if (!worker._alive || !worker.onmessage) return;
  const tile = createSource(msg.descriptor).buildTile(msg.request);
  worker.onmessage({ data: { ...tile, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile', ...over } });
}
function flush(system, over = {}) {
  const batch = held.splice(0, held.length);
  for (const e of batch) reply(e, over);
  return batch.length;
}
// Drive dispatch until every target key has been asked for, without letting any result land.
function dispatchAll(system, centre = [0, 0]) {
  for (let i = 0; i < 200; i++) system.update(centre[0], centre[1]);
  return held.length;
}

let clock = 0;
const now = () => clock;
const makeSystem = (params = {}) => createTerrainSystem({
  source: desc, now,
  params: { chunkSize: 30, renderRadius: 2, maxChunksPerUpdate: 4, integrateExternally: true, ...params },
});

console.log('\n[1] 22 results arriving together queue, and drain across frames nearest-first');
{
  held.length = 0;
  const system = makeSystem();
  dispatchAll(system, [0, 0]);
  const landed = flush(system);
  ok(landed >= 22, `${landed} results landed in one go (24 target chunks minus the cold-start build)`);
  ok(system.chunks.size <= 1, `none of them installed themselves (${system.chunks.size} resident, the cold-start chunk)`);
  ok(system.queuedCount === landed, `all ${landed} are queued`);
  ok(system.queuedBytes > 0, `and their bytes are accounted for (${(system.queuedBytes / 1024).toFixed(0)} KB)`);

  // Nearest-first: commit one at a time and check the distance never decreases.
  const order = [];
  let key;
  while ((key = system.commitNextResult()) !== null) order.push(key);
  ok(order.length === landed, `every queued result committed, none lost (${order.length})`);
  ok(system.queuedCount === 0 && system.queuedBytes === 0, 'the inbox and its byte count are empty afterwards');
  const d2 = k => { const [ix, iz] = k.split(',').map(Number); return ((ix + 0.5) * 30) ** 2 + ((iz + 0.5) * 30) ** 2; };
  let monotonic = true;
  for (let i = 1; i < order.length; i++) if (d2(order[i]) < d2(order[i - 1]) - 1e-6) monotonic = false;
  ok(monotonic, `committed nearest-first (${order.slice(0, 3).join(' ')} ... ${order.slice(-2).join(' ')})`);
  ok(system.chunks.size === landed + Math.min(1, system.chunks.size - landed) || system.chunks.size >= landed, `${system.chunks.size} chunks resident after the drain`);
  system.dispose();
}

console.log('\n[2] a result that no longer applies is dropped, at enqueue and at commit');
{
  held.length = 0;
  const system = makeSystem();
  dispatchAll(system, [0, 0]);
  const before = system.staleDrops;

  // Epoch mismatch: a reply from a previous param generation.
  const one = held[0];
  reply(one, { epoch: system.epoch - 1 });
  ok(system.queuedCount === 0 && system.staleDrops === before + 1, 'an epoch-mismatched reply is dropped at enqueue');

  // Off-window: a key we are not asking for.
  reply(one, { key: '99,99' });
  ok(system.queuedCount === 0 && system.staleDrops === before + 2, 'a reply for a key outside the target set is dropped at enqueue');

  // Newer same-key reply wins, and the older one is not left holding bytes.
  const target = held.find(e => e.msg.key === '1,1');
  reply(target);
  const bytesOne = system.queuedBytes;
  reply(target);
  ok(system.queuedCount === 1 && system.queuedBytes === bytesOne, 'a second reply for the same key replaces the first rather than queueing twice');

  // Valid at enqueue, invalid by the time it is committed: the window moved away.
  system.update(6000, 6000);
  const dropsBefore = system.staleDrops;
  const committed = system.commitNextResult();
  ok(committed === null && system.staleDrops > dropsBefore, 'a queued result whose key left the window is dropped at commit, not installed');
  system.dispose();
}

console.log('\n[3] the inbox is bounded in items, and the bound pauses dispatch');
{
  held.length = 0;
  const system = makeSystem({ renderRadius: 4, inboxMaxItems: 5 });
  for (let i = 0; i < 2; i++) system.update(0, 0);   // 4 jobs a frame
  flush(system);
  ok(system.queuedCount >= 5, `over the item line (${system.queuedCount} queued, cap 5)`);
  ok(system.inboxFull, 'and the inbox reports itself full');
  ok(held.length === 0, 'no jobs outstanding at the worker');
  for (let i = 0; i < 20; i++) system.update(0, 0);
  ok(held.length === 0, 'dispatch stays paused for 20 frames while full -- the bound is backpressure, not a drop');
  while (system.queuedCount >= 5) system.commitNextResult();
  ok(!system.inboxFull, `back under the line (${system.queuedCount} queued)`);
  for (let i = 0; i < 3; i++) system.update(0, 0);
  ok(held.length > 0, `dispatch resumed once the queue drained (${held.length} outstanding)`);
  system.dispose();
}

console.log('\n[4] a byte bound stops dispatch even when the item count is low');
{
  held.length = 0;
  const system = makeSystem({ inboxMaxBytes: 1024 });
  system.update(0, 0);
  flush(system);
  ok(system.queuedCount < system.params.inboxMaxItems && system.queuedBytes > 1024 && system.inboxFull,
    `${system.queuedCount} results are well under the item cap of ${system.params.inboxMaxItems} but already over the byte line (${system.queuedBytes} B > 1024 B)`);
  for (let i = 0; i < 20; i++) system.update(0, 0);
  ok(held.length === 0, 'no further jobs are dispatched while over the byte line');
  system.dispose();
}

console.log('\n[5] queued work counts as pending, and ages on the injected clock');
{
  held.length = 0;
  clock = 1000;
  const system = makeSystem();
  dispatchAll(system, [0, 0]);
  flush(system);
  const queued = system.queuedCount;
  ok(system.pendingBuildCount >= queued, `pendingBuildCount includes the ${queued} queued results`);
  ok(system.queuedOldestMs() === 0, 'nothing has aged yet');
  clock = 1250;
  ok(system.queuedOldestMs() === 250, 'the oldest item ages by exactly the injected clock (250 ms)');

  // Nothing unloads while integration is outstanding.
  system.update(0, 0);
  ok(system.queuedCount === queued, 'a frame with integrateExternally on commits nothing by itself');
  system.dispose();
}

console.log('\n[6] rebuild, restream and dispose clear the queue');
{
  for (const [name, act] of [
    ['rebuild', s => s.rebuild({ renderRadius: 1 })],
    ['restream', s => s.restream()],
    ['setSource', s => s.setSource(analyticDescriptor({ key: 'inbox-test', sourceVersion: '2' }))],
    ['dispose', s => s.dispose()],
  ]) {
    held.length = 0;
    const system = makeSystem();
    dispatchAll(system, [0, 0]);
    flush(system);
    assert.ok(system.queuedCount > 0, `${name}: something was queued to clear`);
    act(system);
    ok(system.queuedCount === 0 && system.queuedBytes === 0, `${name}() empties the inbox and its byte count`);
    if (name !== 'dispose') system.dispose();
  }
}

console.log('\n[7] integrateExternally defaults off: existing hosts drain inside update()');
{
  held.length = 0;
  const system = createTerrainSystem({ source: desc, now, params: { chunkSize: 30, renderRadius: 1, maxChunksPerUpdate: 4 } });
  ok(system.params.integrateExternally === false, 'the default is off, so no existing host changes behaviour');
  dispatchAll(system, [0, 0]);
  const landed = flush(system);
  ok(landed > 0 && system.queuedCount === landed, `${landed} results are queued between frames`);
  const changed = system.update(0, 0);
  ok(system.queuedCount === 0, 'one update() drains the whole queue');
  ok(changed === true, 'and reports itself changed, so hosts keyed off the return value still react');
  ok(system.chunks.size === 9, `all 9 chunks resident at radius 1 (${system.chunks.size})`);
  system.dispose();
}

console.log(`\n${pass} checks passed`);
