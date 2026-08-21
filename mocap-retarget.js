// Video mocap → the 16 joint world positions `setRagdollPose` takes.
//
// Extracted out of `demos/mocap-webcam.html` once the method had proved itself, the same way
// `flight-model.js` came out of the flight demo. The demo now imports this, and so does
// `test-demo-mocap-webcam.mjs` — which matters, because while the maths lived inline the test kept a
// hand-copied twin of it and was therefore guarding a copy rather than the shipped code.
//
// THREE is an injected parameter and no renderer is touched, so this runs headless in Node exactly
// as `player-procedural-body.js` does.
//
// WHAT IT IS FOR. The seam into our rig is `body.setRagdollPose(P)`, which takes sixteen joint WORLD
// POSITIONS rather than rotations (see `docs/subsystems/bots.md` and `demos/pose-retarget.html`).
// Anything that can produce those positions can drive the soldier, so this module's only job is
// landmarks in, positions out. It knows nothing about MediaPipe beyond the landmark indices, and
// nothing about three beyond Vector3/Quaternion/Matrix4.
//
// THE METHOD, and it is `pose-retarget.html`'s, unchanged: take only the joint DIRECTIONS from the
// source and step OUR OWN bone lengths along them. Scaling a donor skeleton to fit ours does not
// work — no single factor fixes a proportion mismatch — but directions plus our lengths gives a pose
// with our skeleton's dimensions exactly and the performer's angles exactly.
//
// WHAT IS ADDED HERE beyond a faithful retarget, because a faithful retarget of a noisy 33-point
// estimate is still noisy:
//   * One-Euro filtering per landmark axis (heavy when still, light when fast).
//   * Depth damping, because z is by far the weakest axis of a single-camera estimate.
//   * A knee guard, because nothing in the estimate stops a knee bending backwards.
//   * Foot locking, because a hip-centred estimate has no ground truth and the feet skate.
// Each is a parameter, each defaults to the value the demo ships, and each is separately testable.

/** MediaPipe Pose landmark indices, by the name this module uses for them. */
export const MP = Object.freeze({
  nose: 0, earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
  heelL: 29, heelR: 30, toeL: 31, toeR: 32,
});
export const N_LANDMARKS = 33;

/** The sixteen keys `setRagdollPose` reads (player-procedural-body.js:1324). */
export const POSE_KEYS = Object.freeze(['head', 'neck', 'chest', 'pelvis',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR']);

/** Canonical source joints. Same vocabulary as `pose-retarget.html`, plus facing hints. */
export const CANON_IDS = Object.freeze(['hips', 'chest', 'neck', 'head', 'headTop', 'nose',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftHeel', 'leftToe', 'rightHeel', 'rightToe']);

/** Line pairs for drawing the raw landmark skeleton. */
export const SKELETON_EDGES = Object.freeze([
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [7, 8], [0, 7], [0, 8],
]);

// ---------------------------------------------------------------------------
// One-Euro filter (Casiez, Roussel, Vogel 2012)
//
// Cutoff = minCutoff + beta·|velocity|, so a still joint is filtered hard and a fast one barely at
// all. That is the whole reason to prefer it to an EMA here: one EMA constant either leaves the
// resting jitter in or turns every punch to treacle, and mocap needs both ends.
// ---------------------------------------------------------------------------

export class OneEuro {
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
  reset() { this.init = false; }
}

/** Slider 0..1 → resting cutoff in Hz (0 = 8 Hz, barely filtered; 1 = 0.25 Hz, very heavy). */
export const minCutoffFor = (s) => 8 * Math.pow(0.25 / 8, s);
/** Slider 0..1 → the velocity coefficient. Squared so the useful low end has resolution. */
export const betaFor = (b) => b * b * 2;

export const DEFAULTS = Object.freeze({
  smooth: 0.55, beta: 0.3, minVis: 0.3,
  reflect: false, yawDeg: 0, plant: true,
  depthScale: 0.75, kneeGuard: 1, footLock: 0.8,
  rootMotion: false, rootScale: 1, hfovDeg: 60,
  lockLiftHeight: 0.09, lockMaxSlip: 0.22,
});

/**
 * One retargeting session: filter state, running proportion estimates, foot locks.
 *
 * @param {{THREE: object}} deps three, injected — no renderer is used.
 */
export function createMocapRetarget({ THREE }) {
  const V = () => new THREE.Vector3();

  // --- outputs -------------------------------------------------------------
  const pose = {};
  for (const k of POSE_KEYS) pose[k] = V();
  const facing = { head: V(), footL: V(), footR: V() };   // unit face directions; zero = unknown
  const world = Array.from({ length: N_LANDMARKS }, V);   // filtered landmarks, three's frame
  const vis = new Float32Array(N_LANDMARKS);
  const root = V();                                        // recovered root offset, metres

  // --- internals -----------------------------------------------------------
  const canon = {};
  for (const s of CANON_IDS) canon[s] = V();
  const rest = { trunk: 0, spine: 0, neck: 0, shoulderL: 0, shoulderR: 0, hipL: 0, hipR: 0 };
  let restCount = 0;

  const filters = Array.from({ length: N_LANDMARKS * 3 }, () => new OneEuro());
  const rootFilter = [new OneEuro(), new OneEuro()];
  let rootRef = null, rootRefN = 0, lastT = 0, tracked = false;

  const locks = {
    L: { active: false, x: 0, z: 0 },
    R: { active: false, x: 0, z: 0 },
  };

  const _v = V(), _in = V(), _mid = V(), _axis = V(), _ears = V(), _dir = V(), _up = V(), _tmp = V();
  const _fu = V(), _rootW = V(), _ax = V(), _perp = V();
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _r = V(), _u = V(), _f = V();

  function reset() {
    tracked = false; lastT = 0; restCount = 0;
    for (const f of filters) f.reset();
    resetRoot();
    releaseLocks();
  }
  function resetRoot() { rootRef = null; rootRefN = 0; root.set(0, 0, 0); for (const f of rootFilter) f.reset(); }
  function releaseLocks() { locks.L.active = false; locks.R.active = false; }

  // -------------------------------------------------------------------------
  // Ingest
  //
  // MediaPipe world landmarks are metres with the origin at the hip midpoint, and image-like axes:
  // x right, y DOWN, z smaller = nearer the camera. Three here is x right, y up, z toward the
  // viewer, so (x, -y, -z) — two flips, which is a proper rotation and not a reflection.
  //
  // `reflect` negates x on top of that, which IS a reflection, and is half of the mirror view; the
  // other half is the left/right key mapping in solve(). Doing only one of the two gives a
  // left-handed person, so they are deliberately driven by the same flag.
  // -------------------------------------------------------------------------

  /**
   * @param {Array<{x,y,z,visibility?}>} worldLandmarks 33 world landmarks, metres.
   * @param {Array<{x,y}>|null} imageLandmarks 33 normalised image landmarks, for root recovery.
   * @param {number} tSec monotonic seconds; drives the filter's dt.
   * @param {object} opts see DEFAULTS.
   */
  function ingest(worldLandmarks, imageLandmarks, tSec, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const dt = lastT ? Math.min(0.1, Math.max(1e-3, tSec - lastT)) : 1 / 30;
    lastT = tSec;
    const sx = o.reflect ? -1 : 1;
    const minCut = minCutoffFor(o.smooth), beta = betaFor(o.beta);
    for (let i = 0; i < N_LANDMARKS; i++) {
      const p = worldLandmarks[i];
      _in.set(sx * p.x, -p.y, -p.z);
      vis[i] = p.visibility ?? 1;
      // A landmark below the gate holds its last position rather than snapping to a guess.
      if (tracked && vis[i] < o.minVis) continue;
      const f = i * 3;
      world[i].set(
        filters[f].filter(_in.x, dt, minCut, beta),
        filters[f + 1].filter(_in.y, dt, minCut, beta),
        filters[f + 2].filter(_in.z, dt, minCut, beta),
      );
    }
    tracked = true;
    if (imageLandmarks && o.rootMotion) updateRoot(worldLandmarks, imageLandmarks, dt, o);
    return dt;
  }

  /** Load a recorded frame straight into the filtered buffer (playback path, no filtering). */
  function setFrame(lm, rootXZ = null) {
    for (let i = 0; i < N_LANDMARKS; i++) {
      world[i].set(lm[i * 4], lm[i * 4 + 1], lm[i * 4 + 2]);
      vis[i] = lm[i * 4 + 3];
    }
    root.set(rootXZ ? rootXZ[0] : 0, 0, rootXZ ? rootXZ[1] : 0);
    tracked = true;
  }

  /** Copy the filtered state out as a flat frame (x, y, z, visibility per landmark). */
  function getFrame(out = new Float32Array(N_LANDMARKS * 4)) {
    for (let i = 0; i < N_LANDMARKS; i++) {
      out[i * 4] = world[i].x; out[i * 4 + 1] = world[i].y; out[i * 4 + 2] = world[i].z; out[i * 4 + 3] = vis[i];
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Root motion, approximately.
  //
  // World landmarks are hip-centred, so a side-step or a step toward the camera vanishes. What the
  // image landmarks still carry is where the performer IS: metres per normalised image unit is the
  // world shoulder width over the image shoulder width, lateral offset is the hip's distance from
  // the image centre in those metres, and depth follows from image scale ∝ 1/Z.
  //
  // The focal length that turns scale into metres is NOT reported by getUserMedia, so a horizontal
  // field of view is assumed (60° by default) and a scale slider covers the rest. This reads a
  // side-step; it is not a measurement, and the depth term is the weaker of the two.
  // -------------------------------------------------------------------------

  function updateRoot(wl, im, dt, o) {
    const aspect = o.aspect || 4 / 3;
    const shW = Math.hypot(wl[MP.shoulderL].x - wl[MP.shoulderR].x,
      wl[MP.shoulderL].y - wl[MP.shoulderR].y, wl[MP.shoulderL].z - wl[MP.shoulderR].z);
    const shI = Math.hypot((im[MP.shoulderL].x - im[MP.shoulderR].x) * aspect,
      im[MP.shoulderL].y - im[MP.shoulderR].y);
    if (shW < 0.05 || shI < 0.01) return;
    const mpu = shW / shI;                                                    // metres per unit, at depth
    const hipX = ((im[MP.hipL].x + im[MP.hipR].x) * 0.5 - 0.5) * aspect;
    const focal = (aspect * 0.5) / Math.tan((o.hfovDeg * Math.PI / 180) * 0.5);
    const depth = mpu * focal;                                                // metres from camera
    const lateral = hipX * mpu * (o.reflect ? -1 : 1);
    if (rootRefN < 15) {                                                      // first frames set the origin
      if (!rootRef) rootRef = { lateral, depth };
      rootRef.lateral += (lateral - rootRef.lateral) / (rootRefN + 1);
      rootRef.depth += (depth - rootRef.depth) / (rootRefN + 1);
      rootRefN++;
    }
    const minCut = minCutoffFor(o.smooth), beta = betaFor(o.beta);
    root.x = rootFilter[0].filter(lateral - rootRef.lateral, dt, minCut, beta);
    root.z = rootFilter[1].filter(-(depth - rootRef.depth), dt, minCut, beta);   // nearer → +z
  }

  // -------------------------------------------------------------------------
  // Canonical joints
  //
  // MediaPipe has no chest, neck or skull-top point, so they are synthesised from what it does
  // have. Trunk proportions are then a RUNNING MEAN of the live estimate rather than a rest-pose
  // measurement, because there is no rest pose to measure: they are constant on a person even
  // though the estimate of them is not. Converges in about 30 frames.
  //
  // `depthScale` shrinks z about the hips first. Single-camera depth is the noisiest axis by a wide
  // margin, and at 1.0 the limbs swim toward and away from the camera; at 0 the performer is
  // flattened onto the frontal plane, which loses a punch thrown at the lens. The default sits
  // nearer 1 than 0 because losing depth entirely is the more visible failure.
  // -------------------------------------------------------------------------

  function buildCanon(depthScale) {
    const hz = (world[MP.hipL].z + world[MP.hipR].z) * 0.5;
    const dz = (i) => hz + (world[i].z - hz) * depthScale;
    const at = (out, i) => out.set(world[i].x, world[i].y, dz(i));

    canon.hips.set(
      (world[MP.hipL].x + world[MP.hipR].x) * 0.5,
      (world[MP.hipL].y + world[MP.hipR].y) * 0.5,
      (dz(MP.hipL) + dz(MP.hipR)) * 0.5);
    _mid.set((world[MP.shoulderL].x + world[MP.shoulderR].x) * 0.5,
      (world[MP.shoulderL].y + world[MP.shoulderR].y) * 0.5,
      (dz(MP.shoulderL) + dz(MP.shoulderR)) * 0.5);
    _ears.set((world[MP.earL].x + world[MP.earR].x) * 0.5,
      (world[MP.earL].y + world[MP.earR].y) * 0.5,
      (dz(MP.earL) + dz(MP.earR)) * 0.5);

    _axis.subVectors(_mid, canon.hips);
    canon.chest.copy(_mid).addScaledVector(_axis, -0.12);
    canon.neck.copy(_mid).lerp(_ears, 0.35);
    canon.head.copy(_ears);
    _axis.subVectors(_ears, _mid);
    canon.headTop.copy(_ears).addScaledVector(_axis, 0.45);
    at(canon.nose, MP.nose);

    at(canon.leftUpperArm, MP.shoulderL); at(canon.leftLowerArm, MP.elbowL); at(canon.leftHand, MP.wristL);
    at(canon.rightUpperArm, MP.shoulderR); at(canon.rightLowerArm, MP.elbowR); at(canon.rightHand, MP.wristR);
    at(canon.leftUpperLeg, MP.hipL); at(canon.leftLowerLeg, MP.kneeL); at(canon.leftFoot, MP.ankleL);
    at(canon.rightUpperLeg, MP.hipR); at(canon.rightLowerLeg, MP.kneeR); at(canon.rightFoot, MP.ankleR);
    at(canon.leftHeel, MP.heelL); at(canon.leftToe, MP.toeL);
    at(canon.rightHeel, MP.heelR); at(canon.rightToe, MP.toeR);

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

  /** Unit direction from canonical joint `a` to `b`; +Y if they coincide. */
  function dir(a, b) {
    _dir.subVectors(canon[b], canon[a]);
    const len = _dir.length();
    return len > 1e-7 ? _dir.divideScalar(len) : _dir.set(0, 1, 0);
  }

  /** Unit direction a→b with its component along `up` removed; zeroes `out` when degenerate. */
  function flatDir(out, a, b, up) {
    out.subVectors(canon[b], canon[a]);
    out.addScaledVector(up, -out.dot(up));
    const l = out.length();
    if (l < 0.02) { out.set(0, 0, 0); return false; }
    out.divideScalar(l);
    return true;
  }

  // -------------------------------------------------------------------------
  // Two-bone IK, from `pose-retarget.html`. Every correction below moves an ENDPOINT, which
  // invalidates the middle joint; re-solving it keeps both bone lengths exact by construction,
  // where scaling the old bone would stretch the limb the whole method exists to preserve.
  // `poleHint` is where the joint was, so the performer's own bend plane survives.
  // -------------------------------------------------------------------------

  function solveMid(out, rootP, end, l1, l2, poleHint) {
    _ax.subVectors(end, rootP);
    let d = _ax.length();
    if (d < 1e-6) { _ax.set(0, -1, 0); d = 1e-6; } else _ax.divideScalar(d);
    const reach = Math.min(d, l1 + l2 - 1e-5);
    const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    _perp.subVectors(poleHint, rootP).addScaledVector(_ax, -_perp.dot(_ax));
    if (_perp.lengthSq() < 1e-12) _perp.set(_ax.z, 0, -_ax.x);
    if (_perp.lengthSq() < 1e-12) _perp.set(0, 0, 1);
    _perp.normalize();
    out.copy(rootP).addScaledVector(_ax, a).addScaledVector(_perp, h);
  }

  // -------------------------------------------------------------------------
  // Solve: canonical joints → the sixteen pose positions.
  // -------------------------------------------------------------------------

  /**
   * @param {{legLen,thighLen,shinLen,armLen}} limbLengths OUR skeleton, from `body.limbLengths`.
   * @param {number} designH the body's design height, `legLen / design.legLenRatio`.
   * @param {object} opts see DEFAULTS. `dt` is used by the foot lock only.
   * @returns {{pose: object, facing: object}} the same objects every call; copy if you keep them.
   */
  function solve(limbLengths, designH, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (!tracked) return { pose, facing };

    buildCanon(o.depthScale);

    const yawDeg = o.yawDeg;
    if (yawDeg) {
      _q.setFromAxisAngle(_up.set(0, 1, 0), yawDeg * Math.PI / 180);
      for (const s of CANON_IDS) canon[s].applyQuaternion(_q);
    }

    const { legLen, thighLen, shinLen, armLen } = limbLengths;
    const halfArm = armLen * 0.5;
    const trunkK = (designH - legLen) / Math.max(rest.trunk, 1e-6);

    // Performer-left lands on key R (the VISUAL LEFT limb, per the mirror bot-limb-map.js:10-13
    // documents) so the result is a proper person. The reflected mirror view swaps that, which
    // un-reflects the already-reflected positions.
    const L = o.reflect ? 'L' : 'R', R = o.reflect ? 'R' : 'L';

    pose.pelvis.set(0, 0, 0);
    pose.chest.copy(pose.pelvis).addScaledVector(dir('hips', 'chest'), rest.spine * trunkK);
    pose.neck.copy(pose.chest).addScaledVector(dir('chest', 'neck'), rest.neck * trunkK);
    pose.head.copy(pose.neck).addScaledVector(dir('neck', 'headTop'), rest.neck * trunkK * 0.6);

    for (const [side, key] of [['left', L], ['right', R]]) {
      const up = `${side}UpperArm`, lo = `${side}LowerArm`, hd = `${side}Hand`;
      pose[`shoulder${key}`].copy(pose.chest)
        .addScaledVector(dir('chest', up), rest[side === 'left' ? 'shoulderL' : 'shoulderR'] * trunkK);
      pose[`elbow${key}`].copy(pose[`shoulder${key}`]).addScaledVector(dir(up, lo), halfArm);
      pose[`hand${key}`].copy(pose[`elbow${key}`]).addScaledVector(dir(lo, hd), halfArm);

      const hip = `${side}UpperLeg`, knee = `${side}LowerLeg`, foot = `${side}Foot`;
      pose[`hip${key}`].copy(pose.pelvis)
        .addScaledVector(dir('hips', hip), rest[side === 'left' ? 'hipL' : 'hipR'] * trunkK);
      pose[`knee${key}`].copy(pose[`hip${key}`]).addScaledVector(dir(hip, knee), thighLen);
      pose[`foot${key}`].copy(pose[`knee${key}`]).addScaledVector(dir(knee, foot), shinLen);

      flatDir(facing[`foot${key}`], `${side}Heel`, `${side}Toe`, _up.set(0, 1, 0));
    }

    _fu.subVectors(canon.headTop, canon.neck).normalize();
    flatDir(facing.head, 'head', 'nose', _fu);

    // KNEE GUARD. Nothing in a landmark estimate knows a knee only bends one way, and the noisy
    // depth axis is exactly the one a knee bends along — so a knee that should be forward of the
    // hip→ankle line lands behind it and the leg reads as broken. The fix reflects only that case,
    // re-solving through solveMid so both bone lengths survive: forward is the body's own forward,
    // built from the shoulder line rather than assumed, so it holds whichever way the performer
    // turns. Knees only. An elbow has no equivalent fixed direction — it points wherever the
    // shoulder is rotated to — so guessing one would break more poses than it fixed.
    if (o.kneeGuard > 0) {
      bodyForward(_f);
      for (const key of ['L', 'R']) {
        const hip = pose[`hip${key}`], knee = pose[`knee${key}`], foot = pose[`foot${key}`];
        _ax.subVectors(foot, hip);
        const d = _ax.length();
        if (d < 1e-5) continue;
        _ax.divideScalar(d);
        _v.subVectors(knee, hip).addScaledVector(_ax, -_v.dot(_ax));   // knee offset from the leg axis
        const along = _v.dot(_f);
        if (along >= 0) continue;                                       // already bending forward
        _tmp.copy(knee);
        // Pole hint: the offending offset with its backward component flipped, blended by strength.
        _tmp.addScaledVector(_f, -along * 2 * o.kneeGuard);
        solveMid(knee, hip, foot, thighLen, shinLen, _tmp);
      }
    }

    // Lower foot on the floor, or a fixed pelvis height when planting is off so jumps read as jumps.
    const lift = o.plant ? -Math.min(pose.footL.y, pose.footR.y) : legLen;
    _rootW.set(o.rootMotion ? root.x * o.rootScale : 0, 0, o.rootMotion ? root.z * o.rootScale : 0);
    if (yawDeg) _rootW.applyQuaternion(_q);
    for (const key of POSE_KEYS) { pose[key].y += lift; pose[key].x += _rootW.x; pose[key].z += _rootW.z; }

    if (o.footLock > 0) applyFootLock(o, thighLen, shinLen);

    return { pose, facing };
  }

  // -------------------------------------------------------------------------
  // FOOT LOCK.
  //
  // The estimate is hip-centred and has no ground truth, so a standing performer's feet drift and
  // a walking one's stance foot slides — the "skating" every video mocap does. A foot near the
  // floor and moving slowly is a foot that is PLANTED, so its XZ is latched and held while the
  // knee is re-solved to absorb the correction, which is what a real leg does. The lock breaks on
  // either of two conditions, and both are needed: the foot lifting past `lockLiftHeight` (a normal
  // step) and the correction exceeding `lockMaxSlip` (the performer walked away from it, or the
  // estimate jumped). Without the slip release a bad lock strands the figure; without the lift
  // release it never lets go of a lifted foot.
  //
  // `footLock` is a blend, not a switch, so partial locking trades a little skate for a little
  // stiffness rather than choosing one.
  // -------------------------------------------------------------------------

  function applyFootLock(o, thighLen, shinLen) {
    const groundY = Math.min(pose.footL.y, pose.footR.y);
    for (const key of ['L', 'R']) {
      const foot = pose[`foot${key}`], knee = pose[`knee${key}`], hip = pose[`hip${key}`];
      const lock = locks[key];
      const lifted = foot.y - groundY > o.lockLiftHeight;
      if (lifted) { lock.active = false; continue; }
      if (!lock.active) { lock.active = true; lock.x = foot.x; lock.z = foot.z; continue; }
      const dx = lock.x - foot.x, dz = lock.z - foot.z;
      if (Math.hypot(dx, dz) > o.lockMaxSlip) { lock.x = foot.x; lock.z = foot.z; continue; }
      foot.x += dx * o.footLock;
      foot.z += dz * o.footLock;
      _tmp.copy(knee);
      solveMid(knee, hip, foot, thighLen, shinLen, _tmp);
    }
  }

  // -------------------------------------------------------------------------
  // Bases.
  //
  // The rig's face is on local −Z — measured off a posed rig in `pose-retarget.html`, not reasoned
  // from the names — so a basis built for a face direction F with up U is (F×U, U, −F). Getting
  // that cross product the other way round is left-handed and silently mirrors the part; the Node
  // test compares `facingBasis` against the rig's own `bodyOrientation` for exactly that reason.
  // -------------------------------------------------------------------------

  /** Body orientation, built as `rdBasis` builds it (player-procedural-body.js:2007-2019). */
  function bodyOrientation(out) {
    _u.subVectors(pose.neck, pose.pelvis);
    if (_u.lengthSq() < 1e-8) _u.set(0, 1, 0); else _u.normalize();
    _r.subVectors(pose.shoulderR, pose.shoulderL);
    if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0); else _r.normalize();
    _f.crossVectors(_u, _r);
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1); else _f.normalize();
    _r.crossVectors(_u, _f).normalize();
    _m.makeBasis(_r, _u, _f);
    return out.setFromRotationMatrix(_m);
  }

  /** The direction the posed body faces (its local −Z in world space). */
  function bodyForward(out) {
    _u.subVectors(pose.neck, pose.pelvis);
    if (_u.lengthSq() < 1e-8) _u.set(0, 1, 0); else _u.normalize();
    _r.subVectors(pose.shoulderR, pose.shoulderL);
    if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0); else _r.normalize();
    out.crossVectors(_r, _u);
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1); else out.normalize();
    return out;
  }

  /** Basis for a part whose FACE points along `F`, up `U`. Null when F is parallel to U. */
  function facingBasis(out, F, U) {
    _u.copy(U).normalize();
    _f.copy(F).addScaledVector(_u, -F.dot(_u));
    if (_f.lengthSq() < 1e-8) return null;
    _f.normalize();
    _r.crossVectors(_f, _u).normalize();   // F × U keeps (right, up, −F) right-handed
    _f.negate();
    _m.makeBasis(_r, _u, _f);
    return out.setFromRotationMatrix(_m);
  }

  /**
   * `jointFrame`, copied from player-procedural-body.js:1253-1266. `poseLimb` (the setRagdollPose
   * path) never calls it, which is why an unfinished ragdoll pose has backwards feet and armour
   * plates floating beside the elbows: `setFromUnitVectors` gives +Y along the bone but an
   * arbitrary roll, and this re-rolls the basis against the body orientation.
   */
  function jointFrame(node, from, to, orientation) {
    if (!node) return;
    _u.subVectors(to, from);
    if (_u.lengthSq() < 1e-10) _u.set(0, 1, 0); else _u.normalize();
    _v.set(0, 0, 1).applyQuaternion(orientation);
    _r.crossVectors(_u, _v);
    if (_r.lengthSq() < 1e-8) {
      _v.set(1, 0, 0).applyQuaternion(orientation);
      _r.crossVectors(_u, _v);
      if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0);
    }
    _r.normalize();
    _f.crossVectors(_r, _u).normalize();
    _m.makeBasis(_r, _u, _f);
    node.quaternion.setFromRotationMatrix(_m);
  }

  /**
   * Everything `setRagdollPose` leaves undone, applied to a body's joint nodes: limb joint frames,
   * plus the head turn and foot yaw the ragdoll path cannot know about because it derives both from
   * the shoulder line. Call straight after `body.setRagdollPose(pose)`.
   */
  function orientJoints(joints, opts = {}) {
    const o = { headTurn: true, footYaw: true, ...opts };
    const bodyQ = bodyOrientation(_qBody);
    // Ragdoll key 'L' drives the VISUAL RIGHT limb (measured in test-pose-retarget.mjs).
    for (const [key, side] of [['L', 'right'], ['R', 'left']]) {
      const hip = pose[`hip${key}`], knee = pose[`knee${key}`], foot = pose[`foot${key}`];
      jointFrame(joints[`${side}Hip`], hip, knee, bodyQ);
      jointFrame(joints[`${side}Knee`], knee, foot, bodyQ);
      jointFrame(joints[`${side}Ankle`], knee, foot, bodyQ);
      if (joints[`${side}Foot`]) {
        const F = facing[`foot${key}`];
        const q = o.footYaw && F.lengthSq() > 0.5 ? facingBasis(_qPart, F, _up.set(0, 1, 0)) : null;
        joints[`${side}Foot`].quaternion.copy(q || bodyQ);
      }
      const sh = pose[`shoulder${key}`], el = pose[`elbow${key}`], hd = pose[`hand${key}`];
      jointFrame(joints[`${side}Shoulder`], sh, el, bodyQ);
      jointFrame(joints[`${side}Elbow`], el, hd, bodyQ);
      jointFrame(joints[`${side}Wrist`], el, hd, bodyQ);
    }
    if (o.headTurn && joints.head && facing.head.lengthSq() > 0.5) {
      _fu.subVectors(pose.head, pose.neck);
      if (facingBasis(_qPart, facing.head, _fu)) {
        joints.head.quaternion.copy(_qPart);
        if (joints.neck) joints.neck.quaternion.slerp(_qPart, 0.5);   // the neck takes half the turn
      }
    }
  }
  const _qBody = new THREE.Quaternion(), _qPart = new THREE.Quaternion();

  return {
    pose, facing, world, vis, root, rest, canon, locks,
    get tracked() { return tracked; },
    reset, resetRoot, releaseLocks,
    ingest, setFrame, getFrame, solve,
    bodyOrientation, bodyForward, facingBasis, jointFrame, orientJoints, solveMid,
  };
}
