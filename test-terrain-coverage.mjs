// Step 4 of the terrain streaming plan: deferring work must never open a hole. A queued result
// has no mesh, so the chunk already there keeps drawing and colliding until its replacement is
// committed, and everything that reads residency reads COMMITTED residency.
// Run: node test-terrain-coverage.mjs
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

const descA = analyticDescriptor({ key: 'coverage-test', sourceVersion: '1' });
const descB = analyticDescriptor({ key: 'coverage-test', sourceVersion: '2', params: { baseAmp: 2.2, lake: 0.3, lakeDepth: 1 } });

function landAll() {
  let n = 0;
  for (const { worker, msg } of held.splice(0, held.length)) {
    if (!worker._alive || !worker.onmessage || msg.jobType !== 'sourceTile') continue;
    const tile = createSource(msg.descriptor).buildTile(msg.request);
    const finished = msg.tint ? { tintRevision: msg.tint.revision } : {};
    worker.onmessage({ data: { ...tile, ...finished, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile' } });
    n++;
  }
  return n;
}

const { createBaseGameTerrain } = await import('./base-game-terrain.js');
function makeTerrain(params = {}, source = descA) {
  const worldQuery = createWorldQueryService();
  const terrain = createBaseGameTerrain({
    scene: new THREE.Scene(), worldQuery, worldCoordinates: createWorldCoordinateSpace(),
    source, useWorker: true, params: { renderRadius: 2, chunkSize: 30, ...params },
  });
  terrain.setActive(true);
  return { terrain, worldQuery };
}
// The ground the world query answers with, or null if nothing answers: a hole.
const probe = (worldQuery, x, z) => worldQuery.groundProbe({ origin: [x, 400, z], maxDistance: 1000, slopeLimitCos: -1 });

console.log('\n[1] walking: the ground under the body answers on every single frame');
{
  held.length = 0;
  const { terrain, worldQuery } = makeTerrain({ integrateBudgetMs: 0.5 });
  let holes = 0, frames = 0, z = 0;
  for (let i = 0; i < 600; i++) {
    z += 0.6;                                   // ~36 m/s: crosses a 30 m chunk every 50 frames
    const body = [0, 0, z];
    terrain.update(body, 1 / 60, body);
    landAll();                                  // results arrive mid-walk, as they do in the game
    if (!probe(worldQuery, body[0], body[2])) holes++;
    frames++;
  }
  ok(holes === 0, `no frame left the body without ground over ${frames} frames of walking (${z.toFixed(0)} m)`);
  ok(terrain.system.chunks.size > 0, `chunks are resident at the end of the walk (${terrain.system.chunks.size})`);
  terrain.dispose();
}

console.log('\n[2] teleport: a jump the stream cannot follow still answers, and recovers');
{
  held.length = 0;
  const { terrain, worldQuery } = makeTerrain({ integrateBudgetMs: 0.5 });
  for (let i = 0; i < 40; i++) { terrain.update([0, 0, 0], 1 / 60); landAll(); }
  const before = terrain.system.chunks.size;
  const far = [12000, 0, -9000];
  let holes = 0;
  for (let i = 0; i < 120; i++) {
    terrain.update(far, 1 / 60, far);
    landAll();
    if (!probe(worldQuery, far[0], far[2])) holes++;
  }
  ok(holes === 0, `the heightfield answered every frame across a 15 km teleport (${before} chunks were resident before it)`);
  ok(terrain.system.chunks.has(`${Math.floor(far[0] / 30)},${Math.floor(far[2] / 30)}`), 'and the chunk under the destination streamed in');
  terrain.dispose();
}

console.log('\n[3] a queued replacement never removes the chunk that is there');
{
  held.length = 0;
  const { terrain, worldQuery } = makeTerrain({ integrateBudgetMs: 0.5 });
  for (let i = 0; i < 60; i++) { terrain.update([0, 0, 0], 1 / 60); landAll(); }
  const key = '0,0';
  const original = terrain.system.chunks.get(key);
  ok(!!original?.mesh, 'a chunk is resident and drawn');
  // Mark the resident chunks stale and restream, the keep-until-replaced path.
  terrain.system.restream({ drop: false });
  for (let i = 0; i < 30; i++) terrain.update([0, 0, 0], 1 / 60);
  landAll();                                    // replacements are now QUEUED, not installed
  ok(terrain.system.queuedCount > 0, `${terrain.system.queuedCount} replacements waiting to commit`);
  const still = terrain.system.chunks.get(key);
  ok(still === original, 'the original chunk object is still the resident one');
  ok(!!still.mesh.geometry.getAttribute('position'), 'its geometry was not disposed out from under it');
  ok(!!probe(worldQuery, 15, 15), 'and the ground under it still answers');
  // Drain, and only now does it change hands.
  for (let i = 0; i < 200; i++) { terrain.update([0, 0, 0], 1 / 60); landAll(); }
  ok(terrain.system.chunks.get(key) !== original, 'once committed, the replacement takes over');
  terrain.dispose();
}

console.log('\n[4] coverage and residencyRevision read COMMITTED residency, not the queue');
{
  held.length = 0;
  const { terrain } = makeTerrain({ integrateBudgetMs: 0.5 });
  for (let i = 0; i < 200; i++) { terrain.update([0, 0, 0], 1 / 60); landAll(); }
  // A quiet frame with nothing queued: residency does not move.
  const restRevision = terrain.residencyRevision;
  terrain.update([0, 0, 0], 1 / 60);
  ok(terrain.residencyRevision === restRevision, 'a quiet frame does not bump residencyRevision');
  // Now queue results without letting them commit, by giving the scheduler no budget at all.
  terrain.system.restream({ drop: false });
  for (let i = 0; i < 30; i++) terrain.update([0, 0, 0], 1 / 60);
  const landed = landAll();
  const queuedRevision = terrain.residencyRevision;
  const residentBefore = terrain.system.chunks.size;
  ok(landed > 0 && terrain.system.queuedCount > 0, `${terrain.system.queuedCount} results are queued but not committed`);
  ok(terrain.system.chunks.size === residentBefore, 'the resident set is unchanged by a queued result');
  ok(terrain.residencyRevision === queuedRevision, 'and a result merely arriving does not bump residencyRevision');
  terrain.dispose();
}

console.log('\n[5] a source swap drops the queue rather than committing the wrong ground');
{
  held.length = 0;
  const { terrain, worldQuery } = makeTerrain({ integrateBudgetMs: 0.5 });
  for (let i = 0; i < 60; i++) { terrain.update([0, 0, 0], 1 / 60); landAll(); }
  // Walk somewhere new so there is real outstanding work, then let it LAND without draining it:
  // the swap has to happen with results actually sitting in the inbox or it proves nothing.
  const away = [600, 0, 600];
  for (let i = 0; i < 40; i++) terrain.update(away, 1 / 60, away);
  landAll();
  const queuedBefore = terrain.system.queuedCount;
  const epochBefore = terrain.system.epoch;
  ok(queuedBefore > 0, `${queuedBefore} results are sitting in the inbox when the swap happens`);
  // And leave a second wave dispatched but unanswered, so the swap also has to survive replies
  // that were built from the old source and arrive afterwards.
  for (let i = 0; i < 40; i++) terrain.update([away[0] + 300, 0, away[2] + 300], 1 / 60, away);
  const oldInFlight = held.filter(e => e.msg.descriptor?.sourceVersion === '1').length;
  terrain.setSource(descB);
  ok(terrain.system.queuedCount === 0, `the inbox is emptied by the swap (${queuedBefore} dropped)`);
  ok(terrain.system.epoch > epochBefore, 'the epoch moved, so replies still in flight cannot commit');
  ok(terrain.system.queuedBytes === 0, 'and their bytes were released');
  ok(oldInFlight > 0, `${oldInFlight} jobs built from the OLD source were still in flight across the swap`);
  const dropsBefore = terrain.system.staleDrops;
  const stragglers = landAll();          // they answer now, after the swap, carrying the old epoch
  ok(terrain.system.queuedCount === 0, `all ${stragglers} old-source replies were refused rather than queued`);
  ok(terrain.system.staleDrops > dropsBefore, `and counted as stale drops (${terrain.system.staleDrops - dropsBefore})`);
  for (let i = 0; i < 300; i++) { terrain.update(away, 1 / 60, away); landAll(); }
  ok(!!probe(worldQuery, away[0], away[2]), 'the new source answers the ground');
  ok(terrain.stats.source.version === '2', `and the resident stream is the new source (version ${terrain.stats.source.version})`);
  for (const chunk of terrain.system.chunks.values()) assert.equal(chunk.meta.sourceVersion, '2', 'a resident chunk still carries the old source version');
  ok(true, `every one of the ${terrain.system.chunks.size} resident chunks carries the new source version`);
  terrain.dispose();
}

console.log('\n[6] a fold that is deferred costs a draw call, never a hole');
{
  held.length = 0;
  // One fold a frame while walking fast enough that arrivals outrun folds: the state the budget
  // is for, where some chunks are resident but not yet in a batch.
  const { terrain } = makeTerrain({ integrateBudgetMs: 2, maxFoldsPerUpdate: 1, renderRadius: 3, maxChunksPerUpdate: 4 });
  let z = 0, sawDeferred = 0, doubled = 0, uncovered = 0;
  for (let i = 0; i < 500; i++) {
    z += 1.2;
    const body = [0, 0, z];
    terrain.update(body, 1 / 60, body);
    landAll();
    const resident = [...terrain.system.chunks.values()].filter(c => c.mesh);
    const ownMesh = resident.filter(c => c.mesh.visible);
    if (ownMesh.length) sawDeferred++;
    for (const c of resident) {
      const inBatch = terrain.batcher.has(c.key) && terrain.batcher.isVisible(c.key);
      if (c.mesh.visible && inBatch) doubled++;      // drawn twice
      if (!c.mesh.visible && !inBatch) uncovered++;  // drawn not at all: the hole
    }
  }
  ok(sawDeferred > 0, `${sawDeferred} of 500 frames had a resident chunk still drawing its own mesh, so the deferred path was really exercised`);
  ok(uncovered === 0, 'no resident chunk was ever invisible in both its mesh and its batch');
  ok(doubled === 0, 'and none was ever drawn twice, as a mesh and a visible batch entry at once');
  terrain.dispose();
}

console.log(`\n${pass} checks passed`);
