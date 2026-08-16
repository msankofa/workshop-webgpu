// flight-model.js — the rigid-body core. One integrator, three airframes.
//
// Everything that decides where an aircraft is and which way it points. No meshes, no materials, no
// DOM: the viewer reads `f.p` and `f.q` and draws them. Because of that this runs under Node, which
// is how `test-flight-model.mjs` covers trim, stall, hover and the wreck fall without a GPU.
//
// It imports three for Vector3/Quaternion only (Node resolves the bare specifier from
// node_modules), `flight-airframes.js` for the tables, `flight-terrain.js` for the ground, and
// `flight-combat.js` for the starting loadout. That last edge is the only one between model and
// combat, and it points one way.

import * as THREE from 'three';
import { getAirframe, validateAirframe, RHO, G } from './flight-airframes.js';
import { heightAt, agl } from './flight-terrain.js';
import { COMBAT, fullBombLoad, gunFor, makeMounts, resetMounts } from './flight-combat.js';
import { fullDroneLoad, DRONE_KINDS } from './flight-drones.js';

export const FWD = new THREE.Vector3(0, 0, -1);
export const UP = new THREE.Vector3(0, 1, 0);
export const RIGHT = new THREE.Vector3(1, 0, 0);

let nextFlyerId = 1;

export function makeFlyer(afKey, opts = {}) {
  const af = getAirframe(afKey);
  // Checked at construction, never in the step loop: an airframe missing a field its own force
  // generators read produces NaN a frame later, and a NaN position is a much worse error message
  // than this one.
  const bad = validateAirframe(afKey, af);
  if (bad.length) throw new Error(`airframe '${afKey}' is not flyable:\n  ${bad.join('\n  ')}`);
  const f = {
    afKey, af,
    p: new THREE.Vector3(opts.x || 0, 0, opts.z || 0),
    v: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    rates: { pitch: 0, yaw: 0, roll: 0 },
    input: { pitch: 0, roll: 0, yaw: 0, throttle: 0, flap: false, sweep: false },
    fwd: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(),
    throttle: af.idleThrottle,
    alpha: 0, beta: 0, gLoad: 1, airspeed: 0, stallFrac: 0,
    sweep: 0, flapPhase: 0, stamina: 1,
    crashed: false, crashTimer: 0,
    // a downed aircraft is a falling object with its own integrator, not a hidden mesh
    wreck: false, wreckSpin: new THREE.Vector3(), wreckFwd: new THREE.Vector3(0, 0, -1),
    wreckFire: 0, wreckSmoke: 0, wreckPop: 0, wreckAge: 0,
    ai: null, mesh: null,
    // combat
    id: nextFlyerId++, team: opts.team ?? 0, hp: af.hp, dead: false, deadTimer: 0, ab: 0,
    armed: true,
    // Resolved once and carried, so nothing downstream has to look a gun up or fall back to a
    // default. An unknown gun key throws here, at construction, like an unknown airframe.
    gun: gunFor(af.gun),
    ammo: gunFor(af.gun)?.ammo ?? 0, missiles: COMBAT.missileMax, flares: COMBAT.flareMax,
    // side/turret guns, each with its own cooldown and magazine; empty for anything without them
    mounts: makeMounts(af),
    drones: fullDroneLoad(), droneCool: Object.fromEntries(DRONE_KINDS.map((k) => [k, 0])),
    bombs: fullBombLoad(), bombCool: 0,
    gunCool: 0, mslCool: 0, flareCool: 0, smokeTimer: 0,
    lockTarget: null, lockProgress: 0, threat: null, lockedBy: null, foe: null,
  };
  f.p.y = heightAt(f.p.x, f.p.z) + af.spawn.alt;
  f.q.setFromAxisAngle(UP, opts.heading || 0);
  syncAxes(f);
  f.v.copy(f.fwd).multiplyScalar(af.spawn.speed);
  return f;
}

export function syncAxes(f) {
  f.fwd.copy(FWD).applyQuaternion(f.q);
  f.up.copy(UP).applyQuaternion(f.q);
  f.right.copy(RIGHT).applyQuaternion(f.q);
}

export function smoothstep01(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

const _force = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _dq = new THREE.Quaternion();

// `assist` is the stability assist (weathervaning). It was a module-level flag in the prototype;
// it is a parameter here so nothing about the model depends on hidden state.
export function stepFlyer(f, dt, assist = true) {
  const af = f.af;
  syncAxes(f);

  if (f.crashed) {
    if (f.wreck) return;                  // stepWreck owns position and attitude now
    f.crashTimer += dt;
    f.v.multiplyScalar(Math.max(0, 1 - dt * 2.4));
    return;
  }

  // --- throttle, flap cycle, wing sweep ---
  if (af.thrust === 'flap') {
    const wantFlap = f.input.flap && f.stamina > 0.02;
    if (wantFlap) {
      f.flapPhase += dt * af.flapHz * Math.PI * 2;
      f.stamina = Math.max(0, f.stamina - dt * af.flapDrain);
    } else {
      f.flapPhase += dt * 1.1;                       // slow idle so the wings still breathe
      f.stamina = Math.min(1, f.stamina + dt * af.flapRecover);
    }
    f.throttle = wantFlap ? 1 : 0;
  } else {
    f.throttle = THREE.MathUtils.clamp(f.throttle + f.input.throttle * dt * 0.65, 0, 1);
  }
  const sweepTarget = f.input.sweep ? 1 : 0;
  f.sweep += THREE.MathUtils.clamp(sweepTarget - f.sweep, -1, 1) * Math.min(1, dt * (af.sweepRate || 3));

  // --- airflow ---
  const V = f.v.length();
  f.airspeed = V;
  const qdyn = 0.5 * RHO * V * V;
  const u = f.v.dot(f.fwd), w = f.v.dot(f.up), s = f.v.dot(f.right);
  f.alpha = V > 0.4 ? Math.atan2(-w, u) : 0;
  f.beta = V > 0.4 ? Math.atan2(s, Math.abs(u) + 0.001) : 0;

  _force.set(0, -G * af.mass, 0);

  const area = af.wingArea * (1 - f.sweep * (1 - af.sweepArea));

  // --- lift, and the stall that comes with it ---
  let cl = 0;
  f.stallFrac = 0;
  if (af.lift === 'wing' && V > 0.5) {
    const aAbs = Math.abs(f.alpha);
    const stall = smoothstep01(af.alphaStall, af.alphaHard, aAbs);
    f.stallFrac = stall;
    cl = af.clAlpha * f.alpha * (1 - stall * 0.88);
    _liftDir.copy(f.up).addScaledVector(f.v, -f.up.dot(f.v) / (V * V));
    if (_liftDir.lengthSq() > 1e-8) {
      _force.addScaledVector(_liftDir.normalize(), qdyn * area * cl);
    }
  }

  // --- drag ---
  if (V > 0.05) {
    _tmp.copy(f.v).multiplyScalar(1 / V);
    let drag;
    if (af.lift === 'wing') {
      const cd = af.cd0 * (1 - f.sweep * (1 - af.sweepDrag))
        + af.kInduced * cl * cl
        + af.cdStall * f.stallFrac
        + af.cdBeta * Math.abs(f.beta);
      drag = qdyn * area * cd;
    } else {
      drag = qdyn * af.bluffArea * af.bluffCd;
    }
    _force.addScaledVector(_tmp, -drag);
  }

  // --- thrust ---
  if (af.thrust === 'axial') {
    // afterburner is Shift on the plane, which has no variable geometry to spend it on
    const abWant = f.input.sweep && f.throttle > 0.92 ? 1 : 0;
    f.ab += (abWant - f.ab) * Math.min(1, dt * 2.2);
    _force.addScaledVector(f.fwd, af.thrustMax * f.throttle * (1 + (af.abThrust - 1) * f.ab));
  } else if (af.thrust === 'body-up') {
    _force.addScaledVector(f.up, af.thrustMax * f.throttle);
  } else if (af.thrust === 'flap' && f.throttle > 0) {
    // downstroke only, and mostly FORWARD: a bird's flap is thrust, the wing is what lifts it.
    // Pointing this vector upward instead makes the bird levitate its own flight path into a
    // steepening climb until it stalls, which is what the first version of this did.
    const beat = Math.max(0, Math.sin(f.flapPhase));
    _tmp.copy(f.up).multiplyScalar(0.30).addScaledVector(f.fwd, 0.95).normalize();
    _force.addScaledVector(_tmp, af.flapPower * beat * (1 - f.sweep * 0.8));
  }
  // `thrust: 'none'` is a glider and falls through here deliberately. Any OTHER value would too,
  // which is why `validateAirframe` rejects it at construction — an engine that silently produces
  // no force reads as a physics bug, not as a typo.

  // g-load as felt: everything except gravity, along body up
  f.gLoad = (_force.dot(f.up) + G * af.mass * f.up.y) / (af.mass * G);

  f.v.addScaledVector(_force, dt / af.mass);
  f.p.addScaledVector(f.v, dt);

  // --- attitude: commanded body rates with lag ---
  let tPitch, tYaw, tRoll;
  if (af.control === 'attitude') {
    const pitch = Math.asin(THREE.MathUtils.clamp(f.fwd.y, -1, 1));
    const roll = Math.atan2(-f.right.y, f.up.y);
    tPitch = THREE.MathUtils.clamp((f.input.pitch * af.maxTilt - pitch) * af.tiltGain,
      -af.maxTiltRate, af.maxTiltRate);
    tRoll = THREE.MathUtils.clamp((f.input.roll * af.maxTilt - roll) * af.tiltGain,
      -af.maxTiltRate, af.maxTiltRate);
    tYaw = f.input.yaw * af.maxYawRate;
  } else {
    // authority scales with dynamic pressure: this is what makes a stall take the controls
    const auth = THREE.MathUtils.clamp(qdyn / af.qRef, 0.06, 1.35);
    tPitch = f.input.pitch * af.maxPitchRate * auth;
    tRoll = f.input.roll * af.maxRollRate * auth;
    tYaw = f.input.yaw * af.maxYawRate * auth;
    if (assist) {
      // Weathervane toward the AoA that supports 1 g at THIS speed, not toward zero. Seeking zero
      // means seeking zero lift, which is why an untouched aircraft used to sink. The cap well
      // below the stall angle is what keeps this trim rather than an AoA limiter: too slow and the
      // trim it wants is unavailable, so the nose stays down, it descends and it gets its speed
      // back. The stick can still pull straight past the cap into a real stall.
      // Half of the target is trim for the airframe's REFERENCE speed, which is what gives speed
      // stability: above trim speed that AoA makes more than 1 g, so the nose comes up and a dive
      // pulls out; below it, the nose drops and the speed comes back. Trimming purely to the
      // current speed has no speed reference at all and rides a dive into the ground.
      const denom = qdyn * area * af.clAlpha;
      const qTrim = 0.5 * RHO * af.trimSpeed * af.trimSpeed;
      const trimRef = (af.mass * G) / (qTrim * area * af.clAlpha);
      const trimNow = denom > 1e-3 ? (af.mass * G) / denom : af.alphaStall;
      const trim = THREE.MathUtils.clamp((trimRef + trimNow) * 0.5, 0, af.alphaStall * 0.55);
      tPitch -= (f.alpha - trim) * af.pitchStab * auth;
      tYaw += f.beta * af.yawStab * auth;
    }
  }
  const k = Math.min(1, dt * af.rateResponse);
  f.rates.pitch += (tPitch - f.rates.pitch) * k;
  f.rates.yaw += (tYaw - f.rates.yaw) * k;
  f.rates.roll += (tRoll - f.rates.roll) * k;

  // body axes are right=+X, up=+Y, forward=-Z, so yaw-right and roll-right are negative rotations
  const h = dt * 0.5;
  _dq.set(f.rates.pitch * h, -f.rates.yaw * h, -f.rates.roll * h, 1).normalize();
  f.q.multiply(_dq).normalize();
  syncAxes(f);

  // --- ground ---
  const ground = heightAt(f.p.x, f.p.z);
  const clear = af.size * 3 + 1.2;
  if (f.p.y < ground + clear) {
    const vertical = -f.v.y;
    if (vertical > 9 || f.airspeed > 34) {
      f.crashed = true; f.crashTimer = 0;
    } else {
      f.p.y = ground + clear;
      f.v.y = Math.max(f.v.y, 0);
      f.v.multiplyScalar(Math.max(0, 1 - dt * 1.8));
    }
  }
  if (f.p.y > 6000) { f.p.y = 6000; f.v.y = Math.min(f.v.y, 0); }
}

export function resetFlyer(f) {
  const af = f.af;
  f.crashed = false; f.crashTimer = 0;
  f.dead = false; f.deadTimer = 0; f.hp = af.hp;
  f.ammo = f.gun?.ammo ?? 0; f.missiles = COMBAT.missileMax; f.flares = COMBAT.flareMax;
  resetMounts(f);
  f.drones = fullDroneLoad();
  f.bombs = fullBombLoad(); f.bombCool = 0;
  for (const k of DRONE_KINDS) f.droneCool[k] = 0;
  f.lockTarget = null; f.lockProgress = 0; f.threat = null; f.ab = 0;
  f.wreck = false; f.wreckAge = 0;
  f.p.set(f.p.x, heightAt(f.p.x, f.p.z) + af.spawn.alt, f.p.z);
  f.q.identity(); syncAxes(f);
  f.v.copy(f.fwd).multiplyScalar(af.spawn.speed);
  f.rates.pitch = f.rates.yaw = f.rates.roll = 0;
  f.throttle = af.idleThrottle;
  f.stamina = 1; f.sweep = 0;
}

// ---------------------------------------------------------------------------
// Wrecks
//
// A downed aircraft is three events, not one: it blows up where it was hit, it falls burning, and
// it blows up again when it arrives. Only the middle part needs an integrator, and it is
// deliberately crude — ballistic gravity and linear drag, no lift, no control. There is no wing
// left worth modelling.
// ---------------------------------------------------------------------------

export const WRECK = {
  drag: 0.05,
  spin: 3.6,         // rad/s of tumble, mostly about the roll axis
  fireGap: 0.03,     // seconds between trail flames (short-lived, so this can be fast)
  smokeGap: 0.10,    // seconds between smoke puffs (long-lived, so this must not be)
  popGap: 0.55,      // seconds between secondary pops on the way down
  // A pure backstop, not a lifetime. The fall is ballistic so it always lands eventually; 45 s
  // covers a kill from about 7 km, well past anything reachable here. Measured fall times: 4.9 s
  // from 90 m, 7.6 s from 220 m, 17.6 s from 1100 m, 27.6 s from 2400 m — an earlier value of 22
  // would have cut the high one off and detonated it in mid air, which reads as a bug.
  maxAge: 45,
  // below this height above ground there is no fall to watch, so the kill just detonates
  minAirAgl: 12,
};

export function startWreck(f) {
  f.wreck = true;
  f.wreckAge = 0;
  f.wreckFire = 0;
  f.wreckSmoke = 0;
  f.wreckPop = 0.2;
  f.wreckFwd.set(f.fwd.x, 0, f.fwd.z);
  if (f.wreckFwd.lengthSq() < 1e-6) f.wreckFwd.set(0, 0, -1);
  f.wreckFwd.normalize();
  // the hit knocks it off its flight path and sets it turning, mostly in roll
  f.wreckSpin.set(
    (Math.random() - 0.5) * WRECK.spin * 0.7,
    (Math.random() - 0.5) * WRECK.spin * 0.5,
    (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5) * WRECK.spin);
  f.v.multiplyScalar(0.7);
  f.v.y += 5;
}

const _wq = new THREE.Quaternion();
const _wax = new THREE.Vector3();

// Advances one wreck. Returns what the viewer has to react to this step:
//   { fire, smoke, pop, landed }  — all booleans, all pure consequences of the timers.
// The FX themselves stay in the viewer; the timers live here so they can be tested.
export function stepWreck(f, dt) {
  const out = { fire: false, smoke: false, pop: false, landed: false };
  if (!f.wreck) return out;
  f.wreckAge += dt;

  f.v.y -= G * dt;
  f.v.multiplyScalar(Math.max(0, 1 - WRECK.drag * dt));
  f.p.addScaledVector(f.v, dt);

  _wax.copy(f.wreckSpin);
  const rate = _wax.length();
  if (rate > 1e-4) {
    _wq.setFromAxisAngle(_wax.multiplyScalar(1 / rate), rate * dt);
    f.q.premultiply(_wq);
  }

  // Fire and smoke run on SEPARATE clocks, and the reason is pool arithmetic rather than taste.
  // Fire lasts 0.32 s, so a puff every 0.03 s holds about 11 alive. Smoke lasts nearly 3 s, so on
  // that same clock it would hold about 100 alive — one wreck would consume an entire 96-sprite
  // pool and starve every other effect on screen.
  f.wreckFire -= dt;
  if (f.wreckFire <= 0) { f.wreckFire = WRECK.fireGap; out.fire = true; }
  f.wreckSmoke -= dt;
  if (f.wreckSmoke <= 0) { f.wreckSmoke = WRECK.smokeGap; out.smoke = true; }
  f.wreckPop -= dt;
  if (f.wreckPop <= 0) { f.wreckPop = WRECK.popGap * (0.6 + Math.random()); out.pop = true; }

  const ground = heightAt(f.p.x, f.p.z);
  if (f.p.y <= ground + 1.5 || f.wreckAge > WRECK.maxAge) {
    // snapped down, not clamped up: if the backstop is what fired, the blast still belongs on the
    // ground rather than hanging wherever the wreck happened to be
    f.p.y = ground + 1.5;
    f.wreck = false;
    out.landed = true;
  }
  return out;
}

// whether a kill leaves something to watch fall, or is already on the ground
export function killMakesWreck(f) { return agl(f.p) > WRECK.minAirAgl; }
