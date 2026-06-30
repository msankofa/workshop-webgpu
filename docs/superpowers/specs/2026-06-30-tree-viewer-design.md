# Tree viewer — standalone procedural tree tuning tool

## Purpose

`environment-viewer.html` only exposes a curated subset of `trees.js`'s tree-generation
parameters (the `Forest` panel sliders), and every change rebakes/repositions a whole forest of
instances plus terrain, grass, water, sky, etc. There's no fast way to dial in a single tree's
full parameter surface in isolation. This adds a standalone, lightweight HTML tool —
`tree-viewer.html` — that reuses `trees.js` and `tree-textures.js` as-is, with its own minimal
scene shell (renderer/camera/controls/lighting/ground), to let someone iterate on a tree's full
shape/leaf/bark parameters and export the resulting JSON for reuse elsewhere (e.g. as a new
forest species preset).

This is a standalone tool in the same spirit as `creature-viewer.html` (the legacy app) — not a
lazy-loaded subsystem of `environment-viewer.html`, and not wired into it in any way.

## Non-goals

- No forest placement, LOD, GPU instancing, or culling — `forest-gpu.js`/`forest-palette.js`/
  `forest-placement.js` are not used. Grid mode (below) just creates N independent `Tree`
  instances; that's plenty cheap for a tuning tool with a capped grid size.
- No terrain system, water, sky, or creature sim. Ground is a flat static plane.
- No species taxonomy (`buildSpecies`) — the user tunes one `opts` object directly.

## Running

Same as the rest of `workshop-webgpu`: `python serve.py [port]`, then open
`http://127.0.0.1:8080/tree-viewer.html`. (Needed because of ES module imports and, in authored
texture mode, image fetches from `./textures/`.)

## Architecture

Single `<script type="module">` in `tree-viewer.html`. Same import-map CDN pins as
`environment-viewer.html` (three@0.184.0 `three.webgpu.js`/`three.tsl.js`, `three/addons/`).

### Scene shell

- `WebGPURenderer` (antialias on), `renderer.shadowMap.enabled = true` /
  `THREE.PCFSoftShadowMap`, sized to the window, appended to `document.body`.
- `THREE.PerspectiveCamera` + **`OrbitControls`** (`three/addons/controls/OrbitControls.js`) —
  new for this tool. The main viewer's camera is a custom drag/zoom/walk rig built for a
  creature-following game camera, which is unnecessary complexity for a static tuning view;
  `OrbitControls` is the minimal correct choice here.
- Lighting: `createLightingRig({ scene, ui: false })` from `lights.js` (same call the main
  viewer uses), with `dirLight.castShadow = true` and shadow camera bounds sized for a single
  tree / small grid (much smaller than the main viewer's ±90 terrain-sized bounds — e.g. ±20).
- Ground: one static `THREE.Mesh(PlaneGeometry, MeshStandardMaterial)`, large enough to sit under
  the grid, flat (no `terrain-system.js`), `receiveShadow = true`.
- No water/sky/clouds/grass/particles/multiplayer/creature-sim code at all.

### Data model

A single mutable `opts` object, shaped exactly like `trees.js`'s internal `DEFAULTS` (same keys,
same per-level array convention), so it can be passed directly to `createTree(opts)` /
`tree.regenerate(opts)` and serialized directly to JSON for export with no translation layer.
Initialized as a deep clone of reasonable defaults (can literally start from
`createTree({}).options` — `trees.js` already merges user options over `DEFAULTS` and stores the
merged result on `.options`).

### View modes

A `select` toggles between:

- **Solo** (default) — one `Tree` at the origin. After every regenerate, compute its combined
  bounding sphere (branches + leaves + leavesShadow geometries) and update
  `controls.target`/camera distance so the tree stays framed (only adjust distance the first time
  after a `levels`/size-affecting change, not every frame — don't fight the user's manual zoom).
- **Grid** — an N×N grid of independent `Tree` instances (`gridSize` slider, 2-5, so up to 25
  trees), all built from the same `opts` but with `seed: baseSeed + index` per cell, arranged with
  spacing derived from current `opts.length[0]` (trunk length) so trees don't overlap as size
  params change. Lets the user see seed-to-seed variety at fixed shape params.

Switching modes disposes the previous mode's `Tree` instance(s) (`tree.dispose()`) and (re)builds
for the new mode.

### Regeneration

One debounced (130ms, matching the main viewer's `apply()` pattern) `scheduleRegenerate()` called
by every control's `onChange`. It calls `regenerateAll()`, which:

1. In Solo mode: `tree.regenerate(opts)`.
2. In Grid mode: for each cell, `tree.regenerate({ ...opts, seed: baseSeed + index })` (the
   shallow spread only needs to override `seed`; `trees.js`'s `merge()` deep-merges the rest from
   the same nested objects, so bark/leaves sub-objects don't need re-spreading).
3. Re-fits the camera/grid spacing if in the "first regenerate after a structural change" case
   described above.

A "Reroll seed" button bumps `opts.seed` (Solo) or `baseSeed` (Grid) to a new random integer and
triggers immediate (non-debounced) regeneration.

### Texture mode

A `select`: `procedural` (default — matches `tree-textures.js`'s WebGPU-friendly textureless
mode, no asset loading) / `authored` (loads the real ez-tree bark/leaf packs via
`createTextureSource('authored', { onReady })`). On selection:

1. Call `createTextureSource(mode, { onReady })`.
2. Immediately apply whatever's available onto `opts.bark.{map,normalMap,vScale}` and
   `opts.leaves.{map,atlas,alphaTest}` (authored mode's maps arrive async via `onReady`; the
   `ready` flag means the leaf atlas canvas may still be blank for a frame or two — acceptable,
   matches how the main viewer already handles this).
3. Regenerate.

Switching back to `procedural` clears those fields to `null`/defaults and regenerates.

### Controls panel

Duplicates (does not import — `environment-viewer.html` isn't a module other files can pull
helpers from) the same minimal draggable/collapsible panel pattern: injected `<style>` block,
`slider(key, label, min, max, step, fmt, onChange, obj)`, `header(text)`, `select(key, label,
opts, onChange)`, `toggle(key, label, onChange)`, plus one new helper, `colorInput(key, label,
obj, onChange)`, for `bark.color`/`leaves.tint` (native `<input type="color">`, converting
`'#rrggbb'` ↔ the numeric hex `trees.js` expects).

All control callbacks read/write directly into nested paths of `opts` (e.g. `opts.bark.color`,
`opts.leaves.count`, `opts.length[level]`), then call `scheduleRegenerate()`.

Sections, top to bottom:

- **View** — mode select (Solo/Grid), `gridSize` slider (Grid mode only, 2-5), seed display +
  "Reroll seed" button.
- **Texture** — mode select (procedural/authored).
- **Structure** — `levels` slider (0-3, integer). Below it, a sub-panel that **rebuilds its rows**
  whenever `levels` changes (since the per-level arrays only matter up to `levels` deep): one
  row per level (0..levels) for each of `length`, `radius`, `taper`, `children`, `branchStart`,
  `angle`, `gnarliness`, `twist`, `sections`, `segments`. Ranges/steps mirror `trees.js`'s
  `DEFAULTS` magnitudes (e.g. `length` 1-30, `radius` 0.05-2, `taper`/`branchStart` 0-1,
  `children` 0-10 integer, `angle` 0-90, `gnarliness` 0-1, `twist` -1-1, `sections`/`segments`
  3-16 integer).
- **Force** — direction as azimuth (0-360°) + elevation (-90-90°) sliders (converted to/from the
  unit `[x,y,z]` vector `trees.js` expects), `strength` slider (0-0.2).
- **Bark** — `color` (color input), `roughness` (0-1), `flatShading` (toggle), `vScale` (0.05-2).
- **Leaves** — `enabled` (toggle), `count` (0-40), `size` (0.2-3), `sizeVariance` (0-1), `start`
  (0-0.9), `spread` (0-1), `angle` (0-90), `doubleBillboard` (toggle), `roundedNormals` (toggle),
  `shape` select (`quad`/`simple`), atlas cell pin (toggle + 0-3 index, only meaningful/visible
  when `texMode === 'authored'`), `shadowFraction` (0-1), `tint` (color input), `roughness`
  (0-1), `alphaTest` (0-1, only relevant with a map).
- **Export** — "Copy tree JSON" button: `navigator.clipboard.writeText(JSON.stringify(opts, null,
  2))`, with a `<textarea readonly>` underneath always showing the same current JSON (so the data
  is visible/selectable even if the Clipboard API throws, e.g. due to permissions).

### Error handling

Mirror the main viewer's pattern: a small `#info` banner, `showError(msg)` on `window.onerror` /
`unhandledrejection`, and a `.catch()` around the `trees.js`/`tree-textures.js` dynamic imports (or
just let the top-level `import` failure surface via the global error handler, since this tool has
no other systems that need to keep running if trees fail to load).

## Testing

No Node test — this is a visual tool with no pure-function math worth a `test-*.mjs` (unlike
`forest-cull.js`/`grass-cells.js`, there's no GPU/CPU parity math here). Verification is manual:
load the page, confirm Solo and Grid modes render, confirm every slider section regenerates the
tree(s), confirm texture mode switch loads/clears textures, confirm Export produces valid JSON
that round-trips through `createTree(JSON.parse(...))`.

## Docs / logging

- Add a short "Standalone tooling" paragraph to `docs/subsystems/vegetation.md` noting
  `tree-viewer.html` exists, what it imports (`trees.js`, `tree-textures.js`, `lights.js`), and
  that it's not wired into `environment-viewer.html`. No new subsystem table row — this isn't a
  lazy-loaded piece of the main app.
- One `agent_log.csv` row, subsystem `vegetation`, listing `tree-viewer.html` and the doc file
  touched.
