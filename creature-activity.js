// Pure, THREE-free decision math for the wild-creature activity FSM (Phase 2): choosing among
// wander/sleep/hunt/socialize/graze and mapping the chosen activity to steering + rest-pose.
// Imported by port-creature-system.js (Phase 2b, not yet wired); unit-tested in
// test-creature-activity.mjs. See docs/superpowers/specs/2026-07-12-wild-activity-fsm-design.md.
//
// Sense ranges (metres) and per-activity duration bands (seconds) are tuning defaults, not
// derived from anything physical: HUNT_SENSE/SOCIAL_SENSE are sized around a few wander-step
// hops so a creature notices prey/kin without omniscient range; THREAT_NEAR is tighter (a threat
// has to be genuinely close to interrupt rest). Durations keep sleep/hunt longest (committed
// activities) and wander/graze shortest (frequently re-evaluated).

export const ACT_WANDER = 'wander';
export const ACT_SLEEP = 'sleep';
export const ACT_HUNT = 'hunt';
export const ACT_SOCIALIZE = 'socialize';
export const ACT_GRAZE = 'graze';

export const HUNT_SENSE = 18;
export const SOCIAL_SENSE = 14;
export const THREAT_NEAR = 8;

export const ACT_DURATION = {
  [ACT_WANDER]: [4, 10],
  [ACT_SLEEP]: [8, 20],
  [ACT_HUNT]: [5, 14],
  [ACT_SOCIALIZE]: [5, 12],
  [ACT_GRAZE]: [3, 8],
};

const RESTING = new Set([ACT_SLEEP, ACT_GRAZE]);

// Sleep-weight modifiers: rises as hp falls, falls as restedness rises. Simple product of two
// monotonic factors, clamped above zero so a starving/unrested creature can still pick sleep.
const SLEEP_HP_K = 1.5;
const SLEEP_REST_K = 0.7;
const SLEEP_FACTOR_MIN = 0.05;

// Neutral, roughly-equal weights; wander slightly favored so idle default is roaming. Phase 3
// gives each creature one of TEMPERAMENTS below instead.
export function defaultTemperament() {
  return {
    [ACT_WANDER]: 1.3,
    [ACT_SLEEP]: 1,
    [ACT_HUNT]: 1,
    [ACT_SOCIALIZE]: 1,
    [ACT_GRAZE]: 1,
  };
}

// Phase 3 personality archetypes: each is a base weight table biasing one drive. Weights are
// relative (chooseActivity normalizes), so a 2.x entry roughly doubles that activity's odds vs a
// 1.0 peer. balanced ~= defaultTemperament so a mixed population still mostly roams.
export const TEMPERAMENTS = {
  balanced: { [ACT_WANDER]: 1.3, [ACT_SLEEP]: 1.0, [ACT_HUNT]: 1.0, [ACT_SOCIALIZE]: 1.0, [ACT_GRAZE]: 1.0 },
  predator: { [ACT_WANDER]: 1.4, [ACT_SLEEP]: 0.5, [ACT_HUNT]: 2.4, [ACT_SOCIALIZE]: 0.6, [ACT_GRAZE]: 0.4 },
  sleepy:   { [ACT_WANDER]: 0.8, [ACT_SLEEP]: 2.6, [ACT_HUNT]: 0.4, [ACT_SOCIALIZE]: 0.8, [ACT_GRAZE]: 1.2 },
  social:   { [ACT_WANDER]: 1.1, [ACT_SLEEP]: 0.8, [ACT_HUNT]: 0.6, [ACT_SOCIALIZE]: 2.6, [ACT_GRAZE]: 1.0 },
  grazer:   { [ACT_WANDER]: 1.0, [ACT_SLEEP]: 1.1, [ACT_HUNT]: 0.4, [ACT_SOCIALIZE]: 0.9, [ACT_GRAZE]: 2.4 },
  restless: { [ACT_WANDER]: 2.4, [ACT_SLEEP]: 0.5, [ACT_HUNT]: 1.1, [ACT_SOCIALIZE]: 0.9, [ACT_GRAZE]: 0.6 },
};

// One color per archetype, shared by the in-world badge pip and the inspector-panel swatch so the
// two always agree. Distinct hues; balanced is a neutral gray.
export const TEMPERAMENT_COLORS = {
  balanced: 0x9aa0a6,
  predator: 0xe5484d,
  sleepy: 0x4c6ef5,
  social: 0x12b5c9,
  grazer: 0x30a46c,
  restless: 0xf59f00,
};

const TEMPERAMENT_NAMES = Object.keys(TEMPERAMENTS);

// Pick one archetype uniformly and optionally jitter each weight by ±`jitter` so same-archetype
// creatures aren't identical. Returns `{ name, weights }` with a fresh weights object.
// Deterministic given `rand`.
export function sampleTemperament(rand = Math.random, jitter = 0.15) {
  const name = TEMPERAMENT_NAMES[Math.min(TEMPERAMENT_NAMES.length - 1, Math.floor(rand() * TEMPERAMENT_NAMES.length))];
  const base = TEMPERAMENTS[name];
  const weights = {};
  for (const act of Object.keys(base)) {
    const f = 1 + (rand() * 2 - 1) * jitter;
    weights[act] = Math.max(0.05, base[act] * f);
  }
  return { name, weights };
}

// Weighted-random activity + duration pick, gated by context. `current` is accepted for API
// symmetry with the integration call site (Phase 3 may use it for anti-repeat bias); Phase 2's
// rules don't reference it. Deterministic given `rand`; always returns a valid activity (falls
// back to ACT_WANDER when nothing is eligible, e.g. all weights zeroed).
export function chooseActivity({
  current,
  ctx = {},
  weights = defaultTemperament(),
  rand = Math.random,
} = {}) {
  const {
    preyDist = Infinity,
    kinDist = Infinity,
    threatDist = Infinity,
    hp01 = 1,
    restedness = 1,
  } = ctx;
  const threatened = threatDist < THREAT_NEAR;

  const eligible = [];
  for (const activity of Object.keys(weights)) {
    if (activity === ACT_HUNT && preyDist > HUNT_SENSE) continue;
    if (activity === ACT_SOCIALIZE && kinDist > SOCIAL_SENSE) continue;
    if (threatened && RESTING.has(activity)) continue;
    let w = weights[activity];
    if (activity === ACT_SLEEP) {
      const factor = (1 + SLEEP_HP_K * (1 - hp01)) * (1 - SLEEP_REST_K * restedness);
      w *= Math.max(SLEEP_FACTOR_MIN, factor);
    }
    if (w > 0) eligible.push([activity, w]);
  }

  let activity;
  if (eligible.length === 0) {
    activity = ACT_WANDER;
  } else {
    const total = eligible.reduce((sum, [, w]) => sum + w, 0);
    let r = rand() * total;
    activity = eligible[eligible.length - 1][0]; // last as fallback for float rounding at the tail
    for (const [name, w] of eligible) {
      if (r < w) { activity = name; break; }
      r -= w;
    }
  }

  const [minS, maxS] = ACT_DURATION[activity];
  const duration = minS + rand() * (maxS - minS);
  return { activity, duration };
}

// Map an activity to the roster loop's steering mode and a target rest-pose scalar (0 normal ...
// 1 fully settled). Unknown activities fall back to wander steering with no rest-pose.
export function activitySteer(activity) {
  switch (activity) {
    case ACT_SLEEP: return { steer: 'stay', restPose: 1 };
    case ACT_GRAZE: return { steer: 'stay', restPose: 0.6 };
    case ACT_HUNT: return { steer: 'hunt', restPose: 0 };
    case ACT_SOCIALIZE: return { steer: 'socialize', restPose: 0 };
    default: return { steer: 'wander', restPose: 0 };
  }
}
