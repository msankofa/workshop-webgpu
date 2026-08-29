// What moves each bone.
//
// A clip asserts a local transform for every bone it has a track for, every frame. That is fine until you
// want a creature to be doing two things at once -- walking while one arm hangs dead, or holding a posed
// head through an animation -- at which point the clip has to be told to leave some bones alone.
//
// Three answers per bone, and the difference between the last two is the one worth being clear about:
//
//   clip    the animation drives it. The default, and what every bone does today.
//   posed   nothing drives it. It keeps the local transform it was given and rides its parent.
//   limp    the ragdoll drives it. Gravity and whatever the parent transmits, nothing else.
//
// `posed` is NOT the same as "no driving force". A bone with no driver is not floppy, it is WELDED: it keeps
// its last local transform and swings around rigidly with its parent. To hang and lag and settle, a bone
// needs a solver -- the force just comes from gravity and the parent's motion rather than from a keyframe.
// That is `limp`, and it is why the two are separate modes instead of one.
//
// Pure and THREE-free. The page decides what to do with these sets; this only says which bone is in which.

export const CLIP = 'clip';
export const POSED = 'posed';
export const LIMP = 'limp';
export const DRIVES = [CLIP, POSED, LIMP];

/** What drives a bone. Unlisted means the clip, so an empty mask is the ordinary animated body. */
export function driveOf(drive, key) {
  const mode = drive?.[key];
  return DRIVES.includes(mode) ? mode : CLIP;
}

/**
 * A copy of the mask with `keys` set to `mode`.
 *
 * The default is stored by ABSENCE rather than by the string 'clip', so a mask with nothing unusual in it
 * is an empty object. That keeps "is anything masked at all" a length check, and it means a mask carries no
 * entries for bones a species does not have.
 */
export function setDrive(drive, keys, mode) {
  const next = { ...(drive || {}) };
  for (const key of typeof keys === 'string' ? [keys] : keys) {
    if (mode === CLIP || !DRIVES.includes(mode)) delete next[key];
    else next[key] = mode;
  }
  return next;
}

/** Every bone under this mode, in rig order. */
export function keysWith(rig, drive, mode) {
  return rig.bones.filter(b => driveOf(drive, b.key) === mode).map(b => b.key);
}

/** How many bones are under each mode. A readout, and what tells you a mask is doing nothing. */
export function driveCounts(rig, drive) {
  const out = { clip: 0, posed: 0, limp: 0 };
  for (const b of rig.bones) out[driveOf(drive, b.key)]++;
  return out;
}

/** Bone indices under a mode, which is what the simulation and the apply loops actually want. */
export function indicesWith(rig, drive, mode) {
  const out = [];
  rig.bones.forEach((b, i) => { if (driveOf(drive, b.key) === mode) out.push(i); });
  return out;
}

/**
 * Which particles the ragdoll must hold still: every bone the ragdoll does NOT drive.
 *
 * A partial ragdoll is the ordinary one with the pinning inverted. Hanging pins the bone you grabbed and
 * lets the body fall off it; this pins everything the animation is still driving and lets the limp bones
 * fall off that. Same solver, same constraints, different set held fixed.
 */
export function anchorIndices(rig, drive) {
  const out = [];
  rig.bones.forEach((b, i) => { if (driveOf(drive, b.key) !== LIMP) out.push(i); });
  return out;
}

/** True when the mask says nothing, so every caller can skip its work entirely. */
export function isPlain(drive) {
  return !drive || Object.keys(drive).length === 0;
}

/** A mask with only the bones this rig has, for when one is carried across species. */
export function forRig(rig, drive) {
  const out = {};
  for (const b of rig.bones) {
    const mode = driveOf(drive, b.key);
    if (mode !== CLIP) out[b.key] = mode;
  }
  return out;
}

/**
 * The bone a THREE animation track drives, or null if the name is not one.
 *
 * A track is named "<node name>.<property>", and the property never contains a dot while a node name may,
 * so the split is on the LAST one. Measured across the dex: every one of 54,503 tracks names a bone the rig
 * knows, no two bones share a name, and no bone name is one THREE would rewrite on import -- so a bone key
 * and a track's target are the same string, and no separate lookup is needed.
 */
export function trackBone(name) {
  const i = String(name ?? '').lastIndexOf('.');
  return i <= 0 ? null : String(name).slice(0, i);
}

/**
 * The tracks a mask stops the clip writing.
 *
 * Returned for the callers that want to build a filtered clip. The page does not: it lets the mixer write
 * everything and puts the masked bones back afterwards, which costs one pass over a handful of bones and
 * makes the mask live, where a filtered clip has to be rebuilt and re-timed on every change.
 */
export function suppressedTracks(trackNames, drive) {
  return (trackNames || []).filter((n) => {
    const bone = trackBone(n);
    return bone !== null && driveOf(drive, bone) !== CLIP;
  });
}
