// The shared terrain worker pool: sized once from the machine, one facade per system, replies routed
// to the system that asked, detach without killing threads.
import assert from 'node:assert/strict';
import { createTerrainWorkerPool, defaultTerrainWorkerCount } from './terrain-worker-pool.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok   ${msg}`); pass++; };

// A worker that echoes what it was sent, owner tag included, like terrain-worker.js does.
const spawned = [];
class FakeWorker {
  constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.terminated = false; spawned.push(this); }
  postMessage(msg) { this.sent.push(msg); queueMicrotask(() => this.onmessage?.({ data: { key: msg.key, owner: msg.owner, echoed: true } })); }
  terminate() { this.terminated = true; }
}
const tick = () => new Promise(r => setTimeout(r, 0));

console.log('\n[1] sizing from the machine');
ok(defaultTerrainWorkerCount(4) === 1, `4 cores -> 1 worker (${defaultTerrainWorkerCount(4)})`);
ok(defaultTerrainWorkerCount(8) === 3, `8 cores -> 3 workers (${defaultTerrainWorkerCount(8)})`);
ok(defaultTerrainWorkerCount(12) === 4, `12 cores -> capped at 4 (${defaultTerrainWorkerCount(12)})`);
ok(defaultTerrainWorkerCount(32) === 4, `32 cores -> still 4 (${defaultTerrainWorkerCount(32)})`);
ok(defaultTerrainWorkerCount(undefined, 2) <= 2, 'the cap is honoured');

console.log('\n[2] one pool, four owners, replies routed home');
{
  spawned.length = 0;
  const pool = createTerrainWorkerPool({ count: 3, WorkerCtor: FakeWorker });
  ok(pool.count === 3 && spawned.length === 3, `three threads for four systems, not twelve (${spawned.length} spawned)`);
  const got = [[], [], [], []];
  const facades = got.map((list) => pool.attach(data => list.push(data)));
  ok(pool.owners === 4, 'four owners attached');
  ok(facades.every(f => f && f.count === 3), 'every facade reports the shared thread count');
  facades[0].postMessage({ key: 'a' });
  ok(pool.busyWorkers === 1 && pool.outstanding.join() === '1,0,0', 'one job posted: exactly one worker is busy until it replies');
  facades[1].postMessage({ key: 'b' }); facades[2].postMessage({ key: 'c' }); facades[3].postMessage({ key: 'd' }); facades[0].postMessage({ key: 'e' });
  await tick();
  ok(got[0].map(d => d.key).join() === 'a,e' && got[1].map(d => d.key).join() === 'b' && got[2].map(d => d.key).join() === 'c' && got[3].map(d => d.key).join() === 'd', `each system got only its own replies (${got.map(l => l.map(d => d.key).join('+')).join(' | ')})`);
  const perWorker = spawned.map(w => w.sent.length);
  ok(perWorker.join() === '2,2,1', `jobs round-robin across the shared threads (${perWorker.join('/')})`);
  ok(spawned.every(w => w.sent.every(m => typeof m.owner === 'number')), 'every job carries its owner tag');
  ok(pool.busyWorkers === 0, 'once every job has been answered no worker is busy');

  // Detach one system: its threads live on for the others, its late replies are dropped.
  facades[1].terminate();
  ok(pool.owners === 3 && spawned.every(w => !w.terminated), 'terminate() detaches the owner and kills no thread');
  facades[1].postMessage({ key: 'late' });
  spawned[0].onmessage({ data: { key: 'stale', owner: 2 } });
  await tick();
  ok(got[1].length === 1, 'a detached owner sends nothing and receives nothing');

  pool.dispose();
  ok(spawned.every(w => w.terminated) && pool.count === 0 && pool.owners === 0, 'dispose() terminates the threads and clears the owners');
  ok(pool.attach(() => {}) === null, 'a disposed pool hands out no facade');
}

console.log('\n[3] no worker support: the pool is unavailable and a system falls back to spawning its own');
{
  const pool = createTerrainWorkerPool({ count: 2, WorkerCtor: function () { throw new Error('no workers here'); } });
  ok(pool.count === 0 && !pool.available && pool.attach(() => {}) === null, 'unavailable pool, null facade');
}

console.log('\n[4] a terrain system uses the pool instead of its own threads');
{
  const { createTerrainSystem } = await import('./terrain-system.js');
  spawned.length = 0;
  const pool = createTerrainWorkerPool({ count: 2, WorkerCtor: FakeWorker });
  const saved = globalThis.Worker;
  globalThis.Worker = function () { throw new Error('a system given a pool must not spawn'); };
  let a, b;
  try {
    a = createTerrainSystem({ params: { chunkSize: 30, renderRadius: 1, useWorker: true }, workerPool: pool });
    b = createTerrainSystem({ params: { chunkSize: 120, renderRadius: 1, useWorker: true }, workerPool: pool });
  } finally { globalThis.Worker = saved; }
  ok(spawned.length === 2 && pool.owners === 2 && a.worker && b.worker && a.worker.count === 2, 'two systems, one pool, two threads, no extra spawn');
  a.dispose();
  ok(pool.owners === 1 && spawned.every(w => !w.terminated), 'disposing one system detaches it and leaves the threads for the other');
  b.dispose(); pool.dispose();
}

console.log(`\n${pass} checks passed`);
