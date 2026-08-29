// base-game-drone-view.js — how the player's drones look on this page: the flight sim's craft
// meshes (flight-meshes.js) posed from the wire state the way bot-viewer-v3 poses them, interpolated
// through base-game-remote-players.js's track, plus the held-overhead mesh and the chase camera.
// Render-local placement only; every input position is global.
import * as THREE from 'three';
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { buildCraftMesh } from './flight-meshes.js';
import { createRemoteTrack } from './base-game-remote-players.js';
import { BASE_GAME_DRONE_DEFS, quatFromHeading } from './base-game-drones.js';
import { sanitizeBaseGameDroneState } from './base-game-protocol.mjs';

// Node materials, as the flight sim uses.
const CRAFT_MATERIALS = {
  standard: (color, emissive = 0x000000) => new MeshStandardNodeMaterial({ color, emissive, roughness: 0.55, metalness: 0.25 }),
  basic: (color, opacity = 1) => new MeshBasicNodeMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
};
export const CRAFT_TINT = 0xc9d4e2;   // the flight sim's own craft
// Chase camera: the flight sim's chase branch, in wingspans of the craft actually drawn. The sim
// hand-authors `chaseDist` per airframe against a mesh it never scales; a hard-coded distance here
// went stale the moment the UAV's meshScale changed, which is what put the wing 43% further from the
// lens than the sim puts its plane. `spans` is measured off the sim: plane 26 m / 11.5 m span = 2.26.
// up and ahead stay the sim's fractions of that distance (0.26 and 1.6).
const CHASE = {
  quad: { spans: 2.45, ref: 0 },    // the quad's own framing, kept as flown
  uav: { spans: 2.26, ref: 105 },   // the plane's framing in the sim, applied to the recon's 2.01 m span
};
const CHASE_UP = 0.26, CHASE_AHEAD = 1.6;
const _box = new THREE.Box3(), _size = new THREE.Vector3();
const _camUp = new THREE.Vector3();

export function createBaseGameDroneView({ scene, worldCoordinates, tintFor = () => 0x8ea2b8 } = {}) {
  const drones = new Map();     // id -> { id, kind, owner, mesh, track, bank, state, mode, target, hp, latest }
  const held = new Map();       // playerId -> { kind, mesh }
  const _local = [0, 0, 0];
  const _sample = { position: [0, 0, 0], yaw: 0, pitch: 0 };
  const _vec = new THREE.Vector3(), _look = new THREE.Vector3();
  const camPos = new THREE.Vector3(), camAim = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  let camReady = false;

  function buildMesh(kind, tint) {
    const def = BASE_GAME_DRONE_DEFS[kind];
    const g = buildCraftMesh(def.mesh, tint, CRAFT_MATERIALS);
    g.scale.setScalar(def.meshScale);
    g.frustumCulled = false;
    g.updateMatrixWorld(true);
    _box.setFromObject(g).getSize(_size);
    g.userData.span = Math.max(_size.x, _size.z);   // as drawn, so meshScale cannot desync the camera
    scene.add(g);
    return g;
  }
  function disposeMesh(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.traverse((o) => { o.geometry?.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
  }

  // One list of wire states at one server time: the snapshot online, the local stepper solo.
  function ingest(list, serverTime) {
    const seen = new Set();
    for (const raw of list ?? []) {
      const s = sanitizeBaseGameDroneState(raw);
      if (!s) continue;
      seen.add(s.id);
      let rec = drones.get(s.id);
      if (!rec) {
        rec = { id: s.id, kind: s.kind, owner: s.owner, mesh: buildMesh(s.kind, tintFor(s.owner)), track: createRemoteTrack(), bank: 0, latest: null };
        drones.set(s.id, rec);
      }
      rec.latest = s; rec.state = s.state; rec.mode = s.mode; rec.target = s.target; rec.hp = s.hp;
      rec.track.push(serverTime, { position: s.p, velocity: s.v, yaw: s.yaw, pitch: s.pitch, grounded: false, spawnRevision: 0 });
    }
    for (const [id, rec] of drones) if (!seen.has(id)) { disposeMesh(rec.mesh); drones.delete(id); }
  }

  // Pose every drone for a render time, with the SAME quaternion the physics builds from yaw, pitch
  // and bank (quatFromHeading). The first version used v3's lookAt + rotateY(PI) + rotateZ(bank);
  // the flip reverses the local Z that rotateZ turns about, so the craft rolled the mirror of the
  // physics and the chase camera's horizon banked against the stick.
  function update(renderTime, dt, { interpolationDelayMs = 100 } = {}) {
    const t = renderTime - interpolationDelayMs;
    for (const rec of drones.values()) {
      const s = rec.track.sample(t, {}, _sample);
      if (!s) { rec.mesh.visible = false; continue; }
      rec.mesh.visible = true;
      worldCoordinates.toRenderLocal(s.position, _local);
      rec.mesh.position.set(_local[0], _local[1], _local[2]);
      if (rec.latest?.q) {
        // The physics attitude itself, slerped so the 20 Hz snapshots do not step; solo sends it every frame.
        _q.fromArray(rec.latest.q);
        if (rec.hadQ) rec.mesh.quaternion.slerp(_q, Math.min(1, dt * 24)); else rec.mesh.quaternion.copy(_q);
        rec.hadQ = true;
        rec.bank = rec.latest.bank;
      } else {
        rec.hadQ = false;
        rec.bank += ((rec.latest?.bank ?? 0) - rec.bank) * Math.min(1, dt * 6);
        quatFromHeading(rec.mesh.quaternion, s.yaw, s.pitch, rec.bank);
      }
      const rotors = rec.mesh.userData.rotors;
      if (rotors) for (const blade of rotors) blade.rotation.y += 42 * dt;
      if (rec.mesh.userData.propeller) rec.mesh.userData.propeller.rotation.z += 55 * dt;
    }
  }

  // The drone in the hands before it is thrown. `at` is the render-local point between the hands
  // (or, with `fallback`, a head point the craft floats above); the nose follows the body's facing.
  function showHeld(playerId, kind, at, yaw, fallback = false) {
    let h = held.get(playerId);
    if (h && h.kind !== kind) { disposeMesh(h.mesh); held.delete(playerId); h = null; }
    if (!kind) { if (h) { disposeMesh(h.mesh); held.delete(playerId); } return; }
    if (!h) { h = { kind, mesh: buildMesh(kind, tintFor(playerId)) }; held.set(playerId, h); }
    h.mesh.visible = true;
    h.mesh.position.set(at[0], at[1] + (fallback ? 0.42 : 0.05), at[2]);
    h.mesh.rotation.set(0, yaw, 0);   // craft nose is -Z, the body's forward at yaw 0 is -Z
    const rotors = h.mesh.userData.rotors;
    if (rotors) for (const blade of rotors) blade.rotation.y += 0.4;   // a held quad idles its rotors
  }
  function hideHeld(playerId) { const h = held.get(playerId); if (h) { disposeMesh(h.mesh); held.delete(playerId); } }

  // Chase camera behind the drone (flight-sim updateCamera, chase branch, in render-local space).
  function placeCamera(camera, id, dt) {
    const rec = drones.get(id);
    if (!rec || !rec.mesh.visible) { camReady = false; return false; }
    // The flight sim's chase branch, line for line: back grows with airspeed, the up offset is the
    // craft's own up (so the screen banks with it), the aim leads the nose, the lens opens with speed.
    const c = CHASE[rec.kind] ?? CHASE.quad;
    const s = rec.latest;
    const dist = (rec.mesh.userData.span || 1) * c.spans;
    const speed = Math.hypot(s.v[0], s.v[1], s.v[2]);
    _vec.set(0, 0, -1).applyQuaternion(rec.mesh.quaternion);                    // nose, from the drawn attitude
    _camUp.set(0, 1, 0).applyQuaternion(rec.mesh.quaternion);                   // its up, so the camera can go inverted with it
    const back = dist * (1 + Math.min(0.5, speed / 400));
    const desired = _look.copy(rec.mesh.position).addScaledVector(_vec, -back).addScaledVector(_camUp, dist * CHASE_UP);
    if (!camReady) { camPos.copy(desired); camAim.copy(rec.mesh.position); camReady = true; }
    const lag = 1 - Math.exp(-dt * 6.5);
    camPos.lerp(desired, lag);
    camAim.lerp(_look.copy(rec.mesh.position).addScaledVector(_vec, dist * CHASE_AHEAD), lag * 1.4);
    camera.position.copy(camPos);
    camera.up.copy(_camUp);
    camera.lookAt(camAim);
    camera.fov = 58 + Math.min(14, speed / (c.ref + 20) * 6);
    camera.updateProjectionMatrix();
    return true;
  }
  function resetCamera() { camReady = false; }

  function ownedBy(playerId, kind = null) {
    let best = null;
    for (const rec of drones.values()) if (rec.owner === playerId && (!kind || rec.kind === kind)) best = rec;
    return best;
  }

  function dispose() {
    for (const rec of drones.values()) disposeMesh(rec.mesh);
    for (const h of held.values()) disposeMesh(h.mesh);
    drones.clear(); held.clear();
  }

  return { drones, ingest, update, showHeld, hideHeld, placeCamera, resetCamera, ownedBy, dispose };
}
