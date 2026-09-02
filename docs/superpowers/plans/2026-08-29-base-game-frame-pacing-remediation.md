# Base Game frame-pacing remediation

**Date:** 2026-08-29  
**Evidence:** live report of excess draws and movement-related frame spikes; terrain and trees WebGPU audits

## Goal

Stabilize Base Game frame pacing while moving, reduce the default draw/submission count, and make
future captures separate ordinary rendering from optional extra scene passes.

## Work

1. **Reconcile the audited and shipped terrain budgets.** Make the page consume the terrain
   subsystem's radius-3 default instead of overriding it with radius 6. Pin the relationship in a
   test. This changes the near-terrain window from 169 chunks/draws to 49.
2. **Remove periodic duplicate rendering from the default frame.** Default water reflections to the
   sky path. Keep planar and screen-space reflection available as explicit quality choices and label
   planar honestly as an extra scene render.
3. **Measure the movement path in the browser.** Capture standing and continuous walking with GPU
   timestamps, including frame p50/p95/p99/max, draw calls, triangles, terrain install/fold time,
   forest recull time, mirror/plain encode time, and renderer geometry counts.
4. **Attribute remaining spikes before changing more code.** If spikes align with terrain installs,
   budget worker result fold-in and synchronous fallback builds. If they align with forest reculls,
   sweep the already-supported movement/heading thresholds. If they are GPU-only, sweep shadows,
   vegetation rungs, and post-processing independently.
5. **Fix the dominant measured path and add a regression gate.** The acceptance target is no
   alternating mirror/plain cost at defaults, no default terrain draw-count drift, and walking p99
   within the chosen browser/device budget without unbounded renderer memory growth.

## Verification

- `node test-base-game-water.mjs`
- `node test-base-game-terrain.mjs`
- `node test-audit-doc.mjs`
- Browser capture in terrain mode, standing and walking, with `?gputime=1` (pending manual run)
