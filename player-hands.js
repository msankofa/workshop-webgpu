// player-hands.js — first-person orb-hand viewmodel.
//
// In FPS mode the local player's capsule is not drawn, so their own two orb hands
// have to be a camera-attached viewmodel rather than part of the GhostRenderer ghost.
// The group is added as a child of the camera, so the orbs live in camera-local space
// and follow head look automatically. update() adds an idle bob plus a fore/aft walk-
// sway scaled by horizontal speed (matching the remote orbs in GhostRenderer).
//
// THREE is passed in (not statically imported) so this stays importable from plain
// Node for tests, same pattern as GhostRenderer.

const ORB_R = 0.12;
const BASE_X = 0.4, BASE_Y = -0.32, BASE_Z = -0.7; // camera-local rest offsets (-Z = forward)
const BOB_HZ = 1.1, BOB_AMP = 0.006;
const SWAY_HZ = 2.2, SWAY_MAX = 0.12, SWAY_PER_SPEED = 0.06;

export function createViewHands(camera, THREE) {
  const geo = new THREE.SphereGeometry(1, 10, 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.7 });
  const group = new THREE.Group();
  const left = new THREE.Mesh(geo, mat);
  const right = new THREE.Mesh(geo, mat);
  left.scale.set(ORB_R, ORB_R, ORB_R);
  right.scale.set(ORB_R, ORB_R, ORB_R);
  left.position.set(-BASE_X, BASE_Y, BASE_Z);
  right.position.set(BASE_X, BASE_Y, BASE_Z);
  group.add(left);
  group.add(right);
  group.visible = false; // hidden until FPS mode
  camera.add(group);

  let t = 0;

  return {
    // hsl in 0..1, from playerTintHSL(localId), so hands match your own ghost.
    setTint(hsl) { mat.color.setHSL(hsl[0], hsl[1], hsl[2]); },
    setVisible(v) { group.visible = !!v; },
    update(dt, { speed = 0 } = {}) {
      t += dt;
      const bob = Math.sin(2 * Math.PI * BOB_HZ * t) * BOB_AMP;
      const swayAmp = Math.min(SWAY_MAX, speed * SWAY_PER_SPEED);
      const sway = Math.sin(2 * Math.PI * SWAY_HZ * t) * swayAmp;
      left.position.set(-BASE_X, BASE_Y + bob, BASE_Z + sway);
      right.position.set(BASE_X, BASE_Y - bob, BASE_Z - sway);
    },
    destroy() {
      camera.remove(group);
      geo.dispose();
      mat.dispose();
    },
  };
}
