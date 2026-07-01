import { applyAge } from './tree-age.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

const base = {
  seed: 1, levels: 3,
  length: [15, 11, 7, 3], radius: [1.2, 0.55, 0.3, 0.16],
  leaves: { count: 10, size: 1.3, tint: 0x4f7a3a },
  bark: { color: 0x6b4f2e },
};

const mature = applyAge(base, 1);
ok(mature.levels === base.levels, 'age 1 keeps levels');
ok(JSON.stringify(mature.length) === JSON.stringify(base.length), 'age 1 keeps length values');
ok(JSON.stringify(mature.radius) === JSON.stringify(base.radius), 'age 1 keeps radius values');
ok(mature.leaves.count === base.leaves.count, 'age 1 keeps leaf count');
ok(mature.leaves.size === base.leaves.size, 'age 1 keeps leaf size');

const sapling = applyAge(base, 0);
ok(sapling.length.every((v, i) => v < base.length[i]), 'age 0 shrinks length');
ok(sapling.radius.every((v, i) => v < base.radius[i]), 'age 0 shrinks radius');
ok(sapling.levels < base.levels, 'age 0 reduces levels');
ok(sapling.leaves.count < base.leaves.count, 'age 0 reduces leaf count');
ok(sapling.leaves.size < base.leaves.size, 'age 0 reduces leaf size');

ok(JSON.stringify(applyAge(base, -1)) === JSON.stringify(applyAge(base, 0)), 'age clamps below 0');
ok(JSON.stringify(applyAge(base, 2)) === JSON.stringify(applyAge(base, 1)), 'age clamps above 1');

const mid = applyAge(base, 0.5);
ok(mid.length[0] > sapling.length[0] && mid.length[0] < base.length[0], 'age 0.5 lands strictly between sapling and mature');

ok(base.levels === 3 && base.length[0] === 15 && base.leaves.count === 10, 'does not mutate the input opts');

// levels=0 species: a "sapling" of a trunk-only tree should still just be levels=0, not forced up.
const trunkOnly = { ...base, levels: 0 };
ok(applyAge(trunkOnly, 0).levels === 0, 'age 0 never raises levels above the species\' own level count');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
