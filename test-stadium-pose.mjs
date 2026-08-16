// Node checks for pose capture and blending. Run with `node test-stadium-pose.mjs`.

import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB, nodeWorldMatrices } from './stadium-glb.js';
import { mapStadiumRig, pivotTree } from './stadium-rig-map.js';
import {
  trs, emptyPose, lerpVec, slerpQuat, blendPoses, blendSequence, validatePose, poseDistance, subsetPose,
} from './stadium-pose.js';

/**
 * The scene-graph half of the demo's pose handling, kept here rather than imported because it lives
 * inline in the HTML. If the demo's version drifts from this, these checks stop meaning anything —
 * `poseBones`, `capturePoseFrom` and `applyPoseTo` in `demos/stadium-walker.html` are the originals.
 */
function buildRig(json, map) {
  const objs = new Map();
  (json.nodes || []).forEach((n, i) => {
    const o = new THREE.Object3D();
    o.name = n.name ?? `node${i}`;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    objs.set(i, o);
  });
  (json.nodes || []).forEach((n, i) => { for (const c of n.children || []) objs.get(i).add(objs.get(c)); });
  const root = new THREE.Group();
  for (const [, o] of objs) if (!o.parent) root.add(o);

  const wanted = new Set(Object.values(map.names));
  for (const skin of json.skins || []) {
    for (const j of skin.joints) { const n = json.nodes[j]?.name; if (n) wanted.add(n); }
  }
  const byName = new Map();
  root.traverse((o) => { if (wanted.has(o.name) && !byName.has(o.name)) byName.set(o.name, o); });
  return { root, byName };
}
const capture = (byName, name) => {
  const pose = emptyPose(name);
  for (const [bone, o] of byName) pose.bones[bone] = trs(o.position.toArray(), o.quaternion.toArray(), o.scale.toArray());
  return pose;
};
const applyPose = (byName, pose) => {
  for (const [bone, t] of Object.entries(pose.bones)) {
    const o = byName.get(bone);
    if (!o) continue;
    o.position.fromArray(t.p); o.quaternion.fromArray(t.q); o.scale.fromArray(t.s);
  }
};

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b}`); }

const ident = [0, 0, 0, 1];
/** A quaternion for `deg` about Y, which is the axis these models turn on. */
const aboutY = (deg) => {
  const h = (deg * Math.PI / 180) / 2;
  return [0, Math.sin(h), 0, Math.cos(h)];
};
const pose = (name, bones) => ({ name, species: 'toy', bones });
const one = (q, p = [0, 0, 0], s = [1, 1, 1]) => trs(p, q, s);

// ===================== the arithmetic =====================

check('a vector lerp hits both ends and the middle', () => {
  assert(lerpVec([0, 0, 0], [2, 4, 6], 0).join() === '0,0,0', 'start');
  assert(lerpVec([0, 0, 0], [2, 4, 6], 1).join() === '2,4,6', 'end');
  assert(lerpVec([0, 0, 0], [2, 4, 6], 0.5).join() === '1,2,3', 'middle');
});

check('slerp halfway between two rotations is the rotation halfway between them', () => {
  const q = slerpQuat(ident, aboutY(90), 0.5);
  const want = aboutY(45);
  for (let i = 0; i < 4; i++) near(q[i], want[i], 1e-9, `component ${i}`);
});

check('slerp stays a unit quaternion the whole way', () => {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    near(Math.hypot(...slerpQuat(aboutY(-140), aboutY(150), t)), 1, 1e-9, `length at t=${t.toFixed(2)}`);
  }
});

check('slerp takes the SHORT way round', () => {
  // The defect this pins: q and -q are the same orientation, so without the sign flip a blend between two
  // nearly-equal poses can travel 350 degrees to get 10, and a limb swings through the body.
  const a = aboutY(10);
  const b = aboutY(350).map(v => -v);   // the same as -10 degrees, written the long way
  const mid = slerpQuat(a, b, 0.5);
  // Halfway between +10 and -10 is 0, so the y component should be tiny — not near sin(180deg/2)=1.
  assert(Math.abs(mid[1]) < 0.02, `slerp went the long way: y=${mid[1].toFixed(3)}`);
  assert(Math.abs(mid[3]) > 0.99, `slerp went the long way: w=${mid[3].toFixed(3)}`);
});

check('slerp survives two identical rotations', () => {
  // The near-parallel branch: the sine denominator collapses and a naive implementation returns NaN.
  const q = slerpQuat(aboutY(30), aboutY(30), 0.5);
  assert(q.every(Number.isFinite), `got ${q}`);
  near(Math.hypot(...q), 1, 1e-9, 'length');
  near(q[1], aboutY(30)[1], 1e-6, 'y');
});

// ===================== blending =====================

check('a blend hits each end exactly', () => {
  const a = pose('a', { hip: one(ident, [0, 0, 0]) });
  const b = pose('b', { hip: one(aboutY(90), [1, 2, 3], [2, 2, 2]) });
  const at0 = blendPoses(a, b, 0), at1 = blendPoses(a, b, 1);
  near(at0.bones.hip.p[1], 0, 1e-9, 'start position');
  near(at1.bones.hip.p[1], 2, 1e-9, 'end position');
  near(at1.bones.hip.s[0], 2, 1e-9, 'end scale');
  near(at1.bones.hip.q[1], aboutY(90)[1], 1e-9, 'end rotation');
});

check('t is clamped rather than extrapolated', () => {
  const a = pose('a', { hip: one(ident, [0, 0, 0]) });
  const b = pose('b', { hip: one(ident, [10, 0, 0]) });
  near(blendPoses(a, b, 2).bones.hip.p[0], 10, 1e-9, 'past the end');
  near(blendPoses(a, b, -1).bones.hip.p[0], 0, 1e-9, 'before the start');
});

check('scale is blended, because these rigs animate it', () => {
  // The ROM's own clips carry translation, rotation AND scale channels, so a pose format that dropped
  // scale would be lossy against the thing it is meant to sit beside.
  const a = pose('a', { hip: one(ident, [0, 0, 0], [1, 1, 1]) });
  const b = pose('b', { hip: one(ident, [0, 0, 0], [3, 3, 3]) });
  near(blendPoses(a, b, 0.5).bones.hip.s[0], 2, 1e-9, 'midpoint scale');
});

check('a bone in only one pose keeps its value instead of collapsing', () => {
  const a = pose('a', { hip: one(ident, [1, 1, 1]), tail: one(aboutY(40)) });
  const b = pose('b', { hip: one(ident, [3, 3, 3]) });
  const mid = blendPoses(a, b, 0.5);
  near(mid.bones.hip.p[0], 2, 1e-9, 'shared bone blends');
  assert(mid.bones.tail, 'the unshared bone was dropped');
  near(mid.bones.tail.q[1], aboutY(40)[1], 1e-9, 'the unshared bone should hold, not fade');
});

check('blending against nothing returns the pose that exists', () => {
  const a = pose('a', { hip: one(aboutY(20)) });
  assert(blendPoses(a, null, 0.7).bones.hip, 'lost the pose');
  assert(blendPoses(null, a, 0.7).bones.hip, 'lost the pose');
  assert(Object.keys(blendPoses(null, null, 0.5).bones).length === 0, 'expected an empty pose');
});

check('a blend does not alias its inputs', () => {
  // Handing back an input's own arrays would let one scrub of the slider corrupt a saved pose.
  const a = pose('a', { hip: one(ident, [0, 0, 0]) });
  const b = pose('b', { hip: one(ident, [10, 0, 0]) });
  const out = blendPoses(a, b, 0);
  out.bones.hip.p[0] = 999;
  near(a.bones.hip.p[0], 0, 1e-9, 'the source pose was mutated');
});

check('every blend shortcut copies too', () => {
  // The one-sided and single-key paths return early, and returned the input's own bones until 2026-08-16.
  const mk = () => pose('a', { hip: one(ident, [0, 0, 0]) });
  for (const [what, make] of [
    ['b missing', (p) => blendPoses(p, null, 0.5)],
    ['a missing', (p) => blendPoses(null, p, 0.5)],
    ['one key', (p) => blendSequence([p], 0.5)],
  ]) {
    const src = mk();
    const got = make(src);
    assert(got.bones !== src.bones, `${what}: handed back the source's own bones`);
    got.bones.hip.p[0] = 999;
    near(src.bones.hip.p[0], 0, 1e-9, `${what}: the source pose was mutated`);
  }
});

// ===================== sequences =====================

check('a sequence crosses every key in order', () => {
  const keys = [
    pose('a', { hip: one(ident, [0, 0, 0]) }),
    pose('b', { hip: one(ident, [10, 0, 0]) }),
    pose('c', { hip: one(ident, [20, 0, 0]) }),
  ];
  near(blendSequence(keys, 0).bones.hip.p[0], 0, 1e-9, 'start');
  near(blendSequence(keys, 0.5).bones.hip.p[0], 10, 1e-9, 'middle key');
  near(blendSequence(keys, 1).bones.hip.p[0], 20, 1e-9, 'end');
  near(blendSequence(keys, 0.25).bones.hip.p[0], 5, 1e-9, 'between the first two');
  near(blendSequence(keys, 0.75).bones.hip.p[0], 15, 1e-9, 'between the last two');
});

check('a sequence of one or none is not an error', () => {
  const solo = pose('a', { hip: one(ident) });
  assert(blendSequence([solo], 0.6).bones.hip, 'a single key should just be itself');
  assert(Object.keys(blendSequence([], 0.5).bones).length === 0, 'an empty list should be an empty pose');
  assert(blendSequence([null, solo, null].filter(Boolean), 1).bones.hip, 'nulls should be skipped');
});

// ===================== validation =====================

check('a good pose validates and a broken one does not', () => {
  assert(validatePose(pose('a', { hip: one(ident) })).ok, 'a fine pose was rejected');
  assert(!validatePose(null).ok, 'null passed');
  assert(!validatePose({ bones: {} }).ok, 'an empty pose passed');
  assert(!validatePose({ bones: { hip: { p: [0, 0], q: ident, s: [1, 1, 1] } } }).ok, 'a short vector passed');
  assert(!validatePose({ bones: { hip: { p: [0, 0, 0], q: [0, 0, 0, 0], s: [1, 1, 1] } } }).ok,
    'a zero quaternion passed, which decomposes to nothing');
  const nan = validatePose({ bones: { hip: { p: [0, NaN, 0], q: ident, s: [1, 1, 1] } } });
  assert(!nan.ok && /hip/.test(nan.problems.join(' ')), `NaN should be named, got ${nan.problems.join('; ')}`);
});

// ===================== distance and subsets =====================

check('pose distance is the widest rotation of any shared bone', () => {
  const a = pose('a', { hip: one(ident), knee: one(ident) });
  const b = pose('b', { hip: one(aboutY(30)), knee: one(aboutY(90)) });
  near(poseDistance(a, b) * 180 / Math.PI, 90, 1e-6, 'should report the worst bone');
  near(poseDistance(a, a), 0, 1e-9, 'a pose against itself');
  assert(poseDistance(a, null) === Infinity, 'missing pose should be infinitely far');
});

check('pose distance survives a quaternion that has drifted off unit length', () => {
  // Found by the cross-rig check below, which reported a pose 0.06 degrees from an exact copy of itself.
  // `Object3D.rotateY` in a loop drifts by about a part in ten million, and acos near 1 magnifies it.
  const drifted = aboutY(37).map(v => v * (1 + 1e-7));
  const p = pose('a', { hip: one(drifted) });
  near(poseDistance(p, p), 0, 1e-9, 'a drifted pose against itself');
  near(poseDistance(p, pose('b', { hip: one(aboutY(37)) })), 0, 1e-6, 'drifted against its clean twin');
});

check('a subset keeps only the named bones, and copies them', () => {
  const a = pose('a', { hip: one(ident, [1, 0, 0]), tail: one(ident), knee: one(ident) });
  const cut = subsetPose(a, ['hip', 'knee']);
  assert(Object.keys(cut.bones).sort().join() === 'hip,knee', `got ${Object.keys(cut.bones)}`);
  cut.bones.hip.p[0] = 42;
  near(a.bones.hip.p[0], 1, 1e-9, 'the subset aliased its source');
});

check('an empty pose is a usable starting point', () => {
  const p = emptyPose('fresh', '019_rattata');
  assert(p.name === 'fresh' && p.species === '019_rattata' && Object.keys(p.bones).length === 0, 'shape');
});

// ===================== against a real rig =====================
//
// The pure half above cannot catch the mistake that actually costs an afternoon: capturing a set of bones
// that is not the set the file animates. These build a real scene graph the way the demo does.

check('the animatable set is pivots AND the _scale leaves', () => {
  // Measured on Rattata's own clips: 104 translation and 192 rotation channels target pivot bones, and 6
  // scale channels target the childless `_scale` leaves the skin binds to. A pose built from `map.names`
  // alone holds pivots only, so it would drop every scale the file carries and no test would notice.
  const { json, bin } = parseGLB(fs.readFileSync('models/stadium/019_rattata.glb'));
  const tree = pivotTree(json, nodeWorldMatrices(json));
  const pivots = new Set(tree.pivots);
  let leafScale = 0, pivotScale = 0;
  for (const a of json.animations || []) {
    for (const c of a.channels) {
      if (c.target.path !== 'scale') continue;
      if (pivots.has(c.target.node)) pivotScale++; else leafScale++;
    }
  }
  assert(leafScale > 0, 'expected scale channels on the leaves — if this fails the capture set can shrink');
  assert(pivotScale === 0, `expected no scale on pivots, found ${pivotScale}`);

  const map = mapStadiumRig(json, bin, { source: '019_rattata' });
  const joints = new Set((json.skins || []).flatMap(s => s.joints));
  const pivotNames = new Set(Object.values(map.names));
  const missed = [...joints].filter(j => !pivotNames.has(json.nodes[j].name));
  assert(missed.length > 0, 'the skin joints are all pivots, so this whole check is moot — re-read it');
});

check('a captured pose round-trips through JSON and back onto the rig', () => {
  const { json, bin } = parseGLB(fs.readFileSync('models/stadium/019_rattata.glb'));
  const map = mapStadiumRig(json, bin, { source: '019_rattata' });
  const { root, byName } = buildRig(json, map);

  const captured = capture(byName, 'a');
  assert(Object.keys(captured.bones).length > 20, `only ${Object.keys(captured.bones).length} bones captured`);
  assert(validatePose(captured).ok, validatePose(captured).problems.join('; '));

  // Move everything, then put the captured pose back and check the rig returns to where it was.
  const before = new Map([...byName].map(([n, o]) => [n, o.quaternion.toArray()]));
  for (const [, o] of byName) o.quaternion.set(0, 0.3826834, 0, 0.9238795);
  const reloaded = JSON.parse(JSON.stringify(captured));
  applyPose(byName, reloaded);
  for (const [n, q] of before) {
    const now = byName.get(n).quaternion.toArray();
    for (let i = 0; i < 4; i++) near(now[i], q[i], 1e-6, `${n} component ${i} did not come back`);
  }
  root.updateMatrixWorld(true);
});

check('blending two real poses moves the rig somewhere between them', () => {
  const { json, bin } = parseGLB(fs.readFileSync('models/stadium/077_ponyta.glb'));
  const map = mapStadiumRig(json, bin, { source: '077_ponyta' });
  const { byName } = buildRig(json, map);

  const rest = capture(byName, 'rest');
  // A second pose: turn every bone a little, so the two are genuinely apart.
  for (const [, o] of byName) o.rotateY(0.25);
  const turned = capture(byName, 'turned');
  const apart = poseDistance(rest, turned);
  assert(apart > 0.2, `the two poses are only ${apart.toFixed(3)} rad apart, so the test proves nothing`);

  applyPose(byName, blendPoses(rest, turned, 0.5));
  const mid = capture(byName, 'mid');
  const toRest = poseDistance(mid, rest), toTurned = poseDistance(mid, turned);
  assert(toRest > 1e-6 && toTurned > 1e-6, 'the midpoint landed on one of the ends');
  near(toRest, toTurned, 1e-6, 'the midpoint is not equidistant from the two ends');
  assert(toRest < apart, 'the midpoint is further from an end than the ends are from each other');
});

check('a pose from one individual applies to another of the same species', () => {
  // What makes poses worth keying by bone NAME rather than node index: two clones share names, so a pose
  // captured on one is portable to the next one spawned.
  const { json, bin } = parseGLB(fs.readFileSync('models/stadium/128_tauros.glb'));
  const map = mapStadiumRig(json, bin, { source: '128_tauros' });
  const a = buildRig(json, map), b = buildRig(json, map);
  for (const [, o] of a.byName) o.rotateY(0.4);
  const pose = capture(a.byName, 'turned');
  applyPose(b.byName, pose);
  near(poseDistance(capture(b.byName, 'check'), pose), 0, 1e-6, 'the second rig did not take the pose');
});

console.log('stadium poses');
console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
