# SP5 — Hybrid collision: analytic terrain + trunk capsules + BVH obstacles · Design Spec

**Date:** 2026-06-21
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped for review (not yet planned/implemented).
**Sequencing:** numbered after the existing SP4 roadmap box, but **Phase A is recommended
before SP4** — it retires a *measured* bottleneck (the SP3 dd9 traces show the terrain octree
rebuild at 35–70 ms spikes, the heaviest remaining CPU item in both terrain modes).

## Problem

The world has three things to collide against, and the current code handles them poorly or
not at all:

1. **Terrain — wrong tool, and it spikes.** FPS-walk player collision uses
   `three/addons/math/Octree.js`: `worldOctree.fromGraphNode(terrainCollisionGroup)` rebuilds a
   triangle octree over the terrain-collider ring as chunks stream, resolved by
   `capsuleIntersect`. But the ground is a **closed-form analytic height field**
   (`terrainHeightAt` / `terrainSystem.getHeight`) — an O(1) query needing no structure. The
   rebuild causes the **35–70 ms `octreeMs` spikes** measured in SP3, and it collides against
   low-res collider meshes that disagree with the visible CDLOD surface. (Holdover from three's
   FPS example; creatures already use the analytic field.)

2. **Trees — no collision at all.** The octree only ever ingested terrain colliders, so the
   player and creatures currently **walk straight through trunks**. Tree collision is net-new.

3. **Rocks (planned) — can't be represented by a height field.** A height field is
   single-valued in Y; rock meshes placed on the terrain are invisible to it, so a terrain-only
   solution lets everything walk through rocks and provides nothing to stand on.

The octree's only consumer is the player capsule; nothing else reads `worldOctree` or
`terrainCollisionGroup`.

## Goal

A **hybrid collision system** — three primitives behind one shared `supportAt`/`resolveCapsule`
abstraction used by both the player and creatures:

| obstacle | collider | interaction | cost |
|---|---|---|---|
| **terrain** | analytic height field (`terrainHeightAt`) | stand on (support) | O(1), no structure, no rebuild |
| **trees** | per-trunk **vertical capsule** from forest placement data | walk around (lateral push-out) | cheap, chunk-bucketed, no mesh |
| **rocks** / arbitrary static meshes | **BVH** (`three-mesh-bvh`) | stand on **and** walls | one BVH over obstacles, refit on change |

`supportAt(x,z) = max(terrainHeight(x,z), rockTopUnderFoot(x,z))` — trees do **not** contribute
support (you can't stand on a trunk). `resolveCapsule` = terrain rest → trunk push-out → rock
BVH resolve. Retire the octree + the terrain-collider machinery that existed only to feed it.

## Phasing

- **Phase A — analytic terrain ground.** Player capsule-vs-heightfield; route creature
  foot/ground sampling through the shared `supportAt` (terrain-only for now). Remove octree +
  collider machinery. Delivers the dd9-spike win. *No FPS-walk regression.*
- **Phase B — tree-trunk collision.** Derive a vertical-capsule collider per tree from the
  forest's `(position, scale)` placement data (trunk radius ≈ `trees.js radius[0]·scale`),
  bucketed per chunk; lateral push-out for player and creatures. The forest already exists, so
  this is high-value net-new collision (trunks become solid). No BVH, no mesh, no rebuild spike.
- **Phase C — rock / obstacle BVH.** `three-mesh-bvh` over the obstacle meshes; capsule
  push-out (walls) + downward support (stand on top), folded into `supportAt`/`resolveCapsule`.
  Lands when rocks do.

## Collision model

Player is a `Capsule(start=feet, end=head, radius=0.35)`, integrated with gravity in
`updateFPSPlayer`. Each substep, replacing the `capsuleIntersect` block, resolve in order:

**Terrain (analytic, Phase A):**
- `groundY = heightAt(start.x, start.z)`, `n = normalAt(start.x, start.z)` (analytic
  central-difference normal from `terrain-field.js`).
- Capsule bottom is `start.y - radius`; if below `groundY`, lift so the bottom rests on it.
- `grounded = penetrating && n.y >= slopeLimitY` (default ≈ 0.5); too-steep contact slides.
  Slide: `v -= n * min(0, v·n)` (mirrors the octree's slide).

**Trees (trunk capsules, Phase B):**
- Per nearby trunk `(tx, tz, rTrunk)`: if the capsule axis is within `radius + rTrunk` in XZ,
  push the capsule out radially (2D circle-vs-circle MTV in XZ). Lateral only — no support, no
  vertical change (trunks are tall/narrow; you walk around them).
- Only trunks in the player's chunk + 8 neighbors are tested (spatial bucket).

**Rocks (BVH, Phase C):**
- **Support:** short downward `bvh.shapecast`/raycast under the capsule within `radius`; a hit
  above `groundY` becomes the stand-on surface.
- **Walls:** capsule `bvh.shapecast` → minimum-translation push-out (three-mesh-bvh
  character-controller pattern), over obstacle triangles only.

**Shared queries:** `supportAt(x, z, footRadius)` → highest supporting Y + normal (terrain or
rock; trees excluded). The player uses `resolveCapsule`; **creatures** point foot-IK ground
targets at `supportAt` (today they sample `terrainHeight`) and may use trunk push-out or keep
steering-based avoidance for trees.

## Components / files

### `collision.js` (NEW — the shared collision module)
- `groundContact({ x, z, bottomY, radius, slopeLimitY, heightAt, normalAt })` →
  `{ groundY, penetration, grounded, normal, restBottomY }` — pure terrain math (Phase A),
  Node-tested.
- `resolveTrunks(capsule, trunks)` — 2D circle-MTV push-out vs nearby trunk capsules (Phase B),
  pure/Node-testable given a trunk list.
- `WorldCollision` — owns the trunk buckets + obstacle BVH: `setTrunks(chunkKey, trunks)` /
  `clearTrunks(chunkKey)` (Phase B, fed from forest baking), `setObstacles(meshes)` (Phase C,
  build/refit one BVH), `supportAt(x,z,r)`, `resolveCapsule(capsule, velocity)`. Injected with
  `heightAt`/`normalAt`.

### `environment-viewer.html` (MODIFY)
- `updateFPSPlayer`: replace `worldOctree.capsuleIntersect(...)` (~L1447–1451) with
  `WorldCollision.resolveCapsule(...)`.
- Remove `worldOctree`, `buildOctree`, `maybeBuildTerrainOctree`, `terrainOctreeDirty`, the
  `Octree` import, and `octreeMs` HUD/perf fields. Add `terrainNormal(x,z)` bound to
  `terrainNormalAt`.
- Phase B: when a tree chunk is baked (`createTreeBuildJob`/placement step), register its
  trunks (`{x, z, rTrunk}` from placement `(pos, scale)`) via `setTrunks(chunkKey, …)`;
  `clearTrunks` on unload. Phase C: register rock meshes via `setObstacles`.

### `terrain-system.js` (MODIFY — cleanup once the octree is gone)
Remove the collider machinery that existed only to feed the octree: `collisionGroup`,
`ensureCollider`, `releaseCollider`, `collisionKeys`, `collisionRadius`,
`collisionSegmentsPerChunk`, `syncCollisionGroup`, `pendingCollisionBuildCount`. `getHeight`
stays. Removes the last per-chunk geometry build from the SP3 `external` path.

### Creature integration
Route creature foot/ground sampling through `WorldCollision.supportAt` (a swap from
`terrainHeight`), so feet land on rock tops. Trunk avoidance via `resolveTrunks` or steering.
The standalone `creature-viewer.html` (Codex's in-flight work) can adopt `collision.js` later.

### Dependency
`three-mesh-bvh` added to the importmap as a CDN ESM URL **pinned to match three r0.184** (the
`computeBoundsTree` prototype extension is version-sensitive). Only needed for Phase C.

## Gate (success criteria)

1. **No octree / no rebuild** (A): octree + collider machinery removed; `octreeMs` gone;
   collision cost **flat vs draw distance** (dd9 trace, prior spikes gone).
2. **No FPS-walk regression** (A): stand/walk/run/jump/crouch/prone behave as before; player
   rests exactly on the analytic ground (agrees with the visible CDLOD surface).
3. **Trunks are solid** (B): player and creatures can no longer walk through tree trunks;
   trunk registration streams with chunks with no rebuild spike.
4. **Rocks are solid** (C): player and creatures stand on top of rocks and cannot walk through
   them; the obstacle BVH builds once / refits on change, never per-frame.
5. **Collision math unit-tested** in Node (`groundContact`, `resolveTrunks`, the terrain/rock
   `supportAt` combine), reusing the field reference as SP2/SP3 did.

## Testing

- **Node (`test-collision.mjs`)**, reusing `grass-height-ref.js` for `heightAt`:
  - terrain: above ground → no penetration; penetrating flat → `restBottomY == groundY`,
    grounded, into-surface velocity removed; moderate slope → normal matches `terrainNormalAt`,
    slides; too-steep → not grounded.
  - trunks: capsule overlapping a trunk circle → pushed out to exactly `radius + rTrunk` in XZ,
    no vertical change; outside range → untouched; nearest-of-several resolves without tunneling.
  - `supportAt` combine: obstacle hit above terrain → obstacle Y; below → terrain Y.
- **Browser checkpoint:** walk/jump/crouch/prone on CDLOD terrain (no sink/float, slopes slide);
  walk into trees → blocked, walk around; (Phase C) place a rock → player + a creature stand on
  it and are blocked by its side; HUD shows `octreeMs` gone, no collider-streaming `cpuMs`
  spikes. **dd9:** confirm spikes gone.

## Out of scope
- Full rigid-body **physics** (stacking/pushing). If wanted later, a WASM engine (Rapier/Jolt)
  is a separate SP. This SP is static-obstacle + heightfield contact.
- **Canopy/branch collision** — only trunks collide; you don't bump your head on leaves.
- A **height-overlay** alternative for moundlike rocks (no overhangs/walls): cheaper, stays
  analytic, but can't represent rock geometry you walk around — rejected in favor of the BVH so
  arbitrary rock meshes work.
