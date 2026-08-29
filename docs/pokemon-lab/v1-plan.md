# Pokémon Lab v1 — the tarmac

**Status:** authored 2026-08-27. Phases 0, 1 and 1.5 shipped 2026-08-28; phases 2 and 3 shipped
2026-08-29. Phases 4 to 6 are not started. See the build-order table at the bottom.

v1 is the surface everything else lands on: browse all 151 Stadium models, watch the animations that
shipped with them, read the skeleton, say what every part of it is, set the pose it stands in, and save
that to one file. **No locomotion.** Movement is v2, moves are v3, and both are readers of the file v1
produces.

The auto-mapper is deliberately not designed here. It is a plane; this is the tarmac. What v1 owes it is
a prepared surface — a place to put a suggestion, a way to show its reasoning, and a record of which
parts a human accepted — so that when it lands it does not require the file format to change.

## What "the mapper is a black box" actually means

`stadium-rig-map.js` is well commented. Its problem is not that the algorithm is undocumented, it is
that **the algorithm's reasoning does not survive to runtime**. It emits an answer and a flat list of
warning strings. You cannot see, for a given species:

- which chains it considered and which rule rejected each one,
- how close a rejected chain came to the threshold that rejected it,
- which pairing it chose and what the runner-up was,
- why the knee landed where it did.

The comments explain the *algorithm*. Nothing explains *this Pokémon*. That is the black box, and it is
what makes disagreeing with it feel like arguing with weather.

The v1 fix is structural and cheap: **separate facts from guesses into different modules.** Today they
are fused in one function, which is why a guess is indistinguishable from a measurement in the output.

## Measured ground truth

Everything below was measured across all 151 models, not assumed.

| Fact | Number | Why it matters |
|---|---|---|
| Pivot bones, whole dex | **6,459** | The upper bound on hand annotation, if done per bone. |
| Pivot bones per species | 10 / **42** / 98 (min/median/max) | Magikarp-sized rigs and Sandslash-sized rigs need the same UI. |
| Chains (branch point to leaf) | 3,496 — median 21/species | Chains are cheaper than bones but still too many to annotate. |
| Chains carrying >2% of the mesh | **1,772 — median 11/species** | The real size of the job. This is the number to attack. |
| Bones any clip animates | 5,649 of 6,459 (**87%**) | "Ignore bones that never move" saves 13%. Not a shortcut. |
| Species with `idle`, `attack`, `entrance`, `faint` | **151 of 151** | Every species has a guaranteed idle to take a neutral pose from. |
| Clips per species | median 7, max 21 | The browse view needs a list, not four buttons. |
| Skeletons with more than one root | **0 of 151** | Simplifies everything. Assert it; don't handle the case. |
| Bone naming | all `boneNN` | Readable, diffable keys — almost. |
| Species with a **duplicated** bone name | **3** — Charmander, Charizard, Magmar (one collision each) | Names alone are not a safe key. See below. |
| Species whose lowest vertex is >5% of body height off y=0 | **32** | Not broken models. See below. |
| Evolution families sharing a rig | **none** | Bulbasaur 30 bones, Ivysaur 46, Venusaur 60. No propagation shortcut exists. |

Current mapper, scored over the dex with `auditMapping`:

| Outcome | Count |
|---|---|
| Legs found, no audit errors | 81 |
| Legs found, audit errors | 35 |
| No legs found | 35 |
| Threw | 0 |

And the annotation gap it leaves: **the median species has 65% of its bones in no named part at all**
(min 25%, max 95%). Those bones are not wrong, they are simply unaddressed — which is the hole v1 fills.

### y = 0 is not the floor, and that is useful

The existing docs say "models stand on y = 0". Measured across the dex, **32 do not** — by as much as
303% of body height (Zubat) above it and 79% below (Tentacruel). The old mapper treated that as a warning
about a broken model.

It is not a defect. The 32 are:

> butterfree, beedrill, spearow, fearow, zubat, venomoth, abra, weepinbell, victreebel, tentacool,
> tentacruel, geodude, magnemite, magneton, dewgong, cloyster, gastly, haunter, koffing, weezing, horsea,
> seadra, goldeen, seaking, magikarp, gyarados, lapras, porygon, aerodactyl, articuno, zapdos, mew

Which is, almost exactly, every flyer, floater and swimmer in the first 151. **y = 0 is the battle
platform anchor, not the ground**, and a species that does not stand on the ground was authored away from
it. (The list is measured; reading it as the platform anchor is inference.)

Two consequences. The offset is a strong prior for the locomotion classifier — worth surfacing in the UI
as a hint rather than a warning. And `neutral.ground` must be **class-dependent**: dropping a Gastly onto
the floor would be actively wrong, so grounding defaults on for a walker and off for anything that does
not touch the ground.

### The thing that would have corrupted the file

Charmander, Charizard and Magmar each contain **two different bones with the same name**. Keying an
annotation file on bone names alone would silently attach a role to the wrong bone on three species, and
nothing downstream would notice. v1 keys on names (readable, diffable, stable across a reload) but
**detects the collision at load and refuses**, falling back to an explicit `boneNN#2` form for those
three. A test asserts the collision set stays exactly those three, so a re-extraction that changes it
fails loudly.

## The core inversion

Three ideas, in order of how much they matter.

**1. Facts and guesses live in different modules.** `pokemon-rig.js` measures — the pivot tree, per-bone
vertex clusters, chains, clip channels, rest matrices. It contains no heuristics and cannot be wrong
about anything except by being buggy. Guessing lives somewhere else entirely and is always optional.

**2. The annotation is the truth; a suggestion is a draft.** Today the mapper is authoritative and hand
roles are a correction layer patched over it, which is why a pose can silently delete a leg. In v1
nothing re-derives structure at load time. What was annotated is what every reader gets, forever.

**3. Unannotated means decoration.** You do not annotate 42 bones. You annotate the root, the spine, the
head, the appendages that matter, and the ground contacts — median about 11 things. Every bone you did
not mention inherits its parent and carries no semantics, which for a Sandslash spike is not a
compromise, it is the correct answer. This is what makes the job finite: roughly 1,800 decisions across
the dex before mirroring, closer to 1,100 after.

## The data model

One file, `stadium-saves/pokemon-lab.json`. Bone **names** as keys throughout.

```jsonc
{
  "version": 1,
  "species": {
    "025_pikachu": {
      "dex": 25, "file": "025_pikachu.glb",
      "rigHash": "a3f1…",          // topology fingerprint; a re-export invalidates loudly

      "locomotion": "walker",       // the class. drives which gates apply.
      "posture": "biped",           // walkers only: biped | quadruped | hexapod | …

      "parts": {
        "root": "bone00",
        "spine": ["bone01", "bone02", "bone03"],        // ordered, hip end first
        "head":  { "chain": ["bone12", "bone13"] },
        "appendages": [
          { "id": "legFL", "type": "leg", "side": "L", "row": 0,
            "chain": ["bone20", "bone21", "bone22"],
            "contact": ["bone22"],
            "mirror": "legFR",
            "author": "hand" }
        ],
        "contacts": ["bone22", "bone26"]                // every bone that touches the ground
      },

      "neutral": {
        "bones": { "bone20": { "q": [0,0,0,1], "p": [0,0,0], "s": [1,1,1] } },
        "ground": true,
        "source": "idle@0.32"        // provenance: which clip and frame it was lifted from
      },

      // Named slices of the ROM clips. `to: null` is the last frame; `from` after `to` plays backwards.
      "segments": {
        "idle":        { "clip": 0, "from": 0, "to": null, "ends": "loop" },
        "enter_shell": { "clip": 7, "from": 0, "to": 8,    "ends": "hold" },
        "in_shell":    { "clip": 7, "from": 8, "to": 51,   "ends": "loop" },
        "exit_shell":  { "clip": 7, "from": 8, "to": 0,    "ends": "hold" }
      },

      "done": false,          // set BY HAND. the gates only ever suggest it.
      "notes": ""
    }
  }
}
```

Design calls worth stating:

- **A part stores a bone list, never a chain reference.** `chain` is an ordered array of bone names and
  nothing else. This is what lets chain-picking and bone-picking coexist without a consistency problem:
  there is one representation and two ways to build it. Storing "chain 7 of the skeleton" would mean
  hand-editing a single bone either corrupts the reference or forces a mode switch, and both are worse
  than an array.
- **Appendage `type`** is an open vocabulary: `leg`, `wing`, `fin`, `arm`, `tail`, `tentacle`, `ear`,
  `antenna`, `other`. A type is a hint to a v2 solver, not a constraint v1 enforces.
- **`contacts` is a first-class list**, not something derived from legs. Caterpie's contacts are belly
  segments; Voltorb's is one point on a sphere; Onix's are several body segments. None of those are feet
  and all of them are what a v2 walker needs.
- **`mirror` is a declared pair**, not a computed one. Computing symmetry is a guess; declaring it is a
  fact, and it is what halves the annotation work.
- **`neutral` records where it came from.** "This pose is frame 0.32 of the idle clip" is the difference
  between a pose you can re-derive and a pile of quaternions.
- **`author` per appendage** (`hand` | `suggested` | `accepted`) so that when the mapper lands you can
  always separate what a person decided from what a machine proposed and nobody checked.

### Locomotion classes

`walker`, `flyer`, `swimmer`, `hopper`, `serpent`, `roller`, `floater`, `burrower`, `static`.

The 35 species where the current mapper finds no legs are **not failures to fix**. Voltorb is a roller,
Gastly is a floater, Onix is a serpent, Diglett is a burrower. Reclassifying them is most of the fix.

## Modules

All pure except the page. All Node-testable.

| File | Job | Rough size |
|---|---|---|
| `pokemon-rig.js` | Facts only: pivot tree, per-bone vertex clusters, chains, clip channels, rest matrices, rig hash. No heuristics. | ~250 lines |
| `pokemon-annotation.js` | The schema: create, validate, mirror an appendage, resolve names to node ids, apply defaults. | ~300 lines |
| `pokemon-gates.js` | Per-class validation. Returns findings, never throws. | ~200 lines |
| `pokemon-lab-io.js` | Load/save the one JSON through `disk-store.js`; migration hook. | ~120 lines |
| `pokemon-lab-runtime.js` | **The base-game contract.** No DOM, no lab UI. | ~150 lines |
| `pokemon-lab.html` | The page. | the bulk |

Reused unchanged: `stadium-glb.js` (its GLB facts are verified and hard-won), `disk-store.js`,
`serve.py` (one new filename in the stadium whitelist).

Deliberately **not** reused: `stadium-rig-map.js`. Its topology half is worth porting into
`pokemon-rig.js`; its heuristic half is v2's problem.

Nothing existing is deleted. `stadium-walker-v2.html` keeps working off its own files.

## The page

Four modes, freely switchable — not gated stages. The staging in stadium-walker-v2 was right in spirit
and wrong in practice, because a gate you cannot cross is indistinguishable from a bug.

**Browse.** The 151 grid, which is the structure that worked. Tiles show dex number, name, and status
colour (untouched / classified / annotated / posed / passing). Select one and it loads. A clip list from
the manifest's own labels, with play, loop and a scrubber.

**Annotate.** Skeleton on. Pick bones, give them a part. **Two selection gestures, not two modes:**
clicking a bone adds or removes that one bone; clicking a chain adds or removes all of its bones at once.
Both write to the same bone list, so you can rough a part in with one chain click and then correct it
bone by bone without switching anything.

The chain gesture exists because median 11 significant chains beats median 42 bones and it is how most
of the dex gets done quickly. The bone gesture exists because the chain decomposition is itself a
structural guess — `extractChains` splits at every branch point, so a mane tuft hanging off a thigh cuts
one leg into three chains — and when it splits a limb wrongly, per-bone editing is the only thing that
can say so. Neither is a fallback for the other.

Mirror button: annotate one side, declare the pair, done. A running "what is still unaddressed" list so
you know when a species is finished.

**Pose.** Scrub any clip to a frame, take it as neutral, then adjust per bone. This is the one piece
proven to work already — `stadium-stance.js` does exactly this and its mirror maths is worth porting
wholesale.

**Review.** Gate results for this species, the whole-dex progress board, and the export preview.

## Gates

Per class, checked against the annotation rather than a mapper's output.

**The gates never set `done`.** They suggest it. When every gate passes on a species that is not marked,
the page offers it — "nothing here is failing, mark it done?" — and you take it or leave it. You can
also mark a species done while gates are still failing, because you may know something the gates do not,
and the board then shows *"done, 2 findings"* rather than hiding either fact.

So the dex board carries two independent signals, not one status:

| Board state | Meaning |
|---|---|
| untouched | no annotation yet |
| in progress | annotated, gates still failing |
| ready | gates all pass, not marked done — the suggestion state |
| done | marked by hand, gates pass |
| done, *n* findings | marked by hand over failing gates — deliberate, and visible |

The distinction matters because a purely derived flag would mean the gates decide when the dex is
finished, and the gates are only a proxy for correctness. A species can satisfy every geometric check
and still be annotated wrongly.

| Class | Must hold |
|---|---|
| every class | a root exists; no bone in two appendages; every `mirror` is reciprocal; neutral pose names only real bones |
| walker | ≥2 contacts; contacts within 12% of body height of the floor; every leg chain unbroken parent-to-child; rows paired |
| flyer | ≥2 appendages typed `wing`, mirrored |
| swimmer | ≥1 `fin` or a spine of ≥4 |
| serpent | spine ≥4, no `leg` appendages |
| roller / static | ≥1 contact, no legs required |
| floater | no contacts required — and a gate that *fails* if contacts are declared |

## The base-game contract

`base-game.html` currently has **no creature system at all** — it is a traversal lab with players,
weapons, drones, terrain and water. So "directly importable" means the contract must stand alone:

```js
import { loadLab, rigFor } from './pokemon-lab-runtime.js';

const lab = await loadLab(fetch);                 // one JSON
const rig = rigFor(lab, '025_pikachu', gltf);     // resolves names, applies neutral pose
// rig.locomotion, rig.contacts, rig.appendages, rig.spine, rig.root
```

Rules: no `serve.py` dependency (plain fetch of a static JSON), no lab UI imports, no THREE in the
resolution layer — it hands back node ids and lets the caller drive its own scene graph. Node-testable
end to end, which means a test can assert base-game's import path works without a browser.

## The seam the mapper lands on

Built in v1, empty until v2:

```js
suggest(rig) -> { parts, confidence, trace }
```

`trace` is an array of decision records — rule, candidates, scores, threshold, outcome — and the Annotate
mode renders whatever it is given. Three small things now mean the plane does not have to rebuild the
runway later:

1. the `author` field per appendage,
2. an accept / accept-one / reject affordance in the UI,
3. a panel that renders a trace.

## Build order

Each phase ends somewhere usable.

| Phase | Delivers | Character | State |
|---|---|---|---|
| 0 | `pokemon-rig.js` + `pokemon-annotation.js` + tests, no UI | mechanical — porting verified code | shipped 2026-08-28 |
| 1 | Browse: the 151 grid, model loading, clip playback | mechanical | shipped 2026-08-28 |
| 1.5 | Segments: naming a frame range of a ROM clip | mechanical, but it changed the schema | shipped 2026-08-28 |
| 2 | Skeleton view, chain and bone selection | mostly mechanical; the picker exists | shipped 2026-08-29 |
| 3 | Annotate: parts, types, mirror, the unaddressed list, both selection gestures | **the uncertain one** — this is the whole UX bet | shipped 2026-08-29 |
| 4 | Pose: clip frame to neutral, per-bone adjust | mechanical — port `stadium-stance.js` | not started |
| 5 | Gates + dex board status | mechanical | not started |
| 6 | `pokemon-lab-runtime.js` + a Node test proving base-game's import path | mechanical | not started |

Phase 1 pulled `pokemon-lab-io.js` forward from its unnumbered place in the module table, because browse
mode records which clip is the idle and that is authored work: it has to reach a file from the first
version of the page rather than be retrofitted onto one that kept it in web storage.

**Phase 2 found a hole in phase 3's bet.** The chain gesture is justified above by "median 11 significant
chains beats median 42 bones", which is true as a count of things to *name*. But chains are mostly one
bone long — **2,136 of 3,496 are a single bone, and the median chain length is 1**. Onix is 40 bones in 39
chains, so clicking chains there is clicking bones; Sandslash's longest chain is 3. The gesture pays off on
Squirtle (6) and Ekans (23) and does nothing for a large part of the dex.

Phase 3 will most likely need a **third gesture: select a bone and everything below it**, which
`descendants(rig, key)` already supports and which is the one that actually collapses a rig like Onix's.
It is not built, because the plan says two gestures. A test in `test-pokemon-select.mjs` pins the Onix
numbers so the problem cannot quietly disappear.

**Phase 1.5 was not in the original plan.** It came out of noticing that the ROM clips are compound
performances — Squirtle's withdraw is eight frames of pulling in and forty-four of sitting in the shell,
inside a clip the game only ever played as a move — so the useful animation is often a range. Saying which
frames mean what is the same kind of decision as saying which bones are a leg, so it belongs in the
annotation rather than in a v2 solver, and it belonged there *early*: it changed `clips` from a clip index
to a frame range, which was a breaking schema change that cost a migration function while the file was
nearly empty and would have cost every species already annotated if it had waited until after phase 3.

Deliberately left out of 1.5, and both for reasons rather than time: crossfading between segments, which is
a runtime concern, and masked blending by body part, which genuinely cannot be built until phase 3 has said
which bones are which. The second is the strongest argument for the annotate mode paying off beyond
locomotion — upper body from one clip and lower from another is only expressible once the parts are named.

Phase 3 is the only one where the design could be wrong in a way that needs rethinking rather than
fixing. Worth building it thin first on five deliberately awkward species — Sandslash (one limb read as
two), Pikachu (asymmetric leg chains), Onix (serpent), Voltorb (roller), Caterpie (worm) — before
committing to the interaction.

## Risks, stated plainly

1. **1,772 significant chains is the cost of this project.** Defaults and mirroring cut it to roughly
   1,100 decisions. Nothing eliminates it, and no shortcut exists via evolution families because they do
   not share rigs. If the annotate interaction is slow, the project does not finish.
2. **Phase 3 is a UX bet**, though a smaller one now that per-bone editing is always present rather than
   an escape hatch. If the chain gesture turns out to be wrong for a species, the work still completes —
   slowly — instead of becoming impossible. The remaining bet is on speed, not on capability.
3. **Duplicate bone names on three species** must be handled at load or the file corrupts silently.
4. **A re-extraction of the models invalidates every annotation.** Hence `rigHash` per species.
5. **v1 has no way to prove an annotation is *right*** — only that it is self-consistent. The first real
   proof arrives with v2's walker, which is late. The five awkward species in phase 3 are the mitigation.
