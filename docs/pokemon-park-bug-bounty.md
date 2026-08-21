# Pokémon Park Performance Bug Bounty

Target: `demos/pokemon-park.html`

Status: Open investigation and remediation list.

This document separates unavoidable rendering work from avoidable frame-time spikes. A costly feature is not automatically a bug; a bounty is earned by showing that its implementation produces unnecessary stutter and by fixing it without unacceptable visual or behavioral regressions.

## Priority and confidence

- **P0:** correctness defect or severe frame-pacing failure
- **P1:** likely primary contributor to visible stutter
- **P2:** meaningful secondary contributor
- **P3:** low-impact cleanup or compounding overhead
- **Confirmed:** directly demonstrated by code behavior
- **High:** strong static evidence; runtime capture should identify magnitude
- **Medium:** credible contributor that still requires profiling

## Shared benchmark protocol

Every performance bounty should include:

1. Before-and-after captures using the same browser, GPU, window size, display refresh rate, seed, population, camera route, and quality flags.
2. A cold-cache run for loading work and a warm-cache run for steady-state work.
3. At least 60 seconds of steady-state data after boot, plus a repeatable traversal through tree, rock, and water chunk boundaries.
4. Frame-spacing p50/p95/p99/max, main-thread long tasks, GPU time when available, and the HUD's worst-frame value.
5. A visual-regression check for popping, missing effects, stale indirect counts, incorrect shadows, collision failures, and resource leaks.

Unless an issue specifies a different gate, success means:

- The targeted spike is identifiable in the baseline and absent or at least 50% smaller after the change.
- Frame-time p95 and p99 do not regress elsewhere by more than 5%.
- No new console errors or validation errors occur.
- Repeating the test three times produces the same conclusion.

## Runtime isolation findings (2026-08-19)

- Disabling Pokémon eliminates the intermittent stutters while producing little or no change in draw calls or steady FPS. Live sub-isolation then identified **move casting** as the trigger: simulation, rendering, and streaming can remain enabled without the same intermittent freezes when only move casting is off.
- Disabling flora removes roughly 100 draw calls and raises steady performance from about 30–40 FPS to roughly 75 FPS. Flora is the dominant sustained GPU/rendering bottleneck, separate from the Pokémon hitch.
- Further live isolation identifies **tree rendering** as the dominant flora cost: disabling tree rendering raises performance from roughly 30–50 FPS to about 75 FPS.
- Disabling shadows removes roughly another 100 draw submissions and improves FPS, confirming a substantial but secondary sustained rendering cost.
- The earlier 900-to-740/750 peak-draw change came from disabling the entire water system; no individual water scheduling improvement was established.
- The park now exposes live flora controls for grass/tree/rock rendering, their three independent compute/streaming paths, flora collisions, and flora shadows. Move controls independently isolate creation, active updates, all rendering, lights, core geometry, particles/debris and particle load, and decals.

## Open bounties

### PP-BB-001 — Refresh-rate-unsafe frame limiter

- **Priority:** P0
- **Confidence:** Confirmed
- **Status:** Mitigation retained; playtest says not a primary bottleneck
- **Classification:** Avoidable frame-pacing defect
- **Likely cause:** The default 60 FPS cap skips `setAnimationLoop` callbacks using a fixed elapsed-time threshold. It works cleanly when display refresh is a multiple of 60, but can settle near 37.5 FPS at 75 Hz, 45 FPS at 90 Hz, 48 FPS at 144 Hz, or 55 FPS at 165 Hz.
- **Implemented:** Normal and invalid-query launches now default to uncapped VSync cadence. Numeric caps remain available only as explicit best-effort profiling or thermal controls.
- **Playtest result:** With the uncapped default, the scene still fluctuated between 20–40 FPS, 600–900 draws, and 1–2 million triangles. The limiter was not the cause of the near-unplayable intermittent freezes; the result instead confirms a substantial workload bottleneck.
- **Potential solutions:**
  - Remove the default cap and use uncapped VSync.
  - Use a refresh-aware divisor selected from measured animation-loop cadence.
  - Use an accumulator with presentation-aware pacing rather than stamping only rendered callbacks.
  - Keep thermal limiting as an explicit user option rather than the default.
- **Test for success:**
  - Test at 60, 75, 90, 120, 144, and 165 Hz.
  - A selected 60 FPS target must average within 2 FPS where the display can present it, without alternating long/short frame intervals or collapsing to a refresh divisor below 60.
  - `?fpsCap=off` and the repaired capped mode must both remain stable.
- **Evidence:** `demos/pokemon-park.html:144`, `demos/pokemon-park.html:1176-1194`

### PP-BB-002 — Rejected species load remains cached and grows the error DOM

- **Priority:** P0
- **Confidence:** Confirmed
- **Status:** Implemented 2026-08-18; awaiting failure-path playtest
- **Classification:** Correctness and degradation bug
- **Likely cause:** `ensureSpecies()` removes a species from `pending` only after success. A rejected promise remains cached. Nearby residents repeatedly receive the same rejection, and each failure appends more text to `#err`.
- **Potential solutions:**
  - Delete the pending entry in a `finally` block.
  - Add a terminal failed-species state with one visible error and exponential retry/backoff.
  - Deduplicate errors by species and error signature.
  - Prevent failed residents from being requeued every streaming tick.
- **Implemented:** Failed species now enter a bounded terminal map, pending entries are cleared in `finally`, normal streaming skips terminal failures, duplicate error text is suppressed, and `retrySpecies` provides an explicit retry path.
- **Test for success:**
  - Force one model URL to return 404 or malformed GLB data.
  - Exactly one user-facing error should be recorded per failed species.
  - Error DOM size, queue length, network requests, and frame time must remain bounded for five minutes.
  - A deliberate retry must be possible after the underlying asset is repaired.
- **Evidence:** `park-creature.js:60-100`, `demos/pokemon-park.html:128-132`, `demos/pokemon-park.html:442-450`

### PP-BB-003 — Runtime species parsing, cloning, upload, and pipeline warm-up hitches

- **Priority:** P1
- **Confidence:** High
- **Status:** Implemented; playtest says little or no material improvement
- **Classification:** Necessary streaming with avoidable gameplay spikes
- **Likely cause:** Only six species load before control is handed to the player. Remaining species perform GLB parsing, rig mapping, scene traversal, texture/buffer upload, and `renderer.compileAsync()` while gameplay is active. One-at-a-time loading prevents overlapping hitches but does not remove each hitch.
- **Potential solutions:**
  - Preload a larger local working set before opening the gate.
  - Parse GLB metadata and perform compatible decoding in workers.
  - Schedule main-thread parse/clone work through a measured idle-time budget.
  - Separate fetch, decode, upload, compile, and spawn into independently budgeted phases.
  - Persist a pipeline/material warm-up manifest and prewarm during boot.
- **Implemented:** Every species in the population plan now loads serially and runs `compileAsync` behind the boot screen before gameplay. `?speciesLoad=stream` retains the previous six-at-boot, nearest-first runtime path for direct A/B testing.
- **Playtest result:** Preloading did not materially improve the observed stutter. Runtime species parsing is not the dominant bottleneck in the tested scene.
- **Test for success:**
  - Cold-load all species while traversing the standard route.
  - No individual species arrival may create a main-thread task longer than the target frame budget or a frame over 25 ms at a 60 FPS target.
  - The HUD loading counter must drain, all species must remain spawnable, and warm-cache behavior must not regress.
- **Evidence:** `demos/pokemon-park.html:439-458`, `demos/pokemon-park.html:1121-1137`, `park-creature.js:60-85`

### PP-BB-004 — Water pass cadence creates periodic heavy frames

- **Priority:** P1
- **Confidence:** High
- **Status:** Implemented 2026-08-18; no isolated improvement confirmed
- **Classification:** Optional visual cost with avoidable burst scheduling
- **Likely cause:** Reflection renders every third frame and caustics every fourth frame, while refraction copies the framebuffer. Reflection and caustics coincide every twelfth frame, producing a repeating high-cost frame.
- **Potential solutions:**
  - Distribute expensive water passes using a shared scheduler that avoids coincident updates.
  - Update passes according to elapsed time and available frame budget instead of frame-number modulus.
  - Reproject or interpolate older reflection/caustic results.
  - Dynamically reduce resolution or update frequency under GPU pressure.
- **Implemented:** Reflection and caustics now use one application-frame scheduler. At most one nested heavy water render may run per gameplay frame; cadence collisions are deferred and alternated rather than coinciding or starving one pass. Renderer-internal nested `frameId` changes no longer drive the cadence.
- **Playtest correction (2026-08-19):** The observed drop from about 900 peak draws to roughly 740–750 came from running with the entire water system disabled, not from the shared scheduler. The scheduler's individual effect remains unproven, and water is no longer considered the primary cause of the remaining intermittent freezes or roughly 600-draw baseline.
- **Test for success:**
  - Capture at least 30 seconds with water on and graph frame time by frame index modulo 12.
  - The repaired version must show no statistically significant twelfth-frame spike.
  - Water-on p99 frame time should approach the water-off baseline while reflection and caustics remain visually stable.
- **Evidence:** `demos/pokemon-park.html:348-362`, `water.js:559-574`, `water.js:862-899`

### PP-BB-005 — Water clipmap snap causes geometry creation and disposal bursts

- **Priority:** P2
- **Confidence:** High
- **Status:** Implemented 2026-08-19; deprioritized pending snap-specific evidence
- **Classification:** Necessary world streaming with avoidable resource churn
- **Likely cause:** Crossing water snap cells builds and commits new `BufferGeometry` objects, replaces meshes, and later disposes old geometry. Budgeting limits generation time but does not eliminate allocation, upload, and commit spikes.
- **Potential solutions:**
  - Reuse a fixed pool of ring geometries and GPU buffers.
  - Update existing buffer ranges instead of replacing geometry objects.
  - Prebuild the next snap state ahead of camera movement.
  - Coordinate water commits with flora uploads so both cannot land in the same frame.
- **Implemented:** Each of the three ring slots now retains one mesh pair and one `BufferGeometry`. Snap commits update dynamic vertex/depth/index buffers in place, grow capacities geometrically only when required, use draw ranges for live indices, and hide dry rings instead of replacing and disposing resources. Stats expose geometry creates, reuses, and buffer growth events.
- **Triage note:** Disabling water changes the peak draw count but does not establish ring snapping as the source of the remaining stutter. Do not spend further primary-stutter effort here unless a capture correlates hitches with snap commits.
- **Test for success:**
  - Traverse repeatedly across the same water snap boundary.
  - Geometry and GPU-buffer object counts must plateau after warm-up.
  - Snap frames must remain within 10% of neighboring-frame CPU and GPU time, with no visible cracks or stale rings.
- **Evidence:** `water.js:981-1042`, `water.js:1059-1088`

### PP-BB-006 — Flora chunk changes trigger full source-buffer rebuilds and uploads

- **Priority:** P1
- **Confidence:** High
- **Status:** Live tree and rock render/update isolation controls installed; optimization pending measured result.
- **Classification:** Necessary streaming with avoidable rebuild scope
- **Isolation tooling:** Trees now have persistent bark, foliage, billboard, bark-shadow, and leaf-shadow masks; live tree/leaf-layer scale, density, draw distance, three LOD thresholds, cone culling/margin, and recull cadence controls. Density regenerates both placement and trunk collision data on slider release.
- **Likely cause:** Tree and rock chunk changes generate placement/collision records and eventually rebuild large source buffers. Tree batching reduces the number of rebuilds, but each flush still rescans the active window and uploads roughly a megabyte.
- **Potential solutions:**
  - Give chunks stable slots in persistent GPU buffers.
  - Upload only inserted, removed, or modified ranges.
  - Maintain per-chunk indirection tables instead of flattening the complete active window.
  - Move placement generation to workers and cap commit/upload bytes per frame.
- **Test for success:**
  - Follow a route crossing at least ten tree and rock chunk boundaries.
  - No full active-window buffer upload should occur for a single chunk mutation.
  - Upload bytes and CPU rebuild time must scale with changed chunks, not total resident chunks.
  - Chunk-crossing p99 frame time must improve by at least 50%.
- **Evidence:** `park-flora.js:346-415`, `forest-gpu.js:403-477`, `dressing-gpu.js:205-250`

### PP-BB-007 — Flora compute submissions are serialized before rendering

- **Priority:** P1
- **Confidence:** Medium-high
- **Status:** Grass, tree, and rock work paths can now be disabled independently during play.
- **Classification:** Correctness-required ordering with avoidable submission overhead
- **Likely cause:** The frame awaits grass, forest, and dressing updates sequentially. Each subsystem may call `renderer.computeAsync()`; while the callback is pending, `_frameBusy` discards subsequent animation-loop callbacks.
- **Potential solutions:**
  - Combine legal flora kernels into one ordered compute submission and one await.
  - Skip all unchanged subsystems before entering async work.
  - Measure and prioritize reculls through one frame-budget scheduler.
  - Preserve compute-before-draw ordering for indirect counts.
- **Test for success:**
  - Instrument compute submission count and duration per frame.
  - A flora recull frame should use one combined submission where dependencies permit.
  - No grass blinking, stale indirect counts, tree popping, or WebGPU validation errors may occur.
  - Missed animation callbacks during normal traversal must decrease measurably.
- **Evidence:** `demos/pokemon-park.html:1185-1187`, `demos/pokemon-park.html:1241-1244`, `park-flora.js:433-438`

### PP-BB-008 — Third-person camera collision is allocation-heavy and oversampled

- **Priority:** P1
- **Confidence:** High
- **Classification:** Avoidable CPU and garbage-collection overhead
- **Likely cause:** The camera boom samples at 0.2 m increments, potentially performing roughly 56 checks at maximum distance. Player physics adds five collision checks per rendered frame. Flora collision gathering and result construction allocate arrays and objects.
- **Potential solutions:**
  - Replace incremental sampling with a segment cast, swept sphere, or spatial-index ray query.
  - Reuse scratch arrays and result objects.
  - Cache the local collision candidate set until the camera/player changes spatial cells.
  - Use adaptive stepping followed by a short binary search near the first obstruction.
- **Test for success:**
  - Profile first-person and third-person routes through dense forest.
  - Steady-state camera collision must allocate zero transient objects per frame.
  - Collision query count must be bounded independently of boom length.
  - No camera penetration or delayed boom response is allowed.
- **Evidence:** `demos/pokemon-park.html:703-797`, `park-flora.js:418-430`, `collision.js:97`

### PP-BB-009 — Move effects allocate and compile resources during casts

- **Priority:** P1
- **Confidence:** High
- **Status:** Confirmed by live subsystem isolation; first remediation installed for playtest.
- **Classification:** Avoidable resource-lifecycle and first-use hitch
- **Likely cause:** Some move effects construct node materials, meshes, and geometries per cast and dispose them afterward. First appearances compile pipelines, palette-keyed pools are initially empty, and multiple autonomous casts previously performed synchronous setup in the same simulation frame.
- **Potential solutions:**
  - Prewarm every enabled effect pipeline during boot, including each palette retained by palette-keyed pools.
  - Pool complete effect rigs, geometries, and materials.
  - Keep immutable geometry/material resources shared across instances.
  - Stagger autonomous casts when several become ready on the same frame.
- **Implemented:**
  - Boot now creates and compiles every runtime effect pipeline and all palette variants used by pooled effects, then returns pooled rigs before play opens.
  - Autonomous requests enter a bounded, deduplicated queue and at most one synchronous cast setup is performed per rendered frame.
  - The in-game Creatures panel reports last/peak synchronous cast setup time, move name, queue depth, and dropped requests.
  - Live component controls now isolate active-effect updates, all move rendering, pooled lights, core geometry, shared and tagged particles/debris, particle load, and ground decals. Aggregate active-effect update time and light-pool occupancy are reported in the panel.
- **Test for success:**
  - Cast each enabled move once, then run at least 100 mixed casts.
  - No pipeline compilation event should occur after boot.
  - Geometry, material, and GPU-resource counts must plateau.
  - First-cast and subsequent-cast frame times must differ by less than 10%.
- **Evidence:** `demos/pokemon-park.html:496-548`, `moves/fx-aura.js:276-361`, `moves/fx-dome.js:248-291`

### PP-BB-010 — Rendering quality is not adaptive to GPU capacity

- **Priority:** P1
- **Confidence:** High
- **Classification:** Scalability deficiency
- **Likely cause:** Pixel ratio can reach 2, a 2048² soft shadow map is always enabled, grass capacity reaches 600,000 blades, and water/environment effects retain fixed quality regardless of measured GPU headroom.
- **Potential solutions:**
  - Add dynamic resolution or a user-visible render-scale setting.
  - Implement quality tiers for shadow resolution, grass density/radius, water passes, cloud layers, and tree variants.
  - Use GPU/frame-time feedback with hysteresis rather than reacting to single frames.
  - Define a target-hardware profile and safe defaults.
- **Test for success:**
  - Test on at least one low-, mid-, and high-tier GPU at fixed viewport sizes.
  - The quality controller must converge on the target frame budget without oscillation.
  - Resolution/quality changes must not cause pipeline recompiles or visible rapid toggling.
- **Evidence:** `demos/pokemon-park.html:176-180`, `demos/pokemon-park.html:216-227`, `park-flora.js:11-25`

### PP-BB-011 — Shadow policy is unnecessarily broad

- **Priority:** P2
- **Confidence:** Medium-high
- **Classification:** Avoidable sustained GPU load
- **Likely cause:** Every loaded creature mesh is made double-sided and configured to cast and receive shadows. A moving 2048² PCF-soft directional shadow pass repeatedly processes a large and changing caster set.
- **Potential solutions:**
  - Preserve correct material sidedness instead of forcing `DoubleSide` globally.
  - Disable casting for tiny, distant, transparent, or visually insignificant meshes.
  - Add shadow LODs and caster-distance thresholds.
  - Update shadow maps only when the light/caster state changes enough to matter.
- **Test for success:**
  - Record shadow-pass GPU time and caster/draw counts on the same populated route.
  - Reduce shadow-pass p95 time by at least 30% without missing nearby contact shadows or introducing obvious light leaks.
  - Verify representative species with thin or mirrored geometry.
- **Evidence:** `demos/pokemon-park.html:216-254`, `park-creature.js:73-79`

### PP-BB-012 — Culling is fragmented and view-incomplete

- **Priority:** P2
- **Confidence:** Medium
- **Classification:** Performance architecture debt
- **Likely cause:** Creatures disable built-in per-mesh frustum culling and use coarse main-camera distance/cone visibility. Trees and rocks use padded GPU view cones, grass primarily uses camera-centered radius/cell culling, and reflection/shadow views do not share one view-specific world-culling system.
- **Potential solutions:**
  - Introduce group-level bounding volumes and exact frustum planes for creatures.
  - Add frustum rejection to grass before compaction.
  - Build view-specific visibility sets for the main, reflection, and shadow cameras.
  - Add terrain/structure occlusion only after profiling shows traversal or fragment cost warrants it.
- **Test for success:**
  - Capture draw/instance counts while looking toward and away from dense content.
  - Off-frustum content must be rejected for each relevant camera without edge popping.
  - Main-view, reflection, and shadow draw counts must decrease measurably while visible output remains equivalent.
- **Evidence:** `park-creature.js:73-79`, `park-creature.js:262-289`, `forest-gpu.js:598-648`, `dressing-gpu.js:329-375`

### PP-BB-013 — Nearby creature simulation and rig posing can create CPU/GC pressure

- **Priority:** P2
- **Confidence:** Medium
- **Classification:** Necessary simulation with optimization opportunity
- **Likely cause:** Up to 52 residents remain active. Visible nearby creatures run gait simulation, animation mixers, walker updates, bone posing, and casting logic. Distance striding helps far creatures but not dense nearby groups.
- **Potential solutions:**
  - Add simulation LOD tiers independent of render LOD.
  - Batch or stagger gait and AI updates across residents.
  - Remove matrix/object allocation inside bone loops.
  - Freeze or use cheaper impostor animation for distant and occluded creatures.
- **Test for success:**
  - Benchmark a deterministic 52-creature crowd facing the camera.
  - Creature update CPU p95 must meet an agreed budget and steady-state updates must allocate no per-bone temporary objects.
  - Locomotion, casting cadence, and visible pose quality must remain correct.
- **Evidence:** `park-creature.js:262-319`, `stadium-walker.js:779-926`

### PP-BB-014 — Resize, minimap, and HUD work can compound slow frames

- **Priority:** P3
- **Confidence:** High for occurrence, low for primary impact
- **Classification:** Avoidable UI/canvas churn
- **Likely cause:** Resize handling is unthrottled and reallocates renderer/minimap backing stores. The minimap redraws at 20 Hz and creates a closure per draw; the HUD replaces `innerHTML` every 250 ms even when most values are unchanged.
- **Potential solutions:**
  - Coalesce resize work to one animation frame and ignore unchanged dimensions.
  - Hoist minimap helpers and dirty-check map content.
  - Update only changed HUD text nodes.
  - Schedule UI work away from frames already carrying streaming commits.
- **Test for success:**
  - Continuously resize the window for ten seconds and verify at most one size commit per animation frame.
  - With a stationary player, unchanged HUD/minimap state should perform no unnecessary DOM or backing-store writes.
  - Confirm that disabling the UI no longer materially changes p99 frame time.
- **Evidence:** `demos/pokemon-park.html:855-901`, `demos/pokemon-park.html:1159-1170`, `demos/pokemon-park.html:1255-1262`

### PP-BB-015 — Resident streaming scans and sorts the full population periodically

- **Priority:** P3
- **Confidence:** Medium
- **Classification:** Avoidable periodic CPU work
- **Likely cause:** Every streaming update scans all planned residents, computes distances, creates a new tier map and candidate arrays, and sorts entrants. At the default population of 420 this is probably secondary, but it lands on a fixed cadence and may compound larger streaming commits.
- **Potential solutions:**
  - Index residents in a fixed grid or spatial hash.
  - Query only cells intersecting active/drop radii.
  - Reuse candidate arrays and tier storage.
  - Avoid sorting when only one activation is allowed; track the nearest candidate directly.
- **Test for success:**
  - Scale populations from 420 to at least 5,000 in a synthetic benchmark.
  - Streaming-update time should scale with nearby residents rather than total population.
  - The default 420-resident update should allocate no recurring large collections.
- **Evidence:** `park-spawn.js:127-154`, `demos/pokemon-park.html:1118-1137`

### PP-BB-016 — The demo lacks pass-level frame instrumentation

- **Priority:** P1
- **Confidence:** Confirmed
- **Classification:** Observability defect
- **Likely cause:** The HUD reports FPS and the worst raw frame interval, but does not attribute time to species loading, spawning, creature simulation, move effects, flora CPU work, compute submissions, water passes, shadow rendering, UI, or GPU execution.
- **Potential solutions:**
  - Integrate `frame-profiler.js` or an equivalent low-overhead recorder.
  - Add named CPU spans and GPU timestamp queries where supported.
  - Record streaming events, upload bytes, pipeline compilations, draw calls, triangles, and active instance counts alongside frame samples.
  - Export reproducible JSON/CSV captures with URL flags and hardware context.
- **Test for success:**
  - A capture must attribute a forced model-load hitch, flora chunk crossing, water-heavy frame, and move cast to named spans/events.
  - Profiling disabled must have negligible overhead; profiling enabled should add less than 2% median CPU frame time.
  - Captures must include p50/p95/p99/max and enough context to compare two builds.
- **Evidence:** `demos/pokemon-park.html:1174-1251`, `docs/subsystems/pokemon-park.md:259`

### PP-BB-017 — Player camera motion is jerky and nonstandard

- **Priority:** P2
- **Confidence:** High for the symptom, medium for the dominant cause
- **Classification:** Camera/control quality defect
- **Likely cause:** The camera is not directly attached to the rendered body; it follows the capsule top. However, its input transform contains hard collision corrections from five player substeps, frame-time-sensitive acceleration lean, separately smoothed XZ/Y motion, a boom distance quantized in 0.2 m increments, immediate snap-in, and eased return. Those independently filtered and discontinuous signals can produce visible position and rotation jerk, especially when frame time is already unstable or the boom touches vegetation.
- **Potential solutions:**
  - Establish separate fixed-step simulation and interpolated render transforms.
  - Drive the camera from one interpolated player anchor rather than several partially smoothed states.
  - Replace discrete boom sampling with a swept sphere and a critically damped, frame-rate-independent spring.
  - Filter acceleration before applying camera lean, or remove acceleration lean until the base rig is stable.
  - Define a conventional camera pipeline: target anchor, yaw/pitch pivot, collision solve, spring, final presentation transform.
- **Test for success:**
  - Replay a deterministic walk/run/strafe route at injected 8, 16, 25, and 33 ms frame times.
  - Plot camera position, angular velocity, and acceleration; constant player motion must not produce isolated derivative spikes.
  - Passing close to trunks and terrain must not penetrate, snap between boom lengths, or oscillate.
  - Hiding the player body must not change camera smoothness, proving the camera uses an independent render anchor.
- **Evidence:** `demos/pokemon-park.html:562-797`, `collision.js:97`, `view-feel.js`

### PP-BB-018 — Visual systems do not share an explicit lighting contract

- **Priority:** P2
- **Confidence:** Medium pending a controlled visual audit
- **Classification:** Rendering consistency defect
- **Likely cause:** GLTF creature materials consume Three.js scene lights, while grass, water, sky, ground, trees, and effects include custom node materials and separately propagated uniforms. The page manually pushes a sun direction into grass, but there is no single enforced contract for sun direction convention, color, intensity, ambient contribution, exposure, fog, or shadow response across every visual subsystem.
- **Potential solutions:**
  - Introduce one immutable-per-frame `LightingState` sourced from the lighting rig.
  - Bind its sun direction, radiance/color, ambient term, exposure, and time-of-day values to every custom lit material.
  - Document whether each direction points toward the sun or along incoming light.
  - Mark intentionally unlit/emissive materials explicitly and keep them out of lighting comparisons.
  - Add shared debug modes for normals, direct diffuse, ambient, shadow factor, and final luminance.
- **Test for success:**
  - Sweep sun azimuth, elevation, color, and intensity through a fixed screenshot scene containing ground, grass, trees, water, rocks, and creatures.
  - Direct-light highlights and dark sides must rotate consistently with the shadow direction.
  - With sun and ambient intensity set to zero, every material classified as lit must become dark except documented emissive terms.
  - Golden-image comparisons must cover noon, sunset, overcast/ambient-only, and zero-light states.
- **Evidence:** `demos/pokemon-park.html:210-262`, `demos/pokemon-park.html:1098-1104`, `lights.js`, `park-ground.js`, `grass-compute.js`, `forest-gpu.js`, `park-creature.js`

## Not currently considered primary bugs

- No runaway animation-loop registration was found.
- No listener multiplication was found during normal page lifetime.
- No explicit GPU readback such as `mapAsync` or `readPixels` was found in the gameplay loop.
- The normal 190 px minimap and four-Hz HUD are unlikely to explain severe stutter by themselves.
- World culling exists; the bounty concerns its granularity and view coverage, not a total absence of culling.

## Claim requirements

A completed bounty should include:

- The issue ID and a short root-cause explanation.
- A minimal patch limited to the issue where practical.
- Before-and-after traces following the shared protocol.
- Automated tests for pure logic and static invariants.
- Manual visual checks for WebGPU behavior that cannot be covered headlessly.
- Documentation updates when URL flags, quality behavior, or profiling output changes.

Multiple bounties may be combined only when the implementation is genuinely shared. Report each issue's acceptance result separately.
