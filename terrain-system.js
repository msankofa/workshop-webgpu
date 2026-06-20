import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { terrainHeightAt, terrainNormalAt, buildChunkArrays, buildHeightTile } from './terrain-field.js';

// Re-export field math so existing importers keep working.
export { terrainHeightAt, terrainNormalAt } from './terrain-field.js';

const DEFAULTS = {
  size: 60,
  baseAmp: 1.0,
  lake: 0.45,
  lakeDepth: 3.2,
  waterLevel: -0.9,
  chunkSize: 30,
  minSegmentsPerChunk: 14,
  collisionSegmentsPerChunk: 8,
  renderRadius: 2,
  collisionRadius: 1,
  maxChunksPerUpdate: 1,
  maxUnloadsPerUpdate: 2,
  useWorker: true,            // build chunk geometry off-thread when a Web Worker is available
  renderMode: 'chunks',       // 'chunks' = one mesh/chunk; 'instanced' = one shader-displaced InstancedMesh
  experimentalInstancedTerrain: false, // disabled until shader height parity with terrainHeightAt is proven
};

function merge(base, over) {
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(over || {})])) {
    out[key] = over && over[key] !== undefined ? over[key] : base[key];
  }
  return out;
}

// Only the fields terrainHeightAt/terrainNormalAt actually read — kept tiny so the
// worker postMessage payload stays small.
function fieldParams(params) {
  return { baseAmp: params.baseAmp, lake: params.lake, lakeDepth: params.lakeDepth };
}

// Wrap raw chunk arrays (from buildChunkArrays or the worker) in a THREE geometry.
function geometryFromArrays(a) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(a.uvs, 2));
  if (a.normals) geo.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(a.index, 1));
  if (!a.normals) geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const HEIGHTMAP_TEXEL_WORLD = 0.5;
const HEIGHTMAP_APRON = 1;

const HEIGHTMAP_SHADER = `
attribute vec2 instanceAtlasOffset;
uniform sampler2D uHeightAtlas;
uniform vec2 uHeightAtlasSize;
uniform float uHeightTileTexels;
uniform float uHeightTileApron;
uniform float uHeightTileSize;

vec2 terrainTileTexel(vec2 localUv, vec2 texelOffset) {
  float interiorIntervals = uHeightTileTexels - 1.0 - 2.0 * uHeightTileApron;
  return instanceAtlasOffset + vec2(uHeightTileApron) + localUv * interiorIntervals + texelOffset;
}

float terrainHeightSample(vec2 localUv, vec2 texelOffset) {
  vec2 texel = terrainTileTexel(localUv, texelOffset);
  return texture2D(uHeightAtlas, (texel + vec2(0.5)) / uHeightAtlasSize).r;
}

vec3 terrainHeightmapNormal(vec2 localUv) {
  float hL = terrainHeightSample(localUv, vec2(-1.0, 0.0));
  float hR = terrainHeightSample(localUv, vec2( 1.0, 0.0));
  float hD = terrainHeightSample(localUv, vec2(0.0, -1.0));
  float hU = terrainHeightSample(localUv, vec2(0.0,  1.0));
  float stepWorld = uHeightTileSize / (uHeightTileTexels - 1.0 - 2.0 * uHeightTileApron);
  return normalize(vec3(hL - hR, 2.0 * stepWorld, hD - hU));
}
`;

function createInstancedTerrainMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 1 });
  const heightUniforms = {
    uHeightAtlas: { value: null },
    uHeightAtlasSize: { value: new THREE.Vector2(1, 1) },
    uHeightTileTexels: { value: 1 },
    uHeightTileApron: { value: HEIGHTMAP_APRON },
    uHeightTileSize: { value: 30 },
  };
  material.userData.heightUniforms = heightUniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, heightUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${HEIGHTMAP_SHADER}`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec2 terrainNormalUv = position.xz / uHeightTileSize + vec2(0.5);
vec3 objectNormal = terrainHeightmapNormal(terrainNormalUv);`
      )
      .replace(
        '#include <begin_vertex>',
        `vec2 terrainLocalUv = position.xz / uHeightTileSize + vec2(0.5);
vec3 transformed = vec3(position.x, terrainHeightSample(terrainLocalUv, vec2(0.0)), position.z);`
      );
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'workshop-heightmap-terrain-v1';
  return material;
}

class TerrainSystem {
  constructor(options = {}) {
    this.params = merge(DEFAULTS, options.params);
    this.group = new THREE.Group();
    this.group.name = 'TerrainChunks';
    this.collisionGroup = new THREE.Group();
    this.collisionGroup.name = 'TerrainCollisionChunks';
    this.material = new MeshStandardNodeMaterial({ color: 0x2a2f38, roughness: 1 });
    this.instancedMaterial = createInstancedTerrainMaterial();
    this.collisionMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.renderMode = this.params.experimentalInstancedTerrain && this.params.renderMode === 'instanced' ? 'instanced' : 'chunks';
    this.instancedTerrain = null;
    this.instancedCapacity = 0;
    this.instanceMatrixScratch = new THREE.Matrix4();
    this.heightAtlasTexture = null;
    this.heightAtlasData = null;
    this.heightAtlasPixels = 1;
    this.heightAtlasGrid = 1;
    this.heightTileTexels = 1;
    this.atlasSlots = new Map();     // chunk key -> atlas slot index
    this.atlasFreeSlots = [];        // freed slot indices available for reuse
    this.atlasRequested = new Set(); // keys whose height-tile job was dispatched at the current epoch
    this.atlasNextSlot = 0;          // high-water slot allocator (reset when the atlas is reallocated)
    this.atlasGridSlots = 1;         // grid*grid capacity of the current atlas
    this.chunks = new Map();
    this.primaryMesh = null;
    this.centerX = 0;
    this.centerZ = 0;
    this.centerChunkX = null;
    this.centerChunkZ = null;
    this.targetKeys = new Set();
    this.collisionKeys = new Set();
    this.activeChunkCache = [];
    this.buildQueue = [];
    this.buildQueueIndex = 0;
    this.chunkingSig = null;

    // Async (worker) build state.
    this.worker = null;
    this.inFlight = new Set();   // chunk keys dispatched to the worker, awaiting a result
    this.epoch = 0;              // bumped on rebuild(); stamped on jobs so stale results are dropped
    this.workerChanged = false;  // a worker chunk landed since the last update() — surface it as "changed"
    if (this.params.useWorker) this.initWorker();

    this.rebuild();
  }

  initWorker() {
    try {
      this.worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onWorkerChunk(e.data);
      this.worker.onerror = () => this.disableWorker();
    } catch (err) {
      this.worker = null;   // no worker support (e.g. file://) — fall back to synchronous building
    }
  }

  // Drop to the synchronous path if the worker errors. Outstanding in-flight keys
  // are cleared and the window is recomputed so they get rebuilt on the main thread.
  disableWorker() {
    this.worker = null;
    this.inFlight.clear();
    this.centerChunkX = null;   // force update() to recompute the build queue
  }

  getHeight(x, z) {
    return terrainHeightAt(this.params, x, z);
  }

  get materialPatchTarget() {
    // In instanced mode the visible terrain is the displaced grid (instancedMaterial),
    // so consumers that patch this material (e.g. water caustics) must target it — not
    // the non-rendered compat chunk mesh.
    if (this.renderMode === 'instanced' && this.instancedTerrain) return this.instancedTerrain;
    return this.primaryMesh;
  }

  get pendingBuildCount() {
    return Math.max(0, this.buildQueue.length - this.buildQueueIndex) + this.inFlight.size;
  }

  get pendingCollisionBuildCount() {
    let pending = 0;
    for (const key of this.collisionKeys) {
      if (!this.chunks.has(key)) pending++;
    }
    return pending;
  }

  get activeChunks() {
    return this.activeChunkCache;
  }

  get targetChunkCount() {
    return this.targetKeys.size;
  }

  rebuild(options = {}) {
    Object.assign(this.params, options);
    this.renderMode = this.params.experimentalInstancedTerrain && this.params.renderMode === 'instanced' ? 'instanced' : 'chunks';
    this.updateInstancedUniforms();
    this.epoch++;            // invalidate any in-flight worker jobs from the old params
    this.inFlight.clear();
    this.atlasRequested.clear();   // re-request every height tile under the new epoch/params
    for (const chunk of this.chunks.values()) {
      this.disposeChunk(chunk);
    }
    this.chunks.clear();
    this.primaryMesh = null;
    this.centerChunkX = null;
    this.centerChunkZ = null;
    this.targetKeys.clear();
    this.collisionKeys.clear();
    this.activeChunkCache = [];
    this.buildQueue = [];
    this.buildQueueIndex = 0;
    this.update(this.centerX, this.centerZ);
  }

  update(centerX, centerZ) {
    this.centerX = centerX;
    this.centerZ = centerZ;

    const chunkSize = this.params.chunkSize;
    const centerChunkX = Math.floor(centerX / chunkSize);
    const centerChunkZ = Math.floor(centerZ / chunkSize);

    const radius = Math.max(0, Math.floor(this.params.renderRadius));
    let changed = false;

    // Recompute when the center chunk moves, when nothing is loaded yet, or when a
    // chunking-relevant param changed at runtime (renderRadius/collisionRadius/chunkSize)
    // without the center moving — otherwise such changes would be silently ignored.
    const chunkingSig = `${chunkSize}|${this.params.renderRadius}|${this.params.collisionRadius}`;
    const sigChanged = chunkingSig !== this.chunkingSig;

    if (centerChunkX !== this.centerChunkX || centerChunkZ !== this.centerChunkZ || this.targetKeys.size === 0 || sigChanged) {
      this.centerChunkX = centerChunkX;
      this.centerChunkZ = centerChunkZ;
      this.chunkingSig = chunkingSig;
      this.targetKeys = this.getTargetKeys(centerChunkX, centerChunkZ, radius);
      this.collisionKeys = this.getTargetKeys(centerChunkX, centerChunkZ, Math.max(0, Math.floor(this.params.collisionRadius)));
      if (this.renderMode === 'instanced') this.updateInstancedTerrain();
      this.buildQueue = this.getMissingKeysSorted(centerX, centerZ);
      this.buildQueueIndex = 0;
      changed = true;
      if (this.syncCollisionGroup()) changed = true;
    }

    // Cold start: build the nearest chunk synchronously so primaryMesh / activeChunks
    // exist immediately for consumers (water binds to the ground mesh, decorations
    // read activeChunks). The rest stream off-thread. Runs only while empty.
    if (this.worker && this.chunks.size === 0 && this.inFlight.size === 0 && this.buildQueueIndex < this.buildQueue.length) {
      const item = this.buildQueue[this.buildQueueIndex];
      if (this.targetKeys.has(item.key)) {
        this.buildQueueIndex++;
        this.addChunk(this.createChunk(item.key, item.ix * chunkSize, item.iz * chunkSize, chunkSize));
        changed = true;
      }
    }

    const maxBuilds = Math.max(1, Math.floor(this.params.maxChunksPerUpdate));
    for (let i = 0; i < maxBuilds && this.buildQueueIndex < this.buildQueue.length; i++) {
      const item = this.buildQueue[this.buildQueueIndex++];
      if (this.chunks.has(item.key) || this.inFlight.has(item.key) || !this.targetKeys.has(item.key)) {
        i--;
        continue;
      }
      if (this.worker) {
        this.dispatchChunk(item, chunkSize);   // builds off-thread; lands in onWorkerChunk
      } else {
        const chunk = this.createChunk(item.key, item.ix * chunkSize, item.iz * chunkSize, chunkSize);
        this.addChunk(chunk);
        changed = true;
      }
    }

    // Only unload once the build pipeline is idle (queue drained AND no worker jobs
    // in flight), so we don't churn chunks mid-stream.
    if (this.buildQueueIndex >= this.buildQueue.length && this.inFlight.size === 0) {
      this.buildQueue = [];
      this.buildQueueIndex = 0;
      const maxUnloads = Math.max(1, Math.floor(this.params.maxUnloadsPerUpdate));
      let unloads = 0;
      for (const [key, chunk] of this.chunks) {
        if (this.targetKeys.has(key)) continue;
        this.disposeChunk(chunk);
        this.chunks.delete(key);
        changed = true;
        unloads++;
        if (unloads >= maxUnloads) break;
      }
    }

    const first = this.chunks.values().next().value || null;
    this.primaryMesh = first ? first.mesh : null;

    // Fold in chunks that the worker finished between frames, so the host (which
    // keys decoration/octree rebuilds off update()'s return) reacts to them.
    const result = changed || this.workerChanged;
    this.workerChanged = false;
    if (result) this.refreshActiveChunkCache();
    return result;
  }

  // Add a fully-built chunk to the scene + bookkeeping (shared by sync + worker paths).
  addChunk(chunk) {
    this.chunks.set(chunk.key, chunk);
    if (this.renderMode !== 'instanced') this.group.add(chunk.mesh);
    if (this.collisionKeys.has(chunk.key)) this.collisionGroup.add(this.ensureCollider(chunk));
    if (!this.primaryMesh) this.primaryMesh = chunk.mesh;
  }

  dispatchChunk(item, chunkSize) {
    const segments = Math.max(this.params.minSegmentsPerChunk, Math.round(chunkSize * 0.75));
    this.inFlight.add(item.key);
    this.worker.postMessage({
      key: item.key,
      epoch: this.epoch,
      xMin: item.ix * chunkSize,
      zMin: item.iz * chunkSize,
      size: chunkSize,
      segments,
      computeNormals: true,
      params: fieldParams(this.params),
    });
  }

  onWorkerChunk(data) {
    if (data.jobType === 'heightTile') {
      if (data.epoch === this.epoch) this.writeHeightTile(data.key, data.heights, data.texels);
      return;
    }
    this.inFlight.delete(data.key);
    // Drop results from a previous param generation (rebuild bumped the epoch).
    if (data.epoch !== this.epoch) return;
    // Drop if we moved away or it somehow already exists.
    if (!this.targetKeys.has(data.key) || this.chunks.has(data.key)) return;

    const [ix, iz] = data.key.split(',').map(Number);
    const chunkSize = this.params.chunkSize;
    const chunk = this.chunkFromArrays(data.key, ix * chunkSize, iz * chunkSize, chunkSize, data);
    this.addChunk(chunk);
    this.workerChanged = true;
    this.refreshActiveChunkCache();
  }

  getTargetKeys(centerChunkX, centerChunkZ, radius) {
    const keys = new Set();
    for (let iz = centerChunkZ - radius; iz <= centerChunkZ + radius; iz++) {
      for (let ix = centerChunkX - radius; ix <= centerChunkX + radius; ix++) {
        keys.add(`${ix},${iz}`);
      }
    }
    return keys;
  }

  getMissingKeysSorted(centerX, centerZ) {
    const missing = [];
    for (const key of this.targetKeys) {
      if (this.chunks.has(key) || this.inFlight.has(key)) continue;
      const [ix, iz] = key.split(',').map(Number);
      const cx = (ix + 0.5) * this.params.chunkSize;
      const cz = (iz + 0.5) * this.params.chunkSize;
      const dx = cx - centerX;
      const dz = cz - centerZ;
      missing.push({ key, ix, iz, distance: dx * dx + dz * dz });
    }
    missing.sort((a, b) => a.distance - b.distance);
    return missing;
  }

  // Synchronous chunk build (fallback when no worker). Mesh geometry only;
  // collider is built lazily by ensureCollider.
  createChunk(key, xMin, zMin, size) {
    const segments = Math.max(this.params.minSegmentsPerChunk, Math.round(size * 0.75));
    const geo = this.createChunkGeometry(xMin, zMin, size, segments, true);
    return this.makeChunk(key, xMin, zMin, size, segments, geo);
  }

  // Build a chunk from worker-produced arrays.
  chunkFromArrays(key, xMin, zMin, size, data) {
    const segments = Math.max(this.params.minSegmentsPerChunk, Math.round(size * 0.75));
    return this.makeChunk(key, xMin, zMin, size, segments, geometryFromArrays(data));
  }

  makeChunk(key, xMin, zMin, size, segments, geo) {
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `TerrainChunk:${key}`;
    mesh.receiveShadow = true;
    mesh.userData.terrainChunk = { key, xMin, zMin, size, segments, lod: 0 };
    return { key, mesh, collider: null, xMin, zMin, size };
  }

  ensureCollider(chunk) {
    if (chunk.collider) return chunk.collider;
    const collisionSegments = Math.max(4, Math.floor(this.params.collisionSegmentsPerChunk));
    const geo = this.createChunkGeometry(chunk.xMin, chunk.zMin, chunk.size, collisionSegments, false);
    const collider = new THREE.Mesh(geo, this.collisionMaterial);
    collider.name = `TerrainCollider:${chunk.key}`;
    collider.userData.terrainChunk = { key: chunk.key, xMin: chunk.xMin, zMin: chunk.zMin, size: chunk.size, segments: collisionSegments, lod: 0 };
    chunk.collider = collider;
    return collider;
  }

  releaseCollider(chunk) {
    if (!chunk.collider) return;
    this.collisionGroup.remove(chunk.collider);
    chunk.collider.geometry.dispose();
    chunk.collider = null;
  }

  // Synchronous geometry build (fallback path + colliders, which are small enough
  // to stay on the main thread). Mirrors the worker's buildChunkArrays output.
  createChunkGeometry(xMin, zMin, size, segments, computeNormals) {
    return geometryFromArrays(buildChunkArrays(xMin, zMin, size, segments, fieldParams(this.params), computeNormals));
  }

  disposeChunk(chunk) {
    chunk.mesh.geometry.dispose();
    if (chunk.mesh.parent === this.group) this.group.remove(chunk.mesh);
    this.releaseCollider(chunk);
  }

  updateInstancedUniforms() {
    const uniforms = this.instancedMaterial && this.instancedMaterial.userData.heightUniforms;
    if (!uniforms) return;
    uniforms.uHeightAtlas.value = this.heightAtlasTexture;
    uniforms.uHeightAtlasSize.value.set(this.heightAtlasPixels, this.heightAtlasPixels);
    uniforms.uHeightTileTexels.value = this.heightTileTexels;
    uniforms.uHeightTileApron.value = HEIGHTMAP_APRON;
    uniforms.uHeightTileSize.value = this.params.chunkSize;
  }

  ensureInstancedTerrain(capacity) {
    if (this.instancedTerrain && this.instancedCapacity >= capacity) return this.instancedTerrain;
    if (this.instancedTerrain) {
      this.group.remove(this.instancedTerrain);
      this.instancedTerrain.geometry.dispose();
    }
    const segments = Math.max(this.params.minSegmentsPerChunk, Math.round(this.params.chunkSize * 0.75));
    const geometry = new THREE.PlaneGeometry(this.params.chunkSize, this.params.chunkSize, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    geometry.setAttribute('instanceAtlasOffset', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 2), 2));
    const mesh = new THREE.InstancedMesh(geometry, this.instancedMaterial, Math.max(1, capacity));
    mesh.name = 'TerrainInstancedDisplacedGrid';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.instancedTerrain = mesh;
    this.instancedCapacity = Math.max(1, capacity);
    this.group.add(mesh);
    return mesh;
  }

  updateInstancedTerrain() {
    const keys = [...this.targetKeys];
    const mesh = this.ensureInstancedTerrain(keys.length);
    this.ensureHeightAtlas(keys.length);
    const chunkSize = this.params.chunkSize;

    // Release atlas slots for keys that left the target window (reuse them later).
    for (const key of [...this.atlasSlots.keys()]) {
      if (!this.targetKeys.has(key)) {
        this.atlasFreeSlots.push(this.atlasSlots.get(key));
        this.atlasSlots.delete(key);
        this.atlasRequested.delete(key);
      }
    }

    const atlasOffsets = mesh.geometry.getAttribute('instanceAtlasOffset');
    let i = 0;
    for (const key of keys) {
      let slot = this.atlasSlots.get(key);
      if (slot === undefined) {
        slot = this.allocateAtlasSlot();
        this.atlasSlots.set(key, slot);
      }
      const [ix, iz] = key.split(',').map(Number);
      this.instanceMatrixScratch.makeTranslation((ix + 0.5) * chunkSize, 0, (iz + 0.5) * chunkSize);
      mesh.setMatrixAt(i, this.instanceMatrixScratch);
      atlasOffsets.setXY(i, (slot % this.heightAtlasGrid) * this.heightTileTexels, Math.floor(slot / this.heightAtlasGrid) * this.heightTileTexels);
      i++;

      // Build the tile off-thread (or synchronously if no worker). Only request once
      // per key per epoch; the atlas fills in as results land — no main-thread stall.
      if (!this.atlasRequested.has(key)) {
        this.atlasRequested.add(key);
        this.requestHeightTile(key, ix, iz);
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    atlasOffsets.needsUpdate = true;
    this.updateInstancedUniforms();
  }

  // Allocate/resize the height atlas DataTexture. Resizing invalidates every slot
  // assignment (tile positions move), so they are cleared and re-requested.
  ensureHeightAtlas(capacity) {
    const intervals = Math.max(1, Math.round(this.params.chunkSize / HEIGHTMAP_TEXEL_WORLD));
    const tileTexels = intervals + 1 + 2 * HEIGHTMAP_APRON;
    const grid = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, capacity))));
    const pixels = grid * tileTexels;
    if (!this.heightAtlasTexture || this.heightAtlasPixels !== pixels || this.heightTileTexels !== tileTexels) {
      if (this.heightAtlasTexture) this.heightAtlasTexture.dispose();
      this.heightAtlasData = new Float32Array(pixels * pixels);
      this.heightAtlasTexture = new THREE.DataTexture(this.heightAtlasData, pixels, pixels, THREE.RedFormat, THREE.FloatType);
      this.heightAtlasTexture.minFilter = THREE.LinearFilter;
      this.heightAtlasTexture.magFilter = THREE.LinearFilter;
      this.heightAtlasTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.heightAtlasTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.heightAtlasTexture.generateMipmaps = false;
      this.heightAtlasTexture.needsUpdate = true;
      this.heightAtlasPixels = pixels;
      this.heightTileTexels = tileTexels;
      this.atlasSlots.clear();
      this.atlasFreeSlots.length = 0;
      this.atlasRequested.clear();
      this.atlasNextSlot = 0;
    }
    this.heightAtlasGrid = grid;
    this.atlasGridSlots = grid * grid;
  }

  allocateAtlasSlot() {
    if (this.atlasFreeSlots.length) return this.atlasFreeSlots.pop();
    if (this.atlasNextSlot < this.atlasGridSlots) return this.atlasNextSlot++;
    return 0; // capacity guard: grid is sized so this should not be reached
  }

  // Build one height tile and route it into the atlas — off-thread when a worker is
  // available (the CPU win), synchronously otherwise (file:// fallback).
  requestHeightTile(key, ix, iz) {
    const chunkSize = this.params.chunkSize;
    if (this.worker) {
      this.worker.postMessage({
        jobType: 'heightTile',
        key,
        epoch: this.epoch,
        xMin: ix * chunkSize,
        zMin: iz * chunkSize,
        size: chunkSize,
        texelWorld: HEIGHTMAP_TEXEL_WORLD,
        apron: HEIGHTMAP_APRON,
        params: fieldParams(this.params),
      });
    } else {
      const tile = buildHeightTile(ix * chunkSize, iz * chunkSize, chunkSize, HEIGHTMAP_TEXEL_WORLD, fieldParams(this.params), HEIGHTMAP_APRON);
      this.writeHeightTile(key, tile.heights, tile.texels);
    }
  }

  // Copy a finished tile into its key's atlas slot. Race-safe: a key keeps its slot
  // until it leaves, and tile content depends only on key + params(epoch), so writing
  // to the key's current slot is always correct (epoch mismatch is dropped upstream).
  writeHeightTile(key, heights, tileTexels) {
    if (tileTexels !== this.heightTileTexels) return;   // atlas resized since the request
    const slot = this.atlasSlots.get(key);
    if (slot === undefined) return;                     // key left the window
    const grid = this.heightAtlasGrid;
    const pixels = this.heightAtlasPixels;
    const ax = (slot % grid) * tileTexels;
    const ay = Math.floor(slot / grid) * tileTexels;
    for (let y = 0; y < tileTexels; y++) {
      this.heightAtlasData.set(heights.subarray(y * tileTexels, (y + 1) * tileTexels), (ay + y) * pixels + ax);
    }
    this.heightAtlasTexture.needsUpdate = true;
  }

  refreshActiveChunkCache() {
    this.activeChunkCache = [...this.chunks.values()].filter((chunk) => this.targetKeys.has(chunk.key)).map((chunk) => {
      const data = chunk.mesh.userData.terrainChunk;
      return {
        key: data.key,
        xMin: data.xMin,
        zMin: data.zMin,
        size: data.size,
        centerX: data.xMin + data.size * 0.5,
        centerZ: data.zMin + data.size * 0.5,
      };
    });
  }

  syncCollisionGroup() {
    let changed = false;
    for (const chunk of this.chunks.values()) {
      const shouldAttach = this.collisionKeys.has(chunk.key);
      const attached = chunk.collider && chunk.collider.parent === this.collisionGroup;
      if (shouldAttach && !attached) {
        this.collisionGroup.add(this.ensureCollider(chunk));
        changed = true;
      } else if (!shouldAttach && chunk.collider) {
        this.releaseCollider(chunk);
        changed = true;
      }
    }
    return changed;
  }

  dispose() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.inFlight.clear();
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    if (this.instancedTerrain) {
      this.group.remove(this.instancedTerrain);
      this.instancedTerrain.geometry.dispose();
      this.instancedTerrain = null;
    }
    if (this.heightAtlasTexture) {
      this.heightAtlasTexture.dispose();
      this.heightAtlasTexture = null;
      this.heightAtlasData = null;
    }
    this.material.dispose();
    this.instancedMaterial.dispose();
    this.collisionMaterial.dispose();
  }
}

export function createTerrainSystem(options) {
  return new TerrainSystem(options);
}

export default createTerrainSystem;
