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
// Reload: orb-hands glide to the sequence-resolved targets (camera-local) at constant speed,
// matching the third-person hand glide (weapon-pose-controller handGlideSpeed). RELOAD_EASE is the
// per-second rate the reload blend fades the hands in/out of sequence control vs. the idle pose.
const RELOAD_GLIDE_SPEED = 3.5, RELOAD_EASE = 9;
// Fraction of the weapon's run/gun bob the hands inherit, so they track the gun without
// looking rigidly welded to it.
const HAND_BOB_FOLLOW = 0.85;

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
  // Reload hand-glide state (camera-local). reloadPos chases the resolved targets at constant speed;
  // reloadW eases 0..1 so hands blend into/out of sequence control without snapping off the grip.
  let reloadTargetL = null, reloadTargetR = null;
  const reloadPosL = new THREE.Vector3(), reloadPosR = new THREE.Vector3();
  let reloadInit = false, reloadW = 0;
  function chaseToward(cur, tgt, dt) {
    const dx = tgt[0] - cur.x, dy = tgt[1] - cur.y, dz = tgt[2] - cur.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = RELOAD_GLIDE_SPEED * dt;
    if (dist <= step || dist < 1e-6) { cur.set(tgt[0], tgt[1], tgt[2]); }
    else { const f = step / dist; cur.set(cur.x + dx * f, cur.y + dy * f, cur.z + dz * f); }
  }

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
    // reload: { active, left:[x,y,z]|null, right:[x,y,z]|null } camera-local hand targets from the
    //   weapon viewmodel's reload sequence, or null/absent when not reloading.
    // bob: { x, y, z } camera-local run/gun bob translation from the weapon viewmodel, so the
    //   hands ride along with the gun instead of detaching from it (inherited at HAND_BOB_FOLLOW).
    update(dt, { speed = 0, charge = 0, reload = null, bob: viewBob = null } = {}) {
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
      const bx = viewBob ? viewBob.x * HAND_BOB_FOLLOW : 0;
      const by = viewBob ? viewBob.y * HAND_BOB_FOLLOW : 0;
      const bz = viewBob ? viewBob.z * HAND_BOB_FOLLOW : 0;
      const idleL = [lx + bx, ly + bob + by, lz + sway * 0.65 + bz];
      const idleR = [rx + bx, ry - bob + by, rz - sway + bz];

      // Reload: blend the idle pose toward the sequence-resolved targets. reloadW eases the hands in
      // and out; reloadPos chases each target at constant speed so the hand sweeps between waypoints.
      reloadTargetL = reload && reload.active ? reload.left : null;
      reloadTargetR = reload && reload.active ? reload.right : null;
      const reloadActive = !!(reloadTargetL || reloadTargetR);
      reloadW += ((reloadActive ? 1 : 0) - reloadW) * Math.min(1, RELOAD_EASE * dt);
      if (reloadActive && !reloadInit) { reloadPosL.set(...idleL); reloadPosR.set(...idleR); reloadInit = true; }
      if (!reloadActive && reloadW < 1e-3) reloadInit = false;
      if (reloadInit) {
        chaseToward(reloadPosL, reloadTargetL || idleL, dt);
        chaseToward(reloadPosR, reloadTargetR || idleR, dt);
      }
      if (reloadW > 1e-3) {
        left.position.set(idleL[0] + (reloadPosL.x - idleL[0]) * reloadW, idleL[1] + (reloadPosL.y - idleL[1]) * reloadW, idleL[2] + (reloadPosL.z - idleL[2]) * reloadW);
        right.position.set(idleR[0] + (reloadPosR.x - idleR[0]) * reloadW, idleR[1] + (reloadPosR.y - idleR[1]) * reloadW, idleR[2] + (reloadPosR.z - idleR[2]) * reloadW);
      } else {
        left.position.set(...idleL);
        right.position.set(...idleR);
      }
    },
    destroy() {
      camera.remove(group);
      geo.dispose();
      mat.dispose();
    },
  };
}