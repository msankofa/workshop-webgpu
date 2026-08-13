# Model Studio Subsystem

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#modelstudio)

## Purpose

A general procedural model pipeline. **Bots are one output target, not the subject.** The studio
edits a target-agnostic spec; each target declares what it can render and what it may cost, and
emits its own native data.

The existing `bot-design-studio.html` is a bot viewer with editing bolted onto it — every inspection
tool reaches through `slot.body.joints`, so nothing in it works for an object that is not a
humanoid. This subsystem inverts that dependency: a spec editor with pluggable preview targets.

Architecture and staging: `docs/superpowers/plans/2026-08-07-model-studio-plan.md`.

## Files

| File | Responsibility |
|---|---|
| `model-primitives.js` | The primitive vocabulary and the shared geometry cache. `createPrimitiveFactory({ THREE, cache, defaults })`, `createGeometryCache()`, `triangleCount()`, `PRIMITIVE_TYPES`, `GEAR_LOD_SEG`. The cache bounds growth two ways: the nuclear `clear()` (safe only when no consumer is alive), or refcount lifecycle for a permanently-alive consumer — `beginRecord()`/`endRecord()` retain exactly the keys a build touched (liveness declared at BUILD, so LOD twins and hidden parts are covered), `releaseAll(handle)` on teardown, and `sweep(keep=0, onDispose=null)` disposes only zero-ref entries (keeping the `keep` most-recently-used as scratch; `onDispose(geo)` fires per dropped geometry so a consumer can drop the matching instanced bucket in the same tick — see `body-part-batches.js` `dropBucket`). `retain`/`release`/`refcount` are the single-key primitives. |
| `model-modifiers.js` | Vertex deformations: `taper`, `bend`, `twist`, `bulge`, `displace`. `applyModifiers(geo, modifiers)`, `MODIFIER_OPS`. |
| `model-csg.js` | BSP booleans over BufferGeometry. `csgOp(THREE, op, a, b)`, `signedVolume(geo)`, `CSG_OPS`. |
| `model-spec.js` | The ModelSpec schema, `defineTarget`, and gates 1–4. `validateSpec`, `measureSpec`, `findPenetrations`, `topologyConflict`. |
| `model-targets/bot.js` | The `bot` target: fixed anchor list, eight material roles, LOD twins on `rbox`, and `adopt`/`emit` against `BOT_BODY_DESIGN`. |
| `model-targets/creature.js` | The `creature` target: `createCreatureTarget(plan)`, anchors derived from a body plan. |
| `creature-plan.js` | The skeleton vocabulary lifted out of `port-creature-system.js`. Stock plans, `generateBodyPlan`, and `anchorsForPlan` — the seam the creature target hangs on. |

Tests, all plain Node: `test-model-primitives.mjs`, `test-model-csg.mjs`, `test-model-spec.mjs`,
`test-model-targets.mjs`, `test-creature-plan.mjs`.

## The three layers

### 1. Primitives — what any target can build

Ten types: `rbox`, `dome`, `lathe`, `extrude`, `sphere`, `cylinder`, `capsule`, `torus`, `cone`,
`tube`. Full descriptor reference, including the modifier and CSG stacks, is in
`procedural-body-weapon-contracts.md` — the bot rig is still the biggest consumer, so the field
tables live with it.

**The cache key is the cost model.** It is the whole descriptor, and every distinct key mints a
geometry, which mints an `InstancedMesh` bucket downstream that is never evicted. Two plates
differing only in bevel are two buckets. That is what makes a unique-geometry budget a hard,
checkable gate rather than a guideline.

A descriptor builds in three stages: **base primitive, then `modifiers`, then `csg`.** Primitives
are free at runtime; the other two are not, so budgets are measured on the finished geometry.

### 2. ModelSpec — what the studio edits

```
{ id, name, target, components: [ {
    id, parent,          // a component id, or an anchor name the target declares
    primitive, size,
    geometry,            // primitive-specific fields: profile, outline, path, section, radial, seg…
    transform: { position, rotation, scale },
    material,            // a target-declared role
    topologyClass,       // see below
    level,               // macro | meso | micro
    modifiers: [ { op, ...params } ],
    csg: [ { op, shape, position, rotation, scale } ],
    repeat: { count } | null,
    mirror, flags,
  } ] }
```

`geometry` is a bag rather than flattened onto the component, which keeps "which primitive and how
big" separate from primitive-specific tuning and makes `descriptorFor(component)` trivial.

`repeat` and `mirror` cost **instances and triangles but not geometries**, which is precisely why
authored repetition is a spec feature and not a primitive. `instanceCount(c, target)` is
`(mirror ? 2 : 1) × (repeat.count ?? 1) × target.instanceFactor(c)`.

The target factor exists because some targets duplicate a piece on their own. The bot's side-less
anchors (`foot`, `knee`, `hip`, `elbow`, `hand`, `shoulder`) each expand to both sides at build time,
which is **22 of the shipped design's 87 pieces**. Leaving that out made the budget read 87 instances
for a body that draws 109.

### 3. Targets — where a spec can go

`defineTarget({ key, primitives, roles, anchors, budget, lodTwin, anchorPose })`. A target is a
contract, not a subclass. `defineTarget` throws if a target declares a primitive the factory cannot
build, so a broken target fails once at definition rather than once per spec.

| | `bot` | `creature` |
|---|---|---|
| anchors | 23, from a constant | derived per plan, 5 to 114 observed |
| roles | `metal rubber plate fabric shell eye accent visor` | `shell plate trim light eye accent` |
| `tube` | no — a swept run between joints needs a path that moves with the pose | yes |
| LOD twin | `rbox` only, matching the batches | nothing |
| budget | 160 geometries / 90k triangles | 60 / 40k |

**`creature` exists this early on purpose.** A bot's anchors come from a constant, so every
assertion against it is equally consistent with a spec that has a nine-anchor list hard-coded
somewhere. A creature's anchor list is computed from its plan, so it is the only one of the two that
can catch that. The test proves it directly: the same component is legal on a four-pair creature and
illegal on a two-pair one, purely because the list is derived.

Two costs the creature target does **not** inherit from the bot. Its segments render as individual
scene meshes rather than through `body-part-batches.js`, so unique-geometry count does not buy an
instanced bucket and the budget is a different shape. And the remaining sim entanglement — the plan
vocabulary is out, but `installGeneratedPlan` still reaches into `document.getElementById`, so it
stayed behind in `port-creature-system.js`.

## The gates

Deterministic, Node-runnable, no GPU. This is the part that turns a generator into something you can
trust, and it is worth having even if no generator is ever built.

| # | Gate | Catches |
|---|---|---|
| 1 | **Legality** | primitive / role / anchor not in the target; unresolved parent; duplicate id; unknown modifier or CSG op; parent cycles |
| 2 | **Budget** | unique geometry count and triangle totals at both LODs, against the target's declared budget |
| 3 | **Topology / primitive conflict** | a structurally wrong primitive for the declared topology class |
| 4 | **Overlap / duplicates** | the same piece authored twice (error); pieces sharing space (advisory) |
| 5 | **Visibility** | a component no view can see — needs the renderer, not built yet |

Gate 5 is the one img2threejs cannot do and we can, because we own the renderer.

**A gate that did not run and a gate that passed must never look the same.** `validateSpec` returns
`{ ok, errors, warnings, skipped, measured, penetration }`. Without `{ THREE }` the budget and
penetration gates land in `skipped` and `measured` is `null`. They are also skipped when legality
failed on something structural, because costing a shape nobody can render reads as a second,
unrelated problem.

### Gate 3's rule table

Seven topology classes: `continuous-sculpt`, `assembled-solid`, `conforming-shell`,
`surface-relief`, `fiber-strand`, `material-only`, `open-shell`. The rules are **adapted from
img2threejs, not copied** — their vocabulary has no `rbox` and ours has a modifier layer theirs does
not:

- `material-only` must not declare a primitive. Definitional.
- `fiber-strand` may not be `rbox`, `extrude`, `sphere` or `dome`. A strand is swept or revolved, and
  a box stack for a cable is the flat-projection failure this gate exists to catch.
- `continuous-sculpt` may not be a **bare** hard-surface primitive (`rbox`, `extrude`, `cylinder`,
  `cone`, box) — but it may be one carrying a shaping modifier. Their version is a flat ban; ours is
  conditional, because a tapered bulging cylinder genuinely is a sculpt.
- `open-shell` must be genuinely open: `dome`, or `tube` with `cap: false`.

The table is expected to **grow with evidence**. An invented rule that rejects good designs is worse
than a missing one.

### Gate 4 is advisory, and here is why

It was built as an error: a piece buried inside another is an authoring failure. Run against the
shipped bot design, **it rejected it on 91 of 761 same-anchor pairs**, and every pair inspected was
correct work. `gear12` is a rubber bar on the FACE of `gear0`, which is a hollow `lathe` head shell.
`gear51` is a plate laid on the `gear30` shoulder pauldron. Detail-on-plate is the design language
throughout, and the rig's own authoring rule says so: every detail piece must protrude past the
surface it decorates.

**An axis-aligned box is not the shape**, so this gate cannot separate "buried" from "layered".
Doing that needs the real surface, which is gate 5's job and needs the renderer. Tightening the
threshold does not rescue it — even strict containment on all six faces still flags 19 pairs of
correct work.

So overlaps come back as **warnings**, ranked worst first, for a person to scan. The only **error**
is an exact duplicate: same geometry, same pose, same anchor, which has no reading under which it is
not a mistake. Geometry identity is the test, and it is exact, because the cache already guarantees
that identical descriptors are the same object.

Only pieces sharing a **root anchor** are compared at all. Two pieces on different anchors have no
known relative pose unless the target supplies one, and guessing would make even the advisory list
noise; those pairs come back as `penetration.unchecked`. Parent/child pairs are skipped, because a
piece attached to another is meant to overlap it.

## The round trip

`botTarget.adopt(BOT_BODY_DESIGN)` then `botTarget.emit(...)` returns the identical design — all 87
gear pieces, the same field set, no piece gaining or losing a field, and the ~35 rig fields passed
through untouched in `spec.rig`. `test-model-targets.mjs` asserts it piece by piece so a failure
names the piece.

This is the cheapest test that can invalidate the whole spec design, and it is the one that keeps
being right: every future schema change has to survive it. Four decisions came out of building it:

- **The spec covers gear, not the rig.** `torsoProfile`, `headRadial`, `limbThicknessRatio` and the
  rest describe the body the gear hangs on. They ride through in `spec.rig`. A spec is what you bolt
  onto a skeleton, not the skeleton.
- **Unknown descriptor fields land in `geometry` and come back out.** Anything the factory reads is
  a geometry field, including fields `adopt` has never heard of, which is what keeps it lossless as
  the vocabulary grows.
- **Synthesised ids are dropped on emit.** A piece with no authored `id` gets `gear{n}` for the
  studio to hold onto; emitting it would silently add 87 new fields to the design file.
- **`faceBody` is a flag, not schema vocabulary.** It puts a piece on a second anchor whose roll is
  locked to the body's forward. That is a rig behaviour, not a shape.

Measured cost of the shipped design: **87 pieces, 109 instances, 120 geometries, 68,608 triangles**
(14,848 at LOD). The 120 is 70 distinct descriptors plus 50 `rbox` LOD twins.

## Status

Stages 1, 1b, 2 and 3 are landed. The prop target, `model-studio.html` and the image → spec intake
are not started. Gate 5 (visibility) needs the renderer and is the missing half of gate 4.
