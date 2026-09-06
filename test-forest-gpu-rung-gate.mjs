// The rung gate hides a variant's rung mesh when no tree of that variant can be in that rung.
// Bucketing is by ring distance with slack, never by cone or occlusion, so it is an upper bound on
// the kernel's own selection: a hidden mesh never has a live indirect count.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createForestGPU } from './forest-gpu.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 2),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }], leafCount: 3, leafSize: 1, leafShadowPct: 0.3,
};
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 1 });
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
camera.position.set(0, 10, 0);
camera.lookAt(0, 0, -100);
camera.updateMatrixWorld(true);
let computes = 0;
function make(extra = {}) {
  return createForestGPU({
    renderer: { computeAsync: async () => { computes++; } }, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 64,
    billboards: false, shadowLayer: 5, ...extra,
  });
}
const rec = (x, z, speciesIdx = 0) => ({ x, z, scale: 1, yaw: 0, speciesIdx, slot: 0 });
const visible = (forest, re) => forest.meshes.filter(m => m.visible && re.test(m.name)).map(m => m.name);
const rungOf = m => /L0$/.test(m) ? 0 : /L1$/.test(m) ? 1 : /L2$/.test(m) ? 2 : /Shadow$/.test(m) ? 'shadow' : null;

// Species 0 near (30 m, behind the camera too), species 1 far (200 m): rung 0 and rung 2 only.
{
  const forest = make();
  forest.setShadowReach(90);
  forest.setChunk('a', [rec(0, -30, 0), rec(0, 30, 0), rec(0, -200, 1), rec(150, -150, 1)]);
  await forest.update();
  const v0 = visible(forest, /forest:v0:/), v1 = visible(forest, /forest:v1:/);
  assert.deepEqual([...new Set(v0.map(rungOf))].sort(), [0, 'shadow'], `v0 rungs ${v0}`);
  assert.deepEqual([...new Set(v1.map(rungOf))].sort(), [2], `v1 rungs ${v1}`);
  assert.equal(forest.summary.draws, 3 + 2, 'three L0 meshes for v0, two L2 meshes for v1');
  assert.equal(forest.summary.shadowDraws, 2, 'only the near variant is within shadow reach');
  assert.equal(forest.summary.rungMeshesHidden, 7 * 2 + 2 * 2 - 5 - 2);
  // The tree behind the camera keeps rung 0 populated: the gate ignores the cone on purpose.
  forest.setChunk('a', [rec(0, 30, 0)]);
  await forest.update();
  assert.deepEqual([...new Set(visible(forest, /forest:v0:/).map(rungOf))].sort(), [0, 'shadow']);
  console.log('gate: near variant draws rung 0 only, far variant rung 2 only, cone ignored');

  // Camera moves out: the same trees fall through the rungs and the meshes follow.
  camera.position.set(0, 10, 100); camera.updateMatrixWorld(true);
  forest.setChunk('a', [rec(0, -30, 0)]);
  await forest.update();
  assert.deepEqual([...new Set(visible(forest, /forest:v0:/).map(rungOf))].sort(), [1], 'at 130 m the tree is rung 1 and out of shadow reach');
  camera.position.set(0, 10, 0); camera.updateMatrixWorld(true);
  await forest.update();
  assert.deepEqual([...new Set(visible(forest, /forest:v0:/).map(rungOf))].sort(), [0, 'shadow'], 'and comes back');
  console.log('gate: follows the camera through the rings');

  // Ring slack: a tree at exactly r0 keeps both neighbouring rungs.
  forest.setChunk('a', [rec(0, -60, 0)]);
  await forest.update();
  assert.deepEqual([...new Set(visible(forest, /forest:v0:/).map(rungOf))].sort(), [0, 1, 'shadow'], 'a tree on the ring is a candidate for both rungs');
  forest.setShadowReach(0);
  assert.equal(forest.summary.shadowDraws, 0);
  console.log('gate: ring slack keeps both rungs at a boundary; reach 0 empties the shadow pair');
  forest.dispose();
}

// Off switch: every wanted mesh draws regardless of distance.
{
  const forest = make({ rungGate: false });
  forest.setShadowReach(90);
  forest.setChunk('a', [rec(0, -30, 0), rec(0, -200, 1)]);
  await forest.update();
  assert.equal(forest.summary.rungGate, false);
  assert.equal(forest.summary.draws, 2 * 7);
  assert.equal(forest.summary.shadowDraws, 2 * 2);
  assert.equal(forest.summary.rungMeshesHidden, 0);
  console.log('gate off: 7 main + 2 shadow meshes per populated variant, as before');
  forest.dispose();
}
