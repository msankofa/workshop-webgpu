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
- **SP6 spec + plan committed.** NOTHING in SP6 implemented yet. Next action = **Plan Task 1, Step 1**.

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
