// bench-base-game-terrain.mjs — what Base Game's terrain costs per frame, headless.
//
// Not a test: nothing here passes or fails. It reports the numbers the improve-webgpu audit asks
// for — the per-frame update split standing and walking, what a chunk-boundary crossing costs, how
// much the frame path allocates, and what the panel's stats getter costs at its 15-frame interval.
// GPU time is not in here; that comes from the page's own frame profiler.
//
// node bench-base-game-terrain.mjs [--v5]

import * as THREE from 'three';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { v5Descriptor } from './terrain-source-v5.js';

const FRAME = 1 / 60;
const useV5 = process.argv.includes('--v5');
const ms = v => v.toFixed(3);
// Hoisted: a fresh [x, y, z] per call would be the harness's own garbage, not the module's.
const AT = [0, 0, 0];
const at = (x, z) => { AT[0] = x; AT[2] = z; return AT; };

function v5Project() {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'F1', params: { amplitude: 25, scale: 260, seedOffset: 2 } }));
  return migrateProjectToUnbounded(normalizeProject({
    app: PROJECT_APP, version: 1, name: 'Bench',
    cfg: { ...DEFAULT_CONFIG, seed: 4242, preview_resolution: 32 },
    density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {},
  }).project);
}

function build(params = {}) {
  const scene = new THREE.Scene();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: createWorldCoordinateSpace(),
    source: useV5 ? v5Descriptor(v5Project()) : analyticDescriptor({ key: 'bench', seaLevel: 0 }),
    useWorker: false, params,
  });
  terrain.setActive(true);
  return terrain;
}

// Percentiles over a sample array, so a rare boundary frame is visible rather than averaged away.
function pct(list, p) {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function report(label, samples) {
  console.log(`  ${label.padEnd(26)} p50 ${ms(pct(samples, 0.5))} ms  p95 ${ms(pct(samples, 0.95))} ms  max ${ms(Math.max(...samples))} ms`);
}

console.log(`\nsource: ${useV5 ? 'v5-recipe' : 'analytic'}`);

// [1] Steady state: the player stands still, so nothing streams and update() is pure overhead.
{
  const terrain = build();
  for (let i = 0; i < 600; i++) terrain.update([0, 0, 0], FRAME);   // settle: stream the window in
  const samples = [];
  for (let i = 0; i < 600; i++) { const t = performance.now(); terrain.update([0, 0, 0], FRAME); samples.push(performance.now() - t); }
  console.log('\n[1] standing still (nothing streams)');
  report('terrain.update', samples);
  console.log(`  resident ${terrain.stats.residentTiles} / target ${terrain.stats.targetTiles}, draws ${terrain.stats.draws}, triangles ${terrain.stats.triangles}`);
  terrain.dispose();
}

// [2] Walking: 5 m/s in a straight line, so a chunk boundary is crossed every 6 s.
{
  const terrain = build();
  for (let i = 0; i < 600; i++) terrain.update([0, 0, 0], FRAME);
  const samples = [], boundary = [];
  const split = { colorizeMs: 0, batchMs: 0, colliderMs: 0, fieldMs: 0 };
  let x = 0, lastChunk = 0;
  for (let i = 0; i < 1800; i++) {
    x += 5 * FRAME;
    const chunk = Math.floor(x / 30);
    const t = performance.now();
    terrain.update([x, 0, 0], FRAME);
    const dtMs = performance.now() - t;
    (chunk !== lastChunk ? boundary : samples).push(dtMs);
    const fc = terrain.frameCost;
    split.colorizeMs += fc.colorizeMs; split.batchMs += fc.batchMs; split.colliderMs += fc.colliderMs; split.fieldMs += fc.fieldMs;
    lastChunk = chunk;
  }
  console.log('\n[2] walking 5 m/s (30 s, 30 m chunks)');
  report('terrain.update', samples);
  if (boundary.length) report('crossing frames only', boundary);
  console.log(`  30 s fold totals: colorize ${ms(split.colorizeMs)} ms, batch ${ms(split.batchMs)} ms, collider ${ms(split.colliderMs)} ms, field ${ms(split.fieldMs)} ms`);
  console.log(`  installs/s ${terrain.stats.installsPerSecond.toFixed(1)}, installed total ${terrain.stats.installedTotal} (residency growth, not chunks built)`);
  terrain.dispose();
}

// [3] What the frame path allocates. The heap delta over N quiet frames, with the collector asked
// to run first, is a floor on per-frame garbage — not an exact count.
{
  const terrain = build();
  for (let i = 0; i < 600; i++) terrain.update([0, 0, 0], FRAME);
  const N = 20000;
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < N; i++) { terrain.update(at(0, 0), FRAME); const c = terrain.frameCost; if (c.foldMs < -1) console.log('unreachable'); }
  const after = process.memoryUsage().heapUsed;
  console.log('\n[3] frame-path allocation (update + frameCost, standing)');
  console.log(`  heap delta over ${N} frames: ${((after - before) / 1024).toFixed(0)} KB  (${((after - before) / N).toFixed(1)} bytes/frame)`);
  console.log(`  ${global.gc ? 'gc available' : 'run with --expose-gc for a cleaner floor'}`);
  terrain.dispose();
}

// [3b] Where that garbage comes from: the same quiet frame with each suspect isolated.
{
  const terrain = build();
  for (let i = 0; i < 600; i++) terrain.update([0, 0, 0], FRAME);
  const N = 20000;
  // heapUsed carries collector state, so one sample is noise. Five runs, report the smallest:
  // it is the tightest upper bound the method can give.
  const measure = (label, fn) => {
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < N; i++) fn();
      best = Math.min(best, (process.memoryUsage().heapUsed - before) / N);
    }
    console.log(`  ${label.padEnd(26)} ${best.toFixed(1)} bytes/call`);
  };
  console.log('');
  console.log('[3b] allocation by piece');
  measure('empty loop (noise floor)', () => {});
  measure('terrain.update', () => terrain.update(at(0, 0), FRAME));
  measure('terrain.frameCost', () => { const c = terrain.frameCost; if (c.foldMs < -1) console.log('unreachable'); });
  measure('system.update', () => terrain.system.update(0, 0));
  measure('system.takeInstallCost', () => terrain.system.takeInstallCost());
  measure('terrain.fields (Set iter)', () => terrain.fields);
  terrain.dispose();
}


// [4] The panel readout. base-game.html reads terrain.stats every 15 frames, so this is 4 Hz.
{
  const terrain = build();
  for (let i = 0; i < 600; i++) terrain.update([0, 0, 0], FRAME);
  const samples = [];
  for (let i = 0; i < 400; i++) { const t = performance.now(); const s = terrain.stats; if (s.residentTiles < 0) console.log('unreachable'); samples.push(performance.now() - t); }
  console.log('\n[4] terrain.stats (panel readout, every 15th frame)');
  report('terrain.stats', samples);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) { const s = terrain.stats; if (s.residentTiles < 0) console.log('unreachable'); }
  console.log(`  heap delta over 2000 reads: ${((process.memoryUsage().heapUsed - before) / 1024).toFixed(0)} KB`);
  terrain.dispose();
}

// [5] The two rebuild paths a slider can drive: draw radius and sea level.
{
  const terrain = build();
  for (let i = 0; i < 600; i++) terrain.update([0, 0, 0], FRAME);
  const beforeChunks = terrain.stats.residentTiles;
  const t0 = performance.now();
  terrain.setSeaLevel(4);
  const seaMs = performance.now() - t0;
  const t1 = performance.now();
  terrain.setDrawRadius(6);
  terrain.update([0, 0, 0], FRAME);
  const radiusMs = performance.now() - t1;
  let settle = 0;
  const t2 = performance.now();
  for (let i = 0; i < 4000 && terrain.stats.residentTiles < terrain.stats.targetTiles; i++) { terrain.update([0, 0, 0], FRAME); settle++; }
  console.log('\n[5] rebuild paths');
  console.log(`  setSeaLevel(4) recolour: ${ms(seaMs)} ms for ${beforeChunks} chunks`);
  console.log(`  setDrawRadius(3 -> 6): first update ${ms(radiusMs)} ms, ${settle} frames and ${ms(performance.now() - t2)} ms to refill ${terrain.stats.residentTiles} chunks`);
  terrain.dispose();
}
