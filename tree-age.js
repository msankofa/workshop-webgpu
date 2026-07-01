// tree-age.js
// Pure age transform for a trees.js options object: no DOM/THREE dependency, so this is
// reusable by both tree-viewer.html (age-preview slider) and, later, the game's forest
// placement (rolling a random age per instance) without duplicating the math.
//
// ageT=0 is a young, small, sparse sapling. ageT=1 reproduces the input's values unchanged
// (a new object, not the same reference, but value-equivalent).

const YOUNG_SCALE = 0.15;       // overall length/radius fraction at age 0
const YOUNG_LEAF_COUNT = 0.2;   // leaf count fraction at age 0
const YOUNG_LEAF_SIZE = 0.4;    // leaf size fraction at age 0
const MIN_LEVELS_AT_AGE_0 = 1;  // a sapling still has its first branch level, not just a bare trunk

function lerp(a, b, t) { return a + (b - a) * t; }

export function applyAge(opts, ageT) {
  const t = Math.max(0, Math.min(1, ageT));
  const scale = lerp(YOUNG_SCALE, 1, t);
  const levels = Math.round(lerp(Math.min(MIN_LEVELS_AT_AGE_0, opts.levels), opts.levels, t));
  return {
    ...opts,
    levels,
    length: opts.length.map(v => v * scale),
    radius: opts.radius.map(v => v * scale),
    leaves: {
      ...opts.leaves,
      count: Math.round(opts.leaves.count * lerp(YOUNG_LEAF_COUNT, 1, t)),
      size: opts.leaves.size * lerp(YOUNG_LEAF_SIZE, 1, t),
    },
  };
}

export default applyAge;
