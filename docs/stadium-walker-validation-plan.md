# Pokémon movement validation and Lab integration plan

**Status:** authored 2026-08-30. Phases 0 through 5 completed 2026-08-31; Phase 6 is next. The baseline records one
pre-existing failure: Venonat's saved pose has no leg roles and prevents the legacy mapper finding legs.  
**Evidence:** `docs/animal-movement-behavior-paper-notes.md`; current implementations in
`stadium-walker.js`, `creature-locomotion.js`, and `gait-diagnostics.js`.

## Goal

Prove whether a Pokémon Lab annotation improves real movement by feeding it into the existing Stadium
walker and comparing it with the existing guessed rig map under identical conditions.

The walker already has the required locomotion core: fixed simulation steps, stance and swing phases,
world-locked foot targets, terrain scanning, an explicit knee pole, reach handling, contact patches,
support polygons, Froude scaling, and Stadium-specific world-matrix retargeting. This plan does not
replace those systems. It makes their remaining failure modes observable and adds the missing Lab-to-map
input path.

## Outcome

At the end of this work, the `Movement` tab in `pokemon-lab.html` can run either:

```text
legacy rig-map guess ─┐
                     ├─> the same ground-movement engine ─> the same diagnostics
Lab-derived map ──────┘
```

The comparison answers one question: **did the human-authored semantic mapping produce a better moving
creature?** It does not write back to the annotation, mark a species complete, or silently tune the gait.

`demos/stadium-walker-v2.html` is a temporary regression harness during the move, not the destination and
not a second authoring app.

## UI destination and terminology

The Lab is the one application. It already owns species loading, the dex, model presentation, skeleton
selection, semantic annotation, neutral pose, animation, audio, persistence, and shared panel chrome.
None of those surfaces move over from the old walker page.

Use these terms consistently:

- **Movement:** the Lab tab and umbrella system for every locomotion class.
- **Ground movement:** the existing `stadium-walker.js` controller used by the `walker` class.
- **Gait:** walk, gallop, or another stepping pattern inside ground movement.
- **Movement class:** `walker`, `flyer`, `swimmer`, `hopper`, `serpent`, `worm`, `roller`, `floater`,
  `burrower`, or `static`, as already stored by `pokemon-annotation.js`.

The Lab must never call every creature a walker. A small movement facade selects a controller from the
annotation's movement class. Initially it supports `walker` through the existing ground controller and
returns an explicit “not implemented” state for the other classes. Later controllers become siblings
behind the same facade.

### What comes over from the old page

- the existing movement runtime module, not its duplicated model-loading code;
- pause, resume, single-step, reset, speed, gait, and terrain controls;
- useful target, contact, pole, foot, and support overlays;
- gait diagnostics and literal warnings;
- controlled legacy-map versus Lab-map comparison;
- trial logging and tuning only after the basic preview is understandable.

### What does not come over

- the old page's species loader and roster as the ordinary single-species workflow;
- bone-role assignment;
- stance and pose authoring;
- skeleton/model display controls;
- separate localStorage documents for roles, stances, and page preferences;
- its `Rig → Stand → Walk → Trial` stage bar;
- duplicated panel styling, camera setup, renderer, ground, and save/import UI.

The old multi-creature comparison is optional advanced tooling. If retained, it lives inside the Lab's
Movement tab and uses the Lab's current data; it does not restore a second authoring path.

## Non-goals

- No new walker or second gait scheduler.
- No second production movement application beside the Lab.
- No per-species locomotion implementation.
- No replacement FABRIK solver.
- No ZMP preview controller or robot-style hierarchical quadratic program.
- No reinforcement-learning controller.
- No motion matching without a locomotion corpus.
- No pursuit, flee, flocking, or collision-avoidance behavior inside the walker.
- No more elaborate swing-foot curve unless the existing sine arc fails a named measurement.
- No requirement that every bone be annotated.
- No gate that treats schema completeness as proof of correct movement.

## Existing baseline to preserve

| Capability | Existing owner |
|---|---|
| Fixed 60 Hz integration with bounded substeps | `stadium-walker.js` |
| Stance/swing scheduling and sine lift | `creature-locomotion.js` |
| Terrain foothold search | `creature-locomotion.js` |
| Explicit-pole two-bone solve | `creature-locomotion.js` |
| Reach-triggered stepping and bounded retries | `stadium-walker.js` |
| Contact patches and support polygon | `foot-sdf.js`, `creature-locomotion.js` |
| Stadium world-matrix retargeting | `stadium-walker.js` |
| Foot slip, tapping, reach, blockage, and speed reports | `gait-diagnostics.js` |
| Existing guessed semantic map | `stadium-rig-map.js` |
| Lab JSON loading and node-ID resolution | `pokemon-lab-runtime.js` |
| Temporary regression harness and source of proven movement UI | `demos/stadium-walker-v2.html` |

Every new diagnostic field must be optional to its consumer. Existing maps and callers must continue to
work without supplying Lab metadata.

## Measurement definitions

The plan uses normalized measures so a Rattata-sized creature and an Onix-sized creature can be compared.

### Foot and reach

- **Stance skate:** rendered horizontal foot travel divided by body travel during one stance. Zero is
  planted; one means the foot was carried with the body.
- **Target gap:** distance between the rendered foot and the gait's intended foot target, divided by leg
  span.
- **Ground error:** rendered foot height minus terrain height at the rendered foot's horizontal position,
  divided by leg span.
- **Reach clamp:** the requested hip-to-foot distance exceeded the solver's permitted extension.

### Knee and chain

- **Bend sign:** dot product between the solved knee's perpendicular offset and the requested pole's
  perpendicular component. A non-positive value means the knee is no longer on the requested side.
- **Knee jump:** angular change of the hip-to-knee direction between consecutive posed frames.
- **Upper/lower length error:** absolute difference between the rendered segment length and its mapped
  rest length, divided by total leg span.
- **Joint continuity error:** separation between the transformed endpoint of the upper group and the
  transformed start of the lower group, divided by leg span.

### Support and time

- **Support margin:** signed horizontal distance from the projected body center to the support-polygon
  boundary. Positive is inside; negative is outside. Point and line supports report `null`, not a fake
  polygon distance.
- **Body clearance:** body height above sampled terrain relative to the configured minimum clearance.
- **Dropped simulation time:** incoming frame time discarded by the maximum-substep guard.

No threshold becomes a pass/fail gate until a baseline trace shows its normal numerical noise.

## Phase 0 — Freeze the current baseline

Purpose: make later diagnostic work incapable of quietly changing locomotion.

### Work

1. Run the existing walker, rig, and gait-diagnostic suites before edits.
2. Record the existing reference-species reports produced by the current sweep/test path.
3. Add one test asserting that calling `diagnosticFrame()` does not change walker state.
4. Add one deterministic trace test: same map, seed, tuning, commands, and fixed steps must produce the
   same body and foot positions whether the diagnostics are sampled or ignored.

### Files

- `test-stadium-rig.mjs`
- `test-gait-diagnostics.mjs`
- `stadium-reference-species.js`

### Exit criteria

- The current tests pass before implementation begins.
- A reproducible baseline report exists for the reference set.
- Diagnostic sampling is proved observational only.

### Result — 2026-08-30

The deterministic and observational checks pass, and the reference report is recorded in
`docs/stadium/walker-baseline-2026-08-30.md`. `test-gait-diagnostics.mjs` passes. The Stadium suite passes
all walker checks, including both new Phase 0 checks, but retains one pre-existing authored-data failure:
Venonat's saved stance has `roles: null`, and the legacy mapper finds no legs after applying it. The
baseline neither changes that stance nor weakens the assertion.

## Phase 1 — Name every existing failure cause

Purpose: separate bad terrain, unreachable placement, scheduling refusal, and retry exhaustion instead of
reporting all of them as a vague bad step.

### Walker telemetry

Extend `diagnosticFrame()` with lifetime counters and current per-leg state for:

- `terrainMisses`: the foothold scan found no grounded target;
- `reachClamps`: the IK request exceeded permitted reach;
- `schedulerWaitFrames`: the leg wanted to move but was waiting for its ordinary turn;
- `schedulerStarvations`: the wait exceeded one complete scheduling opportunity cycle;
- `forcedResteps`: rendered target gap triggered a corrective step;
- `exhaustedResteps`: the retry budget ended and the gap was accepted;
- `unreachableNow`: current target is outside permitted reach;
- `failure`: `null | terrain | reach | scheduler-starvation | retry-exhausted`.

Do not infer these later from one combined number. Increment each counter where the corresponding decision
is made. Ordinary scheduler waiting is not a failure: the Phase 0 baseline spends 85–96% of wanted frames
waiting because support and phase ordering intentionally permit only a subset of legs to lift. Classify a
scheduler failure only after a leg has remained eligible and missed a complete opportunity cycle.

### Diagnostic aggregation

Extend `createGaitMonitor()` to report each failure count and rate globally and per leg. Keep the existing
dragging/tapping verdict unchanged during this phase.

### Tests

Use small hand-authored traces and targeted real-rig cases to force one failure at a time:

- terrain callback returns no reachable foothold;
- target is longer than `l1 + l2`;
- support floor makes a leg wait normally, without a false starvation failure;
- a deliberately held eligible leg exceeds a full opportunity cycle and reports starvation;
- forced re-step succeeds;
- forced re-step exhausts its retry limit.

### Exit criteria

- Every forced case reports exactly one primary cause.
- Existing diagnostic report fields and verdicts remain compatible.
- No new counter becomes `NaN` when older hand-authored test frames omit it.

### Result — 2026-08-31

`diagnosticFrame()` now reports terrain misses, reach clamps, eligible scheduler waits, scheduler
starvation, forced corrective steps, and exhausted retries separately, both per leg and as lifetime
totals. `createGaitMonitor()` aggregates those causes without changing the existing tapping or dragging
verdict. Synthetic traces and real Rattata cases exercise each distinction. The 14-species reference
sweep reproduces every Phase 0 movement number exactly, and ordinary default scheduling produces zero
starvation events.

## Phase 2 — Add knee, retarget, and contact invariants

Purpose: detect a numerically reachable but anatomically wrong leg—the main failure the IK papers warn
about and the current slip metrics cannot see.

### Map metadata

Allow each mapped leg to carry optional diagnostic provenance:

```js
{
  pole,
  poleSource: 'rest-geometry' | 'override' | 'fallback' | 'unknown',
  poleConfidence: 0..1
}
```

The guessed mapper and Lab adapter may supply these fields. The walker must tolerate their absence.

### Walker telemetry

After `applyPose()`, expose plain-number fields for:

- solved hip, knee, and rendered foot positions;
- world-space pole direction;
- bend sign;
- knee angle and per-frame angular change;
- upper- and lower-segment relative length error;
- upper/lower transformed-joint continuity error;
- rendered-foot ground error;
- pole source and confidence.

Keep the telemetry THREE-free at the `diagnosticFrame()` boundary.

### Diagnostic aggregation

Report, per leg:

- minimum bend sign;
- maximum and p95 knee jump;
- maximum segment-length error;
- maximum joint-continuity error;
- planted ground-error p95 and maximum;
- count of low-confidence/fallback poles.

Initially report these values without adding a global failure verdict. Establish numerical noise from real
traces first.

### Tests

- A valid two-bone solve preserves both segment lengths.
- An unreachable solve reports a reach clamp without a false knee flip.
- A deliberately reversed pole produces a negative bend-sign case.
- A collinear rest leg uses a fallback and reports low confidence.
- A stable planted stance has no knee discontinuity beyond numerical tolerance.
- A rendered foot above or below the terrain reports signed ground error.

### Exit criteria

- A backward or flipping knee is machine-visible.
- Segment and joint discontinuities are separately reported.
- None of the reference rigs acquire a transform change merely from telemetry.

### Result — 2026-08-31

The walker now reports solved and rendered hip, knee and foot positions, pole provenance and confidence,
bend sign, knee angle and frame-to-frame change, relative segment-length error, joint-continuity error,
and signed rendered-foot ground error. `gait-diagnostics.js` aggregates them per leg and across the
creature, but deliberately adds no new verdict before the real distributions are understood.

A 20-second flat-ground sweep over the 14 reference species measured bend sign 1.0 throughout, zero
segment-length error, p95 knee changes from 9.55 to 27.02 degrees, maximum knee changes from 17.85 to
41.29 degrees, zero planted-ground error at p95, and zero fallback poles. Thirteen species also had zero
joint-continuity error.

Sandslash exposed an existing mapper defect: each side is emitted as two legs which share the same three
upper bones and differ only at the final toe branch. The second pose overwrites the first pose on those
shared bones, producing 53.6579% joint-continuity error. This is not a telemetry regression; it is the
first machine-visible proof of the Phase 3 design risk already noted for Sandslash (one anatomical limb
read as two). The Lab adapter must preserve one authored limb with multiple foot bones rather than copy
this guessed map.

The synthetic tests prove a reversed pole reports a negative bend sign, a collinear rest leg reports a
zero-confidence fallback, scene-graph segment and joint measurements stay separate, stable stance has no
knee jump, and ground error keeps its sign. The full rig suite still has only the pre-existing Venonat
stance-data failure.

## Phase 3 — Expose clock loss and support margin

Purpose: distinguish locomotion defects from frame stalls and replace binary support reporting with a
useful stability margin.

### Fixed-step telemetry

Before clamping the accumulator, calculate the time that will be discarded. Track:

- `droppedTimeFrame`;
- `droppedTimeTotal`;
- `substepCapHits`;
- maximum observed input `dt`.

Do not remove the substep cap in this phase. The goal is visibility, not allowing a spiral of death.

### Support telemetry

Extend the support calculation with:

- signed support margin for a non-degenerate polygon;
- `null` margin for point/line support;
- polygon point/contact count already used to explain the degeneracy;
- body clearance and below-minimum-clearance frame count.

### Tests

- `dt <= FIXED * MAX_SUBSTEPS` reports zero dropped time.
- A deliberately large `dt` reports the exact discarded duration and one cap hit.
- A point or line support returns `null` margin.
- A point inside a square has positive margin, on its edge has zero, and outside has negative margin.
- Body clearance uses the same terrain sample and minimum as the walker integration.

### Exit criteria

- A stutter trace can say whether bad motion coincided with discarded simulation time.
- Support quality is measurable before the center crosses the polygon edge.

### Result — 2026-08-31

`diagnosticFrame()` now reports discarded time for the current frame and since creation, substep-cap hits,
and maximum input `dt` without changing the fixed-step cap. It also reports signed support margin,
support-point count, current and minimum body clearance, and how often integration attempted to cross the
hard body floor. Point and line support return `null` margin rather than pretending to enclose an area.

The monitor aggregates clock loss and support separately from tapping, dragging, named failures, and
retarget measurements. Tests cover exact discarded duration, inside/edge/outside polygon signs,
degenerate support, and clearance against the same terrain and minimum used by integration. The exact
14-species Phase 0 sweep remains unchanged, and ordinary 60 Hz sampling discards no time.

## Phase 4 — Build the Lab ground-movement map and movement facade

Purpose: replace guessed semantics with authored semantics while preserving measured geometry.

### New module

Add `pokemon-lab-ground-map.js` as a pure adapter. Its conceptual contract is:

```js
mapLabRigForGroundMovement({ annotationRig, measuredRig, gltf })
  -> { map, findings, trace }
```

- `map` has the shape consumed by `createStadiumWalker()`.
- `findings` contains missing or contradictory inputs and never mutates the annotation.
- `trace` states where each semantic and geometric value came from.

The adapter should reuse pure measurement functions from `stadium-rig-map.js` or extract shared helpers
where necessary. It must not duplicate foot-proxy fitting, rest-world measurement, unit conversion, or
Stadium geometry handling.

Add `pokemon-movement.js` as the class-aware runtime facade used by the Lab:

```js
createPokemonMovement({ locomotion, scene, map, ...options })
  -> { supported, label, controller, findings }
```

For `walker`, it delegates to the existing ground-movement engine. Other movement classes return their
plain-language label and an explicit unsupported finding until their controller exists. The Lab imports
this facade, not a function whose public name implies that every creature walks.

### Authored inputs

Read these decisions from the Lab:

- root and spine;
- appendage/limb chain;
- contact or foot bone;
- side and row;
- paired relationship;
- locomotion class;
- neutral pose when present.

Unassigned decorative bones are allowed.

### Derived values

Measure or derive:

- units, forward direction, body centroid, and ride height;
- attachment, hip, knee, ankle, foot, and foot proxy;
- `l1`, `l2`, total span, and rest direction;
- knee index and ankle index;
- foot frame/contact patch;
- rest-geometry pole and confidence.

For the pole, project the interior knee offset perpendicular to the hip-to-foot axis. If its magnitude is
too small to choose a stable side, use a deterministic body-relative fallback, record low confidence, and
emit a finding. Do not add a mandatory annotation field before real species demonstrate the need.

### Tests

- A synthetic annotated chain produces the required walker fields.
- Node IDs resolved by `pokemon-lab-runtime.js` select the intended glTF nodes.
- Derived lengths and positions match the shared Stadium measurements.
- A missing root, foot, chain, side, or row produces a named finding rather than an exception or guess.
- Decorative unassigned bones do not produce a completeness error.
- A non-walker returns an explicit unsupported/not-applicable result rather than invented legs.
- Repeated input produces byte-equivalent plain-data output.

### Exit criteria

- The map adapter contains no THREE dependency and no DOM/UI dependency.
- It can construct a walker map without invoking the old semantic guesses.
- Every map field can be traced to annotation, measurement, or deterministic derivation.
- The movement facade selects by the annotation's movement class and never silently substitutes walking.

### Result — 2026-08-31

`pokemon-lab-ground-map.js` converts the node ids returned by `rigFor()` into the existing ground
controller's map shape. Root, spine, limb chain, side, row, pairing and foot bones come only from the Lab
annotation; geometry uses the shared Stadium measurements. Missing or contradictory inputs return named
findings and no map, while decorative unassigned bones remain optional.

A limb now has one linear joint path plus any additional driven foot branches. The regression test maps
Sandslash as two authored legs with two foot bones each, rather than four guessed legs sharing upper
bones. `pokemon-movement.js` delegates only Walking to the ground controller; every other class returns
its own label and an explicit not-implemented finding. The end-to-end controller test and unchanged
14-species baseline both pass.

## Phase 5 — Put movement inside Pokémon Lab

Purpose: make the Lab the only movement application while preserving a controlled mapping comparison.

### Lab tab

Add `Movement` to `pokemon-lab.html`'s existing tab strip, after `Pose`. Its ordinary view is the currently
selected species—no second species dropdown, loader, renderer, camera, panel, or save document.

The first useful vertical slice contains:

- movement-class readout using the Lab's existing labels (`Walking`, `Flying`, `Swimming`, and so on);
- `Start`, `Pause`, `Step`, and `Reset`;
- desired speed and direction;
- gait choice only when the active controller supports gaits;
- flat ground first, using the existing terrain callback contract;
- a concise state line: moving, paused, unsupported class, or a named mapping problem;
- one collapsed `Diagnostics` section.

For movement classes without a controller, show the class and the fact that its preview is not implemented.
Do not hide the tab, relabel the creature as a walker, or run the ground controller as a fallback.

### One renderer and one loaded asset

Entering the Movement tab creates a movement session from the Lab's current cached model and annotation.
Use a skeleton clone for the driven scene so movement cannot corrupt the model used by annotation, pose,
and animation tabs. Hide the authoring instance while the movement clone is active; restore it when the
session ends. Do not fetch or parse the GLB a second time.

Leaving the tab, changing species, or changing movement-critical annotation must stop and dispose the
session predictably. Returning to another tab restores the Lab's camera/model state rather than carrying
movement transforms into pose authoring.

### Mapping comparison

Inside the Movement tab, provide an advanced input choice:

- `Guessed map`
- `Lab map`
- `Compare`

`Compare` runs two instances with:

- the same model and neutral pose;
- the same walker tuning;
- the same terrain function;
- the same target commands;
- the same fixed-step sequence;
- the same deterministic random seed.

Display compact, literal labels—`Foot slip`, `Target gap`, `Knee flip`, `Ground error`, `Support margin`,
`Dropped time`—rather than internal names or unexplained scores.

### Overlays

Provide toggles for:

- annotated limb chain;
- hip, knee, and foot points;
- pole direction;
- intended and rendered foot targets;
- planted contact patch;
- support polygon and projected body center.

Do not automatically write validation state to the Lab file. The user observes the result and decides
what to revise. Compare mode may use a second clone, but it still uses the Lab renderer, camera, current
species, current annotation, and one shared set of movement commands.

### Old-page retirement boundary

Keep `demos/stadium-walker-v2.html` unchanged as a regression harness until the Lab can start, pause,
reset, display overlays, and produce the same diagnostic report. After parity, mark it legacy and stop
adding features to it. Do not port its role editor, stance editor, model controls, stage bar, or storage.

### Static checks

Extend `_check_pokemon-lab.html.mjs` to assert:

- the Movement tab uses `pokemon-movement.js` rather than importing `createStadiumWalker()` directly;
- it reuses the current cached asset and does not introduce a second model fetch path;
- leaving Movement tears down its clone and restores the authoring model;
- unsupported movement classes are stated and never sent to ground movement;
- both map routes reach the same ground-movement controller;
- compare mode shares one tuning source and command source;
- diagnostic sampling happens once per rendered frame per walker;
- the comparison never writes annotation data.

Keep `_check_stadium-walker-v2.html.mjs` passing while it remains the regression harness.

### Exit criteria

- The selected species can be previewed without leaving the Lab.
- No duplicated rig, stance, pose, or persistence editor appears.
- Switching map source does not rebuild or replace the ground-movement implementation.
- Compare mode controls both walkers identically.
- Every visible warning names a measured condition and the affected leg.

### Result - 2026-08-31

`pokemon-lab.html` now owns movement preview. The Movement tab follows Pose and reuses the selected
species, the cached GLB bytes, the Lab renderer and camera, and a skeleton-aware clone of the current
model. It does not add another species loader, authoring surface, persistence document, or direct import
of the ground controller. Leaving the tab, changing species, or editing the annotation tears the clone
down and restores the authoring model, camera, and playback state.

Walking can run from `Lab map`, `Guessed map`, or `Compare`; both map routes enter through
`createPokemonMovement()` and share gait, speed, direction, terrain, seed, and frame sequence. Other
movement classes state that their preview is not implemented and never fall back to ground movement.
The tab provides start, pause, fixed-step and reset controls, flat ground, walk/gallop selection, six
literal diagnostic readouts, and toggles for limb chains, joints, knee poles, intended/rendered feet,
contact patches, and support.

A real Edge/WebGPU run loaded Bulbasaur from the Lab, switched to the guessed route, started movement,
rendered the cloned model and overlays, and populated every diagnostic without a browser or Lab error.
The current Bulbasaur annotation cannot yet enter `Compare`: its four appendages are not typed as legs,
so the Lab adapter correctly reports `Assign at least one leg before previewing ground movement.` That is
an annotation input for the Phase 6 trial, not a reason to guess inside the Lab route.

The browser pass caught and fixed two integration-only defects that static tests could not see: the first
clone inherited `visible = false` because the authoring model was hidden too early, and the first camera
framing made the preview too small. Regression checks now pin clone-before-hide and species-session
restart. The Lab has 112 static checks; the legacy harness has 44; runtime, adapter, movement-facade and
diagnostic suites pass. The full Stadium rig suite retains only the recorded Venonat stance-data failure.
`demos/stadium-walker-v2.html` is now a legacy regression harness rather than the movement application.

## Phase 6 — Run the trial matrix and decide whether gait changes are justified

Purpose: base any algorithm change on a reproducible failure rather than on a paper's preferred method.

### Trial matrix

For every testable walker annotation, run:

1. stand without drift;
2. start from rest;
3. constant forward movement;
4. stop without stance skating;
5. low and high valid speeds;
6. left and right turns;
7. slope traversal;
8. a small terrain step;
9. an unreachable foothold;
10. a frame-time disturbance that hits the substep cap.

Include deliberately awkward body plans as test inputs when their annotations are available: asymmetric
chains, more than four legs, very short legs, long segmented bodies, and legitimate non-walkers. The test
must not demand that the user's working annotation file be complete; fixtures or explicit test
annotations can exercise the adapter.

### Comparison report

For each species and map source, record:

- stance-skate p95;
- target-gap p95;
- reach-clamp and failure-cause rates;
- knee-flip count and knee-jump p95;
- segment/joint-continuity maximums;
- ground-error p95;
- minimum support margin where defined;
- speed efficiency;
- dropped time;
- authored, derived, fallback, and guessed decision counts.

### Rule for changing the gait

Change a gait algorithm or default only when:

1. the same named failure reproduces with a valid map;
2. diagnostics identify the failing layer;
3. a proposed change improves that measurement;
4. the reference-species sweep shows no material regression;
5. the change has a focused test.

Examples:

- A knee flip with a high-confidence correct pole is a solver/retarget defect.
- A knee flip with a low-confidence collinear pole is a mapping/annotation issue.
- Foot drag with repeated reach clamps may require body height or stride tuning.
- Foot drag with clean reach but dropped simulation time is a clock/frame-pacing issue.
- A collision with an obstacle is not evidence that the gait needs collision-avoidance IK; navigation and
  steering must be tested first.

### Exit criteria

- At least one annotated walker runs through the entire matrix.
- Guessed and annotated results are directly comparable.
- Every failure is assigned to annotation, adapter, walker, terrain, or clock with recorded evidence.
- Any recommended gait change is smaller than and independent of the adapter.

## Phase 7 — Define gates from evidence

Purpose: let the Lab report useful state without claiming that structurally valid data is physically
correct.

Keep these states independent:

- **Structurally ready:** required semantic inputs for the locomotion class exist.
- **Movement tested:** the annotation was run through a recorded trial version.
- **Needs attention:** one or more named diagnostic thresholds failed or visual review rejected it.
- **Accepted:** explicit human decision; never set automatically by the walker.

Thresholds and trial-version identifiers belong in validation results, not hidden in the annotation's
body-part data. The schema design for persisted results is a separate decision after Phase 6 establishes
which measurements are stable enough to retain.

## Verification commands

Run after every phase that touches the corresponding surface:

```text
node test-gait-diagnostics.mjs
node test-stadium-rig.mjs
node test-pokemon-lab-runtime.mjs
node test-pokemon-movement.mjs
node test-pokemon-lab-ground-map.mjs
node _check_pokemon-lab.html.mjs
node _check_stadium-walker-v2.html.mjs
```

Add `test-pokemon-movement.mjs` and `test-pokemon-lab-ground-map.mjs` in Phase 4. If the repository's gait
sweep command is used for the baseline, preserve its exact invocation and tuning alongside the comparison
report.

## Build-order summary

| Phase | Deliverable | State |
|---|---|---|
| 0 | Frozen deterministic baseline | complete 2026-08-30; Venonat data failure recorded |
| 1 | Named failure causes | complete 2026-08-31 |
| 2 | Knee, chain, and rendered-contact invariants | complete 2026-08-31 |
| 3 | Dropped-time and signed-support telemetry | complete 2026-08-31 |
| 4 | Ground-movement map adapter and class-aware movement facade | complete 2026-08-31 |
| 5 | Movement tab and controlled comparison inside Pokémon Lab | complete 2026-08-31 |
| 6 | Trial matrix and evidence report | not started |
| 7 | Evidence-based gate definitions | not started |

The first implementation action is Phase 0, not the adapter and not gait tuning. It creates the baseline
that lets every later change prove it added observation or better input without quietly changing how the
creatures already walk.
