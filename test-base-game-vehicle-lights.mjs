// Node tests for the vehicle light pool: the pure plan and ranking, then the pool itself over real
// meshes with a real THREE scene (no renderer: lights and discs are plain objects until drawn).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { BASE_GAME_VEHICLE_LIGHTS as L } from './base-game-protocol.mjs';
import { BASE_GAME_VEHICLE_DEFS } from './base-game-vehicles.js';
import { buildCraftMesh } from './flight-meshes.js';
import { vehicleLightPlan, rankLitVehicles, createVehicleLights, VEHICLE_LIGHT_LOOK } from './base-game-vehicle-lights.js';

{
  const p = vehicleLightPlan(L.head | L.lamp);
  assert.equal(p.head, 'head'); assert.equal(p.lamp, true); assert.equal(p.turretLight, false);
  assert.equal(vehicleLightPlan(L.head | L.high).head, 'high', 'high beams take over the one cone');
  assert.equal(vehicleLightPlan(L.high).head, 'high', 'high alone still lights the cone');
  assert.equal(vehicleLightPlan(0).head, null);
  assert.equal(vehicleLightPlan('x').lamp, false, 'garbage reads as all off');
}
{
  const list = [
    { id: 'far', lights: L.head, position: [40, 0, 0] },
    { id: 'dark', lights: 0, position: [1, 0, 0] },
    { id: 'near', lights: L.lamp, position: [5, 0, 0] },
    { id: 'mid', lights: L.head, position: [12, 0, 0] },
  ];
  assert.deepEqual(rankLitVehicles(list, [0, 0, 0], 2), ['near', 'mid'], 'the two nearest lit vehicles win; an unlit one nearer than both does not');
  assert.deepEqual(rankLitVehicles(list, [0, 0, 0], 0), []);
}

const MATERIALS = {
  standard: (color, emissive = 0x000000) => new MeshStandardNodeMaterial({ color, emissive }),
  basic: (color, opacity = 1) => new MeshBasicNodeMaterial({ color, transparent: opacity < 1, opacity }),
};
function fakeVehicle(kind, at, lights) {
  const def = BASE_GAME_VEHICLE_DEFS[kind];
  const mesh = buildCraftMesh(def.mesh, 0x8ea2b8, MATERIALS, def);
  mesh.position.set(at[0], at[1], at[2]);
  mesh.updateMatrixWorld(true);
  return { id: `${kind}@${at.join(',')}`, kind, mesh, latest: { lights } };
}
{
  const scene = new THREE.Scene();
  const before = scene.children.length;
  const lights = createVehicleLights({ THREE, scene, sets: 2 });
  const added = scene.children.length - before;
  assert.ok(added > 0, 'the pool is resident from construction');
  const ugv = fakeVehicle('ugv', [0, 0, 0], L.head | L.turretLight | L.turretLaser);
  const buggyNear = fakeVehicle('buggy', [6, 0, 0], L.high);
  const buggyFar = fakeVehicle('buggy', [60, 0, 0], L.head | L.lamp);
  const vehicles = new Map([[ugv.id, ugv], [buggyNear.id, buggyNear], [buggyFar.id, buggyFar]]);
  const eye = new THREE.Vector3(0, 2, 5);
  for (let i = 0; i < 60; i++) lights.update(1 / 60, vehicles, eye);
  assert.equal(scene.children.length - before, added, 'a frame adds nothing to the scene: no light is created per vehicle');

  const holders = lights.pool.map((s) => s.vehicleId);
  assert.ok(holders.includes(ugv.id) && holders.includes(buggyNear.id) && !holders.includes(buggyFar.id), `the two nearest lit vehicles hold the sets (${holders})`);
  const ugvSet = lights.pool.find((s) => s.vehicleId === ugv.id);
  assert.ok(ugvSet.head.intensity > VEHICLE_LIGHT_LOOK.head.intensity * 0.9, 'the UGV headlight has ramped up');
  assert.ok(ugvSet.aux.intensity > VEHICLE_LIGHT_LOOK.turretLight.intensity * 0.9, 'and its turret light');
  assert.equal(ugvSet.lamp.intensity, 0, 'its lamp is off');
  assert.ok(ugvSet.laser.on && ugvSet.laser.level > 0.9, 'and its turret laser is lit');
  // The UGV nose is -Z at yaw 0, so the headlight target lies down -Z from the anchor and ahead of the front axle.
  assert.ok(ugvSet.head.position.z < -BASE_GAME_VEHICLE_DEFS.ugv.wheelbase / 2, 'the headlight sits ahead of the front axle');
  assert.ok(ugvSet.head.target.position.z < ugvSet.head.position.z - 10, 'and points down the nose');
  const nearSet = lights.pool.find((s) => s.vehicleId === buggyNear.id);
  assert.equal(nearSet.head.distance, VEHICLE_LIGHT_LOOK.high.range, 'high beams dress the cone with the long look');
  assert.ok(nearSet.head.intensity > VEHICLE_LIGHT_LOOK.high.intensity * 0.9);

  // Lens discs: every lit switch on every lit vehicle shows one, pool or no pool.
  const discs = (m) => { const out = []; m.traverse((o) => { if (o.name?.startsWith('vehicleLens:') && o.visible) out.push(o.name.slice(12)); }); return out.sort(); };
  assert.deepEqual(discs(ugv.mesh), ['head', 'turretLaser', 'turretLight']);
  assert.deepEqual(discs(buggyNear.mesh), ['high']);
  assert.deepEqual(discs(buggyFar.mesh), ['head', 'lamp'], 'a vehicle beyond the pool still shows its lenses');
  let turretDisc = null; ugv.mesh.traverse((o) => { if (o.name === 'vehicleLens:turretLight') turretDisc = o; });
  assert.equal(turretDisc.parent, ugv.mesh.userData.elevation, 'the turret light disc rides the elevation cradle');

  // Switch the near buggy off: its set frees and goes to the far one; its disc hides.
  buggyNear.latest.lights = 0;
  for (let i = 0; i < 60; i++) lights.update(1 / 60, vehicles, eye);
  assert.deepEqual(discs(buggyNear.mesh), []);
  assert.ok(lights.pool.some((s) => s.vehicleId === buggyFar.id), 'the freed set moves to the next lit vehicle');
  assert.ok(lights.pool.find((s) => s.vehicleId === ugv.id), 'while the UGV keeps its own');
  // Everything off ramps every light to zero.
  for (const v of vehicles.values()) v.latest.lights = 0;
  for (let i = 0; i < 120; i++) lights.update(1 / 60, vehicles, eye);
  for (const s of lights.pool) assert.ok(s.head.intensity === 0 && s.lamp.intensity === 0 && s.aux.intensity === 0 && s.laser.level === 0, 'dark');
  lights.dispose();
}
console.log('base-game-vehicle-lights: all assertions passed');
