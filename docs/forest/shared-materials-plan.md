# Forest: one material per mesh role

Date: 2026-09-06. Status: shipped 2026-09-06, unseen in a browser.

## Why

Base Game's tree startup was two minutes of `render warmup` (WebGPU pipeline creation), never the
palette bake. Each variant in `forest-gpu.js` owned 8 `MeshStandardNodeMaterial`s because the
variant's slot offset in the shared draw buffer was baked into `positionNode`. Commit d9b7ee2 made
that offset a `uniform`, so the WGSL is identical across variants and the program cache shares it:
warmup 124 s → 27 s measured in Base Game (16 variants). The remaining 27 s is pipeline creation,
still one per material per pass, 8 materials × 16 variants × (main + depth) ≈ 256.

## Design

The offset comes from the mesh, not the material: `userData('slotOffset', 'uint')` is a
`ReferenceNode` with `updateType = OBJECT`, so it re-reads the current mesh's `userData` on every
draw, including the depth pass. One material per role for the whole forest:

| Role | Material | Side |
|---|---|---|
| branches L0 / L1 / L2 | `branchMat`, `branchMat1`, `branchMat2` | Front |
| leaves L0 (+ shadow-casting leaves L0) | `leafMat` | Double |
| leaves L1 | `leafMat1` | Front (toggle) |
| coarse leaves L2 | `coarseMat` | Front (toggle) |
| billboard L3 | one `billMat` per variant (each has its own baked capture) | Front (toggle) |
| shadow-only bark / leaves | `barkShadowMat`, `leafShadowMat` | Front / Double |

8 materials (10 with billboards and the shadow pair), ~16–20 pipelines, independent of V. No
appearance change: same vertex colours, textures, side policy, sway and emissive hook; only where the
number added to `instanceIndex` lives.

Changes in `forest-gpu.js`:

1. `instanceNodes(scaleMultiplier, sway)` and `instanceNodesBillboard()` drop the `offset` parameter
   and read `userData('slotOffset', 'uint')`.
2. Materials are created once before the variant loop; the loop only creates meshes.
3. `drawMesh(geom, mat, indirectAttr, castShadow, slotOffset, name)` stamps
   `mesh.userData.slotOffset`; the billboard and shadow-only meshes are stamped the same way.
4. `branchMats` / `leafMats` / `coarseLeafMats` / `billboardMats` / `shadowMats` stop being
   per-variant arrays. `applyTextureSet(fn)` calls `fn` once per role pair; `sideSwitchableMats`
   holds the three shared instances; `opts.addEmissive` runs once per material; billboard
   brightness sets `billMat.colorNode` once.
5. `installVariant` (progressive path) keeps using the shared materials — check it does not clone.

Hosts: `base-game-forest.js`'s `bindTreeMaterials` already binds the same textures to every
variant, so a single call is a simplification; `environment-viewer.html` and `bot-viewer-v3.html`
go through the same `applyTextureSet`.

## Steps

- [x] 1. Snapshot; the four `forest-gpu.js` changes above.
- [x] 2. `test-forest-gpu-programs.mjs`: add "8 distinct material objects across all variants" next
  to the existing one-program-per-role assertion; `test-base-game-forest.mjs`,
  `test-forest-gpu-rebuild.mjs`, `test-tree-lod-preview.mjs`, both page parse checks green.
- [x] 3. `vegetation.md` (`forest-gpu.js` row, the "builds off the frame loop" paragraph,
  `applyTextureSet` contract); `agent_log.csv`.

## Validation

- Headless: the tests above.
- Browser (the user): Base Game tree panel `render warmup` well under 27 s; `112 main + 32 shadow
  draws` and the LOD split unchanged; trees look the same; shadows still cast (the depth pass reads
  the same `userData`).

## Coordination

`forest-gpu.js` is shared with the Hi-Z session (workshop-webgpu-1c), who owns the cull kernel.
This plan touches only the material block, `drawMesh`, `applyTextureSet` and the billboard
brightness setter. Ask before editing; commit by explicit path.
