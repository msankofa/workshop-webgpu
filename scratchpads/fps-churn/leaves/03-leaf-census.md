# 03 — Leaf census: what tree leaves actually draw and cost in Base Game's default configuration

Read-only census, 2026-09-09. No runtime file was edited. Working files beside this one:
`bake-census.mjs` (throwaway headless bake), `trace-dump.txt`, `raw-summary.txt`.

Every number below is labelled **counted in code**, **read from a capture**, or **arithmetic**.

Configuration this describes is the one the plants-on captures carry under `settingsAtStart`
(**read from a capture**, `research/stats/base-game-performance-log.json` entries 0/1/8/9):

```
treeSpeciesSelection = ez-ash_small,ez-ash_medium,ez-aspen_small,ez-oak_small,
                       ez-oak_large,ez-pine_small,ez-pine_large,ez-bush_1   (8 species)
treeVariantsPerSpecies = 2      -> 16 variants        (flora.trees.variants = 16, read from a capture)
treeTexMode = "authored"        treeLeafSize = 1      treeLeafSway = 1
treeLodR0/R1/R2 = 60 / 140 / 260   treeDrawRadius = 260
treeLod0 = treeLod1 = treeLod2 = true
treeBark = treeLeaves = treeBarkShadows = treeLeafShadows = true
treesPerHectare = 45   treeMaxSize = 0.55   treeCapPerVariant = 1024
```

The same values are the code defaults except the species list: `base-game-tree-species.js:17`
ships `DEFAULT_BASE_GAME_TREE_SPECIES = 'ez-aspen_small,ez-oak_small,ez-pine_small'` (3 species),
while `base-game-default-state.json:95` (the saved state the page loads) carries the 8-species
list the captures show. Palette-shaping leaf defaults, all **counted in code** at
`base-game-forest.js:47-49`: `treeLeafCount 10`, `treeLeafSize 1`, `treeLeafStart 0.25`,
`treeLeafSpread 0`, `treeLeafShadowPct 0.3`, `treeCoarseLeafRatio 0.25`,
`treeCoarseLeafSizeMult 2.5`. Billboards are off (`base-game-forest.js:423,590`
`billboards: false`), so each variant is **9** meshes, not 10.

---

## 1. Geometry per leaf role

### Which geometry each role draws (counted in code)

`forest-gpu.js:802-843` builds, per variant `g`:

| Mesh (role) | Geometry | Material | In main pass? | Casts? |
|---|---|---|---|---|
| `forest:v{g}:branchesL0` | `variant.branches` | `branchMat` | yes | no (see §3) |
| `forest:v{g}:leavesL0` | `variant.leaves` | `leafMat` | yes | no |
| `forest:v{g}:shadowL0` | `variant.shadow` | `leafMat` (same object) | yes | no |
| `forest:v{g}:branchesL1` | `variant.branchesLod1` | `branchMat1` | yes | no |
| `forest:v{g}:leavesL1` | **`variant.leavesMid ?? variant.leaves`** | `leafMat1` | yes | no |
| `forest:v{g}:branchesL2` | `variant.branchesLod2` | `branchMat2` | yes | no |
| `forest:v{g}:coarseLeavesL2` | `variant.leavesCoarse` | `coarseMat` | yes | no |
| `forest:v{g}:barkShadow` | `variant.branchesLod2` | `shadowMats.bark` | no (shadow layer 4) | yes |
| `forest:v{g}:leafShadow` | **`variant.shadow`** | `shadowMats.leaf` | no (shadow layer 4) | yes |

Five of the nine are leaf geometry: `leavesL0`, `shadowL0`, `leavesL1`, `coarseLeavesL2`,
`leafShadow`.

**`leavesL1` draws the full LOD0 leaf geometry, not a reduced bake.** `forest-palette.js:106-113`
builds `leavesMid` only when `params.midLeafRatio !== 1 || params.midLeafSizeMult !== 1`;
otherwise `leavesMid` is the *same object* as `leavesGeo`. `base-game-forest.js:243-251`
(`paletteParams`) never sets `midLeafRatio` or `midLeafSizeMult`. A repo-wide grep finds those
keys only in `forest-palette.js`, `tree-viewer.html:741-742` (sliders) and docs — never in
Base Game. So in Base Game **`variant.leavesMid === variant.leaves`** (confirmed by the headless
bake below: `midIsFull` true for all 16 variants).

**The shadow role uses a reduced leaf set, not the full one.** `variant.shadow` is the
`leafShadowPct = 0.3` bucket that `trees.js:541` splits off (`leafShadowRng.next() <
lo.shadowFraction`), i.e. ~30% of the leaves. `leavesCoarse` is `count × 0.25` leaves at
`size × 2.5` with `shadowFraction: 0` (`forest-palette.js:97-104`).

Note `shadowL0` is *not* a shadow caster in the shipped path — under `SHADOW_LIST` every main mesh
gets `castShadow = false` (`forest-gpu.js:1105`) and the `leafShadow` mesh carries all casting.
`shadowL0` exists in the main pass so the 30% shadow bucket still appears in the canopy; at LOD0
the visible canopy is `leavesL0 + shadowL0` = 100% of leaves in **two** draws.

### Headless bake (arithmetic from a run of the real bake code)

`scratchpads/fps-churn/leaves/bake-census.mjs` runs `createForestPalette` from `forest-palette.js`
with exactly the params `base-game-forest.js:243-251` assembles (`speciesTableForSelection` on the
8-species list, `maxSize 0.55`, `branchLods` = `BASE_GAME_BRANCH_LODS`, leaf params above,
`texSet = {mode:'authored', leafAtlas:{cols:2,rows:2}}`, `variantsPerSpecies: 2`).

Triangles per variant (arithmetic, from the bake):

| variant (species) | branches | branchesL1 | branchesL2 | leaves | leavesMid | shadow | leavesCoarse |
|---|---|---|---|---|---|---|---|
| ez-ash_small ×2 | 3868 | 1410 | 1030 | 828 / 840 | same as leaves | 372 / 360 | 360 |
| ez-ash_medium ×2 | 4498 | 1960 | 1635 | 2292 / 2336 | same | 1068 / 1024 | 1008 |
| ez-aspen_small ×2 | 1480 | 534 | 364 | 356 / 324 | same | 124 / 156 | 144 |
| ez-oak_small ×2 | 1170 | 582 | 452 | 692 / 656 | same | 268 / 304 | 288 |
| ez-oak_large ×2 | 5988 | 3276 | 2028 | 3764 / 3756 | same | 1636 / 1644 | 1620 |
| ez-pine_small ×2 | 11120 | 3705 | 2220 | 2564 / 2516 | same | 1076 / 1124 | 1092 |
| ez-pine_large ×2 | 12200 | 4065 | 2436 | 2848 / 2832 | same | 1152 / 1168 | 1200 |
| ez-bush_1 ×2 | 4704 | 2124 | 1698 | 1128 / 1200 | same | 552 / 480 | 504 |

Mean per variant (arithmetic): `leaves 1808.3`, `leavesMid 1808.3`, `shadow 781.8`,
`leavesCoarse 777.0`, `branches 5628.5`, `branchesLod1 2207.0`, `branchesLod2 1482.9`.

Cards, not triangles: every leaf card is one quad = **2 triangles, 4 vertices**
(`trees.js:557-574`, `_leafQuad`, `LEAF_CORNERS` of length 4, 6 indices). Authored mode uses
`shape: 'quad'` (`forest-palette.js:38-49`), so the 4-vertex card — not the many-vertex
`_leafShape` silhouette — is what ships. `doubleBillboard: true` (`trees.js:60`) makes **two
perpendicular cards per leaf**. Mean cards per variant (arithmetic): `leaves` 904,
`shadow` 391, `leavesCoarse` 388. A whole tree's canopy at LOD0 is ~1295 cards.

Card size (counted in code, `trees.js:558`): `w = 0.6 × size`, `h = size`, where
`size = sp.leaves.size × treeLeafSize` (`forest-palette.js:31`). Per-species `sp.leaves.size` for
this selection (arithmetic, from the bake): ash_small 2.05, ash_medium 2.67, aspen_small 2.50,
oak_small 1.38, **oak_large 4.50**, pine_small 0.965, pine_large 2.61, bush_1 2.45 — world metres
at instance scale 1. Instance scale comes from `sizeRange [0, treeMaxSize=0.55]`
(`base-game-tree-species.js:41`, `forest-placement.js:270-275`), so on screen a card is at most
~0.55× those figures — an oak_large leaf card is still up to **2.5 m tall × 1.5 m wide**, and the
LOD2 coarse card is `× coarseLeafSizeMult 2.5` on top of that (up to ~6 m tall).

Also note `leafOptsFor` overrides the authored per-species leaf *count* with the global one:
`leafOpts.count = params.leafCount ?? …` = **10** for every species (`forest-palette.js:29`),
replacing the preset values (ash_small 30, pine_small 21, oak_large 10, …). Not a cost finding,
but it means "leaf density" is one global number here, not per species.

---

## 2. Effective material settings per leaf role

Four leaf materials exist, each shared by every variant (`forest-gpu.js:763-789`). All are
`MeshStandardNodeMaterial` with `vertexColors: true`, `roughness: 1.0`, `metalness: 0.0`
(`makeMat`, `forest-gpu.js:731-738`). What is *actually in effect by default*:

| Role | Material | `side` | `alphaTest` | `transparent` | `map` | `depthWrite` / blending | Casts shadow |
|---|---|---|---|---|---|---|---|
| `leavesL0` | `leafMat` | **DoubleSide** | **0.5** | false | leaf atlas | default (true / NormalBlending) | no |
| `shadowL0` | `leafMat` (same) | **DoubleSide** | 0.5 | false | leaf atlas | default | no |
| `leavesL1` | `leafMat1` | FrontSide | 0.5 | false | leaf atlas | default | no |
| `coarseLeavesL2` | `coarseMat` | FrontSide | 0.5 | false | leaf atlas | default | no |
| `leafShadow` | `shadowMats.leaf` | **DoubleSide** | 0.5 | false | leaf atlas | default | **yes** |

Evidence:
- `side`: `makeMat(1.0, true)` for `leafMat` (`forest-gpu.js:764`) and `leafShadowMat`
  (`:785`); `makeMat(1.0, false)` for `leafMat1` (`:766`) and `coarseMat` (`:768`).
  Counted in code.
- The **"Tree leaves double-sided" toggle is not present in Base Game.** It is registered on
  `globalThis.window?.perfAB` (`forest-gpu.js:1282`); grepping `base-game.html` and
  `base-game-forest.js` for `perfAB` / `setFarLeavesDoubleSided` returns nothing. So `leafMat1`
  and `coarseMat` stay at their FrontSide default and `leafMat` / `leafShadowMat` are hardcoded
  DoubleSide with no way to change them from the page. Counted in code.
- `alphaTest` / `transparent` / `map`: `bindTreeMaterials` (`base-game-forest.js:120-153`) sets
  `leafMat.transparent = false` unconditionally, and in the authored branch
  `leafMat.map = set.leafMap; leafMat.alphaTest = set.leafMap ? (set.leafAlphaTest ?? 0.5) : 0`.
  `tree-textures.js:55` sets `leafAlphaTest: 0.5` for the authored set. `applyTextureSet`
  (`forest-gpu.js:1392-1399`) calls the binder once per role pair — L0, L1, L2-coarse, merged, and
  the shadow pair — so **all four leaf materials get the atlas and `alphaTest 0.5`**.
  `treeTexMode` default is `'authored'` (`base-game-forest.js:45`) and the capture confirms
  `flora.trees.textureMode = "authored"`, `texturesReady = true` (read from a capture).
- `depthWrite` / `blending` are never assigned anywhere in `forest-gpu.js` or
  `base-game-forest.js` — so three's defaults (`depthWrite: true`, `NormalBlending`) hold. With
  `transparent: false` these are opaque, depth-writing, alpha-tested draws. Counted in code
  (absence of assignment).
- Casting: under `SHADOW_LIST` all seven main meshes get `castShadow = false` every
  `syncRenderParts` (`forest-gpu.js:1105`); only `barkShadow` and `leafShadow` cast, on
  `SHADOW_LAYER` 4 so the main camera never sees them (`:842-843`). Counted in code.
- Every leaf material's `positionNode` is built with `sway = true`
  (`instanceNodes(uTreeScale.mul(uLeafScale), true)`, `forest-gpu.js:760-762,783`), and
  `treeLeafSway` defaults to 1, so each leaf vertex pays two `sin()` calls
  (`forest-gpu.js:517-522`). Branch materials do not. Counted in code.
- `normalNode` is set on every leaf material, and for leaves it is the plain instance-rotated
  normal (no normal map). With `DoubleSide` and a custom `normalNode`, three's automatic
  back-face normal flip does not apply — relevant to candidate 3 below.

---

## 3. Culling and LOD selection

Three mechanisms, in this order:

1. **GPU cull kernel** (`forest-gpu.js:363-464`), one invocation per instance slot:
   - hard far cutoff `dist ≤ uMaxDrawRadius` (Base Game: `treeDrawRadius` clamped to `lodR2`, so
     260 m) → `rejectedFar`;
   - padded view-cone rejection: `fwdDot ≥ cos(acos(clamp(fovCos − coneMargin)) + atan(treeRadius,
     dist)) − rearMargin`, `coneMargin` default 0.5 → `rejectedCone`;
   - optional Hi-Z occlusion against last frame's depth pyramid;
   - then a **hard, hysteresis-free distance chain**: `dist² ≤ r0²` → LOD0, else `≤ r1²` → LOD1,
     else `≤ r2²` → LOD2 (`:426-454`). There is no hysteresis anywhere in the chain, so a tree
     sitting on a ring flips rung every frame.
   - the shadow slot is written **before** the cone test (`:379-390`): every tree with
     `dist ≤ uShadowReach` is a caster, cone-rejected or not. `SHADOW_REACH = 90`
     (`base-game.html:3523`, fed in as `treeShadowReach`).
2. **CPU rung gate** (`forest-gpu.js:1005-1026`, `refreshRungCandidates` / `rungHas`): per variant,
   a distance-only bucket scan with ±0.5 m slack decides whether *any* tree of that variant could
   land in a rung; if not, all that variant's meshes for the rung are hidden so the renderer never
   walks them.
3. **`syncRenderParts`** (`:1070-1127`) applies the gate plus `renderParts.leaves` /
   `lodEnabled[rung]` to set `.visible`.

### What the captures say was live (read from a capture)

| entry | capturedAt | lod0 | lod1 | lod2 | rejectedCone | rejectedFar | instances | draws | shadowDraws | flora.triangles |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 03:09:06 (trace on) | 23 | 90 | 287 | 284 | 606 | 1290 | 112 | 32 | 1,198,982 |
| 1 | 03:08:36 (trace on) | 5 | 85 | 255 | 244 | 657 | 1246 | 91 | 28 | 958,657 |
| 8 | 02:10:52 (no trace) | 6 | 88 | 251 | 227 | 674 | 1246 | 88 | 26 | 969,882 |
| 9 | 02:10:34 (no trace) | 3 | 11 | 147 | 401 | 684 | 1246 | 82 | 28 | 401,025 |
| 16 | 01:50:43 (plants off) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

(`23 + 90 + 287 + 284 + 606 = 1290 = instances`, so the lod counts are post-cull survivors.)

### Leaf objects the renderer walked (read from a capture, `context.scene.byOwner`)

| entry | forest renderables | of which leaf-named | leavesL0 | shadowL0 | leavesL1 | coarseLeavesL2 | leafShadow |
|---|---|---|---|---|---|---|---|
| 0 | 144 (= 16×9), `unculled 144` | **80** | 16 | 16 | 16 | 16 | 16 |
| 1 | 119 | **64** | 9 | 9 | 16 | 16 | 14 |
| 8 | 114 | **61** | 8 | 8 | 16 | 16 | 13 |
| 9 | 110 | **58** | 6 | 6 | 16 | 16 | 14 |

`leavesL1` and `coarseLeavesL2` are **16/16 in every capture** — the rung gate never trims them,
because with 8 species × 2 variants and 90 + 287 live trees at least one tree of every variant is
always inside the 60–140 and 140–260 bands. That is 32 leaf draws every frame no matter what.
In entry 0 the gate trimmed nothing at all (144 objects, all visible).

Per-draw instance counts are correspondingly tiny (arithmetic, entry 0): 90 LOD1 trees over 16
`leavesL1` draws ≈ **5.6 instances/draw**; 287 LOD2 trees over 16 `coarseLeavesL2` draws ≈ **18
instances/draw**; 23 LOD0 trees over 16 `leavesL0` draws ≈ **1.4 instances/draw**.

### Leaf triangles, main pass (arithmetic, palette means × capture rung counts)

| entry | leavesL0 | shadowL0 | leavesL1 | coarseL2 | **leaf total** | branch total | sum | flora.triangles (capture) |
|---|---|---|---|---|---|---|---|---|
| 0 | 41,591 | 17,981 | 162,747 | 222,999 | **445,318 (37.1%)** | 753,678 | 1,198,996 | 1,198,982 ✓ |
| 1 | 9,042 | 3,909 | 153,706 | 198,135 | **364,792 (38.0%)** | 593,878 | 958,670 | 958,657 ✓ |
| 8 | 10,850 | 4,691 | 159,130 | 195,027 | **369,698 (38.1%)** | 600,193 | 969,891 | 969,882 ✓ |
| 9 | 5,425 | 2,345 | 19,891 | 114,219 | **141,880 (35.4%)** | 259,148 | 401,028 | 401,025 ✓ |

The sums reproduce `flora.trees.triangles` to within rounding, which is the check that the headless
bake matches the palette the page actually baked (`paletteSource: "disk"`, key
`b5e7d6d3b418def7d1fee4b319b6e879ef6eb498`, read from a capture).

`leavesL1` alone (**full-detail leaf geometry**) is 13.6% of all forest triangles in entry 0 and
16.0% in entry 1 — more than `leavesL0 + shadowL0 + coarseLeavesL2` at LOD0 range combined in
entry 1.

Leaf share of each rung's per-instance triangles (arithmetic): L0 **31.5%**, L1 **45.0%**,
L2 **34.4%**. `rungTriangles` mean triangles per instance = `[8218.5, 4015.3, 2259.9, 2]`. The
L0→L1 step is only 2.05×, and leaves are the reason.

### Shadow pass (read from a capture)

`Shadow Map [ ID: 235 ]` (the sun) in entry 0: `ms 3.5`, `objects 239`, `draws 32`,
`objectsMs 2.8`, `encodeMs 2.7`, `nodesRenderMs 0.2`, `bindingsMs 0.3`, `drawMs 0.2`.
`draws 32 = 16 barkShadow + 16 leafShadow` and `flora.shadowDraws = 32`, so **half the sun shadow
pass's draws are leaf shadows**. Every one of the 12 named rows in that scene's `topBindings` and
`topNodes` is a `forest:v*:barkShadow` or `forest:v*:leafShadow`. Entry 1: `ms 5.5`, 28 draws,
14 leafShadow. The other two shadow scenes (`weaponFlashlight`, `weaponLaserDot`) contain no
forest rows.

The captures do **not** carry a shadow-slot instance count, so the number of trees casting leaf
shadows (those within `SHADOW_REACH = 90 m`, cone-rejected included) is not recoverable from them.

---

## 4. What this evidence can and cannot attribute

**CPU submission per leaf object — measured, but only in aggregate.** Entry 0's `Scene` trace:
`ms 19.7`, `exclusiveMs 13.8`, `objects 207`, `draws 220`, `objectsMs 12.9`, `encodeMs 12.1`,
`nodesRenderMs 4.3`, `bindingsMs 2.9`, `pipelinesMs 0.4`, `drawMs 1.3` (read from a capture).
The forest is 112 of those 220 draws, and 80 of its 144 objects are leaf-named. Every individual
leaf row in `topBindings`/`topNodes` is **0.0–0.3 ms** — no single leaf object is a hotspot; the
cost is spread across 80 of them. If per-object encode cost were uniform, leaves would be
`80/220 × 12.1 ms ≈ 4.4 ms` (**arithmetic, and the uniformity assumption is unverified** — the
trace's own top-12 rows show a 3× spread between the heaviest and lightest rows). The trace stages
cannot be attributed per role any more finely than that, because `topBindings`/`topNodes` list
only the top 12 rows per scene (`topBindingsShare 0.517`, `topNodesShare 0.326` in entry 0 — the
listed rows are only half and a third of their stage's time).

**GPU fragment cost — no evidence exists.** These captures carry no GPU timing at all:
`performance.seriesKeys` has no `gpu*` key, and `performance.passes` (`passForestMs`,
`passGrassMs`, …) are CPU sim/update timers, not render timings (`passForestMs.average = 0.327 ms`
in entry 0, which is the recull, not the draw). `?gputime=1` captures — none among these — give
**whole-frame GPU pass time only**, not per-role. So nothing here measures alpha-tested overdraw,
DoubleSide backface cost, or fragment shading of leaf cards. Any claim about those is a hypothesis
until a GPU measurement exists.

**Triangle counts — two different numbers, don't mix them.** `flora.trees.triangles` is
**arithmetic computed by the page** (`base-game-forest.js:634-637`: rung instance counts ×
`rungTriangles(palette)` means), not a renderer measurement, and it excludes the shadow pass
entirely. `performance.triangles` is `renderer.info` (entry 0: `average 626,468`,
`latest 662,173`). They disagree by roughly 2× in the same capture, so the flora figure is an
upper-bound model, useful for *proportions between roles* (which is how §3 uses it) and not as an
absolute frame cost.

**Shadow-pass cost — measured per scene, not per role.** `Shadow Map [ ID: 235 ]` is 3.5 ms
(entry 0) / 5.5 ms (entry 1) of a 20 ms / 31 ms `Render Pipeline`. Half its draws are leaf
shadows, but the split of its 2.7 ms `encodeMs` between bark and leaf is not in the data.

**Two things deliberately not done here.** (a) The whole-forest on/off deltas in this log
(entry 9 at 13.7 ms average vs entry 8 at 26.3 ms, or the plants-off entries 10–18 at 13.3–28.2 ms)
are **not** used to attribute a leaf cost: they move terrain streaming, grass and camera position
at the same time, and the plants-off entries have `flora.trees` entirely zeroed. (b) The earlier
`branchesL2` merge result is not extrapolated to leaves — that rung's win came from collapsing 16
draws into one over a single geometry with no alpha test, and neither the fragment profile nor the
per-variant geometry variance transfers.

---

## 5. Candidate targets, ranked

None of these removes leaves, species, variants or leaf shadows. Where a toggle is mentioned it is
a *diagnostic* to isolate cost, not the remedy.

### 1. `leavesL1` draws the full LOD0 leaf geometry — the intended mid bake is never requested
**Evidence (counted in code + arithmetic).** `forest-palette.js:106-113` leaves `leavesMid ===
leaves` unless `midLeafRatio`/`midLeafSizeMult` are passed; `base-game-forest.js:243-251` never
passes them; the headless bake confirms `midIsFull` for all 16 variants. Consequence
(arithmetic): `leavesL1` is 162,747 triangles in entry 0 and 153,706 in entry 1 — 13.6% and 16.0%
of all forest triangles, the single largest leaf role in both, and 45% of the LOD1 rung's
per-instance triangles. The rung that covers 60–140 m — where 85–90 trees live in every plants-on
capture — pays LOD0 leaf detail. `tree-viewer.html:741-742` already exposes these as sliders, so
the machinery exists and Base Game simply has no wiring for it.
**What would confirm it.** Bake with `midLeafRatio` in the 0.4–0.6 / `midLeafSizeMult` 1.3–1.6
range (the coarse rung's own trade, less aggressive), re-run the same headless census for the new
triangle count, then a same-camera capture pair for `Scene.exclusiveMs`, `performance.triangles`
and `flora.trees.triangles`. Appearance risk is real and needs a look at the 60–140 m band, which
is why the ratio should be tuned rather than set to the coarse value.

### 2. `leavesL1` and `coarseLeavesL2` are never gated: 32 leaf draws every frame at ~5–18 instances each
**Evidence (read from a capture + counted in code).** All four plants-on captures show
`leavesL1 = 16` and `coarseLeavesL2 = 16` in `context.scene.byOwner`, while `leavesL0` falls to
6–9 in three of them. The gate (`forest-gpu.js:1005-1026`) is per (variant, rung) presence, and
with 16 variants spread over 90 + 287 trees every variant is always present in the wide bands.
Per-draw occupancy is 5.6 and 18 instances (arithmetic). Entry 0's `Scene` spends 12.1 ms of
13.8 ms exclusive in `encodeMs` across 220 draws, and no single leaf row exceeds 0.3 ms — the
signature of many cheap objects rather than a few expensive ones.
**What would confirm it.** A per-role draw/encode split in the trace (currently only top-12 rows),
or an A/B that consolidates the two wide leaf rungs across variants the way `branchesL2` was
consolidated — but see §4(b): that result does not transfer on its own, so this needs its own
measurement, and the alpha-tested leaf material plus per-variant geometry make it a harder merge
than bark was.

### 3. `leavesL0` / `shadowL0` / `leafShadow` are `DoubleSide` with a custom `normalNode`
**Evidence (counted in code).** `forest-gpu.js:764,785` — `leafMat` and `leafShadowMat` are
`makeMat(1.0, true)`. The file's own comment (`:746-757`) says LOD0 keeps DoubleSide deliberately
because leaf cards are genuinely single-sided quads and backface gaps show up close. Two facts
sharpen the trade: (a) `doubleBillboard: true` (`trees.js:60`) already gives every leaf a second
perpendicular card, so the gap is a ~90° wedge, not a hemisphere; (b) each material sets its own
`normalNode` (`:772,787`), and three does not apply its automatic back-face normal flip to a
custom `normalNode`, so today's DoubleSide back faces are already lit with the front normal — the
"two-sided shading" DoubleSide is being paid for is not actually being delivered. Fixing shading
with `faceDirection` and moving to FrontSide, or keeping DoubleSide only for `leafShadow` (where
the shadow map genuinely wants both faces), are both on the table.
**What would confirm it.** This is a **fragment-stage** claim and §4 says no evidence for it
exists. It needs a `?gputime=1` A/B at a fixed camera with the L0 leaf materials flipped to
FrontSide, plus a screenshot pair at 5–20 m to judge the canopy. Base Game has no
`perfAB` host, so the toggle would have to be added as a diagnostic.

### 4. Alpha-tested overdraw from large leaf cards
**Evidence (arithmetic + counted in code, no GPU measurement).** Every leaf material is
`alphaTest 0.5`, `transparent false`, `depthWrite true` (§2) — so each card's fragments run the
full `MeshStandardNodeMaterial` shade before the discard, and overlapping cards cannot be
early-Z'd against each other reliably. Card sizes are large in world units (§1): up to
4.5 m × 2.7 m at scale 1 for oak_large, ×0.55 instance scale, and the LOD2 coarse cards are
`×2.5` linear = **6.25× the area each**. Card counts (arithmetic, entry 0): ~81,000 `leavesL1`
cards from 90 trees and ~111,000 coarse cards from 287 trees. Entry 0's `Render Pipeline` is
20.1 ms against a `Scene` CPU-exclusive 13.8 ms; entry 1's is 31.1 ms against 30.5 ms — the gap
between the two captures is exactly the kind of thing a fragment-bound frame produces, but this is
suggestive, not evidence.
**What would confirm it.** `?gputime=1` captures at a fixed camera, first as-is, then with
`setLeafScale` reduced (already exposed, `forest-gpu.js:1410`) as a pure-area diagnostic, and then
with resolution halved. If GPU pass time tracks card area rather than card count, it is overdraw;
if it tracks count, it is vertex/submission.

### 5. `leafShadow` casts from within 90 m regardless of the view cone
**Evidence (counted in code + read from a capture).** The shadow slot is written before the cone
test (`forest-gpu.js:379-390`), so every tree within `SHADOW_REACH = 90` casts, including the 284
(entry 0) the cone rejected. That is correct for shadows and should stay. What is measurable is
that leaf shadows are 16 of the sun pass's 32 draws and every named row in that scene is a forest
shadow row, in a pass costing 3.5 ms (entry 0) / 5.5 ms (entry 1). The geometry is already the
reduced 30% bucket (`variant.shadow`, 781.8 mean triangles) — so the *geometry* is not the
overweight part; the 16 draws and the DoubleSide alpha-tested material are the parts worth
measuring.
**What would confirm it.** A shadow-pass GPU timing, plus a capture field for the shadow-slot
instance count (currently absent — `flora.trees` has `lod0/lod1/lod2` but no shadow count), so the
per-caster cost can be separated from the per-draw cost. A `treeLeafShadows` off/on pair is the
diagnostic that bounds the whole role's cost; it is not the remedy.

### 6. Per-leaf-vertex sway is on for every leaf role
**Evidence (counted in code).** All four leaf materials build their `positionNode` with
`sway = true`; branch materials do not (`forest-gpu.js:760-762,783`). `swayed()` is two `sin()`
per vertex (`:517-522`), and `treeLeafSway` defaults to 1. Vertex count is meaningful: mean
`leaves` alone is 1808 triangles ≈ 3616 vertices per variant, and `leavesL1` runs that on the
full geometry (candidate 1) at 90 trees. This is the smallest of the six and is listed for
completeness.
**What would confirm it.** `?gputime=1` with `setLeafSway(0)` at a fixed camera. Ranked last
because two `sin()` per vertex is cheap next to the fragment work in candidate 4, and turning sway
off changes the canopy's look, so any win has to be large to be worth chasing.

---

### Gaps in the evidence, stated plainly

- No per-role GPU timing exists anywhere in this log. Candidates 3, 4 and 6 are unmeasured.
- No shadow-slot instance count is captured, so the leaf shadow caster population is unknown.
- `topBindings`/`topNodes` cap at 12 rows per scene covering ~33–52% of their stage, so per-role
  CPU attribution beyond "spread thin across 80 objects" is not available.
- `flora.trees.triangles` is the page's own arithmetic, not a measurement, and excludes shadows.
- The 8-species selection in the captures comes from `base-game-default-state.json`, not from
  `DEFAULT_BASE_GAME_TREE_SPECIES` (3 species) in code; a session that loaded neither would have a
  different palette and different numbers throughout.
