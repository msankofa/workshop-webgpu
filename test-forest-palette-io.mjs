import assert from 'node:assert/strict';
import { createTree, TREES_VERSION } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { paletteKey, paletteKeyInput, serializePalette, deserializePalette, PALETTE_TIERS } from './forest-palette-io.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

function attrBytes(attr) {
  return Buffer.from(attr.array.buffer, attr.array.byteOffset, attr.array.byteLength);
}
function assertSameGeometry(a, b, label) {
  if (!a || !b) { assert.equal(a, b, label); return; }
  const names = ['index', ...Object.keys(a.attributes).sort()];
  assert.deepEqual(names, ['index', ...Object.keys(b.attributes).sort()], `${label} attribute names`);
  for (const n of names) {
    const x = n === 'index' ? a.index : a.attributes[n], y = n === 'index' ? b.index : b.attributes[n];
    if (!x || !y) { assert.equal(x, y, `${label}.${n}`); continue; }
    assert.equal(x.itemSize, y.itemSize, `${label}.${n} itemSize`);
    assert.equal(x.array.constructor.name, y.array.constructor.name, `${label}.${n} type`);
    assert.ok(attrBytes(x).equals(attrBytes(y)), `${label}.${n} bytes`);
  }
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 10, leafSize: 1, leafShadowPct: 0.3, midLeafRatio: 0.5, midLeafSizeMult: 1.5,
};
const texSet = { mode: 'authored', leafAtlas: { cols: 2, rows: 2 }, barkVScale: 0.35 };
const fresh = createForestPalette({ createTree, params, masterSeed: 20260906, variantsPerSpecies: 2, texSet });

// Round trip: every tier of every variant byte-identical, shared tier objects stay shared.
const buf = serializePalette(fresh.variants, { key: 'abc', treesVersion: TREES_VERSION });
const loaded = deserializePalette(buf);
assert.equal(loaded.meta.key, 'abc');
assert.equal(loaded.meta.treesVersion, TREES_VERSION);
assert.equal(loaded.variants.length, fresh.variants.length);
for (let i = 0; i < fresh.variants.length; i++) {
  const f = fresh.variants[i], l = loaded.variants[i];
  assert.equal(l.speciesIdx, f.speciesIdx); assert.equal(l.variant, f.variant);
  for (const t of PALETTE_TIERS) assertSameGeometry(f[t], l[t], `variant ${i} ${t}`);
}
assert.equal(buf.byteLength % 4, 0);
const sharedFresh = createForestPalette({ createTree, params: { ...params, midLeafRatio: 1, midLeafSizeMult: 1 }, masterSeed: 1, variantsPerSpecies: 1, texSet });
assert.equal(sharedFresh.variants[0].leavesMid, sharedFresh.variants[0].leaves);
const sharedLoaded = deserializePalette(serializePalette(sharedFresh.variants));
assert.equal(sharedLoaded.variants[0].leavesMid, sharedLoaded.variants[0].leaves, 'shared tier survives as one object');
assert.ok(Buffer.from(serializePalette(loaded.variants, loaded.meta)).equals(Buffer.from(buf)), 'reserialize is stable');
assert.throws(() => deserializePalette(new ArrayBuffer(16)), /not a palette/);
console.log(`round trip: ${fresh.variants.length} variants, ${(buf.byteLength / 1024).toFixed(0)} KB, byte-identical`);

// Key: stable across property order and unrelated params; changes with every input it should.
const base = { species: params.speciesTable[0], params, speciesIdx: 0, variantsPerSpecies: 2, texMode: 'authored', leafAtlas: texSet.leafAtlas, barkVScale: 0.35, treesVersion: TREES_VERSION };
const k0 = await paletteKey(base);
assert.match(k0, /^[0-9a-f]{40}$/);
const reordered = JSON.parse(JSON.stringify(base));
reordered.species = Object.fromEntries(Object.entries(reordered.species).reverse());
assert.equal(await paletteKey(reordered), k0, 'property order');
assert.equal(await paletteKey({ ...base, params: { ...params, treeLeafSway: 9, density: 3 } }), k0, 'non-geometry params ignored');
assert.equal(await paletteKey({ ...base, species: { ...base.species, bark: { ...base.species.bark, map: {} } } }), k0, 'textures ignored');
assert.equal(await paletteKey({ ...base, texMode: 'ez' }), await paletteKey({ ...base, texMode: 'authored' }), 'any non-procedural mode is authored');
assert.equal(await paletteKey({ ...base, masterSeed: 99 }), k0, 'the world seed is not part of the key');
const changed = {
  species: { ...base.species, seedBias: 1 }, speciesIdx: 1, variantsPerSpecies: 3,
  texMode: 'procedural', leafAtlas: { cols: 4, rows: 4 }, barkVScale: 0.5, treesVersion: TREES_VERSION + 1,
  params: { ...params, midLeafRatio: 0.25 },
};
for (const [field, value] of Object.entries(changed)) {
  assert.notEqual(await paletteKey({ ...base, [field]: value }), k0, `key changes with ${field}`);
}
assert.ok(paletteKeyInput(base).includes('"treesVersion"'));
console.log('key: stable across order/unrelated params/world seed, changes with 8 inputs');
