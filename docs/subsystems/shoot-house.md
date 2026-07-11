# Shoot House Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#shoothouse)

## Purpose

A standalone, procedurally generated **shoot house** (CQB kill-house) map for testing the FPS
movement and shooting mechanics in isolation from every environmental subsystem. It loads
through the same map path as an authored map (picked from the start screen), but renders **no
terrain, grass, forest, water, plants, or scree** — just an enclosed building under the night
sky, lit by controllable interior point lights. The building is **mirror-symmetric** about the
`x=0` plane and **seeded** (`?seed=`), so a given seed reproduces the layout.

Design spec: `docs/superpowers/specs/2026-07-10-shoot-house-map-design.md`.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `shoot-house-layout.js` | **Pure, no Three.js.** `generateShootHouse(seed, opts)` → layout descriptor (primitives, lights, spawn, bounds). Seeded mulberry32 PRNG; generates the right half, mirrors across `x=0`. Node-testable. | 239 |
| `shoot-house.js` | Three.js builder: merges the descriptor's boxes per material into a few `MeshStandardNodeMaterial` meshes, builds the interior `THREE.PointLight`s + a color/intensity control panel, and returns the `loadedMap`-shaped adapter the viewer consumes. Browser/WebGPU only. | 146 |
| `test-shoot-house-layout.mjs` | Node test (no framework) — 460 checks over 8 seeds. | 355 |

## Public API

`shoot-house-layout.js`
- `export const DOOR_W = 2.4` — door-opening width (wide enough to move/shoot through; ≥ player capsule diameter 0.6).
- `export function generateShootHouse(seed = 1, opts = {})` → `{ bounds, primitives, lights, spawn }`.
  - `bounds` = `{ minX, maxX, minZ, maxZ, yMin, yMax }` — **honest**: `yMin` is the floor-slab
    bottom (`-floorThickness`), `yMax = Math.max(H, yDeck + railH)` (accounts for the railing
    exceeding wall height). The adapter feeds these straight to `worldYMin`/`worldYMax`.
  - `primitives[]` = `{ kind, cx, cy, cz, sx, sy, sz, material }`. `kind` ∈
    `perimeter | interior | lintel | step | balcony | railing | cover`. `material` ∈
    `wall | floor | trim | stair`. Lintels are the header above a door opening (a door opening
    is the *absence* of wall between two segments plus the lintel).
  - `lights[]` = `{ x, y, z, radius }` (color/intensity are global, applied by the builder).
  - `spawn` = `{ x, y, z, heading }` — a clear floor cell in the central corridor near one end,
    looking down the corridor.
  - `opts` overrides the defaults `{ W:50, L:80, H:4.0, T:0.3, corridorHalf:4, yDeck:3.4, stepRise:0.18, stepRun:0.28, floorThickness:0.1, railH:1.0 }`.

`shoot-house.js`
- `export function createShootHouse({ scene, THREE, seed = 1, opts = {} })` → adapter object.
  Adds the built root to `scene` itself (matching `loadTerrainMap`). Adapter fields the viewer
  reads: `kind:'shoot-house'`, `root`, `worldX`, `worldZ`, `worldYMin`, `worldYMax`,
  `seaLevel` (`yMin-10`, far below the floor), `resolution`, `heightAt(x,z)` (returns 0 — the
  floor; stairs/balcony are resolved by the BVH `mapCollider` the viewer builds over `root`),
  `spawn`, `setLightColor(hex)`, `setLightIntensity(v)`, `dispose()`. Defensive no-op stubs
  (`makeChunks`, `makeAllChunks`, `grassDensityAt`, `treeDensityAt`, `biomeAt`, `surfaceField`,
  `grassDensityGrid`) exist only so a missed guard or the world-map bake can't throw — they are
  never reached when the viewer's `NO_ENVIRONMENT` guards are correct.

## Layout generation (v2 — open kill-house)

Centered at origin, default footprint 50 (x, ±25) × 80 (z, ±40), wall height 4.0, open roof.
Perimeter bounding walls fully enclose the footprint (no perimeter door — the player cannot
leave). The interior is an **open central-corridor kill-house**, not a maze: two longitudinal
**spine walls at `x = ±corridorHalf` (±4)** form an ~8 m central lane running the full length,
each punched with **3 wide (`DOOR_W`=2.4 m) doorways** into the side rooms. Each half's room
block (`x ∈ [4, ~25]`) is split along `z` into **3 large rooms** (each ≥18 m deep) by 2
full-height **seeded** cross walls, whose dividing doorways connect adjacent rooms. Every room is
directly reachable from the corridor through a spine doorway. A single staircase near the `maxZ`
end climbs (within the corridor lane) to a **balcony catwalk** at `yDeck=3.4` overlooking the
corridor, railed on its open edge, reachable only via the stairs. Cover is a small seeded set of
**chest-high barricades** (~1.1 m tall, 3–4 m long, 0.4 m thick low walls — shoot-over cover, not
cubes), ~1 per room + 2 in the corridor, rejection-sampled off door openings, the stair
footprint, and the spawn cell. One near-ceiling light per room plus corridor lights. The right
half (+ axis-straddling floor slab / corridor lights on `x=0`) is generated, then mirrored across
`x=0`; the invariant `solid(x,z) === solid(-x,z)` holds.

## Wiring (`environment-viewer.html`)

The map loads through a small branch in the existing `if (mapKey)` block (~line 1037): when
`mapKey === 'shoot-house'`, `createShootHouse({ scene, THREE, seed })` (seed from `?seed=`)
replaces `loadTerrainMap`; the existing `createMapCollider(loadedMap.root)` + `rebakeWorldMap()`
run unchanged for both paths. Immediately after, `const NO_ENVIRONMENT = loadedMap?.kind === 'shoot-house'`.

`NO_ENVIRONMENT` then drives:
- **Night lighting** (`rigP`, ~line 3116): sun below horizon (elevation -40), sun intensity 0,
  ambient 0.12 — the interior point lights do the real lighting, the sky renders as night.
- **Decoration skip-guards**: forest (`rebuildForestGPU`/`regenerate` early-out), grass (both
  CPU/GPU branches), plants, dressing/rocks, water, and **clouds** (`_cloudsPromise`) are all
  skipped, so those modules never import or initialize. **The sky itself is NOT guarded** — it
  still loads, producing a clear night sky. The skipped `_grassPromise`/`_waterPromise` stay at their
  `Promise.resolve()` defaults so the final `Promise.all([...])` gate still resolves; every
  per-frame `*Ref?.update(...)` call is null-safe.
- **No autospawned creatures**: the ambient port-creature sim is set to `mode: 'off'`
  (~line 1381) and the ClaudeCraft mob `camps` list is emptied (~line 1393), so nothing spawns
  on load. The ClaudeCraft system is still constructed, so the debug panel's manual "spawn in
  front of player" still works if you want targets on demand.
- **Spawn** (`resetPlayerPosition`, ~line 5456): reads `loadedMap?.spawn?.x/z ?? 8/0` and, on a
  look-reset, `loadedMap?.spawn?.heading ?? Math.PI` — the `??` fallbacks preserve prior
  behavior for every other map.

The start screen (`start-screen.js` `_mapStep`) shows a hardcoded **"Shoot House"** card next to
"Infinite World" that resolves `mapKey = 'shoot-house'` (no `map-config.json` entry).

**Known limitation (multiplayer):** `mapKey` is replicated to guests through the relay, but the
`?seed=` param is not, so a host on a non-default seed and its guests would generate different
house layouts. Fine for solo/local testing (the primary use); replicating the seed is left for a
later multiplayer pass.

## Lighting / materials

Flat untextured PBR (muted concrete floor, wall, trim, stair colors; `roughness 0.9`,
`metalness 0`), merged to ~4 draw calls (barricades and lintels/railings share the `trim`
bucket). Interior lights are shadowless `THREE.PointLight`s with physical inverse-square falloff
(`decay 2`), default intensity 16 (candela; sized for the 4 m ceiling), live-adjustable via the
corner panel's color picker and 0–40 intensity slider. Gun fire is hitscan against
players/creatures only and never collides with world geometry, so walls are cover, not
bullet-impact surfaces — this map is geometry only.

## Tests

`test-shoot-house-layout.mjs` (Node, no framework) runs the invariant suite over 8 seeds plus a
single-seed determinism block — 460 checks total:
- **Determinism**: same `(seed, opts)` → deep-equal; different seed/opts differ.
- **Mirror symmetry**: every `cx>0` primitive/light has a `cx→-cx` twin; straddling primitives
  appear once; `solid(x,z) === solid(-x,z)` over a sampled grid.
- **Enclosure**: perimeter covers all four boundary lines with no gap ≥ capsule diameter (0.6),
  and has no door openings (no lintel on a boundary line).
- **Navigability / reachability**: door widths ≥ `DOOR_W`; spawn cell clear (sampled at low and
  standing height, including short `step`/`cover` solids); every side room is directly reachable
  from the central corridor (a spine doorway opens into each room strip).
- **Openness**: each room's floor area is above a minimum (no cubicles) and the interior full-wall
  count is bounded — guards against regressing to the cramped v1 maze.
- **Cover**: barricades are chest-high (~0.9–1.3 m), longer than thick, and clear of doors/stairs/spawn.
- **Stairs/balcony**: rises/runs in human range, monotonic ascent, top tread aligns to the deck
  within ±rise/2; deck sits exactly at `yDeck`; railing on the open edge; deck adjoins the stair
  top (reachable).
- **Bounds**: all primitives strictly within `bounds` (1e-6 epsilon); `bounds` symmetric about
  `x=0`; lights within bounds and above the floor.

`shoot-house.js` (Three.js builder, adapter, panel) is browser/WebGPU — verified manually
(pick the map, walk it in FPS, check lighting controls, `?seed=` reroll).
