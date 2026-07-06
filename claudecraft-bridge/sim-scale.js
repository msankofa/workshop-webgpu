// claudecraft-bridge/sim-scale.js
// ClaudeCraft humanoid reference height in sim yards (manifest.ts HUMANOID_H).
export const SIM_HUMANOID_HEIGHT = 2.6;

export function makeScale(workshopPlayerHeight) {
  if (!Number.isFinite(workshopPlayerHeight) || workshopPlayerHeight <= 0) {
    throw new RangeError(
      `makeScale: workshopPlayerHeight must be a positive finite number, got ${workshopPlayerHeight}`,
    );
  }
  const SCALE = workshopPlayerHeight / SIM_HUMANOID_HEIGHT;
  return {
    SCALE,
    toWorld: (v) => v * SCALE,
    toSim: (v) => v / SCALE,
  };
}
