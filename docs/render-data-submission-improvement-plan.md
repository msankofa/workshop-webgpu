# Renderer data and submission improvement plan

Date: 2026-09-07. Status: proposed; no runtime changes made.

## Objective

Improve binding/uniform ownership, material sharing, forest submission and allocation/upload behavior. Roughly 45 FPS with occasional dips is the working baseline, not an acceptance threshold. Implement supported improvements even when their primary benefit is correctness, memory use or maintainability. Record tradeoffs rather than assuming a newer approach is better.

Coordinate with docs/render-submission-gpu-driven-plan.md and scratchpads/fps-churn/arch-review/00-verdict.md. This refines their relevant work, without restarting the negative matrix-walk or visually broken bundle experiments. Worker scheduling and camera/arm recovery remain separate tasks.

Evidence: existing DevTools sampling identifies substantial binding, uniform and node work; inclusive times overlap and cannot be added as savings estimates. Specific unnecessary writes/clones still require confirmation. Forest consolidation is a supported candidate, with net CPU/GPU benefit unmeasured.

## 0. Resource inventory and comparison setup

- [ ] Read the effective application paths and loaded Three.js version. Distinguish module defaults from Base Game overrides.
- [ ] Inventory frame, camera/pass, material, object and instance data: owner, consumers, mutable fields, update frequency, invalidation, sharing eligibility and disposal.
- [ ] Complete the material creation/clone/mutation audit and terrain add/optimize/backend-upload trace requested from Fable. Counts alone do not establish ownership or redundancy.
- [ ] Extend optional diagnostics only where needed: binding creations/cache misses, uniform and geometry write calls/bytes, RenderObjects/draws and unique materials by pass. Count actual submitted writes separately from logical dirty ranges.
- [ ] Verify nested-pass exclusive timing, explicit main/shadow/reflection identity, counter overhead and frame alignment locally. Current render work belongs to the following rAF interval, not the row's preceding frameMs.
- [ ] Define an old/new comparison with fixed seed, route/camera, worker count, vegetation, flashlight, reflections and warm-up. Reuse existing evidence; independent source-supported fixes need not wait for another capture.

Deliverable: resource inventory, supported finding list and repeatable comparison procedure.

## 1. Bindings and uniforms

Targets: application node/material setup and the loaded renderer's binding/uniform path; locate exact edit sites through the inventory.

- [ ] Separate genuinely frame-global, camera/pass, material and object/instance values. A second camera, shadow or reflection in the same frame cannot reuse incompatible data merely because frame ID matches.
- [ ] Identify a concrete redundant computation/write and document why dependencies and values are equivalent across consumers.
- [ ] Reuse compatible GPU buffers and bind groups. Key caches on resource/layout identity and generations; invalidate on replacement, resize, layout changes and disposal.
- [ ] Use supported versions/dirty state to skip unchanged writes. Coalesce ranges only where alignment and transfer costs justify it.
- [ ] Share appropriate data and update scopes while keeping transforms and genuinely varying inputs distinct. Avoid shifting equivalent reconstruction work elsewhere.
- [ ] If application APIs cannot express the improvement, design a narrow renderer extension with a compatibility check, integration seam, fallback and upgrade cost. Dynamic offsets require a verified backend/layout/alignment design; absence of current support is a constraint, not a blanket rejection.
- [ ] Implement one coherent ownership change at a time; keep a temporary old/new toggle for risky renderer-path changes.

Verify: multiple cameras/passes in one frame, moving and instanced objects, changing lights/material values, shadows, water/reflections, resource replacement, origin rebase and reset. Tests must detect stale data, not just lower call counts. Accept verified redundant-work removal with documented CPU/GPU/memory effects and no visual or lifetime regressions.

## 2. Material sharing

Depends on the ownership inventory; informs binding and forest layouts.

- [ ] Build compatibility keys from shader/node graph, defines, textures/samplers, blend/depth/cull state, shadow behavior and mutable inputs. Do not merge by name or appearance alone.
- [ ] Replace demonstrated unnecessary clones with bounded registry or subsystem ownership; prevent mutations leaking between consumers.
- [ ] Move suitable per-instance colors/variants into instance attributes or storage records. Preserve distinctions requiring separate shaders/draws and account for extra shader reads.
- [ ] Define shared-resource lifetime, disposal and invalidation for texture, palette and configuration changes.
- [ ] Convert one subsystem first, then apply the verified pattern to remaining cases. Document intentionally unique materials.

Verify independently changing instances, palette/light changes, spawn/despawn, rebuild/reset and shadows. Accept reduced unnecessary resource instances or clearer correct ownership with bounded caches. Sharing a material alone does not guarantee fewer draws or RenderObjects.

## 3. Forest submission consolidation

Refines forest step A in the existing submission plan. Coordinate forest-gpu.js and Hi-Z ownership before editing. Depends on material/pass compatibility decisions.

- [ ] Partition compatible geometry/material roles and record current main/shadow submissions and culling semantics.
- [ ] Pack compatible variants into stable vertex/index arenas with explicit offsets, bounds, capacity/growth and disposal rules.
- [ ] Preserve current visibility and LOD decisions. Compact visible instances, prefix/count metadata and indirect arguments on the GPU without synchronous CPU readback.
- [ ] Prototype one compatible role using compact live-count vertex pulling. Specify invocation-to-instance/variant/local-vertex mapping; preserve indexed geometry semantics and draw live content rather than arena capacity.
- [ ] Compare mapping costs, shader/storage reads and vertex work before expansion. Fewer CPU objects must not silently weaken culling or multiply GPU work.
- [ ] Preserve pass-specific visibility/LOD: main-camera visibility is not automatically valid for shadows or reflections.
- [ ] Handle empty/full visibility, overflow, variant reload, camera movement, origin rebase and resource regeneration. Expand only after the prototype establishes correctness and a sound cost tradeoff.

Verify placement, silhouettes, LOD transitions, alpha/depth behavior, shadows/reflections and visibility extremes. Record total CPU, GPU, vertex work and memory. Keep a fallback if consolidation introduces unacceptable GPU or visual costs; do not reopen bundles as part of this work.

## 4. Allocation and upload waste

Verified small changes can proceed independently; terrain-upload redesign depends on the source audit.

- [ ] Trace candidate temporary objects/arrays through consumers before reuse: escape, retained references, asynchronous work, reentrancy and reset semantics. Preserve immutable snapshots where required.
- [ ] Reuse safe local scratch storage in grass/prediction and other demonstrated hot paths. Avoid unbounded pools or unnecessary permanent retention.
- [ ] Retain bounded buffer capacity and update changed ranges with correct alignment. Separate first upload, ordinary mutation, resize and compaction.
- [ ] Verify existing BatchedMesh range behavior through backend writeBuffer before changing it. Do not infer full transfer from capacity or attribute all dips to compaction.
- [ ] Where justified, amortize rewrites or improve layouts to reduce churn. Preserve collision-critical progress, stale-result rejection and bounded queues; include downstream render/upload costs.
- [ ] Verify disposal/reset and long-session growth.

Verify partial-update boundaries, growth/shrink, slot removal/reuse, compaction, reset and retained references. Accept demonstrated waste reduction or lifecycle improvement; report memory/CPU/upload effects without unsupported GC claims.

## Execution sequence

1. Complete source audits and inventory; begin independently verified allocation fixes.
2. Establish material compatibility and implement one supported sharing improvement.
3. Remove one verified binding/uniform redundancy. Resolve any required renderer-extension design before coding it.
4. Prototype forest consolidation for one role using the established material/data layout; expand after CPU/GPU and visual evaluation.
5. Complete remaining upload/lifecycle improvements and reconcile documentation and ownership across systems.

For each unit: record weakness, replacement, evidence, exact affected files, dependencies and acceptance checks; make a focused reviewable change; run meaningful targeted checks and relevant existing suites. Do not write tests that merely mirror implementation. Browser visual checks are required where Node cannot establish parity. Report gains and costs without adding overlapping savings estimates.

Final verification: warm stationary scene, moving route, vegetation on/off, flashlight/reflection configurations, origin rebase, rebuild/reset and sustained use. Compare total frame/render CPU distributions, slow-frame frequency, GPU time where available, write bytes/calls and memory. A no-FPS-change improvement remains valid when its benefit is established and its performance costs are acceptable.

## Coordination and decision points

This document proposes work; it does not claim optimizations are completed. Fable's revised verdict should map supported findings into these workstreams and identify conflicts or missing evidence. Maintain explicit file ownership. A source audit or locally testable instrumentation check must not be replaced by another user capture. Larger renderer extensions and forest layout changes require a concrete design review; routine supported improvements should not be deferred merely because current FPS is acceptable.
