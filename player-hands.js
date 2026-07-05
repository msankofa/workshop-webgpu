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
// Light-gun reactions: hands raise/draw in while charging, then kick on fire.
const CHARGE_RAISE = 0.14, CHARGE_PULL = 0.06, CHARGE_INSET = 0.12;
const RECOIL_DUR = 0.18, RECOIL_BACK = 0.18, RECOIL_UP = 0.06;

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
  let recoilT = 0; // seconds left in the current recoil kick

  return {
    // hsl in 0..1, from playerTintHSL(localId), so hands match your own ghost.
    setTint(hsl) { mat.color.setHSL(hsl[0], hsl[1], hsl[2]); },
    setVisible(v) { group.visible = !!v; },
    // Fire a quick recoil kick (call when the light gun shoots / places).
    recoil() { recoilT = RECOIL_DUR; },
    // charge: light-gun charge ratio 0..1 (0 when not charging).
    update(dt, { speed = 0, charge = 0 } = {}) {
      t += dt;
      if (recoilT > 0) recoilT = Math.max(0, recoilT - dt);
      const c = Math.max(0, Math.min(1, charge));
      const rk = recoilT / RECOIL_DUR; // 1 -> 0 ease-out over the kick
      const bob = Math.sin(2 * Math.PI * BOB_HZ * t) * BOB_AMP;
      const swayAmp = Math.min(SWAY_MAX, speed * SWAY_PER_SPEED);
      const sway = Math.sin(2 * Math.PI * SWAY_HZ * t) * swayAmp;
      // Charge draws the hands up and inward; recoil kicks them back (+Z) and up.
      const x = BASE_X - c * CHARGE_INSET;
      const y = BASE_Y + c * CHARGE_RAISE + rk * RECOIL_UP;
      const z = BASE_Z + c * CHARGE_PULL + rk * RECOIL_BACK;
      left.position.set(-x, y + bob, z + sway);
      right.position.set(x, y - bob, z - sway);
    },
    destroy() {
      camera.remove(group);
      geo.dispose();
      mat.dispose();
    },
  };
}
