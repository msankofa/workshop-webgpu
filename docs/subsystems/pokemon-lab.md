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
| `pokemon-ik.js` | FABRIK, and which bones answer a drag. | shipped |
| `pokemon-hang.js` | A ragdoll from a rig, and particles back to bone rotations. | shipped |
| `pokemon-drive.js` | What moves each bone: the clip, nothing, or the ragdoll. | shipped |
| `pokemon-map-scope.js` | Which files count as this subsystem, and what imports what. | shipped |
| `test-pokemon-map-scope.mjs` | 103 checks, against the real repo listing. | shipped |
| `pokemon-lab.html` | The page. | browse, segments, picking, posing and annotating shipped |
| `test-pokemon-rig.mjs` | 38 checks, mostly over all 151 models. | shipped |
| `test-pokemon-annotation.mjs` | 65 checks, built against real rigs. | shipped |
| `test-pokemon-lab-io.mjs` | 30 checks, including two cross-checks. | shipped |
| `test-pokemon-pose.mjs` | 29 checks, four species. | shipped |
| `test-pokemon-select.mjs` | 25 checks, six species: the three gestures and the picking maths. | shipped |
| `test-pokemon-ik.mjs` | 38 checks: the solver as geometry, twist and bend, chains against real rigs. | shipped |
| `test-pokemon-hang.mjs` | 27 checks: the physics as physics, the rotation fit against known rotations. | shipped |
| `test-pokemon-drive.mjs` | 18 checks: the mask, its fit to real clips, and the partial ragdoll as physics. | shipped |
| `_check_pokemon-lab.html.mjs` | 98 static checks on the page. | shipped |
| `pokemon-gates.js` | Per-class validation. | not started |
| `pokemon-lab-runtime.js` | The `base-game.html` import contract. | shipped |
| `test-pokemon-lab-runtime.mjs` | 10 checks: the import path end to end, in Node. | shipped |

`ragdoll.js` is reused, and its 31 tests still pass untouched. Its cone solver gained an optional `min` and
an optional per-cone `stiffness` for the bend limit below; both default to the old behaviour, so the bot
ragdoll's five cones — which set neither — behave exactly as before.

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

### A box over several bones

**Alt-drag** draws a box and takes the joints inside it. Shift means the chain here too, so alt-shift-drag
takes the whole chain of anything the box catches, and both land in `toggleKeys` — the box completes a
group you had partly selected rather than flipping each bone, exactly as a click does.

`pointsInRect` in `pokemon-select.js` reads the **same projected points** the click does, so the box takes
what is inside it *in the picture*. Two consequences worth stating, because neither is what a volume test
would do:

- **Depth is ignored.** A bone the mesh is in front of is still caught. That is the promise the overlay
  already makes by drawing with depth testing off — you can see the joint, so the box takes it.
- **Bones behind the camera are skipped**, for the same reason `nearestPoint` skips them. `project` wraps
  the sign back there, so without the check a box drawn on the left of the picture would catch bones off
  to the right.

Corners come in either order, since a drag starts at whichever one the pointer went down on.

The drag is decided **before** a bone is picked, so alt is neither an orbit nor a grab, and `downAt` is
cleared so a box small enough to look like a click does not also toggle the bone under it. Tracking and
release are on the window rather than the canvas, so a box can be dragged past the edge of the viewport
and still work. Escape abandons one, and a cancelled pointer drops it, in both cases without touching the
selection.

Like the other two gestures it needs the skeleton visible — the dots are what you are aiming at.

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
nothing for a third of the dex. That measurement is why there are now two more ways to select: the
**Below** button, which takes a bone and everything under it through `descendants(rig, key)`, and the
alt-drag box above. A test pins the Onix numbers so the problem cannot quietly come back.

## Annotating: saying what each bone is

Phase 3. The schema and every edit to it are `pokemon-annotation.js`; the page is wiring, and every part
edit goes through one `editParts(fn)` so none of them can skip the history or the save.

**Selection first, then a button says what the selection is.** There is no mode in which clicking a bone
quietly edits a part, which is the same reason picking has no mode. Clicking a named part in the panel
puts its bones back in the selection, which closes the loop without inventing a second gesture: correct
the bones, press the button again.

`editParts` compares `annotationStamp` before and after and drops a no-op. Pressing Spine on the bones
that are already the spine is not an edit, and an undo stack full of those is one you cannot find
anything in.

### The vocabularies are the module's

Both class dropdowns and both limb dropdowns are built from `LOCOMOTION`, `POSTURES`, `APPENDAGE_TYPES`
and `SIDES` rather than from `<option>` lists in the markup, so the words the UI offers cannot drift from
the words the file accepts. A check forbids writing any of them out by hand.

Posture is offered only for a walker, because `setLocomotion` drops it for anything else — carrying a
stale posture would misreport the body plan.

### The overlay says three things at once

**Colour is which part.** Every named part has one, and every type the file can hold has an entry in
`PART_COLORS` — a check reads `APPENDAGE_TYPES` out of the module and fails if any of them has no colour,
because a limb somebody typed going back to looking unnamed is worse than never having coloured it. Green
and white are not in the palette: they belong to the selection and the hover, and a part that borrowed
either would be unreadable the moment you selected something. The two drive-mask colours are darker than
anything in the palette, so a masked limb still reads as masked on a fully annotated body.

The lookup is built when the annotation changes and read per frame, not resolved per bone per frame, and
it goes with the skeleton in `clearSkeleton` — bone keys repeat across species.

**Size is whether it stands on the ground.** A contact is normally a bone *inside* a limb, so giving it a
colour outright would mean the one bone whose limb you cannot see is the foot. It gets scale instead —
and a colour of its own **only where nothing else gave it one**, because a Caterpie's belly segment is in
no limb and would otherwise be the one part you named that still looked unnamed.

The button says **Foot**, which is what it is on most of the dex. The file still calls the list
`contacts`, because a Caterpie stands on belly segments and a Voltorb on one point of a sphere, and a
walker needs them wherever they are. Contacts follow the same complete-or-remove rule as every other
multi-bone gesture.

**A selected bone glows and flashes.** It swells, its colour runs to near-white, and a larger additive
sphere sits behind it — a bright dot on a dark viewport does not read as a glow on its own. The phase is
one `selectPulse()` shared by the swell, the colour and the halo, or the joints shimmer against each
other. It is a **triangle wave, not a sine**: the bright end of a sine is where it moves slowest, so a
sine reads as a dim joint that occasionally brightens rather than as a flash.

Unselected joints have their halo scaled to nothing rather than hidden, which would mean a second
visibility flag to keep in step with the skeleton toggle.

### Turning the model down

**Wireframe** and **Opacity**, both acting on the model's own materials. Under WebGPU `material.wireframe`
selects a line-list topology and the renderer builds the wireframe index buffer itself, so this is the
same one line it would be on WebGL rather than a second draw path.

Below full opacity the materials also stop **writing depth**. Without that, the near surface of a
see-through body still occludes the skeleton, which is the one thing you turned the model down to look at.

`transparent` is the property that decides how a material compiles, so it is the only one that takes a
`needsUpdate`, and it takes one **only when it actually flips** — asking on every slider tick would
recompile the whole model as you dragged.

The look is a page setting, not a fact about a species, so it never reaches the file. Because materials
are cached per species, it is re-applied on every load rather than only when a control moves; otherwise
the next species arrives solid while the button still reads Wireframe. A check pins both halves.

### A limb reads its own side

These models stand on y = 0 and **face +z**, so with y up the creature's own left is +x. That is a
documented fact about the export, not a guess, so `suggestSide` proposes L, R or C from where a limb's
mesh actually sits and the New limb button uses it. What is a judgement is how near the middle counts as
centre, which is why the deadband is a parameter and why the dropdown is right there.

The **type is not** guessed. Most of the dex is legs, but writing `leg` into a file as `author: "hand"`
records a decision nobody made, so a new limb starts as `other`.

### Copy to other side

`suggestMirror` matches on mirrored rest geometry rather than on the bone tree, because two mirrored
limbs are routinely built from different numbers of bones. The page excludes every bone already claimed
by another part, or a mirror could quietly steal the spine, and it reports what it could not match rather
than letting a partial answer look complete.

The pair itself goes through `declareMirror`, which is reciprocal by construction — a check forbids the
page assigning `.mirror` directly, since a one-way reference fails validation on somebody else's machine.
A Node test drives the whole gesture on three species and asserts the result validates, because composing
three correct calls wrongly is its own way to corrupt a file.

### What is unaddressed, and what is broken

The unaddressed list is **derived, never stored**. A stored to-do list goes stale the moment a part
changes, and the file would then carry a second answer to a question the parts already answer. An
unaddressed bone is decoration by default and that is a complete answer; the list exists so you can see
what you are defaulting.

`validateAnnotation`'s errors are printed under the limb list — a bone in two limbs, a limb that skips a
joint, a name no bone has. The module already knows what is broken; the page's only job is not to swallow
it.

The limb list is rebuilt on an edit, and hovering a bone is not one. Which limb the selection currently
**is**, and whether Assign can do anything, follow the selection through the cheap path instead — a rebuild
on every pointer move would throw away a dropdown mid-open.

## Posing: drag a bone, the chain above it answers

`pokemon-ik.js` is FABRIK — forward and backward reaching inverse kinematics. Positional and iterative, so
no Jacobians, no matrix inverses, and no configuration where it blows up. It solves joint **positions**;
`segmentRotations` turns the result into per-bone world-space rotations, and the page applies them
**top-down**, because a bone's local rotation is relative to a parent this pass has already moved.

Pure and free of THREE, so it is tested in Node against real rigs. Quaternions are `[x, y, z, w]` arrays,
matching THREE's order.

### How far up: one number, and the selection sets it

The slider is labelled **How far up** and reads out in bones, because the first version called it "Reach"
and the first person to see it asked what that meant.

Grab a bone whose ancestors are selected and that unbroken run is the chain. Grab one with nothing selected
above it and the slider decides. `selectedReach` returns 0 when the selection has nothing to say, which the
page reads as "fall back", so the two compose instead of competing and there is no mode — what you get is
whatever is visibly green in the viewport.

Zero means every ancestor up to the root. A bone with nothing above it is not a grab and the drag is
refused; Onix has a lot of those.

### Two scratch vectors, not one

`dragPoint` returns plain numbers rather than a reused `Vector3`. The first version returned the shared
scratch vector, and the next line read every bone's world position into that same vector — so the solver
was handed the grabbed bone's *current* position as its target, solved to where it already was, and
**dragging did nothing at all**. A check now requires `dragPoint` to return numbers and forbids `dragPose`
from reading `.x` off its target.

The bone objects are resolved once in `beginPose`, not looked up by name on every pointer move, and each
bone settles with `updateWorldMatrix(false, false)` rather than forcing its whole subtree — which on a
98-bone rig was the entire skeleton once per chain bone per event.

### Two solver properties worth knowing

**A straight chain aimed along its own axis cannot fold.** If the target is nearer than full extension,
both FABRIK passes only slide joints along that line and it settles fully extended — a fixed point that
more iterations do not escape. `breakCollinearity` bows the chain first, and the nudge is *sized*: a chain
of length `L` spanning a chord `d` has to bow out by about `L·√(1 − (d/L)²)`, tapered by a sine so it is
largest in the middle. Starting near the answer converges in a few passes where an arbitrary thousandth of
`L` still had 2% error after sixteen. It falls to zero as the chord approaches full extension, which is
also what stops a chain already on its target from being disturbed.

**Near full extension it converges slowly, and past 99.5% it stops improving.** Measured on a 4-segment
unit chain:

| Target (of reach 4) | 4 passes | 16 | 64 | 128 |
|---|---|---|---|---|
| 3.0 | 2.5e-4 | 4.6e-10 | — | — |
| 3.9 | 1.3e-2 | 2.8e-3 | 8.8e-6 | 4.3e-9 |
| 3.999 | 1.7e-4 | 1.7e-4 | 1.6e-4 | 1.4e-4 |

Ordinary targets are done in four to eight. The default is **64 iterations** because they are nearly free —
the loop exits on tolerance, and a 9-joint solve measures ~6µs either way. The residue at 99.98% of reach
is a property of the configuration, not of the iteration count, and at 1e-4 of chain length it is invisible.
A test records this so nobody spends an afternoon on it.

`tolerance` is **relative to chain length** by default. These models range from 9 to 320 units tall and one
absolute figure cannot serve both.

### Posing and playback cannot both own the bones

A running clip rewrites every animated bone each frame, so a pose would be erased on the next one. Turning
**Pose** on pauses playback and disables the transport, rather than letting a pose vanish silently. Turning
it off lets the clip take the bones back, which the panel says.

**Save as neutral pose** writes through `setNeutralBone` and the same `commit` path as everything else, so
it lands in the file, is undoable, and autosaves. It records **every bone, not only the ones that moved** —
a neutral pose is a whole stance, and storing only the edits would leave it depending on whichever clip
happened to be showing when it was taken.

### What is not handled

No joint limits, so nothing stops a neck bending backwards. One yaw per solve, so a chain cannot twist
about its own axis. And a solver assumes a bone points at its child, which is only true where the rig was
built that way — the models' bone origins are documented as not anatomical, so on some species a drag will
move something plausible-looking in an implausible way.

## Hanging: pick it up and let gravity have it

`pokemon-hang.js` builds a ragdoll out of a rig and steps it with **`ragdoll.js`**. That solver's core —
`stepRagdoll`, `integrate`, `solveConstraints`, `collideGround` — touches only `rd.particles` and
`rd.constraints` and knows nothing about humanoids; only its `createRagdoll` is welded to a 16-joint body.
So this builds the same shape of object from a Pokémon skeleton and inherits a Verlet solver that already
has 31 tests. No integrator or constraint kind was rewritten; the only change to that file is the two
optional cone fields described under the bend limit below.

Three constraint kinds, all derived from the skeleton with **no anatomy needed**:

| Kind | Between | Does |
|---|---|---|
| bone | parent and child, at its current length | stops stretching — on its own this is a rope |
| brace | bone and **grandparent**, at its current distance, soft | folding shortens that distance and the constraint pushes back |
| hinge | a two-sided angle range at the middle of every three-bone run | the bend limit — see below |

Braces are ordered **before** bones in the constraint list, because the solver runs it in order every
iteration and whatever comes last has the final say. Interleaved, the braces pulled bones 2.5% out of
length. Hinges are not in that list at all; they are cones, solved by angle rather than by distance.

`setStiffness` finds braces by a `kind` tag rather than by their current stiffness. Reading the value back
meant that setting the slider to exactly 1 made a brace indistinguishable from a bone link, and it never
moved again.

Everything is scaled to body height — gravity, joint radius, the zero-length brace threshold. These models
run from 9 to 320 units tall, so a constant tuned on one is wrong on most. `ragdoll.js`'s own default of 25
is for a 1.8-unit humanoid; `stepHang` takes a multiplier and does the scaling.

### Particles back to bone rotations

The piece that did not exist anywhere. A chain has one child per bone and one rotation that satisfies it; a
**body is a tree**, and a bone with seven children has no rotation putting all seven exactly where the
simulation did. The best available answer minimises squared error over all of them — Wahba's problem —
solved by iterative refinement (Müller et al., *A Robust Method to Extract the Rotational Part of
Deformations*, 2016) rather than an eigen decomposition. Two dozen lines, cannot return a reflection the
way a naive SVD can, and it warm-starts from the parent so the answer stays continuous frame to frame.

**Child directions are normalised.** One branching Squirtle bone has children from 2.2 to 13.8 units long;
un-normalised, the longest dictates the bone's orientation, *and* the correlation matrix is badly enough
conditioned that the refinement drops from quadratic to linear — 24 passes reached only 2e-3 where
normalised it reaches machine precision.

**A bone with fewer than three children spanning three dimensions leaves a rotation undetermined.** Turning
a one-child bone about its own length moves nothing; two children fix everything but the twist
perpendicular to both. The fit returns one of the family that minimises the error. Most bones in these rigs
have one child, so this is the common case, not a corner one — and it is why a test asserts the children
*land where the simulation put them* rather than asserting the original rotation is recovered.

**The root translates as well as turning.** A body carried by its head swings its hips a long way, and no
rotation can express that. Every other bone follows from its parent and its own fixed offset.

Bones are settled root-first via `boneOrder`, because **`rig.bones` is sorted by glTF node index** —
whatever the exporter wrote — which does not promise a parent before its child. A test asserts that
ordering on three species.

### Twist, which is the one angular limit that needs no anatomy

A cone limit has to know which joint is a knee. A **twist** limit does not: the axis is simply the direction
the bone points, so it works on any skeleton today.

It is also the one a positional solver cannot see. Turning a single-child bone about its own length moves
nothing — the child sits on the axis being turned about — so no arrangement of distance constraints can
resist it, and nothing would stop a forearm rotating like a drill. It has to be clamped where rotations are
handed back to the mesh, which is both places that do that: the drag and the hang, from one **Twist**
slider in degrees.

`swingTwist(q, axis)` splits a rotation into the part about the axis and the part across it, `q = swing *
twist`. `limitTwist` clamps the twist and leaves the swing exactly alone. `limitRelativeTwist` does it
**against the parent**, because a whole arm swinging as one is not a twisted elbow, and clamping against
the world would fight the shoulder every time the body turned. All three are in `pokemon-ik.js` and shared.

`twistAxis` takes the direction toward the bone's child, averaged over normalised directions where there is
more than one. Two symmetric children — a hip with a leg either side — average to nothing and have no
meaningful long axis, so it falls back to the direction from the parent, and skips the limit entirely if
that is degenerate too.

The IK drag needs this even though `rotationBetween` produces pure swing: each segment rotation is pure
swing *relative to the world*, so the turn of a bone against its parent can still come out as twist.
Clamped down the chain, parent first.

180° means no limit, and a check pins the slider's range there.

### Bend, the other half, and why it is enforced twice

**Bend** is rotation *across* the bone's axis — the joint opening and closing — and it is the complement of
twist in the same decomposition. One **Bend** slider, also in degrees, also measured against the parent and
against the pose the movement started from. `limitAngle` clamps a whole turn, `limitSwing` clamps only the
part across an axis, and `limitRelative` does both halves at once against a parent; a bone with no usable
long axis falls back to `limitAngle`, because there the whole turn *is* bend and there is no twist to name.

Unlike twist, bend **moves joints**, so the simulation can hold it — and has to, or the particles would fold
through the body while the drawn pose pretended otherwise. So it is enforced in two places with two
different strengths, and the difference is worth being plain about:

| Where | How | What it promises |
|---|---|---|
| On the way to the mesh, `boneRotations` | `limitRelative`, clamped outright | Exact. Nothing is ever *drawn* past the limit. |
| In the simulation, `ragdoll.js` cones | soft, relaxed per pass | A pull. Joints do pass the limit mid-swing and are drawn back. |

The physical half is a two-sided angle range on every three-bone run, seeded from the angle each joint
started at. That is `ragdoll.js`'s existing cone solver, which repositions the child on a cone at a fixed
radius and so changes an angle without touching either bone length. It gained an optional `min` (its five
built-in cones set only a max, since a knee may straighten all the way) and an optional per-cone
`stiffness`. Both default to the old behaviour, so the bot ragdoll is unchanged.

Two things were measured rather than assumed here, and both went against the obvious guess:

**Writing the limit as a distance does not work.** The law of cosines turns an angle at the middle joint
into a distance across it, which the existing brace could have carried for free. But `d(span)/d(theta)` is
`la·lb·sin(theta)/d`, which goes to **zero at π** — the span stops responding to the angle exactly where a
joint is straight. Spines and tails are straight, so the joints most in need of a limit were the ones it
could not see: a 10° limit left a joint bent 20°.

**Weaker correction passes settle better.** `BEND_RELAXATION` is 0.05, not 1. A body with a cone on every
joint has each bone as the child of one and the pivot of the next, and full projections fight both each
other and the length constraints that run after them. Measured on Squirtle at a 15° limit: at 0.25, six of
28 joints settled outside the limit with 4.2% stretch; at 0.05, two, with 1.6%. At 1 it diverged outright.
`probe_bend.mjs` re-derives the table.

Both limits measure from the **grab**, not from one pointer move. `dragPose` re-reads bone positions every
move, so the turn it computes is a single frame's worth; clamping that bounded how *fast* a bone could turn
rather than how far, and dragging slowly went wherever it liked. `beginPose` now records `pose.seedQ` and
`pose.seedPos`, and `limitChain` runs as its own pass afterwards, each bone measured against its parent's
already-corrected total.

### What it still cannot do

No limit knows which *way* a joint bends. A knee opening backwards is the same angle as a knee opening
forwards, so both are allowed; the bend limit stops a skeleton folding through itself, it does not make it
fold correctly. `ragdoll.js` can do better only because it knows which joint is a knee, and nothing here
knows that until the parts are annotated. Braces still resist **all** folding equally, so a hanging creature
reads as uniformly stiff — a neck resists exactly as much as a tail. That is the cost of having no
annotation yet, not a limit of the solver, and it is the strongest argument for phase 3.

Cones are skipped where either bone is shorter than a thousandth of body height. These rigs are full of
bones sitting on their parent — Pikachu has one 0.001 units long on a 22-unit body — and a cone built on one
reports wild angles that are pure direction noise. A whole measuring pass blamed the solver for violations
that were never real before this was found, so a test pins it on all three rigs.

Hanging, posing and playback all own the bones, so turning Hang on stops the other two and disables the
transport. `hang.sim` being non-null *is* the on state; a separate flag would be the same fact twice.

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

### Scrubbing is a convenience, not a limit

`play.frame` is fractional on purpose. The mixer interpolates between keys, so any position between two
frames is a real pose. The **Discrete / Continuous** button only changes the scrubber's step; on Continuous
the readout shows two decimals. Segment bounds are still whole frames, because that is what the file stores.

Its label *is* its state, the way the ghost mode and ghost pose buttons beside it already worked. It used to
read "Snap" and light up, which named neither state and made the reader guess which way the lit one meant.
A check asserts the label is the mode and that it does not also carry a lit class, since that would be the
same fact twice.

Stepping floors going forward and ceils going back, so a step from frame 12.6 lands on 13 rather than
skipping to 14.

### What moves each bone

A clip asserts a local transform for every bone it has a track for, every frame. That is fine until a
creature has to do two things at once. `pokemon-drive.js` gives each bone one of three answers:

| Mode | Driven by | What it looks like |
|---|---|---|
| **Animation** | the clip | the default, and what every bone did before this |
| **Posed** | nothing | keeps its local transform and rides its parent **rigidly** |
| **Limp** | the ragdoll | gravity, plus whatever the parent transmits |

**Posed is not the same as "no driving force", and that distinction is the whole reason there are three
modes rather than two.** A bone with no driver is not floppy, it is *welded*: it keeps its last local
transform and swings around rigidly with its parent. To hang and lag and settle it needs a solver — the
force just comes from gravity and the parent's motion instead of a keyframe. That is Limp.

The mask is stored by absence: `{}` means an ordinary animated body, so every loop can skip its work with
one `isPlain` check and nothing pays for a feature it is not using.

#### It needs no lookup layer, and that was measured

The design rests on a bone key and a THREE track's target being the same string. Across the whole dex:

| | |
|---|---|
| Tracks naming a bone their rig does not have | **0** of 54,503 |
| Species with two bones sharing a name | **0** of 151 |
| Bone names THREE rewrites on import | **0** |
| Non-bone nodes shadowing a bone's name | **0** |

So a mask is a set of the same keys selection, IK and the ragdoll already use. The first two are pinned by
tests over every file; the last two were measured once and are recorded here.

#### The frame, in order

Each step may only override what the one before it had no business owning:

1. `mixer.update(0)` — the clip writes every bone it has a track for.
2. `applyHeld()` — posed bones are put back over it.
3. `stepLimpFrame()` — the limp ones are simulated against the result.
4. `updateSkeleton()` — the overlay is built from what actually happened.

`applyFrame` repeats step 2, because scrubbing and stepping write a frame outside the loop and a posed bone
would otherwise snap back to the clip whenever you touched the scrubber.

Tracks are **not** filtered out of the clip. That would work — `suppressedTracks` exists for a caller that
wants it — but a filtered clip has to be rebuilt and re-timed on every change, where letting the mixer write
everything and putting a handful of bones back afterwards makes the mask live.

#### The partial ragdoll is the hanging one with the pinning inverted

Hanging pins the bone you grabbed and lets the body fall off it. This pins **everything the animation still
drives**, where the clip put it this frame, and lets the limp bones fall off that. Same solver, same
constraints, different set held fixed — `anchorIndices` is the only new idea, and a Node test asserts that
masking every bone limp reproduces the whole-body ragdoll to 1e-9.

Anchors are re-pinned every frame, since the animation moves them. Motion reaches a limp arm through the
constraints rather than through momentum, because `pinBone` sets a particle's previous position to its
current one; a test drives the anchors two body-heights sideways and asserts no limp bone is left behind.

A limp bone also keeps its **own local position**, not the clip's. These clips animate translation as well
as rotation, so otherwise a limp bone would keep sliding along its parent to the clip's tune while only its
angle came from the simulation — and its length would stop matching the constraint holding it.

The mask is re-seeded whenever it changes, from the pose on screen. Without that, a bone arriving at limp
would snap to wherever the body was when the species loaded.

#### Right-clicking a bone

The same three modes, at the bone. Two things it does that the panel cannot: it says what that bone is on
**right now**, and it offers the subtree without making you build a selection first.

It follows the convention every file manager uses. Right-click inside the selection and it acts on the
selection; right-click outside it and that bone *becomes* the selection first, so what is highlighted is
always what is about to change. A dot marks the mode every bone in the set is already on.

Both routes go through one `applyDrive(keys, mode)`. A menu that set the mask itself would be a second
place to forget the held transforms and the re-seed.

Right-clicking **nothing** is left to the browser, so the page does not steal a right-click it has no use
for. And dragging is now left-button only — without that, the same press that opened a bone's menu also
started carrying or posing that bone behind it.

Picking needs the skeleton visible, which it no longer is by default. That is deliberate rather than an
oversight: the dots are what you aim at, and right-clicking for the nearest of a set of invisible targets is
a worse gesture than turning the skeleton on first.

#### Selecting a limb

A limb is a bone and everything under it, which is why the **Below** button exists: chains stop where the
skeleton branches, and 2,136 of 3,496 chains in this dex are a single bone, so the chain gesture cannot
select an arm. Below and the alt-drag box are the two selection gestures the phase 2 notes said were
missing; Below is structural and the box is whatever you can see.

Masked bones are **coloured in the overlay** — deep blue for posed, deep red for limp, both darker than
any part colour so a mask still reads on an annotated body. A mask you cannot see is one
you find out about by wondering why half the body stopped moving.

#### Not saved

The mask lives on the page and dies with the species. Whether "this tail is always limp" is a fact about a
species worth keeping in the annotation file is a schema decision, and it has not been made.

### Explanation lives on hover, and the panel stays controls

The panel had nine paragraphs of prose in it. Prose in a panel is read once and then in the way forever,
and it pushes the controls that matter off the bottom of the scroll. All of it moved to hover text:

| | Where | Length |
|---|---|---|
| `data-tip` | Every control. What it does. | One sentence. Capped at 22 words by a check. |
| `data-more` | Twelve of them. Shown while **Ctrl** is held. | Capped at 45 words. Anything longer belongs here in the docs. |

A `data-more` earns its place only where *what a control does* and *how far to trust it* are different
questions — the bend limit being exact while dragging but a pull while hanging is the clearest case. The
tooltip advertises itself with a dim "Ctrl for more" line, because a hidden affordance nobody is told about
does not exist.

It is one mechanism, not two. The browser's own `title` is gone from both the markup and the script: it
cannot show two lengths, its delay is not settable, and having both would mean two tooltips racing on one
control. Checks assert zero `title=` in the markup **and** zero `.title =` in the script — the first version
only read the markup, and nine script-set titles sailed through it.

The tooltip is a plain script rather than part of the module. It needs no THREE, and the page is far more
debuggable if its labels still explain themselves when the module has failed to load.

### Two histories, and one key press between them

There are **two undo stacks**, and they are separate on purpose:

| | Holds | Lifetime | Where |
|---|---|---|---|
| `history` | the annotation library | outlives the species its entries were made on | Undo / Redo, under Saved segments |
| `bodyHistory` | bone transforms, the drive mask, held poses | dies with the species | Undo / Reset, at the top of Pose |

Merging them would mean offering to undo a pose onto a different skeleton, since a library entry is still
meaningful after you have moved on and a pose is not. So the body history is cleared with the species it
names.

Keeping them apart leaves one problem: **Ctrl+Z has to mean "undo what I just did"**, whichever kind that
was. Both stacks share one counter, `editSeq`, and every entry records when it was made; `undoNewest`
compares the two tops and takes back the later. No mode, no guessing at intent.

Snapshots are taken **before** an edit, one per drag rather than one per pointer move, so undo steps back by
something a person did rather than by a frame. The snapshot is taken on the press and only once `beginPose`
reports the grab took, so a press that grabbed nothing leaves nothing to step through — `beginPose` only
works out which bones will answer, and nothing has moved yet.

Turning the ragdoll **off** is restored by undo; turning it back on is not. A running simulation has no
state worth returning to — it would fall somewhere else immediately — so undo puts the body back and leaves
it stopped.

**Reset** puts the animation back in charge of every bone: no mask, nothing held, ragdoll off. It touches
nothing in the file — segments and the neutral pose survive it — and it pushes a snapshot first, so it is
undoable like any other edit rather than a way to lose an afternoon. It ends by re-applying the current
frame rather than leaving the file's rest pose on screen, because "the animation drives every bone again"
should not look like the clip was thrown away too.

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

## Sound: the Stadium soundtrack, and the cries

The page reuses `environment-audio.js` — the shared controller every viewer plays music and SFX through —
rather than growing its own Web Audio code. It is created with `getPlayerPosition: () => controls.target`,
so every speaker behavior that is written against "the player" is in fact written against the point the
camera orbits, which is where the creature stands. `envAudio.update()` runs once per frame so the Web
Audio listener follows the orbiting camera.

**Music** is the ripped Stadium soundtrack in `pokemon/Stadium Music/`, listed by `serve.py`'s
`GET /api/list-pokemon-music` and fed to `loadMusicHttp` with that listing and base URL — the stock HTTP
playlist path, pointed at a different folder. The panel's Music section is transport (previous, play or
pause, next, shuffle), a track dropdown, a seek bar, and the music volume, all synced from
`subscribe()`/`getState()`. Nothing plays until the play button; the controller is created with
`autoplayOnGesture: false`.

The output select is the controller's own global-versus-speaker choice. The speaker is the orb from the
other viewers (scaled to 0.6 here), and the behavior select carries the four follow behaviors plus one
added for this page: **`fixed`** ("Where you put it"), which holds a world position instead of following
anything. Dragging the orb in the scene — a capture-phase `pointerdown` on the stage, so a grab never
also orbits the camera or picks a bone — moves it on the camera-facing plane through it via
`setMusicSpeakerPosition`, which also switches the behavior to `fixed`. `getMusicSpeakerObject` exists so
the page can raycast the orb; the orb is a real mesh, which is why the "no raycasts outside dragPoint"
check names `speakerOrbHit`/`speakerDragPoint` as the other allowed homes.

**Cries** are `pokemon/poke_cries/`, one file per species, listed by `GET /api/list-pokemon-cries` and
matched **by the three-digit dex prefix**, never by name — the files spell names their own way
(`Farfetchd`, `Mr-Mime`). The Play cry button fetches and decodes the buffer once per species (a failed
load is retried, not cached), then plays it through the controller's newly exported `playBufferAt` — the
same panner chain positional SFX use — at the annotated head's position, or the mean of all bone
positions when no head has been annotated. **Every audio distance is scaled to the species**: the models
are 9 to 147 units tall (median 52, measured across the dex) and the camera frames at about 2.4 spans,
while the controller's numbers and the cry's panner profile were written for metres — the first cut had
the orb placed inside the creature and the cry inaudible past the skin. `syncAudioScale()` calls
`envAudio.setWorldScale(span / 1.8)` on every species load, and the cry's `refDistance`/`maxDistance`
are `2 × span` / `100 × span`. **Cry variation** is four controls and a draw: pitch (±12 semitones), speed (25–400%), a Reversed toggle
and a Variation amount. A press takes the sliders' values, wanders from them by up to ±12 semitones and
half-to-double speed scaled by Variation, and plays through `playBufferAt` with `playbackRate` for speed
and `pitchRatio` for pitch (the controller's worklet keeps them independent). Reversed is a per-species
`AudioBuffer` built once by copying the samples backwards. What a press actually used is written next to
the button. Beyond those: **bass** (a ±24 dB shelf under 180 Hz — meant to be derived from body size or
age one day, with the slider still winning), **vibrato** (an LFO into the source's `detune`, rate and
semitone depth), **tremolo** (an LFO into a gain, rate and depth), **fade** (attack and release ramps timed
to the slice), **stutter** (the opening slice of the trimmed cry N times back to back, then the whole
cry, all delayed in played seconds so it follows the speed) and **trim** (start and end percent). The
effects are built by `cryChain` through `playBufferAt`'s `insert` hook, per slice; echo and reverb were
deliberately left out as environment effects rather than personality. Not saved per species yet; the
annotation file has no field for it. The Music section's
Falloff slider is the controller's `attenuation` effect
(0–200, started at 40 here). Both listings retry on demand — a press with an empty cry
map re-fetches, as does play with an empty playlist — so a page loaded before a server restart heals
without a reload. The Cry section's volume row is the shared SFX volume (the per-origin saved settings
every viewer reads), and moving it also unmutes SFX and master: a mute saved by another tool would
otherwise silence cries with nothing on this page saying so, and the click handler says as much when it
plays into a muted mixer. Bones, not the mesh bounding box, because the mesh bounding
volumes on these models are garbage (vertices are authored bone-local). Orbiting the camera pans and
attenuates the cry.

## `pokemon-lab-runtime.js` — the seam a game reads through

The whole contract between the annotation work and anything that moves a creature, and the thinnest file
in the subsystem — thin because `pokemon-rig.js` already measures the model and `pokemon-annotation.js`
already knows how to turn bone names into node ids. This adds the loading and nothing else.

```js
import { loadLab, rigFor, applyNeutral } from './pokemon-lab-runtime.js';

const lab = await loadLab(fetch);                 // one static JSON
const out = rigFor(lab, '025_pikachu', gltfBytes);
// out.locomotion, out.root, out.spine, out.contacts, out.appendages, out.segments, out.facts
applyNeutral(out, (node, trs) => place(node, trs));
```

Three rules, and they are the reason this file exists rather than a game importing the lab directly:

- **No `serve.py`.** The lab is fetched as a plain static JSON. A game that needed the workshop's Python
  server running would not ship.
- **No lab UI.** Nothing here imports `disk-store.js` or the page.
- **No THREE.** It hands back glTF **node ids** and lets the caller drive its own scene graph. Returning
  Object3Ds would pick the caller's renderer for them; node ids resolve equally well through
  `gltf.parser.associations` or a raw glTF walk. The neutral pose reaches a scene graph through a
  `set(node, trs)` callback, which is what keeps THREE out.

A test asserts the import list is exactly those two pure modules, so the rules cannot erode.

### What it is tolerant about, and what it is not

**Loading throws.** A 404 or a file from a future version is an error, because a game that silently
renders unannotated creatures is one where nobody notices for a week.

**Everything after loading is tolerant.** An unannotated species comes back in the same *shape* with
empty parts rather than as `null`, so a caller never branches on whether the file happened to mention it
— `annotated` says which it was. A model re-exported since the annotation was made sets `staleRig` and
still hands back what it has: only the caller knows whether a creature standing wrong is worse than no
creature at all.

`missingParts(resolved)` lists which of the five things are empty. It is **not a gate** — it applies no
per-class rule. That a walker has no legs is a fact a caller can act on; whether that makes the
annotation wrong is `pokemon-gates.js`'s question.

`rigFor` takes either the GLB bytes or a rig already read from them, since a game that has loaded the
model anyway should not pay to parse it twice. A test drives both routes and asserts they agree.

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

`test-pokemon-select.mjs` covers the three gestures over real rigs, and pins the picking maths a browser
would otherwise be the only place to see: that depth only breaks ties for a click, that a box takes what is
inside it whichever corner the drag started at and ignores depth entirely, that bones behind the camera are
excluded from both, and that a box composed with `toggleKeys` completes a partial group and drops a whole
one — the composition being the thing the page actually does.

`test-pokemon-lab-io.mjs` carries two cross-checks worth more than its unit tests. The filename the page
saves to is matched against `serve.py`'s own whitelist regex, extracted from the Python source, because a
page that saves to a name the server rejects looks like it is working right up until you reload. And the
manifest's clip list is compared against the real `.glb` animations across the whole dex.

`_check_pokemon-lab.html.mjs` asserts against the page source what cannot be run in Node: that every id the
code reaches for exists and every id in the markup is read by something, that every imported name is
exported, that `localStorage` appears exactly once and only as the store's fallback, that every edit to the
library is followed by a save, and that a suggested idle is never written without a click.

One of its checks is there because the selection box shipped invisible. Assigning `style.display = ''`
**removes** the inline style, so an element the stylesheet hides stays hidden while the code reads as
though it works — right for `#stageMsg`, whose stylesheet value is `flex`, and wrong for the four ids
hidden by default. The check reads the stylesheet for those ids and forbids showing them with `''`.

## The panel

The Lab dresses its panel with **`workshop-panel-theme.js`**, the same module the bot viewer, base game,
aircraft studio and code map use. It re-scopes the environment viewer's inspector rules to any panel root
and reads the palette that viewer's Theme tab saves to `pcw:uiTheme`, so a theme picked there carries
here. Nothing about the panel's look is written in this page.

Layout is the established one: a fixed right-edge `#ctrl` with a `.panel-head` (title, `.hint`, and the
`⌄` / `⌃` / `–` head buttons), a `.panel-tabs` strip, and a `.panel-body` scroller holding one
`.tab-host` per tab. Sections are `createSection()` cards; expand-all and collapse-all go through
`setAllSectionsCollapsed()` scoped to the **active tab**, because opening everything would blow open six
tabs nobody is looking at. Collapsing the panel is the theme's own `.collapsed`, which shrinks the dock to
its header bar and frees the whole viewport.

Seven tabs: Dex, Species, Annotate, Pose, Animation, Audio, Map.

### The markup stays flat; the panel is assembled at boot

The controls are written in the page as two plain `<aside>` blocks separated by `<h3>` headings, because
that is far easier to read and to diff than three thousand lines of `createElement`. `buildSections()`
takes each heading and everything up to the next heading and **moves those nodes** into a section under
its tab. Nothing is recreated, so every `$('id')` in the rest of the file still finds the element it
always found, and the heading is kept (hidden) so its text stays the section's name.

`SECTION_PLAN` is keyed on heading text rather than on order or index. A heading renamed in the markup is
reported rather than silently landing its controls on the wrong tab, and a check asserts the plan and the
markup name exactly the same set.

## The Map tab

`tools/filesystem-map.html` with `?scope=pokemon`, in an iframe. That page already draws a filesystem the
way we want one drawn — force-directed hubs, bloom, depth of field, the growth timeline, the filter
panels — so the tab embeds it rather than reimplementing any of it.

The scope parameter is read before anything is built from the scan, so every panel, filter and count in
the page is about this subsystem and nothing else in it needed changing. Without the parameter the tool
behaves exactly as it always did.

Being a separate document is the point: it brings its own renderer and its own `OrbitControls`, so there
is nothing to share, disable or fight over. The Lab's render loop returns early while the map is up. The
iframe is created on first click and hidden rather than removed, so coming back does not re-scan the repo
and re-settle the layout.

### Show the frame before loading it

The map sizes its renderer from its own `window.innerWidth` at boot. An iframe that is still
`display: none` reports zero, and WebGPU does not refuse a zero-width surface politely — it creates an
invalid `depthBuffer` and `colorBuffer`, and then every render pass built on them fails, once a frame,
until the device stops reporting. So the tab shows the frame first and waits one `requestAnimationFrame`
before setting `src`.

The tool clamps its own size too, through `viewW()`/`viewH()` at both the boot sizing and `onResize`,
because being embedded means it can legitimately be in a frame that is not laid out yet — and the same
clamp covers the resize the iframe fires when the tab is switched away and it goes `display: none`.

### Scope is rules, not a list

`pokemon-map-scope.js` decides membership with patterns rather than filenames, because the list goes stale
faster than anyone updates it — the Lab gained five modules in a single night. A rule picks up
`pokemon-gates.js` the day it is written. It is the only thing this subsystem added; the drawing is all
the tool's.

Six groups. `lab`, `docs`, `data` and `borrowed` are on; **`moves` and `old` are off and toggle on**,
because they are neighbours rather than parts — nothing imports either one today. All six are built into
the graph and the toggles filter it live, using the same mechanism as the extension checkboxes, so a
click costs nothing.

**Group is a role, path is a fact, and the path wins.** The moves tests physically live in
`pokemon-park-old/`, so they are drawn inside the archive. Grouping by location keeps the toggles
predictable — turning off `old` empties that cluster and nothing else.

`models/stadium` collapses to one node. Expanded it is 151 model files against twenty code files and would
be the whole picture. Its label counts extensions rather than assuming, because the directory holds 151
models **and** the manifest, and "152 models" would be wrong in a way nobody would check.

Measured: 9,915 entries in the repo scan, 100 after scoping, across ten directories.

### The import edges

Hand-written, because they are facts about the code that no directory listing knows.
`test-pokemon-map-scope.mjs` reads every one back out of the source and checks the other direction too, so
an import the page gains cannot go undrawn. It has earned itself twice: it caught `environment-audio.js`
becoming a page dependency, and it caught a set of edges pointing at modules that no longer existed.

### What it shows that the table does not

`pokemon-pose.js` floats unconnected — written, tested, imported by nothing. And `tools/filesystem-map.html`
sits in `borrowed` rather than `lab`: the map draws the page that draws it, which is a fair description of
the arrangement.
