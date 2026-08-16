// Reads the families authored in tree-viewer.html and turns them into a forest-placement species
// table. Pure and DOM-free apart from the injectable storage handle, so it runs headless in Node.
//
// tree-viewer.html and bot-viewer-v3.html are served from one origin by serve.py, so they already
// share a localStorage bucket -- no fetch, no manifest, no export step. Read-only by contract:
// nothing here ever writes tree-viewer's keys back.
import { buildSpeciesFromFamilies } from './forest-placement.js';

export const FAMILIES_KEY = 'tree-viewer:families';

// The two pages version independently and nothing but this function connects them, so the shape is
// checked at the read boundary rather than trusted.
export function validateFamily(fam) {
  if (!fam || typeof fam !== 'object' || Array.isArray(fam)) return false;
  if (typeof fam.id !== 'string' || !fam.id) return false;
  if (!Array.isArray(fam.species) || fam.species.length === 0) return false;
  return fam.species.every(sp =>
    sp && typeof sp === 'object'
    && typeof sp.id === 'string' && sp.id
    && sp.opts && typeof sp.opts === 'object');
}

// Malformed families are dropped individually: one bad entry should not cost the user the rest.
export function loadFamilies(storage = globalThis.localStorage) {
  let raw = null;
  try {
    raw = storage?.getItem(FAMILIES_KEY) ?? null;
  } catch { return []; }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(validateFamily);
}

// Same nested walk buildSpeciesFromFamilies uses, so index k lines up with its output entry k.
function speciesIdsInOrder(families) {
  const ids = [];
  for (const fam of families) for (const sp of fam.species) ids.push(`${fam.id}/${sp.id}`);
  return ids;
}

// `familyIds` null means every family -- that is the "random across everything" mode. Passing a
// subset is the whole of family-specific selection: placementRecords already does the biome filter
// and density-weighted draw once params.speciesTable is set.
export function speciesTableFor(families, familyIds = null) {
  const picked = familyIds
    ? families.filter(f => familyIds.includes(f.id))
    : families;
  if (!picked.length) return [];
  const table = buildSpeciesFromFamilies(picked);
  const ids = speciesIdsInOrder(picked);
  // Fails loudly rather than silently mis-associating ids if that flatten ever changes shape.
  if (table.length !== ids.length) {
    throw new Error(`species table length ${table.length} != id count ${ids.length}`);
  }
  for (let i = 0; i < table.length; i++) table[i]._tag.id = ids[i];
  return table;
}

// Hand-placed records store a species id, not an index: indices move when the family set changes.
export function indexOfSpeciesId(table, id) {
  for (let i = 0; i < table.length; i++) if (table[i]._tag?.id === id) return i;
  return -1;
}

export function familyOptions(families) {
  return families.map(f => ({ id: f.id, name: f.name || f.id, count: f.species.length }));
}
