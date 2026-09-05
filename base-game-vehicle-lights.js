// base-game-vehicle-lights.js — the lights a vehicle's switches turn on, drawn on this page.
// The switches themselves are a bitmask on the vehicle wire (base-game-protocol.mjs); where each
// light sits is the mesh's own `userData.lights` (flight-meshes.js). This module owns the THREE
// objects and follows the page's WebGPU rule: lights are resident and intensity-switched, never
// added, removed or hidden per vehicle, because the visible light set keys the render pipeline and
// changing it recompiles every material. So there is a small pool of light SETS, handed each frame
// to the lit vehicles nearest the eye; a lit vehicle beyond the pool still shows its lens discs.
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { BASE_GAME_VEHICLE_LIGHTS } from './base-game-protocol.mjs';
import { flashlightColor, coneAngleRad, rampToward } from './weapon-light.js';
import { createWeaponLaser } from './weapon-laser.js';

export const VEHICLE_LIGHT_SETS = 2;

// How each switch's light looks. Candela for the cones, the flashlight's own units, so a headlight
// at 260 is a little under the hand torch's 400 but spread over a wider cone.
export const VEHICLE_LIGHT_LOOK = Object.freeze({
  head: Object.freeze({ intensity: 260, range: 45, angleDeg: 28, penumbra: 0.5, warmth: 0.35 }),
  high: Object.freeze({ intensity: 720, range: 110, angleDeg: 17, penumbra: 0.4, warmth: 0.2 }),
  lamp: Object.freeze({ intensity: 24, range: 14, warmth: 0.6 }),
  turretLight: Object.freeze({ intensity: 340, range: 60, angleDeg: 13, penumbra: 0.45, warmth: 0.15 }),
  turretLaser: Object.freeze({ hue: 0, range: 150, beamRadius: 0.005, beamOpacity: 0.55, intensity: 40, dotAngleDeg: 0.35 }),
  lens: Object.freeze({ head: 0xfff1c8, high: 0xffffff, lamp: 0xffe2a8, turretLight: 0xf4fbff, turretLaser: 0xff2a2a }),
  rampRate: 26,
  decay: 2,
});

// What a hull's switches ask for. The mask is already clipped to the hull's switches on the wire,
// so a bit that is set is one the hull has. High beams are the headlight's cone opened up, not a
// second lamp, which is why they come back as which look the one cone should wear.
export function vehicleLightPlan(mask, out = { head: null, lamp: false, turretLight: false, turretLaser: false }) {
  const m = Number.isInteger(mask) ? mask : 0;
  const L = BASE_GAME_VEHICLE_LIGHTS;
  out.head = (m & L.high) ? 'high' : (m & L.head) ? 'head' : null;
  out.lamp = !!(m & L.lamp);
  out.turretLight = !!(m & L.turretLight);
  out.turretLaser = !!(m & L.turretLaser);
  return out;
}

// Which vehicles get a real light set: the lit ones nearest the eye, `count` of them, in order.
// `list` entries are { id, lights, position: [x, y, z] }; anything unlit is not a candidate.
export function rankLitVehicles(list, eye, count) {
  const lit = [];
  for (const v of list ?? []) {
    if (!v || !(v.lights > 0) || !v.position) continue;
    const dx = v.position[0] - eye[0], dy = v.position[1] - eye[1], dz = v.position[2] - eye[2];
    lit.push({ id: v.id, d2: dx * dx + dy * dy + dz * dz });
  }
  lit.sort((a, b) => a.d2 - b.d2);
  return lit.slice(0, Math.max(0, count | 0)).map((x) => x.id);
}

export function createVehicleLights({ THREE, scene, sets = VEHICLE_LIGHT_SETS } = {}) {
  if (!THREE?.SpotLight) throw new TypeError('createVehicleLights needs THREE');
  if (!scene) throw new TypeError('createVehicleLights needs a scene');
  const look = VEHICLE_LIGHT_LOOK;

  function makeSpot(name, cfg) {
    const spot = new THREE.SpotLight(flashlightColor(cfg.warmth), 0, cfg.range, coneAngleRad(cfg.angleDeg), cfg.penumbra, look.decay);
    spot.name = name;
    spot.castShadow = false;
    scene.add(spot, spot.target);
    return spot;
  }
  const pool = [];
  for (let i = 0; i < sets; i++) {
    const lamp = new THREE.PointLight(flashlightColor(look.lamp.warmth), 0, look.lamp.range, look.decay);
    lamp.name = `vehicleLamp${i}`;
    scene.add(lamp);
    pool.push({
      vehicleId: null,
      head: makeSpot(`vehicleHeadlight${i}`, look.head), headLevel: 0, headLook: 'head',
      lamp, lampLevel: 0,
      aux: makeSpot(`vehicleTurretLight${i}`, look.turretLight), auxLevel: 0,
      laser: createWeaponLaser({ THREE, scene, options: { ...look.turretLaser, shadows: false } }),
    });
  }

  const _dir = new THREE.Vector3(), _plusZ = new THREE.Vector3(0, 0, 1), _pos = new THREE.Vector3(), _fwd = new THREE.Vector3();
  // Lens discs: one per switch per vehicle, parented into the mesh so they ride the turret with it.
  // Meshes, not lights, so showing and hiding them is free.
  const lenses = new Map();   // vehicleId -> { [switch]: Mesh }
  const discGeo = new THREE.CircleGeometry(1, 14);
  const discMaterials = {};
  function discMaterial(name) {
    if (!discMaterials[name]) discMaterials[name] = new MeshBasicNodeMaterial({ color: look.lens[name], toneMapped: false, fog: false, side: THREE.DoubleSide });
    return discMaterials[name];
  }
  function lensFor(rec, name) {
    let byName = lenses.get(rec.id);
    if (!byName) { byName = {}; lenses.set(rec.id, byName); }
    if (byName[name]) return byName[name];
    const anchor = rec.mesh.userData.lights?.[name === 'high' ? 'head' : name];
    if (!anchor) return null;
    const parent = anchor.parent ? rec.mesh.userData[anchor.parent] : rec.mesh;
    if (!parent) return null;
    const disc = new THREE.Mesh(discGeo, discMaterial(name));
    disc.name = `vehicleLens:${name}`;
    const r = name === 'lamp' ? 0.035 : name === 'turretLaser' ? 0.012 : name === 'turretLight' ? 0.02 : 0.04;
    disc.scale.setScalar(r);
    disc.position.set(anchor.pos[0], anchor.pos[1], anchor.pos[2]);
    // A disc faces +Z; the anchors point down the nose, -Z, with a little dip. Face it that way.
    _dir.set(anchor.dir?.[0] ?? 0, anchor.dir?.[1] ?? 0, anchor.dir?.[2] ?? -1).normalize();
    disc.quaternion.setFromUnitVectors(_plusZ, _dir);
    disc.visible = false;
    parent.add(disc);
    byName[name] = disc;
    return disc;
  }

  const _plan = { head: null, lamp: false, turretLight: false, turretLaser: false };
  const _muzzle = [0, 0, 0], _direction = [0, 0, -1], _source = { muzzle: _muzzle, direction: _direction };
  const _rank = [];

  // World placement of an anchor: position and direction through the group it hangs off, so a
  // turret light points where the gun points and a headlight follows the hull over a bump.
  function placeAnchor(rec, name, outPos, outDir) {
    const anchor = rec.mesh.userData.lights?.[name];
    if (!anchor) return false;
    const parent = anchor.parent ? rec.mesh.userData[anchor.parent] : rec.mesh;
    if (!parent) return false;
    outPos.set(anchor.pos[0], anchor.pos[1], anchor.pos[2]);
    parent.localToWorld(outPos);
    outDir.set(anchor.dir?.[0] ?? 0, anchor.dir?.[1] ?? 0, anchor.dir?.[2] ?? -1).normalize().transformDirection(parent.matrixWorld);
    return true;
  }
  function aimSpot(spot, pos, dir, range) {
    spot.position.copy(pos);
    spot.target.position.copy(pos).addScaledVector(dir, Math.max(1, range));
    spot.target.updateMatrixWorld();
  }
  function dressSpot(spot, cfg) {
    if (spot.userData.look === cfg) return;
    spot.userData.look = cfg;
    spot.color.setHex(flashlightColor(cfg.warmth));
    spot.distance = cfg.range; spot.angle = coneAngleRad(cfg.angleDeg); spot.penumbra = cfg.penumbra;
  }

  // `vehicles` is the view's record map: { id, kind, mesh, latest: { lights, p } }. `eye` is the
  // render-local camera position the pool is ranked from.
  function update(dt, vehicles, eye) {
    _rank.length = 0;
    for (const rec of vehicles.values()) {
      if (!rec.mesh?.userData?.lights || !rec.mesh.visible) continue;
      const mask = rec.latest?.lights ?? 0;
      vehicleLightPlan(mask, _plan);
      for (const name of ['head', 'lamp', 'turretLight', 'turretLaser']) {
        const disc = lensFor(rec, name === 'head' && _plan.head === 'high' ? 'high' : name);
        if (!disc) continue;
        const want = name === 'head' ? !!_plan.head : !!_plan[name];
        if (disc.visible !== want) disc.visible = want;
      }
      // High beams and dipped share one anchor; keep only the disc for the look in force.
      const byName = lenses.get(rec.id);
      if (byName?.high && byName?.head) { byName.high.visible = _plan.head === 'high'; byName.head.visible = _plan.head === 'head'; }
      if (mask > 0) _rank.push({ id: rec.id, lights: mask, position: [rec.mesh.position.x, rec.mesh.position.y, rec.mesh.position.z] });
    }
    for (const [id] of lenses) if (!vehicles.has(id)) lenses.delete(id);   // the mesh took the discs with it

    const winners = rankLitVehicles(_rank, [eye.x, eye.y, eye.z], pool.length);
    // Keep a set on the vehicle it already lights when that vehicle is still a winner, so the pool
    // does not shuffle two beams between two hulls every time their distances cross.
    const taken = new Set();
    for (const set of pool) if (set.vehicleId && winners.includes(set.vehicleId)) taken.add(set.vehicleId); else set.vehicleId = null;
    for (const set of pool) {
      if (set.vehicleId) continue;
      const next = winners.find((id) => !taken.has(id));
      if (next) { set.vehicleId = next; taken.add(next); set.headLevel = 0; set.lampLevel = 0; set.auxLevel = 0; }
    }

    for (const set of pool) {
      const rec = set.vehicleId ? vehicles.get(set.vehicleId) : null;
      vehicleLightPlan(rec?.latest?.lights ?? 0, _plan);
      if (rec) rec.mesh.updateMatrixWorld(true);
      // Headlight, in whichever cone is switched in.
      const headCfg = _plan.head === 'high' ? look.high : look.head;
      dressSpot(set.head, headCfg);
      if (rec && _plan.head && placeAnchor(rec, 'head', _pos, _fwd)) aimSpot(set.head, _pos, _fwd, headCfg.range);
      set.headLevel = rampToward(set.headLevel, rec && _plan.head ? 1 : 0, dt, look.rampRate);
      set.head.intensity = headCfg.intensity * set.headLevel;
      // Work lamp.
      if (rec && _plan.lamp && placeAnchor(rec, 'lamp', _pos, _fwd)) set.lamp.position.copy(_pos);
      set.lampLevel = rampToward(set.lampLevel, rec && _plan.lamp ? 1 : 0, dt, look.rampRate);
      set.lamp.intensity = look.lamp.intensity * set.lampLevel;
      // Turret light.
      dressSpot(set.aux, look.turretLight);
      if (rec && _plan.turretLight && placeAnchor(rec, 'turretLight', _pos, _fwd)) aimSpot(set.aux, _pos, _fwd, look.turretLight.range);
      set.auxLevel = rampToward(set.auxLevel, rec && _plan.turretLight ? 1 : 0, dt, look.rampRate);
      set.aux.intensity = look.turretLight.intensity * set.auxLevel;
      // Turret laser: the weapon laser, mounted on the module beside the optic.
      const laserOn = !!(rec && _plan.turretLaser && placeAnchor(rec, 'turretLaser', _pos, _fwd));
      set.laser.setOn(laserOn);
      if (laserOn) { _muzzle[0] = _pos.x; _muzzle[1] = _pos.y; _muzzle[2] = _pos.z; _direction[0] = _fwd.x; _direction[1] = _fwd.y; _direction[2] = _fwd.z; }
      set.laser.update(dt, laserOn ? _source : null);
    }
  }

  function dispose() {
    for (const set of pool) {
      scene.remove(set.head, set.head.target, set.aux, set.aux.target, set.lamp);
      set.head.dispose?.(); set.aux.dispose?.(); set.lamp.dispose?.();
      set.laser.dispose();
    }
    pool.length = 0;
    discGeo.dispose();
    for (const m of Object.values(discMaterials)) m.dispose();
    lenses.clear();
  }

  return { update, dispose, pool, get sets() { return pool.length; } };
}
