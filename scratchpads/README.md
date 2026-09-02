# scratchpads: working folders that must survive

Anything an agent builds that is not yet a repo module goes in a folder here, never in the session
temp directory, which gets wiped. Most folders are throwaway probes (`shadow-geo-probe/`,
`vehicle-models/` at the time of writing) and need no README. Design work does, and the rest of this
file is the design pipeline.

## Reference-to-model design work

One folder per design. Each turns a drawing or photograph of a vehicle into a procedural Three.js
model, checks it against the reference with numbers, and ends with a hand-authored builder in
`flight-meshes.js` the game can draw. This file is the pipeline; each folder's own README says what
is specific to that design. `rq170-sentinel/` is the worked example and the folder to copy.

Nothing here needs a GPU until the last look. Everything a design produces lives in its folder,
on disk and in git, never in the session temp directory.

## Setup, once

- The img2threejs checkout at `~/.claude/skills/img2threejs`. If it is missing:
  `git clone --depth 1 https://github.com/img2threejs/img2threejs.git ~/.claude/skills/img2threejs`
- esbuild and three in `~/.claude/tools/node_modules`. Install them there, not in a design folder:
  Google Drive corrupts a `node_modules` (esbuild's install script fails, three loses its build
  directory). The example's `build.sh` already points at that path.
- Python 3 with Pillow and numpy for the measurement scripts.

## Starting a new design

Copy `rq170-sentinel/` to a new folder, replace `ref/`, delete `shots/`, `meas/`, `zones/`, `pbr/`,
`matcrops/`, `src/`, `factory.mjs`, `viewer.js`, `reviews.jsonl` and `.img2threejs/`, then rewrite
the two files that hold the design: `intake-analysis.md` and `author_spec.py`. Every other file is
generic; rename the output names in `build.sh` and `smoke.mjs` to taste.

## The order to work in

1. **Measure the reference before authoring anything.** Segment the drawing by colour, find the
   row and column extents of each view, convert pixels to metres with one assumed absolute size.
   Write what you saw into `intake-analysis.md`, observation and inference in separate sentences.
   The inference that is not labelled is the one that costs four correction rounds later.

2. **Run intake through the skill.** `probe_image.py`, `check_reference_admission.py`, and
   `build_detail_inventory.py --mode component-zones` with 0 to 1 fractions, not pixels. Open every
   crop it writes into `zones/`.

3. **Author the model in `author_spec.py`.** It loads `skeleton-spec.json` (made once by
   `new_pre_spec_assessment.py` and `new_sculpt_spec.py`) and writes `object-sculpt-spec.json` from
   scratch on every run, so a change is a diff to a script, not an edit to a 300 KB JSON. It holds
   the planform and thickness as functions in metres, the rib solver for tapered sweeps, and every
   component, material, local feature, detail and review target the strict gate asks for.

4. **Build and measure with one command: `sh build.sh`.** It authors the spec, extracts material
   evidence from the crops in `matcrops/`, flattens the maps (`flatten_maps.py`: single-tone paint
   must not carry a tiled crop, or it shows as rectangles), runs the strict gate, generates the
   TypeScript factory, bundles `factory.mjs` and `viewer.js`, then runs `smoke.mjs`,
   `silhouette.mjs` and `compare_views.py`. The last line is the top-view IoU against the drawing
   with per-station leading and trailing edge error.

5. **Look at it.** `python shot-server.py 8090`, open `http://127.0.0.1:8090/viewer.html`. Reference
   beside render, camera presets, wireframe, a screenshot button that writes into `shots/`. The
   gates catch schema problems and never catch a wrong shape. Look, every round.

6. **Probe what the eye found.** `probe_root.mjs` lists the front-most wing vertex per span station
   against the target leading edge. `probe_ribs.mjs` prints each ring's ends. `smoke.mjs` prints
   per-part bounds and the triangle count. Write a probe for the defect, fix the number in
   `author_spec.py`, rebuild.

7. **Record the round.** `append_review.py --action refine-spec` into the spec, and the same line
   into `reviews.jsonl`, because step 3 wipes the spec's review history on every rebuild.

8. **Port by hand.** The generated factory is 1 MB with three bundled in and is not what the game
   draws. Transcribe the spec's numbers into a builder in `flight-meshes.js` (`buildSentinel` and
   `buildRecon` are the two examples), register the kind, and pin the proportions in a
   `test-flight-meshes-<kind>.mjs`. Then the game wiring: `docs/subsystems/base-game.md` for drones
   and ground vehicles.

## Generic files in a design folder

| File | Role |
|---|---|
| `ref/` | The reference images |
| `intake-analysis.md` | What was measured, what was inferred (design-specific) |
| `skeleton-spec.json` | The skill's empty spec, made once |
| `author_spec.py` | The model as code (design-specific) |
| `build.sh` | Spec to measured model in one run |
| `flatten_maps.py` | Flat PBR maps for flat paint |
| `smoke.mjs` | Bounds, NaN scan, triangle count per part |
| `silhouette.mjs` | Top, front and side masks of the built model, CPU only |
| `compare_views.py` | IoU and edge error against the drawing, ASCII diff |
| `probe_root.mjs`, `probe_ribs.mjs`, `probe_le.mjs` | Vertex probes for edge defects |
| `viewer.html`, `viewer-entry.js`, `shot-server.py` | The look, with screenshots to `shots/` |
| `matcrops/`, `pbr/` | Material crops and the evidence extracted from them |
| `reviews.jsonl` | Every correction round, kept across rebuilds |
| `.img2threejs/state.json` | The skill's own checklist state |

## Things that bit

- The generator prefers `transform.scale` over `dimensions` and the skeleton writes `[1,1,1]`.
  Delete it on primitives; keep it on sweeps and implicit bodies so metres are not scaled twice.
- A component with an attachment is replaced by a cylinder between `localStart` and `localEnd`.
  Give it a zero-length segment to keep the authored primitive and still pass the gate.
- Extracted PBR confidence is nearly constant across crops. Judge a crop by looking at it.
- Implicit bodies polygonise on a 64 grid at most. A box carved into one leaves torn flaps;
  a dark inset reads as an opening without carving.
- A tapered sweep tilts its ribs with the spine. Solve rib ends onto the edges, and run any root
  override inside the fit loop, or the next rib is solved against the wrong tilt.
- Components named `-l` and `-r` fail the character chirality gate. Use `port` and `stbd`.
- A craft's cosmetic bank from `bot-drones.js` is positive for a left turn; the base game's wire
  carries the physics sign. Do not add a third convention.

The first run of this pipeline, on a fixed-wing recon UAV, is written up with all six correction
rounds in the "Airframe Reconstruction Runbook" artifact:
https://claude.ai/code/artifact/383506d4-fce5-426a-a82e-3074afecb720
