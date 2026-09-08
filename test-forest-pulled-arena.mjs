// test-forest-pulled-arena.mjs — the pulled-draw arena packing and its vertexIndex mapping.
// Pure JS; no THREE, no GPU. forest-gpu.js transcribes pulledVertexOffset into TSL.
import {
  pulledArenaSlots, packPulledArena, pulledVertexOffset, pulledInvocationCost, PULLED_VERTEX_STRIDE,
  pulledCompactPrefix, pulledCompactLookup, pulledCompactVertex, pulledCompactInstances, PULLED_COMPACT_CHUNK,
} from './forest-cull.js';

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
  // The stub renderer has no device, so the admission check reports unknown; assumeLimits is how a
  // Node test says "build it anyway", and it is the only thing that can authorize an unknown device.
  const make = extra => createForestGPU({
    renderer: { computeAsync: async () => {} }, camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 64,
    billboards: false, shadowLayer: 5, assumeLimits: true, ...extra,
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

// ---------------------------------------------------------------------------
// The compact mode and the validation-failure fallback, wired into forest-gpu.js headless.
console.log('\ncompact mode + validation failure in forest-gpu');
{
  const THREE = await import('three/webgpu');
  const { createTree } = await import('./trees.js');
  const { createForestPalette } = await import('./forest-palette.js');
  const { createForestGPU, pulledAdmission, PULLED_VERTEX_STORAGE_BINDINGS } = await import('./forest-gpu.js');
  const { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } = await import('./base-game-tree-species.js');

  const params = {
    speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 2),
    branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
    leafCount: 3, leafSize: 1, leafShadowPct: 0.3,
  };
  const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 1 });
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000);
  camera.position.set(0, 10, 0); camera.lookAt(0, 0, -100); camera.updateMatrixWorld(true);
  const rec = (x, z, speciesIdx = 0) => ({ x, z, scale: 1, yaw: 0, speciesIdx, slot: 0 });
  // A fake device with the WebGPU event surface, so the uncapturederror path can be driven here.
  function fakeDevice(limit = 8) {
    const listeners = new Map();
    return {
      limits: { maxStorageBuffersInVertexStage: limit, maxStorageBuffersPerShaderStage: 10 },
      addEventListener: (t, fn) => listeners.set(t, fn),
      removeEventListener: t => listeners.delete(t),
      emit: (t, ev) => listeners.get(t)?.(ev),
      get listening() { return listeners.size; },
    };
  }
  const make = (extra, device = null) => createForestGPU({
    renderer: { computeAsync: async () => {}, backend: device ? { device } : undefined },
    camera, palette, heightAt: () => 0,
    lodR0: 60, lodR1: 140, lodR2: 260, maxDrawRadius: 260, capPerVariant: 64,
    billboards: false, shadowLayer: 5, ...extra,
  });

  // ---- the admission rule ----
  check('a device short of the bindings is refused',
    pulledAdmission({ backend: { device: { limits: { maxStorageBuffersInVertexStage: 2 } } } }).admitted === false);
  check('a device that has them is admitted from the DEVICE, not the adapter',
    (() => {
      const a = pulledAdmission({ backend: { device: { limits: { maxStorageBuffersInVertexStage: PULLED_VERTEX_STORAGE_BINDINGS } } }, adapter: { limits: { maxStorageBuffersInVertexStage: 0 } } });
      return a.admitted === true && a.source === 'device';
    })());
  check('an adapter that reports plenty cannot rescue a short device',
    pulledAdmission({ backend: { device: { limits: { maxStorageBuffersInVertexStage: 1 } }, adapter: { limits: { maxStorageBuffersInVertexStage: 16 } } } }).admitted === false);
  check('no device at all is unknown and refused', (() => {
    const a = pulledAdmission({});
    return a.admitted === false && a.source === 'unknown';
  })());
  check('assumeLimits true is the only thing that admits an unknown device',
    pulledAdmission({}, true).admitted === true);
  check('and assumeLimits can stand in for a short device', pulledAdmission({}, { maxStorageBuffersInVertexStage: 1 }).admitted === false);
  check('a forest given no device falls back rather than building the pulled path',
    make({ drawMode: 'pulled' }).summary.drawMode === 'variants-fallback');

  // ---- compact mode structure ----
  const compact = make({ drawMode: 'pulled-compact' }, fakeDevice());
  const merged = compact.meshes.find(m => m.name === 'forest:pulled:branchesL2');
  check('compact mode builds one merged mesh', !!merged, compact.summary.pulledError ?? '');
  check('compact mode reports its mode and mapping',
    compact.summary.drawMode === 'pulled-compact' && compact.summary.pulledMapping === 'compact',
    `${compact.summary.drawMode}/${compact.summary.pulledMapping}`);
  check('the admission it used came from the device it was given', compact.summary.pulledAdmission.source === 'device');
  const chunk = compact.summary.pulledArena.chunk;
  check('the identity index buffer is one chunk, not the padded slot',
    merged.geometry.index.count === chunk && chunk !== compact.summary.pulledArena.indexSlot, String(chunk));
  check('the merged indirect starts at the chunk and zero instances',
    merged.geometry.indirect.array[0] === chunk && merged.geometry.indirect.array[1] === 0);
  check('compact mode needs no merged instance buffer', compact.summary.pulledArena.instanceBytes === 0);
  const slots = make({ drawMode: 'pulled' }, fakeDevice());
  check('compact adds one compute pipeline where slots add two (no merged reset, no merged atomic)',
    compact.summary.computePipelines === slots.summary.computePipelines - 1,
    `${compact.summary.computePipelines} vs ${slots.summary.computePipelines}`);

  compact.setChunk('a', [rec(0, -200, 0), rec(0, -210, 1)]);
  await compact.update();
  check('compact mode hides every per-variant L2 branch mesh',
    compact.meshes.filter(m => m.visible && /^forest:v\d+:branchesL2$/.test(m.name)).length === 0);
  check('and shows the merged mesh instead', merged.visible === true);

  // ---- validation failure ----
  const device = fakeDevice();
  const failing = make({ drawMode: 'pulled-compact' }, device);
  const failMerged = failing.meshes.find(m => m.name === 'forest:pulled:branchesL2');
  failing.setChunk('a', [rec(0, -200, 0), rec(0, -210, 1)]);
  await failing.update();
  check('the device is listened to while a pulled mode is active', device.listening === 1);
  check('the merged mesh is drawing before the error', failMerged.visible === true);
  device.emit('uncapturederror', { error: { message: 'pipeline validation failed: too many storage buffers' } });
  check('an uncaptured device error switches the rung back to variants',
    failing.summary.drawMode === 'variants-fallback', failing.summary.drawMode);
  check('and records what the device said', /pipeline validation failed/.test(failing.summary.pulledError ?? ''),
    failing.summary.pulledError ?? '');
  check('the merged mesh stops drawing', failMerged.visible === false);
  check('the per-variant L2 meshes come back without a rebuild',
    failing.meshes.filter(m => m.visible && /^forest:v\d+:branchesL2$/.test(m.name)).length === 2);
  check('the listener is removed so one error is enough', device.listening === 0);

  let threw = null;
  try { compact.dispose(); slots.dispose(); failing.dispose(); } catch (e) { threw = e; }
  check('dispose is clean in compact mode and after a failure', threw === null, String(threw));
}

// ---------------------------------------------------------------------------
// The compact live-count mapping. Pure accounting and index arithmetic; nothing here runs on a GPU.
console.log('\ncompact mapping');
{
  const counts = [1092, 1092, 1356, 1356, 6660, 6660];   // the default palette's real L2 index counts

  // A round trip over every vertex of a small case: each gi must land on the variant and instance
  // whose span holds it, and every (variant, instance, k) must be hit exactly once.
  {
    const ic = [9, 6, 12];
    const live = [2, 0, 3];   // variant 1 has no live instances at all
    const prefix = pulledCompactPrefix(ic, live);
    const total = prefix[ic.length];
    check('the total is sum(live x indexCount)', total === 2 * 9 + 0 * 6 + 3 * 12, String(total));
    const seen = new Set();
    let bad = 0;
    for (let gi = 0; gi < total; gi++) {
      const h = pulledCompactLookup(gi, prefix, ic);
      if (!h.live) bad++;
      if (h.instance >= live[h.variant]) bad++;
      if (h.k >= ic[h.variant]) bad++;
      const key = `${h.variant}/${h.instance}/${h.k}`;
      if (seen.has(key)) bad++;
      seen.add(key);
    }
    check('every vertex maps to a live (variant, instance, k)', bad === 0, `${bad} bad`);
    check('and every one of them exactly once', seen.size === total, `${seen.size} of ${total}`);
    check('a zero-live variant is never reached', ![...seen].some(k => k.startsWith('1/')));
    const past = pulledCompactLookup(total, prefix, ic);
    check('a vertex past the total is not live and collapses onto variant 0 k=0',
      past.live === false && past.variant === 0 && past.instance === 0 && past.k === 0);
  }

  // The boundary vertices of every span, over random live distributions including empty variants.
  {
    let bad = 0;
    let rng = 12345;
    const rand = n => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) % n);
    for (let trial = 0; trial < 200; trial++) {
      const live = counts.map(() => (rand(4) === 0 ? 0 : rand(40)));
      const prefix = pulledCompactPrefix(counts, live);
      for (let v = 0; v < counts.length; v++) {
        if (live[v] === 0) continue;
        const first = pulledCompactLookup(prefix[v], prefix, counts);
        if (first.variant !== v || first.instance !== 0 || first.k !== 0) bad++;
        const last = pulledCompactLookup(prefix[v + 1] - 1, prefix, counts);
        if (last.variant !== v || last.instance !== live[v] - 1 || last.k !== counts[v] - 1) bad++;
      }
      const total = prefix[counts.length];
      const expect = counts.reduce((a, c, i) => a + c * live[i], 0);
      if (total !== expect) bad++;
    }
    check('every span boundary lands where it should over 200 random live mixes', bad === 0, `${bad} bad`);
  }

  // The live cap: a variant whose cull overflowed cannot claim more vertices than the draw buffer holds.
  {
    const prefix = pulledCompactPrefix([9, 6], [100, 5], 10);
    check('live counts are clamped to the per-variant cap', prefix[2] === 10 * 9 + 5 * 6, String(prefix[2]));
  }

  // Chunking: the draw dispatches ceil(total/chunk) instances and wastes at most chunk-1 vertices
  // per FRAME, and no triangle straddles a chunk edge because every count is a multiple of three.
  {
    const live = counts.map(() => 100);
    const prefix = pulledCompactPrefix(counts, live);
    const total = prefix[counts.length];
    const n = pulledCompactInstances(total);
    check('the chunk count covers the total', n * PULLED_COMPACT_CHUNK >= total);
    check('and wastes less than one chunk', n * PULLED_COMPACT_CHUNK - total < PULLED_COMPACT_CHUNK,
      String(n * PULLED_COMPACT_CHUNK - total));
    check('the chunk is a multiple of three, so triangles never straddle one', PULLED_COMPACT_CHUNK % 3 === 0);
    check('every span boundary is a multiple of three', [...prefix].every(v => v % 3 === 0));
    check('an empty rung dispatches nothing at all', pulledCompactInstances(0) === 0);
  }

  // Total invocations, against what slots dispatch for the same frame.
  {
    const live = counts.map(() => 100);
    const prefix = pulledCompactPrefix(counts, live);
    const cost = pulledInvocationCost(counts, live, Math.ceil(Math.max(...counts) * 1.25));
    check('the compact mapping dispatches exactly the prefix total',
      prefix[counts.length] === cost.compact, `${prefix[counts.length]} vs ${cost.compact}`);
    check('which is 2.74x fewer than slots at the shipped slack', Math.abs(cost.ratio - 2.74) < 0.01, cost.ratio.toFixed(3));
  }

  // The arena offset, end to end: gi -> variant -> that variant's own index buffer -> arena vertex.
  {
    const gs = [geo(10, 4, 1), geo(25, 9, 2), geo(7, 2, 3)];
    const slots = pulledArenaSlots(gs);
    const arena = packPulledArena(gs, slots);
    const ic = [0, 1, 2].map(v => arena.counts[v * 2 + 1]);
    const live = [2, 1, 0];
    const prefix = pulledCompactPrefix(ic, live);
    let wrong = 0;
    for (let gi = 0; gi < prefix[3]; gi++) {
      const h = pulledCompactVertex(gi, prefix, arena);
      const expectVert = gs[h.variant].index.array[h.k];
      if (h.offset !== (h.variant * slots.vertexSlot + expectVert) * PULLED_VERTEX_STRIDE) wrong++;
      if (arena.vertexData[h.offset] !== gs[h.variant].attributes.position.array[expectVert * 3]) wrong++;
    }
    check('the compact offset resolves the same arena vertex the slot mapping would', wrong === 0, `${wrong} wrong`);
    check('a variant with no live instances contributes no vertices', prefix[3] === 2 * ic[0] + ic[1]);
  }
}

console.log(failures === 0 ? '\nAll pulled-arena tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
