// terrain-field.js
// Pure terrain math + chunk-geometry array builder. NO three.js dependency, so it
// can be imported by both the main thread (terrain-system.js) and a Web Worker
// (terrain-worker.js). The worker builds the heavy per-vertex arrays off the
// render thread and ships them back as transferable buffers.

function lakeHash(ix, iz) {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function lakeNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = lakeHash(ix, iz), b = lakeHash(ix + 1, iz), c = lakeHash(ix, iz + 1), d = lakeHash(ix + 1, iz + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function terrainHeightAt(params, x, z) {
  let h = (Math.sin(x * 0.10) * 1.1 + Math.cos(z * 0.085) * 1.0 + Math.sin((x + z) * 0.16) * 0.5
         + Math.cos((x - z) * 0.22 + 0.8) * 0.35 + Math.sin(x * 0.38 + z * 0.27) * 0.18
         + Math.cos(z * 0.44 - x * 0.19) * 0.14) * params.baseAmp;
  const t = 1 - params.lake;
  const basin = smoothstep(t, t + 0.15, lakeNoise(x * 0.045 + 10.5, z * 0.045 - 7.2));
  return h - basin * params.lakeDepth;
}

// Position-deterministic surface normal. Because it depends only on (x, z) via a
// fixed-epsilon central difference, adjacent chunks agree exactly along shared
// edges, so there are no lighting seams between chunks.
export function terrainNormalAt(params, x, z, out) {
  const e = 0.5;
  const nx = terrainHeightAt(params, x - e, z) - terrainHeightAt(params, x + e, z);
  const ny = 2 * e;
  const nz = terrainHeightAt(params, x, z - e) - terrainHeightAt(params, x, z + e);
  const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
  out[0] = nx * inv;
  out[1] = ny * inv;
  out[2] = nz * inv;
  return out;
}

// Height tile for shader-displaced terrain. The tile samples the exact analytic
// field on a regular grid and includes an apron on every side so bilinear height
// reconstruction and one-texel normal taps are stable at chunk boundaries.
export function buildHeightTile(xMin, zMin, size, texelWorld, params, apron = 1) {
  const intervals = Math.max(1, Math.round(size / Math.max(1e-6, texelWorld)));
  const step = size / intervals;
  const pad = Math.max(0, apron | 0);
  const texels = intervals + 1 + pad * 2;
  const originX = xMin - pad * step;
  const originZ = zMin - pad * step;
  const heights = new Float32Array(texels * texels);

  for (let iz = 0; iz < texels; iz++) {
    const z = originZ + iz * step;
    for (let ix = 0; ix < texels; ix++) {
      const x = originX + ix * step;
      heights[iz * texels + ix] = terrainHeightAt(params, x, z);
    }
  }

  return {
    heights,
    texels,
    intervals,
    step,
    apron: pad,
    xMin,
    zMin,
    size,
    originX,
    originZ,
  };
}

// CPU mirror of the shader's LINEAR+CLAMP height texture fetch. This is used by
// tests to prove tile seam behavior before any GLSL path is enabled.
export function sampleHeightTileBilinear(tile, x, z) {
  const maxCell = tile.texels - 2;
  let fx = (x - tile.originX) / tile.step;
  let fz = (z - tile.originZ) / tile.step;
  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  ix = Math.max(0, Math.min(maxCell, ix));
  iz = Math.max(0, Math.min(maxCell, iz));
  const tx = Math.max(0, Math.min(1, fx - ix));
  const tz = Math.max(0, Math.min(1, fz - iz));
  const h00 = tile.heights[iz * tile.texels + ix];
  const h10 = tile.heights[iz * tile.texels + ix + 1];
  const h01 = tile.heights[(iz + 1) * tile.texels + ix];
  const h11 = tile.heights[(iz + 1) * tile.texels + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

// Build the raw geometry arrays for one chunk. The vertex and index ordering match
// THREE.PlaneGeometry(size, size, seg, seg).rotateX(-90).translate(...) exactly, so
// the result is interchangeable with the old synchronous path (same winding =>
// correct front faces). Returns plain typed arrays, transferable from a worker.
export function buildChunkArrays(xMin, zMin, size, segments, params, computeNormals) {
  const seg = Math.max(1, segments | 0);
  const g1 = seg + 1;
  const vcount = g1 * g1;
  const step = size / seg;

  const positions = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const normals = computeNormals ? new Float32Array(vcount * 3) : null;
  const n = [0, 0, 0];

  let p = 0, q = 0;
  for (let iy = 0; iy <= seg; iy++) {
    const z = zMin + iy * step;
    for (let ix = 0; ix <= seg; ix++) {
      const x = xMin + ix * step;
      positions[p] = x;
      positions[p + 1] = terrainHeightAt(params, x, z);
      positions[p + 2] = z;
      uvs[q] = ix / seg;
      uvs[q + 1] = 1 - iy / seg;
      if (normals) {
        terrainNormalAt(params, x, z, n);
        normals[p] = n[0]; normals[p + 1] = n[1]; normals[p + 2] = n[2];
      }
      p += 3; q += 2;
    }
  }

  const icount = seg * seg * 6;
  const index = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
  let t = 0;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = ix + g1 * iy;
      const b = ix + g1 * (iy + 1);
      const c = (ix + 1) + g1 * (iy + 1);
      const d = (ix + 1) + g1 * iy;
      index[t++] = a; index[t++] = b; index[t++] = d;
      index[t++] = b; index[t++] = c; index[t++] = d;
    }
  }

  return { positions, normals, uvs, index };
}

// Chunk arrays from a source tile (terrain-source.js result). Same vertex/uv/index
// layout as buildChunkArrays so the two are interchangeable; reads the tile's
// interior (apron skipped) and uses tile.normals when present.
export function buildChunkArraysFromTile(tile) {
  const seg = tile.intervals;
  const g1 = seg + 1;
  const vcount = g1 * g1;
  const step = tile.step;
  const pad = tile.apron;
  const tx = tile.texels;

  const positions = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const normals = tile.normals ? new Float32Array(vcount * 3) : null;

  let p = 0, q = 0;
  for (let iy = 0; iy <= seg; iy++) {
    const z = tile.zMin + iy * step;
    for (let ix = 0; ix <= seg; ix++) {
      const s = (iy + pad) * tx + (ix + pad);
      positions[p] = tile.xMin + ix * step;
      positions[p + 1] = tile.heights[s];
      positions[p + 2] = z;
      uvs[q] = ix / seg;
      uvs[q + 1] = 1 - iy / seg;
      if (normals) { normals[p] = tile.normals[s * 3]; normals[p + 1] = tile.normals[s * 3 + 1]; normals[p + 2] = tile.normals[s * 3 + 2]; }
      p += 3; q += 2;
    }
  }

  const icount = seg * seg * 6;
  const index = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
  let t = 0;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = ix + g1 * iy;
      const b = ix + g1 * (iy + 1);
      const c = (ix + 1) + g1 * (iy + 1);
      const d = (ix + 1) + g1 * iy;
      index[t++] = a; index[t++] = b; index[t++] = d;
      index[t++] = b; index[t++] = c; index[t++] = d;
    }
  }

  return { positions, normals, uvs, index };
}
