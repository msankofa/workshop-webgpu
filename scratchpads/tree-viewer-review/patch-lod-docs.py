import os
root = os.path.join(os.path.dirname(__file__), '..', '..')

p = os.path.join(root, 'docs', 'subsystems', 'vegetation.md')
s = open(p, encoding='utf-8').read()
a = "| `tree-age.js` |"
assert s.count(a) == 1
s = s.replace(a, """| `tree-lod-preview.js` | `createLodPreview({ renderer, scene, createTree })` and `HOST_PRESETS` (`'base game'`: rings 60/140/260, `branchLods` stride 2 × 0.67 and 3 × 0.5, no billboards; `'environment viewer'`: rings 258/400/583, full branches at every tier, billboards). `build({ opts, texSet, n, params, layout, distance, leafShadowPct })` bakes the current tree as a one-species table through `createForestPalette` itself — so LOD0/1/2 are byte-for-byte what `forest-gpu.js` would instance — and lays each tier out as a cluster of `n` plain meshes with the game's side policy (LOD0 leaves DoubleSide, LOD1/2 FrontSide). LOD3 is one orthographic capture per variant into a `CanvasTexture` (sun 1.2, ambient 0.4, the `'cross'` bake in `environment-viewer.html`) on an upright quad that `update(camera)` yaws toward the camera. `stats` gives tris, leaves and distance per tier. `test-tree-lod-preview.mjs` covers the geometry tiers. |
| `tree-age.js` |""")

a = "A debug readout sits bottom-left:"
assert s.count(a) == 1
s = s.replace(a, """**LOD mode** (Mode select: `solo` / `grid` / `lod`) shows the current tree at every tier the game
draws, through `tree-lod-preview.js`. The eye sits at the origin, 1.7 m up, looking down +Z. Layout
`rings` places the LOD0 cluster at R0, LOD1 at R1, LOD2 at R2 and the billboards at 1.25 × R2, so
each tier is seen at the range where the game would first draw it; `side` places all tiers at one
"Compare distance", spread along X, for a like-for-like comparison. The LOD panel holds the cluster
size, a host preset (which sets the rings, branch LOD specs, coarse-leaf numbers and whether the
billboard tier exists), then live sliders for all of those, the shadow-leaf fraction, and a "Copy
LOD settings JSON" button so a tuned set can be carried back to `base-game-forest.js`. The debug
readout adds one line per tier: distance from the eye, tris, leaves, and percent of LOD0's tris.
Mutation and auto-mutate work in this mode (a rebuild re-bakes the palette); safeguards do not
apply, since the palette bakes through `createTree` without limits.

A debug readout sits bottom-left:""")
open(p, 'w', encoding='utf-8', newline='\n').write(s)

p = os.path.join(root, 'CLAUDE.md')
s = open(p, encoding='utf-8').read()
a = "`grass.js`, `grass-compute.js`, `grass-look.js`, `flora-occlusion.js` |"
assert s.count(a) == 1
s = s.replace(a, "`grass.js`, `grass-compute.js`, `grass-look.js`, `flora-occlusion.js`, `tree-viewer.html`, `tree-lod-preview.js` |")
open(p, 'w', encoding='utf-8', newline='\n').write(s)

with open(os.path.join(root, 'agent_log.csv'), 'a', encoding='utf-8', newline='\n') as f:
    f.write('2026-09-05T13:30,vegetation,"tree-lod-preview.js;tree-viewer.html;test-tree-lod-preview.mjs;docs/subsystems/vegetation.md;CLAUDE.md",'
            '"Tree viewer LOD mode: clusters of n trees at every game LOD tier (baked through forest-palette itself) plus a billboard tier baked like environment-viewer\'s cross impostor; rings or side-by-side layout, host presets for base game and environment viewer, live LOD sliders, per-tier tris in the readout."\n')
print('docs + log updated')
