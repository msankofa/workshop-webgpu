# Tree Viewer: Global Mutate, Per-Trait Mutate, Undo/Redo, Restart

Combined brief spec + plan, follow-up to `docs/superpowers/plans/2026-06-30-tree-viewer-lighting-species-mutation.md`.
Confirmed with the user: per-trait mutate buttons apply only within Structure (the only section
with natural sub-groups); undo/redo snapshots only "big jump" actions (Mutate at any level,
Reroll, Load, Restart), not individual slider drags; Restart resets to the tool's built-in
default tree (captured once at startup), not a saved tree.

## What's being added

1. **Per-section mutate lists factored into named functions** (`structureMutateList`,
   `forceMutateList`, `barkMutateList`, `leavesMutateList`) — refactor of the existing inline
   arrays in each section's Mutate button, needed so "Mutate all" can reuse them without
   duplication.
2. **Global "Mutate all" button** — in the Mutation section, mutates every trait across all four
   sections at once (concatenation of the four list functions above).
3. **Per-trait "Mutate" buttons within Structure** — one small button above each trait's group of
   per-level sliders (Length, Radius, Taper, Children, Branch start, Angle, Gnarliness, Twist,
   Sections, Segments — 10 total), mutating just that trait across its currently-active levels.
   Rendered compact (`.mini-btn` CSS) so 10 extra buttons don't visually dominate the section.
4. **Undo/redo** — a capped-at-15 undo stack + redo stack of `{opts, mode, gridSize, baseSeed}`
   snapshots (map/normalMap-stripped, same as Export/Save). Every mutate path funnels through one
   `mutateSection(list)` function, and Reroll/Load both get a single `pushUndo()` call, so undo
   coverage is centralized rather than scattered. A new action after an undo clears the redo
   stack (standard semantics). Undo/Redo buttons disable themselves when their stack is empty.
5. **Restart button** — resets to `DEFAULT_OPTS`, a snapshot of `opts` captured once immediately
   after the initial `createTree({})` call, before any user interaction. Implemented by reusing
   `loadOpts()` (which already pushes undo), so Restart is itself undoable.

## Design notes

- Undo/redo deliberately does **not** cover Lighting or Texture mode — those aren't touched by
  Mutate, and the user's stated concern ("in case it gets too crazy") is about tree-trait
  mutation, not viewer display settings.
- `loadOpts()` and the new `restoreState()` (used by undo/redo) share a common
  `applyOptsAndRefresh()` helper (re-apply texture maps, rebuild Structure's rows, refresh all
  controls, refresh the seed label, rebuild the 3D view) to avoid duplicating that sequence.
  They differ in scope: `loadOpts()` always forces Solo mode (loading a specific tree to inspect
  it) and derives `baseSeed` from the loaded tree's seed; `restoreState()` restores the exact
  `mode`/`gridSize`/`baseSeed` that were live at snapshot time (undo should reproduce the whole
  previous session state, not just the tree).
- `pushUndo()` lives inside `mutateSection()` and `loadOpts()` — a single choke point per action
  type — plus one explicit call in the Reroll seed button's handler (the one big-jump action that
  doesn't go through either of those two functions).

## Task list (implementing directly, no subagents, one file: `workshop-webgpu/tree-viewer.html`)

1. Add `.mini-btn` and `button:disabled` CSS; add `miniButtonControl()` helper (thin wrapper over
   `buttonControl` adding the `.mini-btn` class). Syntax-check, commit.
2. Add `DEFAULT_OPTS` snapshot (in the tree-data-model block, right after `opts` is created).
   Syntax-check, commit.
3. Refactor Structure/Force/Bark/Leaves's inline Mutate-button arrays into `traitMutateList(p)` /
   `structureMutateList()` / `forceMutateList()` / `barkMutateList()` / `leavesMutateList()`
   functions; update each section's existing "Mutate" button to call the matching function.
   Syntax-check, commit.
4. Add per-trait mini Mutate buttons inside `rebuildStructureRows()`'s loop (one per `LEVEL_PARAMS`
   entry, above that trait's level rows). Syntax-check, commit.
5. Add "Mutate all" button (Mutation section) using the four list functions. Add `pushUndo()` at
   the top of `mutateSection()`. Syntax-check, commit.
6. Add undo/redo state (`UNDO_LIMIT=15`, `undoStack`, `redoStack`, `snapshotState`,
   `applyOptsAndRefresh`, `restoreState`, `undo`, `redo`, `updateUndoRedoButtons`), the Undo/Redo
   button row (Mutation section, compact side-by-side), and `pushUndo()` in the Reroll seed
   handler and inside `loadOpts()`. Add the Restart button (`loadOpts(DEFAULT_OPTS)`). Syntax-check,
   commit.
7. Update `docs/subsystems/vegetation.md`'s Standalone tooling section; append one `agent_log.csv`
   row. Commit.
8. Manual verification: syntax + serve checks, describe the click-through test for the user (same
   style as before — no browser automation available in this session).
