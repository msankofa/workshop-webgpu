// particle-field.js
// Pure-JS particle simulation math for SP4b — no three.js. CPU source of truth the TSL
// compute kernels transcribe, and the Node-tested guard. Two species (ember, dust) share
// the pipeline; only forces/look differ (kindParams).

// Deterministic pseudo-random in [0,1) from (seed, salt).
export function hash01(seed, salt) {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) ^ Math.imul((salt | 0) + 1, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// A pseudo-random point inside the camera-centered cube [cam ± R]. Deterministic per seed,
// so a particle re-spawns reproducibly (and the TSL kernel matches).
export function spawnInVolume(seed, camX, camY, camZ, R) {
  return {
    x: camX + (hash01(seed, 1) * 2 - 1) * R,
    y: camY + (hash01(seed, 2) * 2 - 1) * R,
    z: camZ + (hash01(seed, 3) * 2 - 1) * R,
  };
}

// Divergence-free 2D flow = curl of a scalar potential `pot(x,z)`:
//   (∂pot/∂z, -∂pot/∂x). Analytically div-free, so particles drift without clumping.
export function curlNoise2(x, z, pot, e = 1e-3) {
  const fx = (pot(x, z + e) - pot(x, z - e)) / (2 * e);
  const fz = -(pot(x + e, z) - pot(x - e, z)) / (2 * e);
  return { fx, fz };
}

// Advance age; fade-in/out envelope; wrap (respawn) at maxLife.
export function stepLife(age, dt, maxLife, fadeFrac = 0.15) {
  let a = age + dt;
  let reborn = false;
  if (a >= maxLife) { a -= maxLife; reborn = true; }
  const f = fadeFrac * maxLife;
  const fadeIn = Math.max(0, Math.min(1, a / f));
  const fadeOut = Math.max(0, Math.min(1, (maxLife - a) / f));
  return { age: a, fade: fadeIn * fadeOut, reborn };
}

// Per-species config: forces, look, blend.
export function kindParams(kind) {
  if (kind === 'dust') {
    return {
      buoyancy: 0, drag: 0.6, curlStrength: 0.5, wind: [0.3, 0.15],
      size: 0.06, color: [0.55, 0.55, 0.5], alpha: 0.18, blend: 'alpha',
      flicker: 0, maxLife: 12, speed: 0.4,
    };
  }
  // ember / firefly (default)
  return {
    buoyancy: 0.8, drag: 0.4, curlStrength: 1.2, wind: [0.05, 0.0],
    size: 0.12, color: [1.0, 0.6, 0.25], alpha: 1.0, blend: 'additive',
    flicker: 0.5, maxLife: 6, speed: 0.8,
  };
}
