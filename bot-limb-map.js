// Which limb a hit part belongs to. Pure lookup, no THREE, no DOM, Node-testable.
//
// bot-body-hit.js answers "which part did the shot hit" and returns the part object plus its `_role`.
// That role is a MATERIAL role (shell/plate/trim/…) shared by parts all over the body, so it cannot
// say "left forearm". Anatomical identity has to come from WHICH NAMED SLOT the part occupies, which
// only player-procedural-body.js's `parts` tree knows. This builds that lookup once per body.
//
// Two traps this exists to absorb:
//
// 1. `parts.arms.left` is the VISUAL left arm and is wired to the INTERNAL `arms.right` (the rig
//    mirrors, and setArmTarget swaps for the same reason). Anything that reads the internal rig
//    directly gets the sides backwards. This module only ever reads `body.parts`, which is already
//    visual-side, so the mirror is handled once here instead of at every call site.
//
// 2. Gear is a hit target. A helmet, pauldron or boot is its own part in `parts.all` and sits OUTSIDE
//    the limb it covers, so a shot at a bot's head usually strikes the helmet, not the head. Gear is
//    resolved by walking parent links rather than by parsing anchor names — `gearHosts` uses INTERNAL
//    side naming (`handL` is the internal right hand), so name-parsing would reintroduce trap 1.

/** Limb ids. `core` is the trunk; it is identity, not a severable limb. */
export const LIMBS = ['head', 'core', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

/** Limbs a body can lose. The trunk and the head are handled by their own rules, not by this set. */
export const SEVERABLE_LIMBS = new Set(['leftArm', 'rightArm', 'leftLeg', 'rightLeg']);

const ARM_SEGMENTS = ['shoulder', 'upper', 'elbow', 'lower', 'wrist', 'hand'];
const LEG_SEGMENTS = ['hip', 'upper', 'knee', 'lower', 'ankle', 'foot'];
const CORE_SEGMENTS = ['pelvis', 'waist', 'torso', 'neck'];
const HEAD_SEGMENTS = ['head', 'eyes'];

// A part is a transform-only Object3D in instanced mode; `chain` (a solver) and `target` (a vector)
// share the same slot objects and must not be mapped.
const isPart = (v) => !!v && v.isObject3D === true;

function seed(map, limb, source, names) {
  if (!source) return;
  for (const segment of names) {
    const v = source[segment];
    if (isPart(v)) map.set(v, { limb, segment });
    else if (Array.isArray(v)) for (const item of v) if (isPart(item)) map.set(item, { limb, segment });
  }
}

/**
 * Build the part -> {limb, segment} lookup for one body. Keyed by object reference, so it is O(1) per
 * hit and immune to a part being renamed, re-indexed or hidden.
 *
 * Cache it on the body: part identity never changes for the life of a rig. `setGearLod` swaps
 * geometry without touching identity, and severing only flips `.visible`, so neither invalidates it.
 * A rebuild (revive, body-kind change) makes new parts and needs a new map.
 */
export function buildLimbMap(body) {
  const map = new Map();
  const parts = body?.parts;
  if (!parts) return map;
  seed(map, 'core', parts.core, CORE_SEGMENTS);
  seed(map, 'head', parts.core, HEAD_SEGMENTS);
  seed(map, 'leftArm', parts.arms?.left, ARM_SEGMENTS);
  seed(map, 'rightArm', parts.arms?.right, ARM_SEGMENTS);
  seed(map, 'leftLeg', parts.legs?.left, LEG_SEGMENTS);
  seed(map, 'rightLeg', parts.legs?.right, LEG_SEGMENTS);
  // Gear inherits from whatever it hangs off. Walk up rather than name-match: a piece sits under an
  // anchor under its host, and `faceBody` adds a second anchor, so the depth is not fixed.
  const all = Array.isArray(parts.all) ? parts.all : [];
  for (const part of all) {
    if (!isPart(part) || map.has(part)) continue;
    const host = hostEntry(map, part);
    if (host) map.set(part, { limb: host.limb, segment: 'gear' });
  }
  return map;
}

// Nearest mapped ancestor, bounded so a malformed parent cycle cannot hang the build.
function hostEntry(map, part) {
  let node = part.parent;
  for (let i = 0; i < 16 && node; i++) {
    const entry = map.get(node);
    if (entry) return entry;
    node = node.parent;
  }
  return null;
}

/** The limb entry for a part, or null when the part is unmapped (a foreign or detached object). */
export function limbForPart(map, part) {
  if (!map || !part) return null;
  return map.get(part) || null;
}

/** Just the limb id, for call sites that do not care which segment was struck. */
export function limbIdForPart(map, part) {
  return limbForPart(map, part)?.limb ?? null;
}

/** Can this limb be severed? The head and the trunk are governed by lethality rules instead. */
export function isSeverable(limb) {
  return SEVERABLE_LIMBS.has(limb);
}

/**
 * Every part belonging to a limb, for the `.visible = false` sweep a sever performs. Includes that
 * limb's gear, so a severed arm takes its pauldron with it.
 *
 * `keepProximal` leaves the joint the limb hangs from — the shoulder or hip — so the stump has a cap
 * instead of a hole. Its gear goes with it, since a pauldron on a missing arm reads worse than a bare
 * shoulder.
 */
export function partsOfLimb(map, limb, { keepProximal = true } = {}) {
  const out = [];
  if (!map) return out;
  const proximal = limb === 'leftArm' || limb === 'rightArm' ? 'shoulder'
    : limb === 'leftLeg' || limb === 'rightLeg' ? 'hip' : null;
  for (const [part, entry] of map) {
    if (entry.limb !== limb) continue;
    if (keepProximal && proximal && entry.segment === proximal) continue;
    if (keepProximal && proximal && entry.segment === 'gear' && isChildOfSegment(map, part, proximal)) continue;
    out.push(part);
  }
  return out;
}

// Gear carries segment 'gear', so the proximal test has to look at what it actually hangs off.
function isChildOfSegment(map, part, segment) {
  let node = part.parent;
  for (let i = 0; i < 16 && node; i++) {
    const entry = map.get(node);
    if (entry) return entry.segment === segment;
    node = node.parent;
  }
  return false;
}
