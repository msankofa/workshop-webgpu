// test-bot-limb-map.mjs — anatomical identity for a hit part.
//
// The module is pure and reference-keyed, so the whole thing is testable against a stand-in rig with
// the same SHAPE as player-procedural-body.js's `parts` tree. What is asserted here is the two things
// that actually go wrong: the visual/internal side mirror, and gear being a hit target that sits
// outside the limb it covers.
//
// Run: node test-bot-limb-map.mjs

import {
  LIMBS, SEVERABLE_LIMBS, buildLimbMap, limbForPart, limbIdForPart, isSeverable, partsOfLimb,
} from './bot-limb-map.js';

let failures = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}

// ---- a stand-in rig ----
// Mirrors makePart's output: a transform-only Object3D carrying geometry and a MATERIAL role. The
// roles are deliberately shared across limbs, because that sharing is why _role cannot identify a limb.
let uid = 0;
function part(role = 'shell') {
  return { isObject3D: true, visible: true, parent: null, _role: role, _id: `p${uid++}` };
}
function attach(child, parent) { child.parent = parent; return child; }

function makeArm() {
  return {
    chain: { solve() {} },              // a solver, not a part
    target: { x: 0, y: 0, z: 0 },       // a vector, not a part
    shoulder: part('plate'), upper: part('shell'), elbow: part('trim'),
    lower: part('shell'), wrist: part('trim'), hand: part('shell'),
  };
}
function makeLeg() {
  return {
    chain: { solve() {} },
    hip: part('plate'), upper: part('shell'), knee: part('trim'),
    lower: part('shell'), ankle: part('trim'), foot: part('shell'),
  };
}

function makeBody() {
  // Internal sides, exactly as player-procedural-body.js builds them.
  const armsInternal = { left: makeArm(), right: makeArm() };
  const legsInternal = { left: makeLeg(), right: makeLeg() };
  const core = {
    pelvis: part('plate'), waist: part('shell'), torso: part('shell'),
    neck: part('trim'), head: part('shell'), eyes: [part('light'), part('light')],
  };
  // Gear hangs off an ANCHOR which hangs off its host, so the host is two links up, not one.
  const gear = [];
  const gearOn = (host, role = 'plate') => {
    const anchor = { isObject3D: true, visible: true, parent: host };
    const g = attach(part(role), anchor);
    gear.push(g);
    return g;
  };
  const helmet = gearOn(core.head);
  // gearHosts uses INTERNAL naming: `handL` is the internal RIGHT hand, i.e. the VISUAL left hand.
  const pauldron = gearOn(armsInternal.right.shoulder);
  const glove = gearOn(armsInternal.right.hand);
  const boot = gearOn(legsInternal.right.foot);
  const parts = {
    core,
    // The mirror: visual left is wired to the internal right, same as the real rig.
    arms: { left: armsInternal.right, right: armsInternal.left },
    legs: { left: legsInternal.right, right: legsInternal.left },
    gear,
    all: [],
  };
  for (const side of ['left', 'right']) {
    for (const k of ['shoulder', 'upper', 'elbow', 'lower', 'wrist', 'hand']) parts.all.push(parts.arms[side][k]);
    for (const k of ['hip', 'upper', 'knee', 'lower', 'ankle', 'foot']) parts.all.push(parts.legs[side][k]);
  }
  parts.all.push(core.pelvis, core.waist, core.torso, core.neck, core.head, ...core.eyes, ...gear);
  return { body: { parts }, armsInternal, legsInternal, core, helmet, pauldron, glove, boot };
}

const rig = makeBody();
const map = buildLimbMap(rig.body);

// ---- 1. the side mirror ----
// This is the assertion that matters most: reading the internal rig instead of `parts` swaps every
// left and right, and a limb-loss feature that gets this wrong removes the wrong arm.
check('mirror: visual left arm is the INTERNAL right arm',
  limbIdForPart(map, rig.armsInternal.right.upper), 'leftArm');
check('mirror: visual right arm is the INTERNAL left arm',
  limbIdForPart(map, rig.armsInternal.left.upper), 'rightArm');
check('mirror: visual left leg is the INTERNAL right leg',
  limbIdForPart(map, rig.legsInternal.right.lower), 'leftLeg');
check('mirror: visual right leg is the INTERNAL left leg',
  limbIdForPart(map, rig.legsInternal.left.lower), 'rightLeg');

// ---- 2. every named slot resolves, and to the right segment ----
{
  let allMapped = true, wrongSegment = null;
  for (const [limb, source, names] of [
    ['leftArm', rig.armsInternal.right, ['shoulder', 'upper', 'elbow', 'lower', 'wrist', 'hand']],
    ['rightLeg', rig.legsInternal.left, ['hip', 'upper', 'knee', 'lower', 'ankle', 'foot']],
  ]) {
    for (const seg of names) {
      const e = limbForPart(map, source[seg]);
      if (!e) { allMapped = false; continue; }
      if (e.limb !== limb || e.segment !== seg) wrongSegment = `${seg} -> ${e.limb}/${e.segment}`;
    }
  }
  checkTrue('slots: every arm and leg segment is mapped', allMapped);
  checkTrue('slots: each maps to its own segment name', wrongSegment === null, `${wrongSegment}`);
}
check('slots: torso is core', limbIdForPart(map, rig.core.torso), 'core');
check('slots: neck is core, not head', limbIdForPart(map, rig.core.neck), 'core');
check('slots: head is head', limbIdForPart(map, rig.core.head), 'head');
check('slots: eyes ride the head', limbIdForPart(map, rig.core.eyes[1]), 'head');

// ---- 3. non-parts are not mapped ----
// `chain` and `target` sit in the same slot object as the parts and would otherwise be swept in.
check('non-parts: an IK chain is not a part', limbForPart(map, rig.armsInternal.right.chain), null);
check('non-parts: an arm target is not a part', limbForPart(map, rig.armsInternal.right.target), null);
check('non-parts: a foreign object resolves to null', limbForPart(map, { isObject3D: true }), null);
check('non-parts: null is safe', limbForPart(map, null), null);

// ---- 4. gear is a hit target and inherits its host ----
// A helmet is the OUTERMOST head geometry, so most head hits strike gear, not the head part. If gear
// did not inherit, every headshot would resolve to "unknown limb".
check('gear: a helmet reads as a head hit', limbIdForPart(map, rig.helmet), 'head');
check('gear: and is tagged as gear, not as the head part itself',
  limbForPart(map, rig.helmet).segment, 'gear');
check('gear: a pauldron on the internal right shoulder is the VISUAL left arm',
  limbIdForPart(map, rig.pauldron), 'leftArm');
check('gear: a glove follows its hand', limbIdForPart(map, rig.glove), 'leftArm');
check('gear: a boot follows its foot', limbIdForPart(map, rig.boot), 'leftLeg');
{
  const unmapped = rig.body.parts.all.filter((p) => !map.has(p));
  checkTrue('gear: no part in parts.all is left unmapped', unmapped.length === 0, `${unmapped.length} unmapped`);
}

// ---- 5. severability ----
check('sever: an arm can be lost', isSeverable('leftArm'), true);
check('sever: a leg can be lost', isSeverable('rightLeg'), true);
check('sever: the head is not in the severable set', isSeverable('head'), false);
check('sever: nor is the trunk', isSeverable('core'), false);
checkTrue('sever: LIMBS covers every severable id', [...SEVERABLE_LIMBS].every((l) => LIMBS.includes(l)));

// ---- 6. the sever sweep keeps the stump ----
{
  const doomed = partsOfLimb(map, 'leftArm');
  const set = new Set(doomed);
  checkTrue('sweep: the shoulder survives as the stump cap',
    !set.has(rig.armsInternal.right.shoulder));
  checkTrue('sweep: the shoulder pauldron survives with it', !set.has(rig.pauldron));
  checkTrue('sweep: the upper arm goes', set.has(rig.armsInternal.right.upper));
  checkTrue('sweep: the hand goes', set.has(rig.armsInternal.right.hand));
  checkTrue('sweep: the glove goes with the hand', set.has(rig.glove));
  checkTrue('sweep: nothing from the other arm is touched',
    !set.has(rig.armsInternal.left.upper) && !set.has(rig.armsInternal.left.hand));
  checkTrue('sweep: nothing from the trunk is touched', !set.has(rig.core.torso));
  const bare = partsOfLimb(map, 'leftArm', { keepProximal: false });
  checkTrue('sweep: keepProximal:false takes the shoulder too',
    new Set(bare).has(rig.armsInternal.right.shoulder));
  check('sweep: an unknown limb sweeps nothing', partsOfLimb(map, 'tail').length, 0);
}

// ---- 7. malformed input does not throw ----
{
  check('robust: a body with no parts yields an empty map', buildLimbMap({}).size, 0);
  check('robust: null body yields an empty map', buildLimbMap(null).size, 0);
  check('robust: a null map lookup is null', limbForPart(null, rig.core.head), null);
  // A parent cycle is not something the rig builds, but an unbounded walk would hang the whole frame.
  const a = part(), b = part();
  a.parent = b; b.parent = a;
  const cyc = buildLimbMap({ parts: { core: { torso: part() }, all: [a, b] } });
  checkTrue('robust: a parent cycle terminates instead of hanging', cyc.size >= 1);
}

console.log(failures === 0 ? '\nAll limb-map checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
