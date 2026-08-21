import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { createTraversalLabCollider } from './traversal-lab-collider.js';

export function createBaseGameTraversalLab({ scene, worldQuery }) {
  if (!scene?.add) throw new TypeError('Traversal Lab requires a Three.js scene');
  if (!worldQuery?.registerProvider) throw new TypeError('Traversal Lab requires a world-query service');

  // Collision is baked by the shared renderer-free module; this file only dresses those same
  // meshes with materials and debug helpers, so display and server collision cannot diverge.
  const lab = createTraversalLabCollider();
  const { layout, root, meshes, collider, provider } = lab;
  const materials = [];
  for (const mesh of meshes) {
    const spec = layout.materials[mesh.userData.materialName];
    const material = new MeshStandardNodeMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    mesh.material = material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    materials.push(material);
  }

  const originAxes = new THREE.AxesHelper(5);
  originAxes.name = 'traversal-lab-origin-axes';
  root.add(originAxes);
  scene.add(root);
  const unregisterProvider = worldQuery.registerProvider(provider);

  const wireGeometry = new THREE.WireframeGeometry(collider.geometry);
  const wireMaterial = new THREE.LineBasicMaterial({
    color: 0xff3bd5,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
  });
  const collisionWire = new THREE.LineSegments(wireGeometry, wireMaterial);
  collisionWire.name = 'traversal-lab-collision-wire';
  collisionWire.renderOrder = 50;
  collisionWire.visible = false;
  root.add(collisionWire);

  let disposed = false;
  function setVisible(visible) {
    const value = !!visible;
    root.visible = value;
    provider.enabled = value;
    if (!value) collisionWire.visible = false;
  }

  return {
    root,
    layout,
    collider,
    provider,
    stats: lab.stats,
    setVisible,
    setCollisionDebug(visible) {
      collisionWire.visible = root.visible && !!visible;
    },
    setOriginMarkerVisible(visible) {
      originAxes.visible = !!visible;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unregisterProvider();
      root.removeFromParent();
      collisionWire.geometry.dispose();
      collisionWire.material.dispose();
      originAxes.geometry.dispose();
      originAxes.material.dispose();
      lab.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
