# Slider state presets — design

**Date:** 2026-07-01
**Status:** Approved for planning

## Goal

Let the user save the current values of the scene-tuning sliders/selects/toggles under a name,
list saved states, load one back (restoring both the underlying param values and the live
subsystems they drive), delete states they no longer want, and pick a saved state from the
start-menu before the world even loads — all without re-touching every slider by hand.

## Scope

Captures every control built through the existing `slider()`, `select()`, `toggle()` factories
in `environment-viewer.html` (~line 1567 onward): Forest, Lighting, Terrain/Water, Post FX,
Grass, Clouds, Sky. These write into one of four plain param objects already in that file:

- `params` (line 782) — the catch-all object; also the only object `select()`/`toggle()` ever touch.
- `rigP` (line 1645) — lighting rig (elevation/azimuth/sun/ambient intensity).
- `terrain` (line 188) — size/lake/lakeDepth/waterLevel/renderRadius.
- `SKY_PARAMS` (line 2237) — starCount/sunSize/milkyWayIntensity.

Out of scope: per-particle-kind editor sliders (`pslider`, built inline in the particles section)
and the Walk/FPS + light-gun panel. Neither is wired into the `slider()`/`select()`/`toggle()`
factories, so including them would require a separate registration path with no corresponding
user-facing "save my walk tuning" need identified.

## Capture / apply mechanism

`slider()`, `select()`, `toggle()` each self-register into a module-level `controlRegistry`
array as controls are built, instead of hand-maintaining a separate list of every param:

```js
controlRegistry.push({
  name: `${objName}.${key}`,   // e.g. 'params.count', 'rigP.elevation'
  obj, key,
  sync,                        // () => pushes obj[key] back into the DOM control's displayed state
  onChange,                    // the same handler already wired to the control's input/change event
});
```

- `slider()` already accepts an optional `obj` (defaulting to `params`). It gains one more
  optional argument, `objName`, defaulting to `'params'`. The ~10 existing call sites that pass
  `rigP`, `terrain`, or `SKY_PARAMS` as `obj` are updated to also pass the matching name string
  (`'rigP'`, `'terrain'`, `'SKY_PARAMS'`) so registry keys are stable and human-readable.
- `select()` and `toggle()` always operate on `params`, so their registry entries always use
  `'params.<key>'` — no signature change needed there beyond pushing to the registry.
- `sync` is built from the same `inp`/`val` (or `sel`, or checkbox `inp`) references the factory
  already has in scope: for a slider it sets `inp.value = obj[key]` and `val.textContent =
  fmt(obj[key])`; for a select it sets `sel.value = params[key]`; for a toggle it sets
  `inp.checked = !!params[key]`.

Two module-level functions, defined alongside the registry:

```js
function captureSliderState() {
  const values = {};
  for (const c of controlRegistry) values[c.name] = c.obj[c.key];
  return values;
}

function applySliderState(values) {
  if (!values) return;
  const fired = new Set();
  for (const c of controlRegistry) {
    if (!(c.name in values)) continue;
    c.obj[c.key] = values[c.name];
    c.sync();
  }
  for (const c of controlRegistry) {
    if (!(c.name in values) || fired.has(c.onChange)) continue;
    fired.add(c.onChange);
    c.onChange();
  }
}
```

Values are written and synced to the DOM in one pass, then each distinct `onChange` handler
(many sliders in the same group share one, e.g. `worldRebuild`, `apply`) fires exactly once,
so applying a preset doesn't trigger a rebuild/rebake per slider.

**Timing:** the registry is only complete once every panel — including the ones that arrive
asynchronously via `_forestPromise` (grass/water/clouds/sky) — has been built. `applySliderState`
for both the Presets-tab "Load" button and a start-menu preset selection therefore only ever
runs after the existing final gate in `environment-viewer.html`, right before
`renderer.setAnimationLoop(animate)` starts (the same point `dismiss()` is called).

**Forward/backward tolerance:** a loaded preset's keys that no longer match any registered
control are silently ignored (e.g. a slider was removed since the preset was saved). A control
with no matching key in the loaded preset simply keeps its current default. No schema versioning.

## Storage — `slider-state.js`

A new flat module (matching the one-file-per-subsystem convention already used for
`frame-profiler.js` etc.), owning the `localStorage` schema, importable from both
`environment-viewer.html` and `start-screen.js`:

```js
const STORAGE_KEY = 'pcw:sliderStates';

export function listStates()             // -> { [name]: { savedAt: isoString, values } }
export function saveState(name, values)  // overwrites if name exists; caller confirms first
export function deleteState(name)
```

This keeps storage/schema logic out of `environment-ui.js` (whose existing architecture note
says it owns layout/chrome only, not business logic) and out of `start-screen.js` (which only
needs to list names for its dropdown).

## UI — "Presets" tab in `#workshop-ui`

A sixth tab in the existing tabbed shell built by `environment-ui.js`, alongside
Scene/Creatures/Effects/Walk/Perf (`.wui-tabs` grid goes from `repeat(5, …)` to `repeat(6, …)`,
including the `@media (max-width: 720px)` override). `createEnvironmentUi({ perfLog, sliderState })`
gains a `sliderState` param: `{ capture, apply, list, save, remove }`, all bound closures supplied
by `environment-viewer.html` (`capture`/`apply` are the module-level functions above; `list`/
`save`/`remove` are re-exported from `slider-state.js`).

Panel contents (`buildPresetsPanel(host, sliderState)`, mirroring the existing
`buildPerfPanel` pattern):

- **Save row** — a name `<input>` + **Save** button. On click: if `sliderState.list()` already
  has that name, `window.confirm('Overwrite saved state "<name>"?')` gates the write; on
  confirm (or if the name is new), calls `sliderState.save(name, sliderState.capture())` and
  re-renders the list. Empty name is a no-op (button does nothing, no error UI needed).
- **Saved states list** — one row per entry: name, relative "saved `<n>` ago" label, **Load**
  button (`sliderState.apply(entry.values)`), **Delete** button (`sliderState.remove(name)`,
  re-renders the list; no confirm — deleting a save is low-stakes and reversible by re-saving).
- Empty state: `.wui-empty` placeholder ("No saved states yet") when the list is empty, matching
  the existing empty-state convention used elsewhere in this file.

## Start-menu integration (`start-screen.js`)

The role-select screen (`_roleStep`) gains a "Load preset" `<select>` (options: `None` +
`listStates()` names, imported from `slider-state.js`), placed above or beside the
Solo/Host/Join cards so it's visible regardless of which path the user takes. The selected name
(or `null` for "None") is threaded through the existing resolve chain:

- `_roleStep` resolves `{ mpRole, roomCode, guestMapKey, presetName }` instead of the current
  3-key object.
- `showStartScreen()` includes `presetName` in its returned object alongside `mapKey`, `mpRole`,
  `roomCode`, `setStatus`, `dismiss`.
- `environment-viewer.html` holds onto `presetName` from its `await showStartScreen()` call and,
  at the final gate (same point described under Timing above), calls
  `applySliderState(listStates()[presetName]?.values)` when `presetName` isn't null, right
  before `dismiss()` and `renderer.setAnimationLoop(animate)`.

This applies uniformly to Solo, Host, and Join — a host's preset shapes what it renders locally;
guests don't currently send scene-tuning state to anyone (per the existing host-authoritative
multiplayer model), so a guest's own preset choice only affects their own local rendering, same
as it would in Solo.

## Files touched

| File | Change |
|---|---|
| `slider-state.js` | **New.** `listStates`/`saveState`/`deleteState` over `localStorage`. |
| `environment-viewer.html` | `controlRegistry` + `captureSliderState`/`applySliderState`; `slider()`/`select()`/`toggle()` register controls; `objName` arg threaded through the ~10 custom-`obj` `slider()` calls; import `slider-state.js`; apply `presetName` at the final gate; pass `sliderState` into `createEnvironmentUi(...)`. |
| `environment-ui.js` | 6th "Presets" tab def + CSS grid update; new `buildPresetsPanel(host, sliderState)`. |
| `start-screen.js` | "Load preset" `<select>` on the role-select screen; `presetName` threaded through `_roleStep`'s resolve and `showStartScreen()`'s return value; import `listStates` from `slider-state.js`. |

## Testing

`test-slider-state.mjs` (new, following the existing flat `node test-<name>.mjs` convention) —
exercises `slider-state.js`'s `listStates`/`saveState`/`deleteState` against a minimal
`localStorage` stub (Node has no `localStorage` global), since it's the one piece of this feature
with no DOM dependency. The registry/capture/apply logic and both UI panels are DOM- and
three.js-dependent (same as `environment-ui.js` and the rest of `environment-viewer.html`) and
are manually verified by running the app, per this directory's existing test-coverage pattern
(`infra.md` notes `environment-ui.js` itself has no automated test coverage for the same reason).
