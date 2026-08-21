// Turning a heightfield into a park you can read at a glance.

import { vnoise2, fbm2, ridged2, smoothstep, clamp } from './terrain-noise.js';
import { BIOMES } from './park-species.js';

/** Park biome keys in index order. Index is what the grid stores. */
export const PARK_BIOMES = Object.freeze(Object.keys(BIOMES));
export const PARK_BIOME_INDEX = Object.freeze(Object.fromEntries(PARK_BIOMES.map((k, i) => [k, i])));

/** Map colours, used by the minimap and the legend. Warm and separable rather than naturalistic. */
export const PARK_BIOME_COLORS = Object.freeze({
  meadow:   [138, 186, 88],
  forest:   [48, 112, 62],
  lake:     [56, 108, 168],
  shore:    [214, 196, 142],
  wetland:  [104, 132, 88],
  mountain: [140, 136, 130],
  cave:     [78, 70, 84],
  town:     [176, 150, 122],
});

// The three sectors that divide the park between them.
const SECTORS = ['meadow', 'forest', 'mountain'];

/** Where each sector's centre sits, as a fraction of the world half-extent. */
const SECTOR_ANCHORS = Object.freeze({
  meadow:   [0.00, 0.05],
  forest:   [-0.55, -0.50],
  mountain: [0.62, -0.58],
  town:     [-0.10, 0.68],
});

const idx = (res, ix, iz) => iz * res + ix;

/** Where the water is, and how big the park is. */
export const PARK_TERRAIN = Object.freeze({
  // 2.4 km across — a national park you walk into rather than a garden you see the far side of.
  worldX: 2400, worldZ: 2400, resolution: 769,
  meshStride: 2,
  waterLevel: 0,
  baseHeight: 8,
  rollAmp: 13, rollScale: 420,
  detailAmp: 2.2, detailScale: 62,
  // A 360 m lake, a 500 m massif rising 180 m, and a town pad big enough to hold a visitor centre.
  lake: { x: 0.42, z: 0.36, radius: 0.30, depth: 16, rim: 0.40 },
  peak: { x: 0.62, z: -0.58, radius: 0.44, height: 180, sharpness: 2.4 },
  townPad: { x: -0.12, z: 0.66, radius: 0.16, flatten: 0.88 },
  // A second, smaller tarn on the mountain's shoulder, so water is not only one place on the map.
  tarn: { x: 0.30, z: -0.62, radius: 0.10, depth: 11, rim: 0.35 },
});

/** The park's own heightfield. */
export function parkHeightGrid(opts = {}) {
  const P = { ...PARK_TERRAIN, ...opts };
  const res = P.resolution;
  const halfX = P.worldX / 2, halfZ = P.worldZ / 2;
  const cellX = P.worldX / (res - 1), cellZ = P.worldZ / (res - 1);
  const seed = opts.seed ?? 1;
  const off = (seed * 0.6180339887) % 1 * 1000;

  const basins = [P.lake, P.tarn].filter(Boolean).map((b) => ({
    x: b.x * halfX, z: b.z * halfZ, r: b.radius * Math.min(halfX, halfZ), depth: b.depth, rim: b.rim,
  }));
  const peakX = P.peak.x * halfX, peakZ = P.peak.z * halfZ, peakR = P.peak.radius * Math.min(halfX, halfZ);
  const townX = P.townPad.x * halfX, townZ = P.townPad.z * halfZ, townR = P.townPad.radius * Math.min(halfX, halfZ);

  const height = new Float32Array(res * res);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = -halfX + ix * cellX;
      const z = -halfZ + iz * cellZ;

      let h = P.baseHeight;
      h += (fbm2((x + off) / P.rollScale, (z - off) / P.rollScale, { octaves: 4 }) - 0.5) * 2 * P.rollAmp;
      h += (fbm2((x - off) / P.detailScale, (z + off) / P.detailScale, { octaves: 3 }) - 0.5) * 2 * P.detailAmp;

      // The massif.
      const pd = Math.hypot(x - peakX, z - peakZ) / peakR;
      if (pd < 1) {
        const w = Math.pow(1 - smoothstep(0, 1, pd), P.peak.sharpness);
        h += w * P.peak.height * (0.55 + 0.45 * ridged2((x + off) / 190, (z + off) / 190, { octaves: 4 }));
      }

      // The town sits on a pad.
      const td = Math.hypot(x - townX, z - townZ) / townR;
      if (td < 1.35) {
        const w = (1 - smoothstep(0.65, 1.35, td)) * P.townPad.flatten;
        h = h + (P.baseHeight + 1.2 - h) * w;
      }

      // The basins, cut last so nothing fills them back in.
      for (const b of basins) {
        const wob = 1 + 0.18 * (vnoise2(x / 150 + off, z / 150 - off) - 0.5) * 2;
        const ldw = Math.hypot(x - b.x, z - b.z) / b.r / wob;
        if (ldw >= 1.35) continue;
        h -= b.depth * (1 - smoothstep(0, 1, ldw));
        h += b.rim * b.depth * Math.max(0, 1 - Math.abs(ldw - 1.05) / 0.3);
      }

      height[iz * res + ix] = h;
    }
  }
  return { height, resolution: res, worldX: P.worldX, worldZ: P.worldZ, waterLevel: P.waterLevel };
}

/** Build the park's ground and its biome map in one call — what a page and a test both want. */
export function buildPark(opts = {}) {
  const grid = parkHeightGrid(opts);
  const map = buildParkMap({
    height: grid.height, resolution: grid.resolution,
    worldX: grid.worldX, worldZ: grid.worldZ, waterLevel: grid.waterLevel,
    seed: opts.seed ?? 1,
    ...(opts.mapOptions || {}),
  });
  return { grid, map };
}

/** Build the park's biome grid and the lookups a world page needs. */
export function buildParkMap({
  height,
  slope = null,
  resolution,
  worldX = 600,
  worldZ = 600,
  waterLevel = 0,
  seed = 1,
  // How far the sector boundaries wander, in metres. Zero gives you a Voronoi diagram and it looks it.
  boundaryWarp = 0.16,
  // Everything within this many metres of open water is shore rather than whatever sector it fell in.
  shoreWidth = 22,
  // Wetland is the band beyond the shore that is still barely above the water.
  wetlandRise = 2.4,
  // A slope steeper than this, above `mountainRise` over the water, reads as mountain whatever the sector.
  mountainSlope = 0.30,
  mountainRise = 34,
} = {}) {
  const res = resolution;
  if (!height || !res || height.length < res * res) throw new Error('buildParkMap needs a height grid and its resolution');
  const halfX = worldX / 2, halfZ = worldZ / 2;
  const cellX = worldX / (res - 1), cellZ = worldZ / (res - 1);
  const s = (seed * 2654435761) % 100000 / 977;

  const biome = new Uint8Array(res * res);
  const waterDepth = new Float32Array(res * res);
  const slopeArr = slope || deriveSlope(height, res, cellX, cellZ);

  // Warped distance to a sector centre.
  const anchors = SECTORS.map((k) => [SECTOR_ANCHORS[k][0] * halfX, SECTOR_ANCHORS[k][1] * halfZ]);
  const warpAmp = boundaryWarp * Math.min(worldX, worldZ);

  // The cave is a placed feature, not a sector: a gorge mouth bitten out of the mountain's flank.
  const caveX = SECTOR_ANCHORS.mountain[0] * halfX * 0.55;
  const caveZ = SECTOR_ANCHORS.mountain[1] * halfZ * 0.55;
  const caveR = Math.min(worldX, worldZ) * 0.06;
  const townCX = SECTOR_ANCHORS.town[0] * halfX;
  const townCZ = SECTOR_ANCHORS.town[1] * halfZ;
  const townCR = Math.min(worldX, worldZ) * 0.075;

  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = idx(res, ix, iz);
      const x = -halfX + ix * cellX;
      const z = -halfZ + iz * cellZ;
      const h = height[i];

      const wx = x + (vnoise2(x / 190 + s, z / 190 - s) - 0.5) * 2 * warpAmp;
      const wz = z + (vnoise2(x / 175 - s, z / 175 + s) - 0.5) * 2 * warpAmp;

      // 1. sector — the placed layer.
      let best = 0, bestD = Infinity;
      for (let k = 0; k < anchors.length; k++) {
        const dx = wx - anchors[k][0], dz = wz - anchors[k][1];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = k; }
      }
      let b = PARK_BIOME_INDEX[SECTORS[best]];

      // 2. the ground overrules the plan where it is genuinely mountainous.
      if (h - waterLevel > mountainRise && slopeArr[i] > mountainSlope) b = PARK_BIOME_INDEX.mountain;

      // 3. the developed area, stamped rather than apportioned.
      const td2 = Math.hypot(x - townCX, z - townCZ);
      if (td2 < townCR) b = PARK_BIOME_INDEX.town;

      // 4. the gorge, which must sit on rock to read as a cave rather than as a hole in a field.
      const cd = Math.hypot(x - caveX, z - caveZ);
      if (cd < caveR && h - waterLevel > mountainRise * 0.4) b = PARK_BIOME_INDEX.cave;

      // 5-7. water and its margins, in rising order of certainty.
      const rise = h - waterLevel;
      if (rise < wetlandRise && rise >= 0) b = PARK_BIOME_INDEX.wetland;
      if (rise < shoreWidth * 0.06 && rise >= 0 && slopeArr[i] < 0.22) b = PARK_BIOME_INDEX.shore;
      if (rise < 0) { b = PARK_BIOME_INDEX.lake; waterDepth[i] = -rise; }

      biome[i] = b;
    }
  }

  // The shore band is measured in metres from the waterline
  paintShore(biome, waterDepth, res, cellX, shoreWidth);

  const toCell = (x, z) => {
    const fx = clamp((x + halfX) / cellX, 0, res - 1);
    const fz = clamp((z + halfZ) / cellZ, 0, res - 1);
    return [fx, fz];
  };

  function heightAt(x, z) {
    const [fx, fz] = toCell(x, z);
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, res - 1), z1 = Math.min(z0 + 1, res - 1);
    const tx = fx - x0, tz = fz - z0;
    const h00 = height[idx(res, x0, z0)], h10 = height[idx(res, x1, z0)];
    const h01 = height[idx(res, x0, z1)], h11 = height[idx(res, x1, z1)];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  function biomeAt(x, z) {
    const [fx, fz] = toCell(x, z);
    // Nearest, not bilinear: a biome id is a name, and the average of "forest" and "lake" is nothing.
    return PARK_BIOMES[biome[idx(res, Math.round(fx), Math.round(fz))]];
  }

  function waterDepthAt(x, z) {
    const [fx, fz] = toCell(x, z);
    return waterDepth[idx(res, Math.round(fx), Math.round(fz))];
  }

  function slopeAt(x, z) {
    const [fx, fz] = toCell(x, z);
    return slopeArr[idx(res, Math.round(fx), Math.round(fz))];
  }

  // Cell lists per biome, so a spawner can draw a point IN a biome instead of
  const cells = PARK_BIOMES.map(() => []);
  for (let i = 0; i < biome.length; i++) cells[biome[i]].push(i);

  /** A uniformly random world point inside `biomeKey`, or null if that biome has no cells. */
  function samplePoint(biomeKey, rand = Math.random) {
    const list = cells[PARK_BIOME_INDEX[biomeKey]];
    if (!list || !list.length) return null;
    const i = list[Math.min(list.length - 1, (rand() * list.length) | 0)];
    const ix = i % res, iz = (i / res) | 0;
    // Jitter within the cell, or every resident stands on a lattice.
    return {
      x: -halfX + (ix + rand() - 0.5) * cellX,
      z: -halfZ + (iz + rand() - 0.5) * cellZ,
    };
  }

  return {
    biome, waterDepth, slope: slopeArr, height, resolution: res,
    worldX, worldZ, waterLevel, seed,
    names: PARK_BIOMES,
    heightAt, biomeAt, waterDepthAt, slopeAt, samplePoint,
    cellsPerBiome: cells.map((l) => l.length),
    zones: summariseZones(biome, res, worldX, worldZ),
    cellSize: Math.min(cellX, cellZ),
  };
}

/** Central-difference slope, as rise over run — the same measure the upstream generator uses. */
function deriveSlope(height, res, cellX, cellZ) {
  const out = new Float32Array(res * res);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const xm = Math.max(0, ix - 1), xp = Math.min(res - 1, ix + 1);
      const zm = Math.max(0, iz - 1), zp = Math.min(res - 1, iz + 1);
      const dx = (height[idx(res, xp, iz)] - height[idx(res, xm, iz)]) / ((xp - xm) * cellX);
      const dz = (height[idx(res, ix, zp)] - height[idx(res, ix, zm)]) / ((zp - zm) * cellZ);
      out[idx(res, ix, iz)] = Math.hypot(dx, dz);
    }
  }
  return out;
}

/** Widen the shore to a true metric band around the water. */
function paintShore(biome, waterDepth, res, cellX, shoreWidth) {
  const LAKE = PARK_BIOME_INDEX.lake, SHORE = PARK_BIOME_INDEX.shore;
  const rings = Math.max(1, Math.round(shoreWidth / cellX));
  let front = [];
  for (let i = 0; i < biome.length; i++) if (biome[i] === LAKE) front.push(i);
  const seen = new Uint8Array(biome.length);
  for (const i of front) seen[i] = 1;
  for (let r = 0; r < rings && front.length; r++) {
    const next = [];
    for (const i of front) {
      const ix = i % res, iz = (i / res) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= res || jz >= res) continue;
        const j = idx(res, jx, jz);
        if (seen[j]) continue;
        seen[j] = 1;
        // Only the sectors that a beach can eat.
        if (biome[j] !== PARK_BIOME_INDEX.mountain && biome[j] !== PARK_BIOME_INDEX.cave && biome[j] !== PARK_BIOME_INDEX.town) {
          biome[j] = SHORE;
        }
        next.push(j);
      }
    }
    front = next;
  }
}

/** Cell count and centroid per biome — what the legend prints and where the minimap puts its labels. */
export function summariseZones(biome, res, worldX, worldZ) {
  const halfX = worldX / 2, halfZ = worldZ / 2;
  const cellX = worldX / (res - 1), cellZ = worldZ / (res - 1);
  const acc = PARK_BIOMES.map((key) => ({ key, cells: 0, sx: 0, sz: 0 }));
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = acc[biome[idx(res, ix, iz)]];
      a.cells++;
      a.sx += -halfX + ix * cellX;
      a.sz += -halfZ + iz * cellZ;
    }
  }
  const total = res * res;
  return acc.map((a) => ({
    key: a.key,
    cells: a.cells,
    share: a.cells / total,
    centre: a.cells ? { x: a.sx / a.cells, z: a.sz / a.cells } : null,
  }));
}

/** Where a species would actually like to stand, as a 0..1 score for one point. */
export function featureScore(near, ctx) {
  if (!near || !near.length) return 1;
  let total = 0;
  for (const f of near) {
    switch (f) {
      // `1 - smoothstep(lo, hi, d)`, never `smoothstep(hi, lo, d)`.
      case 'water': total += 1 - smoothstep(4, 26, ctx.waterDistance ?? 999); break;
      case 'trees': total += clamp(ctx.treeDensity ?? 0, 0, 1); break;
      case 'rocks': total += clamp((ctx.slope ?? 0) / 0.5, 0, 1); break;
      case 'building': total += 1 - smoothstep(6, 40, ctx.buildingDistance ?? 999); break;
      case 'open': total += clamp(1 - (ctx.treeDensity ?? 0), 0, 1) * clamp(1 - (ctx.slope ?? 0) / 0.4, 0, 1); break;
      case 'height': total += clamp(((ctx.height ?? 0) - (ctx.waterLevel ?? 0)) / 40, 0, 1); break;
      case 'dark': total += clamp(Math.max(ctx.treeDensity ?? 0, ctx.enclosure ?? 0), 0, 1); break;
      default: total += 0.5;
    }
  }
  return clamp(total / near.length, 0, 1);
}

/** Tree density a park biome wants, 0..1. Drives the forest scatter and the `trees`/`open` features. */
export const PARK_TREE_DENSITY = Object.freeze({
  meadow: 0.06, forest: 0.92, lake: 0, shore: 0.04,
  wetland: 0.22, mountain: 0.05, cave: 0.02, town: 0.14,
});

/** Grass density a park biome wants, 0..1. */
export const PARK_GRASS_DENSITY = Object.freeze({
  meadow: 1.0, forest: 0.45, lake: 0, shore: 0.08,
  wetland: 0.85, mountain: 0.10, cave: 0.0, town: 0.30,
});

/** A deterministic 0..1 source, so a seeded park lays out the same way twice. */
export function makeRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Fractal noise a caller can use for placement jitter without importing the terrain stack itself. */
export function placementNoise(x, z, seed = 0) {
  return fbm2(x / 60 + seed * 13.7, z / 60 - seed * 7.3, { octaves: 3 });
}
