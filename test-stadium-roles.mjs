// Node checks for hand-assigned bone roles. Run with `node test-stadium-roles.mjs`.
//
// Two halves: `compileRoles` on synthetic skeletons, where every mistake a person can make with a click
// is cheap to construct, and then the real models, where the point is that a role document can correct
// the two species the auto-mapper is known to get wrong.

import fs from 'node:fs';
import { parseGLB, nodeWorldMatrices } from './stadium-glb.js';
import { mapStadiumRig, pivotTree } from './stadium-rig-map.js';
import {
  legKey, parseLegKey, emptyRoles, rolesFromMap, assignBone, setAttach, legKeys,
  orderChain, compileRoles, rolesEqual,
} from './stadium-rig-roles.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const load = (s) => {
  const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${s}.glb`));
  return { json, bin };
};
/** Parent lookup in the shape `compileRoles` wants: a plain object, pivot bones only. */
function parentOf(json) {
  const tree = pivotTree(json, nodeWorldMatrices(json));
  const out = {};
  for (const p of tree.pivots) out[p] = tree.parent.get(p) ?? -1;
  return out;
}

// A straight chain 0 -> 1 -> 2 -> 3 on each side, hanging off 100 (left) and 101 (right).
const TOY = { 100: -1, 101: -1, 0: 100, 1: 0, 2: 1, 3: 2, 10: 101, 11: 10, 12: 11, 13: 12 };
function toyDoc() {
  let d = emptyRoles('toy');
  for (const [b, role] of [[0, 'leg'], [1, 'knee'], [2, 'leg'], [3, 'foot']]) d = assignBone(d, b, { leg: '0L', role });
  for (const [b, role] of [[10, 'leg'], [11, 'knee'], [12, 'leg'], [13, 'foot']]) d = assignBone(d, b, { leg: '0R', role });
  return d;
}

// ===================== keys =====================

check('a leg key round-trips through row and side', () => {
  for (const [row, side] of [[0, -1], [0, 1], [2, -1], [11, 1]]) {
    const p = parseLegKey(legKey(row, side));
    assert(p && p.row === row && p.side === side, `${row}/${side} did not survive ${legKey(row, side)}`);
  }
  assert(parseLegKey('nonsense') === null, 'a bad key should be null, not a guess');
});

check('leg keys come back in a stable row-then-side order', () => {
  let d = emptyRoles();
  for (const [b, key] of [[0, '1R'], [1, '0R'], [2, '1L'], [3, '0L']]) d = assignBone(d, b, { leg: key, role: 'leg' });
  assert(legKeys(d).join(',') === '0L,0R,1L,1R', `got ${legKeys(d).join(',')}`);
});

// ===================== ordering =====================

check('a chain is ordered proximal to distal regardless of assignment order', () => {
  assert(orderChain([3, 1, 0, 2], TOY).join(',') === '0,1,2,3', 'not sorted by depth');
  assert(orderChain([2, 3], TOY).join(',') === '2,3', 'a partial chain should still order');
});

check('bones from two different limbs are refused, not silently ordered', () => {
  // The mistake a click-to-assign UI makes easiest: one bone from the other side.
  assert(orderChain([0, 1, 11], TOY) === null, 'a forked set should not compile');
  assert(orderChain([0, 2], TOY) === null, 'a chain with a hole should not compile');
  assert(orderChain([], TOY) === null, 'an empty set is not a chain');
});

// ===================== compiling =====================

check('a clean document compiles to legs with a knee and a foot', () => {
  const { legs, warnings } = compileRoles(toyDoc(), { parent: TOY });
  assert(!warnings.length, `unexpected warnings: ${warnings.join('; ')}`);
  assert(legs.length === 2, `expected two legs, got ${legs.length}`);
  const l = legs.find(x => x.side === -1);
  assert(l.bones.join(',') === '0,1,2,3', `bones ${l.bones}`);
  assert(l.kneeIndex === 1, `kneeIndex ${l.kneeIndex}`);
  assert(l.footBones.join(',') === '3', `footBones ${l.footBones}`);
  assert(l.attach === 100, `attach ${l.attach}`);
});

check('several bones can be the foot', () => {
  // The case that motivated all of this: a foot is a metatarsal plus a toe, not one bone.
  let d = toyDoc();
  d = assignBone(d, 2, { leg: '0L', role: 'foot' });
  const { legs, warnings } = compileRoles(d, { parent: TOY });
  assert(!warnings.length, warnings.join('; '));
  assert(legs.find(l => l.side === -1).footBones.join(',') === '2,3', 'both bones should be the foot');
});

check('a foot that is not the end of the chain is refused', () => {
  let d = toyDoc();
  d = assignBone(d, 1, { leg: '0L', role: 'foot' });   // knee position, above a plain leg bone
  const { legs, warnings } = compileRoles(d, { parent: TOY });
  assert(warnings.some(w => /not the end of the chain/.test(w)), `got ${warnings.join('; ')}`);
  assert(!legs.some(l => l.side === -1), 'the bad leg should not have compiled');
});

check('the knee cannot be the top bone', () => {
  let top = assignBone(toyDoc(), 0, { leg: '0L', role: 'knee' });
  top = assignBone(top, 1, { leg: '0L', role: 'leg' });
  assert(compileRoles(top, { parent: TOY }).warnings.some(w => /topmost/.test(w)), 'top-bone knee allowed');
});

check('a knee below the start of the foot is refused by the end-of-chain rule', () => {
  // There is deliberately no separate "knee inside the foot" check. A bone carries exactly one role, so
  // the only way to place a knee below the first foot bone is to leave a non-foot bone inside the foot's
  // span, which the end-of-chain rule already refuses. A second check for it would be unreachable.
  let d = assignBone(toyDoc(), 1, { leg: '0L', role: 'leg' });   // clear the real knee
  d = assignBone(d, 2, { leg: '0L', role: 'foot' });             // foot is now 2 and 3...
  d = assignBone(d, 3, { leg: '0L', role: 'knee' });             // ...with a knee at its far end
  const w = compileRoles(d, { parent: TOY }).warnings;
  assert(w.some(x => /not the end of the chain/.test(x)), `got ${w.join('; ') || '(nothing)'}`);
});

check('a leg of one bone is refused, because the solver is two-bone', () => {
  // It compiled clean until 2026-08-16 and reached the mapper, which put the knee joint on the sole and
  // gave the lower segment length 0.
  let d = emptyRoles('toy');
  d = assignBone(d, 3, { leg: '0L', role: 'foot' });
  d = assignBone(d, 13, { leg: '0R', role: 'foot' });
  const { legs, warnings } = compileRoles(d, { parent: TOY });
  assert(!legs.length, 'a one-bone leg was compiled');
  assert(warnings.filter(w => /two-bone leg/.test(w)).length === 2, warnings.join('; ') || '(no warning)');
});

check('two knees on one leg is refused rather than one being picked', () => {
  const d = assignBone(toyDoc(), 2, { leg: '0L', role: 'knee' });
  assert(compileRoles(d, { parent: TOY }).warnings.some(w => /only one may be/.test(w)), 'two knees allowed');
});

check('no knee at all is legal, and leaves the split to the mapper', () => {
  const d = assignBone(toyDoc(), 1, { leg: '0L', role: 'leg' });
  const leg = compileRoles(d, { parent: TOY }).legs.find(l => l.side === -1);
  assert(leg && leg.kneeIndex === undefined, `kneeIndex should be undefined, got ${leg?.kneeIndex}`);
});

check('an unpaired row is reported', () => {
  let d = emptyRoles();
  for (const [b, role] of [[0, 'leg'], [1, 'knee'], [2, 'foot']]) d = assignBone(d, b, { leg: '0L', role });
  assert(compileRoles(d, { parent: TOY }).warnings.some(w => /not a pair/.test(w)), 'a lone leg passed');
});

check('a bone claimed by two legs is named', () => {
  // Sandslash in miniature: the same bones assigned to two limbs.
  let d = toyDoc();
  d = assignBone(d, 3, { leg: '0R', role: 'foot' });
  const { warnings } = compileRoles(d, { parent: TOY, names: { 3: 'bone03' } });
  assert(warnings.some(w => /bone03/.test(w) || /do not form one unbroken chain/.test(w)),
    `expected the shared bone to be named, got ${warnings.join('; ')}`);
});

check('an attach that is also a leg bone is refused', () => {
  const d = setAttach(toyDoc(), '0L', 1);
  assert(compileRoles(d, { parent: TOY }).warnings.some(w => /its own bones/.test(w)), 'self-attach allowed');
});

check('an explicit attach overrides the parent chain', () => {
  const d = setAttach(toyDoc(), '0L', 101);
  assert(compileRoles(d, { parent: TOY }).legs.find(l => l.side === -1).attach === 101, 'attach not honoured');
});

check('rolesEqual sees a role change, not just a bone change', () => {
  const a = toyDoc();
  assert(rolesEqual(a, toyDoc()), 'identical documents compared unequal');
  assert(!rolesEqual(a, assignBone(a, 2, { leg: '0L', role: 'foot' })), 'a role change was missed');
  assert(!rolesEqual(a, assignBone(a, 3, { leg: '0R', role: 'foot' })), 'a leg change was missed');
  assert(!rolesEqual(a, setAttach(a, '0L', 999)), 'an attach change was missed');
});

// ===================== against the real models =====================

check('capturing the mapper and compiling it back reproduces the same legs', () => {
  // The round trip an editor depends on: opening the panel must not change the creature.
  for (const s of ['019_rattata', '077_ponyta', '025_pikachu']) {
    const { json, bin } = load(s);
    const map = mapStadiumRig(json, bin, { source: s });
    const { legs, warnings } = compileRoles(rolesFromMap(map), { parent: parentOf(json), names: map.names });
    assert(!warnings.length, `${s}: ${warnings.join('; ')}`);
    assert(legs.length === map.legs.length, `${s}: ${legs.length} legs against ${map.legs.length}`);
    for (const before of map.legs) {
      const after = legs.find(l => l.row === before.row && l.side === before.side);
      assert(after, `${s}: lost leg ${before.row}/${before.side}`);
      assert(after.bones.join(',') === before.bones.join(','), `${s}: leg ${before.row}/${before.side} bones moved`);
      assert(after.kneeIndex === before.kneeIndex, `${s}: knee moved from ${before.kneeIndex} to ${after.kneeIndex}`);
      assert(after.attach === before.attach, `${s}: attach moved`);
    }
  }
});

check('feeding those legs back through the mapper rebuilds the same geometry', () => {
  for (const s of ['019_rattata', '128_tauros']) {
    const { json, bin } = load(s);
    const plain = mapStadiumRig(json, bin, { source: s });
    const roles = compileRoles(rolesFromMap(plain), { parent: parentOf(json), names: plain.names });
    const remapped = mapStadiumRig(json, bin, { source: s, roles });
    assert(remapped.legs.length === plain.legs.length, `${s}: leg count changed`);
    for (const a of plain.legs) {
      const b = remapped.legs.find(l => l.row === a.row && l.side === a.side);
      const d = Math.hypot(a.foot.x - b.foot.x, a.foot.y - b.foot.y, a.foot.z - b.foot.z);
      assert(d < 1e-9, `${s}: leg ${a.row}/${a.side} foot moved ${d}`);
      assert(Math.abs(a.l1 - b.l1) < 1e-9 && Math.abs(a.l2 - b.l2) < 1e-9, `${s}: bone lengths changed`);
    }
  }
});

check('a declared foot of several bones moves the contact point off the toe', () => {
  // The whole reason `sole` takes a list. Measured across all fourteen shipped models, calling the last
  // two bones the foot moves the contact point 2% to 29% of a leg span — it is not a rounding change.
  for (const s of ['019_rattata', '086_seel', '128_tauros']) {
    const { json, bin } = load(s);
    const plain = mapStadiumRig(json, bin, { source: s });
    const leg = plain.legs.find(l => l.bones.length >= 3) || plain.legs[0];

    let doc = rolesFromMap(plain);
    const extra = leg.bones[leg.bones.length - 2];
    const key = legKey(leg.row, leg.side);
    if (doc.bones[extra]?.role === 'knee') doc = assignBone(doc, leg.bones[1], { leg: key, role: 'knee' });
    doc = assignBone(doc, extra, { leg: key, role: 'foot' });
    const roles = compileRoles(doc, { parent: parentOf(json), names: plain.names });
    assert(!roles.warnings.length, `${s}: ${roles.warnings.join('; ')}`);

    const after = mapStadiumRig(json, bin, { source: s, roles })
      .legs.find(l => l.row === leg.row && l.side === leg.side);
    assert(after.footBones.length === 2, `${s}: expected two foot bones, got ${after.footBones.length}`);
    const moved = Math.hypot(after.foot.x - leg.foot.x, after.foot.z - leg.foot.z) / leg.span;
    assert(moved > 0.01, `${s}: the contact point moved only ${(moved * 100).toFixed(2)}% of a leg`);
    assert(moved < 0.5, `${s}: the contact point moved ${(moved * 100).toFixed(0)}% of a leg`);
  }
});

check('Pikachu\'s two extra foot bones are degenerate, which is why that leg maps badly', () => {
  // Found while testing the multi-bone sole: it moves the contact point on every leg of every model
  // EXCEPT this one, where it moves it by 2e-16. Bones 59 and 61 carry 48 vertices between them and every
  // one of the lowest sits at the same x and z, so the two bones are a collapsed point rather than a foot.
  // That is the same leg `rig-audit.js` reports as six bones against the other side's four.
  const { json, bin } = load('025_pikachu');
  const map = mapStadiumRig(json, bin, { source: '025_pikachu' });
  const long = map.legs.reduce((m, l) => (l.bones.length > m.bones.length ? l : m), map.legs[0]);
  const short = map.legs.find(l => l !== long);
  assert(long.bones.length > short.bones.length, 'expected one leg to be longer than its partner');

  let doc = rolesFromMap(map);
  const extra = long.bones[long.bones.length - 2];
  doc = assignBone(doc, extra, { leg: legKey(long.row, long.side), role: 'foot' });
  const roles = compileRoles(doc, { parent: parentOf(json), names: map.names });
  const after = mapStadiumRig(json, bin, { source: '025_pikachu', roles })
    .legs.find(l => l.row === long.row && l.side === long.side);
  const moved = Math.hypot(after.foot.x - long.foot.x, after.foot.z - long.foot.z) / long.span;
  assert(moved < 1e-9, `expected a degenerate foot, but the contact point moved ${(moved * 100).toFixed(2)}%`);
});

check('a declared knee overrides the equal-halves split', () => {
  const s = '128_tauros';
  const { json, bin } = load(s);
  const plain = mapStadiumRig(json, bin, { source: s });
  const leg = plain.legs.find(l => l.bones.length >= 4) || plain.legs[0];
  const want = leg.kneeIndex === 1 ? 2 : 1;

  let doc = rolesFromMap(plain);
  const key = legKey(leg.row, leg.side);
  for (const b of leg.bones) if (doc.bones[b]?.role === 'knee') doc = assignBone(doc, b, { leg: key, role: 'leg' });
  doc = assignBone(doc, leg.bones[want], { leg: key, role: 'knee' });

  const roles = compileRoles(doc, { parent: parentOf(json), names: plain.names });
  assert(!roles.warnings.length, roles.warnings.join('; '));
  const after = mapStadiumRig(json, bin, { source: s, roles }).legs.find(l => l.row === leg.row && l.side === leg.side);
  assert(after.kneeIndex === want, `knee stayed at ${after.kneeIndex}, wanted ${want}`);
  assert(Math.abs(after.l1 - leg.l1) > 1e-9, 'the knee moved but the bone lengths did not');
});

check('Sandslash can be corrected into two limbs', () => {
  // `rig-audit.js` reports Sandslash's four legs as two limbs sharing their first three bones. Nothing
  // could act on that before. Here the shared prefix is assigned to one leg per side and the result
  // compiles clean, which is the whole point of the layer.
  const s = '028_sandslash';
  const { json, bin } = load(s);
  const plain = mapStadiumRig(json, bin, { source: s });
  const parent = parentOf(json);

  const bySide = new Map();
  for (const l of plain.legs) if (!bySide.has(l.side)) bySide.set(l.side, l);
  let doc = emptyRoles(s);
  for (const [side, leg] of bySide) {
    const key = legKey(0, side);
    leg.bones.forEach((b, i) => doc = assignBone(doc, b, {
      leg: key, role: i === leg.bones.length - 1 ? 'foot' : (i === leg.kneeIndex ? 'knee' : 'leg'),
    }));
    doc = setAttach(doc, key, leg.attach);
  }
  const roles = compileRoles(doc, { parent, names: plain.names });
  assert(!roles.warnings.length, `expected a clean two-limb document, got ${roles.warnings.join('; ')}`);
  const remapped = mapStadiumRig(json, bin, { source: s, roles });
  assert(remapped.legs.length === 2, `expected two legs, got ${remapped.legs.length}`);
  const claimed = remapped.legs.flatMap(l => l.bones);
  assert(new Set(claimed).size === claimed.length, 'the corrected legs still share bones');
});

check('a role document that names nothing leaves the mapper alone', () => {
  const { json, bin } = load('019_rattata');
  const plain = mapStadiumRig(json, bin);
  const empty = mapStadiumRig(json, bin, { roles: { legs: [] } });
  assert(empty.legs.length === plain.legs.length, 'an empty document should not disable the heuristics');
});

console.log('stadium bone roles');
console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
