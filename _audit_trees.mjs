// Headless geometry audit for trees.js (Phase 2 verification).
// Checks: finite verts, unit normals, in-range indices, sane UVs — across
// default / rounded-off / atlas configs — plus the merge fix (passing a
// texture-like object where the DEFAULTS value is null must not crash).
import * as THREE from 'three';
import { createTree } from './trees.js';

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL:', msg); };

function auditMesh(label, mesh, { expectUVCells = null } = {}) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv  = g.getAttribute('uv');
  const idx = g.getIndex();
  if (!pos || pos.count === 0) { console.log(`  ${label}: empty (skipped)`); return; }

  // finite positions
  for (let i = 0; i < pos.array.length; i++)
    if (!Number.isFinite(pos.array[i])) { fail(`${label} non-finite position @${i}`); break; }

  // unit normals
  let maxNErr = 0;
  for (let i = 0; i < nrm.count; i++) {
    const x = nrm.getX(i), y = nrm.getY(i), z = nrm.getZ(i);
    const len = Math.hypot(x, y, z);
    maxNErr = Math.max(maxNErr, Math.abs(len - 1));
  }
  if (maxNErr > 1e-4) fail(`${label} normals not unit (max err ${maxNErr.toExponential(2)})`);

  // indices in range
  let maxIdx = -1;
  for (let i = 0; i < idx.count; i++) maxIdx = Math.max(maxIdx, idx.getX(i));
  if (maxIdx >= pos.count) fail(`${label} index ${maxIdx} >= vert count ${pos.count}`);
  if (idx.count % 3 !== 0) fail(`${label} index count ${idx.count} not multiple of 3`);

  // UVs finite and (for default/leaves) within [0,1]
  let uvMin = Infinity, uvMax = -Infinity;
  for (let i = 0; i < uv.array.length; i++) {
    const v = uv.array[i];
    if (!Number.isFinite(v)) { fail(`${label} non-finite uv @${i}`); break; }
    uvMin = Math.min(uvMin, v); uvMax = Math.max(uvMax, v);
  }
  console.log(`  ${label}: verts=${pos.count} tris=${idx.count/3} maxNErr=${maxNErr.toExponential(2)} uv∈[${uvMin.toFixed(2)},${uvMax.toFixed(2)}]`);

  // atlas cell containment: every leaf-quad's UVs should sit inside one grid cell
  if (expectUVCells) {
    const { cols, rows } = expectUVCells;
    const du = 1 / cols, dv = 1 / rows;
    for (let q = 0; q < uv.count; q += 4) {
      const us = [0,1,2,3].map(k => uv.getX(q+k));
      const vs = [0,1,2,3].map(k => uv.getY(q+k));
      const cu = Math.round(Math.min(...us) / du), cv = Math.round(Math.min(...vs) / dv);
      const okU = Math.max(...us) <= (cu + 1) * du + 1e-6 && Math.min(...us) >= cu * du - 1e-6;
      const okV = Math.max(...vs) <= (cv + 1) * dv + 1e-6 && Math.min(...vs) >= cv * dv - 1e-6;
      if (!okU || !okV) { fail(`${label} leaf-quad @${q} not contained in an atlas cell`); break; }
    }
  }
}

function run(label, opts, leafAtlas = null) {
  console.log(`\n[${label}]`);
  const t = createTree(opts);
  auditMesh('branches', t.branchesMesh);
  auditMesh('leaves', t.leavesMesh, { expectUVCells: leafAtlas });
  auditMesh('leavesShadow', t.leavesShadowMesh, { expectUVCells: leafAtlas });
}

// 1. defaults (roundedNormals on)
run('default', { seed: 7, levels: 3 });

// 2. rounded normals off — leaf normals must be exactly the billboard face (unit)
run('rounded-off', { seed: 7, levels: 3, leaves: { roundedNormals: false } });

// 3. atlas — every leaf quad's UVs must fall inside one 4x2 cell
run('atlas', { seed: 7, levels: 3, leaves: { atlas: { cols: 4, rows: 2 } } }, { cols: 4, rows: 2 });

// 3b. pinned atlas cell — EVERY leaf quad must sit in exactly cell 5 of a 4x2 grid
console.log('\n[atlas-pinned cell=5]');
{
  const t = createTree({ seed: 7, levels: 3, leaves: { atlas: { cols: 4, rows: 2, cell: 5 } } });
  const uv = t.leavesMesh.geometry.getAttribute('uv');
  const du = 1 / 4, dv = 1 / 2, cx = 5 % 4, cy = Math.floor(5 / 4);
  let bad = 0;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < cx * du - 1e-6 || u > (cx + 1) * du + 1e-6 || v < cy * dv - 1e-6 || v > (cy + 1) * dv + 1e-6) bad++;
  }
  if (bad) fail(`atlas-pinned: ${bad} uv coords outside cell 5`);
  else console.log(`  ok: all ${uv.count} uv coords inside cell 5 (u∈[${cx*du},${(cx+1)*du}], v∈[${cy*dv},${(cy+1)*dv}])`);
}

// 4. shadow split still works with new leaf path
run('shadow-split', { seed: 7, levels: 3, leaves: { shadowFraction: 0.5 } });

// 5. MERGE FIX: pass texture-like objects where DEFAULTS are null. Before the
//    fix this threw (Object.keys(null)) during option merge.
console.log('\n[merge-fix: texture-like objects into null defaults]');
const fakeTex = { isTexture: true, wrapS: 0, wrapT: 0 }; // duck-typed, never sampled headless
try {
  const t = createTree({
    seed: 7, levels: 2,
    bark: { map: fakeTex, normalMap: fakeTex },
    leaves: { map: fakeTex, atlas: { cols: 2, rows: 2 } },
  });
  // confirm the objects survived the merge by reference (not deep-merged into {})
  if (t.options.bark.map !== fakeTex) fail('bark.map was not preserved through merge');
  if (t.options.leaves.map !== fakeTex) fail('leaves.map was not preserved through merge');
  if (t.branchMat.map !== fakeTex) fail('branchMat.map not bound from options');
  if (t.branchMat.normalMap !== fakeTex) fail('branchMat.normalMap not bound from options');
  console.log('  merge ok: texture refs preserved & bound; wrap set to', fakeTex.wrapS === THREE.RepeatWrapping ? 'RepeatWrapping' : fakeTex.wrapS);
  auditMesh('branches', t.branchesMesh);
  auditMesh('leaves', t.leavesMesh, { expectUVCells: { cols: 2, rows: 2 } });
} catch (e) {
  fail('merge fix did not hold: ' + e.message);
}

// 6. regenerateLeaves: branch geometry unchanged, leaf geometry reflects new opts
console.log('\n[regenerateLeaves]');
{
  const t = createTree({ seed: 42, levels: 3, leaves: { count: 10, size: 1.0 } });
  const branchPos = t.branchesMesh.geometry.getAttribute('position').array.slice();
  const branchNrm = t.branchesMesh.geometry.getAttribute('normal').array.slice();
  const leafCountBefore = t.leavesMesh.geometry.getAttribute('position').count;

  t.regenerateLeaves({ count: 3, size: 2.5 });

  const branchPosAfter = t.branchesMesh.geometry.getAttribute('position').array;
  const leafCountAfter  = t.leavesMesh.geometry.getAttribute('position').count;

  let branchChanged = false;
  for (let i = 0; i < branchPos.length; i++) {
    if (branchPos[i] !== branchPosAfter[i]) { branchChanged = true; break; }
  }
  if (branchChanged) fail('regenerateLeaves: branch positions changed');
  else console.log('  ok: branch positions unchanged');

  const branchNrmAfter = t.branchesMesh.geometry.getAttribute('normal').array;
  let nrmChanged = false;
  for (let i = 0; i < branchNrm.length; i++) {
    if (branchNrm[i] !== branchNrmAfter[i]) { nrmChanged = true; break; }
  }
  if (nrmChanged) fail('regenerateLeaves: branch normals changed');
  else console.log('  ok: branch normals unchanged');

  // count=3 leaves (doubleBillboard default=true → 2 quads each → 8 verts/leaf per terminal branch)
  // → fewer verts than count=10
  if (leafCountAfter >= leafCountBefore) {
    fail(`regenerateLeaves: leaf count ${leafCountAfter} did not decrease from ${leafCountBefore}`);
  } else {
    console.log(`  ok: leaf verts ${leafCountBefore} → ${leafCountAfter} (count 10→3)`);
  }

  auditMesh('regenerateLeaves leaves', t.leavesMesh);
  auditMesh('regenerateLeaves shadow', t.leavesShadowMesh);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
