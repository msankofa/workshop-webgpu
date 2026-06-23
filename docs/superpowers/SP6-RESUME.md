# SP6 Resume Handoff (inline execution)

_Written 2026-06-23 before a context compaction. Read this + the plan to continue._

## What I'm doing
Implementing **SP6 GPU-instanced forest**, INLINE (task-by-task in this session, checkpoints
between). The user chose inline over subagents to reuse context. Token-sensitive user: be concise,
no narrating, no re-reading files already cited in the plan.

## Read these two first
- **Plan:** `docs/superpowers/plans/2026-06-23-sp6-forest-gpu-instanced.md` — the task-by-task steps. Follow it.
- **Spec:** `docs/superpowers/specs/2026-06-23-sp6-forest-gpu-instanced-design.md` — design rationale.

## Current state
- Branch `sp1-webgpu-renderer-migration`, working tree clean. Node v20. Tests run with `node test-*.mjs`.
- **SP5 done** (A: analytic terrain collision, octree retired; B: trunk collision player+creatures, push-out + steering). Committed.
- **SP6 Tasks 1-5 committed** (code complete). Next action = **browser checkpoint of `?forest=gpu`**, then Task 6 (dd9 A/B + docs).
  - T1 `forest-placement.js` + test (7 pass) — ports the LIVE baker placement (placementsForChunk + treeCountForChunk + per-tree RNG order incl. the seed draw) so gpu matches baked.
  - T2 `forest-cull.js` + test (4 pass) — distance cull twin.
  - T3 `forest-palette.js` — bakes V variant geoms once; flat per-species color baked in (generator geom has no color attr).
  - T4 `forest-gpu.js` — global V*CAP src buffer (CPU-filled on chunk change), one compute cull+compact, per-variant indirect draws. **Unverified TSL.**
  - T5 `environment-viewer.html` — `FOREST_MODE` flag, `regenerateGPU` (records+trunks per chunk), awaited per-frame update, HUD/perf fields. Baked path kept as `?forest=baked`.
- **Likely TSL iteration points** (HANDOFF gotchas): integer index casts on `srcCounts.element(g)`/`survCounters.element(g)` (g is int), `uint()` vs `bitcast`, awaited compute order. maxDist is static (View distance at build; not re-wired to the slider).

## Scope reminder
This plan = **GPU path only** (`?forest=gpu`, default). Keep the existing main-thread baked forest as
`?forest=baked` (interim A/B baseline). The **worker path** (`?forest=worker`) is a SEPARATE plan, later.

## Execution order (from the plan)
1. **Task 1** — `forest-placement.js` + `test-forest-placement.mjs` (pure placement records). TDD: write test, run red, implement, green, commit.
2. **Task 2** — `forest-cull.js` + `test-forest-cull.mjs` (distance cull twin; v1 is distance-only per SP2). TDD.
3. **Task 3** — `forest-palette.js` (bake variants). Browser checkpoint (human).
4. **Task 4** — `forest-gpu.js` (instance buffers + cull compute + indirect draws). Browser checkpoint, 1-3 TSL iterations expected.
5. **Task 5** — viewer flag + record/trunk routing + per-frame update + HUD. Browser checkpoint.
6. **Task 6** — dd9 A/B trace (gpu vs baked), fold into notes + paper, sync `../workshop/research/webgpu/`, update HANDOFF.

## Two transcription points to read at Task 1 (I did NOT inline these)
- `sizeFor` body — `environment-viewer.html:618` (returns tree scale from maxSize/sizeVar/skew + rng). Transcribe verbatim into `forest-placement.js`.
- `placements` per-chunk loop — `environment-viewer.html:605-676` (ring/clustered/scattered/random + keepDry water mask + base+extra distribution). I read through :659; read :660-676 for the `random` branch tail. Port verbatim so behavior is identical.
- Per-tree rng/species/yaw derivation — `environment-viewer.html:806,826-828` (already cited in the plan).

## Hard constraints (project)
- **No headless WebGPU** — prove math in Node, hand GPU/TSL to a browser checkpoint (human reloads `http://localhost:8001/environment-viewer.html`). Don't claim GPU behavior I haven't had confirmed.
- Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Small, frequent commits.
- Paper: no em-dashes, no editorializing; don't overclaim "flat fps" (worker/forest nuance).
- Grass template to copy patterns from: `grass-compute.js` (buffers :81-87, kernels :122-163, indirect draw :166-168, awaited computeAsync :215-221).
- After paper/notes changes, sync to `../workshop/research/webgpu/` (copy only; that dir is not git).

## Stop-hook / goal
No active goal hook expected post-compaction. Just continue inline from Task 1. Pause for the human at
each browser checkpoint (Tasks 3,4,5) — I cannot verify WebGPU myself.
