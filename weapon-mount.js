// weapon-mount.js — third-person held-weapon mount for any procedural body.
//
// Extracted from bot-viewer-v3.html's createBotWeaponMount / updateBotWeaponMount /
// flushWeaponMount / stepBarrelTrim so the base game and the bot viewer share one
// implementation of Contract 6 (docs/subsystems/procedural-body-weapon-contracts.md).
// The mount root is ground-anchored and stance-invariant (terrain + 1.5 at the body's
// smoothed XZ); bob and sway are re-added explicitly; the hold is stance x locomotion
// from weapon-hold-resolver.js; the pose controller drives both hands from weaponView.
//
// THREE and the loader are injected so the module stays importable from Node for tests.

import { createWeaponPoseController } from './weapon-pose-controller.js';
import { createWeaponPartBatches, bakeSkinnedGeometry } from './weapon-part-batches.js';
import { resolveWeaponHold, carryDeltaFor, locomotionFor, isCarryLocomotion, isOneHanded,
  hasCarryVocabulary, stepCarryBlend, snapCarryBlend, LOCOMOTION_AIM } from './weapon-hold-resolver.js';
import { AIM_BLEND_DEFAULTS, barrelTrimFraction, releaseTrimFraction } from './bot-aim-blend.js';
import { PISTOL_IDS } from './bot-sidearm.js';

export const MOUNT_HEIGHT = 1.5;              // metres above the body's own feet (Contract 6)
export const CARRY_MOVING_SPEED = 0.35;       // m/s above which a standing body shows the walk carry
export const WEAPON_NORMALIZED_SIZE = 0.62;   // longest GLB axis after normalization (m)
export const BARREL_REFERENCE_BACK = 0.25;    // metres behind the muzzle along the bore for the barrel ray
// Where the freed support hand goes on a one-handed dash: in front of the chest, elbow outward.
export const DASH_HAND = Object.freeze({ fwd: 0.16, side: 0.14, up: -0.04 });
export const REACH_FRACTION = 0.96;           // usable fraction of the straight arm for the two-grip reach solve
export const REACH_ITERATIONS = 2;
// Body-relative hold: the trigger grip is placed from the trigger shoulder along the aim direction,
// as fractions of the arm length (dist) and metres (side: +right, up), blended idle -> aimed by the
// controller's aim amount. Elbows bend by construction; the authored hold supplies rotation only.
export const BODY_HOLD_DEFAULTS = Object.freeze({
  idle: Object.freeze({ dist: 0.55, side: -0.04, up: -0.16 }),
  aim: Object.freeze({ dist: 0.46, side: -0.10, up: 0.06 }),
});

const STANCE_STAND = 'stand';

// ---- stowed weapons (ported from bot-viewer-v3's stow block) --------------------------------
// What is NOT in your hands still hangs on you. A stowed copy is a reduced part list riding the
// torso joint, drawn through the same instanced pool as the held gun, so it costs no draw call of
// its own. Long guns go across the back, pistols on the right hip.
export const STOW_LOD_COVERAGE = 0.9;   // keep the largest sub-meshes covering this share of the vertices
export const STOW_LOD_MAX_PARTS = 2;
export const STOW_PLACEMENTS = Object.freeze({
  back: Object.freeze({ position: [0.02, -0.06, -0.20], rotation: [-Math.PI / 2, 0.61, 0], scale: 0.95 }),
  hip: Object.freeze({ position: [0.22, -0.32, 0.02], rotation: [Math.PI / 2, 0.25, 0], scale: 0.95 }),
});
export function stowPlacementFor(weaponId) {
  return PISTOL_IDS.includes(weaponId) ? STOW_PLACEMENTS.hip : STOW_PLACEMENTS.back;
}
// Where a weapon sits when it is put away, as a hold the mount can blend to. A weapon may author
// its own `holsterHold`; otherwise it is derived from where the weapon would be STOWED, which is
// the place it is actually travelling to -- the two must not be authored apart and drift.
const _holsterHolds = new Map();
export function holsterHoldFor(weaponId, def) {
  if (def?.holsterHold) return def.holsterHold;
  let hold = _holsterHolds.get(weaponId);
  if (!hold) {
    const placement = stowPlacementFor(weaponId);
    hold = { position: [...placement.position], rotation: [...placement.rotation], scale: 1 };
    _holsterHolds.set(weaponId, hold);
  }
  return hold;
}

// Largest sub-meshes first until they cover `coverage` of the vertices or `maxParts` is reached: a
// gun on someone's back is a silhouette, and its trigger guard is never the thing you can see.
export function buildStowParts(instanceParts, { maxParts = STOW_LOD_MAX_PARTS, coverage = STOW_LOD_COVERAGE } = {}) {
  if (!instanceParts?.length) return [];
  const scored = instanceParts
    .map((part) => ({ part, verts: part.geometry?.attributes?.position?.count ?? 0 }))
    .sort((a, b) => b.verts - a.verts);
  const total = scored.reduce((sum, entry) => sum + entry.verts, 0) || 1;
  const kept = [];
  let covered = 0;
  for (const entry of scored) {
    if (kept.length >= maxParts || covered / total >= coverage) break;
    kept.push(entry.part);
    covered += entry.verts;
  }
  return kept.length ? kept : instanceParts;
}
// The loadout minus what is in hand, in slot order, deduplicated. A knife in hand stows BOTH guns.
export function stowedWeaponIds(loadout, heldId, { slots = ['primary', 'sidearm'] } = {}) {
  const ids = [];
  for (const slot of slots) {
    const id = loadout?.[slot];
    if (id && id !== 'none' && id !== heldId && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Shared scratch (consumed fully per call, never held across calls).
let _S = null;
function scratch(THREE) {
  if (_S) return _S;
  _S = {
    partMatrix: new THREE.Matrix4(),
    rootEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
    rootQuat: new THREE.Quaternion(),
    twistQ: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0),
    holdEuler: new THREE.Euler(),
    holdQuat: new THREE.Quaternion(),
    hold: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    loco: { stance: STANCE_STAND, aiming: false, moving: false },
    dashRight: new THREE.Vector3(), dashFwd: new THREE.Vector3(), dashHand: new THREE.Vector3(),
    barrel: { rear: new THREE.Vector3(), origin: new THREE.Vector3(), direction: new THREE.Vector3(), pivot: new THREE.Vector3() },
    wanted: new THREE.Vector3(),
    trimDesired: new THREE.Quaternion(),
    viewPos: new THREE.Vector3(), viewQuat: new THREE.Quaternion(), viewScale: new THREE.Vector3(),
    viewTarget: new THREE.Matrix4(), viewChain: new THREE.Matrix4(),
    shoulderR: new THREE.Vector3(), shoulderL: new THREE.Vector3(), gripR: new THREE.Vector3(), gripL: new THREE.Vector3(),
    reachV: new THREE.Vector3(), reachW: new THREE.Vector3(), reachAxis: new THREE.Vector3(), reachQ: new THREE.Quaternion(),
    bhFwd: new THREE.Vector3(), bhRight: new THREE.Vector3(), bhUp: new THREE.Vector3(), bhTarget: new THREE.Vector3(), bhGrip: new THREE.Vector3(),
    lockOpts: { lockPosePosition: 'lowReady' },
    noOpts: {},
    stowWorld: new THREE.Matrix4(), stowPart: new THREE.Matrix4(),
    stowPos: new THREE.Vector3(), stowOffset: new THREE.Vector3(), stowScale: new THREE.Vector3(),
    stowQuat: new THREE.Quaternion(), stowLocal: new THREE.Quaternion(), stowYaw: new THREE.Quaternion(),
    stowEuler: new THREE.Euler(),
  };
  return _S;
}

function quatAngleBetween(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
}

// Rotate the GLB so its longest axis is Z, scale it to targetSize, centre it; returns the matrix.
export function normalizeWeaponModel(THREE, model, targetSize = WEAPON_NORMALIZED_SIZE) {
  const box = new THREE.Box3(), size = new THREE.Vector3();
  model.updateMatrixWorld(true);
  box.setFromObject(model); box.getSize(size);
  if (size.x >= size.y && size.x >= size.z) model.rotation.y = Math.PI * 0.5;
  else if (size.y >= size.x && size.y >= size.z) model.rotation.x = Math.PI * 0.5;
  model.updateMatrixWorld(true);
  box.setFromObject(model); box.getSize(size);
  model.scale.multiplyScalar(targetSize / Math.max(size.x, size.y, size.z, 1e-6));
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  model.position.sub(box.getCenter(new THREE.Vector3()));
  model.updateMatrixWorld(true);
  return model.matrixWorld.clone();
}

// Raw-GLB-space anchors -> the normalized space the model renders in.
export function bakeWeaponAnchors(THREE, rawAnchors, matrix) {
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(matrix));
  const anchors = {};
  for (const key in rawAnchors) {
    const raw = rawAnchors[key];
    const position = new THREE.Vector3(...raw.p).applyMatrix4(matrix);
    const quaternion = rotation.clone().multiply(new THREE.Quaternion(...(raw.q || [0, 0, 0, 1])));
    anchors[key] = { p: [position.x, position.y, position.z], q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] };
  }
  return anchors;
}

// Default reload choreography when the pose data has none but the anchors allow one.
export function defaultReloadSequence(poseData, rawAnchors) {
  if (!(rawAnchors?.magwell && rawAnchors?.chargingHandle)) return null;
  return {
    duration: 1.45,
    commitAmmoAt: 1.05,
    poses: { aimed: poseData?.weaponPoses?.aimed, reloadRaise: poseData?.weaponPoses?.reloadRaise },
    keys: [
      { t: 0, weaponPose: 'aimed', right: 'rightGrip', left: 'leftGrip' },
      { t: 0.18, weaponPose: 'reloadRaise', right: 'rightGrip', left: 'magwell' },
      { t: 0.35, left: { body: [0.12, -0.3, 0.26] }, event: 'detachMagazine' },
      { t: 0.68, left: 'beltMagazine', event: 'spawnFreshMagazine' },
      { t: 0.95, left: 'magwell', event: 'insertMagazine' },
      { t: 1.15, left: 'chargingHandle', event: 'grabChargingHandle' },
      { t: 1.28, left: { weaponAnchor: 'chargingHandle', offset: [0, 0, -0.12] }, event: 'pullChargingHandle' },
      { t: 1.38, left: 'leftGrip', weaponPose: 'aimed', event: 'releaseChargingHandle' },
    ],
  };
}

/**
 * One per page. Owns the instanced pool, the anchor/pose data and the GLB template cache.
 *
 * @param {object} o
 * @param {object} o.THREE
 * @param {object} o.scene
 * @param {(url: string) => Promise<{scene: object}>} o.loadGLB   e.g. attachDracoLoader(new GLTFLoader()).loadAsync
 * @param {(id: string) => object} o.getWeapon                    weapons.js def lookup
 * @param {() => Promise<[anchors, poses]>} [o.loadData]           defaults to fetching the two JSON files
 * @param {object|Function} [o.aimBlend]                           AIM_BLEND_DEFAULTS-shaped config or a getter for a live one
 */
export function createWeaponMountSystem({ THREE, scene, loadGLB, getWeapon, loadData = null, aimBlend = AIM_BLEND_DEFAULTS,
  castShadow = false, anchorsUrl = './weapon-anchors.json', posesUrl = './weapon-poses.json', convertMaterial = null }) {
  const S = scratch(THREE);
  const templates = new Map();   // weaponId -> Promise<{ bakedAnchors, instanceParts, bounds, reducedParts }>
  const stowPartsCache = new Map();   // weaponId -> Promise<parts[] | null>, the reduced stow list
  let dataPromise = null;
  let batches = null;
  let frameCounter = 0;
  const stats = { mounts: 0, flushed: 0 };
  const aimCfg = () => (typeof aimBlend === 'function' ? aimBlend() : aimBlend);

  // GLTFLoader hands back classic materials, which cannot hold a TSL node and so cannot carry a heat
  // tag for the thermal visor -- an unconverted gun renders in full lit colour in a heat frame. The
  // page passes a converter (three's own renderer.library.fromMaterial) and it runs once per distinct
  // material at template load, not per instance: the template cache already owns these, and several
  // meshes in one GLB usually share one material.
  const convertedMaterials = new Map();
  function convertPartMaterial(material) {
    if (!convertMaterial || !material) return material;
    const one = (m) => {
      if (!convertedMaterials.has(m)) convertedMaterials.set(m, convertMaterial(m) || m);
      return convertedMaterials.get(m);
    };
    return Array.isArray(material) ? material.map(one) : one(material);
  }

  // Shared with the held gun on purpose: a template first loaded from the stow path would bake
  // empty anchors, and the held path would then find a cached template with no muzzle or grips.
  function stowParts(weaponId) {
    if (!stowPartsCache.has(weaponId)) {
      const def = getWeapon(weaponId);
      if (!def?.model) return Promise.resolve(null);
      stowPartsCache.set(weaponId, data()
        .then(([anchorData]) => templateFor(weaponId, def, anchorData?.[weaponId]?.ikAnchors || {}))
        .then((template) => (template ? buildStowParts(template.instanceParts) : null))
        .catch((error) => { console.warn('[weapon-mount] failed to load stowed weapon', weaponId, error); return null; }));
    }
    return stowPartsCache.get(weaponId);
  }

  function data() {
    if (!dataPromise) {
      dataPromise = (loadData ? loadData() : Promise.all([
        fetch(anchorsUrl, { cache: 'no-store' }).then((r) => r.json()),
        fetch(posesUrl, { cache: 'no-store' }).then((r) => r.json()),
      ])).catch((error) => { dataPromise = null; throw error; });
    }
    return dataPromise;
  }

  function templateFor(weaponId, def, rawAnchors) {
    if (!templates.has(weaponId)) {
      const promise = loadGLB(def.model).then((gltf) => {
        const template = gltf.scene;
        const normalizedMatrix = normalizeWeaponModel(THREE, template);
        const bakedAnchors = bakeWeaponAnchors(THREE, rawAnchors, normalizedMatrix);
        template.updateMatrixWorld(true);
        const instanceParts = [];
        template.traverse((obj) => {
          if (!obj.isMesh) return;
          // Skinned meshes get their never-animated bone pose frozen into static geometry.
          const geometry = obj.isSkinnedMesh ? bakeSkinnedGeometry(THREE, obj) : obj.geometry;
          instanceParts.push({ geometry, material: convertPartMaterial(obj.material), localMatrix: obj.matrixWorld.clone() });
        });
        const bounds = new THREE.Box3().setFromObject(template);
        // Stowed copies (phase 4) use the biggest parts only; ordering by vertex count is free here.
        const reducedParts = [...instanceParts]
          .sort((a, b) => (b.geometry.attributes?.position?.count ?? 0) - (a.geometry.attributes?.position?.count ?? 0))
          .slice(0, Math.max(1, Math.ceil(instanceParts.length * 0.5)));
        return { template, bakedAnchors, instanceParts, bounds, reducedParts };
      }).catch((error) => { templates.delete(weaponId); throw error; });
      templates.set(weaponId, promise);
    }
    return templates.get(weaponId);
  }

  /**
   * Builds a mount for `body` holding `weaponId`. Resolves null when the weapon has no model or
   * no third-person hold. The mount's rig is never scene-added; it renders from the pool.
   */
  async function createMount(body, weaponId) {
    const def = getWeapon(weaponId);
    if (!weaponId || !def?.model || !def.thirdPersonHold) return null;
    const [anchorData, poseData] = await data();
    const rawAnchors = anchorData?.[weaponId]?.ikAnchors || {};
    const reloadSequence = poseData?.reloadSequence?.[weaponId] || defaultReloadSequence(poseData, rawAnchors);
    const { bakedAnchors, instanceParts } = await templateFor(weaponId, def, rawAnchors);
    if (!batches) batches = createWeaponPartBatches({ THREE, scene, castShadow });

    const weaponRig = new THREE.Group();
    const weaponAdjust = new THREE.Group();
    const weaponFrame = new THREE.Group();
    const weaponView = new THREE.Group();
    weaponFrame.rotation.y = Math.PI;
    weaponRig.add(weaponAdjust);
    weaponAdjust.add(weaponFrame);
    weaponFrame.add(weaponView);
    const muzzleAnchor = bakedAnchors.muzzle?.p;
    // Barrel axis: the normalized model's long axis (Z) through the muzzle, not grip -> muzzle.
    // The grips sit under the bore, so that line tilts up and an aligned gun shoots low.
    const boreSign = muzzleAnchor ? Math.sign(muzzleAnchor[2] || 1) : 1;
    const rearAnchor = muzzleAnchor ? [muzzleAnchor[0], muzzleAnchor[1], muzzleAnchor[2] - boreSign * BARREL_REFERENCE_BACK] : null;
    const muzzleMarker = muzzleAnchor ? new THREE.Object3D() : null;
    const barrelReferenceMarker = rearAnchor ? new THREE.Object3D() : null;
    // The trim pivots about the trigger hand so the primary grip never moves; falls back to the bore point.
    const pivotAnchor = bakedAnchors.rightGrip?.p || bakedAnchors.leftGrip?.p || rearAnchor;
    const pivotMarker = pivotAnchor ? new THREE.Object3D() : null;
    if (muzzleMarker) { muzzleMarker.position.fromArray(muzzleAnchor); weaponView.add(muzzleMarker); }
    if (barrelReferenceMarker) { barrelReferenceMarker.position.fromArray(rearAnchor); weaponView.add(barrelReferenceMarker); }
    if (pivotMarker) { pivotMarker.position.fromArray(pivotAnchor); weaponView.add(pivotMarker); }
    for (const node of [weaponFrame, muzzleMarker, barrelReferenceMarker, pivotMarker]) {
      if (node) { node.matrixAutoUpdate = false; node.updateMatrix(); }
    }

    const events = [];
    const controller = createWeaponPoseController({
      THREE,
      body,
      weaponView,
      onEvent: (name, payload) => events.push({ name, payload }),
      getWeaponDef: (id) => id === weaponId ? {
        id,
        recoil: def.recoil ?? 0.6,
        ikAnchors: bakedAnchors,
        weaponPoses: poseData?.weaponPoses || {},
        reloadSequence,
      } : {},
    });
    controller.setWeapon(weaponId);
    stats.mounts++;
    return {
      body, def, weaponId, reloadSequence, instanceParts, bakedAnchors,
      weaponRig, weaponAdjust, weaponView, controller, muzzleMarker, barrelReferenceMarker, pivotMarker,
      placed: false,
      visible: true,
      carryBlend: null,
      carryLocomotion: null,
      aimTrim: new THREE.Quaternion(),
      aimTrimSolvedFrame: -999,
      oneHanded: false,
      events,                 // sequence events since last drain (drainEvents)
    };
  }

  function destroyMount(mount, { releaseArms = true } = {}) {
    if (!mount) return;
    // Geometry and materials belong to the template cache; the rig was never scene-added.
    mount.placed = false;
    if (releaseArms) {
      mount.body?.setArmTarget?.('left', null);
      mount.body?.setArmTarget?.('right', null);
    }
    stats.mounts = Math.max(0, stats.mounts - 1);
  }

  // World-space barrel ray from the rear grip through the muzzle. Scratch: consume before the next call.
  function barrelRay(mount) {
    const rearMarker = mount?.barrelReferenceMarker;
    const muzzleMarker = mount?.muzzleMarker;
    if (!rearMarker?.parent || !muzzleMarker?.parent) return null;
    rearMarker.updateWorldMatrix(true, false);
    muzzleMarker.updateWorldMatrix(true, false);
    const rear = rearMarker.getWorldPosition(S.barrel.rear);
    const muzzle = muzzleMarker.getWorldPosition(S.barrel.origin);
    const direction = S.barrel.direction.copy(muzzle).sub(rear);
    if (direction.lengthSq() < 1e-8) return null;
    direction.normalize();
    const pivotMarker = mount.pivotMarker;
    if (pivotMarker?.parent) { pivotMarker.updateWorldMatrix(true, false); pivotMarker.getWorldPosition(S.barrel.pivot); }
    else S.barrel.pivot.copy(rear);
    return S.barrel;
  }

  // Persistent rate-limited correction that turns the rendered barrel onto targetPoint (null unwinds).
  function stepBarrelTrim(mount, dt, targetPoint) {
    const trim = mount.aimTrim;
    if (targetPoint == null && Math.abs(trim.w) > 0.99999) return false;
    const barrel = barrelRay(mount);
    if (!barrel) return false;
    let fraction;
    if (targetPoint) {
      const wanted = S.wanted.copy(targetPoint).sub(barrel.origin);
      if (wanted.lengthSq() < 1e-8) return false;
      S.trimDesired.setFromUnitVectors(barrel.direction, wanted.normalize());
      if (!Number.isFinite(S.trimDesired.x + S.trimDesired.y + S.trimDesired.z + S.trimDesired.w)) return false;
      fraction = barrelTrimFraction(quatAngleBetween(trim, S.trimDesired), aimCfg(), dt);
    } else {
      S.trimDesired.identity();
      fraction = releaseTrimFraction(quatAngleBetween(trim, S.trimDesired), aimCfg(), dt);
    }
    trim.slerp(S.trimDesired, fraction).normalize();
    const rig = mount.weaponRig;
    rig.position.sub(barrel.pivot).applyQuaternion(trim).add(barrel.pivot);
    rig.quaternion.premultiply(trim).normalize();
    rig.updateWorldMatrix(true, false);
    if (targetPoint) mount.aimTrimSolvedFrame = mount.frameIndex ?? frameCounter;
    return true;
  }

  /**
   * Places the mount for this frame and drives the arms.
   *
   * frame: {
   *   feetY, bodyX, bodyZ,          // body's own feet height and smoothed XZ (motion.bodyPosition)
   *   yaw,                          // visual yaw
   *   stance, stanceWeights,        // 'stand'|'crouch'|'kneel'|'prone'|'run'|'dash', {crouch01, kneel01, prone01}
   *   speed,                        // horizontal m/s
   *   aiming,                       // trains the weapon (aim locomotion)
   *   aimPoint,                     // THREE.Vector3 | null: barrel trim target while aiming
   *   bob, sway, headYaw,           // from body.motion
   *   aimChannels,                  // {torsoPitch, torsoYaw, recoilPitch} | null
   *   viewFrame, viewBlend,         // phase 2: optional world-space {position, quaternion} blended in
   *   drawBlend,                    // phase 4: 0 = holsterHold, 1 = live hold (default 1)
 *   holdOffsetY, holdOffsetZ,     // page trims (m): root height, hold forward/back
 *   reachSolve,                   // true: move the gun so both grips are within arm reach (solveReach)
 *   holdMode, bodyHold,           // 'authored' (default) | 'body': trigger grip placed from the shoulder (BODY_HOLD_DEFAULTS shape)
   * }
   */
  function updateMount(mount, dt, frame) {
    if (!mount) return false;
    frameCounter++;
    mount.frameIndex = frame.frameIndex ?? frameCounter;
    const { weaponRig, weaponAdjust, weaponView, controller, def, body } = mount;
    S.loco.stance = frame.stance ?? STANCE_STAND;
    S.loco.aiming = !!frame.aiming;
    S.loco.moving = (frame.speed ?? 0) > CARRY_MOVING_SPEED;
    const locomotion = locomotionFor(S.loco);
    const carrying = isCarryLocomotion(locomotion) && hasCarryVocabulary(def);
    const carryTarget = carryDeltaFor(def, locomotion, frame.stanceWeights);
    // Snap on the first frame after a swap so the gun never glides in from a stale carry.
    mount.carryBlend = mount.carryLocomotion == null
      ? snapCarryBlend(mount.carryBlend, carryTarget)
      : stepCarryBlend(mount.carryBlend, carryTarget, dt);
    let hold = resolveWeaponHold(def, frame.stanceWeights, mount.carryBlend, S.hold);
    const drawBlend = frame.drawBlend ?? 1;
    if (drawBlend < 1) {
      const h = holsterHoldFor(mount.weaponId, def);
      for (let i = 0; i < 3; i++) {
        hold.position[i] = h.position[i] + (hold.position[i] - h.position[i]) * drawBlend;
        hold.rotation[i] = h.rotation[i] + (hold.rotation[i] - h.rotation[i]) * drawBlend;
      }
    }
    // Ground-anchored, stance-invariant root; bob/sway re-added (not inherited via a joint).
    const gaitW = 1 - Math.max(frame.stanceWeights?.prone01 ?? 0, frame.stanceWeights?.kneel01 ?? 0);
    const sway = (frame.sway ?? 0) * gaitW;
    const yaw = frame.yaw ?? 0;
    const x = frame.bodyX + Math.cos(yaw) * sway;
    const z = frame.bodyZ - Math.sin(yaw) * sway;
    const y = frame.feetY + MOUNT_HEIGHT + (frame.bob ?? 0) * gaitW + (frame.holdOffsetY ?? 0);
    const aimCh = frame.aimChannels || null;
    const rootRotation = S.rootQuat.setFromEuler(
      S.rootEuler.set(aimCh ? aimCh.torsoPitch + (aimCh.recoilPitch ?? 0) : 0, yaw + (aimCh ? 0 : (frame.headYaw ?? 0)), 0, 'YXZ'));
    if (aimCh?.torsoYaw) rootRotation.multiply(S.twistQ.setFromAxisAngle(S.up, aimCh.torsoYaw));
    weaponRig.position.set(x, y, z);
    weaponRig.quaternion.copy(rootRotation);
    weaponAdjust.position.fromArray(hold.position);
    weaponAdjust.position.z += frame.holdOffsetZ ?? 0;   // page-level forward/back trim of the hold
    weaponAdjust.quaternion.copy(S.holdQuat.setFromEuler(S.holdEuler.set(hold.rotation[0], hold.rotation[1], hold.rotation[2], 'XYZ')));
    weaponAdjust.scale.setScalar(hold.scale ?? 1);
    if (frame.holdMode === 'body') placeBodyHold(mount, frame, rootRotation);
    // Phase 2 seam: blend the whole rig toward an authored view frame.
    const viewBlend = frame.viewFrame ? Math.max(0, Math.min(1, frame.viewBlend ?? 0)) : 0;
    if (viewBlend > 0) {
      weaponRig.updateWorldMatrix(false, true);
      weaponView.matrixWorld.decompose(S.viewPos, S.viewQuat, S.viewScale);
      S.viewPos.lerp(frame.viewFrame.position, viewBlend);
      S.viewQuat.slerp(frame.viewFrame.quaternion, viewBlend);
      // Re-express as a rig transform: rig = target * inverse(adjust * frame * viewLocal).
      S.viewTarget.compose(S.viewPos, S.viewQuat, S.viewScale);
      weaponView.updateMatrix();
      S.viewChain.copy(weaponAdjust.matrix).multiply(weaponView.parent.matrix).multiply(weaponView.matrix);
      S.viewTarget.multiply(S.viewChain.invert());
      S.viewTarget.decompose(weaponRig.position, weaponRig.quaternion, S.viewScale);
    }
    // A camera-bound gun (full view blend) is not pulled toward shoulders that bob with the body.
    mount.reachMoved = frame.reachSolve && viewBlend < 0.99 ? solveReach(mount) : false;
    mount.placed = true;
    const isAiming = locomotion === LOCOMOTION_AIM;
    controller.setAiming(isAiming ? 1 : 0);
    const lockAimedPosition = isAiming && controller.getAction() !== 'reload';
    controller.update(dt, lockAimedPosition ? S.lockOpts : S.noOpts);
    // A carry points the weapon away from the target on purpose; never barrel-solve it.
    const solveTarget = !carrying && lockAimedPosition && frame.aimPoint ? frame.aimPoint : null;
    if (stepBarrelTrim(mount, dt, solveTarget)) controller.update(0, S.lockOpts);
    // One-handed dash: support hand off the weapon, tucked at the chest (after the controller).
    const oneHanded = carrying && isOneHanded(locomotion);
    if (oneHanded || mount.oneHanded) {
      const torso = body.joints?.torso;
      if (oneHanded && torso) {
        S.dashRight.set(1, 0, 0).applyQuaternion(torso.quaternion);
        S.dashFwd.set(0, 0, 1).applyQuaternion(torso.quaternion);
        S.dashHand.copy(torso.position).addScaledVector(S.dashFwd, DASH_HAND.fwd).addScaledVector(S.dashRight, -DASH_HAND.side);
        S.dashHand.y += DASH_HAND.up;
        body.setArmTarget('left', { position: S.dashHand, weight: 1 });
      } else if (!oneHanded && frame.releaseSupportHand !== false) {
        body.setArmTarget('left', null);   // callers with their own arm overlays pass false
      }
    }
    mount.oneHanded = oneHanded;
    mount.carryLocomotion = locomotion;
    return true;
  }

  // Body-relative hold (frame.holdMode === 'body'): translate the placed rig so the trigger grip
  // sits at shoulder + aimDir * armLen * dist + right * side + up * up. Rotation stays authored.
  function placeBodyHold(mount, frame, rootRotation) {
    const { body, weaponRig, weaponView, bakedAnchors } = mount;
    const shR = body.joints?.rightShoulder;
    const armLen = body.limbLengths?.armLen;
    const gR = bakedAnchors.rightGrip?.p;
    if (!shR || !(armLen > 0) || !gR) return false;
    const cfg = frame.bodyHold || BODY_HOLD_DEFAULTS;
    const aimW = mount.controller.getDebug().aim || 0;
    const dist = cfg.idle.dist + (cfg.aim.dist - cfg.idle.dist) * aimW;
    const side = cfg.idle.side + (cfg.aim.side - cfg.idle.side) * aimW;
    const up = cfg.idle.up + (cfg.aim.up - cfg.idle.up) * aimW;
    // Axes from the body itself (no mount-frame convention): right = shoulder line, forward = up x right,
    // then forward/up pitched about right by the torso's aim lean so the gun rises with the shoulders.
    const shL = body.joints?.leftShoulder;
    shR.getWorldPosition(S.bhTarget);
    if (shL) { shL.getWorldPosition(S.bhRight); S.bhRight.subVectors(S.bhTarget, S.bhRight); S.bhRight.y = 0; }
    if (!shL || S.bhRight.lengthSq() < 1e-8) S.bhRight.set(1, 0, 0).applyQuaternion(rootRotation);
    S.bhRight.normalize();
    S.bhUp.set(0, 1, 0);
    S.bhFwd.crossVectors(S.bhUp, S.bhRight).normalize();
    // Pitch of the hold: while aiming, the FULL elevation to the aim point (the arms swing so the
    // gun points there and the barrel trim covers only the residual); otherwise the torso lean.
    let lean = frame.aimChannels ? (frame.aimChannels.torsoPitch || 0) : 0;
    if (frame.aimPoint && aimW > 1e-3) {
      const dx = frame.aimPoint.x - S.bhTarget.x, dy = frame.aimPoint.y - S.bhTarget.y, dz = frame.aimPoint.z - S.bhTarget.z;
      const elev = Math.atan2(dy, Math.hypot(dx, dz));
      lean = lean + (elev - lean) * aimW;
    }
    if (lean) {
      S.reachQ.setFromAxisAngle(S.bhRight, lean);   // +lean tilts forward up (rotation about right)
      S.bhFwd.applyQuaternion(S.reachQ);
      S.bhUp.applyQuaternion(S.reachQ);
    }
    S.bhTarget.addScaledVector(S.bhFwd, armLen * dist).addScaledVector(S.bhRight, side).addScaledVector(S.bhUp, up);
    weaponRig.updateWorldMatrix(false, true);
    S.bhGrip.fromArray(gR).applyMatrix4(weaponView.matrixWorld);
    weaponRig.position.add(S.bhTarget.sub(S.bhGrip));
    return true;
  }

  // Two-grip reach solve: the gun must be where BOTH hands can hold it. The trigger hand is the
  // anchor (translate the gun toward its shoulder by any excess), then the gun pivots about that
  // grip by the least angle that brings the support grip onto the support arm's reach sphere.
  // A no-op whenever both grips are already reachable, so authored holds are untouched.
  function solveReach(mount) {
    const { body, weaponRig, weaponView, bakedAnchors } = mount;
    const shR = body.joints?.rightShoulder, shL = body.joints?.leftShoulder;
    const armLen = body.limbLengths?.armLen;
    const gR = bakedAnchors.rightGrip?.p, gL = bakedAnchors.leftGrip?.p;
    if (!shR || !shL || !(armLen > 0) || !gR) return false;
    const reach = armLen * REACH_FRACTION;
    shR.getWorldPosition(S.shoulderR);
    shL.getWorldPosition(S.shoulderL);
    let moved = false;
    for (let iter = 0; iter < REACH_ITERATIONS; iter++) {
      weaponRig.updateWorldMatrix(false, true);
      S.gripR.fromArray(gR).applyMatrix4(weaponView.matrixWorld);
      const dR = S.gripR.distanceTo(S.shoulderR);
      if (dR > reach) {
        S.reachV.subVectors(S.shoulderR, S.gripR).multiplyScalar(1 - reach / dR);
        weaponRig.position.add(S.reachV);
        S.gripR.add(S.reachV);
        moved = true;
      }
      if (!gL) break;
      weaponRig.updateWorldMatrix(false, true);
      S.gripL.fromArray(gL).applyMatrix4(weaponView.matrixWorld);
      const dL = S.gripL.distanceTo(S.shoulderL);
      if (dL <= reach) break;
      // Rotate v = gripL - gripR about gripR toward w = shoulderL - gripR until |gripL - shoulderL| = reach.
      S.reachV.subVectors(S.gripL, S.gripR);
      S.reachW.subVectors(S.shoulderL, S.gripR);
      const a = S.reachV.length(), c = S.reachW.length();
      if (a < 1e-6 || c < 1e-6) break;
      const cosNeeded = Math.max(-1, Math.min(1, (a * a + c * c - reach * reach) / (2 * a * c)));
      const thetaNeeded = Math.acos(cosNeeded);
      const thetaNow = Math.acos(Math.max(-1, Math.min(1, S.reachV.dot(S.reachW) / (a * c))));
      if (thetaNow <= thetaNeeded + 1e-4) break;
      S.reachAxis.crossVectors(S.reachV, S.reachW);
      if (S.reachAxis.lengthSq() < 1e-10) break;
      S.reachQ.setFromAxisAngle(S.reachAxis.normalize(), thetaNow - thetaNeeded);
      weaponRig.position.sub(S.gripR).applyQuaternion(S.reachQ).add(S.gripR);
      weaponRig.quaternion.premultiply(S.reachQ).normalize();
      moved = true;
    }
    if (moved) weaponRig.updateWorldMatrix(false, true);
    return moved;
  }

  function muzzleWorld(mount, out) {
    const marker = mount?.muzzleMarker;
    if (!marker?.parent || !mount.placed) return null;
    marker.updateWorldMatrix(true, false);
    return marker.getWorldPosition(out);
  }

  function barrelDirection(mount, out) {
    const ray = barrelRay(mount);
    return ray ? out.copy(ray.direction) : null;
  }

  function drainEvents(mount) {
    const list = mount.events.splice(0, mount.events.length);
    return list;
  }

  function beginFrame() { batches?.beginFrame(); stats.flushed = 0; }

  // Writes one mount's parts into the pool. The only per-frame walk of the never-scene-added rig.
  function flushMount(mount) {
    if (!batches || !mount?.instanceParts || !mount.placed || !mount.visible) return;
    mount.weaponRig.updateMatrixWorld(true);
    const view = mount.weaponView.matrixWorld;
    for (const part of mount.instanceParts) {
      S.partMatrix.multiplyMatrices(view, part.localMatrix);
      batches.add(part.geometry, part.material, S.partMatrix);
    }
    stats.flushed++;
  }

  function endFrame() { batches?.endFrame(); }

  return {
    stats,
    createMount, destroyMount, updateMount,
    muzzleWorld, barrelDirection, barrelRay, stepBarrelTrim, drainEvents,
    beginFrame, flushMount, endFrame,
    // One set of stowed copies per body. Rebuilt only when the stowed ids actually change; the
    // parts come from the SAME template cache the held gun uses, so both land in one instancing
    // bucket. `flush` runs inside the batches' begin/end frame, like flushMount.
    createStow() {
      let key = '', token = 0;
      let mounts = [];
      return {
        get mounts() { return mounts; },
        get key() { return key; },
        setWeapons(ids) {
          const next = (ids || []).filter(Boolean).join('|');
          if (next === key) return;
          key = next;
          mounts = [];
          const mine = ++token;
          for (const weaponId of next ? next.split('|') : []) {
            void Promise.resolve(stowParts(weaponId)).then((parts) => {
              if (token !== mine || !parts?.length) return;
              const placement = stowPlacementFor(weaponId);
              mounts.push({ weaponId, parts, placement, scale: placement.scale * (getWeapon(weaponId)?.thirdPersonHold?.scale ?? 1) });
            });
          }
        },
        // Rides the torso joint: a body without one (a capsule) has nothing to hang a gun on.
        flush(body, yaw = 0) {
          const torso = body?.joints?.torso;
          if (!batches || !mounts.length || !torso) return 0;
          const S = scratch(THREE);
          S.stowYaw.setFromEuler(S.stowEuler.set(0, yaw, 0, 'YXZ'));
          let drawn = 0;
          for (const stow of mounts) {
            const { position, rotation } = stow.placement;
            S.stowOffset.set(position[0], position[1], position[2]).applyQuaternion(S.stowYaw);
            S.stowPos.copy(torso.position).add(S.stowOffset);
            S.stowLocal.setFromEuler(S.stowEuler.set(rotation[0], rotation[1], rotation[2], 'XYZ'));
            S.stowQuat.copy(S.stowYaw).multiply(S.stowLocal);
            S.stowWorld.compose(S.stowPos, S.stowQuat, S.stowScale.setScalar(stow.scale));
            for (const part of stow.parts) {
              S.stowPart.multiplyMatrices(S.stowWorld, part.localMatrix);
              batches.add(part.geometry, part.material, S.stowPart);
              drawn++;
            }
          }
          return drawn;
        },
        dispose() { mounts = []; key = ''; token++; },
      };
    },
    templateFor: (weaponId) => templates.get(weaponId) || null,
    // Loads (or returns) the template for a weapon with its real anchors, for stowed copies.
    loadTemplate(weaponId) {
      const def = getWeapon(weaponId);
      if (!def?.model) return Promise.resolve(null);
      return data().then(([anchorData]) => templateFor(weaponId, def, anchorData?.[weaponId]?.ikAnchors || {}));
    },
    get batches() { return batches; },
    dispose() { batches?.dispose(); batches = null; templates.clear(); stowPartsCache.clear(); dataPromise = null; },
  };
}
