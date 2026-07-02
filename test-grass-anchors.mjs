// test-grass-anchors.mjs
// Node test for grass-anchors.js: chunk binning, slope/facing filters, area-weighted
// deterministic sampling, and slot-capacity sizing. Run: node test-grass-anchors.mjs
import assert from 'node:assert/strict';
import {
  buildChunkIndex, sampleChunk, slotCapacityForRadius,
  chunkKey, parseChunkKey, pointToChunkDist, hashKey, mulberry32,
} from './grass-anchors.js';

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
}

// Horizontal quad (two tris) at height y covering [x0,x1]×[z0,z1]; facing up or down.
function quad(x0, z0, x1, z1, y, { up = true } = {}) {
  const t1 = up
    ? [x0, y, z0, x0, y, z1, x1, y, z0]
    : [x0, y, z0, x1, y, z0, x0, y, z1];
  const t2 = up
    ? [x1, y, z1, x1, y, z0, x0, y, z1]
    : [x1, y, z1, x0, y, z1, x1, y, z0];
  return [...t1, ...t2];
}

// Vertical wall at x, spanning [z0,z1]×[y0,y1] (normal is horizontal).
function wall(x, z0, y0, z1, y1) {
  return [x, y0, z0, x, y0, z1, x, y1, z0, x, y1, z1, x, y1, z0, x, y0, z1];
}

// ---- cave scene in chunk (0,0): floor at y=-50, ceiling at y=-20 (down-facing),
// roof top at y=40 (up-facing), plus a wall. All within [0,32]×[0,32]. ----
const positions = new Float32Array([
  ...quad(0, 0, 32, 32, -50, { up: true }),   // cave floor      → keep
  ...quad(0, 0, 32, 32, -20, { up: false }),  // cave ceiling    → reject (down-facing)
  ...quad(0, 0, 32, 32, 40, { up: true }),    // roof top        → keep
  ...wall(0, 0, -50, 32, 40),                 // wall            → reject (slope)
]);

const index = buildChunkIndex(positions, { chunkSize: 32, minNormalY: 0.5 });
ok(index.triCount === 8, 'counts all input triangles');
ok(index.chunks.size === 1 && index.chunks.has('0,0'), 'bins by centroid into one chunk');
const chunk = index.chunks.get('0,0');
ok(chunk.tris.length === 4, 'keeps only up-facing tris (floor + roof top), rejects ceiling and wall');
ok(Math.abs(chunk.totalArea - 2048) < 1e-3, `stacked layers both count: projected area ${chunk.totalArea} ≈ 2048`);

// ---- sampling ----
const density = 2; // anchors per m² of projected area → expect 4096
const a = sampleChunk(index, positions, '0,0', { density, seed: 7 });
ok(a.length === 4096 * 4, `sample count = density × area (${a.length / 4})`);
let onFloor = 0, onRoof = 0;
for (let i = 0; i < a.length; i += 4) {
  const x = a[i], y = a[i + 1], z = a[i + 2], w = a[i + 3];
  ok(x >= 0 && x <= 32 && z >= 0 && z <= 32, 'anchor XZ within chunk');
  ok(y === -50 || y === 40, 'anchor Y exactly on a surface layer');
  ok(w >= 0 && w < 1, 'anchor rand in [0,1)');
  if (y === -50) onFloor++; else onRoof++;
}
// equal areas → roughly half on each layer
ok(Math.abs(onFloor - onRoof) < 4096 * 0.1, `area-weighted across layers (floor ${onFloor} / roof ${onRoof})`);

const b = sampleChunk(index, positions, '0,0', { density, seed: 7 });
ok(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), 'sampling is deterministic for (key, seed)');
const c = sampleChunk(index, positions, '0,0', { density, seed: 8 });
ok(!Buffer.from(a.buffer).equals(Buffer.from(c.buffer)), 'different seed → different anchors');

ok(sampleChunk(index, positions, '5,5', { density }) === null, 'missing chunk → null');
const capped = sampleChunk(index, positions, '0,0', { density, maxCount: 100 });
ok(capped.length === 100 * 4, 'maxCount caps sample count');

// ---- chunk-spanning triangles: low-poly maps have triangles bigger than a chunk;
// they must be clipped per chunk (centroid binning would leave grassless holes). ----
const bigPositions = new Float32Array(quad(0, 0, 64, 64, 5));
const bigIndex = buildChunkIndex(bigPositions, { chunkSize: 32 });
ok(bigIndex.chunks.size === 4, 'spanning quad covers all 4 chunks');
for (const key of ['0,0', '1,0', '0,1', '1,1']) {
  const ch = bigIndex.chunks.get(key);
  ok(Math.abs(ch.totalArea - 1024) < 1e-3, `chunk ${key} clipped area ${ch.totalArea} ≈ 1024`);
  const s = sampleChunk(bigIndex, bigPositions, key, { density: 0.5, seed: 3 });
  ok(s.length === 512 * 4, 'clipped chunk sample count matches clipped area');
  const [ccx, ccz] = parseChunkKey(key);
  for (let i = 0; i < s.length; i += 4) {
    ok(s[i] >= ccx * 32 - 1e-5 && s[i] <= (ccx + 1) * 32 + 1e-5, 'clipped anchor X within its chunk');
    ok(s[i + 2] >= ccz * 32 - 1e-5 && s[i + 2] <= (ccz + 1) * 32 + 1e-5, 'clipped anchor Z within its chunk');
    ok(s[i + 1] === 5, 'clipped anchor keeps surface height');
  }
}

// ---- helpers ----
ok(parseChunkKey(chunkKey(-3, 17)).join(',') === '-3,17', 'chunk key round-trips negatives');
ok(pointToChunkDist(16, 16, 0, 0, 32) === 0, 'point inside chunk → dist 0');
ok(Math.abs(pointToChunkDist(-10, 16, 0, 0, 32) - 10) < 1e-9, 'dist to chunk edge');
const cap = slotCapacityForRadius(100, 32);
// disk of r=100 touches at most ~π(100/32+1.5)² ≈ 68 chunks from any camera point; capacity must exceed that
ok(cap >= 68, `slot capacity ${cap} covers worst case`);
ok(cap < 200, `slot capacity ${cap} is not wildly oversized`);
ok(hashKey('0,0') !== hashKey('0,1'), 'key hash separates chunks');
const rng = mulberry32(42);
ok(rng() !== rng(), 'rng advances');

console.log(`grass-anchors: ${passed} assertions passed`);
