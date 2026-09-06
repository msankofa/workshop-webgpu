# Ground plan B: baked control maps and compressed texture streaming

STATUS: planned 2026-09-06, not started. Independent of plan A; the two combine.

## What is wrong

- Every fragment re-evaluates the height, slope and biome rules. It is cheap per pixel, but it
  means the studio cannot paint an exception ("dirt here, no snow on this ridge") and the
  splat cannot know anything the rules do not say.
- Ground textures are JPEGs decoded on the CPU, uploaded uncompressed as RGBA8, and the biome
  array is packed pixel by pixel through a canvas. A 1024 square layer is 4 MB before mips, and
  the GPU has no compressed format to sample from.

## Facts the plan builds on

- The placement field window already streams per-tile fields (`heights`, `biomeIds`,
  `moisture`) into textures the shader reads through a wrap-aware sampler
  (`terrain-field-window.js`). A control map is one more field of that kind.
- `terrain-clipmap-window.js` defines the field kinds (`WINDOW_FIELD_KINDS`), and
  `terrain-source-v5.js` fills them per tile on a worker via `classifyTile`.
- The studio's paint layer already stores a per-cell biome override (`paint.biomeOverride`),
  but only for the bounded preview grid. `classifyProject` rejects paint for streaming.
- three r184 ships `KTX2Loader` with the Basis transcoder in `node_modules/three/examples/jsm/`,
  so BC7 / ASTC / ETC2 arrive in one loader call, transcoded to whatever the GPU supports.

## Slices

### B1. A splat control field per tile

Add a `splat` field kind: one byte per post holding the dominant slot index (0..4) in the low
bits and a blend strength in the high bits, computed on the worker from the same rules the
shader uses (`splatWeights` with the biome's rule row; the CPU twin becomes the producer).
The shader reads it through the field sampler and mixes it with its own per-pixel rule result:
`w = mix(ruleWeights, controlWeights, controlStrength)`. Strength 0 is today's behaviour, so
nothing changes until something writes the field.

Files: `terrain-clipmap-window.js` (kind), `terrain-source-v5.js` (fill), `base-game-terrain.js`
(request the field when the splat is bound), `terrain-splat-streamed.js` (one sample and one
mix), tests for the worker fill.

### B2. Painted exceptions that stream

Let the studio's paint reach the field. The paint layer is bounded, so store painted splat
strokes as a sparse list in the project (`material.paint = [{ x, z, r, slot, strength }]`,
world metres) rather than a grid, and stamp them onto the control field after the worker fill
with the window's existing `stampAlong` / per-post mutate path. Sparse strokes stream at any
coordinate, so `classifyProject` need not reject them.

Studio: a "splat" paint tool beside height and biome, drawing into the same stroke list; the
material canvas shows the strokes.

Files: `terrain-project-v5.js` (the list, bounded to a few thousand strokes), `terrain-paint.js`
(tool), `terrain-generator-v5.html`, `base-game-terrain.js` (stamp on tile arrival).

### B3. Compressed ground textures

A build script `bake-ground-textures.mjs` that walks `textures/ground/`, packs roughness, AO
and displacement into one map (plan A1's layout), and writes `color.ktx2`, `normal.ktx2`,
`packed.ktx2` per folder with full mip chains, using `toktx` or the Basis encoder. The loader
prefers `.ktx2` when present and falls back to the JPEGs. The biome array is built from
transcoded layers copied GPU-side (`copyTextureToTexture`) instead of a canvas pack.

The server route lists which folders have the baked set so the studio can show it.

Files: the script, `terrain-splat-streamed.js` (loader branch, array build), `serve.py` (list
field), `textures/ground/README.md`.

### B4. Mip streaming and a budget

Load the top two mips of every layer first (fast, small) and the full chain for the slots the
active project uses, with a byte budget in the Terrain settings. KTX2 supports partial loads by
level when the file's level index is read first. This is the piece that makes a 16-layer biome
array affordable on a laptop.

Files: `terrain-splat-streamed.js`, `base-game.html` (budget setting and a stats line).

## Uncertain parts

- B1 stores a dominant slot per post, not a full five-way weight. That is enough for painted
  exceptions and for the ridge and shore cases, but a post that is a true three-way blend
  rounds. If it shows, widen the field to two bytes (two slots and a mix).
- B3 needs an encoder on the machine. `toktx` is a separate install; the pure-JS Basis
  encoder is slower but has no install. The script should try `toktx` and fall back.
- Array textures from KTX2 layers: three's loader gives one texture per file; building the
  array means GPU copies per layer, which is a path nothing here has used.

## Order

B1, B3, B2, B4. B1 and B3 are independent and could be built in parallel.

## Verification

- Node: the worker fill against the CPU twin, the stroke list normaliser, the bake script's
  output names.
- Browser: paint a dirt patch in the studio and see it in the game; a `stats` line showing
  ground texture bytes on the GPU dropping after B3.
