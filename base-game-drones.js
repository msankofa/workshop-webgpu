// base-game-drones.js — the player's thrown quadcopter and hand-launched UAV, and the Sentinel the
// dev gun spawns into orbit over a player. One drone record,
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
export const DRONE_SENTINEL = 'sentinel';
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
  // The Sentinel is a world drone: the room owner's dev gun puts it into orbit over a player at a
  // preset height and ring and nobody throws it (`world: true` is what the room caps and clears);
  // its owner takes the stick, sends and recalls it like any other drone. Same
  // plane airframe and orbit autonomy as the UAV at ten times the span; cruiseAlt / orbitRadius
  // here are the `low` preset and are overridden per record from the request.
  [DRONE_SENTINEL]: Object.freeze({
    ...DRONE_DEFS[DRONE_LOITER], kind: DRONE_LOITER, label: 'Sentinel', airframe: 'plane', mesh: 'sentinel',
    // A loiter speed, not the plane's 120 m/s circuit: at `turn` rad/s the tightest ring is speed/turn,
    // and the low preset's 400 m ring has to be flyable (70 / 0.35 = 200 m).
    speed: 70, turn: 0.35, climbRate: 20, cruiseAlt: 150, orbitRadius: 400, orbitLeadRad: 0.3,
    holdAlt: 150, minAgl: 20,
    hp: AIRFRAMES.plane.hp * 4, bodyRadius: 8, meshScale: 1, world: true,
    // The rack. `turn` is what makes it a missile rather than a rocket, and speed / turn is its
    // turning circle: 40 m here, because from 150 m up a player aiming at the ground directly below
    // is inside anything wider and the round simply cannot get there.
    agm: { rounds: 4, speed: 120, turn: 3.0, blastRadius: 10, damage: 120, life: 30, radius: 0.3, dropS: 0.35, gapS: 1.2 },
    crashBlast: { radius: 16, damage: 90 },   // a 20 m wing full of fuel
    catchS: 0,
  }),
});


const TAU = Math.PI * 2;
// Close enough to the ground to count as on it. The flight model holds a craft this far up while it
// is being flown, so a drone that settles onto the deck sits here rather than crashing.
const GROUND_TOUCH = 1.5;
// How long a drone may rest on the ground under the stick before it is a crash. A drone is not an
// aeroplane with wheels: putting one on the ground is putting it into the ground. Without this a
// player who flew one down gently skidded along the surface for the best part of a minute -- the
// flight model only calls it a crash above 9 m/s down or 34 m/s forward, and a gentle arrival is
// neither, so nothing ever ended it.
const GROUND_REST_S = 0.6;
let _seq = 0;

// `from` is the hand, `look` the throw direction (unit), both global. The drone leaves at
// `throwSpeed` along it, plus a little up for the quad so a flat throw still clears the thrower.
// `alt` / `radius` replace the def's orbit for this record (the Sentinel's presets); `airborne`
// starts it at its circuit speed already in `follow`, the way a world drone appears, not thrown.
export function createBaseGameDrone(kind, { ownerId = null, team = 0, from, look = [0, 0, -1], throwSpeed = 8, groundY = 0, id = null, alt = null, radius = null, airborne = false } = {}) {
  let def = BASE_GAME_DRONE_DEFS[kind];
  if (!def) throw new Error(`unknown base-game drone kind '${kind}'`);
  if (Number.isFinite(alt) || Number.isFinite(radius)) {
    def = Object.freeze({ ...def, cruiseAlt: Number.isFinite(alt) ? alt : def.cruiseAlt, holdAlt: Number.isFinite(alt) ? alt : def.holdAlt, orbitRadius: Number.isFinite(radius) ? radius : def.orbitRadius });
  }
  const d = createDrone(def.kind, [from[0], from[1] - 1.2, from[2]], { ownerId, team, def, groundY, yaw: Math.atan2(look[0], look[2]) });
  d.p[0] = from[0]; d.p[1] = from[1]; d.p[2] = from[2];
  const up = kind === DRONE_QUAD ? 2.5 : 0.5;
  const speed = airborne ? def.speed : throwSpeed;
  d.v[0] = look[0] * speed; d.v[1] = airborne ? 0 : look[1] * throwSpeed + up; d.v[2] = look[2] * speed;
  d.bombs = 0;
  return {
    id: id ?? `bgd${++_seq}`, kind, def, ownerId, team,
    d, mode: 'auto', state: airborne ? 'follow' : 'launch', stateT: 0,
    target: null,        // [x, y, z] the owner sent it to
    flyer: null,         // flight-model body while manual
    input: { pitch: 0, roll: 0, yaw: 0, throttle: 0, sweep: false, flap: false },
    done: false, crash: null,
    groundS: 0,          // how long it has been sitting on the ground under the stick
    agm: def.agm ? { left: def.agm.rounds, cool: 0 } : null,   // the rack, if this kind has one
    autoSpeed: Math.hypot(d.v[0], d.v[1], d.v[2]),   // the wing's airspeed under autonomy, ramped, never snapped
  };
}

// A world drone appears on its ring: `radius` ahead of the player along `look` (unit, flat), at
// `alt` over the ground there, already flying the ring's tangent at circuit speed.
export function spawnWorldDrone(kind, { ownerId = null, team = 0, at, look = [0, 0, -1], alt = null, radius = null, groundAt = () => 0, id = null } = {}) {
  const def = BASE_GAME_DRONE_DEFS[kind];
  if (!def) throw new Error(`unknown base-game drone kind '${kind}'`);
  const r = Number.isFinite(radius) ? radius : def.orbitRadius, h = Number.isFinite(alt) ? alt : def.cruiseAlt;
  const flat = Math.hypot(look[0], look[2]) || 1;
  const fx = look[0] / flat, fz = look[2] / flat;
  const px = at[0] + fx * r, pz = at[2] + fz * r;
  const from = [px, groundAt(px, pz) + h, pz];
  const rec = createBaseGameDrone(kind, { ownerId, team, from, look: [fz, 0, -fx], groundY: groundAt(px, pz), id, alt: h, radius: r, airborne: true });
  // Leave along the ring in the direction the record will orbit, or the first thing it does is a
  // 180-degree turn that carries it a kilometre outside the ring.
  const sgn = rec.d.orbitSign || 1, speed = rec.def.speed;
  rec.d.v[0] = -sgn * fz * speed; rec.d.v[1] = 0; rec.d.v[2] = sgn * fx * speed;
  rec.d.yaw = Math.atan2(rec.d.v[0], rec.d.v[2]);
  rec.autoSpeed = speed;
  return rec;
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
    // The backstop. A falling drone crashes on its own, and every path here has been walked in a
    // test -- but a dead drone left hanging in the air is the one failure a player actually
    // notices, so being under the ground, or below it, ends it regardless of what the fall thought.
    else if (d.p[1] <= d.groundY + GROUND_TOUCH) {
      rec.crash = [d.p[0], d.groundY, d.p[2]];
      rec.done = true;
      d.done = true;
    }
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
    d.bank = -d.bank;   // the physics roll into bot-drones' cosmetic sign (positive = left turn), which the view negates back
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
  d.yaw = _h.yaw; d.pitch = _h.pitch; d.bank = -_h.bank;   // record bank is bot-drones' sign; the view draws `q` under the stick anyway
  // No floor of our own under the stick: the flight model's ground rule (crash at speed, a soft
  // clamp otherwise) is the sim's, and an extra clamp here made the two paths diverge at 36 s.
  // The flight model's own ground contact is a crash test at speed and a soft clamp otherwise;
  // a crash here is a drone flown into a hill, and it comes down dead.
  if (f.crashed) { releaseDrone(rec); return; }
  // And a soft arrival is still an arrival. The clamp holds it just above the ground with the
  // engine running, so time spent there is what says "this one is down", not the speed it got there
  // at. Leaving the ground clears the clock, so a low pass is not a crash.
  const clear = f.af.size * 3 + 1.2;
  const onDeck = f.p.y <= world.groundY(f.p.x, f.p.z) + clear + 0.05;
  rec.groundS = onDeck ? (rec.groundS || 0) + dt : 0;
  if (rec.groundS >= GROUND_REST_S) {
    f.crashed = true;
    releaseDrone(rec);
  }
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
  // A KILLED DRONE FALLS. It used to end on the spot on a high roll, which put the explosion
  // wherever it happened to be hit -- a blast two hundred metres up, with nothing on the ground to
  // show for it. The sim does not do that: a downed aircraft becomes a wreck that comes down and
  // goes off where it lands, and that is what a player is looking at when he shoots one. The roll
  // now only picks HOW it falls: a wild one still has power and wanders off, a broken one tumbles.
  // Only a drone already on the deck ends where it is, because it has nowhere to fall to.
  const agl = rec.d.p[1] - (Number.isFinite(rec.d.groundY) ? rec.d.groundY : 0);
  if (agl <= GROUND_TOUCH) {
    rec.done = true;
    rec.crash = [rec.d.p[0], rec.d.p[1], rec.d.p[2]];
    return { dead: true, deadstick: false };
  }
  cripple(rec, null, { wild: roll < deadstickChance * wildShare });
  return { dead: true, deadstick: true };
}
function cripple(rec, world, opts = { wild: false }) {
  if (rec.mode === 'manual') releaseDrone(rec);
  crippleDrone(rec.d, { wild: opts.wild, phase: [rec.d.age % TAU, (rec.d.age * 2.1) % TAU, (rec.d.age * 4.2) % TAU] });
  rec.state = 'deadstick'; rec.stateT = 0;
}

// ─── the hit volume ──────────────────────────────────────────────────────────
//
// What a bullet, a rocket or a blast can hit. `def.bodyRadius` has been on every drone def since
// they were written and nothing read it: until now a drone was scenery you could shoot straight
// through. It is a sphere at the drone's position, which is what `combat.js`'s capsule test
// degenerates to when the height is zero, and it is the shape the flight sim uses too (`hitRadius`).
// A 20 m flying wing is not a sphere, but at the ranges anything shoots at one from, it reads.

// One drone as a `resolveHitscan` mob entry, or null if it is not there to be hit.
export function droneHitVolume(rec) {
  if (!rec || rec.done) return null;
  const r = rec.def.bodyRadius;
  if (!(r > 0)) return null;
  return { id: rec.id, p: [rec.d.p[0], rec.d.p[1], rec.d.p[2]], r, h: 0, alive: true, ownerId: rec.ownerId, kind: rec.kind };
}

// Every live drone in a map or list, as mob entries. `exclude` skips one id (a shooter never shoots
// the drone he is sitting in).
export function droneHitVolumes(drones, exclude = null) {
  const out = [];
  for (const rec of (drones?.values ? drones.values() : drones) || []) {
    if (!rec || rec.id === exclude) continue;
    const v = droneHitVolume(rec);
    if (v) out.push(v);
  }
  return out;
}

// Blast damage on a drone: the same falloff a player takes, so one number tunes both. Returns the
// damage dealt, which is zero outside the radius.
export function blastDamageOnDrone(rec, point, radius, damage) {
  const v = droneHitVolume(rec);
  if (!v || !(radius > 0)) return 0;
  // Surface distance, not centre distance: a blast beside a 20 m wing has hit the wing.
  const d = Math.max(0, Math.hypot(point[0] - v.p[0], point[1] - v.p[1], point[2] - v.p[2]) - v.r);
  if (d >= radius) return 0;
  return damage * (1 - d / radius);
}

// ─── the air-to-ground missile ───────────────────────────────────────────────
//
// The missile is not a drone record. It is one of the game's ordinary projectiles
// (bot-projectiles.js flying entity-types/combat-projectile.js), which already knows how to hit a
// player rig, hit the ground, and hand a detonation to whoever asked for one — so a missile inherits
// every one of those paths instead of growing its own. All this section adds is a rack that says
// when one may leave, and a steering step that turns its velocity toward an aim point.
//
// Both the server and Solo call the same two functions, which is why they live here and not in
// either page.

// Is the rack ready? A drone with no rack, one that is wrecked, or one still inside the gap between
// rounds answers no.
export function agmReady(rec, now = 0) {
  if (!rec || rec.done || !rec.agm || !rec.def.agm) return false;
  if (rec.state === 'deadstick') return false;
  return rec.agm.left > 0 && now >= rec.agm.cool;
}

// Take a round off the rack and describe the projectile to spawn. The caller does the spawning,
// because the server spawns into its room manager and Solo into its own, and neither should know
// about the other. Returns null when the rack is not ready.
//
// It leaves from under the belly with the aircraft's own velocity plus a short drop, so the first
// thing the camera sees is the wing going away above it rather than the missile sitting still.
export function fireAgm(rec, aim, now = 0) {
  if (!agmReady(rec, now)) return null;
  if (!Array.isArray(aim) || aim.length !== 3 || !aim.every(Number.isFinite)) return null;
  const cfg = rec.def.agm, d = rec.d;
  rec.agm.left -= 1;
  rec.agm.cool = now + cfg.gapS;
  const origin = [d.p[0], d.p[1] - 1.0, d.p[2]];
  // Aimed at the target from the start, at the aircraft's speed: the motor is what takes it to
  // `speed`, and the steering below does that on the first tick.
  let dx = aim[0] - origin[0], dy = aim[1] - origin[1], dz = aim[2] - origin[2];
  const range = Math.hypot(dx, dy, dz) || 1;
  dx /= range; dy /= range; dz /= range;
  const launch = Math.max(cfg.speed * 0.35, Math.hypot(d.v[0], d.v[1], d.v[2]));
  return {
    origin, dir: [dx, dy, dz], speed: launch,
    blastRadius: cfg.blastRadius, damage: cfg.damage, life: cfg.life, radius: cfg.radius,
    gravity: 0, weaponId: 'agm', ownerId: rec.ownerId,
    // What `stepGuidedProjectiles` reads. `aim` is live: moving it after launch steers the missile.
    guide: { aim: [...aim], turn: cfg.turn, speed: cfg.speed, droneId: rec.id, armS: cfg.dropS },
  };
}

// Turn a velocity toward a point, by at most `turn` radians this step, then set its length to
// `speed`. Written against plain numbers so it can be tested without a projectile at all.
//
// Rotating in the plane of the two vectors (rather than steering each axis toward the target) is
// what keeps the speed constant and the path an arc: an axis-wise lerp cuts the corner and arrives
// slow.
const _gv = [0, 0, 0];
export function steerToward(vel, from, aim, turn, speed, dt, out = _gv) {
  let vx = vel[0], vy = vel[1], vz = vel[2];
  const vlen = Math.hypot(vx, vy, vz) || 1;
  let dx = aim[0] - from[0], dy = aim[1] - from[1], dz = aim[2] - from[2];
  const dlen = Math.hypot(dx, dy, dz);
  if (dlen < 1e-6) { out[0] = vx; out[1] = vy; out[2] = vz; return out; }
  vx /= vlen; vy /= vlen; vz /= vlen;
  dx /= dlen; dy /= dlen; dz /= dlen;
  const dot = Math.max(-1, Math.min(1, vx * dx + vy * dy + vz * dz));
  const angle = Math.acos(dot);
  const step = Math.min(angle, turn * dt);
  let nx, ny, nz;
  if (angle < 1e-5) { nx = dx; ny = dy; nz = dz; }
  else {
    // Gram-Schmidt: the component of the desired direction across the current one, normalised,
    // is the axis to rotate along inside their common plane.
    let px = dx - vx * dot, py = dy - vy * dot, pz = dz - vz * dot;
    const plen = Math.hypot(px, py, pz);
    if (plen < 1e-9) { nx = dx; ny = dy; nz = dz; }   // exactly reversed: snap rather than stall
    else {
      px /= plen; py /= plen; pz /= plen;
      const c = Math.cos(step), sn = Math.sin(step);
      nx = vx * c + px * sn; ny = vy * c + py * sn; nz = vz * c + pz * sn;
    }
  }
  out[0] = nx * speed; out[1] = ny * speed; out[2] = nz * speed;
  return out;
}

// One tick of guidance over a projectile manager's list. Anything without a `guide` is left alone,
// so ordinary grenades and rockets share the list untouched.
//
// It also carries the proximity fuse. A guided round is aimed at a POINT, and the point is usually
// on the ground, so the ordinary impact paths would do — except where nothing answers a raycast
// there (a room with no height function, the sky over a hole in the terrain) the round would sail
// through its target and fly until its life ran out. Arriving is therefore its own end: the fuse
// zeroes the entity's remaining life, and the entity detonates itself through the same path it uses
// for any other airburst, so every consumer of a detonation keeps working unchanged.
const FUSE_DIST = 25;     // metres: inside this, a closing rate that has gone to zero means arrival
const FUSE_TOUCH = 2.5;   // and this close it has simply arrived, whatever the closing rate says
export function stepGuidedProjectiles(list, dt) {
  if (!Array.isArray(list) || !(dt > 0)) return 0;
  let n = 0;
  for (const proj of list) {
    const g = proj?.guide;
    if (!g || !proj.sim || !proj.transform) continue;
    // A short unguided drop, so it clears the wing it came off before the motor takes over.
    g.age = (g.age || 0) + dt;
    if (g.age < (g.armS || 0)) continue;
    steerToward([proj.sim.vx, proj.sim.vy, proj.sim.vz], proj.transform.p, g.aim, g.turn, g.speed, dt, _gv);
    proj.sim.vx = _gv[0]; proj.sim.vy = _gv[1]; proj.sim.vz = _gv[2];
    n++;
    // The fuse. A sphere alone is not enough: at 120 m/s a 1/60 s step is two metres, so a small
    // sphere is stepped straight over. The closing rate going negative is what actually says
    // "past it", and the distance gate is what stops a distant course correction reading as arrival.
    const p = proj.transform.p;
    const dx = g.aim[0] - p[0], dy = g.aim[1] - p[1], dz = g.aim[2] - p[2];
    const dist = Math.hypot(dx, dy, dz);
    const closing = dx * proj.sim.vx + dy * proj.sim.vy + dz * proj.sim.vz;
    if (dist <= FUSE_TOUCH || (dist <= (g.fuseDist ?? FUSE_DIST) && closing <= 0)) proj.sim.life = 0;
  }
  return n;
}

// ─── wire ────────────────────────────────────────────────────────────────────
export function droneWireState(rec) {
  const d = rec.d;
  return {
    id: rec.id, kind: rec.kind, owner: rec.ownerId, team: rec.team,
    p: [d.p[0], d.p[1], d.p[2]], v: [d.v[0], d.v[1], d.v[2]],
    // The record's bank is bot-drones.js's cosmetic one, positive for a LEFT turn: it was written for
    // bot-viewer's lookAt + rotateY(PI) + rotateZ pose, where the flip mirrors the roll axis. The wire
    // carries the physics sign (quatFromHeading: positive right wing down) so the view draws every
    // drone banked into its turn; the 20 m Sentinel made the old inversion obvious where the 2 m UAV
    // at 300 m never had. Solo's ingestRecords does the same flip.
    yaw: d.yaw, pitch: d.pitch, bank: -d.bank,
    hp: d.hp, mode: rec.mode, state: rec.state,
    agm: rec.agm ? rec.agm.left : null,   // rounds left, or null for a kind with no rack
    target: rec.target ? [...rec.target] : null,
    // Under the stick the attitude goes as the physics quaternion: three angles cannot say which way
    // up an inverted aircraft is, and smoothing them rolled the drawn craft back over mid-loop.
    q: rec.flyer ? [rec.flyer.q.x, rec.flyer.q.y, rec.flyer.q.z, rec.flyer.q.w] : null,
  };
}
