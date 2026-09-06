import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTree } from './trees.js';
import { createForestPalette, createForestPaletteAsync } from './forest-palette.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

function fingerprint(palette) {
  const hash = createHash('sha256');
  for (const variant of palette.variants) {
    hash.update(JSON.stringify([variant.speciesIdx, variant.variant]));
    for (const key of ['branches', 'branchesLod1', 'branchesLod2', 'leaves', 'shadow', 'leavesCoarse']) {
      const geo = variant[key];
      hash.update(key);
      if (!geo) { hash.update('null'); continue; }
      for (const [name, attr] of [['index', geo.index], ...Object.entries(geo.attributes)]) {
        hash.update(JSON.stringify([name, attr.itemSize, attr.normalized, attr.array.constructor.name]));
        hash.update(Buffer.from(attr.array.buffer, attr.array.byteOffset, attr.array.byteLength));
      }
      hash.update(JSON.stringify(geo.boundingSphere));
    }
  }
  return hash.digest('hex');
}

function generatorFactory(legacy) {
  const result = { builds: 0, generators: [] };
  result.create = options => {
    // Reproduce the former constructor(seed:1), then regenerate(first variant) sequence.
    const tree = createTree(legacy ? { seed: 1 } : options);
    result.builds++;
    if (legacy) { tree.regenerate(options); result.builds++; }
    const regenerate = tree.regenerate.bind(tree);
    tree.regenerate = opts => { result.builds++; return regenerate(opts); };
    result.generators.push(tree);
    return tree;
  };
  return result;
}

function dispose(palette, factory) {
  for (const variant of palette.variants) {
    for (const geo of Object.values(variant)) if (geo?.isBufferGeometry) geo.dispose();
  }
  for (const tree of factory.generators) tree.dispose();
}

for (const authored of [false, true]) {
  const params = {
    species: 3, diversity: 0.5, generalization: 0.5, maxSize: 0.55,
    leafCount: 10, leafSize: 1, leafShadowPct: 0.3,
    ...(authored ? {
      speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES),
      branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
    } : {}),
  };
  const opts = { params, masterSeed: 20260616, variantsPerSpecies: 2,
    texSet: authored ? { mode: 'authored', leafAtlas: { cols: 2, rows: 2 }, barkVScale: 0.35 } : null };
  const legacy = generatorFactory(true), optimized = generatorFactory(false), asyncFactory = generatorFactory(false);
  const before = createForestPalette({ ...opts, createTree: legacy.create });
  const after = createForestPalette({ ...opts, createTree: optimized.create });
  const asyncPalette = await createForestPaletteAsync({ ...opts, createTree: asyncFactory.create });
  assert.equal(legacy.builds, 7);
  assert.equal(optimized.builds, 6);
  assert.equal(asyncFactory.builds, 6);
  assert.equal(fingerprint(after), fingerprint(before), 'all geometry bytes match the old generation sequence');
  assert.equal(fingerprint(asyncPalette), fingerprint(after), 'async wave ordering preserves the same palette');
  assert.ok(after.bakeMs > 0);
  dispose(before, legacy); dispose(after, optimized); dispose(asyncPalette, asyncFactory);
  console.log(`${authored ? 'authored + trunk LODs' : 'procedural viewer'}: 7 -> 6 full tree builds; byte-identical palette`);
}
let created = 0;
const cancelled = await createForestPaletteAsync({
  createTree: () => { created++; throw new Error('cancelled bake created a generator'); },
  params: { speciesTable: [{}] }, masterSeed: 1,
}, { shouldContinue: () => false });
assert.equal(cancelled, null);
assert.equal(created, 0);
console.log('pre-cancelled palette creates no unused default tree');
{
  const params = { species: 2, diversity: 0.5, generalization: 0.5, maxSize: 0.55, leafCount: 6, leafSize: 1, leafShadowPct: 0.3,
    speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES).slice(0, 1) };
  const a = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2 });
  const b = createForestPalette({ createTree, params, masterSeed: 987654, variantsPerSpecies: 2 });
  assert.equal(fingerprint(a), fingerprint(b), 'two worlds with the same species table share one palette');
  console.log('palette geometry does not depend on the world seed');
}
