// terrain-tint.js — the ground's readability tint, with no dependencies.
// Imported by both terrain-worker.js (so a chunk arrives already coloured) and
// base-game-terrain.js (the synchronous fallback, and the re-tint of a stale revision).
// Keep this file dependency-light: the worker pays for everything it imports.

// LINEAR values: written straight into a vertex-colour attribute, which three treats
// as already in working space.
export const TERRAIN_TINT = Object.freeze({
  water: [0.16, 0.32, 0.42], sand: [0.72, 0.66, 0.46], grass: [0.30, 0.48, 0.22],
  dry: [0.46, 0.44, 0.28], rock: [0.42, 0.40, 0.38], snow: [0.92, 0.93, 0.95],
});

// Band edges, shared by the CPU form here and the TSL twin in base-game-terrain.js.
export const TERRAIN_TINT_BANDS = Object.freeze({
  shoreSpan: 6, sandTop: 2, dryStart: 20, drySpan: 40, snowStart: 60, snowSpan: 40,
  rockNormalY: 0.82, rockSpan: 0.25,
});

// One vertex's ground colour, written into `out` at `o`.
export function terrainTintAt(yAboveSea, normalY, out = [0, 0, 0], o = 0) {
  const T = TERRAIN_TINT, B = TERRAIN_TINT_BANDS;
  const cl = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => { for (let i = 0; i < 3; i++) out[o + i] = a[i] + (b[i] - a[i]) * t; };
  const y = yAboveSea;
  if (y < 0) lerp(T.water, T.sand, cl(1 + y / B.shoreSpan));
  else if (y < B.sandTop) lerp(T.sand, T.grass, cl(y / B.sandTop));
  else if (y < B.snowStart) lerp(T.grass, T.dry, cl((y - B.dryStart) / B.drySpan));
  else lerp(T.dry, T.snow, cl((y - B.snowStart) / B.snowSpan));
  const rock = cl((B.rockNormalY - normalY) / B.rockSpan);
  for (let i = 0; i < 3; i++) out[o + i] += (T.rock[i] - out[o + i]) * rock;
  return out;
}

// Colours for an interleaved position/normal pair (the legacy chunk arrays and volume meshes).
export function tintArrayColors(positions, normals, seaLevel = 0) {
  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    terrainTintAt(positions[i * 3 + 1] - seaLevel, normals ? normals[i * 3 + 1] : 1, colors, i * 3);
  }
  return colors;
}

// Colours for a source tile, in the exact vertex order buildChunkArraysFromTile emits,
// so the main thread never has to build positions just to tint them.
export function tintTileColors(tile, seaLevel = 0) {
  const seg = tile.intervals, pad = tile.apron, tx = tile.texels;
  const g1 = seg + 1;
  const colors = new Float32Array(g1 * g1 * 3);
  let p = 0;
  for (let iy = 0; iy <= seg; iy++) {
    for (let ix = 0; ix <= seg; ix++) {
      const s = (iy + pad) * tx + (ix + pad);
      terrainTintAt(tile.heights[s] - seaLevel, tile.normals ? tile.normals[s * 3 + 1] : 1, colors, p);
      p += 3;
    }
  }
  return colors;
}

// What the worker sends back for one finished tile. Colours are produced ONLY when the tile
// carries normals: without them the slope is unknown, and tinting at normalY = 1 would drop the
// rock band. Null colours hand the tint back to the host, which by then has main-thread normals.
export function finishTileTint(tile, tint) {
  if (!tint) return null;
  const t0 = performance.now();
  let colors = null, bounds = null;
  if (tile.volume && tile.volume.positions) {
    if (tile.volume.normals) colors = tintArrayColors(tile.volume.positions, tile.volume.normals, tint.seaLevel);
    bounds = boundsFromPositions(tile.volume.positions);
  } else if (tile.heights && tile.normals) {
    colors = tintTileColors(tile, tint.seaLevel);
  }
  return { colors, bounds, tintRevision: tint.revision, tintMs: performance.now() - t0 };
}

// The bounding sphere three would compute, as plain numbers, so the worker can send it
// and geometryFromArrays can adopt it instead of walking every vertex again.
export function boundsFromPositions(positions) {
  const n = positions.length / 3;
  if (!n) return { center: [0, 0, 0], radius: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx, dy = positions[i * 3 + 1] - cy, dz = positions[i * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(r2) };
}
