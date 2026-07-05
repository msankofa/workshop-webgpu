# World map HUD (minimap terrain + full-screen M map) — combined spec & plan

**Date:** 2026-07-05
**Subsystems:** infra (HUD), multiplayer (shares the finder panel), terrain (data source)

This is a single combined document: the **Spec** section is the design/contract; the
**Plan** section is the task-by-task implementation checklist.

---

## Spec

### Goal

Render the authored terrain map (from terrain-generator-v4 exports) inside the game HUD:

1. **Minimap** — the existing bottom-left finder panel gains a biome-colored, hill-shaded
   terrain background under the compass strip and friend arrows, drawn heading-up so it
   rotates with the view exactly like the friend markers.
2. **Full-screen map on `M`** — a toggleable overlay showing the whole world north-up,
   with the player marker (pointing where you look) and friend markers.
3. Both are available in **solo** as well as multiplayer. In solo the minimap shows just
   terrain + the player; the friend row/arrows are simply empty.

### Data source

The live global `loadedMap` (from `terrain-loader.js`) already exposes everything needed:
`worldX`, `worldZ` (both 1200 in current exports), `resolution` (~88–96), `seaLevel`,
`heightMin/Max`, `biomeNames`, `biomeAt(x,z)` (nearest biome name), `heightAt(x,z)`
(bilinear height). Colors come from `BIOME_COLORS` in `biome-classifier-js.js` — the exact
palette terrain-generator-v4 uses for its own top-down biome preview, so the in-game map
matches the generator preview.

The map only renders when an authored map is loaded (`loadedMap != null`). Procedural
(infinite) terrain has no fixed extent, so with no authored map the minimap keeps its plain
radar look and `M` shows a short "no authored map" note.

### Projection (load-bearing — must match the friend markers)

The finder projects a world offset `(dx,dz)` from the player to minimap screen coords via
`rel = worldBearing(dx,dz) - heading` then `x = cx + sin(rel)*s*dist`,
`y = cy - cos(rel)*s*dist`, with `s = 70/view = 0.5` px/unit, `heading =
playerViewHeading()` (clockwise compass, N=+Z, E=−X). Expanding, this is a linear map of
world XZ to screen; the terrain background must use the **same** map so terrain and dots
stay glued together:

```
X(wx,wz) = cx − s·cosh·(wx−px) − s·sinh·(wz−pz)
Y(wx,wz) = cy + s·sinh·(wx−px) − s·cosh·(wz−pz)
```

The full-screen map is north-up (no heading rotation), same handedness (N up, E right):
`X = cx − scale·wx`, `Y = cy − scale·wz`.

Both are derived once as canvas affine params so the baked map image can be blitted with a
single `setTransform` + `drawImage`, and both are pure functions unit-tested against the
marker formula for exact alignment.

### Module boundary

New module `world-map.js`:

- `bakeMapPixels({ res, cellWorld, sampleBiomeColor, sampleHeight })` → `{ width, height,
  data: Uint8ClampedArray }` — **pure**, testable in Node. Biome color × Lambert hillshade
  from the height gradient.
- `minimapImageAffine({ s, heading, px, pz, cx, cy, wx0, wz0, sxu, szv })` → `[a,b,c,d,e,f]`
  — **pure**, tested to agree with the finder marker formula.
- `bigMapImageAffine({ scale, cx, cy, wx0, wz0, sxu, szv })` and
  `worldToBigMap(wx, wz, { scale, cx, cy })` — **pure**, tested.
- `bakeMapCanvas(loadedMap, { res })` — browser-only wrapper: samples `loadedMap` on a grid,
  calls `bakeMapPixels`, returns `{ canvas, worldX, worldZ, wx0, wz0, sxu, szv }`.
- `createWorldMapOverlay({ getBake, getLocal, getRemotes, getHeading })` — the `M` overlay:
  builds a hidden full-screen panel, `toggle()/close()/isOpen()/update()`.

`environment-viewer.html` keeps the finder's compass/marker code untouched (it was just
fixed) and only **adds** the terrain blit beneath the markers plus the overlay wiring.

### Non-goals

- No points-of-interest / labels / fog-of-war.
- No live terrain edits reflected on the map (bake is one-shot per map load).
- No minimap for procedural terrain.

---

## Plan

### Task 1: `world-map.js` pure helpers + test
- [ ] `bakeMapPixels`, `minimapImageAffine`, `bigMapImageAffine`, `worldToBigMap` (pure).
- [ ] `test-world-map.mjs`: affine agrees with the finder marker formula for several
      headings/positions; bake produces expected color for a flat single-biome grid;
      north-up handedness (north→up, east→right).

### Task 2: `bakeMapCanvas` + `createWorldMapOverlay` (browser parts of `world-map.js`)
- [ ] Grid-sample `loadedMap.biomeAt/heightAt`, build the canvas.
- [ ] Overlay: full-screen north-up map, player + friend markers, close on `M`/`Esc`.

### Task 3: Wire into `environment-viewer.html`
- [ ] Import `bakeMapCanvas`, `createWorldMapOverlay`, `BIOME_COLORS` path via module.
- [ ] Bake after `loadedMap` is ready.
- [ ] Finder: build/update in solo too (drop the solo no-op; hide friend row in solo);
      draw the baked map heading-up under the arrows via `minimapImageAffine`.
- [ ] `KeyM` toggles the overlay; overlay `update()` runs in `animate()` while open.

### Task 4: Docs + log
- [ ] `docs/subsystems/infra.md`: new "World map HUD" section (bake, affines, overlay).
- [ ] `docs/subsystems/multiplayer.md`: finder section notes terrain bg + solo availability.
- [ ] `CLAUDE.md` infra row: add `world-map.js`.
- [ ] `agent_log.csv`: append one row.
