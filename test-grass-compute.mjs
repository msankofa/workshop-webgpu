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

section('the ground colour is mixed after the palette lighting');
{
  // The ground colour is what the terrain already draws, lit the way the terrain is; the flat
  // key/ambient factor, the cloud noise and the root shade belong to the palette side alone, or
  // a fully tinted blade is 10 % brighter and blotchier than the ground it stands on.
  const src = readFileSync('grass-compute.js', 'utf8');
  check('the palette takes the light, cloud and root-shade terms', /const paletteLit = grassColor\.mul\(uAmbient\.add\(uKey\)\)\.mul\(cloud\)\.mul\(look\.nodes\.rootShade\(bladeT\)\)/.test(src));
  check('and the ground colour is mixed in after them', /const colorNode = mix\(paletteLit, groundColor, tintFinal\)/.test(src));
  check('the normal moves toward the ground\'s up by the same amount', /const normalNode = normalize\(mix\(curl\.normal, upView, tintFinal\)\)/.test(src));
  check('proof mode drops the emissive term', /m\.emissiveNode = emissive\.mul\(float\(1\)\.sub\(proofOnly\)\)/.test(src));
  const { grass } = rig();
  check('the colour mode starts on the palette', grass.colorMode === 'palette');
  grass.setColorMode('ground');
  check('setColorMode switches it', grass.colorMode === 'ground');
  grass.setColorMode('nonsense');
  check('and ignores an unknown key', grass.colorMode === 'ground');
  check('a host without a ground node has no probe', grass.hasGroundProbe === false);
}

section('the fade comes apart into start, end, curve and tapers');
{
  const { fadeEdge } = await import('./grass-cells.js');
  check('the edge is 0 before the fade starts', fadeEdge(10, 40, 50) === 0);
  check('and 1 past its end', fadeEdge(60, 40, 50) === 1);
  check('linear in between', Math.abs(fadeEdge(45, 40, 50) - 0.5) < 1e-9);
  check('a curve above 1 holds density then drops it late', fadeEdge(45, 40, 50, 3) < 0.2 && fadeEdge(49, 40, 50, 3) > 0.7 && fadeEdge(50, 40, 50, 3) === 1);
  check('a zero-width band is a step, not a division by zero', fadeEdge(50.01, 50, 50) === 1 && fadeEdge(49.99, 50, 50) === 0 && Number.isFinite(fadeEdge(50, 50, 50)));
  const src = readFileSync('grass-compute.js', 'utf8');
  check('both cull kernels take the edge from the shared curve', (src.match(/const edge = fadeEdgeFn\(dist\)/g) || []).length === 2);
  check('the kernel curve is the same law', /pow\(clamp\(dist\.sub\(uCullStart\)\.div\(band\), 0, 1\), uFadeCurve\)/.test(src));
  check('the material tapers height and width over the keep edge', /fadeScaleH = float\(1\)\.sub\(uFadeHeight\.mul\(edgeM\)\)\.mul\(nearS\)/.test(src)
    && /fadeScaleW = float\(1\)\.sub\(uFadeWidth\.mul\(edgeM\)\)\.mul\(nearS\)/.test(src));
  check('and the tint has its own ramp', /tintT\.mul\(uGroundTintFar\)/.test(src));

  const { grass, recull } = rig({ radius: 50, maxRadius: 60 });
  await recull();
  check('the fade ends at the radius by default', grass.fade.end === 50 && grass.fade.start === 40);
  check('and the tint band follows the keep band', grass.fade.tintStart === 40 && grass.fade.tintEnd === 50);
  grass.setRadius(60);
  check('a wider radius carries the fade end with it', grass.fade.end === 60 && grass.fade.tintEnd === 60);
  await recull();
  grass.setFadeEnd(55);
  check('a set fade end is honoured', grass.fade.end === 55 && grass.stats.dirty === true, JSON.stringify(grass.fade));
  await recull();
  grass.setFadeEnd(500);
  check('and clamped to the radius', grass.fade.end === 60);
  grass.setFadeEnd(10);
  check('and never before the fade start', grass.fade.end === grass.fade.start);
  grass.setFadeEnd(null);
  check('null follows the radius again', grass.fade.end === 60);
  await recull();
  grass.setFadeHeight(0.5); grass.setFadeWidth(0.25);
  check('the tapers are material-side and do not recull', grass.fade.height === 0.5 && grass.fade.width === 0.25 && grass.stats.dirty === false);
  grass.setTintFade(10, 30);
  check('the tint ramp can be set apart from the keep ramp', grass.fade.tintStart === 10 && grass.fade.tintEnd === 30 && grass.stats.dirty === false);
  grass.setTintFade(null, null);
  check('and follows again on null', grass.fade.tintStart === grass.fade.start && grass.fade.tintEnd === grass.fade.end);
  grass.setNearFade(1, 3);
  check('the near fade takes a start and an end', grass.fade.nearStart === 1 && grass.fade.nearEnd === 3);
  grass.setFadeCurve(2);
  check('a curve change reculls, since the cull reads it', grass.fade.curve === 2 && grass.stats.dirty === true);
}

section('cells are numbered in rings from the camera outward');
{
  const { ringCell, ringOfCell, cellsWithinRing, tierLayout, thinTiers } = await import('./grass-cells.js');
  const half = 7, side = 2 * half + 1;
  const seen = new Map();
  let ordered = true, lastRing = 0;
  for (let i = 0; i < side * side; i++) {
    const c = ringCell(i);
    if (c.ring < lastRing) ordered = false;
    lastRing = c.ring;
    if (Math.max(Math.abs(c.x), Math.abs(c.z)) !== c.ring) ordered = false;
    seen.set(`${c.x},${c.z}`, (seen.get(`${c.x},${c.z}`) ?? 0) + 1);
  }
  check('every cell of the window is visited exactly once', seen.size === side * side && [...seen.values()].every(n => n === 1), `${seen.size} cells`);
  check('in non-decreasing ring order, each at its Chebyshev distance', ordered);
  check('the ring of a cell is exact at the square boundaries', ringOfCell(0) === 0 && ringOfCell(1) === 1 && ringOfCell(8) === 1 && ringOfCell(9) === 2 && ringOfCell(24) === 2 && ringOfCell(25) === 3);
  check('cellsWithinRing is the odd square', cellsWithinRing(0) === 1 && cellsWithinRing(3) === 49);
  const src = readFileSync('grass-compute.js', 'utf8');
  check('the kernel inverts the same ring numbering', /const lo = k\.mul\(int\(2\)\)\.sub\(int\(1\)\)/.test(src) && /sideIdx = j\.div\(L\)/.test(src));

  const lay = tierLayout(3, [{ ring: 1, perCell: 4 }, { ring: 2, perCell: 2 }, { ring: 99, perCell: 1 }]);
  check('a tier layout is cumulative cells and threads', lay.cells.join() === '9,25,49' && lay.threads.join() === '36,68,92');
  const thin = thinTiers(3, [{ ring: 1, perCell: 4 }, { ring: 2, perCell: 2 }, { ring: 99, perCell: 1 }], 70);
  check('thinning takes from the far tier first', thin[0].perCell === 4 && thin[1].perCell === 2 && thin[2].perCell === 0, JSON.stringify(thin));
  const thin2 = thinTiers(3, [{ ring: 1, perCell: 4 }, { ring: 2, perCell: 2 }, { ring: 99, perCell: 1 }], 40);
  check('then the middle, and the inner tier last', thin2[0].perCell === 4 && thin2[1].perCell === 0, JSON.stringify(thin2));
  check('one tier thins the way it always did', thinTiers(3, [{ ring: 99, perCell: 4 }], 100)[0].perCell === Math.floor(100 / 49));
}

section('distance tiers give the far grass its own density');
{
  const { grass, recull } = rig({ radius: 40, maxRadius: 40, density: 12, dispatchBudget: 1e9 });
  await recull();
  const oneTier = grass.stats.dispatch;
  grass.setTiers([{ radius: 10, density: 1 }, { radius: 20, density: 0.5 }, { radius: Infinity, density: 0.25 }]);
  check('tiers mark the cull dirty', grass.stats.dirty === true);
  await recull();
  check('and the dispatch shrinks with the far tiers thinned', grass.stats.dispatch < oneTier, `${grass.stats.dispatch} vs ${oneTier}`);
  check('the inner tier keeps the slider density', grass.stats.density === 12 && grass.stats.tiers[0].density === 12);
  check('the middle and far tiers are fractions of it', grass.stats.tiers[1].density === 6 && grass.stats.tiers[2].density === 3, JSON.stringify(grass.stats.tiers));
  check('the last tier runs to the radius', grass.stats.tiers[2].radius === 40);
  grass.setTiers(null);
  await recull();
  check('null is one tier again', grass.stats.tiers.length === 1 && grass.stats.dispatch === oneTier);
  const { grass: tight, recull: recullTight } = rig({ radius: 40, maxRadius: 40, density: 12, dispatchBudget: 20000 });
  tight.setTiers([{ radius: 10, density: 1 }, { radius: Infinity, density: 1 }]);
  await recullTight();
  check('a tight budget thins the far tier and leaves the feet alone', tight.stats.tiers[0].density === 12 && tight.stats.tiers[1].density < 12 && tight.stats.dispatchClamped, JSON.stringify(tight.stats.tiers));
}

section('draw-cost controls: the cone, the shading, the shadows');
{
  const { grass, camera, recull } = rig();
  await recull();
  const reculls = grass.stats.reculls;
  await grass.update(2);
  check('the same cell and cone skip the recull', grass.stats.reculls === reculls);
  check('the cone is on by default', grass.frustumCull === true);
  grass.setFrustumCull(false);
  await grass.update(3);
  check('turning the cone off re-culls without a cell change', grass.stats.reculls === reculls + 1);
  grass.setNearKeep(12);
  check('the near keep is read in the cull, so it marks it dirty', grass.stats.dirty === true);
  check('the mesh starts on the standard material', grass.shading === 'standard' && grass.mesh.material.isMeshStandardNodeMaterial === true);
  grass.setShading('lambert');
  check('setShading swaps to Lambert', grass.shading === 'lambert' && grass.mesh.material.isMeshLambertNodeMaterial === true);
  grass.setShading('phong');
  check('and ignores an unknown key', grass.shading === 'lambert');
  check('both materials share the one graph', grass.mesh.material.positionNode !== null && grass.mesh.material.colorNode !== null);
  check('blades receive shadows by default', grass.mesh.receiveShadow === true);
  grass.setReceiveShadow(false);
  check('and can stop', grass.mesh.receiveShadow === false);
  void camera;
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
