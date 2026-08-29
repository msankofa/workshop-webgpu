# Base Game trees — dedicated plan

STATUS 2026-08-28: **T1 and T2 shipped** (`base-game-trees.js`, `base-game-forest.js`, wired
into `base-game.html` with a Trees panel block and a readout). T3 (shadows and the mirror) is next.
T2 answered two questions it was told to leave open: the full rescan stays (0.04-0.19 ms, measured),
and the LOD rungs share one undecimated branch geometry, which is where the triangle cost actually
sits. Numbers in `docs/subsystems/vegetation.md`.

STATUS 2026-08-27: **authored, nothing built.** Replaces F6 of
`2026-08-23-base-game-plants.md`, which was fifteen lines and is superseded in full by this
document. The comparison it rests on is
`docs/superpowers/specs/2026-08-27-tree-implementation-comparison.md`, which was reviewed
adversarially and corrected in four places before this was written. F1–F5 of the plants plan are
shipped, so the terrain fields, the cover channels, the chunk host and the grass layer all exist;
this plan consumes them and adds nothing to them.

## Goal

A streamed procedural forest over Base Game's infinite terrain: deterministic from the room seed so
every peer sees the same trees, thinned by slope and moisture rather than switched off by them,
budgeted in draw calls rather than in frame time, and correct through a render-origin rebase, a
planar water mirror and a shadow pass — the three things no existing host has had to survive.

## Facts this plan rests on

Read from source, not recalled. Line references are to the state on 2026-08-27.

**What already exists and is reused unchanged.**

- `trees.js`, `forest-placement.js`, `forest-palette.js`, `forest-gpu.js` are host-agnostic and
  shared by both existing forests. `placementRecords(chunks, params, heightAt, biomeAt)` consumes
  its RNG in a fixed order (species → seed → size → yaw), which is why two peers can agree.
- `base-game-terrain.js` already exposes `biomeAt`, `moistureAt`, `treeDensityAt`, `surfaceFieldAt`
  and `coverAt` (`:414-457`, exported `:680`).
- `flora-field.js` already derives a `coverTree` u8 channel per field texel at tile commit
  (`:112-127`), equal to `treeDensityForBiome(biome) x groundWelcome x slopeGate x moistureFactor`.
- `flora-chunks.js` is the budgeted, readiness-deferring chunk host extracted at F4 — per-frame
  chunk and millisecond budgets, and a `setReadyTest` that defers a chunk whose field has not
  streamed rather than building it against a default.
- `collision.js`'s `createTrunkIndex(chunkSize)` (`:77`) is a chunk-bucketed analytic trunk store
  with `setTrunks`/`clearTrunks`/`nearby`/`resolve`. It is the streaming collision answer;
  bot-viewer's BVH cylinder proxies are the static-arena one and cannot stream.
- The placement field window's guaranteed safe radius is **960 m** (2048 m window, 1024 m
  half-extent, less the 64 m the origin snap can move the centre).

**What Base Game has that no donor host had.**

- **A render origin that moves.** Rebase at 8192 m, snapping to 1024 m. `forest-gpu.js` writes
  records straight into the source buffer and compares them against `uCam` from `camera.position`;
  nothing in it knows an origin exists.
- **A planar water mirror.** `base-game-water.js:59-71` hides a caller-supplied exclusion list and
  re-renders the scene from a reflected camera. Grass is already excluded (`base-game.html:2003`).
- **A directional shadow camera of +/-90 m, far 260** (`base-game.html:1938-1946`).
- **Server-authoritative lockstep player physics.** Every movement parameter is in
  `BASE_GAME_SHARED_KEYS` (`base-game-protocol.mjs:59+`). Anything the player can walk into is a
  match rule, not a local setting.
- **A measured frame to fit into.** Latest capture (2026-08-26, 10 s, 641 samples): 64.1 fps
  effective, 15.6 ms mean frame, **225 draw calls mean / 304 peak**, 381k triangles. Post is
  9.16 ms mean on mirror frames, water reflect 3.11 ms, terrain 0.75, grass 0.054.

**What is wrong with the donor renderer, and must be fixed rather than inherited.**

- `rebuild()` rescans every resident chunk's records, calls `heightAt` per tree, and re-uploads the
  whole `V * CAP * 8` buffer on any chunk mutation (`forest-gpu.js:470-514`). Debounced to once a
  frame, but a full rescan either way. At `capPerVariant: 2048` and twelve variants that is 786 KB.
- `capPerVariant` overflow drops trees and warns **once ever** (`:507-510`).
- The shadow pass and the camera pass share one survivor list, written by a cull that includes a
  forward-facing FOV cone. A tree the cone rejected therefore casts no shadow.
- Leaf shadows exist only at LOD0 (`shadowL0`, `:390-396`).
- LOD3 billboards are unlit `MeshBasicNodeMaterial` with sun and ambient baked at fixed constants,
  and the bake is 150 lines inline in `environment-viewer.html:3575-3750`, gated on `loadedMap`.
- `treeCountForChunk` divides an absolute count by the resident window size
  (`forest-placement.js:115-121`).
- Nothing in `forest-gpu.js`'s material graph is time-dependent. The trees do not move.

## Decisions

**D1 — Density is per area, with a fixed constant, and is a shared key.** `treeCountForChunk`'s
`count / targetChunkCount` makes the forest a function of the resident window, so two peers with
different draw radii would place different trees. Base Game passes `count = treesPerHectare *
chunkArea / 10000` and `targetChunkCount = 1` per chunk, which makes the per-chunk count a pure
function of the chunk and the seed. Draw radius stays local; density joins `BASE_GAME_SHARED_KEYS`
and folds into `worldVersion`. This is a correctness prerequisite, not tuning.

**D2 — Dart-throw against `coverTree`, and drop `treeDensityAt` from the path.** The plants plan
used `treeDensityAt` for the accept and `coverTree` as a zero-veto. A binary veto does not
double-count, but it throws away exactly the information worth having: slope, moisture and ground
material never *modulate* density, so the forest runs at full biome density up to a cliff edge and
stops on a line. `coverTree` already carries all four terms multiplied together. One gate, one
sample, and the forest thins into terrain it dislikes.

**D3 — Metre-height normalisation waits for the authored families that need it.** bot-viewer
measures each baked species' bounding box and scales to a target height because the stock ez presets
range 19.7-96.2 units and one multiplier cannot serve both. That spread is a property of the
*authored* presets. v1 uses procedural `buildSpecies`, where height comes from
`slender = 1 + R() * 0.5 * diversity` (`forest-placement.js`) — about +/-13% at the default
diversity, not 4.9x. So v1 uses the ordinary size pipeline and the normalisation lands at T5 with
the families that motivate it.

**D4 — The cone cull stays on, and the shadow artefact is measured before anything is switched
off.** All three passes read one survivor list written against the main camera's frustum, so a tree
the forward cone rejected casts no shadow either. That is read from the code and is real. Whether it
is *visible* — an off-screen tree whose long low-sun shadow should have reached into frame — is not,
and the donor's cone is a working optimisation that saves instances. So the cone keeps its donor
default, T3 looks for shadow pop with it on, and it comes off only if the artefact shows. An earlier
draft turned it off by default on reasoning alone; that was backwards.

**D5 — The leaf-shadow/LOD coupling is a priced question at T3, not a decision here.** Leaf
shadows exist only at LOD0 (`shadowL0`, `forest-gpu.js:390-396`) and the shadow camera covers
+/-90 m (`base-game.html:1938-1946`), so with the donor's `lodR0` of 60 m there is a 60-90 m band
that is inside the shadow map and past the only rung that has leaf shadows. Three fixes, and this
plan does not pick one blind:

- Raise `lodR0` to 90. Simple, and the most expensive: full-detail geometry across a 90 m disc
  instead of a 60 m one.
- Add a leaf-shadow mesh at LOD1. One more geometry and one more draw per variant, covering the
  band at coarse detail.
- Shrink the shadow camera to `lodR0`. Free, and costs shadow reach.

T3 measures triangles and frame time for each and reports all three. `lodR0` also has its own
slider (D5b), so the coupling is visible while tuning rather than buried.

**D5b — Every LOD rung has its own distance slider and its own on/off toggle.** These are two
different measurements and the plan treats them as two controls, because one does not substitute
for the other:

- **The distance sliders collapse a rung.** `setLodDistances(r0, r1, r2)` already exists. Setting
  `r0 == r1` empties the LOD1 band, so those trees render at LOD2 instead — the quality-versus-cost
  question, with nothing disappearing.
- **The toggles hide a rung.** Trees in that band vanish rather than falling back, which is what
  isolates one rung's raster cost from the others. `forest-gpu.js` cannot do this today: its
  `renderParts` mask is indexed by *part* (bark, leaves, billboards, shadows) across a fixed
  eight-mesh layout (`syncRenderParts`), with no per-rung axis. Adding one is small — an
  `lodEnabled[4]` array and a mesh-to-rung map `[0,0,0,1,1,2,2,3]` folded into the existing mask —
  and it composes with the part toggles rather than replacing them.

**What a rung toggle does and does not measure**, so the numbers are not misread: hiding meshes
removes their draws and their raster work, but the compute cull still runs over the full `V * CAP`
and still writes every rung's indirect counts. A rung toggle therefore measures **raster cost only**.
The cull's cost moves with `capPerVariant` and the draw radius, not with these switches.
`stats.draws` already counts visible meshes, so the readout stays honest when a rung is off.

Sliders keep the full range even where a value looks unreasonable — the point is to see the cliff,
and a clamped slider hides it.

**D6 — Three LOD rungs in v1. No billboards.** `maxDrawRadius` is clamped to `lodR2` so the
billboard region is empty rather than white. LOD3 needs a bake that does not exist outside
`environment-viewer.html`, is gated on authored maps, caches into origin-scoped IndexedDB, and
produces an unlit material that cannot track a day/night cycle. Shipping it half-done is worse than
not shipping it. Porting it properly is a phase of its own, listed and deferred.

**D7 — Trees are excluded from the water mirror in v1, behind a toggle.** The mirror is already the
frame's most expensive pass, and a reflected forest doubles the forest's draw cost on every reflect
frame. The toggle exists because reflected trees are a real visual win, unlike reflected grass; it
requires D4's cone-off and is measured before it is defaulted on.

**D8 — Records are global, uploads are render-local, and rebase re-uploads without redrawing.**
Same contract grass now has. `setWorldOrigin(x, z)` on the forest, subtracting the origin at upload;
`worldCoordinates.onRebase` re-uploads resident chunks. No re-placement, no RNG redraw, no change to
candidate identity.

**D9 — Capacity is a visible budget with a stat, not a silent cliff.** `capPerVariant`, the draw
radius and the chunk-window radius multiply into one number. It is computed and reported the way
grass's buffer and dispatch budgets are, with a `truncating` flag, and the panel says when a slider
is being clamped rather than dropping trees quietly.

**D10 — Collision is out of v1, and when it lands it does not use the draw window.** Player physics
is lockstep and server-authoritative, so a trunk the host can walk into and a guest cannot is a
desync. Collision residency must be a fixed radius around each player, independent of that peer's
local draw radius. `createTrunkIndex` is the mechanism; the residency rule is the new part.

**D11 — Species are procedural in v1; authored families are one route and one loader away.** The
gap is `/api/list-families` in `serve.py` plus a file loader, because `families/manifest.json` is
`[]` and `tree-viewer.html` keeps its families in `localStorage`. That is smaller than the plants
plan implied, and it is scoped here as its own phase rather than as indefinite follow-on work.

## Phases

### T1 — Placement over the streamed fields

`base-game-trees.js`: a `flora-chunks.js` host instance, `placementRecords` per chunk with
`params.treeDensityAt` bound to the streamed `coverTree` sample (D2), per-area count (D1), and the
`setReadyTest` that defers a chunk whose cover or surface field has not streamed.

Params are constructed with every NaN trap closed explicitly, because all three are silent:
`waterLevel`/`shoreMargin` undefined makes the sum NaN and every `height >= NaN` false, so the
forest comes out **empty**; `skew`/`varPattern` undefined makes `Math.exp(p.skew * 1.5)` NaN and
poisons every scale; `leafCount` passed as an absolute flattens every species to one leaf count.

Records are stored global. No renderer yet — this phase ends with a records map and a test.

Test `test-base-game-trees.mjs`: same seed and chunk gives identical records; changing the draw
radius does not change any record (D1); records never land where `coverTree` is zero; density falls
with slope and dryness rather than switching off (D2); a desert chunk and an ocean chunk produce
none; NaN in any param is caught at construction rather than yielding an empty forest.

**T1 stop gate:** records per chunk, placement milliseconds per chunk, and the deferral count while
walking. No frame budget yet — nothing draws.

### T2 — The renderer, render-local and rebased — SHIPPED 2026-08-28

`createForestGPU` wired with the palette, plus the additions Base Game needs:
`setWorldOrigin(x, z)` and an upload path that subtracts it (D8), and the capacity budget with its
stat (D9). Palette disposal on rebake (`disposePalette`, which env-viewer lacks) and the canopy sway
ported from `bot-trees.js:113-121` land here too — they are small and independent, and an earlier
draft gave them a phase and a stop gate of their own, which was ceremony.

`rebuild()`'s full rescan and full re-upload is **measured first, not replaced first**. The
incremental path — a chunk's records occupy a known slot range, so adding or clearing one touches
that range and its variant counts rather than the whole buffer — is the obvious optimisation and is
written only if the measured cost at Base Game's chunk counts justifies it.

Height comes from the same near/far composed sampler grass uses, so trunks and blades cannot
disagree about the ground. Vertical bias is negative, for the same reason grass's is: a trunk sunk
five centimetres is invisible, one floating five centimetres shows daylight under it.

Test: a rebase preserves every record's global XZ, species and id exactly; an incremental chunk add
changes only that chunk's slots; capacity overflow sets `truncating` and reports, and does so every
time rather than once.

The per-rung toggle axis from D5b lands here, with the renderer, so every later phase can A/B
against it.

**T2 outcome.** `bench-base-game-forest.mjs` reports it headless; the GPU half is the page's own
profiler, which now has a `forestGpu` slot inside the frame partition. At defaults the forest is
**84 draws** (12 variants x 7 meshes, billboards off) and **~526k triangles** on top of a 225-draw,
381k-triangle baseline — a real cost, and the reason T3 exists. The rescan measured 0.04 ms, so the
incremental upload path named below was **not written**. The finding that matters for T3: LOD0/1/2
all draw the same `variant.branches` geometry, so 5618 of LOD2's 8858 triangles are undecimated
trunk, and only the leaves get cheaper with distance.

**T2 stop gate (original):** draws, triangles, instances, populated variants, palette bake
milliseconds, the per-chunk upload cost, and the frame-time spike at a chunk boundary — against the
225-draw, 15.6 ms baseline. Captured standing, walking and crossing a rebase. Plus the per-rung sweep: each
of LOD0/1/2 alone, then the intended combination, each reporting draws, triangles and instances so
the cost of a rung is a measured number rather than an estimate.

### T3 — Shadows and the mirror

D4 (cone off, measured both ways), D5 (`lodR0` tied to the shadow camera), D7 (mirror exclusion
with a toggle, and the `onMesh` hook that puts every forest mesh into `reflectionExclusions` the way
grass does). Separate bark-shadow and leaf-shadow toggles, each with its own cost recorded.

**T3 stop gate:** the four shadow combinations and the two mirror states, each with draws,
triangles and the reflect-pass time. This is the phase where the frame budget is most likely to
fail, so it gets the most captures.

### T4 — Panel, persistence, determinism

One Trees block in the Plants section: enable, trees per hectare, draw radius, **a distance slider
and an on/off toggle per LOD rung** (D5b), render parts, shadows, mirror, wind. The chunk-window
radius is **derived from the draw radius, not exposed** — it is an internal residency knob, and a
slider for it invites a window smaller than the radius, where trees stop existing with nothing on
screen to say why.
The readout beside them reports draws, triangles, instances, populated variants and per-rung
instance counts, so a toggle's effect is visible without opening a capture. Saved with the page state file, never
`localStorage`. Density and every other identity input joins `BASE_GAME_SHARED_KEYS`, is sanitized,
owner-only online, and folds into `worldVersion`; draw radius, LODs, shadows and mirror stay local.

Test `test-base-game-rooms-trees.mjs`: two independently constructed peers with different local
quality settings produce identical records; changing a shared value changes `worldVersion`;
malformed values sanitize identically.

**T4 stop gate:** the full capture with trees on at default and at maximum supported settings,
plus a two-peer record comparison.

### T5 — Authored families (D11, D3)

`/api/list-families` in `serve.py`, a file loader beside `tree-families-store.js` that reads
`families/*.json` from disk, and `tree-viewer.html` switched to `disk-store.js` so authoring saves
to a file instead of `localStorage`. `ageRange` is carried through `buildSpeciesFromFamilies` into
`_tag` and consumed as a **palette axis** — age changes geometry, so it is age buckets x variants at
bake time, not a per-instance transform.

**T5 stop gate:** palette bake time with six families (the measured baseline is ~432 ms), variant
count, and the draw-call cost of the larger palette.

### T6 — Billboards, properly (deferred, D6)

Extract the bake from `environment-viewer.html` into a module, give it a lit material that tracks
the day/night cycle, and store the atlas on disk rather than in IndexedDB. Only then raise
`maxDrawRadius` past `lodR2`.

### T7 — Collision (deferred, D10)

`createTrunkIndex` fed from a fixed-radius collision residency independent of draw radius, wired
into the lockstep controller on both host and guest, with a test that a peer's local draw radius
cannot change what it collides with.

## Frame-loop review

**Per frame, always:** `forestGPU.update()` — early-returns unless the camera moved 1.5 m or turned
2°, then one `computeAsync` submitting reset, cull and both finalize groups on a single encoder.
This is the donor's design and it is sound.

**Per frame, cheap path:** the chunk host's `syncToFocus` returns before allocating when the window
key has not changed, and `drain` returns before allocating when both queues are empty. Most frames
cost nothing.

**Per chunk boundary:** budgeted placement (chunks and milliseconds), then an incremental upload of
that chunk's slot range. The donor's full rescan and full re-upload is the thing T2 removes.

**Per rebase:** one re-upload of every resident chunk. Rare (8192 m) and bounded by residency.

**Allocation:** the records map is the only growing structure. Scratch vectors for the camera
forward already exist in the donor. No `new` in `update()`.

**Disposal:** palette geometries on rebake (T3), the renderer's own clones and materials on teardown,
and the storage attributes through the same `renderer._attributes.delete` path grass now uses.

## Visual rubric

| Row | Phase | Fails when |
|---|---|---|
| Scale and contact | T2 | A trunk floats or sinks to its first branch. Same composed height sampler and negative bias as grass. |
| Image stability | T2, T4 | Trees pop at an LOD ring, or shadows flicker as the camera turns. D4 and D5 are the fixes; a remaining pop is a hysteresis question. |
| Shadows | T4 | Canopy shadows vanish at a ring (D5), or off-screen trees stop casting (D4). |
| Transparency and depth | T2 | Leaf cards halo or sort wrongly against each other, the water surface and the grass. |
| Materials and lighting | T3, T4 | Canopies read flat, or move differently from the grass under them. |
| Reflections | T4 | Reflected trees are the wrong trees (the cone), or the reflect pass cost jumps. |
| Render sanity | every | A shader-compile error, or a layer that never appears behind a lazy-import `.catch()`. |

None of this is asserted from source. The verdict is what the page looks like.

## Known limits to state, not hide

- No billboards in v1, so the forest ends at `lodR2` rather than fading to cards.
- Trees do not collide in v1. The player walks through trunks.
- Species are procedural until T5; the six authored families exist and are unreachable.
- Canonical placement is band-limited to the coarse field, so features narrower than a post get no
  unique vegetation. Fine-window arrival corrects only Y.
- Cone-off (D4) costs surviving instances. The number is measured at T3, not guessed here.
- The 960 m field radius is a ceiling the draw radius cannot pass, and `capPerVariant` will bind
  well before it.
- `forest-cull.js` is a hand-synced CPU twin that nothing imports. Any change to the cull kernel in
  T2 or T4 must be mirrored there by hand. T2 did not touch the kernel, so it is still in sync.
- The three LOD rungs share one branch geometry (measured at T2). A "coarse" tree is 63% trunk
  triangles, so raising the LOD distances buys much less than the rung names suggest until the
  branch geometry itself has a coarse variant.
- `showError` was called on both flora's and the forest's failed-load path in `base-game.html` and
  does not exist anywhere in the repo; both now `console.warn`, with the panel line carrying
  `lastError`.
