// Guards demos/mocap-webcam.html — MediaPipe world landmarks retargeted onto the real soldier.
// The landmark→canonical→pose maths is copied from the demo (it lives inline there); the body is
// the real one from ../player-procedural-body.js, built headlessly. A synthetic standing pose in
// MediaPipe's own frame (metres, hip origin, y down, z toward the camera negative) is pushed
// through and the result checked for our proportions, planted feet, and correct sidedness.
//
//   node test-demo-mocap-webcam.mjs

import * as THREE from 'three';
import { createProceduralPlayerBody, BODY_DESIGN_DEFAULTS } from './player-procedural-body.js';
import { setBotBodyKind, botDesignForRole } from './bot-body-design.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const N_LM = 33;
let restCount = 0;

// --- synthetic performer, MediaPipe world frame: y DOWN, x right (image), hip origin --------------
// A 1.7 m person standing, arms out sideways (T), facing the camera. Their LEFT side appears at
// image +x when facing the camera.
const mp = Array.from({ length: N_LM }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
const set = (i, x, y, z) => { mp[i].x = x; mp[i].y = y; mp[i].z = z; };
set(0, 0, -0.68, -0.08);                 // nose
set(7, 0.07, -0.65, 0); set(8, -0.07, -0.65, 0);           // ears
set(11, 0.18, -0.50, 0); set(12, -0.18, -0.50, 0);         // shoulders
set(13, 0.48, -0.50, 0); set(14, -0.48, -0.50, 0);         // elbows (T pose)
set(15, 0.76, -0.50, 0); set(16, -0.76, -0.50, 0);         // wrists
set(23, 0.10, 0, 0); set(24, -0.10, 0, 0);                 // hips
set(25, 0.10, 0.45, 0); set(26, -0.10, 0.45, 0);           // knees
set(27, 0.10, 0.88, 0); set(28, -0.10, 0.88, 0);           // ankles
set(31, 0.10, 0.92, -0.12); set(32, -0.10, 0.92, -0.12);   // toes, toward camera

// --- ingest (no smoothing) ------------------------------------------------------------------------
const world = Array.from({ length: N_LM }, () => new THREE.Vector3());
const ingest = (reflect) => { for (let i = 0; i < N_LM; i++) world[i].set((reflect ? -1 : 1) * mp[i].x, -mp[i].y, -mp[i].z); restCount = 0; };
ingest(false);
ok(world[11].y > 0 && world[27].y < 0, 'y flipped: shoulders above hips, ankles below');
ok(world[31].z > world[27].z, 'z flipped: toes (toward camera) end up at larger z');

// --- canonical joints + rest lengths (copied) ---------------------------------------------------
const CANON_IDS = ['hips', 'chest', 'neck', 'head', 'headTop',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const canon = {}; for (const s of CANON_IDS) canon[s] = new THREE.Vector3();
const rest = { trunk: 0, spine: 0, neck: 0, shoulderL: 0, shoulderR: 0, hipL: 0, hipR: 0 };
const _mid = new THREE.Vector3(), _axis = new THREE.Vector3(), _ears = new THREE.Vector3();
function buildCanon() {
  canon.hips.addVectors(world[23], world[24]).multiplyScalar(0.5);
  _mid.addVectors(world[11], world[12]).multiplyScalar(0.5);
  _ears.addVectors(world[7], world[8]).multiplyScalar(0.5);
  _axis.subVectors(_mid, canon.hips);
  canon.chest.copy(_mid).addScaledVector(_axis, -0.12);
  canon.neck.copy(_mid).lerp(_ears, 0.35);
  canon.head.copy(_ears);
  _axis.subVectors(_ears, _mid);
  canon.headTop.copy(_ears).addScaledVector(_axis, 0.45);
  canon.leftUpperArm.copy(world[11]);  canon.leftLowerArm.copy(world[13]);  canon.leftHand.copy(world[15]);
  canon.rightUpperArm.copy(world[12]); canon.rightLowerArm.copy(world[14]); canon.rightHand.copy(world[16]);
  canon.leftUpperLeg.copy(world[23]);  canon.leftLowerLeg.copy(world[25]);  canon.leftFoot.copy(world[27]);
  canon.rightUpperLeg.copy(world[24]); canon.rightLowerLeg.copy(world[26]); canon.rightFoot.copy(world[28]);
  const k = restCount < 30 ? 1 / (restCount + 1) : 0.02;
  const upd = (key, val) => { rest[key] += (val - rest[key]) * k; };
  upd('trunk', canon.hips.distanceTo(canon.headTop));
  upd('spine', canon.hips.distanceTo(canon.chest));
  upd('neck', canon.chest.distanceTo(canon.neck));
  upd('shoulderL', canon.chest.distanceTo(canon.leftUpperArm));
  upd('shoulderR', canon.chest.distanceTo(canon.rightUpperArm));
  upd('hipL', canon.hips.distanceTo(canon.leftUpperLeg));
  upd('hipR', canon.hips.distanceTo(canon.rightUpperLeg));
  restCount++;
}

// --- retarget (copied) --------------------------------------------------------------------------
const POSE_KEYS = ['head', 'neck', 'chest', 'pelvis', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR',
  'handL', 'handR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR'];
const pose = {}; for (const k of POSE_KEYS) pose[k] = new THREE.Vector3();
const _dir = new THREE.Vector3();
function dir(a, b) { _dir.subVectors(canon[b], canon[a]); const l = _dir.length(); return l > 1e-7 ? _dir.divideScalar(l) : _dir.set(0, 1, 0); }

function retarget(body, reflect, plant, yawDeg = 0) {
  buildCanon();
  if (yawDeg) { const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg)); for (const k of CANON_IDS) canon[k].applyQuaternion(q); }
  const { legLen, thighLen, shinLen, armLen } = body.limbLengths;
  const halfArm = armLen * 0.5;
  const designH = legLen / BODY_DESIGN_DEFAULTS.legLenRatio;
  const trunkK = (designH - legLen) / Math.max(rest.trunk, 1e-6);
  const L = reflect ? 'L' : 'R', R = reflect ? 'R' : 'L';   // performer-left -> key R (visual left) unless reflected
  pose.pelvis.set(0, 0, 0);
  pose.chest.copy(pose.pelvis).addScaledVector(dir('hips', 'chest'), rest.spine * trunkK);
  pose.neck.copy(pose.chest).addScaledVector(dir('chest', 'neck'), rest.neck * trunkK);
  pose.head.copy(pose.neck).addScaledVector(dir('neck', 'headTop'), rest.neck * trunkK * 0.6);
  for (const [side, key] of [['left', L], ['right', R]]) {
    const up = `${side}UpperArm`, lo = `${side}LowerArm`, hd = `${side}Hand`;
    pose[`shoulder${key}`].copy(pose.chest).addScaledVector(dir('chest', up), rest[side === 'left' ? 'shoulderL' : 'shoulderR'] * trunkK);
    pose[`elbow${key}`].copy(pose[`shoulder${key}`]).addScaledVector(dir(up, lo), halfArm);
    pose[`hand${key}`].copy(pose[`elbow${key}`]).addScaledVector(dir(lo, hd), halfArm);
    const hip = `${side}UpperLeg`, knee = `${side}LowerLeg`, foot = `${side}Foot`;
    pose[`hip${key}`].copy(pose.pelvis).addScaledVector(dir('hips', hip), rest[side === 'left' ? 'hipL' : 'hipR'] * trunkK);
    pose[`knee${key}`].copy(pose[`hip${key}`]).addScaledVector(dir(hip, knee), thighLen);
    pose[`foot${key}`].copy(pose[`knee${key}`]).addScaledVector(dir(knee, foot), shinLen);
  }
  const lift = plant ? -Math.min(pose.footL.y, pose.footR.y) : legLen;
  for (const key of POSE_KEYS) pose[key].y += lift;
  return { legLen, thighLen, shinLen, armLen, designH };
}

// --- the real body ------------------------------------------------------------------------------
setBotBodyKind('soldier');
const root = new THREE.Group();
const body = createProceduralPlayerBody({ THREE, scene: root, terrainHeight: () => 0, mode: 'remote', design: botDesignForRole('rifleman') });
ok(typeof body.setRagdollPose === 'function' && body.limbLengths && body.joints, 'body exposes setRagdollPose, limbLengths, joints');

const m = retarget(body, false, true);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
ok(POSE_KEYS.every(k => Number.isFinite(pose[k].x + pose[k].y + pose[k].z)), 'no NaN in the pose');
ok(near(Math.min(pose.footL.y, pose.footR.y), 0, 1e-9), 'lower foot planted on y=0');
ok(near(pose.hipL.distanceTo(pose.kneeL), m.thighLen, 1e-9) && near(pose.kneeL.distanceTo(pose.footL), m.shinLen, 1e-9), 'leg bones are OUR lengths, not the performer\'s');
ok(near(pose.shoulderR.distanceTo(pose.elbowR), m.armLen / 2, 1e-9) && near(pose.elbowR.distanceTo(pose.handR), m.armLen / 2, 1e-9), 'arm bones are OUR lengths');
ok(near(pose.head.y, m.designH, 0.15 * m.designH), `head height ${pose.head.y.toFixed(2)} m is near design height ${m.designH.toFixed(2)} m`);
ok(near(pose.handR.y, pose.shoulderR.y, 0.02) && pose.handR.x > pose.shoulderR.x + 0.5 * m.armLen, 'T-pose: hand out sideways at shoulder height');
ok(pose.handR.x > 0 && pose.handL.x < 0, 'facing view: performer left (+x) lands on key R, the visual-left limb');

// Feed it to the body and confirm the sidedness pose-retarget.html measured: key L → visual RIGHT.
body.setRagdollPose(pose);
root.updateMatrixWorld(true);
const at = (o) => o.getWorldPosition(new THREE.Vector3());
const rh = at(body.joints.rightHand), lh = at(body.joints.leftHand);
ok(near(rh.x, pose.handL.x, 0.05) && near(lh.x, pose.handR.x, 0.05), 'ragdoll key L drives joints.rightHand (mirror documented in bot-limb-map.js)');
ok(lh.x > 0, "facing view: the VISUAL left hand ends up at +x, where the performer's left is — a proper person");

// Un-planted: pelvis sits at legLen.
retarget(body, false, false);
ok(near(pose.pelvis.y, m.legLen, 1e-9), 'plant off: pelvis pinned at legLen');

// Mirror view: reflect + the other key mapping. Same shape, sides exchanged.
const before = pose.handR.clone();
ingest(true); retarget(body, true, true);
ok(near(pose.handL.x, -before.x, 1e-9), 'mirror view: the reflected performer-left lands on key L at -x');
ingest(false);

// --- second pass: One-Euro filter (copied) ------------------------------------------------------
class OneEuro {
  constructor() { this.x = 0; this.dx = 0; this.init = false; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, dt, minCutoff, beta, dCutoff = 1) {
    if (!this.init) { this.x = x; this.dx = 0; this.init = true; return x; }
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * OneEuro.alpha(dCutoff, dt);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += (x - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}
{
  // Jitter of ±5 mm at 30 Hz around a still point: the filter should hold it well under the input.
  const f = new OneEuro(); let maxDev = 0;
  for (let i = 0; i < 300; i++) { const v = f.filter((i % 2 ? 0.005 : -0.005), 1 / 30, 0.5, 0.36); if (i > 30) maxDev = Math.max(maxDev, Math.abs(v)); }
  ok(maxDev < 0.001, `one-euro: 5 mm jitter attenuated to ${(maxDev * 1000).toFixed(2)} mm`);
  // A 1 m step: with beta the lag is short (settles in well under half a second).
  const g = new OneEuro(); g.filter(0, 1 / 30, 0.5, 0.36); let v = 0, n = 0;
  while (v < 0.95 && n < 60) { v = g.filter(1, 1 / 30, 0.5, 0.36); n++; }
  ok(n <= 12, `one-euro: 1 m step reaches 95% in ${n} frames (${(n / 30).toFixed(2)} s)`);
  const h = new OneEuro(); h.filter(0, 1 / 30, 0.5, 0); let v2 = 0, n2 = 0;
  while (v2 < 0.95 && n2 < 200) { v2 = h.filter(1, 1 / 30, 0.5, 0); n2++; }
  ok(n2 > n, `one-euro: without beta the same step lags longer (${n2} frames)`);
}

// --- second pass: facing basis matches the rig's measured convention -----------------------------
// bodyOrientation (pose-retarget.html) builds the rig's basis from up + shoulder line, and its face
// is on local -Z. facingBasis builds one from a face direction. Fed the body's own forward, the two
// must agree; and applying either to (0,0,-1) must return that forward.
const _m = new THREE.Matrix4();
function bodyOrientation(out) {
  const up = new THREE.Vector3().subVectors(pose.neck, pose.pelvis).normalize();
  const right = new THREE.Vector3().subVectors(pose.shoulderR, pose.shoulderL).normalize();
  const fwd = new THREE.Vector3().crossVectors(up, right).normalize();
  right.crossVectors(up, fwd).normalize();
  _m.makeBasis(right, up, fwd);
  return out.setFromRotationMatrix(_m);
}
function facingBasis(out, F, U) {
  const up = U.clone().normalize();
  const fwd = F.clone().addScaledVector(up, -F.dot(up));
  if (fwd.lengthSq() < 1e-8) return null;
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  fwd.negate();
  _m.makeBasis(right, up, fwd);
  return out.setFromRotationMatrix(_m);
}
{
  retarget(body, false, true);
  const bodyQ = bodyOrientation(new THREE.Quaternion());
  const bodyFace = new THREE.Vector3(0, 0, -1).applyQuaternion(bodyQ);
  // Measured convention (pose-retarget.html): face = cross(shoulderR - shoulderL, up) in pose keys.
  // With performer-left on key R, a performer facing the camera gives a soldier facing the viewer.
  const lat = new THREE.Vector3().subVectors(pose.shoulderR, pose.shoulderL).normalize();
  const expect = new THREE.Vector3().crossVectors(lat, new THREE.Vector3(0, 1, 0)).normalize();
  ok(bodyFace.distanceTo(expect) < 1e-6 && bodyFace.z > 0.99, `facing view: rig face = cross(shoulderR-shoulderL, up) = +z, toward the viewer (z=${bodyFace.z.toFixed(3)})`);
  ok(Math.abs(bodyQ.dot(bodyOrientation(new THREE.Quaternion()))) > 0.9999, 'bodyOrientation is deterministic');
  const q = facingBasis(new THREE.Quaternion(), bodyFace, new THREE.Vector3().subVectors(pose.neck, pose.pelvis));
  ok(Math.abs(q.dot(bodyQ)) > 0.9999, 'facingBasis(bodyForward) reproduces the rig body basis');
  const turned = new THREE.Vector3(1, 0, 1).normalize();
  const q2 = facingBasis(new THREE.Quaternion(), turned, new THREE.Vector3(0, 1, 0));
  const face2 = new THREE.Vector3(0, 0, -1).applyQuaternion(q2);
  ok(face2.distanceTo(turned) < 1e-9, 'facingBasis: local -Z lands on the requested face direction (45° head turn)');
  const upOut = new THREE.Vector3(0, 1, 0).applyQuaternion(q2);
  ok(upOut.y > 0.9999, 'facingBasis: up preserved');
}
// --- the three views, on an ASYMMETRIC pose (left arm raised) so reflection is visible ------------
{
  const faceOf = () => new THREE.Vector3(0, 0, -1).applyQuaternion(bodyOrientation(new THREE.Quaternion()));
  set(13, 0.30, -0.80, 0); set(15, 0.30, -1.05, 0);   // performer's LEFT arm up
  // A person's right = forward x up. Proper person <=> the visual-right limb (key L) sits on that side.
  const properPerson = () => { const f = faceOf(); const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)); return (pose.shoulderL.clone().sub(pose.shoulderR)).dot(r) > 0; };

  ingest(false); retarget(body, false, true, 0);        // facing
  ok(faceOf().z > 0.99 && properPerson(), 'facing: faces viewer, proper person');
  ok(pose.handR.y > pose.handL.y + 0.3 && pose.handR.x > 0, 'facing: raised arm is the VISUAL LEFT (key R) at +x — true limbs, opposite screen side');

  ingest(true); retarget(body, true, true, 0);          // mirror
  ok(faceOf().z > 0.99 && properPerson(), 'mirror: faces viewer, proper person');
  ok(pose.handL.y > pose.handR.y + 0.3 && pose.handL.x < 0, "mirror: raised arm is the VISUAL RIGHT (key L) at -x — same screen side as the performer's left");

  ingest(false); retarget(body, false, true, 180);      // follow
  ok(faceOf().z < -0.99 && properPerson(), 'follow: faces away, proper person');
  ok(pose.handR.y > pose.handL.y + 0.3 && pose.handR.x < 0, 'follow: raised arm is the visual left at -x — its left is your left, seen from behind');

  set(13, 0.48, -0.50, 0); set(15, 0.76, -0.50, 0); ingest(false);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
