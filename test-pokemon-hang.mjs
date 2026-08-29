// Hanging tests. Run with `node test-pokemon-hang.mjs`.
//
// Two halves. The ragdoll half is physics and is checked as physics: things fall, lengths hold, a pinned
// bone stays put. The rotation half is the piece that does not exist anywhere else -- fitting one rotation
// to a bone with several children -- and is checked against rotations it should recover exactly.

import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import { readPose, rootPreMatrix } from './pokemon-pose.js';
import {
  buildHang, pinBone, releaseAll, stepHang, hangPositions, setStiffness, setBend, bendStrain,
  extractRotation, boneRotations, boneOrder, twistAxis,
} from './pokemon-hang.js';
import { twistAngle, swingAngle, qmul, qconj } from './pokemon-ik.js';

const DIR = 'models/stadium';
const FILES = { squirtle: '007_squirtle.glb', onix: '095_onix.glb', pikachu: '025_pikachu.glb' };
const cache = new Map();
function rigOf(name) {
  if (!cache.has(name)) cache.set(name, readRigFromGLB(fs.readFileSync(`${DIR}/${FILES[name]}`)).rig);
  return cache.get(name);
}
const restOf = (rig) => readPose(rig, null, 0, rootPreMatrix(rig));

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: ${a} !== ${b}`); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`); }

/** Every parent-to-child distance, for checking the skeleton has not stretched. */
function boneLengths(rig, xyz) {
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const out = [];
  rig.bones.forEach((b, i) => {
    const p = b.parent != null ? at.get(b.parent) : undefined;
    if (p === undefined) return;
    out.push(Math.hypot(xyz[i * 3] - xyz[p * 3], xyz[i * 3 + 1] - xyz[p * 3 + 1], xyz[i * 3 + 2] - xyz[p * 3 + 2]));
  });
  return out;
}
const run = (hang, seconds, opts) => { for (let t = 0; t < seconds; t += 1 / 60) stepHang(hang, 1 / 60, opts); };

console.log('\n--- building one from a rig ---');

check('a particle a bone, seeded where the bones already are', () => {
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    const rest = restOf(rig);
    const hang = buildHang(rig, rest);
    eq(hang.particles.length, rig.bones.length, `${name}: one particle a bone`);
    hang.particles.forEach((p, i) => {
      near(p.pos.x, rest[i * 3], 1e-12, `${name}: ${p.name} x`);
      near(p.pos.y, rest[i * 3 + 1], 1e-12, `${name}: ${p.name} y`);
    });
  }
});

check('one bone constraint a parent link, plus a brace wherever there is a grandparent', () => {
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig));
  const links = rig.bones.filter(b => b.parent != null).length;
  const rigid = hang.constraints.filter(c => c.stiffness === 1).length;
  eq(rigid, links, 'one rigid constraint a parent link');
  assert(hang.constraints.length > rigid, 'and some braces on top');
  for (const c of hang.constraints) {
    eq(c.min, c.max, 'a length constraint should be exact, not a range');
    assert(c.min >= 0 && Number.isFinite(c.min), `bad rest length ${c.min}`);
  }
});

check('everything is scaled to the body, since the dex runs 9 to 320 units tall', () => {
  const small = buildHang(rigOf('squirtle'), restOf(rigOf('squirtle')));
  const big = buildHang(rigOf('onix'), restOf(rigOf('onix')));
  assert(big.height > small.height * 2, 'Onix should be much taller than Squirtle');
  near(small.particles[0].radius / small.height, big.particles[0].radius / big.height, 1e-12,
    'joint radius must be a fraction of height, not a constant');
});

console.log('\n--- it hangs ---');

check('let go and it falls', () => {
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig));
  const before = hangPositions(hang);
  run(hang, 0.5, { ground: false });
  const after = hangPositions(hang);
  let dropped = 0;
  for (let i = 0; i < rig.bones.length; i++) if (after[i * 3 + 1] < before[i * 3 + 1] - 1e-6) dropped++;
  eq(dropped, rig.bones.length, 'every bone should be lower');
});

check('pinned by one bone, that bone stays exactly where it was put', () => {
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig));
  const i = 5;
  pinBone(hang, i, 1, 2, 3);
  run(hang, 2, { ground: false });
  const now = hangPositions(hang);
  near(now[i * 3], 1, 1e-9, 'pinned x');
  near(now[i * 3 + 1], 2, 1e-9, 'pinned y');
  near(now[i * 3 + 2], 3, 1e-9, 'pinned z');
});

check('hanging from one bone, the rest ends up below it', () => {
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig));
  const top = rig.bones.findIndex(b => b.key === rig.root);
  const rest = restOf(rig);
  pinBone(hang, top, rest[top * 3], rest[top * 3 + 1], rest[top * 3 + 2]);
  run(hang, 4, { ground: false });
  const now = hangPositions(hang);
  let below = 0;
  for (let i = 0; i < rig.bones.length; i++) if (now[i * 3 + 1] <= now[top * 3 + 1] + 1e-6) below++;
  assert(below > rig.bones.length * 0.9, `${below} of ${rig.bones.length} bones hang below the pin`);
});

check('the skeleton does not stretch, however long it swings', () => {
  const rig = rigOf('pikachu');
  const rest = restOf(rig);
  const hang = buildHang(rig, rest);
  const before = boneLengths(rig, rest);
  pinBone(hang, 3, rest[9], rest[10] + rig.units.height, rest[11]);
  run(hang, 6, { ground: false });
  const after = boneLengths(rig, hangPositions(hang));
  for (let i = 0; i < before.length; i++) {
    near(after[i], before[i], Math.max(before[i] * 0.02, rig.units.height * 1e-3), `bone ${i} changed length`);
  }
});

check('it keeps its shape instead of collapsing, which is what the braces are for', () => {
  // Measured as how far the pairwise distances between bones drift from the pose it was seeded in. Vertical
  // extent will not do: a braceless rope hangs LONGER than a stiff body, not shorter, so a taller result
  // would have read as success while the creature folded into a string.
  const rig = rigOf('squirtle');
  const rest = restOf(rig);
  const n = rig.bones.length;
  const spread = (xyz) => {
    let sum = 0, count = 0;
    for (let i = 0; i < n; i += 2) {
      for (let j = i + 1; j < n; j += 3) {
        const a = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]);
        const b = Math.hypot(xyz[i * 3] - xyz[j * 3], xyz[i * 3 + 1] - xyz[j * 3 + 1], xyz[i * 3 + 2] - xyz[j * 3 + 2]);
        sum += Math.abs(a - b); count++;
      }
    }
    return sum / count / rig.units.height;
  };
  const drop = (stiffness) => {
    const h = buildHang(rig, rest, { stiffness });
    pinBone(h, 0, rest[0], rest[1], rest[2]);
    run(h, 5, { ground: false });
    return spread(hangPositions(h));
  };
  const loose = drop(0), stiff = drop(1);
  assert(stiff < loose * 0.9,
    `braces should hold the shape: stiff drifted ${(stiff * 100).toFixed(1)}% of height, loose ${(loose * 100).toFixed(1)}%`);
});

check('it settles instead of swinging for ever', () => {
  // Measured as decay rather than a threshold at a fixed moment. It takes about eight seconds to come to
  // rest, and an earlier version of this check looked at six and called that a failure.
  const rig = rigOf('squirtle');
  const rest = restOf(rig);
  const hang = buildHang(rig, rest);
  pinBone(hang, 0, rest[0], rest[1], rest[2]);
  const window = () => {
    const before = hangPositions(hang);
    run(hang, 1, { ground: false, drag: 0.05 });
    const after = hangPositions(hang);
    let moved = 0;
    for (let i = 0; i < after.length; i++) moved = Math.max(moved, Math.abs(after[i] - before[i]));
    return moved / rig.units.height;
  };
  const early = window();
  let last = early;
  for (let s = 0; s < 11; s++) last = window();
  assert(early > 0.1, `it should swing at first, got ${(early * 100).toFixed(1)}%`);
  assert(last < early / 100, `and stop: first second ${(early * 100).toFixed(1)}%, twelfth ${(last * 100).toFixed(2)}%`);
  assert(last < 0.005, `still moving ${(last * 100).toFixed(2)}% of height a second`);
});

check('the ground stops it, and turning the ground off lets it through', () => {
  const rig = rigOf('squirtle');
  const rest = restOf(rig);
  const floor = rig.units.floorY;
  const withGround = buildHang(rig, rest);
  run(withGround, 3, { ground: true });
  const on = hangPositions(withGround);
  for (let i = 0; i < rig.bones.length; i++) {
    assert(on[i * 3 + 1] > floor - rig.units.height * 0.05, `bone ${i} fell through the floor`);
  }
  const without = buildHang(rig, rest);
  run(without, 3, { ground: false });
  const off = hangPositions(without);
  let under = 0;
  for (let i = 0; i < rig.bones.length; i++) if (off[i * 3 + 1] < floor) under++;
  assert(under > 0, 'with no ground it should keep going');
});

check('stiffness is live, and releasing gives every bone its weight back', () => {
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig), { stiffness: 0.4 });
  setStiffness(hang, 0.9);
  for (const c of hang.constraints) assert(c.stiffness === 1 || c.stiffness === 0.9, `stray stiffness ${c.stiffness}`);
  assert(hang.constraints.some(c => c.stiffness === 1), 'bone constraints must not be swept up by the slider');
  pinBone(hang, 2, 0, 0, 0);
  releaseAll(hang);
  for (const p of hang.particles) { assert(!p.pinned, 'nothing pinned'); eq(p.invMass, 1, 'mass back'); }
});

console.log('\n--- particles back to rotations ---');

/** Turn a vector by a quaternion. */
function turn(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
const axisAngle = (a, deg) => {
  const r = deg * Math.PI / 180, s = Math.sin(r / 2), n = Math.hypot(...a);
  return [a[0] / n * s, a[1] / n * s, a[2] / n * s, Math.cos(r / 2)];
};

check('a matrix that is already a rotation comes back as itself', () => {
  for (const [axis, deg] of [[[0, 1, 0], 40], [[1, 0, 0], -75], [[1, 1, 1], 120], [[0, 0, 1], 179]]) {
    const q = axisAngle(axis, deg);
    // Columns of the rotation matrix are the turned basis vectors.
    const m = [turn(q, [1, 0, 0]), turn(q, [0, 1, 0]), turn(q, [0, 0, 1])];
    const got = extractRotation(m);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.7, 0.2]]) {
      const want = turn(q, v), had = turn(got, v);
      for (let i = 0; i < 3; i++) near(had[i], want[i], 1e-6, `${axis}@${deg} on ${v}`);
    }
  }
});

check('identity in, identity out', () => {
  const q = extractRotation([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  for (const v of [[1, 2, 3], [0, -1, 0]]) {
    const had = turn(q, v);
    for (let i = 0; i < 3; i++) near(had[i], v[i], 1e-9, 'unchanged');
  }
});

check('a branching bone is aimed so its children land where the simulation put them', () => {
  // NOT that it recovers the original rotation. Two children fix everything except the twist about the axis
  // perpendicular to both, so a whole family of rotations is equally correct and the fit returns one of
  // them. What it must do is put the children where they went, which is what the mesh reads.
  const rig = rigOf('squirtle');
  const seed = restOf(rig);
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const i = rig.bones.findIndex(b => (b.children || []).length >= 2);
  assert(i >= 0, 'expected a branching bone');

  const q = axisAngle([0.2, 1, 0.1], 35);
  const now = Float64Array.from(seed);
  const kids = rig.bones[i].children.map(k => at.get(k));
  for (const k of kids) {
    const d = [seed[k * 3] - seed[i * 3], seed[k * 3 + 1] - seed[i * 3 + 1], seed[k * 3 + 2] - seed[i * 3 + 2]];
    const t = turn(q, d);
    now[k * 3] = seed[i * 3] + t[0];
    now[k * 3 + 1] = seed[i * 3 + 1] + t[1];
    now[k * 3 + 2] = seed[i * 3 + 2] + t[2];
  }
  const got = boneRotations(rig, seed, now)[i];
  for (const k of kids) {
    const a = [seed[k * 3] - seed[i * 3], seed[k * 3 + 1] - seed[i * 3 + 1], seed[k * 3 + 2] - seed[i * 3 + 2]];
    const want = [now[k * 3] - now[i * 3], now[k * 3 + 1] - now[i * 3 + 1], now[k * 3 + 2] - now[i * 3 + 2]];
    const had = turn(got, a);
    const scale = Math.max(Math.hypot(...want), rig.units.height * 1e-3);
    for (let c = 0; c < 3; c++) near(had[c] / scale, want[c] / scale, 1e-4, `child ${k} axis ${c}`);
  }
});

check('a bone with one child leaves its own twist free, and says so by not inventing one', () => {
  // A single direction cannot determine a rotation. Turning the bone about its own length moves nothing, so
  // any answer in that family is a minimiser; what must not happen is a large arbitrary twist appearing.
  const rig = rigOf('squirtle');
  const seed = restOf(rig);
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const i = rig.bones.findIndex(b => (b.children || []).length === 1 && b.parent != null);
  assert(i >= 0, 'expected a single-child bone');
  const k = at.get(rig.bones[i].children[0]);

  const q = axisAngle([0, 0, 1], 25);
  const now = Float64Array.from(seed);
  const d = [seed[k * 3] - seed[i * 3], seed[k * 3 + 1] - seed[i * 3 + 1], seed[k * 3 + 2] - seed[i * 3 + 2]];
  const t = turn(q, d);
  now[k * 3] = seed[i * 3] + t[0];
  now[k * 3 + 1] = seed[i * 3 + 1] + t[1];
  now[k * 3 + 2] = seed[i * 3 + 2] + t[2];

  const got = boneRotations(rig, seed, now)[i];
  const had = turn(got, d);
  const scale = Math.max(Math.hypot(...t), rig.units.height * 1e-3);
  for (let c = 0; c < 3; c++) near(had[c] / scale, t[c] / scale, 1e-3, `the one child must still land, axis ${c}`);
});

check('a leaf takes its parent rotation, since nothing below it says otherwise', () => {
  const rig = rigOf('squirtle');
  const seed = restOf(rig);
  const now = Float64Array.from(seed);
  now[3] += rig.units.height * 0.1;              // move one bone so the answer is not all identity
  const rots = boneRotations(rig, seed, now);
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  let checked = 0;
  rig.bones.forEach((b, i) => {
    if ((b.children || []).length || b.parent == null) return;
    const p = at.get(b.parent);
    for (let c = 0; c < 4; c++) near(rots[i][c], rots[p][c], 1e-12, `leaf ${b.key} should match ${b.parent}`);
    checked++;
  });
  assert(checked > 0, 'no leaves to check');
});

check('one rotation a bone, all of them unit quaternions, on three species', () => {
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    const seed = restOf(rig);
    const hang = buildHang(rig, seed);
    pinBone(hang, 0, seed[0], seed[1] + rig.units.height * 0.5, seed[2]);
    run(hang, 1.5, { ground: false });
    const rots = boneRotations(rig, seed, hangPositions(hang));
    eq(rots.length, rig.bones.length, `${name}: one a bone`);
    for (const q of rots) {
      assert(q && q.length === 4, `${name}: missing rotation`);
      near(Math.hypot(...q), 1, 1e-6, `${name}: not a unit quaternion`);
      for (const v of q) assert(Number.isFinite(v), `${name}: got ${v}`);
    }
  }
});

check('a twist axis is the way the bone points, and is never a stray direction', () => {
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    const seed = restOf(rig);
    const at = new Map(rig.bones.map((b, i) => [b.key, i]));
    rig.bones.forEach((b, i) => {
      const a = twistAxis(rig, seed, i, at);
      for (const v of a) assert(Number.isFinite(v), `${name}: ${b.key} axis ${v}`);
      const kids = (b.children || []).map(k => at.get(k)).filter(k => k !== undefined);
      // A bone with one child must point at it. More than one, or none, has no single answer to check.
      if (kids.length !== 1) return;
      const k = kids[0];
      const want = [seed[k * 3] - seed[i * 3], seed[k * 3 + 1] - seed[i * 3 + 1], seed[k * 3 + 2] - seed[i * 3 + 2]];
      const lw = Math.hypot(...want), la = Math.hypot(...a);
      if (lw < 1e-9 || la < 1e-9) return;
      for (let c = 0; c < 3; c++) near(a[c] / la, want[c] / lw, 1e-9, `${name}: ${b.key} should point at its child`);
    });
  }
});

check('no bone twists past the limit, whatever the simulation does to it', () => {
  const rig = rigOf('squirtle');
  const seed = restOf(rig);
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const hang = buildHang(rig, seed);
  // Held by the head and swung hard, which is what makes a chain wring itself out.
  pinBone(hang, 0, seed[0] + rig.units.height, seed[1] + rig.units.height, seed[2]);
  run(hang, 3, { ground: false });
  const now = hangPositions(hang);

  const max = 30 * Math.PI / 180;
  const limited = boneRotations(rig, seed, now, { maxTwist: max });
  let worst = 0, worstFree = 0;
  const free = boneRotations(rig, seed, now, { maxTwist: Math.PI });
  rig.bones.forEach((b, i) => {
    const p = b.parent != null ? at.get(b.parent) : undefined;
    if (p === undefined) return;
    const axis = twistAxis(rig, seed, i, at);
    if (Math.hypot(...axis) < 1e-9) return;
    worst = Math.max(worst, Math.abs(twistAngle(qmul(qconj(limited[p]), limited[i]), axis)));
    worstFree = Math.max(worstFree, Math.abs(twistAngle(qmul(qconj(free[p]), free[i]), axis)));
  });
  assert(worst <= max + 1e-4, `a bone twisted ${(worst * 180 / Math.PI).toFixed(1)} degrees past a 30 degree limit`);
  assert(worstFree > max, `unlimited it only reached ${(worstFree * 180 / Math.PI).toFixed(1)} degrees, so the test proves nothing`);
});

console.log('\n--- the bend limit ---');

check('no bone is DRAWN bent past the limit, whatever the simulation does to it', () => {
  // The exact half of the limit. The simulation below is a pull rather than a wall, but what is handed to
  // the mesh is clamped outright, so this is what a person actually sees.
  const rig = rigOf('squirtle');
  const seed = restOf(rig);
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const hang = buildHang(rig, seed, { maxBend: Math.PI });      // limit OFF in the physics on purpose
  pinBone(hang, 0, seed[0] + rig.units.height, seed[1] + rig.units.height, seed[2]);
  run(hang, 3, { ground: false });
  const now = hangPositions(hang);

  const max = 25 * Math.PI / 180;
  const limited = boneRotations(rig, seed, now, { maxBend: max });
  const free = boneRotations(rig, seed, now, {});
  let worst = 0, worstFree = 0;
  rig.bones.forEach((b, i) => {
    const p = b.parent != null ? at.get(b.parent) : undefined;
    if (p === undefined) return;
    const axis = twistAxis(rig, seed, i, at);
    worst = Math.max(worst, swingAngle(qmul(qconj(limited[p]), limited[i]), axis));
    worstFree = Math.max(worstFree, swingAngle(qmul(qconj(free[p]), free[i]), axis));
  });
  assert(worst <= max + 1e-4, `a bone was drawn ${(worst * 180 / Math.PI).toFixed(1)} degrees past a 25 degree limit`);
  assert(worstFree > max, `unlimited it only reached ${(worstFree * 180 / Math.PI).toFixed(1)} degrees, so the test proves nothing`);
});

check('a cone is never built on a bone with no length, on any of the three rigs', () => {
  // The bug this pins down cost a whole measuring pass. Pikachu has a bone 0.001 units long on a 22-unit
  // body; a cone built on it reports wild angles that are pure direction noise, and the numbers blamed the
  // solver for violations that were never real. The threshold has to be relative -- the dex is 9 to 320
  // units tall -- so an absolute epsilon would pass here and fail on something small.
  for (const name of ['squirtle', 'onix', 'pikachu']) {
    const rig = rigOf(name);
    const seed = restOf(rig);
    const hang = buildHang(rig, seed, { maxBend: 1 });
    const span = (i, j) => Math.hypot(seed[i * 3] - seed[j * 3], seed[i * 3 + 1] - seed[j * 3 + 1], seed[i * 3 + 2] - seed[j * 3 + 2]);
    assert(hang.limits.cones.length > 0, `${name}: no cones at all`);
    for (const c of hang.limits.cones) {
      const a = span(c.root, c.pivot), b = span(c.pivot, c.child);
      assert(Math.min(a, b) > rig.units.height * 1e-3,
        `${name}: a cone on bones ${a.toFixed(4)} and ${b.toFixed(4)} long, body height ${rig.units.height.toFixed(1)}`);
    }
  }
});

check('the bend limit brings a swung body back inside itself once it settles', () => {
  // The physics half, and it is a PULL: during a hard swing joints do pass the limit. What is claimed here
  // is only what was measured -- that letting go and waiting brings them back.
  const rig = rigOf('squirtle');
  const seed = restOf(rig);
  const max = 20 * Math.PI / 180;
  const swing = (hang) => {
    const R = rig.units.height * 0.5;
    for (let k = 0; k < 180; k++) {
      pinBone(hang, 1, seed[3] + Math.cos(k * 0.06) * R - R, seed[4] + Math.sin(k * 0.06) * R, seed[5]);
      stepHang(hang, 1 / 60, { ground: false });
    }
    for (let k = 0; k < 360; k++) stepHang(hang, 1 / 60, { ground: false });
  };
  const limited = buildHang(rig, seed, { maxBend: max });
  const free = buildHang(rig, seed, { maxBend: Math.PI });
  swing(limited); swing(free);
  const a = bendStrain(limited), b = bendStrain(free);
  assert(b[0] > max, `unlimited it only bent ${(b[0] * 180 / Math.PI).toFixed(1)} degrees, so the test proves nothing`);
  assert(a[0] < b[0], `limited ${(a[0] * 180 / Math.PI).toFixed(1)} vs free ${(b[0] * 180 / Math.PI).toFixed(1)} degrees`);
  const over = a.filter(v => v > max + 1e-3).length;
  assert(over <= 2, `${over} of ${a.length} joints settled outside the limit`);
});

check('the limit is live, so the slider does not need the body rebuilt', () => {
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig), { maxBend: Math.PI });
  assert(!hang.limits.enabled, 'no limit means the solver should not even run the pass');
  setBend(hang, 0.5);
  assert(hang.limits.enabled, 'setting a limit must turn the pass on');
  for (const c of hang.limits.cones) {
    assert(c.max - c.min <= 1.0 + 1e-9, 'the band should be the limit either side of where it started');
    assert(c.min <= c.rest && c.rest <= c.max, 'the pose it was seeded in must be inside its own limit');
  }
  setBend(hang, Math.PI);
  assert(!hang.limits.enabled, 'putting it back to pi must turn the pass off again');
});

check('stiffness stays adjustable after being set to one', () => {
  // Braces used to be found by having a stiffness under 1, so setting the slider to exactly 1 made them
  // indistinguishable from bone links and they never moved again.
  const rig = rigOf('squirtle');
  const hang = buildHang(rig, restOf(rig), { stiffness: 0.4 });
  const braces = hang.constraints.filter(c => c.kind === 'brace');
  assert(braces.length > 0, 'no braces to test');
  setStiffness(hang, 1);
  assert(braces.every(c => c.stiffness === 1), 'the slider did not reach them');
  setStiffness(hang, 0.3);
  assert(braces.every(c => c.stiffness === 0.3), 'they got stuck at one');
  assert(hang.constraints.every(c => c.kind === 'brace' || c.stiffness === 1), 'bone links must stay rigid');
});

check('the limit off is the same answer as no limit', () => {
  const rig = rigOf('pikachu');
  const seed = restOf(rig);
  const hang = buildHang(rig, seed);
  pinBone(hang, 2, seed[6], seed[7] + rig.units.height * 0.4, seed[8]);
  run(hang, 1, { ground: false });
  const now = hangPositions(hang);
  const a = boneRotations(rig, seed, now);                       // default is pi
  const b = boneRotations(rig, seed, now, { maxTwist: Math.PI });
  a.forEach((q, i) => q.forEach((v, c) => near(v, b[i][c], 1e-12, `bone ${i} component ${c}`)));
});

check('bone order puts every parent before its child, which rig.bones does not promise', () => {
  // rig.bones is sorted by glTF node index -- whatever the exporter wrote. Anything that settles a bone
  // against its parent has to walk boneOrder instead, or it reads a parent that has not moved yet.
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    const order = boneOrder(rig);
    eq(order.length, rig.bones.length, `${name}: every bone appears`);
    eq(new Set(order).size, rig.bones.length, `${name}: and only once`);
    const at = new Map(rig.bones.map((b, i) => [b.key, i]));
    const seen = new Set();
    for (const i of order) {
      const p = rig.bones[i].parent;
      if (p != null) assert(seen.has(at.get(p)), `${name}: ${rig.bones[i].key} came before its parent ${p}`);
      seen.add(i);
    }
    eq(rig.bones[order[0]].key, rig.root, `${name}: the root comes first`);
  }
});

check('a pose that did not move produces no rotation at all', () => {
  const rig = rigOf('pikachu');
  const seed = restOf(rig);
  for (const q of boneRotations(rig, seed, Float64Array.from(seed))) {
    near(Math.abs(q[3]), 1, 1e-9, 'w should be 1 for no rotation');
    for (let i = 0; i < 3; i++) near(q[i], 0, 1e-9, 'and the axis part zero');
  }
});

console.log('\n' + results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
