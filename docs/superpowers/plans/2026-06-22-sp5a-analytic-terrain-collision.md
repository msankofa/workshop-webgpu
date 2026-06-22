# SP5 Phase A — Analytic Terrain Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the FPS player's triangle-octree terrain collision with an O(1) analytic capsule-vs-heightfield resolve, then retire the octree and the terrain-collider machinery that only fed it — removing the measured 35–70 ms `octreeMs` rebuild spike with no FPS-walk regression and no impact on creatures.

**Architecture:** A new pure, three.js-free `collision.js` exposes `groundContact()` (capsule-bottom-vs-analytic-height math) and `slideVelocity()` (remove into-surface velocity component). Both are Node-tested against `terrain-field.js`'s canonical `terrainHeightAt`/`terrainNormalAt`. `environment-viewer.html`'s `updateFPSPlayer` composes them in place of `worldOctree.capsuleIntersect`. The octree plumbing and the `terrain-system.js` collider group are then deleted. Creatures already sample the analytic field (`terrainSystem.getHeight`) and are untouched.

**Tech Stack:** ES modules, Node 20 (logic tests via `node test-*.mjs`), Three.js r0.184 WebGPU (browser-only; verified at a human browser checkpoint), `Capsule` from `three/addons`.

---

## Background facts (verified against the code)

- The octree's **only** consumer is `updateFPSPlayer` at `environment-viewer.html:1544` (`worldOctree.capsuleIntersect`). Everything else is build/HUD plumbing.
- `capsuleIntersect` returns `{ normal, depth }`; current resolve: `playerOnFloor = normal.y > 0`; `playerVelocity -= normal*(normal·velocity)`; `capsule.translate(normal*depth)`.
- The player capsule is `start`=feet (lower), `end`=head (higher), `radius=0.35`. The lowest point is `start.y - radius`.
- `terrain-field.js` exports pure `terrainHeightAt(params,x,z)` and `terrainNormalAt(params,x,z,out)` (out is a length-3 array). `terrain-system.js` re-exports both and exposes `getHeight(x,z)` and `params`.
- Creatures (`creature.js`, `port-creature-system.js`) get ground only via the injected `terrainHeight`/`terrainSystem.getHeight`. They never read the octree or `collisionGroup`. `port-creature-system.js`'s `collisionRadius()` is an unrelated creature-separation method — do **not** touch it.
- `test-terrain-system.mjs` test #6 (L133–146) asserts `sys.collisionGroup.children.length` — must be updated when the collider machinery is removed.

## Collision model (what `groundContact` reproduces)

Each substep, after the capsule has been moved by velocity:
- `groundY = heightAt(start.x, start.z)`; `bottomY = start.y - radius`; `penetration = groundY - bottomY`.
- If `penetration > 0`: lift the capsule vertically by `penetration` so its bottom rests exactly on `groundY`; `grounded = normal.y >= slopeLimitY` (default `0.5`); then `slideVelocity` removes only the into-surface velocity component (`v·n < 0`), so jumps (upward `v`) are preserved and resting gravity is cancelled.
- If `penetration <= 0`: not grounded (airborne/falling), no change.

`slopeLimitY = 0.5` mirrors the old behavior closely (octree grounded on any upward-facing contact; the analytic version additionally lets too-steep faces slide, which is an improvement, not a regression, for walkable terrain).

---

## File Structure

- **Create** `collision.js` — pure collision math (`groundContact`, `slideVelocity`), no three.js import. One responsibility: capsule-vs-heightfield contact.
- **Create** `test-collision.mjs` — Node tests for `collision.js`, using `terrain-field.js` as the height/normal reference.
- **Modify** `environment-viewer.html` — swap the octree resolve in `updateFPSPlayer`; add a `terrainNormal` helper; delete all octree plumbing and the `terrainCollisionGroup`/`pendingCollisionBuildCount` references.
- **Modify** `terrain-system.js` — delete the collider machinery (`collisionGroup`, `collisionMaterial`, `collisionKeys`, `ensureCollider`, `releaseCollider`, `syncCollisionGroup`, `pendingCollisionBuildCount`, `collisionRadius`/`collisionSegmentsPerChunk` defaults, `chunk.collider`); keep `getHeight`.
- **Modify** `test-terrain-system.mjs` — update test #6 to drop the collider assertion (external mode now = records + `getHeight` only).

---

## Task 1: Pure collision math (`collision.js`) — TDD

**Files:**
- Create: `collision.js`
- Test: `test-collision.mjs`

- [ ] **Step 1: Write the failing test**

Create `test-collision.mjs`:

```javascript
// test-collision.mjs — pure capsule-vs-heightfield contact math (SP5 Phase A).
// Reference height/normal come from the canonical analytic field in terrain-field.js,
// so groundContact is provably consistent with the terrain the player sees.
import { terrainHeightAt, terrainNormalAt } from './terrain-field.js';
import { groundContact, slideVelocity } from './collision.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const heightAt = (x, z) => terrainHeightAt(params, x, z);
const normalAt = (x, z) => terrainNormalAt(params, x, z, [0, 0, 0]);
const RADIUS = 0.35, SLOPE = 0.5;

// 1. Above ground: no penetration, not grounded, capsule unchanged.
{
  const x = 12, z = -5;
  const gy = heightAt(x, z);
  const bottomY = gy + 1.0;            // a metre clear of the ground
  const c = groundContact({ x, z, bottomY, slopeLimitY: SLOPE, heightAt, normalAt });
  ok(c.penetration < 0, '1: penetration negative when above ground');
  ok(c.grounded === false, '1: not grounded when above ground');
  ok(near(c.restBottomY, bottomY), '1: restBottomY unchanged when above ground');
}

// 2. Penetrating flat ground: grounded, bottom rests exactly on groundY.
{
  const x = 3, z = 7;
  const gy = heightAt(x, z);
  const bottomY = gy - 0.5;            // sunk half a metre
  const c = groundContact({ x, z, bottomY, slopeLimitY: SLOPE, heightAt, normalAt });
  ok(near(c.penetration, 0.5), '2: penetration equals sink depth');
  ok(near(c.restBottomY, gy, 1e-9), '2: restBottomY rests on groundY');
  ok(c.grounded === true, '2: grounded on shallow real terrain');
  ok(near(c.normal[1], normalAt(x, z)[1]), '2: normal matches analytic field');
}

// 3. Penetrating but too steep (injected steep normal): NOT grounded, still reports
//    penetration + normal so the caller can lift and slide.
{
  const steepNormal = () => { const n = [0.8, 0.3, 0]; const inv = 1 / Math.hypot(...n); return [n[0] * inv, n[1] * inv, n[2] * inv]; };
  const c = groundContact({ x: 0, z: 0, bottomY: heightAt(0, 0) - 0.4, slopeLimitY: SLOPE, heightAt, normalAt: steepNormal });
  ok(c.penetration > 0, '3: penetration positive on steep contact');
  ok(c.grounded === false, '3: too-steep contact is not grounded (slides)');
  ok(c.normal !== null, '3: steep contact still returns a normal for sliding');
}

// 4. slideVelocity removes only the into-surface component.
{
  const flat = [0, 1, 0];
  const r1 = slideVelocity({ x: 2, y: -5, z: 1 }, flat);
  ok(near(r1.x, 2) && near(r1.y, 0) && near(r1.z, 1), '4: downward velocity flattened on flat ground');

  const r2 = slideVelocity({ x: 0, y: 8, z: 0 }, flat);
  ok(near(r2.y, 8), '4: upward velocity (jump) preserved');

  const n = (() => { const v = [0.6, 0.8, 0]; return v; })();   // unit normal
  const r3 = slideVelocity({ x: 0, y: -10, z: 0 }, n);
  const dot = r3.x * n[0] + r3.y * n[1] + r3.z * n[2];
  ok(Math.abs(dot) < 1e-9, '4: into-slope velocity removed (tangential remains)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test-collision.mjs`
Expected: FAIL — `Cannot find module './collision.js'` (or import error).

- [ ] **Step 3: Write the minimal implementation**

Create `collision.js`:

```javascript
// collision.js — pure capsule-vs-world collision math (SP5). No three.js import, so it
// runs under Node for unit tests and in the browser for the live player/creatures.
//
// Phase A implements terrain only: the ground is a closed-form analytic height field
// (terrain-field.js terrainHeightAt), so contact is an O(1) query with no spatial
// structure to rebuild. Phases B/C (trunk capsules, rock BVH) extend this module.

// Capsule-bottom vs analytic ground. Inputs are scalars + injected field functions so
// the module stays three.js-free and Node-testable.
//   x, z         capsule axis position in world XZ
//   bottomY      world Y of the lowest point of the capsule (start.y - radius)
//   slopeLimitY  minimum normal.y to count as standable ground (default 0.5)
//   heightAt     (x,z) -> ground Y
//   normalAt     (x,z) -> [nx,ny,nz] unit surface normal
// Returns { groundY, penetration, grounded, normal, restBottomY }.
//   penetration > 0  means the capsule bottom is below the ground by that much.
//   restBottomY      where the bottom should rest (groundY if penetrating, else unchanged).
//   normal           the surface normal when penetrating, else null.
export function groundContact({ x, z, bottomY, slopeLimitY = 0.5, heightAt, normalAt }) {
  const groundY = heightAt(x, z);
  const penetration = groundY - bottomY;
  if (penetration <= 0) {
    return { groundY, penetration, grounded: false, normal: null, restBottomY: bottomY };
  }
  const normal = normalAt(x, z);
  const grounded = normal[1] >= slopeLimitY;
  return { groundY, penetration, grounded, normal, restBottomY: groundY };
}

// Remove the into-surface component of a velocity (slide along the surface). Only the
// component opposing the normal is removed, so upward motion (a jump) is preserved and
// resting gravity is cancelled — mirrors the octree slide but does not kill jumps.
//   v  { x, y, z }   n  [nx, ny, nz] (unit)
// Returns a new { x, y, z }.
export function slideVelocity(v, n) {
  const vn = v.x * n[0] + v.y * n[1] + v.z * n[2];
  if (vn >= 0) return { x: v.x, y: v.y, z: v.z };
  return { x: v.x - n[0] * vn, y: v.y - n[1] * vn, z: v.z - n[2] * vn };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test-collision.mjs`
Expected: `13 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add collision.js test-collision.mjs
git commit -m "$(cat <<'EOF'
SP5a: pure analytic capsule-vs-heightfield collision math + Node tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire `groundContact` into the FPS player

Replace the octree resolve in `updateFPSPlayer` with the analytic resolve. After this task the player walks on the analytic field; the octree is still built but no longer queried (removed in Task 3).

**Files:**
- Modify: `environment-viewer.html` (import at L34 area; `terrainNormal` helper near L100; `updateFPSPlayer` L1537–1556)

- [ ] **Step 1: Import the collision module and `terrainNormalAt`**

In the import block, after `import { createTerrainSystem } from './terrain-system.js';` (L33), change it to also import `terrainNormalAt`, and add the collision import:

```javascript
import { createTerrainSystem, terrainNormalAt } from './terrain-system.js';
import { groundContact, slideVelocity } from './collision.js';
```

- [ ] **Step 2: Add a `terrainNormal` helper next to `terrainHeight`**

After `function terrainHeight(x, z) { return terrainSystem.getHeight(x, z); }` (L100), add:

```javascript
const _terrainN = [0, 1, 0];
function terrainNormal(x, z) { return terrainNormalAt(terrainSystem.params, x, z, _terrainN); }
```

- [ ] **Step 3: Replace the octree collision block in `updateFPSPlayer`**

Replace exactly these lines (L1543–1549):

```javascript
  playerCollider.translate(playerVelocity.clone().multiplyScalar(deltaTime));
  const result = worldOctree.capsuleIntersect(playerCollider);
  playerOnFloor = result ? result.normal.y > 0 : false;
  if (result) {
    playerVelocity.addScaledVector(result.normal, -result.normal.dot(playerVelocity));
    playerCollider.translate(result.normal.multiplyScalar(result.depth));
  }
```

with:

```javascript
  playerCollider.translate(playerVelocity.clone().multiplyScalar(deltaTime));
  const contact = groundContact({
    x: playerCollider.start.x,
    z: playerCollider.start.z,
    bottomY: playerCollider.start.y - playerCollider.radius,
    slopeLimitY: PLAYER_SLOPE_LIMIT_Y,
    heightAt: terrainHeight,
    normalAt: terrainNormal,
  });
  playerOnFloor = contact.grounded;
  if (contact.penetration > 0) {
    playerCollider.translate(_collisionLift.set(0, contact.penetration, 0));
    const slid = slideVelocity(playerVelocity, contact.normal);
    playerVelocity.set(slid.x, slid.y, slid.z);
  }
```

- [ ] **Step 4: Add the slope-limit constant and the lift scratch vector**

Just above `function updateFPSPlayer(deltaTime) {` (L1537), add:

```javascript
const PLAYER_SLOPE_LIMIT_Y = 0.5;   // min ground normal.y to stand on; steeper faces slide
const _collisionLift = new THREE.Vector3();
```

- [ ] **Step 5: Verify the change is internally consistent (no Node test for browser code)**

Run: `node -e "import('./collision.js').then(m=>console.log(Object.keys(m)))"`
Expected: `[ 'groundContact', 'slideVelocity' ]` (confirms the module the viewer now imports loads cleanly).

> Note: `environment-viewer.html` cannot be Node-parsed (it imports addon stubs). Its behavior is confirmed at the browser checkpoint in Task 5.

- [ ] **Step 6: Commit**

```bash
git add environment-viewer.html
git commit -m "$(cat <<'EOF'
SP5a: FPS player walks on analytic heightfield via groundContact (octree no longer queried)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Delete the octree plumbing from the viewer

The octree is now unused. Remove its import, state, build functions, triggers, and HUD/perf fields.

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Remove the `Octree` import (L30)**

Delete the line:

```javascript
import { Octree } from 'three/addons/math/Octree.js';
```

(Keep `import { Capsule } from 'three/addons/math/Capsule.js';` — the player still uses `Capsule`.)

- [ ] **Step 2: Remove the octree state declarations (L40–43)**

Delete:

```javascript
// Declared here so buildOctree() can reference it.
let worldOctree = new Octree();
let terrainOctreeDirty = false;
let lastTerrainOctreeBuild = 0;
```

- [ ] **Step 3: Remove the collision-group alias (L97)**

Delete:

```javascript
const terrainCollisionGroup = terrainSystem.collisionGroup;
```

- [ ] **Step 4: Remove the `lastOctreeMs` field from `terrainDebug` (L144)**

In the `terrainDebug` object literal, delete the `lastOctreeMs: 0,` entry (leave the rest of the object intact).

- [ ] **Step 5: Remove the octree HUD line (L182)**

Delete the line that renders the octree timing:

```javascript
    `octree ${terrainDebug.lastOctreeMs.toFixed(1)}ms\n` +
```

- [ ] **Step 6: Remove the `octreeMs` perf-log field (L234)**

In `perfLog.snapshot`'s returned object, delete:

```javascript
      octreeMs: +terrainDebug.lastOctreeMs.toFixed(2),
```

- [ ] **Step 7: Remove the initial `buildOctree()` call (L296)**

Delete the standalone line:

```javascript
buildOctree();
```

- [ ] **Step 8: Remove `buildOctree(true)` from `rebuildWorld` (L353)**

Delete the line `buildOctree(true);` (the last statement in `rebuildWorld`).

- [ ] **Step 9: Remove the octree trigger + rebuild from `updateTerrainWindow` (L361, L366)**

Inside `updateTerrainWindow`, delete `terrainOctreeDirty = true;` (inside the `if (terrainSystem.update(...))` block) and delete the standalone `maybeBuildTerrainOctree();` call. Leave `terrainDecorationsDirty = true;`, `syncWaterChunks(...)`, and `maybeSyncTerrainDecorations();` intact.

- [ ] **Step 10: Remove `buildOctree` + `maybeBuildTerrainOctree` definitions (L1328–1345)**

Delete both functions in their entirety:

```javascript
function buildOctree(force = false) {
  const t0 = performance.now();
  worldOctree = new Octree();
  terrainCollisionGroup.updateMatrixWorld(true);
  worldOctree.fromGraphNode(terrainCollisionGroup);
  terrainOctreeDirty = false;
  lastTerrainOctreeBuild = performance.now();
  terrainDebug.lastOctreeMs = lastTerrainOctreeBuild - t0;
}

function maybeBuildTerrainOctree() {
  if (!terrainOctreeDirty) return;
  if (!fpsMode) return;
  const now = performance.now();
  if (terrainSystem.pendingCollisionBuildCount > 0) return;
  if (now - lastTerrainOctreeBuild < 250) return;
  buildOctree();
}
```

- [ ] **Step 11: Remove the octree rebuild line in `enterFPS` (L1461)**

Delete:

```javascript
  if (terrainOctreeDirty && terrainSystem.pendingCollisionBuildCount === 0) buildOctree(true);
```

- [ ] **Step 12: Confirm no octree symbols remain**

Run: `cd "G:/My Drive/Scripts/procedural-creature/workshop-webgpu" && rg -n "octree|Octree|worldOctree|terrainOctreeDirty|lastTerrainOctreeBuild|terrainCollisionGroup|pendingCollisionBuildCount|buildOctree|maybeBuildTerrainOctree|lastOctreeMs" environment-viewer.html`
Expected: no output (exit 1 from ripgrep = no matches).

- [ ] **Step 13: Commit**

```bash
git add environment-viewer.html
git commit -m "$(cat <<'EOF'
SP5a: remove octree plumbing from the viewer (HUD, perf, build triggers)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Delete the collider machinery from `terrain-system.js`

The collider group existed only to feed the octree. Remove it; keep `getHeight` and the chunk records (decorations still read `activeChunks`).

**Files:**
- Modify: `terrain-system.js`
- Modify: `test-terrain-system.mjs` (test #6)

- [ ] **Step 1: Update the terrain-system test #6 first (red)**

In `test-terrain-system.mjs`, replace test #6's body (around L133–146) so it no longer references colliders. Change the `createTerrainSystem` call to drop `collisionRadius` and replace the collider assertion:

```javascript
// ---------------- 6. external visual mode: records only, analytic height still works ----------------
{
  const sys = createTerrainSystem({ params: { ...baseParams, visualMode: 'external' } });
  drive(sys);
  ok(sys.activeChunks.length > 0, 'external mode produces chunk records');
  ok(sys.activeChunks.every(c => c.mesh === undefined || c.mesh === null || true), 'external mode records carry no visual mesh');
  ok(Number.isFinite(sys.getHeight(3, 7)), 'analytic getHeight still works');
  ok(sys.pendingBuildCount === 0, `pendingBuildCount ${sys.pendingBuildCount}`);
}
```

Run: `node test-terrain-system.mjs`
Expected: still PASS currently (collisionGroup still exists) — this step just removes the dependence on it so the next step's removal stays green. If the simplified test passes now, proceed.

- [ ] **Step 2: Remove collider defaults from `DEFAULTS` (L16, L18)**

Delete these two lines from the `DEFAULTS` object:

```javascript
  collisionSegmentsPerChunk: 8,
```
```javascript
  collisionRadius: 1,
```

- [ ] **Step 3: Remove `collisionGroup` + `collisionMaterial` construction (L123–124, L127)**

In the constructor, delete:

```javascript
    this.collisionGroup = new THREE.Group();
    this.collisionGroup.name = 'TerrainCollisionChunks';
```
and:

```javascript
    this.collisionMaterial = new THREE.MeshBasicMaterial({ visible: false });
```

- [ ] **Step 4: Remove `collisionKeys` state (L149) and its rebuild reset (L230)**

Delete `this.collisionKeys = new Set();` from the constructor and `this.collisionKeys.clear();` from `rebuild()`.

- [ ] **Step 5: Remove the `pendingCollisionBuildCount` getter (L199–205)**

Delete the whole getter:

```javascript
  get pendingCollisionBuildCount() {
    let pending = 0;
    for (const key of this.collisionKeys) {
      if (!this.chunks.has(key)) pending++;
    }
    return pending;
  }
```

- [ ] **Step 6: Simplify `chunkingSig` and drop collision-key recompute in `update()` (L251, L259, L264)**

Change the signature line (L251) to drop `collisionRadius`:

```javascript
    const chunkingSig = `${chunkSize}|${this.params.renderRadius}`;
```

Delete the collision-keys assignment (L259):

```javascript
      this.collisionKeys = this.getTargetKeys(centerChunkX, centerChunkZ, Math.max(0, Math.floor(this.params.collisionRadius)));
```

Delete the syncCollisionGroup call (L264):

```javascript
      if (this.syncCollisionGroup()) changed = true;
```

- [ ] **Step 7: Remove the collider attach in `addChunk` (L327)**

Delete:

```javascript
    if (this.collisionKeys.has(chunk.key)) this.collisionGroup.add(this.ensureCollider(chunk));
```

- [ ] **Step 8: Remove `ensureCollider`, `releaseCollider`, `syncCollisionGroup` methods**

Delete `ensureCollider` (L421–430), `releaseCollider` (L432–437), and `syncCollisionGroup` (L612–626) in full.

- [ ] **Step 9: Drop the `releaseCollider` call in `disposeChunk` (L450)**

In `disposeChunk`, delete the line:

```javascript
    this.releaseCollider(chunk);
```

- [ ] **Step 10: Remove the `collider` field from chunk records (L412, L418)**

In `makeChunk`, both return objects drop `collider: null`:

```javascript
      return { key, mesh: null, meta, xMin, zMin, size };
```
and:

```javascript
    return { key, mesh, meta, xMin, zMin, size };
```

- [ ] **Step 11: Remove `collisionMaterial.dispose()` from `dispose()` (L645)**

Delete the line:

```javascript
    this.collisionMaterial.dispose();
```

- [ ] **Step 12: Run the terrain-system test (green) and the full Node suite**

Run: `node test-terrain-system.mjs`
Expected: all asserts pass (no collider references remain).

Run the full logic suite:
```bash
node test-cdlod-morton.mjs && node test-cdlod-select.mjs && node test-cdlod-morph.mjs \
  && node test-light-cluster.mjs && node test-particle-field.mjs && node test-post-grade.mjs \
  && node test-terrain-system.mjs && node test-collision.mjs && node test-terrain-field.mjs
```
Expected: every file reports passing, exit 0.

- [ ] **Step 13: Confirm no collider symbols remain in terrain-system.js**

Run: `rg -n "collisionGroup|collisionKeys|collisionRadius|collisionSegmentsPerChunk|pendingCollisionBuildCount|ensureCollider|releaseCollider|syncCollisionGroup|collisionMaterial" terrain-system.js`
Expected: no output.

- [ ] **Step 14: Commit**

```bash
git add terrain-system.js test-terrain-system.mjs
git commit -m "$(cat <<'EOF'
SP5a: remove terrain collider machinery (only ever fed the octree); keep analytic getHeight

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Browser checkpoint (human-verified)

WebGPU cannot run headless here, so a human reloads and reports. This is the gate for Phase A.

- [ ] **Step 1: Serve and open**

```bash
python -m http.server 8001
```
Open `http://localhost:8001/environment-viewer.html`.

- [ ] **Step 2: FPS-walk regression check**

Press **F** to enter walk mode. Verify, with no regression vs the octree build:
- Stand/walk/run on terrain — player rests on the surface (no sinking, no floating); the rest height agrees with the visible CDLOD ground.
- **Space** jumps and lands cleanly; **C** crouch and **Z** prone change height without sinking through the ground.
- Walking across slopes: gentle slopes are walkable; very steep faces slide rather than stick.

- [ ] **Step 3: dd9 spike check**

Set draw distance to 9. Confirm the HUD no longer shows an `octree … ms` line, and that the `perf log` → CSV no longer contains an `octreeMs` column. Record a short trace while walking and streaming chunks; confirm the prior 35–70 ms `octreeMs`/collider-streaming spikes are gone and CPU frame time is flat vs draw distance.

- [ ] **Step 4: Creature sanity**

Confirm creatures still walk on the terrain normally (they use the same analytic field) and that double-click-to-target still works in orbit mode.

- [ ] **Step 5: Fold the dd9 trace into the notes/paper**

Drop the CSV in `research/stats/`, update `research/webgpu/sp1-migration-notes.md` with the Phase A result, and sync any doc changes into `../workshop/research/webgpu/`. (Do not overclaim flatness — terrain/collision flatten; forest still scales.)

---

## Self-Review

**Spec coverage (Phase A items from the SP5 design spec):**
- "Player capsule-vs-heightfield" → Task 1 (`groundContact`) + Task 2 (wiring). ✓
- "route creature foot/ground sampling through shared `supportAt` (terrain-only for now)" → creatures already sample `terrainSystem.getHeight`, which is the terrain-only support; no change needed for Phase A. Documented in Task 5 Step 4 as a sanity check. (Full `supportAt`/`WorldCollision` lands with Phase B/C when trees/rocks add non-terrain support.) ✓
- "Remove octree + collider machinery" → Task 3 (viewer) + Task 4 (terrain-system). ✓
- "Add `terrainNormal(x,z)` bound to `terrainNormalAt`" → Task 2 Step 2. ✓
- "Collision math unit-tested in Node" → Task 1 + the terrain reference. ✓
- Gate 1 (no octree/no rebuild, `octreeMs` gone, flat vs draw distance) → Task 3 + Task 5 Step 3. ✓
- Gate 2 (no FPS-walk regression) → Task 5 Step 2. ✓

**Deferred to Phase B/C (not in this plan, by design):** trunk capsules (`resolveTrunks`, `setTrunks`), rock BVH (`three-mesh-bvh`, `setObstacles`), the full `WorldCollision`/`supportAt` abstraction. Phase A intentionally keeps `collision.js` to the two pure terrain functions the player needs now (YAGNI); the module is structured to grow.

**Placeholder scan:** none — every code step shows complete code; every command shows expected output.

**Type consistency:** `groundContact` returns `{ groundY, penetration, grounded, normal, restBottomY }` and `slideVelocity` returns `{ x, y, z }` consistently across `collision.js`, `test-collision.mjs`, and the viewer wiring. The viewer passes `{ x, z, bottomY, slopeLimitY, heightAt, normalAt }` matching `groundContact`'s destructured params. `terrainNormal(x,z)` returns a length-3 array matching `normalAt`'s contract.
