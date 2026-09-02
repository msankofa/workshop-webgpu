/**
 * Samples a Chrysalis Engine config into a point cloud, for shape comparison rather than
 * rendering. Reuses the CPU field twin in chrysalis-field-cpu.mjs and the same marching
 * constants as chrysalis-engine.html's fragment shader (outerSteps, stepSafety, the 0.0045 hit
 * threshold, the 2.35 bounding radius from chRaySphere) so the point cloud matches what the
 * shader would actually draw.
 *
 * Rays are cast radially inward from a Fibonacci sphere of directions rather than from a single
 * camera, since the goal is the whole surface, not one view of it. This assumes the field is
 * roughly star-shaped around the origin: a concavity that faces away from every radial direction
 * (a fold hidden behind another fold, as seen from the center) will not get a sample. That is an
 * acceptable simplification for descriptor purposes since egregious concavities of that kind cost
 * `growth`/`disturbance` visibility in the renderer too, not just here.
 */

import { chDistance, chNormal, chEvaluate } from './chrysalis-field-cpu.mjs';

export const BOUND_RADIUS = 2.35;
const HIT_THRESHOLD = 0.0045;
const MIN_STEP = 0.006;
const MAX_STEP = 0.16;

/** N roughly-evenly-spaced points on the unit sphere. */
function fibonacciSphere(n) {
  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(n - 1, 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    points.push([Math.cos(theta) * radiusAtY, y, Math.sin(theta) * radiusAtY]);
  }
  return points;
}

/**
 * Traces one config + seed list into a point cloud.
 * Returns { points: [{position, normal, growth, disturbance}], missCount, rayCount }.
 */
export function tracePointCloud(config, seeds, { rayCount = 3000, outerSteps = null, time = 0 } = {}) {
  const steps = outerSteps ?? config.outerSteps ?? 96;
  const stepSafety = config.stepSafety ?? 0.46;
  const directions = fibonacciSphere(rayCount);
  const points = [];
  let missCount = 0;

  for (const dir of directions) {
    const ro = [dir[0] * BOUND_RADIUS, dir[1] * BOUND_RADIUS, dir[2] * BOUND_RADIUS];
    const rd = [-dir[0], -dir[1], -dir[2]];
    let t = 0;
    let hit = false;
    for (let i = 0; i < steps; i++) {
      const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
      const d = chDistance(p, config, seeds, time);
      if (d < HIT_THRESHOLD) {
        const normal = chNormal(p, config, seeds, time);
        const sample = chEvaluate(p, config, seeds, time);
        points.push({ position: p, normal, growth: sample.growth, disturbance: sample.disturbance });
        hit = true;
        break;
      }
      t += Math.min(MAX_STEP, Math.max(MIN_STEP, d * stepSafety));
      if (t > 2 * BOUND_RADIUS) break;
    }
    if (!hit) missCount++;
  }

  return { points, missCount, rayCount };
}
