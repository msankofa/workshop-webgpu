You are investigating the grass in `base-game.html` in the repo at `G:\My Drive\Scripts\procedural-creature\workshop-webgpu` (read `CLAUDE.md` there first). READ-ONLY: do not edit any file, do not open a browser, do not run servers. You may run `node` scripts that only read files. Work only with Bash/Grep/Read/Glob.

The grass path is: `base-game.html` (settings + panel sliders around lines 244-258, 3140-3175, 4463-4500) -> `base-game-flora.js` -> `grass-compute.js` (GPU candidate cull + instanced blade draw, TSL). The terrain side is `base-game-terrain.js` (look for `groundColorNode`, `setGroundColorMip`, `groundColorReady`, `groundColorSamplesTextures`) and whatever it delegates to (`terrain-splat-streamed.js`, `terrain-clipmap*.js`, `terrain-field.js`, `world-query-*`). Other grass code in the repo: `grass.js`, `grass-look.js`, `grass-anchors.js`, `grass-cells.js`, `grass-textures.js`, `soil-shade.js`, and the grass wiring in `environment-viewer.html`, `bot-viewer-v3.html`, `demos/flight-sim.html`, `demos/pokemon-park.html`, plus `docs/subsystems/vegetation.md` and `docs/subsystems/terrain.md`.

The user reports five problems with the grass in base-game.html:

1. Grass colour does not match the terrain colour. There is code that is supposed to make blades take the ground colour (the `grassGroundTint` / `groundColorNode` path, and a "top/bottom albedo" idea a previous agent added) but the user says it does not work in the browser. We need a VERIFIED way to sample the terrain's rendered colour at a blade's position and recolour the blade from it.
2. Grass can be patchy in the distance.
3. Grass density varies around the player, so it is hard to tell whether the sliders are set right; sometimes entering a high-density area makes grass disappear in a sharp divide around the player.
4. Grass seems poorly optimised; the user expects to generate far more grass without trouble.
5. The fade band is hard to control; it is all wrapped into one slider (`grassCullStart`), and the user wants control over more aspects of how fading works.

For EACH of the five problems:
- Trace the actual code path and say what the code does today, with `file:line` evidence.
- State a concrete hypothesis for the root cause. Label each claim as VERIFIED (you read the exact code and can show it), INFERRED (follows from code you read but you did not confirm the whole chain), or GUESSED.
- Check whether another page or module in this repo already solved that problem (for example `grass.js`, `grass-look.js`, `grass-anchors.js`, `environment-viewer.html`'s grass wiring, `bot-viewer-v3.html`'s flora, `forest-gpu.js`'s cull/fade, `terrain-splat-streamed.js`). If so, say exactly where and how, and whether base-game could reuse it.
- Say what a minimal fix would look like (files and functions, no code required).

Also look specifically at:
- Where `groundColorNode` is evaluated (in the compute cull or in the fragment shader?), what it samples (splat textures, vertex tint, a colour window?), in what coordinate frame, and whether the result actually reaches `colorNode` of the blade material. Check for TSL pitfalls: sampling a texture inside a compute Fn, the `injectedGround` flag, uniform values that are 0 by default, mip parameter ignored, colour space (sRGB vs linear) mismatch between what the terrain draws and what the grass reads.
- How the cull/fade works: `cullStart`, the keep-probability curve, dispatch budget clamping (`dispatchBudget`, `dispatchClamped`), `Kmax` per cell, `maxInstances`, and what happens when density x area exceeds any of these. Which of these produce a SHARP divide vs a soft one.
- Recull cadence: when does a recull run (`forceRecull`, movement threshold, `skippedReculls`), how many threads it dispatches, and whether the draw is indirect. Where the per-frame GPU cost goes.
- Any place a hard edge could appear: window/tile boundaries of the contact field vs the placement field (`safeRadiusFor`, `grassNearFade`, `HEIGHT_MISSING`), cover field gating (`coverGrass`, `grassCoverGate`), water gate, chunk streaming.

Output: a report in markdown, no more than ~150 lines, organised by problem number, claims labelled VERIFIED/INFERRED/GUESSED with file:line, followed by a short "already solved elsewhere in the repo" section and a short "what I could not determine without a browser" section. Be concrete and skeptical; a wrong confident claim is worse than an honest "could not tell".
