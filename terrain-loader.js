import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  applyTerrainTextures, TERRAIN_TEXTURE_LAYERS, FALLBACK_COLORS, MASK_ALIASES, BIOME_MATERIAL,
} from './terrain-textures.js';
import { moistureProxyForBiome, upnessFromNormalY, smoothstep as ssMoist } from './moisture-proxy.js';

const TREE_DENSITY = {
  deep_ocean: 0.0,
  ocean: 0.0,
  beach: 0.03,
  desert: 0.0,
  badlands: 0.04,
  savanna: 0.20,
  plains: 0.10,
  forest: 0.85,
  dark_forest: 0.95,
  jungle: 0.90,
  swamp: 0.45,
  taiga: 0.70,
  snowy_taiga: 0.55,
  snowy_plains: 0.05,
  stony_peaks: 0.03,
  snowy_peaks: 0.0,
  windswept_hills: 0.18,
  meadow: 0.16,
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// --- SurfaceField layer tables (merged plan §1 F1) ---
// Reuse the SAME 13-layer set + fallback colors the vertex bake uses (terrain-textures.js),
// so the read sampler and the eventual material agree on layer identity and tint.
const LAYER_INDEX = Object.fromEntries(TERRAIN_TEXTURE_LAYERS.map((n, i) => [n, i]));
const LAYER_RGB = TERRAIN_TEXTURE_LAYERS.map((n) => {
  const h = FALLBACK_COLORS[n] ?? 0x808080;
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
});
const NLAYERS = TERRAIN_TEXTURE_LAYERS.length;
const SURFACE_TOPK = 4;
// Module-level scratch for the per-query weight accumulation — avoids an allocation on the
// hot path (surfaceField is O(1) and safe to call from placement loops). Not re-entrant,
// which is fine: all callers are single-threaded CPU.
const _surfW = new Float64Array(NLAYERS);

function mapBasePath(mapKey) {
  return mapKey.replace(/\.glb$/i, '');
}

function collectMeshes(root) {
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry?.attributes?.position) meshes.push(obj);
  });
  return meshes;
}

function deriveTopSurfaceHeights(root, { resolution, worldX, worldZ, seaLevel, worldYMax }) {
  const meshes = collectMeshes(root);
  const out = new Float32Array(resolution * resolution);
  const seen = new Uint8Array(resolution * resolution);
  const p = new THREE.Vector3();

  out.fill(Number.isFinite(worldYMax) ? Math.min(seaLevel, worldYMax) : seaLevel);
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const ix = clamp(Math.round((p.x / worldX + 0.5) * (resolution - 1)), 0, resolution - 1);
      const iz = clamp(Math.round((p.z / worldZ + 0.5) * (resolution - 1)), 0, resolution - 1);
      const idx = iz * resolution + ix;
      if (!seen[idx] || p.y > out[idx]) {
        out[idx] = p.y;
        seen[idx] = 1;
      }
    }
  }

  // Fill sparse cells from neighbours. This is a fallback for old exports only;
  // newly exported maps should carry exact `heights` in -data.json.
  for (let pass = 0; pass < resolution * 2; pass++) {
    let changed = false;
    for (let iz = 0; iz < resolution; iz++) {
      for (let ix = 0; ix < resolution; ix++) {
        const idx = iz * resolution + ix;
        if (seen[idx]) continue;
        let sum = 0, count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = ix + dx, nz = iz + dz;
            if (nx < 0 || nx >= resolution || nz < 0 || nz >= resolution) continue;
            const nidx = nz * resolution + nx;
            if (!seen[nidx]) continue;
            sum += out[nidx];
            count++;
          }
        }
        if (count > 0) {
          out[idx] = sum / count;
          seen[idx] = 1;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}

// perf (2026-07-08 Wave 0, terrain-dressing-performance-design.md Milestone 0): `textureMode`
// selects which applyTerrainTextures() path builds the authored map's ground material —
// 'splat' (default, omit textureMode) is the current blended node material; 'legacy' forces
// { legacySplit: true }; 'flat' forces { flatMaterial: true } (diagnostic-only, see
// terrain-textures.js's applyFlatTerrain). Callers pass this straight from the
// ?terrainTexture= URL flag; omitting it (or passing 'splat') is behavior-identical to before
// this option existed.
//
// perf (2026-07-08 Wave 3B/3C, terrain-dressing-performance-design.md Milestone 3): the splat
// path's material-build options are plumbed straight through as loadTerrainMap options, not
// hardcoded — `maxShaderLayers` (default 4, the 3C top-K runtime cap; pass 6 for full quality),
// `slopeCutoff` (3B's live triplanar/planar blend point for dirt/gravel/snow, 0..1, default
// terrain-textures.js's DEFAULT_TRIPLANAR_SLOPE_CUTOFF), `shaderQuality` ('reduced'|'full',
// which prebuilt variant is assigned initially — the OTHER variant is still prebuilt so the
// viewer's "Terrain shader" Perf A/B select can swap instantly), and `prebuildVariants` (default
// true; false skips building the unused variant, e.g. for tests/perf-isolation). Flag wiring
// from a `?terrainTextureQuality=` URL param is intentionally NOT added here — the task scope is
// the loader/material option surface only.
export async function loadTerrainMap(mapKey, {
  scene, textureMode, maxShaderLayers, slopeCutoff, shaderQuality, prebuildVariants,
} = {}) {
  const basePath = mapBasePath(mapKey);
  const [gltf, mapData] = await Promise.all([
    new Promise((resolve, reject) => new GLTFLoader().load(`maps/${mapKey}`, resolve, undefined, reject)),
    fetch(`maps/${basePath}-data.json`).then((r) => {
      if (!r.ok) throw new Error(`map data fetch failed (${r.status})`);
      return r.json();
    }),
  ]);

  const terrainRoot = gltf.scene;

  const resolution = Number(mapData.resolution);
  const worldX = Number(mapData.worldX);
  const worldZ = Number(mapData.worldZ);
  if (!Number.isFinite(resolution) || resolution < 2) throw new Error('map data has invalid resolution');
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) throw new Error('map data has invalid world size');
  const heights = Array.isArray(mapData.heights)
    ? new Float32Array(mapData.heights)
    : deriveTopSurfaceHeights(terrainRoot, {
      resolution,
      worldX,
      worldZ,
      seaLevel: Number(mapData.seaLevel ?? 0),
      worldYMax: Number(mapData.worldYMax),
    });
  const biomeGrid = new Uint8Array(mapData.biomeIds || []);
  const densityGrid = new Float32Array(mapData.grassDensity || []);
  const treeDensityGrid = Array.isArray(mapData.treeDensity) ? new Float32Array(mapData.treeDensity) : null;
  const biomeNames = mapData.biomeNames || [];
  const textureInfo = await applyTerrainTextures(terrainRoot, mapData, {
    resolution,
    worldX,
    worldZ,
    seaLevel: Number(mapData.seaLevel ?? 0),
    biomeNames,
  }, {
    legacySplit: textureMode === 'legacy',
    flatMaterial: textureMode === 'flat',
    maxShaderLayers,
    slopeCutoff,
    shaderQuality,
    prebuildVariants,
  });
  if (!textureInfo) {
    terrainRoot.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.receiveShadow = true;
      obj.castShadow = false;
      obj.material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.0,
      });
    });
  }
  if (scene) scene.add(terrainRoot);

  function bilinear(grid, x, z) {
    const fx = (x / worldX + 0.5) * (resolution - 1);
    const fz = (z / worldZ + 0.5) * (resolution - 1);
    const ix = clamp(Math.floor(fx), 0, resolution - 2);
    const iz = clamp(Math.floor(fz), 0, resolution - 2);
    const tx = clamp(fx - ix, 0, 1);
    const tz = clamp(fz - iz, 0, 1);
    const a = grid[iz * resolution + ix] ?? 0;
    const b = grid[iz * resolution + ix + 1] ?? a;
    const c = grid[(iz + 1) * resolution + ix] ?? a;
    const d = grid[(iz + 1) * resolution + ix + 1] ?? c;
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  function nearestIndex(x, z) {
    const ix = clamp(Math.round((x / worldX + 0.5) * (resolution - 1)), 0, resolution - 1);
    const iz = clamp(Math.round((z / worldZ + 0.5) * (resolution - 1)), 0, resolution - 1);
    return iz * resolution + ix;
  }

  function inBounds(x, z) {
    return x >= -worldX * 0.5 && x <= worldX * 0.5 && z >= -worldZ * 0.5 && z <= worldZ * 0.5;
  }

  function biomeAt(x, z) {
    if (!inBounds(x, z) || biomeGrid.length === 0) return 'plains';
    return biomeNames[biomeGrid[nearestIndex(x, z)]] || 'plains';
  }

  // --- SurfaceField (merged plan §1 F1): one read-only sampler feeding ground albedo,
  // grass/canopy tint, plant density and the moss dressing law. O(1) per query (bilinear
  // grid reads + small arithmetic), safe to call from placement loops. Purely additive —
  // it does NOT touch classifyMesh's per-vertex bake or the terrain material.
  const surfaceSeaLevel = Number(mapData.seaLevel ?? 0);
  const materialMasks = mapData.materialMasks || mapData.materialWeights || null;
  const stepX = worldX / Math.max(1, resolution - 1);
  const stepZ = worldZ / Math.max(1, resolution - 1);

  // normalY from the height grid via central differences (4 bilinear taps). 1 = flat.
  function normalYAt(x, z) {
    const hL = bilinear(heights, x - stepX, z);
    const hR = bilinear(heights, x + stepX, z);
    const hD = bilinear(heights, x, z - stepZ);
    const hU = bilinear(heights, x, z + stepZ);
    const gx = (hR - hL) / (2 * stepX);
    const gz = (hU - hD) / (2 * stepZ);
    return 1 / Math.sqrt(gx * gx + gz * gz + 1);
  }

  // Feathered top-k material weights from the SAME biome/mask/slope logic materialFromMasks/
  // fallbackMaterialAt use — but kept as a smoothstep-feathered weight vector, NOT an argmax.
  function surfaceField(x, z) {
    const gi = nearestIndex(x, z);
    const worldY = inBounds(x, z) ? bilinear(heights, x, z) : surfaceSeaLevel;
    const upness = inBounds(x, z) ? upnessFromNormalY(normalYAt(x, z)) : 1;
    const biome = biomeAt(x, z);

    _surfW.fill(0);
    // Base weights: authored per-layer masks if present, else a unit spike on the biome layer.
    let total = 0;
    if (materialMasks) {
      for (let i = 0; i < NLAYERS; i++) {
        const layer = TERRAIN_TEXTURE_LAYERS[i];
        let w = 0;
        const aliases = MASK_ALIASES[layer] || [layer];
        for (let a = 0; a < aliases.length; a++) {
          const arr = materialMasks[aliases[a]];
          if (Array.isArray(arr) || ArrayBuffer.isView(arr)) w += Number(arr[gi] ?? 0);
        }
        _surfW[i] = w;
        total += w;
      }
    }
    if (total <= 0.001) {
      _surfW.fill(0);
      _surfW[LAYER_INDEX[BIOME_MATERIAL[biome] || 'grass'] ?? LAYER_INDEX.grass] = 1;
      total = 1;
    }

    // Feathered slope/shore/depth ramps — MUST match terrain-textures.js layerWeightsAt (the
    // vertex bake) so this read field and the terrain material agree (one field). Rock and sand
    // are OVERRIDES that suppress the biome base past the threshold (cliff → rock, lakebed →
    // sand), feathered by keepBase so the transition still blends. Edges mirror RAMP there.
    const slope = 1 - upness;
    const rockW = ssMoist(0.42, 0.58, slope);
    const dirtW = ssMoist(0.26, 0.42, slope) * (1 - rockW);
    const sandW = 1 - ssMoist(surfaceSeaLevel - 0.9, surfaceSeaLevel - 0.1, worldY);
    const beachW = (1 - ssMoist(surfaceSeaLevel + 0.8, surfaceSeaLevel + 2.2, worldY)) * (1 - sandW);
    const keepBase = (1 - rockW) * (1 - sandW);
    for (let i = 0; i < NLAYERS; i++) _surfW[i] *= keepBase;
    _surfW[LAYER_INDEX.sand] += sandW * total;
    _surfW[LAYER_INDEX.rock] += rockW * total * (1 - sandW);
    _surfW[LAYER_INDEX.dirt] += dirtW * total * (1 - sandW);
    _surfW[LAYER_INDEX.beach] += beachW * total * (1 - rockW);

    // Top-k selection (k=4), normalized to sum 1.
    const idx = [0, 0, 0, 0];
    const wt = [0, 0, 0, 0];
    for (let k = 0; k < SURFACE_TOPK; k++) { idx[k] = -1; wt[k] = -1; }
    for (let i = 0; i < NLAYERS; i++) {
      const w = _surfW[i];
      for (let k = 0; k < SURFACE_TOPK; k++) {
        if (w > wt[k]) {
          for (let j = SURFACE_TOPK - 1; j > k; j--) { wt[j] = wt[j - 1]; idx[j] = idx[j - 1]; }
          wt[k] = w; idx[k] = i;
          break;
        }
      }
    }
    let wsum = 0;
    for (let k = 0; k < SURFACE_TOPK; k++) { if (idx[k] < 0) { wt[k] = 0; } wsum += Math.max(0, wt[k]); }
    if (wsum <= 1e-8) { idx[0] = LAYER_INDEX.grass; wt[0] = 1; wsum = 1; }
    let r = 0, g = 0, b = 0;
    const indices = [], weights = [], layers = [];
    for (let k = 0; k < SURFACE_TOPK; k++) {
      if (idx[k] < 0) continue;
      const nw = Math.max(0, wt[k]) / wsum;
      const rgb = LAYER_RGB[idx[k]];
      r += rgb[0] * nw; g += rgb[1] * nw; b += rgb[2] * nw;
      indices.push(idx[k]); weights.push(nw); layers.push(TERRAIN_TEXTURE_LAYERS[idx[k]]);
    }

    const moisture = moistureProxyForBiome(biome, worldY, surfaceSeaLevel);
    const density = (inBounds(x, z) && densityGrid.length) ? bilinear(densityGrid, x, z) : 0;
    return {
      materialColor: [r, g, b],
      materialWeights: { indices, weights, layers },
      moisture,
      upness,
      density,
    };
  }

  function makeChunks(center, renderRadius = 2, chunkSize = 30) {
    const minIx = Math.floor((-worldX * 0.5) / chunkSize);
    const maxIx = Math.ceil((worldX * 0.5) / chunkSize) - 1;
    const minIz = Math.floor((-worldZ * 0.5) / chunkSize);
    const maxIz = Math.ceil((worldZ * 0.5) / chunkSize) - 1;
    const cx = clamp(Math.floor(center.x / chunkSize), minIx, maxIx);
    const cz = clamp(Math.floor(center.z / chunkSize), minIz, maxIz);
    const chunks = [];
    for (let iz = Math.max(minIz, cz - renderRadius); iz <= Math.min(maxIz, cz + renderRadius); iz++) {
      for (let ix = Math.max(minIx, cx - renderRadius); ix <= Math.min(maxIx, cx + renderRadius); ix++) {
        const xMin = ix * chunkSize;
        const zMin = iz * chunkSize;
        chunks.push({
          key: `${ix},${iz}`,
          xMin,
          zMin,
          size: chunkSize,
          centerX: xMin + chunkSize * 0.5,
          centerZ: zMin + chunkSize * 0.5,
        });
      }
    }
    return chunks;
  }

  function makeAllChunks(chunkSize = 30) {
    const minIx = Math.floor((-worldX * 0.5) / chunkSize);
    const maxIx = Math.ceil((worldX * 0.5) / chunkSize) - 1;
    const minIz = Math.floor((-worldZ * 0.5) / chunkSize);
    const maxIz = Math.ceil((worldZ * 0.5) / chunkSize) - 1;
    const chunks = [];
    for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const xMin = ix * chunkSize;
        const zMin = iz * chunkSize;
        chunks.push({
          key: `${ix},${iz}`,
          xMin,
          zMin,
          size: chunkSize,
          centerX: xMin + chunkSize * 0.5,
          centerZ: zMin + chunkSize * 0.5,
        });
      }
    }
    return chunks;
  }

  return {
    key: mapKey,
    root: terrainRoot,
    mesh: terrainRoot,
    terrainKind: mapData.terrainKind || 'heightfield',
    worldX,
    worldZ,
    worldYMin: mapData.worldYMin,
    worldYMax: mapData.worldYMax,
    seaLevel: Number(mapData.seaLevel ?? 0),
    resolution,
    biomeNames,
    terrainTextureMeshes: textureInfo?.texturedMeshes ?? 0,
    // perf CSV fields (terrain-dressing-performance-design.md Milestone 0): mode is 'splat'
    // (default), 'legacy', or 'flat' (diagnostic); activeSplatLayers is only populated in
    // splat mode (the number of layers the splat material actually blends, <= MAX_ACTIVE_LAYERS).
    terrainTextureMode: textureInfo?.mode ?? 'none',
    terrainActiveSplatLayers: textureInfo?.activeLayers?.length ?? 0,
    grassDensityGrid: densityGrid,
    heightAt(x, z) { return inBounds(x, z) ? bilinear(heights, x, z) : this.seaLevel; },
    biomeAt,
    grassDensityAt(x, z) { return inBounds(x, z) && densityGrid.length ? bilinear(densityGrid, x, z) : 0; },
    treeDensityAt(x, z) {
      if (!inBounds(x, z)) return 0;
      if (treeDensityGrid?.length) return bilinear(treeDensityGrid, x, z);
      return TREE_DENSITY[biomeAt(x, z)] ?? 0;
    },
    surfaceField,
    makeChunks,
    makeAllChunks,
  };
}
