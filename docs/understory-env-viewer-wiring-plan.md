# Understory env-viewer wiring plan (rocks + deadfall onto dressing-gpu)

> **STATUS 2026-07-05: WIRING DONE.** The `DRESSING_MODE` block is live in
> `environment-viewer.html` (rocks + deadfall on one shared `dressing-gpu.js` host, separate
> `dressingIndex` collision, canopy from the live tree `trunkIndex`, `dressingGpu` profiler
> phase). Module script syntax-checks clean; 9 Node suites green. **Only browser verification
> (the checklist at the bottom) remains.** Known gap: rock textures not loaded yet (flat-grey
> fallback, so the S1 detail-normal is inert until textures are wired).

Status checkpoint written 2026-07-05. All understory MODULE work is landed + green (9 Node
suites). The terrain team's merged-plan **#2 is already DONE** — no action needed there.
What remains is **wiring into `environment-viewer.html`** (browser-only, can't be Node-tested)
plus in-browser WebGPU verification. This doc is the executable spec for that.

## What's already done (do NOT redo)
- **#2 terrain material / F3 moss fold-in — DONE by terrain team.** `terrain-textures.js`
  `makeSplatMaterial` (~line 486–569) builds one `MeshStandardNodeMaterial` with DataArrayTexture
  triplanar blending over `aSplatWA/WB` (feathered top-4 weights) + `aDress` (x=moisture from
  `moistureProxyForBiome`, y=upness, z=cavity reserved). It composes the shared `mossWeight()`
  via dynamic `import('./moss-tint.js')` (line 613–615, `mossWeightFn = mossMod.mossWeight`),
  cavity = `1 - AO`, brush = hash, scaled by `uniforms.mossStrength`. Graceful fallback to
  legacy multi-material on throw. **This is the SAME moss law + SAME moisture proxy that
  rocks.js/deadfall.js use** → one SurfaceField, one mossWeight, one moisture proxy. Consistency
  confirmed. Only their remaining "bug fixing" is theirs to finish.
- All four understory phases (foundation, plants, rocks, deadfall) + the Phase-5 review fixes
  (B1 blocker, S1/S2/S3/S4/S5, nice-to-haves #1/#2/#3/#9). All green.

## Key wiring facts (verified in environment-viewer.html)
- **heightAt** = `terrainHeight` (canonical CPU height query; line 700). Pass this to placement
  and to `createDressingGPU`.
- **surfaceFieldAt** = `loadedMap.surfaceField(x,z)` (exposed at terrain-loader.js:368; O(1),
  safe in placement loops). Pass to `rockPlacementRecords` / `deadfallPlacementRecords`.
- **biomeAt** = `loadedMap.biomeAt` ; **densityAt** = `loadedMap.grassDensityAt`.
- **mapChunkSize()** = `terrainSystem.params.chunkSize || 30` (defined line 1614 inside the
  forest IIFE — for the rocks/deadfall block define a local `const dressingChunkSize = () =>
  terrainSystem.params.chunkSize || 30`, don't reach into the forest scope).
- **Collision:** single shared `trunkIndex` (collision.js `createTrunkIndex`, created line 917,
  keyed by `terrainSystem.params.chunkSize`). Trees register via
  `trunkIndex.setTrunks(chunkKey, [{x,z,r}])` (line 1662) with `r = TRUNK_RADIUS_PER_SCALE(1.2)*scale`,
  and `trunkIndex.clearTrunks(key)` on chunk unload. Player push-out reads `trunkIndex.resolve`
  (line 3919). **Merge boulder + stump + log circles into THIS index**, keyed by the SAME
  `mapChunkSize()` grid the placement `chunkKey` uses (verify the placement chunk grid ==
  trunkIndex chunkSize; if the dressing window uses a different chunkSize, regroup circles by
  the trunkIndex grid before setTrunks — do NOT blindly reuse record.chunkKey). Scree and
  mushrooms get NO collision.
- **Per-frame update:** in `animate()` (~line 4029–4030) add
  `if (dressingGPURef) await frameProfiler.timeAsync('dressingGpu', () => dressingGPURef.update())`.
  Follow the plants trick (lines 3140–3142): monkeypatch `dressingGPU.update` to call
  `syncToFocus(false)` + drain build queue before the raw update, so streaming rides the render loop.

## The pattern to replicate (from the PLANTS_MODE block, lines 2977–3154)
1. Lazy import at wire time: `createRockPalette`+`rockPlacementRecords` (rocks.js/rocks-placement.js),
   `createDeadfallPalette`+`deadfallPlacementRecords`+`makeCanopyIndex` (deadfall*.js),
   `createDressingGPU` (dressing-gpu.js). Add `?v=` cache-bust suffixes.
2. `Object.assign(params, { ...rock/deadfall densities, cull radii, budgets })`.
3. Build palettes with `masterSeed: MASTER_SEED`.
4. `const dressingGPU = createDressingGPU({ renderer, camera, heightAt: terrainHeight, groups })`
   where `groups` = one entry per rock variant / scree / deadfall type (each `{ geometry,
   material, cap }`). Materials: `buildRockMaterial({textures, normalBase: nodes.nWorld,
   moistureNode, brushScale})` and `buildDeadwoodMaterial({moistureNode, nodes})` /
   `buildMushroomMaterial(...)`. **Rocks/deadfall groups: pass `nodes.nWorld` as normalBase /
   nodes so detail-normal (S1) and moss-upness (S5) use the instance-rotated normal.** Mushroom
   groups: `castShadow: false` (plan requirement — set here, it's not encoded in the module).
   Respect budgets: boulders ≤512 TOTAL split across groups (`Math.floor(512/boulderGroupCount)`),
   scree ≤16000, deadfall+fungi ≤1000. See rocks.md integration snippet (now budget-correct).
5. `scene.add(...dressingGPU.meshes)`; `dressingGPURef = dressingGPU`.
6. Windowed chunk streaming: copy `plantChunksForPlacement` / `plantWindowKey` /
   `enqueue*` / `syncToFocus` / `processBuildQueue` (lines 3021–3133). Records:
   `rockPlacementRecords([chunk], rockParams, terrainHeight, loadedMap.surfaceField, {trunkQuery})`
   and `deadfallPlacementRecords([chunk], dfParams, terrainHeight, loadedMap.surfaceField, {canopyAt})`.
   `canopyAt` from `makeCanopyIndex` built over the forest trunk positions (deadfall wants
   logs/stumps UNDER canopy). `dressingGPU.setChunks(batch, clearKeys)` — batch is
   `Map<chunkKey, records[]>`.
7. On each chunk build/clear, update `trunkIndex.setTrunks(key, boulderCirclesFromRecords(recs)
   .concat(stumpCirclesFromRecords(recs), logCirclesFromRecords(recs)))` and
   `trunkIndex.clearTrunks(key)` on unload. NOTE trees already own trunkIndex per chunk — if a
   chunk has BOTH trees and boulders, setTrunks REPLACES; must MERGE tree circles + dressing
   circles in one setTrunks call, or give dressing its own index. **Cleanest: give the dressing
   host its OWN `createTrunkIndex` (dressingIndex) and have the player push-out (line 3919)
   resolve against BOTH** — avoids the tree/dressing setTrunks clobber entirely. Prefer this.
8. Add sliders (moss strength on terrain is `uniforms.mossStrength`; rock/scree/deadfall density,
   cull radius, moisture) mirroring the plant sliders (lines 3149–3154), each calling a
   `regenerateDressingGPU(true)`.
9. Mode flags: `ROCKS_MODE`/`DEADFALL_MODE` from URLSearchParams defaulting to `'gpu'` (or a
   single `DRESSING_MODE`), gating the whole block like `PLANTS_MODE` (line 2977).

## Browser verification (Fable's checklist — do after wiring, via Claude-in-Chrome + serve.py)
Start `python serve.py`, open `http://127.0.0.1:8080/environment-viewer.html`, load an authored
map. Confirm: rocks smooth (no d20 facets), detail normal map visibly active (toggle normal
texture → lighting changes = S1 proof), no floating boulders on steep scree, scree concentrated
on rocky/steep ground (B1 proof), logs lie ALONG slopes (S2 proof — find a yawed log on a ramp),
moss on tilted logs' true top (S5), shelf fungi on mossy/rotten only, mushrooms cast no shadow,
desert/steep = zero deadfall, plants clumped on authored map (S3). Perf HUD: ≤ +1.0 ms median
frame-ms per phase, ≤ ~24 added draws/phase (7 rock + 11 deadfall groups default), instance caps
respected, no WebGPU bind-group errors with clustered lights + CSM (16 samplers/stage cap: rock =
3 triplanar + shadow/env/lighting). Player collides with boulders/stumps/logs, NOT scree/mushrooms.
Capture screenshots + HUD numbers for the user's aesthetic taste call.

## Risks / open decisions carried into wiring
- **trunkIndex clobber (step 7):** recommend a SEPARATE dressingIndex over merging into the tree
  index. Confirm player push-out resolves both.
- **DataArrayTexture for rock albedo/normal:** rocks.js triplanar samples textures; on WebGPU use
  LinearFilter + generateMipmaps=false (DataArray mip gen is broken). Verify rock textures exist
  under textures/ or fall back to flat-color material.
- **Plants→dressing migration is OPTIONAL/deferred** — plants already ship on plants-gpu.js and
  work; only migrate if the shared host is a clear win. Not required for this pass.
