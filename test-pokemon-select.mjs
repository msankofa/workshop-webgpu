// Bone and chain selection tests. Run with `node test-pokemon-select.mjs`.
//
// Against real rigs, because the thing most likely to be wrong is an assumption about how these skeletons
// are shaped -- chains that partition cleanly, bones that have exactly one parent -- and a fixture built
// from that assumption would agree with it.

import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import { toggleBones, addAppendage, emptyAnnotation } from './pokemon-annotation.js';
import {
  toggleKeys, chainContaining, chainKeysOf, chainCoverage, selectionInfo, orderSelection,
  isUnbrokenRun, nearestPoint,
} from './pokemon-select.js';

const DIR = 'models/stadium';
const FILES = {
  squirtle: '007_squirtle.glb', pikachu: '025_pikachu.glb', sandslash: '028_sandslash.glb',
  onix: '095_onix.glb', voltorb: '100_voltorb.glb', caterpie: '010_caterpie.glb',
};

const cache = new Map();
function rigOf(name) {
  if (!cache.has(name)) cache.set(name, readRigFromGLB(fs.readFileSync(`${DIR}/${FILES[name]}`), { source: FILES[name] }).rig);
  return cache.get(name);
}

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: ${a} !== ${b}`); }
const keys = (set) => [...set].sort().join(',');
/** The longest chain a species has. Not every species has a long one -- see the chain-length check. */
const longestChain = (rig) => rig.chains.slice().sort((a, b) => b.bones.length - a.bones.length)[0];

console.log('\n--- the one primitive behind both gestures ---');

check('toggling an absent key adds it, and a present one removes it', () => {
  eq(keys(toggleKeys(new Set(), 'a')), 'a', 'add');
  eq(keys(toggleKeys(new Set(['a']), 'a')), '', 'remove');
});

check('a partly selected group is COMPLETED, not flipped key by key', () => {
  // This is what a person means by clicking a chain they have already started one bone of.
  const out = toggleKeys(new Set(['a']), ['a', 'b', 'c']);
  eq(keys(out), 'a,b,c', 'the rest should join, not a leave');
});

check('a wholly selected group is removed', () => {
  eq(keys(toggleKeys(new Set(['a', 'b', 'c']), ['a', 'b', 'c'])), '', 'all present means take them away');
});

check('force overrides the decision in both directions', () => {
  eq(keys(toggleKeys(new Set(['a']), ['a', 'b'], true)), 'a,b', 'forced on');
  eq(keys(toggleKeys(new Set(['a', 'b']), ['a', 'b'], false)), '', 'forced off');
  eq(keys(toggleKeys(new Set(['a']), ['a', 'b'], false)), '', 'forced off removes what is there');
});

check('toggling never mutates the set it was given', () => {
  const before = new Set(['a']);
  toggleKeys(before, ['b', 'c']);
  eq(keys(before), 'a', 'the original should be untouched');
});

check('it agrees with toggleBones, so a selection becomes a part unchanged', () => {
  // The two gestures must mean the same thing before and after a selection is named.
  const rig = rigOf('squirtle');
  const chain = rig.chains.find(c => c.bones.length >= 3);
  let a = addAppendage(emptyAnnotation('squirtle', rig), rig, { type: 'leg', side: 'L' });
  const id = a.parts.appendages[0].id;

  a = toggleBones(a, rig, id, [chain.bones[0]]);
  const selectionA = toggleKeys(new Set(), [chain.bones[0]]);
  eq(a.parts.appendages[0].chain.join(','), orderSelection(rig, selectionA).join(','), 'after one bone');

  a = toggleBones(a, rig, id, chain.bones);
  const selectionB = toggleKeys(selectionA, chain.bones);
  eq(a.parts.appendages[0].chain.join(','), orderSelection(rig, selectionB).join(','), 'after completing the chain');

  a = toggleBones(a, rig, id, chain.bones);
  const selectionC = toggleKeys(selectionB, chain.bones);
  eq(a.parts.appendages[0].chain.join(','), orderSelection(rig, selectionC).join(','), 'after removing it again');
  eq(selectionC.size, 0, 'and both are empty');
});

console.log('\n--- chains ---');

check('every non-root bone is in exactly one chain, and the root is in none', () => {
  // Measured dex-wide: 151 bones belong to no chain and every one of them is a root. extractChains splits
  // at branch points and the root is one, so it is an attachment rather than a link.
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    for (const bone of rig.bones) {
      const found = rig.chains.filter(c => c.bones.includes(bone.key));
      if (bone.key === rig.root) eq(found.length, 0, `${name}: the root is in ${found.length} chains`);
      else eq(found.length, 1, `${name}: ${bone.key} is in ${found.length} chains`);
    }
  }
});

check('clicking the chain of a root selects the root alone rather than nothing', () => {
  // Every species has this case, so a fallback rather than an assertion.
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    eq(chainContaining(rig, rig.root), null, `${name}: the root should have no chain`);
    eq(chainKeysOf(rig, rig.root).join(','), rig.root, `${name}: the chain gesture should still select it`);
  }
});

check('a bone that is not in the rig has no chain and selects nothing', () => {
  const rig = rigOf('voltorb');
  eq(chainContaining(rig, 'nosuchbone'), null, 'no chain');
  eq(chainKeysOf(rig, 'nosuchbone').length, 0, 'no keys either');
});

check('chain coverage separates whole from partial', () => {
  const rig = rigOf('squirtle');
  const chain = rig.chains.find(c => c.bones.length >= 3);
  const whole = chainCoverage(rig, chain.bones);
  assert(whole.whole.includes(chain.id), 'a fully selected chain is whole');
  eq(whole.partial.length, 0, 'and not also partial');
  const part = chainCoverage(rig, chain.bones.slice(0, 1));
  assert(part.partial.includes(chain.id), 'one bone of it is partial');
  eq(part.whole.length, 0, 'and not whole');
  eq(chainCoverage(rig, []).whole.length + chainCoverage(rig, []).partial.length, 0, 'nothing selected, nothing reported');
});

console.log('\n--- what the panel reads ---');

check('the chain gesture buys much less on some species than the plan assumed', () => {
  // Measured dex-wide: 2,136 of 3,496 chains are a SINGLE bone, and the median chain length is 1. Onix is
  // 40 bones in 39 chains, so clicking chains there is clicking bones. Pinned because the two-gesture bet
  // rests on chains being worth clicking, and for a third of the dex they are barely cheaper.
  const onix = rigOf('onix');
  eq(longestChain(onix).bones.length, 1, 'Onix has no chain longer than one bone');
  assert(onix.chains.length >= onix.bones.length - 1, 'Onix is one chain per bone but for the root');
  const squirtle = rigOf('squirtle');
  assert(longestChain(squirtle).bones.length >= 5, 'Squirtle does have chains worth clicking');
});

check('a selection is ordered root to tip whatever order it was clicked in', () => {
  const rig = rigOf('squirtle');
  const chain = longestChain(rig);
  assert(chain.bones.length >= 4, `need a chain of 4+, got ${chain.bones.length}`);
  const forwards = selectionInfo(rig, chain.bones).bones;
  const backwards = selectionInfo(rig, [...chain.bones].reverse()).bones;
  // Every bone, in an order nobody would click them in.
  const mixed = chain.bones.filter((_, i) => i % 2).concat(chain.bones.filter((_, i) => !(i % 2)));
  assert(mixed.length === chain.bones.length, 'the shuffle must keep every bone');
  assert(mixed.join(',') !== chain.bones.join(','), 'and must actually reorder them');
  const shuffled = selectionInfo(rig, mixed).bones;
  eq(forwards.join(','), backwards.join(','), 'reversed clicks');
  eq(forwards.join(','), shuffled.join(','), 'shuffled clicks');
  eq(forwards.join(','), chain.bones.join(','), 'and it is the chain order');
});

check('mass fraction says whether a selection is a limb or a decoration', () => {
  const rig = rigOf('sandslash');
  const all = selectionInfo(rig, rig.bones.map(b => b.key));
  assert(Math.abs(all.massFraction - 1) < 1e-9, `selecting everything should be the whole mesh, got ${all.massFraction}`);
  eq(selectionInfo(rig, []).massFraction, 0, 'nothing selected carries nothing');

  const big = rig.chains.slice().sort((a, b) => b.massFraction - a.massFraction)[0];
  const small = rig.chains.slice().sort((a, b) => a.massFraction - b.massFraction)[0];
  assert(selectionInfo(rig, big.bones).massFraction > selectionInfo(rig, small.bones).massFraction,
    'the heaviest chain should read heavier than the lightest');
});

check('unknown bones are dropped rather than counted', () => {
  const rig = rigOf('voltorb');
  const info = selectionInfo(rig, [rig.bones[0].key, 'nosuchbone']);
  eq(info.count, 1, 'only the real one');
  assert(!info.bones.includes('nosuchbone'), 'and it is not in the list');
});

check('an unbroken run is reported, and a gap in one is not', () => {
  const rig = rigOf('caterpie');
  const chain = longestChain(rig);
  assert(chain.bones.length >= 3, `need a chain of 3+, got ${chain.bones.length}`);
  assert(isUnbrokenRun(rig, chain.bones), 'a whole chain is a run');
  assert(!isUnbrokenRun(rig, [chain.bones[0], chain.bones[2]]), 'skipping a bone breaks it');
  assert(!isUnbrokenRun(rig, []), 'nothing is not a run');
  assert(selectionInfo(rig, chain.bones).unbroken, 'and the panel reads it');
});

check('a selection does not have to be a chain, and saying so is not an error', () => {
  // Two ears are one part and two runs. `unbroken` is a hint, never a rule.
  const rig = rigOf('pikachu');
  const [a, b] = rig.chains.filter(c => c.bones.length >= 2).slice(0, 2);
  const info = selectionInfo(rig, [...a.bones, ...b.bones]);
  eq(info.count, a.bones.length + b.bones.length, 'both chains are kept');
  assert(!info.unbroken, 'two chains are not one run');
  eq(info.chains.whole.length, 2, 'and both read as whole chains');
});

console.log('\n--- picking ---');

check('the nearest joint within the radius is picked, and nothing outside it', () => {
  const pts = [{ x: 0, y: 0, depth: 1 }, { x: 30, y: 0, depth: 1 }, { x: 100, y: 100, depth: 1 }];
  eq(nearestPoint(pts, 2, 2, 14), 0, 'right next to the first');
  eq(nearestPoint(pts, 28, 1, 14), 1, 'right next to the second');
  eq(nearestPoint(pts, 60, 60, 14), -1, 'near nothing');
  eq(nearestPoint([], 0, 0, 14), -1, 'no points at all');
});

check('where two joints overlap, the one in front is picked', () => {
  const pts = [{ x: 10, y: 10, depth: 9 }, { x: 10, y: 10, depth: 2 }];
  eq(nearestPoint(pts, 10, 10, 14), 1, 'the nearer to the camera');
  eq(nearestPoint([{ x: 10, y: 10, depth: 2 }, { x: 10, y: 10, depth: 9 }], 10, 10, 14), 0, 'whichever order they come in');
});

check('a joint behind the camera is not pickable', () => {
  const pts = [{ x: 5, y: 5, depth: 1, hidden: true }, { x: 40, y: 40, depth: 1 }];
  eq(nearestPoint(pts, 5, 5, 14), -1, 'hidden is skipped even when it is nearest');
  eq(nearestPoint(pts, 40, 40, 14), 1, 'the visible one still picks');
});

check('a clearly nearer joint beats a deeper one that is further away', () => {
  // Depth only breaks ties. A joint 1px away should win over one 13px away that happens to be in front.
  const pts = [{ x: 0, y: 0, depth: 50 }, { x: 13, y: 0, depth: 1 }];
  eq(nearestPoint(pts, 0, 0, 14), 0, 'distance decides first');
});

console.log('\n' + results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
