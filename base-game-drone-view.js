// base-game-drone-view.js — how the player's drones look on this page: the flight sim's craft
// meshes (flight-meshes.js) posed from the wire state the way bot-viewer-v3 poses them, interpolated
// through base-game-remote-players.js's track, plus the held-overhead mesh and the chase camera.
// Render-local placement only; every input position is global.
import * as THREE from 'three';
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { buildCraftMesh } from './flight-meshes.js';
import { createRemoteTrack } from './base-game-remote-players.js';
import { BASE_GAME_DRONE_DEFS, quatFromHeading } from './base-game-drones.js';
import { BASE_GAME_VEHICLE_DEFS } from './base-game-vehicles.js';
import { sanitizeBaseGameDroneState, sanitizeBaseGameVehicleState } from './base-game-protocol.mjs';

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
  sentinel: { spans: 2.26, ref: 105 },   // never at the stick; kept so a spectator camera can frame it the same way
  ugv: { spans: 3.1, ref: 7 },
  buggy: { spans: 2.5, ref: 24 },
};
const CRAFT_DEFS = Object.freeze({ ...BASE_GAME_DRONE_DEFS, ...BASE_GAME_VEHICLE_DEFS });
const isVehicleKind = kind => !!BASE_GAME_VEHICLE_DEFS[kind];
const CHASE_UP = 0.26, CHASE_AHEAD = 1.6;
const shortestAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _box = new THREE.Box3(), _size = new THREE.Vector3();
const _camUp = new THREE.Vector3();

export function createBaseGameDroneView({ scene, worldCoordinates, tintFor = () => 0x8ea2b8, cameraObstruction = null } = {}) {
  const drones = new Map();     // id -> { id, kind, owner, mesh, track, bank, state, mode, target, hp, latest }
  const held = new Map();       // playerId -> { kind, mesh }
  const _local = [0, 0, 0];
  const _sample = { position: [0, 0, 0], yaw: 0, pitch: 0 };
  const _vec = new THREE.Vector3(), _look = new THREE.Vector3();
  const camPos = new THREE.Vector3(), camAim = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _lookQ = new THREE.Quaternion(), _right = new THREE.Vector3(), _upAxis = new THREE.Vector3();   // free-look scratch
  let camReady = false;

  function buildMesh(kind, tint) {
    const def = CRAFT_DEFS[kind];
    const g = buildCraftMesh(def.mesh, tint, CRAFT_MATERIALS, isVehicleKind(kind) ? def : undefined);
    g.scale.setScalar(def.meshScale);
    g.frustumCulled = false;
    g.updateMatrixWorld(true);
    _box.setFromObject(g).getSize(_size);
    g.userData.span = Math.max(_size.x, _size.z);   // as drawn, so meshScale cannot desync the camera
    g.name = `craft-view:${kind}`;
    scene.add(g);
    return g;
  }
  function disposeMesh(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.traverse((o) => { o.geometry?.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
  }

  // One list of wire states at one server time: the snapshot online, the local stepper solo.
  function pushState(s, serverTime, seen) {
      if (!s || !CRAFT_DEFS[s.kind]) return;
      seen.add(s.id);
      let rec = drones.get(s.id);
      if (!rec) {
        // A vehicle wears its own colour: an aircraft's pale sky skin reads as white plastic on a
        // hull in a forest. The owner tint still applies to anything without one, so team colours
        // can land later without moving this.
        const tint = CRAFT_DEFS[s.kind]?.tint ?? tintFor(s.owner);
        rec = { id: s.id, kind: s.kind, owner: s.owner, mesh: buildMesh(s.kind, tint), track: createRemoteTrack(), bank: 0, latest: null };
        drones.set(s.id, rec);
      }
      rec.latest = s; rec.state = s.state; rec.mode = s.mode; rec.target = s.target; rec.hp = s.hp;
      rec.track.push(serverTime, { position: s.p, velocity: s.v, yaw: s.yaw, pitch: s.pitch, grounded: false, spawnRevision: 0 });
  }
  function ingest(list, serverTime) {
    const seen = new Set();
    for (const raw of list ?? []) {
      const s = isVehicleKind(raw?.kind) ? sanitizeBaseGameVehicleState(raw) : sanitizeBaseGameDroneState(raw);
      pushState(s, serverTime, seen);
    }
    for (const [id, rec] of drones) if (!seen.has(id)) { disposeMesh(rec.mesh); drones.delete(id); }
  }

  // Solo records already live in this page. Read them directly instead of constructing wire
  // arrays and running protocol sanitizers into fresh objects every render frame.
  function ingestRecords(records, serverTime) {
    const seen = new Set();
    for (const raw of records ?? []) {
      if (raw?.body) {
        pushState({ id: raw.id, kind: raw.kind, owner: raw.ownerId, team: raw.team, driver: raw.driver,
          p: [raw.body.x, raw.y, raw.body.z], v: [raw.body.vx, raw.airV, raw.body.vz],
          yaw: raw.body.yaw, pitch: raw.pitch, roll: raw.roll, steer: raw.body.steering,
          turretYaw: raw.def?.turret ? raw.turretYaw : null, turretPitch: raw.def?.turret ? raw.turretPitch : null,
          hp: raw.hp, mode: raw.mode, state: raw.state, target: raw.target }, serverTime, seen);
      } else if (raw?.d) {
        pushState({ id: raw.id, kind: raw.kind, owner: raw.ownerId, team: raw.team,
          p: raw.d.p, v: raw.d.v, yaw: raw.d.yaw, pitch: raw.d.pitch, bank: -raw.d.bank,   // record bank is bot-drones' cosmetic sign, see droneWireState
          q: raw.flyer ? [raw.flyer.q.x, raw.flyer.q.y, raw.flyer.q.z, raw.flyer.q.w] : null,
          hp: raw.d.hp, mode: raw.mode, state: raw.state, target: raw.target }, serverTime, seen);
      }
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
        rec.bank += (((rec.latest?.roll ?? rec.latest?.bank) ?? 0) - rec.bank) * Math.min(1, dt * 6);
        // A drone's wire `bank` is already converted for quatFromHeading. A vehicle's `roll` is the
        // raw physics sign from fitVehicleGround, which is positive with the RIGHT side DOWN, while
        // quatFromHeading's bank turns about the nose by the right-hand rule and lifts the right
        // side for positive. Handing one to the other drew every slope inverted: on a 25% hillside
        // the uphill wheels sank in and the downhill pair hung 0.19 m clear.
        const bank = isVehicleKind(rec.kind) ? -rec.bank : rec.bank;
        quatFromHeading(rec.mesh.quaternion, s.yaw, s.pitch, bank);
      }
      const rotors = rec.mesh.userData.rotors;
      if (rotors) for (const blade of rotors) blade.rotation.y += 42 * dt;
      if (rec.mesh.userData.propeller) rec.mesh.userData.propeller.rotation.z += 55 * dt;
      // The weapon station, trained by the server. Eased rather than snapped: the wire arrives at
      // 20 Hz online, and the slew itself is already rate-limited in the simulation.
      const turret = rec.mesh.userData.turret;
      if (turret && Number.isFinite(rec.latest?.turretYaw)) {
        const ease = Math.min(1, dt * 14);
        turret.rotation.y += shortestAngle(rec.latest.turretYaw - turret.rotation.y) * ease;
        const elevation = rec.mesh.userData.elevation;
        // Mesh nose is -Z, so a positive elevation is a positive rotation about the trunnion's X.
        if (elevation) elevation.rotation.x += ((rec.latest.turretPitch ?? 0) - elevation.rotation.x) * ease;
      }
      const wheels = rec.mesh.userData.wheels;
      if (wheels) {
        const speed = rec.latest?.v ? Math.hypot(rec.latest.v[0], rec.latest.v[2]) : 0;
        for (const wheel of wheels) {
          wheel.spin.rotation.x += speed * dt / Math.max(0.05, wheel.radius);
          // `body.steering` is already negative for a right turn (the road model yaws negative to
          // the right), and a positive rotation.y swings the mesh's -Z nose toward -X, its left.
          // Negating here made both, so the wheels pointed away from the turn.
          wheel.pivot.rotation.y = wheel.front ? (rec.latest?.steer ?? 0) : 0;
        }
      }
    }
  }

  // The drone in the hands before it is thrown. `at` is the render-local point between the hands
  // (or, with `fallback`, a head point the craft floats above); the nose follows the body's facing.
  function showHeld(playerId, kind, at, yaw, fallback = false) {
    let byKind = held.get(playerId);
    if (!byKind) { byKind = new Map(); held.set(playerId, byKind); }
    for (const cached of byKind.values()) cached.mesh.visible = false;
    if (!kind) return;
    let h = byKind.get(kind);
    if (!h) { h = { kind, mesh: buildMesh(kind, tintFor(playerId)) }; byKind.set(kind, h); }
    h.mesh.visible = true;
    h.mesh.position.set(at[0], at[1] + (fallback ? 0.42 : 0.05), at[2]);
    h.mesh.rotation.set(0, yaw, 0);   // craft nose is -Z, the body's forward at yaw 0 is -Z
    const rotors = h.mesh.userData.rotors;
    if (rotors) for (const blade of rotors) blade.rotation.y += 0.4;   // a held quad idles its rotors
  }
  function hideHeld(playerId) { const byKind = held.get(playerId); if (byKind) for (const h of byKind.values()) h.mesh.visible = false; }

  // Chase camera behind the drone (flight-sim updateCamera, chase branch, in render-local space).
  // `aimDir`, when given, swings the boom behind where the operator is LOOKING rather than behind
  // the craft's own nose, and levels the horizon. That is what a ground station wants: the hull
  // drives one way while the gun and the camera go another.
  // `look` = { yaw, pitch }, the free-look offset: it swings the boom around the craft while the
  // craft keeps flying its heading. Applied to the direction the camera sits along, in the craft's
  // own frame, so it rides the roll with everything else rather than fighting it.
  function placeCamera(camera, id, dt, { zoom = 1, aimDir = null, look = null } = {}) {
    const rec = drones.get(id);
    if (!rec || !rec.mesh.visible) { camReady = false; return false; }
    // The flight sim's chase branch, line for line: back grows with airspeed, the up offset is the
    // craft's own up (so the screen banks with it), the aim leads the nose, the lens opens with speed.
    const c = CHASE[rec.kind] ?? CHASE.quad;
    const s = rec.latest;
    const dist = (rec.mesh.userData.span || 1) * c.spans * (Number(zoom) > 0 ? zoom : 1);   // the player's shift-wheel boom, in the craft's own spans
    const speed = Math.hypot(s.v[0], s.v[1], s.v[2]);
    if (aimDir) {
      _vec.set(aimDir[0], aimDir[1], aimDir[2]).normalize();
      _camUp.set(0, 1, 0);
    } else {
      _vec.set(0, 0, -1).applyQuaternion(rec.mesh.quaternion);                  // nose, from the drawn attitude
      _camUp.set(0, 1, 0).applyQuaternion(rec.mesh.quaternion);                 // its up, so the camera can go inverted with it
      if (look && (look.yaw || look.pitch)) {
        // Yaw about the craft's up, then pitch about its right: the boom orbits the craft and the
        // aim below follows it, so what you see is what the camera is pointed at.
        _lookQ.setFromAxisAngle(_camUp, look.yaw);
        _vec.applyQuaternion(_lookQ);
        _right.crossVectors(_vec, _camUp).normalize();
        _lookQ.setFromAxisAngle(_right, look.pitch);
        _vec.applyQuaternion(_lookQ);
      }
    }
    const back = dist * (1 + Math.min(0.5, speed / 400));
    const desired = _look.copy(rec.mesh.position).addScaledVector(_vec, -back).addScaledVector(_camUp, dist * CHASE_UP);
    if (isVehicleKind(rec.kind) && cameraObstruction) {
      const clear = cameraObstruction(rec.mesh.position, desired, 0.25);
      const wanted = desired.distanceTo(rec.mesh.position);
      if (wanted > 1e-6 && clear < wanted) desired.lerpVectors(rec.mesh.position, desired, clear / wanted);
    }
    if (!camReady) { camPos.copy(desired); camAim.copy(rec.mesh.position); camReady = true; }
    const lag = 1 - Math.exp(-dt * 6.5);
    camPos.lerp(desired, lag);
    if (isVehicleKind(rec.kind) && cameraObstruction) {
      const clear = cameraObstruction(rec.mesh.position, camPos, 0.25);
      const wanted = camPos.distanceTo(rec.mesh.position);
      if (wanted > 1e-6 && clear < wanted) camPos.lerpVectors(rec.mesh.position, camPos, clear / wanted);
    }
    camAim.lerp(_look.copy(rec.mesh.position).addScaledVector(_vec, dist * CHASE_AHEAD), lag * 1.4);
    camera.position.copy(camPos);
    camera.up.copy(_camUp);
    camera.lookAt(camAim);
    camera.fov = 58 + Math.min(14, speed / (c.ref + 20) * 6);
    camera.updateProjectionMatrix();
    return true;
  }
  // First person on the craft: the sim's cockpit branch. The eye sits forward and above the model
  // origin in the craft's own frame, and the camera takes its whole attitude, so the horizon rolls.
  const _eye = new THREE.Vector3();
  function placeCockpitCamera(camera, id, { fov = 72, look = null } = {}) {
    const rec = drones.get(id);
    if (!rec || !rec.mesh.visible) return false;
    const span = rec.mesh.userData.span || 1;
    _eye.set(0, span * 0.02 + 0.25, -span * 0.16).applyQuaternion(rec.mesh.quaternion);
    camera.position.copy(rec.mesh.position).add(_eye);
    camera.quaternion.copy(rec.mesh.quaternion);
    // Free look here is turning your head, so it is a rotation in the craft's own frame rather than
    // a boom swing: the aircraft holds its attitude and the view turns inside it.
    if (look && (look.yaw || look.pitch)) {
      _lookQ.setFromAxisAngle(_upAxis.set(0, 1, 0), look.yaw);
      camera.quaternion.multiply(_lookQ);
      _lookQ.setFromAxisAngle(_upAxis.set(1, 0, 0), look.pitch);
      camera.quaternion.multiply(_lookQ);
    }
    camera.up.set(0, 1, 0).applyQuaternion(rec.mesh.quaternion);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    return true;
  }

  // What a head-up display needs about a craft, in render-local space (the space the camera is in):
  // where it is, where its nose points, which way is up, and how fast it is going.
  function craftFrame(id, out = { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], velocity: [0, 0, 0], kind: null, agm: null, hp: 0, turretAmmo: null }) {
    const rec = drones.get(id);
    if (!rec || !rec.mesh.visible) return null;
    const s = rec.latest;
    out.position[0] = rec.mesh.position.x; out.position[1] = rec.mesh.position.y; out.position[2] = rec.mesh.position.z;
    _vec.set(0, 0, -1).applyQuaternion(rec.mesh.quaternion);
    out.forward[0] = _vec.x; out.forward[1] = _vec.y; out.forward[2] = _vec.z;
    _vec.set(0, 1, 0).applyQuaternion(rec.mesh.quaternion);
    out.up[0] = _vec.x; out.up[1] = _vec.y; out.up[2] = _vec.z;
    out.velocity[0] = s.v[0]; out.velocity[1] = s.v[1]; out.velocity[2] = s.v[2];
    out.kind = rec.kind; out.agm = s.agm ?? null; out.hp = s.hp ?? 0; out.turretAmmo = s.turretAmmo ?? null;
    return out;
  }

  // The sensor's eye: under the belly, so the airframe is out of frame and the ground fills it.
  function sensorEye(id, out = new THREE.Vector3()) {
    const rec = drones.get(id);
    if (!rec || !rec.mesh.visible) return null;
    const span = rec.mesh.userData.span || 1;
    return out.copy(rec.mesh.position).addScaledVector(_camUp.set(0, 1, 0).applyQuaternion(rec.mesh.quaternion), -span * 0.05 - 0.4);
  }

  function resetCamera() { camReady = false; }

  // With no kind named, the last craft the player owns; a held gadget's kind is asked for first.
  function ownedBy(playerId, kind = null) {
    let best = null;
    for (const rec of drones.values()) {
      if (rec.owner !== playerId) continue;
      if (kind && rec.kind !== kind) continue;
      best = rec;
    }
    return best;
  }

  function dispose() {
    for (const rec of drones.values()) disposeMesh(rec.mesh);
    for (const byKind of held.values()) for (const h of byKind.values()) disposeMesh(h.mesh);
    drones.clear(); held.clear();
  }

  return { drones, ingest, ingestRecords, update, showHeld, hideHeld, placeCamera, placeCockpitCamera, craftFrame, sensorEye, resetCamera, ownedBy, dispose };
}
