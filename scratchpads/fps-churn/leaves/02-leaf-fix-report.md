# Leaf fragment fix — report

Date 2026-09-09. Snapshot of the pre-edit file: `versions/forest-gpu-before-leaf-fragment-20260909-193924.js`.

## What changed

`forest-gpu.js`, two places:

- `createForestGPU()` gained `const normalVarying = opts.instanceNormalVarying !== false;` next to
  `swayEnabled`. The new behaviour is the default; `instanceNormalVarying: false` names the old one
  and exists only so a test can build both forms.
- `instanceNodes()` (the per-variant path used by branchesL0/L1/L2, leavesL0, leavesL1,
  coarseLeavesL2, shadowL0, barkShadow, leafShadow) now returns
  `nWorld = varying(nRot, 'v_forestNormal')` instead of the raw `nRot` expression. The rotation math
  is unchanged; only where it is evaluated changed.

Nothing else moved. `pulledInstanceNodes()` already did this (its own comment records the same
measurement), `instanceNodesBillboard()` has no normal, and no LOD radius, side policy, alphaTest,
density, variant count, sway term or shadow role was touched.

## Before / after, measured in WGSL

Per role, one variant, procedural bark set, default `variants` draw mode. "draw loads" counts
`NodeBuffer_N.value[...]` occurrences; "distinct" counts distinct index expressions.

| role | frag storage bindings | frag draw loads | frag cos/sin | vertex distinct draw indices |
|---|---|---|---|---|
| branchesL0 | 1 → **0** | 2 → **0** | 3 → **1** (bark noise) | 2 → 2 |
| leavesL0 | 1 → **0** | 2 → **0** | 2 → **0** | 2 → 2 |
| leavesL1 | 1 → **0** | 2 → **0** | 2 → **0** | 2 → 2 |
| coarseLeavesL2 | 1 → **0** | 2 → **0** | 2 → **0** | 2 → 2 |
| leafShadow | 1 → **0** | 2 → **0** | 2 → **0** | 2 → 2 |

The `@interpolate(flat) instanceIndex` varying is gone too: the fragment entry point went from five
locations to four, because the rotated normal replaces both the raw-normal varying and the instance
index. Fragment WGSL now reads simply `normalView = v_forestNormal;`.

## Why the shading is identical

*Arithmetic.* Yaw is constant per instance (a flat value), so the rotation is a fixed linear map on
that triangle. Rotating a barycentrically interpolated normal and interpolating the rotated normals
give the same vector: `R·(Σ wᵢ nᵢ) = Σ wᵢ (R·nᵢ)`. No normalization was applied before and none is
applied now, so magnitudes match as well. There is no double-sided flip to reinstate — a custom
`normalNode` never received one in either form, so DoubleSide leaves (L0 leaves, leafShadow) behave
exactly as they did. Only floating-point association differs.

## What the tests prove

New `test-forest-leaf-shaders.mjs` (45 checks, exit 0) asserts, on the WGSL the shipped builder
emits for all five roles: no fragment-stage storage binding, no fragment draw-buffer load, no
fragment `cos`/`sin` beyond the bark's own noise, no fragment use of the instance index, and exactly
two distinct vertex-stage draw indices. It also rebuilds the forest with
`instanceNormalVarying: false` and asserts the old form *does* load the draw buffer per fragment, so
the before-numbers are re-measured on every run rather than remembered.

Every test that imports `forest-gpu.js`, all exit 0:

```
test-base-game-forest      123 passed, 0 failed
test-forest-gpu-programs   exit 0
test-forest-gpu-rebuild    8 passed, 0 failed
test-forest-gpu-rung-gate  exit 0
test-forest-leaf-shaders   45 passed, 0 failed
test-forest-pulled-arena   exit 0
test-forest-pulled-wgsl    55 passed, 0 failed
test-forest-source-uploads exit 0
test-trees-geometry        27 passed, 0 failed
test-forest-cull           48 passed, 0 failed
tsl-build-check            exit 0
test-page-syntax           exit 0
```

`test-forest-pulled-wgsl` covers `pulled` and `pulled-compact`, so both alternative draw modes still
build; `test-forest-gpu-programs` still agrees on the program count, so the shared varying name did
not split any pipeline.

## What the tests cannot prove

- **Cost.** No GPU here and no WGSL compiler in `node_modules`. Removing a per-fragment storage load
  and two transcendentals from the leaf roles is a strictly smaller fragment program, but this pass
  makes no claim about frame time. Only a browser capture answers that.
- **Pixel parity.** The parity argument above is arithmetic, not measured. A browser A/B (toggle
  `instanceNormalVarying`) is the only way to see that leaf shading is unchanged.
- **Bind-group layout in the real backend.** The stub renderer does not create bind groups; that the
  fragment stage no longer declares the buffer is read from the emitted WGSL text only.

## Remaining uncertainty

1. Whether the leaf lag the user reports is dominated by this at all. *Inferred* that it contributes,
   since it was per-fragment work on the densest alpha-tested geometry, but overdraw, alpha-test
   depth behaviour and the DoubleSide policy on L0 leaves are all still candidates and are untouched.
2. The `normalView` / view-space question in `01-leaf-shader-audit.md`: the custom normal reaches
   lighting without a view transform. Preserved deliberately; unresolved.
3. Float association changed (rotation before interpolation instead of after), so leaf shading can
   differ in the last bits. Not visible, *inferred*.
