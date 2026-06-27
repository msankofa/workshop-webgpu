# SP8 Creature Part Instancing - Implementation Plan

**Goal:** Implement creature instancing phases 1-3 from
`docs/superpowers/specs/2026-06-26-sp8-creature-instancing-design.md`.

## Current evidence

Recent traces show six visible creatures add roughly 1100 render draw calls:

| mode | fps median | cpu median | `passCreaturesMs` median | `passPostMs` median | draw calls median |
|---|---:|---:|---:|---:|---:|
| `creatures=on` | 40.3 | 24.08 ms | 0.9 ms | 22.1 ms | 1393 |
| `creatures=off` | 75.0 | 7.63 ms | 0.0 ms | 7.4 ms | 234 |

The first target is draw-call and scene-object reduction, not a simulation worker.

## Task 1 - Map current part types

**Files:**
- Modify: `port-creature-system.js`

- [x] Step 1: Identify each mesh-producing helper and classify it into an instancing bucket.
- [x] Step 2: Identify which current meshes must remain standalone temporarily: debug helpers,
  picking fallback, health bars, team markers, held objects.
- [x] Step 3: Confirm which parts need per-instance color and which can use coarse material buckets.

## Task 2 - Add creature part batcher

**Files:**
- Modify: `port-creature-system.js`

- [x] Step 1: Add a local `createCreaturePartBatches({ scene, capacity })`.
- [x] Step 2: Create canonical geometries:
  - unit box
  - unit sphere
  - unit capsule or cylinder aligned on local Y
  - body shadow proxy box
- [x] Step 3: Create material buckets:
  - shell
  - plate
  - trim
  - light
  - foot
  - joint
  - limb
  - shadow
- [x] Step 4: Implement `beginFrame()`, `add(bucket, matrix, colorOrNull, ownerOrNull)`,
  `endFrame()`, and `dispose()`.
- [x] Step 5: Track per-bucket submitted counts and expose them through creature stats.

## Task 3 - Phase 1: body/detail box instancing

**Files:**
- Modify: `port-creature-system.js`

- [x] Step 1: Preserve existing procedural body part definitions as lightweight render records
  instead of adding every box mesh to the scene.
- [x] Step 2: Submit body/detail boxes to the batcher each frame.
- [x] Step 3: Keep debug/picking behavior functional. If needed, keep one body proxy per creature
  for ray selection during this phase.
- [x] Step 4: Keep old standalone path behind `?creatureInstancing=off`; final phase-3 default is `parts`.
- [ ] Step 5: Record browser trace and compare draw calls.

## Task 4 - Phase 2: limb segment and joint instancing

**Files:**
- Modify: `port-creature-system.js`

- [x] Step 1: Replace leg/arm segment meshes with render records.
- [x] Step 2: Replace leg/arm joint meshes with render records.
- [x] Step 3: Replace feet/hands with render records.
- [x] Step 4: Keep IK/FABRIK state unchanged; only change render output.
- [x] Step 5: Preserve LOD: body-only mode must skip limb submissions.
- [ ] Step 6: Record browser trace and compare draw calls and visual correctness.

## Task 5 - Phase 3: body-only shadow proxy instancing

**Files:**
- Modify: `port-creature-system.js`

- [x] Step 1: Stop casting shadows from individual limb/detail meshes in the instanced path.
- [x] Step 2: Submit one shadow proxy per visible near creature within `Shadow dist`.
- [x] Step 3: Keep a high-quality fallback through `?creatureInstancing=off` for comparison.
- [ ] Step 4: Record browser trace and compare `creatureShadows`, draw calls, and `passPostMs`.

## Task 6 - Verification

- [ ] Step 1: Run syntax checks:

```bash
node --check port-creature-system.js
```

- [ ] Step 2: Extract and syntax-check the viewer module if URL flags or CSV fields change.
- [ ] Step 3: Browser checkpoint:

```text
?post=scene&creatures=on&creatureInstancing=off
?post=scene&creatures=on&creatureInstancing=boxes
?post=scene&creatures=on&creatureInstancing=parts
```

Capture:

- `renderDrawCalls`
- `passPostMs`
- `passCreaturesMs`
- `creatureRenderMs`
- `creatureInstanced*` stats
- visible/rendered/body-only counts

## Stop conditions

- Stop if selection/editor interactions break and cannot be preserved with a simple proxy.
- Stop if the instanced path reduces draw calls but adds more CPU matrix submission cost than it
  removes.
- Do not remove the standalone path until browser traces prove the instanced path is visually and
  behaviorally equivalent enough for the default experience.
