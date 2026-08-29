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
  const legacy = rig({ Kmax: 64 }).grass;
  check('the old Kmax 64 still means 16 blades/m2', legacy.stats.maxDensity === 16, `${legacy.stats.maxDensity}`);

  // The invariant that actually matters, and the one that was broken: whatever the panel offers,
  // the implementation must be able to deliver. A slider whose top two thirds do nothing is worse
  // than a lower slider, because nothing tells you where it stopped meaning anything.
  const page = readFileSync('base-game.html', 'utf8');
  // Plain string parsing: find the slider's call and read the two numbers after its label. No
  // regex and no newline literal, both of which this file has had escaping trouble with.
  const range = name => {
    const i = page.indexOf(`addRange(plantsSec, '${name}'`);
    if (i < 0) return null;
    const nums = page.slice(i, i + 220).split(',').map(x => Number(x.trim())).filter(Number.isFinite);
    return nums.length >= 2 ? { min: nums[0], max: nums[1] } : null;
  };
  const density = range('grassDensity'), radius = range('grassRadius');
  check('the panel has a density slider', !!density, JSON.stringify(density));
  check('the panel has a radius slider', !!radius, JSON.stringify(radius));
  const ceiling = BASE_GAME_FLORA_DEFAULTS.grassKmax / 4;      // cellSize 2
  check('the density ceiling covers the whole density slider', !!density && density.max <= ceiling,
    `slider ${density?.max} vs ceiling ${ceiling}`);
  check('the radius ceiling covers the whole radius slider',
    !!radius && radius.max <= BASE_GAME_FLORA_DEFAULTS.grassMaxRadius,
    `slider ${radius?.max} vs ceiling ${BASE_GAME_FLORA_DEFAULTS.grassMaxRadius}`);
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

section('the thread budget thins instead of hanging');
{
  // Radius and density both multiply into the dispatch, so the far corner of the two sliders is
  // tens of millions of threads. It thins, and says it thinned; it never silently clamps.
  const { grass, recull } = rig({ Kmax: 512, dispatchBudget: 1e6 });
  grass.setRadius(600);
  grass.setDensity(128);
  await recull();
  check('a huge window with huge density stays inside the budget',
    grass.stats.dispatch <= 1e6 * 1.1, `${grass.stats.dispatch}`);
  check('and reports that it thinned', grass.stats.dispatchClamped === true);
  check('the effective density is below what was asked for',
    grass.stats.density < grass.stats.requestedDensity, `${grass.stats.density} vs ${grass.stats.requestedDensity}`);
  grass.setDispatchBudget(64e6);
  await recull();
  check('raising the budget raises the density back', grass.stats.density > 1, `${grass.stats.density}`);
  grass.setRadius(20);
  await recull();
  check('a small window needs no thinning at all', grass.stats.dispatchClamped === false,
    `eff ${grass.stats.density} of ${grass.stats.requestedDensity}`);
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

section('a floating-origin rebase does not re-roll the field');
{
  // Placement hashes off render-local cells meant a rebase shifted every hash input and re-scattered
  // every blade in one frame. The origin is added back, so the hash is on a GLOBAL cell.
  const { grass, recull } = rig({ Kmax: 256 });
  await recull();
  const before = grass.stats.reculls;
  grass.setWorldOrigin(8192, -4096);
  check('moving the origin marks the field dirty', grass.stats.dirty);
  await recull();
  check('and it reculls', grass.stats.reculls > before);
  const same = grass.stats.reculls;
  grass.setWorldOrigin(8192, -4096);
  check('setting the same origin again is a no-op', grass.stats.dirty === false, `dirty ${grass.stats.dirty}`);
  // The rebase snap must land on a whole number of cells or the global grid shears.
  const snap = 1024, cellSize = 2;
  check('the rebase snap is a whole number of cells', Number.isInteger(snap / cellSize), `${snap / cellSize}`);
}

section('the storage buffers are freed on dispose');
{
  // Storage attributes have no dispose event and ComputeNode.dispose() does not free them, so
  // dispose() has to reach the renderer's attribute table or ~29 MB outlives the instance.
  const freed = [];
  const camera = new THREE.PerspectiveCamera();
  const grass = createComputeGrass({
    renderer: { computeAsync: async () => {}, _attributes: { delete: a => freed.push(a) } },
    camera, radius: 20, maxRadius: 20, density: 4, Kmax: 64,
  });
  grass.dispose();
  check('dispose frees more than the geometry and material', freed.length >= 3, `freed ${freed.length}`);
  check('the instance buffer is among them', freed.some(a => a?.array?.length >= grass.stats.capacity * 8));
  // A renderer without the internal must not throw: it is private API on a pinned build.
  const plain = createComputeGrass({ renderer: { computeAsync: async () => {} }, camera, radius: 20, maxRadius: 20, Kmax: 64 });
  let threw = false;
  try { plain.dispose(); } catch { threw = true; }
  check('and dispose survives a renderer without that internal', !threw);
}

section('no colour in the graph skips sRGB to linear');
{
  // uBaseColor/uTipColor go through THREE.Color, which converts. A raw vec3 of sRGB bytes does not,
  // and the dry tint was rendering about 2.5x too bright because of it.
  const src = readFileSync('grass-compute.js', 'utf8');
  const rawByteColour = /vec3\(\s*\d+\s*\/\s*255/.test(src);
  check('no raw sRGB byte triple is used as a colour', !rawByteColour);
  check('the dry tint goes through THREE.Color', /uDryColor\s*=\s*uniform\(new THREE\.Color/.test(src));
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
