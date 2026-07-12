// test-weapon-pose-controller.mjs — plain Node test, no framework.
//
// Exercises weapon-pose-controller.js against Contract 5
// (docs/subsystems/procedural-body-weapon-contracts.md) using a tiny local THREE shim
// (Vector3/Quaternion/Euler) so the test has no dependency on three.js or a real GLB
// pipeline. weapon-pose-controller.js statically imports the real weapon-sequence.js
// (pure, THREE-free) for evaluateSequence/resolveTargetRef, so this test exercises the
// two modules composed together.

import { createWeaponPoseController } from './weapon-pose-controller.js';
import { advanceGlideProgress, advancePoseChase } from './weapon-sequence.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok - ${msg}`);
  }
}
function approx(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ~${b})`);
}

// --- minimal THREE shim -----------------------------------------------------

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  distanceTo(v) {
    return Math.sqrt((this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2);
  }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }
  copy(q) {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }
  multiply(q) {
    // this = this * q (three.js convention)
    const qax = this.x, qay = this.y, qaz = this.z, qaw = this.w;
    const qbx = q.x, qby = q.y, qbz = q.z, qbw = q.w;
    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    return this;
  }
  setFromEuler(euler) {
    const x = euler.x, y = euler.y, z = euler.z;
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    // XYZ order
    this.x = s1 * c2 * c3 + c1 * s2 * s3;
    this.y = c1 * s2 * c3 - s1 * c2 * s3;
    this.z = c1 * c2 * s3 + s1 * s2 * c3;
    this.w = c1 * c2 * c3 - s1 * s2 * s3;
    return this;
  }
}

class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
  }
}

const THREE = { Vector3, Quaternion, Euler };

// --- fakes -------------------------------------------------------------------

function makeFakeBody() {
  return {
    group: { position: new Vector3(0, 0, 0), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1) },
    calls: [],
    setArmTarget(side, target) {
      this.calls.push({ side, target });
    },
  };
}

function makeFakeWeaponView() {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(1, 1, 1),
  };
}

// Weapon def fixture: anchors/poses/reload sequence lifted verbatim from
// docs/superpowers/specs/2026-07-06-procedural-gunplay-design.md so the fallback
// evaluator is exercised against the canonical example shape.
const M1911_DEF = {
  id: 'm1911',
  recoil: 0.6,
  ikAnchors: {
    rightGrip: { p: [0.02, -0.04, -0.12], q: [0, 0, 0, 1] },
    leftGrip: { p: [-0.18, -0.03, -0.34], q: [0, 0, 0, 1] },
    magwell: { p: [0.01, -0.18, -0.18], q: [0, 0, 0, 1] },
    chargingHandle: { p: [0.0, 0.07, -0.28], q: [0, 0, 0, 1] },
    muzzle: { p: [0, 0.02, -0.65], q: [0, 0, 0, 1] },
  },
  weaponPoses: {
    lowReady: { p: [0.24, -0.42, -0.62], r: [-0.08, -0.04, -0.02], scale: 1.0 },
    aimed: { p: [0.3, -0.31, -0.68], r: [-0.02, -0.04, -0.03], scale: 1.0 },
    reloadRaise: { p: [0.22, -0.2, -0.5], r: [0.25, -0.12, 0.2], scale: 1.0 },
  },
  reloadSequence: {
    duration: 1.45,
    commitAmmoAt: 1.05,
    keys: [
      { t: 0.0, weaponPose: 'aimed', right: 'rightGrip', left: 'leftGrip' },
      { t: 0.18, weaponPose: 'reloadRaise', right: 'rightGrip', left: 'magwell' },
      { t: 0.35, right: 'rightGrip', left: { body: [-0.35, -0.35, -0.35] }, event: 'detachMagazine' },
      { t: 0.48, left: { body: [-0.7, -0.45, -0.4] }, event: 'tossMagazine' },
      { t: 0.68, left: 'beltMagazine', event: 'spawnFreshMagazine' },
      { t: 0.95, left: 'magwell', event: 'insertMagazine' },
      { t: 1.15, left: 'chargingHandle', event: 'grabChargingHandle' },
      { t: 1.28, left: { weaponAnchor: 'chargingHandle', offset: [0, 0, -0.12] }, event: 'pullChargingHandle' },
      { t: 1.38, left: 'leftGrip', weaponPose: 'aimed', event: 'releaseChargingHandle' },
    ],
  },
};

function getWeaponDef(id) {
  return id === 'm1911' ? M1911_DEF : undefined;
}

function refKey(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && ref.weaponAnchor) return `weaponAnchor:${ref.weaponAnchor}`;
  if (ref && ref.body) return 'body:offset';
  if (ref && ref.camera) return 'camera:offset';
  if (ref && ref.world) return 'world:offset';
  return 'unknown';
}

// --- test 1: aiming blends the weapon pose toward 'aimed' -------------------

{
  const body = makeFakeBody();
  const weaponView = makeFakeWeaponView();
  // Infinite pose-glide so each aim change lands on the exact named pose in a single frame (the
  // constant-speed pose chase is exercised on its own below).
  const ctrl = createWeaponPoseController({ THREE, body, weaponView, getWeaponDef, poseGlideSpeed: Infinity });
  ctrl.setWeapon('m1911');

  ctrl.setAiming(0);
  ctrl.update(1 / 60, {});
  const lowReadyZ = weaponView.position.z;

  ctrl.setAiming(1);
  ctrl.update(1 / 60, {});
  const aimedZ = weaponView.position.z;

  approx(lowReadyZ, M1911_DEF.weaponPoses.lowReady.p[2], 1e-6, 'aimAmount=0 matches lowReady pose z');
  approx(aimedZ, M1911_DEF.weaponPoses.aimed.p[2], 1e-6, 'aimAmount=1 matches aimed pose z');

  ctrl.setAiming(0.5);
  ctrl.update(1 / 60, {});
  const halfZ = weaponView.position.z;
  const midpoint = (M1911_DEF.weaponPoses.lowReady.p[2] + M1911_DEF.weaponPoses.aimed.p[2]) / 2;
  approx(halfZ, midpoint, 1e-6, 'aimAmount=0.5 is the midpoint between lowReady and aimed');
}

// --- test 2: recoil produces a decaying offset that returns to ~0 -----------

{
  const body = makeFakeBody();
  const weaponView = makeFakeWeaponView();
  const ctrl = createWeaponPoseController({ THREE, body, weaponView, getWeaponDef });
  ctrl.setWeapon('m1911');
  ctrl.setAiming(1); // hold aimed pose steady so we can isolate the recoil delta

  ctrl.update(1 / 60, {});
  const baseZ = weaponView.position.z;

  ctrl.recoil(1);
  ctrl.update(1 / 600, {}); // tiny dt right after the kick — recoil should be near-max
  const kickZ = weaponView.position.z;
  assert(kickZ > baseZ, 'recoil() pulls the weapon root back immediately after the kick');

  // Advance well past the recoil decay window.
  for (let i = 0; i < 60; i++) ctrl.update(1 / 60, {});
  const settledZ = weaponView.position.z;
  approx(settledZ, baseZ, 1e-6, 'recoil offset decays back to ~0 after the decay window');
}

// --- test 3: reload drives both hands through the authored sequence --------

{
  const body = makeFakeBody();
  const weaponView = makeFakeWeaponView();
  const events = [];
  const ctrl = createWeaponPoseController({
    THREE,
    body,
    weaponView,
    getWeaponDef,
    onEvent: (name, payload) => events.push({ name, payload }),
  });
  ctrl.setWeapon('m1911');
  ctrl.play('reload');

  const dt = 1 / 60;
  const leftRefSamples = [];
  let elapsed = 0;
  while (elapsed < 1.5) {
    body.calls.length = 0;
    ctrl.update(dt, {});
    elapsed += dt;

    const rightCall = body.calls.find((c) => c.side === 'right');
    const leftCall = body.calls.find((c) => c.side === 'left');
    assert(!!rightCall, `reload frame @t=${elapsed.toFixed(2)} calls setArmTarget('right', ...)`);
    assert(!!leftCall, `reload frame @t=${elapsed.toFixed(2)} calls setArmTarget('left', ...)`);
    break; // only need to confirm both-hands-called once per iteration; avoid log spam
  }

  // Re-run cleanly (fresh controller) sampling the left-hand ref across the timeline.
  const body2 = makeFakeBody();
  const weaponView2 = makeFakeWeaponView();
  const ctrl2 = createWeaponPoseController({ THREE, body: body2, weaponView: weaponView2, getWeaponDef });
  ctrl2.setWeapon('m1911');
  ctrl2.play('reload');

  const sampleTimes = [0.0, 0.2, 0.4, 0.6, 0.7, 1.0, 1.2, 1.4];
  const seenLeftTargets = [];
  let t = 0;
  const keys = M1911_DEF.reloadSequence.keys;
  let ki = 0;
  for (const sampleT of sampleTimes) {
    do {
      body2.calls.length = 0;
      ctrl2.update(dt, {});
      t += dt;
    } while (t < sampleT);
    const leftCall = body2.calls.find((c) => c.side === 'right') && body2.calls.find((c) => c.side === 'left');
    assert(!!leftCall, `reload @t=${sampleT} still drives both hands`);
    // Compare left-hand world position to what each candidate anchor would resolve to,
    // to identify which anchor/ref is currently active without depending on internals.
    seenLeftTargets.push(body2.calls.find((c) => c.side === 'left').target.position.clone());
  }

  // magwell (t=0.18) -> body toss offsets (t=0.35, 0.48) -> beltMagazine (t=0.68) ->
  // magwell again ("insert", t=0.95) -> chargingHandle (t=1.15) -> offset chargingHandle
  // (t=1.28) -> leftGrip (t=1.38). Confirm the left-hand target actually changes across
  // these phases (it must not get stuck on one anchor for the whole sequence).
  const distinctPositions = new Set(seenLeftTargets.map((v) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`));
  assert(distinctPositions.size >= 4, `left-hand target visits multiple distinct positions across the reload timeline (saw ${distinctPositions.size})`);

  // Specifically check the magwell -> toss -> insert -> chargingHandle waypoints by
  // sampling right at/after each key's time and comparing against the anchor's expected
  // resolved world position (weaponTransform is identity-ish here since weaponView has
  // no parent, so anchor-space == world-space; body offsets go through body.group which
  // is also at the origin with identity rotation).
  // Resolve each anchor against the controller's OWN weapon transform at the sample frame.
  // weapon-sequence.js interpolates the weapon pose between keyframes, so the pose — and
  // thus every anchor's world position — is whatever the controller applied to weaponView
  // that frame. Reading it back keeps this check interpolation-agnostic (vs. assuming the
  // pose is held at a single named keyframe).
  function sampleLeftAndView(sampleT) {
    const b = makeFakeBody();
    const wv = makeFakeWeaponView();
    // Force instant hand convergence so the anchor-position assertions below are deterministic
    // regardless of the default constant-speed glide (that glide is exercised on its own in test 5).
    const c = createWeaponPoseController({ THREE, body: b, weaponView: wv, getWeaponDef, handGlideSpeed: Infinity });
    c.setWeapon('m1911');
    c.play('reload');
    let tt = 0;
    do {
      b.calls.length = 0;
      c.update(dt, {});
      tt += dt;
    } while (tt < sampleT);
    return { left: b.calls.find((call) => call.side === 'left').target.position, view: wv };
  }

  function anchorWorldViaView(anchorName, view) {
    const anchor = M1911_DEF.ikAnchors[anchorName];
    return new Vector3(...anchor.p).applyQuaternion(view.quaternion).add(view.position);
  }

  const magwellSample = sampleLeftAndView(0.2);
  const tossSample = sampleLeftAndView(0.4);
  const insertSample = sampleLeftAndView(1.0);
  const chargingSample = sampleLeftAndView(1.2);

  approx(magwellSample.left.distanceTo(anchorWorldViaView('magwell', magwellSample.view)), 0, 1e-6, 'left hand is at the magwell anchor (world) during the magwell phase');
  assert(tossSample.left.distanceTo(anchorWorldViaView('magwell', tossSample.view)) > 0.1, 'left hand has left the magwell anchor during the body-toss phase');
  approx(insertSample.left.distanceTo(anchorWorldViaView('magwell', insertSample.view)), 0, 1e-6, 'left hand returns to the magwell anchor during the insert phase');
  approx(chargingSample.left.distanceTo(anchorWorldViaView('chargingHandle', chargingSample.view)), 0, 1e-6, 'left hand is at the chargingHandle anchor near the end of the sequence');

  // Events fired in order during the full run.
  const fullBody = makeFakeBody();
  const fullWeaponView = makeFakeWeaponView();
  const seenEvents = [];
  const ctrl3 = createWeaponPoseController({
    THREE,
    body: fullBody,
    weaponView: fullWeaponView,
    getWeaponDef,
    onEvent: (name) => seenEvents.push(name),
  });
  ctrl3.setWeapon('m1911');
  ctrl3.play('reload');
  let t3 = 0;
  while (t3 < 1.5) {
    ctrl3.update(dt, {});
    t3 += dt;
  }
  const expectedEvents = [
    'detachMagazine',
    'tossMagazine',
    'spawnFreshMagazine',
    'insertMagazine',
    'grabChargingHandle',
    'commitAmmo',
    'pullChargingHandle',
    'releaseChargingHandle',
  ];
  for (const ev of expectedEvents) {
    assert(seenEvents.includes(ev), `reload sequence emits '${ev}' event`);
  }
}

// --- test 4: reload never mutates ammo fields --------------------------------

{
  const body = makeFakeBody();
  const weaponView = makeFakeWeaponView();
  const state = { ammoMag: 2, ammoReserve: 10 };
  const ctrl = createWeaponPoseController({ THREE, body, weaponView, getWeaponDef });
  ctrl.setWeapon('m1911');
  ctrl.play('reload');
  const dt = 1 / 60;
  let t = 0;
  while (t < 1.6) {
    ctrl.update(dt, state);
    t += dt;
  }
  assert(state.ammoMag === 2, 'reload does not mutate state.ammoMag');
  assert(state.ammoReserve === 10, 'reload does not mutate state.ammoReserve');
  assert(!('ammo' in M1911_DEF) && M1911_DEF.magazineSize === undefined, 'weapon def carries no ammo fields for the controller to touch');
}

// --- test 5: hand targets glide at constant speed (distance sets duration) ---

{
  // Pure helper: same speed, twice the distance => ~twice the steps to arrive.
  function stepsToArrive(dist, speed, dt) {
    let p = 0, n = 0;
    while (p < 1 && n < 100000) { p = advanceGlideProgress(p, dist, speed, dt); n++; }
    return n;
  }
  const nShort = stepsToArrive(1, 1, 0.1);
  const nLong = stepsToArrive(2, 1, 0.1);
  assert(nShort >= 9 && nShort <= 12, `glide of distance 1 at speed 1 takes ~10 steps of dt=0.1 (~1.0s) (got ${nShort})`);
  assert(Math.abs(nLong - 2 * nShort) <= 2, `duration scales with distance: distance 2 takes ~2x the steps of distance 1 (got ${nLong} vs ${2 * nShort})`);
  assert(advanceGlideProgress(0, 1, 0, 0.1) === 1, 'zero speed snaps to arrival');
  assert(advanceGlideProgress(0, 1, -5, 0.1) === 1, 'negative speed snaps to arrival');
  assert(advanceGlideProgress(0, 0, 5, 0.1) === 1, 'zero distance snaps to arrival');
  assert(advanceGlideProgress(0.5, 1, 100, 0.1) === 1, 'overshoot clamps progress to 1');

  // Controller: a finite glide speed does NOT teleport the hand the frame a ref flips; an infinite
  // speed does. Compare the two left-hand positions shortly after the magwell flip (t=0.18).
  function runReloadLeft(speed, untilT, extraIdleFrames = 0) {
    const b = makeFakeBody();
    const wv = makeFakeWeaponView();
    const c = createWeaponPoseController({ THREE, body: b, weaponView: wv, getWeaponDef, handGlideSpeed: speed });
    c.setWeapon('m1911');
    c.play('reload');
    const dt = 1 / 60;
    let t = 0;
    do {
      b.calls.length = 0;
      c.update(dt, {});
      t += dt;
    } while (t < untilT);
    for (let i = 0; i < extraIdleFrames; i++) { b.calls.length = 0; c.update(dt, {}); }
    return b.calls.find((call) => call.side === 'left').target.position.clone();
  }

  const glideLeft = runReloadLeft(0.6, 0.21);      // slow: still mid-glide 0.03s after the flip
  const snapLeft = runReloadLeft(Infinity, 0.21);  // instant: already at the magwell
  assert(glideLeft.distanceTo(snapLeft) > 0.02, 'finite-speed hand lags a snapped hand right after a ref flip (it glides, not teleports)');

  // Given enough settle time on a stable ref, even a slow glide converges to the same place a snap reaches.
  const glideSettled = runReloadLeft(0.6, 1.5, 240);      // +4s of idle 'leftGrip'
  const snapSettled = runReloadLeft(Infinity, 1.5, 240);
  approx(glideSettled.distanceTo(snapSettled), 0, 1e-4, 'a settled glide reaches the same target as a snap (constant speed, just slower)');

  // Weapon-root pose chase: constant speed, no begin/end assumption.
  const from = { p: [0, 0, 0], r: [0, 0, 0], scale: 1 };
  const to = { p: [1, 0, 0], r: [0.5, 0, 0], scale: 2 };
  // One step of speed 1 at dt 0.1 covers 0.1 m of the 1 m gap => 10% of the way, on every channel.
  const one = advancePoseChase(from, to, 1, 0.1);
  approx(one.p[0], 0.1, 1e-9, 'pose chase covers speed*dt meters of position per step');
  approx(one.r[0], 0.05, 1e-9, 'pose chase advances rotation by the same fraction as position');
  approx(one.scale, 1.1, 1e-9, 'pose chase advances scale by the same fraction as position');
  // Chase all the way: distance 1 at speed 1, dt 0.1 => ~10 steps (arrives together on all channels).
  let cur = from, steps = 0;
  while (Math.hypot(to.p[0] - cur.p[0], to.p[1] - cur.p[1], to.p[2] - cur.p[2]) > 1e-9 && steps < 1000) {
    cur = advancePoseChase(cur, to, 1, 0.1); steps++;
  }
  assert(steps >= 9 && steps <= 11, `pose chase of 1 m at 1 m/s takes ~10 steps of dt=0.1 (got ${steps})`);
  approx(cur.r[0], to.r[0], 1e-9, 'pose chase rotation arrives with position');
  approx(cur.scale, to.scale, 1e-9, 'pose chase scale arrives with position');
  const snapPose = advancePoseChase(from, to, Infinity, 0.1);
  approx(snapPose.p[0], 1, 1e-9, 'infinite pose speed snaps position to target in one step');
  const zeroPose = advancePoseChase(from, to, 0, 0.1);
  approx(zeroPose.p[0], 1, 1e-9, 'non-positive pose speed snaps to target');
}

// --- summary -----------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll assertions PASSED');
}
