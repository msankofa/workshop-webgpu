// Pose distance tests. Run with `node test-pokemon-pose.mjs`.
//
// Built against real rigs. The alignment tests are the point of the file: a metric that does not align
// orientation returns a large number for a pose that is merely facing elsewhere, and that wrong number
// looks exactly like a right one, so it has to be pinned rather than eyeballed.

import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import {
  trsMatrix, multiply, invert, slerp, sampleAt,
  rootPreMatrix, readPose, checkRestPose, poseWeights,
  alignYaw, applyAlignment, poseDistance, frameOfMotion, readAllPoses, nearestPerClip,
  readWindow, readAllWindows, tileWeights,
} from './pokemon-pose.js';

const DIR = 'models/stadium';
const FILES = { squirtle: '007_squirtle.glb', pikachu: '025_pikachu.glb', onix: '095_onix.glb', voltorb: '100_voltorb.glb' };

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
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`); }

/** Turn a pose about the vertical axis and shove it sideways, the way a clip that turns would. */
function rotatePose(pose, theta, dx = 0, dz = 0) {
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const out = new Float64Array(pose.length);
  for (let i = 0; i < pose.length; i += 3) {
    const x = pose[i], z = pose[i + 2];
    out[i] = cos * x + sin * z + dx;
    out[i + 1] = pose[i + 1];
    out[i + 2] = -sin * x + cos * z + dz;
  }
  return out;
}

console.log('\n--- the matrix math ---');

check('a TRS matrix and its inverse cancel', () => {
  const m = trsMatrix([3, -4, 5], [0.2, 0.4, 0.1, Math.sqrt(1 - 0.04 - 0.16 - 0.01)], [2, 0.5, 1.5]);
  const id = multiply(m, invert(m));
  for (let i = 0; i < 16; i++) near(id[i], i % 5 === 0 ? 1 : 0, 1e-9, `identity element ${i}`);
});

check('multiplication is parent-then-child, matching the hierarchy', () => {
  // A child offset by 1 in x under a parent offset by 10 in x lands at 11, not 1.
  const parent = trsMatrix([10, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  const child = trsMatrix([1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  const w = multiply(parent, child);
  near(w[12], 11, 1e-12, 'child world x');
});

check('a parent scale multiplies the child offset, which is the 0.1 trap', () => {
  const parent = trsMatrix([0, 0, 0], [0, 0, 0, 1], [0.1, 0.1, 0.1]);
  const child = trsMatrix([54, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  near(multiply(parent, child)[12], 5.4, 1e-12, 'the child lands at a tenth of its local offset');
});

check('slerp stays on the unit sphere and hits both ends', () => {
  const a = [0, 0, 0, 1];
  const b = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const q = slerp(a, b, t);
    near(Math.hypot(q[0], q[1], q[2], q[3]), 1, 1e-12, `unit at t=${t}`);
  }
  near(slerp(a, b, 0)[3], 1, 1e-12, 'starts at a');
  near(slerp(a, b, 1)[1], b[1], 1e-12, 'ends at b');
});

console.log('\n--- forward kinematics ---');

check('the rest pose reproduces what the rig already measured, on four species', () => {
  for (const name of Object.keys(FILES)) {
    const rig = rigOf(name);
    const worst = checkRestPose(rig);
    assert(worst < 1e-6, `${name}: worst rest-pose error ${worst}, so the FK disagrees with restWorld`);
  }
});

check('leaving out the pre-matrix is exactly the bug it is there to catch', () => {
  const rig = rigOf('squirtle');
  const right = readPose(rig, null, 0);
  // Composing from the root's own local transform, which is what the first version of this did.
  const wrong = readPose(rig, null, 0, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
  const i = rig.bones.findIndex(b => b.parent && Math.abs(b.restWorld[13]) > 1);
  assert(i >= 0, 'expected some bone off the origin');
  near(wrong[i * 3 + 1] / right[i * 3 + 1], 10, 0.001, 'the mistake is a factor of ten, not a small error');
});

check('a fractional frame lands between its neighbours', () => {
  const rig = rigOf('squirtle');
  const clip = rig.clips[0];
  const w = poseWeights(rig);
  const a = readPose(rig, clip, 5), b = readPose(rig, clip, 6), mid = readPose(rig, clip, 5.5);
  const dm = poseDistance(a, mid, { weights: w, height: rig.units.height });
  const dab = poseDistance(a, b, { weights: w, height: rig.units.height });
  assert(dm > 0, 'a half frame should not be the same pose');
  assert(dm < dab, 'a half frame should be nearer than the whole frame');
});

console.log('\n--- alignment, which is the fix ---');

check('a pose turned about the vertical axis is the SAME pose', () => {
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const pose = readPose(rig, rig.clips[0], 12);
  for (const deg of [5, 30, 90, 179, -120]) {
    const turned = rotatePose(pose, deg * Math.PI / 180);
    const aligned = poseDistance(pose, turned, { weights: w, height: h, align: true });
    const raw = poseDistance(pose, turned, { weights: w, height: h, align: false });
    assert(aligned < 1e-9, `${deg} degrees still reads ${aligned} after alignment`);
    if (Math.abs(deg) > 20) assert(raw > 0.1, `${deg} degrees reads only ${raw} unaligned, so the test proves nothing`);
  }
});

check('a pose moved across the ground is the same pose', () => {
  const rig = rigOf('pikachu');
  const w = poseWeights(rig), h = rig.units.height;
  const pose = readPose(rig, rig.clips[0], 3);
  const moved = rotatePose(pose, 0, 40, -25);
  near(poseDistance(pose, moved, { weights: w, height: h }), 0, 1e-9, 'translation in the ground plane');
});

check('a pose moved UP is not the same pose, because crouching is not standing', () => {
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const pose = readPose(rig, rig.clips[0], 3);
  const lifted = new Float64Array(pose);
  for (let i = 1; i < lifted.length; i += 3) lifted[i] += h * 0.25;
  near(poseDistance(pose, lifted, { weights: w, height: h }), 0.25, 1e-9, 'a quarter-height lift');
});

check('alignYaw recovers the angle it was given', () => {
  const rig = rigOf('squirtle');
  const w = poseWeights(rig);
  const pose = readPose(rig, rig.clips[2], 30);
  for (const deg of [10, 45, 90, 150, -75]) {
    const theta = deg * Math.PI / 180;
    const { theta: found } = alignYaw(pose, rotatePose(pose, theta, 7, -3), w);
    // alignYaw solves for the inverse rotation, so the two must cancel.
    const residual = Math.atan2(Math.sin(found + theta), Math.cos(found + theta));
    near(residual, 0, 1e-6, `recovering ${deg} degrees`);
  }
});

check('applying the alignment is what makes the distance drop', () => {
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const a = readPose(rig, rig.clips[0], 4);
  const b = rotatePose(readPose(rig, rig.clips[0], 4), 1.1, 5, 5);
  const fixed = applyAlignment(b, alignYaw(a, b, w));
  near(poseDistance(a, fixed, { weights: w, height: h, align: false, rootIndex: 0 }),
    poseDistance(a, fixed, { weights: w, height: h, align: true }), 1e-9,
    'an already-aligned pair should not move again');
});

check('distance is symmetric and zero only against itself', () => {
  const rig = rigOf('onix');
  const w = poseWeights(rig), h = rig.units.height;
  const a = readPose(rig, rig.clips[0], 2), b = readPose(rig, rig.clips[1], 9);
  near(poseDistance(a, b, { weights: w, height: h }), poseDistance(b, a, { weights: w, height: h }), 1e-9, 'symmetry');
  near(poseDistance(a, a, { weights: w, height: h }), 0, 1e-12, 'against itself');
  assert(poseDistance(a, b, { weights: w, height: h }) > 0, 'two different frames should differ');
});

check('alignment never makes a pair look further apart than root-centring did', () => {
  // It minimises over a family that includes no rotation, so it cannot lose. This is the whole argument.
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const all = readAllPoses(rig);
  let checked = 0;
  for (let i = 0; i < all.length; i += 37) {
    for (let j = 0; j < all.length; j += 53) {
      const aligned = poseDistance(all[i].pose, all[j].pose, { weights: w, height: h, align: true });
      const centred = poseDistance(all[i].pose, all[j].pose, { weights: w, height: h, align: false });
      assert(aligned <= centred + 1e-9, `alignment made ${all[i].name}@${all[i].frame} vs ${all[j].name}@${all[j].frame} worse`);
      checked++;
    }
  }
  assert(checked > 100, `only compared ${checked} pairs`);
});

console.log('\n--- windows, which carry direction ---');

check('a window of one frame is the frame', () => {
  const rig = rigOf('squirtle');
  const one = readWindow(rig, rig.clips[0], 7, { length: 1 });
  const pose = readPose(rig, rig.clips[0], 7);
  eq(one.length, pose.length, 'same size');
  for (let i = 0; i < pose.length; i++) near(one[i], pose[i], 1e-12, `element ${i}`);
});

check('a window that does not fit inside the clip is null, not clamped or shortened', () => {
  const rig = rigOf('squirtle');
  const clip = rig.clips[0];
  const last = clip.frames - 1;
  assert(readWindow(rig, clip, last, { length: 5 }) === null, 'the last frame has no forward window');
  assert(readWindow(rig, clip, last - 4, { length: 5 }) !== null, 'five frames from the end it just fits');
  assert(readWindow(rig, clip, 0, { length: 5, step: -1 }) === null, 'frame zero has no backward window');
  assert(readWindow(rig, clip, 4, { length: 5, step: -1 }) !== null, 'frame four does');
  assert(readWindow(rig, clip, -1, { length: 1 }) === null, 'a negative frame has none either');
});

check('tiled weights are the bone weights repeated once a frame', () => {
  const rig = rigOf('squirtle');
  const w = poseWeights(rig);
  const t = tileWeights(w, 4);
  eq(t.length, w.length * 4, 'four copies');
  for (let k = 0; k < 4; k++) for (let i = 0; i < w.length; i++) eq(t[k * w.length + i], w[i], `copy ${k} bone ${i}`);
});

check('THE FIX: the same pose moving the other way is not the same window', () => {
  // Forward and backward windows from one frame share their first pose, so a single-frame comparison
  // says they are identical. They are the two halves of a jump: same shape, opposite direction.
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const clip = rig.clips.find(c => c.name === 'attack_5');
  let worstSingle = 0, leastWindow = Infinity, tested = 0;
  for (let f = 8; f < 18; f++) {
    const fwd = readWindow(rig, clip, f, { length: 5, step: 1 });
    const back = readWindow(rig, clip, f, { length: 5, step: -1 });
    if (!fwd || !back) continue;
    tested++;
    worstSingle = Math.max(worstSingle,
      poseDistance(readPose(rig, clip, f), readPose(rig, clip, f), { weights: w, height: h }));
    leastWindow = Math.min(leastWindow,
      poseDistance(fwd, back, { weights: tileWeights(w, 5), height: h }));
  }
  assert(tested >= 5, `only tested ${tested} frames`);
  near(worstSingle, 0, 1e-12, 'a frame against itself is always zero, which is the whole problem');
  assert(leastWindow > 0.02, `windows only differ by ${leastWindow}, so direction is still invisible`);
});

check('a turned window is still the same window, so alignment survives the change', () => {
  const rig = rigOf('squirtle');
  const w = tileWeights(poseWeights(rig), 5), h = rig.units.height;
  const win = readWindow(rig, rig.clips[2], 20, { length: 5 });
  const turned = rotatePose(win, 0.9, 12, -6);
  near(poseDistance(win, turned, { weights: w, height: h }), 0, 1e-9, 'one yaw serves the whole window');
});

check('one alignment is solved for the whole window, not one a frame', () => {
  // Turning the WHOLE window aligns away to nothing. Turning only its last frame cannot, because the one
  // shared transform has to serve every frame. That gap is the entire reason a window carries direction.
  const rig = rigOf('squirtle');
  const n = rig.bones.length * 3;
  const w = tileWeights(poseWeights(rig), 4), h = rig.units.height;
  const win = readWindow(rig, rig.clips[2], 20, { length: 4 });

  const whole = rotatePose(win, 0.6, 4, -2);
  near(poseDistance(win, whole, { weights: w, height: h }), 0, 1e-9, 'a wholly turned window is the same window');

  const bent = new Float64Array(win);
  bent.set(rotatePose(win.slice(3 * n, 4 * n), 0.6), 3 * n);
  const aligned = poseDistance(win, bent, { weights: w, height: h, align: true });
  const raw = poseDistance(win, bent, { weights: w, height: h, align: false });
  assert(aligned > 0, 'a window bent only at its end must not align away');
  assert(aligned > raw * 0.8, `alignment absorbed ${(100 * (1 - aligned / raw)).toFixed(0)}% of a bend it should barely touch`);
});

check('the gap is real in the shipped data, not only in a constructed case', () => {
  // Squirtle passes through nearly the same pose twice in attack_3 and goes somewhere different each time.
  // As single frames these are indistinguishable; as windows they are further apart than average.
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const clip = rig.clips.find(c => c.name === 'attack_3');
  const single = poseDistance(readPose(rig, clip, 39), readPose(rig, clip, 61), { weights: w, height: h });
  const win = poseDistance(
    readWindow(rig, clip, 39, { length: 5 }), readWindow(rig, clip, 61, { length: 5 }),
    { weights: tileWeights(w, 5), height: h });
  assert(single < 0.02, `attack_3 frames 39 and 61 should look identical as frames, got ${single.toFixed(3)}`);
  assert(win > 0.4, `and clearly different as windows, got ${win.toFixed(3)}`);
  assert(win / single > 20, `a window should separate them by more than 20x, got ${(win / single).toFixed(0)}x`);
});

check('most static matches are genuine, and the few that are not are wrong by a lot', () => {
  // This is the shape of the problem, and it is not what it looks like from the worst cases alone. Nearly
  // every pair that matches as a single frame also matches as motion. A small tail does not, and misses by
  // an order of magnitude. That tail is what makes windowing worth its cost, and it matters more than the
  // rate suggests: a search for the NEAREST frame selects on low distance, which is exactly what a false
  // match scores.
  const rig = rigOf('squirtle');
  const w = poseWeights(rig), h = rig.units.height;
  const tiled = tileWeights(w, 5);
  const wins = readAllWindows(rig, { length: 5 });
  const n = rig.bones.length * 3;
  const vals = [];
  for (let i = 0; i < wins.length; i += 5) {
    for (let j = i + 1; j < wins.length; j += 11) {
      const a = wins[i], b = wins[j];
      if (a.clip === b.clip && Math.abs(a.frame - b.frame) < 12) continue;
      const single = poseDistance(a.pose.subarray(0, n), b.pose.subarray(0, n), { weights: w, height: h });
      if (single > 0.06) continue;
      vals.push(poseDistance(a.pose, b.pose, { weights: tiled, height: h }));
    }
  }
  vals.sort((x, y) => x - y);
  assert(vals.length > 50, `only ${vals.length} pairs matched as single frames, so the sample proves nothing`);
  const median = vals[vals.length >> 1];
  const bad = vals.filter(v => v > 0.3).length;
  assert(median < 0.12, `median static match is ${median.toFixed(3)} as motion, so most matches are not genuine after all`);
  assert(vals[vals.length - 1] > 0.4, `worst static match is only ${vals[vals.length - 1].toFixed(3)} as motion`);
  assert(bad >= 1 && bad / vals.length < 0.25,
    `${bad} of ${vals.length} static matches are badly wrong, which is outside the measured shape`);
});

check('every window is a real run of frames from its clip', () => {
  const rig = rigOf('voltorb');
  const pre = null;
  const all = readAllWindows(rig, { length: 3 });
  const n = rig.bones.length * 3;
  assert(all.length > 0, 'no windows at all');
  for (const entry of all) {
    eq(entry.pose.length, n * 3, 'three frames wide');
    const clip = rig.clips[entry.clip];
    assert(entry.frame + 2 <= clip.frames - 1, `window at ${entry.frame} runs past the end of ${clip.name}`);
  }
  // Spot-check one against poses read directly.
  const e = all[all.length >> 1];
  const clip = rig.clips[e.clip];
  for (let k = 0; k < 3; k++) {
    const direct = readPose(rig, clip, e.frame + k);
    for (let i = 0; i < n; i += 97) near(e.pose[k * n + i], direct[i], 1e-12, `frame ${k} element ${i}`);
  }
});

check('windowing costs frames at the end of every clip, and says so by having none', () => {
  const rig = rigOf('squirtle');
  const singles = readAllPoses(rig).length;
  const windows = readAllWindows(rig, { length: 5 }).length;
  eq(singles - windows, rig.clips.length * 4, 'four lost frames a clip for a five-frame window');
});

console.log('\n--- the derived quantities ---');

check('a species frame of motion is positive and small', () => {
  for (const name of ['squirtle', 'pikachu']) {
    const rig = rigOf(name);
    const u = frameOfMotion(rig);
    assert(u > 0, `${name}: no motion at all`);
    assert(u < 0.2, `${name}: ${u} a frame is not a frame of motion`);
  }
});

check('Squirtle moves several times as far per frame as Pikachu, so the unit cannot be shared', () => {
  const ratio = frameOfMotion(rigOf('squirtle')) / frameOfMotion(rigOf('pikachu'));
  assert(ratio > 2, `ratio is only ${ratio}, so the per-species unit would not be needed`);
});

check('weights follow the mesh, and fall back to counting bones equally', () => {
  const rig = rigOf('squirtle');
  const w = poseWeights(rig);
  eq(w.length, rig.bones.length, 'one weight a bone');
  assert(w.some(v => v > 0), 'some bone should carry mesh');
  const bare = poseWeights({ bones: rig.bones, geometry: new Map() });
  assert(bare.every(v => v === 1), 'a rig with no skinned geometry should weight every bone the same');
});

check('the nearest frame per clip is one row a clip, nearest first, and skips the target clip', () => {
  const rig = rigOf('squirtle');
  const all = readAllPoses(rig);
  const target = readPose(rig, rig.clips[7], 51);
  const rows = nearestPerClip(rig, all, target, { skipClip: 7 });
  eq(rows.length, rig.clips.length - 1, 'one row for every clip but the target');
  assert(rows.every(r => r.clip !== 7), 'the target clip should be skipped');
  for (let i = 1; i < rows.length; i++) assert(rows[i].distance >= rows[i - 1].distance, 'rows should be sorted');
});

check('Squirtle in-shell is reachable and Pikachu fainted is not, which is the finding', () => {
  const sq = rigOf('squirtle');
  const near1 = nearestPerClip(sq, readAllPoses(sq), readPose(sq, sq.clips[7], 51), { skipClip: 7 })[0];
  const shellFrames = near1.distance / frameOfMotion(sq);

  const pk = rigOf('pikachu');
  const faint = pk.clips.find(c => c.name === 'faint');
  const near2 = nearestPerClip(pk, readAllPoses(pk), readPose(pk, faint, faint.frames - 1), { skipClip: faint.index })[0];
  const faintFrames = near2.distance / frameOfMotion(pk);

  assert(shellFrames < 20, `the shell should be a short blend away, got ${shellFrames.toFixed(1)} frames`);
  assert(faintFrames > shellFrames * 2, `fainted (${faintFrames.toFixed(1)}) should be far harder to reach than the shell (${shellFrames.toFixed(1)})`);
});

console.log('\n' + results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
