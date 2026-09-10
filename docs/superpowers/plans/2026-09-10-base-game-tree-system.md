# Base Game tree system improvements

Date: 2026-09-10

Status: proposed implementation plan. No runtime changes made as part of this review.

## Objective and evidence

Improve Base Game's tree placement, rendering, LOD continuity, and lighting while preserving deterministic world identity, streamed placement, and GPU instancing.

This plan comes from a code review of the active Base Game forest path and a deterministic Node placement probe. It is not a browser visual review or a GPU benchmark. Visual consequences below are hypotheses to validate in-game; measured placement results are labelled separately.

Primary files:

- [base-game.html](../../../base-game.html): integration, lighting, settings, reflection exclusions.
- [base-game-trees.js](../../../base-game-trees.js): placement ownership, terrain sampling, streaming, identity.
- [forest-placement.js](../../../forest-placement.js): candidate generation, ecology acceptance, species selection.
- [base-game-tree-species.js](../../../base-game-tree-species.js): stable species catalog and selection.
- [base-game-forest.js](../../../base-game-forest.js): palette, materials, quality settings, renderer lifecycle.
- [forest-gpu.js](../../../forest-gpu.js): culling, indirect draws, instance transforms, materials, shadows.
- [forest-palette.js](../../../forest-palette.js): branch and foliage representations.

## Current assessment

The engineering foundation is stronger than the visual continuity and ecological placement. Preserve seeded global records, frame-budgeted placement, terrain readiness checks, actual ground contact sampling, the second shoreline rejection, shared materials, GPU culling, indirect instancing, and shadow visibility independent of camera visibility.

The saved state selects eight species with two variants each, authored textures, clustered placement, and LOD distances of 60/140/260 metres. Trees are disabled in that saved state; enable them explicitly for validation. The reusable module's species fallback differs from the saved selection, so every capture must record the effective settings.

| Area | Finding | Evidence and consequence |
| --- | --- | --- |
| Placement | Retrying rejected candidates counteracts density thinning | Confirmed by code and probe; low cover can still fill the requested count. |
| Placement | Scattered mode bypasses the ecology gate | Confirmed by code and probe; zero tree cover still permits trees on dry ground. |
| Placement | Clusters are constrained to chunk interiors | Code-confirmed structure; repeated patches or sparse seams need visual validation. |
| Placement | No neighbour-spacing test in the reviewed placement path | Arbitrarily close roots are possible; visible overlap depends on generated content. |
| Placement | Base Game omits the optional biome callback for species selection | Cover affects acceptance, but the available biome-specific species filtering is unused. |
| Rendering | Close foliage is double-sided; LOD1/2 foliage is single-sided | Code-confirmed; canopy gaps and density changes need visual validation. |
| Rendering | Sixteen variants allocate 144 meshes at nine roles each | Allocation arithmetic, not a measured draw count or GPU cost. Visibility gates reduce submissions. |
| Rendering | Trees are excluded from water reflections | Explicit performance compromise; shoreline appearance needs a browser comparison. |
| LOD | Hard distance switches and a hard 260 m default endpoint | No transition blend or farther representation in the active Base Game path. |
| LOD | Horizontal distance drives selection regardless of tree size | Large trees and bushes use the same distance thresholds. |
| Lighting | Custom bark normal nodes take precedence over assigned normal maps | Code-confirmed precedence in the installed Three implementation; validate the fix visually. |
| Lighting | Leaves use fully rough standard shading without dedicated backlighting | Potentially weak sunlit canopy edges; aesthetic impact not measured. |
| Lighting | Shadow casters use a hard 90 m default root-distance limit | Potential whole-shadow popping and missing long shadows from farther trees. |

## Phase 1: Correct ecology acceptance

Priority: first, alongside the bark-normal fix.

### Reproduction

The review used `placementRecords` over 100 adjacent 96 m chunks on flat ground at height 10, water level 0, shore margin 0.5, seed 123, a requested total of 4,000 trees, cluster size 5, and cluster spread 0.14. Only placement mode and constant `treeDensityAt` changed.

| Placement | Cover 1.0 | Cover 0.2 | Cover 0.0 |
| --- | ---: | ---: | ---: |
| clustered | 4,000 | 4,000 | 0 |
| scattered | 4,000 | 4,000 | 4,000 |

Clustered, random, and ring paths retry rejected points until they fill the target or exhaust attempts. Scattered placement checks shoreline height but does not call the ecology acceptance function. Comments describing straightforward density thinning therefore overstate the current behavior.

### Changes

1. Define trees-per-hectare as candidate density before ecology rejection, consistent with the intended thinning model.
2. Generate a deterministic candidate population, then apply ecology acceptance once per candidate without replenishing ecology rejections.
3. Apply the same ecology gate to every placement mode, including scattered.
4. Base candidate identity and acceptance randomness on stable candidate slots, not the number of previously accepted trees.
5. Keep shoreline and final ground-contact rejection. Update requested/accepted statistics and UI wording to match the implemented semantics.
6. Audit all callers of the shared placement module before changing its contract. Integrate placement algorithm versioning with the existing world identity/network compatibility mechanism so peers cannot silently generate different forests.

### Acceptance

- Zero cover produces zero trees in every mode.
- Over a sufficiently large fixed sample, 20% cover accepts approximately 20% of the candidate population, with a stated statistical tolerance.
- For constant cover fields, increasing cover preserves previously accepted candidate identities and adds candidates monotonically.
- Results are identical across chunk build order, frame budgets, origin rebases, and peer draw radii.
- Existing shoreline and terrain-contact behavior remains correct.
- Document that corrected placement changes existing generated forests; do not promise seed compatibility across algorithm versions.

## Phase 2: Restore authored bark normals

Priority: first, independently of placement.

`forest-gpu.js` assigns a custom `normalNode` to branch materials. `bindTreeMaterials` subsequently assigns `normalMap`, but the installed Three `NodeMaterial.setupNormal()` returns the custom node when present. Simply assigning the map therefore does not compose it with the instance normal.

### Changes

1. Compose bark normal-map perturbation with the correctly rotated instance normal and the actual bark UVs.
2. Return the final normal in the view space expected by the material.
3. Preserve procedural bark mode and inspect the existing pulled-path normal implementation before sharing or adapting it.
4. Keep texture and shader changes consistent across branch LODs and material rebuilds.

### Acceptance

- An exaggerated diagnostic normal map visibly changes bark relief on the default `variants` path.
- Surface lighting remains attached to the tree while orbiting the camera and rotating instances.
- Procedural/authored switching, texture readiness, and palette rebuilding work without stale nodes.
- Build the affected shader graphs headlessly, then validate and render them on WebGPU. Shader construction alone does not establish visual correctness.

## Phase 3: Preserve canopy appearance across LODs

Priority: next visual improvement.

The branch LODs retain the original skeleton, which is worth preserving. Foliage changes are more disruptive: sidedness changes after LOD0, while coarse foliage defaults to roughly one-quarter the leaf count at 2.5 times the leaf size. This changes both coverage and the arrangement of gaps.

### Changes

1. Capture each selected species at every LOD from multiple azimuths before changing geometry.
2. Tune leaf reduction, card size, and orientation to preserve silhouette and canopy coverage. Compare single-sided and double-sided alternatives with measured fragment cost.
3. Add short, stable transition bands between representations. Prototype complementary dithered coverage using stable instance identity, with an explicit policy for depth and shadow passes.
4. Add hysteresis where discrete selection remains, without changing world identity.
5. Evaluate size-aware or projected-size selection so large trees retain detail longer than bushes. Keep these local quality decisions.

### Acceptance

- Walk repeatedly through the 60 m and 140 m boundaries: no abrupt change in canopy fullness, obvious holes, or threshold flicker.
- Test slow motion, camera orbit, elevated views, and a stationary camera with animated leaves.
- Quantify the extra draws, overlap geometry, and GPU cost of transition bands in the same scene.
- Verify culling bounds, leaf cutouts, depth, and shadows during overlap.

## Phase 4: Resolve the distant forest edge

The active Base Game path disables billboards and ends at the smaller of draw radius and LOD2 distance, 260 m in the saved settings. Extending the same detailed geometry indefinitely is not the proposed solution.

### Changes

1. Capture the endpoint from open terrain, hills, and shorelines to establish how visible it is under current fog.
2. Compare a cheap distant representation with a controlled distance fade. Prototype the minimum solution that preserves the intended landscape silhouette.
3. If using impostors or billboards, verify their lighting, alpha coverage, and transitions rather than simply enabling the donor renderer's existing rung.
4. Align the resident chunk window with the full transition/distant coverage requirement.

### Acceptance

- No obvious moving wall of disappearing trees in the reference views.
- Far trees remain consistent with daylight, dusk, and night lighting.
- Record memory, startup, and GPU costs at the chosen far distance.

## Phase 5: Make stands follow habitat and span chunks

### Changes

1. Wire Base Game's terrain biome query into species selection and audit the selected species' habitat tags. Define the fallback when no species matches.
2. Generate cluster centres in global space, allowing clusters to cross chunk boundaries while assigning each accepted tree to one owner chunk.
3. Add size-aware root spacing using deterministic neighbouring candidates. Avoid build-order-dependent rejection.
4. Introduce stand-level species preference and correlated size variation so every cluster is not an independent mixture of the full species list.
5. Audit existing world exclusion queries before considering roads, structures, or gameplay clearings; the review did not establish a complete exclusion contract.

### Acceptance

- View a multi-chunk forest from above: no repeated chunk-grid gaps.
- Neighbouring chunks built in either order produce identical records without duplicates.
- Roots meet the chosen spacing rule across chunk boundaries.
- Habitat transitions produce understandable species changes without sharp artificial seams.
- Apply the placement-version compatibility policy from phase 1 to these identity-changing improvements.

## Phase 6: Improve leaf lighting and shadow continuity

### Changes

1. Prototype a restrained, light-dependent foliage backlighting term. Keep it responsive to sun/moon direction and intensity rather than constant emissive brightness.
2. Evaluate whether canopy normals need adjustment to avoid lighting that exposes individual flat cards too strongly.
3. Replace the root-radius-only shadow admission rule with a conservative light-space or receiver-aware test that can include farther casters whose shadows reach visible ground.
4. Design a bounded shadow transition policy and retain the separate caster list so camera culling never suppresses needed shadows.
5. Check leaf motion against shadow updates and inspect the current sway's shared phase across repeated variants before deciding whether world-position variation is needed.

### Acceptance

- Compare front-lit, side-lit, and backlit canopies at noon, low sun, dusk, and night.
- Leaves gain believable backlighting without glowing independently of the lights.
- Walk across the current 90 m shadow boundary and inspect low-sun shadows from farther trees.
- Rotating away from a caster does not remove its visible shadow.
- Record shadow-map GPU time and admitted caster count for the revised policy.

## Phase 7: Measure rendering tradeoffs

Perform this after the correctness fixes, and repeat affected measurements as visual work lands.

### Changes and comparisons

- Capture actual draw submissions, CPU forest update time, GPU forest/shadow time, geometry cost, and memory using a fixed seed, effective settings, camera route, and device.
- Separate allocated meshes from submitted draws, and separate main-pass draws from shadow-pass draws.
- Compare a selective shoreline reflection option against the current exclusion only if reference images show a meaningful visual benefit.
- Evaluate draw consolidation only with same-content timings. Existing `pulled` and `pulled-compact` modes are experiments, not presumed improvements.
- Use the existing [forest consolidation design](2026-09-07-forest-consolidation-design.md) as background, checking its historical claims against current code.

### Acceptance

- Every adopted optimization has a same-scene before/after capture and preserves required visual behavior.
- Report hardware, resolution, effective species/variants, density, LOD settings, and shadow settings with results.
- Establish a numerical frame-time budget on the target device before accepting added visual costs; no device budget was measured in this review.

## Delivery order and completion

Implement phases 1 and 2 as focused correctness changes. Follow with canopy continuity and the distant edge, then habitat placement and lighting improvements. Profile each affected path rather than waiting until all phases are complete.

Use the existing placement, Base Game forest, geometry, and shader tests where relevant; add regressions for actual changed behavior. Browser captures are required for visual and GPU claims. Keep deterministic-world tests separate from local quality checks.

The work is complete when the confirmed acceptance defects are corrected, agreed visual improvements pass the reference route and lighting cases, deterministic streaming remains intact, and measured costs meet the chosen target-device budget. Record deferred experiments and their evidence explicitly.
