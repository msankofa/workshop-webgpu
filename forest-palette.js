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
    leafOpts.atlas = { cols: texSet.leafAtlas.cols, rows: texSet.leafAtlas.rows, cell: spIdx % cells };
  } else {
    leafOpts.shape = 'simple';
  }
  return leafOpts;
}

// createTree: the generator factory from trees.js. params/masterSeed: the same forest
// params + master seed the placement uses (so species match placementRecords). texSet:
// the active texture set (or null) — drives leaf shape (quad vs simple) and bark vScale,
// so the palette must be rebaked when texMode changes.
export function createForestPalette({ createTree, params, masterSeed, variantsPerSpecies = 4, texSet = null }) {
  const gen = createTree({ seed: 1 });
  const species = buildSpecies(params, rngFrom(masterSeed));   // identical to the baker's species
  const variants = [];
  for (let s = 0; s < species.length; s++) {
    const sp = species[s];
    const leafOpts = leafOptsFor(sp, params, texSet, s);
    const barkOpts = { ...sp.bark };
    if (texSet && texSet.barkVScale !== undefined) barkOpts.vScale = texSet.barkVScale;
    for (let v = 0; v < variantsPerSpecies; v++) {
      const seed = Math.floor(rngFrom(masterSeed + s * 977 + v * 131).next() * 0xffffffff) >>> 0;
      gen.regenerate({ ...sp, seed, leaves: leafOpts, bark: barkOpts });
      const branchesGeo = bakeFlatColor(gen.branchesMesh.geometry, sp.bark.color);
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
      gen.regenerate({ ...sp, seed, leaves: coarseLeafOpts, bark: barkOpts });
      const leavesCoarseGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);

      variants.push({
        speciesIdx: s,
        variant: v,
        branches: branchesGeo,
        leaves: leavesGeo,
        shadow: shadowGeo,
        leavesCoarse: leavesCoarseGeo,
      });
    }
  }
  return { variants, variantsPerSpecies, speciesCount: species.length };
}
