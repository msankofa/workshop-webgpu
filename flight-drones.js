// flight-drones.js — the three releasable mini drones: what they chase, and how they move.
//
// Each one answers a threat the aircraft cannot answer itself:
//
//   DECOY        a flying flare dispenser. It does not fight missiles, it feeds them — the flares it
//                drops go into the same pool the seeker already searches, so nothing in the missile
//                code knows a decoy exists. Release it and turn the other way.
//   KAMIKAZE     an unpowered glider aimed at the ground war. It has no engine, so all the energy it
//                will ever have is the altitude and speed you release it with, and it converts that
//                into speed the whole way down. A long shot arrives faster and hits harder than a
//                close one, which is the opposite of every other weapon here.
//   INTERCEPTOR  a missile that hunts missiles. With nothing inbound it holds station off your wing;
//                the moment something is tracking you it goes.
//
// The meshes, the pools, the FX and the sounds stay in the viewer. What lives here is the target
// choice and the trajectory — the parts worth simulating in Node.

import * as THREE from 'three';
import { G, proNavAccel, pickThreat, interceptPoint } from './flight-combat.js';

// `life` is a lifetime in seconds, `turn` a max turn rate in rad/s, `speed` a cruise in m/s.
export const DRONE = {
  // A DECOY THAT CANNOT OUTRUN THE AIRCRAFT IS USELESS. It has to get somewhere the missile would
  // rather go, which means leaving faster than you can, on a diverging heading. This one is a rocket
  // with flares bolted to it: it boosts to missile speed and holds there.
  //
  // `flareGap` is not a taste setting. At this speed it sets the SPACING of the trail — 0.6 s at
  // 470 m/s is a flare every 282 m against a 520 m seeker range, so the trail has no hole a missile
  // can fly through. Raise the speed without lowering the gap and you get a dotted line.
  decoy: {
    label: 'DECOY', short: 'D', max: 4, cool: 1.1, life: 20,
    speed: 470, boost: 420, sink: 0.06,
    flares: 12, flareGap: 0.6,
  },
  kamikaze: {
    label: 'KAMI', short: 'K', max: 4, cool: 0.9, life: 70,
    speed: 110, turn: 1.5, gain: 22, maxSpeed: 430,
    damage: 80, hitRadius: 24, reach: 6500,
  },
  interceptor: {
    label: 'INTC', short: 'I', max: 3, cool: 1.4, life: 36,
    speed: 300, turn: 2.6, boost: 190, N: 4, maxG: 30, kill: 26,
    station: 46,          // how far off the wing it sits with nothing to do
  },
};

const _dir = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _lead = new THREE.Vector3();

// Rotate a velocity toward a direction at a bounded rate, keeping its magnitude. This is a real
// rotation about the cross axis, not lerp-and-normalise — lerping under-turns badly for anything
// but a small correction (measured: 0.068 rad delivered against 0.1 commanded on a 90° turn), and a
// drone that quietly turns two thirds as fast as its table says makes every tuning number a lie.
export function steerToward(v, dir, turn, dt) {
  const speed = v.length();
  if (speed < 1e-6 || dir.lengthSq() < 1e-12) return;
  _dir.copy(dir).normalize();
  _cur.copy(v).multiplyScalar(1 / speed);
  const ang = Math.acos(THREE.MathUtils.clamp(_cur.dot(_dir), -1, 1));
  if (ang < 1e-5) return;
  _axis.crossVectors(_cur, _dir);
  // Exactly reversed: the cross product vanishes and any perpendicular axis will do. Two candidates,
  // because one of them is itself parallel to _cur whenever the drone is flying straight up.
  if (_axis.lengthSq() < 1e-12) _axis.set(0, 1, 0).cross(_cur);
  if (_axis.lengthSq() < 1e-12) _axis.set(1, 0, 0).cross(_cur);
  v.applyAxisAngle(_axis.normalize(), Math.min(ang, turn * dt));
}

// A glider trades height for speed and never gets any back, so speed is a function of how long it
// has been falling. This is the whole point of the airframe: released high and far it arrives fast.
export function kamikazeSpeed(age, def = DRONE.kamikaze) {
  return Math.min(def.maxSpeed, def.speed + def.gain * age);
}

// ...and what it arrives with is what it hits with. Half damage at release speed, full at terminal.
export function impactDamage(d) {
  const def = d.def;
  if (def !== DRONE.kamikaze) return def.damage || 0;
  const t = (d.v.length() - def.speed) / Math.max(1, def.maxSpeed - def.speed);
  return def.damage * (0.55 + 0.45 * THREE.MathUtils.clamp(t, 0, 1));
}

// Nearest enemy site, with armed ones worth a detour: a SAM is shooting at you and a fuel depot is
// not, so a drone that has to choose should choose the one doing damage.
export function pickGroundTarget(sites, drone) {
  const team = drone.owner ? drone.owner.team : 0;
  let best = null, bestScore = Infinity;
  for (const g of sites) {
    if (g.dead || g.team === team) continue;
    const r = drone.p.distanceTo(g.p);
    if (r > drone.def.reach) continue;
    const score = r * (g.range > 0 ? 0.75 : 1);
    if (score < bestScore) { bestScore = score; best = g; }
  }
  return best;
}

// An interceptor defends its owner, so "what should I shoot" is the same question the owner's threat
// warning already answers. One ranking, one answer, no chance of the two disagreeing.
export function pickInterceptTarget(missiles, owner) {
  if (!owner || owner.dead) return null;
  const t = pickThreat(missiles, owner);
  return t ? t.missile : null;
}

// Advance one drone. Mutates `d`; returns what the viewer has to make happen this frame.
// `world` is `{ groundTargets, missiles }`.
export function stepDrone(d, dt, world) {
  const out = { expired: false, flare: false, hitSite: null, killed: null, detonate: false };
  const def = d.def;
  d.age += dt;
  if (d.age > def.life) { out.expired = true; return out; }

  if (d.kind === 'decoy') {
    d.v.y -= G * def.sink * dt;
    const sp = d.v.length();
    if (sp < def.speed) d.v.setLength(Math.min(def.speed, sp + def.boost * dt));
    d.flareTimer -= dt;
    if (d.flareTimer <= 0) {
      if (d.flaresLeft > 0) { d.flaresLeft--; d.flareTimer = def.flareGap; out.flare = true; }
      // an empty dispenser is just debris; give it a moment so the last flare is clear of it
      else if (d.flareTimer < -1.2) out.expired = true;
    }
  } else if (d.kind === 'kamikaze') {
    if (!d.target || d.target.dead) d.target = pickGroundTarget(world.groundTargets || [], d);
    if (d.target) {
      _dir.copy(d.target.p).sub(d.p);
      if (_dir.length() < def.hitRadius) { out.hitSite = d.target; out.detonate = true; return out; }
      steerToward(d.v, _dir, def.turn, dt);
    } else {
      // nothing to hit: a glider with nowhere to go still goes down
      _dir.copy(d.v).setY(-Math.max(30, Math.abs(d.v.y)));
      steerToward(d.v, _dir, def.turn * 0.5, dt);
    }
    d.v.setLength(kamikazeSpeed(d.age, def));
  } else {
    if (d.target && !d.target.live) d.target = null;
    if (!d.target) {
      d.target = pickInterceptTarget(world.missiles || [], d.owner);
      if (d.target) d.lastLos.copy(d.target.p).sub(d.p).normalize();
    }
    if (d.target) {
      // PRO-NAV IS BLIND DEAD ASTERN. A target directly behind produces no line-of-sight rotation,
      // so it commands nothing and the interceptor flies away from the thing it was launched at —
      // measured, it got overtaken at 8 s instead of intercepting at 2. So point it at the intercept
      // first and only hand over to pro-nav once the bearing is roughly right.
      const r = proNavAccel(_acc, d.p, d.v, d.lastLos, d.target.p, d.target.v, dt, def.N, def.maxG);
      if (r < def.kill) { out.killed = d.target; out.detonate = true; return out; }
      const sp0 = Math.max(d.v.length(), def.speed);
      if (interceptPoint(_lead, d.p, d.target.p, d.target.v, sp0) === null) _lead.copy(d.target.p);
      _dir.copy(_lead).sub(d.p);
      const off = Math.acos(THREE.MathUtils.clamp(
        _dir.dot(d.v) / Math.max(1e-6, _dir.length() * d.v.length()), -1, 1));
      if (off > 0.3) steerToward(d.v, _dir, def.turn, dt);
      else d.v.addScaledVector(_acc, dt);
      const sp = d.v.length();
      if (sp < def.speed) d.v.setLength(Math.min(def.speed, sp + def.boost * dt));
    } else if (d.owner && !d.owner.dead) {
      // station keeping: sit off the wing and match speed, closing the gap if it drops behind
      _wp.copy(d.owner.p).addScaledVector(d.owner.right, d.slot * def.station)
        .addScaledVector(d.owner.up, 14);
      _dir.copy(_wp).sub(d.p);
      const gap = _dir.length();
      steerToward(d.v, _dir, def.turn, dt);
      d.v.setLength(THREE.MathUtils.clamp(d.owner.airspeed + (gap - 25) * 0.7, 55, def.speed));
    } else {
      d.v.multiplyScalar(1 - 0.3 * dt);      // orphaned: the owner is gone, so coast and expire
    }
  }

  d.p.addScaledVector(d.v, dt);
  return out;
}

// How many of each you carry, and what a resupply pod hands back.
export const DRONE_KINDS = Object.keys(DRONE);
export function fullDroneLoad() {
  const out = {};
  for (const k of DRONE_KINDS) out[k] = DRONE[k].max;
  return out;
}
export function giveDrones(f, n = 1) {
  for (const k of DRONE_KINDS) f.drones[k] = Math.min(DRONE[k].max, (f.drones[k] || 0) + n);
}

// A drone release is not free: it costs one of that kind and puts that kind on a short cooldown.
// Returns false if you had none or the rack is still cycling, which is what the dry click is for.
export function canRelease(f, kind) {
  return !f.dead && (f.drones?.[kind] || 0) > 0 && (f.droneCool?.[kind] || 0) <= 0;
}
