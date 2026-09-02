# Sabosugi Visuals

This folder is a reference library of procedural visuals by
[sabosugi](https://codepen.io/sabosugi), plus repository-owned experiments that combine or port their
techniques.

It is not a package and is not wired into the main game renderer. The original pens are independent
studies with their own Three.js version, renderer, GUI, animation loop, and page-level assumptions. They
run in isolated iframes through the local gallery.

Use this document for the collection's technical architecture. Use
[VISUALS_INDEX.md](./VISUALS_INDEX.md) for the item-by-item catalog, source links, and detailed hybrid
notes.

## Inventory

The active gallery contains 102 pages:

- 94 original visuals: 80 ZIP-packaged CodePen exports and 14 standalone HTML files.
- 8 repository-owned pages representing 6 hybrid concepts.

There are 82 ZIP files on disk. Two duplicate downloads are excluded from the manifest. Root index.html
duplicates Enter to Other Dimension.html and is also excluded. BOTANY_TEACHING_MANUAL_2021.pdf is
unrelated reference material.

| Path | Purpose |
|---|---|
| VISUALS_INDEX.md | Hand-maintained catalog, categories, source URLs, and hybrid notes |
| build-manifest.py | Reads the catalog and sources, then regenerates the gallery manifest |
| pens-manifest.json | Generated inventory consumed by the gallery |
| gallery.html | Searchable iframe browser for original and hybrid pages |
| hybrids/ | Repository-owned combinations and WebGPU ports |
| hybrid-tuning/ | Saved GUI configurations for hybrids |
| *.zip | Original CodePen exports, kept intact rather than extracted |

## Gallery architecture

    VISUALS_INDEX.md + files
               |
               v
       build-manifest.py
               |
               v
       pens-manifest.json
               |
               v
          gallery.html
           /         \
          v           v
    plain HTML   /sabosugi/<slug>/...
                       |
                       v
               serve.py reads dist/
               directly from the ZIP

VISUALS_INDEX.md is the editorial source of truth for titles, categories, filenames, and source URLs.
build-manifest.py matches those records to files and detects Three.js versions, file inputs, video,
audio, and non-library remote assets. Do not hand-edit pens-manifest.json.

The ZIP exports contain runnable dist/ files. serve.py exposes them through /sabosugi/<slug>/<path>
without extracting the archives. The manifest maps each URL-safe slug back to a ZIP filename.

The gallery loads one visual at a time. Each iframe gets its own document, module registry, GUI,
animation loop, and WebGL context. Before selecting another visual, the gallery replaces the iframe with
about:blank. Discarding the document is the effective teardown for pens that do not dispose resources or
cancel their loop.

This isolation is deliberate. Combining the originals in one scene would require porting them.

## The connective thread

The originals do not share a codebase, but they share a strong procedural visual grammar:

    time / resolution / pointer / media
                    |
                    v
         construct coordinates or rays
                    |
                    v
     rotate, repeat, fold, or noise the domain
                    |
                    v
          evaluate a procedural field
                    |
                    v
            choose how to sample it
         /          |          |          \
        v           v          v           v
    raymarch     shade UVs   move mesh   move points/lines
                                            |
                                            v
                           palette, glow, additive blending,
                                and optional postprocessing

The recurring core is usually a scalar or vector field, not a modeled object. A pen may reveal that
field by marching a ray through it, evaluating it once per pixel, displacing vertices, positioning
particles, or distorting an input texture. The apparent subject--orb, nebula, tunnel, crystal, terrain,
or data stream--is often a different sampler and color treatment around related math.

This is the seam exploited by hybrids/ether-trails.html: visually unrelated pens can expose compatible
three-dimensional field functions even when their final renderers differ.

### Common scaffolding

A static scan of the 94 originals found:

| Pattern | Visuals |
|---|---:|
| Custom ShaderMaterial or RawShaderMaterial | 74 |
| Fullscreen 2x2 shader quad | 44 |
| Raymarch-related structure or vocabulary | 42 |
| Point or line topology | 20 |
| No custom shader; mainly scene graph and stock materials | 20 |
| Texture, image, SVG, or video input | 19 |
| Composer/bloom-style postprocessing | 19 |
| Explicit additive blending | 18 |
| GUI controls | 90 |
| Independent requestAnimationFrame loop | 88 |
| Resize handling | 92 |

Time and resolution are the dominant shader inputs. Recurring helper names include rot, hash, map,
getNormal, noise, and fbm. They reveal a stable vocabulary: coordinate transforms, pseudorandom fields,
density or distance evaluation, normal recovery, and multiscale noise.

## Technical schools

VISUALS_INDEX.md groups visuals by subject. These classes group them by rendering architecture. Counts
are a mutually exclusive heuristic classification; some visuals sit near a boundary.

### 1. Fullscreen raymarch and distance fields -- about 33

    OrthographicCamera -> 2x2 PlaneGeometry -> fragment shader
                        -> reconstruct ray -> march field -> color

Most apparent geometry exists only in the fragment shader. Examples: Xenolith Diamond, Highway to
Heaven, Quantum Cube, The Birth of Energy from the Ether, and Terminals Corridor.

### 2. Fullscreen fragment fields -- about 11

The same fullscreen shell directly evaluates color, noise, fluid, or texture-warp fields rather than
performing an obvious distance march. Examples: Colorful Nebula Background, Liquid Chrome, Fluid Neon,
Warp Images, and Pixels Scan.

### 3. Object-bound raymarch and procedural shells -- about 9

The computation belongs to a perspective scene or bounded proxy mesh. Examples: Liquid Neon Sphere,
Magical AI Orb, Alien Cell, Inside Light Neon Cave, and Hall of Fractals.

### 4. Shader-driven particles, lines, and instances -- about 13

The field controls topology or motion. Points, trails, polylines, or instances carry the visual, often
with additive blending and bloom. Examples: Data Pulse, Data Stream Wall, Trails Over Different Forms,
Liquid Particles in Sphere, and Rails in Space.

### 5. Other geometry-bound shader studies -- about 8

These use custom shaders on conventional geometry but do not fit the raymarch or particle branches.
Examples: Neon Kaleidoscope, Neon Ribbons, Abstract Chromatic Light, Colorful Smoke, and Old Cloth with
Wind.

### 6. Scene-graph and stock-material studies -- about 20

These rely mainly on generated geometry, primitives, instancing, lines, SVG extrusion, or stock
materials. Examples: Glass Logo with Panorama, Vector Plankton, Interactive Photo Gallery, 3D Gyroscope
Rings, Procedural Alien Rock, and Mascot 3D.

### Cross-cutting media-processing school

About 19 visuals use an image, SVG, texture, or video as an input domain. This overlaps the classes
above. Examples: Dither / ASCII Effect Pro, Video in 3D Forms, Liquid Over Image, Before & After Stream,
and Shapes Over Pixels.

## Shared lineage, not a shared framework

Most pens repeat the same scene, renderer, camera, GUI, uniforms, loop, and resize setup but implement it
independently. Exact function comparison found only small clusters of direct reuse. The strongest sibling
pair is Particles Stream and Through the Layers. Elsewhere, pens may share a noise helper, hash function,
resize routine, or loop template, but substantive source similarity drops sharply.

Think of the originals as sketches made from several generations of personal templates, not subclasses
of one engine.

- 55 originals pin Three.js 0.160.0.
- 12 pin 0.180.0.
- Smaller groups use versions from 0.128.0 through 0.185.1.
- 16 do not expose a version in the form detected by the manifest builder.

These are implementation eras, not compatible runtime layers. Consolidation onto one Three.js release
would be a porting project, not an import-map edit.

## Hybrids

| Concept | Pages | Combination level |
|---|---|---|
| Orb in Nebula | orb-in-nebula.html, orb-in-nebula-webgpu.html | Shader-level; WebGL and WebGPU |
| Nebula in Orb | nebula-in-orb.html | Shader-level, spatial relation inverted |
| Diamond on the Highway | diamond-on-the-highway.html, diamond-on-the-highway-webgpu.html | Shader-level; WebGL and WebGPU |
| Glass Plankton | glass-plankton.html | Scene graph through one parsed SVG |
| Ether Trails | ether-trails.html | Shared field registry sampled by volume and trails |
| Chrysalis Engine | chrysalis-engine.html | One selectable SDF anatomy evolving through three synthesized effect systems |

The original 94 visuals use WebGL. The two -webgpu.html pages are the explicit WebGPU/TSL ports.

### Chrysalis Engine

Chrysalis Engine is the strongest form of hybrid in this folder: Alien Cell, Xenolith Diamond, and
Abnormal Sphere Morphing no longer render as separate layers or passes. Both phases evaluate one
selected anatomy. The default is the repo's tested [`demos/sdf-bug.html`](../demos/sdf-bug.html)
beetle field; [`demos/sdf-creature.html`](../demos/sdf-creature.html), after
[Drin](https://x.com/DrinLajci), remains available from the same control. Their math participates in one
`ChrysalisSample` and one final distance:

                              selected shared SDF anatomy
                                  /                 \
                                 /                   \
              Abnormal living coordinates       growth-stiffened coordinates
                         |                              |
                         v                              v
              same anatomy SDF + Alien        same anatomy SDF + Xenolith
                  tissue deformation              facet lattice
                         |                              |
                         +--------------+---------------+
                                        |
                          directional growth synthesis
                                        |
                                        v
                     final anatomy distance, material IDs,
                         normal, material, and density

Growth is therefore mechanical state, not a color mask. It stiffens one anatomy from warped to rigid,
mixes organic and faceted evaluations of the same anatomy, embosses the advancing front into the
silhouette, changes normal-derived lighting, and converts internal tissue flow into crystalline lattice
density. The bug's shell, head, six legs, eyes, and antennae—or the creature's body, legs, horns, eye,
mouth, and tooth—keep stable material IDs through both phases. Alien Cell's orbit traps also bias the
angular seed fronts, so the transformation propagates through anatomy rather than across a generic
sphere or into an unrelated diamond.

`hybrids/chrysalis-field.js` owns the renderer-independent field contract and GLSL. The HTML
page owns camera rays, the single surface/interior marcher, material response, GUI, interaction, and
persistence. Click adds crystallization, shift-click adds a negative-polarity healing wave, drag orbits,
and the wheel zooms. The Debug folder exposes growth, front/stress, final-field normals, orbit traps,
march cost, and anatomy material IDs so coupling failures can be diagnosed visually.

The deeper authored constants are exposed as creative controls rather than march-safety controls. The
Organic folder now opens noise scale and motion, pulse frequency and wavelength, Alien fold scale and
rotation, vein width, fold displacement, and vein emboss. The anatomy folder adds beetle abdomen and
head proportions, groove depth, antenna elevation/pitch/thickness, and independent front/middle/rear
leg spread. Crystal adds lattice skew and anisotropy; Material adds phase-specific roughness and
specularity plus rim strength; Lighting exposes two directional lights. A selected-seed editor changes
the radius, strength, and propagation speed of one seed at a time, and newly placed seeds inherit those
values. All 74 numeric controls retain per-slider randomization locks and named-state persistence.

The page autosaves configuration, directional seeds, camera, and time through:

    POST /api/save-hybrid?name=chrysalis-engine
        -> sabosugi-visuals/hybrid-tuning/chrysalis-engine.json

The `States: named snapshots` folder can save or overwrite a named state, load any saved state,
or delete it. Named states contain the same complete snapshot as autosave and live beside the current
state in a versioned document. Existing pre-snapshot Chrysalis saves remain readable and upgrade on the
next write.

Each numeric parameter section also begins with `Randomize enabled`. Every slider has a small
checkbox beside its label: checked sliders participate in that section's randomization and unchecked
sliders stay fixed. Values are drawn inside the slider's own range and snapped to its step. Inclusion
choices are part of autosaves and named states; resetting the engine re-enables every slider. Toggles,
colors, action buttons, named-state controls, and debug views are intentionally not randomized.

`test-chrysalis-engine.mjs` guards the synthesis boundary: both source distances must feed one
field, normals and interior must sample that field, every declared uniform must be supplied, empty seed
sets must survive persistence, and only one render pass may exist. For game integration, port the
`chEvaluate`/`chDistance` contract and seed packet into the destination material;
leave the gallery camera, GUI, page loop, and disk store behind.

### Ether Trails

Ether Trails injects one procedural-field registry into two separately compiled shaders: a fullscreen
raymarched volume and a perspective grid of displaced trails. Both passes share the camera,
field-domain mapping, repeat rule, scale, phase, and draw-distance concept. A shared function alone was
insufficient; without shared coordinates and camera state the two images were stylistically related but
did not describe the same space.

It imports disk-store.js and saves tuning through:

    POST /api/save-hybrid?name=ether-trails
        -> sabosugi-visuals/hybrid-tuning/ether-trails.json

test-ether-trails-coupling.mjs protects the source-level coupling invariants.

### Glass Plankton

Glass Plankton combines two non-raymarched pens at the scene-graph level. One SVGLoader.parse() result
feeds filled shapes extruded into transmissive glass and sampled outlines expanded into animated trails.
Both representations must share orientation, scale, and bounds. The solid uses a 180-degree rotation
instead of negative scale so its winding and physical-material normals remain valid.

It imports disk-store.js and currently uses an older dedicated route:

    POST /api/save-glass-plankton
        -> glass-plankton.json at the repository root

test-glass-plankton-alignment.mjs protects alignment, centering, and front-cap winding.

## Running the gallery

From the repository root:

    python serve.py

Then open /sabosugi-visuals/gallery.html.

Use serve.py rather than file:// or an arbitrary static server. The manifest is fetched, ZIP entries need
the /sabosugi/ route, and some hybrids import repository modules or Three.js from node_modules. Most
originals also load dependencies from CDNs, and 17 fetch additional remote assets.

Do not create a grid of live previews. Browsers allow relatively few concurrent WebGL contexts and each
pen starts its own loop. Use static screenshots for thumbnails.

Do not mount several originals into the main application document without first porting them. Common
problems include incompatible Three.js versions, global DOM and CSS assumptions, unmanaged GPU
resources, duplicate loops and input handlers, color-space differences, and remote assets.

## Adding an original

1. Add the ZIP or standalone HTML file.
2. Preserve its README, license, attribution, and archive layout.
3. Add a row to the appropriate VISUALS_INDEX.md table.
4. Run python sabosugi-visuals/build-manifest.py.
5. Resolve every unmatched file or catalog row.
6. Start serve.py and verify the entry through gallery.html.

An expected ZIP contains dist/index.html plus its referenced script.js and style.css.

## Adding a hybrid

1. Add an HTML module under hybrids/ and give it a useful title element.
2. Credit source pens and retain required license notices.
3. Prefer repository-local Three.js imports and shared utilities.
4. For persistence, use disk-store.js with POST /api/save-hybrid?name=<safe-lowercase-slug>.
5. Add a focused test when coordinate systems, shaders, geometry representations, or passes must remain
   coupled.
6. Regenerate the manifest and verify the page in the gallery.

## Porting into the main renderer

Treat an original pen as a reference implementation, not an application component. Extract:

1. **Domain:** screen UV, world position, object position, or media UV.
2. **Field:** SDF, density, noise, fold, flow, or sampled texture.
3. **Sampler:** raymarch, direct evaluation, displacement, or particle placement.
4. **Encoder:** opacity, normals, emissive color, or motion.
5. **Compositor:** additive blending, feedback, transmission, bloom, or legacy color space.
6. **Controls:** technique parameters versus demo-only tuning.

Rebuild those pieces under the destination renderer's lifecycle and resource ownership. Avoid copying
the page bootstrap, global handlers, GUI, and animation loop unless the destination is another isolated
experiment.

This preserves the collection's real connective thread--the field and how it is sampled--without
importing the incompatibilities that iframe isolation contains.
