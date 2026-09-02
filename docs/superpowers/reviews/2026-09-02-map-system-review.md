# Map system review — what it would take to add a map to base-game.html

Reviewer pass over `world-map.js`, its two consumers, and `base-game.html`'s current state.
No code changed.

## What world-map.js is today

`world-map.js` (352 lines, not the 295 the doc claims — see drift section) is two things stitched
together:

- **Pure math** (`bakeMapPixels`, `minimapImageAffine`, `bigMapImageAffine`, `worldToBigMap`,
  `overlayColorizer`), unit-tested in `test-world-map.mjs`. This part is genuinely reusable: it
  takes sampler callbacks and screen-space parameters and returns pixels or affine transforms. It
  has no dependency on `environment-viewer.html` or any specific terrain system.
- **Browser bake + overlay** (`bakeMapCanvas`, `createWorldMapOverlay`), which is where the
  design commits to one terrain model.

`bakeMapCanvas(loadedMap, { res, overlayId })` (`world-map.js:171-211`) samples a `res × res`
grid (default 384) **once**, over a fixed world extent `loadedMap.worldX × loadedMap.worldZ`
centered at the origin, and bakes it into a static canvas plus a second `terrainDetailCanvas`
(contour lines + directional shading, `world-map.js:190-206`). Nothing re-bakes unless the caller
calls it again (`rebakeWorldMap()` in the host page, only on map load or overlay-layer change).
This is the load-bearing assumption: **the whole map is finite, static, and known up front.** The
`loadedMap` argument is the object `terrain-loader.js`'s `loadTerrainMap()` returns — a GLTF-baked
authored map with `heightAt`, `biomeAt`, `surfaceField`, `grassDensityAt`, `treeDensityAt`,
`worldX`, `worldZ`, `resolution`, `seaLevel` all defined and answerable everywhere, synchronously,
with no "not loaded yet" state (`terrain-loader.js:118-198`).

`createWorldMapOverlay({ getBake, getLocal, getRemotes, getHeading, getFacing })`
(`world-map.js:232-352`) builds a hidden `#world-map` full-screen `<div>`, appended straight to
`document.body`, with its own injected `<style>` block. It owns:
- the north-up projection and blit of the baked canvas + contour canvas,
- player/remote arrows (`drawArrow`, north-up, colored green/yellow),
- mouse hover readout (world X/Z under the cursor),
- wheel-to-zoom (0.7×–4×),
- `toggle()/close()/isOpen()/update()`.

It does **not** own opening/closing input (no keybinding inside the module), does not own the
minimap/heading-up HUD (that's a second, separate consumer of the same bake + the pure
`minimapImageAffine`, built entirely inline in the host page), and does not own the layer-picker
UI (`#mp-map-menu`, also inline in the host page). So "is it a module with a clean API, or
entangled with `environment-viewer.html`?" — the pure math is clean; the two browser functions are
clean in the sense of taking injected getters rather than reading globals, but the **data model
they're built around (one finite authored GLTF map, baked once) is not general** — it is
`environment-viewer.html`'s data model, exported into a file.

Nothing in `world-map.js` is broken as far as it's tested — `test-world-map.mjs` passes and the
math checks out. The gap is scope, not correctness.

## Where the doc has drifted from the code

`docs/subsystems/infra.md`'s `world-map.js` section (lines 51, 250-297) has three concrete drifts:

1. **`createWorldMapOverlay`'s documented signature includes a parameter that does not exist.**
   The doc (`infra.md:263`) writes:
   ```js
   export function createWorldMapOverlay({ getBake, getLocal, getRemotes, getHeading, getFacing, getOverlayLabel })
   ```
   The actual export (`world-map.js:232`) has no `getOverlayLabel`:
   ```js
   export function createWorldMapOverlay({ getBake, getLocal, getRemotes, getHeading, getFacing }) {
   ```
   The doc's prose compounds this: `infra.md:287-289` says `update()` "labels the active overlay
   via `getOverlayLabel`." There is no overlay label drawn anywhere on the M map in the current
   code — the only text `draw()` renders is the compass `N` and the hover coordinate tooltip
   (`world-map.js:300-326`). Layer switching happens entirely through the separate `#mp-map-menu`
   built inline in the host page (`environment-viewer.html:812-897`), which never touches the M
   map's own label. Either this was planned and dropped, or removed and the doc wasn't updated —
   either way, a caller reading the doc would pass a callback the function silently ignores.

2. **`bakeMapCanvas`'s documented return shape omits `terrainDetailCanvas`.** The doc
   (`infra.md:283-285`) says it returns `{ canvas, worldX, worldZ, wx0, wz0, sxu, szv, res,
   overlayId }`. The actual return (`world-map.js:207-211`) also includes `terrainDetailCanvas` —
   the contour-line/relief layer built at `world-map.js:190-206` — and both host pages draw it
   directly on top of `canvas` in two places each (minimap: `environment-viewer.html:969-970`;
   M map: `world-map.js:283-284`). A consumer who built a bake shape from the doc alone would get
   flat, contour-less terrain and not know why.

3. **File line count is stale**: the Files table (`infra.md:51`) says 295 lines; the file is
   352. Minor, but it's one more sign the doc wasn't touched when the contour/detail-canvas code
   (which is clearly a later addition — the module's own header comment doesn't mention it either)
   landed.

Everything else in the doc — the pure-function list, `MAP_OVERLAYS`/`overlayColorizer`'s behavior,
the `minimapImageAffine`/`bigMapImageAffine` projection description, the wiring narrative in
`environment-viewer.html` (`rebakeWorldMap`, `#mp-dock`, **M** toggle, cursor-free pause on open) —
checks out against the code as read.

## Only two pages use it, wired identically

`environment-viewer.html` and `environment-viewer-v2.html` both import `world-map.js`
(confirmed by grepping the whole repo, excluding `node_modules`). Nothing else does — not
`bot-viewer-v3.html`, not any `demos/` page, not `base-game.html`.

The two are essentially a copy-paste fork: same `worldMapBake`/`mapOverlayId`/`rebakeWorldMap()`
names, same `#mp-map-menu` layer-picker markup, same `createWorldMapOverlay({...})` call shape,
same **M** keybinding wiring (`environment-viewer.html:8300-8309`,
`environment-viewer-v2.html:14082-14091`). There is exactly one integration pattern to learn from,
not two independent ones — v2 does not do anything differently worth noting.

That wiring, in one place (`environment-viewer.html`):
- `rebakeWorldMap()` (`:746-751`) calls `bakeMapCanvas(loadedMap, { overlayId: mapOverlayId })`
  after `loadedMap` is set by `loadTerrainMap()`/`createShootHouse()`, and is a no-op (`worldMapBake
  = null`) when there's no authored map (`:1210-1243`).
- The heading-up minimap (`#mp-dock`) blits `worldMapBake.canvas` + `.terrainDetailCanvas` under
  hand-drawn compass rings and arrows, using `minimapImageAffine` for exact terrain/marker
  alignment (`:958-975`).
- **M** toggles `worldMapOverlay` and enters `fpsMode`'s cursor-free pause on open
  (`:8300-8309`).
- The layer menu (`#mp-map-menu`) sets `mapOverlayId`, re-bakes, and calls
  `worldMapOverlay.update()` (`:890-897`).

## What base-game.html already has

`base-game.html` has no minimap or map overlay of any kind today (grepped for `mp-dock`,
`mp-finder`, `compass`, `minimap` — no matches). It also uses a **completely different terrain
system** from the one `world-map.js` was built against: `base-game-terrain.js` /
`terrain-system.js` / `terrain-source-v5.js` stream chunks and biome/height data in a **window
around the player** (`fieldWindow()`, `contactWindow()` — every sample outside the resident window
returns `null`, `base-game-terrain.js:435-479`). There is no `worldX`/`worldZ` bound, no
`heightAt(x,z)` that answers for arbitrary far-away coordinates, and no single finite grid to bake
once. `terrain-project-v5.js`'s own name (`migrateProjectToUnbounded`) says the same thing from the
authoring side.

| A map wants | Where it lives in base-game.html today | Ready to hand to a map? |
|---|---|---|
| Local player position | `playerController.getPosition()` (`base-game-player-controller.js:517-519`) — global coords (module convention, confirmed by every call site wrapping it in `worldCoordinates.toGlobal`/`toRenderLocal` at the render edge only) | Yes, directly |
| Local player heading | `playerView.yaw` | Yes, directly |
| Remote players | `remotePlayers.players` (`base-game-remote-players.js:179`, a public `Map` getter) → `record.sample.{position[x,y,z] global, yaw, team, health}` | Yes, directly |
| NPC bots | Same `remotePlayers.players` map — bots ride the same snapshot channel as human players, flagged `record.sample.npc === true` (`base-game-remote-players.js:162`) | Yes, directly — no separate bot channel to wire |
| Drones (including the Sentinel, up to 1500 m via `sentinelHighAlt` at `base-game.html:520`) | `droneView.drones` (`base-game-drone-view.js:39`, Map) → `rec.latest.p` / `rec.track.latest.position`, global, plus `rec.kind`, `rec.owner`, `rec.hp` | Yes, directly |
| Ground vehicles | Same `droneView.drones` map — `createBaseGameDroneView` merges `BASE_GAME_DRONE_DEFS` and `BASE_GAME_VEHICLE_DEFS` into one `CRAFT_DEFS` table and `ingestRecords` pushes both drones (`raw.d`) and vehicles (`raw.body`) into the same `drones` Map (`base-game-drone-view.js:31,89-106`) | Yes, directly — same map as drones |
| Terrain height/biome for a bake | `terrain.groundHeight(x,z)` / `terrain.biomeAt(x,z)` etc. — but **only inside the streamed window**, returns `null` outside it (`base-game-terrain.js:437-479,657-660`) | **No** — no bounded, globally-answerable sampler exists; this is the real gap |
| A finite "world extent" to bake an image over | Does not exist — the terrain is unbounded by design | **No** — `bakeMapCanvas`'s whole model (one `res×res` bake over `worldX×worldZ`) does not apply |
| Floating-origin awareness | `worldCoordinates` (`world-coordinates.js`), rebase distance 8192, snap 1024, exposed via `.getOrigin()`/`.toGlobal()`/`.toRenderLocal()`/`.onRebase()` | N/A — see coordinate section below; every position above is already **global**, which is what a map wants |

The good news dominates the table: every entity feed (player, remotes, bots, drones, vehicles) is
already available as flat, ready global `[x,y,z]` positions through APIs that already exist for
other reasons (rendering, hit-testing, the drone chase camera). The only missing piece is terrain
sampling for a bake, and that's missing because base-game's terrain genuinely doesn't have the
shape `world-map.js` needs — not because nobody built an accessor.

## The plan to add a map to base-game.html

Smallest thing that works first, then layer up:

1. **Reuse the pure math, not the browser functions.** Import `minimapImageAffine`,
   `bigMapImageAffine`, `worldToBigMap`, `bakeMapPixels` from `world-map.js` directly — they take
   plain callbacks and have no opinion about where the samples come from. Do **not** import
   `bakeMapCanvas` or `createWorldMapOverlay` as-is; both are built around
   `terrain-loader.js`'s bounded `loadedMap`, which base-game does not have.

2. **Ship compass + entity dots with no terrain bake at all.** A heading-up minimap panel (same
   visual language as `environment-viewer.html`'s `#mp-dock`: compass strip, range rings, arrows
   for local/remote/bot/drone/vehicle) needs nothing from terrain — only the position feeds already
   in the table above. This alone is useful (it's what multiplayer players actually want first:
   where is everyone) and ships without touching the terrain-sampling gap at all. `drawArrow` from
   `world-map.js:215-228` and the ring-drawing block at `environment-viewer.html:977-998` are
   copyable as-is (small enough to inline rather than import, since they're not exported).

3. **Add the full-screen north-up map (M) as the same dots, no terrain image yet.** Build a
   `base-game-world-map.js` (own module, not a wrapper around `createWorldMapOverlay`) that owns a
   hidden `#world-map` panel, uses `worldToBigMap`/`bigMapImageAffine` for projection, and draws
   arrows for every player/bot/drone/vehicle plus a plain background. This gets the M key doing
   something real before terrain sampling is solved.

4. **Add a windowed terrain bake around the player, re-baked as the player moves**, instead of
   `bakeMapCanvas`'s one-shot global bake. Use `terrain.groundHeight(x,z)` / `terrain.biomeAt(x,z)`
   (`base-game-terrain.js:657,441`) sampled over a fixed-size square centered on the player's
   current global position (e.g. a few hundred meters per side, matching what the streamed field
   window already keeps resident — `fieldPost`/`contactPost` in `BASE_GAME_TERRAIN_DEFAULTS`,
   `base-game-terrain.js:26-72`), passed through `bakeMapPixels` (which is agnostic to bounded vs.
   windowed — it just wants `sampleHeight(ix,iz)`/`sampleBiomeColor(ix,iz)` callbacks). Re-bake on
   a timer or distance threshold (e.g. every 50 m of player movement), not every frame — this
   mirrors how `rebakeWorldMap()` is itself only called on map load / layer change today, not
   per-frame. Handle `null` samples (outside the resident field window) by falling back to a flat
   "unexplored" tile color rather than crashing — `terrain.fieldsReady`/`contactReady` predicates
   already exist for exactly this check (`base-game-terrain.js:709,713`).

5. **Key binding: `M`.** Grepped the whole keydown handler block in `base-game.html`
   (`:4943-5007`) against the taken-key list — `9, R, F, X, B, N, E, G, H, L, T, V, Z, C, Q, space`
   are all in use (Digit9 dev-gun cycle, V/T/H/G/E/F/X/B/N/L/C/Z/Q as listed). **`M` is free** —
   no `KeyM` binding exists anywhere in the file. It's also the obvious choice because it's the
   convention already established in both `environment-viewer.html` and `environment-viewer-v2.html`
   — following "look at how the other pages already do it."

6. **Open/close should not fully pause gameplay.** `base-game.html`'s existing pause machinery
   (`gameplayPaused`, `openPauseMenu()` at `:4864-4871`) stops local physics and is meant for the
   real pause menu — using it for the map would freeze the local player's body in an online game
   while other players keep moving, which is wrong for a live map. The correct model is
   `environment-viewer.html`'s own pattern at open: `document.exitPointerLock?.()` to free the
   mouse, keep simulation running, and let the existing pointer-lock-gated input checks (already
   used throughout `base-game.html`, e.g. `:5012,5030,5037`) naturally stop WASD-look/fire input
   while the cursor is free. On close, `requestPointerLock?.()` again (mirrors `:3993`).

## What has to be invented

Kept to the minimum, since almost everything reusable already exists:

- **A windowed terrain bake function** (step 4 above) — this is the one genuinely new piece.
  Before inventing it from scratch: checked `terrain-clipmap-window.js` and `terrain-field-window.js`
  (the CDLOD system's own windowed-sampling abstractions) as a possible pattern to copy — they
  already solve "sample a moving window of a streamed field," just for render geometry rather than
  a flat map image. The new bake function should follow the same windowing shape (query the field
  window, treat `null` as unresolved) rather than inventing a second convention.
- **A small `base-game-world-map.js` module** wiring `bakeMapPixels`/`minimapImageAffine`/
  `bigMapImageAffine` to base-game's entity feeds and the windowed bake — new file, but almost
  entirely glue over existing pieces (drawArrow, the compass-ring drawing, the panel DOM/CSS can
  all be copied from `world-map.js`/`environment-viewer.html`'s inline blocks rather than
  reinvented).
- **Nothing new needed for entity feeds, coordinates, or keybinding** — all covered above by
  existing APIs.

## Coordinate system: what a map must do about the floating origin

`base-game.html` uses `world-coordinates.js`'s `createWorldCoordinateSpace()` (instantiated at
`base-game.html:1147`), which rebases `renderOrigin` when the player gets more than 8192 units from
it (snapped to 1024, `world-coordinates.js:71-134`). Every position surfaced in the table above
(`playerController.getPosition()`, `remotePlayers.players[...].sample.position`,
`droneView.drones[...].latest.p`) is **already global** — render-local conversion only happens at
the point a mesh is placed (`worldCoordinates.toRenderLocal(...)`, e.g.
`base-game-remote-players.js:164`, `base-game-drone-view.js`'s pose step). A map should:

- **Always read the global position fields directly** (as listed in the table) and never the
  `.position`/`.matrix` of a rendered Three.js mesh, which is render-local and jumps by the rebase
  delta whenever `worldCoordinates` fires `onRebase`.
- **Never itself call `toRenderLocal`.** A map draws in its own 2D screen/canvas space
  (`minimapImageAffine`/`bigMapImageAffine`/`worldToBigMap` all take world `x,z` and a
  scale/center, not Three.js coordinates) — it has no reason to touch the 3D render-local frame at
  all, so a rebase event is invisible to it by construction, as long as every sample source it
  reads is the global one.
- **The windowed terrain bake (step 4) should center on the player's global position**, not on
  `worldCoordinates.getOrigin()` — the origin is a rendering implementation detail that jumps in
  1024-unit snaps; the bake should track the player smoothly.
- This is actually simpler than `environment-viewer.html`'s situation: that page has no floating
  origin at all (single fixed world), so its `world-map.js` wiring never had to think about this.
  Base-game's map gets it for free by consuming the same global-coordinate APIs every other
  base-game system already consumes for the same reason.

## Risks and open questions

- **Windowed bake staleness/pop.** Re-baking a moving window means the edges of the visible map
  are always slightly behind the streamed field, and a fast-moving player (in a vehicle or drone)
  could outrun the bake's re-bake cadence. Needs a tuning pass once it's in a browser — no way to
  size this from reading code alone.
- **Bake cost per re-bake.** `bakeMapPixels` computes a hillshade gradient per cell
  (`world-map.js:56-65`) plus the separate contour-detail pass (`world-map.js:192-206`) — cheap at
  environment-viewer's one-shot-per-map-load cadence, unmeasured at "every 50 m of player
  movement" cadence. Should be profiled with `frame-profiler.js` (already the repo convention) once
  built, not assumed cheap.
- **What "unexplored" should look like** where the field window hasn't streamed yet (e.g., a
  freshly-opened map covering ground the player hasn't been near). Fog-of-war-style gray, or just
  not draw those cells — a product decision, not a technical one, but it changes the bake function's
  contract (does it return partial data or must the caller pre-filter).
- **Drone/vehicle altitude on a 2D map.** The Sentinel flies up to 1500 m (`base-game.html:520`);
  north-up/heading-up projections are both flat XZ, so altitude has no visual representation beyond
  maybe an icon variant or an altitude readout on hover/select — worth deciding before building the
  icon set, not after.
- **Scope of MAP_OVERLAYS.** The seven overlay layers (`biome`/`elevation`/`slope`/`material`/
  `water`/`grass`/`tree`) are all things `terrain.js`'s streamed field can, in principle, answer
  (`biomeAt`, `treeDensityAt`, `surfaceFieldAt` already exist at `base-game-terrain.js:441-479`) —
  but wiring every layer is more scope than the plan above assumes. Start with `biome` only (step
  4) and treat the other six as follow-on, not part of a first landing.
