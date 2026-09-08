// test-forest-pulled-arena.mjs — the pulled-draw arena packing and its vertexIndex mapping.
// Pure JS; no THREE, no GPU. forest-gpu.js transcribes pulledVertexOffset into TSL.
import { pulledArenaSlots, packPulledArena, pulledVertexOffset, pulledInvocationCost, PULLED_VERTEX_STRIDE } from './forest-cull.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

// A fake role geometry: n vertices, a triangle list over them.
function geo(n, tris, seed = 1) {
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2), color = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    position[i * 3] = seed * 100 + i; position[i * 3 + 1] = i + 0.5; position[i * 3 + 2] = -i;
    normal[i * 3 + 1] = 1;
    uv[i * 2] = i / n; uv[i * 2 + 1] = 1 - i / n;
    color[i * 3] = seed / 10; color[i * 3 + 1] = 0.25; color[i * 3 + 2] = i / n;
  }
  const index = new Uint32Array(tris * 3);
  for (let t = 0; t < tris * 3; t++) index[t] = (t * 7 + seed) % n;
  return { attributes: { position: { array: position, count: n }, normal: { array: normal, count: n }, uv: { array: uv, count: n }, color: { array: color, count: n } }, index: { array: index, count: tris * 3 } };
}

console.log('slots');
{
  const gs = [geo(10, 4, 1), geo(25, 9, 2), geo(7, 2, 3)];
  const slots = pulledArenaSlots(gs);
  check('vertexSlot is the largest variant', slots.vertexSlot === 25, JSON.stringify(slots));
  check('indexSlot is the largest variant', slots.indexSlot === 27, JSON.stringify(slots));
  check('empty list gives zero slots', JSON.stringify(pulledArenaSlots([])) === '{"vertexSlot":0,"indexSlot":0}');
  const withHole = pulledArenaSlots([geo(4, 1, 1), null]);
  check('a null variant contributes nothing', withHole.vertexSlot === 4 && withHole.indexSlot === 3);
}

console.log('packing');
{
  const gs = [geo(10, 4, 1), geo(25, 9, 2), geo(7, 2, 3)];
  const slots = pulledArenaSlots(gs);
  const arena = packPulledArena(gs, slots);
  check('arena is the uniform-slot size',
    arena.vertexData.length === 3 * 25 * PULLED_VERTEX_STRIDE && arena.indexData.length === 3 * 27,
    `${arena.vertexData.length}/${arena.indexData.length}`);
  check('counts record each variant', [...arena.counts].join(',') === '10,12,25,27,7,6', [...arena.counts].join(','));

  // Every source vertex must be byte-recoverable from the arena at its slot.
  let mismatch = 0;
  for (let v = 0; v < gs.length; v++) {
    const g = gs[v], n = g.attributes.position.count;
    for (let i = 0; i < n; i++) {
      const o = (v * slots.vertexSlot + i) * PULLED_VERTEX_STRIDE;
      const p = g.attributes.position.array, nr = g.attributes.normal.array;
      const uv = g.attributes.uv.array, c = g.attributes.color.array;
      if (arena.vertexData[o] !== p[i * 3] || arena.vertexData[o + 1] !== p[i * 3 + 1] || arena.vertexData[o + 2] !== p[i * 3 + 2]) mismatch++;
      if (arena.vertexData[o + 3] !== uv[i * 2] || arena.vertexData[o + 7] !== uv[i * 2 + 1]) mismatch++;
      if (arena.vertexData[o + 4] !== nr[i * 3] || arena.vertexData[o + 5] !== nr[i * 3 + 1] || arena.vertexData[o + 6] !== nr[i * 3 + 2]) mismatch++;
      if (arena.vertexData[o + 8] !== c[i * 3] || arena.vertexData[o + 9] !== c[i * 3 + 1] || arena.vertexData[o + 10] !== c[i * 3 + 2]) mismatch++;
    }
  }
  check('every source vertex round-trips', mismatch === 0, `${mismatch} mismatched fields`);

  // Padding indices repeat the variant's first index, so the padded triangles are degenerate.
  let padOk = true;
  for (let v = 0; v < gs.length; v++) {
    const first = gs[v].index.array[0];
    for (let k = gs[v].index.count; k < slots.indexSlot; k++) {
      if (arena.indexData[v * slots.indexSlot + k] !== first) padOk = false;
    }
  }
  check('padding indices are degenerate', padOk);

  check('overflow returns null', packPulledArena(gs, { vertexSlot: 8, indexSlot: 27 }) === null);
  check('index overflow returns null', packPulledArena(gs, { vertexSlot: 25, indexSlot: 4 }) === null);
}

console.log('vertexIndex mapping');
{
  const gs = [geo(10, 4, 1), geo(25, 9, 2), geo(7, 2, 3)];
  const slots = pulledArenaSlots(gs);
  const arena = packPulledArena(gs, slots);

  // For a live k the arena vertex must be the variant's own indexed vertex.
  let wrong = 0;
  for (let v = 0; v < gs.length; v++) {
    for (let k = 0; k < gs[v].index.count; k++) {
      const { live, offset } = pulledVertexOffset(k, v, arena);
      if (!live) { wrong++; continue; }
      const expectVert = gs[v].index.array[k];
      const p = gs[v].attributes.position.array;
      if (arena.vertexData[offset] !== p[expectVert * 3]) wrong++;
      if (offset !== (v * slots.vertexSlot + expectVert) * PULLED_VERTEX_STRIDE) wrong++;
    }
  }
  check('live k resolves to the variant\'s own vertex', wrong === 0, `${wrong} wrong`);

  // Past the variant's index count: not live, and collapsed onto its first vertex.
  const smallest = 2;   // 6 indices, slot 27
  const past = pulledVertexOffset(20, smallest, arena);
  const zero = pulledVertexOffset(0, smallest, arena);
  check('k past the count is not live', past.live === false);
  check('k past the count collapses onto k=0', past.offset === zero.offset);
  check('the largest variant is live to the end of the slot',
    pulledVertexOffset(slots.indexSlot - 1, 1, arena).live === true);

  // An empty variant (no geometry) is never live: the merged draw must skip it entirely.
  const withEmpty = packPulledArena([geo(6, 2, 1), null], pulledArenaSlots([geo(6, 2, 1), null]));
  check('an empty variant has zero counts', withEmpty.counts[2] === 0 && withEmpty.counts[3] === 0);
  check('an empty variant is never live', pulledVertexOffset(0, 1, withEmpty).live === false);
}

// ---------------------------------------------------------------------------
// The pulled draw wired into forest-gpu.js, headless. No GPU: the renderer stub only counts
// computeAsync calls, so this covers structure and CPU-side visibility, never a rendered pixel.
console.log('pulled mode in forest-gpu');
{
  const THREE = await import('three/webgpu');
  const { createTree } = await import('./trees.js');
  const { createForestPalette } = await import('./forest-palette.js');
  const { createForestGPU } = await import('./forest-gpu.js');
  const { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } = await import('./base-game-tree-species.js');

  const params = {
    speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 2),
    branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
    leafCount: 3, leafSize: 1, leafShadowPct: 0.3,
  };
  const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 1 });
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 10, 0); camera.lookAt(0, 0, -100); camera.updateMatrixWorld(true);
  const make = extra => createForestGPU({
    renderer: { computeAsync: async () => {} }, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 64,
    billboards: false, shadowLayer: 5, ...extra,
  });
  const rec = (x, z, speciesIdx = 0) => ({ x, z, scale: 1, yaw: 0, speciesIdx, slot: 0 });

  const plain = make();
  const pulled = make({ drawMode: 'pulled' });
  check('variants mode builds no merged mesh', plain.meshes.every(m => m.name !== 'forest:pulled:branchesL2'));
  check('variants mode reports its draw mode', plain.summary.drawMode === 'variants', plain.summary.drawMode);

  const merged = pulled.meshes.find(m => m.name === 'forest:pulled:branchesL2');
  check('pulled mode builds one merged mesh', !!merged);
  check('pulled mode reports its draw mode', pulled.summary.drawMode === 'pulled', pulled.summary.drawMode);
  check('the merged mesh is exactly one extra object', pulled.meshes.length === plain.meshes.length + 1,
    `${pulled.meshes.length} vs ${plain.meshes.length}`);

  const arena = pulled.summary.pulledArena;
  const l2 = palette.variants.map(v => v.branchesLod2 ?? v.branches);
  const widest = Math.max(...l2.map(g => g.index.count));
  check('the index slot covers the widest variant with slack', arena.indexSlot >= widest, `${arena.indexSlot} vs ${widest}`);
  check('the identity index buffer is the padded stride', merged.geometry.index.count === arena.indexSlot);
  check('the identity index buffer is the identity', merged.geometry.index.array[17] === 17);
  check('the dummy attributes cover every index value', merged.geometry.attributes.position.count === arena.indexSlot);
  check('the merged geometry draws indirect', merged.geometry.indirect != null);
  check('the merged indirect starts at the stride and zero instances',
    merged.geometry.indirect.array[0] === arena.indexSlot && merged.geometry.indirect.array[1] === 0);
  check('the merged geometry is instanced to the whole live list',
    merged.geometry.instanceCount === 2 * 64, String(merged.geometry.instanceCount));

  // Visibility: the merged mesh replaces the per-variant L2 branch meshes, one for one.
  pulled.setChunk('a', [rec(0, -200, 0), rec(0, -210, 1)]);
  await pulled.update();
  plain.setChunk('a', [rec(0, -200, 0), rec(0, -210, 1)]);
  await plain.update();
  const l2Named = f => f.meshes.filter(m => m.visible && /^forest:v\d+:branchesL2$/.test(m.name)).length;
  check('variants mode draws one L2 branch mesh per populated variant', l2Named(plain) === 2, String(l2Named(plain)));
  check('pulled mode hides every per-variant L2 branch mesh', l2Named(pulled) === 0, String(l2Named(pulled)));
  check('pulled mode shows the merged mesh instead', merged.visible === true);
  check('pulled mode submits one fewer main draw', pulled.summary.draws === plain.summary.draws - 1,
    `${pulled.summary.draws} vs ${plain.summary.draws}`);

  // The rung emptying must take the merged mesh with it.
  pulled.setChunk('a', [rec(0, -20, 0)]);
  await pulled.update();
  check('an empty L2 rung hides the merged mesh', merged.visible === false);
  pulled.setChunk('a', [rec(0, -200, 0)]);
  pulled.setLodEnabled([true, true, false]);
  await pulled.update();
  check('a disabled L2 rung hides the merged mesh', merged.visible === false);
  pulled.setLodEnabled([true, true, true]);
  await pulled.update();
  check('re-enabling the rung brings it back', merged.visible === true);

  // Wave install: a real geometry replacing a placeholder must land in the arena slot.
  const strideBefore = merged.geometry.index.array.length;
  const ok = pulled.installVariant(1, palette.variants[0]);
  check('installVariant repacks without changing the stride',
    ok && merged.geometry.index.array.length === strideBefore);
  check('installVariant records no arena overflow', pulled.summary.pulledArena.overflows === 0);

  // The merged mesh rides out with wave 0 so the host publishes and compiles it.
  check('variantMeshes(0) carries the merged mesh', pulled.variantMeshes(0).includes(merged));
  check('variantMeshes(1) does not', !pulled.variantMeshes(1).includes(merged));

  // The compute chain gains the merged reset and finalizer.
  check('pulled mode adds two compute pipelines',
    pulled.summary.computePipelines === plain.summary.computePipelines + 2,
    `${pulled.summary.computePipelines} vs ${plain.summary.computePipelines}`);

  let threw = null;
  try { pulled.dispose(); plain.dispose(); } catch (err) { threw = err; }
  check('dispose is clean in both modes', threw === null, String(threw));
}

// What uniform slots cost against a compact live-count mapping. Accounting only: neither number
// says which is faster on a device, and nothing here has been measured on one.
{
  console.log('\nuniform slots vs a compact live-count mapping');
  const counts = [1092, 1092, 1356, 1356, 6660, 6660];   // the default palette's real L2 index counts
  const even = counts.map(() => 100);
  const stride1 = Math.max(...counts);
  const c1 = pulledInvocationCost(counts, even, stride1);
  check('an even live mix wastes 2.19x at zero slack', Math.abs(c1.ratio - 2.19) < 0.01, c1.ratio.toFixed(3));
  const c125 = pulledInvocationCost(counts, even, Math.ceil(stride1 * 1.25));
  check('and 2.74x at the 1.25 slack the module now defaults to', Math.abs(c125.ratio - 2.74) < 0.01, c125.ratio.toFixed(3));
  const c2 = pulledInvocationCost(counts, even, Math.ceil(stride1 * 2));
  check('the original 2x slack was 4.39x', Math.abs(c2.ratio - 4.39) < 0.01, c2.ratio.toFixed(3));
  // The best case for slots: only the largest variant is on screen.
  const biggestOnly = counts.map((_, i) => (i === counts.length - 1 ? 100 : 0));
  check('a stand of only the largest variant wastes nothing at zero slack',
    pulledInvocationCost(counts, biggestOnly, stride1).ratio === 1);
  check('an empty frame reports no ratio rather than dividing by zero',
    pulledInvocationCost(counts, counts.map(() => 0), stride1).ratio === 0);
}

console.log(failures === 0 ? '\nAll pulled-arena tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
