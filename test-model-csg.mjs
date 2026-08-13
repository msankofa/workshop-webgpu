// node test-model-csg.mjs
//
// Covers the BSP booleans (model-csg.js). A boolean either produces a closed solid of the right
// volume or it does not, and neither triangle counts nor a screenshot would tell you which — so
// every assertion here is a signed-volume check against a number computed by hand.

import * as THREE from 'three';
import { csgOp, signedVolume, polygonsFromGeometry, CSG_OPS } from './model-csg.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name); }
}
function near(a, b, tol, name) { ok(Math.abs(a - b) <= tol, `${name} (got ${a.toFixed(5)}, want ~${b.toFixed(5)})`); }

const box = (w, h, d, at = [0, 0, 0]) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(at[0], at[1], at[2]);
  return g;
};

// ---- the volume helper itself, before anything relies on it ----
{
  near(signedVolume(box(1, 1, 1)), 1, 1e-6, 'unit box has volume 1 with outward winding');
  near(signedVolume(box(2, 1, 0.5)), 1, 1e-6, 'volume scales with the box');
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 2, 64);
  near(signedVolume(cyl), Math.PI * 0.25 * 2, 5e-3, 'cylinder volume matches pi r^2 h');
}

// ---- subtract ----
{
  // A cutter fully inside leaves a cavity, so the solid loses exactly the cutter's volume.
  const r = csgOp(THREE, 'subtract', box(1, 1, 1), box(0.5, 0.5, 0.5));
  near(signedVolume(r), 1 - 0.125, 1e-4, 'subtracting an enclosed cube hollows out its volume');

  // A cutter crossing a face is the real case: a magazine well, a vent, an eye socket.
  const notch = csgOp(THREE, 'subtract', box(1, 1, 1), box(0.4, 0.4, 2));
  near(signedVolume(notch), 1 - 0.16, 1e-4, 'a through-cut removes a full square bore');

  const hole = csgOp(THREE, 'subtract', box(1, 1, 1), new THREE.CylinderGeometry(0.25, 0.25, 2, 64));
  near(signedVolume(hole), 1 - Math.PI * 0.0625, 5e-3, 'a drilled round hole removes pi r^2 h');
  ok(polygonsFromGeometry(hole).length > polygonsFromGeometry(box(1, 1, 1)).length,
    'the cut costs triangles, which is why the budget gate runs after CSG');

  // A cutter that misses must be a no-op, not a corruption.
  const miss = csgOp(THREE, 'subtract', box(1, 1, 1), box(0.5, 0.5, 0.5, [5, 0, 0]));
  near(signedVolume(miss), 1, 1e-4, 'a cutter that misses leaves the solid intact');
}

// ---- union and intersect ----
{
  const u = csgOp(THREE, 'union', box(1, 1, 1), box(1, 1, 1, [0.5, 0, 0]));
  near(signedVolume(u), 1.5, 1e-4, 'union of two half-overlapping cubes is 1.5');

  const i = csgOp(THREE, 'intersect', box(1, 1, 1), box(1, 1, 1, [0.5, 0, 0]));
  near(signedVolume(i), 0.5, 1e-4, 'intersection of the same pair is 0.5');

  const disjoint = csgOp(THREE, 'union', box(1, 1, 1), box(1, 1, 1, [5, 0, 0]));
  near(signedVolume(disjoint), 2, 1e-4, 'union of disjoint solids keeps both');
}

// ---- output shape and contract ----
{
  const r = csgOp(THREE, 'subtract', box(1, 1, 1), box(0.4, 0.4, 2));
  ok(r.attributes.position && r.attributes.normal, 'result carries position and normal');
  ok(r.index === null, 'result is non-indexed, as the BSP produces independent polygons');
  // UVs do not survive a boolean. Recorded as a test so a target that needs them finds out here.
  ok(!r.attributes.uv, 'no UVs survive a boolean');

  let threw = false;
  try { csgOp(THREE, 'nonsense', box(1, 1, 1), box(1, 1, 1)); } catch { threw = true; }
  ok(threw, 'an unknown op throws rather than silently returning the input');
  ok(CSG_OPS.length === 3, 'three ops are declared');
}

// ---- inputs are not consumed ----
{
  const a = box(1, 1, 1), b = box(0.5, 0.5, 0.5);
  const before = a.attributes.position.count;
  csgOp(THREE, 'subtract', a, b);
  ok(a.attributes.position.count === before, 'the input geometry is left alone');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
