// test-base-game-forest.mjs — tree plan T2: the renderer, render-local and rebased.
//
// forest-gpu.js constructs headless: its buffers are plain typed arrays, its kernels are node
// graphs, and the only thing it asks a renderer for is computeAsync. So everything the plan calls
// a T2 risk — the origin subtraction, the capacity budget, the per-rung toggles, the height source
// — is checkable in Node against the REAL modules rather than a mirror of them.
//
// node test-base-game-forest.mjs

import * as THREE from 'three';
import { createBaseGameForest, BASE_GAME_FOREST_DEFAULTS, rungTriangles, proceduralBarkColorNode, bindTreeMaterials, BASE_GAME_FOREST_SHADOW_LAYER } from './base-game-forest.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

// A small palette: the point of these tests is the plumbing, and every extra variant is another
// run of the tree generator.
const SMALL = { treeSpecies: 2, treeVariantsPerSpecies: 2, treesEnabled: true };

function rig(settings = {}) {
  const scene = new THREE.Scene();
  const worldCoordinates = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene,
    worldQuery: createWorldQueryService(),
    worldCoordinates,
    source: analyticDescriptor({ key: 'forest-test', seaLevel: 0 }),
    useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  let computes = 0;
  const renderer = { computeAsync: async () => { computes++; } };
  const forest = createBaseGameForest({
    renderer, scene, camera, terrain, worldCoordinates,
    settings: { ...SMALL, ...settings },
    yieldTask: async () => {},
  });
  return { scene, terrain, camera, forest, worldCoordinates, get computes() { return computes; } };
}

// Streams the terrain fields, then places and uploads until the queues stop draining. Placement is
// budgeted to a chunk a frame by design, so this is a real loop and not a formality.
async function settle(r, frames = 300) {
  const o = r.worldCoordinates.getOrigin();
  for (let i = 0; i < frames; i++) {
    const at = [r.camera.position.x + o[0], r.camera.position.y + o[1], r.camera.position.z + o[2]];
    r.terrain.update(at, 1 / 60);
    r.terrain.fieldScheduler.pump();
    await r.forest.update();
  }
}

// Everything the CPU uploaded, decoded back out of the source buffer.
function uploaded(forest) {
  const gpu = forest.forestGPU;
  const src = gpu.sourceArray, counts = gpu.sourceCounts, CAP = gpu.slotStride;
  const out = [];
  for (let g = 0; g < counts.length; g++) {
    for (let slot = 0; slot < counts[g]; slot++) {
      const b = (g * CAP + slot) * 8;
      out.push({ variant: g, x: src[b], y: src[b + 1], z: src[b + 2], scale: src[b + 3], yaw: src[b + 4] });
    }
  }
  return out;
}
const posKey = i => `${i.x.toFixed(3)},${i.y.toFixed(3)},${i.z.toFixed(3)},${i.scale.toFixed(5)},${i.yaw.toFixed(5)}`;

section('the forest builds and draws what placement found');
const base = rig();
{
  await base.forest.load();
  base.forest.setEnabled(true);
  await settle(base);
  const s = base.forest.stats;
  check('the palette baked', base.forest.built, `lastError ${s.lastError}`);
  check('there are trees standing', s.trees > 0, `${s.trees} trees`);
  check('every standing tree reached the instance buffer', s.instances === s.trees,
    `${s.instances} uploaded, ${s.trees} placed`);
  check('nothing was dropped at the default capacity', s.dropped === 0 && !s.truncating,
    `${s.dropped} dropped of capacity ${s.capacity}`);
  check('Base Game constructs three rungs, no unreachable billboard objects, and a shadow-only pair per variant',
    base.forest.forestGPU.summary.lodCount === 3
      && base.forest.forestGPU.summary.hasBillboards === false
      && base.forest.meshes.length === s.variants * 9,
    `${base.forest.meshes.length} meshes, lodCount ${base.forest.forestGPU.summary.lodCount}`);
  // No billboards in v1 (D6): rung 3 is off, so a populated variant submits seven meshes.
  check('a populated variant submits seven draws, not eight', s.draws === s.visibleVariants * 7,
    `${s.draws} draws over ${s.visibleVariants} variants`);
  check('the counter separates default shadow-pass mesh submissions: bark and leaf cards, one each',
    s.shadowDraws === s.visibleVariants * 2,
    `${s.draws} main + ${s.shadowDraws} shadow over ${s.visibleVariants} variants`);
  // The per-frame path must NOT walk the instances: forestGPU.stats runs computeCullEstimate over
  // every live one, which measured 0.2 ms a frame at a draw radius the sliders reach.
  const scansAfterSettle = s.cullEstimates;
  await settle(base, 20);
  check('twenty more frames run the instance scan zero times', s.cullEstimates === scansAfterSettle,
    `${scansAfterSettle} -> ${s.cullEstimates} scans over 20 frames`);
  check('and the per-rung numbers are still unfilled, because nothing asked for them',
    s.lod0 === 0 && s.lod1 === 0 && s.lod2 === 0 && s.triangles === 0,
    `${s.lod0}/${s.lod1}/${s.lod2}, ${s.triangles} triangles`);
  base.forest.sampleDetail();
  check('sampleDetail is what runs it, once', s.cullEstimates === scansAfterSettle + 1,
    `${s.cullEstimates} scans`);
  check('and sampleDetail fills them, with triangles derived from the palette',
    s.triangles > 0 && s.lod0 + s.lod1 + s.lod2 > 0 && base.forest.rungTriangles[0] > base.forest.rungTriangles[2],
    `rung triangles ${base.forest.rungTriangles.map(t => t.toFixed(0)).join('/')}`);
}

section('trunks sit on the surface the player collides with');
{
  const gpu = base.forest.forestGPU;
  const recs = [...base.forest.trees.records.values()].flat();
  const offset = base.forest.config.treeVerticalOffset;
  let worst = 0;
  for (const inst of uploaded(base.forest)) {
    // Origin is still zero here, so uploaded XZ is global XZ and the record is findable by it.
    const match = recs.find(r => Math.abs(r.x - inst.x) < 1e-4 && Math.abs(r.z - inst.z) < 1e-4);
    if (!match) continue;
    worst = Math.max(worst, Math.abs(inst.y - (base.terrain.groundHeight(match.x, match.z) + offset)));
  }
  check('every uploaded Y is groundHeight plus the vertical bias', worst < 1e-4, `worst ${worst}`);
  check('the bias is negative, so a trunk sinks rather than floats', offset < 0, `${offset}`);
  check('and the buffer holds render-local coordinates equal to global at origin zero',
    gpu.worldOrigin.join(',') === '0,0,0');
}

section('a rebase moves where trees draw, never which trees there are');
{
  const before = new Map();
  for (const [key, recs] of base.forest.trees.records) before.set(key, recs.map(r => `${r.x},${r.z},${r.speciesIdx},${r.slot},${r.scale},${r.yaw}`).join('|'));
  const uploadedBefore = uploaded(base.forest).map(posKey).sort();

  // The player has not moved in the world; only the frame the world is drawn in has.
  const shift = [1024, 0, 1024];
  base.worldCoordinates.setRenderOrigin(shift);
  base.camera.position.set(base.camera.position.x - shift[0], base.camera.position.y, base.camera.position.z - shift[2]);
  await settle(base, 4);

  let changed = 0;
  for (const [key, recs] of base.forest.trees.records) {
    const sig = recs.map(r => `${r.x},${r.z},${r.speciesIdx},${r.slot},${r.scale},${r.yaw}`).join('|');
    if (before.has(key) && before.get(key) !== sig) changed++;
  }
  check('not one record changed', changed === 0, `${changed} chunks differ`);

  const after = uploaded(base.forest);
  const shifted = after.map(i => posKey({ ...i, x: i.x + shift[0], z: i.z + shift[2] })).sort();
  const kept = uploadedBefore.filter(k => shifted.includes(k)).length;
  check('every instance still in the window uploaded at global minus the new origin',
    kept > 0 && kept === uploadedBefore.filter(k => shifted.includes(k)).length,
    `${kept} of ${uploadedBefore.length} matched`);
  check('the renderer knows the origin it uploaded against',
    base.forest.forestGPU.worldOrigin.join(',') === '1024,0,1024');
  base.terrain.dispose();
}

section('capacity is a budget that reports, not a cliff that hides');
{
  const tight = rig({ treeCapPerVariant: 16, treesPerHectare: 400 });
  await tight.forest.load();
  tight.forest.setEnabled(true);
  await settle(tight);
  const s = tight.forest.stats;
  check('a tight cap drops instances and says so', s.dropped > 0 && s.truncating,
    `${s.dropped} dropped, capacity ${s.capacity}`);
  check('the capacity reported is variants times the per-variant cap',
    s.capacity === s.variants * 16, `${s.capacity} for ${s.variants} variants`);
  // The donor warned once ever, so a second overflow looked clean. The STAT has to hold.
  const first = s.dropped;
  tight.forest.forestGPU.setWorldOrigin(1, 0, 1);
  await settle(tight, 2);
  check('and it still says so on the next rebuild, not only the first',
    tight.forest.stats.dropped > 0, `first ${first}, second ${tight.forest.stats.dropped}`);
  tight.terrain.dispose();
}

section('every LOD rung has its own distance and its own switch');
{
  const r = rig({ treeLodR0: 40, treeLodR1: 80, treeLodR2: 200, treeDrawRadius: 200 });
  await r.forest.load();
  r.forest.setEnabled(true);
  await settle(r);
  const all = r.forest.stats.draws;
  const variants = r.forest.stats.visibleVariants;
  check('there is something to switch off', variants > 0 && all === variants * 7, `${all} draws`);

  r.forest.apply({ treeLod0: false });
  await settle(r, 2);
  r.forest.sampleDetail();
  check('hiding rung 0 removes exactly its three meshes per variant',
    r.forest.stats.draws === variants * 4, `${r.forest.stats.draws} draws, expected ${variants * 4}`);
  check('and the cull still runs over every instance, so this measures raster cost only',
    r.forest.stats.instances > 0 && r.forest.forestGPU.stats.cullDispatchInstances === r.forest.stats.capacity);

  r.forest.apply({ treeLod0: true, treeLod1: false, treeLod2: false });
  await settle(r, 2);
  r.forest.sampleDetail();
  check('hiding rungs 1 and 2 removes exactly their four meshes per variant',
    r.forest.stats.draws === variants * 3, `${r.forest.stats.draws} draws, expected ${variants * 3}`);

  r.forest.apply({ treeLod1: true, treeLod2: true });
  await settle(r, 2);
  r.forest.sampleDetail();
  check('and switching them back restores every draw', r.forest.stats.draws === all);

  // Collapsing a band is the other control: r0 == r1 empties LOD1 without hiding anything.
  r.forest.apply({ treeLodR1: 40 });
  await settle(r, 2);
  r.forest.sampleDetail();
  check('collapsing r1 onto r0 empties the LOD1 band', r.forest.stats.lod1 === 0,
    `${r.forest.stats.lod1} instances still at LOD1`);
  check('and those trees fell through to LOD2 rather than vanishing',
    r.forest.stats.lod0 + r.forest.stats.lod2 === r.forest.stats.instances - r.forest.stats.rejectedFar - r.forest.stats.rejectedCone,
    `${r.forest.stats.lod0}/${r.forest.stats.lod1}/${r.forest.stats.lod2} of ${r.forest.stats.instances}`);
  r.terrain.dispose();
}

section('the clamps are real clamps, not echoed settings');
{
  // Deliberately backwards rings and a draw radius past the last rung that has geometry.
  const r = rig({ treeLodR0: 120, treeLodR1: 40, treeLodR2: 80, treeDrawRadius: 900 });
  await r.forest.load();
  r.forest.setEnabled(true);
  await settle(r, 3);
  const g = r.forest.forestGPU.stats;
  check('a lower r1 than r0 is raised to r0, not left to empty the band silently',
    g.lodR0 === 120 && g.lodR1 === 120, `r0 ${g.lodR0}, r1 ${g.lodR1}`);
  check('r2 follows r1 the same way', g.lodR2 === 120, `r2 ${g.lodR2}`);
  check('the draw radius is clamped to the last rung with geometry (D6)',
    g.maxDrawRadius === g.lodR2, `${g.maxDrawRadius} vs lodR2 ${g.lodR2}`);
  check('and the slider itself is untouched, so the panel can say it is clamping',
    r.forest.config.treeDrawRadius === 900);
  r.terrain.dispose();
}
{
  // The placement window is derived from the draw radius at CONSTRUCTION too, not only in apply().
  // Missed once: a forest built and never re-applied placed 121 chunks to draw 49 of them.
  const r = rig({ treeDrawRadius: 120, treeChunkSize: 96 });
  r.forest.setEnabled(true);
  check('the chunk window follows the draw radius from the first frame',
    r.forest.trees.stats.radiusChunks === 2, `${r.forest.trees.stats.radiusChunks} chunks of radius`);
  r.terrain.dispose();
}

section('the palette agrees with the placement');
{
  const r = rig({ treeSpecies: 3, treeVariantsPerSpecies: 2 });
  await r.forest.load();
  r.forest.setEnabled(true);
  await settle(r);
  const recs = [...r.forest.trees.records.values()].flat();
  const maxSpecies = recs.reduce((m, rec) => Math.max(m, rec.speciesIdx), -1);
  check('no record names a species the palette did not bake', maxSpecies < 3 && maxSpecies >= 0,
    `max speciesIdx ${maxSpecies}`);
  check('the variant count is species times variants-per-species',
    r.forest.stats.variants === 6, `${r.forest.stats.variants}`);
  check('family-interleaved baking preserves species-major GPU slot identity',
    r.forest.palette.variants.every((v, g) => v.speciesIdx === Math.floor(g / 2) && v.variant === g % 2));
  // Rebaking must not leak the old geometry: the palette is the one thing env-viewer never frees.
  const oldMeshes = r.forest.meshes.slice();
  const oldPaletteGeos = r.forest.palette.variants.flatMap(v => [
    v.branches, v.branchesLod1, v.branchesLod2, v.leaves, v.shadow, v.leavesCoarse,
  ]).filter(Boolean);
  let paletteDisposals = 0;
  for (const geo of oldPaletteGeos) geo.addEventListener('dispose', () => { paletteDisposals++; });
  r.forest.apply({ treeLeafCount: 4 });
  await settle(r, 30);
  check('a palette change rebuilds rather than mutating the live one',
    r.forest.meshes.length > 0 && r.forest.meshes[0] !== oldMeshes[0]);
  check('every old mesh left the scene', oldMeshes.every(m => !r.scene.children.includes(m)));
  check('and every baked palette geometry was disposed, which env-viewer never does',
    paletteDisposals === oldPaletteGeos.length, `${paletteDisposals} of ${oldPaletteGeos.length}`);
  r.terrain.dispose();
}

section('explicit species ids control which authored trees are present');
{
  const r = rig({
    treeSpeciesSelection: 'ez-oak_small,ez-pine_small',
    treeVariantsPerSpecies: 1,
    treeLeafCount: 3,
  });
  await r.forest.load();
  r.forest.setEnabled(true);
  await settle(r, 80);
  let table = r.forest.trees.placementParams.speciesTable;
  check('placement receives exactly the selected stable species ids',
    table.map(species => species._tag.id).join(',') === 'ez-oak_small,ez-pine_small');
  check('the palette bakes one slot for each selected species', r.forest.stats.variants === 2,
    `${r.forest.stats.variants} variants`);
  check('every record refers only to those selected palette slots',
    [...r.forest.trees.records.values()].flat().every(record => record.speciesIdx === 0 || record.speciesIdx === 1));

  r.forest.apply({ treeSpeciesSelection: 'ez-pine_small' });
  await settle(r, 80);
  table = r.forest.trees.placementParams.speciesTable;
  check('changing the selection rebuilds placement and palette around the remaining species',
    table.length === 1 && table[0]._tag.id === 'ez-pine_small' && r.forest.stats.variants === 1);
  check('the rebuilt records use the remaining species slot',
    [...r.forest.trees.records.values()].flat().every(record => record.speciesIdx === 0));
  r.terrain.dispose();
}

section('the defaults are the ones the plan argued for');
{
  check('billboards are off in v1, so the forest ends at lodR2 (D6)',
    BASE_GAME_FOREST_DEFAULTS.treeDrawRadius === BASE_GAME_FOREST_DEFAULTS.treeLodR2,
    `${BASE_GAME_FOREST_DEFAULTS.treeDrawRadius} vs ${BASE_GAME_FOREST_DEFAULTS.treeLodR2}`);
  check('the LOD rings are ordered', BASE_GAME_FOREST_DEFAULTS.treeLodR0 < BASE_GAME_FOREST_DEFAULTS.treeLodR1
    && BASE_GAME_FOREST_DEFAULTS.treeLodR1 < BASE_GAME_FOREST_DEFAULTS.treeLodR2);
  check('every rung starts on, so a capture starts from the whole cost',
    BASE_GAME_FOREST_DEFAULTS.treeLod0 && BASE_GAME_FOREST_DEFAULTS.treeLod1 && BASE_GAME_FOREST_DEFAULTS.treeLod2);
  check('two variants per species is the provisional performance default',
    BASE_GAME_FOREST_DEFAULTS.treeVariantsPerSpecies === 2,
    `${BASE_GAME_FOREST_DEFAULTS.treeVariantsPerSpecies} variants`);
  check('rungTriangles falls with the rung', (() => {
    const fake = { variants: [{ branches: { index: { count: 300 } }, leaves: { index: { count: 600 } }, shadow: { index: { count: 150 } }, leavesCoarse: { index: { count: 60 } } }] };
    const t = rungTriangles(fake);
    return t[0] === 350 && t[1] === 300 && t[2] === 120 && t[3] === 2;
  })());
}

section('a rebuild frees the GPU storage, not only the meshes');
{
  // Storage attributes have no dispose event and ComputeNode.dispose() does not free their buffers,
  // so a palette rebuild used to leak the source, draw, count, atomic and per-mesh indirect
  // buffers every time. renderer._attributes.delete is the path that actually frees them.
  const deleted = new Set();
  const scene = new THREE.Scene();
  const wc = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: wc,
    source: analyticDescriptor({ key: 'forest-dispose', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  const renderer = { computeAsync: async () => {}, _attributes: { delete: a => deleted.add(a) } };
  const forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates: wc,
    settings: { ...SMALL }, yieldTask: async () => {} });
  await forest.load();
  forest.setEnabled(true);
  const r = { terrain, camera, forest, worldCoordinates: wc, scene };
  await settle(r, 30);
  const variants = forest.stats.variants;
  forest.apply({ treeLeafCount: 5 });     // a palette key: rebuild on the next update
  await settle(r, 30);
  // source + draw + counts + survivor atomics, then seven Base Game indirect buffers per variant.
  // Four shared buffers, then per variant seven rung indirects plus the shadow pair's two.
  check('every storage buffer the old forest owned was freed', deleted.size === 4 + variants * 9,
    `${deleted.size} freed, expected ${4 + variants * 9} for ${variants} variants`);
  check('and the forest came back', forest.built && forest.stats.instances > 0,
    `${forest.stats.instances} instances`);
  forest.dispose();
  check('teardown frees the new one too', deleted.size === (4 + variants * 9) * 2,
    `${deleted.size} freed in total`);
  terrain.dispose();
}

section('shaders compile before the forest reaches the scene');
{
  // Every reachable material is warmed before its mesh draws. Base Game no longer constructs the
  // permanently-disabled billboard material/rung.
  const compiled = [];
  let forest = null, warmComputeCalls = 0;
  const expectedWarmComputeCalls = 2 + SMALL.treeSpecies * SMALL.treeVariantsPerSpecies * 2;
  const scene = new THREE.Scene();
  const wc = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: wc,
    source: analyticDescriptor({ key: 'forest-compile', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  const renderer = {
    computeAsync: async nodes => {
      if (!Array.isArray(nodes)) warmComputeCalls++;
    },
    compileAsync: async (warm, cam, target) => {
      const meshes = [];
      warm.traverse(o => { if (o.isMesh) meshes.push(o); });
      compiled.push({
        count: meshes.length,
        allVisible: meshes.every(m => m.visible),
        inSceneAlready: meshes.some(m => scene.children.includes(m)),
        publishedBefore: forest?.meshes.length ?? 0,
        gotTargetScene: target === scene,
        gotCamera: cam === camera,
      });
    },
  };
  forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates: wc,
    settings: { ...SMALL }, yieldTask: async () => {} });
  await forest.load();
  forest.setEnabled(true);
  await settle({ terrain, camera, forest, worldCoordinates: wc, scene }, 40);
  check('compileAsync ran once per cross-family variant wave',
    compiled.length === SMALL.treeVariantsPerSpecies, `${compiled.length} waves`);
  check('each wave contains one complete variant from every family',
    compiled.every(c => c.count === SMALL.treeSpecies * 9), compiled.map(c => c.count).join('/'));
  check('the first family wave was published before the second compiled',
    compiled[0]?.publishedBefore === 0 && compiled[1]?.publishedBefore === SMALL.treeSpecies * 9,
    compiled.map(c => c.publishedBefore).join('/'));
  check('all wave meshes compile visible, or a hidden rung stalls later', compiled.every(c => c.allVisible));
  check('no wave compiles after its own meshes enter the scene', compiled.every(c => !c.inSceneAlready));
  check('the real scene and camera reach every wave', compiled.every(c => c.gotTargetScene && c.gotCamera));
  check('every compute pipeline warmed before the forest entered the scene',
    warmComputeCalls === expectedWarmComputeCalls,
    `${warmComputeCalls} warmed, expected ${expectedWarmComputeCalls}`);
  check('the forest built and the mask is back in force', forest.built
    && forest.stats.readyVariants === forest.stats.variants
    && forest.meshes.filter(m => m.visible).length === forest.stats.draws + forest.stats.shadowDraws,
    `${forest.meshes.filter(m => m.visible).length} visible, ${forest.stats.draws} draws + ${forest.stats.shadowDraws} shadow`);
  terrain.dispose();
}

section('compile failures stay out of the scene and surface the real error');
{
  const scene = new THREE.Scene();
  const wc = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: wc,
    source: analyticDescriptor({ key: 'forest-compile-failure', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  let compiles = 0;
  const renderer = {
    computeAsync: async () => {},
    compileAsync: async () => { compiles++; throw new Error('intentional shader failure'); },
  };
  const forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates: wc,
    settings: { ...SMALL }, yieldTask: async () => {} });
  await forest.load();
  forest.setEnabled(true);
  const r = { terrain, camera, forest, worldCoordinates: wc, scene };
  await settle(r, 30);
  await settle(r, 10); // a failed build must not retry every frame
  check('the compile error is reported', forest.stats.lastError?.includes('intentional shader failure'), forest.stats.lastError);
  check('a failed forest never enters the scene', !forest.built && forest.meshes.length === 0);
  check('the failed build does not retry until settings or enable state changes', compiles === 1, `${compiles} compiles`);
  terrain.dispose();
}

section('disabling during a family wave cancels disposed work safely');
{
  const scene = new THREE.Scene();
  const wc = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: wc,
    source: analyticDescriptor({ key: 'forest-progress-cancel', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  let releaseCompile = null;
  const renderer = {
    computeAsync: async () => {},
    compileAsync: async () => new Promise(resolve => { releaseCompile = resolve; }),
  };
  const forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates: wc,
    settings: { ...SMALL }, yieldTask: async () => {} });
  await forest.load();
  forest.setEnabled(true);
  await forest.update();
  for (let i = 0; i < 30 && !releaseCompile; i++) await Promise.resolve();
  check('the first all-family wave reached asynchronous compilation', !!releaseCompile);
  forest.setEnabled(false);
  releaseCompile?.();
  for (let i = 0; i < 30 && forest.building; i++) await Promise.resolve();
  check('cancellation leaves no progressive meshes or GPU shell behind',
    !forest.built && forest.meshes.length === 0 && forest.forestGPU === null);
  check('resuming the stale compile does not surface a disposed-GPU error', !forest.stats.lastError,
    forest.stats.lastError);
  terrain.dispose();
}

section('shadows come from a shadow-only pair per variant, culled by reach and not by the view cone');
{
  // Before 2026-08-30 the main meshes cast, so a tree beside or behind the camera -- outside the
  // view cone the cull keeps -- cast nothing, and its shadow appeared when you turned toward it.
  // Now every tree within the shadow camera's reach is in a separate list drawn by two meshes the
  // main camera cannot see.
  const r = rig({ treeLodR0: 60, treeLodR1: 140, treeLodR2: 260, treeShadowReach: 90 });
  await r.forest.load();
  r.forest.setEnabled(true);
  await settle(r, 40);
  const gpu = r.forest.forestGPU;
  const V = r.forest.stats.variants;
  const casters = r.forest.meshes.filter(m => m.castShadow);
  check('each variant casts from exactly two meshes: one bark, one leaf-card set', casters.length === V * 2,
    `${casters.length} casting meshes over ${V} variants`);
  check('the casters are named as the shadow pair', casters.every(m => /:(bark|leaf)Shadow$/.test(m.name)));
  // The bark caster draws the L2 trunk, not the full branches: a ~9cm shadow texel cannot show the difference.
  const l2Counts = r.forest.palette.variants.map(v => (v.branchesLod2 ?? v.branches).attributes.position.count);
  check('the bark caster geometry is the L2 trunk mesh',
    casters.filter(m => /:barkShadow$/.test(m.name)).every((m, i) => m.geometry.attributes.position.count === l2Counts[i]),
    `caster ${casters.find(m => /:barkShadow$/.test(m.name))?.geometry.attributes.position.count} vs L2 ${l2Counts[0]}`);
  const layer = BASE_GAME_FOREST_SHADOW_LAYER;
  check(`the casters live on layer ${layer} only, so the main camera never draws them`,
    casters.every(m => m.layers.mask === (1 << layer)));
  check('the main meshes are on layer 0 and never cast',
    r.forest.meshes.filter(m => !m.castShadow).every(m => m.layers.mask === 1 && m.name.indexOf('Shadow') < 0));
  check('the shadow list reach is the shadow camera half-extent', gpu.summary.shadowList === true && gpu.shadowReach === 90,
    `reach ${gpu.shadowReach}`);
  check('two shadow submissions per populated variant', gpu.summary.shadowDraws === r.forest.stats.visibleVariants * 2,
    `${gpu.summary.shadowDraws} shadow submissions`);
  // Turning both parts off empties the list rather than leaving hidden meshes with a live count.
  r.forest.apply({ treeBarkShadows: false, treeLeafShadows: false });
  check('with both parts off the list radius is 0 and nothing is submitted',
    gpu.shadowReach === 0 && gpu.summary.shadowDraws === 0, `reach ${gpu.shadowReach}, ${gpu.summary.shadowDraws} submissions`);
  r.forest.apply({ treeBarkShadows: true, treeLeafShadows: false });
  check('bark alone submits one per variant and restores the reach',
    gpu.shadowReach === 90 && gpu.summary.shadowDraws === r.forest.stats.visibleVariants, `${gpu.summary.shadowDraws} submissions`);
  r.forest.apply({ treeShadowReach: 400 });
  check('the reach follows the light, not a constant', gpu.shadowReach === 400);
  r.terrain.dispose();
}

section('trunk height, trunk width and leaf size each move their own thing');
{
  // Wired-but-inert is the failure mode worth testing: all three run through the same palette
  // rebake, so a slider that reaches cfg and stops would still look connected.
  const box = geo => { geo.computeBoundingBox(); const b = geo.boundingBox; return { y: b.max.y - b.min.y, x: b.max.x - b.min.x, z: b.max.z - b.min.z }; };
  // Trunk thickness is not the mesh bounding box: branches set that, and they dwarf the trunk.
  // The largest XZ radius among vertices in the bottom 8% is the trunk where it meets the ground.
  const trunkRadius = geo => {
    const pos = geo.attributes.position.array;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < pos.length; i += 3) { minY = Math.min(minY, pos[i]); maxY = Math.max(maxY, pos[i]); }
    const cut = minY + (maxY - minY) * 0.08;
    let r = 0;
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] <= cut) r = Math.max(r, Math.hypot(pos[i], pos[i + 2]));
    return r;
  };
  async function bake(settings) {
    const r = rig(settings);
    await r.forest.load();
    r.forest.setEnabled(true);
    await settle(r, 40);
    const v = r.forest.palette.variants[0];
    const out = { branches: box(v.branches), leaves: box(v.leaves), trunk: trunkRadius(v.branches) };
    r.terrain.dispose();
    return out;
  }

  const base = await bake({});
  const tall = await bake({ treeTrunkHeight: 2 });
  const wide = await bake({ treeTrunkWidth: 3 });
  const leafy = await bake({ treeLeafSize: 3 });

  check('trunk height raises the tree', tall.branches.y > base.branches.y * 1.2,
    `${base.branches.y.toFixed(2)} -> ${tall.branches.y.toFixed(2)}`);
  check('and the canopy rides up with it', tall.leaves.y > base.leaves.y,
    `${base.leaves.y.toFixed(2)} -> ${tall.leaves.y.toFixed(2)}`);

  check('trunk width thickens the trunk, by the multiplier asked for',
    Math.abs(wide.trunk / base.trunk - 3) < 0.05,
    `${base.trunk.toFixed(3)} -> ${wide.trunk.toFixed(3)} (x${(wide.trunk / base.trunk).toFixed(2)}, wanted x3)`);
  // Not asserted as invariant: trees.js divides gnarliness and the growth force by radius, so a
  // thicker trunk genuinely wanders and bends less. That is the generator, and it is about 1%.
  check('and does not become a height slider by the back door',
    Math.abs(wide.branches.y - base.branches.y) / base.branches.y < 0.05,
    `${base.branches.y.toFixed(2)} vs ${wide.branches.y.toFixed(2)}`);

  check('leaf size grows the canopy', leafy.leaves.x > base.leaves.x * 1.2,
    `${base.leaves.x.toFixed(2)} -> ${leafy.leaves.x.toFixed(2)}`);
  check('and leaves it a leaf slider, not a tree slider',
    Math.abs(leafy.branches.y - base.branches.y) < 0.01,
    `branches ${base.branches.y.toFixed(3)} vs ${leafy.branches.y.toFixed(3)}`);

  check('the three are independent - height leaves the trunk radius alone',
    Math.abs(tall.trunk - base.trunk) < 1e-6,
    `${base.trunk.toFixed(3)} vs ${tall.trunk.toFixed(3)}`);
  check('and leaf size leaves it alone too', Math.abs(leafy.trunk - base.trunk) < 1e-6,
    `${base.trunk.toFixed(3)} vs ${leafy.trunk.toFixed(3)}`);
}

section('authored tree textures, wired the way environment-viewer wires them');
{
  // The ez-tree presets carry white bark and leaf colours that multiply photo maps. A forest that
  // bakes those presets but never binds the maps draws white trees, which is what Base Game did.
  check('the default is authored, as the other pages default', BASE_GAME_FOREST_DEFAULTS.treeTexMode === 'authored');

  const fakeSet = (mode, { onReady } = {}) => {
    const set = {
      mode, ready: mode === 'procedural',
      leafMap: mode === 'authored' ? { name: 'leafAtlas' } : null, leafAtlas: { cols: 2, rows: 2 }, leafAlphaTest: 0.5,
      barkMap: mode === 'authored' ? { name: 'bark' } : null, barkNormalMap: mode === 'authored' ? { name: 'barkN' } : null,
      barkVScale: 0.35, disposed: 0,
      dispose() { set.disposed++; },
      land() { set.ready = true; onReady?.(set); },
    };
    made.push(set);
    return set;
  };
  const made = [];
  const scene = new THREE.Scene();
  const wc = createWorldCoordinateSpace();
  const terrain = createBaseGameTerrain({
    scene, worldQuery: createWorldQueryService(), worldCoordinates: wc,
    source: analyticDescriptor({ key: 'forest-textures', seaLevel: 0 }), useWorker: false,
  });
  terrain.setActive(true);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 0);
  const renderer = { computeAsync: async () => {} };
  const forest = createBaseGameForest({ renderer, scene, camera, terrain, worldCoordinates: wc,
    settings: { ...SMALL }, yieldTask: async () => {}, createTextureSource: fakeSet });
  await forest.load();
  forest.setEnabled(true);
  const r = { terrain, camera, forest, worldCoordinates: wc, scene };
  await settle(r, 30);

  const mats = () => { const out = []; forest.forestGPU.applyTextureSet((b, l) => out.push({ b, l })); return out; };
  check('one authored set was created for the build', made.length === 1 && made[0].mode === 'authored', `${made.length} sets`);
  check('the texture set reached the palette bake', forest.stats.textureMode === 'authored' && !forest.stats.texturesReady);
  check('leaves baked as atlas cards, not silhouettes, before the maps decoded',
    forest.palette.variants.every(v => v.leaves.attributes.uv), 'no uv on a leaf geometry');
  check('until the maps decode, the materials carry the procedural binding',
    mats().every(m => m.b.colorNode && !m.b.map && !m.l.map && !m.l.transparent));

  made[0].land();
  const bound = mats();
  check('when the maps land the bark maps are bound and the grain node is dropped',
    bound.every(m => m.b.map === made[0].barkMap && m.b.normalMap === made[0].barkNormalMap && m.b.colorNode === null));
  check('and the leaves cut out against the atlas, never blended',
    bound.every(m => m.l.map === made[0].leafMap && m.l.transparent === false && m.l.alphaTest === 0.5));
  check('the readout says so', forest.stats.texturesReady === true);
  const variantsBefore = forest.stats.variants;

  forest.apply({ treeTexMode: 'procedural' });
  await settle(r, 30);
  check('changing the mode rebakes the palette and keeps the forest', forest.built && forest.stats.variants === variantsBefore);
  check('the procedural set replaced the authored one and the authored maps were released',
    made.length === 2 && made[1].mode === 'procedural' && made[0].disposed === 1, `${made.length} sets, disposed ${made[0].disposed}`);
  check('procedural binds the grain node and no maps', mats().every(m => m.b.colorNode && !m.b.map && !m.l.map));
  check('the readout follows', forest.stats.textureMode === 'procedural' && forest.stats.texturesReady);

  forest.dispose();
  check('dispose releases the live set', made[1].disposed === 1);
  terrain.dispose();

  // Without an injected source and without a document, authored has nowhere to paint its atlas.
  const scene2 = new THREE.Scene();
  const wc2 = createWorldCoordinateSpace();
  const terrain2 = createBaseGameTerrain({
    scene: scene2, worldQuery: createWorldQueryService(), worldCoordinates: wc2,
    source: analyticDescriptor({ key: 'forest-textures-headless', seaLevel: 0 }), useWorker: false,
  });
  terrain2.setActive(true);
  const forest2 = createBaseGameForest({ renderer, scene: scene2, camera, terrain: terrain2, worldCoordinates: wc2,
    settings: { ...SMALL }, yieldTask: async () => {} });
  await forest2.load();
  forest2.setEnabled(true);
  await settle({ terrain: terrain2, camera, forest: forest2, worldCoordinates: wc2, scene: scene2 }, 30);
  check('headless, authored falls back to procedural instead of throwing',
    forest2.built && forest2.stats.textureMode === 'procedural', forest2.stats.lastError ?? '');
  forest2.dispose();
  terrain2.dispose();

  // The binding itself, on bare materials.
  const b = { }, l = { };
  bindTreeMaterials(b, l, null);
  check('a missing set binds procedural', b.colorNode && b.map === null && l.alphaTest === 0 && b.needsUpdate && l.needsUpdate);
}

section('the bark graph compiles');
{
  // A graph that does not build is a black trunk and a shader error in the console. This is the
  // one part of the tree materials that is not a storage-buffer node, so it can be built in Node.
  const { buildMaterial } = await import('./tsl-build-check.mjs');
  const webgpu = await import('three/webgpu');
  const mat = new webgpu.MeshStandardNodeMaterial({ vertexColors: true });
  mat.colorNode = proceduralBarkColorNode();
  let ok = true, err = '';
  try { await buildMaterial(mat); } catch (e) { ok = false; err = String(e?.message ?? e); }
  check('the procedural bark colour node compiles', ok, err);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
