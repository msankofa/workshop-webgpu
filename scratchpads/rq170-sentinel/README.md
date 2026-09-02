# RQ-170 Sentinel

The worked example for the pipeline described in `../README.md`. Built 2026-09-01.

- **References.** `ref/three-view.png`, an orthographic top, side and front drawing, is the
  geometry source. `ref/render-sheet.png`, three CG renders, only settled what the drawing hides:
  gear layout and which way the sensor blisters taper.
- **Scale.** 20 m span assumed; the drawing gives proportions only. Every absolute size follows it.
  Measurements and the labelled inferences are in `intake-analysis.md`.
- **Result.** Top-view silhouette IoU 0.942 against the drawing, strict gate passing, 39k triangles
  in the generated factory. Four review rounds, recorded in `reviews.jsonl`; the two shape defects
  the user found by eye were a hull plateau showing through the wing skin and a leading-edge
  shoulder from the rib solver.
- **Port.** `buildSentinel` in `../../flight-meshes.js`, 2.5k triangles, no landing gear, pinned by
  `../../test-flight-meshes-sentinel.mjs`. Base Game flies it as the `sentinel` world drone; see
  "The Sentinel" in `../../docs/subsystems/base-game.md`.
- **Open.** The intake carve's interior is airframe grey where the drawing shows a dark opening.
  The wing section is a lens with a rounded leading edge; the drawing's is sharper.

Run `sh build.sh` to rebuild everything from `author_spec.py`, then `python shot-server.py 8090`
and open `http://127.0.0.1:8090/viewer.html` to look.
