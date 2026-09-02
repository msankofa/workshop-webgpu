// Presentation-only view of the pure authoritative hurt rig. It never reads render meshes to
// invent hit bounds; every line and radius comes from the shared semantic profile.

import { HUMANOID_HIT_PRIMITIVES, HUMANOID_JOINT_INDEX } from './humanoid-rig-topology.js';
import { playerPosePoint } from './player-body-pose.js';

const ZONE_COLORS = Object.freeze({
  head: 0xff4d4d, neck: 0xff8a4d, torso: 0x49d7ff, pelvis: 0x5f8cff,
  upperArm: 0xffd84d, lowerArm: 0xffa84d, hand: 0xff6f91,
  thigh: 0x71e46f, calf: 0x45bf76, foot: 0x9be34d,
});

export function createPlayerHitRigDebug({ THREE, scene, worldCoordinates } = {}) {
  if (!THREE || !scene?.add || !worldCoordinates?.toRenderLocal) throw new TypeError('hit-rig debug requires THREE, scene and world coordinates');
  const group = new THREE.Group();
  group.name = 'player-hit-rig-debug';
  group.visible = false;
  scene.add(group);

  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  const sphereGeometry = new THREE.SphereGeometry(1, 8, 5);
  const neutralMaterial = new THREE.MeshBasicMaterial({ color: 0x78f5ff, wireframe: true, depthTest: false, transparent: true, opacity: 0.8 });
  const zoneMaterials = new Map(Object.entries(ZONE_COLORS).map(([zone, color]) => [zone,
    new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false, transparent: true, opacity: 0.85 })]));
  const primitives = HUMANOID_HIT_PRIMITIVES.map(spec => {
    const material = zoneMaterials.get(spec.zone) || neutralMaterial;
    const cylinder = new THREE.Mesh(cylinderGeometry, material);
    const endA = new THREE.Mesh(sphereGeometry, material);
    const endB = new THREE.Mesh(sphereGeometry, material);
    cylinder.renderOrder = endA.renderOrder = endB.renderOrder = 1000;
    group.add(cylinder, endA, endB);
    return { spec, cylinder, endA, endB };
  });
  const jointGeometry = new THREE.SphereGeometry(0.025, 6, 4);
  const jointMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const jointMeshes = Object.keys(HUMANOID_JOINT_INDEX).map(() => {
    const mesh = new THREE.Mesh(jointGeometry, jointMaterial);
    mesh.renderOrder = 1001;
    group.add(mesh);
    return mesh;
  });
  const hitMaterial = new THREE.MeshBasicMaterial({ color: 0xff1744, wireframe: true, depthTest: false });
  const hitMarker = new THREE.Mesh(sphereGeometry, hitMaterial);
  hitMarker.scale.setScalar(0.12);
  hitMarker.visible = false;
  hitMarker.renderOrder = 1002;
  hitMarker.name = 'player-hit-marker';
  scene.add(hitMarker);

  const a = [0, 0, 0], b = [0, 0, 0], la = [0, 0, 0], lb = [0, 0, 0];
  const up = new THREE.Vector3(0, 1, 0), delta = new THREE.Vector3();
  const midpoint = new THREE.Vector3(), quat = new THREE.Quaternion();
  let lastHitGlobal = null;

  function update(pose, { visible = false, zoneColors = true, joints = false, lastHit = true } = {}) {
    group.visible = !!visible;
    if (visible && pose?.joints) {
      for (const record of primitives) {
        playerPosePoint(pose, HUMANOID_JOINT_INDEX[record.spec.a], a);
        playerPosePoint(pose, HUMANOID_JOINT_INDEX[record.spec.b], b);
        worldCoordinates.toRenderLocal(a, la); worldCoordinates.toRenderLocal(b, lb);
        const material = zoneColors ? (zoneMaterials.get(record.spec.zone) || neutralMaterial) : neutralMaterial;
        record.cylinder.material = record.endA.material = record.endB.material = material;
        record.endA.position.fromArray(la); record.endB.position.fromArray(lb);
        record.endA.scale.setScalar(record.spec.radius); record.endB.scale.setScalar(record.spec.radius);
        delta.set(lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]);
        const length = delta.length();
        record.cylinder.visible = length > 1e-5;
        if (length > 1e-5) {
          midpoint.set((la[0] + lb[0]) * 0.5, (la[1] + lb[1]) * 0.5, (la[2] + lb[2]) * 0.5);
          quat.setFromUnitVectors(up, delta.multiplyScalar(1 / length));
          record.cylinder.position.copy(midpoint); record.cylinder.quaternion.copy(quat);
          record.cylinder.scale.set(record.spec.radius, length, record.spec.radius);
        }
      }
      for (const [name, index] of Object.entries(HUMANOID_JOINT_INDEX)) {
        playerPosePoint(pose, index, a); worldCoordinates.toRenderLocal(a, la);
        jointMeshes[index].position.fromArray(la); jointMeshes[index].visible = !!joints;
      }
    }
    hitMarker.visible = !!lastHit && !!lastHitGlobal;
    if (hitMarker.visible) { worldCoordinates.toRenderLocal(lastHitGlobal, la); hitMarker.position.fromArray(la); }
  }

  return {
    group,
    update,
    setLastHit(point) { lastHitGlobal = point?.length >= 3 ? [point[0], point[1], point[2]] : null; },
    clearLastHit() { lastHitGlobal = null; hitMarker.visible = false; },
    get diagnostics() { return { profile: 'humanoid-default', profileVersion: 1, primitiveCount: primitives.length, jointCount: jointMeshes.length }; },
    dispose() {
      group.removeFromParent(); hitMarker.removeFromParent();
      cylinderGeometry.dispose(); sphereGeometry.dispose(); jointGeometry.dispose();
      neutralMaterial.dispose(); jointMaterial.dispose(); hitMaterial.dispose();
      for (const material of zoneMaterials.values()) material.dispose();
    },
  };
}
