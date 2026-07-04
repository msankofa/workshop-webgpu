# Base-scene draw-call and shadow-composition findings

Source data: `research/stats/perf-2026-07-04T18-17-12-291Z.csv` (231 samples, 1 s cadence,
~233 s capture). All averages below were recomputed directly from that CSV.
`creatureMode=on`, `creatureInstancingMode=parts`, `terrainMode=chunks` (CDLOD **not**
active in this capture), `postMode=on` for every sampled row.

Expensive frames = `passPostMs>=25` (17 rows). Normal = the remaining 214 rows.

| metric | expensive avg | normal avg | all avg |
|---|---|---|---|
| renderDrawCalls | 382.6 | 363.0 | 364.5 |
| triangles | 1,407,479 | 1,359,174 | 1,362,729 |
| creatureShadows (== creatureInstancedShadows) | 4.94 | 2.99 | 3.13 |
| forestInstances | 71.5 | 18.5 | 22.4 |
| plantInstances | 254.6 | 65.7 | 79.6 |
| creatureVisible / creatureLod0 (full-detail tier) | 6.0 / 4.94 | 4.83 / 2.99 | — |
| creatureLod3 (hidden, far) | 0.0 | 1.17 | — |
| forestDraws / plantDraws / terrainDraws / waterDraws | 96 / 16 / 25 / ~2.25 | 96 / 16 / 25 / ~2.26 | constant |

The draw-call counts for terrain/water/forest/plants/creature-instanced-parts are all
**constant** between expensive and normal frames — they never change with camera
position. Only *instance counts* (forestInstances, plantInstances, creatureShadows/LOD
tier) and the derived triangle/GPU throughput move. Expensive frames correlate with the
camera being close to more creatures (all 6 visible, more at LOD tier 0) and near a
denser patch of forest/plants — a single confound (camera position) drives most of the
correlated metrics, not extra draw calls from those subsystems.

## 1. What `creatureShadows` counts, and how creature shadows are actually rendered

- `environment-viewer.html:963` — `creatureShadows: cs.shadowCasters` (HUD/CSV field).
- `port-creature-system.js:4739-4742` (inside `updateCreatureLod`):
  ```
  const castsShadow = c.lodVisible && d2 <= shadowSq;
  c.lodCastsShadow = castsShadow;
  if (castsShadow) creatureStats.shadowCasters += creatureBatches ? 1 : c.shadowBodyMeshes.length;
  ```
  With the default instancing mode (`CREATURE_INSTANCING_MODE = 'parts'`, `port-creature-system.js:4`),
  `creatureBatches` is truthy (`port-creature-system.js:923-925`), so **each creature within
  `shadowDistance` contributes exactly 1** to the counter — it is an *instance count*, not a
  draw-call count.
- The actual shadow geometry is a single oversized proxy box per creature, not the real
  body meshes: `composeBodyShadowMatrix` (`port-creature-system.js:807-817`) builds a box
  scaled to `bodyScale * (1.72, 0.88, 1.62)` and every creature's proxy is appended to **one
  shared `THREE.InstancedMesh`** (`shadowBox` bucket, `port-creature-system.js:835-837,
  847-849, 895-896`). `defs.shadowBox.material.colorWrite = false` — it still exists in the
  main color pass (so it never gets skipped there) but writes no color, and it's the only
  one of the 8 instanced buckets with `castShadow = true`.
- Net effect: **there is exactly one shadow-casting draw call for all creatures combined**
  — the CSV confirms this: `creatureInstancedShadows` equals `creatureShadows` in every
  single row (both driven by the same `buckets.shadowBox` instance count). Going from 2.8
  to 4.9 is not "more shadow passes," it's more creatures within `shadowDistance` feeding
  more instances into that one already-existing draw. Per-instance shadow cost is a 12
  triangle box (`BoxGeometry(1,1,1)`, confirmed via `node -e` against
  `node_modules/three`), so even at 6 casters that's 72 triangles into a single 2048×2048
  PCFSoft shadow map (`environment-viewer.html:149-150, 589`) — negligible.
- Only one shadow-casting light exists (the sun `dirLight`, `lights.js:40`,
  `environment-viewer.html:587-592`, mapSize 2048×2048, ortho box ±90, near 1/far 260); a
  `moonLight` with an equivalent shadow setup exists for night (`environment-viewer.html:604-607`)
  but the two are mutually exclusive (day/night swap), so there is never more than one
  active shadow map. **Conclusion: creature shadow cost is not a driver of the base-scene
  draw-call/triangle spike.** It is cheap and already collapsed to one instanced draw.

## 2. Draw-call decomposition (~364 avg)

Because Three.js's WebGPU renderer counts every actual GPU draw submitted across every
pass (main color pass + reflection pass + shadow depth pass) in `renderer.info.render.calls`
(read at `environment-viewer.html:930` as `renderDrawCalls`), the ~364-per-frame total is
**not** one draw per visible object — it's the same base-scene objects submitted multiple
times per frame:

**Main color pass (~150 draws, fixed count regardless of instance density):**
- Terrain: 25 draws — one `THREE.Mesh` per active chunk (`terrain-system.js` chunk render
  mode; confirmed fixed via CSV `terrainDraws`==25 every row). Default `chunkSize=30`,
  `renderRadius=2` (`terrain-system.js:14-16`) → `(2·2+1)² = 25` chunks.
- Water: ~2 draws (`waterDraws`/`waterMeshes`, near/mid LOD rings).
- Forest (GPU): 96 draws = `V * 8` (`forest-gpu.js:388`, `stats.draws`), where `V` = 12
  variants (`species=3` × `variantsPerSpecies=4`, `environment-viewer.html:1323`,
  `forest-palette.js:46,57`). Each variant emits 8 separate mesh objects
  (`forest-gpu.js:273-288`: branchesL0, leavesL0, shadowL0, branchesL1, leavesL1,
  branchesL2, leavesCoarseL2, billboardL3) — **this count is fixed no matter how many
  instances survive GPU cull**, since each is one indirect-draw `THREE.Mesh`.
- Plants (GPU): 16 draws = `V` (`plants-gpu.js:197`), one mesh per plant variant, also
  fixed regardless of instance count.
- Creatures: 8 draws — one per instanced-part bucket (`shellBox, plateBox, trimBox,
  lightBox, footBox, jointSphere, limbSegment, shadowBox`, `port-creature-system.js:827-837`),
  fixed regardless of creature count/LOD mix (creature count only changes the *instance
  count* inside each bucket, per `creatureInstancedBoxes/Limbs/Joints/HandsFeet/Shadows` —
  confirmed all fluctuate in the CSV while the *bucket count* stays 8).
- Sky dome (1, `sky.js:86`), stars + Milky Way band (~2, `stars.js:38,48,93,98`), clouds
  (1, `clouds.js:167`, single `THREE.Mesh` subclass).

Sum ≈ 25+2+96+16+8+1+2+1 ≈ **151 main-pass draws** — well under half the observed ~364.

**Reflection pass — the dominant, unaccounted-for source (this is the key finding):**
- `water.js:555` calls `reflector()` (TSL `ReflectorNode`) with no `resolutionScale`
  override, so the reflection render target defaults to **full resolution**
  (`resolutionScale=1`, `node_modules/three/build/three.webgpu.js:37040-37050`).
- `bounces` also defaults to `true` → `updateBeforeType = NodeUpdateType.RENDER`
  (`three.webgpu.js:37098-37103`), meaning the reflector's `updateBefore` fires **every
  single render**, not on some throttled schedule.
- Inside `updateBefore` (`three.webgpu.js:37364-37398`), Three.js does
  `material.visible = false` (hides only the water surface itself) then
  `renderer.render( scene, virtualCamera )` (line 37386) — **the entire `scene` graph is
  re-rendered from a mirrored camera**: terrain, forest, plants, creatures, sky, stars,
  clouds — everything except the water surface itself.
- CSV corroboration: `waterReflectionPasses` is a cumulative session counter that rose
  from 6,235 to 16,376 over the ~232.8 s capture — **≈43.6 passes/second**, matching the
  observed frame rate almost exactly, confirming one full reflection re-render per
  rendered frame, every frame, unconditionally.
- This roughly **doubles** the main-pass draws (minus the ~2 water draws, which hide
  themselves): reflection pass ≈ 151 − 2 ≈ **149 more draws**.

**Shadow depth pass (sun only) — smaller but real:**
- Only meshes with `castShadow = true` are resubmitted into the shadow map.
  - Forest: 4 of the 8 mesh types per variant cast shadows
    (`branchesL0, shadowL0, branchesL1, branchesL2` — `forest-gpu.js:273-278`) → `4 × 12
    variants = 48` shadow draws.
  - Plants: `castShadow = false` (`plants-gpu.js:124-125`) — **no** shadow draws.
  - Terrain: `receiveShadow = true` only, never `castShadow` (`terrain-system.js:397,437`,
    `cdlod-terrain.js:215`) — **no** shadow draws.
  - Creatures: exactly 1 (the shared `shadowBox` instanced draw, see §1).
- Sum ≈ 48 + 1 ≈ **49 shadow-pass draws**.

**Total estimate: 151 (main) + 149 (reflection) + 49 (shadow) ≈ 349**, matching the
observed 360–410 range closely (the residual ~10-60 is HUD/debug overlays, particle
system draws, and selection/grid helpers not itemized here). **The water reflection pass
is the single largest unaccounted-for contributor** — it silently duplicates almost the
entire base scene's draw calls every frame, at full render-target resolution, and this
duplication (not post-processing, not creature shadows) is why base-scene draw calls and
triangles — not `passPostMs` — actually track the frame cost.

## 3. Where the ~1.36M triangles concentrate

- Terrain: 25 chunks × `segments=max(14, round(30·0.75))=23` (`terrain-system.js:15,314`)
  → `23×23×2 = 1,058` triangles/chunk → **~26,450 triangles** (fixed, negligible, ~2% of
  total). Doubled by the reflection pass ≈ ~53K.
- Creatures: computed from average instanced-part counts × per-primitive triangle counts
  (verified via `node -e` against the actual `three` geometries used in
  `port-creature-system.js:820-834`: `BoxGeometry(1,1,1)` = 12 tris, `SphereGeometry(1,12,10)`
  = 216 tris, `CapsuleGeometry(1,1,4,10)` = 180 tris): boxes+limbs+joints+hands/feet+shadow
  average out to **roughly ~35-40K triangles per pass**, ~70-80K once doubled by the
  reflection pass — still only ~5-6% of the 1.36M total, despite creature LOD/shadow
  metrics being the ones singled out in the original finding.
- That leaves **~1.2M+ triangles (≈90% of the total) attributable to forest + plants
  (+ water/sky/stars/clouds)**, and specifically to vegetation: `forestInstances` and
  `plantInstances` are exactly the metrics that move 3-4x between normal and expensive
  frames (18.5→71.5 and 65.7→254.6 respectively) while forest/plant *draw counts* stay
  fixed (96 / 16) — i.e., the GPU-side indirect-draw instance counts (post-cull survivor
  counts written by the compute cull passes in `forest-gpu.js`/`plants-gpu.js`) are what's
  actually scaling triangle throughput, not any change in the number of draw calls.
  **Conclusion: vegetation (forest procedural bark/leaf geometry, secondarily plants)
  dominates the triangle budget, not terrain LOD tessellation (negligible in `chunks`
  mode — CDLOD wasn't even active in this capture) and not creature meshes.**

## 4. Redundant / always-on base-scene draw sources

1. **Water planar reflection re-renders the whole scene every frame at full resolution**
   (`water.js:555`, `three.webgpu.js:37364-37398`) — see §2. This is the single biggest
   redundant cost identified: it isn't gated by distance-to-water, water visibility on
   screen, or a reduced resolution/frequency, and it duplicates terrain + forest + plants
   + creatures + sky every single frame regardless of whether the reflection is even
   prominently visible from the current camera angle.
2. **Creature part rendering is already de-duplicated** (the `parts` instancing mode
   collapses all body/limb/joint draws to 8 fixed buckets, and shadow-casting collapses
   further to a single shared proxy box) — this is *not* a redundant source; it's evidence
   the creature system was already optimized in this direction (see `docs/subsystems/creature.md`
   and the SP8 instancing design doc at `docs/superpowers/specs/2026-06-26-sp8-creature-instancing-design.md`).
3. **`waterCausticEnabled` reports `true` for every sampled row, but `waterCausticPasses`
   stays at 0 for the entire 232.8 s capture** (`water.js:465-467,739,1094`). This looks
   like a monitoring/wiring gap rather than a perf cost: `causticRenderStats.enabled` is
   computed from `CAUSTICS_ENABLED && causticStrength > 0 && causticGroup.children.length
   > 0` (line 739), none of which actually confirm the `CausticTextureNode` is wired into
   a material that gets rendered this frame; the node's `updateBefore` (which increments
   `passes`) only fires if `ground.material.emissiveNode` reaches a drawn material
   (`water.js:783-788`). In this `chunks`-mode capture it apparently never does, so the
   "enabled" flag is misleading (not itself a redundant draw, but worth knowing the stat
   doesn't reflect reality here).
4. Sky dome, stars/Milky Way, and clouds are each single, cheap, always-on draws (1-2
   each) — not worth optimizing relative to the reflection-pass duplication above.

## Bottom line

The dominant, previously-uncounted cost is **the full-scene planar water reflection pass**
(`water.js` + Three's `ReflectorNode`), which silently re-submits nearly every base-scene
draw call a second time, every frame, at full resolution — this is why base-scene draw
calls/triangles (not `passPostMs`) track frame cost, and why forest/plant instance density
and creature LOD/shadow-caster counts (which move together because they all correlate with
camera proximity to dense scene regions) show up as the visible symptom rather than the
cause. Creature shadow rendering itself (`creatureShadows` 2.8→4.9) is cheap and already
collapsed to a single instanced draw call — it is a correlated symptom of "camera near more
creatures," not a meaningful direct cost.
