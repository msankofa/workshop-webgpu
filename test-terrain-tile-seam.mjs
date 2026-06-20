// Height tile seam test for the heightmap-sampled terrain route.
// Verifies the final CPU tile sampling primitive can produce identical shared
// edge heights and heightmap-derived normals for adjacent chunks.
import { buildHeightTile, sampleHeightTileBilinear } from './terrain-field.js';

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const size = 30;
const texelWorld = 0.5;
const apron = 1;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function tileNormal(tile, x, z) {
  const e = tile.step;
  const hL = sampleHeightTileBilinear(tile, x - e, z);
  const hR = sampleHeightTileBilinear(tile, x + e, z);
  const hD = sampleHeightTileBilinear(tile, x, z - e);
  const hU = sampleHeightTileBilinear(tile, x, z + e);
  const nx = hL - hR;
  const ny = 2 * e;
  const nz = hD - hU;
  const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
  return [nx * inv, ny * inv, nz * inv];
}

console.log('\n[1] adjacent height tiles agree on their shared edge');
{
  const a = buildHeightTile(0, 0, size, texelWorld, params, apron);
  const b = buildHeightTile(size, 0, size, texelWorld, params, apron);
  ok(a.texels === 63, `tile texels ${a.texels} (61 interior samples + 2 apron)`);
  ok(a.step === texelWorld, `tile step ${a.step}`);

  let maxHeightDelta = 0;
  let maxNormalDelta = 0;
  for (let i = 0; i <= a.intervals; i++) {
    const z = i * a.step;
    const ha = sampleHeightTileBilinear(a, size, z);
    const hb = sampleHeightTileBilinear(b, size, z);
    maxHeightDelta = Math.max(maxHeightDelta, Math.abs(ha - hb));

    const na = tileNormal(a, size, z);
    const nb = tileNormal(b, size, z);
    for (let k = 0; k < 3; k++) maxNormalDelta = Math.max(maxNormalDelta, Math.abs(na[k] - nb[k]));
  }
  ok(close(maxHeightDelta, 0), `shared-edge height delta ${maxHeightDelta}`);
  ok(maxNormalDelta < 1e-6, `shared-edge normal delta ${maxNormalDelta}`);
}

console.log('\n[2] diagonal neighbor edges agree across a 2x2 tile block');
{
  const t00 = buildHeightTile(0, 0, size, texelWorld, params, apron);
  const t10 = buildHeightTile(size, 0, size, texelWorld, params, apron);
  const t01 = buildHeightTile(0, size, size, texelWorld, params, apron);
  const t11 = buildHeightTile(size, size, size, texelWorld, params, apron);

  const corner = [size, size];
  const hs = [t00, t10, t01, t11].map(t => sampleHeightTileBilinear(t, corner[0], corner[1]));
  const maxCornerDelta = Math.max(...hs) - Math.min(...hs);
  ok(close(maxCornerDelta, 0), `four-tile corner height delta ${maxCornerDelta}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
