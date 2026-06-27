import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

export async function loadTerrainMap(mapKey, { scene } = {}) {
  const basePath = mapBasePath(mapKey);
  const [gltf, mapData] = await Promise.all([
    new Promise((resolve, reject) => new GLTFLoader().load(`maps/${mapKey}`, resolve, undefined, reject)),
    fetch(`maps/${basePath}-data.json`).then((r) => {
      if (!r.ok) throw new Error(`map data fetch failed (${r.status})`);
      return r.json();
    }),
  ]);

  const terrainRoot = gltf.scene;
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
  if (scene) scene.add(terrainRoot);

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
    grassDensityGrid: densityGrid,
    heightAt(x, z) { return inBounds(x, z) ? bilinear(heights, x, z) : this.seaLevel; },
    biomeAt,
    grassDensityAt(x, z) { return inBounds(x, z) && densityGrid.length ? bilinear(densityGrid, x, z) : 0; },
    treeDensityAt(x, z) {
      if (!inBounds(x, z)) return 0;
      if (treeDensityGrid?.length) return bilinear(treeDensityGrid, x, z);
      return TREE_DENSITY[biomeAt(x, z)] ?? 0;
    },
    makeChunks,
    makeAllChunks,
  };
}
