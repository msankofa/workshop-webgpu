// Guards demos/pose-retarget.html, which drives the REAL procedural soldier from borrowed CC0
// animation clips.
//
// Three parts:
//   1. Pure math and rig facts — always runs.
//   2. The real body from ../player-procedural-body.js, built headlessly. This is possible because
//      that module takes THREE as a parameter and needs no renderer, and it is what pins down the
//      side-mirror behaviour of setRagdollPose that no amount of reading the names would settle.
//   3. The upstream Pirate Nation rig, over the network. SKIPS rather than fails when offline.
//
//   node test-pose-retarget.mjs

import * as THREE from 'three';
import { createProceduralPlayerBody, BODY_DESIGN_DEFAULTS } from './player-procedural-body.js';
import { setBotBodyKind, botDesignForRole, SOLDIER_ROLE_DESIGNS } from './bot-body-design.js';
import fs from 'node:fs';
import { getWeapon } from './weapons.js';
import { resolveWeaponHold } from './weapon-hold-resolver.js';

let fail = 0, skipped = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const skip = (msg) => { console.log(`SKIP  ${msg}`); skipped++; };

// ---------------------------------------------------------------------------
// 1. The name normaliser and slot table, copied from the demo.
// ---------------------------------------------------------------------------

const normalizeBone = (name) => String(name || '').toLowerCase().split(/[:|]/).pop()
  .replace(/[._]\d+$/, '').replace(/^mixamorig\d*/, '').replace(/[^a-z0-9]/g, '');

const SLOTS = {
  hips: ['hips', 'body', 'pelvis'],
  chest: ['chest', 'spine2', 'torax', 'upperchest'],
  head: ['head'],
  leftUpperArm: ['upperarml', 'leftarm', 'arml', 'leftupperarm'],
  leftLowerArm: ['lowerarml', 'leftforearm', 'forearml', 'leftlowerarm'],
  leftHand: ['wristl', 'lefthand', 'handl', 'leftwrist'],
  rightUpperArm: ['upperarmr', 'rightarm', 'armr', 'rightupperarm'],
  rightLowerArm: ['lowerarmr', 'rightforearm', 'forearmr', 'rightlowerarm'],
  rightHand: ['wristr', 'righthand', 'handr', 'rightwrist'],
  leftUpperLeg: ['upperlegl', 'leftupleg', 'legl', 'leftupperleg', 'thighl'],
  leftLowerLeg: ['lowerlegl', 'leftleg', 'leftlowerleg', 'calfl'],
  leftFoot: ['footl', 'leftfoot'],
  rightUpperLeg: ['upperlegr', 'rightupleg', 'legr', 'rightupperleg', 'thighr'],
  rightLowerLeg: ['lowerlegr', 'rightleg', 'rightlowerleg', 'calfr'],
  rightFoot: ['footr', 'rightfoot'],
};
const SLOT_IDS = Object.keys(SLOTS);

function resolveSlots(names) {
  const byName = new Map();
  for (const n of names) {
    const key = normalizeBone(n);
    if (key && !byName.has(key)) byName.set(key, n);
  }
  const found = new Map();
  for (const [slot, aliases] of Object.entries(SLOTS)) {
    for (const alias of aliases) if (byName.has(alias)) { found.set(slot, byName.get(alias)); break; }
  }
  return found;
}

// The three rigs the demo has to swallow, by their real bone names.
const RIGS = {
  'Pirate Nation': ['Root', 'Body', 'Chest', 'Head', 'Arm.L', 'ForeArm.L', 'Hand.L',
    'Arm.R', 'ForeArm.R', 'Hand.R', 'Leg.L', 'LowerLeg.L', 'Foot.L', 'Leg.R', 'LowerLeg.R', 'Foot.R'],
  KayKit: ['root', 'hips', 'spine', 'chest', 'upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l', 'handslot.l',
    'upperarm.r', 'lowerarm.r', 'wrist.r', 'hand.r', 'handslot.r', 'head',
    'upperleg.r', 'lowerleg.r', 'foot.r', 'toes.r', 'upperleg.l', 'lowerleg.l', 'foot.l', 'toes.l'],
  Mixamo: ['_rootJoint', 'mixamorig1:Hips_01', 'mixamorig1:Spine_02', 'mixamorig1:Spine1_03',
    'mixamorig1:Spine2_04', 'mixamorig1:Neck_05', 'mixamorig1:Head_06', 'mixamorig1:LeftShoulder_07',
    'mixamorig1:LeftArm_08', 'mixamorig1:LeftForeArm_09', 'mixamorig1:LeftHand_010',
    'mixamorig1:LeftHandThumb1_011', 'mixamorig1:LeftHandIndex1_014',
    'mixamorig1:RightShoulder_026', 'mixamorig1:RightArm_027', 'mixamorig1:RightForeArm_028',
    'mixamorig1:RightHand_029', 'mixamorig1:LeftUpLeg_045', 'mixamorig1:LeftLeg_046',
    'mixamorig1:LeftFoot_047', 'mixamorig1:LeftToeBase_048', 'mixamorig1:RightUpLeg_049',
    'mixamorig1:RightLeg_050', 'mixamorig1:RightFoot_051', 'mixamorig1:RightToeBase_052'],
};

for (const [rig, names] of Object.entries(RIGS)) {
  const found = resolveSlots(names);
  const missing = SLOT_IDS.filter(s => !found.has(s));
  ok(missing.length === 0, `${rig}: all ${SLOT_IDS.length} canonical slots resolve${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
}

// The fuzziness trap: a finger must never answer to the hand slot.
ok(resolveSlots(RIGS.Mixamo).get('leftHand') === 'mixamorig1:LeftHand_010',
  'Mixamo leftHand resolves to the hand, not to a thumb or index bone');
// KayKit ships wrist.l AND its child hand.l; the arm chain ends at the wrist.
ok(resolveSlots(RIGS.KayKit).get('leftHand') === 'wrist.l',
  'KayKit leftHand prefers wrist.l over its child hand.l (alias order matters)');
ok(resolveSlots(RIGS['Pirate Nation']).get('leftUpperLeg') === 'Leg.L'
  && resolveSlots(RIGS['Pirate Nation']).get('leftLowerLeg') === 'LowerLeg.L',
  'Pirate Nation Leg.L and LowerLeg.L do not collide');

// ---------------------------------------------------------------------------
// 2. The real soldier body.
// ---------------------------------------------------------------------------

setBotBodyKind('soldier');
const scene = new THREE.Scene();
const body = createProceduralPlayerBody({
  THREE, scene, terrainHeight: () => 0, mode: 'remote', design: botDesignForRole('rifleman'),
});

ok(typeof body.setRagdollPose === 'function', 'the soldier body exposes setRagdollPose');
ok(body.limbLengths.legLen > 0, `body reports a leg length to scale against (${body.limbLengths.legLen} m)`);
ok(Object.keys(SOLDIER_ROLE_DESIGNS).length >= 3,
  `soldier roles available: ${Object.keys(SOLDIER_ROLE_DESIGNS).join(', ')}`);

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const basePose = () => ({
  pelvis: V(0, 1.00, 0), chest: V(0, 1.35, 0), neck: V(0, 1.52, 0), head: V(0, 1.66, 0),
  shoulderL: V(0.20, 1.45, 0), elbowL: V(0.30, 1.20, 0), handL: V(0.35, 0.95, 0),
  shoulderR: V(-0.20, 1.45, 0), elbowR: V(-0.30, 1.20, 0), handR: V(-0.35, 0.95, 0),
  hipL: V(0.12, 0.95, 0), kneeL: V(0.12, 0.55, 0), footL: V(0.12, 0.06, 0),
  hipR: V(-0.12, 0.95, 0), kneeR: V(-0.12, 0.55, 0), footR: V(-0.12, 0.06, 0),
});

// THE MIRROR. bot-limb-map.js:10-13 documents that parts.arms.left is the visual left wired to the
// internal arms.right, and that mirror reaches setRagdollPose. Verified by pushing one hand far out
// and asking which named joint arrived there. If this ever flips, the demo's "swap sides" default
// is wrong and every soldier ends up carrying its rifle in the other hand.
{
  const P = basePose();
  P.handL.set(1.7, 1.45, 0);
  P.elbowL.set(1.3, 1.45, 0);
  P.shoulderL.set(0.9, 1.45, 0);
  body.setRagdollPose(P);
  scene.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const left = at(body.joints.leftHand).x, right = at(body.joints.rightHand).x;
  ok(Math.abs(right - 1.7) < 1e-3 && Math.abs(left - 1.7) > 0.5,
    `setRagdollPose "handL" drives joints.rightHand (left x=${left.toFixed(2)}, right x=${right.toFixed(2)})`);
}

// The pose is placed by POSITION, so joints land exactly where they are put. That is the property
// the whole approach leans on: no bone-axis reconciliation, no rest-orientation algebra.
{
  const P = basePose();
  body.setRagdollPose(P);
  scene.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  let worst = 0;
  for (const [key, joint] of [
    ['handL', body.joints.rightHand], ['handR', body.joints.leftHand],
    ['footL', body.joints.rightFoot], ['footR', body.joints.leftFoot],
    ['pelvis', body.joints.pelvis], ['head', body.joints.head],
  ]) worst = Math.max(worst, at(joint).distanceTo(P[key]));
  ok(worst < 1e-6, `every posed joint lands exactly where it was put (worst ${worst.toExponential(2)} m)`);
}

// Planting: shift the whole pose so the lower foot sits on y=0.
{
  const P = basePose();
  for (const key in P) P[key].y -= 0.4;        // sink it
  const lift = -Math.min(P.footL.y, P.footR.y);
  for (const key in P) P[key].y += lift;
  ok(Math.abs(Math.min(P.footL.y, P.footR.y)) < 1e-9, 'planting puts the lower foot exactly on the floor');
}

// ---------------------------------------------------------------------------
// The reconstruction, on a synthetic CHIBI donor — short legs, big head, exactly the shape that
// breaks naive scaling. Runs offline; no loader, no network, no real asset.
//
// This guards the demo's central decision. Scaling the donor's positions by one factor
// (ourLeg/theirLeg) is the obvious approach and it is wrong: measured against the real KayKit
// knight it needed ×2.96 and threw the head to 3.29 m. Taking only DIRECTIONS and stepping our own
// bone lengths along them is proportion-proof, and that is what is asserted here.
// ---------------------------------------------------------------------------
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // A donor whose legs are a third of ours and whose head is comically high above the hips.
  const donor = {
    hips: V(0, 0.30, 0), chest: V(0, 0.46, 0), head: V(0, 0.62, 0),
    leftUpperArm: V(0.12, 0.44, 0), leftLowerArm: V(0.20, 0.32, 0), leftHand: V(0.24, 0.20, 0),
    rightUpperArm: V(-0.12, 0.44, 0), rightLowerArm: V(-0.20, 0.32, 0), rightHand: V(-0.24, 0.20, 0),
    leftUpperLeg: V(0.06, 0.28, 0), leftLowerLeg: V(0.06, 0.15, 0.04), leftFoot: V(0.06, 0.02, 0.10),
    rightUpperLeg: V(-0.06, 0.28, 0), rightLowerLeg: V(-0.06, 0.15, -0.04), rightFoot: V(-0.06, 0.02, -0.10),
  };
  const donorLeg = donor.leftUpperLeg.distanceTo(donor.leftLowerLeg) + donor.leftLowerLeg.distanceTo(donor.leftFoot);
  const naive = body.limbLengths.legLen / donorLeg;
  ok(naive > 2, `the naive single-factor scale for this donor would be ×${naive.toFixed(2)} — the trap`);

  const dir = (a, b) => new THREE.Vector3().subVectors(donor[b], donor[a]).normalize();
  const rest = {
    spine: donor.hips.distanceTo(donor.chest), neck: donor.chest.distanceTo(donor.head),
    shoulderL: donor.chest.distanceTo(donor.leftUpperArm), shoulderR: donor.chest.distanceTo(donor.rightUpperArm),
    hipL: donor.hips.distanceTo(donor.leftUpperLeg), hipR: donor.hips.distanceTo(donor.rightUpperLeg),
    trunk: donor.hips.distanceTo(donor.head),
  };

  const { legLen, thighLen, shinLen, armLen } = body.limbLengths;
  const halfArm = armLen * 0.5;
  const designH = legLen / BODY_DESIGN_DEFAULTS.legLenRatio;
  const trunkK = (designH - legLen) / rest.trunk;

  const P = {};
  P.pelvis = V(0, 0, 0);
  P.chest = P.pelvis.clone().addScaledVector(dir('hips', 'chest'), rest.spine * trunkK);
  P.neck = P.chest.clone().addScaledVector(dir('chest', 'head'), rest.neck * trunkK);
  P.head = P.neck.clone().addScaledVector(V(0, 1, 0), rest.neck * trunkK * 0.6);
  for (const [side, key] of [['left', 'L'], ['right', 'R']]) {
    const U = side + 'UpperArm', Lo = side + 'LowerArm', H = side + 'Hand';
    P['shoulder' + key] = P.chest.clone().addScaledVector(dir('chest', U), rest[side === 'left' ? 'shoulderL' : 'shoulderR'] * trunkK);
    P['elbow' + key] = P['shoulder' + key].clone().addScaledVector(dir(U, Lo), halfArm);
    P['hand' + key] = P['elbow' + key].clone().addScaledVector(dir(Lo, H), halfArm);
    const HP = side + 'UpperLeg', K = side + 'LowerLeg', F = side + 'Foot';
    P['hip' + key] = P.pelvis.clone().addScaledVector(dir('hips', HP), rest[side === 'left' ? 'hipL' : 'hipR'] * trunkK);
    P['knee' + key] = P['hip' + key].clone().addScaledVector(dir(HP, K), thighLen);
    P['foot' + key] = P['knee' + key].clone().addScaledVector(dir(K, F), shinLen);
  }
  const lift = -Math.min(P.footL.y, P.footR.y);
  for (const key in P) P[key].y += lift;

  ok(Math.abs(P.hipL.distanceTo(P.kneeL) - thighLen) < 1e-9
    && Math.abs(P.kneeL.distanceTo(P.footL) - shinLen) < 1e-9,
    'reconstructed legs carry OUR bone lengths exactly, whatever the donor measured');
  ok(Math.abs(P.shoulderL.distanceTo(P.elbowL) - halfArm) < 1e-9
    && Math.abs(P.elbowL.distanceTo(P.handL) - halfArm) < 1e-9,
    'reconstructed arms carry OUR bone lengths exactly');
  ok(P.head.y > 1.4 && P.head.y < 2.1,
    `a chibi donor still yields a human head height (${P.head.y.toFixed(2)} m, not the ${(0.62 * naive).toFixed(2)} m naive scaling gives)`);

  body.setRagdollPose(P);
  scene.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  ok(Math.abs(Math.min(at(body.joints.leftFoot).y, at(body.joints.rightFoot).y)) < 1e-6,
    'the real body accepts the reconstructed pose with both feet on the floor');
}

// ---------------------------------------------------------------------------
// 2b. The post-passes that make a cartoon clip read as a soldier.
//
// All three move an endpoint — a hand pulled inboard, a hip lifted out of a bob, a hand snapped
// onto a grip — and all three then re-solve the middle joint. The invariant that matters is that
// BONE LENGTHS SURVIVE, because stretching a limb is exactly what the whole retarget avoids.
// ---------------------------------------------------------------------------

const _ax = new THREE.Vector3(), _perp = new THREE.Vector3();
function solveMid(out, root, end, l1, l2, poleHint) {
  _ax.subVectors(end, root);
  let d = _ax.length();
  if (d < 1e-6) { _ax.set(0, -1, 0); d = 1e-6; } else _ax.divideScalar(d);
  const reach = Math.min(d, l1 + l2 - 1e-5);
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _perp.subVectors(poleHint, root).addScaledVector(_ax, -_perp.dot(_ax));
  if (_perp.lengthSq() < 1e-12) _perp.set(_ax.z, 0, -_ax.x);
  if (_perp.lengthSq() < 1e-12) _perp.set(0, 0, 1);
  _perp.normalize();
  out.copy(root).addScaledVector(_ax, a).addScaledVector(_perp, h);
}

{
  const root = V(0, 1.0, 0), end = V(0.1, 0.1, 0.2), mid = new THREE.Vector3();
  const l1 = 0.558, l2 = 0.558;
  solveMid(mid, root, end, l1, l2, V(0.1, 0.55, 0.4));
  ok(Math.abs(root.distanceTo(mid) - l1) < 1e-9, `solveMid keeps the first bone exact (${root.distanceTo(mid).toFixed(9)})`);
  ok(Math.abs(mid.distanceTo(end) - l2) < 1e-9, `solveMid keeps the second bone exact (${mid.distanceTo(end).toFixed(9)})`);

  // The bend plane must follow the hint, or knees flip backwards on a damped stride.
  const front = new THREE.Vector3(), back = new THREE.Vector3();
  solveMid(front, root, end, l1, l2, V(0, 0.55, 1));
  solveMid(back, root, end, l1, l2, V(0, 0.55, -1));
  ok(front.z > back.z, `the pole hint decides which way the joint bends (z ${front.z.toFixed(3)} vs ${back.z.toFixed(3)})`);

  // An unreachable target must not stretch the first bone.
  const far = new THREE.Vector3();
  solveMid(far, root, V(0, -3, 0), l1, l2, V(0, 0.5, 1));
  ok(Math.abs(root.distanceTo(far) - l1) < 1e-9, 'an over-reaching target still leaves the first bone exact');
}

// BOB DAMPING. Lift the hip, leave the foot planted, re-solve the knee: the leg must absorb it.
{
  const thigh = body.limbLengths.thighLen, shin = body.limbLengths.shinLen;
  const hip = V(0.12, 0.95, 0), foot = V(0.12, 0.0, 0.1);
  const knee0 = new THREE.Vector3();
  solveMid(knee0, hip, foot, thigh, shin, V(0.12, 0.5, 0.3));

  const hip2 = hip.clone(); hip2.y += 0.06;              // a damper lifting the hips
  const knee2 = new THREE.Vector3();
  solveMid(knee2, hip2, foot, thigh, shin, knee0);
  ok(Math.abs(hip2.distanceTo(knee2) - thigh) < 1e-9 && Math.abs(knee2.distanceTo(foot) - shin) < 1e-9,
    'lifting the hip and re-solving keeps thigh and shin exact');
  ok(foot.y === 0, 'the planted foot does not move when the hip is lifted');

  // The clamp: a hip raised past thigh+shin would need a longer leg than we have.
  const span = thigh + shin;
  const dx = hip.x - foot.x, dz = hip.z - foot.z;
  const maxY = Math.sqrt(Math.max(0, span * span - (dx * dx + dz * dz)));
  const allowed = maxY - (hip.y - foot.y);
  ok(allowed > 0 && allowed < span, `the per-leg lift clamp is finite and positive (${allowed.toFixed(3)} m of headroom)`);
}

// ARM INSET. Reducing the hand's lateral offset must narrow the carry without stretching the arm.
{
  const armLen = body.limbLengths.armLen, half = armLen * 0.5;
  const lat = V(1, 0, 0);
  const shoulder = V(0.22, 1.45, 0);
  const hand = V(0.62, 1.05, 0.10);                      // splayed wide, as a chibi clip leaves it
  const elbow0 = new THREE.Vector3();
  solveMid(elbow0, shoulder, hand, half, half, V(0.5, 1.2, -0.2));

  const inset = 0.6;
  const v = new THREE.Vector3().subVectors(hand, shoulder);
  const before = Math.abs(v.dot(lat));
  v.addScaledVector(lat, -v.dot(lat) * inset);
  const after = Math.abs(v.dot(lat));
  if (v.length() > armLen - 1e-4) v.setLength(armLen - 1e-4);
  const hand2 = shoulder.clone().add(v);
  const elbow2 = new THREE.Vector3();
  solveMid(elbow2, shoulder, hand2, half, half, elbow0);

  ok(Math.abs(after - before * (1 - inset)) < 1e-9,
    `arm inset scales the lateral offset by exactly (1 - inset) (${before.toFixed(3)} → ${after.toFixed(3)})`);
  ok(Math.abs(shoulder.distanceTo(elbow2) - half) < 1e-9 && Math.abs(elbow2.distanceTo(hand2) - half) < 1e-9,
    'the inset arm keeps both bones exact');
  ok(hand2.distanceTo(shoulder) <= armLen + 1e-9, 'the inset hand never exceeds arm reach');
}

// THE WEAPON PIPELINE — the repo's own, exercised end to end.
//
// The first version of the demo invented its own mounting and produced a giant CZ, pistols inside
// the torso, and everything backwards. These checks pin the real path so that cannot recur.
{
  // 1. weapons.js is the source of truth and imports cleanly (no THREE, no renderer).
  for (const id of ['cz_805_bren', 'm24', 'rpg', 'five_seven', 'm1911']) {
    const def = getWeapon(id);
    ok(!!def, `weapons.js has an entry for ${id}`);
    ok(typeof def.model === 'string' && def.model.startsWith('models/guns/'),
      `${id}: carries its own model path (${def.model})`);
    ok(def.thirdPersonHold && Array.isArray(def.thirdPersonHold.position),
      `${id}: carries an authored thirdPersonHold`);
    ok(typeof def.thirdPersonHold.scale === 'number',
      `${id}: the hold carries a SCALE (${def.thirdPersonHold.scale}) — the demo must not derive one`);
  }

  // 2. THE THIRD-PERSON NORMALIZATION TARGET IS A FLAT 0.62, NOT viewTargetSize. This is the bug
  //    that made the CZ enormous on screen. weapons.js:80 states the rule; bot-viewer-v3.html:2182
  //    is the only place it is applied. Both are asserted, because a demo that reads viewTargetSize
  //    looks plausible and is wrong by a different factor for every weapon.
  const v3 = fs.readFileSync('bot-viewer-v3.html', 'utf8');
  ok(/normalizeBotWeaponModel\(template,\s*0\.62\)/.test(v3),
    'bot-viewer-v3.html still normalizes third-person weapons to a flat 0.62');
  ok(/NOT viewTargetSize/.test(fs.readFileSync('weapons.js', 'utf8')),
    'weapons.js still documents that third person must NOT use viewTargetSize');

  const demo = fs.readFileSync('demos/pose-retarget.html', 'utf8');
  ok(/const THIRD_PERSON_TARGET = 0\.62;/.test(demo),
    'the demo normalizes to the same flat 0.62 target v3 uses');
  ok(!/viewTargetSize\s*\?\?/.test(demo),
    'the demo no longer falls back to viewTargetSize when scaling the held weapon');

  // How wrong the old code was, per weapon — the reason the CZ read as "fucking huge".
  for (const [id, expected] of [['cz_805_bren', 2.10], ['m24', 2.50], ['five_seven', 1.53], ['m1911', 1.53]]) {
    const ratio = getWeapon(id).viewTargetSize / 0.62;
    ok(Math.abs(ratio - expected) < 0.02,
      `${id}: viewTargetSize would have drawn it ${ratio.toFixed(2)}x oversized`);
  }
  ok(getWeapon('rpg').viewTargetSize === undefined,
    'the RPG has no viewTargetSize, which is why it alone looked right under the old code');

  // 3. resolveWeaponHold with no stance and no carry returns the plain standing hold. That is the
  //    correct degenerate case for a demo with no stance machine, rather than a fabricated pose.
  const def = getWeapon('cz_805_bren');
  const out = resolveWeaponHold(def, null, null, { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
  ok(out.position.every((v, i) => Math.abs(v - def.thirdPersonHold.position[i]) < 1e-9)
    && Math.abs(out.scale - def.thirdPersonHold.scale) < 1e-9,
    `resolveWeaponHold with no stance returns thirdPersonHold verbatim (${out.position.join(', ')} @ ${out.scale})`);

  // 4. normalizeObject, on a synthetic model with a deliberately WRONG long axis. This is the step
  //    whose absence drew the CZ sideways: its raw bbox is 8.2 x 173.3 x 33.6, longest on Y.
  const nBox = new THREE.Box3(), nSize = new THREE.Vector3();
  function normalizeObject(obj, viewTargetSize) {
    obj.updateMatrixWorld(true);
    nBox.setFromObject(obj); nBox.getSize(nSize);
    if (nSize.x >= nSize.y && nSize.x >= nSize.z) obj.rotation.y = Math.PI * 0.5;
    else if (nSize.y >= nSize.x && nSize.y >= nSize.z) obj.rotation.x = Math.PI * 0.5;
    obj.updateMatrixWorld(true);
    nBox.setFromObject(obj); nBox.getSize(nSize);
    const longest = Math.max(nSize.x, nSize.y, nSize.z, 1e-6);
    obj.scale.multiplyScalar(viewTargetSize / longest);
    obj.updateMatrixWorld(true);
    nBox.setFromObject(obj);
    obj.position.sub(nBox.getCenter(new THREE.Vector3()));
  }

  // A "gun" 30 long on Y, offset far from the origin — both faults the CZ actually has.
  const gun = new THREE.Mesh(new THREE.BoxGeometry(1.4, 30, 5.8));
  gun.position.set(12, -40, 7);
  const holder = new THREE.Object3D();
  holder.add(gun);
  normalizeObject(holder, 0.62);
  holder.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(holder);
  const size = after.getSize(new THREE.Vector3());
  const centre = after.getCenter(new THREE.Vector3());

  ok(size.z > size.x && size.z > size.y,
    `normalizeObject puts the longest axis on Z (${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)})`);
  ok(Math.abs(Math.max(size.x, size.y, size.z) - 0.62) < 1e-6,
    'normalizeObject scales the longest axis to viewTargetSize exactly');
  ok(centre.length() < 1e-6,
    `normalizeObject recentres on the origin (centre ${centre.length().toExponential(1)}) — skipping this is why weapons sat inside the torso`);

  // 5. Baked anchors land on the normalized model, which raw anchors do not.
  const rawAnchors = JSON.parse(fs.readFileSync('./weapon-anchors.json', 'utf8'));
  const raw = rawAnchors.cz_805_bren.ikAnchors;
  const m = holder.matrixWorld.clone();
  const bakedGrip = new THREE.Vector3().fromArray(raw.rightGrip.p).applyMatrix4(m);
  const rawGrip = new THREE.Vector3().fromArray(raw.rightGrip.p);
  ok(bakedGrip.length() < rawGrip.length(),
    `baking pulls the anchor into the normalized model's space (|raw| ${rawGrip.length().toFixed(1)} -> |baked| ${bakedGrip.length().toFixed(3)})`);
}

// THE FACING SIGN, and the mount chain that depends on it.
//
// MEASURED OFF THE RIG, NOT COPIED FROM rdBasis. Copying rdBasis is the trap: it builds forward as
// cross(up, lateral), but that result is the body's LOCAL +Z, and the eyes sit on local -Z
// (player-procedural-body.js:1932). So `_rdFwd` points out the BACK of the soldier, and a mount that
// matches it is yawed 180 degrees. weaponRig's +Z must be the FACING — body-preview-v3.html:892
// calls weaponFrame the "fixed 180deg spin: camera-forward (-Z) -> body-forward (+Z)".
{
  const P = basePose();
  body.setRagdollPose(P);
  scene.updateMatrixWorld(true);
  const head = body.joints.head ?? body.parts?.head;
  const q = head.getWorldQuaternion(new THREE.Quaternion());
  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(q);   // eyes on local -Z

  const lat = new THREE.Vector3().subVectors(P.shoulderR, P.shoulderL).normalize();
  const up = new THREE.Vector3().subVectors(P.chest, P.pelvis);
  up.addScaledVector(lat, -up.dot(lat)).normalize();

  const demoFwd = new THREE.Vector3().crossVectors(lat, up).normalize();   // what the demo does
  const rdFwd = new THREE.Vector3().crossVectors(up, lat).normalize();     // what rdBasis does

  ok(demoFwd.dot(facing) > 0.999,
    `the demo's forward is the direction the posed rig actually faces (dot ${demoFwd.dot(facing).toFixed(4)})`);
  ok(rdFwd.dot(facing) < -0.999,
    'rdBasis forward is the exact OPPOSITE of the facing — copying it is the 180-degree weapon bug');

  // The mount yaw that follows, so the convention is pinned and not just the vector.
  const yaw = Math.atan2(demoFwd.x, demoFwd.z);
  const rigZ = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  ok(rigZ.dot(facing) > 0.999, `atan2(fwd.x, fwd.z) puts weaponRig's +Z on the facing (yaw ${yaw.toFixed(3)})`);
}

// THE MOUNT CHAIN. Four nodes, and skipping either middle one misplaces the weapon.
{
  const poses = JSON.parse(fs.readFileSync('./weapon-poses.json', 'utf8')).weaponPoses;
  ok(!!poses?.lowReady?.p, 'weapon-poses.json carries the lowReady carry pose the mount needs');

  const rig = new THREE.Group(), adjust = new THREE.Group();
  const frame = new THREE.Group(), view = new THREE.Group();
  frame.rotation.y = Math.PI;                 // bot-viewer-v3.html:2246, fixed
  rig.add(adjust); adjust.add(frame); frame.add(view);

  const lr = poses.lowReady;
  view.position.fromArray(lr.p);
  view.quaternion.setFromEuler(new THREE.Euler(lr.r[0], lr.r[1], lr.r[2], 'XYZ'));

  const hold = resolveWeaponHold(getWeapon('cz_805_bren'), null, null,
    { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
  // Body facing +Z (rdBasis convention for this test pose), feet on 0.
  rig.position.set(0, 1.5, 0);
  rig.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
  adjust.position.fromArray(hold.position);
  adjust.quaternion.setFromEuler(new THREE.Euler(hold.rotation[0], hold.rotation[1], hold.rotation[2], 'XYZ'));
  adjust.scale.setScalar(hold.scale ?? 1);
  rig.updateMatrixWorld(true);

  const withFrame = view.getWorldPosition(new THREE.Vector3());
  frame.rotation.y = 0; frame.updateMatrix(); rig.updateMatrixWorld(true);
  const withoutFrame = view.getWorldPosition(new THREE.Vector3());
  ok(withFrame.distanceTo(withoutFrame) > 0.5,
    `weaponFrame's fixed PI moves the weapon ${withFrame.distanceTo(withoutFrame).toFixed(2)} m — omitting it is not cosmetic`);

  frame.rotation.y = Math.PI; frame.updateMatrix(); rig.updateMatrixWorld(true);
  const posed = view.getWorldPosition(new THREE.Vector3());
  view.position.set(0, 0, 0); rig.updateMatrixWorld(true);
  const unposed = view.getWorldPosition(new THREE.Vector3());
  ok(unposed.y - posed.y > 0.5,
    `the lowReady pose drops the weapon ${(unposed.y - posed.y).toFixed(2)} m off the shoulder — without it the gun floats high`);
}

// GRIP ANCHORS MUST COME BACK IN THE POSE'S SPACE, NOT WORLD SPACE.
//
// The demo builds the body with `scene: soldierRoot` and offsets soldierRoot so the soldier stands
// beside the donor, so `pose` joints are soldierRoot-LOCAL. `matrixWorld` is world. Blending a
// world-space grip into a local-space hand put the target a whole metre off, which the arm cannot
// reach, so the hands never went near the gun no matter how well the weapon itself was placed.
{
  const OFFSET = 1.0;
  const root = new THREE.Group();
  root.position.x = OFFSET;
  const rig = new THREE.Group();
  rig.position.set(0, 1.5, 0);
  root.add(rig);
  root.updateMatrixWorld(true);

  const anchor = new THREE.Vector3(0.1, -0.2, 0.3);
  const world = anchor.clone().applyMatrix4(rig.matrixWorld);
  const local = root.worldToLocal(world.clone());

  ok(Math.abs(world.x - local.x - OFFSET) < 1e-9,
    `an un-converted grip is off by exactly the root offset (${(world.x - local.x).toFixed(2)} m)`);

  const arm = body.limbLengths.armLen;
  ok(OFFSET > arm,
    `that offset (${OFFSET} m) exceeds the soldier's whole arm (${arm.toFixed(3)} m), so the hand clamps short instead of reaching`);

  const demoSrc = fs.readFileSync('demos/pose-retarget.html', 'utf8');
  ok(/soldierRoot\.worldToLocal\(_gripPose\.right\)/.test(demoSrc)
    && /soldierRoot\.worldToLocal\(_gripPose\.left\)/.test(demoSrc),
    'the demo converts both grips out of world space before blending them into the hands');
}

// THE MOUNT IS SHOULDER-RELATIVE, NOT FEET-RELATIVE.
//
// v3 anchors the weapon at `feetY + 1.5`. That constant only means "just under the shoulders" on a
// body with v3's own torso height, and this demo's torso is rescaled to the donor clip. Copying the
// number put the gun above the shoulders and the arms went straight up after it. What actually has
// to be preserved is the SHOULDER-RELATIVE offset, measured off a rig running its own gait.
{
  const state = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(),
    yaw: 0, alive: true, grounded: true,
  };
  for (let i = 0; i < 240; i++) body.update(1 / 60, state);
  scene.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const feet = Math.min(at(body.joints.leftFoot).y, at(body.joints.rightFoot).y);
  const shoulder = (at(body.joints.leftShoulder).y + at(body.joints.rightShoulder).y) / 2;
  const below = (shoulder - feet) - 1.5;

  ok(shoulder - feet > 1.5,
    `a standing soldier's shoulders sit at feetY + ${(shoulder - feet).toFixed(3)}, above the 1.5 mount`);
  ok(below > 0.05 && below < 0.4,
    `v3's mount is ${below.toFixed(3)} m BELOW the shoulder — a carry, not an overhead hold`);

  const demoSrc = fs.readFileSync('demos/pose-retarget.html', 'utf8');
  ok(/shoulderY - mountBelowShoulder/.test(demoSrc),
    'the demo anchors the mount to its own shoulders, not to a copied feetY + 1.5');
  ok(!/state\.mountHeight/.test(demoSrc),
    'the old absolute mount-height control is gone, so the constant cannot creep back');
}

// ---------------------------------------------------------------------------
// 3. The upstream Pirate Nation rig.
// ---------------------------------------------------------------------------

const MEDIA = 'https://media.githubusercontent.com/media/proofofplay/piratenation-art/main';
const lfs = (...s) => `${MEDIA}/${s.map(encodeURIComponent).join('/')}`;
const SOURCE = lfs('Voxel Game Assets', 'Lore Characters', 'rustbeard', 'avatar_rustbeard_001.gltf');

let gltf = null;
try {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  gltf = JSON.parse(await res.text());
} catch (err) {
  skip(`upstream Pirate Nation checks — ${err.message}`);
}

if (gltf) {
  const nodes = gltf.nodes;
  const joints = gltf.skins?.[0]?.joints.map(i => nodes[i].name) ?? [];
  ok(joints.length === 16, `rustbeard still has 16 joints (found ${joints.length})`);
  ok(gltf.animations?.length === 32, `rustbeard still has 32 clips (found ${gltf.animations?.length})`);

  const found = resolveSlots(joints);
  const missing = SLOT_IDS.filter(s => !found.has(s));
  ok(missing.length === 0, `the live upstream rig still fills every canonical slot${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);

  // Root translation in every clip is why the demo plants the pose rather than trusting its height.
  const rootIdx = nodes.findIndex(n => n.name === 'Root');
  const withRoot = gltf.animations.filter(a =>
    a.channels.some(c => c.target.node === rootIdx && c.target.path === 'translation'));
  ok(withRoot.length === gltf.animations.length,
    `all ${gltf.animations.length} clips animate root translation, so the pose must be planted`);
}

console.log(fail ? `\n${fail} FAILED${skipped ? `, ${skipped} skipped` : ''}`
  : `\nall checks passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
