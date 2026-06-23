# SP6 GPU-Instanced Forest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`). GPU/TSL tasks end at a **browser checkpoint** (WebGPU can't run headless here); expect 1–3 reload iterations per GPU module (project constraint).

**Goal:** Replace the main-thread per-chunk forest baking with a GPU-instanced palette behind `?forest=gpu` (default): pre-bake a palette of tree variants once, instance them from CPU placement records, GPU-cull per frame, and draw via per-variant indirect draws so forest draw/triangle cost is flat vs draw distance.

**Architecture:** Reuse the SP2 grass spine (compute reset→cull→finalize → atomic counter → `IndirectStorageBufferAttribute` → indirect draw), but feed it CPU-computed instance transforms (placement is cheap; only geometry generation was expensive) instead of compute-generated ones. Placement and species logic are extracted from the viewer into pure, Node-tested modules shared with the future worker path. The existing baked forest stays as `?forest=baked` (temporary A/B baseline; the worker plan later replaces it with `?forest=worker`).

**Tech Stack:** ES modules, Node 20 (logic twins), Three.js r0.184 `three/webgpu` + `three/tsl`, `IndirectStorageBufferAttribute`/`StorageInstancedBufferAttribute`.

---

## Scope of THIS plan
GPU path only (`?forest=gpu`) + the shared placement/species/cull extraction it needs. The **worker path** (`?forest=worker`) is a separate plan. After this plan the flag is `?forest=gpu` (new, default) | `?forest=baked` (existing main-thread path, kept as the A/B baseline).

## Verified facts (from the code)
- Placement helpers live in the `trees.js` import closure in `environment-viewer.html`: `rngFrom`/`hash2` (`:547-556`), `buildSpecies`/`toOptions`/`hsl` (`:565-602`), the per-chunk `placementsForChunk` (`:677`), `sizeFor` (`:618`), and per-tree yaw `treeRng.next()*2π` + `s = sizeFor(...)` (`:826-828`). Tree base offset is `params.treeBaseOffset` (`:828`).
- Generator: `gen = createTree({seed})`; `gen.regenerate(opts)` then `gen.branchesMesh.geometry` / `gen.leavesMesh.geometry` / `gen.leavesShadowMesh.geometry` are `BufferGeometry`.
- Materials: `branchMat` = `MeshStandardNodeMaterial({vertexColors:true})`, `leafMat` = `MeshStandardMaterial({vertexColors:true, side:DoubleSide})`.
- Forest sync entry: `regenTrees(rebuildAll)` called from `maybeSyncTerrainDecorations` (`:415`); built off `terrainSystem.activeChunks`, disposed on unload (`regenerate()` `:859-891`, `disposeTreeChunk` `:744`).
- SP5b trunk registration consumes `{x, z, r=1.2·scale}` per chunk; it must keep working in the gpu path.
- Grass template: `grass-compute.js` — buffer creation (`:81-87`), compute kernels (`:122-163`), indirect draw wiring (`:166-168`), awaited `computeAsync` chain (`:215-221`).

## File structure
- `forest-placement.js` (NEW) — pure: `rngFrom`, `hash2`, species builder, and `placementRecords(chunks, params, heightAt)` → `[{x,z,scale,yaw,speciesIdx,chunkKey,slot}]`. No three.js. Node-tested.
- `forest-cull.js` (NEW) — pure: `cullInstance(rec, cam, frustumPlanes, maxDist)` → bool (frustum+distance). Node-tested twin of the TSL cull.
- `forest-palette.js` (NEW) — browser: bake `VARIANTS` geometries per species via the generator; expose `{ variants:[{branches,leaves,shadow,speciesIdx}], branchMat, leafMat }`.
- `forest-gpu.js` (NEW) — browser: per-variant instance buffers from records + GPU cull compute + per-variant indirect draws; `{ meshes, update(camera), setChunk(key,recs), clearChunk(key), stats }`.
- `environment-viewer.html` (MODIFY) — `FOREST_MODE` flag; route placement records; keep baked path as `baked`; feed SP5b trunks from records; HUD/perf fields.

---

## Task 1: Extract placement records (pure, Node-tested)

**Files:** Create `forest-placement.js`, `test-forest-placement.mjs`.

- [ ] **Step 1: Failing test** — `test-forest-placement.mjs`:

```javascript
import { placementRecords } from './forest-placement.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// flat ground at y=0 everywhere (dry); one 30-unit chunk at origin.
const heightAt = () => 0;
const chunks = [{ key: '0,0', xMin: 0, zMin: 0, size: 30, centerX: 15, centerZ: 15 }];
const params = { count: 12, placement: 'random', species: 3, diversity: 0.5, generalization: 0.5,
  maxSize: 0.55, sizeVar: 0.6, skew: 0, shoreMargin: 0.1, treeBaseOffset: -0.1, masterSeed: 20260616, waterLevel: -0.9 };

const a = placementRecords(chunks, params, heightAt);
const b = placementRecords(chunks, params, heightAt);
ok(a.length > 0 && a.length <= 12, '1: places up to count trees');
ok(JSON.stringify(a) === JSON.stringify(b), '1: deterministic for same seed/params');
ok(a.every(r => r.x >= 0 && r.x <= 30 && r.z >= 0 && r.z <= 30), '1: within chunk bounds');
ok(a.every(r => typeof r.scale === 'number' && r.scale > 0), '1: positive scale');
ok(a.every(r => r.speciesIdx >= 0 && r.speciesIdx < params.species), '1: valid speciesIdx');
ok(a.every(r => typeof r.yaw === 'number'), '1: has yaw');

// water rejection: ground below waterLevel+shoreMargin → no placements.
const wet = placementRecords(chunks, { ...params }, () => -5);
ok(wet.length === 0, '1: rejects submerged ground');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2:** `node test-forest-placement.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement** `forest-placement.js` by lifting the existing logic verbatim from `environment-viewer.html` (so behavior is identical) into pure functions:
  - Copy `rngFrom` (`:547-551`) and `hash2` (`:552-556`) verbatim.
  - Copy `hsl`/`toOptions`/`buildSpecies` (`:565-602`) verbatim, but change `hsl` to return a hex number (already does) and keep `THREE.Color` out by computing HSL→hex with a tiny inline helper (no three.js). Use this HSL→hex:

```javascript
function hslHex(h, s, l) {
  h = ((h % 1) + 1) % 1; l = Math.min(0.7, Math.max(0.12, l));
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const to = v => Math.round(v * 255);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}
```

  - Implement `sizeFor(params, rng)`: copy the existing body of `sizeFor` (`environment-viewer.html:618`); it returns a scalar scale from `maxSize`/`sizeVar`/`skew` and the rng. (Read `:618` and transcribe exactly.)
  - Implement `placementRecords(chunks, params, heightAt)`: port the per-chunk loop of `placements` (`:605-...`) — same `base + extra` distribution across chunks, same `ring`/`clustered`/`scattered`/`random` branches, same `keepDry` using `heightAt(x,z) >= params.waterLevel + params.shoreMargin`. For each kept point, derive the same per-tree rng the bake uses (`rngFrom((hash2(ix,iz, masterSeed + slot*1013)*0xffffffff ^ Math.imul(slot+1, 2654435761)) >>> 0)`, per `:806`), then `speciesIdx = floor(treeRng.next() * species)`, `scale = sizeFor(params, ..., treeRng)`, `yaw = treeRng.next() * 2π`. Push `{x, z, scale, yaw, speciesIdx, chunkKey: chunk.key, slot}`.

- [ ] **Step 4:** `node test-forest-placement.mjs` → expect `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add forest-placement.js test-forest-placement.mjs
git commit -m "$(printf 'SP6: extract pure placement-record + species module (Node-tested)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2: Cull twin (pure, Node-tested)

**Files:** Create `forest-cull.js`; extend `test-forest-placement.mjs` or new `test-forest-cull.mjs`.

- [ ] **Step 1: Failing test** — `test-forest-cull.mjs`:

```javascript
import { cullInstance } from './forest-cull.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// Camera at origin looking down -Z; a single far-plane distance test + in-front test.
const cam = { x: 0, z: 0 };
const maxDist = 100;

ok(cullInstance({ x: 0, z: -20 }, cam, maxDist) === true,  '2: in range kept');
ok(cullInstance({ x: 0, z: -200 }, cam, maxDist) === false, '2: beyond maxDist culled');
ok(cullInstance({ x: 80, z: -80 }, cam, maxDist) === false, '2: diagonal beyond radius culled');
ok(cullInstance({ x: 60, z: -60 }, cam, maxDist) === true,  '2: diagonal within radius kept');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

> Note: v1 cull is **distance-only** (camera-centered radius), matching the grass cull which found per-instance frustum culling unnecessary (SP2 result). This keeps the twin simple and the GPU kernel a direct transcription. Frustum culling can be added later if a trace shows it helps.

- [ ] **Step 2:** `node test-forest-cull.mjs` → FAIL.

- [ ] **Step 3: Implement** `forest-cull.js`:

```javascript
// forest-cull.js — pure cull predicate for forest instances. v1 is camera-centered
// distance culling (mirrors the SP2 grass result that per-instance frustum culling was
// unnecessary). The TSL compute in forest-gpu.js transcribes this exactly.
export function cullInstance(rec, cam, maxDist) {
  const dx = rec.x - cam.x, dz = rec.z - cam.z;
  return dx * dx + dz * dz <= maxDist * maxDist;
}
```

- [ ] **Step 4:** `node test-forest-cull.mjs` → expect `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add forest-cull.js test-forest-cull.mjs
git commit -m "$(printf 'SP6: pure forest cull twin (distance) + Node test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3: Palette baking (`forest-palette.js`) — browser checkpoint

**Files:** Create `forest-palette.js`. Modify `environment-viewer.html` (temporary dev harness only if needed).

- [ ] **Step 1: Implement** `forest-palette.js`:

```javascript
// forest-palette.js — bake a fixed set of tree variant geometries ONCE. The expensive
// procedural generation runs species×VARIANTS times total (not per tree per chunk).
import { buildSpecies } from './forest-placement.js';
import { rngFrom } from './forest-placement.js';

export function createForestPalette({ createTree, params, masterSeed, variantsPerSpecies = 4 }) {
  const gen = createTree({ seed: 1 });
  const rng = rngFrom(masterSeed);
  const species = buildSpecies(params, rng);            // same species the placement uses
  const variants = [];
  for (let s = 0; s < species.length; s++) {
    for (let v = 0; v < variantsPerSpecies; v++) {
      const seed = Math.floor(rngFrom(masterSeed + s * 977 + v * 131).next() * 0xffffffff) >>> 0;
      gen.regenerate({ ...species[s], seed,
        leaves: { ...species[s].leaves, count: Math.max(0, Math.floor(params.leafCount ?? 10)) } });
      variants.push({
        speciesIdx: s,
        branches: gen.branchesMesh.geometry.clone(),
        leaves:   gen.leavesMesh.geometry.clone(),
        shadow:   gen.leavesShadowMesh.geometry.clone(),
      });
    }
  }
  return { variants, variantsPerSpecies, speciesCount: species.length };
}
```

> `buildSpecies`/`rngFrom` must be `export`ed from `forest-placement.js` (Task 1) — add the exports there if not already.

- [ ] **Step 2: Browser checkpoint (dev harness).** Temporarily, in the viewer, log `createForestPalette({createTree, params, masterSeed: MASTER_SEED}).variants.length` and add the first variant's `branches` as a `THREE.Mesh(geo, branchMat)` at origin. Reload `http://localhost:8001/environment-viewer.html`. Confirm: a tree renders; variant count = `species × variantsPerSpecies`. Remove the harness.

- [ ] **Step 3: Commit**

```bash
git add forest-palette.js
git commit -m "$(printf 'SP6: forest palette - bake N variant geometries per species once\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 4: GPU instance buffers + cull + indirect draws (`forest-gpu.js`) — browser checkpoint

**Files:** Create `forest-gpu.js`.

This task adapts `grass-compute.js` verbatim in structure. Per **variant** keep: a GPU-resident instance buffer (filled from CPU records on chunk change), a survivor counter, an indirect-args buffer, and 3 instanced draws (branches/leaves/shadow) that read the survivor list.

- [ ] **Step 1: Scaffold the per-variant buffers.** For each variant create (mirroring `grass-compute.js:81-87`):
  - `instAttr = new StorageInstancedBufferAttribute(new Float32Array(CAP*4), 4)` holding `(x,y,z, packed)` where `packed` encodes `scale` and `yaw` (e.g. `yaw + scale*10` decode, or two attrs of vec4; use one vec4 `(x,y,z,scale)` + a second `(yaw,0,0,0)` exactly like grass `inst` 2×vec4). Use the 2×vec4 layout from grass (`:83-84`).
  - `counter` atomic uint (`:85`), `indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([branchIndexCount,0,0,0,0]),5)` (`:86`), one per mesh-type, or one survivor list reused across the 3 draws (preferred: one survivor buffer of instance indices + 3 indirect attrs whose index counts differ).
  - `CAP` per variant = max instances of that variant across the loaded window (size generously, e.g. `maxTreesTotal` / variants, or a fixed cap like 4096; reallocation-free).

- [ ] **Step 2: `setChunk(key, records)` / `clearChunk(key)`.** Maintain `Map<chunkKey, {variant→count, offsets}>`. On change, rebuild each variant's CPU-side `Float32Array` from all loaded chunks' records for that variant and upload **once** (`instAttr.needsUpdate = true` / `renderer` storage update) — never per frame (SP2 caveat). Keep a CPU mirror of total per-variant counts for the HUD.

- [ ] **Step 3: Cull compute (TSL).** One compute kernel per variant (or one over all, routing by variant), transcribing `forest-cull.js`: `dist² = (x-camX)²+(z-camZ)² ≤ maxDist²` → `atomicAdd` survivor index into the variant's survivor buffer; `finalize` writes the count into each of the variant's 3 indirect attrs' `element(1)`. Copy the `reset → cull → finalize` shape from `grass-compute.js:122-163` and the awaited chain from `:215-221`.

- [ ] **Step 4: Instanced draw materials.** For each variant build 3 meshes (branches/leaves/shadow) whose geometry is the palette geometry with `.instanceCount = CAP` and `.indirect = indirectAttr` (`grass-compute.js:166-168`). `positionNode` transforms `positionLocal` by the instance: `rotateY(yaw)` then `*scale` then `+ (x,y,z)` (adapt grass `:175-186` which does yaw-rotate + height-scale; here scale is uniform and full 3D). Branch uses `branchMat` clone; leaves/shadow use `leafMat` clone. Carry vertex colors. If `clusteredLightsRef`, add `emissiveNode = addEmissive(instanceWorldPos, normal)` like grass `:203`.

- [ ] **Step 5: Public API.** Return `{ meshes:[...all variant meshes], update(camera), setChunk, clearChunk, stats:{draws, instances} }`. `update` sets `uCam`, runs the awaited compute chain.

- [ ] **Step 6: Browser checkpoint.** Wire `forest-gpu` into the viewer behind `?forest=gpu` (Task 5) and reload. Confirm: trees appear at placements, on dry ground, sized/rotated; moving the camera culls distant trees; HUD shows forest draws ≈ `variants×3` constant as you change draw distance. Expect 1–3 iterations to settle TSL (integer casts, `bitcast` hashes, awaited compute — see HANDOFF gotchas).

- [ ] **Step 7: Commit** (after the checkpoint is green)

```bash
git add forest-gpu.js
git commit -m "$(printf 'SP6: GPU-instanced forest - per-variant instance buffers, distance cull, indirect draws\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 5: Viewer integration + flag + SP5b trunks

**Files:** Modify `environment-viewer.html`.

- [ ] **Step 1: Flag.** Near the other mode flags add:

```javascript
const FOREST_MODE = new URLSearchParams(location.search).get('forest') || 'gpu';
```

- [ ] **Step 2: Build the gpu system when selected.** In the `trees.js` import block, when `FOREST_MODE === 'gpu'`: build the palette and the gpu system once:

```javascript
const { createForestPalette } = await import('./forest-palette.js');
const { createForestGPU } = await import('./forest-gpu.js');
const palette = createForestPalette({ createTree, params, masterSeed: MASTER_SEED });
const forestGPU = createForestGPU({ renderer, camera, palette,
  addEmissive: clusteredLightsRef ? (p, n) => clusteredLightsRef.pointLightTerm(p, n) : null });
scene.add(...forestGPU.meshes);
```

- [ ] **Step 3: Route placement records + trunks per chunk.** Replace the `regenTrees` body (when gpu) so that, on chunk sync, it computes `placementRecords(activeChunks, params, terrainHeight)` grouped by chunk, calls `forestGPU.setChunk(key, recs)` for changed chunks and `forestGPU.clearChunk(key)` for unloaded ones, and registers SP5b trunks: `trunkIndex.setTrunks(key, recs.map(r => ({x:r.x, z:r.z, r: TRUNK_RADIUS_PER_SCALE * r.scale})))`. Import `placementRecords` from `./forest-placement.js`. Keep the existing baked path intact for `FOREST_MODE === 'baked'` (it already registers trunks in `finishTreeJob`).

- [ ] **Step 4: Per-frame update.** In `animate()`, where the baked forest needs nothing per-frame, add `if (forestGPU) await forestGPU.update(camera);` before the draw (alongside grass/cdlod compute, all awaited).

- [ ] **Step 5: HUD/perf.** Add `forestDraws`/`forestInstances` to `terrainDebug`, the HUD string, and `perfLog.snapshot` (sourced from `forestGPU.stats` when gpu, else `treeChunks.size*3`).

- [ ] **Step 6: Browser checkpoint.** Reload `?forest=gpu` and `?forest=baked`. Confirm gpu renders a varied forest, trunks are solid (walk into one), draws flat vs draw distance; baked still works unchanged.

- [ ] **Step 7: Commit**

```bash
git add environment-viewer.html
git commit -m "$(printf 'SP6: wire ?forest=gpu palette path + records/trunks routing; keep baked baseline\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 6: dd9 A/B trace + docs

- [ ] **Step 1:** Record dd9 `perfStats` traces for `?forest=gpu` vs `?forest=baked` (walk + stream chunks); save both CSVs in `research/stats/` with `-forest-gpu` / `-forest-baked` suffixes.
- [ ] **Step 2:** Append an SP6 section to `research/webgpu/sp1-migration-notes.md` with the before/after (forest draws baked→gpu, CPU frame time, triangles); update the paper's living-state prose (§1/§7) only if the result warrants it (do not overclaim "flat fps" — the worker path still scales; the gpu path makes the *forest* flat). Sync both to `../workshop/research/webgpu/`.
- [ ] **Step 3:** Update `docs/superpowers/HANDOFF.md`: SP6 gpu path done; worker path next.
- [ ] **Step 4: Commit.**

---

## Self-Review
- **Spec §1 (flag + shared placement):** Task 1 (placement extraction) + Task 5 (flag, routing). ✓
- **Spec §2 (palette / CPU placement / GPU cull / indirect draws):** Tasks 2–4. ✓ (v1 cull is distance-only per the SP2 finding; noted in Task 2.)
- **Spec §2 (no per-frame re-upload):** Task 4 Step 2 uploads only on chunk change. ✓
- **Spec gate 1–4 (flat draws/tris, no main-thread bake, dd9 trace):** Tasks 4–6. ✓
- **Spec gate 7 (SP5b trunks still work):** Task 5 Step 3. ✓
- **Spec gate 8 (Node-first):** Tasks 1–2 precede all GPU code. ✓
- **Worker path (spec §3):** deliberately **out of this plan** (separate plan), with `?forest=baked` as the interim baseline. ✓
- **Placeholder note:** Tasks 1–2 carry full code; Tasks 3–5 carry full module scaffolds; Task 4's exact TSL is specified by transcription of `forest-cull.js` + reference to the proven `grass-compute.js` lines, finalized at the browser checkpoint (project constraint that TSL iterates in-browser — not a deferral of design). Two transcription points (`sizeFor` body `:618`, `placements` loop `:605`) require reading those exact lines during Task 1; both are cited.
- **Type consistency:** record shape `{x,z,scale,yaw,speciesIdx,chunkKey,slot}` is consistent across `placementRecords`, `forest-gpu.setChunk`, and the trunk mapping; `cullInstance(rec, cam, maxDist)` matches the TSL kernel inputs.
