# Pokémon Lab — annotation suggestions

**Status:** Phases 0, 1, and 2 complete 2026-09-01. Phase 3 is next.

## Outcome

The Lab should use model geometry to prepare a reviewable first draft of the current species' body parts.
The draft saves selection work; it never becomes annotation data until the person applies it.

The first version suggests only what the existing geometry supports reasonably well:

- body root;
- spine;
- head;
- legs, including side and front-to-rear pair number;
- foot/contact bones;
- mirrored leg pairs.

It does **not** choose the movement class, mark a species complete, overwrite an assigned part, or guess
wings, fins, tails, ears, and other decorative appendages. Those can be added after the grounded-body
suggestions have evidence behind them.

## Why the legacy guessed map is not enough

`stadium-rig-map.js` currently produces a usable automatic map for conventional bodies, but its audit is
not an accuracy measurement:

| Legacy outcome | Species |
|---|---:|
| Legs found, no internal audit errors | 81 |
| Legs found, internal audit errors | 35 |
| No legs found | 35 |
| Threw | 0 |

The 35 with no legs include legitimate non-walkers, so “find more legs” is not the objective. The real
problems are that the legacy mapper mixes measurement and judgement, emits only its final answer plus flat
warning strings, and cannot be compared field-by-field with accepted Lab annotations.

The Lab therefore gets one new pure module:

```js
suggestPokemonParts(rig, { locomotion = null })
  -> { parts, confidence, trace, findings }
```

`pokemon-rig.js` remains the source of facts. The suggestion module consumes its bone tree, chains,
geometry, rest matrices, extents, and rig hash. It does not read or write the annotation library and does
not import the Lab page.

## Suggestion contract

`parts` uses annotation-shaped bone keys so it can be previewed without conversion:

```js
{
  root: 'bone29',
  spine: ['bone28', 'bone17'],
  head: ['bone14', 'bone13'],
  appendages: [{
    id: 'suggest-leg-L-0',
    type: 'leg', side: 'L', row: 0,
    chain: ['bone22', 'bone21', 'bone20'],
    mirror: 'suggest-leg-R-0',
    author: 'suggested'
  }],
  contacts: ['bone19', 'bone18']
}
```

`confidence` is per field and per appendage. It is not presented as a probability until it has been
calibrated against enough accepted annotations. The initial values are literal:

- `strong`: every required rule passed with room beyond its threshold;
- `review`: the candidate passed but one margin was close or the sides were asymmetric;
- `weak`: a fallback was required;
- `none`: no candidate is offered.

`trace` retains the evidence for this species: candidate bone or chain, rule, observed value, threshold,
runner-up where relevant, outcome, and a plain-language explanation. `findings` names conflicts such as no
mirrored partner, overlapping limb chains, or a grounded class with no contact candidate.

The engine and trace have a version string. A cached or dismissed draft is invalid when the rig hash,
movement class, or engine version changes.

## Derivation rules

All distances and masses are normalized by the current model's measured height or vertex count.

1. **Root:** use the measured single skeleton root. It is a rig fact, and the Lab already exposes it as
   the root candidate rather than asking the suggestion engine to reinterpret it.
2. **Foot candidates:** find distal geometry near the model's lowest surface and away from the centerline.
   Keep the normalized floor distance and centerline distance in the trace.
3. **Pairs:** match opposite-side candidates by mirrored rest geometry. Bone counts may differ. Record the
   winning distance and runner-up margin.
4. **Leg chains:** walk from each foot toward the first shared body ancestor. Suggested limb chains must be
   connected, disjoint, and retain branching foot descendants such as Machoke's and Sandslash's.
5. **Side:** derive left/right from measured geometry using the Lab's existing convention, rather than
   copying the legacy mapper's numeric sign.
6. **Rows:** sort pairs front-to-rear using the proposed head direction. Preserve the coordinate and sort
   decision in the trace.
7. **Head:** choose the heaviest non-leg chain only when it clearly exceeds its runner-up. Use its position
   to propose forward but do not store forward in the annotation.
8. **Spine:** take the connected root-to-head path that contains the limb attachments. A disconnected or
   leg-overlapping result is refused rather than repaired.
9. **Contacts:** suggest the lowest geometry inside or immediately below each leg chain. Several branches
   may belong to one leg. Contacts remain one global list, matching the annotation schema.
10. **Movement class:** use an already authored class only as context for findings. Never write one. No-leg
    output is normal for a roller, serpent, floater, swimmer, or stationary body; for a walker it is a
    visible unresolved suggestion.

Every proposed draft is passed through `validateAnnotation()` on a temporary annotation before the UI sees
it. Validation errors lower or remove the affected candidate; they are never silently fixed.

## Lab interaction

Add a compact **Suggested parts** section at the top of Annotate.

- Generate and cache the draft when the Annotate tab first opens for a species.
- If the annotation is blank, show its overlay immediately. Otherwise leave the overlay available but off.
- Summarize it literally: for example, “Found a body root, spine, head, four legs, and eight foot bones.”
- Show one row for Root, Spine, Head, Feet, and each proposed limb.
- Clicking a row selects and highlights its proposed bones without editing anything.
- Each row has **Apply** and **Hide**. Hide is session-only and writes nothing.
- **Apply all missing parts** fills eligible strong/review blank fields in one commit and therefore one
  undo step. Weak suggestions require their own Apply press.
- A collapsed **Why these parts?** view renders the trace in plain language. Rejected candidates live here,
  not in the primary workflow.

Suggested skeleton colours use the existing part colours at lower opacity. Authored colours always win.
No second picker, role editor, save file, or annotation mode is introduced.

### Merge rules

Applying a suggestion is explicit and conservative:

- root is filled only when `parts.root` is null;
- spine, head, and contacts are filled only when their corresponding lists are empty;
- a limb is added only when no existing limb has the same type/side/row and none of its bones is already
  claimed by another appendage;
- an accepted limb is stored with `author: "accepted"`;
- mirrors are declared only between two newly accepted suggestions or an unambiguous matching authored
  limb;
- movement class, posture, neutral pose, segments, notes, and completion state are untouched;
- applying one row changes only that row, even if another suggestion depends on it;
- existing hand-authored values are byte-for-byte unchanged.

The normal annotation functions perform every accepted edit. The suggestion module never mutates an
annotation object directly.

## One guessed map throughout the Lab

Today Movement's **Guessed map** calls `stadium-rig-map.js` directly. That would let movement and annotation
show different guesses after this feature improves.

Once the suggestion module is integrated, Movement should instead:

1. create the same temporary suggestion shown in Annotate;
2. place its parts into an unsaved temporary annotation with the already authored movement class;
3. resolve it through `resolveAnnotation()`;
4. build movement data through `mapLabRigForGroundMovement()`.

The legacy mapper remains for its existing demos and regression tests. The Lab has one automatic semantic
answer, whether the user is previewing it as coloured bones or testing it in motion.

## Evaluation

Do not call the existing 81/35/35 audit “accuracy.” Establish a field-level baseline against human work
before changing thresholds.

Only authored, non-empty fields count as reference data; an unassigned field is unknown, not a negative.
Report:

- exact body-root matches;
- spine, head, and contact bone precision/recall/F1;
- limb count and limb-bone F1 after matching by type, side, row, and maximum overlap;
- side and row agreement;
- invalid, overlapping, or unknown-bone suggestion counts;
- how many clicks **Apply all missing parts** would save without overwriting authored data.

Keep named real-rig regressions for:

- Rattata: conventional quadruped;
- Pikachu: asymmetric leg chains;
- Sandslash: branching foot geometry must remain one limb per side;
- Machoke: foot bones below the driven leg chain;
- Bulbasaur: four rows/sides reach the movement adapter correctly;
- Onix and Voltorb: no invented walking legs;
- Butterfree: non-grounded geometry is not treated as confident ground contact.

Across all 151 rigs, suggestion must be deterministic, never throw, emit only real bone keys, avoid
double-claimed limb bones, and explain every offered part in its trace.

## Build phases

### Phase 0 — Baseline

- Add `test-pokemon-suggest.mjs` with the field-level scorer and current accepted annotations.
- Record the legacy mapper's current score without changing a rule.
- Pin the named regression species and the all-151 safety invariants.

**Result, 2026-09-01.** `test-pokemon-suggest.mjs` maps all 151 real models deterministically, verifies
that every emitted node belongs to its rig, and scores only the non-empty fields currently authored in
the Lab file. Six species currently contribute at least one comparable field.

| Field | Legacy precision | Legacy recall | F1 |
|---|---:|---:|---:|
| Body root | 0 / 2 exact | — | — |
| Spine bones | 1 / 6 | 1 / 10 | 12.5% |
| Head bones | 1 / 4 | 1 / 17 | 9.5% |
| Contact bones | 8 / 12 | 8 / 32 | 36.4% |
| Limb bones | 16 / 18 | 16 / 22 | 80.0% |

Matched legacy limbs have 100% side and row agreement on the current authored sample. The dex-wide
internal audit remains 81 mappings without audit errors, 35 with errors, 35 with no legs, and zero
throws. These are baseline measurements, not an accuracy claim; the authored sample is still small and
incomplete.

The first pure pass is deterministic and annotation-safe across all 151 rigs. On the same partial
authored sample it measures:

| Field | Precision | Recall | F1 |
|---|---:|---:|---:|
| Body root | 2 / 2 exact | - | - |
| Spine bones | 1 / 4 | 1 / 10 | 14.3% |
| Head bones | 17 / 55 | 17 / 17 | 47.2% |
| Contact bones | 26 / 28 | 26 / 32 | 86.7% |
| Limb bones | 22 / 24 | 22 / 22 | 95.7% |

Matched suggested limbs have 100% side and row agreement. Weak head suggestions are deliberately
excluded from bulk apply; the high head recall therefore does not make the low precision safe to accept
without review.

### Phase 1 — Pure suggestion engine

**Complete 2026-09-01.**

- Add `pokemon-suggest.js` using `pokemon-rig.js` facts and annotation bone keys.
- Port the useful foot/pair/body logic from the legacy mapper with explicit candidates and trace records.
- Add deterministic confidence categories and temporary-annotation validation.
- Do not touch the Lab UI in this phase.

### Phase 2 — Preview and selective apply

**Complete 2026-09-01.**

- Add Suggested parts to the existing Annotate tab.
- Add the low-opacity overlay, row selection, Apply, Hide, Apply all missing parts, and trace view.
- Route acceptance through `editParts()` so save and undo behavior remain unchanged.
- Cache only in memory by species, rig hash, class, and engine version.

### Phase 3 — Improve from named evidence

- Compare suggestions with accepted fields and classify each mismatch as candidate detection, pairing,
  chain extent, side, row, head, spine, or contact association.
- Change one rule at a time with a regression that demonstrates the failure.
- Prefer wider evidence margins over species-specific exceptions. If an exception is unavoidable, make it
  explicit and traced.

### Phase 4 — Unify Movement

- Replace the Lab's direct legacy guessed-map call with the temporary suggestion-to-ground-map path.
- Keep Lab map, Guessed map, and Compare controls unchanged.
- Assert that Annotate and Movement name identical suggested bones for the same species.

## Acceptance criteria

- Opening, previewing, hiding, or explaining a suggestion does not change `annotationStamp()` or the save
  file.
- Apply is the only write; Apply all is one undoable write.
- No existing authored value is overwritten.
- Every visible suggestion selects the same bones it would apply.
- Suggested appendages persist as `author: "accepted"`, never `"suggested"`.
- The named awkward species pass their regressions and all 151 rigs satisfy the safety invariants.
- Movement's Guessed map and Annotate's suggestion come from the same draft.
- Existing annotation, runtime, movement, and Lab static suites remain green; the recorded Venonat stance
  fixture remains a separate legacy-data issue.
