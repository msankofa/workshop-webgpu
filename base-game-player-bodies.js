// Presentation owner for Base Game player bodies. It builds and destroys procedural bodies,
// converts authoritative or predicted global player state to render-local body state, supplies the
// world-query support adapter, applies visibility modes, and reports counts. It owns no input,
// simulation, networking, camera, terrain, or state-file storage, and it can never move the capsule.

import { createProceduralPlayerBody } from './player-procedural-body.js';
import { createBodyPartBatches } from './body-part-batches.js';
import { createBodySupportAdapter } from './base-game-body-support.js';
import { remotePlayerColor } from './base-game-remote-players.js';
import { armPoseFromPreset, GAIT_DEFAULTS } from './player-procedural-body.js';
import { LOCOMOTION_DEFAULTS } from './body-locomotion.js';
import { BOT_BODIES, composeBot } from './bot-body-versions.js';
import { SOLDIER_ROLE_DESIGNS, buildSoldierDesign } from './bot-body-design.js';
import { AIM_BLEND_DEFAULTS, solveAimBlend, stepAimChannels, newAimChannels, stepRecoil, wrapAngle } from './bot-aim-blend.js';
import { BODY_HOLD_DEFAULTS } from './weapon-mount.js';

// Aim coherence for players: the torso carries most of the look-vs-heading residual and the aim
// elevation, the head the rest, the barrel trim closes what is left. Same solver as bot-viewer-v3.
export const BASE_GAME_AIM_BLEND = Object.freeze({
  ...AIM_BLEND_DEFAULTS, enabled: true, torsoEnabled: true, headEnabled: true, trimEnabled: true, recoilEnabled: true,
});
export const BASE_GAME_AIM_DISTANCE = 30;   // m along the look ray a remote's aim point is placed
export const BASE_GAME_WEAPON_ACTIONS = Object.freeze({ idle: 0, reload: 1, fire: 2, holster: 3, draw: 4 });

// Appearance choices offered to pages: every bot body version, then the human soldier role kits.
const SOLDIER_KEY = 'soldier:';
export const BASE_GAME_BODY_DESIGNS = Object.freeze([
  ...BOT_BODIES.map((b) => ({ key: b.key, label: b.label })),
  ...Object.keys(SOLDIER_ROLE_DESIGNS).map((role) => ({ key: SOLDIER_KEY + role, label: `soldier ${role}` })),
]);

function composeDesign(key) {
  if (key === 'default') return null;
  if (key.startsWith(SOLDIER_KEY)) return buildSoldierDesign(key.slice(SOLDIER_KEY.length));
  return composeBot(key, key === 'human' ? 'human' : 'as authored');
}

export const BASE_GAME_BODY_MODES = Object.freeze(['off', 'thirdPerson', 'lowerBody']);

const BODY_MODE_TO_RIG = Object.freeze({ thirdPerson: 'local-third-person', lowerBody: 'local-lower-body' });

const LOCOMOTION_OPTIONS = Object.freeze({ adaptGaitToSpeed: true, movementDynamics: true, naturalLocomotion: true });
const HEADING_SPEED_MIN = 0.4;   // m/s; below this the body keeps its last heading
// Standing turn: once the look drifts past `threshold` from the heading the body turns toward it at
// `rate` until within `settle` (hysteresis). The gun's aim point is clamped to `gunYawLimit` around
// the heading so the weapon waits for the body instead of following the camera alone.
export const BASE_GAME_FACING_DEFAULTS = Object.freeze({ threshold: 0.6, rate: 7, settle: 0.12, gunYawLimit: 0.9, gunPitchLimit: 1.1 });

// bot-viewer-v3's shipped Movement tuning (its botMovementSettings), applied the same way its
// applyBotMovementSettings() does. armSwing/armAsym are the locomotion layer's own arm channel.
export const BASE_GAME_MOVEMENT_DEFAULTS = Object.freeze({
  // Tuned in the browser 2026-08-22 (states/base-game-state-20260822021519.json).
  turnStiffness: 55,
  turnDamping: 15,
  maxForwardLead: 0.64,
  gaitModel: 'tuned',
  stepLeadScale: 0.1,
  workspaceWidthScale: 0.75,
  workspaceForwardScale: 1.5,
  bobScale: 0.2,
  swayScale: 0,
  bodyFollowRate: 20,
  locoEnabled: true,
  locoAmount: 1,
  stepOverlap: 0.2,
  spineFalloff: 3,
  strideScale: 1,
  forwardStride: GAIT_DEFAULTS.forwardStride,
  behindStride: GAIT_DEFAULTS.maxBehind,
  cadenceScale: 1,
  triggerDistance: GAIT_DEFAULTS.triggerDistance,
  armSwing: LOCOMOTION_DEFAULTS.armSwing,
  armAsym: 1.5,
});

export function createBaseGamePlayerBodies({
  THREE,
  scene,
  worldQuery,
  worldCoordinates,
  instancedRemotes = true,
  remoteCapacity = 2048,
  weaponSystem = null,     // createWeaponMountSystem(...) from weapon-mount.js; null = no weapons
} = {}) {
  if (!THREE || !scene?.add) throw new TypeError('player bodies require THREE and a scene');
  if (!worldQuery?.groundProbe || !worldCoordinates?.toRenderLocal) {
    throw new TypeError('player bodies require world-query and world-coordinate services');
  }

  const batches = instancedRemotes ? createBodyPartBatches({ THREE, scene, capacity: remoteCapacity }) : null;
  const remotes = new Map();
  let local = null;
  let localMode = 'off';
  let enabled = true;
  let localUpdates = 0;
  let remoteUpdates = 0;
  let armTuning = null;   // last applied arm tuning, re-applied to bodies created later
  let designKey = 'default';
  let design = null;      // null = the bare rig; otherwise a composed bot design
  let movementTuning = { ...BASE_GAME_MOVEMENT_DEFAULTS };
  // The arm-pose presets blend walk->run on absolute m/s; rescale them to the real move speeds.
  const movementSpeeds = { walk: 5.5, sprint: 1.75 };
  const _center = new THREE.Vector3();
  const _aimPoint = new THREE.Vector3();
  const _aimSolved = { torsoYaw: 0, torsoPitch: 0, headYaw: 0, headPitch: 0, barrelYaw: 0, barrelPitch: 0 };
  const _mountFrame = {
    feetY: 0, bodyX: 0, bodyZ: 0, yaw: 0, stance: 'stand', stanceWeights: { crouch01: 0, kneel01: 0, prone01: 0 },
    speed: 0, aiming: false, aimPoint: null, bob: 0, sway: 0, headYaw: 0, aimChannels: null, holdOffsetY: 0, holdOffsetZ: 0,
    viewFrame: null, viewBlend: 0, reachSolve: true, holdMode: 'body', bodyHold: null,
  };
  // Default facing is environment-viewer's: the body faces the look yaw and the legs strafe, so the
  // gun, the body and the camera agree by construction. 'travel' is the experimental path (heading
  // from movement, torso/head aim split, turn-in-place, aim leash).
  let facingMode = 'look';
  let aimTrim = false;    // barrel trim onto the aim point (off: env-viewer's authored hold + controller aim only)
  let reachSolve = false;
  let holdMode = 'authored';
  const facing = { ...BASE_GAME_FACING_DEFAULTS };
  const bodyHold = { idle: { ...BODY_HOLD_DEFAULTS.idle }, aim: { ...BODY_HOLD_DEFAULTS.aim } };
  const _eyeLocal = new THREE.Vector3();
  const holdTrim = { y: 0, z: 0 };
  let localWeaponId = null;
  let localAiming = false;
  let localAimPoint = null;     // render-local THREE.Vector3 | null
  const _velocity = { x: 0, y: 0, z: 0 };
  const _local = [0, 0, 0];

  function makeBody(rigMode, style, instanced) {
    const support = createBodySupportAdapter({ worldQuery, worldCoordinates });
    const body = createProceduralPlayerBody({
      THREE,
      scene,
      terrainHeight: support.terrainHeight,
      mode: rigMode,
      style,
      batches: instanced ? batches : null,
      design,
      ...LOCOMOTION_OPTIONS,
    });
    applyMovementTuningTo(body, movementTuning);
    if (armTuning) applyArmTuningTo(body, armTuning);
    else applyMovementSpeedsTo(body);
    return { body, support, instanced, heading: null, aim: newAimChannels(), weapon: newWeaponRecord() };
  }

  // Phase 1 shape; `ammo` is phase 3's, `slot` phase 4's.
  function newWeaponRecord() {
    return { id: null, mount: null, pending: 0, action: 0, actionTick: -1, lastActionTick: -1, ammo: null };
  }

  // Clamps a render-local aim point into the body's reach cone (yaw about the heading, pitch about
  // the shoulders): the gun tracks the camera only as far as the body can follow it.
  const _clamped = new THREE.Vector3();
  function clampAimPoint(point, heading, height) {
    const ox = _center.x, oy = _center.y + height * 0.35, oz = _center.z;
    const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
    const horiz = Math.hypot(dx, dz);
    const dist = Math.hypot(horiz, dy);
    if (dist < 1e-6) return point;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horiz);
    const yawOff = wrapAngle(yaw - heading);
    const yawC = Math.max(-facing.gunYawLimit, Math.min(facing.gunYawLimit, yawOff));
    const pitchC = Math.max(-facing.gunPitchLimit, Math.min(facing.gunPitchLimit, pitch));
    if (yawC === yawOff && pitchC === pitch) return point;
    const y2 = heading + yawC, c = Math.cos(pitchC);
    return _clamped.set(ox - Math.sin(y2) * c * dist, oy + Math.sin(pitchC) * dist, oz - Math.cos(y2) * c * dist);
  }

  // Requests the mount for `id` on a record; async, so the record notes the request and ignores
  // a stale resolution (token) when the weapon changed again before the GLB arrived.
  function requestWeapon(record, id) {
    const w = record.weapon;
    if (w.id === id) return;
    w.id = id;
    if (w.mount) { weaponSystem?.destroyMount(w.mount); w.mount = null; }
    if (!id || !weaponSystem) return;
    const token = ++w.pending;
    weaponSystem.createMount(record.body, id).then((mount) => {
      if (token !== w.pending || !mount) { if (mount) weaponSystem.destroyMount(mount); return; }
      w.mount = mount;
    }).catch((error) => { if (token === w.pending) console.warn('[base-game] weapon mount failed', id, error); });
  }

  function releaseWeapon(record) {
    const w = record.weapon;
    w.pending++;
    if (w.mount) { weaponSystem?.destroyMount(w.mount); w.mount = null; }
    w.id = null;
  }

  function setWeapon(id) {
    localWeaponId = id || null;
    if (local) requestWeapon(local, localWeaponId);
  }

  function setLocalAim(aiming, aimPoint) {
    localAiming = !!aiming;
    localAimPoint = aimPoint || null;
  }

  // Plays the reload sequence on the record's mount when a new action tick arrives.
  function applyAction(record, action, actionTick) {
    const w = record.weapon;
    w.action = action | 0;
    if (actionTick == null || actionTick === w.lastActionTick) return;
    w.lastActionTick = actionTick;
    w.actionTick = actionTick;
    if (w.action === BASE_GAME_WEAPON_ACTIONS.reload) w.mount?.controller.play('reload');
    if (w.action === BASE_GAME_WEAPON_ACTIONS.fire) { w.mount?.controller.recoil(); record.aim.recoilPitch += BASE_GAME_AIM_BLEND.recoilKick; }
  }

  function localReload() {
    const w = local?.weapon;
    if (!w?.mount || w.mount.controller.getAction() === 'reload') return false;
    w.mount.controller.play('reload');
    return true;
  }

  // Arm tuning = a preset plus slider overrides; written straight into each rig's live armCfg.
  function applyArmTuningTo(body, tuning) {
    const cfg = body.armCfg;
    if (!cfg) return;
    Object.assign(cfg, armPoseFromPreset(tuning.preset));
    if (Number.isFinite(tuning.idleBend)) cfg.idle.bend = tuning.idleBend;
    if (Number.isFinite(tuning.walkRaise)) cfg.walk.raise = tuning.walkRaise;
    if (Number.isFinite(tuning.walkSwing)) cfg.walk.swing = tuning.walkSwing;
    if (Number.isFinite(tuning.runRaise)) cfg.run.raise = tuning.runRaise;
    if (Number.isFinite(tuning.runSwing)) cfg.run.swing = tuning.runSwing;
    if (Number.isFinite(tuning.runPump)) cfg.run.pump = tuning.runPump;
    if (Number.isFinite(tuning.jumpLift)) cfg.jumpLift = tuning.jumpLift;
    if (Number.isFinite(tuning.fallLift)) cfg.fallLift = tuning.fallLift;
    if (Number.isFinite(tuning.fallSpeedRef)) cfg.fallSpeedRef = tuning.fallSpeedRef;
    if (Number.isFinite(tuning.fallTimeRef)) cfg.fallTimeRef = tuning.fallTimeRef;
    if (Number.isFinite(tuning.poseSmoothing)) cfg.poseSmoothing = tuning.poseSmoothing;
    if (Number.isFinite(tuning.landSwing)) cfg.landSwing = tuning.landSwing;
    cfg.enabled = tuning.enabled !== false;
    applyMovementSpeedsTo(body);
    // Elbow bend direction: rotation of the down/back pole about the arm axis, mirrored per side.
    if (Number.isFinite(tuning.elbowPole) && body.ikCfg) {
      body.ikCfg.leftArmPole = tuning.elbowPole;
      body.ikCfg.rightArmPole = -tuning.elbowPole;
    }
  }

  // Port of bot-viewer-v3's applyBotMovementSettings(): one amount scales every cyclic amplitude
  // off the module defaults so the tuned ratios between channels survive dialling it down.
  function applyMovementTuningTo(body, t) {
    body.turnCfg.stiffness = t.turnStiffness;
    body.turnCfg.damping = t.turnDamping;
    Object.assign(body.movementTuning, {
      maxForwardLead: t.maxForwardLead,
      stepLeadScale: t.stepLeadScale,
      gaitModel: t.gaitModel,
      workspaceWidthScale: t.workspaceWidthScale,
      workspaceForwardScale: t.workspaceForwardScale,
      bobScale: t.bobScale, swayScale: t.swayScale, bodyFollowRate: t.bodyFollowRate,
      strideScale: t.strideScale, cadenceScale: t.cadenceScale,
    });
    body.gait.cfg.stepOverlap = t.stepOverlap;
    body.gait.cfg.triggerDistance = t.triggerDistance;
    body.gait.cfg.forwardStride = t.forwardStride;
    body.gait.cfg.maxBehind = t.behindStride;
    if (body.spineCfg) body.spineCfg.falloff = t.spineFalloff;
    if (body.locomotion) {
      const l = body.locomotion.cfg, a = t.locoAmount;
      l.enabled = !!t.locoEnabled;
      l.armSwing = t.armSwing * a;
      l.armAsym = t.armAsym;
      l.pelvisRoll = LOCOMOTION_DEFAULTS.pelvisRoll * a;
      l.pelvisYaw = LOCOMOTION_DEFAULTS.pelvisYaw * a;
      l.torsoLean = LOCOMOTION_DEFAULTS.torsoLean * a;
      l.bob = LOCOMOTION_DEFAULTS.bob * a;
      l.sway = LOCOMOTION_DEFAULTS.sway * a;
      l.heelStrike = LOCOMOTION_DEFAULTS.heelStrike * a;
      l.toeOff = LOCOMOTION_DEFAULTS.toeOff * a;
      l.armSpread = LOCOMOTION_DEFAULTS.armSpread * a;
    }
  }

  function setMovementTuning(patch) {
    movementTuning = { ...movementTuning, ...patch };
    if (local) applyMovementTuningTo(local.body, movementTuning);
    for (const record of remotes.values()) applyMovementTuningTo(record.body, movementTuning);
  }

  function applyMovementSpeedsTo(body) {
    const cfg = body.armCfg;
    if (!cfg) return;
    const walk = movementSpeeds.walk, run = walk * movementSpeeds.sprint;
    cfg.walkSpeed = walk * 0.55;           // arms settle into the walk pose just above a shuffle
    cfg.runSpeedLo = walk * 1.25;          // run pose starts once clearly past walking speed
    cfg.runSpeedHi = Math.max(cfg.runSpeedLo + 0.2, run * 0.95);   // and is full just under sprint
  }

  function setMovementSpeeds({ walk, sprint } = {}) {
    if (Number.isFinite(walk) && walk > 0) movementSpeeds.walk = walk;
    if (Number.isFinite(sprint) && sprint > 0) movementSpeeds.sprint = sprint;
    if (local) applyMovementSpeedsTo(local.body);
    for (const record of remotes.values()) applyMovementSpeedsTo(record.body);
  }

  function setArmTuning(tuning) {
    armTuning = { ...tuning };
    if (local) applyArmTuningTo(local.body, armTuning);
    for (const record of remotes.values()) applyArmTuningTo(record.body, armTuning);
  }

  // Converts one global player sample into the body's render-local update state.
  function feed(record, dt, sample, id) {
    const { body, support } = record;
    const foot = sample.globalFoot;
    support.setReference(foot);
    worldCoordinates.toRenderLocal(foot, _local);
    const height = sample.height ?? 1.8;
    _center.set(_local[0], _local[1] + height * 0.5, _local[2]);
    _velocity.x = sample.velocity?.[0] ?? 0;
    _velocity.y = sample.velocity?.[1] ?? 0;
    _velocity.z = sample.velocity?.[2] ?? 0;
    // The rig leans and strides along its facing, so facing must be the heading of travel (as
    // bot-viewer-v3 does); the camera yaw rides on top as a head look. Forward at yaw is (-sin, -cos).
    const lookYaw = sample.yaw ?? 0;
    const moving = Math.hypot(_velocity.x, _velocity.z) > HEADING_SPEED_MIN;
    if (facingMode === 'look') { record.heading = lookYaw; record.turning = false; }
    else if (moving) { record.heading = Math.atan2(-_velocity.x, -_velocity.z); record.turning = false; }
    if (record.heading == null) record.heading = lookYaw;
    let headOffset = wrapAngle(lookYaw - record.heading);
    if (facingMode !== 'look' && !moving) {
      // Turn in place toward the look once it is past the threshold; keep turning until settled.
      if (!record.turning && Math.abs(headOffset) > facing.threshold) record.turning = true;
      if (record.turning) {
        const step = Math.min(Math.abs(headOffset), facing.rate * Math.max(0, dt));
        record.heading = wrapAngle(record.heading + Math.sign(headOffset) * step);
        headOffset = wrapAngle(lookYaw - record.heading);
        if (Math.abs(headOffset) <= facing.settle) record.turning = false;
      }
    }
    const pitch = sample.pitch ?? 0;
    // Aim split while a weapon is held: torso takes its share of the look residual and elevation,
    // head the rest. Without a weapon the head alone carries the look, as before.
    const w = record.weapon;
    const aiming = !!w.mount && (sample.aiming ?? (record === local ? localAiming : false));
    const ch = record.aim;
    ch.recoilPitch = stepRecoil(ch.recoilPitch, BASE_GAME_AIM_BLEND, dt);
    if (w.mount && facingMode !== 'look') {
      solveAimBlend(wrapAngle(headOffset), pitch, BASE_GAME_AIM_BLEND, _aimSolved);
    } else {
      _aimSolved.torsoYaw = 0; _aimSolved.torsoPitch = 0; _aimSolved.headYaw = headOffset; _aimSolved.headPitch = pitch;
    }
    const split = !!w.mount && facingMode !== 'look';
    stepAimChannels(ch, _aimSolved, BASE_GAME_AIM_BLEND, dt, split ? 1 : 0);
    body.update(dt, {
      id,
      position: _center,
      yaw: record.heading,
      lookYaw: split ? ch.headYaw : headOffset,
      lookWeight: 1,
      aimPitch: split ? ch.headPitch : pitch,
      aimYaw: split ? ch.torsoYaw : 0,
      aimLean: split ? ch.torsoPitch + ch.recoilPitch : ch.recoilPitch,
      height,
      radius: sample.radius ?? 0.35,
      velocity: _velocity,
      onFloor: sample.grounded !== false,
      alive: true,
    });
    if (sample.weapon !== undefined && record !== local) requestWeapon(record, sample.weapon || null);
    if (sample.action !== undefined) applyAction(record, sample.action, sample.actionTick);
    if (w.mount) {
      const motion = body.motion;
      const speed = Math.hypot(_velocity.x, _velocity.z);
      let aimPoint = null;
      if (aiming && aimTrim) {
        if (record === local && localAimPoint) aimPoint = clampAimPoint(localAimPoint, record.heading, height);
        else {
          // Remote aim point: along the replicated look direction from the eyes.
          const c = Math.cos(pitch);
          aimPoint = _aimPoint.set(
            _center.x - Math.sin(lookYaw) * c * BASE_GAME_AIM_DISTANCE,
            _center.y + height * 0.35 + Math.sin(pitch) * BASE_GAME_AIM_DISTANCE,
            _center.z - Math.cos(lookYaw) * c * BASE_GAME_AIM_DISTANCE);
        }
      }
      const f = _mountFrame;
      f.feetY = _local[1]; f.bodyX = motion.bodyPosition.x; f.bodyZ = motion.bodyPosition.z;
      f.yaw = motion.visualYaw; f.stance = speed > movementSpeeds.walk * 1.3 ? 'run' : 'stand';
      f.speed = speed; f.aiming = aiming; f.aimPoint = aimPoint;
      f.bob = motion.bob; f.sway = motion.sway; f.headYaw = motion.headYaw ?? 0;
      f.aimChannels = split ? ch : null;
      f.holdOffsetY = holdTrim.y; f.holdOffsetZ = holdTrim.z;
      // Phase 2: the owner's first-person presentation blends the hold toward an authored view frame.
      f.viewFrame = record === local ? (sample.viewFrame ?? null) : null;
      f.viewBlend = record === local ? (sample.viewBlend ?? 0) : 0;
      f.reachSolve = reachSolve;
      f.holdMode = holdMode; f.bodyHold = bodyHold;
      weaponSystem.updateMount(w.mount, dt, f);
      w.mount.visible = body.group.visible !== false;
    }
  }

  function flushWeapons() {
    if (!weaponSystem) return;
    weaponSystem.beginFrame();
    if (local?.weapon.mount) weaponSystem.flushMount(local.weapon.mount);
    for (const record of remotes.values()) if (record.touched !== false && record.weapon.mount) weaponSystem.flushMount(record.weapon.mount);
    weaponSystem.endFrame();
  }

  // Swaps the appearance for the local body and every remote; bodies are rebuilt in place and
  // remotes re-create themselves on their next update.
  function setBodyDesign(key) {
    const entry = BASE_GAME_BODY_DESIGNS.find((d) => d.key === key) || BASE_GAME_BODY_DESIGNS[0];
    if (entry.key === designKey) return designKey;
    designKey = entry.key;
    design = composeDesign(entry.key);
    if (local) { releaseWeapon(local); local.body.destroy(); local = makeBody(BODY_MODE_TO_RIG[localMode], {}, false); requestWeapon(local, localWeaponId); }
    clearRemotes();
    return designKey;
  }

  function setLocalMode(mode) {
    const next = BASE_GAME_BODY_MODES.includes(mode) ? mode : 'off';
    if (next === localMode && (next === 'off') === !local) return localMode;
    if (local) { releaseWeapon(local); local.body.destroy(); local = null; }
    localMode = next;
    if (next !== 'off') { local = makeBody(BODY_MODE_TO_RIG[next], {}, false); requestWeapon(local, localWeaponId); }
    return localMode;
  }

  function updateLocal(dt, sample) {
    if (!local) return false;
    local.body.setVisible(enabled && sample.visible !== false);
    if (!enabled || sample.visible === false) { if (local.weapon.mount) local.weapon.mount.visible = false; return false; }
    feed(local, dt, sample, 'local');
    localUpdates++;
    return true;
  }

  // Remote bodies are keyed by player id; the sample is the interpolated global state from the
  // remote tracks. Bodies that stop being updated for a frame are hidden, not destroyed.
  function beginRemoteFrame() {
    for (const record of remotes.values()) record.touched = false;
    batches?.beginFrame();
  }

  function updateRemote(dt, id, sample) {
    let record = remotes.get(id);
    if (!record) {
      record = makeBody('remote', {}, !!batches);
      const color = remotePlayerColor(id);
      record.body.setTint?.({ h: color.getHSL({}).h, s: 0.62, l: 0.56 });
      remotes.set(id, record);
    }
    record.touched = true;
    record.body.setVisible(enabled && sample.visible !== false);
    if (enabled && sample.visible !== false) {
      feed(record, dt, sample, id);
      remoteUpdates++;
    } else if (record.weapon.mount) record.weapon.mount.visible = false;
    if (record.instanced) record.body.flush(batches, true);
    return true;
  }

  function endRemoteFrame() {
    for (const record of remotes.values()) if (!record.touched) { record.body.setVisible(false); if (record.weapon.mount) record.weapon.mount.visible = false; }
    batches?.endFrame();
    flushWeapons();
  }

  function releaseRemote(id) {
    const record = remotes.get(id);
    if (!record) return false;
    releaseWeapon(record);
    record.body.destroy();
    remotes.delete(id);
    return true;
  }

  function clearRemotes() {
    for (const id of [...remotes.keys()]) releaseRemote(id);
  }

  return {
    setLocalMode,
    setBodyDesign,
    get bodyDesign() { return designKey; },
    setWeapon,
    setHoldTrim({ y, z } = {}) { if (Number.isFinite(y)) holdTrim.y = y; if (Number.isFinite(z)) holdTrim.z = z; },
    setLocalPartMask(mask) { local?.body.setPartMask?.(mask); },
    setReachSolve(on) { reachSolve = on === true; },
    setFacingMode(mode) { facingMode = mode === 'travel' ? 'travel' : 'look'; },
    setAimTrim(on) { aimTrim = on === true; },
    setFacing(patch) { for (const k in patch) if (Number.isFinite(patch[k])) facing[k] = patch[k]; },
    // 'body' places the trigger grip from the shoulder (elbows bend by construction); 'authored' uses the bot holds.
    setHoldMode(mode, cfg = null) {
      holdMode = mode === 'authored' ? 'authored' : 'body';
      if (cfg?.idle) Object.assign(bodyHold.idle, cfg.idle);
      if (cfg?.aim) Object.assign(bodyHold.aim, cfg.aim);
    },
    // Metres the eyes sit ahead of the head centre at rest (the head's z-squash included).
    localEyeForward() {
      const body = local?.body;
      const head = body?.parts?.core?.head;
      if (!head) return 0;
      const eye = body.eyeCfg;
      return ((eye?.z ?? 0) + (eye?.depth ?? 0) * 0.6) * (head.scale?.z ?? 1);
    },
    // Render-local eye point on the local body's animated head (bot-viewer-v3's POV anchor), or null.
    localEyePoint(out = [0, 0, 0]) {
      const body = local?.body;
      const head = body?.parts?.core?.head;
      if (!head || !body.group.visible) return null;
      const eye = body.eyeCfg;
      _eyeLocal.set(eye?.x ?? 0, eye?.y ?? 0, (eye?.z ?? 0) + (eye?.depth ?? 0) * 0.6);
      head.updateWorldMatrix(true, false);
      head.localToWorld(_eyeLocal);
      out[0] = _eyeLocal.x; out[1] = _eyeLocal.y; out[2] = _eyeLocal.z;
      return out;
    },
    setLocalAim,
    localReload,
    flushWeapons,
    get localWeapon() { return local?.weapon ?? null; },
    get localMount() { return local?.weapon.mount ?? null; },
    remoteMount(id) { return remotes.get(id)?.weapon.mount ?? null; },
    get localHeading() { return local?.heading ?? null; },
    remoteWeapon(id) { return remotes.get(id)?.weapon ?? null; },
    setArmTuning,
    setMovementSpeeds,
    setMovementTuning,
    get movementTuning() { return { ...movementTuning }; },
    updateLocal,
    beginRemoteFrame,
    updateRemote,
    endRemoteFrame,
    releaseRemote,
    clearRemotes,
    setEnabled(value) {
      enabled = !!value;
      local?.body.setVisible(enabled);
      for (const record of remotes.values()) record.body.setVisible(enabled);
    },
    get enabled() { return enabled; },
    get localMode() { return localMode; },
    get localBody() { return local?.body ?? null; },
    get localSupport() { return local?.support ?? null; },
    get remoteCount() { return remotes.size; },
    get remoteIds() { return remotes.keys(); },
    get diagnostics() {
      let probes = 0, misses = 0;
      if (local) { probes += local.support.diagnostics.probes; misses += local.support.diagnostics.misses; }
      for (const record of remotes.values()) { probes += record.support.diagnostics.probes; misses += record.support.diagnostics.misses; }
      return { localMode, localBodies: local ? 1 : 0, remoteBodies: remotes.size, localUpdates, remoteUpdates, supportProbes: probes, supportMisses: misses, instancedRemotes: !!batches };
    },
    dispose() {
      if (local) { local.body.destroy(); local = null; }
      clearRemotes();
      batches?.dispose?.();
    },
  };
}
