# Scout: Appearance (mesh/IK/render) — LOCATE (inventory)

All in `port-creature-system.js` unless noted.

## IK / FABRIK
- `642-700` KinematicChain — FABRIK, max 12 iterations, tol 0.0001; `652-658` reset(); `660-699` solve() backward/forward passes
- Chain instantiation: per-leg `1485`, per-arm `1537`
- Per-frame solve: legs `3088`, arms `2949` (in renderArms)

## Segment placement & orientation
- `528-535` placeSegment() — midpoint position, scale by length, orient via setFromUnitVectors
- `3090-3095` leg segment loop; `2953-2958` arm segment loop
- `3098-3100` foot orientation from terrainNormal + forward

## Body orientation from feet
- `2710-2742` updateBodyOrientation — accumulate _frontAvg/_backAvg/_leftAvg/_rightAvg → pitch/roll via atan2, lerp preferredRotationLerp, leeway clamp; called `2675` in physicsStep

## Mesh creation (constructor, once)
- `1359-1603` constructor: group, body boxes (1426-1445), legs (1460-1510), arms (1512-1556)
- `1605-1637` _box(); `1685-1704` _cap() (capsule/box geometry); `1706-1720` _joint() (sphere)
- `1639-1683` _mergeRigidBodyParts() (merges shell/plate/trim by material, non-instanced only)

## Material creation
- `1386-1403` per-creature: limbMat/jointMat/footMat (HSL), shellMat/plateMat/trimMat, 2× lightMats emissive, teamMat/healthMat/hitMat
- `703` whiteMat; `704-725` 8 debug materials; `814-821` batch materials

## Geometry caching
- `730` geometryCache Map; `734` sharedGeometry() key lookup; boxGeometry/sphereGeometry/capsuleGeometry accessors

## Per-frame allocations
- `759-776` module-scope reusable temp vectors (steering, orientation, IK, leg targeting, arm pole, instancing) — NO per-frame alloc
- **`3087` per-leg: `group.localToWorld(leg.attachmentLocal.clone())` — allocates a Vector3 clone per leg per frame** (only notable churn)

## Arm pole-vector bias
- `2914-2950` shapeArmJoints() — pole from arm.bendLocal, joints lerp toward preferred + pole*sin(π·t)*bendStrength, terrain-clamped; invoked `2950` in renderArms

## Batched instancing
- `805-907` createCreaturePartBatches() — 8 InstancedMesh buckets, cap 8192; `858` beginFrame() reset; `888` endFrame() set count + needsUpdate
- submit: body `3002`, legs `3041`, arms `3052`; per-frame cycle `4791-4798`

## Main render entry
- `3063-3111` render(): sync pos/rot (death roll), health bar, blink, leg loop (3085-3102: solve IK→placeSegment→joints→foot orient), renderArms (3104), submit body/leg/arm/shadow instances (3105-3108), renderDebug (3110)

**Note:** production render path is largely allocation-free (pooled temps, meshes built once, InstancedMesh batching). Main per-frame costs: FABRIK (≤12 iters × limbs), per-leg localToWorld clone, materials are per-creature (not shared across creatures).
