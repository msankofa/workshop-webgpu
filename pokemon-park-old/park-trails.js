// Compatibility entry point for the original park. Generic routing now lives at the repository
// root so Base Game can use it without importing a retired experience.
export * from '../trail-router.js';

/** The park's own trail plan: a spine from the gate to the peak, plus spurs. */
export function parkTrailLegs(terrain) {
  const H = terrain.worldX / 2;
  const at = (fx, fz) => ({ x: fx * H, z: fz * H });
  const gate = at(terrain.townPad.x, terrain.townPad.z);
  const lakeHead = at(terrain.lake.x - terrain.lake.radius * 1.2, terrain.lake.z);
  const lakeFoot = at(terrain.lake.x + terrain.lake.radius * 0.2, terrain.lake.z + terrain.lake.radius * 1.15);
  const tarn = at(terrain.tarn.x + terrain.tarn.radius * 1.7, terrain.tarn.z);
  const saddle = at(terrain.peak.x * 0.66, terrain.peak.z * 0.66);
  return [
    { name: 'gate to the lake', from: gate, to: lakeHead, width: 4.2 },
    { name: 'lake shore', from: lakeHead, to: lakeFoot, width: 3.2 },
    { name: 'lake to the tarn', from: lakeHead, to: tarn, width: 3.4 },
    { name: 'tarn to the saddle', from: tarn, to: saddle, width: 2.8 },
    { name: 'east meadow', from: gate, to: at(0.86, -0.12), width: 3.2 },
    { name: 'south wood', from: gate, to: at(-0.72, 0.86), width: 3.0 },
    { name: 'west loop', from: lakeFoot, to: at(-0.84, 0.1), width: 2.8 },
  ];
}
