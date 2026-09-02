# Sabosugi reference visuals and hybrids

A browsable library of 94 third-party CodePen visuals by the artist **sabosugi**, plus seven hybrids of
our own built by recombining them. Nothing here is wired into `environment-viewer.html` or any other app:
this is reference material, and a place to try a technique before porting it.

Open `/sabosugi-visuals/gallery.html` behind `python serve.py` to browse it. The catalog itself —
titles, categories, source pen URLs, and the notes on each hybrid — lives in
`sabosugi-visuals/VISUALS_INDEX.md`, which is the file to edit; everything else is generated from it.

| File | What it is | Lines |
|---|---|---|
| `sabosugi-visuals/VISUALS_INDEX.md` | The hand-written catalog. The source of truth for titles, categories and pen URLs. | 385 |
| `sabosugi-visuals/gallery.html` | The shell: search, category filter, one iframe. | 314 |
| `sabosugi-visuals/build-manifest.py` | Regenerates the manifest from the index plus a scan of the pens. | 214 |
| `sabosugi-visuals/pens-manifest.json` | Generated. What `gallery.html` reads. Do not hand-edit. | 1567 |
| `sabosugi-visuals/hybrids/*.html` | Seven hybrids. See below. | ~4500 |
| `test-ether-trails-coupling.mjs` | 37 checks over `ether-trails.html`. | 193 |
| `test-glass-plankton-alignment.mjs` | 9 checks over the shared-SVG normalisation. | 98 |

## Licensing

Every pen is MIT (`LICENSE.txt` inside each zip), so the code may be reused with the copyright notice
kept. Each hybrid credits both source pens on screen with links to the originals.

## The gallery, and why it is iframes

The 94 pens were never written to share a page. Between them they pin **nine different Three versions**
(0.128 through 0.185, with 16 pinning none), 92 of 96 build their own lil-gui panel, 80 append a canvas
straight to `document.body`, and almost none dispose anything or stop their render loop. Hosting them in
one scene would mean rewriting all 94.

An iframe per pen costs nothing and gives each its own document, module registry, GUI and
`requestAnimationFrame` loop. Replacing the frame performs the teardown the pens never implement
themselves, which is why `select()` blanks `src` to `about:blank` before loading the next one.

Two limits, both real:

- **It needs a network.** Every pen loads Three from a CDN, and 17 also fetch remote assets (imagekit,
  pexels, unsplash, picsum, streamable, polyhaven). Rewriting the importmaps to the repo's local
  `node_modules` would only work for pens near r184; 0.128 and 0.150 differ too much.
- **Live thumbnails are impossible.** Browsers cap concurrent WebGL contexts at around 16, so a grid of
  running previews would fail. Previews would have to be captured static images, which needs a separate
  pass; the list is text-only until then.

The manifest also flags what a pen needs before it shows anything: 18 want a file loaded into them, 4
handle video, and 1 has audio browsers will not autoplay until you click inside the frame. The gallery
labels each in the list and the top bar.

**The gallery's own chrome hides.** Nearly every pen puts its lil-gui panel at the top right, so the bar
keeps that corner empty and `Hide UI` collapses both the bar and the sidebar. A pill at the bottom left
restores it and steps between pens. That has to be a visible control rather than a keyboard shortcut:
once you click into the frame, the pen's document owns the focus and key events never reach the gallery.

## The manifest

`build-manifest.py` reads `VISUALS_INDEX.md` for titles, categories and source URLs, matches each catalog
row to a file on disk (the catalog abbreviates long filenames with an ellipsis, so the match is on both
ends of it), and scans each pen for its pinned Three version and its capability flags. It **exits nonzero
if any file on disk lacks a catalog row or any row lacks a file**, which is what keeps the two in step.
Run it after adding a pen or editing the index:

```
python sabosugi-visuals/build-manifest.py
```

Filenames with spaces are URL-escaped in the manifest, because 14 of the standalone pens have them.

## Serving pens out of their zips

80 of the pens are CodePen zip exports, and each already contains a complete self-contained
`dist/index.html` next to the `script.js` and `style.css` it references. `serve.py`'s
`GET /sabosugi/<slug>/<file>` reads those straight out of the archive, so nothing is extracted and the
folder keeps 80 zips instead of gaining 80 directories that would drift from them. The slug is
pattern-checked and looked up in the manifest, and the member is resolved against the archive's own
listing, so a path cannot traverse out. See `docs/subsystems/infra.md`.

### Windows path length

The CodePen exports carry their full pen title in the filename, donation appeal and all, so the longest
run to about 100 characters. Cloning into a deep directory on Windows can push them past the 260-character
`MAX_PATH` limit: git checks out everything it can, prints a checkout error, and silently leaves the
longest files missing from the working tree while they sit perfectly in the repo. It showed up here as 71
of 82 zips appearing, at a path measured at exactly 261 characters.

If that happens, either clone somewhere shorter or set `git config --system core.longpaths true`. The
giveaway is `git status` listing deletions you did not make.

### When the pens 404

The manifest and the 21 standalone pens are plain static files; only the 80 zipped ones need the
`/sabosugi/` route. So a server without that route lists all 101 entries perfectly and then fails on most
of them. In practice that means **a `serve.py` process started before the route was added** — Python does
not reload, so an old process keeps serving static files while the route it never had returns 404.
Restart it.

`gallery.html` probes the route once at boot and says so in a banner rather than showing a blank frame.
The probe uses GET rather than HEAD, because `do_HEAD` is a separate handler on the Python side.

## Hybrids

| Hybrid | Combines | Joined at |
|---|---|---|
| Orb in Nebula | Anunaki Magical Sphere + Colorful Nebula Background | one fragment shader (`-webgpu` variant ports it to TSL) |
| Nebula in Orb | the same two, inverted | the orb's shell keeps its container, the nebula fills it |
| Diamond on the Highway | Xenolith Diamond + Highway to Heaven | two `wgslFn`s composed by a TSL `select()` |
| Glass Plankton | Vector Plankton + Glass Logo with Panorama | one `SVGLoader.parse` feeding both |
| Ether Trails | Trails Over Different Forms + fields from seven pens | a shared scalar field |

The first three combine raymarched pens, which merge at the shader level. The last two do not, because
neither of Glass Plankton's sources is a shader at all.

### Glass Plankton

Both pens start at `SVGLoader.parse(text).paths`. The glass pen extrudes those paths into a transmissive
solid; the plankton pen samples them as polylines and smears N interpolated copies between two transforms.
One parse feeds both, so the trail is an outline of the object it resolves into, and its near end is bound
to the solid's live transform.

Two details are load-bearing:

- **The trail lines are additive and opaque at once.** Three forces `NoBlending` only when
  `blending === NormalBlending && transparent === false` (`WebGLState.setMaterial`), so an additive
  material with `transparent: false` keeps its blending *and* sorts into the opaque bucket — and
  `renderTransmissionPass` only feeds opaque and transmissive objects into the buffer that transmissive
  materials sample. A transparent trail composites over the glass; this one refracts through it.
- **The solid is rotated 180° about X, not mirrored in Y**, to match the trail's per-point Y negation. A
  negative scale would reverse the winding and invert the normals, which transmission shows immediately.
  `test-glass-plankton-alignment.mjs` asserts both paths land in the same box and the front cap still
  winds outward.

### Ether Trails

A scan found **42 pens exposing a `float f(vec3)` of their own**, and the ether pen's marcher never cared
what it was marching — it steps on `abs(structuralVal)` and accumulates a palette, which any scalar field
satisfies. So both halves are generic: the volume flies through whichever field you pick, and the grid
reads two fields and blends them with six operators. Seven fields are harvested so far, from seven pens.

`FIELD_GLSL` holds the registry and is injected into both programs. Nothing in it reads a uniform,
precisely because the two programs supply different ones.

The two halves share a space, which took three things and not merely a shared function — the first
version had only the shared function and the halves were running one function over unrelated coordinates:

1. **One camera.** The volume draws on a fullscreen quad under an orthographic camera, so it is handed the
   perspective camera's position and inverse projection-view each frame and rebuilds its rays from them.
2. **One domain.** `toFieldSpace` applies the flight offset, tunnel repetition and field scale, and both
   programs call it with the same arguments.
3. **One phase**, taken from field position. Copying the volume's ray-distance phase to the grid meant
   eye distance, which varies across a surface and spun the fold's rotation axis through 35 radians.

`Field Zoom` is where the coupling is deliberately relaxed: these fields are written to be sampled per
pixel, and the grid has 0.12 local units between vertices, so anything finer aliases. At zoom 1 the grid
reads exactly the point the volume marches; the 0.05 default puts structure roughly 30× the vertex step.

## Shape ordination (experimental)

Chrysalis Engine has no mesh — it's a raymarched SDF driven by `CONFIG` (~30 scalars) plus a
variable seed list — so comparing shapes means sphere-tracing a point cloud rather than measuring
geometry directly. Four Node-only files, none of them wired into `chrysalis-engine.html`:

| File | Role |
|---|---|
| `chrysalis-field-cpu.mjs` | Pure-JS port of `chEvaluate`/`chDistance` from `chrysalis-field.js`'s GLSL. Same "CPU/GPU math twin" pattern as `forest-cull.js` — not imported by the shader, kept in sync by hand. |
| `chrysalis-point-cloud.mjs` | Sphere-traces one config + seed list into surface points (position, normal, growth, disturbance), radially from a Fibonacci sphere of directions using the shader's own stepping constants. |
| `chrysalis-shape-embed.mjs` | Reduces a point cloud to a fixed-length descriptor: a rotation-invariant pairwise-distance histogram plus mean growth/disturbance, bounding radius, and seed count/polarity. |
| `chrysalis-shape-corpus.mjs` | Loads the real saved states from `hybrid-tuning/chrysalis-engine.json` and generates synthetic configs from the same ranges as the page's sliders (`RANGES`, hand-copied — keep in sync if a slider range changes), since the real corpus alone (3 shapes as of writing) is too thin for PCA/MDS. |

`test-chrysalis-shape-ordination.mjs` (repo root) feeds the resulting vectors through
`ordination-vectors.js`'s `buildGram`/`eigenCoords` — the same Gram-matrix/PCA code
`code-ordination.html` runs on source-file embeddings, unmodified, since none of it is
text-specific. It also checks a structural sanity property directly: an all-crystal config sits
farther from an all-organic one than from a second, differently-oriented all-crystal config.

Radial tracing assumes the field is roughly star-shaped around the origin — a fold hidden behind
another fold, invisible from every direction back to the center, won't get sampled. Points on the
isosurface are compared, not the field's raw geometry, so `time` is fixed at 0 for every shape
rather than each shape's own animation clock, to keep comparisons apples-to-apples.

No browser viewer exists yet for the resulting map; the test only prints label/coordinate pairs for
manual inspection. A scatter-plot page (following `code-ordination.html`'s layout) and a `score`
stage against hand-tagged labels are both natural follow-ups, not built here.

## Two traps worth carrying to other pages here

**A control gated by a different control is a defect.** The Field mix folder's six controls are read by
exactly one of 27 height functions, and the shader calls it only when `uShapeType` is 26. Under any other
form all six updated their uniforms and changed nothing, silently — and since the form is persisted, one
earlier visit to the Form Type dropdown left the folder dead on every later load. They now select the
form that reads them, and the status line names the live form. The test asserts every one of the six arms.

**A page that autosaves needs a way back.** Both hybrids have `Reset everything to defaults` as the first
control. `DEFAULTS` is deep-copied *before* `applySaved` runs at boot, which is the only moment the
authored values still exist, and the reset also restores what is not in the config object: camera position
and orbit target, the accumulated clocks, and in Glass Plankton the shape and generated panorama.

Tuning autosaves through `POST /api/save-hybrid?name=<slug>` into `sabosugi-visuals/hybrid-tuning/`, shared
by every hybrid so a new page needs a name rather than a new route. Glass Plankton predates it and still
writes `glass-plankton.json` through its own route.

## Testing

Plain Node, no framework, and no GPU — which is the point. Both shaders are separately compiled, so
nothing at runtime would notice them drifting apart:

```
node test-ether-trails-coupling.mjs
node test-glass-plankton-alignment.mjs
```

The coupling test includes a real JavaScript parse, because a backtick inside a GLSL comment closes the
template literal holding the shader and every other check reads the file as text. That has happened twice.
