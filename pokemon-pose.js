// How far apart are two poses?
//
// Everything about states, transitions and reachability rests on this one number, so it is a module with
// tests rather than something recomputed in a probe each time. `docs/pokemon-lab/math.md` is the write-up.
//
// A pose is one (clip, frame). The distance between two of them is the mass-weighted RMS bone displacement
// as a fraction of body height, measured AFTER solving for the ground-plane transform that minimises it.
// That alignment is the part that is easy to leave out and expensive to leave out: without it a pose read
// from a clip that turns the creature scores far away from the same pose facing elsewhere, and the wrong
// number looks exactly like a right one.
//
// Vertical position is NOT aligned, deliberately. Crouching is not standing, and sliding poses up and down
// to match would erase the difference.

// ===================== small matrix and quaternion math =====================
//
// Column-major, same layout as a THREE.Matrix4's `elements`, so a value from `rig.restWorld` drops in.

export function trsMatrix(p, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    p[0], p[1], p[2], 1,
  ];
}

export function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function invert(m) {
  const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = m;
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (!det) throw new Error('matrix is not invertible');
  const d = 1 / det;
  return [
    t11 * d,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d,
    t12 * d,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d,
    t13 * d,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d,
    t14 * d,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d,
  ];
}

export function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end = b;
  if (d < 0) { end = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const o = a.map((v, i) => v + (end[i] - v) * t);
    const n = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return o.map(v => v / n);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + end[i] * wb);
}

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ===================== sampling =====================

/**
 * A clip's local TRS overrides at `time`, INTERPOLATED.
 *
 * Deliberately not `pokemon-rig.js`'s `sampleClip`, which steps to the nearest key at or before the time.
 * Stepping is right when a person is picking a frame somebody drew; it is wrong for measuring, because
 * 20.3% of tracks in the dex carry fewer keys than their clip has frames. Every track in the dex is
 * LINEAR with uniform key spacing, so LERP and SLERP are exactly what an AnimationMixer would show.
 */
export function sampleAt(clip, time) {
  const out = {};
  const KEY = { rotation: 'q', translation: 'p', scale: 's' };
  for (const track of clip?.tracks || []) {
    const key = KEY[track.path];
    if (!key) continue;
    const { times, values, stride, bone } = track;
    if (!times.length) continue;
    let k = 0;
    while (k < times.length - 1 && times[k + 1] <= time) k++;
    const a = Array.from(values).slice(k * stride, k * stride + stride);
    if (a.length !== stride) continue;
    let v = a;
    if (k < times.length - 1) {
      const b = Array.from(values).slice((k + 1) * stride, (k + 1) * stride + stride);
      const span = times[k + 1] - times[k];
      const t = span > 0 ? Math.min(1, Math.max(0, (time - times[k]) / span)) : 0;
      if (b.length === stride) v = key === 'q' ? slerp(a, b, t) : lerp(a, b, t);
    }
    (out[bone] ??= {})[key] = v;
  }
  return out;
}

// ===================== forward kinematics =====================

/**
 * What sits above the root bone.
 *
 * The pivot tree starts partway down the glTF node tree and Stadium files put a 0.1 scale on an ancestor
 * above the root bone, so composing from the root's own local transform is ten times too big. A uniform
 * scale does not change the RANKING of poses, so the mistake produces numbers that stay internally
 * consistent and are all wrong -- `checkRestPose` is the guard.
 */
export function rootPreMatrix(rig) {
  const b = rig.byKey.get(rig.root);
  if (!b) throw new Error('rig has no root bone');
  return multiply(Array.from(b.restWorld), invert(trsMatrix(b.rest.p, b.rest.q, b.rest.s)));
}

/**
 * Every bone's world position at one frame, in `rig.bones` order.
 *
 * `frame` may be fractional. Pass a null clip for the rest pose. Returns a flat xyz array so two poses of
 * the same rig can be compared by index without hashing a key per bone.
 */
export function readPose(rig, clip, frame, pre = rootPreMatrix(rig)) {
  const fps = clip?.fps || 30;
  const local = clip ? sampleAt(clip, frame / fps) : {};
  const world = new Map();
  const at = (bone) => {
    const cached = world.get(bone.key);
    if (cached) return cached;
    const o = local[bone.key] || {};
    const m = trsMatrix(o.p || bone.rest.p, o.q || bone.rest.q, o.s || bone.rest.s);
    const parent = bone.parent ? rig.byKey.get(bone.parent) : null;
    const w = multiply(parent ? at(parent) : pre, m);
    world.set(bone.key, w);
    return w;
  };
  const out = new Float64Array(rig.bones.length * 3);
  rig.bones.forEach((bone, i) => {
    const w = at(bone);
    out[i * 3] = w[12]; out[i * 3 + 1] = w[13]; out[i * 3 + 2] = w[14];
  });
  return out;
}

/** The rest pose must reproduce what the rig already measured. Returns the worst error in model units. */
export function checkRestPose(rig) {
  const pose = readPose(rig, null, 0);
  let worst = 0;
  rig.bones.forEach((bone, i) => {
    const w = bone.restWorld;
    worst = Math.max(worst, Math.hypot(pose[i * 3] - w[12], pose[i * 3 + 1] - w[13], pose[i * 3 + 2] - w[14]));
  });
  return worst;
}

/**
 * How much mesh hangs off each bone, in `rig.bones` order.
 *
 * Skinning is rigid on all 151 models -- one bone per vertex at weight 1.0 -- so each bone owns a definite
 * lump and there is nothing to approximate. This is mesh DENSITY rather than mass, so a finely tessellated
 * head outvotes a coarse torso. A rig with no skinned geometry falls back to counting bones equally.
 */
export function poseWeights(rig) {
  const w = new Float64Array(rig.bones.length);
  let total = 0;
  rig.bones.forEach((bone, i) => { w[i] = rig.geometry.get(bone.key)?.count ?? 0; total += w[i]; });
  if (!total) w.fill(1);
  return w;
}

// ===================== alignment =====================

/**
 * The ground-plane transform that brings `b` closest to `a`: a yaw about the vertical axis and a
 * translation in x and z. Height is left alone.
 *
 * Closed form, following Kovar, Gleicher & Pighin, "Motion Graphs" (2002). Translation drops out by
 * centring both clouds on their weighted xz centroid, which leaves a single angle to maximise:
 *
 *   theta = atan2( sum w (ax*bz - az*bx), sum w (ax*bx + az*bz) )
 *
 * over the centred coordinates. Both sums are zero only for a cloud with no horizontal extent, where any
 * yaw is as good as another and zero is returned.
 */
export function alignYaw(a, b, weights) {
  let W = 0, ax = 0, az = 0, bx = 0, bz = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (!w) continue;
    W += w;
    ax += w * a[i * 3]; az += w * a[i * 3 + 2];
    bx += w * b[i * 3]; bz += w * b[i * 3 + 2];
  }
  if (!W) return { theta: 0, dx: 0, dz: 0, degenerate: true };
  ax /= W; az /= W; bx /= W; bz /= W;

  let C = 0, S = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (!w) continue;
    const px = a[i * 3] - ax, pz = a[i * 3 + 2] - az;
    const qx = b[i * 3] - bx, qz = b[i * 3 + 2] - bz;
    C += w * (px * qx + pz * qz);
    S += w * (px * qz - pz * qx);
  }
  const degenerate = Math.hypot(C, S) < 1e-12;
  const theta = degenerate ? 0 : Math.atan2(S, C);
  // Translation is whatever puts the rotated b centroid on the a centroid.
  const cos = Math.cos(theta), sin = Math.sin(theta);
  return {
    theta,
    dx: ax - (cos * bx + sin * bz),
    dz: az - (-sin * bx + cos * bz),
    degenerate,
  };
}

/** Apply an `alignYaw` result to a pose, returning a new one. */
export function applyAlignment(pose, { theta, dx, dz }) {
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const out = new Float64Array(pose.length);
  for (let i = 0; i < pose.length; i += 3) {
    const x = pose[i], z = pose[i + 2];
    out[i] = cos * x + sin * z + dx;
    out[i + 1] = pose[i + 1];
    out[i + 2] = -sin * x + cos * z + dz;
  }
  return out;
}

// ===================== distance =====================

/**
 * Mass-weighted RMS bone displacement between two poses, as a fraction of body height.
 *
 * `align` defaults on. Turning it off root-centres instead, which is what this module did before the
 * alignment was written and is kept only so the difference can be measured.
 */
export function poseDistance(a, b, { weights, height = 1, align = true, rootIndex = 0 } = {}) {
  if (!weights) throw new Error('poseDistance needs weights');
  let A = a, B = b;
  if (align) {
    B = applyAlignment(b, alignYaw(a, b, weights));
  } else {
    A = recentre(a, rootIndex);
    B = recentre(b, rootIndex);
  }
  let num = 0, den = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (!w) continue;
    const dx = A[i * 3] - B[i * 3], dy = A[i * 3 + 1] - B[i * 3 + 1], dz = A[i * 3 + 2] - B[i * 3 + 2];
    num += w * (dx * dx + dy * dy + dz * dz);
    den += w;
  }
  return den ? Math.sqrt(num / den) / (height || 1) : Infinity;
}

/** The old behaviour: everything measured relative to one bone. */
function recentre(pose, index) {
  const ox = pose[index * 3], oy = pose[index * 3 + 1], oz = pose[index * 3 + 2];
  const out = new Float64Array(pose.length);
  for (let i = 0; i < pose.length; i += 3) {
    out[i] = pose[i] - ox; out[i + 1] = pose[i + 1] - oy; out[i + 2] = pose[i + 2] - oz;
  }
  return out;
}

// ===================== per-species scale =====================

/**
 * How much this species moves between one frame and the next, as a median over every adjacent pair in
 * every clip. It is the unit a raw distance is worth reading in: Squirtle moves five times as far per
 * frame as Pikachu, so the same number means different things.
 */
export function frameOfMotion(rig, opts = {}) {
  const weights = opts.weights || poseWeights(rig);
  const height = opts.height ?? rig.units.height;
  const align = opts.align ?? true;
  const pre = rootPreMatrix(rig);
  const steps = [];
  for (const clip of rig.clips) {
    let prev = readPose(rig, clip, 0, pre);
    for (let f = 1; f < clip.frames; f++) {
      const cur = readPose(rig, clip, f, pre);
      steps.push(poseDistance(prev, cur, { weights, height, align }));
      prev = cur;
    }
  }
  if (!steps.length) return 0;
  steps.sort((x, y) => x - y);
  return steps[steps.length >> 1];
}

// ===================== windows =====================
//
// A single frame carries no direction. Two poses can match exactly while moving in opposite directions,
// which splices badly however good the distance looks -- the pose at the top of a jump matches the pose at
// the top of a fall.
//
// The fix is to compare a run of consecutive frames as one point cloud, with ONE alignment solved over the
// whole window rather than one per frame. That single shared transform is what makes it work: a window
// that turns left cannot be matched to one that turns right by rotating it, because the same rotation has
// to serve every frame in it.
//
// This needs no new distance function. Concatenate k poses and tile the bone weights k times, and
// `alignYaw` and `poseDistance` operate on the bigger cloud unchanged.

/** Bone weights repeated once per frame of a window, so a window can be handed to `poseDistance`. */
export function tileWeights(weights, length) {
  const out = new Float64Array(weights.length * length);
  for (let k = 0; k < length; k++) out.set(weights, k * weights.length);
  return out;
}

/**
 * `length` consecutive poses as one point cloud, or null if the window does not fit inside the clip.
 *
 * Null rather than a clamped or shortened window on purpose: repeating the last frame would make the end
 * of every clip look motionless and match anything else that is motionless, and a shortened window is not
 * comparable to a full one. A frame too near the end of a clip simply has no window, which is the honest
 * answer -- there is nothing there to blend with.
 *
 * `step` of -1 reads the window backwards, which is how the same pose leaving in the other direction is
 * measured.
 */
export function readWindow(rig, clip, frame, { length = 5, step = 1, pre = null } = {}) {
  const P = pre || rootPreMatrix(rig);
  const last = (clip?.frames ?? 1) - 1;
  const end = frame + step * (length - 1);
  if (frame < 0 || frame > last || end < 0 || end > last) return null;
  const n = rig.bones.length * 3;
  const out = new Float64Array(n * length);
  for (let k = 0; k < length; k++) out.set(readPose(rig, clip, frame + step * k, P), k * n);
  return out;
}

/**
 * Every window in every clip. Poses are the expensive part, so each frame is evaluated once and shared
 * between the windows that contain it.
 *
 * Entries have the same shape as `readAllPoses`, so `nearestPerClip` takes either -- but a window needs
 * `tileWeights(poseWeights(rig), length)` rather than the plain weights.
 */
export function readAllWindows(rig, { length = 5, step = 1 } = {}) {
  const pre = rootPreMatrix(rig);
  const n = rig.bones.length * 3;
  const out = [];
  for (const clip of rig.clips) {
    const poses = [];
    for (let f = 0; f < clip.frames; f++) poses.push(readPose(rig, clip, f, pre));
    for (let f = 0; f < clip.frames; f++) {
      const end = f + step * (length - 1);
      if (end < 0 || end > clip.frames - 1) continue;
      const win = new Float64Array(n * length);
      for (let k = 0; k < length; k++) win.set(poses[f + step * k], k * n);
      out.push({ clip: clip.index, name: clip.name, frame: f, pose: win });
    }
  }
  return out;
}

/** Every frame of every clip, ready to be compared. Poses are the expensive part, so build them once. */
export function readAllPoses(rig) {
  const pre = rootPreMatrix(rig);
  const out = [];
  for (const clip of rig.clips) {
    for (let f = 0; f < clip.frames; f++) out.push({ clip: clip.index, name: clip.name, frame: f, pose: readPose(rig, clip, f, pre) });
  }
  return out;
}

/**
 * The nearest frame to `target` in each clip, nearest clip first.
 *
 * `skipClip` leaves out the clip the target came from, which otherwise wins by being the target.
 */
export function nearestPerClip(rig, all, target, { weights, height, align = true, skipClip = null } = {}) {
  const w = weights || poseWeights(rig);
  const h = height ?? rig.units.height;
  const best = new Map();
  for (const entry of all) {
    if (entry.clip === skipClip) continue;
    const d = poseDistance(target, entry.pose, { weights: w, height: h, align });
    const prev = best.get(entry.clip);
    if (!prev || d < prev.distance) best.set(entry.clip, { clip: entry.clip, name: entry.name, frame: entry.frame, distance: d });
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance);
}
