# Stadium models

Reading Pokemon Stadium's 151 battle models, working out which of their unnamed bones are legs, and
walking them with the repo's own gait code.

**Files**

| File | What it is |
|---|---|
| `stadium-glb.js` | Minimal glTF-binary reader — JSON chunk, node transforms, skinned vertices. No THREE. |
| `stadium-rig-map.js` | Auto-maps an unnamed skeleton into legs, spine, head and tail. No THREE. |
| `stadium-rig-roles.js` | Hand-assigned bone roles that override the auto-mapper, and the compile step. No THREE. |
| `stadium-pose.js` | Poses as local TRS per bone name: blending, validation, distance. No THREE. |
| `foot-sdf.js` | A foot as a contact patch: round-box SDF fit plus the hull of the vertices that reach the floor. No THREE. |
| `stadium-stance.js` | The neutral pose a species stands in, as a sparse edit to the glTF's own rest. No THREE. |
| `stadium-species.js` | The one load path: stance in, posed file mapped, pinned legs obeyed. No THREE. |
| `stadium-walker.js` | Drives the mapped legs from `creature-locomotion.js` and writes the pose onto the rig. |
| `demos/stadium-walker-v2.html` | The staged viewer: rig, stand, walk, trial. Where the stance is authored. |
| `demos/stadium-walker.html` | v1, unstaged. Kept as-is; it reads the same save files but cannot edit a stance. |
| `test-stadium-rig.mjs` | Node checks for all three, over every model in `models/stadium/`. |
| `test-stadium-stance.mjs`, `test-stadium-species.mjs` | Node checks for the stance and the load path. |
| `_check_stadium-walker-v2.html.mjs` | Static checks on the staged page: stage membership, wiring, persistence. |
| `test-foot-sdf.mjs` | Node checks for the fit, the SDF and the patch, over every model. |
| `demos/sdf-pikachu.html`, `demos/sdf-pikachu-field.js` | The SDF spike: a model raymarched as fitted boxes or as a baked volume, beside the real mesh. |
| `demos/sdf-mesh-bake.js` | Converting the mesh itself: triangle distances, the winding-number sign fill, per-bone distance and colour cubes. No THREE. |
| `test-sdf-pikachu.mjs` | Compiles the spike's TSL headlessly and checks the box bake. |
| `test-sdf-mesh-bake.mjs` | Checks the volume bake, and measures how far each field lands from the real triangles. |
| `_check_sdf-pikachu.html.mjs` | Static checks on the spike page: does the module parse, is every control wired. |
| `models/stadium/*.glb` | **All 151** extracted species plus `manifest.json`, checked in so nothing here needs a ROM. |
| `stadium-reference-species.js` | The fourteen this subsystem was tuned against, which the tests assert over. |
| `docs/stadium/` | The upstream session package: `HANDOFF.md`, `feasibility-report.md`, `tooling/`. |

## Why this exists

`docs/stadium/feasibility-report.md` assesses eight mods for **DramaticShapeVoxelMod**, which draws
Stadium's 3D models inside a Gen 1 recomp. Two of the most wanted — follower Pokemon and ambient wild
mobs — rest on one claim: that these models can travel through a world. They cannot as shipped.
**Stadium's models carry no walk cycle**: the ROM only needed idle, attacks, faint and entrance,
because a Pokemon in Stadium stands on a battle platform. Locomotion has to be invented, and that is
what this subsystem does.

## Getting the models

They are extracted from a Pokemon Stadium (US 1.0) ROM by the mod repo's own pipeline. **You do not
need the ROM to work here** — all 151 are now checked into `models/stadium/` (74 MiB) with a
`manifest.json` carrying per-species triangles, bones and clip labels. They were recovered from the session
package's `pokedex-151.html` viewer; the fourteen that were already here came out byte-identical, and every
model's clip count and durations match its manifest entry (72,859 animation channels, zero mismatches).

The rig work here was tuned against fourteen of them, and `stadium-reference-species.js` names that set.
The tests assert over it rather than over the directory, because across all 151 the mapper finds no legs on
35 species **by design** and says so in `warnings`. `demos/pokemon-park.html` is what needed the rest; see
`pokemon-park.md`.

```
python docs/stadium/tooling/extract_glb.py 019 058 077 128     # or no arguments for all 151
```

That script expects `package/pokedex-151.html` beside it (from `dramaticshape-session.zip`). The ROM
route is `python model_extract/pipeline/build.py --rom=<rom> --out=<dir> --no-js` in a clone of
`scottcandy34/DramaticShapeVoxelMod-latest`; the original `DramaticShape/DramaticShapeVoxelMod` repo
is gone (404 even authenticated). ROM md5 must be `ed1378bc12115f71209a77844965ba50`.

## Facts about these files, all verified rather than assumed

1. **Skinning is rigid.** Every vertex binds to exactly one bone at weight 1.0, on all 151 species.
   So each bone owns a definite lump of geometry, and placing a bone places its geometry exactly.
2. **Two nodes per bone.** A `boneNN` pivot carries rotation and translation; a childless
   `boneNN_scale` leaf carries the accumulated scale and is what the skin binds to. All inverse bind
   matrices are identity.
3. **Bone origins are not anatomical joints.** A Rattata hind leg's four pivots sit within two units
   of the body centre while their geometry stands eleven units away on the floor. Reading joint
   positions off the node transforms — the obvious move — produces a skeleton unlike the animal.
4. **Bones are semantically unnamed** (`bone00`, `bone01`, …) and numbered in extraction order.
5. Models stand on y = 0 and face +z. Vertices are authored 10× in bone-local space, so geometry
   bounding volumes are useless: set `frustumCulled = false` or parts vanish with camera angle.
6. Some face-decal triangles are wound backwards, because the game renders with culling off. Use
   `THREE.DoubleSide`.
7. Clips are 30 fps and every one of them wraps; the game's state machine ends one-shots, not the
   player. Eye blinks are texture swaps glTF cannot carry, so the glb has the open-eye frame only.

## `stadium-rig-map.js` — finding the legs

`mapStadiumRig(json, bin, opts)` returns plain JSON: `{ units, forward, root, body, bodyCentroid,
rideHeight, legs[], head, tail, spine, names, restWorld, warnings }`.

Because bone origins are meaningless (fact 3), **every joint position is derived from geometry** —
`jointBetween(a, b)` averages the nearest 30% of each bone's vertices to the other's centroid and
takes the midpoint. A foot is the `sole()`: the horizontal centre of the lowest fifth of the foot
bone's vertices, dropped to the floor.

Legs are found by their **feet**, in three rules, each rejecting what the previous one lets through:

1. *reaches the floor* — rejects head, ears, horns, wings.
2. *is off the midline* — rejects jaw, belly and tail, which on a low-slung animal hang as low as the
   feet do.
3. *is the most distal such chain* — rejects the torso and everything between it and the foot. Ponyta
   needed this one: a mane tuft hanging off a thigh makes that thigh a branch point, cutting one leg
   into three chains that all "reach the floor".

Surviving chains are paired across the mirror plane. Matching bone counts only break ties — requiring
them loses Pikachu, whose left foot hangs off an extra bone its right does not have. Each foot is then
walked **up** to the first bone that is also an ancestor of its mirror partner, which is the pelvis or
shoulder by definition, and everything below that is the leg.

The head is the heaviest chain with no leg under it; the tail is the longest rearward one; the spine
is the path from the root to the head.

Each leg carries a two-bone abstraction for the IK: `hip`, `knee`, `foot`, `l1`, `l2`, `pole`,
`restDir`, `kneeIndex`. **The knee splits the chain where the two halves are most equal in a straight
line**, not at the midpoint of its arc length. A two-bone leg can only reach the annulus between
|l1 − l2| and l1 + l2; splitting a Rattata foreleg into a 97 mm upper and a 25 mm stub locks its foot
out of everything within 59% of the leg's length from the hip, which is most of where a walking foot
wants to be. Fixing that split cut the worst drawn-foot error from 19% of a leg to 1.6%.

The pole vector is **measured, not chosen** — it is the knee's own offset from the hip-to-foot chord,
so the analytic solve reproduces the authored bend. Same reasoning as `demos/bug-rig.js`.

### The body-plan zoo

Across all 151 species the mapper produces: 0 legs for 35, 2 for 59, 4 for 36, 6 for 11, 8 for 7 and
10 for 3, with 61 mapping without a single warning. The four reference quadrupeds and the bipeds
(Charizard, Snorlax, Machop) come out right; Voltorb, Diglett and Onix correctly come out with no legs
and a warning saying so. **The heuristics are expected to fail on odd body plans** — they say so in
`warnings` rather than returning a plausible wrong answer, and `opts.override` merges over the result
so an oddball can be hand-mapped without reimplementing anything.

## `stadium-rig-roles.js` — correcting the mapper by hand

The heuristics get some species wrong in ways `rig-audit.js` can name and nothing could previously act
on. This is the correction layer, and the demo's **Bone roles** panel is its editor: turn the skeleton
on, click a bone, give it a role.

The document is keyed **per bone**, because that is what a click produces:

```js
{ species: '028_sandslash', bones: { 12: { leg: '0L', role: 'foot' }, … }, attach: { '0L': 3 } }
```

`compileRoles(doc, { parent, names })` turns it into the per-leg specs `mapStadiumRig({ roles })` wants,
and returns everything wrong with it rather than dropping legs quietly. What it refuses:

| Refused | Why |
|---|---|
| Bones that do not form one unbroken parent chain | The easiest click mistake — one bone from the other limb. |
| A leg of one bone | The solver is two-bone: the mapper puts the knee joint on the sole and the lower segment comes out length 0. |
| A foot that is not at the distal end | "Below the ankle" has to mean something. |
| More than one knee | Picking one for you would hide the mistake. |
| The topmost bone as the knee | Leaves a zero-length upper segment. |
| An attach that is also one of the leg's own bones | The limb would hang off itself. |
| A row without a pair, or a bone in two legs | Named, not fixed — this is exactly the Sandslash fault. |

Roles are stored per species under `pcw:stadiumRoles` and applied whenever that species is spawned. A
document that compiles to no legs falls back to the mapper rather than leaving a creature unable to
stand. There is deliberately no merge between guessed and declared legs: a role document replaces the
detected set outright, because every merge rule for "the guess says four legs, you said two" is worse
than letting the instruction win.

**A foot may now be several bones.** `sole()` takes a list and averages the lowest fifth of the whole
group, so the contact point is the sole rather than the toe tip. Measured across all fourteen models,
declaring the last two bones the foot moves the contact point **2% to 29% of a leg span** — it is not a
rounding change. One leg is exempt and it is diagnostic: Pikachu's longer leg moves by 2×10⁻¹⁶, because
its last two bones carry 48 vertices between them that all sit at the same x and z. Those bones are a
collapsed point, not a foot, which is why that leg maps as six bones against its partner's four.

### What this does not fix yet

`stadium-walker.js` splits a leg into exactly two rigid groups, `bones.slice(0, kneeIndex)` and
`bones.slice(kneeIndex)`. Everything from the knee down — shank, ankle, foot, toes — is welded together
and rotated so the rest chord knee→foot lands on knee→solvedFoot. **There is no ankle**, so the sole's
angle to the ground is its rest angle plus however far the shank swung: forward in the stride it pitches
one way, behind it pitches the other. That is heel-and-toe walking by construction.

The role data is what an ankle needs — `footBones` and `ankleIndex` are carried on every leg and on the
walker, and are currently read by nothing but the skeleton overlay. Contact is also still a single point
per leg at the balance layer: `bodySupport` takes one `leg.end` each, so a quadruped balances on a
four-point polygon rather than four patches.

## `stadium-stance.js` — the pose a species rests in

Several of these models do not rest standing. **Growlithe sits**, so its feet start under its body, and
everything the walker derives is derived from that: leg span, the two-bone split, ride height, and the
stride envelope that sizes every step. The consequence was already in the numbers before anyone named the
cause — Growlithe's stride measured 18% of its leg span against Ponyta's 56%, and it was the slowest walker
of the fourteen. A sitting dog has almost no envelope to step in, so the gait obediently walks it slowly.

A stance is therefore **an input to `mapStadiumRig`, not a display setting**. The way to use one is to
apply it to the glTF and map the *result*:

```js
const { json, bin } = parseGLB(bytes);
const out = mapSpeciesFromLibrary(json, bin, species, library);   // stadium-species.js
// out.json is the POSED document, out.map describes it, out.warnings says what the pose cost
```

Measured on Growlithe with a single 0.15 rad turn of both hip bones — one slider, nothing else changed:

| | sitting (as shipped) | stood up |
|---|---|---|
| stride | 18.3% of a leg span | **32.1%** |
| body speed | 56% of commanded | **77%** |
| frames blocked from stepping | 96.4% | 89.3% |

### The document

Sparse local TRS overrides keyed by **bone name**, so it is a diff against the ROM: an unedited bone keeps
whatever the file authored, and re-extracting the models does not invalidate it. Same shape
`stadium-pose.js` uses and the shape a glTF animation channel targets.

```js
{ version: 1, species: '058_growlithe', bones: { bone13: { p, q, s }, … }, roles: {…}, ground: true }
```

**`roles` rides along with the pose, and that is the load-bearing part.** Leg detection runs on the
*posed* geometry — the three rules are all about where the feet ended up — so a pose that lifts a foot out
of the floor band deletes a leg the mapper had found. Measured across the fourteen: **Ponyta loses all four
legs to a 0.2 rad hip turn.** Pinning the detected legs as a role document first fixes it, and 13 of the 14
then keep every leg through the same pose. The exception is Sandslash, and it is diagnostic rather than a
bug: its four legs are two limbs used twice, so the shared bones cannot be assigned per-bone to both rows
and one row compiles down to a stub. `compileRoles` says so instead of dropping a leg quietly, and the
stance's pin button surfaces that warning. Pose and pinning are two halves of one decision about how a
species is rigged, so they are one record — two files would let them drift.

### Three things that were not obvious

- **An empty stance returns the input document untouched, and is not re-grounded.** These models are only
  approximately on y=0: Rattata's floor sits at −0.054, Ponyta's at +0.012. Grounding an unedited file
  would shift every absolute position by a few hundredths and quietly break parity with every measurement
  taken before stances existed. Grounding is a correction for an edit that moved the model.
- **Posing the topmost bone of a leg re-estimates the leg span, by 30.7% on Growlithe for a 0.4 rad turn.**
  Joints are estimated from where two bones' vertices meet, so rotating a bone about its pivot moves its
  geometry relative to the still-stationary parent and the hip joint is genuinely read somewhere else. The
  visible joint really has moved. It is large enough that the Rig stage shows the derived numbers live.
- **The mirror mirrors the DELTA FROM REST in world space, not the pose.** Flipping a local TRS in place is
  only correct when the two parent frames are exact mirrors of each other, which is an assumption about the
  rig rather than a fact about it. Mirroring a delta also keeps each leg's authored rest, which matters on
  the models whose two sides genuinely differ — measured, Rattata's sides are 4.8% of a leg span apart
  while Ponyta, Tauros and Growlithe are symmetric to within a rounding error.

### The stamp

`stanceStamp` is a content hash over the posed bones **and the pinned roles**, rounded to 1e-6 first.
Content-addressed rather than a timestamp or a counter, so re-authoring the identical pose does not orphan
the trials taken under it. Roles are in the hash because reassigning which bones are a leg changes the
creature as much as posing it does.

Every trial row and every setpoint records it. Re-posing a species moves what most of the knobs *mean* —
they are fractions of a stride envelope or a leg span — so rows from either side of a stance edit are
measurements of two different animals while looking entirely comparable. Applying a setpoint saved under a
different stance still applies the values and says which stance it came from.

### Who obeys it

The walker page is the **only editor**; everything else is a reader, and they all go through
`stadium-species.js` so they cannot disagree:

| Reader | What it does |
|---|---|
| `demos/stadium-walker-v2.html` | Edits and applies. Writes `stadium-saves/stadium-stances.json`. |
| `test-stadium-rig.mjs` | Walks every stanced species 10 s and fails if it no longer stands up. |
| `sweep-gait.mjs` | Measures the stanced creature, and prints which species it is obeying. |
| `audit-stadium-rig.mjs` | Audits the posed rig, since that is the one that walks. |

A stance that stops a creature standing is a **test failure**, which is the deliberate trade: fixing a
stance can break a test, and that is preferable to it surfacing later as a limp nobody can explain.

## `demos/stadium-walker-v2.html` — the same tools, in the order they depend on each other

v1 puts its sections in the order they were built: Stage, Model, Search, Gait, Legs, Ground, View, Bone
roles, Poses. Search and Gait sit **above** the rig work they depend on, and Bone roles — which has to come
first, because every number downstream is measured off the rig it fixes — is eighth. The page invites you
to tune a creature whose mapping is wrong and whose idle clip is fighting the gait.

v2 is the same code with four stages over it, each showing only its own controls:

| | Stage | What it decides | Gate |
|---|---|---|---|
| 1 | **Rig** | Which bones are legs, and the neutral stance | no bone in two legs; stance authored; legs pinned |
| 2 | **Stand** | Whether it holds itself up, walking off | ride height held; stride envelope worth stepping in; clip off |
| 3 | **Walk** | The gait | not dragging; not tapping |
| 4 | **Trial** | Search, compare, keep | more than one creature to compare |

Nothing is locked — a gate is a readout saying whether the stage's job is done, not a door. Sections carry
`data-stage` and the controller shows the matching ones; sliders keep the same declarative `addSlider`
specs and are simply mounted somewhere else, so the two pages cannot drift on what a knob does. The coach
panel is hidden outside Walk and Trial, since it is about a walk in progress.

Three controls moved on the same reasoning. `standExtension` is not one knob among twenty — it settles the
ride height and every stride number falls out of it, so it heads the Stand stage. `supportPolygonFloor`
moved out of Gait, because whether enough feet stay down to make a polygon is a balance question. And the
idle-clip toggle sits in Stand next to a note about hip disturbance, because that is where the decision is.

### Movement is one control, and idle is one of its settings

v1 had a **walking** checkbox in one section and a **base gait** dropdown in another, so standing a creature
still meant finding a checkbox that did not look like it belonged to the same decision. They are now a
single **movement** select: `idle`, `walk`, `gallop`.

The capability was always there — `walker.update(dt, { walk: false })` skips `steer()` and
`scheduleSteps()`, so the body holds its heading and takes no steps while the legs still solve and settle
under it. That is the state to judge a stance and a ride height in, and it is what the Stand stage now
switches to on entry.

Two details are load-bearing:

- **Idle is not a gait, so the last locomotive one is remembered.** `GAITS.walk` and `GAITS.gallop` are the
  tables every derived number comes from; without a fallback the readouts would blank the moment you stood
  the creature up to look at it. Trials record `gaitKey()`, never `idle`.
- **Nothing is measured while idle.** A standing creature trivially does not drag, so the monitor stops
  sampling and the Walk gate says it is idle rather than reporting a clean verdict on a creature that is
  not moving. A green gate earned by standing still is worse than no gate.

Pause is deliberately still separate: it freezes time, which is a different question from what the creature
is doing. The Movement section carries no `data-stage` and so shows in every stage — it was filed under
`stand walk trial` first, and since the page opens on the rig stage, first load had no movement control on
screen at all.

### All 151 are selectable

v1 offered fourteen — the set the rig work was tuned against — from a list written into the page, which
made the other 137 look unavailable even though every one of them is checked into `models/stadium/`. v2
builds the dropdown from that directory's own `manifest.json` in three groups: the fourteen, the rest that
map with legs, and **the 35 the auto-mapper finds no legs on**.

Those 35 are named in `STADIUM_NO_LEG_SPECIES` (`stadium-reference-species.js`), and `test-stadium-rig.mjs`
re-derives the list across all 151 and fails if it drifts — so the page cannot quietly mislabel a species
after a mapper change. Some genuinely have no legs to find (Voltorb, Gastly, Onix, the snakes); the rest
are heuristic misses. Picking one now explains that instead of throwing, and a saved selection that will
not spawn falls back rather than leaving every panel reading an empty stage.

**The gap**: the Bone roles panel is what would fix a heuristic miss, and it reads the *selected creature*,
which a legless species never becomes. Hand-mapping one therefore is not possible yet. Making the rig stage
operate on a species rather than on a spawned creature is the fix, and 36 call sites currently assume a
walker exists.

### The stance editor

Bone picking is the one the skeleton view already had. What is new is six sliders — three angles and three
shifts — applied on top of the bone's **authored rest**, so zero always means untouched and a slider reads
as "how far from where the ROM left it" rather than accumulating drift. Translation is a fraction of the
model's own height, because these models differ threefold in size.

Dragging a slider only moves the **drawn** pose; the map still describes the last applied stance, and the
panel says so. **Apply and respawn** is what re-derives the rig, and it exists because doing that on every
slider frame would rebuild the walker forty times a second. A clip scrubber can take any frame of any ROM
clip as the starting stance — usually faster than dialling a standing pose out of a sitting one — and it
steps to the nearest key rather than interpolating, because a key is a pose somebody actually drew.

Stance sliders are scoped `stance`, which keeps them out of `knobSpecs` and therefore out of the gait
search: a search free to re-pose the model could make its own numbers look better by changing the creature
underneath them. They are also deliberately not saved into panel prefs, since they are relative to whichever
bone is selected and a restored value would show an angle the stance does not contain.

## `stadium-pose.js` — keyframing, not just walking

The retarget is not really about walking. `placeGroup` takes a bone group and two segments — where it
rests and where it should go — and moves it rigidly; it has no idea a gait exists. `solveTwoBone` lets a
pose be authored as a *foot position* rather than as joint rotations, which on this rig is the difference
between feasible and not, because a bone's origin sits inside the body rather than at its visible joint.
Add the role map for names and you have the pieces of a pose tool.

A pose is **local position, rotation and scale per bone name** — deliberately the shape a glTF animation
channel targets, so a timeline and an exporter can be built on it later without reshaping anything:

```js
{ name: 'crouch', species: '019_rattata', bones: { bone19: { p: [...], q: [...], s: [...] }, … } }
```

Names rather than node indices, because `SkeletonUtils.clone` preserves names — so a pose captured on one
Rattata applies to the next one spawned, which a test asserts.

**The capture set is pivots and the `_scale` leaves.** Measured on Rattata's own clips: 104 translation
and 192 rotation channels target pivot bones, and 6 scale channels target the childless `_scale` leaves
the skin binds to. `map.names` holds pivots only, so a pose built from it would silently drop every scale
the file carries. `poseBones` unions the skin joints in.

`blendPoses(a, b, t)` slerps rotations and lerps position and scale. Two details are load-bearing and
both are tested. Slerp takes the short way round — q and −q are the same orientation, and without the
sign flip a blend between two nearly-equal poses travels 350° to get 10°, swinging a limb through the
body. And a bone present in only one of the two poses holds its value at full strength rather than
blending toward nothing, so a half-captured pose reads as "these bones are unmanaged" rather than
collapsing them onto the origin.

`poseDistance` divides the quaternion dot by both magnitudes rather than assuming unit length. Repeated
`Object3D.rotateY` drifts about a part in ten million, and `acos` near 1 turns that into 0.06° — a pose
measured that far from an exact copy of itself. Found by the cross-rig test, not by inspection.

### The scrubber in the demo

**Poses** panel: capture the selected creature as a named pose, capture the authored rest pose from the
glTF nodes, pick two, and blend between them. Held poses are written **last** in the frame, after the
walker and after the mixer, so they win over both without either knowing the feature exists. The body
keeps simulating underneath — position is the container's transform and a pose is bone locals — so a
creature will wander around holding a pose, which is how you inspect one from every angle. Poses are
saved per species under `pcw:stadiumPoses`, with export and import.

`blendSequence` crosses an ordered list of poses with one dial. It is not a timeline — the keys are
evenly spaced and there is no timing — but it is the traversal a timeline needs.

Every return path owes the caller a pose that shares nothing with its inputs, which is what `copyPose` is
for. The one-sided blends and the single-key sequence returned `{ ...input, name }` until 2026-08-16 — a
spread copies the wrapper and aliases `bones`, so holding a single pose (slot A filled, slot B empty is
the ordinary case) handed the scene graph the saved pose's own arrays. Nothing mutates a held pose today,
so it never bit; the test asserting non-aliasing only exercised the two-pose path.

### What a real keyframe system still needs

- **A timeline**: per-key timing, easing, looping. Ordinary work.
- **An exporter**: `stadium-glb.js` parses and never writes, and the only glTF writer in the repo is
  `glb-shrink-server/`, a Node service. Producing a `.glb` clip means adding a writer or posting poses to
  that service.
- **IK authoring**: poses are captured FK today. Authoring is far easier as foot targets solved at
  playback, then baked to FK on export — the solver already exists and the retarget already emits locals
  every frame, so the bake is nearly free.

## `foot-sdf.js` — a foot as a surface, not a point

Everything above treats a foot as one point: `sole()` produces it, `leg.end` carries it, and
`bodySupport` hulls one per leg. Two feet then hull to a **line**, which has no interior, so a
two-legged creature has no support polygon at all — which is why `uprightSupport` exists, and what that
knob is papering over. This module is the physical answer instead of the assumption.

`fitRoundBox(points, count, { radius })` fits an oriented **round box** by principal axes. A round box
rather than an ellipsoid on measurement: 32% of the bones in these models are flat cards with one
extent of exactly zero, an ellipsoid fitted to one has no volume, and a box with a rounding radius is
exactly a card. The radius is subtracted from the extents rather than added, so the fitted surface
still passes through the vertices it was measured from. `sdRoundBox(box, x, y, z)` is the exact signed
distance.

`buildFootProxy(clouds, opts)` returns the patch the walker stands on: the 2-D hull of the vertices
within a **band** of the lowest one, as offsets from the sole. Four things there are load-bearing:

- **A band, not a fraction.** `sole()` averages the lowest fifth, which on a 12-vertex foot is two
  points that hull to a line. Every quadruped failed that way; the band fixed 39 of 50 feet.
- **The box is the fallback.** A foot built from a *vertical* card hulls to a line whatever the band
  does, and the fitted box's rounding radius is the thickness the card does not carry. That rescues
  Sandslash and Slowpoke, taking the total to 49 of 50. The one refusal is a Pikachu foot bone whose
  48 vertices sit at a single point, which is the same degeneracy the roles tests pin.
- **`soleCentre` is supplied by the caller.** The band and `sole()` choose different vertices, so their
  centroids differ; the walker anchors the patch at the foothold `sole()` produced, so a patch centred
  on anything else hangs off the side of the foot.
- **`maxRadius` bounds it against the leg.** The auto-mapper's "foot" is only ever the last bone in the
  chain, and on a squat model that bone owns more than a foot — Sandshrew's patch measured **1.12× its
  entire leg span**. It is scaled down rather than clipped, so the shape survives, and `capped` is set
  so the panel can say so. Two models are capped at 0.75 of a leg.

### What it buys, measured

`footContact: 'patch'` feeds those points to `bodySupport` instead of one `leg.end`. Six seeds each,
12 s of walking, against `footContact: 'point'`:

| | frames with the centre of mass inside its support |
|---|---|
| Charizard, Machop, Sandshrew (2 legs) | **0% → 42–46%** |
| Tauros | 59% → 100% |
| Slowpoke | 67% → 80% |
| Sandslash | 21% → 36% |
| Seel | 66% → 66%, unchanged |

Sliding and reach-clamping are **identical** in both modes on every model, and step rate is unchanged
except Growlithe (1.44 → 1.77/s). The patch is anchored at the gait's own foothold, so it changes the
size of the support polygon and never where it sits — which is deliberate, and keeps this clear of the
foot-drag question the stray gate's `accept` mode already lost.

`bodySupport` now reports `groundedCount` (legs) and `contactCount` (polygon points) separately. They
were one number, clamped by the pooled buffer, so a 24-legged creature standing on all of them read a
grounded fraction of 16/24.

## `demos/sdf-pikachu.html` — the SDF spike

A throwaway test build, not a subsystem: can a Stadium model be drawn the way `demos/sdf-bug-v2.html`
draws its bug — raymarched signed distance field, no triangles — and does it still read as the creature?

Rigid skinning is what makes it possible. Every vertex belongs to exactly one bone at full weight, so the
**skin** falls apart into rigid chunks. The real mesh renders beside the field from the same bytes and the
same camera, because looking at it is the only way to answer the question. `sdf-pikachu-field.js` holds both
bakes and the TSL so `test-sdf-pikachu.mjs` and `test-sdf-mesh-bake.mjs` can compile the shader and check the
numbers in Node; `_check_sdf-pikachu.html.mjs` covers the page shell.

There are two ways to turn a chunk into a field, and the **field from** dropdown switches between them.

### Fitted boxes — the cheap tier

One oriented round box per chunk from `fitRoundBox`, unioned. Measured:

- **They are loose.** A box bounds the vertices it was fitted to, so its corners stand proud of the model:
  worst is Nidorino, 0.164 of its own height below the floor and 0.139 above its head.
- **The skip sphere has to bound the box, not the vertices.** The march skips a bone when
  `|p − centre| − r` cannot beat the running minimum, which is only valid if the sphere contains the box —
  and a box corner reaches past the furthest vertex. Sizing `r` from the vertices, which is the obvious
  move, carves holes in the creature.
- **Cost is not the problem it looks like.** With that sphere reject, a point inside one of these models
  overlaps a mean of 0.3–1.7 bone volumes across the fourteen; p95 is 2–6 and the worst case is 9.
- **The textures survive.** A bone owns a mean of 6.5 triangles, worst 52, and the hit point tells you
  which bone — so a nearest-triangle UV lookup at the hit is about seven tests. The page takes the cheaper
  route of one averaged colour per bone.

### Baked volume — the mesh itself (`demos/sdf-mesh-bake.js`)

No shape vocabulary in between: each chunk becomes a `TILE_RES`³ = 24³ cube of signed distances, every voxel
holding the measured distance to that chunk's nearest triangle. All 96 cubes tile into one `Data3DTexture`
(`RedFormat` + `HalfFloatType` → `r16float`, which WebGPU filters natively), **2.53 MB per model**, baked in
**0.6–0.8 s**, alongside a second RGBA8 volume of the same shape holding colour. The tile lives in the box's
frame, so the boxes are still built either way.

**How close it gets.** Marching both fields from the same 120 rays and measuring each hit against the real
triangles — the measurement the spike exists for:

| species | boxes, median off the skin | volume, median | volume 95th |
|---|---|---|---|
| Pikachu | 4.05% of body height | **0.16%** | 0.64% |
| Rattata | 6.75% | **0.11%** | 0.58% |
| Tauros | 5.51% | **0.13%** | 0.65% |
| Charizard | 6.70% | **0.19%** | 0.55% |

One voxel on a typical tile is about 1.04% of body height, so trilinear interpolation is reconstructing the
surface to roughly a sixth of a voxel. The tier below is off by thirty to fifty times as much.

**Those figures are the settings the page ships, and it did not always ship them.** The first version opened
at a joint blend of 0.05 and a skin thickness of 0.006, which measure 1.92% — fifteen times its own best —
and it read as a blobby mess. What each knob costs on Pikachu:

| joint blend | thickness 0 | thickness 0.006 |
|---|---|---|
| 0 | **0.13%** | 0.65% |
| 0.006 | 0.22% | 0.78% |
| 0.02 | 0.55% | 1.13% |
| 0.05 | 1.31% | 1.92% |
| 0.1 | 3.95% | 6.19% |

The blend is now zero for the volume and 0.05 only for the boxes, which is where it belongs: it exists to
close the seam a **rotated** bone tears open, boxes leave real gaps at every joint, and the volume's chunks
already overlap because a seam triangle is given to both bones. Nothing on this page rotates a bone.

**Grid resolution is not the limit, and raising it buys nothing.** Measured against the *analytic* field —
exact distance to the triangles, no grid at all — 16³/24³/32³/48³ give surface errors of 0.21/0.07/0.12/0.10%
against the analytic 0.08%. 24³ is already at the floor. The normal error looks alarming at 10–16° until you
notice the analytic field scores *worse* at 29.3°: the metric compares an SDF gradient to a flat facet
normal, and near an edge a distance field's gradient legitimately swings between the two faces. It measures
nothing.

### Colour

One averaged colour per bone was the other half of "it doesn't look like Pikachu" — a bone owning the black
ear tip and the yellow ear averages to an olive ear with no tip. A per-pixel triangle search at the hit is
not the answer either: the worst bone across the fourteen owns **176** triangles, not the 6.5 mean quoted
above.

Colour is baked into a **second volume** on the same grid, sampled with the same coordinate: for each voxel,
the nearest triangle's barycentric UV (`baryOfClosest`) read through the ROM image, stored as linear RGBA8.
5.06 MB on top of the distance volume, and one extra texture fetch — at the hit only. `map` returns distance
alone and `shade` returns distance and colour; splitting them keeps the colour volume out of all 110 march
steps to be used by one. Measured: 9 of 10 Pikachu bones carry more than one colour near their surface.

These are N64 models, so there is a lot of texture and none of it is big: 10–194 images per model, mostly
32×32. UVs run to ±5.86, so any lookup needs `fract` first.

Four things had to be right, and three of them were wrong on the first authoring:

- **Sign comes from the whole model, never from one chunk.** A chunk of skin is an *open* surface with a
  boundary at the seam, where "inside" means nothing. `insideField` fills a `SIGN_RES`³ = 128³ grid once for
  the whole mesh and every tile reads its sign from that.
- **Count winding, not crossings.** These models are assembled from closed parts that interpenetrate — an
  arm pushed into a shoulder. A ray through the overlap crosses four surfaces, so parity calls it *outside*
  and the bake punches a hole exactly where two parts meet. Winding counts it twice and stays non-zero.
  Sandshrew was the tell: its parity fill disagreed with its enclosed volume by 65%.
- **A seam triangle belongs to both bones, so the tile is sized from the triangles and not from the box.**
  The shader answers "past the tile" analytically as `distance to the tile + pad` and never samples out
  there, which is only a lower bound if the tile really holds all of its own triangles. `tileExtent` measures
  them; `box.half + pad` would have been wrong wherever a seam pokes through a face.
- **Thin geometry has no interior to find.** A Charizard wing is thinner than one cell of the sign grid, so
  nothing under it ever reads solid and its field never quite reaches zero. Measured at four resolutions the
  share of skin with an interior climbs 56 → 59 → 66 → 73%, which is a thinness limit rather than a wrong
  rule. The **skin thickness** slider (`u.thicken`, default 0.006, ceiling `MAX_THICKEN`) pushes the whole
  surface outward to cover it, and the skip sphere allows for the ceiling.

Not tested, and the other reason the spike exists: whether the smooth union hides the seams rigid skinning
tears open at every joint. The **joint blend** slider is that question.

## `stadium-walker.js` — walking it

`createStadiumWalker({ THREE, scene, map, terrainHeight, worldHeight, … })` returns
`{ object, scene, body, legs, state, update, fixedStep, applyPose, footContactError, placeAt, … }`. The gait,
foot scan, support polygon and analytic two-bone solve are all `creature-locomotion.js`; nothing about
the walk cycle is new here. Move a creature with `walker.placeAt(x, z, yaw)`, never by writing
`body.pos` — the feet are seeded under the body, and a body moved on its own leaves them where they
were, which is the overreach the gait tuning exists to prevent, self-inflicted at spawn.

**The retarget writes world matrices, not rotations.** Because a bone's origin is not its joint
(fact 3), setting a rotation swings the segment about a point inside the body and the leg comes apart
at the seams. Instead each leg segment's desired world matrix is computed and the bone's local
transform set to whatever puts its rest geometry there. Translation is written as well as rotation,
which is in-domain: the ROM's own clips animate translation, rotation and scale on these same bones.
The whole retarget is expressed **relative to the attach bone**, so a clip playing on the spine
carries the legs with it.

Only leg bones are driven. Spine, head, tail and ears are left free so a ROM clip can play on them at
the same time — the demo layers the idle by dropping every track that targets a leg bone.

### What had to change for these bodies, and why

`GAITS.walk` is authored for the sim's own creature, which is a metre tall with well-bent legs. Five
things did not transfer, each found by measurement:

| Symptom | Cause | Fix |
|---|---|---|
| Body floats, feet trail below it | The height spring damps against a velocity that already contains this step's gravity impulse, biasing the resting height up by `KD·GRAV·h/KP` = 44 mm regardless of size. 4% on a metre-tall body; a third of a Rattata's ride height. | Spring reads velocity **before** gravity is applied. |
| Footholds outside the leg's reach | The stride is sized as a fraction of leg length, but Rattata stands with its forelegs 97% extended and has no annulus to work in. | `heightScale` settles the body until the tightest leg is at 90% extension; `strideEnvelope` sizes the comfort box and step triggers from the resulting geometry. |
| Body outruns its own feet | Top speed came from Froude scaling alone; the body travelled 27 mm during a 20 mm step. | Speed capped at `0.8 · 2 · envelope / cycleTime`. |
| Foot lands with no room to give back | `lookAhead` put the foothold 8 mm ahead of rest on a leg with 20 mm to work with. | Lead sized to the envelope. |
| Creature crawls at a third of its speed | `comfort` clamped to the envelope left some leg permanently `uncomfortable`, and that flag cuts speed to 28% for the whole body. | `comfort` left at its scaled value; hard bounds do the work instead. |

Two more mechanisms exist because a planted foot keeps drifting after it lands: `flagReachStress`
turns the reach limit into a step trigger, and a leg genuinely past full stretch is **forced to lift**
even out of turn — but never below three grounded feet, because two grounded feet are a line, the
support polygon collapses, and the body drops onto its hard floor and takes seconds to climb out.

And two changes to the support normal itself, both of which the shipped species forced:

- **A normal tilted past 45° gets its sideways part clamped, not the whole force discarded.** The sim
  throws the force away, which is survivable on four legs (the normal only tilts that far in a
  transient) and fatal on two.
- **`uprightSupport`** is how much the creature is assumed to hold itself up when the support polygon is
  degenerate or its mass has left it. 0 is the sim's own behaviour — topple. 1 assumes it can always
  stand, which is the only way two legs stand at all: Charizard, Pikachu and Sandshrew otherwise sat on
  their hard floor 100% of the time, walking on their bellies. It defaults to 1 on two legs and 0.5
  above that, because Seel and Sandslash, both splay-limbed, otherwise walk at 64% and 79% of their own
  ride height. **This one is an assumption, not a derivation** — it stands in for ankle torque, which
  nothing here models — which is why it is a slider in the demo rather than a constant.

## Tuning

Every knob lives on `walker.tuning`, and `walker.retune(patch)` re-derives the gait from them **in
place**: same leg objects, same bone lengths, creature never stops walking. `terrainHeight` and the
base gait go through it too, so the ground can be swapped mid-stride.

```js
walker.retune({ standExtension: 0.95, speedScale: 1.4, terrainHeight: hills });
```

| Knob | What it does |
|---|---|
| `standExtension` | How straight the tightest leg may be standing still. Sets the ride height. |
| `maxExtension` | How straight a leg may get while reaching. |
| `swingLimit`, `placeMargin` | Fore/aft swing allowed, and how far inside it a foothold is placed. |
| `reachMargin`, `reachStress` | How far inside its reach a foothold lands, and when a planted foot asks to step. **`reachMargin` must stay below `reachStress`** — see the foot-drag section. |
| `restepFraction` | How far a foot must be from its target before the leg may step, in stride envelopes. The gait's main hysteresis. |
| `supportPushLimit` | How far past top speed the balance model may push the body sideways before that push fades. |
| `uprightSupport` | The upright assumption above. `footContact: patch` is the physical alternative to it. |
| `footContact`, `footPatchScale` | `point` or `patch`, and a multiplier on the measured patch. See `foot-sdf.js` above. |
| `footGround`, `roamRadius`, `base` | Foot clearance, wander radius, and the base gait table. |
| `speedScale`, `stepDurationScale`, `stepLiftScale`, `strideScale` | Deliberate overrides on top of the derived values. `speedScale` past 1 **breaks** the stride relationship on purpose, so that what breaks is visible. |
| `concurrentScale`, `cooldownScale` | Scale how much of the body may be airborne at once, and the turn-taking cooldowns. Mostly for sweeps: they exist so each source of hysteresis can be switched off independently. |
| `minStepSeconds`, `strideNumberMax` | Two floors under the step duration — one perceptual and un-scaled, one from the leg's own pendulum period. Both 0 restores the raw Froude scaling, which puts a gallop step at under three rendered frames. |
| `supportPolygonFloor` | How many feet must stay down. 3, because two are a line. Applied after `concurrentScale`, so it is the last word; 0 switches it off. |
| `strayLimit`, `strayMode`, `strayRetries` | The stray gate — see below. Default `0.05` and `off`, which is exactly what the walker did before the gate existed. |

The demo puts all of them on sliders next to a live readout of what they derive, because the chain
`standExtension → strideEnvelope → maxSpeed → how far a planted foot drifts` is not readable from
source. You drag one end and watch the other move.

### Measured behaviour

Over four models, eight seeds and ~10,000 samples of the **drawn** sole against the gait's foot:
median and 95th percentile both 0.00% of a leg span, fewer than 0.3% of samples over 5%, and the
outliers confined to the straightest-legged models. Planted feet sit exactly on the ground (0.00 mm
error). The body never drops below 88% of its ride height.

Across all fourteen shipped species walking for 20 s on flat ground: ride height 96% of nominal,
clamped planted frames 0.1% median and 2.0% worst, median stride 33% of a leg span, body speed 82% of
what the gait commands. Two species trip the drag detector; see the section below for both the numbers
and what is still wrong with them.

## Foot tapping and foot drag — `gait-diagnostics.js`, `sweep-gait.mjs`

Two ways a procedural walk goes wrong. **Tapping** is a leg that steps without getting anywhere: it
lands, immediately wants to move again, and lifts. **Dragging** is a planted foot whose *rendered*
position slides along the ground while the gait believes it is standing still. Neither is an IK
failure — the two-bone solver does exactly what it is asked, and the asking is what is wrong.

`gait-diagnostics.js` is a pure module (no THREE, no DOM) that takes `walker.diagnosticFrame()` and
scores both. A tap needs a stance shorter than half a step duration **and** a step covering less than
5% of that leg's own span; the halves are also counted separately, so "no tapping" can be told apart
from "detector never fires". Dragging is the rendered foot's slide as a fraction of how far the body
moved over the same interval, integrated over each whole stance, plus the fraction of planted frames
where the solver had to clamp an unreachable target.

Everything is normalised against the creature, not in millimetres — these models differ threefold in
size. One normalisation choice mattered: **stride travel is measured against leg span, not against
`strideEnvelope`.** The envelope is a single number taken as the minimum over the legs, so on a rig
whose legs differ it is the *tightest* leg's envelope and every other leg's stride reads as several
hundred percent of it. Envelope-normalised strides ran 116% to 616% across the shipped models, which
put every real step so far above the threshold that the tap detector could not fire at all.

### What the sweep found

`node sweep-gait.mjs` walks all fourteen species headless and scores them; `baseline`, `stand`,
`scale`, `provoke`, `watch`, `predict`, `snap`, `grid <rowKnob> <colKnob>` and any knob name are the
modes. `MEASURE`, `ONLY`, `TUNE` and `GAIT` are environment overrides. Three real defects
came out of it, all of which had been shipping:

1. **The re-step guard was a flat 0.1 m.** `canWalkLegMove` refuses a step whose target is within
   `restepEpsilon` of the foot, and falls back to a literal 0.1 m when the gait does not set one — a
   number sized for a creature with a 0.58 m femur. The walker never set it. Rattata's entire stride
   envelope is 20.5 mm, so the guard was five envelopes wide and no leg could step until the body had
   dragged it 100 mm. The tell was that eight of fourteen models had a median step travel of 100–104 mm
   *whatever their size*, which is the guard's number and not a property of any animal. It is now
   `strideEnvelope × restepFraction`.
2. **`reachMargin` (0.92) sat above `reachStress` (0.90).** A foothold could be placed at 92% of the
   reach limit and be flagged overextended at 90% on the next frame, so every fresh foothold was born
   already asking to step. `reachMargin` is now 0.70.
3. **The support normal was an unbounded motor.** Its sideways component is a lean, but nothing capped
   it: the magnitude is clamped at 4g, up to 4g/√2 of that can point sideways, and against `H_DRAG`
   that settles near 24 m/s on creatures whose gait tops out around 0.1 m/s. Ivysaur and Seel ran at
   189% and 208% of their own top speed and clamped 58–65% of planted frames, because no arrangement of
   the feet keeps up with a body going twice as fast as its legs can cycle.

The failure boundary itself: dragging holds at 11–13 species out of 14 for any `restepFraction` below
0.7 and drops to 4 at 1.2, where it stays. Below one envelope the foot is re-placed before the body has
walked it back through the envelope, so it lives at the **front** edge — the part of the stride where
the leg is longest — and rides its reach limit the whole time.

Against the **shipped** defaults, measured on the same 20 s flat-ground run:

| | shipped | now |
|---|---|---|
| Species dragging | 4 of 14 | 2 of 14 |
| Worst species' clamped planted frames | 34.8% (Seel) | 2.0% (Ponyta) |
| Median stance skate | 9.2% | 4.4% |
| Seel's ride height | 70% | 94% |

Be careful reading intermediate numbers from the sweep against these. Scaling the re-step guard to the
creature but leaving it *small* is worse than the un-scaled 0.1 m it replaced — 12 of 14 species drag at
`restepFraction` 0.15, and half of all planted frames are past full extension. That regression is how the
boundary was found, and it is why `restepFraction` defaults to 1.2 rather than to something small and
tidy. The flat 0.1 m was accidentally near the right size for these particular models; it would not be for
a model half the size, which is the actual bug.

### The step that is over before it can be drawn

The third defect, found from a screenshot of the foot trail rather than from a number: at a gallop the
trail is a sharp high-frequency zigzag instead of a series of arcs. It looks like a leg snapping back to
its foothold at an impossible speed, and the sharper and faster it is, the more it reads as tapping.

It is not a scheduling failure. `advanceLeg` lerps the foot from `stepStart` to `stepEnd` and adds a
half-sine lift, and **the whole step was lasting three to seven rendered frames** — 3.7 to 7.1 at a walk
and 2.8 to 5.3 at a gallop. Three frames of an eased arc is two interior samples, so what gets drawn is a
triangular spike. The motion is correct and simply finishes before it can be seen.

Two things were checked first and were *not* the cause. Legs are not over-stepping: body travel per step
divided by two stride envelopes — every step's worth of ground — comes out at 0.63 to 1.20, so the steps
are earned. And the drawn foot almost never reverses direction (0.0–0.5 reversals per second), so the
zigzag is the vertical lift arc seen side-on, not the foot hunting back and forth.

Two floors now sit under `stepDuration`, and both do work:

- **`strideNumberMax`** (0.5) is the biomechanical one. A leg is a pendulum, so its natural rate goes as
  the square root of length over gravity, and stride frequency × √(span/g) is what makes rates comparable
  across models differing threefold in size. Real animals sit at 0.2–0.4 walking and about 0.6 at a
  gallop; measured here, walk was 0.25–0.54 and **gallop 0.68–1.00**, off the top of the biological range.
  It is computed from the **longest** leg, not the shortest: reach is limited by the short leg, because a
  foothold it cannot make is useless, but timing is limited by the long one, because a longer pendulum
  swings slower. Sizing it off the short leg let Growlithe, whose legs differ 44% in span, cycle at 0.60.
- **`minStepSeconds`** (0.10) is the perceptual one, and it deliberately does not scale, because the eye
  does not. Below about a tenth of a second a limb reads as having jumped however small the animal is. It
  is also the frame-rate floor in disguise: 0.10 s is six frames at 60 Hz.

Steps now last 6.0–7.6 frames at a walk and 6.4–12.7 at a gallop, and stride numbers are 0.19–0.32 and
0.37–0.46. The cooldowns are stretched by the same factor the floor applied, since they hold a fixed
ratio to the step duration and that ratio *is* the turn-taking.

**This was also what the two biped skaters were doing.** Pikachu and Charizard slid on ~13% of their
planted frames before; with the floors in they are at 1.5% and 4.2%, and the whole set measures 0 of 14
dragging with a median stance skate of 0.0%. Charizard's peak swing speed at a gallop went from 28.8 leg
spans per second — 9.2× its own body speed — to 11.0. `gaitHeadroom`'s recall against measured drag rose
from 83% to 95% for the same reason: the misses *were* this bug, which the arithmetic could not see
because nothing in the tuning was wrong.

The cost is real and worth stating: everything walks about 25% slower, because it was previously covering
ground by cycling its legs faster than a leg that size can cycle. Growlithe is the slowest at 0.23 leg
spans per second. Speed has to be bought back with stride envelope — `standExtension` — not step rate.

### Gallop was never measured, and it was badly broken

Every number in the drag section had been taken under `walk`; `GAIT=gallop node sweep-gait.mjs` now runs
the whole instrument on the other gait. The first run: **14 of 14 species dragging, 9 of 14 carrying
themselves below 85% of their own ride height**, half of all planted frames past full reach, bodies
travelling at 147% of their commanded speed, and — the near miss — **half of all steps having a stance
shorter than half a step duration**, which is one half of the tap detector firing at 50%.

The collapse had a single cause. `GAITS.gallop` sets `maxConcurrentFraction` to 0.5, which on a quadruped
means two feet airborne at once, leaving two down — and two grounded feet are a **line**. The support
polygon has no interior, `bodySupport` tilts the normal instead of holding the body up, and the creature
drops through it. This is the same collapse already documented for bipeds, which is why they get
`uprightSupport` instead.

`supportPolygonFloor` (3) caps concurrency so enough feet stay down to make a polygon. Six legs are
unaffected — three down out of six is still a triangle, so Paras keeps its alternating tripod — and
bipeds are exempt because they can never satisfy it. Set it to 0 to reach the broken regimes on purpose.
Applied after `concurrentScale` so it has the last word.

Result at a gallop: species below ride height 9 → 1, median height 81% → 98%, median stance 0.1 → 1.2
step durations, short stances 50% → 0%, median stance skate 19.3% → 5.3%. **Gallop still drags 14 of 14**
with 46% of planted frames past full reach, so it is fixed as a *collapse* and not as a gait. It needs
the same investigation walk got.

One correction to the section below. Under gallop with `uprightSupport` at 1.0, before the concurrency
cap went in, the sweep reported tapping on one species — the only instance ever measured. It disappears
once the cap is in, so it was a property of the collapsed regime rather than a counterexample, but the
claim that tapping is unreachable holds only for creatures that are actually standing up.

### Tapping does not occur, and that is structural

Zero tapping in every one of about seventy configurations, including savage terrain with the
concurrency cap, the cooldowns and the re-step guard all switched off. The reason is in `advanceLeg`:
it copies `stepEnd` into `leg.end` on landing, and the trigger measures distance **to the target**, so
a foot that has just landed is at zero error by construction. The trigger cannot re-fire until the
target itself moves. Both halves of the detector do fire independently on real data — short stances on
up to 25% of steps, short travels on up to 12% on rough ground — they simply never coincide, because
they are anti-correlated: a leg in a fast cycle still covers ground, and a leg re-placed in the same
spot has been standing a long time.

If tapping ever does appear, the thing to suspect is an unstable foot **target** rather than a loose
scheduler — rough ground at the scan's own scale, or a rapidly flipping travel direction.

### The stray gate — checking that a planted foot is where the gait thinks it is

Until this existed, **nothing in the walker checked a foot against where it was aimed.** `advanceLeg`
ran the step arc to `t = 1` and the foot was planted wherever the solver had put it. The distance
between the two feet — `leg.end`, which the gait believes in, and the drawn sole that comes out of
`solveTwoBone` — was measured and reported as `strayFraction`, and it gated nothing.

`strayLimit` is now that threshold, and it is the **same number** as `GAIT_LIMITS.strayFraction`, so
what the sim acts on and what the panel counts can never drift apart. A test asserts the two defaults
are equal.

**It runs on planted frames, not on landings, and that is measured rather than chosen.** The obvious
reading of "did this step land correctly" is to check the touchdown frame. Built that way, it caught
**zero** strays — not at the defaults, and not in five regimes broken far enough that drawn feet were
off-target on 97% of planted frames. A foothold cannot be off-target at touchdown: `clampTargetToLimits`
pulls it inside the leg's reach before the step begins, so it lands reachable by construction. The whole
error accumulates afterwards, while the body walks over a foot that is standing still.

`strayMode` decides what happens to a foot that has strayed:

| Mode | What it does |
|---|---|
| `off` | Counts only. Identical to the walker's behaviour before the gate existed, and the default. |
| `slow` | Marks the leg uncomfortable, which throttles the body through `uncomfortableSpeedMultiplier`. |
| `restep` | Lifts the foot again immediately, falling through to `accept` after `strayRetries` misses. |
| `accept` | Moves `leg.end` onto the drawn sole: the gait adopts the foot a viewer can actually see. |

**Measured across four species, 12 s each.** At the shipped defaults the gate never fires — 0 strayed
frames on Rattata, Ponyta and Pikachu, 7 on Seel — so the mode makes no difference to a healthy
creature. Break the gait with `speedScale: 2` and the modes separate:

| Species, `speedScale: 2` | `off` | `slow` | `restep` | `accept` |
|---|---|---|---|---|
| Pikachu — skating / past reach | 48% / 44% | **30% / 36%** | 96% / 59% | 96% / 59% |
| Ponyta — skating / past reach | 71% / 36% | **58% / 31%** | 90% / 87% | 98% / 81% |
| Rattata — skating / past reach | 80% / 40% | 80% / 39% | 94% / 72% | 94% / 66% |

**`slow` is the only mode that improves the artefact it is aimed at**, and only on some species.
`restep` and `accept` both drive the stray count to nearly zero and make the real sliding *worse* — the
zero is not a fix, it is the definition: accepting the drawn foot is what "no stray" means. Both also
leave the leg parked at its reach limit, which is precisely where a foot gets dragged from, so `clamped`
roughly doubles. `restep` degenerates into `accept` in practice, since the retry cap is reached quickly
and about three quarters of its actions are fall-throughs.

The reason none of them fixes the broken regime is worth stating plainly: at double the top speed the
body is outrunning its own stride budget, which is an **arithmetic overrun**. No rule about where to put
a foot can answer it. That makes the gate a diagnostic instrument rather than a remedy, which is why it
defaults to `off` — and why the demo's panel says so next to the control.

### Seeing it happen — the demo's fault markers and coach panel

Measuring the two failures headless is one job; making them legible while someone drags a slider is a
different one, and `gait-diagnostics.js` grew three more exports for it. All three are pure and covered
by `test-gait-diagnostics.mjs`.

**`gaitHeadroom(frame)` predicts, where `createGaitMonitor` measures.** The monitor needs seconds of
walking before it can say anything, which is too slow to hold a slider against. This is arithmetic on
the tuning, so it answers on the frame the knob moves. Its load-bearing idea is the **stride budget**:
a leg covers at most two envelopes per cycle and a cycle lasts as long as every leg needs to get its
turn, so `cycleSpeed = 0.8 × 2 × strideEnvelope × concurrent / (stepDuration × legCount)` is a hard
ceiling on body speed. `deriveTuning` already clamps `maxSpeed` to exactly that, then multiplies by
`speedScale` — the knob whose whole purpose is to break the relationship. `speedOverrun` above 1 means
the surplus has to come out of the planted feet. The other two terms are the defects above, expressed
as the quantity that was wrong: `restepEnvelopes` under 1, and `marginGap` (`reachStress − reachMargin`)
at or below zero. Risk is the **worst** term, not their sum, because each is sufficient on its own and
the advice that follows has to point at one knob.

Scored as a classifier over 12 settings × 14 species (`node sweep-gait.mjs predict`): **95% recall, 74%
precision** — three misses out of 168. It was 83% before the step-duration floors; the misses then were
Pikachu and Charizard, and they turned out to be the frames-per-step bug rather than a limit of the
method. The panel still shows the prediction and the measurement side by side and says out loud when they
disagree, because a 26% false-alarm rate is not something to present as an answer on its own.

**`createLegWatch(limits, {tau, fracTau, tapDecay})` scores each leg every frame,** because the report
averages legs together — right for a verdict, useless for a marker that has to sit under one foot. Two
details are load-bearing. It smooths over **planted frames only**, since a swinging foot is supposed to
be moving. And `drag` is normalised off `skateFrames / dragFrameLimit`, the same numerator and threshold
the verdict uses — an earlier version scored it off the mean slide instead, which made a leg amber at 12%
mean slide on a creature the report called clean, so the colour and the word disagreed about the same
walk. The frame fractions get a slower time constant than the ratios (1.5 s against 0.4 s) because they
average a 0-or-1 sequence and a leg sliding a tenth of the time otherwise strobes.

**`diagnoseGait({report, headroom})` returns ranked advice, each entry naming exactly one knob and one
direction.** That constraint is the point: a panel that lists eight correlated numbers tells you
something is wrong and leaves you to guess which slider owns it. A test asserts the rules never ask for
`restepFraction` up and down at once — it has a rule in each direction, since too small drags and too
large starves.

In `demos/stadium-walker.html` this shows up as:

- **Fault markers** (own toggle, independent of the rig overlay). A ring under each foot whose colour and
  size carry the score — green planted, blue swinging, amber to red sliding, pink when *running out of
  leg* is what dominates rather than sliding. A pink stick drawn from where the gait believes the foot is
  to where the solver could actually draw it, visible only once the gap is worth looking at; at the
  shipped defaults nothing clamps and the stick never appears, which is the correct behaviour and is why
  `sweep-gait.mjs watch` takes a `TUNE=` override to check it in a regime where it does.
- **Skid marks** left on the ground by a sliding foot, fading over 2.6 s. The most legible of the three,
  because dragging happens over a whole stance and a per-frame marker can only show an instant of it.
- **Screen-space callouts** on failing legs only. Labelling all fourteen feet at once is the failure mode
  of every debug overlay ever written.
- **A coach panel** on the opposite side from the sliders: two gauges with every term of their arithmetic
  shown, the measured verdict, ranked advice cards with a button that nudges the named slider by 8% of
  its range, and a before/after comparison filled in when the next window completes.

`node sweep-gait.mjs watch` prints the per-leg scores headless, and `predict` scores the prediction
against the measurement. Both exist because a marker validated only by looking at it is not validated.

## Several creatures at once — `stage-roster.js`

The demo was built around one creature: a module-level `current` that the overlay, the fault markers, the
measuring window, the coach panel, the camera and every slider's apply closure all read directly. Tuning
by trial needs comparison, and comparing one setting against another by remembering what the last one
looked like does not work. So `current` is now a pointer into a `stage` Map rather than the only thing
there, and **each creature owns its own slider vector** — which is the part that makes a stage worth
anything, since two creatures tuned identically tell you nothing one creature would not.

`stage-roster.js` is pure and Node-tested. It holds the three things that are easy to get subtly wrong and
impossible to catch by looking at the screen:

- **`resolveScope(roster, scope, selectedId)`** — which creatures a slider change reaches: the selected
  one, everything of its species, or the whole stage. It is an explicit selector rather than something
  inferred from the selection, because "make this one slower" and "make them all slower" are different
  intentions. No selection resolves to *nothing*, never to everything — a slider that quietly retuned the
  stage because a click missed is the kind of thing you notice three trials later.
- **`pickCapsule(origin, dir, capsules)`** — click selection, against a capsule per creature and never
  against the meshes. These models put their vertices at 10× in bone-local space, so their bounding
  volumes are wrong; that is why the viewer disables frustum culling everywhere, and it is also why a mesh
  raycast would be both slow and wrong at the broad phase. Writing the ray-segment math here rather than
  using `Raycaster.distanceSqToSegment` is what let a sign error in it — `w` must be origin minus segment
  start — get caught by a test instead of showing up in the browser as "clicking does not select".
- **`aggregateReports(rows)`** — the group panel, as **counts and rankings, never means**. Every metric in
  `gait-diagnostics.js` is normalised against the creature it came from, which is what makes them
  comparable at all and exactly what makes averaging one across a Rattata and a Paras meaningless. "Three
  of eight are dragging" is a fact; "the stage drags 14%" is not. A creature whose window has not closed
  counts as `measuring`, not as clean.

Spawning clones rather than re-parses: `GLTFLoader.parseAsync` runs once per species and
`SkeletonUtils.clone` produces each individual, which shares geometry and materials and duplicates only
the bone graph. Plain `Object3D.clone(true)` shares the *skeleton*, so every individual of a species would
be posed by whichever walker ran last — the same reason `environment-viewer.html` uses it.

Two costs are controlled deliberately. Fault markers and the rig overlay draw **only for the selected
creature** unless "markers on every creature" is ticked: each creature's markers are several objects per
leg with culling off, so they are transformed and submitted every frame regardless of the view, and that
is the largest avoidable cost on a populated stage. The skid-mark pool is shared and ages **once per
frame**, not once per creature — ageing it inside the per-creature update would make trails fade N times
faster the more creatures you added.

Scoring runs for every creature, though, not just the drawn one. A stage exists so several settings can be
judged at once, and a creature nobody is looking at still has to arrive at a verdict.

**Reports carry the identity of the window that produced them.** Retuning bumps a creature's `windowId`,
and a report arriving with a stale one is discarded. Without that the panel keeps showing the *previous*
settings' numbers under the new settings' name, which is worse than showing nothing because the numbers
look entirely plausible. The measuring window itself is now a slider — short reacts fast and is noisy,
long is trustworthy and slow; the predicted gauges are unaffected either way because they never wait.

## Searching for settings — `gait-search.js`, `trial-log.js`

Twenty interacting knobs are not tunable by reasoning about them, so the panel supports tuning by trial:
**reset**, **tune**, **randomise** with a percentage, a better / same / worse verdict on each, named
setpoints, and a log of everything tried. Both modules are pure and Node-tested.

**Tune is a real optimisation, not a lookup.** `gaitHeadroom` scores a candidate from arithmetic on the
tuning with no simulation, so hundreds fit in the time it takes to draw a frame. `optimise()` is
coordinate descent with shrinking steps — coordinate-wise on purpose, because every improvement it finds
is then attributable to *one* knob, and a search whose answer is a twenty-dimensional jump tells you
nothing about why it is better.

Its objective, `searchCost`, has two terms and the second is not optional. Minimising predicted risk alone
has a trivial answer: crawl. Set the speed low and the guards wide and nothing ever drags, because nothing
happens. So risk is weighted heavily and ties are broken by the stride budget — in **leg spans per
second**, so the same cost means the same thing on a Rattata and a Paras. What it finds is the fastest
settings the detectors do not complain about.

**A percentage means different things to different knobs.** Adding a share of the slider's range is right
for a quantity with a natural zero and wrong for a multiplier: 30% of `speedScale`'s 0.2-to-3 range is
0.84, which doubles a knob sitting at 1 and obliterates one sitting at 0.3. Multipliers move in **log
space** instead, so the same nudge is the same proportional change wherever it starts. `KNOBS` in
`gait-search.js` is the table, and a test scrapes the demo's slider list to assert every tunable knob
appears in it — a knob added to the panel and not to the table would silently never be randomised.

**What transfers between species** is the other half of that table. Most knobs are already fractions of
something the creature owns — a stride envelope, a leg span, its own top speed — and that is the whole
point of deriving the gait from the rest pose, so they carry over by construction. Four do not:
`worldHeight`, `roamRadius` and `footGround` are authored in metres, and `supportPolygonFloor` is a count
of feet that means something different on two legs than on six. `minStepSeconds` looks like it belongs on
that list and does not: it is deliberately un-scaled, because it is a floor on what the eye can follow and
the eye does not care how big the animal is. Applying a setpoint across species drops the four and **names
what it dropped**, since a setpoint silently losing knobs reads later as a broken search loop rather than
as a units mismatch.

**Every creature in scope gets its OWN draw.** The first version drew one vector and applied it to
everything in scope, so a stage of eight ran eight copies of one setting — all the cost of a stage and
none of the comparison. Randomise and tune now run per creature, each perturbed or optimised from that
creature's own values, and each logged as its own trial. Tune in particular has to be per creature: the
stride envelope and leg span differ per species, so the best settings for a Rattata are not the best
settings for a Paras. Reset is the one case where everyone legitimately gets the same vector, since the
defaults are the same numbers for all of them and what each rig derives from them still differs.

**Rejection is a toggle and defaults to off.** `gaitHeadroom` could veto a candidate for free, but its
precision is 74% — about a quarter of what it flags walks cleanly, and those sit exactly on the boundary
worth exploring. Switched on it resamples a bounded number of times and then shows what it has; either way
the candidate is logged, so a better rule can re-score it later.

**A trial row carries the human verdict and the machine metrics separately, never fused.** Merging them
into one quality number destroys the only interesting question in the data — whether they agree — which
`pearson` answers once there are enough rated rows. `metrics: null` is a legitimate state for a row whose
window had not closed, and every reader filters for it; what must not happen is a row picking up the
numbers currently on screen, which were measured under the *previous* settings and would look entirely
plausible. Each trial therefore records the window id it is waiting for, and metrics attach only when that
exact window closes — on the creature it was run on, not on whoever is selected by then.

`tuningMatrix` normalises each knob against its **declared slider range**, not against the spread of the
trials. Scaling by observed variance would make a knob you nudged slightly count as much as one you swept
end to end, and would move every existing point each time a new trial arrived. The log caps itself at 800
rows, drops oldest-first, counts what it dropped, and survives a full quota by keeping rows in memory so
they can still be exported.

### Where a session is saved — `disk-store.js`

Everything this page authors is written to a **file**: `stadium-saves/stadium-tuning.json` holds the
setpoints, the poses, the hand-assigned bone roles and the panel state, and `stadium-saves/stadium-trials.json`
holds the log. Both autosave on every change and land in git. This is not a nicety. Twenty knobs tuned by
trial over hours is the entire product of using this page, and the first version kept all of it in
`localStorage`, which is scoped to the origin: clearing site data loses it, and serving the page on a
different port loses it, silently, with nothing to restore from.

`disk-store.js` is the shared piece and is the pattern every authoring page here should follow.

- `createDiskStore({read, write, storage, key})` GETs the file, and only if that fails falls back to the
  browser copy. Both sides are injected, so the whole store is Node-tested in `test-disk-store.mjs`.
- Web storage is demoted to a **cache**, never the truth. It is written *before* the POST, so a crash
  between the two still has the work; it is what a page opened without `python serve.py` reads; and the
  status line says `loaded from the browser copy — start the server to save` when that is what happened,
  rather than looking identical to a real load.
- Autosave is debounced, so a slider drag is one write. A close is not: `fetch` is cancelled during unload,
  so `pagehide` re-sends anything outstanding with `navigator.sendBeacon`.
- Writes are serialised. An edit made while a write is in flight queues one trailing write instead of
  racing it, which is the case a naive debounce loses.
- **save now** forces a write and **snapshot** writes `stadium-tuning-<stamp>.json` beside the live file,
  because tuning is exploratory and the value of "the one that looked right an hour ago" only becomes
  obvious after it has been overwritten.
- `serve.py` accepts exactly three filenames on `/api/save-stadium`, rejects a non-JSON body, and gives
  only the timestamped name a collision suffix — the two live files are meant to be overwritten.
- The four old browser keys carry over once, on the first load with no file present, so an existing session
  is not lost to the change. `_check_stadium-walker.html.mjs` asserts that `localStorage` appears in the
  page *only* as the store's fallback and in that carry-over.

### Seeing the skeleton

`audit-stadium-rig.mjs` can say that two of Sandslash's four legs share three bones, but a list of
`boneNN` names is not checkable against a creature — you have to see which part of the animal each name
is on. So the View panel draws every bone as a segment from itself to each of its children, coloured by
what the mapper decided it is, with the model solid, wireframed or hidden behind it. Bone names can be
off, on the legs only, or on everything, and clicking a bone reports its role, parent, children and
world position.

**Red means the bone is claimed by more than one leg.** That is the whole reason the view exists: it is
the exact signature of the mapper walking one limb out to two toes and calling the result two limbs, and
nothing else on screen shows it. Bones are picked with the same `pickCapsule` the creature selection
uses — a bone segment is a capsule like any other, so there is one tested picker rather than two.

Model mode applies to every creature at once, because `SkeletonUtils.clone` shares materials between
individuals and that sharing is what makes a second one nearly free. Setting `wireframe` on one would set
it on all of them anyway.

## Two themes

The scene has a night and a day palette — a pale ground shows a dark model's silhouette, a dark one shows
the coloured fault markers and the skid trails, and which reads better depends on the species. Everything
in `SCENE_THEMES` is a value the scene already had, so switching cannot change what the gait does. The
skid marks are the one thing that needs real work: they fade by dimming toward black, which is invisible
on a pale ground, so on the day palette they fade toward white instead. A retired mark is collapsed to
zero length rather than coloured out, since colouring it out is invisible on one palette and a stray dark
line on the other.

The panels can also switch to the look `environment-viewer.html` and `bot-viewer-v3.html` share, via
`workshop-panel-theme.js` — which reads the same saved `pcw:uiTheme` colours, so a theme picked in the
environment viewer carries across. That stylesheet also owns the panel's *position*, docking it to the
right edge, which is right for a viewer with one panel and wrong for a page with one on each side; a small
override puts them back and bridges this page's `<details>` markup onto the `.sec` card look.

## The two things everything above assumes — `rig-audit.js`, `audit-stadium-rig.mjs`

Every number in this document is computed from two assumptions that nothing tested until now: that the
mapper picked the right bones, and that the clip playing on the spine is compatible with walking. Both
turned out to be partly false, and the second one worse than that.

**Run `node audit-stadium-rig.mjs`.** It reports mapping findings and per-clip hip disturbance.

### The clip is an input to the gait, not a layer on it

The walker writes leg bones *after* the mixer, so whatever the clip does to the spine is carried into the
hips the legs hang off. The viewer strips tracks targeting leg **bones** — but not tracks targeting the
bone a leg is **attached to**, and on Rattata the last spine bone *is* the attach for the front legs.
Measured: **every clip on every one of the fourteen models animates a leg attach or one of its
ancestors.** Stripping the leg-bone tracks changes Tauros's hip disturbance by exactly zero.

How much it matters depends on the model, and the number to read it against is the stride envelope — the
whole distance a foot has to work in:

| | idle hip travel | stride envelope | ratio |
|---|---|---|---|
| Seel | 38.4% of a leg | 9.5% | **4.0×** |
| Tauros | 42.7% | 16.2% | **2.6×** |
| Nidorino | 27.9% | 15.2% | **1.8×** |
| Growlithe | 16.2% | 14.8% | **1.1×** |
| Pikachu | 8.5% | 12.2% | 0.7× |
| Ponyta | 5.9% | 30.6% | 0.2× |
| Slowpoke | 0.6% | 14.3% | 0.04× |

Four of fourteen have an idle that moves the hips further than the entire envelope the feet work in.
On those, the animation is a second walk fighting the first.

**And the sweep never ran it.** Neither `sweep-gait.mjs` nor `test-stadium-rig.mjs` creates an
`AnimationMixer`, so every measurement in the sections above was taken with no clip playing, while the
demo plays the idle by default. Those are two different systems. The measured numbers are correct for a
creature with a still spine and describe something other than what the viewer shows.

On the "best clip" question: the idle is usually already the quietest, so the existing choice is
defensible — but not always. Paras's `reaction_182` disturbs 5.0% against the idle's 12.4%, and Charizard
has an `idle_alt` nobody had looked at, at 32.6% against the idle's 6.5%.

### The mapping is right about feet and wrong about limbs

Every model puts its feet on the floor, which is the thing the mapper is demonstrably good at. Three real
errors across the set, none of which produced a mapper warning — the mapper emits no warnings at all on
any of the fourteen:

- **Sandslash's four legs are two limbs.** Rows 0 and 1 share their first three bones; the mapper walked
  one forelimb out to two different claws and called them two legs. Every other check passes it: both
  chains reach the floor, both are a sensible length, and the left/right spans match beautifully —
  because they are the same limb. It has been walking on four legs it does not have.
- **Pikachu's left leg is six bones and its right is four.** One of them ran on into something that is not
  a leg. The spans match to within 0.2%, which is exactly why a symmetry check on span alone passed it.
- **Every model has bones near the floor that no leg claimed** — four on Rattata, eight on Ivysaur. Those
  are probably toes, but nothing has checked.

### One real bug found on the way

`readAccessor` ignored `accessor.normalized`. Every animation rotation in these models is a normalized
int16, so quaternion components came back around 23000 where 0.707 was meant; composed into a matrix and
chained down four bones, the first audit run reported hip travel of 10^19 leg spans. Fixed in
`stadium-glb.js`. **The rig mapper is not affected** — the only normalized accessors in these files are
animation rotations, which the mapper never reads — so the mapping findings above stand independently.

### What this means for the numbers above

The mechanisms hold: a three-frame step arc renders as a spike whatever the leg span is, two grounded feet
are a line whatever bones they belong to, and a re-step guard under one envelope drags. The **magnitudes**
are conditional — on the mapping being right for that species, and on there being no clip. Sandslash's
numbers describe a creature with two legs used twice. Every Seel and Tauros number describes a spine that
does not move.

## What is checked in, and how it behaves

Fourteen species, chosen to cover the three cases the mapper produces rather than to be a nice
selection: nine quadrupeds (Rattata, Growlithe, Ponyta, Tauros, Nidorino, Slowpoke, Ivysaur,
Sandslash, Seel), four bipeds (Pikachu, Charizard, Machop, Sandshrew) and one hexapod (Paras, whose
alternating tripod falls out of the same scheduler with no new code). `test-stadium-rig.mjs` walks
every one of them for ten seconds and asserts it carries itself between 85% and 115% of its own ride
height, takes more than 20 steps and covers more than 1.5 leg spans of path (an absolute 30 cm asked
far more of the small models than the large ones) — so a species that cannot stand up is a
test failure rather than a surprise in the viewer.

## Open threads

- **Slopes are exercised but not tuned.** A test swaps a sine-and-tilt ground under a walking Rattata
  and its planted feet stay on it, but no attention has been paid to how the gait *looks* on a hill,
  and nothing tests a slope steep enough to matter.
- **`uprightSupport` stands in for ankle torque.** A real balance model would replace it.
- **Gallop drags on every species.** The collapse is fixed but the gait is not: 14 of 14 drag, with 46%
  of planted frames past full reach and the drawn foot more than 5% of a leg span from the gait's foot on
  99.8% of them. Walk got a full sweep and gallop has had one measurement; it needs the same treatment.
- **Two bipeds cannot gallop at all.** Pikachu and Machop take 0.03 and 0.07 steps per second under
  `GAITS.gallop` — they are effectively standing still and sliding. Pre-existing and untouched by the
  concurrency cap, which exempts bipeds by construction.
- **Growlithe is the slowest walker, at 0.23 leg spans per second**, and its stride is 18% of its leg
  span against Ponyta's 56%. That is a rest pose with almost no stride envelope, and it was masked until
  the step-duration floors stopped it cycling its legs faster than they can swing. **This now has a fix
  rather than only a diagnosis** — see the stance section above; a crude 0.15 rad hip turn takes it to 32%
  of a leg span and 77% of commanded speed. No stance has been authored for real yet, so the shipped
  numbers throughout this document are still the sitting dog's.
- **Charizard's swing is still fast at a gallop**: 11.0 leg spans per second, 8.1× its own body speed,
  against 1.0–2.7 for everything else.
- **The idle clip is layered, not blended.** A clip that moves the spine a lot will drag the hips
  around; there is no damping on that yet.
- **There is no ankle, so every creature heel-and-toe walks.** The foot is welded to the shank and its
  sole pitches with it. `footBones`/`ankleIndex` now exist to hang a fix on; nothing uses them.
- **Foot contact is one point, not a patch.** Real feet place a polygon. This is part of why two grounded
  feet degenerate to a line, which `supportPolygonFloor` currently works around rather than solves.
- **The stray gate has no mode that actually repairs an overrun.** `slow` helps on two of four species
  and does nothing on the other two; `restep` and `accept` make things worse. The honest fix for the
  regimes where feet stray is upstream — the body must not be commanded past its stride budget in the
  first place — so the gate is a measuring instrument that also happens to be able to act.
- **Gallop is reachable but unmeasured.** The demo offers it and `rowPairSteps` moves a whole row, but
  none of the numbers above were measured under it.
- **35 species cannot be hand-mapped.** The auto-mapper finds no legs on them; the Bone roles panel is the
  tool for that, and it only works on a spawned creature, which a legless species cannot become. They are
  selectable and labelled, but the fix needs the rig stage to work on a species rather than a creature.
- All 151 are checked in. `docs/stadium/tooling/extract_glb.py` re-extracts any of them if needed.
