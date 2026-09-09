// Throwaway: bake the Base Game default palette headless and count leaf geometry per role.
import { createTree } from '../../../trees.js';
import { createForestPalette } from '../../../forest-palette.js';
import { speciesTableForSelection } from '../../../base-game-tree-species.js';
import { rungTriangles } from '../../../base-game-forest.js';

const SEL = 'ez-ash_small,ez-ash_medium,ez-aspen_small,ez-oak_small,ez-oak_large,ez-pine_small,ez-pine_large,ez-bush_1';
const BRANCH_LODS = [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }];
const params = {
  speciesTable: speciesTableForSelection(SEL, { maxSize: 0.55 }),
  branchLods: BRANCH_LODS,
  leafCount: 10, leafSize: 1, leafStart: 0.25, leafSpread: 0,
  leafShadowPct: 0.3, coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5,
  // midLeafRatio / midLeafSizeMult deliberately absent: base-game-forest.js never passes them.
};
const texSet = { mode: 'authored', barkVScale: 4, leafAtlas: { cols: 2, rows: 2 } };
const palette = createForestPalette({ createTree, params, masterSeed: 1, variantsPerSpecies: 2, texSet });

const tris = g => (g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0)) / 3;
const verts = g => g?.attributes?.position?.count ?? 0;
const rows = [];
let tot = { leaves: 0, leavesMid: 0, shadow: 0, leavesCoarse: 0, branches: 0, branchesLod1: 0, branchesLod2: 0 };
palette.variants.forEach((v, i) => {
  const r = { i, species: params.speciesTable[Math.floor(i / 2)]?._tag?.id };
  for (const k of Object.keys(tot)) { r[k] = tris(v[k] ?? (k === 'leavesMid' ? v.leaves : null)); tot[k] += r[k]; }
  r.midIsFull = v.leavesMid === v.leaves;
  r.leafCards = tris(v.leaves) / 2; r.shadowCards = tris(v.shadow) / 2; r.coarseCards = tris(v.leavesCoarse) / 2;
  r.leafVerts = verts(v.leaves);
  rows.push(r);
});
console.log('variants', palette.variants.length, 'species', palette.speciesCount);
console.table(rows);
console.log('TOTALS (tris across 16 variants)', tot);
const n = palette.variants.length;
console.log('MEAN per variant:', Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, +(v / n).toFixed(1)])));
console.log('rungTriangles (mean tris/instance per rung [L0,L1,L2,L3]):', rungTriangles(palette).map(x => +x.toFixed(1)));
// leaf-only share of each rung
const leafShare = {
  L0: (tot.leaves + tot.shadow) / (tot.branches + tot.leaves + tot.shadow),
  L1: tot.leavesMid / (tot.branchesLod1 + tot.leavesMid),
  L2: tot.leavesCoarse / (tot.branchesLod2 + tot.leavesCoarse),
};
console.log('leaf share of rung triangles:', leafShare);
// card size sample
const sp = params.speciesTable;
console.log('per-species leaf opts:', sp.map(s => ({ id: s._tag.id, size: s.leaves.size, count: s.leaves.count, cell: s.leaves?.atlas?.cell })));
