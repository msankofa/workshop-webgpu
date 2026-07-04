# Creature Appearance Rendering Pipeline Trace

## Render Call Chain (Per Creature Per Frame)

### Entry Point: `Creature.render(showDebug, dt, animateParts)`

Located at **line 3063** in `port-creature-system.js`

1. **Update World State** (always)
   - `creature.group.position.copy(this.pos)`
   - `creature.group.rotation.set(pitch, yaw, roll)`
   - `creature.group.updateMatrixWorld(true)`
   - Update health bar color, scale, and visibility
   - Update eye/light blinker materials based on time

2. **Animate Leg IK** (conditional: `animateParts && lodTier < LOD_BODY_ONLY_TIER`)
   ```
   FOR each leg in creature.legs (quadbot: 4, hexbot: 6, octobot: 8):
       hipWorld = creature.group.localToWorld(leg.attachmentLocal.clone())
       points = leg.chain.solve(hipWorld, leg.end, orientation)
       
       FOR each segment in leg.segments (typically 3):
           placeSegment(segment, points[i], points[i+1])
           joint[i].position = points[i+1]
       
       leg.foot.position = leg.end
       leg.foot.quaternion = orientFromUpForward(terrain_normal, forward_dir)
   ```

3. **Animate Arms** (conditional: `animateParts && lodArmsActive`)
   ```
   Call renderArms(orientation, dt) ->
       FOR each arm in creature.arms (front plan: 2, tentacle: 2-8):
           shoulderWorld = creature.group.localToWorld(arm.attachmentLocal.clone())
           
           // Primary IK solve
           points = arm.chain.solve(shoulderWorld, target, orientation)
           shapeArmJoints(arm, points, shoulderWorld, handPoint, orientation)
           
           FOR each segment in arm.segments (typically 3-4):
               placeSegment(segment, points[i], points[i+1])
               joint[i].position = points[i+1]
           
           arm.hand.position = points[last]
           
           // Special case: recovery solve if holding object
           IF arm.holding AND state=='carry' AND settling:
               recoverPoints = arm.chain.solve(shoulderWorld, arm.target, orientation)
               shapeArmJoints(arm, recoverPoints, ...)
               [repeat segment/joint updates]
   ```

4. **Submit Instanced Parts** (if `creatureBatches` enabled)
   - `submitBodyInstances()` - body meshes to batch
   - `submitLegInstances()` - leg segments, joints, feet to batch
   - `submitArmInstances()` - arm segments, joints, hands to batch
   - `submitShadowProxy()` - shadow casting volume

5. **Debug Visualization** (if `showDebug` enabled)
   - Rebuild line/segment geometries for debug overlays
   - Update marker positions for legs, arms, scan zones
   - **Note:** Creates temporary arrays per-frame (production impact only with debug on)

---

## Operations Reference Table

Per-frame occurrence counts based on **hexbot (6 legs, 3 segments each) + 2-arm front setup**

| Operation | Scope | Approx Count | Allocates? | Details |
|-----------|-------|--------------|-----------|---------|
| **KinematicChain.solve()** | per-leg | 6 | No | FABRIK IK solver, up to 12 iterations, early-exit on tolerance |
| **KinematicChain.solve() (arm)** | per-arm | 2-4 | No | Standard: 1x per arm; 1x recovery if holding object |
| **FABRIK iteration** | per-IK-iteration | 12 max per limb | No | Backward pass + forward pass; reuses single `_fabrikDir` Vector3 |
| **placeSegment()** | per-leg-segment | 18 (6 legs × 3 segs) | No | Updates position, scale, quaternion of pre-existing segment mesh |
| **placeSegment() (arm)** | per-arm-segment | 6-8 (2-4 arms × 3-4 segs) | No | Same as leg segments |
| **Joint position update** | per-joint | 10-12 total | No | `joint.position.copy(points[i])` on pre-allocated joint sphere |
| **Foot/hand position** | per-limb-end | 8-10 | No | Updates leg foot and arm hand positions |
| **localToWorld()** | per-limb | 8-10 | Yes (clone) | Shoulder/hip attachment point; uses `leg.attachmentLocal.clone()` |
| **Matrix composition** | per-instanced-part | 30-40+ | No | Reuses `_instMatrix`, `_instLocal` pre-allocated Matrix4 |
| **Color/material updates** | per-creature | 1 | No | Health bar color, blink state; reuses material references |
| **Group matrix update** | per-creature | 1 | No | `group.updateMatrixWorld(true)` cascade |
| **shapeArmJoints()** | per-arm | 2-4 | No | In-place bend control; reuses `_armAxis`, `_armPole`, `_armPreferred` |
| **Temp Vector3 reuse** | per-creature | 200-300 ops | No | Pre-allocated module-level vectors: `_mid`, `_seg`, `_n`, `_q`, `_fwd`, etc. |
| **Temp Matrix4 reuse** | per-creature | 30-50 ops | No | `_instMatrix`, `_instLocal`, `_basis` composed/reused |
| **Geometry.setFromPoints()** | per-debug-call | 1 | Yes | Debug visualization only; creates new BufferGeometry |
| **Temporary array creation** | debug-only | 5 per frame | Yes | `scanPoints`, `zonePoints`, `linkPoints` arrays for debug |

---

## Material & Mesh Allocation Scope

| Category | Allocation Point | Reuse Pattern |
|----------|-----------------|---------------|
| **Creature materials** | Constructor | Per-creature singleton; never recreated |
| **Limb segment meshes** | Constructor | Per-segment; transform updates only |
| **Joint/foot meshes** | Constructor | Per-joint/foot; position updates only |
| **Body part meshes** | Constructor | Merged per-material or instanced; never recreated |
| **Pre-temp vectors** | Module level | Pooled; ~30 Vector3/Matrix4/Quaternion objects |
| **Shared geometries** | Module level cache | Geometry cache by type+dimensions; reused across creatures |

---

## Key Numbers (Typical Hexbot with 2 Arms)

- **Limbs per creature:** 6 legs + 2 arms = 8 kinematic chains
- **Segments per leg:** 3 (typical)
- **Segments per arm:** 3 (front plan)
- **FABRIK iterations max per limb:** 12
- **placeSegment() calls per frame:** 24 (18 legs + 6 arms)
- **chain.solve() calls per frame:** 8-10 (6 legs + 2 arms + up to 2 recovery)
- **Materials per creature:** 8-10 (limbMat, jointMat, footMat, shellMat, plateMat, trimMat, 2x lightMat)
- **Meshes (non-instanced):** ~30-50 per creature (body parts + legs + arms + feet/hands)
- **Temp objects reused:** ~30 pre-allocated Vector3/Matrix4/Quaternion

---

## Memory Allocation Summary

**Per-frame dynamic allocations (production mode):**
- `leg.attachmentLocal.clone()`: ~6-8 Vector3 clones per frame (one per leg/arm for localToWorld)
- Debug arrays: 0 allocations (unless debug enabled)

**No per-frame allocations for:**
- Segment/joint position updates (reuse pre-created meshes)
- IK solve iterations (reuse temp vectors `_fabrikDir`, `_mid`, `_seg`)
- Matrix transformations (reuse `_instMatrix`, `_instLocal`)
- Geometry/material recreation (all created once at startup)

**Total typical per-creature overhead:** ~6-8 Vector3 clones/frame + negligible object churn

