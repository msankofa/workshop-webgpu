import {
  HUMANOID_JOINT_COUNT,
  HUMANOID_JOINT_INDEX as J,
  HUMANOID_HIT_PRIMITIVES,
} from './humanoid-rig-topology.js';
import { createPlayerBodyPose, stepPlayerBodyPose, playerPosePoint, playerPoseAnchor } from './player-body-pose.js';
import {
  raySegmentCapsuleHit, rayPlayerHitRig, distanceToPlayerHitRig,
  createPlayerHitRigHistory, pushPlayerHitRigPose, samplePlayerHitRigPose,
} from './player-hit-rig.js';

let pass = 0, fail = 0;
function ok(value, message) { if (value) pass++; else { fail++; console.error('FAIL:', message); } }
const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

ok(HUMANOID_JOINT_COUNT === 16, 'topology keeps the existing 16 semantic joints');
ok(HUMANOID_HIT_PRIMITIVES.length >= 18, 'profile has articulated semantic primitives');

{
  const hit = raySegmentCapsuleHit([0, 0, -3], [0, 0, 1], 10, [0, -1, 0], [0, 1, 0], 0.25);
  ok(hit.hit && near(hit.distance, 2.75), 'arbitrary capsule intersects at the cylinder surface');
  const angled = raySegmentCapsuleHit([-3, 0, 0], [1, 0, 0], 10, [-1, -1, 0], [1, 1, 0], 0.2);
  ok(angled.hit && angled.distance > 2.6 && angled.distance < 2.8, 'arbitrary oriented segment capsule hits');
  const inside = raySegmentCapsuleHit([0, 0, 0], [1, 0, 0], 10, [0, -1, 0], [0, 1, 0], 0.25);
  ok(inside.hit && inside.distance === 0, 'origin inside a primitive reports immediate contact');
}

const standing = stepPlayerBodyPose(createPlayerBodyPose(), {
  position: [1000000, 20, -1000000], velocity: [0, 0, 0], yaw: 0,
  pitch: 0, tick: 120, grounded: true, aiming: false, alive: true,
});
const head = playerPosePoint(standing, J.head);
const eye = playerPoseAnchor(standing, 'eye');
ok(near(head[0], 1000000) && head[1] > 21.6, 'pose stays precise in global coordinates');
ok(eye[1] > head[1], 'eye anchor belongs to the semantic head');

{
  const headHit = rayPlayerHitRig([head[0], head[1], head[2] - 2], [0, 0, 1], 10, standing);
  ok(headHit.hit && headHit.zone === 'head', 'visible head ray resolves the head zone');
  const beside = rayPlayerHitRig([head[0] + 0.24, head[1], head[2] - 2], [0, 0, 1], 10, standing);
  ok(!beside.hit, 'ray beside the visible head misses instead of hitting a body capsule');
  const swept = rayPlayerHitRig([head[0] + 0.24, head[1], head[2] - 2], [0, 0, 1], 10, standing, { inflate: 0.12 });
  ok(swept.hit && swept.zone === 'head', 'a swept projectile radius expands the rig and its broad phase');
  const gap = rayPlayerHitRig([standing.root[0], standing.root[1] + 0.35, standing.root[2] - 2], [0, 0, 1], 10, standing);
  ok(!gap.hit, 'ray through the low gap between legs misses');
  const knee = playerPosePoint(standing, J.kneeL);
  const leg = rayPlayerHitRig([knee[0], knee[1], knee[2] - 2], [0, 0, 1], 10, standing);
  ok(leg.hit && leg.side === 'left' && ['thigh', 'calf'].includes(leg.zone), 'posed left leg is independently hittable');
  ok(distanceToPlayerHitRig(head, standing) === 0, 'nearest distance is zero inside the rig');
  ok(distanceToPlayerHitRig([head[0] + 10, head[1], head[2]], standing) > 9, 'nearest distance grows outside the rig');
}

{
  const moving = stepPlayerBodyPose(createPlayerBodyPose(), {
    position: [0, 0, 0], velocity: [0, 0, -5], yaw: 0, pitch: 0.3,
    tick: 31, grounded: true, aiming: true,
  });
  const handL = playerPosePoint(moving, J.handL), handR = playerPosePoint(moving, J.handR);
  ok(handL[2] < -0.2 && handR[2] < -0.2, 'aiming articulates both hands in front of the chest');
  ok(playerPoseAnchor(moving, 'muzzle')[2] < -0.2, 'server muzzle anchor follows aim facing');
}

{
  const history = createPlayerHitRigHistory(3);
  for (let i = 0; i < 5; i++) {
    const pose = stepPlayerBodyPose(createPlayerBodyPose(), { position: [i, i * 2, 0], velocity: [1, 0, 0], yaw: 0, tick: i, grounded: true, poseEpoch: 1 });
    pushPlayerHitRigPose(history, pose, i * 10);
  }
  ok(history.length === 3, 'history is fixed-capacity');
  const sample = samplePlayerHitRigPose(history, 35);
  ok(near(sample.root[0], 3.5) && near(sample.root[1], 7), 'history interpolates global roots');
  const nextEpoch = stepPlayerBodyPose(createPlayerBodyPose(), { position: [100, 0, 0], tick: 5, grounded: true, poseEpoch: 2 });
  pushPlayerHitRigPose(history, nextEpoch, 50);
  const noBridge = samplePlayerHitRigPose(history, 45);
  ok(noBridge.root[0] === 100 && noBridge.poseEpoch === 2, 'history never interpolates across pose epochs');
}

if (fail) { console.error(`player-hit-rig: ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`player-hit-rig: ${pass} passed`);
