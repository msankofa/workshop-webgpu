import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { dampAlpha } from './bot-camera-control.js';

const _local = [0, 0, 0];

function clampPitch(value) {
  return Math.max(-Math.PI * 0.47, Math.min(Math.PI * 0.47, value));
}

function finiteVec3(value) {
  return value && value.length >= 3 && value.slice(0, 3).every(Number.isFinite);
}

export function createBaseGamePlayerView({
  scene,
  camera,
  worldQuery,
  worldCoordinates,
  radius = 0.35,
  height = 1.8,
} = {}) {
  if (!scene?.add || !camera?.position) throw new TypeError('player view requires a Three.js scene and camera');
  if (!worldQuery?.raycast || !worldCoordinates?.toRenderLocal) {
    throw new TypeError('player view requires world-query and world-coordinate services');
  }

  const geometry = new THREE.CapsuleGeometry(radius, height - radius * 2, 5, 10);
  const material = new MeshStandardNodeMaterial({
    color: 0x65d9ff,
    roughness: 0.58,
    metalness: 0.05,
    transparent: true,
    opacity: 0.72,
  });
  const capsuleMesh = new THREE.Mesh(geometry, material);
  capsuleMesh.name = 'base-game-diagnostic-player-capsule';
  capsuleMesh.castShadow = true;
  capsuleMesh.receiveShadow = true;
  scene.add(capsuleMesh);

  let yaw = 0;
  let pitch = -0.12;
  let smoothingReady = false;
  let boomDistance = 5;
  const smoothedFocus = new THREE.Vector3();
  const smoothedCamera = new THREE.Vector3();
  const desiredFocus = new THREE.Vector3();
  const desiredCamera = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const rayDirection = new THREE.Vector3();

  function setLook(nextYaw, nextPitch) {
    if (Number.isFinite(nextYaw)) yaw = nextYaw;
    if (Number.isFinite(nextPitch)) pitch = clampPitch(nextPitch);
  }

  function addLook(deltaYaw, deltaPitch) {
    setLook(yaw + deltaYaw, pitch + deltaPitch);
  }

  function resetSmoothing() {
    smoothingReady = false;
  }

  function syncCapsule(globalFootPosition, { visible = true, grounded = false } = {}) {
    worldCoordinates.toRenderLocal(globalFootPosition, _local);
    capsuleMesh.position.set(_local[0], _local[1] + height * 0.5, _local[2]);
    capsuleMesh.rotation.y = yaw;
    capsuleMesh.visible = !!visible;
    material.color.setHex(grounded ? 0x65d9ff : 0xffb85c);
  }

  function obstructionDistance(origin, target, padding) {
    rayDirection.subVectors(target, origin);
    const distance = rayDirection.length();
    if (distance <= 1e-6) return 0;
    rayDirection.multiplyScalar(1 / distance);
    const hit = worldQuery.raycast({
      origin: origin.toArray(),
      direction: rayDirection.toArray(),
      maxDistance: distance,
    });
    return hit ? Math.max(0.12, hit.distance - padding) : distance;
  }

  function updateCamera(dt, globalFootPosition, {
    mode = 'thirdPerson',
    distance = 5,
    eyeHeight = 1.62,
    focusHeight = 1.28,
    followRate = 14,
    obstructionPadding = 0.22,
  } = {}) {
    const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
    desiredFocus.set(globalFootPosition[0], globalFootPosition[1], globalFootPosition[2]);
    desiredFocus.y += mode === 'firstPerson' ? eyeHeight : focusHeight;
    const focusAlpha = dampAlpha(safeDt, followRate);

    const initializeCamera = !smoothingReady || smoothedFocus.distanceToSquared(desiredFocus) > 100;
    if (initializeCamera) {
      smoothedFocus.copy(desiredFocus);
      smoothedCamera.copy(desiredFocus);
      boomDistance = distance;
      smoothingReady = true;
    } else {
      smoothedFocus.lerp(desiredFocus, focusAlpha);
    }

    if (mode === 'firstPerson') {
      if (initializeCamera) smoothedCamera.copy(smoothedFocus);
      else smoothedCamera.lerp(smoothedFocus, dampAlpha(safeDt, followRate * 1.35));
      worldCoordinates.toRenderLocal(smoothedCamera.toArray(), _local);
      camera.position.fromArray(_local);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      capsuleMesh.visible = false;
      return { obstructed: false, boomDistance: 0 };
    }

    const cp = Math.cos(pitch);
    forward.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    desiredCamera.copy(smoothedFocus).addScaledVector(forward, -Math.max(0.5, distance));
    const clearDistance = obstructionDistance(smoothedFocus, desiredCamera, obstructionPadding);
    const obstructed = clearDistance + 1e-4 < distance;
    if (clearDistance < boomDistance) boomDistance = clearDistance;
    else boomDistance += (Math.max(0.5, distance) - boomDistance) * dampAlpha(safeDt, 4);
    desiredCamera.copy(smoothedFocus).addScaledVector(forward, -boomDistance);
    if (initializeCamera) smoothedCamera.copy(desiredCamera);
    else smoothedCamera.lerp(desiredCamera, dampAlpha(safeDt, followRate));

    // Damping must never place the camera through a wall. Clamp the smoothed result as a second,
    // camera-only query; body collision and camera obstruction remain distinct systems.
    const smoothedClear = obstructionDistance(smoothedFocus, smoothedCamera, obstructionPadding);
    rayDirection.subVectors(smoothedCamera, smoothedFocus);
    const smoothedDistance = rayDirection.length();
    if (smoothedDistance > 1e-6 && smoothedClear < smoothedDistance) {
      smoothedCamera.copy(smoothedFocus).addScaledVector(rayDirection, smoothedClear / smoothedDistance);
    }

    worldCoordinates.toRenderLocal(smoothedCamera.toArray(), _local);
    camera.position.fromArray(_local);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    return { obstructed, boomDistance };
  }

  return {
    capsuleMesh,
    syncCapsule,
    updateCamera,
    setLook,
    addLook,
    resetSmoothing,
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    captureState() { return { yaw, pitch, boomDistance }; },
    applyState(state) {
      if (!state || typeof state !== 'object') return false;
      setLook(state.yaw, state.pitch);
      if (Number.isFinite(state.boomDistance)) boomDistance = Math.max(0, state.boomDistance);
      resetSmoothing();
      return true;
    },
    dispose() {
      capsuleMesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

export { clampPitch as clampBaseGamePlayerPitch, finiteVec3 as isFiniteBaseGameVec3 };
