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

const LIGHT_TOOL_ID = 'light';
const HAND_R = 0.048;
const BOB_HZ = 1.1, BOB_AMP = 0.004;
const SWAY_HZ = 2.2, SWAY_MAX = 0.045, SWAY_PER_SPEED = 0.018;
// Light-gun reactions: hands raise/draw in while charging, then kick on fire.
const CHARGE_RAISE = 0.08, CHARGE_PULL = 0.035, CHARGE_INSET = 0.055;
const RECOIL_DUR = 0.18, RECOIL_BACK = 0.075, RECOIL_UP = 0.025;

const POSES = {
  light: {
    left: [-0.22, -0.46, -0.78],
    right: [0.22, -0.46, -0.78],
    radius: HAND_R,
  },
  m1911: {
    left: [0.14, -0.54, -0.66],
    right: [0.38, -0.52, -0.52],
    radius: HAND_R,
  },
  m24: {
    left: [0.10, -0.51, -0.80],
    right: [0.40, -0.53, -0.58],
    radius: HAND_R,
  },
};

function poseFor(tool) {
  return POSES[tool] || POSES.m1911;
}

export function createViewHands(camera, THREE) {
  const geo = new THREE.SphereGeometry(1, 10, 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.7 });
  const group = new THREE.Group();
  const left = new THREE.Mesh(geo, mat);
  const right = new THREE.Mesh(geo, mat);
  group.add(left);
  group.add(right);
  group.visible = false; // hidden until FPS mode
  camera.add(group);

  let t = 0;
  let recoilT = 0; // seconds left in the current recoil kick
  let tool = LIGHT_TOOL_ID;

  function applyScale(pose) {
    const r = pose.radius ?? HAND_R;
    left.scale.set(r, r, r);
    right.scale.set(r, r, r);
  }
  applyScale(POSES.light);
  left.position.set(...POSES.light.left);
  right.position.set(...POSES.light.right);

  return {
    // hsl in 0..1, from playerTintHSL(localId), so hands match your own ghost.
    setTint(hsl) { mat.color.setHSL(hsl[0], hsl[1], hsl[2]); },
    setVisible(v) { group.visible = !!v; },
    setTool(toolId) { tool = toolId || LIGHT_TOOL_ID; applyScale(poseFor(tool)); },
    // Fire a quick recoil kick (call when the selected tool shoots / places).
    recoil() { recoilT = RECOIL_DUR; },
    // charge: light-gun charge ratio 0..1 (0 when not charging).
    update(dt, { speed = 0, charge = 0 } = {}) {
      t += dt;
      if (recoilT > 0) recoilT = Math.max(0, recoilT - dt);
      const isLight = tool === LIGHT_TOOL_ID;
      const c = isLight ? Math.max(0, Math.min(1, charge)) : 0;
      const rk = recoilT / RECOIL_DUR; // 1 -> 0 ease-out over the kick
      const bob = Math.sin(2 * Math.PI * BOB_HZ * t) * BOB_AMP;
      const swayAmp = Math.min(SWAY_MAX, speed * SWAY_PER_SPEED);
      const sway = Math.sin(2 * Math.PI * SWAY_HZ * t) * swayAmp;
      const pose = poseFor(tool);
      const lx = pose.left[0] + c * CHARGE_INSET * 0.45;
      const rx = pose.right[0] - c * CHARGE_INSET;
      const ly = pose.left[1] + c * CHARGE_RAISE + rk * RECOIL_UP;
      const ry = pose.right[1] + c * CHARGE_RAISE + rk * RECOIL_UP;
      const lz = pose.left[2] + c * CHARGE_PULL + rk * RECOIL_BACK;
      const rz = pose.right[2] + c * CHARGE_PULL + rk * RECOIL_BACK;
      left.position.set(lx, ly + bob, lz + sway * 0.65);
      right.position.set(rx, ry - bob, rz - sway);
    },
    destroy() {
      camera.remove(group);
      geo.dispose();
      mat.dispose();
    },
  };
}