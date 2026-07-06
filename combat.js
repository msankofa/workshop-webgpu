// combat.js — pure hitscan combat math (multiplayer guns M1). No three.js import, so it
// runs under Node for unit tests and in the browser for the host/guest sim. Vectors are
// plain [x, y, z] arrays throughout; see docs/superpowers/specs/2026-07-05-multiplayer-guns-design.md.
//
// Scope: ray/capsule hit registration, shot validation, damage reduction, and a small
// per-player pose history used for host-side lag compensation (M1 has no networking wired
// in yet — that lands in M2/M3).

// ---- vector helpers (internal) --------------------------------------------------------
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function length(a) { return Math.hypot(a[0], a[1], a[2]); }

// Returns a normalized copy of `dir`, or null if it is zero-length or non-finite.
export function normalizeDir(dir) {
  if (!dir || dir.length < 3) return null;
  const [x, y, z] = dir;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-8)) return null;
  return [x / len, y / len, z / len];
}

// Ray (origin + dir*t, t in [0, range]) vs a vertical capsule.
//   capsule: { p:[x,y,z], r, h } — segment runs from p.y - h*0.5 to p.y + h*0.5 at (p.x, p.z).
// Returns { hit:true, distance, point } for the earliest valid intersection, else { hit:false }.
export function rayCapsuleHit(origin, dir, range, capsule) {
  const d = normalizeDir(dir);
  if (!d) return { hit: false };
  if (!(range > 0)) return { hit: false };
  const { p, r, h } = capsule;
  const segStart = [p[0], p[1] - h * 0.5, p[2]];
  const segEnd = [p[0], p[1] + h * 0.5, p[2]];

  // Closest-approach test of an infinite ray against a finite capsule: solve the quadratic
  // for the infinite cylinder around the segment axis, then clamp intersections to the
  // segment's Y range; separately test the two end-cap spheres. Take the earliest valid t.
  const axis = sub(segEnd, segStart);           // [0, h, 0]
  const axisLenSq = dot(axis, axis);
  let best = null;

  const considerT = (t, point) => {
    if (t < 0 || t > range) return;
    if (best === null || t < best.t) best = { t, point };
  };

  if (axisLenSq < 1e-12) {
    // Degenerate capsule (h ~ 0): treat as a sphere at p.
    testSphere(origin, d, range, p, r, considerT);
  } else {
    // Infinite cylinder: |(o - segStart) + t*d - axisHat*((o-segStart+t*d)·axisHat)|^2 = r^2
    const axisHat = scale(axis, 1 / Math.sqrt(axisLenSq));
    const oc = sub(origin, segStart);
    const ocDotAxis = dot(oc, axisHat);
    const dDotAxis = dot(d, axisHat);
    // perpendicular components
    const ocPerp = sub(oc, scale(axisHat, ocDotAxis));
    const dPerp = sub(d, scale(axisHat, dDotAxis));

    const A = dot(dPerp, dPerp);
    const B = 2 * dot(ocPerp, dPerp);
    const C = dot(ocPerp, ocPerp) - r * r;

    if (A > 1e-12) {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const t1 = (-B - sq) / (2 * A);
        const t2 = (-B + sq) / (2 * A);
        for (const t of [t1, t2]) {
          if (t < 0 || t > range) continue;
          const pt = add(origin, scale(d, t));
          const along = dot(sub(pt, segStart), axisHat);
          if (along >= 0 && along <= Math.sqrt(axisLenSq)) considerT(t, pt);
        }
      }
    }

    // End-cap spheres (covers rays that enter through the rounded top/bottom).
    testSphere(origin, d, range, segStart, r, considerT);
    testSphere(origin, d, range, segEnd, r, considerT);
  }

  if (!best) return { hit: false };
  return { hit: true, distance: best.t, point: best.point };
}

function testSphere(origin, d, range, center, r, considerT) {
  const oc = sub(origin, center);
  const A = dot(d, d); // 1 (d is normalized)
  const B = 2 * dot(oc, d);
  const C = dot(oc, oc) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  for (const t of [t1, t2]) {
    if (t < 0 || t > range) continue;
    considerT(t, add(origin, scale(d, t)));
  }
}

// Finds the nearest player hit by a ray, skipping the shooter, dead players, and anything
// out of range. `occlusion(origin, point) -> boolean` is optional and defaults to no
// occlusion; return true from it to block a would-be hit (e.g. terrain/map blocking LOS).
export function findPlayerHit({ shooterId, players, origin, dir, range, occlusion }) {
  const d = normalizeDir(dir);
  if (!d || !players || !(range > 0)) return null;
  let best = null;
  for (const player of players) {
    if (!player || player.id === shooterId) continue;
    if (player.alive === false) continue;
    const capsule = { p: player.p, r: player.r, h: player.h };
    const result = rayCapsuleHit(origin, d, range, capsule);
    if (!result.hit) continue;
    if (best !== null && result.distance >= best.distance) continue;
    if (typeof occlusion === 'function' && occlusion(origin, result.point)) continue;
    best = { targetId: player.id, distance: result.distance, point: result.point };
  }
  return best;
}

// Derives a canonical shooter head/muzzle origin from the shooter capsule: capsule centre
// raised by h*0.5, i.e. the top of the capsule (approximates eye height for a standing
// player). Kept intentionally simple for M1; refine per weapon/pose later if needed.
function shooterHeadOrigin(shooter) {
  const [x, y, z] = shooter.p;
  return [x, y + shooter.h * 0.5, z];
}

const MAX_ORIGIN_DRIFT = 1.25; // metres; see design doc "Host Validation".

// Validates an incoming fire intent against host-owned shooter/weapon/cooldown state.
// Returns { ok:true } or { ok:false, reason }.
export function validateShot({ shooter, weapon, intent, nowMs, lastShot }) {
  if (!shooter) return { ok: false, reason: 'no-shooter' };
  if (shooter.alive === false) return { ok: false, reason: 'shooter-dead' };
  if (!weapon) return { ok: false, reason: 'unknown-weapon' };
  if (shooter.weapon != null && intent && intent.weapon != null && shooter.weapon !== intent.weapon) {
    return { ok: false, reason: 'weapon-not-equipped' };
  }
  if (!intent) return { ok: false, reason: 'no-intent' };

  const prevSeq = lastShot && Number.isFinite(lastShot.shotSeq) ? lastShot.shotSeq : -Infinity;
  if (!Number.isFinite(intent.shotSeq) || intent.shotSeq <= prevSeq) {
    return { ok: false, reason: 'stale-shot-seq' };
  }

  const prevAt = lastShot && Number.isFinite(lastShot.at) ? lastShot.at : -Infinity;
  if (Number.isFinite(nowMs) && nowMs - prevAt < weapon.fireIntervalMs) {
    return { ok: false, reason: 'cooldown' };
  }

  const dir = normalizeDir(intent.dir);
  if (!dir) return { ok: false, reason: 'invalid-dir' };

  if (!Array.isArray(intent.origin) || intent.origin.length < 3
    || !intent.origin.every(Number.isFinite)) {
    return { ok: false, reason: 'invalid-origin' };
  }
  const head = shooterHeadOrigin(shooter);
  const drift = length(sub(intent.origin, head));
  if (drift > MAX_ORIGIN_DRIFT) return { ok: false, reason: 'origin-too-far' };

  return { ok: true };
}

// Pure damage reducer: returns a NEW { hp, alive } derived from targetCombat and weapon.
export function applyGunDamage(targetCombat, weapon) {
  const hp = Math.max(0, targetCombat.hp - weapon.damage);
  return { hp, alive: hp > 0 };
}

// ---- pose history (host-side lag compensation) -----------------------------------------
// history: Map<id, Array<{ t, p, q, h, r, alive, hp }>> — samples for one player, oldest first.

export function pushPlayerPose(history, id, pose, nowMs) {
  let list = history.get(id);
  if (!list) { list = []; history.set(id, list); }
  list.push({
    t: nowMs,
    p: pose.p,
    q: pose.q,
    h: pose.h,
    r: pose.r,
    alive: pose.alive,
    hp: pose.hp,
  });
  return list;
}

// Linearly interpolates position between the two samples bracketing targetTimeMs. Clamps
// to the oldest/newest sample outside the recorded range. Other fields (q, h, r, alive, hp)
// are taken from the later of the two bracketing samples (no meaningful interpolation for
// booleans/orientation in M1). Returns null if there's no history for `id`.
export function samplePlayerPose(history, id, targetTimeMs) {
  const list = history.get(id);
  if (!list || list.length === 0) return null;
  if (list.length === 1 || targetTimeMs <= list[0].t) return clonePose(list[0]);
  const last = list[list.length - 1];
  if (targetTimeMs >= last.t) return clonePose(last);

  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (targetTimeMs <= b.t) {
      const span = b.t - a.t;
      const frac = span > 1e-9 ? (targetTimeMs - a.t) / span : 0;
      return {
        t: targetTimeMs,
        p: [
          a.p[0] + (b.p[0] - a.p[0]) * frac,
          a.p[1] + (b.p[1] - a.p[1]) * frac,
          a.p[2] + (b.p[2] - a.p[2]) * frac,
        ],
        q: b.q,
        h: b.h,
        r: b.r,
        alive: b.alive,
        hp: b.hp,
      };
    }
  }
  return clonePose(last);
}

function clonePose(sample) {
  return { t: sample.t, p: sample.p.slice(), q: sample.q, h: sample.h, r: sample.r, alive: sample.alive, hp: sample.hp };
}

// Drops samples older than maxAgeMs (default 750, per design doc "Lag Compensation").
export function prunePlayerPoseHistory(history, nowMs, maxAgeMs = 750) {
  for (const [id, list] of history) {
    const cutoff = nowMs - maxAgeMs;
    let firstKeep = 0;
    while (firstKeep < list.length - 1 && list[firstKeep].t < cutoff) firstKeep++;
    if (firstKeep > 0) list.splice(0, firstKeep);
    if (list.length === 0) history.delete(id);
  }
}
