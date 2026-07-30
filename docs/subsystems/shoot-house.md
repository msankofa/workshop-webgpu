# Shoot House Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#shoothouse)

## Purpose

A standalone, procedurally generated **shoot house** (CQB kill-house) map for testing the FPS
movement and shooting mechanics in isolation from every environmental subsystem. It loads
through the same map path as an authored map (picked from the start screen), but renders **no
terrain, grass, forest, water, plants, or scree** — just an enclosed building under the night
sky, lit by controllable interior point lights. It is **seeded** (`?seed=`) and tunable by
`?size=` / `?difficulty=`, so a given `(seed, opts)` reproduces the layout.

**v2 redesign** (bigger + more varied): the two sides of the house are now generated from
**independent seeded RNG streams**, so it is **asymmetric** by default (each side has its own room
count, cuts, types, and clutter) — strict mirror symmetry is opt-in via `opts.symmetric`. The
default footprint grew to **88 × 150 m** (was 64 × 100), rooms come in **six types**, and the house
gains an entry vestibule, staggered doorways, murder-holes, mezzanines, a second staircase, per-room
colored/dim lighting, and emissive exit/hazard signage.

Design spec: `docs/superpowers/specs/2026-07-10-shoot-house-map-design.md`.
Redesign plan (in progress): `docs/shoot-house-deslop-plan.md` — an "internetcore" aesthetic + intentional
layout language, being built in phases behind a **type selector** rather than replacing the v2 house
in place.

**Phase 0 (types + demo room).** The start-screen "Shoot House" entry is now a **dropdown** of
variants (`SHOOTHOUSE_TYPES` in `shoot-house-layout.js`): **Demo Room** and **Procedural House** (the
v2 above). A **demo room** (`generateDemoRoom`) is one enclosed, roofless room that showcases the
locked internetcore *look* — dark deck floor, emissive floor grid, neon wall/portal trim, a signage
placard, a neon light rig. It is fixed hand-authored geometry so it stays a stable visual reference to
iterate on and push downstream. All aesthetic values live in **`shoot-house-style.js`** (palette +
per-material PBR specs) so a look change there propagates to every current and future variant.

**Phase 2 (cover vocabulary).** A new **`shoot-house-pieces.js`** module defines the tight, legible CQB
cover vocabulary that replaces v2's random-cube clutter: **holo-barrier**, **light-pillar**,
**half-wall baffle**, **holo-platform**, and **portal door** — each a small pure function returning
`shoot-house-style.js`-keyed boxes (dark body + emissive accent). Pieces are the composable atoms the
phase-3 room archetypes will arrange around doors and sightlines. The demo room now doubles as the
**vocabulary showcase** (one clearly-spaced instance of each piece) so each reads on its own before
archetypes compose them. Every piece takes an `accent` material-key param so phase-3 two-tone zoning
can recolor them without touching geometry.

**Phase 3 (room archetypes).** A new **`shoot-house-rooms.js`** module turns the vocabulary into
**designed compositions**: `ROOM_ARCHETYPES` (gauntlet, atrium, crossfire, overwatch, open) each a pure
`buildRoomContent(id, ctx)` builder that arranges phase-2 pieces relative to the room's entry and
sightlines. Seed varies parameters (count/spacing/lane), never *whether* cover exists — the intentional
replacement for v2's random scatter. A **Room Gallery** dropdown type (`generateRoomGallery`) lays one of
each archetype in a row of open-front bays, alternating cyan/magenta accent to demo the **two-tone wing
zoning** (a new `neonMagenta` material in `shoot-house-style.js`), so all five read in a single load.
The internetcore rooms (demo + gallery) use **tall walls** (`heightStand·4.8` ≈ 8.6 m, double the v2
house) for an open-arena feel; the demo doorway stays human-height (~3 m, wall above filled by a header).
Atrium pillars are wide (1.2 m) and spread (cluster radius 2.2 m) so you move *between* the columns.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `shoot-house-layout.js` | **Pure, no Three.js.** `generateShootHouse(seed, opts)` (v2 house) + `generateDemoRoom(opts)` (Phase 0 demo) → layout descriptor (primitives, lights, spawn, bounds, meta). Also exports `SHOOTHOUSE_TYPES` (the dropdown registry). Seeded mulberry32 PRNG; the house builds each side from its own sub-seeded stream (asymmetric) unless `opts.symmetric`. Dimensions derive from the player body scale + `size`/`difficulty` presets. Node-testable. | 529 |
| `shoot-house-style.js` | **Pure data, no Three.js.** Single source of aesthetic truth: `PALETTE`, `MATERIALS` (material key → `{color, roughness, metalness, em?, emissiveIntensity?}`), `DEFAULT_MATERIAL`. Consumed by the builder so a look change propagates to every variant. | 39 |
| `shoot-house-pieces.js` | **Pure, no Three.js.** Phase-2 CQB cover vocabulary: `holoBarrier`, `lightPillar`, `halfWallBaffle`, `holoPlatform`, `portalDoor` (+ `PIECES` registry). Each returns an array of `shoot-house-style.js`-keyed boxes (dark body + emissive `accent`). Decoupled from the layout module (defaults are pre-derived from the FPS capsule) to avoid an import cycle — the layout module is the consumer. | 133 |
| `shoot-house-rooms.js` | **Pure, no Three.js.** Phase-3 room archetypes: `ROOM_ARCHETYPES` (registry) + `buildRoomContent(id, ctx)` composing phase-2 pieces into designed layouts (gauntlet/atrium/crossfire/overwatch/open), entry-relative and seed-varied. Imports pieces only (no cycle). | 89 |
| `layout-interchange.js` | **Pure, no Three.js.** The `pcw-layout` interchange schema (v1) shared with the bot-viewer harness: `createLayout`, `validateLayout`, `toShootHouseLayout`, `fromShootHouseLayout`, `sightRectsFor`. Geometry + gameplay data only. `toShootHouseLayout` synthesizes a floor slab (top at `bounds.yMin`) and a default ceiling light grid, since the document carries neither and the mesh builder expects both among its primitives; `{ floor: false, defaultLights: false }` opts out. | 230 |
| `test-layout-interchange.mjs` | Node test — 60 checks: schema/validation, rect→primitive mapping, round-trip losslessness, non-flat (base-y ≠ 0 and negative) rects, geometric classification of foreign kinds, and nav/sight bake equivalence across a round trip. | 151 |
| `shoot-house.js` | Three.js builder: takes a `pcw-layout` document (`interchange`) or dispatches on `type` (`demo`/`rooms`/`house`), merges the descriptor's boxes per material into a few `MeshStandardNodeMaterial` meshes (materials read from `shoot-house-style.js`; `em` specs become emissive buckets), builds the interior `THREE.PointLight`s honoring per-light color/intensity + a global color/intensity control panel, and returns the `loadedMap`-shaped adapter the viewer consumes (including the raw `primitives` list the merged meshes throw away). Browser/WebGPU only. | 171 |
| `test-shoot-house-layout.mjs` | Node test (no framework) — 552 checks over 8 seeds, incl. flood-fill reachability. | 314 |
| `test-shoot-house-collision.mjs` | Node test — analytic ray-vs-box over the layout (same nearest hit a map-BVH raycast returns): asserts doorway openings are clear at every height and wall shots land on the real face within T/2; demonstrates the old heightfield's off-face aliased blocker. | 130 |
| `test-shoot-house-demo.mjs` | Node test — 30 checks: `SHOOTHOUSE_TYPES` registry, demo-room shape/enclosure/doorway/spawn, every material key known to `shoot-house-style.js`, roof-off, neon lights, phase-2 vocabulary showcase (baffle/pillar/platform/ramp present). | ~75 |
| `test-shoot-house-pieces.mjs` | Node test — 24 checks: each cover piece emits well-formed boxes with known materials, a dark body + emissive accent, body dims/heights (barrier chest-high, baffle un-vaultable, pillar full-height with 4 strips, platform deck+ramp+railing with a clear access edge + deck clearing/walkable-under head height, portal 3-member frame on the face plane), and the `accent` override threads through. | ~90 |
| `test-shoot-house-rooms.mjs` | Node test — 32 checks: `ROOM_ARCHETYPES` registry, each archetype composes well-formed known-material boxes, per-archetype signatures (gauntlet serpentine, atrium 4+4, crossfire staggered flanks, overwatch deck+ramp, open empty, unknown→empty), `accent` threading, and the Room Gallery generator (order/bounds/materials/two-tone lights/roof-off/spawn-on-floor/determinism). | ~90 |

## Public API

`shoot-house-layout.js`
- `export const SHOOTHOUSE_TYPES` — `[{ id, label, desc }]`, the start-screen dropdown registry. Currently
  `demo` (Demo Room), `rooms` (Room Gallery), `house` (Procedural House). Each `id` maps to a map key
  `shoot-house-<id>`, except `house` which stays the legacy bare `shoot-house`.
- `export function generateDemoRoom(opts = {})` → `{ bounds, primitives, lights, spawn, meta:{type:'demo',W,L} }`.
  One roofless 18×14 m room, fixed hand-authored geometry (no seed). Emits `deck` floor + `grid` lattice,
  `panel` perimeter walls with `neon` top/base trim, a front-wall doorway framed by a `portalDoor` piece,
  a `placard` sign, and a 4-light neon rig — plus the **phase-2 vocabulary showcase**: one `holoBarrier`,
  two `lightPillar`s, one `halfWallBaffle`, and one back-wall `holoPlatform` (all from `shoot-house-pieces.js`).
  Materials reference `shoot-house-style.js` keys. `opts` overrides `body`/`H`/`T`/`doorW`/`coverH`/`W`/`L`.

`shoot-house-pieces.js` (phase-2 cover vocabulary; pure, no Three.js). Each returns an array of
`{kind,cx,cy,cz,sx,sy,sz,material}` boxes; every function takes an `accent` material key (default `neon`)
for its emissive parts so phase-3 zoning can two-tone without touching geometry.
- `holoBarrier({ cx, cz, orient='x', len=2.6, thick=0.5, h=1.12, accent })` — chest-high `cover` body +
  glowing top lip. Peek/vault cover defining a firing lane.
- `lightPillar({ cx, cz, w=1.2, H, accent })` — full-height `panel` column with a vertical neon strip on
  each of the four faces. Hard cover / landmark. `H` = wall height (required, no default).
- `halfWallBaffle({ cx, cz, orient='z', len=3.2, thick=0.3, h=1.48, accent })` — shoulder-high `panel`
  segment (too tall to vault) with an emissive vertical seam on each exposed end. Breaks sightlines.
- `holoPlatform({ cx, cz, w=6, d=4, height=2.43, railH=1.01, access='front', accent })` — raised `deck`
  slab with a glowing edge frame, a railing on the three non-access sides, and a stepped `stair` ramp up
  the `access` edge (`'front'|'back'|'left'|'right'`). Overwatch/verticality (replaces the ad-hoc mezzanine).
  `height` is the deck's top face; the default `2.43` (`heightStand·1.35`) clears player head height so you
  climb up to look *down*, and its underside (≈2.23) is walkable beneath — a mezzanine, not a low step.
- `portalDoor({ cx, cz, along='x', facePos, doorW=2.7, doorH, accent })` — 3-member emissive frame
  (2 jambs + header lip) sitting proud of a doorway the wall builder already left. `along` = the wall's
  run axis; `facePos` = the fixed coordinate of the plane the frame sits on.
- `export const PIECES` — `{ holoBarrier, lightPillar, halfWallBaffle, holoPlatform, portalDoor }`.
- New primitive `kind`s these introduce: `baffle`, `platform`, `railing` (also used by the house),
  `pillar`/`step`/`cover`/`neon` (shared with the house). Collision consumes **all** boxes regardless of
  `kind`, so every piece is solid + ballistic automatically.

`shoot-house-rooms.js` (phase-3 room archetypes; pure, no Three.js). Imports the pieces module only.
- `export const ROOM_ARCHETYPES` — `[{ id, label, desc }]` for `gauntlet`, `atrium`, `crossfire`,
  `overwatch`, `open`.
- `export function buildRoomContent(archetype, ctx)` → array of piece boxes composing that archetype's
  cover. `ctx = { rect:{x0,x1,z0,z1} (inset content region), entryX, H, coverH, accent, rand }`. Seed
  (via `rand`) varies parameters (gate count, lane), never whether cover exists. Unknown ids → empty room.
  - **gauntlet** — 3–4 baffles alternating anchor wall → serpentine lane.
  - **atrium** — 4-pillar central cluster + 4 radial low barriers (diagonals stay open).
  - **crossfire** — 2 depth-staggered flanking baffles + 1 far fallback barrier.
  - **overwatch** — a `holoPlatform` against the far wall (access facing entry) + 2 staggered approach barriers.
  - **open** — returns `[]` (deliberate breathing room).

`generateRoomGallery(opts = {})` (in `shoot-house-layout.js`) → the same descriptor shape as the other
generators, `meta = { type:'rooms', bays, order }` (`order` = the archetype ids left→right, since there is
no in-world text). A row of **open-front bays**, one per `ROOM_ARCHETYPES` entry over one continuous floor
slab (+ a front approach strip the player spawns on), each bay alternating `neon`/`neonMagenta` accent to
demo two-tone wing zoning. `opts`: `seed`, `bayW` (15), `bayD` (20), `gap` (4), plus the usual
`body`/`H`/`T`/`coverH` overrides.
- `export const BODY = { radius: 0.3, heightStand: 1.8 }` — the FPS controller's capsule radius and
  standing height (`fp` in `environment-viewer.html`). Every body-relative dimension derives from these.
- `export const DOOR_W` — door-opening width, `max(2.4, radius*9)` = **2.7** (wide enough to move/shoot
  through; ≥ player capsule diameter 0.6).
- `export const SIZE_PRESETS` — `{ compact:{W:60,L:110}, standard:{W:88,L:150}, sprawl:{W:120,L:210} }`.
- `export const DIFFICULTY_PRESETS` — `{ easy, normal, hard }`, each `{ coverDensity, darkChance, roomsBias }`;
  tunes clutter density, how many rooms go dim/dark, and the room-count bias (`hard` = more, smaller rooms).
- `export function generateShootHouse(seed = 1, opts = {})` → `{ bounds, primitives, lights, spawn, meta }`.
  - `bounds` = `{ minX, maxX, minZ, maxZ, yMin, yMax }` — **honest**: `yMin` is the floor-slab
    bottom (`-floorThickness`), `yMax = Math.max(H, yDeck + railH)`. Symmetric about `x=0` (centered
    footprint) even though room *content* is asymmetric. The adapter feeds these to `worldYMin`/`worldYMax`.
  - `primitives[]` = `{ kind, cx, cy, cz, sx, sy, sz, material }`. `kind` ∈
    `perimeter | interior | lintel | step | balcony | railing | cover | pillar | shelf | crate |
    mezzanine | mezzStep | sign`. `material` ∈ `wall | floor | trim | stair | exit | hazard`.
    Lintels are the header above a door opening (a door opening is the *absence* of wall between two
    segments plus the lintel); murder-holes are chest-high window slits (wall below + above, **no**
    lintel). `pillar`s are full-height square columns (`wall`). `shelf`/`crate` are `stair`-material
    clutter. `mezzanine`/`mezzStep` are the raised deck + its access stair. `sign` primitives use the
    emissive `exit` (green, above each spine door) or `hazard` (red, at each stair foot) materials.
  - `lights[]` = `{ x, y, z, radius, color, intensity }` — `color` is a per-light hex tint (room-type
    palette; corridor warm; vestibule cool), `intensity` a 0–1 multiplier the builder applies on top of
    the global slider (dim/dark rooms ≈ 0.22).
  - `spawn` = `{ x, y, z, heading }` — a clear floor cell **inside the entry vestibule** at the minZ end
    of the corridor (`x=0`), facing down the corridor.
  - `meta` = `{ W, L, corridorHalf, vestZ, right, left }`; each side is
    `{ strips, types, roomCount, spineDoorZ, spineX }` — used by the tests for reachability/openness.
  - `opts` — `size` (`'compact'|'standard'|'sprawl'`, default `standard`), `difficulty`
    (`'easy'|'normal'|'hard'`, default `normal`), `symmetric` (default `false` — mirror the right side
    onto the left instead of generating it independently). Footprint/topology defaults
    `{ T:0.3, stepRise:0.18, stepRun:0.28, floorThickness:0.1, minRoomZ:16 }` plus explicit `W`/`L`
    overrides. Body-scaled dimensions each default off `BODY` but accept an override: `body`, `H`
    (`heightStand*2.4`≈4.32), `doorW`, `coverH` (`heightStand*0.62`, clamped 0.9–1.3), `railH`
    (`heightStand*0.56`≈1.0), `corridorHalf` (`max(4.5, heightStand*2.6)`≈4.68), `yDeck` (`H*0.83`≈3.59),
    `yMezz` (`H*0.44`≈1.9).

`layout-interchange.js` (the **`pcw-layout` v1** schema; pure, no Three.js, no imports)

The app-neutral layout document that makes a bot-viewer-v2 world and a shoot-house map the same
thing. A world authored in the harness exports as one of these and loads here through the normal
mesh-build + adapter path — the point being that identical geometry in both apps makes bot
state-code traces diffable.

```js
{ format: 'pcw-layout', version: 1, name?: string,
  bounds: { minX, maxX, minZ, maxZ, yMin, yMax },
  walls:  [ { kind: 'wall', x, z, w, d, h, y } ],   // x/z = centre, w/d = FULL extents,
  covers: [ { kind, x, z, w, d, h, y } ],           // y = base (bottom), h = the rect's own height
  spawns: [ { id, role, x, y, z, heading? } ],      // role: player | bot | dummy | patrol
  terrain: null }                                   // RESERVED v1
```

- **Flatness is not in the schema.** Every rect carries its own base `y`, so stacked/sloped content
  round-trips unchanged; `heightAt() === 0` in the builder is an artifact of the current mesh path,
  not a format rule. `terrain` is reserved for a ground descriptor (field seed, heightmap ref, pads):
  v1 always writes `null` and both apps ignore it, but it survives a round trip.
- **Geometry + gameplay data only.** Materials, themes and lights stay app-side; the document never
  carries them. `walls` also state their height per rect, so the format does not depend on the
  harness's global `WALL_H`.
- Coordinates are quantized to 1e-9 m so the centre/extent conversion (`y` → `cy = y + h/2` → `y`)
  lands back on the same double. Headings are left alone (an angle, not a length).

API:
- `export const LAYOUT_FORMAT = 'pcw-layout'`, `LAYOUT_VERSION = 1`, `DEFAULT_MATERIALS =
  { wall: 'wall', cover: 'trim' }`, `SIGHT_BLOCK_HEIGHT = 1.5` (mirrors `nav-visibility.js`; kept
  local so this module stays dependency-free).
- `createLayout(source)` → normalized v1 document. Accepts a bot-viewer-shaped world
  (`{ walls, covers, bounds, wallHeight, botSpawn, dummySpawn, patrolPoints, terrain, name }`) or an
  existing document (idempotent). Derives `bounds.yMin/yMax` from the rects when absent.
- `validateLayout(doc)` → `{ ok, errors, warnings }`. Never throws. Errors: wrong format/version,
  non-finite or degenerate bounds, non-finite/non-positive rects, non-finite spawn positions, a
  non-object `terrain`. Warnings: a rect entirely outside bounds, an unknown spawn role, no geometry.
- `toShootHouseLayout(doc, { materials } = {})` → `{ bounds, primitives, lights: [], spawn, spawns,
  terrain, meta:{type:'layout',name,source} }` — exactly the generator descriptor `createShootHouse`
  consumes. Walls → `{kind:'wall', material: materials.wall}`, covers → `{kind, material:
  materials.cover}`, each `cy = y + h/2`. `spawn` resolves to the first `player`-role spawn, else the
  first `bot`, else the first entry (heading defaults to `Math.PI`).
- `fromShootHouseLayout(sh, { name } = {})` → v1 document. Prims tagged `wall`/`cover` map straight
  back; **every other kind is classified geometrically** — a box that is not decor (`sign`/`neon`/
  `grid`), whose top is above 0.05 and whose bottom is below `SIGHT_BLOCK_HEIGHT`, becomes a cover
  with its tag preserved. That mirrors the `shootHouseSightRects` filter the environment viewer
  applies to bake bot cover, so floor slabs, lintels and raised decks drop out on both paths.
- `sightRectsFor(doc)` → `[{x,z,w,d,h,kind}]` for `buildSightGrid`, where `h` is the box **top**
  (`y + h`) — a rect lifted off the floor reads at its real height instead of its own thickness.

Round-tripping is lossless for harness-authored content and for the surviving subset of a generator
layout (`test-layout-interchange.mjs` asserts both, plus grid-identical nav/sight bakes either way).

`shoot-house.js`
- `export function createShootHouse({ scene, THREE, seed = 1, type = 'house', opts = {}, interchange = null })`
  → adapter object. When `interchange` (or `opts.layout`) holds a `pcw-layout` document it is
  validated (throwing on errors, `console.warn` on warnings) and converted by `toShootHouseLayout`,
  short-circuiting the generators; otherwise `type` picks the layout generator (`'demo'` →
  `generateDemoRoom`, `'rooms'` → `generateRoomGallery`, else `generateShootHouse`). The mesh merge,
  lights, panel and adapter are shared by both paths — an interchange layout just arrives with an
  empty `lights` list. The adapter gains a `spawns` field (the document's full role-tagged spawn
  list, `null` for the generators).
  Adds the built root to `scene` itself (matching `loadTerrainMap`). Adapter fields the viewer
  reads: `kind:'shoot-house'`, `root`, `worldX`, `worldZ`, `bounds` (`{minX,maxX,minZ,maxZ}`, the
  absolute footprint — unlike `worldX`/`worldZ` which are just widths; used to bake the combat-bot
  nav grid, see `docs/subsystems/bots.md`), `primitives` (the generator's raw box list, passed
  through unmodified with `kind` tags intact — the merged per-material meshes destroy the AABB
  structure, and the bot cover/visibility bakes in `environment-viewer-v2.html` recover their
  sight-blocker rects from it: `{x:cx, z:cz, w:sx, d:sz, h:cy+sy/2}`, minus decorative kinds and
  boxes that float above eye height), `worldYMin`, `worldYMax`,
  `seaLevel` (`yMin-10`, far below the floor), `resolution`, `heightAt(x,z)` (returns 0 — the
  floor; stairs/balconies/mezzanines are resolved by the BVH `mapCollider` the viewer builds over
  `root`), `spawn`, `setLightColor(hex)` (only recolors lights **without** a per-light tint),
  `setLightIntensity(v)` (scales every light by its own multiplier), `dispose()`. Defensive no-op stubs
  (`makeChunks`, `makeAllChunks`, `grassDensityAt`, `treeDensityAt`, `biomeAt`, `surfaceField`,
  `grassDensityGrid`) exist only so a missed guard or the world-map bake can't throw — they are
  never reached when the viewer's `NO_ENVIRONMENT` guards are correct.

## Layout generation (v2 redesign — bigger, varied, asymmetric)

Centered at origin, default footprint **88 (x, ±44) × 150 (z, ±75)** (`standard` size preset), wall
height ~4.32 (`heightStand*2.4`), open roof. Every body-relative dimension derives from `BODY`, so the
whole house scales with the FPS capsule; `size`/`difficulty` presets scale the footprint and clutter.
Perimeter bounding walls fully enclose the footprint (no perimeter door — the player cannot leave).

The interior is an **open central-corridor kill-house**: two longitudinal **spine walls at
`x = ±corridorHalf` (±4.68)** form a ~9.4 m central lane. At the minZ end, a cross wall with one door
seals an **entry vestibule** (8–11 m deep) where the player **spawns**, facing down the corridor.

Each side's room block is generated **independently from its own sub-seeded RNG stream** (so the two
sides differ — the house is asymmetric; set `opts.symmetric` to mirror the right side onto the left
instead). Per side: the block (`x ∈ [±4.68, ±~44]`, ~39 m deep) is split along `z` into **3–6 large
rooms** (difficulty-biased count, each ≥16 m deep, non-uniform depths gently skewed toward maxZ) by
`roomCount-1` full-height cross walls. Each cross wall has one doorway (~50% also get a **chest-high
murder-hole** window slit for cross-room fire), and each room has **one wide (`DOOR_W`=2.7 m) spine
doorway**, **staggered** to a near/center/far position in the room so entries aren't all center-fed.

Each room gets a **seeded type** (≥1 `open` room per side guaranteed):
- **`open`** — large empty area (two lights). A deep open room has a ~60% chance to host a **mezzanine**:
  a raised half-room deck at `yMezz`≈1.9 with a short access stair and an inner railing (`open+mezz`).
- **`cover`** — chest-high **barricades** (`coverH`≈1.1 m low walls); ~40% get an **L-return** for corner
  cover. Density scales with `difficulty`.
- **`pillars`** — 2–4 **full-height square columns** (`pillar`/`wall`) — hard cover you move around.
- **`shelving`** — 2–3 rows of tall `shelf` walls with a door-width aisle gap each — zig-zag movement.
- **`crates`** — a scatter of 4–7 mid-height `crate` boxes forming a loose maze.
- **`tables`** — mess-hall rows of long low tables (`cover`) with small chair `crate` blocks.

Up to **two staircases** climb (within the corridor lane) to **balcony catwalks** at `yDeck`≈3.59
overlooking the corridor, railed on the open edge: one near `maxZ` always, a second near the vestibule
when `L ≥ 140`. The corridor also carries 1–2 lane-running barricades and a couple of full-height posts.
**Emissive signage**: a green `exit` sign above every spine doorway, a red `hazard` sign at each stair
foot. All content is rejection-sampled off doorways / stairs / spawn (`clearZones`). Reachability is
verified functionally (flood fill), not by a symmetry invariant.

## Wiring (`environment-viewer.html`)

The map loads through a small branch in the existing `if (mapKey)` block (~line 1098): the branch
derives a `shootHouseType` from `mapKey` (`'shoot-house'` → `house`; `'shoot-house-<type>'` → that
variant, e.g. `demo`/`rooms`; else `null`). When non-null, `createShootHouse({ scene, THREE, seed, type, opts })`
(seed from `?seed=`, `opts.size` from `?size=`, `opts.difficulty` from `?difficulty=`) replaces
`loadTerrainMap`; the existing `createMapCollider(loadedMap.root)` + `rebakeWorldMap()` run unchanged for
all paths (the BVH collider covers demo/gallery geometry / mezzanine decks/steps / platform ramps).
Immediately after, `const NO_ENVIRONMENT = loadedMap?.kind === 'shoot-house'` (every variant returns that `kind`).

Under `NO_ENVIRONMENT` the viewer also applies **bloom/tone defaults** (agx tone, exposure 1.1, bloom
strength 0.9 / threshold 0.6, contrast, vignette) so the emissive grid/trim/neon actually glow — see the
`if (NO_ENVIRONMENT)` post-FX block after `applyBloom`/`applyGrade` are defined (~line 3400).

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

**Loading a `pcw-layout` file (not yet wired).** `createShootHouse` accepts the document today; the
viewer side still needs a one-line source for it — fetch/`FileReader` the JSON and pass it as
`interchange` in the same `if (mapKey)` branch that picks a `shootHouseType`, e.g.
`createShootHouse({ scene, THREE, interchange: await (await fetch(layoutUrl)).json() })`. Everything
downstream (`createMapCollider`, `NO_ENVIRONMENT`, `rebakeWorldMap`, the bot cover bake off
`loadedMap.primitives`) works unchanged, because the document produces the same descriptor shape the
generators do. The document's role-tagged spawns also reach the viewer as `loadedMap.spawns`, which
is what `sampleBotSpawnPoints` should prefer over grid sampling once a harness world is loaded.

The start screen (`start-screen.js` `_mapStep`) shows a **"Shoot House" dropdown card** next to
"Infinite World" (built by `_shootHouseCard`, populated from `SHOOTHOUSE_TYPES`): a type `<select>` +
an "Enter →" button that resolves the mapped key (`_shootHouseMapKey`: `house` → `shoot-house`, else
`shoot-house-<id>`). No `map-config.json` entry.

**Known limitation (multiplayer):** `mapKey` is replicated to guests through the relay, but the
`?seed=` / `?size=` / `?difficulty=` params are not, so a host on non-default settings and its guests
would generate different house layouts. Fine for solo/local testing (the primary use); replicating the
seed/opts is left for a later multiplayer pass.

## Lighting / materials

All material specs live in **`shoot-house-style.js`** (`MATERIALS[key]` → `{color, roughness, metalness,
em?, emissiveIntensity?}`); the builder looks each up (`?? DEFAULT_MATERIAL`) and, for `em` specs, sets
`emissive`+`emissiveIntensity`. The **demo room / internetcore** keys are `deck`, `grid` (em), `panel`,
`neon` (em), `neonMagenta` (em — the magenta-wing trim accent for phase-3 two-tone zoning), `cover`,
`placard` (em) — dark near-black bodies, low metalness (no env map), emissive neon glowing under bloom. The **v2 house** keys (`floor`, `wall`, `trim`, `stair`, `exit`, `hazard`) are the
older flat untextured PBR (muted concrete; `roughness 0.9`, `metalness 0`), merged to **~6 draw calls** —
one per material bucket. Pillars/posts (`wall`),
barricades/tables/lintels/railings (`trim`), and shelves/crates/mezzanines (`stair`) fold into the
shared buckets. The two **emissive** buckets (`exit` green, `hazard` red) set `emissive`+
`emissiveIntensity 2.2` so signs glow in the dark. Interior lights are shadowless `THREE.PointLight`s
with physical inverse-square falloff (`decay 2`), default global intensity 16 (candela; sized for the
~4.3 m ceiling). Each light carries a **per-light `color` tint** (room-type palette; corridor warm;
vestibule cool) and an **`intensity` multiplier** (dim/dark rooms ≈ 0.22): the corner panel's color
picker only recolors lights with no tint, and its 0–40 slider scales each light by its own multiplier.

**Bullets collide with the walls.** `resolveWorldShot` (hitscan + projectiles) uses an exact
`mapCollider.raycast` occluder over the house BVH, so shots stop on the real wall/barricade/pillar
faces and pass cleanly through doorways — cover is now ballistic, not just line-of-sight. On this
geometry-only map the BVH (which includes the floor slab) is also the ground, so the bilinear
**heightfield terrain march is skipped for shots** (`heightAt: null` when `NO_ENVIRONMENT`): that
heightfield stores wall-*top* height per column and bilinearly ramps it into adjacent floor cells,
which used to spawn invisible shot-blockers ~0.6–1 m beside every wall and inside doorways. Creatures
still use the heightfield for foot placement (walls make its error large but that only affects gait,
not shots).

## Tests

`test-shoot-house-layout.mjs` (Node, no framework) runs the invariant suite over 8 seeds plus a
determinism/preset block — **552 checks total**. Room strips/types come from the returned `meta`, and
reachability is checked functionally, so the assertions are topology-agnostic (they survive the
asymmetric redesign):
- **Determinism / presets**: same `(seed, opts)` → deep-equal; different seed/opts differ; `size`
  preset drives `meta.L`; `difficulty` changes the layout; `opts.symmetric` restores the mirror
  (every side-room `cx>0` primitive has a `cx→-cx` twin).
- **Bounds**: all primitives within `bounds` on all six faces (1e-6 epsilon); `bounds` symmetric
  about `x=0` (centered footprint); lights within bounds and above the floor.
- **Asymmetry**: across the seed set, `solid(x,z) ≠ solid(-x,z)` somewhere (the sides genuinely differ).
- **Enclosure**: perimeter covers all four boundary lines with no gap ≥ capsule diameter (0.6),
  and has no door openings (no lintel on a boundary line).
- **Doorways**: every lintel opening width ≥ `DOOR_W`.
- **Spawn**: cell clear at standing + low height (catches short solids); on the floor at `x=0`; inside
  the entry vestibule (`minZ < z < vestZ`).
- **Reachability**: a **0.4 m-grid flood fill** over structural blockers (walls/pillars/shelves) from
  the spawn reaches the corridor (through the vestibule door) and a point just inside **every** side
  room's spine doorway.
- **Openness**: 3–6 rooms per side; each room's z-extent and floor area above a minimum (no cubicles).
- **Cover**: `cover` pieces are chest-high (0.9–1.3 m), trim material, long axis ≥ 2× thickness.
- **Stairs/balcony**: steps clustered per staircase (1 or 2); each cluster's rises (0.12–0.22 m) and
  runs (0.2–0.4 m) in human range, monotonic ascent, top aligned to a balcony deck; decks are elevated
  catwalks below wall height, within the corridor lane.
- **Lights**: all within bounds; every light carries a `#…` color tint; corridor lights straddle
  `x=0`; every side room has ≥1 light on its side.
- **Room-type variation**: declared-`open` rooms are genuinely empty (no cover/pillars/shelves/crates);
  `pillar`s are full height + square; ≥4 distinct types and ≥1 mezzanine appear across the 8 seeds.
- **Signage**: an emissive `exit` sign per spine doorway (≥ total room count), each a `sign` kind; ≥1
  `hazard` sign at a stair foot.
- **Mezzanine** (when present): deck elevated below wall height, with adjacent access steps.

`test-shoot-house-collision.mjs` verifies the bullet/wall fix without a GPU: a map-BVH raycast
returns the same nearest surface as analytic ray-vs-AABB over the same boxes, so it fires rays over
the pure layout and asserts (A) every spine doorway opening is clear at y=0.5–2.0 and (B) wall shots
land on the real spine face within T/2 (0.15 m), across 5 seeds × both sides; it also reproduces the
old heightfield to show its off-face, aliased blocker for contrast.

`test-shoot-house-demo.mjs` (Node, no framework) — 30 checks on the demo room: the `SHOOTHOUSE_TYPES`
registry has `demo`+`house` with id/label/desc; the room is enclosed on three sides with an open front
doorway (walls flank a clear center); every emitted `material` key is known to `shoot-house-style.js`
(so nothing silently greys); the roof is off over room center; the look features
(deck/grid/panel/neon/cover/placard) are all present; the **phase-2 vocabulary showcase** is present
(baffle/pillar/platform kinds + a platform access ramp); spawn is inside bounds on clear floor; lights
carry neon color tints incl. cyan.

`test-shoot-house-pieces.mjs` (Node, no framework) — 24 checks on the phase-2 cover vocabulary: the
`PIECES` registry holds all five functions; each piece emits well-formed boxes (positive extents, finite
centers) with materials known to the style module, a dark body + at least one emissive accent; per-piece
geometry (barrier chest-high with a lip on top; pillar full wall height with four strips; baffle taller
than vault height with two end seams; platform has a deck slab, step ramp, and railing but no railing on
the open access edge; portal is a 3-member frame on the given face plane); and the `accent` override
swaps the emissive material key.

`test-shoot-house-rooms.mjs` (Node, no framework) — 32 checks on the phase-3 archetypes: `ROOM_ARCHETYPES`
registry; every archetype composes well-formed boxes with materials known to the style module; per-archetype
composition signatures (gauntlet's baffles alternate walls → serpentine; atrium's 4 pillars + 4 radial
barriers; crossfire's 2 depth-staggered flanking baffles; overwatch's deck+ramp over 2 approach barriers;
open is empty; an unknown id falls back to empty); the `accent` override recolors the emissive parts; and
the Room Gallery generator (meta order matches the archetype order, non-degenerate bounds, all materials
known, both cyan+magenta lights present, roof off, spawn inside bounds on real floor, deterministic per seed).

`shoot-house.js` (Three.js builder, adapter, panel) is browser/WebGPU — verified manually
(pick a type from the dropdown, walk it in FPS, check lighting controls, `?seed=` / `?size=` /
`?difficulty=` reroll on the house).
