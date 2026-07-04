# Appearance / Mesh / IK / Render — Performance Analysis

Domain: `port-creature-system.js`, the visual/mesh/IK rendering pipeline (per-frame `Creature.render()` call chain: leg IK loop → `renderArms()` → `submitBodyInstances/submitLegInstances/submitArmInstances/submitShadowProxy` → `renderDebug`). Built on the scouts' `appr-locate.md` / `appr-trace.md`; every anchor below was re-read from source to verify.

**Headline correction to the scouts' claim:** the leg path (`render()` lines 3085–3102) is genuinely allocation-free apart from one `Vector3.clone()` per leg. The **arm path is not** — `renderArms()` and its helpers (`updateArmState`, `armRestTarget`, `constrainArmTarget`, `constrainArmPoint`, `chooseArmObject`) allocate a `Vector3` on nearly every internal `localToWorld`/`worldToLocal` call, and those run unconditionally every frame per arm. This is the single biggest gap between the scouts' inventory and what the code actually does.

---

## 1. FABRIK solve — `KinematicChain.solve()` — `port-creature-system.js:660-699`

What it does: backward+forward IK pass, up to `maxIterations = 12` (line 648), tolerance `0.0001` (line 649), reusing one scratch `_fabrikDir` (line 763).

Cost: O(iterations × chain length) per limb per frame; chain length is 3-4 for legs, 3-5 for arms. Two full point-array passes per iteration (lines 684-687 backward, 690-693 forward), each doing a `subVectors` + `normalize` + `addScaledVector` per joint — cheap vector math, no allocation (confirmed: `_fabrikDir` is the only vector used inside the loop).

Why it looks inefficient but mostly isn't: `this.points` persists across frames (`reset()` only triggers if the array length changed, line 661), so each `solve()` call is warm-started from last frame's pose. Target motion between frames is small (sub-frame creature movement), so in practice the tolerance check (line 695, squared-distance early exit) usually breaks out well before 12 iterations. The full-extension fast path (lines 667-673) also short-circuits the common "leg near max reach" case in O(n) with no iteration at all. **12/0.0001 is a safety cap, not a routinely-hit cost** — this is not the inefficiency the task hypothesized it might be.

Severity: **Low.** The cap itself is fine; the real cost is that it runs per-limb-per-frame at all (see LOD note at the end) and that arms re-seed the cache with a cosmetically bent pose every frame (see finding 6), which can cost an extra iteration or two versus legs.

---

## 2. `placeSegment()` — `port-creature-system.js:528-535`

What it does: sets a limb-segment mesh's position (midpoint), non-uniform scale (`len / mesh.userData.base`), and orientation via `quaternion.setFromUnitVectors(_upAxis, _seg.normalize())`.

Cost: one `setFromUnitVectors` (quaternion-from-two-vectors, a handful of dot/cross/sqrt ops) per segment per frame. Called 18-24×/creature/frame (legs: `segments.length` per leg × leg count, e.g. 6×3=18 for a hexbot; arms: 2951-2958, 3-4 segments × 2-4 arms). Fully allocation-free (`_mid`/`_seg` are module-scope scratch vectors, line 527).

Why it's this way: this is the fundamental cost of stretch-to-fit bone rendering without a real skeleton/skinning system — there's no cheaper way to reorient a discrete mesh per bone every frame short of GPU-side skinning. Not wasteful for what it does.

Severity: **Low.** Inherent cost of the chosen rendering technique (rigid per-segment meshes instead of a skinned skeleton), not a bug.

---

## 3. Per-leg `localToWorld(clone())` — `port-creature-system.js:3087`

```js
const hipWorld = this.group.localToWorld(leg.attachmentLocal.clone());
```

What it does: computes the hip's current world position by cloning the cached local attachment point and transforming it.

Cost: one `Vector3` allocation per leg per frame (6-8 for hex/octobot). Confirmed the scouts' finding — this is real churn, but it is the **only** allocation in the leg loop.

Why it's inefficient: `attachmentLocal` never changes after construction and `this.group.matrixWorld` is already up to date (line 3068, `updateMatrixWorld(true)` runs once at the top of `render()`). The clone exists only because `localToWorld` mutates its argument in place; a pooled per-leg scratch vector (there's already a `_legRestGround`/`_legMoveDir`/`_legLookAhead` scratch trio at line 765 that could be extended, or a per-leg persistent `hipWorld` field like the arm's `attachmentLocal` clone already stored at construction, line 1481) would make this fully static-alloc.

Severity: **Medium.** Small per-object cost but it's an easy, total fix (store `hipWorld` as a persistent per-leg `Vector3` field, reuse it via `.copy()` instead of `.clone()`).

---

## 4. Arm target/constraint pipeline allocates a `Vector3` almost every call — `port-creature-system.js:2751, 2787, 2802, 2937` (+ conditionally `2767`, `2832`, `2835`, `2840`, `2904`)

This is the main correction to the scouts' "largely allocation-free" conclusion. `renderArms()` (2934-3000) is called once per arm per frame whenever `lodArmsActive`, and its call chain allocates repeatedly:

- **2937** `shoulderWorld = this.group.localToWorld(arm.attachmentLocal.clone())` — 1 clone, **every arm, every frame** (same pattern/cost as the leg hip clone, but the scouts' inventory only listed the leg one).
- **2938** calls `updateArmState()`, which for the default/idle/recover states (the common case) calls **`armRestTarget()` (2751)**: `this.group.localToWorld(arm.restLocal.clone())` — another clone, every frame while idle or recovering (idle is the arm's rest state most of the time).
  - In the `carry` state instead: **2904** `this.group.localToWorld(arm.carryLocal.clone())` — same cost, different branch.
  - In the combat/punch branch (2826-2851): **2832, 2835** each allocate a `Vector3` (`punchTarget.clone().sub(...)`, `shoulderWorld.clone().addScaledVector(...)`), and during windup **2840** allocates *two* (`arm.restLocal.clone().add(new THREE.Vector3(...))`) — only while `punchArm === arm` and mid-attack, but that's every frame of every windup/strike.
  - Every branch of `updateArmState` funnels to **`constrainArmTarget()` (2785-2798)**, which does `this.group.worldToLocal(target.clone())` at **2787** — 1 more clone, **unconditionally, every arm, every frame**.
- Back in `renderArms`, after the FABRIK solve, line **2951** loops `for (let i = 1; i < points.length; i++) this.constrainArmPoint(arm, points[i])` — and **`constrainArmPoint()` (2800-2820)** does `this.group.worldToLocal(point.clone())` at **2802** for *every interior/end joint of the chain*, i.e. 2-4 more clones per arm, **unconditionally, every frame**.
- **2767** (`chooseArmObject`, inside the idle-arm object-search): `this.group.worldToLocal(object.position.clone())` per *candidate* grabbable in range — gated by `arm.acquireCooldown` (reset to 0.75s at line 1792), so this is periodic rather than per-frame, but when it fires it allocates once per nearby candidate in a tight loop.

Net guaranteed-per-frame cost per arm (idle/typical case, ignoring combat): **shoulder (1) + rest/carry target (1) + constrainArmTarget (1) + constrainArmPoint × (chain length − 1) (2-4) ≈ 5-7 `Vector3` allocations per arm per frame**, before any combat or object-interaction extras. For a 2-arm creature that's 10-14 short-lived allocations/frame; for tentacle-plan creatures with up to 8 arms (per the trace doc), 40-56/frame — purely from this one pipeline, times however many creatures have `lodArmsActive`.

Why it's inefficient: every one of these is `X.clone()` fed straight into `localToWorld`/`worldToLocal`, which mutate their argument and return it — the clone is only needed because the source vector (`attachmentLocal`, `restLocal`, `carryLocal`, the FABRIK output point) must not itself be mutated. All of these have a natural persistent home (a per-arm scratch field, analogous to the leg's `hipWorld` fix above) that would let the code do `_armScratch.copy(source)` into a reusable buffer instead of allocating. The module already has this pattern for leg scanning (`_legRestGround`, `_legMoveDir`, `_legLookAhead`) and generic use (`_armAxis`, `_armPole`, `_armPreferred`, lines 759-773) — the arm target/constrain code simply doesn't use it, unlike `shapeArmJoints()` which does use scratch vectors correctly (finding 6).

Severity: **High.** This is the largest allocation source in the entire appearance pipeline, it runs unconditionally on the hot path (not debug-gated), and it scales with arm count × creature count × frame rate. It directly contradicts the "production path is allocation-free" assumption for anything with arms.

---

## 5. Per-creature materials not shared, and largely unused when instancing is on — `port-creature-system.js:1386-1403`

What it does: constructs 9 `MeshStandardMaterial`s per creature (`skin`, `limbMat`, `jointMat`, `footMat`, `shellMat`, `plateMat`, `trimMat`, `lightMats[0..1]`) plus 4 `MeshBasicMaterial`s (`teamMat`, `healthBackMat`, `healthMat`, `hitMat`) — 13 materials per creature, all with unique HSL-derived or style-derived colors (line 1386 `new THREE.Color().setHSL(hue, ...)`).

Cost: 13 `Material` object constructions (each carrying its own UUID, event dispatcher, full default property set) at every creature spawn. With `CREATURE_INSTANCING_MODE` defaulting to `'parts'` (line 4 `?? 'parts'`) and `creatureBatches` therefore non-null, `_box()` (1605-1637), `_cap()` (1685-1704), and `_joint()` (1706-1720) all take the `instancedParts` branch: they build a bare `Object3D` and store the material only in `userData.material`/for bucket selection — **the material is never attached to an actual renderable `Mesh`**. It is read back out exactly once per frame via `materialColor(part.material)` → `part.material.color` (lines 3006, 3019, 3026, 3038) to feed `InstancedMesh.setColorAt`. So 9 of the 13 materials exist purely as boxed `THREE.Color` containers.

Why it's inefficient: creating a full `MeshStandardMaterial` (or `MeshBasicMaterial`) to carry nothing but a `.color` is unnecessary overhead — a plain `THREE.Color` (or even a hex number) would serve identically for `materialColor()`'s purpose in instanced mode, at a fraction of the construction cost and memory footprint. This doesn't cost anything per-frame (materials with no attached mesh never enter a draw call, so no extra shader/program state), but it is wasted work at every creature spawn, and it means a large batch-spawn (e.g. two full teams at once) does more allocation than necessary. The 4 materials genuinely used (`teamMat`, `healthBackMat`, `healthMat`, `hitMat` — bound directly to `teamMarker`/`healthBack`/`healthBar`/`hitFlashMesh` meshes, lines 1412-1424, which are deliberately per-creature UI elements, not batched) are legitimate and fine as-is.

Note: in the non-default `CREATURE_INSTANCING_MODE === 'off'` fallback, all 9 body/limb materials *are* bound to real per-segment `Mesh` objects added directly to `scene`/`group` (the non-`instancedParts` branches of `_box`/`_cap`/`_joint`), each with its own unique material — meaning zero batching and one draw call per segment per creature in that mode. That mode exists (URL-param gated) but isn't the production default.

Severity: **Medium** (spawn-time cost only, not per-frame; matters for spawn hitches with many creatures, not steady-state framerate).

---

## 6. `shapeArmJoints()` — `port-creature-system.js:2914-2932`

What it does: computes a pole vector from `arm.bendLocal` (rotated by the creature's orientation), then for each interior joint lerps it 38% toward a preferred bent position (`shoulderWorld`→`handPoint` lerp + pole offset scaled by `sin(π·t)`), clamped above terrain height per joint (line 2929, one `terrainHeight()` call per interior joint).

Cost: correctly allocation-free — reuses `_armAxis`/`_armPole`/`_armPreferred` (module scratch, line 766). Trig cost is one `sin()` per interior joint per arm per frame (2-3 typically) — negligible.

Side effect worth flagging: `points[i].lerp(_armPreferred, 0.38)` (line 2930) **mutates the `KinematicChain`'s own cached `this.points` array in place**. Since `solve()` warm-starts from `this.points` next frame (no reset unless array length changes, line 661), the arm chain's cache is seeded every frame with a cosmetically bent pose rather than the raw FABRIK solution — unlike legs, whose points are never post-processed. The end-effector tolerance check is unaffected (bending only touches interior joints), but the backward pass's initial direction estimate (line 685) is computed from this bent state, so arm chains may need marginally more iterations to reconverge than legs do, frame over frame.

Severity: **Low.** Correct use of scratch vectors, cheap trig; the self-seeding-with-bent-pose behavior is a minor, likely-negligible side effect rather than a real cost.

---

## 7. Redundant per-frame terrain sampling in the arm/foot pipeline — `port-creature-system.js:3098, 2929, 2801, 2786, 2752`

What it does: `terrainHeight()`/`terrainNormal()` (defined at lines 18-25, imported from the terrain subsystem) are queried repeatedly within a single creature's single-frame render pass:
- Foot orientation (leg loop, line 3098): `terrainNormal(leg.end.x, leg.end.z, _n)` does **4** `terrainHeight()` calls (central-difference normal, lines 20-23) per leg, every frame, unconditionally whenever `lodTier < LOD_BODY_ONLY_TIER` — including while the foot is planted and stationary (i.e., the normal at that spot cannot have changed since last frame unless the terrain itself was edited).
- Arm pipeline, per arm per frame: `armRestTarget()` (2752) or `constrainArmTarget()` (2786) each call `terrainHeight()` once, `shapeArmJoints()` (2929) calls it once per interior joint (2-3×), and `constrainArmPoint()` (2801) calls it once per chain point again (2-4×) — roughly 6-9 `terrainHeight()` evaluations per arm per frame, several of them sampling nearly the same (x,z) neighborhood (points along the same short arm chain).

Why it's inefficient (from the appearance side — the cost of `terrainHeight()` itself belongs to the terrain subsystem, not analyzed here): there is no per-frame memoization of terrain samples within a creature's render pass, even though several of these queries land at nearly identical (x,z) coordinates (adjacent joints of the same 0.3-0.6-unit-long arm, or a foot that hasn't moved). The leg foot-normal recompute in particular runs unconditionally every simulated frame regardless of whether `leg.end` changed since the last call — a planted (non-stepping) foot's ground normal is being recomputed for no behavioral reason.

Severity: **Medium.** Doesn't allocate, but is avoidable repeated work whose actual cost scales with however expensive the terrain subsystem's height function is (heightmap/CDLOD sampling can be considerably more expensive than the closed-form sine sum in the legacy app). A simple guard ("only recompute foot normal when `leg.end` moved beyond an epsilon since last sample") or a single per-frame terrain-height/normal cache keyed by rounded (x,z) would remove most of the redundancy.

---

## 8. InstancedMesh batching (`createCreaturePartBatches`) — `port-creature-system.js:805-907` and submit functions `3002-3061`

What it does: 8 `InstancedMesh` buckets (`shellBox`, `plateBox`, `trimBox`, `lightBox`, `footBox`, `jointSphere`, `limbSegment`, `shadowBox`), capacity 8192 each (line 911, not 4096 — that's just the function's default parameter, overridden at the actual call site). `beginFrame()`/`endFrame()` (858-894) reset/finalize counts; `add()` (845-853) writes matrix + optional color via `setMatrixAt`/`setColorAt`. Submit helpers (`submitBodyInstances`, `submitInstancedSegment/Joint/LocalJoint/HandFoot`, `submitLegInstances`, `submitArmInstances`, `submitShadowProxy`) all route through `composeWorldMatrix`/`composeGroupLocalMatrix`/`composeBodyShadowMatrix`, which reuse the module-level `_instMatrix`/`_instLocal`/`_instPos`/`_instScale`/`_instQuat` (759-774) — confirmed allocation-free.

Is it well used: **yes.** This is the strongest part of the pipeline. One shared material per bucket (created once, module scope, lines 814-822) regardless of creature count; per-instance tint is carried by `instanceColor`, not by swapping materials; `frustumCulled = false` (line 829) is the correct call since InstancedMesh bounding volumes don't reflect true instance placement, and per-creature LOD (`lodVisible`/`lodTier`/`lodArmsActive`) already gates which creatures submit at all (visibility/leg/arm loops in `updateCreatureLod()`, lines 4642-4707) before the submit step runs — so distant/hidden creatures are cheaply excluded rather than submitted-then-culled. `_mergeRigidBodyParts()` (1639-1683) additionally merges static body-box geometry by material for the non-instanced fallback path.

One real limitation: capacity is a hard cap of 8192 instances per bucket (`add()` returns `false` silently past capacity, line 847) — with no growth/reallocation and no reported overflow (the boolean return is only checked by the `stats.*++` increment, not surfaced as a warning), a very large creature population could silently stop rendering some body parts once a bucket fills, with no visible diagnostic. Not a performance inefficiency per se, but worth flagging as an unaddressed edge case adjacent to this system.

Severity: **Low** (this subsystem is well designed; the capacity-cap silent-drop is a robustness note, not a perf finding).

---

## 9. LOD gating — mitigating context, not a finding

`updateCreatureLod()` (4642-4707) already gates the expensive parts of this pipeline: `lodShouldSim` (frame-stride throttling for distant creatures, line 4668) skips the entire leg/arm IK loop (`animateParts` param to `render()`, passed as `c.lodShouldSim` at line 4794); `lodArmsActive` (line 4663, gated by `ikSq` distance) disables arm IK+finding-4's allocations entirely for creatures beyond IK range; `lodTier`/`LOD_BODY_ONLY_TIER` (line 3085) disables the leg loop entirely for "body only" tier creatures. This means findings 3, 4, 6, 7 above scale with *visible, near-camera, arm-active* creature count, not total creature count — which meaningfully caps the worst case. It does not change the per-instance cost, only how many instances pay it.

---

## Top offenders (ranked)

1. **Arm target/constrain allocation chain** (`2751, 2787, 2802, 2937`, + combat/carry extras) — **High**. 5-7+ `Vector3` allocations per arm per frame, unconditional, on the hot path; scales with arm count × active-creature count × frame rate. Directly contradicts the "allocation-free" assumption. Fix: give each arm persistent scratch fields (mirroring the leg's `_legRestGround` pattern) and replace every `X.clone()` feeding `localToWorld`/`worldToLocal` with `.copy()` into those fields.
2. **Redundant per-frame terrain sampling** (`3098` foot normal ×4 samples/leg, `2929/2801/2786/2752` arm pipeline ×6-9 samples/arm) — **Medium**. No memoization even when sampling near-identical (x,z), and foot-normal recompute ignores whether the foot actually moved.
3. **Per-creature materials created but unused when instancing is on** (`1386-1403`) — **Medium**. 9 of 13 materials per creature exist solely as `.color` containers under the default `'parts'` instancing mode; a plain `THREE.Color` would do, cutting spawn-time allocation cost for large creature counts.
4. **Per-leg `localToWorld(clone())`** (`3087`) — **Medium**. The one allocation the scouts already correctly flagged; small in isolation (6-8/frame) but trivially fixable the same way as offender #1.
5. **FABRIK iteration cap / tolerance** (`642-700`) — **Low, not actually a problem**. Warm-started + early-exit means 12/0.0001 is a safety ceiling, rarely hit in steady state.
6. **`placeSegment`/`setFromUnitVectors`** (`528-535`) — **Low**. Inherent cost of rigid-mesh bone rendering, already allocation-free.
7. **`shapeArmJoints` trig + warm-start pollution** (`2914-2932`) — **Low**. Cheap trig, correct scratch-vector use; the bent-pose warm-start side effect is a minor curiosity, not a measurable cost.
8. **InstancedMesh batching** (`805-907`, `3002-3061`) — **Low / not an inefficiency**. Well-designed: shared materials, reused scratch matrices, LOD-gated submission. Only note is a silent capacity cap (8192/bucket) with no overflow diagnostic.
