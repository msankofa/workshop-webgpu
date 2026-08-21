# Pokémon Park

`demos/pokemon-park.html` — a 2.4 km park with all 151 Stadium species living in it, each in a biome that
suits it, moving the way its body implies, occasionally using a move. You walk it as the bot rig.

| File | What it is |
|---|---|
| `park-species.js` | All 151: biome, spawn weight, secondary biomes, features, movement style, height in metres, moveset. No THREE. |
| `park-biomes.js` | The park's heightfield and its eight-biome map. No THREE. |
| `park-ground.js` | The ground mesh and the sampler for the *drawn* surface. |
| `park-spawn.js` | The census and the residency streaming. No THREE. |
| `park-movement.js` | Nine solvers for residents that cannot walk. No THREE. |
| `park-creature.js` | Loading, driver dispatch, idle clips, LOD. |
| `park-flora.js` | Grass, trees, boulders, streamed by chunk. |
| `park-trees.js` | Which ez-tree species grows in which biome, and how tall. No THREE. |
| `park-trails.js` | A* trail routing over a coarse grid. No THREE. |
| `stadium-reference-species.js` | The fourteen the rig work was tuned against. |
| `models/stadium/*.glb` | All 151, plus `manifest.json`. 74 MiB. |
| `test-park-world/-movement/-creature/-ground/-trails/-trees.mjs` | 244 checks. |
| `_check_pokemon-park.html.mjs` | 45 static checks on the page. |

## The models

All 151 recovered from `pokedex-151.html` with `docs/stadium/tooling/extract_glb.py`. Verified: the
fourteen already in the repo came out byte-identical, and every model's clip count and durations match its
manifest entry — 72,859 animation channels, zero mismatches. Every species has `idle`, `attack`, `faint`,
`entrance`; 107 have a second attack, 66 a third.

`manifest.json` carries per-species triangles, bones and clip labels. The labels name the moves each attack
animation was used for (`attack_2 (Bide, Skull Bash, Struggle +11)`).

## The three things a species needs

Biome, movement style, moveset. `spawnable(species)` returns what is missing; `test-park-world.mjs` asserts
the whole table passes. Types are absent on purpose — they belong to a battle system that does not exist.

**Biome and likelihood.** Eight biomes. One home biome, a `rarity` weight in (0, 1], and other biomes
accepted at half weight. `near: [water|trees|rocks|building|open|height|dark]` scores a *point* within the
biome, used as an acceptance probability rather than a threshold. `canOccupy` overrides the data: nothing
that cannot swim, fly or hover goes on a lake cell, and a swimmer is not planted on dry land.

**Movement style.** Eleven. Three legged (drive `stadium-walker.js`), eight bodiless (`park-movement.js`),
plus a `ground` fallback nothing is authored as. Styles are authored, not derived: the mapper reads Muk and
Pinsir as ten-legged, Jynx and Electabuzz as six-legged, Mewtwo as legless — hair, mandibles and a floating
pose. The measured count is stored as `rigLegs` so a disagreement is testable. Counts: 25 quad, 51 biped,
11 multi, 14 hover, 18 fly, 12 swim, 5 slither, 2 roll, 8 hop, 2 burrow, 3 sessile. Hitmonchan is the only
species authored legged whose rig maps no legs; it falls back and the fallback lands in `warnings`.

**Moveset.** 2–4 moves from `moves/move-registry.js`. Where the flavour-correct move has no effect, the
entry reads `Wanted?Substitute` (`Vine Whip?Absorb`) and resolves to the substitute.

## The park

`parkHeightGrid` composes the terrain from `terrain-noise.js` primitives — rolling base, one ridged massif
with a radial falloff, two basins, a flattened town pad. `generateFullGridV5` was tried first and returned
61% mountain with no wetland: its layer stack masks by running height only, so "a ridge in the north-east"
is not expressible.

`buildParkMap` places meadow, forest and mountain as warped Voronoi sectors, stamps town and cave as discs,
then lets the ground overrule in this order — sector, mountain, town, cave, wetland, shore, lake. The order
is the design; water is last. Shore is a bounded flood from the waterline, not a height threshold, so the
beach is a constant width instead of varying with slope. `biome-classifier-js.js` was not used: it decides
biome from temperature and humidity noise, which marbles, and a park has to be legible.

Typical shares: meadow 43%, forest 27%, mountain 22%, lake 3%, shore 2%, wetland 2%, town 2%, cave 1%.

**Ground.** One static mesh decimated from the gameplay field. Field 769² (≈3.1 m cells) for feet and
lookups; drawn sheet every second sample — 295 k triangles against 1.18 M undecimated. `resolution - 1`
must divide by `meshStride` or the sheet stops a cell short of two edges; `buildParkGround` refuses a
stride that does not. Colour is baked per vertex from biome, slope and noise, with a TSL layer for near
detail. The drawn surface departs from the field by up to 3.1 m between vertices — feet read the field,
drapes read `surfaceHeightAt`.

`surfaceMaxNear(x, z, r)` stepped by a whole 6.25 m cell regardless of `r`, so any reach smaller than a
cell read a 12.5 m neighbourhood. Nothing called it until the roads did, and it would have floated them
metres off every slope. It now spans exactly `r` at a spacing no coarser than a cell: mean lift along the
trails is 0.11 m, worst 0.82 m.

## The census

Planned once over the whole park, seeded; streaming only decides who has a model. A ring spawner was the
alternative and cannot give you "the Magikarp are still in the lake when you walk back". Each biome's share
of the census is the **square root** of its share of the map. Candidates are drawn from the biome's own
cells — uniform draws over the park need ~100 tries to hit a 1% biome, and 40 attempts put nobody on the
beach. Default: 420 residents, 118 species, every biome populated.

`createResidency` radii are active 130 m, far 210 m, drop 250 m. The gap between active and drop is the
hysteresis; without it a resident on the boundary loads and unloads on alternate frames.

## Driving a creature

Both driver families answer `placeAt`, `setTarget` and a step, so only `applyPose` branches.

- **The walker's leash is origin-centred.** `steer()` heads for (0, 0) past `roamRadius * 1.15` from the
  *world* origin. Defeated by setting `roamRadius` past the map diagonal and driving `setTarget` here — one
  number, no fork.
- **Scale is the Pokedex height.** `worldHeight` means total model height in world units. Model units are
  meaningless across these files; ride heights run 1.8 to 101.
- **The ROM idle is layered on the spine, leg tracks stripped.** Seel, Tauros, Nidorino and Growlithe are
  exempt: their idle moves the hips further than the whole stride envelope (4× on Seel).
- **Culling is by visibility, not bounding volume.** These meshes are authored 10× in bone-local space so
  their bounds are garbage and `frustumCulled` is off. A distance and dot-product test costs the same and
  cannot make a Charizard lose a wing. Past 55 m the gait is strided, not dropped.

## Trails

`park-trails.js` routes A* over a 30 m grid. Water and anything steeper than `maxGrade` 0.55 are
unwalkable, and a step costs `run * (1 + 9 * grade^2)`, so a trail takes switchbacks instead of a
fall line. The route is Chaikin-smoothed, thinned to 14 m control points, and handed to
`road-network.addRoadPath`, which snaps and splits the junctions itself. Seven legs, 7.2 km.

At `maxGrade` 0.42 the massif walls itself off and the tarn and saddle legs do not route at all;
0.55 opens them. A leg that cannot connect lands in `skipped` rather than being straightened into a
line through the lake.

Roads read `ground.surfaceHeightAt`, not the field. `clearMargin` 2.6 m becomes the flora `clearFn`,
which zeroes the grass density grid, the tree density and the boulder records along every trail —
which is why the trails are cut before the flora is sown, the density texture being baked once.

## Moves

Sixteen effects built once at load, cast at a neighbour within 34 m or down the caster's own facing.

- **The six point lights are created before any world material.** A light-count change recompiles every
  material in the scene. `_check_pokemon-park.html.mjs` asserts the ordering.
- **`fx-field` is banned** — it anchors to a hardcoded world (0, 0). Held moves are excluded too.
- `makeLine` uses `step: 0.45`, not the demo's 0.08: it samples `terrainHeight` once per step.
- Ten concurrent casts, oldest disposed — each holds pooled geometry until disposed.

## The player

`createProceduralPlayerBody` with `botDesignForRole('rifleman')`, driven from a plain
`{position, yaw, velocity, onFloor, crouch}` struct. Two inherited traps: feed **horizontal** velocity only
(fall velocity makes a jumping body sprint), and the **standing** height not the lerped capsule (the rig
applies the crouch itself). The sun's shadow camera follows the player — the gate alone is 800 m from the
origin.

**The camera is composed, not steered.** `look.yaw` / `look.pitch` are authoritative; the mouse writes
them and `updateViewFeel` composes `camera.rotation` from them plus the eased strafe tilt and momentum
lean, in YXZ. Writing the look angles without that compose step is a page where the mouse spins the body
and the camera never turns, which is what shipped first. The walk basis comes off `look.yaw` directly
rather than off `camera.matrixWorld`, so visual tilt cannot steer the player.

**The camera does not sit on the collider.** `placeCamera(dt)` eases `camEye` toward the capsule top —
`CAM.followRate` horizontally, `CAM.riseRate` vertically while grounded — and snaps outright past
`CAM.snapDist` so a jump or a respawn does not drag. The collider takes one-frame corrections that the
eye must not inherit: the ground-contact lift, the trunk push-out from `flora.resolveCollision`, and the
stance height lerp. Terrain is not among them; the field's per-frame vertical second difference on
walkable ground measures 4 mm at worst, so it was never the source of the jitter.

The third-person boom marches in from `camDist` in `CAM.boomStep` increments and takes the first seat
clear of the ground and of every trunk. The first version halved the distance instead, which quantised
the boom to five lengths — every trunk it grazed threw the camera 1.2 m. The resolved distance snaps
**in** so nothing swallows the camera and eases **out** at `CAM.boomOutRate` so leaving cover does not
whip. Switching view resets both, or coming back out of first person dollies for a second and a half.

## Trees

Fifteen ez-tree species from `tree-presets.js`, tagged in `park-trees.js` with the biomes each grows in
and a height span in metres — pine on the mountain, ash in the wetland, oak and aspen through the meadow,
bushes everywhere thin. `forest-placement.js` already did the biome-filtered, density-weighted draw
whenever `params.speciesTable` is set; nothing before this passed it one, so the whole park was four
generalised variants of one tree.

Height needs care. The stock presets measure 18.8 to 91.7 units tall, so one `maxSize` cannot serve both,
and `sizeFor` ignores `maxSize` entirely once a species carries its own `sizeRange`. `applyMeasuredHeights`
measures each baked variant and inverts `sizeFor`, so the top of the span lands on the authored metres and
the realised bottom lands on the low one. Trees now stand 0.7 m to 27 m against roughly 6 m before.

**They use the authored texture set, not the procedural one.** `createTextureSource('authored')` loads
the `Bark014_1K-JPG` bark and the four leaf PNGs into a 2x2 atlas, and each species names its own cell —
oak 0, aspen 1, ash 2, pine 3, matching `LEAF_FILES`. That is the whole of the pine work: with a texture
set present `leafOptsFor` switches leaves from `'simple'` silhouettes to `'quad'` atlas cards and honours
`sp.leaves.atlas.cell`, so a pine grows needles. The first version passed `texSet: null` and got neither —
and since three of the four ez families author their leaf tint as pure white, the trees rendered white.

`TEX_DIR` is `'./textures'`, resolved against the **document**. This page is in `demos/`, so it would have
404'd every map and fallen back to flat colour. `createTextureSource` now takes a `texDir`; the park passes
`'../textures'`, and the static checker asserts both that and the files. The set is awaited before the
palette is baked rather than hot-swapped, because the leaf geometry differs between the two modes — a late
set means rebaking. `?treeTex=off` takes the flat path.

Two variants per species is 30 baked geometries (150 ms in Node) and 240 draw meshes, of which only the
variants holding live instances are submitted. `?treeVariants=1` halves it. Trees are frustum-culled on
the GPU by `forest-gpu.js` — a cone test in the cull pass — which is why their meshes carry
`frustumCulled = false`: the bounding volume describes one unit tree, not the instances.

Trunk push-out uses each species' own `radius[0]` rather than one number for the forest, so a bush and a
large pine do not stop a walker at the same distance.

## Grass

The `grass-look.js` features are **off by default**, which is the legacy graph exactly, and each is a panel
toggle. They were shipped on once and the field came out lit in patches: `curlNormal` replaces the lit
normal with the curl arc's, and `translucency` adds a view-and-sun term on top, so turning both on blind
changes how every blade answers the light. Curl and its lighting contribution are separate toggles for that
reason. Every one is a uniform, so flipping one recompiles nothing. Blade height, width and density are
sliders, saved to the session file. `setSunDir` is pushed when a sun slider moves, not per frame.

**The shadow box follows the sun down.** It was a fixed 110 m square around the player. At 46 degrees of
elevation that holds the shadows that reach you; by 20 it does not, and the edge of the box reads as a
straight line across the park with lit ground on one side and shadowed ground on the other. `shadowSpanFor`
widens it to 340 m as the sun drops, and widens the depth bias with it because a wider box is fewer texels
per metre.

## Flora

Four silent-failure modes in the underlying placers, each of which produces nothing and says nothing:

- `forest-placement.js` computes `waterLevel + shoreMargin`; either undefined makes it `NaN`, every
  `height >= NaN` false, and the forest empty. `skew` and `sizeVar` do the same to every scale.
- `createComputeGrass` sizes its buffer from `maxRadius`. The env viewer's 600 is 601² × 64 instances at
  32 bytes ≈ **740 MB**, past the 128 MB default binding limit. 160 is the same grass and 53 MB.
- `rocks-placement.js` gates scree on a `surfaceField`; without one the gate is 0 and every scree candidate
  is rejected. The park synthesises one from its own slope.
- `forest-gpu.js` buckets past `lodR2` into billboards whose material has no colour node until an atlas is
  baked. `maxDrawRadius === lodR2` empties that band.

The park's height array is already the layout `DataTexture` wants, so the grass height texture is a view
over the field. Grass density is a per-biome table baked to a second texture. The placement window must
exceed the cull radius or the square clips the circle. Scree and mushrooms are off by default.

## One draw per Pokemon (`park-atlas.js`)

The Stadium models are about 690 triangles each — but they are exported as **10 to 18 primitives, one
per material, one small texture each**, so an unmerged creature costs 10-18 draw calls to draw almost
nothing, and again in the shadow pass. Fifty residents is well over a thousand draws for about 35k
triangles. Across the 151 models: 1981 primitives.

`atlasSkinnedRoot(THREE, root, { TSL, MeshStandardNodeMaterial })` runs once per species, at load,
through `createParkCreatures`' `atlasSpecies` hook. It packs every texture of the species into one
sheet, merges the primitives into a single `SkinnedMesh` with a per-vertex `atlasTile` vec4, and
rebinds it to the same skeleton. 1981 primitives become at most 193 draws — 10.3x fewer — and the
largest sheet any species needs is 512px, because these textures are mostly 32x32.

**The UV clamp belongs in the shader, not in the vertices.** A quarter of the source UVs run outside
0..1, which is legal because every sampler in these files is `CLAMP_TO_EDGE`: a triangle whose u runs
to 8.8 is stretching one edge texel across itself. Baking `clamp(uv, 0, 1)` into the vertex would
stretch the whole texture across that triangle instead. So the material does
`tile.xy + clamp(uv, 0, 1) * tile.zw` per fragment. `tileRect` also insets each tile by half a texel
so linear filtering cannot reach the neighbour, and each tile is drawn twice — stretched, then exact —
to leave an edge-replicated border for the mips.

The merge refuses rather than guesses: different parents, different skeletons, different local
matrices, a material with no map, or an atlas that will not fit under 1024px all return `null`, and
the species renders unmerged with a warning. `?atlas=off` disables it. The HUD reports
`N draws merged away`.

Instancing is not the answer here and is not implemented: the residents span about thirty species with
one or two of each on screen, so there is almost nothing to batch, and skinned instancing would need
per-instance bone textures.

## What is culled, and what is not

| Layer | Culled by | Note |
|---|---|---|
| Trees, grass, boulders | a cone test in their own compute pass | their meshes carry `frustumCulled = false` on purpose: the bounding volume describes one unit tree, not the instances |
| Roads and trails | Three's per-mesh test | ordinary meshes, split per segment |
| Creatures | `park-creature.js` `update()`, per creature, in world space | see below. Each is one draw after `park-atlas.js` merges it |
| Ground | nothing | one 385×385 sheet, 295k triangles, spanning the whole 2.4 km park, so no frustum can ever drop it. It does not cast a shadow. `cdlod-terrain.js` is the fix and is not wired here |
| Sky, clouds, water | nothing, deliberately | they follow the camera |

Creature meshes come out of the GLB with `frustumCulled = false`, so **nothing culls them unless this
file does**. It used to gate only on a 220 m draw distance and a behind-cone at `cos < -0.35`, which
lets through everything inside about 110° of the view axis — most of it off screen. `update()` now
builds the camera frustum once per call and tests each creature as a world-space sphere of
`species.heightM * 0.85 + cullPad`.

Two deliberate exceptions. Inside `cullKeepDistance` (55 m) a creature is drawn whatever the frustum
says, because it is close enough that losing its shadow would read as a bug. And failing the frustum
test stops the **draw** but not the **walk** — the pose still runs on the old behind-cone, since
freezing animation at the screen edge is visible the moment you pan.

The HUD reports `NN draws, NNNk tris` and, when any are, `N culled`.

## Streaming and hitches

Species assets default to `preload`: every species in the population plan is parsed and pipeline-warmed
serially behind the boot screen before the gate opens. `?speciesLoad=stream` preserves the old
nearest-first runtime streaming path for A/B captures. Resident instances and world chunks still stream
while walking because they are separate from the cached species templates.

| Work | Pace | Why |
|---|---|---|
| Species GLB load | all serially at boot by default; one at a time in `stream` mode | the parse is synchronous once the bytes land, so default play does not permit it during movement |
| Failed species | terminal until `retrySpecies` or reload | a cached rejection must not be requeued every streaming tick or append duplicate error text forever |
| Pipeline compile | at load, via `warmMaterials` | `createParkCreatures` takes a `warmMaterials(obj)` hook; the page passes `renderer.compileAsync(obj, camera, scene)`. Without it the pipeline compiles on the frame the first of that species walks into view |
| Resident spawn | `maxActivations: 1` per 200 ms tick, skipped on a frame over 28 ms | a spawn clones a rig and builds a walker |
| Tree chunks | 2 per frame inside `treeBuildBudgetMs`, uploaded in batches of `treeFlushChunks` | placement is cheap (0.16 ms median, 1.2 ms worst per chunk, measured), but every `setChunks` call costs `forest-gpu` a full source-buffer rebuild and a ~1 MB upload. Batching collapses the eleven consecutive rebuilds a chunk crossing used to cause |
| Rock chunks | `rockChunksPerFrame` inside `rockBuildBudgetMs` | had no time budget at all |

The streaming tick force-fires after 1200 ms even on slow frames, so a page that never gets under 28 ms
still populates.

## Saving

`park-saves/park-session.json` via `POST /api/save-park`, autosaved and beacon-flushed on `pagehide`.
`localStorage` is the fallback cache only; the static checker enforces it. Holds seed, tuning, sightings.

## URL flags

`?seed=4` · `?pop=420` · `?flora=on|off|nograss|notrees|norocks` · `?trails=on|off` ·
`?treeVariants=1..4` · `?treeTex=off` · `?atlas=off` · `?moves=on|off` · `?water=on|off` · `?sky=on|off` ·
`?speciesLoad=preload|stream` (default `preload`) ·
`?fpsCap=60|40|30|off` (default `off`; numeric caps are opt-in profiling/thermal controls)

## Not done

- Types, and therefore battles.
- Nothing follows a moving caster — `cast()` never gets a transform, so an effect is frozen at cast time.
- The eleven newer move effects have still never been seen rendered (inherited from `pokemon-moves.md`).
- Slopes are exercised but not tuned, and the park has 180 m of mountain.
- No structures — the town is ground colour, a flat pad and the trails that reach it.
  `bot-structures.js` + `map-boxes.js` is the intended source.
- Trails are scenery. Nothing prefers to walk on one, and the residents ignore them entirely.
- Streaming is paced but not measured on a GPU. The HUD's `worst NN ms` is the only hitch instrument;
  the page does not wire `frame-profiler.js`.
- No ambient audio; needs park ids in `sound-events.js` first.
- Interaction is looking. No approach, feed, catch or command.

## Note on the shared tests

`test-stadium-rig.mjs`, `test-foot-sdf.mjs`, `test-rig-audit.mjs`, `test-sdf-pikachu.mjs` and
`test-sdf-mesh-bake.mjs` scanned `models/stadium/` with `readdirSync`, which meant "the species we tuned
against" while the directory held fourteen. Checking in all 151 broke that identity without changing
behaviour — the mapper finds no legs on 35 species by design. They now import
`stadium-reference-species.js`.
