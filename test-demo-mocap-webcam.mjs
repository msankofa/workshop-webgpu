// Guards `mocap-retarget.js` and the demo that drives it, `demos/mocap-webcam.html`.
//
// This test IMPORTS the retarget rather than copying it. That distinction is the whole point of the
// module existing: earlier versions kept a hand-copied twin of the maths here, so the test could
// pass while the page did something else entirely. Everything below runs the shipped code.
//
// The body is the real one from ./player-procedural-body.js, built headlessly — that module takes
// THREE as a parameter and needs no renderer, and it is what pins down facts (the L/R mirror, the
// rig's facing convention) that no amount of reading the names would settle.
//
//   node test-demo-mocap-webcam.mjs

import * as THREE from 'three';
import { createProceduralPlayerBody, BODY_DESIGN_DEFAULTS } from './player-procedural-body.js';
import { setBotBodyKind, botDesignForRole } from './bot-body-design.js';
import {
  createMocapRetarget, OneEuro, minCutoffFor, betaFor,
  MP, POSE_KEYS, CANON_IDS, N_LANDMARKS, DEFAULTS,
} from './mocap-retarget.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1. A synthetic performer, in MediaPipe's own frame: metres, hip origin, y DOWN, z negative toward
//    the camera. 1.7 m, standing, arms out sideways. Facing the camera, their LEFT is at image +x.
// ---------------------------------------------------------------------------

const mp = Array.from({ length: N_LANDMARKS }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
const set = (i, x, y, z) => { mp[i].x = x; mp[i].y = y; mp[i].z = z; };
function standingPose() {
  set(MP.nose, 0, -0.68, -0.08);
  set(MP.earL, 0.07, -0.65, 0); set(MP.earR, -0.07, -0.65, 0);
  set(MP.shoulderL, 0.18, -0.50, 0); set(MP.shoulderR, -0.18, -0.50, 0);
  set(MP.elbowL, 0.48, -0.50, 0); set(MP.elbowR, -0.48, -0.50, 0);
  set(MP.wristL, 0.76, -0.50, 0); set(MP.wristR, -0.76, -0.50, 0);
  set(MP.hipL, 0.10, 0, 0); set(MP.hipR, -0.10, 0, 0);
  set(MP.kneeL, 0.10, 0.45, -0.04); set(MP.kneeR, -0.10, 0.45, -0.04);   // knees slightly forward
  set(MP.ankleL, 0.10, 0.88, 0); set(MP.ankleR, -0.10, 0.88, 0);
  set(MP.heelL, 0.10, 0.90, 0.04); set(MP.heelR, -0.10, 0.90, 0.04);
  set(MP.toeL, 0.10, 0.92, -0.12); set(MP.toeR, -0.10, 0.92, -0.12);
}
standingPose();

// Image-space landmarks for the root-recovery path.
const im = Array.from({ length: N_LANDMARKS }, () => ({ x: 0.5, y: 0.5 }));
function imageAt(cx, scale) {
  im[MP.shoulderL] = { x: cx + 0.09 * scale, y: 0.35 };
  im[MP.shoulderR] = { x: cx - 0.09 * scale, y: 0.35 };
  im[MP.hipL] = { x: cx + 0.05 * scale, y: 0.6 };
  im[MP.hipR] = { x: cx - 0.05 * scale, y: 0.6 };
}
imageAt(0.5, 1);

// ---------------------------------------------------------------------------
// 2. The real body.
// ---------------------------------------------------------------------------

setBotBodyKind('soldier');
const sceneRoot = new THREE.Group();
const body = createProceduralPlayerBody({
  THREE, scene: sceneRoot, terrainHeight: () => 0, mode: 'remote', design: botDesignForRole('rifleman'),
});
ok(typeof body.setRagdollPose === 'function' && body.limbLengths && body.joints,
  'body exposes setRagdollPose, limbLengths, joints');

const LL = body.limbLengths;
const DESIGN_H = LL.legLen / BODY_DESIGN_DEFAULTS.legLenRatio;

// ---------------------------------------------------------------------------
// 3. The module under test. `feed` runs enough frames for the running proportion means to converge,
//    exactly as a live session does.
// ---------------------------------------------------------------------------

const mocap = createMocapRetarget({ THREE });
const pose = mocap.pose;

function feed(opts = {}, frames = 40, imageLm = null) {
  const o = { smooth: 0, beta: 0, ...opts };            // smooth 0 = 8 Hz cutoff, near pass-through
  for (let i = 0; i < frames; i++) mocap.ingest(mp, imageLm, i / 30, o);
  return mocap.solve(LL, DESIGN_H, o);
}
function fresh(opts = {}, frames = 40, imageLm = null) {
  mocap.reset();
  return feed(opts, frames, imageLm);
}

// --- axis conversion -------------------------------------------------------
fresh();
ok(mocap.world[MP.shoulderL].y > 0 && mocap.world[MP.ankleL].y < 0,
  'y flipped: shoulders above the hip origin, ankles below');
ok(mocap.world[MP.toeL].z > mocap.world[MP.ankleL].z,
  'z flipped: toes (nearer the camera) end up at larger z');

// --- the retarget's core promise: our skeleton, their angles ---------------
ok(POSE_KEYS.every(k => Number.isFinite(pose[k].x + pose[k].y + pose[k].z)), 'no NaN in the pose');
ok(near(Math.min(pose.footL.y, pose.footR.y), 0, 1e-9), 'lower foot planted on y=0');
ok(near(pose.hipL.distanceTo(pose.kneeL), LL.thighLen, 1e-9)
  && near(pose.kneeL.distanceTo(pose.footL), LL.shinLen, 1e-9), 'leg bones are OUR lengths');
ok(near(pose.shoulderR.distanceTo(pose.elbowR), LL.armLen / 2, 1e-9)
  && near(pose.elbowR.distanceTo(pose.handR), LL.armLen / 2, 1e-9), 'arm bones are OUR lengths');
ok(near(pose.head.y, DESIGN_H, 0.15 * DESIGN_H),
  `head height ${pose.head.y.toFixed(2)} m is near design height ${DESIGN_H.toFixed(2)} m`);
ok(near(pose.handR.y, pose.shoulderR.y, 0.02) && pose.handR.x > pose.shoulderR.x + 0.5 * LL.armLen,
  'T-pose: hand out sideways at shoulder height');

// --- sidedness, measured against the real rig ------------------------------
body.setRagdollPose(pose);
sceneRoot.updateMatrixWorld(true);
const at = (o) => o.getWorldPosition(new THREE.Vector3());
ok(near(at(body.joints.rightHand).x, pose.handL.x, 0.05) && near(at(body.joints.leftHand).x, pose.handR.x, 0.05),
  'ragdoll key L drives joints.rightHand (the mirror bot-limb-map.js:10-13 documents)');
ok(at(body.joints.leftHand).x > 0,
  "facing view: the VISUAL left hand lands at +x, where the performer's left is — a proper person");

// --- plant off -------------------------------------------------------------
fresh({ plant: false });
ok(near(pose.pelvis.y, LL.legLen, 1e-9), 'plant off: pelvis pinned at legLen');

// ---------------------------------------------------------------------------
// 4. One-Euro filter.
// ---------------------------------------------------------------------------

ok(minCutoffFor(0) > 7 && minCutoffFor(1) < 0.3 && minCutoffFor(0) > minCutoffFor(1),
  'minCutoffFor maps the slider 0→8 Hz, 1→0.25 Hz, monotone');
ok(betaFor(0) === 0 && betaFor(1) === 2, 'betaFor maps 0→0, 1→2');
{
  const f = new OneEuro(); let maxDev = 0;
  for (let i = 0; i < 300; i++) {
    const v = f.filter(i % 2 ? 0.005 : -0.005, 1 / 30, 0.5, 0.36);
    if (i > 30) maxDev = Math.max(maxDev, Math.abs(v));
  }
  ok(maxDev < 0.001, `one-euro: ±5 mm jitter attenuated to ${(maxDev * 1000).toFixed(2)} mm`);

  const g = new OneEuro(); g.filter(0, 1 / 30, 0.5, 0.36);
  let v = 0, n = 0;
  while (v < 0.95 && n < 60) { v = g.filter(1, 1 / 30, 0.5, 0.36); n++; }
  const h = new OneEuro(); h.filter(0, 1 / 30, 0.5, 0);
  let v2 = 0, n2 = 0;
  while (v2 < 0.95 && n2 < 200) { v2 = h.filter(1, 1 / 30, 0.5, 0); n2++; }
  ok(n <= 12, `one-euro: a 1 m step reaches 95% in ${n} frames (${(n / 30).toFixed(2)} s)`);
  ok(n2 > n, `one-euro: the same step without beta lags longer (${n2} frames) — the speed term works`);
}
{
  // The visibility gate must HOLD a dropped landmark, not track the garbage that replaced it.
  mocap.reset();
  for (let i = 0; i < 40; i++) mocap.ingest(mp, null, i / 30, { smooth: 0.5, minVis: 0.3 });
  const held = mocap.world[MP.wristL].clone();
  const bad = mp.map((p, i) => (i === MP.wristL ? { x: 3, y: 3, z: 3, visibility: 0.1 } : p));
  for (let i = 40; i < 60; i++) mocap.ingest(bad, null, i / 30, { smooth: 0.5, minVis: 0.3 });
  ok(mocap.world[MP.wristL].distanceTo(held) < 1e-9, 'visibility gate: a dropped landmark holds its last position');
}

// ---------------------------------------------------------------------------
// 5. Bases. The rig's face is on local −Z, so a facing basis must be (F×U, U, −F). Getting the
//    cross product backwards is left-handed and silently mirrors the part, which is what an earlier
//    version did — these checks are why it was caught before it reached a browser.
// ---------------------------------------------------------------------------

fresh();
{
  const bodyQ = mocap.bodyOrientation(new THREE.Quaternion());
  const bodyFace = new THREE.Vector3(0, 0, -1).applyQuaternion(bodyQ);
  const lat = new THREE.Vector3().subVectors(pose.shoulderR, pose.shoulderL).normalize();
  const expect = new THREE.Vector3().crossVectors(lat, new THREE.Vector3(0, 1, 0)).normalize();
  ok(bodyFace.distanceTo(expect) < 1e-6 && bodyFace.z > 0.99,
    `facing view: rig face = cross(shoulderR−shoulderL, up) = +z, toward the viewer (z=${bodyFace.z.toFixed(3)})`);
  ok(mocap.bodyForward(new THREE.Vector3()).distanceTo(bodyFace) < 1e-6,
    'bodyForward agrees with the orientation quaternion it is derived from');

  const q = mocap.facingBasis(new THREE.Quaternion(), bodyFace, new THREE.Vector3().subVectors(pose.neck, pose.pelvis));
  ok(Math.abs(q.dot(bodyQ)) > 0.9999, 'facingBasis(bodyForward) reproduces the rig body basis');

  const turned = new THREE.Vector3(1, 0, 1).normalize();
  const q2 = mocap.facingBasis(new THREE.Quaternion(), turned, new THREE.Vector3(0, 1, 0));
  ok(new THREE.Vector3(0, 0, -1).applyQuaternion(q2).distanceTo(turned) < 1e-9,
    'facingBasis: local −Z lands on the requested face direction (45° head turn)');
  ok(new THREE.Vector3(0, 1, 0).applyQuaternion(q2).y > 0.9999, 'facingBasis: up preserved');
  ok(new THREE.Matrix4().makeRotationFromQuaternion(q2).determinant() > 0.9999,
    'facingBasis: right-handed (determinant +1), so nothing is silently mirrored');
  ok(mocap.facingBasis(new THREE.Quaternion(), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)) === null,
    'facingBasis: null when the face is parallel to up, rather than a garbage basis');
}

// ---------------------------------------------------------------------------
// 6. The three views, on an ASYMMETRIC pose so a reflection is actually visible.
// ---------------------------------------------------------------------------

{
  set(MP.elbowL, 0.30, -0.80, 0); set(MP.wristL, 0.30, -1.05, 0);   // performer's LEFT arm up
  const faceOf = () => new THREE.Vector3(0, 0, -1).applyQuaternion(mocap.bodyOrientation(new THREE.Quaternion()));
  // A person's right = forward × up. Proper person ⟺ the visual-right limb (key L) is on that side.
  const properPerson = () => {
    const r = new THREE.Vector3().crossVectors(faceOf(), new THREE.Vector3(0, 1, 0));
    return pose.shoulderL.clone().sub(pose.shoulderR).dot(r) > 0;
  };

  fresh({ reflect: false, yawDeg: 0 });
  ok(faceOf().z > 0.99 && properPerson(), 'facing: faces the viewer, proper person');
  ok(pose.handR.y > pose.handL.y + 0.3 && pose.handR.x > 0,
    'facing: the raised arm is the VISUAL LEFT (key R) at +x — true limbs, opposite screen side');

  fresh({ reflect: true, yawDeg: 0 });
  ok(faceOf().z > 0.99 && properPerson(), 'mirror: faces the viewer, proper person');
  ok(pose.handL.y > pose.handR.y + 0.3 && pose.handL.x < 0,
    "mirror: the raised arm is the VISUAL RIGHT (key L) at -x — the performer's own screen side");

  fresh({ reflect: false, yawDeg: 180 });
  ok(faceOf().z < -0.99 && properPerson(), 'follow: faces away, proper person');
  ok(pose.handR.y > pose.handL.y + 0.3 && pose.handR.x < 0,
    'follow: the raised arm is the visual left at -x — its left is your left, seen from behind');

  standingPose();
}

// ---------------------------------------------------------------------------
// 7. Depth damping. z is the weakest axis of a one-camera estimate; the slider shrinks it about the
//    hips, and must not touch x, y or our bone lengths.
// ---------------------------------------------------------------------------

{
  set(MP.wristL, 0.30, -0.50, -0.45);   // performer's left hand punched toward the camera
  fresh({ depthScale: 1 });
  const zFull = pose.handR.z, xFull = pose.handR.x, yFull = pose.handR.y, pz = pose.pelvis.z;
  fresh({ depthScale: 0.5 });
  const zHalf = pose.handR.z;
  fresh({ depthScale: 0 });
  const zFlat = pose.handR.z;
  ok(Math.abs(zHalf - pz) < Math.abs(zFull - pz),
    `depth 0.5 pulls the punched hand back toward the body (${zFull.toFixed(3)} → ${zHalf.toFixed(3)} m)`);
  ok(Math.abs(zFlat - pz) < Math.abs(zHalf - pz), `depth 0 flattens it further (${zFlat.toFixed(3)} m)`);
  fresh({ depthScale: 1 });
  ok(near(pose.handR.x, xFull, 1e-9) && near(pose.handR.y, yFull, 1e-9), 'depth damping leaves x and y alone');
  fresh({ depthScale: 0.3 });
  ok(near(pose.shoulderR.distanceTo(pose.elbowR), LL.armLen / 2, 1e-9)
    && near(pose.elbowR.distanceTo(pose.handR), LL.armLen / 2, 1e-9), 'depth damping preserves our bone lengths');
  standingPose();
}

// ---------------------------------------------------------------------------
// 8. Knee guard. A knee driven behind the hip→ankle line is anatomically impossible; the guard
//    reflects only that case, and must not disturb a leg that was already bending forward.
// ---------------------------------------------------------------------------

{
  const kneeAlongForward = () => {
    const f = mocap.bodyForward(new THREE.Vector3());
    const ax = new THREE.Vector3().subVectors(pose.footL, pose.hipL).normalize();
    const off = new THREE.Vector3().subVectors(pose.kneeL, pose.hipL);
    off.addScaledVector(ax, -off.dot(ax));
    return off.dot(f);
  };
  fresh({ kneeGuard: 0 });
  const goodOff = kneeAlongForward(), goodKnee = pose.kneeL.clone();
  ok(goodOff > 0, 'the synthetic standing pose has its knees bending forward, as a person does');
  fresh({ kneeGuard: 1 });
  ok(pose.kneeL.distanceTo(goodKnee) < 1e-9, 'knee guard leaves an already-correct knee exactly alone');

  // Now invert them: knees behind the leg line, which is what noisy depth produces.
  set(MP.kneeL, 0.10, 0.45, 0.18); set(MP.kneeR, -0.10, 0.45, 0.18);
  fresh({ kneeGuard: 0 });
  const badOff = kneeAlongForward();
  ok(badOff < 0, `without the guard the knee stays inverted (${badOff.toFixed(3)} m behind the leg line)`);
  fresh({ kneeGuard: 1 });
  const fixedOff = kneeAlongForward();
  ok(fixedOff > 0, `with the guard it bends forward again (${fixedOff.toFixed(3)} m ahead)`);
  ok(near(pose.hipL.distanceTo(pose.kneeL), LL.thighLen, 1e-6)
    && near(pose.kneeL.distanceTo(pose.footL), LL.shinLen, 1e-6),
    'knee guard re-solves by two-bone IK, so thigh and shin keep their exact lengths');
  const footBefore = pose.footL.clone();
  fresh({ kneeGuard: 0.5 });
  ok(pose.footL.distanceTo(footBefore) < 1e-6, 'knee guard moves the knee only — the foot does not move');
  standingPose();
}

// ---------------------------------------------------------------------------
// 9. Foot lock. The estimate has no ground truth, so a standing performer's feet drift. A planted
//    foot should hold; a lifted one should release; a large slip should release rather than strand
//    the figure. Drift is injected by sliding the ankles, which is how a hip-centred estimate
//    expresses a performer creeping sideways.
// ---------------------------------------------------------------------------

{
  const slideAnkles = (dx) => {
    set(MP.ankleL, 0.10 + dx, 0.88, 0); set(MP.ankleR, -0.10 + dx, 0.88, 0);
    set(MP.kneeL, 0.10 + dx * 0.5, 0.45, -0.04); set(MP.kneeR, -0.10 + dx * 0.5, 0.45, -0.04);
  };

  fresh({ footLock: 0 });
  const startX = pose.footL.x;
  for (let i = 1; i <= 10; i++) { slideAnkles(i * 0.004); feed({ footLock: 0 }, 1); }
  const freeDrift = Math.abs(pose.footL.x - startX);
  ok(freeDrift > 0.01, `no lock: the foot drifts with the estimate (${freeDrift.toFixed(3)} m)`);

  standingPose();
  fresh({ footLock: 1 });
  ok(mocap.locks.L.active && mocap.locks.R.active, 'both feet latch as planted when they are on the floor');
  const lockedStart = pose.footL.x;
  for (let i = 1; i <= 10; i++) { slideAnkles(i * 0.004); feed({ footLock: 1 }, 1); }
  ok(Math.abs(pose.footL.x - lockedStart) < 1e-6, 'foot lock: the planted foot holds its XZ through the same drift');
  ok(near(pose.hipL.distanceTo(pose.kneeL), LL.thighLen, 1e-6)
    && near(pose.kneeL.distanceTo(pose.footL), LL.shinLen, 1e-6),
    'foot lock: the knee absorbs the correction and bone lengths survive');

  // A REAL knee raise, which is the only thing that lifts a foot here: with our bone lengths fixed,
  // shortening the source leg does not raise anything — the foot just travels the same way down the
  // same direction. The thigh has to swing forward (−z is toward the camera) with the shin hanging.
  // Getting this wrong the first time is worth keeping written down, because it is the retarget's
  // central promise doing its job, not a bug.
  standingPose();
  fresh({ footLock: 1 });
  set(MP.kneeL, 0.10, 0.02, -0.42); set(MP.ankleL, 0.10, 0.45, -0.42);
  set(MP.heelL, 0.10, 0.47, -0.38); set(MP.toeL, 0.10, 0.47, -0.54);
  feed({ footLock: 1 }, 6);
  // The performer's LEFT leg is key R (the visual left), so that is the lock that must release.
  ok(pose.footR.y > 0.3, `the knee raise lifts that foot clear of the floor (${pose.footR.y.toFixed(2)} m)`);
  ok(!mocap.locks.R.active && mocap.locks.L.active, 'a lifted foot releases its lock; the stance foot keeps its own');

  standingPose();
  fresh({ footLock: 1 });
  slideAnkles(0.6);
  feed({ footLock: 1 }, 1);
  ok(near(pose.footL.x, mocap.locks.L.x, 1e-9),
    'a slip past lockMaxSlip re-latches at the new position instead of dragging the figure back');

  standingPose();
  fresh({ footLock: 0.5 });
  const halfStart = pose.footL.x;
  for (let i = 1; i <= 10; i++) { slideAnkles(i * 0.004); feed({ footLock: 0.5 }, 1); }
  const halfDrift = Math.abs(pose.footL.x - halfStart);
  ok(halfDrift > 1e-6 && halfDrift < freeDrift,
    `foot lock 0.5 leaves part of the drift (${halfDrift.toFixed(4)} m) — a blend, not a switch`);
  standingPose();
}

// ---------------------------------------------------------------------------
// 10. Root motion. Hip-centred landmarks lose translation; the image landmarks recover it.
// ---------------------------------------------------------------------------

{
  const ROOT = { rootMotion: true, smooth: 0, beta: 0, aspect: 4 / 3 };
  const run = (n0, n1) => { for (let i = n0; i < n1; i++) mocap.ingest(mp, im, i / 30, ROOT); };

  mocap.reset(); imageAt(0.5, 1); run(0, 20);
  ok(Math.abs(mocap.root.x) < 1e-6 && Math.abs(mocap.root.z) < 1e-6, 'root starts at the origin it calibrated to');
  imageAt(0.75, 1); run(20, 60);
  ok(mocap.root.x > 0.1, `stepping to image +x moves the root +x (${mocap.root.x.toFixed(2)} m)`);

  mocap.reset(); imageAt(0.5, 1); run(0, 20);
  imageAt(0.5, 1.4); run(20, 60);   // larger in frame = closer
  ok(mocap.root.z > 0.05, `getting larger in frame moves the root toward the viewer (+z ${mocap.root.z.toFixed(2)} m)`);

  mocap.reset(); imageAt(0.5, 1); run(0, 20);
  imageAt(0.8, 1); run(20, 60);
  mocap.solve(LL, DESIGN_H, { rootMotion: false, footLock: 0 });
  const noRoot = POSE_KEYS.map(k => pose[k].clone());
  mocap.solve(LL, DESIGN_H, { rootMotion: true, rootScale: 1, footLock: 0 });
  const deltas = POSE_KEYS.map((k, i) => pose[k].clone().sub(noRoot[i]));
  const spread = Math.max(...deltas.map(d => d.distanceTo(deltas[0])));
  ok(deltas[0].length() > 0.05 && spread < 1e-9, 'root offset translates every joint by the same vector — no deformation');

  mocap.solve(LL, DESIGN_H, { rootMotion: true, rootScale: 1, yawDeg: 90, footLock: 0 });
  ok(Math.abs(pose.pelvis.z) > 0.05 && Math.abs(pose.pelvis.x) < 1e-6,
    'the root rotates with the view yaw, so "follow" and 90° do not send the figure sideways');

  mocap.solve(LL, DESIGN_H, { rootMotion: true, rootScale: 0, footLock: 0 });
  ok(Math.abs(pose.pelvis.x) < 1e-9, 'root scale 0 disables the offset without disabling the recovery');
  ok(DEFAULTS.hfovDeg === 60, 'root depth assumes a 60° horizontal field of view — an assumption, not a measurement');
}

// ---------------------------------------------------------------------------
// 11. Frame round-trip, which recording, scrubbing and export all rely on.
// ---------------------------------------------------------------------------

{
  standingPose();
  fresh({ footLock: 0 });
  const frame = mocap.getFrame();
  const before = POSE_KEYS.map(k => pose[k].clone());
  ok(frame.length === N_LANDMARKS * 4, 'getFrame packs x, y, z, visibility per landmark');

  // A fresh instance has no running proportion means yet, so it gets the same convergence the
  // recording had — replaying one frame repeatedly is exactly what a paused scrub does.
  const other = createMocapRetarget({ THREE });
  for (let i = 0; i < 40; i++) { other.setFrame(frame, [0, 0]); other.solve(LL, DESIGN_H, { footLock: 0 }); }
  const worst = Math.max(...before.map((p, i) => p.distanceTo(other.pose[POSE_KEYS[i]])));
  ok(worst < 1e-6, `setFrame/getFrame round-trips the pose (worst joint error ${worst.toExponential(1)} m)`);
}

// ---------------------------------------------------------------------------
// 12. orientJoints — the pass that fixes what setRagdollPose leaves undone, against the real rig.
// ---------------------------------------------------------------------------

{
  standingPose();
  fresh();
  body.setRagdollPose(pose);
  mocap.orientJoints(body.joints, { headTurn: false, footYaw: false });
  const bodyQ = mocap.bodyOrientation(new THREE.Quaternion());
  ok(Math.abs(body.joints.head.quaternion.dot(bodyQ)) > 0.99, 'headTurn off: the head keeps the body orientation');

  set(MP.nose, 0.16, -0.68, 0.02);   // performer turns their head to their left
  fresh();
  body.setRagdollPose(pose);
  mocap.orientJoints(body.joints, { headTurn: true, footYaw: true });
  const turnedQ = body.joints.head.quaternion.clone();
  ok(Math.abs(turnedQ.dot(bodyQ)) < 0.99, 'headTurn on: a turned head no longer matches the chest');
  ok(new THREE.Vector3(0, 0, -1).applyQuaternion(turnedQ).dot(mocap.facing.head) > 0.99,
    'the head ends up facing the direction taken from the landmarks');
  ok(new THREE.Vector3(0, 1, 0).applyQuaternion(turnedQ).y > 0.7, 'the turned head stays upright');
  standingPose();

  set(MP.toeL, 0.28, 0.92, -0.06);   // toes turned out
  fresh();
  body.setRagdollPose(pose);
  mocap.orientJoints(body.joints, { headTurn: true, footYaw: true });
  // Ragdoll key L is the VISUAL RIGHT limb, so facing.footL drives joints.rightFoot.
  ok(new THREE.Vector3(0, 0, -1).applyQuaternion(body.joints.rightFoot.quaternion).dot(mocap.facing.footL) > 0.99,
    'footYaw on: the foot faces heel→toe, not where the chest faces');
  mocap.orientJoints(body.joints, { headTurn: true, footYaw: false });
  ok(Math.abs(body.joints.rightFoot.quaternion.dot(mocap.bodyOrientation(new THREE.Quaternion()))) > 0.99,
    'footYaw off: the foot falls back to the body orientation');
  standingPose();
}

// ---------------------------------------------------------------------------
// 13. The demo page and the module have to agree — the whole reason the module exists.
// ---------------------------------------------------------------------------

{
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('./demos/mocap-webcam.html', import.meta.url), 'utf8');
  ok(/import\s*\{[^}]*createMocapRetarget[^}]*\}\s*from\s*'\.\.\/mocap-retarget\.js'/.test(html),
    'demos/mocap-webcam.html imports the retarget rather than carrying a copy');
  ok(!/function\s+buildCanon\s*\(/.test(html) && !/class\s+OneEuro/.test(html),
    'the demo no longer defines its own buildCanon or OneEuro — no hand-synced twin');
  for (const id of ['depthScale', 'kneeGuard', 'footLock', 'trimIn', 'trimOut', 'view', 'scrub']) {
    ok(html.includes(`id="${id}"`), `the panel has a control for ${id}`);
  }
  ok(CANON_IDS.length === 22 && POSE_KEYS.length === 16,
    'the canonical vocabulary is 22 source joints feeding the 16 setRagdollPose keys');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
