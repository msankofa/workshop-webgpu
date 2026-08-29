// IK tests. Run with `node test-pokemon-ik.mjs`.
//
// The solver is geometry and is tested as geometry: segment lengths, reachability, the anchor staying put.
// Chain selection is tested against real rigs, because how these skeletons branch is the thing most likely
// to break an assumption -- Onix has no chain longer than one bone, and the root is in no chain at all.

import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import {
  chainUp, selectedReach, fabrik, rotationBetween, segmentRotations, solveError, distance,
  swingTwist, twistAngle, limitTwist, limitRelativeTwist, qmul, qconj,
} from './pokemon-ik.js';

const DIR = 'models/stadium';
const FILES = { squirtle: '007_squirtle.glb', onix: '095_onix.glb', pikachu: '025_pikachu.glb' };
const cache = new Map();
function rigOf(name) {
  if (!cache.has(name)) cache.set(name, readRigFromGLB(fs.readFileSync(`${DIR}/${FILES[name]}`)).rig);
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
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`); }

/** A straight chain of `n` unit segments along +x. */
const straight = (n) => Array.from({ length: n + 1 }, (_, i) => [i, 0, 0]);
const lengthsOf = (p) => p.slice(1).map((v, i) => distance(p[i], v));

console.log('\n--- the solver ---');

check('the end reaches a target inside its range', () => {
  const p = straight(4);                                    // total reach 4
  for (const target of [[2, 1, 0], [0, 3, 1], [-1, -2, 0.5], [3.9, 0, 0]]) {
    const out = fabrik(p, target);
    near(solveError(out, target), 0, 4e-4, `reaching ${target}`);   // 1e-4 of chain length
  }
});

check('close to full extension it converges slowly, and past 99.5% it stops improving', () => {
  // A real property of FABRIK, not a bug and not fixable by iterating more. Recorded so nobody spends an
  // afternoon on it: the residue at 3.999 of 4 is 4e-5 of chain length, which is invisible.
  const p = straight(4);
  const at = (d, iterations) => solveError(fabrik(p, [d, 0, 0], { iterations, tolerance: 1e-12 }), [d, 0, 0]);
  assert(at(3.9, 4) > at(3.9, 64), '97.5% of reach should keep improving with more passes');
  assert(at(3.9, 64) < 1e-4, `97.5% should get there in 64, got ${at(3.9, 64)}`);
  const plateau = at(3.999, 16), longer = at(3.999, 256);
  assert(plateau < 1e-3, `99.98% should still be within a thousandth, got ${plateau}`);
  assert(longer > plateau * 0.5, 'and 16x the passes should not meaningfully improve it');
});

check('every segment keeps its own length', () => {
  const p = [[0, 0, 0], [2, 0, 0], [2, 3, 0], [2, 3, 1]];
  const before = lengthsOf(p);
  const after = lengthsOf(fabrik(p, [1, -2, 2]));
  for (let i = 0; i < before.length; i++) near(after[i], before[i], 1e-6, `segment ${i}`);
});

check('the anchor never moves, because it is what the chain hangs from', () => {
  const p = straight(5);
  for (const target of [[10, 10, 10], [0, 0, 0], [-4, 1, 0]]) {
    const out = fabrik(p, target);
    near(distance(out[0], p[0]), 0, 1e-9, `anchor after reaching for ${target}`);
  }
});

check('out of reach it straightens toward the target rather than refusing', () => {
  const p = straight(3);
  const target = [100, 0, 0];
  const out = fabrik(p, target);
  near(solveError(out, target), 97, 1e-6, 'it gets as far as three units from the anchor');
  const l = lengthsOf(out);
  for (let i = 0; i < l.length; i++) near(l[i], 1, 1e-6, `segment ${i} still one unit`);
  // Straight means each joint is collinear with the anchor and the target.
  for (const q of out) near(q[1], 0, 1e-6, 'no sideways bend when fully extended');
});

check('a target it is already on is left alone', () => {
  const p = straight(4);
  const out = fabrik(p, [4, 0, 0]);
  for (let i = 0; i < p.length; i++) near(distance(out[i], p[i]), 0, 1e-6, `joint ${i}`);
});

check('a chain too short to solve is returned untouched', () => {
  eq(fabrik([], [1, 1, 1]).length, 0, 'nothing');
  const one = fabrik([[3, 3, 3]], [9, 9, 9]);
  eq(one.length, 1, 'a single joint');
  near(distance(one[0], [3, 3, 3]), 0, 1e-12, 'and it does not move, since there is nothing to bend');
});

check('a zero-length segment does not produce NaN', () => {
  // Bone origins in these files are not anatomical, so coincident joints are a real case.
  const out = fabrik([[0, 0, 0], [0, 0, 0], [1, 0, 0]], [0, 1, 0]);
  for (const q of out) for (const v of q) assert(Number.isFinite(v), `got ${v}`);
});

check('it does not mutate the points it was given', () => {
  const p = straight(3);
  const copy = p.map(v => [...v]);
  fabrik(p, [1, 1, 1]);
  for (let i = 0; i < p.length; i++) near(distance(p[i], copy[i]), 0, 1e-12, `joint ${i}`);
});

console.log('\n--- rotations ---');

check('a rotation between two directions actually takes one onto the other', () => {
  const apply = (q, v) => {
    // v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    const u = [q[0], q[1], q[2]], w = q[3];
    const t = [
      u[1] * v[2] - u[2] * v[1] + w * v[0],
      u[2] * v[0] - u[0] * v[2] + w * v[1],
      u[0] * v[1] - u[1] * v[0] + w * v[2],
    ];
    return [
      v[0] + 2 * (u[1] * t[2] - u[2] * t[1]),
      v[1] + 2 * (u[2] * t[0] - u[0] * t[2]),
      v[2] + 2 * (u[0] * t[1] - u[1] * t[0]),
    ];
  };
  for (const [from, to] of [[[1, 0, 0], [0, 1, 0]], [[0, 0, 1], [1, 1, 1]], [[2, 0, 0], [-3, 0, 0]], [[1, 2, 3], [3, 2, 1]]]) {
    const q = rotationBetween(from, to);
    near(Math.hypot(q[0], q[1], q[2], q[3]), 1, 1e-9, `unit quaternion for ${from}->${to}`);
    const got = apply(q, from);
    const n = Math.hypot(...got), m = Math.hypot(...to);
    for (let i = 0; i < 3; i++) near(got[i] / n, to[i] / m, 1e-6, `direction ${i} for ${from}->${to}`);
  }
});

check('the same direction is no rotation, and a degenerate one is not NaN', () => {
  eq(rotationBetween([1, 0, 0], [2, 0, 0]).join(','), '0,0,0,1', 'already aligned');
  for (const q of [rotationBetween([0, 0, 0], [1, 0, 0]), rotationBetween([1, 0, 0], [0, 0, 0])]) {
    for (const v of q) assert(Number.isFinite(v), `got ${v}`);
  }
});

check('one rotation comes back per segment, and none for the end', () => {
  const before = straight(4);
  const after = fabrik(before, [1, 2, 0]);
  eq(segmentRotations(before, after).length, before.length - 1, 'one a segment');
  eq(segmentRotations([[0, 0, 0]], [[0, 0, 0]]).length, 0, 'a single joint has no segment');
});

console.log('\n--- twist ---');

const axisAngle = (a, rad) => {
  const n = Math.hypot(...a), s = Math.sin(rad / 2);
  return [a[0] / n * s, a[1] / n * s, a[2] / n * s, Math.cos(rad / 2)];
};
const deg = (r) => r * 180 / Math.PI;

check('a pure twist about the axis reads as all twist and no swing', () => {
  const axis = [0, 1, 0];
  for (const d of [10, 90, 170, -60]) {
    const q = axisAngle(axis, d * Math.PI / 180);
    near(deg(twistAngle(q, axis)), d, 1e-6, `${d} degrees about the axis`);
    const { swing } = swingTwist(q, axis);
    near(Math.abs(swing[3]), 1, 1e-6, `${d}: swing should be nothing`);
  }
});

check('a pure swing across the axis reads as no twist', () => {
  const axis = [0, 1, 0];
  for (const d of [15, 80, -120]) {
    near(twistAngle(axisAngle([1, 0, 0], d * Math.PI / 180), axis), 0, 1e-6, `${d} degrees across the axis`);
    near(twistAngle(axisAngle([0, 0, 1], d * Math.PI / 180), axis), 0, 1e-6, `${d} degrees across the other way`);
  }
});

check('swing and twist multiply back into what they came from', () => {
  const axis = [0.3, 1, -0.2];
  for (const q of [axisAngle([1, 2, 3], 1.1), axisAngle([-1, 0.5, 2], 2.4), [0, 0, 0, 1]]) {
    const { swing, twist } = swingTwist(q, axis);
    const back = qmul(swing, twist);
    const sign = back[3] * q[3] < 0 ? -1 : 1;      // a quaternion and its negation are one rotation
    for (let i = 0; i < 4; i++) near(back[i] * sign, q[i], 1e-9, `component ${i}`);
  }
});

check('a twist inside the limit is left exactly alone', () => {
  const axis = [0, 0, 1];
  const q = axisAngle(axis, 20 * Math.PI / 180);
  const out = limitTwist(q, axis, 45 * Math.PI / 180);
  for (let i = 0; i < 4; i++) near(out[i], q[i], 1e-12, `component ${i}`);
});

check('a twist past the limit is clamped to it, keeping its direction', () => {
  const axis = [0, 0, 1];
  for (const d of [90, 150, -100]) {
    const out = limitTwist(axisAngle(axis, d * Math.PI / 180), axis, 45 * Math.PI / 180);
    near(Math.abs(deg(twistAngle(out, axis))), 45, 1e-4, `${d} should clamp to 45`);
    assert(Math.sign(twistAngle(out, axis)) === Math.sign(d), `${d} should keep its sign`);
  }
});

check('clamping the twist does not disturb the swing', () => {
  const axis = [0, 1, 0];
  const q = qmul(axisAngle([1, 0, 0], 0.7), axisAngle(axis, 2.0));   // swing then twist
  const out = limitTwist(q, axis, 0.3);
  const a = swingTwist(q, axis).swing, b = swingTwist(out, axis).swing;
  const sign = a[3] * b[3] < 0 ? -1 : 1;
  for (let i = 0; i < 4; i++) near(b[i] * sign, a[i], 1e-6, `swing component ${i}`);
});

check('the limit is measured against the parent, not the world', () => {
  // A whole arm turning as one is not a twisted elbow. Parent and child turned identically must survive
  // any limit at all, including zero.
  const axis = [0, 1, 0];
  const together = axisAngle(axis, 2.5);
  const out = limitRelativeTwist(together, together, axis, 0);
  for (let i = 0; i < 4; i++) near(out[i], together[i], 1e-9, `component ${i}`);
});

check('a child twisting beyond its parent is brought back to the limit', () => {
  const axis = [0, 1, 0];
  const parent = axisAngle(axis, 0.4);
  const child = qmul(parent, axisAngle(axis, 1.5));
  const out = limitRelativeTwist(parent, child, axis, 0.5);
  near(twistAngle(qmul(qconj(parent), out), axis), 0.5, 1e-6, 'relative twist should sit on the limit');
});

check('a degenerate axis limits nothing rather than producing rubbish', () => {
  const q = axisAngle([1, 1, 1], 1.2);
  for (const axis of [[0, 0, 0], [1e-30, 0, 0]]) {
    const out = limitTwist(q, axis, 0.1);
    for (const v of out) assert(Number.isFinite(v), `got ${v}`);
    near(Math.hypot(...out), 1, 1e-9, 'still a unit quaternion');
  }
});

check('every limited rotation is still a unit quaternion', () => {
  const axis = [0.2, -1, 0.4];
  for (let i = 0; i < 40; i++) {
    const q = axisAngle([Math.sin(i), Math.cos(i * 1.7) + 0.1, Math.sin(i * 0.3) - 0.5], (i % 13) * 0.5 - 3);
    const out = limitTwist(q, axis, (i % 7) * 0.4);
    near(Math.hypot(...out), 1, 1e-9, `case ${i}`);
  }
});

console.log('\n--- which bones answer a drag ---');

check('reach counts ancestors, and zero means all of them', () => {
  const rig = rigOf('squirtle');
  const deep = rig.bones.slice().sort((a, b) => depth(rig, b.key) - depth(rig, a.key))[0].key;
  eq(chainUp(rig, deep, 1).length, 2, 'the bone and one ancestor');
  eq(chainUp(rig, deep, 4).length, 5, 'the bone and four');
  const all = chainUp(rig, deep, 0);
  eq(all[0], rig.root, 'reach zero goes to the root');
  eq(all[all.length - 1], deep, 'and the grabbed bone is the end effector');
  // Asking for more ancestors than exist stops at the root rather than running off.
  assert(chainUp(rig, deep, 999).length === all.length, 'past the root it stops');
});

check('the chain comes back root first, in parent order', () => {
  const rig = rigOf('pikachu');
  const deep = rig.bones.slice().sort((a, b) => depth(rig, b.key) - depth(rig, a.key))[0].key;
  const chain = chainUp(rig, deep, 0);
  for (let i = 1; i < chain.length; i++) {
    eq(rig.byKey.get(chain[i]).parent, chain[i - 1], `${chain[i]} should hang from ${chain[i - 1]}`);
  }
});

check('the root has nothing above it, so dragging it bends nothing', () => {
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    eq(chainUp(rig, rig.root, 0).length, 1, `${name}: the root is its own chain`);
    eq(chainUp(rig, rig.root, 5).length, 1, `${name}: and asking for reach does not invent ancestors`);
  }
});

check('a bone the rig does not have gives an empty chain', () => {
  eq(chainUp(rigOf('onix'), 'nosuchbone', 3).length, 0, 'nothing to solve');
});

console.log('\n--- the selection sets the reach ---');

check('a selected run of ancestors becomes the reach', () => {
  const rig = rigOf('squirtle');
  const deep = rig.bones.slice().sort((a, b) => depth(rig, b.key) - depth(rig, a.key))[0].key;
  const up = chainUp(rig, deep, 0);              // root .. deep
  const three = up.slice(-4, -1);                // the three ancestors directly above it
  eq(selectedReach(rig, deep, three), 3, 'three selected ancestors');
  eq(chainUp(rig, deep, 3).length, 4, 'and that is the chain it builds');
});

check('the run has to be unbroken, so a gap stops the count', () => {
  const rig = rigOf('squirtle');
  const deep = rig.bones.slice().sort((a, b) => depth(rig, b.key) - depth(rig, a.key))[0].key;
  const up = chainUp(rig, deep, 0);
  const parent = up[up.length - 2], grandparent = up[up.length - 3], great = up[up.length - 4];
  eq(selectedReach(rig, deep, [parent, great]), 1, 'the gap at the grandparent ends it');
  eq(selectedReach(rig, deep, [parent, grandparent, great]), 3, 'no gap, all three');
});

check('nothing selected above the bone reads as zero, which is the caller falling back', () => {
  const rig = rigOf('squirtle');
  const deep = rig.bones.slice().sort((a, b) => depth(rig, b.key) - depth(rig, a.key))[0].key;
  eq(selectedReach(rig, deep, []), 0, 'no selection');
  eq(selectedReach(rig, deep, [deep]), 0, 'selecting only the grabbed bone says nothing about its chain');
  eq(selectedReach(rig, rig.root, [rig.root]), 0, 'the root has no ancestors to select');
  eq(selectedReach(rig, deep, new Set()), 0, 'a Set works as well as an array');
});

function depth(rig, key) {
  let d = 0, cur = rig.byKey.get(key)?.parent ?? null;
  while (cur) { d++; cur = rig.byKey.get(cur)?.parent ?? null; }
  return d;
}

console.log('\n--- against a real skeleton ---');

check('solving a real chain keeps its bone lengths and reaches the target', () => {
  const rig = rigOf('squirtle');
  const deep = rig.bones.slice().sort((a, b) => depth(rig, b.key) - depth(rig, a.key))[0].key;
  const chain = chainUp(rig, deep, 4);
  const points = chain.map(k => {
    const w = rig.byKey.get(k).restWorld;
    return [w[12], w[13], w[14]];
  });
  const before = lengthsOf(points);
  // Reachable BY CONSTRUCTION: a fifth of the chain's own length from the tip, not of body height. These
  // are small bones, and a target scaled to the body is routinely outside their range.
  // Inside the reachable sphere by construction. A target measured from the TIP is at the edge of it,
  // since the tip already sits about a chain-length from the anchor.
  const reach = before.reduce((a, b) => a + b, 0);
  const tip = points[points.length - 1];
  const anchor = points[0];
  const target = [
    anchor[0] + (tip[0] - anchor[0]) * 0.7 + reach * 0.15,
    anchor[1] + (tip[1] - anchor[1]) * 0.7,
    anchor[2] + (tip[2] - anchor[2]) * 0.7,
  ];
  assert(distance(anchor, target) < reach, 'the test target must be inside the chain, or it proves nothing');
  const after = fabrik(points, target);
  assert(solveError(after, target) < reach * 1e-3, `it should reach: off by ${solveError(after, target)}`);
  const now = lengthsOf(after);
  for (let i = 0; i < before.length; i++) near(now[i], before[i], 1e-6, `bone ${i} changed length`);
  near(distance(after[0], points[0]), 0, 1e-9, 'the anchor stayed put');
});

console.log('\n' + results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
