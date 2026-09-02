import * as THREE from 'three';
import { createBaseGameForest } from '../../base-game-forest.js';
import { createBaseGameTerrain } from '../../base-game-terrain.js';
import { createWorldQueryService } from '../../world-query.js';
import { createWorldCoordinateSpace } from '../../world-coordinates.js';
import { analyticDescriptor } from '../../terrain-source-analytic.js';

const scene = new THREE.Scene();
const worldCoordinates = createWorldCoordinateSpace();
const terrain = createBaseGameTerrain({ scene, worldQuery: createWorldQueryService(), worldCoordinates,
  source: analyticDescriptor({ key: 'probe', seaLevel: 0 }), useWorker: false });
terrain.setActive(true);
const camera = new THREE.PerspectiveCamera(70, 16/9, 0.1, 2000);
camera.position.set(0, 12, 0);
const renderer = { computeAsync: async () => {} };
const forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates, settings: { treesEnabled: true }, yieldTask: async () => {} });
await forest.load();
forest.setEnabled(true);
for (let i = 0; i < 200; i++) { terrain.update([0,12,0], 1/60); terrain.fieldScheduler.pump(); await forest.update(); }
const tris = g => g ? ((g.index ? g.index.count : g.attributes.position.count) / 3) | 0 : 0;
for (const v of forest.palette.variants) {
  if (!v) continue;
  console.log(`v${v.speciesIdx}.${v.variant}`,
    'branchesL0', tris(v.branches), 'L1', tris(v.branchesLod1 ?? v.branches), 'L2', tris(v.branchesLod2 ?? v.branches),
    '| leaves', tris(v.leaves), 'shadowCards', tris(v.shadow), 'coarse', tris(v.leavesCoarse));
}
