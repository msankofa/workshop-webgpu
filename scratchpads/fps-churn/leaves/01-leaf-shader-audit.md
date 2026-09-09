# Leaf shader audit — forest-gpu.js, default 'variants' draw mode

Date 2026-09-09. Harness `test-forest-leaf-shaders.mjs` (new, modelled on `test-forest-pulled-wgsl.mjs`):
builds each role's material through the shipped `WGSLNodeBuilder` with a stub renderer and reads the
emitted WGSL text. `--dump` writes it to `scratchpads/fps-churn/leaves/wgsl/`.

**What this can and cannot say.** It reads the SHAPE of the emitted code — which stage declares which
binding, which indices are loaded, how many `cos`/`sin` calls each stage has. It does not compile the
WGSL, does not run a GPU, and says nothing about time. Everything below is *measured in WGSL* unless
labelled otherwise.

## Finding: yes, the redundancy is real, and it is exactly what Astra named

`instanceNodes()` (forest-gpu.js:527) returned `nWorld` as a live expression over `draw.element(...)`
and `userData('slotOffset') + instanceIndex`, and lines 771-787 assigned it straight to
`material.normalNode`. `normalNode` is consumed in the FRAGMENT stage, so the builder re-emitted the
whole instance chase there.

Measured, before the fix (per role, one variant, `bindTreeMaterials(..., null)` procedural bark set):

| role | frag `var<storage>` | frag draw loads | frag cos/sin | frag flat instance varying |
|---|---|---|---|---|
| branchesL0 | 1 | 2 | 3 | yes |
| leavesL0 | 1 | 2 | 2 | yes |
| leavesL1 | 1 | 2 | 2 | yes |
| coarseLeavesL2 | 1 | 2 | 2 | yes |
| leafShadow | 1 | 2 | 2 | yes |

(branchesL0's third `sin` is the procedural bark colour noise, which is genuine fragment work.)

The fragment WGSL, `variants-leavesL0-fragment.wgsl` before the fix:

```wgsl
@location( 4 ) @interpolate(flat, either) nodeVarying8 : u32 ) -> OutputStruct {
  ...
  normalLocal = nodeVarying7;
  nodeVar5 = cos( NodeBuffer_913.value[ ( ( ( object.nodeUniform13 + nodeVarying8 ) * 2u ) + 1u ) ].x );
  nodeVar6 = sin( NodeBuffer_913.value[ ( ( ( object.nodeUniform13 + nodeVarying8 ) * 2u ) + 1u ) ].x );
  normalView = vec3<f32>( ( ( normalLocal.x * nodeVar5 ) + ( normalLocal.z * nodeVar6 ) ), normalLocal.y, ( ( normalLocal.z * nodeVar5 ) - ( normalLocal.x * nodeVar6 ) ) );
```

So per leaf fragment: a `var<storage, read>` declaration in the fragment stage, one storage load of
the instance's rec1 (emitted twice, same index), a `cos` and a `sin`, and `instanceIndex` shipped
across as a fifth `@interpolate(flat)` varying purely to index that buffer.

*Arithmetic*: leaves are alpha-tested cards at canopy density, so the fragment count for the leaf
roles is far larger than the vertex count. *Inferred*: that makes this the wrong stage to do the
work in, and it also puts the draw buffer in the fragment bind group where it need not be.

## Vertex stage

Six textual loads of the draw buffer, but only **two distinct indices** (`nodeVar0` and
`nodeVar0 + 1u`): the builder inlines an `element()` read at each consumer of `rec0.x/.y/.z/.w`.
They are identical read-only loads at a loop-invariant index — *inferred* that a driver folds them;
the test asserts the distinct-index count rather than the textual one. `cos`/`sin` are each emitted
once (the builder caches them into `nodeVar1`/`nodeVar2`). Nothing else vertex-side looked redundant.

## Second observation, not acted on

`normalView` is assigned the custom `normalNode` value **directly**, with no view-space transform and
no normalization, in both the old and new form (`normalView = v_forestNormal`). The rotated normal is
world-space, and the lighting below it treats `normalView` as view-space. That is pre-existing
behaviour shared with every role and with the pulled path, so this pass preserved it byte-for-byte;
flagged here because it is visible in the WGSL and looks wrong. Fixing it would change shading, which
was out of scope.
