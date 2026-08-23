// weapon-viewmodel.js — first-person weapon placement as a pure camera-local pose.
//
// Port of environment-viewer.html's createLocalWeaponViewModel maths (authored viewOffset /
// viewRotation, ADS lerp to aimOffset / aimRotation, idle/walk/run bob cross-fade with a strafe-
// relative run axis, run carry lean, recoil kick, reload delta from the shared reloadSequence)
// with no rendering of its own. update() returns { position, rotation, viewBob } in CAMERA space
// (+x right, +y up, -z forward); the caller lifts it into the world and hands it to
// weapon-mount.js as the `viewFrame` of the first-person blend (phase 2 of the weapons plan).
// The pose is for the mount's weaponView (normalized model root), so the authored base rotation
// [0, PI, 0] is the same flip the mount's weaponFrame carries.

import { runBobAxis, easeToward } from './view-feel.js';
import { reloadPoseDelta } from './weapon-sequence.js';

export const VIEWMODEL_FEEL = Object.freeze({
  bobWalk: 0.024,      // weapon bob amplitude when walking (m)
  bobRun: 0.05,        // weapon bob amplitude when running (m)
  recoilDuration: 0.16,
  reloadFallback: 1.2, // seconds, when a weapon has no reloadSequence
});

const DEFAULT_VIEW_OFFSET = [0.22, -0.18, -0.42];
const DEFAULT_VIEW_ROTATION = [0, Math.PI, 0];

export function createWeaponViewModel({ getWeapon, feel = VIEWMODEL_FEEL } = {}) {
  let weaponId = null;
  let t = 0;
  let bobPhase = 0;
  let carryBlend = 0, moveBlend = 0, runBlend = 0;
  let recoilT = 0;
  let reloadT = 0, reloadDur = feel.reloadFallback, activeReloadSeq = null;
  const out = { position: [0, 0, 0], rotation: [0, 0, 0], viewBob: { x: 0, y: 0, z: 0 }, visible: false, aim: 0, reloading: false };

  function setWeapon(id) {
    if (id === weaponId) return;
    weaponId = id || null;
    recoilT = 0; reloadT = 0; activeReloadSeq = null; carryBlend = 0;
  }

  function recoil() { recoilT = feel.recoilDuration; }

  // Starts the reload using the same sequence data the third-person controller plays.
  function reload(sequence) {
    activeReloadSeq = sequence || null;
    reloadDur = typeof sequence?.duration === 'number' ? sequence.duration : feel.reloadFallback;
    reloadT = reloadDur;
  }

  /**
   * @param {number} dt
   * @param {object} s  { speed, aim (0..1), running, moveX, moveZ, lookYaw }
   *   moveX/moveZ are the world-space move axes as the page holds them; lookYaw the camera yaw.
   */
  function update(dt, { speed = 0, aim = 0, running = false, moveX = 0, moveZ = 0, lookYaw = 0 } = {}) {
    const weapon = weaponId ? getWeapon(weaponId) : null;
    if (!weapon) { out.visible = false; return out; }
    t += dt;
    recoilT = Math.max(0, recoilT - dt);
    reloadT = Math.max(0, reloadT - dt);
    const reloading = reloadT > 0;
    const usingSeq = reloading && activeReloadSeq;
    const seqDelta = usingSeq ? reloadPoseDelta(activeReloadSeq, reloadDur - reloadT) : null;
    const reloadP = reloading && !usingSeq ? 1 - reloadT / reloadDur : 0;
    const reloadBump = reloading && !usingSeq ? Math.sin(Math.PI * reloadP) : 0;
    const aimAmt = reloading ? 0 : Math.max(0, Math.min(1, aim));
    const offset = weapon.viewOffset ?? DEFAULT_VIEW_OFFSET;
    const rotBase = weapon.viewRotation ?? DEFAULT_VIEW_ROTATION;
    const aimTgt = weapon.aimOffset ?? [offset[0] * 0.15, offset[1] + 0.03, offset[2] + 0.06];
    const aimRotTgt = weapon.aimRotation ?? [rotBase[0], rotBase[1] * 0.85, rotBase[2]];
    const rot = [0, 1, 2].map((i) => rotBase[i] + (aimRotTgt[i] - rotBase[i]) * aimAmt);
    const aimOffset = [0, 1, 2].map((i) => offset[i] + (aimTgt[i] - offset[i]) * aimAmt);
    // Run/gun bob: idle<->walk<->run cross-fades; aiming and reloading damp it.
    // Fully aimed = fully still: sights must not move with the feet (env-viewer kept 15 %).
    const swayDamp = (1 - aimAmt) * (reloading ? 0.2 : 1);
    const moving = speed > 0.4;
    moveBlend = easeToward(moveBlend, moving ? 1 : 0, dt, 8);
    runBlend = easeToward(runBlend, running ? 1 : 0, dt, 6);
    const idleAmp = feel.bobWalk * 0.22;
    const bobAmount = (idleAmp + (feel.bobWalk - idleAmp) * moveBlend + (feel.bobRun - feel.bobWalk) * runBlend) * swayDamp;
    const bobSpeed = 3 + 4 * moveBlend + 3 * runBlend;
    bobPhase += dt * bobSpeed;
    const cy = Math.cos(lookYaw), sy = Math.sin(lookYaw);
    const localRight = moveX * cy - moveZ * sy;
    const localFwd = moveX * -sy + moveZ * -cy;
    const axis = runBobAxis(localRight, -localFwd);
    const rb = runBlend, wb = 1 - runBlend;
    const s1 = Math.sin(bobPhase), sHalf = Math.sin(bobPhase * 0.5);
    const sideBob = (wb * sHalf * 0.45 + rb * axis.x * s1 * 1.65) * bobAmount;
    const depthBob = (rb * axis.z * s1 * 1.65) * bobAmount;
    const vertBob = (wb * Math.abs(s1) * 0.5 + rb * Math.abs(Math.cos(bobPhase * 1.15)) * 0.38) * bobAmount;
    const rollBob = (wb * sHalf * 0.35 + rb * axis.x * s1 * 0.9) * bobAmount;
    const carryTarget = running && !reloading ? (1 - aimAmt) : 0;
    carryBlend = easeToward(carryBlend, carryTarget, dt, 10);
    const carryX = -0.12 * carryBlend, carryY = -0.06 * carryBlend, carryZ = 0.16 * carryBlend;
    out.viewBob.x = sideBob + carryX; out.viewBob.y = vertBob + carryY; out.viewBob.z = depthBob + carryZ;
    const recoilMul = weapon.recoil ?? 1;
    const kick = reloading ? 0 : (recoilT / feel.recoilDuration) * recoilMul;
    out.position[0] = aimOffset[0] + sideBob + carryX + (seqDelta ? seqDelta.dp[0] : 0);
    out.position[1] = aimOffset[1] + vertBob + carryY + kick * 0.025 - reloadBump * 0.08 + (seqDelta ? seqDelta.dp[1] : 0);
    out.position[2] = aimOffset[2] + depthBob + carryZ + kick * 0.08 - reloadBump * 0.05 + (seqDelta ? seqDelta.dp[2] : 0);
    out.rotation[0] = rot[0] + kick * 0.05 + reloadBump * 0.22 - carryBlend * 0.05 + (seqDelta ? seqDelta.dr[0] : 0);
    out.rotation[1] = rot[1] + carryBlend * 0.5 + (seqDelta ? seqDelta.dr[1] : 0);
    out.rotation[2] = rot[2] + rollBob - carryBlend * 0.08 + (seqDelta ? seqDelta.dr[2] : 0);
    out.visible = true;
    out.aim = aimAmt;
    out.reloading = reloading;
    return out;
  }

  return {
    setWeapon, recoil, reload, update,
    get weaponId() { return weaponId; },
    get reloading() { return reloadT > 0; },
    get state() { return { moveBlend, runBlend, carryBlend, recoilT, reloadT }; },
    get bobPhase() { return bobPhase; },   // footsteps sync to this (html-game-v2's weaponBobTime)
  };
}
