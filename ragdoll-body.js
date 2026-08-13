// ragdoll-body.js — bridge between a live createProceduralPlayerBody rig and the pure ragdoll.js
// solver. One source of truth for the joint mapping + seeding, shared by ragdoll-viewer.html,
// bot-viewer.html, and (later) environment-viewer.html's death pose. THREE is injected, never imported.
import { createRagdoll, seedRagdollFromJoints, applyImpulse, applyImpulseAll } from './ragdoll.js';

// body.joints (visual names) → ragdoll.js's 16 particle names.
export const RAGDOLL_JOINT_MAP = {
  head: 'head', neck: 'neck', torso: 'chest', pelvis: 'pelvis',
  leftShoulder: 'shoulderL', rightShoulder: 'shoulderR',
  leftElbow: 'elbowL', rightElbow: 'elbowR', leftHand: 'handL', rightHand: 'handR',
  leftHip: 'hipL', rightHip: 'hipR', leftKnee: 'kneeL', rightKnee: 'kneeR',
  leftFoot: 'footL', rightFoot: 'footR',
};

/**
 * Seed a ragdoll from a body's live joint world positions (the moment of death, so the corpse
 * flops from where it died) and return a reusable pose map to feed body.setRagdollPose each frame.
 * @param {object} THREE  injected THREE (for a scratch Vector3 + world-matrix read)
 * @param {object} body   a createProceduralPlayerBody instance (must expose .group and .joints)
 * @param {object} [opts] forwarded to createRagdoll (origin, yaw, braceStiffness, jointLimits…),
 *                        plus opts.velocity passed to the seed (inherited motion).
 * @returns {{rd, pose}}  rd = the ragdoll; pose = { ragdollName: live particle pos } for setRagdollPose.
 */
export function ragdollFromBody(THREE, body, opts = {}) {
  const v = new THREE.Vector3();
  body.group.updateMatrixWorld(true);
  const J = {};
  for (const bn in RAGDOLL_JOINT_MAP) {
    const j = body.joints[bn];
    if (!j) continue;
    j.getWorldPosition(v);
    J[RAGDOLL_JOINT_MAP[bn]] = { x: v.x, y: v.y, z: v.z };
  }
  const rd = createRagdoll(opts);
  seedRagdollFromJoints(rd, J, { velocity: opts.velocity });
  const pose = {};
  for (const bn in RAGDOLL_JOINT_MAP) {
    const rn = RAGDOLL_JOINT_MAP[bn];
    pose[rn] = rd.particles[rd.index[rn]].pos;   // stable ref, mutated in place by stepRagdoll
  }
  return { rd, pose };
}

// Per-weapon knockback magnitude (m/s). Respects an explicit `weapon.knockback` if a def sets one,
// else derives from damage + mode so every (incl. future) weapon gets a sensible value.
export function weaponKnockback(weapon) {
  if (!weapon) return 6;
  if (typeof weapon.knockback === 'number') return weapon.knockback;
  const dmg = weapon.damage ?? 20;
  if (weapon.mode === 'melee') return 4;
  if (weapon.mode === 'projectile') return Math.min(18, Math.max(8, dmg / 7));  // explosions hit hardest
  return Math.min(12, Math.max(4, dmg / 5));                                    // hitscan: pistol→rifle→sniper
}

// Skeleton adjacency for spreading a localized hit to 1-hop neighbors.
const NEIGHBORS = {
  head: ['neck'], neck: ['head', 'chest'],
  chest: ['neck', 'pelvis', 'shoulderL', 'shoulderR'], pelvis: ['chest', 'hipL', 'hipR'],
  shoulderL: ['chest', 'elbowL'], elbowL: ['shoulderL', 'handL'], handL: ['elbowL'],
  shoulderR: ['chest', 'elbowR'], elbowR: ['shoulderR', 'handR'], handR: ['elbowR'],
  hipL: ['pelvis', 'kneeL'], kneeL: ['hipL', 'footL'], footL: ['kneeL'],
  hipR: ['pelvis', 'kneeR'], kneeR: ['hipR', 'footR'], footR: ['kneeR'],
};
const _UPPER = [['chest', 1], ['neck', 1], ['head', 0.8], ['shoulderL', 0.9], ['shoulderR', 0.9], ['pelvis', 0.5]];

function nearestJoint(rd, p) {
  let best = null, bestD = Infinity;
  for (const q of rd.particles) {
    const d = (q.pos.x - p.x) ** 2 + (q.pos.y - p.y) ** 2 + (q.pos.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = q.name; }
  }
  return best;
}

/**
 * Explosion knockback: launch the whole corpse radially away from a blast center, with a strong
 * upward pop + a little extra on the chest so it tumbles instead of sliding flat. `strength` is m/s
 * (per-weapon knockback × distance falloff × the panel multiplier). Reused by the game's blasts.
 */
export function applyBlastImpulse(rd, from, strength = 12) {
  const c = rd.particles[rd.index.pelvis].pos;
  let dx = c.x - from.x, dy = c.y - from.y, dz = c.z - from.z;
  const m = Math.hypot(dx, dy, dz) || 1; dx /= m; dy /= m; dz /= m;
  applyImpulseAll(rd, { x: dx * strength, y: (dy * 0.4 + 0.6) * strength, z: dz * strength });
  applyImpulse(rd, 'chest', { x: dx * strength * 0.3, y: strength * 0.3, z: dz * strength * 0.3 });
}

/**
 * Death knockback along the shot direction. A modest whole-body shove (corpse translates as a unit)
 * plus a concentrated reaction at the hit: with `hitPoint`, the impulse focuses on the nearest joint
 * (+1-hop falloff) so a headshot snaps the head, a leg hit kicks the leg, etc.; without it, it
 * spreads across the upper body. `strength` is m/s (per-weapon knockback × the panel multiplier).
 * @param {object} rd
 * @param {{dir, strength?, hitPoint?}} opts  dir = shot travel; hitPoint = world hit position or null
 */
export function applyDeathImpulse(rd, { dir, strength = 8, hitPoint = null }) {
  const m = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / m, dy = dir.y / m, dz = dir.z / m;
  const imp = (name, s) => applyImpulse(rd, name, { x: dx * s, y: (dy * 0.3 + 0.35) * s, z: dz * s });
  applyImpulseAll(rd, { x: dx * strength * 0.35, y: strength * 0.12, z: dz * strength * 0.35 });
  if (hitPoint) {
    const center = nearestJoint(rd, hitPoint);
    imp(center, strength);
    for (const nb of (NEIGHBORS[center] || [])) imp(nb, strength * 0.5);
  } else {
    for (const [name, w] of _UPPER) imp(name, strength * w);
  }
}
