// flight-ai.js — per-archetype steering that drives the same model the player does.
//
// The AI never touches the physics directly. It writes `f.input` — the same pitch/roll/yaw/throttle
// axes a stick writes — so an opponent obeys exactly the physics you do, including its stall.
//
// Nothing here fires a weapon or spawns anything. `aiShoot` returns INTENT and the viewer acts on
// it; `aiGoal` sets `f.wantFlares` rather than calling into the FX layer. That is what makes the
// whole file testable in Node, and it is also the seam an entity registry would plug into.
//
// The `world` argument is `{ flyers, player, aiEngage }`. It is passed rather than imported so the
// module holds no hidden state.

import * as THREE from 'three';
import { G } from './flight-airframes.js';
import { heightAt, agl } from './flight-terrain.js';
import { COMBAT } from './flight-combat.js';

export function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// ---------------------------------------------------------------------------
// The roster
//
// WHAT IS IN THE SKY IS A ROSTER, NOT A FIXED LINEUP.
//
// The axis that matters is `armed`, not the airframe. An unarmed opponent is a flying target you
// can practise gunnery and pursuit against; an armed one is a fight you have to survive. Being able
// to have the first without the second is the whole point — you should be able to learn to fly
// before anything shoots back.
//
// An unarmed aircraft never fires, never locks (so it never sets off your lock warning) and is
// never chosen as a target by any other AI, which means your allies will not steal your practice.
// `dummy` goes further and removes missile evasion too, so a target drone holds still.
// `over` overrides the per-airframe AI circuit.
// ---------------------------------------------------------------------------

export const SQUAD = {
  ally:    { key: 'plane', team: 0, armed: true,  label: 'Ally',    r: 1700, max: 4 },
  bandit:  { key: 'plane', team: 1, armed: true,  label: 'Bandit',  r: 2800, max: 6 },
  hunter:  { key: 'drone', team: 1, armed: true,  label: 'Hunter drone', r: 340, max: 4 },
  raptor:  { key: 'bird',  team: 1, armed: true,  label: 'Raptor',  r: 820, max: 4 },
  trainer: { key: 'plane', team: 1, armed: false, label: 'Trainer', r: 2200, max: 6,
    // slower and lower than a bandit so you can actually catch it, and it still breaks from a
    // missile — a target that jinks is the point of a training aircraft
    over: { speed: 92, alt: 850, radius: 2000, capture: 650 } },
  target:  { key: 'drone', team: 1, armed: false, label: 'Target drone', r: 420, max: 8,
    // barely moves: a gunnery target. Crossing one at 120 m/s is hard enough on its own.
    over: { speed: 4, alt: 280, radius: 90, capture: 45, dummy: true } },
};

export const PRESETS = {
  solo:     { ally: 0, bandit: 0, hunter: 0, raptor: 0, trainer: 0, target: 0, ground: false },
  training: { ally: 0, bandit: 0, hunter: 0, raptor: 0, trainer: 2, target: 4, ground: false },
  mixed:    { ally: 1, bandit: 1, hunter: 0, raptor: 0, trainer: 2, target: 3, ground: true },
  combat:   { ally: 2, bandit: 2, hunter: 1, raptor: 1, trainer: 0, target: 0, ground: true },
};

// a circuit tighter than this is centred on the unit's own spawn point rather than the player's:
// eight target drones sharing one 90 m ring would fly through each other
export const OWN_CIRCUIT_BELOW = 600;

// ---------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------

// A FIXED circuit with a capture radius, not a point swept along a curve. The first version swept
// the target at radius*rate metres a second, which for every class was faster than the aircraft
// could fly: all three chased a fleeing point, saturated their controls and flew into the ground.
export function makeAi(f, seed, over) {
  // From the airframe, not from a ternary on its key. The ternary's final branch was the bird's
  // circuit, so an unrecognised craft patrolled an 820 m ring at 21 m/s whatever it actually was.
  const cfg = { ...f.af.circuit };
  if (over) Object.assign(cfg, over);
  const pts = [];
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + seed;
    const r = cfg.radius * (0.74 + 0.4 * ((i % 3) / 2));
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = Math.max(heightAt(x, z) + cfg.alt * 0.5, cfg.alt + Math.sin(a * 2 + seed) * cfg.alt * 0.28);
    pts.push(new THREE.Vector3(x, y, z));
  }
  f.ai = {
    ...cfg, pts, i: 0, seed, name: 'AI',
    home: new THREE.Vector3(),
    mode: 'patrol', modeTimer: 0, breakDir: 1, foeTimer: 0, rest: false,
  };
  return f;
}

// waypoints are authored around the origin, then shifted to wherever the fight is
export function offsetCircuit(f, cx, cz) {
  for (const p of f.ai.pts) {
    p.x += cx; p.z += cz;
    p.y = Math.max(heightAt(p.x, p.z) + f.ai.alt * 0.5, p.y);
  }
}

// ---------------------------------------------------------------------------
// Target selection and steering
// ---------------------------------------------------------------------------

const _toWp = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _wp = new THREE.Vector3();

// Who this AI is fighting. Enemies prefer the player but will settle for an ally; allies prefer
// whoever is currently locking the player, which is what "support" actually means in a dogfight —
// not flying alongside you, but taking the shot off your back.
export function pickFoe(f, world) {
  let best = null, bestScore = Infinity;
  for (const o of world.flyers) {
    if (o.dead || o.team === f.team) continue;
    if (!o.armed) continue;              // practice targets are yours; nobody else takes them
    if (o === world.player && !world.aiEngage) continue;
    let score = f.p.distanceTo(o.p);
    if (o.lockTarget && o.lockTarget.team === f.team) score *= 0.4;   // it is shooting at us
    if (f.team !== 0 && o === world.player) score *= 0.75;            // enemies want the player
    if (score < bestScore) { bestScore = score; best = o; }
  }
  return best;
}

// Picks where the AI wants to be. Patrol follows its circuit; engage flies a LEAD pursuit at its
// target (aim where they will be, not where they are) and breaks off when a missile is inbound.
export function aiGoal(f, dt, world) {
  const ai = f.ai;
  ai.modeTimer -= dt;
  ai.foeTimer -= dt;
  if (ai.foeTimer <= 0) { ai.foeTimer = 0.7; f.foe = f.armed ? pickFoe(f, world) : null; }
  const foe = f.foe && !f.foe.dead ? f.foe : null;
  const range = foe ? f.p.distanceTo(foe.p) : Infinity;

  if (f.threat && f.threat.live && !ai.dummy) {
    if (ai.mode !== 'break') { ai.mode = 'break'; ai.modeTimer = 3.2; ai.breakDir = Math.random() < 0.5 ? -1 : 1; }
  } else if (foe && range < 7000) {
    if (ai.mode !== 'engage' && ai.modeTimer <= 0) { ai.mode = 'engage'; ai.modeTimer = 1; }
  } else if (ai.mode !== 'patrol' && ai.modeTimer <= 0) {
    ai.mode = 'patrol';
  }

  if (ai.mode === 'break') {
    if (ai.modeTimer <= 0) ai.mode = 'engage';
    f.wantFlares = true;              // the viewer drops them; this file does not spawn anything
    // run perpendicular to the missile and downhill, which is what actually beats a seeker
    const t = f.threat;
    _wp.copy(f.p);
    if (t) {
      _lead.copy(f.p).sub(t.p).normalize();
      _wp.addScaledVector(_lead, 1200);
      _wp.x += -_lead.z * 900 * ai.breakDir;
      _wp.z += _lead.x * 900 * ai.breakDir;
    } else {
      _wp.addScaledVector(f.fwd, 1200);
    }
    _wp.y = Math.max(heightAt(_wp.x, _wp.z) + 260, f.p.y - 220);
    return _wp;
  }

  if (ai.mode === 'engage' && foe) {
    const tof = Math.min(4, range / Math.max(120, COMBAT.gunSpeed));
    _wp.copy(foe.p).addScaledVector(foe.v, tof);
    if (range < 260) _wp.addScaledVector(f.fwd, 700);   // do not fly into their jetwash
    _wp.y = Math.max(heightAt(_wp.x, _wp.z) + 180, _wp.y);
    return _wp;
  }

  const wp = ai.pts[ai.i];
  if (Math.hypot(wp.x - f.p.x, wp.z - f.p.z) < ai.capture) ai.i = (ai.i + 1) % ai.pts.length;
  return ai.pts[ai.i];
}

// Trigger discipline: guns only inside a tight cone at short range, missiles only on a full lock.
// Returns intent — the caller fires. Nothing here consumes ammo or spawns a projectile.
export function aiShoot(f, world) {
  const out = { gun: false, missile: false };
  // Two separate questions, and they were two separate mechanisms: `f.armed` is what the ROSTER
  // decided for this individual (a trainer is an unarmed plane), `af.armable` is whether the
  // airframe can carry weapons at all.
  if (f.dead || !f.armed || !f.af.armable) return out;
  const foe = f.foe;
  if (!foe || foe.dead || foe.team === f.team) return out;
  _lead.copy(foe.p).sub(f.p);
  const range = _lead.length();
  const ang = Math.acos(THREE.MathUtils.clamp(_lead.dot(f.fwd) / Math.max(1, range), -1, 1));
  // the shooter's own gun decides its reach: a cannon that carries 3,600 m should not hold fire
  // at 900 because that is where the light gun gave up
  if (range < (f.gun ? f.gun.aiRange : COMBAT.aiGunRange) && ang < 0.05) out.gun = true;
  if (range < COMBAT.aiMslRange && range > 700 && f.lockTarget === foe
    && f.lockProgress >= 1 && f.mslCool <= 0) out.missile = true;
  return out;
}

export function driveAi(f, dt, world) {
  f.wantFlares = false;
  const wp = aiGoal(f, dt, world);
  steerToward(f, wp, f.ai.speed, f.ai);
}

// The one steering law: fly toward a point at a speed, whatever the airframe. `driveAi` feeds it
// waypoints and the autopilot feeds it a ring; both write `f.input` exactly as the keyboard would,
// which is the seam that lets a player hand over and take back without the model noticing.
// `state` only has to hold `rest` for a bird's stamina hysteresis.
export function steerToward(f, wp, speed, state) {
  _toWp.copy(wp).sub(f.p);
  const flat = Math.hypot(_toWp.x, _toWp.z);

  const wantHeading = Math.atan2(-_toWp.x, -_toWp.z);
  const haveHeading = Math.atan2(-f.fwd.x, -f.fwd.z);
  const dh = wrapPi(wantHeading - haveHeading);
  const dAlt = wp.y - f.p.y;
  const ground = agl(f.p);

  if (f.af.control === 'attitude') {
    // tilt commands SPEED, not distance: the drone has to be able to brake as it arrives
    const horiz = Math.hypot(f.v.x, f.v.z);
    const wantSpeed = Math.min(speed, flat * 0.35);
    f.input.pitch = THREE.MathUtils.clamp(-(wantSpeed - horiz) * 0.25, -1, 1);
    f.input.roll = 0;
    f.input.yaw = THREE.MathUtils.clamp(-dh * 1.2, -1, 1);   // +dh means turn LEFT; see below
    const hoverT = (f.af.mass * G) / f.af.thrustMax;
    const tiltCos = Math.max(0.5, f.up.y);   // tilting steals lift from the rotors; pay it back
    f.throttle = THREE.MathUtils.clamp((hoverT + dAlt * 0.02 - f.v.y * 0.06) / tiltCos, 0, 1);
    f.input.throttle = 0;
  } else {
    // bank-angle hold, not a bank-rate command: the stick is a RATE control, so steering roll
    // straight from heading error just keeps rolling and ends up inverted
    // heading is atan2(-fwd.x, -fwd.z), which INCREASES to the left, while positive bank is a roll
    // to the right. Getting that sign backwards banks away from the target: the heading error then
    // parks at 180 degrees, where it keeps flipping across the wrap and the aircraft flies straight
    // off the map with the wings rocking. Cost an afternoon; hence the comment.
    const bank = Math.atan2(-f.right.y, f.up.y);
    const wantBank = THREE.MathUtils.clamp(-dh * 1.4, -1.05, 1.05);
    f.input.roll = THREE.MathUtils.clamp((wantBank - bank) * 1.8, -1, 1);

    // inner loop on vertical speed, for the same reason
    const wantVy = THREE.MathUtils.clamp(dAlt * 0.25, -26, 26);
    let pitch = THREE.MathUtils.clamp((wantVy - f.v.y) * 0.06, -0.8, 0.9);
    pitch += Math.abs(bank) * 0.35;                                     // hold the nose up in a turn
    if (ground < 220) pitch = Math.max(pitch, (220 - ground) * 0.012);   // terrain dodge
    // ...but with room below, keeping flying speed beats holding altitude
    if (f.airspeed < f.af.trimSpeed * 0.62 && ground > 60) pitch = Math.min(pitch, -0.2);
    // stop short of looping: pitch is a RATE command, so a saturated pull just keeps going over
    const att = Math.asin(THREE.MathUtils.clamp(f.fwd.y, -1, 1));
    if (att > 0.7) pitch = Math.min(pitch, 0);
    if (att < -0.9) pitch = Math.max(pitch, 0);
    f.input.pitch = THREE.MathUtils.clamp(pitch, -1, 1);
    f.input.yaw = 0;
    if (f.af.thrust === 'flap') {
      // stamina hysteresis: flapping flat out drains the bird in seconds, and a grounded bird
      // cannot take off again — flap thrust alone is well under its weight
      if (f.stamina < 0.12) state.rest = true;
      if (f.stamina > 0.55) state.rest = false;
      f.input.flap = !state.rest && (f.airspeed < speed * 0.9 || f.p.y < wp.y - 10);
      f.input.sweep = dAlt < -180 && f.airspeed < 45;
    } else {
      f.input.throttle = f.airspeed < speed ? 1 : -1;
    }
  }
}
