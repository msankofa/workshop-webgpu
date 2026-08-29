// Drive-mask tests. Run with `node test-pokemon-drive.mjs`.
//
// The mask itself is small; what is worth testing is that it lines up with real rigs and real clips. The
// claim the whole design rests on -- that a bone key and a THREE track's target are the same string -- is
// checked against every clip of every species rather than asserted.

import fs from 'node:fs';
import { readRigFromGLB, descendants } from './pokemon-rig.js';
import { readPose, rootPreMatrix } from './pokemon-pose.js';
import { buildHang, pinBone, releaseAll, stepHang, hangPositions } from './pokemon-hang.js';
import {
  CLIP, POSED, LIMP, DRIVES, driveOf, setDrive, keysWith, driveCounts, indicesWith,
  anchorIndices, isPlain, forRig, trackBone, suppressedTracks,
} from './pokemon-drive.js';

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
const restPose = (rig) => readPose(rig, null, 0, rootPreMatrix(rig));

console.log('\n--- the mask ---');

check('an unlisted bone is driven by the clip, which is what an empty mask means', () => {
  eq(driveOf({}, 'anything'), CLIP, 'empty mask');
  eq(driveOf(null, 'anything'), CLIP, 'no mask at all');
  eq(driveOf(undefined, 'anything'), CLIP, 'undefined mask');
  assert(isPlain({}) && isPlain(null), 'an empty mask must read as plain');
});

check('setting a mode reads back, and setting it to clip removes the entry', () => {
  let d = setDrive({}, 'bone1', LIMP);
  eq(driveOf(d, 'bone1'), LIMP, 'set to limp');
  assert(!isPlain(d), 'a mask with an entry is not plain');
  d = setDrive(d, 'bone1', CLIP);
  eq(driveOf(d, 'bone1'), CLIP, 'back to clip');
  eq(Object.keys(d).length, 0, 'the default must be stored by absence, not as a string');
  assert(isPlain(d), 'and the mask is plain again');
});

check('setting does not mutate the mask it was given', () => {
  const a = setDrive({}, 'bone1', LIMP);
  const b = setDrive(a, 'bone2', POSED);
  eq(Object.keys(a).length, 1, 'the original must be untouched');
  eq(Object.keys(b).length, 2, 'the copy must have both');
});

check('a mode nothing recognises is refused rather than stored', () => {
  const d = setDrive({}, 'bone1', 'floppy');
  eq(driveOf(d, 'bone1'), CLIP, 'an unknown mode must fall back to the clip');
  eq(driveOf({ bone1: 'floppy' }, 'bone1'), CLIP, 'and must not be believed when read back either');
});

check('many keys can be set at once', () => {
  const d = setDrive({}, ['a', 'b', 'c'], LIMP);
  for (const k of ['a', 'b', 'c']) eq(driveOf(d, k), LIMP, k);
});

console.log('\n--- against a real rig ---');

check('the three sets partition the skeleton, whatever is in the mask', () => {
  const rig = rigOf('squirtle');
  const limb = descendants(rig, rig.bones[5].key);
  const d = setDrive(setDrive({}, limb, LIMP), rig.bones[2].key, POSED);
  const counts = driveCounts(rig, d);
  eq(counts.clip + counts.posed + counts.limp, rig.bones.length, 'every bone must be in exactly one set');
  for (const mode of DRIVES) {
    eq(keysWith(rig, d, mode).length, counts[mode], `${mode} count must match its list`);
    eq(indicesWith(rig, d, mode).length, counts[mode], `${mode} indices must match its count`);
  }
});

check('the anchors are everything the ragdoll does not drive', () => {
  const rig = rigOf('pikachu');
  const d = setDrive({}, descendants(rig, rig.bones[4].key), LIMP);
  const limp = indicesWith(rig, d, LIMP);
  const anchors = anchorIndices(rig, d);
  eq(limp.length + anchors.length, rig.bones.length, 'every bone is anchored or limp, never both');
  assert(limp.length > 0, 'the mask should have made something limp, or this proves nothing');
  for (const i of anchors) assert(!limp.includes(i), `bone ${i} is in both sets`);
});

check('an empty mask anchors everything, so a partial ragdoll does nothing', () => {
  const rig = rigOf('squirtle');
  eq(anchorIndices(rig, {}).length, rig.bones.length, 'nothing limp means nothing falls');
  eq(indicesWith(rig, {}, LIMP).length, 0, 'and nothing is simulated');
});

check('a mask carried to a species without those bones drops them', () => {
  const squirtle = rigOf('squirtle');
  const onix = rigOf('onix');
  const d = setDrive({}, squirtle.bones.map(b => b.key), LIMP);
  const kept = forRig(onix, d);
  for (const key of Object.keys(kept)) {
    assert(onix.byKey.has(key), `${key} is not an Onix bone`);
  }
  eq(Object.keys(kept).length, driveCounts(onix, d).limp, 'what survives must be what Onix reads back');
});

console.log('\n--- track names ---');

check('a track name splits on its last dot, and a name with no dot is not a track', () => {
  eq(trackBone('bone12.quaternion'), 'bone12', 'plain');
  eq(trackBone('some.bone.position'), 'some.bone', 'a bone name containing a dot');
  eq(trackBone('bone12'), null, 'no property');
  eq(trackBone('.quaternion'), null, 'no bone');
  eq(trackBone(null), null, 'nothing at all');
});

check('only the masked bones are suppressed', () => {
  const names = ['a.quaternion', 'a.position', 'b.quaternion', 'c.scale'];
  const d = setDrive(setDrive({}, 'a', LIMP), 'c', POSED);
  const out = suppressedTracks(names, d);
  eq(out.length, 3, 'both of a and the one of c');
  assert(!out.includes('b.quaternion'), 'b is still the clip\'s');
  eq(suppressedTracks(names, {}).length, 0, 'an empty mask suppresses nothing');
});

check('every track in the dex names a bone its rig knows, so a mask needs no lookup', () => {
  // The claim the whole design rests on. If a track named something the rig did not have, a mask keyed on
  // bone names could not say anything about it, and masking would have to go through node indices instead.
  let tracks = 0, orphans = 0, species = 0;
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.glb')).sort();
  for (const file of files) {
    let rig;
    try { rig = readRigFromGLB(fs.readFileSync(`${DIR}/${file}`)).rig; } catch { continue; }
    species++;
    const known = new Set(rig.bones.map(b => b.key));
    for (const clip of rig.clips) {
      for (const t of clip.tracks) {
        tracks++;
        if (!known.has(t.bone)) orphans++;
      }
    }
  }
  assert(species > 100, `only read ${species} species, so this is not the dex`);
  assert(tracks > 10000, `only ${tracks} tracks, so this is not testing much`);
  eq(orphans, 0, `${orphans} of ${tracks} tracks name a bone their rig does not have`);
});

check('no two bones in a species share a name, so a track name means one bone', () => {
  // THREE binds a track by node NAME. Two bones with one name would make a mask ambiguous, and would make
  // THREE itself bind to whichever it found first.
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.glb')).sort();
  let clashes = 0;
  for (const file of files) {
    let read;
    try { read = readRigFromGLB(fs.readFileSync(`${DIR}/${file}`)); } catch { continue; }
    clashes += (read.rig.duplicates || []).length;
  }
  eq(clashes, 0, `${clashes} repeated bone names across the dex`);
});

console.log('\n--- the partial ragdoll ---');

// The page cannot run in Node, but the mechanism under it can: pin every bone the animation drives, step,
// and see whether the limp ones behave. Everything below drives the anchors by hand in place of a clip.
function partial(rig, seed, driveMask, { frames = 240, move = () => [0, 0, 0] } = {}) {
  const sim = buildHang(rig, seed, { stiffness: 0.4 });
  const anchors = anchorIndices(rig, driveMask);
  for (let k = 0; k < frames; k++) {
    const [dx, dy, dz] = move(k);
    releaseAll(sim);
    for (const i of anchors) pinBone(sim, i, seed[i * 3] + dx, seed[i * 3 + 1] + dy, seed[i * 3 + 2] + dz);
    stepHang(sim, 1 / 60, { gravity: 1, ground: false });
  }
  return hangPositions(sim);
}

const moved = (a, b, i) => Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]);

function boneLengths(rig, xyz) {
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const out = [];
  rig.bones.forEach((b, i) => {
    const p = b.parent != null ? at.get(b.parent) : undefined;
    if (p === undefined) return;
    out.push(Math.hypot(
      xyz[i * 3] - xyz[p * 3], xyz[i * 3 + 1] - xyz[p * 3 + 1], xyz[i * 3 + 2] - xyz[p * 3 + 2]));
  });
  return out;
}

/** A bone with a decent run of descendants, so "a limb goes limp" is actually testing a limb. */
function limbOf(rig) {
  let best = null, most = 0;
  for (const b of rig.bones) {
    const n = descendants(rig, b.key).length;
    if (n > most && n < rig.bones.length - 2) { most = n; best = b.key; }
  }
  return best;
}

check('an empty mask anchors everything, so nothing moves at all', () => {
  const rig = rigOf('squirtle');
  const seed = restPose(rig);
  const now = partial(rig, seed, {});
  let worst = 0;
  for (let i = 0; i < rig.bones.length; i++) worst = Math.max(worst, moved(seed, now, i));
  assert(worst < rig.units.height * 1e-6, `something moved ${worst} with nothing limp`);
});

check('a limp limb falls while the animated bones stay exactly where they were put', () => {
  const rig = rigOf('squirtle');
  const seed = restPose(rig);
  const limb = descendants(rig, limbOf(rig));
  const d = setDrive({}, limb, LIMP);
  const now = partial(rig, seed, d);

  let anchorWorst = 0, limpBest = 0;
  for (const i of anchorIndices(rig, d)) anchorWorst = Math.max(anchorWorst, moved(seed, now, i));
  for (const i of indicesWith(rig, d, LIMP)) limpBest = Math.max(limpBest, moved(seed, now, i));
  assert(anchorWorst < rig.units.height * 1e-6, `an anchored bone drifted ${anchorWorst}`);
  assert(limpBest > rig.units.height * 0.01, `nothing fell: the furthest limp bone moved ${limpBest}`);
});

check('the skeleton does not stretch while half of it hangs off the other half', () => {
  const rig = rigOf('pikachu');
  const seed = restPose(rig);
  const d = setDrive({}, descendants(rig, limbOf(rig)), LIMP);
  const before = boneLengths(rig, seed);
  const after = boneLengths(rig, partial(rig, seed, d));
  let worst = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] > rig.units.height * 1e-3) worst = Math.max(worst, Math.abs(after[i] - before[i]) / before[i]);
  }
  assert(worst < 0.05, `a bone stretched ${(worst * 100).toFixed(1)}%`);
});

check('moving the animated bones carries the limp ones with them', () => {
  // The point of the whole thing: a body that walks away should not leave its dead arm behind.
  const rig = rigOf('squirtle');
  const seed = restPose(rig);
  const d = setDrive({}, descendants(rig, limbOf(rig)), LIMP);
  const shift = rig.units.height * 2;
  const now = partial(rig, seed, d, { frames: 300, move: (k) => [Math.min(k / 150, 1) * shift, 0, 0] });
  for (const i of indicesWith(rig, d, LIMP)) {
    const dx = now[i * 3] - seed[i * 3];
    assert(dx > shift * 0.5, `a limp bone was left behind: it moved ${dx.toFixed(1)} of ${shift.toFixed(1)}`);
  }
});

check('every bone limp is the same thing as the whole-body ragdoll with nothing pinned', () => {
  // The two paths in the page are one mechanism, so the masked one had better degenerate to the other.
  const rig = rigOf('squirtle');
  const seed = restPose(rig);
  const all = setDrive({}, rig.bones.map(b => b.key), LIMP);
  eq(anchorIndices(rig, all).length, 0, 'nothing should be anchored');
  const free = buildHang(rig, seed, { stiffness: 0.4 });
  for (let k = 0; k < 120; k++) stepHang(free, 1 / 60, { gravity: 1, ground: false });
  const masked = partial(rig, seed, all, { frames: 120 });
  const a = hangPositions(free);
  let worst = 0;
  for (let i = 0; i < rig.bones.length; i++) worst = Math.max(worst, moved(a, masked, i));
  assert(worst < rig.units.height * 1e-9, `the two paths disagree by ${worst}`);
});

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failures} checks passed\n`);
process.exit(failures ? 1 : 0);
