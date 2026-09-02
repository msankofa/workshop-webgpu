// Explicit species catalog for Base Game. The stock ez-tree presets already carry stable ids,
// names, geometry options and family membership; this module turns a saved comma-separated
// selection into the exact table shared by placement and palette baking.
import { EZ_TREE_FAMILIES } from './tree-presets.js';
import { buildSpeciesFromFamilies } from './forest-placement.js';

export const BASE_GAME_TREE_SPECIES = Object.freeze(EZ_TREE_FAMILIES.flatMap(family =>
  family.species.map(species => Object.freeze({
    id: species.id,
    name: species.name,
    familyId: family.id,
    familyName: family.name,
    label: `${family.name} — ${species.name}`,
  }))));

export const DEFAULT_BASE_GAME_TREE_SPECIES = 'ez-aspen_small,ez-oak_small,ez-pine_small';

const SPECIES_IDS = new Set(BASE_GAME_TREE_SPECIES.map(species => species.id));

export function selectedTreeSpeciesIds(value, fallback = []) {
  const requested = new Set((Array.isArray(value) ? value : String(value ?? '').split(','))
    .map(id => String(id).trim()).filter(id => SPECIES_IDS.has(id)));
  if (!requested.size) for (const id of fallback) if (SPECIES_IDS.has(id)) requested.add(id);
  // Catalog order is canonical. Checkbox order, CSV order and old save-file order cannot change
  // speciesIdx or the deterministic placement identity.
  return BASE_GAME_TREE_SPECIES.filter(species => requested.has(species.id)).map(species => species.id);
}

export function speciesTableForSelection(value, { maxSize = 0.55 } = {}) {
  const ids = selectedTreeSpeciesIds(value);
  if (!ids.length) return null; // empty remains the procedural compatibility mode
  const selected = new Set(ids);
  const families = EZ_TREE_FAMILIES.map(family => ({
    ...family,
    species: family.species.filter(species => selected.has(species.id)),
  })).filter(family => family.species.length);
  const table = buildSpeciesFromFamilies(families);
  const scaleMax = Math.max(0.01, Number(maxSize) || 0.55);
  let index = 0;
  for (const family of families) for (const species of family.species) {
    table[index]._tag.id = species.id;
    table[index]._tag.familyId = family.id;
    // Keep Base Game's existing global size slider/variance semantics. Preset sizeRange values are
    // editor authoring metadata and would otherwise make the stock medium/large trees enormous.
    table[index]._tag.sizeRange = [0, scaleMax];
    index++;
  }
  return table;
}
