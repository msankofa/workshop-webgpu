// flight-autopilot.js — a player-selectable orbit that works for any airframe.
//
// The AI has flown a fixed circuit through `steerToward` since the first version; this is the same
// law given a ring instead of a waypoint list, and handed to whichever flyer asks for it. It writes
// `f.input` exactly as the keyboard does, so engaging it is "stop reading keys" and disengaging is
// "start again" — the model never learns who is flying.
//
// The point on the ring it chases is AHEAD of the aircraft's current bearing from the centre by a
// lead angle, never a point swept at radius·rate: the swept point was the AI's first bug (every class
// chased something faster than itself and flew into the ground) and a ring is the same trap.
//
// A gunship wants its port side on the target, which is a left-hand orbit — nothing more. On a
// circular orbit at constant radius the heading is tangent, so the wing pointing at the centre is
// the inside wing, and for a left turn that is the port wing. There is no extra steering law for
// "keep the guns on it"; the test asserts the geometry rather than trusting this paragraph.

import * as THREE from 'three';
import { steerToward } from './flight-ai.js';
import { heightAt } from './flight-terrain.js';

export const ORBIT_LIMITS = { radius: [400, 12000], alt: [150, 5500] };

const _wp = new THREE.Vector3();

// `turn` is 'left' (centre on the port side) or 'right'. `alt` is height above the ground at the
// centre; local terrain still wins if the ring crosses higher ground.
export function makeAutopilot(f, { x = 0, z = 0, radius = 3000, alt = 2000, turn = 'left', speed } = {}) {
  const ap = {
    mode: 'orbit', x, z,
    radius: THREE.MathUtils.clamp(radius, ...ORBIT_LIMITS.radius),
    alt: THREE.MathUtils.clamp(alt, ...ORBIT_LIMITS.alt),
    turn, speed: speed ?? f.af.circuit.speed,
    rest: false,          // a bird's stamina hysteresis lives here, as it does on `f.ai`
  };
  f.autopilot = ap;
  return ap;
}

// Engage around a centre off the port (or starboard) wing at the orbit radius, so the aircraft is
// already on the ring and tangent to it — no swing out, no swing in, the guns are on the target the
// moment the pilot lets go.
export function engageOrbitHere(f, { radius = 3000, alt, turn = 'left', speed } = {}) {
  const side = turn === 'left' ? -1 : 1;
  const x = f.p.x + f.right.x * side * radius;
  const z = f.p.z + f.right.z * side * radius;
  const ground = heightAt(x, z);
  return makeAutopilot(f, { x, z, radius, alt: alt ?? f.p.y - ground, turn, speed });
}

export function disengageAutopilot(f) { f.autopilot = null; }

// The bearing sense: the ring angle `atan2(z - cz, x - cx)` increases with +z at +x, which is a
// heading with the centre on the STARBOARD side. A left orbit runs it backwards.
export function orbitSign(turn) { return turn === 'left' ? -1 : 1; }

// Where the aircraft should be steering right now, written into `out`.
export function orbitGoal(out, f, ap) {
  const dx = f.p.x - ap.x, dz = f.p.z - ap.z;
  const dist = Math.hypot(dx, dz);
  // lead is a distance along the ring, not a fixed angle: 600 m ahead on a 12 km ring is a gentle
  // curve, 600 m on a 400 m ring is most of the way round, hence the clamp
  const lead = THREE.MathUtils.clamp(600 / ap.radius, 0.12, 0.9);
  const ang = (dist > 1 ? Math.atan2(dz, dx) : 0) + orbitSign(ap.turn) * lead;
  // Pure pursuit of a point ahead on the ring cuts the chord and settles on a smaller circle — a
  // 23% shortfall on a 400 m ring. Pushing the goal outward by twice the current shortfall (or
  // inward by the overshoot) puts the equilibrium back on the ring itself.
  const goalR = ap.radius + THREE.MathUtils.clamp(2 * (ap.radius - dist), -ap.radius * 0.5, ap.radius * 0.5);
  out.set(ap.x + Math.cos(ang) * goalR, 0, ap.z + Math.sin(ang) * goalR);
  const centreGround = heightAt(ap.x, ap.z);
  out.y = Math.max(centreGround + ap.alt, heightAt(out.x, out.z) + 150);
  return out;
}

export function driveAutopilot(f, dt) {
  const ap = f.autopilot;
  if (!ap || f.dead) return false;
  orbitGoal(_wp, f, ap);
  steerToward(f, _wp, ap.speed, ap);
  return true;
}

// Radius from the centre and the port/starboard vector's angle to the centre — what a test (and a
// HUD readout) wants to know about how well the orbit is being held.
export function orbitError(f, ap) {
  const dx = ap.x - f.p.x, dz = ap.z - f.p.z;
  const dist = Math.hypot(dx, dz);
  const side = orbitSign(ap.turn);           // -1: centre should be off the port wing (-right)
  const dot = (f.right.x * dx + f.right.z * dz) / (dist || 1);
  const across = Math.hypot(f.right.x, f.right.z) || 1;
  return {
    radiusError: dist - ap.radius,
    altError: f.p.y - (heightAt(ap.x, ap.z) + ap.alt),
    // 0 when the inside wing points straight at the centre, in the horizontal plane
    wingAngle: Math.acos(THREE.MathUtils.clamp(side * dot / across, -1, 1)),
  };
}
