// The Sentinel flying wing in flight-meshes.js: pins the drawing-derived proportions the mesh was
// transcribed from (scratchpads/rq170-sentinel/intake-analysis.md) and the conventions every craft
// here shares. Run: node test-flight-meshes-sentinel.mjs
import * as THREE from 'three';
import { buildCraftMesh, CRAFT_KINDS } from './flight-meshes.js';

let failed = 0;
function ok(msg, cond, detail = "") { console.log(`${cond ? "ok  " : "FAIL"} ${msg}${detail ? "  " + detail : ""}`); if (!cond) failed++; }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const materials = {
  standard: (color, emissive = 0x000000) => new THREE.MeshStandardMaterial({ color, emissive }),
  basic: (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity }),
};

ok('sentinel is a registered kind', CRAFT_KINDS.includes('sentinel'), CRAFT_KINDS.join(', '));
const g = buildCraftMesh('sentinel', 0xbdb9b2, materials);
g.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(g);
const size = new THREE.Vector3(); box.getSize(size);

// Drawing: 601 px span over 224 px nose-to-tip, authored at a 20 m span.
ok('span is 20 m', near(size.x, 20, 0.05), `x=${size.x.toFixed(3)}`);
ok('length is the drawing\'s 7.45 m', near(size.z, 7.45, 0.1), `z=${size.z.toFixed(3)}`);
ok('span-to-length ratio holds', near(size.x / size.z, 2.68, 0.06), (size.x / size.z).toFixed(3));
ok('nose points -Z and sits at -3.7', near(box.min.z, -3.7, 0.02), `minZ=${box.min.z.toFixed(3)}`);
ok('hump peaks 0.5 m above the wing skin', near(box.max.y, 0.5, 0.03), `maxY=${box.max.y.toFixed(3)}`);
ok('belly is about a metre deep', box.min.y < -0.85 && box.min.y > -1.1, `minY=${box.min.y.toFixed(3)}`);

// The wing: one mesh, mirror-symmetric, sharp trailing edge (no vertex of the wing above y=0).
let wing = null, tris = 0, bad = 0, wingTop = -Infinity;
g.traverse((o) => {
  if (!o.isMesh) return;
  const p = o.geometry.attributes.position;
  tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
  for (let i = 0; i < p.array.length; i++) if (!Number.isFinite(p.array[i])) bad++;
  if (o.name === 'sentinel-wing') { wing = o; for (let i = 0; i < p.count; i++) wingTop = Math.max(wingTop, p.getY(i)); }
});
ok('the wing is one named mesh', !!wing);
ok('wing upper surface is flat at y=0', near(wingTop, 0, 1e-6), `top=${wingTop.toFixed(4)}`);
if (wing) {
  const p = wing.geometry.attributes.position;
  let asym = 0;
  const key = (x, y, z) => `${Math.abs(x).toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) { const k = key(p.getX(i), p.getY(i), p.getZ(i)); seen.set(k, (seen.get(k) || 0) + (p.getX(i) < 0 ? -1 : 1)); }
  for (const [k, v] of seen) if (!k.startsWith('0.000|') && v !== 0) asym++;
  ok('wing is mirror-symmetric about x=0', asym === 0, `${asym} unmatched vertices`);
  // Leading edge sweep: the front-most vertex at 6 m span sits 0.638 * 6 aft of the nose.
  let le = Infinity; for (let i = 0; i < p.count; i++) if (near(p.getX(i), 6, 0.01)) le = Math.min(le, p.getZ(i));
  ok('leading edge sweeps at the measured 0.638 per metre', near(le + 3.7, 0.638 * 6, 0.05), `a=${(le + 3.7).toFixed(3)} at x=6`);
}
ok('no NaN in any vertex', bad === 0, `${bad} bad floats`);
ok('cheap enough for a world drone', tris < 4000, `${tris} triangles`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
