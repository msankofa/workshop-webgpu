# SP3 — GPU-driven CDLOD terrain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CPU-built per-chunk *visual* terrain with a GPU-driven CDLOD renderer — a camera-snapped Morton-keyed quadtree whose visible nodes + LOD are selected by a compute pass, emitted via `atomicAdd`, and drawn with one `drawIndexedIndirect` of a reusable grid; height/normals from the analytic field in TSL; crack-free via continuous vertex morphing.

**Architecture:** Three layers, mirroring SP2. (1) Pure-JS CDLOD math (`cdlod-select.js`) — Morton keys, level ranges, flattened distance-band selection, morph helpers — fully Node-tested (coverage partition, bounded cost = the gate, morph continuity). (2) GPU module (`cdlod-terrain.js`, modeled on `grass-compute.js`) — reusable grid, `reset→select→finalize` TSL compute, morph+displace+analytic-normal node material, indirect draw. (3) Integration — `terrain-system.js` gains an `external` visual mode (keeps `activeChunks`/colliders/`getHeight`, drops visual meshes); `environment-viewer.html` wires it behind `?terrain=gpu|chunks`.

**Tech Stack:** Three.js r0.184 WebGPU (`three/webgpu`, `three/tsl`), Node 18+ for `.mjs` logic tests (no test framework — plain assert-and-exit scripts run with `node`, matching `test-grass-cells.mjs`).

**Reference:** Spec at `docs/superpowers/specs/2026-06-21-sp3-gpu-cdlod-terrain-design.md`. SP2 twins to copy idioms from: `grass-compute.js`, `grass-cells.js`, `grass-height-ref.js`, `test-grass-cells.mjs`.

**Config defaults (one object, used everywhere):**
```js
// CDLOD config (cfg)
{ leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 }
// node size at level L = leafSize * 2**L ; range[L] = leafSize * 2**L * lodScale
// windowCells = ceil(2*lodScale)+2 = 8 ; candidates = levels*windowCells**2 = 448
```

---

### Task 1: CDLOD pure-JS math + Morton keys

**Files:**
- Create: `cdlod-select.js`
- Test: `test-cdlod-morton.mjs`

- [ ] **Step 1: Write the failing test** — `test-cdlod-morton.mjs`

```js
import { part1by1, compact1by1, mortonKey, decodeMorton } from './cdlod-select.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// part1by1/compact1by1 are inverses on 16-bit inputs
ok(compact1by1(part1by1(0)) === 0, 'spread/compact round-trips 0');
ok(compact1by1(part1by1(0xABCD)) === 0xABCD, 'spread/compact round-trips 0xABCD');
ok(compact1by1(part1by1(0xFFFF)) === 0xFFFF, 'spread/compact round-trips 0xFFFF');

// mortonKey round-trips signed cell indices (incl. negatives) and preserves level
for (const [L, ix, iz] of [[0, 0, 0], [3, 5, -3], [6, -100, 250], [2, -1, -1]]) {
  const d = decodeMorton(mortonKey(L, ix, iz));
  ok(d.level === L && d.ix === ix && d.iz === iz, `morton round-trips (${L},${ix},${iz})`);
}

// distinct cells → distinct codes
ok(mortonKey(0, 0, 0).code !== mortonKey(0, 1, 0).code, 'morton codes differ by ix');
ok(mortonKey(0, 0, 0).code !== mortonKey(0, 0, 1).code, 'morton codes differ by iz');

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-cdlod-morton.mjs`
Expected: FAIL — `Cannot find module './cdlod-select.js'` (or `part1by1 is not a function`).

- [ ] **Step 3: Implement `cdlod-select.js` (Morton section only)**

```js
// cdlod-select.js
// Pure-JS CDLOD node selection math — no three.js. The CPU source of truth that the
// cdlod-terrain.js TSL compute transcribes, and the target for the Node parity tests
// (coverage partition, bounded cost = the gate, crack-free morphing). Camera-snapped,
// Morton-keyed quadtree with flattened distance-band LOD selection (SP3 Decision 4):
// every visible point lands in exactly one selected node.

// ---- Morton (Z-order) keys: interleave 16 low bits of each axis; tag level separately.
// Mirrors the research's linear-quadtree encoding (the node identity the GPU writes per
// instance). Selection itself is flattened, not tree-traversal, so keys are identity, not
// a traversal structure.
export function part1by1(n) {            // spread 16 low bits into even bit positions
  n = n & 0x0000ffff;
  n = (n | (n << 8)) & 0x00ff00ff;
  n = (n | (n << 4)) & 0x0f0f0f0f;
  n = (n | (n << 2)) & 0x33333333;
  n = (n | (n << 1)) & 0x55555555;
  return n >>> 0;
}
export function compact1by1(n) {
  n = n & 0x55555555;
  n = (n | (n >>> 1)) & 0x33333333;
  n = (n | (n >>> 2)) & 0x0f0f0f0f;
  n = (n | (n >>> 4)) & 0x00ff00ff;
  n = (n | (n >>> 8)) & 0x0000ffff;
  return n & 0xffff;
}
// Signed cell indices biased by 0x8000 so negatives interleave monotonically in 16 bits.
export function mortonKey(level, ix, iz) {
  const ux = (ix + 0x8000) & 0xffff, uz = (iz + 0x8000) & 0xffff;
  const code = (part1by1(ux) | (part1by1(uz) << 1)) >>> 0;
  return { level, code };
}
export function decodeMorton(key) {
  const ux = compact1by1(key.code);
  const uz = compact1by1(key.code >>> 1);
  return { level: key.level, ix: ux - 0x8000, iz: uz - 0x8000 };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-cdlod-morton.mjs`
Expected: PASS — all `ok` lines, exit 0.

- [ ] **Step 5: Commit**

```bash
git add cdlod-select.js test-cdlod-morton.mjs
git commit -m "feat(sp3): Morton linear-quadtree keys (Node TDD)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Level ranges, distance helpers, flattened selection

**Files:**
- Modify: `cdlod-select.js` (append)
- Test: `test-cdlod-select.mjs`

- [ ] **Step 1: Write the failing test** — `test-cdlod-select.mjs`

```js
import { levelRanges, nodeSize, minDistToCell, selectNodes, nodeCountForViewDistance } from './cdlod-select.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const cfg = { leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 };

// ranges are geometric: range[L] = leafSize * 2^L * lodScale
const r = levelRanges(cfg);
ok(Math.abs(r[0] - 16 * 1 * 2.5) < 1e-9, 'range[0] = 40');
ok(Math.abs(r[3] - 16 * 8 * 2.5) < 1e-9, 'range[3] = 320');
ok(nodeSize(cfg, 2) === 64, 'nodeSize(2) = 64');

// minDistToCell: 0 inside the cell, exact edge distance outside
ok(minDistToCell(0, 0, 16, 8, 8) === 0, 'distance 0 when camera inside cell');
ok(Math.abs(minDistToCell(0, 0, 16, 32, 0) - 16) < 1e-9, 'distance to cell to the right');

// COVERAGE PARTITION: every sampled point near the camera is inside exactly one node.
function selectedCovering(nodes, px, pz) {
  let n = 0;
  for (const nd of nodes) {
    if (px >= nd.originX && px < nd.originX + nd.size && pz >= nd.originZ && pz < nd.originZ + nd.size) n++;
  }
  return n;
}
for (const [cx, cz] of [[0, 0], [37.5, -12.25], [123.4, 456.7]]) {
  const nodes = selectNodes(cfg, cx, cz);
  let exactlyOne = true;
  // sample a dense disk of radius ~range[levels-2] around the camera (inside coverage)
  const R = levelRanges(cfg)[cfg.levels - 2];
  for (let a = 0; a < 360; a += 7) {
    for (let rr = 2; rr < R; rr += R / 25) {
      const px = cx + Math.cos(a * Math.PI / 180) * rr;
      const pz = cz + Math.sin(a * Math.PI / 180) * rr;
      if (selectedCovering(nodes, px, pz) !== 1) { exactlyOne = false; break; }
    }
    if (!exactlyOne) break;
  }
  ok(exactlyOne, `coverage is a partition near camera (${cx},${cz})`);
}

// FINEST near camera, COARSER far: the node containing the camera is level 0.
{
  const nodes = selectNodes(cfg, 0.5, 0.5);
  const here = nodes.find(n => 0.5 >= n.originX && 0.5 < n.originX + n.size && 0.5 >= n.originZ && 0.5 < n.originZ + n.size);
  ok(here && here.level === 0, 'camera sits on a level-0 (finest) node');
}

// BOUNDED COST (THE GATE): node count never exceeds levels*windowCells^2 and is flat as
// view distance doubles (more levels add one bounded ring each, not area growth).
{
  const cap = cfg.levels * cfg.windowCells * cfg.windowCells;
  const n7 = nodeCountForViewDistance({ ...cfg, levels: 7 }, 0, 0);
  const n9 = nodeCountForViewDistance({ ...cfg, levels: 9 }, 0, 0);
  ok(n7 <= cap, 'node count within candidate cap');
  ok(n9 - n7 <= 2 * cfg.windowCells * cfg.windowCells, 'adding 2 levels adds <= 2 rings (flat, not area)');
  ok(n9 < 4 * n7, 'doubling distance does NOT quadruple node count (vs chunked area growth)');
}

// SNAPPING STABILITY: nudging the camera < one leaf cell leaves coarse-node origins put.
{
  const a = selectNodes(cfg, 100, 100).filter(n => n.level >= 3).map(n => `${n.level}:${n.originX},${n.originZ}`).sort();
  const b = selectNodes(cfg, 100 + cfg.leafSize * 0.4, 100).filter(n => n.level >= 3).map(n => `${n.level}:${n.originX},${n.originZ}`).sort();
  ok(JSON.stringify(a) === JSON.stringify(b), 'sub-leaf camera move keeps coarse nodes stable (no shimmer)');
}

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-cdlod-select.mjs`
Expected: FAIL — `levelRanges is not a function` / export missing.

- [ ] **Step 3: Implement (append to `cdlod-select.js`)**

```js
export function nodeSize(cfg, level) { return cfg.leafSize * (2 ** level); }

export function levelRanges(cfg) {
  const r = new Float32Array(cfg.levels);
  for (let L = 0; L < cfg.levels; L++) r[L] = cfg.leafSize * (2 ** L) * cfg.lodScale;
  return r;
}

// Min distance (XZ) from point (px,pz) to the axis-aligned cell [ox,ox+s)×[oz,oz+s).
export function minDistToCell(ox, oz, s, px, pz) {
  const dx = px < ox ? ox - px : (px > ox + s ? px - (ox + s) : 0);
  const dz = pz < oz ? oz - pz : (pz > oz + s ? pz - (oz + s) : 0);
  return Math.hypot(dx, dz);
}

// CDLOD morph factor for an emitted node: 0 until morphStart*range, ramps to 1 at range.
export function morphFactor(cfg, ranges, level, d) {
  const R = ranges[level];
  const start = cfg.morphStart * R;
  if (R <= start) return 0;
  return Math.max(0, Math.min(1, (d - start) / (R - start)));
}

// Flattened distance-band selection. A node at level L is emitted iff its parent was
// refined into it (camera close enough for level L) AND it is not itself refined (camera
// too far for the finer level L-1). This reproduces recursive CDLOD selection exactly, so
// the emitted nodes form a partition of the covered region.
export function selectNodes(cfg, camX, camZ) {
  const ranges = levelRanges(cfg);
  const half = Math.floor(cfg.windowCells / 2);
  const out = [];
  for (let L = 0; L < cfg.levels; L++) {
    const s = nodeSize(cfg, L);
    const cCellX = Math.floor(camX / s);
    const cCellZ = Math.floor(camZ / s);
    for (let lz = -half; lz <= half; lz++) {
      for (let lx = -half; lx <= half; lx++) {
        const ix = cCellX + lx, iz = cCellZ + lz;
        const ox = ix * s, oz = iz * s;
        const d = minDistToCell(ox, oz, s, camX, camZ);

        // self-refine gate: not refined into finer level (L==0 can't refine)
        const notRefined = (L === 0) || (d > ranges[L - 1]);
        // parent-refine gate: parent (level L+1) was refined into this node
        let refinedByParent;
        if (L === cfg.levels - 1) {
          refinedByParent = true;                       // coarsest: no parent gate
        } else {
          const ps = nodeSize(cfg, L + 1);
          const pIx = Math.floor(ix / 2), pIz = Math.floor(iz / 2);
          const pd = minDistToCell(pIx * ps, pIz * ps, ps, camX, camZ);
          refinedByParent = pd <= ranges[L];            // parent close enough → refined to level L
        }
        if (notRefined && refinedByParent) {
          out.push({
            level: L, ix, iz, originX: ox, originZ: oz, size: s,
            d, morphK: morphFactor(cfg, ranges, L, d),
          });
        }
      }
    }
  }
  return out;
}

export function nodeCountForViewDistance(cfg, camX, camZ) {
  return selectNodes(cfg, camX, camZ).length;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-cdlod-select.mjs`
Expected: PASS — all `ok` lines, exit 0. If "coverage is a partition" fails, the band gates are off; if "flat, not area" fails, `windowCells` is being scaled by distance (it must be constant).

- [ ] **Step 5: Commit**

```bash
git add cdlod-select.js test-cdlod-select.mjs
git commit -m "feat(sp3): flattened CDLOD selection — coverage partition + bounded cost (Node TDD)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Morph continuity (crack-free) parity test

**Files:**
- Modify: `cdlod-select.js` (append `morphGridCoord`)
- Test: `test-cdlod-morph.mjs`

- [ ] **Step 1: Write the failing test** — `test-cdlod-morph.mjs`

```js
import { morphGridCoord, nodeSize } from './cdlod-select.js';
import { grassHeightRef } from './grass-height-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const cfg = { leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 };
const N = cfg.patchQuads;

// At morphK=0 the grid coord is unchanged.
for (const g of [0, 0.3125, 0.5, 1]) ok(Math.abs(morphGridCoord(g, N, 0) - g) < 1e-12, `morphK=0 identity at g=${g}`);

// At morphK=1 every grid coord lands on the EVEN (parent) lattice — multiples of 2/N.
let onParent = true;
for (let i = 0; i <= N; i++) {
  const g = i / N;
  const m = morphGridCoord(g, N, 1);
  const onEven = Math.abs((m * N / 2) - Math.round(m * N / 2)) < 1e-9;
  if (!onEven) onParent = false;
}
ok(onParent, 'morphK=1 snaps all vertices onto the parent (even) lattice');

// CRACK-FREE: a level-L node fully morphed (k=1) samples heights along its shared edge at
// exactly the parent lattice points → identical to the coarser neighbor → no gap.
{
  const L = 2, s = nodeSize(cfg, L), ox = 0, oz = 0;
  const params = { baseAmp: 1, lake: 0.45, lakeDepth: 3.2 };
  let maxGap = 0;
  for (let i = 0; i <= N; i++) {
    const gFine = i / N;
    const wxFine = ox + morphGridCoord(gFine, N, 1) * s;       // morphed (on parent lattice)
    // parent samples only its even vertices; the morphed fine vertex must equal one of them
    const wxParent = ox + Math.round(gFine * N / 2) * (2 / N) * s;
    maxGap = Math.max(maxGap, Math.abs(grassHeightRef(params, wxFine, oz) - grassHeightRef(params, wxParent, oz)));
  }
  ok(maxGap < 1e-6, 'fully-morphed edge heights match the parent lattice (crack-free)');
}

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-cdlod-morph.mjs`
Expected: FAIL — `morphGridCoord is not a function`.

- [ ] **Step 3: Implement (append to `cdlod-select.js`)**

```js
// CDLOD vertex morph in normalized grid coords g in [0,1] with N quads. As morphK→1 the
// coord snaps from the fine (N) lattice toward the even/parent (N/2) lattice, so a node's
// boundary vertices coincide with the coarser parent level's vertices (crack-free seams).
export function morphGridCoord(g, N, morphK) {
  const gi = g * N;                       // vertex index in [0,N]
  const frac = (gi * 0.5) - Math.floor(gi * 0.5);  // 0 on even verts, 0.5 on odd verts
  return g - (frac * 2 / N) * morphK;     // pull odd verts back to the previous even vert
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-cdlod-morph.mjs`
Expected: PASS — all `ok` lines, exit 0.

- [ ] **Step 5: Commit**

```bash
git add cdlod-select.js test-cdlod-morph.mjs
git commit -m "feat(sp3): CDLOD vertex morph — crack-free seam continuity (Node TDD)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: GPU CDLOD terrain module

**Files:**
- Create: `cdlod-terrain.js`
- (No Node test — GPU code is verified by the Task 6 browser checkpoint. The math it
  transcribes is already proven by Tasks 1–3.)

- [ ] **Step 1: Create `cdlod-terrain.js`**

```js
// cdlod-terrain.js
// GPU-driven CDLOD terrain (SP3). Per frame: a compute pass evaluates a camera-snapped,
// Morton-keyed quadtree window (cdlod-select.js math, transcribed to TSL), flat-tests each
// candidate node's LOD band, and atomicAdds survivors into a GPU-resident instance buffer
// that drives ONE drawIndexedIndirect of a reusable PATCH×PATCH grid. The vertex stage
// applies CDLOD morphing, then displaces by the analytic height (bit-matching
// grass-height-ref.js / terrain-field.js) and shades with the analytic normal. Mirrors
// grass-compute.js (awaited computeAsync chain to avoid the indirect-vs-draw race).
import * as THREE from 'three';
import {
  MeshStandardNodeMaterial, StorageInstancedBufferAttribute, StorageBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, int, uint, bitcast, modInt,
  vec2, vec3, vec4, sin, cos, floor, abs, max, min, clamp, sqrt, mix, positionLocal,
  atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';

const DEF = { leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 };

// Reusable indexed grid over [0,1]^2 with q*q cells. aGrid carries (gx,gz) in [0,1].
function buildPatchGeometry(q) {
  const g1 = q + 1, vcount = g1 * g1;
  const grid = new Float32Array(vcount * 2);
  let p = 0;
  for (let iz = 0; iz <= q; iz++) for (let ix = 0; ix <= q; ix++) { grid[p++] = ix / q; grid[p++] = iz / q; }
  const index = new Uint16Array(q * q * 6);
  let t = 0;
  for (let iz = 0; iz < q; iz++) for (let ix = 0; ix < q; ix++) {
    const a = ix + g1 * iz, b = ix + g1 * (iz + 1), c = (ix + 1) + g1 * (iz + 1), d = (ix + 1) + g1 * iz;
    index[t++] = a; index[t++] = b; index[t++] = d; index[t++] = b; index[t++] = c; index[t++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3)); // placeholder; positionNode overrides
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return { geo, indexCount: index.length };
}

const asU = (i) => bitcast(i, 'uint');

export function createCdlodTerrain(opts) {
  const { renderer, camera } = opts;
  const cfg = { ...DEF, ...(opts.cfg || {}) };
  const q = cfg.patchQuads;
  const CANDIDATES = cfg.levels * cfg.windowCells * cfg.windowCells; // dispatch + survivor cap
  const half = Math.floor(cfg.windowCells / 2);

  const o = {
    baseAmp: opts.terrainParams?.baseAmp ?? 1.0,
    lake: opts.terrainParams?.lake ?? 0.45,
    lakeDepth: opts.terrainParams?.lakeDepth ?? 3.2,
  };

  // ---- buffers: per node 1x vec4 = (originX, originZ, size, packed[level + morphK]) ----
  const instAttr = new StorageInstancedBufferAttribute(new Float32Array(CANDIDATES * 4), 4);
  const inst = storage(instAttr, 'vec4', CANDIDATES);
  const counter = storage(new StorageBufferAttribute(new Uint32Array(1), 1), 'uint', 1).toAtomic();
  const { geo, indexCount } = buildPatchGeometry(q);
  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 5);
  const indirect = storage(indirectAttr, 'uint', 5);

  // ---- uniforms ----
  const uCam = uniform(new THREE.Vector2());
  const uLevels = uniform(cfg.levels);
  const uLeaf = uniform(cfg.leafSize);
  const uLodScale = uniform(cfg.lodScale);
  const uMorphStart = uniform(cfg.morphStart);
  const uHalf = uniform(half);
  const uWin = uniform(cfg.windowCells);
  const uPatch = uniform(q);
  const uBaseAmp = uniform(o.baseAmp), uLake = uniform(o.lake), uLakeDepth = uniform(o.lakeDepth);

  // ---- analytic field in TSL (transcription of grass-height-ref.js) ----
  const lakeHashFn = Fn(([ix, iz]) => {
    let h = asU(ix).mul(uint(374761393)).bitXor(asU(iz).mul(uint(668265263)));
    h = h.bitXor(h.shiftRight(uint(13))).mul(uint(1274126177));
    h = h.bitXor(h.shiftRight(uint(16)));
    return h.toFloat().div(4294967296.0);
  });
  const lakeNoiseFn = Fn(([x, z]) => {
    const fx = floor(x), fz = floor(z);
    const ix = int(fx), iz = int(fz);
    const u = x.sub(fx), v = z.sub(fz);
    const su = u.mul(u).mul(float(3).sub(u.mul(2)));
    const sv = v.mul(v).mul(float(3).sub(v.mul(2)));
    const a = lakeHashFn(ix, iz), b = lakeHashFn(ix.add(int(1)), iz);
    const c = lakeHashFn(ix, iz.add(int(1))), d = lakeHashFn(ix.add(int(1)), iz.add(int(1)));
    return mix(mix(a, b, su), mix(c, d, su), sv);
  });
  const heightFn = Fn(([x, z]) => {
    const h = sin(x.mul(0.10)).mul(1.1)
      .add(cos(z.mul(0.085)).mul(1.0))
      .add(sin(x.add(z).mul(0.16)).mul(0.5))
      .add(cos(x.sub(z).mul(0.22).add(0.8)).mul(0.35))
      .add(sin(x.mul(0.38).add(z.mul(0.27))).mul(0.18))
      .add(cos(z.mul(0.44).sub(x.mul(0.19))).mul(0.14))
      .mul(uBaseAmp);
    const t = float(1).sub(uLake);
    const nz = lakeNoiseFn(x.mul(0.045).add(10.5), z.mul(0.045).sub(7.2));
    const basin = clamp(nz.sub(t).div(0.15), 0, 1);
    const basinSS = basin.mul(basin).mul(float(3).sub(basin.mul(2)));
    return h.sub(basinSS.mul(uLakeDepth));
  });

  // min distance (XZ) from camera to cell [ox,ox+s]x[oz,oz+s]
  const minDistFn = Fn(([ox, oz, s, cx, cz]) => {
    const dx = max(max(ox.sub(cx), cx.sub(ox.add(s))), 0);
    const dz = max(max(oz.sub(cz), cz.sub(oz.add(s))), 0);
    return sqrt(dx.mul(dx).add(dz.mul(dz)));
  });
  // range at a level: leaf * 2^L * lodScale  (2^L via exp2)
  const rangeFn = Fn(([L]) => uLeaf.mul(float(2).pow(L)).mul(uLodScale));
  const sizeFn = Fn(([L]) => uLeaf.mul(float(2).pow(L)));

  // ---- compute: reset → select → finalize ----
  const reset = Fn(() => { atomicStore(counter.element(0), uint(0)); })().compute(1);

  const select = Fn(() => {
    const idx = int(instanceIndex);                       // 0 .. CANDIDATES-1
    const win = int(uWin);
    const cellsPerLevel = win.mul(win);
    const L = idx.div(cellsPerLevel);                     // which level
    const inLevel = modInt(idx, cellsPerLevel);
    const lx = modInt(inLevel, win).sub(int(uHalf));
    const lz = inLevel.div(win).sub(int(uHalf));
    const Lf = L.toFloat();
    const s = sizeFn(Lf);
    const cCellX = floor(uCam.x.div(s));
    const cCellZ = floor(uCam.y.div(s));
    const ix = int(cCellX).add(lx);
    const iz = int(cCellZ).add(lz);
    const ox = ix.toFloat().mul(s);
    const oz = iz.toFloat().mul(s);
    const d = minDistFn(ox, oz, s, uCam.x, uCam.y);
    const rangeL = rangeFn(Lf);

    // notRefined: L==0 OR d > range[L-1]
    const rangeInner = rangeFn(Lf.sub(1));
    const notRefined = L.equal(int(0)).or(d.greaterThan(rangeInner));
    // refinedByParent: L==levels-1 OR parentMinDist <= range[L]
    const ps = sizeFn(Lf.add(1));
    // parent cell index = floor(ix/2) (works for negatives via float floor)
    const pIx = floor(ix.toFloat().mul(0.5));
    const pIz = floor(iz.toFloat().mul(0.5));
    const pd = minDistFn(pIx.mul(ps), pIz.mul(ps), ps, uCam.x, uCam.y);
    const refinedByParent = L.equal(int(uLevels).sub(1)).or(pd.lessThanEqual(rangeL));

    If(notRefined.and(refinedByParent), () => {
      // morphK = clamp((d - morphStart*range)/((1-morphStart)*range), 0, 1)
      const startD = uMorphStart.mul(rangeL);
      const morphK = clamp(d.sub(startD).div(rangeL.sub(startD).max(1e-4)), 0, 1);
      const sIdx = atomicAdd(counter.element(0), uint(1));
      // pack level into integer part, morphK into fraction (level<256, morphK in [0,1))
      const packed = Lf.add(morphK.mul(0.999));
      inst.element(sIdx).assign(vec4(ox, oz, s, packed));
    });
  })().compute(CANDIDATES);

  const finalize = Fn(() => { indirect.element(1).assign(atomicLoad(counter.element(0))); })().compute(1);

  // ---- node material: morph grid coord, displace by analytic height, analytic normal ----
  geo.instanceCount = CANDIDATES;
  geo.indirect = indirectAttr;

  const aGrid = attribute('aGrid', 'vec2');
  const rec = inst.element(instanceIndex);             // (ox, oz, size, packed)
  const ox = rec.x, oz = rec.y, s = rec.z;
  const level = floor(rec.w);
  const morphK = rec.w.sub(level).div(0.999);

  // CDLOD morph on each grid axis: pull odd verts toward the even (parent) lattice
  const Nf = float(q);
  const morphAxis = Fn(([g]) => {
    const gi = g.mul(Nf);
    const fr = gi.mul(0.5).sub(floor(gi.mul(0.5)));     // 0 on even, 0.5 on odd
    return g.sub(fr.mul(2).div(Nf).mul(morphK));
  });
  const gX = morphAxis(aGrid.x);
  const gZ = morphAxis(aGrid.y);
  const wx = ox.add(gX.mul(s));
  const wz = oz.add(gZ.mul(s));
  const wy = heightFn(wx, wz);
  const posNode = vec3(wx, wy, wz);

  // analytic normal via central difference of heightFn (matches terrainNormalAt, e=0.5)
  const e = float(0.5);
  const nL = heightFn(wx.sub(e), wz), nR = heightFn(wx.add(e), wz);
  const nD = heightFn(wx, wz.sub(e)), nU = heightFn(wx, wz.add(e));
  const nrm = vec3(nL.sub(nR), e.mul(2), nD.sub(nU));

  const mat = new MeshStandardNodeMaterial({ color: 0x2a2f38, roughness: 1, metalness: 0 });
  mat.positionNode = posNode;
  mat.normalNode = nrm.normalize();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = 'CdlodTerrain';

  let lastCount = 0;
  return {
    mesh,
    async update() {
      uCam.value.set(camera.position.x, camera.position.z);
      await renderer.computeAsync(reset);
      await renderer.computeAsync(select);
      await renderer.computeAsync(finalize);
    },
    setViewDistance(levels) { uLevels.value = Math.max(2, Math.min(cfg.levels, Math.round(levels))); },
    maxLevels: cfg.levels,
    setTerrain(p) { uBaseAmp.value = p.baseAmp; uLake.value = p.lake; uLakeDepth.value = p.lakeDepth; },
    setWaterLevel() { /* terrain ground ignores water level; kept for API symmetry with grass */ },
    get triangleCount() { return (indexCount / 3) * (indirectAttr.array[1] || 0); },
    get drawCount() { return 1; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
```

- [ ] **Step 2: Sanity-check it parses under Node's module resolver** (catches typos/bad imports before the browser)

Run: `node --input-type=module -e "import('./cdlod-terrain.js').then(()=>console.log('import attempted')).catch(e=>{console.log(String(e).split(String.fromCharCode(10))[0])})"`
Expected: prints a line. `Cannot find package 'three'` (no node_modules/three resolvable as bare specifier) is ACCEPTABLE — it means our file parsed and only the bare `three` import failed. A `SyntaxError` in `cdlod-terrain.js` is a FAIL — fix it.

- [ ] **Step 3: Commit**

```bash
git add cdlod-terrain.js
git commit -m "feat(sp3): cdlod-terrain.js — compute select + morph displacement, indirect draw

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: TerrainSystem `external` visual mode

**Files:**
- Modify: `terrain-system.js` (DEFAULTS, `makeChunk`, `addChunk`, `disposeChunk`, `materialPatchTarget`)

- [ ] **Step 1: Add the param** — `terrain-system.js`, in `DEFAULTS` (after `renderMode`):

```js
    renderMode: 'chunks',       // 'chunks' = one mesh/chunk; 'instanced' = one shader-displaced InstancedMesh
    visualMode: 'mesh',         // 'mesh' = build visible chunk geometry; 'external' = records+colliders only (GPU ground renders elsewhere)
```

- [ ] **Step 2: Skip visual geometry in `external` mode** — replace `makeChunk` (currently builds a `THREE.Mesh` with displaced geometry):

```js
  makeChunk(key, xMin, zMin, size, segments, geo) {
    const meta = { key, xMin, zMin, size, segments, lod: 0 };
    if (this.params.visualMode === 'external') {
      // No visible geometry — just a record carrying terrainChunk metadata so activeChunks,
      // decorations and colliders keep working while the GPU CDLOD mesh renders the ground.
      if (geo) geo.dispose();
      return { key, mesh: null, meta, collider: null, xMin, zMin, size };
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `TerrainChunk:${key}`;
    mesh.receiveShadow = true;
    mesh.userData.terrainChunk = meta;
    return { key, mesh, meta, collider: null, xMin, zMin, size };
  }
```

- [ ] **Step 3: Guard mesh access** in `addChunk`, `disposeChunk`, `update` (primaryMesh), `refreshActiveChunkCache`, `materialPatchTarget`:

In `addChunk` — only add a mesh when one exists:
```js
  addChunk(chunk) {
    this.chunks.set(chunk.key, chunk);
    if (chunk.mesh && this.renderMode !== 'instanced') this.group.add(chunk.mesh);
    if (this.collisionKeys.has(chunk.key)) this.collisionGroup.add(this.ensureCollider(chunk));
    if (!this.primaryMesh && chunk.mesh) this.primaryMesh = chunk.mesh;
  }
```

In `disposeChunk`:
```js
  disposeChunk(chunk) {
    if (chunk.mesh) {
      chunk.mesh.geometry.dispose();
      if (chunk.mesh.parent === this.group) this.group.remove(chunk.mesh);
    }
    this.releaseCollider(chunk);
  }
```

In `update`, the `primaryMesh` line:
```js
    const first = this.chunks.values().next().value || null;
    this.primaryMesh = first && first.mesh ? first.mesh : null;
```

In `refreshActiveChunkCache`, read from `chunk.meta` instead of `chunk.mesh.userData.terrainChunk`:
```js
  refreshActiveChunkCache() {
    this.activeChunkCache = [...this.chunks.values()].filter((chunk) => this.targetKeys.has(chunk.key)).map((chunk) => {
      const data = chunk.meta;
      return {
        key: data.key, xMin: data.xMin, zMin: data.zMin, size: data.size,
        centerX: data.xMin + data.size * 0.5, centerZ: data.zMin + data.size * 0.5,
      };
    });
  }
```

In `ensureCollider`, it reads `chunk.xMin` etc. (already on the record) — leave as is. In `materialPatchTarget`:
```js
  get materialPatchTarget() {
    if (this.renderMode === 'instanced' && this.instancedTerrain) return this.instancedTerrain;
    return this.primaryMesh;   // null in external mode → host points `ground` at the CDLOD mesh
  }
```

- [ ] **Step 4: Verify chunks mode is unchanged** (no Node test harness for three.js; this is a read-through). Confirm: every `chunk.mesh.userData.terrainChunk` access was migrated to `chunk.meta`, and `makeChunk`'s `'mesh'` branch still sets `mesh.userData.terrainChunk = meta` so any external reader still works. Grep:

Run: `grep -n "userData.terrainChunk\|chunk.mesh\|chunk.meta" terrain-system.js`
Expected: the only `userData.terrainChunk` writes are in `makeChunk` (mesh branch) and `ensureCollider`; no remaining `chunk.mesh.userData` *reads* in `refreshActiveChunkCache`.

- [ ] **Step 5: Commit**

```bash
git add terrain-system.js
git commit -m "feat(sp3): TerrainSystem external visual mode (records+colliders, no visual meshes)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire into the viewer behind `?terrain=`, HUD, slider; browser checkpoint

**Files:**
- Modify: `environment-viewer.html` (terrain construction ~L85–94; `animate()` render; HUD ~L107–148; `rebuildWorld` ~L257–267; sliders ~L924–939)

> NOTE: `environment-viewer.html` has uncommitted Codex changes (leaf-size). Stage ONLY the
> SP3 hunks with `git add -p`; never `git add environment-viewer.html` wholesale.

- [ ] **Step 1: Add the mode flag + construct the CDLOD ground** — after `const terrainSystem = createTerrainSystem(...)` (~L90):

```js
const TERRAIN_MODE = new URLSearchParams(location.search).get('terrain') || 'gpu';
const terrainSystem = createTerrainSystem({ params: { ...terrain, visualMode: TERRAIN_MODE === 'gpu' ? 'external' : 'mesh' } });
const terrainGroup = terrainSystem.group;
const terrainCollisionGroup = terrainSystem.collisionGroup;
let cdlodRef = null;
let ground = terrainSystem.materialPatchTarget;
function terrainHeight(x, z) { return terrainSystem.getHeight(x, z); }
```

- [ ] **Step 2: Lazy-load the GPU terrain** — near where grass is created (the `createComputeGrass` block, ~L1089), add a sibling loader and call it during init:

```js
if (TERRAIN_MODE === 'gpu') {
  const { createCdlodTerrain } = await import('./cdlod-terrain.js');
  cdlodRef = createCdlodTerrain({
    renderer, camera,
    terrainParams: { baseAmp: terrain.baseAmp, lake: terrain.lake, lakeDepth: terrain.lakeDepth },
    waterLevel: terrain.waterLevel,
  });
  scene.add(cdlodRef.mesh);
  ground = cdlodRef.mesh;
}
```

- [ ] **Step 2b: Update the CDLOD compute before the draw** — in `animate()`, beside `if (grassRef) await grassRef.update(...)`, add:

```js
      if (cdlodRef) await cdlodRef.update();
```

- [ ] **Step 3: HUD + perfLog** — in the HUD text block (~L107) add a terrain-draw line, and in perfLog (~L145) add fields:

HUD (replace the `terrain ${...}` line):
```js
    `terrain ${terrainSystem.renderMode}${cdlodRef ? ' · cdlod' : ''}\n` +
    (cdlodRef ? `terrain draws ${cdlodRef.drawCount} · tris ${cdlodRef.triangleCount}\n` : `chunks ${terrainSystem.activeChunks.length}/${terrainSystem.targetChunkCount}\n`) +
```

perfLog object (add two fields):
```js
      terrainDraws: cdlodRef ? cdlodRef.drawCount : terrainSystem.activeChunks.length,
      terrainTris: cdlodRef ? cdlodRef.triangleCount : null,
```

- [ ] **Step 4: Push terrain edits on rebuild** — in `rebuildWorld` (after the grass `setTerrain`/`setWaterLevel`, ~L267):

```js
  if (cdlodRef) { cdlodRef.setTerrain({ baseAmp: terrain.baseAmp, lake: terrain.lake, lakeDepth: terrain.lakeDepth }); cdlodRef.setWaterLevel(terrain.waterLevel); }
```

- [ ] **Step 5: Drive view distance** — in `drawDistanceChange` (the `renderRadius` slider cb, ~L936) also push to CDLOD level count (map chunk draw distance 1–12 → CDLOD levels):

```js
  function drawDistanceChange() {
    terrainSystem.params.renderRadius = Math.round(terrain.renderRadius);
    if (cdlodRef) cdlodRef.setViewDistance(2 + Math.round(terrain.renderRadius));  // 1..12 → 3..14 capped at maxLevels
    // ... existing far-plane / camera update ...
  }
```

- [ ] **Step 6: Browser checkpoint** (server already runs on :8001; if not, `python -m http.server 8001`):

Open `http://localhost:8001/environment-viewer.html` (GPU default) and a second tab `…?terrain=chunks`.
Verify:
1. GPU terrain renders a continuous lit ground matching the chunked version's shape (same hills/lakes).
2. Flying with `F` / orbiting shows **no cracks** at LOD boundaries and **no popping** as LODs swap (morphing).
3. HUD shows `terrain draws 1` and a bounded `tris` that does NOT grow as you raise the Draw-distance slider.
4. Trees, grass, and water still appear and sit on the ground (decorations still read `activeChunks` + `getHeight`).
5. Creatures still walk on the surface (analytic collision intact).

If the ground flickers: the compute chain isn't awaited — confirm `await cdlodRef.update()` is before `renderer.render`. If there's a uint/"expected a uint" error: an integer index used `.div`/`.mod` in the float domain — use `modInt` + int division (see `select`).

- [ ] **Step 7: Commit (SP3 hunks only)**

```bash
git add -p environment-viewer.html   # stage ONLY the SP3 hunks, skip Codex's leaf-size hunks
git commit -m "feat(sp3): wire GPU CDLOD terrain behind ?terrain=gpu; HUD draws/tris + view-distance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: dd9 perf gate + documentation

**Files:**
- Create: `research/stats/` dd9 CSVs (`-cdlod` / `-chunks`)
- Modify: `research/webgpu/sp1-migration-notes.md`, `research/webgpu/webgpu-parallelism-over-serial-synthesis.html` (+ sync the `workshop/` copies)

- [ ] **Step 1: Capture dd9 A/B** — run the in-app perf capture (the same dd9 flow used for SP1/SP2) at increasing Draw-distance for both `?terrain=gpu` and `?terrain=chunks`; save CSVs to `research/stats/` named `dd9-sp3-cdlod-*.csv` and `dd9-sp3-chunks-*.csv`. The headline numbers: terrain draws + tris vs draw distance (flat for cdlod, growing for chunks), and `cpuMs` delta.

- [ ] **Step 2: Write SP3 migration notes** — append an SP3 section to `sp1-migration-notes.md` covering: the pipeline (camera-snapped Morton quadtree, flattened band selection, morph, indirect draw), the confirmed substitutions (flattened selection for producer/consumer queue; vertex displacement for tessellation — both faithful to the paper's own substitution logic), gotchas hit, and the dd9 numbers. Then copy the file to `../workshop/research/webgpu/sp1-migration-notes.md`.

- [ ] **Step 3: Update the synthesis paper** — mark the SP3 box `complete ✓`, add a `.callout.result` block (mirroring SP1/SP2) with the dd9 table (terrain draws/tris flat vs distance; cpuMs delta) and the honest framing (flattened selection substitution, collision still analytic, no cracks/popping confirmed). Sync to `../workshop/research/webgpu/webgpu-parallelism-over-serial-synthesis.html`. Verify div/table tag balance before committing.

- [ ] **Step 4: Commit**

```bash
git add research/stats/dd9-sp3-*.csv research/webgpu/sp1-migration-notes.md research/webgpu/webgpu-parallelism-over-serial-synthesis.html
git commit -m "docs(sp3): dd9 cdlod-vs-chunks gate; fold SP3 results into notes + synthesis paper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** Gate 1 (flat cost) → Task 2 bounded-cost test + Task 6 HUD + Task 7 dd9. Gate 2 (no cracks/popping) → Task 3 morph test + Task 6 visual. Gate 3 (analytic collision) → Task 5 keeps `getHeight`/colliders + Task 6 check 5. Gate 4 (CPU drop) → Task 5 external mode + Task 7 cpuMs. Decisions 1–6 all map to Tasks 4–6. Components (cdlod-select/field/terrain, terrain-system, viewer) all have tasks. Testing section (3 Node tests + browser + dd9) all present.

**Placeholder scan:** No TBD/"handle edge cases"/"similar to". The one descriptive (non-code) step is Task 7 Step 1 (manual perf capture) — unavoidable, it's a measurement, and the file targets + naming are explicit.

**Type consistency:** `cfg` shape `{leafSize, levels, patchQuads, lodScale, morphStart, windowCells}` identical across Tasks 1–4. `selectNodes` node fields `{level, ix, iz, originX, originZ, size, d, morphK}` consistent. `morphGridCoord(g, N, morphK)` (JS) ↔ `morphAxis(g)` (TSL) use the same formula. `createCdlodTerrain` returns `{mesh, update, setViewDistance, maxLevels, setTerrain, setWaterLevel, triangleCount, drawCount, dispose}` — all consumed in Task 6. `chunk.meta` introduced in Task 5 Step 2 and read in Step 3 consistently. Instance record is `vec4(ox,oz,s,packed)` in both the `select` write and the material read.
