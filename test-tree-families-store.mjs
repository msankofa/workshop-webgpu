// Node test for tree-families-store.js: the read boundary between tree-viewer's localStorage and
// bot-viewer's forest placement. Run: node test-tree-families-store.mjs
import {
  FAMILIES_KEY, validateFamily, loadFamilies, speciesTableFor, indexOfSpeciesId, familyOptions,
} from './tree-families-store.js';
import { EZ_TREE_FAMILIES } from './tree-presets.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };
const section = (name) => console.log(`\n[${name}]`);

// A storage stub, so nothing here needs a browser.
const stubStorage = (value) => ({ getItem: (k) => (k === FAMILIES_KEY ? value : null) });
const throwingStorage = { getItem() { throw new Error('SecurityError: storage disabled'); } };

section('1. validateFamily');
{
  const good = EZ_TREE_FAMILIES[0];
  ok(validateFamily(good), 'a stock family validates');
  ok(!validateFamily(null), 'null rejected');
  ok(!validateFamily([]), 'array rejected');
  ok(!validateFamily({ id: 'x' }), 'missing species rejected');
  ok(!validateFamily({ id: 'x', species: [] }), 'empty species rejected');
  ok(!validateFamily({ id: '', species: [{ id: 'a', opts: {} }] }), 'empty id rejected');
  ok(!validateFamily({ species: [{ id: 'a', opts: {} }] }), 'absent id rejected');
  ok(!validateFamily({ id: 'x', species: [{ id: 'a' }] }), 'species without opts rejected');
  ok(!validateFamily({ id: 'x', species: [{ opts: {} }] }), 'species without id rejected');
}

section('2. loadFamilies degrades instead of throwing');
{
  ok(loadFamilies(stubStorage(null)).length === 0, 'absent key yields []');
  ok(loadFamilies(stubStorage('not json{')).length === 0, 'unparseable JSON yields []');
  ok(loadFamilies(stubStorage('{"a":1}')).length === 0, 'non-array JSON yields []');
  ok(loadFamilies(stubStorage('[]')).length === 0, 'empty array yields []');
  ok(loadFamilies(throwingStorage).length === 0, 'a throwing storage yields [] (private mode)');
  ok(loadFamilies(undefined).length === 0, 'no storage at all yields [] (Node, no DOM)');

  const round = loadFamilies(stubStorage(JSON.stringify(EZ_TREE_FAMILIES)));
  ok(round.length === EZ_TREE_FAMILIES.length, `all ${EZ_TREE_FAMILIES.length} stock families survive a round trip`);

  // One bad entry must not cost the user the good ones.
  const mixed = JSON.stringify([EZ_TREE_FAMILIES[0], { id: 'broken' }, EZ_TREE_FAMILIES[1]]);
  const kept = loadFamilies(stubStorage(mixed));
  ok(kept.length === 2, 'a malformed family is dropped individually, not fatally');
  ok(kept[0].id === EZ_TREE_FAMILIES[0].id && kept[1].id === EZ_TREE_FAMILIES[1].id, 'the good families are the ones kept');
}

section('3. speciesTableFor');
{
  const all = speciesTableFor(EZ_TREE_FAMILIES);
  const totalSpecies = EZ_TREE_FAMILIES.reduce((n, f) => n + f.species.length, 0);
  ok(all.length === totalSpecies, `null filter takes every species (${totalSpecies})`);
  ok(all.every(s => typeof s._tag?.id === 'string' && s._tag.id.includes('/')), 'every entry carries a namespaced _tag.id');
  ok(new Set(all.map(s => s._tag.id)).size === all.length, 'ids are unique across families');
  ok(all.every(s => Array.isArray(s._tag.biomes)), 'placement metadata survives: biomes');
  ok(all.every(s => Number.isFinite(s._tag.density)), 'placement metadata survives: density');
  ok(all.every(s => Array.isArray(s._tag.sizeRange)), 'placement metadata survives: sizeRange');
  ok(all.every(s => s.leaves && s.bark && Number.isFinite(s.levels)), 'entries are complete trees.js opts');

  const pine = EZ_TREE_FAMILIES.find(f => f.id.includes('pine'));
  const justPine = speciesTableFor(EZ_TREE_FAMILIES, [pine.id]);
  ok(justPine.length === pine.species.length, 'a family filter selects only that family');
  ok(justPine.every(s => s._tag.id.startsWith(pine.id + '/')), 'every filtered entry belongs to the asked-for family');
  ok(justPine.length < all.length, 'filtering is actually narrower than the unfiltered table');

  const two = speciesTableFor(EZ_TREE_FAMILIES, [EZ_TREE_FAMILIES[0].id, EZ_TREE_FAMILIES[1].id]);
  ok(two.length === EZ_TREE_FAMILIES[0].species.length + EZ_TREE_FAMILIES[1].species.length, 'multi-family filter unions them');

  ok(speciesTableFor(EZ_TREE_FAMILIES, ['no-such-family']).length === 0, 'an unknown family id yields an empty table');
  ok(speciesTableFor([]).length === 0, 'no families yields an empty table');
}

section('4. id-to-index is stable under family-set changes');
{
  const all = speciesTableFor(EZ_TREE_FAMILIES);
  const target = all[5]._tag.id;
  ok(indexOfSpeciesId(all, target) === 5, 'round-trips its own index');
  ok(indexOfSpeciesId(all, 'nope/nope') === -1, 'unknown id reports -1 rather than 0');

  // Drop the first family; the same species must still be findable by id at its new index.
  const fewer = speciesTableFor(EZ_TREE_FAMILIES.slice(1));
  const moved = indexOfSpeciesId(fewer, target);
  if (moved === -1) {
    ok(target.startsWith(EZ_TREE_FAMILIES[0].id + '/'), 'only a species from the dropped family goes missing');
  } else {
    ok(fewer[moved]._tag.id === target, 'the species is found again at a shifted index');
    ok(moved !== 5, 'and the index genuinely shifted, so storing an index would have been wrong');
  }
}

section('5. familyOptions');
{
  const opts = familyOptions(EZ_TREE_FAMILIES);
  ok(opts.length === EZ_TREE_FAMILIES.length, 'one option per family');
  ok(opts.every(o => o.id && o.name && o.count > 0), 'each option has id, name and a species count');
  const named = familyOptions([{ id: 'bare', species: [{ id: 'a', opts: {} }] }]);
  ok(named[0].name === 'bare', 'a family with no name falls back to its id');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
