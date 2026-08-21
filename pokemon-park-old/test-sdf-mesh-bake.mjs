// Node checks for converting the mesh itself into a distance field, rather than fitting shapes to it.
// Run with `node test-sdf-mesh-bake.mjs`. No GPU: the shader goes through `tsl-build-check.mjs`.

import fs from 'node:fs';
import { STADIUM_REFERENCE_SPECIES } from './stadium-reference-species.js';
import { MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { buildMaterial } from './tsl-build-check.mjs';
import { parseGLB, nodeWorldMatrices } from './stadium-glb.js';
import {
  skinnedTriangles, normaliseTriangles, trianglesByBone, insideField, insideAt,
  bakeTile, tileExtent, triDist2, meshVolume, toHalf, fromHalf, baryOfClosest, sampleImage,
} from './demos/sdf-mesh-bake.js';
import {
  bake, bakeVolume, createField, upload, uploadVolume,
  TILE_RES, TILE_PAD, SIGN_RES, MAX_BONES, STRIDE, ATLAS_W, ATLAS_H, ATLAS_D,
} from './demos/sdf-pikachu-field.js';

let failures = 0;
const results = [];
const notes = [];
async function check(name, fn) {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const load = (n) => parseGLB(fs.readFileSync(`models/stadium/${n}.glb`));
// The set this spike was built against; the directory now holds all 151.
const MODELS = STADIUM_REFERENCE_SPECIES;

/** The tile read the way the shader reads it: trilinear, in the box's own frame. */
function sampleTile(cube, res, box, half, x, y, z) {
  const d = [x - box.center[0], y - box.center[1], z - box.center[2]];
  const f = [0, 1, 2].map((a) => {
    const proj = box.axes[a][0] * d[0] + box.axes[a][1] * d[1] + box.axes[a][2] * d[2];
    return Math.min(res - 1, Math.max(0, (proj / half[a] * 0.5 + 0.5) * (res - 1)));
  });
  const i0 = f.map((v) => Math.min(res - 2, Math.floor(v)));
  const t = f.map((v, a) => v - i0[a]);
  let out = 0;
  for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const w = (i ? t[0] : 1 - t[0]) * (j ? t[1] : 1 - t[1]) * (k ? t[2] : 1 - t[2]);
    out += w * cube[((i0[2] + k) * res + (i0[1] + j)) * res + (i0[0] + i)];
  }
  return out;
}

// ===================== the pieces =====================

await check('distance to a triangle is right in every case of the split', () => {
  const T = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const d = (x, y, z) => Math.sqrt(triDist2(x, y, z, ...T));
  assert(Math.abs(d(0.25, 0.25, 0.7) - 0.7) < 1e-12, 'straight above the face');
  assert(Math.abs(d(0, 0, 0)) < 1e-12, 'on vertex A');
  assert(Math.abs(d(-1, 0, 0) - 1) < 1e-12, 'past vertex A');
  assert(Math.abs(d(0.5, -0.5, 0) - 0.5) < 1e-12, 'off edge AB');
  assert(Math.abs(d(-0.5, 0.5, 0) - 0.5) < 1e-12, 'off edge AC');
  // Off the hypotenuse, which is the case that reads B as its origin and is the easy one to sign wrong.
  assert(Math.abs(d(1, 1, 0) - Math.SQRT1_2) < 1e-12, `off edge BC, got ${d(1, 1, 0)}`);
  assert(Math.abs(d(0.25, 0.25, -0.7) - 0.7) < 1e-12, 'below the face');
});

await check('half floats round-trip to their own precision', () => {
  for (const v of [0, 0.03, -0.03, 1, -1, 0.0001, -0.5, 4, 0.333]) {
    const back = fromHalf(toHalf(v));
    assert(Math.abs(back - v) <= Math.max(6e-4, Math.abs(v) * 1e-3), `${v} came back as ${back}`);
  }
  assert(fromHalf(toHalf(0)) === 0, 'zero did not survive');
});

await check('every triangle lands on bones the rig already knows about', () => {
  const { json, bin } = load('025_pikachu');
  const ctx = nodeWorldMatrices(json);
  const tris = skinnedTriangles(json, bin, ctx);
  assert(tris.count > 100, `only ${tris.count} triangles`);
  const known = new Set(bake(json, bin).bones.map((b) => b.pivot));
  const byBone = trianglesByBone(tris);
  for (const pivot of byBone.keys()) assert(known.has(pivot) || pivot == null, `bone ${pivot} is not in the bake`);
  let covered = 0;
  for (const p of known) if (byBone.get(p)?.length) covered++;
  assert(covered >= known.size - 1, `${known.size - covered} of ${known.size} bones got no triangles`);
});

// ===================== inside and outside =====================

/** A closed, outward-wound box as a triangle soup, for testing the sign rule on known geometry. */
function boxSoup(cx, cy, cz, h) {
  const v = [];
  for (let i = 0; i < 8; i++) {
    v.push([cx + (i & 1 ? h : -h), cy + (i & 2 ? h : -h), cz + (i & 4 ? h : -h)]);
  }
  const quads = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  const xyz = [], owners = [];
  for (const [a, b, c, d] of quads) {
    for (const t of [[a, b, c], [a, c, d]]) {
      for (const i of t) xyz.push(...v[i]);
      owners.push([0, 0, 0]);
    }
  }
  return { xyz: Float64Array.from(xyz), owners, count: owners.length };
}

await check('two solids that interpenetrate stay solid where they overlap', () => {
  // This is the case ray parity gets wrong: four crossings through the overlap reads as even, so parity
  // calls the middle of the join empty. These models are built this way — a limb pushed into a torso.
  const a = boxSoup(-0.15, 0.5, 0, 0.3);
  const b = boxSoup(0.15, 0.5, 0, 0.3);
  const both = {
    xyz: Float64Array.from([...a.xyz, ...b.xyz]),
    owners: [...a.owners, ...b.owners],
    count: a.count + b.count,
  };
  const field = insideField(both, [-0.7, -0.2, -0.7], [0.7, 1.2, 0.7], 48);
  assert(insideAt(field, 0, 0.5, 0), 'the overlap of the two boxes reads as empty');
  assert(insideAt(field, -0.3, 0.5, 0), 'the far side of the first box reads as empty');
  assert(insideAt(field, 0.3, 0.5, 0), 'the far side of the second box reads as empty');
  assert(!insideAt(field, 0, 0.5, 0.5), 'the air beside the boxes reads as solid');
  // The union, not the sum: counting each box whole would give 0.432.
  assert(Math.abs(field.volume - 0.324) < 0.03, `the union came out at ${field.volume.toFixed(3)}, not 0.324`);
});

await check('how much of each skin is thick enough for the grid to find an inside under it', () => {
  // Not everything is: a Charizard wing is thinner than a grid cell, so no voxel under it ever reads solid
  // and its field never quite reaches zero. Measured at four resolutions it climbs 56 - 59 - 66 - 73%, which
  // is what a thinness limit looks like rather than a wrong rule; the shader's thickness knob covers the
  // rest by pushing the surface outward. What this check is really guarding is a species going broadly wrong.
  const worst = [];
  for (const m of MODELS) {
    const { json, bin } = load(m);
    const baked = bake(json, bin);
    const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.count * 3; i++) for (let a = 0; a < 3; a++) {
      const v = tris.xyz[i * 3 + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
    for (let a = 0; a < 3; a++) { lo[a] -= 0.02; hi[a] += 0.02; }
    const res = 64;
    const field = insideField(tris, lo, hi, res);
    const step = Math.max(...field.cell) * 1.5;

    let hits = 0, tried = 0;
    for (let t = 0; t < tris.count; t += Math.max(1, Math.floor(tris.count / 200))) {
      const o = t * 9;
      const ux = tris.xyz[o + 3] - tris.xyz[o], uy = tris.xyz[o + 4] - tris.xyz[o + 1], uz = tris.xyz[o + 5] - tris.xyz[o + 2];
      const vx = tris.xyz[o + 6] - tris.xyz[o], vy = tris.xyz[o + 7] - tris.xyz[o + 1], vz = tris.xyz[o + 8] - tris.xyz[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      const cx = (tris.xyz[o] + tris.xyz[o + 3] + tris.xyz[o + 6]) / 3;
      const cy = (tris.xyz[o + 1] + tris.xyz[o + 4] + tris.xyz[o + 7]) / 3;
      const cz = (tris.xyz[o + 2] + tris.xyz[o + 5] + tris.xyz[o + 8]) / 3;
      tried++;
      if (insideAt(field, cx - nx / len * step, cy - ny / len * step, cz - nz / len * step)) hits++;
    }
    worst.push([m, hits / tried, tried]);
  }
  worst.sort((a, b) => a[1] - b[1]);
  notes.push(`  a step under the skin lands inside: worst ${worst[0][0]} at ${(worst[0][1] * 100).toFixed(0)}%, `
    + `best ${worst[worst.length - 1][0]} at ${(worst[worst.length - 1][1] * 100).toFixed(0)}%`);
  assert(worst[0][1] > 0.5, `${worst[0][0]} only reads inside ${(worst[0][1] * 100).toFixed(0)}% of the time`);
  const median = worst[Math.floor(worst.length / 2)][1];
  assert(median > 0.9, `the median species is only ${(median * 100).toFixed(0)}% solid under its own skin`);
});

await check('how much of the model the sign fill claims, against what the triangles enclose', () => {
  // Reported rather than asserted tightly: the divergence-theorem volume counts interpenetrating parts
  // twice over, and the fill counts their union once, so these two are not meant to be equal.
  const rows = [];
  for (const m of MODELS) {
    const { json, bin } = load(m);
    const baked = bake(json, bin);
    const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
    const field = insideField(tris, [-0.8, -0.1, -0.8], [0.8, 1.1, 0.8], 64);
    const sum = Math.abs(meshVolume(tris));
    rows.push([m, field.volume / sum]);
    assert(field.volume > 0, `${m}: the sign fill found nothing inside at all`);
    assert(field.volume <= sum * 1.2, `${m}: the fill claims ${(field.volume / sum).toFixed(2)}x the enclosed volume`);
  }
  rows.sort((a, b) => a[1] - b[1]);
  notes.push(`  union as a share of the summed parts: ${(rows[0][1] * 100).toFixed(0)}% (${rows[0][0]}) to `
    + `${(rows[rows.length - 1][1] * 100).toFixed(0)}% (${rows[rows.length - 1][0]})`);
});

await check('the inside grid puts the middle of the model in and the air out', () => {
  const { json, bin } = load('025_pikachu');
  const baked = bake(json, bin);
  const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
  const lo = [-0.6, -0.05, -0.6], hi = [0.6, 1.05, 0.6];
  const field = insideField(tris, lo, hi, 64);
  assert(!insideAt(field, 0.5, 0.9, 0.5), 'a corner of the empty air reads as inside');
  assert(!insideAt(field, 0, 1.2, 0), 'a point over the head reads as inside');
  let inCount = 0;
  for (let i = 0; i < 40; i++) if (insideAt(field, 0, 0.15 + i * 0.02, 0)) inCount++;
  assert(inCount > 8, `the model's own centre line is inside for only ${inCount} of 40 samples`);
});

// ===================== the tile =====================

await check('a tile reads zero on the skin it was baked from', () => {
  const { json, bin } = load('025_pikachu');
  const baked = bake(json, bin);
  const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
  const byBone = trianglesByBone(tris);
  const lo = [-0.7, -0.1, -0.7], hi = [0.7, 1.1, 0.7];
  const inside = insideField(tris, lo, hi, SIGN_RES);

  let checked = 0, worst = 0;
  for (const bone of baked.bones.slice(0, 6)) {
    const triIdx = byBone.get(bone.pivot);
    if (!triIdx?.length) continue;
    const half = tileExtent(tris, triIdx, bone.box, TILE_PAD);
    const cube = bakeTile(tris, triIdx, bone.box, { res: TILE_RES, half, inside }).dist;
    // Trilinear over a field that is 1-Lipschitz cannot stray further from zero than one voxel diagonal.
    const voxel = Math.hypot(...half.map((h) => 2 * h / (TILE_RES - 1)));
    for (const t of triIdx.slice(0, 12)) {
      for (let k = 0; k < 3; k++) {
        const o = t * 9 + k * 3;
        const v = sampleTile(cube, TILE_RES, bone.box, half, tris.xyz[o], tris.xyz[o + 1], tris.xyz[o + 2]);
        worst = Math.max(worst, Math.abs(v) / voxel);
        assert(Math.abs(v) <= voxel * 1.02, `a vertex reads ${v.toFixed(4)} against a voxel of ${voxel.toFixed(4)}`);
        checked++;
      }
    }
  }
  assert(checked > 50, `only ${checked} vertices were checked`);
  notes.push(`  worst reading on the skin: ${(worst * 100).toFixed(0)}% of one voxel, over ${checked} vertices`);
});

await check('no voxel on a tile boundary is nearer the skin than the pad', () => {
  // The shader answers "past the tile" analytically, as the distance to the tile plus the pad, and never
  // samples out there. That is only a lower bound if the tile really does hold all of its own triangles.
  const { json, bin } = load('025_pikachu');
  const baked = bake(json, bin);
  const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
  const byBone = trianglesByBone(tris);
  const inside = insideField(tris, [-0.7, -0.1, -0.7], [0.7, 1.1, 0.7], SIGN_RES);
  let tiles = 0;
  for (const bone of baked.bones.slice(0, 8)) {
    const triIdx = byBone.get(bone.pivot);
    if (!triIdx?.length) continue;
    const half = tileExtent(tris, triIdx, bone.box, TILE_PAD);
    const cube = bakeTile(tris, triIdx, bone.box, { res: TILE_RES, half, inside }).dist;
    const R = TILE_RES;
    for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      if (i && j && k && i < R - 1 && j < R - 1 && k < R - 1) continue;
      const v = Math.abs(cube[(k * R + j) * R + i]);
      assert(v >= TILE_PAD - 1e-6, `a boundary voxel is ${v.toFixed(4)} from the skin, under the ${TILE_PAD} pad`);
    }
    tiles++;
  }
  assert(tiles >= 5, `only ${tiles} tiles were checked`);
});

await check('a tile actually carries a sign — its interior goes negative', () => {
  const { json, bin } = load('025_pikachu');
  const baked = bakeVolume(json, bin);
  let signed = 0;
  const R = baked.tiles.res;
  for (let b = 0; b < baked.bones.length; b++) {
    const { col, row, tris } = baked.bones[b].tile;
    if (!tris) continue;
    let neg = false;
    for (let k = 0; k < R && !neg; k++) for (let j = 0; j < R && !neg; j++) for (let i = 0; i < R; i++) {
      const idx = (k * (ATLAS_H) + (row * R + j)) * ATLAS_W + (col * R + i);
      if (fromHalf(baked.tiles.data[idx]) < 0) { neg = true; break; }
    }
    if (neg) signed++;
  }
  notes.push(`  ${signed} of ${baked.bones.length} Pikachu tiles have an inside`);
  assert(signed > baked.bones.length * 0.6, `only ${signed} of ${baked.bones.length} tiles found an inside`);
});

await check('every species bakes a volume, and the atlas has room for all of it', () => {
  const rows = [];
  for (const m of MODELS) {
    const t0 = Date.now();
    const { json, bin } = load(m);
    const baked = bakeVolume(json, bin);
    const ms = Date.now() - t0;
    assert(baked.bones.length <= MAX_BONES, `${m}: ${baked.bones.length} bones past the cap`);
    assert(baked.tiles.data.length === ATLAS_W * ATLAS_H * ATLAS_D, `${m}: the atlas is the wrong size`);
    for (const b of baked.bones) {
      assert(b.tile.col < 12 && b.tile.row < 8, `${m}: a tile fell outside the atlas`);
      assert(b.tile.half.every((h) => h >= TILE_PAD && Number.isFinite(h)), `${m}: a tile extent is bad`);
      assert(Math.hypot(...b.tile.half) <= b.sphere + 1e-9, `${m}: a tile pokes out of its own skip sphere`);
    }
    rows.push([m, baked.bones.length, baked.emptyTiles, ms, baked.tris.count]);
  }
  const total = rows.reduce((s, r) => s + r[3], 0);
  const slow = rows.slice().sort((a, b) => b[3] - a[3])[0];
  notes.push(`  ${rows.length} species baked in ${total} ms; slowest ${slow[0]} at ${slow[3]} ms `
    + `(${slow[4]} triangles, ${slow[1]} bones)`);
  notes.push(`  atlas ${ATLAS_W}x${ATLAS_H}x${ATLAS_D} half floats = `
    + `${(ATLAS_W * ATLAS_H * ATLAS_D * 2 / 1048576).toFixed(2)} MB per model`);
});

// ===================== colour =====================

/** A stand-in for a decoded glTF image: four quadrants of flat, unmistakable colour. */
function quadrantImage(size = 32) {
  const data = new Uint8ClampedArray(size * size * 4);
  const quads = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = quads[(y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1)];
    const o = (y * size + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  return { width: size, height: size, data };
}

await check('a texel is read where the skin actually is, not averaged over the bone', () => {
  // The failure this replaces: one mean colour per bone. Pikachu's ear bone holds a black tip and a yellow
  // ear, and averaging them gives an olive ear with no tip. A bone here has to come back with more than one.
  const { json, bin } = load('025_pikachu');
  const baked = bake(json, bin);
  const tris = normaliseTriangles(skinnedTriangles(json, bin), baked.mid, baked.scale);
  const byBone = trianglesByBone(tris);
  const inside = insideField(tris, [-0.7, -0.1, -0.7], [0.7, 1.1, 0.7], SIGN_RES);
  const images = Array.from({ length: 200 }, () => quadrantImage());

  let manyColoured = 0, tested = 0;
  for (const bone of baked.bones.slice(0, 10)) {
    const triIdx = byBone.get(bone.pivot);
    if (!triIdx?.length) continue;
    const half = tileExtent(tris, triIdx, bone.box, TILE_PAD);
    const { dist, rgb } = bakeTile(tris, triIdx, bone.box, { res: TILE_RES, half, inside, images });
    assert(rgb, 'no colour came back even though images were supplied');
    const seen = new Set();
    for (let i = 0; i < dist.length; i++) {
      // Only near the surface, which is the only place the colour is ever read from.
      if (Math.abs(dist[i]) > 0.01 || rgb[i * 4 + 3] === 0) continue;
      seen.add(`${rgb[i * 4]},${rgb[i * 4 + 1]},${rgb[i * 4 + 2]}`);
    }
    assert(seen.size >= 1, `a bone came back with no colour at all near its surface`);
    if (seen.size > 1) manyColoured++;
    tested++;
  }
  notes.push(`  ${manyColoured} of ${tested} bones carry more than one colour near their surface`);
  assert(manyColoured >= tested * 0.5, `only ${manyColoured} of ${tested} bones vary in colour at all`);
});

await check('barycentric weights of the closest point are a partition, and land on the right vertex', () => {
  const out = [0, 0, 0];
  const T = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  baryOfClosest(0, 0, 0.5, ...T, out);
  assert(Math.abs(out[0] - 1) < 1e-9, `over vertex A the weights are ${out}`);
  baryOfClosest(1, 0, 0.5, ...T, out);
  assert(Math.abs(out[1] - 1) < 1e-9, `over vertex B the weights are ${out}`);
  baryOfClosest(0, 1, 0.5, ...T, out);
  assert(Math.abs(out[2] - 1) < 1e-9, `over vertex C the weights are ${out}`);
  // Clamped back onto the triangle, or a UV read outside it samples a texel from somewhere else entirely.
  for (const p of [[-2, -2, 1], [3, 3, -1], [0.3, 0.3, 0.2], [2, -1, 0]]) {
    baryOfClosest(...p, ...T, out);
    assert(out.every((w) => w >= -1e-9 && w <= 1 + 1e-9), `weights ${out} escaped the triangle at ${p}`);
    assert(Math.abs(out[0] + out[1] + out[2] - 1) < 1e-9, `weights ${out} do not sum to one`);
  }
});

await check('an untextured bake still produces a distance volume and no colour', () => {
  const { json, bin } = load('025_pikachu');
  const baked = bakeVolume(json, bin);
  assert(baked.tiles.data.length > 0, 'no distances came out');
  assert(baked.tiles.rgb === null, 'colour was invented without any images to read');
});

// ===================== how close the field lands to the mesh =====================

/** The shader's own field, on the CPU, so the surface it produces can be measured against the triangles. */
function makeField(baked, kind, { blend = 0.002, thicken = 0, round = 0.06, shrink = 1 } = {}) {
  const R = baked.tiles?.res ?? TILE_RES;
  const local = (b, x, y, z) => {
    const d = [x - b.box.center[0], y - b.box.center[1], z - b.box.center[2]];
    return [0, 1, 2].map((a) => b.box.axes[a][0] * d[0] + b.box.axes[a][1] * d[1] + b.box.axes[a][2] * d[2]);
  };
  const one = (b, x, y, z) => {
    const q = local(b, x, y, z);
    if (kind === 'boxes') {
      const rr = b.span * round + 0.0004;
      const e = q.map((v, a) => Math.abs(v) - Math.max(0, b.box.half[a] * shrink - rr));
      return Math.hypot(...e.map((v) => Math.max(v, 0))) + Math.min(Math.max(...e), 0) - rr;
    }
    const half = b.tile.half;
    const e = q.map((v, a) => Math.abs(v) - half[a]);
    const outer = Math.hypot(...e.map((v) => Math.max(v, 0))) + Math.min(Math.max(...e), 0);
    if (outer > 0) return outer + TILE_PAD - thicken;
    const f = q.map((v, a) => Math.min(R - 1, Math.max(0, (v / half[a] * 0.5 + 0.5) * (R - 1))));
    const i0 = f.map((v) => Math.min(R - 2, Math.floor(v)));
    const t = f.map((v, a) => v - i0[a]);
    let s = 0;
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const w = (i ? t[0] : 1 - t[0]) * (j ? t[1] : 1 - t[1]) * (k ? t[2] : 1 - t[2]);
      const idx = ((i0[2] + k) * ATLAS_H + (b.tile.row * R + i0[1] + j)) * ATLAS_W + (b.tile.col * R + i0[0] + i);
      s += w * fromHalf(baked.tiles.data[idx]);
    }
    return s - thicken;
  };
  return (x, y, z) => {
    let best = 12;
    for (const b of baked.bones) {
      if (kind === 'volume' && !b.tile.tris) continue;
      const lower = Math.hypot(x - b.box.center[0], y - b.box.center[1], z - b.box.center[2]) - b.sphere;
      if (lower >= best) continue;
      const d = one(b, x, y, z);
      // mix(new, running, h), matching `sminCol` — the other order returns the running value at h = 0,
      // which is the far plane, and every ray misses.
      const h = Math.min(1, Math.max(0, 0.5 + 0.5 * (d - best) / blend));
      best = d * (1 - h) + best * h - blend * h * (1 - h);
    }
    return best;
  };
}

/** Distance from a point to the nearest triangle anywhere in the model. */
function nearestSkin(tris, x, y, z) {
  let best = Infinity;
  for (let t = 0; t < tris.count; t++) {
    const o = t * 9;
    const d2 = triDist2(x, y, z,
      tris.xyz[o], tris.xyz[o + 1], tris.xyz[o + 2],
      tris.xyz[o + 3], tris.xyz[o + 4], tris.xyz[o + 5],
      tris.xyz[o + 6], tris.xyz[o + 7], tris.xyz[o + 8]);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

await check('the surface the march lands on is the mesh, to within a voxel', () => {
  // The one measurement that answers the question the spike was built for. March both fields from the same
  // rays and ask, at every hit, how far that point is from the real triangles. The boxes are a shape
  // standing in for the model; the volume is the model. This says by how much.
  const table = [];
  for (const m of ['025_pikachu', '019_rattata', '128_tauros', '006_charizard']) {
    const { json, bin } = load(m);
    const baked = bakeVolume(json, bin);
    const tris = baked.tris;
    const fields = { boxes: makeField(baked, 'boxes'), volume: makeField(baked, 'volume') };
    const errs = { boxes: [], volume: [] };

    for (let a = 0; a < 24; a++) for (let e = 0; e < 5; e++) {
      const yaw = a / 24 * Math.PI * 2, pitch = -0.3 + e * 0.25;
      const ro = [Math.sin(yaw) * Math.cos(pitch) * 2.6, 0.5 + Math.sin(pitch) * 2.6, Math.cos(yaw) * Math.cos(pitch) * 2.6];
      const len = Math.hypot(ro[0], ro[1] - 0.5, ro[2]);
      const rd = [-ro[0] / len, -(ro[1] - 0.5) / len, -ro[2] / len];
      for (const kind of ['boxes', 'volume']) {
        let t = 0.2;
        for (let s = 0; s < 400 && t < 5; s++) {
          const d = fields[kind](ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t);
          if (d < 0.0008) {
            errs[kind].push(nearestSkin(tris, ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t));
            break;
          }
          t += Math.max(d * 0.85, 0.0006);
        }
      }
    }
    const stat = (v) => {
      const s = v.slice().sort((p, q) => p - q);
      return { n: s.length, med: s[Math.floor(s.length / 2)] ?? NaN, p95: s[Math.floor(s.length * 0.95)] ?? NaN };
    };
    table.push([m, stat(errs.boxes), stat(errs.volume)]);
  }

  const voxel = 2 * 0.12 / (TILE_RES - 1);
  for (const [m, b, v] of table) {
    assert(v.n > 40, `${m}: the volume field was only hit by ${v.n} of 120 rays`);
    assert(v.med < b.med, `${m}: the volume lands ${v.med.toFixed(4)} out, no better than boxes at ${b.med.toFixed(4)}`);
    assert(v.med < 0.012, `${m}: the volume surface sits ${v.med.toFixed(4)} off the mesh`);
    notes.push(`  ${m.padEnd(14)} off the real skin — boxes ${(b.med * 100).toFixed(2)}% of height `
      + `(95th ${(b.p95 * 100).toFixed(2)}%), volume ${(v.med * 100).toFixed(2)}% (95th ${(v.p95 * 100).toFixed(2)}%)`);
  }
  notes.push(`  for scale, one voxel on a typical tile is about ${(voxel * 100).toFixed(2)}% of body height`);
});

// ===================== the shader =====================

await check('the volume path compiles, and still names its own bone index', async () => {
  const field = createField();
  const { json, bin } = load('025_pikachu');
  const baked = bakeVolume(json, bin);
  upload(field, baked);
  const bytes = uploadVolume(field, baked);
  assert(bytes === ATLAS_W * ATLAS_H * ATLAS_D * 2, `uploaded ${bytes} bytes`);
  field.u.volume.value = 1;
  const mat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  mat.fragmentNode = field.scenePass();
  const { fragment } = await buildMaterial(mat, new PlaneGeometry(2, 2));
  assert(fragment && fragment.length > 500, 'no fragment shader came out');
  assert(/boneIndex/.test(fragment), 'the bone index was not given a name of its own');
  assert(/sampler3D|texture3D|textureLod/.test(fragment), 'nothing in the shader reads the 3-D texture');
});

await check('the uniform block still has a slot for every bone after the stride grew', () => {
  const field = createField();
  assert(field.boneData.array.length === MAX_BONES * STRIDE, 'the bone array and the stride disagree');
  const { json, bin } = load('025_pikachu');
  upload(field, bake(json, bin));
  for (let i = MAX_BONES - 3; i < MAX_BONES; i++) {
    assert(field.boneData.array[i * STRIDE].y < -100, `slot ${i} is not parked`);
    assert(field.boneData.array[i * STRIDE + 6].x > 0, `slot ${i} has a zero-sized tile to divide by`);
  }
});

console.log(results.join('\n'));
if (notes.length) console.log(`\nmeasured:\n${notes.join('\n')}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
