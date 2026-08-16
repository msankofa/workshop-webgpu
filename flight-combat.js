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
import { heightAt } from './flight-terrain.js';

export const COMBAT = {
  gunSpeed: 940, gunRps: 22, gunDamage: 7, gunSpread: 0.0045, gunRange: 2400,
  ammoMax: 900, missileMax: 4, flareMax: 24,
  lockCone: 0.20, lockRange: 5200, lockTime: 1.1,   // cone is a half-angle in radians
  msl: { thrust: 12000, mass: 84, burn: 2.4, maxG: 24, life: 24, fuse: 16, damage: 150, N: 4,
    cool: 1.1,          // seconds between launches
    blast: 55,         // blast is wider than the fuse: it does not have to be aimed at you to kill you
    gRef: 480,          // speed at which the full g limit is available; below it, less
    dragArea: 0.016,    // Cd·S in m², the parasitic term
    induced: 0.05 },    // how much a hard turn multiplies that drag — the reason evading works
  flare: { life: 6.5, seekCone: 0.75, seekRange: 520, decoy: 0.55, cool: 0.55 },
  aiGunRange: 900, aiMslRange: 3600,
};

// ---------------------------------------------------------------------------
// Guns
//
// The first weapon here that belongs to an AIRCRAFT rather than to the module. `COMBAT.gun*` was one
// gun for everybody — the same popgun on a light trainer and on an aircraft built around a cannon —
// and `cannon` below is exactly those numbers, so nothing that does not name a gun changes at all.
//
// A flyer carries the resolved def on `f.gun`, the way a bomb carries `b.def`, rather than every
// consumer reaching for a module constant. That is the shape the missile pool still needs.
// ---------------------------------------------------------------------------

export const GUNS = {
  cannon: {
    id: 'cannon', label: 'GUN',
    speed: 940, rps: 22, damage: 7, spread: 0.0045, range: 2400, ammo: 900,
    aiRange: 900, resupply: 300, shake: 0.08, volume: 0.55,
  },
  // GAU-8/A Avenger. 3,900 rounds a minute is 65 a second, against the cannon's 22, and it carries
  // 1,174 of them — eighteen seconds of trigger and then you are a very large glider.
  //
  // The damage is where a 30 mm actually differs. 22 a round at 65 a second is 1,430 a second
  // against the cannon's 154, so a burst that would scratch a fighter with the light gun kills it,
  // and a single pass kills any ground site in the demo. That is the correct answer for this gun
  // and it is why the aircraft exists.
  gau8: {
    id: 'gau8', label: 'GAU-8',
    speed: 1010, rps: 65, damage: 22, spread: 0.005, range: 3600, ammo: 1174,
    aiRange: 1400, resupply: 400, shake: 0.2, volume: 0.85,
  },
  // The gunship battery. These fire out of the SIDE from a mount (see below), never from the nose,
  // so `aiRange` is what a mount's own aim logic uses and `spread` is the mount's dispersion.
  //
  // `blast` is what separates a shell from a bullet: a 25 mm round hurts what it touches, a 40 mm
  // hurts a small circle and a 105 mm hurts a street. A round with `blast` detonates on ANY contact,
  // ground included, and the blast has no idea whose side anybody is on — same rule as a bomb.
  m25: {
    id: 'm25', label: '25MM', short: '25',
    speed: 1050, rps: 30, damage: 12, spread: 0.006, range: 4500, ammo: 3000,
    aiRange: 3500, resupply: 1000, shake: 0.05, volume: 0.6, blast: 0,
  },
  l60: {
    id: 'l60', label: '40MM', short: '40',
    speed: 880, rps: 2, damage: 60, spread: 0.004, range: 5500, ammo: 256,
    aiRange: 4500, resupply: 96, shake: 0.15, volume: 0.8, blast: 9,
  },
  m102: {
    id: 'm102', label: '105MM', short: '105',
    speed: 470, rps: 0.16, damage: 300, spread: 0.003, range: 7000, ammo: 100,
    aiRange: 6000, resupply: 40, shake: 0.4, volume: 1.0, blast: 34,
  },
};

// Fails here rather than silently arming a craft with the default gun, same rule as the airframe
// registry: a typo in a descriptor should not produce a plausible aircraft. `'none'` is the one
// legal way to say "no boresight gun" — a gunship shoots out of the side and has nothing in the nose.
export function gunFor(key) {
  if (key == null) return GUNS.cannon;
  if (key === 'none') return null;
  const g = GUNS[key];
  if (!g) throw new Error(`unknown gun '${key}'. Registered: ${Object.keys(GUNS).join(', ')}`);
  return g;
}

// ---------------------------------------------------------------------------
// Mounts
//
// A mount is a gun that is NOT the boresight gun: it sits somewhere on the airframe, points somewhere
// other than the nose, and can be trained inside an arc. `af.mounts` describes them in the aircraft's
// own frame (x right, y up, z aft — the layout convention), and a flyer carries one live instance per
// mount with its own cooldown and magazine, the way `f.gun`/`f.ammo`/`f.gunCool` serve the nose.
//
//   { id, gun, pos: [x, y, z], dir: [x, y, z], arc }     arc is a half-angle in radians
// ---------------------------------------------------------------------------

export function makeMounts(af) {
  return (af.mounts || []).map((m) => {
    const gun = gunFor(m.gun);
    if (!gun) throw new Error(`mount '${m.id}' has no gun`);
    return {
      id: m.id, def: m, gun,
      pos: new THREE.Vector3().fromArray(m.pos),
      dir: new THREE.Vector3().fromArray(m.dir).normalize(),
      arc: m.arc ?? 0.6,
      cool: 0, ammo: gun.ammo,
    };
  });
}

export function resetMounts(f) {
  for (const m of f.mounts || []) { m.cool = 0; m.ammo = m.gun.ammo; }
}

// The muzzle, in the world. Layout z is aft, three's forward is -z, so the aft component rides `fwd`
// negated — the same transform `aircraft-meshes.js` applies to every part, which is why a barrel
// drawn from the layout and a round fired from it come out of the same place.
export function mountOrigin(out, f, m) {
  return out.copy(f.p)
    .addScaledVector(f.right, m.pos.x)
    .addScaledVector(f.up, m.pos.y)
    .addScaledVector(f.fwd, -m.pos.z);
}

export function mountBoresight(out, f, m) {
  return out.set(0, 0, 0)
    .addScaledVector(f.right, m.dir.x)
    .addScaledVector(f.up, m.dir.y)
    .addScaledVector(f.fwd, -m.dir.z)
    .normalize();
}

const _mb = new THREE.Vector3();
const _maxis = new THREE.Vector3();
const _mq = new THREE.Quaternion();

// Trains a wanted direction into the mount's arc. Returns true if it was already inside; if not,
// `dir` is rotated to the edge of the arc on the way toward what was wanted, so a reticle that
// has walked off the arc slides along its rim rather than snapping back to the boresight.
export function clampToArc(dir, f, m) {
  mountBoresight(_mb, f, m);
  const ang = Math.acos(THREE.MathUtils.clamp(_mb.dot(dir), -1, 1));
  if (ang <= m.arc) return true;
  _maxis.crossVectors(_mb, dir);
  if (_maxis.lengthSq() < 1e-9) _maxis.copy(f.up);
  _maxis.normalize();
  dir.copy(_mb).applyQuaternion(_mq.setFromAxisAngle(_maxis, m.arc));
  return false;
}

const _bd = new THREE.Vector3();
const _bh = new THREE.Vector3();
const _bt = new THREE.Vector3();

// Where to point a barrel so a round of `speed`, falling at `g`, launched from a platform moving at
// `platformVel`, arrives at `target`. The round's velocity is aim·speed + platform velocity, exactly
// as `fireGun` builds it, so what this solves is what actually flies.
//
// The vacuum solution is closed-form for a still platform (the low root of the range equation). The
// moving platform is folded in by iterating: solve, read the time of flight, aim at where the
// target sits relative to a shooter that will have drifted `platformVel · t` by then, repeat. Three
// rounds is inside a metre at 5 km. Returns the time of flight, or null if the target is beyond
// what the muzzle speed can reach — the caller then leaves the reticle on the line of sight and
// does not pretend.
export function ballisticAim(out, from, target, speed, platformVel, g) {
  let t = 0;
  for (let i = 0; i < 3; i++) {
    _bt.copy(target).addScaledVector(platformVel, -t);
    _bd.copy(_bt).sub(from);
    const h = _bd.y;
    _bh.set(_bd.x, 0, _bd.z);
    const R = _bh.length();
    if (R < 1e-6) { out.set(0, h >= 0 ? 1 : -1, 0); return Math.abs(h) / speed; }
    const v2 = speed * speed;
    const disc = v2 * v2 - g * (g * R * R + 2 * h * v2);
    if (disc < 0) { out.copy(_bd).normalize(); return null; }
    const tanTh = (v2 - Math.sqrt(disc)) / (g * R);
    const th = Math.atan(tanTh);
    _bh.multiplyScalar(1 / R);
    out.copy(_bh).multiplyScalar(Math.cos(th));
    out.y = Math.sin(th);
    out.normalize();
    t = R / (speed * Math.cos(th));
  }
  return t;
}

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
  // the shooter's own gun: reach and shell speed both set where the lead solution lands, and a
  // 1,010 m/s cannon reaching 3,600 m does not lead like a 940 m/s one reaching 2,400
  const gun = shooter.gun || GUNS.cannon;
  let best = null, bestAng = cone;
  for (const o of targets) {
    if (o === shooter || o.dead || o.team === shooter.team) continue;
    _aaLos.copy(o.p).sub(shooter.p);
    const r = _aaLos.length();
    if (r > gun.range || r < 60) continue;
    const ang = Math.acos(THREE.MathUtils.clamp(_aaLos.dot(shooter.fwd) / r, -1, 1));
    if (ang < bestAng) { bestAng = ang; best = o; }
  }
  if (!best) return null;
  leadPoint(_aaLead, shooter.p, best.p, best.v, gun.speed);
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

// ---------------------------------------------------------------------------
// Air to ground
//
// A bomb is the only weapon here you cannot aim. You aim the AIRCRAFT, several seconds early, and
// what decides whether you hit is a prediction. So the prediction is the feature, and everything
// else in this section exists to keep it honest.
//
// Unlike the missile, a bomb carries its own `def` on the instance rather than reading a module
// constant, which is what lets two kinds be in the air at once with different ballistics. The
// missile pool cannot do that yet.
// ---------------------------------------------------------------------------

// `dragArea` is Cd·S in m², the same convention as `COMBAT.msl.dragArea`. Together with `mass` it is
// the ballistic coefficient, and it is the whole difference between these two: the heavy is the
// cleaner store, so it keeps its forward throw and lands further ahead from the same release.
export const BOMBS = {
  gp: {
    id: 'gp', label: 'BOMB', short: 'B', max: 6, cool: 0.32,
    mass: 230, dragArea: 0.085, damage: 170, blast: 40,
    radius: 0.21, len: 1.9,
  },
  heavy: {
    id: 'heavy', label: 'HVY', short: 'H', max: 2, cool: 1.4,
    mass: 900, dragArea: 0.16, damage: 420, blast: 78,
    radius: 0.32, len: 3.0,
  },
};

export const BOMB_KINDS = Object.keys(BOMBS);

// The `{kind: count}` shape. `f.ammo`/`f.missiles`/`f.flares` are bare integers and cannot say "two
// of one store and four of another"; drones already had to solve this and bombs follow them.
export function fullBombLoad() {
  return Object.fromEntries(BOMB_KINDS.map((k) => [k, BOMBS[k].max]));
}

// One fixed substep for every bomb, whatever the frame rate. A store that lands somewhere different
// at 30 fps than at 144 fps is a bug on its own, but the reason it is pinned HERE is the predictor:
// the pipper marches this same step with this same accel, so the two cannot drift apart.
export const BOMB_STEP = 1 / 120;

const _bacc = new THREE.Vector3();

// Gravity plus quadratic drag along the velocity. No lift, no fins, no guidance — a bomb is a
// falling object and the only thing that makes one differ from another is how fast it sheds speed.
export function bombAccel(out, v, def) {
  const V = v.length();
  out.set(0, -G, 0);
  if (V > 1e-3) out.addScaledVector(v, -(0.5 * RHO * V * def.dragArea) / def.mass);
  return out;
}

export function stepBomb(b, dt) {
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(BOMB_STEP, left);
    bombAccel(_bacc, b.v, b.def);
    b.v.addScaledVector(_bacc, h);
    b.p.addScaledVector(b.v, h);
    left -= h;
  }
  b.age += dt;
}

const _pp = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _mid = new THREE.Vector3();

// Where a store released here, now, would land — the CCIP pipper.
//
// It integrates the real trajectory rather than solving a vacuum parabola, because drag is what
// separates the two bomb types and a closed form that ignored it would put the marker in the same
// place for both. Terrain is sampled every `probe` steps rather than every step: `heightAt` is 16
// plane waves and a ridge term, and the integration is three vector adds, so the ground lookup is
// the entire cost. The crossing is then bisected inside that span, which is what stops the marker
// from stepping in visible jumps as the aircraft moves.
//
// Returns seconds to impact, writing the point into `out`, or null if it is still falling at `maxT`.
export function bombImpact(out, from, vel, def, { maxT = 40, probe = 8 } = {}) {
  _pp.copy(from); _pv.copy(vel);
  if (_pp.y <= heightAt(_pp.x, _pp.z)) { out.copy(_pp); return 0; }
  let t = 0, n = 0;
  _prev.copy(_pp);
  while (t < maxT) {
    bombAccel(_bacc, _pv, def);
    _pv.addScaledVector(_bacc, BOMB_STEP);
    _pp.addScaledVector(_pv, BOMB_STEP);
    t += BOMB_STEP;
    if (++n < probe) continue;
    n = 0;
    if (_pp.y <= heightAt(_pp.x, _pp.z)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) * 0.5;
        _mid.lerpVectors(_prev, _pp, mid);
        if (_mid.y <= heightAt(_mid.x, _mid.z)) hi = mid; else lo = mid;
      }
      out.lerpVectors(_prev, _pp, hi);
      out.y = heightAt(out.x, out.z);
      return t - BOMB_STEP * probe * (1 - hi);
    }
    _prev.copy(_pp);
  }
  return null;
}
