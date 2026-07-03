# plant-viewer.html: standalone plant tuning tool · Design Spec

**Date:** 2026-07-03
**Branch:** `sp1-webgpu-renderer-migration` (fork: `workshop-webgpu/`)
**Status:** scoped (design approved; not yet planned/implemented).

## Problem

`plants.js`'s data model (`PLANT_DEFAULTS`/`PLANT_PRESETS`/`buildPlantGeometry`/`createPlantPalette`,
added in the vegetation-variety pass) was deliberately built as a fully parameterized schema —
leaf shape, simple/complex style, leaflet count/parity, phyllotaxy arrangement, serration,
variegation, colors, stem structure, flower shape — specifically so it could support a standalone
tuning tool later, mirroring `tree-viewer.html`. That tool was flagged as future work and never
built. There is currently no way to see a live-rendered plant while adjusting these parameters, no
way to save a hand-tuned variant as a reusable named species, and no way to author biome/density
tags for new plant species without hand-editing `PLANT_PRESETS`/`PLANT_BIOME_TAGS` source directly.

## Goal

Build `plant-viewer.html`: a standalone, single-file tool — modeled directly on `tree-viewer.html`'s
architecture — that exposes every `PLANT_DEFAULTS` field for live tuning, plus a full save/breed/tag
workflow (Family → Species) equivalent to tree-viewer's, so plant species can be authored and curated
the same way tree species already are. Not wired into `environment-viewer.html`.

## Approach chosen

Reuse `tree-viewer.html`'s proven structure wholesale — same scene shell, same floating-panel control
kit (duplicated inline, not imported, matching tree-viewer's own precedent of not extracting a shared
UI library), same Tuning/Species tab split, same Undo/Redo/Mutate mechanics — and swap the tree data
model for the plant one. Rejected: building a lighter-weight tool without the Family/Species system
(considered during brainstorming, rejected because the user explicitly wants save/breed/tag parity
with tree-viewer, not a read-only slider demo). Rejected: extending `tree-viewer.html` itself with a
"mode" switch between trees and plants — the two data models, control layouts, and mutate lists are
different enough that a shared file would need pervasive type-branching; a second standalone file
matches this codebase's "each tool/subsystem is independently loadable" convention.

Two differences from tree-viewer, both because the underlying data model doesn't have the
corresponding concept yet:

- **No texture-mode section.** `plants.js` geometry has no texture maps (colors are baked directly
  into vertex colors) — there is nothing for a procedural/authored toggle to switch.
- **No age-preview slider, no `ageRange` species field.** `plants.js` has no growth/age model
  analogous to `tree-age.js`'s `applyAge`. Deferred entirely, not stubbed.

## Scene shell

Byte-for-byte the same pattern as `tree-viewer.html`: `WebGPURenderer` (antialias, shadow map PCF
soft), a `THREE.Scene` with a flat dark background, `PerspectiveCamera` + `OrbitControls`
(damped), `createLightingRig({ scene, ui: false })` from `lights.js` with shadow-casting sun, and a
single flat `PlaneGeometry` ground (smaller than tree-viewer's 200×200 is fine — plants are far
smaller than trees; use 60×60). Same import map (three@0.184.0 WebGPU/TSL CDN pins). Same
`showError`/`window.onerror`/`unhandledrejection` banner pattern. Runs via `python serve.py` like
the main viewer (ES module imports don't work over `file://`).

## Data model wiring

```js
import { PLANT_DEFAULTS, PLANT_PRESETS, PLANT_BIOME_TAGS, mergePlantOpts, buildPlantGeometry } from './plants.js';
```

`opts` is a deep clone of `PLANT_DEFAULTS` (not `.options` off a live instance — unlike `trees.js`'s
`Tree` class, `plants.js` has no constructor object to borrow the merged shape from; `structuredClone`
of `PLANT_DEFAULTS` is the moral equivalent of tree-viewer's `_genTree.options` capture). `DEFAULT_OPTS`
is a frozen-at-load clone of that, used by Restart, exactly as in tree-viewer.

There is no `regenerateSolo`/materials-once distinction to preserve: `buildPlantGeometry(opts)`
returns one `THREE.BufferGeometry` with vertex colors already baked in, and every render uses the
same static `MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })`
instance (shared across Solo/Grid meshes, never touched by control changes). So *every* opts change —
color, shape, serration, whatever — is handled uniformly: dispose the old mesh's geometry, call
`buildPlantGeometry(opts)` again, build a new `THREE.Mesh` with the same shared material. This is
simpler than tree-viewer's material-vs-geometry split, which existed only because `trees.js` builds
bark/leaf materials once in its constructor from options tree-viewer can't see cheaply — plants have
no such constructor step to route around.

Solo mode: one instance, camera auto-fit via `fitCameraTo` (same bounding-sphere logic as
tree-viewer, just with tighter default zoom given plants' small scale). Grid mode: N×N instances,
`seed: baseSeed + i`, spacing derived from the current leaf/stem scale rather than a hardcoded
tree-sized value (plants are ~10-50x smaller than trees; spacing needs its own formula, not
tree-viewer's `opts.length[0] * 2.5`) — e.g. `Math.max(1.5, avgPlantExtent * 3)` computed from the
just-built Solo geometry's bounding sphere radius.

## Tuning tab

Same floating-panel manager as tree-viewer (`panelSection`/`createFloatingPanel`/
`positionNewPanel`/`openFloatingPanel`/`closeFloatingPanel`/`toggleFloatingPanel`), duplicated
inline verbatim — this is UI chrome with zero plant-specific logic, no reason to diverge from the
working implementation. Same `row`/`rangeControl`/`selectControl`/`toggleControl`/`colorControl`/
`buttonControl` primitives and the same `optsSlider`/`optsSelect`/`optsToggle`/`optsColor` thin
wrappers bound via dot-path (`getPath`/`setPath`) into `opts`. Dot-paths work unchanged for array
fields — `'stem.nodes.0'` resolves through `obj['stem']['nodes']['0']`, which is a valid array index
access in JS — so `[min, max]`-shaped fields (`stem.nodes`, `stem.nodeSpacing`, `leaf.size`) need no
new control primitive, just two `optsSlider` calls each (e.g. `optsSlider('stem.nodes.0', 'Nodes min', ...)`
+ `optsSlider('stem.nodes.1', 'Nodes max', ...)`).

Sections (each its own floating panel, opened via a `sec-row` label click, same as tree-viewer's
Structure/Force/Bark/Leaves):

- **View** — Mode (`solo`/`grid`) select, grid-size slider, seed label, "Reroll seed" button.
- **Lighting** — identical to tree-viewer: Elevation/Azimuth/Sun intensity/Ambient intensity sliders
  + Sun/Ambient color pickers, driving `rig.set*()` calls. Local state (`sunColor` etc.) tracked the
  same way, since the rig has no getters for these four.
- **Stem** — `stem.nodes.0`/`stem.nodes.1` (Nodes min/max, integer sliders), `stem.nodeSpacing.0`/
  `stem.nodeSpacing.1` (Spacing min/max), `stem.branchProb` (0-1 slider — reserved field, not yet
  consumed by `buildPlantGeometry`; exposed anyway since it's part of the schema and the control
  costs nothing), `stem.sprawl` (0-1 slider).
- **Leaf** — `leaf.shape` select (`oval`/`lance`/`star`), `leaf.style` select (`simple`/`complex`),
  `leaf.leafletCount` slider (1-12, only visually meaningful when style is `complex` — shown always,
  same "harmless even when inapplicable" precedent as tree-viewer's atlas-cell controls),
  `leaf.leafletParity` select (`odd`/`even`), `leaf.arrangement` select (`alternate`/`opposite`/
  `whorl`), `leaf.whorlCount` slider (1-12, meaningful only for `whorl`), `leaf.serration.teeth`
  slider (0-12), `leaf.serration.depth` slider (0-1), `leaf.variegation.enabled` toggle,
  `leaf.variegation.pattern` select (`edge`/`vein`/`blotch`), `leaf.variegation.color` color,
  `leaf.variegation.amount` slider (0-1), `leaf.size.0`/`leaf.size.1` (Size min/max), `leaf.color`
  color, and a vein color pair: a toggle "Enable vein color" (local state, since `veinColor: null` is
  a valid value a plain `colorControl` can't represent) that when off sets `leaf.veinColor = null`
  and when on writes the picker's hex — same null-gating pattern as tree-viewer's
  `atlasPinned`/`applyAtlas()`.
- **Flower** — `flower.enabled` toggle, `flower.shape` select (`star`/`whorlBall`/`pouch`/`burPair`),
  `flower.petals` slider (1-16), `flower.frequency` slider (0-1), `flower.color` color, and a
  throat-color pair using the same toggle-gated null pattern as vein color (`flower.throatColor`).
- **Mutation** (docked panel, not a floating one — same as tree-viewer): mutation-degree slider (0-1),
  per-section "Mutate" buttons wired into `panelSection`'s `mutateFn` parameter for Stem/Leaf/Flower,
  plus a "Mutate all" button unioning all three lists, Undo/Redo buttons, Restart button (calls
  `loadOpts(DEFAULT_OPTS)`).
- **Export** — readonly `<textarea>` + "Copy plant JSON" button, `JSON.stringify(opts, null, 2)` — no
  replacer needed (plant opts never hold live `Texture` objects, unlike tree opts' `bark.map`).

Mutate lists mirror tree-viewer's `structureMutateList`/`barkMutateList`/`leavesMutateList` shape —
flat arrays of `{ min, max, get, set }` entries built via an `optsMutateEntry(path, min, max)` helper
identical to tree-viewer's, covering every numeric field in each section (toggles/selects/colors are
never mutated, same rule as trees):

- `stemMutateList()`: `stem.nodes.0`/`.1`, `stem.nodeSpacing.0`/`.1`, `stem.branchProb`, `stem.sprawl`.
- `leafMutateList()`: `leaf.leafletCount`, `leaf.whorlCount`, `leaf.serration.teeth`,
  `leaf.serration.depth`, `leaf.variegation.amount`, `leaf.size.0`/`.1`.
- `flowerMutateList()`: `flower.petals`, `flower.frequency`.

## Species tab (Family/Species save-breed-tag system)

Full parity with tree-viewer's Species tab, same two-level Family → Species model, persisted to
`localStorage` under its own key `plant-viewer:families` (kept separate from tree-viewer's
`tree-viewer:families` so the two tools' saved data never collide).

**First-launch seeding.** Unlike tree-viewer (which migrates a pre-existing flat saved-tree list),
plant-viewer has no prior save format to migrate — but it does have ready-made starting data. If
`localStorage.getItem('plant-viewer:families')` is `null` (the key has never been set — distinct from
an empty array, which means the user deliberately cleared everything), seed one starter family:

```js
const STARTER_KEYS = Object.keys(PLANT_PRESETS);   // ['chickweed','cleavers','mint','jewelweed']
{
  id: newId(), name: 'Wildflowers',
  species: STARTER_KEYS.map((key, i) => ({
    id: newId(), name: key,
    // seed formula matches createPlantPalette's own convention (plants.js) so the starter
    // species' geometry is identical to what's already placed in environment-viewer.html today.
    opts: { ...mergePlantOpts(PLANT_DEFAULTS, PLANT_PRESETS[key]), seed: 1 + i * 977 },
    parentSpeciesId: null,
    biomes: [...PLANT_BIOME_TAGS[key].biomes],
    density: PLANT_BIOME_TAGS[key].density,
    sizeRange: [0.85, 1.15],
  })),
}
```

The `sizeRange` default `[0.85, 1.15]` matches `plants-placement.js`'s current hardcoded
`0.85 + rng() * 0.3` scale jitter — not a new number, just making the existing constant editable
per-species going forward.

**Species metadata fields:** `name`, `biomes[]` (checkboxes over the same canonical biome-name list
`tree-viewer.html` uses — see `docs/subsystems/biomes.md`), `density` (slider), `sizeRange` min/max
(sliders). **No `ageRange`** — dropped entirely per this design's scope decision; `plants.js` has no
age/growth model to preview or export against yet.

**Grow family:** "Auto-add mutations" (batch-mutates the currently-loaded opts N times from the same
baseline via `stemMutateList()`+`leafMutateList()`+`flowerMutateList()`, saves each as a new species,
restores the baseline afterward — identical mechanics to tree-viewer's) and "Keep current tree as new
species" (manual: mutate/tune freely via the Tuning tab, then keep the result under a name).

**Species list / edit:** click a row to load its `opts` into the live Solo tree and select it for
editing (same unified load+select click as tree-viewer); a `×` per row deletes; the edit panel below
the list shows Name/Biomes/Density/Size-min/Size-max for the selected species. No age-preview slider
(that entire row from tree-viewer's `renderSpeciesEdit` is omitted, not stubbed).

**Export family JSON:** POSTs the family JSON to a new server endpoint `/api/save-plant-family`
(mirrors tree-viewer's `/api/save-family` exactly — same slugify-derived filename, same
falls-back-to-blob-download behavior if the POST fails), writing into a new top-level
`plant-families/` directory + its own `plant-families/manifest.json`, kept separate from `families/`
so tree and plant family data never collide on disk either.

## Server change: `serve.py`

Add a second POST route, `/api/save-plant-family`, alongside the existing `/api/save-family`. Both
routes do the same three things (slugify a name into a filename, write the JSON body to a directory,
append the filename to that directory's `manifest.json` if not already present) against different
directories — factor that shared logic into one helper, e.g.:

```python
def save_family_to(payload, dir_path):
    filename = f"{slugify(payload.get('name'))}.json"
    os.makedirs(dir_path, exist_ok=True)
    with open(os.path.join(dir_path, filename), 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    manifest_path = os.path.join(dir_path, 'manifest.json')
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
        if not isinstance(manifest, list):
            manifest = []
    except (FileNotFoundError, json.JSONDecodeError):
        manifest = []
    if filename not in manifest:
        manifest.append(filename)
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
    return filename
```

`do_POST` dispatches on `self.path` to call `save_family_to(family, FAMILIES_DIR)` for
`/api/save-family` or `save_family_to(family, PLANT_FAMILIES_DIR)` for `/api/save-plant-family`,
each still going through the existing size-limit check and `_send_json` response shape
(`{ ok, filename }` / `{ ok: false, error }`). `PLANT_FAMILIES_DIR = os.path.join(ROOT,
'plant-families')`, defined alongside the existing `FAMILIES_DIR`.

## Non-goals

- No wiring into `environment-viewer.html` — standalone tool only, same as `tree-viewer.html`.
- No placement, GPU instancing, LOD, or culling — that's `plants-gpu.js`/`plants-placement.js`'s job,
  already built and untouched by this work.
- No age/growth model, no age-preview slider, no `ageRange` species field — explicitly deferred.
- No texture-mode toggle — `plants.js` has no texture maps.
- No automated test file — this is UI glue code with no pure logic of its own to unit-test, same
  precedent as `tree-viewer.html` (which also has no `test-*.mjs`). Verified via `node --check` on
  the extracted inline script and a manual `curl` POST against the new `serve.py` endpoint.
- No shared/extracted UI control kit — the floating-panel manager and control primitives are
  duplicated inline from `tree-viewer.html`, matching that file's own precedent of not extracting a
  shared library for a two-tool UI kit.

## Testing / verification plan

- `node --check` against the inline `<script type="module">` content (extracted to the scratch
  directory) to catch syntax errors before ever loading a browser.
- Manual `curl -X POST` against `/api/save-plant-family` with a small sample family JSON, run against
  a live `python serve.py`, checking the response body, the written file under `plant-families/`, and
  `plant-families/manifest.json` — this part needs no GPU and is fully verifiable from this
  environment.
- Best-effort headless-Chrome smoke check (`--dump-dom`) for gross structural errors (panel markup
  present, no thrown script errors reported via the `#info` banner) — with the same disclosed
  limitation as the vegetation-variety work: this environment has no real WebGPU adapter, so live
  rendering correctness cannot be verified here and will be called out explicitly rather than
  claimed.

## Files touched

- Create: `plant-viewer.html`
- Modify: `serve.py` (new `/api/save-plant-family` route + `save_family_to` helper)
- Create: `plant-families/` directory (created lazily by the server on first save, same as
  `families/`)
- Modify: `docs/subsystems/vegetation.md` (replace the "Future tooling (not yet built)" paragraph
  with a real "Standalone tooling: `plant-viewer.html`" section, written in the same style as the
  existing `tree-viewer.html` writeup)
- Modify: `agent_log.csv` (append one row)
