# Feasibility Report: Eight Mod Ideas for DramaticShapeVoxelMod

Assessed against the actual code of both repos: the mod (scottcandy34 mirror, v1.8.2) and the host engine (bryanthaboi/pokemon-gen1-recomp-project). Every claim below cites the file it was read from. Difficulty ratings assume a companion mod reaching in through `mod.exports.lib` (main.lua:1444) where possible, with the fork-vs-companion decision still open.

## Ranked summary

| # | Idea | Difficulty | Key finding |
|---|------|-----------|-------------|
| 1 | Legendary set pieces | Small–Medium | Standalone model draw already proven in tests; mostly wiring |
| 2 | Follower Pokémon | Medium | The engine ships a complete follower (PikachuFollower.lua, 1,044 lines) to adapt |
| 3 | NPC schedules (despawn tier) | Medium | `WorldAPI.toggleObject` + `world.tod_changed` event = ready-made levers |
| 4 | Seasons (voxel world only) | Medium | Atlas slot-rewriting is exactly the needed mechanism; 2D parity is the hard part |
| 5 | Weather (fog + rain look) | Medium | Per-map atmosphere system exists with a runtime override hook; no real particle system |
| 6 | Live/ambient wild mobs | Medium–Large | Every hard seam exists and is proven; bulk of work is per-species visuals |
| 7 | Move VFX | Medium (hero moves) → Large (all 165) | Move id is already known at animation time; no VFX registry exists |
| 8 | Trainer models | Unknown → possibly blocked | Nobody has established the trainer models are in the extracted archive at all |

The single biggest cross-cutting constraint: **there is no overworld art for 151 species.** The engine ships only a handful of Pokémon overworld sprites (SPRITE_PIKACHU, SPRITE_BIRD, SPRITE_SEEL, SPRITE_SURFING_PIKACHU plus Gen 2 extras). Followers, mobs, and set pieces all need either the Stadium models (gated on the player supplying a Stadium ROM) or a billboard fallback built from battle pics — so a shared "draw species X at world position Y, with fallback" module would serve three of the eight ideas at once.

---

## 1. Legendary set pieces — Small–Medium

**What exists.** The Stadium model draw path works with no battle session: `StadiumPack.load(species, shiny)` reads a pack off disk standalone, and `StadiumRig:draw(matrix, pull)` / `:caster(shadowMap, matrix)` emit into Voxel3D's own vertex format. `tests/stadium_anim_qa.lua` already draws rigs outside any battle. `StadiumMon:matrix(x, groundY, z, faceX, faceZ)` places a model at a world position; `VoxelScene.groundAt(map, cx, cy)` supplies terrain height. On the engine side, the Route 12 Snorlax is a named object (`ROUTE12_SNORLAX`, referenced in `src/inventory/ItemEffects.lua:143`); the mod builds its billboards from the NPC list at `VoxelScene.lua:514`, so hiding the flat sprite is a filter there and the object's cell gives the placement.

**What's missing.** Nothing draws a Stadium model in the overworld scene today — `Stadium.draw` returns unless a battle session exists, so a new draw call goes into `VoxelScene.drawScene` (the `HordeGun` precedent at VoxelScene.lua:1277 shows how a mod mesh is drawn there with `glass`/`seams` state handled). Must gate on packs being installed and vanish when the event flag fires.

**Risks.** Multi-pass coverage is where cost hides: shadow map pass, both VR eyes, water reflections. A first version that skips reflections is much smaller.

## 2. Follower Pokémon — Medium

**What exists.** This is the surprise of the assessment: `src/world/PikachuFollower.lua` in the engine is a complete follower implementation — passable NPC, a trail target queued the frame a step commits (`ow.pikachuTrail`), ledge hops, map-connection coordinate offsets, surf/bike hiding, and `setMap` survival via `opts.keepPikachu`. It's Yellow-gated, but the trailing machinery is separable. Lead mon is `Game.save.party[1].species`. The engine's `Sprites.path` already accepts `opts.kind = "overworld"` and `pokemon.sprite` is a live hook, so a companion mod could supply art without patching frozen registries.

**What's missing.** Per-species visuals (the 151-coverage problem — Stadium model, billboarded front pic, or party icon as fallback), and a longer/smoother trail than the single one-cell-behind target Pikachu uses.

**Risks.** FreeMove (1ST/3RD rungs) keeps a continuous position and only fires cell events on crossings, so a cell-chasing follower jogs in right angles behind a player moving on smooth diagonals. Fix: sample a ring buffer from `FreeMove._pos()` (already exposed) when free-roam owns the frame. The follower must not become a collision obstacle.

## 3. NPC schedules — Medium (despawn tier), Large (walking routines)

**What exists.** The engine's mod API has exactly the right levers: `WorldAPI:toggleObject(mapId, objName, visible)` writes save-backed visibility and seamlessly reloads the active map, and the event system fires `world.tod_changed`, `clock.day_changed`, `map.entered`. A "shopkeepers go home at night, houses light up" tier is those two pieces plus a schedule table. For NPCs that actually walk, `HordeMobs.lua` proves the technique: spawn via `addRuntimeObject`, drive `facing/target/moving/progress` directly (deliberately avoiding `scriptMove`, which locks player input), path with a BFS flow field over `map:isWalkableCell`.

**What breaks — and what doesn't.** Dialogue survives: talk scripts are keyed by text constant via `npcAtCell`, not by position. The real hazards are trainer sight lines (position + range based, with a walk-up script), first-listed-NPC ambiguity when two share a cell, blocker NPCs that gate progression, coordinate-triggered scripts, and the fact that moved positions aren't persisted across warps.

**Recommendation.** Ship the despawn/schedule tier first; it's clean, save-safe, and needs no pathing. Treat walking routines as a separate later project.

## 4. Seasons — Medium (voxel world), Large (with 2D parity)

**What exists.** `TerrainAtlas.animate` keeps a private mutable copy of the 128×48 atlas and `patch()` rewrites individual 8×8 tile slots, recoloring grayscale frames through `learnShades`, which learns the shade→color mapping from the baked atlas so it works under both SGB and per-tile GBC palettes. Repainting tree/grass slots by season is exactly this mechanism driven by a season index instead of the animation step. `DayNight` persists its clock through the engine's save events and is the natural place to hang a day counter; the engine separately fires `clock.day_changed`.

**What's missing.** Seasonal specs must be injected into the tileset record (`specsFor` only reads `tileset.animatedTiles` or the TileRenderer default); atlas cache keys multiply per season and need invalidation; and seasonal 8×8 frame art has to be authored — the machinery recolors, it doesn't invent autumn.

**Risks.** This path feeds the voxel terrain only. The flat 2D world draws the engine's own atlas, and `DayTint` is a multiply blend — it can darken but cannot turn green to autumn orange. True 2D parity means engine-side derived art (`src/mods/AssetTransform.lua`) and roughly doubles the project. A voxel-only season that leaves the flat view alone is a legitimate scope.

## 5. Weather — Medium (fog + falling rain), Large (occlusion-correct wet world)

**What exists.** `data/map_atmosphere.lua` is a per-map opt-in atmosphere table (fog + volumetric rays + motes/fireflies), and `ForestAtmos.setOverride(mapId, entry)` is a runtime injection point made for a companion mod. The god-ray shader is a full screen-space march reading the frame's own depth and the sun's shadow map — the template for any weather pass. A particle layer exists (billboard quads, motion as a pure function of time) but has no spawn/kill or collision; falling rain is a new motion function (cheap), splashes and streaks are new work.

**Risks.** Rain occlusion (dry under awnings) can reuse the shadow map, but it's the sun's frustum, not vertical — accept the bias or add a vertical pass. No wetness/ripple hooks in Water.lua; no flat-2D weather path; Android degrades (no readable depth). Also no draw slot for a third-party pass — `ForestAtmos.draw` is called only from VoxelScene/BattleScene, so a companion mod would wrap those.

## 6. Live/ambient wild mobs — Medium–Large

**What exists.** Every hard seam is a supported API, and the mod already exercises most of them. Encounter tables are plain readable data (`Game.data.encounters[mapId].grass.slots`). Suppressing the random roll is a documented hook (`encounter.roll` returning nil — `Horde.lua:637` already does it). Starting a battle with a chosen species/level is first-class: `WorldAPI:startWildBattle(species, level)`. HordeMobs proves spawning and driving up to 14 moving entities. FreeMove routes through the same `onStepComplete`, so free-roam triggering works.

**What's missing.** Per-species visuals (the shared 151 problem); mobs should be `passable = true` with an overlap test (PikachuFollower's trick) rather than solid; spawn/despawn budget per map ring.

**Risks.** `startWildBattle` skips things the organic step path does: it doesn't set the wild-encounter checkpoint origin, and doesn't handle ghost battles or Safari mode — those need explicit handling or excluding those maps. Interaction with LetsGo's auto-enter needs testing. Warp teardown of runtime NPCs is known and solved (`scrubMap`/`dropNpc`).

## 7. Move VFX — Medium for hero moves, Large for coverage

**What exists.** The mod knows the Gen 1 move id at animation time: `Stadium.install` wraps `BattleState.performMove` and reads `moveDef(moveInst).index`. And the compositing insight: the engine's 2D battle animation is already captured to a transparent canvas and stood in the 3D world as a camera-facing card through both mons' cells (`OverworldBattle.animTexture` + `BattleScene.fxCard`) — so 2D animations already read as in-world effects. `StadiumFx.lua` (crossed quads, value-noise flipbooks, bone-anchored) is the template for true 3D effects.

**What's missing.** A per-move-id VFX registry, and a decision per move to keep the 2D card or substitute geometry. The seam is wrapping `OverworldBattle.worldAnim` to suppress the card for moves that have a 3D replacement.

**Risks.** Timing: `performMove` fires ~3 frames before the animation and duration is owned by the engine's AnimPlayer, so a 3D effect must sync to a clock it doesn't own. Recommendation: pick 10–15 hero moves (Hyper Beam, Surf, Thunderbolt, Fire Blast, Dig, Fly) and let the existing card handle the rest — the card already looks intentional.

## 8. Trainer models — Unknown, possibly blocked

**What exists.** The extraction reads exactly one archive (0x920000, 215 entries) and splits it by index: files 0–150 are the Pokémon, files 151–214 are unnamed extras the pipeline's README calls "props, trophies, minigame pieces" (only Surfing Pikachu identified). The word "trainer" appears nowhere in the extraction code. Today the battle shows trainers by suppressing the 3D model and billboarding the 2D trainer pic.

**The gating question.** Whether Stadium's trainer models live in this archive at all. If they're among the 64 extras, the existing parser already handles them (same geo-layout format) and the work is identification + placement + hand-picking animations (they carry no battle table). If not, precedent is discouraging — the README documents searching the whole ROM for the Poké Ball model and finding nothing.

**Recommended first step.** A half-day inventory: run `model_extract/pipeline` with `--only` over files 151–214 and eyeball the glTF output in the generated viewer. That converts "unknown" into "medium" or "blocked" before any commitment.

---

## Suggested build order

1. **Set piece (one Snorlax)** — smallest, most visible, and forces building the "Stadium model in the overworld scene" pass that mobs and followers also need.
2. **Follower** — adapts PikachuFollower + the pass from step 1; establishes the species-visual fallback module.
3. **Live mobs** — reuses both, adds the encounter wiring (which is all supported API).
4. **NPC schedules (despawn tier)** and **weather (fog/rain tier)** — independent of the above, either can interleave.
5. **Seasons (voxel-only)** — self-contained but needs art authored.
6. **Move VFX (hero moves)** — after battle familiarity from earlier work.
7. **Trainer models** — do the half-day archive inventory early (it's cheap), commit only if the models are found.

Note on distribution: several of these reach deeper than `mod.exports.lib` cleanly allows (new draw calls inside `VoxelScene.drawScene`, wrapping `OverworldBattle` internals). A fork is technically simpler; the README's post-v1.6.0 redistribution restriction applies to distributing it, not to building it for personal use. The companion-mod route stays viable if changes upstream are limited to a few explicit hook points.
