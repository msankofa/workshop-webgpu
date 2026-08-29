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

// ---- 3: option merge keeps THREE.Texture instances intact ----
// merge() used to recurse into any object, so a Texture on both sides (bark.map in the viewer's
// 'authored' texture mode) came out as a prototype-less copy of its own properties. It still had
// isTexture === true, so TSL accepted it and the WebGPU sampler binding then crashed on
// texture.addEventListener. Class instances must replace wholesale, not merge key-by-key.
{
  const tex = new THREE.Texture();
  const tree = createTree({ seed: 3, levels: 1, bark: { map: tex, normalMap: tex }, leaves: { map: tex } });
  ok(tree.options.bark.map === tex, '3: bark.map survives merge as the same Texture instance');
  ok(tree.options.bark.normalMap === tex, '3: bark.normalMap survives merge');
  ok(tree.options.leaves.map === tex, '3: leaves.map survives merge');
  tree.regenerate({ bark: { map: tex }, leaves: { map: tex } });
  ok(tree.options.bark.map === tex, '3: bark.map survives a second merge via regenerate()');
  ok(typeof tree.options.leaves.map.addEventListener === 'function', '3: merged map is still a real Texture');
  tree.dispose();
}

// ---- 4: branch tubes are closed at every end that can be seen ----
// The tube used to be skinned with side quads only, and only a branch at the exact depth limit
// pinched its tip shut. Everything else -- the trunk above all, at ~30% of its base radius under
// the families' usual taper -- ended as an open pipe, and the bark material is FrontSide, so you
// looked straight through it into nothing. Two independent closures fix that: every TERMINAL
// branch pinches to a point, and whatever is left wide (trunk and intermediate tips, plus the
// trunk's base) gets a cap fan.
const SEG0 = 8, SEG1 = 6, SEC0 = 4, SEC1 = 3;
const STRAIGHT = {
  seed: 5, length: [10, 4], radius: [1, 0.3], taper: [0.5, 0.5],
  sections: [SEC0, SEC1], segments: [SEG0, SEG1], branchStart: [0, 0], angle: [0, 60],
  gnarliness: [0, 0], twist: [0, 0], force: { direction: [0, 1, 0], strength: 0 },
  leaves: { enabled: false },
};

// Boundary edges = used by exactly one triangle, keyed by POSITION so the tube's duplicated
// UV-seam vertices merge instead of reading as holes. Returns each hole edge's length too,
// which is what separates a real opening from the pinch point at a tapered-to-nothing tip.
function openEdges(geo) {
  const pos = geo.getAttribute('position'), idx = geo.getIndex().array;
  const key = i => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const ids = new Map(), vid = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    if (!ids.has(k)) ids.set(k, ids.size);
    vid.push(ids.get(k));
  }
  const seen = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [vid[idx[t]], vid[idx[t + 1]], vid[idx[t + 2]]];
    const raw = [idx[t], idx[t + 1], idx[t + 2]];
    for (let e = 0; e < 3; e++) {
      const p = tri[e], q = tri[(e + 1) % 3];
      if (p === q) continue; // a pinched tip collapses its ring into degenerate edges
      const k = p < q ? `${p}|${q}` : `${q}|${p}`;
      const rec = seen.get(k);
      if (rec) rec.n++;
      else {
        const a = raw[e], b = raw[(e + 1) % 3];
        seen.set(k, {
          n: 1,
          len: Math.hypot(pos.getX(a) - pos.getX(b), pos.getY(a) - pos.getY(b), pos.getZ(a) - pos.getZ(b)),
        });
      }
    }
  }
  const out = [];
  for (const rec of seen.values()) if (rec.n === 1) out.push(rec.len);
  return out;
}

{
  // 4a: a lone terminal branch. Its base is capped and its tip pinches, so the only opening left
  // is the pinch itself -- one ring of edges too short to see rather than a hole 30% as wide as
  // the trunk. `children: [0]` makes the trunk terminal WITHOUT being at the depth limit, which
  // is precisely the case the old `level === levels` test missed.
  const tree = createTree({ ...STRAIGHT, levels: 2, children: [0, 0] });
  const holes = openEdges(tree.branchesMesh.geometry);
  const widest = holes.length ? Math.max(...holes) : 0;
  ok(holes.length === SEG0, `4a: a terminal branch leaves only its pinch ring open (${holes.length} edges, want ${SEG0})`);
  ok(widest < 0.01, `4a: and that ring is a point, not a hole (widest opening ${widest.toFixed(5)} vs a 0.5 trunk tip before)`);
  tree.dispose();
}

{
  // 4b: trunk with children, so the trunk itself is NOT terminal and keeps a wide tip. Both its
  // ends are capped, so every remaining opening belongs to a child: its pinched tip, and its base
  // ring, which is always buried inside the parent (child radius is capped at 0.85 of the
  // parent's at the attachment point, and it is centred on the parent's axis).
  const COUNT = 4;
  const tree = createTree({ ...STRAIGHT, levels: 1, children: [COUNT] });
  const holes = openEdges(tree.branchesMesh.geometry);
  ok(holes.length === COUNT * 2 * SEG1,
    `4b: the trunk contributes no opening; only the ${COUNT} children's pinch and buried base rings remain (${holes.length}, want ${COUNT * 2 * SEG1})`);
  tree.dispose();
}

{
  // 4c: cap fans wind with their normals, same claim as section 1b but for the branch mesh. Run on
  // a tree with no gnarliness: a wandering tube makes its own quads non-planar, and those would
  // mask whether the caps themselves are right.
  const tree = createTree({ ...STRAIGHT, levels: 1, children: [4] });
  const geo = tree.branchesMesh.geometry;
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal'), idx = geo.getIndex().array;
  let checked = 0, consistent = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const pa = [pos.getX(a), pos.getY(a), pos.getZ(a)];
    const pb = [pos.getX(b), pos.getY(b), pos.getZ(b)];
    const pc = [pos.getX(c), pos.getY(c), pos.getZ(c)];
    const raw = cross(sub(pb, pa), sub(pc, pa));
    if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-9) continue; // degenerate at a pinched tip
    checked++;
    // Same hemisphere, not the near-exact match section 1b can demand of a flat leaf card: a
    // tapered tube's face normal tilts toward the axis by the taper angle while the baked vertex
    // normal stays radial, which on these steep test children is already a 31 degree gap.
    if (dot(norm(raw), norm([nrm.getX(a), nrm.getY(a), nrm.getZ(a)])) > 0) consistent++;
  }
  ok(checked > 0, '4c: sampled branch triangles from a real generated tree');
  ok(consistent === checked, `4c: every branch triangle, cap fans included, winds with its baked normal (${consistent}/${checked})`);
  tree.dispose();
}

{
  // 4d: a cap costs one ring of vertices plus a centre, and one triangle per side. Asserted
  // because the vertex layout is load-bearing for test-tree-presets.mjs section 5.
  const bare = createTree({ ...STRAIGHT, levels: 2, children: [0, 0] });   // terminal: base cap only
  const kids = createTree({ ...STRAIGHT, levels: 1, children: [1] });      // non-terminal: both ends
  const vOf = t => t.branchesMesh.geometry.getAttribute('position').count;
  const tOf = t => t.branchesMesh.geometry.getIndex().count / 3;
  const wall0 = (SEC0 + 1) * (SEG0 + 1), wall1 = (SEC1 + 1) * (SEG1 + 1);
  ok(vOf(bare) === wall0 + (SEG0 + 1), `4d: one cap adds ${SEG0 + 1} vertices (got ${vOf(bare) - wall0})`);
  ok(tOf(bare) === SEC0 * SEG0 * 2 + SEG0, `4d: one cap adds ${SEG0} triangles (got ${tOf(bare) - SEC0 * SEG0 * 2})`);
  ok(vOf(kids) === wall0 + 2 * (SEG0 + 1) + wall1, '4d: a non-terminal trunk carries two caps, its children none');
  bare.dispose(); kids.dispose();
}

{
  // 4e: optional branch LOD streams must only simplify the emitted skin. They may not perturb
  // the full mesh or consume RNG that would move leaf cards and cause visible LOD popping.
  const opts = { seed: 0x51a7, levels: 2 };
  const baseline = createTree(opts);
  const lod = createTree({
    ...opts,
    branchLods: [
      { sectionStride: 2, segmentScale: 0.67 },
      { sectionStride: 3, segmentScale: 0.5 },
    ],
  });
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  const arrayOf = (geo, name) => Array.from(geo.getAttribute(name).array);
  const indicesOf = geo => Array.from(geo.getIndex().array);
  ok(lod.branchLodGeometries.length === 2, '4e: requesting two branch LODs emits two geometries');
  const fullTris = lod.branchesMesh.geometry.getIndex().count / 3;
  const lod1Tris = lod.branchLodGeometries[0].getIndex().count / 3;
  const lod2Tris = lod.branchLodGeometries[1].getIndex().count / 3;
  ok(fullTris > lod1Tris && lod1Tris > lod2Tris,
    `4e: branch triangle cost falls at each rung (${fullTris}/${lod1Tris}/${lod2Tris})`);
  ok(same(arrayOf(baseline.branchesMesh.geometry, 'position'), arrayOf(lod.branchesMesh.geometry, 'position'))
    && same(indicesOf(baseline.branchesMesh.geometry), indicesOf(lod.branchesMesh.geometry)),
    '4e: enabling branch LODs leaves the full branch mesh unchanged');
  ok(same(arrayOf(baseline.leavesMesh.geometry, 'position'), arrayOf(lod.leavesMesh.geometry, 'position'))
    && same(indicesOf(baseline.leavesMesh.geometry), indicesOf(lod.leavesMesh.geometry)),
    '4e: enabling branch LODs leaves leaf placement unchanged');
  baseline.dispose(); lod.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
