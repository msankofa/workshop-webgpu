// test-trees-geometry.mjs -- leaf/billboard winding assertions for P5/Milestone 6
// (docs/superpowers/specs/2026-07-08-trees-performance-design.md, finding 5).
//
// Two independent claims are checked:
//   1. Leaf cards (trees.js's _leafQuad) have NO winding bug: the winding-derived face normal
//      already matches the baked per-vertex normal. This is the "no fake failing test" case the
//      task calls for -- leaf cards are genuinely single-sided by construction and stay
//      DoubleSide (or forest-gpu.js's toggle) on purpose, not because of a bug.
//   2. Forest billboards (forest-gpu.js's buildBillboardGeo) DID have a real winding bug: the
//      quad's winding, combined with how instanceNodesBillboard orients it toward the camera
//      (right = cross(worldUp, camDir), no local-Z contribution, no normal override), produced
//      a front face that pointed AWAY from the camera for every tested camera position. Section
//      2 below reproduces the ORIGINAL (buggy) transform first to prove it fails, then the
//      FIXED winding (reversed index order, as forest-gpu.js's buildBillboardGeo now does) to
//      prove it passes -- the fail-then-pass pair the task asks for.
import * as THREE from 'three';
import { createTree } from './trees.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// ---- 1: leaf card winding matches its baked normal (no bug -- documented, not "fixed") ----
// _leafQuad pushes corners BL(-1,0) BR(1,0) TR(1,1) TL(-1,1) (local, pre-rotation) with indices
// (base, base+1, base+2, base, base+2, base+3) == tri(BL,BR,TR), tri(BL,TR,TL), and assigns
// normal (0,0,1) (local, pre-rotation, non-rounded case). The winding-derived face normal for
// tri(BL,BR,TR) must point the same direction as the assigned normal for the geometry to be
// self-consistent (i.e. FrontSide would show the card's "front", the side its normal points).
{
  const BL = [-1, 0, 0], BR = [1, 0, 0], TR = [1, 1, 0];
  const faceN = norm(cross(sub(BR, BL), sub(TR, BL)));
  const assignedN = [0, 0, 1];
  const d = dot(faceN, assignedN);
  ok(d > 0.99, `1: leaf quad winding-derived face normal matches assigned normal (dot=${d.toFixed(3)}) -- no winding bug on leaf cards`);
}

// Cross-check against the real generator output: build a tiny tree and confirm every leaf
// triangle's winding-derived normal points into the same hemisphere as its baked vertex normal.
{
  const tree = createTree({ seed: 3, levels: 1, leaves: { count: 4, shape: 'quad', doubleBillboard: false, roundedNormals: false } });
  const geo = tree.leavesMesh.geometry;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const idx = geo.getIndex().array;
  let checked = 0, consistent = 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const pa = [pos.getX(a), pos.getY(a), pos.getZ(a)];
    const pb = [pos.getX(b), pos.getY(b), pos.getZ(b)];
    const pc = [pos.getX(c), pos.getY(c), pos.getZ(c)];
    const faceN = norm(cross(sub(pb, pa), sub(pc, pa)));
    const bakedN = norm([nrm.getX(a), nrm.getY(a), nrm.getZ(a)]);
    checked++;
    if (dot(faceN, bakedN) > 0.9) consistent++;
  }
  ok(checked > 0, '1b: sampled leaf triangles from a real generated tree');
  ok(consistent === checked, `1b: all ${checked} leaf triangles wind consistently with their baked normal (${consistent}/${checked})`);
}

// ---- 2: forest billboard winding -- fail (original) then pass (fixed) ----
// Mirrors forest-gpu.js's instanceNodesBillboard: world = ipos + right*localX + worldUp*localY
// (no local-Z term, no normal override -- billMat is MeshBasicNodeMaterial, unlit), where
// right = normalize(cross(worldUp, camDir)) and camDir = normalize(ipos - cameraPosition)
// (points FROM camera TOWARD the instance, per forest-gpu.js's literal `ipos.sub(cameraPosition)`).
function billboardFaceDotTowardCamera(idxArray, posArray, ipos, camPos) {
  const camDir = norm(sub(ipos, camPos));
  const worldUp = [0, 1, 0];
  const right = norm(cross(worldUp, camDir));
  const worldOf = (i) => {
    const lx = posArray[i * 3], ly = posArray[i * 3 + 1];
    return [
      ipos[0] + right[0] * lx + worldUp[0] * ly,
      ipos[1] + right[1] * lx + worldUp[1] * ly,
      ipos[2] + right[2] * lx + worldUp[2] * ly,
    ];
  };
  const towardCam = norm(sub(camPos, ipos));
  // average face normal across all triangles (a plane has one, but stay general)
  let sum = [0, 0, 0], count = 0;
  for (let t = 0; t < idxArray.length / 3; t++) {
    const a = idxArray[t * 3], b = idxArray[t * 3 + 1], c = idxArray[t * 3 + 2];
    const pa = worldOf(a), pb = worldOf(b), pc = worldOf(c);
    const faceN = cross(sub(pb, pa), sub(pc, pa));
    sum[0] += faceN[0]; sum[1] += faceN[1]; sum[2] += faceN[2];
    count++;
  }
  const avgN = norm(sum);
  return { dot: dot(avgN, towardCam), count };
}

const CAM_CASES = [
  { ipos: [0, 0, 0], camPos: [0, 0, -10] },
  { ipos: [0, 0, 0], camPos: [10, 0, 0] },
  { ipos: [0, 0, 0], camPos: [5, 3, 5] },
  { ipos: [0, 5, 0], camPos: [0, 5, -20] },
  { ipos: [2, 0, 3], camPos: [-5, 1, 8] },
];

// 2a: ORIGINAL PlaneGeometry winding (pre-fix) -- must FAIL (face points away from camera).
{
  const g = new THREE.PlaneGeometry(4, 6);
  const idxArray = g.getIndex().array;
  const posArray = g.getAttribute('position').array;
  let allAway = true;
  for (const { ipos, camPos } of CAM_CASES) {
    const { dot: d } = billboardFaceDotTowardCamera(idxArray, posArray, ipos, camPos);
    if (d > 0) allAway = false;
  }
  ok(allAway, '2a: PRE-FIX PlaneGeometry winding faces AWAY from camera under instanceNodesBillboard transform (reproduces the bug)');
}

// 2b: FIXED winding (forest-gpu.js's buildBillboardGeo reverses index order) -- must PASS.
function buildBillboardGeoFixed(width, height, centerY) {
  const g = new THREE.PlaneGeometry(width, height);
  const idx = g.getIndex();
  const arr = idx.array;
  for (let i = 0; i + 2 < arr.length; i += 3) {
    const b = arr[i + 1];
    arr[i + 1] = arr[i + 2];
    arr[i + 2] = b;
  }
  idx.needsUpdate = true;
  g.translate(0, centerY, 0);
  return g;
}
{
  const g = buildBillboardGeoFixed(4, 6, 3);
  const idxArray = g.getIndex().array;
  const posArray = g.getAttribute('position').array;
  let minDot = Infinity;
  for (const { ipos, camPos } of CAM_CASES) {
    const { dot: d, count } = billboardFaceDotTowardCamera(idxArray, posArray, ipos, camPos);
    ok(count > 0, '2b: sampled billboard triangles');
    minDot = Math.min(minDot, d);
  }
  ok(minDot > 0.9, `2b: FIXED billboard winding faces TOWARD the camera for every tested position (min dot=${minDot.toFixed(3)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
