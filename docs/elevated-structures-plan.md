# Elevated structures — how to begin

Status: **route C shipped 2026-08-11** (per-pad falloff + the `terrace` kind + `test-terrace.mjs`).
**Route B shipped 2026-08-17** — the sparse level overlay landed in `nav-grid.js` on 2026-08-11
(`test-nav-levels.mjs`), and step 4 is now done too: the `platform` kind emits decks and a sloped
ramp, `map-boxes.js#seatDecksAndRamps` seats them, `bot-viewer-v3.html` passes them to `buildNavGrid`
and threads `y` through its nav queries, and deck centres are patrol goals (`test-nav-decks.mjs`).
The visibility field, the corner map, goal claims and the danger field are still one surface per
column and say so at the top of the rebuild log. Reference for both is `docs/subsystems/bots.md`
(`terrace`, "Level overlay in nav-grid.js" and its "Wired into bot-viewer-v3.html" subsection).

**Correction, 2026-08-11:** route B's scoping below claims the searches run "over opaque integer
keys". That is wrong, and reading the file is what showed it — `findPath`, `floodFill`,
`labelRegions` and `cheapestSoftLink` each decompose the key into `(c, r)` and rebuild neighbours
from column/row deltas. The fix was a shared `expandNeighbors` every search calls, not the
mechanical edit the paragraph predicted. The rest of the scoping held: base keys stayed put, a
deck-free map bakes byte-identically, and no physics change was needed.

Written 2026-08-11, after a six-agent brainstorm returned ~12 proposals (ramps, terraces, ziggurats,
watchtower decks, catwalks, platforms) that the simulation cannot deliver today. This is the route
out.

**Steps 0–3 are done and the measurements are in `bots.md`.** The one correction worth carrying
forward: step 3's worry that `connectStrandedRegions` would cut its own way up a mesa is measured as
unfounded — it carves 0 cells on a well-formed terrace and marks a rampless one *sealed* instead.

## Why they are blocked

Three facts, checked against the code:

- **Nav is a 2D grid with one height per cell.** `navWalkable(x, z)` (`bot-viewer-v3.html:7531`) is
  bounds, `pointInWall`, and a terrain slope gate. Height comes from `terrainField.heightAt`. There
  is no notion of a second surface at the same (x, z).
- **The capsule cannot climb.** `stepBotPhysics` runs `slopeLimitY = 0.5` with no step-up and no
  jump (`bot-entity.js:66`).
- **Slabs are deliberately outside both.** They render and stop bullets; nav and sight never see
  them, so a bot walks and shoots under an overhang instead of pathing round it.

So the BVH stops a bot walking *through* a slab, and nothing gets it *onto* one. Every "fight on the
high ground" proposal fails at the same point.

## Three routes, and which one to take

**Route A — elevation as terrain.** Stamp landforms into `bot-terrain.js` instead of emitting
geometry. Nav already reads `heightAt` and walks up to `maxSlope` (0.85 rise/run, ~40°), and
`generateFeatures`/`stampFeatures` already place plateaus, ravines and escarpments. Real high ground,
today, with no changes to nav, physics or the collider. What it cannot do is architecture — hard
edges, and anything you walk both over and under.

**Route B — a sparse level overlay.** Corrected 2026-08-11 after the first draft of this section
overstated the cost. The searches in `nav-grid.js` run A* and Dijkstra over **opaque integer keys**;
the `(c, r)` arithmetic is inlined in about six places, but it is mechanical, not structural.

Two things the first draft got wrong:

- **"Every consumer holding a cell index breaks."** Only if the grid is reshaped. Keep the base layer
  at its current keys (`0 .. cols*rows-1`) and allocate extra levels **after** them, and a map with
  no decks is byte-identical while every existing call site keeps working. Most cells never get a
  second level — only the ones under a deck — so this is a sparse overlay, not a second grid.
- **"The capsule needs a step-up."** Only for stairs. `slopeLimitY` 0.5 is ~60° and nav's `maxSlope`
  0.85 is ~40°, so a *ramp* between levels is climbable under the rules that already exist. No
  physics change.

**What is actually left is the lookup.** `worldToCell(grid, x, z)` becomes ambiguous, and it has ~30
call sites in `bot-viewer-v3.html` alone. An optional `y` argument keeps every site that omits it on
today's ground-level answer, so only the "where am I" sites need threading — roughly a dozen — while
the "where is that point" sites can stay as they are until they matter.

The disambiguation rule cannot be global: a bot on a deck asking *where am I* wants its own level,
and asking *where is my enemy* wants the enemy's. So it resolves a point against a **reference
height**, and **returns no cell rather than the nearest** when nothing is within tolerance — that
refusal is the whole safety property. There is room for it: the slab contract already forces ≥1.8 m
of headroom, so two levels at one `(c, r)` are ≥1.8 m apart and ~1.0 m separates them cleanly.

**Unchecked, and not to be assumed:** `nav-visibility.js` bakes `walkIndex` from cells and memoises
pair queries on cell indices; `nav-corners.js` filters rects by height. Neither has been read under
this design.

**Route C — make the slab *be* the ground.** Let a structure raise the terrain field over its
footprint instead of floating a slab above it. Nav stays one layer; the deck simply is the ground
there. Sight already grants and blocks correctly from height because the visibility field is built
against the same height grid. The collider already has the mesh. Nothing new has to understand
layers.

**B and C are not competing — they answer different questions.** C is landscape: berms, terraces,
raised plinths, anything whose shape is ground. B is architecture: a deck you fight on *and* under,
which is most of what the brainstorm actually drew and the one thing C can never do, because a raised
platform under C is solid.

Do **C first** because it is nearly free and delivers high ground immediately, then **B**, which the
scoping above makes affordable rather than a rewrite.

## Two constraints that happen to line up

- **Nav is the binding limit, not physics.** Nav rejects ground steeper than `maxSlope` 0.85 (~40°);
  the capsule rejects contact normals under `slopeLimitY` 0.5 (~60°). Physics is the looser of the
  two, so a ramp nav accepts is one the capsule can climb. *Derived from the two constants, not
  measured — confirm with a bot on a ramp before relying on it.*
- **A vertical edge excludes itself.** A platform's side is far past `maxSlope`, so nav marks it
  unwalkable on its own and the only way up is a ramp you deliberately provide. That is the shape
  the proposals wanted, and it falls out rather than needing to be enforced.

## Where to begin

**Step 0 — the riser pad already exists.** `createTerrainField` builds each pad as
`y: f.y ?? baseAt(f.x, f.z)` (`bot-terrain.js:199`). A pad that supplies its own `y` raises or lowers
the ground to it instead of levelling to the local height. Nothing in the pipeline needs a new field
or a new pad type; `terrainPadsForLayout` just has to stop dropping the property. **Verify this in
Node before building on it** — no caller passes `y` today, so the path is unexercised.

That collapses the expected first step to almost nothing and moves the real work to what the pad
shape implies.

**Step 1 — per-pad falloff (the actual blocking change).** Pads are **circular**, and their rim is a
smoothstep over the global `flattenFalloff` (2.0 m). So a riser's reachability is decided entirely by
one ratio:

    rise / flattenFalloff  vs  maxSlope (0.85)

A 1.5 m rise over a 2 m rim is 0.75 — walkable from every direction, so it is a gentle hummock with
no chokepoint. A 2.5 m rise over the same rim is 1.25 — unwalkable all the way round, so it is a mesa
with no way up at all. Both are useful and neither is what you want by default: the interesting shape
is an unclimbable rim *with one ramp*. Since `flattenFalloff` is global, a map cannot hold both
today. **Give each pad its own `falloff`, defaulting to the global.** This is the change everything
else waits on.

**Step 2 — a `terrace` kind that emits pads and nothing else.** No walls, no covers, no slabs: one
riser at a tight falloff for the mesa, plus one wide-falloff pad on one side for the ramp up. Assert
in Node that the top is level, that the rim exceeds `maxSlope` everywhere except across the ramp, and
that a walkable path exists from outside the footprint to the top. That last assertion is the real
test — `buildNavGrid` and `findPath` are both importable, so it can be proved without a browser.

**Step 2a — accept round, or pay for rectangles.** Circular pads make a terrace a stepped *cone*, not
a ziggurat. That reads as landscape rather than architecture, which suits the eco-brutalism set for a
berm or a raised plinth but will not give the hard-edged tiers the brainstorm drew. Rectangular pads
mean a shape field on the pad record and a new distance function in `padBlend`, which is the hot loop
(`heightAt` runs per mesh vertex and per nav cell). Ship round first and see whether it is enough.

**Step 3 — check `connectStrandedRegions` does not eat it.** `bot-terrain.js` carves passes through
ground the landforms fenced off. A deliberately-unreachable-except-by-ramp platform looks exactly
like a stranding, and the connector may carve a ramp of its own through the side. Verify before
adding more kinds; the fix is likely a flag marking riser pads as intentional.

**Step 4 — the level overlay (route B).** In order: read `nav-visibility.js` and `nav-corners.js`
first, since they are the two unknowns. Then the sparse overlay and its link edges in `nav-grid.js`,
with the base layer's keys untouched, proving in Node that a deck-free map produces a byte-identical
grid. Then the reference-height lookup, whose test is the refusal — a bot on a deck must resolve to
the deck, a bot beneath it to the ground, and a query with no level within tolerance must return
nothing rather than snapping. Only then thread `y` through the dozen "where am I" sites in v3.

## What would change my mind

- If per-pad falloff turns out to be awkward inside `padBlend`'s scratch loop, the cheaper fallback
  is a dedicated ramp *feature* in `stampFeatures` rather than a pad — the escarpment code already
  produces a graded edge.
- If the terrace reads as a lump rather than a structure once it is on screen, the round-pad
  shortcut is the thing to abandon, not the route.

## What each blocked proposal becomes

| Proposed | Under route C |
|---|---|
| Ramp, stepped terrace, ziggurat, quarry | A terrace kind: riser pads plus a ramp pad. Direct. |
| Platform, elevated deck | Same, with a single riser and one ramp. |
| Watchtower with a deck | A raised plinth under C; a real tower needs B, since C has no way up that is not a ramp of ground. |
| Catwalk, shelf, cantilever span | B. These are only interesting because you pass underneath, which is exactly what C gives up. |
| Ledge tower, stacked platforms | B, for the same reason. |
