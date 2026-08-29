// base-game-drones.js — the player's thrown quadcopter and hand-launched UAV. One drone record,
// two steppers: bot-drones.js steering (hoverTo/cruiseTo/orbitAround) flies it while nobody is at
// the stick, flight-model.js flies it in `manual` with the sim's own `drone` and `plane` airframes.
// Pure arrays on the wire; THREE only inside the manual handoff. Tested in test-base-game-drones.mjs.
import * as THREE from 'three';
import {
  DRONE_BOMBER, DRONE_LOITER, DRONE_DEFS,
  createDrone, stepBotDrone, crippleDrone,
  hoverTo, cruiseTo, orbitAround, advance, setState,
} from './bot-drones.js';
import { AIRFRAMES, G } from './flight-airframes.js';
import { makeFlyer, stepFlyer, syncAxes } from './flight-model.js';
import { setHeightSource } from './flight-terrain.js';
import {
  BASE_GAME_DRONE_KINDS, BASE_GAME_DRONE_MODES, BASE_GAME_DRONE_STATES,
  sanitizeBaseGameDroneInput, sanitizeBaseGameDroneState,
} from './base-game-protocol.mjs';

export const DRONE_QUAD = 'quad';
export const DRONE_UAV = 'uav';
export { BASE_GAME_DRONE_KINDS, BASE_GAME_DRONE_MODES, BASE_GAME_DRONE_STATES, sanitizeBaseGameDroneState };
export const sanitizeDroneInput = sanitizeBaseGameDroneInput;

// Open-ground numbers over bot-drones.js's arena defs. Unarmed for now: the bomb rack and dive
// fields stay on the def so arming later is a flag, not a rewrite.
export const BASE_GAME_DRONE_DEFS = Object.freeze({
  [DRONE_QUAD]: Object.freeze({
    ...DRONE_DEFS[DRONE_BOMBER], kind: DRONE_BOMBER, label: 'Quadcopter', airframe: 'drone', mesh: 'drone',
    speed: 12, hoverSpeed: 10, hoverResponse: 3.5, climbRate: 6, turn: 2.2,
    cruiseAlt: 20, shadowAlt: 4, shadowOffset: 2.5, holdAlt: 12, minAgl: 1.5,
    hp: 30, bodyRadius: 0.6, bombs: 0, meshScale: 2.2,
    crashBlast: { radius: 3, damage: 25 },   // a battery pack going off
    catchS: 0.35,      // ballistic after the throw before the rotors take it
  }),
  // The UAV is the flight sim's plane: its airframe table drives manual flight, and the autonomy
  // numbers are that plane's circuit scaled to stay near a player (the sim's own circuit is 2.6 km).
  [DRONE_UAV]: Object.freeze({
    ...DRONE_DEFS[DRONE_LOITER], kind: DRONE_LOITER, label: 'UAV', airframe: 'plane', mesh: 'recon',
    speed: AIRFRAMES.plane.circuit.speed, turn: 0.2, climbRate: 25, cruiseAlt: 300, orbitRadius: 900, orbitLeadRad: 0.3,
    holdAlt: 300, minAgl: 6,
    hp: AIRFRAMES.plane.hp, bodyRadius: 1, meshScale: 1,   // the recon model at its authored size (real metres), flown as the plane
    crashBlast: { radius: 8, damage: 60 },   // the plane's fuel
    catchS: 0,
  }),
});


const TAU = Math.PI * 2;
let _seq = 0;

// `from` is the hand, `look` the throw direction (unit), both global. The drone leaves at
// `throwSpeed` along it, plus a little up for the quad so a flat throw still clears the thrower.
export function createBaseGameDrone(kind, { ownerId = null, team = 0, from, look = [0, 0, -1], throwSpeed = 8, groundY = 0, id = null } = {}) {
  const def = BASE_GAME_DRONE_DEFS[kind];
  if (!def) throw new Error(`unknown base-game drone kind '${kind}'`);
  const d = createDrone(def.kind, [from[0], from[1] - 1.2, from[2]], { ownerId, team, def, groundY, yaw: Math.atan2(look[0], look[2]) });
  d.p[0] = from[0]; d.p[1] = from[1]; d.p[2] = from[2];
  const up = kind === DRONE_QUAD ? 2.5 : 0.5;
  d.v[0] = look[0] * throwSpeed; d.v[1] = look[1] * throwSpeed + up; d.v[2] = look[2] * throwSpeed;
  d.bombs = 0;
  return {
    id: id ?? `bgd${++_seq}`, kind, def, ownerId, team,
    d, mode: 'auto', state: 'launch', stateT: 0,
    target: null,        // [x, y, z] the owner sent it to
    flyer: null,         // flight-model body while manual
    input: { pitch: 0, roll: 0, yaw: 0, throttle: 0, sweep: false, flap: false },
    done: false, crash: null,
    autoSpeed: Math.hypot(d.v[0], d.v[1], d.v[2]),   // the wing's airspeed under autonomy, ramped, never snapped
  };
}

// cruiseTo sets |v| to whatever speed it is handed every step, so a hand-launched wing has to be
// handed a speed that grows from the throw at the plane's own full-thrust acceleration.
function autoSpeed(rec, step) {
  const af = AIRFRAMES[rec.def.airframe];
  const accel = af?.thrustMax && af?.mass ? af.thrustMax / af.mass : 20;
  rec.autoSpeed = Math.min(rec.def.speed, (rec.autoSpeed ?? 0) + accel * step);
  return rec.autoSpeed;
}

function enter(rec, state) { if (rec.state !== state) { rec.state = state; rec.stateT = 0; } setState(rec.d, state); }

// Keep the drone above the ground under it. Autonomy states already fly at an altitude above
// `groundY`; this is the backstop for a throw into a slope and for the manual stepper's own clamp
// being softer than the def's.
function floor(rec, world) {
  const d = rec.d;
  const g = world.groundY(d.p[0], d.p[2]);
  d.groundY = g;
  const minY = g + rec.def.minAgl;
  if (d.p[1] < minY) { d.p[1] = minY; if (d.v[1] < 0) d.v[1] = 0; }
}

function shadowPoint(rec, world, out) {
  const yaw = world.ownerYaw || 0, def = rec.def;
  out[0] = world.ownerPos[0] - Math.sin(yaw) * def.shadowOffset;
  out[1] = world.groundY(world.ownerPos[0], world.ownerPos[2]) + def.shadowAlt;
  out[2] = world.ownerPos[2] - Math.cos(yaw) * def.shadowOffset;
  return out;
}
const _pt = [0, 0, 0];

// One tick. `world` = { ownerPos, ownerYaw, ownerAlive, groundY(x, z), input? }. Mutates `rec`;
// returns { crash } when it hits the ground dead.
export function stepBaseGameDrone(rec, dt, world) {
  const d = rec.d, def = rec.def;
  const step = Math.max(0, Number(dt) || 0);
  if (rec.done) return { crash: null };
  rec.stateT += step;
  d.age += step; d.stateT += step;
  d.groundY = world.groundY(d.p[0], d.p[2]);
  const ownerAlive = world.ownerAlive !== false && Array.isArray(world.ownerPos);
  if (!ownerAlive && rec.state !== 'deadstick') {
    if (rec.mode === 'manual') releaseDrone(rec);
    // No pilot: the quad was being flown and drops; the wing keeps circling where it is.
    if (rec.kind === DRONE_QUAD) cripple(rec, world);
    else { rec.target = [d.p[0], d.p[1], d.p[2]]; enter(rec, 'hold'); }
  }

  if (rec.state === 'deadstick') {
    const out = stepBotDrone(d, step, { groundY: d.groundY, holdFire: true });
    if (out.crash) { rec.crash = out.crash; rec.done = true; }
    return { crash: rec.crash };
  }
  if (rec.mode === 'manual') {
    stepManual(rec, step, world);
    return { crash: null };
  }

  switch (rec.state) {
    case 'launch': {
      if (rec.kind === DRONE_QUAD) {
        // Ballistic until the rotors catch, then climb straight to the shadow point.
        if (rec.stateT < def.catchS) { d.v[1] -= G * step; advance(d, step); break; }
        hoverTo(d, ...shadowPoint(rec, world, _pt), step);
        if (rec.stateT > def.catchS + 1.5) enter(rec, 'follow');
      } else {
        // Hand-launched: climb while circling the owner, so it never flies off to gain height.
        orbitAround(d, world.ownerPos[0], world.ownerPos[2], def.orbitRadius, def.cruiseAlt, step, autoSpeed(rec, step));
        if (d.p[1] >= d.groundY + def.cruiseAlt - 3) enter(rec, 'follow');
      }
      advance(d, step);
      break;
    }
    case 'follow': {
      if (rec.kind === DRONE_QUAD) {
        d.faceYaw = world.ownerYaw || 0;
        hoverTo(d, ...shadowPoint(rec, world, _pt), step);
      } else {
        d.faceYaw = null;
        orbitAround(d, world.ownerPos[0], world.ownerPos[2], def.orbitRadius, def.cruiseAlt, step, autoSpeed(rec, step));
      }
      advance(d, step);
      break;
    }
    case 'goto': {
      const t = rec.target;
      if (!t) { enter(rec, 'follow'); break; }
      d.faceYaw = null;
      const gy = world.groundY(t[0], t[2]);
      if (rec.kind === DRONE_QUAD) {
        const dist = hoverTo(d, t[0], gy + def.holdAlt, t[2], step, def.speed);
        if (dist < 2) enter(rec, 'hold');
      } else {
        const flat = cruiseTo(d, t[0], t[2], def.holdAlt, step, autoSpeed(rec, step));
        if (flat < def.orbitRadius) enter(rec, 'hold');
      }
      advance(d, step);
      break;
    }
    case 'hold': {
      const t = rec.target;
      if (!t) { enter(rec, 'follow'); break; }
      const gy = world.groundY(t[0], t[2]);
      if (rec.kind === DRONE_QUAD) { d.faceYaw = null; hoverTo(d, t[0], gy + def.holdAlt, t[2], step); }
      else orbitAround(d, t[0], t[2], def.orbitRadius, def.holdAlt, step, autoSpeed(rec, step));
      advance(d, step);
      break;
    }
    case 'return': {
      if (!ownerAlive) { enter(rec, 'hold'); break; }
      if (rec.kind === DRONE_QUAD) {
        const dist = hoverTo(d, ...shadowPoint(rec, world, _pt), step, def.speed);
        if (dist < 3) enter(rec, 'follow');
      } else {
        const flat = cruiseTo(d, world.ownerPos[0], world.ownerPos[2], def.cruiseAlt, step, autoSpeed(rec, step));
        if (flat < def.orbitRadius * 1.5) enter(rec, 'follow');
      }
      advance(d, step);
      break;
    }
    default: enter(rec, 'follow');
  }
  floor(rec, world);
  return { crash: null };
}

// ─── orders ──────────────────────────────────────────────────────────────────
export function sendDroneTo(rec, point) {
  if (rec.done || rec.state === 'deadstick' || !Array.isArray(point)) return false;
  rec.target = [Number(point[0]) || 0, Number(point[1]) || 0, Number(point[2]) || 0];
  if (rec.mode === 'manual') releaseDrone(rec);
  enter(rec, 'goto');
  return true;
}
export function recallDrone(rec) {
  if (rec.done || rec.state === 'deadstick') return false;
  rec.target = null;
  if (rec.mode === 'manual') releaseDrone(rec);
  enter(rec, 'return');
  return true;
}

// ─── manual: the flight-model handoff ────────────────────────────────────────
// Position and velocity are metres and m/s on both sides; only attitude converts. bot-drones heading
// is atan2(vx, vz) (+Z forward), flight-model flies nose -Z, so the quaternion is built by looking
// down the heading vector the camera way.
const _m = new THREE.Matrix4(), _eye = new THREE.Vector3(), _at = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _qBank = new THREE.Quaternion(), _fwd = new THREE.Vector3(), _axis = new THREE.Vector3();
export function quatFromHeading(q, yaw, pitch, bank) {
  const cp = Math.cos(pitch);
  _at.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  _eye.set(0, 0, 0);
  _m.lookAt(_eye, _at, _up);
  q.setFromRotationMatrix(_m);
  _fwd.set(0, 0, -1).applyQuaternion(q);
  q.premultiply(_qBank.setFromAxisAngle(_fwd, bank));   // roll about the nose; sign matches headingFromQuat
  return q;
}
export function headingFromQuat(q, out) {
  _fwd.set(0, 0, -1).applyQuaternion(q);
  _axis.set(1, 0, 0).applyQuaternion(q);   // right
  _at.set(0, 1, 0).applyQuaternion(q);     // up
  out.yaw = Math.atan2(_fwd.x, _fwd.z);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
  out.bank = Math.atan2(-_axis.y, _at.y);
  return out;
}

export function takeOverDrone(rec, world) {
  if (rec.done || rec.state === 'deadstick' || rec.mode === 'manual') return false;
  const d = rec.d;
  setHeightSource((x, z) => world.groundY(x, z));
  const f = makeFlyer(rec.def.airframe, { x: d.p[0], z: d.p[2], team: rec.team });
  f.p.set(d.p[0], d.p[1], d.p[2]);
  f.v.set(d.v[0], d.v[1], d.v[2]);
  quatFromHeading(f.q, d.yaw, d.pitch, 0);   // bot-drones bank is cosmetic; a real roll here starts a turn
  syncAxes(f);
  d.bank = 0;
  // The airframe's idle throttle, exactly as the sim's makeFlyer starts you: the quad idles above
  // hover and climbs until you pull back, which is the sim's feel and not a special case here.
  f.throttle = f.af.idleThrottle;
  rec.flyAcc = 0;
  if (rec.assist === undefined) rec.assist = true;
  f.armed = false;
  rec.flyer = f;
  rec.mode = 'manual';
  enter(rec, 'manual');
  return true;
}

export function releaseDrone(rec) {
  if (rec.mode !== 'manual') return false;
  const f = rec.flyer, d = rec.d;
  if (f) {
    d.p[0] = f.p.x; d.p[1] = f.p.y; d.p[2] = f.p.z;
    d.v[0] = f.v.x; d.v[1] = f.v.y; d.v[2] = f.v.z;
    headingFromQuat(f.q, d);
    rec.autoSpeed = Math.hypot(d.v[0], d.v[1], d.v[2]);   // autonomy resumes at the speed it was handed
    if (f.crashed) { rec.flyer = null; rec.mode = 'auto'; rec.d.state = 'deadstick'; rec.state = 'deadstick'; crippleDrone(d, { wild: false }); return true; }
  }
  rec.flyer = null;
  rec.mode = 'auto';
  enter(rec, rec.target ? 'goto' : (rec.kind === DRONE_QUAD ? 'return' : 'follow'));
  return true;
}

const _h = { yaw: 0, pitch: 0, bank: 0 };
function stepManual(rec, dt, world) {
  const f = rec.flyer, d = rec.d, inp = world.input || rec.input;
  setHeightSource((x, z) => world.groundY(x, z));
  f.input.pitch = clamp1(inp.pitch); f.input.roll = clamp1(inp.roll);
  f.input.yaw = clamp1(inp.yaw); f.input.throttle = clamp1(inp.throttle);
  f.input.flap = !!inp.flap; f.input.sweep = !!inp.sweep;   // the sim's Shift and Q, not dropped
  // Fixed 1/120 s substeps, as the sim integrates: the rate lag `min(1, dt*rateResponse)` and the
  // Euler forces are step-size dependent, so one long Solo frame is not two short ones.
  rec.flyAcc = (rec.flyAcc || 0) + dt;
  let steps = 0;
  while (rec.flyAcc + 1e-9 >= MANUAL_STEP && steps < 12) { stepFlyer(f, MANUAL_STEP, rec.assist !== false); rec.flyAcc -= MANUAL_STEP; steps++; }
  d.p[0] = f.p.x; d.p[1] = f.p.y; d.p[2] = f.p.z;
  d.v[0] = f.v.x; d.v[1] = f.v.y; d.v[2] = f.v.z;
  headingFromQuat(f.q, _h);
  d.yaw = _h.yaw; d.pitch = _h.pitch; d.bank = _h.bank;
  // No floor of our own under the stick: the flight model's ground rule (crash at speed, a soft
  // clamp otherwise) is the sim's, and an extra clamp here made the two paths diverge at 36 s.
  // The flight model's own ground contact is a crash test at speed and a soft clamp otherwise;
  // a crash here is a drone flown into a hill, and it comes down dead.
  if (f.crashed) { releaseDrone(rec); }
}
const clamp1 = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
const MANUAL_STEP = 1 / 120;

// ─── damage ──────────────────────────────────────────────────────────────────
// `roll` in [0,1) decides deadstick-or-break like bot-viewer-v3; the caller owns the randomness.
export function damageBaseGameDrone(rec, amount, { roll = 1, deadstickChance = 0.34, wildShare = 0.5 } = {}) {
  if (rec.done || rec.state === 'deadstick') return { dead: false, deadstick: false };
  rec.d.hp -= Math.max(0, Number(amount) || 0);
  if (rec.d.hp > 0) return { dead: false, deadstick: false };
  if (rec.mode === 'manual') releaseDrone(rec);
  if (roll < deadstickChance) {
    cripple(rec, null, { wild: roll < deadstickChance * wildShare });
    return { dead: true, deadstick: true };
  }
  rec.done = true;
  rec.crash = [rec.d.p[0], rec.d.p[1], rec.d.p[2]];
  return { dead: true, deadstick: false };
}
function cripple(rec, world, opts = { wild: false }) {
  if (rec.mode === 'manual') releaseDrone(rec);
  crippleDrone(rec.d, { wild: opts.wild, phase: [rec.d.age % TAU, (rec.d.age * 2.1) % TAU, (rec.d.age * 4.2) % TAU] });
  rec.state = 'deadstick'; rec.stateT = 0;
}

// ─── wire ────────────────────────────────────────────────────────────────────
export function droneWireState(rec) {
  const d = rec.d;
  return {
    id: rec.id, kind: rec.kind, owner: rec.ownerId, team: rec.team,
    p: [d.p[0], d.p[1], d.p[2]], v: [d.v[0], d.v[1], d.v[2]],
    yaw: d.yaw, pitch: d.pitch, bank: d.bank,
    hp: d.hp, mode: rec.mode, state: rec.state,
    target: rec.target ? [...rec.target] : null,
    // Under the stick the attitude goes as the physics quaternion: three angles cannot say which way
    // up an inverted aircraft is, and smoothing them rolled the drawn craft back over mid-loop.
    q: rec.flyer ? [rec.flyer.q.x, rec.flyer.q.y, rec.flyer.q.z, rec.flyer.q.w] : null,
  };
}
