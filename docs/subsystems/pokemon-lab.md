# Pokémon Lab

Annotating the 151 Pokémon Stadium models so they can move. Browse every species and its shipped
animations, say what each part of its skeleton is, set the pose it stands in, and save all of it to one
file that everything downstream reads.

**v1 is the tarmac only** — browse, annotate, pose. Movement is v2 and moves are v3, and both are readers
of the file v1 produces. The full plan, including the measurements it was designed against, is
`docs/pokemon-lab/v1-plan.md`.

`docs/pokemon-lab/pipeline.html` is the same story as one picture: every stage from the N64 ROM to the
annotation file and the readers it is waiting on, colour-coded by what is built, with the reasoning behind
each box on hover. Open it in a browser.

`docs/pokemon-lab/math.md` is every number the lab quotes and how far it can be trusted: the pose-distance
metric in full, what has actually been measured, the four known gaps in it, and the measured constants
(frame rates, chain mass fractions, the rig hash, the mirror suggestion). Each claim is marked measured,
inferred or eyeballed.

| File | Role | State |
|---|---|---|
| `pokemon-rig.js` | Facts about a skeleton. No heuristics. | shipped |
| `pokemon-annotation.js` | The schema: what a person decided each part is. | shipped |
| `pokemon-lab-io.js` | The one file, through `disk-store.js`, and the dex list. | shipped |
| `pokemon-pose.js` | How far apart two poses are. Pure; not wired into the page. | shipped |
| `pokemon-select.js` | Picking bones and chains: the gestures, and screen-space hit-testing. | shipped |
| `pokemon-lab.html` | The page. | browse, segments and bone picking shipped |
| `test-pokemon-rig.mjs` | 38 checks, mostly over all 151 models. | shipped |
| `test-pokemon-annotation.mjs` | 62 checks, built against real rigs. | shipped |
| `test-pokemon-lab-io.mjs` | 30 checks, including two cross-checks. | shipped |
| `test-pokemon-pose.mjs` | 29 checks, four species. | shipped |
| `test-pokemon-select.mjs` | 20 checks, six species. | shipped |
| `_check_pokemon-lab.html.mjs` | 47 static checks on the page. | shipped |
| `pokemon-gates.js` | Per-class validation. | not started |
| `pokemon-lab-runtime.js` | The `base-game.html` import contract. | not started |

This is a separate line from `demos/stadium-walker-v2.html` and the `stadium-*.js` modules, which keep
working and are not changed. The only thing shared is `stadium-glb.js`, whose GLB reading is verified and
worth reusing.

## Why the split between `pokemon-rig.js` and everything else

The old mapper (`stadium-rig-map.js`) measured and guessed in one function, so its output could not be
told apart: a vertex position and a decision about what a leg is came back in the same object with the
same authority. Disagreeing with it meant arguing with a black box.

`pokemon-rig.js` measures and nothing else. Every value in it is derived from the file and can only be
wrong by being buggy. Guessing lives outside it, is always optional, and is recorded as a draft until a
person accepts it.

## `pokemon-rig.js` — the facts

`readRig(json, bin)` returns everything measurable about one model:

```js
{
  bones: [{ key, name, node, parent, children, hasGeometry, restWorld, rest }],
  byKey, nodeOf, keyOf,          // key <-> node id, both directions
  root, roots,
  chains: [{ id, attach, bones, tip, massFraction }],
  geometry: Map<key, { count, points, centroid, min, max, lowest }>,
  clips:   [{ index, name, duration, tracks, bones }],
  units:   { floorY, topY, height, halfWidth, totalVertices },
  duplicateNames, hash, notes,
}
```

Other exports: `readRigFromGLB`, `pivotTree`, `extractChains`, `boneGeometry`, `boneKeys`, `readClips`,
`sampleClip`, `rigHash`, `restTRS`, `subtree`, `descendants`, `ancestors`, `isUnbrokenChain`.

### Bone keys, and the three species that break names

Bones are keyed by **name**, because names are readable, diff cleanly in git, and survive a reload.
All 151 models name every bone `boneNN`.

**Charmander, Charizard and Magmar each contain two different bones sharing one name.** A collision gets
`#2`, assigned in ascending node order so it is deterministic. `rig.duplicateNames` reports it and a test
asserts the set stays exactly those three, so a re-extraction that changes it fails loudly rather than
silently attaching a role to the wrong bone.

### The rig hash

`rig.hash` is FNV-1a over the topology — each bone's key, its parent, and its vertex count. An annotation
records the hash it was made against, so a re-extracted model invalidates its annotations loudly instead
of applying them to bones that moved.

### Chains are topology, not anatomy

`extractChains` splits at every branch point. That decomposition is deterministic and is a fact. That a
given chain is a *limb* is a guess, and is not made here — chains are offered as a selection convenience
and the annotation always stores bones.

Measured: **3,496 chains across the dex, of which 1,772 carry more than 2% of their model's mesh**
(median 11 a species, range 3–24). `massFraction` is reported and the threshold is the caller's business.

## `pokemon-annotation.js` — the decisions

Every edit returns a **new** annotation rather than mutating, so undo is a stack of references. The
shape:

```js
{
  version, species, rigHash,
  locomotion, posture,
  parts: { root, spine: [], head: [], appendages: [], contacts: [] },
  neutral: { bones: { key: {p,q,s} }, ground, source },
  segments: { idle: { clip: 0, from: 0, to: null, ends: 'loop' } },
  done, notes,
}
```

### Segments: named slices of a ROM clip

The Stadium animations are compound performances, so the useful animation is often a **range** rather than
a whole clip. Squirtle's `attack_5` is eight frames of pulling into its shell followed by forty-four
sitting in it, which is `enter_shell` and `in_shell` in one clip the ROM only ever played as a move.

A segment is `{ clip, from, to, ends }` in **frames**, and it is a view into the clip rather than a copy of
its keyframes, so naming a range costs nothing and re-slicing costs nothing.

- **`to: null` means the last frame.** A whole-clip segment therefore does not record a length, and stays
  correct if the model is ever re-extracted at a different one.
- **`from` after `to` plays backwards**, which is how an exit is the entrance reversed for free.
- **`ends` is `loop` or `hold`**, and only those two, because only two things are being said: this is a
  state, or this is a transition. Whether a held segment then returns to something else is the caller's
  decision, not a fact about the clip, so the file does not try to express it.

`resolveSegment(segment, frames)` makes the bounds concrete and reports `reversed`, `length` and
`truncated`. Bounds are **clamped rather than refused** — a segment authored against a longer cut of a clip
still plays, and `validateAnnotation` reports it separately.

Why this is an annotation rather than something a tool derives: only 14% of the clips in the dex pause
anywhere, and the peak of the motion lands in the first, middle and last third almost evenly (324 / 516 /
330). There is no structure to find. Where the meaningful frames are is a judgement, exactly like which
bones are a leg.

One measured fact makes the whole feature safe: **only 2 of 1,171 clips translate the root bone at all**,
and neither moves the body more than 10% of its own height. These are battle-platform performances, so a
segment lifted out of the middle of one does not drift.

### States and transitions are read from the range, never stored

A **state** is a segment a creature can stay in. A **transition** is one that runs out and leaves it
somewhere else. Nothing in the file records which is which, because the range already says it:

| Range | Kind |
|---|---|
| `ends: 'loop'` | state — it sustains |
| a single frame, `from === to`, held | state — a pose you can stand on |
| anything else held | transition — it ends somewhere new |

`segmentKind(segment)` derives it, `statesOf(a)` and `transitionsOf(a)` split the list, and `poseAt(clip,
frame)` builds the single-frame form. The kind is not independent information — the range determines it
completely — so storing it would put one fact in two places. The file is meant to be hand-edited, and
changing `to: 51` to `to: 60` in a text editor would leave a stored kind behind saying the wrong thing. A
check asserts the page never writes one.

**A state is not the same thing as a segment, and this section names the smaller idea.** `segmentKind`
answers "does this slice sustain, or does it lead somewhere". It does not answer "what state is this",
because a state can be realised by many frames across many clips — see the next section.

`segmentKind` is exact on a `resolveSegment` result and best-effort on raw data, where an open `to: null`
cannot be compared against `from`. `resolveAnnotation` therefore attaches `kind` *after* resolving, so a
runtime is handed the answer rather than re-deriving it.

**State names are the part that is a decision.** A runtime asks 151 different skeletons for `idle` and has
to get the same idea back, so `COMMON_STATES` — `idle`, `walk`, `run`, `crouch`, `sleep`, `hurt`,
`fainted`, `airborne`, `guard`, `attack` — is offered everywhere a name is typed. It constrains nothing:
the name field is free text with a datalist, never a select, because `in_shell` belongs to Squirtle and to
no list. A check pins that.

### How near is one pose to another

Whether a creature can *reach* a state is a question about pose distance, and it is measurable.
`pokemon-pose.js` computes it, `test-pokemon-pose.mjs` pins it, and **`docs/pokemon-lab/math.md`** carries
the derivation, every figure, and the limitations — the numbers live there so there is one copy of each.

The short version: run forward kinematics over a **window** of consecutive frames, solve for the one
ground-plane transform (yaw plus xz translation) that brings the two windows closest, then take the RMS
bone displacement weighted by the mesh skinned to each bone, over body height. Read the result in units of
that species' own median frame-to-frame change.

The window is what carries direction — a single frame is a shape with no motion attached, so the top of a
jump matches the top of a fall. One shared transform across the window, not one per frame, is what stops a
window turning left from being rotated onto one turning right.

Reachability is best read as **isolation** — nearest frame elsewhere in the species, over the mean distance
between two arbitrary frames of it:

| Pose | Nearest | Mean pair | Isolation | Blend length |
|---|---|---|---|---|
| Squirtle in-shell | 0.175 | 0.687 | **0.25** | ~9 frames |
| Pikachu fainted | 0.183 | 0.190 | **0.96** | ~32 frames |

The raw distances are nearly the same. Squirtle has poses far nearer its shell than chance would give;
Pikachu has essentially nothing nearer its fainted pose than chance. **Reachability varies enormously
between states, so a transition system needs both a blend path and an authored path.**

Three results shape the design:

1. **Prefer an authored segment over a computed blend.** Squirtle moves *away* from the shell pose before
   landing in it, so the authored transition takes 20 frames where a blend would take 9. The animator was
   not taking the short path, and the short path is not what it should look like.
2. **A state is a looping range, not a still frame.** Across the shell hold the pose keeps moving slightly.
3. **The metric finds regions but cannot name them.** Most of Squirtle's `entrance` sits 0.18–0.30 from the
   shell pose — near, at a distance where no threshold could say whether those frames *are* the in-shell
   state, a crouch, or something else. Whether two frames are the same state is a judgement, the same as
   which bones are a leg.

Alignment, windows and the isolation statistic all arrived on 2026-08-28 as corrections. The metric had
been root-centring instead of aligning, which counted a turned pose as a distant one and moved most figures
by 20–58%; it had compared single frames, so two poses moving in opposite directions scored as identical;
and the Pikachu conclusion had been stated backwards. `math.md` §6 records all three, because each produced
confident and plausible output while being wrong.

Windowing barely moved the headline figures, because both measured targets sit inside a hold. What it
bought is protection against a small, severe tail: a few percent of statically-matching frame pairs are
wrong by over ten times the median, and a nearest-frame search selects on exactly the score a false match
gets. Squirtle's `attack_3` passes through the same pose at frames 39 and 61 — 0.009 apart, half a frame of
motion — and leaves in different directions; as windows they are 82× further apart.

That last point is also why **a state is not a segment**. A state can be realised by many frames across
many clips, so the eventual shape is a named state holding a *set* of representative poses plus an optional
segment to loop while in it, with segments left exactly as they are. Reachability becomes distance to the
nearest representative, and entry lands on whichever one is closest to where the creature already is.
Sketched with the user 2026-08-28, **not agreed and not built.**

### One representation, two gestures

A part stores an **ordered bone list**, never a reference to a chain. `toggleBones(a, rig, id, bones)` is
the single primitive behind both gestures: the bone gesture passes one key, the chain gesture passes a
chain's worth. Because both land in the same place there is no mode to be in, and correcting one bone on
a part built by a chain click cannot leave a stale reference.

`orderBones` puts bones in root-to-tip order by depth, so clicking them in any order still produces a
chain a limb can use.

A partly-present chain click **completes** the part rather than toggling each bone individually — that is
what a person means by clicking a chain they have already started.

### Contacts are stored once

`parts.contacts` is a flat list of every bone that touches the ground. Which limb a contact belongs to is
derived by `contactsOf(a, id)`; a contact in no limb is a body contact (`bodyContacts`) — a Caterpie's
belly, a Voltorb's underside. Storing it per-limb as well would be the same fact in two places.

### Locomotion classes

`walker`, `flyer`, `swimmer`, `hopper`, `serpent`, `worm`, `roller`, `floater`, `burrower`, `static`.

`serpent` and `worm` are deliberately separate: Onix is a rigid segmented body that steers, Caterpie
inches by travelling a wave along itself.

The 35 species where the old mapper finds no legs are not failures. Voltorb is a `roller`, Gastly a
`floater`, Onix a `serpent`, Diglett a `burrower`.

### Grounding is class-dependent

`defaultGrounding(locomotion)` is false for `flyer`, `floater` and `swimmer` — dropping a Gastly onto the
floor would be actively wrong. `groundingOf(a)` returns the explicit choice if there is one, else the
class default.

This exists because **32 of the 151 models do not stand on y = 0**, by up to 303% of body height
(Zubat), and that list is almost exactly the flyers, floaters and swimmers. y = 0 is the battle-platform
anchor, not the ground.

### Mirrors: the pair is declared, the bones are suggested

`declareMirror(a, idA, idB)` is reciprocal by construction and releases whatever either side pointed at
before, so a one-way mirror cannot be created.

`suggestMirror(rig, bones)` proposes the opposite-side bones by matching x-mirrored rest geometry, and
reports a per-bone distance in body heights plus any misses. It is a **suggestion** — it saves clicking,
it does not decide. On Rattata it matches 4 of 4 bones with a worst error of 1.0% of body height.

### Validation

`validateAnnotation(a, rig)` checks structural integrity only — class rules belong in `pokemon-gates.js`.
It never throws and never repairs; it reports findings and the caller decides. Codes: `stale-rig`,
`unknown-bone`, `broken-chain`, `double-claim`, `duplicate-id`, `dangling-mirror`, `one-way-mirror`,
`same-side-mirror`, `bad-class`, `bad-posture`, `bad-type`, `bad-side`, `bad-clip`, `empty-part`,
`posture-ignored`.

### The stamp

`annotationStamp(a)` hashes content, not identity: reordering the appendage list does not change it,
changing a chain does. `done` and `notes` are bookkeeping and deliberately do **not** move the stamp, so
marking a species finished does not invalidate a trial measured against it.

### Handing it to a runtime

`resolveAnnotation(a, rig)` turns every bone key into a node id. The file speaks in names because names
are readable; a runtime speaks in node ids because that is what a loader gives it. This is the only place
the two meet. Bones the rig no longer has are dropped rather than resolved to null.

## `pokemon-lab-io.js` — the file and the dex

The library lives in `stadium-saves/pokemon-lab.json`, read and written through `disk-store.js` and
whitelisted in `serve.py` alongside the stadium files. `localStorage` is the fallback cache only.

`migrateLibrary(raw)` reads whatever the file actually holds. It never throws and never drops a species
without saying so, because a hand-edited file is expected — saving to disk is only worth doing if a person
can open it. Half-written entries are filled in rather than left to crash a reader, and where a key and an
entry's own `species` field disagree, **the key wins** and the mismatch is reported.

`dexEntries(manifest)` is the browse grid's list. The species key is the `.glb` basename, so a
re-extraction that renames a model shows up as a missing species rather than a silently mismatched one.

### Clip labels are taken by index

The manifest's clip list matches the `.glb` animation list exactly — same count, same order, same names,
and durations agreeing to within a frame — across **all 1,171 clips in the dex**. `test-pokemon-lab-io.mjs`
asserts that against the real files, because the day it stops being true every label in the page points at
the wrong animation with nothing looking broken.

Every clip in the dex runs at **exactly 30fps** (`seconds` is `frames / 30` rounded to three decimals, with
no exceptions), which is what makes a frame readout meaningful.

Nothing writes 30 down, though. `pokemon-rig.js` reports `frames` and `fps` per clip as **measured** facts:
the frame count is the key count on the longest track, and since the keys are uniformly spaced on every
clip in the dex, the rate falls out of the duration. A clip that was not 30fps would report its own rate
rather than being played at the wrong speed. A test pins the measured frame counts against the manifest
across all 1,171 clips and asserts the dex holds exactly one frame rate.

### Two signals, not one status

`speciesStatus(annotation, findings)` keeps *a person marked this done* and *the gates are happy* apart, per
the board table in the plan. A `null` findings list is not an empty one: nothing is called `ready` on the
strength of checks that never ran, which is what stops the board looking finished before `pokemon-gates.js`
exists.

## The page: browse mode

The 151 grid, a model loaded and framed from `rig.units` rather than a skinned mesh's bounding box (which
is garbage on these models), every animation the ROM shipped with it, and a transport with a frame-accurate
scrubber. The facts panel is entirely `pokemon-rig.js` output; the warnings explain what it noticed rather
than detecting anything themselves.

What browse mode saves is **named segments**. Set a start and an end, or press **Mark pose** to make both
the frame you are on, choose whether the range loops or holds, give it a name, and it is written to the
file. Each saved segment shows whether it is a state or a transition, which is derived from its range. The
manifest's guess at which clip is the idle is shown as a suggestion and stays one until somebody saves a
segment called `idle` — the facts-versus-decisions split working at its smallest scale. A test asserts a
suggestion can never reach the file on its own.

Keys: space plays and pauses, the arrows step a frame, `i` and `o` set the start and the end, `p` marks the
pose, `b` shows and hides the skeleton, `h` shows and hides the body, Escape clears the bone selection,
`[` and `]` change species, `/` focuses the filter, and Ctrl+Z and Ctrl+Shift+Z undo and redo.

### The page owns the clock

The transport does not use `AnimationMixer`'s loop modes. Every frame it works out a frame number, writes
it into the action, and calls `mixer.update(0)` so nothing else advances anything. That is what makes a
segment and a whole clip the same code path: a range whose in point is after its out point runs backwards,
and a range that holds stops at its end. Expressing those four cases through `LoopOnce`, `LoopRepeat`,
`clampWhenFinished` and a negative `timeScale` would be more code and less predictable, and a check asserts
every `mixer.update` call passes zero so the two clocks can never fight.

Two model quirks from `docs/stadium/HANDOFF.md` are handled on load and show up immediately if they are
not: `frustumCulled = false` (vertices are authored in bone-local space, so parts vanish with camera angle)
and `DoubleSide` (some face decals are wound backwards because the game rendered with culling off).

## The page: the skeleton and picking

The overlay is an `InstancedMesh` of joints plus a `LineSegments` of parent-to-child links, both drawn with
`depthTest: false` and a high `renderOrder`, because a rigger needs to see the bone inside the leg. Both
are re-placed every frame from the live `Object3D` matrices, so the skeleton follows playback, the
scrubber and the rest pose without knowing anything about them. The root joint is amber, selected bones
green, the hovered one white.

`frustumCulled = false` on the overlay for the same reason as the model: these meshes have garbage
bounding volumes.

**Body** (`h`) hides the mesh and leaves the bones, by hiding `modelRoot`. Only the drawing stops: the
mixer still runs and `getWorldPosition` still resolves, so the skeleton keeps animating and stays pickable
with the body off.

### Bones are matched to objects by node index, not by name

`boneObjects(rig, gltf)` walks `gltf.parser.associations`, which maps each `Object3D` back to its glTF node
index. **Charmander, Charizard and Magmar each contain two bones sharing one name**, so a name lookup would
attach the overlay to the wrong bone on exactly the models where being wrong matters most. A check forbids
`.name` in that function.

### Picking is screen-space, which is what makes it agree with the drawing

Not a raycast. The overlay ignores depth, so a raycast would pick a different bone from the one the eye
sees every time a joint sits behind a leg. `nearestPoint` takes the projected joints in CSS pixels and
returns the nearest within 16px, breaking ties by camera depth so the one in front wins where two overlap.
Joints behind the camera are excluded, because `project` wraps their sign and the hit would be nonsense.

It is also forgiving in a way a small sphere is not, which matters on the rigs whose joints are a few
pixels apart.

A click that moved more than 4px from where the button went down is an orbit, not a pick. OrbitControls
offers no "was that a drag" signal, so the distance is the only thing that can separate them.

### One representation, two gestures

Click a bone to toggle it; shift-click to toggle the whole chain it belongs to. Both go through
`toggleKeys`, which **completes** a partly-present group rather than flipping each key — what a person
means by clicking a chain they have already started one bone of. Only a wholly present group is removed.

That is the same rule `toggleBones` applies when a selection becomes a part, and a test drives both through
the same sequence and asserts they agree at every step. There is no mode flag and no second selection; a
check forbids one appearing.

### Two measured facts the plan did not have

**The root bone is in no chain.** `extractChains` splits at branch points and the root is one, so it is an
attachment rather than a link. That is exactly 151 bones dex-wide, one per species, and it is why
`chainKeysOf` falls back to the bone alone rather than asserting.

**The chain gesture buys much less than the plan assumed.** The plan justified it with "median 11
significant chains beats median 42 bones", which is true as a count of things to *name*. But measured
across the dex, **2,136 of 3,496 chains are a single bone and the median chain length is 1**:

| Species | Bones | Chains | Longest chain |
|---|---|---|---|
| Onix | 40 | 39 | **1** |
| Sandslash | 67 | 54 | 3 |
| Pikachu | 37 | 18 | 4 |
| Caterpie | 26 | 17 | 5 |
| Squirtle | 30 | 14 | 6 |
| Ekans | — | — | 23 |

On Onix, clicking chains *is* clicking bones. The two-gesture bet holds for Squirtle and Ekans and does
nothing for a third of the dex, which suggests phase 3 will want a subtree gesture — select a bone and
everything below it — since `descendants(rig, key)` already exists. Not built; the plan says two gestures
and that is what is here. A test pins the Onix numbers so the problem cannot quietly go away.

### The grid is sized, not subdivided

`frameCamera` builds the grid with a **fixed division count and derived spacing**. It used to be the other
way round — spacing pinned at 0.5 world units with the extent scaling from the model — which made the line
count scale instead. Measured across the dex that reached 2,560 divisions and 5,122 lines on Moltres, with
14 species over 1,000 divisions, at a spacing far below what anyone can resolve.

That was reported as heavy lag when the camera drops below the grid, and the mechanism fits: seen edge-on,
every one of those lines still spans the width of the screen and they all pile into one band. From the
default view above, the same grid recedes and costs much less. **This is inferred from the geometry, not
profiled.** If it persists, the next suspects are the transparent `DoubleSide` overdraw between the model
and its ghosts, and the camera's 40,000:1 near-to-far ratio (`near = span / 200`, `far = span * 200`).

A check pins the division count as a constant.

### What the panel reads

`selectionInfo` returns the bones root-to-tip, the count, the **mass fraction** — how much of the model's
mesh the selection carries, which is the number that says whether a selection is a limb or a decoration —
the chains it covers wholly and partly, and whether it forms one unbroken parent-to-child run.

`unbroken` is reported, never enforced. A pair of ears is one part and two runs, so it is a hint here and a
gate's business later.

### Snapping is a scrubbing convenience, not a limit

`play.frame` is fractional on purpose. The mixer interpolates between keys, so any position between two
frames is a real pose. The **Snap** button only changes the scrubber's step; with it off the readout shows
two decimals. Segment bounds are still whole frames, because that is what the file stores.

Stepping floors going forward and ceils going back, so a step from frame 12.6 lands on 13 rather than
skipping to 14.

### Undo is a stack of references

Every `pokemon-annotation.js` edit returns a new object, so a snapshot shares every untouched species with
the one before it. `commit(next)` is the only place `library` is assigned other than `undo` and `redo`, and
a check asserts that count stays at three — an edit that wrote `library` directly would be invisible to
undo and would not be saved.

### Ghosts: two independent axes

Translucent copies of the range's start and end frames, so a loop can be closed by eye.

- **Which** — `start`, `end` or `both`.
- **Where** — `overlap` puts them at the model's own position, which is how you judge how close a loop is;
  `offset` pushes them apart, which is how you compare two poses side by side.

These are separate controls because they answer different questions. Ghosts are built with
`SkeletonUtils.clone` (a plain `clone(true)` shares the skeleton, so posing a ghost would pose the live
model) and given one flat `MeshBasicMaterial` each — cloning the real node materials produced nothing
visible under WebGPU. **The geometry is shared with the live model, so disposing it empties the viewport**;
only the material is disposed. A check pins that, and a failure to build ghosts is caught and reported
rather than aborting the species load.

Toggling ghosts does not move the camera, and marking a start or an end does not start playback. Both were
reported as annoyances and both have checks.

### The axis gizmo

Three.js `ViewHelper`, bottom right. Clicking an axis snaps the camera to it. It needs
`controls.enabled = false` on `pointerdown` over its corner rather than `stopPropagation` on `pointerup` —
swallowing the release means OrbitControls never learns the drag ended and the camera keeps orbiting with
the button up. A check forbids the `stopPropagation` form.

## Tests

Both pure suites run over the real models rather than fixtures, because a fixture built from an assumption
about a Stadium skeleton would agree with that assumption.

`test-pokemon-rig.mjs` asserts, among other things, that all 151 read; bone counts match the manifest;
every skeleton has exactly one root; the tree is acyclic and fully reachable; chains partition the
skeleton with every non-root bone in exactly one and none in two (the root is in none, on all 151);
**2,674,046 rotation keys all decode to unit quaternions**
(guarding the normalized-int16 trap); and that no model uses a `matrix` node, so rest TRS is never a lie.

`test-pokemon-annotation.mjs` asserts that the two selection gestures produce **identical** parts, that
copies are deep enough that an undo stack cannot mutate its own history, that the stamp moves for every
field that matters and not for the ones that do not, that states and transitions partition the segment list
with nothing falling outside, that stretching a pose's end frame changes what it is (the kind being derived
rather than stored), and that the schema holds on the five species the old mapper could not do — Sandslash,
Pikachu, Onix, Voltorb and Caterpie.

`test-pokemon-lab-io.mjs` carries two cross-checks worth more than its unit tests. The filename the page
saves to is matched against `serve.py`'s own whitelist regex, extracted from the Python source, because a
page that saves to a name the server rejects looks like it is working right up until you reload. And the
manifest's clip list is compared against the real `.glb` animations across the whole dex.

`_check_pokemon-lab.html.mjs` asserts against the page source what cannot be run in Node: that every id the
code reaches for exists and every id in the markup is read by something, that every imported name is
exported, that `localStorage` appears exactly once and only as the store's fallback, that every edit to the
library is followed by a save, and that a suggested idle is never written without a click.
