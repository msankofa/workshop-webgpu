# Understory & Surface Dressing — `workshop-webgpu` vs. fable5-world-demo

Companion to `tree-generation-comparison.md`, covering the **plants, moss/lichen/vines, and
fungi/deadfall** layers — i.e. LAAS Pillar C "Nothing is bare." Ours lives in `plants.js` /
`plants-placement.js` / `plants-gpu.js` / `grass*.js` / `terrain-textures.js`; the demo's is spread
across `src/vegetation/` (Understory, GroundCover, Dressing, Deadfall, GroundRing, RockBuilder,
VegLibrary) plus `src/render/{TerrainMaterial,VegMaterials}.ts`. Read directly on 2026-07-04.

> **Honesty note carried from the audit:** the demo is *not* uniformly finished here either. Its
> moss/lichen/wet-margin **shader tint** is live everywhere, but its **vine and standalone-mushroom
> geometry** exist only in a debug gallery scene — never wired into world placement — and the demo's
> own `STATUS.md` lists "geometric wall plants, moss volume geo" as carried debt. Where a demo feature
> is gallery-only, this doc says so, so we don't over-borrow a primitive that isn't actually shipped.

## TL;DR

- **Plants:** both are schema-driven (species = data over a shared preset). Ours has 4 flowering herbs
  with flat fan-triangulated leaf cards and startup-baked variants; the demo reuses its *tree growth
  grammar* for multi-stem shrubs, adds ferns + real petal geometry, and enforces a systemic per-instance
  hue/age/dryness law. Closest of the three layers — but ours lags on variation and shrub/fern classes.
- **Moss / lichen / vines:** **existence gap, not a fidelity gap.** We have *zero* code for moss,
  lichen, vines, dirt streaks, or wet-margin darkening — only a 2-band slope→material texture swap. The
  demo has a mature moisture+normal(upness)+cavity-driven **shader** dressing system across rock,
  deadwood, and terrain. (Its vine/mushroom *geometry* is gallery-only.)
- **Fungi / deadfall:** **entirely absent on our side** — no logs, stumps, snags, mushrooms, decay
  states, or litter rings (`tree-age.js` models *growth*, not decay, and isn't even wired into
  placement). The demo has logs/stumps with `fresh/mossy/rotten` states + a snag tree species, all
  density-scattered; mushroom geometry exists but standalone caps are gallery-only (shelf fungi on logs
  are live).

The unifying lesson: the demo's dressing is powered by **one shared per-vertex data channel**
(upness / moss-openness + cavity/AO baked at generation time) that every material reads the same way —
`smoothstep(moisture or upness) × noise × cavity`. It's a reusable pattern, not N bespoke shaders.

---

## 1. Plants / understory

**Ours** (`plants.js` 389 ln, `plants-placement.js`, `plants-gpu.js`)
- 4 presets — chickweed, cleavers, mint, jewelweed — as overrides on one `PLANT_DEFAULTS` schema
  (`plants.js:9-38, 55-93`). Species = data, no bespoke per-species geometry code.
- Geometry (`buildPlantGeometry:303`): one vertex-colored indexed mesh = stem random-walk path + leaves
  (fan-triangulated from a parametric oval/lance/star envelope with sawtooth serration) + flowers (one
  shared petal-cluster builder for all 4 flower shapes). Leaves are **flat cards** (no fold/curl).
- Variation: baked at startup — `createPlantPalette` bakes `variantsPerSpecies` (4) fixed geometries per
  species; at placement only **scale (0.85–1.15) and yaw** vary. No hue/age/dryness jitter.
- Placement: biome-allowlist + density weight; optional `clusterStrength`/`clusterScale` value-noise
  bias (default 0 = uniform). Clumping is opt-in, not structural.
- Instancing: `plants-gpu.js` reuses the `forest-gpu` reset→cull→finalize→indirect-draw compute spine;
  single distance-cull band, no LOD, dither fade near cull radius. **This pipeline is a real strength.**

**Demo** (`Understory.ts`, `GroundCover.ts`, `VegLibrary.ts`, `LeafMesh.ts`)
- 3 shrub species (`BUSH_HAZEL`, `BUSH_PINKFLOWER` = the spec's pink shrub, `BUSH_JUNIPER`) built as
  **multi-stem instances of the full tree growth grammar** (`buildTree` + `SpeciesParams`), not a
  separate small-plant generator. Plus ferns (rosette of captured frond sprays) and 3 flower kinds
  (umbel/bell/daisy) as **real petal geometry** with per-part `vdata` tagging.
- Leaves/needles are **real 3D meshes** (`LeafMesh.ts`: folded/curled 4-row strip; needle spray) →
  captured into atlas cards for distance LOD. Real mesh→card LOD chain; ours has none.
- Grass (`GroundCover.ts:grassPatch`): **parent-clump/child-blade** sampling (`sqrt(rng)·radius`) baked
  into the placement math — light-competition clumping by default. Per-blade `idata` (hue, dryness, sway
  phase, height) drives fresh↔dry albedo + translucency. Plus a twig / bark-chip / leaf-litter debris tier.
- Per-instance law is systemic: `variantInstance()` rolls lean + crown-asymmetry bias + age per variant;
  `LeafAnchor` carries per-leaf hue/age; species carry `foliageColor.hueVar` + optional `blossom`.

**Deltas:** ours is one clean small subsystem meant to dress a scene; theirs is a full ecosystem tier
with shrubs, ferns, flowers, debris — each a separately-modeled population — under an enforced variation
law. Starkest single gap: **per-instance hue/age/dryness** (ours varies only scale+yaw).

## 2. Moss / lichen / vines / surface dressing

**Ours** — grep for `moss|lichen|vine|dressing` = **zero hits**. The only surface logic is
`terrain-textures.js:fallbackMaterialAt` (`:178`): a 2-band slope pick (`slope>0.58→rock`, `>0.34→dirt`)
+ sea-level sand override, then `classifyMesh` buckets triangles into 13 flat named texture layers with
a hard triangle-granularity boundary. No moisture, cavity, AO, tint, or blend. No rock/boulder geometry
subsystem exists to host dressing. This matches our own roadmap self-score (Pillar C 1.5/10).

**Demo** — dressing is a shader system keyed off baked geometry data, live across three surface classes:
- `RockBuilder.ts` bakes a per-vertex `vdata.z` = moss/lichen **openness ≈ upness** and a cavity/AO
  channel into the displaced-icosphere rock at build time (`:8-9, 229`).
- `VegMaterials.ts:rockMaterial` (`:125`): moss by upness×`vdata.z`, lichen patches on exposed faces,
  dust on up-faces, **dirt streaks bleeding down steep faces** (gated by `1-upness`); roughness tracks
  moss amount.
- `TerrainMaterial.ts`: lichen splotches on rock (`:183`), litter→moss blend by **moisture** (`:205`),
  a **gorge/ravine wall-greening** term (hanging-veg fbm bands + ledge-clump pockets, gated by
  slope/moisture/elevation, `:277`), and **wet-margin darkening** on shores by moisture/riverDepth
  (`:294`). This is the spec's "cliffs → moss by moisture+normal … boulders → crevice AO, moss caps,
  lichen tint" implemented almost verbatim.
- Real **vine** geometry (`Dressing.ts:buildVines` — swaying sagging strand tubes + leaf cards) and
  standalone **mushroom** caps exist but are **gallery-only** (called only from `GalleryScene.ts`, never
  from `Forests.ts`). Root flare (per-species `flare` param) and the `GroundRing.ts` litter/debris
  carpet (≥80k instances) *are* live.

**Delta:** categorical. We buckets whole triangles into discrete textures; they blend per-pixel from
layered noise × moisture × upness × cavity. Porting "just add moss" means moving terrain/rock onto TSL
node materials — infrastructure we already use in `post-fx.js`/`clustered-lights.js` but haven't applied
to terrain.

## 3. Fungi / deadfall / decay / litter rings

**Ours** — grep for `fungi|mushroom|deadfall|snag|stump|log|litter|decay|rot` = **zero source hits**
(only prior-analysis docs). `tree-age.js:applyAge` interpolates sapling→mature **growth** only — no
dead/broken/rotten state, and it isn't wired into game placement. No logs, stumps, snags, mushrooms,
root flare, or litter rings anywhere. **0/10 on every axis here.**

**Demo** (`Deadfall.ts`, `Species.ts` SNAG, `Dressing.ts`, `GroundRing.ts`, `Scatter.ts`)
- `buildLog(decay)` — sagging capped tube; `rotten` gets collapsed cross-section (`squish=0.72`) +
  steeper taper; decay writes a per-vertex `vdata.z` moss/rot weight (`fresh 0.15 / mossy 0.8 /
  rotten 1.0`) that `deadwoodMaterial` reads for moss-on-upface shading.
- `buildStump` — short tube with explicit **root flare** (`amp/height/lobes`).
- **Snag** = a full 6th tree *species* built by the same grammar with `brokenTop:0.62` + `stubChance:0.28`
  (dead = different knobs, not a new asset).
- Deadfall is density-scattered (`Scatter.ts:614`): moisture→decay class, canopy→occurrence weight,
  slope>0.5→reject logs. Shelf fungi live on logs via the decay system.
- `buildMushroom` (cap = lathed dome+gill+stem; shelf = trunk-mounted half-cap) is **real geometry** but
  standalone caps are **gallery-only** (no `Mushroom` slot in the scatter enum). "Litter ring" is
  emergent from canopy-weighted `GroundRing` debris density, **not a discrete per-trunk primitive** even
  in the demo — don't over-borrow it.

## 4. Feature matrix

| Capability | workshop-webgpu | fable5-demo |
|---|---|---|
| **Plants** | | |
| Schema-driven species (species = data) | ✅ 4 herbs | ✅ shares tree grammar |
| Real folded/curled leaf & petal mesh | ⚠️ flat fan cards | ✅ |
| Real mesh→card→impostor LOD chain | ❌ single LOD | ✅ |
| Shrub class | ❌ | ✅ 3 (multi-stem grammar) |
| Ferns | ❌ | ✅ |
| Structural grass clumping (default) | ⚠️ opt-in noise knob | ✅ parent-clump/child-blade |
| Per-instance hue/age/dryness jitter | ❌ scale+yaw only | ✅ systemic |
| Per-variant lean/crown-asym uniqueness | ❌ reseed only | ✅ `variantInstance()` |
| GPU cull + indirect-draw pipeline | ✅ | ⚠️ shared engine scatter |
| **Moss / lichen / vines** | | |
| Moisture-driven moss/litter blend | ❌ | ✅ |
| Moss by normal/upness on rock | ❌ | ✅ |
| Lichen tint/speckle | ❌ | ✅ |
| Dirt streaks on steep faces | ❌ | ✅ |
| Cavity/AO-driven dressing | ❌ | ✅ (baked vdata) |
| Cliff/gorge wall greening | ❌ | ✅ |
| Wet-margin darkening | ❌ | ✅ |
| Hanging vine geometry | ❌ | ⚠️ built, gallery-only |
| Rock/boulder generator (dressing host) | ❌ | ✅ `RockBuilder.ts` |
| **Fungi / deadfall** | | |
| Logs with decay states | ❌ | ✅ fresh/mossy/rotten |
| Stumps with root flare | ❌ | ✅ |
| Snag (dead tree) species | ❌ | ✅ |
| Decay→material coupling | ❌ | ✅ vdata.z |
| Mushroom geometry | ❌ | ⚠️ shelf live, caps gallery-only |
| Deadfall density-function placement | ❌ | ✅ moisture/canopy/slope |
| Root flare at tree bases | ❌ | ✅ per-species |
| Litter ring / debris carpet | ❌ | ✅ `GroundRing` (⚠️ ring is emergent) |

Legend: ✅ live · ⚠️ partial / built-but-gallery-only · ❌ absent

## 5. What to borrow (ranked, highest value first)

1. **Per-instance hue/age/dryness jitter at placement** — cheapest, highest-impact plant fix. Add a
   `hue`/`dryness` float per record and a small TSL color mix; turns 4 clone variants into a
   continuously-varied population at ~zero geometry cost. (Mirrors `LeafAnchor.hue` / `idata`.)
2. **Moisture/normal-driven moss+lichen tint on the terrain splat** — kills the "2-band hard swap"
   complaint with no new geometry. Moisture already exists in `biome-classifier-js.js`; blend moss-green
   into forest/taiga/swamp by moisture×upness (mirrors `TerrainMaterial.ts:205`). Requires moving terrain
   onto a TSL material — infra we already have elsewhere.
3. **Rock/boulder generator + baked upness/cavity `vdata` channel** — we have *no* rock geometry at all;
   a `RockBuilder.js` twin gives both crag geometry (Pillar A/D) and a host for the moss/lichen/dirt-streak
   shaders in one step. This is the single highest-leverage new subsystem for Pillar C.
4. **Log/stump generator with decay states** — reuse `trees.js`'s tube-mesher for a sagging capped log +
   flared stump; a `decay: fresh|mossy|rotten` param perturbs taper/squish and writes a moss/rot weight
   into the per-vertex color channel plants/trees already bake. Add a **snag** preset (foliage-off,
   broken-top) to the forest species table — dead trees for free from the existing grammar.
5. **Density-function deadfall/dressing placement** — extend `forest-placement.js`/`plants-placement.js`'s
   existing biome/density RNG draw with Log/Stump/mushroom classes keyed on moisture (decay) + canopy
   proximity + slope rejection (mirrors `Scatter.ts:614`).
6. **Structural grass/plant clumping as default** (parent-clump/child-scatter, `grassPatch` pattern) and
   **root flare** on trunks (`flare:{amp,height,lobes}`) — both cheap, both read far more natural.
7. **Vine/mushroom geometry** (`Dressing.ts`) — lowest priority: even the demo left these gallery-only.
   If pursued, actually close the placement gap they left (detect overhangs/tree-bases at scatter time).

**Keep from ours:** the `plants-gpu.js` / `forest-gpu.js` compute cull + indirect-draw pipeline, the
schema-driven preset architecture, and the cast/no-cast + dither-fade patterns — all are solid hosts for
the higher-fidelity content above.
