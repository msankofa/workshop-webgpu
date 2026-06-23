# SP5 Phase B — Tree-Trunk Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Make tree trunks solid for the FPS player via cheap lateral capsule-vs-trunk-circle push-out, fed by per-chunk trunk data derived from the forest's existing placement step. No mesh, no BVH, no rebuild spike.

**Architecture:** Extend the pure `collision.js` with `resolveTrunks()` (2D circle-vs-circle MTV in XZ, iterated) and `createTrunkIndex(chunkSize)` (a chunk-bucketed trunk store with `setTrunks`/`clearTrunks`/`resolve`). Node-tested. The viewer registers each baked tree chunk's trunks (`{x, z, r ≈ 1.2·scale}`) on commit and clears them on dispose; `updateFPSPlayer` resolves the player capsule against nearby trunks after the ground lift, lateral only.

**Scope:** Player only. Creatures keep steering-based avoidance for now (the spec permits this); creature trunk push-out is a deferred follow-up because it requires threading the index through `port-creature-bridge.js` into each creature's `physicsStep` (`port-creature-system.js:2386`), which touches the sensitive sim.

**Tech Stack:** ES modules, Node 20 tests, Three.js r0.184 WebGPU (browser checkpoint for the player feel).

---

## Verified integration facts
- Each tree's world `(x, z)` and `scale s` are known in `buildNextTreeInJob` (`environment-viewer.html:826-828`). Trunk world radius ≈ `trees.js radius[0] (1.2) · s`.
- Tree chunks are keyed by terrain chunk key (`ix,iz`), committed in `finishTreeJob`→`commitTreeChunk`, and disposed in `disposeTreeChunk` (called on terrain-chunk unload `:865` and on drop-to-zero `:880`). Hooking registration into `finishTreeJob` and clearing into `disposeTreeChunk` covers all paths.
- `terrainSystem.params.chunkSize` is the bucket size (30).
- Player capsule axis XZ is `playerCollider.start.x/.z`, radius `0.35`.

---

## Task 1: Trunk math + index (`collision.js`) — TDD

**Files:** Modify `collision.js`; extend `test-collision.mjs`.

- [ ] **Step 1: Add failing tests** to `test-collision.mjs` (append before the final summary line):

```javascript
import { resolveTrunks, createTrunkIndex } from './collision.js';

// 5. resolveTrunks: single overlap pushes to exactly radius+r from centre.
{
  const trunks = [{ x: 0, z: 0, r: 1.0 }];
  const out = resolveTrunks(0.5, 0, 0.35, trunks);
  const d = Math.hypot(out.x, out.z);
  ok(out.pushed === true, '5: overlap reports pushed');
  ok(near(d, 1.35, 1e-9), '5: pushed to radius+r (1.35)');
  ok(near(out.z, 0), '5: push is radial (z stays 0)');
}

// 6. resolveTrunks: outside range untouched.
{
  const out = resolveTrunks(5, 5, 0.35, [{ x: 0, z: 0, r: 1.0 }]);
  ok(out.pushed === false, '6: no push when clear');
  ok(out.x === 5 && out.z === 5, '6: position unchanged when clear');
}

// 7. resolveTrunks: point at exact centre pushes deterministically along +x.
{
  const out = resolveTrunks(0, 0, 0.35, [{ x: 0, z: 0, r: 1.0 }]);
  ok(near(out.x, 1.35) && near(out.z, 0), '7: centre degenerate pushes +x');
}

// 8. resolveTrunks: two adjacent trunks resolve without ending inside either.
{
  const trunks = [{ x: 0, z: 0, r: 1.0 }, { x: 2.4, z: 0, r: 1.0 }];
  const out = resolveTrunks(1.2, 0, 0.35, trunks);
  const inAny = trunks.some(t => Math.hypot(out.x - t.x, out.z - t.z) < 0.35 + t.r - 1e-6);
  ok(inAny === false, '8: resolved out of both trunks (no tunneling)');
}

// 9. createTrunkIndex: bucketed set/resolve/clear.
{
  const idx = createTrunkIndex(30);                 // chunkSize 30
  idx.setTrunks('0,0', [{ x: 5, z: 5, r: 1.0 }]);   // trunk in chunk (0,0)
  const hit = idx.resolve(5.5, 5, 0.35);
  ok(hit.pushed === true, '9: index resolves a nearby trunk');
  const far = idx.resolve(500, 500, 0.35);
  ok(far.pushed === false, '9: far point unaffected');
  idx.clearTrunks('0,0');
  ok(idx.resolve(5.5, 5, 0.35).pushed === false, '9: clearTrunks removes the bucket');
}
```

- [ ] **Step 2:** `node test-collision.mjs` → FAIL (`resolveTrunks`/`createTrunkIndex` not exported).

- [ ] **Step 3: Implement** in `collision.js` (append):

```javascript
// Lateral 2D circle-vs-circle push-out: move a point at (px,pz) with collision radius
// `radius` out of any overlapping trunk circle {x,z,r}. Iterates so resolving the deepest
// overlap does not leave the point inside another. Lateral only (no Y). Returns {x,z,pushed}.
export function resolveTrunks(px, pz, radius, trunks, iterations = 4) {
  let x = px, z = pz, pushed = false;
  for (let it = 0; it < iterations; it++) {
    let best = null, bestPen = 0;
    for (const t of trunks) {
      const dx = x - t.x, dz = z - t.z;
      const minD = radius + t.r;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const pen = minD - d;
        if (pen > bestPen) { bestPen = pen; best = { tx: t.x, tz: t.z, dx, dz, d, minD }; }
      }
    }
    if (!best) break;
    pushed = true;
    if (best.d > 1e-6) {
      const inv = best.minD / best.d;
      x = best.tx + best.dx * inv;
      z = best.tz + best.dz * inv;
    } else {
      x = best.tx + best.minD;   // exactly at centre: deterministic +x
      z = best.tz;
    }
  }
  return { x, z, pushed };
}

// Chunk-bucketed trunk store. Keys are terrain chunk keys ("ix,iz"); resolve() only tests
// the point's chunk plus its 8 neighbours, so cost is bounded regardless of forest size.
export function createTrunkIndex(chunkSize) {
  const buckets = new Map();
  return {
    setTrunks(key, trunks) { if (trunks && trunks.length) buckets.set(key, trunks); else buckets.delete(key); },
    clearTrunks(key) { buckets.delete(key); },
    resolve(px, pz, radius) {
      const cx = Math.floor(px / chunkSize), cz = Math.floor(pz / chunkSize);
      const near = [];
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
          const b = buckets.get(`${ix},${iz}`);
          if (b) for (const t of b) near.push(t);
        }
      }
      if (near.length === 0) return { x: px, z: pz, pushed: false };
      return resolveTrunks(px, pz, radius, near);
    },
  };
}
```

- [ ] **Step 4:** `node test-collision.mjs` → expect `22 passed, 0 failed` (13 prior + 9 new).

- [ ] **Step 5: Commit**

```bash
git add collision.js test-collision.mjs
git commit -m "$(printf 'SP5b: trunk circle push-out + chunk-bucketed trunk index + Node tests\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2: Wire trunk registration + player push-out (viewer)

**Files:** Modify `environment-viewer.html`.

- [ ] **Step 1: Import + construct the index.** Change the collision import:

```javascript
import { groundContact, slideVelocity, createTrunkIndex } from './collision.js';
```

After `function terrainNormal(...)` (near L102), add:

```javascript
const TRUNK_RADIUS_PER_SCALE = 1.2;   // trees.js trunk base radius[0] = 1.2, scaled per tree
const trunkIndex = createTrunkIndex(terrainSystem.params.chunkSize);
```

- [ ] **Step 2: Collect trunks during bake.** In `createTreeBuildJob`'s returned job object (L786-797), add `trunks: [],`. In `buildNextTreeInJob`, right after `const s = sizeFor(params, x, z, treeRng);` (L826), add:

```javascript
      job.trunks.push({ x, z, r: TRUNK_RADIUS_PER_SCALE * s });
```

- [ ] **Step 3: Register on commit.** In `finishTreeJob` (L838-840):

```javascript
  function finishTreeJob(job) {
    commitTreeChunk(job.chunk, job.B, job.L, job.LS);
    trunkIndex.setTrunks(job.chunk.key, job.trunks);
  }
```

- [ ] **Step 4: Clear on dispose.** In `disposeTreeChunk` (L744-749), add as the first line of the body:

```javascript
    trunkIndex.clearTrunks(chunk.key);
```

- [ ] **Step 5: Player push-out.** Add a scratch vector next to `_collisionLift` (above `updateFPSPlayer`):

```javascript
const _trunkPush = new THREE.Vector3();
```

In `updateFPSPlayer`, immediately after the ground-contact `if (contact.penetration > 0) { ... }` block, add:

```javascript
  const tr = trunkIndex.resolve(playerCollider.start.x, playerCollider.start.z, playerCollider.radius);
  if (tr.pushed) {
    playerCollider.translate(_trunkPush.set(tr.x - playerCollider.start.x, 0, tr.z - playerCollider.start.z));
  }
```

- [ ] **Step 6: Sanity-load the module.**

Run: `node -e "import('./collision.js').then(m=>console.log(Object.keys(m)))"`
Expected: `[ 'groundContact', 'slideVelocity', 'resolveTrunks', 'createTrunkIndex' ]`

- [ ] **Step 7: Commit**

```bash
git add environment-viewer.html
git commit -m "$(printf 'SP5b: register baked trunks per chunk; player capsule push-out vs trunks\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3: Browser checkpoint (human)

- [ ] Serve (`python -m http.server 8001`), open the viewer, press **F**.
- [ ] Walk straight into a tree trunk → blocked, slides around it; cannot pass through. Larger trees block from farther out (radius scales with size).
- [ ] Walk through a dense cluster → no tunneling between adjacent trunks; no jitter when standing against one.
- [ ] Streaming check: walk across chunk boundaries; trunks become solid as chunks load and cause no frame spike (registration is O(trees-in-chunk), no rebuild).
- [ ] Creatures still wander normally (unchanged; they walk through trunks for now, as scoped).

---

## Self-Review
- Spec Phase B "vertical-capsule collider per tree from placement data, chunk-bucketed, lateral push-out" → Tasks 1+2. ✓ (vertical capsule reduces to a 2D circle in XZ since push-out is lateral and trunks are tall; no Y term needed.)
- Spec "trunk registration streams with chunks with no rebuild spike" → register on commit / clear on dispose, O(trees), no mesh. ✓
- Spec gate "player ... can no longer walk through tree trunks" → Task 2 + checkpoint. ✓
- Spec gate "and creatures" → **deferred** (spec permits steering-based avoidance); creature push-out is a noted follow-up threading `trunkIndex.resolve` into `port-creature-system.js:2386`.
- Placeholder scan: none. Type consistency: trunk record `{x,z,r}` and `resolve()→{x,z,pushed}` consistent across `collision.js`, tests, and viewer.
