# Tree Viewer: Lighting, Species Library, Mutation

Combined brief spec + plan for a follow-up increment to `tree-viewer.html` (see
`docs/superpowers/specs/2026-06-30-tree-viewer-design.md` / `docs/superpowers/plans/2026-06-30-tree-viewer.md`
for the base tool this builds on). All decisions below were confirmed with the user during
brainstorming.

## What's being added

1. **Lighting section** — sliders/color pickers for the existing `lights.js` rig (elevation,
   azimuth, sun intensity, ambient intensity, sun color, ambient color).
2. **Tab bar** — panel body gets two tabs: **Tuning** (all existing sections + new Lighting +
   new Mutation) and **Species** (save/load saved trees).
3. **Species library** — name field + "Save current tree" button snapshots `opts` (map/normalMap
   stripped, same as Export) into a `localStorage`-persisted list; click a saved entry to load it
   (full `opts` replace, switch to Solo, switch back to Tuning tab); small delete button per row.
4. **Mutation** — one global "Mutation degree" (0-1) slider; a "Mutate" button at the top of
   Structure/Force/Bark/Leaves (not View/Texture/Lighting/Export). Degree is a fraction of each
   slider's own min-max range, applied as an independent random perturbation per numeric slider,
   clamped to range. Non-numeric controls (color/toggle/select) are untouched. Mutate behaves like
   Reroll: immediate, bypasses the debounce, refits the camera.
5. **Generic control refresh** — needed because Load/Mutate change `opts` out from under
   already-built controls. Every control primitive registers a `refresh()` closure in a shared
   list; `refreshAllControls()` re-syncs displayed values, self-pruning entries whose DOM node
   was removed by a section rebuild (`el.isConnected` check).

## Design details worth calling out

- `rig` (from `createLightingRig`) only exposes getters for `azimuth`/`elevation` — sun/ambient
  color and intensity have no getter, so those four are tracked as local state in
  `tree-viewer.html` (seeded from `lights.js`'s own `DEFAULTS`: `sunColor:'#fff4e0'`,
  `sunIntensity:1.8`, `ambientColor:'#8ab4e8'`, `ambientIntensity:0.6`), not read back from `rig`.
- Loading a saved tree must re-apply the *current* texture mode's maps after replacing `opts`
  (`applyTexSetToOpts()`), because saved snapshots never contain live `Texture` objects — without
  this, loading a tree while in `authored` texture mode would silently revert it to textureless.
- `header()` currently always appends into `ctrlBody`. It needs a `sectionHost` variable (default
  `ctrlBody`) that tab-page code temporarily points at its own container, mirroring the existing
  `withHost()` pattern used for Structure's per-level rows.
- Structure's Mutate button doesn't need a special rebuild step: it just perturbs
  `opts[key][level]` for `LEVEL_PARAMS × 0..opts.levels` (the same array already used to build its
  sliders) and calls `refreshAllControls()` — no DOM rebuild needed since the row *set* doesn't
  change (only `opts.levels` changes row count, and Mutate never touches `opts.levels`).

## Task list (implementing directly, no subagents, one file: `workshop-webgpu/tree-viewer.html`
unless noted)

1. **Control-refresh registry.** Add `let allControls = [];` and `function refreshAllControls()`.
   Modify `rangeControl`/`selectControl`/`toggleControl`/`colorControl` to push a `{el, refresh}`
   entry. Syntax-check, commit.
2. **Tab bar.** Add a two-button tab bar under `#ctrl-bar`, two container divs (`tuningPage`,
   `speciesPage`) inside `#ctrl-body`, a `sectionHost` var `header()` appends into, and an
   `activateTab(name)` function toggling page visibility + button active state. Move the existing
   `ctrlBody.appendChild(sec)` line in `header()` to use `sectionHost` instead. Default active tab:
   Tuning. Syntax-check, commit.
3. **Lighting section.** New local state for sun/ambient color+intensity (seeded from `lights.js`
   defaults), 6 controls calling `rig.set*`, placed in the Tuning tab after Texture. Syntax-check,
   commit.
4. **Mutation section + per-section Mutate buttons.** Global `mutationDegree` state + slider in a
   new "Mutation" section (Tuning tab, before Structure). A generic
   `mutateParams(list, degree)` helper. Mutate buttons added to Structure (reusing `LEVEL_PARAMS`),
   Force (azimuth/elevation/strength), Bark (roughness/vScale), Leaves (count/size/sizeVariance/
   start/spread/angle/shadowFraction/roughness/alphaTest). Syntax-check, commit.
5. **Species tab: save.** Name `<input>` + "Save current tree" button; `savedTrees` array loaded
   from/persisted to `localStorage` (`tree-viewer:saved-trees`), using the same map/normalMap-
   stripping replacer Export uses. Syntax-check, commit.
6. **Species tab: list + load/delete.** `renderSavedList()` builds clickable rows (click = load,
   small × = delete). `loadOpts(savedOpts)` replaces `opts`'s contents in place via
   `Object.assign` after clearing existing keys, sets `mode='solo'`, `baseSeed=opts.seed`, calls
   `applyTexSetToOpts()`, `refreshAllControls()`, `activateTab('tuning')`, `rebuildView()`.
   Syntax-check, commit.
7. **Docs.** Update `docs/subsystems/vegetation.md`'s "Standalone tooling" paragraph to mention
   the Species library / localStorage / Lighting / Mutation additions. Append one `agent_log.csv`
   row. Commit.
8. **Manual verification.** Serve, syntax-check the whole file one more time, describe what a
   human should click through (same style as before) since no browser automation is available in
   this session.
