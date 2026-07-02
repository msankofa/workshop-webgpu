# Terrain generator v4 — Phase C: heightfield preview

## Purpose

Phase A (`docs/superpowers/specs/2026-07-02-terrain-generator-v4-phase-a-design.md`) built
the 2D pipeline (noise fields through material masks) as flat canvas panels. Phase C adds
a 3D view of the same data: a direct height-grid-to-mesh conversion, rendered in an
interactive Three.js viewport, matching terrain-v3's own "heightfield preview" stage
(`heightfield_pipeline.py`) — a fast, non-volumetric way to see the terrain in 3D before
the (not-yet-built) marching-cubes/density-field stages.

Phase B (paint authoring) is deferred; this phase depends only on Phase A's output.

## Non-goals

- **No 3D painting.** Real terrain-v3's "PAINT IN 3D" toggle requires Phase B's paint
  layers, which don't exist yet. Out of scope entirely.
- **No density field or marching cubes.** Those are Phases D and E.
- **Not bit-exact** with a real Python run, same caveat as every other phase.
- **No visual test for the viewport itself.** Same rationale as the rest of
  `terrain-generator-v4.html` (a visual page) — verification is manual/screenshot-based.
  Headless Chrome with `--disable-gpu` may not render WebGPU content at all, unlike
  Phase A's plain 2D canvas panels, which worked fine headless; this phase's automated
  verification is limited to DOM structure and absence of console errors, not actual
  rendered pixels.

## Architecture

### `buildHeightfieldMesh` — new, DOM-free, in `terrain-generator-js.js`

```
buildHeightfieldMesh(height, resolution, worldX, worldZ)
  -> { positions: Float32Array(resolution*resolution*3),
       normals:   Float32Array(resolution*resolution*3),
       indices:   Uint32Array((resolution-1)*(resolution-1)*6) }
```

- **Positions**: for cell `(ix, iz)`, `x = (ix/(resolution-1) - 0.5) * worldX`,
  `y = height[iz*resolution+ix]`, `z = (iz/(resolution-1) - 0.5) * worldZ` — the same
  centering convention `generateFullGrid` already uses, so the mesh lines up with the 2D
  panels' coordinate space exactly.
- **Normals**: central-difference of the height field (reuses the same edge-aware
  neighbor-sampling pattern as `gradientMagnitude`, but returns a 3-component
  `(-dHeight/dx, 1, -dHeight/dz)` vector normalized to unit length per vertex, instead of
  a scalar magnitude).
- **Indices**: two triangles per grid quad, front-face-up winding — matching the
  convention `terrain-field.js`'s `buildChunkArrays` already establishes elsewhere in
  this codebase (not imported from it; a separate, smaller, standalone implementation,
  same spirit as the rest of `terrain-generator-js.js` being a hand-synced twin rather
  than a shared dependency).

This function has zero Three.js/DOM dependency, matching the rest of
`terrain-generator-js.js` and the codebase's "CPU/GPU math twin" convention — it's
Node-testable on its own.

### Independent resolution + update wiring

- `heightfieldResolution` — a new page-local variable in `terrain-generator-v4.html`
  (**not** part of `genConfig`/`FIELD_GROUPS`), with its own slider: range 16-256, step
  8, default 64.
- `regenerateHeightfield()` calls `generateFullGrid(genConfig, heightfieldResolution)`
  (same seed/world/noise/height/erosion config as the 2D panels, independent
  resolution), then calls `buildHeightfieldMesh` and updates the `BufferGeometry`'s
  `position`/`normal`/`index` attributes in place (`geometry.attributes.position.array`
  etc., with `needsUpdate = true`) rather than disposing and recreating the mesh every
  time.
- `regenerateHeightfield` is added to the existing `REDRAW_CALLBACKS` array (so any
  slider change anywhere still reaches it, keeping the "one shared pipeline run" model
  from Phase A intact), but internally applies its **own** additional debounce
  (~300ms, layered on top of the 150ms shared debounce) before actually rebuilding the
  mesh — mesh rebuild is far more expensive than a 2D canvas redraw, and a rapid
  sequence of slider drags shouldn't rebuild it on every intermediate `regenerate()`
  call.
- A resolution-warning banner (same `.callout` pattern as section 2's) appears when
  `heightfieldResolution > 128`, text: "Heightfield resolution above 128 may be slow to
  rebuild." — mirrors terrain-v3's own `heightfield_warnings` threshold/message.

### Three.js viewport setup

Matches `tree-viewer.html`'s established pattern in this same directory exactly, rather
than hand-rolling camera-drag math the way terrain-v3's own vendored viewport does:

- Importmap: `three`/`three/webgpu`/`three/tsl`/`three/addons/` all pinned to
  `three@0.184.0` via the `cdn.jsdelivr.net` CDN (identical URLs to `tree-viewer.html`'s
  own importmap).
- `THREE.WebGPURenderer`, `await renderer.init()` before first render (async setup,
  same as `tree-viewer.html`).
- `OrbitControls` from `three/addons/controls/OrbitControls.js` — provides orbit drag,
  wheel zoom, and (via its built-in right-click/two-finger pan) panning out of the box.
  A "Reset view" button restores a stored initial `camera.position`/`controls.target`
  and calls `controls.update()`.
- A wireframe checkbox toggles `material.wireframe`.
- Basic lighting: one directional light + one ambient/hemisphere light, enough for
  normals to read visually in non-flat display modes (material/biome modes don't
  strictly need lighting since they're already fully-specified colors, but height/slope
  gradients benefit from a bit of shading).

### Display modes & vertex coloring

A dropdown (mirrors the 2D panels' panel-select convention) switches which per-vertex
color array is applied to the existing geometry — switching modes recolors only, no mesh
rebuild:

- **material** (default) — `materialRgba` divided by 255.
- **biome** — `BIOME_COLORS[BIOMES[biomeId]]` divided by 255.
- **height**, **slope** — `heightColor`/`slopeColor`, same helpers the 2D panels use,
  divided by 255 (those helpers return 0-255 ints; Three.js vertex colors want 0-1
  floats).
- **sea mask, beach mask, mountain mask, rock mask, snow mask** — `maskColor` per mask,
  same palette as their respective 2D panels.
- **continentalness, temperature, humidity** — `divergingColor`.
- **flow accumulation** — `flowColor`.

This is the full list `generateFullGrid` already computes (matching real terrain-v3's
own heightfield display-mode list, minus the paint-layer-specific modes that don't apply
since Phase B is deferred).

### Interaction & stats

- Hover raycast (`THREE.Raycaster` against the mesh on `pointermove`) reports world
  x/z, height, and the active display mode's raw value at that vertex — same tooltip
  convention (position, content style) as the 2D panels' hover tooltips.
- A stats line under the viewport shows vertex count (`heightfieldResolution²`),
  triangle count (`(heightfieldResolution-1)² * 2`), height min/max, and cell size
  (`worldX/(heightfieldResolution-1)`, `worldZ/(heightfieldResolution-1)`) — matches
  Phase A's existing stats-display convention and terrain-v3's own heightfield stats.

## Page placement

New section 8, "Heightfield preview," inserted directly after section 7 (Material
masks — the last Phase A stage) since it's a live-generator capability that belongs
with the pipeline stages, not next to the static reference sections. The existing "A
real exported map" and "Reference tables" sections renumber from 8/9 to 9/10. The hero's
pipeline-overview diagram (section 1) updates the "Heightfield preview" pipe-box from
its current dimmed "not yet built (Phase C)" state to a normal, filled-in box.

## Testing

`buildHeightfieldMesh` gets Node tests appended to `test-terrain-generator-js.mjs`
(same file, same `ok()` convention as the rest of the suite):

- Vertex count equals `resolution²`; index count equals `(resolution-1)² * 6`.
- Position mapping is correct on a small known grid (e.g. a 3×3 grid with a known
  height array — verify specific vertices land at the expected `x`/`y`/`z`).
- Normals are unit-length (magnitude ≈ 1) for every vertex.
- On a perfectly flat height field, every normal points straight up (`(0, 1, 0)`).
- On a simple known slope (e.g. linear ramp), normal direction is checked against the
  analytically-expected tilted vector.

No test for `terrain-generator-v4.html`'s viewport itself — verified manually via
screenshot (checking DOM structure, canvas presence, no console errors) rather than
pixel content, per the Non-goals section's WebGPU-headless caveat.

## Docs / logging

- Update `docs/subsystems/biomes.md`'s existing `terrain-generator-v4.html` link
  description to mention the heightfield viewport now that it exists (still one line,
  same pattern as the Phase A addition).
- One `agent_log.csv` row, subsystem `terrain`, listing `terrain-generator-v4.html`,
  `terrain-generator-js.js`, `test-terrain-generator-js.mjs`.
