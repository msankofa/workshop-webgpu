# Terrain generator v4 — node-graph canvas layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `terrain-generator-v4.html`'s linear scrolling layout with a pannable/zoomable node-graph canvas where each pipeline-stage panel is a draggable node, positioned by default to match the pipeline's shape, connected by arrows, and persisted to `localStorage`.

**Architecture:** Pure DOM/CSS/vanilla-JS addition to the existing single-file page — no new files, no build step. The 9 existing `<section class="panel">` elements move (unchanged internally) into a new `#canvas-world` div that gets CSS-transformed for pan/zoom; 3 new dimmed placeholder `<div class="panel placeholder">` nodes stand in for unbuilt phases. All pan/zoom/drag/connector/persistence logic is added as new functions at the end of the existing `<script type="module">` in `terrain-generator-v4.html`, following the doc's stated pattern that "UI/DOM wiring lives entirely in `terrain-generator-v4.html`'s `<script type="module">`."

**Tech Stack:** Vanilla JS, CSS transforms, inline SVG for connectors, `localStorage`. No new dependencies.

**Reference:** `docs/superpowers/specs/2026-07-03-terrain-generator-v4-node-canvas-design.md`

---

## Ground truth: current file structure

`terrain-generator-v4.html` is 997 lines. Relevant current structure (verified by direct read, not memory):

- Lines 36-43: `main { max-width:980px; margin:0 auto; padding:0 24px 64px; display:flex; flex-direction:column; gap:32px; }`
- Lines 44-50: `.panel { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 28px 32px; box-shadow: 0 2px 10px rgba(43, 38, 32, 0.05); }`
- Line 130: `</style>`
- Lines 142-145: `<header class="hero">...</header>`
- Line 146: `<main>`
- Lines 147-176: `<section class="panel" id="section-overview">` (the static pipeline diagram — deleted by this plan)
- Lines 177-353: the 9 real panels, in order: `section-world-noise`, `section-height`, `section-erosion`, `section-derived`, `section-biome`, `section-material`, `section-heightfield`, `section-consumption`, `section-tables`
- Line 353: `</main>`
- Line 354: `<script type="module">`
- Lines 355-361: imports (`terrain-generator-js.js`, `three`, `three/webgpu`, `OrbitControls`)
- Lines 989-994: `buildReferenceTables(); initMapSelect(); loadRealMap(); regenerate();` (last statements before `</script>`)
- Line 995: `</script>`, line 996: `</body>`, line 997: `</html>`

Mouse handling throughout the file (heightfield raycast at line 542, canvas hover tooltips at lines 629/776/808/921) all use `element.getBoundingClientRect()`, which reports the actual on-screen (post-CSS-transform) box in every evergreen browser — **none of that code needs to change** for panels to work correctly inside a scaled/panned `#canvas-world`.

## Non-goals (carried over from the spec — do not do these)

- No change to any panel's internal markup, canvas rendering, slider handler, or `REDRAW_CALLBACKS` entry.
- No Phase D or Phase E functional content — placeholders only.
- No multi-select, panel resize, or user-editable connector routing.
- No automated test file for the pan/zoom/drag math (per spec: too small to justify a separate testable module). Verification is manual (browser) plus `node --check` for JS syntax safety after each edit.

---

### Task 1: CSS — canvas viewport/world/connector/placeholder rules

**Files:**
- Modify: `terrain-generator-v4.html:36-43` (the `main` rule)
- Modify: `terrain-generator-v4.html:130` (insert new rules before `</style>`)

- [ ] **Step 1: Replace the `main` flex/scroll layout rule**

The current rule lays out sections in a scrolling flex column. The canvas viewport now owns layout, so `main` just needs to stop constraining width/flow.

Old:
```css
  main {
    max-width: 980px;
    margin: 0 auto;
    padding: 0 24px 64px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
```

New:
```css
  main {
    padding: 0;
  }
```

- [ ] **Step 2: Insert the canvas/connector/placeholder CSS block before `</style>`**

Old:
```css
  .callout { background: #f1e9dc; border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 6px; font-size: 0.88em; margin-top: 10px; }
</style>
```

New:
```css
  .callout { background: #f1e9dc; border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 6px; font-size: 0.88em; margin-top: 10px; }
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
    margin: 0;
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
</style>
```

- [ ] **Step 3: Verify no syntax breakage**

Run: `node -e "require('fs').readFileSync('terrain-generator-v4.html','utf8').includes('#canvas-viewport') || process.exit(1)"` from the `workshop-webgpu` directory.
Expected: exits 0 (no output).

- [ ] **Step 4: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain-gen): add node-canvas CSS scaffolding"
```

---

### Task 2: HTML — remove static diagram, wrap panels in canvas world, add placeholders and Reset button

**Files:**
- Modify: `terrain-generator-v4.html:142-353`

- [ ] **Step 1: Add a "Reset layout" button to the hero**

Old:
```html
<header class="hero">
  <h1>Terrain generator v4</h1>
  <p>An in-browser port of terrain-v3's terrain pipeline (<code>G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\</code>). Each section below runs one pipeline stage and exposes its real config fields as sliders. Not bit-exact with a Python run: same algorithm, different seeded PRNG.</p>
</header>
```

New:
```html
<header class="hero">
  <h1>Terrain generator v4</h1>
  <p>An in-browser port of terrain-v3's terrain pipeline (<code>G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\</code>). Each section below runs one pipeline stage and exposes its real config fields as sliders. Not bit-exact with a Python run: same algorithm, different seeded PRNG.</p>
  <button class="action" id="reset-layout-btn" style="margin-top:16px;">Reset layout</button>
</header>
```

- [ ] **Step 2: Delete the static pipeline-overview section, open the canvas world**

Old:
```html
<main>
  <section class="panel" id="section-overview">
    <h2>1. Pipeline overview</h2>
    <div class="pipeline">
      <div class="pipe-box">Noise fields<br><span>continentalness, erosion, weirdness, temperature, humidity</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Height composer<br><span>continent/erosion knot interpolation + weirdness peaks/valleys</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Erosion simulation<br><span>hydraulic incision/deposition, thermal relaxation, D8 flow</span></div>
    </div>
    <div class="pipeline-fanout"><div class="pipe-arrow down">&darr;</div></div>
    <div class="pipeline">
      <div class="pipe-box">Derived masks<br><span>sea, lake, beach, mountain, rock, snow</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Biome classification<br><span>17 ordered rules, last match wins</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box">Material masks<br><span>grass, forest, dirt, sand, rock, snow, water</span></div>
    </div>
    <div class="pipeline-fanout"><div class="pipe-arrow down">&darr;</div></div>
    <div class="pipeline">
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Paint authoring<br><span>not yet built (Phase B)</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box small">Heightfield preview<br><span>direct grid-to-mesh, no voxels</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Density field preview<br><span>not yet built (Phase D)</span></div>
      <div class="pipe-arrow">&rarr;</div>
      <div class="pipe-box small" style="opacity:0.5; border:1px dashed var(--accent);">Marching cubes, water, forest, GLB export<br><span>not yet built (Phase E)</span></div>
    </div>
    <p class="lede" style="margin-top:20px;">Sections 2-7 below cover Phase A (noise fields through material masks). Section 8 is Phase C's heightfield preview. Section 9 shows a real exported map; section 10 lists the reference tables workshop-webgpu reads at runtime.</p>
  </section>

  <section class="panel" id="section-world-noise">
    <h2>2. World &amp; noise fields</h2>
```

New:
```html
<main>
  <div id="canvas-viewport">
    <div id="canvas-world">
      <svg id="connector-svg"></svg>

  <section class="panel" id="section-world-noise">
    <h2>World &amp; noise fields</h2>
```

- [ ] **Step 3: Strip numeric prefixes from the untouched middle sections' headings**

Four independent, order-preserving replacements (each `old` string appears exactly once in the file):

| Old | New |
|---|---|
| `<h2>3. Height composer</h2>` | `<h2>Height composer</h2>` |
| `<h2>4. Erosion &amp; hydrology</h2>` | `<h2>Erosion &amp; hydrology</h2>` |
| `<h2>5. Derived masks</h2>` | `<h2>Derived masks</h2>` |
| `<h2>6. Biome classification</h2>` | `<h2>Biome classification</h2>` |

- [ ] **Step 4: Strip numeric prefix from Material masks, insert the paint placeholder, strip prefix from Heightfield preview, insert density/marching placeholders, strip prefix from "A real exported map"**

Old:
```html
  <section class="panel" id="section-material">
    <h2>7. Material masks</h2>
    <p class="lede">Blended surface material from biome id, slope, and height. No dedicated controls: this stage only reads fields already exposed above.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="material-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="material-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="material-legend"></div>
    </div>
  </section>

  <section class="panel" id="section-heightfield">
    <h2>8. Heightfield preview</h2>
    <p class="lede">Direct height-grid to mesh conversion (no voxels, no marching cubes) -- a fast 3D check of Phase A's output at its own resolution.</p>
    <p class="callout hidden" id="heightfield-resolution-warning">Heightfield resolution is above 128 -- rebuilding the mesh may be slow.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <div id="heightfield-viewport" style="width:420px;height:420px;border-radius:8px;border:1px solid var(--border);overflow:hidden;"></div>
        <div id="heightfield-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <label for="heightfield-mode-select">Display mode</label>
          <select id="heightfield-mode-select">
            <option value="material">material</option>
            <option value="biome">biome</option>
            <option value="height">height</option>
            <option value="slope">slope</option>
            <option value="seaMask">sea mask</option>
            <option value="beachMask">beach mask</option>
            <option value="mountainMask">mountain mask</option>
            <option value="rockMask">rock mask</option>
            <option value="snowMask">snow mask</option>
            <option value="continentalness">continentalness</option>
            <option value="temperature">temperature</option>
            <option value="humidity">humidity</option>
            <option value="flowNorm">flow accumulation</option>
          </select>
        </div>
        <div class="control-row">
          <p class="control-desc">Grid resolution for the 3D mesh, independent of the 2D panels above.</p>
          <label for="heightfield-resolution">resolution <span id="heightfield-resolution-value">64</span></label>
          <input type="range" id="heightfield-resolution" min="16" max="256" step="8" value="64">
        </div>
        <div class="control-row">
          <label><input type="checkbox" id="heightfield-wireframe"> wireframe</label>
        </div>
        <button class="action" id="heightfield-reset-view">Reset view</button>
        <p class="lede" id="heightfield-stats"></p>
      </div>
    </div>
  </section>

  <section class="panel" id="section-consumption">
    <h2>9. A real exported map</h2>
```

New:
```html
  <section class="panel" id="section-material">
    <h2>Material masks</h2>
    <p class="lede">Blended surface material from biome id, slope, and height. No dedicated controls: this stage only reads fields already exposed above.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="material-canvas" width="128" height="128" style="width:420px;height:420px;"></canvas>
        <div id="material-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="material-legend"></div>
    </div>
  </section>

  <div class="panel placeholder" id="node-paint">
    <h2>Paint authoring</h2>
    <p class="lede">Not yet built (Phase B) — manual overrides layered onto the classifier output at five injection points.</p>
  </div>

  <section class="panel" id="section-heightfield">
    <h2>Heightfield preview</h2>
    <p class="lede">Direct height-grid to mesh conversion (no voxels, no marching cubes) -- a fast 3D check of Phase A's output at its own resolution.</p>
    <p class="callout hidden" id="heightfield-resolution-warning">Heightfield resolution is above 128 -- rebuilding the mesh may be slow.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <div id="heightfield-viewport" style="width:420px;height:420px;border-radius:8px;border:1px solid var(--border);overflow:hidden;"></div>
        <div id="heightfield-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls">
        <div class="control-row">
          <label for="heightfield-mode-select">Display mode</label>
          <select id="heightfield-mode-select">
            <option value="material">material</option>
            <option value="biome">biome</option>
            <option value="height">height</option>
            <option value="slope">slope</option>
            <option value="seaMask">sea mask</option>
            <option value="beachMask">beach mask</option>
            <option value="mountainMask">mountain mask</option>
            <option value="rockMask">rock mask</option>
            <option value="snowMask">snow mask</option>
            <option value="continentalness">continentalness</option>
            <option value="temperature">temperature</option>
            <option value="humidity">humidity</option>
            <option value="flowNorm">flow accumulation</option>
          </select>
        </div>
        <div class="control-row">
          <p class="control-desc">Grid resolution for the 3D mesh, independent of the 2D panels above.</p>
          <label for="heightfield-resolution">resolution <span id="heightfield-resolution-value">64</span></label>
          <input type="range" id="heightfield-resolution" min="16" max="256" step="8" value="64">
        </div>
        <div class="control-row">
          <label><input type="checkbox" id="heightfield-wireframe"> wireframe</label>
        </div>
        <button class="action" id="heightfield-reset-view">Reset view</button>
        <p class="lede" id="heightfield-stats"></p>
      </div>
    </div>
  </section>

  <div class="panel placeholder" id="node-density">
    <h2>Density field preview</h2>
    <p class="lede">Not yet built (Phase D) — the real cave/warp-aware 3D density field, not the 2D-only preview stand-in.</p>
  </div>

  <div class="panel placeholder" id="node-marching">
    <h2>Marching cubes, water, forest, GLB export</h2>
    <p class="lede">Not yet built (Phase E) — surface extraction and the rest of the export pipeline.</p>
  </div>

  <section class="panel" id="section-consumption">
    <h2>A real exported map</h2>
```

- [ ] **Step 5: Strip numeric prefix from Reference tables, close the canvas world**

Old:
```html
  <section class="panel" id="section-tables">
    <h2>10. Reference tables</h2>
    <p class="lede">The two lookup tables workshop-webgpu actually uses at runtime.</p>
    <div class="gen-layout">
      <div style="flex:1 1 320px;">
        <h3>Ground texture fallback</h3>
        <table class="ref-table" id="table-material"></table>
      </div>
      <div style="flex:1 1 260px;">
        <h3>Tree density</h3>
        <table class="ref-table" id="table-density"></table>
      </div>
    </div>
  </section>
</main>
```

New:
```html
  <section class="panel" id="section-tables">
    <h2>Reference tables</h2>
    <p class="lede">The two lookup tables workshop-webgpu actually uses at runtime.</p>
    <div class="gen-layout">
      <div style="flex:1 1 320px;">
        <h3>Ground texture fallback</h3>
        <table class="ref-table" id="table-material"></table>
      </div>
      <div style="flex:1 1 260px;">
        <h3>Tree density</h3>
        <table class="ref-table" id="table-density"></table>
      </div>
    </div>
  </section>

    </div>
  </div>
</main>
```

- [ ] **Step 6: Verify structure**

Run: `grep -c "class=\"panel" terrain-generator-v4.html` (Bash tool, or PowerShell `Select-String`)
Expected: `12` (9 real sections + 3 placeholder divs).

Run: `grep -n "1\. Pipeline overview\|section-overview" terrain-generator-v4.html`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain-gen): restructure panels into canvas-world, add placeholder nodes"
```

---

### Task 3: JS — layout state, default positions, persistence

**Files:**
- Modify: `terrain-generator-v4.html` (append new code after line 378's `const REDRAW_CALLBACKS = [];`, before the `// ---- section 8` comment at line 380)

- [ ] **Step 1: Insert the layout-state module**

Old:
```js
  const REDRAW_CALLBACKS = [];

  // ---- section 8: Heightfield preview -- Three.js setup ----
```

New:
```js
  const REDRAW_CALLBACKS = [];

  // ---- Node-graph canvas: layout state, persistence, pan/zoom/drag, connectors ----
  const LAYOUT_STORAGE_KEY = 'terrain-generator-v4-layout';
  const PANEL_WIDTH = 820;

  const DEFAULT_LAYOUT = {
    'section-world-noise': { x: 0, y: 0 },
    'section-height': { x: 900, y: 0 },
    'section-erosion': { x: 1800, y: 0 },
    'section-derived': { x: 0, y: 1300 },
    'section-biome': { x: 900, y: 1300 },
    'section-material': { x: 1800, y: 1300 },
    'node-paint': { x: -900, y: 2600 },
    'section-heightfield': { x: 0, y: 2600 },
    'node-density': { x: 900, y: 2600 },
    'node-marching': { x: 1800, y: 2600 },
    'section-consumption': { x: 3000, y: 0 },
    'section-tables': { x: 3000, y: 1300 },
  };

  const CONNECTOR_EDGES = [
    ['section-world-noise', 'section-height'],
    ['section-height', 'section-erosion'],
    ['section-erosion', 'section-derived'],
    ['section-derived', 'section-biome'],
    ['section-biome', 'section-material'],
    ['section-material', 'node-paint'],
    ['node-paint', 'section-heightfield'],
    ['section-heightfield', 'node-density'],
    ['node-density', 'node-marching'],
  ];

  const canvasViewport = document.getElementById('canvas-viewport');
  const canvasWorld = document.getElementById('canvas-world');
  const connectorSvg = document.getElementById('connector-svg');

  let panX = 0, panY = 0, zoom = 1;
  const panelPositions = {};

  function loadLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) throw new Error('no saved layout');
      const parsed = JSON.parse(raw);
      panX = typeof parsed.panX === 'number' ? parsed.panX : 0;
      panY = typeof parsed.panY === 'number' ? parsed.panY : 0;
      zoom = typeof parsed.zoom === 'number' ? parsed.zoom : 1;
      for (const id of Object.keys(DEFAULT_LAYOUT)) {
        const saved = parsed.positions && parsed.positions[id];
        panelPositions[id] = (saved && typeof saved.x === 'number' && typeof saved.y === 'number')
          ? { x: saved.x, y: saved.y }
          : { ...DEFAULT_LAYOUT[id] };
      }
    } catch {
      panX = 0; panY = 0; zoom = 1;
      for (const id of Object.keys(DEFAULT_LAYOUT)) panelPositions[id] = { ...DEFAULT_LAYOUT[id] };
    }
  }

  function saveLayout() {
    const positions = {};
    for (const id of Object.keys(DEFAULT_LAYOUT)) positions[id] = panelPositions[id];
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ panX, panY, zoom, positions }));
  }

  function applyWorldTransform() {
    canvasWorld.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function applyPanelPosition(id) {
    const el = document.getElementById(id);
    const pos = panelPositions[id];
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  // ---- section 8: Heightfield preview -- Three.js setup ----
```

- [ ] **Step 2: Verify JS still parses**

Run (from `workshop-webgpu/` directory, Bash tool):
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('terrain-generator-v4.html','utf8');const m=html.match(/<script type=\"module\">([\s\S]*)<\/script>/);fs.writeFileSync('_tg4-check.mjs', m[1]);" && node --check _tg4-check.mjs && rm _tg4-check.mjs
```
Expected: no output, exit code 0 (syntax valid). If it errors, the error message will point at the exact line/column to fix (relative `import` paths won't resolve during `--check` since the temp file lives in the same directory as its imports, so this only validates syntax, not module resolution — that's fine, resolution is exercised by the browser in Task 6).

- [ ] **Step 3: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain-gen): add node-canvas layout state and persistence"
```

---

### Task 4: JS — connector rendering

**Files:**
- Modify: `terrain-generator-v4.html` (append immediately after Task 3's `applyPanelPosition` function, still before the `// ---- section 8` comment)

- [ ] **Step 1: Insert connector-path and render functions**

Old:
```js
  function applyPanelPosition(id) {
    const el = document.getElementById(id);
    const pos = panelPositions[id];
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  // ---- section 8: Heightfield preview -- Three.js setup ----
```

New:
```js
  function applyPanelPosition(id) {
    const el = document.getElementById(id);
    const pos = panelPositions[id];
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  function panelRect(id) {
    const pos = panelPositions[id];
    const el = document.getElementById(id);
    return { x: pos.x, y: pos.y, width: PANEL_WIDTH, height: el.offsetHeight };
  }

  function edgePath(fromId, toId) {
    const a = panelRect(fromId);
    const b = panelRect(toId);
    if (a.y === b.y) {
      const x1 = a.x + a.width, y1 = a.y + a.height / 2;
      const x2 = b.x, y2 = b.y + b.height / 2;
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const x1 = a.x + a.width / 2, y1 = a.y + a.height;
    const x2 = b.x + b.width / 2, y2 = b.y;
    const midY = (y1 + y2) / 2;
    return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
  }

  function renderConnectors() {
    const arrowheadDefs = '<defs><marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="var(--accent)"></path></marker></defs>';
    const edges = CONNECTOR_EDGES.map(([from, to]) =>
      `<path d="${edgePath(from, to)}" stroke="var(--accent)" stroke-width="2" fill="none" marker-end="url(#arrowhead)"></path>`
    ).join('');
    connectorSvg.innerHTML = arrowheadDefs + edges;
  }

  // ---- section 8: Heightfield preview -- Three.js setup ----
```

- [ ] **Step 2: Verify JS still parses**

Run the same `node --input-type=module --check` command from Task 3 Step 2.
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain-gen): add node-canvas connector rendering"
```

---

### Task 5: JS — pan, zoom, panel drag, Reset layout, init wiring

**Files:**
- Modify: `terrain-generator-v4.html:989-994` (the final block before `</script>`)

- [ ] **Step 1: Insert interaction handlers and the layout init call**

Old:
```js
  buildReferenceTables();

  initMapSelect();
  loadRealMap();

  regenerate();
</script>
```

New:
```js
  buildReferenceTables();

  initMapSelect();
  loadRealMap();

  regenerate();

  // ---- Node-graph canvas: pan, zoom, panel drag, reset, init ----
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
  let draggingPanelId = null;
  let dragStartX = 0, dragStartY = 0, dragOriginX = 0, dragOriginY = 0;

  canvasViewport.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('.panel')) return;
    isPanning = true;
    canvasViewport.classList.add('panning');
    panStartX = ev.clientX;
    panStartY = ev.clientY;
    panOriginX = panX;
    panOriginY = panY;
    ev.preventDefault();
  });

  window.addEventListener('mousemove', (ev) => {
    if (isPanning) {
      panX = panOriginX + (ev.clientX - panStartX);
      panY = panOriginY + (ev.clientY - panStartY);
      applyWorldTransform();
    } else if (draggingPanelId) {
      const worldDeltaX = (ev.clientX - dragStartX) / zoom;
      const worldDeltaY = (ev.clientY - dragStartY) / zoom;
      panelPositions[draggingPanelId] = { x: dragOriginX + worldDeltaX, y: dragOriginY + worldDeltaY };
      applyPanelPosition(draggingPanelId);
      renderConnectors();
    }
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      canvasViewport.classList.remove('panning');
      saveLayout();
    }
    if (draggingPanelId) {
      draggingPanelId = null;
      saveLayout();
    }
  });

  canvasViewport.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvasViewport.getBoundingClientRect();
    const cursorScreenX = ev.clientX - rect.left;
    const cursorScreenY = ev.clientY - rect.top;
    const zoomOld = zoom;
    const worldX = (cursorScreenX - panX) / zoomOld;
    const worldY = (cursorScreenY - panY) / zoomOld;
    const zoomFactor = Math.exp(-ev.deltaY * 0.001);
    const zoomNew = Math.min(3, Math.max(0.2, zoomOld * zoomFactor));
    panX = cursorScreenX - worldX * zoomNew;
    panY = cursorScreenY - worldY * zoomNew;
    zoom = zoomNew;
    applyWorldTransform();
  }, { passive: false });

  for (const id of Object.keys(DEFAULT_LAYOUT)) {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('placeholder')) continue;
    const header = el.querySelector('h2');
    if (!header) continue;
    header.addEventListener('mousedown', (ev) => {
      draggingPanelId = id;
      dragStartX = ev.clientX;
      dragStartY = ev.clientY;
      dragOriginX = panelPositions[id].x;
      dragOriginY = panelPositions[id].y;
      ev.preventDefault();
      ev.stopPropagation();
    });
  }

  document.getElementById('reset-layout-btn').addEventListener('click', () => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    panX = 0; panY = 0; zoom = 1;
    for (const id of Object.keys(DEFAULT_LAYOUT)) panelPositions[id] = { ...DEFAULT_LAYOUT[id] };
    for (const id of Object.keys(DEFAULT_LAYOUT)) applyPanelPosition(id);
    applyWorldTransform();
    renderConnectors();
  });

  loadLayout();
  for (const id of Object.keys(DEFAULT_LAYOUT)) applyPanelPosition(id);
  applyWorldTransform();
  renderConnectors();
</script>
```

- [ ] **Step 2: Verify JS still parses**

Run the same `node --input-type=module --check` command from Task 3 Step 2.
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain-gen): wire up node-canvas pan/zoom/drag/reset interactions"
```

---

### Task 6: Manual browser verification

**Files:** none (verification only)

- [ ] **Step 1: Start the local server**

Run: `python serve.py 8080` (from `workshop-webgpu/`, background/separate terminal)

- [ ] **Step 2: Load the page and check initial state**

Open `http://127.0.0.1:8080/terrain-generator-v4.html`. Confirm via screenshot or headless-Chrome DOM dump:
- The old numbered static diagram is gone.
- 9 real panels + 3 dimmed dashed placeholder nodes are visible/reachable, positioned per the `DEFAULT_LAYOUT` table (World & noise fields at the top-left, in view on load).
- Arrows connect world-noise→height→erosion→derived→biome→material→paint→heightfield→density→marching.
- Headings no longer show numeric prefixes ("World & noise fields", not "2. World & noise fields").

- [ ] **Step 3: Check interactions**

- Drag the background: the whole graph pans, cursor shows grab/grabbing.
- Scroll the wheel over a panel: the graph zooms, the point under the cursor stays fixed.
- Drag a panel's `<h2>`: only that panel moves; its connector edges follow it; sliders/canvases inside still work (change a slider, confirm the panel's canvas redraws).
- Reload the page: pan/zoom/panel position from before the reload is restored.
- Click "Reset layout": panels/pan/zoom return to the default grid, and reloading again after this keeps the reset state (not the old saved one).
- Placeholder nodes are visibly dimmed/dashed and not draggable.

- [ ] **Step 4: Check the heightfield panel specifically**

Confirm the Three.js viewport (section-heightfield) still renders/orbits correctly now that it sits inside a scaled/panned ancestor — this is the one panel with its own internal pointer-drag (OrbitControls) that could conflict with the page's own pan logic if `stopPropagation` is missing anywhere it's needed. If OrbitControls dragging inadvertently triggers a canvas-world pan, add `ev.stopPropagation()` to the mousedown case in `canvasViewport`'s pan handler when `ev.target.closest('#heightfield-viewport')` is truthy, mirroring the `.panel` header exclusion already in place — panels themselves already exclude via `ev.target.closest('.panel')`, so this should not be necessary, but check.

- [ ] **Step 5: Fix anything found in Step 2-4 inline, then re-verify.**

---

### Task 7: Docs and logging

**Files:**
- Modify: `workshop-webgpu/agent_log.csv` (append one row)

- [ ] **Step 1: Append the log row**

Add this line to the end of `agent_log.csv` (append only — do not edit or reorder existing rows):

```
2026-07-03T00:00,terrain,terrain-generator-v4.html,"Replaced terrain-generator-v4.html's linear scrolling layout with a pannable/zoomable node-graph canvas: draggable panels positioned to match the pipeline shape, SVG connector arrows, localStorage-persisted layout, dimmed placeholder nodes for the still-unbuilt Phase B/D/E stages; removed the now-redundant static pipeline diagram."
```

(No `docs/subsystems/biomes.md` change needed — per the design spec, its link description doesn't reference the page's internal layout. No `code-map.html` change needed — the `TOOL_LINKS` entry for this page already exists and doesn't track line counts for tool pages.)

- [ ] **Step 2: Commit**

```bash
git add agent_log.csv
git commit -m "docs: log node-canvas layout change in agent_log.csv"
```

---

## Plan self-review notes

- **Spec coverage:** DOM structure (Task 2), CSS (Task 1), pan (Task 5), zoom (Task 5), panel drag (Task 5), persistence (Task 3 + Task 5's `loadLayout()`/`saveLayout()` calls), default layout table (Task 3's `DEFAULT_LAYOUT`, values copied verbatim from the spec table), connectors (Task 4, 9 edges matching the spec's edge list exactly), Reset layout button (Task 2 Step 1 + Task 5), testing (Task 6, manual, matches spec's "no automated test" call), docs/logging (Task 7). No spec section is uncovered.
- **Placeholder scan:** no TBD/TODO markers; Task 6 Step 4 is the one step that says "if X, fix Y" rather than prescribing a fixed action — that's intentional, it's a verification/conditional-fix step, not a placeholder, and it names the exact fix (`ev.target.closest('#heightfield-viewport')` exclusion) to apply if needed.
- **Type/id consistency:** `DEFAULT_LAYOUT` keys (Task 3) match `CONNECTOR_EDGES` entries (Task 4) and the `id`s introduced in Task 2 Step 4 (`node-paint`, `node-density`, `node-marching`) and the pre-existing section ids — all 12 cross-checked against the grep output captured at the top of this plan.
