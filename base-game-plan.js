// Pure derivation for Base Game's coarse, kilometres-ahead planning window.

export const BASE_GAME_PLAN_DEFAULTS = Object.freeze({
  post: 30,
  tileIntervals: 16,
  tilesPerSide: 16,
  waterMargin: 1.2,
  maxGrade: 0.55,
  maxCrossSlope: 0.4,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Attach planWalk: 0 is water/cliff, 1..255 grades increasingly flatter ground. */
export function planWalkDerive(tile, options = {}) {
  const O = { ...BASE_GAME_PLAN_DEFAULTS, ...options };
  const heights = tile.heights;
  if (!heights) return tile;
  const { texels, step } = tile;
  const out = new Uint8Array(texels * texels);
  const h = (x, z) => heights[clamp(z, 0, texels - 1) * texels + clamp(x, 0, texels - 1)];
  for (let iz = 0; iz < texels; iz++) for (let ix = 0; ix < texels; ix++) {
    const i = iz * texels + ix;
    if (!Number.isFinite(heights[i]) || heights[i] <= O.seaLevel + O.waterMargin) continue;
    let grade = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      grade = Math.max(grade, Math.abs(h(ix + dx, iz + dz) - heights[i]) / (Math.hypot(dx, dz) * step));
    }
    const gx = (h(ix + 1, iz) - h(ix - 1, iz)) / ((ix > 0 && ix < texels - 1 ? 2 : 1) * step);
    const gz = (h(ix, iz + 1) - h(ix, iz - 1)) / ((iz > 0 && iz < texels - 1 ? 2 : 1) * step);
    const cross = Math.hypot(gx, gz);
    if (grade > O.maxGrade || cross > O.maxCrossSlope) continue;
    const difficulty = Math.max(grade / Math.max(O.maxGrade, 1e-6), cross / Math.max(O.maxCrossSlope, 1e-6));
    out[i] = 1 + Math.round((1 - clamp(difficulty, 0, 1)) * 254);
  }
  tile.planWalk = out;
  return tile;
}

export function createPlanWalkDerive(options = {}) {
  let seaLevel = options.seaLevel ?? 0;
  return {
    derive: tile => planWalkDerive(tile, { ...options, seaLevel }),
    setSeaLevel(value) { if (Number.isFinite(value)) seaLevel = value; },
  };
}
