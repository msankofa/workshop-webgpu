# Vegetation visibility rebuild

Date: 2026-09-06
Status: proposed implementation; browser baseline and root-cause reproduction pending.

## Outcome

Restore functioning terrain and structure occlusion while preserving visible grass, including
movement, slopes, caves, structure edges, wind, shadows, and reflections. Reduce camera-driven
generation work through persistent placement and conservative GPU patch culling. Preserve the
existing density, distribution, blade geometry, materials, and supported view distances.

This plan supersedes the occlusion follow-ups in vegetation-performance-fix-plan.md. Existing
resource-lifetime and upload optimizations remain useful. Commit each independently validated
implementation step separately; do not include concurrent agents' unrelated changes.

## Evidence and corrections

- The per-frame structure/root invalidation defect was identified in code and fixed in 64dc19b.
  Its existence does not prove it caused the reported missing patches.
- ba95aa4 suppresses terrain occlusion for certain placement sources. This is containment,
  not completed support for volumetric terrain.
- 27b3baf exposes absent registered roots in the HUD. Registered roots are not proof that
  visible opaque occluder meshes exist or that any grass is actually hidden.
- The inspected September 5 captures predate these fixes and lack the new rejection counters.
  They cannot establish the current browser configuration or the cause of the current symptom.
- The atrium uses the shared depth pass and compute-grass kernel when compute mode is selected.
  Its map root includes a floor and planter soil. Earlier claims that its ground never occludes
  were incorrect. Its simpler scene is a regression reference, not proof of terrain support.
- A drawn-height label is not proof that every grass root matches the rendered surface:
  near-field interpolation, far-field blending, mesh LOD, and volumetric surfaces need checking.
- Hi-Z is a proposed scalable visibility structure. It cannot repair underground placement,
  wrong projection conventions, missing depth clears, stale streaming registrations, or overflow.

## 1. Reproduce and establish the baseline

- [ ] Record current commits, browser/GPU/adapter limits, loaded modules, saved settings, terrain
  project, camera pose, and grass rendering mode. Inspect applicable repository instructions.
- [ ] Reproduce one missing patch with a fixed camera and deterministic simulation time. Capture
  master occlusion off/on and terrain inclusion off/on separately, then sweep bias.
- [ ] Capture submitted blades, tested candidates, each rejection stage, overflow, registered
  roots, eligible meshes, depth contents, camera/depth revisions, and terrain generation IDs.
- [ ] Distinguish blades rejected in compute from blades submitted but buried, outside the view,
  clipped by another pass, or omitted by capacity. Probe placement at the actual missing patch.
- [ ] Compare the atrium compute path using the same shared-module revision.
- [ ] Audit frame order and renderer state: depth clear/autoClear, viewport/scissor, projection
  and depth conventions, override materials, BatchedMesh transforms/culling, origin rebases,
  and render/compute submission ordering. Check root-version bookkeeping: an unchanged sync
  must not consume a streaming revision before new meshes have been marked.

Deliverable: reproducible scene/camera cases and a diagnosis supported by captured data.
Commit: reproduction harness and relevant diagnostics, then any independently proven defects.
Gate: do not describe a suspected cause as confirmed based on old logs or source inspection alone.

## 2. Define authoritative placement and resource ownership

- [ ] Publish a terrain surface contract keyed by stable chunk ID, generation, transform, and
  source revision. Include bounds and the actual rendered surface representation.
- [ ] For heightfields, match the mesh's triangle interpolation, displacement, and LOD transition.
  For volumetric chunks, evaluate reuse of grass-anchors.js and grass-compute.js anchor mode;
  bind placement to eligible mesh triangles rather than a single height per XZ column.
- [ ] Preserve existing intended distribution and density. Make corrections to buried/floating
  roots explicit in image comparisons; do not silently repopulate all cave floors or roofs.
- [ ] Define stable ownership at chunk seams, stacked surfaces, planter overrides, streaming
  replacements, and rebases. Camera movement must not randomly change blade identity.
- [ ] Publish matching geometry, placement, and visibility metadata together. Retire old buffers
  only after queued GPU work no longer uses them; avoid unbounded rebuild retention.

Deliverable: placement records which agree with visible terrain, including volumetric test scenes.
Commit: surface contract, then placement adapter(s) in independently reviewable steps.
Gate: known patch coordinates show no placement gaps, duplicates, or buried roots with occlusion off.

## 3. Persistent grass patches

- [ ] Group stable blade seeds/anchors into bounded patches; choose patch size using measurements
  of metadata cost, culling effectiveness, and dispatch overhead.
- [ ] Cache placement independently of camera visibility. Regenerate only changed terrain,
  density/distribution inputs, or structure overrides. Keep view-dependent fades live.
- [ ] Build conservative bounds covering full blade geometry, maximum supported wind/bending,
  height/width settings, offsets, and any LOD transition. Update bounds when these inputs change.
- [ ] Allocate bounded persistent slots with generation IDs and dirty upload ranges. Do not scan
  or upload all anchors on every camera step. Rebase coordinates without redistributing blades.
- [ ] Define capacity behavior before rollout: overflow must be observable and must not select
  arbitrary spatial holes through atomic submission order. Preserve configured visible density
  through an appropriate bounded draw/buffer partition or an explicit supported-capacity limit.

Deliverable: same visible placement with camera-only changes issuing visibility work.
Commit: patch storage and bounds, then persistent placement integration.
Gate: turning in place produces zero placement regeneration; memory plateaus after stream cycles.

## 4. Conservative depth pyramid

- [ ] Establish explicit render-graph ordering: valid occluder depth, depth reduction, visibility
  compute, compaction, indirect draw. Keep every depth texture paired with its camera/revision.
- [ ] Reuse existing depth only if its ordering and geometry are suitable. Otherwise build an
  opaque terrain/structure prepass using matching transforms and displacement. Exclude grass,
  transparent water, and unsupported occluder materials. Do not recursively occlude from grass.
- [ ] Define linear or device depth, near/far convention, clear value, UV orientation, and
  ordinary/reversed-Z handling once. Reduce to the farthest depth over each footprint, including
  uncovered pixels, so coarse levels cannot invent occlusion.
- [ ] Handle non-power-of-two dimensions, edges, texture limits, resize and device loss. Use
  explicit mip dependencies; never read a level before its GPU writes complete.
- [ ] Add optional bottom-dock depth/mip visualization and GPU timings. Measure the prepass and
  pyramid overhead independently; retain a correct visible fallback on unsupported devices.

Deliverable: tested conservative depth pyramid with inspectable contents and revision metadata.
Commit: depth producer contract, then pyramid builder and mathematical/device checks.
Gate: synthetic reduction tests and actual WebGPU validation pass; clear/edge cases stay open.

## 5. GPU patch visibility and indirect submission

- [ ] Test patch bounds against the current view and distance rules first. Project a conservative
  screen rectangle and nearest possible patch depth. Keep camera-intersecting, near-plane,
  invalid-projection, and uncertain cases visible.
- [ ] Choose a mip and sample every texel required to conservatively cover that rectangle.
  Cull only if the entire patch is behind the farthest occluder depth plus numerical tolerance.
  Derive tolerance from representation error; do not rely on a slider to hide incorrect geometry.
- [ ] Compact visible patch IDs and drive blade processing/indirect draws from them. Retain
  existing blade-level density/fade/material behavior for surviving patches.
- [ ] Keep recently visible patches conservatively if useful, but immediately retest previously
  hidden patches on disocclusion. Previous-frame visibility must not delay newly visible grass.
  Reset/revalidate history on teleports, FOV changes, rebases, source changes, and slot reuse.
- [ ] Treat main-camera, shadow, and reflection visibility separately. Main-view occlusion must
  not remove off-camera shadow casters or grass visible in a reflection.

Deliverable: working terrain and structure occlusion with stable camera movement and no holes.
Commit: conservative patch test, compaction/submission, then history and secondary-view support.
Gate: paired occlusion-off/on images preserve every visible blade contribution in test scenes.

## 6. Controls and observable debugging

- [ ] Keep one explicit master occlusion switch shared by settings and the bottom HUD. Off must
  bypass depth rejection and restore visibility by the next completed cull, without a rebuild.
- [ ] If terrain/structure inclusion controls remain, label them as occluder sources. Display
  requested state, effective state, eligible mesh counts, and reasons for unavailable resources.
- [ ] Report resident/tested/visible/occluded patches, candidate blades in rejected patches,
  downstream blade rejection stages, drawn blades, overflow, uploads, and generation work.
- [ ] State percentage denominators. Patch rejection percentage is not blade rejection percentage;
  an exact off/on blade reduction needs a matched reference evaluation or controlled A/B capture.
- [ ] Preserve snapshot matching and reject stale camera/source data. Show depth, reduction,
  visibility, compaction, and draw GPU costs when timestamps are available.
- [ ] Keep detailed counters/readbacks opt-in and fit the existing bottom dock. Measure ordinary
  play with diagnostic atomics disabled as well as instrumented A/B runs.
- [ ] Remove terrain-mode suppression once the replacement passes acceptance. Keep truthful
  unavailable states for absent resources; do not present suppression as restored functionality.

Commit: controls/telemetry integration, followed by removal of superseded containment code.

## 7. Acceptance and rollout

Use identical seeds, terrain, camera paths, settings, and simulation times. Warm pipelines before
steady-state measurements; record startup separately. Save images, counter captures, frame-time
distributions, and GPU stage timings with the source revision and hardware details.

| Case | Required result |
| --- | --- |
| Flat ground, steep slope, ridge, thin wall, planter | No false disappearance versus occlusion-off reference |
| Volumetric cave entrance, floor/roof, overhang | Correct placement and conservative occlusion |
| Standing, walking, fast turning, teleport, FOV change | No moving holes or delayed disocclusion |
| Maximum wind, blade height/width, shadow/reflection view | Bounds preserve every visible contribution |
| Streaming, source/LOD swap, origin rebase, resize | No stale depth, reused-slot history, or resource leaks |
| Empty scene, all hidden, all visible, capacity stress | Honest controls/counters and deterministic capacity behavior |

- [ ] Automated geometry/reduction/projection tests cover the mathematical invariants. Shader
  build tests cover generated WGSL; real-device tests cover bind limits, ordering and readbacks.
- [ ] Frozen-frame differential images show zero reproducible false-occlusion regions. Investigate
  every difference; do not loosen the image threshold to accept missing grass.
- [ ] Benchmark open terrain and heavily occluded views on the user's GPU: CPU and GPU costs,
  p50/p95/p99 frame time, submitted blades/triangles, upload bytes, memory, and startup latency.
- [ ] Before rollout, set numeric regression budgets using baseline variance. Require a measured
  net gain in occluded scenes and an agreed bounded overhead in open scenes; counts alone do
  not establish a speedup. If needed, select a conservative bypass when culling cannot pay off.
- [ ] Exercise repeated load/unload and terrain traversal until resource counts stabilize.
- [ ] Commit each completed change with its evidence. Enable the replacement by default only
  after correctness and performance gates pass; then retire the legacy per-blade depth path
  where all consumers have migrated. Keep the atrium functioning throughout.

Tree depth occlusion is a subsequent consumer of the validated infrastructure. Integrate its
wind/LOD bounds and secondary views in a separate commit after grass passes; coordinate with
agents changing forest placement, palettes, or LODs before editing those files.

Completion means working terrain/structure occlusion, restored controls, no missing visible
grass in the regression matrix, and recorded performance results. A feature disable, passing
headless tests alone, or an unverified architectural rewrite does not meet completion.
