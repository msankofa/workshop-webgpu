// Limb damage and severing. Pure data and arithmetic, no THREE, no DOM, Node-testable.
// Damage accumulates per limb; the head kills on contact; a fatal hit takes the limb it landed on.
// DEFAULTS merged into per-class rows, like bot-roles.js. See docs/subsystems/bots.md.

import { SEVERABLE_LIMBS } from './bot-limb-map.js';

// Limbs that kill on contact instead of accumulating.
export const LETHAL_LIMBS = new Set(['head']);

// The gun hand is the visual right; setArmTarget('left') is the support hand.
export const TRIGGER_ARM = 'rightArm';
export const SUPPORT_ARM = 'leftArm';

export const WOUND_DEFAULTS = {
  armThreshold: 60,      // damage one arm absorbs before it comes off
  legThreshold: 75,      // legs are thicker; also a lost leg is far more disruptive than a lost arm
  limbDamageScale: 1,    // future seam: <1 makes a limb hit cost the BODY less than it costs the limb
  severOnKillingBlow: true, // a fatal hit takes the limb it landed on -- see killingBlowSever
  headLethal: true,      // a hit that resolves to the head kills outright, whatever health remains
  // Consequences. Each is multiplicative PER missing limb and composes with the stance multipliers
  // rather than replacing them, the same way bot-stance.js's factors compose with everything else.
  legSpeedFactor: 0.5,   // per missing leg: a limp
  legTurnScale: 0.65,    // per missing leg: pivoting on one leg is slow
  armSpreadScale: 2.2,   // per missing arm: one-handed aim is far worse
  bothLegsSpeedFactor: 0.18, // both gone: a crawl, not 0.5 x 0.5
};

// Only fields that differ are written, so a new default reaches every row.
export const WOUND_CLASSES = {
  human: {},
  // Plate spreads the load: armour has to be chewed through before the limb underneath gives.
  armouredHuman: { armThreshold: 85, legThreshold: 105 },
  // Servos and linkages shear rather than tear — a robot sheds limbs more readily than a person.
  robot: { armThreshold: 45, legThreshold: 55 },
};

const _merged = new Map();
for (const [id, row] of Object.entries(WOUND_CLASSES)) {
  _merged.set(id, Object.freeze({ id, ...WOUND_DEFAULTS, ...row }));
}

/** The wound row for a damage-class id. An unknown id falls back rather than throwing. */
export function getWoundConfig(id) {
  return _merged.get(id) || _merged.get('human');
}

/** Threshold for one limb under one config. Arms and legs differ; anything else is unbreakable. */
export function limbThreshold(limb, cfg = WOUND_DEFAULTS) {
  if (limb === 'leftArm' || limb === 'rightArm') return cfg.armThreshold;
  if (limb === 'leftLeg' || limb === 'rightLeg') return cfg.legThreshold;
  if (isLethalHit(limb, cfg)) return 0;   // no damage to accumulate: the first hit is the last one
  return Infinity;
}

/** Does a hit to this limb kill outright? */
export function isLethalHit(limb, cfg = WOUND_DEFAULTS) {
  return LETHAL_LIMBS.has(limb) && cfg.headLethal !== false;
}

/** Fresh per-bot wound state. Cheap enough to build at spawn for every bot. */
export function createWoundState() {
  return { damage: Object.create(null), severed: Object.create(null), severedCount: 0 };
}

// Record damage against one limb. `severed` is non-null exactly once, so callers need no guard.
// No decay and no healing, like armour breach.
export function applyLimbDamage(state, limb, amount, cfg = WOUND_DEFAULTS) {
  const out = { severed: null, lethal: false, total: 0, threshold: Infinity };
  if (!state) return out;
  const dmg = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  // The head is recorded even when it is not lethal, so a readout can still show it was struck.
  if (LETHAL_LIMBS.has(limb)) {
    out.total = state.damage[limb] = (state.damage[limb] || 0) + dmg;
    out.threshold = limbThreshold(limb, cfg);
    if (!isLethalHit(limb, cfg) || state.severed[limb]) return out;
    out.lethal = true;
    state.severed[limb] = true;
    state.severedCount++;
    out.severed = limb;
    return out;
  }
  if (!SEVERABLE_LIMBS.has(limb)) return out;
  out.threshold = limbThreshold(limb, cfg);
  if (state.severed[limb]) { out.total = state.damage[limb] || 0; return out; }
  const total = (state.damage[limb] || 0) + dmg;
  state.damage[limb] = total;
  out.total = total;
  if (total >= out.threshold) {
    state.severed[limb] = true;
    state.severedCount++;
    out.severed = limb;
  }
  return out;
}

// Take the limb a fatal hit landed on. Arms catch 0.3% of hits, so the accumulator alone never fires.
export function killingBlowSever(state, limb, cfg = WOUND_DEFAULTS) {
  if (!state || !cfg.severOnKillingBlow) return null;
  if (!SEVERABLE_LIMBS.has(limb) || state.severed[limb]) return null;
  state.severed[limb] = true;
  state.severedCount++;
  return limb;
}

/** Is this limb gone? */
export function isSevered(state, limb) {
  return !!state?.severed?.[limb];
}

/** Every missing limb, for a wire payload or a debug readout. */
export function severedLimbs(state) {
  return state ? Object.keys(state.severed).filter((k) => state.severed[k]) : [];
}

/** Has the head been taken off? Only ever true after a lethal head hit, so this implies death. */
export function isDecapitated(state) {
  return isSevered(state, 'head');
}

/** Can this bot still work a gun? False once the trigger arm is gone. */
export function canHoldWeapon(state) {
  return !isSevered(state, TRIGGER_ARM);
}

/** Can it still hold a two-handed weapon properly? False once EITHER arm is gone. */
export function canHoldTwoHanded(state) {
  return !isSevered(state, TRIGGER_ARM) && !isSevered(state, SUPPORT_ARM);
}

// ---- consequences ----
// Multiplied in at the point of use, like bot-stance.js's factors. Not an FSM axis.

const legCount = (state) =>
  (isSevered(state, 'leftLeg') ? 1 : 0) + (isSevered(state, 'rightLeg') ? 1 : 0);
const armCount = (state) =>
  (isSevered(state, TRIGGER_ARM) ? 1 : 0) + (isSevered(state, SUPPORT_ARM) ? 1 : 0);

/** Movement speed multiplier. Both legs is its own number, not the square of one leg. */
export function woundSpeedFactor(state, cfg = WOUND_DEFAULTS) {
  const n = legCount(state);
  if (n === 0) return 1;
  return n >= 2 ? cfg.bothLegsSpeedFactor : cfg.legSpeedFactor;
}

/** Turn-rate multiplier, per missing leg. */
export function woundTurnRateScale(state, cfg = WOUND_DEFAULTS) {
  const n = legCount(state);
  return n === 0 ? 1 : Math.pow(cfg.legTurnScale, n);
}

/** Weapon-spread multiplier, per missing arm. Bigger is worse — it matches stanceSpreadScale. */
export function woundSpreadScale(state, cfg = WOUND_DEFAULTS) {
  const n = armCount(state);
  return n === 0 ? 1 : Math.pow(cfg.armSpreadScale, n);
}

// Can it still work on a casualty? The heal pose is two-handed, so either arm ends a medic.
export function canHeal(state) {
  return armCount(state) === 0;
}

/** Can it still fight at all? With both arms gone there is nothing left to do but run. */
export function canFight(state) {
  return armCount(state) < 2;
}

// What the loadout must do: 'sidearm' (trigger arm gone), 'oneHanded' (support gone), 'disarm', null.
export function weaponResponseFor(state) {
  const trigger = isSevered(state, TRIGGER_ARM);
  const support = isSevered(state, SUPPORT_ARM);
  if (trigger && support) return 'disarm';
  if (trigger) return 'sidearm';
  if (support) return 'oneHanded';
  return null;
}
