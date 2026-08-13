// flight-combat.js — weapon tables and the combat maths that is worth testing without a GPU.
//
// The FX, meshes and audio stay in the viewer. What lives here is everything that is a *decision*
// or a *trajectory*: what a seeker does, where a gun has to aim, which target a lock picks, and how
// fast the threat warning should beep. Those are the parts that were wrong on first authoring and
// only simulation caught, so they are the parts that belong in a module with tests.
//
// It imports three for vector types only. `flight-model.js` imports COMBAT from here for the
// starting loadout, which is the one dependency edge between them; nothing here imports the model.

import * as THREE from 'three';
import { RHO } from './flight-airframes.js';

export const COMBAT = {
  gunSpeed: 940, gunRps: 22, gunDamage: 7, gunSpread: 0.0045, gunRange: 2400,
  ammoMax: 900, missileMax: 4, flareMax: 24,
  lockCone: 0.20, lockRange: 5200, lockTime: 1.1,   // cone is a half-angle in radians
  msl: { thrust: 12000, mass: 84, burn: 2.4, maxG: 24, life: 24, fuse: 16, damage: 150, N: 4,
    blast: 55,          // blast is wider than the fuse: it does not have to be aimed at you to kill you
    gRef: 480,          // speed at which the full g limit is available; below it, less
    dragArea: 0.016,    // Cd·S in m², the parasitic term
    induced: 0.05 },    // how much a hard turn multiplies that drag — the reason evading works
  flare: { life: 6.5, seekCone: 0.75, seekRange: 520, decoy: 0.55 },
  aiGunRange: 900, aiMslRange: 3600,
};

// `range` 0 means the site has no weapon. `passive` means it has no weapon AND makes no other site
// more dangerous either — those are the base structures, which exist purely to be attacked, and the
// HUD draws them dashed so you can tell at a glance that nothing there is shooting back. The radar
// is deliberately unarmed but NOT passive: it has no gun, but it is what gives every other site its
// full reach, so killing it drops the rest to 45%.
export const GROUND = {
  radar:  { hp: 90, range: 0, label: 'RADAR', detect: 9000, blast: 16 },
  sam:    { hp: 70, range: 5200, label: 'SAM', reload: 7.5, minRange: 900, blast: 16 },
  aa:     { hp: 55, range: 1500, label: 'AA', rps: 9, damage: 5, muzzle: 620, blast: 14 },
  hq:     { hp: 150, range: 0, label: 'HQ', passive: true, blast: 22 },
  depot:  { hp: 55, range: 0, label: 'FUEL', passive: true, blast: 38 },
  hangar: { hp: 120, range: 0, label: 'HANGAR', passive: true, blast: 26 },
};

export const G = 9.81;
export const SHELL_GRAVITY = 0.35;   // shells and bullets fall at a fraction of g, arcade-leaning

// ---------------------------------------------------------------------------
// Hit detection
// ---------------------------------------------------------------------------

// A gun round moves 940 m/s, which is 15 m in a 60 Hz step, so testing the round's POINT against a
// 6.5 m target misses most of the time. Test the swept SEGMENT instead.
export function pointSegmentDistSq(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py, qz = az + dz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}

// ---------------------------------------------------------------------------
// Gun lead
// ---------------------------------------------------------------------------

const _lead = new THREE.Vector3();

// Where to point so the shell and the target arrive together.
//
// The obvious version — aim where the target will be after `range / muzzle` seconds — misses by
// 41 m against a 210 m/s crosser at 900 m, because leading pushes the aim point further away, which
// lengthens the flight, which moves the aim point again. Three iterations plus drop compensation
// bring the worst case to 2.9 m. Both numbers are measured.
export function leadPoint(out, from, targetPos, targetVel, muzzle, drop = SHELL_GRAVITY) {
  let tof = from.distanceTo(targetPos) / muzzle;
  for (let k = 0; k < 3; k++) {
    _lead.copy(targetPos).addScaledVector(targetVel, tof);
    tof = _lead.distanceTo(from) / muzzle;
  }
  out.copy(targetPos).addScaledVector(targetVel, tof);
  out.y += 0.5 * G * drop * tof * tof;      // the shells fall; aim over the top
  return tof;
}

const _icR = new THREE.Vector3();
const _icW = new THREE.Vector3();

// Where two constant-speed tracks actually meet, solved rather than iterated.
//
// `leadPoint` above converges on A solution, and for a gun that is fine because the shell outruns
// everything. It is NOT fine when the chaser is slower than its quarry: that geometry has two
// meeting times and the iteration walks to the far one. Measured on an interceptor sent after a
// missile overhauling it from astern, the iteration picked 8.19 s — a stern chase it barely wins —
// when turning round and meeting it head-on takes 2.85 s. Same equation, wrong root.
//
// Writes the aim point into `out` and returns the time to meet, or null if the chaser can never
// catch it and the caller should just point at the target and hope.
export function interceptPoint(out, from, targetPos, targetVel, speed) {
  _icR.copy(targetPos).sub(from);
  _icW.copy(targetVel);
  const a = _icW.lengthSq() - speed * speed;
  const b = 2 * _icR.dot(_icW);
  const c = _icR.lengthSq();
  let t;
  if (Math.abs(a) < 1e-6) {                 // dead heat on speed: the quadratic degenerates
    if (Math.abs(b) < 1e-9) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const t1 = (-b - root) / (2 * a), t2 = (-b + root) / (2 * a);
    // the soonest meeting that is actually in the future
    t = Math.min(t1 > 1e-4 ? t1 : Infinity, t2 > 1e-4 ? t2 : Infinity);
    if (!Number.isFinite(t)) return null;
  }
  out.copy(targetPos).addScaledVector(targetVel, t);
  return t;
}

// ---------------------------------------------------------------------------
// Gun aim assist
// ---------------------------------------------------------------------------

export const AIM_CONE = 0.105;      // ~6 degrees; the angle at which help reaches zero

const _aaLead = new THREE.Vector3();
const _aaDir = new THREE.Vector3();
const _aaLos = new THREE.Vector3();

// MILD AUTOAIM. Not a magnet.
//
// It TRIGGERS on how close your nose is to the target — which is what a player actually points at —
// and CORRECTS toward the lead solution, which is where the round has to go. Those are two different
// directions, and for a fast crosser they can be 8 degrees apart, so getting them the right way
// round matters: an earlier version triggered on the lead point instead, which meant aiming straight
// at a crossing enemy put you outside the cone and got you no help at all. The test measures this.
//
// The bend falls off with how far off the target you are — full strength on boresight, nothing by
// 6 degrees, on a squared curve so the middle of that range is already weak. It closes a FRACTION
// of the lead gap, never all of it unless the slider is at 1. So it rescues a shot that was nearly
// right and does nothing for one that was not, which is the difference between forgiving and aiming
// for you. In a tail chase the lead gap is small and the assist closes most of it; against a fast
// crosser the gap is large and closing a third of it still misses, which is as it should be.
//
// `aim` is modified in place. Returns the target it helped against, or null.
export function applyAimAssist(aim, shooter, targets, strength, cone = AIM_CONE) {
  if (!(strength > 0)) return null;
  let best = null, bestAng = cone;
  for (const o of targets) {
    if (o === shooter || o.dead || o.team === shooter.team) continue;
    _aaLos.copy(o.p).sub(shooter.p);
    const r = _aaLos.length();
    if (r > COMBAT.gunRange || r < 60) continue;
    const ang = Math.acos(THREE.MathUtils.clamp(_aaLos.dot(shooter.fwd) / r, -1, 1));
    if (ang < bestAng) { bestAng = ang; best = o; }
  }
  if (!best) return null;
  leadPoint(_aaLead, shooter.p, best.p, best.v, COMBAT.gunSpeed);
  _aaDir.copy(_aaLead).sub(shooter.p);
  if (_aaDir.lengthSq() < 1e-6) return null;
  _aaDir.normalize();
  const falloff = 1 - bestAng / cone;
  aim.lerp(_aaDir, strength * falloff * falloff).normalize();
  return best;
}

// ---------------------------------------------------------------------------
// Missile guidance
// ---------------------------------------------------------------------------

const _newLos = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _zero = new THREE.Vector3();

// Proportional navigation: turn at a rate proportional to how fast the line of sight to the target
// is rotating, which puts the missile on a COLLISION course rather than chasing the target's tail.
//
// Mutates `lastLos` (the seeker's memory) and writes the commanded acceleration into `out`, capped
// at the airframe's g limit. Returns the current range so the caller can test the fuse.
export function proNavAccel(out, pos, vel, lastLos, targetPos, targetVel, dt, N, maxG) {
  _newLos.copy(targetPos).sub(pos);
  const range = _newLos.length();
  _newLos.multiplyScalar(1 / Math.max(1e-4, range));
  _omega.crossVectors(lastLos, _newLos).multiplyScalar(1 / Math.max(dt, 1e-4));
  lastLos.copy(_newLos);
  _rel.copy(targetVel || _zero).sub(vel);
  const closing = Math.max(40, -_rel.dot(_newLos));
  const speed = vel.length();
  out.crossVectors(_omega, vel).multiplyScalar(N * closing / Math.max(1, speed));
  const aMax = maxG * G;
  if (out.lengthSq() > aMax * aMax) out.setLength(aMax);
  return range;
}

// ---------------------------------------------------------------------------
// The missile as a flying thing, not just a seeker
// ---------------------------------------------------------------------------

const _msAcc = new THREE.Vector3();
const _msGuide = new THREE.Vector3();

// A MISSILE ONLY TURNS AS HARD AS ITS SPEED LETS IT.
//
// Manoeuvre comes from lift, lift goes with the square of speed, so a missile coasting at half its
// design speed has a quarter of its g. A flat 24 g cap regardless of energy is what made these
// things impossible to shake: one that had been chasing you for fifteen seconds cornered exactly as
// hard as one fresh off the rail, so there was no such thing as making it run out of steam.
export function missileMaxG(speed, def = COMBAT.msl) {
  const q = speed / def.gRef;
  return def.maxG * Math.min(1, q * q);
}

// One integration step. The seduction check, the FX and the damage stay in the viewer; this is the
// part that decides whether the thing can still catch you.
//
// The escape is a loop, and it is the real one: turning costs induced drag, drag costs speed, and
// speed is what buys the turn. Force it to follow a hard break and it spends the energy it needs to
// keep following. Fly straight and it keeps all of it, which is why running away does not work.
export function stepMissile(m, dt) {
  const def = COMBAT.msl;
  m.age += dt;
  const burning = m.age < def.burn;
  const speed = m.v.length();

  _msAcc.set(0, -G, 0);
  if (burning) _msAcc.addScaledVector(m.v, def.thrust / (def.mass * Math.max(1, speed)));

  let range = Infinity;
  _msGuide.set(0, 0, 0);
  if (m.target) {
    range = proNavAccel(_msGuide, m.p, m.v, m.lastLos, m.target.p, m.target.v, dt,
      def.N, missileMaxG(speed, def));
    // Hold altitude, the way an autopilot does. Without this the guidance spends its whole budget
    // re-correcting for a fall it never anticipates, which taxes a straight-line intercept as hard
    // as a hard turn and lets you escape by flying level — the opposite of what should happen.
    _msGuide.y += G;
    const aMax = missileMaxG(speed, def) * G;
    if (_msGuide.lengthSq() > aMax * aMax) _msGuide.setLength(aMax);
    _msAcc.add(_msGuide);
  }

  const n = _msGuide.length() / G;
  const dragA = 0.5 * RHO * speed * speed * def.dragArea * (1 + def.induced * n * n) / def.mass;
  _msAcc.addScaledVector(m.v, -dragA / Math.max(1, speed));

  m.v.addScaledVector(_msAcc, dt);
  m.p.addScaledVector(m.v, dt);
  return { range, fused: !!m.target && range < def.fuse, speed: m.v.length(), n, burning };
}

// ---------------------------------------------------------------------------
// Lock-on
// ---------------------------------------------------------------------------

const _los = new THREE.Vector3();

// The best target inside the seeker cone: nearest to boresight, then nearest in range. An unarmed
// aircraft has nothing to lock WITH, which is also what keeps the threat warning quiet in training.
//
// Takes any number of lists, because a seeker does not care whether a return is an aircraft or a
// SAM site — anything with `{ p, dead, team }` is a candidate, and the caller decides what is in
// the sky. That is also the shape an entity registry would hand it.
export function lockCandidate(f, ...lists) {
  if (!f.armed) return null;
  let best = null, bestScore = Infinity;
  for (const list of lists) {
    for (const o of list) {
      if (o === f || o.dead || o.team === f.team) continue;   // no locking your own side
      _los.copy(o.p).sub(f.p);
      const r = _los.length();
      if (r > COMBAT.lockRange || r < 40) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(_los.dot(f.fwd) / r, -1, 1));
      if (ang > COMBAT.lockCone) continue;
      const score = ang * 2200 + r * 0.2;
      if (score < bestScore) { bestScore = score; best = o; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Which missile the warning is about
// ---------------------------------------------------------------------------

const _thP = new THREE.Vector3();
const _thV = new THREE.Vector3();
const _thQ = new THREE.Vector3();

// Is this missile a danger to `me`, and how soon? Two ways for the answer to be yes:
//
//   AIMED    it is tracking you. Dangerous even while it is still boosting away from you.
//   PASSING  it is tracking somebody else, but its blast radius is wider than its fuse, so a
//            near miss on your wingman is a hit on you. Closest approach on the current relative
//            track decides; a missile opening the range is not a passing threat.
//
// Returns null for "no", otherwise the numbers the warning needs, so the caller measures once.
export function missileDanger(m, me, blast = COMBAT.msl.blast) {
  if (!m.live) return null;
  _thP.copy(m.p).sub(me.p);
  const dist = _thP.length();
  _thV.copy(m.v).sub(me.v);
  const rel2 = _thV.lengthSq();
  const closing = -_thP.dot(_thV) / Math.max(1, dist);
  const aimed = m.target === me;
  if (!aimed) {
    if (closing <= 0 || rel2 < 1e-6) return null;
    const tca = Math.max(0, -_thP.dot(_thV) / rel2);
    _thQ.copy(_thP).addScaledVector(_thV, tca);
    if (_thQ.length() > blast) return null;
  }
  return { dist, closing, tti: dist / Math.max(30, closing), aimed };
}

// THE WARNING HAS TO BE ABOUT THE MISSILE THAT ARRIVES FIRST.
//
// Missiles live in a fixed pool and are handed out by first free slot, so pool order is arbitrary —
// taking whichever one happens to be last means a 6 km SAM shot can mask the one 400 m off your
// tail, and the HUD calmly reads ten seconds while you die. Rank by time to impact instead.
export function pickThreat(missiles, me) {
  let best = null;
  for (const m of missiles) {
    const info = missileDanger(m, me);
    if (!info) continue;
    if (!best || info.tti < best.tti) { best = info; best.missile = m; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Threat warning cadence
// ---------------------------------------------------------------------------

export const THREAT = { slowest: 0.65, fastest: 0.045, solidTti: 0.5 };

// How fast the missile-inbound beep should repeat. Two defects live here, both found by simulating
// a closing missile rather than by listening:
//
// 1. TIME TO IMPACT IS NOT MONOTONE. Near a near-miss the closure speed collapses, so range/closure
//    climbs and the warning audibly RELAXES at the exact moment it should be screaming — measured
//    widening from a 0.089 s gap back to 0.65 s. The rate takes the smaller of the time-to-impact
//    and raw-range estimates, and is then ratcheted so it can only ever speed up.
// 2. A PURE RATCHET SCREAMS FOREVER. A guided missile that overshoots keeps tracking while opening
//    the range, and a one-way ratchet would hold maximum rate indefinitely. The ratchet only holds
//    while the range is shrinking.
//
// Measured cadence on a 3.2 km tail chase: 1.5/s at launch, 2.9/s at 1.5 km, 6.2/s at 735 m,
// 13.9/s at 327 m, solid from 0.5 s out.
export function createThreatWarning() {
  return { threat: null, floor: THREAT.slowest, lastDist: 0 };
}

export function threatCadence(state, threat, dist, closing, dt) {
  const tti = dist / Math.max(30, closing);
  const want = THREE.MathUtils.clamp(Math.min(tti * 0.11, dist * 0.00022),
    THREAT.fastest, THREAT.slowest);
  if (threat !== state.threat) {
    state.threat = threat; state.floor = THREAT.slowest; state.lastDist = dist;
  }
  if (dist > state.lastDist + 1) state.floor = Math.min(THREAT.slowest, state.floor + dt * 0.4);
  state.lastDist = dist;
  state.floor = Math.min(state.floor, want);
  return { interval: state.floor, solid: tti < THREAT.solidTti, tti };
}

export function resetThreatWarning(state) {
  state.threat = null; state.floor = THREAT.slowest; state.lastDist = 0;
}

// EVADED. The beeping merely stopping carries no information — it could mean the missile lost you,
// or that you are dead, or that the sound broke. So a miss gets its own cue, and these are the
// three ways of pretending you got away with something you did not:
//
//   `suppressed`  the blast damaged you. That is a hit.
//   `dead`        the threat clears when you do, which is the loudest possible false positive.
//   back to back  the threat never returns to null between two missiles, so `hadThreat` is still
//                 set and nothing fires. You never got away in between.
//
// One ordering trap, which cost the whole feature on first authoring: `hadThreat` has to be read
// BEFORE the loop that clears every flyer's threat, because that loop is the only thing still
// holding last frame's value. Read next to the reassignment — the obvious place — it is always null
// and the cue never fires at all.
export function evadedThisFrame(hadThreat, threatNow, dead, suppressed) {
  return !!hadThreat && !threatNow && !dead && !suppressed;
}
