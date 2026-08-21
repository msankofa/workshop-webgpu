# Fable5-Inspired Forest Features Design

Date: 2026-08-21

## Context

`research/fable5-world-demo-main.zip` is a reference WebGPU/TSL Three.js project (r0.184-family
stack, same as `environment-viewer.html`) whose forest/tree system was compared against ours
(`trees.js` + `forest-gpu.js` + `forest-placement.js`) in conversation on this date. Both systems
independently converged on the same GPU architecture — reset→cull→finalize compute into
`IndirectStorageBufferAttribute`s, cone+far-cutoff rejection before any `atomicAdd`, dirty/threshold-
gated recull — so porting individual techniques is a targeted addition, not an architecture change.

Four fable5 techniques were judged portable without conflicting with our conventions (CPU-side,
Node-testable placement in `forest-placement.js`; worst-case-sized capped GPU buffers; the existing
live-toggle-uniform pattern already used by `uConeEnabled`/`grass-look.js`). A fifth technique
(GPU-side scatter placement, fable5's `Scatter.ts`) was judged a poor fit and is explicitly out of
scope — see "Out of scope" below.

This spec covers making the four techniques **in-game togglable**, not URL-flag-only, following the
precedent `forest-gpu.js` already set for `uConeEnabled` and `grass-look.js` set for its blade-look
features: a live `0/1` uniform read inside a shader `If` block, no shader recompile, registered
through `controlRegistry` so it participates in the existing slider-state-presets save/load system
(`slider-state-presets-shipped` memory) and is visible in MP world-settings sync where applicable.

## Findings

1. **No occlusion culling.** `forest-gpu.js`'s `cull` kernel (~lines 100-165) rejects by radial
   distance (`farLive`, line 143) and view cone (`coneLive`, line 160) only. A tree fully behind a
   ridge or cliff face still survives culling and submits a draw if it's in front of the camera and
   within radius — no terrain visibility test exists anywhere in the forest path.

2. **A shared baked height texture already exists and is unused by forest-gpu.js.**
   `environment-viewer.html:1372` (`bakeHeightTexture`) bakes a 512-resolution (`bakeRes`) height
   texture into `loadedMap.heightTex`/`loadedMap.heightTexBounds` (lines 1405-1406), already passed
   into `createComputeGrass()` as `heightTex`/`heightTexBounds` (lines 5446-5447) for grass's own
   procedural-vs-anchor height sampling. `forest-gpu.js`'s only height awareness is
   `opts.heightAt` (line 37), a **CPU** function called once per rebuild to place a tree's base Y
   (line 485) — there is no TSL height sampler in the forest compute path at all. Occlusion culling
   can reuse the same baked texture rather than adding a second bake.

3. **No shadow-specific proxy geometry.** Bark shadow casting is gated per-LOD by
   `renderParts.barkShadows`/`renderParts.leafShadows` booleans (`forest-gpu.js:458-459`), but when
   enabled, LOD1/LOD2 branches cast shadows using the **same full render geometry** used for color —
   there is no cheaper proxy substituted for the shadow pass. `variant.shadow` (the dedicated
   `shadowL0` mesh, line 68/392) already exists as a precedent for "separately-baked cheap shadow
   geometry," but only for LOD0 leaves, not for bark at any LOD.

4. **Billboards are single flat images, not multi-angle.** `forest-gpu.js`'s L3 tier
   (`billMat`, line 366; `applyBillboardMap`, line 632) is one camera-facing plane sampling one
   texture per variant, cylindrically aligned via `instanceNodesBillboard`. There's no per-angle
   capture — a tree looks visually different close-up vs. from its billboard angle, and the
   billboard silhouette doesn't rotate correctly as the camera orbits.

5. **No branch flare, buttress, or broken-tip detail.** `trees.js`'s radius taper
   (`trees.js:252-258`) is pure linear/evergreen taper along each branch's length; the trunk base and
   branch tips are closed only by pinch-to-`TIP_RADIUS` (line 258) or a flat `_capRing` disc
   (line 335) — no root-flare lobing or jagged broken-branch caps exist as an option.

6. **The toggle mechanism already exists and is proven.** `uConeEnabled` (`forest-gpu.js:115`,
   flipped live at line 566-570 via `setConeEnabled`) and every `grass-look.js` node (sway/curl/
   coverage) follow the same shape: a `uniform(0/1)` read inside a TSL `If`, changed at runtime with
   no material rebuild. `controlRegistry` (see `slider-state-presets-shipped` in project memory) is
   the existing save/load/MP-sync layer new toggles should register through rather than inventing a
   new persistence path.

## Design

### D1. Heightfield occlusion cull — free live toggle

Add a `uOcclusionEnabled` uniform (default on) to the `cull` kernel. For each surviving instance
(after cone+far rejection, before LOD bucketing), raymarch a handful of samples between the camera
eye and the instance's canopy-top world position (`tree base Y + species height estimate`) against
`loadedMap.heightTex`/`heightTexBounds` (reusing findings #1/#2's existing texture — no new bake).
Reject if any sample falls clearly below the sampled terrain height by more than a small margin
(mirrors fable5's `Forests.ts` raymarch-occlusion test). On procedural (no-map) terrain, skip the
test (`uOcclusionEnabled` forced off) rather than adding a second procedural TSL height function —
matches `grass-compute.js`'s existing map-only/procedural-fallback split.

- **Where:** `forest-gpu.js` cull kernel, gated identically to the existing `coneLive`/`farLive`
  pattern; `createForestGPU(opts)` gains `heightTex`/`heightTexBounds` params passed from
  `environment-viewer.html` the same way `createComputeGrass` already receives them.
- **Cost class:** free live toggle — one more `If`-gated comparison per surviving instance, no
  geometry rebuild.
- **UI:** perfAB panel, next to `'Forest frustum cull'` — `'Forest occlusion cull'` toggle. Also
  register a `controlRegistry` entry (`forestOcclusionCull`) so it round-trips through
  slider-state-presets even though its home is the debug panel, consistent with how the cone toggle
  is treated today.
- **Acceptance:** trees fully hidden behind a ridge/cliff from the camera's position stop submitting
  draws with the toggle on; toggling it off restores current (pre-change) behavior exactly; no
  popping of trees that are only partially occluded (a conservative margin errs toward keeping them
  live).

### D2. Shadow crown-proxy — bake-once, live toggle switch

Bake one extra, very cheap "shadow proxy" mesh per baked tree variant in `forest-palette.js` — a
tight icosahedron-ish crown blob + a trunk prism, sized from the variant's bounding box, roughly
matching fable5's `Forests.ts` crown-proxy shape. This is resident alongside the existing LOD1/LOD2
geometry (small triangle count, cheap to always bake and hold).

A live toggle then switches which geometry `castShadow` targets for LOD1/LOD2 bark: full branch
geometry (current behavior) vs. the new proxy. Because both meshes already exist as separate
`THREE.Mesh` instances in the `meshes[]` array (per drawMesh call), the toggle is just flipping
`castShadow` booleans on the pair — same complexity as the existing `renderParts.barkShadows` gate,
no shader/uniform involved.

- **Where:** `forest-palette.js` (new proxy geometry in `createForestPalette`'s per-variant bake
  loop), `forest-gpu.js` (one new proxy mesh per variant per LOD1/LOD2, `drawMesh(...,
  castShadow=false)` initially, flipped by the toggle alongside disabling the full-geometry mesh's
  `castShadow`).
- **Cost class:** rebake required only once at palette construction (proxy always baked
  alongside existing geometry); the toggle itself is a live `castShadow` flip, not a rebuild.
- **UI:** inline Forest quality section in `environment-viewer.html` (this is a visual-quality
  trade-off, not a perf-debug knob) — `'Cheap tree shadows'` checkbox, `controlRegistry` key
  `forestShadowProxy`, defaulting to on for CSM cascade 2+ workloads matching fable5's rationale
  (closed real canopy transmits ~2-5% light at noon; hollow LOD1/2 geometry leaks much more, washing
  out PCSS contact shadows under trees).
- **Acceptance:** toggling on visibly darkens/tightens shadow contact under distant tree clusters
  without changing color-pass geometry; toggling off restores current shadow behavior exactly; no
  extra per-frame cost when off beyond the boolean check already present.

### D3. Branch flare / broken-tip caps — rebake-on-toggle

Add two new **species-level** shape options to `trees.js`, off by default (so the default preset
library renders byte-identical to today):

- `trunkFlare` (0 = current behavior): multiplies the trunk's base rings' radius by
  `1 + trunkFlare * cos(lobes * angle)` for the bottom fraction of the trunk's height, i.e. root
  buttress lobing, mirroring fable5's `TubeMesh.ts` cosine-lobe modulation.
- `brokenTipChance` (0 = current behavior): reuses `trees.js`'s existing `stubChance` concept
  (already present per `Species.ts` comparison notes) but changes the terminal-tip closure from a
  clean pinch (`TIP_RADIUS`, line 258) to a jagged multi-point cap for the rolled branches, instead
  of `_capRing`'s flat disc (line 335).

Because these change baked geometry, not shader state, a live in-game toggle means the palette must
be rebuilt on flip — identical cost/UX to changing a species family today (`regenerateGPU()` already
runs on toolbar changes per `docs/subsystems/vegetation.md`'s "Zero-instance visibility gating &
debounced rebuild" section). No dual-bake-and-swap is proposed here (unlike D2/D4) because these are
species-authoring options a player would set occasionally, not something toggled every frame for
comparison — a short regeneration pause is acceptable.

- **Where:** `trees.js` (`DEFAULTS`, tube-generation loop `trees.js:252-258`, `_capRing`), consumed
  by `forest-palette.js`'s bake and `tree-viewer.html`'s per-species sliders (bonus: these become
  tunable there too, at no extra cost since `tree-viewer.html` already binds directly to `opts`
  paths).
- **Cost class:** rebake-on-toggle (one `regenerateGPU()`-equivalent pass), same as any other
  species-table change.
- **UI:** inline Forest quality section, `'Root flare'` / `'Broken branch tips'` checkboxes (or a
  single `'Detailed branch shapes'` toggle if kept simple), `controlRegistry` keys
  `forestTrunkFlare`/`forestBrokenTips`, wired through the same path as existing species-table
  toolbar controls so it already benefits from debounced rebuild.
- **Acceptance:** toggling produces a visible base-flare/broken-tip silhouette change after one
  regeneration pass; toggling off returns exactly to current geometry (byte-identical, since default
  values are 0/off); triangle budget increase stays within the existing "+87 tris/species average"
  ballpark documented for the current cap-fan feature, not an order of magnitude jump.

### D4. Octahedral billboard impostor — bake pipeline + live swap

Add a startup (or first-use) bake pass, one per baked tree variant: render the variant's LOD1
geometry from an 8×8 (or smaller, e.g. 4×4 to start — see Milestones) grid of hemi-octahedral view
directions into a small offscreen render target, composing albedo+world-normal into one atlas per
variant (skip the depth channel fable5 captures but explicitly doesn't use at runtime — no reason to
pay for it here either). This is genuinely new infrastructure (`forest-palette.js` currently only
bakes geometry, never renders to a texture), scoped down from fable5's full spec (no depth-parallax,
smaller grid, single combined atlas instead of two 2048² atlases) to keep bake time and memory
bounded for a per-session, non-shipped-asset bake.

At runtime, keep the existing flat-billboard mesh/material resident (current behavior, cheap, no
bake dependency) and add the new atlas-sampling billboard mesh alongside it per variant, exactly the
way D2 keeps both shadow geometries resident. The toggle swaps which billboard mesh has non-zero
`instanceCount` in the L3 tier's indirect draw (or simpler: both share one mesh, toggle swaps
`billMat`'s texture/node-graph the way `applyBillboardMap` already does — no second mesh needed if
the shader itself branches on a uniform to pick between "sample flat image" and "sample+blend nearest
2-4 octahedral tiles by view direction").

- **Where:** new bake step called from wherever `createForestPalette()` is invoked in
  `environment-viewer.html`; `forest-gpu.js`'s `billMat` gains the octahedral sampling/blending TSL
  graph behind a uniform branch, reusing `applyBillboardMap`'s existing texture-swap plumbing for the
  new atlas.
- **Cost class:** one-time bake pipeline (new), then a free live shader toggle once baked — matches
  D1/D2's "bake once, flip live" shape rather than D3's "rebuild-on-toggle" shape, since the bake
  only needs to happen once per palette (not per toggle-flip).
- **UI:** inline Forest quality section, `'Multi-angle tree billboards'` checkbox,
  `controlRegistry` key `forestOctaImpostor`, defaulting **off** until the bake pipeline is verified
  cheap enough for lower-end GPUs (bake cost is a one-time startup/palette-change hit — needs
  measuring before flipping the default).
- **Acceptance:** toggling on visibly improves billboard fidelity/consistency as the camera orbits a
  distant tree cluster; toggling off falls back to current flat-billboard behavior exactly; bake
  pass completes within a bounded time budget measured and logged (see Instrumentation) so it can be
  deferred/staggered like other palette work if too slow.

## UI / toggle architecture

- **Perf-flavored, debug-panel-native:** D1 (occlusion cull) goes in the existing perfAB panel next
  to the cone/far-cutoff controls it composes with — it's a culling correctness/perf knob, same
  category as what's already there.
- **Visual-quality, player-facing:** D2, D3, D4 go in the inline Forest section of
  `environment-viewer.html` (per `CLAUDE.md`'s note that `environment-ui.js` is a shell, not where
  sliders live — the real controls are built inline in the viewer). All three register through
  `controlRegistry` so they persist via the existing slider-state-presets localStorage system and
  participate in MP world-settings sync the same way other forest toolbar controls already do.
- **Naming convention:** `forest<Feature>` keys (`forestOcclusionCull`, `forestShadowProxy`,
  `forestTrunkFlare`, `forestBrokenTips`, `forestOctaImpostor`), matching the existing
  `forest*` CSV/stats field convention from the 2026-07-08 trees-performance design.

## Out of scope

- **GPU-side scatter placement** (fable5's `Scatter.ts`). Our placement is deliberately CPU-side and
  pure-JS (`forest-placement.js`) so `placementRecords()` is directly Node-testable and deterministic
  against authored biome maps/species tables. A GPU compute scatter can't be unit-tested the same way
  and would need to coexist with, not replace, biome-authored-species-table logic specific to this
  project. Treat as a separate future rewrite proposal if ever pursued, not a toggle.
- **Hybrid real-leaf-mesh at LOD0** (fable5's `LeafMesh.ts` + `FoliageCards.ts` texture-atlas bake).
  Mostly-cosmetic gain scoped to LOD0 only, needs its own render-to-texture bake step distinct from
  D4's impostor bake; parked until D4 proves the bake-pipeline pattern works well in this codebase.
- **`CanopyShell` aggregate mesh + canopy-coverage texture.** Has a second consumer in fable5 (water
  SSR horizon occlusion), so porting it well is a cross-subsystem change (vegetation + water), not a
  vegetation-only toggle. Out of scope for this spec; note it as a follow-up spec if pursued.

## Instrumentation

Add CSV fields (matching the existing `forest*` naming convention):

- `forestOcclusionCullEnabled`
- `forestRejectedOcclusion`
- `forestShadowProxyEnabled`
- `forestShadowProxyTris` (vs `forestShadowFullTris`, for before/after comparison)
- `forestTrunkFlareEnabled` / `forestBrokenTipsEnabled`
- `forestOctaImpostorEnabled`
- `forestImpostorBakeMs` (one-shot, logged once per palette bake, not per frame)

## Milestones

1. **D1 occlusion cull** — smallest, reuses existing baked height texture, no new bake pipeline.
   Ship first; validates the "reuse `loadedMap.heightTex` in a new compute cull test" pattern.
2. **D2 shadow crown-proxy** — second smallest; validates "bake an extra cheap mesh alongside
   existing LOD geometry, toggle live via castShadow" pattern, reused conceptually by D4.
3. **D3 branch flare/broken tips** — pure `trees.js` option-table addition; ship once D1/D2 prove
   the `controlRegistry`/inline-Forest-panel wiring pattern for player-facing toggles.
4. **D4 octahedral impostor, small grid (4×4) first** — new bake infrastructure; start at 4×4
   view directions and a single combined atlas to bound bake time, measure
   `forestImpostorBakeMs`, then consider 8×8 only if the smaller grid's visual seams are objectionable.

## Verification

- Capture before/after screenshots of a dense forest cluster from a ridge (occlusion cull, D1) and
  from an orbiting camera at billboard range (D4).
- Confirm all four toggles default to their current-behavior-preserving state (off, except D2 which
  may default on per its rationale — decide during D2 implementation) so shipping this incrementally
  never changes the default scene.
- Confirm each toggle round-trips through `controlRegistry` save/load (slider-state-presets) and, for
  the player-facing three (D2-D4), that MP world-settings sync carries the value the same way other
  forest settings do.
- Perf pass targets: D1 should reduce `forestDraws`/`forestBillboardInstances` when standing at the
  base of a ridge looking at trees on the far side, with zero visible pop-in for trees that remain
  actually visible. D2 should reduce shadow-pass triangle submission for LOD1/LOD2 bark without a
  visible shadow-shape regression at typical CSM cascade distances. D4's bake pass must complete
  within a bounded, logged time (target: comparable to or less than current
  `treePaletteBuildMs`) or be deferred/staggered rather than blocking first frame.
