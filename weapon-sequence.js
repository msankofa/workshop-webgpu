// weapon-sequence.js
// Pure evaluator for weapon pose sequences (Contract 5, see
// docs/subsystems/procedural-body-weapon-contracts.md and
// docs/superpowers/specs/2026-07-06-procedural-gunplay-design.md).
// No Three.js import — must stay browser+Node safe so it can be unit-tested
// with plain `node test-weapon-sequence.mjs` and imported from any renderer.
//
// Data shapes (frozen by the contract doc):
//   weaponPose : { p:[x,y,z], r:[x,y,z] (euler), scale }
//   sequence   : { duration, commitAmmoAt, poses?: { name: weaponPose }, keys: [
//                   { t, weaponPose, right, left, event }
//                 ] }
//   target ref : one of
//     "rightGrip"                       — weapon-anchor name (string, found in `anchors`)
//     "beltMagazine"                    — body-anchor name (string, NOT found in `anchors`)
//     { weaponAnchor, offset:[x,y,z] }  — anchor plus local offset
//     { body:  [x,y,z] }                — body-local point
//     { camera:[x,y,z] }                — camera-local point (first-person viewmodel)
//     { world: [x,y,z] }                — absolute world point (debug)
//
// `evaluateSequence(seq, t, prevT)` only carries forward the *raw* ref value that is active
// at time t for each hand channel — it does not know about anchors/body/camera roots, so it
// can't spatially resolve a target itself. Call `resolveTargetRef(ref, ctx)` separately (with
// whatever anchors/roots the caller has in scope) to turn that raw ref into a spatial
// descriptor. This keeps evaluateSequence a pure function of (seq, t) with no scene-graph
// dependency.
//
// `seq.poses` is an optional, self-contained subset of the named poses referenced by this
// sequence's keys (copied in from weapon-poses.json's top-level `weaponPoses` at authoring
// time) — it lets evaluateSequence resolve `weaponPose: 'aimed'` string references without
// needing a second parameter or any global lookup table.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function lerp(a, b, f) { return a + (b - a) * f; }

function lerpVec(a, b, f) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = lerp(a[i] ?? 0, b[i] ?? 0, f);
  return out;
}

function lerpPose(a, b, f) {
  return {
    p: lerpVec(a.p || [0, 0, 0], b.p || [0, 0, 0], f),
    r: lerpVec(a.r || [0, 0, 0], b.r || [0, 0, 0], f),
    scale: lerp(a.scale ?? 1, b.scale ?? 1, f),
  };
}

// Resolves a key's `weaponPose` field (string name into `poses`, or an inline pose object)
// into a concrete { p, r, scale } pose object. Returns null if unresolvable.
function poseValueToObj(val, poses) {
  if (val == null) return null;
  if (typeof val === 'string') return (poses && poses[val]) || null;
  return val;
}

// Finds the bounding keys for a given channel field ('weaponPose' | 'right' | 'left') around
// time t: the last key at/before t that defines the field, and the first key after t that
// defines it. Either may be null (t before the first defining key, or after the last).
function findChannelBounds(keys, field, t) {
  let before = null;
  let after = null;
  for (const key of keys) {
    if (key[field] === undefined) continue;
    if (key.t <= t) {
      if (!before || key.t > before.t) before = key;
    } else if (after === null || key.t < after.t) {
      after = key;
    }
  }
  return { before, after };
}

function evalPoseChannel(keys, t, poses) {
  const { before, after } = findChannelBounds(keys, 'weaponPose', t);
  if (!before && !after) return null;
  if (!after || before === after) return poseValueToObj((before || after).weaponPose, poses);
  if (!before) return poseValueToObj(after.weaponPose, poses);
  const a = poseValueToObj(before.weaponPose, poses);
  const b = poseValueToObj(after.weaponPose, poses);
  if (!a || !b) return a || b || null;
  const span = after.t - before.t;
  const f = span > 0 ? clamp((t - before.t) / span, 0, 1) : 1;
  return lerpPose(a, b, f);
}

// Hand targets are carried forward, not interpolated — jumping between disparate anchors
// (grip -> magwell -> belt -> grip) can't be usefully lerped without IK context, so the most
// recently specified ref simply stays active until the next key changes it.
function evalRefChannel(keys, field, t) {
  const { before } = findChannelBounds(keys, field, t);
  return before ? before[field] : null;
}

// Returns the events whose key.t falls in the open-closed interval (prevT, t] — i.e. crossed
// during this step of forward playback. Scrubbing backward (prevT > t, or omitting prevT)
// yields no events, since there is no well-defined "crossing" to report.
function evalEvents(keys, prevT, t) {
  if (prevT == null || t <= prevT) return [];
  const events = [];
  for (const key of keys) {
    if (key.event == null) continue;
    if (key.t > prevT && key.t <= t) events.push({ t: key.t, event: key.event });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

/**
 * Evaluates a sequence at time t.
 * @param {object} seq - { duration, commitAmmoAt, poses?, keys }
 * @param {number} t - evaluation time, clamped to [0, seq.duration]
 * @param {number|null} [prevT] - previous evaluation time, used only to detect event crossings
 * @returns {{ t:number, weaponPose:object|null, right:*, left:*, events:Array<{t:number,event:string}> }}
 */
export function evaluateSequence(seq, t, prevT = null) {
  const duration = seq && typeof seq.duration === 'number' ? seq.duration : 0;
  const keys = (seq && seq.keys) || [];
  const clampedT = clamp(t, 0, duration);
  const clampedPrevT = prevT == null ? null : clamp(prevT, 0, duration);

  return {
    t: clampedT,
    weaponPose: evalPoseChannel(keys, clampedT, seq && seq.poses),
    right: evalRefChannel(keys, 'right', clampedT),
    left: evalRefChannel(keys, 'left', clampedT),
    events: evalEvents(keys, clampedPrevT, clampedT),
  };
}

// ---------------------------------------------------------------------------
// Hand-target glide
// ---------------------------------------------------------------------------

/**
 * Advances a 0..1 glide progress at CONSTANT SPEED — distance, not a fixed time, sets the
 * duration. `dist` is the length (meters) of the transition captured when it began; the hand
 * covers `speed * dt` meters this step, so progress grows by (speed*dt)/dist. A long grip->belt
 * reach therefore takes proportionally longer than a short charging-handle nudge at the same
 * speed. Non-positive/NaN speed, or a ~zero distance, snaps straight to 1 (instant).
 * Pure scalar math (no THREE) so it's unit-testable headlessly.
 * @param {number} p current progress 0..1
 * @param {number} dist transition distance (meters), captured at glide start
 * @param {number} speed glide speed (m/s)
 * @param {number} dt seconds elapsed this step
 * @returns {number} next progress, clamped to <= 1
 */
export function advanceGlideProgress(p, dist, speed, dt) {
  if (!(speed > 0)) return 1;       // non-positive / NaN speed => snap
  if (!(dist > 1e-9)) return 1;     // already coincident => snap
  const next = p + (speed * (dt || 0)) / dist;
  return next >= 1 ? 1 : next;
}

/**
 * Continuous constant-speed chase of a weapon-root pose toward a (possibly moving) target pose.
 * Unlike advanceGlideProgress this holds no captured distance or from/to — it just steps `current`
 * toward `target` by at most `speed * dt` meters of POSITION each call, so it makes no assumption
 * that a motion starts or ends anywhere (the reload's begin, end, and the idle it returns to are
 * three independent poses). Rotation (euler) and scale advance by the same fraction the position
 * covers, so they arrive together. When the remaining position distance is within one step (or
 * speed is non-positive), it snaps to `target`. Pure (no THREE); returns a fresh pose object.
 * @param {{p:number[],r:number[],scale?:number}} current
 * @param {{p:number[],r:number[],scale?:number}} target
 * @param {number} speed  m/s
 * @param {number} dt     seconds
 */
export function advancePoseChase(current, target, speed, dt) {
  const dpx = target.p[0] - current.p[0];
  const dpy = target.p[1] - current.p[1];
  const dpz = target.p[2] - current.p[2];
  const dist = Math.sqrt(dpx * dpx + dpy * dpy + dpz * dpz);
  const step = (speed > 0 ? speed : Infinity) * (dt || 0);
  const f = (!(speed > 0) || dist <= step || dist < 1e-9) ? 1 : step / dist;
  const cs = current.scale ?? 1;
  const ts = target.scale ?? 1;
  return {
    p: [current.p[0] + dpx * f, current.p[1] + dpy * f, current.p[2] + dpz * f],
    r: [
      current.r[0] + (target.r[0] - current.r[0]) * f,
      current.r[1] + (target.r[1] - current.r[1]) * f,
      current.r[2] + (target.r[2] - current.r[2]) * f,
    ],
    scale: cs + (ts - cs) * f,
  };
}

// ---------------------------------------------------------------------------
// Reload pose delta (first-person viewmodel)
// ---------------------------------------------------------------------------

/**
 * Reload weapon-root pose expressed as a delta from the sequence's OWN start pose, so a caller
 * (e.g. the FP viewmodel) can add it on top of its own idle/aim pose math instead of replacing it.
 * Anchoring to the sequence's t=0 pose makes the delta ~0 at t=0 and at the closing key (which
 * returns to the start pose) by construction — no dependency on any external reference pose, so
 * it stays flush at both ends even if a sequence doesn't start from `aimed`. Pure (no THREE).
 * @param {object} seq - reload sequence (weapon-poses.json reloadSequence[weaponId])
 * @param {number} t - evaluation time
 * @returns {{dp:number[], dr:number[], dScale:number}}
 */
export function reloadPoseDelta(seq, t) {
  const zero = { dp: [0, 0, 0], dr: [0, 0, 0], dScale: 0 };
  if (!seq) return zero;
  const start = evaluateSequence(seq, 0).weaponPose;
  const { weaponPose } = evaluateSequence(seq, t);
  if (!start || !weaponPose) return zero;
  const sp = start.p || [0, 0, 0];
  const sr = start.r || [0, 0, 0];
  const ss = start.scale ?? 1;
  const wp = weaponPose.p || [0, 0, 0];
  const wr = weaponPose.r || [0, 0, 0];
  const ws = weaponPose.scale ?? 1;
  return {
    dp: [wp[0] - sp[0], wp[1] - sp[1], wp[2] - sp[2]],
    dr: [wr[0] - sr[0], wr[1] - sr[1], wr[2] - sr[2]],
    dScale: ws - ss,
  };
}

// ---------------------------------------------------------------------------
// Target ref resolution
// ---------------------------------------------------------------------------

const IDENTITY_Q = [0, 0, 0, 1];

function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotateVecByQuat(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + qw * t + cross(q.xyz, t)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

function addVec(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

// Composes a root transform ({ position:[x,y,z], quaternion:[x,y,z,w] }) with a local
// position/quaternion, producing a world-space { position, quaternion }.
// `scale` is opt-in per call site (only weapon-anchor refs pass root.scale) so body/camera
// refs, whose offsets are already authored in body-scale units, aren't scaled a second time.
function composeRoot(root, localP, localQ, scale) {
  const rootPos = (root && root.position) || [0, 0, 0];
  const rootQuat = (root && root.quaternion) || IDENTITY_Q;
  const s = scale || [1, 1, 1];
  const scaledP = [localP[0] * s[0], localP[1] * s[1], localP[2] * s[2]];
  return {
    position: addVec(rootPos, rotateVecByQuat(rootQuat, scaledP)),
    quaternion: quatMultiply(rootQuat, localQ),
  };
}

/**
 * Classifies and resolves a target ref (see the forms documented at the top of this file)
 * into a plain spatial descriptor. When the relevant root transform is supplied, the result
 * is composed into world space (`space: 'world'`); otherwise the raw local value is returned
 * tagged with the space it's relative to, for the caller to compose itself later.
 *
 * @param {string|object} ref
 * @param {{ anchors?: object, bodyAnchors?: object, weaponRoot?: {position,quaternion}, bodyRoot?: {position,quaternion}, cameraRoot?: {position,quaternion} }} [ctx]
 * @returns {{ position:number[], quaternion:number[], space:string, anchorName?:string }}
 */
export function resolveTargetRef(ref, ctx = {}) {
  const { anchors, bodyAnchors, weaponRoot, bodyRoot, cameraRoot } = ctx;

  if (typeof ref === 'string') {
    const anchor = anchors && anchors[ref];
    if (anchor) {
      // Weapon-anchor string form.
      if (weaponRoot) {
        return { ...composeRoot(weaponRoot, anchor.p, anchor.q || IDENTITY_Q, weaponRoot.scale), space: 'world', anchorName: ref };
      }
      return { position: anchor.p.slice(), quaternion: (anchor.q || IDENTITY_Q).slice(), space: 'weapon', anchorName: ref };
    }
    // Body-anchor string form. Body-anchor local offsets (e.g. a belt mag pouch) are owned by
    // the procedural body track and passed in via `ctx.bodyAnchors`; if the name isn't found
    // there, fall back to the body-root origin so an unknown ref still resolves to *something*.
    const bodyAnchor = bodyAnchors && bodyAnchors[ref];
    const bodyLocalP = bodyAnchor ? bodyAnchor.p : [0, 0, 0];
    const bodyLocalQ = (bodyAnchor && bodyAnchor.q) || IDENTITY_Q;
    if (bodyRoot) {
      return { ...composeRoot(bodyRoot, bodyLocalP, bodyLocalQ), space: 'world', anchorName: ref };
    }
    return { position: bodyLocalP.slice(), quaternion: bodyLocalQ.slice(), space: 'body', anchorName: ref };
  }

  if (ref && typeof ref === 'object') {
    if ('weaponAnchor' in ref) {
      const anchor = anchors && anchors[ref.weaponAnchor];
      const basePos = (anchor && anchor.p) || [0, 0, 0];
      const baseQuat = (anchor && anchor.q) || IDENTITY_Q;
      const offset = ref.offset || [0, 0, 0];
      const localP = addVec(basePos, offset);
      if (weaponRoot) {
        return { ...composeRoot(weaponRoot, localP, baseQuat, weaponRoot.scale), space: 'world', anchorName: ref.weaponAnchor };
      }
      return { position: localP, quaternion: baseQuat.slice(), space: 'weapon', anchorName: ref.weaponAnchor };
    }
    if ('body' in ref) {
      if (bodyRoot) return { ...composeRoot(bodyRoot, ref.body, IDENTITY_Q), space: 'world' };
      return { position: ref.body.slice(), quaternion: IDENTITY_Q.slice(), space: 'body' };
    }
    if ('camera' in ref) {
      if (cameraRoot) return { ...composeRoot(cameraRoot, ref.camera, IDENTITY_Q), space: 'world' };
      return { position: ref.camera.slice(), quaternion: IDENTITY_Q.slice(), space: 'camera' };
    }
    if ('world' in ref) {
      return { position: ref.world.slice(), quaternion: IDENTITY_Q.slice(), space: 'world' };
    }
  }

  return { position: [0, 0, 0], quaternion: IDENTITY_Q.slice(), space: 'world' };
}
