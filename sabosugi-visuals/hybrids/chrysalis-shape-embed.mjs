/**
 * Reduces one Chrysalis Engine point cloud to a fixed-length descriptor vector, so shapes with
 * different numbers of sampled points can still be compared and fed into ordination-vectors.js.
 *
 * The main component is a "shape distribution" (Osada et al.): a histogram of distances between
 * random pairs of surface points. It needs no alignment between shapes (rotation/translation of
 * one shape doesn't change the distances within it), unlike comparing raw point positions would.
 * A few scalar extras ride alongside it for signal a distance histogram can't see on its own:
 * mean growth/disturbance (organic vs crystal balance) and seed count/polarity (how many growth
 * fronts were placed, and whether any were healing rather than crystallizing).
 */

import { BOUND_RADIUS } from './chrysalis-point-cloud.mjs';

export const DEFAULT_BINS = 32;
export const DEFAULT_PAIR_SAMPLES = 20000;
const MAX_HISTOGRAM_DISTANCE = 2 * BOUND_RADIUS;

/** Deterministic PRNG so a given corpus embeds the same way every run. */
export function makeRng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function distance3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * `cloud` is a chrysalis-point-cloud.mjs result ({ points }). `seeds` is the same seed list the
 * cloud was traced with — passed separately because seed metadata isn't part of the geometry.
 * Returns a plain Float64Array of length `bins + 5`.
 */
export function embedPointCloud(cloud, seeds = [], { bins = DEFAULT_BINS, pairSamples = DEFAULT_PAIR_SAMPLES, rng = makeRng(1) } = {}) {
  const points = cloud.points;
  const histogram = new Float64Array(bins);

  if (points.length >= 2) {
    for (let s = 0; s < pairSamples; s++) {
      const i = Math.floor(rng() * points.length);
      let j = Math.floor(rng() * points.length);
      if (j === i) j = (j + 1) % points.length;
      const d = distance3(points[i].position, points[j].position);
      const bin = Math.min(bins - 1, Math.floor((d / MAX_HISTOGRAM_DISTANCE) * bins));
      histogram[bin]++;
    }
    for (let b = 0; b < bins; b++) histogram[b] /= pairSamples;
  }

  let meanGrowth = 0, meanDisturbance = 0;
  let centroid = [0, 0, 0];
  for (const pt of points) {
    meanGrowth += pt.growth;
    meanDisturbance += pt.disturbance;
    centroid[0] += pt.position[0]; centroid[1] += pt.position[1]; centroid[2] += pt.position[2];
  }
  const n = Math.max(points.length, 1);
  meanGrowth /= n; meanDisturbance /= n;
  centroid = [centroid[0] / n, centroid[1] / n, centroid[2] / n];

  let boundingRadius = 0;
  for (const pt of points) boundingRadius = Math.max(boundingRadius, distance3(pt.position, centroid));

  const seedCount = seeds.length;
  const positiveSeeds = seeds.filter((s) => s.polarity >= 0).length;
  const seedPositiveFraction = seedCount ? positiveSeeds / seedCount : 0;

  const vector = new Float64Array(bins + 5);
  vector.set(histogram, 0);
  vector[bins] = meanGrowth;
  vector[bins + 1] = meanDisturbance;
  vector[bins + 2] = boundingRadius;
  vector[bins + 3] = seedCount;
  vector[bins + 4] = seedPositiveFraction;
  return vector;
}

/** Dense vector to the {idx, val} sparse-row format ordination-vectors.js's buildGram expects. */
export function toSparseRow(vector) {
  const idx = new Int32Array(vector.length);
  for (let i = 0; i < vector.length; i++) idx[i] = i;
  return { idx, val: Float64Array.from(vector) };
}
