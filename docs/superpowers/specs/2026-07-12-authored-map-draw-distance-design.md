# Authored-map draw distance — design

## Purpose

On authored/imported terrain maps (`loadedMap` set), the "Draw distance (chunks)" slider
(`terrain.renderRadius`) does not do what its name implies. It only feeds the camera
far-plane/fog calculation and the default for grass's placement window. The ground mesh,
water, trees, and — mostly — grass/plants/rocks are unaffected by it; each of those already
has its own independent visibility radius, and the ground mesh and water have none at all
(both render out to the edge of the map regardless of camera distance).

Goal: turn this into one traditional, Minecraft-style draw distance control for authored
maps — drag it down, and everything (ground, water, trees, grass, plants, rocks) actually
disappears past that radius, with a soft fade rather than a hard pop. Existing per-system
radius sliders (grass, plants, boulder/scree/deadfall/mushroom, trees) stay as independently
tunable *maximums that cannot exceed the new master value* — turning the master down clamps
everything; turning an individual slider down (below master) still works exactly as today.

Scope: **authored maps only** (`loadedMap` truthy). Procedural (infinite) terrain's existing
"Draw distance (chunks)" slider and CDLOD `setViewDistance` behavior are unchanged.

## Current state (for reference)

| System | Has a distance param today? | Bounded by anything? |
|---|---|---|
| Ground mesh (`loadedMap.root`) | No | No — always fully rendered |
| Water (`water.js` clipmap) | `lodR0`/`lodR1` (LOD density transitions only) | Outer ring clips to map edge (`extentX/extentZ`), not camera distance |
| Trees (`forest-gpu.js`) | `maxDrawRadius` (perfAB-only slider, default ≈875) | Hard cutoff, no fade |
| Grass (`grass-compute.js`) | `grassRadius` slider (default 344) | Soft dithered fade |
| Plants (`plants-gpu.js`) | `plantCullRadius` slider (default 150) | Soft dithered fade |
| Rocks/deadfall/mushrooms (`dressing-gpu.js`) | Per-class `*CullRadius` sliders (defaults 110–300) | Soft dithered fade |

Trees are the outlier: a hard cutoff, not a fade. Bringing them under the master is also an
opportunity to give them the same soft-fade treatment as everything else, for visual
consistency.

## Design

### 1. Master param

New `terrain.drawDistance` (world meters). On authored maps, this **replaces** the existing
"Draw distance (chunks)" slider in place (same UI slot, same underlying `terrain` param
object) rather than adding a second slider:

- Range 50–1000m, step 10, default **900m** — high enough that nothing is clipped tighter
  than today's largest existing default (trees, ≈875m) until the user actually lowers it.
- Procedural terrain keeps the current chunk-based slider and label unchanged; this is an
  `if (loadedMap) { ... } else { ... }` branch at the same call site
  (`environment-viewer.html:3296`).
- `terrainSystem.params.renderRadius` (consumed internally by `activeTerrainChunks()` for the
  water/decoration resync-trigger window, and by `mapGrassRadiusChunks`'s fallback default) is
  derived automatically: `Math.ceil(terrain.drawDistance / chunkSize)`. Nothing that currently
  reads `renderRadius` needs to change; it just receives a value driven by the new slider
  instead of being set directly.

### 2. Ceiling on existing per-system radii

For each of the 7 existing radius params — `grassRadius`, `plantCullRadius`,
`boulderCullRadius`, `screeCullRadius`, `deadfallCullRadius`, `mushroomCullRadius`, and
trees' `maxDrawRadius` — the value actually pushed to its GPU system becomes:

```js
effectiveRadius = Math.min(individualParam, terrain.drawDistance)
```

recomputed whenever either the master slider or that individual slider changes. Each
individual slider's own `max` attribute is also live-clamped to the current master value, so
the UI thumb physically can't be dragged past the ceiling. Individual defaults/values are not
rewritten — they simply can't produce an effective radius larger than the master.

Trees additionally gain a soft dithered fade band before their existing `maxDrawRadius` hard
cutoff (matching grass/plants/rocks' `cullStart`/`cullRadius` pattern, `cullStart` = 0.7 ×
radius, the same ratio `dressing-gpu.js` already documents as its convention). `maxDrawRadius`
stays wired into the master-ceiling clamp regardless of which panel it's exposed on — whether
it stays perfAB-only or gets promoted to the main "Trees" panel is an implementation-time call,
not a design constraint.

### 3. Ground mesh discard (new)

The ground currently has no distance handling and, off the splat-texture path, uses a plain
`THREE.MeshStandardMaterial` rather than a TSL node material. Bringing it under the master
requires:

- Standardizing ground materials on `MeshStandardNodeMaterial` on authored maps (the
  splat-texture path in `terrain-textures.js` already does this; the non-splat default path in
  `terrain-loader.js` needs to move to it too).
- A new small shared helper, `terrain-draw-distance.js` (mirrors the existing
  `forest-cull.js`/`light-cluster.js`/`post-grade.js` convention of centralizing math used by a
  TSL node graph), exposing the fade/discard math as both a TSL node-graph builder and a pure
  JS twin for Node testing.
- The discard tests XZ distance from the live camera position (matching the distance basis the
  other cull systems already use, so the ground's fade ring visually lines up with
  trees/grass/plants/rocks as the player walks) against `terrain.drawDistance`, with the same
  stochastic dithered fade over the last 30% of the radius (`cullStart = 0.7 × drawDistance`)
  rather than a hard pop.
- Applied once at load time (`environment-viewer.html`, after `loadedMap` materials exist),
  iterating `loadedMap.root` and injecting the discard node into every material found —
  splat and non-splat alike — via the shared helper so both paths stay visually identical.

### 4. Water discard (new)

Water already has no distance cutoff — its clipmap's outer ring extends to the map edge
(`water.js:966-967`, clipped only by `extentX/extentZ`, not camera distance). Water has no
existing individual override slider (no `waterDrawDistance` today), so it follows the master
1:1, same as the ground:

- The same shared discard helper is applied to `water.js`'s surface/caustic TSL materials,
  using `terrain.drawDistance` directly (no per-system ceiling logic needed here, since there's
  nothing to clamp against).
- Optional/nice-to-have, not required for correctness: also clamp the outer ring's CPU-side
  extent build (`water.js:388-394`'s existing `extentX/extentZ` clamp logic) to
  `min(mapExtent, drawDistance + margin)` so triangulation work isn't wasted on ring geometry
  that the shader will immediately discard. Can be deferred to a follow-up if it doesn't fall
  out naturally during implementation.

### 5. Camera far plane / fog

`updateDrawDistance()` uses `terrain.drawDistance` directly as `terrainFar` on authored maps
(replacing the old `chunkSpan = (renderRadius+1) * chunkSize * 2` approximation), so fog and
the camera's far clip plane line up with the new visible edge exactly instead of an
overestimate.

## Out of scope

- Procedural (infinite) terrain — unchanged.
- Shoot-house-specific geometry beyond what already rides `dressing-gpu.js` — no separate work.
- Multiplayer — this is a local rendering/visibility setting, not simulation state; no sync
  needed.

## Testing

`terrain-draw-distance.js`'s fade/discard math and the `effectiveRadius = min(...)` clamp
logic are pure functions — testable in Node without a GPU, following the existing
`forest-cull.js` pattern. New `test-terrain-draw-distance.mjs` covers:
- clamp behavior (individual > master, individual < master, individual == master)
- fade-band edges (fully inside `cullStart` → always kept; fully beyond `cullRadius` → always
  discarded; between the two → dither probability matches the existing convention)

## Docs to update

- `docs/subsystems/terrain.md` — new `drawDistance` master param, ground discard.
- `docs/subsystems/vegetation.md` — ceiling clamp on `grassRadius`/`plantCullRadius`, trees'
  new fade band.
- `docs/subsystems/rocks.md` — ceiling clamp on the four dressing `*CullRadius` params.
- `docs/subsystems/water.md` — new discard, master-driven (no individual override).
- `agent_log.csv` — one row (likely `subsystem=multi`, since this spans terrain/vegetation/
  rocks/water).
