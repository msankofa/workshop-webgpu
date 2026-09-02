// bench-base-game-forest.mjs — what a Base Game forest costs, headless.
//
// Not a test: nothing here passes or fails. It reports the numbers the tree plan's stop gates ask
// for — trees standing against trees asked for, draws, triangles per LOD rung, the palette bake,
// and the cost of forest-gpu's full rescan-and-re-upload on a chunk mutation. GPU time is not in
// here; that comes from the page's own frame profiler.
//
// node bench-base-game-forest.mjs

import * as THREE from 'three';
import { createBaseGameForest } from './base-game-forest.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

const geoBytes = geo => {
  let n = geo.index ? geo.index.array.byteLength : 0;
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength;
  return n;
};

async function run(label, settings) {
  const scene = new THREE.Scene();
  const wc = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: wc,
    source: analyticDescriptor({ key: 'measure', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  const renderer = { computeAsync: async () => {} };
  // The benchmark measures bake CPU directly; skip browser task yields so its elapsed figure remains
  // comparable across runs. Base Game itself yields between variants and compute pipelines.
  const forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates: wc,
    settings, yieldTask: async () => {} });
  await forest.load();
  forest.setEnabled(true);
  for (let i = 0; i < 400; i++) {
    terrain.update([0, 12, 0], 1 / 60);
    terrain.fieldScheduler.pump();
    await forest.update();
  }
  const s = forest.sampleDetail();   // per-rung counts are an on-demand scan, not a frame-loop read
  // One chunk mutation = one full rescan + full re-upload. Time it directly.
  const gpu = forest.forestGPU;
  const key = [...forest.trees.records.keys()][0];
  const recs = forest.trees.records.get(key);
  const N = 40;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { gpu.setChunk(key, recs); await gpu.update(); }
  const rescanMs = (performance.now() - t0) / N;
  console.log(`${label}: ${s.trees} trees over ${s.resident} chunks (asked ${Math.round(s.requestedTrees)}, thinned ${(s.coverThinning * 100).toFixed(0)}%)`);
  console.log(`   variants ${s.variants}, capacity ${s.capacity}, main meshes ${s.draws}, ~${(s.triangles / 1000).toFixed(0)}k tris, LOD ${s.lod0}/${s.lod1}/${s.lod2}`);
  console.log(`   palette bake ${s.paletteMs.toFixed(0)} ms, render warmup ${s.compileMs.toFixed(0)} ms, compute warmup ${s.computeCompileMs.toFixed(0)} ms`);
  console.log(`   placement ${s.placeMs.toFixed(2)} ms/frame, full rescan+upload ${rescanMs.toFixed(2)} ms`);
  console.log(`   rung triangles ${forest.rungTriangles.map(t => t.toFixed(0)).join(' / ')}`);

  // What the frame loop costs standing still, and whether anything in it walks the instances.
  const scansBefore = gpu.summary.cullEstimates;
  const tIdle = performance.now();
  for (let i = 0; i < 200; i++) await forest.update();
  const idleMs = (performance.now() - tIdle) / 200;
  console.log(`   idle update ${idleMs.toFixed(4)} ms/frame, instance scans over 200 frames ${gpu.summary.cullEstimates - scansBefore}`);

  // Geometry actually uploaded. drawMesh clones per mesh, so branches ship three times a variant.
  const drawn = gpu.meshes.reduce((a, m) => a + geoBytes(m.geometry), 0);
  const seen = new Set();
  let distinct = 0;
  for (const v of forest.palette.variants) {
    for (const g of [v.branches, v.leaves, v.shadow, v.leavesCoarse]) {
      if (seen.has(g)) continue;
      seen.add(g); distinct += geoBytes(g);
    }
  }
  console.log(`   geometry uploaded ${(drawn / 1e6).toFixed(2)} MB across ${gpu.meshes.length} meshes, ${(distinct / 1e6).toFixed(2)} MB distinct`);
  const tri = g => (g?.index ? g.index.count : g.attributes.position.count) / 3;
  const V = forest.palette.variants;
  const mean = f => V.reduce((a, v) => a + tri(f(v)), 0) / V.length;
  console.log(`   per variant: branches ${mean(v => v.branches).toFixed(0)}, leaves ${mean(v => v.leaves).toFixed(0)}, shadow ${mean(v => v.shadow).toFixed(0)}, coarse leaves ${mean(v => v.leavesCoarse).toFixed(0)}`);
  terrain.dispose();
}

const namedDefaults = { treesEnabled: true, treeSpeciesSelection: DEFAULT_BASE_GAME_TREE_SPECIES };
await run('defaults (45/ha, 260 m)', namedDefaults);
await run('dense   (200/ha, 260 m)', { ...namedDefaults, treesPerHectare: 200 });
await run('wide    (45/ha, 600 m)', { ...namedDefaults, treeDrawRadius: 600, treeLodR2: 600 });
