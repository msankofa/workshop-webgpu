# Roads

Spline-drawn dirt roads that follow the ground. Ported 2026-08-10 from
[SeloSlav/spline-based-procedural-dirt-road-system](https://github.com/SeloSlav/spline-based-procedural-dirt-road-system)
(TypeScript/Vite, MIT), which is an application rather than a library — the road model, the graph
topology and the ribbon meshing were read out of its `src/roads/` and rewritten as plain modules
here. Its river/bridge half is not ported: those files are welded to that project's river field and
have no counterpart in either of our viewers.

Wired into **`bot-viewer-v3.html`**. Built in a fork first, browser-approved on 2026-08-10, and
merged straight back — the fork is gone.

Also wired into Base Game through the root **`trail-router.js`** and
**`base-game-trails.js`**. The former is the park's generic A* router moved out of the retired
experience; the latter derives sites and legs kilometres ahead of the player and feeds routed
polylines into `network.addRoadPath`. The old park module now re-exports the shared router and keeps
only its park-specific landmark list. See
`docs/subsystems/pokemon-park.md`.

## The one idea that matters: roads are draped, not carved

Nothing in this subsystem modifies terrain. A road is a ribbon of triangles whose every vertex —
centre, paved edge and feathered shoulder alike — samples the ground at its **own** XZ and lifts a
few centimetres. Two consequences follow, and they are the reason this port was cheap:

- **The entire terrain contract is one callback**, `heightAt(x, z)`. The environment viewer could
  pass `terrainHeightAt` from `terrain-field.js` unchanged.
- **The CPU/GPU twin problem does not arise.** Carving would have meant writing the same
  displacement twice — once in `terrain-field.js`'s JS and once in `cdlod-terrain.js`'s TSL
  `heightFn` — and keeping them in sync forever. A draped ribbon is indifferent to how the ground
  beneath it was produced.

### …but drape on the surface you can SEE

The callback must return the height of the **rendered** ground, not of the field it was generated
from. Those are different surfaces. `buildTerrainMeshArrays` emits flat triangles between grid
vertices; it agrees with `heightAt` exactly at those vertices and departs from it in between, by
however much the ground curves across one cell. In a hollow the chord rides *above* the field it
interpolates.

Measured on the viewer's own "eroded highlands" preset (`meshCell` 0.5 m, terrace steps, drainage
channels), the mesh sits **up to 0.21 m above the field** — five times the road's 4 cm lift. On
gentle default terrain the same gap is 0.024 m and stays under the lift. That is precisely the
first bug this system shipped with: green ground came through the road on rough terrain, never on
smooth, stable rather than flickering, because it was not depth precision at all — the terrain
really was in front.

The fix is `createMeshSurface(bounds, mesh)` in `bot-terrain.js`, which reads heights straight off
the vertex buffer that was just uploaded and interpolates them with the same triangle split the
index buffer uses. The viewer republishes it from `buildFloorMesh` on every rebuild.

### ...and clear it over the whole triangle, not at its corners

That was still not enough, and the second round of "terrain is coming through the road" is the more
instructive one. A road sampling the right surface at every vertex can still be buried, because
**the road is its own mesh** -- vertices every 0.9 m along and *none at all* across its 3.2 m width
made triangles far coarser than the 0.5 m ground they were laid over, so their interiors sagged
through ground their corners cleared comfortably. Measured: **26% of the road's area sat below the
terrain, by up to 0.64 m** against a 4 cm lift. The first test passed the whole time, because it
checked vertices.

Two changes fix it, and both are needed:

- **`surfaceCell`** -- no road quad spans more than one ground cell, in either direction. The core
  ribbon gains lateral columns, the shoulder is subdivided, the junction discs gain rings, and the
  centreline sample spacing is capped by the same number. The viewer sets it to half the terrain's
  `meshCell`.
- **`ground.maxNear(x, z, r)`** -- each vertex takes the *highest* the ground gets within its own
  neighbourhood rather than the height under itself, so a terrace lip between two vertices cannot
  cut the triangle spanning them. The radius is read off each vertex's real neighbour distance,
  because road quads are not uniform: on the outside of a turn they stretch to several times nominal
  size, and every fixed radius left slivers exactly there. It must exceed the quad's half-diagonal
  (0.707), not merely its side -- using 0.62 was an arithmetic slip that left dips in.

Result on the roughest preset, across three seeds and four route shapes including a hairpin: **no
penetration anywhere**, at 3.8 ms and ~11k vertices per road.

The price is that the road is an upper envelope, so it rides above the ground rather than exactly on
it -- a median of about 0.14 m on that preset, more where it bridges a gully. That reads as a graded
track rather than a painted stripe, which is arguably right, but it is a real trade-off. If it ever
looks wrong, the answer is carving (see below) rather than a smaller envelope: shrinking the radius
brings the burial straight back.

Consequently there is **no polygon offset on any road material**, deliberately. Separation is
geometric. A depth bias would only paper over a surface that was contesting for real, and its sign
depends on the renderer's depth convention — one more thing to get wrong. `test-roads.mjs` asserts
clearance over triangle **interiors**, sampled barycentrically, and separately asserts that the old
coarse build fails that same check. Vertex-only clearance is the assertion that let this ship twice;
do not weaken it back.

The cost of draping is that a road follows every wiggle of the ground under it. That is correct for
a dirt track and wrong for a graded road. If a graded road is ever wanted, `bot-terrain.js` already
has `flatten` pads with a falloff; extending those from circles to polyline capsules would carve the
strip, and the ribbon would still drape on top of the carved result with no changes here.

## Files

| File | Role | THREE? |
|---|---|---|
| `road-path.js` | Curve evaluation, ground-following sampling, point-to-polyline and segment-crossing queries | no |
| `road-network.js` | The graph: snapping, crossings, edge splitting, junction classification, snapshots | no |
| `road-index.js` | Uniform 24 m grid index; every "is there a road here?" question | no |
| `road-mesh.js` | Centreline → geometry arrays (core ribbon, shoulder, junction patches) | no |
| `roads.js` | Materials, meshes, the draw tool; the only file that touches THREE | yes |

The first four are plain `{x, y, z}` objects and run in Node, which is what `test-roads.mjs`
exercises. Adding a viewer means writing the input wiring, not porting geometry code.

## Geometry, layer by layer

`buildRoadCoreArrays` — the paved surface. Columns from left edge to right edge at `surfaceCell`
spacing, lifted `coreLift` (6 cm). The paved edges carry a seeded, three-sample-smoothed sine wobble
(`edgeJitter`, 18 cm) so the road is not a drafted ribbon; the same seed always reproduces the same
edge, or the road would crawl on every rebuild.

`buildRoadShoulderArrays` — the feathered edge, and the part worth understanding. Six vertices per
sample:

```
outer-left   mid-left   inner-left | inner-right   mid-right   outer-right
alpha 0      alpha 0.42 alpha 1    |  alpha 1      alpha 0.42  alpha 0
```

The inner stops sit `innerOverlap` (14 cm) back **under** the paved core, which is what hides the
seam between the two meshes. The middle quad is deliberately not emitted — that gap is the road
itself. Every one of these vertices re-samples the ground at its own position and lifts by
`shoulderLift` (5.5 cm, above the core so the two never z-fight). That per-vertex re-sampling is
what stops a shoulder flare from punching through sloped ground, and it is the single most
important detail in the original implementation.

`buildRoadPatchArrays` — a two-ring disc at every node: an opaque inner ring covering where the arms
meet, and a transparent outer ring so the patch dissolves into the terrain instead of ending on a
visible circle. Without it, three roads meeting at an angle leave open corners. Dead ends get the
same disc at a smaller radius, and the road's terminal sample is pulled back by `endTrim` so the cap
covers a rounded mouth rather than a squared-off ribbon end.

Alpha reaches the shader as a `roadAlpha` vertex attribute driving `material.opacityNode` (verified
present in the r0.184 build). The original smuggled it through `uv.x` instead.

## Topology: what `addRoadPath` does

One call handles the whole graph job, which is why the draw tool has no topology knowledge at all:

1. Simplify the raw click polyline (`simplifyDistance`, 0.85 m).
2. Reject routes shorter than `minRouteLength`.
3. Resolve each endpoint: within `snapDistance` of an existing node, join it; within reach of an
   existing road, split that road and join the new node.
4. Find proper crossings against every existing edge, ignoring any within `crossingGuard` of either
   end (a crossing there would leave a stub shorter than its own junction patch) and any within
   `crossingSpacing` of a crossing already accepted. Each survivor splits the road it crossed.
5. Splice the crossing points into the route and emit one edge per span between connection points.
6. Prune orphaned nodes; reclassify every node as endpoint / bend / t-junction / cross-junction /
   complex by arm count.

Tuning constants live in `ROAD_NETWORK_DEFAULTS` and are scaled down from the original's
medieval-map numbers (4.2 m roads over open countryside) for arena-sized maps of 40–80 m.

Snapshots persist **control points only**. The sampled centreline is re-derived against whatever
terrain is live, so a road saved on one map re-drapes correctly when the ground under it changes
rather than floating or sinking.

Roads ride in the **maze** save slot, alongside the terrain that shaped them — they are map
geometry, not AI tuning or look. `applyMazeState` restores the graph first and lets the layout
rebuild that follows re-drape it onto the new ground.

## What consumes roads

### Base Game trail routing (2026-09-01)

`trail-router.js` is pure JS. `buildTrailGrid` and `gridFromWindow` produce bounded typed-array
grids; `routeTrail` uses typed-array g-scores, parents, closed flags and f-scores instead of one
`Map`/`Set`/object allocation per expanded post. Optional `costMul` discounts an existing corridor,
and optional `crossSlope` rejects a move whose terrain gradient across the direction of travel is
too steep. Chaikin smoothing validates every generated point against walkability.

`base-game-trails.js` owns the deterministic world planner. It creates one placeholder site per
resident site tile where possible, builds a relative-neighbourhood graph over settled 3x3 tile
blocks, canonically orders the resulting legs, and routes at most one leg per update. A leg waits
for lower-keyed intersecting legs and only those lower routes contribute its corridor discount, so
approach direction cannot change the geometry. Eviction drops legs that touch the departed site
tile and any owner whose 3x3 context became incomplete; rare out-of-order returns rebuild topology
from the stored canonical paths without rerouting them. This keeps the graph bounded and makes
prune-and-return deterministic. `test-trail-router.mjs` and
`test-base-game-trails.mjs` cover the router, corridor cost, water/slope safety and deterministic
sampled polylines.

`roads.js` no longer tears down every mesh on `rebuild()`. Revision maps retain unchanged edge and
node meshes; a queue builds one edge ribbon or node patch per `update()`. `setResidency(x,z,radius)`
queries the road spatial index only after a movement stride and keeps meshes for nearby edges while
the complete topology remains available for planning and vegetation. A world-space distance fade
softens the residency edge. Base Game uses a 70 m radius inside the 1.25 m contact window and a
`readyAt` hook, so no mesh is built until its exact ground samples are resident. The group follows
render-origin rebases. `test-road-system-incremental.mjs` covers incremental builds, no-op rebuilds,
residency and disposal.

`groundFromHeightFn(fn, {cell})` can now build a max-near envelope by scanning the supplied cell
spacing. Base Game passes `terrain.contactHeightAt`, never volumetric `groundHeight`, avoiding the
otherwise multiplicative surface-bisection cost per road vertex.

**Vegetation clearance.** `bot-flora.js` gained an optional `clearFn(x, z)` — "true where nothing may
grow" — checked by both the grass `acceptFn` and the plant-placement filter. Default is `null`, so
every other host behaves exactly as before. Note the original project claimed automatic tree *and*
grass clearance in its README but only ever cleared grass; nothing in its `props/` or `vegetation/`
references roads at all.

The viewer passes `roadSystem.isNearRoad`, a band measured from the **centreline** and independent of
road width. The default (1.35 m) is deliberately narrower than a default road's half width (1.6 m),
so blades survive along the outermost strip of paving and the verge grows in over the road's edge
instead of stopping dead at it. That overgrown fringe is the intended look and is what makes a dirt
track read as used; widening the margin to clear the full paved width makes the road look freshly
laid. `test-roads.mjs` locks it, because measured against road width it looks like a bug.

The same band drives the nav bias reach, for the same reason: both are "near the road", not "on the
paving".

**Nav bias.** `nav-grid.js` gained `setNavTravelCost(grid, costAt)`, which bakes one per-cell
multiplier and applies it in both `findPath` and `floodFill`, averaged across each step's two cells.

> Costs are clamped to **≥ 1** deliberately. The A* heuristic charges one unit per cell, so a cost
> below 1 would make it optimistic and the returned path would no longer be the cheapest one. A
> preferred surface is modelled as *"everything else is dearer"*, never as *"this is cheaper than
> walking"*. `test-roads.mjs` asserts the clamp, and asserts that raising the off-road cost actually
> pulls a route onto the road while leaving off-road ground reachable.

Grids built without a cost field carry `travelCost === null` and are bit-identical to before.

**Collision: none.** Road meshes are tagged `fpNoCollision`; capsules and bullets pass through them.
They are decoration plus a nav hint.

## Using it in the fork

The **Roads** card sits in the World tab. `draw road` arms a tool in the same slot as the spawn
tools, so arming one disarms the others:

- click the ground to drop a control point (the preview ribbon follows the cursor, red until the
  route is long enough to be kept)
- **Enter** commits, **Backspace** removes the last point, **Escape** puts the tool away and
  abandons the draft
- `erase road` deletes whatever stretch you click
- ends that land on an existing road join it — that is how you build a network rather than a pile of
  separate roads

Sliders: new-road width (existing roads keep the width they were drawn at), bare strip, open-ground
cost and road-pull reach (the nav bias), plus show/hide and clear-all. Both the clearance and the nav
reach are measured from the centreline.

Committing a road re-runs only the nav and flora stages of `rebuildDerived`. Roads themselves
re-drape in the geometry stage, before flora, since flora asks them where it may not grow.

## Status

Shipped in `bot-viewer-v3.html`, browser-approved 2026-08-10, Node-tested (`node test-roads.mjs`,
plus the full existing suite still green). Not yet done:

- **Not in the environment viewer.** The port there is the adapter plus input wiring; the geometry
  and topology code needs no changes — but note that viewer's ground is GPU-displaced under
  `?terrain=gpu`, so the "drape on the rendered surface" rule above needs an answer there that
  `createMeshSurface` does not provide.
- **No road-aware bot behaviour** beyond the path-cost bias — nothing patrols a road or uses one as
  a landmark.
