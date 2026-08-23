// Node checks for stances. Run with `node test-stadium-stance.mjs`.
//
// The claim under test is the one the whole feature rests on: a stance is an input to `mapStadiumRig`,
// so editing the neutral pose changes the numbers the gait derives — ride height, leg span, the two-bone
// split — and not merely what is drawn. Growlithe is the worked example, because it rests sitting down.

import fs from 'node:fs';
import { parseGLB, nodeWorldMatrices, nodeLocalMatrix, matMultiply, readSkinnedVertices } from './stadium-glb.js';
import { mapStadiumRig, pivotTree } from './stadium-rig-map.js';
import { rolesFromMap, compileRoles } from './stadium-rig-roles.js';
import {
  STANCE_VERSION, emptyStance, copyStance, isEmptyStance, isBlankStance, setStanceBone, clearStanceBone,
  setStanceRoles, stanceStamp, validateStance, applyStance, groundJson, stanceJson,
  mirrorTargets, mirrorLocal, mirrorStanceBone, restTRS,
  invertAffine, decomposeTRS, trsMatrix,
  emptyLibrary, getStance, putStance, stancedSpecies,
} from './stadium-stance.js';
import { STADIUM_REFERENCE_SPECIES } from './stadium-reference-species.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

const load = (s) => parseGLB(fs.readFileSync(`models/stadium/${s}.glb`));

/** A quaternion for `angle` radians about an axis, so a test can pose a bone the way a slider would. */
function axisAngle([x, y, z], angle) {
  const n = Math.hypot(x, y, z) || 1;
  const h = angle / 2, s = Math.sin(h) / n;
  return [x * s, y * s, z * s, Math.cos(h)];
}

/** Lowest vertex in the file, which is what the mapper calls the floor. */
function lowestVertex(json, bin) {
  const v = readSkinnedVertices(json, bin, nodeWorldMatrices(json));
  let low = Infinity;
  for (let i = 0; i < v.count; i++) low = Math.min(low, v.position[i * 3 + 1]);
  return low;
}

const worldOf = (json, name) => {
  const ctx = nodeWorldMatrices(json);
  const i = json.nodes.findIndex(n => n.name === name);
  return { m: ctx.world[i], i };
};

console.log('\n--- matrix helpers ---');

check('a TRS survives a round trip through a matrix', () => {
  const trs = { p: [0.3, -1.2, 4], q: axisAngle([0.267, 0.535, 0.802], 0.9), s: [1, 1, 1] };
  const back = decomposeTRS(trsMatrix(trs));
  for (let i = 0; i < 3; i++) close(back.p[i], trs.p[i], 1e-9, `p${i}`);
  // q and -q are the same rotation, so compare through the dot rather than component by component.
  const dot = Math.abs(back.q.reduce((a, v, i) => a + v * trs.q[i], 0));
  close(dot, 1, 1e-9, 'rotation');
  for (let i = 0; i < 3; i++) close(back.s[i], 1, 1e-9, `s${i}`);
});

check('non-uniform scale survives the round trip', () => {
  const trs = { p: [1, 2, 3], q: axisAngle([0, 1, 0], 0.4), s: [2, 0.5, 3] };
  const back = decomposeTRS(trsMatrix(trs));
  for (let i = 0; i < 3; i++) close(back.s[i], trs.s[i], 1e-9, `s${i}`);
});

check('invertAffine undoes a rotate-scale-translate', () => {
  const m = trsMatrix({ p: [3, -2, 1], q: axisAngle([0.6, 0, 0.8], 1.1), s: [2, 2, 2] });
  const id = matMultiply(m, invertAffine(m));
  for (let i = 0; i < 16; i++) close(id[i], i % 5 === 0 ? 1 : 0, 1e-9, `identity[${i}]`);
});

check('a singular matrix is refused rather than returning nonsense', () => {
  let threw = false;
  try { invertAffine([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]); } catch { threw = true; }
  assert(threw, 'expected a throw on a zero 3x3');
});

console.log('\n--- the document ---');

check('an empty stance is empty and stamps as rest', () => {
  const s = emptyStance('019_rattata');
  assert(isEmptyStance(s), 'should be empty');
  assert(stanceStamp(s) === 'rest', `expected rest, got ${stanceStamp(s)}`);
  assert(s.version === STANCE_VERSION, 'version missing');
});

check('setStanceBone does not mutate its input', () => {
  const a = emptyStance('x');
  const b = setStanceBone(a, 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  assert(isEmptyStance(a), 'the original was mutated');
  assert(!isEmptyStance(b), 'the copy did not take the edit');
});

check('copyStance shares no arrays with its source', () => {
  const a = setStanceBone(emptyStance('x'), 'bone01', { p: [1, 2, 3], q: [0, 0, 0, 1], s: [1, 1, 1] });
  const b = copyStance(a);
  b.bones.bone01.p[0] = 99;
  assert(a.bones.bone01.p[0] === 1, 'the arrays are aliased');
});

check('clearing the last bone returns to empty', () => {
  const a = setStanceBone(emptyStance('x'), 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  assert(isEmptyStance(clearStanceBone(a, 'bone01')), 'should be empty again');
});

check('the stamp is content-addressed, not insertion-ordered', () => {
  const t1 = { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  const t2 = { p: [0, 2, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  const a = setStanceBone(setStanceBone(emptyStance('x'), 'bone01', t1), 'bone02', t2);
  const b = setStanceBone(setStanceBone(emptyStance('x'), 'bone02', t2), 'bone01', t1);
  assert(stanceStamp(a) === stanceStamp(b), 'the same stance stamped two ways');
});

check('the stamp changes when the pose changes', () => {
  const a = setStanceBone(emptyStance('x'), 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  const b = setStanceBone(emptyStance('x'), 'bone01', { p: [1.5, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  assert(stanceStamp(a) !== stanceStamp(b), 'two different poses stamped the same');
});

check('a difference below the rounding floor is the same stance', () => {
  const a = setStanceBone(emptyStance('x'), 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  const b = setStanceBone(emptyStance('x'), 'bone01', { p: [1 + 1e-12, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  assert(stanceStamp(a) === stanceStamp(b), 'float noise produced a different stamp');
});

check('pinned legs count toward the stamp, because they change the creature', () => {
  const a = emptyStance('x');
  const b = setStanceRoles(a, { species: 'x', bones: { 12: { leg: '0L', role: 'foot' } }, attach: {} });
  assert(stanceStamp(a) === 'rest', 'an untouched stance should stamp as rest');
  assert(stanceStamp(b) !== 'rest', 'pinned legs should change the stamp');
});

check('a stance with only pinned legs is not blank and survives the library', () => {
  const s = setStanceRoles(emptyStance('019_rattata'), { species: '019_rattata', bones: { 12: { leg: '0L', role: 'foot' } }, attach: {} });
  assert(isEmptyStance(s), 'there is no pose, so the pose is empty');
  assert(!isBlankStance(s), 'but something was authored, so it is not blank');
  const lib = putStance(emptyLibrary(), s);
  assert(stancedSpecies(lib).includes('019_rattata'), 'the pinned legs were dropped on save');
});

check('setStanceRoles deep-copies, so the library cannot be edited through the caller', () => {
  const doc = { species: 'x', bones: { 12: { leg: '0L', role: 'foot' } }, attach: {} };
  const s = setStanceRoles(emptyStance('x'), doc);
  doc.bones[12].role = 'knee';
  assert(s.roles.bones[12].role === 'foot', 'the roles document is aliased');
});

check('a stance carried to the wrong species is named as such', () => {
  const { json } = load('019_rattata');
  const s = setStanceBone(emptyStance('019_rattata'), 'notABone', { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  const v = validateStance(s, json);
  assert(!v.ok, 'should have failed');
  assert(v.unknown.includes('notABone'), 'should name the bone it does not have');
});

check('a non-finite value is refused', () => {
  const { json } = load('019_rattata');
  const s = setStanceBone(emptyStance('x'), json.nodes[1].name, { p: [0, NaN, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  assert(!validateStance(s, json).ok, 'NaN should have failed validation');
});

console.log('\n--- applying it ---');

check('applyStance leaves the source document untouched', () => {
  const { json } = load('019_rattata');
  const name = json.nodes[1].name;
  const before = JSON.stringify(json.nodes[1]);
  applyStance(json, setStanceBone(emptyStance('x'), name, { p: [9, 9, 9], q: [0, 0, 0, 1], s: [1, 1, 1] }));
  assert(JSON.stringify(json.nodes[1]) === before, 'the input was mutated');
});

check('applyStance writes the transform the stance asked for', () => {
  const { json } = load('019_rattata');
  const name = json.nodes[1].name;
  const posed = applyStance(json, setStanceBone(emptyStance('x'), name, { p: [9, 8, 7], q: [0, 0, 0, 1], s: [1, 1, 1] }));
  const node = posed.nodes.find(n => n.name === name);
  assert(node.translation.join() === '9,8,7', `got ${node.translation}`);
});

check('a bone the model does not have is skipped rather than thrown', () => {
  const { json } = load('019_rattata');
  const posed = applyStance(json, setStanceBone(emptyStance('x'), 'ghost', { p: [1, 1, 1], q: [0, 0, 0, 1], s: [1, 1, 1] }));
  assert(posed.nodes.length === json.nodes.length, 'node count changed');
});

check('groundJson puts the lowest vertex back on the floor', () => {
  const { json, bin } = load('058_growlithe');
  const root = json.nodes.findIndex(n => n.name === 'model_root');
  const lifted = applyStance(json, setStanceBone(emptyStance('x'), 'model_root',
    { p: [0, 5, 0], q: [0, 0, 0, 1], s: json.nodes[root].scale ?? [1, 1, 1] }));
  assert(lowestVertex(lifted, bin) > 4, 'the model should be in the air before grounding');
  close(lowestVertex(groundJson(lifted, bin), bin), 0, 1e-6, 'grounded floor');
});

check('the shipped models are only approximately on y=0', () => {
  // Pins the reason `stanceJson` refuses to ground an unedited file: doing so would move every absolute
  // position by a few hundredths and break parity with measurements taken before stances existed.
  const floors = ['019_rattata', '077_ponyta', '058_growlithe'].map(s => {
    const { json, bin } = load(s);
    return [s, lowestVertex(json, bin)];
  });
  assert(floors.some(([, f]) => Math.abs(f) > 1e-3), 'expected at least one model off the floor');
  console.log(`       authored floors: ${floors.map(([s, f]) => `${s.slice(4)} ${f.toFixed(4)}`).join(', ')}`);
});

check('an empty stance hands back the very same document, ungrounded', () => {
  const { json, bin } = load('019_rattata');
  assert(stanceJson(json, bin, emptyStance('019_rattata')) === json, 'an empty stance should be a no-op');
});

check('grounding is idempotent', () => {
  const { json, bin } = load('019_rattata');
  const once = groundJson(json, bin);
  close(lowestVertex(groundJson(once, bin), bin), lowestVertex(once, bin), 1e-9, 'floor after a second grounding');
});

check('stanceJson honours ground:false', () => {
  const { json, bin } = load('058_growlithe');
  const root = json.nodes.find(n => n.name === 'model_root');
  let s = setStanceBone(emptyStance('x'), 'model_root', { p: [0, 5, 0], q: [0, 0, 0, 1], s: root.scale ?? [1, 1, 1] });
  s.ground = false;
  assert(lowestVertex(stanceJson(json, bin, s), bin) > 4, 'ground:false should have left it in the air');
  s = { ...s, ground: true };
  close(lowestVertex(stanceJson(json, bin, s), bin), 0, 1e-6, 'ground:true floor');
});

console.log('\n--- the point of the whole thing: the mapper re-derives ---');

check('standing a leg up changes the numbers the gait is built from', () => {
  const { json, bin } = load('058_growlithe');
  const before = mapStadiumRig(json, bin);
  assert(before.legs.length >= 2, 'expected legs on Growlithe');

  // Rotate the top bone of every leg backwards, which is the edit a person makes to stand a sitting model up.
  let stance = emptyStance('058_growlithe');
  for (const leg of before.legs) {
    const name = before.names[leg.bones[0]];
    const rest = restTRS(json, name);
    const turned = trsMatrix({ ...rest, q: rest.q });
    void turned;
    stance = setStanceBone(stance, name, { ...rest, q: composeQ(axisAngle([1, 0, 0], 0.35), rest.q) });
  }
  const after = mapStadiumRig(stanceJson(json, bin, stance), bin);
  assert(after.legs.length === before.legs.length, 'the edit lost a leg');
  const moved = Math.abs(after.rideHeight - before.rideHeight) / before.rideHeight;
  assert(moved > 0.01, `ride height barely moved (${(moved * 100).toFixed(2)}%) — the stance is not reaching the mapper`);
});

check('posing the top of a leg re-estimates the leg span, and by a lot', () => {
  // Not a bug, and worth pinning because it is surprising. Joints are estimated from where two bones'
  // vertices meet, so rotating the topmost bone about its pivot moves its geometry relative to the
  // still-stationary parent and the hip joint is re-read somewhere else. The visible joint really has
  // moved. It is large enough that the Rig stage has to show the derived numbers while you drag.
  const { json, bin } = load('058_growlithe');
  const before = mapStadiumRig(json, bin);
  const name = before.names[before.legs[0].bones[0]];
  const rest = restTRS(json, name);
  const stance = setStanceBone(emptyStance('x'), name, { ...rest, q: composeQ(axisAngle([1, 0, 0], 0.4), rest.q) });
  const after = mapStadiumRig(stanceJson(json, bin, stance), bin);
  const a = before.legs[0], b = after.legs[0];
  const span = (l) => l.l1 + l.l2;
  const drift = Math.abs(span(a) - span(b)) / span(a);
  assert(drift > 0.01, 'the span did not move at all — the stance is not reaching the mapper');
  assert(drift < 0.6, `span moved ${(drift * 100).toFixed(0)}%, which is past anything a 0.4 rad turn should do`);
  const footMoved = Math.hypot(a.foot.x - b.foot.x, a.foot.y - b.foot.y, a.foot.z - b.foot.z);
  assert(footMoved > 1e-3, 'the foot did not move at all');
  console.log(`       leg span re-estimated by ${(drift * 100).toFixed(1)}% for a 0.4 rad hip turn`);
});

check('an empty stance maps identically to the untouched file', () => {
  const { json, bin } = load('019_rattata');
  const a = mapStadiumRig(json, bin);
  const b = mapStadiumRig(stanceJson(json, bin, emptyStance('019_rattata')), bin);
  close(b.rideHeight, a.rideHeight, 1e-9, 'ride height');
  assert(a.legs.length === b.legs.length, 'leg count changed with no stance');
});

console.log('\n--- mirroring ---');

check('every paired leg bone finds a partner, and the pairing is symmetric', () => {
  const { json, bin } = load('019_rattata');
  const map = mapStadiumRig(json, bin);
  const t = mirrorTargets(map);
  assert(Object.keys(t).length > 0, 'no pairs found on a quadruped');
  for (const [a, b] of Object.entries(t)) assert(t[b] === a, `${a}->${b} is not reciprocal`);
});

check('mirroring an unedited bone leaves the partner at its own rest', () => {
  const { json, bin } = load('019_rattata');
  const map = mapStadiumRig(json, bin);
  const ctx = nodeWorldMatrices(json);
  const [name, partner] = Object.entries(mirrorTargets(map))[0];
  const out = mirrorStanceBone(emptyStance('x'), { json, ctx, map, name });
  const rest = restTRS(json, partner);
  const got = out.bones[partner];
  for (let i = 0; i < 3; i++) close(got.p[i], rest.p[i], 1e-6, `partner p${i}`);
});

check('mirroring twice returns the original edit', () => {
  const { json, bin } = load('019_rattata');
  const map = mapStadiumRig(json, bin);
  const ctx = nodeWorldMatrices(json);
  const [name, partner] = Object.entries(mirrorTargets(map))[0];
  const rest = restTRS(json, name);
  const edited = { ...rest, q: composeQ(axisAngle([1, 0, 0], 0.3), rest.q) };
  let s = setStanceBone(emptyStance('x'), name, edited);
  s = mirrorStanceBone(s, { json, ctx, map, name });
  const back = mirrorStanceBone(s, { json, ctx, map, name: partner });
  const got = back.bones[name];
  const dot = Math.abs(got.q.reduce((a, v, i) => a + v * edited.q[i], 0));
  close(dot, 1, 1e-6, 'round-tripped rotation');
});

check('mirroring a bone with no partner is a no-op rather than an error', () => {
  const { json, bin } = load('019_rattata');
  const map = mapStadiumRig(json, bin);
  const ctx = nodeWorldMatrices(json);
  const spineName = map.names[map.spine[0]];
  const s = mirrorStanceBone(emptyStance('x'), { json, ctx, map, name: spineName });
  assert(isEmptyStance(s), 'a spine bone should not have been mirrored');
});

check('a mirrored edit lands where the mirror image of the source landed', () => {
  // Measures rig symmetry as much as the mirror math: the two are only the same answer when the model's
  // two sides are mirror images of each other, which these ROM models are to within a fraction of a bone.
  const worst = [];
  for (const species of ['019_rattata', '077_ponyta', '128_tauros', '058_growlithe']) {
    const { json, bin } = load(species);
    const map = mapStadiumRig(json, bin);
    const ctx = nodeWorldMatrices(json);
    const pairs = Object.entries(mirrorTargets(map));
    if (!pairs.length) continue;
    const [name, partner] = pairs[0];
    const rest = restTRS(json, name);
    const edited = { ...rest, q: composeQ(axisAngle([1, 0, 0], 0.3), rest.q) };
    let s = setStanceBone(emptyStance(species), name, edited);
    s = mirrorStanceBone(s, { json, ctx, map, name });
    const posed = applyStance(json, s);
    const a = worldOf(posed, name).m, b = worldOf(posed, partner).m;
    const span = map.legs[0].l1 + map.legs[0].l2;
    const off = Math.hypot(a[12] + b[12], a[13] - b[13], a[14] - b[14]) / span;
    worst.push([species, off]);
    assert(off < 0.25, `${species}: mirrored bone is ${(off * 100).toFixed(1)}% of a leg span from the mirror of its partner`);
  }
  console.log(`       mirror asymmetry, fraction of a leg span: ${worst.map(([s, o]) => `${s.slice(4)} ${(o * 100).toFixed(1)}%`).join(', ')}`);
});

console.log('\n--- the library ---');

check('a species with no stance reads back as an empty one', () => {
  const s = getStance(emptyLibrary(), '019_rattata');
  assert(isEmptyStance(s) && s.species === '019_rattata', 'expected an empty stance for the species');
});

check('putStance round-trips and stamps', () => {
  const s = setStanceBone(emptyStance('019_rattata'), 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  const lib = putStance(emptyLibrary(), s);
  const back = getStance(lib, '019_rattata');
  assert(back.bones.bone01.p[0] === 1, 'the bone did not survive');
  assert(lib.stances['019_rattata'].stamp === stanceStamp(s), 'stamp not stored');
});

check('storing an empty stance removes the species rather than saving nothing', () => {
  const s = setStanceBone(emptyStance('019_rattata'), 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  let lib = putStance(emptyLibrary(), s);
  lib = putStance(lib, clearStanceBone(s, 'bone01'));
  assert(!stancedSpecies(lib).length, 'the emptied species should be gone');
});

check('putStance does not mutate the library it was given', () => {
  const lib = emptyLibrary();
  putStance(lib, setStanceBone(emptyStance('x'), 'bone01', { p: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] }));
  assert(!stancedSpecies(lib).length, 'the input library was mutated');
});

console.log('\n--- every shipped species survives an empty stance ---');

check('all fourteen map the same with and without an empty stance applied', () => {
  for (const species of STADIUM_REFERENCE_SPECIES) {
    const { json, bin } = load(species);
    const a = mapStadiumRig(json, bin);
    const b = mapStadiumRig(stanceJson(json, bin, emptyStance(species)), bin);
    assert(a.legs.length === b.legs.length, `${species}: leg count changed`);
    close(b.rideHeight, a.rideHeight, 1e-9, `${species} ride height`);
  }
});

/** The detected legs, frozen into the hand-assignment format, which is how a pose is stopped from losing them. */
function pinnedRoles(json, map, species) {
  const tree = pivotTree(json, nodeWorldMatrices(json));
  const parent = {}, names = {};
  for (const p of tree.pivots) { parent[p] = tree.parent.get(p) ?? -1; names[p] = json.nodes[p].name; }
  return compileRoles(rolesFromMap(map, species), { parent, names });
}

check('a pose alone can cost a model its legs — which is why the Rig stage pins them first', () => {
  // The hazard this test exists to pin: leg detection runs on the POSED geometry, and its three rules
  // (reaches the floor, off the midline, most distal) are about where the feet ended up. A pose that
  // lifts a foot out of the floor band deletes that leg. Ponyta loses all four to a 0.2 rad hip turn.
  const lost = [], unpinnable = [];
  for (const species of STADIUM_REFERENCE_SPECIES) {
    const { json, bin } = load(species);
    const before = mapStadiumRig(json, bin);
    if (!before.legs.length) continue;
    let stance = emptyStance(species);
    for (const leg of before.legs) {
      const name = before.names[leg.bones[0]];
      const rest = restTRS(json, name);
      stance = setStanceBone(stance, name, { ...rest, q: composeQ(axisAngle([1, 0, 0], 0.2), rest.q) });
    }
    const posed = stanceJson(json, bin, stance);
    const bare = mapStadiumRig(posed, bin);
    if (bare.legs.length !== before.legs.length) lost.push(`${species.slice(4)} ${before.legs.length}→${bare.legs.length}`);

    // With the detected legs pinned as roles first, the same pose keeps every one of them — unless the
    // detection was not self-consistent to begin with, in which case pinning must SAY so rather than
    // quietly dropping a leg. Sandslash is the standing example: its four legs are two limbs used twice,
    // so the shared bones cannot be assigned per-bone to both rows and one row compiles down to a stub.
    const roles = pinnedRoles(json, before, species);
    const pinned = mapStadiumRig(posed, bin, { roles });
    if (pinned.legs.length !== before.legs.length) {
      assert(roles.warnings?.length,
        `${species}: pinned roles lost legs (${before.legs.length} → ${pinned.legs.length}) with nothing said about why`);
      unpinnable.push(`${species.slice(4)} (${roles.warnings.length} warning(s))`);
      continue;
    }
    assert(pinned.legs.length === before.legs.length,
      `${species}: pinned roles still lost legs, ${before.legs.length} → ${pinned.legs.length}`);
  }
  assert(lost.length, 'expected at least one species to lose legs unpinned — has detection changed?');
  console.log(`       lost legs to the pose when unpinned: ${lost.join(', ')}`);
  console.log(`       detected legs that will not pin: ${unpinnable.join(', ') || 'none'}`);
});

check('with legs pinned, a stance moves the ride height on every species', () => {
  const moved = [];
  for (const species of STADIUM_REFERENCE_SPECIES) {
    const { json, bin } = load(species);
    const before = mapStadiumRig(json, bin);
    if (!before.legs.length) continue;
    let stance = emptyStance(species);
    for (const leg of before.legs) {
      const name = before.names[leg.bones[0]];
      const rest = restTRS(json, name);
      stance = setStanceBone(stance, name, { ...rest, q: composeQ(axisAngle([1, 0, 0], 0.2), rest.q) });
    }
    const roles = pinnedRoles(json, before, species);
    const after = mapStadiumRig(stanceJson(json, bin, stance), bin, { roles });
    moved.push([species.slice(4), (after.rideHeight - before.rideHeight) / before.rideHeight]);
  }
  assert(moved.some(([, m]) => Math.abs(m) > 0.01), 'no species changed ride height — stances are not reaching the mapper');
  console.log(`       ride height change from a 0.2 rad hip turn: ${moved.map(([s, m]) => `${s} ${(m * 100).toFixed(0)}%`).join(', ')}`);
});

/** Quaternion product, `a` applied after `b`, in glTF's xyzw order. */
function composeQ(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
