# Tree Viewer: Floating Panels + Docked Mutation Panel

Combined brief spec + plan. Confirmed with the user: every Tuning-tab section (View, Texture,
Lighting, Structure, Force, Bark, Leaves, Export) becomes click-to-open-a-floating-panel instead
of inline accordion expansion; within Structure, each trait (Length, Radius, ... 10 total) *also*
gets its own floating panel, nested (opens to the left of Structure's panel); multi-panel support
(several open at once, auto-avoiding vertical overlap) is being built now rather than deferred.
Mutation becomes its own always-visible docked panel below the main "Tree controls" panel, not
part of this floating-panel system.

## Judgment calls made (not asked, stated here for the record)

- **Row vs. Mutate button click targets**: the row's label and its Mutate button are separate
  DOM elements with separate click handlers — no `event.target` sniffing needed. Clicking the
  label toggles the floating panel; clicking Mutate mutates immediately, independent of whether
  the panel is open (mirrors the sketch, where "Mutate Branch start" stays in the main list).
- **Repel algorithm (v1, "good enough")**: a newly-opened panel (one with no remembered position
  yet) prefers to appear one panel-width to the left of whatever contained the row that opened it
  (the main panel for top-level sections, or the parent floating panel for nested trait panels),
  vertically near that row. If it would overlap an already-open panel in roughly the same X
  column, it's pushed below the lowest colliding one. If that push would run off the bottom of
  the screen, the position is clamped to keep the panel fully on-screen (not wrapped into a new
  column) — a reasonable v1 given no explicit spec for the overflow case.
- **Position memory**: a panel's `(x, y)` is set once — either by the repel algorithm on its
  first-ever open, or by the user dragging it — and reused on every subsequent open (closing and
  reopening never re-runs the repel algorithm). This matches "maintain their position... as long
  as the user does not reposition them" literally: only user drags change a settled position.
- **Closing cascades to children**: closing a panel also closes any panel that was opened *from
  inside it* (e.g. closing Structure's panel closes any currently-open trait panels), since a
  trait panel has no meaning once its parent is hidden.
- **Species tab is unaffected** — it's a tab switch, not a section-accordion, and isn't part of
  this request.
- **Mutation panel is also made draggable**, reusing the same drag-by-title-bar code as the main
  panel, since that's nearly free and keeps it consistent with the rest of the UI — not explicitly
  requested but a natural fit.

## Architecture

### Floating panel manager (new)

- `floatingPanels: Map<id, { id, el, body, x, y, opened, parentId }>`.
- `createFloatingPanel(id, title)` — builds the `.float-panel` DOM (title bar + close button +
  body), draggable via the same pointerdown/move/up pattern as the main panel, appended directly
  to `document.body` (so it can be positioned anywhere, independent of the main panel).
- `openFloatingPanel(id, anchorEl)` / `closeFloatingPanel(id)` (cascades to children) /
  `toggleFloatingPanel(id, anchorEl)`.
- `positionNewPanel(fp, anchorEl)` — the repel algorithm described above. Measures the panel's
  real height via a hidden-but-`display:block` trick (can't read `offsetHeight` while
  `display:none`) so the collision check uses actual content height, not a guess.

### `panelSection(id, label, mutateFn)` (new, replaces `header()` for Tuning-tab sections)

Creates a row (label + optional Mutate button) in whatever `current` points to right now (so it
naturally nests — Structure's per-trait rows are created while `current` is Structure's own
floating-panel body), creates the matching floating panel (parented to whichever panel/page
`current` belongs to, derived via a `bodyToPanelId` lookup), sets `current` to the new panel's
body, and returns that body — i.e. it's a drop-in replacement for `header()`'s calling
convention, so the *existing* per-section slider-building code (the lines after each `header()`
call) doesn't need to change, only the `header('X')` call itself becomes
`panelSection('x', 'X', mutateFnOrNull)`.

### Structure section (restructured)

Previously, `rebuildStructureRows()` tore down and rebuilt *all* of Structure's DOM (row list +
sliders) on every Levels/Load/Restart/Undo/Redo change — fine when everything lived inline in one
host div. Now that each trait is a *persistent* floating panel (created once, living in
`document.body`), that full teardown would orphan-and-recreate 10 floating panels every time
Levels changes. Split into:

- `buildStructureUI()` — runs once at startup: creates Structure's own floating panel (via
  `panelSection`), and inside it, one `panelSection` per trait (parented to Structure's panel),
  storing each trait's body in `traitPanelBodies[key]`.
- `rebuildTraitSliders()` — runs on every Levels/Load/Restart/Undo/Redo change: for each trait,
  clears and repopulates *just that trait's floating-panel body* with `0..opts.levels` sliders.
  Replaces the old `rebuildStructureRows()` at all its call sites.

### Mutation panel (docked, separate from the floating-panel system)

A second always-visible panel, visually identical to `#ctrl` (same CSS), positioned by default
directly below it. Contains exactly what it does today: Mutation degree slider, Mutate all,
Undo/Redo, Restart. Not part of the Tuning/Species tab structure at all — always visible,
independent of which tab is active.

## Task list (implementing directly, one file: `workshop-webgpu/tree-viewer.html`)

1. Add `.float-panel`/`.fp-bar`/`.fp-close`/`.fp-body` CSS, extending the existing shared
   row/slider/select/button/textarea selectors to also match `.float-panel` (so floating panels
   look identical to the main panel's sections). Syntax-check, commit.
2. Add the floating panel manager (`floatingPanels`, `createFloatingPanel`, `open/close/toggle`,
   `positionNewPanel`) and `panelSection()`. Syntax-check, commit.
3. Convert View, Texture, Lighting, Force, Bark, Leaves, Export from `header('X')` to
   `panelSection('x', 'X', mutateFnOrNull)` (Force/Bark/Leaves pass their existing
   `*MutateList` function; View/Texture/Lighting/Export pass `null`). Syntax-check, commit.
4. Restructure Structure into `buildStructureUI()` + `rebuildTraitSliders()`; update all call
   sites of the old `rebuildStructureRows()` (Levels slider, `applyOptsAndRefresh`). Syntax-check,
   commit.
5. Extract the Mutation section into its own standalone docked panel (own DOM/CSS reuse, own drag
   handler, positioned below `#ctrl`), removing it from the tabbed panel's `header()` flow.
   Syntax-check, commit.
6. Update `docs/subsystems/vegetation.md`; append one `agent_log.csv` row. Commit.
7. Manual verification: syntax + serve checks, describe the click-through test (open several
   sections including nested trait panels, drag one, confirm repel avoids overlap, confirm
   closing Structure also closes its open trait panels, confirm reopening a panel keeps its last
   position).
