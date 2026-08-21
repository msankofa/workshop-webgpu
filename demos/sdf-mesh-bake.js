// Turning the mesh itself into a distance field, rather than fitting shapes to it.
//
// For a grid of points around each rigid skin chunk, record the distance to the nearest triangle of that
// chunk and the sign of the whole model at that point. The result is the model, to the grid's resolution —
// no primitive vocabulary in between. Pure JS with no THREE import so Node can run all of it.

import { readAccessor, transformPoint, nodeWorldMatrices } from '../stadium-glb.js';

// ---------------------------------------------------------------------------
// Geometry off the glTF
// ---------------------------------------------------------------------------

/**
 * Every triangle of a Stadium model, posed into rest world space, with the bones each one touches.
 *
 * Rigid skinning is what makes this exact: one bone per vertex at weight 1, so a vertex is just its bone's
 * world matrix applied to the bind position. A triangle at a seam touches two bones and is handed to both,
 * which is deliberate — each chunk then closes over its own seam and the union has no crack in it.
 */
export function skinnedTriangles(json, bin, ctx = nodeWorldMatrices(json)) {
  const xyz = [];
  const uvs = [];
  const owners = [];
  const image = [];
  const p = [0, 0, 0];
  const imageOf = (mi) => {
    const tex = json.materials?.[mi]?.pbrMetallicRoughness?.baseColorTexture?.index;
    return tex == null ? -1 : (json.textures?.[tex]?.source ?? -1);
  };
  for (const node of json.nodes || []) {
    if (node.mesh == null || node.skin == null) continue;
    const joints = json.skins[node.skin].joints;
    for (const prim of json.meshes[node.mesh].primitives || []) {
      if (prim.mode != null && prim.mode !== 4) continue;
      const a = prim.attributes || {};
      if (a.POSITION == null || a.JOINTS_0 == null) continue;
      const pos = readAccessor(json, bin, a.POSITION);
      const jnt = readAccessor(json, bin, a.JOINTS_0);
      const wgt = a.WEIGHTS_0 != null ? readAccessor(json, bin, a.WEIGHTS_0) : null;
      const tex = a.TEXCOORD_0 != null ? readAccessor(json, bin, a.TEXCOORD_0) : null;
      const idx = prim.indices != null ? readAccessor(json, bin, prim.indices) : null;
      const img = imageOf(prim.material);
      const n = pos.length / 3;
      const world = new Float64Array(n * 3);
      const pivot = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        let best = 0;
        if (wgt) for (let k = 1; k < 4; k++) if (wgt[i * 4 + k] > wgt[i * 4 + best]) best = k;
        const leaf = joints[jnt[i * 4 + best]];
        transformPoint(ctx.world[leaf], pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], p);
        world[i * 3] = p[0]; world[i * 3 + 1] = p[1]; world[i * 3 + 2] = p[2];
        // Re-keyed onto the pivot that moves, matching how `boneGeometry` keys its clusters.
        pivot[i] = ctx.parent[leaf];
      }
      const len = idx ? idx.length : n;
      for (let t = 0; t + 2 < len; t += 3) {
        const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
        for (const i of [i0, i1, i2]) {
          xyz.push(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
          uvs.push(tex ? tex[i * 2] : 0, tex ? tex[i * 2 + 1] : 0);
        }
        owners.push([pivot[i0], pivot[i1], pivot[i2]]);
        image.push(img);
      }
    }
  }
  return {
    xyz: Float64Array.from(xyz), uv: Float64Array.from(uvs),
    owners, image, count: owners.length,
  };
}

/** A copy of the triangles with the model scaled to one unit tall and stood on y = 0. */
export function normaliseTriangles(tris, mid, scale) {
  const xyz = new Float64Array(tris.xyz.length);
  for (let i = 0; i < tris.count * 3; i++) {
    for (let a = 0; a < 3; a++) xyz[i * 3 + a] = (tris.xyz[i * 3 + a] - mid[a]) * scale;
  }
  return { xyz, uv: tris.uv, owners: tris.owners, image: tris.image, count: tris.count };
}

/** Which triangles belong to each bone pivot. */
export function trianglesByBone(tris) {
  const out = new Map();
  for (let t = 0; t < tris.count; t++) {
    const o = tris.owners[t];
    for (let k = 0; k < 3; k++) {
      if (k && (o[k] === o[0] || (k === 2 && o[k] === o[1]))) continue;
      let list = out.get(o[k]);
      if (!list) out.set(o[k], list = []);
      list.push(t);
    }
  }
  return out;
}

/**
 * Signed volume of the triangle soup, by the divergence theorem.
 *
 * Only meaningful on a closed, consistently wound mesh — which is exactly why it is worth computing. Held
 * against the volume the parity fill counts, it says whether the sign test can be trusted for this model.
 */
export function meshVolume(tris) {
  let v = 0;
  for (let t = 0; t < tris.count; t++) {
    const o = t * 9;
    const ax = tris.xyz[o], ay = tris.xyz[o + 1], az = tris.xyz[o + 2];
    const bx = tris.xyz[o + 3], by = tris.xyz[o + 4], bz = tris.xyz[o + 5];
    const cx = tris.xyz[o + 6], cy = tris.xyz[o + 7], cz = tris.xyz[o + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

// ---------------------------------------------------------------------------
// Distance to a triangle
// ---------------------------------------------------------------------------

/** Squared distance from a point to a triangle — the closest-point-on-triangle case split. */
export function triDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx - w * (cx - bx), qy = bpy - w * (cy - by), qz = bpz - w * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }

  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  const qx = apx - (v * abx + w * acx), qy = apy - (v * aby + w * acy), qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

/**
 * Where on a triangle the closest point falls, in barycentric coordinates, written into `out`.
 *
 * Run once per voxel for the winning triangle rather than inside the search, so it can afford to find the
 * point by projection and read the weights back off it instead of threading them through the case split.
 */
export function baryOfClosest(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const v0x = bx - ax, v0y = by - ay, v0z = bz - az;
  const v1x = cx - ax, v1y = cy - ay, v1z = cz - az;
  const nx = v0y * v1z - v0z * v1y, ny = v0z * v1x - v0x * v1z, nz = v0x * v1y - v0y * v1x;
  const nn = nx * nx + ny * ny + nz * nz;
  if (nn < 1e-20) { out[0] = 1; out[1] = 0; out[2] = 0; return out; }
  // Onto the triangle's plane first, then clamped into it by the same weights.
  const t = ((px - ax) * nx + (py - ay) * ny + (pz - az) * nz) / nn;
  const qx = px - nx * t, qy = py - ny * t, qz = pz - nz * t;
  const v2x = qx - ax, v2y = qy - ay, v2z = qz - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01;
  let v = den === 0 ? 0 : (d11 * d20 - d01 * d21) / den;
  let w = den === 0 ? 0 : (d00 * d21 - d01 * d20) / den;
  v = Math.min(1, Math.max(0, v));
  w = Math.min(1, Math.max(0, w));
  if (v + w > 1) { const s = v + w; v /= s; w /= s; }
  out[0] = 1 - v - w; out[1] = v; out[2] = w;
  return out;
}

/** One texel out of a decoded glTF image, wrapped and taken to linear. */
export function sampleImage(img, u, v) {
  const wrap = (x) => { const f = x - Math.floor(x); return f < 0 ? f + 1 : f; };
  const px = Math.min(img.width - 1, Math.floor(wrap(u) * img.width));
  const py = Math.min(img.height - 1, Math.floor(wrap(v) * img.height));
  const o = (py * img.width + px) * 4;
  const srgb = (c) => (c / 255) ** 2.2;
  return [srgb(img.data[o]), srgb(img.data[o + 1]), srgb(img.data[o + 2])];
}

// ---------------------------------------------------------------------------
// Which side of the skin a point is on
// ---------------------------------------------------------------------------

const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];

/** Crossings of one axis-aligned line with every triangle, each carrying which way it was crossed. */
function lineCrossings(tris, rows, ax, bx_, cx_, b, c, hits) {
  hits.length = 0;
  for (const t of rows) {
    const o = t * 9;
    const b0 = tris.xyz[o + bx_], c0 = tris.xyz[o + cx_];
    const b1 = tris.xyz[o + 3 + bx_], c1 = tris.xyz[o + 3 + cx_];
    const b2 = tris.xyz[o + 6 + bx_], c2 = tris.xyz[o + 6 + cx_];
    const d = (c1 - c2) * (b0 - b2) + (b2 - b1) * (c0 - c2);
    if (d === 0) continue;
    const l0 = ((c1 - c2) * (b - b2) + (b2 - b1) * (c - c2)) / d;
    const l1 = ((c2 - c0) * (b - b2) + (b0 - b2) * (c - c2)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
    // The axes come in cyclic order, so the sign of that denominator is which way the face points.
    hits.push({ t: l0 * tris.xyz[o + ax] + l1 * tris.xyz[o + 3 + ax] + l2 * tris.xyz[o + 6 + ax], w: d > 0 ? 1 : -1 });
  }
  hits.sort((p, q) => p.t - q.t);
}

/**
 * A grid over the whole model marking which cells are inside the skin.
 *
 * Counted by winding number rather than by crossing parity, because these models are assembled from closed
 * parts that interpenetrate — an arm pushed into a shoulder. A ray through the overlap crosses four surfaces,
 * so parity calls it OUTSIDE and the bake would punch a hole exactly where two parts meet. Winding counts it
 * twice and stays non-zero. Run down all three axes and taken by majority, so one bad face cannot decide it.
 *
 * The sign has to come from the WHOLE model rather than from one chunk: a chunk of skin is an open surface
 * with a boundary at the seam, where "inside" means nothing.
 */
export function insideField(tris, lo, hi, res) {
  const cell = [0, 1, 2].map((a) => (hi[a] - lo[a]) / res);
  const votes = new Uint8Array(res * res * res);
  const hits = [];

  for (const [ax, bx_, cx_] of AXES) {
    // Bucketed by row so a line tests the triangles that could possibly cross it, not all of them.
    const rows = Array.from({ length: res }, () => []);
    for (let t = 0; t < tris.count; t++) {
      const o = t * 9;
      let mn = Infinity, mx = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = tris.xyz[o + k * 3 + bx_];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const i0 = Math.max(0, Math.floor((mn - lo[bx_]) / cell[bx_]));
      const i1 = Math.min(res - 1, Math.floor((mx - lo[bx_]) / cell[bx_]));
      for (let i = i0; i <= i1; i++) rows[i].push(t);
    }

    const idx = [0, 0, 0];
    for (let ib = 0; ib < res; ib++) {
      const b = lo[bx_] + (ib + 0.5) * cell[bx_];
      if (!rows[ib].length) continue;
      for (let ic = 0; ic < res; ic++) {
        const c = lo[cx_] + (ic + 0.5) * cell[cx_];
        lineCrossings(tris, rows[ib], ax, bx_, cx_, b, c, hits);
        if (!hits.length) continue;
        let total = 0;
        for (const h of hits) total += h.w;
        let k = 0, behind = 0;
        for (let ia = 0; ia < res; ia++) {
          const a = lo[ax] + (ia + 0.5) * cell[ax];
          while (k < hits.length && hits[k].t < a) behind += hits[k++].w;
          if (total - behind !== 0) {
            idx[ax] = ia; idx[bx_] = ib; idx[cx_] = ic;
            votes[(idx[2] * res + idx[1]) * res + idx[0]]++;
          }
        }
      }
    }
  }

  const data = new Uint8Array(votes.length);
  let filled = 0;
  for (let i = 0; i < votes.length; i++) if (votes[i] >= 2) { data[i] = 1; filled++; }
  return { data, res, lo, cell, filled, volume: filled * cell[0] * cell[1] * cell[2] };
}

/** Whether a point in model space falls inside the skin, by nearest cell. */
export function insideAt(field, x, y, z) {
  const { res, lo, cell } = field;
  const i = Math.floor((x - lo[0]) / cell[0]);
  const j = Math.floor((y - lo[1]) / cell[1]);
  const k = Math.floor((z - lo[2]) / cell[2]);
  if (i < 0 || j < 0 || k < 0 || i >= res || j >= res || k >= res) return false;
  return field.data[(k * res + j) * res + i] === 1;
}

// ---------------------------------------------------------------------------
// The tile
// ---------------------------------------------------------------------------

/**
 * How far the chunk's triangles actually reach along the box's own axes, plus the pad.
 *
 * Not the fitted box grown by the pad, which is the obvious move and is wrong: a triangle at a seam is given
 * to BOTH bones, so it carries vertices this bone's box was never fitted to and pokes out through its face.
 * The shader's "past the tile" answer is `distance to the tile + pad`, and that only holds if every triangle
 * in the tile is inside it — so the tile has to be measured from the triangles, not from the box.
 */
export function tileExtent(tris, triIdx, box, pad) {
  const half = [pad, pad, pad];
  for (const t of triIdx) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const dx = tris.xyz[o] - box.center[0];
      const dy = tris.xyz[o + 1] - box.center[1];
      const dz = tris.xyz[o + 2] - box.center[2];
      for (let a = 0; a < 3; a++) {
        const e = Math.abs(box.axes[a][0] * dx + box.axes[a][1] * dy + box.axes[a][2] * dz) + pad;
        if (e > half[a]) half[a] = e;
      }
    }
  }
  return half;
}

/**
 * One bone's chunk of skin, as a cube of signed distances in the chunk's own oriented frame.
 *
 * Corner voxels sit exactly on the tile's faces, so 0..1 across the tile maps onto the full voxel range.
 */
export function bakeTile(tris, triIdx, box, { res, half, inside, images = null }) {
  const out = new Float32Array(res * res * res);
  // Colour is baked into the same grid as the distance, so the shader reads it with the same coordinate
  // and no per-pixel triangle search. One averaged colour per bone loses every marking on these models.
  const rgb = images ? new Uint8Array(res * res * res * 4) : null;
  const bary = [0, 0, 0];

  // Centroid and radius per triangle, so a triangle that cannot beat the running best is skipped.
  const cen = new Float64Array(triIdx.length * 3);
  const rad = new Float64Array(triIdx.length);
  for (let n = 0; n < triIdx.length; n++) {
    const o = triIdx[n] * 9;
    let cxs = 0, cys = 0, czs = 0;
    for (let k = 0; k < 3; k++) { cxs += tris.xyz[o + k * 3]; cys += tris.xyz[o + k * 3 + 1]; czs += tris.xyz[o + k * 3 + 2]; }
    const cx = cxs / 3, cy = cys / 3, cz = czs / 3;
    cen[n * 3] = cx; cen[n * 3 + 1] = cy; cen[n * 3 + 2] = cz;
    let r = 0;
    for (let k = 0; k < 3; k++) {
      r = Math.max(r, Math.hypot(
        tris.xyz[o + k * 3] - cx, tris.xyz[o + k * 3 + 1] - cy, tris.xyz[o + k * 3 + 2] - cz));
    }
    rad[n] = r;
  }

  const far = Math.hypot(half[0], half[1], half[2]);
  for (let k = 0; k < res; k++) {
    const lz = (k / (res - 1) * 2 - 1) * half[2];
    for (let j = 0; j < res; j++) {
      const ly = (j / (res - 1) * 2 - 1) * half[1];
      for (let i = 0; i < res; i++) {
        const lx = (i / (res - 1) * 2 - 1) * half[0];
        const px = box.center[0] + box.axes[0][0] * lx + box.axes[1][0] * ly + box.axes[2][0] * lz;
        const py = box.center[1] + box.axes[0][1] * lx + box.axes[1][1] * ly + box.axes[2][1] * lz;
        const pz = box.center[2] + box.axes[0][2] * lx + box.axes[1][2] * ly + box.axes[2][2] * lz;
        let best = far * far, winner = -1;
        for (let n = 0; n < triIdx.length; n++) {
          const gap = Math.hypot(px - cen[n * 3], py - cen[n * 3 + 1], pz - cen[n * 3 + 2]) - rad[n];
          if (gap > 0 && gap * gap >= best) continue;
          const o = triIdx[n] * 9;
          const d2 = triDist2(px, py, pz,
            tris.xyz[o], tris.xyz[o + 1], tris.xyz[o + 2],
            tris.xyz[o + 3], tris.xyz[o + 4], tris.xyz[o + 5],
            tris.xyz[o + 6], tris.xyz[o + 7], tris.xyz[o + 8]);
          if (d2 < best) { best = d2; winner = triIdx[n]; }
        }
        const d = Math.sqrt(best);
        const at = (k * res + j) * res + i;
        out[at] = insideAt(inside, px, py, pz) ? -d : d;
        if (!rgb) continue;
        const img = winner >= 0 ? images[tris.image[winner]] : null;
        if (!img) { rgb[at * 4 + 3] = 0; continue; }
        const o = winner * 9, uo = winner * 6;
        baryOfClosest(px, py, pz,
          tris.xyz[o], tris.xyz[o + 1], tris.xyz[o + 2],
          tris.xyz[o + 3], tris.xyz[o + 4], tris.xyz[o + 5],
          tris.xyz[o + 6], tris.xyz[o + 7], tris.xyz[o + 8], bary);
        const u = bary[0] * tris.uv[uo] + bary[1] * tris.uv[uo + 2] + bary[2] * tris.uv[uo + 4];
        const v = bary[0] * tris.uv[uo + 1] + bary[1] * tris.uv[uo + 3] + bary[2] * tris.uv[uo + 5];
        const c = sampleImage(img, u, v);
        // Stored as linear bytes, matching how the shader's albedo is used; alpha marks a real reading.
        for (let a = 0; a < 3; a++) rgb[at * 4 + a] = Math.round(Math.min(1, c[a]) * 255);
        rgb[at * 4 + 3] = 255;
      }
    }
  }
  return { dist: out, rgb };
}

// ---------------------------------------------------------------------------
// Half floats
// ---------------------------------------------------------------------------

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

/** IEEE binary32 to binary16, which is what an r16float texture wants. */
export function toHalf(value) {
  _f32[0] = value;
  const x = _i32[0];
  const sign = (x >> 16) & 0x8000;
  const e = (x >> 23) & 0xff;
  let m = (x >> 12) & 0x07ff;
  if (e < 103) return sign;
  if (e > 142) return sign | 0x7c00 | (e === 255 && (x & 0x007fffff) ? 0x0200 : 0);
  if (e < 113) {
    m |= 0x0800;
    return sign | ((m >> (114 - e)) + ((m >> (113 - e)) & 1));
  }
  return sign + (((e - 112) << 10) | (m >> 1)) + (m & 1);
}

/** The inverse, so a test can check what a bake actually stored. */
export function fromHalf(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const m = bits & 0x03ff;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * (m + 1024) * 2 ** (e - 25);
}
