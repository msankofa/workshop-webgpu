# Water Clipmap LOD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the terrain-chunk-based water system with a three-ring camera-following clipmap: near ring (dense, ~50 m radius), mid ring (~150 m), far ring (map extent). All rings share the existing TSL materials; `environment-viewer.html` no longer computes or passes chunk arrays.

**Architecture:** `buildRingGeometry()` accepts a ring descriptor `{snapX, snapZ, innerHalf, outerHalf, cellSize, extentX, extentZ}` and builds a square grid with annular exclusion, extent clipping, and dry-quad skipping. Ring state lives in `waterRings[3]`; `checkSnaps()` marks rings dirty inside `update()`; `processRingQueue()` builds one ring per frame within the existing `buildBudgetMs` budget. `environment-viewer.html` removes `syncWaterChunks` and passes `extentX/Z` to `regenerate()` for authored maps.

**Tech Stack:** Three.js WebGPU, TSL node materials, `water.js`, `environment-viewer.html`

---

### Task 1: Add `buildRingGeometry` to `water.js`

**Files:**
- Modify: `water.js` (add after `buildGeometry`)

- [ ] **Step 1: Add `buildRingGeometry` after `buildGeometry` (~line 230)**

```js
function buildRingGeometry(o, { snapX, snapZ, innerHalf, outerHalf, cellSize, extentX, extentZ }) {
  const xMin = snapX - outerHalf;
  const zMin = snapZ - outerHalf;
  const nX = Math.max(1, Math.round((outerHalf * 2) / cellSize));
  const nZ = Math.max(1, Math.round((outerHalf * 2) / cellSize));
  const nx = nX + 1, nz = nZ + 1;
  const level = o.waterLevel;
  const heightFn = o.heightFn || (() => 0);

  const positions = new Float32Array(nx * nz * 3);
  const depths = new Float32Array(nx * nz);
  const bed = new Float32Array(nx * nz);
  let minBed = Infinity;

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      const x = xMin + i * cellSize;
      const z = zMin + j * cellSize;
      const b = heightFn(x, z);
      minBed = Math.min(minBed, b);
      bed[idx] = b;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z;
      depths[idx] = Math.max(0, level - b);
    }
  }

  const indices = [];
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nX; i++) {
      const cx = xMin + (i + 0.5) * cellSize;
      const cz = zMin + (j + 0.5) * cellSize;
      // annular exclusion: skip quads inside the finer ring's footprint
      if (innerHalf > 0 && Math.abs(cx - snapX) <= innerHalf && Math.abs(cz - snapZ) <= innerHalf) continue;
      // extent clip: skip quads outside authored map bounds
      if (extentX !== undefined && (cx < -extentX * 0.5 || cx > extentX * 0.5)) continue;
      if (extentZ !== undefined && (cz < -extentZ * 0.5 || cz > extentZ * 0.5)) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      // dry skip: all four corners above water
      if (bed[a] >= level && bed[b] >= level && bed[c] >= level && bed[d] >= level) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aDepth',   new THREE.BufferAttribute(depths, 1));
  g.setIndex(indices);
  g.computeBoundingSphere();
  g.userData.minBed = minBed;
  return g;
}
```

- [ ] **Step 2: Open `environment-viewer.html` in browser, confirm no breakage** — water still appears (existing chunk system still running).

---

### Task 2: Add ring state and helpers inside `createWaterSystem`

**Files:**
- Modify: `water.js` (inside `createWaterSystem`, after existing material construction ~line 450)

- [ ] **Step 1: Add LOD config, ring state, and `disposeRing`/`buildRing`/`checkSnaps`/`processRingQueue`/`updateCausticProjection` after the `stats` object (~line 451)**

Replace:
```js
  const stats = { chunks: 0, candidates: 0, pending: 0, dry: 0, minBed: Infinity, waterLevel: o.waterLevel };
  let waterBuildQueue = [];
  let waterBuildQueueIndex = 0;
  let waterBuildKeys = new Set();
```

With:
```js
  // ---- LOD config (mutable so setLodDistances() can update live) ----
  const lodConfig = {
    r0: o.lodR0 ?? 50,
    r1: o.lodR1 ?? 150,
    cells: [o.cellS0 ?? 1, o.cellS1 ?? 4, o.cellS2 ?? 16],
  };
  lodConfig.snaps = lodConfig.cells.map(c => c * 4);

  // ---- ring state ----
  const waterRings    = [null, null, null];   // { mesh, causticMesh, geometry, snapX, snapZ }
  const ringDirty     = [true, true, true];
  const pendingSnaps  = [null, null, null];   // { snapX, snapZ } queued for next processRingQueue
  let lastCamX = 0, lastCamZ = 0;

  function getRingDescriptor(n, snapX, snapZ) {
    const innerHalf = n === 0 ? 0 : (n === 1 ? lodConfig.r0 : lodConfig.r1);
    const outerExt  = o.extentX !== undefined
      ? Math.max(o.extentX, o.extentZ ?? o.extentX) * 0.5 + lodConfig.cells[2]
      : o.size * 0.5;
    const outerHalf = n === 0 ? lodConfig.r0 : (n === 1 ? lodConfig.r1 : outerExt);
    return { snapX, snapZ, innerHalf, outerHalf, cellSize: lodConfig.cells[n],
             extentX: o.extentX, extentZ: o.extentZ };
  }

  function disposeRing(n) {
    const r = waterRings[n];
    if (!r) return;
    if (r.mesh)        surface.remove(r.mesh);
    if (r.causticMesh) causticGroup.remove(r.causticMesh);
    if (r.geometry)    r.geometry.dispose();
    waterRings[n] = null;
  }

  function buildRing(n, snapX, snapZ) {
    disposeRing(n);
    const desc = getRingDescriptor(n, snapX, snapZ);
    const geometry = buildRingGeometry(o, desc);
    if (!geometry.index || geometry.index.count === 0) {
      geometry.dispose();
      waterRings[n] = { mesh: null, causticMesh: null, geometry: null, snapX, snapZ };
      return;
    }
    const mesh = new THREE.Mesh(geometry, surfaceMat);
    mesh.name = `WaterRing${n}`;
    mesh.renderOrder = 1;
    const causticMesh = new THREE.Mesh(geometry, causticMat);
    causticMesh.name = `WaterCausticRing${n}`;
    causticMesh.frustumCulled = false;
    surface.add(mesh);
    causticGroup.add(causticMesh);
    waterRings[n] = { mesh, causticMesh, geometry, snapX, snapZ };
    updateCausticProjection();
  }

  function checkSnaps(camX, camZ) {
    lastCamX = camX; lastCamZ = camZ;
    for (let n = 0; n < 3; n++) {
      const step = lodConfig.snaps[n];
      const sx = Math.round(camX / step) * step;
      const sz = Math.round(camZ / step) * step;
      const r  = waterRings[n];
      if (!r || r.snapX !== sx || r.snapZ !== sz) {
        pendingSnaps[n] = { snapX: sx, snapZ: sz };
        ringDirty[n]    = true;
      }
    }
  }

  function processRingQueue() {
    const start    = performance.now();
    const maxBuild = Math.max(1, Math.floor(o.maxBuildsPerFrame));
    let built = 0;
    for (let n = 0; n < 3 && built < maxBuild; n++) {
      if (!ringDirty[n] || !pendingSnaps[n]) continue;
      if (built > 0 && performance.now() - start >= o.buildBudgetMs) break;
      const { snapX, snapZ } = pendingSnaps[n];
      buildRing(n, snapX, snapZ);
      ringDirty[n]   = false;
      pendingSnaps[n] = null;
      built++;
    }
  }

  function updateCausticProjection() {
    if (o.extentX !== undefined) {
      const sz = Math.max(o.extentX, o.extentZ ?? o.extentX);
      updateCausticCamera(0, 0, sz);
      tsl_c_worldSizeG.value = sz;
      tsl_c_worldCenterG.value.set(0, 0);
    } else {
      updateCausticCamera(lastCamX, lastCamZ, o.size);
      tsl_c_worldSizeG.value = o.size;
      tsl_c_worldCenterG.value.set(lastCamX, lastCamZ);
    }
  }
```

- [ ] **Step 2: Verify the file saves with no syntax errors** — open browser dev console, confirm no parse error.

---

### Task 3: Wire rings into `update()`, `regenerate()`, `getStats()`, `setLodDistances()`, `dispose()`

**Files:**
- Modify: `water.js` (replace functions in the lower half of `createWaterSystem`)

- [ ] **Step 1: Replace `update()` (currently calls `processWaterBuildQueue`)**

Old:
```js
  function update(time) {
    processWaterBuildQueue();
    tsl_uTime.value = time;
    camera.updateMatrixWorld();
    // Caustic render: handled by CausticTextureNode.updateBefore() inside renderer.render().
  }
```

New:
```js
  function update(time) {
    tsl_uTime.value = time;
    camera.updateMatrixWorld();
    checkSnaps(camera.position.x, camera.position.z);
    processRingQueue();
  }
```

- [ ] **Step 2: Replace `regenerate()`**

Old (the entire `regenerate` function):
```js
  function regenerate(opts) {
    let rebuildExisting = false;
    if (opts) {
      if (opts.size !== undefined) o.size = opts.size;
      if (opts.waterLevel !== undefined && opts.waterLevel !== o.waterLevel) {
        o.waterLevel = opts.waterLevel;
        rebuildExisting = true;
      }
      if (opts.heightFn !== undefined && opts.heightFn !== o.heightFn) {
        o.heightFn = opts.heightFn;
        rebuildExisting = true;
      }
      if (opts.chunks !== undefined) o.chunks = opts.chunks;
    }
    if (rebuildExisting) {
      for (const chunk of waterChunks.values()) disposeWaterChunk(chunk);
      waterChunks.clear();
      waterBuildQueue = [];
      waterBuildQueueIndex = 0;
      waterBuildKeys.clear();
    }
    syncWaterChunks();
    surface.position.y = o.waterLevel;
    causticGroup.position.y = o.waterLevel;
    tsl_cBedRef.value = o.waterLevel - o.causticBedDepth;
    tsl_c_bedRefG.value = o.waterLevel - o.causticBedDepth;
    tsl_c_waterLevelG.value = o.waterLevel;
  }
```

New:
```js
  function regenerate(opts) {
    if (opts) {
      if (opts.waterLevel !== undefined) o.waterLevel = opts.waterLevel;
      if (opts.heightFn  !== undefined) o.heightFn   = opts.heightFn;
      if (opts.extentX   !== undefined) o.extentX    = opts.extentX;
      if (opts.extentZ   !== undefined) o.extentZ    = opts.extentZ;
      if (opts.lodR0     !== undefined) lodConfig.r0 = opts.lodR0;
      if (opts.lodR1     !== undefined) lodConfig.r1 = opts.lodR1;
    }
    for (let n = 0; n < 3; n++) {
      disposeRing(n);
      ringDirty[n] = true;
      const step = lodConfig.snaps[n];
      pendingSnaps[n] = { snapX: Math.round(lastCamX / step) * step, snapZ: Math.round(lastCamZ / step) * step };
    }
    surface.position.y       = o.waterLevel;
    causticGroup.position.y  = o.waterLevel;
    tsl_cBedRef.value        = o.waterLevel - o.causticBedDepth;
    tsl_c_bedRefG.value      = o.waterLevel - o.causticBedDepth;
    tsl_c_waterLevelG.value  = o.waterLevel;
    updateCausticProjection();
  }
```

- [ ] **Step 3: Replace `getChunkCount` / `getStats` and add `setLodDistances`**

Old `getChunkCount`:
```js
  function getChunkCount() { return waterChunks.size; }
```

New `getChunkCount`:
```js
  function getChunkCount() { return waterRings.filter(r => r?.mesh).length; }
```

Old `getStats` (entire function):
```js
  function getStats() {
    let waterTriangles = 0;
    let waterVertices = 0;
    for (const chunk of waterChunks.values()) {
      const g = chunk.geometry;
      const position = g.getAttribute?.('position');
      const index = g.getIndex?.();
      waterVertices += position?.count || 0;
      waterTriangles += index ? Math.floor(index.count / 3) : 0;
    }
    return {
      ...stats,
      chunks: waterChunks.size,
      pending: Math.max(0, waterBuildQueue.length - waterBuildQueueIndex),
      dry: Math.max(0, stats.candidates - waterChunks.size - Math.max(0, waterBuildQueue.length - waterBuildQueueIndex)),
      waterMeshes: waterChunks.size,
      causticMeshes: waterChunks.size,
      waterDraws: waterChunks.size,
      causticDraws: waterChunks.size,
      waterTriangles,
      causticTriangles: waterTriangles,
      waterVertices,
      version: WATER_VERSION,
    };
  }
```

New `getStats` + new `setLodDistances` (replace the old `getStats`):
```js
  function getStats() {
    const ringTris  = [0, 0, 0];
    const ringVerts = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
      const r = waterRings[n];
      if (!r?.geometry) continue;
      const pos = r.geometry.getAttribute?.('position');
      const idx = r.geometry.getIndex?.();
      ringVerts[n] = pos?.count ?? 0;
      ringTris[n]  = idx ? Math.floor(idx.count / 3) : 0;
    }
    const totalTris  = ringTris[0]  + ringTris[1]  + ringTris[2];
    const totalVerts = ringVerts[0] + ringVerts[1] + ringVerts[2];
    const minBed     = Math.min(...waterRings.map(r => r?.geometry?.userData?.minBed ?? Infinity));
    const meshCount  = waterRings.filter(r => r?.mesh).length;
    return {
      version: WATER_VERSION, waterLevel: o.waterLevel,
      ring0Tris:  ringTris[0],  ring1Tris:  ringTris[1],  ring2Tris:  ringTris[2],
      ring0Verts: ringVerts[0], ring1Verts: ringVerts[1], ring2Verts: ringVerts[2],
      waterTriangles: totalTris, waterVertices: totalVerts,
      waterMeshes: meshCount, causticMeshes: meshCount,
      waterDraws:  meshCount, causticDraws:  meshCount,
      chunks: meshCount, candidates: 3,
      pending: ringDirty.filter(Boolean).length,
      dry: 0, minBed,
    };
  }

  function setLodDistances(r0, r1) {
    lodConfig.r0 = r0;
    lodConfig.r1 = r1;
    for (let n = 0; n < 3; n++) {
      disposeRing(n);
      ringDirty[n] = true;
      const step = lodConfig.snaps[n];
      pendingSnaps[n] = { snapX: Math.round(lastCamX / step) * step, snapZ: Math.round(lastCamZ / step) * step };
    }
  }
```

- [ ] **Step 4: Replace `dispose()`**

Old:
```js
  function dispose() {
    for (const chunk of waterChunks.values()) disposeWaterChunk(chunk);
    waterChunks.clear();
    // surfaceMat.dispose() also cleans up tsl_reflector's internal RT (via node disposal).
    surfaceMat.dispose(); causticMat.dispose(); causticsTarget.dispose();
  }
```

New:
```js
  function dispose() {
    for (let n = 0; n < 3; n++) disposeRing(n);
    surfaceMat.dispose(); causticMat.dispose(); causticsTarget.dispose();
  }
```

- [ ] **Step 5: Update the `return` statement to expose `setLodDistances`**

Old:
```js
  return { surface, version: WATER_VERSION, update, resize, regenerate, setWaves, setCaustic, setReflectRate, setLightDir, getChunkCount, getStats, dispose };
```

New:
```js
  return { surface, version: WATER_VERSION, update, resize, regenerate, setWaves, setCaustic, setReflectRate, setLightDir, setLodDistances, getChunkCount, getStats, dispose };
```

- [ ] **Step 6: Remove the old `syncWaterChunks` (internal), `addWaterChunk`, `disposeWaterChunk`, `processWaterBuildQueue` and the initial `syncWaterChunks()` call at the bottom of `createWaterSystem`**

Delete these blocks entirely (they are dead code after the replacements above):
- `function disposeWaterChunk(chunk) { ... }`
- `function addWaterChunk(bounds) { ... }`
- `function syncWaterChunks() { ... }` (the internal one inside createWaterSystem, ~line 585)
- `function processWaterBuildQueue() { ... }`
- The standalone call `syncWaterChunks();` just before the `update` function (~line 653)

Also delete the top-level helper functions that are now unused:
- `function getChunkBounds(o) { ... }` (~line 232)
- `function getWorldProjection(bounds) { ... }` (~line 245)

- [ ] **Step 7: Verify browser — open `environment-viewer.html`, confirm water renders as three overlapping rings with no console errors. The rings will all be centred on (0,0) until `update()` is wired to the camera.**

---

### Task 4: Update `environment-viewer.html`

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Remove `lastWaterChunkSignature` declaration and rename `waterChunkSignature` to avoid confusion**

Old (~line 637):
```js
let lastWaterChunkSignature = '';
```
Delete that line.

Old (~line 722):
```js
function waterChunkSignature(chunks) {
  return chunks.map(c => c.key).sort().join('|');
}
```
Rename to `chunkSignature` (it is still used by `lastMapChunkSignature`):
```js
function chunkSignature(chunks) {
  return chunks.map(c => c.key).sort().join('|');
}
```

- [ ] **Step 2: Update `updateTerrainWindow` — remove all `syncWaterChunks` calls and fix the renamed function**

Old `updateTerrainWindow` body:
```js
function updateTerrainWindow(center) {
  terrainFocus.copy(center);
  updateSunShadowFocus(center);
  if (loadedMap) {
    const signature = waterChunkSignature(activeTerrainChunks());
    if (signature !== lastMapChunkSignature) {
      lastMapChunkSignature = signature;
      terrainDecorationsDirty = true;
      syncWaterChunks(true);
    } else if (waterRef && !lastWaterChunkSignature) {
      syncWaterChunks();
    }
    maybeSyncTerrainDecorations();
    return;
  }
  const terrainChanged = terrainSystem.update(center.x, center.z);
  if (terrainChanged) {
    ground = cdlodRef ? cdlodRef.mesh : terrainSystem.materialPatchTarget;
    terrainDecorationsDirty = true;
    syncWaterChunks(true);
  } else if (waterRef && !lastWaterChunkSignature) {
    syncWaterChunks();
  }
  maybeSyncTerrainDecorations();
}
```

New:
```js
function updateTerrainWindow(center) {
  terrainFocus.copy(center);
  updateSunShadowFocus(center);
  if (loadedMap) {
    const signature = chunkSignature(activeTerrainChunks());
    if (signature !== lastMapChunkSignature) {
      lastMapChunkSignature = signature;
      terrainDecorationsDirty = true;
    }
    maybeSyncTerrainDecorations();
    return;
  }
  const terrainChanged = terrainSystem.update(center.x, center.z);
  if (terrainChanged) {
    ground = cdlodRef ? cdlodRef.mesh : terrainSystem.materialPatchTarget;
    terrainDecorationsDirty = true;
  }
  maybeSyncTerrainDecorations();
}
```

- [ ] **Step 3: Update `maybeSyncTerrainDecorations` — remove `syncWaterChunks` call**

Old:
```js
function maybeSyncTerrainDecorations() {
  if (!terrainDecorationsDirty || terrainSystem.pendingBuildCount > 0) return;
  if (grassRef) grassRef.sync();
  syncWaterChunks(true);
  if (regenTrees) regenTrees(terrainDecorationsRebuildAll);
  terrainDecorationsRebuildAll = false;
  terrainDecorationsDirty = false;
}
```

New:
```js
function maybeSyncTerrainDecorations() {
  if (!terrainDecorationsDirty || terrainSystem.pendingBuildCount > 0) return;
  if (grassRef) grassRef.sync();
  if (regenTrees) regenTrees(terrainDecorationsRebuildAll);
  terrainDecorationsRebuildAll = false;
  terrainDecorationsDirty = false;
}
```

- [ ] **Step 4: Update `rebuildWorld` — replace `syncWaterChunks` with direct `regenerate`**

Old (~line 679):
```js
  if (waterRef) syncWaterChunks(true, { size: terrain.size });
```

New:
```js
  if (waterRef) waterRef.regenerate({
    waterLevel: terrain.waterLevel, heightFn: terrainHeight,
    ...(loadedMap ? { extentX: loadedMap.worldX, extentZ: loadedMap.worldZ } : {}),
  });
```

- [ ] **Step 5: Delete `waterChunkSignature` (old name), `syncWaterChunks` functions**

Delete entirely:
- `function waterChunkSignature(chunks) { ... }` (now replaced by `chunkSignature` in step 1)
- `function syncWaterChunks(force = false, extra = {}) { ... }`

- [ ] **Step 6: Update water creation block**

Old (~line 2040–2047):
```js
    Object.assign(params, { waterWaves: 1.0, caustics: 1.0, reflectRate: 1 });
    waterRef = createWaterSystem({
      renderer, scene, camera, ground,
      size: terrain.size, waterLevel: terrain.waterLevel, heightFn: terrainHeight,
      chunks: activeTerrainChunks(),
    });
    scene.add(waterRef.surface);
    syncWaterChunks(true);
```

New:
```js
    Object.assign(params, { waterWaves: 1.0, caustics: 1.0, reflectRate: 1, waterLodR0: 50, waterLodR1: 150 });
    waterRef = createWaterSystem({
      renderer, scene, camera, ground,
      size: terrain.size, waterLevel: terrain.waterLevel, heightFn: terrainHeight,
      ...(loadedMap ? { extentX: loadedMap.worldX, extentZ: loadedMap.worldZ } : {}),
      lodR0: params.waterLodR0, lodR1: params.waterLodR1,
    });
    scene.add(waterRef.surface);
```

- [ ] **Step 7: Add Water LOD sliders after the existing water sliders (~line 2052)**

After:
```js
    slider('reflectRate', 'Reflect every N frames', 1, 6, 1, fi, () => waterRef.setReflectRate(params.reflectRate));
```

Add:
```js
    header('Water LOD');
    const updateWaterLod = () => { if (waterRef) waterRef.setLodDistances(params.waterLodR0, params.waterLodR1); };
    slider('waterLodR0', 'Near radius', 10, 200, 5, fi, updateWaterLod);
    slider('waterLodR1', 'Mid radius', 30, 400, 5, fi, updateWaterLod);
```

- [ ] **Step 8: Update `syncWaterDebug` to use ring stats**

Old `syncWaterDebug` body (the non-early-return path, ~line 755–769):
```js
  const s = waterRef.getStats();
  terrainDebug.waterLoaded = true;
  terrainDebug.waterVersion = s.version || waterRef.version || '?';
  terrainDebug.waterChunks = s.chunks;
  terrainDebug.waterCandidates = s.candidates;
  terrainDebug.waterPending = s.pending || 0;
  terrainDebug.waterDry = s.dry || 0;
  terrainDebug.waterMeshes = s.waterMeshes || s.chunks || 0;
  terrainDebug.causticMeshes = s.causticMeshes || 0;
  terrainDebug.waterDraws = s.waterDraws || s.chunks || 0;
  terrainDebug.causticDraws = s.causticDraws || 0;
  terrainDebug.waterTriangles = s.waterTriangles || 0;
  terrainDebug.causticTriangles = s.causticTriangles || 0;
  terrainDebug.waterVertices = s.waterVertices || 0;
  terrainDebug.waterMinBed = s.minBed;
```

New:
```js
  const s = waterRef.getStats();
  terrainDebug.waterLoaded    = true;
  terrainDebug.waterVersion   = s.version || '?';
  terrainDebug.waterChunks    = s.chunks;
  terrainDebug.waterTriangles = s.waterTriangles || 0;
  terrainDebug.waterVertices  = s.waterVertices  || 0;
  terrainDebug.waterMinBed    = s.minBed;
  terrainDebug.ring0Tris      = s.ring0Tris  || 0;
  terrainDebug.ring1Tris      = s.ring1Tris  || 0;
  terrainDebug.ring2Tris      = s.ring2Tris  || 0;
  terrainDebug.waterPending   = s.pending    || 0;
```

- [ ] **Step 9: Update `terrainDebug` initial object (~line 383)**

Old:
```js
const terrainDebug = {
  grassChunks: 0, grassPending: 0,
  waterChunks: 0, waterCandidates: 0, waterPending: 0, waterDry: 0,
  waterMeshes: 0, causticMeshes: 0, waterDraws: 0, causticDraws: 0,
  waterTriangles: 0, causticTriangles: 0, waterVertices: 0,
  waterMinBed: Infinity, waterLoaded: false, waterVersion: '',
  treePlacements: 0, lastUpdate: 0, fps: 0, cpuMs: 0,
};
```

New:
```js
const terrainDebug = {
  grassChunks: 0, grassPending: 0,
  waterChunks: 0, waterPending: 0,
  waterTriangles: 0, waterVertices: 0,
  waterMinBed: Infinity, waterLoaded: false, waterVersion: '',
  ring0Tris: 0, ring1Tris: 0, ring2Tris: 0,
  treePlacements: 0, lastUpdate: 0, fps: 0, cpuMs: 0,
};
```

- [ ] **Step 10: Update the HUD water line (~line 447)**

Old:
```js
    `water ${terrainDebug.waterLoaded ? `${terrainDebug.waterVersion || '?'} ${terrainDebug.waterChunks}/${terrainDebug.waterCandidates} dry ${terrainDebug.waterDry} pending ${terrainDebug.waterPending} tris ${terrainDebug.waterTriangles.toLocaleString()} min ${Number.isFinite(terrainDebug.waterMinBed) ? terrainDebug.waterMinBed.toFixed(1) : '--'}` : 'not loaded'}\n` +
```

New:
```js
    `water ${terrainDebug.waterLoaded ? `${terrainDebug.waterVersion || '?'} r0:${terrainDebug.ring0Tris} r1:${terrainDebug.ring1Tris} r2:${terrainDebug.ring2Tris} tris ${terrainDebug.waterTriangles.toLocaleString()} pending ${terrainDebug.waterPending} min ${Number.isFinite(terrainDebug.waterMinBed) ? terrainDebug.waterMinBed.toFixed(1) : '--'}` : 'not loaded'}\n` +
```

- [ ] **Step 11: Update the perf snapshot object — replace chunk fields with ring fields (~lines 534–545)**

Old:
```js
      waterChunks: terrainDebug.waterChunks,
      waterCandidates: terrainDebug.waterCandidates,
      waterDry: terrainDebug.waterDry,
      waterPending: terrainDebug.waterPending,
      waterMeshes: terrainDebug.waterMeshes,
      causticMeshes: terrainDebug.causticMeshes,
      waterDraws: terrainDebug.waterDraws,
      causticDraws: terrainDebug.causticDraws,
      waterTriangles: terrainDebug.waterTriangles,
      causticTriangles: terrainDebug.causticTriangles,
      waterVertices: terrainDebug.waterVertices,
      waterMinBed: Number.isFinite(terrainDebug.waterMinBed) ? +terrainDebug.waterMinBed.toFixed(3) : null,
```

New:
```js
      waterPending: terrainDebug.waterPending,
      waterTriangles: terrainDebug.waterTriangles,
      waterVertices: terrainDebug.waterVertices,
      waterMinBed: Number.isFinite(terrainDebug.waterMinBed) ? +terrainDebug.waterMinBed.toFixed(3) : null,
      waterRing0Tris: terrainDebug.ring0Tris,
      waterRing1Tris: terrainDebug.ring1Tris,
      waterRing2Tris: terrainDebug.ring2Tris,
```

---

### Task 5: Visual verify and commit

- [ ] **Step 1: Open `environment-viewer.html` in browser**

Check in browser console for errors. Expected: no errors.

- [ ] **Step 2: Verify water renders correctly**

- Water surface visible over lake areas
- Moving the camera: water geometry updates (especially near ring should snap visibly at first, then settle)
- HUD shows `water cw4 r0:NNN r1:NNN r2:NNN tris NNN` with non-zero triangle counts
- Water LOD sliders appear and adjusting them rebuilds the rings

- [ ] **Step 3: Verify no regression in caustics, reflection, wave animation**

- Caustic light patterns visible on lakebed
- Reflection visible on water surface
- Waves animate (fragment-driven, unchanged)

- [ ] **Step 4: Save a version snapshot before committing**

```
cp environment-viewer.html versions/environment-viewer-before-water-clipmap-YYYYMMDD-HHMMSS.html
```
(Replace the timestamp with the actual current datetime.)

- [ ] **Step 5: Commit**

```bash
git add water.js environment-viewer.html
git commit -m "feat(water): replace chunk system with camera-following clipmap LOD

Three concentric square rings (near/mid/far) replace the terrain-chunk
water grid. Each ring snaps to its own camera-distance grid and rebuilds
independently. Authored maps pass extentX/Z instead of chunk arrays.
Removes syncWaterChunks, waterChunkSignature, lastWaterChunkSignature.
Adds setLodDistances() and Water LOD sliders."
```
