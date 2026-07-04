# Optimization Spec — Appearance / Mesh / IK / Render Pipeline

Scope: the per-frame `Creature.render()` call chain and creature spawn-time mesh/material
construction in `port-creature-system.js`. Physics, steering, collision, and terrain-sampling
*internals* are out of scope (owned by the locomotion and steering specs); this spec only
addresses render-side callers of those systems.

All line numbers refer to `port-creature-system.js` at the state read on 2026-07-04. Every
anchor below was re-read from source before speccing.

---

## Findings validation

### Confirmed (survives scrutiny — worth acting on)

- **Arm target/constraint pipeline allocates 5–7 `Vector3`/arm/frame (finding 4).**
  Confirmed at every cited line:
  - `2937` `shoulderWorld = this.group.localToWorld(arm.attachmentLocal.clone())` — 1 clone, unconditional per arm/frame.
  - `2751` `armRestTarget()` `this.group.localToWorld(arm.restLocal.clone())` — 1 clone, hit in idle/recover/carry-fallback (the common case).
  - `2787` `constrainArmTarget()` `this.group.worldToLocal(target.clone())` — 1 clone, unconditional.
  - `2802` `constrainArmPoint()` `this.group.worldToLocal(point.clone())` — 1 clone per interior/end joint, looped at `2951` over `points.length-1` (2–4 clones).
  - Combat/carry extras confirmed: `2904` carry clone; `2832`/`2835` punch dir/strike clones; `2840` two clones (`restLocal.clone()` + `new THREE.Vector3()`); `2767` `chooseArmObject` per-candidate clone (cooldown-gated).
  Verified `arm.attachmentLocal`/`restLocal`/`carryLocal`/`bendLocal` are `.clone()`'d once at construction (`1534-1550`) and **never** mutated afterward (no `.set`/`.copy` sink anywhere), so pooling into per-arm scratch is safe. **This is the headline win.**

- **Per-leg `localToWorld(clone())` at `3087` (finding 3).** Confirmed: exactly one `Vector3`
  clone per leg per frame, the only allocation in the leg loop (`3086-3101`). `leg.attachmentLocal`
  is immutable (set at `1481`). Same fix shape as the arm case; bundle them.

- **Redundant per-frame terrain sampling (finding 7).** Confirmed: `terrainNormal()` (`18-25`)
  issues **4** `terrainHeight` calls per invocation, called at `3098` once per leg per frame
  unconditionally (planted or not). Arm pipeline confirmed to sample terrain at `2752`, `2786`,
  `2795`, `2801`, `2817`, `2929` — 6–9 `terrainHeight` calls per arm per frame, several at
  near-identical (x,z). **Cross-spec note:** the locomotion spec (its finding 1) establishes
  that `terrainHeight` is injected (`3`) and is a **BVH raycast with per-call heap allocation**
  when a hand-authored `maps/workshop/*.glb` map is loaded — not the cheap analytic sine-sum.
  That makes this render-side finding materially worse in exactly the mode currently exercised in
  this working tree. The memoization win is render-owned; the raycast cost itself is the terrain
  subsystem's.

- **FABRIK iteration cap is *not* a problem (finding 1) — exoneration confirmed.** `solve()`
  (`660-699`) warm-starts from persistent `this.points` (reset only on length change, `661`),
  has an O(n) full-extension fast path (`667-673`), and squared-distance early-exit (`695`).
  `_fabrikDir` (`763`) is the only vector touched in the loop — allocation-free. The analyst was
  right to reject the scouts' hypothesis; **do not spec FABRIK changes.**

- **InstancedMesh batching is well-designed (finding 8) — exoneration confirmed.** Shared
  per-bucket materials, `instanceColor` tint, reused `_inst*` scratch matrices (`769-774`),
  `frustumCulled = false`, LOD-gated submission. The only real note is the silent 8192/bucket
  capacity cap. **Not a perf finding; do not spec batching changes.** (The capacity cap is a
  robustness item, listed under "Deferred / out of scope" below.)

- **`placeSegment` / `setFromUnitVectors` (finding 2) and `shapeArmJoints` (finding 6) are
  low/inherent.** Both confirmed allocation-free (`_mid`/`_seg` at `527`; `_armAxis`/`_armPole`/
  `_armPreferred` at `766`). Not worth CPU-side work.

### Corrected (claim partially wrong — scope narrower than stated)

- **"9 of 13 per-creature materials are pure `.color` containers; a plain `THREE.Color` would
  serve identically" (finding 5) — OVERSTATED.** Two corrections:
  1. **Material identity is load-bearing for 5 of the 9.** `_box()` (`1605-1624`) routes into
     instancing buckets by **identity comparison** — `material === this.plateMat` (`1612`),
     `=== this.trimMat` (`1614`), `this.lightMats.includes(material)` (`1616`), else `shellBox`
     — and derives `castsBodyShadow` from `=== this.shellMat || === this.plateMat` (`1619`,
     `1633`). So `shellMat`, `plateMat`, `trimMat`, `lightMats[0]`, `lightMats[1]` are used as
     routing tokens, not just color. `lightMats` are *also* live-swapped onto `part.material` by
     the blinker animation each frame (`3080`) and read back through `materialColor(part.material)`
     in submit. They **cannot** be demoted to `THREE.Color` without first refactoring `_box` to
     take an explicit bucket argument and reworking the blink swap.
  2. **`materialColor()` reads `.color` off a Material (`780-782`), so a bare `THREE.Color`
     cannot be dropped in as-is** — it has no `.color` property and would fall through to
     `whiteMat.color`. The read sites must change too.
  The genuinely clean win is narrower: **`limbMat`, `jointMat`, `footMat`, and the local `skin`**
  (`1387-1390`, `1448`) are consumed *only* via `userData.material → materialColor().color`
  (`1467/1474/1519/1526/1692/1712` store them; `3019/3026/3038` read them) and never compared by
  identity. Those 4 are demotable with a small submit-path change. Still a valid Medium spawn-time
  win, just 3–4 materials, not 9. See Change C.

### Rejected / no action

- FABRIK cap (finding 1), `placeSegment` (finding 2), InstancedMesh batching (finding 8):
  exonerated above.
- `shapeArmJoints` warm-start "cache pollution" (finding 6): the `points[i].lerp(_armPreferred,
  0.38)` at `2930` does mutate the chain's persistent `this.points`, but the end-effector
  tolerance check (`695`) is unaffected and any extra-iteration cost is bounded by the same
  early-exit that makes FABRIK cheap. Not worth the correctness risk of changing. No action.

---

## Change A — Pool the arm + leg target/constraint `Vector3` allocations

**Problem.** The IK render path clones a `Vector3` on nearly every `localToWorld`/`worldToLocal`
call. Guaranteed idle-case cost is ~5–7 clones/arm/frame (`2937`, `2751`, `2787`, `2802×(chain-1)`)
plus 1 clone/leg/frame (`3087`), all on the hot path, unconditional whenever `lodArmsActive` /
`lodTier < LOD_BODY_ONLY_TIER`. For an 8-arm tentacle plan that is 40–56 short-lived allocations
per frame from this one pipeline, times every near-camera creature — pure GC pressure.

**Proposed change.** Give each arm and each leg persistent scratch `Vector3` fields, mirroring the
existing `_legRestGround`/`_legMoveDir`/`_legLookAhead` module-scratch pattern (`765`), and replace
`X.clone()` (fed straight into a mutating `localToWorld`/`worldToLocal`) with `scratch.copy(X)` then
the transform. Concretely:

- Add per-arm fields at arm construction (`1534-1550`), e.g. `arm._shoulderWorld`, `arm._restWorld`,
  `arm._localScratch`, `arm._pointScratch` (all `new THREE.Vector3()`).
- `renderArms` `2937`: `const shoulderWorld = this.group.localToWorld(arm._shoulderWorld.copy(arm.attachmentLocal))`.
- `armRestTarget` `2751`: `const target = this.group.localToWorld(arm._restWorld.copy(arm.restLocal))`.
  Note this returns a value the caller `.copy()`s into `arm.desiredTarget` (`2857/2860/…`), so a
  reused buffer is safe as long as the copy-out happens before the next `armRestTarget` call — it
  does in every branch. **Verify the combat branch (`2837` + `2846/2848`) does not hold two live
  `armRestTarget` results simultaneously** (it calls it up to twice: `windupBack` at `2837` then
  `armRestTarget` again at `2846`); if both must be live, give combat its own second buffer or keep
  those two paths on `.clone()` (combat-only, rarer).
- `constrainArmTarget` `2787`: `worldToLocal(arm._localScratch.copy(target))`.
- `constrainArmPoint` `2802`: `worldToLocal(arm._pointScratch.copy(point))` — this is looped, but
  each iteration is fully consumed before the next, so one buffer suffices.
- Leg loop `3087`: store a persistent `leg._hipWorld` (created at leg construction, `1481` region)
  and do `const hipWorld = this.group.localToWorld(leg._hipWorld.copy(leg.attachmentLocal))`.

The combat/carry extras (`2832`, `2835`, `2840`, `2904`, `2767`) are lower priority: `2904` (carry)
is common enough to pool with `arm._restWorld` reuse; the punch clones (`2832/2835/2840`) fire only
mid-attack and can be deferred or pooled into two combat-only scratch fields; `2767` is
cooldown-gated (0.75 s) and periodic — leave for a follow-up.

**Expected win.** Eliminates ~5–7 heap allocations/arm/frame + 1/leg/frame on the render hot path;
for a busy near-camera scene with several multi-arm creatures this removes tens to low-hundreds of
short-lived `Vector3`s per frame, cutting minor-GC frequency (the main symptom: periodic frame-time
spikes, not steady-state ms). No change to visual output.

**Risk / correctness.** Low-to-medium. The one real hazard is buffer aliasing — a reused buffer
must be fully consumed (copied out or transformed) before its next reuse in the same frame. Two
spots need care: (1) `armRestTarget`'s return being live across two calls in the combat branch
(noted above); (2) `constrainArmTarget` internally does `target.copy(this.group.localToWorld(local))`
at `2794` where `local` is the worldToLocal scratch — since `target` is `arm.desiredTarget` (not the
scratch) this is fine, but confirm the scratch isn't the same object as `target`. Keep the combat
punch clones as-is initially to shrink the risk surface.

**Effort.** M (arm fields + 4–5 edited call sites + leg field; careful aliasing review).

---

## Change B — Memoize terrain samples within a creature's render pass

**Problem.** `terrainNormal()` at `3098` recomputes a foot's ground normal (4 `terrainHeight` calls)
every frame per leg, unconditionally, even when the foot is planted and `leg.end` has not moved — the
normal cannot have changed unless the terrain was edited. Separately, the arm pipeline issues 6–9
`terrainHeight` calls per arm per frame (`2752/2786/2795/2801/2817/2929`), several at nearly
identical (x,z) along the same sub-unit-long arm chain. With a workshop map loaded, each such call is
a BVH raycast (see locomotion spec finding 1), so the redundancy is expensive, not free.

**Proposed change.** Two independent, cheap guards:

1. **Foot-normal skip (highest value, lowest risk).** Store `leg._lastNormalSampleX/Z` and cache the
   resulting `_n`/quaternion per leg. In the leg loop (`3097-3100`), only call `terrainNormal` +
   `orientFromUpForward` when `leg.end` moved beyond an epsilon (e.g. `1e-4` squared) since the last
   sample; otherwise reuse the cached `leg.foot.quaternion`. A planted foot then pays zero terrain
   samples per frame instead of 4. Note `_fwd` (creature heading) also feeds the orientation, so the
   guard should also refresh when yaw changed materially — or simply gate on "foot moved OR yaw
   delta > epsilon" to stay visually correct during turns.
2. **Per-frame terrain-sample cache for the arm pipeline (optional, lower value).** A tiny
   fixed-size cache keyed by rounded (x,z) (e.g. quantized to ~0.1 units) populated during a
   creature's render pass and cleared per creature. Given arm-chain joints cluster within a
   0.3–0.6-unit span, several of the 6–9 samples would hit. This is more code for a smaller win than
   (1); recommend shipping (1) first and measuring before doing (2).

**Expected win.** For a static or slow-moving creature with L legs, removes 4·L `terrainHeight` calls
per frame outright. When a workshop map is loaded (current default in this tree), that is 4·L avoided
BVH raycasts + their per-call array/`Vector3` allocations per frame per near-camera creature — the
single largest render-owned cost reduction in map mode. Analytic-map mode gains less but still
non-zero.

**Risk / correctness.** Low for (1) if the guard also covers yaw change (else feet visibly stop
re-tilting during turns on sloped ground). Terrain is effectively static per frame, so intra-frame
memoization in (2) is safe; the only staleness would be a mid-frame terrain edit, which does not
happen during render. Keep the epsilon conservative to avoid visible foot-orientation popping.

**Effort.** S for (1); M for (2).

---

## Change C — Demote color-only materials to reduce spawn-time allocation

**Problem.** Each creature constructs 13 materials at spawn (`1386-1403`). Under the default
`CREATURE_INSTANCING_MODE === 'parts'`, `limbMat`, `jointMat`, `footMat`, and the local `skin`
material are never bound to a rendered `Mesh` — they exist only to have their `.color` read back once
per frame via `materialColor(part.userData.material)` for `InstancedMesh.setColorAt`. Building a full
`MeshStandardMaterial` (UUID, event dispatcher, full default property set, program-cache
implications) purely to box a color is wasted spawn work, which shows up as a hitch when batch-
spawning teams. (Corrected scope: `shellMat/plateMat/trimMat/lightMats` are *not* included — they are
used as bucket-routing identity tokens in `_box` and, for `lightMats`, live-swapped by the blinker
animation, so they must stay real Materials unless `_box` is refactored. See findings validation.)

**Proposed change.** For the four color-only materials, store a `THREE.Color` instead of a Material and
have the mesh parts carry `userData.color` (a `THREE.Color`) rather than `userData.material`:

- Replace `this.limbMat`/`this.jointMat`/`this.footMat` construction (`1388-1390`) and local `skin`
  (`1387`, currently a `MeshStandardMaterial` passed to `_box` at `1448`) — but note `skin` goes
  through `_box`, which falls into the `shellBox` bucket and still needs a color; keep `skin`'s
  color but it can be a `THREE.Color` fed to `_box` if `_box` is taught to accept a `{bucket, color}`
  form. Simplest first cut: only demote `limbMat`/`jointMat`/`footMat` (the `_cap`/`_joint`/hipBall/
  shoulder/foot/hand parts, `1462-1526`, `1692`, `1712`), which never touch `_box`.
- At the storage sites, set `part.userData.color = this.jointColor` (a `THREE.Color`) instead of
  `userData.material = this.jointMat`.
- Update the submit readers `submitInstancedSegment/Joint/LocalJoint/HandFoot` (`3015-3039`) to read
  `part.userData.color` directly instead of `materialColor(part.userData.material)`; keep
  `materialColor` for the `_box` path (`3006`) which still holds real Materials.
- Guard on `CREATURE_INSTANCING_MODE`: in the non-default `'off'` mode these materials **are** bound
  to real per-segment meshes (`1698/1715` and the `_cap`/`_joint` else-branches), so the demotion must
  be gated to parts mode — construct the cheap `THREE.Color` in parts mode and the full Material in
  off mode. Do not regress the `'off'` path.

**Expected win.** ~3 fewer `MeshStandardMaterial` constructions per creature at spawn (parts mode).
Purely spawn-time; no steady-state framerate change. Meaningful only for large/batched spawns (two
full teams), where it trims a spawn hitch. Low absolute value — schedule after A and B.

**Risk / correctness.** Medium, mostly from the two code paths (`'parts'` vs `'off'`) and the shared
`materialColor` reader. Easy to accidentally break the `'off'` fallback or the `_box`/blinker paths
if the demotion isn't tightly scoped. Keep the change surgical: only the three non-`_box`, non-blink
materials, only in parts mode.

---

## GPU / TSL opportunities (separate track — do not bundle with the CPU wins above)

These are larger, higher-risk architectural moves specific to the WebGPU workspace. Listed for
completeness; none should block the cheap CPU wins.

- **GPU skinning to retire per-segment `placeSegment` (finding 2).** The stretch-to-fit rigid-mesh
  bone rendering (`528-535`, ~18–24 `setFromUnitVectors`/creature/frame) is inherent to the current
  CPU technique. A real skinned skeleton with a TSL/compute skinning node would move the per-bone
  reorientation to the GPU. This is a large rewrite of the render half of `Creature` and the batching
  system; only worth it if `placeSegment` shows up materially in a CPU profile (analysis rates it
  Low). **Effort L, defer.**

- **GPU-side IK is not recommended.** FABRIK here is already cheap (warm-started, early-exit) and
  branchy/serial per chain — a poor fit for GPU. Keep IK on the CPU; the win is in Change A
  (allocations), not in moving the math.

- **`instanceColor` already carries per-part tint on the GPU** (batching, `805-907`) — this is
  already the right pattern; Change C only removes redundant CPU-side Material objects feeding it, it
  does not change the GPU path.

---

## Deferred / out of scope (robustness, not perf)

- **InstancedMesh 8192/bucket silent capacity cap** (`add()` returns `false` unchecked, ~`847`).
  Not a perf inefficiency; a very large population could silently stop drawing some body parts with
  no diagnostic. Worth a logged overflow warning eventually. Not speced here.

---

## Ranking by impact-to-effort

| Rank | Change | Impact | Effort | Why this order |
|---|---|---|---|---|
| 1 | **B(1) — foot-normal terrain-sample skip** | Med–High (High in workshop-map mode) | **S** | Best ratio: removes 4·L raycasts/frame/creature for planted feet; tiny, localized guard. |
| 2 | **A — pool arm + leg IK `Vector3`s** | High (GC-spike reduction) | M | Largest allocation source on the render hot path; the analyst's headline. Mechanical but needs aliasing care. |
| 3 | **B(2) — arm-pipeline terrain memo cache** | Med (workshop-map mode) | M | Real avoided raycasts but smaller than B(1); ship after measuring B(1). |
| 4 | **C — demote color-only materials** | Low (spawn-time only) | M | Spawn-hitch trim for batched spawns; corrected to ~3 materials; two-mode risk. |
| — | GPU skinning / GPU IK | Low CPU payoff, high risk | L | Defer; only if CPU profiling justifies a render rewrite. |

Recommended sequencing: **B(1) → A → (measure) → B(2) → C.** B(1) and A are the two that move
steady-state / spike behavior for a near-camera, arm-active creature scene; B(2) and C are
follow-ups whose value depends on map mode and spawn patterns respectively.
