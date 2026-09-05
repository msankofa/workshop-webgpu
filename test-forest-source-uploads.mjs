import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForestGPU } from './forest-gpu.js';

const geometries = [];
function variant() {
  const geo = () => { const g = new THREE.BoxGeometry(); geometries.push(g); return g; };
  return { branches: geo(), leaves: geo(), shadow: geo(), leavesCoarse: geo() };
}
const gpu = createForestGPU({ renderer: { computeAsync: async () => {} },
  camera: new THREE.PerspectiveCamera(), palette: { variants: [variant(), variant()], variantsPerSpecies: 1 },
  capPerVariant: 4, billboards: false });
const record = (x, speciesIdx = 0, slot = 0) => ({ x, z: 3.1, ground: 2.2, scale: 0.7, yaw: 0.3, speciesIdx, slot });
const first = record(1.1), second = record(4.1, 0, 1), other = record(8.1, 1);
gpu.setChunks(new Map([['a', [first, second]], ['b', [other]]]));
await gpu.update();
const attr = gpu.sourceAttribute;
assert.deepEqual(Array.from(gpu.sourceCounts), [2, 1]);
attr.clearUpdateRanges(); // stand in for the renderer consuming the pending range
const initialVersion = attr.version;
gpu.setChunk('a', [first, second]); await gpu.update();
assert.equal(attr.version, initialVersion, 'identical Float32 records do not trigger uploads');
assert.deepEqual(attr.updateRanges, []);
const changed = { ...second, x: 5.1 };
gpu.setChunk('a', [first, changed]); await gpu.update();
assert.deepEqual(attr.updateRanges, [{ start: 8, count: 8 }], 'one tree updates one 32-byte record');
assert.equal(gpu.sourceArray[8], Math.fround(5.1));
const changedOther = { ...other, x: 10.1 };
gpu.setChunk('b', [changedOther]); await gpu.update();
assert.deepEqual(attr.updateRanges, [{ start: 8, count: 32 }], 'unconsumed ranges survive another rebuild');
attr.clearUpdateRanges();
gpu.setChunk('a', [changed]); await gpu.update();
assert.deepEqual(attr.updateRanges, [{ start: 0, count: 8 }], 'removing a leading tree uploads the shifted survivor');
assert.equal(gpu.sourceCounts[0], 1);
attr.clearUpdateRanges();
gpu.clearChunk('a'); await gpu.update();
assert.equal(gpu.sourceCounts[0], 0);
assert.deepEqual(attr.updateRanges, [], 'removing the final record only changes the count');
gpu.setWorldOrigin(100, 1, 200); await gpu.update();
assert.equal(gpu.sourceArray[32], Math.fround(changedOther.x - 100));
assert.equal(gpu.sourceArray[33], Math.fround(changedOther.ground - 1));
assert.deepEqual(attr.updateRanges, [{ start: 32, count: 8 }]);
attr.clearUpdateRanges();
gpu.setChunk('b', Array.from({ length: 6 }, (_, i) => record(20 + i, 1, i)));
await gpu.update();
assert.equal(gpu.sourceCounts[1], 4);
assert.equal(gpu.summary.droppedInstances, 2, 'capacity policy is unchanged');
assert.deepEqual(attr.updateRanges, [{ start: 32, count: 32 }]);
assert.equal(gpu.sourceArray[32], -80, 'overflow keeps the original insertion order');
gpu.setVariantReady(1, false); await gpu.update();
assert.equal(gpu.sourceCounts[1], 0);
gpu.setVariantReady(1, true); await gpu.update();
assert.equal(gpu.sourceCounts[1], 4, 'publication restores records even when stored values are unchanged');
gpu.dispose(); geometries.forEach(g => g.dispose());
console.log('forest source upload range, precision, removal, rebase, overflow, and publication checks passed');
