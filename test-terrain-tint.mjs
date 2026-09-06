// Step 1 of the terrain streaming plan: the worker finishes the chunk (vertex colours
// and bounds), and a reply whose tint revision is stale is re-tinted on commit.
// Run: node test-terrain-tint.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildChunkArrays, buildChunkArraysFromTile } from './terrain-field.js';
import { createSource } from './terrain-source.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { terrainTintAt, tintTileColors, tintArrayColors, boundsFromPositions, finishTileTint } from './terrain-tint.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok   ${msg}`); pass++; };

const desc = analyticDescriptor({ key: 'tint-test', sourceVersion: '1' });
const source = createSource(desc);
const request = { ix: 0, iz: 0, lod: 0, xMin: 0, zMin: 0, size: 30, intervals: 22, apron: 0, fields: ['heights', 'normals'] };

console.log('\n[1] worker tint matches the main-thread per-vertex pass exactly');
{
  const tile = source.buildTile(request);
  const arrays = buildChunkArraysFromTile(tile);
  const seaLevel = 3.5;
  // What base-game-terrain's colorizeGeometry produces from the finished geometry.
  const reference = new Float32Array(arrays.positions.length);
  for (let i = 0; i < arrays.positions.length / 3; i++) {
    terrainTintAt(arrays.positions[i * 3 + 1] - seaLevel, arrays.normals[i * 3 + 1], reference, i * 3);
  }
  const worker = tintTileColors(tile, seaLevel);
  ok(worker.length === reference.length, `same vertex count (${worker.length / 3})`);
  let maxDiff = 0;
  for (let i = 0; i < reference.length; i++) maxDiff = Math.max(maxDiff, Math.abs(worker[i] - reference[i]));
  ok(maxDiff === 0, `bit-identical colours over the whole tile (max diff ${maxDiff})`);

  // The interleaved form (legacy chunk arrays and volume meshes) agrees too.
  const a = buildChunkArrays(0, 0, 30, 22, { baseAmp: 1, lake: 0.45, lakeDepth: 3.2 }, true);
  const inter = tintArrayColors(a.positions, a.normals, seaLevel);
  let interDiff = 0;
  for (let i = 0; i < a.positions.length / 3; i++) {
    const want = terrainTintAt(a.positions[i * 3 + 1] - seaLevel, a.normals[i * 3 + 1]);
    for (let k = 0; k < 3; k++) interDiff = Math.max(interDiff, Math.abs(inter[i * 3 + k] - want[k]));
  }
  ok(interDiff < 1e-6, `interleaved position/normal tint agrees vertex for vertex (float32 rounding only, ${interDiff.toExponential(1)})`);
}

console.log('\n[2] worker bounds equal what three would compute');
{
  const tile = source.buildTile(request);
  const arrays = buildChunkArraysFromTile(tile);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
  geo.computeBoundingSphere();
  const b = boundsFromPositions(arrays.positions);
  const dc = Math.max(Math.abs(b.center[0] - geo.boundingSphere.center.x), Math.abs(b.center[1] - geo.boundingSphere.center.y), Math.abs(b.center[2] - geo.boundingSphere.center.z));
  ok(dc < 1e-9, `centre matches (${dc.toExponential(1)})`);
  ok(Math.abs(b.radius - geo.boundingSphere.radius) < 1e-9, `radius matches (${b.radius.toFixed(4)} vs ${geo.boundingSphere.radius.toFixed(4)})`);
}

console.log('\n[3] a tile without normals arrives untinted, and the host tints it with slope');
{
  const withNormals = source.buildTile(request);
  const withoutNormals = source.buildTile({ ...request, fields: ['heights'] });
  ok(!withoutNormals.normals, 'the heights-only tile really has no normals');
  const tint = { seaLevel: 0, revision: 7 };
  ok(finishTileTint(withNormals, tint).colors instanceof Float32Array, 'a tile with normals is tinted in the worker');
  const finished = finishTileTint(withoutNormals, tint);
  ok(finished.colors === null, 'a tile without normals comes back untinted rather than tinted flat');
  ok(!!finished.bounds === false, 'and carries no bounds either (they come from the volume positions)');

  // Slope is what would be lost: the rock band only appears once real normals exist, so the flat
  // normalY = 1 tint the worker used to send is not the same picture the host produces.
  const arrays = buildChunkArraysFromTile(withNormals);
  let steepest = 1, at = 0;
  for (let i = 0; i < arrays.normals.length / 3; i++) if (arrays.normals[i * 3 + 1] < steepest) { steepest = arrays.normals[i * 3 + 1]; at = i; }
  const withSlope = terrainTintAt(arrays.positions[at * 3 + 1], steepest);
  const flat = terrainTintAt(arrays.positions[at * 3 + 1], 1);
  const gap = Math.max(...withSlope.map((v, k) => Math.abs(v - flat[k])));
  ok(steepest < 0.82 && gap > 1e-3, `the rock band a flat tint would have lost is real here (normalY ${steepest.toFixed(3)}, colour gap ${gap.toFixed(4)})`);
}

console.log('\n[4] a stale-revision reply is re-tinted on commit, a current one is not');
{
  // A worker that tints under whatever revision the system asked for.
  const dispatched = [];
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; this._alive = true; }
    postMessage(msg) {
      dispatched.push(msg);
      setTimeout(() => {
        if (!this._alive || !this.onmessage || msg.jobType !== 'sourceTile') return;
        const tile = createSource(msg.descriptor).buildTile(msg.request);
        const finished = msg.tint ? { colors: tintTileColors(tile, msg.tint.seaLevel), tintRevision: msg.tint.revision, tintMs: 0.5 } : {};
        this.onmessage({ data: { ...tile, ...finished, key: msg.key, epoch: msg.epoch, jobType: 'sourceTile', sourceKey: msg.descriptor.key, sourceVersion: msg.descriptor.sourceVersion } });
      }, 0);
    }
    terminate() { this._alive = false; }
  }
  globalThis.Worker = function () { return new FakeWorker(); };
  const { createBaseGameTerrain } = await import('./base-game-terrain.js');
  const terrain = createBaseGameTerrain({
    scene: new THREE.Scene(), worldQuery: createWorldQueryService(), worldCoordinates: createWorldCoordinateSpace(),
    source: desc, useWorker: true, params: { renderRadius: 1 },
  });
  terrain.setActive(true);
  const settle = async () => { for (let i = 0; i < 40; i++) { terrain.update([0, 0, 0], 1 / 60); await new Promise(r => setTimeout(r, 0)); } };
  await settle();
  ok(dispatched.some(m => m.tint && m.tint.revision === 1), 'the dispatch carries the tint revision');
  const chunk = terrain.system.chunks.get('0,0');
  ok(!!chunk?.mesh?.geometry.getAttribute('color'), 'the arrived chunk already has worker colours');
  ok(chunk.mesh.geometry.userData.tintRevision === 1, 'and carries the revision it was tinted under');

  // Freeze the colours, then move the waterline: the revision moves on and every chunk is re-tinted.
  const before = Float32Array.from(chunk.mesh.geometry.getAttribute('color').array);
  terrain.setSeaLevel(40);
  const after = chunk.mesh.geometry.getAttribute('color').array;
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  ok(changed > 0, `sea-level change re-tinted the resident chunk (${changed} components changed)`);
  ok(chunk.mesh.geometry.userData.tintRevision === 2, 'the re-tint stamps the new revision');

  // A reply that was in flight across that change arrives stale and is corrected on commit.
  const stale = source.buildTile({ ...request, ix: 1, iz: 1, xMin: 30, zMin: 30 });
  const staleColors = tintTileColors(stale, 0);   // tinted at the OLD sea level
  terrain.system.chunks.delete('1,1');            // as if it were still in flight across the change
  terrain.system.onWorkerChunk({ ...stale, colors: staleColors, tintRevision: 1, key: '1,1', epoch: terrain.system.epoch, jobType: 'sourceTile' });
  // Since step 2 a reply waits in the inbox rather than being installed inside onmessage.
  ok(terrain.system.queuedCount === 1 && !terrain.system.chunks.has('1,1'), 'the stale reply waits in the inbox rather than installing itself');
  terrain.update([0, 0, 0], 1 / 60);
  const staleChunk = terrain.system.chunks.get('1,1');
  ok(!!staleChunk, 'the next update commits it');
  const got = staleChunk.mesh.geometry.getAttribute('color').array;
  const want = tintTileColors(stale, 40);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff = Math.max(diff, Math.abs(got[i] - want[i]));
  ok(diff === 0 && staleChunk.mesh.geometry.userData.tintRevision === 2, 'a stale-revision chunk is re-tinted to the current sea level on commit');
  terrain.dispose();
}

console.log(`\n${pass} checks passed`);
