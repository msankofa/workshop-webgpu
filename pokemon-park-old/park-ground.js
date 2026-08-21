// The park's ground: one mesh, one draw call, shaded by the biome underneath it.

import { PARK_BIOMES, PARK_BIOME_INDEX } from './park-biomes.js';

/** Ground albedo per biome, linear-ish sRGB. Separable enough to read a biome boundary from a ridge. */
export const PARK_GROUND_COLORS = Object.freeze({
  meadow:   [0.38, 0.52, 0.20],
  forest:   [0.16, 0.28, 0.13],
  lake:     [0.20, 0.26, 0.24],
  shore:    [0.72, 0.65, 0.47],
  wetland:  [0.29, 0.36, 0.20],
  mountain: [0.42, 0.41, 0.39],
  cave:     [0.19, 0.17, 0.20],
  town:     [0.45, 0.42, 0.36],
});

/** Rock and soil the slope rules blend toward, so a cliff is never grass stood on end. */
const ROCK = [0.36, 0.345, 0.33];
const SOIL = [0.30, 0.24, 0.17];

const idx = (res, ix, iz) => iz * res + ix;

/** Build the park's ground mesh. */
export function buildParkGround({
  THREE,
  MeshStandardNodeMaterial,
  TSL,
  park,
  stride = 2,
  colors = PARK_GROUND_COLORS,
} = {}) {
  if (!THREE?.BufferGeometry) throw new Error('buildParkGround needs { THREE }');
  const { grid, map } = park;
  const res = grid.resolution;
  const worldX = grid.worldX, worldZ = grid.worldZ;
  const halfX = worldX / 2, halfZ = worldZ / 2;
  const cellX = worldX / (res - 1), cellZ = worldZ / (res - 1);
  const st = Math.max(1, Math.floor(stride));
  // Refused rather than rounded.
  if ((res - 1) % st !== 0) {
    throw new Error(`buildParkGround: stride ${st} does not divide resolution-1 (${res - 1}); the sheet would not reach the park edge`);
  }
  const n = (res - 1) / st + 1;
  const dx = cellX * st, dz = cellZ * st;

  const verts = n * n;
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const color = new Float32Array(verts * 3);
  const heights = new Float32Array(verts);

  const sample = (ix, iz) => grid.height[idx(res, Math.min(res - 1, ix), Math.min(res - 1, iz))];

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = Math.min(res - 1, i * st), gj = Math.min(res - 1, j * st);
      const h = sample(gi, gj);
      const v = j * n + i;
      const x = -halfX + i * dx, z = -halfZ + j * dz;
      position[v * 3] = x; position[v * 3 + 1] = h; position[v * 3 + 2] = z;
      heights[v] = h;

      // Central differences on the FIELD, not on the decimated sheet
      const hl = sample(Math.max(0, gi - 1), gj), hr = sample(Math.min(res - 1, gi + 1), gj);
      const hd = sample(gi, Math.max(0, gj - 1)), hu = sample(gi, Math.min(res - 1, gj + 1));
      let nx = (hl - hr), ny = 2 * cellX, nz = (hd - hu);
      const inv = 1 / Math.hypot(nx, ny, nz);
      normal[v * 3] = nx * inv; normal[v * 3 + 1] = ny * inv; normal[v * 3 + 2] = nz * inv;

      const slope = Math.hypot((hr - hl) / (2 * cellX), (hu - hd) / (2 * cellZ));
      const base = colors[PARK_BIOMES[map.biome[idx(res, gi, gj)]]] || colors.meadow;

      // Rock takes over on anything steep and soil shows through on the way there
      const rockW = clamp01((slope - 0.34) / 0.34);
      const soilW = clamp01((slope - 0.14) / 0.26) * (1 - rockW);
      // Two octaves of value noise at very different scales
      const macro = 1 + 0.16 * (vnoise(x / 90, z / 90) - 0.5) * 2;
      const micro = 1 + 0.09 * (vnoise(x / 11, z / 11) - 0.5) * 2;
      const tint = macro * micro;

      for (let k = 0; k < 3; k++) {
        let c = base[k] * (1 - rockW - soilW) + SOIL[k] * soilW + ROCK[k] * rockW;
        color[v * 3 + k] = clamp01(c * tint);
      }
    }
  }

  // Two triangles a quad, split a -> c -> b then b -> c -> d.
  const quads = (n - 1) * (n - 1);
  const index = verts > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let w = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index[w++] = a; index[w++] = c; index[w++] = b;
      index[w++] = b; index[w++] = c; index[w++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const material = new MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  });

  if (TSL) applyGroundDetail(TSL, material);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'park-ground';
  mesh.receiveShadow = true;
  mesh.castShadow = false;   // a 2.4 km sheet in the shadow pass buys nothing and costs the whole map
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  /** The height of the DRAWN ground, matching this mesh's own triangles and diagonals. */
  function surfaceHeightAt(x, z) {
    const fu = clampf((x + halfX) / dx, 0, n - 1.0001);
    const fv = clampf((z + halfZ) / dz, 0, n - 1.0001);
    const i = Math.floor(fu), j = Math.floor(fv);
    const u = fu - i, v = fv - j;
    const a = heights[j * n + i], b = heights[j * n + i + 1];
    const c = heights[(j + 1) * n + i], d = heights[(j + 1) * n + i + 1];
    // The quad emits (a, c, b) then (b
    return u + v <= 1
      ? a + (b - a) * u + (c - a) * v
      : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  /** The highest drawn ground within `r` metres — what a flat pad needs to clear the peaks under it. */
  function surfaceMaxNear(x, z, r) {
    let best = -Infinity;
    // The grid spans exactly r, at a spacing no coarser than a cell. Stepping by dx instead read a
    // whole cell out for any r smaller than one, which lifts a road metres off a slope.
    const nx = Math.max(1, Math.ceil(r / dx)), nz = Math.max(1, Math.ceil(r / dz));
    const sx = r / nx, sz = r / nz;
    for (let j = -nz; j <= nz; j++) {
      for (let i = -nx; i <= nx; i++) {
        const h = surfaceHeightAt(x + i * sx, z + j * sz);
        if (h > best) best = h;
      }
    }
    return best;
  }

  return {
    mesh, geometry, material,
    vertices: verts, triangles: quads * 2, gridSize: n,
    surfaceHeightAt, surfaceMaxNear,
    bounds: { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

/** The near-ground detail the baked vertex colour cannot carry. */
function applyGroundDetail(TSL, material) {
  const { Fn, float, vec3, positionWorld, normalWorld, mix, clamp, mx_fractal_noise_float, abs } = TSL;
  material.colorNode = Fn(() => {
    const p = positionWorld;
    const fine = mx_fractal_noise_float(p.mul(0.55), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    const coarse = mx_fractal_noise_float(p.mul(0.045), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    // Flat ground shows the fine grain
    const flatness = clamp(abs(normalWorld.y), 0.0, 1.0);
    const grain = mix(coarse, fine, flatness);
    const shade = float(0.82).add(grain.mul(0.36));
    return TSL.materialColor.mul(vec3(shade, shade, shade));
  })();
  // Roughness varies with the same grain so the ground is not uniformly matte under a low sun.
  material.roughnessNode = Fn(() => {
    const r = mx_fractal_noise_float(positionWorld.mul(0.08), 2, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    return clamp(float(0.86).add(r.mul(0.14)), float(0.4), float(1.0));
  })();
}

// --- small helpers, deliberately local so this module imports nothing but

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampf = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/** Biome colours as an ImageData-ready RGBA buffer, for the minimap. */
export function bakeBiomeImage(map, palette) {
  const res = map.resolution;
  const out = new Uint8ClampedArray(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    const c = palette[PARK_BIOMES[map.biome[i]]] || [255, 0, 255];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  }
  return { data: out, width: res, height: res };
}

export { PARK_BIOME_INDEX };
