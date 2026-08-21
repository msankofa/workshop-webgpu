// Which ez-tree species grows in which park biome, and how tall it stands in metres.

import { buildSpeciesFromFamilies } from './forest-placement.js';

// heightM is the tallest of the species; minM the shortest. density is a weight within a biome.
export const PARK_TREE_SPECIES = Object.freeze({
  'ez-pine_small':   { biomes: ['mountain', 'forest'], density: 1.1, minM: 5.5, maxM: 10 },
  'ez-pine_medium':  { biomes: ['mountain', 'forest'], density: 0.9, minM: 10, maxM: 17 },
  'ez-pine_large':   { biomes: ['mountain', 'forest'], density: 0.5, minM: 17, maxM: 27 },
  'ez-oak_small':    { biomes: ['forest', 'meadow', 'town'], density: 0.9, minM: 4.5, maxM: 8 },
  'ez-oak_medium':   { biomes: ['forest', 'meadow', 'town'], density: 0.8, minM: 8, maxM: 14 },
  'ez-oak_large':    { biomes: ['forest', 'town'], density: 0.45, minM: 15, maxM: 23 },
  'ez-ash_small':    { biomes: ['forest', 'wetland', 'shore'], density: 0.9, minM: 5, maxM: 9 },
  'ez-ash_medium':   { biomes: ['forest', 'wetland', 'shore'], density: 0.7, minM: 9, maxM: 15 },
  'ez-ash_large':    { biomes: ['forest', 'wetland'], density: 0.4, minM: 15, maxM: 24 },
  'ez-aspen_small':  { biomes: ['meadow', 'forest', 'shore'], density: 1.0, minM: 5, maxM: 9 },
  'ez-aspen_medium': { biomes: ['meadow', 'forest', 'shore'], density: 0.7, minM: 9, maxM: 14 },
  'ez-aspen_large':  { biomes: ['meadow', 'forest'], density: 0.35, minM: 14, maxM: 20 },
  'ez-bush_1':       { biomes: ['meadow', 'shore', 'town', 'mountain'], density: 1.4, minM: 0.9, maxM: 1.8 },
  'ez-bush_2':       { biomes: ['meadow', 'wetland', 'forest'], density: 1.2, minM: 1.1, maxM: 2.2 },
  'ez-bush_3':       { biomes: ['shore', 'wetland', 'cave', 'mountain'], density: 1.0, minM: 0.7, maxM: 1.4 },
});

/** Turn a target height span into the [lo, hi] `sizeRange` that `sizeFor` will actually realise. */
export function sizeRangeFor(minM, maxM, naturalUnits, sizeVar) {
  const hi = maxM / Math.max(0.01, naturalUnits);
  const k = Math.max(0.12, 1 - sizeVar);
  if (k >= 1) return [hi, hi];
  const lo = (minM / Math.max(0.01, naturalUnits) - k * hi) / (1 - k);
  return [Math.max(0.001, lo), hi];
}

/** The species table `placementRecords`/`createForestPalette` want, tagged with park biomes. */
export function buildParkTreeTable(families, { include = PARK_TREE_SPECIES } = {}) {
  const kept = [];
  for (const fam of families) {
    const species = fam.species.filter((sp) => include[sp.id]);
    if (species.length) kept.push({ ...fam, species });
  }
  const table = buildSpeciesFromFamilies(kept);
  let i = 0;
  for (const fam of kept) {
    for (const sp of fam.species) {
      const spec = include[sp.id];
      const tag = table[i]._tag;
      tag.id = sp.id;
      tag.biomes = spec.biomes.slice();
      tag.density = spec.density;
      tag.minM = spec.minM;
      tag.maxM = spec.maxM;
      // Placeholder until the palette is baked and measured; 1 keeps the tree at ez-tree scale.
      tag.sizeRange = [1, 1];
      i++;
    }
  }
  return table;
}

/** Rewrite every `sizeRange` from the heights measured off the baked geometry. */
export function applyMeasuredHeights(table, naturalHeights, sizeVar) {
  for (let s = 0; s < table.length; s++) {
    const natural = naturalHeights[s];
    if (!(natural > 0)) continue;
    const tag = table[s]._tag;
    tag.natural = natural;
    tag.sizeRange = sizeRangeFor(tag.minM, tag.maxM, natural, sizeVar);
  }
  return table;
}

/** Every biome that has at least one species, so a caller can spot an unplantable biome. */
export function biomesCovered(table) {
  const out = new Set();
  for (const sp of table) for (const b of sp._tag.biomes) out.add(b);
  return [...out].sort();
}
