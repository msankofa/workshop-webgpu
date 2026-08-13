// weapon-pose-controller.js — visual-only weapon animation controller.
//
// Implements Contract 5 (docs/subsystems/procedural-body-weapon-contracts.md) and the
// "Runtime Animation State" / "IK Arms" / "Events and Props" sections of
// docs/superpowers/specs/2026-07-06-procedural-gunplay-design.md.
//
// This module drives the weapon root pose (weaponView) and pushes world-space hand
// targets into the procedural body via body.setArmTarget(side, {...}) (Contract 1).
// It never moves the player, camera, or touches hit-registration.
//
// THREE is injected (not statically imported) so this stays importable from plain
// Node for tests, same pattern as GhostRenderer / player-hands.js.
//
// Sequence evaluation + target-ref resolution come from weapon-sequence.js (pure,
// THREE-free, unit-tested). evaluateSequence(seq, t, prevT) returns a blended weaponPose
// *object*, carried-forward left/right *raw refs*, and the *delta* events fired in
// (prevT, t]; resolveTargetRef(ref, {anchors, bodyAnchors, weaponRoot, bodyRoot, cameraRoot})
// returns a plain {position:[x,y,z], quaternion:[x,y,z,w]} which this module lifts into
// THREE vectors/quaternions for body.setArmTarget (Contract 1).

import { evaluateSequence, resolveTargetRef, advanceGlideProgress, advancePoseChase } from './weapon-sequence.js';

const RECOIL_DURATION = 0.22; // seconds for a recoil kick to decay back to ~0
const RECOIL_Z = 0.06; // weapon root pulls back along local -z per unit recoil
const RECOIL_PITCH = 0.09; // muzzle rise per unit recoil (radians)

const DEFAULT_POSE = { p: [0, 0, 0], r: [0, 0, 0], scale: 1 };

const DEFAULT_HAND_GLIDE_SPEED = 3.5; // m/s the driven hand target chases a changed ref (see advanceGlideProgress)
const DEFAULT_POSE_GLIDE_SPEED = 4.0; // m/s the weapon-root pose chases its target pose (see advancePoseChase)

// Shortest-path normalized-lerp blend of two quaternions into `out`, writing raw components so it
// works with both real THREE.Quaternion and the array-free test shim (neither .slerp nor .set needed).
function blendQuat(out, a, b, t) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = dot < 0 ? -1 : 1;
  const x = a.x + (b.x * s - a.x) * t;
  const y = a.y + (b.y * s - a.y) * t;
  const z = a.z + (b.z * s - a.z) * t;
  const w = a.w + (b.w * s - a.w) * t;
  const inv = 1 / (Math.hypot(x, y, z, w) || 1);
  out.x = x * inv; out.y = y * inv; out.z = z * inv; out.w = w * inv;
  return out;
}

// Placeholder body-space anchors not covered by Contract 4's weapon anchors (e.g. a mag
// pouch on the belt). Real body anchors likely land in their own data file later;
// this is a minimal stand-in so 'beltMagazine'-style refs resolve to *something*.
// Body-local frame (matches rootAnchor): +x = the body's LEFT, +y = up, +z = forward.
const DEFAULT_BODY_ANCHORS = {
  beltMagazine: { p: [0.28, -0.44, 0.16], q: [0, 0, 0, 1] },
};

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpVec3Array(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function lerpPose(a, b, t) {
  a = a || DEFAULT_POSE;
  b = b || DEFAULT_POSE;
  return {
    p: lerpVec3Array(a.p, b.p, t),
    r: lerpVec3Array(a.r, b.r, t),
    scale: lerp(a.scale ?? 1, b.scale ?? 1, t),
  };
}

// --- world-space transform helper ------------------------------------------

// `out`, when passed, is a { position, quaternion, scale } scratch triple that gets
// overwritten in place instead of allocating a fresh result (callers that immediately
// flatten the result — see asRoot() in update() — can safely reuse one across calls).
function worldTransformOf(THREE, obj, out) {
  if (!obj) {
    if (out) {
      out.position.x = 0; out.position.y = 0; out.position.z = 0;
      out.quaternion.x = 0; out.quaternion.y = 0; out.quaternion.z = 0; out.quaternion.w = 1;
      out.scale.x = 1; out.scale.y = 1; out.scale.z = 1;
      return out;
    }
    return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  }
  const target = out || { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  // Only reads obj.matrixWorld, so ancestors+self is enough — never force a descendant walk
  // (updateWorldMatrix(true, false) skips children; updateMatrixWorld(true) would force all of them).
  if (typeof obj.updateWorldMatrix === 'function' && obj.matrixWorld && typeof obj.matrixWorld.decompose === 'function') {
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(target.position, target.quaternion, target.scale);
    return target;
  }
  // Object has the old matrixWorld pipeline but not updateWorldMatrix (unlikely with real
  // THREE, kept as a defensive fallback).
  if (typeof obj.updateMatrixWorld === 'function' && obj.matrixWorld && typeof obj.matrixWorld.decompose === 'function') {
    obj.updateMatrixWorld(true);
    obj.matrixWorld.decompose(target.position, target.quaternion, target.scale);
    return target;
  }
  // Flat object with no parent-chain matrix pipeline (test shim, or an already-world
  // root node) — its local transform IS its world transform.
  // Reset any field the flat object lacks: a reused `out` would otherwise leak the
  // previous call's values where the old allocating path returned identity defaults.
  if (obj.position) target.position.copy(obj.position);
  else { target.position.x = 0; target.position.y = 0; target.position.z = 0; }
  if (obj.quaternion) target.quaternion.copy(obj.quaternion);
  else { target.quaternion.x = 0; target.quaternion.y = 0; target.quaternion.z = 0; target.quaternion.w = 1; }
  if (obj.scale) target.scale.copy(obj.scale);
  else { target.scale.x = 1; target.scale.y = 1; target.scale.z = 1; }
  return target;
}

// --- controller --------------------------------------------------------------

export function createWeaponPoseController({ THREE, body, weaponView, getWeaponDef, onEvent, handGlideSpeed = DEFAULT_HAND_GLIDE_SPEED, poseGlideSpeed = DEFAULT_POSE_GLIDE_SPEED }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};

  // Per-hand glide state. When a hand's target ref flips (grip -> magwell -> belt -> ...), the
  // resolved world point jumps; instead of teleporting the hand we glide the DRIVEN target from
  // the previous ref's point to the new one at constant speed (advanceGlideProgress), so the arm
  // sweeps between waypoints. Both endpoints are re-resolved every frame so they still track the
  // moving weapon/body (a settled hand, p>=1, stays glued to its anchor while the player walks).
  function makeGlideState() {
    return { init: false, toRef: null, fromRef: null, p: 1, dist: 1e-4, pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  }
  const glide = { left: makeGlideState(), right: makeGlideState() };

  // Scratch triples for worldTransformOf()/toThree() results that are consumed synchronously
  // within a single call and never retained afterward (see call sites below for the
  // non-overlapping-lifetime reasoning that makes reuse safe).
  const rootScratch = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  // driveHandGlide needs `to` and `from`/`from0` alive at the same time (distance/lerp math
  // against both), so these must be two distinct slots, not one shared with `rootScratch`.
  const glideScratchTo = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const glideScratchFrom = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  // Hoisted so setFromEuler() below doesn't allocate a THREE.Euler every frame.
  const poseEulerScratch = new THREE.Euler();

  function toThree(r, out) {
    const target = out || { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    target.position.x = r.position[0]; target.position.y = r.position[1]; target.position.z = r.position[2];
    target.quaternion.x = r.quaternion[0]; target.quaternion.y = r.quaternion[1]; target.quaternion.z = r.quaternion[2]; target.quaternion.w = r.quaternion[3];
    return target;
  }

  const s = {
    weaponId: null,
    action: 'idle', // 'idle' | 'aim' | 'fire' | 'reload' | 'swap'
    actionTime: 0,
    aimAmount: 0,
    recoilAmount: 0,
    recoilElapsed: RECOIL_DURATION, // start fully decayed
    activeSeq: null,
    committedAmmoThisReload: false,
    basePose: null, // glided weapon-root pose (pre-recoil); null forces a snap on the next frame
  };

  function weaponDef() {
    return (s.weaponId && getWeaponDef && getWeaponDef(s.weaponId)) || {};
  }

  function poseNamed(name, fallbackName) {
    const poses = weaponDef().weaponPoses || {};
    return poses[name] || (fallbackName && poses[fallbackName]) || DEFAULT_POSE;
  }

  function setWeapon(id) {
    s.weaponId = id;
    s.action = 'idle';
    s.actionTime = 0;
    s.activeSeq = null;
    s.basePose = null; // snap to the new weapon's pose rather than gliding from the old one
  }

  function setAiming(amount) {
    s.aimAmount = clamp01(amount);
  }

  function recoil(amount) {
    s.recoilAmount = Math.max(0, amount || 0);
    s.recoilElapsed = 0;
  }

  function play(actionName) {
    s.action = actionName;
    s.actionTime = 0;
    if (actionName === 'reload') {
      s.activeSeq = weaponDef().reloadSequence || null;
      s.committedAmmoThisReload = false;
    }
    if (actionName === 'fire') {
      recoil(weaponDef().recoil ?? 0.6);
    }
  }

  function driveHand(side, target, hint) {
    if (!body || typeof body.setArmTarget !== 'function') return;
    body.setArmTarget(side, {
      position: target.position,
      quaternion: target.quaternion,
      weight: 1,
      hint,
    });
  }

  // Resolve `ref` to a world target and drive the hand toward it via a constant-speed glide.
  // `ref` identity is stable across frames (evalRefChannel returns the same key value each time and
  // the idle path uses interned strings), so `ref !== g.toRef` reliably detects a genuine ref flip.
  function driveHandGlide(side, ref, hint, dt, ctx) {
    const g = glide[side];
    // `to` must stay valid for the whole function (read again in the blend branch below), so it
    // gets its own scratch slot distinct from `from`/`from0` (glideScratchFrom), which is only
    // read immediately after being computed and is safe to overwrite between those two uses.
    const to = toThree(resolveTargetRef(ref, ctx), glideScratchTo);
    if (!g.init) {
      // First frame: snap onto the current ref so the hand doesn't glide in from the origin.
      g.init = true; g.fromRef = ref; g.toRef = ref; g.p = 1; g.dist = 1e-4;
      g.pos.copy(to.position); g.quat.copy(to.quaternion);
    } else if (ref !== g.toRef) {
      // Ref flipped: start a new glide from where we were heading to the new target. Capture the
      // transition distance now so progress advances at constant speed over THIS distance.
      const from0 = toThree(resolveTargetRef(g.toRef, ctx), glideScratchFrom);
      g.fromRef = g.toRef;
      g.toRef = ref;
      g.dist = Math.max(1e-4, from0.position.distanceTo(to.position));
      g.p = 0;
    }
    if (g.p < 1) g.p = advanceGlideProgress(g.p, g.dist, handGlideSpeed, dt);
    if (g.p >= 1) {
      g.pos.copy(to.position); g.quat.copy(to.quaternion);
    } else {
      const from = toThree(resolveTargetRef(g.fromRef, ctx), glideScratchFrom);
      g.pos.set(
        from.position.x + (to.position.x - from.position.x) * g.p,
        from.position.y + (to.position.y - from.position.y) * g.p,
        from.position.z + (to.position.z - from.position.z) * g.p,
      );
      blendQuat(g.quat, from.quaternion, to.quaternion, g.p);
    }
    driveHand(side, { position: g.pos, quaternion: g.quat }, hint);
  }

  function update(dt, state = {}) {
    dt = Math.max(0, dt || 0);

    if (state.weaponId && state.weaponId !== s.weaponId) setWeapon(state.weaponId);

    // Remember last frame's action time so evaluateSequence can report the events crossed
    // in (prevActionTime, actionTime] this step.
    const prevActionTime = s.actionTime;

    // Action/actionTime: an explicit state.action (replicated / host-authoritative)
    // wins; otherwise advance whatever play()/local input already set (local FPS).
    if (state.action !== undefined && state.action !== s.action) {
      play(state.action);
      if (state.actionTime !== undefined) s.actionTime = state.actionTime;
    } else if (state.actionTime !== undefined) {
      s.actionTime = state.actionTime;
    } else {
      s.actionTime += dt;
    }

    if (state.aimAmount !== undefined) setAiming(state.aimAmount);
    s.recoilElapsed += dt;

    const recoilK = s.recoilElapsed >= RECOIL_DURATION ? 0 : 1 - s.recoilElapsed / RECOIL_DURATION;
    const recoilOffset = s.recoilAmount * recoilK;

    let weaponPose;
    let rightRef = 'rightGrip';
    let leftRef = 'leftGrip';
    let rightHint = 'grip';
    let leftHint = 'support';

    if (s.action === 'reload' && s.activeSeq) {
      const evaluated = evaluateSequence(s.activeSeq, s.actionTime, prevActionTime);
      // evaluated.weaponPose is a blended { p, r, scale } object (or null before the first
      // pose key); fall back to the raised reload pose so the weapon never snaps to origin.
      weaponPose = evaluated.weaponPose || poseNamed('reloadRaise');
      if (evaluated.right != null) rightRef = evaluated.right;
      if (evaluated.left != null) leftRef = evaluated.left;
      leftHint = 'reload';

      // evaluated.events are only the ones crossed this step (delta), so emit them directly.
      for (const ev of evaluated.events) {
        emit(ev.event, { t: ev.t, weaponId: s.weaponId });
      }

      if (
        !s.committedAmmoThisReload &&
        s.activeSeq.commitAmmoAt !== undefined &&
        s.actionTime >= s.activeSeq.commitAmmoAt
      ) {
        s.committedAmmoThisReload = true;
        // Informational only — v1 ammo transfer is owned by the existing gun.reload,
        // never mutated here.
        emit('commitAmmo', { t: s.activeSeq.commitAmmoAt, weaponId: s.weaponId, informational: true });
      }

      // Auto-complete a locally-driven reload once its duration elapses. When the
      // caller supplies state.action explicitly (host/replicated), they own the
      // transition back to idle instead.
      if (
        state.action === undefined &&
        s.activeSeq.duration !== undefined &&
        s.actionTime >= s.activeSeq.duration
      ) {
        s.action = 'idle';
        s.actionTime = 0;
        s.activeSeq = null;
      }
    } else {
      weaponPose = lerpPose(poseNamed('lowReady'), poseNamed('aimed'), s.aimAmount);
    }

    // Continuous constant-speed chase of the weapon-root pose toward its current target (the idle
    // blend, or the sequence's interpolated pose). Makes no begin/end assumption: at an action
    // boundary the target jumps and the pose glides to it at poseGlideSpeed; within the sequence the
    // target already moves smoothly and the faster chase tracks it without visible lag. This is the
    // BASE pose (pre-recoil) so the kick below stays snappy and never feeds back into the chase.
    if (!s.basePose) {
      s.basePose = { p: weaponPose.p.slice(), r: weaponPose.r.slice(), scale: weaponPose.scale ?? 1 };
    } else {
      s.basePose = advancePoseChase(s.basePose, weaponPose, poseGlideSpeed, dt);
    }
    weaponPose = s.basePose;

    // Some mounts (the remote bot viewer) aim by rotating a hand/grip pivot. Their
    // authored hold position is already the correct place in the hands, so an ADS
    // pose translation must not be combined with that extra parent rotation: it
    // would swing the weapon away from the grip. Keep the pose's rotation/scale
    // and arm targets, but lock only its translation to the named base pose.
    if (state.lockPosePosition) {
      const lockedPose = poseNamed(state.lockPosePosition);
      weaponPose = { ...weaponPose, p: [...lockedPose.p] };
    }

    // Recoil kick applies on top of whatever pose we landed on above.
    weaponPose = {
      p: [weaponPose.p[0], weaponPose.p[1], weaponPose.p[2] + recoilOffset * RECOIL_Z],
      r: [weaponPose.r[0] - recoilOffset * RECOIL_PITCH, weaponPose.r[1], weaponPose.r[2]],
      scale: weaponPose.scale,
    };

    if (weaponView) {
      if (weaponView.position && weaponView.position.set) {
        weaponView.position.set(weaponPose.p[0], weaponPose.p[1], weaponPose.p[2]);
      }
      if (weaponView.quaternion && weaponView.quaternion.setFromEuler) {
        poseEulerScratch.x = weaponPose.r[0]; poseEulerScratch.y = weaponPose.r[1]; poseEulerScratch.z = weaponPose.r[2];
        weaponView.quaternion.setFromEuler(poseEulerScratch);
      }
      if (weaponView.scale && weaponView.scale.set) {
        const sc = weaponPose.scale ?? 1;
        weaponView.scale.set(sc, sc, sc);
      }
    }

    const def = weaponDef();
    // weapon-sequence.js's resolveTargetRef is THREE-free: it takes/returns plain arrays.
    // Flatten our THREE world transforms into { position:[x,y,z], quaternion:[x,y,z,w] } roots,
    // then lift the array result back into THREE for body.setArmTarget (Contract 1).
    const asRoot = (wt) => ({
      position: [wt.position.x, wt.position.y, wt.position.z],
      quaternion: [wt.quaternion.x, wt.quaternion.y, wt.quaternion.z, wt.quaternion.w],
      scale: [wt.scale.x, wt.scale.y, wt.scale.z],
    });
    // rootScratch is reused for both calls below: asRoot() flattens each result into a plain
    // {position:[],quaternion:[],scale:[]} object synchronously before the next call runs, so
    // the two worldTransformOf() calls never need their scratch data alive at the same time.
    const weaponRoot = asRoot(worldTransformOf(THREE, weaponView, rootScratch));
    const ctx = {
      anchors: def.ikAnchors || {},
      bodyAnchors: def.bodyAnchors || DEFAULT_BODY_ANCHORS,
      weaponRoot,
      // body.rootAnchor is the chest-height, facing-yaw node; body.group is fixed at the world
      // origin (the rig writes meshes in absolute world space), so resolving body-space refs
      // against group would ignore player position + facing. Fall back to group if no anchor.
      bodyRoot: asRoot(worldTransformOf(THREE, body && (body.rootAnchor || body.group), rootScratch)),
      cameraRoot: weaponRoot, // no camera injected; approximate with weapon root
    };

    driveHandGlide('right', rightRef, rightHint, dt, ctx);
    driveHandGlide('left', leftRef, leftHint, dt, ctx);
  }

  // Allocation-free accessor for hot loops that only need the current action name.
  function getAction() { return s.action; }

  function getDebug() {
    const recoilK = s.recoilElapsed >= RECOIL_DURATION ? 0 : 1 - s.recoilElapsed / RECOIL_DURATION;
    return {
      weaponId: s.weaponId,
      action: s.action,
      actionTime: s.actionTime,
      aim: s.aimAmount,
      recoil: s.recoilAmount * recoilK,
      hasSeq: !!s.activeSeq,
    };
  }

  return { update, play, setWeapon, setAiming, recoil, getDebug, getAction };
}
