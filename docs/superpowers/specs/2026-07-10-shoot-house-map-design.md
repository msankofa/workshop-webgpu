# Shoot House Map — Design Spec

**Date:** 2026-07-10
**Status:** Approved, ready for implementation
**Author:** brainstorming session

## Summary

A standalone, procedurally generated **shoot house** (CQB kill-house) map that loads through
the existing map-picker exactly like an authored map, but has **no environment features** —
no terrain, grass, forest, water, clouds, plants, or scree. Just an enclosed building under a
**night sky**, lit by controllable point lights. Its purpose is to test the FPS movement and
shooting mechanics in isolation from all the environmental subsystems.

The building is **mirror-symmetric** about the `x=0` plane (two identical halves for A/B
testing) and **seeded** (`?seed=`), containing perimeter bounding walls, interior walls with
door-frame openings, a staircase up to a balcony/upper walkway, and low cover blocks.

Hitscan today only registers on players/creatures (`findPlayerHit`), so walls are **cover**,
not bullet-impact surfaces — this map is **geometry only**. Targets come from the existing
creature sim or multiplayer, out of scope here.

## Scope

**In scope**
- New pure layout generator + Three.js mesh/light builder + a `loadedMap`-shaped adapter.
- A hardcoded "Shoot House" card in the start-screen map picker.
- Minimal viewer wiring: a load branch, night-sky lighting defaults, decoration skip-guards,
  and reading the map's spawn point.
- Node tests for the pure layout generator.
- Subsystem doc + `agent_log.csv` entry.

**Out of scope**
- Shootable/reactive target props (hitscan is player/creature-only today).
- Bullet-impact decals against geometry.
- Multi-floor beyond the single balcony/upper walkway.
- Any change to the hitscan/combat system.

## Architecture

### New files

| File | Responsibility |
|---|---|
| `shoot-house-layout.js` | **Pure, no Three.js.** `generateShootHouse(seed, opts)` → layout descriptor. Seeded PRNG (mulberry32). Generates the right half, mirrors across `x=0`. Node-testable. |
| `shoot-house.js` | Three.js builder: consumes the descriptor, merges boxes per material into a few `MeshStandardNodeMaterial` meshes, builds `THREE.PointLight`s, exposes the `loadedMap`-shaped adapter + a small self-owned control panel (color + intensity). |
| `test-shoot-house-layout.mjs` | Node tests for the pure generator (determinism, symmetry, enclosure, navigability, stairs, lights). |
| `docs/subsystems/shoot-house.md` | Subsystem reference doc. |

### `shoot-house-layout.js` — pure generator

```js
export function generateShootHouse(seed = 1, opts = {}) → {
  bounds:   { minX, maxX, minZ, maxZ, yMin, yMax },
  primitives: Primitive[],   // every solid box in the house
  lights:   Light[],         // interior point-light placements
  spawn:    { x, y, z, heading },  // player start, on the floor in a clear cell
}
```

`Primitive` = `{ kind, cx, cy, cz, sx, sy, sz, material }` where:
- `kind` ∈ `'perimeter' | 'interior' | 'lintel' | 'step' | 'balcony' | 'railing' | 'cover'`.
  (`lintel` = the header spanning above a door opening; door openings are the *absence* of wall
  between two interior/perimeter segments plus a lintel above.)
- `cx,cy,cz` = center (world units); `sx,sy,sz` = full extents.
- `material` ∈ `'wall' | 'floor' | 'trim' | 'stair'` (selects the merge bucket + color).

`Light` = `{ x, y, z, radius }` (color/intensity are global, set at build time, not per-light).

**Design intent (v2 — improvement pass):** an open, readable CQB kill-house that is easy to
shoot and move through — NOT a maze of tiny rooms. A wide central corridor runs the long axis
with a few large rooms opening off each side through generous doorways; cover is chest-high
barricades you can shoot over, not scattered cubes.

**Generation rules**
- **Dimensions (defaults, `opts` overridable):** width `W=50` (x ∈ `[-25, 25]`), length `L=80`
  (z ∈ `[-40, 40]`), wall height `H=4.0`, wall thickness `T=0.3`, floor at `y=0` (a single floor
  slab primitive), open roof (no ceiling), balcony deck at `yDeck=3.4`. Door opening width
  `DOOR_W=2.4` (wide enough to move and shoot through cleanly; ≥ player capsule diameter `0.6`).
- **Perimeter:** four bounding walls forming a closed rectangle of height `H`. Must fully
  enclose the footprint (a player cannot leave; the only openings are interior, never on the
  perimeter).
- **Central corridor:** two longitudinal spine walls at `x = ±corridorHalf` (`corridorHalf≈4`,
  i.e. an ~8 m central lane) running the full length, each with wide door openings into the side
  rooms. The corridor is the primary sightline and the spawn lane. Being symmetric about `x=0`,
  the two spines are mirror twins.
- **Side rooms:** each half's room block (`x ∈ [corridorHalf, maxX]`, ~21 m deep) is divided
  along `z` into **~3 large rooms** by full-height cross walls at seeded `z` positions. Every
  wall between two rooms (and every spine wall) gets a `DOOR_W` door opening with a lintel above.
  Rooms are big and open — no sub-subdivision into cubicles.
- **Staircase:** one run near one end, `stepRise≈0.18`, `stepRun≈0.28`, ascending from the floor
  to `yDeck`; the top tread aligns to the balcony deck height (±`stepRise/2`). Steps are `step`
  primitives.
- **Balcony:** a `balcony` deck primitive at `yDeck` forming a catwalk that overlooks the
  central corridor (an elevated shooting position), fenced with a `railing` primitive
  (height ~1.0) on its open edge. Reachable only via the staircase.
- **Cover — barricades, not cubes:** a small seeded set of chest-high `cover` barricades
  (height ~1.1 m, length ~3–4 m, thickness ~0.4 m — low walls, each oriented along x or z), placed
  as meaningful shooting cover in the rooms and corridor. They must NOT block door openings, the
  staircase footprint, or the spawn cell. Far fewer, far more purposeful than a scatter of cubes.
- **Lights:** roughly one interior light per room plus corridor lights (not a fixed small count),
  each near ceiling height, sized (`radius`) to actually light its room. Placed per-region so the
  interior reads clearly at the builder's default intensity.
- **Mirror:** every primitive and light generated with `cx>0` is duplicated with `cx → -cx`
  (extents unchanged; a wall running along z reflects to the mirrored z-line). Primitives that
  straddle `x=0` (the floor slab; anything centered on the axis) are emitted once. Result:
  `layout(x,z) === layout(-x,z)` for all solids.
- **Spawn:** a clear floor cell in the central corridor near one end (e.g. `x=0`, `z` a few metres
  in from `minZ`), `heading` looking down the corridor along the long axis. `spawn.y = 0`. The
  viewer offsets by capsule height.

**Determinism:** identical `(seed, opts)` → deep-equal descriptor. Uses a local mulberry32 PRNG
seeded from `seed`; no `Math.random`, no time, no globals.

### `shoot-house.js` — Three.js builder + adapter

```js
export function createShootHouse({ scene, THREE, seed = 1, opts = {} }) → loadedMapAdapter
```

1. Calls `generateShootHouse(seed, opts)`.
2. Buckets primitives by `material`, builds one `BoxGeometry` per primitive translated to its
   center, and **merges** each bucket with `mergeGeometries` (from
   `three/addons/utils/BufferGeometryUtils.js`) into a single `BufferGeometry` per material →
   ~3–4 draw calls total. Each bucket gets one flat, untextured `MeshStandardNodeMaterial`
   (muted concrete/wall/trim/stair colors; `roughness` high, `metalness` 0).
3. Adds the merged meshes to a root `THREE.Group` (world-space geometry, `castShadow=false`,
   `receiveShadow=false`), does **not** add root to the scene itself (the viewer sets
   `ground = loadedMap.root` and — matching the authored-map path — the viewer/loader is
   responsible for adding it; verify against `loadTerrainMap`, which adds `root` to `scene`
   before returning — replicate that so the branch is symmetric).
4. Builds `lights.length` `THREE.PointLight`s at the descriptor positions (`castShadow=false`),
   parented to root, with a shared color + intensity.
5. Builds a small self-owned floating control panel (following `lights.js`'s optional-panel
   precedent): an `<input type="color">` bound to `setLightColor(hex)` and a range input bound
   to `setLightIntensity(v)`. Panel is created only in a browser (`typeof document`).
6. Returns the adapter.

**`loadedMap` adapter contract** (only these are read by the viewer once decoration is
guarded off — see Integration):

| Field | Value |
|---|---|
| `kind` | `'shoot-house'` (the discriminator every guard/branch keys on) |
| `root` | the `THREE.Group` of merged meshes + lights |
| `worldX`, `worldZ` | footprint extents (`bounds.maxX-minX`, `bounds.maxZ-minZ`) |
| `worldYMin`, `worldYMax` | `bounds.yMin`, `bounds.yMax` |
| `seaLevel` | `bounds.yMin - 10` (far below the floor; water is guarded off anyway) |
| `resolution` | a modest int (e.g. `Math.ceil(max(worldX,worldZ))`) for the height bake |
| `heightAt(x,z)` | returns floor height `0` (stairs/balcony resolved by the BVH collider) |
| `spawn` | `{ x, y, z, heading }` from the descriptor |
| `setLightColor(hex)`, `setLightIntensity(v)` | live control setters |
| `dispose()` | frees geometries/materials/lights, removes the panel |

**Stubs** (never reached when guards are correct, provided defensively so a missed guard or the
world-map bake can't throw): `makeChunks(center, rr, cs) → []`, `makeAllChunks(cs) → []`,
`grassDensityAt → 0`, `treeDensityAt → 0`, `biomeAt → 'meadow'`,
`surfaceField(x,z) → { materialColor:[0.3,0.3,0.32], materialWeights:null, moisture:0, upness:1, density:0 }`,
`grassDensityGrid: undefined`.

### Viewer integration (`environment-viewer.html`)

All edits are small and localized:

1. **Map-load branch** (~line 1026, the `if (mapKey)` block): before `loadTerrainMap`, branch
   `if (mapKey === 'shoot-house')`:
   ```js
   const { createShootHouse } = await import('./shoot-house.js');
   const seed = Number(new URLSearchParams(location.search).get('seed')) || 1;
   loadedMap = createShootHouse({ scene, THREE, seed });
   ```
   then the existing `createMapCollider(loadedMap.root)` + `rebakeWorldMap()` run unchanged.
2. **Night-sky defaults** (after the rig is created, ~line 1071, gated on
   `loadedMap?.kind === 'shoot-house'`): `rig.setElevation(min)`, `rig.setSunIntensity(0)`,
   `rig.setAmbientIntensity(≈0.12)`, and set the sky module to night (via `sky.js`'s
   time-of-day / sun-below-horizon param — coder wires the exact call after reading `sky.js`);
   optionally enable `moonLight` at a low intensity for faint fill. The house point lights do
   the real interior lighting.
3. **Decoration skip-guards** — wrap each of these lazy loads with
   `if (loadedMap?.kind !== 'shoot-house') { ... }` so the module never imports/initializes:
   - forest (`_forestPromise` inner forest-gpu/placement, ~2158+) — **note:** the sky/clouds
     load lives *inside* `_forestPromise`; guard the forest/grass/water bodies, **not** the
     whole promise, so the sky still loads. Structure the guards to keep the sky path alive.
   - grass (grass-compute, inside forest promise)
   - water (`_waterPromise`, ~4283)
   - plants (`PLANTS_MODE` block, ~3705)
   - dressing/rocks (`DRESSING_MODE` block, ~3897)
   - clouds (`_cloudsPromise`) — **guarded off** (v2): a clear night sky over the shoot house.
     Sky itself stays.
4. **Spawn** (~line 5431, `resetPlayerPosition`): read the map spawn:
   ```js
   const sx = loadedMap?.spawn?.x ?? 8, sz = loadedMap?.spawn?.z ?? 0;
   ```
   (heading applied to the FPS look yaw where `resetLook` is honored).
5. **Start screen** (`start-screen.js`, `_mapStep`): add a hardcoded card after "Infinite
   World":
   ```js
   grid.appendChild(_mapCard('Shoot House', 'Enclosed CQB kill-house, night, no environment', () => resolve('shoot-house')));
   ```

No change to `map-config.json` (the card is hardcoded, not a GLB entry).

## Testing

`test-shoot-house-layout.mjs` (Node, no framework, `ok()` assertions, `process.exit`), against
the **pure** `generateShootHouse`:

- **Determinism:** same `(seed, opts)` → deep-equal descriptor; different seeds differ.
- **Mirror symmetry:** for every primitive with `cx>0` there is a matching primitive with
  `cx→-cx` and identical extents/kind/material; axis-straddling primitives appear once. Same
  for lights. (The invariant `solidAt(x,z) === solidAt(-x,z)`.)
- **Enclosure:** perimeter walls cover the full boundary of `bounds` with no gap ≥ player
  capsule diameter (`0.6`) — the player cannot escape; perimeter has no door openings.
- **Navigability:** every door opening width ≥ `DOOR_W` (and ≥ `0.6`); the spawn cell is clear of
  solids (checked at low and standing height); the corridor connects to every room (each side
  room is reachable from the central corridor through door openings — a reachability/flood check
  over the room graph, not just "≥1 opening").
- **Openness:** rooms are large — assert each enclosed room's floor area is above a sane minimum
  (no cubicles), and the interior wall count is bounded (a small number of full walls, not a
  scatter). This guards against regressing to the cramped v1 layout.
- **Cover:** barricades are chest-high (height in ~`[0.9, 1.3]`), longer than they are thick
  (a low wall, not a cube), and none overlap a door opening, the stair footprint, or the spawn
  cell.
- **Stairs:** step rises/runs within human range; monotonic ascent; the top tread aligns to the
  balcony deck height within `±stepRise/2`.
- **Balcony:** deck at `yDeck`; railing present along the open edge; deck reachable (its base
  footprint adjoins the stair top).
- **Lights:** all within `bounds`, above the floor, below `yMax`; at least one per room region.
- **Bounds validity:** all primitives lie within `bounds` (strict, 1e-6); `bounds` symmetric
  about `x=0`. Run the invariant suite over multiple seeds.

The Three.js builder (`shoot-house.js`), viewer wiring, and control panel are browser/WebGPU —
verified manually (see Verification).

## Verification (manual)

1. `python serve.py`, open the viewer, pick **Shoot House** from the map picker.
2. Confirm: night sky, no terrain/grass/water/trees/rocks, an enclosed building with two
   mirrored halves, interior point lights.
3. Enter FPS (`F`), walk through door openings, up the stairs onto the balcony; confirm
   perimeter walls block exit and the player collides with walls/cover.
4. Confirm the light color/intensity controls change the interior lighting live.
5. `?seed=2` produces a different (still symmetric, still enclosed) layout.
6. `node test-shoot-house-layout.mjs` passes.

## Performance / quality bar

- Static geometry merged to ~3–4 draw calls; triangle count in the low thousands (well under
  the `createMapCollider` 250k cap).
- No per-frame allocation in the builder; the adapter's `heightAt`/stubs are O(1).
- Interior lights are shadowless plain point lights (no shadow-map cost); count kept small
  (~8–16).
- Flat untextured PBR — no texture loads, no environment GPU pipelines initialized.
- Lean code, no narration comments; comments only for non-obvious constraints.

---

## Orchestration Plan

Fable reviewers, Sonnet coders. Three waves; each coding task is followed by a Fable review
gate before the next dependent wave starts. Independent tasks within a wave run in parallel.

### Wave 1 — pure core (parallelizable, no viewer risk)

- **T1 (Sonnet): `shoot-house-layout.js`** — implement `generateShootHouse` per spec:
  seeded mulberry32, right-half generation, mirror across `x=0`, all primitive kinds, lights,
  spawn. Pure, no Three.js imports.
- **T2 (Sonnet): `test-shoot-house-layout.mjs`** — implement all tests in the Testing section.
  Written against the spec's contract so it can be authored in parallel with T1; run against
  T1's output at the end of the wave.
- **Gate (Fable):** review T1+T2 together for spec conformance, symmetry/enclosure/navigability
  correctness, determinism, and that the tests actually prove the invariants (not tautologies).
  `node test-shoot-house-layout.mjs` must pass. Iterate until green.

### Wave 2 — Three.js builder + adapter (depends on Wave 1 contract)

- **T3 (Sonnet): `shoot-house.js`** — merge-by-material geometry build, `MeshStandardNodeMaterial`
  buckets, point lights, the full `loadedMap` adapter contract + stubs, the color/intensity
  control panel, `dispose()`. Import `mergeGeometries` from
  `three/addons/utils/BufferGeometryUtils.js`. Match `loadTerrainMap`'s scene-add behavior.
- **Gate (Fable):** review against the adapter contract table, draw-call/merge correctness,
  disposal completeness, and that the panel is DOM-guarded. No Node test (browser-only);
  reviewer checks by reading + reasoning.

### Wave 3 — viewer wiring (depends on Wave 2; touches the shared entry point)

- **T4 (Sonnet): `environment-viewer.html` + `start-screen.js`** — the five integration edits
  (load branch, night defaults, decoration guards keeping sky alive, spawn read, picker card).
  Read `sky.js` to wire the exact night-time-of-day call. Keep edits minimal and localized.
- **Gate (Fable):** review that guards skip forest/grass/water/plants/dressing **without**
  killing the sky promise; that the load branch is symmetric with the authored-map path; that
  spawn fallback preserves the old default for other maps; that nothing else regresses.

### Wave 4 — docs + log (after implementation verified)

- **T5 (Sonnet or inline): docs** — `docs/subsystems/shoot-house.md`, a table row in the
  workshop `CLAUDE.md` and `code-map.html`, and an `agent_log.csv` append (`subsystem: multi`,
  files listed, one-line summary).

### Coordinator responsibilities (me)

- Provide each Sonnet agent this spec + the precise file/line integration points.
- Run/relay the Fable review gates; do not advance a wave until its gate is green.
- Do the final manual browser verification (Verification section) — agents can't drive WebGPU.
- Never let a doc drift from code (workshop `CLAUDE.md` rule).

---

## v3 addendum (2026-07-11) — body-scaled, more open

After walking v2, the interior still read as cramped and undifferentiated. v3 keeps the descriptor
contract and the four-material set unchanged (so `shoot-house.js` is untouched) and revises the pure
generator only:

- **Body-scaled dimensions.** A new `export const BODY = { radius: 0.3, heightStand: 1.8 }` (the FPS
  `fp` capsule) drives every body-relative measure: ceiling `H = heightStand*2.4`, `DOOR_W =
  max(2.4, radius*9)` = 2.7, `coverH = heightStand*0.62`, `railH = heightStand*0.56`, `corridorHalf
  = max(4, heightStand*2.5)`, `yDeck = H*0.83`. Each is an `opts` override.
- **Larger footprint:** 50x80 -> 64x100; corridor lane ~9 m; side rooms ~27 m deep.
- **3-4 rooms per side** (seeded count) instead of a fixed 3, each still >=18 m deep.
- **Per-room type variation** (seeded, >=1 guaranteed `open`): `open` = large empty area (two
  lights, no clutter); `cover` = 1-2 chest-high barricades; `pillars` = a colonnade of 2-3
  full-height square columns (`pillar` kind, `wall` material) for hard cover.
- **Brighter:** larger light radii, two lights per open room, corridor light count scaled to `L`.

Tests grow to 513 checks: room-count is derived per seed (`roomStripsOf`), plus new coverage for
room-type variation, the guaranteed empty room, and pillar shape. `shoot-house.js`, the wiring, and
the adapter contract are unchanged.
