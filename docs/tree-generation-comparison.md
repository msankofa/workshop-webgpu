# Procedural Tree Generation — `workshop-webgpu` vs. fable5-world-demo

A side-by-side of how the two codebases grow trees. Ours lives in `trees.js` (+ `forest-gpu.js`
for instancing); the demo lives in `src/vegetation/` (TreeBuilder, Skeleton, Species, LeafMesh,
TubeMesh, Impostors, …). Source read directly on 2026-07-04, not from docs.

## TL;DR

Both grow a **recursive tube skeleton with wander + a growth-direction bias, then attach
foliage and merge into a few meshes.** The shared DNA is real — ours is explicitly "in the style
of dgreenheck/ez-tree," and the demo is the same lineage taken several steps further.

The gap is one of **botanical fidelity and LOD ambition**, not core approach:

- **Foliage is the biggest divergence.** Ours is **billboard leaf cards** (quads, atlas cells, or a
  flat silhouette polygon). The demo builds **real leaf and needle meshes at LOD0** — a folded/curled
  4-row leaf strip (~18 tris each) and a needle spray (a drooping stem with dozens of individual
  needle quads in comb/brush arrangement) — and only falls back to captured cards at distance.
- **The demo's skeleton is a fuller SpeedTree-style grammar**: crown-envelope shaping, whorled *and*
  golden-angle phyllotaxis, planar bough plates, cantilever droop + tip-curl, light-competition
  asymmetry, and age-driven density. Ours has wander + a single force vector + per-level angle.
- **Per-instance uniqueness**: ours varies seed/size/yaw/variant; the demo gives every tree its own
  lean, crown-asymmetry bias, and age that reshape the actual branch structure — matching the LAAS
  "per-instance growth seed" floor.
- **LOD**: ours ends in a **single flat billboard**; the demo captures **octahedral impostors**
  (8×8 hemi-oct views, albedo+normal+depth atlases) per the spec.
- **Structural realism rule** the demo enforces and we don't: *foliage never sits on primary
  branches* — every species grows a fine twig/branchlet level and leaves attach only there.

Net: same skeleton idea; the demo is a higher-fidelity, LOD-complete, botanically-parameterized
superset. Ours is a lean, well-optimized single-file generator that is genuinely good at what it
does but stops at billboard leaves and a flat impostor.

---

## 1. Provenance & architecture

| | **workshop-webgpu** (`trees.js`) | **fable5-world-demo** (`src/vegetation/`) |
|---|---|---|
| Lineage | Explicitly "in the style of dgreenheck/ez-tree" | SpeedTree-style parametric grammar (own impl) |
| Language / renderer | JS, three.js `MeshStandardMaterial` (WebGL-era) | TypeScript strict, `three/webgpu` + TSL node materials |
| File shape | One ~455-line class `Tree extends THREE.Group` | ~14 modules: `TreeBuilder`/`Skeleton`/`Species`/`LeafMesh`/`TubeMesh`/`FoliageCards`/`Impostors`/`Deadfall`/`Dressing`/… |
| Determinism | mulberry32 RNG from `seed` | `Rng` streams with `.fork('tubes'|'foliage'|…)` sub-seeds |
| Output | 3 merged meshes: branches, leaves, leavesShadow | `BuiltTree { bark, foliage(cards), foliageMesh(real), skeleton, stats }` |
| Instancing | `forest-gpu.js`: CPU placement → GPU cull → indirect draw | scatter/streaming layer (separate subsystem) |

## 2. Skeleton / branching

**Ours (`trees.js:_generateBranch`, `_spawnChildren`)**
- Breadth-first queue; each branch is a tapered swept tube of `sections` rings × `segments` sides.
- Growth direction per section = **wander** (`gnarliness`, scaled by 1/√radius so thin branches wiggle
  more) + bend toward a single **force direction** (`force.strength`, e.g. up for phototropism) +
  optional constant **twist**.
- Children: stratified height slots along the parent (`branchStart`→1), stratified azimuth with jitter,
  fixed tilt `angle` per level, radius = min(cap, parentRadius·0.85). Length jittered ±20%.
- Per-level arrays index everything: `length/radius/taper/children/angle/gnarliness/sections/segments`.

**Demo (`Skeleton.ts:growBranch`)**
- Recursive (depth-first) polyline growth; each segment updates direction with:
  - **wander** = `sin(t·freq+phase)·wob + random` on both perpendicular axes (per-branch phase/freq so
    siblings decorrelate),
  - **gravitropism** (up/down tropism, weaker on laterals, ramps with `t`),
  - **cantilever droop** accumulating toward the unsupported tip + a **tip-curl** that opposes it late,
  - **trunk lean** from the per-instance `leanX/leanZ`.
- Children placed by **phyllotaxis**: `whorl≥2` → whorled rings; else **golden-angle spiral**; `planar`
  → two-sided in the bough plane (spruce boughs, beech plates). Count = `len·span·density·ageScale`.
- Child length shaped by a **crown envelope** (`cone|ellipsoid|dome|column|irregular`) × a
  **light-competition asymmetry** (`asym·(dir·bias)`) — trees lean their mass toward "light."
- Emits **foliage anchors** only at `foliage.anchorLevel`, spaced along the twig, each with a full
  orientation quaternion (z=outgrowth, twisted toward world-up), hue, and age.

**Delta:** the demo models tropism, droop, phyllotaxis, crown shape, and light competition as
first-class parameters; ours folds all directional behavior into `gnarliness` + one `force` vector +
a fixed per-level `angle`. Ours is cheaper and easier to reason about; theirs produces species-correct
silhouettes.

## 3. Foliage — the biggest divergence

**Ours (`_spawnLeaves`, `_leafQuad`, `_leafShape`)**
- **Billboard cards.** Each leaf is a quad (`_leafQuad`) sampling an atlas cell, or a **textureless
  silhouette polygon** (`_leafShape`, an 8-point leaf outline) for asset-free mode.
- `doubleBillboard` → two perpendicular quads per leaf. `roundedNormals` bends leaf normals outward so
  the canopy lights as a volume rather than flat cards.
- `shadowFraction` splits leaves into a cast-shadow mesh and a no-cast mesh (billboards are muddy in
  shadow, so default 0 cast).
- Placed on outer branch levels via `leaves.spread`/`start`/`count`.

**Demo (`LeafMesh.ts`, `TreeBuilder`)**
- **Real geometry at LOD0.** `buildLeaf` = a 4-row strip folded along the midrib and curled toward the
  tip (~18 tris), with a petiole; `buildNeedleSpray` = a drooping stem strip + `needleCount` single-quad
  needles arranged **comb** (flat ±rows filling the bough plane) or **brush** (radial).
- Foliage **mode** per build: `cards` (captured atlas), `mesh` (real leaves), or `hybrid` (hero: both).
- Vertex data carries **hue / sway-flex / sway-phase / AO** per vertex for wind + crown-depth shading.
- `bendNormals(crownCenter, crownRadius)` + `crownAO` post-process the whole canopy so it reads as a
  lit volume with interior darkening.
- Anchors thinned to card/mesh **budgets** with survivor enlargement to hold coverage (a forest beech
  is ~24k anchors → strided hard for rings).

**Delta:** we render leaves as sprites; they render leaves as **meshes** (Pillar A "grass is blades,
litter is meshes, leaves…"), reserving cards purely as a distance LOD captured *from* those meshes.

## 4. Species & per-instance variation

**Ours:** `trees.js` ships one `DEFAULTS` parameter set; `forest-gpu.js`'s palette bakes up to ~8
species variants. Per-instance variation = seed + size + yaw + which baked variant. Real, but the
*structure* of a given variant is fixed once baked.

**Demo (`Species.ts`):** six hand-authored presets with botanical intent — **spruce** (whorled cone,
up-hooked tips), **mountain pine** (dome, 4-level, needles on rising twiglets), **beech** (ellipsoid,
distichous twig plates), **birch** (column, weeping streamers), **karst gnarl** (irregular cliff tree,
high wander/asym), **snag** (dead, `brokenTop:0.62`, high `stubChance`, no foliage). Every tree also
gets a `GrowthInstance` — `leanX/leanZ`, a crown-asymmetry `bias` direction, and `age` (scales height
and child density) — so **branch structure itself is unique per instance**, not just transform.

This is the LAAS "≥6 species × per-instance uniqueness (own growth seed, lean from slope/wind, crown
asymmetry from light competition)" floor, implemented literally. Ours partially meets it via variant +
transform jitter.

## 5. Bark, decay, and dressing

| Feature | Ours | Demo |
|---|---|---|
| Tube/bark | tapered tube, UV wraps ~thickness | `TubeMesh` with **root flare** (amp/height/lobes), bark repeats, `crownAO` |
| Broken/dead | — | `brokenTop` (snag), `stub` branches, `stubChance` decay |
| Twig-level rule | leaves can sit on any outer level | **foliage only on the finest twig level** (enforced) |
| Companion assets | trees only | `Deadfall`, `Dressing` (moss/vines), `GroundRing`, `Understory`, `RockBuilder` in the same subsystem |

## 6. LOD & impostors

**Ours (`forest-gpu.js`):** 4 LOD rungs — L0 branches+leaves+shadow, L1 branches+leaves, L2
branches+coarse-leaves, **L3 a single 6-index flat billboard**. GPU cull is **distance-only** (no
frustum, no occlusion, per `forest-cull.js`), compacted into per-variant indirect draws.

**Demo:** ring LODs **drop tube levels below the anchor level** (the cards own that level, so its tubes
are pure waste) and thin foliage cards to budgets with survivor enlargement. Distance terminus is a
**captured octahedral impostor** — `Impostors.ts`, 8×8 hemi-octahedral views, each rendered 3× into
albedo / world-normal / linear-depth atlases, blended across the 3 nearest views at runtime. This is
the spec's "octahedral impostors (≥8×8 views, albedo+normal+depth)" floor; ours is a flat quad.

## 7. Feature matrix

| Capability | workshop-webgpu | fable5-demo |
|---|---|---|
| Recursive tube skeleton | ✅ | ✅ |
| Seeded determinism | ✅ (mulberry32) | ✅ (forked Rng streams) |
| Wander / gnarliness | ✅ | ✅ (sin+random, per-branch phase) |
| Phototropism / gravitropism | ✅ single force vector | ✅ tropism + droop + tip-curl |
| Phyllotaxis (whorl/spiral/planar) | ❌ (stratified slots) | ✅ |
| Crown-envelope shaping | ❌ | ✅ (5 shapes) |
| Light-competition asymmetry | ❌ | ✅ |
| Per-instance structural uniqueness | ⚠️ variant + transform | ✅ lean/bias/age reshape branches |
| Real leaf/needle meshes | ❌ billboard cards only | ✅ (cards are the LOD, not the base) |
| Canopy volume shading (normal bend + AO) | ✅ roundedNormals | ✅ bendNormals + crownAO |
| Wind data per vertex | ❌ (no tree wind) | ✅ (flex/phase in vertex data) |
| Species presets | ⚠️ ~8 baked variants | ✅ 6 botanical presets |
| Decay states (snag/broken/stubs) | ❌ | ✅ |
| Root flare | ❌ | ✅ |
| Octahedral impostors | ❌ (flat billboard) | ✅ 8×8 albedo+normal+depth |
| GPU instanced cull + indirect draw | ✅ (distance cull) | ✅ (+ meshlet direction) |
| Companion dressing (deadfall/moss/understory) | ❌ | ✅ same subsystem |

## 8. What's worth borrowing (highest value first)

1. **Real leaf/needle meshes at LOD0** (`LeafMesh.ts`) — the single biggest fidelity lever; our
   billboard cards are the Pillar-A failure. Cards become a capture-based distance LOD, not the base.
2. **Per-vertex wind data (flex/phase)** — unblocks tree wind (Pillar F), which our trees entirely lack.
3. **Per-instance `GrowthInstance` (lean/bias/age)** reshaping the skeleton, not just the transform —
   cheap to add on top of our existing seed and directly satisfies the per-instance-uniqueness floor.
4. **Phyllotaxis + crown envelopes** for species-correct silhouettes.
5. **Octahedral impostor capture** to replace the flat L3 billboard for distance-holding (Pillar D).
6. **The "foliage only on the finest twig level" rule** — a one-line structural discipline that makes
   canopies read as botanical rather than leaves-glued-to-sticks.

Our generator's strengths to keep: single-file simplicity, aggressive scratch-object reuse (no GC
spikes on forest rebuild), the cast/no-cast leaf split, and the working GPU instancing/indirect-draw
pipeline in `forest-gpu.js` — that pipeline is a fine host for higher-fidelity geometry.
