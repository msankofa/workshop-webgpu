// Sparse, serialisable settings for the Pokemon Stadium walker. Pure: no THREE and no DOM.

export const DEFAULT_WALKER_GAIT = 'walk';
export const WALKER_GAITS = Object.freeze(['walk', 'gallop']);

export const WALKER_TUNING_FIELDS = Object.freeze({
  speedScale: { label: 'Speed scale', group: 'Movement character', min: 0.25, max: 2, step: 0.05, default: 1 },
  strideScale: { label: 'Stride length', group: 'Movement character', min: 0.25, max: 1.5, step: 0.05, default: 1 },
  stepDurationScale: { label: 'Step duration', group: 'Movement character', min: 0.5, max: 2, step: 0.05, default: 1 },
  stepLiftScale: { label: 'Step lift', group: 'Movement character', min: 0, max: 2, step: 0.05, default: 1 },

  standExtension: { label: 'Standing extension', group: 'Stance and reach', min: 0.5, max: 0.98, step: 0.01, default: 0.9 },
  maxExtension: { label: 'Maximum extension', group: 'Stance and reach', min: 0.6, max: 0.999, step: 0.001, default: 0.99 },
  swingLimit: { label: 'Knee swing limit', group: 'Stance and reach', min: 0.1, max: 1.5, step: 0.02, default: Math.PI / 5, unit: 'rad' },
  uprightSupport: { label: 'Upright support', group: 'Stance and reach', min: 0, max: 1, step: 0.05, default: null },

  concurrentScale: { label: 'Concurrent-step scale', group: 'Cadence', min: 0.25, max: 2, step: 0.05, default: 1 },
  cooldownScale: { label: 'Step cooldown', group: 'Cadence', min: 0, max: 2, step: 0.05, default: 1 },
  restepFraction: { label: 'Re-step threshold', group: 'Cadence', min: 0.1, max: 3, step: 0.05, default: 1.2 },
  minStepSeconds: { label: 'Minimum step time', group: 'Cadence', min: 0.05, max: 0.5, step: 0.01, default: 0.1, unit: 's' },

  placeMargin: { label: 'Placement margin', group: 'Foot safety', min: 0.2, max: 0.95, step: 0.01, default: 0.7 },
  reachMargin: { label: 'Reach margin', group: 'Foot safety', min: 0.2, max: 0.95, step: 0.01, default: 0.7 },
  reachStress: { label: 'Reach-stress threshold', group: 'Foot safety', min: 0.3, max: 0.999, step: 0.001, default: 0.9 },
  footContact: { label: 'Foot contact', group: 'Foot safety', values: ['point', 'patch'], default: 'point' },
  footPatchScale: { label: 'Contact-patch scale', group: 'Foot safety', min: 0.1, max: 2, step: 0.05, default: 1 },
  strayLimit: { label: 'Stray-foot limit', group: 'Foot safety', min: 0.005, max: 0.25, step: 0.005, default: 0.05 },
  strayMode: { label: 'Stray-foot behavior', group: 'Foot safety', values: ['off', 'slow', 'restep', 'accept'], default: 'off' },
  strayRetries: { label: 'Stray-foot retries', group: 'Foot safety', min: 0, max: 8, step: 1, default: 2, integer: true },
});

const nearlyEqual = (a, b) => typeof a === 'number' && typeof b === 'number'
  && Math.abs(a - b) <= 1e-9;

function boundedNumber(value, spec) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const bounded = Math.min(spec.max, Math.max(spec.min, number));
  return spec.integer ? Math.round(bounded) : bounded;
}

/**
 * Keep only known, finite overrides. Static defaults disappear so a saved species continues to benefit
 * from later changes to the geometry-derived walker.
 */
export function normaliseWalkerTuning(raw, { legCount = null } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, spec] of Object.entries(WALKER_TUNING_FIELDS)) {
    if (!Object.hasOwn(source, key)) continue;
    if (spec.values) {
      if (spec.values.includes(source[key])) out[key] = source[key];
      continue;
    }
    const value = boundedNumber(source[key], spec);
    if (value !== null) out[key] = value;
  }

  const stand = out.standExtension ?? WALKER_TUNING_FIELDS.standExtension.default;
  const maximum = out.maxExtension ?? WALKER_TUNING_FIELDS.maxExtension.default;
  if (stand >= maximum) {
    if (Object.hasOwn(out, 'standExtension')) {
      out.standExtension = Math.max(WALKER_TUNING_FIELDS.standExtension.min, maximum - 0.01);
    } else {
      out.maxExtension = Math.min(WALKER_TUNING_FIELDS.maxExtension.max, stand + 0.01);
    }
  }

  const margin = out.reachMargin ?? WALKER_TUNING_FIELDS.reachMargin.default;
  const stress = out.reachStress ?? WALKER_TUNING_FIELDS.reachStress.default;
  if (margin >= stress) {
    if (Object.hasOwn(out, 'reachMargin')) {
      out.reachMargin = Math.max(WALKER_TUNING_FIELDS.reachMargin.min, stress - 0.01);
    } else {
      out.reachStress = Math.min(WALKER_TUNING_FIELDS.reachStress.max, margin + 0.01);
    }
  }

  for (const [key, value] of Object.entries(out)) {
    const fallback = WALKER_TUNING_FIELDS[key]?.default;
    if (fallback !== null && (value === fallback || nearlyEqual(value, fallback))) delete out[key];
  }
  return out;
}

export function normaliseWalkerMovement(raw, options = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const gait = WALKER_GAITS.includes(source.gait) && source.gait !== DEFAULT_WALKER_GAIT
    ? source.gait
    : null;
  return { gait, tuning: normaliseWalkerTuning(source.tuning, options) };
}

export function walkerMovementIsBlank(raw) {
  const movement = normaliseWalkerMovement(raw);
  return !movement.gait && !Object.keys(movement.tuning).length;
}

export function effectiveWalkerTuning(overrides, derived = {}, options = {}) {
  const sparse = normaliseWalkerTuning(overrides, options);
  const out = {};
  for (const [key, spec] of Object.entries(WALKER_TUNING_FIELDS)) {
    const baseline = derived[key] ?? spec.default;
    if (baseline !== null) out[key] = sparse[key] ?? baseline;
  }
  return out;
}

export function walkerTuningLabel(value, spec) {
  if (value == null) return 'derived';
  if (typeof value === 'string') return value;
  if (spec?.unit === 's') return value.toFixed(2) + ' s';
  if (spec?.unit === 'rad') return Math.round(value * 180 / Math.PI) + ' deg';
  return value.toFixed(spec?.step < 0.01 ? 3 : 2);
}
