// Pure tracer timing/geometry helpers shared by the hitscan spawn path, replicated effect
// adapter, renderer, and Node tests. Damage remains hitscan; these functions only animate the
// cosmetic luminous streak between the captured muzzle and the resolved hit point.

export const DEFAULT_TRACER_FX = Object.freeze({
  speed: 750,
  length: 1.2,
  width: 0.04,
  opacity: 0.85,
  glow: 0.35,
  minVisibleDistance: 3,
});
export const MIN_TRACER_ENTITY_LIFE = 0.12;

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeTracerFx(value = {}) {
  const fx = value && typeof value === 'object' ? value : {};
  return {
    speed: clamp(finite(fx.speed, DEFAULT_TRACER_FX.speed), 1, 5000),
    length: clamp(finite(fx.length, DEFAULT_TRACER_FX.length), 0.01, 20),
    width: clamp(finite(fx.width, DEFAULT_TRACER_FX.width), 0.001, 1),
    opacity: clamp(finite(fx.opacity, DEFAULT_TRACER_FX.opacity), 0, 2),
    glow: clamp(finite(fx.glow, DEFAULT_TRACER_FX.glow), 0, 2),
    minVisibleDistance: clamp(
      finite(fx.minVisibleDistance, DEFAULT_TRACER_FX.minVisibleDistance),
      0,
      100,
    ),
  };
}

export function tracerDistance(p0, p1) {
  if (!Array.isArray(p0) || !Array.isArray(p1)) return 0;
  return Math.hypot(
    (Number(p1[0]) || 0) - (Number(p0[0]) || 0),
    (Number(p1[1]) || 0) - (Number(p0[1]) || 0),
    (Number(p1[2]) || 0) - (Number(p0[2]) || 0),
  );
}

export function tracerLifetime(p0, p1, profile) {
  const fx = normalizeTracerFx(profile);
  const distance = tracerDistance(p0, p1);
  if (distance <= fx.minVisibleDistance) return 0;
  const visibleLength = Math.min(fx.length, distance - fx.minVisibleDistance);
  // The entity remains alive until the tail, not merely the leading edge, reaches the target.
  // Keep short-range streak entities present for at least two 20 Hz multiplayer snapshots.
  // The renderer stops drawing after the moving tail arrives, so this network envelope does
  // not make the streak linger visually.
  return Math.max(
    MIN_TRACER_ENTITY_LIFE,
    (distance + visibleLength) / fx.speed,
  );
}

export function tracerSegmentAt(p0, p1, ageSeconds, profile) {
  const fx = normalizeTracerFx(profile);
  const distance = tracerDistance(p0, p1);
  if (distance <= fx.minVisibleDistance || distance <= 1e-8 || fx.opacity <= 0) return null;

  const age = Math.max(0, finite(ageSeconds, 0));
  const leadingDistance = age * fx.speed;
  const visibleLength = Math.min(fx.length, distance - fx.minVisibleDistance);
  if (leadingDistance <= fx.minVisibleDistance || leadingDistance >= distance + visibleLength) return null;

  // After the head reaches the target, continue advancing the tail into it. The streak
  // therefore contracts naturally instead of lingering as a stationary beam.
  const headDistance = Math.min(distance, leadingDistance);
  const tailDistance = Math.max(
    fx.minVisibleDistance,
    Math.min(distance, leadingDistance - visibleLength),
  );
  if (headDistance - tailDistance <= 1e-8) return null;

  const invDistance = 1 / distance;
  const dx = (p1[0] - p0[0]) * invDistance;
  const dy = (p1[1] - p0[1]) * invDistance;
  const dz = (p1[2] - p0[2]) * invDistance;
  const segmentLength = headDistance - tailDistance;

  return {
    start: [
      p0[0] + dx * tailDistance,
      p0[1] + dy * tailDistance,
      p0[2] + dz * tailDistance,
    ],
    end: [
      p0[0] + dx * headDistance,
      p0[1] + dy * headDistance,
      p0[2] + dz * headDistance,
    ],
    alpha: fx.opacity * clamp(segmentLength / visibleLength, 0, 1),
    width: fx.width,
    glow: fx.glow,
    segmentLength,
  };
}
