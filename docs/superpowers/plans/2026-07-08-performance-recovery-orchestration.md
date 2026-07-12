# Performance Recovery Orchestration Plan (Sonnet Agents)

> **For agentic workers:** This is an orchestration plan. The orchestrator (Fable session) dispatches one Sonnet subagent per task below via the Agent tool (`model: "sonnet"`), reviews the diff and test output between tasks, and holds user checkpoints for browser perf captures. Tasks use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the July 5 performance envelope (median `cpuMs <= 11 ms`, `passPostMs <= 7 ms`, 60+ FPS on the current map/camera route) by executing the highest-return milestones of the four 2026-07-08 performance specs.

**Architecture:** Four sequential waves ordered by expected return (sky work skipped per user decision 2026-07-08). Wave 0 lands instrumentation plus a runtime **Perf A/B panel** so every later change is comparable live, not just via reload. Within a wave, agents run in parallel only when their file sets are disjoint; exactly one agent per wave may edit `environment-viewer.html`. Each wave ends with Node tests plus a user-run capture checkpoint against explicit regression gates before the next wave dispatches.

**Tech Stack:** Three.js r0.184 WebGPU/TSL, plain Node test scripts (`node test-<name>.mjs`), `python serve.py` + browser perf CSV capture (`?perf=on`, perf panel `csv` button).

**Source specs (agents must read the sections named in their prompt):**

- `docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md` (anchor spec — owns the primary regression)
- `docs/superpowers/specs/2026-07-08-water-performance-design.md`
- `docs/superpowers/specs/2026-07-08-trees-performance-design.md`
- `docs/superpowers/specs/2026-07-08-sky-performance-design.md` (**skipped** — user decision 2026-07-08; sky is not a material contributor to the regression. Its milestones live in the deferred backlog.)

---

## Why this order

The July 8 A/B captures split the regression: no-dressing baseline is 13.62 ms CPU vs July 5's 10.35 ms (**~3.3 ms terrain/global material cost**), and enabling dressing adds **~4.25 ms** more (material cost, not draw count). Water reflection runs a nested scene render every frame (**~2.3–2.7 ms**, and it re-renders terrain/trees/dressing, so every material win pays twice). Trees and sky are secondary but share cheap wins (frustum culling, redundant per-frame work).

Return ranking → wave order:

| Wave | Work | Expected return | Spec milestones |
|---|---|---|---|
| 0 | Instrumentation + A/B flags + Perf A/B panel | Enables measurement and live comparison (no perf change) | terrain-dressing M0, water design §1 flags |
| 1 | Terrain splat reduction, cheap scree, deadfall winding | ~3 ms + ≥1.5 ms + part of dressing delta | terrain-dressing M3B/3C, M1, M2 |
| 2 | Water reflection/caustic throttles + gates | ~1.0–1.5 ms | water design §2, §3, defaults from §1 |
| 3 | Trees + dressing frustum/cone culling, far cutoff, recull threshold | GPU-side; fewer survivors into render/shadow/reflection | trees M1–M4, terrain-dressing M5 |

**Deferred backlog (not dispatched in this plan; higher risk, lower return, or skipped):** packed dressing compute host (terrain-dressing M4), workerized dressing placement (M6), water ring-build worker (water §5), water shader quality tiers beyond flag scaffolding (water §4), tree quality presets / front-side leaves / async palettes (trees design §4–§7), and the **entire sky spec** (quality presets, placement coalescing, `aSize` removal, baked Milky Way, async celestial textures — skipped per user decision; revisit only if final verification shows sky as a measurable contributor).

---

## Orchestration rules

1. **Dispatch:** Agent tool, `subagent_type: "general-purpose"`, `model: "sonnet"`. Parallel dispatch (single message, multiple Agent calls) only for tasks marked parallel-safe in the same wave.
2. **One viewer-writer per wave.** `environment-viewer.html` is ~5700 lines and every subsystem wires into it. The task marked **[viewer]** in each wave is the only one allowed to edit it. All other agents in the wave expose module-level APIs/stats only.
3. **Between tasks:** orchestrator reads the diff (`git diff --stat` then targeted `git diff`), confirms test output was actually pasted by the agent, and spot-checks the doc + `agent_log.csv` updates happened. Reject and re-dispatch with corrections rather than patching agent mistakes silently.
4. **Between waves:** USER CHECKPOINT — user runs the capture matrix for that wave (60 s stationary on the standard camera route, same map) and drops the CSVs in the repo root. Orchestrator compares medians against the wave's pass gates before dispatching the next wave.
5. **Commits:** one commit per task, on the current branch (`sp1-webgpu-renderer-migration`), message format `perf(<subsystem>): <what>` + the standard co-author line. Agents commit only their own files.
6. **Regression gates (every wave, from the anchor spec):** stationary median `cpuMs` must not increase > 0.5 ms from the previous wave; p90 `cpuMs` must not increase > 1.0 ms; `renderDrawCalls` must not grow without a documented reason.
7. **Perf A/B panel (runtime comparison).** Wave 0 creates a `window.perfAB` control registry plus a "Perf A/B" section in the viewer's inline slider UI:
   - API (fixed names — later tasks depend on them): `perfAB.addToggle(label, initial, onChange)`, `perfAB.addSlider(label, initial, min, max, step, onChange)`, `perfAB.addSelect(label, initial, options, onChange)`. Registration must be safe from lazily loaded modules: modules call `window.perfAB?.addToggle(...)` so non-viewer agents can register controls without editing `environment-viewer.html`.
   - URL flags remain the source of truth for *initial* state and for reproducible capture runs; sliders mutate live state on top. The perf CSV logs the *current* value of every A/B-controlled setting per sample row, so a capture taken while toggling stays interpretable.
   - Formal wave-gate numbers always come from steady-state URL-flag captures, not mid-toggle recordings.
   - Shader-structure choices (terrain shader mode, scree material tier) are exposed as instant swaps by prebuilding both material variants at load; uniform/CPU values (rates, radii, cone widths, thresholds) are plain live sliders. One-way code fixes (deadfall winding) get no toggle — only the reversible part (`material.side`) does.

**Common prompt preamble** — paste this block verbatim at the top of every agent prompt below:

```text
You are working in G:\My Drive\Scripts\procedural-creature\workshop-webgpu on branch
sp1-webgpu-renderer-migration. Read CLAUDE.md in this directory first and follow it —
especially: update the owning docs/subsystems/<name>.md in the same change, and append
one row to agent_log.csv (date,subsystem,files,summary; append-only). Tests are plain
Node scripts run as `node test-<name>.mjs` from the repo root; run every test you touch
or that covers files you touch, and paste the real output in your final report. Do not
edit environment-viewer.html unless this prompt explicitly says you may. Commit exactly
once when done: `perf(<subsystem>): <summary>` with co-author line
"Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Your final report must list:
files changed, test commands + output, doc/log updates made, and any spec deviation.
```

---

## Wave 0 — Instrumentation, A/B flags, Perf A/B panel

### Task 0.1: Terrain/dressing/water flags + perf CSV fields + Perf A/B panel **[viewer]** 

**Files:**
- Modify: `environment-viewer.html` (URL flag block near lines 72–80 and 1002–1225; perfLog sample fields near 1437–1565; dressing init near 3615; water init near 3958)
- Modify: `terrain-loader.js:144-150` (accept forced legacy/flat texture mode)
- Modify: `dressing-gpu.js` (expose `stats()` counts if not already: groups, instances, draws)
- Modify: `water.js` (add missing setters only — no default changes in this wave)
- Modify: `docs/subsystems/terrain.md`, `docs/subsystems/rocks.md`, `docs/subsystems/water.md`, `docs/subsystems/infra.md`

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
(DISPATCHED 2026-07-08, completed as commit 76696f8.)

Implement Milestone 0 of docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md
plus the URL-flag scaffolding from section "1. Add explicit water performance flags" of
docs/superpowers/specs/2026-07-08-water-performance-design.md. Read both spec sections in full.

You MAY edit environment-viewer.html for this task.

1. URL flags, following the existing pattern at environment-viewer.html:72-80
   (const X = new URLSearchParams(location.search).get('x') || 'default'):
   - ?terrainTexture=splat|legacy|flat  (default 'splat'). 'legacy' forces
     applyTerrainTextures(..., { legacySplit: true }) via terrain-loader.js:144-150.
     'flat' skips the authored splat material and applies a single cheap
     MeshStandardNodeMaterial (diagnostic only).
   - ?waterReflection=on|off, ?waterReflectRate=1|2|3|4, ?waterReflectScale=0.25|0.5|0.75|1,
     ?waterCaustics=on|off, ?waterCausticRate=1|2|4|8, ?waterCausticRes=256|512|1024,
     ?waterQuality=low|medium|high. Parse them and pass through to water via existing
     setters (water.js already has setReflectRate; add setCausticRate/setCausticRes/
     setCausticsEnabled/setQuality as pass-through state setters in water.js if missing —
     wire but DO NOT change any default behavior in this task; defaults stay
     reflectRate=1, caustics on. Wave 2 changes defaults.)
   - Keep existing ?dressing=off working unchanged.

2. Perf CSV fields, added to the perfLog sample object (environment-viewer.html:1437-1565)
   so they appear as columns in the downloaded perf-<timestamp>.csv:
   - terrainTextureMode, terrainActiveSplatLayers, terrainTextureMeshes
   - dressingDraws, dressingGroups, dressingInstances, dressingMode
   - waterQuality, waterCausticRate (waterReflectionRate/ResolutionScale/LastMs already exist)
   Pull dressing counts from dressing-gpu.js stats — extend its stats() return if the
   counts are not already exposed. terrainActiveSplatLayers comes from the splat material
   build in terrain-textures.js (it already resolves the active layer list).

3. Perf A/B panel: create a window.perfAB control registry and a "Perf A/B" section in
   the existing inline slider UI of environment-viewer.html (follow the established
   inline-slider pattern; environment-ui.js is only the tab shell, do not build controls
   there). Exact API, which later agents will call from lazily loaded modules via
   window.perfAB?.addX(...):
     perfAB.addToggle(label, initial, onChange)
     perfAB.addSlider(label, initial, min, max, step, onChange)
     perfAB.addSelect(label, initial, options, onChange)   // options: string[]
   Controls registered before the panel DOM exists must be queued and flushed when the
   panel builds. In this task, register the water controls (they have runtime setters):
     - "Water reflection" toggle -> setReflectionEnabled
     - "Reflect rate" slider 1..4 step 1 -> setReflectRate
     - "Reflect scale" select [0.25,0.5,0.75,1] -> reflection target rescale
     - "Caustics" toggle, "Caustic rate" slider 1..8 step 1, "Caustic res" select
       [256,512,1024] -> corresponding setters
   Initial values come from the URL flags (or current defaults when absent).
   Do NOT add a terrain-mode runtime swap here — that arrives in Wave 1 when both
   material variants exist; terrainTexture stays URL-flag-only in this task.

4. CSV coupling: every perfAB-controlled setting must appear in the perf CSV sample row
   with its CURRENT value (not its initial flag value), so captures taken while
   toggling stay interpretable.

5. Verify flags do not change default rendering: with no query params the sampled CSV
   fields must show terrainTextureMode=splat and identical draw counts to before your change.

Tests: node test-terrain-splat.mjs and node test-frame-profiler.mjs must pass.
Update docs/subsystems/terrain.md (flag + loader change), rocks.md (dressing stats),
water.md (new setters/flags), infra.md (new CSV columns + the perfAB registry API,
which other subsystems will call).
```

- [x] **Step 2: Orchestrator review** — `git diff --stat`; confirm no water/terrain default changed (grep the diff for `reflectRate` default and `CAUSTICS`); confirm the new CSV field names match this plan exactly (later waves reference them). *(Done: commit `76696f8`; defaults intact — `causticRate: 1`, `CAUSTICS_ENABLED = true`, reflection on; all 9 CSV field names match. Note: commit necessarily includes pre-existing in-flight viewer/agent_log hunks from the same branch.)*

- [ ] **Step 3: USER CHECKPOINT — baseline capture matrix.** Four 60 s stationary captures, standard route:
  1. `?perf=on&dressing=off&terrainTexture=splat`
  2. `?perf=on&dressing=off&terrainTexture=legacy`
  3. `?perf=on&dressing=gpu&terrainTexture=splat`
  4. `?perf=on&dressing=gpu&terrainTexture=legacy`

  Expected: run 3 ≈ current baseline (~43 FPS / 17.9 ms); runs 1–2 quantify the splat-vs-legacy terrain delta. Record medians in this plan file under Wave 0 results before proceeding.

  **DONE 2026-07-09** — captures in `research/stats/perf-2026-07-09T11-*.csv`. Medians:

  | Run | FPS | cpuMs | drawCalls | passPostMs | gpuAwaitMs | reflLastMs | dressingDraws/Inst |
  |---|---:|---:|---:|---:|---:|---:|---|
  | dressing off + splat | 64.5 | 13.55 | 243 | 10.55 | 11.15 | 2.20 | 0 |
  | dressing off + legacy | 55.3 | 13.45 | 253 | 10.80 | 11.30 | 2.30 | 0 |
  | dressing gpu + splat | 55.4 | 15.37 | 262 | 11.25 | 12.30 | 2.60 | 13 / 2314 |
  | dressing gpu + legacy | 59.0 | 13.20 | 272 | 9.70 | 10.80 | 2.10 | 13 / 2314 |

  Interpretation: with dressing on, splat costs **+2.17 ms CPU / +1.55 ms passPost** vs legacy — confirms P1 as the biggest single target. Dressing adds **+1.8 ms CPU** on splat (smaller than the July 8 −4.25 ms measurement, but same direction). No-dressing cpuMs 13.55 is still ~3.2 ms above the July 5 envelope. Water reflection 2.1–2.6 ms every frame, as specced. The dressing-off legacy FPS median (55.3 vs 64.5 splat at near-identical cpuMs/gpuAwait) is inconsistent — likely capture noise (sample counts differ 160 vs 264); treat cpuMs/passPostMs as the reliable columns, not FPS. **Instrumentation gap found:** `terrainTextureMode` reports `none` for legacy runs — legacy path doesn't stamp the mode; fix assigned to Task 1.1 (owns terrain-loader.js).

---

## Wave 1 — Biggest material wins (three parallel agents)

Parallel-safe: Task 1.1 owns `terrain-textures.js`/`terrain-loader.js`, Task 1.2 owns `rocks.js` + viewer, Task 1.3 owns `deadfall.js`. No file overlap.

### Task 1.1: Terrain splat shader cost reduction (spec M3B + M3C)

**Files:**
- Modify: `terrain-textures.js` (layer loop 553–564, triplanar sample 542–546, moss/normal finalization 571–581)
- Modify: `terrain-loader.js` (pass material options)
- Test: `test-terrain-splat.mjs` (extend)

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
Implement Milestones 3B and 3C from
docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md (read sections
"P1", "3B: Triplanar Only for Slope-Relevant Layers", "3C: Top-K Runtime Cap" in full).
Do NOT implement 3A (per-mesh material subsets) or 3D (distant LOD) — deferred.

Do NOT edit environment-viewer.html. Expose everything as material-build options that
terrain-loader.js passes through; the ?terrainTexture flag wiring from Wave 0 already
selects the build path.

3B: In the terrain-textures.js layer loop (currently ~lines 553-564; every active layer
pays a 3-sample triplanar albedo + planar normal/AO + moss/macro hash per fragment):
add a per-layer `triplanar: boolean` classification. Only rock, and dirt/gravel on
steep slopes, use triplanar albedo; grass/forest/meadow/sand/beach use a single planar
albedo sample. Slope gating should reuse the existing slope/weight signal already
available in the shader — do not add new texture reads to decide.

3C: Add a material option maxShaderLayers (default 4). When the active layer list is
longer, keep the 4 dominant layers by total baked weight and drop the rest from the
compiled loop. Plumb an override so maxShaderLayers=6 is selectable for visual debug
(terrain-loader option; the flag wiring can come later, do not touch the viewer).

Perf A/B controls (Wave 0 landed a window.perfAB registry; register from module code
via window.perfAB?.addX(...), never by editing the viewer):
- Prebuild BOTH terrain material variants at load (full 6-layer triplanar AND
  reduced planar/top-4) and register
  perfAB.addSelect('Terrain shader', <initial>, ['reduced','full'], swapFn) where
  swapFn reassigns mesh.material on the terrain meshes — instant swap, no recompile
  hitch at toggle time. Initial value follows the maxShaderLayers/mode options.
- Make the 3B slope threshold a uniform and register
  perfAB.addSlider('Triplanar slope cutoff', <default>, 0, 1, 0.01, setUniformFn)
  so the cliff/flat boundary is tunable live.

TDD: extend test-terrain-splat.mjs first with failing assertions for (a) the layer
classification function (given the current map's six layers — grass, forest, dirt,
sand, beach, rock — exactly rock and steep-dirt classify triplanar) and (b) top-K
selection (six weighted layers in, four dominant out, order stable). Run it, see it
fail, implement, run again, paste passing output. Keep the classification/top-K logic
in plain exported functions so Node can test them without a GPU, following the
repo's CPU/GPU twin pattern.

Update docs/subsystems/terrain.md: new material options, classification rule, default cap.
```

- [x] **Step 2: Orchestrator review** — confirm the test diff shows a genuinely failing-first assertion; confirm no viewer edits; confirm `maxShaderLayers` default is 4. *(Done: commit `8398544`. No viewer edits; `DEFAULT_MAX_SHADER_LAYERS=4`; 27/27 tests after failing-first. Both variants prebuilt + perfAB select/slider registered from module code. Honest deviation documented in terrain.md: dirt/gravel/snow compile planar+triplanar reads blended by mix() (TSL static graph can't skip reads at runtime) — net win comes from the 5 always-planar layers (3→1 reads) and the top-4 cap. Bonus fix: legacy path now stamps terrainTextureMode='legacy'.)*

### Task 1.2: Cheap scree material (spec M1) **[viewer]**

**Files:**
- Modify: `rocks.js:172-231` (split `buildRockMaterial`)
- Modify: `environment-viewer.html:3697-3712` (wire scree groups)
- Test: `test-rocks-geometry.mjs` (run; extend only if material tier selection is testable in Node)

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
Implement Milestone 1 from
docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md (read sections
"P2" and "Milestone 1: Cheap Scree Material" in full).

You MAY edit environment-viewer.html, but ONLY the rock-group material wiring around
lines 3697-3712.

In rocks.js, split the current buildRockMaterial() into:
- buildBoulderMaterial(): the existing rich material (triplanar albedo/roughness/normal,
  moss, lichen hash) — rename, keep behavior identical.
- buildScreeMaterial(): one albedo sample or flat color, no triplanar, no normal map,
  no lichen noise, constant roughness scalar. Keep receiveShadow; do not cast shadows
  from scree unless it already does.
Keep buildRockMaterial() as a thin alias to buildBoulderMaterial() so any other caller
is unaffected.

In environment-viewer.html:3697-3712, route groups with t.scree to buildScreeMaterial(),
everything else to buildBoulderMaterial().

Perf A/B control: build both materials up front and register (from the rock wiring
code) perfAB.addToggle('Scree rich material', false, fn) where fn swaps the scree
groups' material between buildScreeMaterial() (off) and buildBoulderMaterial() (on) —
instant swap for live visual/perf comparison. Use window.perfAB?.addToggle so it is
a no-op if the panel is absent.

Run node test-rocks-geometry.mjs and node test-rocks-placement.mjs; paste output.
Update docs/subsystems/rocks.md: the two material tiers, which groups use which, and
the A/B toggle.
```

- [x] **Step 2: Orchestrator review** — confirm the viewer diff is confined to the rock wiring block; confirm the rich material path is unchanged (diff should show rename only). *(Done: commit `7b77046`. Rename + alias + new `buildScreeMaterial` only; viewer diff 56 lines, all in the wiring block; tests 22/22 + 27/27. Toggle swap correctly re-applies dressing-gpu position/normal nodes via captured `nodes` — documented in rocks.md.)*

### Task 1.3: Deadfall winding fix, drop blanket DoubleSide (spec M2)

**Files:**
- Modify: `deadfall.js:354-362, 405-407` (Grower winding, material sides)
- Test: `test-deadfall-geometry.mjs` (extend)

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
Implement Milestone 2 from
docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md (read sections
"P5" and "Milestone 2" in full). Do NOT edit environment-viewer.html.

Fix the Grower triangle/quad winding in deadfall.js so closed logs and stumps render
correctly with THREE.FrontSide. Then remove the blanket DoubleSide: logs/stumps use
FrontSide; keep DoubleSide only for genuinely two-sided sheets (shelf fungus, gill
discs) — via a separate material or group flag, per the spec.

TDD: extend test-deadfall-geometry.mjs first with a failing winding assertion — for a
closed log/stump geometry, computed triangle normals must point outward (dot(normal,
vertex - segmentCenter) > 0 for a sample of triangles). Run it, see it fail against
current winding, fix, run again, paste passing output. Also run
node test-deadfall-placement.mjs.

Perf A/B control: the winding fix itself is one-way (no toggle), but register
perfAB.addToggle('Deadfall double-sided', false, fn) from deadfall.js via
window.perfAB?.addToggle, where fn flips the log/stump material between FrontSide
(off) and DoubleSide (on) at runtime (set material.side, mark needsUpdate) so the
cost difference is comparable live. The fungus/gill two-sided materials stay
DoubleSide regardless of the toggle.

Update docs/subsystems/rocks.md (deadfall is documented under the rocks/dressing
subsystem doc — check where deadfall.js is covered and update there).
```

- [x] **Step 2: Orchestrator review** — winding test failed first, then passed; confirm mushroom/fungus visuals still have a two-sided path. *(Done: commit `bfafa6a`. Two distinct winding bugs found via TDD — sweepTube side quads and buildStump top-cap fan; test failed 26/260 + 168/182 first, now 37/37 + 25/25. Mushroom material keeps DoubleSide. Accepted deviation: shelf fungus stays baked into FrontSide log geometry (per-triangle material split needs the dressing-gpu host, out of scope) — CHECK AT WAVE 1 CHECKPOINT: shelf fungi visible from below/behind?)*

### Task 1.4 (interlude, added 2026-07-09 by user request): Auto-save perf captures with context **[viewer]**

**Files:**
- Modify: `serve.py` (POST endpoint writing to `research/stats/`)
- Modify: `environment-viewer.html` (perfLog auto-upload + context columns)
- Modify: `docs/subsystems/infra.md`

- [x] **Step 1: Dispatch agent** — perfLog auto-posts the CSV to `serve.py` on recording stop and on page unload (sendBeacon); filename `perf-<ISO>-<sanitized query string>.csv`; new per-sample context columns: `queryString`, `camX`, `camY`, `camZ`, `camHeading`, `camSpeed`. Manual download button stays. *(Done: commit `193aab6`.)*
- [x] **Step 2: Orchestrator review** — path sanitization on the endpoint (no directory traversal); no behavior change when the server endpoint is absent (e.g. viewer served another way). *(Done: strict regex + basename + `..` reject, live-tested with 3 traversal variants → 400; collision → `-2` suffix; upload failure = one console.warn + manual button unchanged.)*

- [ ] **Wave 1 USER CHECKPOINT:** two captures, `?perf=on&dressing=gpu&terrainTexture=splat` and `?perf=on&dressing=off&terrainTexture=splat`. Pass gates (vs Wave 0 runs 3 and 1): dressing-on `cpuMs` median improves ≥ 1.5 ms and `passPostMs` ≥ 1.0 ms (scree win); dressing-off approaches `cpuMs <= 11.5`, `passPostMs <= 7.5` (splat win). Visual check: scree still reads as ground scatter at walking height; no inside-out logs; no terrain seams on cliffs. If splat visuals regressed on cliffs, re-dispatch 1.1 agent to tune the slope threshold before proceeding.

---

## Wave 2 — Water throttles and gates (one agent)

### Task 2.1: Reflection/caustic throttling, visibility gates, new defaults + frame cap **[viewer]**

*(Scope extended 2026-07-09 per thermal findings: also add a frame-rate cap — `?fpsCap=60|40|30|off`, default 60 — implemented in the rAF loop, with a Perf A/B select and an `fpsCap` CSV column. Capping reduces boost-window heat generation and delays/softens the RTX 3060 Laptop thermal throttle documented in the Thermal validity rule.)*

**Files:**
- Modify: `water.js` (reflector updateBefore 561–645, CAUSTICS_ENABLED 468, CausticTextureNode.updateBefore 803–839)
- Modify: `environment-viewer.html` (water init ~3958: default changes; stats 1544–1553 if new counters)
- Modify: `docs/subsystems/water.md`

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
Implement design sections 2 ("Throttle nested renders independently") and 3 ("Gate
reflection and caustics by visibility and material strength") plus the default changes
from section 1, all from docs/superpowers/specs/2026-07-08-water-performance-design.md.
Read the whole spec. Do NOT implement section 4 (shader quality tiers) or section 5
(ring worker) — deferred; the ?waterQuality flag from Wave 0 may remain a stored
setting that only low-cost paths read.

You MAY edit environment-viewer.html, but only the water init/wiring (~line 3958) and
perf stats plumbing (~1544-1553).

1. Defaults: reflectRate 2 (was 1), caustics default to every 4th frame at 512px
   (spec allows off-by-default as the alternative — pick rate-4 so visuals survive;
   note the choice in docs). Wave 0 URL flags override all of these.
2. Caustic throttle: add a frame counter in CausticTextureNode.updateBefore
   (water.js:803-839) mirroring the reflection modulo throttle; on skipped frames the
   previous caustic render target must stay bound — never a blank texture.
3. Gates — skip the nested render entirely when:
   reflection: reflectMix <= 0 or reflectBrightness <= 0, or no water ring geometry
   is visible in the frustum;
   caustics: causticStrength <= 0, or light direction below horizon.
   Implement the cheap checks first; if frustum testing the water plane is not
   straightforward with existing helpers, land strength/ring-count gates and report
   the frustum gate as a deviation rather than hacking it.
4. Counters: waterReflectionPasses and waterCausticPasses accumulated per sample window
   into the perf CSV, so waterReflectionPasses/sampledFrames ~= 1/reflectRate is
   verifiable from the CSV alone.

5. Perf A/B: the water rate/scale/caustics sliders already exist from Wave 0 — verify
   they drive your new throttle/gate code paths correctly (rate slider must change the
   pass-ratio counters live). Add one new control via the registry:
   perfAB.addToggle('Water visibility gates', true, fn) enabling/disabling the
   section-3 gates so their cost/benefit is comparable live.

No Node test covers water; verify by code inspection plus a manual smoke check
instruction in your report (what to look for: no black-frame flicker on the water at
startup or when toggling rates). Update docs/subsystems/water.md with new defaults,
gates, and counters.
```

- [x] **Step 2: Orchestrator review** — confirm skipped frames keep prior targets bound (read the actual diff hunks in `updateBefore`); confirm defaults changed in exactly one place and URL flags still override. *(Done: commit `89527e1`. Defaults 2/4/512 changed only in the DEFAULTS block; agent's Node smoke test covered gates, overrides both directions, and no-blank-frame startup; frame cap default 60 with vsync-beat tolerance; skip-path audit found nothing needing hoisting — mp broadcast is on its own setInterval. Honest deviation: reflection frustum gate skipped (no clipmap-ring frustum helper exists) — strength + ring-count gates landed instead.)*

- [ ] **Wave 2 USER CHECKPOINT:** captures with defaults, `?waterReflection=off`, `?waterReflectRate=4`, `?waterCaustics=off`. Pass gates from the water spec: default `waterReflectionLastMs` < 2 ms (was 2.3–2.7); CSV pass-ratio matches configured rates; ≥ 1.0 ms median CPU recovered vs Wave 1 default capture; no blank reflection/caustic flicker.

---

## Wave 3 — Frustum/cone culling (two parallel agents)

Parallel-safe: Task 3.1 owns `forest-gpu.js`/`forest-cull.js` + viewer; Task 3.2 owns `dressing-gpu.js` only.

### Task 3.1: Trees — frustum cull, far cutoff, recull threshold, telemetry **[viewer]**

**Files:**
- Modify: `forest-gpu.js` (cull kernel 86–130, drawMesh 201–285, update/EPS 399–415)
- Modify: `forest-cull.js` (CPU twin — must stay hand-synced)
- Modify: `environment-viewer.html` (forest CSV fields)
- Test: `test-forest-cull.mjs` (extend), `test-forest-gpu-rebuild.mjs` (run)

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
Implement Milestones 1-4 from docs/superpowers/specs/2026-07-08-trees-performance-design.md
(read design sections 1, 2, 3 and the Instrumentation section in full). Do NOT implement
milestones 5-7 (quality presets, front-side leaves, async palettes) — deferred.

CRITICAL repo pattern: forest-cull.js is a hand-synced CPU twin of the TSL cull math in
forest-gpu.js, tested by test-forest-cull.mjs without a GPU. Every change to the GPU
cull kernel MUST be mirrored in forest-cull.js in the same commit. Write the CPU-twin
test first (TDD), then port to TSL.

You MAY edit environment-viewer.html, but only to add forest perf CSV fields.

1. Frustum/cone rejection in the cull kernel (forest-gpu.js:86-130): pass camera
   forward vector and horizontal-FOV cosine as uniforms; reject instances behind the
   camera beyond a rear margin and outside a conservative cone expanded by per-variant
   tree radius. Runs before LOD selection and atomic writes.
2. Hard far cutoff: treeMaxDrawRadius uniform; beyond-LOD2 instances are rejected, not
   billboarded forever. Default: bounded a comfortable margin past the current LOD2
   radius (read the current radii in the code and pick ~1.5x LOD2; document the value).
3. Recull threshold (forest-gpu.js:399-415): replace the EPS movement check with:
   recull when camera crosses a 1.5-world-unit cell OR heading changes > ~3 degrees
   (needed because culling is now view-dependent) OR data is dirty (chunk/LOD/quality
   change — keep existing forced paths).
4. Telemetry: expose from the module and wire into the perf CSV: forestReculls,
   forestSkippedReculls, forestRejectedFrustum, forestRejectedFar, forestLod0/1/2
   Instances, forestBillboardInstances (readback can piggyback on however
   forestVisibleVariants/forestDraws are surfaced today).

5. Perf A/B controls (register from forest-gpu.js via window.perfAB?.addX — the
   registry landed in Wave 0):
   - perfAB.addToggle('Forest frustum cull', true, fn) — bypass/enable the new
     cone rejection (uniform flag).
   - perfAB.addSlider('Forest cone margin', <default>, 0, 0.5, 0.01, fn) — the
     FOV-cosine padding.
   - perfAB.addSlider('Tree max draw radius', <default>, <lod2>, <3x lod2>, 5, fn).
   - perfAB.addSlider('Recull cell size', 1.5, 0.1, 5, 0.1, fn) and
     perfAB.addSlider('Recull angle deg', 3, 0.5, 15, 0.5, fn).
   All are uniforms/CPU thresholds — live sliders, no rebuild. With the HUD rejection
   counters this is how popping-vs-savings gets tuned at the checkpoint.

TDD in test-forest-cull.mjs: failing tests first for (a) behind-camera instance
rejected, (b) in-cone instance kept, (c) edge instance within radius margin kept
(anti-pop), (d) beyond-max-radius rejected, (e) recull trigger fires on cell crossing
and heading change but not on 0.01-unit drift. Paste fail-then-pass output. Also run
node test-forest-gpu-rebuild.mjs and node test-forest-placement.mjs.

Update docs/subsystems/vegetation.md: new uniforms, cutoff default, recull policy,
telemetry fields, and the twin-sync note.
```

- [x] **Step 2: Orchestrator review** — diff `forest-cull.js` against the TSL kernel changes side-by-side for drift; confirm rear/cone margins exist (anti-pop); confirm the forced-recull paths survived. *(Done: commit `1ed09a8`. Cone margin 0.5 (wider than dressing per canopy-pop risk) + rear margin 0.1 + per-instance angular pad via atan2(treeRadius, dist); far cutoff lodR2×1.5=875; 1.5-unit/2° recull thresholds matching dressing; 23/23 twin tests fail-first, rebuild 8/8 + placement 13/13 green; viewer diff confined to CSV fields; dirty paths intact.)*

### Task 3.2: Dressing — frustum/cone culling (spec M5)

**Files:**
- Modify: `dressing-gpu.js` (cull kernel 109–113, radial gate 164)
- Test: none exists for dressing GPU math — agent adds `test-dressing-cull.mjs` with a CPU twin function

- [ ] **Step 1: Dispatch agent** with the preamble plus:

```text
Implement Milestone 5 from
docs/superpowers/specs/2026-07-08-terrain-dressing-performance-design.md (read sections
"P4" and "Milestone 5" in full). Do NOT edit environment-viewer.html. Do NOT implement
Milestone 4 (packed compute host) — deferred; keep the per-group kernel structure.

Add camera forward vector + FOV-cosine uniforms to the dressing cull kernel
(dressing-gpu.js:109-113): reject instances behind the camera or outside a WIDE
expanded cone (spec says do not be aggressive — generous padding, instances are small
and dense so popping is very visible). Keep the existing radial distance limit.

Repo pattern: GPU cull math gets a hand-synced CPU twin for Node testing (see
forest-cull.js / test-forest-cull.mjs as the model). Create dressing-cull.js exporting
the classification function and test-dressing-cull.mjs, TDD: failing tests for
behind-camera rejection, wide-cone keep at screen edge, radial limit unchanged. Paste
fail-then-pass output.

Expose rejectedFrustum count via the existing stats() so the Wave 0 CSV fields can pick
it up later without viewer edits now.

Perf A/B controls (register from dressing-gpu.js via window.perfAB?.addX — no viewer
edits needed):
- perfAB.addToggle('Dressing frustum cull', true, fn) — bypass/enable (uniform flag).
- perfAB.addSlider('Dressing cone margin', <default>, 0, 0.6, 0.01, fn) — keep the
  default generous; the slider exists precisely so the user can find the narrowest
  non-popping width live on dense scree.

Update docs/subsystems/rocks.md (dressing GPU section): uniforms, cone width choice,
new twin file, A/B controls.
```

- [x] **Step 2: Orchestrator review** — cone padding is generous (compare against forest's margin); twin + test committed together with the kernel change. *(Done across two commits, dispatched early on 2026-07-09 in parallel with Wave 2: `e1a3ff8` cone cull with 0.35 cosine margin over vertical-FOV cosine + `dressing-cull.js` twin, 15 tests; orchestrator review caught exact-float dirty checks → follow-up `a2be85e` added 1.5-unit/2° threshold-gated reculls with `shouldRecull` predicate, skipped/executed counters, coupling comments both sides, 25 tests. Verified: forced-dirty short-circuits thresholds.)*

### Task 3.3 (added 2026-07-09 from the expensive-list review): Tree leaf/billboard side policy

- [x] Dispatched and completed as commit `be0359a` (trees spec §5, promoted from deferred backlog). Findings: leaf cards had NO winding bug (verified analytically + against generated trees — honest no-fake-test); billboards had a REAL winding bug (front face pointed away from camera — every billboard was rendering its backface; fail-then-pass proven). Billboards now FrontSide; L1 + coarse-L2 leaves FrontSide; L0 close leaves stay DoubleSide (spec's sanctioned partial win — backface-duplication rejected with vertex-cost math: would double ~7200 verts/variant). 'Tree leaves double-sided' perfAB toggle covers exactly the switchable materials. Tests 10/10 new + full forest regression green; orchestrator re-ran tests locally to confirm.

- [ ] **Wave 3 USER CHECKPOINT:** default capture plus a rotate-in-place capture in dense forest/scree. Pass gates: rejected-counts nonzero when looking away; no visible popping at screen edges while rotating or walking (use the live cone-margin sliders to find safe values, then bake them in as defaults); `forestSkippedReculls` > 0 while strafing slowly; stationary median within regression gates vs Wave 2.

---

## Thermal validity rule (added 2026-07-09)

The dev machine is an RTX 3060 Laptop GPU that thermal-throttles under sustained load: telemetry (`research/stats/gpu-telemetry-*.csv`, helper on port 8080) shows 86°C peaks with core clocks sagging 1650→1160 MHz (−30%) and power 83→34 W over ~3 minutes, while perf captures at *constant workload* show all GPU pass timings inflating proportionally (passPostMs 8.9→13.9, gpuAwait 9.3→15.2) and cpuMs growth ≈ gpuAwait growth. Consequences for every gate comparison:

1. **Warm-window medians only:** discard the first 60 s of every capture (shader compile + boost-clock flattery); compare equal-length windows at equal session offsets.
2. **Join GPU telemetry:** every gate table row must report median `clocks.gr` from the matching `gpu-telemetry-*.csv`; two captures are only comparable if their median core clocks are within ~10%. A "regression" at 1200 MHz vs a "baseline" at 1650 MHz is a thermal artifact, not a code result.
3. The July 5 envelope numbers carry unknown thermal state — treat them as directional, not exact.
4. The user-facing goal restates as: **hit 60 FPS at the sustained (throttled) clock**, not at boost clock. Reducing sustained GPU load both raises FPS directly and delays/reduces the throttle itself.

Related evidence from the same investigation: with dressing on, the 169-chunk window (`dressingRadiusChunks=6`) fills to ~43–48k records over minutes and every chunk crossing re-sorts all records (`passDressingMs` spikes to 17 ms) — promotes M4 (packed host) and M6 (worker/cache placement) from deferred to post-Wave-3 candidates. First-person mode raises baseline GPU load (ground-level alpha overdraw), which both costs FPS directly and accelerates throttling.

## Final verification (after Wave 3)

- [ ] User runs the full matrix from the anchor spec: stationary / slow pan / walk, 60 s each, defaults only.
- [ ] Orchestrator checks against the overall goal: median `cpuMs <= 11 ms`, `passPostMs <= 7 ms`, median FPS >= 60, `waterReflectionLastMs < 2 ms`, `forestDraws <= 24`.
- [ ] If the goal is not met, the gap analysis (which CSV column is still fat) decides which deferred-backlog item gets promoted — most likely terrain 3A/3D or the packed dressing host; check sky contribution via the existing `?sky=off`/`?sky=domeonly` modes before promoting any skipped sky work.
- [ ] Orchestrator appends a summary row to `agent_log.csv` (`multi` subsystem) and records final numbers in this file under a "Results" heading.
- [ ] Run `superpowers:finishing-a-development-branch` to decide merge/PR.

## Results

(filled in at each checkpoint)

| Checkpoint | FPS med | cpuMs med | passPostMs | waterReflectionLastMs | renderDrawCalls | Notes |
|---|---:|---:|---:|---:|---:|---|
| Wave 0 baseline (dressing on) | 55.4 | 15.37 | 11.25 | 2.60 | 262 | splat; dressing 13 draws / 2314 inst |
| Wave 0 baseline (dressing off) | 64.5 | 13.55 | 10.55 | 2.20 | 243 | splat |
| After Wave 1 | | | | | | |
| After Wave 2 | | | | | | |
| After Wave 3 (final) | | | | | | |
