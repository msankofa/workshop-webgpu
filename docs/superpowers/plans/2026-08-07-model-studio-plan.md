# Model studio plan

**Status:** authored 2026-08-07. Stages 1, 1b, 2 and 3 landed, with the creature-plan extraction
pulled forward alongside stage 2. The prop target is next. Reference doc:
`docs/subsystems/model-studio.md`.

A general procedural model pipeline. Bots become **one output target**, not the subject. The studio
edits a target-agnostic spec; each target declares what it can render and what it costs, and emits
its own native data.

## Why this shape

`bot-design-studio.html` is a bot viewer with editing bolted onto it. Every inspection tool reaches
through `slot.body.joints`, so nothing in it works for an object that is not a humanoid. The new
studio inverts that dependency: it is a **spec editor with pluggable preview targets**.

The img2threejs read (`docs/superpowers/reviews/` and the chat of 2026-08-07) settled which half of
that project transfers. Its intake, spec schema and deterministic gates are ahead of ours. Its
build half is not usable here: it emits a `SkinnedMesh` with per-component materials, and neither
can go through `body-part-batches.js`. So we take stages 1, 2 and 4, and write our own stage 3.

## The three layers

### 1. Primitives — what any target can build

The geometry factory that already exists inside `player-procedural-body.js` (`gearGeometry`,
`sharedGeo`, the `_sharedBodyGeo` cache), extracted so more than one system can use it.

The vocabulary inherited from the bot rig is nine types: `rbox`, `cylinder`, `sphere`, `cone`,
`capsule`, `torus`, `lathe`, `extrude`, `dome`. `rbox` is worth keeping and img2threejs has no
equivalent — a raw box reads as a hard-edged cube, and the chamfer is what makes plate read as
plate.

**This vocabulary is adequate for hard-surface armour and for nothing else.** That limit is easy to
miss by looking at what the bot is made of, which is a circular measurement: the bot uses `rbox` for
76% of its pieces because `rbox` is what existed and the bot is armour. The unused primitives say
nothing about what a prop, weapon, vehicle or creature needs.

Reasoning forward from the targets instead, three things were missing, and only the first was a
primitive. **All three landed in Stage 1b**, so a descriptor now builds in three stages — base
primitive, ordered `modifiers`, then `csg`:

- **`tube` — a profile swept along a curve.** Cables, hoses, slings, straps, railings, tails, vines,
  exhausts. The fake is a chain of cylinders, which costs more geometries *and* reads as segments.
  `section` takes a closed polygon, so a flat strap and a round cable are the same primitive.
- **A modifier layer** (`model-modifiers.js`): `taper`, `bend`, `twist`, `bulge`, `displace`.
  Organic form is not reachable by lengthening a list of shapes; it needs operations ON shapes. This
  is what img2threejs's `continuous-sculpt` topology class, subdivision module and SDF primitives
  exist for, and what its flat-projection-bias rule guards against. They need tessellation along the
  axis they act on, which is what the `lengthSeg` field supplies.
- **Booleans** (`model-csg.js`): BSP `subtract`/`intersect`/`union`, with the cutter itself a
  descriptor. Magazine wells, trigger guards, vents, bolt holes, eye sockets, recessed panels. This
  is precisely the defect visible in img2threejs's own Sony demo, where the case's two recessed
  wells rendered as a flat top with blobs on it.

`plane-card` (zero-thickness two-sided: cloth, capes, membranes, foliage) is a likely fourth, held
back only because double-sided transparent geometry renders twice without `forceSinglePass` — the
defect the effect-renderer rewrite removed — so it arrives with a rule attached.

Two things NOT to add. `ellipsoid` is a scaled sphere and `g.scale` already accepts an array;
adding it would mint buckets for nothing. `instanced-cluster` buys img2threejs one draw call for
repeated fasteners, but this renderer already instances, so twelve identical bolts already share a
bucket. What is missing there is *authoring* repetition — saying it once instead of twelve times —
which is a spec feature, not a primitive.

**Primitives are free at runtime; modifiers and CSG are not.** A new primitive costs code in the
factory, a case in the validator and a control in the panel, and nothing per frame. Subtraction and
subdivision produce genuinely heavier meshes. That makes the budget gate more load-bearing once
they land, not less.

Measured on the bot target, which is the only one that exists yet: 87 gear pieces, **70 distinct
descriptors**, and **120 geometries in the game** (70 plus 50 `rbox` LOD twins — only `rbox` gets a
twin). A recorded dead end: authoring `scale` instead of `size` to collapse buckets is worth
nothing here. Normalising every piece to its aspect ratio gives 69 distinct shapes against 70
descriptors. These are different shapes, not one shape at many sizes.

**The cache key is the cost model.** It is the full descriptor —
`[type, profile, outline, size, radial, seg, bevel, corner, depth, axis, smooth, rim, wall]` — and
every distinct key mints an `InstancedMesh` bucket downstream that is never evicted. Two plates
differing only in bevel are two buckets. This is what makes a unique-geometry budget a hard,
checkable gate rather than a guideline.

### 2. ModelSpec — what the studio edits

Target-agnostic component tree, borrowed from img2threejs's `ObjectSculptSpec` and trimmed to what
this renderer can express. Their component fields map onto our gear descriptors almost one to one,
which is why the schema is worth borrowing rather than inventing.

```
{ id, name, target, components: [ {
    id, parent,            // parent is a component id or a target anchor name
    primitive,             // one of the vocabulary
    size, transform: { position, rotation, scale },
    material,              // a target-declared role
    topologyClass,         // continuous-sculpt | assembled-solid | conforming-shell |
                           // surface-relief | fiber-strand | material-only | open-shell
    level,                 // macro | meso | micro
    modifiers: [ { op, ...params } ],   // ordered; taper | bend | twist | bulge | displace
    csg: [ { op, shape } ],             // subtract | intersect | union
    repeat: { count, along, ... } | null,
    mirror, flags,
  } ] }
```

**`modifiers`, `csg` and `repeat` are in the schema from the start even though nothing emits them
yet.** Unused fields are free; retrofitting an operation layer onto a flat descriptor means
rewriting every target and every gate at once. This is the one decision here that is cheap now and
expensive later.

Two consequences follow immediately. **The cache key must include the whole modifier and CSG
stack**, or two pieces differing only in a taper silently share one geometry — the same trap the
gear key already documents. And because these operations produce heavier meshes rather than free
ones, the budget gate has to run after them, not on the base primitive.

`topologyClass` is carried purely so the validator can reject structurally wrong primitives. It
costs one string per component and converts a class of judgment failure into a rule — see gates.

### 3. Targets — where a spec can go

A target is a contract, not a subclass:

```js
{
  key: 'bot',
  primitives: [...],        // subset it can render
  roles: [...],             // material roles that exist in its material system
  anchors: [...],           // legal parent names for a root component
  budget: { geometries, triangles },
  emit(spec),               // -> target-native data (bot: a gear[] array)
  adopt(native),            // -> ModelSpec, so existing designs come IN
  mount(spec, ctx),         // build a preview in the studio scene
}
```

First two targets, chosen to prove the seam rather than to be exhaustive:

- **`bot`** — anchors `head neck torso waist pelvis hip knee elbow foot`, roles
  `metal rubber plate fabric shell eye accent visor`, emits the gear array
  `bot-body-design.js` already holds. `adopt` plus `emit` gives a **round-trip test**: the shipped
  design in, the identical design out. That is the proof the spec is expressive enough, and it is
  cheap to run.
- **`prop`** — a static world object with no rig: one root, free-form child transforms, instanced
  through the same batches. This is what `bot-structures.js` and the shoot-house pieces want.

The full intended output range, listed so the seam is designed for it rather than discovered by it:

| Target | Needs beyond today's vocabulary |
|---|---|
| `bot` | nothing — it is the proof the spec is lossless |
| `prop` / structure | `tube` (railings, cable runs), subtraction (vents, openings) |
| `weapon` | subtraction (magazine wells, trigger guards), `tube`, `repeat` (rails, knurling) |
| `vehicle` | `tube` (hoses, frames), subtraction (wheel arches, intakes) |
| `dressing` | `plane-card`, `repeat` |
| `creature` | anchors DERIVED from an existing body plan; modifiers for organic surface |

**`creature` is much cheaper than first assessed, because the generated skeleton already exists.**
`generateBodyPlan(rng)` in `port-creature-system.js` produces arbitrary rigs today — variable leg
pairs, variable segments per leg, randomised attachment points and rest positions, optional head —
with `finalizePlan` assigning rows and `clonePlan` round-tripping it.

So a creature is **a bot with a derived anchor list**. `bot` reads nine anchors from a constant;
`creature` computes `leg{i}.seg{j}` plus body and head from the plan. Same descriptor model, same
gear-hanging, only the anchor source differs. Two targets collapse into one mechanism, and it is
the same direction as the creature-bot merge already on the board.

Two costs remain, and neither is the skeleton:

- **The rig is tangled with the sim.** `port-creature-system.js` is 5,455 lines of steering,
  combat, foraging and grabbables around the plan code, and `installGeneratedPlan` reaches into
  `document.getElementById`. It needs the Stage 1 treatment: lift the plan vocabulary and the IK
  chain into a DOM-free, sim-free module and leave the behaviour where it is.
- **Creatures do not render through the batches.** Segments are individual scene meshes, so this
  target does not inherit the bot's instancing. Its budget is a different shape and bot economics
  must not be assumed onto it.

This also narrows why the modifier layer is needed. The skeleton is solved; the SURFACE is not.
Creature limbs are uniform boxes and capsules, so taper and bulge are what make a limb read as a
limb rather than a tube. That is a smaller and truer claim than "no finite primitive list makes a
creature."

## The gates

Deterministic, Node-runnable, no GPU. This is the part that turns a generator into something
trustworthy, and it is worth having even if no generator is ever built.

1. **Legality** — primitive, role and anchor exist in the target. Parent references resolve. No
   cycles.
2. **Budget** — unique geometry count and triangle totals at both LOD segments, against the
   target's declared budget. `rbox` is 828 triangles at `seg: 3` and 156 at `seg: 1`.
3. **Topology/primitive conflict** — img2threejs's rule, worth taking verbatim: a
   `continuous-sculpt` may not be `box`, `cylinder` or `cone`; a `fiber-strand` may not be `box` or
   `plane-card`. They call the failure it prevents flat-projection bias — picking a box stack for
   an organic bulge. The bot's recorded wrong reads (wetsuit, cone, nappy, bobblehead) are that
   same failure, found by four rounds of critique instead of by a rule.
4. **Overlap** — does this piece intersect that piece. **This turned out to be advisory, not an
   error** — see correction 6.
5. **Visibility** — every component must read from at least one view. Generalised from the
   existing `auditVisibility`, which is the tool that breaks stalls: a part you have been nudging
   for twenty minutes may simply be inside the torso.

Gate 5 is the one img2threejs cannot do and we can, because we own the renderer.

## Review loop

Kept from `bot-design-studio.html`, generalised off the bot rig, plus one thing it is missing:

- Six-angle contact sheet, sim paused, labels hidden, centre-square crop.
- **A reference pane.** Judgment is comparative and ours currently compares against memory. This is
  also the gap that shows in img2threejs's own showcase: their hero image and their thumbnail of the
  same knife disagree badly, because one sheet from one angle cannot catch it.
- Bounded correction counts per pass. A loop that cannot detect its own non-convergence runs
  forever.

## Stages

| # | Deliverable | Value if the rest never lands |
|---|---|---|
| 1 | **DONE** `model-primitives.js` — extract the factory + cache. Bots import it; behaviour identical. | Geometry vocabulary becomes testable and reusable. |
| 1b | **DONE** `tube` primitive + the modifier stack (`taper`/`bend`/`twist`/`bulge`/`displace`) and CSG (`subtract`/`intersect`/`union`), keyed into the cache. | The vocabulary stops being armour-only. |
| 2 | **DONE** `model-spec.js` + `test-model-spec.mjs` — schema, `defineTarget`, gates 1-4. Plus `creature-plan.js` and both targets' declarative halves. | A validator for hand-authored designs, today. |
| 3 | **DONE** `model-targets/bot.js` with `adopt`/`emit` + round-trip test. | Proves the spec expresses the shipped design losslessly. |
| 4 | `model-targets/prop.js`. | Second target; proves the seam is real and not bot-shaped. |
| 5 | `model-studio.html` — target picker, tree, panel, inspection, critique sheet with reference. | The studio itself. |
| 6 | Image → spec intake, borrowing img2threejs stages 1-2. | The generator. Gated on 1-5. |

Stage 1 touches a live game module, so it snapshots to `versions/` first and must be
behaviour-identical — verified by the existing body tests plus a new geometry test.

## Assumptions, stated rather than asked

- **Inputs** are assumed to be reference images of the concept-art / game-reference kind, not
  photographs needing PBR extraction. If they are photographs, stage 6 grows an intake step; stages
  1-5 are unaffected.
- **Build order** is bot then prop, because that pair proves the seam cheaply. It is NOT a claim
  that the studio is bot-shaped. The schema is sized for the whole target table from the start.
- **`creature` is a third target, not a second phase.** Since its skeleton already exists, the only
  question is whether the plan extraction happens alongside the prop target or after it. Doing it
  early is the stronger test of the anchor seam: a target whose anchors are computed per instance
  proves the spec is not quietly assuming a fixed list.

## Corrections this plan has already absorbed

Recorded because each was a wrong turn that measurement or review caught, and the reasoning is
worth more than the conclusion:

1. **Reading the bot's primitive usage as evidence about the vocabulary was circular.** 76% `rbox`
   describes what existed, not what a general studio needs.
2. **"Author `scale` instead of `size` to collapse buckets" is worth one geometry.** 69 distinct
   shapes against 70 descriptors. Measured before recommending, and the measurement killed it.
3. **The 140-geometry figure was a test artifact.** The test twins every type; the game twins only
   `rbox`. The real number is 120.
4. **Stage 1b's `tube` shipped with inverted side winding, and only a volume check found it.** The
   solid measured exactly **minus one third** of its true volume, which is the caps' contribution
   alone — the sides were cancelling the wrong way. It would have rendered as a plausible tube from
   outside and been wrong for every boolean, every normal and every backface test. Three of my own
   assertions in the same pass were wrong rather than the code: an open surface's signed volume is
   not zero but origin-dependent; a bend's *outer* edge is longer than the centreline so the axis
   extent can grow, not shrink; and a 24-sided section is an inscribed polygon 1.1% under a circle,
   so testing against `pi r^2 h` inside a loose tolerance would have hidden a real shortfall. The
   transferable part: assert against a number computed by hand for the geometry that is actually
   built, not for the ideal shape it approximates.
5. **"A generated skeleton is the hard unbuilt part of `creature`" was wrong.** `generateBodyPlan`
   has done exactly that for a long time. The unbuilt parts are extracting it from the sim and
   giving limbs an organic surface — both smaller. Treating an existing subsystem as absent is the
   same failure as reading the bot inventory as a vocabulary requirement: assuming the shape of the
   problem instead of checking it.
6. **"Pairwise penetration is a real authoring failure" was wrong, and the round trip proved it.**
   Built as an error, gate 4 rejected the shipped bot design on 91 of 761 same-anchor pairs, and
   every pair inspected was correct work: `gear12` is a bar on the FACE of `gear0`, a hollow `lathe`
   head shell. Detail-on-plate is the design language, and the rig's own authoring rule says every
   detail piece must protrude past the surface it decorates. An axis-aligned box is not the shape,
   so the gate cannot separate buried from layered — that needs the real surface, which is gate 5.
   Tightening the threshold does not rescue it: strict six-face containment still flags 19 correct
   pairs. Overlap is now a ranked warning; the only error is an exact duplicate. The lesson is the
   value of running a gate against a design already known to be good, rather than only against
   synthetic cases built to fail.
7. **The budget undercounted the bot by a quarter.** 22 of the 87 gear pieces sit on side-less
   anchors, which expand to BOTH sides at build time, so the scene draws 109 instances. Targets now
   declare an `instanceFactor`. Found by measuring the real design rather than by reading the code.
