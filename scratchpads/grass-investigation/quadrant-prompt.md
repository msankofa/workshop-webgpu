# Brief: the base-game grass quadrant bug (read-only investigation)

You are one of five agents given this identical brief. Work independently. Do NOT edit any file, do
NOT run a browser, do NOT run git commands that change state. Node scripts you write go in
`scratchpads/grass-investigation/agent-<yourname>/`. Report in at most 150 lines, every claim
labelled VERIFIED (you read the exact code, cite file:line), INFERRED, or GUESSED.

Repo: `G:\My Drive\Scripts\procedural-creature\workshop-webgpu` (Windows; grep with the Grep tool,
not `grep -r` over the drive). Start with `docs/subsystems/vegetation.md` (Base Game section),
`base-game-flora.js`, `grass-compute.js`, `terrain-field-window.js`, `terrain-clipmap-window.js`,
`base-game-terrain.js` (setSource, acquireFields, groundHeight), and the grass parts of
`base-game.html` (search `createBaseGameFlora`, `applyFloraSettings`, `applyTerrainProjectAtRuntime`,
`syncSpawnBuilding`, `worldMode`). `git log --oneline 16f38bf..HEAD` lists today's commits; the grass
work is the ones mentioning grass, the spawn building ones are another session's.

## The symptom, in the user's words
"it literally is like a 4 sides thing, and its not a rectangle, it expands out infinitely in that
quadrant. a quadrant has grass or it doesnt, its not like if i walk far enough in that direction
the grass starts to appear again, its gone." Two OPPOSITE quadrants have grass, the other two have
none. It happens with the spawn building present and with it absent. "going from non draft to
draft terrain means that there is 0 grass anywhere. going straight to draft terrain from the
traversal lab leads to the quadrant grass bug."

So there are two bugs:
A. Quadrants: the field is split by two straight lines into four quadrants; two opposite ones grow
   grass, two do not, to infinity. Unknown whether the lines pass through the world origin, the
   render origin, or the player. Opposite-quadrant patterns are sign bugs: something behaves
   differently when x and z have different signs (integer modulo of negatives, a wrap that assumes
   non-negative indices, a hash, floor vs truncation, a bounds test with min > max, a select with
   swapped arms, texture wrap modes, negative tile indices in a Map key, etc).
B. Source swap: applying a draft terrain (`terrain.setSource` with a v5 descriptor) while grass is
   up leaves 0 blades everywhere afterwards. Loading the draft directly from the traversal lab world
   mode does not (it gives bug A instead).

## What is already ruled out headlessly (do not re-do, but you may distrust)
- `scratchpads/grass-investigation/check-residency-quadrants.mjs`: the field windows' tile
  residency mask agrees with CPU tile presence in all four quadrants and refills after a source
  swap. The GPU indexing was mirrored in JS; the TSL itself was not executed.
- The ring-ordered, tiered cell numbering in grass-compute's procedural cull was checked against
  the generated WGSL (`scratchpads/grass-investigation/wgsl-cull.wgsl`, regenerate with
  `node test-grass-wgsl-build.mjs --dump`) and matches `grass-cells.ringCell`.
- The building's footprint rectangle is not it (the bug exists without the building).
- The cull's 19-texture binding overflow was fixed; grass draws in general.

## What to look for
1. Every place in the cull chain where a world coordinate's sign matters: grass-compute.js
   procedural cull (hashes, cell math, `modInt`), the injected samplers in base-game-flora.js
   (`buildSamplers`, `wrapStructure`, `handoverDistance`), terrain-field-window.js `gpuSampler`
   and `syncResidency`, terrain-clipmap-window.js (`desiredOrigin`, `wrapIndex`, `tileInside`,
   `resolved`), terrain-clipmap.js `drawnHeightNodeFor`, and the terrain's cover derivation
   (`flora-field.js`, `tileCover`). Say which could produce an opposite-quadrant pattern and why.
2. What differs between the two ways of reaching the draft terrain: from the traversal lab (world
   mode change) versus from the running non-draft terrain (`applyTerrainProjectAtRuntime`). Trace
   what happens to the field windows, the contact window, the residency masks, the clipmap, the
   render origin, `terrain.seaLevel` and the grass instance across `setSource`, and what could leave
   every candidate culled: height missing (-1e5 sentinel), below the water line, density 0, outside
   the cone, or the occlusion projection.
3. The TSL vs JS gap: anything where TSL/WGSL semantics differ from JS for negatives (`%`, integer
   division truncating toward zero, `floor` on int, bitcast, `select` argument order, `int()` of a
   float). Cite the exact node calls.
4. If you can, write a small Node script that reproduces a quadrant asymmetry on the CPU twins
   (grass-cells.js, the windows' `sampleField`/`resolved`, `terrain.coverAt`, `groundHeight`)
   across all four quadrants, and report the numbers.

Rank your findings by how well they explain BOTH symptoms; the bug that explains "two opposite
quadrants" is the prize. Give file:line for everything.
