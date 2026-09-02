// Node tests for the renderer-free Base Game ground-vehicle simulation.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeRoadVehicle, stepRoadVehicle } from './city-vehicle-model.js';
import {
  VEHICLE_UGV, VEHICLE_BUGGY, BASE_GAME_VEHICLE_DEFS,
  createBaseGameVehicle, fitVehicleGround, stepBaseGameVehicle, stepVehicleSeat,
  createSeatedController,
  sendVehicleTo, recallVehicle, takeOverVehicle, releaseVehicle,
  damageBaseGameVehicle, vehicleWireState, vehicleSeatState, restoreVehicleSeatState,
  sanitizeBaseGameVehicleState, sanitizeBaseGameVehicleSeatState,
  vehicleBasis, turretPivotWorld, aimVehicleTurret, turretDirWorld, fireVehicleTurret,
} from './base-game-vehicles.js';
import { createBaseGamePrediction } from './base-game-prediction.js';
import { getWeapon } from './weapons.js';
import { BASE_GAME_WEAPON_IDS } from './base-game-protocol.mjs';

const DT = 1 / 120;
const flat = () => 0;
const owner = { pos: [0, 0, 0], yaw: 0 };
const world = (groundY = flat, over = {}) => ({ ownerPos: owner.pos, ownerYaw: owner.yaw, ownerAlive: true, groundY, seaLevel: -100, ...over });
const run = (rec, seconds, w = world(), input = null) => {
  let out;
  for (let i = 0; i < Math.round(seconds / DT); i++) out = input ? stepVehicleSeat(rec, input, DT, w) : stepBaseGameVehicle(rec, DT, w);
  return out;
};

// Three points reproduce an analytic plane's slopes at any heading.
{
  const body = makeRoadVehicle({ x: 7, z: -3, yaw: 0, def: BASE_GAME_VEHICLE_DEFS.ugv });
  const plane = (x, z) => 2 + 0.2 * x + 0.35 * z;
  const fit = fitVehicleGround(body, BASE_GAME_VEHICLE_DEFS.ugv, plane);
  const front = plane(7, -3 + 0.55), left = plane(7 - 0.4, -3 - 0.55), right = plane(7 + 0.4, -3 - 0.55);
  assert.ok(Math.abs(fit.y - (front + left + right) / 3) < 1e-12);
  assert.ok(Math.abs(fit.pitch - Math.atan(0.35)) < 1e-12);
  assert.ok(Math.abs(fit.roll - Math.atan(-0.2)) < 1e-12);
}

// Grade is a force, not a speed rule: the same engine climbs below its force limit and rolls
// backward above it.
{
  const def = { mass: 500, engineForce: 500 * 9.81 * 0.35, powerLimit: 1e9, rollingResistance: 0, cdA: 0 };
  const mild = makeRoadVehicle({ def, grade: Math.atan(0.2) });
  const steep = makeRoadVehicle({ def, grade: Math.atan(0.8) });
  for (let i = 0; i < 120; i++) { stepRoadVehicle(mild, { throttle: 1 }, DT); stepRoadVehicle(steep, { throttle: 1 }, DT); }
  assert.ok(mild.longitudinalSpeed > 0.5, 'engine climbs a grade below its force limit');
  assert.ok(steep.longitudinalSpeed < -0.5, 'gravity wins above the engine force limit');
}

// Deployment places the UGV ahead, then autonomy brings it to its shadow point on a hill.
{
  const hill = (x, z) => 0.08 * z;
  const rec = createBaseGameVehicle(VEHICLE_UGV, { ownerId: 'p1', from: [0, 0, 0], id: 'deploy', groundY: hill });
  stepBaseGameVehicle(rec, DT, world(hill));
  assert.equal(rec.state, 'follow');
  assert.ok(rec.body.z > 1.9 && Math.abs(rec.pitch - Math.atan(0.08)) < 1e-3);
  run(rec, 10, world(hill));
  assert.ok(Math.hypot(rec.body.x, rec.body.z + 3) < 2.5, 'UGV follows behind its owner');
}

// A cliff edge produces ballistic flight and a landing on the lower shelf.
{
  const cliff = (_x, z) => z < 3 ? 0 : -3;
  const rec = createBaseGameVehicle(VEHICLE_BUGGY, { from: [0, 0, 0], id: 'cliff', groundY: cliff });
  assert.ok(takeOverVehicle(rec, 'p1'));
  let flew = false;
  for (let i = 0; i < 120 * 8; i++) {
    stepVehicleSeat(rec, { moveZ: 1 }, DT, world(cliff));
    flew ||= rec.airborne;
  }
  assert.ok(flew, 'vehicle becomes airborne after the support drops');
  assert.equal(rec.airborne, false);
  assert.ok(Math.abs(rec.y - (-3 + rec.def.clearance)) < 1e-5, 'vehicle lands on the lower shelf');
}

// The 10 Hz probe chooses a side heading when the straight sample is too steep.
{
  const ridge = (x, z) => z <= 0 ? 0 : (Math.abs(x) < 2.2 ? z : 0);
  const rec = createBaseGameVehicle(VEHICLE_UGV, { ownerId: 'p1', id: 'probe', groundY: ridge });
  stepBaseGameVehicle(rec, DT, world(ridge));
  sendVehicleTo(rec, [0, 0, 30]);
  run(rec, 0.2, world(ridge));
  // Two stages since the steering was smoothed: the probe picks a side heading at 10 Hz, and the
  // heading actually steered to eases toward that pick rather than snapping onto it.
  assert.ok(Math.abs(rec.probeTarget) > 0.4, 'grade probe picks a heading away from an over-limit straight climb');
  run(rec, 0.6, world(ridge));
  assert.ok(Math.abs(rec.probeYaw) > 0.4, 'and the steered heading eases onto that pick');
}

// Orders, hold, recall and manual handoff preserve the drone-shaped state contract.
{
  const rec = createBaseGameVehicle(VEHICLE_UGV, { ownerId: 'p1', id: 'orders', groundY: flat });
  run(rec, 0.1);
  assert.ok(sendVehicleTo(rec, [0, 0, 8]));
  run(rec, 8);
  assert.equal(rec.state, 'hold');
  assert.ok(takeOverVehicle(rec, 'p1'));
  run(rec, 0.5, world(), { moveZ: 1, moveX: 0.3 });
  assert.equal(rec.mode, 'manual');
  assert.ok(releaseVehicle(rec));
  assert.equal(rec.state, 'goto', 'release resumes a retained target');
  assert.ok(recallVehicle(rec));
  run(rec, 10);
  assert.equal(rec.state, 'follow');
}

// A blocked autonomous vehicle reverses once; another stuck event inside five seconds holds.
{
  const rec = createBaseGameVehicle(VEHICLE_UGV, { ownerId: 'p1', id: 'stuck', groundY: flat });
  run(rec, 0.1);
  rec.body.def.engineForce = 0; rec.body.def.reverseForce = 0;
  rec.body.vx = 0; rec.body.vz = 0; rec.body.speed = 0; rec.body.longitudinalSpeed = 0;
  sendVehicleTo(rec, [0, 0, 20]);
  run(rec, 1.7);
  assert.equal(rec.state, 'stuck');
  run(rec, 4);
  assert.equal(rec.state, 'hold');
  assert.equal(rec.secondStuck, true);
}

// Fixed inputs and ids are bit-identical, including probe staggering and wire output.
{
  const a = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'same', groundY: flat });
  const b = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'same', groundY: flat });
  takeOverVehicle(a, 'p'); takeOverVehicle(b, 'p');
  for (let i = 0; i < 1200; i++) {
    const input = { moveZ: i < 800 ? 1 : 0, moveX: Math.sin(i * 0.02), crouch: i > 900 };
    stepVehicleSeat(a, input, DT, world()); stepVehicleSeat(b, input, DT, world());
  }
  assert.deepEqual(vehicleSeatState(a), vehicleSeatState(b));
}

// Wire and reconciliation state survive JSON sanitization and restore the exact road body.
{
  const rec = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'wire', team: 2, groundY: flat });
  takeOverVehicle(rec, 'p1'); run(rec, 1, world(), { moveZ: 1, moveX: -0.2 });
  const wire = JSON.parse(JSON.stringify(vehicleWireState(rec)));
  const clean = sanitizeBaseGameVehicleState(wire);
  assert.equal(clean?.driver, 'p1'); assert.equal(clean?.kind, 'buggy');
  const seat = sanitizeBaseGameVehicleSeatState(JSON.parse(JSON.stringify(vehicleSeatState(rec))));
  assert.ok(seat);
  const restored = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'wire', groundY: flat });
  assert.ok(restoreVehicleSeatState(restored, seat));
  assert.deepEqual(vehicleSeatState(restored).body, seat.body);
  assert.equal(sanitizeBaseGameVehicleState({ ...wire, p: [NaN, 0, 0] }), null);
}

// Damage produces the room blast payload at the vehicle position.
{
  const rec = createBaseGameVehicle(VEHICLE_UGV, { id: 'damage', groundY: flat });
  assert.equal(damageBaseGameVehicle(rec, 10).dead, false);
  assert.equal(damageBaseGameVehicle(rec, 100).dead, true);
  assert.equal(rec.state, 'wreck'); assert.ok(rec.crash);
}

// The seated controller and prediction replay the exact same tick path as authority. The body is
// at the seat, so ordinary position reconciliation stays green; injected vehicle drift is caught.
{
  function mockBody() {
    const position = [0, 0, 0], previousPosition = [0, 0, 0], velocity = [0, 0, 0];
    let tick = 0;
    return {
      config: { fixedHz: 120 }, grounded: false, ceiling: false, swimming: false, stance: 'stand', requestedStance: 'stand', stanceWeights: {}, standBlocked: false,
      poseHeight: 1.8, inWater: false, submersion: 0, waterSurface: null, contacts: [], surface: null, diagnostics: {}, waterTime: 0,
      setInput() {}, queueJump() {}, clearJump() {}, configure() {}, reset() {}, getCapsule() { return null; },
      stepOnce(next) { tick = next?.tick ?? tick + 1; return {}; },
      advance() { return { steps: 0, alpha: 0 }; }, interpolatedPosition(_a, out = [0, 0, 0]) { return Object.assign(out, position); },
      getPosition(out = [0, 0, 0]) { out.splice(0, 3, ...position); return out; }, getVelocity(out = [0, 0, 0]) { out.splice(0, 3, ...velocity); return out; },
      pin(p, v, nextTick = null) { previousPosition.splice(0, 3, ...position); position.splice(0, 3, ...p); velocity.splice(0, 3, ...v); tick = nextTick ?? tick + 1; return true; },
      captureState() { return { position: [...position], previousPosition: [...previousPosition], velocity: [...velocity], grounded: false, tick }; },
      applyState(s) { position.splice(0, 3, ...s.position); previousPosition.splice(0, 3, ...(s.previousPosition ?? s.position)); velocity.splice(0, 3, ...(s.velocity ?? [0, 0, 0])); tick = s.tick ?? tick; return true; },
      get tick() { return tick; },
    };
  }
  const server = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'predicted-seat', groundY: flat });
  const client = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'predicted-seat', groundY: flat });
  takeOverVehicle(server, 'p1'); takeOverVehicle(client, 'p1');
  const map = new Map([[client.id, client]]), body = mockBody();
  const controller = createSeatedController(body, map, { worldFor: () => world() });
  controller.setControlling(client.id);
  const ticks = [];
  const prediction = createBaseGamePrediction({ controller, onTick: tick => ticks.push(tick) });
  const serverBody = mockBody();
  for (let frame = 0; frame < 120; frame++) {
    const moveX = Math.sin(frame * 0.08) * 0.5;
    prediction.advance(DT + 1e-9, () => ({ moveZ: 1, moveX, crouch: false }));
    const tick = ticks[frame];
    const seat = stepVehicleSeat(server, tick, DT, world());
    serverBody.pin(seat.position, seat.velocity, tick.tick);
  }
  assert.deepEqual(vehicleSeatState(client).body, vehicleSeatState(server).body, 'predicted and authoritative seat bodies are bit-identical');
  let result = prediction.reconcile({ position: serverBody.getPosition(), velocity: serverBody.getVelocity(), grounded: false, lastProcessedTick: 120, queueDepth: 0, spawnRevision: 0, controlling: server.id, vehicle: vehicleSeatState(server) });
  assert.equal(result.hard, false); assert.equal(prediction.diagnostics.hardSnaps, 0);
  client.body.x += 0.5;
  result = prediction.reconcile({ position: serverBody.getPosition(), velocity: serverBody.getVelocity(), grounded: false, lastProcessedTick: 120, queueDepth: 0, spawnRevision: 0, controlling: server.id, vehicle: vehicleSeatState(server) });
  assert.equal(result.reason, 'replay');
  assert.ok(Math.abs(client.body.x - server.body.x) < 1e-12, 'vehicle drift restores from the authoritative seat body');
}

// Both registered ground meshes are consumed through the combined craft view: four wheel pivots,
// animated rolling/steering, cached held meshes and terrain-clamped chase placement.
{
  const { createBaseGameDroneView } = await import('./base-game-drone-view.js');
  const scene = new THREE.Scene();
  let obstructionCalls = 0;
  const coords = { toRenderLocal: (p, out = [0, 0, 0]) => { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; } };
  const view = createBaseGameDroneView({ scene, worldCoordinates: coords, cameraObstruction: () => { obstructionCalls++; return 0.8; } });
  const rec = createBaseGameVehicle(VEHICLE_BUGGY, { id: 'drawn-buggy', groundY: flat });
  takeOverVehicle(rec, 'p1'); run(rec, 1, world(), { moveZ: 1, moveX: 0.4 });
  view.ingest([vehicleWireState(rec)], 1_000); view.update(1_000, 1 / 60, { interpolationDelayMs: 0 });
  const drawn = view.drones.get(rec.id);
  assert.equal(drawn.mesh.userData.wheels.length, 4);
  assert.ok(drawn.mesh.userData.wheels.some(wheel => Math.abs(wheel.pivot.rotation.y) > 0), 'front wheels display steering');
  assert.ok(drawn.mesh.userData.wheels.some(wheel => Math.abs(wheel.spin.rotation.x) > 0), 'wheels roll with speed');
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.1, 1e5);
  assert.ok(view.placeCamera(camera, rec.id, 1 / 60));
  assert.ok(obstructionCalls >= 2, 'ground chase camera checks desired and smoothed obstruction');
  view.showHeld('p1', VEHICLE_UGV, [0, 1, 0], 0);
  const cachedUgv = scene.children.find(child => child.name === 'craft-view:ugv');
  view.showHeld('p1', VEHICLE_BUGGY, [0, 1, 0], 0);
  assert.equal(cachedUgv.visible, false);
  view.showHeld('p1', VEHICLE_UGV, [0, 1, 0], 0);
  assert.equal(scene.children.find(child => child.name === 'craft-view:ugv'), cachedUgv, 'held UGV mesh is reused after a slot change');
  view.dispose();
}

const ok = (cond, msg) => assert.ok(cond, msg);

// ─── the weapon station (2026-09-02) ────────────────────────────────────────
// Aim only: the station trains toward a world point, it does not shoot yet.
{
  const flat = () => 0;
  const world = { groundY: flat, ownerPos: [0, 0, 0], ownerYaw: 0, ownerAlive: true, seaLevel: -Infinity };
  const make = (yaw = 0) => {
    const r = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 0], yaw, groundY: flat });
    r.mode = 'parked'; r.state = 'parked';
    return r;
  };
  const T = BASE_GAME_VEHICLE_DEFS.ugv.turret;

  ok(!!T, 'the UGV def carries a weapon station');
  ok(BASE_GAME_VEHICLE_DEFS.buggy.turret === undefined, 'the buggy has none, so it is unarmed');

  // The basis has to be orthonormal at any attitude, or every angle derived from it is wrong.
  {
    const rec = make(0.7); rec.pitch = 0.2; rec.roll = -0.35;
    const b = vehicleBasis(rec);
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const len = (u) => Math.hypot(u[0], u[1], u[2]);
    for (const [n, a] of Object.entries(b)) ok(Math.abs(len(a) - 1) < 1e-9, `basis ${n} is unit length`);
    ok(Math.abs(dot(b.fwd, b.right)) < 1e-9 && Math.abs(dot(b.fwd, b.up)) < 1e-9 && Math.abs(dot(b.right, b.up)) < 1e-9,
      'basis axes are mutually perpendicular');
  }

  // Straight ahead is zero, and the road model faces +Z.
  {
    const rec = make(0);
    aimVehicleTurret(rec, 10, [0, rec.def.turret.pivot[1], 50]);
    ok(Math.abs(rec.turretYaw) < 1e-6, `an aim dead ahead trains to yaw 0 (${rec.turretYaw.toFixed(4)})`);
  }

  // A point to the vehicle's right is +90 degrees, and the slew rate is what limits getting there.
  {
    const rec = make(0);
    const aim = [50, rec.def.turret.pivot[1], 0];
    const out = aimVehicleTurret(rec, 0.1, aim);
    ok(Math.abs(rec.turretYaw - T.yawRate * 0.1) < 1e-9,
      `one 0.1 s step moves exactly yawRate x dt (${rec.turretYaw.toFixed(4)})`);
    ok(out.onTarget === false, 'and it reports not on target while it is still slewing');
    for (let i = 0; i < 200; i++) aimVehicleTurret(rec, 1 / 60, aim);
    ok(Math.abs(rec.turretYaw - Math.PI / 2) < 1e-3, `it settles at +90 degrees (${rec.turretYaw.toFixed(4)})`);
    ok(aimVehicleTurret(rec, 1 / 60, aim).onTarget === true, 'and then reports on target');
  }

  // Yaw wraps the short way rather than unwinding through the long side.
  {
    const rec = make(0);
    rec.turretYaw = Math.PI - 0.05;
    const before = rec.turretYaw;
    aimVehicleTurret(rec, 1 / 60, [0, rec.def.turret.pivot[1] + 0, -50]);   // directly behind
    ok(Math.abs(wrapPiTest(rec.turretYaw - before)) <= T.yawRate / 60 + 1e-9,
      'a wrap across pi never moves more than one rate-limited step');
  }

  // Elevation clamps, and an aim above the limit is reported unreachable rather than silently met.
  {
    const rec = make(0);
    const high = [0, rec.def.turret.pivot[1] + 100, 5];
    let out;
    for (let i = 0; i < 300; i++) out = aimVehicleTurret(rec, 1 / 60, high);
    ok(Math.abs(rec.turretPitch - T.pitchMax) < 1e-6, `pitch stops at pitchMax (${rec.turretPitch.toFixed(3)})`);
    ok(out.reachable === false, 'and an aim above the elevation limit reports unreachable');
    ok(out.onTarget === false, 'so it is never on target');
  }

  // The aim is a WORLD point: rolling the hull must not swing the trained direction in the world.
  {
    const aim = [30, 1.2, 40];
    const level = make(0.6);
    const rolled = make(0.6); rolled.roll = 0.4; rolled.pitch = -0.15;
    for (let i = 0; i < 400; i++) { aimVehicleTurret(level, 1 / 60, aim); aimVehicleTurret(rolled, 1 / 60, aim); }
    const worldDir = (rec) => {
      const b = vehicleBasis(rec);
      const cy = Math.cos(rec.turretYaw), sy = Math.sin(rec.turretYaw);
      const cp = Math.cos(rec.turretPitch), sp = Math.sin(rec.turretPitch);
      return [0, 1, 2].map(i => (b.fwd[i] * cy + b.right[i] * sy) * cp + b.up[i] * sp);
    };
    const a = worldDir(level), c = worldDir(rolled);
    const dot = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    ok(dot > 0.999, `a rolled and pitched hull trains to the same world direction (dot ${dot.toFixed(5)})`);
  }

  // The station trains from inside the vehicle's own fixed step, so Solo and the server agree.
  {
    const rec = make(0);
    rec.aim = [40, 1.2, 0];
    stepBaseGameVehicle(rec, 0.5, world);
    ok(rec.turretYaw > 0.2, `stepping the vehicle trains the station off its stored aim (${rec.turretYaw.toFixed(3)})`);
    const wire = vehicleWireState(rec);
    ok(Number.isFinite(wire.turretYaw) && Number.isFinite(wire.turretPitch), 'and the angles reach the wire');
  }
  {
    const buggy = createBaseGameVehicle('buggy', { from: [0, 0, 0], groundY: flat });
    const wire = vehicleWireState(buggy);
    ok(wire.turretYaw === null && wire.turretPitch === null,
      'an unarmed vehicle sends null, so a remote can tell no turret from a turret at zero');
    ok(aimVehicleTurret(buggy, 1 / 60, [10, 0, 10]) === null, 'and aiming one is a no-op');
  }
}
function wrapPiTest(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }


// ─── firing (2026-09-02) ────────────────────────────────────────────────────
{
  const flat = () => 0;
  const world = { groundY: flat, ownerPos: [0, 0, 0], ownerYaw: 0, ownerAlive: true, seaLevel: -Infinity };
  const T = BASE_GAME_VEHICLE_DEFS.ugv.turret;
  const armed = (aim) => {
    const r = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 0], yaw: 0, groundY: flat });
    r.mode = 'parked'; r.state = 'parked'; r.aim = aim;
    for (let i = 0; i < 600; i++) aimVehicleTurret(r, 1 / 60, aim);   // let it finish training
    r.turretOnTarget = true;
    return r;
  };

  ok(T.weapon === 'ugv_mg' && getWeapon(T.weapon), 'the station names a weapon the weapons table knows');
  ok(!BASE_GAME_WEAPON_IDS.includes(T.weapon), 'and that weapon is not in the loadout vocabulary');

  // Nothing leaves the barrel unless the trigger is down.
  {
    const rec = armed([0, 1.3, 60]);
    ok(fireVehicleTurret(rec) === null, 'no trigger, no round');
    rec.firing = true;
    ok(fireVehicleTurret(rec) !== null, 'trigger down fires one');
  }

  // Rate of fire is a cooldown debt paid off in the fixed step, so a fast tick cannot spray.
  {
    const rec = armed([0, 1.3, 60]); rec.firing = true;
    ok(fireVehicleTurret(rec) !== null, 'the first round leaves');
    ok(fireVehicleTurret(rec) === null, 'and an immediate second does not');
    let fired = 0;
    for (let i = 0; i < 120; i++) { stepBaseGameVehicle(rec, 1 / 120, world); if (fireVehicleTurret(rec)) fired++; }
    ok(Math.abs(fired - T.rps) <= 1, `one second of held trigger fires about rps rounds (${fired} vs ${T.rps})`);
  }

  // A station still slewing refuses rather than throwing the round wide.
  {
    const rec = armed([0, 1.3, 60]); rec.firing = true; rec.turretOnTarget = false;
    ok(fireVehicleTurret(rec) === null, 'off target, the station holds fire');
  }

  // The round leaves along the direction the station was trained to, from ahead of the trunnion.
  {
    const aim = [40, 1.3, 40];
    const rec = armed(aim); rec.firing = true;
    const shot = fireVehicleTurret(rec);
    const pivot = turretPivotWorld(rec, [0, 0, 0]);
    const dir = turretDirWorld(rec, [0, 0, 0]);
    ok(Math.abs(Math.hypot(...shot.dir) - 1) < 1e-9, 'the shot direction is unit length');
    const dot = shot.dir[0] * dir[0] + shot.dir[1] * dir[1] + shot.dir[2] * dir[2];
    ok(dot > 0.9999, 'the round leaves along the trained barrel');
    const ahead = Math.hypot(shot.origin[0] - pivot[0], shot.origin[1] - pivot[1], shot.origin[2] - pivot[2]);
    ok(Math.abs(ahead - T.muzzle) < 1e-9, `the muzzle is ${T.muzzle} m ahead of the trunnion (${ahead.toFixed(3)})`);
    // And it actually points at what was aimed at, which is the whole contract.
    let ax = aim[0] - shot.origin[0], ay = aim[1] - shot.origin[1], az = aim[2] - shot.origin[2];
    const al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
    ok(shot.dir[0] * ax + shot.dir[1] * ay + shot.dir[2] * az > 0.999, 'and it points at the aim point');
  }

  // Ammunition is spent and runs out; there is no rearm, as with the Sentinel's rack.
  {
    const rec = armed([0, 1.3, 60]); rec.firing = true;
    const start = rec.mount.ammo;
    let fired = 0;
    for (let i = 0; i < 200000 && rec.mount.ammo > 0; i++) { rec.mount.cool = 0; if (fireVehicleTurret(rec)) fired++; }
    ok(fired === start, `every round on the mount can be fired (${fired} of ${start})`);
    rec.mount.cool = 0;
    ok(fireVehicleTurret(rec) === null, 'and an empty mount fires nothing');
    ok(vehicleWireState(rec).turretAmmo === 0, 'the wire reports the empty rack');
  }

  // A wreck and a drowned hull do not shoot, and neither does an unarmed vehicle.
  {
    const rec = armed([0, 1.3, 60]); rec.firing = true;
    rec.state = 'drowned';
    ok(fireVehicleTurret(rec) === null, 'a drowned hull holds fire');
    rec.state = 'parked'; rec.done = true;
    ok(fireVehicleTurret(rec) === null, 'and a finished one does too');
    const buggy = createBaseGameVehicle('buggy', { from: [0, 0, 0], groundY: flat });
    buggy.firing = true;
    ok(fireVehicleTurret(buggy) === null, 'an unarmed vehicle has nothing to fire');
    ok(vehicleWireState(buggy).turretAmmo === null, 'and reports null rounds, not zero');
  }

  // Letting go of the stick drops the trigger, so a released station cannot keep shooting.
  {
    const rec = armed([0, 1.3, 60]); rec.firing = true; rec.mode = 'manual';
    releaseVehicle(rec);
    ok(rec.firing === false, 'releasing the stick clears the trigger');
  }
}

// ─── follow behaviour (2026-09-02) ──────────────────────────────────────────
// The station is held behind the owner's TRAVEL. Tracking the eyeline made it orbit anyone who
// stood still and turned their head, which is neither realistic nor useful.
{
  const groundY = () => 0;
  const rec = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 6], yaw: 0, groundY });
  const world = { groundY, ownerPos: [0, 0, 0], ownerYaw: 0, ownerVel: [0, 0, 0], ownerAlive: true, seaLevel: -Infinity };
  const settle = (n = 900) => { for (let i = 0; i < n; i++) stepBaseGameVehicle(rec, 1 / 120, world); };

  // Walk north, let it take station, then stand still and spin on the spot.
  world.ownerVel = [0, 0, 3];
  settle();
  const parked = [rec.body.x, rec.body.z];
  world.ownerVel = [0, 0, 0];
  for (let turn = 0; turn < 8; turn++) { world.ownerYaw = turn * Math.PI / 4; settle(120); }
  const drift = Math.hypot(rec.body.x - parked[0], rec.body.z - parked[1]);
  ok(drift < 0.6, `a full turn on the spot does not walk the UGV round the owner (${drift.toFixed(2)} m)`);

  // Change travel direction and it re-stations behind the new heading.
  world.ownerYaw = 0;
  world.ownerVel = [3, 0, 0];
  settle();
  ok(rec.body.x < -1 && Math.abs(rec.body.z) < 1.5,
    `walking east puts it behind the owner to the west (${rec.body.x.toFixed(2)}, ${rec.body.z.toFixed(2)})`);
}

// A parked UGV never rotates on the spot. The old follow state eased its yaw toward the owner's,
// assigned directly rather than driven through the wheels, so it span with its tyres pointing
// straight ahead.
{
  const groundY = () => 0;
  const rec = createBaseGameVehicle('ugv', { ownerId: 'o', from: [0, 0, 3], yaw: 0, groundY });
  const world = { groundY, ownerPos: [0, 0, 0], ownerYaw: 0, ownerVel: [0, 0, 0], ownerAlive: true, seaLevel: -Infinity };
  for (let i = 0; i < 900; i++) stepBaseGameVehicle(rec, 1 / 120, world);   // let it take station and settle
  const parkedYaw = rec.body.yaw, parkedAt = [rec.body.x, rec.body.z];
  for (let turn = 1; turn <= 6; turn++) {
    world.ownerYaw = turn * Math.PI / 3;
    for (let i = 0; i < 120; i++) stepBaseGameVehicle(rec, 1 / 120, world);
  }
  const turned = Math.abs(wrapPiLocal(rec.body.yaw - parkedYaw));
  const moved = Math.hypot(rec.body.x - parkedAt[0], rec.body.z - parkedAt[1]);
  ok(turned < 0.05, `a parked UGV holds its heading while the owner turns (${turned.toFixed(3)} rad)`);
  ok(moved < 0.6, `and stays put (${moved.toFixed(2)} m)`);
}
function wrapPiLocal(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

console.log('base-game-vehicles: all assertions passed');