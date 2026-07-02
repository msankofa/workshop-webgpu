// grass-anchors.js
// CPU-side mesh-anchor sampling for GPU grass on authored (volumetric) maps.
// Bins a world-space triangle soup (the map collider geometry) into XZ chunks of
// upward-facing triangles, then area-weighted samples deterministic anchor points
// per chunk. Triangles spanning several chunks are clipped exactly to each chunk
// rectangle (low-poly maps have triangles larger than a chunk — centroid binning
// would leave grassless holes). Pure math, no three.js import — Node-tested by
// test-grass-anchors.mjs. grass-compute.js streams these anchors into a GPU storage
// buffer and culls them in its compute kernel instead of generating blade positions
// procedurally, so blades land on the real mesh surface (cave floors, overhangs,
// floating islands) rather than a top-down heightfield approximation.

// 32-bit string hash (FNV-1a) for deterministic per-chunk RNG seeds.
export function hashKey(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic PRNG in [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

export function parseChunkKey(key) {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

// Distance from an XZ point to the AABB of chunk (cx,cz).
export function pointToChunkDist(x, z, cx, cz, chunkSize) {
  const dx = Math.max(cx * chunkSize - x, 0, x - (cx + 1) * chunkSize);
  const dz = Math.max(cz * chunkSize - z, 0, z - (cz + 1) * chunkSize);
  return Math.hypot(dx, dz);
}

// Worst-case number of chunks whose AABB lies within `radius` of any camera
// point. Used to size the GPU slot pool. Counts grid offsets from a corner
// (the worst case) with one extra ring of margin.
export function slotCapacityForRadius(radius, chunkSize) {
  const m = Math.ceil(radius / chunkSize) + 2;
  let count = 0;
  for (let dz = -m; dz <= m; dz++) {
    for (let dx = -m; dx <= m; dx++) {
      if (pointToChunkDist(0, 0, dx, dz, chunkSize) <= radius + chunkSize) count++;
    }
  }
  return count;
}

// XZ-projected area of a 3D triangle given as three [x,y,z] arrays.
function projAreaXZ(a, b, c) {
  return 0.5 * Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]));
}

// Sutherland–Hodgman: clip a convex 3D polygon (array of [x,y,z]) against one
// half-plane keep(v) >= 0, defined in XZ; y interpolates linearly along edges.
function clipHalfPlane(poly, keep) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const dc = keep(cur), dn = keep(nxt);
    if (dc >= 0) out.push(cur);
    if ((dc >= 0) !== (dn >= 0)) {
      const t = dc / (dc - dn);
      out.push([
        cur[0] + (nxt[0] - cur[0]) * t,
        cur[1] + (nxt[1] - cur[1]) * t,
        cur[2] + (nxt[2] - cur[2]) * t,
      ]);
    }
  }
  return out;
}

// Clip a 3D triangle to a chunk rectangle in XZ. Returns a convex polygon
// (possibly empty) of [x,y,z] vertices.
function clipTriToChunk(v0, v1, v2, cx, cz, chunkSize) {
  const x0 = cx * chunkSize, x1 = (cx + 1) * chunkSize;
  const z0 = cz * chunkSize, z1 = (cz + 1) * chunkSize;
  let poly = [v0, v1, v2];
  poly = clipHalfPlane(poly, (v) => v[0] - x0);
  if (poly.length < 3) return [];
  poly = clipHalfPlane(poly, (v) => x1 - v[0]);
  if (poly.length < 3) return [];
  poly = clipHalfPlane(poly, (v) => v[2] - z0);
  if (poly.length < 3) return [];
  poly = clipHalfPlane(poly, (v) => z1 - v[2]);
  return poly.length < 3 ? [] : poly;
}

// Bin upward-facing triangles of a non-indexed world-space triangle soup
// (Float32Array, 9 floats per triangle) into XZ chunks. A triangle is "upward"
// when its unit normal has y >= minNormalY (requires consistent outward winding,
// which GLB exports provide). Triangles contained in one chunk are stored by
// index; triangles spanning chunks are clipped and the clipped pieces stored in
// an auxiliary `extraTris` soup (referenced as triCount + extraIndex). Each chunk
// carries a CDF over XZ-projected areas for area-weighted sampling.
export function buildChunkIndex(positions, { chunkSize = 32, minNormalY = 0.5 } = {}) {
  const triCount = Math.floor(positions.length / 9);
  const lists = new Map(); // key -> { tris: number[], areas: number[] }
  const extra = [];        // flattened 9-float clipped sub-triangles
  const addRef = (key, ref, area) => {
    let list = lists.get(key);
    if (!list) { list = { tris: [], areas: [] }; lists.set(key, list); }
    list.tris.push(ref);
    list.areas.push(area);
  };
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    if (ny / len < minNormalY) continue;
    const c0x = Math.floor(Math.min(ax, bx, cx) / chunkSize);
    const c1x = Math.floor(Math.max(ax, bx, cx) / chunkSize);
    const c0z = Math.floor(Math.min(az, bz, cz) / chunkSize);
    const c1z = Math.floor(Math.max(az, bz, cz) / chunkSize);
    if (c0x === c1x && c0z === c1z) {
      addRef(chunkKey(c0x, c0z), t, 0.5 * ny); // ny > 0; = area projected onto XZ
      continue;
    }
    const v0 = [ax, ay, az], v1 = [bx, by, bz], v2 = [cx, cy, cz];
    for (let icz = c0z; icz <= c1z; icz++) {
      for (let icx = c0x; icx <= c1x; icx++) {
        const poly = clipTriToChunk(v0, v1, v2, icx, icz, chunkSize);
        for (let i = 1; i + 1 < poly.length; i++) {
          const area = projAreaXZ(poly[0], poly[i], poly[i + 1]);
          if (area <= 1e-9) continue;
          const ref = triCount + extra.length / 9;
          extra.push(...poly[0], ...poly[i], ...poly[i + 1]);
          addRef(chunkKey(icx, icz), ref, area);
        }
      }
    }
  }
  const chunks = new Map();
  for (const [key, list] of lists) {
    const n = list.tris.length;
    const tris = new Uint32Array(list.tris);
    const cdf = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += list.areas[i]; cdf[i] = acc; }
    chunks.set(key, { tris, cdf, totalArea: acc });
  }
  return { chunkSize, minNormalY, chunks, triCount, extraTris: new Float32Array(extra) };
}

function upperBound(cdf, r) {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] <= r) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Sample up to maxCount anchors on the chunk's upward surface, area-weighted,
// at `density` anchors per unit of XZ-projected area. Deterministic for a given
// (key, seed). Returns a Float32Array of n*4: (x, y, z, rand01) per anchor, or
// null if the chunk has no upward surface.
export function sampleChunk(index, positions, key, { density, maxCount = Infinity, seed = 1 } = {}) {
  const chunk = index.chunks.get(key);
  if (!chunk || chunk.totalArea <= 0) return null;
  const n = Math.min(maxCount, Math.round(density * chunk.totalArea));
  if (n <= 0) return new Float32Array(0);
  const rng = mulberry32(hashKey(key) ^ (seed >>> 0));
  const out = new Float32Array(n * 4);
  const tc = index.triCount;
  for (let i = 0; i < n; i++) {
    const j = upperBound(chunk.cdf, rng() * chunk.totalArea);
    const ref = chunk.tris[j];
    const src = ref < tc ? positions : index.extraTris;
    const o = (ref < tc ? ref : ref - tc) * 9;
    // uniform barycentric via sqrt trick
    const su = Math.sqrt(rng());
    const r2 = rng();
    const b0 = 1 - su, b1 = su * (1 - r2), b2 = su * r2;
    out[i * 4] = b0 * src[o] + b1 * src[o + 3] + b2 * src[o + 6];
    out[i * 4 + 1] = b0 * src[o + 1] + b1 * src[o + 4] + b2 * src[o + 7];
    out[i * 4 + 2] = b0 * src[o + 2] + b1 * src[o + 5] + b2 * src[o + 8];
    out[i * 4 + 3] = rng();
  }
  return out;
}
