# Tree Viewer: Families, Species, and Age

Combined brief spec + plan. Confirmed with the user: Family = named collection of named
Species (each a full tree `opts` + metadata), grown by auto (batch-mutate-and-save-N) and manual
(mutate normally, then "keep as new species") modes; biome/density/size-range are per-species,
using the real 18-name biome list from `docs/subsystems/biomes.md`; age is rolled per placed
instance later (out of scope here) but previewable live in tree-viewer now; this replaces/extends
the existing flat "Species" tab (save/load list) rather than adding a separate tab.

## New shared module: `tree-age.js`

Pure function, no DOM/THREE dependency (matches `forest-cull.js`/`grass-cells.js`'s "testable
math, no framework" pattern) — needed because it must eventually be reusable by the game's
forest placement too, not just this tool.

```js
export function applyAge(opts, ageT): opts   // ageT clamped to [0,1]; ageT=1 is value-equivalent to opts unchanged
```

Transforms: overall scale (`length`/`radius` arrays × a lerp from a young-form fraction to 1),
"development" (`levels` lerped from `min(1, opts.levels)` up to `opts.levels` — a sapling only
has its first branch level grown in), and leaf count/size (each lerped from a reduced young-form
fraction to their full configured value). Constants (young-form fractions) are internal, not
user-tunable in this round.

Paired with `test-tree-age.mjs` (age=1 is a no-op on values; age=0 shrinks length/radius/levels/
leaf count/leaf size; clamps outside [0,1]; age=0.5 lands strictly between; doesn't mutate input).

## Data model (in `tree-viewer.html`)

```js
Family  = { id, name, species: Species[] }
Species = { id, name, opts, parentSpeciesId, biomes: string[], density, sizeRange: [min,max], ageRange: [min,max] }
```

Stored as one nested blob in `localStorage` (`tree-viewer:families`) — simplest schema at this
scale, and makes a future "export family as JSON" trivial (`JSON.stringify(family)`).
`parentSpeciesId` records what a species was mutated from, for lineage only (not used
programmatically yet). `biomes` uses the canonical 18 names from `biomes.md`
(`deep_ocean, ocean, beach, desert, badlands, savanna, plains, forest, dark_forest, jungle,
swamp, taiga, snowy_taiga, snowy_plains, stony_peaks, snowy_peaks, windswept_hills, meadow`).

**Migration**: on first load, if `tree-viewer:families` doesn't exist yet but the old
`tree-viewer:saved-trees` does, fold every old entry into one family named "Imported"
(`biomes: []`, `density: 1`, `sizeRange: [0.8, 1.2]`, `ageRange: [1, 1]`) so nothing from before
this feature vanishes.

## Pre-existing bug found and fixed along the way

`applyOptsAndRefresh()` (the shared hub `loadOpts()`/`restoreState()` already call after
replacing `opts`) never resynced the page-local `forceAz`/`forceEl` state from the newly-loaded
`opts.force.direction`. Since the Force section's azimuth/elevation sliders are bound to
`forceAz`/`forceEl` (derived state, not a direct `opts` path — `opts.force.direction` is a unit
vector, not an angle), this meant: after any Load/Undo/Redo, the Force sliders silently showed
the *previous* tree's angle, and dragging one afterward would compute a new direction from that
stale angle rather than the just-loaded one. Fixed by adding `resyncForceAngles()` (extracted
from the Force section's existing one-time startup computation) and calling it inside
`applyOptsAndRefresh()`. This also enables "Auto-add mutations" below to correctly reset to a
clean baseline between iterations.

## Auto-grow ("Auto-add mutations")

Reuses the *existing* `structureMutateList()`/`forceMutateList()`/`barkMutateList()`/
`leavesMutateList()` (no duplicated param tables) against the live `opts`, looped N times:

```js
function resetOptsQuiet(source) {           // like loadOpts's core, but no undo/tab-switch/render —
  for (const k of Object.keys(opts)) delete opts[k];   // this is an internal batch-generation step,
  Object.assign(opts, structuredClone(source));         // not a user-facing "load"
  resyncForceAngles();
}
// for i in 0..count: resetOptsQuiet(baseline) -> mutateParams(allFourLists) -> snapshot -> push to family
// then resetOptsQuiet(baseline) once more + one refreshAllControls()+rebuildView() to restore the
// visible tree, so the batch doesn't leave a random mutation on screen or drift baseline-to-baseline
```

Only rebuilds the live 3D view **once**, at the end (restoring the original baseline) — not once
per generated variant, since the visual rebuild is irrelevant to what gets saved.

## Manual grow ("Keep current tree as new species")

No new mutate mechanism — you use the tool exactly as it already works (any Mutate button,
sliders, whatever), then a name field + "Keep current tree as new species" button (same
input+button idiom the old "Save current tree" used) snapshots the live tree into the current
family. Never hitting that button is how a bad mutation gets discarded.

## Species tab UI (replaces the old flat Save/Saved-trees sections)

- **Family** — a `<select>` of existing families + a name field/button to create a new one.
- **Grow family** — the auto-add count+button and the keep-as-species name+button described above.
- **Species** — list of the current family's members (name + biome/density hint); clicking a row
  both loads it into the live Solo tree *and* selects it for editing (unifying "load" and "edit
  target" into one click, so the age-preview slider below always previews the species you're
  actually looking at); a small × deletes it from the family.
- **Edit species** — for whichever species was last clicked: name, one checkbox per biome (18),
  density, size min/max, age min/max, and an **age-preview slider** (0-1) that live-re-renders the
  currently-loaded Solo tree through `applyAge` (via `buildSolo`/`regenerateSolo` now rendering
  `makeTree(applyAge(opts, previewAge))` instead of raw `opts` — a no-op change when
  `previewAge` is left at its default of 1). Loading any species (via the list, or Restart) resets
  `previewAge` back to 1, so switching species always starts previewing at full maturity.
  Grid mode is unaffected by age preview (only Solo renders through `applyAge`).

## Task list (implementing directly, no subagents)

1. Create `tree-age.js` + `test-tree-age.mjs`. Run the test. Commit.
2. In `tree-viewer.html`: import `applyAge`; wire `buildSolo`/`regenerateSolo` to render through
   it with a new `previewAge` state (default 1). Syntax-check, commit.
3. Extract `resyncForceAngles()` from the Force section's startup computation; call it from
   `applyOptsAndRefresh()`. Syntax-check, commit (this is the bug fix, isolated from the rest).
4. Replace the old flat Species tab (Save/Saved-trees sections, `snapshotOpts`/old `loadOpts`
   internals) with the Family/Species data model, migration, and `loadOpts` update (reset
   `previewAge`). Syntax-check, commit.
5. Build the Family/Species tab UI: family picker + new-family, Grow-family host (auto-add +
   keep-as-species), Species list host, Edit-species host, and the `renderFamilyPanel()`
   orchestrator that rebuilds the three dynamic hosts. Syntax-check, commit.
6. Update `docs/subsystems/vegetation.md`; append `agent_log.csv`. Commit.
7. Manual verification: run `test-tree-age.mjs`, syntax + serve checks on `tree-viewer.html`,
   describe the click-through test (create a family, auto-add mutations, keep one manually, edit
   a species's biomes/density/size/age, scrub age-preview, delete a species, reload the page and
   confirm the family persisted, and — if you still have pre-migration saved trees in this
   browser's localStorage — confirm they appear under an "Imported" family).
