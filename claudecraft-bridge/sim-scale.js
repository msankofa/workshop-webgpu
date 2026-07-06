// claudecraft-bridge/sim-scale.js
// ClaudeCraft humanoid reference height in sim yards (manifest.ts HUMANOID_H).
export const SIM_HUMANOID_HEIGHT = 2.6;

export function makeScale(workshopPlayerHeight) {
  const SCALE = workshopPlayerHeight / SIM_HUMANOID_HEIGHT;
  return {
    SCALE,
    toWorld: (v) => v * SCALE,
    toSim: (v) => v / SCALE,
  };
}
