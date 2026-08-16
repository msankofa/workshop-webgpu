// Searching the tuning space by trial: propose settings, score them, and remember what happened.
//
// WHY A SEARCH AT ALL. The walker has about twenty knobs and they interact — `standExtension` shrinks the
// stride envelope, which lowers the top speed, which changes how far a planted foot drifts before its leg
// is rescued. That chain is not readable from the source and it is barely readable from the sliders, so
// the practical way to find good settings is to try some. What this module does is make the trying cheap
// and the results comparable.
//
// THE ONE FACT THE WHOLE DESIGN RESTS ON: `gaitHeadroom` scores a candidate from arithmetic on the tuning
// alone, with no simulation and no waiting. That is what turns "tune" from a lookup table into an actual
// optimisation — hundreds of candidates can be evaluated in the time it takes to render one frame. The
// measured detectors still have the last word, but they cost seconds each and cannot be put in a loop.
//
// Pure: no THREE, no DOM, no walker. `evaluate` is injected, so the search can be tested in Node against
// a made-up scoring function whose optimum is known in advance.

/**
 * How each knob is perturbed, and whether it means the same thing on another species.
 *
 * KIND decides what a percentage means. Adding a percentage of the slider's range is right for a
 * quantity with a natural zero, and wrong for a multiplier: 30% of the 0.2-to-3 range is 0.84, which
 * doubles a knob sitting at 1 and obliterates one sitting at 0.3. Multipliers move in log space instead,
 * so a 30% nudge feels the same wherever it starts.
 *
 * TRANSFER decides what may be copied to another species. Most of these are already fractions of
 * something the creature owns — a stride envelope, a leg span, its own top speed — and that normalisation
 * is the entire point of the walker deriving its gait from the rest pose, so they carry over by
 * construction. The exceptions are the ones authored in metres, and `supportPolygonFloor`, which is a
 * count of feet and means something different on two legs than on six.
 *
 * `minStepSeconds` looks like it belongs with the absolute ones and does not: it is deliberately
 * un-scaled, because it is a floor on what the eye can follow and the eye does not care how big the
 * animal is. It transfers.
 */
export const KNOBS = {
  speedScale:          { kind: 'ratio',   transfer: true },
  stepDurationScale:   { kind: 'ratio',   transfer: true },
  stepLiftScale:       { kind: 'ratio',   transfer: true },
  strideScale:         { kind: 'ratio',   transfer: true },
  supportPushLimit:    { kind: 'ratio',   transfer: true },
  concurrentScale:     { kind: 'ratio',   transfer: true },
  cooldownScale:       { kind: 'ratio',   transfer: true },
  minStepSeconds:      { kind: 'linear',  transfer: true },
  strideNumberMax:     { kind: 'linear',  transfer: true },
  restepFraction:      { kind: 'linear',  transfer: true },
  standExtension:      { kind: 'linear',  transfer: true },
  maxExtension:        { kind: 'linear',  transfer: true },
  placeMargin:         { kind: 'linear',  transfer: true },
  reachMargin:         { kind: 'linear',  transfer: true },
  reachStress:         { kind: 'linear',  transfer: true },
  uprightSupport:      { kind: 'linear',  transfer: true },
  swingLimit:          { kind: 'angle',   transfer: true },
  supportPolygonFloor: { kind: 'integer', transfer: false, why: 'a count of feet, and two legs cannot keep three down' },
  footGround:          { kind: 'linear',  transfer: false, why: 'authored in millimetres, and these models differ fourfold in size' },
  roamRadius:          { kind: 'linear',  transfer: false, why: 'metres of scenery, not a property of the creature' },
  worldHeight:         { kind: 'linear',  transfer: false, why: 'the absolute size being tuned for' },
};

/** Anything not in the table is treated as linear and non-transferable, which is the safe pair. */
export function knobInfo(key) {
  return KNOBS[key] || { kind: 'linear', transfer: false, why: 'not described in KNOBS' };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Snap to the slider's own granularity, so a proposal is a value the panel can actually display. */
function snap(v, spec) {
  const step = spec.step || 0.01;
  const q = Math.round((v - spec.min) / step) * step + spec.min;
  // Floating-point step arithmetic leaves values like 0.7000000000000001, which then render as garbage.
  return Number(clamp(q, spec.min, spec.max).toFixed(6));
}

/**
 * One random neighbour of `base`.
 *
 * `specs` is `{key: {min, max, step, value}}` — the sliders' own bounds, so a proposal can never be
 * something the panel could not show. `pct` is 0..1. `keys` limits which knobs move, which matters more
 * than it sounds: varying all twenty at once makes a verdict impossible to attribute to anything.
 */
export function perturb(base, specs, pct, rng = Math.random, keys = null) {
  const out = { ...base };
  const list = keys || Object.keys(specs);
  for (const key of list) {
    const spec = specs[key];
    if (!spec) continue;
    const kind = knobInfo(key).kind;
    const v = base[key] ?? spec.value;
    const r = rng() * 2 - 1;
    let next;
    if (kind === 'ratio' && v > 0) {
      // Log space: a 30% nudge is the same size of change at 0.3 as at 3.
      next = v * Math.exp(r * pct);
    } else {
      next = v + r * pct * (spec.max - spec.min);
    }
    if (kind === 'integer') next = Math.round(next);
    out[key] = snap(next, spec);
  }
  return out;
}

/**
 * How bad a candidate is. Lower is better.
 *
 * TWO TERMS, and the second one is not optional. Predicted risk alone has a trivial minimum: crawl. Set
 * the speed low and the guards wide and nothing ever drags, because nothing much happens. So risk is
 * weighted heavily and then ties are broken by how fast the legs could actually carry the body — the
 * stride budget `gaitHeadroom` already computes, in leg spans per second so it means the same thing on a
 * Rattata and a Paras. The result is "the fastest settings the detectors do not complain about", which is
 * the question actually being asked.
 */
export function searchCost(headroom, { speedWeight = 1 } = {}) {
  if (!headroom) return Infinity;
  const risk = Math.max(headroom.dragRisk, headroom.tapRisk);
  const span = headroom.legSpanLongest || headroom.strideEnvelope || 1;
  const spansPerSecond = span > 0 ? (headroom.cycleSpeed || 0) / span : 0;
  return risk * 10 - speedWeight * spansPerSecond;
}

/**
 * Coordinate descent with shrinking steps, over knobs that are free to move.
 *
 * Coordinate-wise rather than a gradient or a swarm because `evaluate` is cheap but not free, the space
 * is low-dimensional, and — the part that matters for a person reading the result — every improvement it
 * finds is attributable to ONE knob. A search whose answer is a twenty-dimensional jump tells you nothing
 * about why it is better.
 *
 * `evaluate(values)` returns a cost. Injected rather than computed here so this stays pure and so the
 * caller decides whether cost comes from the instant prediction or from a measured window.
 */
export function optimise(base, specs, evaluate, {
  keys = null, rounds = 6, samples = 7, startScale = 0.5, shrink = 0.55,
} = {}) {
  const free = (keys || Object.keys(specs)).filter(k => specs[k]);
  let best = { ...base };
  let bestCost = evaluate(best);
  let evaluations = 1;
  let scale = startScale;
  const history = [];

  for (let round = 0; round < rounds; round++) {
    let improvedThisRound = false;
    for (const key of free) {
      const spec = specs[key];
      const kind = knobInfo(key).kind;
      const span = spec.max - spec.min;
      for (let i = 0; i < samples; i++) {
        // A symmetric fan around the current value rather than random draws: with a handful of samples,
        // random ones cluster and leave gaps, and the whole point of this stage is to be systematic.
        const frac = ((i / (samples - 1)) * 2 - 1) * scale;
        if (frac === 0) continue;
        const v = best[key] ?? spec.value;
        let next = (kind === 'ratio' && v > 0) ? v * Math.exp(frac) : v + frac * span;
        if (kind === 'integer') next = Math.round(next);
        next = snap(next, spec);
        if (next === best[key]) continue;
        const cand = { ...best, [key]: next };
        const cost = evaluate(cand);
        evaluations++;
        if (cost < bestCost - 1e-9) {
          bestCost = cost; best = cand; improvedThisRound = true;
          history.push({ round, key, to: next, cost });
        }
      }
    }
    scale *= shrink;
    // Nothing moved at this step size, and every later step is smaller — there is nothing left to find.
    if (!improvedThisRound) break;
  }
  return { values: best, cost: bestCost, evaluations, history };
}

/**
 * Which of a setpoint's values may be applied to a different species, and which were dropped.
 *
 * Returns the filtered values plus the reasons, because a setpoint silently losing three knobs on the way
 * to another creature is exactly the kind of thing that later reads as "the search loop is broken" rather
 * than as a units mismatch.
 */
export function transferValues(values, { sameSpecies = false } = {}) {
  if (sameSpecies) return { values: { ...values }, dropped: [] };
  const out = {}, dropped = [];
  for (const [key, v] of Object.entries(values)) {
    const info = knobInfo(key);
    if (info.transfer) out[key] = v;
    else dropped.push({ key, why: info.why || 'does not transfer' });
  }
  return { values: out, dropped };
}

/** How far two tuning vectors are apart, as a fraction of each knob's own range. */
export function tuningDistance(a, b, specs) {
  let sum = 0, n = 0;
  for (const key of Object.keys(specs)) {
    const spec = specs[key];
    const span = spec.max - spec.min;
    if (!(span > 0)) continue;
    const av = a[key] ?? spec.value, bv = b[key] ?? spec.value;
    sum += ((av - bv) / span) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Which knobs actually differ, for a trial's provenance. */
export function changedKeys(a, b, specs, eps = 1e-9) {
  return Object.keys(specs).filter(k => Math.abs((a[k] ?? specs[k].value) - (b[k] ?? specs[k].value)) > eps);
}
