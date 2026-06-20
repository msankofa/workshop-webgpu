// Verifies the worker geometry builder (terrain-field.buildChunkArrays) is
// behaviour-equivalent to the old THREE.PlaneGeometry path, and that adjacent
// chunks share identical edge vertices/normals (seamlessness). Run: node test-terrain-field.mjs
import * as THREE from './node_modules/three/build/three.module.js';
import { buildChunkArrays, terrainHeightAt, terrainNormalAt } from './terrain-field.js';

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL:', msg); } };
const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// --- Reference geometry built the OLD way (PlaneGeometry + per-vertex height + analytic normals) ---
function referenceArrays(xMin, zMin, size, seg) {
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate(xMin + size * 0.5, 0, zMin + size * 0.5);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainHeightAt(params, p.getX(i), p.getZ(i)));
  const out = [0, 0, 0];
  const nrm = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    terrainNormalAt(params, p.getX(i), p.getZ(i), out);
    nrm.setXYZ(i, out[0], out[1], out[2]);
  }
  return {
    positions: p.array, normals: nrm.array,
    uvs: geo.attributes.uv.array, index: geo.index.array,
  };
}

function compareArrays(label, xMin, zMin, size, seg) {
  console.log(`\n[${label}] chunk (${xMin},${zMin}) size ${size} seg ${seg}`);
  const ref = referenceArrays(xMin, zMin, size, seg);
  const got = buildChunkArrays(xMin, zMin, size, seg, params, true);

  ok(got.positions.length === ref.positions.length, `position length ${got.positions.length} vs ${ref.positions.length}`);
  ok(got.index.length === ref.index.length, `index length ${got.index.length} vs ${ref.index.length}`);
  ok(got.uvs.length === ref.uvs.length, `uv length ${got.uvs.length} vs ${ref.uvs.length}`);

  let posMax = 0, nrmMax = 0, uvMax = 0;
  for (let i = 0; i < ref.positions.length; i++) posMax = Math.max(posMax, Math.abs(got.positions[i] - ref.positions[i]));
  for (let i = 0; i < ref.normals.length; i++) nrmMax = Math.max(nrmMax, Math.abs(got.normals[i] - ref.normals[i]));
  for (let i = 0; i < ref.uvs.length; i++) uvMax = Math.max(uvMax, Math.abs(got.uvs[i] - ref.uvs[i]));
  let idxMismatch = 0;
  for (let i = 0; i < ref.index.length; i++) if (got.index[i] !== ref.index[i]) idxMismatch++;

  ok(posMax < 1e-3, `max position delta ${posMax}`);
  ok(nrmMax < 1e-3, `max normal delta ${nrmMax}`);
  ok(uvMax < 1e-6, `max uv delta ${uvMax}`);
  ok(idxMismatch === 0, `index mismatches ${idxMismatch}`);
  console.log(`  pos d=${posMax.toExponential(2)} nrm d=${nrmMax.toExponential(2)} uv d=${uvMax.toExponential(2)} idx mismatch=${idxMismatch}`);

  // heights actually equal the field function
  let hMax = 0;
  const g1 = seg + 1;
  for (let iy = 0; iy <= seg; iy++) for (let ix = 0; ix <= seg; ix++) {
    const vi = (iy * g1 + ix) * 3;
    hMax = Math.max(hMax, Math.abs(got.positions[vi + 1] - terrainHeightAt(params, got.positions[vi], got.positions[vi + 2])));
  }
  ok(hMax < 1e-4, `height vs field delta ${hMax} (Float32 storage rounding expected ~1e-6)`);

  // normals unit-length and pointing up
  let badN = 0;
  for (let i = 0; i < got.normals.length; i += 3) {
    const len = Math.hypot(got.normals[i], got.normals[i + 1], got.normals[i + 2]);
    if (!close(len, 1, 1e-3) || got.normals[i + 1] <= 0) badN++;
  }
  ok(badN === 0, `non-unit / downward normals: ${badN}`);
}

// --- Front-face winding: each triangle's geometric normal should point up (+y) ---
function checkWinding(xMin, zMin, size, seg) {
  console.log(`\n[winding] chunk (${xMin},${zMin})`);
  const a = buildChunkArrays(xMin, zMin, size, seg, params, true);
  const P = a.positions, I = a.index;
  let downFacing = 0;
  for (let t = 0; t < I.length; t += 3) {
    const i0 = I[t] * 3, i1 = I[t + 1] * 3, i2 = I[t + 2] * 3;
    const e1x = P[i1] - P[i0], e1y = P[i1 + 1] - P[i0 + 1], e1z = P[i1 + 2] - P[i0 + 2];
    const e2x = P[i2] - P[i0], e2y = P[i2 + 1] - P[i0 + 1], e2z = P[i2 + 2] - P[i0 + 2];
    // cross(e1, e2).y  — THREE uses CCW front faces, so up-facing => positive
    const ny = e1z * e2x - e1x * e2z;
    if (ny <= 0) downFacing++;
  }
  ok(downFacing === 0, `down-facing triangles (wrong winding): ${downFacing}`);
  console.log(`  triangles ${I.length / 3}, down-facing ${downFacing}`);
}

// --- Seamlessness: shared edge between (0,0) and (1,0) must match exactly ---
function checkSeam(size, seg) {
  console.log(`\n[seam] chunk (0,0) right edge vs chunk (1,0) left edge`);
  const A = buildChunkArrays(0, 0, size, seg, params, true);
  const B = buildChunkArrays(size, 0, size, seg, params, true);
  const g1 = seg + 1;
  let posMax = 0, nrmMax = 0;
  for (let iy = 0; iy <= seg; iy++) {
    const aIdx = (iy * g1 + seg) * 3; // right column of A (ix=seg)
    const bIdx = (iy * g1 + 0) * 3;   // left column of B (ix=0)
    for (let k = 0; k < 3; k++) {
      posMax = Math.max(posMax, Math.abs(A.positions[aIdx + k] - B.positions[bIdx + k]));
      nrmMax = Math.max(nrmMax, Math.abs(A.normals[aIdx + k] - B.normals[bIdx + k]));
    }
  }
  ok(posMax < 1e-6, `seam position delta ${posMax}`);
  ok(nrmMax < 1e-6, `seam normal delta ${nrmMax}`);
  console.log(`  edge pos delta ${posMax.toExponential(2)}, normal delta ${nrmMax.toExponential(2)}`);
}

// render-mesh sizing the system actually uses: chunkSize 30 -> seg max(14, round(22.5)) = 23
compareArrays('render', 0, 0, 30, 23);
compareArrays('render-offset', -60, 90, 30, 23);
compareArrays('collider', 0, 0, 30, 8);
compareArrays('big-index', 0, 0, 30, 260);   // > 65535 verts -> Uint32 index path
checkWinding(0, 0, 30, 23);
checkWinding(-60, 90, 30, 23);
checkSeam(30, 23);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
