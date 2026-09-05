// test-tree-lod-preview.mjs -- the LOD preview's tiers must be the palette's own bake, laid out where asked.
// Billboards need a renderer, so this covers the three geometry tiers only.
import * as THREE from 'three';
import { createTree } from './trees.js';
import { createForestPalette } from './forest-palette.js';
import { createLodPreview, HOST_PRESETS } from './tree-lod-preview.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const base = createTree({ seed: 11 });
const opts = structuredClone(base.options);
base.dispose();

const scene = new THREE.Scene();
const preview = createLodPreview({ renderer: null, scene, createTree });
const host = HOST_PRESETS['base game'];
const stats = await preview.build({ opts, texSet: null, n: 3, layout: 'rings', params: { ...host, billboards: false } });

ok(stats.length === 3, 'three tiers without billboards');
ok(stats.map(s => s.distance).join() === host.rings.join(), 'rings layout puts tier k at rings[k]');
ok(stats[0].tris > stats[1].tris && stats[1].tris > stats[2].tris, `tiers get cheaper: ${stats.map(s => s.tris).join(' > ')}`);
ok(stats[2].leaves < stats[1].leaves, 'coarse leaves are fewer');

// Same bake the game would do
const palette = createForestPalette({
  createTree, masterSeed: opts.seed >>> 0, variantsPerSpecies: 3, texSet: null,
  params: { speciesTable: [{ ...opts }], leafShadowPct: 0.3, branchLods: host.branchLods,
    coarseLeafRatio: host.coarseLeafRatio, coarseLeafSizeMult: host.coarseLeafSizeMult },
});
const gameL1 = palette.variants.reduce((a, v) => a + v.branchesLod1.index.count / 3 + v.leaves.index.count / 3, 0);
ok(stats[1].tris === gameL1, 'LOD1 triangle count matches forest-palette exactly');

const groups = scene.children[0].children;
ok(groups.length === 3 && groups.every(g => g.children.length > 0), 'each tier group holds meshes');
ok(groups[0].children.length === 9, 'LOD0 has branches + leaves + shadow per variant');

const side = await preview.build({ opts, texSet: null, n: 2, layout: 'side', distance: 42, params: { ...host, billboards: false } });
ok(side.every(s => s.distance === 42), 'side layout puts every tier at the compare distance');
const xs = scene.children[0].children.map(g => g.position.x);
ok(new Set(xs).size === 3, 'side layout spreads tiers along X');

const fill = await preview.build({ opts, texSet: null, n: 2, layout: 'fill', density: 60, params: { ...host, billboards: false } });
const fillTrees = fill.reduce((a, s) => a + s.count, 0);
ok(fillTrees > 100, `fill lays out a forest (${fillTrees} trees)`);
ok(fill[0].count < fill[1].count && fill[1].count < fill[2].count, 'outer rings hold more trees than inner ones');
ok(scene.children[0].children.every(o => o.isInstancedMesh), 'fill draws instanced meshes only');

preview.dispose();
ok(scene.children[0].children.length === 0, 'dispose empties the root but keeps it in the scene');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
