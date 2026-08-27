# Sabosugi Visuals — Index

Reference library of third-party CodePen visuals by artist **sabosugi** (codepen.io/sabosugi), dropped into this
folder as downloaded pen exports. None of these are wired into `environment-viewer.html` or any other app
in this repo — this is a browsable catalog for finding inspiration/reference before porting a technique.

**To browse them, run `python serve.py` and open `/sabosugi-visuals/gallery.html`.** It lists all 100
entries with search and category filters, and loads the selected one in an iframe. `pens-manifest.json`
drives that list; regenerate it with `python sabosugi-visuals/build-manifest.py` after adding a pen or
editing this file, which is where the titles, categories and pen URLs come from.

All 94 visuals use Three.js `WebGLRenderer`, and none use WebGPU or TSL despite living in the
`workshop-webgpu` folder. Most are a fullscreen or object-bound `ShaderMaterial` (raw GLSL, often
raymarched) — Anunaki Magical Sphere, Colorful Nebula Background, Xenolith Diamond and Highway to Heaven
have each been read and confirmed as such. But **not all of them are**: Vector Plankton is CPU-animated
`LineSegments` and Glass Logo is an `ExtrudeGeometry` under a stock `MeshPhysicalMaterial`, neither with a
line of custom shader code. Check the source before assuming a given pen is a raymarcher.

- **80 visuals** are CodePen zip exports (`<name>.zip`, unzip to get `dist/index.html` + `src/index.html` +
  `src/script.js` + `README.md` with the original CodePen URL).
- **14 visuals** are standalone `.html` files at the folder root (open directly in a browser).
- `index.html` at the folder root is a duplicate of `Enter to Other Dimension.html`, not a separate visual.
- Two zips are duplicate downloads of the same pen: `colorful-smoke-support-me-...(1).zip` and
  `glass-logo-with-panorama-svg-support (1).zip` each duplicate their non-`(1)` sibling.
- `BOTANY_TEACHING_MANUAL_2021.pdf` is unrelated reference material, not a visual — not included below.
- `hybrids/` holds our own recombinations of these pens. They are new code under this repo's conventions,
  not pen exports. See **Hybrids** at the end.

Source column links to the original CodePen pen where the zip's `README.md` recorded one.

## Cosmic / Dimensional Flythrough

Camera moves through space, nebulae, portals, or light tunnels.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Colorful Nebula Background | Nebula | `colorful-nebula-background-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/WbGadbw) |
| Inside Nebula | Nebula | `inside-nebula.zip` | [pen](https://codepen.io/sabosugi/pen/ZYprEOw) |
| Dark Matter | Nebula | `Dark Matter.html` | — |
| Unknown Galaxy | Nebula | `Unknown Galaxy.html` | — |
| Data Tunnel | Tech Tunnel | `data-tunnel-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/azZmLoB) |
| Fly in Blockchain | Tech Tunnel | `fly-in-blockchain-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/bNwyKjX) |
| Through the Layers | Tech Tunnel | `through-the-layers.zip` | [pen](https://codepen.io/sabosugi/pen/VYPPaoE) |
| Fly in Particles City | Tech Tunnel | `Fly in Particles CIty.html` | — |
| Flight Through the Atmosphere | Aerial Flight | `flight-through-the-atmosphere-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/gbLPgeL) |
| Rails in Space | Aerial Flight | `rails-in-space-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/xbgWXMP) |
| Falling Through the Sky | Aerial Flight | `Falling Through the Sky.html` | — |
| Fly in Cave | Cave Interior | `fly-in-cavethree-js.zip` | [pen](https://codepen.io/sabosugi/pen/PwzGGxa) |
| Inside Light Neon Cave | Cave Interior | `Inside Light Neon Cave.html` | — |
| Fly Over Nano Structures | Microscopic Flight | `fly-over-nano-structures.zip` | [pen](https://codepen.io/sabosugi/pen/wBzxKJa) |
| Inside UFO Spaceship | Sci-Fi Interior | `inside-ufo-spaceship-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/XJpqjpo) |
| Fractal Dreams | Fractal | `fractal-dreams-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/NPREpqP) |
| Hall of Fractals | Fractal | `hall-of-fractals-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/gbgeXja) |
| Going to Shambhala | Dimensional Portal | `going-to-shambhala.zip` | [pen](https://codepen.io/sabosugi/pen/raWwMWO) |
| Highway to Heaven | Dimensional Portal | `highway-to-heaven-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/azpqWKE) |
| The Birth of Energy from the Ether | Dimensional Portal | `the-birth-of-energy-from-the-ether-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/WbGqrKy) |
| The Place Where Souls Are Born | Dimensional Portal | `the-place-where-souls-are-born-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/bNBGKgr) |
| Enter to Other Dimension | Dimensional Portal | `Enter to Other Dimension.html` (dup: `index.html`) | — |

## Sci-Fi Tech & Data

Cyberpunk / data-visualization themed pieces — corridors, holograms, digital readouts.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Terminals Corridor | Corridor / Architecture | `terminals-orridor-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/XJNpVNe) |
| Futuristic Neon Ceramic Corridor | Corridor / Architecture | `Futuristic Neon Ceramic Corridor.html` | — |
| Holo Blinds | Holographic | `holo-blinds-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/azpNzMG) |
| Holo Ribbons on White Background | Holographic | `holo-ribbons-on-white-background-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/vEgGvKR) |
| Neon Ribbons | Holographic | `Neon Ribbons.html` | — |
| City Scan | Scan / Wireframe | `city-scan-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/dPONVYy) |
| Pixels Scan | Scan / Wireframe | `pixels-scan-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/zxNdgqZ) |
| Data Pulse | Data Visualization | `data-pulse-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/azmxRXY) |
| Data Stream Wall | Data Visualization | `data-stream-wall-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/WbGBRKO) |
| Neural Network Signals | Data Visualization | `neural-network-signals.zip` | [pen](https://codepen.io/sabosugi/pen/YPGLJpv) |
| Crystal of Data | Data Object | `crystal-of-data-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/LEbGORv) |
| Digital Tokamak with Trails | Data Object | `digital-tokamak-with-trails-three-js.zip` | [pen](https://codepen.io/sabosugi/pen/jErebjR) |
| Tunnel of Digits with Flashes of Lightning | Digital Rain | `tunnel-of-digits-with-flashes-of-lightning.zip` | [pen](https://codepen.io/sabosugi/pen/NPREBJZ) |
| 3D Gyroscope Rings | Geometric Mechanism | `3d-gyroscope-ringsthree-js.zip` | [pen](https://codepen.io/sabosugi/pen/OPXzbze) |
| Quantum Cube | Geometric Mechanism | `quantum-cube-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/rajpbOE) |
| Neon Kaleidoscope | Geometric Mechanism | `Neon Kaleidoscope.html` | — |

## Orbs & Energy Spheres

Self-contained spherical hero objects — magical, plasma, AI, or crystalline.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Anunaki Magical Sphere | Mystical Orb | `anunaki-magical-sphere-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/MYbmpya) |
| Colorful Magical Sphere | Mystical Orb | `colorful-magical-sphere-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/OPbJJOr) |
| Liquid Particles in Sphere | Mystical Orb | `liquid-particles-in-sphere-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/azpEqMj) |
| Liquid Neon Sphere | Mystical Orb | `Liquid Neon Sphere.html` | — |
| Magic Plasma Sphere | Plasma | `magic-plasma-sphere-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/jErWrMe) |
| Pulsing Orb | Plasma | `pulsing-orb-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/bNBpKQb) |
| Magical AI Orb | AI Orb | `magical-ai-orb-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/EagJwmv) |
| Smooth AI Orb | AI Orb | `smooth-ai-orb-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/EaZmXzE) |
| Quantum Core | Energy Core | `quantum-core-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/ZYBYggJ) |
| Inside Quantum | Energy Core | `inside-quantum-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/pvNqdRy) |
| Inside Quantum Core | Energy Core | `Inside Quantum Core.html` | — |
| Xenolith Diamond | Crystal Form | `xenolith-diamond-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/JobXbPW) |
| Magical Octahedron | Crystal Form | `Magical Octahedron.html` | — |
| Disco Ball | Reflective Object | `disco-ball-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/NPbvWLy) |

## Organic & Biological

Cellular, botanical, and geological forms.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Alien Cell | Microscopic | `alien-cell-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/xbgWxvN) |
| Abstract Plankton | Microscopic | `abstract-plankton-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/NPRoVqG) |
| Vector Plankton (SVG-loadable) | Microscopic | `vector-plankton-three-js-you-can-load-your-svg-form-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/pvbKxKQ) |
| Kinetic Villi | Microscopic | `kinetic-villi-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/emBwvEJ) |
| Villi from Pixels | Microscopic | `villi-from-pixels-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/LExzmzQ) |
| Aurum Leaf | Botanical | `aurum-leaf-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/ByQZrMY) |
| Tree of Souls | Botanical | `tree-of-souls-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/RNodamL) |
| Alien Fluorite | Geological | `alien-fluorite-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/jEVPrOx) |
| Procedural Alien Rock | Geological | `procedural-alien-rock-three-js.zip` | [pen](https://codepen.io/sabosugi/pen/XJKPvyg) |

## Fluid, Liquid & Smoke

Fluid-simulation-style shader surfaces — metal, latex, smoke, holographic liquid.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| 3D Fluid Background | Fluid Simulation | `3d-fluid-background-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/gbwNZPr) |
| Abnormal Sphere Morphing | Liquid Metal | `abnormal-sphere-morphing-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/vEyOYEX) |
| Abstract Blue Latex | Liquid Metal | `abstract-blue-latex-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/RNobLNR) |
| Liquid Chrome | Liquid Metal | `Liquid Chrome.html` | — |
| Colorful Smoke | Smoke & Vapor | `colorful-smoke-support-me-...sabosugi.zip` (+ duplicate `(1)` copy) | [pen](https://codepen.io/sabosugi/pen/wBgxMjo) |
| Fluid Holographic Background | Holographic Fluid | `fluid-holographic-background-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/zxKELBB) |
| Fluid Neon | Holographic Fluid | `fluid-neon-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/XJjypjm) |

## Nature & Atmosphere

Landscapes, sky, and planetary surfaces.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Magical Landscape | Terrain | `magical-landscape-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/OPbXXoN) |
| Chameleon Topography | Terrain | `chameleon-topography-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/LEbENap) |
| Holo Grass Hill | Terrain | `holo-grass-hill-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/WbRdYjE) |
| Colorful God Rays | Atmospheric Light | `colorful-god-rays-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/OPbrMKz) |
| Northern Lights (Aurora Borealis) | Atmospheric Light | `northern-lights-aurora-borealis-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/XJjoprL) |
| Very Hot Planet | Planet | `very-hot-planet.zip` | [pen](https://codepen.io/sabosugi/pen/RNKpmQj) |

## Particle & Motion Effects

Particle-driven or trail-driven motion pieces, plus cloth/pyro sims.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Particles Stream | Particle Flow | `particles-stream-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/yygMKRb) |
| Trails in Forms | Particle Flow | `trails-in-formsthree-js.zip` | [pen](https://codepen.io/sabosugi/pen/emzdzmy) |
| Trails Over Different Forms | Particle Flow | `trails-over-different-formsthree-js.zip` | [pen](https://codepen.io/sabosugi/pen/qENqdZm) |
| Waves Pins | Particle Flow | `waves-pins-three-js.zip` | [pen](https://codepen.io/sabosugi/pen/emzpagK) |
| 3D Forms as Pixels | Particle Formation | `3d-forms-as-pixels-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/JoRpVeO) |
| Abstract Lights | Ambient Light | `abstract-lights-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/WbGaBma) |
| Abstract Chromatic Light | Ambient Light | `Abstract Chromatic Light.html` | — |
| Fireworks 2026 + Boom Sound | Pyrotechnics | `fireworks-2026-boom-sound.zip` | [pen](https://codepen.io/sabosugi/pen/ByzBXQW) |
| Old Cloth with Wind | Cloth Simulation | `old-cloth-with-windthree-js.zip` | [pen](https://codepen.io/sabosugi/pen/ByzLYpb) |

## Image / Video Processing & Interactive

Pieces that take an image/video/cursor as input and process or distort it, plus UI/branding pieces.

| Visual | Sub-category | File | Source |
|---|---|---|---|
| Liquid Over Image | Liquid Distortion | `liquid-over-image-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/myRXWPm) |
| Warp Images | Liquid Distortion | `warp-images.zip` | [pen](https://codepen.io/sabosugi/pen/NPRyaQa) |
| Dither / ASCII Effect Pro | Pixel-Art Filter | `dither-ascii-effect-pro-video-version-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/full/PwzWLLw) |
| Shapes Over Pixels – FX for Video | Pixel-Art Filter | `shapes-over-pixelsfx-for-video-support-me-...sabosugi.zip` | [pen](https://codepen.io/sabosugi/pen/BypLMMN) |
| Pixels as Frequencies | Audio-Reactive Pixel FX | `pixels-as-frequencies-three-js.zip` | [pen](https://codepen.io/sabosugi/pen/azZgYmd) |
| Video in 3D Forms | 3D Reprojection | `video-in-3d-formsthree-js.zip` | [pen](https://codepen.io/sabosugi/pen/YPWrWGq) |
| Before & After Stream | Compare Effect | `before-after-stream-three-js.zip` | [pen](https://codepen.io/sabosugi/pen/YPWQGZd) |
| Followers – Cursor Effect | Cursor Interaction | `followerscursor-effect.zip` | [pen](https://codepen.io/sabosugi/pen/MYbJQGZ) |
| Interactive Photo Gallery | Gallery / UI | `interactive-photo-gallery.zip` | [pen](https://codepen.io/sabosugi/pen/LEZPerG) |
| Glass Logo with Panorama (SVG Support) | Branding / Logo | `glass-logo-with-panorama-svg-support.zip` (+ duplicate `(1)` copy) | [pen](https://codepen.io/sabosugi/pen/bNwjyXP) |
| Mascot 3D | Branding / Logo | `mascot-3dthree-js.zip` | [pen](https://codepen.io/sabosugi/pen/YPWPoRJ) |

## The gallery

`gallery.html` gives all 100 entries one interface. Each pen loads in an **iframe**, which is the only
arrangement these particular files support: between them they pin nine different Three versions (0.128
through 0.185, with 16 pinning none), 92 of 96 build their own lil-gui panel, 80 append a canvas straight
to `document.body`, and almost none dispose anything or stop their render loop. Hosting them in one
scene would mean rewriting all 94. A frame per pen gives each its own document, module registry, GUI and
`requestAnimationFrame` loop at no cost, and swapping the frame performs the teardown the pens never
implement themselves.

The 80 zipped pens are **served from inside their archives** by `serve.py`'s `/sabosugi/<slug>/<file>`
route, because each zip already contains a complete self-contained `dist/index.html` next to the
`script.js` and `style.css` it references. Nothing is extracted, so the folder keeps 80 archives instead
of gaining 80 directories that would drift from them. The other 20 entries are plain files already.

Two limits worth knowing:

- **The gallery needs a network.** Every pen loads Three from a CDN, and 17 also fetch real assets
  (imagekit, pexels, unsplash, picsum, streamable, polyhaven). Rewriting the importmaps to the repo's
  local `node_modules` would only work for pens near r184; 0.128 and 0.150 differ too much.
- **Live thumbnails are not possible.** Browsers cap concurrent WebGL contexts at around 16, so a grid
  of running previews would fail. Previews would have to be captured static images, which needs a
  separate pass; the list is text-only until then.

The manifest also flags what a pen needs before it will show anything: 18 want a file loaded into them,
4 handle video, and 1 has audio that browsers will not autoplay until you click inside the frame.

**The gallery's own chrome hides.** Nearly every pen puts a lil-gui panel at the top right, which is
exactly where a status bar's controls would otherwise sit, so the bar keeps that corner empty and its
`Hide UI` button collapses both the bar and the sidebar to give the pen the whole window. A small pill at
the bottom left restores it and steps between pens. That pill has to be a visible control rather than a
keyboard shortcut: once you click into the frame the pen's document owns the focus, and key events never
reach the gallery.

## Hybrids

Our own combinations, built in this repo rather than downloaded. Both source pens are MIT
(`LICENSE.txt` inside each zip), so the code may be reused with the copyright notice kept; each hybrid
credits its sources on screen.

| Hybrid | Combines | File |
|---|---|---|
| Orb in Nebula | Anunaki Magical Sphere + Colorful Nebula Background | `hybrids/orb-in-nebula.html`, `hybrids/orb-in-nebula-webgpu.html` |
| Nebula in Orb | the same two, inverted | `hybrids/nebula-in-orb.html` |
| Diamond on the Highway | Xenolith Diamond + Highway to Heaven | `hybrids/diamond-on-the-highway.html`, `hybrids/diamond-on-the-highway-webgpu.html` |
| Glass Plankton | Vector Plankton + Glass Logo with Panorama | `hybrids/glass-plankton.html` |
| Ether Trails | Trails Over Different Forms as a readout for fields harvested from seven pens | `hybrids/ether-trails.html` |

The first three combine raymarched pens, which merge at the shader level: same architecture, so the
helper functions concatenate into one `main()`, and the `-webgpu` variants port that to three r0.184
WGSL/TSL. Glass Plankton is a different kind of join — neither source is a shader, so the two combine at
the scene-graph level instead, sharing a parsed SVG rather than a ray march.

### Ether Trails — the field hybridiser

This one started as a pair and became a machine, because the seam it was built on turned out to be
everywhere.

Trails Over Different Forms displaces a grid of 100 polylines by a 2D height function and lets you swap
which one, so "a form" is already a pluggable function there. The Birth of Energy from the Ether is a
raymarch whose core is a cheap 3D fold, `q += sin(q * scale + t).yzx / scale`, read out as `q.y`. A 3D
scalar field works as a height function, so the fold became a form and the grid became a contour survey
of the volume rendered behind it.

Then a scan of the collection found **42 pens exposing a `float f(vec3)` of their own**, and the ether's
march never cared what it was marching — it steps on `abs(structuralVal)` and accumulates a palette,
which any scalar field satisfies. So both halves are now generic:

- the **volume** flies through whichever field you pick, using the ether's marcher and tone curve;
- the **grid** reads two fields and blends them, with six operators.

Seven fields are harvested so far, each its source pen's own math:

| Field | From | Character |
|---|---|---|
| Ether | The Birth of Energy from the Ether | Folded filaments |
| Nebula | Inside Nebula | Thin ridged veins |
| Aurora | Northern Lights | Fractal curtain |
| Crystal | Xenolith Diamond | Hard facets |
| Highway | Highway to Heaven | Structural density |
| Morph | Abnormal Sphere Morphing | Value noise |
| Quantum Cube | Quantum Cube | True box distance |

That is 7 volumes against 7 × 7 × 6 grid combinations, and the interesting ones are rarely the matched
pairs — the grid does not have to read the volume it stands in front of. Every blend operator collapses
to field A at mix 0, so turning B down always returns you to A rather than to something else. The
original 26 forms are all still there, with any field as a backdrop.

**The two halves genuinely share a space**, which took three things and not merely a shared function.
The first version of this page had only the shared function, and that was not enough: the volume sampled
at `totalDist * rayDir` with a flight offset and `mod()` tunnel repetition applied, while the grid sampled
at `vec3(p * scale, depth)` with neither and a different scale, under a different camera. Same maths,
unrelated coordinates. It looked related without being related.

1. **One camera.** The volume draws on a fullscreen quad under an orthographic camera, so it cannot see
   the perspective camera the grid uses. It is now handed that camera's position and inverse
   projection-view every frame and rebuilds its rays from them, so orbiting moves both. `Share The Camera`
   turns this off and reverts the volume to the original pen's baked ray, which is worth seeing precisely
   because it shows what the coupling buys.
2. **One domain.** `toFieldSpace` applies the flight offset, the tunnel repetition and the field scale,
   and both programs call it with the same arguments. Field scale and tunnel repeat are therefore single
   controls that move both halves at once.
3. **One phase.** The ether's fold twists by distance along the ray; the grid passes distance from the eye
   to that vertex, which is the same quantity.

The grid is consequently a real slice of the volume, and `Slide Grid Through Volume` moves the mesh in
world space rather than shifting a lookup — what you see is where it is.

With the camera uncoupled, field scale at 1 and tunnel repeat on, the volume is pixel-identical to the
original pen: `toFieldSpace` reduces to the two lines it replaced and `totalDist` is still the twist phase.

`test-ether-trails-coupling.mjs` asserts all of this from the source, since two separately-compiled
shaders have nothing at runtime that would notice them drifting apart.

**Two things the field form does not share with the 26 solid forms beside it**, both found because the
mix control appeared to do nothing:

- **A field covers the grid.** Every solid form guards on `length(p)` against its size, which confined
  the field to a disc holding about 6% of the vertices — the mix was working the whole time, in a patch
  small enough to read as nothing. `Field Extent` replaces that with a soft vignette at the outer edge.
- **The phase must come from the point, not the eye.** The volume twists its fold by distance along the
  ray, and copying that to the grid meant using distance from the camera — which varies across a surface
  and spun the fold's rotation axis through 35 radians from one side of the grid to the other, turning
  the form into noise. The grid now takes its phase from the field position.

`Field Zoom` is the honest part of the trade. These fields were written to be sampled per pixel by a
raymarcher, while the grid has 0.12 local units between vertices, so anything finer than that spacing
aliases. At zoom 1 the grid reads exactly the point the volume marches and the sharper fields are noise;
the 0.05 default puts structure roughly 30x larger than the vertex step. It is a control rather than a
hidden constant because it is the one place the strict point-for-point coupling is deliberately relaxed.

**Draw distance is one control over two limits**, because they are one thing to look at. The camera's far
plane clips the grid, which spans 120 units, and the volume's march has its own limit. That limit was 25
in the source pen, measured from the world origin where its eye sat — with the camera coupled the ray now
starts wherever you are standing, so a fixed 25 stopped the march a few units past the structure instead
of around it. Both now follow `Draw Distance`, default 400.

Raising it is nearly free: the step heuristic grows with distance from the field's centre, so a marched
ray reaches 400 in roughly 40 steps. The exception is the pixel looking straight down the tunnel axis,
where the step shrinks near the vanishing point and the march is step-limited rather than clip-limited.
That is the source pen's bright core, not a defect.

**The Field mix folder arms itself**, and this is the interesting failure it came from. Its six controls
are read by exactly one of the 27 height functions, `hFieldMix`, and the vertex shader only calls it when
`uShapeType` is 26. Under any other form all six update their uniforms, move their sliders, and change
nothing — silently. The form is persisted, so a single earlier visit to the Form Type dropdown left the
whole folder dead on every later load, including through a fetch that 404s and falls back to the browser
copy. Touching anything in the folder now selects the form that reads it, so the controls cannot be inert,
and the status line names the live form because otherwise this is invisible from the panel.

The general lesson, which applies to every page in this repo: a control whose effect is gated by a
different control is a defect, not a documentation problem. `test-ether-trails-coupling.mjs` asserts every
one of the six arms.

**Both hybrids reset.** `Reset everything to defaults` is the first control in each panel. The defaults are
deep-copied before `applySaved` runs at boot, which is the only moment the authored values still exist, and
the reset also restores what does not live in the config object — camera position and orbit target, the
accumulated clocks, and in Glass Plankton the shape and the generated panorama. Without it a page that
autosaves every change has no way back.

Other details worth knowing:

- **`FIELD_GLSL` holds the whole registry** and is injected into both programs. Nothing in that string
  reads a uniform, precisely because the two programs supply different ones.
- **Two passes, one buffer.** `renderer.autoClear` is off: the volume draws under an orthographic camera,
  then the grid draws additively over it under a perspective camera with OrbitControls.
- **The march budget is a `break`, not a loop bound.** GLSL ES 1.0 requires a constant bound, and some of
  these fields cost far more per step than the ether's own fold, so `March Steps` needs to be adjustable.
- **Two harvested functions had to be adapted**, and only in ways the registry could not avoid: Northern
  Lights took its octave count as an argument, which has to be a constant here, and Abnormal Sphere
  Morphing's noise read a contrast uniform that a shader which is not that pen cannot supply, so it is
  folded in at that pen's default.
- **Output is linear by default.** The ether pen was written against r128, whose default output was
  linear; Three has defaulted to sRGB since r152, which washes out its accumulated-light look. The
  original is the default and the modern pipeline is a toggle.

Tuning autosaves to `hybrid-tuning/ether-trails.json` through `POST /api/save-hybrid?name=<slug>`, which
is shared by every hybrid so a new page needs a name rather than a new route.

### Glass Plankton

Both pens start at the same call, `SVGLoader.parse(text).paths`. The glass pen turns
those paths into filled shapes and extrudes them into a transmissive solid; the plankton pen samples the
same paths as polylines and smears N interpolated copies between two transforms. One parse feeds both, so
the trail is an outline of the object it resolves into, and the trail's near end is bound to the glass
logo's live transform so the swarm tracks the solid as it turns. Wave and twist ease to zero as the trail
approaches, which is what makes it read as the logo condensing out of the swarm.

Two details are load-bearing:

- **The trail lines are additive and opaque at once.** Three forces `NoBlending` only when
  `blending === NormalBlending && transparent === false` (`WebGLState.setMaterial`), so an additive
  material with `transparent: false` keeps its blending *and* sorts into the opaque bucket — and
  `renderTransmissionPass` only feeds opaque and transmissive objects into the buffer that transmissive
  materials sample. A transparent trail composites over the glass; this one refracts through it. The
  `Refract Through Glass` toggle switches between the two.
- **The solid is rotated 180° about X, not mirrored in Y,** to match the trail's per-point Y negation.
  A negative scale would reverse the winding and invert the normals, which a transmissive material shows
  immediately. `test-glass-plankton-alignment.mjs` at the repo root asserts both paths land in the same
  box and that the front cap still winds outward.

The page needs `serve.py` (it imports `../../disk-store.js` and `three` from the repo's `node_modules`);
it autosaves its GUI to `glass-plankton.json` through `POST /api/save-glass-plankton`. Its panorama is
drawn to a canvas at runtime rather than fetched, so unlike the original pen it has no remote asset to
lose; a real equirectangular image can still be loaded from the Environment folder.
