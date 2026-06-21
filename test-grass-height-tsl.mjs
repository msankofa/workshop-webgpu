import { terrainHeightAt } from './terrain-field.js';
import { grassHeightRef } from './grass-height-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };

// Sample a grid spanning several chunks incl. fractional + negative coords.
let maxErr = 0;
for (let x = -64; x <= 64; x += 3.5) {
  for (let z = -64; z <= 64; z += 3.5) {
    const a = terrainHeightAt(params, x, z);
    const b = grassHeightRef(params, x, z);
    maxErr = Math.max(maxErr, Math.abs(a - b));
  }
}
ok(maxErr < 1e-6, `height port matches terrainHeightAt over grid (maxErr=${maxErr.toExponential(2)})`);

// Determinism: same input twice → identical output.
ok(grassHeightRef(params, 12.3, -7.1) === grassHeightRef(params, 12.3, -7.1), 'deterministic');

// Lake params actually move the result somewhere (so uniforms are wired meaningfully).
// (0,0) may sit on dry land where the basin is 0, so scan the grid for any basin cell.
let lakeMoves = false;
for (let x = -64; x <= 64 && !lakeMoves; x += 3.5) {
  for (let z = -64; z <= 64; z += 3.5) {
    if (grassHeightRef({ ...params, lakeDepth: 10 }, x, z) !== grassHeightRef({ ...params, lakeDepth: 0 }, x, z)) {
      lakeMoves = true; break;
    }
  }
}
ok(lakeMoves, 'lakeDepth changes height where a basin exists');

process.exit(fail ? 1 : 0);
