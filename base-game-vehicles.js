// base-game-vehicles.js -- shared deterministic ground-vehicle simulation for Base Game.
// The UGV and buggy use the same road model. Their definition row selects autonomy and a
// remote operator versus an onboard seat; this module has no renderer or server dependency.
import { G, DEFAULT_ROAD_VEHICLE, makeRoadVehicle, stepRoadVehicle } from './city-vehicle-model.js';
import {
  BASE_GAME_VEHICLE_KINDS, BASE_GAME_VEHICLE_MODES, BASE_GAME_VEHICLE_STATES,
  sanitizeBaseGameVehicleState, sanitizeBaseGameVehicleSeatState,
} from './base-game-protocol.mjs';

export const VEHICLE_UGV = 'ugv';
export const VEHICLE_BUGGY = 'buggy';
export { BASE_GAME_VEHICLE_KINDS, BASE_GAME_VEHICLE_MODES, BASE_GAME_VEHICLE_STATES, sanitizeBaseGameVehicleState, sanitizeBaseGameVehicleSeatState };

const FIXED_STEP = 1 / 120;
const PROBE_PERIOD = 0.1;
const PROBE_ANGLE = 35 * Math.PI / 180;
const PROBE_EASE = 6;          // how fast the eased heading chases the 10 Hz probe, per second
const STEER_RATE = 2.5;        // full lock to full lock in 0.8 s, which is a real rack
const STEER_FULL_LOCK = 0.9;   // heading error at which the wheels are on the stops (was 0.65)
const ZERO_INPUT = Object.freeze({ throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: false });
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp1 = x => clamp(Number(x) || 0, -1, 1);
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

export const BASE_GAME_VEHICLE_DEFS = Object.freeze({
  [VEHICLE_UGV]: Object.freeze({
    ...DEFAULT_ROAD_VEHICLE,
    kind: VEHICLE_UGV, label: 'UGV', mesh: 'ugv', autonomy: true, seat: 'remote', gadget: true,
    tint: 0x5c6b3c,   // the reference's olive; craft otherwise share the flight sim's pale sky skin
    mass: 180, wheelbase: 1.1, track: 0.8, clearance: 0.25, cgHeight: 0.22, yawInertia: 72,
    engineForce: 1700, powerLimit: 9000, reverseForce: 1200, brakeForce: 2600, handbrakeForce: 2200,
    rollingResistance: 0.022, cdA: 0.34, cornerStiffnessFront: 15000, cornerStiffnessRear: 14000,
    maxSteer: 0.68, steerResponse: 10, steerSpeedFalloff: 0.07, maxSpeed: 7,
    shadowOffset: 3, followRadius: 1.5, stopRadius: 2, maxGrade: 0.7,
    hp: 40, bodyRadius: 0.75, meshScale: 1, crashBlast: { radius: 3, damage: 20 },
    seatOffset: [0, 0, 0], exitOffset: [-1.2, 0, 0],
    // The remote weapon station. `pivot` is the trunnion in the SIM frame (forward +Z); the mesh
    // draws it at -z because craft meshes point their nose down -Z. Its height is the mesh's own
    // gun-axis band, and test-vehicle-meshes.mjs asserts the drawn trunnion agrees with it.
    turret: Object.freeze({
      pivot: [0, 1.335, 0.05], muzzle: 0.78,
      yawRate: 1.9, pitchRate: 1.2, pitchMin: -0.17, pitchMax: 0.79, tolerance: 0.02,
      weapon: 'ugv_mg', rps: 9, ammo: 400,
    }),
  }),
  [VEHICLE_BUGGY]: Object.freeze({
    ...DEFAULT_ROAD_VEHICLE,
    kind: VEHICLE_BUGGY, label: 'Buggy', mesh: 'buggy', autonomy: false, seat: 'onboard', gadget: false,
    tint: 0xb8a074,   // desert tan, the light-strike-vehicle reference
    mass: 900, wheelbase: 2.4, track: 1.6, clearance: 0.4, cgHeight: 0.52, yawInertia: 1550,
    engineForce: 6800, powerLimit: 100000, reverseForce: 3400, brakeForce: 10500, handbrakeForce: 7600,
    maxSpeed: 24, hp: 120, bodyRadius: 1.5, meshScale: 1, crashBlast: { radius: 5, damage: 40 },
    seatOffset: [-0.42, 0.72, 0.05], exitOffset: [-1.2, 0, 0], maxGrade: 0.7,
  }),
});

let sequence = 0;
function idPhase(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 12 / 120;
}

function localPoint(body, localX, localZ) {
  const sy = Math.sin(body.yaw), cy = Math.cos(body.yaw);
  return [body.x + localX * cy + localZ * sy, body.z - localX * sy + localZ * cy];
}

// Three samples define the support plane: front centre, rear left and rear right.
export function fitVehicleGround(body, def, groundY) {
  const halfWb = def.wheelbase * 0.5, halfTrack = def.track * 0.5;
  const front = localPoint(body, 0, halfWb);
  const left = localPoint(body, -halfTrack, -halfWb);
  const right = localPoint(body, halfTrack, -halfWb);
  const hFront = groundY(front[0], front[1]);
  const hLeft = groundY(left[0], left[1]);
  const hRight = groundY(right[0], right[1]);
  const hRear = (hLeft + hRight) * 0.5;
  return {
    y: (hFront + hLeft + hRight) / 3,
    pitch: Math.atan2(hFront - hRear, def.wheelbase),
    roll: Math.atan2(hLeft - hRight, def.track),
  };
}

export function createBaseGameVehicle(kind, { ownerId = null, team = 0, from = [0, 0, 0], yaw = 0, groundY = 0, id = null } = {}) {
  const def = BASE_GAME_VEHICLE_DEFS[kind];
  if (!def) throw new Error(`unknown base-game vehicle kind '${kind}'`);
  const body = makeRoadVehicle({ x: Number(from[0]) || 0, z: Number(from[2]) || 0, yaw: Number(yaw) || 0, def });
  const ground = typeof groundY === 'function' ? groundY(body.x, body.z) : Number(groundY) || 0;
  const vehicleId = id ?? `bgv${++sequence}`;
  return {
    id: vehicleId, kind, def, ownerId, team, body,
    y: ground + def.clearance, pitch: 0, roll: 0, airV: 0, airborne: false,
    mode: def.autonomy ? 'auto' : 'parked', state: def.autonomy ? 'deploy' : 'parked', stateT: 0,
    target: null, driver: null,
    input: { ...ZERO_INPUT }, hp: def.hp, done: false, crash: null,
    stepAcc: 0, age: 0, probeT: idPhase(vehicleId), probeYaw: body.yaw,
    stuckT: 0, stuckFrom: null, lastRecoveryAt: -Infinity, secondStuck: false, probeTarget: 0, steerCmd: 0,
    turretYaw: 0, turretPitch: 0, aim: null, turretOnTarget: false, firing: false, followYaw: null,
    mount: def.turret ? { cool: 0, ammo: def.turret.ammo } : null,
  };
}

function enter(rec, state) {
  if (rec.state !== state) { rec.state = state; rec.stateT = 0; }
}

// Station is held behind where the owner is GOING, not behind what they are LOOKING at. Tracking
// the eyeline made it drive a circle round anyone who turned their head on the spot. Below a
// walking pace the heading is simply held, so standing still and looking about does not move it.
const FOLLOW_MIN_SPEED = 0.6;
function shadowPoint(rec, world) {
  const v = world.ownerVel;
  const speed = v ? Math.hypot(v[0], v[2]) : 0;
  if (speed >= FOLLOW_MIN_SPEED) rec.followYaw = Math.atan2(v[0], v[2]);
  else if (rec.followYaw === null) rec.followYaw = Number(world.ownerYaw) || 0;   // first placement only
  const yaw = rec.followYaw;
  return [world.ownerPos[0] - Math.sin(yaw) * rec.def.shadowOffset, world.ownerPos[2] - Math.cos(yaw) * rec.def.shadowOffset];
}

function chooseProbeHeading(rec, desired, groundY) {
  const current = groundY(rec.body.x, rec.body.z);
  const candidates = [desired, desired + PROBE_ANGLE, desired - PROBE_ANGLE];
  let chosen = candidates[0], bestTurn = Infinity, shallowest = Infinity, foundAllowed = false;
  for (const yaw of candidates) {
    const next = groundY(rec.body.x + Math.sin(yaw) * 5, rec.body.z + Math.cos(yaw) * 5);
    const grade = (next - current) / 5;
    const allowed = grade <= rec.def.maxGrade;
    const turn = Math.abs(wrapPi(yaw - desired));
    if (allowed && (!foundAllowed || turn < bestTurn)) {
      chosen = yaw; bestTurn = turn; foundAllowed = true;
    } else if (!foundAllowed && grade < shallowest) {
      chosen = yaw; shallowest = grade;
    }
  }
  return chosen;
}

// The rack has a rate. Commanding the wheels straight from the heading error made them chatter
// between locks; every branch below goes through here so none of them can snap.
function slewSteer(rec, want) {
  rec.steerCmd += clamp(want - rec.steerCmd, -STEER_RATE * FIXED_STEP, STEER_RATE * FIXED_STEP);
  return rec.steerCmd;
}

function driveToward(rec, x, z, stopRadius, groundY) {
  const dx = x - rec.body.x, dz = z - rec.body.z;
  const distance = Math.hypot(dx, dz);
  const desired = Math.atan2(dx, dz);
  rec.probeT -= FIXED_STEP;
  if (rec.probeT <= 0) {
    rec.probeTarget = chooseProbeHeading(rec, desired, groundY);
    rec.probeT += PROBE_PERIOD;
  }
  // The probe re-picks at 10 Hz and only ever returns one of three headings, so its answer is eased
  // rather than taken: snapping to it put a 35 degree step into the steering ten times a second.
  rec.probeYaw = wrapPi(rec.probeYaw + wrapPi(rec.probeTarget - rec.probeYaw) * Math.min(1, FIXED_STEP * PROBE_EASE));
  const error = wrapPi(rec.probeYaw - rec.body.yaw);
  const headingScale = clamp(1 - Math.abs(error) / Math.PI, 0.12, 1);
  const distanceScale = clamp((distance - stopRadius) / 5, 0, 1);
  if (distance <= stopRadius) {
    rec.steerCmd = slewSteer(rec, 0);
    return { distance, moving: false, input: { ...ZERO_INPUT, brake: 1, handbrake: true } };
  }
  if (Math.abs(error) > Math.PI * 0.7) {
    return { distance, moving: true, input: { ...ZERO_INPUT, reverse: 0.55, steer: slewSteer(rec, error > 0 ? 1 : -1) } };
  }
  return {
    distance, moving: true,
    input: { ...ZERO_INPUT, throttle: headingScale * Math.max(0.25, distanceScale), steer: slewSteer(rec, clamp(-error / STEER_FULL_LOCK, -1, 1)) },
  };
}

function autonomyInput(rec, world) {
  const alive = world.ownerAlive !== false && Array.isArray(world.ownerPos);
  if (rec.state === 'deploy') {
    if (!alive) { enter(rec, 'hold'); return { ...ZERO_INPUT, handbrake: true }; }
    const yaw = Number(world.ownerYaw) || 0;
    rec.body.x = world.ownerPos[0] + Math.sin(yaw) * 2;
    rec.body.z = world.ownerPos[2] + Math.cos(yaw) * 2;
    rec.body.yaw = yaw;
    enter(rec, 'follow');
  }
  if (!alive && (rec.state === 'follow' || rec.state === 'return')) enter(rec, 'hold');
  let result = null;
  if (rec.state === 'follow' || rec.state === 'return') {
    if (!alive) return { ...ZERO_INPUT, handbrake: true };
    const p = shadowPoint(rec, world);
    result = driveToward(rec, p[0], p[1], rec.def.followRadius, world.groundY);
    if (!result.moving && rec.state === 'return') enter(rec, 'follow');
    // Nothing turns a parked UGV to face anywhere. A four-wheel car cannot rotate on the spot, and
    // this was assigning yaw directly rather than driving the wheels: it span in place with its
    // tyres pointing straight ahead. It now keeps whatever heading it arrived on.
  } else if (rec.state === 'goto') {
    if (!rec.target) { enter(rec, 'follow'); return { ...ZERO_INPUT }; }
    result = driveToward(rec, rec.target[0], rec.target[2], rec.def.stopRadius, world.groundY);
    if (!result.moving) enter(rec, 'hold');
  } else if (rec.state === 'hold') {
    return { ...ZERO_INPUT, brake: 1, handbrake: true };
  } else if (rec.state === 'stuck') {
    if (rec.stateT < 1) return { ...ZERO_INPUT, reverse: 0.7, steer: 1 };
    enter(rec, rec.stuckFrom || (rec.target ? 'goto' : 'follow'));
    return { ...ZERO_INPUT };
  }
  const input = result?.input ?? { ...ZERO_INPUT };
  const wantsMove = result?.moving === true && input.throttle > 0;
  if (wantsMove && rec.body.speed < 0.3) rec.stuckT += FIXED_STEP;
  else rec.stuckT = 0;
  if (rec.stuckT >= 1.5) {
    if (rec.age - rec.lastRecoveryAt < 5) { enter(rec, 'hold'); rec.secondStuck = true; }
    else {
      rec.stuckFrom = rec.state; rec.lastRecoveryAt = rec.age; rec.stuckT = 0; enter(rec, 'stuck');
    }
  }
  return input;
}

function stepFixed(rec, world) {
  if (rec.done) return;
  rec.age += FIXED_STEP;
  rec.stateT += FIXED_STEP;
  const fit = fitVehicleGround(rec.body, rec.def, world.groundY);
  const supportY = fit.y + rec.def.clearance;

  if (!rec.airborne && rec.y > supportY + 0.06) { rec.airborne = true; rec.airV = Math.max(0, rec.airV); }
  if (rec.airborne) {
    rec.body.grade = 0;
    rec.airV -= G * FIXED_STEP;
    rec.y += rec.airV * FIXED_STEP;
    stepRoadVehicle(rec.body, ZERO_INPUT, FIXED_STEP);
    const landing = fitVehicleGround(rec.body, rec.def, world.groundY).y + rec.def.clearance;
    if (rec.y <= landing && rec.airV <= 0) { rec.y = landing; rec.airV = 0; rec.airborne = false; }
  } else {
    rec.y = supportY; rec.pitch = fit.pitch; rec.roll = fit.roll; rec.body.grade = fit.pitch;
    let input = ZERO_INPUT;
    if (rec.mode === 'manual') input = rec.input;
    else if (rec.mode === 'auto') input = autonomyInput(rec, world);
    rec.input = { ...ZERO_INPUT, ...input };
    stepRoadVehicle(rec.body, rec.input, FIXED_STEP);
  }

  if (rec.def.turret) {
    rec.turretOnTarget = !!aimVehicleTurret(rec, FIXED_STEP)?.onTarget;
    if (rec.mount) rec.mount.cool = Math.max(0, rec.mount.cool - FIXED_STEP);
  }

  const ground = world.groundY(rec.body.x, rec.body.z);
  if (Number.isFinite(world.seaLevel) && ground < world.seaLevel - rec.def.clearance && rec.state !== 'drowned') {
    rec.mode = 'parked'; rec.driver = null; rec.input = { ...ZERO_INPUT }; enter(rec, 'drowned');
  }
}

// Variable caller time is accumulated into exactly the road model's 120 Hz steps.
export function stepBaseGameVehicle(rec, dt, world) {
  if (!rec || !world?.groundY || rec.done) return { crash: rec?.crash ?? null };
  rec.stepAcc += Math.max(0, Number(dt) || 0);
  let steps = 0;
  while (rec.stepAcc + 1e-10 >= FIXED_STEP && steps < 24) {
    stepFixed(rec, world); rec.stepAcc -= FIXED_STEP; steps++;
  }
  return { crash: rec.crash };
}

export function sendVehicleTo(rec, point) {
  if (!rec || rec.done || !rec.def.autonomy || !Array.isArray(point)) return false;
  rec.target = [Number(point[0]) || 0, Number(point[1]) || 0, Number(point[2]) || 0];
  if (rec.mode === 'manual') releaseVehicle(rec);
  rec.mode = 'auto'; enter(rec, 'goto'); return true;
}

export function recallVehicle(rec) {
  if (!rec || rec.done || !rec.def.autonomy) return false;
  rec.target = null;
  if (rec.mode === 'manual') releaseVehicle(rec);
  rec.mode = 'auto'; enter(rec, 'return'); return true;
}

export function takeOverVehicle(rec, driver) {
  if (!rec || rec.done || rec.state === 'drowned' || rec.state === 'wreck' || rec.driver || typeof driver !== 'string') return false;
  rec.driver = driver; rec.mode = 'manual'; enter(rec, 'manual'); return true;
}

export function releaseVehicle(rec) {
  if (rec) rec.firing = false;
  if (!rec || rec.mode !== 'manual') return false;
  rec.driver = null; rec.input = { ...ZERO_INPUT };
  if (rec.def.autonomy) { rec.mode = 'auto'; enter(rec, rec.target ? 'goto' : 'return'); }
  else { rec.mode = 'parked'; enter(rec, 'parked'); }
  return true;
}

export function stepVehicleSeat(rec, tickInput, dt, world) {
  if (!rec || rec.mode !== 'manual') return null;
  const moveZ = clamp1(tickInput?.moveZ), moveX = clamp1(tickInput?.moveX);
  rec.input = { ...ZERO_INPUT, throttle: Math.max(0, moveZ), reverse: Math.max(0, -moveZ), steer: moveX, handbrake: tickInput?.crouch === true };
  stepBaseGameVehicle(rec, dt, world);
  if (rec.def.seat === 'remote') {
    const p = world.ownerPos ?? [0, 0, 0];
    return { position: [...p], velocity: [0, 0, 0] };
  }
  return vehicleSeatPoint(rec);
}

export function vehicleSeatPoint(rec, exit = false) {
  const offset = exit ? rec.def.exitOffset : rec.def.seatOffset;
  const sy = Math.sin(rec.body.yaw), cy = Math.cos(rec.body.yaw);
  const x = rec.body.x + offset[0] * cy + offset[2] * sy;
  const z = rec.body.z - offset[0] * sy + offset[2] * cy;
  return { position: [x, rec.y + offset[1], z], velocity: [rec.body.vx, rec.airV, rec.body.vz] };
}

export function damageBaseGameVehicle(rec, amount) {
  if (!rec || rec.done) return { dead: false };
  rec.hp -= Math.max(0, Number(amount) || 0);
  if (rec.hp > 0) return { dead: false };
  rec.hp = 0; rec.done = true; rec.mode = 'parked'; rec.driver = null; enter(rec, 'wreck');
  rec.crash = [rec.body.x, rec.y, rec.body.z];
  return { dead: true };
}

// ─── the weapon station ──────────────────────────────────────────────────────
// Hull axes from yaw, pitch and roll, matching the attitude the view builds: forward is +Z at yaw 0
// (the road model's own convention) and a positive roll drops the right side.
const _basis = { fwd: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] };
export function vehicleBasis(rec, out = _basis) {
  const cy = Math.cos(rec.body.yaw), sy = Math.sin(rec.body.yaw);
  const cp = Math.cos(rec.pitch), sp = Math.sin(rec.pitch);
  const cr = Math.cos(rec.roll), sr = Math.sin(rec.roll);
  const fx = sy * cp, fy = sp, fz = cy * cp;
  const r0x = cy, r0y = 0, r0z = -sy;
  const u0x = fy * r0z - fz * r0y, u0y = fz * r0x - fx * r0z, u0z = fx * r0y - fy * r0x;
  out.fwd[0] = fx; out.fwd[1] = fy; out.fwd[2] = fz;
  out.right[0] = r0x * cr - u0x * sr; out.right[1] = r0y * cr - u0y * sr; out.right[2] = r0z * cr - u0z * sr;
  out.up[0] = u0x * cr + r0x * sr; out.up[1] = u0y * cr + r0y * sr; out.up[2] = u0z * cr + r0z * sr;
  return out;
}

const _pivot = [0, 0, 0];
export function turretPivotWorld(rec, out = _pivot, basis = null) {
  const t = rec.def.turret;
  if (!t) return null;
  const b = basis || vehicleBasis(rec);
  const px = t.pivot[0], py = t.pivot[1], pz = t.pivot[2];
  out[0] = rec.body.x + b.right[0] * px + b.up[0] * py + b.fwd[0] * pz;
  out[1] = rec.y + b.right[1] * px + b.up[1] * py + b.fwd[1] * pz;
  out[2] = rec.body.z + b.right[2] * px + b.up[2] * py + b.fwd[2] * pz;
  return out;
}

// Train the station toward a world point. The aim is a WORLD point and never a hull-relative angle
// pair, so a bot brain can hand one over unchanged; the slew, the clamp and the reachability answer
// all live here, below that seam, so an AI-aimed station obeys the limits a player-aimed one does.
// Yaw wraps freely, pitch clamps, and both move at their own rate: a station swinging onto you is a
// warning, and an instantaneous one is not.
export function aimVehicleTurret(rec, dt, aim = rec.aim) {
  const t = rec?.def?.turret;
  if (!t) return null;
  const step = Math.max(0, Number(dt) || 0);
  let desiredYaw = rec.turretYaw, desiredPitch = rec.turretPitch, reachable = true;
  if (Array.isArray(aim) && aim.length === 3 && aim.every(Number.isFinite)) {
    const b = vehicleBasis(rec);
    turretPivotWorld(rec, _pivot, b);
    let dx = aim[0] - _pivot[0], dy = aim[1] - _pivot[1], dz = aim[2] - _pivot[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      dx /= len; dy /= len; dz /= len;
      const f = dx * b.fwd[0] + dy * b.fwd[1] + dz * b.fwd[2];
      const r = dx * b.right[0] + dy * b.right[1] + dz * b.right[2];
      const u = dx * b.up[0] + dy * b.up[1] + dz * b.up[2];
      desiredYaw = Math.atan2(r, f);
      desiredPitch = Math.asin(clamp(u, -1, 1));
      if (desiredPitch < t.pitchMin || desiredPitch > t.pitchMax) reachable = false;
      desiredPitch = clamp(desiredPitch, t.pitchMin, t.pitchMax);
    }
  }
  const yawStep = t.yawRate * step, pitchStep = t.pitchRate * step;
  rec.turretYaw = wrapPi(rec.turretYaw + clamp(wrapPi(desiredYaw - rec.turretYaw), -yawStep, yawStep));
  rec.turretPitch = clamp(rec.turretPitch + clamp(desiredPitch - rec.turretPitch, -pitchStep, pitchStep), t.pitchMin, t.pitchMax);
  const onTarget = reachable
    && Math.abs(wrapPi(desiredYaw - rec.turretYaw)) <= t.tolerance
    && Math.abs(desiredPitch - rec.turretPitch) <= t.tolerance;
  return { onTarget, reachable, desiredYaw, desiredPitch };
}

// Where the barrel points, and where its muzzle is, both in the world. Same construction the
// station's own angles were solved from, so the round leaves along the direction it was trained to.
export function turretDirWorld(rec, out = [0, 0, 0], basis = null) {
  const b = basis || vehicleBasis(rec);
  const cy = Math.cos(rec.turretYaw), sy = Math.sin(rec.turretYaw);
  const cp = Math.cos(rec.turretPitch), sp = Math.sin(rec.turretPitch);
  for (let i = 0; i < 3; i++) out[i] = (b.fwd[i] * cy + b.right[i] * sy) * cp + b.up[i] * sp;
  return out;
}

// One round, or null. Follows `fireAgm`'s seam exactly: this decides, the caller acts, because the
// server resolves into its room with lag compensation and Solo only presents the effect. Nothing
// here knows whether the aim came from a player's mouse or from a brain.
export function fireVehicleTurret(rec) {
  const t = rec?.def?.turret;
  if (!t || rec.done || !rec.firing) return null;
  if (rec.state === 'drowned' || rec.state === 'wreck') return null;
  const m = rec.mount;
  if (!m || m.ammo <= 0 || m.cool > 0) return null;
  if (!rec.turretOnTarget) return null;   // the barrel is not there yet: refuse rather than fire wide
  const b = vehicleBasis(rec);
  const dir = turretDirWorld(rec, [0, 0, 0], b);
  const pivot = turretPivotWorld(rec, [0, 0, 0], b);
  m.cool += 1 / t.rps;
  m.ammo -= 1;
  return {
    origin: [pivot[0] + dir[0] * t.muzzle, pivot[1] + dir[1] * t.muzzle, pivot[2] + dir[2] * t.muzzle],
    dir, weaponId: t.weapon, ownerId: rec.ownerId, vehicleId: rec.id, ammo: m.ammo,
  };
}

export function vehicleWireState(rec) {
  return {
    id: rec.id, kind: rec.kind, owner: rec.ownerId, team: rec.team, driver: rec.driver,
    p: [rec.body.x, rec.y, rec.body.z], v: [rec.body.vx, rec.airV, rec.body.vz],
    yaw: rec.body.yaw, pitch: rec.pitch, roll: rec.roll, steer: rec.body.steering,
    hp: rec.hp, mode: rec.mode, state: rec.state, target: rec.target ? [...rec.target] : null,
    turretYaw: rec.def.turret ? rec.turretYaw : null, turretPitch: rec.def.turret ? rec.turretPitch : null,
    turretAmmo: rec.mount ? rec.mount.ammo : null,
  };
}

export function vehicleSeatState(rec) {
  return {
    ...vehicleWireState(rec),
    body: [rec.body.x, rec.body.z, rec.body.yaw, rec.body.vx, rec.body.vz, rec.body.yawRate, rec.body.steering, rec.y, rec.airV],
  };
}

export function restoreVehicleSeatState(rec, state) {
  const clean = sanitizeBaseGameVehicleSeatState(state);
  if (!rec || !clean || clean.id !== rec.id || clean.kind !== rec.kind) return false;
  const [x, z, yaw, vx, vz, yawRate, steering, y, airV] = clean.body;
  Object.assign(rec.body, { x, z, yaw, vx, vz, yawRate, steering });
  rec.y = y; rec.airV = airV; rec.airborne = Math.abs(airV) > 1e-6;
  rec.pitch = clean.pitch; rec.roll = clean.roll; rec.hp = clean.hp; rec.mode = clean.mode; rec.state = clean.state;
  rec.target = clean.target; rec.driver = clean.driver;
  return true;
}

// Presents a player controller-shaped surface while routing fixed ticks through an occupied seat.
// `worldFor(rec)` returns the same owner/ground/sea keys used by the shared stepper.
export function createSeatedController(bodyController, vehicles, { worldFor = null, maxStepsPerFrame = 8 } = {}) {
  if (!bodyController?.stepOnce || !bodyController?.pin || !(vehicles instanceof Map)) throw new TypeError('seated controller requires a pinnable body controller and vehicle map');
  let controlling = null, accumulator = 0, jumpQueued = false;
  const input = { moveX: 0, moveZ: 0, yaw: 0, sprint: false, crouch: false, stance: 0 };
  const fixed = () => 1 / bodyController.config.fixedHz;
  const controlled = () => controlling ? vehicles.get(controlling) ?? null : null;
  function seatWorld(rec) {
    const base = typeof worldFor === 'function' ? worldFor(rec) : (worldFor ?? {});
    base.ownerPos = bodyController.getPosition(base.ownerPos ?? [0, 0, 0]);
    base.ownerYaw = input.yaw; base.ownerAlive = true;
    return base;
  }
  const api = {
    setControlling(id, state = null) {
      if (state) {
        const rec = vehicles.get(state.id);
        if (rec) restoreVehicleSeatState(rec, state);
      }
      controlling = typeof id === 'string' && vehicles.has(id) ? id : null;
      accumulator = 0; jumpQueued = false;
      return controlling;
    },
    configure(next) { return bodyController.configure(next); },
    setInput(next = {}) { Object.assign(input, next); if (!controlled()) bodyController.setInput(next); },
    queueJump() { if (!controlled()) bodyController.queueJump(); else jumpQueued = true; },
    clearJump() { jumpQueued = false; bodyController.clearJump(); },
    stepOnce(next = null, jump = false) {
      if (next) Object.assign(input, next);
      const rec = controlled();
      if (!rec) return bodyController.stepOnce(next, jump);
      const seat = stepVehicleSeat(rec, input, fixed(), seatWorld(rec));
      if (!seat) { controlling = null; return bodyController.stepOnce(next, false); }
      bodyController.pin(seat.position, seat.velocity, Number.isSafeInteger(next?.tick) ? next.tick : null);
      jumpQueued = false;
      return { grounded: false, ceiling: false, swimming: false, seated: true };
    },
    advance(dt) {
      if (!controlled()) return bodyController.advance(dt);
      const step = fixed(), accepted = Math.min(Math.max(0, Number(dt) || 0), step * maxStepsPerFrame);
      accumulator = Math.min(step * maxStepsPerFrame, accumulator + accepted);
      let steps = 0;
      while (accumulator + 1e-9 >= step && steps < maxStepsPerFrame) { api.stepOnce(input, false); accumulator -= step; steps++; }
      return { steps, alpha: clamp(accumulator / step, 0, 1), droppedSeconds: Math.max(0, (Number(dt) || 0) - accepted) };
    },
    reset(position) { controlling = null; accumulator = 0; return bodyController.reset(position); },
    interpolatedPosition(alpha, out) { return bodyController.interpolatedPosition(alpha, out); },
    getPosition(out) { return bodyController.getPosition(out); },
    getVelocity(out) { return bodyController.getVelocity(out); },
    pin(position, velocity, tick = null) { return bodyController.pin(position, velocity, tick); },
    getCapsule() { return bodyController.getCapsule(); },
    captureState() { const rec = controlled(); return { ...bodyController.captureState(), controlling, vehicle: rec ? vehicleSeatState(rec) : null }; },
    applyState(state) {
      const ok = bodyController.applyState(state);
      if (!ok) return false;
      if (state?.vehicle) {
        const rec = vehicles.get(state.vehicle.id);
        if (rec && restoreVehicleSeatState(rec, state.vehicle)) controlling = rec.id;
        else controlling = null;
      } else controlling = null;
      accumulator = 0;
      return true;
    },
    get controlledId() { return controlling; },
    get controlledVehicle() { return controlled(); },
    get grounded() { return controlled() ? false : bodyController.grounded; },
    get ceiling() { return controlled() ? false : bodyController.ceiling; },
    get tick() { return bodyController.tick; },
    get waterTime() { return bodyController.waterTime; },
    get swimming() { return controlled() ? false : bodyController.swimming; },
    get stance() { return bodyController.stance; },
    get requestedStance() { return bodyController.requestedStance; },
    get stanceWeights() { return bodyController.stanceWeights; },
    get standBlocked() { return bodyController.standBlocked; },
    get poseHeight() { return bodyController.poseHeight; },
    get inWater() { return controlled() ? false : bodyController.inWater; },
    get submersion() { return controlled() ? 0 : bodyController.submersion; },
    get waterSurface() { return bodyController.waterSurface; },
    get contacts() { return controlled() ? [] : bodyController.contacts; },
    get surface() { return controlled() ? null : bodyController.surface; },
    get config() { return bodyController.config; },
    get diagnostics() { return { ...bodyController.diagnostics, seated: !!controlled(), vehicleId: controlling }; },
  };
  return api;
}
