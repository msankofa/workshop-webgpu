// Pure articulated player hurt-volume math and bounded lag history.

import {
  HUMANOID_HIT_PRIMITIVES,
  HUMANOID_JOINT_INDEX,
  HUMANOID_JOINT_COUNT,
} from './humanoid-rig-topology.js';
import { createPlayerBodyPose, copyPlayerBodyPose, playerPosePoint } from './player-body-pose.js';

const EPS = 1e-9;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function normalized(dir) {
  if (!dir || dir.length < 3 || !dir.every(Number.isFinite)) return null;
  const n = Math.hypot(dir[0], dir[1], dir[2]);
  return n > EPS ? [dir[0] / n, dir[1] / n, dir[2] / n] : null;
}

function pointSegmentClosest(point, a, b, out = [0, 0, 0]) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const denom = abx * abx + aby * aby + abz * abz;
  const t = denom > EPS ? Math.max(0, Math.min(1,
    ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby + (point[2] - a[2]) * abz) / denom)) : 0;
  out[0] = a[0] + abx * t; out[1] = a[1] + aby * t; out[2] = a[2] + abz * t;
  return out;
}

function sphereRoots(origin, dir, center, radius, range, consider) {
  const ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return;
  const root = Math.sqrt(disc);
  for (const t of [-b - root, -b + root]) if (t >= 0 && t <= range) consider(t);
}

export function raySegmentCapsuleHit(origin, direction, range, a, b, radius) {
  const dir = normalized(direction);
  if (!dir || !(range > 0) || !(radius > 0) || !a?.every(Number.isFinite) || !b?.every(Number.isFinite)) return { hit: false };
  const closestOrigin = pointSegmentClosest(origin, a, b);
  const odx = origin[0] - closestOrigin[0], ody = origin[1] - closestOrigin[1], odz = origin[2] - closestOrigin[2];
  if (odx * odx + ody * ody + odz * odz <= radius * radius) {
    const n = Math.hypot(odx, ody, odz);
    return { hit: true, distance: 0, point: [...origin], normal: n > EPS ? [odx / n, ody / n, odz / n] : [-dir[0], -dir[1], -dir[2]] };
  }

  const ba = sub(b, a), oa = sub(origin, a);
  const baba = dot(ba, ba), bard = dot(ba, dir), baoa = dot(ba, oa);
  const rdoa = dot(dir, oa), oaoa = dot(oa, oa);
  const qa = baba - bard * bard;
  const qb = baba * rdoa - baoa * bard;
  const qc = baba * oaoa - baoa * baoa - radius * radius * baba;
  let best = Infinity;
  const consider = t => { if (t >= 0 && t <= range && t < best) best = t; };
  if (baba > EPS && Math.abs(qa) > EPS) {
    const disc = qb * qb - qa * qc;
    if (disc >= 0) {
      const t = (-qb - Math.sqrt(disc)) / qa;
      const y = baoa + t * bard;
      if (t >= 0 && t <= range && y > 0 && y < baba) consider(t);
    }
  }
  sphereRoots(origin, dir, a, radius, range, consider);
  sphereRoots(origin, dir, b, radius, range, consider);
  if (!Number.isFinite(best)) return { hit: false };
  const point = [origin[0] + dir[0] * best, origin[1] + dir[1] * best, origin[2] + dir[2] * best];
  const center = pointSegmentClosest(point, a, b);
  let nx = point[0] - center[0], ny = point[1] - center[1], nz = point[2] - center[2];
  const nl = Math.hypot(nx, ny, nz);
  if (nl > EPS) { nx /= nl; ny /= nl; nz /= nl; }
  else { nx = -dir[0]; ny = -dir[1]; nz = -dir[2]; }
  return { hit: true, distance: best, point, normal: [nx, ny, nz] };
}

function rayAabb(origin, dir, range, pose, inflate = 0) {
  let t0 = 0, t1 = range;
  for (let axis = 0; axis < 3; axis++) {
    const min = pose.root[axis] + pose.boundsMin[axis] - inflate;
    const max = pose.root[axis] + pose.boundsMax[axis] + inflate;
    if (Math.abs(dir[axis]) < EPS) {
      if (origin[axis] < min || origin[axis] > max) return false;
      continue;
    }
    let a = (min - origin[axis]) / dir[axis], b = (max - origin[axis]) / dir[axis];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t1 < t0) return false;
  }
  return true;
}

export function rayPlayerHitRig(origin, direction, range, pose, { inflate = 0 } = {}) {
  const dir = normalized(direction);
  const padding = Math.max(0, Number.isFinite(inflate) ? inflate : 0);
  if (!dir || !pose?.joints || pose.alive === false || !rayAabb(origin, dir, range, pose, padding)) return { hit: false };
  let best = null;
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let index = 0; index < HUMANOID_HIT_PRIMITIVES.length; index++) {
    const primitive = HUMANOID_HIT_PRIMITIVES[index];
    playerPosePoint(pose, HUMANOID_JOINT_INDEX[primitive.a], a);
    playerPosePoint(pose, HUMANOID_JOINT_INDEX[primitive.b], b);
    const hit = raySegmentCapsuleHit(origin, dir, range, a, b, primitive.radius + padding);
    if (!hit.hit || (best && hit.distance >= best.distance - 1e-8)) continue;
    best = { ...hit, primitive: index, zone: primitive.zone, side: primitive.side };
  }
  return best ?? { hit: false };
}

export function distanceToPlayerHitRig(point, pose) {
  if (!point?.every(Number.isFinite) || !pose?.joints || pose.alive === false) return Infinity;
  let best = Infinity;
  const a = [0, 0, 0], b = [0, 0, 0], closest = [0, 0, 0];
  for (const primitive of HUMANOID_HIT_PRIMITIVES) {
    playerPosePoint(pose, HUMANOID_JOINT_INDEX[primitive.a], a);
    playerPosePoint(pose, HUMANOID_JOINT_INDEX[primitive.b], b);
    pointSegmentClosest(point, a, b, closest);
    best = Math.min(best, Math.max(0, Math.hypot(point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]) - primitive.radius));
  }
  return best;
}

export function createPlayerHitRigHistory(capacity = 96) {
  const cap = Math.max(2, Math.floor(capacity));
  const slots = Array.from({ length: cap }, () => ({ t: 0, pose: createPlayerBodyPose() }));
  return { capacity: cap, slots, start: 0, length: 0 };
}

export function pushPlayerHitRigPose(history, pose, timeMs) {
  if (!history?.slots || !Number.isFinite(timeMs)) throw new TypeError('invalid hit-rig history push');
  const index = (history.start + history.length) % history.capacity;
  if (history.length === history.capacity) history.start = (history.start + 1) % history.capacity;
  else history.length++;
  history.slots[index].t = timeMs;
  copyPlayerBodyPose(pose, history.slots[index].pose);
  return history;
}

function historySlot(history, logicalIndex) {
  return history.slots[(history.start + logicalIndex) % history.capacity];
}

export function samplePlayerHitRigPose(history, targetTimeMs, out = createPlayerBodyPose()) {
  if (!history?.length) return null;
  const first = historySlot(history, 0), last = historySlot(history, history.length - 1);
  if (history.length === 1 || targetTimeMs <= first.t) return copyPlayerBodyPose(first.pose, out);
  if (targetTimeMs >= last.t) return copyPlayerBodyPose(last.pose, out);
  for (let i = 1; i < history.length; i++) {
    const a = historySlot(history, i - 1), b = historySlot(history, i);
    if (targetTimeMs > b.t) continue;
    if (a.pose.poseEpoch !== b.pose.poseEpoch || a.pose.profileId !== b.pose.profileId || a.pose.profileVersion !== b.pose.profileVersion) {
      return copyPlayerBodyPose(b.pose, out);
    }
    const span = b.t - a.t, f = span > EPS ? (targetTimeMs - a.t) / span : 1;
    for (let axis = 0; axis < 3; axis++) out.root[axis] = a.pose.root[axis] + (b.pose.root[axis] - a.pose.root[axis]) * f;
    for (let j = 0; j < out.joints.length; j++) out.joints[j] = a.pose.joints[j] + (b.pose.joints[j] - a.pose.joints[j]) * f;
    for (let axis = 0; axis < 3; axis++) {
      out.eye[axis] = a.pose.eye[axis] + (b.pose.eye[axis] - a.pose.eye[axis]) * f;
      out.muzzle[axis] = a.pose.muzzle[axis] + (b.pose.muzzle[axis] - a.pose.muzzle[axis]) * f;
      out.boundsMin[axis] = Math.min(a.pose.boundsMin[axis], b.pose.boundsMin[axis]);
      out.boundsMax[axis] = Math.max(a.pose.boundsMax[axis], b.pose.boundsMax[axis]);
    }
    out.profileId = b.pose.profileId; out.profileVersion = b.pose.profileVersion;
    out.poseEpoch = b.pose.poseEpoch; out.tick = b.pose.tick;
    out.alive = b.pose.alive; out.hp = b.pose.hp;
    return out;
  }
  return copyPlayerBodyPose(last.pose, out);
}
