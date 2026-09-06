# Base Game: every occluder hides, every flora kind is hidden

STATUS: phases 1 and 2 committed 2026-09-05 (28ab06f), terrain occlusion gated off since ba95aa4; phases 3 and 4 superseded by `2026-09-06-base-game-hiz-occlusion.md`.

## Goal

Today only the spawn building is in the flora occlusion depth image, and only grass reads it.
The end state is the table below with every cell true, except the one cell that is not worth
its cost.

| | Culled by view cone | Culled by occlusion | Acts as occluder |
|---|---|---|---|
| Spawn building | n/a | n/a | true (today) |
| Lab | n/a | n/a | phase 1 |
| Terrain | true (today) | skipped, see "Not doing" | phase 2 |
| Trees | true (today) | phase 4 | phase 3, trunks only |
| Grass | true (today) | true (today) | n/a |

## How the depth image works, and what constrains the plan

`flora-occlusion.js` renders the scene from the live camera into a 256 px half-float target with
`scene.overrideMaterial` set to a material whose colour is view depth. Only meshes on layer 2 draw.
The cull kernels in `grass-compute.js` project each candidate with the same view-projection and
drop it when its top is deeper than the stored depth by more than the bias.

Two facts decide what is cheap:

- A scene-wide override material uses the standard vertex path. Anything whose vertices come from
  a shader position node draws in the wrong place. The far clipmap rings
  (`terrain-clipmap.js`, `mat.positionNode = worldPos`) and the forest (`forest-gpu.js`, per-variant
  `positionNode`) are both of that kind. The near terrain chunks are a `BatchedMesh` with real
  vertices (`terrain-chunk-batches.js`), and the lab is plain meshes.
- The other session's `cacheStatic` skips the render when no marked root moved and the camera did
  not move. Any occluder that changes shape while the player walks (streaming chunks, forest
  reculls) must call `invalidate()` on change, or the cache serves a stale image.

## Phase 1: the lab occludes

Files: `base-game.html`.

- In `syncSpawnBuildingFlora()` (near line 1276), also mark `traversalLab.root` when the world mode
  is the spawn area. The rain occluder bake at line 3427 already treats that root as the lab's
  occluder set, so the same root is right.
- The lab root moves on rebase; `flora-occlusion.js` detects root motion itself, nothing to add.

Test: `test-base-game-flora.mjs` if it stubs the occlusion; otherwise the browser HUD grass line,
which already says "occlusion on", and the ring probe (`2fdfd1a`) which names the cull test that
killed a blade per direction. Stand behind a lab wall and read the probe.

## Phase 2: near terrain occludes

Files: `base-game.html`, `flora-occlusion.js`.

- Mark `terrain.root` (the batched chunk root the rain bake at line 3428 uses). Real vertices, so
  the override material is correct for it. Do not mark the far clipmap rings.
- Chunks stream in and out under the same root, so the root's matrix does not change when its
  contents do. Add a call to `occlusion.invalidate()` from the page's chunk-residency callback
  (wherever `terrain` reports a chunk added or removed; find it by grepping `chunkBatches` or the
  residency gate from `5b93dce`).
- The BatchedMesh's own per-chunk frustum test runs for the occlusion camera as well, so only
  visible chunks draw into the image.

Cost to measure before keeping it on by default: the occlusion render's `stats.lastRenderCpuMs`
and the frame profiler's GPU pass time with the player walking, with and without terrain marked.
The render already happens every moving frame for the building, so the delta is only the terrain
draw at 256 px. If the delta is under about a millisecond of GPU time, default on; otherwise
default off behind a toggle "Terrain hides grass behind a crest" next to the existing occlusion
toggle at line 4645.

Correctness risk: the terrain surface and the grass blade base are the same height, so a blade on
a slope facing the camera could read as "deeper than the terrain in front of it" by a texel of
resolution. The bias (0.12 m plus 1 percent of depth) is what protects it. Check a hillside at a
grazing angle with the proof colour mode; if blades vanish on facing slopes, raise the bias only
for terrain by writing the terrain depth minus a slope allowance in a per-object material (phase 3
introduces that mechanism anyway).

## Phase 3: tree trunks occlude

Files: `flora-occlusion.js`, `forest-gpu.js`, `base-game-forest.js`.

- Per-object depth materials instead of the scene-wide override. Three's renderer honours a
  material assigned per object when `scene.overrideMaterial` is null, so the pass changes to: for
  each marked mesh, swap its material for a depth material it carries in `userData.occlusionMaterial`
  (or the shared one when it has none), render, swap back.
- `forest-gpu.js` builds one depth material per variant with the same `positionNode` as that
  variant's branch material and no leaf material. Leaves are excluded on purpose: a canopy is
  porous and would hide grass you can see through it.
- Forest reculls change which trees exist, so the forest's recull path calls `invalidate()`.
- Mark only the branch meshes.

Payoff is small (a trunk hides a thin sliver). Do this phase only because phase 4 needs the
per-object mechanism, or skip both together.

## Phase 4: trees are culled by occlusion

Files: `forest-gpu.js`, `forest-cull.js`, `base-game-forest.js`.

- The forest cull kernel already projects each instance for its cone test (`coneLive`, around line
  197). Add the same keep function `grass-compute.js` uses: project base and top, keep if either is
  on screen, drop when the top is deeper than the depth image by more than the bias. Pass the
  occlusion state through `createForestGPU(opts.occlusion)` the way `createComputeGrass` takes it.
- Trees are tall, so test the top at the tree's height, not a fixed blade height. Test the base
  too, and keep if either passes, otherwise a tree whose crown peeks over a wall disappears.
- The sampled-texture budget: the forest kernel must sample the depth image through one texture
  node with `.sample()` for its five taps, the fix from `75d9c2a`, or it will trip the per-stage
  limit the other session raised.
- Hand-sync the CPU twin `forest-cull.js` with an `occluded` branch that takes a depth sampler,
  so `test-forest-cull.mjs` can cover it headless.
- Shadow-only meshes on the forest shadow layer must ignore the occlusion result, or a hidden tree
  stops casting its shadow across the wall.

## Not doing: terrain culled by occlusion

A chunk is tens of metres across and is almost never entirely behind a wall or a ridge. The
per-chunk frustum test already handles the common case. Skip.

## Order and stopping points

1 then 2 are each one commit and independently useful; stop after 2 if the measurement in phase 2
is bad. 3 and 4 go together. Every phase updates `docs/subsystems/vegetation.md` (the occlusion
section) and `base-game.md`, and appends a row to `agent_log.csv`.
