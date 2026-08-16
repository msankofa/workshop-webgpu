// Poses for a Stadium rig: capture, blend, and the arithmetic underneath.
//
// A pose is local TRS per bone NAME — deliberately the same shape a glTF animation channel targets, so a
// timeline and an exporter can be built on this later without reshaping anything. Names rather than node
// indices because the scene graph works in names and `SkeletonUtils.clone` preserves them, which makes a
// pose portable between two individuals of a species.
//
// Pure: no THREE, no DOM. The demo does the scene-graph traversal and hands plain numbers in and out.

/** One bone's local transform, as plain arrays. */
export const trs = (p, q, s) => ({ p: [...p], q: [...q], s: [...s] });

export function emptyPose(name = 'pose', species = null) {
  return { name, species, bones: {} };
}

/** A pose under a new name, sharing nothing with the original — every return path owes the caller this. */
export function copyPose(pose, name = pose.name) {
  const out = emptyPose(name, pose.species ?? null);
  for (const [bone, t] of Object.entries(pose.bones)) out.bones[bone] = trs(t.p, t.q, t.s);
  return out;
}

/** Vector lerp, componentwise. */
export function lerpVec(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Quaternion slerp, taking the short way round.
 *
 * The sign flip is the part worth having a test for: q and -q are the same orientation, so without it a
 * blend between two poses can take the long way and a limb swings through the body to get somewhere it
 * was almost already at.
 */
export function slerpQuat(a, b, t) {
  let [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  // Near-parallel: slerp's sine denominator collapses, so fall back to a normalised lerp.
  if (dot > 0.9995) {
    const out = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t];
    const l = Math.hypot(...out) || 1;
    return out.map(v => v / l);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

/**
 * Blend two poses. `t` of 0 is all `a`, 1 is all `b`.
 *
 * A bone present in only one pose keeps that pose's value at full strength rather than blending toward
 * nothing — a half-captured pose then reads as "these bones are unmanaged", which is recoverable, instead
 * of collapsing those bones to the origin, which is not.
 */
export function blendPoses(a, b, t, { name = 'blend' } = {}) {
  if (!a) return b ? copyPose(b, name) : emptyPose(name);
  if (!b) return copyPose(a, name);
  const k = Math.min(1, Math.max(0, t));
  const out = emptyPose(name, a.species ?? b.species ?? null);
  for (const bone of new Set([...Object.keys(a.bones), ...Object.keys(b.bones)])) {
    const x = a.bones[bone], y = b.bones[bone];
    if (!x) { out.bones[bone] = trs(y.p, y.q, y.s); continue; }
    if (!y) { out.bones[bone] = trs(x.p, x.q, x.s); continue; }
    out.bones[bone] = { p: lerpVec(x.p, y.p, k), q: slerpQuat(x.q, y.q, k), s: lerpVec(x.s, y.s, k) };
  }
  return out;
}

/**
 * Blend along an ordered list of poses with one 0..1 dial, so a scrubber can cross several keys.
 *
 * This is not yet a timeline — the keys are evenly spaced and there is no timing — but it is the same
 * traversal a timeline needs, and having it here means the demo does not grow its own copy.
 */
export function blendSequence(poses, t, opts = {}) {
  const list = (poses || []).filter(Boolean);
  if (!list.length) return emptyPose(opts.name ?? 'blend');
  if (list.length === 1) return copyPose(list[0], opts.name ?? list[0].name);
  const k = Math.min(1, Math.max(0, t)) * (list.length - 1);
  const i = Math.min(list.length - 2, Math.floor(k));
  return blendPoses(list[i], list[i + 1], k - i, opts);
}

/** Reject anything that is not a usable pose, rather than letting it reach the scene graph. */
export function validatePose(pose) {
  const bad = [];
  if (!pose || typeof pose !== 'object' || !pose.bones || typeof pose.bones !== 'object') {
    return { ok: false, problems: ['not a pose object'], count: 0 };
  }
  const num3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const num4 = (v) => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite);
  for (const [bone, t] of Object.entries(pose.bones)) {
    if (!t || !num3(t.p) || !num4(t.q) || !num3(t.s)) { bad.push(bone); continue; }
    if (Math.hypot(...t.q) < 1e-6) bad.push(bone);
  }
  const count = Object.keys(pose.bones).length;
  return {
    ok: count > 0 && !bad.length,
    count,
    problems: [
      ...(count ? [] : ['pose has no bones']),
      ...(bad.length ? [`${bad.length} bone(s) with bad numbers: ${bad.slice(0, 4).join(', ')}`] : []),
    ],
  };
}

/**
 * How far apart two poses are, as the largest rotation of any shared bone, in radians.
 *
 * The dot is divided by both magnitudes rather than assumed unit. Repeated quaternion multiplication —
 * `Object3D.rotateY` in a loop, say — drifts off unit length by a part in ten million, and `acos` near 1
 * turns that into 0.06 degrees, so a pose read as that far from ITSELF.
 */
export function poseDistance(a, b) {
  if (!a || !b) return Infinity;
  let worst = 0;
  for (const bone of Object.keys(a.bones)) {
    const x = a.bones[bone], y = b.bones[bone];
    if (!y) continue;
    const la = Math.hypot(...x.q), lb = Math.hypot(...y.q);
    if (la < 1e-12 || lb < 1e-12) continue;
    const dot = Math.abs(x.q[0] * y.q[0] + x.q[1] * y.q[1] + x.q[2] * y.q[2] + x.q[3] * y.q[3]) / (la * lb);
    worst = Math.max(worst, 2 * Math.acos(Math.min(1, dot)));
  }
  return worst;
}

/** Keep only the bones a caller cares about — the seed of "this clip drives the legs and nothing else". */
export function subsetPose(pose, keep) {
  const set = keep instanceof Set ? keep : new Set(keep);
  const out = emptyPose(pose.name, pose.species);
  for (const [bone, t] of Object.entries(pose.bones)) if (set.has(bone)) out.bones[bone] = trs(t.p, t.q, t.s);
  return out;
}
