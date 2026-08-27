// test-grass-compute.mjs — the compute grass's CPU-side contracts.
//
// The cull kernel itself needs a GPU, but everything that decides HOW MUCH it runs is plain
// JavaScript: the density ceiling derived from Kmax, and the per-recull dispatch derived from the
// live window. Both were wrong before 2026-08-26 — density saturated at a quarter of the panel's
// slider, and every recull dispatched the buffer ceiling no matter where the radius sat.
//
// node test-grass-compute.mjs

import { readFileSync } from 'node:fs';

// The blade atlas is the only DOM user in the grass chain; stub it so the module loads headless.
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {} }) }) };

const THREE = await import('three');
const { createComputeGrass } = await import('./grass-compute.js');
const { BASE_GAME_FLORA_DEFAULTS } = await import('./base-game-flora.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function rig(opts = {}) {
  const camera = new THREE.PerspectiveCamera();
  const grass = createComputeGrass({
    renderer: { computeAsync: async () => {} }, camera,
    radius: 55, maxRadius: 56.5685424949238, density: 12, ...opts,
  });
  // Each recull needs a new cell, or the cell gate skips it.
  let x = 0;
  const recull = async () => { x += 1000; camera.position.set(x, 0, 0); await grass.update(1); };
  return { grass, camera, recull };
}

section('the density ceiling comes from Kmax');
{
  const { grass } = rig({ Kmax: 256 });
  check('Kmax 256 over a 2 m cell allows 64 blades/m2', grass.stats.maxDensity === 64, `${grass.stats.maxDensity}`);
  check('and the panel slider tops out below that', 60 <= grass.stats.maxDensity);
  const legacy = rig({ Kmax: 64 }).grass;
  check('the old Kmax 64 still means 16 blades/m2', legacy.stats.maxDensity === 16, `${legacy.stats.maxDensity}`);
  check('Base Game asks for the raised ceiling', BASE_GAME_FLORA_DEFAULTS.grassKmax === 256,
    `${BASE_GAME_FLORA_DEFAULTS.grassKmax}`);
}

section('the dispatch follows the live window, not the buffer');
{
  const { grass, recull } = rig({ Kmax: 256 });
  await recull();
  const wide = grass.stats.dispatch;
  check('a full-radius recull dispatches fewer threads than the buffer holds',
    wide < grass.stats.capacity, `${wide} vs ${grass.stats.capacity}`);
  grass.setRadius(20);
  await recull();
  const narrow = grass.stats.dispatch;
  check('shrinking the radius shrinks the dispatch', narrow < wide / 5, `${narrow} vs ${wide}`);
  grass.setRadius(55);
  await recull();
  check('and restoring it restores the dispatch', grass.stats.dispatch === wide, `${grass.stats.dispatch}`);
  grass.setDensity(60);
  await recull();
  check('raising density raises the dispatch', grass.stats.dispatch > wide * 4, `${grass.stats.dispatch} vs ${wide}`);
  const side = 2 * Math.ceil(55 / 2) + 1;      // the live window at radius 55, cellSize 2
  check('density 60 is not silently clamped', grass.stats.dispatch === side * side * 240,
    `${grass.stats.dispatch} vs ${side * side * 240}`);
}

section('the dispatch never outruns the instance buffer');
{
  // The kernel writes one instance per surviving thread. If a dispatch could exceed capacity the
  // uHardCap guard is the only thing standing between it and an out-of-bounds storage write.
  const { grass, recull } = rig({ Kmax: 256 });
  grass.setRadius(1e6);                       // clamped to maxRadius
  grass.setDensity(1e6);                      // clamped to Kmax
  await recull();
  check('worst-case sliders still fit the buffer',
    grass.stats.dispatch <= grass.stats.capacity, `${grass.stats.dispatch} vs ${grass.stats.capacity}`);
}

section('zero density plants nothing');
{
  const { grass, recull } = rig({ Kmax: 256 });
  grass.setDensity(0);
  await recull();
  check('a zero-density recull dispatches nothing meaningful', grass.stats.dispatch <= 1, `${grass.stats.dispatch}`);
}

section('the cell gate still skips reculls');
{
  const { grass, camera } = rig({ Kmax: 256 });
  camera.position.set(0, 0, 0);
  await grass.update(1);
  const after = grass.stats.reculls;
  await grass.update(2);
  await grass.update(3);
  check('standing still skips the recull', grass.stats.reculls === after, `${grass.stats.reculls} vs ${after}`);
  check('and counts the skips', grass.stats.skippedReculls >= 2, `${grass.stats.skippedReculls}`);
}

section('the wind gets a clock, not a frame delta');
{
  // uTime drives the sway phase. Passing dt pins it near 0.016 and the blades hold one fixed bend;
  // a unit test cannot see this because the module is correct and the CALLER was wrong.
  const page = readFileSync('base-game.html', 'utf8');
  const call = page.match(/flora\.update\(([^)]*)\)/);
  check('base-game.html calls flora.update', !!call);
  check('and does not hand it dt', call && !/\bdt\b/.test(call[1]), call?.[1]);
  check('it hands it elapsed seconds', call && /\/\s*1000/.test(call[1]), call?.[1]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
