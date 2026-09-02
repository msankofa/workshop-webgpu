import {
  BASE_GAME_TREE_SPECIES,
  DEFAULT_BASE_GAME_TREE_SPECIES,
  selectedTreeSpeciesIds,
  speciesTableForSelection,
} from './base-game-tree-species.js';

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\nexplicit Base Game tree species');
const ids = BASE_GAME_TREE_SPECIES.map(species => species.id);
check('the stock catalog exposes all 16 named species', ids.length === 16 && new Set(ids).size === 16, `${ids.length}`);
const defaults = selectedTreeSpeciesIds(DEFAULT_BASE_GAME_TREE_SPECIES);
check('the default is an explicit aspen/oak/pine selection',
  defaults.join(',') === 'ez-aspen_small,ez-oak_small,ez-pine_small', defaults.join(','));
check('unknown ids and duplicates are removed in canonical catalog order',
  selectedTreeSpeciesIds('ez-pine_small,nope,ez-oak_small,ez-pine_small').join(',') === 'ez-oak_small,ez-pine_small');
check('an empty selection preserves procedural compatibility', speciesTableForSelection('') === null);
const table = speciesTableForSelection('ez-pine_small,ez-oak_small', { maxSize: 0.42 });
check('the selected table contains only the requested named species',
  table.map(species => species._tag.id).join(',') === 'ez-oak_small,ez-pine_small');
check('the Base Game max-size control replaces editor preset size ranges',
  table.every(species => species._tag.sizeRange[0] === 0 && species._tag.sizeRange[1] === 0.42));
check('the table retains distinct authored tree shapes', table[0].length[0] !== table[1].length[0]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
