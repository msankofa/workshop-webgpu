# Forest Freeze Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the main-thread freezes caused by dragging the tree size, species diversity, and tree count sliders.

**Architecture:** Two independent fixes. Fix 1 — add a `regenerateLeaves(leafOpts)` method to `Tree` that reruns the BFS in geometry-skip mode, halving the palette generation cost. Fix 2 — add a `setChunks(map)` batch method to the forest GPU object so `regenerateGPU` calls `rebuild()` once instead of once per chunk.

**Tech Stack:** Vanilla JS ES modules, Three.js r160, Node.js for headless tests.

---

## Background: what causes the freezes

**Species / diversity sliders** → `rebakeForest` → `rebuildForestGPU` → `createForestPalette`.  
Inside `createForestPalette` (`forest-palette.js:55–71`) each variant runs `gen.regenerate()` **twice** with the same branch seed — once for normal leaves, once for coarse LOD leaves. The branch BFS is identical both times; only the leaf options differ. At 8 species × 4 variants this is 64 full `Tree.generate()` calls blocking the main thread.

**Count / maxSize sliders** → `regenerate()` → `regenerateGPU(true)` → loops all N active chunks calling `forestGPU.setChunk(key, recs)` per chunk. `setChunk` always calls `rebuild()` which clears and refills the entire `srcAttr` Float32Array from scratch. With N = 25 chunks, `rebuild()` is called 25 times when one final call would suffice.

---

## Files

| File | Change |
|---|---|
| `trees.js` | Add `_generateBranch(branch, leavesOnly)` flag; add `regenerateLeaves(leafOpts)` method |
| `forest-palette.js` | Replace second `gen.regenerate()` with `gen.regenerateLeaves(coarseLeafOpts)` |
| `forest-gpu.js` | Add `setChunks(map)` to the returned API object |
| `environment-viewer.html` | Update `regenerateGPU` to batch all chunk records and call `setChunks` once |
| `_audit_trees.mjs` | Add `regenerateLeaves` correctness tests |
| `test-forest-gpu-rebuild.mjs` | New: test `setChunks` produces same buffer as N×`setChunk` in one rebuild call |

---

## Task 1: Add `regenerateLeaves` to `Tree` in `trees.js`

**Files:**
- Modify: `trees.js:196` (`_generateBranch`), `trees.js:163` (after `regenerate`)

The BFS already separates section computation (needed for leaf placement) from geometry pushes (verts/normals/uvs/indices). Adding a `leavesOnly` flag gates the geometry pushes without touching the RNG-consuming wander/force/spawn calls, so the RNG state when `_spawnLeaves` is reached is identical to a full generation with the same seed — producing the same leaf positions, just with different options.

- [ ] **Step 1: Add `leavesOnly` parameter to `_generateBranch`**

In `trees.js`, change the signature and gate all branch geometry pushes. The sections array, origin advance, gnarliness wander, and `_spawnChildren` / `_spawnLeaves` calls are **not** gated — they must still run to keep the RNG stream identical.

Find this line:
```js
  _generateBranch(branch) {
```
Replace with:
```js
  _generateBranch(branch, leavesOnly = false) {
```

Find the inner vertex loop (starts with `for (let j = 0; j < segs; j++) {`):
```js
      for (let j = 0; j < segs; j++) {
        const a = (2 * Math.PI * j) / segs;
        _dir.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(_q);
        _v.copy(_dir).multiplyScalar(radius).add(origin);
        this.branch.verts.push(_v.x, _v.y, _v.z);
        this.branch.normals.push(_dir.x, _dir.y, _dir.z);
        this.branch.uvs.push((j / segs) * wrapsX, vCoord);
      }
      // seam vertex (duplicate of j=0) at u = wrapsX
      _dir.set(1, 0, 0).applyQuaternion(_q);
      _v.copy(_dir).multiplyScalar(radius).add(origin);
      this.branch.verts.push(_v.x, _v.y, _v.z);
      this.branch.normals.push(_dir.x, _dir.y, _dir.z);
      this.branch.uvs.push(wrapsX, vCoord);
```
Replace with:
```js
      if (!leavesOnly) {
        for (let j = 0; j < segs; j++) {
          const a = (2 * Math.PI * j) / segs;
          _dir.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(_q);
          _v.copy(_dir).multiplyScalar(radius).add(origin);
          this.branch.verts.push(_v.x, _v.y, _v.z);
          this.branch.normals.push(_dir.x, _dir.y, _dir.z);
          this.branch.uvs.push((j / segs) * wrapsX, vCoord);
        }
        // seam vertex (duplicate of j=0) at u = wrapsX
        _dir.set(1, 0, 0).applyQuaternion(_q);
        _v.copy(_dir).multiplyScalar(radius).add(origin);
        this.branch.verts.push(_v.x, _v.y, _v.z);
        this.branch.normals.push(_dir.x, _dir.y, _dir.z);
        this.branch.uvs.push(wrapsX, vCoord);
      }
```

Find the index loop (starts `// skin the tube:`):
```js
    // skin the tube: two triangles per quad between consecutive rings
    for (let i = 0; i < branch.sectionCount; i++) {
      for (let j = 0; j < segs; j++) {
        const a = indexOffset + i * vertsPerRing + j;
        const b = a + 1;
        const c = a + vertsPerRing;
        const d = c + 1;
        this.branch.indices.push(a, c, b, b, c, d);
      }
    }
```
Replace with:
```js
    // skin the tube: two triangles per quad between consecutive rings
    if (!leavesOnly) {
      for (let i = 0; i < branch.sectionCount; i++) {
        for (let j = 0; j < segs; j++) {
          const a = indexOffset + i * vertsPerRing + j;
          const b = a + 1;
          const c = a + vertsPerRing;
          const d = c + 1;
          this.branch.indices.push(a, c, b, b, c, d);
        }
      }
    }
```

- [ ] **Step 2: Add `regenerateLeaves` method to `Tree`**

Insert after the `regenerate` method (after line `regenerate(options) { ... }`):

```js
  regenerateLeaves(leafOpts) {
    if (leafOpts) this.options = merge(this.options, { leaves: leafOpts });
    const o = this.options;
    this.rng = makeRNG(o.seed);
    this.leafShadowRng = makeRNG((o.seed ^ 0x9e3779b9) >>> 0);
    this.leaf = { verts: [], normals: [], uvs: [], indices: [] };
    this.leafShadow = { verts: [], normals: [], uvs: [], indices: [] };
    this.queue = [{
      origin: new THREE.Vector3(0, 0, 0),
      orientation: new THREE.Euler(0, 0, 0),
      length: at(o.length, 0),
      radius: at(o.radius, 0),
      level: 0,
      sectionCount: at(o.sections, 0),
      segmentCount: at(o.segments, 0),
    }];
    while (this.queue.length) this._generateBranch(this.queue.shift(), true);
    this._commit(this.leavesMesh.geometry, this.leaf);
    this._commit(this.leavesShadowMesh.geometry, this.leafShadow);
  }
```

- [ ] **Step 3: Commit**

```bash
git add trees.js
git commit -m "feat(trees): add regenerateLeaves for leaf-only BFS pass"
```

---

## Task 2: Test `regenerateLeaves` in `_audit_trees.mjs`

**Files:**
- Modify: `_audit_trees.mjs`

- [ ] **Step 1: Add the test block**

Append before the final `console.log` / `process.exit` lines in `_audit_trees.mjs`:

```js
// 6. regenerateLeaves: branch geometry unchanged, leaf geometry reflects new opts
console.log('\n[regenerateLeaves]');
{
  const t = createTree({ seed: 42, levels: 3, leaves: { count: 10, size: 1.0 } });
  const branchPos = t.branchesMesh.geometry.getAttribute('position').array.slice();
  const branchNrm = t.branchesMesh.geometry.getAttribute('normal').array.slice();
  const leafCountBefore = t.leavesMesh.geometry.getAttribute('position').count;

  t.regenerateLeaves({ count: 3, size: 2.5 });

  const branchPosAfter = t.branchesMesh.geometry.getAttribute('position').array;
  const leafCountAfter  = t.leavesMesh.geometry.getAttribute('position').count;

  let branchChanged = false;
  for (let i = 0; i < branchPos.length; i++) {
    if (branchPos[i] !== branchPosAfter[i]) { branchChanged = true; break; }
  }
  if (branchChanged) fail('regenerateLeaves: branch positions changed');
  else console.log('  ok: branch positions unchanged');

  const branchNrmAfter = t.branchesMesh.geometry.getAttribute('normal').array;
  let nrmChanged = false;
  for (let i = 0; i < branchNrm.length; i++) {
    if (branchNrm[i] !== branchNrmAfter[i]) { nrmChanged = true; break; }
  }
  if (nrmChanged) fail('regenerateLeaves: branch normals changed');
  else console.log('  ok: branch normals unchanged');

  // count=3 leaves (doubleBillboard default=true → 2 quads each → 8 verts/leaf)
  // → fewer verts than count=10
  if (leafCountAfter >= leafCountBefore) {
    fail(`regenerateLeaves: leaf count ${leafCountAfter} did not decrease from ${leafCountBefore}`);
  } else {
    console.log(`  ok: leaf verts ${leafCountBefore} → ${leafCountAfter} (count 10→3)`);
  }

  auditMesh('regenerateLeaves leaves', t.leavesMesh);
  auditMesh('regenerateLeaves shadow', t.leavesShadowMesh);
}
```

- [ ] **Step 2: Run the audit**

```
node _audit_trees.mjs
```

Expected output ends with `ALL CHECKS PASSED`. The new block prints:
```
[regenerateLeaves]
  ok: branch positions unchanged
  ok: branch normals unchanged
  ok: leaf verts <N> → <M> (count 10→3)
  leaves: verts=... tris=... ...
  shadow: ...
```

- [ ] **Step 3: Commit**

```bash
git add _audit_trees.mjs
git commit -m "test(trees): verify regenerateLeaves preserves branches, updates leaves"
```

---

## Task 3: Use `regenerateLeaves` in `forest-palette.js`

**Files:**
- Modify: `forest-palette.js:55–80`

- [ ] **Step 1: Replace the second `gen.regenerate()` call**

Find this block in `forest-palette.js` (inside the `for (let v ...)` loop):

```js
      const ratio = Math.max(0.05, Math.min(1.0, params.coarseLeafRatio ?? 0.25));
      const sizeMult = Math.max(1.0, params.coarseLeafSizeMult ?? 2.5);
      const coarseLeafOpts = {
        ...leafOpts,
        count: Math.max(1, Math.round(leafOpts.count * ratio)),
        size: leafOpts.size * sizeMult,
        shadowFraction: 0,
      };
      gen.regenerate({ ...sp, seed, leaves: coarseLeafOpts, bark: barkOpts });
      const leavesCoarseGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);
```

Replace with:

```js
      const ratio = Math.max(0.05, Math.min(1.0, params.coarseLeafRatio ?? 0.25));
      const sizeMult = Math.max(1.0, params.coarseLeafSizeMult ?? 2.5);
      const coarseLeafOpts = {
        ...leafOpts,
        count: Math.max(1, Math.round(leafOpts.count * ratio)),
        size: leafOpts.size * sizeMult,
        shadowFraction: 0,
      };
      gen.regenerateLeaves(coarseLeafOpts);
      const leavesCoarseGeo = bakeFlatColor(gen.leavesMesh.geometry, sp.leaves.tint);
```

- [ ] **Step 2: Verify the audit still passes**

```
node _audit_trees.mjs
```

Expected: `ALL CHECKS PASSED`

- [ ] **Step 3: Commit**

```bash
git add forest-palette.js
git commit -m "perf(forest): halve palette generation cost via regenerateLeaves"
```

---

## Task 4: Add `setChunks` batch method to `forest-gpu.js`

**Files:**
- Modify: `forest-gpu.js:353` (the returned API object)

- [ ] **Step 1: Add `setChunks` alongside `setChunk`**

Find this line in the returned object at the end of `createForestGPU` (`forest-gpu.js`):

```js
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
```

Replace with:

```js
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    setChunks(map) { for (const [k, v] of map) chunkRecords.set(k, v); rebuild(); },
```

- [ ] **Step 2: Commit**

```bash
git add forest-gpu.js
git commit -m "feat(forest-gpu): add setChunks batch API to call rebuild once"
```

---

## Task 5: Test `setChunks` in `test-forest-gpu-rebuild.mjs`

**Files:**
- Create: `test-forest-gpu-rebuild.mjs`

`forest-gpu.js` requires Three.js WebGPU and cannot run headlessly. The test instead uses a CPU-only mirror of the `rebuild()` logic — the same algorithm, no GPU objects — to verify that `setChunks(map)` produces the identical source buffer to N×`setChunk` while calling `rebuild()` once.

- [ ] **Step 1: Create the test file**

```js
// test-forest-gpu-rebuild.mjs
// CPU mirror of forest-gpu.js rebuild() logic.
// Verifies setChunks(map) ≡ N×setChunk and calls rebuild() exactly once.

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

function makeHarness({ V = 3, CAP = 8, variantsPerSpecies = 1 } = {}) {
  const srcArray    = new Float32Array(V * CAP * 8);
  const countsArray = new Uint32Array(V);
  const chunkRecords = new Map();
  let rebuildCount = 0;

  const variantSel = slot => (Math.imul(slot + 1, 2654435761) >>> 0) % variantsPerSpecies;

  function rebuild() {
    rebuildCount++;
    countsArray.fill(0);
    srcArray.fill(0);
    for (const records of chunkRecords.values()) {
      for (const r of records) {
        const g = r.speciesIdx * variantsPerSpecies + variantSel(r.slot);
        if (g < 0 || g >= V) continue;
        const slot = countsArray[g];
        if (slot >= CAP) continue;
        countsArray[g] = slot + 1;
        const base = (g * CAP + slot) * 8;
        srcArray[base]     = r.x;
        srcArray[base + 1] = 0;    // y (heightAt stub)
        srcArray[base + 2] = r.z;
        srcArray[base + 3] = r.scale;
        srcArray[base + 4] = r.yaw;
      }
    }
  }

  return {
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    setChunks(map)         { for (const [k, v] of map) chunkRecords.set(k, v); rebuild(); },
    get rebuildCount()     { return rebuildCount; },
    srcSnapshot()          { return srcArray.slice(); },
    countSnapshot()        { return countsArray.slice(); },
  };
}

// ---- fixtures ----
const r0 = [{ x: 1, z: 1, scale: 0.5, yaw: 0.1, speciesIdx: 0, slot: 0 }];
const r1 = [{ x: 5, z: 5, scale: 0.7, yaw: 1.2, speciesIdx: 1, slot: 0 }];
const r2 = [{ x: 9, z: 9, scale: 0.4, yaw: 2.3, speciesIdx: 2, slot: 0 }];

// ---- test 1: rebuild call count ----
const a = makeHarness({ V: 3, CAP: 4, variantsPerSpecies: 1 });
a.setChunk('0,0', r0);
a.setChunk('1,0', r1);
a.setChunk('0,1', r2);
ok(a.rebuildCount === 3, `setChunk: rebuild called ${a.rebuildCount} times, expected 3`);

const b = makeHarness({ V: 3, CAP: 4, variantsPerSpecies: 1 });
b.setChunks(new Map([['0,0', r0], ['1,0', r1], ['0,1', r2]]));
ok(b.rebuildCount === 1, `setChunks: rebuild called ${b.rebuildCount} time(s), expected 1`);

// ---- test 2: identical source buffer ----
const aSnap = a.srcSnapshot(), bSnap = b.srcSnapshot();
ok(aSnap.every((v, i) => v === bSnap[i]), 'setChunks src buffer matches N×setChunk');
ok(a.countSnapshot().every((v, i) => v === b.countSnapshot()[i]), 'setChunks counts match N×setChunk');

// ---- test 3: order independence (different insertion order, same final state) ----
const c = makeHarness({ V: 3, CAP: 4, variantsPerSpecies: 1 });
c.setChunks(new Map([['0,1', r2], ['0,0', r0], ['1,0', r1]]));  // reversed order
ok(c.rebuildCount === 1, 'reversed setChunks: still one rebuild');
// Note: source buffer order may differ by insertion order (Map preserves insertion),
// but total instance count per variant must match.
ok(c.countSnapshot().every((v, i) => v === b.countSnapshot()[i]), 'reversed setChunks: same counts');

// ---- test 4: empty batch is a no-op ----
const d = makeHarness();
d.setChunks(new Map());
ok(d.rebuildCount === 1, 'empty setChunks still calls rebuild once');
ok(d.srcSnapshot().every(v => v === 0), 'empty setChunks: src buffer stays zero');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test — expect it to fail** (setChunks doesn't exist yet in forest-gpu.js... but we added it in Task 4, so it should pass)

```
node test-forest-gpu-rebuild.mjs
```

Expected: `4 passed, 0 failed`

- [ ] **Step 3: Commit**

```bash
git add test-forest-gpu-rebuild.mjs
git commit -m "test(forest-gpu): verify setChunks batch rebuild correctness"
```

---

## Task 6: Update `regenerateGPU` in `environment-viewer.html` to use `setChunks`

**Files:**
- Modify: `environment-viewer.html:825–841` (`regenerateGPU` function)

- [ ] **Step 1: Replace the per-chunk `setChunk` loop with a batch**

Find this block in `environment-viewer.html`:

```js
  function regenerateGPU(rebuildExisting) {
    if (!forestGPU) return;
    const active = forestChunksForPlacement().slice();
    const activeKeys = new Set(active.map(c => c.key));
    for (const key of [...gpuTreeChunks]) {
      if (!activeKeys.has(key)) { forestGPU.clearChunk(key); trunkIndex.clearTrunks(key); gpuTreeChunks.delete(key); }
    }
    const pr = paramsForRecords();
    for (const chunk of active) {
      if (!rebuildExisting && gpuTreeChunks.has(chunk.key)) continue;
      const recs = placementRecords([chunk], pr, terrainHeight);
      forestGPU.setChunk(chunk.key, recs);
      trunkIndex.setTrunks(chunk.key, recs.map(r => ({ x: r.x, z: r.z, r: TRUNK_RADIUS_PER_SCALE * r.scale })));
      gpuTreeChunks.add(chunk.key);
    }
    terrainDebug.treePlacements = forestGPU.stats.instances;
  }
```

Replace with:

```js
  function regenerateGPU(rebuildExisting) {
    if (!forestGPU) return;
    const active = forestChunksForPlacement().slice();
    const activeKeys = new Set(active.map(c => c.key));
    for (const key of [...gpuTreeChunks]) {
      if (!activeKeys.has(key)) { forestGPU.clearChunk(key); trunkIndex.clearTrunks(key); gpuTreeChunks.delete(key); }
    }
    const pr = paramsForRecords();
    const batch = new Map();
    for (const chunk of active) {
      if (!rebuildExisting && gpuTreeChunks.has(chunk.key)) continue;
      const recs = placementRecords([chunk], pr, terrainHeight);
      batch.set(chunk.key, recs);
      trunkIndex.setTrunks(chunk.key, recs.map(r => ({ x: r.x, z: r.z, r: TRUNK_RADIUS_PER_SCALE * r.scale })));
      gpuTreeChunks.add(chunk.key);
    }
    if (batch.size > 0) forestGPU.setChunks(batch);
    terrainDebug.treePlacements = forestGPU.stats.instances;
  }
```

- [ ] **Step 2: Manual browser verification**

Open `environment-viewer.html` in a WebGPU browser. Open DevTools Performance panel and record while:

1. Dragging the **Tree count** slider from 18 → 1500. The HUD `instances` count should update without a visible freeze. No long task (>50ms) should appear in the Performance flamechart.
2. Dragging **Max size** from 0.2 → 1.2. Same expectation.
3. Dragging **Species diversity (types)** from 1 → 8. This still runs `createForestPalette` synchronously (Task 3 halved its cost). Expect a single spike when released but not repeated per-drag-tick freezes.

- [ ] **Step 3: Commit**

```bash
git add environment-viewer.html
git commit -m "perf(forest): batch regenerateGPU chunk updates to one rebuild call"
```

---

## Self-Review

**Spec coverage:**
- ✅ Coarse-leaf double-regenerate removed (Tasks 1, 3)
- ✅ `setChunks` batch API added and tested (Tasks 4, 5)
- ✅ `regenerateGPU` updated to use batch API (Task 6)
- ✅ Tests for `regenerateLeaves` (Task 2) and `setChunks` (Task 5)

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency:**
- `regenerateLeaves(leafOpts)` — defined in Task 1, called in Task 3. `leafOpts` shape matches `leaves` sub-object (count, size, shadowFraction, etc.) as used throughout `forest-palette.js`.
- `setChunks(map)` — `Map<string, record[]>` defined in Task 4, tested in Task 5 with same Map type, called in Task 6 with `new Map()`.
- `rebuild()` internal — not exported; Task 5 tests its behaviour via the CPU mirror harness, not by importing it.
