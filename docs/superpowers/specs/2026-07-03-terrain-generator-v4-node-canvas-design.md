# Terrain generator v4 — node-graph canvas layout

## Purpose

`terrain-generator-v4.html` is currently a linear top-to-bottom scrolling page, numbered
section 1 through 10, with a static SVG-in-HTML pipeline diagram (section 1) that
duplicates information already implied by the section order. This redesigns the page
into a pannable/zoomable canvas where each pipeline stage is its own draggable panel,
positioned by default to match the pipeline's actual shape (the diagram becomes the
layout itself, so the standalone diagram is removed). This is a layout/interaction
change only — no pipeline stage's content, math, or wiring changes.

This work is a prerequisite for Phase D (density field preview, currently paused) and
Phase E (marching cubes/water/forest/export, not yet built): both land as new nodes in
this graph once built, rather than new numbered sections in a scroll.

## Non-goals

- **No change to any panel's content or logic.** Every canvas-rendering function,
  slider handler, colormap call, and `REDRAW_CALLBACKS` entry in `terrain-generator-js.js`
  and `terrain-generator-v4.html` stays exactly as it is. This spec only repositions
  existing `<section class="panel">` elements and adds pan/zoom/drag chrome around them.
- **No Phase D or Phase E content.** Those get dimmed placeholder nodes in the graph
  (preserving the roadmap visibility the removed static diagram used to provide) but no
  new functional panels.
- **No multi-select, no panel resize, no connector rerouting by the user** — panels move
  as a unit via their header; connectors are computed automatically, not user-edited.
- **No test coverage for the pan/zoom/drag math itself** — same rationale as the rest of
  this page's UI wiring (visual, verified manually/via screenshot), and the math involved
  (~10-15 lines of coordinate transforms) is too small to justify a separate testable
  module.

## Architecture

### DOM structure

```
<main>
  <div id="canvas-viewport">          <!-- fixed-size window, overflow:hidden -->
    <div id="canvas-world">           <!-- transform: translate(panX,panY) scale(zoom) -->
      <svg id="connector-svg">...</svg>
      <section class="panel" id="section-world-noise">...</section>   <!-- unchanged content -->
      <section class="panel" id="section-height">...</section>
      <section class="panel" id="section-erosion">...</section>
      <section class="panel" id="section-derived">...</section>
      <section class="panel" id="section-biome">...</section>
      <section class="panel" id="section-material">...</section>
      <section class="panel" id="section-heightfield">...</section>
      <section class="panel" id="section-consumption">...</section>   <!-- real exported map -->
      <section class="panel" id="section-tables">...</section>        <!-- reference tables -->
      <div class="panel placeholder" id="node-paint">Paint authoring (Phase B)</div>
      <div class="panel placeholder" id="node-density">Density field preview (Phase D)</div>
      <div class="panel placeholder" id="node-marching">Marching cubes, water, forest, GLB export (Phase E)</div>
    </div>
  </div>
</main>
```

The 9 real `<section class="panel">` elements keep their exact current internal markup
and ids (`section-world-noise` through `section-tables`) — they are cut from their
current flow position in `<main>` and pasted as children of `#canvas-world`, nothing
inside them changes. Three new `<div class="panel placeholder">` elements are dimmed
non-interactive stand-ins for Phase B/D/E, styled like the old diagram's dashed "not yet
built" boxes.

The old `<header class="hero">` (title + intro paragraph) stays exactly where it is,
above `<main>` — a normal, non-canvas top banner. Section 1's static pipeline-overview
`<section>` is deleted entirely. Every remaining section's `<h2>` drops its numeric
prefix ("2. World & noise fields" → "World & noise fields") since reading order no
longer applies in a free-form graph.

### CSS

```css
#canvas-viewport {
  position: relative;
  width: 100%;
  height: 82vh;
  overflow: hidden;
  background: var(--paper);
  cursor: grab;
  border-top: 1px solid var(--border);
}
#canvas-viewport.panning { cursor: grabbing; }
#canvas-world {
  position: absolute;
  top: 0; left: 0;
  transform-origin: 0 0;
  will-change: transform;
}
#connector-svg {
  position: absolute;
  top: 0; left: 0;
  overflow: visible;
  pointer-events: none;
}
#canvas-world .panel {
  position: absolute;
  width: 820px;
  margin: 0; /* was margin/gap-driven flex spacing; position now comes from left/top */
}
.panel.placeholder {
  opacity: 0.5;
  border: 1px dashed var(--accent);
  pointer-events: none;
  padding: 20px 24px;
}
#canvas-world .panel h2 {
  cursor: grab;
  user-select: none;
}
#canvas-world .panel h2:active { cursor: grabbing; }
```

`main`'s old `display:flex; flex-direction:column; gap:32px;` rule (which laid out the
scrolling sections) is removed/superseded by `#canvas-viewport`'s fixed-size window.

### Pan

Mousedown on `#canvas-world`'s background (event target is `#canvas-world` or
`#connector-svg`, not a descendant `.panel`) starts a pan drag. Each `mousemove` while
dragging adds the raw screen-pixel delta directly to `panX`/`panY` (1:1 — with
`transform: translate(panX,panY) scale(zoom)`, `translate` is applied after `scale`, so
`panX`/`panY` are already in screen-pixel units regardless of current zoom).

### Zoom

Wheel event over `#canvas-viewport` adjusts `zoom` (clamped to `[0.2, 3]`), keeping the
point under the cursor fixed on screen:

```js
const worldX = (cursorScreenX - panX) / zoomOld;
const worldY = (cursorScreenY - panY) / zoomOld;
// after computing zoomNew (clamped):
panX = cursorScreenX - worldX * zoomNew;
panY = cursorScreenY - worldY * zoomNew;
zoom = zoomNew;
```

### Dragging a panel

Mousedown on a `.panel h2` (not a placeholder, which is `pointer-events: none`) starts a
panel drag. Each `mousemove` converts the screen-pixel delta to world-space by dividing
by the current `zoom` (`worldDeltaX = screenDeltaX / zoom`), adds it to that panel's
stored `x`/`y`, and updates its `left`/`top` style plus any connector `<line>` endpoints
that reference it.

### Persistence

One `localStorage` key, `terrain-generator-v4-layout`, holding:

```json
{ "panX": 0, "panY": 0, "zoom": 1, "positions": { "section-world-noise": { "x": 0, "y": 0 }, "...": "..." } }
```

Written on drag-end (pan release or panel-drag release), not on every `mousemove`. Read
once on page load; if absent or fails to parse, every panel falls back to its default
position (below) and `panX/panY/zoom` default to `0, 0, 1`. A "Reset layout" button
(placed in the hero, since it's the one persistent chrome element outside the canvas)
clears the `localStorage` key and re-applies the defaults without a page reload.

## Default layout

820px-wide panels, 900px horizontal pitch, 1300px vertical pitch (generous enough that
the tallest panel — World & noise fields, ~15 sliders — never overlaps the row below):

| Node | id | x | y |
|---|---|---|---|
| World & noise fields | `section-world-noise` | 0 | 0 |
| Height composer | `section-height` | 900 | 0 |
| Erosion & hydrology | `section-erosion` | 1800 | 0 |
| Derived masks | `section-derived` | 0 | 1300 |
| Biome classification | `section-biome` | 900 | 1300 |
| Material masks | `section-material` | 1800 | 1300 |
| Paint authoring (Phase B, placeholder) | `node-paint` | -900 | 2600 |
| Heightfield preview | `section-heightfield` | 0 | 2600 |
| Density field preview (Phase D, placeholder) | `node-density` | 900 | 2600 |
| Marching cubes/water/export (Phase E, placeholder) | `node-marching` | 1800 | 2600 |
| A real exported map | `section-consumption` | 3000 | 0 |
| Reference tables | `section-tables` | 3000 | 1300 |

Initial `panX/panY` are set so the World & noise fields node (top-left of the main
pipeline flow) is visible in the viewport on first load; `zoom` starts at `1`.

## Connectors

Nine arrows, matching the pipeline's sequential stage order (the same simplification the
old static diagram already made — author-layer injection points are not shown as
separate edges):

`world-noise → height → erosion → derived → biome → material → paint(placeholder) → heightfield → density(placeholder) → marching(placeholder)`

Each edge is one SVG `<path>` with a `marker-end` arrowhead. Horizontal neighbors (same
row) connect right-edge-midpoint to left-edge-midpoint with a straight line. Row-transition
edges (material → paint, e.g., a large horizontal jump between rows) use a right-angle
elbow path (down from the source's bottom-midpoint, across, then down into the target's
top-midpoint) so the line doesn't cut diagonally across unrelated panels. "A real exported
map" and "Reference tables" have no connectors (per their off-to-the-side placement).
Endpoints recompute whenever either connected panel's position changes (drag or reset).

## Testing

No automated test for the canvas/pan/zoom/drag system itself (visual/interactive,
verified manually — same rationale as the rest of this page). Verification: pan by
dragging the background, zoom with the wheel (cursor point stays fixed), drag a panel by
its header (canvas content inside keeps working — hover tooltips, sliders, dropdowns),
reload the page and confirm the dragged position persisted, click "Reset layout" and
confirm it returns to the default grid, confirm placeholder nodes are non-interactive
and visually dimmed.

## Docs / logging

- No `docs/subsystems/biomes.md` changes needed — the link description doesn't reference
  the page's internal layout.
- One `agent_log.csv` row, subsystem `terrain`, listing `terrain-generator-v4.html`
  (the only file touched — this is a pure layout/interaction change, no
  `terrain-generator-js.js` involvement).
