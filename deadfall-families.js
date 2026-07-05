// deadfall-families.js -- the SNAG (standing dead tree) as an authored tree-family entry, so it
// rides the EXISTING forest pipeline (buildSpeciesFromFamilies -> forest-placement.js
// placementRecords -> forest-palette.js bake -> forest-gpu.js draw) with NO new renderer. A snag
// is "dead trees for free": a normal trees.js species with foliage OFF and a broken-top taper.
//
// WHY A NEW FILE, NOT AN EDIT TO trees.js: a snag is fully expressible as a trees.js *opts
// object* (leaves.enabled:false + a blunt trunk taper + short stub branches) -- it needs ZERO
// change to the generator core, so it cannot perturb any existing species' RNG draw order or
// byte-output (the determinism tests stay green). The families table itself ships empty
// (families/manifest.json = []), and the world builds species via buildSpecies() unless a
// speciesTable is supplied; this module is the additive data a caller merges in (see the
// deferred-integration note in docs/subsystems/vegetation.md).
//
// Shape matches forest-placement.js buildSpeciesFromFamilies(families): each family is
// { id, name, species: [{ opts (full trees.js opts), biomes, density, sizeRange }] }.

// A blunt broken trunk: taper[0] ~0.55 leaves the top at ~45% of base radius (a snapped stub,
// NOT a needle tip -- trees.js only collapses the very tip to 0 when branch.level === levels, so
// a level-0 trunk with levels>=1 keeps a blunt top). Foliage is off. A few short high-taper stub
// branches suggest broken limbs. Grey-brown dead bark.
const SNAG_BARK = 0x5a4f45;

function snagOpts(over = {}) {
  return {
    levels: over.levels ?? 1,
    length: over.length ?? [11, 3.5],
    radius: over.radius ?? [0.9, 0.28],
    taper: over.taper ?? [0.55, 0.85],       // blunt broken top on the trunk
    children: over.children ?? [3, 0],        // a few stub limbs, no sub-branches
    branchStart: [0.45, 0.4],
    angle: over.angle ?? [0, 62],
    gnarliness: over.gnarliness ?? [0.12, 0.22],
    sections: [8, 4],
    segments: [8, 5],
    force: { direction: [0, 1, 0], strength: 0.02 },
    bark: { color: over.barkColor ?? SNAG_BARK, roughness: 0.95, vScale: 0.4 },
    leaves: { enabled: false, count: 0 },     // DEAD: no foliage
  };
}

// Two snag species for silhouette variety: a tall broken bole and a short jagged stub.
export const SNAG_FAMILY = {
  id: 'snag',
  name: 'Snags (dead standing)',
  species: [
    {
      opts: snagOpts({ levels: 1, length: [12, 3.5], radius: [0.95, 0.3], taper: [0.5, 0.85], children: [3, 0] }),
      biomes: [],           // [] = eligible in any biome; author can restrict to forest/taiga/swamp
      density: 0.06,        // LOW weight among live species -> rare dead trees inside forests
      sizeRange: [0.8, 1.35],
    },
    {
      opts: snagOpts({ levels: 1, length: [6.5, 2.4], radius: [0.7, 0.24], taper: [0.62, 0.88], children: [2, 0], angle: [0, 70] }),
      biomes: [],
      density: 0.05,
      sizeRange: [0.7, 1.1],
    },
  ],
};

// Convenience: merge the snag family into an existing families array (returns a new array).
export function withSnags(families = []) {
  return [...families, SNAG_FAMILY];
}

export default SNAG_FAMILY;
