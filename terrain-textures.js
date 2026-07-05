import * as THREE from 'three';
import { moistureProxyForBiome, upnessFromNormalY, smoothstep as ssRamp } from './moisture-proxy.js';

export const TERRAIN_TEXTURE_LAYERS = ['grass', 'forest', 'meadow', 'taiga', 'dirt', 'savanna', 'swamp', 'sand', 'beach', 'desert', 'gravel', 'rock', 'snow'];

// Merged-plan Phase 2 (row #2): the single blended terrain node material replaces the old
// per-triangle argmax + addGroup multi-material. Max distinct layers blended on ONE map's
// terrain stage. Kept small so the per-fragment array-tap bandwidth (albedo+normal per active
// layer, 2 samplers total via DataArrayTexture) stays inside the R1/R2 budget; per-vertex we
// still keep only the top-4 (R1 "top-k=4 per fragment") so most slots are 0 at any vertex.
export const MAX_ACTIVE_LAYERS = 6;
const VERTEX_TOPK = 4;
// Slope/shore/height feather ramps — SAME edges the read-only surfaceField sampler uses in
// terrain-loader.js, so the CPU field and the baked vertex weights agree (one field, N
// consumers). Replaces fallbackMaterialAt's hard 0.58/0.34 slope and sea±0.5/1.5 steps.
const RAMP = { rock: [0.50, 0.66], dirt: [0.26, 0.42], sandLo: -0.9, sandHi: -0.1, beachLo: 0.8, beachHi: 2.2 };

const MATERIAL_INDEX = Object.fromEntries(TERRAIN_TEXTURE_LAYERS.map((name, index) => [name, index]));
const BASE_PATH = 'textures/ground';
const TILE_METERS = { grass: 4, forest: 3.5, meadow: 4, taiga: 3.5, dirt: 3, savanna: 3.5, swamp: 3, sand: 3.5, beach: 3, desert: 4, gravel: 2.5, rock: 2, snow: 4 };
// FALLBACK_COLORS / MASK_ALIASES / BIOME_MATERIAL are exported (additive) so the read-only
// SurfaceField sampler in terrain-loader.js can reuse the SAME layer→color and biome/mask
// tables the per-vertex bake uses, without duplicating them. classifyMesh is untouched.
export const FALLBACK_COLORS = { grass: 0x6f8f45, forest: 0x4f6d38, meadow: 0x82a84f, taiga: 0x536b48, dirt: 0x7b5a3a, savanna: 0x9b8a4a, swamp: 0x4b5435, sand: 0xd8be7c, beach: 0xd7c18a, desert: 0xcfae68, gravel: 0x808080, rock: 0x6f6c64, snow: 0xdde2df };
const ROUGHNESS = { grass: 0.95, forest: 0.96, meadow: 0.95, taiga: 0.96, dirt: 0.92, savanna: 0.93, swamp: 0.98, sand: 0.88, beach: 0.86, desert: 0.9, gravel: 0.98, rock: 0.96, snow: 0.82 };
export const MASK_ALIASES = {
  grass: ['grass', 'plains'],
  forest: ['forest', 'dark_forest', 'jungle'],
  meadow: ['meadow'],
  taiga: ['taiga'],
  dirt: ['dirt', 'badlands'],
  savanna: ['savanna'],
  swamp: ['swamp', 'mud'],
  sand: ['sand', 'water', 'ocean'],
  beach: ['beach', 'shore'],
  desert: ['desert'],
  gravel: ['gravel', 'scree'],
  rock: ['rock', 'stone', 'stony_peaks'],
  snow: ['snow', 'snowy_taiga', 'snowy_plains', 'snowy_peaks'],
};
export const BIOME_MATERIAL = {
  deep_ocean: 'sand', ocean: 'sand', beach: 'beach', desert: 'desert', badlands: 'dirt', savanna: 'savanna',
  plains: 'grass', forest: 'forest', dark_forest: 'forest', jungle: 'forest', swamp: 'swamp', taiga: 'taiga',
  snowy_taiga: 'snow', snowy_plains: 'snow', stony_peaks: 'rock', snowy_peaks: 'snow',
  windswept_hills: 'gravel', meadow: 'meadow',
};
const MAP_SUFFIXES = {
  color: ['albedo', 'color', 'basecolor', 'base_color', 'diffuse'],
  normal: ['normal', 'normalgl', 'normal_gl'],
  roughness: ['roughness', 'rough'],
  ao: ['ao', 'ambientocclusion', 'ambient_occlusion', 'ambient-occlusion'],
  displacement: ['displacement', 'height'],
};
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const LEGACY_FILES = {
  grass: { color: ['grass.jpg'] },
  dirt: { color: ['dirt_color.jpg'], normal: ['dirt_normal.jpg'] },
};
const BUILT_IN_TEXTURE_FILES = ['grass.jpg', 'dirt_color.jpg', 'dirt_normal.jpg'];
const MANIFEST_URL = `${BASE_PATH}/manifest.json`;

let textureFileSetPromise = null;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function normalizeTextureFile(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(new RegExp(`^${BASE_PATH}/`), '');
}

async function loadTextureFileSet(options = {}) {
  if (options.textureFiles instanceof Set) {
    return new Set([...options.textureFiles].map(normalizeTextureFile).filter(Boolean));
  }
  if (Array.isArray(options.textureFiles)) {
    return new Set(options.textureFiles.map(normalizeTextureFile).filter(Boolean));
  }
  if (typeof fetch !== 'function') return new Set(BUILT_IN_TEXTURE_FILES);
  if (!textureFileSetPromise) {
    textureFileSetPromise = fetch(MANIFEST_URL, { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((manifest) => {
        const files = Array.isArray(manifest) ? manifest : manifest?.files;
        return new Set((Array.isArray(files) ? files : BUILT_IN_TEXTURE_FILES).map(normalizeTextureFile).filter(Boolean));
      })
      .catch(() => new Set(BUILT_IN_TEXTURE_FILES));
  }
  return textureFileSetPromise;
}

function candidateFiles(layer, mapKind, textureFiles) {
  const out = [];
  for (const suffix of MAP_SUFFIXES[mapKind] || []) {
    for (const ext of EXTENSIONS) {
      out.push(`${layer}/${suffix}.${ext}`);
      out.push(`${layer}/${layer}_${suffix}.${ext}`);
      out.push(`${layer}/${layer}-${suffix}.${ext}`);
      out.push(`${layer}_${suffix}.${ext}`);
      out.push(`${layer}-${suffix}.${ext}`);
    }
  }
  for (const file of LEGACY_FILES[layer]?.[mapKind] || []) out.push(file);
  return [...new Set(out)].filter((file) => textureFiles.has(file)).map((file) => `${BASE_PATH}/${file}`);
}

async function loadTextureFromCandidates(loader, urls, { color = false, anisotropy = 8, tileMeters = 4 } = {}) {
  for (const url of urls) {
    const texture = await new Promise((resolve) => loader.load(url, resolve, undefined, () => resolve(null)));
    if (!texture) continue;
    texture.name = url;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / Math.max(0.001, tileMeters), 1 / Math.max(0.001, tileMeters));
    texture.anisotropy = anisotropy;
    texture.generateMipmaps = true;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, url };
  }
  return { texture: null, url: null };
}

async function loadLayerMaterial(layer, options = {}) {
  const loader = options.loader || new THREE.TextureLoader();
  const anisotropy = options.anisotropy ?? 8;
  const tileMeters = Number(options.tileMeters?.[layer] ?? TILE_METERS[layer] ?? 4);
  const loadOptions = { anisotropy, tileMeters };
  const textureFiles = await loadTextureFileSet(options);
  const [color, normal, roughness, ao, displacement] = await Promise.all([
    loadTextureFromCandidates(loader, candidateFiles(layer, 'color', textureFiles), { ...loadOptions, color: true }),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'normal', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'roughness', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'ao', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'displacement', textureFiles), loadOptions),
  ]);
  const material = new THREE.MeshStandardMaterial({
    name: `Terrain ${layer}`,
    color: color.texture ? 0xffffff : FALLBACK_COLORS[layer],
    map: color.texture,
    normalMap: normal.texture,
    roughnessMap: roughness.texture,
    aoMap: ao.texture,
    displacementMap: displacement.texture,
    displacementScale: 0,
    displacementBias: 0,
    roughness: ROUGHNESS[layer],
    metalness: 0,
  });
  return {
    layer,
    material,
    loaded: { color: color.url, normal: normal.url, roughness: roughness.url, ao: ao.url, displacement: displacement.url },
    missing: { color: !color.url, normal: !normal.url, roughness: !roughness.url, ao: !ao.url, displacement: !displacement.url },
    tileMeters,
  };
}

async function createTerrainMaterials(options = {}) {
  const packs = await Promise.all(TERRAIN_TEXTURE_LAYERS.map((layer) => loadLayerMaterial(layer, options)));
  return {
    packs,
    materials: packs.map((pack) => pack.material),
    report: Object.fromEntries(packs.map((pack) => [pack.layer, {
      loaded: pack.loaded,
      missing: pack.missing,
      tileMeters: pack.tileMeters,
    }])),
  };
}

function gridIndexAt(x, z, meta) {
  const ix = clamp(Math.round((x / meta.worldX + 0.5) * (meta.resolution - 1)), 0, meta.resolution - 1);
  const iz = clamp(Math.round((z / meta.worldZ + 0.5) * (meta.resolution - 1)), 0, meta.resolution - 1);
  return iz * meta.resolution + ix;
}

function materialFromMasks(mapData, gridIndex) {
  const masks = mapData.materialMasks || mapData.materialWeights;
  if (!masks || typeof masks !== 'object') return null;
  let best = 'grass';
  let bestWeight = -Infinity;
  for (const material of TERRAIN_TEXTURE_LAYERS) {
    let weight = 0;
    for (const key of MASK_ALIASES[material] || [material]) {
      const arr = masks[key];
      if (Array.isArray(arr)) weight += Number(arr[gridIndex] ?? 0);
    }
    if (weight > bestWeight) { best = material; bestWeight = weight; }
  }
  return bestWeight > 0.001 ? best : null;
}

function fallbackMaterialAt(mapData, meta, gridIndex, worldY, normalY) {
  const biomeId = mapData.biomeIds?.[gridIndex];
  const biome = meta.biomeNames?.[biomeId] || 'plains';
  let material = BIOME_MATERIAL[biome] || 'grass';
  const seaLevel = Number(meta.seaLevel ?? 0);
  const slope = 1 - Math.abs(Number.isFinite(normalY) ? normalY : 1);
  if (worldY <= seaLevel - 0.5) material = 'sand';
  else if (worldY <= seaLevel + 1.5 && material !== 'desert') material = 'beach';
  else if (slope > 0.58 && material !== 'snow') material = 'rock';
  else if (slope > 0.34 && ['grass', 'forest', 'meadow', 'taiga', 'savanna'].includes(material)) material = 'dirt';
  return material;
}

function dominantMaterial(a, b, c) {
  if (a === b || a === c) return a;
  if (b === c) return b;
  return [a, b, c].sort((x, y) => (MATERIAL_INDEX[y] ?? 0) - (MATERIAL_INDEX[x] ?? 0))[0] || 'grass';
}

function ensureUv2(geometry) {
  const uv = geometry.getAttribute('uv');
  if (!uv || geometry.getAttribute('uv2')) return;
  geometry.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(uv.array), 2));
}

function classifyMesh(mesh, mapData, meta) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return false;
  const normal = geometry.getAttribute('normal');
  const world = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const n = new THREE.Vector3();
  const uv = new Float32Array(position.count * 2);
  const vertexMaterial = new Array(position.count);

  for (let i = 0; i < position.count; i++) {
    world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    uv[i * 2] = world.x;
    uv[i * 2 + 1] = world.z;
    let normalY = 1;
    if (normal) {
      n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      normalY = n.y;
    }
    const gridIndex = gridIndexAt(world.x, world.z, meta);
    vertexMaterial[i] = materialFromMasks(mapData, gridIndex) || fallbackMaterialAt(mapData, meta, gridIndex, world.y, normalY);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  ensureUv2(geometry);

  const index = geometry.getIndex();
  geometry.clearGroups();
  if (index) {
    const source = index.array;
    const buckets = TERRAIN_TEXTURE_LAYERS.map(() => []);
    for (let i = 0; i < source.length; i += 3) {
      const ia = source[i], ib = source[i + 1], ic = source[i + 2];
      const material = dominantMaterial(vertexMaterial[ia], vertexMaterial[ib], vertexMaterial[ic]);
      buckets[MATERIAL_INDEX[material]].push(ia, ib, ic);
    }
    const IndexArray = source.constructor;
    const reordered = new IndexArray(source.length);
    let offset = 0;
    for (let materialIndex = 0; materialIndex < buckets.length; materialIndex++) {
      const bucket = buckets[materialIndex];
      if (!bucket.length) continue;
      reordered.set(bucket, offset);
      geometry.addGroup(offset, bucket.length, materialIndex);
      offset += bucket.length;
    }
    geometry.setIndex(new THREE.BufferAttribute(reordered, 1));
  } else {
    let start = 0;
    let current = MATERIAL_INDEX[vertexMaterial[0] || 'grass'];
    for (let i = 0; i < position.count; i += 3) {
      const material = dominantMaterial(vertexMaterial[i], vertexMaterial[i + 1], vertexMaterial[i + 2]);
      const materialIndex = MATERIAL_INDEX[material];
      if (i > start && materialIndex !== current) {
        geometry.addGroup(start, i - start, current);
        start = i;
        current = materialIndex;
      }
    }
    geometry.addGroup(start, position.count - start, current);
  }
  return true;
}

export async function applyTerrainTextures(root, mapData, meta = {}, options = {}) {
  if (typeof document === 'undefined') return null;
  const resolution = Number(meta.resolution ?? mapData.resolution);
  const worldX = Number(meta.worldX ?? mapData.worldX);
  const worldZ = Number(meta.worldZ ?? mapData.worldZ);
  if (!Number.isFinite(resolution) || resolution < 2 || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) return null;
  const fullMeta = {
    resolution,
    worldX,
    worldZ,
    seaLevel: Number(meta.seaLevel ?? mapData.seaLevel ?? 0),
    biomeNames: meta.biomeNames || mapData.biomeNames || [],
  };
  const { materials, report, packs } = await createTerrainMaterials(options);
  root.updateMatrixWorld(true);
  let texturedMeshes = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    obj.receiveShadow = true;
    obj.castShadow = false;
    if (classifyMesh(obj, mapData, fullMeta)) {
      obj.material = materials;
      texturedMeshes++;
    }
  });
  root.userData.terrainTextureMaterials = materials;
  root.userData.terrainTextureLayerPacks = packs;
  root.userData.terrainTextureSettings = Object.fromEntries(packs.map((pack) => [pack.layer, {
    sourceLayer: pack.layer,
    tileMeters: pack.tileMeters,
    defaultTileMeters: pack.tileMeters,
    roughness: ROUGHNESS[pack.layer],
    defaultRoughness: ROUGHNESS[pack.layer],
    normalScale: 1,
    displacementScale: 0,
  }]));
  root.userData.terrainTextureMeshes = texturedMeshes;
  root.userData.terrainTextureReport = report;
  return { materials, texturedMeshes, report };
}
const TEXTURE_MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'displacementMap'];

function applyTextureTileMeters(texture, tileMeters) {
  if (!texture) return;
  const repeat = 1 / Math.max(0.001, Number(tileMeters) || 1);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.needsUpdate = true;
}

function disposeOwnedMaps(material) {
  for (const texture of material.userData.terrainOwnedMaps || []) texture.dispose();
  material.userData.terrainOwnedMaps = [];
}

function cloneLayerTexture(texture, tileMeters) {
  if (!texture) return null;
  const clone = texture.clone();
  applyTextureTileMeters(clone, tileMeters);
  return clone;
}

function applyLayerMaterialSettings(material, settings) {
  for (const key of TEXTURE_MAP_KEYS) applyTextureTileMeters(material[key], settings.tileMeters);
  material.roughness = settings.roughness;
  if (material.normalScale) material.normalScale.set(settings.normalScale, settings.normalScale);
  material.displacementScale = settings.displacementScale;
  material.displacementBias = 0;
  material.needsUpdate = true;
}

export function getTerrainTextureLayerNames() {
  return [...TERRAIN_TEXTURE_LAYERS];
}

export function getTerrainTextureLayerSettings(root, layer) {
  return root?.userData?.terrainTextureSettings?.[layer] || null;
}

function normalizeTextureSource(source) {
  return normalizeTextureFile(source).replace(/\/+$/, '');
}

function validTextureSource(source) {
  return /^[A-Za-z0-9_\-/]+$/.test(source || '');
}

async function loadTextureSourceMaps(source, settings) {
  const textureFiles = await loadTextureFileSet();
  const loader = new THREE.TextureLoader();
  const loadOptions = { anisotropy: 8, tileMeters: settings.tileMeters };
  const [color, normal, roughness, ao, displacement] = await Promise.all([
    loadTextureFromCandidates(loader, candidateFiles(source, 'color', textureFiles), { ...loadOptions, color: true }),
    loadTextureFromCandidates(loader, candidateFiles(source, 'normal', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(source, 'roughness', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(source, 'ao', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(source, 'displacement', textureFiles), loadOptions),
  ]);
  return {
    map: color.texture,
    normalMap: normal.texture,
    roughnessMap: roughness.texture,
    aoMap: ao.texture,
    displacementMap: displacement.texture,
  };
}

export async function updateTerrainTextureLayer(root, layer, changes = {}) {
  const packs = root?.userData?.terrainTextureLayerPacks;
  const settingsByLayer = root?.userData?.terrainTextureSettings;
  if (!packs || !settingsByLayer || !Object.hasOwn(MATERIAL_INDEX, layer)) return null;
  const targetPack = packs[MATERIAL_INDEX[layer]];
  if (!targetPack?.material) return null;
  const settings = settingsByLayer[layer] || (settingsByLayer[layer] = {
    sourceLayer: layer,
    tileMeters: targetPack.tileMeters,
    defaultTileMeters: targetPack.tileMeters,
    roughness: ROUGHNESS[layer],
    defaultRoughness: ROUGHNESS[layer],
    normalScale: 1,
    displacementScale: 0,
  });
  const oldSource = settings.sourceLayer;
  if (changes.sourceLayer !== undefined) {
    const source = normalizeTextureSource(changes.sourceLayer);
    if (validTextureSource(source)) settings.sourceLayer = source;
  }
  if (Number.isFinite(Number(changes.tileMeters))) settings.tileMeters = Number(changes.tileMeters);
  if (Number.isFinite(Number(changes.roughness))) settings.roughness = clamp(Number(changes.roughness), 0, 1);
  if (Number.isFinite(Number(changes.normalScale))) settings.normalScale = clamp(Number(changes.normalScale), 0, 3);
  if (Number.isFinite(Number(changes.displacementScale))) settings.displacementScale = clamp(Number(changes.displacementScale), 0, 2);

  const target = targetPack.material;
  if (changes.sourceLayer !== undefined && settings.sourceLayer !== oldSource) {
    disposeOwnedMaps(target);
    const loaded = await loadTextureSourceMaps(settings.sourceLayer, settings);
    const owned = [];
    for (const key of TEXTURE_MAP_KEYS) {
      target[key] = loaded[key];
      if (loaded[key]) owned.push(loaded[key]);
    }
    target.userData.terrainOwnedMaps = owned;
    target.color.set(target.map ? 0xffffff : FALLBACK_COLORS[layer]);
  }
  applyLayerMaterialSettings(target, settings);
  return { ...settings };
}