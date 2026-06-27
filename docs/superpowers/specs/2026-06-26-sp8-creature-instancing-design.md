# SP8 - Creature Part Instancing - Design Spec

**Date:** 2026-06-26  
**Branch:** `sp1-webgpu-renderer-migration` (`workshop-webgpu/`)  
**Status:** scoped.

## Problem

The creature stats show the creature frame drop is mostly render-side scene complexity, not raw
creature simulation:

| mode | fps median | cpu median | `passCreaturesMs` median | `passPostMs` median | draw calls median |
|---|---:|---:|---:|---:|---:|
| `creatures=on` | 40.3 | 24.08 ms | 0.9 ms | 22.1 ms | 1393 |
| `creatures=off` | 75.0 | 7.63 ms | 0.0 ms | 7.4 ms | 234 |

Six visible creatures add roughly 1100 draw calls. Moving simulation to a worker would only attack
about 1-2 ms of CPU work. The larger wall is the many independent `THREE.Mesh` parts: body boxes,
plates, lights, leg capsules, joints, feet, arm capsules, hands, health bars, markers, and shadow
casters.

## Goal

Reduce creature draw calls while preserving procedural variation.

The first instancing target is not a skinned-character rewrite. It is a renderer-side batching layer
for repeated primitive part types:

- body/shell/plate/trim boxes
- foot/hand boxes
- leg/arm segment capsules or cylinders
- joint spheres
- head/sensor/eye boxes
- optional simple health/team markers

Each part can still vary per creature by transform, non-uniform scale, color, emissive color, and
visibility. Instancing requires shared geometry and material, not identical world transforms.

## Key Answer: Can Instanced Parts Vary Size?

Yes. A `THREE.InstancedMesh` stores a matrix per instance. That matrix carries translation,
rotation, and scale, including non-uniform scale. A single unit box can become a wide body plate, a
thin trim strip, a foot, or a sensor if the material bucket matches. Instance attributes can also
carry per-instance color and other shader data.

The real constraint is batching:

- Same geometry layout.
- Same material/shader program.
- Different transform/scale/color is fine.
- Different material class or texture usually means a different instance batch.

For this project, procedural variation is compatible with instancing if we move from "unique
geometry per exact size" to "canonical primitive geometry plus per-instance matrix".

## Architecture

### Current Shape

`port-creature-system.js` creates many separate meshes:

- `_box(...)` creates per-part body/details.
- `_cap(...)` creates limb segment meshes.
- `_joint(...)` creates joint spheres.
- feet/hands are separate box meshes added to the scene.
- each creature owns materials derived from hue/style.
- LOD currently toggles `.visible` / `.castShadow` on those individual meshes.

This is flexible, but every visible part is a draw participant.

### Proposed Shape

Add a creature render batching layer:

```js
const creatureBatches = createCreaturePartBatches({ scene, capacity });

creatureBatches.beginFrame();
creature.submitRenderParts(creatureBatches, lodState);
creatureBatches.endFrame();
```

`submitRenderParts` replaces most direct mesh transform writes with instance writes:

```js
batches.box.add({
  matrix,
  color,
  emissive,
  bucket: 'shell'
});

batches.segment.add({
  matrix,
  color,
  bucket: 'limb'
});
```

The batch layer owns the `InstancedMesh` objects and updates `count`, matrices, and instance colors
each frame.

### Buckets

Start with conservative material buckets:

| bucket | canonical geometry | material |
|---|---|---|
| `shellBox` | unit box | standard rough shell material with instance color |
| `plateBox` | unit box | standard plate material with instance color |
| `trimBox` | unit box | standard trim material with instance color |
| `lightBox` | unit box | emissive material, instance emissive/color |
| `footBox` | unit box | standard dark foot material with instance color |
| `jointSphere` | unit sphere | standard joint material with instance color |
| `limbSegment` | unit capsule or cylinder | standard limb material with instance color |

Use one `InstancedMesh` per bucket. If WebGPU material/node constraints make instance color awkward
for a bucket, temporarily split by coarse palette color. Do not split by exact part size.

### Geometry Policy

Use canonical primitives:

- `unitBox`: dimensions `1,1,1`, scaled by matrix.
- `unitSphere`: radius `1`, scaled uniformly or mildly non-uniformly.
- `unitCapsule` or `unitCylinder`: aligned on local Y, transformed to connect endpoints.

Current capsule geometry is generated from exact `radius,length`. That defeats instancing. For
batched limbs, replace exact capsule geometry with a canonical limb primitive:

- **Phase 1 option:** cylinder-only limb segments. Fast and clean, slightly less rounded.
- **Phase 2 option:** unit capsule scaled by radius/length. Non-uniform scaling stretches caps but
  is usually acceptable at this visual scale.
- **Phase 3 option:** shader/TSL capsule impostor or skinned/merged limb mesh if visual quality
  demands it.

### Transform Submission

For every current part placement:

- body boxes: `matrix = compose(creatureGroupWorld * localPartTransform * scale)`
- leg/arm segments: use the same `placeSegment` math, but write a matrix instead of mutating a mesh.
- joints: sphere at joint point with scale radius.
- feet/hands: box matrix at current foot/hand pose.

The existing procedural state remains the source of truth:

- body pose
- leg chain points
- arm chain points
- foot/hand positions
- LOD state
- combat/debug state

Instancing changes only the render representation.

### LOD Integration

Use the new creature performance controls as the front door:

- Full detail: submit body + legs + arms + joints + feet/hands.
- Body-only: submit body/head/detail boxes, skip legs/arms/joints/feet.
- Far: submit one simplified body box or none.
- Shadow LOD: either no shadows, body-only shadow batch, or near full-part shadows.

Do not make instancing remove the LOD sliders. Instancing reduces baseline draw calls; sliders
remain quality/performance tuning.

### Shadow Strategy

Shadow cost can erase instancing gains if every part still casts separately.

Recommended order:

1. Near creatures: body-only shadow proxy.
2. Optional high-quality near mode: full part shadows.
3. Mid/far: no shadow or blob/capsule shadow.

For Phase 1, keep a separate `shadowBodyBox` instanced batch and stop casting shadows from every
leg segment. This matches the stats: render cost is the wall, and shadows multiply draw work.

### Picking / Selection

Instanced meshes complicate ray picking because the hit gives `instanceId`, not a direct part mesh.

Batch layer must keep:

```js
instanceOwner[batchName][instanceId] = creature;
instancePart[batchName][instanceId] = { type, legIndex, segmentIndex };
```

Selection can map `instanceId` back to the creature. If this becomes fragile, keep invisible/simple
per-creature picking proxies temporarily:

- one bounding box per creature,
- or raycast against creature body proxy only.

### Debug Rendering

Do not batch debug helpers in Phase 1. Debug mode is an editor path and should stay simple.

When debug is enabled:

- either keep old per-part meshes for selected creature only,
- or render debug markers separately as today.

Normal non-debug creatures should use the batch path.

## Phased Plan

### Phase 0 - Measurement Gate

Record a baseline with current sliders:

- `?post=scene&creatures=on`
- `?post=scene&creatures=off`
- one tuned-Lod run using the new sliders

Capture:

- `renderDrawCalls`
- `passPostMs`
- `passCreaturesMs`
- `creatureRenderMs`
- `creatureShadows`
- visible/rendered/body-only counts

### Phase 1 - Body/Detail Box Instancing

Batch only body/head/detail boxes first. Leave animated limbs as current meshes.

Why first:

- lowest correctness risk,
- large number of box details per creature,
- proves material/instance color path,
- picking can still use remaining creature meshes if needed.

Expected win: fewer body/detail draw calls and lower scene traversal/render cost.

### Phase 2 - Limb Segment and Joint Instancing

Batch:

- leg segment primitives,
- arm segment primitives,
- joints,
- feet/hands.

This is the main draw-call win. Existing IK/FABRIK math still runs; only output changes from
`mesh.position/quaternion/scale` to batch instance matrices.

### Phase 3 - Shadow Proxy Instancing

Replace per-part shadows with:

- one instanced body shadow proxy per near creature, or
- one simplified capsule/box aggregate per creature.

Full part shadows can remain as an explicit high-quality option, not default.

### Phase 4 - Optional Skinned Mesh / Merge

Only consider this if instancing still leaves too much cost.

Skinned meshes are the modern game default for authored characters, but this project has procedural
leg counts, segment counts, and model variation. A full skeleton path is a bigger architectural
change than primitive-part instancing.

## Success Criteria

For six visible creatures on the known bad camera path:

- reduce `renderDrawCalls` by at least 50% versus current creature-on baseline,
- reduce `passPostMs` materially while `passCreaturesMs` does not rise by more than 1 ms,
- preserve visible creature variation and animation,
- selection still returns the correct creature,
- `creatureDetail/body-only/hide/animation/IK/shadow` sliders still work.

## Risks

- Instance colors/material support may differ between WebGPU node materials and standard materials.
  If blocked, split into coarse material buckets first.
- Per-instance updates every frame still cost CPU, but matrix writes are cheaper than maintaining
  hundreds of scene objects and draw calls.
- Ray picking needs owner lookup by `instanceId`.
- Non-uniformly scaled capsules may look different from exact capsule geometries.
- Debug/editor mode should not dictate the fast path; keep debug separate.

## Non-Goals

- Moving creature simulation to a worker.
- Rewriting creatures as GPU simulation.
- Full skinned mesh/skeleton refactor in Phase 1.
- Removing procedural variation.
- Hard-capping quality for faster machines.
