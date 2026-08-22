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

export const BASE_GAME_BODY_MODES = Object.freeze(['off', 'thirdPerson', 'lowerBody']);

const BODY_MODE_TO_RIG = Object.freeze({ thirdPerson: 'local-third-person', lowerBody: 'local-lower-body' });

const LOCOMOTION_OPTIONS = Object.freeze({ adaptGaitToSpeed: true, movementDynamics: true, naturalLocomotion: true });
const HEADING_SPEED_MIN = 0.4;   // m/s; below this the body keeps its last heading

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
  let movementTuning = { ...BASE_GAME_MOVEMENT_DEFAULTS };
  // The arm-pose presets blend walk->run on absolute m/s; rescale them to the real move speeds.
  const movementSpeeds = { walk: 5.5, sprint: 1.75 };
  const _center = new THREE.Vector3();
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
      ...LOCOMOTION_OPTIONS,
    });
    applyMovementTuningTo(body, movementTuning);
    if (armTuning) applyArmTuningTo(body, armTuning);
    else applyMovementSpeedsTo(body);
    return { body, support, instanced, heading: null };
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
    if (Math.hypot(_velocity.x, _velocity.z) > HEADING_SPEED_MIN) record.heading = Math.atan2(-_velocity.x, -_velocity.z);
    if (record.heading == null) record.heading = lookYaw;
    const headOffset = Math.atan2(Math.sin(lookYaw - record.heading), Math.cos(lookYaw - record.heading));
    body.update(dt, {
      id,
      position: _center,
      yaw: record.heading,
      lookYaw: headOffset,
      lookWeight: 1,
      aimPitch: sample.pitch ?? 0,
      height,
      radius: sample.radius ?? 0.35,
      velocity: _velocity,
      onFloor: sample.grounded !== false,
      alive: true,
    });
  }

  function setLocalMode(mode) {
    const next = BASE_GAME_BODY_MODES.includes(mode) ? mode : 'off';
    if (next === localMode && (next === 'off') === !local) return localMode;
    if (local) { local.body.destroy(); local = null; }
    localMode = next;
    if (next !== 'off') local = makeBody(BODY_MODE_TO_RIG[next], {}, false);
    return localMode;
  }

  function updateLocal(dt, sample) {
    if (!local) return false;
    local.body.setVisible(enabled && sample.visible !== false);
    if (!enabled || sample.visible === false) return false;
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
    }
    if (record.instanced) record.body.flush(batches, true);
    return true;
  }

  function endRemoteFrame() {
    for (const record of remotes.values()) if (!record.touched) record.body.setVisible(false);
    batches?.endFrame();
  }

  function releaseRemote(id) {
    const record = remotes.get(id);
    if (!record) return false;
    record.body.destroy();
    remotes.delete(id);
    return true;
  }

  function clearRemotes() {
    for (const id of [...remotes.keys()]) releaseRemote(id);
  }

  return {
    setLocalMode,
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
