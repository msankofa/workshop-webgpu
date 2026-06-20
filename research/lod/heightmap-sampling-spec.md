# Heightmap-Sampled Terrain Displacement — Spec

**Status:** Design spec with initial data-path groundwork. Gates the `experimentalInstancedTerrain` flag — terrain displacement stays gated off until the acceptance criteria below are met.

**Goal:** Render terrain as one (or few) shader-displaced grids instead of one mesh per chunk, with **height parity guaranteed by construction** — the GPU samples a float heightmap that JS fills from `terrainHeightAt()`, so the GPU never re-implements the height function.

**Why this and not an analytic GLSL port:** The first instanced prototype ported `terrainHeightAt` into GLSL by hand. The base sine sum ports exactly, but the **lake term diverged**: JS `lakeHash` is an integer hash (`Math.imul`/XOR/`>>>`), while the GLSL used a generic `fract(sin(dot()))` hash — a different function. Result: lakes in the wrong places, errors of order `lakeDepth` (3.2), and a visual-vs-collision mismatch. Heightmap sampling eliminates this entire class of bug: the texture is the real field, so the only divergence is bilinear reconstruction error, which is tiny and bounded (below).

---

## Parity is solved — evidence

`test-terrain-heightmap-parity.mjs` emulates the GPU's bilinear texture fetch in JS (GPU `LINEAR` filtering is a specified weighted average of 4 texels) and measures the error vs analytic `terrainHeightAt` over a 240×240 region including lakes:

| u/texel | texels/chunk | max err | p99.9 | rms |
|---|---|---|---|---|
| 2.0 | 16² | 0.69 | 0.50 | 0.067 |
| **1.3 (= today's mesh)** | 23² | **0.35** | 0.26 | 0.031 |
| 1.0 | 24² | 0.25 | 0.17 | 0.019 |
| **0.5 (recommended)** | 61² | **0.075** | 0.049 | 0.005 |
| 0.25 | 121² | 0.019 | 0.012 | 0.001 |

Key facts this establishes:
- **The current chunk mesh already has ~0.35 worst-case visual-vs-analytic deviation** (it linearly interpolates height between ~1.3u vertices; collision uses the analytic field). The world looks correct at that level — so it is the *tolerance the heightmap must not exceed*.
- A heightmap at **0.5 u/texel (≈64×64 per 30u chunk)** gives **max 0.075 / p99.9 0.049** — ~4–5× better than today's mesh, visually imperceptible, and well under the ~0.1 that would let a creature visibly float/sink.
- Error converges **quadratically** with texel spacing, so finer is always strictly safe. 0.5 u/texel is the recommended density; 0.25 is available if any artifact ever appears.

**This test is the un-gate gate** (see Acceptance). It needs no GPU — it predicts GLSL output exactly because float-texture bilinear filtering is fully specified.

---

## Data model

- **Per-chunk heightmap tiles**, one float texture per terrain chunk, packed into an **atlas** (or a `DataArrayTexture` / texture array) so a single instanced draw can address all visible tiles via a per-instance atlas index.
- **Resolution:** 0.5 u/texel → 61 texels across a 30u chunk; round up to **64×64** per tile.
- **Format:** **R16F** (half-float, single channel). Linear filtering of R16F is core in WebGL2 (`THREE.WebGLRenderer` r160 / WebGL2). Half-float quantization at our height range (±~5) is ~0.005 — an order of magnitude below the 0.075 interpolation error, so negligible. *Do not* use 8-bit (quantization ~0.04+ and needs encode/decode). Use R32F only if a target platform lacks R16F linear filtering (it costs 2× memory; `OES_texture_float_linear` is required for R32F linear).
- **Sampler state:** `LINEAR` min/mag, `CLAMP_TO_EDGE`, no mipmaps.
- **Tile apron for seamlessness:** each tile covers its 30u chunk **plus a 1-texel apron on every side**, and the world→uv mapping places texel *centers* on the sample grid so that the shared edge between adjacent tiles samples **identical world positions**. Because both tiles fill from the same deterministic `terrainHeightAt`, the shared-edge texels are bit-identical → the bilinear result at the seam matches from both sides. The symmetric apron also lets heightmap-derived normals use one-texel taps at both low and high chunk edges without clamping. This is covered by `test-terrain-tile-seam.mjs`.

---

## Generation — and where the CPU win finally lands

- The **worker** fills a tile's `Float32Array` heightmap (just `64×64` height evals) instead of building full per-chunk geometry (positions+normals+uvs+index ≈ `24²×8` floats + index). This is **less work and a smaller transfer**, and it removes the per-chunk `BufferGeometry` allocation churn on the main thread — directly fixing the "instanced mode still builds every chunk" waste flagged in the prototype review, and the panning jitter it caused.
- `buildHeightTile(xMin, zMin, size, texelWorld, params, apron)` exists in `terrain-field.js` (mirrors `buildChunkArrays` but emits only the height grid). `sampleHeightTileBilinear(...)` mirrors the shader's `LINEAR` fetch for tests. The worker has a `jobType: 'heightTile'` path returning the `Float32Array` as a transferable; the future main-thread heightmap renderer wraps it in a `DataTexture`/atlas region (`type: HalfFloatType` after a Float32→Float16 pack, or upload as Float32 and let the driver convert).
- One shared displaced grid geometry (a `PlaneGeometry(chunkSize, chunkSize, S, S)`, `S` chosen for silhouette quality, independent of texel density) is instanced once per visible tile; each instance carries its world translation + atlas index.

---

## Shader (sketch — not final)

Inject via `material.onBeforeCompile` on a `MeshStandardMaterial` so lighting/shadows are inherited.

Vertex:
```glsl
// per-instance: instanceMatrix (translation), aAtlasIndex (or per-instance uv rect)
vec4 worldXZ = instanceMatrix * vec4(position, 1.0);
vec2 uv = tileUv(worldXZ.xz, aAtlasRect);       // world -> tile uv, half-texel correct
float h = texture2D(uHeightAtlas, uv).r;        // bilinear fetch == JS bilinear (parity)
transformed = vec3(position.x, h, position.z);  // project_vertex applies instanceMatrix
```
Normal — **from the heightmap, not analytic** (so it matches the displaced surface and never reintroduces the lake-hash mismatch):
```glsl
float texel = uTexelWorld;                       // world units per texel
float hL = texture2D(uHeightAtlas, tileUv(worldXZ.xz + vec2(-texel,0), rect)).r;
float hR = texture2D(uHeightAtlas, tileUv(worldXZ.xz + vec2( texel,0), rect)).r;
float hD = texture2D(uHeightAtlas, tileUv(worldXZ.xz + vec2(0,-texel), rect)).r;
float hU = texture2D(uHeightAtlas, tileUv(worldXZ.xz + vec2(0, texel), rect)).r;
objectNormal = normalize(vec3(hL - hR, 2.0 * texel, hD - hU));
```
This central-difference normal is seamless across tiles for the same reason heights are (shared edge texels identical), as long as the neighbour taps can reach across the tile apron — hence the 1-texel apron.

---

## CPU / consumer parity decision

- **Collision, grass placement, tree shore-rejection keep using analytic `getHeight` (`terrainHeightAt`).** It is cheap and exact, and the resulting visual-vs-collision mismatch equals the bilinear reconstruction error: **≤0.075 at 0.5 u/texel — smaller than the ~0.35 the current chunk mesh already exhibits.** No regression; no re-plumbing of consumers.
- *Alternative (deferred):* route `getHeight` through the same CPU bilinear sampler for *exact* CPU/GPU agreement. Only worth it if 0.075 ever proves visible. Adds heightmap retention + sampling cost on the CPU side. Not recommended for v1.

---

## Integration & the gate

- Built on the existing **gated** `experimentalInstancedTerrain` path in `terrain-system.js`. Production stays `renderMode: 'chunks'` until acceptance passes.
- **Fix `materialPatchTarget` (prototype bug):** in instanced/heightmap mode it currently returns a (non-rendered) chunk mesh using `this.material`, while the visible terrain uses the instanced material. The water system patches `materialPatchTarget`'s material for caustics/shadow projection, so caustics land on the invisible material. `materialPatchTarget` must return the **rendered** terrain (instanced grid + `instancedMaterial`) in this mode. This is part of acceptance (verify caustics on the lakebed).

---

## Acceptance criteria (un-gate checklist)

Un-gate `experimentalInstancedTerrain` only when ALL hold:
1. `node test-terrain-heightmap-parity.mjs` passes at the chosen resolution (0.5 u/texel) — **the parity guarantee**.
2. `node test-terrain-tile-seam.mjs` passes: adjacent tiles' shared-edge height samples and heightmap-derived normals agree within float precision under the symmetric-apron world→uv mapping.
3. **Visual:** no seams between tiles; lake shores match the analytic field; creatures sit on the ground (spot-check visual vs `getHeight` ≤ 0.1).
4. **Water caustics/shadows are visible on the terrain** (the `materialPatchTarget` fix).
5. **`perfStats`:** terrain draw calls flat vs draw distance; **no new main-thread hitch** while streaming (worker fills heightmaps, main thread only uploads textures — confirm `geom`/jitter improve vs the chunk baseline, not just draw calls).
6. Existing suites stay green: `test-terrain-field`, `test-terrain-system`, `test-terrain-instanced`.

---

## Risks / open questions

- **R16F linear filtering** — core in WebGL2; verify on the target renderer. Fallback R32F (`OES_texture_float_linear`, 2× memory). Hard-require WebGL2; do not fall back to 8-bit packing.
- **Atlas vs texture-array indexing per instance** — three.js `InstancedMesh` needs a per-instance attribute (atlas rect or array layer). A `DataArrayTexture` (one layer per tile) is cleanest; verify instanced sampling of a specific layer in the injected shader.
- **Seam UV math (half-texel)** — the dominant failure mode; gated by acceptance #2.
- **Normal epsilon** — central-diff uses one texel spacing; near tile edges it must read into the apron, else the normal seams. Apron sizing must cover the normal taps (≥1 texel).
- **`frustumCulled=false` instanced grid** draws all tiles always (1 call, no culling). Fine to dd~6; at dd12 (625 tiles) it's ~625× the grid's vertex work always. If that bites, add per-instance frustum culling (CPU rebuild of the instance list per move, or GPU indirect later in Rung 4).
- **Strategic expectation:** the last `perfStats` trace showed instanced terrain only buys ~+15–30% fps at dd6 because **grass + trees dominate**. Finish this for correctness, the CPU/jitter win, and the modest draw-call win — but the dominant remaining cost is grass (a separate GPU-compute effort; naive grass mesh grouping already regressed and is ruled out).

---

## File structure (expand into bite-sized tasks when building)

- `terrain-field.js` — **done:** `buildHeightTile(xMin, zMin, size, texelWorld, params, apron)` and `sampleHeightTileBilinear(...)`.
- `terrain-worker.js` — **done:** handles `jobType: 'heightTile'` and returns the `Float32Array` heightmap transferable.
- `terrain-heightmap.js` (new) — atlas/`DataArrayTexture` management, tile upload, the displaced instanced grid, the `onBeforeCompile` injection, `materialPatchTarget` returning the rendered terrain.
- `terrain-system.js` — when `experimentalInstancedTerrain` + heightmap mode: drive `terrain-heightmap.js` instead of building per-chunk render geometry; keep colliders (analytic) for the ~9 collision chunks; keep `activeChunks` from chunk bounds (no render geometry needed).
- `test-terrain-heightmap-parity.mjs` — **done** (reconstruction error / resolution gate).
- `test-terrain-tile-seam.mjs` — **done:** shared-edge height and normal agreement under the symmetric-apron UV scheme (acceptance #2).
- `test-terrain-worker-heighttile.mjs` — **done:** mocked browser-worker smoke test for the `heightTile` worker job.
