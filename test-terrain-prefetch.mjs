// Step 5 of the terrain streaming plan: the window leads the walk, hysteresis stops a body
// loitering on a boundary from thrashing a chunk, and one in-flight cap is shared by every
// streamer. Run: node test-terrain-prefetch.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSource } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok   ${msg}`); pass++; };

const held = [];
class HeldWorker {
  constructor() { this.onmessage = null; this._alive = true; }
  postMessage(msg) { held.push({ worker: this, msg }); }
  terminate() { this._alive = false; }
}
globalThis.Worker = function () { return new HeldWorker(); };
const desc = analyticDescriptor({ key: 'prefetch-test', sourceVersion: '1' });
function landAll() {
  let n = 0;
  for (const { worker, msg } of held.splice(0, held.length)) {
    if (!worker._alive || !worker.onmessage || msg.jobType !== 'sourceTile') continue;
    const tile = createSource(msg.descriptor).buildTile(msg.request);
    worker.onmessage({ data: { ...tile, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile' } });
    n++;
  }
  return n;
}

const { createTerrainSystem } = await import('./terrain-system.js');
const { createBaseGameTerrain } = await import('./base-game-terrain.js');
const CHUNK = 30;
const makeSystem = (params = {}, extra = {}) => createTerrainSystem({
  source: desc, params: { chunkSize: CHUNK, renderRadius: 2, maxChunksPerUpdate: 4, integrateExternally: true, prefetchChunks: 1, prefetchVehicleChunks: 2, ...params },
  ...extra,
});

console.log('\n[1] a straight walk asks for the next column before the boundary is reached');
{
  held.length = 0;
  const system = makeSystem();
  system.update(0, 0);
  const standing = new Set(system.targetKeys);
  ok(!standing.has('3,0'), 'standing still, the window is the ring and nothing further');
  // Walking +x at 6 m/s, well inside chunk 0 (x = 5 of 30): the column at +3 is already wanted.
  system.setMotion(6, 0);
  system.update(5, 0);
  ok(system.targetKeys.has('3,0'), 'walking +x from inside chunk 0, the column at +3 is already in the target set');
  ok(system.prefetchKeys === 5, `the lead added exactly one column of 5 (${system.prefetchKeys})`);
  ok(!system.targetKeys.has('-3,0'), 'and nothing was added behind the walk');
  system.dispose();
}

console.log('\n[2] a vehicle leads by two columns, a walker by one');
{
  held.length = 0;
  const system = makeSystem();
  system.setMotion(6, 0); system.update(5, 0);
  const walker = system.prefetchKeys;
  system.setMotion(30, 0); system.update(5, 0);
  const vehicle = system.prefetchKeys;
  ok(walker === 5 && vehicle === 10, `walking leads by one column (${walker} keys), a vehicle by two (${vehicle})`);
  ok(system.targetKeys.has('4,0'), 'the second column is in the set at vehicle speed');
  system.setMotion(0, 0); system.update(5, 0);
  ok(system.prefetchKeys === 0, 'and stopping drops the lead entirely');
  system.dispose();
}

console.log('\n[3] a diagonal walk leads along both axes');
{
  held.length = 0;
  const system = makeSystem();
  system.setMotion(6, 6);
  system.update(5, 5);
  ok(system.targetKeys.has('3,0') && system.targetKeys.has('0,3'), 'both the +x and the +z columns are wanted on a diagonal');
  ok(!system.targetKeys.has('-3,0') && !system.targetKeys.has('0,-3'), 'and neither trailing column is');
  system.dispose();
}

console.log('\n[4] a reversal re-aims the lead within the chunk, and does not re-request behind');
{
  held.length = 0;
  const system = makeSystem();
  system.setMotion(6, 0);
  system.update(5, 0);
  const ahead = new Set(system.targetKeys);
  ok(ahead.has('3,0'), 'leading +x');
  // Turn around WITHOUT leaving the chunk: the lead must follow the velocity, not the chunk.
  system.setMotion(-6, 0);
  system.update(5, 0);
  ok(system.targetKeys.has('-3,0'), 'after the reversal the lead points -x, inside the same chunk');
  ok(!system.targetKeys.has('3,0'), 'and the column it was leading toward is no longer wanted');
  // A chunk already built for the old lead must not be rebuilt when the lead swings back onto it.
  for (let i = 0; i < 60; i++) { system.update(5, 0); landAll(); while (system.commitNextResult() !== null); }
  ok(system.chunks.has('-3,0'), 'the trailing column was actually built while the lead pointed at it');
  let rebuilds = 0;
  const realDispatch = system.dispatchChunk.bind(system);
  system.dispatchChunk = (item, ...rest) => { if (item.key === '-3,0') rebuilds++; return realDispatch(item, ...rest); };
  system.setMotion(6, 0);
  for (let i = 0; i < 60; i++) { system.update(5, 0); landAll(); while (system.commitNextResult() !== null); }
  ok(system.targetKeys.has('3,0'), 'swinging back wants the +x column again');
  ok(rebuilds === 0, 'and the chunk built for the old lead was never re-requested');
  system.dispose();
}

console.log('\n[5] hysteresis: loitering on a boundary does not thrash a chunk in and out');
{
  held.length = 0;
  // Two systems side by side, same walk: one with a margin, one without.
  const results = {};
  for (const margin of [0, 1]) {
    held.length = 0;
    const system = makeSystem({ unloadMargin: margin, prefetchChunks: 0, prefetchVehicleChunks: 0, maxChunksPerUpdate: 8 });
    const settle = () => { for (let i = 0; i < 30; i++) { system.update(system.centerX, system.centerZ); landAll(); while (system.commitNextResult() !== null); } };
    system.update(15, 0); settle();
    let builds = 0;
    const realDispatch = system.dispatchChunk.bind(system);
    system.dispatchChunk = (...a) => { builds++; return realDispatch(...a); };
    // Step back and forth across the 0/1 boundary at x = 30, ten times.
    for (let i = 0; i < 10; i++) {
      system.update(29, 0); settle();
      system.update(31, 0); settle();
    }
    results[margin] = builds;
    system.dispose();
  }
  ok(results[1] < results[0], `crossing a boundary 20 times rebuilt ${results[1]} chunks with a margin against ${results[0]} without`);
  // Not zero: the first crossing legitimately widens the window. What the margin removes is the
  // repeat, so the count stops growing with the number of crossings.
  ok(results[1] <= 5, `the margin's ${results[1]} builds are the first crossing, not 20 of them`);
}

console.log('\n[6] one in-flight cap is shared by every streamer, not one each');
{
  held.length = 0;
  const budget = { max: 6, count: 0 };
  const a = makeSystem({ renderRadius: 3 }, { inFlightBudget: budget });
  const b = makeSystem({ renderRadius: 3 }, { inFlightBudget: budget });
  for (let i = 0; i < 20; i++) { a.update(0, 0); b.update(500, 500); }
  ok(budget.count <= budget.max, `the two systems have ${budget.count} jobs outstanding between them, never over the shared cap of ${budget.max}`);
  ok(a.inFlight.size + b.inFlight.size === budget.count, `and the count matches what they actually hold (${a.inFlight.size} + ${b.inFlight.size})`);
  ok(a.inFlight.size > 0 && b.inFlight.size > 0, 'both got a share rather than one starving the other');
  const held0 = held.length;
  for (let i = 0; i < 20; i++) { a.update(0, 0); b.update(500, 500); }
  ok(held.length === held0, 'and neither dispatches another job while the shared cap is full');
  landAll();
  ok(budget.count === 0, 'completing every job releases the whole budget');
  for (let i = 0; i < 5; i++) a.update(0, 0);
  ok(budget.count > 0, 'after which dispatch resumes');
  a.dispose(); b.dispose();
  ok(budget.count === 0, 'and disposing a system releases the slots it was holding');
}

console.log('\n[7] Base Game wires one budget across the near system and the cascade');
{
  held.length = 0;
  const terrain = createBaseGameTerrain({
    scene: new THREE.Scene(), worldQuery: createWorldQueryService(), worldCoordinates: createWorldCoordinateSpace(),
    source: desc, useWorker: true, params: { renderRadius: 3, chunkSize: CHUNK, maxInFlight: 8 },
  });
  terrain.setActive(true);
  for (let i = 0; i < 40; i++) terrain.update([0, 0, 0], 1 / 60, [0, 0, 0]);
  const st = terrain.stats;
  ok(st.maxInFlight === 8 && st.inFlight <= 8, `stats report the shared cap (${st.inFlight}/${st.maxInFlight} outstanding)`);
  // Walking gives the streamers a lead; the stats say so.
  let z = 0;
  for (let i = 0; i < 120; i++) { z += 0.2; terrain.update([0, 0, z], 1 / 60, [0, 0, z]); landAll(); }
  ok(terrain.stats.speed > 5, `the body's speed reaches the streamers (${terrain.stats.speed} m/s, from dt not wall-clock)`);
  ok(terrain.stats.prefetchKeys > 0, `and the window leads it (${terrain.stats.prefetchKeys} keys ahead)`);
  terrain.dispose();
}

console.log('\n[8] an error reply releases its in-flight slot, or errors leak the budget');
{
  held.length = 0;
  const budget = { max: 4, count: 0 };
  const system = makeSystem({ renderRadius: 3 }, { inFlightBudget: budget });
  for (let i = 0; i < 10; i++) system.update(0, 0);
  ok(budget.count === 4, `${budget.count} jobs outstanding, at the cap`);
  // Every one of them comes back as a source error rather than a tile.
  const errored = held.splice(0, held.length);
  for (const { worker, msg } of errored) worker.onmessage({ data: { key: msg.key, epoch: msg.epoch, jobType: 'sourceTile', error: 'simulated source failure', contractError: true } });
  ok(budget.count === 0, `all ${errored.length} error replies released their slots (${budget.count} still held)`);
  ok(system.lastSourceError === 'simulated source failure', 'and the error is reported rather than swallowed');
  for (let i = 0; i < 5; i++) system.update(0, 0);
  ok(budget.count > 0, 'so the streamer can dispatch again instead of deadlocking on leaked slots');
  system.dispose();
  ok(budget.count === 0, 'and dispose releases what was left');
}

console.log(`\n${pass} checks passed`);
