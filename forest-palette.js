// forest-palette.js — bake a fixed set of tree variant geometries ONCE (browser).
// The expensive procedural generation runs species x VARIANTS times total at startup,
// not per tree per chunk. Each variant is the generator's branch/leaf/shadow geometry
// with a FLAT per-species color attribute baked in (bark color on branches, leaf tint
// on leaves + shadow) — this replicates the baker's appendGeom flat-color step
// (environment-viewer.html:884-888), because the generator geometry has no color
// attribute and the materials use vertexColors:true.
import * as THREE from 'three';
import { buildSpecies, rngFrom } from './forest-placement.js';

// fill a clone of `geom` with a flat per-vertex color (hex -> rgb), matching appendGeom.
function bakeFlatColor(geom, hex) {
  const g = geom.clone();
  const n = g.attributes.position.count;
  const r = ((hex >> 16) & 255) / 255, gc = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = gc; col[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// Build the per-species leaf/bark options the same way the baker does
// (environment-viewer.html:862-878). In authored mode the leaves switch to the larger
// 'quad' atlas billboards (cell = speciesIdx % atlasCells); procedural uses 'simple'.
function leafOptsFor(sp, params, texSet, spIdx) {
  const leafOpts = { ...sp.leaves, shadowFraction: params.leafShadowPct };
  leafOpts.count = Math.max(0, Math.floor(params.leafCount ?? sp.leaves.count ?? 10));
  leafOpts.size = sp.leaves.size * (params.leafSize ?? 1);
  if (params.leafStart !== undefined) leafOpts.start = params.leafStart;
  if (params.leafSpread !== undefined) leafOpts.spread = params.leafSpread;
  const useAtlas = texSet && texSet.mode && texSet.mode !== 'procedural' && texSet.leafAtlas;
  if (useAtlas) {
    const cells = texSet.leafAtlas.cols * texSet.leafAtlas.rows;
    leafOpts.shape = 'quad';
    // An AUTHORED species names its own cell (the ez families pin oak 0 / aspen 1 / ash 2 / pine 3,
    // matching tree-textures.js's LEAF_FILES), and that is real data, not a default to be improved
    // on. `spIdx % cells` is only right for buildSpecies()' procedural species, which carry no
    // atlas at all — applied to a family table it hands two of the three pines broadleaves.
    const authored = sp.leaves?.atlas?.cell;
    const cell = Number.isInteger(authored) && authored >= 0 && authored < cells
      ? authored
      : spIdx % cells;
    leafOpts.atlas = { cols: texSet.leafAtlas.cols, rows: texSet.leafAtlas.rows, cell };
  } else {
    leafOpts.shape = 'simple';
  }
  return leafOpts;
}

// createTree: the generator factory from trees.js. params/masterSeed: the same forest
// params + master seed the placement uses (so species match placementRecords). texSet:
// the active texture set (or null) — drives leaf shape (quad vs simple) and bark vScale,
// so the palette must be rebaked when texMode changes.
function createPaletteState({ createTree, params, masterSeed, variantsPerSpecies = 4, texSet = null }) {
  const gen = createTree({ seed: 1 });
  // An authored species table (from buildSpeciesFromFamilies) takes over when present;
  // its entries are full trees.js opts objects too, so nothing else below needs to change.
  const species = params.speciesTable || buildSpecies(params, rngFrom(masterSeed));
  const variants = [];
  return { gen, species, variants, params, masterSeed, variantsPerSpecies, texSet, bakeMs: 0 };
}

function bakeVariant(state, s, v) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { gen, species, variants, params, masterSeed, texSet } = state;
  const sp = species[s];
  const leafOpts = leafOptsFor(sp, params, texSet, s);
  const barkOpts = { ...sp.bark };
  if (texSet && texSet.barkVScale !== undefined) barkOpts.vScale = texSet.barkVScale;
  const seed = Math.floor(rngFrom(masterSeed + s * 977 + v * 131).next() * 0xffffffff) >>> 0;
  gen.regenerate({ ...sp, seed, leaves: leafOpts, bark: barkOpts, branchLods: params.branchLods ?? [] });
  const branchesGeo = bakeFlatColor(gen.branchesMesh.geometry, sp.bark.color);
  const branchesLod1Geo = gen.branchLodGeometries[0]
    ? bakeFlatColor(gen.branchLodGeometries[0], sp.bark.color) : null;
  const branchesLod2Geo = gen.branchLodGeometries[1]
    ? bakeFlatColor(gen.branchLodGeometries[1], sp.bark.color) : null;
  const leavesGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);
  const shadowGeo = bakeFlatColor(gen.leavesShadowMesh.geometry, sp.leaves.tint);

  const ratio = Math.max(0.05, Math.min(1.0, params.coarseLeafRatio ?? 0.25));
  const sizeMult = Math.max(1.0, params.coarseLeafSizeMult ?? 2.5);
  const coarseLeafOpts = {
    ...leafOpts,
    count: Math.max(1, Math.round(leafOpts.count * ratio)),
    size: leafOpts.size * sizeMult,
    shadowFraction: 0,
  };
  gen.regenerateLeaves(coarseLeafOpts);
  const leavesCoarseGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);

  const variant = {
    speciesIdx: s,
    variant: v,
    branches: branchesGeo,
    branchesLod1: branchesLod1Geo,
    branchesLod2: branchesLod2Geo,
    leaves: leavesGeo,
    shadow: shadowGeo,
    leavesCoarse: leavesCoarseGeo,
  };
  // Keep species-major slot order even when the async baker visits one variant from every family.
  variants[s * state.variantsPerSpecies + v] = variant;
  state.bakeMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  return variant;
}

function finishPalette(state) {
  return {
    variants: state.variants,
    variantsPerSpecies: state.variantsPerSpecies,
    speciesCount: state.species.length,
    bakeMs: state.bakeMs,
  };
}

export function createForestPalette(opts) {
  const state = createPaletteState(opts);
  for (let s = 0; s < state.species.length; s++) {
    for (let v = 0; v < state.variantsPerSpecies; v++) bakeVariant(state, s, v);
  }
  return finishPalette(state);
}

// Base Game enables trees at runtime, so baking the entire palette in the caller's frame creates a
// visible hitch. This twin keeps the synchronous API for existing hosts and yields between variants.
// `shouldContinue` lets a host abort a stale bake after disable/rebuild without finishing dead work.
export async function createForestPaletteAsync(opts, {
  yieldFn = async () => {},
  shouldContinue = () => true,
  onFamilyWave = null,
} = {}) {
  const state = createPaletteState(opts);
  const total = state.species.length * state.variantsPerSpecies;
  let built = 0;
  // Breadth-first across species: each wave contains the same variant number from every family.
  // A host can publish that complete wave, avoiding a temporary forest made from only one family.
  for (let v = 0; v < state.variantsPerSpecies; v++) {
    const wave = [];
    for (let s = 0; s < state.species.length; s++) {
      if (!shouldContinue()) return null;
      wave.push(bakeVariant(state, s, v));
      built++;
      if (s + 1 < state.species.length) await yieldFn();
    }
    if (!shouldContinue()) return null;
    if (onFamilyWave) {
      const keepGoing = await onFamilyWave({
        variant: v,
        variants: wave,
        palette: { ...finishPalette(state), variants: [...state.variants] },
        built,
        total,
      });
      if (keepGoing === false || !shouldContinue()) return null;
    }
    if (built < total) await yieldFn();
  }
  return shouldContinue() ? finishPalette(state) : null;
}
