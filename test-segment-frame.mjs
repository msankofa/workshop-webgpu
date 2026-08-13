// test-segment-frame.mjs — limb-segment frames must be rigid with the body.
//
// placeSegment orients a limb with the SHORTEST-ARC rotation from +Y to the bone. That rotation
// carries no roll, so computed in world space it leaves a near-vertical thigh with a near-identity
// frame whichever way the bot is facing — the segment's local frame is world-locked, not
// body-locked. Nothing rendered cared (limb geometry is a lathe about Y, so it looks the same at
// any roll), but a blood decal pinned in that frame stays put in world space while the body turns
// around it, and ends up on the opposite side of the leg. Reported as "the decal flips to the other
// side when they turn around". placeSegment now does the same shortest-arc solve in BODY space.
//
// The property under test is exactly the one that failed: rotate a pose rigidly, and every limb
// frame must rotate by the same amount. Driven through setRagdollPose because it poses the rig from
// explicit joint positions, so the "same pose, rotated" comparison is exact — the gait scheduler
// would settle to different foot placements at different yaws and make the comparison meaningless.
//
// Run: node test-segment-frame.mjs

import * as THREE from 'three/webgpu';
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { composeBot } from './bot-body-versions.js';

let failures = 0;
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}

const body = createProceduralPlayerBody({
  THREE, scene: null, terrainHeight: () => 0, mode: 'remote',
  style: { shell: 0x46554c, plate: 0x1b201d, trim: 0x0a0d0a, accent: 0x53d68d },
  design: composeBot('current', 'as authored'),
  adaptGaitToSpeed: true, movementDynamics: true,
  // instanced mode needs a pool only when flush() runs; the frames come from update/setRagdollPose.
  batches: { add: () => true, beginFrame() {}, endFrame() {} },
});

// A plausible standing pose. The values don't matter — only that the same pose, rigidly rotated,
// yields rigidly rotated frames.
const POSE = {
  head: [0, 1.72, 0], neck: [0, 1.55, 0], chest: [0, 1.35, 0], pelvis: [0, 1.00, 0],
  shoulderL: [-0.20, 1.45, 0], shoulderR: [0.20, 1.45, 0],
  elbowL: [-0.24, 1.18, 0.02], elbowR: [0.24, 1.18, 0.02],
  handL: [-0.26, 0.92, 0.06], handR: [0.26, 0.92, 0.06],
  hipL: [-0.10, 0.98, 0], hipR: [0.10, 0.98, 0],
  kneeL: [-0.11, 0.55, 0.03], kneeR: [0.11, 0.55, 0.03],
  footL: [-0.11, 0.08, 0], footR: [0.11, 0.08, 0],
};
const rotatedPose = (R) => {
  const out = {};
  for (const k in POSE) {
    const v = new THREE.Vector3(...POSE[k]);
    if (R) v.applyQuaternion(R);
    out[k] = v;
  }
  return out;
};
function frameOf(part, R) {
  body.setRagdollPose(rotatedPose(R));
  body.group.updateMatrixWorld(true);
  return part.matrixWorld.clone();
}
// World offset of a part-local point from that part's own origin — i.e. where on the limb's
// surface the point sits, independent of where the limb has moved to.
function offsetOf(part, R, lp) {
  const m = frameOf(part, R);
  return lp.clone().applyMatrix4(m).sub(new THREE.Vector3().setFromMatrixPosition(m));
}

const SEGMENTS = [
  ['thigh (left upper leg)', body.parts.legs.left.upper],
  ['shin (left lower leg)', body.parts.legs.left.lower],
  ['upper arm (right)', body.parts.arms.right.upper],
  ['forearm (right)', body.parts.arms.right.lower],
];
const FRONT = new THREE.Vector3(0, 0, 0.06);   // a point on the front face of the segment

for (const [label, part] of SEGMENTS) {
  let worst = 0;
  for (const deg of [30, 90, 180, 270]) {
    const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * Math.PI / 180);
    const off0 = offsetOf(part, null, FRONT);
    const off1 = offsetOf(part, R, FRONT);
    worst = Math.max(worst, off0.clone().applyQuaternion(R).distanceTo(off1));
  }
  checkTrue(`${label}: frame rotates rigidly with the body`, worst < 1e-6, `worst error ${worst}`);
}

// The regression itself, stated as a number: before the fix a 180° turn put the front-of-thigh point
// at the exact NEGATION of where it belongs — ~0.12 m off on a ~0.11 m-thick thigh, which is what
// "on the other side of the leg" means. Anything near that magnitude means the roll is world-locked
// again.
{
  const part = body.parts.legs.left.upper;
  const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const off0 = offsetOf(part, null, FRONT);
  const off1 = offsetOf(part, R, FRONT);
  const flipped = off0.clone().applyQuaternion(R).negate();   // what the old world-locked frame gave
  checkTrue('thigh: a 180° turn does NOT mirror the decal to the far side',
    flipped.distanceTo(off1) > 0.05, `only ${flipped.distanceTo(off1).toFixed(4)} m from the flipped position`);
}

console.log(failures === 0 ? '\nAll segment-frame checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
