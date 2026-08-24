// Pure authoritative semantic pose for player hurt registration.
// It deliberately owns no renderer objects and accepts global foot-plane coordinates.

import {
  HUMANOID_JOINT_COUNT,
  HUMANOID_JOINT_INDEX as J,
  HUMANOID_PROPORTIONS,
} from './humanoid-rig-topology.js';
import { BASE_GAME_DEFAULT_HIT_PROFILE } from './base-game-body-models.js';

const FIXED_HZ = 120;
const EPS = 1e-9;

function finite3(value, fallback = [0, 0, 0]) {
  if (!value || value.length < 3 || !value.every(Number.isFinite)) return fallback;
  return value;
}

export function createPlayerBodyPose() {
  return {
    root: [0, 0, 0],
    joints: new Float32Array(HUMANOID_JOINT_COUNT * 3),
    eye: new Float32Array(3),
    muzzle: new Float32Array(3),
    boundsMin: new Float32Array(3),
    boundsMax: new Float32Array(3),
    profileId: BASE_GAME_DEFAULT_HIT_PROFILE,
    profileVersion: 1,
    poseEpoch: 1,
    tick: 0,
    alive: true,
    hp: 100,
  };
}

function setJoint(out, index, x, y, z) {
  const i = index * 3;
  out.joints[i] = x;
  out.joints[i + 1] = y;
  out.joints[i + 2] = z;
}

function rotateLocal(x, z, yaw) {
  // Base Game yaw 0 faces -Z. Local +X is body-right, local +Z is body-forward.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c - z * s, -x * s - z * c];
}

function localFromWorldDir(dirX, dirZ, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [dirX * c - dirZ * s, -dirX * s - dirZ * c];
}

function put(out, index, lx, ly, lz, yaw) {
  const [x, z] = rotateLocal(lx, lz, yaw);
  setJoint(out, index, x, ly, z);
}

function midpointBend(out, index, a, b, bendX, bendY, bendZ, yaw) {
  const ai = a * 3, bi = b * 3;
  put(out, index,
    (out.joints[ai] + out.joints[bi]) * 0.5 + bendX,
    (out.joints[ai + 1] + out.joints[bi + 1]) * 0.5 + bendY,
    (out.joints[ai + 2] + out.joints[bi + 2]) * 0.5 + bendZ,
    yaw);
}

function setLocalPoint(out, target, lx, ly, lz, yaw) {
  const [x, z] = rotateLocal(lx, lz, yaw);
  target[0] = x; target[1] = ly; target[2] = z;
}

function recomputeBounds(out, pad = 0.23) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < out.joints.length; i += 3) {
    const x = out.joints[i], y = out.joints[i + 1], z = out.joints[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  out.boundsMin[0] = minX - pad; out.boundsMin[1] = minY - pad; out.boundsMin[2] = minZ - pad;
  out.boundsMax[0] = maxX + pad; out.boundsMax[1] = maxY + pad; out.boundsMax[2] = maxZ + pad;
}

export function stepPlayerBodyPose(out, input = {}) {
  if (!out?.joints || out.joints.length !== HUMANOID_JOINT_COUNT * 3) {
    throw new TypeError('stepPlayerBodyPose requires createPlayerBodyPose() output');
  }
  const root = finite3(input.position);
  const velocity = finite3(input.velocity);
  const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;
  const pitch = Number.isFinite(input.pitch) ? Math.max(-1.45, Math.min(1.45, input.pitch)) : 0;
  const tick = Number.isSafeInteger(input.tick) && input.tick >= 0 ? input.tick : out.tick;
  const fixedHz = Number.isFinite(input.fixedHz) && input.fixedHz > 0 ? input.fixedHz : FIXED_HZ;
  const grounded = input.grounded === true;
  const swimming = input.swimming === true;
  const aiming = input.aiming === true;
  const speed = Math.hypot(velocity[0], velocity[2]);
  const speed01 = Math.min(1, speed / 5.2);
  const moveLocal = speed > EPS ? localFromWorldDir(velocity[0] / speed, velocity[2] / speed, yaw) : [0, 1];
  const phase = speed > 0.08 ? tick / fixedHz * speed * 4.8 : 0;
  const strideWave = Math.sin(phase);
  const stride = grounded && !swimming ? 0.20 * speed01 : 0;
  const pelvisBob = grounded && speed > 0.08 ? Math.abs(Math.sin(phase)) * 0.025 * speed01 : 0;

  out.root[0] = root[0]; out.root[1] = root[1]; out.root[2] = root[2];
  out.tick = tick;
  out.poseEpoch = Number.isSafeInteger(input.poseEpoch) && input.poseEpoch > 0 ? input.poseEpoch : out.poseEpoch;
  out.profileId = typeof input.profileId === 'string' ? input.profileId : out.profileId;
  out.profileVersion = 1;
  out.alive = input.alive !== false;
  out.hp = Number.isFinite(input.hp) ? input.hp : out.hp;

  const hipY = HUMANOID_PROPORTIONS.height * 0.58 - pelvisBob;
  const chestY = hipY + 0.36;
  const neckY = chestY + 0.16;
  const headY = neckY + 0.14;
  const hipHalf = 0.13;
  const shoulderHalf = 0.22;

  put(out, J.pelvis, 0, hipY, 0, yaw);
  put(out, J.chest, 0, chestY, speed01 * 0.025, yaw);
  put(out, J.neck, 0, neckY, speed01 * 0.030, yaw);
  put(out, J.head, 0, headY, speed01 * 0.035, yaw);
  put(out, J.hipL, -hipHalf, hipY - 0.015, 0, yaw);
  put(out, J.hipR, hipHalf, hipY - 0.015, 0, yaw);
  put(out, J.shoulderL, -shoulderHalf, chestY + 0.015, 0.015, yaw);
  put(out, J.shoulderR, shoulderHalf, chestY + 0.015, 0.015, yaw);

  const leftStep = strideWave * stride;
  const rightStep = -leftStep;
  const footLiftL = grounded ? Math.max(0, strideWave) * 0.10 * speed01 : 0.10;
  const footLiftR = grounded ? Math.max(0, -strideWave) * 0.10 * speed01 : 0.10;
  const airborneTuck = grounded ? 0 : Math.min(0.18, Math.max(0.04, Math.abs(velocity[1]) * 0.015));
  put(out, J.footL, -hipHalf, 0.07 + footLiftL + airborneTuck, leftStep, yaw);
  put(out, J.footR, hipHalf, 0.07 + footLiftR + airborneTuck, rightStep, yaw);
  // Knees bend slightly forward and outward rather than living on the straight hip-foot chord.
  const li = J.hipL * 3, lf = J.footL * 3, ri = J.hipR * 3, rf = J.footR * 3;
  const leftKnee = [(out.joints[li] + out.joints[lf]) * 0.5, (out.joints[li + 1] + out.joints[lf + 1]) * 0.5, (out.joints[li + 2] + out.joints[lf + 2]) * 0.5];
  const rightKnee = [(out.joints[ri] + out.joints[rf]) * 0.5, (out.joints[ri + 1] + out.joints[rf + 1]) * 0.5, (out.joints[ri + 2] + out.joints[rf + 2]) * 0.5];
  const [kbx, kbz] = rotateLocal(0, 0.08, yaw);
  setJoint(out, J.kneeL, leftKnee[0] + kbx, leftKnee[1] - 0.015, leftKnee[2] + kbz);
  setJoint(out, J.kneeR, rightKnee[0] + kbx, rightKnee[1] - 0.015, rightKnee[2] + kbz);

  if (aiming) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const aimForward = [0, sp, cp];
    // Weapon is held right-of-centre; both hands meet it at different points.
    put(out, J.handR, 0.09, chestY - hipY + 0.02 + aimForward[1] * 0.48, aimForward[2] * 0.48, yaw);
    put(out, J.handL, -0.10, chestY - hipY - 0.01 + aimForward[1] * 0.40, aimForward[2] * 0.40, yaw);
    // put() receives root-relative Y, while the authored values above are absolute in the pose.
    out.joints[J.handR * 3 + 1] = chestY + 0.02 + aimForward[1] * 0.48;
    out.joints[J.handL * 3 + 1] = chestY - 0.01 + aimForward[1] * 0.40;
  } else {
    const armSwing = strideWave * 0.16 * speed01;
    put(out, J.handL, -shoulderHalf - 0.025, chestY - 0.64, -armSwing, yaw);
    put(out, J.handR, shoulderHalf + 0.025, chestY - 0.64, armSwing, yaw);
  }

  // Elbows are derived in world/root-relative coordinates after the hands are placed.
  for (const [shoulder, elbow, hand, side] of [[J.shoulderL, J.elbowL, J.handL, -1], [J.shoulderR, J.elbowR, J.handR, 1]]) {
    const si = shoulder * 3, hi = hand * 3;
    const [ox, oz] = rotateLocal(side * 0.055, aiming ? -0.035 : 0.015, yaw);
    setJoint(out, elbow,
      (out.joints[si] + out.joints[hi]) * 0.5 + ox,
      (out.joints[si + 1] + out.joints[hi + 1]) * 0.5 - (aiming ? 0.08 : 0.02),
      (out.joints[si + 2] + out.joints[hi + 2]) * 0.5 + oz);
  }

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  setLocalPoint(out, out.eye, 0, headY + 0.015, 0.075, yaw);
  setLocalPoint(out, out.muzzle, 0.085, headY - 0.14 + sp * 0.20, 0.18 + cp * 0.22, yaw);
  recomputeBounds(out);
  return out;
}

export function copyPlayerBodyPose(source, out = createPlayerBodyPose()) {
  out.root[0] = source.root[0]; out.root[1] = source.root[1]; out.root[2] = source.root[2];
  out.joints.set(source.joints); out.eye.set(source.eye); out.muzzle.set(source.muzzle);
  out.boundsMin.set(source.boundsMin); out.boundsMax.set(source.boundsMax);
  out.profileId = source.profileId; out.profileVersion = source.profileVersion;
  out.poseEpoch = source.poseEpoch; out.tick = source.tick; out.alive = source.alive; out.hp = source.hp;
  return out;
}

export function playerPosePoint(pose, joint, out = [0, 0, 0]) {
  const index = typeof joint === 'number' ? joint : J[joint];
  if (!Number.isInteger(index) || index < 0 || index >= HUMANOID_JOINT_COUNT) return null;
  const i = index * 3;
  out[0] = pose.root[0] + pose.joints[i];
  out[1] = pose.root[1] + pose.joints[i + 1];
  out[2] = pose.root[2] + pose.joints[i + 2];
  return out;
}

export function playerPoseAnchor(pose, name, out = [0, 0, 0]) {
  const value = name === 'muzzle' ? pose.muzzle : pose.eye;
  out[0] = pose.root[0] + value[0];
  out[1] = pose.root[1] + value[1];
  out[2] = pose.root[2] + value[2];
  return out;
}

