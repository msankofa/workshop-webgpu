// test-trees-integer-params.mjs -- a fractional children/sections/segments count must not break the tree.
// tree-viewer.html's Mutate wrote floats into these; children 6.37 made _shuffledSlots index arr[5.37]
// and left most slots undefined, so 86% of the vertex positions came out NaN. trees.js now rounds.
import * as THREE from 'three';
import { createTree } from './trees.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

function nanCount(tree) {
  let n = 0, total = 0;
  tree.traverse(o => {
    const a = o.isMesh && o.geometry.getAttribute('position');
    if (!a) return;
    for (let i = 0; i < a.array.length; i++) { total++; if (Number.isNaN(a.array[i])) n++; }
  });
  return { n, total };
}
function vertexCount(tree) { return nanCount(tree).total; }

const base = createTree({ seed: 7 });
const o = structuredClone(base.options);
base.dispose();

const clean = createTree(o);
ok(nanCount(clean).n === 0, 'integer defaults produce no NaN');

const frac = createTree({ ...o, children: [6.37, 3.2, 2.9, 1.1] });
const r = nanCount(frac);
ok(r.total > 0 && r.n === 0, `fractional children produce no NaN (got ${r.n}/${r.total})`);

const rounded = createTree({ ...o, children: [6, 3, 3, 1] });
ok(vertexCount(frac) === vertexCount(rounded), 'fractional children round to the nearest whole tree');

const fracRings = createTree({ ...o, sections: [10.4, 8.6, 6, 4], segments: [8.4, 6, 5, 4] });
const intRings = createTree({ ...o, sections: [10, 9, 6, 4], segments: [8, 6, 5, 4] });
ok(nanCount(fracRings).n === 0, 'fractional sections/segments produce no NaN');
ok(vertexCount(fracRings) === vertexCount(intRings), 'fractional sections/segments round to whole rings');

const tiny = createTree({ ...o, segments: [1, 1, 1, 1], sections: [0.2, 0, 0, 0] });
ok(nanCount(tiny).n === 0 && vertexCount(tiny) > 0, 'segments below 3 and sections below 1 are lifted, not zeroed');

for (const t of [clean, frac, rounded, fracRings, intRings, tiny]) t.dispose();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
