# Base Game grass: recull each distance tier on its own clock

Date: 2026-09-06. STATUS: steps 1 to 4 committed 2026-09-06 (a50348e, 7cdec82, 2a7a2dc and the forest gate on top), docs in each; unseen in a browser. Follows `2026-09-06-base-game-hiz-occlusion.md`.

## Why

With the Hi-Z pyramid on, the grass cull runs every frame: the pyramid changes every frame, and
`grass-compute.js` reculls whenever its occlusion input changes. The user's A/B at one viewpoint:

| | survivors | fps |
|---|---|---|
| occlusion off | 343,517 | 46.5 |
| occlusion on | 70,877 | 45.1 |

79% fewer blades and no frame-time win, at 52 reculls a second over 15 million candidate threads.
The cull that removes the blades costs more than the blades did. Before this change the cull ran
on cell crossings and cone turns only.

The candidates are laid out by tier already (`grass-cells.js` `tierLayout`: tier 0 threads first,
then tier 1, then tier 2, each cell-major), and the far tier is most of them. In the shipped state
the tiers are 0 to 47 m, 47 to 187 m at a tenth of the density, and 187 to 341 m at full density.
A far blade's occlusion changes slowly: an occluder edge at 200 m moves a fraction of a pyramid
texel per frame of walking. So the far tier can be reculled rarely, the near tier every frame, and
the total work per second drops to a fraction without changing what is drawn.

## What must stay true

- Drawn blades are identical to a full recull at the moment each tier's recull runs; a stale tier
  is only ever stale in time, never wrong for the frame it was culled in.
- One tier reculling never disturbs another tier's survivors.
- Turning occlusion off returns the old behaviour: one recull per cell crossing or cone change.
- The HUD's cull counters, the A/B compare and the ground probes keep working; the counters become
  per tier plus a total.
- The blade material compiles to the same number of programs it does today (one), so the tree
  lesson from `d9b7ee2` is not repeated on the grass: per-region constants go in uniforms.

## Design

### Per-tier survivor regions

Today `reset` clears one atomic counter, `cull` appends survivors to one instance buffer, and
`finalize` copies the counter into one indirect draw. Change to three of each:

- `survCount[t]`, three atomics; the instance buffer split into three regions of fixed capacity
  sized from `tierLayout` (a tier's region holds at most that tier's candidate count, capped by the
  buffer). A tier writes `region[t].base + atomicAdd(survCount[t])`.
- Three indirect buffers and three `Mesh` objects over the same geometry and the same material,
  each with a `uniform` `uRegionBase` the vertex stage adds to `instanceIndex` before reading the
  record. Three draws instead of one; the cost of two extra draw calls is nothing next to a recull.
- `finalize[t]` writes region t's count into its indirect buffer, clamped by the region capacity
  and by the tier's share of `maxBlades`.

### Reculling a subset of tiers

`cull.count` is already set from the tier layout, and the thread index maps to a tier by the
`uTierThreads0/1` boundaries. Add `uTierBegin`: a recull of tiers `[a..b]` dispatches
`threads(b) - threads(a)` threads with `uTierBegin = threads(a)`, and the kernel adds it to
`instanceIndex` before the existing tier decode. Nothing else in the kernel changes: a thread still
knows its tier, cell and slot the way it does now. `reset` takes the same range and clears only
those tiers' counters.

The recull chain per frame becomes: for the set S of due tiers, `[reset(S), cull(S), finalize(S)]`
in one `computeAsync` submit; an empty S submits nothing.

### The clocks

Each tier is due when any of these holds, evaluated in `update()`:

- a dirty flag (settings change, residency, tier layout, a cell crossing for tier 0 and, since
  a cell crossing moves the whole window, for every tier);
- the camera moved more than `moveM[t]` or turned more than `turnDeg[t]` since that tier's last
  recull, with the pyramid on (the same shape as `forest-gpu.js`'s recull gate);
- `frames[t]` frames have passed since that tier's last recull, with the pyramid on, so a still
  camera in front of a moving occluder (a vehicle, a swaying tree) still refreshes.

Defaults, as `createComputeGrass` options and Plants sliders (never narrowing what a person can
set; the sliders' ranges reach 0, which means every frame):

| tier | move (m) | turn (deg) | frames |
|---|---|---|---|
| 0 near | 0 | 0 | 1 |
| 1 mid | 0.5 | 3 | 4 |
| 2 far | 2 | 8 | 16 |

The per-frame gate that exists today (`occChanged` from the pyramid revision) moves inside the
tier-0 clock. With the pyramid off, only the dirty and cell-crossing terms apply, which is the
old behaviour.

### The forest

`forest-gpu.js` is one list with a few thousand candidates; its per-frame recull is cheap. It
takes the mid tier's thresholds as its Hi-Z gate (`recullMoveDist`, `recullHeadingCos` already
exist there) so the cost is bounded, and keeps its frame clock at 4. Not split into tiers.

### HUD

The grass runtime line gains the reculls per second per tier and the candidate threads per tier,
so the win is visible: `reculls/s 52 / 13 / 3 over 0.9M / 2.1M / 12.0M threads`. The exact cull
counters are summed over tiers for the existing lines; the A/B compare is unchanged.

## Steps

- [ ] 1. `grass-cells.js`: `tierRegions(layout, capacity)` (region base and size per tier from
  the thread layout and the instance capacity) and `tierDue(clockState, camera, params)` (the
  clock as a pure function); `test-grass-cells.mjs` covers both: regions never overlap or exceed
  the capacity, the clocks fire on move, turn, frames and dirty exactly as the table says, and
  the pyramid-off case fires on dirty only.
- [ ] 2. `grass-compute.js`: three counters, regions, indirect buffers and meshes; `uTierBegin`;
  ranged reset/cull/finalize; the clocks in `update()`; `stats.tiers[t].reculls` and
  `stats.tierRecullRate`; `readCullCounts` sums the per-tier counters. `test-grass-compute.mjs`
  asserts the dispatch sizes and thread offsets for each subset and that a mid-only recull leaves
  the other two indirect counts untouched. `test-grass-wgsl-build.mjs` proves the kernels and the
  blade material still build, with the material at one program.
- [ ] 3. `base-game-flora.js`: the clock options from settings (`grassRecullMoveMid`,
  `grassRecullTurnMid`, `grassRecullFramesMid`, same for far), `stats` carrying the per-tier rates.
  `base-game.html`: the six sliders in the Plants section under the tiers, the runtime line, the
  capture fields. `test-base-game-flora.mjs` for the pass-through.
- [ ] 4. `forest-gpu.js`: the Hi-Z gate takes move and turn thresholds and a frame clock instead
  of "any revision"; `base-game-forest.js` passes the mid values. `test-forest-cull.mjs` gets the
  gate in `shouldRecull`'s twin.
- [ ] 5. Docs: `vegetation.md` (grass-compute regions and clocks, forest gate), `base-game.md`
  (sliders, HUD, capture); a row in `agent_log.csv` per step.

One commit per step; steps 1 and 2 are pure and land without a browser.

## Validation

- Headless: the tests named above plus `test-hiz-pyramid.mjs`, `test-vegetation-debug-hud.mjs`
  and `test-page-syntax.mjs`.
- Browser, the user's look: the same A/B as above at the same spot. The plan succeeds when
  survivors stay near 70,000 with occlusion on and the frame time drops below the occlusion-off
  figure, and the runtime line shows the far tier reculling a few times a second while walking.
  Then walk toward a crest and watch for far blades that appear late; if a 16-frame far clock is
  visible, the far frames slider is the fix, not the code.

## Risks

- Three regions of fixed capacity: a tier can fill its region while another has room. Size the
  regions from the tier's own candidate count so that cannot happen unless the buffer is smaller
  than the layout, in which case `thinTiers` already thins the far tier first.
- A cell crossing dirties every tier, which is a full recull as today; at walking speed that is
  every 2 m. If that dominates, tier 1 and 2 crossings can be coarsened to their own cell stride,
  a later change.
- `readCullCounts` diagnostics are per recull; with tiers reculling at different times the sum
  mixes frames. The HUD already says the counts are sampled, not per frame.
