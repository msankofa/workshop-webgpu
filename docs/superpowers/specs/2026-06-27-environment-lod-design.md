# Environment LOD — Grass, Tree LOD, Cloud Layers

**Date:** 2026-06-27
**Branch:** sp1-webgpu-renderer-migration (or new branch)

---

## Overview

Three independent but thematically related improvements to the authored-map environment:

1. **Grass unification** — authored map switches to GPU compute grass via a baked height texture; player-centered radius, density gradient, and max-blade cap all become live sliders.
2. **Tree LOD** — four LOD rings (full → no shadow → coarse leaves → billboard); each transition distance is a slider; billboard atlases baked once and cached in IndexedDB; cross-quad vs 8-angle toggle.
3. **Cloud layers** — both layers camera-follow; layer 1 gets an Extent slider; layer 2 is a second independent Clouds instance with its own full set of sliders.

---

## 1. Grass Unification

### Problem

Authored maps use `grass.js` (CPU chunk-based) because `grass-compute.js` hardcodes a closed-form TSL terrain height formula that doesn't work for arbitrary authored meshes. The chunk system lacks world-unit radius, configurable cull gradient, and a blade cap.

### Solution: Height Texture Bake

At authored-map load time, sample `terrainHeight(x, z)` across the map's world bounds into a `Float32Array` (512 × 512). Upload as a `DataTexture` (format: `RedFormat`, type: `FloatType`). Store as `loadedMap.heightTex` + `loadedMap.heightTexBounds` (`{minX, minZ, worldX, worldZ}`).

`grass-compute.js` receives an optional `heightTex` + `heightTexBounds` opts pair. When present, the TSL height node does a UV lookup:

```
uv = (worldXZ - boundsMin) / boundsSize   // [0,1]²
height = texture2D(uHeightTex, uv).r
```

The closed-form sine formula remains the default when `heightTex` is absent (procedural terrain unchanged).

### Cull Gradient

Replace the hardcoded 80%-of-radius dither with a configurable `uCullStart` uniform. Per-blade survival:

```
dist < uRadius
  AND height > uWaterMin
  AND rand > remap(dist, uCullStart, uRadius, 0, 1)
```

Blades inside `uCullStart` always survive. Beyond it, keep-probability descends linearly to 0 at `uRadius`. Pure density thinning — no alpha changes.

### Max Blades Cap

`uMaxBlades` (u32 uniform). The `atomicAdd` write is guarded: only proceed if the current counter value is below `uMaxBlades`. Prevents the survivor buffer from exceeding a target count regardless of density × area.

### Removed

- `grass.js` authored-map branch (`if (loadedMap || GRASS_MODE === 'cpu')`)
- `mapGrassRadiusChunks` slider
- The `?grass=cpu` authored-map fallback (procedural terrain keeps its own cpu fallback if ever needed)

### New Sliders (Grass panel, authored map + procedural)

| Slider | Key | Range | Default |
|---|---|---|---|
| Radius | `grassRadius` | 8–600 wu | 200 |
| Cull start | `grassCullStart` | 0–Radius | 150 |
| Density | `grassDensity` | 0–16 blades/m² | 8 |
| Max blades | `grassMaxBlades` | 10k–500k | 200k |

---

## 2. Tree LOD System

### LOD Rings

| LOD | Distance | Mesh types drawn |
|---|---|---|
| 0 | < R0 | branches + leaves (full) + shadow |
| 1 | R0–R1 | branches + leaves (full) |
| 2 | R1–R2 | branches + coarse leaves |
| 3 | > R2 | billboard |

Default distances: R0 = 60, R1 = 120, R2 = 220 (world units). All three are live sliders.

### `forest-gpu.js` Cull Kernel Changes

**Counters:** Each variant `g` gets 4 atomic survivor counters: `survCounters[g*4 + lod]`.

**Draw buffer layout:** Each variant gets 4 regions of `CAP` slots in the draw buffer:
```
variant g, LOD l → slots [(g*4 + l)*CAP, (g*4 + l)*CAP + CAP)
```

**Kernel:** Reads tree distance, computes LOD (0–3 via three threshold comparisons), atomicAdds into `survCounters[g*4+lod]`, writes instance record to the corresponding draw buffer region.

**Finalize:** One dispatch per variant; reads 4 counters, writes 8 indirect buffers per variant: branches-L0, leaves-L0, shadow-L0, branches-L1, leaves-L1, branches-L2, coarseLeaves-L2, billboard-L3.

**Uniforms added:** `uLodR0`, `uLodR1`, `uLodR2` (float, live).

### Coarse Leaf Geometry (LOD 2)

`createForestPalette` bakes a `leavesCoarse` geometry per variant alongside the existing `branches`, `leaves`, `shadow`. It calls `createTree` with:
- `leafCount = Math.round(params.leafCount * coarseLeafRatio)`
- `leafSize = params.leafSize * coarseLeafSizeMult`

All other tree params unchanged.

**Temporary tuning sliders** (removed once ideal values found):

| Slider | Key | Range | Default |
|---|---|---|---|
| Coarse leaf ratio | `coarseLeafRatio` | 0.05–0.6 | 0.25 |
| Coarse leaf size mult | `coarseLeafSizeMult` | 1.0–5.0 | 2.5 |

Changing either slider triggers `rebuildForestGPU` (palette rebake). Does not invalidate billboard cache (billboards bake from LOD 0 geometry only).

### Billboard Bake

**Trigger:** After `rebuildForestGPU` completes and the palette is ready.

**Cache key:** Deterministic string concatenating `masterSeed|leafCount|leafSize|species|diversity|generalization|variantsPerSpecies` — stored as the IndexedDB key.

**Store:** IndexedDB database `"forest-billboards"`, one entry per `{key, mode}` pair where `mode` is `"cross"` or `"8way"`. Value: array of PNG `Blob`s, one per variant.

**Bake process (per variant):**
1. Create an offscreen `WebGLRenderTarget` (or WebGPU equivalent), e.g. 256×512 per tile.
2. Render the full-quality variant mesh (LOD 0 geometry) to the target.
   - *Cross-quad*: one front-facing render (camera at +Z, orthographic).
   - *8-angle atlas*: 8 renders at yaw 0°, 45°, …, 315°; packed into a 4×2 atlas.
3. `renderer.readRenderTargetPixels` → canvas → `canvas.toBlob('image/png')`.
4. Store blob in IndexedDB.

**Load process:** On startup, check IndexedDB for matching key+mode. If found, skip bake, load PNG → `THREE.TextureLoader` → assign to billboard material. If not found, run bake.

**Toggle:** Panel toggle `billboardMode` (`"cross"` / `"8way"`). Switching re-checks IndexedDB for the other mode; if cached, swaps material texture immediately. If not cached, triggers bake for that mode. No re-bake of the other mode.

**Billboard draw mesh (per variant):**
- Geometry: `PlaneGeometry(1, 1)` (single quad).
- Material: `MeshBasicNodeMaterial`, `side: DoubleSide`, `transparent: true`, `alphaTest: 0.5`.
- *Cross-quad mode*: one instance per tree; geometry is a pre-built 2-quad mesh (two `PlaneGeometry` quads crossed at 90° in a single `BufferGeometry`). Indirect count = survivors.
- *8-angle mode*: one instance per tree; vertex shader computes camera-tree yaw angle, maps to atlas tile UV.

### New Sliders (Trees panel)

| Slider | Key | Range | Default |
|---|---|---|---|
| LOD 0→1 dist | `treeLodR0` | 10–300 wu | 60 |
| LOD 1→2 dist | `treeLodR1` | 20–400 wu | 120 |
| LOD 2→3 dist | `treeLodR2` | 40–600 wu | 220 |
| Coarse leaf ratio | `coarseLeafRatio` | 0.05–0.6 | 0.25 |
| Coarse leaf size | `coarseLeafSizeMult` | 1.0–5.0 | 2.5 |
| Billboard mode | `billboardMode` | cross / 8-way toggle | cross |

---

## 3. Cloud Layers

### Camera-Following

Both `Clouds` instances: each frame, `cloudsRef.position.x = camera.position.x; cloudsRef.position.z = camera.position.z`. Y stays at configured height. The existing horizon fade (`length(positionWorld)`) continues to work correctly since the fade is distance-from-origin and the quad moves with the camera.

### Extent Slider

`Clouds` gets `setExtent(wu)` which sets `this.scale.x = this.scale.z = wu / 2000` (normalised to the current hardcoded 2000 base). Layer 1 default extent: 2000. Layer 2 default extent: 4000.

### Layer 1 (existing, enhanced)

Adds **Extent** slider. All other existing sliders unchanged (Height, Coverage, Puff, Softness, Opacity, Fade, Speed). Speed and Softness are already per-instance.

### Layer 2 (new `Clouds` instance)

Fully independent second instance. Its own sliders:

| Slider | Key | Range | Default |
|---|---|---|---|
| Height | `cloud2Height` | 20–600 wu | 280 |
| Extent | `cloud2Extent` | 500–8000 wu | 4000 |
| Coverage | `cloud2Cover` | 0–0.9 | 0.3 |
| Puff size | `cloud2Puff` | 0.3–6 | 3.0 |
| Softness | `cloud2Softness` | 0.05–0.5 | 0.3 |
| Opacity | `cloud2Opacity` | 0–1 | 0.5 |
| Speed | `cloud2Speed` | 0–4 | 0.6 |

Both layers drift independently (`_scaledTime` is already per-instance in `Clouds`).

---

## Files Changed

| File | Change |
|---|---|
| `grass-compute.js` | Add `heightTex`/`heightTexBounds` opts; `uCullStart`; `uMaxBlades` |
| `forest-gpu.js` | 4 LOD counters/regions/indirect; `uLodR0/R1/R2`; billboard mesh + material |
| `forest-palette.js` | Bake `leavesCoarse` geometry per variant; accept `coarseLeafRatio/SizeMult` |
| `clouds.js` | Add `setExtent()` |
| `environment-viewer.html` | Height texture bake on map load; remove grass.js branch; camera XZ copy to both cloud layers in animate loop; new sliders for all three systems; billboard bake/cache/toggle logic |

---

## Out of Scope

- Grass LOD (blade height/complexity reduction at distance) — not requested
- Tree wind/animation at LOD 1–2 — unchanged from current
- Procedural terrain tree changes — authored map only for LOD (procedural keeps current maxDist cull)
- Water/particle changes
