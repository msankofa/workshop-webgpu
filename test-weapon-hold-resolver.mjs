// Node smoke tests for weapon-hold-resolver.js (stance x locomotion -> one third-person hold).
import assert from 'node:assert/strict';
import {
  LOCOMOTION_IDLE, LOCOMOTION_WALK, LOCOMOTION_RUN, LOCOMOTION_DASH, LOCOMOTION_AIM,
  CARRY_PRESETS, DEFAULT_HOLD, carryDeltaFor, hasCarryVocabulary, locomotionFor,
  isCarryLocomotion, isOneHanded, stepCarryBlend, snapCarryBlend, resolveWeaponHold,
} from './weapon-hold-resolver.js';
import { WEAPONS } from './weapons.js';
import { KNEEL_DEFAULTS, BODY_DESIGN_DEFAULTS, gaitForSpeed } from './player-procedural-body.js';

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const RIFLE = {
  carryClass: 'rifle',
  thirdPersonHold: { position: [0.3, 0.92, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 },
  crouchHold: { position: [0.3, -0.09, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 },
  proneHold: { position: [0.35, -0.43, -0.12], rotation: [-0.04, 0.08, -0.08], scale: 2 },
};

// --- carry delta selection ---
check(carryDeltaFor(RIFLE, LOCOMOTION_IDLE).position.every((v) => v === 0), 'idle carries no delta');
check(carryDeltaFor(RIFLE, LOCOMOTION_AIM).rotation.every((v) => v === 0), 'aim carries no delta -- it IS the stance hold');
check(carryDeltaFor(RIFLE, LOCOMOTION_WALK) === CARRY_PRESETS.rifle.walk, 'class preset resolves for walk');
check(carryDeltaFor(RIFLE, LOCOMOTION_DASH) === CARRY_PRESETS.rifle.dash, 'class preset resolves for dash');
check(carryDeltaFor(RIFLE, 'nonsense').position.every((v) => v === 0), 'an unknown locomotion reads as idle, not a crash');
check(carryDeltaFor({}, LOCOMOTION_WALK).position.every((v) => v === 0), 'no carryClass = no delta');
check(carryDeltaFor(null, LOCOMOTION_RUN).rotation.every((v) => v === 0), 'a null def is survivable');
{
  const own = { position: [9, 9, 9], rotation: [1, 1, 1] };
  check(carryDeltaFor({ carryClass: 'rifle', carryHolds: { walk: own } }, LOCOMOTION_WALK) === own,
    'a per-weapon carryHolds entry overrides its class preset');
  check(carryDeltaFor({ carryClass: 'rifle', carryHolds: { walk: own } }, LOCOMOTION_RUN) === CARRY_PRESETS.rifle.run,
    'overriding one entry leaves the others on the preset');
}

// --- stance-aware carry entries: a { stand, crouch, prone } map instead of one flat delta ---
{
  const STAND = { position: [1, 0, 0], rotation: [0.1, 0, 0] };
  const PRONE = { position: [-1, 0, 0], rotation: [-0.1, 0, 0] };
  const def = { carryClass: 'rifle', carryHolds: { walk: { stand: STAND, prone: PRONE } } };

  const standing = carryDeltaFor(def, LOCOMOTION_WALK, { crouch01: 0, prone01: 0 });
  check(near(standing.position[0], 1) && near(standing.rotation[0], 0.1), 'zero weights resolve the stand entry');

  const prone = carryDeltaFor(def, LOCOMOTION_WALK, { crouch01: 1, prone01: 1 });
  check(near(prone.position[0], -1) && near(prone.rotation[0], -0.1), 'prone dominates a simultaneous crouch, matching resolveWeaponHold');

  const crouched = carryDeltaFor(def, LOCOMOTION_WALK, { crouch01: 1, prone01: 0 });
  check(near(crouched.position[0], 1), 'a missing crouch entry falls back to stand, not zero');

  const half = carryDeltaFor(def, LOCOMOTION_WALK, { crouch01: 0, prone01: 0.5 });
  check(near(half.position[0], 0), 'prone weight blends linearly toward the prone entry');

  check(carryDeltaFor(def, LOCOMOTION_WALK).position.every(Number.isFinite), 'no weights argument is survivable (treated as all-zero)');

  const other = carryDeltaFor(def, LOCOMOTION_WALK, { crouch01: 0, prone01: 0 });
  check(other !== standing, 'a stance-aware entry resolves to a fresh object each call, unlike a flat entry');

  // Missing BOTH crouch and prone: the whole map collapses to the stand entry regardless of weights,
  // exactly like a flat delta would -- this is the common case (a class nobody has stance-tuned).
  const flatlike = { carryClass: 'rifle', carryHolds: { walk: { stand: STAND } } };
  check(near(carryDeltaFor(flatlike, LOCOMOTION_WALK, { crouch01: 1, prone01: 1 }).position[0], 1),
    'a stance map with only stand behaves like a flat delta at every weight');
}
{
  // Integration: the RPG's own carryHolds.walk (weapons.js) is the real-data motivation for the
  // stance-aware shape -- assert it round-trips through the resolver both standing and prone.
  const rpg = WEAPONS.rpg;
  check(!!rpg.carryHolds?.walk?.stand && !!rpg.carryHolds?.walk?.prone, 'the RPG declares a stand/prone walk carry');
  const standing = carryDeltaFor(rpg, LOCOMOTION_WALK, { crouch01: 0, prone01: 0 });
  const prone = carryDeltaFor(rpg, LOCOMOTION_WALK, { crouch01: 0, prone01: 1 });
  const matches = (a, b) => a.position.every((v, i) => near(v, b.position[i], 1e-9)) && a.rotation.every((v, i) => near(v, b.rotation[i], 1e-9));
  check(matches(standing, rpg.carryHolds.walk.stand), 'RPG standing walk resolves to the authored stand entry');
  check(matches(prone, rpg.carryHolds.walk.prone), 'RPG prone walk resolves to the authored prone entry');
  check(!matches(standing, prone), 'the RPG walk carry actually differs by stance -- the whole point of the override');
}
check(hasCarryVocabulary(RIFLE) && !hasCarryVocabulary({}), 'melee/thrown weapons declare no carry vocabulary');

// --- muzzle direction: the whole point of the walk/run poses ---
// +rotation[0] pitches the muzzle DOWN (weapon-pose-controller.js recoil raises it with `r[0] - kick`).
// ONLY the muzzle direction is contractual, and only on the pitch channel: a carry exists to get the
// weapon off-target, and which way is the whole point. Everything else -- how far, the cross-body
// yaw, the roll, the translation -- is per-class authoring done in weapon-animation-viewer.html.
// Two earlier revisions of this loop asserted a walk-vs-run pitch ordering and a positive cross-body
// yaw; both were rifle-shaped assumptions that broke the moment real poses were authored (a pistol
// low-ready hangs straight down at the thigh with no cant at all). Do not add them back.
for (const cls of ['rifle', 'pistol']) {
  check(CARRY_PRESETS[cls].walk.rotation[0] > 0, `${cls} walk carry points the muzzle down`);
  check(CARRY_PRESETS[cls].run.rotation[0] > 0, `${cls} run carry points the muzzle down`);
  check(CARRY_PRESETS[cls].dash.rotation[0] < 0, `${cls} dash carry points the muzzle up`);
  for (const kind of ['walk', 'run', 'dash']) {
    const d = CARRY_PRESETS[cls][kind];
    check(d.position.every(Number.isFinite) && d.rotation.every(Number.isFinite), `${cls} ${kind} is fully numeric`);
    check(d.rotation.every((v) => Math.abs(v) <= Math.PI), `${cls} ${kind} stays inside +/-PI per axis`);
  }
}

// --- locomotion mapping ---
check(locomotionFor({ stance: 'stand', moving: false }) === LOCOMOTION_IDLE, 'a standing still bot is idle');
check(locomotionFor({ stance: 'stand', moving: true }) === LOCOMOTION_WALK, 'a moving standing bot walks');
check(locomotionFor({ stance: 'crouch', moving: true }) === LOCOMOTION_WALK, 'a moving crouched bot uses the walk carry');
check(locomotionFor({ stance: 'run', moving: true }) === LOCOMOTION_RUN, 'the run stance selects the run carry');
check(locomotionFor({ stance: 'dash', moving: true }) === LOCOMOTION_DASH, 'the dash stance selects the dash carry');
check(locomotionFor({ stance: 'run', moving: true, aiming: true }) === LOCOMOTION_AIM, 'aiming outranks running');
check(locomotionFor({ stance: 'dash', aiming: true }) === LOCOMOTION_AIM, 'aiming outranks even a blast evade');
check(locomotionFor() === LOCOMOTION_IDLE, 'no context reads as idle');

check(isCarryLocomotion(LOCOMOTION_WALK) && isCarryLocomotion(LOCOMOTION_RUN) && isCarryLocomotion(LOCOMOTION_DASH),
  'walk/run/dash are off-target carries');
check(!isCarryLocomotion(LOCOMOTION_AIM) && !isCarryLocomotion(LOCOMOTION_IDLE), 'aim/idle are not carries -- they may barrel-solve');
check(isOneHanded(LOCOMOTION_DASH) && !isOneHanded(LOCOMOTION_RUN), 'only dash frees the support hand');

// --- blend easing ---
{
  // A synthetic target, NOT a live preset: the easing math must not be re-tested every time someone
  // re-authors a carry in the viewer, and an earlier version of this block silently encoded the sign
  // of whatever rifle.run happened to be that day.
  const TARGET = { position: [-1, 0.5, 0.25], rotation: [1, -0.5, 0.25] };
  const st = stepCarryBlend(null, TARGET, 0.016);
  check(st.position[0] < 0 && st.position[0] > TARGET.position[0], 'one 16 ms step moves toward the target without reaching it');
  check(st.position[1] > 0 && st.position[1] < TARGET.position[1], '...on every channel, in the target\'s own direction');
  let acc = { position: [0, 0, 0], rotation: [0, 0, 0] };
  for (let i = 0; i < 200; i++) acc = stepCarryBlend(acc, TARGET, 0.016);
  check(near(acc.rotation[0], TARGET.rotation[0], 1e-6) && near(acc.position[2], TARGET.position[2], 1e-6),
    'the blend converges on its target');
  const before = acc.position[0];
  stepCarryBlend(acc, TARGET, 0);
  check(acc.position[0] === before, 'a zero dt is a no-op, not a snap');
  stepCarryBlend(acc, null, 1e6);
  check(near(acc.position[0], 0) && near(acc.rotation[0], 0), 'a null target eases back to no delta');
}
{
  const st = snapCarryBlend(null, CARRY_PRESETS.pistol.dash);
  check(st.rotation[0] === CARRY_PRESETS.pistol.dash.rotation[0], 'snap lands exactly on the target');
  check(st.position !== CARRY_PRESETS.pistol.dash.position, 'snap copies rather than aliasing the frozen preset');
}
{
  // Regression: the presets are frozen, so a blend that wrote through would throw in strict mode.
  // Compared against a captured copy rather than a hardcoded sign, so re-authoring cannot weaken it.
  const before = JSON.stringify(CARRY_PRESETS.rifle);
  const st = snapCarryBlend(null, CARRY_PRESETS.rifle.walk);
  stepCarryBlend(st, CARRY_PRESETS.rifle.dash, 0.5);
  check(JSON.stringify(CARRY_PRESETS.rifle) === before, 'blending never mutates the shared preset');
}

// --- the resolve ---
{
  const zero = { crouch01: 0, prone01: 0 };
  const stand = resolveWeaponHold(RIFLE, zero, null);
  check(near(stand.position[1], 0.92) && near(stand.scale, 2), 'no weights, no carry = the authored stand hold');

  const crouched = resolveWeaponHold(RIFLE, { crouch01: 1, prone01: 0 }, null);
  check(near(crouched.position[1], -0.09), 'full crouch weight = the authored crouch hold');

  const prone = resolveWeaponHold(RIFLE, { crouch01: 1, prone01: 1 }, null);
  check(near(prone.position[1], -0.43), 'prone dominates a simultaneous crouch, matching the rig');

  const half = resolveWeaponHold(RIFLE, { crouch01: 0.5, prone01: 0 }, null);
  check(half.position[1] < 0.92 && half.position[1] > -0.09, 'a half crouch sits between the two holds');

  const walking = resolveWeaponHold(RIFLE, zero, CARRY_PRESETS.rifle.walk);
  check(near(walking.rotation[0], -0.1 + CARRY_PRESETS.rifle.walk.rotation[0]), 'the carry delta adds onto the stance rotation');
  check(walking.rotation[0] > stand.rotation[0], 'walking drops the muzzle relative to standing');
  check(near(walking.scale, 2), 'a carry delta never rescales the weapon');

  const crouchWalk = resolveWeaponHold(RIFLE, { crouch01: 1, prone01: 0 }, CARRY_PRESETS.rifle.walk);
  check(near(crouchWalk.position[1], -0.09 + CARRY_PRESETS.rifle.walk.position[1]),
    'crouch-walk composes both axes -- the case the 5x3 cross product existed to avoid');

  check(near(resolveWeaponHold(RIFLE, { crouch01: 9, prone01: -4 }, null).position[1], -0.09, 1e-12),
    'out-of-range weights clamp instead of extrapolating');
}
// --- kneel: its own authored slot, not a share of the crouch weight ---
{
  const KNEELER = { ...RIFLE, kneelHold: { position: [0.3, 0.404, -0.68], rotation: [-0.1, 0.08, -0.08], scale: 2 } };
  check(near(resolveWeaponHold(KNEELER, { crouch01: 0, kneel01: 1, prone01: 0 }, null).position[1], 0.404),
    'full kneel weight = the authored kneel hold');
  check(near(resolveWeaponHold(KNEELER, { crouch01: 1, kneel01: 1, prone01: 0 }, null).position[1], 0.404),
    'kneel dominates a simultaneous crouch, matching the rig precedence');
  check(near(resolveWeaponHold(KNEELER, { crouch01: 1, kneel01: 1, prone01: 1 }, null).position[1], -0.43),
    'prone still dominates kneel');
  const half = resolveWeaponHold(KNEELER, { crouch01: 0, kneel01: 0.5, prone01: 0 }, null).position[1];
  check(half > 0.404 && half < 0.92, 'a half kneel sits between the stand and kneel holds');
  check(near(resolveWeaponHold(RIFLE, { crouch01: 0, kneel01: 1, prone01: 0 }, null).position[1], -0.09),
    'a weapon with no kneel hold falls back to crouch, not to the mount origin');

  // Regression pin: kneel01 = 0 must reproduce the pre-kneel resolve exactly, since three viewers
  // still call this without ever setting the weight.
  for (const c of [0, 0.25, 0.5, 1]) for (const p of [0, 0.5, 1]) {
    const withKey = resolveWeaponHold(KNEELER, { crouch01: c, kneel01: 0, prone01: p }, null);
    const without = resolveWeaponHold(KNEELER, { crouch01: c, prone01: p }, null);
    check(withKey.position.every((v, i) => near(v, without.position[i], 1e-12)) && near(withKey.scale, without.scale),
      `kneel01=0 is identical to an absent kneel weight (crouch ${c}, prone ${p})`);
  }
}

// --- the holds actually track the rig: gun height relative to the SHOULDERS is stance-invariant ---
// This is what the authored numbers are for. The mount is pinned at feetY + 1.5 and never moves with
// stance (bot-viewer-v3.html:2416; applyStanceHeight only writes cap.end.y), so hold Y is the only
// thing that can express a stance's shoulder drop. Pinned against the rig's own geometry, so
// retuning crouchCfg/KNEEL_DEFAULTS fails here instead of silently desyncing the gun.
{
  const H = 1.8;
  const thighLen = 1.8 * BODY_DESIGN_DEFAULTS.legLenRatio * BODY_DESIGN_DEFAULTS.thighFrac;
  const hipRatio = gaitForSpeed(0).pelvisHeightRatio;   // adaptGaitToSpeed is on; author at rest
  const CROUCH_PELVIS_DROP = 0.62, CROUCH_SHOULDER_DROP = 0.19;   // crouchCfg, player-procedural-body.js:1211
  const shoulderStand = H * hipRatio + H * 0.34;
  const shoulderCrouch = H * hipRatio * (1 - CROUCH_PELVIS_DROP) + H * 0.34 * (1 - CROUCH_SHOULDER_DROP);
  const shoulderKneel = thighLen * KNEEL_DEFAULTS.hipHeight + H * 0.34 * (1 - KNEEL_DEFAULTS.shoulderDrop);

  check(shoulderKneel > shoulderCrouch,
    'a kneeling bot carries its shoulders HIGHER than a crouching one -- the whole reason kneel needs its own hold');

  for (const [id, def] of Object.entries(WEAPONS)) {
    if (!def.thirdPersonHold || !def.crouchHold) continue;
    check(def.kneelHold, `${id} authors a kneel hold`);
    const zero = { crouch01: 0, kneel01: 0, prone01: 0 };
    const gunStand = resolveWeaponHold(def, zero, null).position[1];
    const gunCrouch = resolveWeaponHold(def, { ...zero, crouch01: 1 }, null).position[1];
    const gunKneel = resolveWeaponHold(def, { ...zero, kneel01: 1 }, null).position[1];
    // 1 cm: the authored values are rounded to 3dp and the hip ratio drifts ~3 cm with speed.
    check(near(gunCrouch - shoulderCrouch, gunStand - shoulderStand, 0.01),
      `${id} holds the gun at its standing shoulder height when crouched`);
    check(near(gunKneel - shoulderKneel, gunStand - shoulderStand, 0.01),
      `${id} holds the gun at its standing shoulder height when kneeling`);
    check(gunKneel > gunCrouch, `${id} rides higher kneeling than crouching`);
  }
}
{
  // Missing holds must fall back along the authored chain, never collapse to the mount origin.
  const standOnly = { thirdPersonHold: RIFLE.thirdPersonHold };
  check(near(resolveWeaponHold(standOnly, { crouch01: 1, prone01: 1 }, null).position[1], 0.92),
    'a weapon with only a stand hold keeps it in every stance');
  const empty = resolveWeaponHold({}, { crouch01: 0, prone01: 0 }, null);
  check(empty.position.every((v) => v === 0) && empty.scale === DEFAULT_HOLD.scale, 'a def with no holds resolves to identity, not NaN');
  check(resolveWeaponHold(null, null, null).scale === 1, 'null everything is survivable');
}
{
  const out = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const same = resolveWeaponHold(RIFLE, { crouch01: 0, prone01: 0 }, null, out);
  check(same === out, 'the out-param is written in place so the per-frame path allocates nothing');
}

// --- real weapon data ---
for (const [id, def] of Object.entries(WEAPONS)) {
  if (!def.thirdPersonHold) continue;
  const held = resolveWeaponHold(def, { crouch01: 0, prone01: 0 }, carryDeltaFor(def, LOCOMOTION_RUN));
  check(held.position.every(Number.isFinite) && held.rotation.every(Number.isFinite) && held.scale > 0,
    `${id} resolves a finite run hold`);
}
check(WEAPONS.m1911.carryClass === 'pistol' && WEAPONS.cz_805_bren.carryClass === 'rifle', 'weapons.js declares carry classes');
check(!hasCarryVocabulary(WEAPONS.knife), 'the knife has no carry vocabulary -- it keeps its authored hold');

console.log(`weapon-hold-resolver: ${checks} checks passed`);
